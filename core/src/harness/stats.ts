import type { Stats } from './schema.js';

/** Percentile by linear interpolation between closest ranks (the "type 7" definition, as in numpy). */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0]!;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
}

export function computeStats(values: number[]): Stats {
  const n = values.length;
  if (n === 0) return { n: 0, min: 0, max: 0, mean: 0, stddev: 0, cvPercent: 0, p50: 0, p95: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const stddev = Math.sqrt(variance);
  return {
    n,
    min: sorted[0]!,
    max: sorted[n - 1]!,
    mean,
    stddev,
    cvPercent: mean === 0 ? 0 : (stddev / mean) * 100,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
  };
}

/** Index of the median element (lower median for an even count), by the given key. */
export function medianIndex(values: number[]): number {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  return order[Math.floor((order.length - 1) / 2)]![1];
}
