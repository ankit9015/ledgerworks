/**
 * A small, fast, deterministic demo/e2e dataset (about a second, versus about 7 minutes for the
 * 10M-row benchmark seed): two tenants, "huge" (30,000 usage events) and "small" (600), with usage in
 * the last 60 days, a consistent credit ledger, and jobs in every state including dead letters.
 * Everything is synthetic. Raw API keys are written to .seed/keys-demo.json (gitignored, mode 600,
 * never printed) in the same shape as the benchmark seed's keys.json, so the UI end-to-end test can
 * read either. It adds tenants to the database it is pointed at and does not delete anything. NOTE: do not run it
 * on the benchmark database (it would change the exact 10,000,000-row count the benchmarks check);
 * use a separate database, e.g. DATABASE_ADMIN_URL=.../ledgerline_demo (see ledgerline/README.md).
 *
 *   pnpm --filter @ledgerworks/ledgerline seed:demo
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { adminUrl } from '../db/config.js';
import { generateApiKey } from '../keys.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const TENANTS = [
  { size: 'huge', rank: 1, events: 30_000, name: 'Demo huge tenant' },
  { size: 'small', rank: 2, events: 600, name: 'Demo small tenant' },
];

/** Local databases only, and only the development ones (the benchmark database or a demo copy). */
function assertLocalDemoDatabase(url: string): void {
  const u = new URL(url);
  const db = decodeURIComponent(u.pathname.slice(1));
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname)) {
    throw new Error(`Refusing to seed: host "${u.hostname}" is not local`);
  }
  if (!['ledgerworks', 'ledgerline_demo'].includes(db)) {
    throw new Error(`Refusing to seed: database "${db}" is not ledgerworks or ledgerline_demo`);
  }
}

async function main(): Promise<void> {
  assertLocalDemoDatabase(adminUrl());
  const db = new pg.Client({ connectionString: adminUrl() });
  await db.connect();
  const out: unknown[] = [];
  try {
    for (const t of TENANTS) {
      const key = generateApiKey();
      const created = await db.query<{ id: string }>(
        `SELECT ledgerline_fn.create_tenant($1, $2, $3, $4) AS id`,
        [t.name, `${t.size}-${Date.now()}@demo.test`, key.hash, key.prefix],
      );
      const id = created.rows[0]!.id;
      // Usage: spread over the last 60 days, a few event types, hash-derived quantities.
      await db.query(
        `INSERT INTO usage_events (tenant_id, occurred_at, event_type, quantity)
         SELECT $1::uuid, now() - (g * interval '60 days' / $2::int) - (hashtext($1::uuid::text || g) % 3600) * interval '1 second',
                (ARRAY['llm.tokens','image.generated','embedding.tokens','api.call'])[1 + abs(hashtext(g::text)) % 4],
                1 + abs(hashtext($1::uuid::text || 'q' || g)) % 500
         FROM generate_series(1, $2::int) g`,
        [id, t.events],
      );
      // Ledger: one grant, then debits and a refund; balance_after and the balance row agree.
      await db.query(
        `WITH rows AS (
           SELECT * FROM (VALUES
             (1, 'grant', 20000, 'initial grant'), (2, 'debit', -2500, 'usage 2026-08'),
             (3, 'debit', -3100, 'usage 2026-09'), (4, 'refund', 400, 'goodwill refund'),
             (5, 'debit', -1800, 'usage 2026-10'), (6, 'grant', 5000, 'top-up')
           ) AS v(n, kind, amount, reference)
         ), run AS (
           SELECT n, kind, amount, reference, sum(amount) OVER (ORDER BY n) AS bal FROM rows
         ), ins AS (
           INSERT INTO credit_ledger (tenant_id, amount, kind, reference, balance_after, created_at)
           SELECT $1::uuid, amount, kind, reference, bal, now() - (7 - n) * interval '3 days' FROM run ORDER BY n
           RETURNING 1
         )
         UPDATE credit_balances SET balance = (SELECT sum(amount) FROM rows), updated_at = now()
         WHERE tenant_id = $1::uuid`,
        [id],
      );
      // Jobs in every state; the dead ones also have dead_letters rows.
      await db.query(
        `INSERT INTO jobs (tenant_id, queue, type, status, run_at, attempts, max_attempts, last_error)
         SELECT $1::uuid, 'demo', 'demo.' || s.t, s.st, now() - s.age * interval '1 second', s.att, 3, s.err
         FROM (VALUES
           ('noop','queued',120,0,NULL), ('noop','queued',45,0,NULL), ('flaky','failed',30,1,'first attempt fails'),
           ('noop','running',5,1,NULL), ('noop','succeeded',600,1,NULL), ('noop','succeeded',500,1,NULL),
           ('noop','succeeded',400,1,NULL), ('doomed','dead',900,3,'always fails'), ('doomed','dead',800,3,'always fails')
         ) AS s(t, st, age, att, err)`,
        [id],
      );
      await db.query(
        `INSERT INTO dead_letters (tenant_id, job_id, type, payload, attempts, last_error, dead_at)
         SELECT tenant_id, id, type, payload, attempts, last_error, now() - interval '10 minutes'
         FROM jobs WHERE tenant_id = $1::uuid AND status = 'dead'`,
        [id],
      );
      out.push({ size: t.size, rank: t.rank, tenantId: id, events: t.events, apiKey: key.raw });
    }
    await db.query('ANALYZE usage_events');
  } finally {
    await db.end();
  }
  const dir = path.join(repoRoot, '.seed');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'keys-demo.json'),
    JSON.stringify(
      { seed: 'demo', note: 'synthetic demo tenants; secrets, do not commit', tenants: out },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    `demo seed done: ${TENANTS.length} tenants; raw keys written to .seed/keys-demo.json (not printed)`,
  );
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
