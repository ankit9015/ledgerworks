-- 0004: job queue (P1.9). Runs as ledgerline_owner.
--
-- Delivery semantics: AT-LEAST-ONCE with at most one LIVE lease per job. A job is claimed with
-- FOR UPDATE SKIP LOCKED and leased for a fixed time. If the worker never reports back, the job
-- becomes claimable again after the lease expires, so a handler can run more than once (a crash
-- after the side effect but before the acknowledgement). Completion and failure are fenced by the
-- attempt number, so a stale worker cannot overwrite a newer attempt. NOT exactly-once.
--
-- Job states: queued (waiting), running (leased), failed (last attempt failed, retry scheduled at
-- run_at), succeeded, dead (retries exhausted; a dead_letters row exists).
--
-- All time comes in as parameters (p_now) so tests can drive a fake clock.

ALTER TABLE jobs ADD COLUMN lease_expires_at timestamptz;

-- ---------------------------------------------------------------------------------------------
-- Worker role: it may do exactly one thing, call claim_jobs. It has no table privileges.
-- ---------------------------------------------------------------------------------------------
GRANT USAGE ON SCHEMA ledgerline_fn TO ledgerline_worker;

-- ---------------------------------------------------------------------------------------------
-- Privileges for the claim function's owner (ledgerline_definer), and its permissive policies on
-- exactly these three tables. Without BYPASSRLS, it can touch nothing else.
-- ---------------------------------------------------------------------------------------------
GRANT SELECT, UPDATE         ON jobs         TO ledgerline_definer;
GRANT SELECT, INSERT, UPDATE ON job_attempts TO ledgerline_definer;
GRANT INSERT                 ON dead_letters TO ledgerline_definer;
CREATE POLICY definer_access ON jobs         FOR ALL TO ledgerline_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_access ON job_attempts FOR ALL TO ledgerline_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_access ON dead_letters FOR ALL TO ledgerline_definer USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------------------------
-- enqueue_job (invoker: runs as the app role in the caller's tenant transaction).
-- The idempotency key is unique per tenant; the same key returns the existing job (the payload of
-- the first call wins) with created = false.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION ledgerline_fn.enqueue_job(
  p_type text,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_key text DEFAULT NULL,
  p_queue text DEFAULT 'default',
  p_max_attempts integer DEFAULT 5,
  p_run_at timestamptz DEFAULT NULL,
  p_now timestamptz DEFAULT now())
RETURNS TABLE (job_id uuid, created boolean)
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := public.app_tenant_id();
  v_id uuid;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no tenant set for this transaction' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.jobs (tenant_id, queue, type, payload, max_attempts, run_at, idempotency_key,
                           created_at, updated_at)
  VALUES (v_tenant, p_queue, p_type, p_payload, p_max_attempts, COALESCE(p_run_at, p_now),
          p_key, p_now, p_now)
  ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, true;
  ELSE
    SELECT j.id INTO v_id FROM public.jobs j
    WHERE j.tenant_id = v_tenant AND j.idempotency_key = p_key;
    RETURN QUERY SELECT v_id, false;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- claim_jobs (SECURITY DEFINER, executable only by ledgerline_worker). Claims across tenants:
-- the one place the queue must see every tenant's rows. It returns the tenant id so the caller
-- can open a tenant-scoped transaction for the handler's own database work.
--   1. jobs whose lease expired with all attempts used are dead-lettered, not claimed again;
--   2. up to p_limit runnable jobs are locked with FOR UPDATE SKIP LOCKED: queued or failed with
--      run_at <= p_now, or running with an expired lease;
--   3. the previous attempt of a re-claimed job is closed as failed ('lease expired');
--   4. the jobs become running with a new lease and a new job_attempts row is written.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION ledgerline_fn.claim_jobs(
  p_worker text, p_queue text, p_limit integer, p_lease_ms bigint, p_now timestamptz)
RETURNS TABLE (job_id uuid, tenant_id uuid, type text, payload jsonb,
               attempt_no integer, max_attempts integer, lease_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_ids uuid[];
BEGIN
  WITH exhausted AS (
    SELECT j.id FROM public.jobs j
    WHERE j.queue = p_queue AND j.status = 'running'
      AND j.lease_expires_at <= p_now AND j.attempts >= j.max_attempts
    FOR UPDATE SKIP LOCKED),
  closed AS (
    UPDATE public.job_attempts a
    SET finished_at = p_now, outcome = 'failed', error = 'lease expired'
    FROM exhausted e WHERE a.job_id = e.id AND a.finished_at IS NULL
    RETURNING a.job_id),
  dead AS (
    UPDATE public.jobs j
    SET status = 'dead', last_error = 'lease expired after the last attempt',
        locked_by = NULL, lease_expires_at = NULL, updated_at = p_now
    FROM exhausted e WHERE j.id = e.id
    RETURNING j.id, j.tenant_id, j.type, j.payload, j.attempts)
  INSERT INTO public.dead_letters (tenant_id, job_id, type, payload, attempts, last_error, dead_at)
  SELECT d.tenant_id, d.id, d.type, d.payload, d.attempts,
         'lease expired after the last attempt', p_now
  FROM dead d;

  SELECT array_agg(s.id) INTO v_ids FROM (
    SELECT j.id FROM public.jobs j
    WHERE j.queue = p_queue
      AND ((j.status IN ('queued', 'failed') AND j.run_at <= p_now)
        OR (j.status = 'running' AND j.lease_expires_at <= p_now AND j.attempts < j.max_attempts))
    ORDER BY j.run_at, j.id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED) s;
  IF v_ids IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.job_attempts a
  SET finished_at = p_now, outcome = 'failed', error = 'lease expired'
  WHERE a.job_id = ANY (v_ids) AND a.finished_at IS NULL;

  RETURN QUERY
  WITH upd AS (
    UPDATE public.jobs j
    SET status = 'running', attempts = j.attempts + 1, locked_by = p_worker, locked_at = p_now,
        lease_expires_at = p_now + p_lease_ms * interval '1 millisecond', updated_at = p_now
    WHERE j.id = ANY (v_ids)
    RETURNING j.id, j.tenant_id, j.type, j.payload, j.attempts, j.max_attempts, j.lease_expires_at),
  ins AS (
    INSERT INTO public.job_attempts (tenant_id, job_id, attempt_no, worker_id, started_at)
    SELECT u.tenant_id, u.id, u.attempts, p_worker, p_now FROM upd u)
  SELECT u.id, u.tenant_id, u.type, u.payload, u.attempts, u.max_attempts, u.lease_expires_at
  FROM upd u;
END $$;

-- ---------------------------------------------------------------------------------------------
-- complete_job / fail_job (invoker: run in the job's tenant transaction, so RLS applies).
-- Both are fenced: they only act if the job is still running, leased to this worker, at this
-- attempt number. A stale worker (lease expired and job re-claimed) gets false / 'stale'.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION ledgerline_fn.complete_job(
  p_job_id uuid, p_worker text, p_attempt integer, p_now timestamptz)
RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.jobs j
  SET status = 'succeeded', completed_at = p_now, updated_at = p_now,
      locked_by = NULL, lease_expires_at = NULL, last_error = NULL
  WHERE j.id = p_job_id AND j.tenant_id = public.app_tenant_id()
    AND j.status = 'running' AND j.locked_by = p_worker AND j.attempts = p_attempt;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE public.job_attempts a
  SET finished_at = p_now, outcome = 'succeeded'
  WHERE a.job_id = p_job_id AND a.attempt_no = p_attempt;
  RETURN true;
END $$;

-- Returns 'retry_scheduled', 'dead' (retries exhausted: dead_letters row written in the same
-- transaction) or 'stale'. p_retry_delay_ms is the backoff chosen by the caller.
CREATE FUNCTION ledgerline_fn.fail_job(
  p_job_id uuid, p_worker text, p_attempt integer, p_error text,
  p_retry_delay_ms bigint, p_now timestamptz)
RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_job public.jobs%ROWTYPE;
  v_error text := left(COALESCE(p_error, 'unknown error'), 2000);
BEGIN
  SELECT * INTO v_job FROM public.jobs j
  WHERE j.id = p_job_id AND j.tenant_id = public.app_tenant_id()
    AND j.status = 'running' AND j.locked_by = p_worker AND j.attempts = p_attempt
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'stale';
  END IF;
  UPDATE public.job_attempts a
  SET finished_at = p_now, outcome = 'failed', error = v_error
  WHERE a.job_id = p_job_id AND a.attempt_no = p_attempt;

  IF v_job.attempts >= v_job.max_attempts THEN
    UPDATE public.jobs j
    SET status = 'dead', last_error = v_error, locked_by = NULL, lease_expires_at = NULL,
        updated_at = p_now
    WHERE j.id = p_job_id;
    INSERT INTO public.dead_letters (tenant_id, job_id, type, payload, attempts, last_error, dead_at)
    VALUES (v_job.tenant_id, v_job.id, v_job.type, v_job.payload, v_job.attempts, v_error, p_now);
    RETURN 'dead';
  END IF;
  UPDATE public.jobs j
  SET status = 'failed', last_error = v_error, locked_by = NULL, lease_expires_at = NULL,
      run_at = p_now + p_retry_delay_ms * interval '1 millisecond', updated_at = p_now
  WHERE j.id = p_job_id;
  RETURN 'retry_scheduled';
END $$;

-- Ownership and execute privileges.
ALTER FUNCTION ledgerline_fn.claim_jobs(text, text, integer, bigint, timestamptz)
  OWNER TO ledgerline_definer;

REVOKE EXECUTE ON FUNCTION ledgerline_fn.claim_jobs(text, text, integer, bigint, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ledgerline_fn.enqueue_job(text, jsonb, text, text, integer, timestamptz, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ledgerline_fn.complete_job(uuid, text, integer, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ledgerline_fn.fail_job(uuid, text, integer, text, bigint, timestamptz) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION ledgerline_fn.claim_jobs(text, text, integer, bigint, timestamptz) TO ledgerline_worker;
GRANT EXECUTE ON FUNCTION ledgerline_fn.enqueue_job(text, jsonb, text, text, integer, timestamptz, timestamptz) TO ledgerline_app;
GRANT EXECUTE ON FUNCTION ledgerline_fn.complete_job(uuid, text, integer, timestamptz) TO ledgerline_app;
GRANT EXECUTE ON FUNCTION ledgerline_fn.fail_job(uuid, text, integer, text, bigint, timestamptz) TO ledgerline_app;
