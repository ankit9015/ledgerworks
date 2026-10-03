import type pg from 'pg';
import {
  MEASUREMENT_VERSION,
  MeasureQueryOptionsSchema,
  type Failure,
  type PlanCapture,
  type QueryMeasurement,
  type ShadowRef,
} from './schema.js';
import { summarizePlan } from './plan.js';
import {
  HarnessFailure,
  WATCHDOG_GRACE_MS,
  backgroundBetween,
  closeQuietly,
  openSession,
  readBackground,
  restartPostgres,
  toHarnessFailure,
  withWatchdog,
  type MeasurementTarget,
  type OpenSession,
} from './session.js';
import { classifyStatement, hasMultipleStatements, strategyFor } from './statement.js';
import { computeStats, medianIndex } from './stats.js';

type Ok = Extract<QueryMeasurement, { status: 'ok' }>;

/** Same statement text without a trailing semicolon, so it can follow EXPLAIN. */
const trimSql = (sql: string): string => sql.trim().replace(/;+\s*$/, '');

/**
 * Measures a query (or INSERT/UPDATE/DELETE) on a shadow database.
 *
 * Per measured run the statement is executed twice: once as it is, timed by the client's wall
 * clock (no EXPLAIN overhead), and once as EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON), which gives the
 * server-side execution time, the plan and the buffer counts. Reads run in BEGIN READ ONLY, writes
 * in BEGIN ... ROLLBACK; see classifyStatement for what that does and does not undo.
 *
 * It refuses any database that is not a shadow (typed failure 'refused-not-shadow') and never
 * hangs: every statement has a server-side timeout, a client-side watchdog and the whole call has a
 * maximum runtime. Failures are returned, not thrown.
 */
export function measureQuery(
  target: MeasurementTarget,
  options: unknown,
): Promise<QueryMeasurement> {
  return runQuery(target, options, { skipShadowCheck: false });
}

/** Internal. `skipShadowCheck` is reachable only from internal-testing.ts. */
export async function runQuery(
  target: MeasurementTarget,
  rawOptions: unknown,
  internal: { skipShadowCheck: boolean },
): Promise<QueryMeasurement> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const elapsed = (): number => Date.now() - started;
  let completed = 0;
  let ref: ShadowRef | null = null;

  const fail = (e: unknown, phase: Failure['phase']): QueryMeasurement => {
    const h = toHarnessFailure(e, phase);
    return {
      version: MEASUREMENT_VERSION,
      kind: 'query',
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

  const parsed = MeasureQueryOptionsSchema.safeParse(rawOptions);
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
  const sql = trimSql(o.sql);
  const cls = classifyStatement(sql);
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
  if (cls === 'ddl' || cls === 'non-transactional') {
    return fail(
      new HarnessFailure('invalid-input', `this is a ${cls} statement: use measureDdl`, 'setup'),
      'setup',
    );
  }
  const readOnly = cls === 'read';
  const cold = o.cache.mode === 'cold-ish';
  const remaining = (): number => o.maxTotalRuntimeMs - elapsed();

  /** statement_timeout for the next statement: the user's, but never beyond the total budget. */
  const effectiveTimeout = (): { ms: number; budgetBound: boolean } => {
    const left = remaining();
    return left < o.statementTimeoutMs
      ? { ms: Math.max(1, left), budgetBound: true }
      : { ms: o.statementTimeoutMs, budgetBound: false };
  };

  let session: OpenSession | undefined;
  const open = async (): Promise<OpenSession> =>
    openSession(target, {
      applicationName: 'ledgerworks-measure',
      statementTimeoutMs: effectiveTimeout().ms,
      lockTimeoutMs: o.lockTimeoutMs,
      connectTimeoutMs: o.connectTimeoutMs,
      skipShadowCheck: internal.skipShadowCheck,
    });

  /** Runs one statement in its own transaction, timed around the statement only. */
  const inTx = async <T>(
    c: pg.Client,
    phase: Failure['phase'],
    run: () => Promise<T>,
  ): Promise<{ value: T; ms: number }> => {
    const t = effectiveTimeout();
    if (remaining() <= 0)
      throw new HarnessFailure(
        'max-runtime-exceeded',
        `maximum total runtime of ${o.maxTotalRuntimeMs} ms exceeded`,
        phase,
      );
    await c.query(`SET statement_timeout = ${Math.floor(t.ms)}`);
    await c.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    const t0 = performance.now();
    try {
      const value = await withWatchdog(c, t.ms + WATCHDOG_GRACE_MS, run);
      return { value, ms: performance.now() - t0 };
    } catch (e) {
      const h = toHarnessFailure(e, phase);
      if (h.kind === 'statement-timeout' && t.budgetBound) {
        throw new HarnessFailure(
          'max-runtime-exceeded',
          `maximum total runtime of ${o.maxTotalRuntimeMs} ms exceeded`,
          phase,
          h.sqlState,
        );
      }
      throw h;
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
    }
  };

  const plain = (c: pg.Client, phase: Failure['phase']) =>
    inTx(c, phase, () => c.query({ text: sql, values: o.params as unknown[], rowMode: 'array' }));
  const explain = (c: pg.Client, phase: Failure['phase']) =>
    inTx(c, phase, () =>
      c.query({
        text: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
        values: o.params as unknown[],
      }),
    );

  const wall: number[] = [];
  const server: number[] = [];
  const planning: number[] = [];
  const plans: PlanCapture[] = [];
  const perRun: Ok['perRun'] = [];
  let rows = 0;
  let cacheNote = '';
  let restarted = false;
  let dropped = false;

  try {
    session = await open();
    ref = session.ref;
    let bgStart = await readBackground(session.client);

    if (!cold) {
      for (let i = 0; i < o.warmupRuns; i++) await plain(session.client, 'warmup');
    }

    for (let i = 0; i < o.measuredRuns; i++) {
      if (remaining() <= 0)
        throw new HarnessFailure(
          'max-runtime-exceeded',
          `maximum total runtime of ${o.maxTotalRuntimeMs} ms exceeded after ${completed} runs`,
          'measured',
        );
      if (cold) {
        await closeQuietly(session.client);
        const r = await restartPostgres(target, o.cache.dropOsCache);
        restarted = true;
        dropped = r.droppedOsCache;
        if (r.note) cacheNote = r.note;
        session = await open();
        // after a restart the counters start over: the window is the last run only
        bgStart = await readBackground(session.client);
      }
      let wallMs: number;
      let planJson: unknown;
      if (cold) {
        // One execution only, EXPLAIN first: a second one would find the cache already filled.
        const e = await explain(session.client, 'measured');
        wallMs = e.ms;
        planJson = e.value.rows[0]?.['QUERY PLAN'];
        rows = summarizePlan(planJson).rows;
      } else {
        const p = await plain(session.client, 'measured');
        wallMs = p.ms;
        rows = p.value.rowCount ?? p.value.rows.length;
        const e = await explain(session.client, 'measured');
        planJson = e.value.rows[0]?.['QUERY PLAN'];
      }
      const s = summarizePlan(planJson);
      wall.push(wallMs);
      server.push(s.executionMs);
      planning.push(s.planningMs);
      plans.push({ runIndex: i, json: planJson, summary: s });
      perRun.push({
        wallMs,
        serverExecMs: s.executionMs,
        planningMs: s.planningMs,
        rows: s.rows,
        sharedHit: s.buffers.sharedHit,
        sharedRead: s.buffers.sharedRead,
      });
      completed++;
    }

    const background = backgroundBetween(bgStart, await readBackground(session.client));
    const mi = medianIndex(server);
    const first = plans[0]!;
    const median = plans[mi]!;
    const finishedAt = new Date();
    const measurement: Ok = {
      version: MEASUREMENT_VERSION,
      kind: 'query',
      status: 'ok',
      shadow: ref!,
      statement: { sql, paramCount: o.params.length, class: cls, strategy: strategyFor(cls) },
      config: {
        warmupRuns: cold ? 0 : o.warmupRuns,
        measuredRuns: o.measuredRuns,
        statementTimeoutMs: o.statementTimeoutMs,
        maxTotalRuntimeMs: o.maxTotalRuntimeMs,
      },
      cache: cold
        ? {
            mode: 'cold-ish',
            claim: dropped
              ? 'shared-buffers-emptied-vm-page-cache-dropped'
              : 'shared-buffers-emptied-os-cache-warm',
            restartedPostgres: restarted,
            droppedOsCache: dropped,
            notes:
              (dropped
                ? "Postgres was restarted and the page cache of the Docker VM's kernel was dropped before every run. Caches below the VM (the host operating system, the SSD) were not touched, so this is colder than warm but is not a guaranteed cold disk read."
                : 'Postgres was restarted before every run (shared_buffers empty). The OS page cache was NOT dropped, so blocks read ("shared read") probably came from the kernel cache, not the disk: compare buffers.ioReadMs with sharedRead. This is NOT a cold-cache measurement.') +
              ' Each run is a single EXPLAIN (ANALYZE) execution (a second execution would find the cache filled), so wallMs includes EXPLAIN instrumentation overhead in this mode.' +
              (cacheNote ? ` ${cacheNote}` : ''),
          }
        : {
            mode: 'warm',
            claim: 'warm-after-warmup',
            restartedPostgres: false,
            droppedOsCache: false,
            notes: `${o.warmupRuns} warmup run(s) before the measured runs; shared_buffers and the OS cache hold what the statement touches.`,
          },
      wallMs: computeStats(wall),
      serverExecMs: computeStats(server),
      planningMs: computeStats(planning),
      rows,
      rowsKind: readOnly ? 'returned' : 'affected',
      buffers: median.summary.buffers,
      plans: { first, median },
      perRun,
      timings: { startedAt, finishedAt: finishedAt.toISOString(), totalMs: elapsed() },
      environment: { ...session.environment, background },
    };
    return measurement;
  } catch (e) {
    return fail(e, completed === 0 && !session ? 'connect' : 'measured');
  } finally {
    if (session) await closeQuietly(session.client);
  }
}
