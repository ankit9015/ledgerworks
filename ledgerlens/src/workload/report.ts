import { redactLiterals, sanitizeText, untrusted, type Untrusted } from '@ledgerworks/core';
import type { Provenance, StatementBindings, UnverifiableReason } from './bindings.js';
import type { Exclusion, Workload, WorkloadStatement } from './types.js';

export interface ReportedStatement {
  rank: number;
  queryId: string;
  queryHash: string;
  kind: WorkloadStatement['kind'];
  calls: number;
  totalTimeMs: number;
  meanTimeMs: number;
  rows: number;
  /** normalized text with constants replaced by "?", marked as database text */
  text: Untrusted;
  status: 'bound' | 'unverifiable';
  /** provenance of the first binding set, or null when unverifiable */
  provenance: Provenance | null;
  confidence: 'high' | 'medium' | 'low' | null;
  setCount: number;
  validation: { ok: number; rejected: number; skipped: number; notRun: number };
  unverifiable: { reason: UnverifiableReason; detail: Untrusted; params: number[] } | null;
}

export interface ProvenanceCounts {
  statements: number;
  'user-supplied': number;
  'sampled-from-stats': number;
  synthesized: number;
  'not-needed': number;
  unverifiable: number;
}

export interface WorkloadReport {
  version: 1;
  capturedAt: string;
  database: string;
  statsResetAt: string | null;
  serverVersion: string;
  statementsRead: number;
  hiddenText: number;
  excluded: Exclusion[];
  /** statements that stayed in the workload */
  inWorkload: number;
  /** counts for the N statements with the most total time */
  top: { n: number } & ProvenanceCounts;
  all: ProvenanceCounts;
  /** reasons for unverifiable statements, over the whole workload */
  unverifiableByReason: Partial<Record<UnverifiableReason, number>>;
  statements: ReportedStatement[];
}

function counts(list: ReportedStatement[]): ProvenanceCounts {
  const c: ProvenanceCounts = {
    statements: list.length,
    'user-supplied': 0,
    'sampled-from-stats': 0,
    synthesized: 0,
    'not-needed': 0,
    unverifiable: 0,
  };
  for (const s of list)
    if (s.provenance) c[s.provenance]++;
    else c.unverifiable++;
  return c;
}

export function buildWorkloadReport(
  w: Workload,
  bindings: StatementBindings[],
  topN = 20,
): WorkloadReport {
  const byId = new Map(bindings.map((b) => [b.queryId, b]));
  const statements: ReportedStatement[] = w.statements.map((s) => {
    const b = byId.get(s.queryId);
    const first = b?.sets[0];
    const v = { ok: 0, rejected: 0, skipped: 0, notRun: 0 };
    for (const set of b?.sets ?? []) {
      const k = set.validation.status;
      if (k === 'ok') v.ok++;
      else if (k === 'rejected') v.rejected++;
      else if (k === 'skipped') v.skipped++;
      else v.notRun++;
    }
    return {
      rank: s.rank,
      queryId: s.queryId,
      queryHash: s.queryHash,
      kind: s.kind,
      calls: s.calls,
      totalTimeMs: s.totalTimeMs,
      meanTimeMs: s.meanTimeMs,
      rows: s.rows,
      text: untrusted(redactLiterals(s.text), 400),
      status: b && b.status === 'bound' ? 'bound' : 'unverifiable',
      provenance: b?.status === 'bound' && first ? first.provenance : null,
      confidence: b?.status === 'bound' && first ? first.confidence : null,
      setCount: b?.sets.length ?? 0,
      validation: v,
      unverifiable:
        b?.status === 'unverifiable' && b.unverifiable
          ? {
              reason: b.unverifiable.reason,
              detail: untrusted(b.unverifiable.detail, 300),
              params: b.unverifiable.params,
            }
          : b
            ? null
            : {
                reason: 'parse_failed',
                detail: untrusted('no bindings were attempted'),
                params: [],
              },
    };
  });
  const unverifiableByReason: WorkloadReport['unverifiableByReason'] = {};
  for (const s of statements)
    if (s.unverifiable)
      unverifiableByReason[s.unverifiable.reason] =
        (unverifiableByReason[s.unverifiable.reason] ?? 0) + 1;
  const top = statements.slice(0, topN);
  return {
    version: 1,
    capturedAt: w.capturedAt,
    database: w.database,
    statsResetAt: w.statsResetAt,
    serverVersion: w.serverVersion,
    statementsRead: w.statementsRead,
    hiddenText: w.hiddenText,
    excluded: w.excluded,
    inWorkload: statements.length,
    top: { n: top.length, ...counts(top) },
    all: counts(statements),
    unverifiableByReason,
    statements,
  };
}

const ms = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${n.toFixed(1)} ms`);

/** a readable summary: exclusions, counts per provenance, the top N with their provenance, and every unverifiable statement */
export function renderWorkloadReport(r: WorkloadReport): string {
  const o: string[] = [];
  o.push(
    `Workload of database ${sanitizeText(r.database, 60)} (${sanitizeText(r.serverVersion, 60)})`,
  );
  o.push(`captured ${r.capturedAt}; statistics since ${r.statsResetAt ?? 'unknown'}`);
  o.push('');
  o.push(`pg_stat_statements rows read (this database): ${r.statementsRead}`);
  o.push('excluded:');
  for (const e of r.excluded)
    o.push(
      `  ${e.reason.padEnd(22)} ${String(e.count).padStart(4)}  (${ms(e.totalTimeMs)} total time)`,
    );
  if (r.hiddenText) o.push(`  text hidden by privileges: ${r.hiddenText}`);
  o.push(`statements in the workload: ${r.inWorkload}`);
  o.push('');
  const c = (x: ProvenanceCounts): string =>
    `${x.statements} statements: ${x['user-supplied']} user-supplied, ${x['sampled-from-stats']} sampled-from-stats, ${x.synthesized} synthesized, ${x['not-needed']} without parameters, ${x.unverifiable} UNVERIFIABLE`;
  o.push(`top ${r.top.n} by total time: ${c(r.top)}`);
  o.push(`whole workload: ${c(r.all)}`);
  o.push('');
  o.push('rank  hash              kind    calls    total       provenance (conf.)           query');
  for (const s of r.statements.slice(0, r.top.n))
    o.push(
      `${String(s.rank).padStart(4)}  ${s.queryHash}  ${s.kind.padEnd(6)} ${String(s.calls).padStart(7)}  ${ms(s.totalTimeMs).padStart(9)}  ${(s.provenance ? `${s.provenance} (${s.confidence})` : 'UNVERIFIABLE').padEnd(27)}  ${sanitizeText(s.text.$untrusted, 70)}`,
    );
  const bad = r.statements.filter((s) => s.unverifiable);
  o.push('');
  o.push(`unverifiable statements (${bad.length}), none skipped silently:`);
  for (const s of bad)
    o.push(
      `  #${s.rank} ${s.queryHash} ${s.kind}: ${s.unverifiable!.reason}: ${sanitizeText(s.unverifiable!.detail.$untrusted, 160)}`,
    );
  return o.join('\n');
}
