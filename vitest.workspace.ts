import { defineWorkspace } from 'vitest/config';

const packages = ['core', 'ledgerlens', 'ledgerlatch', 'ui', 'evals'];

const ledgerline = {
  root: './ledgerline',
  // Tests share one Postgres database (created by the global setup), so the scripts run test files
  // one at a time (--fileParallelism=false, which Vitest only honours globally).
  globalSetup: ['./test/global-setup.ts'],
  testTimeout: 30_000,
  hookTimeout: 60_000,
};

// `pnpm test:concurrency` sets CONCURRENCY=1 and runs only the slow full-size tests.
export default defineWorkspace(
  process.env.CONCURRENCY === '1'
    ? [
        {
          test: {
            ...ledgerline,
            name: 'ledgerline-concurrency',
            include: ['test/concurrency/**/*.test.ts'],
            testTimeout: 600_000,
          },
        },
      ]
    : [
        ...packages.map((name) => ({
          test: { name, root: `./${name}`, include: ['src/**/*.test.ts'] },
        })),
        {
          // The admin UI: component tests in jsdom (Playwright covers the real browser, see e2e/).
          esbuild: { jsx: 'automatic' as const },
          test: {
            name: 'ledgerline-ui',
            root: './ledgerline/ui',
            environment: 'jsdom',
            include: ['test/**/*.test.tsx'],
            setupFiles: ['./test/setup.ts'],
          },
        },
        {
          test: {
            ...ledgerline,
            name: 'ledgerline',
            include: ['src/**/*.test.ts', 'test/*.test.ts'],
          },
        },
      ],
);
