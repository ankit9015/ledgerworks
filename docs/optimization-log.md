# Optimization log

One entry per performance win. Every entry must contain all of the following, with real output pasted from a real run (never estimated):

1. **Slow query**: the exact SQL and the endpoint or code path it serves.
2. **`EXPLAIN (ANALYZE, BUFFERS)` before**: full plan output.
3. **Change**: the index, schema change or query rewrite, as the exact SQL or diff.
4. **`EXPLAIN (ANALYZE, BUFFERS)` after**: full plan output.
5. **Measured latency before and after**: with the number of runs and how they were taken.
6. **Seed size**: rows per relevant table, plus the Postgres version and container CPU/memory limits (see `docker-compose.yml`). Label synthetic data as synthetic.

## Environment (applies to every entry)

- **Data (synthetic):** the 10,000,000-row `usage_events` seed (seed value 20251001, 250 tenants, Zipf-skewed; huge = rank 1 with 2,541,285 events, small = rank 100 with 10,118 events), re-seeded after Step 0 with identical fingerprints (`raw/seed-run4-after-0005.txt`). Details: `benchmarks/seed.md`.
- **Postgres 16.15** in Docker Desktop, container limited to **2 CPUs / 2 GiB**, `shared_buffers` 512 MB, `work_mem` 16 MB, `random_page_cost` 4, default autovacuum (see `docker-compose.yml`, `raw/environment-p1.10.txt`).
- **Machine:** Intel Core i5-1135G7 laptop (4 cores / 8 threads), Windows 11; k6 (v2.3.0, Docker), the API (host `tsx`, pool size 10) and Postgres share it, so run-to-run noise is real: **15 to 25 percent** on this machine. A change is only called an improvement here when it is clearly larger than the spread of the runs.
- **Method for "before" and "after" through the API:** the unchanged k6 scripts and profile of `benchmarks/baseline.md` (30 s warmup, 60 s measured, constant arrival rate; `usage-read` 2 iterations/s, `balance` and `ingest` 100 req/s), the same preflight (exactly 10,000,000 rows, no autovacuum running, `pg_stat_statements` reset), **3 runs per set**, medians with min – max, via `ledgerline/k6/bench3.sh` and `ledgerline/k6/stats.mjs`. The API process is restarted for each set. A "before" is the state of the code and schema immediately before the change in this log (the "after" of the previous entry, re-measured when the scenario was not covered).
- **EXPLAIN method:** `docs/benchmarks/sql/explain.sh` runs a `.sql` file as `ledgerline_app` with the tenant set (so RLS applies exactly as in the API), inside a rolled-back transaction, warm cache.

## Entries

### E1. `GET /v1/usage`: ORDER BY resolved to the output alias (application bug, not an indexing win)

- **Observation:** O1 (below).
- **Kind of change:** **a bug fix in the application query.** No index was added, changed or dropped; the existing `(tenant_id, occurred_at)` indexes were already enough. The query said `ORDER BY occurred_at DESC, id DESC` while also selecting `to_char(occurred_at ...) AS occurred_at`; in Postgres a bare name in `ORDER BY` matches an output column before an input column ("alias shadowing"), so it sorted by the formatted text and the planner could not walk the index backwards and stop after 51 rows.
- **Slow query** (`ledgerline/src/routes/usage.ts`, `GET /v1/usage`; huge tenant = rank 1, 2,541,285 events; a 7-day window, page 1, limit 50 + 1; SQL in `docs/benchmarks/sql/usage-read-p1-alias.sql`):

  ```sql
  SELECT id, event_type, quantity,
         to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at, metadata
  FROM usage_events
  WHERE tenant_id = :TENANT AND occurred_at >= '2026-08-24T00:00:00Z' AND occurred_at < '2026-08-31T00:00:00Z'
  ORDER BY occurred_at DESC, id DESC
  LIMIT 51
  ```

- **`EXPLAIN (ANALYZE, BUFFERS)` before** (as `ledgerline_app` with the tenant set, so RLS applies; three warm executions took 112.4, 93.4 and 123.8 ms, plan of the last one; raw: `raw/explain-o1-before.txt`). It reads and sorts 64,435 rows (4,946 buffers) to return 51:

```
Limit  (cost=23678.97..23679.10 rows=51 width=93) (actual time=123.697..123.705 rows=51 loops=1)
  Buffers: shared hit=4946
  InitPlan 1 (returns $0)
    ->  Result  (cost=0.00..0.26 rows=1 width=16) (actual time=0.220..0.221 rows=1 loops=1)
          Buffers: shared hit=6
  ->  Sort  (cost=23678.71..23836.53 rows=63127 width=93) (actual time=123.695..123.699 rows=51 loops=1)
        Sort Key: (to_char((usage_events.occurred_at AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'::text)) DESC, usage_events.id DESC
        Sort Method: top-N heapsort  Memory: 36kB
        Buffers: shared hit=4946
        ->  Result  (cost=2469.30..21572.66 rows=63127 width=93) (actual time=6.517..91.961 rows=64435 loops=1)
              One-Time Filter: ($0 = '8641a01e-babb-4e44-d36d-f68e5233c7fb'::uuid)
              Buffers: shared hit=4940
              ->  Bitmap Heap Scan on usage_events_2026_08 usage_events  (cost=2469.30..21257.02 rows=63127 width=69) (actual time=6.200..38.696 rows=64435 loops=1)
                    Recheck Cond: ((tenant_id = '8641a01e-babb-4e44-d36d-f68e5233c7fb'::uuid) AND (occurred_at >= '2026-08-24 00:00:00+00'::timestamp with time zone) AND (occurred_at < '2026-08-31 00:00:00+00'::timestamp with time zone))
                    Heap Blocks: exact=4494
                    Buffers: shared hit=4934
                    ->  Bitmap Index Scan on usage_events_2026_08_tenant_id_occurred_at_idx  (cost=0.00..2453.51 rows=63127 width=0) (actual time=5.560..5.561 rows=64435 loops=1)
                          Index Cond: ((tenant_id = '8641a01e-babb-4e44-d36d-f68e5233c7fb'::uuid) AND (occurred_at >= '2026-08-24 00:00:00+00'::timestamp with time zone) AND (occurred_at < '2026-08-31 00:00:00+00'::timestamp with time zone))
                          Buffers: shared hit=440
Planning:
  Buffers: shared hit=435
Planning Time: 1.463 ms
Execution Time: 123.822 ms
```

- **Change:** `ORDER BY usage_events.occurred_at DESC, usage_events.id DESC` (table-qualified, so the input column is used). Nothing else.
- **`EXPLAIN (ANALYZE, BUFFERS)` after** (three warm executions: 1.4, 0.7 and 0.6 ms; raw: `raw/explain-o1-after.txt`). An index scan backward feeds an incremental sort, and 52 rows are read (70 buffers):

```
Limit  (cost=1.87..64.05 rows=51 width=101) (actual time=0.502..0.572 rows=51 loops=1)
  Buffers: shared hit=70
  InitPlan 1 (returns $0)
    ->  Result  (cost=0.00..0.26 rows=1 width=16) (actual time=0.220..0.220 rows=1 loops=1)
          Buffers: shared hit=6
  ->  Incremental Sort  (cost=1.61..76960.73 rows=63127 width=101) (actual time=0.500..0.565 rows=51 loops=1)
        Sort Key: usage_events.occurred_at DESC, usage_events.id DESC
        Presorted Key: usage_events.occurred_at
        Full-sort Groups: 2  Sort Method: quicksort  Average Memory: 29kB  Peak Memory: 29kB
        Buffers: shared hit=70
        ->  Result  (cost=0.43..74120.01 rows=63127 width=101) (actual time=0.346..0.494 rows=52 loops=1)
              One-Time Filter: ($0 = '8641a01e-babb-4e44-d36d-f68e5233c7fb'::uuid)
              Buffers: shared hit=61
              ->  Index Scan Backward using usage_events_2026_08_tenant_id_occurred_at_idx on usage_events_2026_08 usage_events  (cost=0.43..73804.38 rows=63127 width=69) (actual time=0.038..0.128 rows=52 loops=1)
                    Index Cond: ((tenant_id = '8641a01e-babb-4e44-d36d-f68e5233c7fb'::uuid) AND (occurred_at >= '2026-08-24 00:00:00+00'::timestamp with time zone) AND (occurred_at < '2026-08-31 00:00:00+00'::timestamp with time zone))
                    Buffers: shared hit=55
Planning:
  Buffers: shared hit=425
Planning Time: 1.381 ms
Execution Time: 0.631 ms
```

- **Measured through the API** (k6 `usage-read`, 2 iterations/s, 30 s warmup + 60 s measured, huge and small tenant, **3 runs each, run order interleaved**, same preflight and profile as the baseline; API restarted between the two sets; median with min – max over the 3 runs; raw: `raw/usage-read_*_runo1before{1,2,3}.*` and `..._runo1after{1,2,3}.*`):

  | Scenario           |           | p50                       | p95                       | p99                       |
  | ------------------ | --------- | ------------------------- | ------------------------- | ------------------------- |
  | usage-read / huge  | before    | 91.6 ms (90.9 – 96.3)     | 145.5 ms (139.2 – 151.1)  | 164.9 ms (155.0 – 175.6)  |
  | usage-read / huge  | **after** | **14.9 ms (14.5 – 15.0)** | **24.3 ms (22.1 – 28.7)** | **30.5 ms (29.2 – 32.9)** |
  | usage-read / small | before    | 14.1 ms (13.9 – 14.9)     | 18.1 ms (17.7 – 19.2)     | 21.9 ms (19.5 – 26.8)     |
  | usage-read / small | after     | 14.3 ms (14.1 – 14.5)     | 17.1 ms (17.0 – 17.5)     | 19.3 ms (18.2 – 20.1)     |

  The huge-tenant p95 fell by about 83% (145.5 to 24.3 ms), far outside the run-to-run spread (the ranges do not overlap). The small tenant did not change (18.1 to 17.1 ms is inside the spread, so no claim). `pg_stat_statements` for the usage query, run 1 of each set, includes warmup: mean 80.1 ms (page-1 shape) and 137.3 ms (cursor shape) before, 1.6 ms and 5.7 ms after. After the fix the huge and small tenants cost the same through the API (about 14 to 15 ms p50, most of it the fixed per-request cost, see O3).

- **Write and storage cost:** none (no schema change).
- **Seed and environment:** see "Environment" above.
- **What was learned:** the original "huge tenants are slow" finding was not an indexing problem at all. A one-word application bug made the existing index unusable. Only `EXPLAIN` could show that; adding an index would have changed nothing.

### E2. Usage-read access pattern: checked, **no index change needed** (negative result)

- **Observation:** new (candidate 2 of P1.10: "do the existing indexes serve tenant + date range, ordered by time, paginated?").
- **Question and method:** after E1, is anything left in the database for this query? `EXPLAIN (ANALYZE, BUFFERS)` of the four shapes the API produces, as `ledgerline_app` with RLS, huge tenant (the worst case), warm cache, three executions each (SQL in `docs/benchmarks/sql/usage-read-*.sql`, raw in `raw/explain-item2-*.txt`):

  | Shape                                                                                       | Execution time (3 runs) | Buffers                                       | Plan                                                                                                                                  |
  | ------------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
  | page 1, 7 days inside one partition (E1 "after")                                            | 1.4, 0.7, 0.6 ms        | 70                                            | Index Scan Backward on `(tenant_id, occurred_at)` + Incremental Sort                                                                  |
  | page 3, keyset cursor, same window                                                          | 0.51, 0.50, 0.49 ms     | 73                                            | same; the planner derives `occurred_at <= cursor` as an extra index condition, the row comparison stays as a `Filter` (1 row removed) |
  | page 1, window across a month boundary (2 partitions)                                       | 0.45, 0.47, 0.46 ms     | 72                                            | ordered `Append` of two backward index scans; the older partition is "never executed"                                                 |
  | page 3 (cursor), across a month boundary                                                    | 0.53, 0.59, 0.54 ms     | 71                                            | same                                                                                                                                  |
  | page 1 with the unindexed `eventType` filter (rarest type, 5% of the tenant, 30-day window) | 1.8, 1.7, 2.9 ms        | 433 (last run; 1,256 on the first, cold, run) | same index; the filter is applied to heap rows (1,172 removed) until 51 match                                                         |

  Page 3 of the cross-partition window, the most complex shape (full plan of the last run):

```
Limit  (cost=5.13..211.43 rows=51 width=101) (actual time=0.396..0.460 rows=51 loops=1)
  Buffers: shared hit=71
  InitPlan 1 (returns $0)
    ->  Result  (cost=0.00..0.26 rows=1 width=16) (actual time=0.180..0.180 rows=1 loops=1)
          Buffers: shared hit=6
  ->  Incremental Sort  (cost=4.87..141828.87 rows=35060 width=101) (actual time=0.395..0.456 rows=51 loops=1)
        Sort Key: usage_events.occurred_at DESC, usage_events.id DESC
        Presorted Key: usage_events.occurred_at
        Full-sort Groups: 2  Sort Method: quicksort  Average Memory: 29kB  Peak Memory: 29kB
        Buffers: shared hit=71
        ->  Append  (cost=0.85..140251.17 rows=35060 width=101) (actual time=0.277..0.408 rows=52 loops=1)
              Buffers: shared hit=62
              ->  Result  (cost=0.43..71747.76 rows=3765 width=101) (actual time=0.276..0.403 rows=52 loops=1)
                    One-Time Filter: ($0 = '8641a01e-babb-4e44-d36d-f68e5233c7fb'::uuid)
                    Buffers: shared hit=62
                    ->  Index Scan Backward using usage_events_2026_09_tenant_id_occurred_at_idx on usage_events_2026_09 usage_events_2  (cost=0.43..71728.93 rows=3765 width=69) (actual time=0.028..0.113 rows=52 loops=1)
                          Index Cond: ((tenant_id = '8641a01e-babb-4e44-d36d-f68e5233c7fb'::uuid) AND (occurred_at >= '2026-08-28 00:00:00+00'::timestamp with time zone) AND (occurred_at < '2026-09-04 00:00:00+00'::timestamp with time zone) AND (occurred_at <= '2026-09-03 23:33:20.284944+00'::timestamp with time zone))
                          Filter: (ROW(occurred_at, id) < ROW('2026-09-03 23:33:20.284944+00'::timestamp with time zone, '64ed2919-bf67-ddf6-e216-2f6182e5a0a5'::uuid))
                          Rows Removed by Filter: 1
                          Buffers: shared hit=56
              ->  Result  (cost=0.43..68328.11 rows=31295 width=101) (never executed)
                    One-Time Filter: ($0 = '8641a01e-babb-4e44-d36d-f68e5233c7fb'::uuid)
                    ->  Index Scan Backward using usage_events_2026_08_tenant_id_occurred_at_idx on usage_events_2026_08 usage_events_1  (cost=0.43..68171.64 rows=31295 width=69) (never executed)
                          Index Cond: ((tenant_id = '8641a01e-babb-4e44-d36d-f68e5233c7fb'::uuid) AND (occurred_at >= '2026-08-28 00:00:00+00'::timestamp with time zone) AND (occurred_at < '2026-09-04 00:00:00+00'::timestamp with time zone) AND (occurred_at <= '2026-09-03 23:33:20.284944+00'::timestamp with time zone))
                          Filter: (ROW(occurred_at, id) < ROW('2026-09-03 23:33:20.284944+00'::timestamp with time zone, '64ed2919-bf67-ddf6-e216-2f6182e5a0a5'::uuid))
Planning:
  Buffers: shared hit=486
Planning Time: 1.622 ms
Execution Time: 0.539 ms
```

- **Findings:**
  1. The API already uses **keyset pagination** (`(occurred_at, id) < (cursor)`), not OFFSET (D16). Later pages cost the same as the first (73 against 70 buffers), which is the property OFFSET lacks. There was nothing to replace.
  2. Partition pruning and ordered Append work for windows that span two months: the older partition is not even touched when the newer one already supplies the 51 rows.
  3. Every shape is under 3 ms inside Postgres. After E1 the API's p50 for this endpoint is about 15 ms, so what remains is not the query but the fixed per-request cost (see O3 and E5).
- **Decision:** **no index added, nothing changed.** A covering or `(tenant_id, occurred_at DESC, id DESC)` index would remove the 51-row incremental sort, which costs microseconds, at the price of a second index on every partition (more write cost and storage for no measurable gain). Not built, so there is no ingest or size cost to report.
- **What was learned:** the index decided in D13 (`(tenant_id, occurred_at)` per partition) is the right one for this pattern; the earlier slowness was entirely E1. The `eventType` filter is not indexed on purpose (D13) and is fast enough here only because the filter is applied while walking the time order; a very rare type in a very large window could scan far more rows, and was not measured at that extreme.

### E3. Job claim: two partial indexes and a provable predicate (queue throughput about 3.9x)

- **Observation:** O6 (below).
- **Slow query:** the two statements of `ledgerline_fn.claim_jobs` (migration 0004) that scan `jobs`, run on **every** claim: the pick (`... WHERE queue = $1 AND ((status IN ('queued','failed') AND run_at <= now) OR (status = 'running' AND lease_expires_at <= now AND attempts < max_attempts)) ORDER BY run_at, id LIMIT n FOR UPDATE SKIP LOCKED`) and the lease-expiry check that opens the function (`status = 'running' AND lease_expires_at <= now AND attempts >= max_attempts`). P1.9 only planned the first; the second is also a sequential scan and was added to the benchmark output here. SQL: `docs/benchmarks/sql/queue-claim-plans.sql`.
- **`EXPLAIN (ANALYZE, BUFFERS)` before** (10,000 queued synthetic jobs in one queue, fresh database; `raw/queue-throughput-o6-before.txt`). Pick: a sequential scan and a sort of all 10,000 rows to return 1 (9.263 ms in this run, 5.670 ms in the P1.9 run; the spread is the machine):

```
Limit  (cost=532.00..532.01 rows=1 width=30) (actual time=9.229..9.231 rows=1 loops=1)
  Buffers: shared hit=183
  ->  LockRows  (cost=532.00..657.00 rows=10000 width=30) (actual time=9.227..9.228 rows=1 loops=1)
        Buffers: shared hit=183
        ->  Sort  (cost=532.00..557.00 rows=10000 width=30) (actual time=9.204..9.205 rows=1 loops=1)
              Sort Key: run_at, id
              Sort Method: quicksort  Memory: 931kB
              Buffers: shared hit=182
              ->  Seq Scan on jobs j  (cost=0.00..482.00 rows=10000 width=30) (actual time=0.007..3.735 rows=10000 loops=1)
                    Filter: ((queue = 'bench'::text) AND (((status = ANY ('{queued,failed}'::text[])) AND (run_at <= now())) OR ((status = 'running'::text) AND (lease_expires_at <= now()) AND (attempts < max_attempts))))
                    Buffers: shared hit=182
Planning:
  Buffers: shared hit=67 read=1
Planning Time: 0.244 ms
Execution Time: 9.263 ms
```

Lease-expiry check: a sequential scan too (1.895 ms):

```
LockRows  (cost=0.00..407.01 rows=1 width=22) (actual time=1.868..1.869 rows=0 loops=1)
  Buffers: shared hit=182
  ->  Seq Scan on jobs j  (cost=0.00..407.00 rows=1 width=22) (actual time=1.867..1.868 rows=0 loops=1)
        Filter: ((attempts >= max_attempts) AND (queue = 'bench'::text) AND (status = 'running'::text) AND (lease_expires_at <= now()))
        Rows Removed by Filter: 10000
        Buffers: shared hit=182
Planning:
  Buffers: shared hit=1
Planning Time: 0.121 ms
Execution Time: 1.895 ms
```

- **Change** (migration `0006_claim_indexes.sql`; one logical change: make both scans indexable):

  ```sql
  CREATE INDEX jobs_claim_idx ON jobs (queue, run_at, id) WHERE status IN ('queued', 'failed', 'running');
  CREATE INDEX jobs_lease_idx ON jobs (queue, lease_expires_at) WHERE status = 'running';
  ```

  and the pick restated, same semantics and ordering, so that the planner can prove the partial-index predicate (it cannot for an `OR` of different status tests: the first attempt, the index alone with the old query, was **not used** by default: the planner still chose the sequential scan, and with `enable_seqscan = off` it only built an unordered BitmapOr that still sorted 6,950 rows; only the restated query gets the ordered index scan) and use `run_at` as an index range:

  ```sql
  WHERE j.queue = p_queue AND j.run_at <= p_now
    AND j.status IN ('queued', 'failed', 'running')
    AND (j.status <> 'running' OR (j.lease_expires_at <= p_now AND j.attempts < j.max_attempts))
  ORDER BY j.run_at, j.id LIMIT p_limit FOR UPDATE SKIP LOCKED
  ```

  Added `run_at <= p_now` for running jobs is implied (a job only becomes running through `claim_jobs`, which needs `run_at` <= the claim time, and a lease expires after that), so the rows claimed are the same; this invariant is recorded in the migration and in D22. `FOR UPDATE SKIP LOCKED`, the `LIMIT`, the ordering and everything after the pick are unchanged.

- **`EXPLAIN (ANALYZE, BUFFERS)` after** (same data; `raw/queue-throughput-o6-after.txt`). Pick, an ordered index scan with no sort, 4 buffers (0.043 ms):

```
Limit  (cost=0.29..0.41 rows=1 width=30) (actual time=0.023..0.023 rows=1 loops=1)
  Buffers: shared hit=4
  ->  LockRows  (cost=0.29..1180.35 rows=10000 width=30) (actual time=0.022..0.022 rows=1 loops=1)
        Buffers: shared hit=4
        ->  Index Scan using jobs_claim_idx on jobs j  (cost=0.29..1080.35 rows=10000 width=30) (actual time=0.015..0.016 rows=1 loops=1)
              Index Cond: ((queue = 'bench'::text) AND (run_at <= now()))
              Filter: ((status = ANY ('{queued,failed,running}'::text[])) AND ((status <> 'running'::text) OR ((lease_expires_at <= now()) AND (attempts < max_attempts))))
              Buffers: shared hit=3
Planning:
  Buffers: shared hit=83 read=2
Planning Time: 0.346 ms
Execution Time: 0.043 ms
```

Lease-expiry check (0.019 ms):

```
LockRows  (cost=0.13..5.91 rows=1 width=22) (actual time=0.004..0.004 rows=0 loops=1)
  Buffers: shared hit=2
  ->  Index Scan using jobs_lease_idx on jobs j  (cost=0.13..5.90 rows=1 width=22) (actual time=0.003..0.003 rows=0 loops=1)
        Index Cond: ((queue = 'bench'::text) AND (lease_expires_at <= now()))
        Filter: ((attempts >= max_attempts) AND (status = 'running'::text))
        Buffers: shared hit=2
Planning:
  Buffers: shared hit=2
Planning Time: 0.095 ms
Execution Time: 0.019 ms
```

- **Measured** (`pnpm --filter @ledgerworks/ledgerline bench:queue`, the P1.9 method: 10,000 no-op jobs, 50 workers, 3 runs, each on a freshly created and migrated database, nothing else running; before re-measured in the same session as the after):

  |                     | run 1                 | run 2                 | run 3                 | median (range)                   |
  | ------------------- | --------------------- | --------------------- | --------------------- | -------------------------------- |
  | before (0004 only)  | 67.0 jobs/s (149.3 s) | 64.5 jobs/s (155.1 s) | 64.0 jobs/s (156.2 s) | **64.5 jobs/s (64.0 – 67.0)**    |
  | after (0004 + 0006) | 257.7 jobs/s (38.8 s) | 253.1 jobs/s (39.5 s) | 250.1 jobs/s (40.0 s) | **253.1 jobs/s (250.1 – 257.7)** |

  A 3.9x increase in throughput, far outside the spread (the ranges are 5% and 3%, nowhere near overlapping). The P1.9 record said 77.1 jobs/s (72.1 – 85.6) for the unchanged code; the "before" measured today is lower by about 16%, which is a measure of how much this machine drifts between sessions, and is why the before was re-run rather than quoted. The full-size correctness test (`pnpm test:concurrency`, 50 workers, 10,000 jobs, no job executed twice, none lost, no double-claim of a live lease) went from about 160 s to **38.8 s (257 jobs/s)** and still passes, and the 11 queue tests (backoff schedule, dead letters, crashed workers and lease expiry, fencing of stale workers, idempotent enqueue, access control) pass unchanged.

- **Write and storage cost:** two more indexes on `jobs`, maintained on every enqueue, claim and acknowledgement. Scratch database, bulk `INSERT` of 100,000 queued jobs, 5 runs: **median 2,637 ms with the two indexes against 2,001 ms without (about 30% more for a bulk insert)**, ranges 2,267 – 2,974 against 1,919 – 2,164 ms (`raw/o6-index-write-cost.txt`); that is about 6 microseconds more per row inserted. Size at 110,000 queued jobs: `jobs_claim_idx` **6.9 MB** (table 15 MB, primary key 4.6 MB); `jobs_lease_idx` is empty unless jobs are running (8 KB). Succeeded and dead jobs are in neither index, so they do not grow with history. The end-to-end drain, which includes all the claim and acknowledgement writes, still got 3.9x faster, so in this workload the extra write cost is far smaller than the read saving. It was not measured on the HTTP ingest path (the queue has no HTTP path yet).
- **What was learned:** (1) A partial index is only used when the planner can prove the query implies its predicate; an `OR` of different status tests defeated that, so the query shape had to change together with the index (an index alone would have been a silent no-op, which `EXPLAIN` showed). (2) Read the whole function, not only the headline query: the cheap-looking first statement was also a sequential scan. (3) The older `jobs_runnable_idx (queue, run_at) WHERE status = 'queued'` from migration 0001 is now not used by any query and is a candidate for dropping (not done here: one change at a time, and not measured).

<!-- ENTRIES -->

## Observations (not yet acted on)

Things noticed while building the P1.7 baseline. **Nothing below has been fixed**: the baseline in `docs/benchmarks/baseline.md` was measured on the unmodified code and schema. P1.10 turns these into proper entries (before/after).

### O1. `GET /v1/usage` cannot use the index order: `ORDER BY occurred_at` resolves to the output alias

- **Where:** `ledgerline/src/routes/usage.ts`. The query selects `to_char(occurred_at AT TIME ZONE 'UTC', ...) AS occurred_at` and then says `ORDER BY occurred_at DESC, id DESC`. In Postgres, a bare name in `ORDER BY` matches an output column before an input column, so it sorts by the formatted text, not by the indexed `timestamptz` column. The result order is the same (the text is ISO-formatted), but the planner cannot walk `(tenant_id, occurred_at)` backwards and stop after 51 rows.
- **Evidence:** single warm run each, `EXPLAIN (ANALYZE, BUFFERS)` as `ledgerline_app` with the tenant set (so RLS applies); tenant rank 1, window 2026-08-24 to 2026-08-31, `LIMIT 51`; 10M-row synthetic seed, Postgres 16.15, 2 CPU / 2 GiB container. The only difference between the two queries is `ORDER BY usage_events.occurred_at` instead of the alias.

As written in the API (sorts by the alias): **Execution Time: 132.736 ms**, 4,934 buffer hits, 64,435 rows read and sorted to return a 51-row page.

```
QUERY PLAN
 Limit  (cost=23949.41..23949.54 rows=51 width=93) (actual time=132.610..132.617 rows=51 loops=1)
   Buffers: shared hit=4934
   InitPlan 1 (returns $0)
     ->  Result  (cost=0.00..0.26 rows=1 width=16) (actual time=0.088..0.088 rows=1 loops=1)
   ->  Sort  (cost=23949.15..24114.06 rows=65961 width=93) (actual time=132.608..132.611 rows=51 loops=1)
         Sort Key: (to_char((usage_events.occurred_at AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'::text)) DESC, usage_events.id DESC
         Sort Method: top-N heapsort  Memory: 36kB
         Buffers: shared hit=4934
         ->  Result  (cost=2581.43..21748.56 rows=65961 width=93) (actual time=6.968..94.051 rows=64435 loops=1)
               One-Time Filter: ($0 = '8641a01e-babb-4e44-d36d-f68e5233c7fb'::uuid)
               Buffers: shared hit=4934
               ->  Bitmap Heap Scan on usage_events_2026_08 usage_events  (cost=2581.43..21418.75 rows=65961 width=69) (actual time=6.857..34.037 rows=64435 loops=1)
                     Recheck Cond: ((tenant_id = '8641a01e-babb-4e44-d36d-f68e5233c7fb'::uuid) AND (occurred_at >= '2026-08-24 00:00:00+00'::timestamp with time zone) AND (occurred_at < '2026-08-31 00:00:00+00'::timestamp with time zone))
                     Heap Blocks: exact=4494
                     Buffers: shared hit=4934
                     ->  Bitmap Index Scan on usage_events_2026_08_tenant_id_occurred_at_idx  (cost=0.00..2564.94 rows=65961 width=0) (actual time=6.110..6.110 rows=64435 loops=1)
                           Index Cond: ((tenant_id = '8641a01e-babb-4e44-d36d-f68e5233c7fb'::uuid) AND (occurred_at >= '2026-08-24 00:00:00+00'::timestamp with time zone) AND (occurred_at < '2026-08-31 00:00:00+00'::timestamp with time zone))
                           Buffers: shared hit=440
 Planning Time: 0.301 ms
 Execution Time: 132.736 ms
```

Same query ordered by the real column: **Execution Time: 0.417 ms**, 55 buffer hits.

```
QUERY PLAN
 Limit  (cost=1.82..61.54 rows=51 width=101) (actual time=0.308..0.375 rows=51 loops=1)
   Buffers: shared hit=55
   InitPlan 1 (returns $0)
     ->  Result  (cost=0.00..0.26 rows=1 width=16) (actual time=0.157..0.157 rows=1 loops=1)
   ->  Incremental Sort  (cost=1.56..77238.76 rows=65961 width=101) (actual time=0.307..0.369 rows=51 loops=1)
         Sort Key: usage_events.occurred_at DESC, usage_events.id DESC
         Presorted Key: usage_events.occurred_at
         Full-sort Groups: 2  Sort Method: quicksort  Average Memory: 29kB  Peak Memory: 29kB
         Buffers: shared hit=55
         ->  Result  (cost=0.43..74270.52 rows=65961 width=101) (actual time=0.191..0.335 rows=52 loops=1)
               One-Time Filter: ($0 = '8641a01e-babb-4e44-d36d-f68e5233c7fb'::uuid)
               Buffers: shared hit=55
               ->  Index Scan Backward using usage_events_2026_08_tenant_id_occurred_at_idx on usage_events_2026_08 usage_events  (cost=0.43..73940.71 rows=65961 width=69) (actual time=0.026..0.108 rows=52 loops=1)
                     Index Cond: ((tenant_id = '8641a01e-babb-4e44-d36d-f68e5233c7fb'::uuid) AND (occurred_at >= '2026-08-24 00:00:00+00'::timestamp with time zone) AND (occurred_at < '2026-08-31 00:00:00+00'::timestamp with time zone))
                     Buffers: shared hit=55
 Planning Time: 0.294 ms
 Execution Time: 0.417 ms
```

- **Measured impact in the baseline:** `usage-read / huge` p95 is 162.5 ms against 22.0 ms for the small tenant (medians of 3 runs at 2 iterations/s), and higher rates saturate (see baseline.md, "Findings"). These are baseline numbers; no after-measurement exists yet.
- **Status:** FIXED in E1 (application bug, alias shadowing; huge-tenant usage-read p95 145.5 ms to 24.3 ms through the API, no index change).

### O2. Autovacuum ran on the partitions on its own after the seed

`pg_stat_user_tables` showed `last_autovacuum` and `last_autoanalyze` set for the seeded partitions after the seed (for example `usage_events_2026_01`: last_autovacuum 2026-10-01 16:58:19 UTC), although the seed itself only runs `ANALYZE`. The benchmark preflight waits until no autovacuum worker is running and records it, but the visibility-map state during the baseline is whatever autovacuum left, not something the seed controls.

### O3. Fixed per-request overhead from round trips

`balance` and `ingest` p50 is about 7-8 ms at 100 req/s for both tenant sizes. Each authenticated request makes five round trips to Postgres (key lookup, `BEGIN`, `set_config`, the statement, `COMMIT`; the key lookup and the statement are visible in the per-run `pg_stat_statements` files in `docs/benchmarks/raw/`). That is a cost floor for every endpoint, independent of data size. Not investigated further.

### O4. Unexplained latency spikes on the cheap endpoints

For `balance` and `ingest` the run maxima are 64 to 401 ms and p99 is 22 to 102 ms while p95 is 10 to 17 ms (every run). The k6 container, the API on the host and the 2-CPU Postgres container share one 4-core laptop, so scheduler noise is a plausible cause, but this was not diagnosed.

### O5. `credit_ledger (tenant_id, id)` is now a redundant index

Migration 0003 added a unique constraint on `credit_ledger (tenant_id, id)` (required for the composite foreign key that keeps refunds inside one tenant). It makes the older non-unique index `credit_ledger_tenant_id_idx` on the same columns redundant: two indexes now cover the same lookups and both are maintained on every ledger insert. Not changed (no tuning in this task). A before/after write-cost measurement belongs in P1.10.

### O6. `claim_jobs` sequentially scans and sorts every runnable job on every claim

- **Where:** the pick step of `ledgerline_fn.claim_jobs` (migration 0004): `WHERE queue = ... AND ((status IN ('queued','failed') AND run_at <= now) OR (status = 'running' AND lease_expires_at <= now AND attempts < max_attempts)) ORDER BY run_at, id LIMIT n FOR UPDATE SKIP LOCKED`.
- **Evidence:** `EXPLAIN (ANALYZE, BUFFERS)` against 10,000 queued synthetic jobs (Postgres 16.15, 2 CPU / 2 GiB container) shows `Seq Scan on jobs` + `Sort` over all 10,000 rows to return 1: Execution Time 5.670 ms, 182 buffer hits. Full plan in `docs/benchmarks/queue.md` and `docs/benchmarks/raw/queue-throughput.txt`.
- **Measured impact:** 10,000 no-op jobs with 50 workers: median 77.1 jobs/s (72.1 to 85.6) over 3 runs. The full-size correctness test takes about 160 s.
- **Why:** the existing partial index `(queue, run_at) WHERE status = 'queued'` cannot serve the `OR` that makes `failed` jobs and expired leases claimable.
- **Status:** FIXED in E3 (two partial indexes plus a provable predicate; queue throughput 64.5 to 253.1 jobs/s).

### O7. Credit and queue functions are plpgsql round trips

The per-debit cost measured in the 10,000-debit test (about 14 to 19 s for 10,000 debits with 50 workers, i.e. roughly 500 to 700 debits/s, with all debits of one tenant serialised on its balance row) was not profiled. Noted for P1.10; no conclusion drawn.
