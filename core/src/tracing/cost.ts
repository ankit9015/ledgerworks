import type { RunTrace } from '../agent/types.js';

/**
 * Prices per million tokens, by model name. EMPTY by default: no dollar cost is computed unless
 * someone configures real prices (this repository ships none; prices change and differ by provider).
 */
export type PriceTable = Record<string, { inputPerMTok: number; outputPerMTok: number }>;
export const DEFAULT_PRICES: PriceTable = {};

export interface CostReport {
  /** null when no price is configured for every model that was used */
  usd: number | null;
  /** models that were used and have no entry in the table */
  unpriced: string[];
  /** true when any token number behind the cost is our estimate, not the provider's */
  tokensEstimated: boolean;
  note: string;
}

export function computeCost(trace: RunTrace, prices: PriceTable = DEFAULT_PRICES): CostReport {
  const unpriced = new Set<string>();
  let usd = 0;
  let estimated = false;
  for (const s of trace.steps) {
    const u = s.model.usage;
    if (!u) continue;
    if (u.source === 'estimated') estimated = true;
    const p = prices[s.model.model];
    if (!p) unpriced.add(s.model.model);
    else
      usd += (u.promptTokens / 1e6) * p.inputPerMTok + (u.completionTokens / 1e6) * p.outputPerMTok;
  }
  if (Object.keys(prices).length === 0) {
    return {
      usd: null,
      unpriced: [...unpriced],
      tokensEstimated: estimated,
      note: 'not computed: no price table is configured',
    };
  }
  return {
    usd: unpriced.size ? null : usd,
    unpriced: [...unpriced],
    tokensEstimated: estimated,
    note: unpriced.size
      ? 'not computed: some models have no price in the table'
      : estimated
        ? 'computed from the configured prices; some token counts are estimates'
        : 'computed from the configured prices and provider-reported tokens',
  };
}
