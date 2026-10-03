/** Contract tests of the OpenAI-compatible adapter against a local mock HTTP server. */
import { afterEach, describe, expect, it } from 'vitest';
import { LLMError } from './errors.js';
import {
  OpenAICompatibleProvider,
  extractTextToolCalls,
  normalizeArguments,
  parseDurationMs,
  parseRetryAfter,
  type OpenAICompatibleConfig,
} from './openai.js';
import { parseSse } from './sse.js';
import { collectStream } from './stream.js';
import { ManualClock, type ChatRequest, type StreamEvent, type ToolDefinition } from './types.js';
import {
  chunk,
  completion,
  json,
  sseData,
  sseStart,
  startMock,
  tick,
  writeSplit,
  type MockHandler,
  type MockServer,
} from './testing/mock-server.js';

const KEY = 'sk-test-SECRETKEY0123456789';
const tool: ToolDefinition = {
  name: 'get_weather',
  description: 'weather',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};
const ask = (extra: Partial<ChatRequest> = {}): ChatRequest => ({
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
});

let servers: MockServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

async function setup(handler: MockHandler, cfg: Partial<OpenAICompatibleConfig> = {}) {
  const server = await startMock(handler);
  servers.push(server);
  const clock = new ManualClock();
  const provider = new OpenAICompatibleProvider({
    baseURL: `${server.url}/v1`,
    apiKey: KEY,
    model: 'mock-model',
    clock,
    random: () => 0.5,
    timeoutMs: 2000,
    ...cfg,
  });
  return { server, clock, provider };
}

async function events(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const lastError = (ev: StreamEvent[]): LLMError => {
  const l = ev[ev.length - 1]!;
  if (l.type !== 'error') throw new Error(`expected an error event, got ${l.type}`);
  return l.error;
};
const fail = async (p: Promise<unknown>): Promise<LLMError> =>
  (await p.then(
    () => undefined,
    (e: unknown) => e,
  )) as LLMError;

describe('chat: success and request shape', () => {
  it('sends the OpenAI chat format and parses the reply', async () => {
    const { provider, server } = await setup((_r, res) =>
      json(
        res,
        200,
        completion({ content: 'hello' }, 'stop', {
          prompt_tokens: 11,
          completion_tokens: 3,
          total_tokens: 14,
        }),
      ),
    );
    const r = await provider.chat(
      ask({
        tools: [tool],
        toolChoice: { name: 'get_weather' },
        temperature: 0.2,
        maxTokens: 50,
        jsonMode: true,
        messages: [
          { role: 'system', content: 's' },
          { role: 'user', content: 'u' },
          {
            role: 'assistant',
            content: null,
            toolCalls: [
              {
                id: 'c1',
                name: 'get_weather',
                arguments: { city: 'x' },
                rawArguments: '{"city":"x"}',
              },
            ],
          },
          { role: 'tool', toolCallId: 'c1', content: 'sunny' },
        ],
      }),
    );
    expect(r).toMatchObject({
      content: 'hello',
      finishReason: 'stop',
      provider: 'openai-compatible',
      model: 'mock-model',
    });
    expect(r.usage).toEqual({
      promptTokens: 11,
      completionTokens: 3,
      totalTokens: 14,
      source: 'provider',
    });
    expect(r.quirks).toBeUndefined();
    const rec = server.requests[0]!;
    expect(rec.method).toBe('POST');
    expect(rec.url).toBe('/v1/chat/completions');
    expect(rec.headers.authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(rec.body);
    expect(body).toMatchObject({
      model: 'mock-model',
      temperature: 0.2,
      max_tokens: 50,
      response_format: { type: 'json_object' },
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', description: 'weather', parameters: tool.parameters },
        },
      ],
    });
    expect(body.messages[2]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"x"}' },
        },
      ],
    });
    expect(body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'sunny' });
  });

  it('sends custom headers and no Authorization header without a key', async () => {
    const { provider, server } = await setup(
      (_r, res) => json(res, 200, completion({ content: 'x' })),
      { apiKey: '', headers: { 'x-title': 'ledgerworks' } },
    );
    await provider.chat(ask());
    expect(server.requests[0]!.headers['x-title']).toBe('ledgerworks');
    expect(server.requests[0]!.headers.authorization).toBeUndefined();
  });

  it('reads tool calls with provider ids and flags usage that was estimated', async () => {
    const { provider } = await setup((_r, res) =>
      json(
        res,
        200,
        completion(
          {
            content: null,
            tool_calls: [
              {
                id: 'abc',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"Pune"}' },
              },
            ],
          },
          'tool_calls',
        ),
      ),
    );
    const r = await provider.chat(ask({ tools: [tool] }));
    expect(r.toolCalls).toEqual([
      {
        id: 'abc',
        name: 'get_weather',
        arguments: { city: 'Pune' },
        rawArguments: '{"city":"Pune"}',
      },
    ]);
    expect(r.finishReason).toBe('tool_calls');
    expect(r.usage.source).toBe('estimated');
    expect(r.quirks).toContain('usage_estimated');
    expect(r.usage.totalTokens).toBeGreaterThan(0);
  });

  it('lists models from data[], models[] and plain arrays; maps a 404', async () => {
    let n = 0;
    const { provider } = await setup((_r, res) => {
      n++;
      if (n === 1) return json(res, 200, { data: [{ id: 'a' }, { id: 'b' }] });
      if (n === 2) return json(res, 200, { models: [{ name: 'c' }, 'd'] });
      if (n === 3) return json(res, 200, ['e']);
      return json(res, 404, { error: { message: 'not found' } });
    });
    expect(await provider.listModels()).toEqual(['a', 'b']);
    expect(await provider.listModels()).toEqual(['c', 'd']);
    expect(await provider.listModels()).toEqual(['e']);
    expect((await fail(provider.listModels())).kind).toBe('bad_request');
  });
});

describe('errors map into the taxonomy and never leak the key', () => {
  it.each([
    [401, { error: { message: 'bad key' } }, 'auth_failed'],
    [403, { error: { message: 'forbidden' } }, 'auth_failed'],
    [400, { error: { message: 'bad field' } }, 'bad_request'],
    [404, { error: { message: 'no such model' } }, 'bad_request'],
    [422, { error: { message: 'unprocessable' } }, 'bad_request'],
    [
      400,
      {
        error: {
          code: 'context_length_exceeded',
          message: "This model's maximum context length is 8192 tokens",
        },
      },
      'context_length',
    ],
    [413, 'too big', 'context_length'],
    [
      400,
      { error: { code: 'content_filter', message: 'blocked by the content management policy' } },
      'content_filtered',
    ],
  ])('HTTP %i maps to %s without retrying', async (status, body, kind) => {
    const { provider, server } = await setup((_r, res) => json(res, status, body));
    const e = await fail(provider.chat(ask()));
    expect(e).toBeInstanceOf(LLMError);
    expect(e.kind).toBe(kind);
    expect(e.status).toBe(status);
    expect(server.requests).toHaveLength(1);
  });

  it('an error body that echoes the key is scrubbed from the message and from JSON', async () => {
    const { provider } = await setup((_r, res) =>
      json(res, 401, {
        error: { message: `Incorrect API key provided: ${KEY}. See https://x.example` },
      }),
    );
    const e = await fail(provider.chat(ask()));
    expect(e.kind).toBe('auth_failed');
    expect(e.message).not.toContain(KEY);
    expect(JSON.stringify(e)).not.toContain('SECRETKEY');
    const ev = await events(
      (await setup((_r, res) => json(res, 401, `bad ${KEY}`))).provider.stream(ask()),
    );
    expect(lastError(ev).message).not.toContain(KEY);
  });

  it('a non-JSON error page (HTML) is still typed', async () => {
    const { provider } = await setup((_r, res) => json(res, 502, '<html>Bad gateway</html>'), {
      maxRetries: 0,
    });
    expect((await fail(provider.chat(ask()))).kind).toBe('server_error');
  });

  it('a non-JSON success body is invalid_response, not a crash', async () => {
    const { provider } = await setup((_r, res) => json(res, 200, 'not json at all'));
    expect((await fail(provider.chat(ask()))).kind).toBe('invalid_response');
  });

  it.each([
    [{}],
    [{ choices: [] }],
    [{ choices: [{ message: null }] }],
    [[1, 2]],
    [{ error: { message: 'boom' } }],
  ])('a response without choices[0].message (%j) is invalid_response', async (body) => {
    const { provider } = await setup((_r, res) => json(res, 200, body));
    expect((await fail(provider.chat(ask()))).kind).toBe('invalid_response');
  });
});

describe('retries', () => {
  it('429 with Retry-After in seconds: waits at least that long, then succeeds', async () => {
    const { provider, clock, server } = await setup((_r, res, n) =>
      n === 1
        ? json(res, 429, { error: { message: 'slow down' } }, { 'retry-after': '2' })
        : json(res, 200, completion({ content: 'ok' })),
    );
    const r = await provider.chat(ask());
    expect(r.content).toBe('ok');
    expect(server.requests).toHaveLength(2);
    expect(clock.sleeps).toEqual([2000]); // Retry-After wins over the 250 ms jittered backoff
  });

  it('429 with Retry-After as an HTTP date', async () => {
    const { provider, clock } = await setup((_r, res, n) => {
      if (n === 1)
        return json(res, 429, {}, { 'retry-after': new Date(Date.now() + 5000).toUTCString() });
      return json(res, 200, completion({ content: 'ok' }));
    }, {});
    // The adapter reads the date against ITS clock: make that clock agree with the wall clock here
    const wall = new ManualClock(Date.now());
    const p2 = new OpenAICompatibleProvider({
      baseURL: `${servers[0]!.url}/v1`,
      apiKey: KEY,
      model: 'm',
      clock: wall,
      random: () => 0,
    });
    await p2.chat(ask());
    expect(wall.sleeps).toHaveLength(1);
    expect(wall.sleeps[0]!).toBeGreaterThan(3500);
    expect(wall.sleeps[0]!).toBeLessThanOrEqual(5000);
    expect(clock.sleeps).toEqual([]);
    void provider;
  });

  it('500 then success; the delay is exponential with jitter (injected randomness)', async () => {
    const { provider, clock, server } = await setup((_r, res, n) =>
      n < 3
        ? json(res, 500, { error: { message: 'oops' } })
        : json(res, 200, completion({ content: 'ok' })),
    );
    expect((await provider.chat(ask())).content).toBe('ok');
    expect(server.requests).toHaveLength(3);
    expect(clock.sleeps).toEqual([250, 500]); // base 500 * 2^n * random 0.5
  });

  it('gives up after maxRetries with the typed error', async () => {
    const { provider, server } = await setup(
      (_r, res) => json(res, 503, { error: { message: 'down' } }),
      { maxRetries: 2 },
    );
    const e = await fail(provider.chat(ask()));
    expect(e).toMatchObject({ kind: 'server_error', status: 503 });
    expect(server.requests).toHaveLength(3);
  });

  it('respects the retry budget: a Retry-After longer than the budget is surfaced without sleeping', async () => {
    const { provider, clock, server } = await setup(
      (_r, res) => json(res, 429, {}, { 'retry-after': '120' }),
      { retryBudgetMs: 60_000 },
    );
    const e = await fail(provider.chat(ask()));
    expect(e).toMatchObject({ kind: 'rate_limited', retryAfterMs: 120_000 });
    expect(clock.sleeps).toEqual([]);
    expect(server.requests).toHaveLength(1);
  });

  it('does not retry an exhausted quota (insufficient_quota)', async () => {
    const { provider, server } = await setup((_r, res) =>
      json(res, 429, {
        error: { code: 'insufficient_quota', message: 'You exceeded your current quota' },
      }),
    );
    expect((await fail(provider.chat(ask()))).kind).toBe('rate_limited');
    expect(server.requests).toHaveLength(1);
  });

  it('retries a dropped connection (network error)', async () => {
    const { provider, server, clock } = await setup((_r, res, n) =>
      n === 1 ? res.destroy() : json(res, 200, completion({ content: 'ok' })),
    );
    expect((await provider.chat(ask())).content).toBe('ok');
    expect(server.requests).toHaveLength(2);
    expect(clock.sleeps).toHaveLength(1);
  });

  it('a request that times out is a typed timeout and is not retried', async () => {
    const { provider, server } = await setup(() => undefined, { timeoutMs: 150 });
    const t0 = Date.now();
    const e = await fail(provider.chat(ask()));
    expect(e.kind).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(server.requests).toHaveLength(1);
  });

  it('cancellation: before the call, while it hangs, and during a backoff sleep', async () => {
    const { provider } = await setup(() => undefined);
    const pre = new AbortController();
    pre.abort();
    expect((await fail(provider.chat(ask({ signal: pre.signal })))).kind).toBe('cancelled');
    const ac = new AbortController();
    const pending = fail(provider.chat(ask({ signal: ac.signal })));
    setTimeout(() => ac.abort(), 50);
    expect((await pending).kind).toBe('cancelled');
    const ev = await events(provider.stream(ask({ signal: pre.signal })));
    expect(lastError(ev).kind).toBe('cancelled');
  });

  it('a URL-policy refusal (SafeFetchError) is bad_request and not retried', async () => {
    let calls = 0;
    const provider = new OpenAICompatibleProvider({
      baseURL: 'https://example.invalid/v1',
      apiKey: KEY,
      model: 'm',
      fetch: async () => {
        calls++;
        throw Object.assign(new Error(`blocked ${KEY}`), { name: 'SafeFetchError' });
      },
    });
    const e = await fail(provider.chat(ask()));
    expect(e.kind).toBe('bad_request');
    expect(e.message).not.toContain(KEY);
    expect(calls).toBe(1);
  });
});

describe('streaming', () => {
  it('assembles text split across arbitrary chunk boundaries, with comments, keep-alives, usage and [DONE]', async () => {
    const body =
      ': keep-alive\n\n' +
      sseData(chunk({ role: 'assistant', content: 'Hel' })) +
      ': ping\n\n' +
      sseData(chunk({ content: 'lo ' })) +
      sseData(chunk({ content: 'wörld' })) +
      sseData(chunk({}, 'stop')) +
      sseData({
        id: 'c1',
        model: 'mock-model',
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }) +
      'data: [DONE]\n\n';
    const { provider } = await setup(async (_r, res) => {
      sseStart(res);
      await writeSplit(res, body, 7);
      res.end();
    });
    const ev = await events(provider.stream(ask()));
    expect(
      ev
        .filter((e) => e.type === 'text_delta')
        .map((e) => (e as { text: string }).text)
        .join(''),
    ).toBe('Hello wörld');
    const done = ev[ev.length - 1]!;
    expect(done.type).toBe('done');
    const r = (done as { result: import('./types.js').ChatResult }).result;
    expect(r).toMatchObject({ content: 'Hello wörld', finishReason: 'stop', model: 'mock-model' });
    expect(r.usage).toEqual({
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
      source: 'provider',
    });
    expect(ev.some((e) => e.type === 'usage')).toBe(true);
    const sent = JSON.parse(servers[0]!.requests[0]!.body);
    expect(sent.stream).toBe(true);
    expect(sent.stream_options).toEqual({ include_usage: true });
  });

  it('assembles partial tool-call arguments and several tool calls in one response', async () => {
    const parts = [
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_a',
            type: 'function',
            function: { name: 'get_weather', arguments: '' },
          },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] }),
      chunk({
        tool_calls: [
          {
            index: 1,
            id: 'call_b',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":' },
          },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'ty":"Pune"}' } }] }),
      chunk({ tool_calls: [{ index: 1, function: { arguments: '"Delhi"}' } }] }),
      chunk({}, 'tool_calls'),
    ];
    const { provider } = await setup(async (_r, res) => {
      sseStart(res);
      await writeSplit(res, parts.map(sseData).join('') + 'data: [DONE]\n\n', 11);
      res.end();
    });
    const ev = await events(provider.stream(ask({ tools: [tool] })));
    expect(ev.map((e) => e.type).filter((t) => t.startsWith('tool_call'))).toEqual([
      'tool_call_start',
      'tool_call_delta',
      'tool_call_start',
      'tool_call_delta',
      'tool_call_delta',
      'tool_call_delta',
      'tool_call_end',
      'tool_call_end',
    ]);
    const r = (ev[ev.length - 1] as { result: import('./types.js').ChatResult }).result;
    expect(r.toolCalls.map((c) => [c.id, c.arguments])).toEqual([
      ['call_a', { city: 'Pune' }],
      ['call_b', { city: 'Delhi' }],
    ]);
    expect(r.finishReason).toBe('tool_calls');
    expect(r.usage.source).toBe('estimated'); // no usage chunk: flagged, not invented
    expect(r.quirks).toContain('usage_estimated');
  });

  it('a stream that ends without [DONE] but with a finish reason is accepted and flagged', async () => {
    const { provider } = await setup((_r, res) => {
      sseStart(res);
      res.end(sseData(chunk({ content: 'hi' })) + sseData(chunk({}, 'stop')));
    });
    const r = await collectStream(provider.stream(ask()));
    expect(r.content).toBe('hi');
    expect(r.quirks).toContain('stream_ended_without_done');
  });

  it('a stream that ends without finishing is a typed mid-stream error; an empty one is invalid_response', async () => {
    const { provider } = await setup((_r, res, n) => {
      sseStart(res);
      res.end(n === 1 ? sseData(chunk({ content: 'partial' })) : '');
    });
    const e1 = lastError(await events(provider.stream(ask())));
    expect(e1).toMatchObject({ kind: 'network', midStream: true });
    const e2 = lastError(await events(provider.stream(ask())));
    expect(e2.kind).toBe('invalid_response');
  });

  it('a malformed JSON chunk is a typed invalid_response event, not a crash', async () => {
    const { provider } = await setup((_r, res) => {
      sseStart(res);
      res.end(sseData(chunk({ content: 'ok so far' })) + 'data: {"choices": [ {oops\n\n');
    });
    const ev = await events(provider.stream(ask()));
    expect(ev[0]).toMatchObject({ type: 'text_delta' });
    expect(lastError(ev)).toMatchObject({ kind: 'invalid_response', midStream: true });
  });

  it('a mid-stream disconnect is a typed error and the request is NOT retried', async () => {
    const { provider, server } = await setup(async (_r, res) => {
      sseStart(res);
      res.write(sseData(chunk({ content: 'abc' })));
      await tick();
      await new Promise((r) => setTimeout(r, 20));
      res.destroy();
    });
    const ev = await events(provider.stream(ask()));
    expect(ev.some((e) => e.type === 'text_delta')).toBe(true);
    expect(lastError(ev)).toMatchObject({ kind: 'network', midStream: true });
    expect(server.requests).toHaveLength(1);
  });

  it('an error object inside the stream is typed', async () => {
    const { provider } = await setup((_r, res) => {
      sseStart(res);
      res.end(sseData({ error: { message: 'rate limit reached', code: 'rate_limit_exceeded' } }));
    });
    expect(lastError(await events(provider.stream(ask()))).kind).toBe('rate_limited');
  });

  it('retries before the first byte (429 then a stream), but never after content', async () => {
    const { provider, clock, server } = await setup((_r, res, n) => {
      if (n === 1) return json(res, 429, {}, { 'retry-after': '1' });
      sseStart(res);
      res.end(sseData(chunk({ content: 'ok' })) + sseData(chunk({}, 'stop')) + 'data: [DONE]\n\n');
    });
    const r = await collectStream(provider.stream(ask()));
    expect(r.content).toBe('ok');
    expect(server.requests).toHaveLength(2);
    expect(clock.sleeps).toEqual([1000]);
  });

  it('a stream that goes quiet hits the idle timeout', async () => {
    const { provider } = await setup(
      (_r, res) => {
        sseStart(res);
        res.write(sseData(chunk({ content: 'a' })));
      },
      { streamIdleTimeoutMs: 120 },
    );
    const ev = await events(provider.stream(ask()));
    expect(lastError(ev)).toMatchObject({ kind: 'timeout', midStream: true });
  });

  it('enforces the maximum number of events and bytes', async () => {
    const many = Array.from({ length: 50 }, () => sseData(chunk({ content: 'x' }))).join('');
    const { provider } = await setup(
      (_r, res) => {
        sseStart(res);
        res.end(many);
      },
      { limits: { maxStreamEvents: 10 } },
    );
    expect(lastError(await events(provider.stream(ask()))).kind).toBe('invalid_response');
    const { provider: p2 } = await setup(
      (_r, res) => {
        sseStart(res);
        res.end(many);
      },
      { limits: { maxResponseBytes: 200 } },
    );
    expect(lastError(await events(p2.stream(ask()))).message).toMatch(/limit/);
  });

  it('streaming quirks: tool calls without index, arguments sent as an object, ids generated', async () => {
    const parts = [
      chunk({
        tool_calls: [{ id: 'x1', function: { name: 'get_weather', arguments: '{"city"' } }],
      }),
      chunk({ tool_calls: [{ function: { arguments: ':"A"}' } }] }),
      chunk({ tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'B' } } }] }),
    ];
    const { provider } = await setup((_r, res) => {
      sseStart(res);
      res.end(parts.map(sseData).join('') + sseData(chunk({}, 'stop')) + 'data: [DONE]\n\n');
    });
    const r = await collectStream(provider.stream(ask({ tools: [tool] })));
    expect(r.toolCalls.map((c) => c.arguments)).toEqual([{ city: 'A' }, { city: 'B' }]);
    expect(r.quirks).toEqual(
      expect.arrayContaining(['tool_call_index_missing', 'arguments_as_object']),
    );
    expect(r.finishReason).toBe('tool_calls'); // 'stop' with tool calls is corrected, and flagged
    expect(r.quirks).toContain('finish_reason_corrected_to_tool_calls');
  });
});

describe('provider quirks (non-streaming)', () => {
  const call = (fn: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    id: 'c1',
    type: 'function',
    function: fn,
    ...extra,
  });
  const run = async (message: Record<string, unknown>, finish = 'tool_calls') => {
    const { provider } = await setup((_r, res) =>
      json(
        res,
        200,
        completion(message, finish, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
      ),
    );
    return provider.chat(ask({ tools: [tool] }));
  };

  it('arguments as a JSON string (standard), as an object, empty, null and double-encoded', async () => {
    const std = await run({
      tool_calls: [call({ name: 'get_weather', arguments: '{"city":"A"}' })],
    });
    expect(std.toolCalls[0]).toMatchObject({ arguments: { city: 'A' } });
    expect(std.quirks).toBeUndefined();
    const obj = await run({
      tool_calls: [call({ name: 'get_weather', arguments: { city: 'B' } })],
    });
    expect(obj.toolCalls[0]).toMatchObject({
      arguments: { city: 'B' },
      rawArguments: '{"city":"B"}',
    });
    expect(obj.quirks).toContain('arguments_as_object');
    const empty = await run({ tool_calls: [call({ name: 'get_weather', arguments: '' })] });
    expect(empty.toolCalls[0]).toMatchObject({ arguments: {}, rawArguments: '{}' });
    expect(empty.quirks).toContain('empty_arguments');
    const nul = await run({ tool_calls: [call({ name: 'get_weather', arguments: null })] });
    expect(nul.toolCalls[0]!.arguments).toEqual({});
    const dbl = await run({
      tool_calls: [call({ name: 'get_weather', arguments: JSON.stringify('{"city":"C"}') })],
    });
    expect(dbl.toolCalls[0]).toMatchObject({ arguments: { city: 'C' } });
    expect(dbl.quirks).toContain('double_encoded_arguments');
  });

  it('malformed or non-object arguments are passed on FLAGGED, never repaired', async () => {
    const bad = await run({
      tool_calls: [call({ name: 'get_weather', arguments: '{"city": "A"' })],
    });
    expect(bad.toolCalls[0]!.argumentsError).toMatch(/not valid JSON/);
    expect(bad.toolCalls[0]!.arguments).toBeUndefined();
    expect(bad.toolCalls[0]!.rawArguments).toBe('{"city": "A"');
    const arr = await run({ tool_calls: [call({ name: 'get_weather', arguments: '[1,2]' })] });
    expect(arr.toolCalls[0]!.argumentsError).toMatch(/JSON object/);
    const num = await run({ tool_calls: [call({ name: 'get_weather', arguments: 5 })] });
    expect(num.toolCalls[0]!.argumentsError).toBeDefined();
  });

  it('a missing tool-call id is generated and flagged; duplicate ids are invalid_response', async () => {
    const r = await run({
      tool_calls: [
        { type: 'function', function: { name: 'get_weather', arguments: '{}' } },
        { type: 'function', function: { name: 'get_weather', arguments: '{}' } },
      ],
    });
    expect(r.toolCalls.map((c) => c.id)).toEqual(['call_1', 'call_2']);
    expect(r.quirks).toContain('tool_call_id_generated');
    const { provider } = await setup((_r, res) =>
      json(
        res,
        200,
        completion(
          {
            tool_calls: [
              call({ name: 'get_weather', arguments: '{}' }),
              call({ name: 'get_weather', arguments: '{}' }),
            ],
          },
          'tool_calls',
        ),
      ),
    );
    expect((await fail(provider.chat(ask({ tools: [tool] })))).kind).toBe('invalid_response');
  });

  it('flat tool calls (name and arguments on the call), the legacy function_call, content as parts', async () => {
    const flat = await run({
      tool_calls: [{ id: 'f1', name: 'get_weather', arguments: '{"city":"D"}' }],
    });
    expect(flat.toolCalls[0]).toMatchObject({ id: 'f1', arguments: { city: 'D' } });
    expect(flat.quirks).toContain('flat_tool_call');
    const legacy = await run(
      { content: null, function_call: { name: 'get_weather', arguments: '{"city":"E"}' } },
      'function_call',
    );
    expect(legacy.toolCalls[0]).toMatchObject({ name: 'get_weather', arguments: { city: 'E' } });
    expect(legacy.quirks).toContain('legacy_function_call');
    expect(legacy.finishReason).toBe('tool_calls');
    const parts = await run(
      {
        content: [
          { type: 'text', text: 'ab' },
          { type: 'text', text: 'cd' },
        ],
      },
      'stop',
    );
    expect(parts.content).toBe('abcd');
    expect(parts.quirks).toContain('content_as_parts');
  });

  it('finish_reason "stop" together with tool calls is corrected to tool_calls and flagged', async () => {
    const r = await run({ tool_calls: [call({ name: 'get_weather', arguments: '{}' })] }, 'stop');
    expect(r.finishReason).toBe('tool_calls');
    expect(r.quirks).toContain('finish_reason_corrected_to_tool_calls');
  });

  it('tool calls returned as plain text: recognised only for an offered tool and flagged', async () => {
    const tagged = await run(
      { content: '<tool_call>{"name":"get_weather","arguments":{"city":"F"}}</tool_call>' },
      'stop',
    );
    expect(tagged.toolCalls[0]).toMatchObject({ name: 'get_weather', arguments: { city: 'F' } });
    expect(tagged.content).toBeNull();
    expect(tagged.quirks).toContain('text_tool_call');
    const plain = await run(
      { content: '{"name":"get_weather","parameters":{"city":"G"}}' },
      'stop',
    );
    expect(plain.toolCalls[0]!.arguments).toEqual({ city: 'G' });
    const fenced = await run(
      { content: '```json\n{"name":"get_weather","arguments":{"city":"H"}}\n```' },
      'stop',
    );
    expect(fenced.toolCalls).toHaveLength(1);
    // a tool that was not offered stays text; prose around JSON stays text
    const other = await run({ content: '{"name":"delete_everything","arguments":{}}' }, 'stop');
    expect(other.toolCalls).toEqual([]);
    expect(other.content).toContain('delete_everything');
    const prose = await run(
      { content: 'Sure! {"name":"get_weather","arguments":{"city":"I"}}' },
      'stop',
    );
    expect(prose.toolCalls).toEqual([]);
    expect(
      extractTextToolCalls('{"name":"get_weather","arguments":[1]}', new Set(['get_weather'])),
    ).toBeNull();
  });

  it('what cannot be normalised is invalid_response: no name, finish_reason tool_calls without calls', async () => {
    const { provider } = await setup((_r, res, n) =>
      n === 1
        ? json(res, 200, completion({ tool_calls: [call({ arguments: '{}' })] }, 'tool_calls'))
        : json(res, 200, completion({ content: 'x' }, 'tool_calls')),
    );
    expect((await fail(provider.chat(ask({ tools: [tool] })))).kind).toBe('invalid_response');
    expect((await fail(provider.chat(ask({ tools: [tool] })))).kind).toBe('invalid_response');
  });

  it('normalizeArguments and header parsing helpers', () => {
    const q = new Set<string>();
    expect(normalizeArguments('{"a":1}', q)).toEqual({
      arguments: { a: 1 },
      rawArguments: '{"a":1}',
    });
    expect(parseRetryAfter('3', 0)).toBe(3000);
    expect(parseRetryAfter('1.5', 0)).toBe(1500);
    expect(
      parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:27:50 GMT')),
    ).toBe(10_000);
    expect(parseRetryAfter('garbage', 0)).toBeUndefined();
    expect(parseDurationMs('6m0s')).toBe(360_000);
    expect(parseDurationMs('20ms')).toBe(20);
    expect(parseDurationMs('1h2m3.5s')).toBe(3_723_500);
    expect(parseDurationMs('abc')).toBeUndefined();
  });

  it('reads rate-limit headers into the result', async () => {
    const { provider } = await setup((_r, res) =>
      json(res, 200, completion({ content: 'x' }), {
        'x-ratelimit-remaining-requests': '7',
        'x-ratelimit-remaining-tokens': '900',
        'x-ratelimit-reset-requests': '1m30s',
        'x-ratelimit-reset-tokens': '250ms',
      }),
    );
    const r = await provider.chat(ask());
    expect(r.rateLimit).toEqual({
      remainingRequests: 7,
      remainingTokens: 900,
      resetRequestsMs: 90_000,
      resetTokensMs: 250,
    });
  });

  it('refuses a response larger than the limit', async () => {
    const { provider } = await setup(
      (_r, res) => json(res, 200, completion({ content: 'x'.repeat(5000) })),
      { limits: { maxResponseBytes: 1000 } },
    );
    expect((await fail(provider.chat(ask()))).kind).toBe('invalid_response');
  });
});

describe('SSE parser', () => {
  const stream = (parts: (string | Uint8Array)[]): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(c) {
        for (const p of parts) c.enqueue(typeof p === 'string' ? new TextEncoder().encode(p) : p);
        c.close();
      },
    });
  const collect = async (s: ReadableStream<Uint8Array>) => {
    const out: string[] = [];
    for await (const m of parseSse(s, { maxBytes: 1e6, maxEvents: 1e6 })) out.push(m.data);
    return out;
  };
  it('handles CRLF, lone CR, multi-line data, comments, BOM and a final event without a blank line', async () => {
    expect(
      await collect(
        stream([
          '﻿data: a\r\n\r\n',
          ': c\r\n\r\ndata: b1\r\ndata: b2\r\n\r\n',
          'data: c\r\r',
          'data: last',
        ]),
      ),
    ).toEqual(['a', 'b1\nb2', 'c', 'last']);
  });
  it('handles a CRLF split between chunks and a multi-byte character split between chunks', async () => {
    const euro = new TextEncoder().encode('data: €\n\n');
    expect(
      await collect(stream(['data: x\r', '\n\r', '\n', euro.slice(0, 7), euro.slice(7)])),
    ).toEqual(['x', '€']);
  });
  it('enforces limits', async () => {
    await expect(
      collect(stream(['data: a\n\ndata: b\n\ndata: c\n\n']).tee()[0]),
    ).resolves.toHaveLength(3);
    const lim = async () => {
      for await (const m of parseSse(stream(['data: a\n\ndata: b\n\n']), {
        maxBytes: 1e6,
        maxEvents: 1,
      }))
        void m;
    };
    await expect(lim()).rejects.toThrow(/events/);
  });
});
