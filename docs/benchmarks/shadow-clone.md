# Shadow clone of the 10M-row benchmark database (C2.1)

All data is **synthetic** (`pnpm seed --yes`, seed `20251001`, the same fingerprints as `seed.md`). Raw output: `raw/c2.1-full-clone-20261003T041809Z.json`, `raw/c2.1-sampled-clone-20261003T041809Z.json` (written by `pnpm test:shadow-full`, one full and one sampled clone, run once; the files hold the complete manifests and the logs). Design: DECISIONS.md D29 to D33.

|                   |                                                                                                                                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source            | Postgres 16.15 in Docker, `ledgerworks-postgres`, limits 2 CPUs / 2 GiB (docker-compose.yml, D10), read through the role `shadow_reader` (`pg_read_all_data`, `BYPASSRLS`, `default_transaction_read_only`) |
| Shadow            | `ledgerworks/shadow-postgres:16.15-hypopg1.4.3` (`sha256:af9fe3cb...`), **2 CPUs / 3 GiB**, no swap, `shm` 256 MB, own volume, 2 COPY streams                                                               |
| Machine           | Intel Core i5-1135G7 (4 cores / 8 threads), Windows 11, Docker Desktop VM with **8 CPUs / 9.6 GiB** (both containers share it and one disk)                                                                 |
| Source during run | nothing else running; the source container was not OOM-killed and not restarted (`State.OOMKilled` false, `RestartCount` 0 before and after, same `StartedAt`)                                              |

## Full clone

| Stage                                               | Duration                       |
| --------------------------------------------------- | ------------------------------ |
| preflight                                           | 0.5 s                          |
| container start                                     | 2.2 s                          |
| schema dump                                         | 0.5 s                          |
| restore pre-data                                    | 0.4 s                          |
| **copy data**                                       | **34.7 s**                     |
| restore post-data (indexes, keys, policies, `-j 2`) | **51.7 s**                     |
| `ANALYZE`                                           | 3.5 s                          |
| verify counts                                       | 0.9 s                          |
| other stages                                        | under 0.1 s each               |
| **Total**                                           | **97.8 s** (wall clock 97.9 s) |

- Rows: `usage_events` 10,000,000 in source and shadow (all 12 non-empty partitions equal); every table: shadow rows = source rows, ratio 1.
- Schema: 873 structural lines (relations, columns, indexes, constraints, policies, functions, triggers, sequences) compared; 0 differences.
- Source untouched: counts, checksums of the small tables and the `pg_stat_database` / `pg_stat_user_tables` write counters identical before and after (`tup_inserted` 10,016,816, `tup_updated` 1,040, `tup_deleted` 296 both times).
- Memory of the shadow: sampled working set peak **1,739 MiB** (`docker stats`, 32 samples, so short peaks can be missed); cgroup `memory.peak` **3,072 MiB**, which is the container limit: it includes page cache from writing about 2.3 GB, which the kernel reclaims, and nothing was killed. So the true minimum is between those numbers and **not** established; only 2 CPUs / 3 GiB is verified.
- Memory of the source during the clone: peak 1,128 MiB of 2 GiB (sampled).

## Sampled clone (10% of tenants, seed 20251001)

|                                           | Source         | Shadow      | Ratio     |
| ----------------------------------------- | -------------- | ----------- | --------- |
| tenants (root)                            | 250            | 22          | 0.088     |
| users (referenced)                        | 1,543          | 120         | 0.078     |
| memberships                               | 1,543          | 120         | 0.078     |
| credit_ledger                             | 6,053          | 530         | 0.088     |
| **usage_events**                          | **10,000,000** | **289,749** | **0.029** |
| schema_migrations (no link, copied whole) | 11             | 11          | 1.0       |

- **The 10% is of tenants, not of data**: the kept tenants are small ones (the sizes follow a Zipf curve), so the biggest table has 2.9% of its rows. Anything measured on this shadow is not full-scale (D32).
- Integrity: 10 foreign keys checked with an anti-join, 0 orphans (the database also validated every key when it was created).
- 16.2 s in total (copy 5.4 s, post-data 1.5 s), shadow peak 112 MiB sampled.

## Small clone (the `ledgerline_demo` database, 30,600 usage events)

Raw: `raw/c2.1-small-clone-results-20261003T042500Z.json` (written by the core test suite, which CI runs). Full clone 5.4 s in total; 870 structural lines compared, 0 differences; row counts and md5 checksums of all 58 tables equal; sampled clone, failure cleanup, orphan cleanup and "source unchanged" results are in the same file.

## Re-measurement with settling as the default (additional full clone)

Raw: `raw/c2.1-full-clone-settle-default-20261003T083804Z.json`, `raw/c2.1-sampled-clone-settle-default-20261003T083804Z.json` (one full and one sampled clone, run once). Same source, shadow limits and machine as above; `createShadow` now ends with a **settle** stage (wait for autovacuum, `VACUUM (ANALYZE)`, `CHECKPOINT`), recorded separately in the manifest (`stages`, `settle`, `cloneDurationMs`).

|                                  | earlier run (no settle)                    | this run                                                                                |
| -------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------- |
| clone stages (`cloneDurationMs`) | 97.8 s                                     | **142.8 s**                                                                             |
| copy data                        | 34.7 s                                     | 61.2 s                                                                                  |
| restore post-data                | 51.7 s                                     | 65.8 s                                                                                  |
| `ANALYZE`                        | 3.5 s                                      | 6.8 s                                                                                   |
| **settle stage**                 | -                                          | **13.5 s** (waited for autovacuum 0.02 s, `VACUUM (ANALYZE)` 7.0 s, `CHECKPOINT` 6.6 s) |
| total                            | 97.8 s                                     | 156.4 s                                                                                 |
| shadow peak memory               | 1,739 MiB sampled, cgroup 3,072 MiB        | 1,756 MiB sampled (52 samples), cgroup 3,072 MiB                                        |
| source container                 | not OOM-killed, 0 restarts, peak 1,128 MiB | not OOM-killed, 0 restarts, peak 1,087 MiB                                              |

- **The clone itself was 45 s slower in this run than in the first, with nothing changed in that part of the code**: every stage that does real work (copy, indexes, `ANALYZE`) was slower, so the difference is the machine (a laptop that was not otherwise controlled), not settling. Treat the two clone times as one measurement each and their difference as noise of that size; the settle stage cost, 13.5 s, is the figure this run adds. Settle found no autovacuum to wait for because the explicit `VACUUM` of a clone that had just been analysed started first.
- Row counts, schema equality (873 lines), the source-unchanged fingerprint and the sampled integrity check (10 foreign keys, 0 orphans) held again. Sampled clone: 20.0 s clone stages + 2.7 s settle.
