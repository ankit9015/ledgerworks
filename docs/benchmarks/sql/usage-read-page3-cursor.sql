-- Item 2: page 3 (cursor = 100th row of the window), window inside one partition.
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, event_type, quantity, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at, metadata
FROM usage_events
WHERE tenant_id = :TENANT AND occurred_at >= '2026-08-24T00:00:00Z'::timestamptz AND occurred_at < '2026-08-31T00:00:00Z'::timestamptz AND (occurred_at, id) < ('2026-08-30T23:05:17.930311Z'::timestamptz, '5c4857c6-2073-09fa-4df5-f8a4abdb84ee'::uuid)
ORDER BY usage_events.occurred_at DESC, usage_events.id DESC
LIMIT 51;
