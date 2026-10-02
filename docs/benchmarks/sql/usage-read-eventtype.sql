-- Item 2 (extra): the optional eventType filter, which no index covers. Huge tenant, rarest type
-- (api.call, 5% of the tenant's events), a 30-day window, page 1.
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, event_type, quantity, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at, metadata
FROM usage_events
WHERE tenant_id = :TENANT AND occurred_at >= '2026-07-01T00:00:00Z'::timestamptz AND occurred_at < '2026-07-31T00:00:00Z'::timestamptz AND event_type = 'api.call'
ORDER BY usage_events.occurred_at DESC, usage_events.id DESC
LIMIT 51;
