import { getJson, withRetry } from './http.mjs';

// UFCalendar API (https://ufcalendar.com/developers/ufc-api). The free plan
// (1,000 requests/month) permits commercial use per its developer terms as of
// 2026-11-05; raw data must not be redistributed in bulk. Enabled only when
// UFCALENDAR_API_KEY is set. Not an official promoter source.
const BASE = 'https://api.ufcalendar.com/v1';
const STATUS = { announced: 'ANNOUNCED', scheduled: 'CONFIRMED', live: 'CONFIRMED', completed: 'COMPLETED', cancelled: 'CANCELED', postponed: 'POSTPONED' };
const BOUT_STATUS = { announced: 'SCHEDULED', confirmed: 'SCHEDULED', cancelled: 'CANCELED', completed: 'COMPLETED', no_contest: 'COMPLETED' };
const SEGMENT = { main: 'main', prelims: 'prelim', early_prelims: 'early' };
const ORG_NAMES = { ufc: 'UFC', pfl: 'PFL', oktagon: 'OKTAGON', bkfc: 'BKFC', rizin: 'RIZIN' };

export function mapUfcalendarEvent(d, retrievedAt) {
  const card = (d.card ?? []).filter(f => f.fighter_a && f.fighter_b);
  const main = card.find(f => f.is_main) ?? card[0];
  const v = d.venue;
  const broadcasts = d.broadcasts ?? [];
  const us = broadcasts.filter(b => ['US', 'WORLD'].includes(b.region));
  const shown = (us.length ? us : broadcasts).map(b => b.provider);
  return {
    id: `ufcal-${d.slug}`,
    sport: 'MMA',
    promotion: ORG_NAMES[d.org] ?? d.org.toUpperCase(),
    title: d.title,
    headline: main ? `${main.fighter_a.name} vs ${main.fighter_b.name}` : 'Main event TBA',
    date: localDate(d.starts_at, d.tz ?? v?.tz),
    timezone: d.tz ?? v?.tz ?? null,
    start: d.main_card_at ?? d.starts_at ?? null,
    startKind: d.main_card_at ? 'main_card' : 'first_bout',
    timeNote: d.main_card_at ? 'Main card time from UFCalendar' : 'First bout time from UFCalendar',
    venue: v?.name ?? 'Venue TBA',
    location: [v?.city, v?.region, v?.country].filter(Boolean).join(', '),
    network: [...new Set(shown)].join(', ') || 'TBA',
    broadcastVerified: false,
    status: STATUS[d.status] ?? 'ANNOUNCED',
    fights: card.map(f => ({
      a: f.fighter_a.name, b: f.fighter_b.name, order: f.ordering ?? undefined,
      weightClass: f.weight_class, titleFight: f.is_title, rounds: f.scheduled_rounds,
      segment: SEGMENT[f.card_section] ?? null, status: BOUT_STATUS[f.status] ?? 'SCHEDULED'
    })),
    sources: [{ label: 'UFCalendar API', url: `https://ufcalendar.com/events/${d.slug}`, retrievedAt, official: false }]
  };
}

function localDate(iso, tz) {
  if (!iso) return null;
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)); }
  catch { return iso.slice(0, 10); }
}

export default {
  id: 'ufcalendar',
  label: 'UFCalendar API (licensed aggregator, MMA)',
  official: false,
  minIntervalMinutes: () => Number(process.env.UFCALENDAR_MIN_INTERVAL_MINUTES || 1440),
  enabled: () => Boolean(process.env.UFCALENDAR_API_KEY),
  async fetch({ fetchImpl } = {}) {
    const headers = { Authorization: `Bearer ${process.env.UFCALENDAR_API_KEY}` };
    const orgs = (process.env.UFCALENDAR_ORGS || 'ufc,pfl').split(',').map(s => s.trim()).filter(Boolean);
    const maxEvents = Number(process.env.UFCALENDAR_MAX_EVENTS_PER_ORG || 8);
    const retrievedAt = new Date().toISOString();
    const events = [];
    let requests = 0;
    for (const org of orgs) {
      const list = await withRetry(() => { requests++; return getJson(`${BASE}/events?org=${encodeURIComponent(org)}&status=upcoming&order=asc&limit=${maxEvents}`, { headers, fetchImpl }); });
      for (const ev of list.data ?? []) {
        const detail = await withRetry(() => { requests++; return getJson(`${BASE}/events/${encodeURIComponent(ev.slug)}`, { headers, fetchImpl }); });
        events.push(mapUfcalendarEvent(detail.data, retrievedAt));
      }
    }
    return { events, meta: { requests } };
  }
};
