import type pg from 'pg';
import { assertShadow } from '@ledgerworks/core';
import type { SqlCandidate } from './types.js';

/**
 * Runs the up or the down SQL of a candidate on a SHADOW, statement by statement (index builds with
 * CONCURRENTLY cannot run inside a transaction block). `assertShadow` is checked first, on this very
 * connection: a database that is not a shadow gets nothing. This is the only way Ledgerlens applies
 * a candidate; there is no function that applies one to a source database.
 */
export async function applyCandidateOnShadow(
  client: pg.ClientBase,
  candidate: SqlCandidate,
  direction: 'up' | 'down',
): Promise<void> {
  await assertShadow(client);
  const statements = direction === 'up' ? candidate.upStatements : candidate.downStatements;
  for (const sql of statements) {
    if (sql.trim().startsWith('--')) continue; // a comment-only statement (the "nothing to undo" down of ANALYZE)
    await client.query(sql);
  }
}
