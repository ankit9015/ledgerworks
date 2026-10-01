// POST /v1/usage-events at a constant arrival rate. Events carry event_type "k6.baseline" and get
// occurred_at = now() (partition usage_events_2026_10, empty after seeding); the harness truncates
// that partition after the ingest runs so the dataset is back to exactly the seeded rows.
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, authHeaders, currentTenant, scenarios, summaryTrendStats } from './common.js';

const RATE = Number(__ENV.RATE || 100);
const tenant = currentTenant();

export const options = {
  scenarios: scenarios(RATE),
  summaryTrendStats,
  thresholds: {
    'http_req_duration{phase:measure}': ['p(95)<200'],
    'http_req_failed{phase:measure}': ['rate<0.01'],
    'dropped_iterations{scenario:measure}': ['count==0'],
  },
};

export function run() {
  const body = JSON.stringify({
    eventType: 'k6.baseline',
    quantity: 1 + Math.floor(Math.random() * 1000),
    metadata: { src: 'k6' },
  });
  const res = http.post(`${BASE_URL}/v1/usage-events`, body, { headers: authHeaders(tenant) });
  check(res, { 'status is 201': (r) => r.status === 201 });
}
