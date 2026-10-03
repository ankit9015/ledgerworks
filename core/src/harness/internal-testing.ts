/**
 * TEST-ONLY override of the shadow check, for the tests of the harness itself (they need to prove
 * what the harness does against a database that is not a shadow).
 *
 * It is deliberately NOT exported from index.ts, takes no option that a public function accepts,
 * is not part of any option schema or tool definition, and refuses to run outside a test runner
 * unless two things are set: VITEST (set by the runner) and
 * LEDGERWORKS_ALLOW_NON_SHADOW_FOR_TESTS=1. It logs loudly every time.
 */
import { runDdl, type DdlHooks } from './ddl.js';
import { runQuery } from './query.js';
import type { DdlMeasurement, QueryMeasurement } from './schema.js';
import type { MeasurementTarget } from './session.js';

function guard(): void {
  if (!process.env.VITEST || process.env.LEDGERWORKS_ALLOW_NON_SHADOW_FOR_TESTS !== '1') {
    throw new Error(
      'The shadow check can only be disabled inside a test run (VITEST and LEDGERWORKS_ALLOW_NON_SHADOW_FOR_TESTS=1).',
    );
  }
  console.error(
    '!!!!!!!! LEDGERWORKS HARNESS: SHADOW CHECK DISABLED (test override). The statement will run against a database that may NOT be a shadow. !!!!!!!!',
  );
}

export function unsafeMeasureQueryForTests(
  target: MeasurementTarget,
  options: unknown,
): Promise<QueryMeasurement> {
  guard();
  return runQuery(target, options, { skipShadowCheck: true });
}

export function unsafeMeasureDdlForTests(
  target: MeasurementTarget,
  options: unknown,
  hooks: DdlHooks = {},
): Promise<DdlMeasurement> {
  guard();
  return runDdl(target, options, hooks, { skipShadowCheck: true });
}
