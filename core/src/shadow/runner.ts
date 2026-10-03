import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transform, type Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { docker, dockerHostInfo, redact } from './docker.js';
import {
  containerNameFor,
  destroyShadow,
  labelArgs,
  shadowLabels,
  volumeNameFor,
} from './lifecycle.js';
import {
  MANIFEST_VERSION,
  parseManifest,
  type SamplingRule,
  type ShadowManifest,
  type TableManifest,
} from './manifest.js';
import { MARKER_SCHEMA, MARKER_TABLE, SHADOW_GUC, assertShadow } from './marker.js';
import { DEFAULT_RULE, planFull, planSampling, type TablePlan } from './sampling.js';
import {
  PLANNER_SETTINGS,
  REPORTED_SETTINGS,
  SourceSession,
  assertSourceReadOnly,
  readCatalog,
  readSourceInfo,
  sourceClientConfig,
  type Catalog,
  type CatalogRelation,
} from './source.js';
import { qi, qtable } from './sql.js';

export const SHADOW_IMAGE_TAG = 'ledgerworks/shadow-postgres:16.15-hypopg1.4.3';
export const SHADOW_DB = 'shadow';
export const SHADOW_ADMIN = 'shadow_admin';
/** Schema the shadow runner installs its own extensions into, so the user's schemas stay identical. */
export const EXT_SCHEMA = 'ledgerworks_ext';

export interface ContainerLimits {
  cpus: number;
  memoryMiB: number;
  shmMiB: number;
  pidsLimit: number;
}
export const DEFAULT_LIMITS: ContainerLimits = {
  cpus: 2,
  memoryMiB: 3072,
  shmMiB: 256,
  pidsLimit: 512,
};
/** What is kept free for the source database when it runs on the same Docker host. */
export const DEFAULT_SOURCE_RESERVE = { cpus: 2, memoryMiB: 2048 };

export interface CreateShadowOptions {
  /** Connection string of the READ-ONLY source role. Never logged, never stored. */
  sourceUrl: string;
  mode: 'full' | 'sampled';
  /** required when mode is 'sampled' */
  sampling?: Partial<SamplingRule> & Pick<SamplingRule, 'rootTable' | 'ratio'>;
  limits?: Partial<ContainerLimits>;
  /** CPUs and memory that must stay free on the Docker host for the source (refuses otherwise). */
  sourceReserve?: { cpus: number; memoryMiB: number };
  /** Name of the source's container, if it runs on this Docker host: its memory is sampled and its health checked. */
  sourceContainer?: string;
  /** Concurrent COPY streams (each holds one source connection). Default 2. */
  copyParallelism?: number;
  /** Cap on the data rate read from the source, in MB/s. Default: unthrottled. */
  maxSourceMBps?: number;
  /** Statement timeout of every source session, in ms. Default 30 minutes (a COPY of one table is one statement). */
  sourceStatementTimeoutMs?: number;
  allowWritableSource?: boolean;
  /** Overrides of the shadow's postgres settings (name to value), applied after the defaults. */
  postgresSettings?: Record<string, string>;
  imageTag?: string;
  /** Host name the shadow container uses to reach a source on localhost. Default host.docker.internal. */
  sourceHostInContainer?: string;
  /** Where manifests are written. Default $LEDGERWORKS_SHADOW_DIR or <tmp>/ledgerworks-shadow. */
  manifestDir?: string;
  runId?: string;
  /** Called at the start of every stage; throwing aborts the clone (used to test failure cleanup). */
  onStage?: (stage: string) => void | Promise<void>;
  log?: (message: string) => void;
}

export interface ShadowHandle {
  runId: string;
  containerName: string;
  volumeName: string;
  port: number;
  manifest: ShadowManifest;
  manifestPath: string | null;
  /** Includes the generated password; keep it in memory, never log it. */
  connectionString(): string;
  connect(): Promise<pg.Client>;
  destroy(): Promise<void>;
}

export class ResourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceError';
  }
}
export class UnsupportedExtensionError extends Error {
  constructor(public readonly missing: string[]) {
    super(`The shadow image cannot provide these source extensions: ${missing.join(', ')}`);
    this.name = 'UnsupportedExtensionError';
  }
}
export class CloneVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloneVerificationError';
  }
}

const MIB = 1024 * 1024;

function pgEnvFromUrl(url: string, hostInContainer: string): Record<string, string> {
  const u = new URL(url);
  let host = u.hostname.replace(/^\[|\]$/g, '');
  if (['localhost', '127.0.0.1', '::1'].includes(host)) host = hostInContainer;
  const env: Record<string, string> = {
    PGHOST: host,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
    PGCONNECT_TIMEOUT: '15',
    PGAPPNAME: 'ledgerworks-shadow-dump',
  };
  const ssl = u.searchParams.get('sslmode');
  if (ssl) env.PGSSLMODE = ssl;
  return env;
}

/** Image: build it from core/docker/shadow when it is not present. */
export async function ensureShadowImage(tag: string, log: (m: string) => void): Promise<string> {
  const have = await docker(['image', 'inspect', tag, '--format', '{{.Id}}'], { allowFail: true });
  if (have.code === 0) return have.stdout.trim();
  log(`building shadow image ${tag}`);
  const context = fileURLToPath(new URL('../../docker/shadow', import.meta.url));
  await docker(['build', '-t', tag, context], { timeoutMs: 1_200_000 });
  return (await docker(['image', 'inspect', tag, '--format', '{{.Id}}'])).stdout.trim();
}

function parseMem(s: string): number {
  const m = /^([\d.]+)\s*([KMGT]?i?B)/i.exec(s.trim());
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const f = unit.startsWith('k')
    ? 1 / 1024
    : unit.startsWith('g')
      ? 1024
      : unit.startsWith('t')
        ? 1024 * 1024
        : unit === 'b'
          ? 1 / MIB
          : 1;
  return n * f; // MiB
}

/** Polls `docker stats` and keeps the highest memory use seen per container. */
function startMemoryMonitor(names: string[]): {
  stop(): Promise<{ peaks: Map<string, number>; samples: number }>;
} {
  const peaks = new Map<string, number>();
  let samples = 0;
  let running = true;
  const loop = (async () => {
    while (running) {
      const r = await docker(
        ['stats', '--no-stream', '--format', '{{.Name}}|{{.MemUsage}}', ...names],
        {
          allowFail: true,
          timeoutMs: 30_000,
        },
      );
      if (r.code === 0) {
        samples++;
        for (const line of r.stdout.split('\n')) {
          const [name, usage] = line.trim().split('|');
          if (!name || !usage) continue;
          const used = parseMem(usage.split('/')[0]!);
          peaks.set(name, Math.max(peaks.get(name) ?? 0, used));
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      return { peaks, samples };
    },
  };
}

function throttle(mbps: number): Transform {
  const started = Date.now();
  let bytes = 0;
  return new Transform({
    async transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      const dueMs = (bytes / (mbps * 1_000_000)) * 1000 - (Date.now() - started);
      if (dueMs > 0) await new Promise((resolve) => setTimeout(resolve, dueMs));
      cb(null, chunk);
    },
  });
}

async function waitForPostgres(connect: () => pg.Client, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    const c = connect();
    c.on('error', () => undefined);
    try {
      await c.connect();
      await c.query('SELECT 1');
      await c.end();
      return;
    } catch (e) {
      last = e;
      await c.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(
    `shadow postgres did not become ready: ${String((last as Error)?.message ?? last)}`,
  );
}

function sumByAncestors(catalog: Catalog, leafCounts: Map<number, number>): Map<number, number> {
  const byOid = new Map(catalog.relations.map((r) => [r.oid, r]));
  const out = new Map<number, number>();
  for (const [oid, n] of leafCounts) {
    let cur: CatalogRelation | undefined = byOid.get(oid);
    while (cur) {
      out.set(cur.oid, (out.get(cur.oid) ?? 0) + n);
      cur = cur.parentOid === null ? undefined : byOid.get(cur.parentOid);
    }
  }
  return out;
}

export async function createShadow(opts: CreateShadowOptions): Promise<ShadowHandle> {
  const runId = opts.runId ?? randomUUID();
  const log = opts.log ?? (() => undefined);
  const secrets: string[] = [];
  try {
    const u = new URL(opts.sourceUrl);
    if (u.password) secrets.push(decodeURIComponent(u.password), u.password);
  } catch {
    throw new Error('sourceUrl is not a valid connection string');
  }
  const createdAt = new Date();
  const t0 = performance.now();
  const stages: { name: string; durationMs: number }[] = [];
  const stage = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    log(`stage ${name}`);
    const s = performance.now();
    try {
      await opts.onStage?.(name);
      return await fn();
    } finally {
      stages.push({ name, durationMs: Math.round(performance.now() - s) });
    }
  };

  const containerName = containerNameFor(runId);
  const volumeName = volumeNameFor(runId);
  const password = randomBytes(24).toString('hex');
  secrets.push(password);
  const limits: ContainerLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  const reserve = opts.sourceReserve ?? DEFAULT_SOURCE_RESERVE;
  const imageTag = opts.imageTag ?? SHADOW_IMAGE_TAG;
  const parallelism = Math.max(1, opts.copyParallelism ?? 2);
  const stmtTimeout = opts.sourceStatementTimeoutMs ?? 30 * 60_000;
  const appName = `ledgerworks-shadow-${runId.slice(0, 8)}`;
  const srcCfg = (): pg.ClientConfig =>
    sourceClientConfig(opts.sourceUrl, {
      statementTimeoutMs: stmtTimeout,
      lockTimeoutMs: 10_000,
      applicationName: appName,
    });
  const metaCfg = (): pg.ClientConfig =>
    sourceClientConfig(opts.sourceUrl, {
      statementTimeoutMs: 60_000,
      lockTimeoutMs: 10_000,
      applicationName: appName,
    });
  const warnings: string[] = [];
  const sourceHostInContainer = opts.sourceHostInContainer ?? 'host.docker.internal';

  // Held in an object: TypeScript does not track assignments made inside the stage callbacks.
  const st: {
    coordinator?: SourceSession;
    monitor?: ReturnType<typeof startMemoryMonitor>;
    healthBefore?: { oom: boolean; restarts: number; started: string };
  } = {};
  const inspectSource = async (): Promise<
    { oom: boolean; restarts: number; started: string } | undefined
  > => {
    if (!opts.sourceContainer) return undefined;
    const r = await docker(
      [
        'inspect',
        opts.sourceContainer,
        '--format',
        '{{.State.OOMKilled}}|{{.RestartCount}}|{{.State.StartedAt}}',
      ],
      { allowFail: true },
    );
    if (r.code !== 0) return undefined;
    const [oom, restarts, started] = r.stdout.trim().split('|');
    return { oom: oom === 'true', restarts: Number(restarts), started: started ?? '' };
  };

  try {
    if (opts.mode === 'sampled' && !opts.sampling)
      throw new Error("mode 'sampled' needs a sampling rule");

    // ---- 1. preflight: resources, source safety, snapshot, catalog --------------------------
    const pre = await stage('preflight', async () => {
      const host = await dockerHostInfo();
      if (limits.cpus + reserve.cpus > host.cpus) {
        throw new ResourceError(
          `Docker host has ${host.cpus} CPUs; the shadow needs ${limits.cpus} and ${reserve.cpus} must stay free for the source.`,
        );
      }
      if (limits.memoryMiB + reserve.memoryMiB + 1024 > host.memoryMiB) {
        throw new ResourceError(
          `Docker host has ${host.memoryMiB} MiB; the shadow needs ${limits.memoryMiB} MiB, ${reserve.memoryMiB} MiB must stay free for the source and 1024 MiB for the VM itself.`,
        );
      }
      const ro = await assertSourceReadOnly(opts.sourceUrl, {
        allowWritableSource: opts.allowWritableSource,
        log,
      });
      if (ro.overrideUsed)
        warnings.push('allowWritableSource override used: the source role could write');
      st.coordinator = await SourceSession.connect(metaCfg());
      const coordinator = st.coordinator;
      await coordinator.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const snap = await coordinator.query<{ id: string }>('SELECT pg_export_snapshot() AS id');
      const info = await readSourceInfo(coordinator);
      if (info.rlsTablesWithoutBypass.length) {
        throw new Error(
          `The source role is subject to row-level security on ${info.rlsTablesWithoutBypass.join(', ')}: a copy would miss rows. ` +
            'Give the role BYPASSRLS (provisionReaderRole does).',
        );
      }
      const catalog = await readCatalog(coordinator);
      const rule: SamplingRule | null =
        opts.mode === 'sampled' ? { ...DEFAULT_RULE, ...opts.sampling! } : null;
      const plan: TablePlan[] = rule ? planSampling(catalog, rule) : planFull(catalog);
      st.healthBefore = await inspectSource();
      return { host, ro, snapshotId: snap.rows[0]!.id, info, catalog, rule, plan };
    });
    const { host, info, catalog, rule } = pre;

    // ---- 2. image ---------------------------------------------------------------------------
    const imageId = await stage('image', () => ensureShadowImage(imageTag, log));

    // ---- 3. container -----------------------------------------------------------------------
    const labels = shadowLabels(runId, opts.mode, createdAt);
    const pgSettings: Record<string, string> = {
      shared_preload_libraries: 'pg_stat_statements',
      'pg_stat_statements.track': 'all',
      shared_buffers: `${Math.floor(limits.memoryMiB * 0.25)}MB`,
      maintenance_work_mem: `${Math.min(256, Math.floor(limits.memoryMiB * 0.06))}MB`,
      max_wal_size: '2GB',
      max_connections: '50',
    };
    for (const name of PLANNER_SETTINGS) pgSettings[name] = info.settings[name]!;
    Object.assign(pgSettings, opts.postgresSettings);

    const port = await stage('container', async () => {
      await docker(['volume', 'create', ...labelArgs(labels), volumeName]);
      await docker(
        [
          'run',
          '-d',
          '--name',
          containerName,
          ...labelArgs(labels),
          '--cpus',
          String(limits.cpus),
          '--memory',
          `${limits.memoryMiB}m`,
          '--memory-swap',
          `${limits.memoryMiB}m`,
          '--shm-size',
          `${limits.shmMiB}m`,
          '--pids-limit',
          String(limits.pidsLimit),
          '-v',
          `${volumeName}:/var/lib/postgresql/data`,
          '-p',
          '127.0.0.1::5432',
          '--add-host',
          'host.docker.internal:host-gateway',
          '-e',
          `POSTGRES_USER=${SHADOW_ADMIN}`,
          '-e',
          'POSTGRES_PASSWORD',
          '-e',
          `POSTGRES_DB=${SHADOW_DB}`,
          imageTag,
          'postgres',
          ...Object.entries(pgSettings).flatMap(([k, v]) => ['-c', `${k}=${v}`]),
        ],
        { env: { POSTGRES_PASSWORD: password }, secrets },
      );
      const p = (await docker(['port', containerName, '5432/tcp'])).stdout.trim().split('\n')[0]!;
      const portNumber = Number(p.slice(p.lastIndexOf(':') + 1));
      st.monitor = startMemoryMonitor([
        containerName,
        ...(opts.sourceContainer ? [opts.sourceContainer] : []),
      ]);
      await waitForPostgres(() => shadowClient(portNumber, password), 120_000);
      return portNumber;
    });

    const shadow = shadowClient(port, password);
    shadow.on('error', () => undefined);
    await shadow.connect();
    let shadowVersion = '';
    let hypopgVersion: string | null = null;
    let pgssVersion: string | null = null;
    try {
      // ---- 4. extension availability --------------------------------------------------------
      await stage('extension-check', async () => {
        const avail = await shadow.query<{ name: string; default_version: string }>(
          'SELECT name, default_version FROM pg_available_extensions',
        );
        const names = new Set(avail.rows.map((r) => r.name));
        const missing = info.extensions
          .map((e) => e.name)
          .filter((n) => n !== 'plpgsql' && !names.has(n));
        if (missing.length) throw new UnsupportedExtensionError(missing);
        hypopgVersion = avail.rows.find((r) => r.name === 'hypopg')?.default_version ?? null;
        pgssVersion =
          avail.rows.find((r) => r.name === 'pg_stat_statements')?.default_version ?? null;
        shadowVersion = (
          await shadow.query<{ v: string }>(`SELECT current_setting('server_version') AS v`)
        ).rows[0]!.v;
      });

      // ---- 5. roles and settings --------------------------------------------------------------
      const createdRoles = await stage('roles', async () => {
        const out: ShadowManifest['roles'] = [];
        for (const r of info.roles) {
          if (r.name === SHADOW_ADMIN) {
            warnings.push(
              `source role "${SHADOW_ADMIN}" collides with the shadow administrator and was not created`,
            );
            continue;
          }
          // NOLOGIN, no password, never a superuser: the names and attributes are what experiments need.
          const attrs = [
            'NOLOGIN',
            'NOSUPERUSER',
            r.bypassRls ? 'BYPASSRLS' : 'NOBYPASSRLS',
            r.createDb ? 'CREATEDB' : 'NOCREATEDB',
            r.createRole ? 'CREATEROLE' : 'NOCREATEROLE',
            r.inherit ? 'INHERIT' : 'NOINHERIT',
          ].join(' ');
          await shadow.query(`CREATE ROLE ${qi(r.name)} ${attrs}`);
          out.push({ name: r.name, bypassRls: r.bypassRls, wasSuperuser: r.superuser });
        }
        const created = new Set(out.map((r) => r.name));
        for (const m of info.memberships) {
          if (created.has(m.role) && created.has(m.member)) {
            await shadow.query(`GRANT ${qi(m.role)} TO ${qi(m.member)}`);
          }
        }
        for (const s of info.roleSettings) {
          if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(s.name)) continue;
          if (s.name === 'default_transaction_read_only' || s.name.startsWith('ledgerworks.'))
            continue;
          if (s.role !== null && !created.has(s.role)) continue;
          try {
            await shadow.query('SELECT set_config($1, $2, false)', [s.name, s.value]);
            const target =
              s.role === null
                ? `DATABASE ${qi(SHADOW_DB)}`
                : `ROLE ${qi(s.role)} IN DATABASE ${qi(SHADOW_DB)}`;
            await shadow.query(`ALTER ${target} SET ${s.name} FROM CURRENT`);
            await shadow.query(`RESET ${s.name}`);
          } catch (e) {
            warnings.push(
              `could not copy setting ${s.name} for ${s.role ?? 'database'}: ${(e as Error).message}`,
            );
            await shadow.query('RESET ALL').catch(() => undefined);
          }
        }
        return out;
      });

      // ---- 6. schema ----------------------------------------------------------------------------
      await stage('schema-dump', async () => {
        const env = pgEnvFromUrl(opts.sourceUrl, sourceHostInContainer);
        env.PGOPTIONS = '-c default_transaction_read_only=on';
        const names = Object.keys(env).flatMap((k) => ['-e', k]);
        await docker(
          [
            'exec',
            ...names,
            containerName,
            'pg_dump',
            '-Fc',
            '--schema-only',
            '--no-publications',
            '--no-subscriptions',
            `--exclude-schema=${MARKER_SCHEMA}`,
            '--lock-wait-timeout=10000',
            `--snapshot=${pre.snapshotId}`,
            '-f',
            '/tmp/schema.dump',
          ],
          { env, secrets, timeoutMs: stmtTimeout },
        );
      });
      const restoreArgs = (section: string, extra: string[] = []): string[] => [
        'exec',
        containerName,
        'pg_restore',
        '-U',
        SHADOW_ADMIN,
        '-d',
        SHADOW_DB,
        `--section=${section}`,
        '--exit-on-error',
        ...extra,
        '/tmp/schema.dump',
      ];
      await stage('restore-pre', async () => {
        await docker(restoreArgs('pre-data'), { secrets });
      });

      // ---- 7. data ------------------------------------------------------------------------------
      const planByOid = new Map(pre.plan.map((p) => [p.table.oid, p]));
      const byOid = new Map(catalog.relations.map((r) => [r.oid, r]));
      const topOf = (r: CatalogRelation): CatalogRelation => {
        let cur = r;
        while (cur.parentOid !== null && byOid.has(cur.parentOid)) cur = byOid.get(cur.parentOid)!;
        return cur;
      };
      const leaves = catalog.relations.filter((r) => r.relkind === 'r' && r.columns.length > 0);
      const sourceTotals = new Map<number, number>();
      const copied = new Map<number, number>();
      await stage('copy-data', async () => {
        const queue = [...leaves].sort((a, b) => b.bytes - a.bytes);
        let failure: unknown;
        const ac = new AbortController();
        const worker = async (): Promise<void> => {
          const src = await SourceSession.connect(srcCfg());
          const dst = shadowClient(port, password);
          dst.on('error', () => undefined);
          try {
            await dst.connect();
            await src.beginAtSnapshot(pre.snapshotId);
            while (!failure) {
              const rel = queue.shift();
              if (!rel) return;
              const plan = planByOid.get(topOf(rel).oid)!;
              const cols = rel.columns.map(qi).join(', ');
              const from = `ONLY ${qtable(rel.schema, rel.name)}`;
              const total = await src.query<{ n: string }>(`SELECT count(*) AS n FROM ${from}`);
              sourceTotals.set(rel.oid, Number(total.rows[0]!.n));
              const where = plan.predicate ? ` WHERE ${plan.predicate}` : '';
              const out = src.copyOut(`COPY (SELECT ${cols} FROM ${from} t${where}) TO STDOUT`);
              const into = dst.query(
                copyFrom(`COPY ${qtable(rel.schema, rel.name)} (${cols}) FROM STDIN`),
              );
              const streams = opts.maxSourceMBps
                ? [out, throttle(opts.maxSourceMBps), into]
                : [out, into];
              await pipeline(streams as unknown as [Readable, Writable], { signal: ac.signal });
              copied.set(rel.oid, into.rowCount);
              log(
                `  copied ${rel.schema}.${rel.name}: ${into.rowCount} of ${sourceTotals.get(rel.oid)} rows`,
              );
            }
          } catch (e) {
            failure ??= e;
            ac.abort();
            throw e;
          } finally {
            await src.end();
            await dst.end().catch(() => undefined);
          }
        };
        const results = await Promise.allSettled(Array.from({ length: parallelism }, worker));
        const firstFailure = results.find((r) => r.status === 'rejected');
        if (firstFailure && firstFailure.status === 'rejected') {
          throw failure ?? firstFailure.reason;
        }
      });

      await stage('sequences', async () => {
        const seqs = await st.coordinator!.query<{
          schemaname: string;
          sequencename: string;
          last_value: string;
        }>(
          `SELECT schemaname, sequencename, last_value::text FROM pg_sequences
            WHERE last_value IS NOT NULL AND schemaname NOT IN ('pg_catalog','information_schema')`,
        );
        for (const s of seqs.rows) {
          await shadow.query('SELECT setval($1::regclass, $2::bigint, true)', [
            qtable(s.schemaname, s.sequencename),
            s.last_value,
          ]);
        }
      });
      const matviews = await st.coordinator!.query<{
        schemaname: string;
        matviewname: string;
        ispopulated: boolean;
      }>(
        `SELECT schemaname, matviewname, ispopulated FROM pg_matviews WHERE schemaname NOT IN ('pg_catalog','information_schema')`,
      );
      // The snapshot is no longer needed: release the source transaction as early as possible.
      await st.coordinator!.end();
      st.coordinator = undefined;

      // ---- 8. constraints, indexes, policies, triggers ---------------------------------------
      await stage('restore-post', async () => {
        await docker(
          restoreArgs('post-data', ['-j', String(Math.max(1, Math.min(limits.cpus, 4)))]),
          { secrets },
        );
      });
      await stage('matviews', async () => {
        let pending = matviews.rows.filter((m) => m.ispopulated);
        for (let pass = 0; pass < 3 && pending.length; pass++) {
          const failed: typeof pending = [];
          for (const m of pending) {
            try {
              await shadow.query(
                `REFRESH MATERIALIZED VIEW ${qtable(m.schemaname, m.matviewname)}`,
              );
            } catch {
              failed.push(m);
            }
          }
          pending = failed;
        }
        for (const m of pending)
          warnings.push(
            `materialized view ${m.schemaname}.${m.matviewname} could not be refreshed`,
          );
      });

      // ---- 9. extensions for later phases, statistics ---------------------------------------
      await stage('extensions', async () => {
        const have = new Set(
          (await shadow.query<{ extname: string }>('SELECT extname FROM pg_extension')).rows.map(
            (r) => r.extname,
          ),
        );
        await shadow.query(`CREATE SCHEMA IF NOT EXISTS ${qi(EXT_SCHEMA)}`);
        for (const e of ['pg_stat_statements', 'hypopg']) {
          if (!have.has(e))
            await shadow.query(`CREATE EXTENSION ${qi(e)} SCHEMA ${qi(EXT_SCHEMA)}`);
        }
        const ns = await shadow.query<{ nspname: string }>(
          `SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_stat_statements'`,
        );
        await shadow.query(`SELECT ${qi(ns.rows[0]!.nspname)}.pg_stat_statements_reset()`);
      });
      await stage('analyze', async () => {
        await shadow.query('ANALYZE');
      });

      // ---- 10. verify -------------------------------------------------------------------------
      const shadowCounts = new Map<number, number>();
      await stage('verify', async () => {
        for (const rel of leaves) {
          const r = await shadow.query<{ n: string }>(
            `SELECT count(*) AS n FROM ONLY ${qtable(rel.schema, rel.name)}`,
          );
          const n = Number(r.rows[0]!.n);
          shadowCounts.set(rel.oid, n);
          if (n !== copied.get(rel.oid)) {
            throw new CloneVerificationError(
              `${rel.schema}.${rel.name}: copied ${copied.get(rel.oid)} rows but the shadow holds ${n}`,
            );
          }
          if (opts.mode === 'full' && n !== sourceTotals.get(rel.oid)) {
            throw new CloneVerificationError(
              `${rel.schema}.${rel.name}: source has ${sourceTotals.get(rel.oid)} rows, shadow ${n}`,
            );
          }
        }
      });

      // ---- 11. marker (last: a half-finished clone never looks like a shadow) ------------------
      await stage('marker', async () => {
        await shadow.query(`CREATE SCHEMA ${qi(MARKER_SCHEMA)}`);
        await shadow.query(
          `CREATE TABLE ${qi(MARKER_SCHEMA)}.${qi(MARKER_TABLE)} (
             run_id text PRIMARY KEY, created_at timestamptz NOT NULL, source_database text NOT NULL,
             mode text NOT NULL, manifest jsonb)`,
        );
        await shadow.query(
          `INSERT INTO ${qi(MARKER_SCHEMA)}.${qi(MARKER_TABLE)} (run_id, created_at, source_database, mode) VALUES ($1, $2, $3, $4)`,
          [runId, createdAt.toISOString(), info.database, opts.mode],
        );
        // run id is a uuid or caller-chosen id; the literal is quoted by the server-side format()
        const lit = await shadow.query<{ s: string }>('SELECT quote_literal($1) AS s', [runId]);
        await shadow.query(`ALTER DATABASE ${qi(SHADOW_DB)} SET ${SHADOW_GUC} = ${lit.rows[0]!.s}`);
      });

      // ---- manifest ---------------------------------------------------------------------------
      const mem = await st.monitor!.stop();
      st.monitor = undefined;
      const cg = await docker(
        [
          'exec',
          containerName,
          'sh',
          '-c',
          'cat /sys/fs/cgroup/memory.peak 2>/dev/null || cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes 2>/dev/null',
        ],
        { allowFail: true },
      );
      const cgroupPeak = /^\d+$/.test(cg.stdout.trim())
        ? Math.round(Number(cg.stdout.trim()) / MIB)
        : null;
      const healthAfter = await inspectSource();

      const srcByOid = sumByAncestors(catalog, sourceTotals);
      const dstByOid = sumByAncestors(catalog, shadowCounts);
      const tables: TableManifest[] = catalog.relations.map((r) => {
        const plan = planByOid.get(topOf(r).oid)!;
        const sourceRows = srcByOid.get(r.oid) ?? 0;
        const shadowRows = dstByOid.get(r.oid) ?? 0;
        return {
          schema: r.schema,
          name: r.name,
          kind: r.relkind === 'p' ? 'partitioned-table' : r.isPartition ? 'partition' : 'table',
          sourceRows,
          shadowRows,
          ratio: sourceRows === 0 ? 1 : shadowRows / sourceRows,
          selection: plan.selection,
          predicate: plan.predicate,
        };
      });
      const leafRows = tables.filter((t) => t.kind !== 'partitioned-table');
      const sumSrc = leafRows.reduce((a, t) => a + t.sourceRows, 0);
      const sumDst = leafRows.reduce((a, t) => a + t.shadowRows, 0);
      const largest = [...tables].sort((a, b) => b.sourceRows - a.sourceRows)[0];
      const sampled = opts.mode === 'sampled';
      const settingRows = [];
      for (const name of REPORTED_SETTINGS) {
        const r = await shadow.query<{ v: string }>('SELECT current_setting($1) AS v', [name]);
        settingRows.push({ name, source: info.settings[name]!, shadow: r.rows[0]!.v });
      }
      const shadowExt = (
        await shadow.query<{ extname: string }>('SELECT extname FROM pg_extension ORDER BY 1')
      ).rows.map((r) => r.extname);
      const finishedAt = new Date();
      const manifest: ShadowManifest = {
        manifestVersion: MANIFEST_VERSION,
        id: runId,
        createdAt: createdAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        source: {
          database: info.database,
          serverVersion: info.serverVersion,
          readOnlyCheck: {
            canWrite: pre.ro.check.canWrite,
            overrideUsed: pre.ro.overrideUsed,
            reasons: pre.ro.check.reasons,
          },
        },
        mode: opts.mode,
        sampling: rule,
        scaling: {
          sampled,
          totalRowRatio: sumSrc === 0 ? 1 : sumDst / sumSrc,
          largestTableRatio: largest
            ? largest.sourceRows === 0
              ? 1
              : largest.shadowRows / largest.sourceRows
            : 1,
          note: sampled
            ? 'SAMPLED COPY: this shadow holds only part of the data (see per-table ratios). Timings, plan shapes and sizes measured here are NOT full-scale and must be reported as measured on a sample.'
            : 'Full copy: every table has the same row count as the source. Timings still depend on the shadow container limits and settings recorded here, which may differ from production.',
        },
        tables,
        container: {
          name: containerName,
          volume: volumeName,
          limits: {
            cpus: limits.cpus,
            memoryMiB: limits.memoryMiB,
            memorySwapMiB: limits.memoryMiB,
            shmMiB: limits.shmMiB,
            pidsLimit: limits.pidsLimit,
          },
          host: { cpus: host.cpus, memoryMiB: host.memoryMiB, dockerVersion: host.serverVersion },
          sourceReserve: reserve,
        },
        image: {
          tag: imageTag,
          id: imageId,
          postgresVersion: shadowVersion,
          hypopgVersion,
          pgStatStatementsVersion: pgssVersion,
        },
        extensions: { source: info.extensions.map((e) => e.name), shadow: shadowExt },
        roles: createdRoles,
        settings: settingRows,
        copy: {
          method: 'schema-dump+copy-stream',
          parallelism,
          maxSourceMBps: opts.maxSourceMBps ?? null,
          snapshot: 'exported-repeatable-read',
          sourceStatementTimeoutMs: stmtTimeout,
        },
        stages: [...stages],
        totalDurationMs: Math.round(performance.now() - t0),
        memory: {
          shadowPeakSampledMiB: mem.peaks.has(containerName)
            ? Math.round(mem.peaks.get(containerName)!)
            : null,
          shadowCgroupPeakMiB: cgroupPeak,
          sourcePeakSampledMiB:
            opts.sourceContainer && mem.peaks.has(opts.sourceContainer)
              ? Math.round(mem.peaks.get(opts.sourceContainer)!)
              : null,
          samples: mem.samples,
        },
        sourceContainerHealth:
          opts.sourceContainer && st.healthBefore && healthAfter
            ? {
                name: opts.sourceContainer,
                oomKilledBefore: st.healthBefore.oom,
                oomKilledAfter: healthAfter.oom,
                restartCountBefore: st.healthBefore.restarts,
                restartCountAfter: healthAfter.restarts,
                startedAtBefore: st.healthBefore.started,
                startedAtAfter: healthAfter.started,
              }
            : null,
        warnings,
      };
      const validated = parseManifest(manifest);
      await shadow.query(
        `UPDATE ${qi(MARKER_SCHEMA)}.${qi(MARKER_TABLE)} SET manifest = $1::jsonb WHERE run_id = $2`,
        [JSON.stringify(validated), runId],
      );
      // The marker must now pass the same check that the harness applies. The database-level setting
      // only reaches new sessions, so check on a fresh connection.
      const fresh = shadowClient(port, password);
      await fresh.connect();
      try {
        await assertShadow(fresh);
      } finally {
        await fresh.end();
      }

      const dir =
        opts.manifestDir ??
        process.env.LEDGERWORKS_SHADOW_DIR ??
        path.join(os.tmpdir(), 'ledgerworks-shadow');
      await mkdir(dir, { recursive: true });
      const manifestPath = path.join(dir, `${runId}.json`);
      await writeFile(manifestPath, JSON.stringify(validated, null, 2) + '\n');

      return makeHandle({
        runId,
        containerName,
        volumeName,
        port,
        password,
        manifest: validated,
        manifestPath,
      });
    } finally {
      await shadow.end().catch(() => undefined);
    }
  } catch (e) {
    // Whatever failed, nothing is left behind.
    try {
      await st.monitor?.stop();
    } catch {
      // ignore
    }
    await st.coordinator?.end().catch(() => undefined);
    try {
      await destroyShadow(runId);
    } catch (cleanupError) {
      log(`cleanup after failure also failed: ${redact(String(cleanupError), secrets)}`);
    }
    if (e instanceof Error) e.message = redact(e.message, secrets);
    throw e;
  }
}

function shadowClient(port: number, password: string): pg.Client {
  return new pg.Client({
    host: '127.0.0.1',
    port,
    user: SHADOW_ADMIN,
    password,
    database: SHADOW_DB,
    application_name: 'ledgerworks-shadow',
  });
}

function makeHandle(h: {
  runId: string;
  containerName: string;
  volumeName: string;
  port: number;
  password: string;
  manifest: ShadowManifest;
  manifestPath: string | null;
}): ShadowHandle {
  return {
    runId: h.runId,
    containerName: h.containerName,
    volumeName: h.volumeName,
    port: h.port,
    manifest: h.manifest,
    manifestPath: h.manifestPath,
    connectionString: () =>
      `postgres://${SHADOW_ADMIN}:${h.password}@127.0.0.1:${h.port}/${SHADOW_DB}`,
    connect: async () => {
      const c = shadowClient(h.port, h.password);
      await c.connect();
      return c;
    },
    destroy: async () => {
      await destroyShadow(h.runId);
    },
  };
}

/** Runs `fn` on a fresh shadow and always tears it down, also when `fn` or the clone throws. */
export async function withShadow<T>(
  opts: CreateShadowOptions,
  fn: (shadow: ShadowHandle) => Promise<T>,
): Promise<T> {
  const shadow = await createShadow(opts);
  try {
    return await fn(shadow);
  } finally {
    await shadow.destroy();
  }
}

/** Re-opens a shadow that is already running (for example from another process). */
export async function attachShadow(runId: string): Promise<ShadowHandle> {
  const name = containerNameFor(runId);
  const r = await docker(['inspect', name], { allowFail: true });
  if (r.code !== 0) throw new Error(`no shadow container for run ${runId}`);
  const c = (
    JSON.parse(r.stdout) as {
      Config: { Env: string[]; Labels: Record<string, string> };
      NetworkSettings: { Ports: Record<string, { HostPort: string }[] | null> };
    }[]
  )[0]!;
  if (c.Config.Labels['ledgerworks.shadow'] !== 'true')
    throw new Error(`container ${name} is not a shadow`);
  const password = c.Config.Env.find((e) => e.startsWith('POSTGRES_PASSWORD='))?.slice(
    'POSTGRES_PASSWORD='.length,
  );
  const port = Number(c.NetworkSettings.Ports['5432/tcp']?.[0]?.HostPort);
  if (!password || !port) throw new Error(`cannot determine connection details of ${name}`);
  const client = shadowClient(port, password);
  await client.connect();
  try {
    const { manifest } = await assertShadow(client);
    return makeHandle({
      runId,
      containerName: name,
      volumeName: volumeNameFor(runId),
      port,
      password,
      manifest,
      manifestPath: null,
    });
  } finally {
    await client.end();
  }
}
