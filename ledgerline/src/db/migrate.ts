import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const OWNER_ROLE = 'ledgerline_owner';
export const APP_ROLE = 'ledgerline_app';
export const DEFINER_ROLE = 'ledgerline_definer';

export const defaultMigrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

export interface BootstrapOptions {
  /** Password for the application role. Development default only. */
  appPassword?: string;
}

/** Quote a value as an SQL string literal (used only for role passwords in DDL). */
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Creates the three roles and the database-level grants they need. Must run as a superuser (or a
 * role with CREATEROLE). Safe to re-run; it also resets the app role password.
 *
 * - ledgerline_owner:   owns all tables and runs migrations. NOLOGIN: only reachable by SET ROLE.
 * - ledgerline_app:     the only role the API connects as. No BYPASSRLS, no ownership.
 * - ledgerline_definer: owns the few SECURITY DEFINER functions. NOLOGIN, no BYPASSRLS.
 */
export async function bootstrapRoles(
  client: pg.Client,
  options: BootstrapOptions = {},
): Promise<void> {
  const appPassword =
    options.appPassword ?? process.env.LEDGERLINE_APP_PASSWORD ?? 'ledgerline_app';
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${OWNER_ROLE}') THEN
        CREATE ROLE ${OWNER_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
      END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DEFINER_ROLE}') THEN
        CREATE ROLE ${DEFINER_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
      END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
      END IF;
    END $$`);
  await client.query(`ALTER ROLE ${APP_ROLE} PASSWORD ${literal(appPassword)}`);
  // The owner must be able to hand function ownership to the definer role.
  await client.query(`GRANT ${DEFINER_ROLE} TO ${OWNER_ROLE}`);
  const { rows } = await client.query<{ db: string }>('SELECT current_database() AS db');
  const db = `"${rows[0]!.db.replaceAll('"', '""')}"`;
  await client.query(`GRANT CONNECT ON DATABASE ${db} TO ${APP_ROLE}`);
  await client.query(`GRANT CREATE ON SCHEMA public TO ${OWNER_ROLE}`);
  // Needed for CREATE SCHEMA (the ledgerline_fn schema in 0002).
  await client.query(`GRANT CREATE ON DATABASE ${db} TO ${OWNER_ROLE}`);
}

export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export async function loadMigrations(dir: string = defaultMigrationsDir): Promise<MigrationFile[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const result: MigrationFile[] = [];
  for (const file of files) {
    const sql = await readFile(path.join(dir, file), 'utf8');
    result.push({
      version: file.slice(0, 4),
      name: file.slice(5, -4),
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  return result;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies pending migrations in order, each in its own transaction, as ledgerline_owner.
 * Applied migrations are tracked in schema_migrations with a checksum; editing an applied file
 * is an error. An advisory lock prevents two runners from racing.
 */
export async function migrate(
  adminUrl: string,
  options: { dir?: string; appPassword?: string } = {},
): Promise<MigrateResult> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await bootstrapRoles(client, { appPassword: options.appPassword });
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(`SET ROLE ${OWNER_ROLE}`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        name       text NOT NULL,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations',
    );
    const done = new Map(rows.map((r) => [r.version, r.checksum]));
    const result: MigrateResult = { applied: [], skipped: [] };

    for (const m of await loadMigrations(options.dir)) {
      const recorded = done.get(m.version);
      if (recorded !== undefined) {
        if (recorded !== m.checksum) {
          throw new Error(
            `Migration ${m.version}_${m.name} was edited after being applied (checksum mismatch)`,
          );
        }
        result.skipped.push(m.version);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [m.version, m.name, m.checksum],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.version}_${m.name} failed: ${(err as Error).message}`, {
          cause: err,
        });
      }
      result.applied.push(m.version);
    }
    return result;
  } finally {
    await client.end();
  }
}
