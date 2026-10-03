import type { z } from 'zod';
import type { LLMErrorKind } from '../llm/errors.js';
import type {
  Clock,
  FinishReason,
  LLMProvider,
  Message,
  ProviderRouting,
  Usage,
} from '../llm/types.js';

export interface ToolContext {
  /** aborted when the run is cancelled, its time is up, or this tool call times out */
  signal: AbortSignal;
  callId: string;
}

/**
 * A tool the model may call. Arguments are validated against `parameters` (zod) BEFORE `execute`
 * runs; `execute` only ever sees validated data. What `execute` returns is sent to the model as data.
 */
export interface AgentTool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  parameters: S;
  execute(args: z.infer<S>, ctx: ToolContext): unknown;
  /** the loop asks the approval callback before running it; without a callback it is denied */
  requiresApproval?: boolean;
  /** the tool changes state; propagated to the ToolDefinition (see ToolDefinition.changesState) */
  changesState?: boolean;
  /** overrides AgentOptions.toolTimeoutMs */
  timeoutMs?: number;
  /** overrides AgentOptions.maxToolResultBytes */
  maxResultBytes?: number;
}

export interface ApprovalRequest {
  tool: string;
  /** the validated arguments the tool would run with */
  arguments: unknown;
  callId: string;
  step: number;
}
export type ApprovalDecision = boolean | { approved: boolean; reason?: string };

export type StopReason =
  | 'final_answer'
  | 'step_limit'
  | 'token_budget'
  | 'wall_clock'
  | 'cancelled'
  /** the provider failed (after the adapter's own retries); `error` has the typed kind */
  | 'provider_error'
  /** a tool call failed for good and onToolFailure is 'stop' */
  | 'tool_failure'
  /** tools were offered but the model is known not to support them */
  | 'capability_unsupported';

export interface AgentOptions {
  provider: LLMProvider;
  /** system prompt (yours). Tool results are never merged into it. */
  system?: string;
  /** the conversation so far (user and assistant turns); a plain string becomes one user message */
  prompt: string | Message[];
  tools?: AgentTool[];
  /** most model calls in one run. Default 10. */
  maxSteps?: number;
  /** stop once the provider-reported (or estimated) total tokens reach this. Default: none. */
  tokenBudget?: number;
  /** wall-clock limit for the whole run, ms. Default: none. */
  wallClockMs?: number;
  signal?: AbortSignal;
  /** tool calls of one step that run at the same time. Default 4. */
  toolConcurrency?: number;
  /** per tool call, ms. Default 30,000. */
  toolTimeoutMs?: number;
  /** longer results are cut and marked "[truncated: N bytes omitted]". Default 16,384 bytes. */
  maxToolResultBytes?: number;
  /** after a call failed for good (invalid arguments twice): 'continue' tells the model and goes on; 'stop' ends the run. Default 'continue'. */
  onToolFailure?: 'continue' | 'stop';
  approve?: (req: ApprovalRequest) => Promise<ApprovalDecision> | ApprovalDecision;
  /** include tool arguments and results (redacted) in the trace. Default false: hashes and sizes only. */
  debug?: boolean;
  /** per model call, ms */
  modelTimeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
  /** exact strings to scrub from the trace and from error messages (for example the API key) */
  secrets?: string[];
  conversationId?: string;
  /** append a fixed note to the system prompt saying tool results are data. Default true. */
  injectionNote?: boolean;
  clock?: Clock;
  /** randomness for the data delimiters; injectable for tests */
  random?: () => number;
}

export type ToolOutcome =
  | 'ok'
  | 'error'
  | 'timeout'
  | 'denied'
  | 'unknown_tool'
  /** first invalid attempt: the model was told and may retry once */
  | 'invalid_arguments'
  /** invalid again after the repair offer: a typed failure, the tool was not run */
  | 'invalid_arguments_failed'
  | 'cancelled';

export interface ToolCallTrace {
  callId: string;
  name: string;
  /** sha256 (first 16 hex characters) of the arguments exactly as the model sent them */
  argumentsHash: string;
  argumentsBytes: number;
  latencyMs: number;
  outcome: ToolOutcome;
  /** this call was valid after an earlier invalid one for the same tool (the single repair) */
  repair: boolean;
  truncated: boolean;
  resultBytes: number;
  resultHash: string;
  approval: 'not_required' | 'granted' | 'denied' | 'no_approver' | 'hook_failed';
  /** only with debug: redacted arguments and result text */
  arguments?: unknown;
  result?: string;
}

export interface ModelCallTrace {
  provider: string;
  model: string;
  latencyMs: number;
  usage: Usage | null;
  finishReason: FinishReason | null;
  /** which provider handled the call and why others were skipped (fallback chains) */
  routing?: ProviderRouting;
  quirks?: string[];
  error?: { kind: LLMErrorKind; message: string; retryAfterMs?: number };
}

export interface StepTrace {
  index: number;
  model: ModelCallTrace;
  toolCalls: ToolCallTrace[];
}

export interface RunTotals {
  steps: number;
  modelCalls: number;
  toolCalls: number;
  /** tool calls whose outcome was not 'ok' */
  toolErrors: number;
  /** invalid calls that were valid after the one repair attempt */
  repairs: number;
  /** invalid calls that stayed invalid after the repair attempt */
  failures: number;
  truncations: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** true when any of the token numbers is our estimate rather than the provider's */
  tokensEstimated: boolean;
  wallMs: number;
}

/** The record of a run. It never holds a key; arguments and results appear only as hashes and sizes unless `debug` was set. */
export interface RunTrace {
  runId: string;
  startedAt: string;
  finishedAt: string;
  stopReason: StopReason;
  steps: StepTrace[];
  totals: RunTotals;
  debug: boolean;
}

export interface RunResult {
  stopReason: StopReason;
  /** the model's final text when stopReason is 'final_answer' */
  finalAnswer: string | null;
  /** set for provider_error and capability_unsupported */
  error?: { kind: LLMErrorKind | 'capability_unsupported'; message: string; retryAfterMs?: number };
  /** the whole conversation, including assistant turns and the (delimited) tool results */
  messages: Message[];
  trace: RunTrace;
}
