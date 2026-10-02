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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '127.0.0.1',
    databaseUrl: env.DATABASE_URL ?? appUrl(),
    logLevel: env.LOG_LEVEL ?? 'info',
    tenantCreationToken: env.TENANT_CREATION_TOKEN || undefined,
    partitionMonthsAhead: Number(env.PARTITION_MONTHS_AHEAD ?? 6),
  };
}
