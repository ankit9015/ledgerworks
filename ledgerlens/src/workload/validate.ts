import type pg from 'pg';
import type { ConnectionFactory } from '@ledgerworks/core';
import { sanitizeText } from '@ledgerworks/core';
import { toQueryConfig, type BindingSet, type StatementBindings } from './bindings.js';
import { ll, withSource } from './source.js';
import type { WorkloadStatement } from './types.js';

/**
 * Asks the server whether it accepts each binding set: a plain `EXPLAIN` (no ANALYZE: nothing is
 * executed) with the values as bound parameters, in a read-only session. A statement whose sets are
 * all refused (a type the server cannot infer, a value of the wrong type) becomes unverifiable.
 * Only SELECT statements are checked on the source; writes are skipped and checked on the shadow later.
 */
export async function validateBindings(
  connect: ConnectionFactory,
  stmt: WorkloadStatement,
  bound: StatementBindings,
): Promise<StatementBindings> {
  if (bound.status !== 'bound') return bound;
  if (stmt.kind !== 'select' || !stmt.parsed?.single) {
    return {
      ...bound,
      sets: bound.sets.map((s) => ({
        ...s,
        validation: {
          status: 'skipped',
          detail: 'only plain SELECT statements are checked on the source',
        },
      })),
    };
  }
  const sets = await withSource(connect, async (c) => {
    const out: BindingSet[] = [];
    for (const s of bound.sets) out.push(await validateOne(c, stmt, s));
    return out;
  });
  if (sets.every((s) => s.validation.status === 'rejected'))
    return {
      ...bound,
      status: 'unverifiable',
      sets,
      unverifiable: {
        reason: 'bindings_rejected_by_server',
        detail: `${sets[0]!.validation.detail ?? 'rejected'}${stmt.topLevel ? '' : ' (the statement ran inside a function or trigger, it may use variables that only exist there)'}`,
        params: [],
      },
    };
  return {
    ...bound,
    sets: sets
      .filter((s) => s.validation.status !== 'rejected')
      .concat(sets.filter((s) => s.validation.status === 'rejected')),
  };
}

async function validateOne(
  c: pg.Client,
  stmt: WorkloadStatement,
  set: BindingSet,
): Promise<BindingSet> {
  const q = toQueryConfig(stmt.text, set);
  try {
    await c.query(`BEGIN READ ONLY`);
    await c.query({ text: ll(`EXPLAIN (FORMAT JSON) ${q.text}`), values: q.values });
    return { ...set, validation: { status: 'ok' } };
  } catch (e) {
    const code = (e as { code?: string }).code ?? 'unknown';
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ...set,
      validation: { status: 'rejected', detail: `${code}: ${sanitizeText(msg, 160)}` },
    };
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
  }
}
