import { createHash } from 'node:crypto';
import { untrusted } from '@ledgerworks/core';
import type { Finding } from '../analyzer/findings.js';
import type { SchemaSnapshot, SnapshotIndex, SnapshotTable } from '../schema/snapshot.js';
import { IdentifierError } from '../sql/ident.js';
import {
  parseCondition,
  type ColumnReference,
  type ParamUsage,
  type TableRef,
} from '../sql/parse.js';
import type { StatementBindings } from '../workload/bindings.js';
import type { ColumnStats } from '../workload/source.js';
import type { WorkloadStatement } from '../workload/types.js';
import {
  buildAnalyze,
  buildCreateIndex,
  buildDropIndex,
  buildStatsTarget,
  makeIndexName,
  validateSql,
  type BuiltSql,
} from './sqlgen.js';
import {
  DEFAULT_GENERATE_OPTIONS,
  type AdviceCandidate,
  type Candidate,
  type GenerateOptions,
  type IndexKeyColumn,
  type IndexSpec,
  type SkipReason,
  type SkippedCandidate,
  type SqlCandidate,
  type TriggerRef,
} from './types.js';

/**
 * The rules-only advisor (L3.3): no model. From the statements of the workload, the plan findings
 * and the schema it proposes indexes (equality columns first, then one range column, then sort
 * columns; partial and covering variants; CONCURRENTLY always), drops of prefix-redundant indexes,
 * a statistics refresh or target, and advice for rewrites. It never measures anything: speedups are the
 * verifier's job (L3.5). Everything it looked at and did not turn into a candidate is returned in
 * `skipped` with a reason.
 */

export interface StatementInput {
  statement: WorkloadStatement;
  /** binding sets, used to see whether a value is constant in practice (the partial index rule) */
  bindings?: StatementBindings;
  /** findings of the analyzer for this statement's plan */
  findings?: Finding[];
}

export type ColumnStatsLookup = (
  schema: string,
  table: string,
  column: string,
) => ColumnStats | undefined;

export interface GenerateInput {
  statements: StatementInput[];
  snapshot: SchemaSnapshot;
  columnStats?: ColumnStatsLookup;
}

export interface GenerateResult {
  candidates: Candidate[];
  skipped: SkippedCandidate[];
}

const SMALL_FIXED =
  /^(smallint|integer|bigint|int2|int4|int8|real|double precision|boolean|uuid|date|timestamp( with(out)? time zone)?|time( with(out)? time zone)?|numeric(\(\d+(,\d+)?\))?)$/i;
const RANGE_ROLES = new Set(['range_lower', 'range_upper', 'between_lower', 'between_upper']);
const EQUALITY_ROLES = new Set(['equality', 'in_list', 'any_array']);

const idOf = (...parts: string[]): string =>
  `cand_${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 12)}`;

function resolveTable(
  snapshot: SchemaSnapshot,
  ref: TableRef,
): { table?: SnapshotTable; reason?: 'table_not_found' | 'ambiguous_table' } {
  const matches = snapshot.tables.filter(
    (t) => t.name === ref.name && (ref.schema === null || t.schema === ref.schema),
  );
  if (matches.length === 0) return { reason: 'table_not_found' };
  // an unqualified name resolves through search_path; prefer public when several schemas have it
  if (matches.length > 1) {
    const pub = matches.filter((t) => t.schema === 'public');
    if (pub.length === 1) return { table: pub[0]! };
    return { reason: 'ambiguous_table' };
  }
  return { table: matches[0]! };
}

/** which table (and column) a column reference means, among the tables visible where it appears */
function resolveColumn(
  snapshot: SchemaSnapshot,
  ref: ColumnReference,
  scope: TableRef[],
): { table: SnapshotTable; column: string } | null {
  const candidates = ref.qualifier
    ? scope.filter((t) => (t.alias !== null ? t.alias === ref.qualifier : t.name === ref.qualifier))
    : scope;
  for (const t of candidates) {
    const r = resolveTable(snapshot, t);
    if (r.table && r.table.columns.some((c) => c.name === ref.name))
      return { table: r.table, column: ref.name };
  }
  return null;
}

interface Profile {
  table: SnapshotTable;
  equality: string[]; // from parameters, in order of appearance
  joinEquality: string[]; // from column = column
  range: string[];
  /** ORDER BY as plain columns of this table, from the first key until the first one that is not */
  sort: IndexKeyColumn[];
  sortBlockedBy: 'alias' | 'expression' | 'other_table' | null;
  referenced: Set<string>;
  notes: string[];
  functionOnColumn: string[];
}

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

function profileFor(
  snapshot: SchemaSnapshot,
  stmt: WorkloadStatement,
): Map<SnapshotTable, Profile> {
  const parsed = stmt.parsed!;
  const out = new Map<SnapshotTable, Profile>();
  const get = (t: SnapshotTable): Profile => {
    let p = out.get(t);
    if (!p) {
      p = {
        table: t,
        equality: [],
        joinEquality: [],
        range: [],
        sort: [],
        sortBlockedBy: null,
        referenced: new Set(),
        notes: [],
        functionOnColumn: [],
      };
      out.set(t, p);
    }
    return p;
  };
  // every table of the statement gets a profile, so a table with no usable predicate is reported, not forgotten
  for (const ref of parsed.tables) {
    const r = resolveTable(snapshot, ref);
    if (r.table) get(r.table);
  }
  for (const u of parsed.usages) {
    if (!u.column) continue;
    const r = resolveColumn(snapshot, u.column, u.scope);
    if (!r) continue;
    const p = get(r.table);
    if (u.column.viaFunction) {
      p.functionOnColumn.push(r.column);
      continue;
    }
    if (EQUALITY_ROLES.has(u.role)) p.equality.push(r.column);
    else if (RANGE_ROLES.has(u.role)) p.range.push(r.column);
    else if (u.role === 'like')
      p.notes.push(
        'a LIKE pattern is not covered by the generated index (a left-anchored pattern needs text_pattern_ops or a C collation)',
      );
    else if (u.role === 'inequality') p.notes.push('a <> comparison cannot use a b-tree index');
  }
  for (const j of parsed.joinEqualities) {
    for (const side of [j.left, j.right]) {
      const r = resolveColumn(snapshot, side, j.scope);
      if (r) get(r.table).joinEquality.push(r.column);
    }
  }
  for (const c of parsed.columns) {
    const r = resolveColumn(snapshot, c.ref, c.scope);
    if (r) get(r.table).referenced.add(r.column);
  }
  // ORDER BY: only keys that are plain columns of ONE table, from the first, can be served by an index
  const items = parsed.orderBy;
  if (items.length > 0 && parsed.kind === 'select') {
    let table: SnapshotTable | null = null;
    const cols: IndexKeyColumn[] = [];
    let blocked: Profile['sortBlockedBy'] = null;
    for (const it of items) {
      if (!it.column) {
        blocked = it.viaAlias ? 'alias' : 'expression';
        break;
      }
      const scope =
        parsed.columns.find(
          (c) => c.ref.name === it.column!.name && c.ref.qualifier === it.column!.qualifier,
        )?.scope ?? [];
      const r = resolveColumn(snapshot, it.column, scope);
      if (!r || (table && r.table !== table)) {
        blocked = 'other_table';
        break;
      }
      table = r.table;
      cols.push({ name: r.column, desc: it.desc });
    }
    if (table && cols.length) {
      const p = get(table);
      p.sort = cols;
      p.sortBlockedBy = blocked;
    } else if (blocked) {
      // remember on every table of the statement that the sort could not be served
      for (const p of out.values()) p.sortBlockedBy = blocked;
    }
  }
  return out;
}

function sameKey(
  a: { name: string | null; desc: boolean }[],
  b: { name: string; desc: boolean }[],
): boolean {
  return a.length >= b.length && b.every((k, i) => a[i]!.name === k.name);
}

/** does an existing index make the wanted one pointless? (same table, the wanted key is a prefix of the existing key, compatible predicate) */
function coveredBy(
  existing: SnapshotIndex,
  key: IndexKeyColumn[],
  include: string[],
  partial: IndexSpec['partial'],
): boolean {
  if (!existing.valid || existing.method !== 'btree') return false;
  if (!sameKey(existing.columns, key)) return false;
  if (key.length >= 2 || key.some((k) => k.desc)) {
    // directions matter only when they are mixed: compare the pattern, allowing the exact reverse (a backward scan)
    const want = key.map((k) => k.desc);
    const have = existing.columns.slice(0, key.length).map((c) => c.desc);
    const eq = want.every((d, i) => d === have[i]);
    const rev = want.every((d, i) => d !== have[i]);
    if (!eq && !rev) return false;
  }
  if (
    include.length &&
    !include.every(
      (c) => existing.include.includes(c) || existing.columns.some((k) => k.name === c),
    )
  )
    return false;
  if (partial === null) return existing.predicate === null;
  return existing.predicate !== null && existing.predicate.includes(partial.value); // checked more closely by the caller
}

export async function generateCandidates(
  input: GenerateInput,
  options: Partial<GenerateOptions> = {},
): Promise<GenerateResult> {
  const o = { ...DEFAULT_GENERATE_OPTIONS, ...options };
  const { snapshot } = input;
  const skipped: SkippedCandidate[] = [];
  const bySignature = new Map<string, SqlCandidate>();
  const advice = new Map<string, AdviceCandidate>();
  const skip = (reason: SkipReason, subject: string, detail: string, hash: string[]): void => {
    if (
      skipped.some(
        (s) =>
          s.reason === reason &&
          s.subject.$untrusted === untrusted(subject, 200).$untrusted &&
          s.detail === detail,
      )
    ) {
      const s = skipped.find(
        (x) =>
          x.reason === reason &&
          x.subject.$untrusted === untrusted(subject, 200).$untrusted &&
          x.detail === detail,
      )!;
      for (const h of hash) if (!s.targetedStatements.includes(h)) s.targetedStatements.push(h);
      return;
    }
    skipped.push({
      reason,
      subject: untrusted(subject, 200),
      detail,
      targetedStatements: [...hash],
    });
  };

  const add = (c: SqlCandidate): void => {
    const key = `${c.kind}|${c.upSql}`;
    const prev = bySignature.get(key);
    if (!prev) return void bySignature.set(key, c);
    for (const h of c.targetedStatements)
      if (!prev.targetedStatements.includes(h)) prev.targetedStatements.push(h);
    for (const t of c.triggeredBy)
      if (
        !prev.triggeredBy.some(
          (x) =>
            x.queryHash === t.queryHash &&
            x.nodePath === t.nodePath &&
            x.findingKind === t.findingKind,
        )
      )
        prev.triggeredBy.push(t);
    for (const n of c.riskNotes) if (!prev.riskNotes.includes(n)) prev.riskNotes.push(n);
  };

  // ---------------------------------------------------------------- indexes from statements
  for (const si of input.statements) {
    const stmt = si.statement;
    const hash = stmt.queryHash;
    if (
      !stmt.parsed ||
      stmt.parsed.kind === 'insert' ||
      stmt.parsed.kind === 'merge' ||
      stmt.parsed.kind === 'utility'
    )
      continue;
    const trigger: TriggerRef = { findingKind: null, nodePath: null, queryHash: hash };
    const profiles = profileFor(snapshot, stmt);
    for (const ref of stmt.parsed.tables) {
      const r = resolveTable(snapshot, ref);
      if (r.reason === 'table_not_found')
        skip(
          'table_not_found',
          ref.name,
          'the table is not in the schema snapshot (not described, or its name is altered by the schema tool)',
          [hash],
        );
      else if (r.reason === 'ambiguous_table')
        skip(
          'ambiguous_table',
          ref.name,
          'several schemas have a table with this name and the statement does not say which',
          [hash],
        );
    }

    for (const p of profiles.values()) {
      const t = p.table;
      const label = `${t.schema}.${t.name}`;
      // rewrite advice that does not depend on an index
      for (const col of uniq(p.functionOnColumn))
        addAdvice(
          advice,
          'function_on_column',
          t,
          col,
          hash,
          'A function is applied to a column in a predicate, so a plain index on the column cannot be used. Compare the bare column, or create an index on the same expression.',
        );
      if (p.sortBlockedBy === 'alias')
        addAdvice(
          advice,
          'qualify_order_by_alias',
          t,
          null,
          hash,
          'ORDER BY names an output alias that hides a column, so the sort is on the alias expression and no index can supply the order. Qualify the column (ORDER BY table.column) so the order can come from an index.',
        );
      const offsetUse = stmt.parsed.usages.some((u) => u.role === 'offset');
      if (offsetUse && p === [...profiles.values()][0])
        addAdvice(
          advice,
          'offset_pagination',
          t,
          null,
          hash,
          'The statement pages with OFFSET: the server reads and discards every skipped row. Keyset pagination (WHERE (sort columns) < the last row seen) reads only the page.',
        );

      if (t.namesVerified === false) {
        skip(
          'identifier_not_representable',
          label,
          'a name of this table, as the schema tool reports it, differs from the name in the database (control characters and line breaks are removed by the tool), so SQL built from it could point at another object',
          [hash],
        );
        continue;
      }
      if (t.kind !== 'table' && t.kind !== 'partitioned_table') {
        skip(
          'not_a_plain_table',
          label,
          'only tables get indexes (views and materialized views are not indexed here)',
          [hash],
        );
        continue;
      }
      const paramEq = uniq(p.equality);
      const joinEq = uniq(p.joinEquality).filter((c) => !paramEq.includes(c));
      const range = uniq(p.range).filter((c) => !paramEq.includes(c));
      const hasSort = p.sort.length > 0;
      if (
        paramEq.length + joinEq.length + range.length === 0 &&
        !(hasSort && stmt.parsed.hasLimit)
      ) {
        skip(
          'no_indexable_predicate',
          label,
          'no equality, range or (with LIMIT) sort column of this table to build an index on',
          [hash],
        );
        continue;
      }
      if ((t.estimatedRows ?? 0) < o.minTableRows) {
        skip(
          'tiny_table',
          label,
          `the table has about ${Math.round(t.estimatedRows ?? 0)} rows, fewer than ${o.minTableRows}: a sequential scan is cheap`,
          [hash],
        );
        continue;
      }
      if (t.kind === 'partitioned_table' && (t.partitionsTruncated || t.partitions.length === 0)) {
        skip(
          'partition_list_incomplete',
          label,
          'the partitions of this table were not all listed, so one index per partition cannot be generated',
          [hash],
        );
        continue;
      }

      // ---- key: equality columns, then one range column, then the sort columns
      const notes = [...p.notes];
      let key: IndexKeyColumn[] = [...paramEq, ...joinEq].map((name) => ({ name, desc: false }));
      // how many leading key columns decide WHICH rows and the leading ORDER: the rest only break ties between equal sort values
      let essentialLen = -1;
      const rangeCol = range[0];
      if (range.length > 1)
        notes.push(
          'only the first range column goes into the key: columns after a range cannot be used to seek',
        );
      if (rangeCol) key.push({ name: rangeCol, desc: false });
      if (hasSort) {
        const sortCols = p.sort;
        const first = sortCols[0]!;
        const base = first.desc;
        if (rangeCol && first.name !== rangeCol) {
          notes.push(
            'ORDER BY is not served: the first sort column differs from the range column, and a range scan breaks the order',
          );
        } else {
          const rest = rangeCol ? sortCols.slice(1) : sortCols;
          if (!rangeCol && !key.some((k) => k.name === first.name)) essentialLen = key.length + 1;
          else essentialLen = key.length;
          for (const c of rest) {
            if (key.some((k) => k.name === c.name)) continue;
            // normalise so that the first sort column is ascending; a mixed direction stays explicit (a backward scan serves the reverse)
            key.push({ name: c.name, desc: c.desc !== base });
          }
          if (
            rangeCol &&
            first.name === rangeCol &&
            first.desc !== false &&
            sortCols.some((c) => c.desc !== base)
          ) {
            // the range column is the first sort column: its direction is the baseline (ascending)
          }
        }
        if (p.sortBlockedBy)
          notes.push('only the leading ORDER BY columns that are plain columns were used');
      } else if (p.sortBlockedBy === 'alias') {
        notes.push(
          'ORDER BY names an output alias: the sort is on an expression and the index cannot supply the order (see the rewrite suggestion)',
        );
      }
      if (key.length > o.maxKeyColumns) {
        key = key.slice(0, o.maxKeyColumns);
        notes.push(`the key was cut to ${o.maxKeyColumns} columns`);
      }
      if (key.length === 0) {
        skip('no_indexable_predicate', label, 'no usable key columns after the rules', [hash]);
        continue;
      }

      const mk = async (
        keyCols: IndexKeyColumn[],
        include: string[],
        partial: IndexSpec['partial'],
        variantOf: string | null,
        extraNotes: string[],
        why: string,
      ): Promise<SqlCandidate | null> => {
        // duplicates: an existing index (also a prefix-wise one) already serves this key
        const dup = t.indexes.find((ix) => coveredBy(ix, keyCols, include, partial));
        // an existing index that serves the rows and the leading order leaves only a tie-break sort (an incremental sort):
        // not worth a new index on its own
        if (
          !dup &&
          essentialLen > 0 &&
          essentialLen < keyCols.length &&
          include.length === 0 &&
          partial === null
        ) {
          const head = keyCols.slice(0, essentialLen);
          const near = t.indexes.find((ix) => coveredBy(ix, head, [], null));
          if (near) {
            skip(
              'covered_by_existing_index',
              `${label}: ${near.name}`,
              `an existing index serves the filter and the leading ORDER BY column; the ${keyCols.length - essentialLen} remaining sort column(s) only break ties, which the planner handles with an incremental sort`,
              [hash],
            );
            return null;
          }
        }
        if (dup) {
          if (partial === null || (await partialMatches(dup, partial))) {
            skip(
              'covered_by_existing_index',
              `${label}: ${dup.name}`,
              `an existing ${dup.unique ? 'unique ' : ''}index already starts with these columns (${dup.columns.length} key columns)`,
              [hash],
            );
            return null;
          }
        }
        const name = makeIndexName({
          schema: t.schema,
          table: t.name,
          key: keyCols.map((k) => k.name + (k.desc ? ' desc' : '')),
          include,
          predicate: partial ? `${partial.column}=${partial.value}` : null,
        });
        const spec: IndexSpec = {
          schema: t.schema,
          table: t.name,
          indexName: name,
          method: 'btree',
          key: keyCols,
          include,
          partial,
          partitions: t.kind === 'partitioned_table' ? t.partitions : null,
        };
        let built: BuiltSql;
        try {
          built = buildCreateIndex(spec);
        } catch (e) {
          if (e instanceof IdentifierError) {
            skip(
              'identifier_not_representable',
              label,
              `a name cannot be written safely: ${e.message}`,
              [hash],
            );
            return null;
          }
          throw e;
        }
        await validateSql(built.up, ['IndexStmt', 'AlterTableStmt'], spec);
        await validateSql(built.down, ['DropStmt']);
        const risk = [...notes, ...extraNotes];
        if (spec.partitions)
          risk.push(
            `partitioned table: one concurrent index per partition (${spec.partitions.length}), attached to an index on the parent; assumes the partitions are in the same schema as the parent and are not partitioned themselves`,
          );
        risk.push(
          'an index adds work to every INSERT, UPDATE and DELETE of the table and takes space; the verifier measures both',
        );
        if (partial)
          risk.push(
            "a partial index is only used when the query's condition implies its predicate; a generic (unbound) plan cannot prove that",
          );
        if (include.length)
          risk.push(
            'an index-only scan needs recently vacuumed pages (the visibility map); wide INCLUDE columns make the index larger',
          );
        const c: SqlCandidate = {
          id: idOf('create_index', t.schema, t.name, built.up.join(';')),
          kind: 'create_index',
          table: { schema: t.schema, name: t.name },
          rationale: why,
          subjects: [untrusted(label, 200)],
          targetedStatements: [hash],
          riskNotes: risk,
          triggeredBy: [
            trigger,
            ...(si.findings ?? [])
              .filter(
                (f) =>
                  f.kind === 'seq_scan_selective_filter' ||
                  f.kind === 'large_sort_index_could_order' ||
                  f.kind === 'join_on_unindexed_foreign_key' ||
                  f.kind === 'nested_loop_many_loops',
              )
              .map((f) => ({ findingKind: f.kind, nodePath: f.nodePath, queryHash: hash })),
          ],
          variantOf,
          upSql: built.up.join(';\n'),
          downSql: built.down.join(';\n'),
          upStatements: built.up,
          downStatements: built.down,
          noTransaction: built.noTransaction,
          index: spec,
        };
        add(c);
        return bySignature.get(`${c.kind}|${c.upSql}`)!;
      };

      const shape = [
        paramEq.length ? 'equality' : null,
        joinEq.length ? 'join' : null,
        rangeCol ? 'range' : null,
        hasSort ? 'sort' : null,
      ]
        .filter(Boolean)
        .join(' + ');
      const plain = await mk(
        key,
        [],
        null,
        null,
        [],
        `Index on the columns the statement filters by (${shape}): equality columns first, then the range column, then the sort columns.`,
      );

      if (!o.variants) continue;
      // ---- covering variant
      if (
        stmt.parsed.kind === 'select' &&
        !stmt.parsed.selectsStar &&
        !stmt.parsed.hasSubqueries &&
        !stmt.parsed.hasDerivedRelations
      ) {
        const inKey = new Set(key.map((k) => k.name));
        const extras = [...p.referenced].filter((c) => !inKey.has(c)).sort();
        const types = new Map(t.columns.map((c) => [c.name, c.type]));
        if (
          extras.length >= 1 &&
          extras.length <= o.maxIncludeColumns &&
          extras.every((c) => SMALL_FIXED.test(types.get(c) ?? ''))
        ) {
          await mk(
            key,
            extras,
            null,
            plain?.id ?? null,
            [],
            'The same index with the other columns the statement reads added as INCLUDE columns, so the statement can be answered from the index without visiting the table.',
          );
        }
      }
      // ---- partial variant: one equality column whose value is constant in practice and rare
      if (si.bindings && input.columnStats && paramEq.length > 0) {
        for (const c of paramEq) {
          const usage = stmt.parsed.usages.find(
            (u): u is ParamUsage => u.role === 'equality' && u.column?.name === c,
          );
          if (!usage) continue;
          const sets = si.bindings.sets.filter(
            (s) =>
              s.validation.status !== 'rejected' &&
              s.provenance !== 'synthesized' &&
              s.provenance !== 'not-needed',
          );
          const values = new Set(
            sets.map((s) => s.params.find((x) => x.index === usage.param)?.value),
          );
          if (sets.length === 0 || values.size !== 1) continue;
          const v = [...values][0];
          if (typeof v !== 'string') continue;
          const stats = input.columnStats(t.schema, t.name, c);
          if (!stats) {
            skip(
              'partial_needs_statistics',
              `${label}.${c}`,
              'the value looks constant but the column has no statistics to say how rare it is',
              [hash],
            );
            continue;
          }
          const hit = stats.mcv.find((m) => m.value === v);
          const freq = hit
            ? hit.freq
            : stats.mcv.length
              ? Math.min(...stats.mcv.map((m) => m.freq))
              : null;
          if (freq === null || freq > o.partialMaxFrequency) continue;
          const rest = key.filter((k) => k.name !== c);
          if (rest.length === 0) {
            skip(
              'partial_needs_other_columns',
              `${label}.${c}`,
              'the only predicate is the constant equality: a partial index needs at least one other column',
              [hash],
            );
            continue;
          }
          await mk(
            rest,
            [],
            { column: c, value: v },
            plain?.id ?? null,
            [
              `the value matches about ${(freq * 100).toFixed(1)}% of the rows or fewer (from the column statistics)`,
            ],
            'A partial index on the rows with the constant value the statement asks for: much smaller than the full index.',
          );
        }
      }
    }

    // ---- plan findings that call for statistics rather than an index
    for (const f of si.findings ?? []) {
      if (f.kind !== 'stale_statistics' && f.kind !== 'estimate_mismatch') continue;
      const relName = f.subject.relation?.$untrusted;
      if (!relName) continue;
      const t =
        snapshot.tables.find((x) => x.name === relName) ??
        snapshot.tables.find((x) => x.partitions.includes(relName));
      if (!t) continue;
      if (f.kind === 'stale_statistics') {
        const built = buildAnalyze(t.schema, t.name);
        await validateSql(built.up, ['VacuumStmt']);
        add({
          id: idOf('analyze', t.schema, t.name),
          kind: 'analyze_or_stats_target',
          table: { schema: t.schema, name: t.name },
          rationale:
            'The table has changed a lot since its statistics were gathered; ANALYZE refreshes them so the planner estimates from current data.',
          subjects: [untrusted(`${t.schema}.${t.name}`, 200)],
          targetedStatements: [hash],
          riskNotes: [
            'ANALYZE reads a sample of the table (a short load); it takes no lock that blocks reads or writes',
          ],
          triggeredBy: [{ findingKind: f.kind, nodePath: f.nodePath, queryHash: hash }],
          variantOf: null,
          upSql: built.up.join(';\n'),
          downSql: built.down.join(';\n'),
          upStatements: built.up,
          downStatements: built.down,
          noTransaction: built.noTransaction,
          index: null,
        });
      } else if (
        f.subject.detail &&
        // when the same plan also shows stale statistics, the estimate error is explained by that and ANALYZE comes first
        !(si.findings ?? []).some(
          (x) => x.kind === 'stale_statistics' && x.subject.relation?.$untrusted === relName,
        )
      ) {
        const cond = await parseCondition(f.subject.detail.$untrusted);
        const cols = uniq((cond?.columns ?? []).map((c) => c.name))
          .filter((c) => t.columns.some((x) => x.name === c))
          .slice(0, 3);
        if (cols.length === 0) continue;
        const built = buildStatsTarget(t.schema, t.name, cols, 1000);
        await validateSql(built.up, ['AlterTableStmt', 'VacuumStmt']);
        await validateSql(built.down, ['AlterTableStmt']);
        add({
          id: idOf('stats_target', t.schema, t.name, cols.join(',')),
          kind: 'analyze_or_stats_target',
          table: { schema: t.schema, name: t.name },
          rationale:
            'The planner misjudged how many rows the filter keeps while the statistics are current; a higher statistics target samples more of the column and may improve the estimate.',
          subjects: [untrusted(`${t.schema}.${t.name}`, 200)],
          targetedStatements: [hash],
          riskNotes: [
            'a higher target makes ANALYZE and planning slightly slower; it does not help when the columns are correlated (that needs extended statistics, not generated here)',
          ],
          triggeredBy: [{ findingKind: f.kind, nodePath: f.nodePath, queryHash: hash }],
          variantOf: null,
          upSql: built.up.join(';\n'),
          downSql: built.down.join(';\n'),
          upStatements: built.up,
          downStatements: built.down,
          noTransaction: built.noTransaction,
          index: null,
        });
      }
    }
  }

  // ---------------------------------------------------------------- redundant indexes of the schema
  for (const t of snapshot.tables) {
    if (t.kind !== 'table' && t.kind !== 'partitioned_table') continue;
    if (t.namesVerified === false) {
      skip(
        'identifier_not_representable',
        `${t.schema}.${t.name}`,
        'names of this table do not match the database exactly (see the schema tool note), so no SQL is generated for it',
        [],
      );
      continue;
    }
    for (const a of t.indexes) {
      if (a.primary || a.unique || !a.valid || a.method !== 'btree') continue;
      if (a.columns.some((c) => c.name === null)) continue; // expression index: not compared here
      const better = t.indexes.find(
        (b) =>
          b !== a &&
          b.valid &&
          b.method === 'btree' &&
          b.predicate === a.predicate &&
          b.columns.length >= a.columns.length &&
          a.columns.every(
            (c, i) => b.columns[i]!.name === c.name && b.columns[i]!.desc === c.desc,
          ) &&
          // an identical key is redundant only once (the later name goes); a longer key makes the shorter one redundant
          (b.columns.length > a.columns.length || b.unique || b.primary || b.name < a.name) &&
          a.include.every((c) => b.include.includes(c) || b.columns.some((k) => k.name === c)),
      );
      if (!better) continue;
      if (t.kind === 'partitioned_table') {
        skip(
          'partitioned_table_not_supported',
          `${t.schema}.${t.name}: ${a.name}`,
          'dropping an index of a partitioned table is not generated',
          [],
        );
        continue;
      }
      const spec: IndexSpec = {
        schema: t.schema,
        table: t.name,
        indexName: a.name,
        method: 'btree',
        key: a.columns.map((c) => ({ name: c.name!, desc: c.desc })),
        include: a.include,
        partial: null,
        partitions: null,
      };
      if (a.predicate !== null) continue; // recreating a partial index needs its predicate text: left to a person
      let built: BuiltSql;
      try {
        built = buildDropIndex(t.schema, a.name, spec);
      } catch (e) {
        if (e instanceof IdentifierError) {
          skip(
            'identifier_not_representable',
            `${t.schema}.${t.name}`,
            `a name cannot be written safely: ${e.message}`,
            [],
          );
          continue;
        }
        throw e;
      }
      await validateSql(built.up, ['DropStmt']);
      await validateSql(built.down, ['IndexStmt'], spec);
      add({
        id: idOf('drop_redundant_index', t.schema, a.name),
        kind: 'drop_redundant_index',
        table: { schema: t.schema, name: t.name },
        rationale:
          'Another index on the same table starts with all the columns of this one, so this one adds write cost and space without serving a query the other cannot.',
        subjects: [
          untrusted(`${t.schema}.${t.name}: ${a.name}`, 200),
          untrusted(`kept: ${better.name}`, 200),
        ],
        targetedStatements: [],
        riskNotes: [
          "a prefix index can still be preferred for its smaller size or a different sort direction or operator class; the verifier re-measures the table's statements without it",
          'the down SQL recreates the index (a rebuild that reads the whole table)',
        ],
        triggeredBy: [],
        variantOf: null,
        upSql: built.up.join(';\n'),
        downSql: built.down.join(';\n'),
        upStatements: built.up,
        downStatements: built.down,
        noTransaction: built.noTransaction,
        index: spec,
      });
    }
  }

  return {
    candidates: [...bySignature.values(), ...advice.values()].sort((x, y) =>
      x.id.localeCompare(y.id),
    ),
    skipped,
  };
}

async function partialMatches(
  ix: SnapshotIndex,
  partial: NonNullable<IndexSpec['partial']>,
): Promise<boolean> {
  if (!ix.predicate) return false;
  const f = await parseCondition(ix.predicate);
  return (
    !!f && f.columns.some((c) => c.name === partial.column) && ix.predicate.includes(partial.value)
  );
}

function addAdvice(
  into: Map<string, AdviceCandidate>,
  adviceKind: AdviceCandidate['advice'],
  t: SnapshotTable,
  column: string | null,
  hash: string,
  text: string,
): void {
  const id = idOf('rewrite_suggestion', adviceKind, t.schema, t.name, column ?? '');
  const prev = into.get(id);
  if (prev) {
    if (!prev.targetedStatements.includes(hash)) prev.targetedStatements.push(hash);
    return;
  }
  into.set(id, {
    id,
    kind: 'rewrite_suggestion',
    table: { schema: t.schema, name: t.name },
    rationale: text,
    subjects: [
      untrusted(column ? `${t.schema}.${t.name}.${column}` : `${t.schema}.${t.name}`, 200),
    ],
    targetedStatements: [hash],
    riskNotes: [
      "advice only: it changes the application's SQL, which Ledgerlens does not do and cannot verify until a rewritten statement is supplied",
    ],
    triggeredBy: [{ findingKind: null, nodePath: null, queryHash: hash }],
    variantOf: null,
    upSql: null,
    downSql: null,
    advice: adviceKind,
  });
}
