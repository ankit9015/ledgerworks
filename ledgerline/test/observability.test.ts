import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { debitCredits } from '../src/credits.js';
import { metricsUrlFrom, workerUrlFrom } from '../src/db/config.js';
import { buildMetricsServer } from '../src/observability/metrics-server.js';
import { poolQueueStats, setQueueStatsProvider } from '../src/observability/metrics.js';
import { initTracing, instrumentDb } from '../src/observability/tracing.js';
import { systemClock } from '../src/queue/clock.js';
import { enqueueJob } from '../src/queue/queue.js';
import { Worker } from '../src/queue/worker.js';
import { adminPool, appPool, testAdminUrl } from './helpers.js';

const TOKEN = 'obs-admin-token';
const exporter = new InMemorySpanExporter();
let admin: pg.Pool;
let app: pg.Pool;
let metricsDb: pg.Pool;
let workerDb: pg.Pool;
let api: ReturnType<typeof buildApp>;
let metrics: ReturnType<typeof buildMetricsServer>;
let tracing: { shutdown: () => Promise<void> };

interface Tenant {
  id: string;
  key: string;
}
async function newTenant(): Promise<Tenant> {
  const res = await api.inject({
    method: 'POST',
    url: '/v1/tenants',
    headers: { 'x-admin-token': TOKEN },
    payload: { name: 'obs', ownerEmail: `${Math.random().toString(36).slice(2)}@obs.test` },
  });
  expect(res.statusCode).toBe(201);
  return { id: res.json().tenant.id, key: res.json().apiKey.key };
}
const scrape = async (): Promise<string> => (await metrics.inject({ url: '/metrics' })).body;

beforeAll(async () => {
  tracing = initTracing({ serviceName: 'ledgerline-test', exporter });
  admin = adminPool();
  app = appPool();
  metricsDb = new pg.Pool({ connectionString: metricsUrlFrom(testAdminUrl()), max: 2 });
  workerDb = new pg.Pool({
    connectionString: workerUrlFrom(testAdminUrl()),
    max: 4,
  });
  setQueueStatsProvider(poolQueueStats(metricsDb));
  api = buildApp({ db: instrumentDb(app), tenantCreationToken: TOKEN });
  await api.ready();
  metrics = buildMetricsServer();
  await metrics.ready();
});
afterAll(async () => {
  setQueueStatsProvider(undefined);
  await api.close();
  await metrics.close();
  await tracing.shutdown();
  await Promise.all([admin.end(), app.end(), metricsDb.end(), workerDb.end()]);
});

describe('/metrics is not part of the public API surface', () => {
  it('is not served on the API app, whatever the path or method', async () => {
    for (const url of ['/metrics', '/metrics/', '/v1/metrics', '/METRICS']) {
      const res = await api.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.body).not.toMatch(/ledgerline_|# HELP/);
    }
  });

  it('is served by the separate metrics server, which serves nothing else', async () => {
    const ok = await metrics.inject({ url: '/metrics' });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toMatch(/text\/plain/);
    expect(ok.body).toMatch(/# HELP ledgerline_http_request_duration_seconds/);
    for (const url of ['/', '/health', '/v1/credits/balance', '/v1/usage']) {
      expect((await metrics.inject({ url })).statusCode, url).toBe(404);
    }
  });

  it('can require a bearer token', async () => {
    const guarded = buildMetricsServer({ token: 's3cret-metrics-token' });
    expect((await guarded.inject({ url: '/metrics' })).statusCode).toBe(401);
    expect(
      (await guarded.inject({ url: '/metrics', headers: { authorization: 'Bearer wrong' } }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await guarded.inject({
          url: '/metrics',
          headers: { authorization: 'Bearer s3cret-metrics-token' },
        })
      ).statusCode,
    ).toBe(200);
    await guarded.close();
  });

  it('the metrics server listens on its own port, not the API port', async () => {
    const m = buildMetricsServer();
    const a = buildApp({ db: app });
    await m.listen({ port: 0, host: '127.0.0.1' });
    await a.listen({ port: 0, host: '127.0.0.1' });
    const mPort = (m.server.address() as { port: number }).port;
    const aPort = (a.server.address() as { port: number }).port;
    expect(mPort).not.toBe(aPort);
    expect((await fetch(`http://127.0.0.1:${mPort}/metrics`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${aPort}/metrics`)).status).toBe(404);
    await m.close();
    await a.close();
  });
});

describe('metrics content and label hygiene', () => {
  it('records requests, debits and queue state, and no label holds a tenant id, API key or SQL text', async () => {
    const a = await newTenant();
    const b = await newTenant();
    // Requests: success, 401, validation error, an unknown route containing identifiers.
    await api.inject({ url: '/v1/credits/balance', headers: { authorization: `Bearer ${a.key}` } });
    await api.inject({ url: '/v1/credits/balance', headers: { authorization: 'Bearer nope' } });
    await api.inject({
      method: 'POST',
      url: '/v1/usage-events',
      headers: { authorization: `Bearer ${a.key}` },
      payload: { eventType: '', quantity: 1 },
    });
    await api.inject({ url: `/v1/tenants/${a.id}/secret/${a.key}` });
    // Debit outcomes.
    await admin.query(`UPDATE credit_balances SET balance = 10 WHERE tenant_id = $1`, [a.id]);
    await admin.query(
      `INSERT INTO credit_ledger (tenant_id, amount, kind, balance_after) VALUES ($1, 10, 'grant', 10)`,
      [a.id],
    );
    await debitCredits(app, a.id, 4, 'k1'); // accepted
    await debitCredits(app, a.id, 4, 'k1'); // replayed
    await debitCredits(app, a.id, 100, 'k2'); // rejected
    // Queue state, including a job with an error message and a payload that must not leak.
    const { jobId } = await enqueueJob(
      app,
      b.id,
      systemClock,
      'obs.test',
      { secret: 'payload-secret-value' },
      { queue: 'obsq', maxAttempts: 1 },
    );
    const w = new Worker({
      id: 'obs-w',
      claimDb: workerDb,
      appDb: app,
      clock: systemClock,
      queue: 'obsq',
      leaseMs: 1000,
      handlers: {
        'obs.test': async () => {
          throw new Error(`failure for tenant ${b.id} with key ${b.key} SELECT * FROM jobs`);
        },
      },
    });
    expect(await w.runOnce()).toBe(true);

    const text = await scrape();
    const series = text.split('\n').filter((l) => l && !l.startsWith('#'));

    expect(text).toMatch(/ledgerline_http_requests_in_flight 0/);
    expect(text).toMatch(
      /ledgerline_http_request_duration_seconds_count\{route="\/v1\/credits\/balance",method="GET",status="200"\} 1/,
    );
    expect(text).toMatch(/route="\/v1\/credits\/balance",method="GET",status="401"/);
    expect(text).toMatch(/route="\/v1\/usage-events",method="POST",status="400"/);
    expect(text).toMatch(/route="unmatched",method="GET",status="404"/);
    expect(text).toMatch(/ledgerline_credit_debits_total\{outcome="accepted"\} 1/);
    expect(text).toMatch(/ledgerline_credit_debits_total\{outcome="replayed"\} 1/);
    expect(text).toMatch(/ledgerline_credit_debits_total\{outcome="rejected"\} 1/);
    expect(text).toMatch(/ledgerline_queue_jobs\{queue="obsq",state="dead"\} 1/);
    expect(text).toMatch(/ledgerline_queue_oldest_runnable_job_age_seconds\{queue="obsq"\} 0/);
    expect(text).toMatch(/ledgerline_worker_job_events_total\{event="dead"\} 1/);

    // Hygiene: nothing identifying or SQL-like appears anywhere in the exposition.
    for (const secret of [a.id, b.id, a.key, b.key, jobId, 'payload-secret-value']) {
      expect(text, `must not contain ${secret.slice(0, 8)}...`).not.toContain(secret);
    }
    expect(text).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/);
    expect(text).not.toMatch(/\blk_[0-9a-f]{8}_/);
    expect(text).not.toMatch(/\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)\b/);
    // Label values are drawn from small sets; bound the total.
    expect(series.length).toBeLessThan(400);
    console.log(`METRIC SERIES after this test's traffic: ${series.length}`);
  });
});

describe('metrics role is read-only and narrow', () => {
  it('may call queue_stats and read statistics, but read no table and the app role cannot call queue_stats', async () => {
    const stats = await metricsDb.query('SELECT * FROM ledgerline_fn.queue_stats()');
    expect(Object.keys(stats.rows[0] ?? { queue: 1, status: 1, jobs: 1 })).not.toContain(
      'tenant_id',
    );
    await expect(metricsDb.query('SELECT 1 FROM jobs')).rejects.toMatchObject({ code: '42501' });
    await expect(metricsDb.query('SELECT 1 FROM credit_ledger')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(metricsDb.query('DELETE FROM usage_events')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(app.query('SELECT * FROM ledgerline_fn.queue_stats()')).rejects.toMatchObject({
      code: '42501',
    });
    const r = await metricsDb.query(`SELECT count(*)::int AS n FROM pg_stat_database`);
    expect(r.rows[0].n).toBeGreaterThanOrEqual(0);
  });
});

describe('traces', () => {
  it('an HTTP request produces a server span with child database spans, without keys, tenant ids or SQL', async () => {
    const t = await newTenant();
    exporter.reset();
    const res = await api.inject({
      url: '/v1/credits/balance',
      headers: { authorization: `Bearer ${t.key}` },
    });
    expect(res.statusCode).toBe(200);
    const spans = exporter.getFinishedSpans();
    const server = spans.find((s) => s.name === 'GET /v1/credits/balance');
    expect(server, 'server span').toBeTruthy();
    expect(server!.attributes['http.route']).toBe('/v1/credits/balance');
    expect(server!.attributes['http.response.status_code']).toBe(200);
    const db = spans.filter((s) => s.name.startsWith('db '));
    expect(db.map((s) => s.attributes['db.operation.name'])).toEqual(
      expect.arrayContaining(['SELECT', 'BEGIN', 'COMMIT']),
    );
    for (const s of db) {
      expect(s.spanContext().traceId).toBe(server!.spanContext().traceId);
    }
    const dump = JSON.stringify(spans.map((s) => ({ n: s.name, a: s.attributes })));
    expect(dump).not.toContain(t.key);
    expect(dump).not.toContain(t.id);
    expect(dump).not.toMatch(/credit_balances|authenticate_api_key|set_config/);
  });

  it('a queue worker emits claim, handler and ack spans with the job id and attempt', async () => {
    const t = await newTenant();
    const { jobId } = await enqueueJob(
      app,
      t.id,
      systemClock,
      'trace.ok',
      { x: 1 },
      { queue: 'traceq' },
    );
    exporter.reset();
    const w = new Worker({
      id: 'trace-w',
      claimDb: workerDb,
      appDb: app,
      clock: systemClock,
      queue: 'traceq',
      leaseMs: 1000,
      handlers: { 'trace.ok': async () => {} },
    });
    expect(await w.runOnce()).toBe(true);
    const spans = exporter.getFinishedSpans();
    for (const name of ['queue.claim', 'queue.handler', 'queue.ack']) {
      const s = spans.find((x) => x.name === name && x.attributes['job.id'] === jobId);
      expect(s, name).toBeTruthy();
      expect(s!.attributes['job.attempt']).toBe(1);
    }
    const dump = JSON.stringify(spans.map((s) => s.attributes));
    expect(dump).not.toContain(t.key);
    expect(dump).not.toContain(t.id);
    expect(dump).not.toContain('"x":1');
  });
});
