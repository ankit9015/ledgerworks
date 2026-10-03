/**
 * The run-to-run variance experiment of the measurement harness (C2.2), on the 10M-row Ledgerline
 * benchmark database.
 *
 *   pnpm --filter @ledgerworks/core variance [--attach <runId>] [--keep] [--repetitions 10]
 *        [--warmup 3] [--measured 20] [--out docs/benchmarks/raw] [--cpuset 0,1] [--only case1,case2]
 *
 * Without --attach it clones the benchmark database into a fresh full shadow (minutes) and destroys
 * it at the end unless --keep is given. With --attach it measures an existing shadow, so the clone
 * is paid once. Every raw measurement is written to a timestamped file under --out (never
 * overwritten) and a summary table is printed.
 *
 * --cpuset pins the shadow container to the listed CPUs of the Docker host with `docker update`.
 * That changes the container's configuration, so it is recorded in the raw files and only done when
 * asked for; it is an experiment on how to reduce variance, not a silent change.
 */
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { docker, dockerHostInfo } from '../shadow/docker.js';
import { attachShadow, createShadow, type ShadowHandle } from '../shadow/runner.js';
import { settleShadow } from '../shadow/settle.js';
import { BENCH_DB, ensureReaderRole, readerUrlFor } from '../shadow/testing/helpers.js';
import { runVarianceExperiment, type VarianceCase } from './variance.js';

const { values } = parseArgs({
  options: {
    attach: { type: 'string' },
    keep: { type: 'boolean', default: false },
    repetitions: { type: 'string', default: '10' },
    warmup: { type: 'string', default: '3' },
    measured: { type: 'string', default: '20' },
    out: {
      type: 'string',
      default: path.resolve(import.meta.dirname, '../../../docs/benchmarks/raw'),
    },
    cpuset: { type: 'string' },
    only: { type: 'string' },
    label: { type: 'string', default: 'baseline' },
  },
});

async function main(): Promise<void> {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const warmupRuns = Number(values.warmup);
  const measuredRuns = Number(values.measured);
  let shadow: ShadowHandle;
  let created = false;
  if (values.attach) {
    shadow = await attachShadow(values.attach);
  } else {
    await ensureReaderRole(BENCH_DB);
    shadow = await createShadow({
      sourceUrl: readerUrlFor(BENCH_DB),
      mode: 'full',
      sourceContainer: 'ledgerworks-postgres',
      log: (m) => console.error(m),
    });
    created = true;
  }
  try {
    const c = await shadow.connect();
    const tenant = (
      await c.query<{ tenant_id: string }>(
        'SELECT tenant_id FROM usage_events GROUP BY 1 ORDER BY count(*) DESC LIMIT 1',
      )
    ).rows[0]!.tenant_id;
    await c.query('DROP TABLE IF EXISTS harness_variance_ddl');
    await c.query(
      `CREATE TABLE harness_variance_ddl AS SELECT g AS id, g % 5000 AS a, md5(g::text) AS b, repeat('x', 100) AS d FROM generate_series(1, 200000) g`,
    );
    await c.query('CREATE INDEX ON harness_variance_ddl (a)');
    // Make the scratch table quiescent before measuring: otherwise autovacuum and the checkpoint that follow
    // its creation run during the measurement (seen in the first run: the DDL took 518 ms instead of 290 ms).
    await c.query('VACUUM (ANALYZE) harness_variance_ddl');
    await c.query('CHECKPOINT');
    await c.end();

    // A shadow that has just been loaded keeps working in the background for minutes: settle it first.
    const settle = await settleShadow(shadow);
    console.error(`settled: ${JSON.stringify(settle)}`);

    if (values.cpuset) {
      await docker(['update', '--cpuset-cpus', values.cpuset, shadow.containerName]);
    }
    const inspect = JSON.parse((await docker(['inspect', shadow.containerName])).stdout)[0]
      .HostConfig;
    const host = await dockerHostInfo();
    const usageBase = `SELECT id, event_type, quantity, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at, metadata
FROM usage_events WHERE tenant_id = $1 AND occurred_at >= '2026-08-24T00:00:00Z'::timestamptz AND occurred_at < '2026-08-31T00:00:00Z'::timestamptz`;
    const q = { params: [tenant], warmupRuns, measuredRuns };
    const cases: VarianceCase[] = [
      {
        name: 'usage-read-after-E1',
        description:
          'Ledgerline usage-read page 1, huge tenant, 7-day window, ORDER BY the table column (E1 fixed form)',
        kind: 'query',
        options: {
          ...q,
          sql: `${usageBase}\nORDER BY usage_events.occurred_at DESC, usage_events.id DESC LIMIT 51`,
        },
      },
      {
        name: 'usage-read-before-E1',
        description:
          'the same query as the API ran it before the E1 fix (ORDER BY resolves to the output alias)',
        kind: 'query',
        options: { ...q, sql: `${usageBase}\nORDER BY occurred_at DESC, id DESC LIMIT 51` },
      },
      {
        name: 'usage-aggregate-month',
        description: 'count and sum over one month of the huge tenant (about 270k rows)',
        kind: 'query',
        options: {
          ...q,
          sql: `SELECT count(*), sum(quantity) FROM usage_events WHERE tenant_id = $1 AND occurred_at >= '2026-07-01T00:00:00Z'::timestamptz AND occurred_at < '2026-08-01T00:00:00Z'::timestamptz`,
        },
      },
      {
        name: 'credit-balance-update',
        description: 'UPDATE of one credit_balances row, measured inside a rolled-back transaction',
        kind: 'query',
        options: {
          ...q,
          sql: 'UPDATE credit_balances SET balance = balance + 1 WHERE tenant_id = $1',
        },
      },
      {
        name: 'ddl-add-column-volatile-default',
        description:
          'ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT random() on a 200,000-row scratch table (rewrite), 3 runs per repetition',
        kind: 'ddl',
        options: {
          sql: 'ALTER TABLE public.harness_variance_ddl ADD COLUMN v double precision NOT NULL DEFAULT random()',
          table: 'public.harness_variance_ddl',
          runs: 3,
        },
      },
    ].filter((cs) => !values.only || values.only.split(',').includes(cs.name)) as VarianceCase[];

    const cpu = os.cpus();
    const report = await runVarianceExperiment({
      target: shadow,
      cases,
      repetitions: Number(values.repetitions),
      outDir: values.out!,
      stamp: `${values.label}-${stamp}`,
      onProgress: (m) => console.error(m),
      context: {
        label: values.label,
        description: `Variance of the measurement harness: each case run ${values.repetitions} times, each repetition with ${warmupRuns} warmup and ${measuredRuns} measured runs (DDL: 3 runs).`,
        data: 'synthetic 10M-row Ledgerline benchmark database (pnpm seed --yes, seed 20251001), full shadow copy',
        machine: {
          cpuModel: cpu[0]?.model,
          logicalCores: cpu.length,
          ramGiB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
          platform: `${os.platform()} ${os.release()}`,
          node: process.version,
        },
        dockerHost: host,
        shadow: {
          manifestId: shadow.runId,
          sampled: shadow.manifest.scaling.sampled,
          image: shadow.manifest.image,
          settings: shadow.manifest.settings,
        },
        containerLimits: {
          nanoCpus: inspect.NanoCpus,
          cpuset: inspect.CpusetCpus || null,
          memoryBytes: inspect.Memory,
          memorySwapBytes: inspect.MemorySwap,
          shmBytes: inspect.ShmSize,
        },
        cpusetAppliedForThisRun: values.cpuset ?? null,
        settle,
        notes:
          'Run on a developer laptop with other applications open: nothing else was started by this script, but the machine was not dedicated.',
      },
    });
    console.log(report.markdown);
    console.log(
      JSON.stringify(
        report.cases.map((c) => ({ name: c.name, failures: c.failures, rawFile: c.rawFile })),
        null,
        1,
      ),
    );
  } finally {
    if (created && !values.keep) await shadow.destroy();
    else console.error(`shadow ${shadow.runId} left running (container ${shadow.containerName})`);
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
