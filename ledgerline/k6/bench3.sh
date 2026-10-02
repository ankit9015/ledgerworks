#!/usr/bin/env bash
# Runs a set of scenarios 3 times each (rounds interleaved, like run-all.sh) under one tag, using
# exactly the same run.sh, profile and preflight as the baseline.
#   ledgerline/k6/bench3.sh <tag> "usage-read huge 2" "usage-read small 2" ...
# Raw files: docs/benchmarks/raw/<script>_<tenant>_run<tag><round>.{txt,summary.json,pgss.txt}
set -uo pipefail
cd "$(dirname "$0")"
TAG=${1:?tag}; shift
COMBOS=("$@")
for round in 1 2 3; do
  for combo in "${COMBOS[@]}"; do
    read -r script tenant rate <<<"$combo"
    echo "##### $TAG round $round: $script $tenant (rate $rate) $(date -u +%H:%M:%S)"
    ./run.sh "$script" "$tenant" "${TAG}${round}" "$rate" || echo "RUN FAILED: $combo"
  done
done
