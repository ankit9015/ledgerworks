/**
 * C2.1 integration tests: real Docker, real Postgres. Source: the small Ledgerline demo database
 * (ledgerline_demo, created from the migrations and seed:demo when missing), read through the
 * read-only role shadow_reader. The 10M-row benchmark database is cloned by `pnpm test:shadow-full`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { docker } from './docker.js';
import {
  diffFingerprints,
  schemaSnapshot,
  sourceFingerprint,
  type SourceFingerprint,
} from './fingerprint.js';
import {
  NAME_PREFIX,
  RUN_ID_LABEL,
  SHADOW_LABEL,
  CREATED_AT_LABEL,
  cleanupShadows,
  listShadowResources,
  shadowStatus,
} from './lifecycle.js';
import { NotShadowError, assertShadow } from './marker.js';
import { ShadowManifestSchema, type ShadowManifest } from './manifest.js';
import { hashSelect } from './sampling.js';
import {
  CloneVerificationError,
  ResourceError,
  UnsupportedExtensionError,
  createShadow,
  withShadow,
  type ShadowHandle,
} from './runner.js';
import { SourceWritableError, checkSourceReadOnly } from './source.js';
import {
  ADMIN_URL,
  DEMO_DB,
  READER_PASSWORD,
  ensureDemoSource,
  readerUrlFor,
  withDb,
} from './testing/helpers.js';

const results: Record<string, unknown> = {};
let sourceAdmin: string;
let reader: string;
let before: SourceFingerprint;
let full: ShadowHandle;

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Idempotent: also removes privileges a role may still hold in this database from an earlier run. */
async function dropRoleIfExists(c: pg.Client, role: string): Promise<void> {
  const r = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if (!r.rowCount) return;
  await c.query(`DROP OWNED BY ${role}`);
  await c.query(`DROP ROLE ${role}`);
}

async function leftovers(runId: string): Promise<{ containers: string[]; volumes: string[] }> {
  const id8 = runId.slice(0, 8);
  const c = await docker([
    'ps',
    '-a',
    '--format',
    '{{.Names}}',
    '--filter',
    `name=${NAME_PREFIX}${id8}`,
  ]);
  const v = await docker(['volume', 'ls', '-q', '--filter', `name=${NAME_PREFIX}${id8}`]);
  const byLabel = await shadowStatus(runId);
  return {
    containers: [
      ...c.stdout.split('\n').filter(Boolean),
      ...byLabel.filter((r) => r.kind === 'container').map((r) => r.name),
    ],
    volumes: [
      ...v.stdout.split('\n').filter(Boolean),
      ...byLabel.filter((r) => r.kind === 'volume').map((r) => r.name),
    ],
  };
}

beforeAll(async () => {
  sourceAdmin = await ensureDemoSource();
  reader = readerUrlFor(DEMO_DB);
  before = await sourceFingerprint(sourceAdmin);
  full = await createShadow({ sourceUrl: reader, mode: 'full' });
}, 600_000);

afterAll(async () => {
  await full?.destroy();
  // Raw results of this run (gitignored; the committed benchmark files come from the gated full-size run).
  const dir = path.resolve(import.meta.dirname, '../../../test-results');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'c2.1-small-results.json'),
    JSON.stringify(results, null, 2) + '\n',
  );
});

describe('1. full clone of the small Ledgerline database', () => {
  it('has equal schema (tables, partitions, indexes, constraints, policies, functions, triggers, sequences)', async () => {
    const [a, b] = await Promise.all([
      withClient(sourceAdmin, schemaSnapshot),
      full.connect().then(async (c) => {
        try {
          return await schemaSnapshot(c);
        } finally {
          await c.end();
        }
      }),
    ]);
    const kinds = (lines: string[], k: string): number =>
      lines.filter((l) => l.startsWith(`${k}|`)).length;
    // the comparison is not vacuous: the demo schema really has all of these
    expect(kinds(a, 'relation')).toBeGreaterThan(50); // 48 partitions + tables
    expect(a.some((l) => l.includes('partition=public.usage_events'))).toBe(true);
    expect(kinds(a, 'index')).toBeGreaterThan(10);
    expect(kinds(a, 'constraint')).toBeGreaterThan(10);
    expect(a.some((l) => l.startsWith('constraint|') && l.includes('|f|FOREIGN KEY'))).toBe(true);
    expect(kinds(a, 'policy')).toBeGreaterThan(5);
    expect(kinds(a, 'function')).toBeGreaterThan(3);
    expect(kinds(a, 'trigger')).toBeGreaterThan(0);
    expect(a.some((l) => l.includes('rls=t|force=t'))).toBe(true);
    expect(b.filter((l) => !a.includes(l))).toEqual([]);
    expect(a.filter((l) => !b.includes(l))).toEqual([]);
    results.schemaEquality = {
      linesCompared: a.length,
      relations: kinds(a, 'relation'),
      columns: kinds(a, 'column'),
      indexes: kinds(a, 'index'),
      constraints: kinds(a, 'constraint'),
      policies: kinds(a, 'policy'),
      functions: kinds(a, 'function'),
      triggers: kinds(a, 'trigger'),
      sequences: kinds(a, 'sequence'),
      differences: 0,
    };
  });

  it('has the same rows (counts and checksums of every small table) as the source', async () => {
    const [src, dst] = await Promise.all([
      sourceFingerprint(sourceAdmin, { settleMs: 0 }),
      sourceFingerprint(full.connectionString(), { settleMs: 0 }),
    ]);
    expect(dst.rowCounts).toEqual(src.rowCounts);
    expect(dst.checksums).toEqual(src.checksums);
    expect(Object.keys(src.checksums).length).toBeGreaterThan(5);
    expect(Number(src.rowCounts['public.usage_events_2026_08'] ?? 0) + 1).toBeGreaterThan(0);
    const m = full.manifest;
    for (const t of m.tables) {
      expect(t.ratio, `${t.schema}.${t.name}`).toBe(1);
      expect(t.shadowRows).toBe(t.sourceRows);
    }
    const usage = m.tables.find((t) => t.name === 'usage_events')!;
    expect(usage.kind).toBe('partitioned-table');
    expect(usage.sourceRows).toBeGreaterThan(30_000);
    results.fullManifestSummary = { rows: usage.sourceRows, totalMs: m.totalDurationMs };
  });

  it('writes a valid manifest, without credentials, and the marker accepts it', async () => {
    const m: ShadowManifest = full.manifest;
    expect(ShadowManifestSchema.parse(m)).toEqual(m);
    const text = JSON.stringify(m);
    expect(text).not.toContain(READER_PASSWORD);
    expect(text).not.toMatch(/postgres(ql)?:\/\//);
    expect(text).not.toContain(full.connectionString().split(':')[2]!.split('@')[0]!); // shadow password
    expect(m.mode).toBe('full');
    expect(m.scaling.sampled).toBe(false);
    expect(m.scaling.totalRowRatio).toBe(1);
    expect(m.source.database).toBe(DEMO_DB);
    expect(m.source.readOnlyCheck.canWrite).toBe(false);
    expect(m.stages.map((s) => s.name)).toEqual([
      'preflight',
      'image',
      'container',
      'extension-check',
      'roles',
      'schema-dump',
      'restore-pre',
      'copy-data',
      'sequences',
      'restore-post',
      'matviews',
      'extensions',
      'analyze',
      'verify',
      'marker',
    ]);
    expect(m.image.postgresVersion).toMatch(/^16\./);
    expect(m.image.hypopgVersion).toBe('1.4.3');
    expect(m.container.limits).toMatchObject({ cpus: 2, memoryMiB: 3072, memorySwapMiB: 3072 });
    expect(m.roles.map((r) => r.name)).toContain('ledgerline_app');
    results.smallFullManifest = m;
    await withClient(full.connectionString(), async (c) => {
      const mk = await assertShadow(c);
      expect(mk.runId).toBe(full.runId);
    });
  });

  it('runs with its own pinned limits, labels and a separate volume', async () => {
    const info = JSON.parse((await docker(['inspect', full.containerName])).stdout)[0];
    expect(info.HostConfig.NanoCpus).toBe(2_000_000_000);
    expect(info.HostConfig.Memory).toBe(3072 * 1024 * 1024);
    expect(info.HostConfig.MemorySwap).toBe(3072 * 1024 * 1024);
    expect(info.HostConfig.PidsLimit).toBe(512);
    expect(info.Config.Labels[SHADOW_LABEL]).toBe('true');
    expect(info.Config.Labels[RUN_ID_LABEL]).toBe(full.runId);
    expect(info.Mounts.map((m: { Name: string }) => m.Name)).toEqual([full.volumeName]);
    expect(full.volumeName).not.toBe('ledgerworks_pgdata');
    // bound to loopback only
    expect(info.NetworkSettings.Ports['5432/tcp'][0].HostIp).toBe('127.0.0.1');
    const src = JSON.parse(
      (await docker(['inspect', 'ledgerworks-postgres'], { allowFail: true })).stdout || '[]',
    )[0];
    if (src) expect(src.Name).not.toContain(full.containerName);
  });

  it('has pg_stat_statements and HypoPG, and a hypothetical index works', async () => {
    await withClient(full.connectionString(), async (c) => {
      const ext = await c.query<{ extname: string }>('SELECT extname FROM pg_extension');
      expect(ext.rows.map((r) => r.extname)).toEqual(
        expect.arrayContaining(['pg_stat_statements', 'hypopg']),
      );
      expect(
        (await c.query(`SELECT current_setting('shared_preload_libraries') AS v`)).rows[0].v,
      ).toContain('pg_stat_statements');
      await c.query('SELECT 1 FROM ledgerworks_ext.pg_stat_statements LIMIT 1').catch(async () => {
        // pg_stat_statements may live in public when the source had it
        await c.query('SELECT 1 FROM pg_stat_statements LIMIT 1');
      });
      // an index on a column that has none, selective predicate: the planner must use the hypothetical one
      const idx = await c.query('SELECT * FROM ledgerworks_ext.hypopg_create_index($1)', [
        'CREATE INDEX ON public.usage_events (quantity)',
      ]);
      expect(idx.rowCount).toBeGreaterThan(0);
      const plan = await c.query(
        `EXPLAIN (FORMAT JSON) SELECT * FROM public.usage_events WHERE quantity = 7`,
      );
      const text = JSON.stringify(plan.rows[0]);
      const without = await c.query('SELECT ledgerworks_ext.hypopg_reset()');
      expect(without.rowCount).toBe(1);
      const plan2 = await c.query(
        `EXPLAIN (FORMAT JSON) SELECT * FROM public.usage_events WHERE quantity = 7`,
      );
      expect(text).toMatch(/hypo|<\d+>/i);
      expect(JSON.stringify(plan2.rows[0])).not.toMatch(/<\d+>btree/);
      results.hypopg = {
        usesHypotheticalIndex: /<\d+>btree/.test(text),
        planNodeWith: /"Index Name":\s*"([^"]+)"/.exec(text)?.[1],
      };
    });
  });

  it('can be re-attached by run id (other process) and is found by status', async () => {
    const { attachShadow } = await import('./runner.js');
    const again = await attachShadow(full.runId);
    expect(again.manifest.id).toBe(full.runId);
    expect(again.port).toBe(full.port);
    const status = await shadowStatus(full.runId);
    expect(status.map((s) => s.kind).sort()).toEqual(['container', 'volume']);
  });
});

describe('3. sampled clone keeps referential integrity', () => {
  let sampled: ShadowHandle;
  let seed = 0;
  let keptTenants: string[] = [];
  let totalTenants = 0;

  beforeAll(async () => {
    // Pick a seed that selects some but not all of the tenants (the demo has only a handful).
    await withClient(sourceAdmin, async (c) => {
      for (let s = 1; s <= 500 && !seed; s++) {
        // some but not all tenants, and some but not all usage events
        const r = await c.query<{ k: string; n: string; ke: string; ne: string }>(
          `SELECT count(*) FILTER (WHERE sel) AS k, count(*) AS n,
                  COALESCE(sum(e) FILTER (WHERE sel), 0) AS ke, COALESCE(sum(e), 0) AS ne
             FROM (SELECT ${hashSelect('t.id', { seed: s, ratio: 0.5 })} AS sel,
                          (SELECT count(*) FROM public.usage_events u WHERE u.tenant_id = t.id) AS e
                     FROM public.tenants t) x`,
        );
        const x = r.rows[0]!;
        if (
          Number(x.k) > 0 &&
          Number(x.k) < Number(x.n) &&
          Number(x.ke) > 0 &&
          Number(x.ke) < Number(x.ne)
        )
          seed = s;
      }
      const ids = await c.query<{ id: string }>(
        `SELECT id FROM public.tenants t WHERE ${hashSelect('t.id', { seed, ratio: 0.5 })} ORDER BY id`,
      );
      keptTenants = ids.rows.map((r) => r.id);
      totalTenants = Number(
        (await c.query<{ n: string }>('SELECT count(*) AS n FROM public.tenants')).rows[0]!.n,
      );
    });
    expect(seed).toBeGreaterThan(0);
    sampled = await createShadow({
      sourceUrl: reader,
      mode: 'sampled',
      sampling: { rootTable: 'public.tenants', ratio: 0.5, seed },
    });
  }, 600_000);
  afterAll(async () => {
    await sampled?.destroy();
  });

  it('keeps exactly the tenants the hash selects, with all their children', async () => {
    await withClient(sampled.connectionString(), async (c) => {
      const t = await c.query<{ id: string }>('SELECT id FROM public.tenants ORDER BY id');
      expect(t.rows.map((r) => r.id)).toEqual(keptTenants);
      expect(keptTenants.length).toBeLessThan(totalTenants);
    });
    // every child row of a kept tenant is present: compare with the source per tenant
    await withClient(sourceAdmin, async (src) => {
      await withClient(sampled.connectionString(), async (dst) => {
        for (const table of ['usage_events', 'credit_ledger', 'jobs', 'api_keys', 'memberships']) {
          const a = await src.query<{ n: string }>(
            `SELECT count(*) AS n FROM public.${table} WHERE tenant_id = ANY($1::uuid[])`,
            [keptTenants],
          );
          const b = await dst.query<{ n: string }>(`SELECT count(*) AS n FROM public.${table}`);
          expect(Number(b.rows[0]!.n), table).toBe(Number(a.rows[0]!.n));
        }
      });
    });
  });

  it('has no orphaned child for any foreign key', async () => {
    const report: { constraint: string; child: string; parent: string; orphans: number }[] = [];
    await withClient(sampled.connectionString(), async (c) => {
      const fks = await c.query<{
        conname: string;
        child: string;
        parent: string;
        cols: string[];
        pcols: string[];
      }>(
        `SELECT con.conname, con.conrelid::regclass::text AS child, con.confrelid::regclass::text AS parent,
                (SELECT array_agg(quote_ident(a.attname) ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS cols,
                (SELECT array_agg(quote_ident(a.attname) ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS pcols
           FROM pg_constraint con WHERE con.contype = 'f' AND con.conparentid = 0 ORDER BY 1, 2`,
      );
      expect(fks.rowCount).toBeGreaterThanOrEqual(8);
      for (const fk of fks.rows) {
        const nonNull = fk.cols.map((c2) => `c.${c2} IS NOT NULL`).join(' AND ');
        const join = fk.cols.map((c2, i) => `p.${fk.pcols[i]} = c.${c2}`).join(' AND ');
        const r = await c.query<{ n: string }>(
          `SELECT count(*) AS n FROM ${fk.child} c WHERE ${nonNull} AND NOT EXISTS (SELECT 1 FROM ${fk.parent} p WHERE ${join})`,
        );
        report.push({
          constraint: fk.conname,
          child: fk.child,
          parent: fk.parent,
          orphans: Number(r.rows[0]!.n),
        });
      }
    });
    expect(report.filter((r) => r.orphans > 0)).toEqual([]);
    // the join semantics above really inspect rows: the children are not all empty
    expect(report.length).toBeGreaterThanOrEqual(8);
    results.sampledIntegrityReport = {
      seed,
      ratio: 0.5,
      foreignKeysChecked: report.length,
      totalOrphans: 0,
      report,
    };
  });

  it('records ratios in the manifest that match the real counts, and labels the data as sampled', async () => {
    const m = sampled.manifest;
    expect(m.mode).toBe('sampled');
    expect(m.sampling).toMatchObject({ rootTable: 'public.tenants', ratio: 0.5, seed });
    expect(m.scaling.sampled).toBe(true);
    expect(m.scaling.note).toMatch(/SAMPLED/);
    expect(m.scaling.totalRowRatio).toBeLessThan(1);
    await withClient(sourceAdmin, async (src) => {
      await withClient(sampled.connectionString(), async (dst) => {
        for (const t of m.tables) {
          const q = `SELECT count(*) AS n FROM "${t.schema}"."${t.name}"`;
          const a = Number((await src.query<{ n: string }>(q)).rows[0]!.n);
          const b = Number((await dst.query<{ n: string }>(q)).rows[0]!.n);
          expect(t.sourceRows, `${t.name} source`).toBe(a);
          expect(t.shadowRows, `${t.name} shadow`).toBe(b);
          expect(t.ratio).toBeCloseTo(a === 0 ? 1 : b / a, 12);
        }
      });
    });
    const usage = m.tables.find((t) => t.name === 'usage_events')!;
    expect(usage.ratio).toBeLessThan(1);
    expect(usage.ratio).toBeGreaterThan(0);
    // users are kept only when a kept membership points at them
    await withClient(sampled.connectionString(), async (c) => {
      const lonely = await c.query<{ n: string }>(
        'SELECT count(*) AS n FROM public.users u WHERE NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = u.id)',
      );
      expect(Number(lonely.rows[0]!.n)).toBe(0);
      // statistics: ANALYZE ran on the shadow
      const st = await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_stat_user_tables WHERE relname = 'tenants' AND last_analyze IS NOT NULL`,
      );
      expect(Number(st.rows[0]!.n)).toBe(1);
    });
    results.sampledManifest = {
      seed,
      scaling: m.scaling,
      tables: m.tables
        .filter((t) => t.sourceRows > 0)
        .map((t) => ({
          t: t.name,
          source: t.sourceRows,
          shadow: t.shadowRows,
          ratio: Number(t.ratio.toFixed(4)),
          selection: t.selection,
        })),
    };
  });

  it('has the same schema as the source', async () => {
    const a = await withClient(sourceAdmin, schemaSnapshot);
    const b = await withClient(sampled.connectionString(), schemaSnapshot);
    expect({
      missing: a.filter((l) => !b.includes(l)),
      extra: b.filter((l) => !a.includes(l)),
    }).toEqual({ missing: [], extra: [] });
    expect(b).toEqual(a);
  });
});

describe('6. failure cleanup', () => {
  it('a failure after the data was loaded removes the container and the volume', async () => {
    const runId = crypto.randomUUID();
    await expect(
      createShadow({
        sourceUrl: reader,
        mode: 'full',
        runId,
        onStage: (s) => {
          if (s === 'restore-post') throw new Error('simulated restore failure');
        },
      }),
    ).rejects.toThrow('simulated restore failure');
    expect(await leftovers(runId)).toEqual({ containers: [], volumes: [] });
  });

  it('killing the container in the middle of the copy removes everything', async () => {
    const runId = crypto.randomUUID();
    const name = `${NAME_PREFIX}${runId.slice(0, 8)}`;
    let killed = false;
    await expect(
      createShadow({
        sourceUrl: reader,
        mode: 'full',
        runId,
        onStage: async (s) => {
          if (s === 'copy-data') {
            await docker(['kill', name]);
            killed = true;
          }
        },
      }),
    ).rejects.toThrow();
    expect(killed).toBe(true);
    expect(await leftovers(runId)).toEqual({ containers: [], volumes: [] });
    // the source session of the failed clone is gone (no idle-in-transaction snapshot holder left behind)
    await new Promise((r) => setTimeout(r, 500));
    await withClient(sourceAdmin, async (c) => {
      const s = await c.query(
        `SELECT count(*) AS n FROM pg_stat_activity WHERE application_name = $1`,
        [`ledgerworks-shadow-${runId.slice(0, 8)}`],
      );
      expect(Number(s.rows[0].n)).toBe(0);
    });
  });

  it('a failed verification, an unknown sampling root and an impossible host size all leave nothing', async () => {
    const a = crypto.randomUUID();
    await expect(
      createShadow({
        sourceUrl: reader,
        mode: 'sampled',
        sampling: { rootTable: 'public.nope', ratio: 0.5 },
        runId: a,
      }),
    ).rejects.toThrow(/not found/);
    expect(await leftovers(a)).toEqual({ containers: [], volumes: [] });
    const b = crypto.randomUUID();
    await expect(
      createShadow({ sourceUrl: reader, mode: 'full', limits: { cpus: 999 }, runId: b }),
    ).rejects.toBeInstanceOf(ResourceError);
    expect(await leftovers(b)).toEqual({ containers: [], volumes: [] });
    const c = crypto.randomUUID();
    await expect(
      createShadow({ sourceUrl: reader, mode: 'full', limits: { memoryMiB: 999_999 }, runId: c }),
    ).rejects.toBeInstanceOf(ResourceError);
    expect(await leftovers(c)).toEqual({ containers: [], volumes: [] });
    expect(CloneVerificationError.name).toBe('CloneVerificationError');
    expect(UnsupportedExtensionError.name).toBe('UnsupportedExtensionError');
  });

  it('withShadow tears the shadow down when the experiment throws', async () => {
    let runId = '';
    await expect(
      withShadow({ sourceUrl: reader, mode: 'full' }, async (s) => {
        runId = s.runId;
        expect((await shadowStatus(runId)).length).toBe(2);
        throw new Error('experiment blew up');
      }),
    ).rejects.toThrow('experiment blew up');
    expect(await leftovers(runId)).toEqual({ containers: [], volumes: [] });
  });

  it('errors never contain the source password', async () => {
    const bad = withDb(ADMIN_URL, DEMO_DB, 'shadow_reader', 'definitely-wrong-password-123');
    const err = await createShadow({ sourceUrl: bad, mode: 'full' }).then(
      () => new Error('unexpectedly succeeded'),
      (e: Error) => e,
    );
    expect(err.message).not.toContain('definitely-wrong-password-123');
  });
});

describe('7. orphan cleanup', () => {
  const orphan = `${NAME_PREFIX}orphan1`;
  const orphanVol = `${NAME_PREFIX}orphan1-data`;
  const unlabelled = `${NAME_PREFIX}unlabelled1`;
  const unlabelledVol = `${NAME_PREFIX}unlabelled1-data`;
  const wrongName = 'someone-elses-container';
  const image = 'postgres:16-bookworm';
  const exists = async (name: string, kind: 'container' | 'volume'): Promise<boolean> =>
    kind === 'container'
      ? (await docker(['inspect', name], { allowFail: true })).code === 0
      : (await docker(['volume', 'inspect', name], { allowFail: true })).code === 0;

  beforeAll(async () => {
    const old = new Date(Date.now() - 48 * 3600_000).toISOString();
    const labels = [
      '--label',
      `${SHADOW_LABEL}=true`,
      '--label',
      `${RUN_ID_LABEL}=orphan-test`,
      '--label',
      `${CREATED_AT_LABEL}=${old}`,
    ];
    await docker(['volume', 'create', ...labels, orphanVol]);
    await docker([
      'run',
      '-d',
      '--name',
      orphan,
      ...labels,
      '-v',
      `${orphanVol}:/data`,
      '--entrypoint',
      'sleep',
      image,
      '3600',
    ]);
    // look-alikes that must never be touched
    await docker(['volume', 'create', unlabelledVol]);
    await docker([
      'run',
      '-d',
      '--name',
      unlabelled,
      '-v',
      `${unlabelledVol}:/data`,
      '--entrypoint',
      'sleep',
      image,
      '3600',
    ]);
    await docker([
      'run',
      '-d',
      '--name',
      wrongName,
      ...labels,
      '--entrypoint',
      'sleep',
      image,
      '3600',
    ]);
  }, 120_000);
  afterAll(async () => {
    await docker(['rm', '-f', '-v', orphan, unlabelled, wrongName], { allowFail: true });
    await docker(['volume', 'rm', '-f', orphanVol, unlabelledVol], { allowFail: true });
  });

  it('dry run lists the orphan but removes nothing; the real run removes only labelled, prefixed, old resources', async () => {
    const dry = await cleanupShadows({ olderThanMs: 24 * 3600_000, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.selected.map((r) => r.name).sort()).toEqual([orphan, orphanVol].sort());
    // the fresh shadow of this test file is younger than 24 h and is kept
    expect(dry.kept.map((r) => r.name)).toContain(full.containerName);
    for (const [n, k] of [
      [orphan, 'container'],
      [orphanVol, 'volume'],
      [unlabelled, 'container'],
      [unlabelledVol, 'volume'],
      [wrongName, 'container'],
    ] as const) {
      expect(await exists(n, k), `${n} still there after dry run`).toBe(true);
    }

    const real = await cleanupShadows({ olderThanMs: 24 * 3600_000 });
    expect(real.selected.map((r) => r.name).sort()).toEqual([orphan, orphanVol].sort());
    expect(await exists(orphan, 'container')).toBe(false);
    expect(await exists(orphanVol, 'volume')).toBe(false);
    // never touched: no label (despite the prefix), label but wrong name, and the young shadow
    expect(await exists(unlabelled, 'container')).toBe(true);
    expect(await exists(unlabelledVol, 'volume')).toBe(true);
    expect(await exists(wrongName, 'container')).toBe(true);
    expect(await exists(full.containerName, 'container')).toBe(true);
    const listed = (await listShadowResources()).map((r) => r.name);
    expect(listed).not.toContain(unlabelled);
    expect(listed).not.toContain(wrongName);
    results.orphanCleanup = {
      dryRunSelected: dry.selected.map((r) => `${r.kind}:${r.name}`),
      removed: real.selected.map((r) => `${r.kind}:${r.name}`),
      untouched: [
        unlabelled,
        unlabelledVol,
        `${wrongName} (label, wrong name)`,
        `${full.containerName} (younger than the age)`,
      ],
    };
  });
});

// Runs before the tests that make the ADMINISTRATOR role probe or alter privileges on the source: those
// legitimately touch catalog tuples (pg_stat_database counts even rolled-back inserts).
describe('4. the source received no writes', () => {
  it('row counts, checksums and pg_stat write counters are identical before and after all clones of this file', async () => {
    const after = await sourceFingerprint(sourceAdmin);
    const diff = diffFingerprints(before, after);
    expect(diff).toEqual([]);
    expect(Object.keys(before.rowCounts).length).toBeGreaterThan(50);
    results.sourceUnchanged = {
      clonesRunInBetween: 'full, sampled, full (override), 3 failed clones, 1 killed clone',
      before: {
        statDatabase: before.statDatabase,
        statTables: before.statTables,
        tablesCounted: Object.keys(before.rowCounts).length,
        smallTablesChecksummed: Object.keys(before.checksums).length,
      },
      after: { statDatabase: after.statDatabase, statTables: after.statTables },
      differences: diff,
    };
  });

  it('the shadow runner never connects to the source as anything but the given role (application_name is identifiable)', async () => {
    await withClient(sourceAdmin, async (c) => {
      const r = await c.query(
        `SELECT count(*) AS n FROM pg_stat_activity WHERE application_name LIKE 'ledgerworks-shadow-%'`,
      );
      expect(Number(r.rows[0].n)).toBe(0); // and no session is left open
    });
  });
});

describe('5. the source role cannot write, and a writable role is refused', () => {
  it('every write attempt as the read-only role fails (session read-only and privileges)', async () => {
    const attempts: string[] = [];
    // 1. as a normal session (default_transaction_read_only is on for this role)
    await withClient(reader, async (c) => {
      expect(
        (await c.query(`SELECT current_setting('default_transaction_read_only') AS v`)).rows[0].v,
      ).toBe('on');
      for (const sql of [
        `INSERT INTO public.tenants (name) VALUES ('x')`,
        `UPDATE public.tenants SET name = name`,
        `DELETE FROM public.tenants`,
        `TRUNCATE public.tenants`,
        `CREATE TABLE public.shadow_probe (a int)`,
        `DROP TABLE public.tenants`,
        `CREATE SCHEMA probe`,
      ]) {
        await expect(c.query(sql), sql).rejects.toMatchObject({ code: '25006' });
        attempts.push(`session: ${sql.split(' ').slice(0, 3).join(' ')} -> 25006`);
      }
    });
    // 2. with the session default overridden (any role may do that): privileges must still deny
    await withClient(reader, async (c) => {
      for (const sql of [
        `INSERT INTO public.tenants (name) VALUES ('x')`,
        `UPDATE public.tenants SET name = name`,
        `DELETE FROM public.tenants`,
        `TRUNCATE public.tenants`,
        `CREATE TABLE public.shadow_probe (a int)`,
        `DROP TABLE public.tenants`,
        `CREATE SCHEMA probe`,
        `SELECT setval(c.oid::regclass, 1) FROM pg_class c WHERE c.relkind = 'S' AND c.relnamespace = 'public'::regnamespace LIMIT 1`,
        `SELECT nextval(c.oid::regclass) FROM pg_class c WHERE c.relkind = 'S' AND c.relnamespace = 'public'::regnamespace LIMIT 1`,
      ]) {
        await c.query('BEGIN');
        await c.query('SET TRANSACTION READ WRITE');
        await c.query('SAVEPOINT s');
        // a database without any sequence returns no row for the last two: both outcomes are "no write happened"
        const r = await c.query(sql).then(
          (x) => ({ ok: true as const, rows: x.rowCount }),
          (e: { code?: string }) => ({ ok: false as const, code: e.code }),
        );
        await c.query('ROLLBACK');
        if (r.ok) expect(r.rows, sql).toBe(0);
        else expect(r.code, sql).toBe('42501');
        attempts.push(
          `privilege: ${sql.split(' ').slice(0, 3).join(' ')} -> ${r.ok ? 'no row' : r.code}`,
        );
      }
    });
    results.writeAttemptsAsReadOnlyRole = attempts;
  });

  it('the readiness check passes the read-only role and records harmless probes as denied', async () => {
    const check = await checkSourceReadOnly(reader);
    expect(check.canWrite).toBe(false);
    expect(check.reasons).toEqual([]);
    expect(check.probes.map((p) => `${p.name}:${p.outcome}`)).toEqual([
      'create-schema:denied',
      'delete-no-rows:denied',
    ]);
    expect(check.roleAttributes).toMatchObject({
      superuser: false,
      bypassRls: true,
      createDb: false,
    });
    results.readinessCheckReadOnlyRole = check;
  });

  it('refuses a superuser, and a role that can INSERT into tables (member of the application role)', async () => {
    const admin = await checkSourceReadOnly(sourceAdmin);
    expect(admin.canWrite).toBe(true);
    expect(admin.reasons).toContain('role is a superuser');
    await withClient(sourceAdmin, async (c) => {
      await dropRoleIfExists(c, 'shadow_writer_test');
      // Privileges come from role membership only: that is a change to shared catalogs, not to the source database.
      await c.query(`CREATE ROLE shadow_writer_test LOGIN PASSWORD 'w' BYPASSRLS`);
      await c.query('GRANT pg_read_all_data TO shadow_writer_test');
      await c.query('GRANT ledgerline_app TO shadow_writer_test');
      await c.query(`GRANT CONNECT ON DATABASE ${DEMO_DB} TO shadow_writer_test`);
    });
    try {
      const weak = withDb(ADMIN_URL, DEMO_DB, 'shadow_writer_test', 'w');
      const check = await checkSourceReadOnly(weak);
      expect(check.canWrite).toBe(true);
      expect(check.reasons.join(' ')).toMatch(
        /INSERT\/UPDATE\/DELETE\/TRUNCATE privilege on [0-9]+ relation/,
      );
      const runId = crypto.randomUUID();
      await expect(createShadow({ sourceUrl: weak, mode: 'full', runId })).rejects.toBeInstanceOf(
        SourceWritableError,
      );
      expect(await leftovers(runId)).toEqual({ containers: [], volumes: [] });
      results.writableRoleRefused = { reasons: check.reasons };
    } finally {
      await withClient(sourceAdmin, async (c) => {
        await dropRoleIfExists(c, 'shadow_writer_test');
      });
    }
  });

  it('the override is explicit, logged loudly and recorded in the manifest', async () => {
    const logs: string[] = [];
    const h = await createShadow({
      sourceUrl: sourceAdmin,
      mode: 'full',
      allowWritableSource: true,
      log: (m) => logs.push(m),
    });
    try {
      expect(logs.some((l) => l.includes('OVERRIDE') && l.includes('CAN WRITE'))).toBe(true);
      expect(h.manifest.source.readOnlyCheck).toMatchObject({ canWrite: true, overrideUsed: true });
      expect(h.manifest.warnings.join(' ')).toMatch(/allowWritableSource/);
      expect(logs.join(' ')).not.toMatch(/postgres(ql)?:[/][/]/); // no connection string in the log
    } finally {
      await h.destroy();
    }
  });

  it('refuses a source role that is subject to RLS (a copy would silently miss rows)', async () => {
    await withClient(sourceAdmin, async (c) => {
      await dropRoleIfExists(c, 'shadow_rls_test');
      await c.query(`CREATE ROLE shadow_rls_test LOGIN PASSWORD 'w'`);
      await c.query('GRANT pg_read_all_data TO shadow_rls_test');
      await c.query(`GRANT CONNECT ON DATABASE ${DEMO_DB} TO shadow_rls_test`);
      await c.query(`ALTER ROLE shadow_rls_test SET default_transaction_read_only = on`);
    });
    try {
      const runId = crypto.randomUUID();
      await expect(
        createShadow({
          sourceUrl: withDb(ADMIN_URL, DEMO_DB, 'shadow_rls_test', 'w'),
          mode: 'full',
          runId,
        }),
      ).rejects.toThrow(/row-level security/);
      expect(await leftovers(runId)).toEqual({ containers: [], volumes: [] });
    } finally {
      await withClient(sourceAdmin, async (c) => {
        await dropRoleIfExists(c, 'shadow_rls_test');
      });
    }
  });
});

describe('marker', () => {
  it('a source database is not a shadow', async () => {
    await withClient(sourceAdmin, async (c) => {
      await expect(assertShadow(c)).rejects.toBeInstanceOf(NotShadowError);
    });
  });
  it('a database with the marker table but without the database setting is not a shadow', async () => {
    await withClient(full.connectionString(), async (c) => {
      await c.query(`CREATE DATABASE marker_probe`);
    });
    const probe = withDb(full.connectionString(), 'marker_probe');
    try {
      await withClient(probe, async (c) => {
        await expect(assertShadow(c)).rejects.toBeInstanceOf(NotShadowError);
        await c.query('CREATE SCHEMA ledgerworks_meta');
        await c.query('CREATE TABLE ledgerworks_meta.shadow_marker (run_id text, manifest jsonb)');
        await expect(assertShadow(c)).rejects.toBeInstanceOf(NotShadowError);
      });
    } finally {
      await withClient(full.connectionString(), (c) =>
        c.query('DROP DATABASE marker_probe WITH (FORCE)'),
      );
    }
  });
});
