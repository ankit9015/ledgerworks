import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { measureDdl, type DdlHooks } from './ddl.js';
import { measureQuery } from './query.js';
import type { DdlMeasurement, QueryMeasurement } from './schema.js';
import type { MeasurementTarget } from './session.js';
import { computeStats } from './stats.js';

export interface VarianceCase {
  name: string;
  description: string;
  kind: 'query' | 'ddl';
  /** options of measureQuery / measureDdl */
  options: Record<string, unknown>;
  hooks?: DdlHooks;
}

export interface VarianceCaseResult {
  name: string;
  description: string;
  kind: 'query' | 'ddl';
  statement: string;
  repetitions: number;
  failures: number;
  /** p50 of each repetition (wall clock; for DDL the duration), ms */
  p50WallMs: number[];
  /** p50 server-side execution time of each repetition, ms (queries only) */
  p50ServerMs: number[];
  /** coefficient of variation inside each repetition (percent), wall clock */
  withinCvPercent: number[];
  /** statistics of the repetition p50s (what run-to-run variance means) */
  acrossWall: ReturnType<typeof computeStats>;
  acrossServer: ReturnType<typeof computeStats> | null;
  /** (max - min) / mean of the repetition p50s, percent */
  spreadPercent: number;
  rawFile: string | null;
}

export interface VarianceReport {
  cases: VarianceCaseResult[];
  markdown: string;
}

/**
 * Runs each case `repetitions` times (each a full measureQuery / measureDdl, with its own warmup and
 * measured runs), writes every raw measurement of a case to its own file (never overwriting) and
 * returns the run-to-run statistics.
 */
export async function runVarianceExperiment(o: {
  target: MeasurementTarget;
  cases: VarianceCase[];
  repetitions: number;
  /** directory for raw files; null to not write */
  outDir: string | null;
  stamp: string;
  /** anything that should be stored next to the raw data: machine, limits, manifest id, notes */
  context: Record<string, unknown>;
  onProgress?: (msg: string) => void;
}): Promise<VarianceReport> {
  const results: VarianceCaseResult[] = [];
  for (const c of o.cases) {
    const runs: (QueryMeasurement | DdlMeasurement)[] = [];
    for (let r = 0; r < o.repetitions; r++) {
      o.onProgress?.(`${c.name}: repetition ${r + 1}/${o.repetitions}`);
      runs.push(
        c.kind === 'query'
          ? await measureQuery(o.target, c.options)
          : await measureDdl(o.target, c.options, c.hooks),
      );
    }
    const ok = runs.filter((m) => m.status === 'ok');
    const wallStats = ok.map((m) =>
      m.kind === 'query' ? m.wallMs : (m as Extract<DdlMeasurement, { status: 'ok' }>).durationMs,
    );
    const p50Wall = wallStats.map((s) => s.p50);
    const p50Server = ok
      .filter((m) => m.kind === 'query')
      .map((m) => (m as Extract<QueryMeasurement, { status: 'ok' }>).serverExecMs.p50);
    const across = computeStats(p50Wall);
    const statement =
      ok[0] && ok[0].status === 'ok' ? ok[0].statement.sql : String(c.options.sql ?? '');
    let rawFile: string | null = null;
    if (o.outDir) {
      rawFile = path.join(o.outDir, `c2.2-variance-${c.name}-${o.stamp}.json`);
      await writeFile(
        rawFile,
        JSON.stringify(
          { case: c.name, description: c.description, context: o.context, repetitions: runs },
          null,
          2,
        ) + '\n',
        { flag: 'wx' }, // never overwrite raw output
      );
    }
    results.push({
      name: c.name,
      description: c.description,
      kind: c.kind,
      statement,
      repetitions: o.repetitions,
      failures: runs.length - ok.length,
      p50WallMs: p50Wall,
      p50ServerMs: p50Server,
      withinCvPercent: wallStats.map((s) => s.cvPercent),
      acrossWall: across,
      acrossServer: p50Server.length ? computeStats(p50Server) : null,
      spreadPercent: across.mean === 0 ? 0 : ((across.max - across.min) / across.mean) * 100,
      rawFile: rawFile ? path.basename(rawFile) : null,
    });
  }
  return { cases: results, markdown: varianceMarkdown(results) };
}

const f = (n: number): string => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(3));

export function varianceMarkdown(cases: VarianceCaseResult[]): string {
  const rows = cases.map((c) => {
    const w = c.acrossWall;
    const s = c.acrossServer;
    const within = computeStats(c.withinCvPercent);
    return `| ${c.name} | ${c.repetitions - c.failures}/${c.repetitions} | ${f(w.mean)} | ${f(w.min)} to ${f(w.max)} | ${w.cvPercent.toFixed(1)}% | ${c.spreadPercent.toFixed(1)}% | ${s ? f(s.mean) : '-'} | ${s ? s.cvPercent.toFixed(1) + '%' : '-'} | ${within.mean.toFixed(1)}% (max ${within.max.toFixed(1)}%) |`;
  });
  return [
    '| case | ok runs | mean of p50 wall (ms) | p50 wall range (ms) | CV of p50 wall across repetitions | spread (max-min)/mean | mean of p50 server (ms) | CV of p50 server | CV of the 20 runs inside one repetition (mean, max) |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}
