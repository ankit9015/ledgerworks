/**
 * DEMO ONLY: produces queue traffic so the observability dashboard and the admin UI have something
 * to show. Enqueues jobs for the seeded sample tenants (.seed/keys.json) at a steady rate and runs a
 * few workers with a mix of outcomes (succeed, fail once then succeed, always fail and dead-letter),
 * (including debits of the seeded tenants' credit balances: re-seed to reset them) with its own /metrics (default 127.0.0.1:9465) and traces. It writes ordinary jobs through the same
 * functions the product uses; it is not part of the API.
 *
 *   pnpm --filter @ledgerworks/ledgerline demo:queue [seconds, default 120] [jobs per second, default 20]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { adminUrl, appUrlFrom, metricsUrl, workerUrlFrom } from '../db/config.js';
import { buildMetricsServer } from '../observability/metrics-server.js';
import { poolQueueStats, setQueueStatsProvider } from '../observability/metrics.js';
import { initTracing } from '../observability/tracing.js';
import { debitIn } from '../credits.js';
import { systemClock } from './clock.js';
import { enqueueJob } from './queue.js';
import { Worker, type Handler } from './worker.js';

const SECONDS = Number(process.argv[2] ?? 120);
const RATE = Number(process.argv[3] ?? 20);
const WORKERS = 8;

const keys = JSON.parse(readFileSync(path.resolve('../.seed/keys.json'), 'utf8')) as {
  tenants: { size: string; tenantId: string }[];
};
const tenants = keys.tenants.map((t) => t.tenantId);

const tracing = initTracing({
  serviceName: 'ledgerline-worker',
  endpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
});
const app = new pg.Pool({ connectionString: appUrlFrom(adminUrl()), max: 12 });
const claim = new pg.Pool({ connectionString: workerUrlFrom(adminUrl()), max: 12 });
const metricsDb = new pg.Pool({ connectionString: metricsUrl(), max: 2 });
setQueueStatsProvider(poolQueueStats(metricsDb));
const metricsServer = buildMetricsServer({ token: process.env.METRICS_TOKEN });
await metricsServer.listen({
  port: Number(process.env.WORKER_METRICS_PORT ?? 9465),
  host: process.env.METRICS_HOST ?? '127.0.0.1',
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const handlers: Record<string, Handler> = {
  'demo.noop': async () => {
    await sleep(5 + Math.random() * 30);
  },
  'demo.flaky': async (job) => {
    await sleep(10);
    if (job.attemptNo === 1) throw new Error('first attempt fails');
  },
  // Debits 1 credit of the tenant the job belongs to. Some jobs repeat an earlier key (an idempotent
  // replay) and some ask for far more than the balance (rejected), so all outcomes show up.
  'demo.debit': async (job, ctx) => {
    const n = (job.payload as { n: number }).n;
    const key = n % 10 === 0 ? 'demo-replay-key' : `demo-${job.id}`;
    const amount = n % 7 === 0 ? 1_000_000_000 : 1;
    await ctx.withTenant((c) => debitIn(c, amount, key, 'demo'));
  },
  'demo.doomed': async () => {
    await sleep(10);
    throw new Error('always fails');
  },
};

const stopAt = Date.now() + SECONDS * 1000;
let enqueued = 0;
const producer = (async () => {
  while (Date.now() < stopAt) {
    const n = Math.random();
    const type =
      n < 0.65 ? 'demo.noop' : n < 0.8 ? 'demo.debit' : n < 0.95 ? 'demo.flaky' : 'demo.doomed';
    await enqueueJob(
      app,
      tenants[enqueued % tenants.length]!,
      systemClock,
      type,
      { n: enqueued },
      {
        queue: 'demo',
        maxAttempts: 3,
      },
    );
    enqueued++;
    await sleep(1000 / RATE);
  }
})();
const workers = Array.from({ length: WORKERS }, async (_, i) => {
  const w = new Worker({
    id: `demo-worker-${i}`,
    claimDb: claim,
    appDb: app,
    clock: systemClock,
    handlers,
    queue: 'demo',
    leaseMs: 30_000,
    backoff: { baseMs: 500, factor: 2, capMs: 4000 },
  });
  while (Date.now() < stopAt + 15_000) {
    if (!(await w.runOnce())) await sleep(100);
  }
});
await Promise.all([producer, ...workers]);
console.log(`demo queue done: ${enqueued} jobs enqueued over ${SECONDS}s`);
await metricsServer.close();
await tracing.shutdown();
await Promise.all([app.end(), claim.end(), metricsDb.end()]);
