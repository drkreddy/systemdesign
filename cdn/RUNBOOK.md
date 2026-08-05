# CDN lab runbook

Every command used in this course, what it checks, and why. Copy-pasteable.

Two hostnames are in play throughout:

- `cdn-lab-origin.onrender.com` — the origin directly (Render, Oregon)
- `cdn-lab.drkreddy.com` — the same origin through your Cloudflare zone

---

## The one idea behind every measurement

**The origin counts every request that reaches it.** Ask for `/stats` and you
see how many requests actually crossed the planet. A cache hit at the edge is
invisible to the origin, so a counter that does not move is proof the CDN served
the request.

This matters because latency alone cannot prove a cache hit — a fast response
might just be a warm TCP connection. Two independent signals are needed:

| Signal | Where from | What it is |
|---|---|---|
| `cf-cache-status` | Cloudflare response header | Cloudflare's **claim** |
| `X-Origin-Hit` / `/stats` | your own origin | your **verification** |

When they disagree, believe the origin.

---

## Reading cf-cache-status

| Value | Meaning |
|---|---|
| `HIT` | served from edge cache, origin untouched |
| `MISS` | eligible for caching, but not in cache — fetched from origin and stored |
| `EXPIRED` | was cached, TTL ran out, revalidated with origin |
| `REVALIDATED` | stale copy confirmed still valid via ETag; no body transferred |
| `DYNAMIC` | **not eligible** — Cloudflare decided not to cache this at all |
| `BYPASS` | a rule explicitly said do not cache |

`DYNAMIC` is the one that confuses people. It does not mean "cache was empty" —
it means Cloudflare never even considered caching it. By default Cloudflare only
caches a fixed list of static file extensions (`.js`, `.css`, `.jpg`, …).
An `/api/*` JSON endpoint is `DYNAMIC` forever until you write a rule.

---

## Reading probe.sh output

    #        dns      tcp      tls      ttfb     xfer     TOTAL  cf-cache  colo  age   oh

Columns are **per-phase durations**, not cumulative timestamps, so they sum to
TOTAL:

| Column | What it measures | What a CDN does to it |
|---|---|---|
| `dns` | hostname → IP | shrinks; proxying collapses CNAME chains to one lookup |
| `tcp` | TCP handshake, 1 RTT | shrinks — handshake with a nearby edge, not the origin |
| `tls` | TLS handshake, 1-2 RTT | shrinks a lot; distance is multiplied by round trips |
| `ttfb` | server think time + round trip | **collapses to ~0 on a cache HIT** |
| `xfer` | streaming the body | barely changes; bandwidth-bound, not latency-bound |
| `age` | seconds this object has sat in cache | `0` right after a MISS, climbs to the TTL |
| `oh` | `X-Origin-Hit` — origin's own counter | **frozen = genuine cache hits** |

`tcp`/`tls` shrinking helps *even uncacheable traffic*. That is why a CDN in
front of a pure API is not pointless.

Always discard sample #1: it pays cold TCP/TLS setup that later samples reuse.

---

## Module 0 — origin and toolkit

    node origin/server.js                      # run locally on :8080
    ./tools/probe.sh http://localhost:8080/api/time 3

    # deployed origin, direct
    curl -sS https://cdn-lab-origin.onrender.com/api/time | jq .
    curl -sSI https://cdn-lab-origin.onrender.com/api/time | grep -iE 'x-origin|cache-control|cf-'

    # keep the Render free tier awake for the duration of a lab session.
    # pings /health, which is excluded from /stats, so it cannot pollute counters.
    ./tools/keepalive.sh https://cdn-lab-origin.onrender.com 600

Verify an endpoint's caching headers without downloading the body:

    curl -sSD- -o /dev/null "https://cdn-lab.drkreddy.com/cache?maxage=0&smaxage=300&swr=60" \
      | grep -iE '^(cache-control|x-origin-hit)'

Conditional requests — prove a 304 costs zero body bytes:

    ET=$(curl -sSD- -o /dev/null "$URL/etag?v=7" | grep -i '^etag:' | tr -d '\r' | awk '{print $2}')
    curl -sS -o /dev/null -w 'status %{http_code}  bytes %{size_download}\n' \
      -H "If-None-Match: $ET" "$URL/etag?v=7"      # -> 304, 0 bytes

---

## Module 1 — worldwide baseline

    ./tools/globe.sh http https://cdn-lab.drkreddy.com/api/time  my-label
    ./tools/globe.sh ping cdn-lab.drkreddy.com                   my-label

Runs from ~10 real machines worldwide via the free Globalping API. Saves to
`results/<label>.json`.

Raw API, if you want to see the mechanism:

    ID=$(curl -sS -X POST https://api.globalping.io/v1/measurements \
      -H 'Content-Type: application/json' \
      -d '{"type":"ping","target":"example.com","limit":3,
           "locations":[{"country":"IN"},{"country":"DE"},{"country":"US"}]}' | jq -r .id)
    sleep 6
    curl -sS "https://api.globalping.io/v1/measurements/$ID" \
      | jq -r '.results[] | "\(.probe.city) \(.result.stats.avg)ms"'

**Caveats that cost real time to learn:**

- `globe.sh` pins **countries, not machines** — a rerun may draw a different
  probe in the same country. Compare medians over several runs, never two runs.
- A brand-new hostname is cached by no resolver anywhere. Its first measurement
  pays full recursion everywhere and looks far worse than reality. Warm it first.
- One probe reporting 2034ms of DNS while its neighbours report 5ms is noise,
  not signal.

---

## Module 2 — DNS, delegation, and turning the proxy on

Who is allowed to answer for the domain — the delegation chain, root → TLD → zone:

    dig +trace drkreddy.com

Compare what several resolvers believe (catches mid-propagation states):

    for r in 1.1.1.1 8.8.8.8 9.9.9.9; do
      printf '%-9s ' "$r"; dig +short NS drkreddy.com @$r | tr '\n' ' '; echo
    done

**Grey cloud vs orange cloud** — the whole mechanism in two commands:

    dig +short A drkreddy.com      # grey  -> 2.57.91.91      your real server
    dig +short A example.com       # orange-> 172.66.x, 104.20.x  Cloudflare's IPs

    # confirm who owns an IP
    whois 172.67.145.72 | grep -iE '^(orgname|netname):'

A proxied record answers with Cloudflare's **anycast** IPs. The same addresses
are announced from 300+ locations via BGP, so packets reach the nearest one.
That substitution is the entire trick — a CDN intercepts name resolution.

Proxying also **flattens CNAME chains**. Measured cost of one extra hop:

    dig +short cdn-lab.drkreddy.com          # count the hops before an IP
    for i in 1 2 3 4 5; do
      /usr/bin/time -p dig +trace +tries=1 cdn-lab.drkreddy.com >/dev/null
    done 2>&1 | awk '/^real/{s+=$2} END{printf "avg %.0fms\n", s/5*1000}'

    #   cdn-lab-origin.onrender.com   2 CNAME hops   ~256ms cold recursion
    #   cdn-lab.drkreddy.com (grey)   3 CNAME hops   ~346ms cold recursion
    #   cdn-lab.drkreddy.com (orange) 0 CNAME hops   single A lookup

DNS resolution happens *before* the first request packet, so this latency never
appears in server metrics or most APM tools.

**The Module 2 experiment** — same test, two endpoints, opposite results:

    curl -sS https://cdn-lab.drkreddy.com/stats/reset > /dev/null
    ./tools/probe.sh https://cdn-lab.drkreddy.com/api/time        4   # no-store
    ./tools/probe.sh https://cdn-lab.drkreddy.com/static/app.v1.js 4  # immutable
    curl -sS https://cdn-lab.drkreddy.com/stats | jq '.hits_by_path'

Result: `/api/time` → 4 requests, 4 origin hits, `DYNAMIC`, TTFB 300-600ms.
`/static/app.v1.js` → 4 requests, **1** origin hit, `MISS` then `HIT HIT HIT`,
TTFB 483ms → 65ms.

**Module 2's real lesson: putting a CDN in front of an app does almost nothing
by itself.** Routing improves, but every uncacheable request still crosses the
planet. The win comes from telling it what to cache — Module 3.

---

## DNS safety (any zone migration)

Nameserver delegation is **per-zone, not per-record**. The moment nameservers
change, any record absent from the new provider ceases to exist — it does not
fall back to the old host. A dropped DKIM CNAME does not error; mail just
quietly starts failing signature checks.

    ./tools/verify-dns.sh                    # asserts live zone matches dns-backup/

Queries the authoritative nameserver directly, so a stale resolver cache cannot
make a broken zone look healthy. Exits non-zero on mismatch.

**A zone cannot be enumerated from outside.** `ANY` is refused under RFC 8482 and
`AXFR` is denied, so `dig` only finds hostnames you already guessed. Three
sources, three blind spots:

| Source | Blind spot |
|---|---|
| `dig` from outside | only finds names you guess |
| Cloudflare's scan | a dictionary of common names — missed `AAAA ai` |
| **registrar's zone editor** | **authoritative — the only complete list** |

Always diff all three before switching nameservers.

Post-migration checks:

    dig +short MX drkreddy.com                                    # both, right priorities
    dig +short TXT drkreddy.com                                   # SPF byte-identical
    dig +short TXT _dmarc.drkreddy.com
    dig +short CNAME hostingermail-a._domainkey.drkreddy.com      # DKIM
    curl -sSI https://drkreddy.com | grep -iE '^(server|cf-ray)'  # no cf-ray = not proxied

Inbound mail (someone → you) tests MX. Outbound (you → Gmail) tests SPF/DKIM/
DMARC. Test **both** directions; they fail independently.

---

## Cloudflare SSL modes

Set under SSL/TLS → Overview. Controls the Cloudflare → origin leg only.

| Mode | Cloudflare → origin | Use |
|---|---|---|
| Off | plaintext | never |
| Flexible | plaintext | **dangerous** — padlock shown while origin leg is bare; also causes redirect loops against an HTTPS-forcing origin |
| Full | HTTPS, cert unverified | accepts a forged cert |
| **Full (strict)** | HTTPS, cert verified | **correct** whenever the origin has a valid cert |

---

## Gotchas hit in this lab

- **Render is itself behind Cloudflare.** `*.onrender.com` returns
  `server: cloudflare`, so the "no CDN" baseline was really *proxy without
  caching*. That turned out useful: it isolates the caching benefit.
- **Cloudflare proxying Cloudflare works**, despite the classic
  Error 1014 (CNAME Cross-User Banned) risk. Needs the hostname registered as a
  Custom Domain in Render, and SSL mode Full (strict).
- **Register the custom domain while the record is still grey.** Render
  validates by resolving the hostname; if Cloudflare is already proxying, it
  sees Cloudflare IPs and certificate issuance can fail.
- **Free-plan zones get a smaller colo footprint.** Requests from India served
  by `BLR` through Render's paid zone landed in `SIN` through the free zone —
  roughly 30ms of extra distance, purely from plan tier.
- **Anycast does not always reach the nearest PoP.** A Pretoria probe was served
  from Bucharest, Falkenstein from Sofia. BGP follows peering, not geography.
- **Free-tier cold starts (~30-60s)** land inside measurements and look like
  network latency. Run `keepalive.sh` before any experiment.
