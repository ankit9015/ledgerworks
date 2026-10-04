import { createHash } from 'node:crypto';
import { parseIndexDefinition, statementKinds } from '../sql/indexdef.js';
import { parseCondition } from '../sql/parse.js';
import {
  MAX_IDENTIFIER_BYTES,
  assertIdentifier,
  quoteIdent,
  quoteLiteral,
  quoteQualified,
} from '../sql/ident.js';
import type { IndexSpec } from './types.js';

/**
 * The only place the SQL of a candidate is assembled, and only from `quoteIdent` / `quoteLiteral`
 * (sql/ident.ts). Afterwards `validateSql` asks PostgreSQL's own parser what the text contains: the
 * statements must be exactly the expected kinds, and an index must read back as the structure it
 * was generated from. Text that fails is a bug or an attack, and never leaves this module.
 */

export class SqlGenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlGenError';
  }
}

const sanitizePart = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20);

/**
 * A deterministic index name, `ll_<table>_<columns>_<hash>`, made only of [a-z0-9_] and at most 63
 * bytes: whatever the table and column names contain, the generated name is plain. The hash keeps
 * two different column lists apart after sanitising. `suffix` (a partition number) is kept intact.
 */
export function makeIndexName(
  parts: {
    schema: string;
    table: string;
    key: string[];
    include: string[];
    predicate?: string | null;
  },
  suffix = '',
): string {
  const hash = createHash('sha256')
    .update(
      JSON.stringify([
        parts.schema,
        parts.table,
        parts.key,
        parts.include,
        parts.predicate ?? null,
      ]),
    )
    .digest('hex')
    .slice(0, 8);
  const body = [
    'll',
    sanitizePart(parts.table),
    ...parts.key.slice(0, 3).map((k) => sanitizePart(k)),
  ]
    .filter(Boolean)
    .join('_');
  const tail = `_${hash}${suffix}`;
  const name = `${body.slice(0, MAX_IDENTIFIER_BYTES - tail.length)}${tail}`;
  assertIdentifier(name);
  return name;
}

/** all names in a spec must be representable; throws IdentifierError for the first that is not */
export function assertSpecIdentifiers(spec: IndexSpec): void {
  assertIdentifier(spec.schema);
  assertIdentifier(spec.table);
  for (const k of spec.key) assertIdentifier(k.name);
  for (const c of spec.include) assertIdentifier(c);
  if (spec.partial) assertIdentifier(spec.partial.column);
  for (const p of spec.partitions ?? []) assertIdentifier(p);
}

function indexBody(spec: IndexSpec): string {
  const key = spec.key.map((k) => `${quoteIdent(k.name)}${k.desc ? ' DESC' : ''}`).join(', ');
  const include = spec.include.length
    ? ` INCLUDE (${spec.include.map(quoteIdent).join(', ')})`
    : '';
  const where = spec.partial
    ? ` WHERE ${quoteIdent(spec.partial.column)} = ${quoteLiteral(spec.partial.value)}`
    : '';
  return `USING btree (${key})${include}${where}`;
}

export interface BuiltSql {
  up: string[];
  down: string[];
  noTransaction: boolean;
}

export function buildCreateIndex(spec: IndexSpec): BuiltSql {
  assertSpecIdentifiers(spec);
  const table = quoteQualified(spec.schema, spec.table);
  const index = quoteQualified(spec.schema, spec.indexName);
  if (!spec.partitions) {
    return {
      up: [
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${quoteIdent(spec.indexName)} ON ${table} ${indexBody(spec)}`,
      ],
      down: [`DROP INDEX CONCURRENTLY IF EXISTS ${index}`],
      noTransaction: true,
    };
  }
  // CREATE INDEX CONCURRENTLY is not allowed on a partitioned table: the documented procedure is an
  // index ON ONLY the parent (instant, invalid), a concurrent index per partition, and ATTACH for each.
  const up = [
    `CREATE INDEX IF NOT EXISTS ${quoteIdent(spec.indexName)} ON ONLY ${table} ${indexBody(spec)}`,
  ];
  const down: string[] = [];
  spec.partitions.forEach((p, i) => {
    const child = makeIndexName(
      {
        schema: spec.schema,
        table: spec.table,
        key: spec.key.map((k) => k.name),
        include: spec.include,
        predicate: spec.partial?.value ?? null,
      },
      `_p${i}`,
    );
    up.push(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${quoteIdent(child)} ON ${quoteQualified(spec.schema, p)} ${indexBody(spec)}`,
    );
    up.push(`ALTER INDEX ${index} ATTACH PARTITION ${quoteQualified(spec.schema, child)}`);
  });
  // dropping the partitioned index drops the attached partition indexes with it
  down.push(`DROP INDEX IF EXISTS ${index}`);
  return { up, down, noTransaction: true };
}

export function buildDropIndex(schema: string, name: string, recreate: IndexSpec): BuiltSql {
  assertIdentifier(schema);
  assertIdentifier(name);
  const create = buildCreateIndex({ ...recreate, partitions: null });
  return {
    up: [`DROP INDEX CONCURRENTLY IF EXISTS ${quoteQualified(schema, name)}`],
    down: create.up,
    noTransaction: true,
  };
}

export function buildAnalyze(schema: string, table: string): BuiltSql {
  return {
    up: [`ANALYZE ${quoteQualified(schema, table)}`],
    // there is nothing to undo: ANALYZE only refreshes the planner's statistics. A comment is a valid, empty statement.
    down: ['-- ANALYZE only refreshes planner statistics; nothing to undo'],
    noTransaction: false,
  };
}

export function buildStatsTarget(
  schema: string,
  table: string,
  columns: string[],
  target: number,
): BuiltSql {
  if (!Number.isInteger(target) || target < 1 || target > 10_000)
    throw new SqlGenError('statistics target out of range');
  const t = quoteQualified(schema, table);
  return {
    up: [
      ...columns.map(
        (c) => `ALTER TABLE ${t} ALTER COLUMN ${quoteIdent(c)} SET STATISTICS ${target}`,
      ),
      `ANALYZE ${t}`,
    ],
    // -1 is "use default_statistics_target" (PostgreSQL 16)
    down: columns.map((c) => `ALTER TABLE ${t} ALTER COLUMN ${quoteIdent(c)} SET STATISTICS -1`),
    noTransaction: false,
  };
}

/**
 * Asks the parser what the generated statements are. Every statement must be one of `allowed`, in
 * any number; a comment-only statement is fine (it parses to no statement). For an index
 * statement the parsed structure must equal `spec` (columns, include, partial or not, table).
 */
export async function validateSql(
  statements: string[],
  allowed: readonly string[],
  spec?: IndexSpec,
): Promise<void> {
  for (const sql of statements) {
    if (sql.trim().startsWith('--') && !sql.includes('\n')) continue;
    const kinds = await statementKinds(sql);
    if (kinds.length !== 1)
      throw new SqlGenError(`generated text holds ${kinds.length} statements, expected 1`);
    if (!allowed.includes(kinds[0]!))
      throw new SqlGenError(`generated a ${kinds[0]} statement, allowed: ${allowed.join(', ')}`);
    if (spec && kinds[0] === 'IndexStmt') {
      const parsed = await parseIndexDefinition(sql);
      const expectedTables = new Set([spec.table, ...(spec.partitions ?? [])]);
      const same =
        expectedTables.has(parsed.table) &&
        (parsed.schema ?? spec.schema) === spec.schema &&
        parsed.columns.length === spec.key.length &&
        parsed.columns.every(
          (c, i) => c.name === spec.key[i]!.name && c.desc === spec.key[i]!.desc,
        ) &&
        JSON.stringify(parsed.include) === JSON.stringify(spec.include) &&
        (parsed.predicate !== null) === (spec.partial !== null);
      if (!same)
        throw new SqlGenError('the generated index does not read back as its specification');
      if (spec.partial && parsed.predicate !== null) {
        const f = await parseCondition(parsed.predicate);
        if (!f || f.columns.length !== 1 || f.columns[0]!.name !== spec.partial.column)
          throw new SqlGenError('the generated predicate does not read back as its specification');
      }
    }
  }
}
