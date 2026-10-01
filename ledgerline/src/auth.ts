import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from './db/tenant.js';
import { unauthorized } from './errors.js';
import { API_KEY_PATTERN, hashApiKey } from './keys.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by requireApiKey after the key was verified. Never taken from request input. */
    tenantId: string | undefined;
    apiKeyId: string | undefined;
  }
}

/**
 * Resolves a Bearer API key to its tenant through the narrow SECURITY DEFINER function (the API
 * cannot read api_keys before it knows the tenant). Every failure is the same 401, so the response
 * does not reveal whether a key exists. The key and the Authorization header are never logged.
 */
export function registerAuth(app: FastifyInstance, db: Db): void {
  app.decorateRequest('tenantId', undefined);
  app.decorateRequest('apiKeyId', undefined);

  app.decorate('requireApiKey', async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer (\S+)$/.exec(header) : null;
    const raw = match?.[1];
    if (!raw || !API_KEY_PATTERN.test(raw)) throw unauthorized();

    const result = await db.query<{ tenant_id: string; api_key_id: string }>(
      'SELECT tenant_id, api_key_id FROM ledgerline_fn.authenticate_api_key($1)',
      [hashApiKey(raw)],
    );
    const row = result.rows[0];
    if (!row) throw unauthorized();
    req.tenantId = row.tenant_id;
    req.apiKeyId = row.api_key_id;
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    requireApiKey: (req: FastifyRequest) => Promise<void>;
  }
}

/** The tenant of an authenticated request. Throws if called on an unauthenticated route. */
export function tenantOf(req: FastifyRequest): string {
  if (!req.tenantId) throw unauthorized();
  return req.tenantId;
}
