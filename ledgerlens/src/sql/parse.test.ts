import { describe, expect, it } from 'vitest';
import { SqlParseError, parseStatement, type ParamUsage } from './parse.js';

const roles = (us: ParamUsage[]): string[] =>
  [...us]
    .sort((a, b) => a.param - b.param)
    .map(
      (u) =>
        `$${u.param}:${u.role}:${u.column ? `${u.column.qualifier ? u.column.qualifier + '.' : ''}${u.column.name}` : '-'}`,
    );

describe('parseStatement (the real PostgreSQL grammar)', () => {
  it('finds the column of equality, range, BETWEEN, IN, ANY, LIKE, LIMIT and OFFSET parameters', async () => {
    const p = await parseStatement(
      `SELECT id FROM usage_events
        WHERE tenant_id = $1 AND occurred_at >= $2 AND occurred_at < $3
          AND kind IN ($4, $5) AND id = ANY($6) AND name LIKE $7 AND qty BETWEEN $8 AND $9
        ORDER BY occurred_at DESC LIMIT $10 OFFSET $11`,
    );
    expect(p.kind).toBe('select');
    expect(p.paramCount).toBe(11);
    expect(roles(p.usages)).toEqual([
      '$1:equality:tenant_id',
      '$2:range_lower:occurred_at',
      '$3:range_upper:occurred_at',
      '$4:in_list:kind',
      '$5:in_list:kind',
      '$6:any_array:id',
      '$7:like:name',
      '$8:between_lower:qty',
      '$9:between_upper:qty',
      '$10:limit:-',
      '$11:offset:-',
    ]);
    expect(p.tables).toEqual([{ schema: null, name: 'usage_events', alias: null }]);
  });

  it('understands swapped operands, casts, and a function around the column', async () => {
    const p = await parseStatement(
      'SELECT 1 FROM t WHERE $1 < created_at AND lower(email) = lower($2) AND id = $3::uuid AND n <> $4',
    );
    expect(roles(p.usages)).toEqual(
      [
        '$1:range_lower:created_at', // $1 < col is col > $1
        '$2:equality:email',
        '$3:equality:id',
        '$4:inequality:n',
      ].map((x) => x),
    );
    const byParam = (n: number) => p.usages.find((u) => u.param === n)!;
    // "$1 < created_at" is the same as "created_at > $1": a lower bound
    expect(byParam(1).operator).toBe('>');
    expect(byParam(2).column?.viaFunction).toBe('lower');
    expect(byParam(3).castType).toBe('uuid');
  });

  it('resolves aliases and joins to the table list, and keeps the qualifier', async () => {
    const p = await parseStatement(
      `SELECT e.id FROM usage_events e JOIN tenants t ON t.id = e.tenant_id AND t.slug = $1
        WHERE e.occurred_at > $2`,
    );
    expect(p.tables.map((t) => `${t.name} ${t.alias}`)).toEqual(['usage_events e', 'tenants t']);
    expect(roles(p.usages)).toEqual(['$1:equality:t.slug', '$2:range_lower:e.occurred_at']);
    const u = p.usages.find((x) => x.param === 2)!;
    expect(u.scope.map((s) => s.alias)).toEqual(['e', 't']);
  });

  it('does not take a "$1" inside a string literal or a comment for a parameter (a regex would)', async () => {
    const p = await parseStatement(
      `SELECT 1 FROM t WHERE a = '$1' AND b = $1 -- $2\n AND c = '$9'`,
    );
    expect(p.paramCount).toBe(1);
    expect(roles(p.usages)).toEqual(['$1:equality:b']);
  });

  it('subqueries have their own scope and CTE names are not tables', async () => {
    const sub = await parseStatement(
      'SELECT 1 FROM a WHERE a.x IN (SELECT y FROM b WHERE b.z = $1)',
    );
    expect(sub.tables.map((t) => t.name)).toEqual(['a', 'b']);
    expect(roles(sub.usages)).toEqual(['$1:equality:b.z']);
    const cte = await parseStatement(
      'WITH recent AS (SELECT id FROM events WHERE ts > $1) SELECT * FROM recent WHERE id = $2',
    );
    expect(cte.tables.map((t) => t.name)).toEqual(['events']);
    expect(cte.hasDerivedRelations).toBe(true);
  });

  it('INSERT, UPDATE and DELETE parameters map to columns', async () => {
    const ins = await parseStatement('INSERT INTO t (a, b, c) VALUES ($1, $2, now())');
    expect(roles(ins.usages)).toEqual(['$1:insert_value:a', '$2:insert_value:b']);
    expect(ins.kind).toBe('insert');
    expect(ins.tables.map((t) => t.name)).toEqual(['t']);
    const noCols = await parseStatement('INSERT INTO t VALUES ($1, $2)');
    expect(noCols.usages.map((u) => [u.param, u.insertPosition])).toEqual([
      [1, 0],
      [2, 1],
    ]);
    const upd = await parseStatement('UPDATE t SET a = $1, b = b + $2 WHERE id = $3');
    expect(roles(upd.usages)).toEqual(['$1:update_set:a', '$2:other:b', '$3:equality:id']);
    const del = await parseStatement('DELETE FROM t WHERE id = $1 AND ts < $2');
    expect(roles(del.usages)).toEqual(['$1:equality:id', '$2:range_upper:ts']);
    const upsert = await parseStatement(
      'INSERT INTO t (id, n) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET n = $3',
    );
    expect(roles(upsert.usages)).toEqual([
      '$1:insert_value:id',
      '$2:insert_value:n',
      '$3:update_set:n',
    ]);
  });

  it('a parameter used any other way is reported as "other", never dropped', async () => {
    const p = await parseStatement(
      'SELECT coalesce($1, 0) + 1, now() - $2::interval FROM t WHERE f($3) > 1',
    );
    expect(p.usages.map((u) => [u.param, u.role]).sort()).toEqual([
      [1, 'other'],
      [2, 'other'],
      [3, 'other'],
    ]);
  });

  it('classifies statements: utility is not a workload statement; several statements are flagged', async () => {
    expect((await parseStatement('SET search_path = x')).kind).toBe('utility');
    expect((await parseStatement('COPY t FROM STDIN')).kind).toBe('utility');
    expect((await parseStatement('CREATE INDEX ON t (a)')).kind).toBe('utility');
    const two = await parseStatement('SELECT 1; SELECT 2');
    expect(two.single).toBe(false);
    expect((await parseStatement('SELECT 1')).single).toBe(true);
    expect((await parseStatement('SELECT now()')).tables).toEqual([]);
  });

  it('refuses text that is not SQL, with a typed error', async () => {
    await expect(parseStatement('SELEC 1 FRO')).rejects.toBeInstanceOf(SqlParseError);
    await expect(parseStatement("SELECT 'unterminated")).rejects.toBeInstanceOf(SqlParseError);
  });
});
