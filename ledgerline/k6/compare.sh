#!/usr/bin/env bash
# The full baseline matrix (6 scenarios x 3 rounds) for the FINAL code and, in the same session and
# interleaved round by round, for the ORIGINAL P1.7 code (git worktree ../ledgerworks-baseline at
# aa0aa89, same database), so drift of this machine between sessions cannot be mistaken for a code
# effect. Raw files: <script>_<tenant>_runfinal2<N> and <script>_<tenant>_runbase2<N>.
#   ledgerline/k6/compare.sh
set -uo pipefail
cd "$(dirname "$0")"
COMBOS=("usage-read huge 2" "usage-read small 2" "balance huge 100" "balance small 100" "ingest huge 100" "ingest small 100")
for round in 1 2 3; do
  for variant in final2 base2; do
    if [ "$variant" = final2 ]; then ./api.sh start "compare-final2-r$round" || continue
    else ./api.sh start-baseline "compare-base2-r$round" || continue; fi
    for combo in "${COMBOS[@]}"; do
      read -r script tenant rate <<<"$combo"
      echo "##### round $round $variant: $script $tenant (rate $rate) $(date -u +%H:%M:%S)"
      ./run.sh "$script" "$tenant" "${variant}${round}" "$rate" || echo "RUN FAILED: $variant $combo"
    done
  done
done
./api.sh stop
echo "##### all done $(date -u +%H:%M:%S)"
