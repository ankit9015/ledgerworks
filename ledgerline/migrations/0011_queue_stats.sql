-- 0011: cross-tenant queue statistics for the metrics endpoint (P1.12). Runs as ledgerline_owner.
--
-- The /metrics server needs queue depth and the age of the oldest queued job across ALL tenants,
-- which RLS forbids to the app role. Like claim_jobs, this is one narrow SECURITY DEFINER function
-- owned by ledgerline_definer (no BYPASSRLS, SELECT on jobs behind its own policy) and executable
-- only by the read-only ledgerline_metrics login. It returns aggregates only: no tenant id, no job
-- id, no payload, no error text.
--   jobs                  rows in that state
--   oldest_runnable_at    earliest run_at among jobs waiting to run (queued or failed), else NULL
--   retried_attempts      attempts beyond the first, summed (cumulative: jobs are never deleted)
GRANT USAGE ON SCHEMA ledgerline_fn TO ledgerline_metrics;

CREATE FUNCTION ledgerline_fn.queue_stats()
RETURNS TABLE (queue text, status text, jobs bigint, oldest_runnable_at timestamptz,
               retried_attempts bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT j.queue, j.status, count(*),
         min(j.run_at) FILTER (WHERE j.status IN ('queued', 'failed')),
         COALESCE(sum(GREATEST(j.attempts - 1, 0)), 0)::bigint
  FROM public.jobs j
  GROUP BY j.queue, j.status
$$;

ALTER FUNCTION ledgerline_fn.queue_stats() OWNER TO ledgerline_definer;
REVOKE EXECUTE ON FUNCTION ledgerline_fn.queue_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledgerline_fn.queue_stats() TO ledgerline_metrics;
