import { adminUrl } from './config.js';
import { migrate } from './migrate.js';

const result = await migrate(adminUrl());
console.log(
  `migrations applied: ${result.applied.join(', ') || '(none)'}; already applied: ${result.skipped.join(', ') || '(none)'}`,
);
