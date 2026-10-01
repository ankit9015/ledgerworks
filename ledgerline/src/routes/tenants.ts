import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { Db } from '../db/tenant.js';
import { unauthorized } from '../errors.js';
import { generateApiKey } from '../keys.js';

interface CreateTenantBody {
  name: string;
  ownerEmail: string;
}

function sameToken(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export const tenantRoutes: FastifyPluginAsync<{
  db: Db;
  tenantCreationToken: string | undefined;
}> = async (app, { db, tenantCreationToken }) => {
  app.post<{ Body: CreateTenantBody }>(
    '/v1/tenants',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'ownerEmail'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            ownerEmail: { type: 'string', format: 'email', minLength: 3, maxLength: 320 },
          },
        },
      },
      // When a token is configured, creating tenants needs it (checked before the body is used).
      preValidation: async (req) => {
        if (tenantCreationToken && !sameToken(req.headers['x-admin-token'], tenantCreationToken)) {
          throw unauthorized();
        }
      },
    },
    async (req, reply) => {
      const key = generateApiKey();
      const result = await db.query<{ id: string }>(
        'SELECT ledgerline_fn.create_tenant($1, $2, $3, $4) AS id',
        [req.body.name, req.body.ownerEmail, key.hash, key.prefix],
      );
      void reply.header('cache-control', 'no-store');
      return reply.status(201).send({
        tenant: { id: result.rows[0]!.id, name: req.body.name },
        // The only time the raw key is ever available. Only its hash is stored.
        apiKey: { key: key.raw, prefix: key.prefix },
      });
    },
  );
};
