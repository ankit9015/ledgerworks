import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  InMemorySpanExporter,
  BasicTracerProvider,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, runAgent } from '../agent/index.js';
import type { RunResult } from '../agent/types.js';
import { FallbackProvider } from '../llm/chain.js';
import { FakeProvider, type FakeScript } from '../llm/fake.js';
import { ManualClock } from '../llm/types.js';
import { startMock, json, type MockServer } from '../llm/testing/mock-server.js';
import { LangfuseSink, langfuseFromEnv } from './langfuse.js';
import { JsonlFileSink } from './jsonl.js';
import { OtelSink } from './otel.js';
import { TraceLineSchema } from './schema.js';
import { computeCost } from './cost.js';
import { listRuns, parseTraceFile, renderTrace } from './show.js';
import { emitTrace, prepareForExport, type TraceSink } from './sinks.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const coreDir = path.resolve(here, '../..');
const KEY = 'sk-test-PLANTEDKEY0123456789abcd';
const PASS = 'hunter2-PLANTED';
const PROMPT = 'PLANTED-PROMPT-TEXT-8841';
const SYSTEM = 'PLANTED-SYSTEM-PROMPT-1207';
const ARG = 'PLANTED-ARG-VALUE-3392';
const RESULT = 'PLANTED-RESULT-VALUE-7710';
const OUTPUT = 'PLANTED-MODEL-OUTPUT-5521';
const ALL_PLANTED = [KEY, PASS, PROMPT, SYSTEM, ARG, RESULT, OUTPUT, 'SECRETSUFFIX'];

let servers: MockServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
  delete process.env.CI;
  delete process.env.LEDGERWORKS_CI;
});
const tmp = (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'lw-trace-'));
const call = (name: string, args: unknown) => ({ name, arguments: args });
const calls = (...c: ReturnType<typeof call>[]) => ({ type: 'tool_calls' as const, calls: c });
const text = (content: string) => ({ type: 'text' as const, content });

const lookup = defineTool({
  name: 'lookup',
  description: 'looks something up',
  parameters: z.object({ q: z.string() }).strict(),
  execute: (a: { q: string }) => `result for ${a.q}: ${RESULT}`,
});

/** A run with a fall-over (groq rate limited, openrouter answers), an invalid call that is repaired, and an unknown tool. */
async function interestingRun(
  extra: Partial<Parameters<typeof runAgent>[0]> = {},
): Promise<RunResult> {
  const a = new FakeProvider({
    id: 'groq',
    script: [{ type: 'error', error: { kind: 'rate_limited', status: 429, retryAfterMs: 2000 } }],
  });
  const b = new FakeProvider({
    id: 'openrouter',
    model: 'model-b',
    script: [
      {
        type: 'tool_calls',
        calls: [call('lookup', { q: 7 })],
        usage: { promptTokens: 120, completionTokens: 18, totalTokens: 138 },
      },
      {
        type: 'tool_calls',
        calls: [call('lookup', { q: ARG }), call('delete_everything', {})],
        usage: { promptTokens: 190, completionTokens: 15, totalTokens: 205 },
      },
      {
        type: 'text',
        content: `done ${OUTPUT}`,
        usage: { promptTokens: 240, completionTokens: 9, totalTokens: 249 },
      },
    ],
  });
  const chain = new FallbackProvider({
    members: [{ provider: a }, { provider: b }],
    clock: new ManualClock(),
  });
  return runAgent({
    provider: chain,
    system: SYSTEM,
    prompt: `${PROMPT} please look it up`,
    tools: [lookup],
    secrets: [KEY],
    ...extra,
  });
}

// ---------------------------------------------------------------------------------------------
describe('JSONL file sink and the viewer', () => {
  it('a run through the fake provider writes a valid trace line with its steps and token counts', async () => {
    const dir = await tmp();
    const sink = new JsonlFileSink({ dir });
    const run = await interestingRun({ traceSinks: [sink] });
    expect(run.traceErrors).toBeUndefined();
    const lines = (await readFile(path.join(dir, 'runs.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    const line = TraceLineSchema.parse(JSON.parse(lines[0]!));
    expect(line.trace.runId).toBe(run.trace.runId);
    expect(line.trace.steps).toHaveLength(3);
    expect(line.trace.totals).toMatchObject({
      modelCalls: 3,
      toolCalls: 3,
      repairs: 1,
      totalTokens: 592,
      tokensEstimated: false,
    });
    expect(line.trace.steps[0]!.model.routing).toEqual({
      provider: 'openrouter',
      skipped: [{ provider: 'groq', reason: 'rate_limited (HTTP 429)' }],
    });
    expect(line.trace.steps[0]!.model.usage).toEqual({
      promptTokens: 120,
      completionTokens: 18,
      totalTokens: 138,
      source: 'provider',
    });
  });

  it('the default directory is under .ledgerworks (gitignored), and the file is private', async () => {
    const ignore = await readFile(path.resolve(coreDir, '../.gitignore'), 'utf8');
    expect(ignore).toMatch(/^\.ledgerworks\/$/m);
    expect(new JsonlFileSink().dir).toBe(path.join(process.cwd(), '.ledgerworks', 'traces'));
  });

  it('caps the file size by rotating, keeps only maxFiles, and every line stays valid', async () => {
    const dir = await tmp();
    const sink = new JsonlFileSink({ dir, maxFileBytes: 4000, maxFiles: 3 });
    const base = (await interestingRun()).trace;
    for (let i = 0; i < 14; i++) await sink.write({ ...base, runId: `run-${i}` });
    const files = (await readdir(dir)).sort();
    expect(files.length).toBeLessThanOrEqual(3);
    expect(files).toContain('runs.jsonl');
    expect(files.length).toBeGreaterThan(1); // it did rotate
    for (const f of files) {
      expect((await stat(path.join(dir, f))).size).toBeLessThanOrEqual(4000 + 100);
      for (const l of (await readFile(path.join(dir, f), 'utf8')).trim().split('\n'))
        TraceLineSchema.parse(JSON.parse(l));
    }
    // the newest run is in the current file; the oldest have been dropped
    expect(await readFile(path.join(dir, 'runs.jsonl'), 'utf8')).toContain('run-13');
    const all = (await Promise.all(files.map((f) => readFile(path.join(dir, f), 'utf8')))).join('');
    expect(all).not.toContain('"run-0"');
  });

  it('concurrent runs never interleave their lines', async () => {
    const dir = await tmp();
    const sink = new JsonlFileSink({ dir });
    const base = (await interestingRun()).trace;
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => sink.write({ ...base, runId: `c-${i}` })),
    );
    const lines = (await readFile(path.join(dir, 'runs.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(25);
    expect(new Set(lines.map((l) => TraceLineSchema.parse(JSON.parse(l)).trace.runId)).size).toBe(
      25,
    );
  });

  it('the viewer renders a run with a fall-over and a repair as a timeline', async () => {
    const dir = await tmp();
    await interestingRun({ traceSinks: [new JsonlFileSink({ dir })] });
    const { runs, bad } = parseTraceFile(await readFile(path.join(dir, 'runs.jsonl'), 'utf8'));
    expect(bad).toBe(0);
    const out = renderTrace(runs[0]!);
    expect(out).toMatch(/^run [0-9a-f-]{36} {2}FINAL_ANSWER /);
    expect(out).toContain('tokens 550 in + 42 out = 592 (reported by the provider)');
    expect(out).toContain('step 0  openrouter / model-b');
    expect(out).toContain('FELL OVER from groq (rate_limited (HTTP 429))');
    expect(out).toContain('invalid_arguments');
    expect(out).toMatch(/tool lookup {2}ok .*\[REPAIRED\]/);
    expect(out).toContain('tool (unknown)  unknown_tool');
    expect(out).toContain('138 tok');
    expect(out).toMatch(/step 2 .*finish stop/);
    expect(out).toContain('cost   not computed: no price table is configured');
    expect(out).toMatch(
      /3 step\(s\), 3 tool call\(s\): 2 not ok, 1 repaired, 0 failed for good, 0 truncated/,
    );
    for (const planted of ALL_PLANTED) expect(out).not.toContain(planted);
    expect(listRuns(runs)).toMatch(/^\s*0 {2}[0-9a-f]{8} {2}.*final_answer\s+3 steps {2}592 tok/);
  });

  it('the viewer prints control characters and escape sequences from a hostile file safely, and skips bad lines', async () => {
    const dir = await tmp();
    const run = (await interestingRun()).trace;
    run.steps[0]!.toolCalls[0]!.name = 'evil\u001b[31m\u0007name';
    run.steps[0]!.model.provider = 'p\u001b]0;pwned\u0007';
    const file = path.join(dir, 'x.jsonl');
    await writeFile(
      file,
      'not json\n' +
        JSON.stringify({
          v: 1,
          kind: 'agent-run',
          exportedAt: new Date().toISOString(),
          trace: run,
        }) +
        '\n{"v":2}\n',
    );
    const { runs, bad } = parseTraceFile(await readFile(file, 'utf8'));
    expect(bad).toBe(2);
    const out = renderTrace(runs[0]!);
    expect(
      [...out].some((ch) => {
        const c = ch.charCodeAt(0);
        return (c < 32 && c !== 10) || c === 127;
      }),
    ).toBe(false);
    expect(out).toContain('evilname'.replace('name', '[31mname'));
  });

  it('the command prints a run (default: the last), lists runs, and fails clearly on a missing file', async () => {
    const dir = await tmp();
    const sink = new JsonlFileSink({ dir });
    await interestingRun({ traceSinks: [sink] });
    await interestingRun({ traceSinks: [sink] });
    const run = (args: string[]) =>
      spawnSync(process.execPath, ['--import', 'tsx', path.join(here, 'show.ts'), ...args], {
        cwd: coreDir,
        encoding: 'utf8',
      });
    const shown = run([path.join(dir, 'runs.jsonl')]);
    expect(shown.status).toBe(0);
    expect(shown.stdout).toContain('FELL OVER from groq');
    const listed = run([path.join(dir, 'runs.jsonl'), '--list']);
    expect(listed.stdout.trim().split('\n')).toHaveLength(2);
    expect(run([path.join(dir, 'runs.jsonl'), '--run', '0']).status).toBe(0);
    expect(run([path.join(dir, 'runs.jsonl'), '--run', '9']).status).toBe(1);
    expect(run([path.join(dir, 'nope.jsonl')]).status).toBe(1);
    expect(run([]).status).toBe(2);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------
describe('OpenTelemetry bridge', () => {
  function otel() {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    return { exporter, tracer: provider.getTracer('test') };
  }
  const byName = (spans: ReadableSpan[], n: string): ReadableSpan[] =>
    spans.filter((s) => s.name === n);

  it('emits one run span, one span per model call and one per tool call, with real timing and the same no-secrets rules', async () => {
    const { exporter, tracer } = otel();
    const run = await interestingRun({ traceSinks: [new OtelSink({ tracer, secrets: [KEY] })] });
    expect(run.traceErrors).toBeUndefined();
    const spans = exporter.getFinishedSpans();
    const root = byName(spans, 'agent.run');
    expect(root).toHaveLength(1);
    expect(byName(spans, 'agent.model_call')).toHaveLength(3);
    expect(byName(spans, 'agent.tool_call')).toHaveLength(3);
    expect(spans).toHaveLength(7);
    const rootId = root[0]!.spanContext().spanId;
    for (const s of spans.filter((x) => x.name !== 'agent.run')) {
      expect(s.parentSpanContext?.spanId).toBe(rootId);
      expect(s.spanContext().traceId).toBe(root[0]!.spanContext().traceId);
    }
    expect(root[0]!.attributes).toMatchObject({
      'agent.run_id': run.trace.runId,
      'agent.stop_reason': 'final_answer',
      'agent.steps': 3,
      'agent.repairs': 1,
      'llm.tokens.total': 592,
      'llm.tokens.estimated': false,
    });
    const first = byName(spans, 'agent.model_call')[0]!;
    expect(first.attributes).toMatchObject({
      'llm.provider': 'openrouter',
      'llm.model': 'model-b',
      'llm.tokens.total': 138,
      'llm.routing.skipped_count': 1,
      'agent.step': 0,
    });
    expect(String(first.attributes['llm.routing.skipped'])).toContain(
      'groq: rate_limited (HTTP 429)',
    );
    const tools = byName(spans, 'agent.tool_call');
    expect(tools.map((t) => [t.attributes['tool.name'], t.attributes['tool.outcome']])).toEqual([
      ['lookup', 'invalid_arguments'],
      ['lookup', 'ok'],
      ['(unknown)', 'unknown_tool'],
    ]);
    expect(tools[1]!.attributes['tool.repair']).toBe(true);
    expect(tools[2]!.status.code).toBe(2); // ERROR
    // the timeline is the recorded one
    expect(root[0]!.startTime[0]).toBe(Math.floor(new Date(run.trace.startedAt).getTime() / 1000));
    expect(spans.every((s) => s.endTime[0] > 0)).toBe(true);
  });

  it('a failed model call and a failed run set the span status', async () => {
    const { exporter, tracer } = otel();
    const p = new FakeProvider({
      script: [{ type: 'error', error: { kind: 'auth_failed', status: 401 } }],
    });
    await runAgent({ provider: p, prompt: 'x', traceSinks: [new OtelSink({ tracer })] });
    const spans = exporter.getFinishedSpans();
    expect(byName(spans, 'agent.run')[0]!.status.code).toBe(2);
    const m = byName(spans, 'agent.model_call')[0]!;
    expect(m.status.code).toBe(2);
    expect(m.attributes['llm.error.kind']).toBe('auth_failed');
  });
});

// ---------------------------------------------------------------------------------------------
describe('Langfuse sink (mock server)', () => {
  const cfg = (
    s: MockServer,
    extra: Partial<ConstructorParameters<typeof LangfuseSink>[0]> = {},
  ) => ({
    host: s.url,
    publicKey: 'pk-lf-PUBLICPART',
    secretKey: 'sk-lf-SECRETSUFFIX0123456789',
    ...extra,
  });

  it('posts one trace, a generation per model call and a span per tool call, with usage and no content', async () => {
    const s = await startMock((_r, res) => json(res, 207, { successes: [], errors: [] }));
    servers.push(s);
    const run = await interestingRun({
      traceSinks: [new LangfuseSink(cfg(s, { secrets: [KEY] }))],
    });
    expect(run.traceErrors).toBeUndefined();
    expect(s.requests).toHaveLength(1);
    const req = s.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/public/ingestion');
    expect(req.headers.authorization).toBe(
      `Basic ${Buffer.from('pk-lf-PUBLICPART:sk-lf-SECRETSUFFIX0123456789').toString('base64')}`,
    );
    const batch = (
      JSON.parse(req.body) as { batch: { type: string; body: Record<string, unknown> }[] }
    ).batch;
    expect(batch.map((e) => e.type)).toEqual([
      'trace-create',
      'generation-create',
      'span-create',
      'generation-create',
      'span-create',
      'span-create',
      'generation-create',
    ]);
    expect(batch[0]!.body).toMatchObject({
      id: run.trace.runId,
      name: 'agent-run',
      metadata: { stopReason: 'final_answer' },
    });
    expect(batch[1]!.body).toMatchObject({
      traceId: run.trace.runId,
      model: 'model-b',
      usage: { input: 120, output: 18, total: 138, unit: 'TOKENS' },
    });
    expect(batch[5]!.body.name).toBe('tool:(unknown)');
    for (const planted of ALL_PLANTED) expect(req.body).not.toContain(planted);
    expect(req.body).not.toContain('SECRETSUFFIX');
  });

  it('is configured only from environment variables', () => {
    expect(langfuseFromEnv({})).toBeNull();
    expect(langfuseFromEnv({ LANGFUSE_HOST: 'http://x' })).toBeNull();
    expect(
      langfuseFromEnv({
        LANGFUSE_HOST: 'http://x',
        LANGFUSE_PUBLIC_KEY: 'a',
        LANGFUSE_SECRET_KEY: 'b',
      }),
    ).toBeInstanceOf(LangfuseSink);
  });

  it('a server that fails, refuses, rejects events, or never answers does not break or noticeably slow the run; its keys never show in the error', async () => {
    const t0 = Date.now();
    const failing = await startMock((_r, res) =>
      json(res, 500, { message: 'down sk-lf-SECRETSUFFIX0123456789' }),
    );
    servers.push(failing);
    const r1 = await interestingRun({ traceSinks: [new LangfuseSink(cfg(failing))] });
    expect(r1.stopReason).toBe('final_answer');
    expect(r1.traceErrors).toEqual([{ sink: 'langfuse', message: 'Langfuse answered HTTP 500' }]);

    const refusing = await startMock((_r, res) => json(res, 207, { errors: [{ id: 'x' }] }));
    servers.push(refusing);
    expect(
      (await interestingRun({ traceSinks: [new LangfuseSink(cfg(refusing))] })).traceErrors![0]!
        .message,
    ).toBe('Langfuse refused 1 event(s)');

    const closed = await startMock(() => undefined);
    const dead = { ...cfg(closed) };
    await closed.close();
    const r3 = await interestingRun({ traceSinks: [new LangfuseSink(dead)] });
    expect(r3.stopReason).toBe('final_answer');
    expect(r3.traceErrors).toHaveLength(1);

    const hanging = await startMock(() => undefined);
    servers.push(hanging);
    const t1 = Date.now();
    const r4 = await interestingRun({
      traceSinks: [new LangfuseSink(cfg(hanging, { timeoutMs: 200 }))],
    });
    expect(Date.now() - t1).toBeLessThan(1500);
    expect(r4.stopReason).toBe('final_answer');
    expect(r4.traceErrors![0]!.message).toMatch(/no answer within 200 ms/);
    expect(JSON.stringify([r1, r3, r4].map((r) => r.traceErrors))).not.toContain('SECRETSUFFIX');
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
});

// ---------------------------------------------------------------------------------------------
describe('tracing never breaks or slows a run', () => {
  const sink = (name: string, write: TraceSink['write']): TraceSink => ({ name, write });

  it('a sink that throws, rejects or hangs is reported; the run result is unchanged; the other sinks still get the trace', async () => {
    const dir = await tmp();
    const good = new JsonlFileSink({ dir });
    const t0 = Date.now();
    const run = await interestingRun({
      traceTimeoutMs: 300,
      traceSinks: [
        sink('throws', () => {
          throw new Error(`boom ${KEY}`);
        }),
        sink('rejects', () => Promise.reject(new Error('nope'))),
        sink('hangs', () => new Promise<void>(() => undefined)),
        good,
      ],
    });
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(run.stopReason).toBe('final_answer');
    expect(run.finalAnswer).toContain(OUTPUT);
    expect(run.traceErrors!.map((e) => e.sink).sort()).toEqual(['hangs', 'rejects', 'throws']);
    expect(run.traceErrors!.find((e) => e.sink === 'hangs')!.message).toMatch(
      /did not finish within 300 ms/,
    );
    expect(JSON.stringify(run.traceErrors)).not.toContain(KEY);
    expect((await readFile(path.join(dir, 'runs.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(
      1,
    );
  });

  it('a sink cannot change the trace the caller gets (each sink receives a copy)', async () => {
    const run = await interestingRun({
      traceSinks: [
        sink('vandal', (t) => {
          t.steps.length = 0;
          t.stopReason = 'cancelled';
        }),
      ],
    });
    expect(run.trace.stopReason).toBe('final_answer');
    expect(run.trace.steps).toHaveLength(3);
  });

  it('with no sinks nothing changes; emitTrace with an empty list returns at once', async () => {
    const run = await interestingRun();
    expect(run.traceErrors).toBeUndefined();
    expect(await emitTrace([], run.trace)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('privacy: planted keys, prompts, arguments and results never reach an exported trace', () => {
  async function exportEverywhere(opts: { debug?: boolean; includeDebugContent?: boolean } = {}) {
    const dir = await tmp();
    const exporter = new InMemorySpanExporter();
    const tracer = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    }).getTracer('t');
    const lf = await startMock((_r, res) => json(res, 207, { errors: [] }));
    servers.push(lf);
    // a provider whose ERROR echoes the prompt and the key (what some servers do)
    const echoing = new FakeProvider({
      id: 'echo',
      script: [
        {
          type: 'error',
          error: {
            kind: 'server_error',
            status: 500,
            message: `server echoed: ${PROMPT} and ${KEY}`,
          },
        },
      ],
    });
    const secrets = [KEY, PASS];
    const sinks: TraceSink[] = [
      new JsonlFileSink({ dir, secrets, includeDebugContent: opts.includeDebugContent }),
      new OtelSink({ tracer, secrets }),
      new LangfuseSink({
        host: lf.url,
        publicKey: 'pk-lf-PUBLICPART',
        secretKey: 'sk-lf-SECRETSUFFIX0123456789',
        secrets,
      }),
    ];
    const boom = defineTool({
      name: 'boom',
      description: 'always fails',
      parameters: z.object({}),
      execute: () => {
        throw new Error(`failed with password=${PASS} and ${KEY}`);
      },
    });
    const tools = [lookup, boom];
    const mainRun = await runAgent({
      provider: new FakeProvider({
        script: [
          calls(
            call('lookup', { q: `${ARG} ${KEY}` }),
            call('boom', {}),
            call(`${PROMPT}-as-a-tool-name`, {}),
          ),
          text(`final ${OUTPUT}`),
        ],
      }),
      system: SYSTEM,
      prompt: `${PROMPT} ${KEY}`,
      tools,
      secrets,
      debug: opts.debug,
      traceSinks: sinks,
    });
    const errRun = await runAgent({
      provider: echoing,
      system: SYSTEM,
      prompt: PROMPT,
      tools,
      secrets,
      debug: opts.debug,
      traceSinks: sinks,
    });
    const file = await readFile(path.join(dir, 'runs.jsonl'), 'utf8');
    const spans = JSON.stringify(
      exporter.getFinishedSpans().map((s) => ({
        name: s.name,
        attributes: s.attributes,
        events: s.events,
        status: s.status,
      })),
    );
    const langfuse = lf.requests.map((r) => r.body).join('\n');
    return {
      file,
      spans,
      langfuse,
      mainRun,
      errRun,
      spanCount: exporter.getFinishedSpans().length,
    };
  }

  it('default: nothing planted appears in the JSONL file, the spans, the Langfuse bodies, or the in-memory trace', async () => {
    const x = await exportEverywhere();
    expect(x.spanCount).toBe(8);
    for (const [where, data] of Object.entries({
      file: x.file,
      spans: x.spans,
      langfuse: x.langfuse,
      traceErrors: JSON.stringify([x.mainRun.traceErrors, x.errRun.traceErrors]),
    })) {
      for (const planted of ALL_PLANTED)
        expect(data, `${planted} in ${where}`).not.toContain(planted);
    }
    // the in-memory trace is key-free; it may hold model-chosen names and provider error text (never exported)
    for (const secret of [KEY, PASS])
      for (const r of [x.mainRun, x.errRun]) expect(JSON.stringify(r.trace)).not.toContain(secret);
    expect(x.file.length).toBeGreaterThan(500); // the scan is not vacuous: there is a lot of trace to scan
    expect(x.file).toContain('"outcome":"error"');
    expect(x.file).toContain('(withheld: provider text is not exported)');
    // what IS there: hashes, sizes, timings, tokens, names of providers and models, stop reasons
    expect(x.file).toMatch(/"argumentsHash":"[0-9a-f]{16}"/);
    expect(x.file).toContain('"provider":"echo"');
  });

  it('with debug content requested, the sink opts in, and it is not CI: content appears, secrets are still redacted', async () => {
    const x = await exportEverywhere({ debug: true, includeDebugContent: true });
    expect(x.file).toContain(ARG); // arguments of the lookup call are content
    expect(x.file).toContain(RESULT);
    for (const secret of [KEY, PASS, 'SECRETSUFFIX']) {
      expect(x.file).not.toContain(secret);
      expect(x.spans).not.toContain(secret);
      expect(x.langfuse).not.toContain(secret);
      expect(JSON.stringify(x.mainRun.trace)).not.toContain(secret);
    }
    // OpenTelemetry and Langfuse never get content, even in a debug run
    for (const content of [ARG, RESULT, PROMPT, SYSTEM, OUTPUT]) {
      expect(x.spans).not.toContain(content);
      expect(x.langfuse).not.toContain(content);
    }
    expect(x.file).not.toContain(SYSTEM);
    expect(x.file).not.toContain(OUTPUT);
  });

  it('debug content is NOT exported in CI, even when the sink asks for it', async () => {
    process.env.CI = 'true';
    const x = await exportEverywhere({ debug: true, includeDebugContent: true });
    for (const planted of ALL_PLANTED) expect(x.file).not.toContain(planted);
    expect(x.file).toContain('"debug":false');
    delete process.env.CI;
    process.env.LEDGERWORKS_CI = '1';
    const y = await exportEverywhere({ debug: true, includeDebugContent: true });
    expect(y.file).not.toContain(ARG);
  });

  it('debug content needs both the run flag and the sink option; neither alone exports it', async () => {
    expect((await exportEverywhere({ debug: true })).file).not.toContain(RESULT);
    expect((await exportEverywhere({ includeDebugContent: true })).file).not.toContain(RESULT);
  });

  it('no compose profile switches debug tracing on', async () => {
    const compose = await readFile(path.resolve(coreDir, '../docker-compose.yml'), 'utf8');
    expect(compose).not.toMatch(/TRACE_DEBUG|includeDebugContent|LEDGERWORKS_TRACE/i);
    const ci = await readFile(path.resolve(coreDir, '../.github/workflows/ci.yml'), 'utf8');
    expect(ci).not.toMatch(/TRACE_DEBUG|LEDGERWORKS_TRACE/i);
  });

  it('prepareForExport on its own: strips content, caps model-supplied ids, hides unknown tool names and provider error text', async () => {
    const run = await interestingRun({ debug: true });
    expect(JSON.stringify(run.trace)).toContain(ARG); // the in-memory debug trace has content...
    const exported = prepareForExport(run.trace, { secrets: [KEY] });
    expect(JSON.stringify(exported)).not.toContain(ARG); // ...the export does not
    expect(exported.debug).toBe(false);
    const hostile = structuredClone(run.trace);
    hostile.steps[0]!.toolCalls[0]!.callId = 'x'.repeat(500);
    hostile.steps[0]!.toolCalls[0]!.name = 'y'.repeat(500);
    const e2 = prepareForExport(hostile);
    expect(e2.steps[0]!.toolCalls[0]!.callId).toHaveLength(64);
    expect(e2.steps[0]!.toolCalls[0]!.name).toHaveLength(64);
  });
});

// ---------------------------------------------------------------------------------------------
describe('cost and usage', () => {
  it('records tokens with the provider/estimated flag and computes NO dollar cost without a price table', async () => {
    const run = await interestingRun();
    expect(computeCost(run.trace)).toEqual({
      usd: null,
      unpriced: ['model-b'],
      tokensEstimated: false,
      note: 'not computed: no price table is configured',
    });
    const est = await runAgent({
      provider: new FakeProvider({
        script: [{ type: 'text', content: 'x', usage: { source: 'estimated' } }],
      }),
      prompt: 'x',
    });
    expect(est.trace.steps[0]!.model.usage!.source).toBe('estimated');
    expect(computeCost(est.trace).tokensEstimated).toBe(true);
    expect(renderTrace(est.trace)).toContain('some ESTIMATED');
  });

  it('with an explicit price table (made-up numbers, for the test only) it computes, and says when a model is unpriced', async () => {
    const run = await interestingRun();
    const priced = computeCost(run.trace, { 'model-b': { inputPerMTok: 1, outputPerMTok: 2 } });
    expect(priced.usd).toBeCloseTo((550 / 1e6) * 1 + (42 / 1e6) * 2, 12);
    expect(priced.note).toMatch(/provider-reported tokens/);
    const unpriced = computeCost(run.trace, { other: { inputPerMTok: 1, outputPerMTok: 1 } });
    expect(unpriced.usd).toBeNull();
    expect(unpriced.unpriced).toEqual(['model-b']);
    expect(renderTrace(run.trace, { 'model-b': { inputPerMTok: 1, outputPerMTok: 2 } })).toMatch(
      /cost {3}\$0\.0006\d+/,
    );
  });
});

void http;
void ({} as FakeScript);
