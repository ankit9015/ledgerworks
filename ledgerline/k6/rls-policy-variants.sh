#!/usr/bin/env bash
# P1.11: does the way the policy reads the tenant setting matter for planning or execution?
# Inside ONE transaction that is ROLLED BACK (policy DDL is transactional, so nothing persists), the
# usage_events policy is switched between variants and the same statement is run N times server-side
# as ledgerline_app (plan + execute each time, no network), reporting the mean time per execution.
# Variants of USING (tenant_id = ...):
#   A  (SELECT app_tenant_id())                            the policy in migration 0002
#   B  app_tenant_id()                                     bare stable function call
#   C  (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)   no regex helper (errors on a malformed id)
#   F  policy A unchanged, but app_tenant_id() rewritten without a FROM clause so the planner can inline it
#      (same result for every input: NULL for a missing, empty or malformed setting)
#   N  no policy at all: run as the throwaway BYPASSRLS role (reference)
# Queries: Q1 usage-read page 1 (huge tenant, 7-day window, 51 rows); Q2 a 6-month aggregate over about
# 1.2M rows of the huge tenant (shows whether the setting is evaluated once per statement or per row).
#   ledgerline/k6/rls-policy-variants.sh [iterations for Q1, default 3000] [rounds, default 3]
set -euo pipefail
cd "$(dirname "$0")/../.."
N1=${1:-3000}; ROUNDS=${2:-3}
HUGE=$(node -e "console.log(require('./.seed/keys.json').tenants.find(t=>t.size==='huge').tenantId)")
Q1="SELECT id, event_type, quantity, occurred_at, metadata FROM usage_events WHERE tenant_id = '$HUGE' AND occurred_at >= '2026-08-24T00:00:00Z'::timestamptz AND occurred_at < '2026-08-31T00:00:00Z'::timestamptz ORDER BY usage_events.occurred_at DESC, usage_events.id DESC LIMIT 51"
Q2="SELECT count(*), sum(quantity) FROM usage_events WHERE tenant_id = '$HUGE' AND occurred_at >= '2026-01-01T00:00:00Z'::timestamptz AND occurred_at < '2026-07-01T00:00:00Z'::timestamptz"
FN_F="CREATE OR REPLACE FUNCTION public.app_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS \$f\$ SELECT CASE WHEN current_setting('app.tenant_id', true) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\$' THEN current_setting('app.tenant_id', true)::uuid END \$f\$;"
declare -A POLICY=(
  [A]="(SELECT app_tenant_id())"
  [B]="app_tenant_id()"
  [C]="(SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)"
)
bench() { # <label> <query> <iterations> <role>
  cat <<SQL
RESET ROLE; SET LOCAL ROLE $4;
DO \$\$ DECLARE t0 timestamptz; n int := $3; r record; BEGIN
  t0 := clock_timestamp();
  FOR i IN 1..n LOOP FOR r IN EXECUTE \$q\$$2\$q\$ LOOP NULL; END LOOP; END LOOP;
  RAISE NOTICE '$1: % ms per execution (% executions)', round(((extract(epoch FROM clock_timestamp() - t0) * 1000) / n)::numeric, 4), n;
END \$\$;
SQL
}
{
  echo "BEGIN;"
  echo "SELECT set_config('app.tenant_id', '$HUGE', true);"
  echo "\echo '--- warmup (not reported)'"
  bench "warmup Q1" "$Q1" 500 ledgerline_app
  bench "warmup Q2" "$Q2" 3 ledgerline_app
  for round in $(seq 1 "$ROUNDS"); do
    echo "\echo '--- round $round'"
    echo "RESET ROLE;"
    echo "CREATE OR REPLACE FUNCTION public.app_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS \$f\$ SELECT CASE WHEN v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\$' THEN v::uuid END FROM (SELECT current_setting('app.tenant_id', true) AS v) s \$f\$;"
    for v in A B C; do
      echo "RESET ROLE;"
      echo "ALTER POLICY tenant_isolation ON usage_events USING (tenant_id = ${POLICY[$v]}) WITH CHECK (tenant_id = ${POLICY[$v]});"
      bench "Q1 variant $v" "$Q1" "$N1" ledgerline_app
      bench "Q2 variant $v" "$Q2" 5 ledgerline_app
    done
    echo "RESET ROLE;"
    echo "ALTER POLICY tenant_isolation ON usage_events USING (tenant_id = ${POLICY[A]}) WITH CHECK (tenant_id = ${POLICY[A]});"
    echo "$FN_F"
    bench "Q1 variant F" "$Q1" "$N1" ledgerline_app
    bench "Q2 variant F" "$Q2" 5 ledgerline_app
    bench "Q1 variant N (no RLS)" "$Q1" "$N1" ledgerline_bench_norls
    bench "Q2 variant N (no RLS)" "$Q2" 5 ledgerline_bench_norls
  done
  echo "RESET ROLE;"
  echo "ROLLBACK;"
} | docker exec -i ledgerworks-postgres psql -U ledgerworks -d ledgerworks -X -q -v ON_ERROR_STOP=1 2>&1 | grep -E "NOTICE|---|ERROR" | sed 's/^psql:<stdin>:[0-9]*: //'
docker exec ledgerworks-postgres psql -U ledgerworks -d ledgerworks -At -c "SELECT 'policy after rollback: ' || qual FROM pg_policies WHERE tablename = 'usage_events'"
