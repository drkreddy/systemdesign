import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';

const PORT = process.env.PORT || 8080;
// Render does not expose its region as an env var, so ORIGIN_REGION is set
// explicitly in render.yaml. Keeps the label honest wherever this is deployed.
const REGION = process.env.ORIGIN_REGION || process.env.FLY_REGION || 'local';
const INSTANCE = (process.env.RENDER_INSTANCE_ID || process.env.FLY_MACHINE_ID || os.hostname()).slice(0, 8);

// ---------------------------------------------------------------------------
// Instrumentation.
//
// The whole point of this server is to answer one question from the origin's
// side: "did that request actually reach me, or did the CDN serve it?"
// A cache HIT at the edge is invisible here — the counter simply does not move.
// That silence is the measurement.
// ---------------------------------------------------------------------------
const hits = new Map();            // path -> total requests that reached origin
let inflight = 0;                  // requests being served right now
let maxInflight = 0;               // high-water mark — the thundering-herd signal
const recent = [];                 // ring buffer of the last 500 requests
const BOOTED_AT = Date.now();

function record(path) {
  hits.set(path, (hits.get(path) || 0) + 1);
  recent.push({ t: Date.now(), path });
  if (recent.length > 500) recent.shift();
  return hits.get(path);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : dflt;
};

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    'Content-Length': payload.length,
    // Stamped on every response so you can prove which machine served it and
    // how many times the origin has been touched. Survives the trip through
    // Cloudflare, so a stale X-Origin-Hit in a cached response tells you
    // exactly how old the cached copy is.
    'X-Origin-Region': REGION,
    'X-Origin-Instance': INSTANCE,
    'X-Origin-Served-At': new Date().toISOString(),
    'X-Origin-Inflight': String(inflight),
    ...headers,
  });
  res.end(payload);
}

const json = (res, status, obj, headers = {}) =>
  send(res, status, JSON.stringify(obj, null, 2), {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });

// Builds a Cache-Control header from query params so you can reshape caching
// behaviour from the command line without redeploying.
function cacheControl(q) {
  if (q.get('cc')) return q.get('cc');            // full manual override
  const parts = [];
  parts.push(q.get('private') !== null ? 'private' : 'public');
  parts.push(`max-age=${clamp(q.get('maxage'), 0, 31536000, 60)}`);
  if (q.has('smaxage')) parts.push(`s-maxage=${clamp(q.get('smaxage'), 0, 31536000, 60)}`);
  if (q.has('swr')) parts.push(`stale-while-revalidate=${clamp(q.get('swr'), 0, 86400, 30)}`);
  if (q.has('sie')) parts.push(`stale-if-error=${clamp(q.get('sie'), 0, 86400, 30)}`);
  if (q.has('immutable')) parts.push('immutable');
  if (q.has('nostore')) return 'no-store';
  if (q.has('novalidate')) parts.push('must-revalidate');
  return parts.join(', ');
}

const server = http.createServer(async (req, res) => {
  inflight++;
  maxInflight = Math.max(maxInflight, inflight);

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  const q = url.searchParams;

  // Logged so `fly logs` becomes a live view of origin traffic. During the
  // thundering-herd module you watch this scroll.
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.url} ` +
    `inflight=${inflight} colo=${req.headers['cf-ray']?.split('-')[1] || '-'}`
  );

  try {
    await route(req, res, { url, path, q });
  } catch (err) {
    console.error('handler error', err);
    if (!res.headersSent) json(res, 500, { error: String(err) });
  } finally {
    inflight--;
  }
});

async function route(req, res, { path, q }) {
  // -- observability -------------------------------------------------------
  // Deliberately never counted, so polling /stats does not pollute the numbers
  // it is reporting.
  if (path === '/stats') {
    const now = Date.now();
    return json(res, 200, {
      region: REGION,
      instance: INSTANCE,
      uptime_s: Math.round((now - BOOTED_AT) / 1000),
      inflight,
      max_inflight: maxInflight,
      total_hits: [...hits.values()].reduce((a, b) => a + b, 0),
      hits_by_path: Object.fromEntries([...hits.entries()].sort((a, b) => b[1] - a[1])),
      last_10s: recent.filter((r) => now - r.t < 10_000).length,
      last_60s: recent.filter((r) => now - r.t < 60_000).length,
    }, { 'Cache-Control': 'no-store' });
  }

  if (path === '/stats/reset') {
    hits.clear();
    recent.length = 0;
    maxInflight = 0;
    return json(res, 200, { ok: true, reset_at: new Date().toISOString() },
      { 'Cache-Control': 'no-store' });
  }

  if (path === '/health') {
    return json(res, 200, { ok: true, region: REGION }, { 'Cache-Control': 'no-store' });
  }

  // Echoes what the origin actually received. Behind Cloudflare this is how you
  // see CF-Connecting-IP, CF-IPCountry, CF-Ray and the rewritten Accept-Encoding.
  if (path === '/whoami') {
    const n = record(path);
    return json(res, 200, {
      method: req.method,
      url: req.url,
      origin_hit: n,
      headers: req.headers,
      socket_remote: req.socket.remoteAddress,
    }, { 'Cache-Control': 'no-store', 'X-Origin-Hit': String(n) });
  }

  // -- the teaching endpoints ---------------------------------------------

  // Always dynamic. Should never be served from cache; if it ever is, your
  // cache rules are wrong and this endpoint will show a frozen timestamp.
  if (path === '/api/time') {
    const n = record(path);
    return json(res, 200, {
      now: new Date().toISOString(),
      epoch_ms: Date.now(),
      origin_hit: n,
      region: REGION,
    }, { 'Cache-Control': 'no-store', 'X-Origin-Hit': String(n) });
  }

  // A slow, expensive endpoint — the one worth caching, and the one that hurts
  // when a stampede lands on it. ?ms= controls the pain.
  if (path === '/api/slow') {
    const ms = clamp(q.get('ms'), 0, 20000, 2000);
    const n = record(path);
    await sleep(ms);
    return json(res, 200, {
      computed_in_ms: ms,
      finished_at: new Date().toISOString(),
      origin_hit: n,
      concurrent_at_peak: maxInflight,
      region: REGION,
    }, { 'Cache-Control': cacheControl(q), 'X-Origin-Hit': String(n) });
  }

  // Fails on demand, so edge resilience can be tested without taking the real
  // origin down. ?status= chooses the failure code; ?ms= delays it first, to
  // imitate an origin that is struggling rather than cleanly dead.
  if (path === '/api/flaky') {
    const n = record(path);
    const status = clamp(q.get('status'), 400, 599, 500);
    await sleep(clamp(q.get('ms'), 0, 20000, 0));
    return json(res, status, {
      failed_on_purpose: true, status, origin_hit: n, at: new Date().toISOString(),
    }, { 'Cache-Control': cacheControl(q), 'X-Origin-Hit': String(n) });
  }

  // The workhorse for the caching-strategy module: same body, arbitrary
  // Cache-Control assembled from the query string.
  //   /cache?maxage=0&smaxage=300&swr=60
  if (path === '/cache') {
    const n = record(path);
    return json(res, 200, {
      generated_at: new Date().toISOString(),
      origin_hit: n,
      cache_control_sent: cacheControl(q),
      region: REGION,
    }, { 'Cache-Control': cacheControl(q), 'X-Origin-Hit': String(n) });
  }

  // Conditional requests. The body only changes when ?v= changes, so the ETag
  // is stable and revalidation returns a 304 with no body — the cheap refresh.
  if (path === '/etag') {
    const n = record(path);
    const version = q.get('v') || '1';
    // The ETag must be derived from the *content* only. Hashing the whole
    // response body would fold in origin_hit, which changes every request, so
    // the ETag would never repeat and revalidation could never return 304.
    const etag = `"${crypto.createHash('sha256').update(`v=${version}`).digest('hex').slice(0, 16)}"`;
    const body = JSON.stringify({ version, origin_hit: n, region: REGION }, null, 2);

    if (req.headers['if-none-match'] === etag) {
      return send(res, 304, '', { ETag: etag, 'Cache-Control': cacheControl(q), 'X-Origin-Hit': String(n) });
    }
    return send(res, 200, body, {
      'Content-Type': 'application/json; charset=utf-8',
      ETag: etag,
      'Cache-Control': cacheControl(q),
      'X-Origin-Hit': String(n),
    });
  }

  // Per the HTTP spec, Vary splits the cache into one entry per distinct header
  // value. Cloudflare does NOT implement that — it honours Vary: Accept-Encoding
  // and ignores everything else, caching a single copy and serving it to all.
  // Measured here: fr-FR, ja-JP and de-DE all received the en-US body on a HIT.
  // The response echoes back the language the origin actually saw, so the body
  // exposes the mix-up that cf-cache-status alone would hide.
  if (path === '/vary') {
    const n = record(path);
    const lang = req.headers['accept-language'] || 'none';
    return json(res, 200, { lang, origin_hit: n, region: REGION }, {
      'Cache-Control': cacheControl(q),
      Vary: q.get('vary') || 'Accept-Language',
      'X-Origin-Hit': String(n),
    });
  }

  // Cache-Tag groups objects for tag-based purge. Note: tag purge is an
  // Enterprise feature on Cloudflare — we emit the header anyway and will
  // reimplement tag purge ourselves in a Worker during the invalidation module.
  if (path === '/tagged') {
    const n = record(path);
    const tag = q.get('tag') || 'default';
    return json(res, 200, { tag, generated_at: new Date().toISOString(), origin_hit: n }, {
      'Cache-Control': cacheControl(q),
      'Cache-Tag': tag,
      'X-Origin-Hit': String(n),
    });
  }

  // Fingerprinted static asset: the filename carries the version, so it can be
  // cached forever and "invalidated" by changing the URL rather than purging.
  if (path.startsWith('/static/')) {
    const n = record('/static/*');
    const kb = clamp(q.get('kb'), 1, 5000, 64);
    const body = ('/* cdn-lab asset ' + path + ' */\n' + 'x'.repeat(1024).concat('\n')).repeat(kb);
    return send(res, 200, body, {
      'Content-Type': path.endsWith('.css') ? 'text/css' : 'application/javascript',
      'Cache-Control': q.has('cc') || q.has('maxage')
        ? cacheControl(q)
        : 'public, max-age=31536000, immutable',
      'X-Origin-Hit': String(n),
    });
  }

  // Large payload for bandwidth, compression and transfer-time experiments.
  if (path === '/bigpage') {
    const n = record(path);
    const kb = clamp(q.get('kb'), 1, 10000, 512);
    const chunk = 'The quick brown fox jumps over the lazy dog. '.repeat(23); // ~1KB
    return send(res, 200, `<!doctype html><title>bigpage</title><pre>${chunk.repeat(kb)}</pre>`, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': cacheControl(q),
      'X-Origin-Hit': String(n),
    });
  }

  if (path === '/') {
    const n = record(path);
    return send(res, 200, indexHtml(), {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Origin-Hit': String(n),
    });
  }

  record('404');
  return json(res, 404, { error: 'not found', path }, { 'Cache-Control': 'no-store' });
}

function indexHtml() {
  const rows = [
    ['/api/time', 'always dynamic, no-store'],
    ['/api/slow?ms=2000', 'slow + expensive — the stampede target'],
    ['/cache?maxage=60&smaxage=300&swr=30', 'configurable Cache-Control'],
    ['/etag?v=1', 'conditional requests / 304'],
    ['/vary', 'Vary-keyed cache entries'],
    ['/tagged?tag=home', 'Cache-Tag for tag purge'],
    ['/static/app.v1.js', 'immutable fingerprinted asset'],
    ['/bigpage?kb=512', 'large payload'],
    ['/whoami', 'echo received headers'],
    ['/stats', 'origin hit counters'],
    ['/stats/reset', 'zero the counters'],
  ].map(([p, d]) => `<tr><td><a href="${p}">${p}</a></td><td>${d}</td></tr>`).join('');

  return `<!doctype html><meta charset=utf-8><title>CDN lab origin</title>
<style>body{font:15px/1.6 system-ui;margin:2rem auto;max-width:52rem;padding:0 1rem}
td{padding:.3rem .9rem .3rem 0;border-bottom:1px solid #8883}code{background:#8882;padding:.1rem .3rem}</style>
<h1>CDN lab origin</h1>
<p>Region <code>${REGION}</code> · instance <code>${INSTANCE}</code> · up ${Math.round((Date.now() - BOOTED_AT) / 1000)}s</p>
<table>${rows}</table>`;
}

server.keepAliveTimeout = 65_000;   // must exceed the CDN's keepalive to avoid
server.headersTimeout = 70_000;     // races that surface as sporadic 502s
server.listen(PORT, () => console.log(`origin listening on :${PORT} region=${REGION}`));
