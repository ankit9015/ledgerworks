/**
 * Write cost of the redundant credit_ledger index (O5 / E4). On a freshly created and migrated
 * scratch database per run, with and without `credit_ledger_tenant_id_idx` (dropped by migration
 * 0007; the "with" variant recreates it as 0001 defined it):
 *   1. bulk insert of 100,000 ledger rows (superuser, one statement);
 *   2. 5,000 sequential debits through the real function (app role, one connection, one tenant).
 * Variants alternate (with, without, with, ...) so drift hits both equally. Synthetic data only.
 *
 *   pnpm --filter @ledgerworks/ledgerline bench:ledger
 */
import pg from 'pg';
import { adminUrl, appUrlFrom } from '../db/config.js';
import { migrate } from '../db/migrate.js';
import { debitCredits } from '../credits.js';

const DB = 'ledgerline_bench_ledger';
const BULK_ROWS = 100_000;
const DEBITS = 5_000;
const RUNS = 5;

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

async function oneRun(withIndex: boolean): Promise<{ bulkMs: number; debitMs: number }> {
  const server = new pg.Client({ connectionString: adminUrl() });
  await server.connect();
  await server.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await server.query(`CREATE DATABASE ${DB}`);
  await server.end();
  const dbAdmin = withDb(adminUrl(), DB);
  await migrate(dbAdmin);
  const admin = new pg.Pool({ connectionString: dbAdmin, max: 2 });
  const app = new pg.Pool({ connectionString: appUrlFrom(dbAdmin), max: 1 });
  try {
    if (withIndex) {
      // Migration 0007 dropped this index; recreate it exactly as 0001 defined it.
      const c = await admin.connect();
      try {
        await c.query('SET ROLE ledgerline_owner');
        await c.query('CREATE INDEX credit_ledger_tenant_id_idx ON credit_ledger (tenant_id, id)');
      } finally {
        await c.query('RESET ROLE');
        c.release();
      }
    }
    const t = await admin.query<{ id: string }>(
      `INSERT INTO tenants (name) VALUES ('bench-a'), ('bench-b') RETURNING id`,
    );
    const [a, b] = [t.rows[0]!.id, t.rows[1]!.id];
    await admin.query(`INSERT INTO credit_balances (tenant_id, balance) VALUES ($1, 1000000000)`, [
      a,
    ]);

    const t0 = performance.now();
    await admin.query(
      `INSERT INTO credit_ledger (tenant_id, amount, kind, idempotency_key)
       SELECT $1, 1, 'grant', 'bulk:' || g FROM generate_series(1, $2::int) g`,
      [b, BULK_ROWS],
    );
    const bulkMs = performance.now() - t0;

    const t1 = performance.now();
    for (let i = 0; i < DEBITS; i++) {
      const r = await debitCredits(app, a, 1, `d:${i}`);
      if (r.outcome !== 'debited') throw new Error(`unexpected outcome ${r.outcome}`);
    }
    const debitMs = performance.now() - t1;
    return { bulkMs, debitMs };
  } finally {
    await admin.end();
    await app.end();
  }
}

async function main(): Promise<void> {
  console.log(
    `ledger index write cost: ${RUNS} runs per variant, alternating, fresh database each`,
  );
  console.log(
    `bulk insert ${BULK_ROWS} rows; ${DEBITS} sequential debits; started ${new Date().toISOString()}`,
  );
  const results: Record<'with' | 'without', { bulkMs: number; debitMs: number }[]> = {
    with: [],
    without: [],
  };
  for (let i = 0; i < RUNS; i++) {
    for (const variant of ['with', 'without'] as const) {
      const r = await oneRun(variant === 'with');
      results[variant].push(r);
      console.log(
        `run ${i + 1} ${variant.padEnd(7)} bulk ${r.bulkMs.toFixed(0)} ms; ` +
          `${DEBITS} debits ${r.debitMs.toFixed(0)} ms = ${(r.debitMs / DEBITS).toFixed(3)} ms per debit`,
      );
    }
  }
  const med = (xs: number[]): number => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
  for (const variant of ['with', 'without'] as const) {
    const bulk = results[variant].map((r) => r.bulkMs);
    const deb = results[variant].map((r) => r.debitMs / DEBITS);
    console.log(
      `${variant.padEnd(7)} bulk median ${med(bulk).toFixed(0)} ms (${Math.min(...bulk).toFixed(0)} - ${Math.max(...bulk).toFixed(0)}); ` +
        `debit median ${med(deb).toFixed(3)} ms (${Math.min(...deb).toFixed(3)} - ${Math.max(...deb).toFixed(3)})`,
    );
  }
  const server = new pg.Client({ connectionString: adminUrl() });
  await server.connect();
  await server.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await server.end();
}

main().catch((err) => {
  console.error(`bench failed: ${(err as Error).message}`);
  process.exit(1);
});
