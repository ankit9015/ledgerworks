#!/usr/bin/env bash
# Records the environment of a benchmark session into docs/benchmarks/raw/environment.txt.
set -euo pipefail
cd "$(dirname "$0")/../.."
PSQL="docker exec ledgerworks-postgres psql -U ledgerworks -d ledgerworks -At"
OUT=docs/benchmarks/raw/environment.txt
{
  echo "date (UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "git commit: $(git rev-parse --short HEAD)"
  echo "postgres: $($PSQL -c 'SELECT version()')"
  echo "container limits: $(docker inspect -f 'NanoCpus={{.HostConfig.NanoCpus}} Memory={{.HostConfig.Memory}} MemorySwap={{.HostConfig.MemorySwap}}' ledgerworks-postgres)"
  echo "postgres settings: $($PSQL -F ' ' -c "SELECT string_agg(name || '=' || setting || coalesce(' ' || unit, ''), ', ' ORDER BY name) FROM pg_settings WHERE name IN ('shared_buffers','effective_cache_size','work_mem','maintenance_work_mem','max_connections','random_page_cost','jit','autovacuum','synchronous_commit','shared_preload_libraries')")"
  echo "k6 image: $(MSYS_NO_PATHCONV=1 docker run --rm grafana/k6 version | head -1)"
  echo "node: $(node -v)"
  echo "api: host process (tsx src/server.ts), HOST=0.0.0.0, default pool size 10, LOG_LEVEL=info (default), no changes from the committed code"
  echo "k6 -> api: host.docker.internal:3000"
  echo "seed value: $(python -c "import json;print(json.load(open('.seed/keys.json'))['seed'])" 2>/dev/null || echo unknown)"
  echo "row counts:"
  for t in tenants users memberships api_keys usage_events credit_ledger credit_balances jobs job_attempts dead_letters; do
    echo "  $t: $($PSQL -c "SELECT count(*) FROM $t")"
  done
  echo "database size: $($PSQL -c "SELECT pg_size_pretty(pg_database_size(current_database()))")"
  echo "indexes on usage_events (parent): $($PSQL -c "SELECT string_agg(indexname, '; ') FROM pg_indexes WHERE tablename = 'usage_events'" )"
} | tee "$OUT"
