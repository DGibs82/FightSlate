// Kept for compatibility with the Render preDeployCommand: seeding is now an
// ingestion run (curated snapshot + any enabled licensed sources).
import { runIngestion } from '../lib/ingest.mjs';
const result = await runIngestion({ force: true });
console.log(JSON.stringify({ events: result.events, changes: result.changes, sources: result.sources.map(s => `${s.source}:${s.status}`), reviewFlags: result.reviewFlags }));
process.exit(result.sources.some(s => s.status === 'SUCCESS') ? 0 : 1);
