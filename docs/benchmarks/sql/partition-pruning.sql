-- E6: partition pruning on a date-range read (huge tenant, 7-day window): only one of the 48
-- partitions appears in the plan. The control has no date range and has to visit every partition.
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*), sum(quantity) FROM usage_events
WHERE tenant_id = :TENANT AND occurred_at >= '2026-08-24T00:00:00Z'::timestamptz AND occurred_at < '2026-08-31T00:00:00Z'::timestamptz;
EXPLAIN
SELECT count(*), sum(quantity) FROM usage_events WHERE tenant_id = :TENANT;
