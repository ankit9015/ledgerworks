import { appUrl } from './db/config.js';

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  logLevel: string;
  /** When set, POST /v1/tenants requires this value in the x-admin-token header. */
  tenantCreationToken: string | undefined;
  /** usage_events partitions kept ahead of the current month (migration 0008). */
  partitionMonthsAhead: number;
  /** Where /metrics is served: its own port and bind address, never the public API port. */
  metricsHost: string;
  metricsPort: number;
  /** If set, /metrics requires `Authorization: Bearer <token>`. */
  metricsToken: string | undefined;
  /** OTLP/HTTP traces endpoint; tracing is off when unset. */
  otelTracesEndpoint: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '127.0.0.1',
    databaseUrl: env.DATABASE_URL ?? appUrl(),
    logLevel: env.LOG_LEVEL ?? 'info',
    tenantCreationToken: env.TENANT_CREATION_TOKEN || undefined,
    partitionMonthsAhead: Number(env.PARTITION_MONTHS_AHEAD ?? 6),
    metricsHost: env.METRICS_HOST ?? '127.0.0.1',
    metricsPort: Number(env.METRICS_PORT ?? 9464),
    metricsToken: env.METRICS_TOKEN || undefined,
    otelTracesEndpoint: env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || undefined,
  };
}
