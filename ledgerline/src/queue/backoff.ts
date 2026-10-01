export interface BackoffPolicy {
  baseMs: number;
  factor: number;
  capMs: number;
}

export const defaultBackoff: BackoffPolicy = { baseMs: 1000, factor: 2, capMs: 60_000 };

/**
 * Delay before retrying after attempt number `attempt` failed (1-based): exponential, capped,
 * with "equal jitter" (half fixed, half random) so retries of many jobs spread out.
 * random() must return a number in [0, 1); it is injectable for tests.
 */
export function retryDelayMs(
  attempt: number,
  policy: BackoffPolicy,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(policy.capMs, policy.baseMs * policy.factor ** (attempt - 1));
  return Math.floor(exponential / 2 + random() * (exponential / 2));
}
