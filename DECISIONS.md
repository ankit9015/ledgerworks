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
