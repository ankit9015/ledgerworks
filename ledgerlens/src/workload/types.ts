import type { ParsedStatement, StatementKind, TableRef } from '../sql/parse.js';

/** Why a statement left the workload. Every exclusion is counted under one of these, never dropped silently. */
export const EXCLUSION_REASONS = [
  'utility_statement', // not SELECT / INSERT / UPDATE / DELETE / MERGE (SET, COPY, CREATE ..., BEGIN, ...)
  'ledgerlens_own_query', // carries the Ledgerlens marker comment
  'monitoring_query', // reads pg_stat_statements itself (also other monitoring tools and the benchmark's own dumps)
  'no_user_tables', // reads only pg_catalog / information_schema, or no table at all (SELECT 1, SELECT now())
  'other_database', // recorded for another database of the same server
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export interface Exclusion {
  reason: ExclusionReason;
  count: number;
  /** total execution time of the excluded statements, ms (so the size of what was left out is visible) */
  totalTimeMs: number;
}

/** One statement of the workload: pg_stat_statements' normalized text with its statistics. */
export interface WorkloadStatement {
  /** pg_stat_statements queryid, as text (it is a signed 64 bit integer) */
  queryId: string;
  /** first 16 hex digits of the SHA-256 of the normalized text: safe to show and to log, unlike the text */
  queryHash: string;
  /** 1 = the most total time */
  rank: number;
  /** the normalized text, `$1, $2` for constants. Database text: untrusted, never put into a prompt unmarked. */
  text: string;
  kind: StatementKind;
  calls: number;
  totalTimeMs: number;
  meanTimeMs: number;
  rows: number;
  sharedBlksHit: number;
  sharedBlksRead: number;
  /** false for statements run inside a function (pg_stat_statements.track = all) */
  topLevel: boolean;
  tables: TableRef[];
  paramCount: number;
  /** null when the text could not be parsed (the statement stays in the workload and becomes unverifiable) */
  parsed: ParsedStatement | null;
  parseError: string | null;
}

export interface Workload {
  version: 1;
  capturedAt: string;
  database: string;
  /** pg_stat_statements_info.stats_reset: the numbers cover the time since then */
  statsResetAt: string | null;
  serverVersion: string;
  /** rows read from pg_stat_statements for this database (before any exclusion) */
  statementsRead: number;
  statements: WorkloadStatement[];
  excluded: Exclusion[];
  /** statements whose text pg_stat_statements hid (a role without pg_read_all_stats sees none of them) */
  hiddenText: number;
}
