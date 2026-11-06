import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, staleAfterHours, reverifyAfterDays, numberEnv } from './config.mjs';
import * as store from './store.mjs';
import curated from './connectors/curated.mjs';
import ufcalendar from './connectors/ufcalendar.mjs';
import boxerbook from './connectors/boxerbook.mjs';
import {
  normalizeEvent, dedupeEvents, sameEvent, diffEvents, snapshotOf, isUpcoming, slugify,
  isValidTransition, MATERIAL_CHANGES
} from '../public/js/core.mjs';

export const DEFAULT_CONNECTORS = [curated, ufcalendar, boxerbook];

let running = null;
// Only one ingestion at a time per process.
export function runIngestion(opts = {}) {
  if (!running) running = ingest(opts).finally(() => { running = null; });
  return running;
}

async function fighterImages() {
  try {
    const files = await fs.readdir(path.join(ROOT, 'public', 'assets', 'fighters'));
    return new Map(files.map(f => [path.parse(f).name, `/assets/fighters/${f}`]));
  } catch { return new Map(); }
}

async function loadDeveloping() {
  const rows = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'developing.json'), 'utf8'));
  // Reported/rumoured matchups must cite at least one source to be shown.
  return rows.filter(r => r.id && r.title && Array.isArray(r.sources) && r.sources.some(s => /^https?:\/\//.test(s.url)));
}

async function ingest({ connectors = DEFAULT_CONNECTORS, now = new Date(), force = false, fetchImpl } = {}) {
  const runStarted = now.toISOString();
  const previous = await store.listEvents();
  const lastRuns = await store.listRuns({ limit: 200 });
  const results = [];
  const fresh = [];
  const succeeded = new Set();

  const usable = new Set(); // sources whose data (fresh or cached) is in this run

  for (const c of connectors) {
    if (!c.enabled()) continue;
    const started = Date.now();
    const lastOk = lastRuns.find(r => r.source === c.id && r.status === 'SUCCESS');
    const minMinutes = c.minIntervalMinutes?.() ?? 0;
    const run = { source: c.id, startedAt: new Date(started).toISOString(), received: 0, accepted: 0, rejected: 0, warnings: [] };
    let accepted = null;
    if (!force && lastOk && minMinutes && Date.parse(lastOk.finishedAt) > now.getTime() - minMinutes * 60000) {
      run.status = 'SKIPPED';
      run.reason = `rate budget: last success ${lastOk.finishedAt}, min interval ${minMinutes}m`;
    } else {
      try {
        const { events, meta } = await c.fetch({ fetchImpl });
        run.received = events.length;
        accepted = [];
        for (const raw of events) {
          const { event, errors } = normalizeEvent(raw);
          if (errors.length) { run.rejected++; run.warnings.push(`${raw?.id ?? '?'}: ${errors.join('; ')}`); continue; }
          if (c.official !== true) event.sources = event.sources.map(s => ({ ...s, official: false }));
          // Only an official (promoter/broadcaster) source can make an event CONFIRMED.
          if (event.status === 'CONFIRMED' && !event.sources.some(s => s.official)) event.status = 'ANNOUNCED';
          event.sourceIds = [c.id];
          accepted.push(event);
        }
        run.accepted = accepted.length;
        run.status = 'SUCCESS';
        run.meta = meta ?? null;
        await store.saveSourceCache(c.id, accepted, new Date().toISOString());
      } catch (err) {
        run.status = 'FAILED';
        run.error = String(err?.message ?? err).slice(0, 500);
      }
    }
    if (!accepted) {
      // Skipped or failed: reuse the last good payload so merged fields don't flap.
      const cache = await store.getSourceCache(c.id);
      if (cache) { accepted = cache.events; run.usedCacheFrom = cache.fetchedAt; }
    }
    if (accepted) { fresh.push(...accepted); usable.add(c.id); }
    if (run.status === 'SUCCESS') succeeded.add(c.id);
    run.finishedAt = new Date().toISOString();
    run.durationMs = Date.now() - started;
    results.push(run);
    if (run.status !== 'SKIPPED') await store.recordRun({ ...run, warnings: run.warnings.slice(0, 50) });
  }

  // Events whose every source is unusable this run (failed with no cache, or
  // connector disabled) are carried forward unchanged.
  const sourcesOf = e => (e.sourceIds?.length ? e.sourceIds : ['curated']);
  const carried = previous.filter(e => !sourcesOf(e).some(id => usable.has(id)));
  const official = fresh.filter(e => e.sources.some(s => s.official));
  const other = fresh.filter(e => !e.sources.some(s => s.official));
  const merged = dedupeEvents([...official, ...other]);

  const images = await fighterImages();
  const nowIso = now.toISOString();
  const changes = [];
  const reviewFlags = [];
  const next = [];
  const matchedPrev = new Set();

  for (const ev of merged) {
    const prev = previous.find(p => p.id === ev.id) ?? previous.find(p => !matchedPrev.has(p.id) && sameEvent(p, ev));
    if (prev) { matchedPrev.add(prev.id); ev.id = prev.id; }
    const main = ev.fights[0];
    if (!ev.images.length && main && main.status !== 'CANCELED') {
      ev.images = [images.get(slugify(main.a)), images.get(slugify(main.b))].filter(Boolean);
    }
    const diff = diffEvents(prev ? snapshotOf(prev) : null, snapshotOf(ev));
    const material = prev ? diff.filter(d => MATERIAL_CHANGES.has(d.type)) : diff;
    if (prev && !isValidTransition(prev.status, ev.status)) reviewFlags.push(`${ev.id}: unusual status change ${prev.status} → ${ev.status}`);
    ev.firstSeenAt = prev?.firstSeenAt ?? nowIso;
    ev.lastSeenAt = nowIso;
    ev.updatedAt = material.length ? nowIso : prev?.updatedAt ?? nowIso;
    ev.sequence = (prev?.sequence ?? 0) + (prev && material.length ? 1 : 0);
    ev.missingFromSource = false;
    ev.announce = prev ? prev.announce !== false : true;
    for (const d of material) changes.push({ eventId: ev.id, ...d, from: d.from ?? null, to: d.to ?? null });
    next.push(ev);
  }

  for (const prev of previous) {
    if (matchedPrev.has(prev.id) || next.some(n => n.id === prev.id)) continue;
    if (carried.includes(prev)) { next.push(prev); continue; }
    // A source that succeeded no longer lists this event. Keep it (never
    // silently delete or auto-cancel); flag upcoming events for review.
    const flagged = { ...prev };
    if (isUpcoming(prev, now) && !prev.missingFromSource) {
      flagged.missingFromSource = true;
      flagged.updatedAt = nowIso;
      changes.push({ eventId: prev.id, type: 'EVENT_REMOVED', summary: 'No longer listed by its source. Treat as unconfirmed until re-verified.', from: null, to: null });
      reviewFlags.push(`${prev.id}: missing from source`);
    }
    next.push(flagged);
  }

  // A run that adds many events at once is a bulk import (first deploy,
  // re-curation, new source): store them, but don't email them as "new".
  const added = next.filter(e => !previous.some(p => p.id === e.id));
  const bulk = added.length > numberEnv('BULK_IMPORT_THRESHOLD', 15);
  if (bulk) { for (const e of added) e.announce = false; reviewFlags.push(`bulk import: ${added.length} new events stored without new-fight alerts`); }

  for (const ev of next) if (ev.conflicts?.length) reviewFlags.push(`${ev.id}: source conflict ${ev.conflicts.map(c => `${c.field}=${c.value} (${c.source})`).join(', ')}`);

  if (usable.size) {
    await store.saveEvents(next);
    await store.recordChanges(changes);
  }
  if (succeeded.has('curated')) await store.saveDeveloping(await loadDeveloping());

  return { startedAt: runStarted, finishedAt: new Date().toISOString(), sources: results, events: next.length, changes: changes.length, reviewFlags };
}

// Freshness summary used by /health, /api/meta and the admin dashboard.
export async function freshness(now = new Date()) {
  const runs = await store.listRuns({ limit: 100 });
  const events = await store.listEvents();
  const lastSuccess = runs.find(r => r.status === 'SUCCESS')?.finishedAt ?? null;
  const lastRun = runs[0] ?? null;
  const upcoming = events.filter(e => isUpcoming(e, now));
  const verified = upcoming.map(e => e.verifiedAt).filter(Boolean).sort();
  const oldestVerified = verified[0] ?? null;
  const newestVerified = verified.at(-1) ?? null;
  const ingestFresh = Boolean(lastSuccess) && now - Date.parse(lastSuccess) < staleAfterHours() * 3600000;
  const needsReverify = upcoming.filter(e => !e.verifiedAt || now - Date.parse(e.verifiedAt) > reverifyAfterDays() * 86400000).map(e => e.id);
  return {
    lastSuccessfulIngestAt: lastSuccess,
    lastRun: lastRun && { source: lastRun.source, status: lastRun.status, finishedAt: lastRun.finishedAt, error: lastRun.error ?? null },
    ingestFresh,
    dataVerifiedAt: newestVerified,
    oldestVerifiedAt: oldestVerified,
    needsReverify,
    upcomingEvents: upcoming.length,
    fresh: ingestFresh && upcoming.length > 0 && needsReverify.length < Math.max(1, upcoming.length / 2)
  };
}
