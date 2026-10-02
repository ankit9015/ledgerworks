// Median and range over the runs of one tag, from the raw k6 --summary-export files.
//   node ledgerline/k6/stats.mjs <tag> [raw dir]          (prints a markdown table)
//   node ledgerline/k6/stats.mjs <tag> [raw dir] --json    (prints JSON)
// Files looked at: <script>_<tenant>_run<tag><N>.summary.json. Measured phase only.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const tag = process.argv[2] === '-' ? '' : process.argv[2]; // '-' = the original baseline files (run1..3)
const dir =
  process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'docs/benchmarks/raw';
const asJson = process.argv.includes('--json');
if (process.argv[2] === undefined) throw new Error('usage: stats.mjs <tag|-> [dir]');

const re = new RegExp(`^(.+?)_(\\w+?)_run${tag}(\\d)\\.summary\\.json$`);
const groups = new Map();
for (const f of readdirSync(dir)) {
  const m = re.exec(f);
  if (!m) continue;
  const key = `${m[1]} / ${m[2]}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(JSON.parse(readFileSync(path.join(dir, f), 'utf8')).metrics);
}

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const result = {};
for (const [key, runs] of [...groups].sort()) {
  const d = runs.map((m) => m['http_req_duration{phase:measure}']);
  const stat = (name) => {
    const xs = d.map((x) => x[name]);
    return { median: med(xs), min: Math.min(...xs), max: Math.max(...xs), all: xs };
  };
  const reqs = runs.map((m) => m['http_req_duration{phase:measure}'].count);
  const dropped = runs.map((m) => m['dropped_iterations{scenario:measure}']?.count ?? 0);
  const failed = runs.map(
    (m) =>
      m['http_req_failed{phase:measure}']?.value ?? m['http_req_failed{phase:measure}']?.rate ?? 0,
  );
  result[key] = {
    runs: runs.length,
    p50: stat('med'),
    p95: stat('p(95)'),
    p99: stat('p(99)'),
    requests: reqs,
    throughputPerSec: reqs.map((c) => c / 60),
    dropped,
    failedRate: failed,
  };
}
if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const f = (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(1)} ms`);
  const s = (x) => `${f(x.median)} (${f(x.min)} – ${f(x.max)})`;
  console.log('| Scenario | Runs | p50 | p95 | p99 | Requests per run | Dropped | Failed |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const [k, r] of Object.entries(result)) {
    console.log(
      `| ${k} | ${r.runs} | ${s(r.p50)} | ${s(r.p95)} | ${s(r.p99)} | ${r.requests.join(' / ')} | ${r.dropped.join(' / ')} | ${r.failedRate.map((x) => (x * 100).toFixed(2) + '%').join(' / ')} |`,
    );
  }
}
