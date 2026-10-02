-- O1 after the fix: the same query, ORDER BY names the table column.
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, event_type, quantity, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at, metadata
FROM usage_events
WHERE tenant_id = :TENANT AND occurred_at >= '2026-08-24T00:00:00Z'::timestamptz AND occurred_at < '2026-08-31T00:00:00Z'::timestamptz
ORDER BY usage_events.occurred_at DESC, usage_events.id DESC
LIMIT 51;
