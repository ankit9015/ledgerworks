# RLS overhead (P1.11)

What do the row-level security policies cost? The same k6 scenarios and the same code, with RLS and without it, plus the same transactions at the database level and the plans. All data is **synthetic** (`seed.md`).

## Findings (read these first)

1. **End to end, the overhead of RLS is within the noise.** Through the API, with 3 runs per mode, the medians with RLS were 6.9 / 6.3 / 4.7 / 4.8 ms p50 (usage huge, usage small, balance, ingest) and without it 6.4 / 6.6 / 4.8 / 5.6 ms: the differences go in both directions and are far smaller than the spread between runs of the same mode (up to 2x in single runs, see the table). I cannot detect an effect of RLS on p50, p95, p99 or throughput with this method.
2. **At the database level there is a small, consistent cost: about 0.07 to 0.16 ms per transaction, 14 to 23% of the database time of the transaction**, in every one of the four scenarios (pgbench, 1 client, 3 alternating rounds each). On the HTTP requests measured here (p50 4.7 to 6.9 ms) that is roughly **1 to 3%**, which is why it disappears in the k6 spread.
3. **Where the cost comes from:** the policy adds one `InitPlan` that evaluates `app_tenant_id()` once per statement plus a `Result` node with a `One-Time Filter` on each scanned partition (6 more buffer hits). The setting is **evaluated once per statement, not per row**: a statement that scans about 1.2 million rows costs the same (within noise) with RLS, with the bare function, and without RLS.
4. **No policy rewrite was worth adopting.** Four variants were measured (see "Does the way the policy reads the setting matter"); the best one that keeps the exact behaviour (an inlinable `app_tenant_id()`) is about 8% faster server-side (0.014 ms), which is smaller than the noise of the measurement, and the one that is clearly cheaper changes the failure mode (an error instead of zero rows for a malformed setting). Logged as a negative result (E7 in `../optimization-log.md`); migrations and policies are unchanged.

## Method

- **The only difference between the two modes is that the policies are not applied.** The API code is identical in both modes, and every query it runs already carries an explicit `tenant_id = $1` predicate (usage read, balance read, ingest insert; the usage read has it since D16), so "without RLS" still filters by tenant and the comparison does not measure the cost of a missing filter.
- **Benchmark-only mode, nothing changed in the product:** a temporary login role `ledgerline_bench_norls`, a member of `ledgerline_app` (so exactly the same privileges) with `BYPASSRLS`, created and dropped by `ledgerline/k6/rls-off-role.sh`, in the same database, on the same data and cache pages. The API is pointed at it only through `DATABASE_URL` for the duration of the benchmark; no mode, flag or code path in the API or the migrations disables RLS, and the role was dropped afterwards (the script verifies that no role other than the superuser has `BYPASSRLS`). Before every API start the benchmark script checks `pg_stat_activity` to prove which role the API connected as (`raw/p1.11-rls-compare.log.txt`: `ledgerline_app` for RLS-on, `ledgerline_bench_norls` for RLS-off, in all 6 starts). A first attempt used a throwaway database copy (`CREATE DATABASE ... TEMPLATE`, RLS disabled in the copy); that crashed the Postgres container once during the 2.3 GB copy (it recovered and the data was intact: 10,000,000 rows, 6,053 ledger rows) and was abandoned in favour of the role, which also keeps one shared cache.
- **k6:** the unchanged scripts and profile of `baseline.md` (30 s warmup + 60 s measured, constant arrival rate; `usage-read` 2 it/s, `balance` and `ingest` 100 req/s), the same preflight, **3 runs per mode per scenario, interleaved round by round** (RLS-on, RLS-off, RLS-on, ...), the API restarted for each mode, via `ledgerline/k6/rls-compare.sh`; raw `raw/*_runrlson{1,2,3}.*` and `*_runrlsoff{1,2,3}.*`. The ingested rows were removed after each ingest run as in the baseline (10,000,000 rows before and after).
- **Environment:** the same as the baseline: Intel Core i5-1135G7 laptop, Postgres 16.15 in Docker limited to **2 CPUs / 2 GiB**, `shared_buffers` 512 MB, API on the host under `tsx` (pool size 10), k6 v2.3.0 in Docker, 10,000,000 synthetic `usage_events`, 250 tenants, huge tenant = rank 1 (2,541,285 events), small = rank 100 (10,118 events). Full record: `raw/environment-p1.10-final.txt`. Everything shares one laptop; the spread between runs on this machine is 15 to 25% and up to 2x in single runs here.

## k6 results (3 runs per mode, median with min – max)

| Scenario                    | Mode    | p50                 | p95                   | p99                   | Throughput (measured phase)          | Dropped   | Failed                                                                                                                                          |
| --------------------------- | ------- | ------------------- | --------------------- | --------------------- | ------------------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| usage-read / huge (2 it/s)  | RLS on  | 6.9 ms (6.5 – 7.0)  | 16.4 ms (12.8 – 17.0) | 22.1 ms (15.6 – 24.7) | 6.0 req/s (363 / 360 / 363 requests) | 0 / 0 / 0 | 0                                                                                                                                               |
| usage-read / huge           | RLS off | 6.4 ms (6.2 – 13.2) | 18.2 ms (12.0 – 19.0) | 26.2 ms (22.6 – 29.8) | 6.0 req/s (360 / 363 / 363)          | 0 / 0 / 0 | 0                                                                                                                                               |
| usage-read / small          | RLS on  | 6.3 ms (5.9 – 6.6)  | 11.4 ms (11.1 – 12.3) | 13.5 ms (12.4 – 41.4) | 6.0 req/s (360 / 360 / 360)          | 0 / 0 / 0 | 0                                                                                                                                               |
| usage-read / small          | RLS off | 6.6 ms (6.4 – 14.6) | 12.9 ms (11.8 – 18.3) | 18.1 ms (14.0 – 20.1) | 6.0 req/s (363 / 360 / 360)          | 0 / 0 / 0 | 0                                                                                                                                               |
| balance / small (100 req/s) | RLS on  | 4.7 ms (3.8 – 6.0)  | 9.3 ms (6.9 – 10.2)   | 19.5 ms (9.2 – 33.4)  | 100.0 req/s (6,001 per run)          | 0 / 0 / 0 | 0                                                                                                                                               |
| balance / small             | RLS off | 4.8 ms (3.9 – 6.6)  | 8.9 ms (8.5 – 9.6)    | 13.8 ms (10.9 – 24.0) | 100.0 req/s (6,001 per run)          | 0 / 0 / 0 | **2 of 6,001 in one run** (`dial: i/o timeout` between the k6 container and the host; a network hiccup like observation O4, not related to RLS) |
| ingest / small (100 req/s)  | RLS on  | 4.8 ms (4.4 – 6.4)  | 8.5 ms (7.5 – 9.6)    | 12.1 ms (10.4 – 12.6) | 100.0 req/s (6,001 / 6,000 / 6,001)  | 0 / 0 / 0 | 0                                                                                                                                               |
| ingest / small              | RLS off | 5.6 ms (4.5 – 7.2)  | 8.8 ms (8.3 – 10.8)   | 12.1 ms (11.5 – 23.7) | 100.0 req/s (6,000 / 6,001 / 6,000)  | 0 / 0 / 0 | 0                                                                                                                                               |

Throughput is requests divided by 60 s; the arrival rate is fixed, so it equals the configured rate when nothing is dropped (nothing was). **Verdict: the overhead of RLS is within the noise.** The sign of the median difference flips between scenarios (RLS-off is faster at p50 for usage huge, RLS-on for the small usage read, balance and ingest), the ranges overlap in every row, and the largest "differences" (usage huge p95 16.4 against 18.2 ms, usage small p95 11.4 against 12.9 ms) are in the direction opposite to what RLS would cause.

## Database level (the same transactions, 1 client, pgbench)

`ledgerline/k6/pgbench-rls.sh`: `BEGIN; set_config; <statement>; COMMIT` as `ledgerline_app` (RLS) and as the bypass role, 15 s per run, 3 alternating rounds, `pgbench -M simple`, explicit `tenant_id` in each statement (`docs/benchmarks/sql/pgbench-rls-*.sql`; raw `raw/pgbench-rls-p111.txt`). Mean latency of the whole transaction (4 statements, one client, no HTTP):

| Transaction              | RLS on: mean latency (range) | RLS off: mean latency (range) | Difference           | Throughput on / off (txn/s, median) |
| ------------------------ | ---------------------------- | ----------------------------- | -------------------- | ----------------------------------- |
| usage read, huge tenant  | 0.851 ms (0.848 – 0.861)     | 0.694 ms (0.651 – 0.714)      | **+0.157 ms (+23%)** | 1,175 / 1,442                       |
| usage read, small tenant | 0.764 ms (0.667 – 0.770)     | 0.639 ms (0.596 – 0.663)      | **+0.125 ms (+20%)** | 1,310 / 1,565                       |
| balance read             | 0.466 ms (0.421 – 0.481)     | 0.396 ms (0.373 – 0.397)      | **+0.070 ms (+18%)** | 2,146 / 2,524                       |
| ingest                   | 1.038 ms (0.963 – 1.049)     | 0.912 ms (0.896 – 0.984)      | **+0.126 ms (+14%)** | 963 / 1,097                         |

RLS-on was slower in all 12 of 12 paired rounds. The ranges do not overlap for three of the four transactions (huge and small usage read, balance read) and overlap only for ingest, so the direction is reliable and the size (14 to 23% of database time, 0.07 to 0.16 ms) is approximate. In an HTTP request of 4.7 to 6.9 ms (p50 in the table above) that is about 1 to 3%.

## EXPLAIN with and without RLS (usage read, page 1, huge tenant, a 7-day window)

`docs/benchmarks/sql/usage-read-p1-fixed.sql`, `EXPLAIN (ANALYZE, BUFFERS)`, 5 executions each (raw `raw/explain-p111-ledgerline_app.txt` and `..._ledgerline_bench_norls.txt`); the plan of the last run is shown. With RLS (execution times 18.6 (cold), 1.4, 0.38, 0.43, 0.57 ms; planning 8.2, 2.0, 0.87, 1.2, 1.8 ms), 70 buffers, the policy shows as an `InitPlan` and a `Result` with a `One-Time Filter`:

```
Limit  (cost=1.87..64.05 rows=51 width=101) (actual time=0.470..0.509 rows=51 loops=1)
  Buffers: shared hit=70
  InitPlan 1 (returns $0)
    ->  Result  (cost=0.00..0.26 rows=1 width=16) (actual time=0.226..0.226 rows=1 loops=1)
          Buffers: shared hit=6
  ->  Incremental Sort  (cost=1.61..76960.73 rows=63127 width=101) (actual time=0.469..0.505 rows=51 loops=1)
        Sort Key: usage_events.occurred_at DESC, usage_events.id DESC
        Presorted Key: usage_events.occurred_at
        Full-sort Groups: 2  Sort Method: quicksort  Average Memory: 29kB  Peak Memory: 29kB
        Buffers: shared hit=70
        ->  Result  (cost=0.43..74120.01 rows=63127 width=101) (actual time=0.340..0.436 rows=52 loops=1)
              One-Time Filter: ($0 = '8641a01e-babb-4e44-d36d-f68e5233c7fb'::uuid)
              Buffers: shared hit=61
              ->  Index Scan Backward using usage_events_2026_08_tenant_id_occurred_at_idx on usage_events_2026_08 usage_events  (cost=0.43..73804.38 rows=63127 width=69) (actual time=0.020..0.089 rows=52 loops=1)
                    Index Cond: ((tenant_id = '8641a01e-babb-4e44-d36d-f68e5233c7fb'::uuid) AND (occurred_at >= '2026-08-24 00:00:00+00'::timestamp with time zone) AND (occurred_at < '2026-08-31 00:00:00+00'::timestamp with time zone))
                    Buffers: shared hit=55
Planning:
  Buffers: shared hit=425
Planning Time: 1.828 ms
Execution Time: 0.570 ms
```

Without RLS (execution 0.39, 0.25, 0.24, 0.22, 0.21 ms; planning 1.3, 0.83, 1.1, 0.80, 0.89 ms), 64 buffers, the same index scan:

```
Limit  (cost=1.61..63.79 rows=51 width=101) (actual time=0.148..0.180 rows=51 loops=1)
  Buffers: shared hit=64
  ->  Incremental Sort  (cost=1.61..76960.73 rows=63127 width=101) (actual time=0.146..0.176 rows=51 loops=1)
        Sort Key: usage_events.occurred_at DESC, usage_events.id DESC
        Presorted Key: usage_events.occurred_at
        Full-sort Groups: 2  Sort Method: quicksort  Average Memory: 29kB  Peak Memory: 29kB
        Buffers: shared hit=64
        ->  Index Scan Backward using usage_events_2026_08_tenant_id_occurred_at_idx on usage_events_2026_08 usage_events  (cost=0.43..74120.01 rows=63127 width=101) (actual time=0.066..0.146 rows=52 loops=1)
              Index Cond: ((tenant_id = '8641a01e-babb-4e44-d36d-f68e5233c7fb'::uuid) AND (occurred_at >= '2026-08-24 00:00:00+00'::timestamp with time zone) AND (occurred_at < '2026-08-31 00:00:00+00'::timestamp with time zone))
              Buffers: shared hit=55
Planning:
  Buffers: shared hit=407
Planning Time: 0.887 ms
Execution Time: 0.209 ms
```

The access path is identical (the same backward index scan on the same partition: the policy never costs an extra scan). The differences are the `InitPlan` (6 buffer hits, the call of `app_tenant_id()`, which does a catalog lookup, a regular-expression match and a cast) and the `One-Time Filter` node, which does not change the plan shape or row estimates. Single `EXPLAIN ANALYZE` times are noisy and include instrumentation overhead, so they are shown for the plan shape; the quantitative figures are the loops below and the pgbench table.

## Does the way the policy reads the setting matter?

The usage policy is `tenant_id = (SELECT app_tenant_id())` (D14: the sub-select makes Postgres evaluate it once per statement). Inside one transaction that is rolled back (policy DDL is transactional, so nothing persisted; verified afterwards), the policy was switched between variants and the same statement run 3,000 times server-side as `ledgerline_app` (plan and execute each time, no network), 3 rounds, in `ledgerline/k6/rls-policy-variants.sh`; three executions of the script are kept in `raw/rls-policy-variants-p111-run{1,2,3}.txt` (run 1 had no variant F; run 2 was disturbed by noise on the machine, with a no-RLS reference of 0.24 ms in one round; run 3 is the quietest). Q1 = usage page 1 (51 rows), mean ms per execution, median of the 3 rounds of each execution:

| Variant                                                                                                              | Run 1   | Run 2 (noisy) | Run 3 |                                                                             |
| -------------------------------------------------------------------------------------------------------------------- | ------- | ------------- | ----- | --------------------------------------------------------------------------- |
| **A**: `(SELECT app_tenant_id())` (the current policy)                                                               | 0.221   | 0.188         | 0.172 |                                                                             |
| **B**: `app_tenant_id()` (no sub-select)                                                                             | 0.198   | 0.272         | 0.189 | not better, and no longer forced to a once-per-statement `InitPlan`         |
| **C**: `(SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)` (no helper function)                      | 0.159   | 0.199         | 0.142 | cheaper, but **errors** on a malformed setting instead of returning no rows |
| **F**: policy A with `app_tenant_id()` rewritten without a `FROM` so it can be inlined (same result for every input) | not run | 0.177         | 0.158 | about 8% faster than A in the same runs (-6% and -8%)                       |
| **N**: no RLS (bypass role)                                                                                          | 0.137   | 0.120         | 0.115 | the floor                                                                   |

Q2 (a 6-month aggregate over about 1.2 million rows of the huge tenant, 5 executions per variant): 237 to 439 ms for every variant including no RLS, with differences inside the noise of the runs (for example run 3: A 290 / 269 / 269 ms, B 272 / 277 / 290, C 262 / 264 / 293, F 276 / 273 / 268, no RLS 239 / 238 / 247). **A per-row evaluation of the setting would add on the order of a second for 1.2 million rows; it does not happen, so the setting is read once per statement**, as D14 claimed (now measured, not only argued). What remains is about 12% on this aggregate in run 3 (A against no RLS), plausibly a pass-through `Result` node per row, not isolated further.

- **Server-side, RLS costs about 0.06 ms per statement (+50%) in the quietest run** (A 0.172 against 0.115 ms); the best behaviour-preserving rewrite (F) recovers about 0.014 ms of it. That is inside the noise of this measurement (run 2 shows A varying by 2x), and about 0.3% of a 5 ms request. **No rewrite was adopted**: B is not better, C changes the failure mode that the isolation matrix tests ("a missing, empty or malformed setting returns zero rows, not an error"), and F's gain is not distinguishable from noise. Migrations and policies are unchanged, so the isolation tests did not need to be re-run for a policy change (they were run for every other change in this phase; all 181 isolation tests pass).

## Limitations

- One laptop; the load generator, the API and Postgres share the CPUs. The spread between runs (15 to 25%, up to 2x in single runs) is larger than the overhead being measured, which is why the verdict at the HTTP level is "within the noise", not "zero". The database-level numbers are the better estimate of the cost: **about 0.07 to 0.16 ms per transaction**.
- The "without RLS" mode is a `BYPASSRLS` role, not tables with RLS disabled; both skip the policies, and the plan above shows the only difference is the policy's own nodes.
- Only the policies used by these paths (usage_events, credit_balances) were exercised. Tables with the `EXISTS`-style policy (`users`) were not measured.
- Three runs per mode are not confidence intervals.
