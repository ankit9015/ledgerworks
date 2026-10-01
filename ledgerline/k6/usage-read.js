// GET /v1/usage for one tenant over a random 7-day window inside the seeded year, newest first,
// limit=50. Each iteration reads page 1 and, while a cursor is returned, up to 2 more pages.
// Requests are tagged page=1|2|3 so the report can show them separately.
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, authHeaders, currentTenant, scenarios, summaryTrendStats } from './common.js';

const RATE = Number(__ENV.RATE || 2);
const tenant = currentTenant();
const WINDOW_START = Date.parse('2025-10-01T00:00:00Z');
const DAY = 24 * 3600 * 1000;

export const options = {
  scenarios: scenarios(RATE),
  summaryTrendStats,
  thresholds: {
    'http_req_duration{phase:measure}': ['p(95)<500'],
    'http_req_duration{phase:measure,page:1}': ['p(95)<500'],
    'http_req_duration{phase:measure,page:2}': ['p(95)<500'],
    'http_req_duration{phase:measure,page:3}': ['p(95)<500'],
    'http_req_failed{phase:measure}': ['rate<0.01'],
    'dropped_iterations{scenario:measure}': ['count==0'],
  },
};

export function run() {
  const startDay = Math.floor(Math.random() * (365 - 7));
  const from = new Date(WINDOW_START + startDay * DAY).toISOString();
  const to = new Date(WINDOW_START + (startDay + 7) * DAY).toISOString();
  let cursor = null;
  for (let page = 1; page <= 3; page++) {
    const qs = `from=${from}&to=${to}&limit=50${cursor ? `&cursor=${cursor}` : ''}`;
    const res = http.get(`${BASE_URL}/v1/usage?${qs}`, {
      headers: authHeaders(tenant),
      tags: { page: String(page), name: 'GET /v1/usage' },
    });
    const ok = check(res, { 'status is 200': (r) => r.status === 200 });
    if (!ok) return;
    cursor = res.json('nextCursor');
    if (!cursor) return;
  }
}
