// Safety core for play.drkreddy.com.
//
// This is the only file in the public surface that touches security. A lab is
// data (see src/labs/*.js); the core decides what is allowed. Keeping that
// boundary sharp is the point: adding a second lab must never require editing
// the allowlist, the clamps, or the CORS policy.
//
// Pipeline, in order:
//   CORS preflight -> resolve lab/experiment -> kill switch -> clamp params
//   -> namespace cache key per visitor -> serve from cache or origin -> expose headers

const ALLOWED_ORIGINS = new Set([
  'https://blog.drkreddy.com',
  'http://localhost:8788',   // wrangler pages dev
  'http://localhost:5173',
]);

// Browser JS cannot read a response header unless it is named here. Without
// this the widgets would show a body and no cache status, which is the entire
// lesson — verified against the live edge, which exposes none of these today.
const EXPOSED = [
  'x-play-cache', 'x-play-age', 'x-play-experiment', 'x-play-live',
  'cf-cache-status', 'cf-ray', 'age', 'x-origin-hit', 'x-origin-region',
].join(', ');

const KILL_MEMO_MS = 10_000;
let killMemo = { value: null, at: 0 };

/**
 * Validates a lab definition at module load, so a malformed schema fails at
 * deploy rather than silently passing an uncapped parameter to the origin.
 * This is the mechanism that makes "a lab is data" safe.
 */
export function defineLab(name, experiments) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(`lab name must be lowercase kebab-case: ${name}`);
  }
  for (const [key, def] of Object.entries(experiments)) {
    const where = `${name}/${key}`;
    if (!/^[a-z][a-z0-9-]*$/.test(key)) throw new Error(`${where}: bad experiment name`);
    if (typeof def.origin !== 'string' || !def.origin.startsWith('/')) {
      throw new Error(`${where}: origin must be an absolute path`);
    }
    if (!Number.isFinite(def.ttl) || !Number.isFinite(def.swr)) {
      throw new Error(`${where}: must declare numeric ttl and swr`);
    }
    for (const [p, spec] of Object.entries(def.params || {})) {
      if (spec.type === 'int') {
        // The clamp is read from here, so an absent bound is an uncapped
        // parameter reaching a 0.1-CPU origin. Refuse to start.
        if (!Number.isFinite(spec.min) || !Number.isFinite(spec.max)) {
          throw new Error(`${where}: param "${p}" must declare numeric min and max`);
        }
        if (spec.max < spec.min) throw new Error(`${where}: param "${p}" has max < min`);
      } else if (spec.type === 'enum') {
        if (!Array.isArray(spec.values) || spec.values.length === 0) {
          throw new Error(`${where}: param "${p}" must declare a non-empty values array`);
        }
      } else {
        throw new Error(`${where}: param "${p}" has unsupported type "${spec.type}"`);
      }
    }
  }
  return { name, experiments };
}

export function buildRegistry(labs) {
  const map = new Map();
  for (const lab of labs) map.set(lab.name, lab);
  return map;
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'https://blog.drkreddy.com';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Expose-Headers': EXPOSED,
    'Vary': 'Origin',
  };
}

const json = (body, status, request, extra = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(request),
      ...extra,
    },
  });

/** Clamps every declared parameter. Anything not in the schema is discarded. */
function clampParams(def, url) {
  const out = {};
  const notes = [];
  for (const [p, spec] of Object.entries(def.params || {})) {
    const raw = url.searchParams.get(p);
    if (spec.type === 'int') {
      const n = Number(raw);
      if (raw === null || !Number.isFinite(n)) { out[p] = spec.default; continue; }
      const clamped = Math.min(Math.max(Math.trunc(n), spec.min), spec.max);
      // Reported back so a reader who asks for ms=999999 sees why they did not
      // get it, rather than being silently ignored.
      if (clamped !== Math.trunc(n)) notes.push({ param: p, asked: Math.trunc(n), given: clamped, limit: spec.max });
      out[p] = clamped;
    } else {
      out[p] = spec.values.includes(raw) ? raw : spec.default;
      if (raw !== null && !spec.values.includes(raw)) {
        notes.push({ param: p, asked: raw, given: out[p], allowed: spec.values });
      }
    }
  }
  return { params: out, notes };
}

/**
 * Visitor id namespaces the cache key. Two readers running the same experiment
 * simultaneously must not see each other's MISS/HIT sequence — that is a
 * correctness requirement for the lesson, not only an abuse control. Stateless,
 * so it costs no KV writes.
 */
function visitorId(url) {
  const raw = (url.searchParams.get('v') || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
  return raw || 'anon';
}

async function killed(env) {
  const now = Date.now();
  if (killMemo.value !== null && now - killMemo.at < KILL_MEMO_MS) return killMemo.value;
  let value = false;
  try {
    value = (await env.PLAY_META.get('play:enabled')) === 'off';
  } catch { value = false; }   // a KV blip must not take the site down
  killMemo = { value, at: now };
  return value;
}

export async function handle(request, env, ctx, registry) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(request),
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  if (request.method !== 'GET') {
    return json({ error: 'only GET is supported' }, 405, request);
  }

  if (url.pathname === '/' || url.pathname === '/labs') {
    return json({
      labs: [...registry.values()].map((l) => ({
        lab: l.name,
        experiments: Object.entries(l.experiments).map(([k, d]) => ({
          experiment: k,
          path: `/${l.name}/${k}`,
          ttl: d.ttl, swr: d.swr,
          params: Object.fromEntries(Object.entries(d.params || {}).map(
            ([p, s]) => [p, s.type === 'int' ? { min: s.min, max: s.max, default: s.default }
                                             : { values: s.values, default: s.default }])),
        })),
      })),
    }, 200, request);
  }

  // Allowlist: only registered lab/experiment pairs resolve. Nothing here can
  // express "forward an arbitrary path", which is what keeps /api/toggle and
  // /stats/reset unreachable from the public internet.
  const [, labName, experimentName, ...rest] = url.pathname.split('/');
  const lab = registry.get(labName);
  if (!lab) return json({ error: 'unknown lab', lab: labName }, 404, request);
  const def = lab.experiments[experimentName];
  if (!def || rest.length) {
    return json({ error: 'unknown experiment', lab: labName, experiment: experimentName }, 404, request);
  }

  const { params, notes } = clampParams(def, url);

  if (await killed(env)) {
    return json({
      live: false,
      reason: 'live experiments are temporarily disabled; the page should show recorded data',
    }, 503, request, { 'X-Play-Live': 'off' });
  }

  return serve(request, env, ctx, { lab, experimentName, def, params, notes, url });
}

/** Cache-then-origin, with the experiment's own TTL and stale window. */
async function serve(request, env, ctx, { lab, experimentName, def, params, notes, url }) {
  const cache = caches.default;
  const v = visitorId(url);

  // Key is built from clamped values only, so two readers asking for the same
  // capped experiment share nothing across visitor ids and everything within one.
  const keyUrl = new URL(`https://play.invalid/${lab.name}/${experimentName}`);
  for (const [k, val] of Object.entries(params).sort()) keyUrl.searchParams.set(k, String(val));
  keyUrl.searchParams.set('v', v);
  const cacheKey = new Request(keyUrl.toString(), { method: 'GET' });

  const meta = (extra) => ({
    ...corsHeaders(request),
    'X-Play-Experiment': `${lab.name}/${experimentName}`,
    'X-Play-Live': 'on',
    'Cache-Control': 'no-store',
    ...extra,
  });

  const hit = await cache.match(cacheKey);
  if (hit) {
    const storedAt = Number(hit.headers.get('X-Play-Stored-At') || 0);
    const age = Math.floor((Date.now() - storedAt) / 1000);
    if (age <= def.ttl) {
      return decorate(hit, meta({ 'X-Play-Cache': 'HIT', 'X-Play-Age': String(age) }), notes);
    }
    if (age <= def.ttl + def.swr) {
      ctx.waitUntil(fetchAndStore(env, def, params, cacheKey, cache, ctx));
      return decorate(hit, meta({ 'X-Play-Cache': 'STALE', 'X-Play-Age': String(age) }), notes);
    }
  }

  const fresh = await fetchAndStore(env, def, params, cacheKey, cache, ctx);
  return decorate(fresh, meta({ 'X-Play-Cache': 'MISS', 'X-Play-Age': '0' }), notes);
}

async function fetchAndStore(env, def, params, cacheKey, cache, ctx) {
  const origin = new URL(def.origin, env.ORIGIN_BASE);
  for (const [k, val] of Object.entries(params)) origin.searchParams.set(k, String(val));

  const res = await fetch(origin.toString(), {
    // The origin is reached directly rather than through the private lab
    // worker: chaining two caching layers is what silently froze content in
    // Module 4, where revalidation read the inner cache instead of the origin.
    cf: { cacheTtl: 0, cacheEverything: false },
    headers: { 'X-Play-Secret': env.ORIGIN_SECRET || '' },
  });

  const body = await res.arrayBuffer();
  const store = new Response(body, {
    status: res.status,
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'application/json',
      'X-Origin-Hit': res.headers.get('X-Origin-Hit') || '',
      'X-Origin-Region': res.headers.get('X-Origin-Region') || '',
      'X-Play-Stored-At': String(Date.now()),
      'Cache-Control': `public, s-maxage=${def.ttl + def.swr + 60}`,
    },
  });
  if (res.status === 200) ctx.waitUntil(cache.put(cacheKey, store.clone()));
  return store;
}

function decorate(res, headers, notes) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  if (notes.length) out.headers.set('X-Play-Clamped', JSON.stringify(notes));
  out.headers.delete('X-Play-Stored-At');
  return out;
}
