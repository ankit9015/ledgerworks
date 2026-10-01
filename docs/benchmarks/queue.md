# Queue throughput (P1.9)

Measured on the unmodified queue implementation (migration 0004 and `ledgerline/src/queue/`), with **no tuning**: no new indexes, no query changes, no configuration changes. All data is **synthetic**: no-op jobs spread over 5 synthetic tenants. The point is an honest "before" for P1.10.

## Result

|                                   |                                                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Jobs per run                      | 10,000 (all enqueued before the workers start)                                                                 |
| Workers                           | 50 concurrent workers (independent async loops, each claims one job at a time)                                 |
| Handler                           | no-op (does nothing, no database work); each job is still claimed, acknowledged and recorded in `job_attempts` |
| Runs                              | 3, each on a freshly created and migrated database (no dead tuples carried over)                               |
| Throughput                        | run 1: **85.6** jobs/s (116.87 s); run 2: **72.1** jobs/s (138.61 s); run 3: **77.1** jobs/s (129.65 s)        |
| **Median / range**                | **77.1 jobs/s** (72.1 to 85.6)                                                                                 |
| Correctness check after every run | all 10,000 jobs `succeeded`, max attempts = 1                                                                  |

Raw output: `raw/queue-throughput.txt` (includes the query plan below). Reproduce with `pnpm --filter @ledgerworks/ledgerline bench:queue`.

## Environment

|                      |                                                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Date                 | 2026-10-01 (UTC)                                                                                                                                                                                                 |
| Machine              | Intel Core i5-1135G7 (4 cores / 8 threads), 19.8 GB RAM, NVMe SSD, Windows 11 Home                                                                                                                               |
| Postgres             | 16.15 in Docker Desktop (VM: 8 CPUs, 9.6 GiB); container limits **2 CPUs / 2 GiB memory, no swap** (docker-compose.yml)                                                                                          |
| Postgres settings    | `shared_buffers` 512 MB, `effective_cache_size` 1536 MB, `work_mem` 16 MB, `max_connections` 100, `synchronous_commit` on, autovacuum on                                                                         |
| Client               | Node 22.13.1 on the host (workers and Postgres share the same laptop), two connection pools of up to 30 connections each (one as `ledgerline_worker` for claiming, one as `ledgerline_app` for acknowledgements) |
| Nothing else running | no API server, no k6 during these runs                                                                                                                                                                           |
| Indexes on `jobs`    | only those from migration 0001: primary key, `(tenant_id, id)`, `(tenant_id, idempotency_key)` partial unique, `(queue, run_at) WHERE status = 'queued'`                                                         |

## Why it is slow (diagnosed, not fixed)

The pick step of `claim_jobs`, planned against the full queue of 10,000 queued jobs (`EXPLAIN (ANALYZE, BUFFERS)`, rolled back, from run 1):

```
Limit  (cost=532.00..532.01 rows=1 width=30) (actual time=5.645..5.646 rows=1 loops=1)
  ->  LockRows
        ->  Sort  (cost=532.00..557.00 rows=10000 width=30) (actual time=5.630..5.631 rows=1 loops=1)
              Sort Key: run_at, id
              Sort Method: quicksort  Memory: 931kB
              ->  Seq Scan on jobs j  (actual time=0.007..2.291 rows=10000 loops=1)
                    Filter: ((queue = 'bench'::text) AND (((status = ANY ('{queued,failed}'::text[])) AND (run_at <= now())) OR ((status = 'running'::text) AND (lease_expires_at <= now()) AND (attempts < max_attempts))))
Execution Time: 5.670 ms
```

Every claim scans and sorts every runnable row to return one. The only queue index is partial on `status = 'queued'`, which the query's `OR` (needed so that `failed` retries and expired leases are claimable) cannot use. That is about 5.7 ms of CPU per claim at the start of a run, on a 2-CPU container shared by 50 workers, so throughput is bounded by that cost, and it falls as the queue grows. This is recorded as observation O6 in `../optimization-log.md`.

## Limitations

- One laptop; the workers and Postgres compete for CPU. Valid as a before/after comparison on this machine only.
- A no-op handler: real handlers would add their own work and database round trips.
- One claim per call (`limit = 1`); batch claiming was not measured.
- Three runs show the spread (about 17% between best and worst) but are not a confidence interval.
