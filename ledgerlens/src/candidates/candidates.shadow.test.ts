/**
 * Up, then down, on a real shadow, for every kind of candidate: the schema afterwards equals the schema before
 * (the harness's own schema fingerprint, plus statistics targets). Needs Docker (the shadow image).
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotShadowError, createShadow, schemaSnapshot, type ShadowHandle } from '@ledgerworks/core';
import { makeFinding } from '../analyzer/findings.js';
import { parsePlan } from '../analyzer/plan.js';
import { admin, createScratchDb, type ScratchDb } from '../testing/db.js';
import { stmt } from '../testing/fixtures.js';
import { readSnapshot, type SchemaSnapshot } from '../schema/snapshot.js';
import { openSource, readColumnStats, readTable, withSource } from '../workload/source.js';
import type { BindingSet, StatementBindings } from '../workload/bindings.js';
import { applyCandidateOnShadow } from './apply.js';
import { generateCandidates } from './generate.js';
import type { SqlCandidate } from './types.js';

let db: ScratchDb;
let shadow: ShadowHandle;
let snapshot: SchemaSnapshot;
let stats: Awaited<ReturnType<typeof readColumnStats>>;

beforeAll(async () => {
  db = await createScratchDb([
    `CREATE TABLE events (id bigserial PRIMARY KEY, tenant_id int NOT NULL, kind text NOT NULL, qty int, occurred_at timestamptz NOT NULL)`,
    `INSERT INTO events (tenant_id, kind, qty, occurred_at)
       SELECT g % 50, (ARRAY['a','b','c'])[1 + g % 3], g % 100, now() - (g || ' minutes')::interval FROM generate_series(1, 20000) g`,
    `CREATE INDEX events_tenant ON events (tenant_id)`,
    `CREATE INDEX events_tenant_time ON events (tenant_id, occurred_at)`,
    `CREATE TABLE jobs (id bigserial PRIMARY KEY, state text NOT NULL, run_at timestamptz NOT NULL)`,
    `INSERT INTO jobs (state, run_at) SELECT CASE WHEN g % 50 = 0 THEN 'pending' ELSE 'done' END, now() - (g || ' seconds')::interval FROM generate_series(1, 20000) g`,
    `CREATE TABLE pevents (id bigint NOT NULL, tenant_id int NOT NULL, occurred_at timestamptz NOT NULL) PARTITION BY RANGE (occurred_at)`,
    ...[0, 1, 2, 3].map(
      (i) =>
        `CREATE TABLE pevents_p${i} PARTITION OF pevents FOR VALUES FROM ('2025-0${i + 1}-01') TO ('2025-0${i + 2}-01')`,
    ),
    `INSERT INTO pevents SELECT g, g % 40, timestamptz '2025-01-01' + (g % 120 || ' days')::interval FROM generate_series(1, 20000) g`,
    `CREATE TABLE stale (id serial PRIMARY KEY, a int, b int) WITH (autovacuum_enabled = false)`,
    `INSERT INTO stale (a, b) SELECT g % 100, g % 7 FROM generate_series(1, 20000) g`,
    'ANALYZE',
  ]);
  const source = openSource(db.readerUrl);
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
  stats = await withSource(source.connect, async (c) => {
    const t = (await readTable(c, { schema: null, name: 'jobs', alias: null }))!;
    return readColumnStats(c, t, ['state']);
  });
  shadow = await createShadow({ sourceUrl: db.readerUrl, mode: 'full' });
}, 600_000);

afterAll(async () => {
  await shadow?.destroy();
  await db?.drop();
}, 120_000);

/** the harness's schema fingerprint plus what it does not carry: statistics targets */
async function fingerprint(c: pg.Client): Promise<string[]> {
  const base = await schemaSnapshot(c);
  const targets = await c.query<{ line: string }>(
    `SELECT format('stattarget|%s.%s|%s', n.nspname, c.relname, a.attname) || '|' || a.attstattarget AS line
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p') ORDER BY 1`,
  );
  return [...base, ...targets.rows.map((r) => r.line)];
}

async function candidatesFor(): Promise<SqlCandidate[]> {
  const set = (v: string): BindingSet => ({
    id: 's',
    provenance: 'user-supplied',
    confidence: 'high',
    notes: [],
    validation: { status: 'ok' },
    params: [
      {
        index: 1,
        value: v,
        isArray: false,
        provenance: 'user-supplied',
        origin: 'user',
        structural: false,
        column: null,
      },
      {
        index: 2,
        value: '2030-01-01',
        isArray: false,
        provenance: 'user-supplied',
        origin: 'user',
        structural: false,
        column: null,
      },
      {
        index: 3,
        value: '10',
        isArray: false,
        provenance: 'user-supplied',
        origin: 'user',
        structural: false,
        column: null,
      },
    ],
  });
  const jobs = await stmt(
    'SELECT id FROM jobs WHERE state = $1 AND run_at <= $2 ORDER BY run_at LIMIT $3',
  );
  const eq = await stmt('SELECT id, qty FROM events WHERE qty = $1 AND kind = $2');
  const part = await stmt('SELECT id FROM pevents WHERE tenant_id = $1');
  const cover = await stmt(
    'SELECT tenant_id, occurred_at, qty FROM events WHERE tenant_id = $1 AND occurred_at >= $2',
  );
  const fakePlan = parsePlan([
    {
      Plan: {
        'Node Type': 'Seq Scan',
        'Relation Name': 'stale',
        'Plan Rows': 1,
        'Actual Rows': 5000,
        'Actual Loops': 1,
        Filter: '(a = 7)',
      },
    },
  ]);
  const stale = makeFinding({
    kind: 'stale_statistics',
    severity: 'high',
    node: fakePlan.root,
    subject: { relation: 'stale' },
    evidence: [{ name: 'modificationRatio', value: 1, unit: 'ratio' }],
    summary: 's',
    analyzed: true,
  });
  const mismatch = makeFinding({
    kind: 'estimate_mismatch',
    severity: 'high',
    node: fakePlan.root,
    subject: { relation: 'stale', detail: '(a = 7)' },
    evidence: [{ name: 'factor', value: 50, unit: 'factor' }],
    summary: 's',
    analyzed: true,
  });
  const stmtOnStale = await stmt('SELECT count(*) FROM stale WHERE a = $1');
  const stmtOnStale2 = await stmt('SELECT count(*) FROM stale WHERE a = $1 AND b > $2');
  const b = (s: Awaited<ReturnType<typeof stmt>>, v: string): StatementBindings => ({
    queryId: s.queryId,
    queryHash: s.queryHash,
    status: 'bound',
    unverifiable: null,
    sets: [set(v)],
  });
  const r = await generateCandidates(
    {
      statements: [
        { statement: jobs, bindings: b(jobs, 'pending') },
        { statement: eq },
        { statement: part },
        { statement: cover },
        { statement: stmtOnStale, findings: [stale] },
        { statement: stmtOnStale2, findings: [mismatch] },
      ],
      snapshot,
      columnStats: (_s, t, c) => (t === 'jobs' ? stats.get(c) : undefined),
    },
    { minTableRows: 1000 },
  );
  return r.candidates.filter((c): c is SqlCandidate => c.upSql !== null);
}

describe('every kind of candidate: up, then down, and the schema is what it was', () => {
  it('all kinds are generated for the test database', async () => {
    const cs = await candidatesFor();
    const summary = cs
      .map(
        (c) =>
          `${c.kind}${c.index?.partial ? ':partial' : ''}${c.index?.include.length ? ':covering' : ''}${c.index?.partitions ? ':partitioned' : ''}`,
      )
      .sort();
    expect(summary).toEqual(
      expect.arrayContaining([
        'create_index',
        'create_index:covering',
        'create_index:partial',
        'create_index:partitioned',
        'drop_redundant_index',
        'analyze_or_stats_target',
      ]),
    );
    // two analyze_or_stats_target candidates: ANALYZE and the statistics target
    expect(cs.filter((c) => c.kind === 'analyze_or_stats_target')).toHaveLength(2);
    // every SQL-bearing candidate has down SQL
    for (const c of cs) expect(c.downSql.length).toBeGreaterThan(0);
  });

  it('apply up, apply down, schema diff empty, for each; and the up really changed something where it should', async () => {
    const cs = await candidatesFor();
    const c = await shadow.connect();
    try {
      for (const cand of cs) {
        const before = await fingerprint(c);
        await applyCandidateOnShadow(c, cand, 'up');
        const during = await fingerprint(c);
        if (cand.upSql.startsWith('ANALYZE'))
          expect(during).toEqual(before); // statistics are not schema
        else expect(during, cand.upSql.slice(0, 80)).not.toEqual(before);
        if (cand.kind === 'create_index') {
          const valid = await c.query<{ valid: boolean; n: number }>(
            `SELECT bool_and(i.indisvalid) AS valid, count(*)::int AS n FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid WHERE ic.relname LIKE $1`,
            [`${cand.index!.indexName.slice(0, 55)}%`],
          );
          expect(valid.rows[0]!.valid, cand.index!.indexName).toBe(true);
          expect(valid.rows[0]!.n).toBe(
            cand.index!.partitions ? 1 + cand.index!.partitions.length : 1,
          );
        }
        await applyCandidateOnShadow(c, cand, 'down');
        const after = await fingerprint(c);
        expect(after, `${cand.kind}: ${cand.upSql.slice(0, 100)}`).toEqual(before);
      }
    } finally {
      await c.end();
    }
  });

  it('applying twice is harmless (IF NOT EXISTS / IF EXISTS), and the down of something that was never applied is too', async () => {
    const cs = (await candidatesFor()).filter(
      (x) => x.kind === 'create_index' && !x.index!.partitions,
    );
    const c = await shadow.connect();
    try {
      const cand = cs[0]!;
      await applyCandidateOnShadow(c, cand, 'down'); // nothing to drop
      await applyCandidateOnShadow(c, cand, 'up');
      await applyCandidateOnShadow(c, cand, 'up'); // already there
      await applyCandidateOnShadow(c, cand, 'down');
    } finally {
      await c.end();
    }
  });

  it('refuses to apply anything to a database that is not a shadow: the source is untouched', async () => {
    const cs = await candidatesFor();
    const cand = cs.find((x) => x.kind === 'create_index')!;
    const before = await admin(db.name, async (a) => schemaSnapshot(a));
    await admin(db.name, async (a) => {
      await expect(applyCandidateOnShadow(a, cand, 'up')).rejects.toBeInstanceOf(NotShadowError);
    });
    expect(await admin(db.name, async (a) => schemaSnapshot(a))).toEqual(before);
  });
});
