import test from 'node:test';
import assert from 'node:assert/strict';
import { isolate, event } from './helpers.mjs';

isolate();
const store = await import('../lib/store.mjs');
const { notifyNew, notifyUpcoming, unsubscribeUrl } = await import('../lib/notify.mjs');
const { sentPreviews } = await import('../lib/email.mjs');
const { verifyUnsubscribeToken, unsubscribeToken } = await import('../lib/tokens.mjs');
const { emailMode } = await import('../lib/config.mjs');
const { normalizeEvent } = await import('../public/js/core.mjs');

const now = new Date('2030-05-10T12:00:00Z');
const stored = (o, firstSeenAt) => ({ ...normalizeEvent(event(o)).event, sourceIds: ['curated'], firstSeenAt, lastSeenAt: firstSeenAt, sequence: 0 });

async function subscriber(email, extra = {}) {
  const s = await store.upsertSubscriber({ email, status: 'ACTIVE', boxing: true, mma: true, newFightAlerts: true, upcomingAlerts: true, reminderHours: 24, confirmedAt: '2030-05-05T00:00:00.000Z', ...extra });
  return s;
}

test('email defaults to preview mode: nothing is sent without EMAIL_ENABLED=true', () => {
  assert.equal(emailMode(), 'preview');
  process.env.RESEND_API_KEY = 're_test'; process.env.EMAIL_FROM = 'x@y.z';
  assert.equal(emailMode(), 'preview');
  delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM;
});

test('new subscribers are not blasted with the existing backlog', async () => {
  await store.saveEvents([
    stored({ id: 'old-1' }, '2030-05-01T00:00:00.000Z'),
    stored({ id: 'old-2', date: '2030-06-02', start: null, fights: [{ a: 'K', b: 'L' }] }, '2030-05-01T00:00:00.000Z')
  ]);
  await subscriber('fan@example.com');
  const r = await notifyNew({ now });
  assert.equal(r.sent, 0);
});

test('events added after confirmation go out as ONE digest, once, excluding canceled/past/unconfirmed-source flags', async () => {
  const events = await store.listEvents();
  await store.saveEvents([
    ...events,
    stored({ id: 'new-1', date: '2030-06-10', start: null, title: 'New <b>Card</b>', fights: [{ a: 'M', b: 'N' }] }, '2030-05-09T00:00:00.000Z'),
    stored({ id: 'new-2', date: '2030-06-11', start: null, fights: [{ a: 'O', b: 'P' }], sport: 'MMA' }, '2030-05-09T00:00:00.000Z'),
    stored({ id: 'new-canceled', date: '2030-06-12', start: null, status: 'CANCELED', fights: [{ a: 'Q', b: 'R' }] }, '2030-05-09T00:00:00.000Z'),
    stored({ id: 'new-past', date: '2030-05-01', start: null, fights: [{ a: 'S', b: 'T' }] }, '2030-05-09T00:00:00.000Z'),
    { ...stored({ id: 'new-missing', date: '2030-06-13', start: null, fights: [{ a: 'U', b: 'V' }] }, '2030-05-09T00:00:00.000Z'), missingFromSource: true }
  ]);
  sentPreviews.length = 0;
  const r = await notifyNew({ now });
  assert.equal(r.sent, 1);
  assert.equal(sentPreviews.length, 1);
  const mail = sentPreviews[0];
  assert.equal(mail.subject, '2 new fights on FightSlate');
  assert.ok(!mail.html.includes('<b>Card</b>'), 'event text is HTML-escaped');
  assert.ok(mail.html.includes('New &lt;b&gt;Card&lt;/b&gt;'));
  assert.ok(!mail.html.includes('new-canceled') && !mail.html.includes('new-past') && !mail.html.includes('new-missing'));
  assert.match(mail.headers['List-Unsubscribe'], /\/unsubscribe\?u=/);
  assert.equal(mail.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');

  assert.ok(mail.idempotencyKey.length <= 256, 'Resend idempotency key limit');
  assert.equal((await notifyNew({ now })).sent, 0, 'second run sends nothing');
});

test('events from a bulk import are never announced', async () => {
  const events = await store.listEvents();
  await store.saveEvents([...events, { ...stored({ id: 'bulk-x', date: '2030-06-20', start: null, fights: [{ a: 'Bx', b: 'By' }] }, '2030-05-09T00:00:00.000Z'), announce: false }]);
  const s = await subscriber('bulk@example.com', { confirmedAt: '2030-05-08T00:00:00.000Z' });
  sentPreviews.length = 0;
  await notifyNew({ now });
  const mail = sentPreviews.find(m => m.to === s.email);
  assert.ok(mail && !mail.html.includes('bulk-x'));
});

test('sport preferences are respected', async () => {
  const s = await subscriber('boxingonly@example.com', { mma: false, confirmedAt: '2030-05-08T00:00:00.000Z' });
  sentPreviews.length = 0;
  await notifyNew({ now });
  const mine = sentPreviews.filter(m => m.to === s.email);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].subject, 'New on FightSlate: New <b>Card</b>');
});

test('dry run plans but never sends or records deliveries', async () => {
  await subscriber('dry@example.com', { confirmedAt: '2030-05-08T00:00:00.000Z' });
  sentPreviews.length = 0;
  const r = await notifyNew({ now, dryRun: true });
  assert.equal(sentPreviews.length, 0);
  assert.equal(r.planned.length, 1);
  assert.equal((await notifyNew({ now, dryRun: true })).planned.length, 1, 'still pending because nothing was recorded');
});

test('per-run cap stops a data bug from mass-mailing', async () => {
  process.env.NOTIFY_MAX_PER_RUN = '1';
  for (let i = 0; i < 3; i++) await subscriber(`cap${i}@example.com`, { confirmedAt: '2030-05-08T00:00:00.000Z' });
  const r = await notifyNew({ now });
  assert.equal(r.sent, 1);
  assert.equal(r.capped, true);
  delete process.env.NOTIFY_MAX_PER_RUN;
});

test('reminders: only timed, active events inside the window; a reschedule gets a fresh reminder', async () => {
  const start = new Date(now.getTime() + 24 * 3600000).toISOString();
  await store.saveEvents([
    stored({ id: 'soon', date: start.slice(0, 10), start }, '2030-05-01T00:00:00.000Z'),
    stored({ id: 'soon-canceled', date: start.slice(0, 10), start, status: 'CANCELED', fights: [{ a: 'W', b: 'X' }] }, '2030-05-01T00:00:00.000Z'),
    stored({ id: 'soon-tba', date: start.slice(0, 10), start: null, fights: [{ a: 'Y', b: 'Z' }] }, '2030-05-01T00:00:00.000Z'),
    stored({ id: 'later', date: '2030-06-20', start: '2030-06-20T20:00:00Z', fights: [{ a: 'AA', b: 'BB' }] }, '2030-05-01T00:00:00.000Z')
  ]);
  const subs = await store.activeSubscribers();
  sentPreviews.length = 0;
  const r = await notifyUpcoming({ now });
  assert.equal(r.sent, subs.length, 'one reminder per subscriber, only for "soon"');
  assert.ok(sentPreviews.every(m => m.idempotencyKey.includes(':soon:')));
  assert.equal((await notifyUpcoming({ now })).sent, 0, 'deduplicated');

  const moved = new Date(now.getTime() + 24.5 * 3600000).toISOString();
  const evs = await store.listEvents();
  await store.saveEvents(evs.map(e => (e.id === 'soon' ? { ...e, start: moved } : e)));
  assert.equal((await notifyUpcoming({ now })).sent, subs.length, 'rescheduled start → new reminder');
});

test('unsubscribe tokens are signed per subscriber and verify in constant time', async () => {
  const s = await subscriber('unsub@example.com');
  const url = new URL(unsubscribeUrl(s));
  assert.equal(url.searchParams.get('u'), s.id);
  assert.ok(verifyUnsubscribeToken(s.id, url.searchParams.get('t')));
  assert.ok(!verifyUnsubscribeToken(s.id, unsubscribeToken('someone-else')));
  assert.ok(!verifyUnsubscribeToken(s.id, ''));
});
