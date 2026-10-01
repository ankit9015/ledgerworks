import type { FastifyPluginAsync } from 'fastify';
import { tenantOf } from '../auth.js';
import { withTenant, type Db } from '../db/tenant.js';

export const creditRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get('/v1/credits/balance', { preValidation: app.requireApiKey }, async (req) => {
    const tenantId = tenantOf(req);
    const row = await withTenant(db, tenantId, async (c) => {
      const r = await c.query<{ balance: string; updated_at: Date }>(
        'SELECT balance, updated_at FROM credit_balances WHERE tenant_id = $1',
        [tenantId],
      );
      return r.rows[0];
    });
    return {
      balance: row ? Number(row.balance) : 0,
      updatedAt: row ? row.updated_at.toISOString() : null,
    };
  });
};
