/** Connection settings. Development defaults match docker-compose.yml. */
export const DEFAULT_ADMIN_URL = 'postgres://ledgerworks:ledgerworks@localhost:5432/ledgerworks';

export function adminUrl(): string {
  return process.env.DATABASE_ADMIN_URL ?? DEFAULT_ADMIN_URL;
}

/** Same server and database as the admin URL, but as the (RLS-bound) application role. */
export function appUrlFrom(admin: string): string {
  const url = new URL(admin);
  url.username = 'ledgerline_app';
  url.password = process.env.LEDGERLINE_APP_PASSWORD ?? 'ledgerline_app';
  return url.toString();
}

export function appUrl(): string {
  return process.env.DATABASE_URL ?? appUrlFrom(adminUrl());
}

/** Same server and database, as the queue worker role (may only call claim_jobs). */
export function workerUrlFrom(admin: string): string {
  const url = new URL(admin);
  url.username = 'ledgerline_worker';
  url.password = process.env.LEDGERLINE_WORKER_PASSWORD ?? 'ledgerline_worker';
  return url.toString();
}

export function workerUrl(): string {
  return process.env.DATABASE_WORKER_URL ?? workerUrlFrom(adminUrl());
}
