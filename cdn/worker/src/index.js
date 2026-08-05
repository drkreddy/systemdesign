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
    test: (p) => p.startsWith('/static/'),
    // Fingerprinted filenames: the URL changes when the content does, so the
    // object never needs invalidating and can be cached effectively forever.
    cache: true,
    edgeTtl: 31536000,
    browserTtl: 31536000,
    immutable: true,
  },
  {
    name: 'api-dynamic',
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
    test: () => true,
    cache: true,
    edgeTtl: 60,
    browserTtl: 0,
    swr: 120,
  },
];

const pickRoute = (pathname) => ROUTES.find((r) => r.test(pathname));

// The cache key is a synthetic GET Request. Building it explicitly — rather than
// letting Cloudflare derive one from the incoming request — is what makes
// normalisation possible.
function cacheKeyFor(request, url) {
  const key = new URL(url.toString());
  const kept = [...key.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.some((re) => re.test(k)))
    .sort(([a], [b]) => a.localeCompare(b));   // ?b=2&a=1 must equal ?a=1&b=2
  key.search = new URLSearchParams(kept).toString();
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

const age = (res) => {
  const stored = res.headers.get('X-Edge-Stored-At');
  return stored ? Math.floor((Date.now() - Number(stored)) / 1000) : 0;
};

// Fetch from origin and store. Returns the response to serve.
async function fetchAndStore(request, cacheKey, route, cache, ctx) {
  const originRes = await fetch(request);

  // Only successful, complete responses are worth storing. Caching a 500 turns
  // a transient origin blip into a sustained outage served from the edge, and a
  // 206 would cache a fragment as if it were the whole body.
  const storable = route.cache && originRes.status === 200;

  const res = new Response(originRes.body, originRes);
  res.headers.set('X-Edge-Route', route.name);
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
  const toStore = res.clone();
  toStore.headers.set('X-Edge-Stored-At', String(Date.now()));
  toStore.headers.set('Cache-Control', `public, s-maxage=${route.edgeTtl + (route.swr || 0)}`);
  ctx.waitUntil(cache.put(cacheKey, toStore));

  res.headers.set('X-Edge-Cache', 'MISS');
  res.headers.set('X-Edge-Age', '0');
  return res;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const route = pickRoute(url.pathname);

    // Anything not idempotent must reach the origin untouched.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const originRes = await fetch(request);
      const res = new Response(originRes.body, originRes);
      res.headers.set('X-Edge-Cache', 'BYPASS-METHOD');
      return res;
    }

    if (!route.cache) {
      const originRes = await fetch(request);
      const res = new Response(originRes.body, originRes);
      res.headers.set('X-Edge-Route', route.name);
      res.headers.set('X-Edge-Cache', 'BYPASS');
      res.headers.set('Cache-Control', 'no-store');
      return res;
    }

    const cache = caches.default;
    const cacheKey = cacheKeyFor(request, url);
    const hit = await cache.match(cacheKey);

    if (hit) {
      const a = age(hit);
      const res = new Response(hit.body, hit);
      res.headers.set('X-Edge-Route', route.name);
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
        ctx.waitUntil(fetchAndStore(request, cacheKey, route, cache, ctx));
        return res;
      }
      // Too stale to serve — fall through and fetch synchronously.
    }

    return fetchAndStore(request, cacheKey, route, cache, ctx);
  },
};
