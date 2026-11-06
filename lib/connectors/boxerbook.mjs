import { getJson, withRetry } from './http.mjs';
import { slugify } from '../../public/js/core.mjs';

// Boxerbook API (https://boxerbook.com/developers). Free keys are for
// personal, non-commercial and testing use; commercial use needs the paid App
// plan. Attribution "Data from Boxerbook" with links is required. Enabled only
// when BOXERBOOK_API_KEY is set. Not an official promoter source, so events
// from here stay ANNOUNCED unless an official source confirms them.
const BASE = 'https://boxerbook.com/v1';
const BOUT_STATUS = { scheduled: 'SCHEDULED', cancelled: 'CANCELED', canceled: 'CANCELED', completed: 'COMPLETED' };

// Boxerbook lists every club show. Keep cards a schedule user cares about:
// a named broadcaster, a title bout, or a known promoter.
export function isMajorCard(ev) {
  return (ev.broadcasts ?? []).length > 0 || (ev.bouts ?? []).some(b => b.title_text);
}

export function mapBoxerbookEvent(ev, retrievedAt) {
  const bouts = (ev.bouts ?? []).filter(b => b.a?.name && b.b?.name);
  // Boxerbook does not identify the main event. Only a single title bout is
  // treated as the headliner; otherwise we use a neutral label rather than guess.
  const titles = bouts.filter(b => b.title_text);
  const main = titles.length === 1 ? titles[0] : null;
  const ordered = main ? [main, ...bouts.filter(b => b !== main)] : bouts;
  const live = bouts.filter(b => !['cancelled', 'canceled'].includes(b.status));
  const allCanceled = bouts.length > 0 && live.length === 0;
  const place = ev.city || ev.venue || 'TBA';
  const headline = main ? `${main.a.name} vs ${main.b.name}` : `Boxing card: ${place}`;
  return {
    id: ev.id ? `boxerbook-${ev.id}` : `boxerbook-${slugify(headline)}-${ev.date}`,
    sport: 'Boxing',
    promotion: ev.promoter ?? 'TBA',
    title: headline,
    headline,
    date: ev.date,
    timezone: null,
    start: ev.start_utc ? new Date(ev.start_utc).toISOString() : null,
    startKind: ev.start_utc ? 'card' : null,
    timeNote: ev.start_utc ? 'Card start from Boxerbook' : 'Start time TBA',
    venue: ev.venue ?? 'Venue TBA',
    location: [ev.city, ev.country].filter(Boolean).join(', '),
    network: [...new Set((ev.broadcasts ?? []).map(b => b.platform))].join(', ') || 'TBA',
    broadcastVerified: false,
    status: allCanceled ? 'CANCELED' : 'ANNOUNCED',
    fights: ordered.map(b => ({
      a: b.a.name, b: b.b.name, weightClass: b.division && b.division !== 'other' ? b.division : null,
      titleFight: b.title_text ? true : null, segment: main && b === main ? 'main' : null, rounds: b.scheduled_rounds ?? null,
      status: BOUT_STATUS[b.status] ?? 'SCHEDULED', note: b.title_text ?? null
    })),
    sources: [{ label: 'Data from Boxerbook', url: ev.url || 'https://boxerbook.com/', retrievedAt, official: false }]
  };
}

export default {
  id: 'boxerbook',
  label: 'Boxerbook API (licensed aggregator, boxing)',
  official: false,
  minIntervalMinutes: () => Number(process.env.BOXERBOOK_MIN_INTERVAL_MINUTES || 360),
  enabled: () => Boolean(process.env.BOXERBOOK_API_KEY),
  async fetch({ fetchImpl } = {}) {
    const headers = { 'X-Api-Key': process.env.BOXERBOOK_API_KEY };
    const retrievedAt = new Date().toISOString();
    const body = await withRetry(() => getJson(`${BASE}/schedule?when=30d`, { headers, fetchImpl }));
    const events = (body.events ?? []).filter(isMajorCard).map(e => mapBoxerbookEvent(e, retrievedAt));
    return { events, meta: { asOf: body.as_of, truncated: body.truncated === true, requests: 1 } };
  }
};
