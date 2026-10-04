#!/usr/bin/env bash
# L3.1: a short, mixed Ledgerline workload so that pg_stat_statements has something real in it.
# Uses the existing k6 scripts (ledgerline/k6/*.js) unchanged. Raw output goes to docs/benchmarks/raw/
# under NEW names (l3.1-<scenario>_<tenant>_<UTC stamp>.*); nothing existing is overwritten.
#
#   ledgerlens/scripts/k6-workload.sh
#
# Prerequisites: docker compose up -d, `pnpm seed --yes` done, and the API running with
#   HOST=0.0.0.0 pnpm --filter @ledgerworks/ledgerline dev
#
# pg_stat_statements is reset ONLY for the benchmark database (dbid), once, before the first run
# (the existing ledgerline/k6/run.sh resets everything before every run, which would keep only the
# last scenario). The ingest scenario's rows are removed afterwards exactly as run.sh does.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT=$(pwd -W 2>/dev/null || pwd)
OUT=docs/benchmarks/raw
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
PSQL="docker exec ledgerworks-postgres psql -U ledgerworks -d ledgerworks -At"
mkdir -p "$OUT"

ROWS=$($PSQL -c "SELECT count(*) FROM usage_events")
echo "usage_events rows: $ROWS"
[ "$ROWS" = "10000000" ] || { echo "ABORT: expected exactly 10000000 rows"; exit 2; }
curl -sf http://localhost:3000/health >/dev/null || { echo "ABORT: API not healthy on :3000"; exit 2; }
for i in $(seq 1 120); do
  BUSY=$($PSQL -c "SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'autovacuum worker'")
  [ "$BUSY" = "0" ] && break
  echo "waiting for autovacuum ($BUSY running)..."; sleep 5
done
[ "$BUSY" = "0" ] || { echo "ABORT: autovacuum still running"; exit 2; }

$PSQL -c "SELECT pg_stat_statements_reset(0, (SELECT oid FROM pg_database WHERE datname = 'ledgerworks'), 0)" >/dev/null
echo "pg_stat_statements reset for database ledgerworks at $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# scenario tenant rate
RUNS=("usage-read huge 2" "usage-read small 2" "balance small 100" "ingest small 20")
for spec in "${RUNS[@]}"; do
  read -r SCRIPT TENANT RATE <<<"$spec"
  LABEL="l3.1-${SCRIPT}_${TENANT}_${STAMP}"
  echo "== $LABEL (rate $RATE/s, 95 s)"
  set +e
  MSYS_NO_PATHCONV=1 docker run --rm -e TENANT="$TENANT" -e RATE="$RATE" \
    -v "$ROOT/ledgerline/k6:/scripts:ro" -v "$ROOT/.seed:/seed:ro" -v "$ROOT/$OUT:/out" \
    grafana/k6 run --quiet --no-color --summary-export="/out/$LABEL.summary.json" "/scripts/$SCRIPT.js" \
    > "$OUT/$LABEL.txt" 2>&1
  K6_EXIT=$?
  set -e
  echo "k6 exit code: $K6_EXIT (thresholds are informational)" | tee -a "$OUT/$LABEL.txt"
done

# the raw statistics of this workload, kept as a file (queries are normalized by Postgres: no literals)
$PSQL -c "COPY (SELECT queryid, calls, round(total_exec_time::numeric,3) AS total_exec_time_ms, round(mean_exec_time::numeric,3) AS mean_exec_time_ms, rows, shared_blks_hit, shared_blks_read, regexp_replace(query, '\s+', ' ', 'g') AS query FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = 'ledgerworks') ORDER BY total_exec_time DESC) TO STDOUT WITH CSV HEADER" \
  > "$OUT/l3.1-pgss-after-k6_${STAMP}.csv"

$PSQL -c "TRUNCATE usage_events_2026_10" >/dev/null
echo "after cleanup usage_events rows: $($PSQL -c 'SELECT count(*) FROM usage_events')"
echo "$STAMP" > "$OUT/l3.1-latest-stamp.txt"
