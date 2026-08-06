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

---

# Lab log — what we did and what it showed

Chronological record with real numbers. Raw JSON for every global run is in
`results/`.

## Setup decisions

| Decision | Chosen | Why |
|---|---|---|
| Origin host | Render free tier, **Oregon** | Fly.io now requires a card. Oregon is ~13,000km from India, so the propagation gap is impossible to miss. |
| Domain | `drkreddy.com` via Cloudflare free | Already owned. Free plan forces full nameserver delegation. |
| Lab hostname | `cdn-lab.drkreddy.com` | A name that served nothing before, so blast radius on the live domain is zero. |
| Proxy posture | everything grey except `cdn-lab` | The live site and email keep behaving exactly as before. |

## 2026-08-05 — DNS migration to Cloudflare

Moved nameservers `ns1/ns2.dns-parking.com` (Hostinger) → `olivia/woz.ns.cloudflare.com`.

**14 records migrated, 14/14 verified afterwards** via `./tools/verify-dns.sh`.
Apex and `www` still 301 to `drkreddy.github.io`; `server: hcdn` with no
`cf-ray` confirms grey cloud is genuinely not proxying.

What the three sources each missed:

| Source | Records found | Missed |
|---|---|---|
| `dig` from outside | 7 | 3 DKIM CNAMEs, autoconfig, autodiscover, `A ai` |
| Cloudflare auto-scan | 13 | `AAAA ai` |
| Hostinger zone editor | **14** | nothing — authoritative |

The lesson: zones cannot be enumerated externally, so never trust a scan as
complete. Diff against the registrar's own editor before switching.

## Module 1 — baseline, before our CDN

`/api/time` (sends `no-store`), 10 global probes.

| Run | Hostname | Total median | DNS median | TTFB median |
|---|---|---|---|---|
| `baseline-01-no-cloudflare` | `cdn-lab-origin.onrender.com` | **226ms** | 18ms | 189ms |
| `baseline-02-grey-cloud` | `cdn-lab.drkreddy.com` (grey) | 341ms | 96ms | 212ms |
| `baseline-02b-grey-warm-dns` | same, DNS caches warmed | 382ms | 68ms | 194ms |

**TTFB was ~85% of every total.** The entire cost is the round trip to Oregon.

The grey-cloud runs measured *worse* than the raw Render hostname. Two causes,
both real:

1. **Cold DNS caches** on a minutes-old hostname — London 900→213ms on rerun.
2. **One extra CNAME hop.** Cold full recursion: `cdn-lab-origin.onrender.com`
   ~256ms over 2 hops vs `cdn-lab.drkreddy.com` ~346ms over 3. **~90ms for one
   hop**, spent before the first request packet is sent.

A confound worth knowing: **Render is itself behind Cloudflare.** `*.onrender.com`
returns `server: cloudflare`, so this "no CDN" baseline was really *proxy without
caching*. That turned out to help — it isolates the caching benefit from the
TLS-termination benefit.

## Module 2 — turning the proxy on

Set SSL/TLS to **Full (strict)**, flipped `cdn-lab` to orange.

**DNS chain collapsed**, exactly as predicted:

    grey:    cdn-lab -> onrender.com -> gcp-us-west1-1... -> ...cdn.cloudflare.net -> 216.24.57.7
    orange:  cdn-lab -> 172.67.145.72, 104.21.55.58        (Cloudflare anycast, one lookup)

No Error 1014 — Cloudflare proxying Cloudflare works, given a Render Custom
Domain and Full (strict).

### The core experiment: two endpoints, same test

4 requests each, from India, after `/stats/reset`:

| | `/api/time` (`no-store`) | `/static/app.v1.js` (`immutable`) |
|---|---|---|
| Requests sent | 4 | 4 |
| **Reached Oregon** | **4** | **1** |
| cf-cache-status | `DYNAMIC` ×4 | `MISS`, then `HIT` ×3 |
| TTFB | 606, 302, 354, 344ms | 483ms → **76, 64, 65ms** |

**Turning on a CDN cached nothing by default.** Cloudflare's default rules only
cover static file extensions, so the JSON API stayed `DYNAMIC` — permanently,
until a Cache Rule says otherwise. The static asset cached with no configuration
at all and TTFB fell 7×.

### Cache is per-colo

`/static/app.v1.js`, 10 global probes, run twice:

| Run | Result | Total median | TTFB median | New origin hits |
|---|---|---|---|---|
| `after-01-orange-cold-colos` | 1 HIT (SIN), **9 MISS** | 429ms | 294ms | **9** |
| `after-02-orange-warm-colos` | **10 HIT** | 99ms | **12ms** | **0** |

Run 1 was mostly MISS *despite* the cache being warm — warming it from India only
populated Singapore. **Nine cities each fetched from Oregon independently.**
Cloudflare's free-tier cache is per-PoP: 300+ locations means up to 300+ misses
for one object.

Run 2: every colo HIT, **TTFB 294ms → 12ms**, and the origin counter did not move
at all. Ten worldwide requests, zero reached Oregon.

This directly previews Module 6 — one purge means every PoP misses at once, and
that is the thundering herd.

### Honest caveat on before/after

Modules 1 and 2 measured **different endpoints** (`/api/time` uncacheable vs
`/static/*` cacheable), so "226ms → 99ms" changes two variables and is not a
clean comparison. The valid one is `after-01` vs `after-02`: same URL, same
config, only cache state differs — **429ms → 99ms, TTFB 294ms → 12ms**.

Other measurement facts established:

- **TTFB = network round trip + server think time.** Proven with
  `/api/slow?ms=N`: sleeps of 0/1000/3000ms produced TTFB phases of
  0.69/1.38/3.31s. The sleep lands in TTFB one-for-one.
- **Cold starts are brutal.** A Render free instance took **22s** to wake. Warm
  the origin before any measurement.
- **Free-plan zones get a smaller colo footprint.** India → `BLR` through
  Render's paid zone, but → `SIN` through our free zone.
- **After caching, DNS becomes the bottleneck.** In run 2, TTFB was 9-38ms while
  DNS was 132ms (Mumbai), 304ms (Cape Town). Fix one bottleneck, meet the next.

## Module 3 — caching strategies

### Eligibility and duration are two separate decisions

    1. ELIGIBILITY  Cloudflare: may I cache this at all?   <- file extension, or a Cache Rule
    2. DURATION     Your Cache-Control: for how long?      <- only read if step 1 passed

**Proof.** `/cache?maxage=300` sends a textbook `public, max-age=300`. Before any
rule, 4 requests → `DYNAMIC` ×4, 4 origin hits. Cloudflare decides eligibility by
**file extension** (`.js`, `.css`, `.jpg`, …), and an extensionless path like
`/cache` or `/api/time` is ineligible — so its `Cache-Control` is never even read.

This is Cloudflare-specific. Fastly and Akamai honour `Cache-Control` for any
content type. "Does the CDN cache by default, or only what you tell it to?" is a
real architectural difference between vendors.

**The Cache Rule** (Caching → Cache Rules), scoped to the lab host only:

    http.host eq "cdn-lab.drkreddy.com" and not starts_with(http.request.uri.path, "/stats")
    -> Cache eligibility: Eligible for cache
    -> Edge TTL:    Use cache-control header if present, bypass cache if not
    -> Browser TTL: Respect origin TTL

`/stats` is excluded because it is the instrument the experiments read.

**Result:** `/cache?maxage=300` → `MISS` then `HIT HIT HIT`, TTFB 254ms → 56ms,
origin hits frozen at 1.

### DYNAMIC vs BYPASS — a two-word diagnostic

| Status | Meaning | Where to fix |
|---|---|---|
| `DYNAMIC` | not eligible; Cloudflare never considered it | the Cache Rule |
| `BYPASS` | eligible, but a header declined | the `Cache-Control` |

After the rule, `/api/time` (which sends `no-store`) moved from `DYNAMIC` to
`BYPASS` — 4 requests, 4 origin hits. **The rule grants permission, the header
exercises it**, so the application keeps per-endpoint control.

A too-narrow rule also shows up as `DYNAMIC`: `/vary` read `DYNAMIC` purely
because the first rule expression only matched `/cache` and `/api/`.

### max-age vs s-maxage

    Cache-Control: public, max-age=0, s-maxage=300

`max-age` speaks to every cache including browsers; `s-maxage` speaks only to
**shared** caches (CDNs, proxies). The pair above means *browsers always
revalidate, CDN shields the origin for 5 minutes*.

Measured: `MISS` then `HIT HIT HIT` despite `max-age=0`. The workhorse pattern
for dynamic content — users get fresh data, the database sees one request per
5 minutes per PoP instead of one per user.

### Query strings fragment the cache

Cloudflare's default cache key includes the **full query string**. Five requests
for one logical object:

    /cache?maxage=300                               HIT
    /cache?maxage=300&utm_source=twitter            MISS
    /cache?maxage=300&utm_source=facebook           MISS
    /cache?maxage=300&fbclid=abc123                 MISS
    /cache?maxage=300&utm_source=twitter&utm_medium=social  MISS
    -> 4 origin hits for ONE object

Tracking parameters are appended by platforms you do not control, so a site with
perfect headers can still run a terrible hit rate. Fixes, in order of preference:

1. normalise the cache key at the edge (Cache Rules → Cache Key → Query String;
   may be gated by plan)
2. strip the params in a Worker before cache lookup — Module 4
3. keep them out of URLs — rarely within your control

### stale-while-revalidate is NOT honoured on the free plan

    Cache-Control: s-maxage=10, stale-while-revalidate=120

    t=0   MISS      primed
    t=1   HIT       age=0, fresh
    t=14  EXPIRED   <-- client WAITED for the origin round trip
    t=15  HIT       age=0, refreshed

SWR promises: serve the stale copy instantly (`HIT`, `age=14`) and refresh in the
background so nobody waits. Cloudflare instead revalidated **synchronously** —
`EXPIRED` means the client paid the full origin latency. Serving stale is a paid
feature.

This matters for Module 6. SWR is the standard defence against cache stampedes:
when a hot object expires, one request refreshes it while everyone else gets the
stale copy. Without it, every request arriving during a refresh piles onto the
origin. We will build this by hand in a Worker.

### Commands

    # is it the rule or the header? read cf-cache-status
    curl -sSI "$U/cache?maxage=300" | grep -i cf-cache-status

    # browser vs edge TTL
    ./tools/probe.sh "$U/cache?maxage=0&smaxage=300" 4

    # query-string fragmentation
    for q in "" "&utm_source=twitter" "&fbclid=abc"; do
      curl -sSI "$U/cache?maxage=300$q" | grep -i cf-cache-status
    done

    # does this CDN serve stale? watch for HIT-with-high-age vs EXPIRED
    curl -sSI "$U/cache?maxage=0&smaxage=10&swr=120"   # prime
    sleep 13
    curl -sSI "$U/cache?maxage=0&smaxage=10&swr=120"   # EXPIRED = no SWR

### Vary is ignored — and that breaks correctness, not hit rate

Origin sent `Vary: Accept-Language` with `public, max-age=300`. One fresh URL,
four languages:

    requested en-US   MISS   body lang=en-US   correct
    requested fr-FR   HIT    body lang=en-US   *** WRONG ***
    requested ja-JP   HIT    body lang=en-US   *** WRONG ***
    requested de-DE   HIT    body lang=en-US   *** WRONG ***
    -> 1 origin hit

**Cloudflare honours `Vary: Accept-Encoding` and ignores every other `Vary`
value.** It caches one copy and serves it to everyone.

Note the failure mode is the *opposite* of the spec-compliant one. A correct
shared cache fragments per header value and the hit rate collapses. Cloudflare
keeps a great hit rate and silently serves wrong content.

**This is a security issue, not a performance one.** An app shipping

    Cache-Control: public, max-age=60
    Vary: Cookie

behind Cloudflare will serve the first user's personalised response to every
later user. That is one customer seeing another customer's data.

`cf-cache-status` cannot detect this — every wrong response was a healthy-looking
`HIT`. Only comparing the **body** against what was requested exposes it. When
testing a cache, assert on content, not on cache status.

**Never rely on `Vary` for correctness at a CDN.** Instead:

- put the variant in the URL — `/api/data?lang=fr`, `/fr/page` — so it is part
  of the cache key and cannot be confused
- put it in the cache key explicitly, via Worker logic or custom cache key config
- mark genuinely per-user content `private, no-store` and keep it away from
  shared caches entirely

### Command

    # assert on the BODY, not on cf-cache-status
    for lang in en-US fr-FR ja-JP; do
      curl -sS -H "Accept-Language: $lang" "$U/vary?maxage=300&t=$(date +%s)" | jq -r .lang
    done

### Cache key settings — what the free plan actually gives you

Cache Rules → your rule → **Cache key**.

| Setting | Free plan | Verdict for this lab |
|---|---|---|
| Cache deception armor | available | **ON** — security, see below |
| Cache by device type | available | OFF — 3× the entries, and we serve no device variants |
| Sort query string | available | **ON** — verified working |
| Ignore query string (toggle) | available | **OFF** — all-or-nothing; would collide `?maxage=300` with `?maxage=60` |
| Query string: include/exclude specific params | **Enterprise only** | unavailable — the `utm_` fix needs a Worker |

**Verified:** with Sort query string on, `?a=1&b=2&c=3`, `?c=3&b=2&a=1` and
`?b=2&a=1&c=3` produced **1 origin hit**. Parameter order no longer fragments
the cache.

**Still unfixed:** `utm_source` / `fbclid` fragmentation, because excluding
specific parameters is Enterprise. This is what the Worker in Module 4 solves.

**Cache deception armor** defends against web cache deception:

1. attacker sends the victim `https://site.com/account/settings/x.css`
2. the app ignores the junk suffix and renders the victim's real account page
3. the CDN sees `.css`, concludes "static asset", and caches it publicly
4. the attacker fetches the same URL and receives the victim's cached page

The attack rests on the same fact that made `/static/app.v1.js` cache with no
configuration: **eligibility is decided by file extension, not by response
content.** Armor checks the extension against the actual `Content-Type` first.

Note the dashboard warning: changing any cache-key setting orphans every existing
entry — a purge-everything with extra steps. On a busy site that sends all
traffic to the origin at once, which is a self-inflicted thundering herd.

---

## Module 4 — path-based routing in a Worker

`worker/src/index.js`, deployed to `cdn-lab.drkreddy.com/*` via
`worker/wrangler.toml`.

### Why code instead of dashboard rules

Three things drove this, all measured earlier in the lab:

| Need | Config on free plan | Worker |
|---|---|---|
| different policy per path | possible, one rule each | one ordered table |
| drop `utm_`/`fbclid` from the cache key | **Enterprise only** | yes |
| `stale-while-revalidate` | **not honoured** | yes |

Secondary but real: the policy lives in git, is reviewed in a PR, and rolls back
with a revert. A dashboard rule has none of that.

### The policy table

    /stats, /admin/*   never cache        it is the instrument the experiments read
    /static/*          1 year, immutable  fingerprinted URLs never need invalidating
    /api/*             edge 30s, browser 0s, SWR 120s
    everything else    edge 60s, browser 0s, SWR 120s

First match wins, so specific prefixes precede general ones.

### Deploy

    npm install -g wrangler
    wrangler login          # interactive — needs a real terminal
    cd worker && wrangler deploy
    wrangler tail           # live request log from the edge

### Two bugs worth keeping

**Double fetch.** `new Response((await fetch(request)).body, await fetch(request))`
issues *two* origin requests and consumes a body twice. It would have doubled
origin load on every non-GET.

**`cache.match()` will not return an entry that has expired per its own
`Cache-Control`.** Storing with `s-maxage=edgeTtl` therefore deletes the entry at
exactly the moment the stale-while-revalidate window opens, leaving nothing to
serve stale. SWR would silently never fire — and it would *look* like it worked,
because the symptom is a `MISS`, which reads as an ordinary cold cache.

Fix: store with `s-maxage = edgeTtl + swr` so the entry survives the whole
window, and track freshness separately via an `X-Edge-Stored-At` timestamp.

**The cache's notion of "expired" and the application's notion of "stale" must be
different, or serve-stale cannot be implemented at all.** This generalises to
Redis, Memcached and any application-level cache.

Related: only `status === 200` is stored. Caching a 500 turns a transient origin
blip into a sustained outage served from the edge.

### Observability

Every response carries edge-set headers, so behaviour is observable rather than
inferred:

    X-Edge-Route    which policy matched
    X-Edge-Cache    HIT | MISS | STALE | BYPASS | BYPASS-METHOD
    X-Edge-Age      seconds since stored

`STALE` is the one to watch — it means a user was served instantly from cache
while the refresh happened behind them.

---

### Module 4 results

Deployed with `wrangler deploy`. Route matching verified:

    /stats              route=never-cache        BYPASS
    /static/app.v1.js   route=immutable-assets   HIT
    /api/time           route=api-dynamic        MISS
    /cache?maxage=300   route=default            HIT

**Cache-key normalisation works.** The same test that produced 4 origin hits in
Module 3 — plain URL plus `utm_source`, `fbclid`, `gclid` and a two-param
combination — produced **6 requests, 1 origin hit**. The Enterprise-gated
feature, implemented in ~10 lines.

**stale-while-revalidate works.** Origin deliberately slow (2000ms), route edge
TTL 30s / SWR 120s:

    t=0   MISS    age=0    2380ms   waited for the slow origin
    t=2   HIT     age=0     171ms
    t=35  STALE   age=33    165ms   <-- served instantly despite a 2s origin
    t=38  HIT     age=3     188ms   refreshed behind the user

### The most important bug in this lab: two stacked caches

First SWR run looked perfect and was completely broken.

    browser -> [Worker caches.default] -> fetch(request) -> [Cloudflare zone cache] -> origin
                    our SWR logic                              the Module 3 Cache Rule

A Worker's `fetch()` to its own route is still served by **Cloudflare's zone
cache**. So the background "refresh from origin" read Cloudflare's cached copy
and wrote it back into our cache as though it were fresh.

Symptom, across a full SWR cycle:

    prime          origin_hit=1  generated_at=19:46:12
    stale          origin_hit=1  generated_at=19:46:12
    after refresh  origin_hit=1  generated_at=19:46:12   <-- never changed

`X-Edge-Cache` cycled `MISS → HIT → STALE → HIT`, age reset correctly, response
times were excellent. **Content could never update, forever, and every header
reported perfect health.** A stale-forever cache is worse than no cache, because
it is silent.

Only the origin-side counter caught it. This is why `/stats` exists.

**Attempted fix that did NOT work:** `fetch(request, { cf: { cacheTtl: 0 } })`.
Still served from the zone cache.

**Actual fix:** address the origin by its own hostname, so our zone's cache is
not in the path at all.

    const ORIGIN_HOST = 'cdn-lab-origin.onrender.com';
    function toOrigin(request) {
      const u = new URL(request.url);
      u.hostname = ORIGIN_HOST;
      return new Request(u.toString(), request);
    }

Routed through a single helper so no code path can accidentally re-enter the
zone cache. Verified after the fix:

    prime          origin_hit=1  generated_at=19:51:43
    stale (age=65) origin_hit=1  generated_at=19:51:43   old copy, served instantly
    after refresh  origin_hit=2  generated_at=19:52:49   NEW data from Oregon

**Generalisable lesson:** when you add a cache in front of something that is
already cached, revalidation silently reads the inner cache. Applies to a Worker
over a CDN, an app cache over a read replica, or Redis over a query cache the
database keeps. Always verify freshness against the **system of record**, never
against the layer beneath you.

### Cost of a hedge that did not pay

`cf: { cacheTtl: 0 }` was left in place alongside the hostname fix. It does not
work on its own but is harmless, and documents the attempt.

---

## Module 5 — invalidation

Three ways to stop serving stale content, with very different costs:

| Strategy | Time to take effect | Origin cost | Complexity |
|---|---|---|---|
| TTL expiry | up to the TTL | one refetch per PoP | zero |
| Active purge | seconds, global | **stampede** — every PoP misses at once | API + tracking |
| Versioned URLs | instant | zero — a new URL is just a new object | needs a build step |

### Versioned URLs — invalidation by never needing it

`/static/*` is `max-age=31536000, immutable`. Requesting v1, v1, v2, v2, v3 gave
`HIT HIT MISS HIT MISS` — **2 origin hits for 2 new versions**, then never again.

This is why bundlers emit `app.a3f9b2c.js`: the content hash *is* the cache key.
Ship new code, reference a new URL, and the old object ages out unused. No purge,
no propagation delay, no stampede. For static assets this strictly dominates.

Limit: it only works for content referenced *indirectly*, via HTML that itself
has a short TTL. `/api/products` cannot be versioned — users request it directly.

### Purge-by-URL does not work with custom cache keys

Measured on a **1-year TTL** object, so nothing but a purge could evict it:

    purge by URL      -> still HIT   did NOT evict
    purge everything  -> MISS        did evict

The Worker builds a synthetic cache key (tracking params stripped, rest sorted).
Cloudflare's purge-by-URL targets the standard key derived from the original
request, so even an identical-looking URL does not reach the entry.

**The tradeoff nobody mentions when you write the Worker:**

| | Granular purge | Cache-key control |
|---|---|---|
| Default Cloudflare caching | works | query strings fragment |
| Worker with custom keys | **only purge_everything** | normalisation, SWR |

`purge_everything` drops every object in every PoP at once — a deliberate
zone-wide stampede, and the wrong tool for invalidating one object.

### Generational invalidation (Worker + KV)

Invalidate by bumping a counter instead of deleting anything. The generation is
part of the cache key, so a bump makes every entry for that tag unreachable at
once; orphans are never read again and fall out on their own TTL.

    KV: gen:<tag> -> integer
    cache key: <normalised url>&__g=<gen>
    POST /__purge?tag=assets   (authenticated) -> gen+1

Routes carry tags: `assets`, `api`, `page`.

**The purge endpoint is authenticated.** An open one is a denial-of-service
vector — anyone could orphan the cache in a loop and drive all traffic to origin.
Secret set via `wrangler secret put PURGE_TOKEN`, checked against
`X-Purge-Token`. Verified: no token and wrong token both return 401.

**KV is read once per isolate per 5s, not per request.** A KV read on the hot
path would add latency and partly defeat caching. Cost: a warm isolate can take
up to 5s to notice a purge, on top of KV's own propagation.

### Measured: purge propagation and its cost

Primed all 10 cities, confirmed warm, bumped the generation, measured repeatedly.

| Run | Result | Median total |
|---|---|---|
| `m5-warm` (before purge) | mostly HIT | **132ms** |
| `m5-purge-t0` (immediately after) | 5 HIT, 3 MISS — not yet propagated | 164ms |
| `m5-purge-t60` (t+60s) | 7 MISS, 1 HIT — propagated | **549ms** |

**Propagation takes roughly 30-60s** globally, dominated by KV eventual
consistency plus the 5s isolate memo. Not instant, and worth knowing before
relying on purge for anything correctness-critical.

**One purge of one object made the site 4x slower worldwide.** Every PoP lost its
copy at the same moment and re-fetched from Oregon independently. That is the
thundering herd, and Module 6 makes it far worse on purpose before fixing it.

### Commands

    ./tools/purge.sh url <url>    # granular — does NOT work with Worker cache keys
    ./tools/purge.sh all          # works, but stampedes the whole zone

    # generational purge (the one that actually works here)
    curl -H "X-Purge-Token: $PURGE_TOKEN" \
      "https://cdn-lab.drkreddy.com/__purge?tag=assets"

    # watch propagation
    ./tools/globe.sh http <url> before
    # ...purge...
    ./tools/globe.sh http <url> after

---

## Module 6 — the thundering herd

### Cloudflare already coalesces, per colo

60 requests fired simultaneously at one cold, slow (3000ms) URL:

    edge:   60 x MISS
    origin: 2 requests, max_inflight 2

Cloudflare recognises identical in-flight subrequests and collapses them. This
protection is free and automatic, and contradicts the usual "N misses means N
origin requests" framing. It is **per colo**, so it does nothing about ten cities
missing at once — measured separately in Module 5 as nine independent fetches.

### Coalescing protects the origin; SWR protects the user

Same 40-request burst, same URL, only the arrival time differs:

| Load arrives | Cache status | Wall time | Origin hits |
|---|---|---|---|
| inside the stale window | 40 x `STALE` | **0s** | 2 |
| past the stale window | 39 x `MISS` | **3s** | 2 |

**Identical origin cost, completely different user experience.** Coalescing stops
60 requests becoming 60 database queries. It does nothing to stop all 60 waiting
for the one query that does run. Only serving stale does that — and only because
we built it, since the free plan does not honour `stale-while-revalidate`.

### Serving stale when the origin is down

Added to the Worker: a copy kept past its stale window purely as outage
insurance, served if the origin throws or returns 5xx. Caching the 5xx instead
would spread the outage. Also added +/-15% jitter to stored lifetimes, so objects
cached during a spike do not all expire together and recreate that spike.

`/api/toggle` on the origin flips a failure flag, because a URL that *always*
fails cannot reproduce the case that matters: content that was healthy, got
cached, and only then started failing.

Measured:

| Situation | Visitor sees |
|---|---|
| origin broken, nothing cached | **500** — correct, there is nothing to serve |
| origin broken, copy cached | **200 with old content** — site stayed up |

### UNVERIFIED: the mechanism behind that second row

The outcome is right but **it is not this code that produced it**. The response
carried `X-Edge-Cache: MISS`, meaning the Worker believed the origin returned
200 — so the `stale-if-error` branch never executed. Reproduced three times,
including with a route deliberately shortened to a 5s/5s window.

Something between the Worker and the Node process served a stale 200 while the
origin returned 500 to direct requests. Render's own Cloudflare was checked and
reported `DYNAMIC`, so it is not a confirmed explanation.

**The stale-if-error code is deployed and untested.** Do not trust it without
verifying it against an origin whose stack is fully under your control.

This is the Module 4 lesson one layer deeper: **you cannot verify your own cache
logic while an uncontrolled cache sits beneath it.** Addressing the origin
hostname directly removed *our* zone's cache from the path, but that hostname is
itself behind infrastructure we do not control.

### What actually defends an origin

| Defence | Available here | Protects |
|---|---|---|
| per-colo coalescing | free, automatic | origin |
| stale-while-revalidate | built in the Worker | **user** |
| stale-if-error | written, unverified | user, during an outage |
| TTL jitter | built in the Worker | origin, against synchronised expiry |
| versioned URLs | free | avoids invalidation entirely |
| tiered cache / origin shield | **paid only** | origin, across colos |

The cross-colo gap is real and unfixable on this plan: one purge still means one
origin fetch per city. Tiered caching is the paid answer; the free mitigations
are long stale windows and never purging when a version bump would do.

### Commands

    # stampede one colo
    seq 60 | xargs -P 60 -I{} curl -sS -o /dev/null -D- "$URL" \
      | grep -i x-edge-cache | awk '{print $2}' | sort | uniq -c

    # break / heal the origin
    curl "$ORIGIN/api/toggle?status=500"
    curl "$ORIGIN/api/toggle?clear=1"

    # note: macOS has no `timeout`; `wrangler tail` needs gtimeout or a manual stop

---

## play.drkreddy.com — public experiment surface

Hardened Worker at `play-worker/`, serving the blog's live widgets. Structure:
`src/core.js` owns everything security-related; `src/labs/*.js` are data.

    play.drkreddy.com/<lab>/<experiment>?<capped params>&v=<visitor id>

One hostname with paths per lab, because the free plan allows **one Rate Limiting
Rule** — a single host means one rule covers every lab ever added.

### Why the schema is validated at load

`defineLab()` throws unless every int parameter declares `min` and `max`. An
uncapped parameter reaching a 0.1-CPU origin is the failure being prevented, so
it must fail at deploy rather than at 3am. Verified rejected:

    param missing max / missing min / max < min
    unsupported param type
    enum with no values
    origin that is an absolute URL   <- also closes an SSRF path
    missing ttl / swr

### Verified in production, before anything public existed

| Check | Result |
|---|---|
| unregistered lab, experiment, or extra path segment | 404 |
| `/api/toggle`, `/stats/reset`, `/bigpage` | 404 — no route exists |
| `ms=999999` | clamped to 1500; origin confirms it computed 1500 |
| `ms=-99` | clamped to 0 |
| `utm_source=<script>` | rejected, falls back to default |
| CORS | exposes `x-play-cache`, `cf-cache-status`, `x-origin-hit`, … |
| two visitors, same experiment | independent MISS→HIT; neither disturbs the other |
| `ms=99999` vs `ms=1500` | same cache entry — varying past the cap cannot multiply entries |
| **100 concurrent, 100 distinct visitors** | 100 × 200 in 3s; **2 origin hits**; `max_inflight` 2 |
| kill switch on | 503 + `x-play-live: off`, **0 origin hits** |

**Sandboxing is free at the origin.** The visitor id is part of the cache key but
not the origin URL, so 100 readers get 100 independent MISS→HIT sequences while
the origin sees one shared request that Cloudflare coalesces.

### Kill switch

    wrangler kv key put --binding PLAY_META play:enabled off --remote   # disable
    wrangler kv key put --binding PLAY_META play:enabled on  --remote   # restore

Takes up to ~60s to propagate in either direction — measured 40s to restore. KV
is read once per isolate per 10s, never written per request, because the free
tier allows only 1,000 writes/day.

### Origin hardening that came with this

The origin hostname is published in a public repository, so `/api/toggle` and
`/stats/reset` were reachable by anyone — a stranger could break every reader's
experiment without touching `play`. Both now require `X-Play-Secret` and **fail
closed**: an unset `ORIGIN_SECRET` disables them rather than leaving them open.

Caps also dropped from private-lab values to public-safe ones:

    /api/slow   ms   20000 -> 3000
    /bigpage    kb   10000 -> 512
    /static     kb    5000 -> 256

`play` clamps far lower still; these are the second layer.

### Cold starts

The cron trigger (`*/10 * * * *`) pings `/health`, replacing `tools/keepalive.sh`
which only ran while a terminal was open. `/health` is excluded from `/stats`, so
it cannot pollute the counters the experiments read.

### Gotchas

- Worker routes need a DNS record even though nothing routes there. Use
  `AAAA <name> 100::` **proxied** — the discard address.
- Cron registration needs a `workers.dev` subdomain to exist on the account.
  Opening Workers & Pages once creates it.
- macOS caches negative DNS answers, so `curl` can fail on a new hostname while
  `dig` succeeds. Work around it with
  `curl --resolve host:443:$(dig +short host @1.1.1.1 | head -1)`.
- The Bash tool runs zsh, which does **not** word-split unquoted variables —
  `$CURL_OPTS` arrives as one argument. Inline the flags instead.

---

<!-- KEEP THIS LAST. New module notes go ABOVE this marker. -->

## Status

- [x] Module 0 — instrumented origin + measurement toolkit
- [x] Module 1 — baseline latency, no CDN
- [x] Module 2 — Cloudflare in front, proxy mechanics
- [x] Module 3 — caching strategies: eligibility, TTLs, cache keys, Vary
- [x] Module 4 — path-based routing in a Worker (deployed; SWR + key normalisation verified)
- [x] Module 5 — invalidation: versioned URLs, purge limits, generational keys
- [x] Module 6 — thundering herd (stale-if-error written but UNVERIFIED — see notes)
