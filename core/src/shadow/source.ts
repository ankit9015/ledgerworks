import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { to as copyTo, type CopyToStreamQuery } from 'pg-copy-streams';
import { assertReadOnlySql, qi, ql } from './sql.js';

/** Settings that every connection to the source gets (startup options, so the server enforces them). */
export function sourceClientConfig(
  url: string,
  o: { statementTimeoutMs: number; lockTimeoutMs: number; applicationName: string },
): pg.ClientConfig {
  return {
    connectionString: url,
    application_name: o.applicationName,
    // row_security=off turns "silently filtered by RLS" into an error, as pg_dump does.
    options: [
      '-c default_transaction_read_only=on',
      `-c statement_timeout=${o.statementTimeoutMs}`,
      `-c lock_timeout=${o.lockTimeoutMs}`,
      '-c idle_in_transaction_session_timeout=0',
      '-c row_security=off',
    ].join(' '),
  };
}

export class SourceWritableError extends Error {
  constructor(public readonly reasons: string[]) {
    super(
      `Refusing to use this source: its role can write (${reasons.join('; ')}). ` +
        'Use a read-only role (see provisionReaderRole) or pass allowWritableSource explicitly.',
    );
    this.name = 'SourceWritableError';
  }
}

/** A connection to the source that can only run read-only statements. */
export class SourceSession {
  private constructor(public readonly client: pg.Client) {}

  static async connect(config: pg.ClientConfig): Promise<SourceSession> {
    const client = new pg.Client(config);
    await client.connect();
    const s = new SourceSession(client);
    const r = await client.query<{ v: string }>(
      "SELECT current_setting('default_transaction_read_only') AS v",
    );
    if (r.rows[0]?.v !== 'on') {
      await client.end();
      throw new Error('Source session is not read-only (default_transaction_read_only is not on)');
    }
    return s;
  }

  async query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<R>> {
    assertReadOnlySql(sql);
    return this.client.query<R>(sql, params);
  }

  /** COPY (SELECT ...) TO STDOUT as a stream. */
  copyOut(sql: string): CopyToStreamQuery {
    assertReadOnlySql(sql);
    return this.client.query(copyTo(sql));
  }

  /** Join an exported snapshot so that this session sees exactly the data the coordinator sees. */
  async beginAtSnapshot(snapshotId: string): Promise<void> {
    await this.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await this.query(`SET TRANSACTION SNAPSHOT ${ql(snapshotId)}`);
  }

  async end(): Promise<void> {
    try {
      await this.client.query('ROLLBACK');
    } catch {
      // not in a transaction or connection already gone
    }
    await this.client.end().catch(() => undefined);
  }
}

export interface WriteCheckResult {
  canWrite: boolean;
  reasons: string[];
  role: string;
  /** What each active probe did. A probe that is "denied" is the good outcome. */
  probes: {
    name: string;
    outcome: 'denied' | 'succeeded-rolled-back' | 'skipped';
    detail?: string;
  }[];
  roleAttributes: {
    superuser: boolean;
    bypassRls: boolean;
    createRole: boolean;
    createDb: boolean;
    replication: boolean;
  };
}

/**
 * Checks that the role behind `url` cannot write to the source. It does not trust the session
 * default: it opens a transaction, switches it to READ WRITE (any role may do that, so only
 * privileges are tested), takes a privilege inventory, then tries a CREATE SCHEMA and a no-row
 * DELETE (`DELETE ... WHERE false`, which still needs the DELETE privilege). Everything is rolled
 * back, whatever the outcome.
 */
export async function checkSourceReadOnly(url: string): Promise<WriteCheckResult> {
  const client = new pg.Client({
    connectionString: url,
    application_name: 'ledgerworks-shadow-writecheck',
  });
  await client.connect();
  const reasons: string[] = [];
  const probes: WriteCheckResult['probes'] = [];
  try {
    await client.query('BEGIN');
    try {
      await client.query('SET TRANSACTION READ WRITE');
    } catch (e) {
      if ((e as { code?: string }).code === '25006') {
        // read-only replica: the server itself refuses all writes
        const who = await client.query<{ u: string }>('SELECT current_user AS u');
        await client.query('ROLLBACK');
        return {
          canWrite: false,
          reasons: [],
          role: who.rows[0]!.u,
          probes: [
            {
              name: 'server-in-recovery',
              outcome: 'denied',
              detail: 'hot standby: the server refuses writes',
            },
          ],
          roleAttributes: {
            superuser: false,
            bypassRls: false,
            createRole: false,
            createDb: false,
            replication: false,
          },
        };
      }
      throw e;
    }
    const attrs = (
      await client.query(
        `SELECT current_user AS role, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
           FROM pg_roles WHERE rolname = current_user`,
      )
    ).rows[0] as Record<string, unknown>;
    const roleAttributes = {
      superuser: attrs.rolsuper === true,
      bypassRls: attrs.rolbypassrls === true,
      createRole: attrs.rolcreaterole === true,
      createDb: attrs.rolcreatedb === true,
      replication: attrs.rolreplication === true,
    };
    if (roleAttributes.superuser) reasons.push('role is a superuser');
    if (roleAttributes.createRole) reasons.push('role has CREATEROLE');
    if (roleAttributes.createDb) reasons.push('role has CREATEDB');
    if (roleAttributes.replication) reasons.push('role has REPLICATION');

    const inv = (
      await client.query<{
        tbl: string;
        seq: string;
        sch: string;
        db: boolean;
        wr: boolean;
        prog: boolean;
        files: boolean;
      }>(
        `SELECT
           (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT IN ('pg_catalog','information_schema')
               AND has_table_privilege(c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE'))::text AS tbl,
           (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relkind = 'S' AND n.nspname NOT IN ('pg_catalog','information_schema')
               AND CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(c.oid, 'USAGE,UPDATE') ELSE false END)::text AS seq,
           (SELECT count(*) FROM pg_namespace n
             WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'
               AND has_schema_privilege(n.oid, 'CREATE'))::text AS sch,
           has_database_privilege(current_database(), 'CREATE') AS db,
           pg_has_role(current_user, 'pg_write_all_data', 'USAGE') AS wr,
           pg_has_role(current_user, 'pg_execute_server_program', 'USAGE') AS prog,
           pg_has_role(current_user, 'pg_write_server_files', 'USAGE') AS files`,
      )
    ).rows[0]!;
    if (Number(inv.tbl) > 0)
      reasons.push(`INSERT/UPDATE/DELETE/TRUNCATE privilege on ${inv.tbl} relation(s)`);
    if (Number(inv.seq) > 0) reasons.push(`USAGE/UPDATE privilege on ${inv.seq} sequence(s)`);
    if (Number(inv.sch) > 0) reasons.push(`CREATE privilege on ${inv.sch} schema(s)`);
    if (inv.db) reasons.push('CREATE privilege on the database');
    if (inv.wr) reasons.push('member of pg_write_all_data');
    if (inv.prog) reasons.push('member of pg_execute_server_program');
    if (inv.files) reasons.push('member of pg_write_server_files');

    // Active probe 1: DDL.
    const schemaName = `ledgerworks_probe_${randomBytes(4).toString('hex')}`;
    await client.query('SAVEPOINT p1');
    try {
      await client.query(`CREATE SCHEMA ${qi(schemaName)}`);
      probes.push({ name: 'create-schema', outcome: 'succeeded-rolled-back' });
      reasons.push('CREATE SCHEMA succeeded (rolled back)');
    } catch (e) {
      probes.push({
        name: 'create-schema',
        outcome: 'denied',
        detail: (e as { code?: string }).code,
      });
    }
    await client.query('ROLLBACK TO SAVEPOINT p1');

    // Active probe 2: a harmless data write on the first user table: a DELETE that matches no row.
    const t = await client.query<{ s: string; n: string }>(
      `SELECT n.nspname AS s, c.relname AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
          AND n.nspname NOT LIKE 'pg\\_toast%' ORDER BY 1, 2 LIMIT 1`,
    );
    if (t.rows[0]) {
      await client.query('SAVEPOINT p2');
      try {
        await client.query(`DELETE FROM ${qi(t.rows[0].s)}.${qi(t.rows[0].n)} WHERE false`);
        probes.push({
          name: 'delete-no-rows',
          outcome: 'succeeded-rolled-back',
          detail: `${t.rows[0].s}.${t.rows[0].n}`,
        });
        reasons.push(`DELETE on ${t.rows[0].s}.${t.rows[0].n} succeeded (rolled back)`);
      } catch (e) {
        probes.push({
          name: 'delete-no-rows',
          outcome: 'denied',
          detail: (e as { code?: string }).code,
        });
      }
      await client.query('ROLLBACK TO SAVEPOINT p2');
    } else {
      probes.push({ name: 'delete-no-rows', outcome: 'skipped', detail: 'no user tables' });
    }
    await client.query('ROLLBACK');
    return {
      canWrite: reasons.length > 0,
      reasons,
      role: String(attrs.role),
      probes,
      roleAttributes,
    };
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    await client.end().catch(() => undefined);
  }
}

/**
 * Refuses to proceed when the role can write, unless `allowWritableSource` is set; the override is
 * logged loudly and recorded in the manifest.
 */
export async function assertSourceReadOnly(
  url: string,
  opts: { allowWritableSource?: boolean; log?: (msg: string) => void } = {},
): Promise<{ check: WriteCheckResult; overrideUsed: boolean }> {
  const check = await checkSourceReadOnly(url);
  if (!check.canWrite) return { check, overrideUsed: false };
  if (!opts.allowWritableSource) throw new SourceWritableError(check.reasons);
  const warn = opts.log ?? ((m: string) => console.warn(m));
  warn(
    `!!! OVERRIDE: the source role "${check.role}" CAN WRITE (${check.reasons.join('; ')}). ` +
      'Continuing because allowWritableSource was set. The runner itself only reads, via read-only sessions.',
  );
  return { check, overrideUsed: true };
}

/**
 * Creates (or updates) a role that is fit to be the shadow runner's source role: it can log in,
 * can read every table in the cluster (pg_read_all_data) and bypass row-level security (needed to
 * copy tables with FORCE ROW LEVEL SECURITY; without it the copy would silently miss rows), and
 * cannot write anything: no superuser, no CREATE anywhere, default_transaction_read_only = on.
 * Run this ONCE with an administrator connection; the runner never calls it. The password is
 * passed in by the caller and never logged.
 */
export async function provisionReaderRole(
  adminUrl: string,
  o: { role: string; password: string; database: string },
): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [o.role]);
    const attrs = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS INHERIT';
    await admin.query(
      `${exists.rowCount ? 'ALTER' : 'CREATE'} ROLE ${qi(o.role)} ${attrs} PASSWORD ${ql(o.password)}`,
    );
    await admin.query(`GRANT pg_read_all_data TO ${qi(o.role)}`);
    // read-only too: lets the role see the text of other sessions' statements in pg_stat_statements
    await admin.query(`GRANT pg_read_all_stats TO ${qi(o.role)}`);
    await admin.query(`ALTER ROLE ${qi(o.role)} SET default_transaction_read_only = on`);
    await admin.query(`GRANT CONNECT ON DATABASE ${qi(o.database)} TO ${qi(o.role)}`);
  } finally {
    await admin.end();
  }
}

// ---------------------------------------------------------------------------------------------
// Catalog introspection (all read-only SELECTs on the snapshot session)
// ---------------------------------------------------------------------------------------------

export interface CatalogRelation {
  oid: number;
  schema: string;
  name: string;
  /** r = ordinary or partition leaf, p = partitioned parent */
  relkind: 'r' | 'p';
  isPartition: boolean;
  parentOid: number | null;
  /** an ordinary table that other tables inherit from (legacy inheritance): copy with FROM ONLY */
  isInheritanceParent: boolean;
  /** columns that can be copied (not dropped, not generated), in attribute order */
  columns: string[];
  bytes: number;
  estRows: number;
}

export interface CatalogFk {
  childOid: number;
  parentOid: number;
  childCols: string[];
  parentCols: string[];
}

export interface Catalog {
  relations: CatalogRelation[];
  /** primary key columns by relation oid (top-level logical tables) */
  primaryKeys: Map<number, string[]>;
  fks: CatalogFk[];
}

const SYSTEM_SCHEMAS = `('pg_catalog','information_schema','ledgerworks_meta')`;

export async function readCatalog(s: SourceSession): Promise<Catalog> {
  const rels = await s.query<{
    oid: string;
    schema: string;
    name: string;
    relkind: 'r' | 'p';
    relispartition: boolean;
    parent_oid: string | null;
    has_inheritors: boolean;
    bytes: string;
    est_rows: string;
  }>(
    `SELECT c.oid::bigint::text AS oid, n.nspname AS schema, c.relname AS name, c.relkind, c.relispartition,
            (SELECT i.inhparent::bigint::text FROM pg_inherits i WHERE i.inhrelid = c.oid AND c.relispartition) AS parent_oid,
            (SELECT count(*) > 0 FROM pg_inherits i WHERE i.inhparent = c.oid) AS has_inheritors,
            pg_total_relation_size(c.oid)::text AS bytes, GREATEST(c.reltuples, 0)::bigint::text AS est_rows
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ${SYSTEM_SCHEMAS}
        AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'
        AND c.relpersistence <> 't'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
      ORDER BY n.nspname, c.relname`,
  );
  const attrs = await s.query<{ oid: string; attnum: number; attname: string; copyable: boolean }>(
    `SELECT a.attrelid::bigint::text AS oid, a.attnum, a.attname, (a.attgenerated = '') AS copyable
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r','p')
        AND n.nspname NOT IN ${SYSTEM_SCHEMAS} AND n.nspname NOT LIKE 'pg\\_toast%'
      ORDER BY a.attrelid, a.attnum`,
  );
  const colsByOid = new Map<number, { attnum: number; name: string; copyable: boolean }[]>();
  for (const a of attrs.rows) {
    const k = Number(a.oid);
    const list = colsByOid.get(k) ?? [];
    list.push({ attnum: a.attnum, name: a.attname, copyable: a.copyable });
    colsByOid.set(k, list);
  }
  const relations: CatalogRelation[] = rels.rows.map((r) => ({
    oid: Number(r.oid),
    schema: r.schema,
    name: r.name,
    relkind: r.relkind,
    isPartition: r.relispartition,
    parentOid: r.parent_oid === null ? null : Number(r.parent_oid),
    isInheritanceParent: r.relkind === 'r' && !r.relispartition && r.has_inheritors,
    columns: (colsByOid.get(Number(r.oid)) ?? []).filter((c) => c.copyable).map((c) => c.name),
    bytes: Number(r.bytes),
    estRows: Number(r.est_rows),
  }));
  const nameOf = (oid: number, attnum: number): string => {
    const c = colsByOid.get(oid)?.find((x) => x.attnum === attnum);
    if (!c) throw new Error(`catalog: column ${attnum} of relation ${oid} not found`);
    return c.name;
  };
  const cons = await s.query<{
    contype: string;
    conrelid: string;
    confrelid: string;
    conkey: number[];
    confkey: number[] | null;
  }>(
    `SELECT contype, conrelid::bigint::text AS conrelid, confrelid::bigint::text AS confrelid, conkey, confkey
       FROM pg_constraint WHERE contype IN ('p','f') AND conparentid = 0`,
  );
  const known = new Set(relations.map((r) => r.oid));
  const primaryKeys = new Map<number, string[]>();
  const fks: CatalogFk[] = [];
  for (const c of cons.rows) {
    const child = Number(c.conrelid);
    if (!known.has(child)) continue;
    if (c.contype === 'p') {
      primaryKeys.set(
        child,
        c.conkey.map((n) => nameOf(child, n)),
      );
    } else {
      const parent = Number(c.confrelid);
      if (!known.has(parent)) continue;
      fks.push({
        childOid: child,
        parentOid: parent,
        childCols: c.conkey.map((n) => nameOf(child, n)),
        parentCols: (c.confkey ?? []).map((n) => nameOf(parent, n)),
      });
    }
  }
  return { relations, primaryKeys, fks };
}

export interface SourceRole {
  name: string;
  superuser: boolean;
  inherit: boolean;
  createRole: boolean;
  createDb: boolean;
  bypassRls: boolean;
}

export interface SourceInfo {
  database: string;
  serverVersion: string;
  extensions: { name: string; version: string }[];
  roles: SourceRole[];
  memberships: { role: string; member: string }[];
  /** ALTER ROLE/DATABASE ... SET entries: role null = database-wide */
  roleSettings: { role: string | null; name: string; value: string }[];
  settings: Record<string, string>;
  rlsTablesWithoutBypass: string[];
}

/** Settings that only steer the planner (never allocate memory); copied to the shadow by default. */
export const PLANNER_SETTINGS = [
  'seq_page_cost',
  'random_page_cost',
  'cpu_tuple_cost',
  'cpu_index_tuple_cost',
  'cpu_operator_cost',
  'parallel_setup_cost',
  'parallel_tuple_cost',
  'effective_cache_size',
  'effective_io_concurrency',
  'default_statistics_target',
  'jit',
  'work_mem',
  'max_parallel_workers_per_gather',
] as const;

/** Reported side by side in the manifest. */
export const REPORTED_SETTINGS = [
  ...PLANNER_SETTINGS,
  'shared_buffers',
  'maintenance_work_mem',
  'max_wal_size',
] as const;

export async function readSourceInfo(s: SourceSession): Promise<SourceInfo> {
  const head = (
    await s.query<{ db: string; v: string }>(
      `SELECT current_database() AS db, current_setting('server_version') AS v`,
    )
  ).rows[0]!;
  const ext = await s.query<{ extname: string; extversion: string }>(
    'SELECT extname, extversion FROM pg_extension ORDER BY extname',
  );
  const roles = await s.query<{
    rolname: string;
    rolsuper: boolean;
    rolinherit: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolbypassrls: boolean;
  }>(
    `SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolbypassrls
       FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY rolname`,
  );
  const mem = await s.query<{ role: string; member: string }>(
    `SELECT r.rolname AS role, m.rolname AS member FROM pg_auth_members am
       JOIN pg_roles r ON r.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
      WHERE r.rolname !~ '^pg_' AND m.rolname !~ '^pg_'`,
  );
  const rs = await s.query<{ rolname: string | null; cfg: string }>(
    `SELECT r.rolname, unnest(st.setconfig) AS cfg FROM pg_db_role_setting st
       LEFT JOIN pg_roles r ON r.oid = st.setrole
      WHERE st.setdatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))`,
  );
  const roleSettings = rs.rows.map((r) => {
    const i = r.cfg.indexOf('=');
    return { role: r.rolname, name: r.cfg.slice(0, i), value: r.cfg.slice(i + 1) };
  });
  const settings: Record<string, string> = {};
  for (const name of REPORTED_SETTINGS) {
    const r = await s.query<{ v: string }>('SELECT current_setting($1) AS v', [name]);
    settings[name] = r.rows[0]!.v;
  }
  // Tables with RLS that this session's role cannot read unfiltered: a copy would miss rows.
  const rls = await s.query<{ t: string }>(
    `SELECT format('%I.%I', n.nspname, c.relname) AS t
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relrowsecurity AND c.relkind IN ('r','p') AND n.nspname NOT IN ${SYSTEM_SCHEMAS}
        AND NOT (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user)`,
  );
  return {
    database: head.db,
    serverVersion: head.v,
    extensions: ext.rows.map((e) => ({ name: e.extname, version: e.extversion })),
    roles: roles.rows.map((r) => ({
      name: r.rolname,
      superuser: r.rolsuper,
      inherit: r.rolinherit,
      createRole: r.rolcreaterole,
      createDb: r.rolcreatedb,
      bypassRls: r.rolbypassrls,
    })),
    memberships: mem.rows,
    roleSettings,
    settings,
    rlsTablesWithoutBypass: rls.rows.map((r) => r.t),
  };
}
