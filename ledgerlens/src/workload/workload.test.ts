import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, createScratchDb, resetStatements, type ScratchDb } from '../testing/db.js';
import {
  UserBindingsFileSchema,
  arrayLiteral,
  bindStatement,
  toQueryConfig,
  type StatementBindings,
} from './bindings.js';
import { buildWorkloadReport, renderWorkloadReport } from './report.js';
import { LEDGERLENS_MARKER, openSource, readWorkload, withSource } from './source.js';
import { validateBindings } from './validate.js';
import type { Workload, WorkloadStatement } from './types.js';

const HOSTILE = [
  "O'Brien",
  "'; DROP TABLE events; --",
  "x' OR '1'='1",
  'back\\slash',
  'two\nlines',
  'SELECT 1',
  '$1',
  '50%_off',
  '"quoted"',
  '{a,b}',
];

const SETUP = [
  `CREATE TABLE tenants (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, plan text NOT NULL)`,
  `INSERT INTO tenants SELECT ('00000000-0000-0000-0000-00000000000' || g)::uuid, 'tenant-' || g, CASE WHEN g = 1 THEN 'pro' ELSE 'free' END
     FROM generate_series(1, 5) g`,
  `CREATE TABLE events (
     id bigserial PRIMARY KEY,
     tenant_id uuid NOT NULL REFERENCES tenants (id),
     kind text NOT NULL,
     qty int NOT NULL,
     occurred_at timestamptz NOT NULL,
     note text)`,
  // skewed: tenant 1 owns 60%, kinds are skewed too, timestamps spread over a year
  `INSERT INTO events (tenant_id, kind, qty, occurred_at, note)
     SELECT ('00000000-0000-0000-0000-00000000000' || (CASE WHEN g % 10 < 6 THEN 1 ELSE 2 + g % 4 END))::uuid,
            (ARRAY['read','read','read','write','delete','admin'])[1 + g % 6],
            g % 100,
            timestamptz '2025-01-01' + (g || ' minutes')::interval,
            'note ' || g
       FROM generate_series(1, 20000) g`,
  `CREATE TABLE hostile (id serial PRIMARY KEY, name text NOT NULL)`,
  ...HOSTILE.map((v) =>
    `INSERT INTO hostile (name) SELECT $hv$${v}$hv$ FROM generate_series(1, 30)`.replace(
      '$hv$' + v + '$hv$',
      "'" + v.replaceAll("'", "''") + "'",
    ),
  ),
  `CREATE TABLE fresh (id int, label text, flag boolean)`,
  `INSERT INTO fresh SELECT g, 'l' || g, g % 2 = 0 FROM generate_series(1, 50) g`,
  `CREATE FUNCTION app_lookup(k text) RETURNS int LANGUAGE sql AS 'SELECT 1'`,
  `ANALYZE tenants; ANALYZE events; ANALYZE hostile`, // `fresh` is deliberately never analyzed
];

let db: ScratchDb;
let source: ReturnType<typeof openSource>;
beforeAll(async () => {
  db = await createScratchDb(SETUP);
  source = openSource(db.readerUrl);
  await source.ensureReadOnly();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

/** runs statements with parameters as the application would, so that pg_stat_statements records them */
async function runApp(fn: (c: pg.Client) => Promise<void>): Promise<void> {
  await admin(db.name, fn);
}

async function bindText(
  sql: string,
  o: Parameters<typeof bindStatement>[2] = {},
): Promise<StatementBindings> {
  const parsed = (await import('../sql/parse.js')).parseStatement;
  const p = await parsed(sql);
  const stmt = {
    queryId: 'q',
    queryHash: 'h'.repeat(16),
    rank: 1,
    text: sql,
    kind: p.kind,
    calls: 1,
    totalTimeMs: 1,
    meanTimeMs: 1,
    rows: 1,
    sharedBlksHit: 0,
    sharedBlksRead: 0,
    topLevel: true,
    tables: p.tables,
    paramCount: p.paramCount,
    parsed: p,
    parseError: null,
  } satisfies WorkloadStatement;
  return withSource(source.connect, (c) => bindStatement(c, stmt, o));
}

describe('workload model', () => {
  it('reads the statements of this database, excludes what is not workload and counts every exclusion by reason', async () => {
    await resetStatements(db.name);
    await runApp(async (c) => {
      for (let i = 0; i < 5; i++)
        await c.query('SELECT count(*) FROM events WHERE tenant_id = $1', [
          '00000000-0000-0000-0000-000000000001',
        ]);
      await c.query('SELECT id FROM events WHERE kind = $1 AND qty > $2 LIMIT $3', ['read', 10, 5]);
      await c.query('INSERT INTO hostile (name) VALUES ($1)', ['one']);
      await c.query('SET application_name = $$x$$');
      await c.query('CREATE INDEX tmp_idx ON hostile (name)');
      await c.query('DROP INDEX tmp_idx');
      await c.query('SELECT 1');
      await c.query('SELECT now()');
      await c.query('SELECT count(*) FROM pg_catalog.pg_class');
      await c.query('SELECT relname FROM pg_class WHERE oid = $1', [1259]);
      await c.query('SELECT calls FROM pg_stat_statements LIMIT 1');
      await c.query("SELECT app_lookup('x')");
    });
    const w = await readWorkload(source.connect);
    const ex = Object.fromEntries(w.excluded.map((e) => [e.reason, e.count]));
    expect(ex.utility_statement).toBeGreaterThanOrEqual(3); // SET, CREATE INDEX, DROP INDEX
    expect(ex.monitoring_query).toBe(1);
    expect(ex.no_user_tables).toBeGreaterThanOrEqual(4); // SELECT 1, SELECT now(), pg_class twice
    expect(ex.other_database).toBeGreaterThanOrEqual(0);
    const texts = w.statements.map((s) => s.text);
    expect(texts.some((t) => t.includes('FROM events WHERE tenant_id = $1'))).toBe(true);
    expect(texts.some((t) => t.includes('LIMIT $3'))).toBe(true);
    expect(texts.some((t) => t.startsWith('INSERT INTO hostile'))).toBe(true);
    // a statement that only calls an application function is application work, not "no tables"
    expect(texts.some((t) => t.includes('app_lookup'))).toBe(true);
    // nothing Ledgerlens itself sent is in the workload, and a second read sees (and excludes) the first read's queries
    expect(texts.some((t) => t.includes(LEDGERLENS_MARKER))).toBe(false);
    const again = await readWorkload(source.connect);
    expect(again.excluded.find((e) => e.reason === 'ledgerlens_own_query')!.count).toBeGreaterThan(
      0,
    );
    expect(again.statements.some((s) => s.text.includes(LEDGERLENS_MARKER))).toBe(false);
    // ranks are by total time and every kept statement carries its statistics and a stable hash
    const stmt = w.statements.find((s) => s.text.includes('FROM events WHERE tenant_id = $1'))!;
    expect(stmt.calls).toBe(5);
    expect(stmt.queryHash).toMatch(/^[0-9a-f]{16}$/);
    expect(w.statements.map((s) => s.rank)).toEqual(w.statements.map((_, i) => i + 1));
    expect(w.statements.every((s, i, a) => i === 0 || a[i - 1]!.totalTimeMs >= s.totalTimeMs)).toBe(
      true,
    );
    expect(w.statementsRead).toBe(
      w.statements.length +
        w.excluded.filter((e) => e.reason !== 'other_database').reduce((a, e) => a + e.count, 0) +
        w.hiddenText,
    );
  });

  it('keeps a statement whose text cannot be parsed, as unverifiable, instead of dropping it', async () => {
    // pg_stat_statements text is valid SQL, so build the case directly
    const w: WorkloadStatement = {
      queryId: '1',
      queryHash: 'a'.repeat(16),
      rank: 1,
      text: 'SELEC garbage $1',
      kind: 'select',
      calls: 1,
      totalTimeMs: 1,
      meanTimeMs: 1,
      rows: 0,
      sharedBlksHit: 0,
      sharedBlksRead: 0,
      topLevel: true,
      tables: [],
      paramCount: 0,
      parsed: null,
      parseError: 'syntax error',
    };
    const b = await withSource(source.connect, (c) => bindStatement(c, w));
    expect(b.status).toBe('unverifiable');
    expect(b.unverifiable!.reason).toBe('parse_failed');
  });
});

describe('parameter bindings', () => {
  it('equality, range, IN, LIMIT and OFFSET: sampled from the statistics of the column each parameter is compared with', async () => {
    const b = await bindText(
      `SELECT id FROM events
        WHERE tenant_id = $1 AND kind IN ($2, $3) AND occurred_at >= $4 AND occurred_at < $5
        ORDER BY occurred_at LIMIT $6 OFFSET $7`,
    );
    expect(b.status).toBe('bound');
    expect(b.sets.length).toBe(3);
    const s0 = b.sets[0]!;
    expect(s0.provenance).toBe('sampled-from-stats');
    expect(s0.confidence).toBe('medium');
    const p = (n: number) => s0.params.find((x) => x.index === n)!;
    expect(p(1)).toMatchObject({
      column: 'events.tenant_id',
      origin: 'most_common_value',
      structural: false,
    });
    expect(p(1).value).toBe('00000000-0000-0000-0000-000000000001'); // the 60% tenant
    expect(p(2).column).toBe('events.kind');
    expect(p(3).column).toBe('events.kind');
    expect(p(2).value).not.toBe(p(3).value); // different values at different list positions
    expect(p(4)).toMatchObject({ column: 'events.occurred_at', origin: 'histogram_bound' });
    expect(new Date(p(4).value!).getTime()).toBeLessThan(new Date(p(5).value!).getTime()); // a non-empty window
    expect(p(6)).toMatchObject({
      provenance: 'synthesized',
      structural: true,
      origin: 'structural_default',
    });
    expect(p(7)).toMatchObject({ provenance: 'synthesized', structural: true });
    // every value is text, and the sets differ (typical, common and rare values)
    const fp = b.sets.map((s) => JSON.stringify(s.params.map((x) => x.value)));
    expect(new Set(fp).size).toBe(b.sets.length);
  });

  it('LIMIT and OFFSET alone are structural: the set is labelled synthesized, never "sampled"', async () => {
    const b = await bindText('SELECT * FROM fresh LIMIT $1 OFFSET $2');
    expect(b.sets[0]!.provenance).toBe('synthesized');
    expect(b.sets[0]!.confidence).toBe('low');
  });

  it('= ANY($1) gets an array literal, LIKE gets a prefix pattern, a swapped comparison and a function around the column work', async () => {
    const any = await bindText('SELECT 1 FROM events WHERE tenant_id = ANY($1)');
    const arr = any.sets[0]!.params[0]!;
    expect(arr.isArray).toBe(true);
    expect(arr.value).toMatch(/^\{"[0-9a-f-]{36}"(,"[0-9a-f-]{36}")*\}$/);
    const like = await bindText('SELECT 1 FROM events WHERE note LIKE $1');
    expect(like.sets[0]!.params[0]).toMatchObject({ origin: 'like_prefix_of_sample' });
    expect(like.sets[0]!.params[0]!.value).toMatch(/%$/);
    expect(like.sets[0]!.confidence).toBe('low');
    const swapped = await bindText(
      'SELECT 1 FROM events WHERE $1 < occurred_at AND lower(kind) = lower($2)',
    );
    expect(swapped.sets[0]!.params.map((x) => x.column)).toEqual([
      'events.occurred_at',
      'events.kind',
    ]);
  });

  it('keyset pagination (a row comparison) and a parameter inside COALESCE on INSERT are understood', async () => {
    const keyset = await bindText(
      'SELECT id FROM events WHERE tenant_id = $1 AND (occurred_at, id) < ($2::timestamptz, $3::bigint) LIMIT $4',
    );
    expect(keyset.sets[0]!.params.map((x) => x.column)).toEqual([
      'events.tenant_id',
      'events.occurred_at',
      'events.id',
      null,
    ]);
    const ins = await bindText(
      'INSERT INTO events (tenant_id, kind, qty, occurred_at) VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()))',
    );
    expect(ins.status).toBe('bound');
    expect(ins.sets[0]!.params.map((x) => x.column)).toEqual([
      'events.tenant_id',
      'events.kind',
      'events.qty',
      'events.occurred_at',
    ]);
    expect(ins.sets[0]!.confidence).toBe('low');
    expect(ins.sets[0]!.notes.join(' ')).toMatch(/constraints are not checked/);
  });

  it('a column without statistics gets a synthesized value from its type, with low confidence', async () => {
    const b = await bindText('SELECT 1 FROM fresh WHERE id = $1 AND label = $2 AND flag = $3');
    expect(b.status).toBe('bound');
    const s = b.sets[0]!;
    expect(s.provenance).toBe('synthesized');
    expect(s.confidence).toBe('low');
    expect(s.params.map((x) => x.origin)).toEqual(['type_default', 'type_default', 'type_default']);
    expect(s.params.map((x) => x.value)).toEqual(['1', 'x', 'true']);
  });

  it('a statement without parameters needs none', async () => {
    const b = await bindText('SELECT count(*) FROM events');
    expect(b.sets[0]).toMatchObject({ provenance: 'not-needed', confidence: 'high', params: [] });
  });

  it('user-supplied values win, are validated against the parameter count, and are never "improved"', async () => {
    const sql = 'SELECT 1 FROM events WHERE tenant_id = $1 AND kind = $2';
    const ok = await bindText(sql, {
      userBindings: {
        q: [
          ['00000000-0000-0000-0000-000000000003', 'write'],
          ['00000000-0000-0000-0000-000000000002', null],
        ],
      },
    });
    expect(ok.sets.map((s) => s.provenance)).toEqual(['user-supplied', 'user-supplied']);
    expect(ok.sets[0]!.confidence).toBe('high');
    expect(ok.sets[1]!.params[1]!.value).toBeNull();
    const bad = await bindText(sql, { userBindings: { q: [['only-one']] } });
    expect(bad.unverifiable!.reason).toBe('user_bindings_invalid');
    expect(() => UserBindingsFileSchema.parse({ q: [] })).toThrow();
  });
});

describe('unverifiable statements are listed with a reason, never skipped', () => {
  const cases: [string, string, string][] = [
    [
      'a parameter that is only a function argument',
      'SELECT app_lookup($1)',
      'param_without_column_or_type',
    ],
    ['a parameter in the select list', 'SELECT $1 FROM events', 'param_without_column_or_type'],
    [
      'a column of a derived table',
      'WITH x AS (SELECT id FROM events) SELECT 1 FROM x WHERE x.id = $1',
      'column_not_found',
    ],
    ['a table that does not exist', 'SELECT 1 FROM no_such_table WHERE a = $1', 'table_not_found'],
    ['a column that does not exist', 'SELECT 1 FROM events WHERE nope = $1', 'column_not_found'],
  ];
  for (const [label, sql, reason] of cases) {
    it(`${label}: ${reason}`, async () => {
      const b = await bindText(sql);
      expect(b.status).toBe('unverifiable');
      expect(b.sets).toEqual([]);
      expect(b.unverifiable!.reason).toBe(reason);
      expect(b.unverifiable!.detail.length).toBeGreaterThan(10);
    });
  }

  it('a binding the server refuses makes the statement unverifiable (bindings_rejected_by_server)', async () => {
    const sql = 'SELECT 1 FROM events WHERE qty = $1';
    const stmt = await statementOf(sql);
    const bound = await bindText(sql, { userBindings: { q: [['not a number']] } });
    expect(bound.status).toBe('bound'); // we cannot know until the server has seen it
    const checked = await validateBindings(source.connect, stmt, bound);
    expect(checked.status).toBe('unverifiable');
    expect(checked.unverifiable!.reason).toBe('bindings_rejected_by_server');
    expect(checked.unverifiable!.detail).toMatch(/22P02/); // invalid_text_representation
  });

  it('statements that ran inside a function say so', async () => {
    const stmt = {
      ...(await statementOf('SELECT 1 FROM events WHERE nope_variable = $1')),
      topLevel: false,
    };
    const b = await withSource(source.connect, (c) => bindStatement(c, stmt));
    expect(b.unverifiable!.detail).toMatch(/inside a function or trigger/);
  });
});

async function statementOf(sql: string): Promise<WorkloadStatement> {
  const p = await (await import('../sql/parse.js')).parseStatement(sql);
  return {
    queryId: 'q',
    queryHash: 'h'.repeat(16),
    rank: 1,
    text: sql,
    kind: p.kind,
    calls: 1,
    totalTimeMs: 1,
    meanTimeMs: 1,
    rows: 1,
    sharedBlksHit: 0,
    sharedBlksRead: 0,
    topLevel: true,
    tables: p.tables,
    paramCount: p.paramCount,
    parsed: p,
    parseError: null,
  };
}

describe('hostile values are bound parameters, never SQL text', () => {
  it('values pulled from pg_stats (quotes, semicolons, SQL, newlines, a "$1") are sampled as they are', async () => {
    const stmt = await statementOf('SELECT id FROM hostile WHERE name = $1');
    const b = await withSource(source.connect, (c) => bindStatement(c, stmt, { sets: 10 }));
    const values = b.sets.map((s) => s.params[0]!.value);
    // 10 equally common hostile values: every one is an MCV, and the sets walk through them
    expect(values.filter((v) => HOSTILE.includes(v!)).length).toBeGreaterThanOrEqual(5);
    expect(values.some((v) => v!.includes("'") || v!.includes(';') || v!.includes('\n'))).toBe(
      true,
    );
  });

  it('each hostile value finds exactly its own rows when sent as a parameter, and nothing else happens', async () => {
    const sql = 'SELECT count(*)::int AS n FROM hostile WHERE name = $1';
    for (const v of HOSTILE) {
      const cfg = toQueryConfig(sql, {
        params: [
          {
            index: 1,
            value: v,
            isArray: false,
            provenance: 'sampled-from-stats',
            origin: 'most_common_value',
            structural: false,
            column: null,
          },
        ],
      });
      expect(cfg.text).toBe(sql); // byte for byte the text pg_stat_statements gave: no value in it
      if (v !== '$1') expect(cfg.text).not.toContain(v); // (the value "$1" is also the placeholder)
      expect(cfg.values).toEqual([v]);
      const r = await withSource(source.connect, (c) => c.query<{ n: number }>(cfg));
      expect(r.rows[0]!.n).toBe(30);
    }
    await runApp(async (c) => {
      expect((await c.query('SELECT count(*)::int AS n FROM events')).rows[0]!.n).toBe(20000);
      expect((await c.query('SELECT count(*)::int AS n FROM hostile')).rows[0]!.n).toBe(
        HOSTILE.length * 30 + 1,
      );
    });
  });

  it('validation sends the statement text unchanged and the hostile values only in the parameter list', async () => {
    const sql = 'SELECT id FROM hostile WHERE name = $1';
    const stmt = await statementOf(sql);
    const sent: { text: string; values: unknown[] }[] = [];
    const connect = async () => {
      const c = await source.connect();
      const q = c.query.bind(c) as (...a: unknown[]) => unknown;
      (c as unknown as { query: unknown }).query = (...args: unknown[]) => {
        const a0 = args[0] as string | { text: string; values?: unknown[] };
        if (typeof a0 === 'object' && a0.values) sent.push({ text: a0.text, values: a0.values });
        return q(...args);
      };
      return c;
    };
    const bound = await bindText(sql, { userBindings: { q: HOSTILE.map((v) => [v]) } });
    const checked = await validateBindings(connect, stmt, bound);
    expect(checked.sets.map((s) => s.validation.status)).toEqual(HOSTILE.map(() => 'ok'));
    expect(sent).toHaveLength(HOSTILE.length);
    for (const [i, m] of sent.entries()) {
      expect(m.text).toBe(`${LEDGERLENS_MARKER} EXPLAIN (FORMAT JSON) ${sql}`);
      for (const v of HOSTILE.filter((x) => x !== '$1')) expect(m.text).not.toContain(v);
      expect(m.values).toEqual([HOSTILE[i]]);
    }
  });

  it('an array parameter keeps hostile elements intact', async () => {
    const lit = arrayLiteral(HOSTILE);
    const r = await withSource(source.connect, (c) =>
      c.query<{ a: string[] }>('SELECT $1::text[] AS a', [lit]),
    );
    expect(r.rows[0]!.a).toEqual(HOSTILE);
  });

  it('the source never receives a statement that could write: only SELECT, EXPLAIN, catalog reads, in read-only sessions', async () => {
    const log: string[] = [];
    const connect = async () => {
      const c = await source.connect();
      const q = c.query.bind(c) as (...a: unknown[]) => unknown;
      (c as unknown as { query: unknown }).query = (...args: unknown[]) => {
        const a0 = args[0];
        log.push(typeof a0 === 'string' ? a0 : (a0 as { text: string }).text);
        return q(...args);
      };
      return c;
    };
    const w = await readWorkload(connect);
    const bound: StatementBindings[] = [];
    await withSource(connect, async (c) => {
      for (const s of w.statements) bound.push(await bindStatement(c, s));
    });
    for (const [i, s] of w.statements.entries()) await validateBindings(connect, s, bound[i]!);
    expect(log.length).toBeGreaterThan(5);
    for (const sql of log) {
      const first = sql.replace(LEDGERLENS_MARKER, '').trim().split(/\s+/)[0]!.toUpperCase();
      expect(['SELECT', 'EXPLAIN', 'BEGIN', 'ROLLBACK', 'WITH'], sql.slice(0, 60)).toContain(first);
    }
    // and the connection really is read-only: a write is refused by the server
    await expect(
      withSource(source.connect, (c) => c.query('CREATE TABLE should_not_exist (a int)')),
    ).rejects.toThrow(/read-only/);
  });
});

describe('the report', () => {
  it('lists every statement of the workload; the counts add up; text is redacted and marked untrusted', async () => {
    const w: Workload = await readWorkload(source.connect);
    const bound: StatementBindings[] = [];
    await withSource(source.connect, async (c) => {
      for (const s of w.statements) bound.push(await bindStatement(c, s));
    });
    const validated: StatementBindings[] = [];
    for (const [i, s] of w.statements.entries())
      validated.push(await validateBindings(source.connect, s, bound[i]!));
    const r = buildWorkloadReport(w, validated, 20);
    expect(r.statements).toHaveLength(w.statements.length); // nothing skipped
    expect(r.all.statements).toBe(w.statements.length);
    const sum = (x: typeof r.all) =>
      x['user-supplied'] +
      x['sampled-from-stats'] +
      x.synthesized +
      x['not-needed'] +
      x.unverifiable;
    expect(sum(r.all)).toBe(r.all.statements);
    expect(sum(r.top)).toBe(r.top.n);
    expect(Object.values(r.unverifiableByReason).reduce((a, b) => a + (b ?? 0), 0)).toBe(
      r.all.unverifiable,
    );
    for (const s of r.statements) {
      expect(s.text).toHaveProperty('$untrusted');
      if (s.unverifiable) expect(s.unverifiable.detail).toHaveProperty('$untrusted');
    }
    const text = renderWorkloadReport(r);
    expect(text).toMatch(/unverifiable statements \(\d+\), none skipped silently/);
    expect(text).toContain('statements in the workload:');
  });
});
