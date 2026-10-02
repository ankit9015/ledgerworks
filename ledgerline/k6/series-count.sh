#!/usr/bin/env bash
# Cardinality report: number of distinct metric series exposed by the API and by the demo worker
# right now, and the series per metric family. Run it after a load run.
#   ledgerline/k6/series-count.sh [api metrics url] [worker metrics url]
API=${1:-http://localhost:9464/metrics}; WORKER=${2:-http://localhost:9465/metrics}
for url in "$API" "$WORKER"; do
  body=$(curl -sf "$url") || { echo "$url: not reachable"; continue; }
  echo "== $url: $(echo "$body" | grep -v '^#' | grep -vc '^$') series"
  echo "$body" | grep -v '^#' | grep -v '^$' | sed -E 's/[{ ].*//; s/_(bucket|sum|count)$//' | sort | uniq -c | sort -rn | head -12
done
