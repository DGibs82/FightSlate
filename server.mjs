import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as store from './lib/store.mjs';
import { ROOT, appUrl, adminToken, isAdminRequest, emailMode, numberEnv, tokenSecret, isProduction } from './lib/config.mjs';
import { makeToken, hashToken, verifyUnsubscribeToken } from './lib/tokens.mjs';
import { sendEmail, escapeHtml } from './lib/email.mjs';
import { notifyNew, notifyUpcoming } from './lib/notify.mjs';
import { runIngestion, freshness } from './lib/ingest.mjs';
import { buildCalendar } from './lib/ics.mjs';
import { effectiveStatus, isUpcoming, eventSortKey, eventsForFighter, slugify } from './public/js/core.mjs';

const PUBLIC = path.join(ROOT, 'public');
const MAX_BODY = 16 * 1024;
const CONFIRM_TTL_MS = 48 * 3600000;
const RESEND_COOLDOWN_MS = 10 * 60000;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};

function send(res, status, body, type, extra = {}) {
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS, ...extra });
  res.end(body);
}
const json = (res, status, data, extra) => send(res, status, JSON.stringify(data), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store', ...extra });
const html = (res, status, body) => send(res, status, body, 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });

class BadRequest extends Error {}

async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new BadRequest('request body too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  if (String(req.headers['content-type']).includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  try { return JSON.parse(raw); } catch { throw new BadRequest('invalid JSON'); }
}

// Fixed-window in-memory rate limiter (per process; fine for a single instance).
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < now) { buckets.set(key, { count: 1, reset: now + windowMs }); return false; }
  b.count++;
  if (buckets.size > 10000) for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
  return b.count > max;
}
const clientIp = req => String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

// ---------- event views ----------
function present(e, now) {
  const { sourceIds, ...rest } = e;
  return { ...rest, effectiveStatus: effectiveStatus(e, now) };
}

function filterEvents(rows, params, now) {
  const list = name => (params.get(name) ?? '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 300);
  const ids = [...list('ids'), ...list('id')];
  const fighters = list('fighters').map(slugify);
  if (ids.length || fighters.length) {
    // Personal feeds: saved events plus upcoming bouts of followed fighters.
    return rows.filter(e => ids.includes(e.id) || (fighters.length && isUpcoming(e, now) && e.fights.some(f => fighters.includes(slugify(f.a)) || fighters.includes(slugify(f.b)))))
      .sort((a, b) => eventSortKey(a) - eventSortKey(b));
  }
  const includePast = params.get('include') === 'past';
  const sport = params.get('sport'), promotion = params.get('promotion'), status = params.get('status');
  const from = params.get('from'), to = params.get('to');
  const q = (params.get('q') ?? '').trim().toLowerCase();
  const fighter = params.get('fighter');
  return rows.filter(e =>
    (includePast || isUpcoming(e, now)) &&
    (!sport || e.sport === sport) &&
    (!promotion || e.promotion === promotion) &&
    (!status || e.status === status) &&
    (!from || e.date >= from) && (!to || e.date <= to) &&
    (!fighter || e.fights.some(f => slugify(f.a) === fighter || slugify(f.b) === fighter)) &&
    (!q || [e.id, e.title, e.headline, e.promotion, e.venue, e.location, e.network, ...e.fights.flatMap(f => [f.a, f.b])].join(' ').toLowerCase().includes(q))
  ).sort((a, b) => eventSortKey(a) - eventSortKey(b));
}

// ---------- subscriptions ----------
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const REMINDER_HOURS = [6, 12, 24, 48, 72, 168];

function prefsFrom(b) {
  const hours = Number(b.reminderHours);
  return {
    boxing: b.boxing !== false, mma: b.mma !== false,
    newFightAlerts: b.newFightAlerts !== false, upcomingAlerts: b.upcomingAlerts !== false,
    reminderHours: REMINDER_HOURS.includes(hours) ? hours : 24
  };
}

async function subscribe(req, res) {
  const ip = clientIp(req);
  if (limited(`sub:${ip}`, 5, 10 * 60000)) return json(res, 429, { error: 'Too many requests. Try again later.' });
  const b = await readBody(req);
  const email = String(b.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return json(res, 400, { error: 'Enter a valid email address.' });
  if (limited(`sub-email:${email}`, 3, 60 * 60000)) return json(res, 429, { error: 'Too many requests. Try again later.' });
  const generic = { ok: true, message: 'Check your inbox for a confirmation link. Alerts start once you confirm.' };
  const prefs = prefsFrom(b);
  const existing = await store.findSubscriberByEmail(email);
  if (existing?.confirmSentAt && Date.now() - Date.parse(existing.confirmSentAt) < RESEND_COOLDOWN_MS) return json(res, 200, generic);

  const token = makeToken();
  const confirmFields = { confirmTokenHash: hashToken(token), confirmSentAt: new Date() };
  let sub;
  if (existing?.status === 'ACTIVE') {
    // An unauthenticated request must not change an active subscription;
    // the new preferences apply only after the owner confirms by email.
    sub = await store.updateSubscriber(existing.id, { ...confirmFields, pendingPrefs: prefs });
  } else {
    sub = await store.upsertSubscriber({ email, status: 'PENDING', ...prefs, ...confirmFields, pendingPrefs: null, confirmedAt: null, unsubscribedAt: null });
  }
  const link = `${appUrl()}/api/confirm?token=${token}`;
  const isUpdate = existing?.status === 'ACTIVE';
  await sendEmail({
    to: email,
    subject: isUpdate ? 'Confirm your FightSlate alert settings' : 'Confirm your FightSlate alerts',
    html: `<div style="font-family:system-ui,sans-serif"><h2>${isUpdate ? 'Confirm your new alert settings' : 'Confirm FightSlate alerts'}</h2>
<p><a href="${link}">${isUpdate ? 'Apply these settings' : 'Confirm subscription'}</a></p>
<p style="color:#666;font-size:12px">This link expires in 48 hours. If you did not request this, ignore this email and nothing will change.</p></div>`,
    idempotencyKey: `confirm:${sub.id}:${confirmFields.confirmTokenHash.slice(0, 16)}`
  });
  return json(res, 200, generic);
}

async function confirm(url, res) {
  const sub = await store.findSubscriberByHash('confirmTokenHash', hashToken(url.searchParams.get('token') ?? ''));
  const expired = sub?.confirmSentAt && Date.now() - Date.parse(sub.confirmSentAt) > CONFIRM_TTL_MS;
  if (!sub || expired) return html(res, 400, page('Link expired', '<p>This confirmation link is invalid or has expired. Subscribe again to get a new one.</p>'));
  const update = { confirmTokenHash: null, pendingPrefs: null };
  if (sub.status === 'ACTIVE' && sub.pendingPrefs) Object.assign(update, prefsFrom(sub.pendingPrefs));
  else Object.assign(update, { status: 'ACTIVE', confirmedAt: new Date(), unsubscribedAt: null });
  await store.updateSubscriber(sub.id, update);
  res.writeHead(302, { Location: '/?confirmed=1#alerts', ...SECURITY_HEADERS });
  return res.end();
}

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · FightSlate</title><link rel="stylesheet" href="/styles.css"></head><body><main class="shell narrow"><h1 class="page-title">${escapeHtml(title)}</h1>${body}<p><a class="btn" href="/">Back to FightSlate</a></p></main></body></html>`;
}

async function unsubscribe(req, url, res) {
  const params = req.method === 'POST' ? new URLSearchParams({ ...Object.fromEntries(url.searchParams), ...(await readBody(req)) }) : url.searchParams;
  const id = params.get('u') ?? '', token = params.get('t') ?? '';
  const sub = id ? await store.findSubscriberById(id) : null;
  if (!sub || !verifyUnsubscribeToken(id, token)) return html(res, 400, page('Invalid link', '<p>This unsubscribe link is invalid. Reply to any FightSlate email and we will remove you.</p>'));
  // GET shows a confirmation button so link scanners can't unsubscribe people;
  // POST (button or RFC 8058 one-click) performs it.
  if (req.method === 'GET') {
    return html(res, 200, page('Unsubscribe', `<p>Stop all FightSlate alert emails to <strong>${escapeHtml(sub.email)}</strong>?</p>
<form method="post" action="/unsubscribe"><input type="hidden" name="u" value="${escapeHtml(id)}"><input type="hidden" name="t" value="${escapeHtml(token)}"><button class="btn primary" type="submit">Unsubscribe</button></form>`));
  }
  await store.updateSubscriber(sub.id, { status: 'UNSUBSCRIBED', unsubscribedAt: new Date(), confirmTokenHash: null, pendingPrefs: null });
  return html(res, 200, page('Unsubscribed', '<p>You will not receive further FightSlate alert emails.</p>'));
}

// ---------- admin ----------
async function adminRoute(req, url, res) {
  if (!adminToken()) return json(res, 503, { error: 'Admin is disabled: set ADMIN_TOKEN (24+ characters).' });
  if (limited(`admin:${clientIp(req)}`, 30, 60000)) return json(res, 429, { error: 'Too many requests' });
  if (!isAdminRequest(req)) return json(res, 401, { error: 'unauthorized' });
  const dryRun = url.searchParams.get('dryRun') === '1';
  if (req.method === 'GET' && url.pathname === '/internal/status') {
    const [fresh, runs, changes, st] = await Promise.all([freshness(), store.listRuns({ limit: 30 }), store.listChanges({ limit: 50 }), store.stats()]);
    const events = await store.listEvents();
    const review = events.filter(e => e.missingFromSource || e.conflicts?.length).map(e => ({ id: e.id, title: e.title, missingFromSource: e.missingFromSource, conflicts: e.conflicts }));
    return json(res, 200, { freshness: fresh, runs, changes, stats: st, review, emailMode: emailMode() });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  if (url.pathname === '/internal/ingest' || url.pathname === '/internal/seed') return json(res, 200, await runIngestion({ force: true }));
  if (url.pathname === '/internal/notify/new') return json(res, 200, await notifyNew({ dryRun }));
  if (url.pathname === '/internal/notify/upcoming') return json(res, 200, await notifyUpcoming({ dryRun }));
  return json(res, 404, { error: 'not found' });
}

// ---------- static ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

async function serveStatic(url, res) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return false; }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(PUBLIC, `.${rel}`);
  if (!file.startsWith(PUBLIC + path.sep)) return false;
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!type) return false;
  try {
    const body = await fs.readFile(file);
    const cache = type.startsWith('image/') ? 'public, max-age=86400' : 'no-cache';
    send(res, 200, body, type, { 'Cache-Control': cache });
    return true;
  } catch { return false; }
}

// ---------- router ----------
export async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const now = new Date();

    if (req.method === 'GET' && p === '/health') {
      const [st, fresh] = await Promise.all([store.stats(), freshness(now)]);
      // Always 200 while the process works so the host doesn't restart it for
      // stale data; staleness is reported in the body for monitoring.
      return json(res, 200, { ok: true, dataFresh: fresh.fresh, lastSuccessfulIngestAt: fresh.lastSuccessfulIngestAt, upcomingEvents: fresh.upcomingEvents, ...st });
    }
    if (req.method === 'GET' && p === '/api/meta') {
      const fresh = await freshness(now);
      const events = await store.listEvents();
      return json(res, 200, { ...fresh, promotions: [...new Set(events.filter(e => isUpcoming(e, now)).map(e => e.promotion))].sort(), serverTime: now.toISOString() });
    }
    if (req.method === 'GET' && p === '/api/events') {
      return json(res, 200, filterEvents(await store.listEvents(), url.searchParams, now).map(e => present(e, now)));
    }
    if (req.method === 'GET' && p.startsWith('/api/events/')) {
      const id = decodeURIComponent(p.slice('/api/events/'.length));
      const e = await store.getEvent(id);
      if (!e) return json(res, 404, { error: 'not found' });
      return json(res, 200, { ...present(e, now), changes: await store.listChanges({ eventIds: [id], limit: 50 }) });
    }
    if (req.method === 'GET' && p === '/api/changes') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean).slice(0, 200);
      return json(res, 200, await store.listChanges({ since: url.searchParams.get('since') ?? undefined, eventIds: ids, limit: 200 }));
    }
    if (req.method === 'GET' && p.startsWith('/api/fighters/')) {
      const slug = slugify(decodeURIComponent(p.slice('/api/fighters/'.length)));
      const events = eventsForFighter(await store.listEvents(), slug).sort((a, b) => eventSortKey(a) - eventSortKey(b));
      if (!events.length) return json(res, 404, { error: 'No events on file for this fighter' });
      const name = events.flatMap(e => e.fights).flatMap(f => [f.a, f.b]).find(n => slugify(n) === slug);
      return json(res, 200, { slug, name, events: events.map(e => present(e, now)) });
    }
    if (req.method === 'GET' && p === '/api/developing') return json(res, 200, await store.listDeveloping());
    if (req.method === 'GET' && (p === '/api/calendar.ics' || p === '/calendar.ics')) {
      const params = url.searchParams;
      let rows = await store.listEvents();
      const explicit = params.get('id') || params.get('ids') || params.get('fighters');
      // Feeds keep 30 days of history so calendars don't drop recent events.
      if (!explicit) rows = rows.filter(e => isUpcoming(e, new Date(now - 30 * 86400000)));
      const q = new URLSearchParams(params); q.set('include', 'past');
      rows = filterEvents(rows, q, now);
      if (params.get('id') && !rows.length) return json(res, 404, { error: 'event not found' });
      const name = params.get('name')?.slice(0, 60) || (params.get('sport') ? `FightSlate ${params.get('sport')}` : 'FightSlate');
      const filename = params.get('id') && rows.length === 1 ? `${rows[0].id}.ics` : 'fightslate.ics';
      return send(res, 200, buildCalendar(rows, { appUrl: appUrl(), name, now }), 'text/calendar; charset=utf-8', {
        'Content-Disposition': `${params.get('download') === '0' ? 'inline' : 'attachment'}; filename="${filename}"`, 'Cache-Control': 'public, max-age=900'
      });
    }
    if (req.method === 'POST' && p === '/api/subscribe') return await subscribe(req, res);
    if (req.method === 'GET' && p === '/api/confirm') return await confirm(url, res);
    if (p === '/unsubscribe' && ['GET', 'POST'].includes(req.method)) return await unsubscribe(req, url, res);
    if (req.method === 'GET' && p === '/api/unsubscribe') {
      return html(res, 410, page('Link no longer supported', '<p>Please use the unsubscribe link in your most recent FightSlate email, or reply to it and we will remove you.</p>'));
    }
    if (p.startsWith('/internal/')) return await adminRoute(req, url, res);
    if (req.method === 'GET' && await serveStatic(url, res)) return;
    return json(res, 404, { error: 'not found' });
  } catch (err) {
    if (err instanceof BadRequest) return json(res, 400, { error: err.message });
    console.error(err);
    return json(res, 500, { error: 'internal error' });
  }
}

export async function start() {
  tokenSecret(); // fail fast in production if TOKEN_SECRET is missing
  if (!adminToken()) console.warn('[config] ADMIN_TOKEN not set (or shorter than 24 chars): admin endpoints are disabled.');
  console.log(`[config] storage=${store.storageMode()} email=${emailMode()} production=${isProduction()}`);
  try {
    const r = await runIngestion();
    console.log('[ingest] startup', JSON.stringify({ events: r.events, changes: r.changes, sources: r.sources.map(s => `${s.source}:${s.status}`), reviewFlags: r.reviewFlags.length }));
  } catch (err) { console.error('[ingest] startup failed; serving last stored data', err); }
  const minutes = numberEnv('INGEST_INTERVAL_MINUTES', 60);
  setInterval(() => runIngestion().then(r => console.log('[ingest]', r.sources.map(s => `${s.source}:${s.status}`).join(' '), `changes=${r.changes}`)).catch(err => console.error('[ingest] failed', err)), minutes * 60000).unref();
  const port = Number(process.env.PORT || 8787);
  const server = http.createServer(handler);
  server.listen(port, () => console.log(`FightSlate on http://127.0.0.1:${port}`));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await start();
