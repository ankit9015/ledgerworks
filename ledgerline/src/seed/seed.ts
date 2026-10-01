/**
 * Seed script: resets the LOCAL DEVELOPMENT database and loads synthetic data.
 *
 *   pnpm seed --yes [--seed <value>]
 *
 * Everything below is synthetic. Data is generated with set-based SQL (generate_series) and is a
 * pure function of the seed value: the same seed always produces the same rows (ids and
 * timestamps included). Only API key secrets are random, and they are only written to .seed/.
 *
 * Safety: this file is never imported by the API. It connects with DATABASE_ADMIN_URL (a
 * superuser, which bypasses FORCE ROW LEVEL SECURITY) and refuses to run unless that URL points at
 * the local `ledgerworks` development database and --yes is given. See DECISIONS.md D17.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { adminUrl } from '../db/config.js';
import { migrate } from '../db/migrate.js';
import { generateApiKey } from '../keys.js';

export const DEV_DATABASE = 'ledgerworks';
const TOTAL_EVENTS = 10_000_000;
const TENANTS = 250;
const SKEW = 1.2; // Zipf exponent: tenant of rank i gets a share proportional to 1 / i^SKEW
const WINDOW_START = '2025-10-01'; // 365 days: 2025-10-01 .. 2026-09-30 (UTC)
const WINDOW_DAYS = 365;
/** Tenant ranks that get a usable API key written to .seed/keys.json. */
const SAMPLE_RANKS: { rank: number; size: string }[] = [
  { rank: 1, size: 'huge' },
  { rank: 5, size: 'large' },
  { rank: 25, size: 'medium' },
  { rank: 100, size: 'small' },
  { rank: 250, size: 'tiny' },
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function parseArgs(argv: string[]): { yes: boolean; seed: string } {
  const yes = argv.includes('--yes');
  const i = argv.indexOf('--seed');
  const seed = (i >= 0 ? argv[i + 1] : undefined) ?? process.env.SEED ?? '20251001';
  return { yes, seed };
}

/** Refuse anything that is not the local development database. */
export function assertLocalDevDatabase(url: string): void {
  const u = new URL(url);
  const host = u.hostname;
  const db = decodeURIComponent(u.pathname.slice(1));
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) {
    throw new Error(`Refusing to seed: host "${host}" is not local`);
  }
  if (db !== DEV_DATABASE) {
    throw new Error(`Refusing to seed: database "${db}" is not "${DEV_DATABASE}"`);
  }
}

const fmt = (n: number | string): string => Number(n).toLocaleString('en-US');
const t0 = Date.now();
const secs = (): string => ((Date.now() - t0) / 1000).toFixed(1).padStart(7) + 's';
const log = (msg: string): void => console.log(`[${secs()}] ${msg}`);

async function main(): Promise<void> {
  const { yes, seed } = parseArgs(process.argv.slice(2));
  const url = adminUrl();
  assertLocalDevDatabase(url);
  if (!yes) {
    console.log(
      `This will DELETE ALL DATA in the local "${DEV_DATABASE}" database and re-seed it\n` +
        `(${fmt(TOTAL_EVENTS)} usage events, ${TENANTS} tenants, seed "${seed}").\n` +
        `Re-run with --yes to continue:  pnpm seed --yes`,
    );
    process.exit(1);
  }

  log(`seed value: ${seed}`);
  const migrated = await migrate(url);
  log(
    `migrations: applied [${migrated.applied.join(', ')}], already applied [${migrated.skipped.join(', ')}]`,
  );

  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('SET TimeZone = UTC');
    const ver = await db.query<{ v: string }>("SELECT current_setting('server_version') AS v");
    log(`postgres ${ver.rows[0]!.v}`);

    // ---- reset -------------------------------------------------------------------------------
    // The ledger's TRUNCATE guard trigger is an ordinary trigger, so replica mode skips it for this
    // one reset statement. Reset immediately afterwards.
    await db.query('SET session_replication_role = replica');
    await db.query(
      `TRUNCATE dead_letters, job_attempts, jobs, credit_balances, credit_ledger, usage_events,
                api_keys, memberships, users, tenants RESTART IDENTITY CASCADE`,
    );
    await db.query('RESET session_replication_role');
    log('reset: all tables truncated');

    // ---- plan --------------------------------------------------------------------------------
    await db.query(
      `CREATE TEMP TABLE seed_days AS
       SELECT d AS day_idx, (DATE '${WINDOW_START}' + d) AS day,
              (CASE WHEN extract(isodow FROM DATE '${WINDOW_START}' + d) >= 6 THEN 0.45 ELSE 1.0 END)
              * (0.6 + 0.8 * d / ${WINDOW_DAYS - 1}.0) AS w
       FROM generate_series(0, ${WINDOW_DAYS - 1}) AS d`,
    );
    // day_starts[i] = cumulative share of all days before day i; width_bucket() inverts the CDF.
    await db.query(
      `CREATE TEMP TABLE seed_arr AS
       SELECT array_agg(c::float8 ORDER BY day_idx) AS day_starts
       FROM (SELECT day_idx, (sum(w) OVER (ORDER BY day_idx) - w) / sum(w) OVER () AS c FROM seed_days) s`,
    );
    await db.query(
      `CREATE TEMP TABLE seed_hours AS
       SELECT array_agg(c::float8 ORDER BY h) AS hour_starts
       FROM (SELECT h, (sum(w) OVER (ORDER BY h) - w) / sum(w) OVER () AS c
             FROM (SELECT h, 0.3 + exp(-power(h - 14, 2) / 32.0) AS w FROM generate_series(0, 23) h) x) s`,
    );
    await db.query(
      `CREATE TEMP TABLE seed_months AS
       SELECT m AS month_start,
              sum(w) / (SELECT sum(w) FROM seed_days) AS share,
              COALESCE((SELECT sum(w) FROM seed_days WHERE day < m), 0) / (SELECT sum(w) FROM seed_days) AS cum_lo,
              (SELECT sum(w) FROM seed_days WHERE day < (m + INTERVAL '1 month')::date)
                / (SELECT sum(w) FROM seed_days) AS cum_hi
       FROM (SELECT date_trunc('month', day)::date AS m, w, day FROM seed_days) x
       GROUP BY m`,
    );
    await db.query(
      `CREATE TEMP TABLE seed_tenants AS
       WITH w AS (SELECT i AS rank, 1 / power(i::numeric, $3::numeric) AS w FROM generate_series(1, $2::int) i),
            t AS (SELECT rank, w / sum(w) OVER () AS share FROM w),
            f AS (SELECT rank, floor($4::numeric * share)::bigint AS n0 FROM t),
            r AS (SELECT $4::numeric - sum(n0) AS rem FROM f)
       SELECT rank, md5($1 || ':tenant:' || rank)::uuid AS tenant_id,
              n0 + CASE WHEN rank <= (SELECT rem FROM r) THEN 1 ELSE 0 END AS n
       FROM f`,
      [seed, TENANTS, SKEW, TOTAL_EVENTS],
    );
    // Events per tenant per month, by largest remainder so each tenant's months add up exactly.
    await db.query(
      `CREATE TEMP TABLE seed_plan AS
       WITH x AS (SELECT t.rank, t.tenant_id, t.n, m.month_start, m.cum_lo, m.cum_hi, t.n * m.share AS exact
                  FROM seed_tenants t CROSS JOIN seed_months m),
            y AS (SELECT *, floor(exact)::bigint AS f, exact - floor(exact) AS frac FROM x),
            z AS (SELECT *, n - sum(f) OVER (PARTITION BY rank) AS rem,
                         row_number() OVER (PARTITION BY rank ORDER BY frac DESC, month_start) AS rn FROM y)
       SELECT rank, tenant_id, month_start, cum_lo::float8 AS cum_lo, cum_hi::float8 AS cum_hi,
              f + CASE WHEN rn <= rem THEN 1 ELSE 0 END AS n
       FROM z`,
    );
    const planned = await db.query<{ total: string; tenants: string }>(
      'SELECT sum(n) AS total, count(DISTINCT rank) AS tenants FROM seed_plan',
    );
    if (Number(planned.rows[0]!.total) !== TOTAL_EVENTS) {
      throw new Error(`plan adds up to ${planned.rows[0]!.total}, expected ${TOTAL_EVENTS}`);
    }
    log(`plan: ${planned.rows[0]!.tenants} tenants, ${fmt(planned.rows[0]!.total)} events`);

    // ---- tenants, users, memberships ---------------------------------------------------------
    await db.query(
      `INSERT INTO tenants (id, name, created_at)
       SELECT tenant_id, 'Tenant ' || lpad(rank::text, 3, '0'),
              TIMESTAMPTZ '2025-09-01 00:00:00+00' - rank * INTERVAL '1 hour'
       FROM seed_tenants ORDER BY rank`,
    );
    await db.query(
      `INSERT INTO users (id, email, created_at)
       SELECT md5($1 || ':user:' || t.rank || ':' || k)::uuid,
              'user' || k || '.t' || lpad(t.rank::text, 3, '0') || '@seed.example',
              TIMESTAMPTZ '2025-09-02 00:00:00+00'
       FROM seed_tenants t
       CROSS JOIN LATERAL generate_series(1, 3 + floor(30 / sqrt(t.rank))::int) AS k
       ORDER BY t.rank, k`,
      [seed],
    );
    await db.query(
      `INSERT INTO memberships (tenant_id, user_id, role, created_at)
       SELECT t.tenant_id, md5($1 || ':user:' || t.rank || ':' || k)::uuid,
              CASE k WHEN 1 THEN 'owner' WHEN 2 THEN 'admin' ELSE 'member' END,
              TIMESTAMPTZ '2025-09-02 00:00:00+00'
       FROM seed_tenants t
       CROSS JOIN LATERAL generate_series(1, 3 + floor(30 / sqrt(t.rank))::int) AS k
       ORDER BY t.rank, k`,
      [seed],
    );
    log('tenants, users, memberships inserted');

    // ---- usage events: one set-based INSERT per month ----------------------------------------
    const months = await db.query<{ m: string }>(
      `SELECT to_char(month_start, 'YYYY-MM-DD') AS m FROM seed_months ORDER BY month_start`,
    );
    for (const { m } of months.rows) {
      const started = Date.now();
      const r = await db.query(
        `INSERT INTO usage_events (id, tenant_id, occurred_at, event_type, quantity, metadata, created_at)
         SELECT q.id::uuid, p.tenant_id,
                TIMESTAMPTZ '${WINDOW_START} 00:00:00+00'
                  + make_interval(hours => (width_bucket(p.cum_lo + q.u1 * (p.cum_hi - p.cum_lo),
                                                         (SELECT day_starts FROM seed_arr)) - 1) * 24
                                           + width_bucket(q.u2, (SELECT hour_starts FROM seed_hours)) - 1)
                  + INTERVAL '1 microsecond' * floor(q.u3 * 3600 * 1000000),
                CASE WHEN q.u4 < 0.60 THEN 'llm.tokens'
                     WHEN q.u4 < 0.75 THEN 'embedding.tokens'
                     WHEN q.u4 < 0.85 THEN 'image.generated'
                     WHEN q.u4 < 0.95 THEN 'audio.seconds'
                     ELSE 'api.call' END,
                1 + floor(power(q.u5, 3) * 5000)::bigint,
                jsonb_build_object('model', 'model-' || (1 + floor(q.u6 * 4)::int)),
                TIMESTAMPTZ '${WINDOW_START} 00:00:00+00'
         FROM seed_plan p
         CROSS JOIN LATERAL generate_series(1, p.n) AS j
         CROSS JOIN LATERAL (SELECT md5($1 || ':ev:' || p.rank || ':' || $2::text || ':' || j) AS id) h
         CROSS JOIN LATERAL (
           SELECT h.id,
                  ('x' || substr(md5(h.id), 1, 8))::bit(32)::bigint / 4294967296.0::float8 AS u1,
                  ('x' || substr(md5(h.id), 9, 8))::bit(32)::bigint / 4294967296.0::float8 AS u2,
                  ('x' || substr(md5(h.id), 17, 8))::bit(32)::bigint / 4294967296.0::float8 AS u3,
                  ('x' || substr(md5(h.id), 25, 8))::bit(32)::bigint / 4294967296.0::float8 AS u4,
                  ('x' || substr(h.id, 1, 8))::bit(32)::bigint / 4294967296.0::float8 AS u5,
                  ('x' || substr(h.id, 9, 8))::bit(32)::bigint / 4294967296.0::float8 AS u6
         ) q
         WHERE p.month_start = $3::date AND p.n > 0`,
        [seed, m, m],
      );
      log(
        `  usage_events ${m}: ${fmt(r.rowCount ?? 0)} rows in ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
    }

    // ---- credits: ledger and balances, consistent by construction ----------------------------
    // Per tenant and month: one grant, one debit for that month's usage (1 credit per 100 units),
    // and for about 2% of tenant-months a small refund. Balance = sum of the ledger.
    await db.query(
      `CREATE TEMP TABLE seed_usage AS
       SELECT tenant_id, date_trunc('month', occurred_at)::date AS m, sum(quantity) AS q
       FROM usage_events GROUP BY 1, 2`,
    );
    await db.query(
      `INSERT INTO credit_ledger (tenant_id, amount, kind, idempotency_key, reference, created_at)
       SELECT tenant_id, amount, kind, key, ref, created_at FROM (
         SELECT u.tenant_id, (ceil(u.q / 100.0 * 1.15) + 1000)::bigint AS amount, 'grant' AS kind,
                'seed:grant:' || to_char(u.m, 'YYYY-MM') AS key, 'monthly grant' AS ref,
                u.m::timestamptz AS created_at
         FROM seed_usage u
         UNION ALL
         SELECT u.tenant_id, -ceil(u.q / 100.0)::bigint, 'debit',
                'usage:' || to_char(u.m, 'YYYY-MM'), 'usage ' || to_char(u.m, 'YYYY-MM'),
                (u.m + INTERVAL '1 month')::timestamptz - INTERVAL '1 second'
         FROM seed_usage u
         UNION ALL
         SELECT u.tenant_id, floor(ceil(u.q / 100.0) * 0.05)::bigint, 'refund',
                'seed:refund:' || to_char(u.m, 'YYYY-MM'), 'goodwill refund',
                (u.m + INTERVAL '1 month')::timestamptz
         FROM seed_usage u
         WHERE ('x' || substr(md5($1 || ':refund:' || u.tenant_id || u.m), 1, 4))::bit(16)::int % 50 = 0
           AND floor(ceil(u.q / 100.0) * 0.05) > 0
       ) l
       ORDER BY created_at, tenant_id, kind`,
      [seed],
    );
    await db.query(
      `INSERT INTO credit_balances (tenant_id, balance, updated_at)
       SELECT tenant_id, sum(amount), max(created_at) FROM credit_ledger GROUP BY tenant_id`,
    );
    log('credit_ledger and credit_balances inserted');

    // ---- API keys: every tenant gets one; raw keys only for the sample, written to .seed/ ----
    const tenantRows = await db.query<{ rank: number; tenant_id: string; n: string }>(
      'SELECT rank, tenant_id, n FROM seed_tenants ORDER BY rank',
    );
    const ids: string[] = [];
    const prefixes: string[] = [];
    const hashes: string[] = [];
    const sample: Record<string, unknown>[] = [];
    for (const t of tenantRows.rows) {
      const key = generateApiKey();
      ids.push(t.tenant_id);
      prefixes.push(key.prefix);
      hashes.push(key.hash);
      const s = SAMPLE_RANKS.find((x) => x.rank === t.rank);
      if (s) {
        sample.push({
          size: s.size,
          rank: t.rank,
          tenantId: t.tenant_id,
          events: Number(t.n),
          apiKey: key.raw,
        });
      }
    }
    await db.query(
      `INSERT INTO api_keys (tenant_id, key_prefix, key_hash)
       SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[])`,
      [ids, prefixes, hashes],
    );
    const dir = path.join(repoRoot, '.seed');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'keys.json'),
      JSON.stringify(
        { seed, note: 'synthetic tenants; secrets, do not commit', tenants: sample },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    log(
      `api keys: ${ids.length} created; ${sample.length} raw keys written to .seed/keys.json (not printed)`,
    );

    // ---- analyze and report ------------------------------------------------------------------
    await db.query('ANALYZE');
    log('ANALYZE done');
    await report(db, seed);
  } finally {
    await db.end();
  }
}

async function report(db: pg.Client, seed: string): Promise<void> {
  const q = async <T extends pg.QueryResultRow>(sql: string): Promise<T[]> =>
    (await db.query<T>(sql)).rows;

  console.log('\n=== row counts per table ===');
  const tables = [
    'tenants',
    'users',
    'memberships',
    'api_keys',
    'usage_events',
    'credit_ledger',
    'credit_balances',
    'jobs',
    'job_attempts',
    'dead_letters',
  ];
  for (const t of tables) {
    const r = await q<{ n: string }>(`SELECT count(*) AS n FROM ${t}`);
    console.log(`${t.padEnd(16)} ${fmt(r[0]!.n).padStart(12)}`);
  }

  console.log('\n=== usage_events distribution ===');
  const top = await q<{ n: string }>(
    `SELECT count(*) AS n FROM usage_events GROUP BY tenant_id ORDER BY n DESC`,
  );
  const total = top.reduce((a, r) => a + Number(r.n), 0);
  const top5 = top.slice(0, 5).reduce((a, r) => a + Number(r.n), 0);
  console.log(`tenants with events: ${top.length}`);
  console.log(
    `top 5 tenants: ${fmt(top5)} events = ${((top5 / total) * 100).toFixed(1)}% of all events`,
  );
  console.log(
    `largest tenant: ${fmt(top[0]!.n)} (${((Number(top[0]!.n) / total) * 100).toFixed(1)}%)`,
  );
  console.log(`smallest tenant: ${fmt(top[top.length - 1]!.n)} events`);
  console.log(`median tenant: ${fmt(top[Math.floor(top.length / 2)]!.n)} events`);

  console.log('\n=== usage_events per partition ===');
  const parts = await q<{ part: string; n: string }>(
    `SELECT c.relname AS part, (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM ' || quote_ident(c.relname), false, true, '')))[1]::text AS n
     FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'usage_events'::regclass ORDER BY c.relname`,
  );
  const nonEmpty = parts.filter((p) => Number(p.n) > 0);
  const sizes = nonEmpty.map((p) => Number(p.n));
  console.log(
    `${parts.length} partitions, ${nonEmpty.length} non-empty (${nonEmpty[0]!.part} .. ${nonEmpty[nonEmpty.length - 1]!.part}), ${parts.length - nonEmpty.length} empty`,
  );
  console.log(
    `rows per non-empty partition: min ${fmt(Math.min(...sizes))}, max ${fmt(Math.max(...sizes))}`,
  );

  console.log('\n=== credits consistency ===');
  const mism = await q<{ n: string }>(
    `SELECT count(*) AS n FROM credit_balances b
     FULL JOIN (SELECT tenant_id, sum(amount) AS s FROM credit_ledger GROUP BY tenant_id) l USING (tenant_id)
     WHERE b.balance IS DISTINCT FROM l.s`,
  );
  const neg = await q<{ n: string }>('SELECT count(*) AS n FROM credit_balances WHERE balance < 0');
  const orphan = await q<{ n: string }>(
    `SELECT count(*) AS n FROM tenants t WHERE NOT EXISTS (SELECT 1 FROM credit_balances b WHERE b.tenant_id = t.id)`,
  );
  console.log(`ledger-sum vs balance mismatches: ${mism[0]!.n}`);
  console.log(`negative balances: ${neg[0]!.n}; tenants without a balance row: ${orphan[0]!.n}`);
  if (Number(mism[0]!.n) !== 0) throw new Error('credit ledger/balance mismatch');

  console.log('\n=== determinism fingerprint ===');
  const fp = await q<{ fp: string }>(
    `SELECT md5(concat_ws('|', count(*), sum(quantity), sum(extract(epoch FROM occurred_at)::numeric),
                         sum(hashtext(id::text)::numeric), sum(hashtext(tenant_id::text || event_type)::numeric))) AS fp
     FROM usage_events`,
  );
  const lfp = await q<{ fp: string }>(
    `SELECT md5(concat_ws('|', count(*), sum(amount), sum(id), sum(hashtext(tenant_id::text || kind)::numeric))) AS fp
     FROM credit_ledger`,
  );
  console.log(`usage_events fingerprint: ${fp[0]!.fp}`);
  console.log(`credit_ledger fingerprint: ${lfp[0]!.fp}`);

  const size = await q<{ db: string; ue: string }>(
    `SELECT pg_size_pretty(pg_database_size(current_database())) AS db,
            pg_size_pretty(sum(pg_total_relation_size(c.oid))) AS ue
     FROM pg_class c WHERE c.oid = 'usage_events'::regclass
        OR c.oid IN (SELECT inhrelid FROM pg_inherits WHERE inhparent = 'usage_events'::regclass)`,
  );
  console.log(`\ntotal database size: ${size[0]!.db} (usage_events incl. indexes: ${size[0]!.ue})`);
  console.log(`seed value: ${seed}`);
  console.log(`total runtime: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// Only run when executed directly (so the guard can be unit tested).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`seed failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
