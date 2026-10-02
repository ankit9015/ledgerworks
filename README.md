# Ledgerworks

One repository, three connected projects around Postgres performance and safety, with measured results and an honest account of what did not work.

| Package                               | Role                                                                                                                                                                         | Status               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| [`ledgerline/`](ledgerline/README.md) | **The patient.** A multi-tenant backend (usage metering, credits, job queue, row-level security) with a load-test report, an optimization log, observability and an admin UI | **Phase 1 complete** |
| `ledgerlens/`                         | The tuner: finds slow queries and proves each proposed fix on a shadow copy                                                                                                  | planned, not started |
| `ledgerlatch/`                        | The safety check: tests migrations for lock risk on a production-sized shadow database                                                                                       | planned, not started |
| `core/`, `evals/`, `ui/`              | Shared engine, evaluation gauntlets, shared components                                                                                                                       | placeholders         |

## Results in one table (details, sources and limits in [ledgerline/README.md](ledgerline/README.md))

| What                                            | Result                                                                              | Source                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Usage read, largest tenant, p95                 | 161.2 ms to **29.4 ms**; cause: an application bug (`ORDER BY` alias), not indexing | [after.md](docs/benchmarks/after.md), [E1](docs/optimization-log.md) |
| Saturation of that endpoint                     | from queueing at 5 it/s to **0 dropped up to 100 it/s**                             | [after.md](docs/benchmarks/after.md)                                 |
| Job queue throughput (one method, 3 fresh runs) | 64.5 to **253.1 jobs/s**                                                            | [E3](docs/optimization-log.md)                                       |
| Credit debits, 50 workers, 10,000 debits        | no overdraft, no double-spend; the lock's mutation check fails the test             | [credits.test.ts](ledgerline/test/credits.test.ts)                   |
| Tenant isolation                                | 182 tests, 772 assertions                                                           | [isolation.test.ts](ledgerline/test/isolation.test.ts)               |
| Row-level security cost                         | +0.07 to +0.16 ms per transaction; **within the noise** end to end                  | [rls-overhead.md](docs/benchmarks/rls-overhead.md)                   |
| Changes tried                                   | 8: 2 latency/throughput wins, 3 storage/operations, 3 null results                  | [optimization-log.md](docs/optimization-log.md)                      |

Everything was measured on one laptop with the load generator, the API and Postgres sharing the CPUs, on synthetic data: the numbers are relative, not absolute capacity.

## Try it

Needs Docker, Node 22+ and pnpm 9.

```bash
pnpm install --frozen-lockfile
pnpm demo        # Postgres, migrations, demo seed, API on :3000, admin UI on :5173
```

Then open http://localhost:5173 and paste the demo key it prints. More commands, the architecture diagram and the limits are in [ledgerline/README.md](ledgerline/README.md).

## Repository map

- [plan.md](plan.md): the project plan and its checkboxes. [PRODUCT.md](PRODUCT.md): persona, goals, non-goals, success metrics. [DECISIONS.md](DECISIONS.md): every decision with options, choice and risks.
- [docs/benchmarks/](docs/benchmarks/): reports and raw output of every run. [docs/optimization-log.md](docs/optimization-log.md): the log. [docs/observability.md](docs/observability.md): traces, metrics, dashboard.

License: [MIT](LICENSE).
