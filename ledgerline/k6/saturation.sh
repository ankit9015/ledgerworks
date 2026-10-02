#!/usr/bin/env bash
# Huge-tenant usage-read saturation probes, same script, profile and preflight as the baseline's
# "Saturation" section (30 s warmup + 60 s measure, k6 up to 400 VUs), only the rate differs.
#   ledgerline/k6/saturation.sh <tag> <rate> [<rate> ...]      raw: usage-read_huge_run<tag><rate>x<n>
set -uo pipefail
cd "$(dirname "$0")"
TAG=${1:?tag}; shift
./api.sh start "saturation-$TAG" || exit 1
N=0
for rate in "$@"; do
  N=$((N + 1))
  echo "##### saturation $TAG: usage-read huge at $rate it/s $(date -u +%H:%M:%S)"
  ./run.sh usage-read huge "${TAG}${rate}x${N}" "$rate" || echo "RUN FAILED: $rate"
done
./api.sh stop
echo "##### all done $(date -u +%H:%M:%S)"
