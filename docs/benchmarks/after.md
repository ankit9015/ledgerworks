# After (P1.10): Ledgerline after the optimization work

The baseline protocol of `baseline.md`, re-run on the final code (commit `7de746d` plus the benchmark scripts added in this task), with the baseline code re-run **in the same session, interleaved round by round**, so that the machine's drift between sessions is not mistaken for a code effect. All data is **synthetic** (`seed.md`); the changes themselves are in `../optimization-log.md` (E1 to E6) and `../../DECISIONS.md` (D21 to D24).

## Findings (read these first)

1. **One change explains all of the movement in the endpoint latencies: E1, the `ORDER BY` alias bug.** `GET /v1/usage` for the huge tenant: p95 **161.2 ms to 29.4 ms** (medians of 3 runs, baseline code and final code interleaved in the same session), p50 93.4 to 15.6 ms. The small tenant and the `balance` and `ingest` endpoints did **not** change beyond the noise (differences of 0 to 3% at p50, below the 15 to 25% spread). Nothing else in P1.10 touches these endpoints measurably.
2. **Saturation moved from below 5 iterations/s to between 100 and 200.** On the baseline code the huge-tenant read already queued at 5 it/s (p95 16.7 s) and timed out at 20 it/s. On the final code, 5, 10, 20, 40 and 100 it/s all ran with **0 dropped iterations and 0 failed requests** (p95 12.6, 11.4, 9.2, 7.1 and 18.0 ms); 200 it/s saturates (p50 714 ms, 1,135 dropped iterations, about 168 iterations/s achieved).
3. **All three accepted targets are met**, one with a caveat (a single run above 50 ms): see the table below.
4. **The queue (E3, 3.9x) and the storage and retention changes (E4, E6) are not visible in this HTTP benchmark**, because no HTTP endpoint exercises them; their measurements are in the log.
5. **Absolute numbers are not comparable across sessions on this laptop.** The same cheap endpoint had p50 3.7 to 4.1 ms in one session, 6.0 to 6.6 ms in another, and 7 to 8 ms in the recorded baseline, on unchanged code for that endpoint. Only same-session interleaved pairs are used to attribute an effect.

## Targets (accepted before this work)

| Target                                                       | Result                                                                                                                                                                                                         | Verdict                                                                                                                                                     |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `usage-read` p95 at most 50 ms for the huge tenant at 2 it/s | Main set (interleaved with the baseline code): **29.4 ms** median of 3 runs, runs 51.5 / 29.4 / 29.1 ms. Two further samples of the final code: 13.5 ms (22.6 / 13.5 / 10.7) and 11.1 ms (19.3 / 11.1 / 10.9). | **Met on the median in all three samples.** One of nine runs (the first run of the main set, 51.5 ms) was 1.5 ms over the limit.                            |
| Sustain 10 it/s with 0 dropped iterations                    | 3 runs at 10 it/s: **0 / 0 / 0 dropped, 0 failed requests**, p95 11.4 / 11.3 / 11.3 ms (baseline code: 275 dropped, p95 36 to 43 s)                                                                            | **Met**                                                                                                                                                     |
| No regression on the cheap endpoints (p95 11 to 13 ms)       | `balance` p95 7.7 ms (huge) and 8.3 ms (small); `ingest` 9.0 and 9.1 ms (final code, main set); the baseline code in the same session: 7.7, 8.3, 9.8 and 9.9 ms                                                | **Met**: no change beyond noise against the baseline code, and below the 11 to 13 ms band in absolute terms (the band is from the recorded, slower session) |

## Environment and method

Same as `baseline.md` (Intel Core i5-1135G7 laptop, Postgres 16.15 in Docker limited to 2 CPUs / 2 GiB, API on the host under `tsx` with pool size 10, k6 v2.3.0 in Docker, 10,000,000 synthetic `usage_events`, seed value 20251001 re-seeded with identical fingerprints, huge tenant = rank 1, small = rank 100). Full record: `raw/environment-p1.10-final.txt`.

- **Profile, unchanged:** 30 s warmup (excluded) + 60 s measured, constant arrival rate (`usage-read` 2 it/s, `balance` and `ingest` 100 req/s); preflight (exactly 10,000,000 rows, no autovacuum running, `pg_stat_statements` reset); **3 runs per scenario**; medians with min to max.
- **Three sets compared:**
  1. **Baseline as recorded** on 2026-10-01 (`baseline.md`).
  2. **Baseline code re-run today**: the P1.7 code (git worktree at `aa0aa89`, API only; identical k6 scripts) against the same, current database. Its only difference from the final code on these endpoints is the E1 query.
  3. **Final code**, today.
     Sets 2 and 3 alternate by round (final, baseline, final, baseline, final, baseline; the API is restarted each time) via `ledgerline/k6/compare.sh`, tagged `final2` and `base2` in `raw/`.
- **A first attempt was invalid and is disclosed.** In the first run of this comparison, the baseline API silently failed to start (`EADDRINUSE`; the previous server was still shutting down and answered the health check), so the files tagged `basetoday` actually measured the final code. They are kept and explained in `raw/NOTE-basetoday-was-final-code.txt`, the script was fixed (it now waits for the port, requires the new process's own "Server listening" log line and checks which checkout is running), and the whole comparison was re-run. The first attempt's two final-code samples are used below only as an extra run-to-run check.

## Results: baseline against after (3 runs, median with min – max)

Reading guide: "Final vs baseline-today" is the change of the median between the two interleaved sets of this session. Differences of a few percent are inside the 15 to 25% spread of this machine and are not changes.

### p50

| Scenario           | Baseline as recorded 2026-10-01 | Baseline code re-run today  | **Final code (today)**          | Final vs baseline-today (median) |
| ------------------ | ------------------------------- | --------------------------- | ------------------------------- | -------------------------------- |
| usage-read / huge  | 97.7 ms (95.8 ms – 105.3 ms)    | 93.4 ms (91.1 ms – 94.2 ms) | **15.6 ms (15.0 ms – 21.5 ms)** | -83%                             |
| usage-read / small | 13.2 ms (12.4 ms – 14.7 ms)     | 14.5 ms (13.3 ms – 15.0 ms) | **14.7 ms (12.5 ms – 14.8 ms)** | 2%                               |
| balance / huge     | 7.1 ms (6.9 ms – 7.2 ms)        | 6.0 ms (5.9 ms – 6.0 ms)    | **6.1 ms (6.0 ms – 6.2 ms)**    | 3%                               |
| balance / small    | 7.2 ms (7.1 ms – 7.2 ms)        | 6.6 ms (5.9 ms – 6.7 ms)    | **6.6 ms (5.9 ms – 6.7 ms)**    | 0%                               |
| ingest / huge      | 8.1 ms (7.4 ms – 8.2 ms)        | 7.3 ms (7.3 ms – 7.3 ms)    | **7.3 ms (6.4 ms – 7.3 ms)**    | 0%                               |
| ingest / small     | 8.3 ms (7.3 ms – 8.5 ms)        | 7.1 ms (7.0 ms – 7.3 ms)    | **7.2 ms (7.1 ms – 7.3 ms)**    | 2%                               |

### p95

| Scenario           | Baseline as recorded 2026-10-01 | Baseline code re-run today     | **Final code (today)**          | Final vs baseline-today (median) |
| ------------------ | ------------------------------- | ------------------------------ | ------------------------------- | -------------------------------- |
| usage-read / huge  | 162.5 ms (152.5 ms – 185.4 ms)  | 161.2 ms (160.7 ms – 165.6 ms) | **29.4 ms (29.1 ms – 51.5 ms)** | -82%                             |
| usage-read / small | 22.0 ms (20.2 ms – 24.5 ms)     | 19.2 ms (18.6 ms – 19.8 ms)    | **19.4 ms (18.3 ms – 19.8 ms)** | 1%                               |
| balance / huge     | 12.0 ms (11.9 ms – 12.5 ms)     | 7.7 ms (7.4 ms – 7.8 ms)       | **7.7 ms (7.6 ms – 9.4 ms)**    | -0%                              |
| balance / small    | 11.1 ms (10.1 ms – 13.1 ms)     | 8.3 ms (8.1 ms – 8.4 ms)       | **8.3 ms (8.1 ms – 8.4 ms)**    | -1%                              |
| ingest / huge      | 11.3 ms (10.1 ms – 17.0 ms)     | 9.8 ms (9.0 ms – 10.5 ms)      | **9.0 ms (7.9 ms – 9.0 ms)**    | -8%                              |
| ingest / small     | 13.0 ms (13.0 ms – 17.6 ms)     | 9.9 ms (9.0 ms – 10.0 ms)      | **9.1 ms (8.8 ms – 10.7 ms)**   | -8%                              |

### p99

| Scenario           | Baseline as recorded 2026-10-01 | Baseline code re-run today     | **Final code (today)**          | Final vs baseline-today (median) |
| ------------------ | ------------------------------- | ------------------------------ | ------------------------------- | -------------------------------- |
| usage-read / huge  | 212.1 ms (190.1 ms – 255.2 ms)  | 217.8 ms (189.6 ms – 268.5 ms) | **31.5 ms (31.1 ms – 62.5 ms)** | -86%                             |
| usage-read / small | 32.4 ms (24.1 ms – 42.9 ms)     | 22.8 ms (20.7 ms – 28.3 ms)    | **21.6 ms (20.2 ms – 30.1 ms)** | -5%                              |
| balance / huge     | 52.1 ms (22.0 ms – 96.8 ms)     | 11.1 ms (8.7 ms – 13.9 ms)     | **10.4 ms (9.0 ms – 24.0 ms)**  | -6%                              |
| balance / small    | 38.1 ms (30.2 ms – 50.1 ms)     | 9.9 ms (9.9 ms – 10.5 ms)      | **10.0 ms (9.9 ms – 12.4 ms)**  | 1%                               |
| ingest / huge      | 37.2 ms (31.2 ms – 102.2 ms)    | 14.6 ms (10.6 ms – 25.5 ms)    | **10.8 ms (9.1 ms – 11.5 ms)**  | -26%                             |
| ingest / small     | 66.7 ms (63.4 ms – 91.0 ms)     | 13.6 ms (12.2 ms – 14.3 ms)    | **11.6 ms (10.1 ms – 18.6 ms)** | -15%                             |

### Dropped iterations and failed requests

None of the 36 interleaved runs dropped an iteration or failed a request. (Request counts per run: 6,001 for the cheap scenarios, 360 or 363 for `usage-read`; a few runs have one request fewer, which is the arrival-rate boundary, not a drop.)

| Scenario           | Set            | Requests per run   | Dropped   | Failed                |
| ------------------ | -------------- | ------------------ | --------- | --------------------- |
| usage-read / huge  | recorded       | 363 / 363 / 363    | 0 / 0 / 0 | 0.00% / 0.00% / 0.00% |
| usage-read / huge  | baseline today | 363 / 363 / 363    | 0 / 0 / 0 | 0.00% / 0.00% / 0.00% |
| usage-read / huge  | final          | 363 / 363 / 363    | 0 / 0 / 0 | 0.00% / 0.00% / 0.00% |
| usage-read / small | recorded       | 363 / 360 / 363    | 0 / 0 / 0 | 0.00% / 0.00% / 0.00% |
| usage-read / small | baseline today | 363 / 360 / 363    | 0 / 0 / 0 | 0.00% / 0.00% / 0.00% |
| usage-read / small | final          | 363 / 363 / 360    | 0 / 0 / 0 | 0.00% / 0.00% / 0.00% |
| balance / huge     | recorded       | 6001 / 6001 / 6001 | 0 / 0 / 0 | 0.00% / 0.00% / 0.00% |
| balance / huge     | baseline today | 6000 / 6001 / 6001 | 0 / 0 / 0 | 0.00% / 0.00% / 0.00% |
| balance / huge     | final          | 6001 / 6001 / 6001 | 0 / 0 / 0 | 0.00% / 0.00% / 0.00% |
| balance / small    | recorded       | 6001 / 6001 / 6001 | 0 / 0 / 0 | 0.00% / 0.00% / 0.00% |
| balance / small    | baseline today | 6001 / 6001 / 6001 | 0 / 0 / 0 | 0.00% / 0.00% / 0.00% |
| balance / small    | final          | 6001 / 6000 / 6001 | 0 / 0 / 0 | 0.00% / 0.00% / 0.00% |
| ingest / huge      | recorded       | 6001 / 6001 / 6001 | 0 / 0 / 0 | 0.00% / 0.00% / 0.00% |
| ingest / huge      | baseline today | 6001 / 6000 / 6001 | 0 / 0 / 0 | 0.00% / 0.00% / 0.00% |
| ingest / huge      | final          | 6001 / 6001 / 6001 | 0 / 0 / 0 | 0.00% / 0.00% / 0.00% |
| ingest / small     | recorded       | 6001 / 6001 / 6001 | 0 / 0 / 0 | 0.00% / 0.00% / 0.00% |
| ingest / small     | baseline today | 6001 / 6001 / 6001 | 0 / 0 / 0 | 0.00% / 0.00% / 0.00% |
| ingest / small     | final          | 6000 / 6001 / 6001 | 0 / 0 / 0 | 0.00% / 0.00% / 0.00% |

### Run-to-run check: three samples of the final code

The same code, measured three times (the main set, the first attempt of this comparison, and the mislabelled second set), p95 per scenario:

| Scenario           | final2 (main set)           | first attempt (tag final)   | accidental second (tag basetoday) |
| ------------------ | --------------------------- | --------------------------- | --------------------------------- |
| usage-read / huge  | 29.4 ms (29.1 ms – 51.5 ms) | 13.5 ms (10.7 ms – 22.6 ms) | 11.1 ms (10.9 ms – 19.3 ms)       |
| usage-read / small | 19.4 ms (18.3 ms – 19.8 ms) | 11.0 ms (10.7 ms – 12.4 ms) | 10.5 ms (10.5 ms – 11.6 ms)       |
| balance / huge     | 7.7 ms (7.6 ms – 9.4 ms)    | 8.1 ms (7.4 ms – 8.5 ms)    | 7.5 ms (7.5 ms – 7.5 ms)          |
| balance / small    | 8.3 ms (8.1 ms – 8.4 ms)    | 7.0 ms (6.2 ms – 7.9 ms)    | 6.4 ms (6.1 ms – 6.9 ms)          |
| ingest / huge      | 9.0 ms (7.9 ms – 9.0 ms)    | 9.8 ms (9.0 ms – 10.7 ms)   | 14.1 ms (9.6 ms – 70.4 ms)        |
| ingest / small     | 9.1 ms (8.8 ms – 10.7 ms)   | 9.1 ms (8.7 ms – 18.8 ms)   | 12.9 ms (7.4 ms – 39.6 ms)        |

The spread between samples of the same code is as large as 2 to 3x for the 2 it/s `usage-read` p95 (29.4 ms in the main set, 11 to 14 ms in the other two), which is why only the interleaved pair is used for attribution. The ordering of the main set was a "slow state" of the machine (p50 of `balance` 6.0 to 6.6 ms against 3.6 to 4.1 ms in the first attempt).

## Attribution: which change caused which number

| Number                                                         | Change                             | Evidence                                                                                                                                                                  |
| -------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `usage-read` huge p95 161.2 to 29.4 ms, p50 93.4 to 15.6 ms    | **E1** (ORDER BY alias bug), alone | the only difference in code between the two interleaved sets; E1's own before/after (145.5 to 24.3 ms) was measured separately                                            |
| `usage-read` small, `balance`, `ingest`: no change             | none                               | indexes dropped (E4), partitions function (E6), ledger and queue changes (Step 0, E3) are not on these paths; E5 (round trips) was measured as a null result and reverted |
| Queue throughput 64.5 to 253.1 jobs/s                          | **E3** (claim indexes)             | `queue.md`-style benchmark, not part of this table                                                                                                                        |
| Saturation moved from below 5 it/s to between 100 and 200 it/s | **E1**                             | the same query, now index-ordered                                                                                                                                         |
| Credit write path and Step 0                                   | none measurable here               | no HTTP endpoint debits; `balance` unchanged (it reads `credit_balances` under the new SELECT-only policy)                                                                |

## Saturation: huge-tenant `usage-read`, 5, 10 and 20 iterations/s and beyond

Same script, profile and preflight as the baseline's "Saturation" section (30 s warmup + 60 s measure, k6 up to 400 VUs per scenario; each iteration is up to 3 paginated requests, so 10 it/s is about 30 requests/s). Raw: `raw/usage-read_huge_runsatf*` and `*_runsatg*`, `raw/p1.10-saturation*.log.txt`. A first launch of this script was aborted because a labelling bug would have overwritten repeated runs; its partial files are kept in `raw/aborted/`.

| Rate           | Baseline code (recorded; re-run in `baseline.md`)                                                                             | **Final code**                                                                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5 it/s         | p50 12.48 s, **p95 16.74 s**, p99 17.19 s, 606 requests, **81 dropped** (first probe: p95 14.37 s, 62 dropped)                | p50 5.0 ms, **p95 12.6 ms**, p99 23.5 ms, 900 requests, **0 dropped**, 0 failed                                                                                               |
| 10 it/s        | p50 32.65 s, **p95 36.39 s**, p99 37.25 s, 429 requests, **275 dropped** (first probe: p95 43.01 s, 275 dropped)              | 3 runs: p50 4.7 / 4.8 / 4.7 ms, **p95 11.4 / 11.3 / 11.3 ms**, p99 12.4 / 12.3 / 12.3 ms, 1,800 / 1,803 / 1,803 requests, **0 dropped**, 0 failed                             |
| 20 it/s        | p50 54.35 s, p95 59.99 s, 325 requests, **801 dropped, 36.62% of requests timed out** (first probe: p95 58.42 s, 801 dropped) | p50 4.5 ms, **p95 9.2 ms**, p99 11.1 ms, 3,600 requests, **0 dropped**, 0 failed                                                                                              |
| 40 it/s (new)  | not measured                                                                                                                  | p50 4.6 ms, p95 7.1 ms, p99 8.8 ms, 7,203 requests, 0 dropped, 0 failed                                                                                                       |
| 100 it/s (new) | not measured                                                                                                                  | p50 6.4 ms, **p95 18.0 ms**, p99 40.0 ms, 18,003 requests, **0 dropped**, 0 failed                                                                                            |
| 200 it/s (new) | not measured                                                                                                                  | **saturated**: p50 714 ms, p95 795 ms, p99 854 ms, 32,595 requests, **1,135 dropped**, 0 failed (about 168 iterations/s achieved, about 540 requests/s in the measured phase) |

Each rate was run once, except 10 it/s (3 runs), as in the baseline. The final-code probes ran in a faster state of the machine than the interleaved comparison (p50 4.5 to 5 ms), so their absolute values are not comparable with the 2 it/s table above. The improvement is from a queueing collapse (seconds of latency at 5 it/s) to a flat curve (about 10 ms) up to 100 it/s, so the size of the effect is orders of magnitude, far outside any session drift. Which component limits the system between 100 and 200 it/s (Postgres at 2 CPUs, the single Node process, or k6, all on one laptop) was not determined.

## Limitations

- One laptop, with k6, the API and Postgres all sharing the CPU; valid as a before/after comparison on this machine, not as absolute capacity.
- Session drift of up to about 2x in absolute latencies (see finding 5): only interleaved pairs are used for attribution; the recorded 2026-10-01 baseline is shown for continuity, not for subtraction.
- Three runs per scenario show the spread but are not confidence intervals. The 2 it/s `usage-read` p95 had one run (51.5 ms) well above the other two of its set.
- The saturation probes are single runs per rate (three at 10 it/s), as in the baseline.
- `tsx` on the fly, default settings, warm caches (see `baseline.md`).
