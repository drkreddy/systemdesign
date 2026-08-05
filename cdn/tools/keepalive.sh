#!/usr/bin/env bash
# keepalive.sh — hold the Render free-tier origin awake during a lab session.
#
#   ./tools/keepalive.sh <origin-url> [interval_s]
#
# Render idles a free service out after ~15 minutes without traffic, and waking
# it costs 30-60s of cold start. That cold start would land inside whatever
# latency measurement you happen to be taking and look like network latency,
# which is exactly the kind of artefact that makes a benchmark lie.
#
# Pings /health, which the origin deliberately does NOT count in /stats — so
# keeping the service warm never pollutes the hit counters the experiments read.
#
# Run it in one terminal for the duration of a lab, Ctrl-C when done.
set -uo pipefail

URL="${1:?usage: keepalive.sh <origin-url> [interval_s]}"
INTERVAL="${2:-600}"   # 10 min — comfortably inside Render's ~15 min idle window

printf 'keepalive: %s/health every %ss — Ctrl-C to stop\n' "${URL%/}" "$INTERVAL"
while true; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 90 "${URL%/}/health" 2>/dev/null)
  ms=$(curl -sS -o /dev/null -w '%{time_total}' --max-time 90 "${URL%/}/health" 2>/dev/null)
  printf '[%s] health=%s  %.0fms\n' "$(date +%H:%M:%S)" "${code:-ERR}" "$(echo "${ms:-0} * 1000" | bc -l)"
  sleep "$INTERVAL"
done
