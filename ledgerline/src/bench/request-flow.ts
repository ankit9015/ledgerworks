/**
 * Database part of an authenticated balance request, without HTTP (O3 / E5): authenticate the key,
 * open a tenant transaction, read the balance. Two variants of the tenant transaction:
 *   legacy:  BEGIN, set_config, statement, COMMIT as four separate round trips (5 with the auth)
 *   merged:  "BEGIN; SELECT set_config(...)" sent as one simple-protocol query (4 with the auth)
 * N sequential flows per run on one pool connection, 3 rounds, alternating variants. Uses the
 * seeded database (read only) and the small tenant from .seed/keys.json; the key is never printed.
 *
 *   pnpm --filter @ledgerworks/ledgerline bench:flow
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { appUrlFrom, adminUrl } from '../db/config.js';
import { hashApiKey } from '../keys.js';

const N = 5000;
const ROUNDS = 3;

const keys = JSON.parse(readFileSync(path.resolve('../.seed/keys.json'), 'utf8')) as {
  tenants: { size: string; apiKey: string }[];
};
const rawKey = keys.tenants.find((t) => t.size === 'small')!.apiKey;
const hash = hashApiKey(rawKey);

type Variant = 'legacy' | 'merged';

async function flow(pool: pg.Pool, variant: Variant): Promise<void> {
  const auth = await pool.query<{ tenant_id: string }>(
    'SELECT tenant_id, api_key_id FROM ledgerline_fn.authenticate_api_key($1)',
    [hash],
  );
  const tenantId = auth.rows[0]!.tenant_id;
  const client = await pool.connect();
  try {
    if (variant === 'legacy') {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    } else {
      await client.query(
        `BEGIN; SELECT set_config('app.tenant_id', ${client.escapeLiteral(tenantId)}, true)`,
      );
    }
    await client.query('SELECT balance, updated_at FROM credit_balances WHERE tenant_id = $1', [
      tenantId,
    ]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function run(pool: pg.Pool, variant: Variant): Promise<number[]> {
  const times: number[] = [];
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    await flow(pool, variant);
    times.push(performance.now() - t);
  }
  return times.sort((a, b) => a - b);
}

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: appUrlFrom(adminUrl()), max: 10 });
  for (let i = 0; i < 1000; i++) await flow(pool, 'legacy'); // warmup
  console.log(`${N} sequential flows per run, ${ROUNDS} rounds, alternating variants`);
  const at = (xs: number[], p: number): number => xs[Math.floor(p * (xs.length - 1))]!;
  const p50s: Record<Variant, number[]> = { legacy: [], merged: [] };
  for (let r = 1; r <= ROUNDS; r++) {
    for (const v of ['legacy', 'merged'] as const) {
      const t = await run(pool, v);
      p50s[v].push(at(t, 0.5));
      console.log(
        `round ${r} ${v.padEnd(6)} p50 ${at(t, 0.5).toFixed(3)} ms  p95 ${at(t, 0.95).toFixed(3)} ms  p99 ${at(t, 0.99).toFixed(3)} ms`,
      );
    }
  }
  for (const v of ['legacy', 'merged'] as const) {
    const xs = [...p50s[v]].sort((a, b) => a - b);
    console.log(
      `${v.padEnd(6)} p50 median ${xs[1]!.toFixed(3)} ms (${xs[0]!.toFixed(3)} - ${xs[2]!.toFixed(3)})`,
    );
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
