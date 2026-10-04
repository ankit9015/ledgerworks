import { parseCondition, parseSortKey, type ColumnReference } from '../sql/parse.js';
import type { SchemaSnapshot, SnapshotTable } from '../schema/snapshot.js';
import { ev, fmt, makeFinding, type Finding, type Severity } from './findings.js';
import { totalRows, walk, type ParsedPlan, type PlanNode } from './plan.js';

/**
 * The deterministic plan analyzer (L3.2): no model, no guessing. Every finding comes from numbers in
 * the plan (or in the schema snapshot) and carries them as evidence. Thresholds are explicit and
 * overridable; the defaults are conventions of this tool, recorded in DECISIONS.md (D48), not
 * measured truths: a finding says "this shape is a known cause of slowness", never "this is why".
 */
export interface Thresholds {
  /** a sequential scan counts as "large" from this many rows examined */
  seqScanMinRows: number;
  /** ... and as "selective" when it returns at most this share of them */
  seqScanMaxSelectivity: number;
  /** estimate versus actual: factor at which a node is reported, and the fewest rows (either side) that matter */
  estimateMinFactor: number;
  estimateMinRows: number;
  /** a sort over at least this many rows */
  sortMinRows: number;
  /** a nested loop whose inner side runs at least this many times */
  nestedLoopMinLoops: number;
  /** statistics: modifications since the last analyze as a share of live rows, and at least this many */
  staleModRatio: number;
  staleMinMods: number;
  /** a table is "large" for the foreign key rule from this many rows */
  fkMinTableRows: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  seqScanMinRows: 10_000,
  seqScanMaxSelectivity: 0.1,
  estimateMinFactor: 10,
  estimateMinRows: 100,
  sortMinRows: 5_000,
  nestedLoopMinLoops: 1_000,
  staleModRatio: 0.1,
  staleMinMods: 1_000,
  fkMinTableRows: 10_000,
};

export interface AnalyzeContext {
  /** the schema (indexes, foreign keys, partitions, table activity) when known; rules that need it are skipped without it */
  snapshot?: SchemaSnapshot;
  /** the time "days since analyze" is counted to (default: now) */
  now?: Date;
}

interface Entry {
  node: PlanNode;
  parent: PlanNode | null;
}

const SCAN_TYPES = new Set([
  'Seq Scan',
  'Parallel Seq Scan',
  'Index Scan',
  'Index Only Scan',
  'Bitmap Heap Scan',
  'Parallel Index Scan',
  'Parallel Index Only Scan',
]);
const SEQ_SCANS = new Set(['Seq Scan', 'Parallel Seq Scan']);
const JOINS = new Set(['Nested Loop', 'Hash Join', 'Merge Join']);

const sev = (v: number, medium: number, high: number): Severity =>
  v >= high ? 'high' : v >= medium ? 'medium' : 'low';
const order: Severity[] = ['info', 'low', 'medium', 'high'];
const maxSev = (a: Severity, b: Severity): Severity =>
  order.indexOf(a) >= order.indexOf(b) ? a : b;

function tableOf(snapshot: SchemaSnapshot | undefined, n: PlanNode): SnapshotTable | undefined {
  if (!snapshot || !n.relation) return undefined;
  return (
    snapshot.tables.find((t) => t.name === n.relation && (!n.schema || t.schema === n.schema)) ??
    snapshot.tables.find(
      (t) => t.partitions.includes(n.relation!) && (!n.schema || t.schema === n.schema),
    )
  );
}

/** Every finding the rules produce for one plan, most severe first. Never throws for a plan it understands. */
export async function analyzePlan(
  plan: ParsedPlan,
  ctx: AnalyzeContext = {},
  overrides: Partial<Thresholds> = {},
): Promise<Finding[]> {
  const t = { ...DEFAULT_THRESHOLDS, ...overrides };
  const entries = new Map<string, Entry>();
  const visit = (n: PlanNode, parent: PlanNode | null): void => {
    entries.set(n.path, { node: n, parent });
    for (const c of n.children) visit(c, n);
  };
  visit(plan.root, null);
  const all = [...walk(plan.root)];
  const out: Finding[] = [];
  const analyzed = plan.analyzed;

  // ---- sequential scans with a selective filter -------------------------------------------------
  type SeqHit = { node: PlanNode; examined: number; returned: number; selectivity: number };
  const seqHits: SeqHit[] = [];
  for (const n of all) {
    if (!SEQ_SCANS.has(n.nodeType) || n.filter === null) continue;
    let examined: number | null = null;
    let returned: number | null = null;
    if (n.actual) {
      returned = n.actual.rows * n.actual.loops;
      examined = returned + (n.rowsRemovedByFilter ?? 0) * n.actual.loops;
    } else {
      const tab = tableOf(ctx.snapshot, n);
      if (tab?.estimatedRows != null && n.planRows !== null && tab.kind === 'table') {
        examined = tab.estimatedRows;
        returned = n.planRows;
      }
    }
    if (examined === null || returned === null || examined < t.seqScanMinRows) continue;
    const selectivity = returned / examined;
    if (selectivity > t.seqScanMaxSelectivity) continue;
    seqHits.push({ node: n, examined, returned, selectivity });
  }
  // partitions of one table scanned with the same filter are one finding, at the Append above them
  const groups = new Map<string, SeqHit[]>();
  for (const h of seqHits) {
    const parent = entries.get(h.node.path)!.parent;
    const key =
      parent && (parent.nodeType === 'Append' || parent.nodeType === 'Merge Append')
        ? `${parent.path}|${h.node.filter}`
        : h.node.path;
    groups.set(key, [...(groups.get(key) ?? []), h]);
  }
  for (const hits of groups.values()) {
    const first = hits[0]!;
    const parent = entries.get(first.node.path)!.parent;
    const grouped =
      hits.length > 1 ||
      (parent && (parent.nodeType === 'Append' || parent.nodeType === 'Merge Append'));
    const examined = hits.reduce((a, h) => a + h.examined, 0);
    const returned = hits.reduce((a, h) => a + h.returned, 0);
    const selectivity = returned / examined;
    const anchor = grouped && parent ? parent : first.node;
    const evidence = [
      ev('rowsExamined', examined, 'rows'),
      ev('rowsReturned', returned, 'rows'),
      ev('selectivity', selectivity, 'ratio'),
      ...(grouped ? [ev('scansGrouped', hits.length, 'count')] : []),
      ...(analyzed && first.node.actual?.totalMs != null
        ? [
            ev(
              'scanTimeMsAllWorkers',
              hits.reduce(
                (a, h) => a + (h.node.actual?.totalMs ?? 0) * (h.node.actual?.loops ?? 1),
                0,
              ),
              'ms',
            ),
          ]
        : []),
    ] as const;
    out.push(
      makeFinding({
        kind: 'seq_scan_selective_filter',
        severity: maxSev(
          sev(examined, 100_000, 1_000_000),
          selectivity <= 0.001 ? 'medium' : 'low',
        ),
        node: anchor,
        relatedNodePaths: grouped ? hits.map((h) => h.node.path) : [],
        subject: { relation: first.node.relation, detail: first.node.filter },
        evidence: evidence as unknown as [ReturnType<typeof ev>, ...ReturnType<typeof ev>[]],
        summary: `A sequential scan reads ${fmt(examined)} rows to keep ${fmt(returned)} (${(selectivity * 100).toFixed(selectivity < 0.01 ? 3 : 1)}%).`,
        analyzed,
      }),
    );
  }

  // ---- estimate versus actual (analyzed plans): report where the error STARTS ---------------------
  if (analyzed) {
    const factor = new Map<string, { f: number; est: number; act: number; over: boolean }>();
    for (const n of all) {
      if (!n.actual || n.planRows === null) continue;
      const est = n.planRows * n.actual.loops;
      const act = n.actual.rows * n.actual.loops;
      if (Math.max(est, act) < t.estimateMinRows) continue;
      // below a LIMIT the node stops early: fewer rows than estimated is expected there
      let underLimit = false;
      for (let p = entries.get(n.path)!.parent; p; p = entries.get(p.path)!.parent)
        if (p.nodeType === 'Limit') underLimit = true;
      if (underLimit && act < est) continue;
      const f = (Math.max(est, act) + 1) / (Math.min(est, act) + 1);
      if (f >= t.estimateMinFactor) factor.set(n.path, { f, est, act, over: est > act });
    }
    for (const [path, h] of factor) {
      const node = entries.get(path)!.node;
      // inherited error: a child with the same direction and a similar factor is the origin, not this node
      const inherited = node.children.some((c) => {
        const ch = factor.get(c.path);
        return ch && ch.over === h.over && ch.f >= h.f / 3;
      });
      if (inherited) continue;
      out.push(
        makeFinding({
          kind: 'estimate_mismatch',
          severity: sev(h.f, 100, 1000),
          node,
          subject: {
            relation: node.relation,
            index: node.indexName,
            detail: node.filter ?? node.indexCond,
          },
          evidence: [
            ev('estimatedRows', h.est, 'rows'),
            ev('actualRows', h.act, 'rows'),
            ev('factor', h.f, 'factor'),
          ],
          summary: `The planner expected ${fmt(h.est)} rows and found ${fmt(h.act)}: ${h.over ? 'an overestimate' : 'an underestimate'} by a factor of ${fmt(h.f)}.`,
          analyzed,
        }),
      );
    }
  }

  // ---- sorts ----------------------------------------------------------------------------------------
  for (const n of all) {
    if (n.nodeType !== 'Sort' && n.nodeType !== 'Incremental Sort') continue;
    if (analyzed && n.sortSpaceType === 'Disk') {
      const kb = n.sortSpaceUsedKb ?? 0;
      out.push(
        makeFinding({
          kind: 'sort_spills_to_disk',
          severity: sev(kb, 10_000, 100_000),
          node: n,
          subject: { detail: n.sortKey.join(', ') },
          evidence: [
            ev('sortSpaceKb', kb, 'kb'),
            ev('rowsSorted', totalRows(n) ?? 0, 'rows'),
            ...(n.tempBlocksWritten !== null
              ? [ev('tempBlocksWritten', n.tempBlocksWritten, 'blocks')]
              : []),
          ],
          summary: `A sort used ${fmt(kb)} kB on disk (${n.sortMethod ?? 'external sort'}) because it did not fit in work_mem.`,
          analyzed,
        }),
      );
    }
    if (n.nodeType === 'Sort' && n.sortKey.length > 0) {
      const child = n.children[0];
      const rowsIn = child ? totalRows(child) : null;
      const hasBase = child ? [...walk(child)].some((x) => SCAN_TYPES.has(x.nodeType)) : false;
      if (rowsIn !== null && rowsIn >= t.sortMinRows && hasBase) {
        // a Limit above the sort, also through nodes that only project columns or merge parallel workers (Result, Gather Merge)
        let parent = entries.get(n.path)!.parent;
        while (parent && (parent.nodeType === 'Result' || parent.nodeType === 'Gather Merge'))
          parent = entries.get(parent.path)!.parent;
        const limit = parent?.nodeType === 'Limit' ? parent : null;
        const limitRows = limit ? (limit.actual ? limit.actual.rows : limit.planRows) : null;
        const keys = await Promise.all(n.sortKey.map((k) => parseSortKey(k)));
        const exprKeys = keys.filter((k) => k.column === null).length;
        const topN = limitRows !== null && rowsIn >= 20 * Math.max(1, limitRows);
        out.push(
          makeFinding({
            kind: 'large_sort_index_could_order',
            severity: topN || rowsIn >= 100_000 ? 'high' : sev(rowsIn, 20_000, 100_000),
            node: n,
            relatedNodePaths: limit ? [limit.path] : [],
            subject: { detail: n.sortKey.join(', ') },
            evidence: [
              ev('rowsSorted', rowsIn, 'rows'),
              ev('sortKeys', n.sortKey.length, 'count'),
              ev('sortKeysThatAreExpressions', exprKeys, 'count'),
              ...(limitRows !== null ? [ev('limitRows', limitRows, 'rows')] : []),
              ...(n.actual?.totalMs != null && analyzed
                ? [ev('sortNodeTimeMs', n.actual.totalMs * n.actual.loops, 'ms')]
                : []),
            ],
            summary:
              `${fmt(rowsIn)} rows are sorted${limitRows !== null ? ` to return the first ${fmt(limitRows)}` : ''}; an index on the sort columns could deliver them in order.` +
              (exprKeys > 0
                ? ` ${exprKeys} of ${n.sortKey.length} sort keys are expressions, not columns: an index can only give the order if the query sorts by the column itself.`
                : ''),
            analyzed,
          }),
        );
      }
    }
  }

  // ---- nested loops with many loops (N+1 shape) --------------------------------------------------------
  for (const n of all) {
    if (n.nodeType !== 'Nested Loop' || n.children.length < 2) continue;
    const inner = n.children[1]!;
    const outer = n.children[0]!;
    const loops = inner.actual ? inner.actual.loops : (totalRows(outer) ?? 0);
    if (loops < t.nestedLoopMinLoops) continue;
    const innerMs =
      inner.actual?.totalMs != null ? inner.actual.totalMs * inner.actual.loops : null;
    const share = innerMs !== null && plan.executionMs ? innerMs / plan.executionMs : null;
    out.push(
      makeFinding({
        kind: 'nested_loop_many_loops',
        severity: maxSev(
          sev(loops, 10_000, 100_000),
          share !== null && share >= 0.5 ? 'high' : 'low',
        ),
        node: n,
        relatedNodePaths: [inner.path],
        subject: {
          relation: inner.relation,
          index: inner.indexName,
          detail: inner.indexCond ?? inner.filter,
        },
        evidence: [
          ev(
            inner.actual ? 'innerLoops' : 'outerRowsEstimated',
            loops,
            inner.actual ? 'count' : 'rows',
          ),
          ...(inner.actual ? [ev('innerRowsPerLoop', inner.actual.rows, 'rows')] : []),
          ...(innerMs !== null ? [ev('innerTotalMs', innerMs, 'ms')] : []),
          ...(share !== null ? [ev('shareOfExecutionTime', share, 'ratio')] : []),
        ],
        summary: `The inner side of a nested loop runs ${fmt(loops)} times${innerMs !== null ? `, ${fmt(innerMs)} ms in total` : ' (estimated from the outer side)'}: the shape of one query per row.`,
        analyzed,
      }),
    );
  }

  // ---- hash join in several batches --------------------------------------------------------------------------
  for (const n of all) {
    if (n.nodeType !== 'Hash' || n.hashBatches === null || n.hashBatches <= 1) continue;
    out.push(
      makeFinding({
        kind: 'hash_join_multiple_batches',
        severity: sev(n.hashBatches, 4, 16),
        node: n,
        subject: {},
        evidence: [
          ev('hashBatches', n.hashBatches, 'count'),
          ...(n.originalHashBatches !== null
            ? [ev('originalHashBatches', n.originalHashBatches, 'count')]
            : []),
          ...(n.peakMemoryKb !== null ? [ev('peakMemoryKb', n.peakMemoryKb, 'kb')] : []),
          ...(n.actual ? [ev('hashedRows', n.actual.rows * n.actual.loops, 'rows')] : []),
        ],
        summary: `A hash table was built in ${fmt(n.hashBatches)} batches because it did not fit in work_mem; the rest went through temporary files.`,
        analyzed,
      }),
    );
  }

  // ---- lossy bitmap heap scans ---------------------------------------------------------------------------------------
  for (const n of all) {
    if (n.nodeType !== 'Bitmap Heap Scan' || !n.lossyHeapBlocks) continue;
    const exact = n.exactHeapBlocks ?? 0;
    const share = n.lossyHeapBlocks / (n.lossyHeapBlocks + exact);
    out.push(
      makeFinding({
        kind: 'lossy_bitmap_recheck',
        severity: share >= 0.5 ? 'medium' : 'low',
        node: n,
        subject: { relation: n.relation, detail: n.recheckCond },
        evidence: [
          ev('lossyHeapBlocks', n.lossyHeapBlocks, 'blocks'),
          ev('exactHeapBlocks', exact, 'blocks'),
          ev('lossyShare', share, 'ratio'),
          ev(
            'rowsRemovedByRecheck',
            (n.rowsRemovedByIndexRecheck ?? 0) * (n.actual?.loops ?? 1),
            'rows',
          ),
        ],
        summary: `The bitmap became lossy: ${fmt(n.lossyHeapBlocks)} heap pages are rechecked row by row (${(share * 100).toFixed(0)}% of the pages read) because the bitmap did not fit in work_mem.`,
        analyzed,
      }),
    );
  }

  // ---- join on an unindexed foreign key (needs the schema) -----------------------------------------------------------
  if (ctx.snapshot) {
    for (const n of all) {
      if (!JOINS.has(n.nodeType)) continue;
      const cond = n.hashCond ?? n.mergeCond ?? n.joinFilter ?? null;
      if (!cond) continue;
      const facts = await parseCondition(cond);
      if (!facts) continue;
      const scans = [...walk(n)].filter((x) => x !== n && SEQ_SCANS.has(x.nodeType) && x.relation);
      for (const scan of scans) {
        const tab = tableOf(ctx.snapshot, scan);
        if (!tab || (tab.estimatedRows ?? 0) < t.fkMinTableRows) continue;
        const sideColumns = (side: ColumnReference): boolean =>
          side.qualifier === scan.alias ||
          side.qualifier === scan.relation ||
          (side.qualifier === null && false);
        for (const [l, r] of facts.equalities) {
          for (const mine of [l, r].filter(sideColumns)) {
            const fk = tab.foreignKeys.find(
              (f) => f.columns.length === 1 && f.columns[0] === mine.name,
            );
            if (!fk) continue;
            const covered = tab.indexes.some(
              (i) =>
                i.valid &&
                i.method === 'btree' &&
                i.predicate === null &&
                i.columns[0]?.name === mine.name,
            );
            if (covered) continue;
            const examined = scan.actual
              ? (scan.actual.rows + (scan.rowsRemovedByFilter ?? 0)) * scan.actual.loops
              : (tab.estimatedRows ?? 0);
            out.push(
              makeFinding({
                kind: 'join_on_unindexed_foreign_key',
                severity: sev(tab.estimatedRows ?? 0, 100_000, 1_000_000),
                node: n,
                relatedNodePaths: [scan.path],
                subject: { relation: tab.name, detail: `${fk.name}: (${fk.columns.join(', ')})` },
                evidence: [
                  ev('tableRows', tab.estimatedRows ?? 0, 'rows'),
                  ev('rowsReadBySeqScan', examined, 'rows'),
                  ev('foreignKeyColumns', fk.columns.length, 'count'),
                  ev('indexesOnTable', tab.indexes.length, 'count'),
                ],
                summary: `A join reads a table of ${fmt(tab.estimatedRows ?? 0)} rows sequentially on a foreign key column that has no index.`,
                analyzed,
              }),
            );
          }
        }
      }
    }
  }

  // ---- partitioned table scanned without pruning ----------------------------------------------------------------------
  if (ctx.snapshot) {
    for (const n of all) {
      if (n.nodeType !== 'Append' && n.nodeType !== 'Merge Append') continue;
      const scans = n.children.flatMap((c) =>
        [...walk(c)].filter((x) => SCAN_TYPES.has(x.nodeType) && x.relation),
      );
      if (scans.length < 2) continue;
      const parents = new Set(
        scans
          .map((s) => tableOf(ctx.snapshot, s))
          .filter((x): x is SnapshotTable => !!x && x.partitions.length > 0),
      );
      if (parents.size !== 1) continue;
      const parentTable = [...parents][0]!;
      const partitions = new Set(scans.map((s) => s.relation!));
      const total = parentTable.partitionCount;
      if (
        parentTable.partitionKeyColumns.length === 0 ||
        partitions.size < Math.max(2, 0.9 * total)
      )
        continue;
      let withKey = 0;
      let withAnyCondition = 0;
      for (const s of scans) {
        const conds = [s.indexCond, s.filter, s.recheckCond].filter((x): x is string => !!x);
        if (conds.length) withAnyCondition++;
        let mentions = false;
        for (const c of conds) {
          const f = await parseCondition(c);
          if (f?.columns.some((col) => parentTable.partitionKeyColumns.includes(col.name)))
            mentions = true;
        }
        if (mentions) withKey++;
      }
      if (withKey === scans.length) continue; // conditions on the key everywhere and still all partitions: pruning was not possible by design
      out.push(
        makeFinding({
          kind: 'no_partition_pruning',
          severity: withAnyCondition > 0 ? (partitions.size >= 12 ? 'high' : 'medium') : 'low',
          node: n,
          subject: {
            relation: parentTable.name,
            detail: `partition key (${parentTable.partitionKeyColumns.join(', ')})`,
          },
          evidence: [
            ev('partitionsScanned', partitions.size, 'count'),
            ev('partitionsTotal', total, 'count'),
            ev('subplansRemoved', n.subplansRemoved ?? 0, 'count'),
            ev('scansWithConditionOnKey', withKey, 'count'),
            ev('scansWithAnyCondition', withAnyCondition, 'count'),
          ],
          summary: `${fmt(partitions.size)} of ${fmt(total)} partitions are scanned; ${withKey === 0 ? 'no condition uses the partition key' : `only ${withKey} of ${scans.length} scans have a condition on the partition key`}, so none could be skipped.`,
          analyzed,
        }),
      );
    }
  }

  // ---- stale statistics (needs table activity) -------------------------------------------------------------------------------
  if (ctx.snapshot) {
    const now = ctx.now ?? new Date();
    const reported = new Set<string>();
    for (const n of all) {
      if (!SCAN_TYPES.has(n.nodeType) || !n.relation) continue;
      const tab = tableOf(ctx.snapshot, n);
      const a = tab?.activity;
      if (!tab || !a || reported.has(`${tab.schema}.${tab.name}`)) continue;
      const last = [a.lastAnalyze, a.lastAutoanalyze]
        .filter((x): x is string => !!x)
        .map((x) => new Date(x).getTime());
      const never = last.length === 0;
      const ratio = a.modsSinceAnalyze / Math.max(1, a.liveTuples);
      const stale =
        (!never && a.modsSinceAnalyze >= t.staleMinMods && ratio >= t.staleModRatio) ||
        (never && a.liveTuples >= t.staleMinMods);
      if (!stale) continue;
      reported.add(`${tab.schema}.${tab.name}`);
      const days = never ? null : (now.getTime() - Math.max(...last)) / 86_400_000;
      out.push(
        makeFinding({
          kind: 'stale_statistics',
          severity: never ? 'medium' : ratio >= 0.5 ? 'high' : ratio >= 0.2 ? 'medium' : 'low',
          node: n,
          subject: { relation: tab.name },
          evidence: [
            ev('modificationsSinceAnalyze', a.modsSinceAnalyze, 'rows'),
            ev('liveRows', a.liveTuples, 'rows'),
            ev('modificationRatio', ratio, 'ratio'),
            ...(days !== null ? [ev('daysSinceAnalyze', days, 'days')] : []),
            ev('neverAnalyzed', never ? 1 : 0, 'count'),
          ],
          summary: never
            ? `The table has ${fmt(a.liveTuples)} rows and has never been analyzed.`
            : `${fmt(a.modsSinceAnalyze)} rows changed since the last analyze (${(ratio * 100).toFixed(0)}% of the table, ${fmt(days ?? 0)} days ago).`,
          analyzed,
        }),
      );
    }
  }

  return out.sort(
    (x, y) =>
      order.indexOf(y.severity) - order.indexOf(x.severity) || x.nodePath.localeCompare(y.nodePath),
  );
}
