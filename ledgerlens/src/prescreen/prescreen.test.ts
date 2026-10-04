/**
 * The HypoPG pre-screen on a real shadow (cloned from a scratch database): planted missing index passes,
 * a useless index is rejected with its reason, nothing persists, only shadows are accepted, and the report
 * never calls an estimate a speedup. Needs Docker (the shadow image, which has HypoPG).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotShadowError, createShadow, type ShadowHandle } from '@ledgerworks/core';
import { generateCandidates } from '../candidates/generate.js';
import type { SqlCandidate } from '../candidates/types.js';
import { readSnapshot, type SchemaSnapshot } from '../schema/snapshot.js';
import { admin, createScratchDb, type ScratchDb } from '../testing/db.js';
import { stmt } from '../testing/fixtures.js';
import { bindStatement, type StatementBindings } from '../workload/bindings.js';
import { openSource, withSource } from '../workload/source.js';
import { validateBindings } from '../workload/validate.js';
import type { WorkloadStatement } from '../workload/types.js';
import {
  FORBIDDEN_WORDS,
  PrescreenReportSchema,
  StatementScreenSchema,
  prescreenCandidates,
  renderPrescreenReport,
  type PrescreenReport,
} from './index.js';

let db: ScratchDb;
let shadow: ShadowHandle;
let source: ReturnType<typeof openSource>;
let snapshot: SchemaSnapshot;

beforeAll(async () => {
  db = await createScratchDb([
    `CREATE TABLE events (id bigserial PRIMARY KEY, tenant_id int NOT NULL, flag boolean NOT NULL, occurred_at timestamptz NOT NULL, note text)`,
    // tenant_id: 1,000 values; flag: 60% true. No index on either.
    `INSERT INTO events (tenant_id, flag, occurred_at, note)
       SELECT g % 1000, g % 5 < 3, timestamptz '2025-01-01' + (g || ' seconds')::interval, 'n' || g FROM generate_series(1, 150000) g`,
    `CREATE TABLE pevents (id bigint NOT NULL, tenant_id int NOT NULL, occurred_at timestamptz NOT NULL) PARTITION BY RANGE (occurred_at)`,
    ...[0, 1, 2, 3].map(
      (i) =>
        `CREATE TABLE pevents_p${i} PARTITION OF pevents FOR VALUES FROM ('2025-0${i + 1}-01') TO ('2025-0${i + 2}-01')`,
    ),
    `INSERT INTO pevents SELECT g, g % 1000, timestamptz '2025-01-01' + (g % 120 || ' days')::interval FROM generate_series(1, 100000) g`,
    `CREATE TABLE victim (id int)`,
    `INSERT INTO victim VALUES (1)`,
    'ANALYZE',
  ]);
  source = openSource(db.readerUrl);
  await source.ensureReadOnly();
  snapshot = (
    await readSnapshot(
      { sourceUrl: db.readerUrl, applicationName: 'ledgerlens-test' },
      source.connect,
      {
        schemas: ['public'],
      },
    )
  ).snapshot;
  shadow = await createShadow({ sourceUrl: db.readerUrl, mode: 'full' });
}, 600_000);

afterAll(async () => {
  await shadow?.destroy();
  await db?.drop();
}, 120_000);

async function bound(
  sql: string,
  userBindings?: Record<string, (string | number | boolean | null)[][]>,
): Promise<{ statement: WorkloadStatement; bindings: StatementBindings }> {
  const statement = await stmt(sql);
  const b = await withSource(source.connect, (c) =>
    bindStatement(c, statement, {
      sets: 3,
      userBindings: userBindings && { [statement.queryId]: userBindings.rows! },
    }),
  );
  return { statement, bindings: await validateBindings(source.connect, statement, b) };
}

async function candidateFor(
  s: { statement: WorkloadStatement; bindings: StatementBindings },
  pick: (c: SqlCandidate) => boolean = () => true,
): Promise<SqlCandidate> {
  const r = await generateCandidates(
    { statements: [s], snapshot },
    { minTableRows: 1000, variants: false },
  );
  return r.candidates.find(
    (c): c is SqlCandidate => c.kind === 'create_index' && pick(c as SqlCandidate),
  )!;
}

async function counts(c: pg.Client): Promise<{ classes: number; indexes: number }> {
  const r = await c.query<{ classes: number; indexes: number }>(
    'SELECT (SELECT count(*) FROM pg_class)::int AS classes, (SELECT count(*) FROM pg_index)::int AS indexes',
  );
  return r.rows[0]!;
}

describe('the pre-screen', () => {
  it('a planted missing index passes: the planner uses the hypothetical index and expects much less work', async () => {
    const s = await bound('SELECT id, note FROM events WHERE tenant_id = $1 AND occurred_at >= $2');
    const cand = await candidateFor(s);
    expect(cand).toBeDefined();
    const [r] = await prescreenCandidates(shadow, [{ candidate: cand, statements: [s] }], {
      settle: 'never',
    });
    expect(r!.decision).toBe('pass');
    expect(r!.reason).toBeNull();
    expect(r!.screens.length).toBeGreaterThan(0);
    for (const sc of r!.screens) {
      expect(sc.plannerUsesIndex).toBe(true);
      expect(sc.estimatedCostRatio).toBeLessThan(0.5);
      expect(sc.costWith).toBeLessThan(sc.costWithout!);
      expect(sc.measuredSpeedup).toBeNull();
    }
    expect(r!.estimatedCostRatio).toBeLessThan(0.5);
    expect(r!.measuredSpeedup).toBeNull();
    expect(r!.shadow.manifestId).toBe(shadow.manifest.id);
    expect(r!.shadow.sampled).toBe(false);
    expect(PrescreenReportSchema.parse(JSON.parse(JSON.stringify(r)))).toEqual(r);
  });

  it('a partitioned table works too (HypoPG builds the hypothetical index on the parent)', async () => {
    const s = await bound('SELECT id FROM pevents WHERE tenant_id = $1');
    const cand = await candidateFor(s);
    expect(cand.index!.partitions).not.toBeNull();
    const [r] = await prescreenCandidates(shadow, [{ candidate: cand, statements: [s] }], {
      settle: 'never',
    });
    expect(r!.decision).toBe('pass');
    expect(r!.screens.every((x) => x.nodesUsingIndex >= 1)).toBe(true);
  });

  it('a useless index on a low-selectivity column is rejected, with its reason', async () => {
    // 60% of the rows are flag = true: the planner will not use an index to read most of the table
    const s = await bound('SELECT id FROM events WHERE flag = $1', { rows: [[true]] });
    const cand = await candidateFor(s);
    expect(cand.index!.key.map((k) => k.name)).toEqual(['flag']);
    const [r] = await prescreenCandidates(shadow, [{ candidate: cand, statements: [s] }], {
      settle: 'never',
    });
    expect(r!.decision).toBe('reject');
    expect(r!.reason).toBe('index_not_used');
    expect(r!.summary).toMatch(/does not use the hypothetical index/);
    expect(r!.screens.every((x) => !x.plannerUsesIndex)).toBe(true);
    // the ratio of an unused index is about 1 (the same plan); the report's own ratio only counts plans that use the index
    for (const x of r!.screens) expect(x.estimatedCostRatio).toBeGreaterThan(0.99);
    expect(r!.estimatedCostRatio).toBeNull();
  });

  it('an index the planner uses, but for too little estimated gain, is rejected with the other reason', async () => {
    const s = await bound('SELECT id, note FROM events WHERE tenant_id = $1');
    const cand = await candidateFor(s);
    const [r] = await prescreenCandidates(shadow, [{ candidate: cand, statements: [s] }], {
      settle: 'never',
      maxCostRatioToPass: 0.0001,
    });
    expect(r!.decision).toBe('reject');
    expect(r!.reason).toBe('cost_reduction_below_threshold');
    expect(r!.screens.some((x) => x.plannerUsesIndex)).toBe(true);
  });

  it('candidates it cannot screen say why: not an index, no bindings', async () => {
    const s = await bound('SELECT id FROM events WHERE tenant_id = $1');
    const drop: SqlCandidate = { ...(await candidateFor(s)), kind: 'drop_redundant_index' };
    const nobind = await bound('SELECT id FROM events WHERE tenant_id = $1 AND note = lower($2)');
    const cand = await candidateFor(s);
    const rs = await prescreenCandidates(
      shadow,
      [
        { candidate: drop, statements: [s] },
        {
          candidate: cand,
          statements: [
            {
              statement: nobind.statement,
              bindings: { ...nobind.bindings, status: 'unverifiable', sets: [] },
            },
          ],
        },
        { candidate: cand, statements: [] },
      ],
      { settle: 'never' },
    );
    expect(rs.map((r) => [r.decision, r.reason])).toEqual([
      ['cannot_screen', 'not_an_index_candidate'],
      ['cannot_screen', 'no_verifiable_statement'],
      ['cannot_screen', 'no_verifiable_statement'],
    ]);
  });
});

describe('only shadows, and nothing persists', () => {
  it('refuses a database that is not a shadow, before anything else is sent', async () => {
    const s = await bound('SELECT id FROM events WHERE tenant_id = $1');
    const cand = await candidateFor(s);
    const notShadow = { connectionString: () => db.adminUrl };
    await expect(
      prescreenCandidates(notShadow, [{ candidate: cand, statements: [s] }]),
    ).rejects.toBeInstanceOf(NotShadowError);
    // also when the connection has the right role but no marker
    await admin(db.name, async (a) => {
      expect((await a.query('SELECT count(*)::int AS n FROM victim')).rows[0]!.n).toBe(1);
      const ext = await a.query("SELECT 1 FROM pg_extension WHERE extname = 'hypopg'");
      expect(ext.rowCount).toBe(0); // the source database was not changed in any way
    });
  });

  it('hypothetical indexes live in the session: another session never sees them, and after the session ends nothing is left', async () => {
    const conn = (): pg.Client => new pg.Client({ connectionString: shadow.connectionString() });
    const a = conn();
    const b = conn();
    await a.connect();
    await b.connect();
    const base = await counts(a);
    await a.query(
      `SELECT * FROM ledgerworks_ext.hypopg_create_index('CREATE INDEX ON public.events (tenant_id)')`,
    );
    expect(
      (await a.query('SELECT count(*)::int AS n FROM ledgerworks_ext.hypopg_list_indexes')).rows[0]!
        .n,
    ).toBe(1);
    expect(
      (await b.query('SELECT count(*)::int AS n FROM ledgerworks_ext.hypopg_list_indexes')).rows[0]!
        .n,
    ).toBe(0);
    expect(await counts(b)).toEqual(base); // not in the catalog either
    await a.end();
    const c = conn();
    await c.connect();
    expect(
      (await c.query('SELECT count(*)::int AS n FROM ledgerworks_ext.hypopg_list_indexes')).rows[0]!
        .n,
    ).toBe(0);
    expect(await counts(c)).toEqual(base);
    await b.end();
    await c.end();
  });

  it('after the pre-screen returns, no hypothetical index, no catalog change and no connection of its own is left', async () => {
    const probe = new pg.Client({ connectionString: shadow.connectionString() });
    await probe.connect();
    const base = await counts(probe);
    const s = await bound('SELECT id, note FROM events WHERE tenant_id = $1 AND occurred_at >= $2');
    const cand = await candidateFor(s);
    await prescreenCandidates(shadow, [{ candidate: cand, statements: [s] }], { settle: 'never' });
    expect(await counts(probe)).toEqual(base);
    const left = await probe.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name LIKE 'ledgerlens-prescreen%'",
    );
    expect(left.rows[0]!.n).toBe(0);
    const fresh = new pg.Client({ connectionString: shadow.connectionString() });
    await fresh.connect();
    expect(
      (await fresh.query('SELECT count(*)::int AS n FROM ledgerworks_ext.hypopg_list_indexes'))
        .rows[0]!.n,
    ).toBe(0);
    await fresh.end();
    await probe.end();
  });
});

describe('the report never calls an estimate a speedup', () => {
  async function sampleReports(): Promise<PrescreenReport[]> {
    const s = await bound('SELECT id, note FROM events WHERE tenant_id = $1 AND occurred_at >= $2');
    const useless = await bound('SELECT id FROM events WHERE flag = $1', { rows: [[true]] });
    const c1 = await candidateFor(s);
    const c2 = await candidateFor(useless);
    return prescreenCandidates(
      shadow,
      [
        { candidate: c1, statements: [s] },
        { candidate: c2, statements: [useless] },
        { candidate: { ...c1, kind: 'drop_redundant_index' }, statements: [s] },
        { candidate: c1, statements: [] },
      ],
      { settle: 'never' },
    );
  }

  it('estimatedCostRatio and measuredSpeedup are separate fields, and measuredSpeedup can only be null', async () => {
    const shape = Object.keys(PrescreenReportSchema.shape);
    expect(shape).toContain('estimatedCostRatio');
    expect(shape).toContain('measuredSpeedup');
    expect(Object.keys(StatementScreenSchema.shape)).toEqual(
      expect.arrayContaining(['estimatedCostRatio', 'measuredSpeedup']),
    );
    const [r] = await sampleReports();
    expect(() => PrescreenReportSchema.parse({ ...r, measuredSpeedup: 3.2 })).toThrow();
    expect(() => PrescreenReportSchema.parse({ ...r, measuredSpeedup: 1 })).toThrow();
    expect(() => StatementScreenSchema.parse({ ...r!.screens[0], measuredSpeedup: 2 })).toThrow();
    // no other field is named like a speedup
    const names = [
      ...Object.keys(PrescreenReportSchema.shape),
      ...Object.keys(StatementScreenSchema.shape),
    ];
    expect(names.filter((n) => /speed|faster|gain/i.test(n))).toEqual([
      'measuredSpeedup',
      'measuredSpeedup',
    ]);
  });

  it('no text of any report (pass, reject, cannot screen), and no rendering of it, says speedup or faster', async () => {
    for (const r of await sampleReports()) {
      expect(r.measuredSpeedup).toBeNull();
      const textOnly = JSON.stringify(r, (k, v) => (k === 'measuredSpeedup' ? undefined : v));
      expect(textOnly).not.toMatch(FORBIDDEN_WORDS);
      const rendered = renderPrescreenReport(r);
      expect(rendered).not.toMatch(FORBIDDEN_WORDS);
      expect(rendered).toMatch(/estimat/i); // numbers are called estimates
      expect(r.note).toMatch(/ESTIMATED/);
    }
  });

  it('no string in the pre-screen source says speedup or faster either', () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
    for (const f of ['report.ts', 'prescreen.ts']) {
      const code = readFileSync(path.join(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.includes('FORBIDDEN_WORDS ='))
        .join('\n')
        .replace(/\/speed[^\n]*\/i;/, '') // the definition of the forbidden words itself
        .replaceAll('measuredSpeedup', 'measuredField');
      expect(code, f).not.toMatch(FORBIDDEN_WORDS);
    }
  });

  it('is only ever null: no code path of the pre-screen sets measuredSpeedup to anything else', () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
    const src = readFileSync(path.join(dir, 'prescreen.ts'), 'utf8');
    const assignments = src.match(/measuredSpeedup\s*[:=]\s*[^,\n;)]+/g) ?? [];
    expect(assignments.length).toBeGreaterThan(0);
    for (const a of assignments) expect(a).toMatch(/measuredSpeedup\s*[:=]\s*null/);
  });
});

describe('without HypoPG', () => {
  it('says so instead of passing or rejecting (run last: it removes the extension from the throwaway shadow)', async () => {
    const s = await bound('SELECT id FROM events WHERE tenant_id = $1');
    const cand = await candidateFor(s);
    const a = new pg.Client({ connectionString: shadow.connectionString() });
    await a.connect();
    await a.query('DROP EXTENSION hypopg');
    await a.end();
    const [r] = await prescreenCandidates(shadow, [{ candidate: cand, statements: [s] }], {
      settle: 'never',
    });
    expect(r!.decision).toBe('cannot_screen');
    expect(r!.reason).toBe('hypopg_unavailable');
  });
});
