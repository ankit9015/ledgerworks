import pg from 'pg';
import { assertShadow } from './marker.js';

export interface SettleResult {
  /** time spent waiting for autovacuum workers that were already running */
  waitedForAutovacuumMs: number;
  vacuumAnalyzeMs: number;
  checkpointMs: number;
}

/**
 * Makes a freshly loaded shadow quiet before anything is timed on it: waits for autovacuum workers
 * that are running, then runs VACUUM (ANALYZE) (sets hint bits and the visibility map, refreshes
 * statistics) and CHECKPOINT (flushes dirty pages). Without this, a shadow that has just been
 * cloned keeps working in the background for minutes (autovacuum of the loaded tables, a
 * checkpoint) and the first measurements are slower and noisier: seen on the 10M-row clone, where
 * autovacuum ran from the end of the load until 2.5 minutes later (DECISIONS.md D36).
 *
 * Only runs on a verified shadow, because it changes the database's physical state.
 */
export async function settleShadow(
  target: { connectionString(): string },
  o: { timeoutMs?: number } = {},
): Promise<SettleResult> {
  const c = new pg.Client({
    connectionString: target.connectionString(),
    application_name: 'ledgerworks-settle',
  });
  c.on('error', () => undefined);
  await c.connect();
  try {
    await assertShadow(c);
    return await settleClient(c, o.timeoutMs);
  } finally {
    await c.end();
  }
}

/** The settle steps on a connection the caller already knows belongs to a shadow (createShadow uses it before the marker exists). */
export async function settleClient(c: pg.ClientBase, timeoutMs = 600_000): Promise<SettleResult> {
  const deadline = Date.now() + timeoutMs;
  const t0 = performance.now();
  for (;;) {
    const r = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity WHERE backend_type = 'autovacuum worker'`,
    );
    if (Number(r.rows[0]!.n) === 0) break;
    if (Date.now() > deadline)
      throw new Error('autovacuum workers still running after the timeout');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const waited = performance.now() - t0;
  const t1 = performance.now();
  await c.query('VACUUM (ANALYZE)');
  const t2 = performance.now();
  await c.query('CHECKPOINT');
  const t3 = performance.now();
  return {
    waitedForAutovacuumMs: Math.round(waited),
    vacuumAnalyzeMs: Math.round(t2 - t1),
    checkpointMs: Math.round(t3 - t2),
  };
}
