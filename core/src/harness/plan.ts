import type { Buffers, PlanSummary } from './schema.js';

type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

function* walk(node: PlanNode): Generator<PlanNode> {
  yield node;
  for (const child of node.Plans ?? []) yield* walk(child);
}

/**
 * Parses the output of EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON): either the array that the server
 * returns or its single element. Throws when the shape is not a plan.
 */
export function summarizePlan(json: unknown): PlanSummary {
  const root = (Array.isArray(json) ? json[0] : json) as Record<string, unknown> | undefined;
  const top = root?.Plan as PlanNode | undefined;
  if (!root || !top || typeof top['Node Type'] !== 'string') {
    throw new Error('not an EXPLAIN (FORMAT JSON) plan');
  }
  const nodes = [...walk(top)];
  const nodeTypes = [...new Set(nodes.map((n) => String(n['Node Type'])))];
  const scans = nodes
    .filter((n) => /Scan$/.test(String(n['Node Type'])))
    .map((n) => ({
      nodeType: String(n['Node Type']),
      relation: typeof n['Relation Name'] === 'string' ? n['Relation Name'] : null,
      index: typeof n['Index Name'] === 'string' ? n['Index Name'] : null,
    }));
  // PostgreSQL 16 names it "I/O Read Time", 17 and later "Shared I/O Read Time".
  const io = top['Shared I/O Read Time'] ?? top['I/O Read Time'];
  const buffers: Buffers = {
    sharedHit: num(top['Shared Hit Blocks']),
    sharedRead: num(top['Shared Read Blocks']),
    sharedDirtied: num(top['Shared Dirtied Blocks']),
    sharedWritten: num(top['Shared Written Blocks']),
    tempRead: num(top['Temp Read Blocks']),
    tempWritten: num(top['Temp Written Blocks']),
    ioReadMs: typeof io === 'number' ? io : null,
  };
  return {
    executionMs: num(root['Execution Time']),
    planningMs: num(root['Planning Time']),
    rows: num(top['Actual Rows']),
    buffers,
    nodeTypes,
    scans,
    usesSeqScan: scans.some((s) => s.nodeType === 'Seq Scan'),
    usesIndexScan: scans.some((s) =>
      /^(Index Scan|Index Only Scan|Bitmap Index Scan)$/.test(s.nodeType),
    ),
    usesSort: nodeTypes.some((t) => /Sort$/.test(t)),
  };
}
