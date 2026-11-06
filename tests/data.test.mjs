import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeEvent, dedupeEvents } from '../public/js/core.mjs';
import { withUtcStart } from '../lib/connectors/curated.mjs';

const snapshot = JSON.parse(fs.readFileSync(new URL('../data/events.json', import.meta.url)));
const developing = JSON.parse(fs.readFileSync(new URL('../data/developing.json', import.meta.url)));
const events = snapshot.events.map(withUtcStart);

test('curated snapshot: every event is valid and cites http(s) sources with a retrieval date', () => {
  assert.equal(snapshot.schemaVersion, 2);
  for (const raw of events) {
    const { errors } = normalizeEvent(raw);
    assert.deepEqual(errors, [], raw.id);
    for (const s of raw.sources) assert.ok(s.retrievedAt, `${raw.id} source missing retrievedAt`);
  }
});

test('curated snapshot: no duplicate ids or duplicate cards', () => {
  const ids = events.map(e => e.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(dedupeEvents(events.map(e => normalizeEvent(e).event)).length, events.length);
});

test('curated snapshot: only officially sourced events are CONFIRMED', () => {
  for (const e of events) if (e.status === 'CONFIRMED') assert.ok(e.sources.some(s => s.official), e.id);
});

test('curated snapshot: local start times convert to the expected UTC instants', () => {
  const byId = Object.fromEntries(events.map(e => [e.id, e.start]));
  assert.equal(byId['ufc-334-2026-11-14'], '2026-11-15T02:00:00.000Z');          // 9 PM EST
  assert.equal(byId['pfl-dubai-2026-11-14'], '2026-11-14T18:00:00.000Z');        // 10 PM GST
  assert.equal(byId['boxing-tszyu-lara-2026-12-13'], '2026-12-12T23:30:00.000Z'); // 9:30 AM AEST
  assert.equal(byId['boxing-haney-paro-2026-12-19'], '2026-12-20T01:00:00.000Z'); // 8 PM EST
  for (const e of events) if (e.startLocal) assert.equal(e.startLocal.date, e.date, `${e.id}: startLocal date should be the local event date`);
});

test('developing matchups are sourced and never appear as scheduled events', () => {
  const titles = new Set(events.map(e => e.headline.toLowerCase()));
  for (const d of developing) {
    assert.ok(d.sources.length && d.sources.every(s => /^https:\/\//.test(s.url)), d.id);
    assert.ok(!titles.has(d.title.toLowerCase()), `${d.title} must not be on the schedule`);
  }
});
