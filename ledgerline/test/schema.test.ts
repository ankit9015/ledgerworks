import { mkdtemp, writeFile, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultMigrationsDir, migrate } from '../src/db/migrate.js';
import { adminPool, appPool, serverAdminUrl, testAdminUrl } from './helpers.js';

const TABLES = [
  'api_keys',
  'credit_balances',
  'credit_ledger',
  'dead_letters',
  'job_attempts',
  'jobs',
  'memberships',
  'tenants',
  'usage_events',
  'users',
];

let admin: pg.Pool;

/** Runs fn on one dedicated connection inside a transaction that is always rolled back. */
async function inTx(fn: (c: pg.PoolClient) => Promise<void>): Promise<void> {
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}
let app: pg.Pool;

beforeAll(() => {
  admin = adminPool();
  app = appPool();
});
afterAll(async () => {
  await admin.end();
  await app.end();
});

describe('migrations', () => {
  it('applied from empty and are tracked', async () => {
    const { rows } = await admin.query(
      'SELECT version, name FROM schema_migrations ORDER BY version',
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toMatchObject({ version: '0001', name: 'schema' });
  });

  it('is safe to re-run: nothing is applied twice', async () => {
    const before = await admin.query('SELECT count(*)::int AS n FROM schema_migrations');
    const result = await migrate(testAdminUrl());
    const after = await admin.query('SELECT count(*)::int AS n FROM schema_migrations');
    expect(result.applied).toEqual([]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('refuses to run when an applied migration file was edited', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'migrations-'));
    await cp(defaultMigrationsDir, dir, { recursive: true });
    await writeFile(path.join(dir, '0001_schema.sql'), '-- tampered\nSELECT 1;\n');
    await expect(migrate(testAdminUrl(), { dir })).rejects.toThrow(/checksum mismatch/);
  });

  it('rolls a failing migration back and records nothing for it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'migrations-'));
    await cp(defaultMigrationsDir, dir, { recursive: true });
    await writeFile(
      path.join(dir, '9999_broken.sql'),
      'CREATE TABLE half_done (id int); SELECT 1/0;\n',
    );
    await expect(migrate(testAdminUrl(), { dir })).rejects.toThrow(/9999_broken failed/);
    const t = await admin.query("SELECT to_regclass('public.half_done') AS t");
    expect(t.rows[0].t).toBeNull();
    const v = await admin.query("SELECT 1 FROM schema_migrations WHERE version = '9999'");
    expect(v.rowCount).toBe(0);
  });

  it('applies from a brand-new empty database', async () => {
    const name = 'ledgerline_empty_check';
    const server = new pg.Client({ connectionString: serverAdminUrl() });
    await server.connect();
    try {
      await server.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await server.query(`CREATE DATABASE ${name}`);
      const url = new URL(serverAdminUrl());
      url.pathname = `/${name}`;
      const result = await migrate(url.toString());
      expect(result.applied.length).toBeGreaterThanOrEqual(1);
      expect((await migrate(url.toString())).applied).toEqual([]);
    } finally {
      await server.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await server.end();
    }
  });
});

describe('schema', () => {
  it('has exactly the expected tables, all owned by ledgerline_owner', async () => {
    const { rows } = await admin.query(
      `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
         AND c.relname <> 'schema_migrations'
       ORDER BY c.relname`,
    );
    expect(rows.map((r) => r.relname)).toEqual(TABLES);
    for (const r of rows) expect(r.owner).toBe('ledgerline_owner');
  });

  it('has a tenant_id column and a foreign key to tenants on every tenant-owned table', async () => {
    const tenantOwned = TABLES.filter((t) => !['tenants', 'users'].includes(t));
    for (const table of tenantOwned) {
      const col = await admin.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name=$1 AND column_name='tenant_id'`,
        [table],
      );
      expect(col.rowCount, `${table}.tenant_id`).toBe(1);
      const fk = await admin.query(
        `SELECT 1 FROM pg_constraint
         WHERE conrelid = ('public.' || $1)::regclass AND contype = 'f'
           AND confrelid = 'public.tenants'::regclass`,
        [table],
      );
      // job_attempts and dead_letters reach tenants through the composite FK to jobs.
      const viaJobs = ['job_attempts', 'dead_letters'].includes(table);
      if (!viaJobs) expect(fk.rowCount, `${table} FK to tenants`).toBeGreaterThanOrEqual(1);
    }
  });

  it('partitions usage_events by month and keeps the partition key in the primary key', async () => {
    const pk = await admin.query(
      `SELECT array_agg(a.attname::text ORDER BY a.attname) AS cols
       FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
       WHERE i.indrelid = 'usage_events'::regclass AND i.indisprimary`,
    );
    expect(pk.rows[0].cols).toEqual(['id', 'occurred_at']);
    const parts = await admin.query(
      `SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = 'usage_events'::regclass`,
    );
    expect(parts.rows[0].n).toBe(48);
    const strategy = await admin.query(
      `SELECT partstrat FROM pg_partitioned_table WHERE partrelid = 'usage_events'::regclass`,
    );
    expect(strategy.rows[0].partstrat).toBe('r');
  });

  it('stores only a hash plus a prefix for API keys (no raw key column)', async () => {
    const { rows } = await admin.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'api_keys' ORDER BY column_name`,
    );
    const cols = rows.map((r) => r.column_name);
    expect(cols).toContain('key_hash');
    expect(cols).toContain('key_prefix');
    expect(cols).not.toContain('key');
    expect(cols).not.toContain('secret');
    await inTx(async (c) => {
      const t = await c.query(`INSERT INTO tenants (name) VALUES ('keys') RETURNING id`);
      await expect(
        c.query(
          `INSERT INTO api_keys (tenant_id, key_prefix, key_hash) VALUES ($1, 'lk_x', 'not-a-sha256-hash')`,
          [t.rows[0].id],
        ),
      ).rejects.toThrow(/check/i);
    });
  });

  it('allows only owner/admin/member as membership roles', async () => {
    await inTx(async (c) => {
      const t = await c.query(`INSERT INTO tenants (name) VALUES ('t') RETURNING id`);
      const u = await c.query(
        `INSERT INTO users (email) VALUES ('role-check@example.com') RETURNING id`,
      );
      await expect(
        c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'root')`, [
          t.rows[0].id,
          u.rows[0].id,
        ]),
      ).rejects.toThrow(/check/i);
    });
  });
});

describe('roles', () => {
  it('app role is not superuser, cannot bypass RLS, and owns nothing', async () => {
    const r = await admin.query(
      `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin
       FROM pg_roles WHERE rolname = 'ledgerline_app'`,
    );
    expect(r.rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolcanlogin: true,
    });
    const owned = await admin.query(
      `SELECT count(*)::int AS n FROM pg_class c WHERE pg_get_userbyid(c.relowner) = 'ledgerline_app'`,
    );
    expect(owned.rows[0].n).toBe(0);
  });

  it('owner role is not superuser and cannot log in directly', async () => {
    const r = await admin.query(
      `SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'ledgerline_owner'`,
    );
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcanlogin: false });
  });

  it('the app role cannot create tables', async () => {
    await expect(app.query('CREATE TABLE app_made (id int)')).rejects.toThrow(/permission denied/);
  });
});

describe('credit_ledger is append-only', () => {
  it('rejects UPDATE, DELETE and TRUNCATE via trigger even for a superuser', async () => {
    await inTx(async (c) => {
      const t = await c.query(`INSERT INTO tenants (name) VALUES ('ledger') RETURNING id`);
      await c.query(
        `INSERT INTO credit_ledger (tenant_id, amount, kind) VALUES ($1, 10, 'grant')`,
        [t.rows[0].id],
      );
      for (const sql of [
        'UPDATE credit_ledger SET amount = 99',
        'DELETE FROM credit_ledger',
        'TRUNCATE credit_ledger',
      ]) {
        await c.query('SAVEPOINT s1');
        await expect(c.query(sql), sql).rejects.toThrow(/append-only/);
        await c.query('ROLLBACK TO s1');
      }
    });
  });

  it('has no UPDATE/DELETE/TRUNCATE privilege for the app role', async () => {
    for (const priv of ['UPDATE', 'DELETE', 'TRUNCATE']) {
      const r = await admin.query(
        `SELECT has_table_privilege('ledgerline_app', 'credit_ledger', $1) AS ok`,
        [priv],
      );
      expect(r.rows[0].ok, priv).toBe(false);
    }
  });
});
