-- P1.11: the balance-read transaction, as ledgerline_app, explicit tenant_id predicate.
BEGIN;
SELECT set_config('app.tenant_id', :tenant, true);
SELECT balance, updated_at FROM credit_balances WHERE tenant_id = :tenant;
COMMIT;
