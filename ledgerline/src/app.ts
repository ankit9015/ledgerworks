import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Db } from './db/tenant.js';
import { ApiError } from './errors.js';
import { registerAuth } from './auth.js';
import { healthRoutes } from './routes/health.js';
import { tenantRoutes } from './routes/tenants.js';
import { usageRoutes } from './routes/usage.js';
import { creditRoutes } from './routes/credits.js';
import { registerHttpMetrics } from './observability/metrics.js';
import { registerHttpTracing } from './observability/tracing.js';

export interface AppOptions {
  /** Pool connected as the application role (never the owner or a superuser). */
  db: Db;
  logger?: FastifyServerOptions['logger'];
  tenantCreationToken?: string | undefined;
}

interface ErrorBody {
  error: { code: string; message: string; requestId: string; details?: unknown };
}

const STATUS_CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  404: 'not_found',
  405: 'method_not_allowed',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
};

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    genReqId: () => randomUUID(),
    requestIdLogLabel: 'requestId',
    bodyLimit: 100 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, allErrors: false } },
  });

  registerHttpTracing(app);
  registerHttpMetrics(app);

  // Every response carries the request id, which also appears in every log line for the request.
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  app.setErrorHandler((err, req, reply) => {
    let status = 500;
    let code = 'internal_error';
    let message = 'Internal server error';
    let details: unknown;
    const e = err as Error & {
      statusCode?: number;
      validation?: { instancePath: string; message?: string }[];
      code?: string;
    };

    if (e instanceof ApiError) {
      status = e.statusCode;
      code = e.code;
      message = e.message;
      details = e.details;
    } else if (e.validation) {
      status = 400;
      code = 'validation_error';
      message = 'Request validation failed';
      details = e.validation.map((v) => ({
        path: v.instancePath || '/',
        message: v.message ?? 'invalid',
      }));
    } else if (e.code === '23514' && /no partition/i.test(e.message)) {
      status = 422;
      code = 'occurred_at_out_of_range';
      message = 'occurredAt is outside the supported date range (2024-01 to 2027-12)';
    } else if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      status = e.statusCode;
      code = STATUS_CODES[status] ?? 'bad_request';
      message = status === 400 ? 'Malformed request' : (STATUS_CODES[status] ?? 'Request error');
    }

    if (status >= 500) {
      // Full detail goes to the server log only, never to the client.
      req.log.error({ err: e }, 'unhandled error');
    } else {
      req.log.info({ statusCode: status, code }, 'request rejected');
    }
    const body: ErrorBody = {
      error: { code, message, requestId: req.id, ...(details !== undefined ? { details } : {}) },
    };
    if (status === 401) void reply.header('www-authenticate', 'Bearer');
    return reply.status(status).send(body);
  });

  app.setNotFoundHandler((req, reply) => {
    const body: ErrorBody = {
      error: { code: 'not_found', message: 'Route not found', requestId: req.id },
    };
    return reply.status(404).send(body);
  });

  registerAuth(app, options.db);
  void app.register(healthRoutes, { db: options.db });
  void app.register(tenantRoutes, {
    db: options.db,
    tenantCreationToken: options.tenantCreationToken,
  });
  void app.register(usageRoutes, { db: options.db });
  void app.register(creditRoutes, { db: options.db });
  return app;
}
