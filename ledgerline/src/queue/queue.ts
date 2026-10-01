import { withTenant, type Db } from '../db/tenant.js';
import type { Clock } from './clock.js';

export interface ClaimedJob {
  id: string;
  tenantId: string;
  type: string;
  payload: unknown;
  attemptNo: number;
  maxAttempts: number;
  leaseExpiresAt: Date;
}

export interface EnqueueOptions {
  /** Unique per tenant: the same key never creates a second job. */
  idempotencyKey?: string;
  queue?: string;
  maxAttempts?: number;
  runAt?: Date;
}

/** Enqueue in its own tenant transaction. `created` is false when the key already existed. */
export function enqueueJob(
  db: Db,
  tenantId: string,
  clock: Clock,
  type: string,
  payload: unknown = {},
  options: EnqueueOptions = {},
): Promise<{ jobId: string; created: boolean }> {
  return withTenant(db, tenantId, async (c) => {
    const r = await c.query<{ job_id: string; created: boolean }>(
      'SELECT * FROM ledgerline_fn.enqueue_job($1, $2::jsonb, $3, $4, $5, $6, $7)',
      [
        type,
        JSON.stringify(payload),
        options.idempotencyKey ?? null,
        options.queue ?? 'default',
        options.maxAttempts ?? 5,
        options.runAt ?? null,
        clock.now(),
      ],
    );
    return { jobId: r.rows[0]!.job_id, created: r.rows[0]!.created };
  });
}

/**
 * Claims up to `limit` jobs across all tenants. `claimDb` must be connected as the worker role
 * (the only role allowed to call claim_jobs). Not tenant-scoped by design.
 */
export async function claimJobs(
  claimDb: Db,
  clock: Clock,
  workerId: string,
  options: { queue?: string | undefined; limit?: number; leaseMs: number },
): Promise<ClaimedJob[]> {
  const r = await claimDb.query<{
    job_id: string;
    tenant_id: string;
    type: string;
    payload: unknown;
    attempt_no: number;
    max_attempts: number;
    lease_expires_at: Date;
  }>('SELECT * FROM ledgerline_fn.claim_jobs($1, $2, $3, $4, $5)', [
    workerId,
    options.queue ?? 'default',
    options.limit ?? 1,
    options.leaseMs,
    clock.now(),
  ]);
  return r.rows.map((x) => ({
    id: x.job_id,
    tenantId: x.tenant_id,
    type: x.type,
    payload: x.payload,
    attemptNo: x.attempt_no,
    maxAttempts: x.max_attempts,
    leaseExpiresAt: x.lease_expires_at,
  }));
}

/** Runs in the job's tenant transaction. False means the worker is stale (lease lost). */
export function completeJob(
  appDb: Db,
  clock: Clock,
  job: ClaimedJob,
  workerId: string,
): Promise<boolean> {
  return withTenant(appDb, job.tenantId, async (c) => {
    const r = await c.query<{ ok: boolean }>(
      'SELECT ledgerline_fn.complete_job($1, $2, $3, $4) AS ok',
      [job.id, workerId, job.attemptNo, clock.now()],
    );
    return r.rows[0]!.ok;
  });
}

export type FailOutcome = 'retry_scheduled' | 'dead' | 'stale';

export function failJob(
  appDb: Db,
  clock: Clock,
  job: ClaimedJob,
  workerId: string,
  error: string,
  retryDelayMs: number,
): Promise<FailOutcome> {
  return withTenant(appDb, job.tenantId, async (c) => {
    const r = await c.query<{ outcome: FailOutcome }>(
      'SELECT ledgerline_fn.fail_job($1, $2, $3, $4, $5, $6) AS outcome',
      [job.id, workerId, job.attemptNo, error, retryDelayMs, clock.now()],
    );
    return r.rows[0]!.outcome;
  });
}
