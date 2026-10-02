-- O1: the query exactly as the API ran it before the fix (ORDER BY resolves to the output alias).
-- Huge tenant (rank 1), 7-day window, page 1, limit 50 (+1).
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, event_type, quantity, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at, metadata
FROM usage_events
WHERE tenant_id = :TENANT AND occurred_at >= '2026-08-24T00:00:00Z'::timestamptz AND occurred_at < '2026-08-31T00:00:00Z'::timestamptz
ORDER BY occurred_at DESC, id DESC
LIMIT 51;
