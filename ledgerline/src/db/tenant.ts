import type pg from 'pg';

export type Db = Pick<pg.Pool, 'query' | 'connect'>;

/**
 * Runs fn inside one transaction with the tenant set (local to the transaction, so it cannot leak
 * to the next user of a pooled connection). Commits on success, rolls back on any error.
 */
export async function withTenant<T>(
  db: Db,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
