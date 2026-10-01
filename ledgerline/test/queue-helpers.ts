import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect } from 'vitest';
import { workerUrlFrom } from '../src/db/config.js';
import type { ClaimedJob } from '../src/queue/queue.js';
import type { WorkerEvent } from '../src/queue/worker.js';
import { adminPool, testAdminUrl, testAppUrl } from './helpers.js';

export interface QueueEnv {
  admin: pg.Pool;
  app: pg.Pool;
  /** Connected as ledgerline_worker: may only call claim_jobs. */
  workerDb: pg.Pool;
  tenants: string[];
  close(): Promise<void>;
}

export async function makeEnv(): Promise<QueueEnv> {
  const admin = adminPool();
  const app = new pg.Pool({ connectionString: testAppUrl(), max: 30 });
  const workerDb = new pg.Pool({ connectionString: workerUrlFrom(testAdminUrl()), max: 30 });
  const tenants: string[] = [];
  for (let i = 0; i < 5; i++) {
    const t = await admin.query<{ id: string }>(
      `INSERT INTO tenants (name) VALUES ('queue-test') RETURNING id`,
    );
    tenants.push(t.rows[0]!.id);
  }
  return {
    admin,
    app,
    workerDb,
    tenants,
    close: async () => {
      await admin.end();
      await app.end();
      await workerDb.end();
    },
  };
}

/** Each test uses its own queue name, so tests never see each other's jobs. */
export const uniqueQueue = (): string => `q-${randomUUID().slice(0, 8)}`;

/** Bulk-inserts jobs round-robin over the tenants, runnable at runAt (default: now). */
export async function insertJobs(
  env: QueueEnv,
  queue: string,
  count: number,
  type: string,
  maxAttempts = 5,
  runAt?: Date,
): Promise<void> {
  await env.admin.query(
    `INSERT INTO jobs (tenant_id, queue, type, payload, max_attempts, run_at)
     SELECT ($1::uuid[])[1 + (g % $2::int)], $3, $4, jsonb_build_object('n', g), $5, $7::timestamptz
     FROM generate_series(0, $6::int - 1) AS g`,
    [env.tenants, env.tenants.length, queue, type, maxAttempts, count, runAt ?? new Date()],
  );
}

export interface Claim {
  worker: string;
  at: Date;
  leaseExpiresAt: Date;
  attemptNo: number;
}

/** Collects claim events and checks leases never overlap for one job. */
export function recorder() {
  const claims = new Map<string, Claim[]>();
  const onEvent = (e: WorkerEvent): void => {
    if (e.kind !== 'claimed') return;
    const list = claims.get(e.job.id) ?? [];
    list.push({
      worker: e.workerId,
      at: e.at,
      leaseExpiresAt: e.job.leaseExpiresAt,
      attemptNo: e.job.attemptNo,
    });
    claims.set(e.job.id, list);
  };
  return { claims, onEvent };
}

/** A job may only be claimed again once the previous lease has expired. */
export function expectNoOverlappingLeases(claims: Map<string, Claim[]>): number {
  let reclaims = 0;
  for (const [id, list] of claims) {
    const sorted = [...list].sort((a, b) => a.attemptNo - b.attemptNo);
    for (let i = 1; i < sorted.length; i++) {
      reclaims++;
      expect(
        sorted[i]!.at.getTime(),
        `job ${id}: claim #${i + 1} at ${sorted[i]!.at.toISOString()} before lease expiry ${sorted[i - 1]!.leaseExpiresAt.toISOString()}`,
      ).toBeGreaterThanOrEqual(sorted[i - 1]!.leaseExpiresAt.getTime());
    }
  }
  return reclaims;
}

export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const payloadN = (job: ClaimedJob): number => (job.payload as { n: number }).n;
