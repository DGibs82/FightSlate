import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const isProduction = () => process.env.NODE_ENV === 'production';

const MIN_SECRET_LENGTH = 24;

// Admin endpoints are disabled unless a strong ADMIN_TOKEN is configured.
// There is deliberately no default value.
export function adminToken() {
  const t = process.env.ADMIN_TOKEN;
  return t && t.length >= MIN_SECRET_LENGTH ? t : null;
}

export function isAdminRequest(req) {
  const expected = adminToken();
  if (!expected) return false;
  const header = String(req.headers.authorization ?? '');
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  // Compare fixed-length digests so the comparison is constant-time.
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b) && given.length > 0;
}

let devSecret = null;
// TOKEN_SECRET signs unsubscribe links and hashes confirmation tokens. It must
// be identical for the web service and every cron job. In production it is
// required; in development a random secret is persisted under the data dir so
// links keep working across restarts without a shared, known default.
export function tokenSecret() {
  const s = process.env.TOKEN_SECRET;
  if (s && s.length >= MIN_SECRET_LENGTH) return s;
  if (isProduction()) throw new Error('TOKEN_SECRET (24+ chars) is required in production');
  if (devSecret) return devSecret;
  const file = path.join(dataDir(), '.dev-token-secret');
  try { devSecret = fs.readFileSync(file, 'utf8').trim(); } catch { /* create below */ }
  if (!devSecret || devSecret.length < MIN_SECRET_LENGTH) {
    devSecret = crypto.randomBytes(32).toString('base64url');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, devSecret, { mode: 0o600 });
  }
  return devSecret;
}

export function dataDir() {
  return process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data', 'runtime');
}

export function seedFile() {
  return process.env.SEED_FILE ? path.resolve(process.env.SEED_FILE) : path.join(ROOT, 'data', 'events.json');
}

export function appUrl() {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  if (process.env.RENDER_EXTERNAL_HOSTNAME) return `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`;
  return `http://localhost:${process.env.PORT || 8787}`;
}

// Email is only sent for real when explicitly enabled. Otherwise messages are
// logged ("preview"), so a deploy can never surprise subscribers.
export function emailMode() {
  if (process.env.EMAIL_ENABLED === 'true' && process.env.RESEND_API_KEY && process.env.EMAIL_FROM) return 'live';
  return 'preview';
}

export function numberEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Hours after which data is flagged stale in /health, the UI and admin.
export const staleAfterHours = () => numberEnv('STALE_AFTER_HOURS', 36);
// Curated (hand-verified) entries older than this are flagged for re-verification.
export const reverifyAfterDays = () => numberEnv('REVERIFY_AFTER_DAYS', 7);
