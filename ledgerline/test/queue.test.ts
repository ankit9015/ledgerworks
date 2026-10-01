import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeClock, systemClock } from '../src/queue/clock.js';
import { drain } from '../src/queue/drain.js';
import { claimJobs, completeJob, enqueueJob, failJob } from '../src/queue/queue.js';
import { AbandonJob, type Handler } from '../src/queue/worker.js';
import {
  expectNoOverlappingLeases,
  insertJobs as insertJobsInto,
  makeEnv,
  mulberry32,
  payloadN,
  recorder,
  uniqueQueue,
  type QueueEnv,
} from './queue-helpers.js';

let env: QueueEnv;
let admin: pg.Pool;
let app: pg.Pool;
let workerDb: pg.Pool;
let tenants: string[];

beforeAll(async () => {
  env = await makeEnv();
  ({ admin, app, workerDb, tenants } = env);
});
afterAll(async () => {
  await env.close();
});

const insertJobs = (queue: string, count: number, type: string, maxAttempts = 5, runAt?: Date) =>
  insertJobsInto(env, queue, count, type, maxAttempts, runAt);

describe('queue: failures, backoff and dead letters', () => {
  it('retries on an exponential schedule, never early, and dead-letters after max attempts', async () => {
    const JOBS = 300;
    const MAX = 4;
    const queue = uniqueQueue();
    const clock = new FakeClock();
    // run_at must be "now" on the fake clock, so the bulk insert passes it explicitly.
    await insertJobs(queue, JOBS, 'work', MAX, clock.now());

    const FAIL_P = 0.6;
    const kind = (n: number): 'poison' | 'ok' | 'flaky' =>
      n % 10 === 0 ? 'poison' : n % 10 <= 3 ? 'ok' : 'flaky';
    const decides = (n: number, attempt: number): boolean =>
      mulberry32(n * 100 + attempt)() < FAIL_P;
    const executions = new Map<string, number>();
    const handlers: Record<string, Handler> = {
      work: async (job) => {
        executions.set(job.id, (executions.get(job.id) ?? 0) + 1);
        const n = payloadN(job);
        const k = kind(n);
        if (k === 'poison' || (k === 'flaky' && decides(n, job.attemptNo))) {
          throw new Error(`${k} job ${n} failed on attempt ${job.attemptNo}`);
        }
      },
    };
    const backoff = { baseMs: 1000, factor: 2, capMs: 60_000 };
    const delayAfter = (attempt: number) =>
      Math.floor(0.75 * Math.min(60_000, 1000 * 2 ** (attempt - 1)));

    let rounds = 0;
    let checkedEarly = false;
    for (;;) {
      await drain({
        claimDb: workerDb,
        appDb: app,
        clock,
        workers: 10,
        handlers,
        queue,
        leaseMs: 30_000,
        backoff,
        random: () => 0.5, // fixed jitter draw: delay = 75% of the exponential step
      });
      rounds++;
      const next = await admin.query(
        `SELECT min(run_at) AS t FROM jobs WHERE queue = $1 AND status = 'failed'`,
        [queue],
      );
      const t: Date | null = next.rows[0].t;
      if (!t) break;
      expect(t.getTime()).toBeGreaterThan(clock.now().getTime());
      if (!checkedEarly) {
        // One millisecond before run_at nothing is claimable; at run_at the jobs are.
        clock.set(t.getTime() - 1);
        expect(
          await claimJobs(workerDb, clock, 'probe', { queue, limit: 5, leaseMs: 1000 }),
        ).toEqual([]);
        checkedEarly = true;
      }
      clock.set(t.getTime());
    }

    const jobs = await admin.query(
      `SELECT id, (payload->>'n')::int AS n, status, attempts, last_error FROM jobs WHERE queue = $1`,
      [queue],
    );
    expect(jobs.rowCount).toBe(JOBS);
    const attemptRows = await admin.query(
      `SELECT a.job_id, a.attempt_no, a.started_at, a.finished_at, a.outcome, a.error
       FROM job_attempts a JOIN jobs j ON j.id = a.job_id WHERE j.queue = $1 ORDER BY a.job_id, a.attempt_no`,
      [queue],
    );
    const byJob = new Map<string, typeof attemptRows.rows>();
    for (const r of attemptRows.rows) byJob.set(r.job_id, [...(byJob.get(r.job_id) ?? []), r]);
    const deadLetters = await admin.query(
      `SELECT d.job_id, d.attempts, d.last_error, d.payload FROM dead_letters d
       JOIN jobs j ON j.id = d.job_id WHERE j.queue = $1`,
      [queue],
    );
    const dlByJob = new Map(deadLetters.rows.map((r) => [r.job_id, r]));

    let dead = 0;
    let succeededAfterRetry = 0;
    let retriesChecked = 0;
    for (const job of jobs.rows) {
      const rows = byJob.get(job.id) ?? [];
      // Expected outcome, computed independently from the failure rule.
      let expectedAttempts = MAX;
      let expectedStatus = 'dead';
      if (kind(job.n) === 'ok') {
        expectedAttempts = 1;
        expectedStatus = 'succeeded';
      } else if (kind(job.n) === 'flaky') {
        for (let a = 1; a <= MAX; a++) {
          if (!decides(job.n, a)) {
            expectedAttempts = a;
            expectedStatus = 'succeeded';
            break;
          }
        }
      }
      expect(job.status, `job ${job.n}`).toBe(expectedStatus);
      expect(job.attempts, `job ${job.n} attempts`).toBe(expectedAttempts);
      expect(rows.length).toBe(expectedAttempts);
      expect(executions.get(job.id)).toBe(expectedAttempts); // one handler run per attempt

      // Backoff schedule: the next attempt starts exactly delay(n) after attempt n failed.
      for (let i = 0; i + 1 < rows.length; i++) {
        expect(rows[i]!.outcome).toBe('failed');
        const gap = rows[i + 1]!.started_at.getTime() - rows[i]!.finished_at.getTime();
        expect(gap, `job ${job.n} gap after attempt ${i + 1}`).toBe(delayAfter(i + 1));
        retriesChecked++;
      }
      if (expectedStatus === 'succeeded') {
        expect(rows[rows.length - 1]!.outcome).toBe('succeeded');
        if (expectedAttempts > 1) succeededAfterRetry++;
        expect(dlByJob.has(job.id)).toBe(false);
      } else {
        dead++;
        // Dead-lettered with the full attempt history.
        const dl = dlByJob.get(job.id)!;
        expect(dl.attempts).toBe(MAX);
        expect(dl.last_error).toBe(rows[MAX - 1]!.error);
        expect(dl.last_error).toContain(`attempt ${MAX}`);
        expect(dl.payload).toEqual({ n: job.n });
        expect(rows.every((r) => r.outcome === 'failed' && r.error)).toBe(true);
        expect(job.last_error).toBe(dl.last_error);
      }
    }
    expect(dlByJob.size).toBe(dead);
    expect(dead).toBeGreaterThanOrEqual(JOBS / 10); // at least the poison jobs
    expect(succeededAfterRetry).toBeGreaterThan(0);
    console.log(
      `QUEUE TEST 2: ${JOBS} jobs, max ${MAX} attempts: ${JOBS - dead} succeeded ` +
        `(${succeededAfterRetry} after at least one retry), ${dead} dead-lettered, ` +
        `${retriesChecked} retry gaps matched the schedule 750/1500/3000 ms, ${rounds} rounds`,
    );
  }, 120_000);

  it('a job with an unknown type fails (and is eventually dead-lettered), never lost', async () => {
    const queue = uniqueQueue();
    const clock = new FakeClock();
    await insertJobs(queue, 1, 'no-such-handler', 2, clock.now());
    for (let i = 0; i < 2; i++) {
      await drain({
        claimDb: workerDb,
        appDb: app,
        clock,
        workers: 1,
        handlers: {},
        queue,
        leaseMs: 1000,
      });
      clock.advance(120_000);
    }
    const j = await admin.query(`SELECT status, last_error FROM jobs WHERE queue = $1`, [queue]);
    expect(j.rows[0].status).toBe('dead');
    expect(j.rows[0].last_error).toMatch(/no handler registered/);
  });
});

describe('queue: crashed workers and leases', () => {
  const LEASE = 30_000;

  it('a job is re-claimed only after its lease expires, and a stale worker is fenced off', async () => {
    const queue = uniqueQueue();
    const clock = new FakeClock();
    await insertJobs(queue, 1, 'work', 3, clock.now());
    const t0 = clock.now().getTime();

    const [first] = await claimJobs(workerDb, clock, 'worker-A', { queue, leaseMs: LEASE });
    expect(first!.attemptNo).toBe(1);
    expect(first!.leaseExpiresAt.getTime()).toBe(t0 + LEASE);
    // worker-A "crashes" here: it never reports back.

    clock.set(t0 + LEASE - 1);
    expect(await claimJobs(workerDb, clock, 'worker-B', { queue, leaseMs: LEASE })).toEqual([]);
    clock.set(t0 + LEASE);
    const [second] = await claimJobs(workerDb, clock, 'worker-B', { queue, leaseMs: LEASE });
    expect(second!.id).toBe(first!.id);
    expect(second!.attemptNo).toBe(2);

    // Attempt 1 was closed as failed by lease expiry; attempt 2 is open.
    const att = await admin.query(
      `SELECT attempt_no, outcome, error, worker_id FROM job_attempts WHERE job_id = $1 ORDER BY attempt_no`,
      [first!.id],
    );
    expect(att.rows).toEqual([
      { attempt_no: 1, outcome: 'failed', error: 'lease expired', worker_id: 'worker-A' },
      { attempt_no: 2, outcome: null, error: null, worker_id: 'worker-B' },
    ]);

    // worker-A wakes up late: both of its acknowledgements are refused.
    expect(await completeJob(app, clock, first!, 'worker-A')).toBe(false);
    expect(await failJob(app, clock, first!, 'worker-A', 'late', 0)).toBe('stale');
    const mid = await admin.query(`SELECT status, locked_by, attempts FROM jobs WHERE id = $1`, [
      first!.id,
    ]);
    expect(mid.rows[0]).toEqual({ status: 'running', locked_by: 'worker-B', attempts: 2 });

    expect(await completeJob(app, clock, second!, 'worker-B')).toBe(true);
    const done = await admin.query(`SELECT status, attempts FROM jobs WHERE id = $1`, [first!.id]);
    expect(done.rows[0]).toEqual({ status: 'succeeded', attempts: 2 });
  });

  it('abandoned jobs re-run only after lease expiry; re-executions are counted and expected', async () => {
    const JOBS = 200;
    const queue = uniqueQueue();
    const clock = new FakeClock();
    await insertJobs(queue, JOBS, 'work', 5, clock.now());
    const rand = mulberry32(7);
    const abandon = new Set<number>();
    while (abandon.size < 40) abandon.add(Math.floor(rand() * JOBS));

    const executions = new Map<string, number>();
    const handlers: Record<string, Handler> = {
      work: async (job) => {
        executions.set(job.id, (executions.get(job.id) ?? 0) + 1);
        // Side effect done, then the worker dies before acknowledging (first attempt only).
        if (job.attemptNo === 1 && abandon.has(payloadN(job))) throw new AbandonJob();
      },
    };
    const { claims, onEvent } = recorder();
    const run = () =>
      drain({
        claimDb: workerDb,
        appDb: app,
        clock,
        workers: 20,
        handlers,
        queue,
        leaseMs: LEASE,
        onEvent,
      });

    const first = await run();
    expect(first.processed).toBe(JOBS);
    const afterFirst = await admin.query(
      `SELECT status, count(*)::int AS n FROM jobs WHERE queue = $1 GROUP BY status ORDER BY status`,
      [queue],
    );
    expect(afterFirst.rows).toEqual([
      { status: 'running', n: 40 },
      { status: 'succeeded', n: JOBS - 40 },
    ]);

    clock.advance(LEASE - 1); // one millisecond too early
    expect((await run()).processed).toBe(0);
    expect(executions.size).toBe(JOBS);
    expect([...executions.values()].filter((n) => n > 1)).toHaveLength(0);

    clock.advance(1); // lease expired
    const second = await run();
    expect(second.processed).toBe(40);

    const reexecuted = [...executions.values()].filter((n) => n === 2).length;
    const total = [...executions.values()].reduce((a, b) => a + b, 0);
    expect(reexecuted).toBe(40);
    expect(total).toBe(JOBS + 40);
    expect(expectNoOverlappingLeases(claims)).toBe(40);
    const final = await admin.query(
      `SELECT status, count(*)::int AS n, max(attempts) AS max_attempts FROM jobs WHERE queue = $1 GROUP BY status`,
      [queue],
    );
    expect(final.rows).toEqual([{ status: 'succeeded', n: JOBS, max_attempts: 2 }]);
    console.log(
      `QUEUE TEST 3: ${JOBS} jobs, ${abandon.size} abandoned by a "crashed" worker: ` +
        `${reexecuted} re-executions (${total} handler runs for ${JOBS} jobs), all after lease expiry, ` +
        `0 claims 1 ms before expiry, ${JOBS} succeeded`,
    );
  }, 60_000);

  it('a job whose lease keeps expiring is dead-lettered after its last attempt, not run forever', async () => {
    const queue = uniqueQueue();
    const clock = new FakeClock();
    await insertJobs(queue, 1, 'work', 2, clock.now());
    let runs = 0;
    const handlers: Record<string, Handler> = {
      work: async () => {
        runs++;
        throw new AbandonJob();
      },
    };
    const go = () =>
      drain({ claimDb: workerDb, appDb: app, clock, workers: 1, handlers, queue, leaseMs: LEASE });
    await go();
    clock.advance(LEASE);
    await go();
    clock.advance(LEASE);
    expect((await go()).processed).toBe(0); // nothing to run: the job is dead-lettered instead
    expect(runs).toBe(2);
    const j = await admin.query(
      `SELECT id, status, attempts, last_error FROM jobs WHERE queue = $1`,
      [queue],
    );
    expect(j.rows[0]).toMatchObject({ status: 'dead', attempts: 2 });
    const dl = await admin.query(
      `SELECT attempts, last_error FROM dead_letters WHERE job_id = $1`,
      [j.rows[0].id],
    );
    expect(dl.rows).toEqual([{ attempts: 2, last_error: 'lease expired after the last attempt' }]);
    const att = await admin.query(
      `SELECT outcome, error FROM job_attempts WHERE job_id = $1 ORDER BY attempt_no`,
      [j.rows[0].id],
    );
    expect(att.rows).toEqual([
      { outcome: 'failed', error: 'lease expired' },
      { outcome: 'failed', error: 'lease expired' },
    ]);
    clock.advance(10 * LEASE);
    expect((await go()).processed).toBe(0);
    expect(runs).toBe(2);
  });
});

describe('queue: idempotent enqueue', () => {
  it('50 concurrent enqueues with one key create exactly one job', async () => {
    const queue = uniqueQueue();
    const tenant = tenants[0]!;
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        enqueueJob(app, tenant, systemClock, 'work', { x: 1 }, { idempotencyKey: 'once', queue }),
      ),
    );
    expect(new Set(results.map((r) => r.jobId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const n = await admin.query(
      `SELECT count(*)::int AS n FROM jobs WHERE tenant_id = $1 AND idempotency_key = 'once' AND queue = $2`,
      [tenant, queue],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it('the key is unique per tenant; no key means a new job every time', async () => {
    const queue = uniqueQueue();
    const [a, b] = [tenants[1]!, tenants[2]!];
    const ja = await enqueueJob(
      app,
      a,
      systemClock,
      'work',
      {},
      { idempotencyKey: 'shared', queue },
    );
    const jb = await enqueueJob(
      app,
      b,
      systemClock,
      'work',
      {},
      { idempotencyKey: 'shared', queue },
    );
    expect(ja.jobId).not.toBe(jb.jobId);
    expect(ja.created && jb.created).toBe(true);
    const x = await enqueueJob(app, a, systemClock, 'work', {}, { queue });
    const y = await enqueueJob(app, a, systemClock, 'work', {}, { queue });
    expect(x.jobId).not.toBe(y.jobId);
    // The first call's payload wins on a repeat.
    const first = await enqueueJob(
      app,
      a,
      systemClock,
      'work',
      { v: 1 },
      { idempotencyKey: 'p', queue },
    );
    const second = await enqueueJob(
      app,
      a,
      systemClock,
      'work',
      { v: 2 },
      { idempotencyKey: 'p', queue },
    );
    expect(second).toEqual({ jobId: first.jobId, created: false });
    const p = await admin.query(`SELECT payload FROM jobs WHERE id = $1`, [first.jobId]);
    expect(p.rows[0].payload).toEqual({ v: 1 });
  });

  it('enqueue through the API path honours max attempts and run_at', async () => {
    const queue = uniqueQueue();
    const clock = new FakeClock();
    const later = new Date(clock.now().getTime() + 5_000);
    const { jobId } = await enqueueJob(
      app,
      tenants[0]!,
      clock,
      'work',
      {},
      { queue, maxAttempts: 2, runAt: later },
    );
    expect(await claimJobs(workerDb, clock, 'w', { queue, leaseMs: 1000 })).toEqual([]);
    clock.set(later.getTime());
    const [job] = await claimJobs(workerDb, clock, 'w', { queue, leaseMs: 1000 });
    expect(job).toMatchObject({ id: jobId, maxAttempts: 2, attemptNo: 1 });
  });
});

describe('queue: access control and tenant context', () => {
  it('claiming works across tenants, and only the worker role can claim', async () => {
    const queue = uniqueQueue();
    await insertJobs(queue, 10, 'work');
    // The app role (the API) cannot claim: it would expose every tenant's payloads.
    await expect(
      app.query(`SELECT * FROM ledgerline_fn.claim_jobs('x', $1, 5, 1000, now())`, [queue]),
    ).rejects.toMatchObject({ code: '42501' });
    const claimed = await claimJobs(workerDb, systemClock, 'w', {
      queue,
      limit: 10,
      leaseMs: 1000,
    });
    expect(claimed).toHaveLength(10);
    expect(new Set(claimed.map((c) => c.tenantId)).size).toBe(tenants.length);
  });

  it('the worker role has no table privileges and cannot call anything but claim_jobs', async () => {
    for (const table of [
      'jobs',
      'job_attempts',
      'dead_letters',
      'credit_ledger',
      'usage_events',
      'tenants',
    ]) {
      await expect(workerDb.query(`SELECT 1 FROM ${table} LIMIT 1`), table).rejects.toMatchObject({
        code: '42501',
      });
    }
    for (const sql of [
      `SELECT * FROM ledgerline_fn.enqueue_job('x')`,
      `SELECT ledgerline_fn.complete_job(gen_random_uuid(), 'w', 1, now())`,
      `SELECT * FROM ledgerline_fn.debit_credits(1, 'k')`,
      `SELECT * FROM ledgerline_fn.authenticate_api_key('x')`,
    ]) {
      await expect(workerDb.query(sql), sql).rejects.toMatchObject({ code: '42501' });
    }
    const r = await workerDb.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('acknowledging another tenants job is refused (RLS), and handlers see only their tenant', async () => {
    const queue = uniqueQueue();
    const clock = new FakeClock();
    await insertJobs(queue, 5, 'work', 3, clock.now());
    const jobs = await claimJobs(workerDb, clock, 'w', { queue, limit: 5, leaseMs: 60_000 });
    const mine = jobs[0]!;
    const other = tenants.find((t) => t !== mine.tenantId)!;
    // Pretend to be a different tenant and try to complete / fail the job.
    const forged = { ...mine, tenantId: other };
    expect(await completeJob(app, clock, forged, 'w')).toBe(false);
    expect(await failJob(app, clock, forged, 'w', 'x', 0)).toBe('stale');
    const still = await admin.query(`SELECT status FROM jobs WHERE id = $1`, [mine.id]);
    expect(still.rows[0].status).toBe('running');
    // The real tenant can.
    expect(await completeJob(app, clock, mine, 'w')).toBe(true);
  });
});
