import { z } from 'zod';

/**
 * The report of the HypoPG pre-screen (L3.4).
 *
 * Two different kinds of number are kept apart on purpose:
 *  - `estimatedCostRatio`: the planner's estimated cost WITH a hypothetical index divided by its
 *    estimated cost WITHOUT it, for the statements the candidate targets. Planner cost units, an
 *    estimate that can be wrong in either direction. Below 1 means "the planner expects less work".
 *  - `measuredSpeedup`: a measured ratio of times. Only the verifier (L3.5) can fill it. Here it is
 *    the literal `null`: the schema refuses anything else, so nothing in the pre-screen can put a
 *    number there, and no sentence of the report may call an estimate a speedup.
 */

export const PRESCREEN_REASONS = [
  'index_not_used', // the planner does not use the hypothetical index for any targeted statement
  'cost_reduction_below_threshold', // used, but the estimated cost falls by less than the threshold
  'not_an_index_candidate', // HypoPG only screens new indexes
  'no_verifiable_statement', // the candidate targets no statement that has bindings the server accepts
  'hypopg_unavailable', // the extension is not installed on this shadow
  'hypothetical_index_refused', // HypoPG could not create the index (a type or an expression it does not support)
  'explain_failed', // every EXPLAIN of the targeted statements failed
] as const;
export type PrescreenReason = (typeof PRESCREEN_REASONS)[number];

export const StatementScreenSchema = z
  .object({
    queryHash: z.string(),
    bindingSetId: z.string(),
    /** a plan node uses the hypothetical index */
    plannerUsesIndex: z.boolean(),
    /** estimated total cost of the plan without / with the hypothetical index (planner cost units) */
    costWithout: z.number().nullable(),
    costWith: z.number().nullable(),
    /** costWith / costWithout; null when either is unknown */
    estimatedCostRatio: z.number().nullable(),
    /** always null here: only the verifier measures */
    measuredSpeedup: z.null(),
    /** how many plan nodes use the hypothetical index */
    nodesUsingIndex: z.number().int().nonnegative(),
    /** a typed error class when this EXPLAIN failed (SQLSTATE), else null */
    error: z.string().nullable(),
  })
  .strict();
export type StatementScreen = z.infer<typeof StatementScreenSchema>;

export const PrescreenReportSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('hypopg-prescreen'),
    candidateId: z.string(),
    shadow: z.object({ manifestId: z.string(), sampled: z.boolean() }),
    decision: z.enum(['pass', 'reject', 'cannot_screen']),
    reason: z.enum(PRESCREEN_REASONS).nullable(),
    /** our sentence; it speaks of estimated planner cost and never of speed */
    summary: z.string(),
    screens: z.array(StatementScreenSchema),
    /** the lowest estimatedCostRatio over the screens where the index was used, or null */
    estimatedCostRatio: z.number().nullable(),
    /** always null here (see above) */
    measuredSpeedup: z.null(),
    thresholds: z.object({ maxCostRatioToPass: z.number() }),
    /** for the reader: what these numbers are */
    note: z.string(),
  })
  .strict();
export type PrescreenReport = z.infer<typeof PrescreenReportSchema>;

export const PRESCREEN_NOTE =
  "estimatedCostRatio is the planner's ESTIMATED cost with the hypothetical index over its estimated cost without it (planner cost units, from plain EXPLAIN; nothing was executed or timed). It can be wrong either way. Only the verifier measures.";

/** words that would turn an estimate into a claim about time: none may appear in any text of a report */
export const FORBIDDEN_WORDS =
  /speed\s*-?up|faster|quicker|x\s+faster|times\s+as\s+fast|seconds? saved|milliseconds? saved/i;

const num = (n: number): string => (n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3));

/** a readable summary of a report: estimates are called estimates, nothing is called a speedup */
export function renderPrescreenReport(r: PrescreenReport): string {
  const o: string[] = [];
  o.push(
    `candidate ${r.candidateId}: ${r.decision.toUpperCase()}${r.reason ? ` (${r.reason})` : ''}   shadow ${r.shadow.manifestId.slice(0, 8)}${r.shadow.sampled ? ' (sampled)' : ''}`,
  );
  o.push(r.summary);
  for (const s of r.screens)
    o.push(
      `  statement ${s.queryHash.slice(0, 8)} / ${s.bindingSetId}: ${s.error ? `EXPLAIN failed (${s.error})` : `planner ${s.plannerUsesIndex ? `uses the hypothetical index in ${s.nodesUsingIndex} node(s); estimated cost ${s.costWith !== null ? num(s.costWith) : '?'} vs ${s.costWithout !== null ? num(s.costWithout) : '?'} without (estimatedCostRatio ${s.estimatedCostRatio !== null ? num(s.estimatedCostRatio) : '?'})` : `does not use it; estimated cost ${s.costWithout !== null ? num(s.costWithout) : '?'}`}`}`,
    );
  o.push('  measured timings: none (only the verifier measures)');
  o.push(`  ${r.note}`);
  return o.join('\n');
}
