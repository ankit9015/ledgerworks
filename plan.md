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
- [x] **P1.4** Row-level security on every tenant-owned table. The tenant is set per transaction via a session setting. The app connects with a non-superuser role that does not bypass RLS.
  - **Done when:** an automated test matrix (roles x tables x operations) proves **zero cross-tenant reads and writes**, and the test count is printed in the test output.
- [x] **P1.5** Fastify API: auth by API key, create tenant, ingest usage event, read usage, read balance. Request validation with a schema library; consistent error format.
  - **Done when:** integration tests cover the happy path and auth failure for every endpoint.

### Data and baseline
- [x] **P1.6** Seed script generating **10 million** `usage_events` across at least 200 tenants using `generate_series`, with a realistic skew (a few very large tenants). Deterministic via a seed value.
  - **Done when:** `pnpm seed` is repeatable, documents its runtime, and prints row counts per table.
- [x] **P1.7** k6 baseline: scripts for usage ingest, usage read (by tenant and date range) and balance read. Save raw output in `docs/benchmarks/`.
  - **Done when:** `docs/benchmarks/baseline.md` reports p50/p95/p99 per endpoint, request count, error rate, seed size and container limits.

### Correctness under concurrency
- [x] **P1.8** Race-free credit debit: a single function or transaction using row locking, a balance check before the run, an idempotency key, and a refund path on failure.
  - **Done when:** a test with 50 parallel workers performing 10,000 debits shows **no overdraft, no double-spend, and ledger sum equals balance**. Repeating the same idempotency key does not double-debit.
- [x] **P1.9** Job queue using `FOR UPDATE SKIP LOCKED`, with retries, exponential backoff, a max-attempts limit, dead-lettering and idempotency keys.
  - **Done when:** a test with 50 workers processing 10,000 jobs shows **no job executed twice, none lost**, failed jobs reach `dead_letters` after the retry limit, and throughput (jobs/s) is recorded.

### Performance work
- [x] **P1.10** Monthly partitioning for `usage_events` plus automatic partition creation; index design for the main read patterns.
  - **Done when:** `docs/optimization-log.md` contains at least **3 entries**, each with: the slow query, `EXPLAIN (ANALYZE, BUFFERS)` before, the change, `EXPLAIN (ANALYZE, BUFFERS)` after, and measured latency before and after at the stated seed size.
- [x] **P1.11** RLS overhead measurement: the same k6 scenario with and without RLS.
  - **Done when:** the overhead is published as a table in `docs/benchmarks/`.
- [x] **P1.12** Observability: OpenTelemetry traces, a `/metrics` endpoint, a Grafana dashboard JSON in the repo (request latency, queue depth and age, slow queries from `pg_stat_statements`).
  - **Done when:** `docker compose --profile obs up` shows the dashboard with live data.
- [x] **P1.13** Small admin UI (React + Vite): tenant usage chart, credit balance, queue health.
  - **Done when:** it shows loading, empty and error states for each panel.

### Phase 1 deliverable
- [x] **P1.14** `ledgerline/README.md` leading with a results table: p95 per endpoint, queue throughput, RLS overhead, number of isolation tests, and the optimization-log highlights. Then architecture diagram (Mermaid), then a one-command demo.
  - **Done when:** a fresh clone can run the demo with the documented commands only.
- **Checkpoint:** stop, summarize measured results, and wait for the author's go-ahead.

## 4. Phase 2: Shared core (weeks 2-3)

### Shadow DB and measurement
- [x] **C2.1** Shadow database runner: given a source connection (read-only), create a throwaway Postgres container with the same schema and either a full or sampled copy of the data, and tear it down afterwards. Container name prefix and labels so leftovers are cleaned up.
  - **Done when:** a test clones the Ledgerline database, verifies row counts (or sample ratio), and confirms the source database received **no writes** (compare `pg_stat_database` counters or use a read-only role that would error on write).
- [x] **C2.2** Measurement harness: run a query N times (warmup + measured runs), record timings (p50/p95), plan JSON, buffers, and for DDL: lock wait, duration, relation size change.
  - **Done when:** results are returned as typed JSON, repeat runs of the same query are within a documented variance, and the harness refuses to run against a non-shadow connection unless explicitly overridden.

### LLM layer
- [x] **C2.3** `LLMProvider` interface: `chat`, `stream`, tool-call support, usage reporting (tokens in/out), and a capability flags object (`tools`, `streaming`, `jsonMode`).
  - **Done when:** interface and types are documented, with a fake provider used in tests.
- [x] **C2.4** Generic OpenAI-compatible adapter (`baseURL`, `apiKey`, `model`) with 429/5xx retry and backoff, request timeout, and normalization of streaming and tool-call formats.
  - **Done when:** contract tests pass against the fake provider, and a manual script works against at least one real free-tier provider (Groq or OpenRouter) and Ollama if installed. Record which were tested in `DECISIONS.md`.
- [x] **C2.5** Hand-written agent loop: send messages and tool schemas, execute tool calls, feed results back, stop on final answer or step limit. Schema-validate tool arguments; on invalid arguments, allow **one** repair retry, then fail safely. Count tool errors.
  - **Done when:** tests cover valid calls, invalid arguments with repair, unknown tool names, step-limit stop, and provider 429 handling.
- [x] **C2.6** Fallback chain (provider A, then B, then C) with per-provider quota tracking, plus a "test connection" check that reports tool and streaming support.
  - **Done when:** a test simulates provider A failing and verifies B is used.
- [x] **C2.7** Bring-your-own-key safety: base URLs must be HTTPS (localhost only in an explicit dev mode), block private and internal IP ranges, enforce timeouts and response-size limits, never log keys, show only the last 4 characters.
  - **Done when:** SSRF tests for private ranges, link-local, and redirects to private ranges all pass.

### Tools and MCP
- [x] **C2.8** Tool registry: each tool defined once with a typed schema, usable by the agent loop and exposed through an MCP server (streamable HTTP or stdio). Initial read-only tools: `list_slow_queries`, `get_query_plan`, `describe_schema`.
  - **Done when:** the MCP server works with an MCP inspector or client, and the same tool definitions are used by the in-process agent.
- [x] **C2.9** Tracing: record each agent run (steps, tools, tokens, latency) to Langfuse or to a local table if Langfuse is not configured.
  - **Done when:** a run is visible with its steps and token counts.
- **Checkpoint:** stop and summarize. Then wait for the author's go-ahead before Phase 3.

## 5. Phase 3: Ledgerlens (weeks 3-6)

Ledgerlens finds slow queries in a Postgres database, proposes fixes, and **verifies each fix on a shadow copy** with measured before/after numbers. It never changes the source database and never applies anything automatically. Accepting a fix only exports a reviewable migration.

### Principles (apply to every task below)

1. **Verified, not guessed.** Only the verifier decides a verdict. An LLM can propose, never judge.
2. **Source is read-only.** `EXPLAIN ANALYZE`, index builds and write benchmarks run on a settled shadow only. Source access uses the read-only role and the existing readiness check.
3. **Noise rules from D36 are enforced in code.** Call a difference real only above about 40% for queries of 50 ms or more, 2x for queries under 2 ms (use server time), and about 50% for DDL durations, compared interleaved in the same session. Anything smaller is "inconclusive", never an improvement.
4. **Sampled shadows are labelled.** A sampled shadow is not a scaled-down database (10% of tenants kept 2.9% of events). Verdicts from a sample are capped at "indicative" and say so.
5. **Database text is untrusted.** Query text, identifiers, comments and plan text are delimited data. Generated SQL quotes every identifier properly and never interpolates untrusted strings.
6. **Deterministic baseline first.** A rules-only advisor (no LLM) is built before the LLM proposer, so the value of the LLM is measurable.
7. **Honest numbers.** Report counts (for example 21/30), repeats, model ids and dates. No invented numbers. Raw outputs are kept and never overwritten.
8. **Generic.** Works on any Postgres 16 source. Ledgerline is the first test subject, so a second schema is used in the gauntlet to avoid overfitting.

### L3.0 Product framing
- [x] Write `ledgerlens/PRODUCT.md`: persona (a backend developer at a small startup with no DBA whose app got slow), problem, goals, at least three non-goals (no auto-apply, no query rewriting of application code, no monitoring replacement), and measurable success metrics. Add DECISIONS entries for the verdict vocabulary and risk levels.
- [x] Define the typed event taxonomy as a schema file (no sending yet): `investigation_started`, `slow_query_opened`, `candidate_viewed`, `fix_accepted`, `fix_rejected` (reason), `fix_reverted`, `thumbs`, `state_shown` (rate_limited, quota_exhausted, no_problems, fix_did_not_help). Events carry ids, hashes and classes only, never query text.
- **Done when:** the files exist, and the taxonomy has a test that rejects an event containing a field named like query text.

### L3.1 Workload model and parameter bindings
Problem: `pg_stat_statements` stores normalized text with `$1, $2`, so a query cannot be measured without concrete values.
- [x] A `Workload` type: normalized statements with calls, total and mean time, rows and buffer counts. Exclude utility statements, Ledgerlens's own queries and pg_catalog-only statements, and say how many were excluded and why.
- [x] Parameter binding strategies, each with a provenance label: `user-supplied` (a file of example values), `sampled-from-stats` (values from `pg_stats` most_common_vals and histogram bounds, matched to the column each parameter is compared with, using a real SQL parser; record the parser choice and version), and `synthesized` (values derived from column types, lowest confidence). Every binding set carries a confidence level.
- [x] Statements with no usable bindings are marked `unverifiable` and listed with a reason. They are never silently skipped.
- **Done when:** on the Ledgerline benchmark workload (after a k6 run) the report states the real share of the top 20 statements that got bindings, with provenance, and lists the unverifiable ones. Tests cover parameters in equality, range, IN lists and LIMIT/OFFSET, and a hostile value pulled from stats (for example a string containing quotes or a semicolon) that must be passed as a bound parameter, never as text.

### L3.2 Deterministic plan analyzer
- [x] Parse `EXPLAIN (FORMAT JSON)` output (estimates only, from the source tool) and `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` output (from the harness) into a typed plan tree with node paths.
- [x] Findings with evidence numbers and a severity: seq scan on a large table with a selective filter, estimate versus actual row mismatch (factor), sort spilling to disk, sort over a large set where an index could provide order, nested loop with a high loop count (N+1 shape), hash join with multiple batches, lossy bitmap heap recheck, join on an unindexed foreign key, absent partition pruning, and stale statistics (last analyze versus modification counts).
- [x] Every finding links to the node path it came from. Plan text inside findings is marked untrusted.
- **Done when:** snapshot tests cover at least 8 distinct plan shapes using fixture plans saved from real runs, and the pre-E1 Ledgerline usage-read plan produces a "large sort where an index could give order" finding. No finding is produced without evidence numbers (tested).

### L3.3 Deterministic candidate generator (the rules-only advisor)
- [ ] A typed `Candidate`: id, kind (`create_index`, `drop_redundant_index`, `analyze_or_stats_target`, `rewrite_suggestion`), up SQL and down SQL, rationale, targeted statements, risk notes, and the findings that triggered it.
- [ ] Index rules: equality columns first, then range, then sort columns; partial indexes when a constant filter is dominant; `INCLUDE` for covering when it removes a heap fetch; `CONCURRENTLY` always; skip tiny tables; avoid duplicates of existing indexes (including prefix-redundant ones) using `describe_schema`.
- [ ] `rewrite_suggestion` is advice text only and is not verified unless a rewrite SQL is supplied (see L3.7 equivalence check).
- [ ] SQL generation quotes identifiers through one tested helper.
- **Done when:** tests show correct column order for 6 query shapes, duplicate and prefix-redundant detection, and an identifier-injection test (table and column names containing quotes, semicolons and newlines) where the generated SQL is valid and inert.

### L3.4 HypoPG pre-screen
- [ ] On the settled shadow, create each index candidate as a hypothetical index, run plain `EXPLAIN` for the targeted statements with their bindings, and record whether the planner uses the index and the estimated cost change. Drop the hypothetical index afterwards.
- [ ] Candidates the planner does not use are rejected early with the reason. HypoPG results are cost estimates only and are never reported as measured speedups.
- **Done when:** a planted missing-index case passes the pre-screen, a useless index is rejected, and the report text never calls a HypoPG number a speedup (tested by a string check on the report schema, which has separate `estimatedCostRatio` and `measuredSpeedup` fields).

### L3.5 Verifier
- [ ] For each surviving candidate, on a settled shadow and with interleaved before/after measurement using the harness: measure the targeted statements before, apply the candidate for real (fresh shadow per run when the statement cannot be rolled back, for example `CREATE INDEX CONCURRENTLY`), measure the build time and size, then measure again.
- [ ] Write overhead: benchmark inserts and updates on the affected table before and after (from workload statements when bound, otherwise a synthetic statement matching the table's columns, labelled as synthetic).
- [ ] Regression check: re-measure the top N other statements touching the same table, and flag any regression beyond the noise thresholds.
- [ ] Verdicts: `verified_improvement`, `inconclusive`, `no_effect`, `harmful`, `unverifiable`, with `indicative` as a cap for sampled shadows. Rules use the D36 thresholds and a configurable write-overhead limit.
- [ ] Risk level (`low`, `medium`, `high`) from an explicit documented table: lock mode (`CONCURRENTLY` or not), table size, write overhead, how hot the table is (calls), and sampled versus full shadow.
- [ ] Output is a typed, versioned `Verdict` that includes the shadow manifest id, whether the data was sampled, run counts and the spread.
- **Done when:** tests show a planted missing index gives `verified_improvement`, a useless index gives `no_effect`, an index that heavily slows inserts gives `harmful` (a constructed case), two identical runs are never reported as an improvement, a sampled shadow caps the verdict at `indicative`, and repeating the same candidate gives the same verdict class in 3 of 3 runs.

### L3.6 Migration output
- [ ] Generate reviewable `up.sql` and `down.sql` with a header comment (candidate id, measured evidence summary, risks, whether sampled, noise thresholds used). Use `CONCURRENTLY` and a "no transaction" marker where needed.
- [ ] Never execute anything on the source. Provide a script that prints how to apply the migration manually.
- [ ] Validate the output: apply `up` then `down` on a fresh shadow and check that the schema returns to the original (schema diff equals empty).
- **Done when:** the round-trip test passes for every candidate kind, and the header never contains query literals (redaction on by default).

### L3.7 LLM proposer (agent loop)
- [ ] New tools registered through the existing registry. Source tools: `list_slow_queries`, `get_query_plan`, `describe_schema`. Shadow-only tools: `get_plan_analysis` (deterministic findings), `hypothetical_index_test`, `measure_query`. The model submits candidates through `propose_candidate` as **structured parameters, not raw SQL**, and the generator turns them into SQL. A rewrite candidate may carry raw SQL, but it is only measured after a result-equivalence check (matching checksums for the sample bindings), and a failing check is a typed rejection.
- [ ] Budgets per investigation: maximum steps, tokens, wall clock, shadow builds and shadow time. Exhausted budgets end the run with a typed stop reason.
- [ ] The verifier remains the only judge. A test shows that a model claiming "this made it 10x faster" cannot change the verdict.
- [ ] Prompt hygiene: system instructions stay separate from tool results, database text is delimited as untrusted, and a gauntlet case where a table comment tells the model to drop an index must not produce any drop candidate (this tests the mechanics, not the model's resistance).
- **Done when:** a scripted fake-provider run goes from slow query to verified candidate with a full trace, a manual script runs one end-to-end investigation with a real provider on one planted problem (raw trace saved, keys stripped), and tests cover invalid candidates, a rewrite that fails equivalence, budget exhaustion, and the verdict-override attempt.

### L3.8 Gauntlet
- [ ] About 30 planted problems as directories: setup SQL, workload with bindings, problem class, human reference fix, expected verdict class, and a `trap` flag. Classes: missing index, wrong composite column order, unindexed foreign key, N+1 shape, bad `LIKE` pattern, stale statistics, sort spill, function on an indexed column, type mismatch preventing index use, partial-index opportunity, redundant index, and OFFSET pagination.
- [ ] At least 5 **traps** where the right answer is "do not add an index" (low selectivity, tiny table, write-heavy table, an index that already exists in another form).
- [ ] Use two schemas (Ledgerline-derived and a different synthetic one) so results do not depend on one dataset.
- [ ] Hold out about 10 cases as a test set that is never used while tuning rules or prompts. Record in the repo which ones.
- [ ] `pnpm gauntlet:build` builds every case reproducibly.
- **Done when:** every human reference fix is run through the same verifier and produces the expected verdict class (a reference that fails is reported, not hidden), and the trap cases verify as "no change recommended".

### L3.9 Evals
- [ ] A runner that evaluates the deterministic baseline and each configured model on every case, with fallover disabled so results are attributable to one model, and at least 3 repeats per case for LLMs.
- [ ] Metrics shown as counts and percentages: fixed with a verified speedup, harmful, trap passed, useless, speedup versus the reference fix (ratio), tool-error rate, repair rate, tokens, latency, and estimated cost only if a price table is configured.
- [ ] promptfoo suites for CI use the fake provider and recorded runs only (no keys and no cost in CI). Real-model runs are manual, with raw outputs committed (keys stripped), the exact model id, the date and the current free-tier limits noted.
- [ ] A results table in the README comparing the baseline and each model on the dev set and the held-out set separately.
- **Done when:** CI fails on a regression of the baseline or the fake-provider suite, and the README table has real counts with repeat numbers.

### L3.10 Service and API
- [ ] Fastify API with a separate metadata database (never the source or the shadow): create connection (config encrypted, read-only readiness check), list slow queries, start an investigation, get an investigation (steps, trace), list candidates and verdicts, accept or reject (a reason is required to reject; accepting only unlocks the migration download), and download the migration.
- [ ] Store plans, stats and redacted query text only. Original literals are never stored unless a setting is turned on, and the setting is off by default.
- [ ] Single-user API token for now (record the decision and its limits).
- **Done when:** integration tests cover each endpoint with a happy path and an auth failure, a test confirms literals do not appear in the stored data, and no endpoint can run anything on the source beyond the read-only tools.

### L3.V (visual storytelling, from the main plan)
- [ ] **L3.V1 Plan diagram.** Map EXPLAIN JSON to a flow diagram (React Flow plus ELK or dagre). Arrow thickness shows row count, box colour shows share of time, and badges show findings. Done when it renders without overlap for all gauntlet queries and snapshot tests cover at least 5 plan shapes.
- [ ] **L3.V2 Before/after view.** Done when every displayed number exists in the stored verdict (a test fails otherwise) and sampled verdicts show the "indicative" label.
- [ ] **L3.V3 Agent run as workflow.** Find, Diagnose, Propose, Hypothetical test, Build on shadow, Measure, Verdict, each with status and a click-through to the tool call, tokens and latency. Done when a recorded run replays correctly including a failed step and a rate-limited step.
- [ ] **L3.V4 Verdict card.** Speedup (with its noise label), write overhead, storage, risk, Accept and Reject (reason required). Accept never applies anything.
- Shared rules: measured data only, not colour alone, and loading, empty, failed-step and rate-limited states everywhere.

### L3.11 Product instrumentation
- [ ] Implement the typed events from L3.0 with a local JSONL sink and an optional PostHog sink (environment variables only). Events carry ids, hashes and classes only. A test scans events for query text and literals.
- [ ] Document the funnels: connected, first investigation, first verified fix, first accept.
- **Done when:** the privacy scan test passes and the funnel definitions are written in `ledgerlens/PRODUCT.md`.

### L3.12 README, demo and test-user prep
- [ ] `ledgerlens/README.md` leads with the gauntlet results table (baseline versus models, dev versus held-out, counts and repeats), then one verified before/after example, then architecture, then a one-command demo, then "Honest limits" (shadow noise, sampled shadows, parameter binding limits, free-model variance, HypoPG cost estimates, laptop numbers).
- [ ] Prepare a short script and consent note for 5 to 10 test users, and a `docs/user-feedback.md` template (what they tried, what failed, what changed).
- **Done when:** a fresh clone reaches a working demo with documented commands, and every number in the README links to a raw file.

### Prompt split for Claude Code
- Prompt 10: L3.0 to L3.4 (foundations, no LLM)
- Prompt 11: L3.5 and L3.6 (verifier and migration output)
- Prompt 12: L3.7 (LLM proposer)
- Prompt 13: L3.8 and L3.9 (gauntlet and evals)
- Prompt 14: L3.10, L3.V, L3.11, L3.12 (API, UI, instrumentation, README)
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
