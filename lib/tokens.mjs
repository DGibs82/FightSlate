import crypto from 'node:crypto';
import { tokenSecret } from './config.mjs';

export function makeToken() { return crypto.randomBytes(32).toString('base64url'); }

// Confirmation tokens are random; only their HMAC is stored.
export function hashToken(token) {
  return crypto.createHmac('sha256', tokenSecret()).update(String(token)).digest('hex');
}

// Unsubscribe tokens are derived from the subscriber id, so every email (sent
// by the web service or a cron job) can include a working link without
// storing the raw token. Requires the same TOKEN_SECRET in every service.
export function unsubscribeToken(subscriberId) {
  return crypto.createHmac('sha256', tokenSecret()).update(`unsubscribe:${subscriberId}`).digest('base64url');
}

export function verifyUnsubscribeToken(subscriberId, token) {
  const expected = Buffer.from(unsubscribeToken(subscriberId));
  const given = Buffer.from(String(token ?? ''));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
