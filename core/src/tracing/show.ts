/**
 * pnpm trace:show <file.jsonl> [--run <n | runId-prefix>] [--list] [--prices <file.json>]
 *
 * Prints one run from a JSONL trace file as a readable timeline. Default: the last run in the file.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { RunTrace } from '../agent/types.js';
import { sanitizeText } from '../tools/untrusted.js';
import { computeCost, type PriceTable } from './cost.js';
import { TraceLineSchema } from './schema.js';

export function parseTraceFile(text: string): { runs: RunTrace[]; bad: number } {
  const runs: RunTrace[] = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const p = TraceLineSchema.safeParse(JSON.parse(line));
      if (p.success) runs.push(p.data.trace as RunTrace);
      else bad++;
    } catch {
      bad++;
    }
  }
  return { runs, bad };
}

const ms = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`;
const bytes = (n: number): string => (n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`);

/** A readable timeline of one run: steps, provider routing, tool calls, outcomes, repairs, truncations, tokens, latency. */
export function renderTrace(t: RunTrace, prices?: PriceTable): string {
  const o: string[] = [];
  const tot = t.totals;
  o.push(
    `run ${t.runId}  ${t.stopReason.toUpperCase()}  ${t.startedAt}  ${ms(tot.wallMs)}${t.debug ? '  (debug content present)' : ''}`,
  );
  o.push(
    `tokens ${tot.promptTokens} in + ${tot.completionTokens} out = ${tot.totalTokens} (${tot.tokensEstimated ? 'some ESTIMATED' : 'reported by the provider'})`,
  );
  const cost = computeCost(t, prices);
  o.push(`cost   ${cost.usd === null ? cost.note : `$${cost.usd.toFixed(6)} (${cost.note})`}`);
  o.push('');
  for (const s of t.steps) {
    const m = s.model;
    const when = new Date(m.startedAt).getTime() - new Date(t.startedAt).getTime();
    const tok = m.usage
      ? `${m.usage.totalTokens} tok${m.usage.source === 'estimated' ? ' (est.)' : ''}`
      : 'no usage';
    o.push(
      `+${String(when).padStart(5)} ms  step ${s.index}  ${sanitizeText(m.provider, 60)} / ${sanitizeText(m.model, 80)}  ${ms(m.latencyMs)}  ${tok}  finish ${m.finishReason ?? '-'}`,
    );
    if (m.routing) {
      o.push(
        m.routing.skipped.length
          ? `            routing: served by ${sanitizeText(m.routing.provider, 60)}; FELL OVER from ${m.routing.skipped.map((x) => `${sanitizeText(x.provider, 60)} (${sanitizeText(x.reason, 100)})`).join(', ')}`
          : `            routing: served by ${sanitizeText(m.routing.provider, 60)}`,
      );
    }
    if (m.quirks?.length) o.push(`            adapter normalised: ${m.quirks.join(', ')}`);
    if (m.error)
      o.push(
        `            MODEL CALL FAILED: ${sanitizeText(m.error.kind, 40)}${m.error.retryAfterMs ? ` (retry after ${ms(m.error.retryAfterMs)})` : ''}: ${sanitizeText(m.error.message, 200)}`,
      );
    for (const c of s.toolCalls) {
      const flags = [
        c.repair ? 'REPAIRED' : '',
        c.truncated ? 'TRUNCATED' : '',
        c.abandoned ? 'ABANDONED' : '',
        c.approval !== 'not_required' ? `approval ${c.approval}` : '',
      ]
        .filter(Boolean)
        .join(', ');
      o.push(
        `              tool ${sanitizeText(c.name, 40)}  ${c.outcome}  ${ms(c.latencyMs)}  args #${c.argumentsHash} (${bytes(c.argumentsBytes)})  result #${c.resultHash} (${bytes(c.resultBytes)})${flags ? `  [${flags}]` : ''}`,
      );
      if (t.debug && c.arguments !== undefined)
        o.push(`                args: ${JSON.stringify(c.arguments).slice(0, 200)}`);
    }
  }
  o.push('');
  o.push(
    `${tot.steps} step(s), ${tot.toolCalls} tool call(s): ${tot.toolErrors} not ok, ${tot.repairs} repaired, ${tot.failures} failed for good, ${tot.truncations} truncated`,
  );
  return o.join('\n');
}

export function listRuns(runs: RunTrace[]): string {
  return runs
    .map(
      (r, i) =>
        `${String(i).padStart(3)}  ${r.runId.slice(0, 8)}  ${r.startedAt}  ${r.stopReason.padEnd(14)}  ${r.totals.steps} steps  ${r.totals.totalTokens} tok  ${ms(r.totals.wallMs)}`,
    )
    .join('\n');
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      run: { type: 'string' },
      list: { type: 'boolean', default: false },
      prices: { type: 'string' },
    },
  });
  const file = positionals[0];
  if (!file) {
    console.error(
      'usage: pnpm trace:show <file.jsonl> [--run <n|runId-prefix>] [--list] [--prices <prices.json>]',
    );
    process.exit(2);
  }
  const { runs, bad } = parseTraceFile(await readFile(file, 'utf8'));
  if (bad) console.error(`(${bad} line(s) were not valid trace lines and were skipped)`);
  if (runs.length === 0) {
    console.error('no runs in that file');
    process.exit(1);
  }
  if (values.list) return void console.log(listRuns(runs));
  let pick: RunTrace | undefined = runs[runs.length - 1];
  if (values.run !== undefined)
    pick = /^\d+$/.test(values.run)
      ? runs[Number(values.run)]
      : runs.find((r) => r.runId.startsWith(values.run!));
  if (!pick) {
    console.error(`no such run: ${values.run}`);
    process.exit(1);
  }
  const prices = values.prices
    ? (JSON.parse(await readFile(values.prices, 'utf8')) as PriceTable)
    : undefined;
  console.log(renderTrace(pick, prices));
}

if (process.argv[1] && /show\.[tj]s$/.test(process.argv[1])) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
