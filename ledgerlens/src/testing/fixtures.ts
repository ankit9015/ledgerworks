/** Test-only builders for schema snapshots and workload statements (no database needed). */
import type { SchemaSnapshot, SnapshotIndex, SnapshotTable } from '../schema/snapshot.js';
import { parseStatement } from '../sql/parse.js';
import type { WorkloadStatement } from '../workload/types.js';

export function index(
  name: string,
  cols: string[],
  o: {
    unique?: boolean;
    primary?: boolean;
    include?: string[];
    predicate?: string | null;
    valid?: boolean;
  } = {},
): SnapshotIndex {
  return {
    name,
    method: 'btree',
    unique: o.unique ?? false,
    primary: o.primary ?? false,
    valid: o.valid ?? true,
    columns: cols.map((c) => {
      const desc = c.endsWith(' desc');
      return { name: desc ? c.slice(0, -5) : c, desc, nullsFirst: null, opclass: null };
    }),
    include: o.include ?? [],
    predicate: o.predicate ?? null,
    sizeBytes: 1000,
  };
}

export function table(
  name: string,
  columns: Record<string, string>,
  o: {
    schema?: string;
    rows?: number;
    indexes?: SnapshotIndex[];
    partitions?: string[];
    partitionKey?: string[];
    kind?: SnapshotTable['kind'];
  } = {},
): SnapshotTable {
  return {
    schema: o.schema ?? 'public',
    name,
    kind: o.kind ?? (o.partitions ? 'partitioned_table' : 'table'),
    estimatedRows: o.rows ?? 1_000_000,
    totalBytes: 1_000_000,
    columns: Object.entries(columns).map(([n, type]) => ({ name: n, type, notNull: false })),
    indexes: o.indexes ?? [],
    foreignKeys: [],
    partitionKey: o.partitionKey ? `RANGE (${o.partitionKey.join(', ')})` : null,
    partitions: o.partitions ?? [],
    partitionCount: o.partitions?.length ?? 0,
    partitionsTruncated: false,
    partitionKeyColumns: o.partitionKey ?? [],
    activity: null,
    namesVerified: true,
  };
}

export const snapshotOf = (...tables: SnapshotTable[]): SchemaSnapshot => ({
  serverVersion: '16.15',
  tables,
  tablesTruncated: false,
  hypopgInstalled: true,
});

let counter = 0;
export async function stmt(sql: string): Promise<WorkloadStatement> {
  const p = await parseStatement(sql);
  counter++;
  return {
    queryId: `${counter}`,
    queryHash: counter.toString(16).padStart(16, '0'),
    rank: counter,
    text: sql,
    kind: p.kind,
    calls: 100,
    totalTimeMs: 1000,
    meanTimeMs: 10,
    rows: 10,
    sharedBlksHit: 0,
    sharedBlksRead: 0,
    topLevel: true,
    tables: p.tables,
    paramCount: p.paramCount,
    parsed: p,
    parseError: null,
  };
}
