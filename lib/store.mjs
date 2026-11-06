import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './config.mjs';
import { normalizeEvent } from '../public/js/core.mjs';

// Storage. With DATABASE_URL set it uses PostgreSQL through Prisma; without it
// JSON files under DATA_DIR (default data/runtime/, git-ignored) so the app
// runs locally with zero setup.

let prisma = null;
async function getPrisma() {
  if (!process.env.DATABASE_URL) return null;
  if (!prisma) { const mod = await import('@prisma/client'); prisma = new mod.PrismaClient(); }
  return prisma;
}
export const storageMode = () => (process.env.DATABASE_URL ? 'postgres' : 'file');

// ---------- file helpers (serialised writes per file) ----------
const locks = new Map();
async function readFile(name, fallback) {
  try { return JSON.parse(await fs.readFile(path.join(dataDir(), name), 'utf8')); } catch { return fallback; }
}
async function writeFile(name, data) {
  await fs.mkdir(dataDir(), { recursive: true });
  const file = path.join(dataDir(), name), tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}
async function mutate(name, fallback, fn) {
  const prev = locks.get(name) ?? Promise.resolve();
  let result;
  const next = prev.then(async () => { const data = await readFile(name, fallback); result = await fn(data); await writeFile(name, data); });
  locks.set(name, next.catch(() => {}));
  await next;
  return result;
}

const iso = d => (d instanceof Date ? d.toISOString() : d ?? null);

// ---------- events ----------
function fromRow(row) {
  const { event } = normalizeEvent({
    ...row,
    date: row.date instanceof Date ? row.date.toISOString().slice(0, 10) : row.date,
    start: iso(row.start), verifiedAt: iso(row.verifiedAt), firstSeenAt: iso(row.firstSeenAt),
    lastSeenAt: iso(row.lastSeenAt), updatedAt: iso(row.updatedAt)
  });
  return { ...event, sourceIds: row.sourceIds ?? [], conflicts: row.conflicts ?? [], announce: row.announce !== false };
}

function toRow(e) {
  return {
    sport: e.sport, promotion: e.promotion, title: e.title, headline: e.headline,
    date: new Date(`${e.date}T00:00:00Z`), timezone: e.timezone, start: e.start ? new Date(e.start) : null,
    startKind: e.startKind, timeNote: e.timeNote, venue: e.venue, location: e.location, network: e.network,
    broadcastVerified: e.broadcastVerified, status: e.status, statusReason: e.statusReason,
    images: e.images, sources: e.sources, fights: e.fights, sourceIds: e.sourceIds ?? [], conflicts: e.conflicts ?? [],
    verifiedAt: e.verifiedAt ? new Date(e.verifiedAt) : null, firstSeenAt: new Date(e.firstSeenAt),
    lastSeenAt: new Date(e.lastSeenAt), sequence: e.sequence, missingFromSource: e.missingFromSource, announce: e.announce !== false
  };
}

export async function listEvents() {
  const p = await getPrisma();
  const rows = p ? await p.event.findMany({ orderBy: [{ date: 'asc' }, { headline: 'asc' }] }) : await readFile('events.json', []);
  return rows.map(fromRow).filter(e => e.sport && e.date);
}

export async function getEvent(id) {
  return (await listEvents()).find(e => e.id === id) ?? null;
}

// Writes the full event set produced by an ingestion run.
export async function saveEvents(events) {
  const p = await getPrisma();
  if (!p) { await writeFile('events.json', events); return; }
  await p.$transaction(events.map(e => {
    const data = toRow(e);
    return p.event.upsert({ where: { id: e.id }, update: data, create: { id: e.id, ...data } });
  }));
}

// ---------- developing (unconfirmed) matchups ----------
export async function listDeveloping() {
  const p = await getPrisma();
  if (p) return p.developingMatchup.findMany({ orderBy: { updatedAt: 'desc' } });
  return readFile('developing.json', []);
}
export async function saveDeveloping(rows) {
  const p = await getPrisma();
  if (!p) return writeFile('developing.json', rows);
  const ids = rows.map(r => r.id);
  await p.$transaction([
    p.developingMatchup.deleteMany({ where: { id: { notIn: ids } } }),
    ...rows.map(r => p.developingMatchup.upsert({ where: { id: r.id }, update: r, create: r }))
  ]);
}

// ---------- change history ----------
export async function recordChanges(changes) {
  if (!changes.length) return;
  const rows = changes.map(c => ({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...c }));
  const p = await getPrisma();
  if (p) { await p.eventChange.createMany({ data: rows.map(r => ({ ...r, createdAt: new Date(r.createdAt) })) }); return; }
  await mutate('changes.json', [], list => { list.push(...rows); if (list.length > 5000) list.splice(0, list.length - 5000); });
}

export async function listChanges({ since, eventIds, limit = 200 } = {}) {
  const p = await getPrisma();
  let rows;
  if (p) {
    rows = await p.eventChange.findMany({
      where: { ...(since ? { createdAt: { gt: new Date(since) } } : {}), ...(eventIds?.length ? { eventId: { in: eventIds } } : {}) },
      orderBy: { createdAt: 'desc' }, take: limit
    });
    return rows.map(r => ({ ...r, createdAt: iso(r.createdAt) }));
  }
  rows = await readFile('changes.json', []);
  return rows
    .filter(r => (!since || r.createdAt > since) && (!eventIds?.length || eventIds.includes(r.eventId)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

// ---------- per-source cache (last good payload) ----------
export async function getSourceCache(source) {
  const p = await getPrisma();
  if (p) { const r = await p.sourceCache.findUnique({ where: { source } }); return r && { events: r.events, fetchedAt: iso(r.fetchedAt) }; }
  return (await readFile('source-cache.json', {}))[source] ?? null;
}
export async function saveSourceCache(source, events, fetchedAt) {
  const p = await getPrisma();
  if (p) { await p.sourceCache.upsert({ where: { source }, update: { events, fetchedAt: new Date(fetchedAt) }, create: { source, events, fetchedAt: new Date(fetchedAt) } }); return; }
  await mutate('source-cache.json', {}, all => { all[source] = { events, fetchedAt }; });
}

// ---------- ingestion runs ----------
export async function recordRun(run) {
  const row = { id: crypto.randomUUID(), ...run };
  const p = await getPrisma();
  if (p) return p.ingestionRun.create({ data: { ...row, startedAt: new Date(row.startedAt), finishedAt: new Date(row.finishedAt) } });
  await mutate('runs.json', [], list => { list.push(row); if (list.length > 500) list.splice(0, list.length - 500); });
  return row;
}

export async function listRuns({ limit = 50 } = {}) {
  const p = await getPrisma();
  if (p) return (await p.ingestionRun.findMany({ orderBy: { startedAt: 'desc' }, take: limit })).map(r => ({ ...r, startedAt: iso(r.startedAt), finishedAt: iso(r.finishedAt) }));
  return (await readFile('runs.json', [])).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
}

// ---------- subscribers ----------
export async function upsertSubscriber(input) {
  const p = await getPrisma();
  if (p) return p.subscriber.upsert({ where: { email: input.email }, update: input, create: input });
  return mutate('subscribers.json', [], rows => {
    let row = rows.find(x => x.email === input.email);
    const now = new Date().toISOString();
    if (row) Object.assign(row, input, { updatedAt: now });
    else { row = { id: crypto.randomUUID(), status: 'PENDING', createdAt: now, updatedAt: now, ...input }; rows.push(row); }
    return { ...row };
  });
}
export async function findSubscriberByEmail(email) {
  const p = await getPrisma();
  if (p) return p.subscriber.findUnique({ where: { email } });
  return (await readFile('subscribers.json', [])).find(x => x.email === email) ?? null;
}
export async function findSubscriberById(id) {
  const p = await getPrisma();
  if (p) return p.subscriber.findUnique({ where: { id } });
  return (await readFile('subscribers.json', [])).find(x => x.id === id) ?? null;
}
export async function findSubscriberByHash(field, hash) {
  if (!['confirmTokenHash'].includes(field)) throw new Error('unsupported lookup field');
  const p = await getPrisma();
  if (p) return p.subscriber.findFirst({ where: { [field]: hash } });
  return (await readFile('subscribers.json', [])).find(x => x[field] === hash) ?? null;
}
export async function updateSubscriber(id, data) {
  const p = await getPrisma();
  if (p) return p.subscriber.update({ where: { id }, data });
  return mutate('subscribers.json', [], rows => {
    const row = rows.find(x => x.id === id);
    if (!row) return null;
    Object.assign(row, data, { updatedAt: new Date().toISOString() });
    return { ...row };
  });
}
export async function activeSubscribers() {
  const p = await getPrisma();
  if (p) return p.subscriber.findMany({ where: { status: 'ACTIVE' } });
  return (await readFile('subscribers.json', [])).filter(x => x.status === 'ACTIVE');
}

// ---------- deliveries ----------
export async function deliveryExists(key) {
  const p = await getPrisma();
  if (p) return (await p.delivery.findUnique({ where: { dedupeKey: key } }))?.status === 'SENT';
  return (await readFile('deliveries.json', [])).some(x => x.dedupeKey === key && x.status === 'SENT');
}
export async function logDelivery(data) {
  const p = await getPrisma();
  if (p) {
    // A failed attempt may be retried later under the same key.
    return p.delivery.upsert({ where: { dedupeKey: data.dedupeKey }, update: data, create: data });
  }
  return mutate('deliveries.json', [], rows => {
    const existing = rows.find(x => x.dedupeKey === data.dedupeKey);
    if (existing) { Object.assign(existing, data); return existing; }
    const row = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...data };
    rows.push(row);
    return row;
  });
}

export async function stats() {
  const p = await getPrisma();
  if (p) {
    const [events, subscribers, deliveries] = await Promise.all([
      p.event.count(), p.subscriber.count({ where: { status: 'ACTIVE' } }), p.delivery.count({ where: { status: 'SENT' } })
    ]);
    return { events, subscribers, deliveries, mode: 'postgres' };
  }
  return {
    events: (await listEvents()).length,
    subscribers: (await activeSubscribers()).length,
    deliveries: (await readFile('deliveries.json', [])).filter(x => x.status === 'SENT').length,
    mode: 'file'
  };
}
