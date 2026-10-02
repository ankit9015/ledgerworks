import type { FastifyPluginAsync } from 'fastify';
import { tenantOf } from '../auth.js';
import { withTenant, type Db } from '../db/tenant.js';
import { ApiError } from '../errors.js';

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

  // Recent ledger entries of the caller's tenant, newest first, keyset-paginated on the ledger id.
  app.get<{ Querystring: { limit?: string; cursor?: string } }>(
    '/v1/credits/ledger',
    {
      preValidation: app.requireApiKey,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'string', pattern: '^[0-9]{1,3}$' },
            cursor: { type: 'string', pattern: '^[0-9]{1,15}$' },
          },
        },
      },
    },
    async (req) => {
      const tenantId = tenantOf(req);
      const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
      if (limit < 1 || limit > 100) {
        throw new ApiError(400, 'validation_error', 'Request validation failed', [
          { path: '/limit', message: 'must be between 1 and 100' },
        ]);
      }
      const rows = await withTenant(db, tenantId, async (c) => {
        const r = await c.query<{
          id: string;
          kind: string;
          amount: string;
          balance_after: string | null;
          reference: string | null;
          created_at: Date;
        }>(
          `SELECT id, kind, amount, balance_after, reference, created_at
           FROM credit_ledger
           WHERE tenant_id = $1 AND ($2::bigint IS NULL OR id < $2::bigint)
           ORDER BY id DESC LIMIT $3`,
          [tenantId, req.query.cursor ?? null, limit + 1],
        );
        return r.rows;
      });
      const page = rows.slice(0, limit);
      return {
        items: page.map((r) => ({
          id: Number(r.id),
          kind: r.kind,
          amount: Number(r.amount),
          balanceAfter: r.balance_after === null ? null : Number(r.balance_after),
          reference: r.reference,
          createdAt: r.created_at.toISOString(),
        })),
        nextCursor: rows.length > limit ? String(page[page.length - 1]!.id) : null,
      };
    },
  );
};
