import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Each test file gets an isolated data directory and no external services.
export function isolate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fightslate-test-'));
  process.env.DATA_DIR = dir;
  delete process.env.DATABASE_URL;
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_ENABLED;
  delete process.env.UFCALENDAR_API_KEY;
  delete process.env.BOXERBOOK_API_KEY;
  delete process.env.ADMIN_TOKEN;
  process.env.TOKEN_SECRET = 'test-secret-test-secret-test-secret';
  return dir;
}

export function event(overrides = {}) {
  return {
    id: 'ev-1', sport: 'Boxing', promotion: 'Matchroom Boxing', title: 'A vs B', headline: 'Alpha One vs Bravo Two',
    date: '2030-06-01', start: '2030-06-01T20:00:00.000Z', timeNote: 'Main card 9 PM BST', venue: 'Arena', location: 'London, UK',
    network: 'DAZN', broadcastVerified: true, status: 'CONFIRMED',
    fights: [{ a: 'Alpha One', b: 'Bravo Two' }, { a: 'Charlie Three', b: 'Delta Four' }],
    sources: [{ label: 'Official', url: 'https://example.com/a-vs-b', retrievedAt: '2030-05-01', official: true }],
    ...overrides
  };
}
