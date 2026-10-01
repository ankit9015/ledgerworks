import type pg from 'pg';
import { withTenant, type Db } from '../db/tenant.js';
import { defaultBackoff, retryDelayMs, type BackoffPolicy } from './backoff.js';
import type { Clock } from './clock.js';
import { claimJobs, completeJob, failJob, type ClaimedJob } from './queue.js';

export interface JobContext {
  /** Run database work for this job inside a transaction with the job's tenant set. */
  withTenant<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T>;
}

export type Handler = (job: ClaimedJob, ctx: JobContext) => Promise<void>;

/** Thrown by a handler to simulate a worker that dies without acknowledging the job. */
export class AbandonJob extends Error {
  constructor() {
    super('worker abandoned the job');
    this.name = 'AbandonJob';
  }
}

export type WorkerEvent =
  | { kind: 'claimed'; workerId: string; job: ClaimedJob; at: Date }
  | { kind: 'completed'; workerId: string; job: ClaimedJob; accepted: boolean }
  | { kind: 'failed'; workerId: string; job: ClaimedJob; outcome: string; error: string }
  | { kind: 'abandoned'; workerId: string; job: ClaimedJob };

export interface WorkerOptions {
  id: string;
  /** Connected as the worker role: may only claim. */
  claimDb: Db;
  /** Connected as the app role: handler work and acknowledgements, always tenant-scoped. */
  appDb: Db;
  clock: Clock;
  handlers: Record<string, Handler>;
  queue?: string;
  leaseMs: number;
  backoff?: BackoffPolicy;
  random?: () => number;
  onEvent?: (e: WorkerEvent) => void;
}

/**
 * One worker. Delivery is at-least-once: a handler may run again after its lease expires if the
 * worker never acknowledges (see migration 0004). Handlers should be idempotent.
 */
export class Worker {
  constructor(private readonly o: WorkerOptions) {}

  /** Claims and processes at most one job. Returns false when nothing was claimable. */
  async runOnce(): Promise<boolean> {
    const [job] = await claimJobs(this.o.claimDb, this.o.clock, this.o.id, {
      queue: this.o.queue,
      limit: 1,
      leaseMs: this.o.leaseMs,
    });
    if (!job) return false;
    this.o.onEvent?.({ kind: 'claimed', workerId: this.o.id, job, at: this.o.clock.now() });

    const handler = this.o.handlers[job.type];
    try {
      if (!handler) throw new Error(`no handler registered for job type "${job.type}"`);
      await handler(job, {
        withTenant: (fn) => withTenant(this.o.appDb, job.tenantId, fn),
      });
    } catch (err) {
      if (err instanceof AbandonJob) {
        this.o.onEvent?.({ kind: 'abandoned', workerId: this.o.id, job });
        return true;
      }
      const message = err instanceof Error ? err.message : String(err);
      const delay = retryDelayMs(
        job.attemptNo,
        this.o.backoff ?? defaultBackoff,
        this.o.random ?? Math.random,
      );
      const outcome = await failJob(this.o.appDb, this.o.clock, job, this.o.id, message, delay);
      this.o.onEvent?.({ kind: 'failed', workerId: this.o.id, job, outcome, error: message });
      return true;
    }
    const accepted = await completeJob(this.o.appDb, this.o.clock, job, this.o.id);
    this.o.onEvent?.({ kind: 'completed', workerId: this.o.id, job, accepted });
    return true;
  }

  /** Processes jobs until nothing is claimable. */
  async runUntilIdle(): Promise<number> {
    let n = 0;
    while (await this.runOnce()) n++;
    return n;
  }
}
