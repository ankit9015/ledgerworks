import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, runAgent } from '../agent/index.js';
import { CircuitBreaker, FallbackProvider, QuotaTracker } from './chain.js';
import { LLMError } from './errors.js';
import { FakeProvider, type FakeScript, type FakeStep } from './fake.js';
import { ManualClock, type ChatRequest, type StreamEvent } from './types.js';

const req = (extra: Partial<ChatRequest> = {}): ChatRequest => ({
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
});
const ok = (t = 'ok'): FakeStep => ({ type: 'text', content: t });
const err = (
  kind:
    | 'rate_limited'
    | 'server_error'
    | 'timeout'
    | 'network'
    | 'auth_failed'
    | 'bad_request'
    | 'content_filtered'
    | 'context_length',
  extra: { retryAfterMs?: number; status?: number } = {},
): FakeStep => ({ type: 'error', error: { kind, ...extra } });
const fake = (id: string, script: FakeScript = []): FakeProvider =>
  new FakeProvider({ id, script });
const fail = async (p: Promise<unknown>): Promise<LLMError> =>
  (await p.then(
    () => undefined,
    (e: unknown) => e,
  )) as LLMError;
async function events(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('CircuitBreaker', () => {
  it('opens after N consecutive failures, half-opens after the cooldown with ONE trial, closes on success, reopens on failure', () => {
    const clock = new ManualClock();
    const b = new CircuitBreaker(clock, { failureThreshold: 3, cooldownMs: 10_000 });
    expect(b.current()).toBe('closed');
    b.onFailure();
    b.onFailure();
    b.onSuccess(); // a success resets the count
    b.onFailure();
    b.onFailure();
    expect(b.current()).toBe('closed');
    b.onFailure();
    expect(b.current()).toBe('open');
    expect(b.tryAcquire()).toBe(false);
    clock.advance(9_999);
    expect(b.tryAcquire()).toBe(false);
    clock.advance(1);
    expect(b.current()).toBe('half_open');
    expect(b.tryAcquire()).toBe(true); // the trial
    expect(b.tryAcquire()).toBe(false); // only one at a time
    b.onFailure(); // the trial failed: open again, the cooldown starts over
    expect(b.current()).toBe('open');
    expect(b.msUntilHalfOpen()).toBe(10_000);
    clock.advance(10_000);
    expect(b.tryAcquire()).toBe(true);
    b.onSuccess();
    expect(b.current()).toBe('closed');
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(true);
  });
});

describe('QuotaTracker', () => {
  it('counts requests and tokens per minute and per day in sliding windows', () => {
    const clock = new ManualClock();
    const q = new QuotaTracker(clock, {
      requestsPerMinute: 2,
      tokensPerMinute: 100,
      requestsPerDay: 3,
    });
    expect(q.check()).toBeNull();
    q.record(10);
    q.record(10);
    expect(q.check()?.reason).toMatch(/2\/2 requests per minute/);
    clock.advance(60_001);
    expect(q.check()).toBeNull();
    q.record(500); // 3rd request today, and a lot of tokens
    expect(q.check()?.reason).toMatch(/tokens per minute|requests per day/);
    clock.advance(60_001);
    expect(q.check()?.reason).toMatch(/3\/3 requests per day/);
    clock.advance(86_400_000);
    expect(q.check()).toBeNull();
  });

  it('is updated from rate-limit headers and Retry-After', () => {
    const clock = new ManualClock();
    const q = new QuotaTracker(clock, {});
    q.observe({ remainingRequests: 5, resetRequestsMs: 1000 });
    expect(q.check()).toBeNull();
    q.observe({ remainingRequests: 0, resetRequestsMs: 20_000 });
    expect(q.check()).toMatchObject({ retryAfterMs: 20_000 });
    clock.advance(20_000);
    expect(q.check()).toBeNull();
    q.blockFor(5000, 'retry-after');
    expect(q.check()?.retryAfterMs).toBe(5000);
  });
});

describe('FallbackProvider', () => {
  it('A fails with 429, B is used, and the routing says why A was skipped', async () => {
    const a = fake('A', [err('rate_limited', { status: 429 })]);
    const b = fake('B', [ok('from B')]);
    const chain = new FallbackProvider({
      members: [{ provider: a }, { provider: b }],
      clock: new ManualClock(),
    });
    const r = await chain.chat(req());
    expect(r.content).toBe('from B');
    expect(r.provider).toBe('B');
    expect(r.routing).toEqual({
      provider: 'B',
      skipped: [{ provider: 'A', reason: 'rate_limited (HTTP 429)' }],
    });
    expect(a.calls).toHaveLength(1);
  });

  it('falls over on rate_limited, server_error, timeout and network, in order', async () => {
    const a = fake('A', [err('server_error', { status: 503 }), err('timeout'), err('network')]);
    const b = fake('B', [err('rate_limited'), err('network'), err('timeout')]);
    const c = fake('C', [ok('c1'), ok('c2'), ok('c3')]);
    const chain = new FallbackProvider({
      members: [{ provider: a }, { provider: b }, { provider: c }],
      clock: new ManualClock(),
      breaker: { failureThreshold: 99 },
    });
    for (const n of [1, 2, 3]) {
      const r = await chain.chat(req());
      expect(r.content).toBe(`c${n}`);
      expect(r.routing!.skipped.map((s) => s.provider)).toEqual(['A', 'B']);
    }
  });

  it('does NOT fall over on auth_failed, bad_request, content_filtered or context_length: they are surfaced', async () => {
    for (const kind of [
      'auth_failed',
      'bad_request',
      'content_filtered',
      'context_length',
    ] as const) {
      const a = fake('A', [err(kind)]);
      const b = fake('B', [ok('should not be used')]);
      const chain = new FallbackProvider({
        members: [{ provider: a }, { provider: b }],
        clock: new ManualClock(),
      });
      const e = await fail(chain.chat(req()));
      expect(e.kind).toBe(kind);
      expect(b.calls).toHaveLength(0);
      expect(chain.health()[0]!.consecutiveFailures).toBe(0); // the provider answered: not counted against its circuit
    }
  });

  it('does not fall over on cancellation', async () => {
    const a = fake('A', [{ type: 'hang' }]);
    const b = fake('B', [ok()]);
    const chain = new FallbackProvider({
      members: [{ provider: a }, { provider: b }],
      clock: new ManualClock(),
    });
    const ac = new AbortController();
    const pending = fail(chain.chat(req({ signal: ac.signal })));
    ac.abort();
    expect((await pending).kind).toBe('cancelled');
    expect(b.calls).toHaveLength(0);
  });

  it("A's circuit opens, A is skipped without a request, then half-opens and recovers", async () => {
    const clock = new ManualClock();
    const a = fake('A', [err('server_error'), err('server_error'), ok('A is back')]);
    const b = fake('B', [ok('b1'), ok('b2'), ok('b3'), ok('b4')]);
    const chain = new FallbackProvider({
      members: [{ provider: a }, { provider: b }],
      clock,
      breaker: { failureThreshold: 2, cooldownMs: 30_000 },
    });
    expect((await chain.chat(req())).provider).toBe('B');
    expect((await chain.chat(req())).provider).toBe('B');
    expect(chain.health()[0]!.circuit).toBe('open');
    const skipped = await chain.chat(req());
    expect(skipped.provider).toBe('B');
    expect(a.calls).toHaveLength(2); // no request to A while its circuit is open
    expect(skipped.routing!.skipped[0]).toMatchObject({ provider: 'A' });
    expect(skipped.routing!.skipped[0]!.reason).toMatch(/^circuit open/);
    clock.advance(30_000);
    expect(chain.health()[0]!.circuit).toBe('half_open');
    const trial = await chain.chat(req());
    expect(trial.provider).toBe('A'); // the single trial request succeeded
    expect(chain.health()[0]!.circuit).toBe('closed');
  });

  it('a failed half-open trial reopens the circuit and falls over to B in the same call', async () => {
    const clock = new ManualClock();
    const a = fake('A', [err('network'), err('network'), err('network')]);
    const b = fake('B', [ok(), ok(), ok()]);
    const chain = new FallbackProvider({
      members: [{ provider: a }, { provider: b }],
      clock,
      breaker: { failureThreshold: 2, cooldownMs: 1000 },
    });
    await chain.chat(req());
    await chain.chat(req());
    clock.advance(1000);
    const r = await chain.chat(req());
    expect(r.provider).toBe('B');
    expect(a.calls).toHaveLength(3);
    expect(chain.health()[0]!.circuit).toBe('open');
  });

  it('when all providers are down, one typed error lists each reason', async () => {
    const a = fake('A', [err('rate_limited', { retryAfterMs: 8000, status: 429 })]);
    const b = fake('B', [err('server_error', { status: 500 })]);
    const c = fake('C', [err('timeout')]);
    const chain = new FallbackProvider({
      members: [{ provider: a }, { provider: b }, { provider: c }],
      clock: new ManualClock(),
    });
    const e = await fail(chain.chat(req()));
    expect(e).toBeInstanceOf(LLMError);
    expect(e.kind).toBe('timeout'); // the kind of the last real failure
    expect(e.causes!.map((x) => [x.provider, x.kind])).toEqual([
      ['A', 'rate_limited'],
      ['B', 'server_error'],
      ['C', 'timeout'],
    ]);
    expect(e.message).toMatch(/A: .*; B: .*; C: /);
    expect(e.retryAfterMs).toBe(8000);
  });

  it('a provider whose quota is exhausted is skipped WITHOUT a request', async () => {
    const clock = new ManualClock();
    const a = fake('A', [ok('a1'), ok('a2'), ok('a3')]);
    const b = fake('B', [ok('b1'), ok('b2')]);
    const chain = new FallbackProvider({
      members: [{ provider: a, quota: { requestsPerMinute: 2 } }, { provider: b }],
      clock,
    });
    expect((await chain.chat(req())).provider).toBe('A');
    expect((await chain.chat(req())).provider).toBe('A');
    const third = await chain.chat(req());
    expect(third.provider).toBe('B');
    expect(a.calls).toHaveLength(2);
    expect(third.routing!.skipped[0]!.reason).toMatch(
      /quota exhausted \(2\/2 requests per minute\)/,
    );
    clock.advance(60_001);
    expect((await chain.chat(req())).provider).toBe('A');
  });

  it('token quota: usage reported by the provider counts', async () => {
    const a = fake('A', [
      {
        type: 'text',
        content: 'x',
        usage: { promptTokens: 90, completionTokens: 20, totalTokens: 110 },
      },
      ok(),
    ]);
    const b = fake('B', [ok('b')]);
    const chain = new FallbackProvider({
      members: [{ provider: a, quota: { tokensPerMinute: 100 } }, { provider: b }],
      clock: new ManualClock(),
    });
    await chain.chat(req());
    expect((await chain.chat(req())).provider).toBe('B');
    expect(chain.health()[0]!.usage.tokensLastMinute).toBe(110);
  });

  it('rate-limit headers and Retry-After update the quota: the provider is skipped until the reset', async () => {
    const clock = new ManualClock();
    const a = new FakeProvider({
      id: 'A',
      script: [(): FakeStep => ({ type: 'text', content: 'a' }), ok('a-again')],
    });
    const wrapped = Object.create(a) as FakeProvider;
    wrapped.chat = async (r: ChatRequest) => ({
      ...(await a.chat(r)),
      rateLimit: { remainingRequests: 0, resetRequestsMs: 15_000 },
    });
    const b = fake('B', [ok('b'), ok('b2')]);
    const chain = new FallbackProvider({
      members: [{ provider: wrapped }, { provider: b }],
      clock,
    });
    expect((await chain.chat(req())).provider).toBe('A'); // the response said: 0 requests remaining
    const next = await chain.chat(req());
    expect(next.provider).toBe('B');
    expect(next.routing!.skipped[0]!.reason).toMatch(/reports 0 requests remaining/);
    clock.advance(15_000);
    expect((await chain.chat(req())).provider).toBe('A');

    // Retry-After on a 429 blocks the provider without any further request
    const c = fake('C', [err('rate_limited', { retryAfterMs: 40_000 }), ok('c2')]);
    const d = fake('D', [ok('d1'), ok('d2')]);
    const chain2 = new FallbackProvider({
      members: [{ provider: c }, { provider: d }],
      clock,
      breaker: { failureThreshold: 99 },
    });
    await chain2.chat(req());
    const second = await chain2.chat(req());
    expect(second.provider).toBe('D');
    expect(c.calls).toHaveLength(1);
    expect(second.routing!.skipped[0]!.reason).toMatch(/asked to wait/);
  });

  it('keeps a conversation on the provider that served it, unless that provider fails', async () => {
    const a = fake('A', [err('server_error'), ok('a-later')]);
    const b = fake('B', [ok('b1'), ok('b2'), ok('b3')]);
    const chain = new FallbackProvider({
      members: [{ provider: a }, { provider: b }],
      clock: new ManualClock(),
      breaker: { failureThreshold: 99 },
    });
    expect((await chain.chat(req({ conversationId: 'conv1' }))).provider).toBe('B'); // A failed
    const again = await chain.chat(req({ conversationId: 'conv1' }));
    expect(again.provider).toBe('B');
    expect(again.routing!.skipped).toEqual([]); // A was not even tried
    expect(a.calls).toHaveLength(1);
    expect((await chain.chat(req({ conversationId: 'conv2' }))).provider).toBe('A'); // a new conversation starts at the top of the chain
  });

  it('skips a provider known not to support tools when the request has tools', async () => {
    const a = new FakeProvider({
      id: 'A',
      script: [ok('plain')],
      capabilities: { tools: { value: false, source: 'probed', probedAt: 'x' } },
    });
    const b = fake('B', [{ type: 'tool_calls', calls: [{ name: 't', arguments: {} }] }]);
    const chain = new FallbackProvider({
      members: [{ provider: a }, { provider: b }],
      clock: new ManualClock(),
    });
    const tools = [{ name: 't', description: 'd', parameters: { type: 'object' } }];
    const r = await chain.chat(req({ tools }));
    expect(r.provider).toBe('B');
    expect(r.routing!.skipped[0]!.reason).toBe('does not support tool calls (probed)');
    expect((await chain.chat(req())).provider).toBe('A'); // without tools A is fine
    // when no member supports tools the chain says so and the agent refuses up front
    const only = new FallbackProvider({
      members: [
        {
          provider: new FakeProvider({
            id: 'X',
            capabilities: { tools: { value: false, source: 'probed' } },
          }),
        },
      ],
      clock: new ManualClock(),
    });
    expect(only.capabilities().tools.value).toBe(false);
    expect((await fail(only.chat(req({ tools })))).causes![0]!.message).toMatch(
      /does not support tool calls/,
    );
  });

  it('streaming: falls over before any content, never after content has been delivered', async () => {
    const a = fake('A', [
      err('rate_limited'),
      { type: 'stream_fail', text: 'partial', error: { kind: 'network' } },
    ]);
    const b = fake('B', [ok('from B'), ok('never')]);
    const chain = new FallbackProvider({
      members: [{ provider: a }, { provider: b }],
      clock: new ManualClock(),
      breaker: { failureThreshold: 99 },
    });
    const first = await events(chain.stream(req()));
    const done = first[first.length - 1]!;
    expect(done.type).toBe('done');
    expect(
      (done as { result: { routing: { provider: string; skipped: unknown[] } } }).result.routing,
    ).toEqual({ provider: 'B', skipped: [{ provider: 'A', reason: 'rate_limited' }] });
    const second = await events(chain.stream(req()));
    expect(second.some((e) => e.type === 'text_delta')).toBe(true);
    expect(second[second.length - 1]).toMatchObject({
      type: 'error',
      error: { kind: 'network', midStream: true },
    });
    expect(b.remaining).toBe(1); // B was not asked to continue the answer
  });

  it('the fallover is visible in the agent run trace', async () => {
    const a = fake('A', [
      err('server_error', { status: 500 }),
      err('server_error', { status: 500 }),
    ]);
    const b = fake('B', [
      { type: 'tool_calls', calls: [{ name: 'echo', arguments: { v: 'x' } }] },
      ok('final from B'),
    ]);
    const chain = new FallbackProvider({
      members: [{ provider: a }, { provider: b }],
      clock: new ManualClock(),
      breaker: { failureThreshold: 99 },
    });
    const echo = defineTool({
      name: 'echo',
      description: 'x',
      parameters: z.object({ v: z.string() }),
      execute: (x: { v: string }) => x.v,
    });
    const run = await runAgent({ provider: chain, prompt: 'x', tools: [echo] });
    expect(run.stopReason).toBe('final_answer');
    expect(run.trace.steps.map((s) => s.model.routing)).toEqual([
      { provider: 'B', skipped: [{ provider: 'A', reason: 'server_error (HTTP 500)' }] },
      { provider: 'B', skipped: [] }, // the conversation stayed on B in the next step: A was not asked again
    ]);
    expect(a.calls).toHaveLength(1);
  });
});
