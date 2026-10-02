import type pg from 'pg';

export interface PartitionResult {
  name: string;
  /** True when this call created the partition, false when it already existed. */
  created: boolean;
}

/**
 * Makes sure the usage_events partitions for the current month and the next `monthsAhead` months
 * exist (migration 0008). Idempotent and safe to call from several processes at once; it does not
 * block inserts or reads. Returns one entry per month checked.
 */
export async function ensurePartitions(
  db: Pick<pg.Pool, 'query'>,
  monthsAhead = 6,
): Promise<PartitionResult[]> {
  const r = await db.query<{ partition_name: string; created: boolean }>(
    'SELECT partition_name, created FROM ledgerline_fn.ensure_usage_events_partitions($1)',
    [monthsAhead],
  );
  return r.rows.map((row) => ({ name: row.partition_name, created: row.created }));
}

/**
 * Runs ensurePartitions now and then on a timer. Failures are reported through onError and retried
 * at the next tick; they never throw. Returns a function that stops the timer.
 */
export function schedulePartitionMaintenance(
  db: Pick<pg.Pool, 'query'>,
  options: {
    monthsAhead: number;
    intervalMs: number;
    onCreated: (names: string[]) => void;
    onError: (err: unknown) => void;
  },
): () => void {
  const tick = async (): Promise<void> => {
    try {
      const created = (await ensurePartitions(db, options.monthsAhead))
        .filter((p) => p.created)
        .map((p) => p.name);
      if (created.length > 0) options.onCreated(created);
    } catch (err) {
      options.onError(err);
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), options.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
