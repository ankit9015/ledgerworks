import type pg from 'pg';
import { z } from 'zod';
import {
  ToolRegistry,
  noSpans,
  createPostgresTools,
  type ConnectionFactory,
  type PostgresToolsConfig,
} from '@ledgerworks/core';
import {
  parseForeignKeyDefinition,
  parseIndexDefinition,
  parsePartitionKey,
} from '../sql/indexdef.js';
import { ll, withSource } from '../workload/source.js';

/**
 * The schema as Ledgerlens uses it: tables, columns, indexes (as structure), foreign keys,
 * partitioning and (when read) table activity. It is built from the output of the `describe_schema`
 * tool (index definitions and constraint definitions are read by the real SQL parser), plus one small
 * read of pg_stat_user_tables for the counters the tool does not give.
 *
 * Names in here are database text. They are used to build SQL only through sql/ident.ts, and shown
 * to a model only wrapped as untrusted.
 */

export interface SnapshotColumn {
  name: string;
  type: string;
  notNull: boolean;
}
export interface SnapshotIndexColumn {
  /** null for an expression */
  name: string | null;
  desc: boolean;
  nullsFirst: boolean | null;
  opclass: string | null;
}
export interface SnapshotIndex {
  name: string;
  method: string;
  unique: boolean;
  primary: boolean;
  valid: boolean;
  columns: SnapshotIndexColumn[];
  include: string[];
  predicate: string | null;
  sizeBytes: number | null;
}
export interface SnapshotForeignKey {
  name: string;
  columns: string[];
  refSchema: string | null;
  refTable: string;
  refColumns: string[];
}
export interface TableActivity {
  liveTuples: number;
  deadTuples: number;
  modsSinceAnalyze: number;
  lastAnalyze: string | null;
  lastAutoanalyze: string | null;
  seqScans: number;
  idxScans: number;
}
export interface SnapshotTable {
  schema: string;
  name: string;
  kind: 'table' | 'partitioned_table' | 'view' | 'materialized_view';
  estimatedRows: number | null;
  totalBytes: number;
  columns: SnapshotColumn[];
  indexes: SnapshotIndex[];
  foreignKeys: SnapshotForeignKey[];
  /** e.g. "RANGE (occurred_at)" */
  partitionKey: string | null;
  /** names of the partitions (as many as the tool listed) */
  partitions: string[];
  partitionCount: number;
  partitionsTruncated: boolean;
  /** plain columns of the partition key (expressions are not listed) */
  partitionKeyColumns: string[];
  activity: TableActivity | null;
}
export interface SchemaSnapshot {
  serverVersion: string;
  tables: SnapshotTable[];
  tablesTruncated: boolean;
  hypopgInstalled: boolean;
}

export function findTable(
  s: SchemaSnapshot,
  schema: string | null,
  name: string,
): SnapshotTable | undefined {
  return s.tables.find((t) => t.name === name && (schema === null || t.schema === schema));
}

// ---- describe_schema adapter -------------------------------------------------------------------

const Txt = z.union([z.string(), z.object({ $untrusted: z.string() })]);
const plain = (t: z.infer<typeof Txt>): string => (typeof t === 'string' ? t : t.$untrusted);

/** the part of the describe_schema result this reads (the tool's result has more) */
export const DescribeSchemaResultSchema = z.object({
  serverVersion: z.string(),
  tables: z.array(
    z.object({
      schema: Txt,
      name: Txt,
      kind: z.enum(['table', 'partitioned_table', 'view', 'materialized_view']),
      estimatedRows: z.number().nullable(),
      totalBytes: z.number(),
      partitionKey: Txt.nullable().optional(),
      partitions: z.array(z.object({ name: Txt })).optional(),
      partitionsTruncated: z.boolean().optional(),
      columns: z.array(z.object({ name: Txt, type: Txt, notNull: z.boolean() })),
      indexes: z
        .array(
          z.object({
            name: Txt,
            definition: Txt,
            sizeBytes: z.number().nullable(),
            unique: z.boolean(),
            primary: z.boolean(),
            valid: z.boolean(),
          }),
        )
        .optional(),
      constraints: z
        .array(z.object({ name: Txt, kind: z.string(), definition: Txt, validated: z.boolean() }))
        .optional(),
    }),
  ),
  tablesTruncated: z.boolean().optional(),
  extensions: z
    .object({ installed: z.array(z.object({ name: Txt, version: z.string(), schema: Txt })) })
    .optional(),
});
export type DescribeSchemaResult = z.infer<typeof DescribeSchemaResultSchema>;

/** Builds the snapshot from the describe_schema tool result. Index and foreign key definitions are parsed; one that cannot be is skipped and reported in `warnings`. */
export async function snapshotFromDescribeSchema(
  data: unknown,
): Promise<{ snapshot: SchemaSnapshot; warnings: string[] }> {
  const d = DescribeSchemaResultSchema.parse(data);
  const warnings: string[] = [];
  const tables: SnapshotTable[] = [];
  for (const t of d.tables) {
    const schema = plain(t.schema);
    const name = plain(t.name);
    const indexes: SnapshotIndex[] = [];
    for (const i of t.indexes ?? []) {
      try {
        const p = await parseIndexDefinition(plain(i.definition));
        indexes.push({
          name: plain(i.name),
          method: p.method,
          unique: i.unique,
          primary: i.primary,
          valid: i.valid,
          columns: p.columns,
          include: p.include,
          predicate: p.predicate,
          sizeBytes: i.sizeBytes,
        });
      } catch {
        warnings.push(
          `index ${plain(i.name)} on ${schema}.${name}: definition could not be parsed`,
        );
      }
    }
    const foreignKeys: SnapshotForeignKey[] = [];
    for (const c of t.constraints ?? []) {
      if (c.kind !== 'foreign_key') continue;
      try {
        const fk = await parseForeignKeyDefinition(plain(c.definition));
        if (fk) foreignKeys.push({ name: plain(c.name), ...fk });
      } catch {
        warnings.push(
          `constraint ${plain(c.name)} on ${schema}.${name}: definition could not be parsed`,
        );
      }
    }
    tables.push({
      schema,
      name,
      kind: t.kind,
      estimatedRows: t.estimatedRows,
      totalBytes: t.totalBytes,
      columns: t.columns.map((c) => ({
        name: plain(c.name),
        type: plain(c.type),
        notNull: c.notNull,
      })),
      indexes,
      foreignKeys,
      partitionKey: t.partitionKey ? plain(t.partitionKey) : null,
      partitions: (t.partitions ?? []).map((p) => plain(p.name)),
      partitionCount: t.partitions?.length ?? 0,
      partitionsTruncated: t.partitionsTruncated ?? false,
      partitionKeyColumns: t.partitionKey
        ? ((await parsePartitionKey(plain(t.partitionKey)))?.columns ?? [])
        : [],
      activity: null,
    });
  }
  return {
    snapshot: {
      serverVersion: d.serverVersion,
      tables,
      tablesTruncated: d.tablesTruncated ?? false,
      hypopgInstalled: (d.extensions?.installed ?? []).some((e) => plain(e.name) === 'hypopg'),
    },
    warnings,
  };
}

/** pg_stat_user_tables counters for the tables of a snapshot (read-only). Partitions are summed under their parent. */
export async function readActivity(c: pg.Client, snapshot: SchemaSnapshot): Promise<void> {
  const r = await c.query<{
    schemaname: string;
    relname: string;
    parent_schema: string | null;
    parent_name: string | null;
    n_live_tup: string;
    n_dead_tup: string;
    n_mod_since_analyze: string;
    last_analyze: Date | null;
    last_autoanalyze: Date | null;
    seq_scan: string;
    idx_scan: string | null;
  }>(
    ll(`SELECT s.schemaname, s.relname, pn.nspname AS parent_schema, pc.relname AS parent_name,
               s.n_live_tup::text, s.n_dead_tup::text, s.n_mod_since_analyze::text,
               s.last_analyze, s.last_autoanalyze, s.seq_scan::text, s.idx_scan::text
          FROM pg_stat_user_tables s
          LEFT JOIN pg_inherits i ON i.inhrelid = s.relid
          LEFT JOIN pg_class pc ON pc.oid = i.inhparent
          LEFT JOIN pg_namespace pn ON pn.oid = pc.relnamespace`),
  );
  const acc = new Map<string, TableActivity>();
  const key = (s: string, n: string): string => `${s}.${n}`;
  const later = (a: string | null, b: Date | null): string | null =>
    !b ? a : !a || new Date(a) < b ? b.toISOString() : a;
  for (const row of r.rows) {
    const k = row.parent_name
      ? key(row.parent_schema!, row.parent_name)
      : key(row.schemaname, row.relname);
    const a = acc.get(k) ?? {
      liveTuples: 0,
      deadTuples: 0,
      modsSinceAnalyze: 0,
      lastAnalyze: null,
      lastAutoanalyze: null,
      seqScans: 0,
      idxScans: 0,
    };
    a.liveTuples += Number(row.n_live_tup);
    a.deadTuples += Number(row.n_dead_tup);
    a.modsSinceAnalyze += Number(row.n_mod_since_analyze);
    a.lastAnalyze = later(a.lastAnalyze, row.last_analyze);
    a.lastAutoanalyze = later(a.lastAutoanalyze, row.last_autoanalyze);
    a.seqScans += Number(row.seq_scan);
    a.idxScans += Number(row.idx_scan ?? 0);
    acc.set(k, a);
  }
  for (const t of snapshot.tables) t.activity = acc.get(key(t.schema, t.name)) ?? null;
}

/**
 * Reads the schema of the source database: runs the describe_schema tool (read-only, with its
 * limits), adapts its result, and adds table activity. `schemas` limits what is described.
 */
export async function readSnapshot(
  cfg: PostgresToolsConfig,
  connect: ConnectionFactory,
  o: { schemas?: string[]; maxTables?: number } = {},
): Promise<{ snapshot: SchemaSnapshot; warnings: string[] }> {
  const tool = createPostgresTools(cfg).tools.find((t) => t.name === 'describe_schema')!;
  const registry = new ToolRegistry().register(tool);
  const res = await registry.run(
    'describe_schema',
    { schemas: o.schemas, max_tables: o.maxTables ?? 100, include_indexes: true },
    { connect, callId: 'ledgerlens-schema', span: noSpans },
  );
  if (!res.ok) throw new Error(`describe_schema failed: ${res.error?.code}: ${res.error?.message}`);
  const out = await snapshotFromDescribeSchema(res.data);
  await withSource(connect, (c) => readActivity(c, out.snapshot));
  return out;
}
