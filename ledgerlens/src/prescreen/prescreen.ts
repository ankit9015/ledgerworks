import pg from 'pg';
import { assertShadow, settleShadow, type ShadowManifest } from '@ledgerworks/core';
import { parsePlan, walk } from '../analyzer/plan.js';
import { buildHypotheticalIndexSql } from '../candidates/sqlgen.js';
import type { SqlCandidate } from '../candidates/types.js';
import { toQueryConfig, type StatementBindings } from '../workload/bindings.js';
import type { WorkloadStatement } from '../workload/types.js';
import {
  PRESCREEN_NOTE,
  PrescreenReportSchema,
  type PrescreenReason,
  type PrescreenReport,
  type StatementScreen,
} from './report.js';

/** where HypoPG lives on a shadow (the shadow runner installs extensions in their own schema) */
const EXT = 'ledgerworks_ext';

export interface PrescreenTarget {
  connectionString(): string;
  manifest?: ShadowManifest;
}

export interface PrescreenInput {
  candidate: SqlCandidate;
  /** the statements the candidate targets, with the binding sets to plan them with */
  statements: { statement: WorkloadStatement; bindings: StatementBindings }[];
}

export interface PrescreenOptions {
  /** binding sets planned per statement (default 3) */
  maxSetsPerStatement?: number;
  /**
   * The estimated cost with the index must be at most this share of the cost without it for the
   * candidate to pass (default 0.8: at least 20% less estimated work). A convention of this tool,
   * not a measured truth.
   */
  maxCostRatioToPass?: number;
  /** settle the shadow first: 'if_needed' (default) does it unless the manifest says it was settled, 'never' trusts the caller */
  settle?: 'if_needed' | 'always' | 'never';
}

const isIndexCandidate = (c: SqlCandidate): boolean =>
  c.kind === 'create_index' && c.index !== null;

/**
 * Plans the statements a candidate targets with and without a HYPOTHETICAL index (HypoPG) on a
 * shadow, with plain EXPLAIN (nothing is executed), and reports whether the planner would use the
 * index and how its estimated cost changes. Hypothetical indexes live in the session that created
 * them: one connection is opened for the whole call, every hypothetical index is dropped and the
 * connection is closed before it returns.
 *
 * Refuses (throws NotShadowError) on a database that is not a shadow, before sending anything else.
 */
export async function prescreenCandidates(
  target: PrescreenTarget,
  inputs: PrescreenInput[],
  o: PrescreenOptions = {},
): Promise<PrescreenReport[]> {
  const maxSets = o.maxSetsPerStatement ?? 3;
  const maxRatio = o.maxCostRatioToPass ?? 0.8;
  const settleMode = o.settle ?? 'if_needed';
  // the marker is checked first, on its own connection, before anything else is sent
  const probe = new pg.Client({
    connectionString: target.connectionString(),
    application_name: 'ledgerlens-prescreen',
  });
  probe.on('error', () => undefined);
  await probe.connect();
  let manifest: ShadowManifest;
  try {
    manifest = (await assertShadow(probe)).manifest;
  } finally {
    await probe.end().catch(() => undefined);
  }
  // settle before any plan is inspected, as the shadow runner does by default
  const alreadySettled = target.manifest?.settle?.performed === true;
  if (settleMode === 'always' || (settleMode === 'if_needed' && !alreadySettled))
    await settleShadow(target);
  const sess = await openSession(target);
  try {
    const reports: PrescreenReport[] = [];
    const hypopg = await sess.query<{ extversion: string }>(
      "SELECT extversion FROM pg_extension WHERE extname = 'hypopg'",
    );
    for (const input of inputs) {
      reports.push(
        await screenOne(sess, input, {
          manifestId: manifest.id,
          sampled: manifest.scaling.sampled,
          hypopg: hypopg.rows.length > 0,
          maxSets,
          maxRatio,
        }),
      );
    }
    return reports;
  } finally {
    await sess.query(`SELECT ${EXT}.hypopg_reset()`).catch(() => undefined);
    await sess.end().catch(() => undefined);
  }
}

async function openSession(target: PrescreenTarget): Promise<pg.Client> {
  const s = new pg.Client({
    connectionString: target.connectionString(),
    application_name: 'ledgerlens-prescreen-session',
    // a stuck plan must not hold the shadow
    options: '-c statement_timeout=120000',
  });
  s.on('error', () => undefined);
  await s.connect();
  await assertShadow(s); // every connection that sends a statement is checked, not only the first
  return s;
}

interface Ctx {
  manifestId: string;
  sampled: boolean;
  hypopg: boolean;
  maxSets: number;
  maxRatio: number;
}

const report = (
  c: SqlCandidate,
  ctx: Ctx,
  decision: PrescreenReport['decision'],
  reason: PrescreenReason | null,
  summary: string,
  screens: StatementScreen[],
  maxRatio: number,
): PrescreenReport => {
  const used = screens.filter((s) => s.plannerUsesIndex && s.estimatedCostRatio !== null);
  return PrescreenReportSchema.parse({
    version: 1,
    kind: 'hypopg-prescreen',
    candidateId: c.id,
    shadow: { manifestId: ctx.manifestId, sampled: ctx.sampled },
    decision,
    reason,
    summary,
    screens,
    estimatedCostRatio: used.length ? Math.min(...used.map((s) => s.estimatedCostRatio!)) : null,
    measuredSpeedup: null,
    thresholds: { maxCostRatioToPass: maxRatio },
    note: PRESCREEN_NOTE,
  });
};

async function screenOne(
  sess: pg.Client,
  input: PrescreenInput,
  ctx: Ctx,
): Promise<PrescreenReport> {
  const cand = input.candidate;
  const out = (
    d: PrescreenReport['decision'],
    r: PrescreenReason | null,
    text: string,
    screens: StatementScreen[] = [],
  ) => report(cand, ctx, d, r, text, screens, ctx.maxRatio);
  if (!isIndexCandidate(cand))
    return out(
      'cannot_screen',
      'not_an_index_candidate',
      'HypoPG can only screen a new index; this candidate is not one.',
    );
  if (!ctx.hypopg)
    return out(
      'cannot_screen',
      'hypopg_unavailable',
      'The HypoPG extension is not installed on this shadow.',
    );
  const usable = input.statements
    .map((s) => ({
      ...s,
      sets: s.bindings.sets.filter((x) => x.validation.status !== 'rejected').slice(0, ctx.maxSets),
    }))
    .filter(
      (s) => s.bindings.status === 'bound' && s.sets.length > 0 && s.statement.parsed?.single,
    );
  if (usable.length === 0)
    return out(
      'cannot_screen',
      'no_verifiable_statement',
      'None of the statements this candidate targets has bindings to plan it with, so it cannot be screened (it is not passed or rejected on a guess).',
    );

  const sql = await buildHypotheticalIndexSql(cand.index!);
  await sess.query(`SELECT ${EXT}.hypopg_reset()`);
  const screens: StatementScreen[] = [];

  // 1. the plans WITHOUT the hypothetical index (same session, same statistics)
  const without = new Map<string, number | null>();
  for (const s of usable)
    for (const set of s.sets)
      without.set(
        `${s.statement.queryHash}|${set.id}`,
        (await explain(sess, s.statement, set)).cost,
      );

  // 2. create the hypothetical index
  let hypoNames: Set<string>;
  try {
    await sess.query(`SELECT * FROM ${EXT}.hypopg_create_index($1)`, [sql]);
    const listed = await sess.query<{ index_name: string }>(
      `SELECT index_name FROM ${EXT}.hypopg_list_indexes`,
    );
    hypoNames = new Set(listed.rows.map((r) => r.index_name));
    if (hypoNames.size === 0) throw new Error('no hypothetical index was created');
  } catch (e) {
    await sess.query(`SELECT ${EXT}.hypopg_reset()`).catch(() => undefined);
    return out(
      'cannot_screen',
      'hypothetical_index_refused',
      `HypoPG could not create the index (${(e as { code?: string }).code ?? 'error'}).`,
    );
  }

  // 3. the plans WITH it
  for (const s of usable) {
    for (const set of s.sets) {
      const w = await explain(sess, s.statement, set);
      const before = without.get(`${s.statement.queryHash}|${set.id}`) ?? null;
      const nodes = w.plan
        ? [...walk(w.plan.root)].filter((n) => n.indexName !== null && hypoNames.has(n.indexName))
            .length
        : 0;
      const ratio = before !== null && w.cost !== null && before > 0 ? w.cost / before : null;
      screens.push({
        queryHash: s.statement.queryHash,
        bindingSetId: set.id,
        plannerUsesIndex: nodes > 0,
        costWithout: before,
        costWith: w.cost,
        estimatedCostRatio: ratio,
        measuredSpeedup: null,
        nodesUsingIndex: nodes,
        error: w.error,
      });
    }
  }
  await sess.query(`SELECT ${EXT}.hypopg_reset()`);

  if (screens.every((s) => s.error !== null))
    return out(
      'cannot_screen',
      'explain_failed',
      'Every EXPLAIN of the targeted statements failed.',
      screens,
    );
  const used = screens.filter((s) => s.plannerUsesIndex);
  if (used.length === 0)
    return out(
      'reject',
      'index_not_used',
      `The planner does not use the hypothetical index for any of the ${screens.length} plans tried (${usable.length} statement(s)): rejected early.`,
      screens,
    );
  const best = Math.min(...used.map((s) => s.estimatedCostRatio ?? Infinity));
  if (!(best <= ctx.maxRatio))
    return out(
      'reject',
      'cost_reduction_below_threshold',
      `The planner uses the hypothetical index, but its estimated cost is at best ${best.toFixed(2)} of the cost without it, above the ${ctx.maxRatio} needed to pass: rejected early.`,
      screens,
    );
  return out(
    'pass',
    null,
    `The planner uses the hypothetical index in ${used.length} of ${screens.length} plans tried; its estimated cost is at best ${best.toFixed(3)} of the estimated cost without it. This is an estimate of planner work, to be confirmed by measurement.`,
    screens,
  );
}

/** plain EXPLAIN (never ANALYZE) of a statement with a binding set, in a read-only transaction */
async function explain(
  sess: pg.Client,
  stmt: WorkloadStatement,
  set: Parameters<typeof toQueryConfig>[1],
): Promise<{
  cost: number | null;
  plan: ReturnType<typeof parsePlan> | null;
  error: string | null;
}> {
  const q = toQueryConfig(stmt.text, set);
  try {
    await sess.query('BEGIN READ ONLY');
    const r = await sess.query<{ 'QUERY PLAN': unknown }>({
      text: `EXPLAIN (FORMAT JSON) ${q.text}`,
      values: q.values,
    });
    const plan = parsePlan(r.rows[0]!['QUERY PLAN']);
    return { cost: plan.root.totalCost, plan, error: null };
  } catch (e) {
    return { cost: null, plan: null, error: (e as { code?: string }).code ?? 'error' };
  } finally {
    await sess.query('ROLLBACK').catch(() => undefined);
  }
}
