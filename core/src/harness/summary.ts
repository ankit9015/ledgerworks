import type { DdlMeasurement, QueryMeasurement, ShadowRef, Stats } from './schema.js';

const ms = (n: number): string =>
  (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)) + ' ms';
const stat = (s: Stats): string =>
  `p50 ${ms(s.p50)}, p95 ${ms(s.p95)}, min ${ms(s.min)}, max ${ms(s.max)}, sd ${ms(s.stddev)} (CV ${s.cvPercent.toFixed(1)}%), n=${s.n}`;
const bytes = (n: number): string =>
  Math.abs(n) >= 1024 ** 2
    ? `${(n / 1024 ** 2).toFixed(1)} MiB`
    : Math.abs(n) >= 1024
      ? `${(n / 1024).toFixed(1)} KiB`
      : `${n} B`;

function scaling(s: ShadowRef | null): string[] {
  if (!s) return [];
  return s.sampled
    ? [
        `!! SAMPLED shadow ${s.manifestId.slice(0, 8)}: ${(s.totalRowRatio * 100).toFixed(1)}% of all rows, ${(s.largestTableRatio * 100).toFixed(1)}% of the largest table. These numbers are NOT full-scale.`,
      ]
    : [`shadow ${s.manifestId.slice(0, 8)}: full copy (see its manifest for the container limits)`];
}

function background(b: {
  quiet: boolean;
  autovacuumWorkersAtStart: number;
  autovacuumWorkersAtEnd: number;
  autovacuumRunsDuring: number;
  checkpointsDuring: number;
}): string[] {
  return b.quiet
    ? []
    : [
        `!! NOT QUIET: autovacuum workers at start ${b.autovacuumWorkersAtStart}, at end ${b.autovacuumWorkersAtEnd}, autovacuum runs during ${b.autovacuumRunsDuring}, checkpoints during ${b.checkpointsDuring}. Timings may be disturbed; run settleShadow and measure again.`,
      ];
}

/** A human-readable summary of a query measurement (or of its failure). */
export function summarizeQuery(m: QueryMeasurement): string {
  if (m.status === 'failed') {
    return [
      ...scaling(m.shadow),
      `FAILED (${m.failure.kind}) in ${m.failure.phase} after ${m.failure.completedRuns} run(s), ${ms(m.failure.elapsedMs)}: ${m.failure.message}`,
    ].join('\n');
  }
  const p = m.plans.median.summary;
  return [
    ...scaling(m.shadow),
    ...background(m.environment.background),
    `${m.statement.class} / ${m.statement.strategy}: ${m.statement.sql.replace(/\s+/g, ' ').slice(0, 120)}`,
    `cache: ${m.cache.claim}; ${m.config.warmupRuns} warmup + ${m.config.measuredRuns} measured runs`,
    `wall   ${stat(m.wallMs)}`,
    `server ${stat(m.serverExecMs)}   planning p50 ${ms(m.planningMs.p50)}`,
    `rows ${m.rows} ${m.rowsKind}; buffers (median run) hit ${m.buffers.sharedHit}, read ${m.buffers.sharedRead}` +
      (m.buffers.ioReadMs !== null ? `, io read ${ms(m.buffers.ioReadMs)}` : ''),
    `plan (median run): ${p.nodeTypes.join(' > ')}; seq scan ${p.usesSeqScan}, index scan ${p.usesIndexScan}, sort ${p.usesSort}`,
  ].join('\n');
}

/** A human-readable summary of a DDL measurement (or of its failure). */
export function summarizeDdl(m: DdlMeasurement): string {
  if (m.status === 'failed') {
    return [
      ...scaling(m.shadow),
      `FAILED (${m.failure.kind}) in ${m.failure.phase} after ${m.failure.completedRuns} run(s), ${ms(m.failure.elapsedMs)}: ${m.failure.message}`,
    ].join('\n');
  }
  return [
    ...scaling(m.shadow),
    ...background(m.environment.background),
    `${m.statement.strategy}: ${m.statement.sql.replace(/\s+/g, ' ').slice(0, 120)}`,
    `duration ${stat(m.durationMs)}; lock wait p50 ${ms(m.lockWaitMs.p50)}`,
    `locks on ${m.target.table} (${m.locks.source}): ${m.locks.targetTableModes.join(', ') || 'none'}; blocks selects: ${m.locks.blocksSelects}, blocks writes: ${m.locks.blocksWrites}`,
    `table rewritten: ${m.rewrite.tableRewritten}; indexes rebuilt: ${m.rewrite.indexesRebuilt}; created: ${m.rewrite.indexesCreated.join(', ') || 'none'}`,
    `size ${bytes(m.size.before.totalBytes)} -> ${bytes(m.size.after.totalBytes)} (table ${bytes(m.size.deltaBytes.table)}, indexes ${bytes(m.size.deltaBytes.indexes)})`,
    m.verification.rolledBackCleanly === null
      ? 'not rolled back (fresh shadow per run)'
      : `rolled back cleanly: ${m.verification.rolledBackCleanly}`,
  ].join('\n');
}
