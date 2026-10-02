import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics. Label policy (tested): labels only ever hold values from small fixed sets
 * (route pattern, HTTP method, status code, outcome names, queue name, job state). Never a tenant id,
 * an API key, a request path with ids, an error message or SQL text.
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'ledgerline_process_' });

export const httpDuration = new Histogram({
  name: 'ledgerline_http_request_duration_seconds',
  help: 'HTTP request duration by route pattern, method and status code',
  labelNames: ['route', 'method', 'status'] as const,
  buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const httpInFlight = new Gauge({
  name: 'ledgerline_http_requests_in_flight',
  help: 'HTTP requests currently being handled',
  registers: [registry],
});

export const debitOutcomes = new Counter({
  name: 'ledgerline_credit_debits_total',
  help: 'Credit debit attempts by outcome: accepted, rejected (insufficient credits), conflict (idempotency key reused for something else), replayed (idempotent repeat)',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const partitionsCreated = new Counter({
  name: 'ledgerline_partitions_created_total',
  help: 'usage_events partitions created by the automatic maintenance',
  registers: [registry],
});

export const partitionRuns = new Counter({
  name: 'ledgerline_partition_maintenance_runs_total',
  help: 'Partition maintenance runs by result',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const workerEvents = new Counter({
  name: 'ledgerline_worker_job_events_total',
  help: 'Queue worker events in this process: claimed, completed, retried, dead, abandoned, stale',
  labelNames: ['event'] as const,
  registers: [registry],
});

// --- queue state, read from the database at scrape time (cross-tenant aggregates only) ---------
export interface QueueStatRow {
  queue: string;
  status: string;
  jobs: number;
  oldestRunnableAt: Date | null;
  retriedAttempts: number;
}
type QueueStatsProvider = () => Promise<QueueStatRow[]>;
let queueStats: QueueStatsProvider | undefined;
export function setQueueStatsProvider(p: QueueStatsProvider | undefined): void {
  queueStats = p;
}

const STATES = ['queued', 'running', 'failed', 'succeeded', 'dead'];
async function statsOnce(): Promise<QueueStatRow[]> {
  return queueStats ? queueStats() : [];
}

new Gauge({
  name: 'ledgerline_queue_jobs',
  help: 'Jobs by queue and state',
  labelNames: ['queue', 'state'] as const,
  registers: [registry],
  async collect() {
    this.reset();
    const rows = await statsOnce();
    for (const q of new Set(rows.map((r) => r.queue))) {
      for (const state of STATES) {
        const row = rows.find((r) => r.queue === q && r.status === state);
        this.set({ queue: q, state }, row?.jobs ?? 0);
      }
    }
  },
});
new Gauge({
  name: 'ledgerline_queue_oldest_runnable_job_age_seconds',
  help: 'Age of the oldest job waiting to run (queued or failed with run_at in the past); 0 when none',
  labelNames: ['queue'] as const,
  registers: [registry],
  async collect() {
    this.reset();
    const rows = await statsOnce();
    for (const q of new Set(rows.map((r) => r.queue))) {
      const oldest = rows
        .filter((r) => r.queue === q && r.oldestRunnableAt)
        .map((r) => r.oldestRunnableAt!.getTime())
        .sort((a, b) => a - b)[0];
      this.set({ queue: q }, oldest === undefined ? 0 : Math.max(0, (Date.now() - oldest) / 1000));
    }
  },
});
new Gauge({
  name: 'ledgerline_queue_retried_attempts',
  help: 'Cumulative attempts beyond the first, summed over all jobs (jobs are never deleted, so this only grows)',
  labelNames: ['queue'] as const,
  registers: [registry],
  async collect() {
    this.reset();
    const rows = await statsOnce();
    for (const q of new Set(rows.map((r) => r.queue))) {
      this.set(
        { queue: q },
        rows.filter((r) => r.queue === q).reduce((s, r) => s + r.retriedAttempts, 0),
      );
    }
  },
});

/** Reads the queue statistics through the narrow definer function as the read-only metrics role. */
export function poolQueueStats(db: Pick<pg.Pool, 'query'>): QueueStatsProvider {
  return async () => {
    const r = await db.query<{
      queue: string;
      status: string;
      jobs: string;
      oldest_runnable_at: Date | null;
      retried_attempts: string;
    }>('SELECT * FROM ledgerline_fn.queue_stats()');
    return r.rows.map((x) => ({
      queue: x.queue,
      status: x.status,
      jobs: Number(x.jobs),
      oldestRunnableAt: x.oldest_runnable_at,
      retriedAttempts: Number(x.retried_attempts),
    }));
  };
}

/** HTTP request metrics for a Fastify app (route pattern as label, never the raw URL). */
export function registerHttpMetrics(app: FastifyInstance): void {
  const open = new WeakSet<object>();
  const finish = (req: object): boolean => {
    if (!open.delete(req)) return false;
    httpInFlight.dec();
    return true;
  };
  app.addHook('onRequest', async (req) => {
    open.add(req);
    httpInFlight.inc();
  });
  app.addHook('onResponse', async (req, reply) => {
    finish(req);
    httpDuration.observe(
      {
        route: req.routeOptions?.url ?? 'unmatched',
        method: req.method,
        status: String(reply.statusCode),
      },
      reply.elapsedTime / 1000,
    );
  });
  // A connection that dies mid-request may never reach onResponse; keep the gauge honest.
  app.addHook('onRequestAbort', (req, done) => {
    finish(req);
    done();
  });
}
