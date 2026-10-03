import pg from 'pg';
import {
  MEASUREMENT_VERSION,
  MeasureDdlOptionsSchema,
  type DdlMeasurement,
  type Failure,
  type ShadowRef,
  type Sizes,
} from './schema.js';
import {
  HarnessFailure,
  WATCHDOG_GRACE_MS,
  backgroundBetween,
  closeQuietly,
  openSession,
  readBackground,
  toHarnessFailure,
  withWatchdog,
  type MeasurementTarget,
  type OpenSession,
} from './session.js';
import { classifyStatement, hasMultipleStatements, strategyFor } from './statement.js';
import { computeStats } from './stats.js';

type Ok = Extract<DdlMeasurement, { status: 'ok' }>;

/** Supplies a fresh shadow for one run of a statement that cannot run in a transaction. */
export interface FreshShadowProvider {
  (): Promise<{ target: MeasurementTarget; dispose: () => Promise<void> }>;
}
export interface DdlHooks {
  freshShadow?: FreshShadowProvider;
}

/** Weakest first. */
const LOCK_ORDER = [
  'AccessShareLock',
  'RowShareLock',
  'RowExclusiveLock',
  'ShareUpdateExclusiveLock',
  'ShareLock',
  'ShareRowExclusiveLock',
  'ExclusiveLock',
  'AccessExclusiveLock',
];
const strength = (m: string): number => LOCK_ORDER.indexOf(m);

type LockHeld = Ok['locks']['held'][number];

interface RelSnapshot {
  /** schema.name of every table (the target, or its partitions) to relfilenode */
  tables: Map<string, number | null>;
  indexes: Map<string, number | null>;
  toast: Map<string, number | null>;
  sizes: Sizes;
  targetFilenode: number | null;
  targetRelkind: string;
  partitions: number;
}

const num = (v: unknown): number => Number(v ?? 0);

const EMPTY_SIZES: Sizes = { tableBytes: 0, indexesBytes: 0, toastBytes: 0, totalBytes: 0 };

/**
 * Files and sizes of a table (or of a partitioned table and its partitions) and of its indexes and
 * TOAST. With `allowMissing`, a table that does not exist (after a DROP TABLE inside the measured
 * transaction) gives an empty snapshot instead of an error.
 */
async function snapshotRelations(
  c: pg.Client,
  table: string,
  allowMissing = false,
): Promise<RelSnapshot> {
  if (allowMissing) {
    const there = await c.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [
      table,
    ]);
    if (!there.rows[0]!.ok) {
      return {
        tables: new Map(),
        indexes: new Map(),
        toast: new Map(),
        sizes: EMPTY_SIZES,
        targetFilenode: null,
        targetRelkind: '',
        partitions: 0,
      };
    }
  }
  let leaves;
  try {
    leaves = await c.query<{
      oid: string;
      name: string;
      relkind: string;
      filenode: string | null;
      bytes: string;
      total: string;
      toast: string | null;
      is_target: boolean;
      level: number;
    }>(
      `SELECT c.oid::bigint::text AS oid, format('%I.%I', n.nspname, c.relname) AS name, c.relkind,
              pg_relation_filenode(c.oid)::text AS filenode, pg_relation_size(c.oid)::text AS bytes,
              pg_total_relation_size(c.oid)::text AS total, NULLIF(c.reltoastrelid, 0)::bigint::text AS toast,
              (c.oid = $1::regclass) AS is_target, t.level
         FROM (
                SELECT relid, level FROM pg_partition_tree($1::regclass)
                UNION ALL
                -- pg_partition_tree returns no rows for an ordinary table: the table itself is the tree
                SELECT $1::regclass::oid, 0 WHERE NOT EXISTS (SELECT 1 FROM pg_partition_tree($1::regclass))
              ) t
         JOIN pg_class c ON c.oid = t.relid JOIN pg_namespace n ON n.oid = c.relnamespace
        ORDER BY t.level, 2`,
      [table],
    );
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === '42P01' || code === '3F000' || code === '42602' || code === '22P02') {
      throw new HarnessFailure(
        'invalid-input',
        `table "${table}" not found or not a valid name`,
        'setup',
        code,
      );
    }
    throw e;
  }
  const tables = new Map<string, number | null>();
  const indexes = new Map<string, number | null>();
  const toast = new Map<string, number | null>();
  let tableBytes = 0;
  let indexesBytes = 0;
  let toastBytes = 0;
  let totalBytes = 0;
  let targetFilenode: number | null = null;
  let targetRelkind = '';
  let partitions = 0;
  for (const r of leaves.rows) {
    const isLeafLike = r.relkind === 'r' || r.relkind === 'm';
    if (r.is_target) {
      targetFilenode = r.filenode === null ? null : Number(r.filenode);
      targetRelkind = r.relkind;
    } else {
      partitions++;
    }
    tables.set(r.name, r.filenode === null ? null : Number(r.filenode));
    if (!isLeafLike) continue; // a partitioned parent holds no data of its own
    tableBytes += num(r.bytes);
    totalBytes += num(r.total);
    const ix = await c.query<{ name: string; filenode: string | null; bytes: string }>(
      `SELECT format('%I.%I', n.nspname, ic.relname) AS name, pg_relation_filenode(ic.oid)::text AS filenode,
              pg_relation_size(ic.oid)::text AS bytes
         FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_namespace n ON n.oid = ic.relnamespace
        WHERE i.indrelid = $1::bigint::oid`,
      [r.oid],
    );
    for (const i of ix.rows) {
      indexes.set(i.name, i.filenode === null ? null : Number(i.filenode));
      indexesBytes += num(i.bytes);
    }
    if (r.toast) {
      const tt = await c.query<{ filenode: string | null; total: string }>(
        `SELECT pg_relation_filenode($1::bigint::oid)::text AS filenode, pg_total_relation_size($1::bigint::oid)::text AS total`,
        [r.toast],
      );
      toast.set(r.name, tt.rows[0]!.filenode === null ? null : Number(tt.rows[0]!.filenode));
      toastBytes += num(tt.rows[0]!.total);
    }
  }
  return {
    tables,
    indexes,
    toast,
    sizes: { tableBytes, indexesBytes, toastBytes, totalBytes },
    targetFilenode,
    targetRelkind,
    partitions,
  };
}

interface LockMonitor {
  stop(): Promise<{ waitMs: number; held: LockHeld[]; intervalMs: number }>;
}

/**
 * Polls pg_stat_activity and pg_locks for one backend from a second session. The wait time is the
 * sum of the intervals in which the backend was seen waiting for a lock (an estimate with an error
 * of about one sampling interval); the lock list is everything seen, granted or not.
 */
function startLockMonitor(m: pg.Client, pid: number, pauseMs: number): LockMonitor {
  const seen = new Map<string, LockHeld>();
  const stamps: number[] = [];
  let waitMs = 0;
  let running = true;
  const loop = (async () => {
    let prevWaiting = false;
    let prevAt = performance.now();
    while (running) {
      let rows;
      try {
        rows = await m.query<{
          wait_event_type: string | null;
          locktype: string | null;
          mode: string | null;
          granted: boolean | null;
          nspname: string | null;
          relname: string | null;
          relkind: string | null;
        }>(
          `SELECT a.wait_event_type, l.locktype, l.mode, l.granted, n.nspname, c.relname, c.relkind
             FROM pg_stat_activity a LEFT JOIN pg_locks l ON l.pid = a.pid
             LEFT JOIN pg_class c ON c.oid = l.relation LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE a.pid = $1`,
          [pid],
        );
      } catch {
        return;
      }
      const now = performance.now();
      stamps.push(now);
      if (prevWaiting) waitMs += now - prevAt;
      prevAt = now;
      prevWaiting = rows.rows.some((r) => r.wait_event_type === 'Lock');
      for (const r of rows.rows) {
        if (!r.mode || !r.locktype || r.locktype === 'virtualxid' || r.locktype === 'transactionid')
          continue;
        if (r.nspname === 'pg_catalog' || r.nspname === 'information_schema') continue;
        const relation = r.relname ? `${r.nspname}.${r.relname}` : r.locktype;
        const key = `${relation}|${r.mode}`;
        const prev = seen.get(key);
        seen.set(key, {
          relation,
          relkind: r.relkind,
          locktype: r.locktype,
          mode: r.mode,
          granted: (prev?.granted ?? false) || r.granted === true,
        });
      }
      if (pauseMs > 0) await new Promise((res) => setTimeout(res, pauseMs));
    }
    if (prevWaiting) waitMs += performance.now() - prevAt;
  })();
  return {
    async stop() {
      running = false;
      await loop;
      const deltas = stamps
        .slice(1)
        .map((t, i) => t - stamps[i]!)
        .sort((a, b) => a - b);
      return {
        waitMs,
        held: [...seen.values()],
        intervalMs: deltas.length ? deltas[Math.floor(deltas.length / 2)]! : 0,
      };
    },
  };
}

/** Locks held by the session itself, read inside its transaction right after the statement. */
async function ownLocks(c: pg.Client): Promise<LockHeld[]> {
  const r = await c.query<{
    locktype: string;
    mode: string;
    granted: boolean;
    nspname: string | null;
    relname: string | null;
    relkind: string | null;
  }>(
    `SELECT l.locktype, l.mode, l.granted, n.nspname, c.relname, c.relkind
       FROM pg_locks l LEFT JOIN pg_class c ON c.oid = l.relation LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE l.pid = pg_backend_pid() AND l.locktype NOT IN ('virtualxid', 'transactionid')`,
  );
  return r.rows
    .filter((x) => x.nspname !== 'pg_catalog' && x.nspname !== 'information_schema')
    .map((x) => ({
      relation: x.relname ? `${x.nspname}.${x.relname}` : x.locktype,
      relkind: x.relkind,
      locktype: x.locktype,
      mode: x.mode,
      granted: x.granted,
    }));
}

interface RunResult {
  background: ReturnType<typeof backgroundBetween>;
  durationMs: number;
  lockWaitMs: number;
  before: RelSnapshot;
  after: RelSnapshot;
  held: LockHeld[];
  lockSource: 'end-of-statement' | 'sampled';
  samplingIntervalMs: number;
  rolledBackCleanly: boolean | null;
}

const sameSizes = (a: Sizes, b: Sizes): boolean =>
  a.tableBytes === b.tableBytes &&
  a.indexesBytes === b.indexesBytes &&
  a.totalBytes === b.totalBytes;

const mapsEqual = (a: Map<string, number | null>, b: Map<string, number | null>): boolean =>
  a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

/**
 * Measures a DDL statement: duration, lock wait, the lock modes it takes, relation sizes before and
 * after, and whether the table was rewritten (its relfilenode changed).
 *
 * Strategy: transactional DDL (almost all of it) runs inside BEGIN ... ROLLBACK on the shadow, so
 * every run starts from the same state and leaves no trace; the locks are read from pg_locks
 * right after the statement, while the transaction still holds them. Statements that cannot run in a
 * transaction (CREATE INDEX CONCURRENTLY, REINDEX CONCURRENTLY, VACUUM, ...) cannot be rolled back, so
 * each run needs a fresh shadow from `hooks.freshShadow`; without it the result is the failure
 * 'needs-fresh-shadow'. For those the locks come from sampling only.
 *
 * Refuses any database that is not a shadow. Failures are returned, not thrown.
 */
export function measureDdl(
  target: MeasurementTarget,
  options: unknown,
  hooks: DdlHooks = {},
): Promise<DdlMeasurement> {
  return runDdl(target, options, hooks, { skipShadowCheck: false });
}

/** Internal. `skipShadowCheck` is reachable only from internal-testing.ts. */
export async function runDdl(
  target: MeasurementTarget,
  rawOptions: unknown,
  hooks: DdlHooks,
  internal: { skipShadowCheck: boolean },
): Promise<DdlMeasurement> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const elapsed = (): number => Date.now() - started;
  let completed = 0;
  let ref: ShadowRef | null = null;

  const fail = (e: unknown, phase: Failure['phase']): DdlMeasurement => {
    const h = toHarnessFailure(e, phase);
    return {
      version: MEASUREMENT_VERSION,
      kind: 'ddl',
      status: 'failed',
      shadow: ref,
      failure: {
        kind: h.kind,
        message: h.message,
        sqlState: h.sqlState,
        phase: h.phase,
        completedRuns: completed,
        elapsedMs: elapsed(),
      },
    };
  };

  const parsed = MeasureDdlOptionsSchema.safeParse(rawOptions);
  if (!parsed.success) {
    return fail(
      new HarnessFailure(
        'invalid-input',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        'setup',
      ),
      'setup',
    );
  }
  const o = parsed.data;
  const sql = o.sql.trim().replace(/;+\s*$/, '');
  if (hasMultipleStatements(sql)) {
    return fail(
      new HarnessFailure(
        'invalid-input',
        'a measured statement must be exactly one statement',
        'setup',
      ),
      'setup',
    );
  }
  const cls = classifyStatement(sql);
  if (cls === 'read') {
    return fail(
      new HarnessFailure('invalid-input', 'this is a read: use measureQuery', 'setup'),
      'setup',
    );
  }
  const transactional = cls !== 'non-transactional';
  if (!transactional && !hooks.freshShadow) {
    return fail(
      new HarnessFailure(
        'needs-fresh-shadow',
        'this statement cannot run in a transaction, so it cannot be rolled back; pass hooks.freshShadow to run each measurement on a fresh shadow',
        'setup',
      ),
      'setup',
    );
  }
  const remaining = (): number => o.maxTotalRuntimeMs - elapsed();
  const timeoutNow = (): { ms: number; budgetBound: boolean } => {
    const left = remaining();
    return left < o.statementTimeoutMs
      ? { ms: Math.max(1, left), budgetBound: true }
      : { ms: o.statementTimeoutMs, budgetBound: false };
  };

  const open = (t: MeasurementTarget): Promise<OpenSession> =>
    openSession(t, {
      applicationName: 'ledgerworks-ddl-measure',
      statementTimeoutMs: timeoutNow().ms,
      lockTimeoutMs: o.lockTimeoutMs,
      connectTimeoutMs: o.connectTimeoutMs,
      skipShadowCheck: internal.skipShadowCheck,
    });

  /** One run on one target. */
  const oneRun = async (t: MeasurementTarget, sess: OpenSession): Promise<RunResult> => {
    const a = sess.client;
    const monitorClient = new pg.Client({
      connectionString: t.connectionString(),
      application_name: 'ledgerworks-ddl-monitor',
    });
    monitorClient.on('error', () => undefined);
    await monitorClient.connect();
    let blocker: pg.Client | undefined;
    let releaseTimer: NodeJS.Timeout | undefined;
    let monitor: LockMonitor | undefined;
    try {
      const bgStart = await readBackground(a);
      const before = await snapshotRelations(a, o.table);
      const pid = (await a.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;

      if (o.blockingTransaction) {
        blocker = new pg.Client({
          connectionString: t.connectionString(),
          application_name: 'ledgerworks-ddl-blocker',
        });
        blocker.on('error', () => undefined);
        await blocker.connect();
        await blocker.query('BEGIN');
        await blocker.query(o.blockingTransaction.sql);
        const b = blocker;
        releaseTimer = setTimeout(
          () => void b.query('ROLLBACK').catch(() => undefined),
          o.blockingTransaction.holdMs,
        );
      }

      const to = timeoutNow();
      if (remaining() <= 0)
        throw new HarnessFailure(
          'max-runtime-exceeded',
          `maximum total runtime of ${o.maxTotalRuntimeMs} ms exceeded`,
          'measured',
        );
      await a.query(`SET statement_timeout = ${Math.floor(to.ms)}`);
      if (transactional) await a.query('BEGIN');
      monitor = startLockMonitor(monitorClient, pid, o.samplingIntervalMs);
      const t0 = performance.now();
      let durationMs: number;
      try {
        await withWatchdog(
          a,
          to.ms + WATCHDOG_GRACE_MS + (o.blockingTransaction?.holdMs ?? 0),
          () => a.query(sql),
        );
        durationMs = performance.now() - t0;
      } catch (e) {
        const h = toHarnessFailure(e, 'measured');
        if (transactional) await a.query('ROLLBACK').catch(() => undefined);
        await monitor.stop();
        monitor = undefined;
        if (h.kind === 'statement-timeout' && to.budgetBound) {
          throw new HarnessFailure(
            'max-runtime-exceeded',
            `maximum total runtime of ${o.maxTotalRuntimeMs} ms exceeded`,
            'measured',
            h.sqlState,
          );
        }
        throw h;
      }

      let held: LockHeld[] = [];
      let after: RelSnapshot;
      let rolledBackCleanly: boolean | null = null;
      if (transactional) {
        held = await ownLocks(a); // authoritative: a transaction keeps every lock it took until the end
        after = await snapshotRelations(a, o.table, true);
        await a.query('ROLLBACK');
        const restored = await snapshotRelations(a, o.table);
        rolledBackCleanly =
          restored.targetFilenode === before.targetFilenode &&
          mapsEqual(restored.tables, before.tables) &&
          mapsEqual(restored.indexes, before.indexes) &&
          sameSizes(restored.sizes, before.sizes);
      } else {
        after = await snapshotRelations(a, o.table, true);
      }
      const mon = await monitor.stop();
      monitor = undefined;
      const background = backgroundBetween(bgStart, await readBackground(a));
      const seenModes = new Map<string, LockHeld>();
      for (const h of [...mon.held, ...held]) seenModes.set(`${h.relation}|${h.mode}`, h);
      return {
        background,
        durationMs,
        lockWaitMs: mon.waitMs,
        before,
        after,
        held: transactional ? held : [...seenModes.values()],
        lockSource: transactional ? 'end-of-statement' : 'sampled',
        samplingIntervalMs: mon.intervalMs,
        rolledBackCleanly,
      };
    } finally {
      clearTimeout(releaseTimer);
      if (monitor) await monitor.stop().catch(() => undefined);
      if (blocker) {
        await blocker.query('ROLLBACK').catch(() => undefined);
        await closeQuietly(blocker);
      }
      await closeQuietly(monitorClient);
    }
  };

  const results: RunResult[] = [];
  let environment: OpenSession['environment'] | undefined;
  try {
    for (let i = 0; i < o.runs; i++) {
      if (remaining() <= 0) {
        throw new HarnessFailure(
          'max-runtime-exceeded',
          `maximum total runtime of ${o.maxTotalRuntimeMs} ms exceeded after ${completed} runs`,
          'measured',
        );
      }
      if (transactional) {
        const sess = await open(target);
        ref ??= sess.ref;
        environment ??= sess.environment;
        try {
          results.push(await oneRun(target, sess));
        } finally {
          await closeQuietly(sess.client);
        }
      } else {
        const fresh = await hooks.freshShadow!();
        try {
          const sess = await open(fresh.target);
          ref ??= sess.ref;
          environment ??= sess.environment;
          try {
            results.push(await oneRun(fresh.target, sess));
          } finally {
            await closeQuietly(sess.client);
          }
        } finally {
          await fresh.dispose();
        }
      }
      completed++;
    }

    const first = results[0]!;
    const targetName = o.table;
    const tableNameMatches = (rel: string): boolean =>
      rel === targetName || rel === targetName.replace(/^public\./, '');
    const rewriteOf = (
      r: RunResult,
    ): {
      table: boolean;
      indexes: boolean;
      toast: boolean | null;
      parts: string[];
      created: string[];
      dropped: string[];
    } => {
      const changedTables = [...r.after.tables].filter(
        ([k, v]) => r.before.tables.has(k) && r.before.tables.get(k) !== v,
      );
      const changedIdx = [...r.after.indexes].filter(
        ([k, v]) => r.before.indexes.has(k) && r.before.indexes.get(k) !== v,
      );
      const toastBefore = [...r.before.toast.values()];
      const toastAfter = [...r.after.toast.values()];
      return {
        table: changedTables.length > 0,
        indexes: changedIdx.length > 0,
        toast: toastBefore.length ? toastBefore.some((v, i) => v !== toastAfter[i]) : null,
        parts: r.after.partitions > 0 ? changedTables.map(([k]) => k) : [],
        created: [...r.after.indexes.keys()].filter((k) => !r.before.indexes.has(k)),
        dropped: [...r.before.indexes.keys()].filter((k) => !r.after.indexes.has(k)),
      };
    };
    const rw = results.map(rewriteOf);
    const modes = [
      ...new Set(first.held.filter((h) => tableNameMatches(h.relation)).map((h) => h.mode)),
    ].sort((x, y) => strength(y) - strength(x));
    const strongest = modes[0] ?? null;
    const sortedHeld = [...first.held].sort(
      (x, y) => strength(y.mode) - strength(x.mode) || x.relation.localeCompare(y.relation),
    );
    const consistent = rw.every((x) => x.table === rw[0]!.table && x.indexes === rw[0]!.indexes);
    const finishedAt = new Date();
    const measurement: Ok = {
      version: MEASUREMENT_VERSION,
      kind: 'ddl',
      status: 'ok',
      shadow: ref!,
      statement: { sql, class: cls, strategy: strategyFor(cls) },
      target: {
        table: o.table,
        relkind: first.before.targetRelkind,
        partitions: first.before.partitions,
      },
      config: {
        runs: o.runs,
        statementTimeoutMs: o.statementTimeoutMs,
        lockTimeoutMs: o.lockTimeoutMs,
        maxTotalRuntimeMs: o.maxTotalRuntimeMs,
        samplingIntervalMs: Math.round(first.samplingIntervalMs * 10) / 10,
        blockingTransaction: o.blockingTransaction !== undefined,
      },
      durationMs: computeStats(results.map((r) => r.durationMs)),
      lockWaitMs: computeStats(results.map((r) => r.lockWaitMs)),
      locks: {
        source: first.lockSource,
        held: sortedHeld,
        targetTableModes: modes,
        strongestTargetTableMode: strongest,
        blocksSelects: strongest === 'AccessExclusiveLock',
        blocksWrites: strongest !== null && strength(strongest) >= strength('ShareLock'),
      },
      rewrite: {
        tableRewritten: rw[0]!.table,
        relfilenodeBefore: first.before.targetFilenode,
        relfilenodeAfter: first.after.targetFilenode,
        indexesRebuilt: rw[0]!.indexes,
        indexesCreated: rw[0]!.created,
        indexesDropped: rw[0]!.dropped,
        toastRewritten: rw[0]!.toast,
        partitionsRewritten: rw[0]!.parts,
        consistentAcrossRuns: consistent,
      },
      size: {
        before: first.before.sizes,
        after: first.after.sizes,
        deltaBytes: {
          table: first.after.sizes.tableBytes - first.before.sizes.tableBytes,
          indexes: first.after.sizes.indexesBytes - first.before.sizes.indexesBytes,
          toast: first.after.sizes.toastBytes - first.before.sizes.toastBytes,
          total: first.after.sizes.totalBytes - first.before.sizes.totalBytes,
        },
      },
      runs: results.map((r, i) => ({
        durationMs: r.durationMs,
        lockWaitMs: r.lockWaitMs,
        tableRewritten: rw[i]!.table,
        sizeBefore: r.before.sizes,
        sizeAfter: r.after.sizes,
      })),
      verification: {
        rolledBackCleanly: transactional
          ? results.every((r) => r.rolledBackCleanly === true)
          : null,
      },
      timings: { startedAt, finishedAt: finishedAt.toISOString(), totalMs: elapsed() },
      environment: {
        ...environment!,
        background: {
          autovacuumWorkersAtStart: results[0]!.background.autovacuumWorkersAtStart,
          autovacuumWorkersAtEnd: results[results.length - 1]!.background.autovacuumWorkersAtEnd,
          autovacuumRunsDuring: results.reduce((n, r) => n + r.background.autovacuumRunsDuring, 0),
          checkpointsDuring: results.reduce((n, r) => n + r.background.checkpointsDuring, 0),
          quiet: results.every((r) => r.background.quiet),
        },
      },
    };
    return measurement;
  } catch (e) {
    return fail(e, completed === 0 ? 'setup' : 'measured');
  }
}
