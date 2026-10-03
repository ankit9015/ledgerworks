import { z } from 'zod';

/** Bump when a field is removed or changes meaning. Adding optional fields does not bump it. */
export const MEASUREMENT_VERSION = 1;

/** All durations are milliseconds. */
export const StatsSchema = z.object({
  n: z.number().int().nonnegative(),
  min: z.number(),
  max: z.number(),
  mean: z.number(),
  /** sample standard deviation (n - 1); 0 when n is 1 */
  stddev: z.number(),
  /** stddev / mean * 100; 0 when the mean is 0 */
  cvPercent: z.number(),
  /** percentiles by linear interpolation between ranks (the "type 7" definition) */
  p50: z.number(),
  p95: z.number(),
});
export type Stats = z.infer<typeof StatsSchema>;

/** What a report built on a measurement must say about the data it ran on. */
export const ShadowRefSchema = z.object({
  /** id of the shadow manifest (= run id) */
  manifestId: z.string(),
  /** true when the shadow holds only part of the data: results are NOT full-scale */
  sampled: z.boolean(),
  mode: z.enum(['full', 'sampled']),
  /** sum of shadow rows / sum of source rows */
  totalRowRatio: z.number(),
  /** shadow rows / source rows of the largest table */
  largestTableRatio: z.number(),
  /** text to print next to any number taken from this measurement */
  scalingNote: z.string(),
});
export type ShadowRef = z.infer<typeof ShadowRefSchema>;

export const StatementClassSchema = z.enum(['read', 'dml', 'ddl', 'non-transactional']);
export type StatementClass = z.infer<typeof StatementClassSchema>;

export const StrategySchema = z.enum([
  /** BEGIN READ ONLY ... ROLLBACK around every run */
  'read-only-transaction',
  /** BEGIN ... ROLLBACK around every run: the statement really runs, its effects are discarded */
  'rollback-transaction',
  /** cannot run in a transaction block: every run gets a fresh shadow */
  'fresh-shadow-per-run',
]);
export type Strategy = z.infer<typeof StrategySchema>;

export const FailureKindSchema = z.enum([
  'refused-not-shadow',
  'invalid-input',
  'connection-error',
  'sql-error',
  'statement-timeout',
  'lock-timeout',
  'max-runtime-exceeded',
  /** the server did not answer within the statement timeout plus a grace period: the connection was dropped */
  'client-watchdog',
  'needs-fresh-shadow',
]);
export type FailureKind = z.infer<typeof FailureKindSchema>;

export const FailureSchema = z.object({
  kind: FailureKindSchema,
  message: z.string(),
  /** Postgres SQLSTATE when the server reported one */
  sqlState: z.string().nullable(),
  phase: z.enum(['connect', 'check', 'warmup', 'measured', 'setup', 'cleanup']),
  /** measured runs that finished before the failure */
  completedRuns: z.number().int().nonnegative(),
  elapsedMs: z.number().nonnegative(),
});
export type Failure = z.infer<typeof FailureSchema>;

const PlanScanSchema = z.object({
  nodeType: z.string(),
  relation: z.string().nullable(),
  index: z.string().nullable(),
});

export const BuffersSchema = z.object({
  sharedHit: z.number(),
  sharedRead: z.number(),
  sharedDirtied: z.number(),
  sharedWritten: z.number(),
  tempRead: z.number(),
  tempWritten: z.number(),
  /** time spent reading blocks, reported by the server when track_io_timing is on (the harness turns it on) */
  ioReadMs: z.number().nullable(),
});
export type Buffers = z.infer<typeof BuffersSchema>;

export const PlanSummarySchema = z.object({
  executionMs: z.number(),
  planningMs: z.number(),
  /** Actual Rows of the top node */
  rows: z.number(),
  buffers: BuffersSchema,
  nodeTypes: z.array(z.string()),
  scans: z.array(PlanScanSchema),
  usesSeqScan: z.boolean(),
  /** Index Scan, Index Only Scan, Bitmap Index Scan */
  usesIndexScan: z.boolean(),
  usesSort: z.boolean(),
});
export type PlanSummary = z.infer<typeof PlanSummarySchema>;

const PlanCaptureSchema = z.object({
  /** 0-based index of the measured run this plan comes from */
  runIndex: z.number().int().nonnegative(),
  /** the EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) output, unmodified */
  json: z.unknown(),
  summary: PlanSummarySchema,
});
export type PlanCapture = z.infer<typeof PlanCaptureSchema>;

export const BackgroundSchema = z.object({
  /** autovacuum workers running when the measurement started / ended */
  autovacuumWorkersAtStart: z.number().int(),
  autovacuumWorkersAtEnd: z.number().int(),
  /** autovacuum and autoanalyze runs that finished during the measurement (from pg_stat_user_tables) */
  autovacuumRunsDuring: z.number().int(),
  /** checkpoints that started during the measurement (from pg_stat_bgwriter) */
  checkpointsDuring: z.number().int(),
  /** none of the above: nothing else was working in the database while this was measured */
  quiet: z.boolean(),
});
export type Background = z.infer<typeof BackgroundSchema>;

const EnvironmentSchema = z.object({
  /** background work seen while measuring; when not quiet, treat the timings with suspicion (see settleShadow) */
  background: BackgroundSchema,
  postgresVersion: z.string(),
  settings: z.record(z.string(), z.string()),
  /** container limits of the shadow, from its manifest */
  limits: z
    .object({
      cpus: z.number(),
      memoryMiB: z.number(),
      memorySwapMiB: z.number(),
      shmMiB: z.number(),
    })
    .nullable(),
});

export const CacheSchema = z.object({
  mode: z.enum(['warm', 'cold-ish']),
  /** What was actually done to the caches, in words. Never "cold" unless Postgres was restarted AND the OS page cache was dropped. */
  claim: z.enum([
    'warm-after-warmup',
    'shared-buffers-emptied-os-cache-warm',
    'shared-buffers-emptied-vm-page-cache-dropped',
  ]),
  restartedPostgres: z.boolean(),
  droppedOsCache: z.boolean(),
  notes: z.string(),
});

const PerRunSchema = z.object({
  wallMs: z.number(),
  serverExecMs: z.number(),
  planningMs: z.number(),
  rows: z.number(),
  sharedHit: z.number(),
  sharedRead: z.number(),
});

export const QueryMeasurementSchema = z.discriminatedUnion('status', [
  z.object({
    version: z.literal(MEASUREMENT_VERSION),
    kind: z.literal('query'),
    status: z.literal('ok'),
    shadow: ShadowRefSchema,
    statement: z.object({
      sql: z.string(),
      paramCount: z.number().int(),
      class: StatementClassSchema,
      strategy: StrategySchema,
    }),
    config: z.object({
      warmupRuns: z.number().int(),
      measuredRuns: z.number().int(),
      statementTimeoutMs: z.number(),
      maxTotalRuntimeMs: z.number(),
    }),
    cache: CacheSchema,
    /** client-side wall clock of the plain statement, per run, without EXPLAIN overhead */
    wallMs: StatsSchema,
    /** "Execution Time" reported by EXPLAIN (ANALYZE), per run */
    serverExecMs: StatsSchema,
    planningMs: StatsSchema,
    /** rows returned (SELECT) or affected (INSERT/UPDATE/DELETE) by the last measured run */
    rows: z.number(),
    rowsKind: z.enum(['returned', 'affected']),
    /** buffers of the median run (by server execution time) */
    buffers: BuffersSchema,
    plans: z.object({ first: PlanCaptureSchema, median: PlanCaptureSchema }),
    perRun: z.array(PerRunSchema),
    timings: z.object({ startedAt: z.string(), finishedAt: z.string(), totalMs: z.number() }),
    environment: EnvironmentSchema,
  }),
  z.object({
    version: z.literal(MEASUREMENT_VERSION),
    kind: z.literal('query'),
    status: z.literal('failed'),
    shadow: ShadowRefSchema.nullable(),
    failure: FailureSchema,
  }),
]);
export type QueryMeasurement = z.infer<typeof QueryMeasurementSchema>;

const SizesSchema = z.object({
  /** pg_relation_size of the table (for a partitioned table: the sum over its partitions) */
  tableBytes: z.number(),
  /** sum of pg_relation_size over all its indexes */
  indexesBytes: z.number(),
  /** the TOAST table and its index */
  toastBytes: z.number(),
  /** pg_total_relation_size */
  totalBytes: z.number(),
});
export type Sizes = z.infer<typeof SizesSchema>;

const LockHeldSchema = z.object({
  /** schema.name, or the locktype for non-relation locks */
  relation: z.string(),
  relkind: z.string().nullable(),
  locktype: z.string(),
  /** e.g. AccessExclusiveLock */
  mode: z.string(),
  granted: z.boolean(),
});

const DdlRunSchema = z.object({
  durationMs: z.number(),
  /** time the session spent waiting for a lock, from pg_stat_activity sampling (resolution: see samplingIntervalMs) */
  lockWaitMs: z.number(),
  tableRewritten: z.boolean(),
  sizeBefore: SizesSchema,
  sizeAfter: SizesSchema,
});

export const DdlMeasurementSchema = z.discriminatedUnion('status', [
  z.object({
    version: z.literal(MEASUREMENT_VERSION),
    kind: z.literal('ddl'),
    status: z.literal('ok'),
    shadow: ShadowRefSchema,
    statement: z.object({ sql: z.string(), class: StatementClassSchema, strategy: StrategySchema }),
    target: z.object({
      table: z.string(),
      relkind: z.string(),
      partitions: z.number().int(),
    }),
    config: z.object({
      runs: z.number().int(),
      statementTimeoutMs: z.number(),
      lockTimeoutMs: z.number(),
      maxTotalRuntimeMs: z.number(),
      samplingIntervalMs: z.number(),
      blockingTransaction: z.boolean(),
    }),
    /** wall clock of the statement, including any lock wait */
    durationMs: StatsSchema,
    lockWaitMs: StatsSchema,
    locks: z.object({
      /**
       * end-of-statement: pg_locks of the session read right after the statement, before the
       * transaction ends (every lock a transaction took is still held there).
       * sampled: pg_locks polled from a second session while the statement ran (the only way for
       * statements that cannot run in a transaction, where locks are released between phases).
       */
      source: z.enum(['end-of-statement', 'sampled']),
      held: z.array(LockHeldSchema),
      /** lock modes on the target table itself, strongest first */
      targetTableModes: z.array(z.string()),
      strongestTargetTableMode: z.string().nullable(),
      /** derived from the PostgreSQL lock conflict table */
      blocksSelects: z.boolean(),
      blocksWrites: z.boolean(),
    }),
    rewrite: z.object({
      /** the table's file (relfilenode) was replaced */
      tableRewritten: z.boolean(),
      relfilenodeBefore: z.number().nullable(),
      relfilenodeAfter: z.number().nullable(),
      /** existing indexes whose file was replaced */
      indexesRebuilt: z.boolean(),
      indexesCreated: z.array(z.string()),
      indexesDropped: z.array(z.string()),
      toastRewritten: z.boolean().nullable(),
      /** for a partitioned table: partitions whose file was replaced */
      partitionsRewritten: z.array(z.string()),
      /** false when the runs disagreed (should not happen) */
      consistentAcrossRuns: z.boolean(),
    }),
    size: z.object({
      before: SizesSchema,
      after: SizesSchema,
      deltaBytes: z.object({
        table: z.number(),
        indexes: z.number(),
        toast: z.number(),
        total: z.number(),
      }),
    }),
    runs: z.array(DdlRunSchema),
    verification: z.object({
      /** after ROLLBACK the table's file and sizes equal the "before" state; null when no transaction was used */
      rolledBackCleanly: z.boolean().nullable(),
    }),
    timings: z.object({ startedAt: z.string(), finishedAt: z.string(), totalMs: z.number() }),
    environment: EnvironmentSchema,
  }),
  z.object({
    version: z.literal(MEASUREMENT_VERSION),
    kind: z.literal('ddl'),
    status: z.literal('failed'),
    shadow: ShadowRefSchema.nullable(),
    failure: FailureSchema,
  }),
]);
export type DdlMeasurement = z.infer<typeof DdlMeasurementSchema>;

/** Options accepted by measureQuery. Strict: unknown keys (such as an attempt to skip the shadow check) are rejected. */
export const MeasureQueryOptionsSchema = z
  .object({
    sql: z.string().min(1),
    params: z.array(z.unknown()).default([]),
    warmupRuns: z.number().int().min(0).max(1000).default(3),
    measuredRuns: z.number().int().min(1).max(10_000).default(20),
    statementTimeoutMs: z.number().int().min(1).max(3_600_000).default(30_000),
    maxTotalRuntimeMs: z.number().int().min(1).max(86_400_000).default(300_000),
    lockTimeoutMs: z.number().int().min(0).default(5_000),
    connectTimeoutMs: z.number().int().min(100).default(10_000),
    cache: z
      .object({
        mode: z.enum(['warm', 'cold-ish']).default('warm'),
        /** cold-ish only: also drop the OS page cache of the Docker VM (needs a privileged helper container) */
        dropOsCache: z.boolean().default(false),
      })
      .strict()
      .default({ mode: 'warm', dropOsCache: false }),
  })
  .strict();
export type MeasureQueryOptions = z.input<typeof MeasureQueryOptionsSchema>;

export const MeasureDdlOptionsSchema = z
  .object({
    sql: z.string().min(1),
    /** schema-qualified table the statement changes; its locks, size and file are observed */
    table: z.string().min(1),
    runs: z.number().int().min(1).max(100).default(3),
    statementTimeoutMs: z.number().int().min(1).max(3_600_000).default(300_000),
    lockTimeoutMs: z.number().int().min(0).default(10_000),
    maxTotalRuntimeMs: z.number().int().min(1).max(86_400_000).default(900_000),
    connectTimeoutMs: z.number().int().min(100).default(10_000),
    /** pg_locks / pg_stat_activity polling pause in ms (the real resolution is coarser on Windows) */
    samplingIntervalMs: z.number().int().min(0).max(1000).default(2),
    /**
     * Hold a conflicting lock from another session for `holdMs` before and while the statement
     * starts, to measure how long it waits (what a long-running transaction on the table would cause).
     */
    blockingTransaction: z
      .object({ sql: z.string().min(1), holdMs: z.number().int().min(1).max(600_000) })
      .strict()
      .optional(),
  })
  .strict();
export type MeasureDdlOptions = z.input<typeof MeasureDdlOptionsSchema>;
