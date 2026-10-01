-- 0002: row-level security, tenant helper, and the two SECURITY DEFINER functions.
-- Runs as ledgerline_owner.

-- The current tenant for this transaction. The API sets it with
--   SELECT set_config('app.tenant_id', '<uuid>', true)   -- true = local to the transaction
-- If the setting is missing, empty or not a uuid this returns NULL, and "tenant_id = NULL" is never
-- true, so every policy below yields zero rows (no error, and never "everything").
CREATE FUNCTION app_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN v::uuid
  END
  FROM (SELECT current_setting('app.tenant_id', true) AS v) s
$$;

-- ---------------------------------------------------------------------------------------------
-- Enable AND force RLS on every tenant-owned table (FORCE makes the owner obey policies too).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE tenants         ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants         FORCE  ROW LEVEL SECURITY;
ALTER TABLE users           ENABLE ROW LEVEL SECURITY;
ALTER TABLE users           FORCE  ROW LEVEL SECURITY;
ALTER TABLE memberships     ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships     FORCE  ROW LEVEL SECURITY;
ALTER TABLE api_keys        ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys        FORCE  ROW LEVEL SECURITY;
ALTER TABLE usage_events    ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events    FORCE  ROW LEVEL SECURITY;
ALTER TABLE credit_ledger   ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_ledger   FORCE  ROW LEVEL SECURITY;
ALTER TABLE credit_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_balances FORCE  ROW LEVEL SECURITY;
ALTER TABLE jobs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs            FORCE  ROW LEVEL SECURITY;
ALTER TABLE job_attempts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_attempts    FORCE  ROW LEVEL SECURITY;
ALTER TABLE dead_letters    ENABLE ROW LEVEL SECURITY;
ALTER TABLE dead_letters    FORCE  ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------------------------
-- Application policies. (SELECT app_tenant_id()) is evaluated once per statement, not per row.
-- ---------------------------------------------------------------------------------------------
-- A tenant sees only itself.
CREATE POLICY tenant_isolation ON tenants FOR SELECT TO ledgerline_app
  USING (id = (SELECT app_tenant_id()));

-- A tenant sees only users that are members of it.
CREATE POLICY tenant_isolation ON users FOR SELECT TO ledgerline_app
  USING (EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.user_id = users.id AND m.tenant_id = (SELECT app_tenant_id())
  ));

CREATE POLICY tenant_isolation ON memberships FOR ALL TO ledgerline_app
  USING (tenant_id = (SELECT app_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app_tenant_id()));

CREATE POLICY tenant_isolation ON api_keys FOR ALL TO ledgerline_app
  USING (tenant_id = (SELECT app_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app_tenant_id()));

CREATE POLICY tenant_isolation ON usage_events FOR ALL TO ledgerline_app
  USING (tenant_id = (SELECT app_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app_tenant_id()));

-- Ledger: read and append only (no UPDATE/DELETE policy exists, in addition to the missing
-- privileges and the trigger from 0001).
CREATE POLICY tenant_read   ON credit_ledger FOR SELECT TO ledgerline_app
  USING (tenant_id = (SELECT app_tenant_id()));
CREATE POLICY tenant_append ON credit_ledger FOR INSERT TO ledgerline_app
  WITH CHECK (tenant_id = (SELECT app_tenant_id()));

CREATE POLICY tenant_isolation ON credit_balances FOR ALL TO ledgerline_app
  USING (tenant_id = (SELECT app_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app_tenant_id()));

CREATE POLICY tenant_isolation ON jobs FOR ALL TO ledgerline_app
  USING (tenant_id = (SELECT app_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app_tenant_id()));

CREATE POLICY tenant_isolation ON job_attempts FOR ALL TO ledgerline_app
  USING (tenant_id = (SELECT app_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app_tenant_id()));

CREATE POLICY tenant_isolation ON dead_letters FOR ALL TO ledgerline_app
  USING (tenant_id = (SELECT app_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app_tenant_id()));

-- ---------------------------------------------------------------------------------------------
-- SECURITY DEFINER functions (see DECISIONS.md D14). They run as ledgerline_definer, which has
-- only the table privileges below and its own permissive policies on exactly those tables.
-- It does NOT have BYPASSRLS, so it cannot touch any other table's rows.
-- ---------------------------------------------------------------------------------------------
CREATE SCHEMA ledgerline_fn;
GRANT CREATE ON SCHEMA ledgerline_fn TO ledgerline_definer;
GRANT USAGE  ON SCHEMA ledgerline_fn TO ledgerline_app;
GRANT USAGE  ON SCHEMA public        TO ledgerline_definer;

GRANT SELECT, INSERT ON tenants         TO ledgerline_definer;
GRANT SELECT, INSERT ON users           TO ledgerline_definer;
GRANT INSERT         ON memberships     TO ledgerline_definer;
GRANT SELECT, INSERT ON api_keys        TO ledgerline_definer;
GRANT INSERT         ON credit_balances TO ledgerline_definer;

CREATE POLICY definer_access ON tenants         FOR ALL TO ledgerline_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_access ON users           FOR ALL TO ledgerline_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_access ON memberships     FOR ALL TO ledgerline_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_access ON api_keys        FOR ALL TO ledgerline_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_access ON credit_balances FOR ALL TO ledgerline_definer USING (true) WITH CHECK (true);

-- Creates a tenant, its owner membership, a zero credit balance and its first API key.
-- The caller generates the key and passes only its SHA-256 hex hash and a display prefix.
CREATE FUNCTION ledgerline_fn.create_tenant(
  p_name text, p_owner_email text, p_key_hash text, p_key_prefix text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := gen_random_uuid();
  v_user   uuid;
BEGIN
  INSERT INTO public.tenants (id, name) VALUES (v_tenant, p_name);
  INSERT INTO public.users (email) VALUES (p_owner_email)
    ON CONFLICT (lower(email)) DO NOTHING;
  SELECT u.id INTO v_user FROM public.users u WHERE lower(u.email) = lower(p_owner_email);
  INSERT INTO public.memberships (tenant_id, user_id, role) VALUES (v_tenant, v_user, 'owner');
  INSERT INTO public.credit_balances (tenant_id) VALUES (v_tenant);
  INSERT INTO public.api_keys (tenant_id, key_prefix, key_hash)
    VALUES (v_tenant, p_key_prefix, p_key_hash);
  RETURN v_tenant;
END $$;

-- The API-key lookup problem: the API must find a key before it knows the tenant. This is the
-- only code path that reads api_keys across tenants. It matches the full hash (never a prefix),
-- ignores revoked keys, and returns only the two ids needed to open a tenant transaction.
CREATE FUNCTION ledgerline_fn.authenticate_api_key(p_key_hash text)
RETURNS TABLE (tenant_id uuid, api_key_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT k.tenant_id, k.id
  FROM public.api_keys k
  WHERE k.key_hash = p_key_hash AND k.revoked_at IS NULL
$$;

ALTER FUNCTION ledgerline_fn.create_tenant(text, text, text, text) OWNER TO ledgerline_definer;
ALTER FUNCTION ledgerline_fn.authenticate_api_key(text) OWNER TO ledgerline_definer;

REVOKE EXECUTE ON FUNCTION ledgerline_fn.create_tenant(text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ledgerline_fn.authenticate_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledgerline_fn.create_tenant(text, text, text, text) TO ledgerline_app;
GRANT EXECUTE ON FUNCTION ledgerline_fn.authenticate_api_key(text) TO ledgerline_app;
