/**
 * pnpm workload:report [--top 20] [--user-bindings file.json] [--out docs/benchmarks/raw] [--label name]
 *
 * Reads the workload of the database behind $LEDGERLENS_SOURCE_URL (a READ-ONLY role, see core's
 * provisionReaderRole), builds parameter bindings, asks the server to EXPLAIN each SELECT with them,
 * and writes the full report as JSON under a NEW file name (an existing file is never overwritten).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { UserBindingsFileSchema, bindStatement, type StatementBindings } from './bindings.js';
import { buildWorkloadReport, renderWorkloadReport } from './report.js';
import { openSource, readWorkload, withSource } from './source.js';
import { validateBindings } from './validate.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** sampled values can be real data (ids, emails): they are left out of the file unless asked for */
function withoutValues(list: StatementBindings[]): StatementBindings[] {
  return list.map((b) => ({
    ...b,
    sets: b.sets.map((s) => ({
      ...s,
      params: s.params.map((p) => ({
        ...p,
        value: p.value === null ? null : '(omitted, use --include-values)',
      })),
    })),
  }));
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      top: { type: 'string', default: '20' },
      'user-bindings': { type: 'string' },
      out: { type: 'string', default: path.join(repoRoot, 'docs/benchmarks/raw') },
      'include-values': { type: 'boolean', default: false },
      label: { type: 'string', default: 'l3.1-workload-bindings' },
      sets: { type: 'string', default: '3' },
    },
  });
  const url = process.env.LEDGERLENS_SOURCE_URL;
  if (!url) {
    console.error('set LEDGERLENS_SOURCE_URL to the connection string of a READ-ONLY role');
    process.exit(2);
  }
  const source = openSource(url);
  await source.ensureReadOnly();
  const userBindings = values['user-bindings']
    ? UserBindingsFileSchema.parse(JSON.parse(await readFile(values['user-bindings'], 'utf8')))
    : undefined;
  const workload = await readWorkload(source.connect);
  const bound: StatementBindings[] = [];
  const cache = { tables: new Map(), stats: new Map() };
  await withSource(source.connect, async (c) => {
    for (const s of workload.statements)
      bound.push(await bindStatement(c, s, { sets: Number(values.sets), userBindings }, cache));
  });
  const validated: StatementBindings[] = [];
  for (const [i, s] of workload.statements.entries())
    validated.push(await validateBindings(source.connect, s, bound[i]!));
  const report = buildWorkloadReport(workload, validated, Number(values.top));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  await mkdir(values.out!, { recursive: true });
  const file = path.join(values.out!, `${values.label}-${stamp}.json`);
  await writeFile(
    file,
    JSON.stringify(
      { report, bindings: values['include-values'] ? validated : withoutValues(validated) },
      null,
      2,
    ),
    { flag: 'wx' },
  );
  console.log(renderWorkloadReport(report));
  console.log(`\nraw report: ${file}`);
}

if (process.argv[1] && /cli\.[tj]s$/.test(process.argv[1])) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
