import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { registry } from './metrics.js';

/**
 * The metrics endpoint lives on its OWN Fastify instance, port and bind address (default
 * 127.0.0.1:9464), never on the public API port, so /metrics is not part of the API surface at all.
 * Optionally also requires `Authorization: Bearer <METRICS_TOKEN>`. Exposes nothing but /metrics.
 */
export function buildMetricsServer(options: { token?: string | undefined } = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get('/metrics', async (req, reply) => {
    if (options.token) {
      const given = Buffer.from(req.headers.authorization ?? '');
      const want = Buffer.from(`Bearer ${options.token}`);
      if (given.length !== want.length || !timingSafeEqual(given, want)) {
        return reply.status(401).send('unauthorized');
      }
    }
    return reply.header('content-type', registry.contentType).send(await registry.metrics());
  });
  return app;
}
