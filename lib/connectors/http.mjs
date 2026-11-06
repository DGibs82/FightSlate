// Small fetch wrapper used by licensed-API connectors: timeout + retries with
// exponential backoff, honouring Retry-After on 429/503.
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function withRetry(fn, { attempts = 3, baseDelayMs = 500, onAttempt = () => {} } = {}) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    onAttempt(i);
    try { return await fn(i); } catch (err) {
      lastError = err;
      // Client errors other than rate limiting will not succeed on retry.
      if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429) break;
      if (i < attempts) await sleep(err.retryAfterMs ?? baseDelayMs * 2 ** (i - 1));
    }
  }
  throw lastError;
}

export async function getJson(url, { headers = {}, timeoutMs = 15000, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': 'FightSlate/2 (+schedule app)', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const err = new HttpError(res.status, `GET ${new URL(url).pathname} -> HTTP ${res.status}`);
    const retryAfter = Number(res.headers.get('retry-after'));
    if (retryAfter > 0 && retryAfter <= 60) err.retryAfterMs = retryAfter * 1000;
    throw err;
  }
  return res.json();
}
