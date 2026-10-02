-- 0006: make the job claim index-friendly (P1.10, O6 / E3). Runs as ledgerline_owner.
--
-- Before: both scans in claim_jobs were sequential scans of the whole jobs table (the only queue
-- index was partial on status = 'queued' and the query's OR could not use it), and the pick also
-- sorted every runnable row to return one.
--
-- Two small partial indexes cover only non-terminal rows (succeeded and dead jobs are in neither):
--   jobs_claim_idx  (queue, run_at, id) for the pick: an ordered index scan, no sort, which stops
--                   after p_limit rows;
--   jobs_lease_idx  (queue, lease_expires_at) for the lease-expiry check: only running rows.
--
-- The pick keeps its exact semantics and ordering (run_at, id; FOR UPDATE SKIP LOCKED). The
-- condition is only restated so the planner can prove the partial-index predicate (it cannot for
-- an OR of different status tests) and use run_at as an index range:
--   * `status IN ('queued','failed','running')` is the index predicate, spelled as one conjunct;
--   * `run_at <= p_now` is added for running jobs too. It is implied for them: a job only becomes
--     running through claim_jobs, which requires run_at <= the claim time, and a lease expires
--     after the claim time, so run_at <= lease_expires_at <= p_now whenever the lease is expired.
-- The rest of the function is unchanged from 0004.

CREATE INDEX jobs_claim_idx ON jobs (queue, run_at, id)
  WHERE status IN ('queued', 'failed', 'running');
CREATE INDEX jobs_lease_idx ON jobs (queue, lease_expires_at)
  WHERE status = 'running';

CREATE OR REPLACE FUNCTION ledgerline_fn.claim_jobs(
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
      AND j.run_at <= p_now
      AND j.status IN ('queued', 'failed', 'running')
      AND (j.status <> 'running' OR (j.lease_expires_at <= p_now AND j.attempts < j.max_attempts))
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
