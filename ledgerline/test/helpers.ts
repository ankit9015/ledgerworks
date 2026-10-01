import pg from 'pg';
import { adminUrl, appUrlFrom } from '../src/db/config.js';

/** Tests run against their own database so they never touch development data. */
export const TEST_DB = 'ledgerline_test';

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

export function testAdminUrl(): string {
  return withDatabase(adminUrl(), TEST_DB);
}

export function testAppUrl(): string {
  return appUrlFrom(testAdminUrl());
}

export function serverAdminUrl(): string {
  return adminUrl();
}

export function adminPool(): pg.Pool {
  return new pg.Pool({ connectionString: testAdminUrl(), max: 4 });
}

export function appPool(): pg.Pool {
  return new pg.Pool({ connectionString: testAppUrl(), max: 4 });
}
