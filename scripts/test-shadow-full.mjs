// Clones the 10M-row benchmark database into a shadow container (full copy, then one sampled copy)
// and writes the raw results under docs/benchmarks/raw/ with a timestamped name (never overwritten).
// Minutes long, so it is not part of `pnpm test`; see DECISIONS.md D29 and core/README.md.
//
//   pnpm test:shadow-full
//
// Needs Docker and the seeded benchmark database (pnpm seed --yes), as described in the README.
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--fileParallelism=false'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, SHADOW_FULL: '1' },
});
process.exit(result.status ?? 1);
