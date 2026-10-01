import pg from 'pg';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

const app = buildApp({
  db: pool,
  logger: { level: config.logLevel, redact: ['req.headers.authorization'] },
  tenantCreationToken: config.tenantCreationToken,
});

if (!config.tenantCreationToken) {
  app.log.warn('TENANT_CREATION_TOKEN is not set: POST /v1/tenants is open to anyone');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => pool.end());
  });
}

await app.listen({ port: config.port, host: config.host });
