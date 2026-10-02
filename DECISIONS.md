# Ledgerworks: DECISIONS.md

One entry per decision: options considered, choice, reason. Newest at the bottom.

## D1. Language and runtime: TypeScript (strict) on Node 22+

- **Options:** TypeScript, Go, Python.
- **Choice:** TypeScript with `strict` enabled, on Node 22 or newer.
- **Reason:** Specified in plan.md section 1. One language across API, UI, core and evals; strict mode catches errors at compile time.

## D2. Package manager and layout: pnpm workspaces

- **Options:** pnpm, npm workspaces, yarn.
- **Choice:** pnpm workspaces in a single monorepo.
- **Reason:** Specified in plan.md. Fast installs, strict dependency resolution, simple cross-package linking.

## D3. Database: Postgres 16 in Docker

- **Options:** Postgres 16, other Postgres versions, MySQL.
- **Choice:** Postgres 16 run through Docker Compose.
- **Reason:** Specified in plan.md. Row-level security, partitioning, `FOR UPDATE SKIP LOCKED` and `pg_stat_statements` are all needed by the project.

## D4. API framework: Fastify

- **Options:** Fastify, Express, Hono.
- **Choice:** Fastify.
- **Reason:** Specified in plan.md. Built-in schema validation and good performance.

## D5. Tests: Vitest

- **Options:** Vitest, Jest, node:test.
- **Choice:** Vitest.
- **Reason:** Specified in plan.md. TypeScript support without extra configuration, fast, workspace-aware.

## D6. Load testing: k6

- **Options:** k6, autocannon, wrk.
- **Choice:** k6.
- **Reason:** Specified in plan.md. Scripted scenarios with built-in percentile reporting and raw output export.

## D7. UI: React + Vite (where a UI is needed)

- **Options:** React + Vite, Next.js, no UI.
- **Choice:** A small React + Vite app, only where a UI is called for.
- **Reason:** Specified in plan.md. The UI is an admin and visualization layer, so a SPA is enough.

## D8. LLM access: provider-agnostic, no vendor SDK

- **Options:** a single vendor SDK, an abstraction library, our own interface.
- **Choice:** One `LLMProvider` interface with a generic OpenAI-compatible adapter and a hand-written agent loop.
- **Reason:** Specified in plan.md. Works with free-tier and local providers, and no vendor lock-in.

## D9. Lint, format and CI tooling

- **Options:** ESLint + Prettier, Biome.
- **Choice:** ESLint (flat config, typescript-eslint) and Prettier. CI on GitHub Actions running lint, typecheck and test.
- **Reason:** plan.md asks for ESLint and Prettier by name. Both are widely known.

## D10. Local database resource limits

- **Options:** no limits, limits sized to the host, small fixed limits.
- **Choice:** The `postgres` service is pinned to **2 CPUs** and **2 GiB memory** (`cpus: "2.0"`, `mem_limit: 2g`, `memswap_limit: 2g` so swap cannot hide memory pressure). Postgres settings are sized to match: `shared_buffers=512MB`, `effective_cache_size=1536MB`, `work_mem=16MB`, `maintenance_work_mem=128MB`, `max_connections=100`.
- **Reason:** plan.md section 1 rule 5 requires container limits to be recorded next to every benchmark. Fixed limits make results comparable across machines and runs. The values are a modest, reproducible profile that fits on a laptop; they are not tuned for peak throughput. The same numbers appear in `docker-compose.yml` and must be quoted in every benchmark report.
- **Extension:** `pg_stat_statements` is loaded through `shared_preload_libraries` and created at first init by `docker/initdb/01-extensions.sql`. `pg_stat_statements.track=all` so nested statements are counted.
- **Image:** `postgres:16`, Docker Hub official image. Local only; the compose file contains a development password and is not meant for any shared environment.

## D11. Migrations: plain SQL files with a small custom runner

- **Options:** a migration tool (node-pg-migrate, Flyway, dbmate, Atlas) or plain SQL files with our own runner.
- **Choice:** numbered plain SQL files in `ledgerline/migrations/` (`0001_schema.sql`, ...) applied by `ledgerline/src/db/migrate.ts`. Forward-only (no down migrations).
- **Reason:** the schema depends on Postgres features (roles, RLS, partitioning, `SECURITY DEFINER` functions) that ORMs and generators handle poorly, so raw SQL is the honest source of truth. The runner is about 100 lines: each file runs in its own transaction, applied versions are recorded in `schema_migrations` with a SHA-256 checksum, editing an already-applied file is an error, and a Postgres advisory lock stops two runners racing. Re-running is a no-op. Later phases (Ledgerlatch) analyze these same SQL files.
- **Cost:** no automatic rollback and no drift detection beyond checksums. Acceptable for this project.

## D12. Database roles

- **Options:** one role for everything; owner + app role; owner + app + a `BYPASSRLS` auth role.
- **Choice:** three non-superuser roles, created by the runner's bootstrap step (which needs a superuser connection, the compose user, via `DATABASE_ADMIN_URL`):
  - `ledgerline_owner`: `NOLOGIN`, owns every table and function; migrations run as this role through `SET ROLE`. Under `FORCE ROW LEVEL SECURITY` it is subject to policies like anyone else.
  - `ledgerline_app`: `LOGIN`, no `BYPASSRLS`, owns nothing, cannot create objects. The API connects only as this role (`DATABASE_URL`). Least-privilege grants per table are in `0001_schema.sql`: no UPDATE/DELETE on `credit_ledger`, `usage_events`, `dead_letters`; no writes at all on `tenants` and `users`.
  - `ledgerline_definer`: `NOLOGIN`, owns the `SECURITY DEFINER` functions (see D14).
- **Reason:** a table owner can bypass RLS unless `FORCE` is set, and a superuser or `BYPASSRLS` role always bypasses it, so the app must be none of those. The app password defaults to a development value (`LEDGERLINE_APP_PASSWORD`); set a real one anywhere shared.

## D13. Schema design and indexes

- **Ids:** `uuid` (`gen_random_uuid()`) for entities; `bigint identity` for append-only logs (`credit_ledger`, `job_attempts`, `dead_letters`). Identity columns on a partitioned table are avoided, so `usage_events` uses a uuid.
- **Users are global**, tenancy lives in `memberships`; `users` has no `tenant_id`.
- **`usage_events`:** range-partitioned by month on `occurred_at`, primary key `(id, occurred_at)` (the partition key must be in every unique constraint). The migration creates 48 monthly partitions, 2024-01 to 2027-12, deterministically, plus `create_usage_events_partition(date)` for P1.10's automatic creation. There is no default partition; an event outside the range is rejected (the API maps this to a 422).
- **Composite foreign keys** `(tenant_id, job_id) -> jobs (tenant_id, id)` on `job_attempts` and `dead_letters`, so a child row cannot reference another tenant's job.
- **Indexes added (and why)** - kept deliberately few so later phases have room to improve:
  - `users (lower(email))` unique: email identity.
  - `memberships (tenant_id, user_id)` unique: prevents duplicates, serves tenant lookups.
  - `api_keys (key_hash)` unique: the auth lookup path; `api_keys (tenant_id)`: tenant FK.
  - `usage_events (tenant_id, occurred_at)`: the one main read pattern (per-tenant time range); created per partition automatically.
  - `credit_ledger (tenant_id, id)`, and a partial unique `(tenant_id, idempotency_key)`: tenant reads and idempotent debits (P1.8).
  - `jobs (tenant_id, id)` unique (composite FK target), partial unique `(tenant_id, idempotency_key)`, and partial `(queue, run_at) WHERE status = 'queued'` for the worker poll (P1.9).
  - `job_attempts (job_id, attempt_no)` unique: attempt numbering and job FK.
  - `dead_letters (job_id)` unique, `(tenant_id, dead_at)`.
- **Deliberately not indexed:** `memberships.user_id` (users are never deleted), `usage_events` by event type or metadata, `job_attempts.tenant_id`. These are where the optimization work in P1.10 and Ledgerlens can show measured effects.
- **Append-only ledger:** enforced three ways: no UPDATE/DELETE/TRUNCATE privilege for the app role, a row trigger rejecting UPDATE and DELETE, and a statement trigger rejecting TRUNCATE (so even a superuser mistake is stopped).

## D14. Row-level security design and the API-key lookup problem

- **Tenant context:** the API opens a transaction and runs `SELECT set_config('app.tenant_id', '<uuid>', true)` (`true` = local to the transaction, so it cannot leak to the next user of a pooled connection). The helper `app_tenant_id()` returns the uuid, or NULL when the setting is missing, empty or malformed. Policies compare `tenant_id = (SELECT app_tenant_id())`; NULL never matches, so a missing setting means zero rows, not an error and not everything. The `(SELECT ...)` wrapper makes Postgres evaluate it once per statement.
- **Enable and force:** `ENABLE` and `FORCE ROW LEVEL SECURITY` on all ten tables, so the owner role obeys policies too. Policies are `TO ledgerline_app` only. `credit_ledger` has SELECT and INSERT policies and nothing else. `tenants` and `users` are readable only for the current tenant (users via membership) and have no write policy for the app.
- **API-key lookup (options):** (a) a `BYPASSRLS` auth role, (b) a policy on `api_keys` that allows lookup by hash, (c) a narrow `SECURITY DEFINER` function.
- **Choice:** (c). `ledgerline_fn.authenticate_api_key(hash)` returns only `(tenant_id, api_key_id)` for a non-revoked key whose full hash matches. A second function, `ledgerline_fn.create_tenant(...)`, creates a tenant, its owner membership, a zero balance and the first key hash, because the app role has no write access to `tenants` or `users`.
- **Why not (a) or (b):** `BYPASSRLS` is all-or-nothing and would be a standing risk. A hash-lookup policy on `api_keys` would also expose key rows to any tenant that guessed or knew a hash, and mixes auth logic into data policies.
- **How the definer is contained:** both functions are owned by `ledgerline_definer` (`NOLOGIN`, no `BYPASSRLS`, not a superuser). It has table privileges only on what the two functions need (`tenants`, `users`, `memberships`, `api_keys`, `credit_balances`) with permissive policies on exactly those tables, and nothing at all on the ledger, jobs or usage data. Functions pin `SET search_path = pg_catalog, pg_temp` and reference tables schema-qualified, which blocks search-path hijacking. `EXECUTE` is revoked from `PUBLIC` and granted only to `ledgerline_app`.
- **Risks that remain:** (1) whoever can run `set_config('app.tenant_id', ...)` on an app connection chooses the tenant, so the API must set it only from the authenticated key and never from request input; the database cannot defend against a compromised API process. (2) `authenticate_api_key` is an oracle: anyone with app-role access can test hashes, which is harmless because keys are 256-bit random and only their hash is compared. (3) `create_tenant` lets a caller attach any email as owner of a new tenant; it grants no access to existing tenants. The HTTP endpoint is optionally gated by a token (D16).
- **Partitions:** RLS is declared on the partitioned parent. The app role has no privileges on the individual partitions, so they can only be reached through the parent (tested).
- **Migration/seed note:** because the owner is also subject to `FORCE`, bulk seeding (P1.6) must either run as a superuser or set the tenant per statement.

## D15. Isolation test strategy

- **Choice:** a table-driven matrix in `ledgerline/test/isolation.test.ts`: every tenant-owned table x {SELECT, INSERT, UPDATE, DELETE} x {tenant A, tenant B, no tenant set, a role with no grants}, run as the real application role over a real connection (not by `SET ROLE` from a superuser). Each cell asserts the specific failure mode: a privilege error where the app was never granted the operation, an RLS violation for cross-tenant inserts and tenant-moving updates, and zero affected rows for cross-tenant reads, updates and deletes. Positive controls (own-tenant reads, own-tenant inserts) make sure the denials are not simply because everything fails. Extra guards cover malformed tenant settings, `row_security = off`, `SET ROLE`, disabling RLS or triggers, ledger immutability, direct partition access, grants matching the matrix, and the definer functions.
- **Verified to bite:** with the `jobs` policy temporarily changed to `USING (true)`, the matrix failed on the jobs cells.
- **Output:** the run prints `ISOLATION SUMMARY: N isolation tests, M isolation assertions`.
- **Where Postgres comes from:** locally the docker-compose Postgres (database `ledgerline_test`, recreated and migrated by a Vitest global setup); in CI a `postgres:16` service container.

## D16. HTTP API design (P1.5)

- **Validation:** Fastify's built-in JSON Schema validation (Ajv), with `additionalProperties: false` on every body and query, `removeAdditional` and `coerceTypes` off (so `"name": 123` is rejected rather than silently turned into a string). Options considered: Zod or TypeBox with a Fastify type provider. Built-in schemas were chosen to avoid another dependency; the cost is hand-written TypeScript types next to the schemas. `limit` is a digit string parsed by the handler because query strings are always strings and coercion is off.
- **Authentication:** `Authorization: Bearer <key>`. Key format `lk_<8 hex>_<43 base64url>` (256-bit secret). Only the SHA-256 hash is stored, plus the visible prefix. A plain fast hash is appropriate here because the key is high-entropy random, so there is nothing to brute-force; a slow password hash would only add request latency. Malformed, unknown and revoked keys all return the same 401 with `WWW-Authenticate: Bearer`, and authentication runs before body validation. Lookup goes through the `SECURITY DEFINER` function from D14.
- **Tenant per request:** authenticated handlers run `withTenant()`: one transaction, `set_config('app.tenant_id', <id from the verified key>, true)`, commit or rollback. The tenant id is never read from request input (a body containing `tenant_id` is rejected as an unknown field).
- **Tenant creation:** `POST /v1/tenants` returns the raw key exactly once (`Cache-Control: no-store`). It is unauthenticated by nature. If `TENANT_CREATION_TOKEN` is set, it requires `x-admin-token` (constant-time comparison); if unset it is open and the server logs a warning at startup. This is a development convenience; a real deployment would put tenant creation behind its own admin auth.
- **Errors:** every error is `{ "error": { "code", "message", "requestId", "details"? } }`. Validation errors list `path` and `message` only. Unexpected errors return a generic 500 with no message or stack; the full error goes to the server log only. A write outside the partition range returns 422 `occurred_at_out_of_range`.
- **Logging:** pino via Fastify with a per-request UUID (`requestId` in every log line, `x-request-id` response header). Logs never include headers or bodies; the server config also redacts `req.headers.authorization` as a second line of defense. A test sends valid, invalid and garbage credentials and asserts none of them (nor `authorization`/`bearer`, nor the key hash) appear in the captured log output.
- **Pagination:** keyset on `(occurred_at DESC, id DESC)` with an opaque base64url cursor carrying microsecond-precision timestamp text (JS dates would truncate to milliseconds and could skip or repeat rows). The query always includes an explicit `tenant_id` predicate in addition to RLS so the planner can use the tenant index.
- **Not included yet:** rate limiting, usage-event idempotency keys, credit debits on ingest (P1.8), API key rotation endpoints.

## D17. Seeding: how it bypasses forced RLS, and its safety limits

- **Options:** (a) run as the compose superuser; (b) a dedicated seeding role with `BYPASSRLS`; (c) run as the app role and set the tenant per statement; (d) add permissive seed-only policies.
- **Choice:** (a): `pnpm seed` connects with `DATABASE_ADMIN_URL` (the compose superuser), which bypasses `FORCE ROW LEVEL SECURITY`.
- **Why:** it needs the least new machinery. (b) would create a standing `BYPASSRLS` role that must then be guarded forever. (c) is impossible for the reset (the app role cannot delete) and awkward for 10M rows across 250 tenants. (d) would put seed-only exceptions in the production policy set, which the isolation tests exist to keep clean.
- **Risks and mitigations:**
  - The seed is a destructive tool. It refuses to run unless the admin URL's host is local (`localhost`, `127.0.0.1`, `::1`) and the database is exactly `ledgerworks`, and unless `--yes` is passed; without `--yes` it prints what it would delete and exits non-zero. These guards are unit-tested (`src/seed/seed.test.ts`). The test database `ledgerline_test` is also refused.
  - It is never reachable from the API: it lives in `src/seed/`, is imported by nothing, and the API process only holds the app-role connection string, not the admin URL.
  - The reset uses `session_replication_role = replica` for a single `TRUNCATE` statement so that the ledger's append-only truncate trigger does not block it, then resets the setting. That is the only place the append-only guard is bypassed, and it needs superuser.
- **Data model (all synthetic):** 250 tenants; usage events per tenant follow a Zipf curve (`share ~ 1 / rank^1.2`), so the largest tenant holds about a quarter of all events and the smallest about 3.4k. Events cover 2025-10-01 to 2026-09-30 (UTC, 12 monthly partitions) with a weekday/weekend pattern, linear growth over the year and a diurnal hourly curve. Everything (ids, timestamps, quantities) is a pure function of the seed value (`md5` of `seed:tenant:month:index`); only API key secrets are random. Generation is set-based: one `INSERT ... SELECT ... generate_series` per month.
- **Credits:** per tenant and month one grant, one debit equal to 1 credit per 100 usage units (computed from the seeded events), and occasional refunds; the balance is the ledger sum, verified after every seed (mismatches must be 0).
- **Keys:** every tenant gets one API key; raw keys for five sample tenants (huge, large, medium, small, tiny) are written to the gitignored `.seed/keys.json` (mode 600) and are never printed.
- **Not tuned:** the seed loads into the tables with their indexes in place and runs plain `ANALYZE` afterwards, no `VACUUM`, no extra indexes, no changed settings, so the data starts in the same state the benchmarks measure.

## D18. Credit debit and refund (P1.8)

- **Options:** (a) a transaction written in the API code; (b) a plpgsql function that runs as the caller (`SECURITY INVOKER`); (c) a `SECURITY DEFINER` function with the app role's direct write privileges on the ledger and balances revoked.
- **Choice:** (b): `ledgerline_fn.debit_credits(amount, key, reference)` and `ledgerline_fn.refund_credits(debit_id, amount, key, reference)`, created in migration 0003.
- **Why:** the logic and the lock live in one place and one round trip, next to the data, instead of being re-implemented by each caller (a). Running as the caller keeps forced RLS and the existing grants in force, with the tenant taken from `app_tenant_id()` and never from a parameter, so a function call cannot touch another tenant (tested). (c) is stronger but would rewrite the privilege matrix and isolation tests; deferred (see risks).
- **Locking:** the first statement is `SELECT ... FROM credit_balances WHERE tenant_id = <current> FOR UPDATE`. All debits and refunds of one tenant serialise on that row; different tenants do not block each other. The balance check, the ledger INSERT and the balance UPDATE then happen in the same transaction. The `CHECK (balance >= 0)` constraint remains as a second line of defence.
- **Idempotency (unique per tenant):** a debit takes a required key. The lookup by key happens after the lock is held, so concurrent requests with one key queue behind the first and then see its committed row. Same key and same amount returns the original result (`replayed = true`, original ledger id and original balance after the debit) and writes nothing. **Same key with a different amount (or a key that belongs to a refund) is rejected with outcome `idempotency_conflict`, not accepted and not applied.** A rejected debit (`insufficient_credits`) writes nothing, so it does not occupy the key; a later retry with the same key is evaluated afresh. Keys share one namespace per tenant across debits and refunds (the existing partial unique index on `(tenant_id, idempotency_key)` is the database-level backstop).
- **Refunds:** a refund references one debit (`refund_of`), is itself idempotent by its own key, can be for any amount from 1 up to the original debit amount, and **a debit can be refunded at most once** (a unique index on `refund_of` backs the function's own check). Repeated partial refunds were deliberately not designed; a second refund of the same debit returns `already_refunded` whatever its amount. A refund is a new ledger row; nothing is ever updated. Outcomes: `refunded`, `debit_not_found` (unknown id, another tenant's debit, or a non-debit row), `refund_exceeds_debit`, `already_refunded`, `idempotency_conflict`.
- **Schema additions (0003):** `credit_ledger.balance_after` and `refund_of`; a composite foreign key `(tenant_id, refund_of) -> (tenant_id, id)` so a refund can only point at the same tenant's row (otherwise one tenant could "refund" another's debit and block it), which needs a unique `(tenant_id, id)`; checks that `refund_of` only appears on refunds and that amounts have the right sign per kind (debit negative, grant and refund positive). The existing seeded rows satisfy all of this (verified by applying 0003 to the seeded database: 0 ledger-vs-balance mismatches). Seeded refund rows are goodwill refunds with no `refund_of`, so seeded debits can still be refunded once through the function.
- **Risks:** (1) the invariant "ledger sum equals balance" holds for everything that goes through these functions; the app role still has direct INSERT on `credit_ledger` and UPDATE on `credit_balances`, so buggy application code could write around them. Revoking those grants and making the functions `SECURITY DEFINER` is the stronger follow-up. (2) Per-tenant serialisation bounds a single tenant's debit rate. (3) The old non-unique index `credit_ledger (tenant_id, id)` is now redundant with the new unique constraint; left in place on purpose (no tuning in this task; logged in `docs/optimization-log.md`).
- **Verification:** `ledgerline/test/credits.test.ts`, real Postgres, 50 separate connections. Mutation check: with `FOR UPDATE` removed from `debit_credits`, the 10,000-debit test failed: all 10,000 debits were accepted and none rejected, 55,225 credits were debited against a supply of 25,000, ledger sums went negative (-30,225 in total against balances of 15,491) and all 5 tenants had a ledger-vs-balance mismatch. With the lock restored, the same test accepts about 4,570 and rejects about 5,430 with no overdraft and no mismatch.

## D19. Job queue (P1.9)

- **Delivery semantics: at-least-once, with at most one live lease per job. Not exactly-once.** A job is claimed with `FOR UPDATE SKIP LOCKED` and leased for a fixed time. If its worker never acknowledges (it crashed, or the handler outlived the lease), the job becomes claimable again once the lease has expired, so a handler can run more than once, for example after a crash that happens after the side effect but before the acknowledgement. Handlers must be idempotent (the credit functions, for instance, take idempotency keys). Acknowledgements are fenced by attempt number and worker id: if a stale worker reports back after its lease was lost and the job re-claimed, `complete_job` returns `false` and `fail_job` returns `stale`, and the newer attempt is untouched. Handler work and the acknowledgement are separate transactions, which is exactly why this is not exactly-once.
- **States:** `queued` (waiting), `running` (leased), `failed` (the last attempt failed, a retry is scheduled at `run_at`; claimable once due), `succeeded`, `dead` (retries exhausted, a `dead_letters` row exists). Every claim writes a `job_attempts` row (`attempt_no`, `worker_id`, start); the acknowledgement or lease expiry closes it with an outcome and error.
- **Claim:** one SQL function, `claim_jobs(worker, queue, limit, lease_ms, now)`: (1) dead-letters jobs whose lease expired with all attempts used (in the same statement as the dead-letter insert), (2) picks runnable rows with `ORDER BY run_at, id LIMIT n FOR UPDATE SKIP LOCKED` (queued or failed and due, or running with an expired lease), (3) closes the previous attempt as `lease expired`, (4) marks them running with a new lease and inserts the new attempt row. No new indexes were added (the existing partial index only covers `status = 'queued'`); the resulting scan cost is logged as an observation, not tuned.
- **Retries:** exponential backoff with jitter, capped, computed by the caller (`retryDelayMs`: base 1 s, factor 2, cap 60 s, "equal jitter": half fixed, half random). Max attempts is per job (default 5). After the last attempt `fail_job` moves the job to `dead` and inserts the `dead_letters` row in the same transaction.
- **Time is injectable:** every function takes `p_now`, and TypeScript code takes a `Clock` (`FakeClock` in tests). Tests do not sleep.
- **Enqueue:** `enqueue_job(...)` with an optional idempotency key, unique per tenant (the existing partial unique index; `INSERT ... ON CONFLICT DO NOTHING` then a lookup). The same key returns the existing job, and the first call's payload wins. Without a key every call creates a new job.
- **RLS design (options):** (a) a worker role with `BYPASSRLS`; (b) workers connect as the app role and the claim is an ordinary function; (c) a narrowly scoped `SECURITY DEFINER` claim function that only a dedicated worker role may execute, with everything else tenant-scoped.
- **Choice: (c).** Workers must claim across tenants, which RLS forbids to the app role, so `claim_jobs` is a `SECURITY DEFINER` function owned by `ledgerline_definer`, executable **only** by a new `ledgerline_worker` login role (no `BYPASSRLS`, no table privileges at all; created by the bootstrap step). A worker process holds two connections pools: the worker role only to claim, and the ordinary app role for everything else. `claim_jobs` returns the tenant id; the handler's database work then runs through `withTenant(job.tenantId)` as the app role, so RLS applies to it, and `complete_job` and `fail_job` are `SECURITY INVOKER` functions that run in that tenant transaction and can only touch that tenant's job. The definer role was extended for this: `SELECT, UPDATE` on `jobs`, `SELECT, INSERT, UPDATE` on `job_attempts`, `INSERT` on `dead_letters`, each with a permissive policy for the definer only (this supersedes the statement in D14 that it has no access to job tables; the isolation tests now assert the exact privilege set).
- **Risks:** (1) whoever holds the worker role's credentials can claim and read the payloads of every tenant's jobs; protect it like a database credential and never give it to the API process. (2) A compromised worker process can run a handler with any tenant id it was handed; the database cannot tell that the id is genuine. (3) `claim_jobs` is a single point where cross-tenant data is visible; it is kept short, pins `search_path`, and returns only the fields a worker needs. (4) A handler that outlives its lease will run concurrently with a re-claim; there is no lease renewal yet.
- **Tests:** `ledgerline/test/queue.test.ts` (failure injection with the backoff schedule checked to the millisecond, dead letters with attempt history, crash and lease-expiry behaviour including fencing of a stale worker, idempotent enqueue, access control) and, at full size, `ledgerline/test/concurrency/queue-10k.test.ts` (50 workers, 10,000 jobs).

## D20. Test organisation: default run versus `pnpm test:concurrency`

- **Problem 1:** test files share one Postgres database and, with Vitest's default of running files in parallel, their connection pools together exceeded `max_connections` (100) once the credit and queue tests existed. `fileParallelism` is only honoured as a global Vitest option, not per project, so both scripts now pass `--fileParallelism=false`.
- **Problem 2:** the full-size queue test (50 workers, 10,000 jobs) takes minutes on the unmodified claim query (see `docs/benchmarks/queue.md`). It lives in `ledgerline/test/concurrency/` and runs through `pnpm test:concurrency`, which sets `CONCURRENCY=1` so the Vitest workspace contains only that project.
- **Not moved:** the 10,000-debit, 50-worker credit test takes about 15 s and stays in the default `pnpm test`.
- **CI:** see the workflow: lint, typecheck and `pnpm test` as before, plus a separate `pnpm test:concurrency` step with its own timeout.

## D21. Ledger invariant hardening: SECURITY DEFINER debit and refund (Step 0 before P1.10)

- **Problem:** D18 chose `SECURITY INVOKER` functions and recorded the gap: the app role still had `INSERT` on `credit_ledger` and `INSERT, UPDATE` on `credit_balances`, so any application code could write around the functions and break "ledger sum equals balance".
- **Options:** (a) keep invoker functions and rely on code review; (b) make the functions `SECURITY DEFINER` owned by the existing `ledgerline_definer`; (c) make them `SECURITY DEFINER` owned by a **new, dedicated** NOLOGIN role `ledgerline_ledger`, and revoke the direct grants from the app role.
- **Choice: (c)** (migration `0005_ledger_invariant.sql`). `ledgerline_definer` already can insert tenants, users and API keys; adding ledger writes to it would make one role the owner of unrelated powers. `ledgerline_ledger` has exactly `SELECT, INSERT` on `credit_ledger` and `SELECT, UPDATE` on `credit_balances`, and nothing else (asserted by tests, including that it has no `DELETE`, no other table and no `BYPASSRLS`).
- **RLS stays in force inside the functions.** The ledger role's policies are tenant-scoped, not permissive: `tenant_id = (SELECT app_tenant_id())` for read, append and balance access. So even a bug inside a function body cannot read or write another tenant's rows, and the tenant still comes from the session setting and never from an argument (the function signatures are unchanged). This is the main difference from the permissive `definer_access` policies of D14.
- **The app role now has `SELECT` only** on `credit_ledger` and `credit_balances`. The old write policies (`tenant_append`, the `FOR ALL` balances policy) were dropped and replaced by a `SELECT` policy, so there is neither a privilege nor a policy to write with.
- **`search_path`:** `pg_catalog, pg_temp`, set on both functions. The bodies were already fully schema-qualified (`public.credit_ledger`, `public.app_tenant_id()`); a test creates temporary tables with the same names, puts `pg_temp` first in the caller's `search_path`, and shows the writes still go to the real tables.
- **The function bodies did not change** (same file `0003`, same mutation target). Only the execution context changed.
- **Seed and tests:** the seed runs as the superuser and is unaffected. Tests that need balances or ledger rows set up fixtures as the admin role.
- **Residual risks:**
  1. **The caller still chooses the tenant by setting `app.tenant_id`.** Whoever can run `set_config('app.tenant_id', ...)` on an app connection can debit that tenant (the function trusts the setting). The database cannot defend against a compromised API process; the API sets the setting only from the authenticated key (D14, D16). This is unchanged, and not made worse.
  2. Any caller holding the app role can spend a tenant's credits through `debit_credits` with a fresh idempotency key. That is the function's purpose; authorisation of the amount is the API's job.
  3. A bug in the two function bodies is now a bug in code that runs with write rights. The mitigations are the tenant-scoped policies above, the pinned `search_path`, the `CHECK (balance >= 0)` and sign constraints, the append-only triggers, and the tests.
  4. `adjustment` and `grant` rows can no longer be created by the app role at all (before, it could insert them directly). There is no API for granting credits yet; when one is added it needs its own definer function.
- **Verification:** `isolation.test.ts` matrix updated (the app role's INSERT and UPDATE on those tables are now privilege-denied in every context), plus tests for the ledger role's exact privileges and tenant-scoped policies; `credits.test.ts` has new tests that the app role cannot insert into the ledger or write balances directly (own tenant, other tenant, no tenant), that tenant A's call cannot affect tenant B even when it passes B's debit id or B's idempotency key, and that `search_path` shadowing does not redirect writes. **Mutation check re-run:** with `FOR UPDATE` removed from `debit_credits`, the 10,000-debit test failed (10,000 accepted, 0 rejected; raw output `docs/benchmarks/raw/mutation-check-row-lock-after-0005.txt`); with the lock, about 4,570 are accepted and about 5,430 rejected. The seeded database was migrated forward (0 mismatches) and then re-seeded from scratch: ledger-sum vs balance mismatches 0, fingerprints identical to the earlier seeds.
- **Supersedes:** the "risks (1)" and the option (c) deferral in D18.
