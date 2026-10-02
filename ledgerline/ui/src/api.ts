/**
 * Typed access to the Ledgerline API. The API key is a function argument supplied by the caller
 * (held in React state, in memory only): this module never reads or writes localStorage,
 * sessionStorage, cookies or the URL.
 */

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
  get unauthorized(): boolean {
    return this.status === 401;
  }
}

export interface UsageSummary {
  from: string;
  to: string;
  days: { day: string; events: number; quantity: number }[];
}
export interface Balance {
  balance: number;
  updatedAt: string | null;
}
export interface LedgerEntry {
  id: number;
  kind: string;
  amount: number;
  balanceAfter: number | null;
  reference: string | null;
  createdAt: string;
}
export interface LedgerPage {
  items: LedgerEntry[];
  nextCursor: string | null;
}
export interface QueueStats {
  counts: Record<'queued' | 'running' | 'failed' | 'succeeded' | 'dead', number>;
  oldestRunnableAgeSeconds: number | null;
  recentDeadLetters: {
    jobId: string;
    type: string;
    attempts: number;
    lastError: string | null;
    deadAt: string;
  }[];
}

export type Fetcher = typeof fetch;

export async function getJson<T>(
  path: string,
  apiKey: string,
  signal?: AbortSignal,
  fetcher: Fetcher = fetch,
): Promise<T> {
  const res = await fetcher(`/api${path}`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    signal,
    credentials: 'omit',
    cache: 'no-store',
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      // keep the generic message
    }
    throw new ApiRequestError(res.status, message);
  }
  return (await res.json()) as T;
}

export const rangeQuery = (days: number, now: Date = new Date()): string => {
  const to = new Date(now);
  const from = new Date(now.getTime() - days * 86400e3);
  return `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
};
