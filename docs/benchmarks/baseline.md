# Baseline (P1.7): Ledgerline before any optimization

Measured on the code and schema as committed at the end of P1.5/P1.6, **with no tuning of any kind** (no new indexes, no query changes, no configuration changes). All data is **synthetic** (see `seed.md`). The point of this file is an honest "before" for P1.10 and P1.11.

## Findings (read these first)

1. **Under the fixed profile, no endpoint errored, timed out or dropped iterations in any of the 18 runs**: 0 failed requests, 0 dropped iterations and 0 failed checks (6,001 measured requests per run for the cheap scenarios, about 363 per run for usage reads).
2. **Tenant size matters a lot for `GET /v1/usage`.** At 2 iterations/s (about 6 requests/s) the very large tenant (rank 1, 2,541,285 events, about 25% of all events) has p95 **162.5 ms** against **22.0 ms** for a small tenant (rank 100, 10,118 events): about 7x. Medians are 97.7 ms against 13.2 ms. The balance and ingest endpoints do not depend on tenant size (p95 11 to 13 ms for both).
3. **The huge-tenant usage read saturates early.** Separate single-run capacity probes (not part of the 3-run baseline; same script and profile except the rate; see the probe table below): at **5 iterations/s** (about 15 requests/s) the huge tenant already has p95 **14.4 s** and **62 dropped iterations**; at **10 iterations/s**, p95 **43.0 s** and **275 dropped iterations**. At **20 iterations/s** k6 hit its 400-VU cap with **801 dropped iterations**, and requests started timing out (see "Saturation" below, which re-ran all three probes and compares them with the first figures). Up to 10 iterations/s requests did not return errors, they queued; at 20 iterations/s they hit the 60 s request timeout. A small tenant at **20 iterations/s** (about 60 requests/s) is fine: p95 16 ms, 0 dropped. The 2 iterations/s rate of the main baseline was chosen after seeing this, so that the three-run comparison is between sustainable loads. The saturation point is reported here rather than hidden.
4. **Root-cause candidate (diagnosed, not fixed):** the usage query sorts by an output alias, so it cannot use the `(tenant_id, occurred_at)` index order. The same query under matched conditions runs in 132.7 ms with the alias and 0.417 ms ordering by the column. Full plans in `../optimization-log.md`, observation O1.
5. The cheap endpoints have occasional spikes (run maxima 64 to 401 ms, p99 up to 102 ms) that were not diagnosed (observation O4).

## Environment

|                   |                                                                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Date              | 2026-10-01 (UTC), commit `0e7e423` plus the k6 scripts added in this task                                                                                                                                                            |
| Machine           | Intel Core i5-1135G7 (4 cores / 8 threads), 19.8 GB RAM, NVMe SSD, Windows 11 Home                                                                                                                                                   |
| Postgres          | 16.15 (Debian) in Docker Desktop (VM: 8 CPUs, 9.6 GiB); container limits **2 CPUs / 2 GiB memory, no swap**                                                                                                                          |
| Postgres settings | `shared_buffers` 512 MB, `effective_cache_size` 1536 MB, `work_mem` 16 MB, `maintenance_work_mem` 128 MB, `max_connections` 100, `random_page_cost` 4, `jit` on, `synchronous_commit` on, autovacuum on, `pg_stat_statements` loaded |
| API               | Host process (`tsx src/server.ts`, Node 22.13.1), `HOST=0.0.0.0`, default pool size 10, default `LOG_LEVEL=info`, one process                                                                                                        |
| Load generator    | k6 v2.3.0 in the `grafana/k6` Docker image, reaching the API at `host.docker.internal:3000`                                                                                                                                          |
| Shared resources  | k6, the API, the Postgres container and the OS all ran on the same laptop at the same time. Postgres is capped at 2 CPUs; the others are not capped                                                                                  |
| Seed              | value `20251001`; exactly 10,000,000 `usage_events` (verified before every run), 250 tenants, 1,543 users, 6,053 ledger rows; top 5 tenants hold 51.8%; database size 2,305 MB                                                       |
| Indexes in place  | only those from migration 0001 (`usage_events` primary key and `(tenant_id, occurred_at)` on each partition)                                                                                                                         |
| Tenants used      | **huge** = rank 1 (2,541,285 events); **small** = rank 100 (10,118 events)                                                                                                                                                           |
| Full record       | `raw/environment.txt`                                                                                                                                                                                                                |

## Load profile (identical for every run)

Every scenario is two k6 `constant-arrival-rate` phases against one endpoint with one tenant's API key:

- **Warmup:** 30 s at the scenario rate, tagged `phase=warmup`, excluded from all reported numbers.
- **Measure:** 60 s at the same rate, starting 5 s after the warmup ends, tagged `phase=measure`. **Only this phase is reported.**

| Scenario     | Rate           | What one iteration does                                                                                                                                           |
| ------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `usage-read` | 2 iterations/s | `GET /v1/usage` over a random 7-day window inside the seeded year, `limit=50`, newest first; follows the cursor for up to 3 pages (pages are reported separately) |
| `balance`    | 100 req/s      | `GET /v1/credits/balance`                                                                                                                                         |
| `ingest`     | 100 req/s      | `POST /v1/usage-events` (event type `k6.baseline`, `occurred_at` = now, so rows land in the otherwise empty `usage_events_2026_10` partition)                     |

Each scenario ran for the huge tenant and the small tenant. The full matrix was run in 3 rounds (all six scenarios per round), so drift over the session is spread across scenarios.

**Before every run** (`ledgerline/k6/run.sh`): confirm `usage_events` has exactly 10,000,000 rows, confirm the API is healthy, wait until no autovacuum worker is running, reset `pg_stat_statements`. **After ingest runs:** the ingested rows (9,002 per run, warmup included) are removed by truncating the otherwise empty current-month partition, and the row count is verified to be back at exactly 10,000,000 (it was, after all 6 ingest runs).

Thresholds are defined in each script (p95 under 500 ms for usage reads, 100 ms for balance, 200 ms for ingest, error rate under 1%, zero dropped iterations) but are **informational only**: no run is aborted on them and a threshold exit code (99) is ignored.

## Results (3 runs per scenario; median, with min to max across the 3 runs)

### Latency, measured phase only (median of runs, with min – max across runs)

| Scenario             | Runs | p50                            | p95                            | p99                            | max                            | Requests: total (per run)      |
| -------------------- | ---- | ------------------------------ | ------------------------------ | ------------------------------ | ------------------------------ | ------------------------------ |
| usage-read / huge    | 3    | 97.7 ms (95.8 ms – 105.3 ms)   | 162.5 ms (152.5 ms – 185.4 ms) | 212.1 ms (190.1 ms – 255.2 ms) | 230.4 ms (222.5 ms – 286.8 ms) | 1,089 (363 / 363 / 363)        |
| &nbsp;&nbsp;↳ page 1 | 3    | 117.6 ms (111.9 ms – 123.5 ms) | 203.1 ms (184.1 ms – 231.3 ms) | 226.4 ms (193.6 ms – 256.2 ms) | 230.4 ms (222.5 ms – 272.3 ms) | 363 (121 / 121 / 121)          |
| &nbsp;&nbsp;↳ page 2 | 3    | 93.7 ms (89.7 ms – 98.3 ms)    | 130.6 ms (120.8 ms – 154.6 ms) | 141.0 ms (139.8 ms – 182.0 ms) | 154.0 ms (150.6 ms – 286.8 ms) | 363 (121 / 121 / 121)          |
| &nbsp;&nbsp;↳ page 3 | 3    | 90.0 ms (87.5 ms – 97.2 ms)    | 131.4 ms (118.2 ms – 172.8 ms) | 141.5 ms (124.4 ms – 195.3 ms) | 203.3 ms (134.2 ms – 265.2 ms) | 363 (121 / 121 / 121)          |
| usage-read / small   | 3    | 13.2 ms (12.4 ms – 14.7 ms)    | 22.0 ms (20.2 ms – 24.5 ms)    | 32.4 ms (24.1 ms – 42.9 ms)    | 38.6 ms (26.2 ms – 69.9 ms)    | 1,086 (363 / 360 / 363)        |
| &nbsp;&nbsp;↳ page 1 | 3    | 17.3 ms (15.7 ms – 19.3 ms)    | 30.9 ms (23.4 ms – 31.9 ms)    | 33.2 ms (25.7 ms – 53.4 ms)    | 38.6 ms (26.2 ms – 69.9 ms)    | 362 (121 / 120 / 121)          |
| &nbsp;&nbsp;↳ page 2 | 3    | 13.7 ms (12.7 ms – 14.3 ms)    | 18.1 ms (18.1 ms – 19.8 ms)    | 19.2 ms (19.1 ms – 27.4 ms)    | 24.6 ms (19.6 ms – 46.3 ms)    | 362 (121 / 120 / 121)          |
| &nbsp;&nbsp;↳ page 3 | 3    | 10.7 ms (10.6 ms – 11.3 ms)    | 16.0 ms (14.4 ms – 18.0 ms)    | 18.5 ms (15.7 ms – 34.9 ms)    | 19.2 ms (15.9 ms – 40.0 ms)    | 362 (121 / 120 / 121)          |
| balance / huge       | 3    | 7.1 ms (6.9 ms – 7.2 ms)       | 12.0 ms (11.9 ms – 12.5 ms)    | 52.1 ms (22.0 ms – 96.8 ms)    | 287.0 ms (64.4 ms – 401.0 ms)  | 18,003 (6,001 / 6,001 / 6,001) |
| balance / small      | 3    | 7.2 ms (7.1 ms – 7.2 ms)       | 11.1 ms (10.1 ms – 13.1 ms)    | 38.1 ms (30.2 ms – 50.1 ms)    | 192.2 ms (176.8 ms – 255.5 ms) | 18,003 (6,001 / 6,001 / 6,001) |
| ingest / huge        | 3    | 8.1 ms (7.4 ms – 8.2 ms)       | 11.3 ms (10.1 ms – 17.0 ms)    | 37.2 ms (31.2 ms – 102.2 ms)   | 225.7 ms (168.8 ms – 311.4 ms) | 18,003 (6,001 / 6,001 / 6,001) |
| ingest / small       | 3    | 8.3 ms (7.3 ms – 8.5 ms)       | 13.0 ms (13.0 ms – 17.6 ms)    | 66.7 ms (63.4 ms – 91.0 ms)    | 276.1 ms (176.6 ms – 353.7 ms) | 18,003 (6,001 / 6,001 / 6,001) |

### Errors, throughput and dropped iterations (per run: r1 / r2 / r3)

| Scenario           | Error rate (measured) | Throughput (req/s)    | Dropped iterations (measured) | Checks failed |
| ------------------ | --------------------- | --------------------- | ----------------------------- | ------------- |
| usage-read / huge  | 0.00% / 0.00% / 0.00% | 6.0 / 6.0 / 6.0       | 0 / 0 / 0                     | 0 / 0 / 0     |
| usage-read / small | 0.00% / 0.00% / 0.00% | 6.0 / 6.0 / 6.0       | 0 / 0 / 0                     | 0 / 0 / 0     |
| balance / huge     | 0.00% / 0.00% / 0.00% | 100.0 / 100.0 / 100.0 | 0 / 0 / 0                     | 0 / 0 / 0     |
| balance / small    | 0.00% / 0.00% / 0.00% | 100.0 / 100.0 / 100.0 | 0 / 0 / 0                     | 0 / 0 / 0     |
| ingest / huge      | 0.00% / 0.00% / 0.00% | 100.0 / 100.0 / 100.0 | 0 / 0 / 0                     | 0 / 0 / 0     |
| ingest / small     | 0.00% / 0.00% / 0.00% | 100.0 / 100.0 / 100.0 | 0 / 0 / 0                     | 0 / 0 / 0     |

Notes:

- Latency is k6 `http_req_duration` for the measured phase: from sending the request to receiving the whole response, measured from the k6 container (a request that does almost nothing costs about 2 ms, which is the Docker-to-host hop).
- Each cheap scenario sent 6,001 measured requests per run. Each usage-read run sent about 363 (121 iterations x 3 pages); one small-tenant run completed one iteration fewer (360 requests) with nothing dropped.
- Throughput is measured requests / 60 s, so it equals the configured rate when nothing is dropped.
- Error rate is the share of failed responses (`http_req_failed`): 0.00% in every run.
- Page 1 of `usage-read` is slower than pages 2 and 3 for both tenant sizes. Not investigated.

### Capacity probes (single runs, informational)

Same scripts and profile, only the rate differs. Raw files are in `raw/` (names ending `_runcap5`, `_runcap10`, `_runcap20`). k6 was allowed up to 400 VUs per scenario.

| Scenario           | Rate    | p50    | p95    | p99    | max    | Measured requests | Dropped iterations | Errors |
| ------------------ | ------- | ------ | ------ | ------ | ------ | ----------------- | ------------------ | ------ |
| usage-read / huge  | 5 it/s  | 9.2 s  | 14.4 s | 14.9 s | 15.8 s | 696               | 62                 | 0.00%  |
| usage-read / huge  | 10 it/s | 40.3 s | 43.0 s | 43.6 s | 44.0 s | 341               | 275                | 0.00%  |
| usage-read / small | 20 it/s | 10 ms  | 16 ms  | 28 ms  | 95 ms  | 3,603             | 0                  | 0.00%  |

## Saturation (re-run on unmodified code, raw files kept)

The huge-tenant `usage-read` probes were re-run at 5, 10 and 20 iterations/s on the same unmodified code, with the same 30 s warmup + 60 s measure profile, the same preflight (exactly 10,000,000 rows, no autovacuum running) and the same environment as the baseline (API on the host under `tsx`, k6 in Docker). Single run per rate, measured phase only. Raw files in `raw/`: `usage-read_huge_runsat5.*`, `usage-read_huge_runsat10.*`, `usage-read_huge_runsat20.*` (`.summary.json`, `.txt`, `.pgss.txt`), the loop's console log `saturation-run.log`, and the API's own log during these runs `api-sat.log`.

| Rate    | Run                                                        | p50     | p95     | p99     | max     | Measured requests | Dropped iterations | Failed requests |
| ------- | ---------------------------------------------------------- | ------- | ------- | ------- | ------- | ----------------- | ------------------ | --------------- |
| 5 it/s  | first probe (`_runcap5`)                                   | 9.18 s  | 14.37 s | 14.90 s | 15.80 s | 696               | 62                 | 0.00%           |
| 5 it/s  | re-run (`_runsat5`)                                        | 12.48 s | 16.74 s | 17.19 s | 18.04 s | 606               | 81                 | 0.00%           |
| 10 it/s | first probe (`_runcap10`)                                  | 40.29 s | 43.01 s | 43.56 s | 43.97 s | 341               | 275                | 0.00%           |
| 10 it/s | re-run (`_runsat10`)                                       | 32.65 s | 36.39 s | 37.25 s | 37.85 s | 429               | 275                | 0.00%           |
| 20 it/s | first probe (console figures only, raw files were deleted) | n/a     | 58.42 s | 58.81 s | 59.01 s | 356               | 801                | 0.00%           |
| 20 it/s | re-run (`_runsat20`)                                       | 54.35 s | 59.99 s | 59.99 s | 60.00 s | 325               | 801                | **36.62%**      |

Differences from the earlier figures:

- **The picture is the same** (the endpoint cannot keep up from 5 iterations/s upward, latency is seconds to a minute, and dropped iterations are large), but the exact numbers move by roughly 15-25% between runs of the same code: p95 at 5 it/s was 14.4 s then 16.7 s, at 10 it/s 43.0 s then 36.4 s. These are saturated, queue-dominated runs, so they are noisy; they show that the saturation exists, not a precise capacity figure.
- **Dropped iterations differ at 5 it/s** (62 vs 81) and are identical at 10 and 20 it/s (275 and 801), where k6 is capped by its 400-VU limit.
- **The 20 it/s re-run is different in kind from the first probe.** The first probe's slowest request finished at 59.01 s, just under k6's default 60 s request timeout, so it reported 0.00% errors. In the re-run requests did hit the 60 s timeout: **36.62% of measured requests failed** (119 `request timeout` warnings are visible in the console file, `usage-read_huge_runsat20.txt`). So the earlier statement that nothing errored at 20 it/s was only true of that single lucky run; at this rate the endpoint does produce timeouts.
- The 5 and 10 it/s runs show 0.00% failed requests in both rounds.
- Cause: the usage query cannot use the index order (optimization-log O1), so each page of a huge tenant reads and sorts tens of thousands of rows; at these rates the 2-CPU Postgres container is the bottleneck.

## How to reproduce

```bash
docker compose up -d                                     # Postgres 16, limits in docker-compose.yml
pnpm seed --yes                                          # about 5 minutes; writes .seed/keys.json (gitignored)
HOST=0.0.0.0 pnpm --filter @ledgerworks/ledgerline dev   # the API, in another terminal
ledgerline/k6/env.sh                                     # records the environment
ledgerline/k6/run-all.sh                                 # the 18 runs (about 30 minutes)
node ledgerline/k6/summarize.mjs                         # prints the tables above from raw/*.summary.json
```

One run: `ledgerline/k6/run.sh usage-read huge 1 2` (script, tenant size, run label, rate). The k6 command inside `run.sh` is:

```
docker run --rm -e TENANT=<size> -e RATE=<rate> \
  -v <repo>/ledgerline/k6:/scripts:ro -v <repo>/.seed:/seed:ro -v <repo>/docs/benchmarks/raw:/out \
  grafana/k6 run --quiet --no-color --summary-export=/out/<label>.summary.json /scripts/<script>.js
```

## Raw output

In `raw/`: `<scenario>_<tenant>_run<N>.summary.json` (k6 `--summary-export`), `.txt` (console summary), `.pgss.txt` (top statements in `pg_stat_statements` for that run), `environment.txt`, `run-all.log`. API keys are not in these files: `.seed/` is gitignored, the scripts never print keys, and the files were searched for the `lk_` key prefix before committing.

## Limitations

- One laptop; the load generator, API and database compete for the same CPUs. The numbers are valid as a before/after comparison on this machine, not as absolute capacity.
- The API ran under `tsx` (TypeScript compiled on the fly) with default settings. A compiled build would likely be somewhat faster; not changed on purpose.
- Warm caches: each run follows a 30 s warmup and the 2.3 GB dataset largely fits in the host's page cache. Cold-start performance was not measured.
- Three runs per scenario show the spread but are not enough for tight confidence intervals; the spread is reported instead of a single best run.
- k6's random generator is not seeded, so read windows differ between runs; that variation is part of the reported spread.
