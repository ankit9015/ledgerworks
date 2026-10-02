-- O6: both statements of claim_jobs that scan the jobs table, planned against 10,000 queued jobs
-- of one queue (as the superuser on a scratch database; the same plans the bench prints).
BEGIN;
EXPLAIN (ANALYZE, BUFFERS)
SELECT j.id FROM jobs j
WHERE j.queue = 'bench'
  AND ((j.status IN ('queued', 'failed') AND j.run_at <= now())
    OR (j.status = 'running' AND j.lease_expires_at <= now() AND j.attempts < j.max_attempts))
ORDER BY j.run_at, j.id LIMIT 1 FOR UPDATE SKIP LOCKED;
EXPLAIN (ANALYZE, BUFFERS)
SELECT j.id FROM jobs j
WHERE j.queue = 'bench' AND j.status = 'running'
  AND j.lease_expires_at <= now() AND j.attempts >= j.max_attempts
FOR UPDATE SKIP LOCKED;
ROLLBACK;
