/* Handlers for `kind: 'local'` experiments — ones the Worker answers itself
 * rather than proxying to an origin.
 *
 * This map is defined HERE, in the platform, not in a lab file. A lab may name
 * a handler; it cannot supply one. That keeps the property that makes labs
 * safe: a lab is data, and adding one never introduces executable code to the
 * public surface.
 */

const STATE_TTL = 3600;

/** Per-visitor state, kept in the Cache API rather than KV.
 *
 *  KV's free tier allows 1,000 writes/day and a limiter writes on every
 *  request. The Cache API has no such ceiling. It is per-colo rather than
 *  global and offers no atomicity — both true, both fine here, because the key
 *  is one visitor and a single reader does not race themselves. Post 4 is
 *  about exactly this trade-off, so the demo embodies it rather than hiding it.
 */
async function readState(cache, key) {
  const hit = await cache.match(key);
  if (!hit) return null;
  try { return await hit.json(); } catch { return null; }
}

async function writeState(cache, key, state) {
  // Awaited, not fired into waitUntil: a reader clicking twice quickly must see
  // their own previous request reflected, or the demo teaches the wrong thing.
  await cache.put(key, new Response(JSON.stringify(state), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, s-maxage=${STATE_TTL}`,
    },
  }));
}

/**
 * A real token bucket, enforced for real. Refills continuously at `rate` up to
 * `burst`, spends one token per request, and refuses with 429 when empty.
 */
async function tokenBucket({ params, visitor, cache }) {
  const rate = params.rate;
  const capacity = params.burst;
  const now = Date.now();

  const key = new Request(`https://play.invalid/_state/ratelimit/token-bucket/${visitor}`);
  const prior = await readState(cache, key);

  let tokens = prior ? prior.tokens : capacity;
  const last = prior ? prior.last : now;
  tokens = Math.min(capacity, tokens + ((now - last) / 1000) * rate);

  const allowed = tokens >= 1;
  if (allowed) tokens -= 1;

  await writeState(cache, key, { tokens, last: now });

  // Seconds until one whole token exists again. Sent as Retry-After so a client
  // can wait exactly the right amount rather than guessing — post 5's point.
  const deficit = allowed ? 0 : 1 - tokens;
  const retryAfter = Math.max(1, Math.ceil(deficit / rate));

  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-RateLimit-Limit': String(capacity),
    'X-RateLimit-Remaining': String(Math.max(0, Math.floor(tokens))),
    'X-RateLimit-Reset': String(Math.ceil((capacity - tokens) / rate)),
  };
  if (!allowed) headers['Retry-After'] = String(retryAfter);

  return new Response(JSON.stringify({
    allowed,
    tokens: Math.round(tokens * 100) / 100,
    capacity,
    rate,
    retry_after: allowed ? null : retryAfter,
    at: new Date(now).toISOString(),
  }, null, 2), { status: allowed ? 200 : 429, headers });
}

export const HANDLERS = { tokenBucket };
