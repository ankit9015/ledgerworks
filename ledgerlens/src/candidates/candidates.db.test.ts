import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, createScratchDb, type ScratchDb } from '../testing/db.js';
import { snapshotOf, stmt, table } from '../testing/fixtures.js';
import { readSnapshot, type SchemaSnapshot } from '../schema/snapshot.js';
import { openSource, readColumnStats, readTable, withSource } from '../workload/source.js';
import { MAX_IDENTIFIER_BYTES, quoteIdent, quoteLiteral, quoteQualified } from '../sql/ident.js';
import { generateCandidates } from './generate.js';
import type { Candidate, SqlCandidate } from './types.js';

const HOSTILE: Record<string, { table: string; column: string }> = {
  quotes: { table: 'we"ird_table', column: 'we"ird_col' },
  'a semicolon and a statement': {
    table: 'x"; DROP TABLE victim; --',
    column: 'c"; DROP TABLE victim; --',
  },
  newlines: { table: 'two\nlines', column: 'a\nb\r\nc' },
  unicode: { table: 'tablé 日本語 😀', column: 'colonne é 日本' },
  'a reserved word': { table: 'select', column: 'order' },
  'a name that looks like SQL': {
    table: 'x) ; DELETE FROM victim WHERE (1=1',
    column: 'y) ; DELETE FROM victim --',
  },
  'exactly 63 bytes': { table: 't'.repeat(MAX_IDENTIFIER_BYTES), column: 'é'.repeat(31) + 'c' },
};

let db: ScratchDb;
let source: ReturnType<typeof openSource>;
beforeAll(async () => {
  db = await createScratchDb([
    'CREATE TABLE victim (id int)',
    'INSERT INTO victim VALUES (1), (2), (3)',
    `CREATE TABLE events (id bigserial PRIMARY KEY, tenant_id int NOT NULL, kind text NOT NULL, qty int, occurred_at timestamptz NOT NULL)`,
    `INSERT INTO events (tenant_id, kind, qty, occurred_at)
       SELECT g % 50, (ARRAY['a','b','c'])[1 + g % 3], g % 100, now() - (g || ' minutes')::interval FROM generate_series(1, 30000) g`,
    'CREATE INDEX events_tenant ON events (tenant_id)',
    'CREATE INDEX events_tenant_time ON events (tenant_id, occurred_at)',
    'CREATE INDEX events_tenant_time_copy ON events (tenant_id, occurred_at)',
    'CREATE UNIQUE INDEX events_unique_kind_qty ON events (kind, qty, id)',
    `CREATE INDEX events_partial ON events (occurred_at) WHERE kind = 'a'`,
    ...Object.values(HOSTILE).flatMap((h) => [
      `CREATE TABLE ${quoteIdent(h.table)} (id int, ${quoteIdent(h.column)} int)`,
      `INSERT INTO ${quoteIdent(h.table)} SELECT g, g % 10 FROM generate_series(1, 20000) g`,
    ]),
    'ANALYZE',
  ]);
  source = openSource(db.readerUrl);
  await source.ensureReadOnly();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

async function snapshot(): Promise<SchemaSnapshot> {
  const { snapshot: s, warnings } = await readSnapshot(
    { sourceUrl: db.readerUrl, applicationName: 'ledgerlens-test' },
    source.connect,
    {
      schemas: ['public'],
      maxTables: 100,
    },
  );
  expect(warnings).toEqual([]);
  return s;
}

describe('against the real describe_schema output', () => {
  it('the snapshot has the indexes of the database as structure (columns, direction, include, predicate, unique)', async () => {
    const s = await snapshot();
    const ev = s.tables.find((t) => t.name === 'events')!;
    const byName = Object.fromEntries(ev.indexes.map((i) => [i.name, i]));
    expect(byName.events_tenant_time!.columns.map((c) => c.name)).toEqual([
      'tenant_id',
      'occurred_at',
    ]);
    expect(byName.events_unique_kind_qty).toMatchObject({ unique: true, primary: false });
    expect(byName.events_pkey).toMatchObject({ unique: true, primary: true });
    expect(byName.events_partial!.predicate).toMatch(/kind = 'a'/);
    expect(s.hypopgInstalled).toBe(false); // the scratch database has no HypoPG; the shadow does
  });

  it('duplicates are skipped, prefix-redundant indexes become drop candidates; the unique index and the primary key are never dropped', async () => {
    const s = await snapshot();
    const q1 = await stmt('SELECT id FROM events WHERE tenant_id = $1');
    const q2 = await stmt('SELECT id FROM events WHERE tenant_id = $1 AND occurred_at >= $2');
    const r = await generateCandidates({
      statements: [{ statement: q1 }, { statement: q2 }],
      snapshot: s,
    });
    // both statements are already served by existing indexes
    expect(
      r.candidates.filter(
        (c) => c.kind === 'create_index' && !(c as SqlCandidate).index!.include.length,
      ),
    ).toEqual([]);
    expect(
      r.skipped.filter((x) => x.reason === 'covered_by_existing_index').length,
    ).toBeGreaterThanOrEqual(2);
    const drops = r.candidates.filter((c): c is SqlCandidate => c.kind === 'drop_redundant_index');
    expect(drops.map((d) => d.index!.indexName).sort()).toEqual([
      'events_tenant',
      'events_tenant_time_copy',
    ]);
    for (const d of drops) {
      expect(d.upSql).toMatch(/^DROP INDEX CONCURRENTLY IF EXISTS "public"\."events_/);
      expect(d.downSql).toMatch(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS "events_/);
    }
  });

  it('a column nobody indexes gets a candidate, with the variants', async () => {
    const s = await snapshot();
    const q = await stmt('SELECT id, qty FROM events WHERE qty = $1 AND kind = $2');
    const r = await generateCandidates({ statements: [{ statement: q }], snapshot: s });
    const keys = r.candidates
      .filter((c): c is SqlCandidate => c.kind === 'create_index')
      .map((c) => c.upSql);
    expect(keys.some((k) => k.endsWith('USING btree ("qty", "kind")'))).toBe(true);
  });
});

describe('hostile identifiers: the generated SQL is valid and inert', () => {
  const NEEDS_EXACT = new Set(['newlines']); // the schema tool removes line breaks from names

  /** generate for one statement, apply the up on the real database, check what was built, apply the down */
  async function buildAndCheck(
    snap: SchemaSnapshot,
    h: { table: string; column: string },
  ): Promise<SqlCandidate> {
    const t = quoteIdent(h.table);
    const c = quoteIdent(h.column);
    const q = await stmt(`SELECT id FROM ${t} WHERE ${c} = $1`);
    const r = await generateCandidates({ statements: [{ statement: q }], snapshot: snap });
    const cand = r.candidates.find(
      (x): x is SqlCandidate => x.kind === 'create_index' && x.index!.include.length === 0,
    )!;
    expect(cand, JSON.stringify(r.skipped)).toBeDefined();
    expect(cand.index!.table).toBe(h.table);
    expect(cand.index!.key.map((k) => k.name)).toEqual([h.column]);
    // the generated index NAME is plain whatever the names are
    expect(cand.index!.indexName).toMatch(/^ll_[a-z0-9_]+$/);
    expect(Buffer.byteLength(cand.index!.indexName)).toBeLessThanOrEqual(MAX_IDENTIFIER_BYTES);
    await admin(db.name, async (a) => {
      for (const sql of cand.upStatements) await a.query(sql);
      const created = await a.query<{ attname: string; relname: string }>(
        `SELECT a.attname, c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
          WHERE i.indexrelid = to_regclass($1)`,
        [quoteQualified('public', cand.index!.indexName)],
      );
      expect(created.rows).toEqual([{ attname: h.column, relname: h.table }]);
      expect((await a.query('SELECT count(*)::int AS n FROM victim')).rows[0]!.n).toBe(3);
      for (const sql of cand.downStatements) await a.query(sql);
      expect(
        (
          await a.query('SELECT to_regclass($1) AS r', [
            quoteQualified('public', cand.index!.indexName),
          ])
        ).rows[0]!.r,
      ).toBeNull();
      expect((await a.query('SELECT count(*)::int AS n FROM victim')).rows[0]!.n).toBe(3);
    });
    return cand;
  }

  for (const [label, h] of Object.entries(HOSTILE)) {
    it(`through the schema tool, a table and a column named with ${label}`, async () => {
      const s = await snapshot();
      if (!NEEDS_EXACT.has(label)) {
        expect(s.tables.find((t) => t.name === h.table)!.namesVerified).toBe(true);
        await buildAndCheck(s, h);
        return;
      }
      // the tool shows "two lines" for "two\nlines": SQL built from that would name another object, so nothing is generated
      expect(s.tables.find((t) => t.name === h.table)).toBeUndefined();
      const q = await stmt(
        `SELECT id FROM ${quoteIdent(h.table)} WHERE ${quoteIdent(h.column)} = $1`,
      );
      const r = await generateCandidates({ statements: [{ statement: q }], snapshot: s });
      expect(r.candidates.filter((c) => c.kind === 'create_index')).toEqual([]);
      expect(r.skipped.map((x) => x.reason)).toContain('table_not_found');
      await admin(db.name, async (a) => {
        expect((await a.query('SELECT count(*)::int AS n FROM victim')).rows[0]!.n).toBe(3);
      });
    });

    it(`with exact names, the same hostile table and column (${label}) give valid, inert SQL`, async () => {
      const snap = snapshotOf(
        table(h.table, { id: 'integer', [h.column]: 'integer' }, { rows: 20000 }),
      );
      await buildAndCheck(snap, h);
    });
  }

  it('a lossy name is detected against the catalog, not trusted: namesVerified is false for the table the tool altered', async () => {
    const { snapshot: raw } = await readSnapshot(
      { sourceUrl: db.readerUrl, applicationName: 'ledgerlens-test' },
      source.connect,
      { schemas: ['public'], maxTables: 100 },
    );
    const altered = raw.tables.filter((t) => t.namesVerified === false);
    expect(altered.map((t) => t.name)).toEqual(['two lines']);
  });

  it('a name of 64 bytes or more cannot exist in a database and is refused, not truncated', async () => {
    // the server's parser cuts a long identifier in a statement to 63 bytes, so only the schema snapshot can carry one
    const longSchema = 's'.repeat(70);
    const s = snapshotOf(table('events', { id: 'integer', c: 'integer' }, { schema: longSchema }));
    const q = await stmt('SELECT id FROM events WHERE c = $1');
    const r = await generateCandidates({ statements: [{ statement: q }], snapshot: s });
    expect(r.candidates.filter((c) => c.kind === 'create_index')).toEqual([]);
    const sk = r.skipped.find((x) => x.reason === 'identifier_not_representable')!;
    expect(sk).toBeDefined();
    expect(sk.detail).toMatch(/at most 63 bytes/);
    // and a long name in a statement really is cut by the parser (why one cannot come from pg_stat_statements)
    const cut = await stmt(`SELECT 1 FROM events WHERE "${'c'.repeat(70)}" = $1`);
    expect(cut.parsed!.usages[0]!.column!.name).toHaveLength(63);
  });

  it('a partial index value with quotes, a backslash, a semicolon and a newline is quoted as a literal and reads back unchanged', async () => {
    const values = ["O'Brien", "'; DROP TABLE victim; --", 'back\\slash', 'two\nlines', '日本 😀'];
    for (const v of values) {
      const tableName = `p_${Math.random().toString(36).slice(2, 8)}`;
      await admin(db.name, async (a) => {
        await a.query(`CREATE TABLE ${tableName} (id int, state text, run_at timestamptz)`);
        await a.query(
          `INSERT INTO ${tableName} SELECT g, CASE WHEN g % 100 = 0 THEN $1 ELSE 'x' END, now() FROM generate_series(1, 20000) g`,
          [v],
        );
        await a.query(`ANALYZE ${tableName}`);
      });
      const s = await snapshot();
      const q = await stmt(
        `SELECT id FROM ${tableName} WHERE state = $1 AND run_at <= $2 ORDER BY run_at LIMIT $3`,
      );
      const set = {
        id: 's',
        provenance: 'user-supplied' as const,
        confidence: 'high' as const,
        notes: [],
        validation: { status: 'ok' as const },
        params: [
          {
            index: 1,
            value: v,
            isArray: false,
            provenance: 'user-supplied' as const,
            origin: 'user' as const,
            structural: false,
            column: null,
          },
          {
            index: 2,
            value: '2030-01-01',
            isArray: false,
            provenance: 'user-supplied' as const,
            origin: 'user' as const,
            structural: false,
            column: null,
          },
          {
            index: 3,
            value: '10',
            isArray: false,
            provenance: 'user-supplied' as const,
            origin: 'user' as const,
            structural: false,
            column: null,
          },
        ],
      };
      const stats = await withSource(source.connect, async (c) => {
        const tab = (await readTable(c, { schema: null, name: tableName, alias: null }))!;
        return readColumnStats(c, tab, ['state']);
      });
      const r = await generateCandidates({
        statements: [
          {
            statement: q,
            bindings: {
              queryId: q.queryId,
              queryHash: q.queryHash,
              status: 'bound',
              unverifiable: null,
              sets: [set],
            },
          },
        ],
        snapshot: s,
        columnStats: (_s, t, c) => (t === tableName ? stats.get(c) : undefined),
      });
      const partial = r.candidates.find(
        (x): x is SqlCandidate => x.kind === 'create_index' && !!x.index!.partial,
      )!;
      expect(partial, `${v}: ${JSON.stringify(r.skipped)}`).toBeDefined();
      expect(partial.upSql).toContain(quoteLiteral(v));
      await admin(db.name, async (a) => {
        for (const sql of partial.upStatements) await a.query(sql);
        const def = await a.query<{ pred: string }>(
          `SELECT pg_get_expr(indpred, indrelid) AS pred FROM pg_index WHERE indexrelid = to_regclass($1)`,
          [quoteQualified('public', partial.index!.indexName)],
        );
        // the server's own reading of the predicate: the same constant, nothing else
        const matches = await a.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${tableName} WHERE state = $1`,
          [v],
        );
        expect(matches.rows[0]!.n).toBe(200);
        expect(def.rows[0]!.pred).toMatch(/^\(state = /);
        expect((await a.query('SELECT count(*)::int AS n FROM victim')).rows[0]!.n).toBe(3);
        for (const sql of partial.downStatements) await a.query(sql);
      });
    }
  });
});

void (null as unknown as pg.Client);
void (null as unknown as Candidate);
