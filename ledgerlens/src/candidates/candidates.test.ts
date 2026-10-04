import { describe, expect, it } from 'vitest';
import { analyzePlan } from '../analyzer/analyze.js';
import { parsePlan } from '../analyzer/plan.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { index, snapshotOf, stmt, table } from '../testing/fixtures.js';
import type { BindingSet, StatementBindings } from '../workload/bindings.js';
import { generateCandidates } from './generate.js';
import type { ColumnStatsLookup } from './generate.js';
import { makeIndexName } from './sqlgen.js';
import type { Candidate, SqlCandidate } from './types.js';
import { MAX_IDENTIFIER_BYTES } from '../sql/ident.js';

const events = table('events', {
  id: 'bigint',
  tenant_id: 'uuid',
  kind: 'text',
  qty: 'integer',
  created_at: 'timestamp with time zone',
  occurred_at: 'timestamp with time zone',
  note: 'text',
  meta: 'jsonb',
});
const base = snapshotOf(events, table('tiny', { id: 'integer', label: 'text' }, { rows: 500 }));

const creates = (cs: Candidate[]): SqlCandidate[] =>
  cs.filter((c): c is SqlCandidate => c.kind === 'create_index');
/** the plain variants: no INCLUDE columns, not partial */
const plains = (cs: Candidate[]): SqlCandidate[] =>
  creates(cs).filter((c) => c.index!.include.length === 0 && !c.index!.partial);
/** key columns of the plain (non-variant) create_index candidate, as written: "a, b DESC" */
const keyOf = (c: SqlCandidate): string =>
  c.index!.key.map((k) => k.name + (k.desc ? ' DESC' : '')).join(', ');

async function gen(
  sql: string,
  snap = base,
  extra: Parameters<typeof generateCandidates>[0]['statements'][number] extends infer S
    ? Partial<S>
    : never = {},
) {
  return generateCandidates({
    statements: [{ statement: await stmt(sql), ...extra }],
    snapshot: snap,
  });
}

describe('index rules: column order for six query shapes', () => {
  it('equality only', async () => {
    const { candidates } = await gen('SELECT id FROM events WHERE tenant_id = $1 AND kind = $2');
    const c = plains(candidates);
    expect(c).toHaveLength(1);
    expect(creates(candidates)).toHaveLength(2); // and the covering variant: the statement also reads id
    expect(keyOf(c[0]!)).toBe('tenant_id, kind');
    expect(c[0]!.upSql).toMatch(
      /^CREATE INDEX CONCURRENTLY IF NOT EXISTS "ll_events_tenant_id_kind_[0-9a-f]{8}" ON "public"."events" USING btree \("tenant_id", "kind"\)$/,
    );
    expect(c[0]!.downSql).toMatch(
      /^DROP INDEX CONCURRENTLY IF EXISTS "public"."ll_events_tenant_id_kind_[0-9a-f]{8}"$/,
    );
    expect(c[0]!.noTransaction).toBe(true);
  });

  it('equality plus range: equality first, then the range column', async () => {
    const { candidates } = await gen(
      'SELECT id FROM events WHERE occurred_at >= $2 AND tenant_id = $1 AND occurred_at < $3',
    );
    expect(keyOf(plains(candidates)[0]!)).toBe('tenant_id, occurred_at');
  });

  it('equality plus sort: the sort column follows the equality column; a mixed direction stays explicit', async () => {
    const one = await gen(
      'SELECT id FROM events WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2',
    );
    expect(keyOf(plains(one.candidates)[0]!)).toBe('tenant_id, created_at');
    const mixed = await gen(
      'SELECT id FROM events WHERE tenant_id = $1 ORDER BY created_at DESC, id ASC LIMIT $2',
    );
    expect(keyOf(plains(mixed.candidates)[0]!)).toBe('tenant_id, created_at, id DESC'); // (ASC, DESC) serves (DESC, ASC) scanned backward
  });

  it('range plus sort on the same column: one column serves both; sort columns after it are appended', async () => {
    const { candidates } = await gen(
      'SELECT id FROM events WHERE occurred_at > $1 ORDER BY occurred_at, id LIMIT $2',
    );
    expect(keyOf(plains(candidates)[0]!)).toBe('occurred_at, id');
  });

  it('range plus sort on a DIFFERENT column: only the range column, and the risk note says the order is not served', async () => {
    const { candidates } = await gen(
      'SELECT id FROM events WHERE qty > $1 ORDER BY occurred_at LIMIT $2',
    );
    const c = plains(candidates)[0]!;
    expect(keyOf(c)).toBe('qty');
    expect(c.riskNotes.join(' ')).toMatch(/ORDER BY is not served/);
  });

  it('partial index opportunity: a constant that is rare, from the binding sets and the column statistics', async () => {
    const jobs = table('jobs', { id: 'bigint', state: 'text', run_at: 'timestamp with time zone' });
    const sql = 'SELECT id FROM jobs WHERE state = $1 AND run_at <= $2 ORDER BY run_at LIMIT $3';
    const s = await stmt(sql);
    const set = (v: string): BindingSet => ({
      id: 'x',
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
          value: '2026-01-01',
          isArray: false,
          provenance: 'user-supplied',
          origin: 'user',
          structural: false,
          column: null,
        },
        {
          index: 3,
          value: '50',
          isArray: false,
          provenance: 'user-supplied',
          origin: 'user',
          structural: false,
          column: null,
        },
      ],
    });
    const bindings = (v1: string, v2: string): StatementBindings => ({
      queryId: s.queryId,
      queryHash: s.queryHash,
      status: 'bound',
      unverifiable: null,
      sets: [set(v1), set(v2)],
    });
    const stats: ColumnStatsLookup = (_s, t, c) =>
      t === 'jobs' && c === 'state'
        ? {
            column: 'state',
            inherited: false,
            nullFrac: 0,
            nDistinct: 4,
            histogram: [],
            mcv: [
              { value: 'done', freq: 0.93 },
              { value: 'pending', freq: 0.03 },
              { value: 'failed', freq: 0.02 },
            ],
          }
        : undefined;
    const run = (b: StatementBindings, st = stats) =>
      generateCandidates({
        statements: [{ statement: s, bindings: b }],
        snapshot: snapshotOf(jobs),
        columnStats: st,
      });
    const r = await run(bindings('pending', 'pending'));
    const all = creates(r.candidates);
    const partial = all.find((c) => c.index!.partial)!;
    expect(partial).toBeDefined();
    expect(keyOf(partial)).toBe('run_at');
    expect(partial.index!.partial).toEqual({ column: 'state', value: 'pending' });
    expect(partial.upSql).toMatch(/USING btree \("run_at"\) WHERE "state" = 'pending'$/);
    expect(partial.variantOf).toBe(plains(r.candidates)[0]!.id);
    expect(keyOf(plains(r.candidates)[0]!)).toBe('state, run_at');
    // not constant in practice (two different values): no partial index
    expect(
      creates((await run(bindings('pending', 'done'))).candidates).some((c) => c.index!.partial),
    ).toBe(false);
    // a common value (93% of the rows): no partial index
    expect(
      creates((await run(bindings('done', 'done'))).candidates).some((c) => c.index!.partial),
    ).toBe(false);
    // no statistics: not guessed, listed
    const none = await run(bindings('pending', 'pending'), () => undefined);
    expect(creates(none.candidates).some((c) => c.index!.partial)).toBe(false);
    expect(none.skipped.some((x) => x.reason === 'partial_needs_statistics')).toBe(true);
  });

  it('covering opportunity: the other columns the statement reads become INCLUDE columns (small fixed-width types only)', async () => {
    const r = await gen(
      'SELECT tenant_id, occurred_at, qty FROM events WHERE tenant_id = $1 AND occurred_at >= $2',
    );
    const all = creates(r.candidates);
    const plain = all.find((c) => c.index!.include.length === 0)!;
    const covering = all.find((c) => c.index!.include.length > 0)!;
    expect(keyOf(covering)).toBe('tenant_id, occurred_at');
    expect(covering.index!.include).toEqual(['qty']);
    expect(covering.upSql).toMatch(/\("tenant_id", "occurred_at"\) INCLUDE \("qty"\)$/);
    expect(covering.variantOf).toBe(plain.id);
    // a wide column (text, jsonb) or SELECT * is never included
    const wide = await gen('SELECT tenant_id, note FROM events WHERE tenant_id = $1');
    expect(creates(wide.candidates).every((c) => c.index!.include.length === 0)).toBe(true);
    const star = await gen('SELECT * FROM events WHERE tenant_id = $1');
    expect(creates(star.candidates).every((c) => c.index!.include.length === 0)).toBe(true);
  });

  it('a join column that is not a parameter still gets an index (the inner side of a join)', async () => {
    const orders = table('orders', { id: 'integer', customer_id: 'integer', total: 'integer' });
    const customers = table('customers', { id: 'integer', name: 'text' });
    const r = await gen(
      'SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.name = $1',
      snapshotOf(orders, customers),
    );
    expect(
      plains(r.candidates)
        .map((c) => `${c.table.name}(${keyOf(c)})`)
        .sort(),
    ).toEqual(['customers(name, id)', 'orders(customer_id)']);
  });

  it('tiny tables get no index and the skip is listed; so are statements with nothing to index', async () => {
    const t = await gen('SELECT id FROM tiny WHERE label = $1');
    expect(creates(t.candidates)).toEqual([]);
    expect(t.skipped.map((s) => s.reason)).toContain('tiny_table');
    const n = await gen('SELECT count(*) FROM events');
    expect(n.skipped.map((s) => s.reason)).toContain('no_indexable_predicate');
  });

  it('the same candidate from two statements is one candidate that targets both', async () => {
    const a = await stmt('SELECT id FROM events WHERE tenant_id = $1');
    const b = await stmt('SELECT count(*) FROM events WHERE tenant_id = $1');
    const r = await generateCandidates({
      statements: [{ statement: a }, { statement: b }],
      snapshot: base,
    });
    const c = creates(r.candidates).filter((x) => x.index!.include.length === 0);
    expect(c).toHaveLength(1);
    expect(c[0]!.targetedStatements.sort()).toEqual([a.queryHash, b.queryHash].sort());
  });

  it('UPDATE and DELETE are indexed by their WHERE; INSERT is not', async () => {
    const u = await gen('UPDATE events SET qty = $2 WHERE tenant_id = $1 AND kind = $3');
    expect(keyOf(plains(u.candidates)[0]!)).toBe('tenant_id, kind');
    const d = await gen('DELETE FROM events WHERE occurred_at < $1');
    expect(keyOf(plains(d.candidates)[0]!)).toBe('occurred_at');
    const i = await gen('INSERT INTO events (tenant_id, kind) VALUES ($1, $2)');
    expect(i.candidates).toEqual([]);
  });
});

describe('duplicates and prefix-redundant indexes', () => {
  const withIdx = (...ix: ReturnType<typeof index>[]) => snapshotOf({ ...events, indexes: ix });

  it('an existing index that starts with the wanted columns makes the candidate a listed skip, not a duplicate', async () => {
    const r = await gen(
      'SELECT id FROM events WHERE tenant_id = $1 AND occurred_at >= $2',
      withIdx(index('events_t_o', ['tenant_id', 'occurred_at', 'id'])),
    );
    expect(creates(r.candidates).filter((c) => c.index!.include.length === 0)).toEqual([]);
    expect(
      r.skipped.find((s) => s.reason === 'covered_by_existing_index')!.subject.$untrusted,
    ).toMatch(/events_t_o/);
  });

  it('an existing index that is only a PREFIX of the wanted key does not cover it: the longer index is proposed', async () => {
    const r = await gen(
      'SELECT id FROM events WHERE tenant_id = $1 AND occurred_at >= $2',
      withIdx(index('events_t', ['tenant_id'])),
    );
    expect(keyOf(plains(r.candidates).find((c) => c.index!.include.length === 0)!)).toBe(
      'tenant_id, occurred_at',
    );
  });

  it('an existing index that serves the filter and the leading ORDER BY column leaves only a tie-break: no new index, and the reason says so', async () => {
    const sql =
      'SELECT id FROM events WHERE tenant_id = $1 AND occurred_at >= $2 ORDER BY occurred_at DESC, id DESC LIMIT $3';
    const served = await gen(sql, withIdx(index('events_t_o', ['tenant_id', 'occurred_at'])));
    expect(plains(served.candidates)).toEqual([]);
    expect(served.skipped.find((s) => s.reason === 'covered_by_existing_index')!.detail).toMatch(
      /incremental sort/,
    );
    // without the range column the first sort column is what the index must hold
    const eqSort =
      'SELECT id FROM events WHERE tenant_id = $1 ORDER BY created_at DESC, id LIMIT $2';
    expect(
      plains((await gen(eqSort, withIdx(index('i', ['tenant_id', 'created_at'])))).candidates),
    ).toEqual([]);
    expect(plains((await gen(eqSort, withIdx(index('i', ['tenant_id'])))).candidates)).toHaveLength(
      1,
    );
  });

  it('an invalid index, another access method or a partial index does not count as covering a full one', async () => {
    const sql = 'SELECT id FROM events WHERE tenant_id = $1';
    for (const ix of [
      index('i1', ['tenant_id'], { valid: false }),
      index('i2', ['tenant_id'], { predicate: "(kind = 'x'::text)" }),
      { ...index('i3', ['tenant_id']), method: 'hash' },
    ])
      expect(creates((await gen(sql, withIdx(ix))).candidates).length).toBeGreaterThan(0);
  });

  it('prefix-redundant indexes of the schema become drop candidates with a recreate down SQL; unique and primary ones never do', async () => {
    const snap = withIdx(
      index('events_pkey', ['id'], { primary: true, unique: true }),
      index('events_t', ['tenant_id']),
      index('events_t_o', ['tenant_id', 'occurred_at']),
      index('events_t_o_dup', ['tenant_id', 'occurred_at']),
      index('events_u', ['kind'], { unique: true }),
      index('events_k', ['kind', 'qty']),
    );
    const { candidates } = await generateCandidates({ statements: [], snapshot: snap });
    const drops = candidates.filter((c): c is SqlCandidate => c.kind === 'drop_redundant_index');
    expect(drops.map((d) => d.index!.indexName).sort()).toEqual(['events_t', 'events_t_o_dup']); // not events_t_o (kept), not events_u (unique), not the pkey
    const d = drops.find((x) => x.index!.indexName === 'events_t')!;
    expect(d.upSql).toBe('DROP INDEX CONCURRENTLY IF EXISTS "public"."events_t"');
    expect(d.downSql).toBe(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "events_t" ON "public"."events" USING btree ("tenant_id")',
    );
    expect(d.noTransaction).toBe(true);
    expect(d.subjects.map((s) => s.$untrusted)).toContain('kept: events_t_o');
  });

  it('a different predicate, include or direction pattern is not redundant', async () => {
    const snap = withIdx(
      index('a', ['tenant_id']),
      index('b', ['tenant_id', 'qty'], { predicate: "(kind = 'x'::text)" }), // partial: does not make a redundant
      index('c', ['qty']),
      index('d', ['qty desc', 'id']), // c is a prefix of d only in name, directions differ
    );
    const { candidates } = await generateCandidates({ statements: [], snapshot: snap });
    expect(candidates.filter((c) => c.kind === 'drop_redundant_index')).toEqual([]);
  });
});

describe('partitioned tables', () => {
  const parts = Array.from({ length: 6 }, (_, i) => `events_p${i}`);
  const ptable = table(
    'events',
    { id: 'bigint', tenant_id: 'uuid', occurred_at: 'timestamp with time zone' },
    { partitions: parts, partitionKey: ['occurred_at'] },
  );

  it('uses the documented procedure: ON ONLY the parent, one CONCURRENTLY index per partition, ATTACH, and a down that drops the parent index', async () => {
    const r = await gen('SELECT id FROM events WHERE tenant_id = $1', snapshotOf(ptable));
    const c = creates(r.candidates)[0]!;
    expect(c.upStatements).toHaveLength(1 + parts.length * 2);
    expect(c.upStatements[0]).toMatch(
      /^CREATE INDEX IF NOT EXISTS ".*" ON ONLY "public"."events" /,
    );
    expect(c.upStatements.filter((s) => s.startsWith('CREATE INDEX CONCURRENTLY'))).toHaveLength(
      parts.length,
    );
    expect(c.upStatements.filter((s) => s.startsWith('ALTER INDEX'))).toHaveLength(parts.length);
    expect(
      c.upStatements.some((s) => /CONCURRENTLY IF NOT EXISTS ".*" ON "public"."events_p3"/.test(s)),
    ).toBe(true);
    expect(c.downStatements).toHaveLength(1);
    expect(c.downStatements[0]).toMatch(/^DROP INDEX IF EXISTS "public"\./);
    expect(c.downSql).not.toMatch(/CONCURRENTLY/); // not allowed on a partitioned index
    expect(c.riskNotes.join(' ')).toMatch(/one concurrent index per partition/);
  });

  it('refuses when the partition list is not complete', async () => {
    const r = await gen(
      'SELECT id FROM events WHERE tenant_id = $1',
      snapshotOf({ ...ptable, partitionsTruncated: true }),
    );
    expect(creates(r.candidates)).toEqual([]);
    expect(r.skipped.map((s) => s.reason)).toContain('partition_list_incomplete');
  });
});

describe('rewrite suggestions are advice only', () => {
  it('ORDER BY an output alias that hides the column (the Ledgerline E1 problem), a function on a column, and OFFSET', async () => {
    const alias = await gen(
      `SELECT id, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY') AS occurred_at FROM events WHERE tenant_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT $2`,
    );
    const a = alias.candidates.find((c) => c.kind === 'rewrite_suggestion')!;
    expect(a).toMatchObject({
      kind: 'rewrite_suggestion',
      advice: 'qualify_order_by_alias',
      upSql: null,
      downSql: null,
    });
    expect(a.rationale).toMatch(/Qualify the column/);
    const fn = await gen('SELECT id FROM events WHERE lower(kind) = $1');
    expect(
      fn.candidates.some(
        (c) => c.kind === 'rewrite_suggestion' && c.advice === 'function_on_column',
      ),
    ).toBe(true);
    expect(creates(fn.candidates)).toEqual([]); // no plain-column index is proposed for a predicate on lower(kind)
    const off = await gen(
      'SELECT id FROM events WHERE tenant_id = $1 ORDER BY created_at LIMIT $2 OFFSET $3',
    );
    expect(
      off.candidates.some(
        (c) => c.kind === 'rewrite_suggestion' && c.advice === 'offset_pagination',
      ),
    ).toBe(true);
    // the advice never contains a name from the database in its sentence; names are in `subjects`, marked untrusted
    for (const c of [a]) expect(c.subjects[0]).toHaveProperty('$untrusted');
  });
});

describe('statistics candidates come from plan findings', () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/plans');
  const load = (n: string) => JSON.parse(readFileSync(path.join(dir, `${n}.json`), 'utf8'));

  it('stale statistics give ANALYZE with a down that is an explicit no-op', async () => {
    const f = load('stale_statistics');
    const findings = await analyzePlan(parsePlan(f.plan), {
      snapshot: f.context,
      now: new Date(f.producedBy.capturedAt),
    });
    const s = await stmt(f.sql);
    const r = await generateCandidates(
      { statements: [{ statement: s, findings }], snapshot: f.context },
      { minTableRows: 1 },
    );
    const a = r.candidates.find((c): c is SqlCandidate => c.kind === 'analyze_or_stats_target')!;
    expect(a.upSql).toBe('ANALYZE "ll_fixtures"."stale"');
    expect(a.downSql).toMatch(/^--/);
    expect(a.triggeredBy[0]!.findingKind).toBe('stale_statistics');
  });
});

describe('index names', () => {
  it('are plain, at most 63 bytes, deterministic, and different for different columns even after sanitising', () => {
    const long = makeIndexName({
      schema: 'public',
      table: 'T'.repeat(60) + 'éé',
      key: ['a"; DROP TABLE x; --', 'B c'],
      include: [],
    });
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(MAX_IDENTIFIER_BYTES);
    expect(long).toMatch(/^[a-z0-9_]+$/);
    expect(makeIndexName({ schema: 's', table: 't', key: ['a'], include: [] })).toBe(
      makeIndexName({ schema: 's', table: 't', key: ['a'], include: [] }),
    );
    expect(makeIndexName({ schema: 's', table: 't', key: ['a-b'], include: [] })).not.toBe(
      makeIndexName({ schema: 's', table: 't', key: ['a_b'], include: [] }),
    );
    expect(makeIndexName({ schema: 's', table: 't', key: ['a'], include: [] }, '_p12')).toMatch(
      /_p12$/,
    );
  });
});
