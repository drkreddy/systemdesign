/* Rate limiter simulators.
 *
 * Pure functions: (events, config) -> decisions[]. No network, no clock, no
 * randomness — the same input always produces the same output, so the widgets
 * and the node tests exercise identical code.
 *
 * Running these in the browser rather than at an edge is deliberate. Deciding
 * whether request 11 is allowed is arithmetic; a round trip to Oregon would add
 * latency, burn request quota, and risk this site's own rate limit blocking a
 * lab about rate limits.
 *
 * `events` is an array of timestamps in milliseconds, ascending.
 * Every simulator returns one decision per event:
 *   { t, allowed, state }   state is algorithm-specific, for display
 */

/* --------------------------------------------------------------- patterns */

/** n requests spaced evenly, starting at `from`. */
export function steady(n, intervalMs, from = 0) {
  return Array.from({ length: n }, (_, i) => from + i * intervalMs);
}

/** n requests all at once. */
export function burst(n, atMs = 0) {
  return Array.from({ length: n }, () => atMs);
}

/**
 * The pattern that makes fixed windows fail: a full limit's worth of requests
 * at the very end of one window, and another full limit at the start of the
 * next. Two seconds apart, 2x the limit, entirely within the rules.
 */
export function boundaryBurst(limit, windowMs) {
  const justBefore = windowMs - 1000;
  const justAfter = windowMs + 1000;
  return [...burst(limit, justBefore), ...burst(limit, justAfter)];
}

/* ------------------------------------------------------------- algorithms */

/**
 * Fixed window. Divide time into buckets and count per bucket.
 * Cheapest to implement and the one almost everyone writes first. Its flaw is
 * structural rather than a bug: the counter resets on a wall-clock boundary the
 * client can see coming.
 */
export function fixedWindow(events, { limit, windowMs }) {
  let currentWindow = null;
  let count = 0;
  return events.map((t) => {
    const w = Math.floor(t / windowMs);
    if (w !== currentWindow) { currentWindow = w; count = 0; }
    const allowed = count < limit;
    if (allowed) count++;
    return { t, allowed, state: { window: w, count, limit } };
  });
}

/**
 * Sliding window log. Keep every timestamp in the trailing window and count
 * them. Exactly correct — no boundary to exploit — but memory grows with the
 * request rate, which is why it is rarely used at scale unmodified.
 */
export function slidingLog(events, { limit, windowMs }) {
  const log = [];
  return events.map((t) => {
    const cutoff = t - windowMs;
    while (log.length && log[0] <= cutoff) log.shift();
    const allowed = log.length < limit;
    if (allowed) log.push(t);
    return { t, allowed, state: { inWindow: log.length, limit } };
  });
}

/**
 * Sliding window counter. Keeps two counters and weights the previous window by
 * how much of it still overlaps. Two numbers instead of a list, and it closes
 * the boundary hole — at the cost of assuming the previous window's traffic was
 * evenly spread, which it usually is not.
 */
export function slidingCounter(events, { limit, windowMs }) {
  let currentWindow = null;
  let currentCount = 0;
  let previousCount = 0;
  return events.map((t) => {
    const w = Math.floor(t / windowMs);
    if (currentWindow === null) currentWindow = w;
    if (w !== currentWindow) {
      // Windows may be skipped entirely if traffic paused.
      previousCount = w === currentWindow + 1 ? currentCount : 0;
      currentCount = 0;
      currentWindow = w;
    }
    const elapsed = t - w * windowMs;
    const overlap = (windowMs - elapsed) / windowMs;
    const estimate = previousCount * overlap + currentCount;
    const allowed = estimate < limit;
    if (allowed) currentCount++;
    return {
      t,
      allowed,
      state: { estimate: Math.round(estimate * 100) / 100, currentCount, previousCount, limit },
    };
  });
}

/**
 * Token bucket. Tokens refill continuously at `ratePerSec` up to `burst`.
 * A request spends one. Bursts are permitted *on purpose*, bounded by the
 * bucket size — which is usually what you actually want, since real clients are
 * bursty and a limiter that punishes every burst punishes normal behaviour.
 */
export function tokenBucket(events, { ratePerSec, burst: capacity }) {
  let tokens = capacity;
  let last = events.length ? events[0] : 0;
  return events.map((t) => {
    const elapsedSec = Math.max(0, t - last) / 1000;
    tokens = Math.min(capacity, tokens + elapsedSec * ratePerSec);
    last = t;
    const allowed = tokens >= 1;
    if (allowed) tokens -= 1;
    return {
      t,
      allowed,
      state: { tokens: Math.round(tokens * 100) / 100, capacity, ratePerSec },
    };
  });
}

export const ALGORITHMS = {
  'fixed-window':    { label: 'Fixed window',          fn: fixedWindow },
  'sliding-log':     { label: 'Sliding window log',    fn: slidingLog },
  'sliding-counter': { label: 'Sliding window counter', fn: slidingCounter },
  'token-bucket':    { label: 'Token bucket',          fn: tokenBucket },
};

/** Runs one pattern through several algorithms so they can be compared. */
export function compare(events, config, keys = Object.keys(ALGORITHMS)) {
  return keys.map((k) => ({
    key: k,
    label: ALGORITHMS[k].label,
    decisions: ALGORITHMS[k].fn(events, config),
  }));
}

export const allowedCount = (decisions) => decisions.filter((d) => d.allowed).length;

/* ------------------------------------------------- distributed limiters */

/**
 * Deterministic pseudo-random, so "random" load balancing produces the same
 * picture on every page load. A widget that reshuffles on refresh makes readers
 * doubt the result rather than the design.
 */
function lcg(i) {
  let x = (i * 1103515245 + 12345) & 0x7fffffff;
  x ^= x >>> 7;
  return x & 0x7fffffff;
}

/** Splits one client's requests across N instances. */
export function spread(events, { instances, strategy = 'round-robin' }) {
  const buckets = Array.from({ length: instances }, () => []);
  events.forEach((t, i) => {
    let idx;
    if (strategy === 'sticky') idx = 0;              // routed by client id
    else if (strategy === 'random') idx = lcg(i) % instances;
    else idx = i % instances;
    buckets[idx].push(t);
  });
  return buckets;
}

/**
 * Runs an independent limiter on every instance, exactly as a fleet does when
 * each server counts in its own memory. The aggregate is what the client
 * actually experiences — and it is not the limit you configured.
 */
export function distributed(events, config, { instances, strategy = 'round-robin', algorithm = 'sliding-counter' }) {
  const buckets = spread(events, { instances, strategy });
  const perInstance = buckets.map((b) => ALGORITHMS[algorithm].fn(b, config));
  return {
    perInstance,
    totalAllowed: perInstance.reduce((a, d) => a + allowedCount(d), 0),
    totalSent: events.length,
  };
}
