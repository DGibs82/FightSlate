import test from 'node:test';
import assert from 'node:assert/strict';
import {
  slugify, normalizeEvent, normalizeBout, zonedTimeToUtc, effectiveStatus, isUpcoming, eventEndsAt, dedupeEvents,
  diffEvents, snapshotOf, isValidTransition, buildWatchlist, sameEvent
} from '../public/js/core.mjs';
import { event } from './helpers.mjs';

const norm = raw => normalizeEvent(raw).event;

test('slugify strips accents, suffixes and punctuation', () => {
  assert.equal(slugify('Jiří Procházka'), 'jiri-prochazka');
  assert.equal(slugify('Vergil Ortiz Jr.'), 'vergil-ortiz');
  assert.equal(slugify("Da'Mazion Vanhouter"), 'da-mazion-vanhouter');
});

test('normalizeEvent rejects events without a source, date or known sport', () => {
  assert.deepEqual(normalizeEvent(event()).errors, []);
  assert.match(normalizeEvent(event({ sources: [] })).errors.join(), /source/);
  assert.match(normalizeEvent(event({ date: 'Nov 5' })).errors.join(), /date/);
  assert.match(normalizeEvent(event({ sport: 'Kickboxing' })).errors.join(), /sport/);
  assert.match(normalizeEvent(event({ sources: [{ label: 'x', url: 'javascript:alert(1)' }] })).errors.join(), /source/);
});

test('legacy v1 shapes are normalised (string bouts, "UFC / MMA", CANCELLED)', () => {
  const e = norm(event({ sport: 'UFC / MMA', status: 'cancelled', fights: ['A Guy vs B Guy'] }));
  assert.equal(e.sport, 'MMA');
  assert.equal(e.status, 'CANCELED');
  assert.deepEqual([e.fights[0].a, e.fights[0].b, e.fights[0].status], ['A Guy', 'B Guy', 'SCHEDULED']);
  assert.equal(normalizeBout({ a: 'X', b: 'Y', status: 'Cancelled' }).status, 'CANCELED');
});

test('zonedTimeToUtc handles DST on both sides of the switch', () => {
  // US Eastern: EDT (UTC-4) until 2026-11-01, EST (UTC-5) after.
  assert.equal(zonedTimeToUtc('2026-10-31', '21:00', 'America/New_York'), '2026-11-01T01:00:00.000Z');
  assert.equal(zonedTimeToUtc('2026-11-14', '21:00', 'America/New_York'), '2026-11-15T02:00:00.000Z');
  // US spring-forward day (2026-03-08) evening is EDT.
  assert.equal(zonedTimeToUtc('2026-03-08', '20:00', 'America/New_York'), '2026-03-09T00:00:00.000Z');
  // UK: BST until 2026-10-25.
  assert.equal(zonedTimeToUtc('2026-10-24', '22:00', 'Europe/London'), '2026-10-24T21:00:00.000Z');
  assert.equal(zonedTimeToUtc('2026-12-11', '22:00', 'Europe/London'), '2026-12-11T22:00:00.000Z');
  // Southern hemisphere and no-DST zones; date rolls back across UTC.
  assert.equal(zonedTimeToUtc('2026-12-13', '09:30', 'Australia/Brisbane'), '2026-12-12T23:30:00.000Z');
  assert.equal(zonedTimeToUtc('2026-12-13', '09:30', 'Australia/Sydney'), '2026-12-12T22:30:00.000Z');
  assert.equal(zonedTimeToUtc('2026-11-14', '22:00', 'Asia/Dubai'), '2026-11-14T18:00:00.000Z');
});

test('effectiveStatus never invents a result for past events', () => {
  const now = new Date('2030-06-03T00:00:00Z');
  assert.equal(effectiveStatus(norm(event()), now), 'PAST');
  assert.equal(effectiveStatus(norm(event({ status: 'CANCELED' })), now), 'CANCELED');
  assert.equal(effectiveStatus(norm(event({ status: 'COMPLETED' })), now), 'COMPLETED');
  assert.equal(effectiveStatus(norm(event()), new Date('2030-05-01T00:00:00Z')), 'CONFIRMED');
});

test('date-only events stay upcoming through the end of their date everywhere', () => {
  const e = norm(event({ start: null }));
  assert.ok(isUpcoming(e, new Date('2030-06-01T23:00:00Z')));
  assert.ok(isUpcoming(e, new Date('2030-06-02T11:00:00Z')), 'still June 1 in Hawaii/Americas');
  assert.ok(!isUpcoming(e, new Date('2030-06-02T13:00:00Z')));
  assert.equal(eventEndsAt(norm(event())).toISOString(), '2030-06-02T02:00:00.000Z');
});

test('lifecycle transitions', () => {
  assert.ok(isValidTransition('ANNOUNCED', 'CONFIRMED'));
  assert.ok(isValidTransition('CONFIRMED', 'POSTPONED'));
  assert.ok(isValidTransition('POSTPONED', 'CONFIRMED'));
  assert.ok(isValidTransition('CANCELED', 'CONFIRMED'), 'reinstated cards happen');
  assert.ok(!isValidTransition('COMPLETED', 'ANNOUNCED'));
  assert.ok(!isValidTransition('POSTPONED', 'COMPLETED'));
});

test('dedupe merges the same card from two sources; official wins, sources union', () => {
  const official = { ...norm(event()), sourceIds: ['curated'] };
  const aggregator = { ...norm(event({ id: 'agg-77', date: '2030-06-02', network: 'TBA', start: '2030-06-01T21:00:00Z', status: 'CANCELED',
    fights: [{ a: 'Bravo Two', b: 'Alpha One' }], sources: [{ label: 'Agg', url: 'https://agg.example/77', official: false }] })), sourceIds: ['agg'] };
  const [merged, ...rest] = dedupeEvents([official, aggregator]);
  assert.equal(rest.length, 0);
  assert.equal(merged.id, 'ev-1');
  assert.equal(merged.start, '2030-06-01T20:00:00.000Z', 'official start time kept');
  assert.equal(merged.status, 'CONFIRMED');
  assert.deepEqual(merged.sources.map(s => s.url), ['https://example.com/a-vs-b', 'https://agg.example/77']);
  assert.deepEqual(merged.sourceIds.sort(), ['agg', 'curated']);
  assert.equal(merged.conflicts[0].value, 'CANCELED', 'cancellation report surfaced for review');
  assert.deepEqual(merged.duplicateIds, ['agg-77']);
});

test('dedupe keeps distinct cards apart', () => {
  const a = norm(event());
  assert.equal(dedupeEvents([a, norm(event({ id: 'x', date: '2030-06-05' }))]).length, 2, 'more than a day apart');
  assert.equal(dedupeEvents([a, norm(event({ id: 'y', fights: [{ a: 'Echo', b: 'Foxtrot' }] }))]).length, 2, 'different headliners');
  assert.equal(dedupeEvents([a, norm(event({ id: 'z', sport: 'MMA' }))]).length, 2, 'different sport');
});

test('dedupe matches an aggregator card that lists the headliner lower down', () => {
  const agg = norm(event({ id: 'agg', fights: [{ a: 'Charlie Three', b: 'Delta Four' }, { a: 'Alpha One', b: 'Bravo Two' }] }));
  assert.ok(sameEvent(norm(event()), agg));
});

test('diffEvents detects time, status, opponent, cancellation and venue changes', () => {
  const before = snapshotOf(norm(event()));
  const after = snapshotOf(norm(event({
    start: '2030-06-01T21:00:00Z', status: 'POSTPONED', venue: 'Other Arena',
    fights: [{ a: 'Alpha One', b: 'Golf Five' }, { a: 'Charlie Three', b: 'Delta Four', status: 'CANCELED' }, { a: 'Hotel', b: 'India' }]
  })));
  const types = diffEvents(before, after).map(c => c.type).sort();
  assert.deepEqual(types, ['BOUT_ADDED', 'BOUT_CANCELED', 'OPPONENT_CHANGED', 'POSTPONED', 'TIME_CHANGED', 'VENUE_CHANGED']);
  const opp = diffEvents(before, after).find(c => c.type === 'OPPONENT_CHANGED');
  assert.equal(opp.from, 'Bravo Two');
  assert.equal(opp.to, 'Golf Five');
  assert.deepEqual(diffEvents(before, before), []);
});

test('watchlist flags changes to saved fights and includes followed fighters', () => {
  const original = norm(event());
  const saved = { 'ev-1': { snapshot: snapshotOf(original), savedAt: '2030-05-01' } };
  const now = new Date('2030-05-02T00:00:00Z');
  assert.deepEqual(buildWatchlist([original], saved, [], now)[0].changes, []);

  const canceled = norm(event({ status: 'CANCELED' }));
  const other = norm(event({ id: 'ev-2', date: '2030-07-01', start: null, fights: [{ a: 'Zulu', b: 'Charlie Three' }] }));
  const list = buildWatchlist([canceled, other], saved, ['charlie-three'], now);
  assert.equal(list.length, 2);
  assert.equal(list[0].changes[0].type, 'CANCELED');
  assert.equal(list[1].reason, 'fighter');

  const gone = buildWatchlist([], saved, [], now);
  assert.equal(gone[0].event, null);
  assert.equal(gone[0].changes[0].type, 'EVENT_REMOVED');
});
