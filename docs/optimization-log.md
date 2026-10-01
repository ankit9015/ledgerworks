# Optimization log

One entry per performance win. Every entry must contain all of the following, with real output pasted from a real run (never estimated):

1. **Slow query**: the exact SQL and the endpoint or code path it serves.
2. **`EXPLAIN (ANALYZE, BUFFERS)` before**: full plan output.
3. **Change**: the index, schema change or query rewrite, as the exact SQL or diff.
4. **`EXPLAIN (ANALYZE, BUFFERS)` after**: full plan output.
5. **Measured latency before and after**: with the number of runs and how they were taken.
6. **Seed size**: rows per relevant table, plus the Postgres version and container CPU/memory limits (see `docker-compose.yml`). Label synthetic data as synthetic.

## Entries

_None yet. Entries are added in P1.10._

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
- **Status:** not fixed. Planned for P1.10 with a measured before/after through the API.

### O2. Autovacuum ran on the partitions on its own after the seed

`pg_stat_user_tables` showed `last_autovacuum` and `last_autoanalyze` set for the seeded partitions after the seed (for example `usage_events_2026_01`: last_autovacuum 2026-10-01 16:58:19 UTC), although the seed itself only runs `ANALYZE`. The benchmark preflight waits until no autovacuum worker is running and records it, but the visibility-map state during the baseline is whatever autovacuum left, not something the seed controls.

### O3. Fixed per-request overhead from round trips

`balance` and `ingest` p50 is about 7-8 ms at 100 req/s for both tenant sizes. Each authenticated request makes five round trips to Postgres (key lookup, `BEGIN`, `set_config`, the statement, `COMMIT`; the key lookup and the statement are visible in the per-run `pg_stat_statements` files in `docs/benchmarks/raw/`). That is a cost floor for every endpoint, independent of data size. Not investigated further.

### O4. Unexplained latency spikes on the cheap endpoints

For `balance` and `ingest` the run maxima are 64 to 401 ms and p99 is 22 to 102 ms while p95 is 10 to 17 ms (every run). The k6 container, the API on the host and the 2-CPU Postgres container share one 4-core laptop, so scheduler noise is a plausible cause, but this was not diagnosed.
