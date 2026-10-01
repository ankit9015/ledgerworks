import type { Db } from '../db/tenant.js';
import type { BackoffPolicy } from './backoff.js';
import type { Clock } from './clock.js';
import { Worker, type Handler, type WorkerEvent } from './worker.js';

export interface DrainOptions {
  claimDb: Db;
  appDb: Db;
  clock: Clock;
  /** Number of concurrent workers (independent async loops, each claiming one job at a time). */
  workers: number;
  handlers: Record<string, Handler>;
  queue: string;
  leaseMs: number;
  backoff?: BackoffPolicy;
  random?: () => number;
  onEvent?: (e: WorkerEvent) => void;
}

/** Runs `workers` workers until none can claim anything. Returns jobs processed and wall time. */
export async function drain(o: DrainOptions): Promise<{ processed: number; ms: number }> {
  const started = performance.now();
  const counts = await Promise.all(
    Array.from({ length: o.workers }, (_, i) =>
      new Worker({
        id: `worker-${i}`,
        claimDb: o.claimDb,
        appDb: o.appDb,
        clock: o.clock,
        handlers: o.handlers,
        queue: o.queue,
        leaseMs: o.leaseMs,
        backoff: o.backoff,
        random: o.random,
        onEvent: o.onEvent,
      }).runUntilIdle(),
    ),
  );
  return { processed: counts.reduce((a, b) => a + b, 0), ms: performance.now() - started };
}
