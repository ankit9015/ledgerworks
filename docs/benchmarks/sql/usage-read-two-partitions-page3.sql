-- Item 2: page 3 with cursor, window spanning a month boundary.
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, event_type, quantity, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at, metadata
FROM usage_events
WHERE tenant_id = :TENANT AND occurred_at >= '2026-08-28T00:00:00Z'::timestamptz AND occurred_at < '2026-09-04T00:00:00Z'::timestamptz AND (occurred_at, id) < ('2026-09-03T23:33:20.284944Z'::timestamptz, '64ed2919-bf67-ddf6-e216-2f6182e5a0a5'::uuid)
ORDER BY usage_events.occurred_at DESC, usage_events.id DESC
LIMIT 51;
