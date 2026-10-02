#!/usr/bin/env bash
# Runs one SQL file as the application role (ledgerline_app, RLS applies) with the tenant set, so
# EXPLAIN output matches what the API sees. The file's statements run inside a transaction that is
# rolled back. Placeholders replaced: :HUGE and :SMALL (tenant ids from .seed/keys.json).
#   docs/benchmarks/sql/explain.sh <file.sql> [huge|small] [repeat]
# EXPLAIN_ROLE=ledgerline_bench_norls runs it as the throwaway no-RLS role of P1.11 (see k6/rls-off-role.sh).
set -euo pipefail
cd "$(dirname "$0")/../../.."
FILE=${1:?sql file}; SIZE=${2:-huge}; REPEAT=${3:-1}; ROLE=${EXPLAIN_ROLE:-ledgerline_app}
TID=$(node -e "const k=require('./.seed/keys.json');console.log(k.tenants.find(t=>t.size==='$SIZE').tenantId)")
for i in $(seq 1 "$REPEAT"); do
  { echo "BEGIN;"; echo "SELECT set_config('app.tenant_id', '$TID', true);"; sed "s/:TENANT/'$TID'/g" "$FILE"; echo "ROLLBACK;"; } |
    docker exec -i -e PGPASSWORD=$ROLE ledgerworks-postgres psql -h localhost -U $ROLE -d ledgerworks -X -q -P pager=off
done
