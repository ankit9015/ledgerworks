#!/usr/bin/env bash
# Runs one k6 scenario in the grafana/k6 Docker image and stores raw output in docs/benchmarks/raw/.
#
#   ledgerline/k6/run.sh <ingest|usage-read|balance> <huge|large|medium|small|tiny> <run-number> [rate]
#
# Prerequisites: docker compose up -d (Postgres), `pnpm seed --yes` done, and the API running with
#   HOST=0.0.0.0 pnpm --filter @ledgerworks/ledgerline dev     (so the k6 container can reach it)
# Not tuned in any way: default pool size, default log level, no extra indexes or settings.
set -euo pipefail

SCRIPT=${1:?script}; TENANT=${2:?tenant size}; RUN=${3:?run number}; RATE=${4:-}
cd "$(dirname "$0")/../.."
ROOT=$(pwd -W 2>/dev/null || pwd)           # Windows-style path when running under Git Bash
LABEL="${SCRIPT}_${TENANT}_run${RUN}"
OUT=docs/benchmarks/raw
PSQL="docker exec ledgerworks-postgres psql -U ledgerworks -d ledgerworks -At"
mkdir -p "$OUT"

echo "== preflight: $LABEL"
ROWS=$($PSQL -c "SELECT count(*) FROM usage_events")
echo "usage_events rows: $ROWS"
if [ "$ROWS" != "10000000" ]; then echo "ABORT: expected exactly 10000000 rows"; exit 2; fi
curl -sf http://localhost:3000/health >/dev/null || { echo "ABORT: API not healthy on :3000"; exit 2; }
for i in $(seq 1 120); do
  BUSY=$($PSQL -c "SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'autovacuum worker'")
  [ "$BUSY" = "0" ] && break
  echo "waiting for autovacuum to finish ($BUSY running)..."; sleep 5
done
[ "$BUSY" = "0" ] || { echo "ABORT: autovacuum still running"; exit 2; }
$PSQL -c "SELECT pg_stat_statements_reset()" >/dev/null

RATE_ENV=()
[ -n "$RATE" ] && RATE_ENV=(-e "RATE=$RATE")

set +e
MSYS_NO_PATHCONV=1 docker run --rm \
  -e TENANT="$TENANT" "${RATE_ENV[@]}" \
  -v "$ROOT/ledgerline/k6:/scripts:ro" -v "$ROOT/.seed:/seed:ro" -v "$ROOT/$OUT:/out" \
  grafana/k6 run --quiet --no-color --summary-export="/out/$LABEL.summary.json" "/scripts/$SCRIPT.js" \
  > "$OUT/$LABEL.txt" 2>&1
K6_EXIT=$?
set -e
echo "k6 exit code: $K6_EXIT (99 = a threshold failed; thresholds are informational, not gating)"
echo "k6 exit code: $K6_EXIT" >> "$OUT/$LABEL.txt"

# Slowest statements seen by Postgres during this run (pg_stat_statements was reset above).
$PSQL -F ' | ' -c "SELECT calls, round(total_exec_time::numeric,1) AS total_ms, round(mean_exec_time::numeric,3) AS mean_ms, round(max_exec_time::numeric,1) AS max_ms, rows, left(regexp_replace(query, '\s+', ' ', 'g'), 160) FROM pg_stat_statements WHERE query NOT ILIKE '%pg_stat_%' ORDER BY total_exec_time DESC LIMIT 6" > "$OUT/$LABEL.pgss.txt"

if [ "$SCRIPT" = "ingest" ]; then
  $PSQL -c "SELECT count(*) FROM usage_events_2026_10 WHERE event_type = 'k6.baseline'" | sed 's/^/ingested rows this run: /'
  $PSQL -c "TRUNCATE usage_events_2026_10" >/dev/null
  echo "after cleanup usage_events rows: $($PSQL -c 'SELECT count(*) FROM usage_events')"
fi
