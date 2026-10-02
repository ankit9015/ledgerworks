-- 0010: drop jobs_runnable_idx (P1.12 cleanup b). Runs as ledgerline_owner.
--
-- (queue, run_at) WHERE status = 'queued' from 0001 was meant for the worker poll, but claim_jobs
-- never used it (O6) and since 0006 its predicate is covered by jobs_claim_idx. A mixed queue
-- workload (successes, retries, dead letters, expired leases, idempotent enqueues) recorded 0 scans
-- of it, and no statement the job functions run uses it (docs/benchmarks/raw/job-index-usage-b.txt).
DROP INDEX jobs_runnable_idx;
