#!/usr/bin/env bash
# Starts or stops the API the way the benchmarks run it (host process under tsx, default pool size
# 10, default log level). Output goes to docs/benchmarks/raw/api-<label>.txt.
#   ledgerline/k6/api.sh start [label]     ledgerline/k6/api.sh stop
#   ledgerline/k6/api.sh start-baseline [label]   the P1.7 code (git worktree ../ledgerworks-baseline at aa0aa89)
# `stop` waits until port 3000 is really free, and `start*` fails unless THIS process logged
# "Server listening" (an earlier version let a still-running old server answer the health check
# while the new one died with EADDRINUSE, which silently measured the wrong code).
set -euo pipefail
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/../.."

wait_started() { # <log file>
  for i in $(seq 1 60); do
    if grep -q "EADDRINUSE" "$1" 2>/dev/null; then echo "FAILED: port in use, see $1"; exit 1; fi
    if grep -q "Server listening" "$1" 2>/dev/null && curl -sf http://localhost:3000/health >/dev/null; then return 0; fi
    sleep 1
  done
  echo "FAILED: API did not start, see $1"; exit 1
}

# Prove which code answers: the parent (tsx launcher) command line names the checkout it runs from.
assert_code() { # <substring expected in the launcher path> <substring that must NOT be there>
  CMD=$(powershell -NoProfile -Command '
    $c = Get-NetTCPConnection -LocalPort 3000 -State Listen | Select-Object -First 1
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"
    (Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)").CommandLine')
  case "$CMD" in *"$1"*) ;; *) echo "FAILED: listener is not the expected code: $CMD"; exit 1 ;; esac
  case "$CMD" in *"$2"*) echo "FAILED: listener runs from the wrong checkout: $CMD"; exit 1 ;; esac
}

case "${1:?start|start-baseline|stop}" in
  start)
    LABEL=${2:-current}
    "$SELF" stop >/dev/null
    HOST=0.0.0.0 nohup pnpm --filter @ledgerworks/ledgerline dev > "docs/benchmarks/raw/api-$LABEL.txt" 2>&1 < /dev/null &
    wait_started "docs/benchmarks/raw/api-$LABEL.txt"; assert_code "ledgerworks\ledgerline" "ledgerworks-baseline"; echo "API up" ;;
  start-baseline)
    LABEL=${2:-baseline}
    "$SELF" stop >/dev/null
    (cd ../ledgerworks-baseline/ledgerline && HOST=0.0.0.0 nohup npx tsx src/server.ts > "../../ledgerworks/docs/benchmarks/raw/api-$LABEL.txt" 2>&1 < /dev/null &)
    wait_started "docs/benchmarks/raw/api-$LABEL.txt"; assert_code "ledgerworks-baseline" "NONE-NONE"; echo "baseline API up" ;;
  stop)
    powershell -NoProfile -Command '
      $deadline = (Get-Date).AddSeconds(30)
      do {
        $l = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
        foreach ($c in $l) {
          $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"
          if ($p -and $p.ParentProcessId) { Stop-Process -Id $p.ParentProcessId -Force -ErrorAction SilentlyContinue }
          Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Milliseconds 500
        $l = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
      } while ($l -and (Get-Date) -lt $deadline)
      if ($l) { Write-Error "port 3000 still in use"; exit 1 }'
    echo "API stopped" ;;
esac
