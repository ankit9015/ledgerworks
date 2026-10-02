import pg from 'pg';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { metricsUrl } from './db/config.js';
import { buildMetricsServer } from './observability/metrics-server.js';
import { poolQueueStats, setQueueStatsProvider } from './observability/metrics.js';
import { initTracing, instrumentDb } from './observability/tracing.js';
import { schedulePartitionMaintenance } from './partitions.js';

const config = loadConfig();
const tracing = initTracing({
  serviceName: 'ledgerline-api',
  endpoint: config.otelTracesEndpoint,
});
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
const db = instrumentDb(pool);

const app = buildApp({
  db,
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
    void Promise.all([app.close(), metricsServer.close(), tracing.shutdown()]).then(() =>
      Promise.all([pool.end(), metricsDb.end()]),
    );
  });
}

// /metrics: separate port and bind address (default 127.0.0.1:9464), read-only database role.
const metricsDb = new pg.Pool({ connectionString: metricsUrl(), max: 2 });
setQueueStatsProvider(poolQueueStats(metricsDb));
const metricsServer = buildMetricsServer({ token: config.metricsToken });
await metricsServer.listen({ port: config.metricsPort, host: config.metricsHost });

await app.listen({ port: config.port, host: config.host });
