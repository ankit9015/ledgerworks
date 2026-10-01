// Builds the baseline tables (markdown) from the raw k6 --summary-export files.
//   node ledgerline/k6/summarize.mjs [docs/benchmarks/raw]
// Only the measured phase (60 s, tag phase=measure) is reported; warmup is excluded.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] ?? 'docs/benchmarks/raw';
const MEASURE_SECONDS = 60;
const files = readdirSync(dir).filter((f) =>
  /^(ingest|usage-read|balance)_\w+_run\d+\.summary\.json$/.test(f),
);

const groups = new Map(); // "script|tenant" -> [{run, metrics}]
for (const f of files) {
  const [, script, tenant, run] = /^(.+?)_(\w+)_run(\d+)\.summary\.json$/.exec(f);
  const key = `${script}|${tenant}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push({
    run: Number(run),
    metrics: JSON.parse(readFileSync(path.join(dir, f), 'utf8')).metrics,
  });
}

const ms = (v) =>
  v === undefined ? 'n/a' : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(1)} ms`;
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const spread = (xs, fmt = ms) =>
  `${fmt(med(xs))} (${fmt(Math.min(...xs))} – ${fmt(Math.max(...xs))})`;

function row(label, runs, metricName) {
  const m = runs.map((r) => r.metrics[metricName]).filter(Boolean);
  if (!m.length || m.every((x) => !x.count)) return null;
  const counts = m.map((x) => x.count);
  return `| ${label} | ${runs.length} | ${spread(m.map((x) => x.med))} | ${spread(m.map((x) => x['p(95)']))} | ${spread(m.map((x) => x['p(99)']))} | ${spread(m.map((x) => x.max))} | ${counts.reduce((a, b) => a + b, 0).toLocaleString('en-US')} (${counts.map((c) => c.toLocaleString('en-US')).join(' / ')}) |`;
}

const order = ['usage-read', 'balance', 'ingest'];
const out = [];
out.push('### Latency, measured phase only (median of runs, with min – max across runs)\n');
out.push('| Scenario | Runs | p50 | p95 | p99 | max | Requests: total (per run) |');
out.push('|---|---|---|---|---|---|---|');
const sizes = ['huge', 'small'];
for (const script of order) {
  for (const tenant of sizes) {
    const runs = (groups.get(`${script}|${tenant}`) ?? []).sort((a, b) => a.run - b.run);
    if (!runs.length) continue;
    const label = `${script} / ${tenant}`;
    const r = row(label, runs, 'http_req_duration{phase:measure}');
    if (r) out.push(r);
    if (script === 'usage-read') {
      for (const p of [1, 2, 3]) {
        const rp = row(
          `&nbsp;&nbsp;↳ page ${p}`,
          runs,
          `http_req_duration{phase:measure,page:${p}}`,
        );
        if (rp) out.push(rp);
      }
    }
  }
}

out.push('\n### Errors, throughput and dropped iterations (per run: r1 / r2 / r3)\n');
out.push(
  '| Scenario | Error rate (measured) | Throughput (req/s) | Dropped iterations (measured) | Checks failed |',
);
out.push('|---|---|---|---|---|');
for (const script of order) {
  for (const tenant of sizes) {
    const runs = (groups.get(`${script}|${tenant}`) ?? []).sort((a, b) => a.run - b.run);
    if (!runs.length) continue;
    const err = runs.map((r) => {
      const m = r.metrics['http_req_failed{phase:measure}'];
      return m ? `${(m.value * 100).toFixed(2)}%` : 'n/a';
    });
    const thr = runs.map((r) =>
      (r.metrics['http_req_duration{phase:measure}'].count / MEASURE_SECONDS).toFixed(1),
    );
    const drop = runs.map((r) =>
      String(r.metrics['dropped_iterations{scenario:measure}']?.count ?? 0),
    );
    const chk = runs.map((r) => String(r.metrics.checks?.fails ?? 0));
    out.push(
      `| ${script} / ${tenant} | ${err.join(' / ')} | ${thr.join(' / ')} | ${drop.join(' / ')} | ${chk.join(' / ')} |`,
    );
  }
}
console.log(out.join('\n'));
