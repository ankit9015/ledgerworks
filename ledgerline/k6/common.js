// Shared by every k6 script. Load profile (identical for every run, see docs/benchmarks/baseline.md):
//   warmup : constant arrival rate, 30s, tagged phase=warmup (excluded from reported numbers)
//   measure: same rate, 60s, starts 5s after the warmup ends, tagged phase=measure
// Thresholds are defined in each script for information only; failing them does not fail the run.
import { SharedArray } from 'k6/data';

export const BASE_URL = __ENV.BASE_URL || 'http://host.docker.internal:3000';

// Raw API keys come from a gitignored file mounted at /seed (never printed, never committed).
const tenants = new SharedArray('tenants', () => JSON.parse(open('/seed/keys.json')).tenants);

export function currentTenant() {
  const size = __ENV.TENANT;
  const t = tenants.find((x) => x.size === size);
  if (!t) throw new Error(`TENANT must be one of ${tenants.map((x) => x.size).join(', ')}`);
  return t;
}

export function authHeaders(tenant) {
  return { Authorization: `Bearer ${tenant.apiKey}`, 'Content-Type': 'application/json' };
}

export const WARMUP = '30s';
export const MEASURE = '60s';

export function scenarios(rate) {
  const base = {
    executor: 'constant-arrival-rate',
    rate,
    timeUnit: '1s',
    preAllocatedVUs: 50,
    maxVUs: 400,
    exec: 'run',
  };
  return {
    warmup: { ...base, duration: WARMUP, tags: { phase: 'warmup' } },
    measure: { ...base, startTime: '35s', duration: MEASURE, tags: { phase: 'measure' } },
  };
}

export const summaryTrendStats = ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'];
