import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCalendar, foldLine, escapeText } from '../lib/ics.mjs';
import { normalizeEvent } from '../public/js/core.mjs';
import { event } from './helpers.mjs';

const ev = o => ({ ...normalizeEvent(event(o)).event, sequence: o?.sequence ?? 0, updatedAt: '2030-05-02T10:00:00.000Z' });
const opts = { appUrl: 'https://fightslate.test', now: new Date('2030-05-03T00:00:00Z') };
const unfold = s => s.replace(/\r\n /g, '');

test('calendar uses CRLF, folds long lines to 75 octets, and ends with CRLF', () => {
  const cal = buildCalendar([ev({ title: 'É'.repeat(80) })], opts);
  assert.ok(cal.endsWith('END:VCALENDAR\r\n'));
  for (const line of cal.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `too long: ${line}`);
  assert.ok(!/[^\r]\n/.test(cal), 'bare LF found');
  assert.ok(unfold(cal).includes(`SUMMARY:${'É'.repeat(80)}`));
});

test('timed events have UTC start/end, UID, SEQUENCE and CONFIRMED status', () => {
  const cal = unfold(buildCalendar([ev({ sequence: 3 })], opts));
  assert.match(cal, /UID:ev-1@fightslate/);
  assert.match(cal, /DTSTART:20300601T200000Z/);
  assert.match(cal, /DTEND:20300602T020000Z/);
  assert.match(cal, /SEQUENCE:3/);
  assert.match(cal, /STATUS:CONFIRMED/);
  assert.match(cal, /LAST-MODIFIED:20300502T100000Z/);
});

test('TBA start times become all-day events with an exclusive next-day end', () => {
  const cal = unfold(buildCalendar([ev({ start: null, date: '2030-12-31' })], opts));
  assert.match(cal, /DTSTART;VALUE=DATE:20301231/);
  assert.match(cal, /DTEND;VALUE=DATE:20310101/);
  assert.match(cal, /Start time TBA/);
});

test('canceled and postponed events stay in the feed marked CANCELLED; announced is TENTATIVE', () => {
  const cal = unfold(buildCalendar([ev({ id: 'c', status: 'CANCELED' }), ev({ id: 'p', status: 'POSTPONED' }), ev({ id: 'a', status: 'ANNOUNCED' })], opts));
  assert.equal(cal.match(/STATUS:CANCELLED/g).length, 2);
  assert.match(cal, /SUMMARY:CANCELED: /);
  assert.match(cal, /SUMMARY:POSTPONED: /);
  assert.match(cal, /STATUS:TENTATIVE/);
});

test('canceled bouts are listed separately, not as part of the card', () => {
  const cal = unfold(buildCalendar([ev({ fights: [{ a: 'Alpha One', b: 'Bravo Two' }, { a: 'X Ray', b: 'Yankee', status: 'CANCELED' }] })], opts));
  assert.match(cal, /Canceled bouts:\\n• X Ray vs Yankee/);
});

test('text escaping per RFC 5545', () => {
  assert.equal(escapeText('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
  assert.equal(foldLine('x'.repeat(75)), 'x'.repeat(75));
  assert.equal(foldLine('x'.repeat(76)), `${'x'.repeat(75)}\r\n x`);
});
