# @ledgerworks/core

The shared engine. Everything here is generic: it works against any Postgres 16 database, Ledgerline is the first test subject.

| Part                  | Status | What it is                                                                                                               |
| --------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| `src/shadow/` (C2.1)  | done   | clones a database (full or sampled) into a throwaway, labelled Postgres container; the only place experiments run        |
| `src/harness/` (C2.2) | done   | measures a query or a DDL statement on a shadow and returns typed, versioned JSON; refuses anything that is not a shadow |

## Shadow database runner (C2.1)

```ts
import { createShadow, withShadow, assertShadow } from '@ledgerworks/core';

// sourceUrl must be a READ-ONLY role (see below). Teardown always runs.
await withShadow({ sourceUrl: process.env.SHADOW_SOURCE_URL!, mode: 'full' }, async (shadow) => {
  const db = await shadow.connect(); // superuser of the shadow only
  // ... experiments ...
  console.log(shadow.manifest.scaling); // sampled? ratios?
});
```

### Safety, in one place

1. **The source role must not be able to write.** `provisionReaderRole(adminUrl, ...)` (run once by a human) creates a role with `pg_read_all_data`, `BYPASSRLS` (needed to copy tables with `FORCE ROW LEVEL SECURITY`; without it the copy would silently miss rows) and `default_transaction_read_only = on`. `createShadow` runs `checkSourceReadOnly` first: privilege inventory plus a rolled-back `CREATE SCHEMA` and no-row `DELETE` with the session switched to read-write. A role that can write is refused (`SourceWritableError`) unless `allowWritableSource: true`, which is logged loudly and recorded in the manifest.
2. Every source session is read-only (server-enforced at connect), has a statement timeout, a lock timeout and an identifiable `application_name`, and only sends statements that pass an allow-list. The runner never sends DDL or DML to the source. See DECISIONS.md D31.
3. **No resource competition:** the shadow has its own CPU, memory, swap, pids and shm limits and its own volume, and the runner refuses to start when the Docker host cannot hold the shadow **and** a reserve for the source. Defaults: shadow 2 CPUs / 3 GiB, reserve 2 CPUs / 2 GiB.
   - **Verified:** the full clone of the 10M-row Ledgerline database at 2 CPUs / 3 GiB, on a Docker host with 8 CPUs / 9.6 GiB, with the source at 2 CPUs / 2 GiB: 97.8 s, source not harmed (`docs/benchmarks/shadow-clone.md`).
   - **Not verified:** anything smaller. The shadow's cgroup peak reached its 3 GiB limit (page cache), the sampled working set peaked at 1.7 GiB. Try less than 2 GiB at your own risk. I/O is shared on one-disk hosts and cannot be capped here; `maxSourceMBps` caps the read rate from the source.
4. Every shadow is marked: database setting `ledgerworks.shadow_run_id`, marker table `ledgerworks_meta.shadow_marker` with the manifest, container and volume labels `ledgerworks.shadow=true` and a run id. `assertShadow(client)` checks all of it; the measurement harness (C2.2) calls it before doing anything.

### Modes and the manifest

- `mode: 'full'`: every table has the source's row count (verified).
- `mode: 'sampled'` with `sampling: { rootTable, ratio, seed, uncovered, isolated, fullTables }`: the root table is sampled by a deterministic hash, children follow their foreign keys, referenced parents keep what is referenced (D32). **The ratio is a ratio of root rows, not of data**: 8.8% of Ledgerline's tenants gave 2.9% of its usage events.
- The manifest (`ShadowManifestSchema`, `manifestVersion` 1, also stored inside the shadow) records source database and server version, mode and rule, per-table source rows, shadow rows, ratio and why, container limits and host, image id and versions, extensions, roles, planner settings side by side, copy parameters, the duration of every stage, peak memory (sampled and cgroup), the source container's health before and after, and warnings. It never contains a credential.
- **Any timing taken on a sampled shadow must be reported as measured on a sample.** `manifest.scaling.sampled`, `totalRowRatio` and `largestTableRatio` are there for that.

### Lifecycle

```
pnpm --filter @ledgerworks/core shadow create --mode full              # source URL from $SHADOW_SOURCE_URL
pnpm --filter @ledgerworks/core shadow create --mode sampled --root public.tenants --ratio 0.1 --seed 7
pnpm --filter @ledgerworks/core shadow status [runId]
pnpm --filter @ledgerworks/core shadow url <runId>                      # connection string, with password
pnpm --filter @ledgerworks/core shadow destroy <runId>
pnpm --filter @ledgerworks/core shadow cleanup --older-than 24h --dry-run
```

`cleanup` considers only containers and volumes that carry the shadow label **and** the `lw-shadow-` name prefix. `createShadow` removes everything it made when it fails (also when the container is killed halfway), and `withShadow` tears down in a `finally`.

### Tests

- `pnpm test` runs `src/shadow/shadow.small.test.ts` (real Docker and Postgres, about 1 minute): clone of the small Ledgerline demo database (created on first use as `ledgerline_demo`), schema equality, counts and checksums, sampled integrity for every foreign key, source-unchanged proof, read-only role and refusal tests, failure and orphan cleanup, marker. Needs Docker; the first run builds the shadow image.
- `pnpm test:shadow-full` clones the 10M-row benchmark database (needs `pnpm seed --yes` first), once in full and once sampled, and writes timestamped raw files to `docs/benchmarks/raw/`. Minutes; not part of `pnpm test` or CI.

`createShadow` **settles** the shadow before returning it (wait for autovacuum, `VACUUM (ANALYZE)`, `CHECKPOINT`; its own `settle` stage in the manifest, separate from the clone stages; opt out with `settle: false`), because a freshly loaded shadow keeps running autovacuum and a checkpoint in the background for minutes, which disturbs the first measurements (D36, D37). `settleShadow(target)` does the same for a shadow created without it.

## Measurement harness (C2.2)

```ts
import {
  createShadow,
  settleShadow,
  measureQuery,
  measureDdl,
  summarizeQuery,
} from '@ledgerworks/core';

const shadow = await createShadow({ sourceUrl, mode: 'full' });
try {
  const q = await measureQuery(shadow, {
    sql: 'SELECT ... WHERE tenant_id = $1',
    params: [id],
    warmupRuns: 3,
    measuredRuns: 20,
  });
  if (q.status === 'ok') console.log(summarizeQuery(q));
  const d = await measureDdl(shadow, {
    sql: 'ALTER TABLE public.t ADD COLUMN c int NOT NULL DEFAULT random()',
    table: 'public.t',
  });
} finally {
  await shadow.destroy();
}
```

- **Typed results, never exceptions.** `QueryMeasurement` and `DdlMeasurement` (`src/harness/schema.ts`, zod, `version: 1`) are unions on `status`: `ok`, or `failed` with `failure.kind` (`refused-not-shadow`, `invalid-input`, `connection-error`, `sql-error`, `statement-timeout`, `lock-timeout`, `max-runtime-exceeded`, `client-watchdog`, `needs-fresh-shadow`), the SQLSTATE, the phase and the number of completed runs. Every result carries the shadow's manifest id, whether it is **sampled**, the row ratios and a scaling note; `summarizeQuery` / `summarizeDdl` print a loud warning line for a sampled shadow and for a database that was not quiet while measuring.
- **Refuses non-shadows.** The marker is checked first (D33); a database that fails it gets `refused-not-shadow` and the statement is never sent. The only way around it is `src/harness/internal-testing.ts`, which is not exported, takes no option that a public function accepts (option schemas are strict), only works inside a test run with an environment flag, and logs loudly. Tool definitions added later must not expose anything like it.
- **Query measurement.** Per run: the statement as written, timed by the client (wall clock), and `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` (server time, planning time, buffers, rows). Reported: p50, p95, min, max, standard deviation and CV of both clocks; the full plan JSON of the first and of the median run, parsed (`usesSeqScan`, `usesIndexScan`, `usesSort`, the scans with relation and index); buffer hit/read/dirtied/written and I/O read time of the median run; rows returned or affected; every run's numbers.
- **Writes are safe by strategy** (`classifyStatement`): reads run in `BEGIN READ ONLY`; INSERT/UPDATE/DELETE and DDL run in `BEGIN ... ROLLBACK`; statements that cannot run in a transaction (`CREATE INDEX CONCURRENTLY`, `REINDEX CONCURRENTLY`, `VACUUM`, ...) need `hooks.freshShadow` and get a fresh shadow per run. What rollback does not undo (sequence values, dead tuples that make sizes grow, statistics counters) is listed in D34.
- **DDL measurement fields** (`DdlMeasurement`, the contract for Ledgerlatch): `durationMs`, `lockWaitMs`, `locks.held`, `locks.targetTableModes` (strongest first), `locks.strongestTargetTableMode`, `locks.blocksSelects`, `locks.blocksWrites`, `rewrite.tableRewritten` (relfilenode changed), `rewrite.indexesRebuilt` / `indexesCreated` / `indexesDropped`, `toastRewritten`, `size.before` / `after` / `deltaBytes` (table, indexes, TOAST, total), `verification.rolledBackCleanly`. Locks come from `pg_locks` right after the statement inside the transaction (`locks.source: 'end-of-statement'`), or from sampling for non-transactional statements (`'sampled'`). Lock wait time is sampled from `pg_stat_activity` (resolution about 15 ms on Windows); `blockingTransaction` holds a conflicting lock from another session for N ms to measure it.
- **Cold versus warm.** `cache: { mode: 'warm' }` is the default. `{ mode: 'cold-ish' }` restarts the shadow's Postgres before every run (needs `shadow.containerName`); `dropOsCache: true` also drops the page cache of the Docker VM through a privileged helper. `cache.claim` says which was done: `warm-after-warmup`, `shared-buffers-emptied-os-cache-warm` or `shared-buffers-emptied-vm-page-cache-dropped`. **Nothing here is a guaranteed cold disk read**: caches below the VM (the host, the SSD) are not controlled.
- **Safety nets:** server-side `statement_timeout` (never beyond the remaining total budget), `lock_timeout`, a client-side watchdog that drops the connection when the server stops answering, and `maxTotalRuntimeMs`.

### Sample outputs

From the test on the small demo shadow (`docs/benchmarks/raw/c2.2-small-harness-results-*.json` holds the complete JSON of both):

```
shadow 84b9377d: full copy (see its manifest for the container limits)
read / read-only-transaction: SELECT id, event_type, quantity, to_char(occurred_at AT TIME ZONE 'UTC', ...) AS occurred_at
cache: warm-after-warmup; 5 warmup + 30 measured runs
wall   p50 3.05 ms, p95 3.72 ms, min 2.80 ms, max 8.45 ms, sd 1.01 ms (CV 30.6%), n=30
server p50 0.26 ms, p95 0.34 ms, min 0.23 ms, max 0.54 ms, sd 0.06 ms (CV 20.6%), n=30   planning p50 1.67 ms
rows 51 returned; buffers (median run) hit 31, read 0, io read 0.00 ms
plan (median run): Limit > Incremental Sort > Append > Index Scan; seq scan false, index scan true, sort true

rollback-transaction: CREATE INDEX harness_ddl_c_idx ON public.harness_ddl (c)
duration p50 137 ms, p95 144 ms, min 130 ms, max 144 ms, sd 10.0 ms (CV 7.3%), n=2; lock wait p50 0.00 ms
locks on public.harness_ddl (end-of-statement): ShareLock; blocks selects: false, blocks writes: true
table rewritten: false; indexes rebuilt: false; created: public.harness_ddl_c_idx
size 40.4 MiB -> 41.8 MiB (table 0 B, indexes 1.4 MiB)
rolled back cleanly: true
```

### Run-to-run variance (what difference counts as real)

Ten repetitions of each case, each with 3 warmup and 20 measured runs, on a **full** shadow of the 10M-row synthetic Ledgerline database (2 CPUs / 3 GiB container, `shared_buffers` 768 MB, settled), on an Intel Core i5-1135G7 laptop (4 cores / 8 threads, 19.8 GB RAM, Windows 11, Docker Desktop VM with 8 CPUs / 9.6 GiB) that was **not dedicated** (other applications running, CPU frequency not fixed). Raw files and every experiment: `docs/benchmarks/c2.2-variance.md`; reasoning: DECISIONS.md D36.

| Case                                                                | mean of p50 (wall) | range of the 10 p50s | CV of p50 across repetitions | (max-min)/mean | CV of the 20 runs inside one repetition |
| ------------------------------------------------------------------- | ------------------ | -------------------- | ---------------------------- | -------------- | --------------------------------------- |
| usage-read after the E1 fix (index scan, top 51)                    | 1.26 ms            | 1.12 to 1.77 ms      | **15.0%**                    | 51.6%          | 17.5%                                   |
| usage-read before the E1 fix (sorts 64k rows)                       | 53.0 ms            | 44.2 to 66.7 ms      | 11.5%                        | 42.3%          | 28.7%                                   |
| usage aggregate over one month (about 270k rows)                    | 87.2 ms            | 82.7 to 92.5 ms      | 3.7%                         | 11.2%          | 23.4%                                   |
| UPDATE of one balance row (rolled back)                             | 0.98 ms            | 0.84 to 1.26 ms      | 11.7%                        | 43.3%          | 21.7%                                   |
| DDL: ADD COLUMN NOT NULL DEFAULT random() on 200,000 rows (rewrite) | 282 ms             | 249 to 330 ms        | 9.6%                         | 28.8%          | 11.4%                                   |

- **CV above 15% is reported:** single runs (17% to 29%), and the sub-2 ms cases across repetitions (15.0% here, 17.1% in the first experiment, 50.2% in one pinned experiment). What I tried: **settling the shadow first** (autovacuum of the freshly loaded tables was running during the first experiment: CV 17.1% became 6.9% and 8.0%; the DDL case 518 ms became about 290 ms), **CPU pinning** to two CPUs (inconclusive, not adopted), **more runs** (10 warmup + 100 measured: no improvement). I did not quiet the laptop itself.
- **The median of the same query moves between experiments run minutes apart by more than the CV inside one experiment** (the before-E1 query: 72.1, 65.6 and 53.0 ms in three consecutive experiments). So: **compare A and B in the same session, interleaved**; call a difference real only above about **40%** for queries of 50 ms or more, a **factor of 2** for queries under 2 ms (use the server time), and about **50%** for DDL durations. Lock modes and rewrite flags are deterministic. A result with `environment.background.quiet: false` should be repeated after `settleShadow`.

### DDL behaviour observed (PostgreSQL 16.15, 200,000-row table, every run rolled back)

| Statement                                          | Lock modes on the table            | Rewritten   | Duration (p50) |
| -------------------------------------------------- | ---------------------------------- | ----------- | -------------- |
| `CREATE INDEX`                                     | ShareLock                          | no          | 137 ms         |
| `ADD COLUMN ... DEFAULT 5`                         | AccessExclusiveLock                | no          | 1.1 ms         |
| `ADD COLUMN ... DEFAULT now()`                     | AccessExclusiveLock                | no (STABLE) | 1.2 ms         |
| `ADD COLUMN ... NOT NULL DEFAULT random()`         | AccessExclusiveLock, ShareLock     | **yes**     | 428 ms         |
| `ADD COLUMN ... DEFAULT gen_random_uuid()`         | AccessExclusiveLock, ShareLock     | **yes**     | 895 ms         |
| `ALTER COLUMN a TYPE bigint` (int, indexed)        | AccessExclusiveLock, ShareLock     | **yes**     | 584 ms         |
| `ALTER COLUMN c TYPE varchar(40)` (from 20)        | AccessExclusiveLock                | no          | 1.0 ms         |
| `ALTER COLUMN b SET NOT NULL`                      | AccessExclusiveLock                | no (scan)   | 17 ms          |
| `ADD CONSTRAINT ... CHECK ... NOT VALID`           | AccessExclusiveLock                | no          | 1.5 ms         |
| `CREATE INDEX CONCURRENTLY` (fresh shadow per run) | ShareUpdateExclusiveLock (sampled) | no          | 457 ms         |

Everything matches PostgreSQL's documented behaviour; the extra `ShareLock` on rewriting statements is the index rebuild after the rewrite (D35).

### Tests

`src/harness/harness.test.ts` runs in `pnpm test` (real Docker and Postgres, about 1 minute): fast versus slow query (the usage-read before the E1 fix against after it: ratios 9.7 and 10.1 by wall clock, 112 and 114 by server time, in two repetitions), plan capture (seq scan versus index scan), writes leaving the data unchanged (row counts and md5 before and after), the DDL table above, lock-wait measurement (a blocker holding ACCESS SHARE for 800 ms gives 801 ms), refusal of non-shadows, typed failures for timeouts, lock timeout, total runtime, invalid input and an unresponsive server (`docker pause`), cold-ish measurements, background detection, and the variance experiment code writing raw files. The 10M-row experiment is `pnpm --filter @ledgerworks/core variance` (minutes; not part of `pnpm test`).

## LLM layer (C2.3 to C2.7)

Provider-agnostic: no vendor SDK, plain `fetch`. **Everything a model returns is untrusted input**: text, tool names, tool arguments, and anything inside tool results that is sent back to it. No claims about model quality are made anywhere in this code or these docs. No real provider key is needed by `pnpm test` or CI: all tests use `FakeProvider` and a local mock HTTP server; real-provider checks are the manual script `pnpm llm:smoke`.

### The interface (`src/llm/types.ts`)

```ts
interface LLMProvider {
  readonly id: string;
  readonly model: string;
  capabilities(): Capabilities; // each entry: { value, source: 'declared' | 'probed' | 'unknown', probedAt? }
  updateCapabilities?(patch: Partial<Capabilities>): void;
  chat(request: ChatRequest): Promise<ChatResult>; // throws LLMError
  stream(request: ChatRequest): AsyncIterable<StreamEvent>; // never throws a provider error: a failed stream ends with an `error` event
  listModels?(signal?: AbortSignal): Promise<string[]>;
}
```

- **Messages:** `system`, `user`, `assistant` (`content` or `toolCalls`), `tool` (`toolCallId`, `content`). **Tools:** `{ name, description, parameters: JSON Schema }`. **`ToolCall`:** `{ id, name, arguments (parsed, unvalidated), rawArguments (the model's own string), argumentsError? }`; a call whose arguments are not valid JSON is passed on flagged, never repaired silently.
- **`ChatRequest`:** `messages`, `tools`, `toolChoice` (`auto`, `none`, `required`, `{ name }`), `temperature`, `maxTokens`, `jsonMode`, `signal` (`AbortSignal`: **cancellation works everywhere** and gives the `cancelled` error), `timeoutMs`, `conversationId`.
- **`ChatResult`:** `content`, `toolCalls`, `finishReason` (`stop`, `tool_calls`, `length`, `content_filter`, `other`), `usage` (`promptTokens`, `completionTokens`, `totalTokens`, and `source: 'provider' | 'estimated'`: estimated numbers are about 4 characters per token and are labelled), `quirks` (what the adapter normalised), `rateLimit` (from response headers), `routing` (set by a fallback chain).
- **`StreamEvent`:** `text_delta`, `tool_call_start` (`index`, `id`, `name`), `tool_call_delta` (`argumentsDelta`), `tool_call_end`, `usage`, `done` (with the assembled `ChatResult`), `error` (typed `LLMError`, always last).
- **`Capabilities`:** `tools`, `streaming`, `jsonMode`, `parallelToolCalls`, `maxContext`, each `{ value: T | null, source: 'declared' | 'probed' | 'unknown' }`.
- **Errors (`src/llm/errors.ts`):** `LLMError` with `kind` one of `rate_limited` (with `retryAfterMs` when known), `auth_failed`, `timeout`, `network`, `bad_request`, `server_error`, `invalid_response`, `context_length`, `content_filtered`, `cancelled`; plus `status`, `provider`, `midStream` (content had already been delivered) and, for a fallback chain, `causes`. Messages are redacted (`src/security/redact.ts`) and capped; an error never holds a key, headers, or a request or response body.
- **`FakeProvider` (`src/llm/fake.ts`):** scripts normal replies, tool calls (also malformed arguments and unknown tool names), 429s and other typed errors, hangs (timeout or cancellation), mid-stream failures and slow streams (with an injectable `ManualClock`), and records every request. `collectStream` assembles a stream into a result.

### OpenAI-compatible adapter (`src/llm/openai.ts`, C2.4)

```ts
const provider = new OpenAICompatibleProvider({
  baseURL: 'https://api.groq.com/openai/v1',
  apiKey: process.env.LLM_API_KEY!,
  model: 'some-model',
  headers: { 'x-title': 'ledgerworks' },
  timeoutMs: 60_000,
  maxRetries: 3,
});
const r = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
for await (const e of provider.stream({ messages })) {
  /* text_delta, tool_call_*, usage, done | error */
}
const models = await provider.listModels(); // GET /models, if the endpoint has it
```

Plain `fetch` (injectable: the safe fetch of C2.7 has the same shape), the OpenAI chat-completions format (`/chat/completions`, `tools`, `tool_choice`, `response_format`, `stream_options.include_usage`).

- **Streaming (server-sent events):** partial tool-call arguments are assembled across chunks; several tool calls in one response; `[DONE]`; comment lines and keep-alives; a stream that ends without `[DONE]` but with a finish reason (accepted, flagged `stream_ended_without_done`); one that ends without finishing (typed mid-stream `network` error) or before any content (`invalid_response`); a malformed chunk (`invalid_response` event, no crash); an error object inside the stream; usage from the last chunk, or an **estimate flagged `estimated`** when the server sends none. Limits: bytes, events, total duration, idle time between chunks.
- **Retries:** exponential backoff with full jitter on 429, 5xx and network errors; `Retry-After` (seconds or HTTP date, also `retry-after-ms`) is honored as a minimum; a retry budget (default 60 s of sleeping) and `maxRetries`; no retry on other 4xx, on `insufficient_quota`, or on a timeout; **no retry after a stream has delivered content** (a typed `midStream` error instead). Time (`Clock`) and randomness are injectable, so the tests do not sleep.
- **Errors:** 401/403 `auth_failed`; 429 `rate_limited` (with `retryAfterMs`); 5xx `server_error`; 408 and our own timeouts `timeout`; 400/413/422 `context_length` (code or message), `content_filtered`, otherwise `bad_request`; 404 `bad_request`; connection failures `network`; unreadable or incomplete bodies `invalid_response`; the caller's abort `cancelled`. Messages are redacted (the key, bearer tokens, URL credentials); no body or header is kept.

**Provider quirks handled** (each one that fires is listed in `ChatResult.quirks`):

| Quirk                                                                                                                 | What the adapter does                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| tool-call `arguments` as an object instead of a JSON string                                                           | accepts it, `arguments_as_object`                                                                                                               |
| `arguments` empty string or `null` (tool without parameters)                                                          | `{}`, `empty_arguments`                                                                                                                         |
| `arguments` encoded twice (a JSON string holding a JSON string)                                                       | decodes once more, `double_encoded_arguments`                                                                                                   |
| `arguments` not valid JSON, or valid JSON that is not an object                                                       | **not repaired**: the call is passed on with `argumentsError` and the raw text                                                                  |
| tool call without `id`                                                                                                | generates `call_<n>`, `tool_call_id_generated`; **duplicate ids are `invalid_response`**                                                        |
| tool call without a `function` wrapper (`name` and `arguments` on the call)                                           | `flat_tool_call`                                                                                                                                |
| legacy single `function_call`                                                                                         | converted, `legacy_function_call`                                                                                                               |
| `finish_reason: "stop"` together with tool calls                                                                      | corrected to `tool_calls`, `finish_reason_corrected_to_tool_calls`; `finish_reason: "tool_calls"` with no readable call is `invalid_response`   |
| message `content` as a list of parts                                                                                  | joined, `content_as_parts`                                                                                                                      |
| tool call returned as **plain text** (`<tool_call>{...}</tool_call>`, a bare JSON object or array, or one json fence) | converted only when the whole reply has that shape and every `name` is one of the **offered** tools, `text_tool_call`; anything else stays text |
| streamed tool calls without `index`                                                                                   | a new `id`, or a new name after a named call, starts a new call, `tool_call_index_missing`                                                      |
| no usage in the response                                                                                              | estimated (about 4 characters per token), `usage_estimated`, `usage.source: 'estimated'`                                                        |
| tool call without a name                                                                                              | `invalid_response`                                                                                                                              |

**Manual real-provider check:** `LLM_BASE_URL=... LLM_API_KEY=... LLM_MODEL=... pnpm llm:smoke` runs a plain chat, a streaming chat and one tool-call round trip, prints a summary with the key masked (last 4 characters), and saves the sanitised raw report to `docs/benchmarks/raw/llm-smoke-<host>-<time>.json` (never overwritten). It exits with code 2 and makes no request when a variable is missing. Nothing in the automated tests or CI needs a key.

### Agent loop (`src/agent/`, C2.5)

```ts
import { runAgent, defineTool } from '@ledgerworks/core';
import { z } from 'zod';

const weather = defineTool({
  name: 'get_weather',
  description: 'Current weather for a city',
  parameters: z.object({ city: z.string() }).strict(), // validated before execute runs; also the JSON Schema offered to the model
  execute: async ({ city }, { signal }) => lookup(city, signal),
});
const run = await runAgent({
  provider,
  system,
  prompt: 'weather in Pune?',
  tools: [weather],
  maxSteps: 8,
  tokenBudget: 20_000,
  wallClockMs: 60_000,
  toolConcurrency: 4,
  maxToolResultBytes: 16_384,
  approve: async (req) => askTheHuman(req),
});
run.stopReason;
run.finalAnswer;
run.trace;
```

- **Stop reasons** (typed): `final_answer`, `step_limit`, `token_budget`, `wall_clock`, `cancelled`, `provider_error` (with the `LLMError` kind), `tool_failure`, `capability_unsupported` (tools offered to a model probed or declared as not supporting them).
- **Arguments** are validated with zod before a tool runs; invalid arguments get **one** repair attempt (the validation error goes back as a tool result), then a typed failure for that call; `onToolFailure: 'continue' | 'stop'`. Unknown tool names, thrown errors, hangs (timeout) and oversized results (`[truncated: N bytes omitted]`) are tool results, never crashes. Parallel calls run under `toolConcurrency`.
- **Tool results are data:** each is a `tool` message inside `<<<DATA-<random token> ... DATA-<token>>>>` markers, never part of the system prompt.
- **Approval:** tools with `requiresApproval` go through `approve` first; denied (or no approver) returns "denied by user".
- **Trace:** `run.trace` lists every model call (latency, usage, routing) and tool call (arguments hash, latency, outcome, repair, truncation, approval); arguments and results appear only with `debug: true`; no key ever (tested).
- **Injection tests check the loop's mechanics, not any model's resistance to injection** (D39).

### Fallback chain and "test connection" (`src/llm/chain.ts`, `src/llm/probe.ts`, C2.6)

```ts
const chain = new FallbackProvider({
  members: [
    { provider: groq, quota: { requestsPerMinute: 30 } },
    { provider: openrouter },
    { provider: local },
  ],
  breaker: { failureThreshold: 3, cooldownMs: 30_000 },
});
const r = await chain.chat({ messages, conversationId }); // r.routing: which provider answered, why the others were skipped
chain.health(); // circuit state and quota usage per provider
const report = await testConnection(groq); // reachable, auth, model exists, streaming, tools, JSON mode, latency
```

- **Falls over** after `rate_limited`, `server_error`, `timeout`, `network`; **surfaces** `bad_request`, `auth_failed`, `content_filtered` (and `context_length`, `invalid_response`, `cancelled`). All down: one `LLMError` with `causes` listing each provider's reason.
- **Circuit breaker** (open after N consecutive failures, one trial request when half-open after a cooldown, injectable clock) and **quota tracker** (requests and tokens per minute and day; updated from rate-limit headers and Retry-After; an exhausted provider is skipped without a request).
- **Probe report** (`ProbeReport`): `reachable`, `authOk`, `modelExists`, `streaming`, `tools` (a forced tool call whose arguments must validate), `jsonMode`, `latencyMs`, per-check `evidence`, and `capabilities` labelled `probed` with a timestamp. A feature is `false` only on evidence; a timeout leaves it unknown. Agents that need tools refuse to start (`capability_unsupported`) on a provider probed as not supporting them.

### Bring-your-own-key safety (`src/security/`, C2.7)

```ts
// built once, by server code. The dev flag is never read from a request or a stored config.
const safeFetch = createSafeFetch({
  allowInsecureLocalhost: process.env.NODE_ENV === 'development',
  maxRedirects: 0,
  hostDenylist,
});
const provider = new OpenAICompatibleProvider({
  baseURL: userSuppliedUrl,
  apiKey,
  model,
  fetch: safeFetch,
});

const ring = Keyring.fromEnv(process.env); // LEDGERWORKS_SECRET_KEYS, LEDGERWORKS_SECRET_KEY_ID
const stored = encryptSecret(ring, apiKey, configId); // AES-256-GCM, random nonce, key id inside the value
const key = decryptSecret(ring, stored, configId);
```

- **URLs:** HTTPS only (HTTP to localhost only with the server-side dev flag), no credentials, no fragment, a maximum length, internal names and special-purpose IP literals refused (decimal, hex, octal and short encodings of 127.0.0.1, `localhost` variants, trailing dots, IPv4-mapped IPv6 all covered), host allow and deny hooks.
- **SSRF:** the host is resolved by us, every answer must be public, and the connection goes to the validated IP with the original Host header and TLS server name (DNS rebinding cannot swap the address); no automatic redirects (re-validated hops if enabled); connect and total timeouts; maximum response size, also for streams.
- **Keys:** AES-256-GCM with a key id for rotation, keys only in the environment; redaction in every error, trace, log and the smoke output; only the last 4 characters are ever displayed (`maskKey`).
- The test matrix (about 170 cases) and the list of remaining risks are in `src/security/security.test.ts` and DECISIONS.md D41.
