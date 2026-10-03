import pg from 'pg';
import { docker } from '../shadow/docker.js';
import { NotShadowError, assertShadow } from '../shadow/marker.js';
import type { ShadowManifest } from '../shadow/manifest.js';
import type { Background, Failure, FailureKind, ShadowRef } from './schema.js';

/** Where to measure. A ShadowHandle from createShadow fits this shape. */
export interface MeasurementTarget {
  connectionString(): string;
  /** only needed for cold-ish measurements, which restart the container */
  containerName?: string;
}

export class HarnessFailure extends Error {
  constructor(
    public readonly kind: FailureKind,
    message: string,
    public readonly phase: Failure['phase'],
    public readonly sqlState: string | null = null,
  ) {
    super(message);
    this.name = 'HarnessFailure';
  }
}

/** What a result carries when the shadow check was disabled for a test: visibly not a shadow result. */
export const UNVERIFIED_REF: ShadowRef = {
  manifestId: 'UNVERIFIED-NOT-A-SHADOW',
  sampled: false,
  mode: 'full',
  totalRowRatio: 1,
  largestTableRatio: 1,
  scalingNote: 'The shadow check was disabled for a test: this database is NOT a verified shadow.',
};

export function shadowRef(m: ShadowManifest): ShadowRef {
  return {
    manifestId: m.id,
    sampled: m.scaling.sampled,
    mode: m.mode,
    totalRowRatio: m.scaling.totalRowRatio,
    largestTableRatio: m.scaling.largestTableRatio,
    scalingNote: m.scaling.note,
  };
}

/** Maps whatever went wrong into a typed failure kind. */
export function toHarnessFailure(e: unknown, phase: Failure['phase']): HarnessFailure {
  if (e instanceof HarnessFailure) return e;
  const err = e as { code?: string; message?: string };
  const message = err.message ?? String(e);
  switch (err.code) {
    case '57014':
      return new HarnessFailure('statement-timeout', message, phase, err.code);
    case '55P03':
      return new HarnessFailure('lock-timeout', message, phase, err.code);
    case '57P01':
    case '57P02':
    case '57P03':
    case '08006':
    case '08003':
      return new HarnessFailure('connection-error', message, phase, err.code);
  }
  if (/ECONN|ETIMEDOUT|Connection terminated|timeout expired|EPIPE/i.test(message)) {
    return new HarnessFailure('connection-error', message, phase, err.code ?? null);
  }
  return new HarnessFailure('sql-error', message, phase, err.code ?? null);
}

export interface OpenOptions {
  applicationName: string;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  connectTimeoutMs: number;
  /** test-only; never set from a public function */
  skipShadowCheck: boolean;
}

export interface OpenSession {
  client: pg.Client;
  manifest: ShadowManifest | null;
  ref: ShadowRef | null;
  environment: {
    postgresVersion: string;
    settings: Record<string, string>;
    limits: { cpus: number; memoryMiB: number; memorySwapMiB: number; shmMiB: number } | null;
  };
}

const REPORTED = [
  'shared_buffers',
  'work_mem',
  'effective_cache_size',
  'max_parallel_workers_per_gather',
  'jit',
  'random_page_cost',
  'track_io_timing',
  'default_statistics_target',
] as const;

/**
 * Connects, and BEFORE running anything else checks the shadow marker. A database that is not a
 * shadow is refused with kind 'refused-not-shadow'; the caller's statement is never sent to it.
 * The only way to skip the check is `skipShadowCheck`, which exists for the tests of the harness
 * itself, is not part of any public option type, and is only reachable through internal-testing.ts.
 */
export async function openSession(target: MeasurementTarget, o: OpenOptions): Promise<OpenSession> {
  const client = new pg.Client({
    connectionString: target.connectionString(),
    application_name: o.applicationName,
    connectionTimeoutMillis: o.connectTimeoutMs,
  });
  client.on('error', () => undefined); // a dropped connection surfaces through the pending query
  try {
    await client.connect();
  } catch (e) {
    throw new HarnessFailure(
      'connection-error',
      (e as Error).message,
      'connect',
      (e as { code?: string }).code ?? null,
    );
  }
  try {
    let manifest: ShadowManifest | null = null;
    if (!o.skipShadowCheck) {
      try {
        manifest = (await assertShadow(client)).manifest;
      } catch (e) {
        if (e instanceof NotShadowError)
          throw new HarnessFailure('refused-not-shadow', e.message, 'check');
        throw toHarnessFailure(e, 'check');
      }
    }
    await client.query(`SET statement_timeout = ${Math.max(1, Math.floor(o.statementTimeoutMs))}`);
    await client.query(`SET lock_timeout = ${Math.max(0, Math.floor(o.lockTimeoutMs))}`);
    // Lets EXPLAIN report how long block reads took (separates "from the OS cache" from "from disk").
    await client.query('SET track_io_timing = on').catch(() => undefined);
    const v = await client.query<{ v: string }>(`SELECT current_setting('server_version') AS v`);
    const settings: Record<string, string> = {};
    for (const name of REPORTED) {
      const r = await client.query<{ v: string }>('SELECT current_setting($1) AS v', [name]);
      settings[name] = r.rows[0]!.v;
    }
    const lim = manifest?.container.limits;
    return {
      client,
      manifest,
      ref: manifest ? shadowRef(manifest) : UNVERIFIED_REF,
      environment: {
        postgresVersion: v.rows[0]!.v,
        settings,
        limits: lim
          ? {
              cpus: lim.cpus,
              memoryMiB: lim.memoryMiB,
              memorySwapMiB: lim.memorySwapMiB,
              shmMiB: lim.shmMiB,
            }
          : null,
      },
    };
  } catch (e) {
    await closeQuietly(client);
    throw e;
  }
}

export async function closeQuietly(client: pg.Client): Promise<void> {
  await Promise.race([
    client.end().catch(() => undefined),
    new Promise((r) => setTimeout(r, 2000)),
  ]);
}

/**
 * Runs `fn`, but gives up after `ms`: the connection is destroyed and a 'client-watchdog' failure is
 * thrown. This is what keeps a measurement from hanging when the server stops answering (a stuck
 * container) although statement_timeout should have fired.
 */
export async function withWatchdog<T>(
  client: pg.Client,
  ms: number,
  fn: () => Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const pending = fn();
  pending.catch(() => undefined);
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const stream = (client as unknown as { connection?: { stream?: { destroy(): void } } })
            .connection?.stream;
          stream?.destroy();
          reject(
            new HarnessFailure(
              'client-watchdog',
              `no answer from the server within ${ms} ms (statement timeout plus grace); connection dropped`,
              'measured',
            ),
          );
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Grace period on top of statement_timeout before the client-side watchdog fires. */
export const WATCHDOG_GRACE_MS = 3000;

export async function waitUntilReady(target: MeasurementTarget, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const c = new pg.Client({
      connectionString: target.connectionString(),
      connectionTimeoutMillis: 2000,
    });
    c.on('error', () => undefined);
    try {
      await c.connect();
      await c.query('SELECT 1');
      await c.end();
      return;
    } catch (e) {
      last = (e as Error).message;
      await c.end().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new HarnessFailure(
    'connection-error',
    `shadow did not come back after restart: ${last}`,
    'measured',
  );
}

/**
 * Restarts the shadow's Postgres (empties shared_buffers). With dropOsCache it also drops the page
 * cache of the Linux kernel the container runs in (on Docker Desktop: the VM), through a privileged
 * helper container started from the same image. Returns what was actually achieved.
 */
export async function restartPostgres(
  target: MeasurementTarget,
  dropOsCache: boolean,
): Promise<{ droppedOsCache: boolean; note: string }> {
  if (!target.containerName) {
    throw new HarnessFailure(
      'invalid-input',
      'cold-ish measurements need the shadow container name',
      'measured',
    );
  }
  await docker(['restart', '-t', '30', target.containerName]);
  let dropped = false;
  let note = '';
  if (dropOsCache) {
    const image = (
      await docker(['inspect', target.containerName, '--format', '{{.Config.Image}}'])
    ).stdout.trim();
    const r = await docker(
      [
        'run',
        '--rm',
        '--privileged',
        '--entrypoint',
        'sh',
        image,
        '-c',
        'sync; echo 3 > /proc/sys/vm/drop_caches && echo dropped',
      ],
      { allowFail: true, timeoutMs: 60_000 },
    );
    dropped = r.code === 0 && r.stdout.includes('dropped');
    note = dropped ? '' : `dropping the OS cache failed: ${r.stderr.trim().slice(0, 200)}`;
  }
  await waitUntilReady(target);
  return { droppedOsCache: dropped, note };
}

export interface BackgroundReading {
  workers: number;
  autovacuumRuns: number;
  checkpoints: number;
}

/** Counters of background work in the database, read at the start and at the end of a measurement. */
export async function readBackground(client: pg.Client): Promise<BackgroundReading> {
  const r = await client.query<{ workers: string; runs: string; checkpoints: string }>(
    `SELECT (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'autovacuum worker')::text AS workers,
            (SELECT COALESCE(sum(autovacuum_count + autoanalyze_count), 0) FROM pg_stat_user_tables)::text AS runs,
            (SELECT checkpoints_timed + checkpoints_req FROM pg_stat_bgwriter)::text AS checkpoints`,
  );
  const row = r.rows[0]!;
  return {
    workers: Number(row.workers),
    autovacuumRuns: Number(row.runs),
    checkpoints: Number(row.checkpoints),
  };
}

export function backgroundBetween(start: BackgroundReading, end: BackgroundReading): Background {
  const runs = Math.max(0, end.autovacuumRuns - start.autovacuumRuns);
  const checkpoints = Math.max(0, end.checkpoints - start.checkpoints);
  return {
    autovacuumWorkersAtStart: start.workers,
    autovacuumWorkersAtEnd: end.workers,
    autovacuumRunsDuring: runs,
    checkpointsDuring: checkpoints,
    quiet: start.workers === 0 && end.workers === 0 && runs === 0 && checkpoints === 0,
  };
}
