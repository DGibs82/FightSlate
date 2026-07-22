import crypto from 'node:crypto';
const secret=()=>process.env.TOKEN_SECRET||'dev-only-change-me';
export function makeToken(){ return crypto.randomBytes(32).toString('base64url'); }
export function hashToken(t){ return crypto.createHmac('sha256',secret()).update(t).digest('hex'); }
