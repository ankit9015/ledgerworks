import { z } from 'zod';
import { sanitizeText, untrusted, type Untrusted } from '@ledgerworks/core';
import type { PlanNode } from './plan.js';

export const FINDING_KINDS = [
  'seq_scan_selective_filter',
  'estimate_mismatch',
  'sort_spills_to_disk',
  'large_sort_index_could_order',
  'nested_loop_many_loops',
  'hash_join_multiple_batches',
  'lossy_bitmap_recheck',
  'join_on_unindexed_foreign_key',
  'no_partition_pruning',
  'stale_statistics',
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export const SEVERITIES = ['info', 'low', 'medium', 'high'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const EVIDENCE_UNITS = [
  'rows',
  'ms',
  'kb',
  'blocks',
  'count',
  'ratio',
  'factor',
  'days',
] as const;
export type EvidenceUnit = (typeof EVIDENCE_UNITS)[number];

/** one measured or estimated number a finding rests on */
export interface EvidenceItem {
  name: string;
  value: number;
  unit: EvidenceUnit;
}
/** at least one item: an empty list does not type-check */
export type Evidence = readonly [EvidenceItem, ...EvidenceItem[]];

/** Names and conditions from the plan: database text, always marked untrusted. */
export interface FindingSubject {
  relation: Untrusted | null;
  index: Untrusted | null;
  /** a condition, a sort key or a hash condition, whichever the finding is about */
  detail: Untrusted | null;
}

declare const made: unique symbol;

/**
 * A finding. It can only be created by `makeFinding`, which requires evidence (the type is a
 * non-empty tuple, and every number is checked to be finite at run time). A finding read back from
 * storage goes through `FindingSchema`, which refuses an empty evidence list the same way.
 */
export interface Finding {
  readonly [made]: true;
  kind: FindingKind;
  severity: Severity;
  /** the node it came from (see plan.ts `PlanNode.path`) */
  nodePath: string;
  nodeType: string;
  /** other nodes involved (the scan under a join, the node an estimate error started in, ...) */
  relatedNodePaths: string[];
  subject: FindingSubject;
  evidence: Evidence;
  /** our own sentence, built from the numbers only; no text from the plan is put into it */
  summary: string;
  /** true when the evidence includes actual rows and timings (EXPLAIN ANALYZE) */
  analyzed: boolean;
}

export interface FindingInput {
  kind: FindingKind;
  severity: Severity;
  node: PlanNode;
  relatedNodePaths?: string[];
  subject?: { relation?: string | null; index?: string | null; detail?: string | null };
  evidence: Evidence;
  summary: string;
  analyzed: boolean;
}

export class FindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FindingError';
  }
}

export function makeFinding(i: FindingInput): Finding {
  if (!Array.isArray(i.evidence) || i.evidence.length === 0)
    throw new FindingError(`finding ${i.kind}: evidence numbers are required`);
  const seen = new Set<string>();
  for (const e of i.evidence) {
    if (typeof e.value !== 'number' || !Number.isFinite(e.value))
      throw new FindingError(`finding ${i.kind}: evidence "${e.name}" is not a finite number`);
    if (!e.name || seen.has(e.name))
      throw new FindingError(`finding ${i.kind}: evidence names must be present and unique`);
    seen.add(e.name);
  }
  return {
    kind: i.kind,
    severity: i.severity,
    nodePath: i.node.path,
    nodeType: sanitizeText(i.node.nodeType, 60),
    relatedNodePaths: i.relatedNodePaths ?? [],
    subject: {
      relation: untrusted(i.subject?.relation ?? null, 120),
      index: untrusted(i.subject?.index ?? null, 120),
      detail: untrusted(i.subject?.detail ?? null, 300),
    },
    evidence: i.evidence,
    summary: i.summary,
    analyzed: i.analyzed,
  } as unknown as Finding;
}

/** the shape of a finding in storage or on the wire (the brand exists only in the type system) */
export const FindingSchema = z.object({
  kind: z.enum(FINDING_KINDS),
  severity: z.enum(SEVERITIES),
  nodePath: z.string().regex(/^\d+(\.\d+)*$/),
  nodeType: z.string(),
  relatedNodePaths: z.array(z.string()),
  subject: z.object({
    relation: z.object({ $untrusted: z.string() }).nullable(),
    index: z.object({ $untrusted: z.string() }).nullable(),
    detail: z.object({ $untrusted: z.string() }).nullable(),
  }),
  evidence: z
    .array(
      z.object({
        name: z.string().min(1),
        value: z.number().finite(),
        unit: z.enum(EVIDENCE_UNITS),
      }),
    )
    .min(1),
  summary: z.string(),
  analyzed: z.boolean(),
});

export const ev = (name: string, value: number, unit: EvidenceUnit): EvidenceItem => ({
  name,
  value,
  unit,
});

export const fmt = (n: number): string =>
  Math.abs(n) >= 100 ? Math.round(n).toLocaleString('en-US') : String(Math.round(n * 100) / 100);
