import type pg from 'pg';
import { withTenant, type Db } from './db/tenant.js';
import { debitOutcomes } from './observability/metrics.js';

export type DebitOutcome = 'debited' | 'insufficient_credits' | 'idempotency_conflict';
export type RefundOutcome =
  | 'refunded'
  | 'debit_not_found'
  | 'refund_exceeds_debit'
  | 'already_refunded'
  | 'idempotency_conflict';

export interface CreditResult<O extends string> {
  outcome: O;
  /** Ledger row written (or, for a replay, the original row). Null when nothing was written. */
  ledgerId: number | null;
  /** Balance after the operation (original balance for a replay); the balance seen if rejected. */
  balance: number;
  /** True when the same idempotency key and parameters had already been applied. */
  replayed: boolean;
}

interface Row {
  outcome: string;
  ledger_id: string | null;
  balance: string;
  replayed: boolean;
}

function toResult<O extends string>(row: Row): CreditResult<O> {
  return {
    outcome: row.outcome as O,
    ledgerId: row.ledger_id === null ? null : Number(row.ledger_id),
    balance: Number(row.balance),
    replayed: row.replayed,
  };
}

/** Debit inside an existing tenant transaction. */
export async function debitIn(
  client: pg.PoolClient,
  amount: number,
  idempotencyKey: string,
  reference?: string,
): Promise<CreditResult<DebitOutcome>> {
  const r = await client.query<Row>('SELECT * FROM ledgerline_fn.debit_credits($1, $2, $3)', [
    amount,
    idempotencyKey,
    reference ?? null,
  ]);
  const result = toResult<DebitOutcome>(r.rows[0]!);
  debitOutcomes.inc({
    outcome: result.replayed
      ? 'replayed'
      : result.outcome === 'debited'
        ? 'accepted'
        : result.outcome === 'insufficient_credits'
          ? 'rejected'
          : 'conflict',
  });
  return result;
}

/** Refund inside an existing tenant transaction. */
export async function refundIn(
  client: pg.PoolClient,
  debitId: number,
  amount: number,
  idempotencyKey: string,
  reference?: string,
): Promise<CreditResult<RefundOutcome>> {
  const r = await client.query<Row>('SELECT * FROM ledgerline_fn.refund_credits($1, $2, $3, $4)', [
    debitId,
    amount,
    idempotencyKey,
    reference ?? null,
  ]);
  return toResult(r.rows[0]!);
}

/** One debit in its own transaction for the given tenant. */
export function debitCredits(
  db: Db,
  tenantId: string,
  amount: number,
  idempotencyKey: string,
  reference?: string,
): Promise<CreditResult<DebitOutcome>> {
  return withTenant(db, tenantId, (c) => debitIn(c, amount, idempotencyKey, reference));
}

/** One refund in its own transaction for the given tenant. */
export function refundCredits(
  db: Db,
  tenantId: string,
  debitId: number,
  amount: number,
  idempotencyKey: string,
  reference?: string,
): Promise<CreditResult<RefundOutcome>> {
  return withTenant(db, tenantId, (c) => refundIn(c, debitId, amount, idempotencyKey, reference));
}
