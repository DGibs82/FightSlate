import crypto from 'node:crypto';
import * as store from './store.mjs';
import { sendEmail, escapeHtml } from './email.mjs';
import { unsubscribeToken } from './tokens.mjs';
import { appUrl, numberEnv } from './config.mjs';
import { isUpcoming, eventSortKey } from '../public/js/core.mjs';

// Notification safety rules:
// - New-fight alerts only cover events first seen AFTER the subscriber
//   confirmed (no backlog blast on sign-up), are upcoming, and not canceled.
// - One digest email per subscriber per run, not one email per event.
// - Reminders only for events with a real start time and an active status.
// - Every email carries a one-click unsubscribe link and List-Unsubscribe.
// - A per-run cap stops a data bug from mass-mailing.

const wants = (s, e) => (e.sport === 'Boxing' ? s.boxing : s.mma);
const maxPerRun = () => numberEnv('NOTIFY_MAX_PER_RUN', 200);
const ALERTABLE = new Set(['ANNOUNCED', 'CONFIRMED']);

function when(e) {
  if (!e.start) return `${e.date} · Start time TBA`;
  return `${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(e.start))} ET`;
}

function eventHtml(e, base) {
  return `<tr><td style="padding:12px 0;border-bottom:1px solid #eee">
<strong>${escapeHtml(e.title)}</strong>${e.headline && !e.title.includes(e.headline) ? `<br>${escapeHtml(e.headline)}` : ''}<br>
${escapeHtml(when(e))}<br>${escapeHtml([e.venue, e.location].filter(Boolean).join(', '))}<br>
Watch: ${escapeHtml(e.network === 'TBA' ? 'Broadcast TBA' : e.network)}<br>
<a href="${base}/?event=${encodeURIComponent(e.id)}">Details</a> · <a href="${base}/api/calendar.ics?id=${encodeURIComponent(e.id)}">Add to calendar</a>
</td></tr>`;
}

export function unsubscribeUrl(sub) {
  return `${appUrl()}/unsubscribe?u=${encodeURIComponent(sub.id)}&t=${unsubscribeToken(sub.id)}`;
}

function wrap(sub, title, bodyHtml) {
  const unsub = unsubscribeUrl(sub);
  return {
    html: `<div style="font-family:system-ui,sans-serif;max-width:560px">
<h2>${escapeHtml(title)}</h2>${bodyHtml}
<p style="color:#666;font-size:12px;margin-top:24px">You are receiving this because you subscribed to FightSlate alerts.
<a href="${unsub}">Unsubscribe</a>. Schedules change; always check the details link before an event.</p></div>`,
    headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
  };
}

async function deliver(sub, key, type, eventId, message, budget, dryRun) {
  if (budget.used >= budget.max) { budget.capped = true; return false; }
  if (await store.deliveryExists(key)) return false;
  budget.used++;
  if (dryRun) { budget.planned.push({ to: sub.email, subject: message.subject, key }); return true; }
  try {
    const res = await sendEmail({ to: sub.email, idempotencyKey: key, ...message });
    await store.logDelivery({ subscriberId: sub.id, eventId, type, dedupeKey: key, providerId: res.id, status: 'SENT', error: null });
    return true;
  } catch (err) {
    await store.logDelivery({ subscriberId: sub.id, eventId, type, dedupeKey: key, status: 'FAILED', error: String(err).slice(0, 500) });
    return false;
  }
}

export async function notifyNew({ now = new Date(), dryRun = false } = {}) {
  const events = (await store.listEvents()).filter(e => isUpcoming(e, now) && ALERTABLE.has(e.status) && !e.missingFromSource);
  const subs = await store.activeSubscribers();
  const budget = { used: 0, max: maxPerRun(), planned: [], capped: false };
  let sent = 0;
  for (const s of subs) {
    if (!s.newFightAlerts || !s.confirmedAt) continue;
    const confirmedAt = Date.parse(s.confirmedAt);
    const fresh = events
      .filter(e => wants(s, e) && e.announce !== false && e.firstSeenAt && Date.parse(e.firstSeenAt) > confirmedAt)
      .sort((a, b) => eventSortKey(a) - eventSortKey(b));
    const unsent = [];
    for (const e of fresh) if (!(await store.deliveryExists(`new:${s.id}:${e.id}`))) unsent.push(e);
    if (!unsent.length) continue;
    const shown = unsent.slice(0, 10);
    const subject = unsent.length === 1 ? `New on FightSlate: ${unsent[0].title}` : `${unsent.length} new fights on FightSlate`;
    const more = unsent.length > shown.length ? `<p>…and ${unsent.length - shown.length} more on the site.</p>` : '';
    const message = { subject, ...wrap(s, 'New fights added', `<table width="100%">${shown.map(e => eventHtml(e, appUrl())).join('')}</table>${more}`) };
    // Resend idempotency keys are limited to 256 chars: hash the event set.
    const digestKey = `newdigest:${s.id}:${crypto.createHash('sha256').update(unsent.map(e => e.id).sort().join(',')).digest('hex').slice(0, 32)}`;
    if (await deliver(s, digestKey, 'NEW_FIGHT', null, message, budget, dryRun)) {
      sent++;
      // Per-event keys ensure each event is announced to a subscriber only once.
      if (!dryRun) for (const e of unsent) await store.logDelivery({ subscriberId: s.id, eventId: e.id, type: 'NEW_FIGHT_ITEM', dedupeKey: `new:${s.id}:${e.id}`, status: 'SENT', error: null });
    }
  }
  return { sent, dryRun, capped: budget.capped, planned: dryRun ? budget.planned : undefined };
}

export async function notifyUpcoming({ now = new Date(), dryRun = false } = {}) {
  const events = (await store.listEvents()).filter(e => e.start && ['CONFIRMED', 'ANNOUNCED'].includes(e.status) && !e.missingFromSource);
  const subs = await store.activeSubscribers();
  const budget = { used: 0, max: maxPerRun(), planned: [], capped: false };
  let sent = 0;
  for (const s of subs) {
    if (!s.upcomingAlerts) continue;
    const hours = Number(s.reminderHours || 24);
    for (const e of events) {
      if (!wants(s, e)) continue;
      const diff = (Date.parse(e.start) - now.getTime()) / 3600000;
      // Hourly cron: fire inside a 2-hour window ending at the reminder mark.
      if (diff <= 0 || diff > hours + 1 || diff < hours - 1) continue;
      // Start time is part of the key: a rescheduled event gets a fresh reminder.
      const key = `upcoming:${s.id}:${e.id}:${hours}:${e.start}`;
      const message = { subject: `Fight reminder: ${e.title}`, ...wrap(s, `Starts in about ${hours} hours`, `<table width="100%">${eventHtml(e, appUrl())}</table>`) };
      if (await deliver(s, key, 'UPCOMING', e.id, message, budget, dryRun)) sent++;
    }
  }
  return { sent, dryRun, capped: budget.capped, planned: dryRun ? budget.planned : undefined };
}
