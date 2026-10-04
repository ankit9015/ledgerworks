import { randomUUID } from 'node:crypto';
import type { RunTrace } from '../agent/types.js';
import { redactText } from '../security/redact.js';
import { prepareForExport, type TraceSink } from './sinks.js';

export interface LangfuseConfig {
  /** e.g. https://cloud.langfuse.com or your own host. Operator configuration, never user input. */
  host: string;
  publicKey: string;
  secretKey: string;
  /** one HTTP request, ms. Default 1,500. */
  timeoutMs?: number;
  fetch?: typeof fetch;
  secrets?: readonly string[];
}

/**
 * Reads LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY. Returns null when they are not
 * all set (tracing to Langfuse is then simply off). The keys exist only in the environment.
 */
export function langfuseFromEnv(env: NodeJS.ProcessEnv = process.env): LangfuseSink | null {
  const {
    LANGFUSE_HOST: host,
    LANGFUSE_PUBLIC_KEY: publicKey,
    LANGFUSE_SECRET_KEY: secretKey,
  } = env;
  if (!host || !publicKey || !secretKey) return null;
  return new LangfuseSink({ host, publicKey, secretKey });
}

/**
 * Sends a finished run to Langfuse's HTTP ingestion API (POST /api/public/ingestion, basic auth with
 * the public and secret key): one trace, one generation per model call (model, token usage, timing)
 * and one span per tool call (name, outcome, hashes and sizes). Prompts, completions, tool arguments
 * and tool results are NOT sent (the same privacy rules as the other sinks). One bounded request; a
 * failure is reported to the emitter, which keeps it out of the run.
 */
export class LangfuseSink implements TraceSink {
  readonly name = 'langfuse';
  constructor(private c: LangfuseConfig) {}

  async write(runTrace: RunTrace): Promise<void> {
    const t = prepareForExport(runTrace, { includeDebugContent: false, secrets: this.c.secrets });
    const now = new Date().toISOString();
    const batch: unknown[] = [
      {
        id: randomUUID(),
        type: 'trace-create',
        timestamp: now,
        body: {
          id: t.runId,
          name: 'agent-run',
          timestamp: t.startedAt,
          metadata: { stopReason: t.stopReason, totals: t.totals },
        },
      },
    ];
    for (const step of t.steps) {
      const m = step.model;
      const mStart = new Date(m.startedAt);
      batch.push({
        id: randomUUID(),
        type: 'generation-create',
        timestamp: now,
        body: {
          id: `${t.runId}-g${step.index}`,
          traceId: t.runId,
          name: 'model-call',
          model: m.model,
          startTime: mStart.toISOString(),
          endTime: new Date(mStart.getTime() + m.latencyMs).toISOString(),
          usage: m.usage
            ? {
                input: m.usage.promptTokens,
                output: m.usage.completionTokens,
                total: m.usage.totalTokens,
                unit: 'TOKENS',
              }
            : undefined,
          level: m.error ? 'ERROR' : 'DEFAULT',
          statusMessage: m.error?.kind,
          metadata: {
            provider: m.provider,
            finishReason: m.finishReason,
            tokensEstimated: m.usage?.source === 'estimated',
            routing: m.routing,
          },
        },
      });
      for (const c of step.toolCalls) {
        const cStart = new Date(c.startedAt);
        batch.push({
          id: randomUUID(),
          type: 'span-create',
          timestamp: now,
          body: {
            id: `${t.runId}-t${c.callId}`,
            traceId: t.runId,
            parentObservationId: `${t.runId}-g${step.index}`,
            name: c.outcome === 'unknown_tool' ? 'tool:(unknown)' : `tool:${c.name.slice(0, 64)}`,
            startTime: cStart.toISOString(),
            endTime: new Date(cStart.getTime() + c.latencyMs).toISOString(),
            level: c.outcome === 'ok' ? 'DEFAULT' : 'WARNING',
            metadata: {
              outcome: c.outcome,
              repair: c.repair,
              truncated: c.truncated,
              argumentsHash: c.argumentsHash,
              resultHash: c.resultHash,
              resultBytes: c.resultBytes,
              approval: c.approval,
            },
          },
        });
      }
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.c.timeoutMs ?? 1500);
    try {
      const res = await (this.c.fetch ?? fetch)(
        `${this.c.host.replace(/\/+$/, '')}/api/public/ingestion`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Basic ${Buffer.from(`${this.c.publicKey}:${this.c.secretKey}`).toString('base64')}`,
          },
          body: JSON.stringify({ batch }),
          signal: ac.signal,
        },
      );
      if (!res.ok) throw new Error(`Langfuse answered HTTP ${res.status}`);
      // the ingestion API answers 207 with per-event results: report events it refused
      const body = (await res.json().catch(() => null)) as { errors?: unknown[] } | null;
      if (body?.errors?.length) throw new Error(`Langfuse refused ${body.errors.length} event(s)`);
    } catch (e) {
      const msg =
        e instanceof Error
          ? e.name === 'AbortError'
            ? `no answer within ${this.c.timeoutMs ?? 1500} ms`
            : e.message
          : String(e);
      throw new Error(
        redactText(msg, [this.c.publicKey, this.c.secretKey, ...(this.c.secrets ?? [])]),
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
