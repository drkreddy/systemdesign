#!/usr/bin/env bash
# globe.sh — measure a URL from real machines around the world.
#
#   ./tools/globe.sh http  <url> [label]    full HTTP timing breakdown per probe
#   ./tools/globe.sh ping  <host> [label]   ICMP RTT per probe
#
# Uses the Globalping API (free, no auth, rate-limited). Each probe is a real
# machine in that city, so these are genuine network measurements, not estimates.
#
# The probe list is DELIBERATELY FIXED. A before/after comparison is only valid
# if both runs are taken from the same places — swap the locations between runs
# and you are measuring the probe list, not the CDN. Results are written to
# results/<label>.json so the "before" snapshot survives for later diffing.
set -uo pipefail

MODE="${1:?usage: globe.sh <http|ping> <target> [label]}"
TARGET="${2:?usage: globe.sh <http|ping> <target> [label]}"
LABEL="${3:-$MODE-$(date +%H%M%S)}"
API=https://api.globalping.io/v1/measurements
OUTDIR="$(dirname "$0")/../results"; mkdir -p "$OUTDIR"

# Ten locations spread across the globe, weighted toward Asia because that is
# where you are and where the origin is furthest away.
LOCATIONS='[{"country":"IN"},{"country":"SG"},{"country":"JP"},{"country":"AU"},
            {"country":"DE"},{"country":"GB"},{"country":"US","state":"CA"},
            {"country":"US","state":"NY"},{"country":"BR"},{"country":"ZA"}]'

if [ "$MODE" = http ]; then
  # Split the URL into host and path — the API wants them separately.
  proto=$(printf '%s' "$TARGET" | sed -n 's|^\(https\?\)://.*|\1|p'); proto=${proto:-https}
  rest=${TARGET#*://}; host=${rest%%/*}; path="/${rest#*/}"
  [ "$rest" = "$host" ] && path="/"
  body=$(jq -nc --arg h "$host" --arg p "$path" --arg pr "$(echo "$proto" | tr a-z A-Z)" \
    --argjson loc "$LOCATIONS" '{
      type:"http", target:$h, limit:10, locations:$loc,
      measurementOptions:{ protocol:$pr, request:{ path:$p, method:"GET" } } }')
else
  body=$(jq -nc --arg t "$TARGET" --argjson loc "$LOCATIONS" \
    '{type:"ping", target:$t, limit:10, locations:$loc, measurementOptions:{packets:6}}')
fi

id=$(curl -sS -X POST "$API" -H 'Content-Type: application/json' -d "$body" | jq -r '.id // empty')
[ -z "$id" ] && { echo "measurement failed to start"; exit 1; }

printf '\n\033[1m%s %s\033[0m  label=%s\n' "$MODE" "$TARGET" "$LABEL"
printf '\033[2mmeasurement %s — waiting for probes\033[0m\n\n' "$id"

# Poll until every probe reports. Measurements are async; results stream in.
for _ in $(seq 1 30); do
  sleep 2
  raw=$(curl -sS "$API/$id")
  [ "$(printf '%s' "$raw" | jq -r '.status')" = finished ] && break
done
printf '%s' "$raw" > "$OUTDIR/$LABEL.json"

if [ "$MODE" = http ]; then
  printf '\033[2m%-22s %8s %8s %8s %9s %9s  %-11s %-6s\033[0m\n' \
    'probe' 'dns' 'tcp' 'tls' 'ttfb' 'TOTAL' 'cf-cache' 'colo'
  printf '\033[2m%s\033[0m\n' "$(printf '─%.0s' {1..86})"
  printf '%s' "$raw" | jq -r '
    .results[]? |
    ( .result.rawHeaders // "" ) as $h |
    [ (.probe.city + ", " + .probe.country),
      (.result.timings.dns // 0), (.result.timings.tcp // 0), (.result.timings.tls // 0),
      (.result.timings.firstByte // 0), (.result.timings.total // 0),
      ( $h | capture("(?i)x-edge-cache: *(?<v>[A-Za-z-]+)").v?
             // ( $h | capture("(?i)cf-cache-status: *(?<v>[A-Za-z]+)").v? ) // "-" ),
      ( $h | capture("(?i)cf-ray: *[a-f0-9]+-(?<v>[A-Z]{3})").v? // "-" )
    ] | @tsv' \
  | sort -t$'\t' -k6 -n \
  | awk -F'\t' '{
      hot = ($7=="HIT") ? "\033[32m" : ($7=="STALE") ? "\033[36m" : ($7=="MISS"||$7=="EXPIRED") ? "\033[33m" : "\033[0m";
      printf "%-22s %7dm %7dm %7dm %s%8dm %8dm\033[0m  %s%-11s\033[0m %-6s\n",
        substr($1,1,22), $2, $3, $4, hot, $5, $6, hot, $7, $8 }'

  printf '%s' "$raw" | jq -r '[.results[]?.result.timings.total // empty] | select(length>0) |
    "\n[1mtotal: min \(min)ms   median \(sort[length/2|floor])ms   max \(max)ms[0m"'
else
  printf '\033[2m%-22s %9s %9s %9s %7s\033[0m\n' 'probe' 'min' 'avg' 'max' 'loss'
  printf '\033[2m%s\033[0m\n' "$(printf '─%.0s' {1..62})"
  printf '%s' "$raw" | jq -r '
    .results[]? | [ (.probe.city + ", " + .probe.country),
      (.result.stats.min // 0), (.result.stats.avg // 0),
      (.result.stats.max // 0), (.result.stats.loss // 0) ] | @tsv' \
  | sort -t$'\t' -k3 -n \
  | awk -F'\t' '{ printf "%-22s %8.1fm %8.1fm %8.1fm %6s%%\n", substr($1,1,22), $2, $3, $4, $5 }'
fi

printf '\n\033[2msaved -> results/%s.json\033[0m\n\n' "$LABEL"
