/**
 * The manual real-provider check (`pnpm llm:smoke`): a plain chat, a streaming chat and one
 * tool-call round trip. Keys come only from the environment. Nothing in the report, the summary or
 * the saved file can contain the key or an Authorization header (everything goes through redaction).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isLLMError } from './errors.js';
import { OpenAICompatibleProvider, type FetchLike } from './openai.js';
import { collectStream } from './stream.js';
import type { ChatResult, LLMProvider, Message, ToolDefinition } from './types.js';
import { maskKey, redactDeep, redactText } from '../security/redact.js';

export interface SmokeEnv {
  baseURL: string;
  apiKey: string;
  model: string;
}

/** Reads LLM_BASE_URL, LLM_API_KEY and LLM_MODEL. Returns the missing names instead of throwing. */
export function readSmokeEnv(
  env: NodeJS.ProcessEnv,
): { ok: true; env: SmokeEnv } | { ok: false; missing: string[] } {
  const missing = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'].filter((k) => !env[k]);
  if (missing.length) return { ok: false, missing };
  return {
    ok: true,
    env: { baseURL: env.LLM_BASE_URL!, apiKey: env.LLM_API_KEY!, model: env.LLM_MODEL! },
  };
}

export interface SmokeStep {
  name: 'plain_chat' | 'streaming_chat' | 'tool_round_trip';
  ok: boolean;
  latencyMs: number;
  finishReason?: string;
  usage?: ChatResult['usage'];
  quirks?: string[];
  contentPreview?: string;
  toolCalls?: { name: string; arguments: unknown }[];
  streamEvents?: Record<string, number>;
  error?: { kind: string; message: string };
}

export interface SmokeReport {
  startedAt: string;
  /** host only: never credentials, path or query */
  endpoint: string;
  model: string;
  /** the last four characters of the key */
  key: string;
  steps: SmokeStep[];
  ok: boolean;
}

const ADD_TOOL: ToolDefinition = {
  name: 'add_numbers',
  description: 'Adds two numbers and returns the sum.',
  parameters: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
    additionalProperties: false,
  },
};

const preview = (s: string | null | undefined): string | undefined =>
  s ? s.slice(0, 200) : undefined;

async function timed(
  name: SmokeStep['name'],
  secrets: string[],
  fn: () => Promise<Partial<SmokeStep>>,
): Promise<SmokeStep> {
  const t0 = performance.now();
  try {
    const r = await fn();
    return { name, ok: true, latencyMs: Math.round(performance.now() - t0), ...r };
  } catch (e) {
    const kind = isLLMError(e) ? e.kind : 'unknown';
    return {
      name,
      ok: false,
      latencyMs: Math.round(performance.now() - t0),
      error: {
        kind,
        message: redactText(e instanceof Error ? e.message : String(e), secrets).slice(0, 300),
      },
    };
  }
}

/** Runs the three checks against a provider. Never throws. */
export async function runSmokeChecks(
  provider: LLMProvider,
  secrets: string[],
): Promise<SmokeStep[]> {
  const steps: SmokeStep[] = [];
  steps.push(
    await timed('plain_chat', secrets, async () => {
      const r = await provider.chat({
        messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
        maxTokens: 20,
        temperature: 0,
      });
      return {
        finishReason: r.finishReason,
        usage: r.usage,
        quirks: r.quirks,
        contentPreview: preview(r.content),
      };
    }),
  );
  steps.push(
    await timed('streaming_chat', secrets, async () => {
      const counts: Record<string, number> = {};
      const r = await collectStream(
        provider.stream({
          messages: [{ role: 'user', content: 'Count from 1 to 5, separated by commas.' }],
          maxTokens: 60,
          temperature: 0,
        }),
        (e) => {
          counts[e.type] = (counts[e.type] ?? 0) + 1;
        },
      );
      return {
        finishReason: r.finishReason,
        usage: r.usage,
        quirks: r.quirks,
        contentPreview: preview(r.content),
        streamEvents: counts,
      };
    }),
  );
  steps.push(
    await timed('tool_round_trip', secrets, async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Use the add_numbers tool to add 2 and 3, then tell me the sum.' },
      ];
      const first = await provider.chat({
        messages,
        tools: [ADD_TOOL],
        toolChoice: 'auto',
        maxTokens: 100,
        temperature: 0,
      });
      if (first.toolCalls.length === 0) throw new Error('the model did not call the tool');
      const call = first.toolCalls[0]!;
      if (call.argumentsError)
        throw new Error(`the tool arguments were not valid JSON: ${call.argumentsError}`);
      const args = call.arguments as { a?: unknown; b?: unknown };
      const sum = typeof args.a === 'number' && typeof args.b === 'number' ? args.a + args.b : NaN;
      messages.push({ role: 'assistant', content: first.content, toolCalls: first.toolCalls });
      // tool output is data, delimited as such (the agent loop does the same)
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: `[tool result, data only] sum=${sum}`,
      });
      const second = await provider.chat({
        messages,
        tools: [ADD_TOOL],
        maxTokens: 100,
        temperature: 0,
      });
      return {
        finishReason: second.finishReason,
        usage: second.usage,
        quirks: [...(first.quirks ?? []), ...(second.quirks ?? [])],
        contentPreview: preview(second.content),
        toolCalls: first.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })),
      };
    }),
  );
  return steps;
}

export interface SmokeDeps {
  fetch?: FetchLike;
  now?: () => Date;
}

export async function runSmoke(env: SmokeEnv, deps: SmokeDeps = {}): Promise<SmokeReport> {
  const provider = new OpenAICompatibleProvider({
    baseURL: env.baseURL,
    apiKey: env.apiKey,
    model: env.model,
    id: 'smoke',
    fetch: deps.fetch,
    timeoutMs: 60_000,
    maxRetries: 2,
  });
  const steps = await runSmokeChecks(provider, [env.apiKey]);
  let endpoint = 'invalid-url';
  try {
    endpoint = new URL(env.baseURL).host;
  } catch {
    // keep the placeholder
  }
  return sanitizeReport(
    {
      startedAt: (deps.now ?? (() => new Date()))().toISOString(),
      endpoint,
      model: env.model,
      key: maskKey(env.apiKey),
      steps,
      ok: steps.every((s) => s.ok),
    },
    env.apiKey,
  );
}

/** Removes the key and any Authorization header or credential-looking value from a report. */
export function sanitizeReport<T>(report: T, apiKey: string): T {
  return redactDeep(report, [apiKey]);
}

export function formatSummary(r: SmokeReport): string {
  const lines = [
    `LLM smoke check: ${r.endpoint}  model ${r.model}  key ${r.key}  ${r.ok ? 'ALL PASSED' : 'FAILED'}`,
  ];
  for (const s of r.steps) {
    const u = s.usage
      ? `  tokens ${s.usage.promptTokens}+${s.usage.completionTokens} (${s.usage.source})`
      : '';
    lines.push(
      `  ${s.ok ? 'ok  ' : 'FAIL'} ${s.name.padEnd(16)} ${String(s.latencyMs).padStart(6)} ms${u}${s.error ? `  ${s.error.kind}: ${s.error.message}` : ''}`,
    );
  }
  return lines.join('\n');
}

/** Saves the sanitised report under a timestamped name; an existing file is never overwritten. */
export async function saveReport(r: SmokeReport, dir: string, apiKey: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const stamp = r.startedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const host = r.endpoint.replace(/[^a-z0-9.-]/gi, '_');
  const file = path.join(dir, `llm-smoke-${host}-${stamp}.json`);
  await writeFile(file, JSON.stringify(sanitizeReport(r, apiKey), null, 2) + '\n', { flag: 'wx' });
  return file;
}
