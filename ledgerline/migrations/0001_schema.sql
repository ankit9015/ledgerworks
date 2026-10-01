-- 0001: core schema. Runs as ledgerline_owner (the owner of every object created here).
-- Row-level security, helper functions and SECURITY DEFINER functions come in 0002.

CREATE TABLE tenants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Users are global (one person can belong to several tenants); tenancy lives in memberships.
CREATE TABLE users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

CREATE TABLE memberships (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  user_id    uuid NOT NULL REFERENCES users (id),
  role       text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);

-- Only a hash of the key is stored. key_prefix is the visible, non-secret part (e.g. lk_ab12cd34).
CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  name         text NOT NULL DEFAULT 'default',
  key_prefix   text NOT NULL,
  key_hash     text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz,
  CHECK (key_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX api_keys_tenant_id_idx ON api_keys (tenant_id);

-- Partitioned by month on occurred_at. The partition key must be part of the primary key.
CREATE TABLE usage_events (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  occurred_at timestamptz NOT NULL,
  event_type  text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 100),
  quantity    bigint NOT NULL CHECK (quantity >= 0),
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

-- Main read pattern: one tenant, a time range.
CREATE INDEX usage_events_tenant_time_idx ON usage_events (tenant_id, occurred_at);

-- Creates the partition for the month containing p_month (idempotent). Reused by P1.10.
CREATE FUNCTION create_usage_events_partition(p_month date) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_start date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_name  text := format('usage_events_%s', to_char(v_start, 'YYYY_MM'));
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF usage_events FOR VALUES FROM (%L) TO (%L)',
    v_name, v_start, v_end);
  RETURN v_name;
END $$;

-- Deterministic initial range: 2024-01 .. 2027-12.
SELECT create_usage_events_partition(m::date)
FROM generate_series('2024-01-01'::date, '2027-12-01'::date, interval '1 month') AS m;

-- Append-only ledger of credit movements. amount > 0 adds credits, amount < 0 spends them.
CREATE TABLE credit_ledger (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  amount          bigint NOT NULL CHECK (amount <> 0),
  kind            text NOT NULL CHECK (kind IN ('grant', 'debit', 'refund', 'adjustment')),
  idempotency_key text,
  reference       text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX credit_ledger_idempotency_key
  ON credit_ledger (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- Also serves the tenant FK and "latest entries of a tenant".
CREATE INDEX credit_ledger_tenant_id_idx ON credit_ledger (tenant_id, id);

CREATE FUNCTION reject_ledger_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'credit_ledger is append-only (% rejected)', TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER credit_ledger_no_update_delete
  BEFORE UPDATE OR DELETE ON credit_ledger
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_change();
CREATE TRIGGER credit_ledger_no_truncate
  BEFORE TRUNCATE ON credit_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_change();

CREATE TABLE credit_balances (
  tenant_id  uuid PRIMARY KEY REFERENCES tenants (id),
  balance    bigint NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  queue           text NOT NULL DEFAULT 'default',
  type            text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead')),
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  run_at          timestamptz NOT NULL DEFAULT now(),
  locked_at       timestamptz,
  locked_by       text,
  idempotency_key text,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  -- Lets child tables use a composite FK so a child row can never point at another tenant's job.
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX jobs_idempotency_key
  ON jobs (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- Worker poll (P1.9): next runnable job in a queue.
CREATE INDEX jobs_runnable_idx ON jobs (queue, run_at) WHERE status = 'queued';

CREATE TABLE job_attempts (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  job_id      uuid NOT NULL,
  attempt_no  integer NOT NULL,
  worker_id   text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome     text CHECK (outcome IN ('succeeded', 'failed')),
  error       text,
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs (tenant_id, id),
  UNIQUE (job_id, attempt_no)
);

CREATE TABLE dead_letters (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  job_id     uuid NOT NULL UNIQUE,
  type       text NOT NULL,
  payload    jsonb NOT NULL,
  attempts   integer NOT NULL,
  last_error text,
  dead_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs (tenant_id, id)
);
CREATE INDEX dead_letters_tenant_id_idx ON dead_letters (tenant_id, dead_at);

-- Least-privilege grants for the application role. Nothing is granted on usage_events partitions
-- directly: access goes through the parent table only.
-- Not granted on purpose: UPDATE/DELETE on credit_ledger, usage_events and dead_letters, and any
-- write on tenants/users (those go through SECURITY DEFINER functions in 0002).
GRANT USAGE ON SCHEMA public TO ledgerline_app;
GRANT SELECT                         ON tenants         TO ledgerline_app;
GRANT SELECT                         ON users           TO ledgerline_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships     TO ledgerline_app;
GRANT SELECT, INSERT, UPDATE         ON api_keys        TO ledgerline_app;
GRANT SELECT, INSERT                 ON usage_events    TO ledgerline_app;
GRANT SELECT, INSERT                 ON credit_ledger   TO ledgerline_app;
GRANT SELECT, INSERT, UPDATE         ON credit_balances TO ledgerline_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON jobs            TO ledgerline_app;
GRANT SELECT, INSERT, UPDATE         ON job_attempts    TO ledgerline_app;
GRANT SELECT, INSERT                 ON dead_letters    TO ledgerline_app;
-- Explicit, on top of the trigger: the app role can never change or remove ledger rows.
REVOKE UPDATE, DELETE, TRUNCATE ON credit_ledger FROM ledgerline_app;
-- Identity sequences are used when the app inserts ledger, attempt and dead-letter rows.
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ledgerline_app;
