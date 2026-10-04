import { z } from 'zod';

/**
 * A typed plan tree from `EXPLAIN (FORMAT JSON)` (estimates only, as the source tool gives it) or
 * `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` (as the measurement harness gives it). Every node has a
 * path (see `nodePath`) that findings point to. Strings in here (relation names, conditions, sort
 * keys) are database or query text: the analyzer never copies them into prose, and findings carry
 * them only as untrusted-marked fields.
 */

export interface RawPlanNode {
  'Node Type': string;
  Plans?: RawPlanNode[];
  [k: string]: unknown;
}

/** only the shape is checked here; every field is read defensively in convert() */
const RawNode: z.ZodType<RawPlanNode> = z.lazy(() =>
  z.object({ 'Node Type': z.string(), Plans: z.array(RawNode).optional() }).passthrough(),
);

const ExplainSchema = z
  .array(
    z
      .object({
        Plan: RawNode,
        'Planning Time': z.number().optional(),
        'Execution Time': z.number().optional(),
      })
      .passthrough(),
  )
  .min(1);

export interface PlanNode {
  /** "0" for the root, "0.1" for its second child, "0.1.0" for that child's first child */
  path: string;
  nodeType: string;
  parentRelationship: string | null;
  joinType: string | null;
  strategy: string | null;
  schema: string | null;
  relation: string | null;
  alias: string | null;
  indexName: string | null;
  scanDirection: string | null;
  startupCost: number | null;
  totalCost: number | null;
  /** the planner's estimate of rows PER LOOP */
  planRows: number | null;
  /** present only for EXPLAIN ANALYZE */
  actual: { rows: number; loops: number; startupMs: number | null; totalMs: number | null } | null;
  filter: string | null;
  indexCond: string | null;
  recheckCond: string | null;
  joinFilter: string | null;
  hashCond: string | null;
  mergeCond: string | null;
  rowsRemovedByFilter: number | null;
  rowsRemovedByIndexRecheck: number | null;
  heapFetches: number | null;
  exactHeapBlocks: number | null;
  lossyHeapBlocks: number | null;
  sortKey: string[];
  presortedKey: string[];
  sortMethod: string | null;
  sortSpaceUsedKb: number | null;
  sortSpaceType: string | null;
  hashBatches: number | null;
  originalHashBatches: number | null;
  peakMemoryKb: number | null;
  subplansRemoved: number | null;
  tempBlocksWritten: number | null;
  workersPlanned: number | null;
  workersLaunched: number | null;
  children: PlanNode[];
}

export interface ParsedPlan {
  /** true when the plan has actual rows and timings (EXPLAIN ANALYZE) */
  analyzed: boolean;
  planningMs: number | null;
  executionMs: number | null;
  root: PlanNode;
}

export class PlanParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanParseError';
  }
}

const nOf = (r: RawPlanNode, k: string): number | null =>
  typeof r[k] === 'number' ? (r[k] as number) : null;
const sOf = (r: RawPlanNode, k: string): string | null =>
  typeof r[k] === 'string' ? (r[k] as string) : null;
const slOf = (r: RawPlanNode, k: string): string[] =>
  Array.isArray(r[k]) ? (r[k] as unknown[]).filter((x): x is string => typeof x === 'string') : [];

function convert(r: RawPlanNode, path: string): PlanNode {
  const rows = nOf(r, 'Actual Rows');
  return {
    path,
    nodeType: r['Node Type'],
    parentRelationship: sOf(r, 'Parent Relationship'),
    joinType: sOf(r, 'Join Type'),
    strategy: sOf(r, 'Strategy'),
    schema: sOf(r, 'Schema'),
    relation: sOf(r, 'Relation Name'),
    alias: sOf(r, 'Alias'),
    indexName: sOf(r, 'Index Name'),
    scanDirection: sOf(r, 'Scan Direction'),
    startupCost: nOf(r, 'Startup Cost'),
    totalCost: nOf(r, 'Total Cost'),
    planRows: nOf(r, 'Plan Rows'),
    actual:
      rows === null
        ? null
        : {
            rows,
            loops: nOf(r, 'Actual Loops') ?? 1,
            startupMs: nOf(r, 'Actual Startup Time'),
            totalMs: nOf(r, 'Actual Total Time'),
          },
    filter: sOf(r, 'Filter'),
    indexCond: sOf(r, 'Index Cond'),
    recheckCond: sOf(r, 'Recheck Cond'),
    joinFilter: sOf(r, 'Join Filter'),
    hashCond: sOf(r, 'Hash Cond'),
    mergeCond: sOf(r, 'Merge Cond'),
    rowsRemovedByFilter: nOf(r, 'Rows Removed by Filter'),
    rowsRemovedByIndexRecheck: nOf(r, 'Rows Removed by Index Recheck'),
    heapFetches: nOf(r, 'Heap Fetches'),
    exactHeapBlocks: nOf(r, 'Exact Heap Blocks'),
    lossyHeapBlocks: nOf(r, 'Lossy Heap Blocks'),
    sortKey: slOf(r, 'Sort Key'),
    presortedKey: slOf(r, 'Presorted Key'),
    sortMethod: sOf(r, 'Sort Method'),
    sortSpaceUsedKb: nOf(r, 'Sort Space Used'),
    sortSpaceType: sOf(r, 'Sort Space Type'),
    hashBatches: nOf(r, 'Hash Batches'),
    originalHashBatches: nOf(r, 'Original Hash Batches'),
    peakMemoryKb: nOf(r, 'Peak Memory Usage'),
    subplansRemoved: nOf(r, 'Subplans Removed'),
    tempBlocksWritten: nOf(r, 'Temp Written Blocks'),
    workersPlanned: nOf(r, 'Workers Planned'),
    workersLaunched: nOf(r, 'Workers Launched'),
    children: (r.Plans ?? []).map((c, i) => convert(c, `${path}.${i}`)),
  };
}

/** Parses the JSON of an EXPLAIN (FORMAT JSON) result: the array the server returns, or its text. Throws PlanParseError. */
export function parsePlan(explainJson: unknown): ParsedPlan {
  let value = explainJson;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw new PlanParseError('the plan text is not JSON');
    }
  }
  const p = ExplainSchema.safeParse(value);
  if (!p.success)
    throw new PlanParseError(`not an EXPLAIN (FORMAT JSON) result: ${p.error.issues[0]?.message}`);
  const top = p.data[0]!;
  const root = convert(top.Plan, '0');
  return {
    analyzed: root.actual !== null,
    planningMs: top['Planning Time'] ?? null,
    executionMs: top['Execution Time'] ?? null,
    root,
  };
}

/** every node, parents before children */
export function* walk(node: PlanNode): Generator<PlanNode> {
  yield node;
  for (const c of node.children) yield* walk(c);
}

export function findNode(plan: ParsedPlan, path: string): PlanNode | undefined {
  for (const n of walk(plan.root)) if (n.path === path) return n;
  return undefined;
}

/** rows a node produced over the whole run (actual rows x loops), or the planner's estimate x loops of 1 when not analyzed */
export function totalRows(n: PlanNode): number | null {
  if (n.actual) return n.actual.rows * n.actual.loops;
  return n.planRows;
}
