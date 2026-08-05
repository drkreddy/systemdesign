# CDN lab

A hands-on CDN course. An instrumented origin in Virginia, Cloudflare in front of
it, and measurements taken from real probes around the world.

The organising idea: **the origin counts every request that reaches it.** A cache
hit at the edge is invisible to the origin, so a frozen `X-Origin-Hit` counter is
proof that the CDN served the request rather than the origin. Latency numbers can
mislead; the counter cannot.

## Layout

    origin/server.js   instrumented origin — zero dependencies, plain node:http
    render.yaml        Render blueprint, pinned to Oregon (far from India on purpose)
    tools/probe.sh     per-phase latency breakdown + cache-status reader
    tools/keepalive.sh holds the free-tier origin awake during a lab session
    dns-backup/        pre-migration snapshot of drkreddy.com — restore reference

## Modules

| # | Topic | What you measure |
|---|-------|------------------|
| 0 | Origin + measurement toolkit | DNS / TCP / TLS / TTFB / transfer, split apart |
| 1 | Baseline latency, no CDN | RTT from ~10 global probes; traceroute the path |
| 2 | Cloudflare in front | Same probes; `cf-cache-status`, `cf-ray` colo codes |
| 3 | Caching strategies | `s-maxage`, `stale-while-revalidate`, cache keys, `Vary` |
| 4 | Path-based routing | `/api/*` bypass vs `/static/*` long-cache — Rules and Worker |
| 5 | Invalidation | URL purge vs TTL vs versioned URLs; purge propagation time |
| 6 | Thundering herd | Stampede the origin post-purge, count the hits, then fix it |

## Origin endpoints

| Path | Purpose |
|------|---------|
| `/api/time` | always dynamic, `no-store` — if this ever caches, a rule is wrong |
| `/api/slow?ms=2000` | slow and expensive — the stampede target in Module 6 |
| `/cache?maxage=&smaxage=&swr=&sie=&immutable` | `Cache-Control` composed from the query string |
| `/etag?v=1` | conditional requests; bump `v` to change content |
| `/vary?vary=Accept-Language` | one cache entry per header value |
| `/tagged?tag=home` | emits `Cache-Tag` |
| `/static/app.v1.js` | fingerprinted, `max-age=31536000, immutable` |
| `/bigpage?kb=512` | large payload for compression/transfer tests |
| `/whoami` | echoes received headers — shows what Cloudflare adds |
| `/stats` | origin hit counters, in-flight, high-water mark |
| `/stats/reset` | zero the counters before an experiment |

`/stats` and `/health` are never counted, so polling them does not pollute the
numbers they report.

## Usage

    node origin/server.js                       # local, port 8080
    ./tools/probe.sh <url> [count]              # latency breakdown

Reading `probe.sh` output — the columns are per-phase durations, not cumulative
timestamps, so they sum to TOTAL:

    dns    resolving the hostname
    tcp    TCP handshake — 1 RTT to whoever answered
    tls    TLS handshake — moves to the edge once proxied
    ttfb   server think time — what a cache HIT collapses to ~0
    xfer   streaming the body — bandwidth-bound, not latency-bound
    oh     X-Origin-Hit; frozen across requests = genuine cache hits
