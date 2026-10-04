import type { Untrusted } from '@ledgerworks/core';
import type { FindingKind } from '../analyzer/findings.js';

export const CANDIDATE_KINDS = [
  'create_index',
  'drop_redundant_index',
  'analyze_or_stats_target',
  'rewrite_suggestion',
] as const;
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];

export interface IndexKeyColumn {
  name: string;
  desc: boolean;
}

/** what a create_index candidate builds (the SQL is generated from this, never the other way round) */
export interface IndexSpec {
  schema: string;
  table: string;
  indexName: string;
  method: 'btree';
  key: IndexKeyColumn[];
  include: string[];
  /** a partial index: the column and the constant of `column = constant` (the constant is quoted by quoteLiteral) */
  partial: { column: string; value: string } | null;
  /** the table is partitioned: built with ON ONLY, one CONCURRENTLY index per partition, then ATTACH */
  partitions: string[] | null;
}

export interface TriggerRef {
  /** the plan finding that led here, when there was one */
  findingKind: FindingKind | null;
  nodePath: string | null;
  queryHash: string;
}

interface CandidateBase {
  /** deterministic: a hash of the kind, the table and the SQL */
  id: string;
  kind: CandidateKind;
  table: { schema: string; name: string };
  /** our own sentence: no name from the database is put into it (names are in `subjects`, marked untrusted) */
  rationale: string;
  subjects: Untrusted[];
  /** the statements (by hash) this candidate is meant to help */
  targetedStatements: string[];
  riskNotes: string[];
  triggeredBy: TriggerRef[];
  /** another candidate this one is a variant of (a covering or partial version of a plain index) */
  variantOf: string | null;
}

/** a candidate that changes the schema: it always has up and down SQL */
export interface SqlCandidate extends CandidateBase {
  kind: 'create_index' | 'drop_redundant_index' | 'analyze_or_stats_target';
  upSql: string;
  downSql: string;
  /** the statements of upSql / downSql one by one (the migration runs them in this order) */
  upStatements: string[];
  downStatements: string[];
  /** CREATE/DROP INDEX CONCURRENTLY cannot run inside a transaction block */
  noTransaction: boolean;
  /** set for create_index */
  index: IndexSpec | null;
}

/** advice text only: no SQL, so nothing to verify until a rewrite SQL is supplied (L3.7) */
export interface AdviceCandidate extends CandidateBase {
  kind: 'rewrite_suggestion';
  upSql: null;
  downSql: null;
  advice: RewriteAdvice;
}

export type RewriteAdvice =
  | 'qualify_order_by_alias' // ORDER BY names an output alias that hides the column
  | 'function_on_column' // a function around an indexed column in a predicate
  | 'offset_pagination'; // large OFFSET

export type Candidate = SqlCandidate | AdviceCandidate;

export const SKIP_REASONS = [
  'tiny_table',
  'covered_by_existing_index',
  'no_indexable_predicate',
  'table_not_found',
  'ambiguous_table',
  'column_not_found',
  'not_a_plain_table',
  'identifier_not_representable',
  'partition_list_incomplete',
  'partial_needs_other_columns',
  'partial_needs_statistics',
  'unique_or_primary_index',
  'partitioned_table_not_supported',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** Something the rules looked at and did not turn into a candidate. Always listed, never dropped silently. */
export interface SkippedCandidate {
  reason: SkipReason;
  /** the table or index concerned (database text) */
  subject: Untrusted;
  /** our sentence */
  detail: string;
  targetedStatements: string[];
}

export interface GenerateOptions {
  /** tables smaller than this get no index candidate (estimated rows). Default 10,000. */
  minTableRows: number;
  /** most key columns in a generated index. Default 4. */
  maxKeyColumns: number;
  /** most INCLUDE columns in a covering variant. Default 3. */
  maxIncludeColumns: number;
  /** a partial index is proposed when the constant matches at most this share of the rows. Default 0.1. */
  partialMaxFrequency: number;
  /** also propose covering (INCLUDE) and partial variants. Default true. */
  variants: boolean;
}

export const DEFAULT_GENERATE_OPTIONS: GenerateOptions = {
  minTableRows: 10_000,
  maxKeyColumns: 4,
  maxIncludeColumns: 3,
  partialMaxFrequency: 0.1,
  variants: true,
};
