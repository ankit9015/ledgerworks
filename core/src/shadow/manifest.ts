import { z } from 'zod';

export const MANIFEST_VERSION = 1;

/** How the data of a sampled shadow was chosen. See sampling.ts. */
export const SamplingRuleSchema = z.object({
  /** schema-qualified root table whose rows are sampled directly, e.g. "public.tenants" */
  rootTable: z.string(),
  /** fraction of root rows kept, 0 < ratio <= 1 */
  ratio: z.number().gt(0).lte(1),
  /** integer seed of the deterministic hash selection */
  seed: z.number().int(),
  /** what to do with tables that are neither the root nor reachable from it through foreign keys */
  uncovered: z.enum(['referenced', 'full', 'empty']),
  /** what to do with tables that have no foreign-key link to the sampled graph at all */
  isolated: z.enum(['full', 'empty']),
  /** schema-qualified tables copied completely whatever the rule says */
  fullTables: z.array(z.string()),
});
export type SamplingRule = z.infer<typeof SamplingRuleSchema>;

export const TableManifestSchema = z.object({
  schema: z.string(),
  name: z.string(),
  kind: z.enum(['table', 'partition', 'partitioned-table']),
  /** rows in the source, counted inside the clone's snapshot */
  sourceRows: z.number().int().nonnegative(),
  /** rows in the shadow after loading, counted on the shadow */
  shadowRows: z.number().int().nonnegative(),
  /** shadowRows / sourceRows (1 for an empty table that was copied completely) */
  ratio: z.number().nonnegative(),
  /** why this table has the rows it has */
  selection: z.enum([
    'all',
    'root',
    'child',
    'referenced',
    'full-override',
    'isolated-full',
    'empty',
  ]),
  /** the filter applied to the source (SQL, no data values beyond the sampling threshold) */
  predicate: z.string().nullable(),
});
export type TableManifest = z.infer<typeof TableManifestSchema>;

const StageSchema = z.object({ name: z.string(), durationMs: z.number().nonnegative() });

export const ShadowManifestSchema = z.object({
  manifestVersion: z.literal(MANIFEST_VERSION),
  /** equals the run id, the container label ledgerworks.shadow.run-id and the marker row */
  id: z.string(),
  createdAt: z.string(),
  finishedAt: z.string(),
  source: z.object({
    database: z.string(),
    serverVersion: z.string(),
    /** the source role could not write (checked), or the override was used */
    readOnlyCheck: z.object({
      canWrite: z.boolean(),
      overrideUsed: z.boolean(),
      reasons: z.array(z.string()),
    }),
  }),
  mode: z.enum(['full', 'sampled']),
  sampling: SamplingRuleSchema.nullable(),
  /** Read this before reporting any timing taken on this shadow. */
  scaling: z.object({
    sampled: z.boolean(),
    /** sum of shadow rows / sum of source rows over all tables */
    totalRowRatio: z.number(),
    /** shadow rows / source rows of the largest source table */
    largestTableRatio: z.number(),
    note: z.string(),
  }),
  tables: z.array(TableManifestSchema),
  container: z.object({
    name: z.string(),
    volume: z.string(),
    limits: z.object({
      cpus: z.number(),
      memoryMiB: z.number(),
      memorySwapMiB: z.number(),
      shmMiB: z.number(),
      pidsLimit: z.number(),
    }),
    host: z.object({ cpus: z.number(), memoryMiB: z.number(), dockerVersion: z.string() }),
    sourceReserve: z.object({ cpus: z.number(), memoryMiB: z.number() }),
  }),
  image: z.object({
    tag: z.string(),
    id: z.string(),
    postgresVersion: z.string(),
    hypopgVersion: z.string().nullable(),
    pgStatStatementsVersion: z.string().nullable(),
  }),
  extensions: z.object({
    source: z.array(z.string()),
    shadow: z.array(z.string()),
  }),
  roles: z.array(z.object({ name: z.string(), bypassRls: z.boolean(), wasSuperuser: z.boolean() })),
  /** Planner-relevant settings, source and shadow side by side (they differ when memory differs). */
  settings: z.array(z.object({ name: z.string(), source: z.string(), shadow: z.string() })),
  copy: z.object({
    method: z.literal('schema-dump+copy-stream'),
    parallelism: z.number(),
    maxSourceMBps: z.number().nullable(),
    snapshot: z.literal('exported-repeatable-read'),
    sourceStatementTimeoutMs: z.number(),
  }),
  stages: z.array(StageSchema),
  /** everything, including the settle stage */
  totalDurationMs: z.number().nonnegative(),
  /** totalDurationMs without the settle stage (absent in manifests written before settling became the default) */
  cloneDurationMs: z.number().nonnegative().optional(),
  /** the settle stage: wait for autovacuum, VACUUM (ANALYZE), CHECKPOINT (absent in older manifests) */
  settle: z
    .object({
      performed: z.boolean(),
      waitedForAutovacuumMs: z.number(),
      vacuumAnalyzeMs: z.number(),
      checkpointMs: z.number(),
    })
    .optional(),
  memory: z.object({
    /** highest value seen by polling `docker stats` of the shadow container (working set) */
    shadowPeakSampledMiB: z.number().nullable(),
    /** cgroup memory.peak of the shadow container (includes reclaimable page cache) */
    shadowCgroupPeakMiB: z.number().nullable(),
    /** same polling for the source container, when it was named */
    sourcePeakSampledMiB: z.number().nullable(),
    samples: z.number().int(),
  }),
  sourceContainerHealth: z
    .object({
      name: z.string(),
      oomKilledBefore: z.boolean(),
      oomKilledAfter: z.boolean(),
      restartCountBefore: z.number(),
      restartCountAfter: z.number(),
      startedAtBefore: z.string(),
      startedAtAfter: z.string(),
    })
    .nullable(),
  warnings: z.array(z.string()),
});
export type ShadowManifest = z.infer<typeof ShadowManifestSchema>;

/** Throws if `value` is not a valid manifest. Also refuses anything that looks like a credential. */
export function parseManifest(value: unknown): ShadowManifest {
  const m = ShadowManifestSchema.parse(value);
  const text = JSON.stringify(m);
  if (/postgres(ql)?:\/\/[^"\s]*:[^"\s@]+@/i.test(text)) {
    throw new Error('Manifest contains a connection string with a password');
  }
  return m;
}
