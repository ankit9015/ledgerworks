import pg from 'pg';
import { migrate } from '../src/db/migrate.js';
import { TEST_DB, serverAdminUrl, testAdminUrl } from './helpers.js';

/** Recreates the test database from scratch and applies all migrations. */
export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: serverAdminUrl() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end();
  }
  const result = await migrate(testAdminUrl());
  console.log(`[global-setup] ${TEST_DB} migrated from empty: ${result.applied.join(', ')}`);
}
