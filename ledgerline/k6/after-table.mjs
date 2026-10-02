// Builds the comparison tables of docs/benchmarks/after.md from the raw k6 summary files.
//   node ledgerline/k6/after-table.mjs
// Three sets per scenario: the baseline as recorded on 2026-10-01 (files run1..3), the SAME baseline
// code re-run today in the same session as the final code, interleaved round by round (tag base2), and the final code
// (tag final2). Medians with min - max over the 3 runs, measured phase only.
import { execFileSync } from 'node:child_process';

const stats = (tag) =>
  JSON.parse(
    execFileSync('node', ['ledgerline/k6/stats.mjs', tag, 'docs/benchmarks/raw', '--json']),
  );
const recorded = stats('-');
const today = stats('base2');
const final = stats('final2');
// Two further samples of the FINAL code (the first compare attempt; see raw/NOTE-basetoday-was-final-code.txt)
const extraA = stats('final');
const extraB = stats('basetoday');

const f = (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(1)} ms`);
const cell = (x) => (x ? `${f(x.median)} (${f(x.min)} – ${f(x.max)})` : 'n/a');
const order = [
  'usage-read / huge',
  'usage-read / small',
  'balance / huge',
  'balance / small',
  'ingest / huge',
  'ingest / small',
];

for (const metric of ['p50', 'p95', 'p99']) {
  console.log(`\n#### ${metric}\n`);
  console.log(
    '| Scenario | Baseline as recorded 2026-10-01 | Baseline code re-run today | **Final code (today)** | Final vs baseline-today (median) |',
  );
  console.log('|---|---|---|---|---|');
  for (const k of order) {
    const a = recorded[k]?.[metric];
    const b = today[k]?.[metric];
    const c = final[k]?.[metric];
    const delta = b && c ? `${(((c.median - b.median) / b.median) * 100).toFixed(0)}%` : 'n/a';
    console.log(`| ${k} | ${cell(a)} | ${cell(b)} | **${cell(c)}** | ${delta} |`);
  }
}

console.log('\n#### Dropped iterations and failed requests per run (r1 / r2 / r3)\n');
console.log('| Scenario | Set | Requests per run | Dropped | Failed |');
console.log('|---|---|---|---|---|');
for (const k of order) {
  for (const [name, set] of [
    ['recorded', recorded],
    ['baseline today', today],
    ['final', final],
  ]) {
    const r = set[k];
    if (!r) continue;
    console.log(
      `| ${k} | ${name} | ${r.requests.join(' / ')} | ${r.dropped.join(' / ')} | ${r.failedRate.map((x) => `${(x * 100).toFixed(2)}%`).join(' / ')} |`,
    );
  }
}

console.log(
  '#### Run-to-run check: three independent samples of the final code (p95, median and range of 3 runs)',
);
console.log(
  '| Scenario | final2 (main set) | first attempt (tag final) | accidental second (tag basetoday) |',
);
console.log('|---|---|---|---|');
for (const k of order) {
  console.log(
    `| ${k} | ${cell(final[k]?.p95)} | ${cell(extraA[k]?.p95)} | ${cell(extraB[k]?.p95)} |`,
  );
}
