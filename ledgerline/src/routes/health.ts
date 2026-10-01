import type { FastifyPluginAsync } from 'fastify';
import type { Db } from '../db/tenant.js';

export const healthRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get('/health', async (req, reply) => {
    try {
      await db.query('SELECT 1');
      return { status: 'ok', db: 'ok' };
    } catch (err) {
      req.log.error({ err }, 'health check: database unreachable');
      return reply.status(503).send({ status: 'degraded', db: 'down' });
    }
  });
};
