import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, runAgent } from '../agent/index.js';
import { OpenAICompatibleProvider } from './openai.js';
import { probeProvider, testConnection, type ProbeReport } from './probe.js';
import { ManualClock } from './types.js';
import {
  chunk,
  completion,
  json,
  sseData,
  sseStart,
  startMock,
  type MockServer,
} from './testing/mock-server.js';

const KEY = 'sk-test-PROBEKEY0123456789abc';
const samples: Record<string, ProbeReport> = {};
let servers: MockServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});
afterAll(async () => {
  const dir = path.resolve(import.meta.dirname, '../../../test-results');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'c2.6-probe-samples.json'),
    JSON.stringify(samples, null, 2) + '\n',
  );
});

interface Behaviour {
  models?: string[] | 'none';
  tools?:
    | 'works'
    | 'refuse400'
    | 'ignore'
    | 'bad_args'
    | 'malformed'
    | 'wrong_tool'
    | 'object_choice_refused';
  stream?: 'works' | 'refuse400' | 'hang';
  jsonMode?: 'works' | 'refuse400' | 'text';
  auth?: 'ok' | 'fail';
}

async function server(
  b: Behaviour = {},
): Promise<{ provider: OpenAICompatibleProvider; server: MockServer }> {
  const s = await startMock((r, res) => {
    if (b.auth === 'fail') return json(res, 401, { error: { message: `bad key ${KEY}` } });
    if (r.url.endsWith('/models')) {
      if (b.models === 'none') return json(res, 404, { error: { message: 'no such route' } });
      return json(res, 200, { data: (b.models ?? ['probe-model']).map((id) => ({ id })) });
    }
    const body = JSON.parse(r.body) as {
      stream?: boolean;
      tools?: unknown[];
      tool_choice?: unknown;
      response_format?: unknown;
    };
    if (body.stream) {
      if (b.stream === 'refuse400')
        return json(res, 400, { error: { message: 'streaming is not supported' } });
      if (b.stream === 'hang') return;
      sseStart(res);
      res.end(sseData(chunk({ content: 'ok' })) + sseData(chunk({}, 'stop')) + 'data: [DONE]\n\n');
      return;
    }
    if (body.tools) {
      const t = b.tools ?? 'works';
      if (t === 'refuse400')
        return json(res, 400, { error: { message: 'this model does not support tools' } });
      if (t === 'object_choice_refused' && typeof body.tool_choice === 'object')
        return json(res, 400, { error: { message: 'tool_choice object not supported' } });
      if (t === 'ignore')
        return json(res, 200, completion({ content: 'I would rather just talk.' }, 'stop'));
      const args =
        t === 'bad_args'
          ? '{"value": 5}'
          : t === 'malformed'
            ? '{"value": "x"'
            : '{"value":"probe"}';
      const name = t === 'wrong_tool' ? 'something_else' : 'probe_echo';
      return json(
        res,
        200,
        completion(
          {
            content: null,
            tool_calls: [{ id: 'p1', type: 'function', function: { name, arguments: args } }],
          },
          'tool_calls',
        ),
      );
    }
    if (body.response_format) {
      if (b.jsonMode === 'refuse400')
        return json(res, 400, { error: { message: 'response_format not supported' } });
      return json(
        res,
        200,
        completion({
          content: b.jsonMode === 'text' ? 'Sure, here you go: {"ok": true}' : '{"ok": true}',
        }),
      );
    }
    return json(res, 200, completion({ content: 'ok' }));
  });
  servers.push(s);
  return {
    server: s,
    provider: new OpenAICompatibleProvider({
      baseURL: `${s.url}/v1`,
      apiKey: KEY,
      model: 'probe-model',
      maxRetries: 0,
      clock: new ManualClock(),
      timeoutMs: 1500,
    }),
  };
}

describe('test connection (probe)', () => {
  it('a capable server: reachable, auth ok, model exists, streaming, tools, JSON mode, latency; stored as "probed"', async () => {
    const { provider } = await server();
    const report = await testConnection(provider, { now: () => new Date('2026-10-03T12:00:00Z') });
    expect(report).toMatchObject({
      provider: 'openai-compatible',
      model: 'probe-model',
      probedAt: '2026-10-03T12:00:00.000Z',
      reachable: true,
      authOk: true,
      modelExists: true,
      streaming: true,
      tools: true,
      jsonMode: true,
    });
    expect(report.latencyMs).toBeGreaterThanOrEqual(0);
    expect(report.evidence.map((e) => [e.check, e.status])).toEqual([
      ['models', 'pass'],
      ['chat', 'pass'],
      ['streaming', 'pass'],
      ['tool_calls', 'pass'],
      ['json_mode', 'pass'],
    ]);
    expect(provider.capabilities().tools).toEqual({
      value: true,
      source: 'probed',
      probedAt: '2026-10-03T12:00:00.000Z',
    });
    expect(provider.capabilities().streaming.source).toBe('probed');
    expect(provider.capabilities().parallelToolCalls.source).toBe('unknown'); // not probed, not claimed
    expect(JSON.stringify(report)).not.toContain(KEY);
    samples.capableServer = report;
  });

  it('a server that refuses tools: tools reported UNSUPPORTED, with the evidence, and agent features are disabled', async () => {
    const { provider } = await server({ tools: 'refuse400' });
    const report = await testConnection(provider);
    expect(report.tools).toBe(false);
    expect(report.streaming).toBe(true);
    expect(report.reachable).toBe(true);
    const ev = report.evidence.find((e) => e.check === 'tool_calls')!;
    expect(ev.status).toBe('fail');
    expect(ev.detail).toMatch(/refused a request with tools: bad_request \(HTTP 400\)/);
    expect(provider.capabilities().tools).toMatchObject({ value: false, source: 'probed' });
    samples.toolsRefused = report;

    // the agent refuses to start with tools, with a typed reason, and sends nothing
    const echo = defineTool({
      name: 'echo',
      description: 'x',
      parameters: z.object({}),
      execute: () => 'x',
    });
    const before = servers[servers.length - 1]!.requests.length;
    const run = await runAgent({ provider, prompt: 'x', tools: [echo] });
    expect(run.stopReason).toBe('capability_unsupported');
    expect(servers[servers.length - 1]!.requests.length).toBe(before);
  });

  it('a server that ignores the forced tool call (plain text instead) is reported as not supporting tools', async () => {
    const { provider } = await server({ tools: 'ignore' });
    const report = await probeProvider(provider);
    expect(report.tools).toBe(false);
    expect(report.evidence.find((e) => e.check === 'tool_calls')!.detail).toMatch(
      /no tool call although one was forced/,
    );
  });

  it.each([
    ['bad_args', /did not validate/],
    ['malformed', /not valid JSON/],
    ['wrong_tool', /different tool/],
  ] as const)(
    'tool arguments that do not validate (%s) mean tools are not supported',
    async (tools, re) => {
      const { provider } = await server({ tools });
      const report = await probeProvider(provider);
      expect(report.tools).toBe(false);
      expect(report.evidence.find((e) => e.check === 'tool_calls')!.detail).toMatch(re);
    },
  );

  it('a server that rejects the object form of tool_choice but accepts "required" still passes', async () => {
    const { provider } = await server({ tools: 'object_choice_refused' });
    expect((await probeProvider(provider)).tools).toBe(true);
  });

  it('streaming and JSON mode refusals are reported per feature', async () => {
    const { provider } = await server({ stream: 'refuse400', jsonMode: 'refuse400' });
    const report = await probeProvider(provider);
    expect(report).toMatchObject({ streaming: false, jsonMode: false, tools: true });
    const text = await probeProvider((await server({ jsonMode: 'text' })).provider);
    expect(text.jsonMode).toBe(false);
    expect(text.evidence.find((e) => e.check === 'json_mode')!.detail).toMatch(/not a JSON object/);
  });

  it('a model missing from the model list, and an endpoint without a model list', async () => {
    const missing = await probeProvider((await server({ models: ['other-model'] })).provider);
    expect(missing.modelExists).toBe(false);
    expect(missing.evidence[0]).toMatchObject({ check: 'models', status: 'fail' });
    const none = await probeProvider((await server({ models: 'none' })).provider);
    expect(none.modelExists).toBeNull();
    expect(none.reachable).toBe(true);
    expect(none.tools).toBe(true);
  });

  it('wrong credentials: reachable but auth failed; the other checks are skipped; no key in the report', async () => {
    const { provider } = await server({ auth: 'fail' });
    const report = await probeProvider(provider);
    expect(report).toMatchObject({
      reachable: true,
      authOk: false,
      streaming: null,
      tools: null,
      jsonMode: null,
    });
    expect(report.evidence.filter((e) => e.status === 'skipped').map((e) => e.check)).toEqual([
      'streaming',
      'tool_calls',
      'json_mode',
    ]);
    expect(JSON.stringify(report)).not.toContain(KEY);
    samples.authFailed = report;
  });

  it('an unreachable endpoint: not reachable, everything unknown', async () => {
    const closed = await startMock(() => undefined);
    const url = closed.url;
    await closed.close();
    const provider = new OpenAICompatibleProvider({
      baseURL: `${url}/v1`,
      apiKey: KEY,
      model: 'm',
      maxRetries: 0,
      timeoutMs: 800,
    });
    const report = await probeProvider(provider);
    expect(report).toMatchObject({
      reachable: false,
      authOk: null,
      tools: null,
      streaming: null,
      jsonMode: null,
    });
    expect(report.capabilities.tools).toEqual({ value: null, source: 'unknown' });
  });

  it('a stream that hangs is inconclusive (null), not "unsupported"', async () => {
    const { provider } = await server({ stream: 'hang' });
    const report = await probeProvider(provider, { timeoutMs: 300 });
    expect(report.streaming).toBeNull();
    expect(report.evidence.find((e) => e.check === 'streaming')!.status).toBe('inconclusive');
    expect(report.tools).toBe(true); // the rest of the probe still ran
  });
});
