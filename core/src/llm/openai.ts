import { LLMError, cancelled, type LLMErrorKind } from './errors.js';
import { SseLimitError, parseSse } from './sse.js';
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
  type Message,
  type RateLimitInfo,
  type StreamEvent,
  type ToolCall,
  type Usage,
} from './types.js';

/** The part of `fetch` the adapter uses. The safe fetch of C2.7 has the same shape. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<Response>;

export interface OpenAICompatibleConfig {
  baseURL: string;
  /** may be empty for servers without authentication (a local Ollama) */
  apiKey: string;
  model: string;
  /** id used in traces; default "openai-compatible" */
  id?: string;
  headers?: Record<string, string>;
  /** per attempt: until the response is complete (chat) or until the headers arrive (stream). Default 60,000. */
  timeoutMs?: number;
  /** stream only: longest pause between two chunks. Default: timeoutMs. */
  streamIdleTimeoutMs?: number;
  /** retries after the first attempt (429, 5xx, network). Default 3. */
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  /** total time the adapter may spend sleeping between retries. Default 60,000. */
  retryBudgetMs?: number;
  fetch?: FetchLike;
  clock?: Clock;
  /** returns [0, 1); injectable for deterministic backoff */
  random?: () => number;
  /** capabilities you assert; they are labelled "declared" */
  declare?: Partial<{
    tools: boolean;
    streaming: boolean;
    jsonMode: boolean;
    parallelToolCalls: boolean;
    maxContext: number;
  }>;
  limits?: { maxResponseBytes?: number; maxStreamEvents?: number; maxStreamMs?: number };
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------------------------------
// header parsing
// ---------------------------------------------------------------------------------------------

/** Retry-After: delay in seconds (may be fractional) or an HTTP date. Returns ms, or undefined. */
export function parseRetryAfter(
  value: string | null | undefined,
  nowMs: number,
): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const t = Date.parse(v);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, t - nowMs);
}

/** "1s", "6m0s", "20ms", "1h2m3.5s" or a bare number of seconds, to milliseconds. */
export function parseDurationMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(v))) {
    matched += m[0].length;
    const n = Number(m[1]);
    total +=
      m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : m[2] === 'm' ? n * 60_000 : n * 3_600_000;
  }
  return matched === v.length ? Math.round(total) : undefined;
}

export function parseRateLimit(h: Headers): RateLimitInfo | undefined {
  const num = (k: string): number | undefined => {
    const v = h.get(k);
    return v !== null && /^\d+$/.test(v.trim()) ? Number(v) : undefined;
  };
  const info: RateLimitInfo = {
    remainingRequests: num('x-ratelimit-remaining-requests'),
    remainingTokens: num('x-ratelimit-remaining-tokens'),
    resetRequestsMs: parseDurationMs(h.get('x-ratelimit-reset-requests')),
    resetTokensMs: parseDurationMs(h.get('x-ratelimit-reset-tokens')),
  };
  const clean = Object.fromEntries(
    Object.entries(info).filter(([, v]) => v !== undefined),
  ) as RateLimitInfo;
  return Object.keys(clean).length ? clean : undefined;
}

// ---------------------------------------------------------------------------------------------
// error mapping
// ---------------------------------------------------------------------------------------------

const CONTEXT_RE =
  /context[_ ]length|maximum context|context window|too many tokens|reduce the length|token limit/i;
const FILTER_RE =
  /content[_ ]filter|content[_ ]policy|content management policy|safety system|responsible ai/i;

function errorFields(body: string): { message: string; code: string; type: string } {
  try {
    const j: unknown = JSON.parse(body);
    const e = isObj(j) ? (isObj(j.error) ? j.error : j) : {};
    return {
      message:
        typeof e.message === 'string' ? e.message : typeof e.error === 'string' ? e.error : '',
      code: typeof e.code === 'string' ? e.code : typeof e.code === 'number' ? String(e.code) : '',
      type: typeof e.type === 'string' ? e.type : '',
    };
  } catch {
    return { message: '', code: '', type: '' };
  }
}

interface MappedError {
  error: LLMError;
  /** do not retry even though the kind is normally retriable (e.g. an exhausted quota) */
  noRetry: boolean;
}

function mapHttpError(
  status: number,
  body: string,
  headers: Headers,
  nowMs: number,
  provider: string,
  secrets: string[],
): MappedError {
  const f = errorFields(body);
  const detail = f.message || f.code || f.type;
  const text = `HTTP ${status}${detail ? `: ${detail.slice(0, 200)}` : ''}`;
  const retryAfterMs =
    parseRetryAfter(
      headers.get('retry-after-ms') ? String(Number(headers.get('retry-after-ms')) / 1000) : null,
      nowMs,
    ) ?? parseRetryAfter(headers.get('retry-after'), nowMs);
  const mk = (kind: LLMErrorKind, extra: { noRetry?: boolean } = {}): MappedError => ({
    error: new LLMError({ kind, message: text, provider, status, retryAfterMs, secrets }),
    noRetry: extra.noRetry ?? false,
  });
  const haystack = `${f.code} ${f.type} ${f.message}`;
  if (status === 401 || status === 403) return mk('auth_failed');
  if (status === 408) return mk('timeout');
  if (status === 429)
    return mk('rate_limited', {
      noRetry: /insufficient_quota|billing|exceeded your current quota/i.test(haystack),
    });
  if (status >= 500) return mk('server_error');
  if (status === 400 || status === 413 || status === 422) {
    if (status === 413 || CONTEXT_RE.test(haystack)) return mk('context_length');
    if (FILTER_RE.test(haystack)) return mk('content_filtered');
    return mk('bad_request');
  }
  return mk('bad_request');
}

// ---------------------------------------------------------------------------------------------
// request building
// ---------------------------------------------------------------------------------------------

function toWireMessages(messages: Message[]): Json[] {
  return messages.map((m): Json => {
    switch (m.role) {
      case 'system':
      case 'user':
        return { role: m.role, content: m.content };
      case 'assistant': {
        const out: Json = {
          role: 'assistant',
          content: m.toolCalls?.length ? (m.content ?? null) : (m.content ?? ''),
        };
        if (m.toolCalls?.length) {
          out.tool_calls = m.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.rawArguments },
          }));
        }
        return out;
      }
      case 'tool':
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
  });
}

// ---------------------------------------------------------------------------------------------
// response normalisation
// ---------------------------------------------------------------------------------------------

function partsToText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const t = content
      .map((p) =>
        isObj(p) && typeof p.text === 'string' ? p.text : typeof p === 'string' ? p : '',
      )
      .join('');
    return t;
  }
  return null;
}

/**
 * Turns the arguments of one tool call into our form, normalising what can be normalised:
 *  - a JSON string (standard);
 *  - an object instead of a string (quirk 'arguments_as_object');
 *  - an empty string or null for a tool without arguments (quirk 'empty_arguments' -> {});
 *  - a JSON string that was encoded twice (quirk 'double_encoded_arguments').
 * Anything else (not JSON, or not an object after parsing) is returned with `argumentsError` set.
 * Nothing is repaired or guessed.
 */
export function normalizeArguments(
  raw: unknown,
  quirks: Set<string>,
): { arguments: unknown; rawArguments: string; argumentsError?: string } {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    quirks.add('empty_arguments');
    return { arguments: {}, rawArguments: '{}' };
  }
  if (isObj(raw)) {
    quirks.add('arguments_as_object');
    return { arguments: raw, rawArguments: JSON.stringify(raw) };
  }
  if (typeof raw !== 'string') {
    return {
      arguments: undefined,
      rawArguments: String(raw),
      argumentsError: `arguments have type ${typeof raw}, expected a JSON object`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      arguments: undefined,
      rawArguments: raw,
      argumentsError: `arguments are not valid JSON: ${(e as Error).message}`,
    };
  }
  if (typeof parsed === 'string') {
    try {
      const again: unknown = JSON.parse(parsed);
      if (isObj(again)) {
        quirks.add('double_encoded_arguments');
        return { arguments: again, rawArguments: parsed };
      }
    } catch {
      // fall through
    }
  }
  if (!isObj(parsed)) {
    return {
      arguments: undefined,
      rawArguments: raw,
      argumentsError: 'arguments must be a JSON object',
    };
  }
  return { arguments: parsed, rawArguments: raw };
}

function normalizeToolCalls(
  rawCalls: unknown[],
  quirks: Set<string>,
  provider: string,
): ToolCall[] {
  const out: ToolCall[] = [];
  const ids = new Set<string>();
  rawCalls.forEach((entry, i) => {
    if (!isObj(entry))
      throw new LLMError({
        kind: 'invalid_response',
        message: 'a tool call is not an object',
        provider,
      });
    let fn: Json;
    if (isObj(entry.function)) fn = entry.function;
    else {
      fn = entry; // some servers put name and arguments directly on the call
      quirks.add('flat_tool_call');
    }
    const name = fn.name;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new LLMError({
        kind: 'invalid_response',
        message: 'a tool call has no function name',
        provider,
      });
    }
    let id: string;
    if (typeof entry.id === 'string' && entry.id !== '') id = entry.id;
    else {
      id = `call_${i + 1}`;
      quirks.add('tool_call_id_generated');
    }
    if (ids.has(id)) {
      throw new LLMError({
        kind: 'invalid_response',
        message: `two tool calls share the id "${id.slice(0, 40)}"`,
        provider,
      });
    }
    ids.add(id);
    out.push({ id, name, ...normalizeArguments(fn.arguments, quirks) });
  });
  return out;
}

/**
 * Some servers (typically local models) return a tool call as plain text. Recognised only when the
 * whole reply is exactly one of: `<tool_call>{...}</tool_call>` blocks, a JSON object or array, or a
 * single ```json fence, each element having a `name` that is one of the OFFERED tools and
 * `arguments` (or `parameters`). Anything else stays text. The result is flagged 'text_tool_call'.
 */
export function extractTextToolCalls(content: string, offered: Set<string>): ToolCall[] | null {
  let s = content.trim();
  if (s === '') return null;
  const blocks: string[] = [];
  const tagged = [...s.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g)];
  if (tagged.length > 0 && s.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim() === '') {
    for (const t of tagged) blocks.push(t[1]!.trim());
  } else {
    const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(s);
    if (fence) s = fence[1]!;
    blocks.push(s);
  }
  const calls: ToolCall[] = [];
  for (const b of blocks) {
    let j: unknown;
    try {
      j = JSON.parse(b);
    } catch {
      return null;
    }
    for (const c of Array.isArray(j) ? j : [j]) {
      if (!isObj(c) || typeof c.name !== 'string' || !offered.has(c.name)) return null;
      const args = c.arguments ?? c.parameters;
      if (args !== undefined && !isObj(args) && typeof args !== 'string') return null;
      const n = normalizeArguments(args, new Set());
      calls.push({ id: `call_${calls.length + 1}`, name: c.name, ...n });
    }
  }
  return calls.length ? calls : null;
}

function normalizeUsage(u: unknown, estimate: () => Usage): Usage {
  if (isObj(u)) {
    const p = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : undefined;
    const c = typeof u.completion_tokens === 'number' ? u.completion_tokens : undefined;
    const t = typeof u.total_tokens === 'number' ? u.total_tokens : undefined;
    if (p !== undefined || c !== undefined || t !== undefined) {
      const prompt = p ?? Math.max(0, (t ?? 0) - (c ?? 0));
      const comp = c ?? Math.max(0, (t ?? 0) - (p ?? 0));
      return {
        promptTokens: prompt,
        completionTokens: comp,
        totalTokens: t ?? prompt + comp,
        source: 'provider',
      };
    }
  }
  return estimate();
}

function mapFinish(reason: unknown, hasCalls: boolean, quirks: Set<string>): FinishReason {
  let r: FinishReason;
  switch (reason) {
    case 'stop':
    case 'end_turn':
      r = 'stop';
      break;
    case 'tool_calls':
    case 'function_call':
    case 'tool_use':
      r = 'tool_calls';
      break;
    case 'length':
    case 'max_tokens':
      r = 'length';
      break;
    case 'content_filter':
      r = 'content_filter';
      break;
    default:
      r = hasCalls ? 'tool_calls' : 'other';
  }
  if (hasCalls && r === 'stop') {
    quirks.add('finish_reason_corrected_to_tool_calls');
    r = 'tool_calls';
  }
  return r;
}

// ---------------------------------------------------------------------------------------------
// the adapter
// ---------------------------------------------------------------------------------------------

interface Sent {
  res: Response;
  controller: AbortController;
  timer: NodeJS.Timeout | undefined;
  done(): void;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;
  readonly model: string;
  private cfg: Required<
    Pick<
      OpenAICompatibleConfig,
      'timeoutMs' | 'maxRetries' | 'retryBaseDelayMs' | 'retryMaxDelayMs' | 'retryBudgetMs'
    >
  > &
    OpenAICompatibleConfig;
  private fetchFn: FetchLike;
  private clock: Clock;
  private random: () => number;
  private caps: Capabilities;
  private secrets: string[];
  private limits: { maxResponseBytes: number; maxStreamEvents: number; maxStreamMs: number };

  constructor(config: OpenAICompatibleConfig) {
    this.cfg = {
      ...config,
      timeoutMs: config.timeoutMs ?? 60_000,
      maxRetries: config.maxRetries ?? 3,
      retryBaseDelayMs: config.retryBaseDelayMs ?? 500,
      retryMaxDelayMs: config.retryMaxDelayMs ?? 30_000,
      retryBudgetMs: config.retryBudgetMs ?? 60_000,
    };
    this.id = config.id ?? 'openai-compatible';
    this.model = config.model;
    this.fetchFn = config.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.clock = config.clock ?? systemClock;
    this.random = config.random ?? Math.random;
    this.secrets = config.apiKey ? [config.apiKey] : [];
    this.limits = {
      maxResponseBytes: config.limits?.maxResponseBytes ?? 16 * 1024 * 1024,
      maxStreamEvents: config.limits?.maxStreamEvents ?? 200_000,
      maxStreamMs: config.limits?.maxStreamMs ?? 600_000,
    };
    const caps = unknownCapabilities();
    const d = config.declare ?? {};
    for (const k of ['tools', 'streaming', 'jsonMode', 'parallelToolCalls'] as const) {
      if (d[k] !== undefined) caps[k] = { value: d[k]!, source: 'declared' };
    }
    if (d.maxContext !== undefined) caps.maxContext = { value: d.maxContext, source: 'declared' };
    this.caps = caps;
  }

  capabilities(): Capabilities {
    return this.caps;
  }
  updateCapabilities(patch: Partial<Capabilities>): void {
    this.caps = { ...this.caps, ...patch };
  }

  private url(path: string): string {
    return `${this.cfg.baseURL.replace(/\/+$/, '')}${path}`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      ...this.cfg.headers,
    };
    if (this.cfg.apiKey) h.authorization = `Bearer ${this.cfg.apiKey}`;
    return h;
  }

  private err(init: ConstructorParameters<typeof LLMError>[0]): LLMError {
    return new LLMError({ provider: this.id, secrets: this.secrets, ...init });
  }

  private async readLimited(res: Response, max: number): Promise<string> {
    if (!res.body) return '';
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let text = '';
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > max) {
        await reader.cancel().catch(() => undefined);
        throw this.err({ kind: 'invalid_response', message: `response larger than ${max} bytes` });
      }
      text += dec.decode(value, { stream: true });
    }
    return text + dec.decode();
  }

  /**
   * One HTTP exchange with retries: 429, 5xx and network errors are retried with exponential backoff
   * and full jitter, honoring Retry-After, within a retry budget; other errors are returned at once.
   */
  private async send(
    path: string,
    method: 'GET' | 'POST',
    body: string | undefined,
    o: { signal?: AbortSignal; timeoutMs?: number; stream: boolean },
  ): Promise<Sent> {
    const timeoutMs = o.timeoutMs ?? this.cfg.timeoutMs;
    let spent = 0;
    for (let attempt = 0; ; attempt++) {
      if (o.signal?.aborted) throw cancelled(this.id);
      const controller = new AbortController();
      const onAbort = (): void => controller.abort(o.signal?.reason);
      o.signal?.addEventListener('abort', onAbort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        o.signal?.removeEventListener('abort', onAbort);
      };
      let failure: MappedError | undefined;
      try {
        const res = await this.fetchFn(this.url(path), {
          method,
          headers: this.headers(),
          body,
          signal: controller.signal,
        });
        if (res.ok) {
          if (o.stream) clearTimeout(timer);
          return { res, controller, timer: o.stream ? undefined : timer, done: cleanup };
        }
        const text = await this.readLimited(res, 64 * 1024).catch(() => '');
        failure = mapHttpError(
          res.status,
          text,
          res.headers,
          this.clock.now(),
          this.id,
          this.secrets,
        );
        const rl = parseRateLimit(res.headers);
        if (rl) Object.assign(failure.error, { rateLimit: rl });
      } catch (e) {
        if (e instanceof LLMError) {
          cleanup();
          throw e;
        }
        if (o.signal?.aborted) {
          cleanup();
          throw cancelled(this.id);
        }
        if (timedOut) {
          cleanup();
          throw this.err({ kind: 'timeout', message: `no complete answer within ${timeoutMs} ms` });
        }
        const name = (e as { name?: string })?.name;
        if (name === 'SafeFetchError') {
          cleanup();
          throw this.err({
            kind: 'bad_request',
            message: `request refused by the URL policy: ${(e as Error).message}`,
          });
        }
        failure = {
          error: this.err({
            kind: 'network',
            message: `network error: ${(e as Error)?.message ?? 'unknown'}`,
          }),
          noRetry: false,
        };
      }
      cleanup();
      const { error, noRetry } = failure;
      if (!error.retriable || error.kind === 'timeout' || noRetry || attempt >= this.cfg.maxRetries)
        throw error;
      const backoff =
        Math.min(this.cfg.retryMaxDelayMs, this.cfg.retryBaseDelayMs * 2 ** attempt) *
        this.random();
      const delay = Math.max(error.retryAfterMs ?? 0, backoff);
      if (spent + delay > this.cfg.retryBudgetMs) throw error;
      spent += delay;
      try {
        await this.clock.sleep(delay, o.signal);
      } catch {
        throw cancelled(this.id);
      }
    }
  }

  private requestBody(req: ChatRequest, stream: boolean): string {
    const body: Json = { model: this.model, messages: toWireMessages(req.messages) };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      if (req.toolChoice !== undefined) {
        body.tool_choice =
          typeof req.toolChoice === 'string'
            ? req.toolChoice
            : { type: 'function', function: { name: req.toolChoice.name } };
      }
    }
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.jsonMode) body.response_format = { type: 'json_object' };
    if (stream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }
    return JSON.stringify(body);
  }

  private estimateUsage(req: ChatRequest, content: string | null, calls: ToolCall[]): Usage {
    const prompt = estimateTokens(JSON.stringify(req.messages) + JSON.stringify(req.tools ?? []));
    const completion = estimateTokens(
      (content ?? '') + calls.map((c) => c.name + c.rawArguments).join(''),
    );
    return {
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: prompt + completion,
      source: 'estimated',
    };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const sent = await this.send('/chat/completions', 'POST', this.requestBody(req, false), {
      signal: req.signal,
      timeoutMs: req.timeoutMs,
      stream: false,
    });
    let text: string;
    try {
      text = await this.readLimited(sent.res, this.limits.maxResponseBytes);
    } catch (e) {
      if (e instanceof LLMError) throw e;
      if (req.signal?.aborted) throw cancelled(this.id);
      if (sent.controller.signal.aborted) {
        throw this.err({
          kind: 'timeout',
          message: `no complete answer within ${req.timeoutMs ?? this.cfg.timeoutMs} ms`,
        });
      }
      throw this.err({
        kind: 'network',
        message: `network error while reading the response: ${(e as Error).message}`,
      });
    } finally {
      sent.done();
    }
    let j: unknown;
    try {
      j = JSON.parse(text);
    } catch {
      throw this.err({ kind: 'invalid_response', message: 'the response is not valid JSON' });
    }
    return this.parseChat(j, req, parseRateLimit(sent.res.headers));
  }

  private parseChat(
    j: unknown,
    req: ChatRequest,
    rateLimit: RateLimitInfo | undefined,
  ): ChatResult {
    if (!isObj(j))
      throw this.err({ kind: 'invalid_response', message: 'the response is not a JSON object' });
    if (isObj(j.error) && !Array.isArray(j.choices)) {
      throw this.err({
        kind: 'invalid_response',
        message: `the server returned an error object: ${String(j.error.message ?? '').slice(0, 200)}`,
      });
    }
    const choice = Array.isArray(j.choices) ? j.choices[0] : undefined;
    if (!isObj(choice) || !isObj(choice.message)) {
      throw this.err({
        kind: 'invalid_response',
        message: 'the response has no choices[0].message',
      });
    }
    const quirks = new Set<string>();
    const msg = choice.message;
    let content = partsToText(msg.content);
    if (Array.isArray(msg.content)) quirks.add('content_as_parts');
    let rawCalls: unknown[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (rawCalls.length === 0 && isObj(msg.function_call)) {
      rawCalls = [msg.function_call];
      quirks.add('legacy_function_call');
    }
    let toolCalls = normalizeToolCalls(rawCalls, quirks, this.id);
    if (toolCalls.length === 0 && content && req.tools?.length) {
      const fromText = extractTextToolCalls(content, new Set(req.tools.map((t) => t.name)));
      if (fromText) {
        toolCalls = fromText;
        content = null;
        quirks.add('text_tool_call');
      }
    }
    if (choice.finish_reason === 'tool_calls' && toolCalls.length === 0) {
      throw this.err({
        kind: 'invalid_response',
        message: 'finish_reason is tool_calls but no tool call could be read',
      });
    }
    const usageSrc = j.usage;
    const usage = normalizeUsage(usageSrc, () => this.estimateUsage(req, content, toolCalls));
    if (usage.source === 'estimated') quirks.add('usage_estimated');
    return {
      content: content === '' && toolCalls.length > 0 ? null : content,
      toolCalls,
      finishReason: mapFinish(choice.finish_reason, toolCalls.length > 0, quirks),
      usage,
      model: typeof j.model === 'string' ? j.model : undefined,
      provider: this.id,
      quirks: quirks.size ? [...quirks] : undefined,
      rateLimit,
    };
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    let sawContent = false;
    try {
      const sent = await this.send('/chat/completions', 'POST', this.requestBody(req, true), {
        signal: req.signal,
        timeoutMs: req.timeoutMs,
        stream: true,
      });
      const rateLimit = parseRateLimit(sent.res.headers);
      const idleMs = this.cfg.streamIdleTimeoutMs ?? req.timeoutMs ?? this.cfg.timeoutMs;
      const started = this.clock.now();
      let idle: NodeJS.Timeout | undefined;
      let idleFired = false;
      const arm = (): void => {
        clearTimeout(idle);
        idle = setTimeout(() => {
          idleFired = true;
          sent.controller.abort();
        }, idleMs);
      };
      const quirks = new Set<string>();
      let text = '';
      const calls = new Map<
        number,
        { id: string; name: string; args: string; started: boolean; argsObject?: boolean }
      >();
      let finish: unknown;
      let usageRaw: unknown;
      let model: string | undefined;
      let doneMarker = false;
      let lastIndex = -1;
      const fail = (kind: LLMErrorKind, message: string, status?: number): LLMError =>
        this.err({ kind, message, status, midStream: sawContent });

      try {
        arm();
        const body = sent.res.body;
        if (!body) throw fail('invalid_response', 'the response has no body');
        for await (const msg of parseSse(body, {
          maxBytes: this.limits.maxResponseBytes,
          maxEvents: this.limits.maxStreamEvents,
        })) {
          arm();
          if (this.clock.now() - started > this.limits.maxStreamMs)
            throw fail('timeout', `stream longer than ${this.limits.maxStreamMs} ms`);
          if (msg.data === '[DONE]') {
            doneMarker = true;
            break;
          }
          let chunk: unknown;
          try {
            chunk = JSON.parse(msg.data);
          } catch {
            throw fail('invalid_response', 'a stream chunk is not valid JSON');
          }
          if (!isObj(chunk)) throw fail('invalid_response', 'a stream chunk is not a JSON object');
          if (isObj(chunk.error)) {
            const f = errorFields(JSON.stringify(chunk));
            const k: LLMErrorKind = /rate|quota/i.test(`${f.code} ${f.type}`)
              ? 'rate_limited'
              : CONTEXT_RE.test(f.message)
                ? 'context_length'
                : 'server_error';
            throw fail(k, `error inside the stream: ${(f.message || f.code).slice(0, 200)}`);
          }
          if (typeof chunk.model === 'string') model = chunk.model;
          if (chunk.usage !== undefined && chunk.usage !== null) usageRaw = chunk.usage;
          const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
          if (!isObj(choice)) continue;
          if (choice.finish_reason !== undefined && choice.finish_reason !== null)
            finish = choice.finish_reason;
          const delta = isObj(choice.delta) ? choice.delta : {};
          const piece = partsToText(delta.content);
          if (piece) {
            sawContent = true;
            text += piece;
            yield { type: 'text_delta', text: piece };
          }
          const rawCalls: unknown[] = Array.isArray(delta.tool_calls)
            ? delta.tool_calls
            : isObj(delta.function_call)
              ? [delta.function_call]
              : [];
          for (const tc of rawCalls) {
            if (!isObj(tc)) throw fail('invalid_response', 'a streamed tool call is not an object');
            const fn = isObj(tc.function) ? tc.function : tc;
            let index: number;
            if (typeof tc.index === 'number') index = tc.index;
            else {
              // no index (some servers): a new id starts a new call, otherwise continue the last one
              quirks.add('tool_call_index_missing');
              const byId =
                typeof tc.id === 'string'
                  ? [...calls].find(([, c]) => c.id === tc.id)?.[0]
                  : undefined;
              // a new id, or a name arriving after the last call already had one, starts a new call
              const startsNew =
                (typeof tc.id === 'string' && tc.id !== '') ||
                (typeof fn.name === 'string' && fn.name !== '' && !!calls.get(lastIndex)?.name);
              index = byId ?? (startsNew ? lastIndex + 1 : Math.max(lastIndex, 0));
            }
            lastIndex = Math.max(lastIndex, index);
            let c = calls.get(index);
            if (!c) {
              c = {
                id: typeof tc.id === 'string' ? tc.id : '',
                name: '',
                args: '',
                started: false,
              };
              calls.set(index, c);
            }
            if (!c.id && typeof tc.id === 'string') c.id = tc.id;
            if (typeof fn.name === 'string' && fn.name !== '' && !c.name) c.name = fn.name;
            if (c.name && !c.started) {
              if (!c.id) {
                c.id = `call_${index + 1}`;
                quirks.add('tool_call_id_generated');
              }
              c.started = true;
              sawContent = true;
              yield { type: 'tool_call_start', index, id: c.id, name: c.name };
            }
            const a = fn.arguments;
            if (typeof a === 'string' && a !== '') {
              c.args += a;
              yield { type: 'tool_call_delta', index, argumentsDelta: a };
            } else if (isObj(a)) {
              quirks.add('arguments_as_object');
              c.args = JSON.stringify(a);
              yield { type: 'tool_call_delta', index, argumentsDelta: c.args };
            }
          }
        }
      } catch (e) {
        clearTimeout(idle);
        sent.done();
        if (e instanceof LLMError) throw e;
        if (req.signal?.aborted) throw cancelled(this.id);
        if (idleFired) throw fail('timeout', `no data for ${idleMs} ms`);
        if (e instanceof SseLimitError)
          throw fail('invalid_response', `stream limit exceeded (${e.limit})`);
        throw fail('network', `the stream was interrupted: ${(e as Error).message}`);
      }
      clearTimeout(idle);
      sent.done();

      if (!doneMarker) {
        if (finish === undefined) {
          throw sawContent
            ? fail('network', 'the stream ended without finishing')
            : fail('invalid_response', 'the stream ended before any content');
        }
        quirks.add('stream_ended_without_done');
      }
      const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0]);
      const toolCalls: ToolCall[] = [];
      for (const [index, c] of ordered) {
        if (!c.name) throw fail('invalid_response', 'a streamed tool call has no function name');
        yield { type: 'tool_call_end', index };
        toolCalls.push({ id: c.id, name: c.name, ...normalizeArguments(c.args, quirks) });
      }
      if (new Set(toolCalls.map((c) => c.id)).size !== toolCalls.length)
        throw fail('invalid_response', 'two streamed tool calls share an id');
      let content: string | null = text === '' ? null : text;
      if (toolCalls.length === 0 && content && req.tools?.length) {
        const fromText = extractTextToolCalls(content, new Set(req.tools.map((t) => t.name)));
        if (fromText) {
          toolCalls.push(...fromText);
          content = null;
          quirks.add('text_tool_call');
        }
      }
      if (finish === 'tool_calls' && toolCalls.length === 0)
        throw fail('invalid_response', 'finish_reason is tool_calls but no tool call arrived');
      const usage = normalizeUsage(usageRaw, () => this.estimateUsage(req, content, toolCalls));
      if (usage.source === 'estimated') quirks.add('usage_estimated');
      yield { type: 'usage', usage };
      yield {
        type: 'done',
        result: {
          content,
          toolCalls,
          finishReason: mapFinish(finish, toolCalls.length > 0, quirks),
          usage,
          model,
          provider: this.id,
          quirks: quirks.size ? [...quirks] : undefined,
          rateLimit,
        },
      };
    } catch (e) {
      const err =
        e instanceof LLMError
          ? e
          : this.err({
              kind: 'network',
              message: (e as Error)?.message ?? 'unknown error',
              midStream: sawContent,
            });
      yield { type: 'error', error: err };
    }
  }

  /** GET /models, if the endpoint supports it. */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const sent = await this.send('/models', 'GET', undefined, { signal, stream: false });
    let text: string;
    try {
      text = await this.readLimited(sent.res, this.limits.maxResponseBytes);
    } finally {
      sent.done();
    }
    let j: unknown;
    try {
      j = JSON.parse(text);
    } catch {
      throw this.err({
        kind: 'invalid_response',
        message: 'the models response is not valid JSON',
      });
    }
    const list = isObj(j)
      ? Array.isArray(j.data)
        ? j.data
        : Array.isArray(j.models)
          ? j.models
          : null
      : Array.isArray(j)
        ? j
        : null;
    if (!list)
      throw this.err({ kind: 'invalid_response', message: 'the models response has no list' });
    const ids = list
      .map((m) =>
        typeof m === 'string'
          ? m
          : isObj(m)
            ? typeof m.id === 'string'
              ? m.id
              : typeof m.name === 'string'
                ? m.name
                : ''
            : '',
      )
      .filter((s) => s !== '');
    return ids;
  }
}
