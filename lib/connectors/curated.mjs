import fs from 'node:fs/promises';
import { seedFile } from '../config.mjs';
import { zonedTimeToUtc } from '../../public/js/core.mjs';

// Hand-verified snapshot maintained in data/events.json. Every entry must cite
// the official page it was checked against. Promoter sites (ufc.com,
// pflmma.com, ...) prohibit automated scraping, so this file is updated by a
// person, not a bot. See docs/DATA_SOURCES.md.
export default {
  id: 'curated',
  label: 'FightSlate curated snapshot (official promoter pages, manually verified)',
  official: true,
  enabled: () => true,
  async fetch() {
    const raw = JSON.parse(await fs.readFile(seedFile(), 'utf8'));
    const events = (Array.isArray(raw) ? raw : raw.events).map(withUtcStart);
    return { events, meta: { snapshotVerifiedAt: raw.snapshotVerifiedAt ?? null } };
  }
};

// Curated entries record the wall-clock time printed by the official source
// (e.g. "9:00 PM ET") as startLocal; converting here avoids hand-made UTC
// mistakes around daylight-saving changes.
export function withUtcStart(e) {
  if (!e.startLocal) return e;
  const { date, time, zone } = e.startLocal;
  return { ...e, start: zonedTimeToUtc(date, time, zone) };
}
