// Programmable CDN edge for the lab.
//
// Everything here is something Cloudflare's dashboard either cannot do on the
// free plan or cannot express at all:
//
//   1. per-path caching policy as code, reviewable in git
//   2. cache-key normalisation — dropping utm_/fbclid, which is Enterprise-only
//      as a config setting
//   3. stale-while-revalidate, which this plan does not honour from headers
//
// Instrumentation: every response carries X-Edge-* headers describing which
// policy matched and what the cache did, so behaviour is observable from curl
// rather than inferred.

// The origin's own hostname. Requests are sent here rather than back through
// cdn-lab.drkreddy.com so that Cloudflare's zone cache never sits between this
// Worker and the origin — see the note in fetchAndStore.
const ORIGIN_HOST = 'cdn-lab-origin.onrender.com';

// Params that never change the response body. Stripping them from the cache key
// collapses every tracking-decorated variant of a URL onto one entry. Measured
// before this existed: 5 requests for one object produced 4 origin hits.
const TRACKING_PARAMS = [
  /^utm_/i,          // utm_source, utm_medium, utm_campaign, utm_term, utm_content
  /^fbclid$/i,       // Facebook
  /^gclid$/i,        // Google Ads
  /^gbraid$/i, /^wbraid$/i,
  /^msclkid$/i,      // Microsoft Ads
  /^mc_(cid|eid)$/i, // Mailchimp
  /^igshid$/i,       // Instagram
  /^ref$/i, /^referrer$/i,
];

// Ordered — first match wins, so put specific prefixes before general ones.
const ROUTES = [
  {
    name: 'never-cache',
    test: (p) => p.startsWith('/stats') || p.startsWith('/admin'),
    // /stats is the instrument the experiments read. Caching it would make it
    // report its own stale numbers and quietly invalidate every measurement.
    cache: false,
  },
  {
    name: 'immutable-assets',
    tag: 'assets',
    test: (p) => p.startsWith('/static/'),
    // Fingerprinted filenames: the URL changes when the content does, so the
    // object never needs invalidating and can be cached effectively forever.
    cache: true,
    edgeTtl: 31536000,
    browserTtl: 31536000,
    immutable: true,
  },
  {
    // Deliberately tiny windows so outage behaviour can be exercised in seconds
    // rather than minutes. Matched before api-dynamic, which would otherwise
    // claim this path.
    name: 'resilience-test',
    tag: 'api',
    test: (p) => p === '/api/flaky',
    cache: true,
    edgeTtl: 5,
    browserTtl: 0,
    swr: 5,
  },
  {
    name: 'api-dynamic',
    tag: 'api',
    test: (p) => p.startsWith('/api/'),
    // Short edge TTL with browser revalidation: users see fresh data while the
    // origin sees at most one request per edgeTtl per PoP.
    cache: true,
    edgeTtl: 30,
    browserTtl: 0,
    swr: 120,
  },
  {
    name: 'default',
    tag: 'page',
    test: () => true,
    cache: true,
    edgeTtl: 60,
    browserTtl: 0,
    swr: 120,
  },
];

const pickRoute = (pathname) => ROUTES.find((r) => r.test(pathname));

// Cache generations. Invalidation works by bumping a counter rather than by
// deleting anything: the generation is part of the cache key, so a bump makes
// every existing entry for that tag unreachable at once. Orphaned entries are
// never read again and fall out on their own TTL.
//
// This exists because Cloudflare's purge-by-URL cannot reach entries stored
// under a Worker's custom cache key — measured in Module 5 — leaving
// purge_everything as the only API option, which is a zone-wide stampede.
//
// KV is read once per isolate per GEN_MEMO_MS rather than per request. A KV read
// on every request would add latency to the hot path and defeat the point of
// caching. The cost is that a purge takes up to GEN_MEMO_MS to be noticed by an
// already-warm isolate, on top of KV's own global propagation delay.
// How long past the stale window a copy is kept purely as outage insurance.
// It is never served while the origin is healthy.
const ERROR_GRACE = 86400;

const GEN_MEMO_MS = 5000;
const genMemo = new Map();

async function generation(env, tag) {
  if (!tag) return '0';
  const now = Date.now();
  const memo = genMemo.get(tag);
  if (memo && now - memo.at < GEN_MEMO_MS) return memo.gen;
  const gen = (await env.CACHE_META.get(`gen:${tag}`)) || '0';
  genMemo.set(tag, { gen, at: now });
  return gen;
}

// Every origin request goes through here, so no code path can accidentally
// re-enter Cloudflare's zone cache by requesting our own proxied hostname.
function toOrigin(request) {
  const u = new URL(request.url);
  u.hostname = ORIGIN_HOST;
  return new Request(u.toString(), request);
}

// The cache key is a synthetic GET Request. Building it explicitly — rather than
// letting Cloudflare derive one from the incoming request — is what makes
// normalisation possible.
function cacheKeyFor(request, url, gen) {
  const key = new URL(url.toString());
  const kept = [...key.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.some((re) => re.test(k)))
    .sort(([a], [b]) => a.localeCompare(b));   // ?b=2&a=1 must equal ?a=1&b=2
  key.search = new URLSearchParams(kept).toString();
  // Namespaced by generation, so bumping it orphans every prior entry.
  key.searchParams.set('__g', gen);
  return new Request(key.toString(), { method: 'GET' });
}

// Cache-Control is rewritten on the way out so the browser gets a different TTL
// from the edge. The edge TTL is enforced by what we store; this header governs
// the browser only.
function buildCacheControl(route) {
  if (!route.cache) return 'no-store';
  const parts = [`max-age=${route.browserTtl ?? 0}`];
  if (route.immutable) parts.push('immutable');
  parts.unshift('public');
  return parts.join(', ');
}

function serveStaleOnError(stale, route, gen, why) {
  const res = new Response(stale.body, stale);
  res.headers.set('X-Edge-Route', route.name);
  res.headers.set('X-Edge-Gen', gen ?? '0');
  res.headers.set('X-Edge-Cache', 'STALE-ERROR');
  res.headers.set('X-Edge-Origin-Problem', why);
  res.headers.set('Cache-Control', 'public, max-age=0');
  return res;
}

const age = (res) => {
  const stored = res.headers.get('X-Edge-Stored-At');
  return stored ? Math.floor((Date.now() - Number(stored)) / 1000) : 0;
};

// Fetch from origin and store. Returns the response to serve.
// staleFallback: a cached copy that is too old to serve normally, kept as a
// last resort. An origin that is down should degrade a site to slightly-old
// content, not to an error page — the cache is already holding a better answer
// than a 500.
async function fetchAndStore(request, cacheKey, route, cache, ctx, gen, staleFallback) {
  // Fetch the origin by its OWN hostname rather than re-requesting our proxied
  // one. This is load-bearing, not a tidy-up.
  //
  // A Worker's fetch() to its own route is still served by Cloudflare's zone
  // cache, so a plain fetch(request) during revalidation reads Cloudflare's
  // cached copy instead of the origin, then writes it back into our cache as
  // though it were fresh. Measured: three requests spanning a full SWR cycle all
  // returned the same generated_at with the origin counter stuck at 1 — content
  // could never update, while every cache header reported perfect health.
  //
  // cf: { cacheTtl: 0 } was tried first and did NOT prevent the cached read.
  // Addressing the origin directly is what actually removes the second layer.
  let originRes;
  try {
    originRes = await fetch(toOrigin(request), { cf: { cacheTtl: 0, cacheEverything: false } });
  } catch (err) {
    if (staleFallback) return serveStaleOnError(staleFallback, route, gen, 'unreachable');
    throw err;
  }

  // A 5xx means the origin is failing, not that the content changed. Serving the
  // old copy keeps the site up; caching the 500 would spread the outage.
  if (originRes.status >= 500 && staleFallback) {
    return serveStaleOnError(staleFallback, route, gen, String(originRes.status));
  }

  // Only successful, complete responses are worth storing. Caching a 500 turns
  // a transient origin blip into a sustained outage served from the edge, and a
  // 206 would cache a fragment as if it were the whole body.
  const storable = route.cache && originRes.status === 200;

  const res = new Response(originRes.body, originRes);
  res.headers.set('X-Edge-Route', route.name);
  res.headers.set('X-Edge-Gen', gen ?? '0');
  res.headers.set('Cache-Control', buildCacheControl(route));

  if (!storable) {
    res.headers.set('X-Edge-Cache', 'BYPASS');
    return res;
  }

  // Stored copy differs from the served copy: it carries the timestamp used to
  // compute age, and a deliberately longer s-maxage.
  //
  // The longer TTL is essential. cache.match() refuses to return an entry that
  // has expired per its own Cache-Control, so storing with s-maxage=edgeTtl
  // would make the entry vanish exactly when the stale-while-revalidate window
  // begins — there would be nothing left to serve stale. Freshness is therefore
  // tracked by us via X-Edge-Stored-At, and s-maxage only bounds how long the
  // entry may survive at all.
  // Jitter the stored lifetime by +/-15%. Without it, everything cached during a
  // traffic spike expires together later, recreating the same spike against the
  // origin on a loop. Spreading expiry breaks that synchronisation.
  const jitter = 0.85 + Math.random() * 0.3;
  const survive = Math.round((route.edgeTtl + (route.swr || 0) + ERROR_GRACE) * jitter);
  const toStore = res.clone();
  toStore.headers.set('X-Edge-Stored-At', String(Date.now()));
  toStore.headers.set('Cache-Control', `public, s-maxage=${survive}`);
  ctx.waitUntil(cache.put(cacheKey, toStore));

  res.headers.set('X-Edge-Cache', 'MISS');
  res.headers.set('X-Edge-Age', '0');
  return res;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Tag invalidation endpoint. Authenticated, because an open purge endpoint
    // is a denial-of-service vector: anyone could orphan the cache in a loop and
    // drive every request to the origin.
    if (url.pathname === '/__purge') {
      const provided = request.headers.get('X-Purge-Token') || url.searchParams.get('token');
      if (!env.PURGE_TOKEN || provided !== env.PURGE_TOKEN) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }
      const tag = url.searchParams.get('tag');
      if (!tag) {
        return new Response(JSON.stringify({ error: 'tag required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }
      const current = Number((await env.CACHE_META.get(`gen:${tag}`)) || '0');
      const next = current + 1;
      await env.CACHE_META.put(`gen:${tag}`, String(next));
      genMemo.delete(tag);   // only clears THIS isolate; others wait out GEN_MEMO_MS
      return new Response(JSON.stringify({
        purged: tag, generation: next, at: new Date().toISOString(),
      }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }

    const route = pickRoute(url.pathname);

    // Anything not idempotent must reach the origin untouched.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const originRes = await fetch(toOrigin(request));
      const res = new Response(originRes.body, originRes);
      res.headers.set('X-Edge-Cache', 'BYPASS-METHOD');
      return res;
    }

    if (!route.cache) {
      const originRes = await fetch(toOrigin(request), { cf: { cacheTtl: 0 } });
      const res = new Response(originRes.body, originRes);
      res.headers.set('X-Edge-Route', route.name);
      res.headers.set('X-Edge-Cache', 'BYPASS');
      res.headers.set('Cache-Control', 'no-store');
      return res;
    }

    const cache = caches.default;
    const gen = await generation(env, route.tag);
    const cacheKey = cacheKeyFor(request, url, gen);
    const hit = await cache.match(cacheKey);

    if (hit) {
      const a = age(hit);
      const res = new Response(hit.body, hit);
      res.headers.set('X-Edge-Route', route.name);
      res.headers.set('X-Edge-Gen', gen);
      res.headers.set('X-Edge-Age', String(a));
      res.headers.set('Cache-Control', buildCacheControl(route));

      if (a <= route.edgeTtl) {
        res.headers.set('X-Edge-Cache', 'HIT');
        return res;
      }

      // Past the freshness window but inside the stale-while-revalidate window:
      // serve the stale copy immediately and refresh in the background. This is
      // the behaviour Cloudflare's free plan will not do from headers, and the
      // reason a request arriving at expiry does not have to wait for Oregon.
      if (route.swr && a <= route.edgeTtl + route.swr) {
        res.headers.set('X-Edge-Cache', 'STALE');
        ctx.waitUntil(fetchAndStore(request, cacheKey, route, cache, ctx, gen));
        return res;
      }
      // Too old to serve normally — but keep it as outage insurance.
      return fetchAndStore(request, cacheKey, route, cache, ctx, gen, hit.clone());
    }

    return fetchAndStore(request, cacheKey, route, cache, ctx, gen);
  },
};
