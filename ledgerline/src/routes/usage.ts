import type { FastifyPluginAsync } from 'fastify';
import { tenantOf } from '../auth.js';
import { withTenant, type Db } from '../db/tenant.js';
import { ApiError } from '../errors.js';

interface IngestBody {
  eventType: string;
  quantity: number;
  occurredAt?: string;
  metadata?: Record<string, unknown>;
}

interface ReadQuery {
  from?: string;
  to?: string;
  eventType?: string;
  limit?: string;
  cursor?: string;
}

// Microsecond-precision UTC text, so keyset pagination cursors do not lose precision.
const TS = `to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function encodeCursor(occurredAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ t: occurredAt, i: id })).toString('base64url');
}

function decodeCursor(cursor: string): { t: string; i: string } {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      t?: unknown;
      i?: unknown;
    };
    if (
      typeof v.t === 'string' &&
      typeof v.i === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(v.t) &&
      /^[0-9a-f-]{36}$/i.test(v.i)
    ) {
      return { t: v.t, i: v.i };
    }
  } catch {
    // fall through
  }
  throw new ApiError(400, 'invalid_cursor', 'The cursor is not valid');
}

export const usageRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.post<{ Body: IngestBody }>(
    '/v1/usage-events',
    {
      preValidation: app.requireApiKey,
      schema: {
        body: {
          type: 'object',
          required: ['eventType', 'quantity'],
          additionalProperties: false,
          properties: {
            eventType: { type: 'string', minLength: 1, maxLength: 100 },
            quantity: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            occurredAt: { type: 'string', format: 'date-time' },
            metadata: { type: 'object' },
          },
        },
      },
    },
    async (req, reply) => {
      const tenantId = tenantOf(req);
      const b = req.body;
      const row = await withTenant(db, tenantId, async (c) => {
        const r = await c.query<{ id: string; occurred_at: string }>(
          `INSERT INTO usage_events (tenant_id, occurred_at, event_type, quantity, metadata)
           VALUES ($1, COALESCE($2::timestamptz, now()), $3, $4, $5)
           RETURNING id, ${TS} AS occurred_at`,
          [
            tenantId,
            b.occurredAt ?? null,
            b.eventType,
            b.quantity,
            JSON.stringify(b.metadata ?? {}),
          ],
        );
        return r.rows[0]!;
      });
      return reply.status(201).send({ id: row.id, occurredAt: row.occurred_at });
    },
  );

  app.get<{ Querystring: ReadQuery }>(
    '/v1/usage',
    {
      preValidation: app.requireApiKey,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
            eventType: { type: 'string', minLength: 1, maxLength: 100 },
            limit: { type: 'string', pattern: '^[0-9]{1,4}$' },
            cursor: { type: 'string', minLength: 1, maxLength: 300 },
          },
        },
      },
    },
    async (req) => {
      const tenantId = tenantOf(req);
      const q = req.query;
      const limit = q.limit === undefined ? 50 : Number(q.limit);
      if (limit < 1 || limit > 200) {
        throw new ApiError(400, 'validation_error', 'Request validation failed', [
          { path: '/limit', message: 'must be between 1 and 200' },
        ]);
      }
      if (q.from && q.to && new Date(q.from) >= new Date(q.to)) {
        throw new ApiError(400, 'invalid_range', '"from" must be earlier than "to"');
      }
      // Explicit tenant_id predicate (RLS adds its own): lets the planner use the tenant index.
      const where: string[] = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      const add = (sql: string, value: unknown): void => {
        params.push(value);
        where.push(sql.replace('?', `$${params.length}`));
      };
      if (q.from) add('occurred_at >= ?::timestamptz', q.from);
      if (q.to) add('occurred_at < ?::timestamptz', q.to);
      if (q.eventType) add('event_type = ?', q.eventType);
      if (q.cursor) {
        const c = decodeCursor(q.cursor);
        params.push(c.t, c.i);
        where.push(
          `(occurred_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
        );
      }
      params.push(limit + 1);
      // ORDER BY must name the table column: a bare `occurred_at` would match the output alias of
      // the same name (the formatted text) and the planner could not use the index order (O1).

      const rows = await withTenant(db, tenantId, async (client) => {
        const r = await client.query<{
          id: string;
          event_type: string;
          quantity: string;
          occurred_at: string;
          metadata: Record<string, unknown>;
        }>(
          `SELECT id, event_type, quantity, ${TS} AS occurred_at, metadata
           FROM usage_events
           WHERE ${where.join(' AND ')}
           ORDER BY usage_events.occurred_at DESC, usage_events.id DESC
           LIMIT $${params.length}`,
          params,
        );
        return r.rows;
      });

      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map((r) => ({
          id: r.id,
          eventType: r.event_type,
          quantity: Number(r.quantity),
          occurredAt: r.occurred_at,
          metadata: r.metadata,
        })),
        nextCursor: rows.length > limit && last ? encodeCursor(last.occurred_at, last.id) : null,
      };
    },
  );
};
