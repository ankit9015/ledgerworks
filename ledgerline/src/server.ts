import pg from 'pg';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { schedulePartitionMaintenance } from './partitions.js';

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

// Keep the next months' usage_events partitions present: at startup and every 6 hours.
const stopPartitions = schedulePartitionMaintenance(pool, {
  monthsAhead: config.partitionMonthsAhead,
  intervalMs: 6 * 3600 * 1000,
  onCreated: (names) => app.log.info({ partitions: names }, 'created usage_events partitions'),
  onError: (err) => app.log.error({ err }, 'partition maintenance failed'),
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopPartitions();
    void app.close().then(() => pool.end());
  });
}

await app.listen({ port: config.port, host: config.host });
