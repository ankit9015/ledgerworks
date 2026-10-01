/**
 * Queue throughput: 10,000 no-op jobs drained by 50 workers, 3 runs, each on a freshly created
 * database (so earlier runs leave no dead tuples behind). Nothing is tuned.
 *
 *   pnpm --filter @ledgerworks/ledgerline bench:queue
 *
 * Uses the local Postgres from docker-compose (DATABASE_ADMIN_URL); creates and drops the
 * database `ledgerline_bench`. All data is synthetic.
 */
import pg from 'pg';
import { adminUrl, appUrlFrom, workerUrlFrom } from '../db/config.js';
import { migrate } from '../db/migrate.js';
import { systemClock } from '../queue/clock.js';
import { drain } from '../queue/drain.js';
import type { Handler } from '../queue/worker.js';

const DB = 'ledgerline_bench';
const JOBS = 10_000;
const WORKERS = 50;
const RUNS = 3;
const LEASE_MS = 60_000;

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

async function oneRun(run: number): Promise<number> {
  const server = new pg.Client({ connectionString: adminUrl() });
  await server.connect();
  await server.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await server.query(`CREATE DATABASE ${DB}`);
  await server.end();

  const dbAdmin = withDb(adminUrl(), DB);
  await migrate(dbAdmin);
  const admin = new pg.Pool({ connectionString: dbAdmin, max: 2 });
  const app = new pg.Pool({ connectionString: appUrlFrom(dbAdmin), max: 30 });
  const workerDb = new pg.Pool({ connectionString: workerUrlFrom(dbAdmin), max: 30 });
  try {
    const tenants: string[] = [];
    for (let i = 0; i < 5; i++) {
      const t = await admin.query<{ id: string }>(
        `INSERT INTO tenants (name) VALUES ('bench') RETURNING id`,
      );
      tenants.push(t.rows[0]!.id);
    }
    await admin.query(
      `INSERT INTO jobs (tenant_id, queue, type, payload, run_at)
       SELECT ($1::uuid[])[1 + (g % 5)], 'bench', 'noop', jsonb_build_object('n', g), $2::timestamptz
       FROM generate_series(0, $3::int - 1) g`,
      [tenants, new Date(), JOBS],
    );
    await admin.query('ANALYZE jobs');

    if (run === 1) {
      // The pick step of claim_jobs, planned against the full, untouched queue (rolled back).
      const c = await admin.connect();
      try {
        await c.query('BEGIN');
        const plan = await c.query(
          `EXPLAIN (ANALYZE, BUFFERS)
           SELECT j.id FROM jobs j
           WHERE j.queue = 'bench'
             AND ((j.status IN ('queued', 'failed') AND j.run_at <= now())
               OR (j.status = 'running' AND j.lease_expires_at <= now() AND j.attempts < j.max_attempts))
           ORDER BY j.run_at, j.id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        );
        console.log('--- EXPLAIN (ANALYZE, BUFFERS) of the claim pick, 10,000 queued jobs ---');
        for (const row of plan.rows) console.log(row['QUERY PLAN']);
        console.log('---');
        await c.query('ROLLBACK');
      } finally {
        c.release();
      }
    }

    const handlers: Record<string, Handler> = { noop: async () => {} };
    const { processed, ms } = await drain({
      claimDb: workerDb,
      appDb: app,
      clock: systemClock,
      workers: WORKERS,
      handlers,
      queue: 'bench',
      leaseMs: LEASE_MS,
    });
    const check = await admin.query(
      `SELECT count(*) FILTER (WHERE status = 'succeeded')::int AS ok, count(*)::int AS total,
              max(attempts) AS max_attempts FROM jobs`,
    );
    if (
      check.rows[0].ok !== JOBS ||
      check.rows[0].total !== JOBS ||
      check.rows[0].max_attempts !== 1
    ) {
      throw new Error(`run ${run}: unexpected final state ${JSON.stringify(check.rows[0])}`);
    }
    const perSecond = processed / (ms / 1000);
    console.log(
      `run ${run}: ${processed} jobs in ${(ms / 1000).toFixed(2)} s = ${perSecond.toFixed(1)} jobs/s ` +
        `(all ${JOBS} succeeded, max attempts 1)`,
    );
    return perSecond;
  } finally {
    await admin.end();
    await app.end();
    await workerDb.end();
  }
}

async function main(): Promise<void> {
  console.log(`queue throughput: ${JOBS} jobs, ${WORKERS} workers, ${RUNS} runs, no-op handler`);
  console.log(`started ${new Date().toISOString()}`);
  const results: number[] = [];
  for (let run = 1; run <= RUNS; run++) results.push(await oneRun(run));
  const sorted = [...results].sort((a, b) => a - b);
  console.log(
    `median ${sorted[1]!.toFixed(1)} jobs/s, min ${sorted[0]!.toFixed(1)}, max ${sorted[2]!.toFixed(1)}`,
  );
  const server = new pg.Client({ connectionString: adminUrl() });
  await server.connect();
  await server.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await server.end();
}

main().catch((err) => {
  console.error(`bench failed: ${(err as Error).message}`);
  process.exit(1);
});
