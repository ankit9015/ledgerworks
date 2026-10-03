import { LLMError, cancelled, type LLMErrorKind } from './errors.js';
import {
  estimateTokens,
  systemClock,
  unknownCapabilities,
  type Capabilities,
  type ChatRequest,
  type ChatResult,
  type Clock,
  type FinishReason,
  type LLMProvider,
  type StreamEvent,
  type ToolCall,
  type Usage,
} from './types.js';

export interface FakeToolCall {
  /** omit to get "call_<n>" */
  id?: string;
  name: string;
  /** an object (serialised for you) or a RAW STRING, which may be malformed JSON on purpose */
  arguments: unknown;
}

export interface FakeErrorSpec {
  kind: LLMErrorKind;
  message?: string;
  retryAfterMs?: number;
  status?: number;
}

/** One scripted answer. The script is consumed one entry per chat() or stream() call. */
export type FakeStep =
  | {
      type: 'text';
      content: string;
      usage?: Partial<Usage>;
      chunkSize?: number;
      chunkDelayMs?: number;
      finishReason?: FinishReason;
    }
  | {
      type: 'tool_calls';
      calls: FakeToolCall[];
      content?: string | null;
      usage?: Partial<Usage>;
      chunkDelayMs?: number;
    }
  | { type: 'error'; error: FakeErrorSpec }
  /** never answers: ends when the caller aborts, or with a timeout once request.timeoutMs elapses */
  | { type: 'hang' }
  /** streams `text` and then fails mid-stream (chat() simply fails) */
  | { type: 'stream_fail'; text?: string; error: FakeErrorSpec; chunkSize?: number };

export type FakeScript = (FakeStep | ((req: ChatRequest, callIndex: number) => FakeStep))[];

export interface FakeProviderOptions {
  id?: string;
  model?: string;
  script?: FakeScript;
  clock?: Clock;
  capabilities?: Partial<Capabilities>;
  /** what to do when the script runs out (default: throw an invalid_response so the test fails loudly) */
  onExhausted?: FakeStep;
}

const providerUsage = (req: ChatRequest, completion: string, over?: Partial<Usage>): Usage => {
  const prompt = estimateTokens(JSON.stringify(req.messages));
  const comp = estimateTokens(completion);
  return {
    promptTokens: over?.promptTokens ?? prompt,
    completionTokens: over?.completionTokens ?? comp,
    totalTokens:
      over?.totalTokens ?? (over?.promptTokens ?? prompt) + (over?.completionTokens ?? comp),
    source: over?.source ?? 'provider',
  };
};

function toToolCall(c: FakeToolCall, n: number): ToolCall {
  const id = c.id ?? `call_${n}`;
  if (typeof c.arguments === 'string') {
    try {
      return { id, name: c.name, arguments: JSON.parse(c.arguments), rawArguments: c.arguments };
    } catch (e) {
      return {
        id,
        name: c.name,
        arguments: undefined,
        rawArguments: c.arguments,
        argumentsError: `arguments are not valid JSON: ${(e as Error).message}`,
      };
    }
  }
  return {
    id,
    name: c.name,
    arguments: c.arguments,
    rawArguments: JSON.stringify(c.arguments ?? {}),
  };
}

/**
 * A scriptable provider for tests: normal replies, tool calls (also with malformed arguments and
 * unknown tool names), provider errors (429, timeouts, ...), mid-stream failures and slow streams.
 * It records every request it received in `calls`.
 */
export class FakeProvider implements LLMProvider {
  readonly id: string;
  readonly model: string;
  readonly calls: ChatRequest[] = [];
  private script: FakeScript;
  private clock: Clock;
  private caps: Capabilities;
  private index = 0;
  private exhausted: FakeStep | undefined;
  private toolCounter = 0;

  constructor(o: FakeProviderOptions = {}) {
    this.id = o.id ?? 'fake';
    this.model = o.model ?? 'fake-model';
    this.script = [...(o.script ?? [])];
    this.clock = o.clock ?? systemClock;
    this.caps = { ...unknownCapabilities(), ...o.capabilities };
    this.exhausted = o.onExhausted;
  }

  /** append steps to the script */
  enqueue(...steps: FakeScript): this {
    this.script.push(...steps);
    return this;
  }
  get remaining(): number {
    return this.script.length - this.index;
  }
  capabilities(): Capabilities {
    return this.caps;
  }
  updateCapabilities(patch: Partial<Capabilities>): void {
    this.caps = { ...this.caps, ...patch };
  }
  async listModels(): Promise<string[]> {
    return [this.model];
  }

  private next(req: ChatRequest): FakeStep {
    this.calls.push({ ...req, messages: [...req.messages] });
    const entry = this.script[this.index++];
    if (entry === undefined) {
      if (this.exhausted) return this.exhausted;
      throw new LLMError({
        kind: 'invalid_response',
        message: 'FakeProvider script exhausted',
        provider: this.id,
      });
    }
    return typeof entry === 'function' ? entry(req, this.index - 1) : entry;
  }

  private err(spec: FakeErrorSpec, midStream = false): LLMError {
    return new LLMError({
      kind: spec.kind,
      message: spec.message ?? `scripted ${spec.kind}`,
      provider: this.id,
      status: spec.status,
      retryAfterMs: spec.retryAfterMs,
      midStream,
    });
  }

  private async hang(req: ChatRequest): Promise<never> {
    const signal = req.signal;
    if (signal?.aborted) throw cancelled(this.id);
    const waits: Promise<never>[] = [];
    if (signal) {
      waits.push(
        new Promise<never>((_, reject) =>
          signal.addEventListener('abort', () => reject(cancelled(this.id)), { once: true }),
        ),
      );
    }
    if (req.timeoutMs !== undefined) {
      waits.push(
        this.clock.sleep(req.timeoutMs).then(() => {
          throw new LLMError({
            kind: 'timeout',
            message: `no answer within ${req.timeoutMs} ms`,
            provider: this.id,
          });
        }),
      );
    }
    if (waits.length === 0) await new Promise(() => undefined);
    return Promise.race(waits);
  }

  private build(step: FakeStep, req: ChatRequest): ChatResult {
    if (step.type === 'text') {
      return {
        content: step.content,
        toolCalls: [],
        finishReason: step.finishReason ?? 'stop',
        usage: providerUsage(req, step.content, step.usage),
        model: this.model,
        provider: this.id,
      };
    }
    if (step.type === 'tool_calls') {
      const calls = step.calls.map((c) => toToolCall(c, ++this.toolCounter));
      return {
        content: step.content ?? null,
        toolCalls: calls,
        finishReason: 'tool_calls',
        usage: providerUsage(
          req,
          JSON.stringify(calls.map((c) => [c.name, c.rawArguments])),
          step.usage,
        ),
        model: this.model,
        provider: this.id,
      };
    }
    throw new Error('not a reply step');
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    if (req.signal?.aborted) throw cancelled(this.id);
    const step = this.next(req);
    switch (step.type) {
      case 'error':
        throw this.err(step.error);
      case 'stream_fail':
        throw this.err(step.error);
      case 'hang':
        return this.hang(req);
      default:
        if (step.type === 'text' || step.type === 'tool_calls') {
          if (step.chunkDelayMs)
            await this.clock.sleep(step.chunkDelayMs, req.signal).catch(() => {
              throw cancelled(this.id);
            });
        }
        return this.build(step, req);
    }
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    try {
      if (req.signal?.aborted) throw cancelled(this.id);
      const step = this.next(req);
      if (step.type === 'error') throw this.err(step.error);
      if (step.type === 'hang') return yield* this.hangEvents(req);
      const pause = async (ms?: number): Promise<void> => {
        if (req.signal?.aborted) throw cancelled(this.id);
        if (ms)
          await this.clock.sleep(ms, req.signal).catch(() => {
            throw cancelled(this.id);
          });
      };
      if (step.type === 'stream_fail') {
        const size = step.chunkSize ?? 8;
        const text = step.text ?? '';
        for (let i = 0; i < text.length; i += size) {
          await pause();
          yield { type: 'text_delta', text: text.slice(i, i + size) };
        }
        throw this.err(step.error, text.length > 0);
      }
      const result = this.build(step, req);
      if (step.type === 'text') {
        const size = step.chunkSize ?? 8;
        for (let i = 0; i < step.content.length; i += size) {
          await pause(step.chunkDelayMs);
          yield { type: 'text_delta', text: step.content.slice(i, i + size) };
        }
      } else {
        if (result.content) yield { type: 'text_delta', text: result.content };
        let index = 0;
        for (const c of result.toolCalls) {
          await pause(step.chunkDelayMs);
          yield { type: 'tool_call_start', index, id: c.id, name: c.name };
          const raw = c.rawArguments;
          const mid = Math.ceil(raw.length / 2);
          yield { type: 'tool_call_delta', index, argumentsDelta: raw.slice(0, mid) };
          yield { type: 'tool_call_delta', index, argumentsDelta: raw.slice(mid) };
          yield { type: 'tool_call_end', index };
          index++;
        }
      }
      yield { type: 'usage', usage: result.usage };
      yield { type: 'done', result };
    } catch (e) {
      yield { type: 'error', error: e instanceof LLMError ? e : cancelled(this.id) };
    }
  }

  private async *hangEvents(req: ChatRequest): AsyncGenerator<StreamEvent> {
    try {
      await this.hang(req);
    } catch (e) {
      yield { type: 'error', error: e as LLMError };
    }
  }
}
