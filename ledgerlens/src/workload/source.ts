import { createHash } from 'node:crypto';
import type pg from 'pg';
import { createSourceAccess, type ConnectionFactory } from '@ledgerworks/core';
import { quoteQualified } from '../sql/ident.js';
import { parseStatement, SqlParseError, type TableRef } from '../sql/parse.js';
import {
  EXCLUSION_REASONS,
  type Exclusion,
  type ExclusionReason,
  type Workload,
  type WorkloadStatement,
} from './types.js';

/** Every statement Ledgerlens sends starts with this comment, so it can recognise its own queries in pg_stat_statements. */
export const LEDGERLENS_MARKER = '/* ledgerlens */';
export const ll = (sql: string): string => `${LEDGERLENS_MARKER} ${sql}`;

/** A read-only session on the source (the same connection rules and readiness check as the core tools). */
export function openSource(
  sourceUrl: string,
  o: { statementTimeoutMs?: number; allowWritableSource?: boolean; log?: (m: string) => void } = {},
): { connect: ConnectionFactory; ensureReadOnly(): Promise<void> } {
  const access = createSourceAccess({
    sourceUrl,
    applicationName: 'ledgerlens',
    statementTimeoutMs: o.statementTimeoutMs ?? 15_000,
    allowWritableSource: o.allowWritableSource,
    log: o.log,
  });
  return { connect: access.connect, ensureReadOnly: access.ensureReadOnly };
}

export async function withSource<T>(
  connect: ConnectionFactory,
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  const c = await connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => undefined);
  }
}

export const hashText = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);

const SYSTEM_SCHEMAS = new Set(['pg_catalog', 'information_schema', 'pg_toast']);
const MONITORING_TABLES = new Set(['pg_stat_statements', 'pg_stat_statements_info']);
const isSystem = (t: TableRef): boolean =>
  (t.schema !== null && SYSTEM_SCHEMAS.has(t.schema)) ||
  // an unqualified pg_* name resolves to pg_catalog first
  (t.schema === null && t.name.startsWith('pg_') && !MONITORING_TABLES.has(t.name));

export interface ReadWorkloadOptions {
  /** most statements to read, by total time (default 500) */
  limit?: number;
}

interface PgssRow {
  queryid: string | null;
  query: string | null;
  calls: string;
  total_exec_time: number;
  mean_exec_time: number;
  rows: string;
  shared_blks_hit: string;
  shared_blks_read: string;
  toplevel: boolean | null;
}

/**
 * Reads the workload of the connected database from pg_stat_statements, parses every statement and
 * excludes what is not a workload statement, counting each exclusion by reason.
 */
export async function readWorkload(
  connect: ConnectionFactory,
  o: ReadWorkloadOptions = {},
): Promise<Workload> {
  return withSource(connect, async (c) => {
    const meta = (
      await c.query<{ db: string; v: string; reset: Date | null; now: Date }>(
        ll(`SELECT current_database() AS db, current_setting('server_version') AS v,
                   (SELECT stats_reset FROM pg_stat_statements_info) AS reset, now() AS now`),
      )
    ).rows[0]!;
    // functions defined by the application (not by PostgreSQL or an extension): a statement that calls one is
    // application work even when it names no table (SELECT * FROM app_fn.authenticate($1))
    const fnRows = (
      await c.query<{ nspname: string; proname: string }>(
        ll(`SELECT n.nspname, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND left(n.nspname, 8) <> 'pg_toast'
               AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')`),
      )
    ).rows;
    const userFnQualified = new Set(fnRows.map((f) => `${f.nspname}.${f.proname}`.toLowerCase()));
    const userFnNames = new Set(fnRows.map((f) => f.proname.toLowerCase()));
    const callsUserFunction = (p: NonNullable<WorkloadStatement['parsed']>): boolean =>
      p.functions.some((f) =>
        f.schema ? userFnQualified.has(`${f.schema}.${f.name}`) : userFnNames.has(f.name),
      );
    const rows = (
      await c.query<PgssRow>(
        ll(`SELECT queryid::text, query, calls::text, total_exec_time, mean_exec_time, rows::text,
                   shared_blks_hit::text, shared_blks_read::text, toplevel
              FROM pg_stat_statements
             WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
             ORDER BY total_exec_time DESC LIMIT $1`),
        [o.limit ?? 500],
      )
    ).rows;
    const other = (
      await c.query<{ n: string; t: number }>(
        ll(`SELECT count(*)::text AS n, coalesce(sum(total_exec_time), 0) AS t FROM pg_stat_statements
             WHERE dbid <> (SELECT oid FROM pg_database WHERE datname = current_database())`),
      )
    ).rows[0]!;

    const excluded = new Map<ExclusionReason, Exclusion>(
      EXCLUSION_REASONS.map((r) => [r, { reason: r, count: 0, totalTimeMs: 0 }]),
    );
    const exclude = (r: ExclusionReason, ms: number, n = 1): void => {
      const e = excluded.get(r)!;
      e.count += n;
      e.totalTimeMs += ms;
    };
    exclude('other_database', Number(other.t), Number(other.n));

    const statements: Omit<WorkloadStatement, 'rank'>[] = [];
    let hiddenText = 0;
    for (const r of rows) {
      const ms = r.total_exec_time;
      if (r.query === null || r.query.startsWith('<insufficient privilege>')) {
        hiddenText++;
        continue;
      }
      const text = r.query;
      if (text.trimStart().startsWith(LEDGERLENS_MARKER)) {
        exclude('ledgerlens_own_query', ms);
        continue;
      }
      let parsed: WorkloadStatement['parsed'] = null;
      let parseError: string | null = null;
      try {
        parsed = await parseStatement(text);
      } catch (e) {
        if (!(e instanceof SqlParseError)) throw e;
        parseError = e.message.slice(0, 200);
      }
      if (parsed) {
        if (parsed.kind === 'utility') {
          exclude('utility_statement', ms);
          continue;
        }
        if (parsed.tables.some((t) => MONITORING_TABLES.has(t.name))) {
          exclude('monitoring_query', ms);
          continue;
        }
        if (parsed.tables.every(isSystem) && !callsUserFunction(parsed)) {
          exclude('no_user_tables', ms);
          continue;
        }
      }
      statements.push({
        queryId: r.queryid ?? hashText(text),
        queryHash: hashText(text),
        text,
        kind: parsed?.kind ?? 'select',
        calls: Number(r.calls),
        totalTimeMs: ms,
        meanTimeMs: r.mean_exec_time,
        rows: Number(r.rows),
        sharedBlksHit: Number(r.shared_blks_hit),
        sharedBlksRead: Number(r.shared_blks_read),
        topLevel: r.toplevel ?? true,
        tables: parsed?.tables ?? [],
        paramCount: parsed?.paramCount ?? 0,
        parsed,
        parseError,
      });
    }
    return {
      version: 1,
      capturedAt: meta.now.toISOString(),
      database: meta.db,
      statsResetAt: meta.reset ? meta.reset.toISOString() : null,
      serverVersion: meta.v,
      statementsRead: rows.length,
      statements: statements.map((s, i) => ({ ...s, rank: i + 1 })),
      excluded: [...excluded.values()],
      hiddenText,
    } satisfies Workload;
  });
}

// ------------------------------------------------------------------------------------------------
// catalog and statistics

export interface ColumnInfo {
  name: string;
  attnum: number;
  /** format_type output, e.g. "uuid", "timestamp with time zone", "character varying(20)" */
  type: string;
  typeOid: number;
  notNull: boolean;
}
export interface TableInfo {
  oid: number;
  schema: string;
  name: string;
  /** r table, p partitioned table, v view, m materialized view, f foreign table */
  relkind: string;
  estimatedRows: number;
  columns: ColumnInfo[];
}

/** Resolves a table as the server would (search_path included); null when it does not exist (or is not visible). */
export async function readTable(c: pg.Client, ref: TableRef): Promise<TableInfo | null> {
  const t = (
    await c.query<{
      oid: number;
      nspname: string;
      relname: string;
      relkind: string;
      reltuples: number;
    }>(
      ll(`SELECT c.oid::int AS oid, n.nspname, c.relname, c.relkind::text AS relkind, c.reltuples::float8 AS reltuples
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.oid = to_regclass($1)`),
      [quoteQualified(ref.schema, ref.name)],
    )
  ).rows[0];
  if (!t) return null;
  const cols = (
    await c.query<{
      attname: string;
      attnum: number;
      type: string;
      typeoid: number;
      attnotnull: boolean;
    }>(
      ll(`SELECT a.attname, a.attnum::int AS attnum, format_type(a.atttypid, a.atttypmod) AS type,
                 a.atttypid::int AS typeoid, a.attnotnull
            FROM pg_attribute a
           WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
           ORDER BY a.attnum`),
      [t.oid],
    )
  ).rows;
  return {
    oid: t.oid,
    schema: t.nspname,
    name: t.relname,
    relkind: t.relkind,
    estimatedRows: Math.max(0, t.reltuples),
    columns: cols.map((x) => ({
      name: x.attname,
      attnum: x.attnum,
      type: x.type,
      typeOid: x.typeoid,
      notNull: x.attnotnull,
    })),
  };
}

export interface ColumnStats {
  column: string;
  inherited: boolean;
  nullFrac: number;
  /** negative: a fraction of the row count (pg_stats convention) */
  nDistinct: number;
  /** most common values with their frequencies, most frequent first. Values are text as Postgres prints them. */
  mcv: { value: string; freq: number }[];
  /** histogram bucket bounds, ascending, as text */
  histogram: string[];
}

/** pg_stats for some columns of a table. Prefers the inherited (whole partitioned table) row when both exist. */
export async function readColumnStats(
  c: pg.Client,
  t: TableInfo,
  columns: string[],
): Promise<Map<string, ColumnStats>> {
  if (columns.length === 0) return new Map();
  const r = await c.query<{
    attname: string;
    inherited: boolean;
    null_frac: number;
    n_distinct: number;
    mcv: string[] | null;
    freqs: number[] | null;
    hist: string[] | null;
  }>(
    // anyarray -> text -> text[] is the supported way to read the values without parsing array syntax ourselves
    ll(`SELECT attname, inherited, null_frac::float8 AS null_frac, n_distinct::float8 AS n_distinct,
               most_common_vals::text::text[] AS mcv, most_common_freqs::float8[] AS freqs,
               histogram_bounds::text::text[] AS hist
          FROM pg_stats WHERE schemaname = $1 AND tablename = $2 AND attname = ANY($3::text[])`),
    [t.schema, t.name, columns],
  );
  const out = new Map<string, ColumnStats>();
  for (const row of r.rows) {
    const prev = out.get(row.attname);
    if (prev && prev.inherited && !row.inherited) continue;
    out.set(row.attname, {
      column: row.attname,
      inherited: row.inherited,
      nullFrac: row.null_frac,
      nDistinct: row.n_distinct,
      mcv: (row.mcv ?? []).map((value, i) => ({ value, freq: row.freqs?.[i] ?? 0 })),
      histogram: row.hist ?? [],
    });
  }
  return out;
}
