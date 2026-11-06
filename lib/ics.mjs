import { DEFAULT_DURATION_HOURS } from '../public/js/core.mjs';

// RFC 5545 calendar generation.

const stamp = d => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

export function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Lines longer than 75 octets must be folded (CRLF + single space).
export function foldLine(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts = [];
  let current = '', size = 0, limit = 75;
  for (const ch of line) {
    const len = Buffer.byteLength(ch, 'utf8');
    if (size + len > limit) { parts.push(current); current = ''; size = 0; limit = 74; }
    current += ch; size += len;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

function nextDay(date) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replaceAll('-', '');
}

function icsStatus(ev) {
  if (ev.status === 'CANCELED' || ev.status === 'POSTPONED') return 'CANCELLED';
  if (ev.status === 'CONFIRMED' || ev.status === 'COMPLETED') return 'CONFIRMED';
  return 'TENTATIVE';
}

function summary(ev) {
  const prefix = ev.status === 'CANCELED' ? 'CANCELED: ' : ev.status === 'POSTPONED' ? 'POSTPONED: ' : '';
  const label = ev.headline && ev.headline !== ev.title && !ev.title.includes(ev.headline) ? `${ev.title}: ${ev.headline}` : ev.title || ev.headline;
  return `${prefix}${label}`;
}

function description(ev, appUrl) {
  const lines = [];
  if (ev.status === 'POSTPONED') lines.push('This event has been postponed. New date TBA.');
  if (ev.status === 'CANCELED') lines.push('This event has been canceled.');
  if (ev.statusReason) lines.push(ev.statusReason);
  lines.push(`${ev.sport} · ${ev.promotion}`);
  lines.push(ev.start ? (ev.timeNote || 'Start time from source') : 'Start time TBA (shown as an all-day event)');
  lines.push(`Watch: ${ev.network === 'TBA' ? 'Broadcast TBA' : ev.network}${ev.broadcastVerified ? '' : ' (unverified)'}`);
  const live = ev.fights.filter(f => f.status !== 'CANCELED');
  if (live.length) {
    lines.push('', 'Card:');
    for (const f of live) lines.push(`• ${f.a} vs ${f.b}${f.weightClass ? ` (${f.weightClass})` : ''}`);
  }
  const canceled = ev.fights.filter(f => f.status === 'CANCELED');
  if (canceled.length) lines.push('', 'Canceled bouts:', ...canceled.map(f => `• ${f.a} vs ${f.b}`));
  lines.push('', `Sources: ${ev.sources.map(s => s.url).join(' ')}`);
  if (ev.verifiedAt) lines.push(`Last verified: ${ev.verifiedAt.slice(0, 10)}`);
  lines.push(`Details: ${appUrl}/?event=${encodeURIComponent(ev.id)}`);
  return lines.join('\n');
}

export function eventToVevent(ev, { appUrl, now = new Date() }) {
  const lines = ['BEGIN:VEVENT', `UID:${ev.id}@fightslate`, `DTSTAMP:${stamp(now)}`, `SEQUENCE:${ev.sequence ?? 0}`];
  if (ev.updatedAt) lines.push(`LAST-MODIFIED:${stamp(ev.updatedAt)}`);
  if (ev.start) {
    lines.push(`DTSTART:${stamp(ev.start)}`, `DTEND:${stamp(Date.parse(ev.start) + DEFAULT_DURATION_HOURS * 3600000)}`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${ev.date.replaceAll('-', '')}`, `DTEND;VALUE=DATE:${nextDay(ev.date)}`, 'TRANSP:TRANSPARENT');
  }
  lines.push(
    `SUMMARY:${escapeText(summary(ev))}`,
    `LOCATION:${escapeText([ev.venue, ev.location].filter(Boolean).join(', '))}`,
    `DESCRIPTION:${escapeText(description(ev, appUrl))}`,
    `STATUS:${icsStatus(ev)}`,
    `CATEGORIES:${escapeText(ev.sport)},${escapeText(ev.promotion)}`,
    `URL:${appUrl}/?event=${encodeURIComponent(ev.id)}`,
    'END:VEVENT'
  );
  return lines;
}

export function buildCalendar(events, { appUrl, name = 'FightSlate', now = new Date() }) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FightSlate//Combat Sports Calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
    'X-WR-CALDESC:Boxing and MMA events from FightSlate. Times are UTC and display in your calendar\'s time zone.',
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H', 'X-PUBLISHED-TTL:PT6H',
    ...events.flatMap(ev => eventToVevent(ev, { appUrl, now })),
    'END:VCALENDAR'
  ];
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
