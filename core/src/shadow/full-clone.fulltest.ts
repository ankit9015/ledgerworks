/**
 * C2.1 test 2: clone the 10M-row Ledgerline benchmark database, once in full and once sampled.
 * Gated behind `pnpm test:shadow-full` (SHADOW_FULL=1); not part of `pnpm test` or CI.
 * Raw results go to docs/benchmarks/raw/ under a timestamped name; an existing file is never
 * overwritten.
 */
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { diffFingerprints, schemaSnapshot, sourceFingerprint } from './fingerprint.js';
import { createShadow, type ShadowHandle } from './runner.js';
import { BENCH_DB, adminUrlFor, ensureReaderRole, readerUrlFor } from './testing/helpers.js';

const rawDir = path.resolve(import.meta.dirname, '../../../docs/benchmarks/raw');
const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\.\d+Z$/, 'Z');
const SOURCE_CONTAINER = 'ledgerworks-postgres';

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

function machine(): Record<string, unknown> {
  const cpu = os.cpus();
  return {
    cpuModel: cpu[0]?.model,
    logicalCores: cpu.length,
    ramGiB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    platform: `${os.platform()} ${os.release()}`,
    node: process.version,
  };
}

async function save(name: string, body: unknown): Promise<string> {
  const file = path.join(rawDir, `${name}-${stamp}.json`);
  await writeFile(file, JSON.stringify(body, null, 2) + '\n', { flag: 'wx' }); // wx: never overwrite
  return file;
}

async function integrityReport(
  shadow: ShadowHandle,
): Promise<{ constraint: string; orphans: number }[]> {
  const report: { constraint: string; orphans: number }[] = [];
  await withClient(shadow.connectionString(), async (c) => {
    const fks = await c.query<{
      conname: string;
      child: string;
      parent: string;
      cols: string[];
      pcols: string[];
    }>(
      `SELECT con.conname, con.conrelid::regclass::text AS child, con.confrelid::regclass::text AS parent,
              (SELECT array_agg(quote_ident(a.attname) ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS cols,
              (SELECT array_agg(quote_ident(a.attname) ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS pcols
         FROM pg_constraint con WHERE con.contype = 'f' AND con.conparentid = 0 ORDER BY 1, 2`,
    );
    for (const fk of fks.rows) {
      const nonNull = fk.cols.map((x) => `c.${x} IS NOT NULL`).join(' AND ');
      const join = fk.cols.map((x, i) => `p.${fk.pcols[i]} = c.${x}`).join(' AND ');
      const r = await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM ${fk.child} c WHERE ${nonNull} AND NOT EXISTS (SELECT 1 FROM ${fk.parent} p WHERE ${join})`,
      );
      report.push({ constraint: fk.conname, orphans: Number(r.rows[0]!.n) });
    }
  });
  return report;
}

describe('clone of the 10M-row benchmark database', () => {
  it('full clone: schema and counts equal, source untouched, duration and memory recorded', async () => {
    const admin = adminUrlFor(BENCH_DB);
    await ensureReaderRole(BENCH_DB);
    const before = await sourceFingerprint(admin);
    expect(before.rowCounts['public.credit_balances']).toBe(250);
    const eventsBefore = Object.entries(before.rowCounts)
      .filter(([k]) => k.startsWith('public.usage_events_'))
      .reduce((a, [, n]) => a + n, 0);
    expect(eventsBefore).toBe(10_000_000);

    const logs: string[] = [];
    const wall0 = Date.now();
    const shadow: ShadowHandle = await createShadow({
      sourceUrl: readerUrlFor(BENCH_DB),
      mode: 'full',
      sourceContainer: SOURCE_CONTAINER,
      log: (m) => logs.push(`${new Date().toISOString()} ${m}`),
    });
    const wallMs = Date.now() - wall0;
    try {
      const m = shadow.manifest;
      const usage = m.tables.find((t) => t.name === 'usage_events')!;
      expect(usage.sourceRows).toBe(10_000_000);
      expect(usage.shadowRows).toBe(10_000_000);
      for (const t of m.tables) expect(t.shadowRows, `${t.name}`).toBe(t.sourceRows);

      const [a, b] = await Promise.all([
        withClient(admin, schemaSnapshot),
        shadow.connect().then(async (c) => {
          try {
            return await schemaSnapshot(c);
          } finally {
            await c.end();
          }
        }),
      ]);
      const schemaDiff = {
        missing: a.filter((l) => !b.includes(l)),
        extra: b.filter((l) => !a.includes(l)),
      };
      expect(schemaDiff).toEqual({ missing: [], extra: [] });

      // the source did not change, at full size either
      const after = await sourceFingerprint(admin);
      const diff = diffFingerprints(before, after);
      expect(diff).toEqual([]);

      // the source container survived: not OOM-killed, not restarted
      expect(m.sourceContainerHealth).toMatchObject({ oomKilledAfter: false });
      expect(m.sourceContainerHealth!.restartCountAfter).toBe(
        m.sourceContainerHealth!.restartCountBefore,
      );
      expect(m.sourceContainerHealth!.startedAtAfter).toBe(
        m.sourceContainerHealth!.startedAtBefore,
      );

      const file = await save('c2.1-full-clone', {
        description:
          'C2.1 test 2: full clone of the synthetic 10M-row Ledgerline benchmark database into a shadow container.',
        data: 'synthetic (pnpm seed --yes, seed 20251001)',
        machine: machine(),
        wallClockMs: wallMs,
        manifest: m,
        schemaLinesCompared: a.length,
        schemaDifferences: schemaDiff,
        sourceFingerprint: {
          before: { statDatabase: before.statDatabase, statTables: before.statTables },
          after: { statDatabase: after.statDatabase, statTables: after.statTables },
          differences: diff,
        },
        log: logs,
      });
      console.log(`[shadow-full] saved ${file}`);
    } finally {
      await shadow.destroy();
    }
  });

  it('sampled clone (10% of tenants): integrity holds and the ratios are recorded', async () => {
    const admin = adminUrlFor(BENCH_DB);
    const before = await sourceFingerprint(admin);
    const logs: string[] = [];
    const wall0 = Date.now();
    const shadow = await createShadow({
      sourceUrl: readerUrlFor(BENCH_DB),
      mode: 'sampled',
      sampling: { rootTable: 'public.tenants', ratio: 0.1, seed: 20251001 },
      sourceContainer: SOURCE_CONTAINER,
      log: (m) => logs.push(`${new Date().toISOString()} ${m}`),
    });
    const wallMs = Date.now() - wall0;
    try {
      const m = shadow.manifest;
      expect(m.scaling.sampled).toBe(true);
      const report = await integrityReport(shadow);
      expect(report.length).toBeGreaterThanOrEqual(8);
      expect(report.filter((r) => r.orphans > 0)).toEqual([]);
      const after = await sourceFingerprint(admin);
      expect(diffFingerprints(before, after)).toEqual([]);
      const file = await save('c2.1-sampled-clone', {
        description:
          'C2.1: sampled clone (10% of tenants, seed 20251001) of the synthetic 10M-row Ledgerline benchmark database.',
        data: 'synthetic (pnpm seed --yes, seed 20251001)',
        machine: machine(),
        wallClockMs: wallMs,
        manifest: m,
        integrityReport: { foreignKeysChecked: report.length, orphans: 0, detail: report },
        log: logs,
      });
      console.log(`[shadow-full] saved ${file}`);
    } finally {
      await shadow.destroy();
    }
  });
});
