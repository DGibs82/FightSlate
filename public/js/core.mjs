// FightSlate shared domain logic.
// Pure functions only (no DOM, no Node APIs) so the server, the ingestion job,
// the notification jobs, the browser and the tests all use the same rules.

export const EVENT_STATUSES = ['ANNOUNCED', 'CONFIRMED', 'POSTPONED', 'CANCELED', 'COMPLETED'];
export const BOUT_STATUSES = ['SCHEDULED', 'CANCELED', 'COMPLETED'];
export const SPORTS = ['Boxing', 'MMA'];

// Allowed lifecycle transitions. Anything else is accepted from a source but
// flagged so an operator can review it (sources are occasionally wrong).
export const TRANSITIONS = {
  ANNOUNCED: ['CONFIRMED', 'POSTPONED', 'CANCELED', 'COMPLETED'],
  CONFIRMED: ['ANNOUNCED', 'POSTPONED', 'CANCELED', 'COMPLETED'],
  POSTPONED: ['ANNOUNCED', 'CONFIRMED', 'CANCELED'],
  CANCELED: ['ANNOUNCED', 'CONFIRMED'],
  COMPLETED: []
};

const HOUR = 3600000;
// Assumed event length when only a start time is known (main card + buffer).
export const DEFAULT_DURATION_HOURS = 6;

export function isValidTransition(from, to) {
  if (!from || from === to) return true;
  return (TRANSITIONS[from] || []).includes(to);
}

export function slugify(value) {
  return String(value ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function normalizeSport(value) {
  const s = String(value ?? '').toLowerCase();
  // Kickboxing and bare-knuckle are different sports; don't file them as boxing.
  if (/kick|bare.?knuckle/.test(s)) return null;
  if (/\bboxing\b/.test(s)) return 'Boxing';
  if (/\b(mma|ufc)\b/.test(s)) return 'MMA';
  return null;
}

export function normalizeStatus(value) {
  const s = String(value ?? '').toUpperCase().replace('CANCELLED', 'CANCELED');
  return EVENT_STATUSES.includes(s) ? s : 'ANNOUNCED';
}

// Bouts were plain "A vs B" strings in the v1 data; accept both shapes.
export function normalizeBout(input, index = 0) {
  let bout = input;
  if (typeof input === 'string') {
    const [a, b] = input.split(/\s+vs\.?\s+/i);
    bout = { a, b: b ?? 'TBA' };
  }
  const a = String(bout.a ?? '').trim();
  const b = String(bout.b ?? 'TBA').trim() || 'TBA';
  const status = BOUT_STATUSES.includes(String(bout.status).toUpperCase().replace('CANCELLED', 'CANCELED'))
    ? String(bout.status).toUpperCase().replace('CANCELLED', 'CANCELED') : 'SCHEDULED';
  return {
    id: `${slugify(a)}-vs-${slugify(b)}`,
    a, b,
    order: Number.isFinite(bout.order) ? bout.order : index + 1,
    weightClass: bout.weightClass ?? null,
    titleFight: bout.titleFight ?? null,
    rounds: Number.isFinite(bout.rounds) ? bout.rounds : null,
    segment: bout.segment ?? null,
    status,
    note: bout.note ?? null
  };
}

export function normalizeSource(src) {
  return {
    label: String(src?.label ?? 'Source'),
    url: String(src?.url ?? ''),
    retrievedAt: src?.retrievedAt ?? null,
    official: src?.official === true
  };
}

// Returns { event, errors }. Invalid events are rejected by ingestion rather
// than shown with guessed values.
export function normalizeEvent(raw) {
  const errors = [];
  const sport = normalizeSport(raw?.sport);
  if (!raw?.id) errors.push('missing id');
  if (!sport) errors.push(`unknown sport "${raw?.sport}"`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw?.date ?? ''))) errors.push('date must be YYYY-MM-DD');
  if (raw?.start && Number.isNaN(Date.parse(raw.start))) errors.push('start is not a valid ISO timestamp');
  if (!raw?.headline) errors.push('missing headline');
  const sources = (raw?.sources ?? []).map(normalizeSource).filter(s => /^https?:\/\//.test(s.url));
  if (!sources.length) errors.push('at least one http(s) source is required');
  const fights = (raw?.fights ?? []).map(normalizeBout).filter(b => b.a);
  const event = {
    id: String(raw?.id ?? ''),
    sport,
    promotion: String(raw?.promotion ?? 'TBA'),
    title: String(raw?.title ?? raw?.headline ?? ''),
    headline: String(raw?.headline ?? ''),
    date: String(raw?.date ?? ''),
    timezone: raw?.timezone ?? null,
    start: raw?.start ? new Date(raw.start).toISOString() : null,
    startKind: raw?.start ? (raw?.startKind ?? 'main_card') : null,
    timeNote: String(raw?.timeNote ?? (raw?.start ? '' : 'Start time TBA')),
    venue: String(raw?.venue ?? 'Venue TBA'),
    location: String(raw?.location ?? ''),
    network: String(raw?.network ?? 'TBA') || 'TBA',
    broadcastVerified: raw?.broadcastVerified === true,
    status: normalizeStatus(raw?.status),
    statusReason: raw?.statusReason ?? null,
    images: Array.isArray(raw?.images) ? raw.images : [],
    fights,
    sources,
    verifiedAt: raw?.verifiedAt ?? latest(sources.map(s => s.retrievedAt)),
    firstSeenAt: raw?.firstSeenAt ?? null,
    lastSeenAt: raw?.lastSeenAt ?? null,
    updatedAt: raw?.updatedAt ?? null,
    sequence: Number.isFinite(raw?.sequence) ? raw.sequence : 0,
    missingFromSource: raw?.missingFromSource === true
  };
  return { event, errors };
}

function latest(values) {
  const v = values.filter(Boolean).sort();
  return v.length ? v[v.length - 1] : null;
}

// ---------- Time ----------

// Offset (ms) of an IANA zone from UTC at a given instant.
export function zoneOffsetMs(instant, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(instant).map(p => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

// Converts a wall-clock time in an IANA zone to a UTC ISO string, DST-aware.
// e.g. zonedTimeToUtc('2026-11-14', '22:00', 'America/New_York') -> 2026-11-15T03:00:00.000Z
export function zonedTimeToUtc(date, time, timeZone) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wall - zoneOffsetMs(new Date(wall), timeZone);
  // Re-check once: the offset can differ on the other side of a DST switch.
  const second = wall - zoneOffsetMs(new Date(guess), timeZone);
  if (second !== guess) guess = second;
  return new Date(guess).toISOString();
}

// When an event is considered over. Date-only events stay "upcoming" until
// the date has ended everywhere a card could plausibly run (UTC+14 to UTC-12).
export function eventEndsAt(event) {
  if (event.start) return new Date(Date.parse(event.start) + DEFAULT_DURATION_HOURS * HOUR);
  return new Date(Date.parse(`${event.date}T00:00:00Z`) + 36 * HOUR);
}

export function eventSortKey(event) {
  return event.start ? Date.parse(event.start) : Date.parse(`${event.date}T12:00:00Z`);
}

// Status as it should be displayed now. We never invent a result: an event
// whose date has passed without a source marking it COMPLETED is "PAST".
export function effectiveStatus(event, now = new Date()) {
  if (['CANCELED', 'COMPLETED'].includes(event.status)) return event.status;
  if (eventEndsAt(event) < now) return event.status === 'POSTPONED' ? 'POSTPONED' : 'PAST';
  return event.status;
}

export function isUpcoming(event, now = new Date()) {
  return eventEndsAt(event) >= now;
}

// ---------- Deduplication ----------

function pairKey(a, b) {
  return [slugify(a), slugify(b)].sort().join('|');
}

export function headlinerKey(event) {
  const main = event.fights?.find(f => f.status !== 'CANCELED') ?? event.fights?.[0];
  if (main && main.b !== 'TBA') return pairKey(main.a, main.b);
  return `${slugify(event.promotion)}|${slugify(event.title)}`;
}

export function sameEvent(x, y) {
  if (x.id === y.id) return true;
  if (x.sport !== y.sport) return false;
  const days = Math.abs(Date.parse(x.date) - Date.parse(y.date)) / (24 * HOUR);
  if (days > 1) return false;
  if (headlinerKey(x) === headlinerKey(y)) return true;
  // Aggregators may not know which bout headlines: match if either card's
  // headliner appears anywhere on the other card.
  const has = (ev, key) => (ev.fights ?? []).some(f => f.b !== 'TBA' && pairKey(f.a, f.b) === key);
  return has(y, headlinerKey(x)) || has(x, headlinerKey(y));
}

function sourceRank(event) {
  return event.sources.some(s => s.official) ? 1 : 0;
}

// Merge events that describe the same card from multiple sources into one
// canonical record. Official sources win field conflicts; sources are unioned.
export function dedupeEvents(events) {
  const out = [];
  for (const ev of events) {
    const match = out.find(o => sameEvent(o, ev));
    if (!match) { out.push(structuredClone(ev)); continue; }
    const [primary, secondary] = sourceRank(ev) > sourceRank(match) ? [ev, match] : [match, ev];
    const merged = { ...structuredClone(secondary), ...structuredClone(primary) };
    merged.id = match.id;
    merged.start = primary.start ?? secondary.start;
    merged.startKind = primary.start ? primary.startKind : secondary.startKind;
    if (primary.network === 'TBA' && secondary.network !== 'TBA') {
      merged.network = secondary.network;
      merged.broadcastVerified = secondary.broadcastVerified;
    }
    if (!primary.fights.length) merged.fights = secondary.fights;
    const seen = new Set();
    merged.sources = [...primary.sources, ...secondary.sources].filter(s => !seen.has(s.url) && seen.add(s.url));
    merged.verifiedAt = latest([primary.verifiedAt, secondary.verifiedAt]);
    merged.sourceIds = [...new Set([...(primary.sourceIds ?? []), ...(secondary.sourceIds ?? [])])];
    // An official source wins, but a lower-ranked source reporting a
    // cancellation or postponement is surfaced for review rather than dropped.
    merged.conflicts = [...(match.conflicts ?? [])];
    if (primary.status !== secondary.status && ['CANCELED', 'POSTPONED'].includes(secondary.status)) {
      merged.conflicts.push({ field: 'status', value: secondary.status, source: secondary.sources[0]?.label ?? 'secondary source' });
    }
    merged.duplicateIds = [...new Set([...(match.duplicateIds ?? []), ev.id].filter(id => id !== match.id))];
    out[out.indexOf(match)] = merged;
  }
  return out;
}

// ---------- Change detection ----------

// Material fields: a change here bumps the ICS SEQUENCE and is shown to users
// who saved the event.
export function snapshotOf(event) {
  return {
    date: event.date, start: event.start ?? null, status: event.status,
    venue: event.venue, location: event.location, network: event.network,
    headline: event.headline,
    fights: (event.fights ?? []).map(f => ({ a: f.a, b: f.b, status: f.status ?? 'SCHEDULED' }))
  };
}

export function diffEvents(prev, next) {
  if (!prev) return [{ type: 'EVENT_ADDED', summary: `Added: ${next.headline}` }];
  if (!next) return [{ type: 'EVENT_REMOVED', summary: `No longer listed by source: ${prev.headline}` }];
  const changes = [];
  if (prev.status !== next.status) {
    const type = next.status === 'CANCELED' ? 'CANCELED'
      : next.status === 'POSTPONED' ? 'POSTPONED' : 'STATUS_CHANGED';
    changes.push({ type, field: 'status', from: prev.status, to: next.status,
      summary: type === 'STATUS_CHANGED' ? `Status ${prev.status} → ${next.status}` : `Event ${next.status.toLowerCase()}` });
  }
  if (prev.date !== next.date) changes.push({ type: 'DATE_CHANGED', field: 'date', from: prev.date, to: next.date, summary: `Date moved ${prev.date} → ${next.date}` });
  if ((prev.start ?? null) !== (next.start ?? null)) {
    changes.push({ type: 'TIME_CHANGED', field: 'start', from: prev.start ?? null, to: next.start ?? null,
      summary: !prev.start ? 'Start time announced' : !next.start ? 'Start time now TBA' : 'Start time changed' });
  }
  if (prev.venue !== next.venue || prev.location !== next.location) {
    changes.push({ type: 'VENUE_CHANGED', field: 'venue', from: `${prev.venue}, ${prev.location}`, to: `${next.venue}, ${next.location}`, summary: `Venue changed to ${next.venue}` });
  }
  if (prev.network !== next.network) changes.push({ type: 'BROADCAST_CHANGED', field: 'network', from: prev.network, to: next.network, summary: `Broadcast: ${next.network}` });
  changes.push(...diffBouts(prev.fights ?? [], next.fights ?? []));
  return changes;
}

export function diffBouts(prevBouts, nextBouts) {
  const changes = [];
  const unmatchedNext = [...nextBouts];
  const take = pred => { const i = unmatchedNext.findIndex(pred); return i < 0 ? null : unmatchedNext.splice(i, 1)[0]; };
  for (const p of prevBouts) {
    const same = take(n => pairKey(n.a, n.b) === pairKey(p.a, p.b));
    if (same) {
      const ps = p.status ?? 'SCHEDULED', ns = same.status ?? 'SCHEDULED';
      if (ps !== ns) changes.push({ type: ns === 'CANCELED' ? 'BOUT_CANCELED' : 'BOUT_STATUS_CHANGED', bout: `${p.a} vs ${p.b}`, from: ps, to: ns, summary: ns === 'CANCELED' ? `Bout canceled: ${p.a} vs ${p.b}` : `${p.a} vs ${p.b}: ${ps} → ${ns}` });
      continue;
    }
    const pa = slugify(p.a), pb = slugify(p.b);
    const swap = take(n => [slugify(n.a), slugify(n.b)].some(s => s === pa || s === pb));
    if (swap) {
      const kept = [swap.a, swap.b].find(n => [pa, pb].includes(slugify(n)));
      const gone = slugify(p.a) === slugify(kept) ? p.b : p.a;
      const added = slugify(swap.a) === slugify(kept) ? swap.b : swap.a;
      changes.push({ type: 'OPPONENT_CHANGED', bout: `${swap.a} vs ${swap.b}`, from: gone, to: added, summary: `${kept}: opponent changed from ${gone} to ${added}` });
      continue;
    }
    changes.push({ type: 'BOUT_REMOVED', bout: `${p.a} vs ${p.b}`, summary: `Bout no longer listed: ${p.a} vs ${p.b}` });
  }
  for (const n of unmatchedNext) changes.push({ type: 'BOUT_ADDED', bout: `${n.a} vs ${n.b}`, summary: `Bout added: ${n.a} vs ${n.b}` });
  return changes;
}

// Change types that warrant a calendar SEQUENCE bump and a "changed" badge.
export const MATERIAL_CHANGES = new Set(['CANCELED', 'POSTPONED', 'STATUS_CHANGED', 'DATE_CHANGED', 'TIME_CHANGED', 'VENUE_CHANGED', 'OPPONENT_CHANGED', 'BOUT_CANCELED', 'BOUT_REMOVED', 'BOUT_ADDED', 'BROADCAST_CHANGED']);

// ---------- Personalisation ----------

export function fighterSlugs(event) {
  return new Set((event.fights ?? []).flatMap(f => [slugify(f.a), slugify(f.b)]).filter(s => s && s !== 'tba'));
}

export function eventsForFighter(events, slug) {
  return events.filter(e => fighterSlugs(e).has(slug));
}

// Builds the "My Slate" model from local favourites.
// saved: { [eventId]: { snapshot, savedAt } }, fighters: [slug]
export function buildWatchlist(events, saved, fighters, now = new Date()) {
  const byId = new Map(events.map(e => [e.id, e]));
  const items = [];
  for (const [id, entry] of Object.entries(saved ?? {})) {
    const ev = byId.get(id);
    const changes = ev ? diffEvents(entry.snapshot, snapshotOf(ev)).filter(c => MATERIAL_CHANGES.has(c.type)) : [{ type: 'EVENT_REMOVED', summary: 'This event is no longer listed by our sources' }];
    items.push({ id, event: ev ?? null, reason: 'saved', changes });
  }
  for (const slug of fighters ?? []) {
    for (const ev of eventsForFighter(events, slug)) {
      if (!isUpcoming(ev, now) || items.some(i => i.id === ev.id)) continue;
      items.push({ id: ev.id, event: ev, reason: 'fighter', fighter: slug, changes: [] });
    }
  }
  return items.sort((x, y) => (x.event ? eventSortKey(x.event) : Infinity) - (y.event ? eventSortKey(y.event) : Infinity));
}
