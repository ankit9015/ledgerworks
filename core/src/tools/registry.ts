import { z } from 'zod';
import type { AgentTool } from '../agent/types.js';
import { truncateResult } from '../agent/loop.js';
import type { ConnectionFactory } from '../db/cancellable.js';
import { redactText } from '../security/redact.js';
import { sanitizeText } from './untrusted.js';

/** Names are lowercase snake_case, 2 to 64 characters: safe in prompts, logs, file names and MCP. */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

export interface ToolAnnotations {
  /** the tool never changes anything */
  readOnly: boolean;
  /** the tool writes, runs DDL, or has effects outside the process */
  changesState: boolean;
  /** a human must approve each call */
  requiresApproval: boolean;
  /** calling it twice with the same input has the same effect as once */
  idempotent: boolean;
}

/** Runs `fn` inside a tracing span (C2.9 plugs in OpenTelemetry; the default just runs it). */
export type SpanRunner = <T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: () => Promise<T>,
) => Promise<T>;
export const noSpans: SpanRunner = (_n, _a, fn) => fn();

export interface ToolHandlerContext {
  /** fires on timeout or cancellation; the tool must stop (see the cancellation contract in core/README.md) */
  signal: AbortSignal;
  /** opens a connection to the tool's data source (read-only for the Postgres tools) */
  connect: ConnectionFactory;
  callId: string;
  span: SpanRunner;
}

/** Thrown by a handler for an expected failure: it reaches the model as a typed error, not a crash. */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

/**
 * One tool, defined once. `input` is the only schema source: it validates arguments and produces
 * the JSON Schema that models (agent loop) and MCP clients both see.
 */
export interface ToolSpec<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: S;
  /** optional schema of the structured result; when given, a handler result that does not match is an error */
  output?: z.ZodType;
  annotations: ToolAnnotations;
  /** default 15,000 ms */
  timeoutMs?: number;
  /** default 65,536 bytes of JSON text */
  maxResultBytes?: number;
  /**
   * Required (non-empty) to register a tool that changes state WITHOUT requiring approval. A written
   * reason in code, visible in review; there is no other way around the rule.
   */
  allowChangesStateWithoutApproval?: string;
  handler(input: z.infer<S>, ctx: ToolHandlerContext): Promise<unknown> | unknown;
}

export const defineToolSpec = <S extends z.ZodType>(spec: ToolSpec<S>): ToolSpec =>
  spec as unknown as ToolSpec;

/** The JSON Schema of a tool's input: THE one both the agent loop and MCP use. */
export function inputJsonSchema(spec: ToolSpec): Record<string, unknown> {
  const schema = z.toJSONSchema(spec.input) as Record<string, unknown>;
  delete schema.$schema;
  if (schema.type === undefined) schema.type = 'object';
  return schema;
}
export function outputJsonSchema(spec: ToolSpec): Record<string, unknown> | undefined {
  if (!spec.output) return undefined;
  const schema = z.toJSONSchema(spec.output) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

export interface ToolResult {
  ok: boolean;
  /** structured data (ok) */
  data?: unknown;
  error?: { code: string; message: string };
  /** JSON text of {ok, data|error}, cut at the tool's size limit with an explicit marker */
  text: string;
  /** size of the full JSON before any cut */
  bytes: number;
  truncated: boolean;
}

export class ToolRegistry {
  private tools = new Map<string, ToolSpec>();

  register(spec: ToolSpec): this {
    if (!TOOL_NAME_PATTERN.test(spec.name)) {
      throw new Error(
        `invalid tool name "${spec.name.slice(0, 80)}": use lowercase letters, digits and underscores, starting with a letter (2 to 64 characters)`,
      );
    }
    if (this.tools.has(spec.name)) throw new Error(`duplicate tool name "${spec.name}"`);
    if (!spec.description || spec.description.trim().length < 10)
      throw new Error(`tool "${spec.name}" needs a description of at least 10 characters`);
    const a = spec.annotations;
    if (a.readOnly && a.changesState)
      throw new Error(`tool "${spec.name}" cannot be both readOnly and changesState`);
    if (
      a.changesState &&
      !a.requiresApproval &&
      !(
        spec.allowChangesStateWithoutApproval &&
        spec.allowChangesStateWithoutApproval.trim().length >= 10
      )
    ) {
      throw new Error(
        `tool "${spec.name}" changes state but does not require approval: set requiresApproval, or give allowChangesStateWithoutApproval a reason of at least 10 characters`,
      );
    }
    if (spec.timeoutMs !== undefined && (!(spec.timeoutMs > 0) || spec.timeoutMs > 600_000))
      throw new Error(`tool "${spec.name}": timeoutMs must be between 1 and 600000`);
    if (
      spec.maxResultBytes !== undefined &&
      (!(spec.maxResultBytes >= 256) || spec.maxResultBytes > 4 * 1024 * 1024)
    )
      throw new Error(`tool "${spec.name}": maxResultBytes must be between 256 and 4194304`);
    // the schema must be convertible and describe an object: fail at registration, not at the first call
    const schema = inputJsonSchema(spec);
    if (schema.type !== 'object')
      throw new Error(`tool "${spec.name}": the input schema must describe an object`);
    this.tools.set(spec.name, spec);
    return this;
  }

  registerAll(specs: ToolSpec[]): this {
    for (const s of specs) this.register(s);
    return this;
  }
  get(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }
  list(): ToolSpec[] {
    return [...this.tools.values()];
  }

  /**
   * Runs one tool call: validates the input, runs the handler under its timeout, validates the
   * output, and returns typed data or a typed error with the size handled. Never throws.
   */
  async run(
    name: string,
    rawInput: unknown,
    ctx: Omit<ToolHandlerContext, 'signal'> & { signal?: AbortSignal },
  ): Promise<ToolResult> {
    const spec = this.tools.get(name);
    if (!spec)
      return this.finish(undefined, {
        ok: false,
        error: { code: 'unknown_tool', message: `unknown tool "${sanitizeText(name, 64)}"` },
      });
    if (ctx.signal?.aborted)
      return this.finish(spec, {
        ok: false,
        error: { code: 'cancelled', message: 'the call was cancelled' },
      });
    const parsed = spec.input.safeParse(rawInput ?? {});
    if (!parsed.success) {
      const msg = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.length ? i.path.join('.') : '(arguments)'}: ${i.message}`)
        .join('; ');
      return this.finish(spec, {
        ok: false,
        error: { code: 'invalid_arguments', message: msg.slice(0, 500) },
      });
    }
    const ac = new AbortController();
    const onOuter = (): void => ac.abort();
    if (ctx.signal?.aborted) ac.abort();
    else ctx.signal?.addEventListener('abort', onOuter, { once: true });
    const timeoutMs = spec.timeoutMs ?? 15_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      const work = Promise.resolve().then(() =>
        spec.handler(parsed.data, { ...ctx, signal: ac.signal, span: ctx.span ?? noSpans }),
      );
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
          ac.abort();
          resolve('timeout');
        }, timeoutMs);
      });
      const winner = await Promise.race([work, timeout]);
      if (winner === 'timeout') {
        // the handler was told to stop; wait briefly for it to do so (cancellation contract)
        await Promise.race([
          work.then(
            () => undefined,
            () => undefined,
          ),
          new Promise((r) => setTimeout(r, 2000).unref?.()),
        ]);
        return this.finish(spec, {
          ok: false,
          error: { code: 'timeout', message: `the tool did not finish within ${timeoutMs} ms` },
        });
      }
      if (spec.output) {
        const v = spec.output.safeParse(winner);
        if (!v.success)
          return this.finish(spec, {
            ok: false,
            error: {
              code: 'invalid_output',
              message: 'the tool produced a result that does not match its output schema',
            },
          });
      }
      return this.finish(spec, { ok: true, data: winner });
    } catch (e) {
      if (e instanceof ToolError)
        return this.finish(spec, {
          ok: false,
          error: { code: e.code, message: sanitizeText(redactText(e.message), 500) },
        });
      if ((e as { name?: string })?.name === 'AbortError')
        return this.finish(spec, {
          ok: false,
          error: { code: 'cancelled', message: 'the call was cancelled' },
        });
      // anything else is a bug or an unexpected failure: say so without leaking internals
      return this.finish(spec, {
        ok: false,
        error: {
          code: 'internal_error',
          message: sanitizeText(redactText(e instanceof Error ? e.message : String(e)), 200),
        },
      });
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onOuter);
    }
  }

  private finish(
    spec: ToolSpec | undefined,
    r: { ok: boolean; data?: unknown; error?: { code: string; message: string } },
  ): ToolResult {
    const full = JSON.stringify(r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error });
    const max = spec?.maxResultBytes ?? 65_536;
    const cut = truncateResult(full, max);
    return {
      ok: r.ok,
      data: r.data,
      error: r.error,
      text: cut.text,
      bytes: Buffer.byteLength(full),
      truncated: cut.truncated,
    };
  }

  /** The tools as agent-loop tools. The loop wraps each result as delimited data (agent/loop.ts). */
  toAgentTools(base: { connect: ConnectionFactory; span?: SpanRunner }): AgentTool[] {
    return this.list().map((spec): AgentTool => ({
      name: spec.name,
      description: spec.description,
      parameters: spec.input,
      requiresApproval: spec.annotations.requiresApproval,
      changesState: spec.annotations.changesState,
      timeoutMs: spec.timeoutMs,
      maxResultBytes: spec.maxResultBytes,
      execute: async (args, { signal, callId }) =>
        (
          await this.run(spec.name, args, {
            connect: base.connect,
            span: base.span ?? noSpans,
            callId,
            signal,
          })
        ).text,
    }));
  }

  /**
   * The tools that may be exposed over MCP. Tools that change state are NOT exposed unless
   * `allowChangesState` is passed explicitly (and the MCP server then also needs an approval handler);
   * the skipped names are returned so the caller can say so.
   */
  forMcp(o: { allowChangesState?: boolean } = {}): { tools: ToolSpec[]; skipped: string[] } {
    const tools: ToolSpec[] = [];
    const skipped: string[] = [];
    for (const t of this.list()) {
      if (t.annotations.changesState && o.allowChangesState !== true) skipped.push(t.name);
      else tools.push(t);
    }
    return { tools, skipped };
  }
}
