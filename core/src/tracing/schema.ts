import { z } from 'zod';

const Usage = z.object({
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
  source: z.enum(['provider', 'estimated']),
});

const ToolCallTrace = z.object({
  callId: z.string(),
  name: z.string(),
  startedAt: z.string(),
  argumentsHash: z.string(),
  argumentsBytes: z.number(),
  latencyMs: z.number(),
  outcome: z.enum([
    'ok',
    'error',
    'timeout',
    'denied',
    'unknown_tool',
    'invalid_arguments',
    'invalid_arguments_failed',
    'cancelled',
  ]),
  repair: z.boolean(),
  truncated: z.boolean(),
  resultBytes: z.number(),
  resultHash: z.string(),
  abandoned: z.boolean().optional(),
  approval: z.enum(['not_required', 'granted', 'denied', 'no_approver', 'hook_failed']),
  arguments: z.unknown().optional(),
  result: z.string().optional(),
});

const ModelCallTrace = z.object({
  provider: z.string(),
  model: z.string(),
  startedAt: z.string(),
  latencyMs: z.number(),
  usage: Usage.nullable(),
  finishReason: z.enum(['stop', 'tool_calls', 'length', 'content_filter', 'other']).nullable(),
  routing: z
    .object({
      provider: z.string(),
      skipped: z.array(z.object({ provider: z.string(), reason: z.string() })),
    })
    .optional(),
  quirks: z.array(z.string()).optional(),
  error: z
    .object({ kind: z.string(), message: z.string(), retryAfterMs: z.number().optional() })
    .optional(),
});

export const RunTraceSchema = z.object({
  runId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  stopReason: z.enum([
    'final_answer',
    'step_limit',
    'token_budget',
    'wall_clock',
    'cancelled',
    'provider_error',
    'tool_failure',
    'capability_unsupported',
  ]),
  steps: z.array(
    z.object({ index: z.number(), model: ModelCallTrace, toolCalls: z.array(ToolCallTrace) }),
  ),
  totals: z.object({
    steps: z.number(),
    modelCalls: z.number(),
    toolCalls: z.number(),
    toolErrors: z.number(),
    repairs: z.number(),
    failures: z.number(),
    truncations: z.number(),
    promptTokens: z.number(),
    completionTokens: z.number(),
    totalTokens: z.number(),
    tokensEstimated: z.boolean(),
    wallMs: z.number(),
  }),
  debug: z.boolean(),
});

/** One line of the JSONL file. */
export const TraceLineSchema = z.object({
  v: z.literal(1),
  kind: z.literal('agent-run'),
  exportedAt: z.string(),
  trace: RunTraceSchema,
});
export type TraceLine = z.infer<typeof TraceLineSchema>;
