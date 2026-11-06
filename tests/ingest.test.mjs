import test from 'node:test';
import assert from 'node:assert/strict';
import { isolate, event } from './helpers.mjs';

isolate();
const { runIngestion, freshness } = await import('../lib/ingest.mjs');
const store = await import('../lib/store.mjs');
const { withRetry, getJson, HttpError } = await import('../lib/connectors/http.mjs');
const { mapUfcalendarEvent } = await import('../lib/connectors/ufcalendar.mjs');
const { mapBoxerbookEvent, isMajorCard } = await import('../lib/connectors/boxerbook.mjs');

function connector(id, { official = true, events = [], fail = false, minIntervalMinutes } = {}) {
  return {
    id, label: id, official, enabled: () => true,
    minIntervalMinutes: minIntervalMinutes ? () => minIntervalMinutes : undefined,
    async fetch() { if (fail) throw new Error(`${id} is down`); return { events: structuredClone(events) }; }
  };
}
const day = d => new Date(`2030-05-${String(d).padStart(2, '0')}T12:00:00Z`);

test('ingestion records provenance, run status and change history across runs', async () => {
  const first = await runIngestion({ connectors: [connector('curated', { events: [event()] })], now: day(1) });
  assert.equal(first.sources[0].status, 'SUCCESS');
  let [ev] = await store.listEvents();
  assert.equal(ev.firstSeenAt, day(1).toISOString());
  assert.equal(ev.sequence, 0);
  assert.deepEqual(ev.sourceIds, ['curated']);
  assert.equal(ev.sources[0].retrievedAt, '2030-05-01');

  // Time change + opponent change on the next run.
  const changed = event({ start: '2030-06-01T21:00:00Z', fights: [{ a: 'Alpha One', b: 'Golf Five' }, { a: 'Charlie Three', b: 'Delta Four' }] });
  const second = await runIngestion({ connectors: [connector('curated', { events: [changed] })], now: day(2) });
  assert.equal(second.changes, 2);
  [ev] = await store.listEvents();
  assert.equal(ev.firstSeenAt, day(1).toISOString(), 'firstSeenAt preserved');
  assert.equal(ev.sequence, 1, 'material change bumps calendar SEQUENCE');
  const types = (await store.listChanges({ eventIds: ['ev-1'] })).map(c => c.type);
  assert.ok(types.includes('TIME_CHANGED') && types.includes('OPPONENT_CHANGED') && types.includes('EVENT_ADDED'));

  // No change: no new history, sequence stable.
  const third = await runIngestion({ connectors: [connector('curated', { events: [changed] })], now: day(3) });
  assert.equal(third.changes, 0);
  assert.equal((await store.listEvents())[0].sequence, 1);
});

test('a failing source keeps the last good data and is recorded as FAILED', async () => {
  const before = await store.listEvents();
  const result = await runIngestion({ connectors: [connector('curated', { fail: true })], now: day(4) });
  assert.equal(result.sources[0].status, 'FAILED');
  assert.match(result.sources[0].error, /down/);
  assert.equal(result.sources[0].usedCacheFrom !== undefined, true, 'served from cache');
  assert.deepEqual((await store.listEvents()).map(e => e.id), before.map(e => e.id));
  const runs = await store.listRuns();
  assert.equal(runs[0].status, 'FAILED');
});

test('events dropped by a source are flagged for review, never silently deleted or canceled', async () => {
  const result = await runIngestion({ connectors: [connector('curated', { events: [] })], now: day(5) });
  const [ev] = await store.listEvents();
  assert.equal(ev.status, 'CONFIRMED');
  assert.equal(ev.missingFromSource, true);
  assert.ok(result.reviewFlags.some(f => f.includes('missing from source')));
});

test('aggregator data cannot mark an event CONFIRMED and merges into the official card', async () => {
  const agg = event({ id: 'agg-1', network: 'TBA', sources: [{ label: 'Agg', url: 'https://agg.example/1' }] });
  const only = event({ id: 'agg-2', date: '2030-07-01', fights: [{ a: 'Kilo', b: 'Lima' }], sources: [{ label: 'Agg', url: 'https://agg.example/2', official: true }] });
  await runIngestion({ connectors: [connector('curated', { events: [event()] }), connector('agg', { official: false, events: [agg, only] })], now: day(6), force: true });
  const events = await store.listEvents();
  const official = events.find(e => e.id === 'ev-1');
  assert.equal(official.status, 'CONFIRMED');
  assert.equal(official.missingFromSource, false);
  assert.deepEqual(official.sourceIds.sort(), ['agg', 'curated']);
  const aggOnly = events.find(e => e.id === 'agg-2');
  assert.equal(aggOnly.status, 'ANNOUNCED', 'non-official connector cannot confirm, even if it claims official');
  assert.equal(aggOnly.sources[0].official, false);
});

test('rate-limited sources are skipped but their cached data still merges', async () => {
  const agg = connector('agg', { official: false, minIntervalMinutes: 1440, events: [] });
  const r = await runIngestion({ connectors: [connector('curated', { events: [event()] }), agg], now: new Date() });
  assert.equal(r.sources.find(s => s.source === 'agg').status, 'SKIPPED');
  assert.ok((await store.listEvents()).find(e => e.id === 'agg-2'), 'cached aggregator event retained');
});

test('bulk imports are stored but not announced as new fights', async () => {
  const many = Array.from({ length: 16 }, (_, i) => event({ id: `bulk-${i}`, date: '2030-08-01', start: null, fights: [{ a: `Bulk A${i}`, b: `Bulk B${i}` }] }));
  const r = await runIngestion({ connectors: [connector('curated', { events: [event(), ...many] })], now: day(7) });
  assert.ok(r.reviewFlags.some(f => f.startsWith('bulk import: 16')));
  const events = await store.listEvents();
  assert.equal(events.find(e => e.id === 'bulk-3').announce, false);
  assert.equal(events.find(e => e.id === 'ev-1').announce, true, 'existing events keep their flag');
  const one = await runIngestion({ connectors: [connector('curated', { events: [event(), ...many, event({ id: 'single', date: '2030-09-01', start: null, fights: [{ a: 'Solo', b: 'Act' }] })] })], now: day(8) });
  assert.ok(!one.reviewFlags.some(f => f.startsWith('bulk')));
  assert.equal((await store.listEvents()).find(e => e.id === 'single').announce, true);
});

test('freshness reports stale data when the last successful ingest is old', async () => {
  const fresh = await freshness(new Date(Date.now() + 2 * 86400000));
  assert.equal(fresh.ingestFresh, false);
  assert.equal(fresh.fresh, false);
});

test('withRetry retries 5xx/429 with backoff but not other 4xx', async () => {
  let calls = 0;
  const flaky = async () => { calls++; if (calls < 3) throw new HttpError(503, 'busy'); return 'ok'; };
  assert.equal(await withRetry(flaky, { baseDelayMs: 1 }), 'ok');
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw new HttpError(401, 'bad key'); }, { baseDelayMs: 1 }));
  assert.equal(calls, 1);
  const fakeFetch = async () => new Response('nope', { status: 404 });
  await assert.rejects(getJson('https://api.example/x', { fetchImpl: fakeFetch }), /HTTP 404/);
});

test('UFCalendar mapping keeps canceled bouts, segments and statuses', () => {
  const ev = mapUfcalendarEvent({
    slug: 'ufc-999-2030-06-01', title: 'UFC 999', org: 'ufc', starts_at: '2030-06-01T22:00:00Z', main_card_at: '2030-06-02T02:00:00Z',
    tz: 'America/New_York', status: 'scheduled', venue: { name: 'MSG', city: 'New York', region: 'NY', country: 'United States', tz: 'America/New_York' },
    broadcasts: [{ region: 'US', provider: 'Paramount+', kind: 'stream', url: null }, { region: 'GB', provider: 'TNT', kind: 'tv', url: null }],
    card: [
      { ordering: 1, card_section: 'main', is_main: true, is_title: true, weight_class: 'Heavyweight', scheduled_rounds: 5, status: 'confirmed', fighter_a: { name: 'A' }, fighter_b: { name: 'B' } },
      { ordering: 2, card_section: 'prelims', is_main: false, is_title: false, weight_class: 'Lightweight', scheduled_rounds: 3, status: 'cancelled', fighter_a: { name: 'C' }, fighter_b: { name: 'D' } }
    ]
  }, '2030-05-01');
  assert.equal(ev.date, '2030-06-01');
  assert.equal(ev.start, '2030-06-02T02:00:00Z');
  assert.equal(ev.status, 'CONFIRMED');
  assert.equal(ev.network, 'Paramount+');
  assert.equal(ev.fights[1].status, 'CANCELED');
  assert.equal(ev.fights[1].segment, 'prelim');
  assert.equal(ev.sources[0].official, false);
});

test('Boxerbook mapping never guesses a headliner and filters club shows', () => {
  const card = { id: 5, date: '2030-06-01', venue: 'Arena', city: 'Leeds', country: 'GB', promoter: 'Promo', broadcasts: [{ platform: 'DAZN' }], url: 'https://boxerbook.com/events/5',
    bouts: [{ id: 1, status: 'scheduled', a: { name: 'A' }, b: { name: 'B' } }, { id: 2, status: 'cancelled', a: { name: 'C' }, b: { name: 'D' } }] };
  const ev = mapBoxerbookEvent(card, '2030-05-01');
  assert.equal(ev.headline, 'Boxing card: Leeds');
  assert.equal(ev.status, 'ANNOUNCED');
  assert.equal(ev.fights[1].status, 'CANCELED');
  const titled = mapBoxerbookEvent({ ...card, bouts: [...card.bouts, { id: 3, status: 'scheduled', title_text: 'WBO', a: { name: 'E' }, b: { name: 'F' } }] }, '2030-05-01');
  assert.equal(titled.headline, 'E vs F');
  assert.equal(isMajorCard({ broadcasts: [], bouts: [{ title_text: null }] }), false);
  assert.equal(mapBoxerbookEvent({ ...card, bouts: [{ id: 2, status: 'cancelled', a: { name: 'C' }, b: { name: 'D' } }] }).status, 'CANCELED');
});
