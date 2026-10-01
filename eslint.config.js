import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node scripts (not TypeScript)
    files: ['ledgerline/k6/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
  {
    // k6 scripts run in k6's own runtime, which provides these globals.
    files: ['ledgerline/k6/**/*.js'],
    languageOptions: { globals: { __ENV: 'readonly', open: 'readonly' } },
  },
);
