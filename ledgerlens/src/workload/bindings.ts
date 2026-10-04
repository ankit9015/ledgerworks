import type pg from 'pg';
import { z } from 'zod';
import type { ColumnReference, ParamUsage, TableRef } from '../sql/parse.js';
import { readColumnStats, readTable, type ColumnStats, type TableInfo } from './source.js';
import type { WorkloadStatement } from './types.js';

/**
 * Parameter bindings (L3.1). pg_stat_statements keeps `$1, $2`, so a statement cannot be measured
 * without concrete values. Where they come from is always recorded:
 *
 *  - `user-supplied`: a file of example values (highest confidence);
 *  - `sampled-from-stats`: values from pg_stats (most_common_vals and histogram_bounds) for the column
 *    each parameter is compared with (found by the SQL parser, see sql/parse.ts);
 *  - `synthesized`: derived from the column type or from the statement's own cast (lowest confidence);
 *  - `not-needed`: the statement has no parameters.
 *
 * A statement without a usable binding is `unverifiable` with a reason and stays in every report.
 *
 * Values are TEXT, and are only ever sent as bound parameters (`toQueryConfig`): the statement text
 * is never built from them, so a value like `'; DROP TABLE x; --` is just data.
 */

export type Provenance = 'user-supplied' | 'sampled-from-stats' | 'synthesized' | 'not-needed';
export type Confidence = 'high' | 'medium' | 'low';

export type ValueOrigin =
  | 'user'
  | 'most_common_value'
  | 'histogram_bound'
  | 'like_prefix_of_sample'
  | 'type_default'
  | 'structural_default';

export interface ParamBinding {
  /** 1-based, as in $1 */
  index: number;
  /** text sent as a bound parameter (null = SQL NULL) */
  value: string | null;
  /** the value is a Postgres array literal for `col = ANY($n)` */
  isArray: boolean;
  provenance: Exclude<Provenance, 'not-needed'>;
  origin: ValueOrigin;
  /** LIMIT / OFFSET: they shape the plan but do not select rows, so they do not lower the provenance of the set */
  structural: boolean;
  /** "table.column" the parameter was matched with (database text), or null */
  column: string | null;
}

export interface BindingSet {
  id: string;
  /** the weakest provenance among the non-structural parameters */
  provenance: Provenance;
  confidence: Confidence;
  params: ParamBinding[];
  notes: string[];
  /** filled by validateBindings */
  validation: { status: 'not_run' | 'ok' | 'rejected' | 'skipped'; detail?: string };
}

export const UNVERIFIABLE_REASONS = [
  'parse_failed', // the text is not valid SQL for the parser
  'table_not_found', // a table of the statement is not visible (dropped, or another search_path)
  'column_not_found', // a compared column was not found in the tables in scope (a derived table, a CTE, a typo)
  'param_without_column_or_type', // a parameter is used in an expression and no cast tells its type
  'no_stats_and_no_type', // the column has no statistics and its type cannot be synthesized
  'type_unsupported_for_synthesis',
  'bindings_rejected_by_server', // every binding set was refused by the server (EXPLAIN failed)
  'user_bindings_invalid', // the user-supplied values do not fit the statement
] as const;
export type UnverifiableReason = (typeof UNVERIFIABLE_REASONS)[number];

export interface StatementBindings {
  queryId: string;
  queryHash: string;
  status: 'bound' | 'unverifiable';
  sets: BindingSet[];
  unverifiable: { reason: UnverifiableReason; detail: string; params: number[] } | null;
}

/** user-supplied values: { "<queryId or queryHash>": [ ["v1", "v2", ...], ... ] } (null = SQL NULL) */
export const UserBindingsFileSchema = z.record(
  z.string(),
  z
    .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
    .min(1)
    .max(20),
);
export type UserBindingsFile = z.infer<typeof UserBindingsFileSchema>;

export interface BindOptions {
  /** how many different binding sets to build per statement (default 3: typical, common and rare values) */
  sets?: number;
  userBindings?: UserBindingsFile;
  /** the time used for synthesized timestamps (default: now) */
  now?: Date;
}

/** The only way values meet SQL: the text stays exactly as pg_stat_statements gave it, the values travel as parameters. */
export function toQueryConfig(
  sqlText: string,
  set: Pick<BindingSet, 'params'>,
): { text: string; values: (string | null)[] } {
  const ordered = [...set.params].sort((a, b) => a.index - b.index);
  return { text: sqlText, values: ordered.map((p) => p.value) };
}

/** A Postgres array literal for a text[] bound parameter, with every element quoted. */
export function arrayLiteral(values: readonly string[]): string {
  return `{${values.map((v) => `"${v.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(',')}}`;
}

// ------------------------------------------------------------------------------------------------

interface ResolvedColumn {
  table: TableInfo;
  column: TableInfo['columns'][number];
}

type Resolver = (ref: TableRef) => Promise<TableInfo | null>;

function qualifierMatches(t: TableRef, q: string): boolean {
  return t.alias !== null ? t.alias === q : t.name === q;
}

async function resolveColumn(
  usage: ParamUsage,
  resolve: Resolver,
): Promise<
  | { ok: true; value: ResolvedColumn }
  | { ok: false; reason: 'table_not_found' | 'column_not_found'; detail: string }
> {
  const ref: ColumnReference | null = usage.column;
  const tablesToTry: TableRef[] = (() => {
    if (usage.role === 'insert_value' || usage.role === 'update_set')
      return usage.targetTable ? [usage.targetTable] : [];
    if (!ref) return [];
    return ref.qualifier
      ? usage.scope.filter((t) => qualifierMatches(t, ref.qualifier!))
      : usage.scope;
  })();
  if (tablesToTry.length === 0)
    return { ok: false, reason: 'column_not_found', detail: 'no table in scope for the column' };
  for (const t of tablesToTry) {
    const info = await resolve(t);
    if (!info) return { ok: false, reason: 'table_not_found', detail: `table ${t.name} not found` };
    const col =
      ref?.name !== undefined
        ? info.columns.find((c) => c.name === ref.name)
        : usage.insertPosition !== null
          ? info.columns[usage.insertPosition]
          : undefined;
    if (col) return { ok: true, value: { table: info, column: col } };
  }
  return {
    ok: false,
    reason: 'column_not_found',
    detail: `column ${ref?.name ?? `#${usage.insertPosition}`} not found in the tables in scope`,
  };
}

// ---- value picking -------------------------------------------------------------------------------

const QUANTILES = [0.5, 0.2, 0.8, 0.35, 0.65];
const histAt = (h: string[], q: number): string | undefined =>
  h.length ? h[Math.min(h.length - 1, Math.max(0, Math.round(q * (h.length - 1))))] : undefined;

/** candidate equality values, most "typical" first: the most common value, then spread histogram bounds, then the other common values */
function equalityPool(s: ColumnStats | undefined): string[] {
  if (!s) return [];
  const pool: string[] = [];
  const add = (v: string | undefined): void => {
    if (v !== undefined && !pool.includes(v)) pool.push(v);
  };
  add(s.mcv[0]?.value);
  for (const q of QUANTILES) add(histAt(s.histogram, q));
  for (const m of s.mcv) add(m.value);
  return pool;
}

function synthesizeFor(type: string, now: Date): string | null {
  const t = type.toLowerCase();
  if (/^(smallint|integer|bigint|int2|int4|int8)$/.test(t)) return '1';
  if (/^(numeric|decimal|real|double precision|float4|float8|money)/.test(t)) return '1';
  if (t === 'boolean') return 'true';
  if (t === 'uuid') return '00000000-0000-0000-0000-000000000001';
  if (/^(text|character|varchar|bpchar|citext|name)/.test(t)) return 'x';
  if (t.startsWith('timestamp')) return now.toISOString();
  if (t === 'date') return now.toISOString().slice(0, 10);
  if (t === 'jsonb' || t === 'json') return '{}';
  return null;
}

interface PickContext {
  usage: ParamUsage;
  stats: ColumnStats | undefined;
  column: ResolvedColumn | null;
  /** for between/range: does the statement also bound this column from the other side? */
  pairedRange: boolean;
  listPosition: number;
  setIndex: number;
  now: Date;
  paramCount: number;
}

interface Picked {
  value: string | null;
  isArray: boolean;
  provenance: Exclude<Provenance, 'not-needed'>;
  origin: ValueOrigin;
  structural: boolean;
  note?: string;
}

/**
 * Parameters of functions where the value does not change which rows are read or how: the zone of
 * AT TIME ZONE and the format of to_char. A value that every PostgreSQL accepts is used, and it is
 * labelled structural (like LIMIT) so it does not lower the provenance of the set.
 */
const PLAN_NEUTRAL_FUNCTION_ARGS: Record<string, string> = {
  'timezone:0': 'UTC',
  'to_char:1': 'YYYY-MM-DD HH24:MI:SS',
};

function pick(c: PickContext): Picked | { fail: UnverifiableReason; detail: string } {
  const { usage: u, stats, setIndex: k } = c;
  const typeName = c.column?.column.type ?? u.castType ?? null;
  const fallback = (): Picked | { fail: UnverifiableReason; detail: string } => {
    if (!typeName)
      return {
        fail: 'param_without_column_or_type',
        detail: `$${u.param}: not compared with a column and has no cast: its type and meaning are unknown (it is a function argument, in the select list or in an expression)`,
      };
    const v = synthesizeFor(typeName, c.now);
    if (v === null)
      return {
        fail: stats ? 'type_unsupported_for_synthesis' : 'no_stats_and_no_type',
        detail: `$${u.param}: no statistics and cannot synthesize a value of type ${typeName}`,
      };
    return {
      value: v,
      isArray: false,
      provenance: 'synthesized',
      origin: 'type_default',
      structural: false,
    };
  };
  switch (u.role) {
    case 'limit':
      return {
        value: '50',
        isArray: false,
        provenance: 'synthesized',
        origin: 'structural_default',
        structural: true,
      };
    case 'offset':
      return {
        value: ['0', '100', '1000'][k % 3]!,
        isArray: false,
        provenance: 'synthesized',
        origin: 'structural_default',
        structural: true,
      };
    case 'equality':
    case 'in_list':
    case 'inequality':
    case 'insert_value':
    case 'update_set': {
      const pool = equalityPool(stats);
      if (pool.length === 0) return fallback();
      const stride = u.role === 'in_list' ? 1 : 1;
      const v = pool[(k * stride + c.listPosition) % pool.length]!;
      const origin: ValueOrigin = stats?.mcv.some((m) => m.value === v)
        ? 'most_common_value'
        : 'histogram_bound';
      return {
        value: v,
        isArray: false,
        provenance: 'sampled-from-stats',
        origin,
        structural: false,
      };
    }
    case 'any_array': {
      const pool = equalityPool(stats);
      if (pool.length === 0) return fallback();
      const take = Math.min(3, pool.length);
      const vals = Array.from({ length: take }, (_, i) => pool[(k + i) % pool.length]!);
      return {
        value: arrayLiteral(vals),
        isArray: true,
        provenance: 'sampled-from-stats',
        origin: 'most_common_value',
        structural: false,
      };
    }
    case 'range_lower':
    case 'range_upper':
    case 'between_lower':
    case 'between_upper': {
      const q = QUANTILES[k % QUANTILES.length]!;
      const upper = u.role === 'range_upper' || u.role === 'between_upper';
      // a column bounded from both sides gets a window of about 10% of the histogram; alone, a bound at the quantile
      const at = c.pairedRange ? (upper ? Math.min(1, q + 0.1) : q) : q;
      const v = histAt(stats?.histogram ?? [], at);
      if (v === undefined) {
        // no histogram (few distinct values): the common values are the next best thing for a range test
        const pool = equalityPool(stats);
        if (pool.length) {
          const sorted = [...pool].sort();
          const idx = Math.min(sorted.length - 1, Math.round(at * (sorted.length - 1)));
          return {
            value: sorted[idx]!,
            isArray: false,
            provenance: 'sampled-from-stats',
            origin: 'most_common_value',
            structural: false,
            note: `$${u.param}: no histogram, a most common value was used as the range bound`,
          };
        }
        return fallback();
      }
      return {
        value: v,
        isArray: false,
        provenance: 'sampled-from-stats',
        origin: 'histogram_bound',
        structural: false,
      };
    }
    case 'like': {
      const pool = equalityPool(stats);
      if (pool.length === 0) return fallback();
      const sample = pool[k % pool.length]!;
      const prefix = [...sample].slice(0, 3).join('');
      const escaped = prefix.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
      return {
        value: `${escaped}%`,
        isArray: false,
        provenance: 'sampled-from-stats',
        origin: 'like_prefix_of_sample',
        structural: false,
        note: `$${u.param}: a prefix pattern built from a sampled value; the real patterns are unknown`,
      };
    }
    case 'other': {
      const known = u.functionArg
        ? PLAN_NEUTRAL_FUNCTION_ARGS[`${u.functionArg.name}:${u.functionArg.index}`]
        : undefined;
      if (known !== undefined)
        return {
          value: known,
          isArray: false,
          provenance: 'synthesized',
          origin: 'structural_default',
          structural: true,
          note: `${u.param}: argument ${u.functionArg!.index + 1} of ${u.functionArg!.name}(): a plan-neutral value`,
        };
      return fallback();
    }
  }
}

const RANK: Record<Provenance, number> = {
  'user-supplied': 3,
  'sampled-from-stats': 2,
  synthesized: 1,
  'not-needed': 4,
};

/**
 * Builds binding sets for one statement. `c` is a read-only session on the SOURCE (catalog and
 * pg_stats reads only). Never throws for a statement it cannot bind: it returns `unverifiable`.
 */
export async function bindStatement(
  c: pg.Client,
  stmt: WorkloadStatement,
  o: BindOptions = {},
  cache: {
    tables: Map<string, Promise<TableInfo | null>>;
    stats: Map<string, Promise<Map<string, ColumnStats>>>;
  } = {
    tables: new Map(),
    stats: new Map(),
  },
): Promise<StatementBindings> {
  const base = { queryId: stmt.queryId, queryHash: stmt.queryHash };
  const unverifiable = (
    reason: UnverifiableReason,
    detail: string,
    params: number[] = [],
  ): StatementBindings => ({
    ...base,
    status: 'unverifiable',
    sets: [],
    unverifiable: {
      reason,
      detail: stmt.topLevel ? detail : `${detail} (the statement ran inside a function or trigger)`,
      params,
    },
  });
  const now = o.now ?? new Date();
  const nSets = o.sets ?? 3;

  if (!stmt.parsed)
    return unverifiable('parse_failed', stmt.parseError ?? 'the text could not be parsed');
  const parsed = stmt.parsed;
  if (parsed.paramCount === 0)
    return {
      ...base,
      status: 'bound',
      sets: [
        {
          id: `${stmt.queryHash}-0`,
          provenance: 'not-needed',
          confidence: 'high',
          params: [],
          notes: ['the statement has no parameters'],
          validation: { status: 'not_run' },
        },
      ],
      unverifiable: null,
    };

  // 1. user-supplied values
  const user = o.userBindings?.[stmt.queryId] ?? o.userBindings?.[stmt.queryHash];
  if (user) {
    const bad = user.find((row) => row.length !== parsed.paramCount);
    if (bad)
      return unverifiable(
        'user_bindings_invalid',
        `the statement has ${parsed.paramCount} parameters, a supplied row has ${bad.length}`,
      );
    return {
      ...base,
      status: 'bound',
      sets: user.map((row, i) => ({
        id: `${stmt.queryHash}-u${i}`,
        provenance: 'user-supplied' as const,
        confidence: 'high' as const,
        params: row.map((v, j) => ({
          index: j + 1,
          value: v === null ? null : String(v),
          isArray: false,
          provenance: 'user-supplied' as const,
          origin: 'user' as const,
          structural: false,
          column: null,
        })),
        notes: [],
        validation: { status: 'not_run' as const },
      })),
      unverifiable: null,
    };
  }

  // 2. everything else needs the tables
  const resolve: Resolver = (ref) => {
    const key = `${ref.schema ?? ''}.${ref.name}`;
    let p = cache.tables.get(key);
    if (!p) {
      p = readTable(c, ref);
      cache.tables.set(key, p);
    }
    return p;
  };
  const statsFor = (t: TableInfo, columns: string[]): Promise<Map<string, ColumnStats>> => {
    const key = `${t.oid}:${[...columns].sort().join(',')}`;
    let p = cache.stats.get(key);
    if (!p) {
      p = readColumnStats(c, t, columns);
      cache.stats.set(key, p);
    }
    return p;
  };

  // one usage per parameter is enough to decide its value; the first one with a column wins
  const byParam = new Map<number, ParamUsage[]>();
  for (const u of parsed.usages) byParam.set(u.param, [...(byParam.get(u.param) ?? []), u]);
  const missing: number[] = [];
  for (let n = 1; n <= parsed.paramCount; n++) if (!byParam.has(n)) missing.push(n);
  if (missing.length)
    return unverifiable(
      'param_without_column_or_type',
      `parameters ${missing.map((m) => `$${m}`).join(', ')} are not used in a way the parser could read`,
      missing,
    );

  interface Plan {
    usage: ParamUsage;
    column: ResolvedColumn | null;
    stats: ColumnStats | undefined;
    pairedRange: boolean;
    listPosition: number;
  }
  const plans: Plan[] = [];
  const listCounters = new Map<string, number>();
  const failures: { reason: UnverifiableReason; detail: string; param: number }[] = [];
  for (let n = 1; n <= parsed.paramCount; n++) {
    const usages = byParam.get(n)!;
    // prefer the usage that tells most: one with a column, then the first
    const u = usages.find((x) => x.column !== null) ?? usages[0]!;
    let column: ResolvedColumn | null = null;
    if (u.column || u.role === 'insert_value' || u.role === 'update_set') {
      const r = await resolveColumn(u, resolve);
      if (r.ok) column = r.value;
      else if (u.role !== 'other') {
        failures.push({ reason: r.reason, detail: `$${n}: ${r.detail}`, param: n });
        continue;
      }
    }
    const colKey = column ? `${column.table.oid}.${column.column.name}` : '';
    const listPosition = u.role === 'in_list' ? (listCounters.get(colKey) ?? 0) : 0;
    if (u.role === 'in_list') listCounters.set(colKey, listPosition + 1);
    const pairedRange =
      !!column &&
      parsed.usages.some(
        (x) =>
          x !== u &&
          x.column?.name === u.column?.name &&
          ((u.role === 'range_lower' && x.role === 'range_upper') ||
            (u.role === 'range_upper' && x.role === 'range_lower') ||
            (u.role === 'between_lower' && x.role === 'between_upper') ||
            (u.role === 'between_upper' && x.role === 'between_lower')),
      );
    plans.push({ usage: u, column, stats: undefined, pairedRange, listPosition });
  }
  if (failures.length) {
    const f = failures[0]!;
    return unverifiable(
      f.reason,
      failures.map((x) => x.detail).join('; '),
      failures.map((x) => x.param),
    );
  }
  // statistics, one read per table
  const perTable = new Map<TableInfo, Set<string>>();
  for (const p of plans)
    if (p.column)
      perTable.set(
        p.column.table,
        (perTable.get(p.column.table) ?? new Set()).add(p.column.column.name),
      );
  const statMaps = new Map<TableInfo, Map<string, ColumnStats>>();
  for (const [t, cols] of perTable) statMaps.set(t, await statsFor(t, [...cols]));
  for (const p of plans)
    p.stats = p.column ? statMaps.get(p.column.table)?.get(p.column.column.name) : undefined;

  const sets: BindingSet[] = [];
  const seen = new Set<string>();
  for (let k = 0; k < nSets; k++) {
    const params: ParamBinding[] = [];
    const notes: string[] = [];
    for (const p of plans) {
      const picked = pick({
        usage: p.usage,
        stats: p.stats,
        column: p.column,
        pairedRange: p.pairedRange,
        listPosition: p.listPosition,
        setIndex: k,
        now,
        paramCount: parsed.paramCount,
      });
      if ('fail' in picked) return unverifiable(picked.fail, picked.detail, [p.usage.param]);
      if (picked.note) notes.push(picked.note);
      params.push({
        index: p.usage.param,
        value: picked.value,
        isArray: picked.isArray,
        provenance: picked.provenance,
        origin: picked.origin,
        structural: picked.structural,
        column: p.column ? `${p.column.table.name}.${p.column.column.name}` : null,
      });
    }
    params.sort((a, b) => a.index - b.index);
    const fingerprint = JSON.stringify(params.map((x) => x.value));
    if (seen.has(fingerprint)) continue; // few distinct values: do not report the same set twice
    seen.add(fingerprint);
    const substantive = params.filter((x) => !x.structural);
    const provenance: Provenance = substantive.length
      ? substantive.reduce<Provenance>(
          (w, x) => (RANK[x.provenance] < RANK[w] ? x.provenance : w),
          substantive[0]!.provenance,
        )
      : 'synthesized'; // only LIMIT / OFFSET: nothing was sampled
    const isWrite = parsed.kind !== 'select';
    let confidence: Confidence = provenance === 'sampled-from-stats' ? 'medium' : 'low';
    if (isWrite) {
      confidence = 'low';
      notes.push(
        'write statement: unique, foreign key and check constraints are not checked for these values',
      );
    }
    if (substantive.some((x) => x.origin === 'like_prefix_of_sample')) confidence = 'low';
    sets.push({
      id: `${stmt.queryHash}-${k}`,
      provenance,
      confidence,
      params,
      notes,
      validation: { status: 'not_run' },
    });
  }
  return { ...base, status: 'bound', sets, unverifiable: null };
}
