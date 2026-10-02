-- P1.11: the usage-read page-1 transaction as the API runs it (BEGIN, set_config, SELECT, COMMIT),
-- as ledgerline_app, random 7-day window (2025-10-01 = epoch 1759276800). Same file for both modes;
-- in the "no RLS" copy of the database the policies are simply disabled. The query always carries
-- an explicit tenant_id predicate, so both modes filter by tenant.
\set t random(0, 357) * 86400
BEGIN;
SELECT set_config('app.tenant_id', :tenant, true);
SELECT id, event_type, quantity, occurred_at, metadata FROM usage_events
WHERE tenant_id = :tenant AND occurred_at >= to_timestamp(1759276800 + :t)
  AND occurred_at < to_timestamp(1759276800 + :t + 604800)
ORDER BY occurred_at DESC, id DESC LIMIT 51;
COMMIT;
