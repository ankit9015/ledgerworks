import type pg from 'pg';
import { parseManifest, type ShadowManifest } from './manifest.js';

/** Database-level setting that carries the run id (ALTER DATABASE ... SET). */
export const SHADOW_GUC = 'ledgerworks.shadow_run_id';
export const MARKER_SCHEMA = 'ledgerworks_meta';
export const MARKER_TABLE = 'shadow_marker';

export class NotShadowError extends Error {
  constructor(reason: string) {
    super(
      `Refusing to run: this database is not a Ledgerworks shadow (${reason}). ` +
        'Experiments only run on a database created by createShadow.',
    );
    this.name = 'NotShadowError';
  }
}

export interface ShadowMarker {
  runId: string;
  manifest: ShadowManifest;
}

/**
 * Proves that the database behind `client` is a shadow: the database-level setting exists AND the
 * marker table has a row with the same run id AND that row carries a valid manifest. Throws
 * NotShadowError otherwise. Anything that did not come out of createShadow (a source database, a
 * half-finished clone, a copy of a shadow that lost its setting) fails this check.
 */
export async function assertShadow(client: pg.ClientBase): Promise<ShadowMarker> {
  const guc = await client.query<{ v: string | null }>(
    `SELECT current_setting('${SHADOW_GUC}', true) AS v`,
  );
  const runId = guc.rows[0]?.v;
  if (!runId) throw new NotShadowError('no database-level shadow setting');
  const exists = await client.query<{ ok: boolean }>(
    `SELECT to_regclass('${MARKER_SCHEMA}.${MARKER_TABLE}') IS NOT NULL AS ok`,
  );
  if (!exists.rows[0]?.ok) throw new NotShadowError('no marker table');
  const row = await client.query<{ run_id: string; manifest: unknown }>(
    `SELECT run_id, manifest FROM ${MARKER_SCHEMA}.${MARKER_TABLE} WHERE run_id = $1`,
    [runId],
  );
  if (row.rowCount !== 1)
    throw new NotShadowError('marker row does not match the database setting');
  if (!row.rows[0]!.manifest)
    throw new NotShadowError('clone did not finish (marker has no manifest)');
  let manifest: ShadowManifest;
  try {
    manifest = parseManifest(row.rows[0]!.manifest);
  } catch {
    throw new NotShadowError('marker manifest is invalid');
  }
  if (manifest.id !== runId) throw new NotShadowError('manifest id does not match the run id');
  return { runId, manifest };
}
