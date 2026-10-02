-- Page 3 of the same window with the keyset cursor exactly as the API builds it
-- ((occurred_at, id) < (cursor_t, cursor_id)), ORDER BY the table column. The cursor values are the
-- 100th row of the page-1 ordering, looked up first.
CREATE TEMP TABLE _c AS
SELECT occurred_at AS t, id FROM usage_events
WHERE tenant_id = :TENANT AND occurred_at >= '2026-08-24T00:00:00Z'::timestamptz AND occurred_at < '2026-08-31T00:00:00Z'::timestamptz
ORDER BY usage_events.occurred_at DESC, usage_events.id DESC OFFSET 99 LIMIT 1;
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, event_type, quantity, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at, metadata
FROM usage_events
WHERE tenant_id = :TENANT AND occurred_at >= '2026-08-24T00:00:00Z'::timestamptz AND occurred_at < '2026-08-31T00:00:00Z'::timestamptz
  AND (occurred_at, id) < ((SELECT t FROM _c), (SELECT id FROM _c))
ORDER BY usage_events.occurred_at DESC, usage_events.id DESC
LIMIT 51;
