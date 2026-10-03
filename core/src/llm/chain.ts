import { LLMError, toLLMError, type LLMErrorCause, type LLMErrorKind } from './errors.js';
import {
  systemClock,
  unknownCapabilities,
  type Capabilities,
  type ChatRequest,
  type ChatResult,
  type Clock,
  type LLMProvider,
  type ProviderRouting,
  type RateLimitInfo,
  type StreamEvent,
} from './types.js';

/** Errors after which the next provider is tried. Everything else is surfaced to the caller. */
export const FALLOVER_KINDS: readonly LLMErrorKind[] = [
  'rate_limited',
  'server_error',
  'timeout',
  'network',
];
export const isFalloverKind = (k: LLMErrorKind): boolean => FALLOVER_KINDS.includes(k);

// ---------------------------------------------------------------------------------------------
// circuit breaker
// ---------------------------------------------------------------------------------------------

export interface BreakerConfig {
  /** consecutive failures that open the circuit. Default 3. */
  failureThreshold?: number;
  /** how long it stays open before one trial request is allowed. Default 30,000 ms. */
  cooldownMs?: number;
}

export type BreakerState = 'closed' | 'open' | 'half_open';

/**
 * closed: requests flow; `failureThreshold` consecutive failures open it.
 * open: requests are refused until `cooldownMs` has passed.
 * half_open: exactly one trial request is allowed; success closes the circuit, failure opens it again.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private state: BreakerState = 'closed';
  private trialInFlight = false;
  private threshold: number;
  private cooldown: number;

  constructor(
    private clock: Clock,
    cfg: BreakerConfig = {},
  ) {
    this.threshold = cfg.failureThreshold ?? 3;
    this.cooldown = cfg.cooldownMs ?? 30_000;
  }

  /** The state as of now (an open circuit whose cooldown has passed reads as half_open). */
  current(): BreakerState {
    if (this.state === 'open' && this.clock.now() - this.openedAt >= this.cooldown)
      return 'half_open';
    return this.state;
  }
  msUntilHalfOpen(): number {
    return this.state === 'open'
      ? Math.max(0, this.cooldown - (this.clock.now() - this.openedAt))
      : 0;
  }
  consecutiveFailures(): number {
    return this.failures;
  }

  /** Asks permission for a request; in half_open this claims the single trial. */
  tryAcquire(): boolean {
    const s = this.current();
    if (s === 'closed') return true;
    if (s === 'half_open') {
      if (this.trialInFlight) return false;
      this.state = 'half_open';
      this.trialInFlight = true;
      return true;
    }
    return false;
  }
  /** Gives back a trial that was not used (e.g. skipped for another reason). */
  release(): void {
    this.trialInFlight = false;
  }
  onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
    this.trialInFlight = false;
  }
  onFailure(): void {
    this.trialInFlight = false;
    if (this.state === 'half_open') {
      this.state = 'open';
      this.openedAt = this.clock.now();
      return;
    }
    this.failures++;
    if (this.failures >= this.threshold) {
      this.state = 'open';
      this.openedAt = this.clock.now();
    }
  }
}

// ---------------------------------------------------------------------------------------------
// quota tracking
// ---------------------------------------------------------------------------------------------

export interface QuotaConfig {
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  requestsPerDay?: number;
  tokensPerDay?: number;
}

const MINUTE = 60_000;
const DAY = 86_400_000;

/**
 * Counts requests and tokens in sliding windows against the configured limits, and honors what the
 * provider itself reports: rate-limit response headers and Retry-After block the provider until the
 * stated reset, whatever the configured limits say.
 */
export class QuotaTracker {
  private requests: number[] = [];
  private tokens: { t: number; n: number }[] = [];
  private blockedUntil = 0;
  private blockedWhy = '';

  constructor(
    private clock: Clock,
    private cfg: QuotaConfig = {},
  ) {}

  private prune(now: number): void {
    this.requests = this.requests.filter((t) => now - t < DAY);
    this.tokens = this.tokens.filter((x) => now - x.t < DAY);
  }

  /** null when a request may be made, otherwise why not. Makes no request. */
  check(): { reason: string; retryAfterMs: number } | null {
    const now = this.clock.now();
    this.prune(now);
    if (now < this.blockedUntil)
      return {
        reason: `quota exhausted (${this.blockedWhy})`,
        retryAfterMs: this.blockedUntil - now,
      };
    const inWindow = (w: number): { r: number[]; k: { t: number; n: number }[] } => ({
      r: this.requests.filter((t) => now - t < w),
      k: this.tokens.filter((x) => now - x.t < w),
    });
    const m = inWindow(MINUTE);
    const d = inWindow(DAY);
    const sum = (k: { n: number }[]): number => k.reduce((a, x) => a + x.n, 0);
    const wait = (arr: number[], w: number): number => Math.max(0, w - (now - Math.min(...arr)));
    if (this.cfg.requestsPerMinute !== undefined && m.r.length >= this.cfg.requestsPerMinute) {
      return {
        reason: `quota exhausted (${m.r.length}/${this.cfg.requestsPerMinute} requests per minute)`,
        retryAfterMs: wait(m.r, MINUTE),
      };
    }
    if (this.cfg.tokensPerMinute !== undefined && sum(m.k) >= this.cfg.tokensPerMinute) {
      return {
        reason: `quota exhausted (${sum(m.k)}/${this.cfg.tokensPerMinute} tokens per minute)`,
        retryAfterMs: wait(
          m.k.map((x) => x.t),
          MINUTE,
        ),
      };
    }
    if (this.cfg.requestsPerDay !== undefined && d.r.length >= this.cfg.requestsPerDay) {
      return {
        reason: `quota exhausted (${d.r.length}/${this.cfg.requestsPerDay} requests per day)`,
        retryAfterMs: wait(d.r, DAY),
      };
    }
    if (this.cfg.tokensPerDay !== undefined && sum(d.k) >= this.cfg.tokensPerDay) {
      return {
        reason: `quota exhausted (${sum(d.k)}/${this.cfg.tokensPerDay} tokens per day)`,
        retryAfterMs: wait(
          d.k.map((x) => x.t),
          DAY,
        ),
      };
    }
    return null;
  }

  /** Records a request that was sent and the tokens it used. */
  record(tokens: number): void {
    const now = this.clock.now();
    this.requests.push(now);
    if (tokens > 0) this.tokens.push({ t: now, n: tokens });
  }

  /** Updates from rate-limit headers: a remaining count of 0 blocks until the reset time. */
  observe(info: RateLimitInfo | undefined): void {
    if (!info) return;
    const now = this.clock.now();
    if (info.remainingRequests === 0)
      this.block(
        now + (info.resetRequestsMs ?? MINUTE),
        'the provider reports 0 requests remaining',
      );
    if (info.remainingTokens === 0)
      this.block(now + (info.resetTokensMs ?? MINUTE), 'the provider reports 0 tokens remaining');
  }
  /** A 429 with a Retry-After blocks the provider for that long. */
  blockFor(ms: number, why: string): void {
    this.block(this.clock.now() + ms, why);
  }
  private block(until: number, why: string): void {
    if (until > this.blockedUntil) {
      this.blockedUntil = until;
      this.blockedWhy = why;
    }
  }
  usage(): {
    requestsLastMinute: number;
    requestsLastDay: number;
    tokensLastMinute: number;
    tokensLastDay: number;
  } {
    const now = this.clock.now();
    this.prune(now);
    const k = (w: number): number =>
      this.tokens.filter((x) => now - x.t < w).reduce((a, x) => a + x.n, 0);
    return {
      requestsLastMinute: this.requests.filter((t) => now - t < MINUTE).length,
      requestsLastDay: this.requests.length,
      tokensLastMinute: k(MINUTE),
      tokensLastDay: k(DAY),
    };
  }
}

// ---------------------------------------------------------------------------------------------
// the chain
// ---------------------------------------------------------------------------------------------

export interface ChainMember {
  provider: LLMProvider;
  quota?: QuotaConfig;
}

export interface FallbackOptions {
  members: ChainMember[];
  breaker?: BreakerConfig;
  clock?: Clock;
  id?: string;
  /** keep a conversation (request.conversationId) on the provider that last served it while that provider is healthy. Default true. */
  sticky?: boolean;
}

interface Slot {
  member: ChainMember;
  breaker: CircuitBreaker;
  quota: QuotaTracker;
}

export interface ProviderHealth {
  provider: string;
  circuit: BreakerState;
  consecutiveFailures: number;
  msUntilHalfOpen: number;
  usage: ReturnType<QuotaTracker['usage']>;
}

/**
 * Tries providers in order (A, then B, then C). A provider is passed over, with the reason recorded
 * in `ChatResult.routing`, when its circuit is open, its quota is exhausted, or it is known not to
 * support the tools in the request; it is failed over from after rate_limited, server_error,
 * timeout or network errors. bad_request, auth_failed, content_filtered, context_length,
 * invalid_response and cancelled are surfaced to the caller, because another provider will not fix
 * them (or the caller asked to stop). When every provider failed or was skipped, one LLMError lists
 * each reason in `causes`.
 */
export class FallbackProvider implements LLMProvider {
  readonly id: string;
  readonly model: string;
  private slots: Slot[];
  private clock: Clock;
  private sticky: boolean;
  private lastFor = new Map<string, string>();

  constructor(o: FallbackOptions) {
    if (o.members.length === 0) throw new Error('a fallback chain needs at least one provider');
    this.clock = o.clock ?? systemClock;
    this.sticky = o.sticky ?? true;
    this.slots = o.members.map((member) => ({
      member,
      breaker: new CircuitBreaker(this.clock, o.breaker),
      quota: new QuotaTracker(this.clock, member.quota),
    }));
    this.id = o.id ?? `chain(${o.members.map((m) => m.provider.id).join('>')})`;
    this.model = o.members[0]!.provider.model;
  }

  health(): ProviderHealth[] {
    return this.slots.map((s) => ({
      provider: s.member.provider.id,
      circuit: s.breaker.current(),
      consecutiveFailures: s.breaker.consecutiveFailures(),
      msUntilHalfOpen: s.breaker.msUntilHalfOpen(),
      usage: s.quota.usage(),
    }));
  }

  /** tools: false only if every member is known not to support them; true if any does; otherwise unknown */
  capabilities(): Capabilities {
    const caps = this.slots.map((s) => s.member.provider.capabilities());
    const merged = unknownCapabilities();
    for (const k of ['tools', 'streaming', 'jsonMode', 'parallelToolCalls'] as const) {
      const vals = caps.map((c) => c[k]);
      if (vals.every((v) => v.value === false))
        merged[k] = { value: false, source: vals[0]!.source, probedAt: vals[0]!.probedAt };
      else if (vals.some((v) => v.value === true))
        merged[k] = { value: true, source: vals.find((v) => v.value === true)!.source };
    }
    return merged;
  }

  private order(req: ChatRequest): Slot[] {
    const preferred =
      this.sticky && req.conversationId ? this.lastFor.get(req.conversationId) : undefined;
    if (!preferred) return this.slots;
    const i = this.slots.findIndex((s) => s.member.provider.id === preferred);
    if (i <= 0) return this.slots;
    return [this.slots[i]!, ...this.slots.filter((_, j) => j !== i)];
  }

  private remember(req: ChatRequest, id: string): void {
    if (!this.sticky || !req.conversationId) return;
    this.lastFor.delete(req.conversationId);
    this.lastFor.set(req.conversationId, id);
    if (this.lastFor.size > 1000) this.lastFor.delete(this.lastFor.keys().next().value as string);
  }

  /** null = go ahead; otherwise the reason this provider is passed over. Claims the half-open trial when it returns null. */
  private gate(
    slot: Slot,
    req: ChatRequest,
  ): { reason: string; cause: LLMErrorCause['kind']; retryAfterMs?: number } | null {
    const p = slot.member.provider;
    if (req.tools?.length && p.capabilities().tools.value === false) {
      return {
        reason: `does not support tool calls (${p.capabilities().tools.source})`,
        cause: 'bad_request',
      };
    }
    const q = slot.quota.check();
    if (q) return { reason: q.reason, cause: 'quota_exhausted', retryAfterMs: q.retryAfterMs };
    if (!slot.breaker.tryAcquire()) {
      return {
        reason: `circuit open (${Math.ceil(slot.breaker.msUntilHalfOpen() / 1000)} s until a trial request)`,
        cause: 'circuit_open',
        retryAfterMs: slot.breaker.msUntilHalfOpen(),
      };
    }
    return null;
  }

  private exhausted(
    causes: LLMErrorCause[],
    lastReal: LLMError | undefined,
    retryAfter: number | undefined,
  ): LLMError {
    const kind: LLMErrorKind = lastReal
      ? lastReal.kind
      : causes.every((c) => c.kind === 'circuit_open')
        ? 'server_error'
        : causes.some((c) => c.kind === 'quota_exhausted')
          ? 'rate_limited'
          : 'bad_request';
    return new LLMError({
      kind,
      message: `no provider could take the request: ${causes.map((c) => `${c.provider}: ${c.message}`).join('; ')}`,
      provider: this.id,
      retryAfterMs: retryAfter,
      causes,
    });
  }

  private onFailure(slot: Slot, err: LLMError): void {
    slot.breaker.onFailure();
    if (err.kind === 'rate_limited') {
      if (err.retryAfterMs)
        slot.quota.blockFor(err.retryAfterMs, 'the provider asked to wait (Retry-After)');
      slot.quota.observe(err.rateLimit);
    }
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const skipped: ProviderRouting['skipped'] = [];
    const causes: LLMErrorCause[] = [];
    let lastReal: LLMError | undefined;
    let retryAfter: number | undefined;
    const note = (v: number | undefined): void => {
      if (v !== undefined && v > 0)
        retryAfter = retryAfter === undefined ? v : Math.min(retryAfter, v);
    };
    for (const slot of this.order(req)) {
      const p = slot.member.provider;
      const g = this.gate(slot, req);
      if (g) {
        skipped.push({ provider: p.id, reason: g.reason });
        causes.push({ provider: p.id, kind: g.cause, message: g.reason });
        note(g.retryAfterMs);
        continue;
      }
      try {
        const r = await p.chat(req);
        slot.breaker.onSuccess();
        slot.quota.record(r.usage.totalTokens);
        slot.quota.observe(r.rateLimit);
        this.remember(req, p.id);
        return { ...r, routing: { provider: p.id, skipped } };
      } catch (e) {
        const err = toLLMError(e, p.id);
        if (err.kind === 'cancelled') {
          slot.breaker.release();
          throw err;
        }
        slot.quota.record(0);
        if (!isFalloverKind(err.kind)) {
          slot.breaker.onSuccess(); // it answered: the provider is up, the request is the problem
          throw err;
        }
        this.onFailure(slot, err);
        lastReal = err;
        note(err.retryAfterMs);
        const reason = `${err.kind}${err.status ? ` (HTTP ${err.status})` : ''}`;
        skipped.push({ provider: p.id, reason });
        causes.push({ provider: p.id, kind: err.kind, message: err.message });
      }
    }
    throw this.exhausted(causes, lastReal, retryAfter);
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const skipped: ProviderRouting['skipped'] = [];
    const causes: LLMErrorCause[] = [];
    let lastReal: LLMError | undefined;
    let retryAfter: number | undefined;
    for (const slot of this.order(req)) {
      const p = slot.member.provider;
      const g = this.gate(slot, req);
      if (g) {
        skipped.push({ provider: p.id, reason: g.reason });
        causes.push({ provider: p.id, kind: g.cause, message: g.reason });
        if (g.retryAfterMs) retryAfter = Math.min(retryAfter ?? Infinity, g.retryAfterMs);
        continue;
      }
      let yielded = false;
      let failed: LLMError | undefined;
      for await (const e of p.stream(req)) {
        if (e.type === 'error') {
          failed = e.error;
          break;
        }
        if (e.type === 'text_delta' || e.type === 'tool_call_start') yielded = true;
        if (e.type === 'done') {
          slot.breaker.onSuccess();
          slot.quota.record(e.result.usage.totalTokens);
          slot.quota.observe(e.result.rateLimit);
          this.remember(req, p.id);
          yield { type: 'done', result: { ...e.result, routing: { provider: p.id, skipped } } };
          return;
        }
        yield e;
      }
      if (!failed) return; // stream ended without done or error: nothing more to say
      if (failed.kind === 'cancelled') {
        slot.breaker.release();
        yield { type: 'error', error: failed };
        return;
      }
      slot.quota.record(0);
      if (!isFalloverKind(failed.kind)) {
        slot.breaker.onSuccess();
        yield { type: 'error', error: failed };
        return;
      }
      this.onFailure(slot, failed);
      if (yielded) {
        // content was already delivered: switching providers would splice two answers
        yield { type: 'error', error: failed };
        return;
      }
      lastReal = failed;
      if (failed.retryAfterMs) retryAfter = Math.min(retryAfter ?? Infinity, failed.retryAfterMs);
      skipped.push({
        provider: p.id,
        reason: `${failed.kind}${failed.status ? ` (HTTP ${failed.status})` : ''}`,
      });
      causes.push({ provider: p.id, kind: failed.kind, message: failed.message });
    }
    yield {
      type: 'error',
      error: this.exhausted(causes, lastReal, retryAfter === Infinity ? undefined : retryAfter),
    };
  }
}
