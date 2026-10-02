-- E6: page 1 of a 7-day window at a random day inside the seeded year (2025-10-01 = epoch
-- 1759276800); the bounds use to_timestamp (immutable) so they are plan-time constants, like the
-- timestamptz parameters the API sends. The tenant id is substituted by pgbench.
\set t random(0, 357) * 86400
SELECT id, event_type, quantity, occurred_at, metadata FROM usage_events
WHERE tenant_id = :tenant AND occurred_at >= to_timestamp(1759276800 + :t)
  AND occurred_at < to_timestamp(1759276800 + :t + 604800)
ORDER BY occurred_at DESC, id DESC LIMIT 51;
