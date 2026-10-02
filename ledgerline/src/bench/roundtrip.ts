/**
 * Cost of one Postgres round trip from the API host (O3 / E5): N sequential `SELECT 1` on one
 * connection, as the application role. Prints the median and p95 of the per-query latency.
 *
 *   pnpm --filter @ledgerworks/ledgerline bench:roundtrip
 */
import pg from 'pg';
import { adminUrl, appUrlFrom } from '../db/config.js';

const N = 5000;

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: appUrlFrom(adminUrl()) });
  await client.connect();
  for (let i = 0; i < 500; i++) await client.query('SELECT 1');
  const times: number[] = [];
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    await client.query('SELECT 1');
    times.push(performance.now() - t);
  }
  await client.end();
  times.sort((a, b) => a - b);
  const at = (p: number): number => times[Math.floor(p * (N - 1))]!;
  console.log(
    `${N} sequential SELECT 1: p50 ${at(0.5).toFixed(3)} ms, p95 ${at(0.95).toFixed(3)} ms, ` +
      `p99 ${at(0.99).toFixed(3)} ms, max ${times[N - 1]!.toFixed(3)} ms`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
