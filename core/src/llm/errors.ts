import { redactText } from '../security/redact.js';

export type LLMErrorKind =
  | 'rate_limited'
  | 'auth_failed'
  | 'timeout'
  | 'network'
  | 'bad_request'
  | 'server_error'
  | 'invalid_response'
  | 'context_length'
  | 'content_filtered'
  | 'cancelled';

export interface LLMErrorCause {
  provider: string;
  kind: LLMErrorKind | 'circuit_open' | 'quota_exhausted';
  message: string;
}

export interface LLMErrorInit {
  kind: LLMErrorKind;
  message: string;
  provider?: string;
  /** HTTP status, when there was one */
  status?: number;
  /** for rate_limited: how long the server asked us to wait, when known */
  retryAfterMs?: number;
  /** true once content had already been delivered (streams): the call was not retried */
  midStream?: boolean;
  /** set by a fallback chain that tried several providers: one entry per provider */
  causes?: LLMErrorCause[];
  /** secrets to scrub from the message in addition to the credential patterns */
  secrets?: readonly (string | undefined)[];
}

/**
 * The typed error of the LLM layer. The message is scrubbed of credentials and capped in length;
 * an error never carries a request body, headers or a response body.
 */
export class LLMError extends Error {
  readonly kind: LLMErrorKind;
  readonly provider: string | undefined;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly midStream: boolean;
  readonly causes: LLMErrorCause[] | undefined;

  constructor(init: LLMErrorInit) {
    super(redactText(init.message, init.secrets ?? []).slice(0, 500));
    this.name = 'LLMError';
    this.kind = init.kind;
    this.provider = init.provider;
    this.status = init.status;
    this.retryAfterMs = init.retryAfterMs;
    this.midStream = init.midStream ?? false;
    this.causes = init.causes;
  }

  /** whether trying the same call again later can help, in general */
  get retriable(): boolean {
    return (
      this.kind === 'rate_limited' ||
      this.kind === 'server_error' ||
      this.kind === 'network' ||
      this.kind === 'timeout'
    );
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      kind: this.kind,
      message: this.message,
      provider: this.provider,
      status: this.status,
      retryAfterMs: this.retryAfterMs,
      midStream: this.midStream,
      causes: this.causes,
    };
  }
}

export const isLLMError = (e: unknown): e is LLMError => e instanceof LLMError;

export function cancelled(provider?: string): LLMError {
  return new LLMError({ kind: 'cancelled', message: 'the call was cancelled', provider });
}

/** Wraps anything thrown into an LLMError (never leaks the original message unredacted). */
export function toLLMError(
  e: unknown,
  provider?: string,
  secrets?: readonly (string | undefined)[],
): LLMError {
  if (e instanceof LLMError) return e;
  const err = e as { name?: string; message?: string };
  if (err?.name === 'AbortError') return cancelled(provider);
  return new LLMError({
    kind: 'network',
    message: err?.message ?? 'unknown error',
    provider,
    secrets,
  });
}
