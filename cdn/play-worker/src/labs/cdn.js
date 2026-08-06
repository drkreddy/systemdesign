import { defineLab } from '../core.js';

// The CDN lab, expressed purely as data. Every parameter declares its own
// bounds; core.js refuses to start if any is missing one, which is what stops a
// new experiment from quietly handing an uncapped value to a 0.1-CPU origin.
//
// Caps are far below the origin's own limits on purpose. The lab endpoints
// accept ms up to 20000 and kb up to 5000 — fine for a private lab driven by
// one person, a denial-of-service toy when strangers can call it.
export default defineLab('cdn', {
  // Post 1 & 2 — is this cached, and what does the status word mean?
  'cache-status': {
    origin: '/cache',
    ttl: 20,
    swr: 40,
    params: {
      maxage: { type: 'int', min: 0, max: 300, default: 60 },
    },
  },

  // Post 1 — an expensive response is the one worth caching. Capped at 1.5s:
  // enough to feel the difference between MISS and HIT, short enough that a
  // burst cannot tie the origin up.
  'expensive': {
    origin: '/api/slow',
    ttl: 20,
    swr: 40,
    params: {
      ms: { type: 'int', min: 0, max: 1500, default: 800 },
    },
  },

  // Post 2 — never cacheable, whatever the reader tries. Proves the difference
  // between "the CDN would not" and "the header said not to".
  'never-cached': {
    origin: '/api/time',
    ttl: 0,
    swr: 0,
    params: {},
  },

  // Post 4 — cache keys. The reader appends a tracking parameter and watches a
  // single logical object shatter into several cached copies.
  'cache-key': {
    origin: '/cache',
    ttl: 30,
    swr: 30,
    params: {
      maxage: { type: 'int', min: 0, max: 300, default: 120 },
      utm_source: { type: 'enum', values: ['none', 'twitter', 'facebook', 'newsletter'], default: 'none' },
      fbclid: { type: 'enum', values: ['none', 'abc123', 'xyz789'], default: 'none' },
    },
  },

  // Post 5 — fresh, stale, dead. Deliberately tiny windows so the whole
  // lifecycle is watchable inside a single page view.
  'ttl-timeline': {
    origin: '/cache',
    ttl: 5,
    swr: 10,
    params: {
      maxage: { type: 'int', min: 0, max: 60, default: 5 },
    },
  },

  // Post 6 — the herd. The widget fires several of these at once; the origin's
  // own counter shows how many actually arrived.
  'stampede': {
    origin: '/api/slow',
    ttl: 15,
    swr: 30,
    params: {
      ms: { type: 'int', min: 0, max: 1000, default: 600 },
    },
  },

  // Read-only view of the origin's counters, so a widget can prove a HIT never
  // reached Oregon. /stats is not cached and is never mutated from here —
  // /stats/reset is deliberately absent from this registry.
  'origin-stats': {
    origin: '/stats',
    ttl: 0,
    swr: 0,
    params: {},
  },
});
