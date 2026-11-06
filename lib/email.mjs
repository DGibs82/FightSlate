import { emailMode } from './config.mjs';

// Sends through Resend only when emailMode() === 'live' (EMAIL_ENABLED=true
// plus RESEND_API_KEY and EMAIL_FROM). Otherwise the message is logged and
// reported as a preview, so nothing reaches a real inbox by accident.
export const sentPreviews = [];

export async function sendEmail({ to, subject, html, text, idempotencyKey, headers = {} }, { fetchImpl = fetch } = {}) {
  if (emailMode() !== 'live') {
    const preview = { to, subject, idempotencyKey, at: new Date().toISOString() };
    sentPreviews.push({ ...preview, html, headers });
    if (sentPreviews.length > 100) sentPreviews.shift();
    console.log('[email preview]', preview);
    return { id: `preview-${Date.now()}`, preview: true };
  }
  const r = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], reply_to: process.env.EMAIL_REPLY_TO || undefined, subject, html, text, headers }),
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

export const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
