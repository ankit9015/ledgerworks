/**
 * Candidates for some real Ledgerline statements, from the real schema of the benchmark database.
 *
 *   LEDGERLENS_SOURCE_URL=postgres://reader:...@localhost:5432/ledgerworks pnpm --filter @ledgerworks/ledgerlens candidates:report
 *
 * Reads only (a read-only role). Writes docs/benchmarks/raw/l3.3-candidates-<stamp>.json (new name every run)
 * and prints a table. Nothing is applied anywhere.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzePlan } from '../src/analyzer/analyze.js';
import { parsePlan } from '../src/analyzer/plan.js';
import { generateCandidates, type Candidate } from '../src/candidates/index.js';
import { parseStatement } from '../src/sql/parse.js';
import { readSnapshot } from '../src/schema/snapshot.js';
import {
  openSource,
  withSource,
  readTable,
  readColumnStats,
  hashText,
} from '../src/workload/source.js';
import type { WorkloadStatement } from '../src/workload/types.js';
import { readFileSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const STATEMENTS: { label: string; sql: string; fixture?: string }[] = [
  {
    label: 'usage-read BEFORE the E1 fix (ORDER BY the output alias)',
    sql: `SELECT id, event_type, quantity, to_char(occurred_at AT TIME ZONE $5, $6) AS occurred_at, metadata FROM usage_events WHERE tenant_id = $1 AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz ORDER BY occurred_at DESC, id DESC LIMIT $4`,
    fixture: 'pre_e1_usage_read',
  },
  {
    label: 'usage-read AFTER the E1 fix (ORDER BY the column)',
    sql: `SELECT id, event_type, quantity, to_char(occurred_at AT TIME ZONE $5, $6) AS occurred_at, metadata FROM usage_events WHERE tenant_id = $1 AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz ORDER BY usage_events.occurred_at DESC, usage_events.id DESC LIMIT $4`,
    fixture: 'post_e1_usage_read',
  },
  {
    label: 'balance lookup',
    sql: 'SELECT balance, updated_at FROM credit_balances WHERE tenant_id = $1',
  },
  {
    label: 'a count of one tenant (no condition on the partition key)',
    sql: 'SELECT count(*) FROM usage_events WHERE tenant_id = $1',
    fixture: 'no_partition_pruning_tenant_count',
  },
  {
    label: 'usage events of one event type (unindexed column)',
    sql: 'SELECT id, tenant_id, occurred_at FROM usage_events WHERE event_type = $1',
    fixture: 'seq_scan_selective_partitioned',
  },
];

async function main(): Promise<void> {
  const url = process.env.LEDGERLENS_SOURCE_URL;
  if (!url)
    throw new Error('set LEDGERLENS_SOURCE_URL to a READ-ONLY role of the benchmark database');
  const source = openSource(url);
  await source.ensureReadOnly();
  const { snapshot, warnings } = await readSnapshot(
    { sourceUrl: url, applicationName: 'ledgerlens' },
    source.connect,
    {
      schemas: ['public'],
    },
  );
  const stats = new Map<string, Awaited<ReturnType<typeof readColumnStats>>>();
  await withSource(source.connect, async (c) => {
    for (const t of snapshot.tables) {
      const info = await readTable(c, { schema: t.schema, name: t.name, alias: null });
      if (info)
        stats.set(
          `${t.schema}.${t.name}`,
          await readColumnStats(
            c,
            info,
            t.columns.map((x) => x.name),
          ),
        );
    }
  });
  const out: unknown[] = [];
  const lines: string[] = [];
  for (const [i, s] of STATEMENTS.entries()) {
    const parsed = await parseStatement(s.sql);
    const stmt: WorkloadStatement = {
      queryId: `report-${i}`,
      queryHash: hashText(s.sql),
      rank: i + 1,
      text: s.sql,
      kind: parsed.kind,
      calls: 0,
      totalTimeMs: 0,
      meanTimeMs: 0,
      rows: 0,
      sharedBlksHit: 0,
      sharedBlksRead: 0,
      topLevel: true,
      tables: parsed.tables,
      paramCount: parsed.paramCount,
      parsed,
      parseError: null,
    };
    let findings;
    if (s.fixture) {
      const f = JSON.parse(
        readFileSync(path.join(root, 'ledgerlens/fixtures/plans', `${s.fixture}.json`), 'utf8'),
      );
      findings = await analyzePlan(parsePlan(f.plan), { snapshot, now: new Date() });
    }
    const r = await generateCandidates(
      {
        statements: [{ statement: stmt, findings }],
        snapshot,
        columnStats: (sc, t, c) => stats.get(`${sc}.${t}`)?.get(c),
      },
      { minTableRows: 10_000 },
    );
    out.push({
      label: s.label,
      hash: stmt.queryHash,
      findings: findings?.map((f) => ({ kind: f.kind, severity: f.severity, path: f.nodePath })),
      candidates: r.candidates,
      skipped: r.skipped,
    });
    lines.push(`\n### ${s.label}\n`);
    lines.push(
      `findings used: ${findings ? findings.map((f) => `${f.kind} (${f.severity})`).join(', ') || 'none' : 'none (no plan)'}`,
    );
    for (const c of r.candidates.filter((x) => x.targetedStatements.includes(stmt.queryHash)))
      lines.push(`- ${describe(c)}`);
    for (const k of r.skipped.filter((x) => x.targetedStatements.includes(stmt.queryHash)))
      lines.push(`- skipped (${k.reason}): ${k.subject.$untrusted}: ${k.detail}`);
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const dir = path.join(root, 'docs/benchmarks/raw');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `l3.3-candidates-${stamp}.json`);
  await writeFile(file, JSON.stringify({ snapshotWarnings: warnings, statements: out }, null, 2), {
    flag: 'wx',
  });
  console.log(lines.join('\n'));
  console.log(`\nraw: ${file}`);
}

function describe(c: Candidate): string {
  if (c.kind === 'rewrite_suggestion') return `rewrite_suggestion (${c.advice}): ${c.rationale}`;
  const extra =
    c.kind === 'create_index'
      ? `${c.index!.partial ? ' [partial]' : ''}${c.index!.include.length ? ' [covering]' : ''}${c.index!.partitions ? ` [${c.index!.partitions.length} partitions]` : ''}`
      : '';
  return `${c.kind}${extra}: ${c.upStatements[0]}${c.upStatements.length > 1 ? `  (+${c.upStatements.length - 1} statements)` : ''}`;
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
