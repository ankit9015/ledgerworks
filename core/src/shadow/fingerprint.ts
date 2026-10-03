import pg from 'pg';
import { qtable } from './sql.js';

const EXCLUDED_SCHEMAS = `('pg_catalog','information_schema','ledgerworks_meta','ledgerworks_ext')`;
const NOT_TOAST = `n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'`;

/**
 * A canonical, sorted list of lines describing everything structural in the database: relations
 * (kind, owner, RLS flags, partitioning, ACL, options), columns, indexes, constraints, policies,
 * triggers, functions, sequences, views, enum types and extensions. An unset ACL is shown as the
 * default ACL it stands for (a GRANT followed by a REVOKE leaves an explicit but equal ACL behind). Two databases with the same
 * snapshot have the same schema for the purposes of C2.1. The shadow runner's own schemas
 * (ledgerworks_meta, ledgerworks_ext) are left out.
 */
export async function schemaSnapshot(client: pg.ClientBase): Promise<string[]> {
  const r = await client.query<{ line: string }>(`
    SELECT line FROM (
      SELECT format('relation|%I.%I|kind=%s|owner=%s|rls=%s|force=%s|partition=%s|key=%s|bound=%s|acl=%s|opts=%s|persist=%s',
               n.nspname, c.relname, c.relkind, pg_get_userbyid(c.relowner), c.relrowsecurity, c.relforcerowsecurity,
               COALESCE((SELECT format('%I.%I', pn.nspname, pc.relname) FROM pg_inherits i
                           JOIN pg_class pc ON pc.oid = i.inhparent JOIN pg_namespace pn ON pn.oid = pc.relnamespace
                          WHERE i.inhrelid = c.oid AND c.relispartition), '-'),
               COALESCE(CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END, '-'),
               COALESCE(pg_get_expr(c.relpartbound, c.oid), '-'),
               COALESCE(c.relacl, acldefault((CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END)::"char", c.relowner))::text,
               COALESCE(c.reloptions::text, '-'), c.relpersistence) AS line
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname NOT IN ${EXCLUDED_SCHEMAS} AND ${NOT_TOAST} AND c.relkind IN ('r','p','v','m','S','f')
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
      UNION ALL
      SELECT format('column|%I.%I|%s|%I|%s|notnull=%s|default=%s|identity=%s|generated=%s|collation=%s',
               n.nspname, c.relname, a.attnum, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
               COALESCE(pg_get_expr(d.adbin, d.adrelid), '-'), a.attidentity, a.attgenerated, a.attcollation::regcollation)
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attnum > 0 AND NOT a.attisdropped AND n.nspname NOT IN ${EXCLUDED_SCHEMAS} AND ${NOT_TOAST}
         AND c.relkind IN ('r','p','v','m','f')
         AND NOT EXISTS (SELECT 1 FROM pg_depend dd WHERE dd.classid = 'pg_class'::regclass AND dd.objid = c.oid AND dd.deptype = 'e')
      UNION ALL
      SELECT format('index|%s|valid=%s', pg_get_indexdef(i.indexrelid), i.indisvalid)
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname NOT IN ${EXCLUDED_SCHEMAS} AND ${NOT_TOAST}
      UNION ALL
      SELECT format('constraint|%s|%I|%s|%s|validated=%s', con.conrelid::regclass, con.conname, con.contype,
               pg_get_constraintdef(con.oid), con.convalidated)
        FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace
       WHERE n.nspname NOT IN ${EXCLUDED_SCHEMAS} AND ${NOT_TOAST}
      UNION ALL
      SELECT format('policy|%I.%I|%I|permissive=%s|roles=%s|cmd=%s|using=%s|check=%s', schemaname, tablename, policyname,
               permissive, roles::text, cmd, COALESCE(qual, '-'), COALESCE(with_check, '-'))
        FROM pg_policies WHERE schemaname NOT IN ${EXCLUDED_SCHEMAS}
      UNION ALL
      SELECT format('trigger|%s', pg_get_triggerdef(t.oid))
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE NOT t.tgisinternal AND n.nspname NOT IN ${EXCLUDED_SCHEMAS} AND ${NOT_TOAST}
      UNION ALL
      SELECT format('function|%s|owner=%s|acl=%s|%s', p.oid::regprocedure, pg_get_userbyid(p.proowner),
               COALESCE(p.proacl, acldefault('f'::"char", p.proowner))::text, md5(pg_get_functiondef(p.oid)))
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT IN ${EXCLUDED_SCHEMAS} AND ${NOT_TOAST} AND p.prokind IN ('f','p')
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
      UNION ALL
      SELECT format('sequence|%I.%I|%s|start=%s|min=%s|max=%s|inc=%s|cycle=%s|cache=%s', schemaname, sequencename,
               data_type, start_value, min_value, max_value, increment_by, cycle, cache_size)
        FROM pg_sequences WHERE schemaname NOT IN ${EXCLUDED_SCHEMAS}
      UNION ALL
      SELECT format('view|%I.%I|%s', schemaname, viewname, md5(definition)) FROM pg_views WHERE schemaname NOT IN ${EXCLUDED_SCHEMAS}
      UNION ALL
      SELECT format('enum|%I.%I|%s', n.nspname, t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder))
        FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace JOIN pg_enum e ON e.enumtypid = t.oid
       WHERE n.nspname NOT IN ${EXCLUDED_SCHEMAS} GROUP BY n.nspname, t.typname
      UNION ALL
      SELECT format('extension|%s|%s', e.extname, n.nspname) FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
       WHERE n.nspname NOT IN ('ledgerworks_ext')
    ) x ORDER BY line`);
  // Sorted here (binary order) so that the result does not depend on the database's collation.
  return r.rows.map((x) => x.line).sort();
}

export interface SourceFingerprint {
  database: string;
  /** exact count(*) per ordinary table or partition (schema.table) */
  rowCounts: Record<string, number>;
  /** cumulative write counters of the database (pg_stat_database) */
  statDatabase: { tup_inserted: number; tup_updated: number; tup_deleted: number };
  /** cumulative write counters summed over all user tables (pg_stat_user_tables) */
  statTables: { n_tup_ins: number; n_tup_upd: number; n_tup_del: number; n_tup_hot_upd: number };
  /** md5 over the text form of every row of each small table (at most `checksumMaxRows` rows) */
  checksums: Record<string, string>;
}

/**
 * Fingerprint of a database: row counts, write counters and checksums of small tables. Take one
 * before and one after an operation; if the operation wrote nothing, they are equal. Use an
 * administrator connection or any role that can read the tables. Statistics are flushed
 * asynchronously by Postgres, so the call first waits for `settleMs`.
 */
export async function sourceFingerprint(
  url: string,
  o: { settleMs?: number; checksumMaxRows?: number } = {},
): Promise<SourceFingerprint> {
  await new Promise((resolve) => setTimeout(resolve, o.settleMs ?? 2000));
  const c = new pg.Client({ connectionString: url, application_name: 'ledgerworks-fingerprint' });
  await c.connect();
  try {
    await c.query('SELECT pg_stat_clear_snapshot()');
    const db = (await c.query<{ d: string }>('SELECT current_database() AS d')).rows[0]!.d;
    const tables = await c.query<{ s: string; t: string }>(
      `SELECT n.nspname AS s, c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog','information_schema') AND ${NOT_TOAST}
          AND n.nspname <> 'ledgerworks_meta' ORDER BY 1, 2`,
    );
    const rowCounts: Record<string, number> = {};
    const checksums: Record<string, string> = {};
    const max = o.checksumMaxRows ?? 50_000;
    for (const t of tables.rows) {
      const key = `${t.s}.${t.t}`;
      const n = Number(
        (await c.query<{ n: string }>(`SELECT count(*) AS n FROM ${qtable(t.s, t.t)}`)).rows[0]!.n,
      );
      rowCounts[key] = n;
      if (n <= max) {
        const m = await c.query<{ h: string }>(
          `SELECT md5(COALESCE(string_agg(x::text, ',' ORDER BY x::text), '')) AS h FROM ${qtable(t.s, t.t)} x`,
        );
        checksums[key] = m.rows[0]!.h;
      }
    }
    const sd = (
      await c.query<{ i: string; u: string; d: string }>(
        `SELECT tup_inserted::text AS i, tup_updated::text AS u, tup_deleted::text AS d FROM pg_stat_database WHERE datname = current_database()`,
      )
    ).rows[0]!;
    const st = (
      await c.query<{ i: string; u: string; d: string; h: string }>(
        `SELECT COALESCE(sum(n_tup_ins),0)::text AS i, COALESCE(sum(n_tup_upd),0)::text AS u,
                COALESCE(sum(n_tup_del),0)::text AS d, COALESCE(sum(n_tup_hot_upd),0)::text AS h FROM pg_stat_user_tables`,
      )
    ).rows[0]!;
    return {
      database: db,
      rowCounts,
      statDatabase: {
        tup_inserted: Number(sd.i),
        tup_updated: Number(sd.u),
        tup_deleted: Number(sd.d),
      },
      statTables: {
        n_tup_ins: Number(st.i),
        n_tup_upd: Number(st.u),
        n_tup_del: Number(st.d),
        n_tup_hot_upd: Number(st.h),
      },
      checksums,
    };
  } finally {
    await c.end();
  }
}

/** Differences between two fingerprints; an empty list means nothing changed. */
export function diffFingerprints(before: SourceFingerprint, after: SourceFingerprint): string[] {
  const d: string[] = [];
  const keys = new Set([...Object.keys(before.rowCounts), ...Object.keys(after.rowCounts)]);
  for (const k of keys) {
    if (before.rowCounts[k] !== after.rowCounts[k])
      d.push(`rows ${k}: ${before.rowCounts[k]} -> ${after.rowCounts[k]}`);
  }
  for (const k of Object.keys(before.checksums)) {
    if (before.checksums[k] !== after.checksums[k]) d.push(`checksum ${k} changed`);
  }
  for (const k of Object.keys(before.statDatabase) as (keyof SourceFingerprint['statDatabase'])[]) {
    if (before.statDatabase[k] !== after.statDatabase[k])
      d.push(`pg_stat_database.${k}: ${before.statDatabase[k]} -> ${after.statDatabase[k]}`);
  }
  for (const k of Object.keys(before.statTables) as (keyof SourceFingerprint['statTables'])[]) {
    if (before.statTables[k] !== after.statTables[k])
      d.push(`pg_stat_user_tables.${k}: ${before.statTables[k]} -> ${after.statTables[k]}`);
  }
  return d;
}
