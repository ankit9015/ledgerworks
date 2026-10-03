import { describe, expect, it } from 'vitest';
import { assertReadOnlySql } from './sql.js';
import { DEFAULT_RULE, hashSelect, planFull, planSampling } from './sampling.js';
import type { Catalog, CatalogRelation } from './source.js';
import { parseManifest } from './manifest.js';

function rel(oid: number, name: string, extra: Partial<CatalogRelation> = {}): CatalogRelation {
  return {
    oid,
    schema: 'public',
    name,
    relkind: 'r',
    isPartition: false,
    parentOid: null,
    isInheritanceParent: false,
    columns: ['id'],
    bytes: 0,
    estRows: 0,
    ...extra,
  };
}

// tenants <- memberships -> users ; tenants <- events (partitioned: parent 4, partitions 5 and 6)
// tenants <- notes <- note_items (two hops) ; countries (isolated lookup) ; audit (self reference only)
const catalog: Catalog = {
  relations: [
    rel(1, 'tenants'),
    rel(2, 'users'),
    rel(3, 'memberships'),
    rel(4, 'events', { relkind: 'p' }),
    rel(5, 'events_a', { isPartition: true, parentOid: 4 }),
    rel(6, 'events_b', { isPartition: true, parentOid: 4 }),
    rel(7, 'notes'),
    rel(8, 'note_items'),
    rel(9, 'countries'),
    rel(10, 'audit'),
  ],
  primaryKeys: new Map([
    [1, ['id']],
    [2, ['id']],
    [3, ['tenant_id', 'user_id']],
    [4, ['id']],
    [7, ['id']],
    [8, ['id']],
    [9, ['code']],
    [10, ['id']],
  ]),
  fks: [
    { childOid: 3, parentOid: 1, childCols: ['tenant_id'], parentCols: ['id'] },
    { childOid: 3, parentOid: 2, childCols: ['user_id'], parentCols: ['id'] },
    { childOid: 4, parentOid: 1, childCols: ['tenant_id'], parentCols: ['id'] },
    { childOid: 5, parentOid: 1, childCols: ['tenant_id'], parentCols: ['id'] }, // partition copy of the FK
    { childOid: 7, parentOid: 1, childCols: ['tenant_id'], parentCols: ['id'] },
    { childOid: 8, parentOid: 7, childCols: ['note_id'], parentCols: ['id'] },
    { childOid: 10, parentOid: 10, childCols: ['parent_id'], parentCols: ['id'] },
  ],
};

const rule = { ...DEFAULT_RULE, rootTable: 'public.tenants', ratio: 0.25, seed: 7 };

describe('planSampling', () => {
  const plan = planSampling(catalog, rule);
  const by = Object.fromEntries(plan.map((p) => [p.table.key, p]));

  it('plans one entry per logical table (partitions fold into their parent)', () => {
    expect(plan.map((p) => p.table.key).sort()).toEqual([
      'public.audit',
      'public.countries',
      'public.events',
      'public.memberships',
      'public.note_items',
      'public.notes',
      'public.tenants',
      'public.users',
    ]);
  });

  it('samples the root by a hash of its key and children by their foreign key to it', () => {
    expect(by['public.tenants']!.selection).toBe('root');
    expect(by['public.tenants']!.predicate).toContain('hashtextextended((t."id")::text, 7)');
    expect(by['public.tenants']!.predicate).toContain('< 250000');
    expect(by['public.events']!.selection).toBe('child');
    expect(by['public.events']!.predicate).toContain('t."tenant_id" IS NULL OR');
  });

  it('keeps a child of a child only when its parent row is kept', () => {
    const p = by['public.note_items']!;
    expect(p.selection).toBe('child');
    expect(p.predicate).toContain('EXISTS (SELECT 1 FROM "public"."notes"');
  });

  it('filters a table with several parents by the covered ones; the other parent follows it', () => {
    const m = by['public.memberships']!;
    expect(m.selection).toBe('child');
    expect(m.predicate).toContain('hashtextextended((t."tenant_id")::text');
    expect(m.predicate).not.toContain('"users"'); // users is not a covered parent: it is pulled in by memberships
  });

  it('requires every covered parent to hold (AND) when a table has two of them', () => {
    const two: Catalog = {
      ...catalog,
      fks: [
        ...catalog.fks,
        { childOid: 8, parentOid: 1, childCols: ['tenant_id'], parentCols: ['id'] },
      ],
    };
    const p = planSampling(two, rule).find((x) => x.table.key === 'public.note_items')!;
    expect(p.predicate).toContain('EXISTS (SELECT 1 FROM "public"."notes"');
    expect(p.predicate).toContain(') AND (');
    expect(p.predicate).toContain('hashtextextended((t."tenant_id")::text');
  });

  it('keeps referenced parents (users) only when a kept membership points at them', () => {
    const p = by['public.users']!;
    expect(p.selection).toBe('referenced');
    expect(p.predicate).toContain('EXISTS (SELECT 1 FROM "public"."memberships"');
  });

  it('copies isolated tables completely by default and ignores self references', () => {
    expect(by['public.countries']!.selection).toBe('isolated-full');
    expect(by['public.countries']!.predicate).toBeNull();
    expect(by['public.audit']!.selection).toBe('isolated-full');
  });

  it('honours isolated=empty, fullTables and uncovered modes', () => {
    const e = Object.fromEntries(
      planSampling(catalog, { ...rule, isolated: 'empty' }).map((p) => [p.table.key, p]),
    );
    expect(e['public.countries']!.predicate).toBe('false');
    const f = Object.fromEntries(
      planSampling(catalog, { ...rule, fullTables: ['public.notes'] }).map((p) => [p.table.key, p]),
    );
    expect(f['public.notes']!.selection).toBe('full-override');
    expect(f['public.notes']!.predicate).toBeNull();
    const u = Object.fromEntries(
      planSampling(catalog, { ...rule, uncovered: 'full' }).map((p) => [p.table.key, p]),
    );
    expect(u['public.users']!.predicate).toBeNull();
  });

  it('is deterministic and rejects unknown tables', () => {
    expect(planSampling(catalog, rule)).toEqual(plan);
    expect(() => planSampling(catalog, { ...rule, rootTable: 'public.nope' })).toThrow(/not found/);
    expect(() => planSampling(catalog, { ...rule, fullTables: ['public.nope'] })).toThrow(
      /not found/,
    );
  });

  it('full plan has no filters', () => {
    expect(planFull(catalog).every((p) => p.predicate === null && p.selection === 'all')).toBe(
      true,
    );
  });

  it('hashSelect threshold follows the ratio', () => {
    expect(hashSelect('k', { seed: 1, ratio: 1 })).toContain('< 1000000');
    expect(hashSelect('k', { seed: 1, ratio: 0.001 })).toContain('< 1000');
  });
});

describe('assertReadOnlySql (source guard)', () => {
  it.each([
    'SELECT 1',
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    "SET TRANSACTION SNAPSHOT '00000003-0000001B-1'",
    'COPY (SELECT "a" FROM ONLY "public"."t" t) TO STDOUT',
    "SELECT * FROM t WHERE note = 'drop table x; delete from y'",
    'SELECT updated_at, created_by, "update" FROM t',
    'ROLLBACK',
  ])('allows %s', (sql) => {
    expect(() => assertReadOnlySql(sql)).not.toThrow();
  });
  it.each([
    'INSERT INTO t VALUES (1)',
    'UPDATE t SET a = 1',
    'DELETE FROM t',
    'TRUNCATE t',
    'CREATE TABLE x (a int)',
    'DROP TABLE t',
    'ALTER TABLE t ADD COLUMN a int',
    "SELECT nextval('s')",
    "SELECT setval('s', 1)",
    'SELECT * FROM t FOR UPDATE',
    'WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x',
    'COPY t FROM STDIN',
    'VACUUM t',
    'GRANT ALL ON t TO public',
  ])('refuses %s', (sql) => {
    expect(() => assertReadOnlySql(sql)).toThrow(/Refusing/);
  });
});

describe('manifest schema', () => {
  it('rejects a manifest that carries a connection string with a password', () => {
    expect(() => parseManifest({})).toThrow();
  });
});
