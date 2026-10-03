/** Test-only helpers. Not exported from the package index. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { provisionReaderRole } from '../source.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ?? 'postgres://ledgerworks:ledgerworks@localhost:5432/ledgerworks';
export const DEMO_DB = 'ledgerline_demo';
export const BENCH_DB = 'ledgerworks';
/** Development-only credentials of the read-only role (not a secret). */
export const READER_ROLE = 'shadow_reader';
export const READER_PASSWORD = 'shadow_reader_dev';

export function withDb(url: string, db: string, user?: string, password?: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

export const adminUrlFor = (db: string): string => withDb(ADMIN_URL, db);
export const readerUrlFor = (db: string): string =>
  withDb(ADMIN_URL, db, READER_ROLE, READER_PASSWORD);

export async function ensureReaderRole(db: string): Promise<void> {
  await provisionReaderRole(ADMIN_URL, {
    role: READER_ROLE,
    password: READER_PASSWORD,
    database: db,
  });
}

function pnpm(args: string[], db: string): void {
  const r = spawnSync('pnpm', args, {
    cwd: repoRoot,
    shell: true,
    env: { ...process.env, DATABASE_ADMIN_URL: adminUrlFor(db) },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
}

/**
 * The small Ledgerline demo database (two tenants, about 31k usage events, jobs in every state).
 * Created from the migrations and `seed:demo` when it does not exist yet; reused otherwise.
 * Returns the administrator URL of it.
 */
export async function ensureDemoSource(): Promise<string> {
  const server = new pg.Client({ connectionString: ADMIN_URL });
  await server.connect();
  try {
    const exists = await server.query('SELECT 1 FROM pg_database WHERE datname = $1', [DEMO_DB]);
    if (!exists.rowCount) await server.query(`CREATE DATABASE ${DEMO_DB}`);
  } finally {
    await server.end();
  }
  pnpm(['--filter', '@ledgerworks/ledgerline', 'migrate'], DEMO_DB);
  const db = new pg.Client({ connectionString: adminUrlFor(DEMO_DB) });
  await db.connect();
  let tenants = 0;
  try {
    tenants = Number(
      (await db.query<{ n: string }>('SELECT count(*) AS n FROM tenants')).rows[0]!.n,
    );
  } finally {
    await db.end();
  }
  if (tenants === 0) pnpm(['--filter', '@ledgerworks/ledgerline', 'seed:demo'], DEMO_DB);
  await ensureReaderRole(DEMO_DB);
  return adminUrlFor(DEMO_DB);
}
