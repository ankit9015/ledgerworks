import type { StatementClass, Strategy } from './schema.js';

/** Removes comments and string literals so keywords inside them are not seen. */
function bare(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .trim()
    .toLowerCase();
}

const NON_TRANSACTIONAL = [
  /^create\s+(unique\s+)?index\s+concurrently\b/,
  /^drop\s+index\s+concurrently\b/,
  /^reindex\b[\s\S]*\bconcurrently\b/,
  /^alter\s+table\b[\s\S]*\bdetach\s+partition\b[\s\S]*\bconcurrently\b/,
  /^vacuum\b/,
  /^create\s+database\b/,
  /^drop\s+database\b/,
  /^alter\s+system\b/,
  /^create\s+tablespace\b/,
  /^drop\s+tablespace\b/,
];

/**
 * Which kind of statement this is, and so how it can be measured safely:
 *
 *  - read (SELECT, VALUES, TABLE, WITH ... SELECT): runs inside BEGIN READ ONLY, so a function that
 *    tries to write (nextval, a volatile function that inserts) fails instead of writing.
 *  - dml (INSERT, UPDATE, DELETE, MERGE, WITH containing one of them, SELECT ... FOR UPDATE):
 *    EXPLAIN ANALYZE really executes it, so every run is inside BEGIN ... ROLLBACK. Not rolled back:
 *    sequence values consumed, and anything outside the database (a trigger that calls out).
 *  - ddl (CREATE, ALTER, DROP, TRUNCATE, ...): transactional in PostgreSQL, so inside BEGIN ... ROLLBACK.
 *  - non-transactional (CREATE/DROP INDEX CONCURRENTLY, REINDEX CONCURRENTLY, VACUUM, CREATE DATABASE,
 *    ALTER SYSTEM, ...): cannot run in a transaction block, so rollback is not possible; every run
 *    needs a fresh shadow.
 */
export function classifyStatement(sql: string): StatementClass {
  const s = bare(sql).replace(/;+\s*$/, '');
  if (NON_TRANSACTIONAL.some((re) => re.test(s))) return 'non-transactional';
  const first = /^[a-z]+/.exec(s)?.[0] ?? '';
  if (first === 'explain') return 'dml'; // EXPLAIN ANALYZE executes: treat as a write
  if (['select', 'values', 'table', 'show'].includes(first)) {
    return /\bfor\s+(no\s+key\s+)?(update|share)\b/.test(s) ? 'dml' : 'read';
  }
  if (first === 'with') {
    return /\b(insert|update|delete|merge)\b/.test(s) ? 'dml' : 'read';
  }
  if (['insert', 'update', 'delete', 'merge', 'copy', 'call', 'do'].includes(first)) return 'dml';
  return 'ddl';
}

export function strategyFor(c: StatementClass): Strategy {
  switch (c) {
    case 'read':
      return 'read-only-transaction';
    case 'non-transactional':
      return 'fresh-shadow-per-run';
    default:
      return 'rollback-transaction';
  }
}

/** True when the text holds more than one statement (a measured statement must be exactly one). */
export function hasMultipleStatements(sql: string): boolean {
  const s = bare(sql).replace(/;+\s*$/, '');
  return s.includes(';');
}
