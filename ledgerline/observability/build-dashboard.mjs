// Generates grafana/dashboards/ledgerline.json (committed). Run: node ledgerline/observability/build-dashboard.mjs
import { writeFileSync } from 'node:fs';

const PROM = { type: 'prometheus', uid: 'ledgerline-prometheus' };
const PG = { type: 'grafana-postgresql-datasource', uid: 'ledgerline-postgres' };
let nextId = 1;

const ts = (
  title,
  description,
  targets,
  { unit = 'short', x, y, w = 8, h = 8, stack = false, min } = {},
) => ({
  id: nextId++,
  type: 'timeseries',
  title,
  description,
  datasource: PROM,
  gridPos: { x, y, w, h },
  fieldConfig: {
    defaults: {
      unit,
      min,
      custom: {
        drawStyle: 'line',
        lineWidth: 2,
        fillOpacity: stack ? 30 : 8,
        showPoints: 'never',
        stacking: { mode: stack ? 'normal' : 'none' },
        // Series are told apart by legend text and line style, not by colour alone.
        lineStyle: { fill: 'solid' },
      },
    },
    overrides: [],
  },
  options: {
    legend: { displayMode: 'table', placement: 'bottom', calcs: ['lastNotNull', 'max'] },
    tooltip: { mode: 'multi' },
  },
  targets: targets.map(([expr, legend], i) => ({
    refId: String.fromCharCode(65 + i),
    datasource: PROM,
    expr,
    legendFormat: legend,
  })),
});

const q = (p) =>
  `histogram_quantile(${p}, sum by (le, route) (rate(ledgerline_http_request_duration_seconds_bucket[1m])))`;

const panels = [
  {
    id: nextId++,
    type: 'row',
    title: 'API',
    collapsed: false,
    gridPos: { x: 0, y: 0, w: 24, h: 1 },
    panels: [],
  },
  ts(
    'Request latency p50 by route',
    'histogram_quantile over 1 m of request durations, per route pattern',
    [[q(0.5), '{{route}}']],
    { unit: 's', x: 0, y: 1 },
  ),
  ts('Request latency p95 by route', 'p95', [[q(0.95), '{{route}}']], { unit: 's', x: 8, y: 1 }),
  ts('Request latency p99 by route', 'p99', [[q(0.99), '{{route}}']], { unit: 's', x: 16, y: 1 }),
  ts(
    'Request rate by route',
    'requests per second, per route pattern',
    [['sum by (route) (rate(ledgerline_http_request_duration_seconds_count[1m]))', '{{route}}']],
    { unit: 'reqps', x: 0, y: 9 },
  ),
  ts(
    'Error rate (share of requests)',
    '5xx = server errors, 4xx = client errors (including 401 and validation failures)',
    [
      [
        'sum(rate(ledgerline_http_request_duration_seconds_count{status=~"5.."}[1m])) / sum(rate(ledgerline_http_request_duration_seconds_count[1m]))',
        '5xx share',
      ],
      [
        'sum(rate(ledgerline_http_request_duration_seconds_count{status=~"4.."}[1m])) / sum(rate(ledgerline_http_request_duration_seconds_count[1m]))',
        '4xx share',
      ],
    ],
    { unit: 'percentunit', x: 8, y: 9, min: 0 },
  ),
  ts(
    'Requests in flight',
    'requests currently being handled by the API process',
    [['ledgerline_http_requests_in_flight', 'in flight']],
    { x: 16, y: 9, min: 0 },
  ),
  {
    id: nextId++,
    type: 'row',
    title: 'Queue',
    collapsed: false,
    gridPos: { x: 0, y: 17, w: 24, h: 1 },
    panels: [],
  },
  ts(
    'Queue depth by state',
    'jobs per state (all tenants), read from the database at scrape time',
    [
      [
        'sum by (queue, state) (ledgerline_queue_jobs{state=~"queued|running|failed"})',
        '{{queue}} {{state}}',
      ],
    ],
    { x: 0, y: 18, stack: true, min: 0 },
  ),
  ts(
    'Oldest runnable job age',
    'seconds since the oldest queued or failed job became runnable; 0 when nothing waits',
    [['ledgerline_queue_oldest_runnable_job_age_seconds', '{{queue}}']],
    { unit: 's', x: 8, y: 18, min: 0 },
  ),
  ts(
    'Retries and dead letters',
    'cumulative attempts beyond the first, jobs in state dead, and worker events per second',
    [
      [
        'sum by (queue) (ledgerline_queue_retried_attempts)',
        'retried attempts (cumulative) {{queue}}',
      ],
      ['sum by (queue) (ledgerline_queue_jobs{state="dead"})', 'dead letters {{queue}}'],
      [
        'sum by (event) (rate(ledgerline_worker_job_events_total{event=~"retried|dead"}[1m]))',
        'rate/s {{event}}',
      ],
    ],
    { x: 16, y: 18, min: 0 },
  ),
  {
    id: nextId++,
    type: 'row',
    title: 'Credits and partitions',
    collapsed: false,
    gridPos: { x: 0, y: 26, w: 24, h: 1 },
    panels: [],
  },
  ts(
    'Debit outcomes',
    'debit attempts per second by outcome: accepted, rejected (insufficient credits), replayed (idempotent repeat), conflict',
    [['sum by (outcome) (rate(ledgerline_credit_debits_total[1m]))', '{{outcome}}']],
    { unit: 'ops', x: 0, y: 27, min: 0 },
  ),
  {
    id: nextId++,
    type: 'stat',
    title: 'Partitions created (since process start)',
    description:
      'usage_events partitions created by the automatic maintenance, and maintenance runs by result',
    datasource: PROM,
    gridPos: { x: 8, y: 27, w: 8, h: 8 },
    fieldConfig: {
      defaults: {
        unit: 'short',
        thresholds: { mode: 'absolute', steps: [{ color: 'text', value: null }] },
      },
      overrides: [],
    },
    options: {
      reduceOptions: { calcs: ['lastNotNull'] },
      textMode: 'value_and_name',
      colorMode: 'none',
    },
    targets: [
      {
        refId: 'A',
        datasource: PROM,
        expr: 'sum(ledgerline_partitions_created_total)',
        legendFormat: 'created',
      },
      {
        refId: 'B',
        datasource: PROM,
        expr: 'sum by (result) (ledgerline_partition_maintenance_runs_total)',
        legendFormat: 'runs {{result}}',
      },
    ],
  },
  {
    id: nextId++,
    type: 'text',
    title: 'Traces',
    gridPos: { x: 16, y: 27, w: 8, h: 8 },
    options: {
      mode: 'markdown',
      content:
        'Traces for the API (`ledgerline-api`: HTTP and database spans) and the queue worker (`ledgerline-worker`: claim, handler, ack with job id and attempt) are in Jaeger: http://localhost:16686. Spans never carry API keys, tenant ids or SQL text.',
    },
  },
  {
    id: nextId++,
    type: 'row',
    title: 'Database',
    collapsed: false,
    gridPos: { x: 0, y: 35, w: 24, h: 1 },
    panels: [],
  },
  {
    id: nextId++,
    type: 'table',
    title: 'Top slow queries (pg_stat_statements, read-only login)',
    description:
      'Normalised statements from pg_stat_statements for the ledgerworks database, by total time. Read through the ledgerline_metrics login (pg_read_all_stats only). Statement text is shown to dashboard viewers here, and is never exported as a metric label.',
    datasource: PG,
    gridPos: { x: 0, y: 36, w: 24, h: 10 },
    fieldConfig: { defaults: {}, overrides: [] },
    options: { showHeader: true, sortBy: [{ displayName: 'total ms', desc: true }] },
    targets: [
      {
        refId: 'A',
        datasource: PG,
        format: 'table',
        rawQuery: true,
        editorMode: 'code',
        rawSql: `SELECT left(regexp_replace(s.query, '\\s+', ' ', 'g'), 140) AS statement,
       s.calls,
       round(s.mean_exec_time::numeric, 3) AS "mean ms",
       round(s.max_exec_time::numeric, 1) AS "max ms",
       round(s.total_exec_time::numeric, 1) AS "total ms",
       s.rows
FROM pg_stat_statements s JOIN pg_database d ON d.oid = s.dbid
WHERE d.datname = 'ledgerworks' AND s.query NOT ILIKE '%pg_stat_%'
ORDER BY s.total_exec_time DESC LIMIT 15`,
      },
    ],
  },
];

const dashboard = {
  uid: 'ledgerline-overview',
  title: 'Ledgerline overview',
  tags: ['ledgerline'],
  timezone: 'browser',
  schemaVersion: 39,
  version: 1,
  refresh: '5s',
  time: { from: 'now-15m', to: 'now' },
  templating: { list: [] },
  annotations: { list: [] },
  panels,
};
writeFileSync(
  new URL('./grafana/dashboards/ledgerline.json', import.meta.url),
  JSON.stringify(dashboard, null, 2) + '\n',
);
console.log(`wrote dashboard with ${panels.length} panels`);
