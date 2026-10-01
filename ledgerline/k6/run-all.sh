#!/usr/bin/env bash
# The full baseline matrix: 3 rounds x 6 scenarios (usage-read, balance, ingest x huge, small).
# Fixed load profile (identical every run): warmup 30s, then 60s measured, constant arrival rate:
#   usage-read 2 iterations/s (each = up to 3 paginated requests), balance 100 req/s, ingest 100 req/s.
# Ingest runs last in each round; run.sh truncates the empty current-month partition afterwards.
set -uo pipefail
cd "$(dirname "$0")"
for round in 1 2 3; do
  for combo in "usage-read huge 2" "usage-read small 2" "balance huge 100" "balance small 100" "ingest huge 100" "ingest small 100"; do
    set -- $combo
    echo "##### round $round: $1 $2 (rate $3) $(date -u +%H:%M:%S)"
    ./run.sh "$1" "$2" "$round" "$3" || echo "RUN FAILED: $combo"
  done
done
echo "##### all done $(date -u +%H:%M:%S)"
