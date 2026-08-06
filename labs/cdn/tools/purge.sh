#!/usr/bin/env bash
# purge.sh — actively invalidate cached objects via the Cloudflare API.
#
#   ./tools/purge.sh url <url> [<url>...]    purge specific URLs
#   ./tools/purge.sh all                     purge the entire zone
#
# Reads CF_API_TOKEN and CF_ZONE_ID from .env (gitignored).
#
# A purge is not free. Every PoP holding the object drops it, so the next
# request in each of 300+ locations is a MISS that reaches the origin. Purging
# one hot object can produce hundreds of simultaneous origin requests — see
# Module 6. `purge all` does this for every object at once and should be treated
# as an incident-response tool, not a deployment step.
#
# Note on cache keys: this purges by URL, and the Worker's cache key is the
# URL with tracking parameters stripped and the rest sorted. Purge the
# normalised form or the entry will survive.
set -uo pipefail

cd "$(dirname "$0")/.."
[ -f .env ] || { echo "no .env — see .env.example"; exit 1; }
set -a; . ./.env; set +a
: "${CF_API_TOKEN:?missing in .env}" "${CF_ZONE_ID:?missing in .env}"

MODE="${1:?usage: purge.sh <url|all> [urls...]}"; shift

api() {
  curl -sS -X POST \
    "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/purge_cache" \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    -H 'Content-Type: application/json' \
    --data "$1"
}

case "$MODE" in
  url)
    [ $# -gt 0 ] || { echo "usage: purge.sh url <url> [<url>...]"; exit 1; }
    body=$(printf '%s\n' "$@" | jq -R . | jq -sc '{files: .}')
    label="$# url(s)"
    ;;
  all)
    body='{"purge_everything":true}'
    label="EVERYTHING"
    ;;
  *) echo "unknown mode: $MODE"; exit 1 ;;
esac

start=$(python3 -c 'import time; print(time.time())')
resp=$(api "$body")
end=$(python3 -c 'import time; print(time.time())')

ok=$(printf '%s' "$resp" | jq -r '.success')
if [ "$ok" = true ]; then
  printf 'purged %s in %.0fms — API acknowledged\n' \
    "$label" "$(echo "($end - $start) * 1000" | bc -l)"
  echo "note: the API returning success means the request was ACCEPTED."
  echo "      Propagation to every PoP is asynchronous and is what to measure."
else
  printf 'purge FAILED:\n%s\n' "$(printf '%s' "$resp" | jq -c '.errors')"
  exit 1
fi
