import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { isolate, event } from './helpers.mjs';

isolate();
const { handler } = await import('../server.mjs');
const store = await import('../lib/store.mjs');
const { runIngestion } = await import('../lib/ingest.mjs');
const { sentPreviews } = await import('../lib/email.mjs');
const { unsubscribeToken } = await import('../lib/tokens.mjs');
const { tokenSecret, isAdminRequest } = await import('../lib/config.mjs');

const connector = events => ({ id: 'curated', official: true, enabled: () => true, fetch: async () => ({ events }) });
await runIngestion({
  connectors: [connector([
    event({ id: 'one', date: '2099-01-01', start: '2099-01-01T20:00:00Z' }),
    event({ id: 'two', date: '2099-02-01', start: null, sport: 'MMA', promotion: 'UFC', fights: [{ a: 'Echo', b: 'Foxtrot' }] })
  ])]
});

const server = http.createServer(handler);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());
const get = (p, init) => fetch(base + p, { redirect: 'manual', ...init });

test('admin is disabled without a strong ADMIN_TOKEN (no default token)', async () => {
  delete process.env.ADMIN_TOKEN;
  for (const token of ['change-me', '', 'undefined']) {
    const r = await get('/internal/ingest', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 503);
  }
  process.env.ADMIN_TOKEN = 'short';
  assert.equal((await get('/internal/status', { headers: { Authorization: 'Bearer short' } })).status, 503, 'weak tokens are refused');
});

test('admin requires the exact token', async () => {
  process.env.ADMIN_TOKEN = 'a'.repeat(32);
  assert.equal((await get('/internal/status', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await get('/internal/status')).status, 401);
  const ok = await get('/internal/status', { headers: { Authorization: `Bearer ${'a'.repeat(32)}` } });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.emailMode, 'preview');
  assert.ok(body.runs.length >= 1);
  assert.ok(!isAdminRequest({ headers: { authorization: `Bearer ${'a'.repeat(31)}` } }));
  delete process.env.ADMIN_TOKEN;
});

test('production refuses to start without TOKEN_SECRET', () => {
  const saved = { secret: process.env.TOKEN_SECRET, env: process.env.NODE_ENV };
  delete process.env.TOKEN_SECRET; process.env.NODE_ENV = 'production';
  assert.throws(() => tokenSecret(), /TOKEN_SECRET/);
  process.env.TOKEN_SECRET = saved.secret; process.env.NODE_ENV = saved.env ?? '';
  if (!saved.env) delete process.env.NODE_ENV;
});

test('single-event calendar download contains only that event (v1 bug)', async () => {
  const r = await get('/api/calendar.ics?id=one');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/calendar/);
  assert.match(r.headers.get('content-disposition'), /one\.ics/);
  const body = await r.text();
  assert.equal(body.match(/BEGIN:VEVENT/g).length, 1);
  assert.equal((await get('/api/calendar.ics?id=nope')).status, 404);
  const sport = await (await get('/api/calendar.ics?sport=MMA')).text();
  assert.equal(sport.match(/BEGIN:VEVENT/g).length, 1);
  const personal = await (await get('/api/calendar.ics?fighters=echo')).text();
  assert.match(personal, /UID:two@fightslate/);
});

test('API filters, meta and fighter lookup', async () => {
  const events = await (await get('/api/events?sport=Boxing')).json();
  assert.deepEqual(events.map(e => e.id), ['one']);
  assert.equal(events[0].effectiveStatus, 'CONFIRMED');
  assert.ok(!('sourceIds' in events[0]), 'internal fields not exposed');
  const meta = await (await get('/api/meta')).json();
  assert.ok(meta.lastSuccessfulIngestAt);
  assert.equal(meta.upcomingEvents, 2);
  const fighter = await (await get('/api/fighters/echo')).json();
  assert.equal(fighter.name, 'Echo');
  assert.equal((await get('/api/fighters/nobody')).status, 404);
  const health = await (await get('/health')).json();
  assert.equal(health.ok, true);
  assert.equal(health.mode, 'file');
});

test('static files cannot escape public/ and old pages are gone', async () => {
  for (const p of ['/..%2fserver.mjs', '/%2e%2e/package.json', '/../package.json', '/js/..%2f..%2fserver.mjs', '/%2e%2e%2f%2e%2e%2fetc%2fpasswd', '/index.old.html', '/admin.old.html']) {
    assert.equal((await get(p)).status, 404, p);
  }
  const home = await get('/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  const html = await home.text();
  assert.ok(!/July 2[15], 2026|Refreshed July/.test(html), 'no hardcoded refresh label or featured fight');
});

test('malformed requests get 400, not 500', async () => {
  const bad = await get('/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
  assert.equal(bad.status, 400);
  const huge = await get('/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'x'.repeat(20000) }) });
  assert.equal(huge.status, 400);
});

test('subscribe → confirm → unsubscribe flow, with no takeover of active subscriptions', async () => {
  sentPreviews.length = 0;
  const sub = await get('/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.0.0.1' }, body: JSON.stringify({ email: 'Fan@Example.com', mma: false, reminderHours: 9999 }) });
  assert.equal(sub.status, 200);
  const link = sentPreviews.at(-1).html.match(/href="([^"]+)"/)[1];
  const confirm = await get(new URL(link).pathname + new URL(link).search);
  assert.equal(confirm.status, 302);
  let s = await store.findSubscriberByEmail('fan@example.com');
  assert.equal(s.status, 'ACTIVE');
  assert.equal(s.mma, false);
  assert.equal(s.reminderHours, 24, 'invalid reminder hours fall back to 24');
  assert.equal((await get(new URL(link).pathname + new URL(link).search)).status, 400, 'token is single-use');

  // Someone else re-submits the address: the active subscription is untouched.
  await store.updateSubscriber(s.id, { confirmSentAt: null });
  await get('/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.0.0.2' }, body: JSON.stringify({ email: 'fan@example.com', boxing: false }) });
  s = await store.findSubscriberByEmail('fan@example.com');
  assert.equal(s.status, 'ACTIVE');
  assert.equal(s.boxing, true, 'preferences only change after the owner confirms');

  const t = unsubscribeToken(s.id);
  assert.equal((await get(`/unsubscribe?u=${s.id}&t=bad`)).status, 400);
  const page = await get(`/unsubscribe?u=${s.id}&t=${t}`);
  assert.equal(page.status, 200);
  assert.equal((await store.findSubscriberByEmail('fan@example.com')).status, 'ACTIVE', 'GET (link scanners) does not unsubscribe');
  const post = await get('/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `u=${s.id}&t=${t}` });
  assert.equal(post.status, 200);
  assert.equal((await store.findSubscriberByEmail('fan@example.com')).status, 'UNSUBSCRIBED');
});

test('subscribe is rate limited per IP', async () => {
  let last;
  for (let i = 0; i < 7; i++) last = await get('/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.9.9.9' }, body: JSON.stringify({ email: `r${i}@example.com` }) });
  assert.equal(last.status, 429);
});
