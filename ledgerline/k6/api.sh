#!/usr/bin/env bash
# Starts or stops the API the way the benchmarks run it (host process under tsx, default pool size
# 10, default log level). Output goes to docs/benchmarks/raw/api-<label>.log.
#   ledgerline/k6/api.sh start [label]     ledgerline/k6/api.sh stop
set -euo pipefail
cd "$(dirname "$0")/../.."
case "${1:?start|stop}" in
  start)
    LABEL=${2:-current}
    "$0" stop >/dev/null 2>&1 || true
    HOST=0.0.0.0 nohup pnpm --filter @ledgerworks/ledgerline dev > "docs/benchmarks/raw/api-$LABEL.txt" 2>&1 &
    for i in $(seq 1 60); do curl -sf http://localhost:3000/health >/dev/null && { echo "API up"; exit 0; }; sleep 1; done
    echo "API did not start"; exit 1 ;;
  stop)
    powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force }" || true
    sleep 1; echo "API stopped" ;;
esac
