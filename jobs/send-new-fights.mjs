import { notifyNew } from '../lib/notify.mjs';
console.log(JSON.stringify(await notifyNew({ dryRun: process.argv.includes('--dry-run') })));
process.exit(0);
