/**
 * Is jobs_runnable_idx used? (P1.12 cleanup b.) On a freshly created and migrated scratch database
 * (migrations up to the one that introduced the index being checked), run a mixed queue workload
 * (plain jobs, jobs that fail once, jobs that always fail and dead-letter, idempotent enqueues, a
 * crashed worker's expired leases), then print pg_stat_user_indexes for `jobs` and EXPLAIN of every
 * statement the job functions run against jobs. Synthetic data only.
 *
 *   pnpm --filter @ledgerworks/ledgerline exec tsx src/bench/job-index-usage.ts
 */
import pg from 'pg';
import { adminUrl, appUrlFrom, workerUrlFrom } from '../db/config.js';
import { migrate } from '../db/migrate.js';
import { enqueueJob } from '../queue/queue.js';
import { systemClock } from '../queue/clock.js';
import { drain } from '../queue/drain.js';
import { AbandonJob, type Handler } from '../queue/worker.js';

const DB = 'ledgerline_idxuse';
function withDb(url: string): string {
  const u = new URL(url);
  u.pathname = `/${DB}`;
  return u.toString();
}

async function main(): Promise<void> {
  const server = new pg.Client({ connectionString: adminUrl() });
  await server.connect();
  await server.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await server.query(`CREATE DATABASE ${DB}`);
  await server.end();
  const dbAdmin = withDb(adminUrl());
  await migrate(dbAdmin);
  const admin = new pg.Pool({ connectionString: dbAdmin, max: 2 });
  const app = new pg.Pool({ connectionString: appUrlFrom(dbAdmin), max: 20 });
  const workerDb = new pg.Pool({ connectionString: workerUrlFrom(dbAdmin), max: 20 });
  const tenants: string[] = [];
  for (let i = 0; i < 5; i++) {
    const t = await admin.query<{ id: string }>(
      `INSERT INTO tenants (name) VALUES ('u') RETURNING id`,
    );
    tenants.push(t.rows[0]!.id);
  }
  const N = 3000;
  for (let i = 0; i < N; i++) {
    const type = i % 10 === 0 ? 'flaky' : i % 25 === 0 ? 'doomed' : i % 40 === 0 ? 'crash' : 'noop';
    await enqueueJob(
      app,
      tenants[i % 5]!,
      systemClock,
      type,
      { n: i },
      {
        queue: 'idx',
        maxAttempts: type === 'doomed' ? 2 : 3,
        idempotencyKey: i % 7 === 0 ? `k${i}` : undefined,
      },
    );
  }
  // same keys again: exercises the idempotency lookup
  for (let i = 0; i < N; i += 7) {
    await enqueueJob(
      app,
      tenants[i % 5]!,
      systemClock,
      'noop',
      {},
      { queue: 'idx', idempotencyKey: `k${i}` },
    );
  }
  const seen = new Set<string>();
  const handlers: Record<string, Handler> = {
    noop: async () => {},
    flaky: async (job) => {
      if (job.attemptNo === 1) throw new Error('first attempt fails');
    },
    doomed: async () => {
      throw new Error('always fails');
    },
    crash: async (job) => {
      if (!seen.has(job.id)) {
        seen.add(job.id);
        throw new AbandonJob();
      }
    },
  };
  // short leases so abandoned jobs expire during the run; tiny backoff so retries happen
  const r = await drain({
    claimDb: workerDb,
    appDb: app,
    clock: systemClock,
    workers: 20,
    handlers,
    queue: 'idx',
    leaseMs: 200,
    backoff: { baseMs: 5, factor: 2, capMs: 40 },
  });
  await new Promise((res) => setTimeout(res, 400));
  const r2 = await drain({
    claimDb: workerDb,
    appDb: app,
    clock: systemClock,
    workers: 20,
    handlers,
    queue: 'idx',
    leaseMs: 200,
    backoff: { baseMs: 5, factor: 2, capMs: 40 },
  });
  console.log(`processed ${r.processed} + ${r2.processed} job runs`);
  const st = await admin.query(`SELECT status, count(*)::int AS n FROM jobs GROUP BY 1 ORDER BY 1`);
  console.log('final states:', JSON.stringify(st.rows));
  await admin.query('ANALYZE jobs');
  const idx = await admin.query(
    `SELECT indexrelname, idx_scan::int, idx_tup_read::int, pg_size_pretty(pg_relation_size(indexrelid)) AS size
     FROM pg_stat_user_indexes WHERE relname = 'jobs' ORDER BY indexrelname`,
  );
  console.log('--- pg_stat_user_indexes for jobs');
  for (const row of idx.rows) console.log(JSON.stringify(row));
  console.log('--- EXPLAIN of the statements the job functions run against jobs (rolled back)');
  const stmts: Record<string, string> = {
    'claim pick': `SELECT j.id FROM jobs j WHERE j.queue = 'idx' AND j.run_at <= now() AND j.status IN ('queued','failed','running') AND (j.status <> 'running' OR (j.lease_expires_at <= now() AND j.attempts < j.max_attempts)) ORDER BY j.run_at, j.id LIMIT 1 FOR UPDATE SKIP LOCKED`,
    'claim exhausted-lease check': `SELECT j.id FROM jobs j WHERE j.queue = 'idx' AND j.status = 'running' AND j.lease_expires_at <= now() AND j.attempts >= j.max_attempts FOR UPDATE SKIP LOCKED`,
    'claim update by id': `UPDATE jobs SET updated_at = now() WHERE id = ANY (ARRAY(SELECT id FROM jobs LIMIT 3))`,
    'complete_job update': `UPDATE jobs SET status = 'succeeded' WHERE id = (SELECT id FROM jobs LIMIT 1) AND tenant_id = '${tenants[0]}' AND status = 'running' AND locked_by = 'w' AND attempts = 1`,
    'fail_job select': `SELECT * FROM jobs j WHERE j.id = (SELECT id FROM jobs LIMIT 1) AND j.tenant_id = '${tenants[0]}' AND j.status = 'running' AND j.locked_by = 'w' AND j.attempts = 1 FOR UPDATE`,
    'enqueue idempotency lookup': `SELECT j.id FROM jobs j WHERE j.tenant_id = '${tenants[0]}' AND j.idempotency_key = 'k0'`,
    'per-tenant job listing': `SELECT * FROM jobs WHERE tenant_id = '${tenants[0]}' AND status = 'queued' ORDER BY run_at LIMIT 10`,
  };
  for (const [name, sql] of Object.entries(stmts)) {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      const p = await c.query(`EXPLAIN ${sql}`);
      console.log(`## ${name}`);
      for (const row of p.rows) console.log('  ' + row['QUERY PLAN']);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  }
  await admin.end();
  await app.end();
  await workerDb.end();
  const s2 = new pg.Client({ connectionString: adminUrl() });
  await s2.connect();
  await s2.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await s2.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
