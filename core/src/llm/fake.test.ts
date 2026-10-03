import { describe, expect, it } from 'vitest';
import { LLMError, isLLMError, toLLMError } from './errors.js';
import { FakeProvider } from './fake.js';
import { collectStream } from './stream.js';
import { ManualClock, type ChatRequest, type StreamEvent } from './types.js';
import { maskKey, redactDeep, redactText } from '../security/redact.js';

const req = (text = 'hi', extra: Partial<ChatRequest> = {}): ChatRequest => ({
  messages: [{ role: 'user', content: text }],
  ...extra,
});

async function events(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('FakeProvider', () => {
  it('answers with scripted text, usage flagged as from the provider', async () => {
    const p = new FakeProvider({ script: [{ type: 'text', content: 'hello there' }] });
    const r = await p.chat(req());
    expect(r).toMatchObject({
      content: 'hello there',
      finishReason: 'stop',
      provider: 'fake',
      toolCalls: [],
    });
    expect(r.usage.source).toBe('provider');
    expect(r.usage.totalTokens).toBe(r.usage.promptTokens + r.usage.completionTokens);
    expect(p.calls).toHaveLength(1);
  });

  it('scripts tool calls, including malformed arguments and unknown tool names', async () => {
    const p = new FakeProvider({
      script: [
        {
          type: 'tool_calls',
          calls: [
            { name: 'lookup', arguments: { id: 1 } },
            { name: 'lookup', arguments: '{"id": ' }, // malformed JSON, passed on flagged
            { name: 'does_not_exist', arguments: {} },
          ],
        },
      ],
    });
    const r = await p.chat(req());
    expect(r.finishReason).toBe('tool_calls');
    expect(r.toolCalls.map((c) => c.id)).toEqual(['call_1', 'call_2', 'call_3']);
    expect(r.toolCalls[0]).toMatchObject({
      name: 'lookup',
      arguments: { id: 1 },
      rawArguments: '{"id":1}',
    });
    expect(r.toolCalls[1]!.argumentsError).toMatch(/not valid JSON/);
    expect(r.toolCalls[1]!.arguments).toBeUndefined();
    expect(r.toolCalls[2]!.name).toBe('does_not_exist');
  });

  it('scripts typed errors: 429 with Retry-After, server error, auth', async () => {
    const p = new FakeProvider({
      script: [
        { type: 'error', error: { kind: 'rate_limited', retryAfterMs: 2000, status: 429 } },
        { type: 'error', error: { kind: 'server_error', status: 503 } },
        { type: 'error', error: { kind: 'auth_failed', status: 401 } },
      ],
    });
    const e1 = await p.chat(req()).catch((e: unknown) => e);
    expect(isLLMError(e1) && e1.kind).toBe('rate_limited');
    expect((e1 as LLMError).retryAfterMs).toBe(2000);
    expect((e1 as LLMError).retriable).toBe(true);
    const e2 = (await p.chat(req()).catch((e: unknown) => e)) as LLMError;
    expect(e2).toMatchObject({ kind: 'server_error', status: 503 });
    const e3 = (await p.chat(req()).catch((e: unknown) => e)) as LLMError;
    expect(e3.kind).toBe('auth_failed');
    expect(e3.retriable).toBe(false);
  });

  it('a hanging call ends with a timeout (injected clock, no real waiting) or on cancellation', async () => {
    const p = new FakeProvider({
      clock: new ManualClock(),
      script: [{ type: 'hang' }, { type: 'hang' }],
    });
    const t = (await p.chat(req('x', { timeoutMs: 5000 })).catch((e: unknown) => e)) as LLMError;
    expect(t.kind).toBe('timeout');
    const ac = new AbortController();
    const pending = p.chat(req('x', { signal: ac.signal })).catch((e: unknown) => e);
    ac.abort();
    expect(((await pending) as LLMError).kind).toBe('cancelled');
  });

  it('an already-cancelled request fails at once, in chat and in stream', async () => {
    const p = new FakeProvider({
      script: [
        { type: 'text', content: 'x' },
        { type: 'text', content: 'x' },
      ],
    });
    const ac = new AbortController();
    ac.abort();
    await expect(p.chat(req('x', { signal: ac.signal }))).rejects.toMatchObject({
      kind: 'cancelled',
    });
    const ev = await events(p.stream(req('x', { signal: ac.signal })));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: 'error', error: { kind: 'cancelled' } });
  });

  it('streams text in chunks, then usage and done; collectStream assembles the result', async () => {
    const p = new FakeProvider({
      script: [{ type: 'text', content: 'abcdefghijklmnop', chunkSize: 5 }],
    });
    const ev = await events(p.stream(req()));
    expect(ev.map((e) => e.type)).toEqual([
      'text_delta',
      'text_delta',
      'text_delta',
      'text_delta',
      'usage',
      'done',
    ]);
    const p2 = new FakeProvider({
      script: [{ type: 'text', content: 'abcdefghijklmnop', chunkSize: 5 }],
    });
    const r = await collectStream(p2.stream(req()));
    expect(r.content).toBe('abcdefghijklmnop');
  });

  it('streams tool calls as start, delta, delta, end', async () => {
    const p = new FakeProvider({
      script: [{ type: 'tool_calls', calls: [{ name: 'a', arguments: { x: 1 } }] }],
    });
    const ev = await events(p.stream(req()));
    expect(ev.map((e) => e.type)).toEqual([
      'tool_call_start',
      'tool_call_delta',
      'tool_call_delta',
      'tool_call_end',
      'usage',
      'done',
    ]);
    const deltas = ev
      .filter((e) => e.type === 'tool_call_delta')
      .map((e) => (e as { argumentsDelta: string }).argumentsDelta);
    expect(deltas.join('')).toBe('{"x":1}');
  });

  it('a mid-stream failure yields the text so far and then a typed error event, marked midStream', async () => {
    const p = new FakeProvider({
      script: [{ type: 'stream_fail', text: 'partial answer', error: { kind: 'network' } }],
    });
    const ev = await events(p.stream(req()));
    expect(ev.slice(0, -1).every((e) => e.type === 'text_delta')).toBe(true);
    const last = ev[ev.length - 1]!;
    expect(last.type).toBe('error');
    expect((last as { error: LLMError }).error).toMatchObject({ kind: 'network', midStream: true });
    await expect(
      collectStream(
        new FakeProvider({
          script: [{ type: 'stream_fail', text: 'x', error: { kind: 'network' } }],
        }).stream(req()),
      ),
    ).rejects.toBeInstanceOf(LLMError);
  });

  it('a slow stream takes (virtual) time per chunk and can be cancelled between chunks', async () => {
    const clock = new ManualClock();
    const p = new FakeProvider({
      clock,
      script: [{ type: 'text', content: 'aaaaaaaaaaaa', chunkSize: 4, chunkDelayMs: 1000 }],
    });
    const start = clock.now();
    await collectStream(p.stream(req()));
    expect(clock.now() - start).toBe(3000);

    const ac = new AbortController();
    const p2 = new FakeProvider({
      script: [{ type: 'text', content: 'aaaaaaaaaaaa', chunkSize: 4 }],
    });
    const out: StreamEvent[] = [];
    for await (const e of p2.stream(req('x', { signal: ac.signal }))) {
      out.push(e);
      if (out.length === 1) ac.abort();
    }
    expect(out[out.length - 1]).toMatchObject({ type: 'error', error: { kind: 'cancelled' } });
  });

  it('fails loudly when the script is exhausted, and records every request', async () => {
    const p = new FakeProvider({ script: [{ type: 'text', content: 'one' }] });
    await p.chat(req('first'));
    await expect(p.chat(req('second'))).rejects.toMatchObject({ kind: 'invalid_response' });
    expect(p.calls.map((c) => (c.messages[0] as { content: string }).content)).toEqual([
      'first',
      'second',
    ]);
  });

  it('capabilities are unknown unless declared', () => {
    expect(new FakeProvider().capabilities().tools).toEqual({ value: null, source: 'unknown' });
    const p = new FakeProvider({ capabilities: { tools: { value: true, source: 'declared' } } });
    expect(p.capabilities().tools.source).toBe('declared');
  });
});

describe('errors and redaction', () => {
  it('error messages never carry the key, a bearer token or URL credentials', () => {
    const key = 'sk-test-0123456789abcdefghij';
    const e = new LLMError({
      kind: 'bad_request',
      message: `HTTP 400 for Authorization: Bearer ${key} at https://user:hunter2@api.example.com with api_key=${key}`,
      secrets: [key],
    });
    expect(e.message).not.toContain(key);
    expect(e.message).not.toContain('hunter2');
    expect(JSON.stringify(e)).not.toContain(key);
    expect(toLLMError(new Error(`boom ${key}`), 'p', [key]).message).not.toContain(key);
  });

  it('wraps unknown errors as network and AbortError as cancelled', () => {
    expect(toLLMError(new Error('socket hang up')).kind).toBe('network');
    const abort = Object.assign(new Error('x'), { name: 'AbortError' });
    expect(toLLMError(abort).kind).toBe('cancelled');
  });

  it('redactDeep masks sensitive keys and key-shaped values; maskKey shows the last 4 only', () => {
    const out = redactDeep({
      headers: { Authorization: 'Bearer abcdefghijkl' },
      note: 'key gsk_abcdefghijklmnop here',
      n: 3,
    });
    expect(JSON.stringify(out)).not.toContain('abcdefghijkl');
    expect(out.n).toBe(3);
    expect(maskKey('sk-test-0123456789abcdef')).toBe('••••cdef');
    expect(maskKey('short')).toBe('••••');
    expect(redactText('plain text')).toBe('plain text');
  });
});
