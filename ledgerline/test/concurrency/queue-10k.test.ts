import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemClock } from '../../src/queue/clock.js';
import { drain } from '../../src/queue/drain.js';
import type { Handler } from '../../src/queue/worker.js';
import {
  expectNoOverlappingLeases,
  insertJobs as insertJobsInto,
  makeEnv,
  payloadN,
  recorder,
  uniqueQueue,
  type QueueEnv,
} from '../queue-helpers.js';

// Run with: pnpm test:concurrency (too slow for the default test run: see DECISIONS.md D19).
let env: QueueEnv;
beforeAll(async () => {
  env = await makeEnv();
});
afterAll(async () => {
  await env.close();
});
const admin = () => env.admin;
const insertJobs = (queue: string, count: number, type: string) =>
  insertJobsInto(env, queue, count, type);

describe('queue (concurrency, full size): 50 workers, 10,000 jobs, no failures and no crashes', () => {
  it('runs every job exactly once, loses none, and never double-claims a live lease', async () => {
    const JOBS = 10_000;
    const queue = uniqueQueue();
    await insertJobs(queue, JOBS, 'noop');

    const executions = new Map<string, number>();
    const { claims, onEvent } = recorder();
    let tenantChecks = 0;
    const handlers: Record<string, Handler> = {
      noop: async (job, ctx) => {
        executions.set(job.id, (executions.get(job.id) ?? 0) + 1);
        // Handlers must run with the right tenant set (sampled: it costs a round trip).
        if (payloadN(job) % 100 === 0) {
          await ctx.withTenant(async (c) => {
            const r = await c.query(
              `SELECT current_setting('app.tenant_id') AS t, count(DISTINCT tenant_id)::int AS n FROM jobs`,
            );
            if (r.rows[0].t !== job.tenantId || r.rows[0].n !== 1) {
              throw new Error('handler ran with the wrong tenant context');
            }
            tenantChecks++;
          });
        }
      },
    };

    const { processed, ms } = await drain({
      claimDb: env.workerDb,
      appDb: env.app,
      clock: systemClock,
      workers: 50,
      handlers,
      queue,
      leaseMs: 60_000,
      onEvent,
    });
    console.log(
      `QUEUE TEST 1: ${processed} jobs by 50 workers in ${(ms / 1000).toFixed(1)}s ` +
        `(${(processed / (ms / 1000)).toFixed(0)} jobs/s), ${tenantChecks} tenant-context checks`,
    );

    const status = await admin().query(
      `SELECT status, count(*)::int AS n, min(attempts) AS min_a, max(attempts) AS max_a
       FROM jobs WHERE queue = $1 GROUP BY status`,
      [queue],
    );
    expect(status.rows).toEqual([{ status: 'succeeded', n: JOBS, min_a: 1, max_a: 1 }]); // none lost
    expect(processed).toBe(JOBS);
    expect(executions.size).toBe(JOBS); // every job ran...
    expect([...executions.values()].every((n) => n === 1)).toBe(true); // ...exactly once
    expect(claims.size).toBe(JOBS);
    expect([...claims.values()].every((l) => l.length === 1)).toBe(true); // never claimed twice
    expect(expectNoOverlappingLeases(claims)).toBe(0);

    const attempts = await admin().query(
      `SELECT count(*)::int AS n, count(DISTINCT job_id)::int AS jobs,
              count(*) FILTER (WHERE outcome = 'succeeded' AND finished_at IS NOT NULL)::int AS ok
       FROM job_attempts a JOIN jobs j ON j.id = a.job_id WHERE j.queue = $1`,
      [queue],
    );
    expect(attempts.rows[0]).toEqual({ n: JOBS, jobs: JOBS, ok: JOBS });
    const dead = await admin().query(
      `SELECT count(*)::int AS n FROM dead_letters d JOIN jobs j ON j.id = d.job_id WHERE j.queue = $1`,
      [queue],
    );
    expect(dead.rows[0].n).toBe(0);
    expect(tenantChecks).toBe(JOBS / 100);
  }, 180_000);
});
