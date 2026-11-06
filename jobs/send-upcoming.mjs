import { notifyUpcoming } from '../lib/notify.mjs';
console.log(JSON.stringify(await notifyUpcoming({ dryRun: process.argv.includes('--dry-run') })));
process.exit(0);
