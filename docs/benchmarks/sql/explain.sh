#!/usr/bin/env bash
# Runs one SQL file as the application role (ledgerline_app, RLS applies) with the tenant set, so
# EXPLAIN output matches what the API sees. The file's statements run inside a transaction that is
# rolled back. Placeholders replaced: :HUGE and :SMALL (tenant ids from .seed/keys.json).
#   docs/benchmarks/sql/explain.sh <file.sql> [huge|small] [repeat]
set -euo pipefail
cd "$(dirname "$0")/../../.."
FILE=${1:?sql file}; SIZE=${2:-huge}; REPEAT=${3:-1}
TID=$(node -e "const k=require('./.seed/keys.json');console.log(k.tenants.find(t=>t.size==='$SIZE').tenantId)")
for i in $(seq 1 "$REPEAT"); do
  { echo "BEGIN;"; echo "SELECT set_config('app.tenant_id', '$TID', true);"; sed "s/:TENANT/'$TID'/g" "$FILE"; echo "ROLLBACK;"; } |
    docker exec -i -e PGPASSWORD=ledgerline_app ledgerworks-postgres psql -h localhost -U ledgerline_app -d ledgerworks -X -q -P pager=off
done
