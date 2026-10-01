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
