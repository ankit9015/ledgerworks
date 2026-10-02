import pg from 'pg';
import { loadConfig } from './config.js';
import { ensurePartitions } from './partitions.js';

/** One-off partition maintenance: `pnpm --filter @ledgerworks/ledgerline partitions:ensure`. */
const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 1 });
try {
  const results = await ensurePartitions(pool, config.partitionMonthsAhead);
  const created = results.filter((r) => r.created).map((r) => r.name);
  console.log(
    `checked ${results.length} months (${results[0]?.name} .. ${results.at(-1)?.name}); ` +
      `created: ${created.join(', ') || '(none)'}`,
  );
} finally {
  await pool.end();
}
