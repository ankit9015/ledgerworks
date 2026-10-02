#!/usr/bin/env bash
# P1.11: the same k6 scenarios with RLS (API as ledgerline_app) and without it (API as the throwaway
# BYPASSRLS role ledgerline_bench_norls, see rls-off-role.sh), 3 rounds, interleaved mode by mode, the
# API restarted for each mode, same data and same Postgres. The API code is identical in both modes
# and every query already filters by tenant_id explicitly. Raw files: <script>_<tenant>_runrlson<N>
# and ..._runrlsoff<N>.
#   ledgerline/k6/rls-compare.sh
set -uo pipefail
cd "$(dirname "$0")"
COMBOS=("usage-read huge 2" "usage-read small 2" "balance small 100" "ingest small 100")
PSQL="docker exec ledgerworks-postgres psql -U ledgerworks -d ledgerworks -At"
for round in 1 2 3; do
  for mode in rlson rlsoff; do
    if [ "$mode" = rlsoff ]; then
      export DATABASE_URL="postgres://ledgerline_bench_norls:ledgerline_bench_norls@localhost:5432/ledgerworks"; EXPECT=ledgerline_bench_norls; OTHER=ledgerline_app
    else
      unset DATABASE_URL; EXPECT=ledgerline_app; OTHER=ledgerline_bench_norls
    fi
    ./api.sh start "rls-compare-$mode-r$round" || continue
    # prove which role the API connects as (health did a query, so a pool connection exists)
    GOT=$($PSQL -c "SELECT string_agg(DISTINCT usename, ',') FROM pg_stat_activity WHERE datname = 'ledgerworks' AND usename IN ('$EXPECT', '$OTHER')")
    echo "round $round $mode: API connected as: $GOT"
    if [ "$GOT" != "$EXPECT" ]; then echo "ABORT: expected $EXPECT"; ./api.sh stop; exit 1; fi
    for combo in "${COMBOS[@]}"; do
      read -r script tenant rate <<<"$combo"
      echo "##### round $round $mode: $script $tenant (rate $rate) $(date -u +%H:%M:%S)"
      ./run.sh "$script" "$tenant" "${mode}${round}" "$rate" || echo "RUN FAILED: $mode $combo"
    done
  done
done
unset DATABASE_URL
./api.sh stop
echo "##### all done $(date -u +%H:%M:%S)"
