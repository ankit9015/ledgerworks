/**
 * Tenant isolation matrix: tables x operations x contexts.
 *
 * Contexts:  tenantA, tenantB (real app role, app.tenant_id set), noTenant (app role, setting
 * absent) and noPrivileges (a role with no grants at all).
 * Operations: SELECT, INSERT, UPDATE, DELETE.
 *
 * Every assertion goes through eq()/denied() so the total can be printed at the end.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminPool, appPool } from './helpers.js';

type Op = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
const OPS: Op[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const CONTEXTS = ['tenantA', 'tenantB', 'noTenant', 'noPrivileges'] as const;
type Context = (typeof CONTEXTS)[number];

interface Seed {
  tenantId: string;
  userId: string;
  mainJobId: string;
  lonelyJobId: string;
}

interface Spec {
  table: string;
  /** Column holding the tenant key used for filtering (tenants/users filter on their own id). */
  keyCol: string;
  /** What keyCol holds for a given seeded tenant. */
  keyOf: (s: Seed) => string;
  privileges: Record<Op, boolean>;
  insert: (tenant: Seed, spareUserId: string) => { sql: string; params: unknown[] };
  /** SET clause used by UPDATE tests (a no-op change of a column to itself). */
  set: string;
  /** Extra filter for DELETE tests (to avoid FK-referenced rows). */
  deleteFilter?: string;
  /** True when rows carry tenant_id, so "move row to another tenant" can be tested. */
  hasTenantId: boolean;
}

const rnd = () => randomBytes(8).toString('hex');

const SPECS: Spec[] = [
  {
    table: 'tenants',
    keyCol: 'id',
    keyOf: (s) => s.tenantId,
    privileges: { SELECT: true, INSERT: false, UPDATE: false, DELETE: false },
    insert: () => ({ sql: `INSERT INTO tenants (name) VALUES ($1)`, params: ['x'] }),
    set: 'name = name',
    hasTenantId: false,
  },
  {
    table: 'users',
    keyCol: 'id',
    keyOf: (s) => s.userId,
    privileges: { SELECT: true, INSERT: false, UPDATE: false, DELETE: false },
    insert: () => ({ sql: `INSERT INTO users (email) VALUES ($1)`, params: [`${rnd()}@x.test`] }),
    set: 'email = email',
    hasTenantId: false,
  },
  {
    table: 'memberships',
    keyCol: 'tenant_id',
    keyOf: (s) => s.tenantId,
    privileges: { SELECT: true, INSERT: true, UPDATE: true, DELETE: true },
    insert: (t, spare) => ({
      sql: `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'member')`,
      params: [t.tenantId, spare],
    }),
    set: 'role = role',
    hasTenantId: true,
  },
  {
    table: 'api_keys',
    keyCol: 'tenant_id',
    keyOf: (s) => s.tenantId,
    privileges: { SELECT: true, INSERT: true, UPDATE: true, DELETE: false },
    insert: (t) => ({
      sql: `INSERT INTO api_keys (tenant_id, key_prefix, key_hash) VALUES ($1, 'lk_test', $2)`,
      params: [t.tenantId, randomBytes(32).toString('hex')],
    }),
    set: 'name = name',
    hasTenantId: true,
  },
  {
    table: 'usage_events',
    keyCol: 'tenant_id',
    keyOf: (s) => s.tenantId,
    privileges: { SELECT: true, INSERT: true, UPDATE: false, DELETE: false },
    insert: (t) => ({
      sql: `INSERT INTO usage_events (tenant_id, occurred_at, event_type, quantity)
            VALUES ($1, '2026-01-15T10:00:00Z', 'tokens', 5)`,
      params: [t.tenantId],
    }),
    set: 'quantity = quantity',
    hasTenantId: true,
  },
  {
    table: 'credit_ledger',
    keyCol: 'tenant_id',
    keyOf: (s) => s.tenantId,
    // Money moves only through debit_credits/refund_credits (SECURITY DEFINER), never directly.
    privileges: { SELECT: true, INSERT: false, UPDATE: false, DELETE: false },
    insert: (t) => ({
      sql: `INSERT INTO credit_ledger (tenant_id, amount, kind) VALUES ($1, 5, 'grant')`,
      params: [t.tenantId],
    }),
    set: 'amount = amount',
    hasTenantId: true,
  },
  {
    table: 'credit_balances',
    keyCol: 'tenant_id',
    keyOf: (s) => s.tenantId,
    privileges: { SELECT: true, INSERT: false, UPDATE: false, DELETE: false },
    insert: (t) => ({
      sql: `INSERT INTO credit_balances (tenant_id, balance) VALUES ($1, 1)`,
      params: [t.tenantId],
    }),
    set: 'balance = balance',
    hasTenantId: true,
  },
  {
    table: 'jobs',
    keyCol: 'tenant_id',
    keyOf: (s) => s.tenantId,
    privileges: { SELECT: true, INSERT: true, UPDATE: true, DELETE: true },
    insert: (t) => ({
      sql: `INSERT INTO jobs (tenant_id, type) VALUES ($1, 'x')`,
      params: [t.tenantId],
    }),
    set: 'last_error = last_error',
    deleteFilter: `type = 'lonely'`,
    hasTenantId: true,
  },
  {
    table: 'job_attempts',
    keyCol: 'tenant_id',
    keyOf: (s) => s.tenantId,
    privileges: { SELECT: true, INSERT: true, UPDATE: true, DELETE: false },
    insert: (t) => ({
      sql: `INSERT INTO job_attempts (tenant_id, job_id, attempt_no) VALUES ($1, $2, $3)`,
      params: [t.tenantId, t.mainJobId, 1000 + Math.floor(Math.random() * 1e6)],
    }),
    set: 'error = error',
    hasTenantId: true,
  },
  {
    table: 'dead_letters',
    keyCol: 'tenant_id',
    keyOf: (s) => s.tenantId,
    privileges: { SELECT: true, INSERT: true, UPDATE: false, DELETE: false },
    insert: (t) => ({
      sql: `INSERT INTO dead_letters (tenant_id, job_id, type, payload, attempts)
            VALUES ($1, $2, 'lonely', '{}', 1)`,
      params: [t.tenantId, t.lonelyJobId],
    }),
    set: 'last_error = last_error',
    hasTenantId: true,
  },
];

// ---------------------------------------------------------------------------------------------
// Assertion counting
// ---------------------------------------------------------------------------------------------
let assertions = 0;
let isolationTests = 0;

function eq<T>(actual: T, expected: T, label: string): void {
  assertions++;
  expect(actual, label).toEqual(expected);
}
function truthy(cond: boolean, label: string): void {
  assertions++;
  expect(cond, label).toBe(true);
}

// ---------------------------------------------------------------------------------------------
// Running statements in each context
// ---------------------------------------------------------------------------------------------
type Outcome =
  | { ok: true; rowCount: number; rows: Record<string, unknown>[] }
  | { ok: false; code: string; message: string };

let admin: pg.Pool;
let app: pg.Pool;
let A: Seed;
let B: Seed;
let C: Seed;
let spareUserId: string;

async function run(
  ctx: Context,
  sql: string,
  params: unknown[] = [],
  setup: string[] = [],
): Promise<Outcome> {
  const pool = ctx === 'noPrivileges' ? admin : app;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (ctx === 'noPrivileges') await client.query('SET LOCAL ROLE ledgerline_test_noprivs');
    if (ctx === 'tenantA')
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [A.tenantId]);
    if (ctx === 'tenantB')
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [B.tenantId]);
    for (const s of setup) await client.query(s);
    try {
      const r = await client.query(sql, params);
      return { ok: true, rowCount: r.rowCount ?? 0, rows: r.rows };
    } catch (e) {
      const err = e as { code?: string; message: string };
      return { ok: false, code: err.code ?? '', message: err.message };
    }
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

function denied(o: Outcome, kind: 'privilege' | 'rls', label: string): void {
  assertions++;
  expect(o.ok, `${label}: expected an error`).toBe(false);
  if (!o.ok) {
    expect(o.code, `${label}: ${o.message}`).toBe('42501');
    if (kind === 'privilege') expect(o.message, label).toMatch(/permission denied/);
    else expect(o.message, label).toMatch(/row-level security/);
  }
}

function rows(o: Outcome): Record<string, unknown>[] {
  if (!o.ok) throw new Error(`unexpected error: ${o.message}`);
  return o.rows;
}

async function count(spec: Spec, key: string, extra?: string): Promise<number> {
  const r = await admin.query(
    `SELECT count(*)::int AS n FROM ${spec.table} WHERE ${spec.keyCol} = $1 ${extra ? `AND ${extra}` : ''}`,
    [key],
  );
  return r.rows[0].n as number;
}

// ---------------------------------------------------------------------------------------------
// Seed data (inserted as the superuser, which bypasses RLS)
// ---------------------------------------------------------------------------------------------
async function seedTenant(name: string, full: boolean): Promise<Seed> {
  const t = await admin.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [name]);
  const tenantId = t.rows[0].id as string;
  const u = await admin.query(`INSERT INTO users (email) VALUES ($1) RETURNING id`, [
    `${name}-${rnd()}@iso.test`,
  ]);
  const userId = u.rows[0].id as string;
  const main = await admin.query(
    `INSERT INTO jobs (tenant_id, type) VALUES ($1, 'main') RETURNING id`,
    [tenantId],
  );
  const lonely = await admin.query(
    `INSERT INTO jobs (tenant_id, type) VALUES ($1, 'lonely') RETURNING id`,
    [tenantId],
  );
  const seed: Seed = {
    tenantId,
    userId,
    mainJobId: main.rows[0].id,
    lonelyJobId: lonely.rows[0].id,
  };
  if (full) {
    await admin.query(
      `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [tenantId, userId],
    );
    await admin.query(
      `INSERT INTO api_keys (tenant_id, key_prefix, key_hash) VALUES ($1, 'lk_seed', $2)`,
      [tenantId, randomBytes(32).toString('hex')],
    );
    await admin.query(
      `INSERT INTO usage_events (tenant_id, occurred_at, event_type, quantity)
       VALUES ($1, '2026-02-01T00:00:00Z', 'tokens', 1)`,
      [tenantId],
    );
    await admin.query(
      `INSERT INTO credit_ledger (tenant_id, amount, kind) VALUES ($1, 100, 'grant')`,
      [tenantId],
    );
    await admin.query(`INSERT INTO credit_balances (tenant_id, balance) VALUES ($1, 100)`, [
      tenantId,
    ]);
    await admin.query(
      `INSERT INTO job_attempts (tenant_id, job_id, attempt_no) VALUES ($1, $2, 1)`,
      [tenantId, seed.mainJobId],
    );
    await admin.query(
      `INSERT INTO dead_letters (tenant_id, job_id, type, payload, attempts)
       VALUES ($1, $2, 'main', '{}', 5)`,
      [tenantId, seed.mainJobId],
    );
  }
  return seed;
}

beforeAll(async () => {
  admin = adminPool();
  app = appPool();
  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ledgerline_test_noprivs') THEN
        CREATE ROLE ledgerline_test_noprivs NOLOGIN;
      END IF;
    END $$`);
  A = await seedTenant('tenant-a', true);
  B = await seedTenant('tenant-b', true);
  // C is only used for "own-tenant insert works" controls, so it has no balance or dead letter.
  C = await seedTenant('tenant-c', false);
  const spare = await admin.query(`INSERT INTO users (email) VALUES ($1) RETURNING id`, [
    `spare-${rnd()}@iso.test`,
  ]);
  spareUserId = spare.rows[0].id;
});

afterAll(async () => {
  console.log(
    `\nISOLATION SUMMARY: ${isolationTests} isolation tests, ${assertions} isolation assertions`,
  );
  await admin.end();
  await app.end();
});

// ---------------------------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------------------------
function mineAndOther(ctx: Context): { mine: Seed | null; other: Seed } {
  if (ctx === 'tenantA') return { mine: A, other: B };
  if (ctx === 'tenantB') return { mine: B, other: A };
  return { mine: null, other: A };
}

describe.each(SPECS)('isolation: $table', (spec) => {
  describe.each(OPS)('%s', (op) => {
    it.each(CONTEXTS)(`${spec.table} ${op} as %s`, async (ctx) => {
      isolationTests++;
      const { mine, other } = mineAndOther(ctx);
      const otherKey = spec.keyOf(other);
      const label = `${spec.table} ${op} as ${ctx}`;
      const statements: Record<Op, { sql: string; params: unknown[] }> = {
        SELECT: { sql: `SELECT ${spec.keyCol} AS k FROM ${spec.table}`, params: [] },
        INSERT: spec.insert(other, spareUserId),
        UPDATE: { sql: `UPDATE ${spec.table} SET ${spec.set}`, params: [] },
        DELETE: {
          sql: `DELETE FROM ${spec.table}${spec.deleteFilter ? ` WHERE ${spec.deleteFilter}` : ''}`,
          params: [],
        },
      };

      // A role with no grants at all can do nothing.
      if (ctx === 'noPrivileges') {
        const s = statements[op];
        denied(await run(ctx, s.sql, s.params), 'privilege', label);
        return;
      }
      // Operations the app role was never granted fail on privilege in every tenant context.
      if (!spec.privileges[op]) {
        const s = statements[op];
        denied(await run(ctx, s.sql, s.params), 'privilege', `${label} (no grant)`);
        return;
      }

      if (op === 'SELECT') {
        const all = rows(await run(ctx, statements.SELECT.sql));
        if (mine) {
          truthy(all.length >= 1, `${label}: own rows are visible`);
          eq(
            all.filter((r) => r.k !== spec.keyOf(mine)).length,
            0,
            `${label}: no row belongs to another tenant`,
          );
        } else {
          eq(all.length, 0, `${label}: nothing is visible`);
        }
        const targeted = rows(
          await run(ctx, `SELECT 1 FROM ${spec.table} WHERE ${spec.keyCol} = $1`, [otherKey]),
        );
        eq(targeted.length, 0, `${label}: targeted read of the other tenant returns nothing`);
      }

      if (op === 'INSERT') {
        const s = statements.INSERT; // always built for `other` (or A when no tenant is set)
        denied(await run(ctx, s.sql, s.params), 'rls', `${label}: insert for another tenant`);
      }

      if (op === 'UPDATE') {
        const targeted = await run(
          ctx,
          `UPDATE ${spec.table} SET ${spec.set} WHERE ${spec.keyCol} = $1`,
          [otherKey],
        );
        eq(targeted.ok && targeted.rowCount, 0, `${label}: targeted update of the other tenant`);
        const all = await run(ctx, statements.UPDATE.sql);
        const expected = mine ? await count(spec, spec.keyOf(mine)) : 0;
        eq(all.ok && all.rowCount, expected, `${label}: unqualified update touches only own rows`);
        if (mine && spec.hasTenantId) {
          const move = await run(ctx, `UPDATE ${spec.table} SET tenant_id = $1`, [other.tenantId]);
          denied(move, 'rls', `${label}: moving own rows to another tenant`);
        }
      }

      if (op === 'DELETE') {
        const filter = spec.deleteFilter ? `AND ${spec.deleteFilter}` : '';
        const targeted = await run(
          ctx,
          `DELETE FROM ${spec.table} WHERE ${spec.keyCol} = $1 ${filter}`,
          [otherKey],
        );
        eq(targeted.ok && targeted.rowCount, 0, `${label}: targeted delete of the other tenant`);
        const all = await run(ctx, statements.DELETE.sql);
        const expected = mine ? await count(spec, spec.keyOf(mine), spec.deleteFilter) : 0;
        eq(all.ok && all.rowCount, expected, `${label}: unqualified delete touches only own rows`);
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Positive controls: the policies allow what they should (so the denials above are meaningful)
// ---------------------------------------------------------------------------------------------
describe('isolation: own-tenant writes still work', () => {
  it.each(SPECS.filter((s) => s.privileges.INSERT && s.hasTenantId))(
    'insert into $table for the current tenant succeeds',
    async (spec) => {
      isolationTests++;
      const s = spec.insert(C, spareUserId);
      // Use tenant C's own context via an explicit set_config.
      const client = await app.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [C.tenantId]);
        const r = await client.query(s.sql, s.params);
        eq(r.rowCount, 1, `${spec.table}: own insert`);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    },
  );
});

// ---------------------------------------------------------------------------------------------
// Guards around the matrix
// ---------------------------------------------------------------------------------------------
describe('isolation: guards', () => {
  it('a missing, empty or malformed tenant setting returns zero rows, not an error', async () => {
    isolationTests++;
    for (const spec of SPECS) {
      for (const setting of [null, '', 'not-a-uuid', "' OR true --"]) {
        const client = await app.connect();
        try {
          await client.query('BEGIN');
          if (setting !== null) {
            await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [setting]);
          }
          const r = await client.query(`SELECT 1 FROM ${spec.table}`);
          eq(r.rowCount, 0, `${spec.table} with tenant setting ${JSON.stringify(setting)}`);
        } finally {
          await client.query('ROLLBACK').catch(() => undefined);
          client.release();
        }
      }
    }
  });

  it('the tenant setting does not leak across transactions on a pooled connection', async () => {
    isolationTests++;
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [A.tenantId]);
      const inside = await client.query('SELECT 1 FROM jobs');
      truthy((inside.rowCount ?? 0) > 0, 'tenant A sees jobs inside its transaction');
      await client.query('COMMIT');
      const after = await client.query('SELECT 1 FROM jobs');
      eq(after.rowCount, 0, 'after COMMIT the setting is gone and no rows are visible');
    } finally {
      client.release();
    }
  });

  it('every tenant-owned table has RLS enabled AND forced, and at least one policy', async () => {
    isolationTests++;
    const { rows: tables } = await admin.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
         AND c.relname <> 'schema_migrations'`,
    );
    eq(tables.length, SPECS.length, 'all tables are covered by the matrix');
    for (const t of tables) {
      eq(
        [t.relname, t.relrowsecurity, t.relforcerowsecurity],
        [t.relname, true, true],
        `${t.relname} RLS flags`,
      );
      const p = await admin.query(
        `SELECT count(*)::int AS n FROM pg_policies WHERE tablename = $1`,
        [t.relname],
      );
      truthy(p.rows[0].n >= 1, `${t.relname} has a policy`);
    }
  });

  it('the app role is not a superuser, has no BYPASSRLS, and cannot switch to a stronger role', async () => {
    isolationTests++;
    const r = await app.query(
      `SELECT current_user AS u, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    eq(r.rows[0], { u: 'ledgerline_app', rolsuper: false, rolbypassrls: false }, 'app role flags');
    for (const role of [
      'ledgerline_owner',
      'ledgerline_definer',
      'ledgerline_ledger',
      'postgres',
      'ledgerworks',
    ]) {
      const o = await run('noTenant', `SET ROLE ${role}`);
      truthy(!o.ok, `app cannot SET ROLE ${role}`);
    }
  });

  it('turning row_security off does not bypass RLS for the app role (it errors instead)', async () => {
    isolationTests++;
    const o = await run('tenantA', 'SELECT * FROM jobs', [], ['SET LOCAL row_security = off']);
    truthy(!o.ok, 'query fails instead of returning unfiltered rows');
  });

  it('the app role cannot disable RLS, drop policies or disable ledger triggers', async () => {
    isolationTests++;
    for (const sql of [
      'ALTER TABLE jobs DISABLE ROW LEVEL SECURITY',
      'ALTER TABLE jobs NO FORCE ROW LEVEL SECURITY',
      'DROP POLICY tenant_isolation ON jobs',
      'ALTER TABLE credit_ledger DISABLE TRIGGER credit_ledger_no_update_delete',
      'ALTER TABLE credit_ledger DISABLE TRIGGER ALL',
    ]) {
      const o = await run('tenantA', sql);
      truthy(!o.ok && o.code === '42501', `denied: ${sql}`);
    }
  });

  it('the app role cannot modify or remove credit_ledger rows, in any tenant context', async () => {
    isolationTests++;
    for (const ctx of ['tenantA', 'tenantB', 'noTenant'] as const) {
      for (const sql of [
        'UPDATE credit_ledger SET amount = amount',
        'DELETE FROM credit_ledger',
        'TRUNCATE credit_ledger',
      ]) {
        denied(await run(ctx, sql), 'privilege', `${ctx}: ${sql}`);
      }
    }
    const still = await admin.query(
      `SELECT count(*)::int AS n FROM credit_ledger WHERE tenant_id = $1`,
      [A.tenantId],
    );
    truthy(still.rows[0].n >= 1, 'ledger rows are intact');
  });

  it('the app role has no direct access to usage_events partitions', async () => {
    isolationTests++;
    const parts = await admin.query(
      `SELECT inhrelid::regclass::text AS name FROM pg_inherits WHERE inhparent = 'usage_events'::regclass`,
    );
    eq(parts.rowCount, 48, 'partition count');
    for (const p of parts.rows) {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        const r = await admin.query(`SELECT has_table_privilege('ledgerline_app', $1, $2) AS ok`, [
          p.name,
          priv,
        ]);
        eq(r.rows[0].ok, false, `${p.name} ${priv}`);
      }
    }
    denied(
      await run('tenantA', 'SELECT * FROM usage_events_2026_01'),
      'privilege',
      'direct partition read',
    );
  });

  it('granted privileges match the matrix exactly', async () => {
    isolationTests++;
    for (const spec of SPECS) {
      for (const op of OPS) {
        const r = await admin.query(`SELECT has_table_privilege('ledgerline_app', $1, $2) AS ok`, [
          spec.table,
          op,
        ]);
        eq(r.rows[0].ok, spec.privileges[op], `${spec.table} ${op} grant`);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// SECURITY DEFINER functions
// ---------------------------------------------------------------------------------------------
// Functions in the ledgerline_fn schema, by kind. Adding a function means deciding which kind it is.
const DEFINER_FUNCTIONS = [
  'authenticate_api_key',
  'claim_jobs',
  'create_tenant',
  'debit_credits',
  'refund_credits',
];
const LEDGER_FUNCTIONS = ['debit_credits', 'refund_credits'];
const INVOKER_FUNCTIONS = ['complete_job', 'enqueue_job', 'fail_job'];

describe('isolation: SECURITY DEFINER functions', () => {
  it('authenticate_api_key returns the tenant for a valid hash and nothing otherwise', async () => {
    isolationTests++;
    const hash = randomBytes(32).toString('hex');
    await admin.query(
      `INSERT INTO api_keys (tenant_id, key_prefix, key_hash) VALUES ($1, 'lk_f', $2)`,
      [A.tenantId, hash],
    );
    const ok = await app.query(`SELECT * FROM ledgerline_fn.authenticate_api_key($1)`, [hash]);
    eq(
      ok.rows.map((r) => r.tenant_id),
      [A.tenantId],
      'valid key resolves to its tenant',
    );
    const unknown = await app.query(`SELECT * FROM ledgerline_fn.authenticate_api_key($1)`, [
      randomBytes(32).toString('hex'),
    ]);
    eq(unknown.rowCount, 0, 'unknown key');
    await admin.query(`UPDATE api_keys SET revoked_at = now() WHERE key_hash = $1`, [hash]);
    const revoked = await app.query(`SELECT * FROM ledgerline_fn.authenticate_api_key($1)`, [hash]);
    eq(revoked.rowCount, 0, 'revoked key');
    const prefix = await app.query(`SELECT * FROM ledgerline_fn.authenticate_api_key('lk_f')`);
    eq(prefix.rowCount, 0, 'a prefix alone never authenticates');
  });

  it('create_tenant creates tenant, owner membership, zero balance and a key', async () => {
    isolationTests++;
    const hash = randomBytes(32).toString('hex');
    const email = `owner-${rnd()}@iso.test`;
    const r = await app.query(`SELECT ledgerline_fn.create_tenant($1, $2, $3, $4) AS id`, [
      'created',
      email,
      hash,
      'lk_created',
    ]);
    const id = r.rows[0].id as string;
    const m = await admin.query(`SELECT role FROM memberships WHERE tenant_id = $1`, [id]);
    eq(m.rows, [{ role: 'owner' }], 'owner membership');
    const b = await admin.query(
      `SELECT balance::int AS b FROM credit_balances WHERE tenant_id = $1`,
      [id],
    );
    eq(b.rows, [{ b: 0 }], 'zero balance');
    const k = await admin.query(`SELECT key_hash FROM api_keys WHERE tenant_id = $1`, [id]);
    eq(k.rows, [{ key_hash: hash }], 'key hash stored');
  });

  it('the definer role is narrow: no BYPASSRLS and exactly the privileges its functions need', async () => {
    isolationTests++;
    const r = await admin.query(
      `SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'ledgerline_definer'`,
    );
    eq(r.rows[0], { rolsuper: false, rolbypassrls: false, rolcanlogin: false }, 'definer flags');
    // Exactly these privileges, nothing else. credit_ledger and usage_events: none at all.
    const allowed: Record<string, string[]> = {
      tenants: ['SELECT', 'INSERT'],
      users: ['SELECT', 'INSERT'],
      memberships: ['INSERT'],
      api_keys: ['SELECT', 'INSERT'],
      credit_balances: ['INSERT'],
      jobs: ['SELECT', 'UPDATE'],
      job_attempts: ['SELECT', 'INSERT', 'UPDATE'],
      dead_letters: ['INSERT'],
    };
    for (const spec of SPECS) {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        const p = await admin.query(
          `SELECT has_table_privilege('ledgerline_definer', $1, $2) AS ok`,
          [spec.table, priv],
        );
        eq(
          p.rows[0].ok,
          (allowed[spec.table] ?? []).includes(priv),
          `definer ${priv} on ${spec.table}`,
        );
      }
    }
  });

  it('the ledger role is narrow: no BYPASSRLS, only SELECT+INSERT on the ledger and SELECT+UPDATE on balances', async () => {
    isolationTests++;
    const r = await admin.query(
      `SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'ledgerline_ledger'`,
    );
    eq(r.rows[0], { rolsuper: false, rolbypassrls: false, rolcanlogin: false }, 'ledger flags');
    const allowed: Record<string, string[]> = {
      credit_ledger: ['SELECT', 'INSERT'],
      credit_balances: ['SELECT', 'UPDATE'],
    };
    for (const spec of SPECS) {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        const p = await admin.query(
          `SELECT has_table_privilege('ledgerline_ledger', $1, $2) AS ok`,
          [spec.table, priv],
        );
        eq(
          p.rows[0].ok,
          (allowed[spec.table] ?? []).includes(priv),
          `ledger role ${priv} on ${spec.table}`,
        );
      }
    }
    // Its policies are tenant-scoped, never "true": no permissive escape hatch.
    const pol = await admin.query(
      `SELECT tablename, policyname, qual, with_check FROM pg_policies
       WHERE 'ledgerline_ledger' = ANY (roles) ORDER BY tablename, policyname`,
    );
    eq(pol.rowCount, 3, 'ledger role policy count');
    for (const p of pol.rows) {
      const text = `${p.qual ?? ''} ${p.with_check ?? ''}`;
      truthy(/app_tenant_id/.test(text), `${p.policyname} is tenant-scoped`);
      truthy(!/(^|[^a-z_])true([^a-z_]|$)/.test(text), `${p.policyname} is not permissive`);
    }
  });

  it('the worker role can log in, has no BYPASSRLS, no table privileges and may only call claim_jobs', async () => {
    isolationTests++;
    const r = await admin.query(
      `SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'ledgerline_worker'`,
    );
    eq(r.rows[0], { rolsuper: false, rolbypassrls: false, rolcanlogin: true }, 'worker flags');
    for (const spec of SPECS) {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        const p = await admin.query(
          `SELECT has_table_privilege('ledgerline_worker', $1, $2) AS ok`,
          [spec.table, priv],
        );
        eq(p.rows[0].ok, false, `worker ${priv} on ${spec.table}`);
      }
    }
    const fns = await admin.query(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'ledgerline_fn' AND has_function_privilege('ledgerline_worker', p.oid, 'EXECUTE')
       ORDER BY p.proname`,
    );
    eq(
      fns.rows.map((x) => x.proname),
      ['claim_jobs'],
      'functions the worker role may execute',
    );
  });

  it('SECURITY DEFINER functions pin search_path and belong to the definer role; invoker functions stay invokers; none is public', async () => {
    isolationTests++;
    const f = await admin.query(
      `SELECT p.oid, p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'ledgerline_fn' ORDER BY p.proname`,
    );
    const definers = f.rows.filter((r) => r.prosecdef);
    const invokers = f.rows.filter((r) => !r.prosecdef);
    eq(
      definers.map((r) => r.proname),
      DEFINER_FUNCTIONS,
      'SECURITY DEFINER functions',
    );
    eq(
      invokers.map((r) => r.proname),
      INVOKER_FUNCTIONS,
      'SECURITY INVOKER functions (run as the caller, so RLS applies)',
    );
    for (const r of definers) {
      eq(
        r.owner,
        LEDGER_FUNCTIONS.includes(r.proname) ? 'ledgerline_ledger' : 'ledgerline_definer',
        `${r.proname} owner`,
      );
      eq(r.proconfig, ['search_path=pg_catalog, pg_temp'], `${r.proname} search_path`);
    }
    for (const r of f.rows) {
      const p = await admin.query(
        `SELECT has_function_privilege('ledgerline_test_noprivs', $1::oid, 'EXECUTE') AS ok`,
        [r.oid],
      );
      eq(p.rows[0].ok, false, `${r.proname} is not executable by PUBLIC`);
    }
    const o = await run('noPrivileges', `SELECT * FROM ledgerline_fn.authenticate_api_key('x')`);
    truthy(!o.ok && o.code === '42501', 'a role without grants cannot call the function');
  });
});
