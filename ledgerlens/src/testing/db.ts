/** Test-only helpers: a scratch database on the local Postgres with a read-only role. Not exported from the package. */
import pg from 'pg';
import { provisionReaderRole } from '@ledgerworks/core';

export const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ?? 'postgres://ledgerworks:ledgerworks@localhost:5432/ledgerworks';
/** the same development-only read-only role the core tests use (not a secret) */
export const READER_ROLE = 'shadow_reader';
export const READER_PASSWORD = 'shadow_reader_dev';

export function urlFor(db: string, user?: string, password?: string): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}
export const adminUrlFor = (db: string): string => urlFor(db);
export const readerUrlFor = (db: string): string => urlFor(db, READER_ROLE, READER_PASSWORD);

export async function admin<T>(db: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: adminUrlFor(db) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export interface ScratchDb {
  name: string;
  adminUrl: string;
  readerUrl: string;
  drop(): Promise<void>;
}

/** Creates `ll_test_<random>` with pg_stat_statements and the read-only role; `setupSql` runs as the administrator. */
export async function createScratchDb(setupSql: string[] = []): Promise<ScratchDb> {
  const name = `ll_test_${Math.random().toString(36).slice(2, 10)}`;
  await admin('postgres', (c) => c.query(`CREATE DATABASE ${name}`));
  await admin(name, async (c) => {
    await c.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
    for (const s of setupSql) await c.query(s);
  });
  await provisionReaderRole(ADMIN_URL, {
    role: READER_ROLE,
    password: READER_PASSWORD,
    database: name,
  });
  return {
    name,
    adminUrl: adminUrlFor(name),
    readerUrl: readerUrlFor(name),
    async drop() {
      await admin('postgres', (c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    },
  };
}

/** forgets the statistics of ONE database only (never the cluster) */
export async function resetStatements(db: string): Promise<void> {
  await admin(db, (c) =>
    c.query(
      'SELECT pg_stat_statements_reset(0, (SELECT oid FROM pg_database WHERE datname = $1), 0)',
      [db],
    ),
  );
}
