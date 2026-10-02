import type { FastifyPluginAsync } from 'fastify';
import { tenantOf } from '../auth.js';
import { withTenant, type Db } from '../db/tenant.js';

const STATES = ['queued', 'running', 'failed', 'succeeded', 'dead'] as const;

/**
 * Queue health for the CALLER's tenant only (counts by state, how long the oldest waiting job has
 * waited, the latest dead letters). Runs as the app role under RLS, with an explicit tenant filter
 * too. Cross-tenant operational views are Grafana's job (see D28), never an API endpoint.
 */
export const queueRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get('/v1/queue/stats', { preValidation: app.requireApiKey }, async (req) => {
    const tenantId = tenantOf(req);
    return withTenant(db, tenantId, async (c) => {
      const counts = await c.query<{ status: string; n: string }>(
        'SELECT status, count(*) AS n FROM jobs WHERE tenant_id = $1 GROUP BY status',
        [tenantId],
      );
      const oldest = await c.query<{ age: string | null }>(
        `SELECT extract(epoch FROM now() - min(run_at)) AS age FROM jobs
         WHERE tenant_id = $1 AND status IN ('queued', 'failed') AND run_at <= now()`,
        [tenantId],
      );
      const dead = await c.query<{
        job_id: string;
        type: string;
        attempts: number;
        last_error: string | null;
        dead_at: Date;
      }>(
        `SELECT job_id, type, attempts, last_error, dead_at FROM dead_letters
         WHERE tenant_id = $1 ORDER BY dead_at DESC LIMIT 10`,
        [tenantId],
      );
      const byState = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<string, number>;
      for (const r of counts.rows) byState[r.status] = Number(r.n);
      const age = oldest.rows[0]?.age;
      return {
        counts: byState,
        oldestRunnableAgeSeconds: age === null || age === undefined ? null : Number(age),
        recentDeadLetters: dead.rows.map((r) => ({
          jobId: r.job_id,
          type: r.type,
          attempts: r.attempts,
          lastError: r.last_error === null ? null : r.last_error.slice(0, 200),
          deadAt: r.dead_at.toISOString(),
        })),
      };
    });
  });
};
