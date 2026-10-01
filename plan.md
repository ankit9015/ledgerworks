# Ledgerworks: plan.md

Instructions for Claude Code. Read this whole file first, then work phase by phase.

## 0. What we are building

**Ledgerworks** is one monorepo with three connected projects around Postgres performance and safety:

| Package | Role | One line |
|---|---|---|
| `ledgerline/` | The patient | A multi-tenant backend (usage ledger, credits, job queue, RLS) with its own load-test report and optimization log |
| `ledgerlens/` | The tuner | Finds slow queries and proves each proposed fix on a shadow copy (before/after measurements) |
| `ledgerlatch/` | The safety check | Tests migrations for lock risk on a production-sized shadow DB and rewrites unsafe ones |
| `core/` | Shared engine | Shadow DB runner, measurement harness, provider-agnostic LLM interface + agent loop, MCP server |
| `evals/` | Proof | Gauntlets of planted problems, per-model comparison tables |

Story in one sentence: *Ledgerline is a data-heavy backend, Ledgerlens tunes it, and Ledgerlatch makes sure the fixes ship safely.*

Target roles for the author: AI-native product engineer and AI-native full stack engineer. So every package needs (a) measured numbers, (b) a product layer (persona, decisions, instrumentation), and (c) real AI tool-use that is judged on outcomes.

## 1. Ground rules (apply to every phase)

1. **Clean-room.** The author's employer has proprietary code. Never read, copy or imitate it. Everything here is designed from scratch from public docs. Do not name any employer in code, docs or commits.
2. **Stack:** TypeScript (strict), Node 22+, pnpm workspaces, Postgres 16 in Docker, Fastify for APIs, Vitest for tests, k6 for load, a small React + Vite UI where a UI is called for. Ask before changing the stack.
3. **LLMs are provider-agnostic.** No dependency on any single vendor SDK. One `LLMProvider` interface, a generic OpenAI-compatible adapter (`baseURL + apiKey + model`) covering Groq, OpenRouter, Together, Ollama and similar. The agent loop is hand-written. Free-tier rate limits (429s) must be handled with backoff and clear UI states.
4. **Never auto-apply.** Ledgerlens and Ledgerlatch only propose changes. Experiments run on a shadow copy, never on the source database. Connections to user databases use a read-only role and statement timeouts.
5. **Numbers must be defensible.** Record seed size, container CPU/memory limits, request counts and Postgres version next to every benchmark. Label synthetic data as synthetic. Never invent or estimate a result: run it and paste the real output.
6. **Secrets.** API keys are never logged and never committed. Provide `.env.example` only.
7. **Working style.** Work one task at a time. After each task: run its tests, run lint and typecheck, commit with a clear message, and tick the box in this file. At the end of each phase, stop and summarize what was done and what was measured before starting the next phase.
8. **If a task's acceptance criteria cannot be met**, say so plainly, explain why, and propose options. Do not weaken the criteria silently.

## 2. Repo layout

```
ledgerworks/
├── plan.md
├── README.md                 # leads with results, then architecture, then one-command demo
├── PRODUCT.md                # persona, problem, goals, non-goals, success metrics
├── DECISIONS.md              # one entry per decision: options, choice, reason
├── docker-compose.yml        # pinned CPU/memory limits
├── package.json              # pnpm workspace root
├── ledgerline/               # patient app (API + admin UI + migrations + seed + k6)
├── core/                     # shared engine
├── ledgerlens/               # tuner (later phase)
├── ledgerlatch/              # migration checker (later phase)
├── ui/                       # shared React components (plan diagram, timeline, workflow chain, verdict card)
├── evals/                    # gauntlets + model comparison (later phase)
└── docs/
    ├── optimization-log.md   # before/after EXPLAIN ANALYZE, one entry per win
    └── benchmarks/           # raw k6 outputs and reports
```

## 3. Phase 1: Ledgerline (weeks 1-2)

Purpose: a realistic, data-heavy, multi-tenant backend that is fast, correct under concurrency, and later serves as the "patient" for Ledgerlens and Ledgerlatch.

### Product framing (write first)
- [x] **P1.0** Create `PRODUCT.md` and `DECISIONS.md`.
  - Ledgerline persona: a developer building an AI product who needs per-customer usage metering, credits and background jobs without writing it from scratch.
  - Include goals, non-goals, success metrics.
  - **Done when:** both files exist and `PRODUCT.md` states one persona, one problem, three non-goals and at least three measurable success metrics.

### Setup
- [x] **P1.1** pnpm workspace, TypeScript strict config, ESLint, Prettier, Vitest, GitHub Actions workflow (lint, typecheck, test).
  - **Done when:** `pnpm lint && pnpm typecheck && pnpm test` passes locally and in CI on an empty skeleton.
- [x] **P1.2** `docker-compose.yml` with Postgres 16, `pg_stat_statements` enabled, CPU and memory limits pinned and documented.
  - **Done when:** `docker compose up -d` gives a database where `SELECT * FROM pg_stat_statements LIMIT 1` works.

### Schema and isolation
- [x] **P1.3** SQL migrations (plain SQL files with a simple runner, or a migration tool of your choice recorded in `DECISIONS.md`) for: `tenants`, `users`, `memberships` (roles: owner, admin, member), `api_keys` (store a hash only, show prefix), `usage_events` (partitioned by month), `credit_ledger` (append-only), `credit_balances`, `jobs`, `job_attempts`, `dead_letters`.
  - **Done when:** migrations apply from empty and roll forward cleanly in CI.
- [ ] **P1.4** Row-level security on every tenant-owned table. The tenant is set per transaction via a session setting. The app connects with a non-superuser role that does not bypass RLS.
  - **Done when:** an automated test matrix (roles x tables x operations) proves **zero cross-tenant reads and writes**, and the test count is printed in the test output.
- [ ] **P1.5** Fastify API: auth by API key, create tenant, ingest usage event, read usage, read balance. Request validation with a schema library; consistent error format.
  - **Done when:** integration tests cover the happy path and auth failure for every endpoint.

### Data and baseline
- [ ] **P1.6** Seed script generating **10 million** `usage_events` across at least 200 tenants using `generate_series`, with a realistic skew (a few very large tenants). Deterministic via a seed value.
  - **Done when:** `pnpm seed` is repeatable, documents its runtime, and prints row counts per table.
- [ ] **P1.7** k6 baseline: scripts for usage ingest, usage read (by tenant and date range) and balance read. Save raw output in `docs/benchmarks/`.
  - **Done when:** `docs/benchmarks/baseline.md` reports p50/p95/p99 per endpoint, request count, error rate, seed size and container limits.

### Correctness under concurrency
- [ ] **P1.8** Race-free credit debit: a single function or transaction using row locking, a balance check before the run, an idempotency key, and a refund path on failure.
  - **Done when:** a test with 50 parallel workers performing 10,000 debits shows **no overdraft, no double-spend, and ledger sum equals balance**. Repeating the same idempotency key does not double-debit.
- [ ] **P1.9** Job queue using `FOR UPDATE SKIP LOCKED`, with retries, exponential backoff, a max-attempts limit, dead-lettering and idempotency keys.
  - **Done when:** a test with 50 workers processing 10,000 jobs shows **no job executed twice, none lost**, failed jobs reach `dead_letters` after the retry limit, and throughput (jobs/s) is recorded.

### Performance work
- [ ] **P1.10** Monthly partitioning for `usage_events` plus automatic partition creation; index design for the main read patterns.
  - **Done when:** `docs/optimization-log.md` contains at least **3 entries**, each with: the slow query, `EXPLAIN (ANALYZE, BUFFERS)` before, the change, `EXPLAIN (ANALYZE, BUFFERS)` after, and measured latency before and after at the stated seed size.
- [ ] **P1.11** RLS overhead measurement: the same k6 scenario with and without RLS.
  - **Done when:** the overhead is published as a table in `docs/benchmarks/`.
- [ ] **P1.12** Observability: OpenTelemetry traces, a `/metrics` endpoint, a Grafana dashboard JSON in the repo (request latency, queue depth and age, slow queries from `pg_stat_statements`).
  - **Done when:** `docker compose --profile obs up` shows the dashboard with live data.
- [ ] **P1.13** Small admin UI (React + Vite): tenant usage chart, credit balance, queue health.
  - **Done when:** it shows loading, empty and error states for each panel.

### Phase 1 deliverable
- [ ] **P1.14** `ledgerline/README.md` leading with a results table: p95 per endpoint, queue throughput, RLS overhead, number of isolation tests, and the optimization-log highlights. Then architecture diagram (Mermaid), then a one-command demo.
  - **Done when:** a fresh clone can run the demo with the documented commands only.
- **Checkpoint:** stop, summarize measured results, and wait for the author's go-ahead.

## 4. Phase 2: Shared core (weeks 2-3)

### Shadow DB and measurement
- [ ] **C2.1** Shadow database runner: given a source connection (read-only), create a throwaway Postgres container with the same schema and either a full or sampled copy of the data, and tear it down afterwards. Container name prefix and labels so leftovers are cleaned up.
  - **Done when:** a test clones the Ledgerline database, verifies row counts (or sample ratio), and confirms the source database received **no writes** (compare `pg_stat_database` counters or use a read-only role that would error on write).
- [ ] **C2.2** Measurement harness: run a query N times (warmup + measured runs), record timings (p50/p95), plan JSON, buffers, and for DDL: lock wait, duration, relation size change.
  - **Done when:** results are returned as typed JSON, repeat runs of the same query are within a documented variance, and the harness refuses to run against a non-shadow connection unless explicitly overridden.

### LLM layer
- [ ] **C2.3** `LLMProvider` interface: `chat`, `stream`, tool-call support, usage reporting (tokens in/out), and a capability flags object (`tools`, `streaming`, `jsonMode`).
  - **Done when:** interface and types are documented, with a fake provider used in tests.
- [ ] **C2.4** Generic OpenAI-compatible adapter (`baseURL`, `apiKey`, `model`) with 429/5xx retry and backoff, request timeout, and normalization of streaming and tool-call formats.
  - **Done when:** contract tests pass against the fake provider, and a manual script works against at least one real free-tier provider (Groq or OpenRouter) and Ollama if installed. Record which were tested in `DECISIONS.md`.
- [ ] **C2.5** Hand-written agent loop: send messages and tool schemas, execute tool calls, feed results back, stop on final answer or step limit. Schema-validate tool arguments; on invalid arguments, allow **one** repair retry, then fail safely. Count tool errors.
  - **Done when:** tests cover valid calls, invalid arguments with repair, unknown tool names, step-limit stop, and provider 429 handling.
- [ ] **C2.6** Fallback chain (provider A, then B, then C) with per-provider quota tracking, plus a "test connection" check that reports tool and streaming support.
  - **Done when:** a test simulates provider A failing and verifies B is used.
- [ ] **C2.7** Bring-your-own-key safety: base URLs must be HTTPS (localhost only in an explicit dev mode), block private and internal IP ranges, enforce timeouts and response-size limits, never log keys, show only the last 4 characters.
  - **Done when:** SSRF tests for private ranges, link-local, and redirects to private ranges all pass.

### Tools and MCP
- [ ] **C2.8** Tool registry: each tool defined once with a typed schema, usable by the agent loop and exposed through an MCP server (streamable HTTP or stdio). Initial read-only tools: `list_slow_queries`, `get_query_plan`, `describe_schema`.
  - **Done when:** the MCP server works with an MCP inspector or client, and the same tool definitions are used by the in-process agent.
- [ ] **C2.9** Tracing: record each agent run (steps, tools, tokens, latency) to Langfuse or to a local table if Langfuse is not configured.
  - **Done when:** a run is visible with its steps and token counts.
- **Checkpoint:** stop and summarize. Then wait for the author's go-ahead before Phase 3.

## 5. Phase 3 outline: Ledgerlens (weeks 3-6, detail to be expanded after Phase 2)

**Persona:** a backend developer at a small startup with no DBA, whose app got slow.
**Flow:** connect read-only, ranked slow queries, plain-language diagnosis, proposed fix, verified on the shadow copy with before/after timings, accept or reject.

Planned tasks (to be broken down with acceptance criteria at the Phase 2 checkpoint):
- Slow-query finder from `pg_stat_statements` (ranked by total time, with normalized query text and optional literal redaction).
- Plan analyzer (seq scans, bad estimates, sorts spilling to disk, N+1 patterns from repeated query shapes).
- Fix proposer using the agent loop; candidate indexes tested first with HypoPG, then built on the shadow copy.
- Verifier: before/after measurement, write-overhead estimate, storage cost, risk level; reject fixes that do not help or hurt writes too much.
- Output as a reviewable migration file with a diff. Never auto-applied.
- Product layer from day one: PostHog events (`slow_query_opened`, `fix_viewed`, `fix_accepted`, `fix_rejected` with reason, `fix_reverted`, `thumbs`), states for rate-limited, quota exhausted, no problems found, fix did not help.
- Gauntlet of about 30 planted problems in Ledgerline-style data (missing index, wrong composite order, unindexed foreign key, N+1, bad `LIKE`, stale statistics, sort spill, and so on).
- Metrics per model: percent fixed with a real speedup, percent harmful or useless, speedup versus human reference fix, tokens and cost per fix.

**Visual storytelling (Ledgerlens "investigation board").** Everything shown must be measured data from recorded runs. Never invent timings. Do not rely on color alone (add icons and labels). Every view needs loading, empty, failed-step and rate-limited states.
- **L3.V1 Plan diagram.** Map `EXPLAIN (FORMAT JSON)` to a flow diagram using React Flow with automatic layout (ELK or dagre). Boxes are plan nodes, arrows show row flow, arrow thickness encodes row count, box color encodes share of total time, badges flag problems (seq scan on a large table, estimate versus actual mismatch, sort spill).
  - **Done when:** the diagram renders without overlap for all gauntlet queries, and a snapshot test covers at least 5 distinct plan shapes.
- **L3.V2 Before/after view.** The same diagram side by side with the fix applied, showing measured timings.
  - **Done when:** it uses only numbers from the verifier output, and a test fails if a displayed number is not present in the stored measurement.
- **L3.V3 Agent run as workflow.** A horizontal chain: Find, Diagnose, Propose, Hypothetical index test, Build on shadow copy, Measure, Verdict. Each step shows status (done, running, failed, skipped); clicking a step shows the tool call, tokens and latency.
  - **Done when:** a recorded run replays correctly, including a failed-step case and a rate-limited case.
- **L3.V4 Verdict card.** Speedup, write overhead, storage cost, risk level, with Accept and Reject (reason required on reject). Emits the PostHog events defined above.
  - **Done when:** accepting never applies anything automatically; it only exports the reviewable migration file.

## 6. Phase 4 outline: Ledgerlatch (weeks 7-9)

**Persona:** the same developer, about to ship a schema change.
**Flow:** paste a migration, see locks and rewrite risk, watch it tested on a production-sized shadow copy under simulated traffic, get a safer rewrite, see it proven.

Planned tasks:
- Static analysis of migration SQL for lock level and table-rewrite risk (rules per statement type).
- Dynamic test: run the migration on the shadow copy while k6 or a Node load generator issues reads and writes; measure blocked time and query latency impact.
- Rewrite engine for common patterns (add NOT NULL column, add index without `CONCURRENTLY`, add foreign key, change column type, add unique constraint) into expand/contract steps (add nullable, batched backfill, validate constraint).
- Prove step: rerun the rewritten version under the same traffic and report blocked time before and after.
- Integration with Ledgerlens: every proposed index is checked by Ledgerlatch for safe creation.
- Gauntlet of about 20 risky migrations: how many correctly flagged, how many rewrites actually remove the lock.

**Visual storytelling (Ledgerlatch "lock timeline").** Same rules as Ledgerlens: measured data only, accessible without color alone, all states handled.
- **L4.V1 Swimlane timeline.** One lane for the migration and lanes for reads and writes. Queries blocked by a lock appear as bars stacking up behind it. Use a lightweight chart library (uPlot or visx).
  - **Done when:** the timeline replays a recorded run and the displayed blocked durations match the harness output exactly (tested).
- **L4.V2 Before/after timelines.** Original migration versus rewritten migration under identical traffic.
  - **Done when:** both runs use the same recorded traffic profile, stated on screen.
- **L4.V3 Rewrite step flow.** Boxes and arrows for the rewrite (add nullable, batched backfill with a live progress bar, validate constraint, add NOT NULL). Each box shows a lock-level badge and measured block time.
  - **Done when:** the flow is generated from the rewrite engine output, not hand-written.

**Shared storytelling (build after both tools work).**
- **S.1 Story mode report.** A one-page shareable report in the order Problem, Evidence, Fix, Proof, Risk, generated from stored runs.
- **S.2 Pipeline view.** Ledgerlens proposes an index, Ledgerlatch checks it creates safely, and the final verdict shows both results.
- Cut order if time is short: story-mode export, then animations, then the pipeline view. Keep the plan diagram and the lock timeline.

## 7. Phase 5 outline: evals, users and write-ups (week 10)

- promptfoo suites in `evals/` for both gauntlets, run across several free models; publish a comparison table (success rate, harmful-suggestion rate, p50 latency, tokens per task). CI fails on regression.
- 5 to 10 real testers: log what they tried, what failed, and what changed because of it, in `PRODUCT.md`.
- A 2-minute demo video per package that starts with the user's problem.
- Resume-ready metrics table with only numbers that were really measured.

## 8. Definition of done for the whole project

- Every checkbox above is ticked, or explicitly marked cut in `DECISIONS.md` with a reason.
- README leads with measured results and links to raw benchmark output.
- A fresh clone can run each package's demo with documented commands.
- No secrets, no employer-specific names or code anywhere in the repo or its history.

## 9. First action for Claude Code

Start with **P1.0**, then **P1.1** and **P1.2**. After finishing P1.2, show the author the repo tree and the passing CI output, then continue with P1.3 onward without waiting, stopping only at the checkpoint at the end of Phase 1.
