-- P1.11: the ingest transaction, as ledgerline_app (rows land in usage_events_2026_10, which is
-- truncated afterwards as the k6 runs do), explicit tenant_id.
BEGIN;
SELECT set_config('app.tenant_id', :tenant, true);
INSERT INTO usage_events (tenant_id, occurred_at, event_type, quantity, metadata)
VALUES (:tenant, now(), 'pgbench.rls', 1, '{}'::jsonb);
COMMIT;
