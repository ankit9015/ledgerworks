// GET /v1/credits/balance at a constant arrival rate.
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, authHeaders, currentTenant, scenarios, summaryTrendStats } from './common.js';

const RATE = Number(__ENV.RATE || 100);
const tenant = currentTenant();

export const options = {
  scenarios: scenarios(RATE),
  summaryTrendStats,
  thresholds: {
    'http_req_duration{phase:measure}': ['p(95)<100'],
    'http_req_failed{phase:measure}': ['rate<0.01'],
    'dropped_iterations{scenario:measure}': ['count==0'],
  },
};

export function run() {
  const res = http.get(`${BASE_URL}/v1/credits/balance`, { headers: authHeaders(tenant) });
  check(res, { 'status is 200': (r) => r.status === 200 });
}
