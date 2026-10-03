/**
 * C2.2 integration tests: real Docker and Postgres. A full clone of the small Ledgerline demo
 * database is created once; the harness is exercised against it.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { docker } from '../shadow/docker.js';
import { NotShadowError } from '../shadow/marker.js';
import { createShadow, type ShadowHandle } from '../shadow/runner.js';
import { settleShadow } from '../shadow/settle.js';
import {
  ADMIN_URL,
  DEMO_DB,
  ensureDemoSource,
  readerUrlFor,
  withDb,
} from '../shadow/testing/helpers.js';
import * as publicApi from '../index.js';
import { measureDdl, measureQuery, summarizeDdl, summarizeQuery } from './index.js';
import { unsafeMeasureDdlForTests, unsafeMeasureQueryForTests } from './internal-testing.js';
import {
  MeasureDdlOptionsSchema,
  MeasureQueryOptionsSchema,
  QueryMeasurementSchema,
  DdlMeasurementSchema,
} from './schema.js';
import { summarizePlan } from './plan.js';
import { classifyStatement } from './statement.js';
import { computeStats, percentile } from './stats.js';
import { runVarianceExperiment } from './variance.js';

const results: Record<string, unknown> = {};
let shadow: ShadowHandle;
let sourceAdmin: string;
let tenant: string;

const ALIAS_SQL = `SELECT id, event_type, quantity,
       to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at, metadata
  FROM usage_events
 WHERE tenant_id = $1 AND occurred_at >= '2000-01-01T00:00:00Z'::timestamptz AND occurred_at < '2100-01-01T00:00:00Z'::timestamptz
 ORDER BY occurred_at DESC, id DESC
 LIMIT 51`;
// The same query with the E1 fix (ORDER BY names the table column, so the index order is used).
const FIXED_SQL = ALIAS_SQL.replace(
  'ORDER BY occurred_at DESC, id DESC',
  'ORDER BY usage_events.occurred_at DESC, usage_events.id DESC',
);

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** rows + md5 of every row of a table: "the data is unchanged" */
async function tableFingerprint(
  c: pg.Client,
  table: string,
): Promise<{ rows: number; md5: string }> {
  const r = await c.query<{ n: string; h: string }>(
    `SELECT count(*)::text AS n, md5(COALESCE(string_agg(t::text, ',' ORDER BY t::text), '')) AS h FROM ${table} t`,
  );
  return { rows: Number(r.rows[0]!.n), md5: r.rows[0]!.h };
}

beforeAll(async () => {
  sourceAdmin = await ensureDemoSource();
  shadow = await createShadow({ sourceUrl: readerUrlFor(DEMO_DB), mode: 'full' });
  await withClient(shadow.connectionString(), async (c) => {
    tenant = (
      await c.query<{ tenant_id: string }>(
        'SELECT tenant_id FROM usage_events GROUP BY 1 ORDER BY count(*) DESC LIMIT 1',
      )
    ).rows[0]!.tenant_id;
    // scratch tables, created on the shadow only
    await c.query(`CREATE TABLE harness_scratch AS
      SELECT g AS id, g % 1000 AS k, md5(g::text) AS payload FROM generate_series(1, 100000) g`);
    await c.query('ANALYZE harness_scratch');
    await c.query(`CREATE TABLE harness_ddl (
      id int PRIMARY KEY, a int NOT NULL, b text, c varchar(20), d text)`);
    await c.query(
      `INSERT INTO harness_ddl SELECT g, g % 5000, md5(g::text), 'v' || (g % 100), repeat('x', 100) FROM generate_series(1, 200000) g`,
    );
    await c.query('CREATE INDEX harness_ddl_a_idx ON harness_ddl (a)');
    await c.query('ANALYZE harness_ddl');
  });
}, 600_000);

afterAll(async () => {
  await shadow?.destroy();
  const dir = path.resolve(import.meta.dirname, '../../../test-results');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'c2.2-results.json'), JSON.stringify(results, null, 2) + '\n');
});

describe('pure parts', () => {
  it('percentiles and statistics', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(
      percentile(
        Array.from({ length: 20 }, (_, i) => i + 1),
        95,
      ),
    ).toBeCloseTo(19.05, 10);
    const s = computeStats([10, 12, 14]);
    expect(s).toMatchObject({ n: 3, min: 10, max: 14, mean: 12, p50: 12 });
    expect(s.stddev).toBeCloseTo(2, 10);
    expect(s.cvPercent).toBeCloseTo((2 / 12) * 100, 10);
    expect(computeStats([5])).toMatchObject({ stddev: 0, cvPercent: 0, p50: 5, p95: 5 });
  });

  it('classifies statements and picks a strategy', () => {
    const c = classifyStatement;
    expect(c('SELECT 1')).toBe('read');
    expect(c('  -- comment\n WITH x AS (SELECT 1) SELECT * FROM x')).toBe('read');
    expect(c("SELECT 'delete from t'")).toBe('read');
    expect(c('SELECT * FROM t FOR UPDATE')).toBe('dml');
    expect(c('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d')).toBe('dml');
    expect(c('UPDATE t SET a = 1')).toBe('dml');
    expect(c('INSERT INTO t VALUES (1)')).toBe('dml');
    expect(c('ALTER TABLE t ADD COLUMN a int')).toBe('ddl');
    expect(c('CREATE INDEX i ON t (a)')).toBe('ddl');
    expect(c('TRUNCATE t')).toBe('ddl');
    expect(c('CREATE INDEX CONCURRENTLY i ON t (a)')).toBe('non-transactional');
    expect(c('create unique index concurrently i on t (a)')).toBe('non-transactional');
    expect(c('REINDEX INDEX CONCURRENTLY i')).toBe('non-transactional');
    expect(c('VACUUM t')).toBe('non-transactional');
  });

  it('summarizes a plan: node types, scans, sort, buffers', () => {
    const json = [
      {
        Plan: {
          'Node Type': 'Limit',
          'Actual Rows': 5,
          'Shared Hit Blocks': 7,
          'Shared Read Blocks': 2,
          'Shared I/O Read Time': 0.4,
          Plans: [
            { 'Node Type': 'Sort', Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 't' }] },
            { 'Node Type': 'Index Scan', 'Relation Name': 'u', 'Index Name': 'u_idx' },
          ],
        },
        'Planning Time': 0.1,
        'Execution Time': 1.5,
      },
    ];
    const s = summarizePlan(json);
    expect(s).toMatchObject({
      executionMs: 1.5,
      planningMs: 0.1,
      rows: 5,
      usesSeqScan: true,
      usesIndexScan: true,
      usesSort: true,
    });
    expect(s.buffers).toMatchObject({ sharedHit: 7, sharedRead: 2, ioReadMs: 0.4 });
    expect(s.scans).toEqual([
      { nodeType: 'Seq Scan', relation: 't', index: null },
      { nodeType: 'Index Scan', relation: 'u', index: 'u_idx' },
    ]);
    // the PostgreSQL 16 spelling of the I/O time key
    const pg16 = summarizePlan([
      {
        Plan: { 'Node Type': 'Seq Scan', 'I/O Read Time': 1.25 },
        'Execution Time': 1,
        'Planning Time': 0,
      },
    ]);
    expect(pg16.buffers.ioReadMs).toBe(1.25);
    expect(() => summarizePlan({ nope: 1 })).toThrow();
  });

  it('options are strict: an unknown key (for example a way around the shadow check) is rejected', () => {
    expect(
      MeasureQueryOptionsSchema.safeParse({ sql: 'SELECT 1', skipShadowCheck: true }).success,
    ).toBe(false);
    expect(
      MeasureQueryOptionsSchema.safeParse({ sql: 'SELECT 1', allowNonShadow: true }).success,
    ).toBe(false);
    expect(
      MeasureDdlOptionsSchema.safeParse({
        sql: 'ALTER TABLE t ADD COLUMN a int',
        table: 't',
        force: true,
      }).success,
    ).toBe(false);
    expect(
      MeasureQueryOptionsSchema.safeParse({
        sql: 'SELECT 1',
        cache: { mode: 'warm', skipShadowCheck: true },
      }).success,
    ).toBe(false);
  });

  it('the override is not reachable from the public API', () => {
    const names = Object.keys(publicApi);
    expect(names.filter((n) => /unsafe|skipShadow|override|nonshadow/i.test(n))).toEqual([]);
    expect(names).toEqual(
      expect.arrayContaining(['measureQuery', 'measureDdl', 'summarizeQuery', 'summarizeDdl']),
    );
    expect(measureQuery.length).toBe(2); // (target, options): there is no third, internal, parameter
  });
});

describe('1. fast and slow queries differ clearly and repeatably', () => {
  it('the usage-read query before the E1 fix (ORDER BY alias) is much slower than after it', async () => {
    const run = (sql: string) =>
      measureQuery(shadow, { sql, params: [tenant], warmupRuns: 5, measuredRuns: 30 });
    const slow1 = await run(ALIAS_SQL);
    const fast1 = await run(FIXED_SQL);
    const slow2 = await run(ALIAS_SQL);
    const fast2 = await run(FIXED_SQL);
    for (const m of [slow1, fast1, slow2, fast2]) expect(m.status).toBe('ok');
    if (
      slow1.status !== 'ok' ||
      fast1.status !== 'ok' ||
      slow2.status !== 'ok' ||
      fast2.status !== 'ok'
    )
      return;
    // both return the same 51 rows
    expect(slow1.rows).toBe(51);
    expect(fast1.rows).toBe(51);
    // clearly different, by wall clock and by server time, in both repetitions
    for (const [s, f] of [
      [slow1, fast1],
      [slow2, fast2],
    ] as const) {
      expect(s.wallMs.p50 / f.wallMs.p50).toBeGreaterThan(4);
      expect(s.serverExecMs.p50 / f.serverExecMs.p50).toBeGreaterThan(8);
      expect(s.wallMs.p95).toBeGreaterThan(f.wallMs.p95);
    }
    // repeatable: the same query gives about the same answer twice (within 50% on the median)
    expect(
      Math.abs(slow1.serverExecMs.p50 - slow2.serverExecMs.p50) / slow1.serverExecMs.p50,
    ).toBeLessThan(0.5);
    expect(
      Math.abs(fast1.serverExecMs.p50 - fast2.serverExecMs.p50) / fast1.serverExecMs.p50,
    ).toBeLessThan(0.5);
    // different work too: the slow one reads and sorts everything, the fast one reads about 51 rows
    expect(slow1.plans.median.summary.usesSort).toBe(true);
    expect(slow1.buffers.sharedHit).toBeGreaterThan(fast1.buffers.sharedHit * 5);
    // typed, versioned, valid
    expect(QueryMeasurementSchema.parse(slow1)).toEqual(slow1);
    expect(slow1.version).toBe(1);
    expect(slow1.shadow).toMatchObject({ manifestId: shadow.runId, sampled: false, mode: 'full' });
    expect(slow1.config).toMatchObject({ warmupRuns: 5, measuredRuns: 30 });
    expect(slow1.perRun).toHaveLength(30);
    expect(slow1.cache.claim).toBe('warm-after-warmup');
    results.fastVsSlow = {
      slow: [slow1, slow2].map((m) => ({
        wallP50: m.wallMs.p50,
        wallP95: m.wallMs.p95,
        serverP50: m.serverExecMs.p50,
        bufferHit: m.buffers.sharedHit,
        plan: m.plans.median.summary.nodeTypes,
      })),
      fast: [fast1, fast2].map((m) => ({
        wallP50: m.wallMs.p50,
        wallP95: m.wallMs.p95,
        serverP50: m.serverExecMs.p50,
        bufferHit: m.buffers.sharedHit,
        plan: m.plans.median.summary.nodeTypes,
      })),
      ratioWallP50: [slow1.wallMs.p50 / fast1.wallMs.p50, slow2.wallMs.p50 / fast2.wallMs.p50],
      ratioServerP50: [
        slow1.serverExecMs.p50 / fast1.serverExecMs.p50,
        slow2.serverExecMs.p50 / fast2.serverExecMs.p50,
      ],
    };
    results.sampleQueryMeasurement = fast1;
    results.sampleQuerySummary = summarizeQuery(fast1);
  });
});

describe('2. the plan JSON is captured and parsed', () => {
  it('captures the first and the median plan; detects seq scan versus index scan', async () => {
    const q = 'SELECT * FROM harness_scratch WHERE k = $1 AND id < 5000';
    const seq = await measureQuery(shadow, { sql: q, params: [7], measuredRuns: 5, warmupRuns: 1 });
    expect(seq.status).toBe('ok');
    if (seq.status !== 'ok') return;
    expect(seq.plans.first.summary.usesSeqScan).toBe(true);
    expect(seq.plans.first.summary.usesIndexScan).toBe(false);
    expect(seq.plans.median.summary.scans[0]).toMatchObject({
      nodeType: 'Seq Scan',
      relation: 'harness_scratch',
    });
    expect(Array.isArray(seq.plans.first.json)).toBe(true);
    expect(JSON.stringify(seq.plans.first.json)).toContain('"Node Type":"Seq Scan"');
    expect(seq.plans.median.runIndex).toBeGreaterThanOrEqual(0);
    expect(seq.buffers.sharedHit + seq.buffers.sharedRead).toBeGreaterThan(0);
    expect(seq.rows).toBeGreaterThan(0);

    await withClient(shadow.connectionString(), async (c) => {
      await c.query('CREATE INDEX harness_scratch_k_idx ON harness_scratch (k, id)');
      await c.query('ANALYZE harness_scratch');
    });
    const idx = await measureQuery(shadow, { sql: q, params: [7], measuredRuns: 5, warmupRuns: 1 });
    expect(idx.status).toBe('ok');
    if (idx.status !== 'ok') return;
    expect(idx.plans.first.summary.usesIndexScan).toBe(true);
    expect(idx.plans.first.summary.usesSeqScan).toBe(false);
    expect(idx.plans.median.summary.scans.some((s) => s.index === 'harness_scratch_k_idx')).toBe(
      true,
    );
    expect(idx.rows).toBe(seq.rows);
    results.seqVersusIndex = {
      before: { scans: seq.plans.median.summary.scans, serverP50: seq.serverExecMs.p50 },
      after: { scans: idx.plans.median.summary.scans, serverP50: idx.serverExecMs.p50 },
    };
    await withClient(shadow.connectionString(), (c) => c.query('DROP INDEX harness_scratch_k_idx'));
  });
});

describe('3. writes leave no trace', () => {
  it('INSERT, UPDATE and DELETE are measured inside a rolled-back transaction: the data is unchanged', async () => {
    const before = await withClient(shadow.connectionString(), async (c) => ({
      scratch: await tableFingerprint(c, 'harness_scratch'),
      tenants: await tableFingerprint(c, 'tenants'),
      balances: await tableFingerprint(c, 'credit_balances'),
    }));
    const outcomes: Record<string, unknown> = {};
    for (const [name, sql, params] of [
      [
        'insert',
        "INSERT INTO harness_scratch SELECT g + 1000000, g % 1000, 'x' FROM generate_series(1, 5000) g",
        [],
      ],
      ['update', 'UPDATE harness_scratch SET k = k + 1 WHERE id < 20000', []],
      ['delete', 'DELETE FROM harness_scratch WHERE id % 2 = 0', []],
      [
        'update-with-rls-table',
        'UPDATE credit_balances SET balance = balance + 1 WHERE tenant_id = $1',
        [tenant],
      ],
      ['update-tenants', "UPDATE tenants SET name = name || 'x'", []],
    ] as const) {
      const m = await measureQuery(shadow, { sql, params, warmupRuns: 1, measuredRuns: 5 });
      expect(m.status, name).toBe('ok');
      if (m.status !== 'ok') continue;
      expect(m.statement.class).toBe('dml');
      expect(m.statement.strategy).toBe('rollback-transaction');
      expect(m.rowsKind).toBe('affected');
      expect(m.rows).toBeGreaterThan(0);
      outcomes[name] = { rowsAffected: m.rows, serverP50: m.serverExecMs.p50 };
    }
    const after = await withClient(shadow.connectionString(), async (c) => ({
      scratch: await tableFingerprint(c, 'harness_scratch'),
      tenants: await tableFingerprint(c, 'tenants'),
      balances: await tableFingerprint(c, 'credit_balances'),
    }));
    expect(after).toEqual(before);
    results.writesLeaveNoTrace = { before, after, measured: outcomes };
  });

  it('DDL (including TRUNCATE and DROP TABLE) measured by measureDdl is rolled back too', async () => {
    const before = await withClient(shadow.connectionString(), (c) =>
      tableFingerprint(c, 'harness_scratch'),
    );
    for (const sql of [
      'TRUNCATE harness_scratch',
      'ALTER TABLE harness_scratch ADD COLUMN z int DEFAULT 1',
      'DROP TABLE harness_scratch',
    ]) {
      const m = await measureDdl(shadow, { sql, table: 'public.harness_scratch', runs: 2 });
      expect(m.status, sql).toBe('ok');
      if (m.status === 'ok') expect(m.verification.rolledBackCleanly).toBe(true);
    }
    const after = await withClient(shadow.connectionString(), (c) =>
      tableFingerprint(c, 'harness_scratch'),
    );
    expect(after).toEqual(before);
  });

  it('a read cannot write: a function that writes fails inside the read-only transaction', async () => {
    const m = await measureQuery(shadow, {
      sql: "SELECT nextval(pg_get_serial_sequence('credit_ledger', 'id'))",
      measuredRuns: 2,
    });
    expect(m.status).toBe('failed');
    if (m.status === 'failed') {
      expect(m.failure.kind).toBe('sql-error');
      expect(m.failure.sqlState).toBe('25006');
    }
  });
});

describe('4. DDL: lock modes, rewrite, sizes (against known PostgreSQL behaviour)', () => {
  type Row = {
    statement: string;
    locks: string[];
    rewritten: boolean;
    indexesRebuilt: boolean;
    durationMs: number;
    tableBytesDelta: number;
    indexBytesDelta: number;
  };
  const table: Row[] = [];
  const ddl = async (sql: string, runs = 2) => {
    const m = await measureDdl(shadow, { sql, table: 'public.harness_ddl', runs });
    expect(m.status, sql).toBe('ok');
    if (m.status !== 'ok') throw new Error('unreachable');
    table.push({
      statement: sql.replace('public.harness_ddl', 'harness_ddl'),
      locks: m.locks.targetTableModes,
      rewritten: m.rewrite.tableRewritten,
      indexesRebuilt: m.rewrite.indexesRebuilt,
      durationMs: m.durationMs.p50,
      tableBytesDelta: m.size.deltaBytes.table,
      indexBytesDelta: m.size.deltaBytes.indexes,
    });
    expect(m.verification.rolledBackCleanly, sql).toBe(true);
    expect(m.rewrite.consistentAcrossRuns).toBe(true);
    expect(m.locks.source).toBe('end-of-statement');
    expect(DdlMeasurementSchema.parse(m)).toEqual(m);
    return m;
  };

  it('CREATE INDEX: SHARE lock (blocks writes, not reads), no rewrite, a new index', async () => {
    const m = await ddl('CREATE INDEX harness_ddl_c_idx ON public.harness_ddl (c)');
    expect(m.locks.strongestTargetTableMode).toBe('ShareLock');
    expect(m.locks.blocksWrites).toBe(true);
    expect(m.locks.blocksSelects).toBe(false);
    expect(m.rewrite.tableRewritten).toBe(false);
    expect(m.rewrite.indexesCreated).toEqual(['public.harness_ddl_c_idx']);
    expect(m.size.deltaBytes.indexes).toBeGreaterThan(0);
    expect(m.size.deltaBytes.table).toBe(0);
    results.sampleDdlMeasurement = m;
    results.sampleDdlSummary = summarizeDdl(m);
  });

  it('ADD COLUMN with a constant default: ACCESS EXCLUSIVE but no rewrite (PostgreSQL 11 and later)', async () => {
    const m = await ddl('ALTER TABLE public.harness_ddl ADD COLUMN e1 int DEFAULT 5');
    expect(m.locks.strongestTargetTableMode).toBe('AccessExclusiveLock');
    expect(m.locks.blocksSelects).toBe(true);
    expect(m.rewrite.tableRewritten).toBe(false);
    expect(m.size.deltaBytes.table).toBe(0);
  });

  it('ADD COLUMN with a STABLE default (now()): no rewrite either (evaluated once)', async () => {
    const m = await ddl('ALTER TABLE public.harness_ddl ADD COLUMN e2 timestamptz DEFAULT now()');
    expect(m.rewrite.tableRewritten).toBe(false);
  });

  it('ADD COLUMN NOT NULL with a VOLATILE default (random()): full table rewrite', async () => {
    const m = await ddl(
      'ALTER TABLE public.harness_ddl ADD COLUMN e3 double precision NOT NULL DEFAULT random()',
    );
    expect(m.locks.strongestTargetTableMode).toBe('AccessExclusiveLock');
    expect(m.rewrite.tableRewritten).toBe(true);
    expect(m.rewrite.relfilenodeAfter).not.toBe(m.rewrite.relfilenodeBefore);
    expect(m.rewrite.indexesRebuilt).toBe(true); // a rewrite rebuilds the indexes
    expect(m.size.deltaBytes.table).toBeGreaterThan(0);
  });

  it('ADD COLUMN with a volatile default that allows NULL (gen_random_uuid()): also a rewrite', async () => {
    const m = await ddl(
      'ALTER TABLE public.harness_ddl ADD COLUMN e4 uuid DEFAULT gen_random_uuid()',
    );
    expect(m.rewrite.tableRewritten).toBe(true);
  });

  it('ALTER COLUMN TYPE int to bigint: rewrite, indexes rebuilt, ACCESS EXCLUSIVE', async () => {
    const m = await ddl('ALTER TABLE public.harness_ddl ALTER COLUMN a TYPE bigint');
    expect(m.locks.strongestTargetTableMode).toBe('AccessExclusiveLock');
    expect(m.rewrite.tableRewritten).toBe(true);
    expect(m.rewrite.indexesRebuilt).toBe(true);
  });

  it('ALTER COLUMN TYPE varchar(20) to varchar(40) (widening): no rewrite', async () => {
    const m = await ddl('ALTER TABLE public.harness_ddl ALTER COLUMN c TYPE varchar(40)');
    expect(m.locks.strongestTargetTableMode).toBe('AccessExclusiveLock');
    expect(m.rewrite.tableRewritten).toBe(false);
  });

  it('SET NOT NULL: ACCESS EXCLUSIVE, scans the table but does not rewrite it', async () => {
    const m = await ddl('ALTER TABLE public.harness_ddl ALTER COLUMN b SET NOT NULL');
    expect(m.locks.strongestTargetTableMode).toBe('AccessExclusiveLock');
    expect(m.rewrite.tableRewritten).toBe(false);
  });

  it('ADD CHECK ... NOT VALID: ACCESS EXCLUSIVE, no rewrite', async () => {
    const m = await ddl(
      'ALTER TABLE public.harness_ddl ADD CONSTRAINT harness_chk CHECK (a >= 0) NOT VALID',
    );
    expect(m.locks.strongestTargetTableMode).toBe('AccessExclusiveLock');
    expect(m.rewrite.tableRewritten).toBe(false);
  });

  it('CREATE INDEX CONCURRENTLY cannot be rolled back: refused without a fresh shadow, measured with one', async () => {
    const sql = 'CREATE INDEX CONCURRENTLY harness_ddl_d_idx ON public.harness_ddl (d)';
    const refused = await measureDdl(shadow, { sql, table: 'public.harness_ddl' });
    expect(refused.status).toBe('failed');
    if (refused.status === 'failed') expect(refused.failure.kind).toBe('needs-fresh-shadow');

    const created: ShadowHandle[] = [];
    const m = await measureDdl(
      shadow,
      { sql, table: 'public.harness_ddl', runs: 2, samplingIntervalMs: 0 },
      {
        freshShadow: async () => {
          const s = await createShadow({ sourceUrl: readerUrlFor(DEMO_DB), mode: 'full' });
          created.push(s);
          try {
            await withClient(s.connectionString(), async (c) => {
              await c.query(
                `CREATE TABLE harness_ddl AS SELECT g AS id, g % 5000 AS a, md5(g::text) AS b, 'v' AS c, repeat('x', 200) AS d FROM generate_series(1, 300000) g`,
              );
            });
          } catch (e) {
            await s.destroy(); // never leak a shadow when the setup fails
            throw e;
          }
          return { target: s, dispose: () => s.destroy() };
        },
      },
    );
    expect(m.status === 'failed' ? JSON.stringify(m.failure) : 'ok').toBe('ok');
    if (m.status !== 'ok') return;
    expect(m.statement.strategy).toBe('fresh-shadow-per-run');
    expect(m.locks.source).toBe('sampled');
    expect(m.locks.targetTableModes).toContain('ShareUpdateExclusiveLock');
    expect(m.locks.targetTableModes).not.toContain('AccessExclusiveLock');
    expect(m.locks.blocksSelects).toBe(false);
    expect(m.locks.blocksWrites).toBe(false);
    expect(m.rewrite.tableRewritten).toBe(false);
    expect(m.rewrite.indexesCreated).toEqual(['public.harness_ddl_d_idx']);
    expect(m.verification.rolledBackCleanly).toBeNull();
    expect(created).toHaveLength(2);
    // every fresh shadow was destroyed
    for (const s of created)
      expect(
        (await docker(['ps', '-a', '-q', '--filter', `name=${s.containerName}`])).stdout.trim(),
      ).toBe('');
    table.push({
      statement:
        'CREATE INDEX CONCURRENTLY harness_ddl_d_idx ON harness_ddl (d)  [fresh shadow per run, locks sampled]',
      locks: m.locks.targetTableModes,
      rewritten: m.rewrite.tableRewritten,
      indexesRebuilt: m.rewrite.indexesRebuilt,
      durationMs: m.durationMs.p50,
      tableBytesDelta: m.size.deltaBytes.table,
      indexBytesDelta: m.size.deltaBytes.indexes,
    });
  }, 300_000);

  it('records the table of observed behaviour', () => {
    results.ddlBehaviour = table;
    expect(table.length).toBeGreaterThanOrEqual(9);
  });
});

describe('lock wait time can be measured when another session holds a conflicting lock', () => {
  it('a transaction holding ACCESS SHARE for 800 ms makes ADD COLUMN wait about that long', async () => {
    const m = await measureDdl(shadow, {
      sql: 'ALTER TABLE public.harness_ddl ADD COLUMN w1 int',
      table: 'public.harness_ddl',
      runs: 3,
      blockingTransaction: {
        sql: 'LOCK TABLE public.harness_ddl IN ACCESS SHARE MODE',
        holdMs: 800,
      },
    });
    expect(m.status).toBe('ok');
    if (m.status !== 'ok') return;
    // The DDL waited for the blocker: about 800 ms (sampled: the error is about one sampling interval)
    expect(m.lockWaitMs.p50).toBeGreaterThan(600);
    expect(m.lockWaitMs.p50).toBeLessThan(1000);
    expect(m.durationMs.p50).toBeGreaterThan(750);
    expect(m.durationMs.p50 - m.lockWaitMs.p50).toBeLessThan(200); // the rest is the statement itself
    expect(m.config.blockingTransaction).toBe(true);
    // and without the blocker it does not wait
    const free = await measureDdl(shadow, {
      sql: 'ALTER TABLE public.harness_ddl ADD COLUMN w1 int',
      table: 'public.harness_ddl',
      runs: 3,
    });
    expect(free.status).toBe('ok');
    if (free.status !== 'ok') return;
    expect(free.lockWaitMs.p50).toBeLessThan(50);
    results.lockWait = {
      blocked: {
        holdMs: 800,
        lockWaitP50: m.lockWaitMs.p50,
        durationP50: m.durationMs.p50,
        samplingIntervalMs: m.config.samplingIntervalMs,
      },
      free: { lockWaitP50: free.lockWaitMs.p50, durationP50: free.durationMs.p50 },
    };
  });
});

describe('5. the harness refuses a database that is not a shadow', () => {
  it('measureQuery and measureDdl return the typed failure and run nothing', async () => {
    const source = { connectionString: () => sourceAdmin };
    const q = await measureQuery(source, { sql: 'SELECT 1' });
    expect(q.status).toBe('failed');
    if (q.status === 'failed') {
      expect(q.failure.kind).toBe('refused-not-shadow');
      expect(q.failure.completedRuns).toBe(0);
      expect(q.failure.phase).toBe('check');
    }
    const d = await measureDdl(source, {
      sql: 'CREATE TABLE should_never_exist (a int)',
      table: 'public.tenants',
    });
    expect(d.status).toBe('failed');
    if (d.status === 'failed') expect(d.failure.kind).toBe('refused-not-shadow');
    const w = await measureQuery(source, { sql: "UPDATE tenants SET name = 'hacked'" });
    expect(w.status).toBe('failed');
    // nothing happened on the source
    await withClient(sourceAdmin, async (c) => {
      expect(
        (await c.query(`SELECT to_regclass('public.should_never_exist') AS t`)).rows[0].t,
      ).toBeNull();
      expect(
        (await c.query(`SELECT count(*)::int AS n FROM tenants WHERE name = 'hacked'`)).rows[0].n,
      ).toBe(0);
    });
    results.refusal = {
      query: q.status === 'failed' ? q.failure : null,
      ddl: d.status === 'failed' ? d.failure : null,
    };
  });

  it('a half-built database (marker table without the database setting) is refused too', async () => {
    await withClient(shadow.connectionString(), (c) => c.query('CREATE DATABASE harness_fake'));
    try {
      const fake = withDb(shadow.connectionString(), 'harness_fake');
      await withClient(fake, async (c) => {
        await c.query('CREATE SCHEMA ledgerworks_meta');
        await c.query('CREATE TABLE ledgerworks_meta.shadow_marker (run_id text, manifest jsonb)');
      });
      const m = await measureQuery({ connectionString: () => fake }, { sql: 'SELECT 1' });
      expect(m.status === 'failed' && m.failure.kind).toBe('refused-not-shadow');
    } finally {
      await withClient(shadow.connectionString(), (c) =>
        c.query('DROP DATABASE harness_fake WITH (FORCE)'),
      );
    }
  });

  it('the test-only override works only inside a test run with its environment flag, and logs loudly', async () => {
    // An unmarked database on the shadow's server (not the demo source): safe to run things in.
    await withClient(shadow.connectionString(), (c) => c.query('CREATE DATABASE harness_plain'));
    try {
      const plain = withDb(shadow.connectionString(), 'harness_plain');
      await withClient(plain, (c) => c.query('CREATE TABLE t (a int)'));
      const target = { connectionString: () => plain };
      delete process.env.LEDGERWORKS_ALLOW_NON_SHADOW_FOR_TESTS;
      expect(() => unsafeMeasureQueryForTests(target, { sql: 'SELECT 1' })).toThrow(
        /only be disabled inside a test run/,
      );
      const refused = await measureQuery(target, { sql: 'SELECT 1' });
      expect(refused.status === 'failed' && refused.failure.kind).toBe('refused-not-shadow');
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      process.env.LEDGERWORKS_ALLOW_NON_SHADOW_FOR_TESTS = '1';
      try {
        const q = await unsafeMeasureQueryForTests(target, {
          sql: 'SELECT 1',
          warmupRuns: 0,
          measuredRuns: 2,
        });
        expect(q.status).toBe('ok');
        const d = await unsafeMeasureDdlForTests(target, {
          sql: 'ALTER TABLE public.t ADD COLUMN b int',
          table: 'public.t',
          runs: 1,
        });
        expect(d.status).toBe('ok');
        // the result is visibly not a shadow result
        for (const m of [q, d])
          expect(m.status === 'ok' && m.shadow.manifestId).toBe('UNVERIFIED-NOT-A-SHADOW');
        expect(
          spy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('SHADOW CHECK DISABLED'))
            .length,
        ).toBe(2);
      } finally {
        delete process.env.LEDGERWORKS_ALLOW_NON_SHADOW_FOR_TESTS;
        spy.mockRestore();
      }
    } finally {
      await withClient(shadow.connectionString(), (c) =>
        c.query('DROP DATABASE harness_plain WITH (FORCE)'),
      );
    }
  });
});

describe('6. timeouts and limits give typed failures and never hang', () => {
  it('a statement over its timeout fails with statement-timeout, promptly', async () => {
    const t0 = Date.now();
    const m = await measureQuery(shadow, {
      sql: 'SELECT pg_sleep(10)',
      statementTimeoutMs: 300,
      warmupRuns: 0,
      measuredRuns: 3,
    });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(m.status).toBe('failed');
    if (m.status === 'failed') {
      expect(m.failure).toMatchObject({
        kind: 'statement-timeout',
        sqlState: '57014',
        phase: 'measured',
        completedRuns: 0,
      });
      results.timeout = m.failure;
    }
  });

  it('a warmup that times out is reported as such', async () => {
    const m = await measureQuery(shadow, {
      sql: 'SELECT pg_sleep(10)',
      statementTimeoutMs: 200,
      warmupRuns: 2,
      measuredRuns: 3,
    });
    expect(m.status === 'failed' && m.failure.phase).toBe('warmup');
  });

  it('the maximum total runtime stops a long measurement and reports the runs completed', async () => {
    const t0 = Date.now();
    const m = await measureQuery(shadow, {
      sql: 'SELECT pg_sleep(0.05)',
      warmupRuns: 0,
      measuredRuns: 1000,
      maxTotalRuntimeMs: 1500,
    });
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(m.status).toBe('failed');
    if (m.status === 'failed') {
      expect(m.failure.kind).toBe('max-runtime-exceeded');
      expect(m.failure.completedRuns).toBeGreaterThan(3);
      expect(m.failure.completedRuns).toBeLessThan(1000);
      results.maxRuntime = m.failure;
    }
  });

  it('the total budget also bounds a single statement', async () => {
    const m = await measureQuery(shadow, {
      sql: 'SELECT pg_sleep(10)',
      warmupRuns: 0,
      measuredRuns: 1,
      statementTimeoutMs: 60_000,
      maxTotalRuntimeMs: 700,
    });
    expect(m.status === 'failed' && m.failure.kind).toBe('max-runtime-exceeded');
  });

  it('a DDL statement that waits for a lock longer than lock_timeout fails with lock-timeout', async () => {
    const m = await measureDdl(shadow, {
      sql: 'ALTER TABLE public.harness_ddl ADD COLUMN lt int',
      table: 'public.harness_ddl',
      runs: 1,
      lockTimeoutMs: 300,
      blockingTransaction: {
        sql: 'LOCK TABLE public.harness_ddl IN ACCESS EXCLUSIVE MODE',
        holdMs: 3000,
      },
    });
    expect(m.status).toBe('failed');
    if (m.status === 'failed')
      expect(m.failure).toMatchObject({ kind: 'lock-timeout', sqlState: '55P03' });
  });

  it('invalid input is a typed failure, not an exception', async () => {
    for (const opts of [
      {},
      { sql: '' },
      { sql: 'SELECT 1; SELECT 2' },
      { sql: 'ALTER TABLE t ADD COLUMN a int' },
      { sql: 'SELECT 1', measuredRuns: 0 },
    ]) {
      const m = await measureQuery(shadow, opts);
      expect(m.status === 'failed' && m.failure.kind, JSON.stringify(opts)).toBe('invalid-input');
    }
    const d = await measureDdl(shadow, {
      sql: 'ALTER TABLE public.no_such_table ADD COLUMN a int',
      table: 'public.no_such_table',
    });
    expect(d.status === 'failed' && d.failure.kind).toBe('invalid-input');
    const r = await measureDdl(shadow, { sql: 'SELECT 1', table: 'public.tenants' });
    expect(r.status === 'failed' && r.failure.kind).toBe('invalid-input');
  });

  it('a SQL error is a typed failure with the SQLSTATE', async () => {
    const m = await measureQuery(shadow, { sql: 'SELECT * FROM table_that_does_not_exist' });
    expect(m.status === 'failed' && m.failure).toMatchObject({
      kind: 'sql-error',
      sqlState: '42P01',
    });
  });

  it('a server that stops answering cannot hang the harness (client-side watchdog)', async () => {
    const t0 = Date.now();
    const pending = measureQuery(shadow, {
      sql: 'SELECT pg_sleep(30)',
      statementTimeoutMs: 1000,
      warmupRuns: 0,
      measuredRuns: 1,
    });
    await new Promise((r) => setTimeout(r, 600));
    await docker(['pause', shadow.containerName]);
    let m;
    try {
      m = await pending;
    } finally {
      await docker(['unpause', shadow.containerName]);
    }
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(m.status).toBe('failed');
    if (m.status === 'failed') {
      expect(m.failure.kind).toBe('client-watchdog');
      results.watchdog = m.failure;
    }
    // the shadow works again afterwards
    const ok = await measureQuery(shadow, { sql: 'SELECT 1', warmupRuns: 0, measuredRuns: 2 });
    expect(ok.status).toBe('ok');
  });
});

describe('cold-ish measurements say exactly what was done to the caches', () => {
  it('restarting Postgres empties shared_buffers (warm vs cold-ish), without claiming a cold cache', async () => {
    const sql = 'SELECT count(*), sum(quantity) FROM usage_events';
    const warm = await measureQuery(shadow, { sql, warmupRuns: 3, measuredRuns: 5 });
    const cold = await measureQuery(shadow, {
      sql,
      measuredRuns: 3,
      cache: { mode: 'cold-ish', dropOsCache: false },
    });
    expect(warm.status).toBe('ok');
    expect(cold.status).toBe('ok');
    if (warm.status !== 'ok' || cold.status !== 'ok') return;
    expect(cold.cache).toMatchObject({
      mode: 'cold-ish',
      restartedPostgres: true,
      droppedOsCache: false,
      claim: 'shared-buffers-emptied-os-cache-warm',
    });
    expect(cold.cache.notes).toMatch(/NOT a cold-cache measurement/);
    expect(cold.config.warmupRuns).toBe(0);
    // after a restart the blocks have to be read into shared_buffers again
    expect(cold.perRun.every((r) => r.sharedRead > 0)).toBe(true);
    expect(warm.perRun.every((r) => r.sharedRead === 0)).toBe(true);
    results.coldish = {
      claim: cold.cache.claim,
      warm: {
        serverP50: warm.serverExecMs.p50,
        sharedHit: warm.buffers.sharedHit,
        sharedRead: warm.buffers.sharedRead,
      },
      coldish: {
        serverP50: cold.serverExecMs.p50,
        sharedHit: cold.buffers.sharedHit,
        sharedRead: cold.buffers.sharedRead,
        ioReadMs: cold.buffers.ioReadMs,
      },
    };
  });

  it('with dropOsCache it also drops the VM page cache, and says so only if that worked', async () => {
    const cold = await measureQuery(shadow, {
      sql: 'SELECT count(*) FROM usage_events',
      measuredRuns: 2,
      cache: { mode: 'cold-ish', dropOsCache: true },
    });
    expect(cold.status).toBe('ok');
    if (cold.status !== 'ok') return;
    if (cold.cache.droppedOsCache) {
      expect(cold.cache.claim).toBe('shared-buffers-emptied-vm-page-cache-dropped');
      expect(cold.cache.notes).toMatch(/not a guaranteed cold disk read/);
    } else {
      expect(cold.cache.claim).toBe('shared-buffers-emptied-os-cache-warm');
      expect(cold.cache.notes).toMatch(/failed/);
    }
    results.coldishDropOsCache = {
      claim: cold.cache.claim,
      droppedOsCache: cold.cache.droppedOsCache,
      ioReadMs: cold.buffers.ioReadMs,
      sharedRead: cold.buffers.sharedRead,
      serverP50: cold.serverExecMs.p50,
    };
  });

  it('a cold-ish run without a container name is invalid input', async () => {
    const m = await measureQuery(
      { connectionString: () => shadow.connectionString() },
      { sql: 'SELECT 1', measuredRuns: 1, cache: { mode: 'cold-ish' } },
    );
    expect(m.status === 'failed' && m.failure.kind).toBe('invalid-input');
  });
});

describe('background work is reported, and a shadow can be settled', () => {
  it('settleShadow vacuums, analyzes and checkpoints a shadow, and refuses anything else', async () => {
    const r = await settleShadow(shadow);
    expect(r.vacuumAnalyzeMs).toBeGreaterThan(0);
    expect(r.checkpointMs).toBeGreaterThanOrEqual(0);
    await expect(settleShadow({ connectionString: () => sourceAdmin })).rejects.toBeInstanceOf(
      NotShadowError,
    );
    results.settle = r;
  });

  it('a measurement says whether anything else was working in the database', async () => {
    await settleShadow(shadow);
    const quiet = await measureQuery(shadow, {
      sql: 'SELECT count(*) FROM tenants',
      warmupRuns: 1,
      measuredRuns: 5,
    });
    expect(quiet.status).toBe('ok');
    if (quiet.status !== 'ok') return;
    expect(quiet.environment.background).toMatchObject({
      autovacuumWorkersAtStart: 0,
      autovacuumRunsDuring: 0,
      checkpointsDuring: 0,
      quiet: true,
    });
    expect(summarizeQuery(quiet)).not.toMatch(/NOT QUIET/);

    // a checkpoint that happens during the measurement is seen
    const pending = measureQuery(shadow, {
      sql: 'SELECT pg_sleep(0.02)',
      warmupRuns: 0,
      measuredRuns: 30,
    });
    await new Promise((r) => setTimeout(r, 150));
    await withClient(shadow.connectionString(), (c) => c.query('CHECKPOINT'));
    const noisy = await pending;
    expect(noisy.status).toBe('ok');
    if (noisy.status !== 'ok') return;
    expect(noisy.environment.background.checkpointsDuring).toBeGreaterThanOrEqual(1);
    expect(noisy.environment.background.quiet).toBe(false);
    expect(summarizeQuery(noisy)).toMatch(/NOT QUIET/);
    expect(QueryMeasurementSchema.parse(noisy)).toEqual(noisy);
    results.background = {
      quiet: quiet.environment.background,
      withCheckpoint: noisy.environment.background,
    };
  });
});

describe('7. the variance experiment saves raw files', () => {
  it('runs repetitions of a case and writes one raw file per case (never overwriting)', async () => {
    const outDir = path.resolve(import.meta.dirname, '../../../test-results/variance-smoke');
    await mkdir(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:.]/g, '');
    const report = await runVarianceExperiment({
      target: shadow,
      repetitions: 3,
      outDir,
      stamp,
      context: {
        note: 'smoke test of the experiment code on the small demo shadow, not the published experiment',
        manifestId: shadow.runId,
      },
      cases: [
        {
          name: 'smoke-fixed',
          description: 'fixed usage-read',
          kind: 'query',
          options: { sql: FIXED_SQL, params: [tenant], warmupRuns: 2, measuredRuns: 5 },
        },
        {
          name: 'smoke-ddl',
          description: 'add column',
          kind: 'ddl',
          options: {
            sql: 'ALTER TABLE public.harness_ddl ADD COLUMN v1 int DEFAULT 1',
            table: 'public.harness_ddl',
            runs: 2,
          },
        },
      ],
    });
    expect(report.cases).toHaveLength(2);
    expect(report.cases.every((c) => c.failures === 0 && c.p50WallMs.length === 3)).toBe(true);
    expect(report.markdown).toContain('smoke-fixed');
    const files = (await readdir(outDir)).filter((f) => f.includes(stamp));
    expect(files.sort()).toEqual([
      `c2.2-variance-smoke-ddl-${stamp}.json`,
      `c2.2-variance-smoke-fixed-${stamp}.json`,
    ]);
    const raw = JSON.parse(await readFile(path.join(outDir, files[1]!), 'utf8'));
    expect(raw.repetitions).toHaveLength(3);
    for (const r of raw.repetitions) expect(QueryMeasurementSchema.parse(r).status).toBe('ok');
    // writing the same file again must fail: raw output is never overwritten
    await expect(
      runVarianceExperiment({
        target: shadow,
        repetitions: 1,
        outDir,
        stamp,
        context: {},
        cases: [
          {
            name: 'smoke-fixed',
            description: '',
            kind: 'query',
            options: { sql: 'SELECT 1', warmupRuns: 0, measuredRuns: 1 },
          },
        ],
      }),
    ).rejects.toThrow(/EEXIST/);
    results.varianceSmoke = report.cases.map((c) => ({
      name: c.name,
      p50WallMs: c.p50WallMs,
      cvAcross: c.acrossWall.cvPercent,
    }));
  });
});

// keep an explicit reference so a rename of the test source database is caught at compile time
void ADMIN_URL;
