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
