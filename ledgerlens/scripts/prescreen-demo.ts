/**
 * L3.4 on the Ledgerline benchmark data: the HypoPG pre-screen on a SHADOW (never the source).
 *
 *   LEDGERLENS_SHADOW_RUN_ID=<run id of a full shadow of the benchmark database> \
 *     LEDGERLENS_SOURCE_URL=<read-only URL of the source, only to check that it was not touched> \
 *     pnpm --filter @ledgerworks/ledgerlens prescreen:demo
 *
 * 1. PLANTED missing index: the real index usage_events_tenant_time_idx is dropped on the shadow (the
 *    source keeps it; the script checks that at the end), the statistics are settled, and candidates
 *    are generated from the shadow's schema for the Ledgerline usage read.
 * 2. USELESS index: a candidate on usage_events(event_type), whose every value matches a few percent
 *    of 10,000,000 rows.
 * Both are pre-screened with HypoPG. Raw report: docs/benchmarks/raw/l3.4-prescreen-<stamp>.json
 * (a new name every run).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertShadow, attachShadow, provisionReaderRole } from '@ledgerworks/core';
import { generateCandidates } from '../src/candidates/generate.js';
import type { SqlCandidate } from '../src/candidates/types.js';
import { prescreenCandidates, renderPrescreenReport } from '../src/prescreen/index.js';
import { readSnapshot } from '../src/schema/snapshot.js';
import { parseStatement } from '../src/sql/parse.js';
import { bindStatement, type StatementBindings } from '../src/workload/bindings.js';
import {
  hashText,
  openSource,
  readColumnStats,
  readTable,
  withSource,
} from '../src/workload/source.js';
import type { WorkloadStatement } from '../src/workload/types.js';
import { validateBindings } from '../src/workload/validate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const USAGE_READ = `SELECT id, event_type, quantity, to_char(occurred_at AT TIME ZONE $5, $6) AS occurred_at, metadata FROM usage_events WHERE tenant_id = $1 AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz ORDER BY usage_events.occurred_at DESC, usage_events.id DESC LIMIT $4`;
const BY_EVENT_TYPE = 'SELECT id, tenant_id, occurred_at FROM usage_events WHERE event_type = $1';

async function toStatement(sql: string, rank: number): Promise<WorkloadStatement> {
  const parsed = await parseStatement(sql);
  return {
    queryId: `demo-${rank}`,
    queryHash: hashText(sql),
    rank,
    text: sql,
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
}

async function main(): Promise<void> {
  const runId = process.env.LEDGERLENS_SHADOW_RUN_ID;
  const sourceUrl = process.env.LEDGERLENS_SOURCE_URL;
  if (!runId || !sourceUrl)
    throw new Error('set LEDGERLENS_SHADOW_RUN_ID and LEDGERLENS_SOURCE_URL');
  const shadow = await attachShadow(runId);
  const admin = await shadow.connect();
  await assertShadow(admin);
  const lines: string[] = [];
  const say = (s: string): void => {
    lines.push(s);
    console.log(s);
  };

  // ---- 1. plant the missing index, on the shadow only -------------------------------------------------
  const existing = await admin.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'usage_events' AND schemaname = 'public'`,
  );
  say(
    `indexes on usage_events (parent) in the shadow before: ${existing.rows.map((r) => r.indexname).join(', ')}`,
  );
  if (existing.rows.some((r) => r.indexname === 'usage_events_tenant_time_idx')) {
    await admin.query('DROP INDEX public.usage_events_tenant_time_idx');
    say('planted: dropped usage_events_tenant_time_idx on the SHADOW (the source keeps its copy)');
  } else say('(the index was already dropped on this shadow by an earlier run)');

  // ---- 2. schema and bindings from the shadow, through a read-only role ----------------------------------
  await provisionReaderRole(shadow.connectionString(), {
    role: 'll_reader',
    password: 'll_reader_dev',
    database: 'shadow',
  });
  const ru = new URL(shadow.connectionString());
  ru.username = 'll_reader';
  ru.password = 'll_reader_dev';
  const src = openSource(ru.toString());
  await src.ensureReadOnly();
  const { snapshot } = await readSnapshot(
    { sourceUrl: ru.toString(), applicationName: 'ledgerlens' },
    src.connect,
    { schemas: ['public'] },
  );
  const ue = snapshot.tables.find((t) => t.name === 'usage_events')!;
  say(
    `schema read from the shadow: usage_events has ${ue.partitionCount} partitions and these parent indexes: ${ue.indexes.map((i) => i.name).join(', ')}`,
  );

  const stmts = [await toStatement(USAGE_READ, 1), await toStatement(BY_EVENT_TYPE, 2)];
  const bound: StatementBindings[] = [];
  const stats = new Map<string, Awaited<ReturnType<typeof readColumnStats>>>();
  await withSource(src.connect, async (c) => {
    for (const s of stmts) bound.push(await bindStatement(c, s, { sets: 3 }));
    const info = (await readTable(c, { schema: 'public', name: 'usage_events', alias: null }))!;
    stats.set(
      'public.usage_events',
      await readColumnStats(
        c,
        info,
        info.columns.map((x) => x.name),
      ),
    );
  });
  const checked: StatementBindings[] = [];
  for (const [i, s] of stmts.entries())
    checked.push(await validateBindings(src.connect, s, bound[i]!));
  for (const [i, s] of stmts.entries())
    say(
      `statement ${i + 1} (${s.queryHash.slice(0, 8)}): bindings ${checked[i]!.status}, ${checked[i]!.sets.length} set(s), provenance ${checked[i]!.sets[0]?.provenance ?? '-'}`,
    );

  // ---- 3. candidates from the rules -----------------------------------------------------------------------------
  const gen = await generateCandidates(
    {
      statements: stmts.map((statement, i) => ({ statement, bindings: checked[i] })),
      snapshot,
      columnStats: (s, t, c) => stats.get(`${s}.${t}`)?.get(c),
    },
    { minTableRows: 10_000 },
  );
  const creates = gen.candidates.filter((c): c is SqlCandidate => c.kind === 'create_index');
  say(
    `candidates: ${creates.length} create_index; skipped: ${gen.skipped.map((k) => k.reason).join(', ') || 'none'}`,
  );
  for (const c of creates)
    say(
      `  ${c.id}  ${c.index!.key.map((k) => k.name).join(', ')}${c.index!.include.length ? ` INCLUDE (${c.index!.include.join(', ')})` : ''}${c.index!.partial ? ' [partial]' : ''}  targets ${c.targetedStatements.map((h) => h.slice(0, 8)).join(',')}`,
    );

  const byHash = new Map(
    stmts.map((s, i) => [s.queryHash, { statement: s, bindings: checked[i]! }]),
  );
  const inputs = creates.map((candidate) => ({
    candidate,
    statements: candidate.targetedStatements.map((h) => byHash.get(h)!).filter(Boolean),
  }));
  const reports = await prescreenCandidates(shadow, inputs, { settle: 'always' });
  say('');
  for (const r of reports) say(`${renderPrescreenReport(r)}\n`);

  // ---- 3b. the useless case: the application only ever asks for the dominant event types -------------------------
  const stats2 = stats.get('public.usage_events')!.get('event_type')!;
  say(
    `event_type statistics: ${stats2.mcv.map((m) => `${m.value} ${(m.freq * 100).toFixed(1)}%`).join(', ')} (${stats2.nDistinct} distinct values)`,
  );
  const dominant = stats2.mcv.slice(0, 1).map((m) => [m.value]);
  const dominantBound = await withSource(src.connect, (c) =>
    bindStatement(c, stmts[1]!, { sets: 1, userBindings: { [stmts[1]!.queryId]: dominant } }),
  );
  const dominantChecked = await validateBindings(src.connect, stmts[1]!, dominantBound);
  const plainEventType = creates.find(
    (c) =>
      c.index!.key.length === 1 &&
      c.index!.key[0]!.name === 'event_type' &&
      c.index!.include.length === 0,
  )!;
  const [useless] = await prescreenCandidates(
    shadow,
    [
      {
        candidate: plainEventType,
        statements: [{ statement: stmts[1]!, bindings: dominantChecked }],
      },
    ],
    { settle: 'never' },
  );
  say(
    '--- the same index, when the statement is only ever run with the dominant event type (user-supplied value) ---',
  );
  say(renderPrescreenReport(useless!));
  reports.push(useless!);

  // ---- 4. the source was not touched --------------------------------------------------------------------------------
  const check = openSource(sourceUrl);
  await check.ensureReadOnly();
  const srcIdx = await withSource(check.connect, (c) =>
    c.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'usage_events' AND schemaname = 'public'`,
    ),
  );
  say(
    `source indexes on usage_events afterwards: ${srcIdx.rows.map((r) => r.indexname).join(', ')}`,
  );

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const dir = path.join(root, 'docs/benchmarks/raw');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `l3.4-prescreen-${stamp}.json`);
  await writeFile(
    file,
    JSON.stringify(
      {
        shadowRunId: runId,
        manifestId: shadow.manifest.id,
        log: lines,
        reports,
        candidates: creates,
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
  console.log(`raw: ${file}`);
  await admin.end();
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
