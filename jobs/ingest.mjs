import { runIngestion } from '../lib/ingest.mjs';
const result = await runIngestion({ force: process.argv.includes('--force') });
console.log(JSON.stringify(result, null, 2));
process.exit(result.sources.some(s => s.status === 'SUCCESS') ? 0 : 1);
