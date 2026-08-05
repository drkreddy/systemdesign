#!/usr/bin/env bash
# probe.sh — break one HTTP request into its latency components.
#
#   ./tools/probe.sh <url> [count] [curl-args...]
#
# Every column is a *phase*, not a cumulative timestamp, so the numbers add up
# to total and you can see which phase the CDN actually improved:
#
#   dns       resolving the hostname
#   tcp       TCP handshake        — 1 RTT to whoever answered
#   tls       TLS handshake        — 1-2 RTT, terminated at the CDN edge once proxied
#   ttfb      server think time    — the part a cache HIT collapses to ~0
#   xfer      streaming the body   — bandwidth-bound, not latency-bound
#
# Also pulls the headers that say who served it: cf-cache-status (HIT/MISS/
# EXPIRED/REVALIDATED/DYNAMIC/BYPASS), the colo code inside cf-ray, Age, and
# our own X-Origin-Hit counter.
set -uo pipefail

URL="${1:?usage: probe.sh <url> [count] [curl-args...]}"
COUNT="${2:-5}"
shift 2 2>/dev/null || shift 1
HDR="$(mktemp)"; trap 'rm -f "$HDR"' EXIT

printf '\n\033[1m%s\033[0m  (%s requests)\n\n' "$URL" "$COUNT"
printf '\033[2m%-3s %8s %8s %8s %9s %8s %9s  %-11s %-6s %6s %7s\033[0m\n' \
  '#' 'dns' 'tcp' 'tls' 'ttfb' 'xfer' 'TOTAL' 'cf-cache' 'colo' 'age' 'oh'
printf '\033[2m%s\033[0m\n' "$(printf '─%.0s' {1..96})"

for i in $(seq 1 "$COUNT"); do
  # -s silent, -o discard body, -D dump headers, --compressed to exercise
  # the same content negotiation a browser would.
  t=$(curl -sS -o /dev/null -D "$HDR" --compressed \
        -w '%{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total} %{http_code} %{size_download}' \
        "$URL" "$@" 2>/dev/null) || { printf '%-3s request failed\n' "$i"; continue; }

  read -r t_dns t_conn t_ssl t_start t_total code size <<<"$t"

  # Headers are case-insensitive on the wire; normalise before matching.
  cache=$(grep -i '^cf-cache-status:' "$HDR" | tail -1 | tr -d '\r' | awk '{print $2}')
  ray=$(grep   -i '^cf-ray:'          "$HDR" | tail -1 | tr -d '\r' | awk '{print $2}')
  age=$(grep   -i '^age:'             "$HDR" | tail -1 | tr -d '\r' | awk '{print $2}')
  oh=$(grep    -i '^x-origin-hit:'    "$HDR" | tail -1 | tr -d '\r' | awk '{print $2}')
  colo="${ray##*-}"

  # awk does the float maths and converts the cumulative timestamps curl
  # reports into per-phase durations. time_appconnect is 0 on plain HTTP.
  awk -v i="$i" -v dns="$t_dns" -v conn="$t_conn" -v ssl="$t_ssl" \
      -v start="$t_start" -v tot="$t_total" -v code="$code" -v sz="$size" \
      -v cache="${cache:--}" -v colo="${colo:--}" -v age="${age:--}" -v oh="${oh:--}" '
    BEGIN {
      tcp = conn - dns;
      tls = (ssl > 0) ? ssl - conn : 0;
      base = (ssl > 0) ? ssl : conn;
      ttfb = start - base;
      xfer = tot - start;
      hot = (cache == "HIT" || cache == "REVALIDATED") ? "\033[32m" : \
            (cache == "MISS" || cache == "EXPIRED")    ? "\033[33m" : "\033[0m";
      printf "%-3s %7.1fm %7.1fm %7.1fm %s%8.1fm\033[0m %7.1fm %8.1fm  %s%-11s\033[0m %-6s %6s %7s\n",
        i, dns*1000, tcp*1000, tls*1000, hot, ttfb*1000, xfer*1000, tot*1000, hot, cache, colo, age, oh;
    }'
done

printf '\n\033[2mcf-cache: HIT=served from edge  MISS=fetched from origin  EXPIRED=stale, revalidated\n'
printf 'DYNAMIC=not eligible for caching  BYPASS=a rule said do not cache\n'
printf 'oh = X-Origin-Hit, our origin-side counter. Frozen oh across requests = real cache hits.\033[0m\n\n'
