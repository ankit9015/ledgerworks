-- 0005: close the ledger invariant gap (see DECISIONS.md D21). Runs as ledgerline_owner.
--
-- Until now the app role could INSERT into credit_ledger and UPDATE credit_balances directly, so
-- "ledger sum equals balance" only held for code that went through debit_credits/refund_credits.
-- From here on those two functions are the ONLY way the application changes money:
--   * they become SECURITY DEFINER, owned by a dedicated NOLOGIN role (ledgerline_ledger) that has
--     exactly SELECT+INSERT on credit_ledger and SELECT+UPDATE on credit_balances;
--   * that role's policies are tenant-scoped (tenant_id = app_tenant_id()), NOT permissive, so
--     forced RLS still confines every statement inside the functions to the caller's tenant, and
--     the tenant still comes from the session setting, never from an argument;
--   * the app role loses INSERT on credit_ledger and INSERT/UPDATE on credit_balances, together
--     with the policies that went with those privileges.

GRANT USAGE ON SCHEMA public TO ledgerline_ledger;
-- Needed so ALTER FUNCTION ... OWNER TO can hand the functions over (same pattern as 0002).
GRANT CREATE ON SCHEMA ledgerline_fn TO ledgerline_ledger;

GRANT SELECT, INSERT ON credit_ledger   TO ledgerline_ledger;
GRANT SELECT, UPDATE ON credit_balances TO ledgerline_ledger;

CREATE POLICY ledger_read   ON credit_ledger FOR SELECT TO ledgerline_ledger
  USING (tenant_id = (SELECT app_tenant_id()));
CREATE POLICY ledger_append ON credit_ledger FOR INSERT TO ledgerline_ledger
  WITH CHECK (tenant_id = (SELECT app_tenant_id()));
CREATE POLICY ledger_balance ON credit_balances FOR ALL TO ledgerline_ledger
  USING (tenant_id = (SELECT app_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app_tenant_id()));

-- The app role may read its own ledger and balance, and nothing more.
REVOKE INSERT ON credit_ledger FROM ledgerline_app;
REVOKE INSERT, UPDATE ON credit_balances FROM ledgerline_app;
DROP POLICY tenant_append ON credit_ledger;
DROP POLICY tenant_isolation ON credit_balances;
CREATE POLICY tenant_read ON credit_balances FOR SELECT TO ledgerline_app
  USING (tenant_id = (SELECT app_tenant_id()));

-- The function bodies are unchanged from 0003 (they already use schema-qualified names and take
-- the tenant from app_tenant_id()); only the execution context changes.
ALTER FUNCTION ledgerline_fn.debit_credits(bigint, text, text)
  SECURITY DEFINER SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION ledgerline_fn.refund_credits(bigint, bigint, text, text)
  SECURITY DEFINER SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION ledgerline_fn.debit_credits(bigint, text, text) OWNER TO ledgerline_ledger;
ALTER FUNCTION ledgerline_fn.refund_credits(bigint, bigint, text, text) OWNER TO ledgerline_ledger;
