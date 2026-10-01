import { defineWorkspace } from 'vitest/config';

const packages = ['core', 'ledgerlens', 'ledgerlatch', 'ui', 'evals'];

export default defineWorkspace([
  ...packages.map((name) => ({
    test: { name, root: `./${name}`, include: ['src/**/*.test.ts'] },
  })),
  {
    test: {
      name: 'ledgerline',
      root: './ledgerline',
      include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
      // Tests share one Postgres database (created by the global setup).
      globalSetup: ['./test/global-setup.ts'],
      fileParallelism: false,
      testTimeout: 30_000,
      hookTimeout: 60_000,
    },
  },
]);
