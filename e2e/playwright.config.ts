import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests of the admin UI against the real API and a seeded database.
 * Locally the API and the UI dev server are started if they are not already running; Postgres must
 * be up and migrated and seeded (`docker compose up -d`, `pnpm migrate`, `pnpm seed --yes` or
 * `pnpm seed:demo`). CI uses the small demo seed and E2E_KEYS_FILE=.seed/keys-demo.json.
 */
export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:5173', trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'pnpm --filter @ledgerworks/ledgerline dev',
      url: 'http://localhost:3000/health',
      reuseExistingServer: true,
      timeout: 60_000,
      env: { METRICS_PORT: '9466' },
    },
    {
      command: 'pnpm --filter @ledgerworks/ledgerline-ui dev',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
