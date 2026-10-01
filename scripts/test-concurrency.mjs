// Runs the full-size concurrency tests (ledgerline/test/concurrency). They are excluded from the
// default `pnpm test` because they take minutes; see DECISIONS.md D19.
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--fileParallelism=false'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, CONCURRENCY: '1' },
});
process.exit(result.status ?? 1);
