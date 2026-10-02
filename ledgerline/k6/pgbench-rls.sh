#!/usr/bin/env bash
# P1.11, database level: the same transactions as the API runs (BEGIN, set_config, statement,
# COMMIT; explicit tenant_id in every statement) with pgbench, once as ledgerline_app (RLS applies)
# and once as the throwaway BYPASSRLS role ledgerline_bench_norls (see rls-off-role.sh), 1 client,
# 3 alternating rounds. pgbench -M simple (constants in the SQL).
#   ledgerline/k6/pgbench-rls.sh [seconds per run, default 15]
set -uo pipefail
cd "$(dirname "$0")/../.."
SECS=${1:-15}
HUGE=$(node -e "console.log(require('./.seed/keys.json').tenants.find(t=>t.size==='huge').tenantId)")
SMALL=$(node -e "console.log(require('./.seed/keys.json').tenants.find(t=>t.size==='small').tenantId)")
run() { # <role> <script> <tenant id>
  docker exec -i -e PGPASSWORD="$1" ledgerworks-postgres pgbench -h localhost -U "$1" -n -M simple \
    -D tenant="'$3'" -T "$SECS" -c 1 -f /dev/stdin ledgerworks < "docs/benchmarks/sql/pgbench-rls-$2.sql" 2>&1 |
    grep -E "latency average|latency stddev|tps =|number of transactions actually"
}
echo "# P1.11 pgbench, ${SECS}s per run, 1 client, -M simple; transactions: BEGIN; set_config; statement; COMMIT"
for round in 1 2 3; do
  for sc in "usage:$HUGE:usage-huge" "usage:$SMALL:usage-small" "balance:$SMALL:balance" "ingest:$SMALL:ingest"; do
    IFS=: read -r script tenant name <<<"$sc"
    for role in ledgerline_app ledgerline_bench_norls; do
      echo "## round $round scenario=$name role=$role"
      run "$role" "$script" "$tenant"
    done
  done
done
# the ingest runs wrote rows into the otherwise empty current-month partition: remove them, as run.sh does
docker exec ledgerworks-postgres psql -U ledgerworks -d ledgerworks -At -c "SELECT count(*) || ' rows ingested by pgbench' FROM usage_events_2026_10 WHERE event_type = 'pgbench.rls'" -c "TRUNCATE usage_events_2026_10" -c "SELECT count(*) || ' usage_events rows after cleanup' FROM usage_events"
