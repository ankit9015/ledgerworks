import { z } from 'zod';

/**
 * The typed events of Ledgerlens (L3.0). Nothing is sent from here; sinks come with L3.11.
 *
 * Privacy rule: an event carries ids, hashes and classes only. Never query text, literals,
 * identifiers, plan text or free-form user text. Two guards, both tested:
 *  1. every event schema is strict (an unknown field is rejected);
 *  2. `assertNoQueryText` scans the whole event and refuses any field NAMED like query text, and any
 *     string that looks like SQL, so a mistake in a future schema cannot slip through.
 */

const Id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_.:-]+$/, 'ids are short tokens, not text');
/** a hash of the normalized query text (hex), never the text */
const Hash = z.string().regex(/^[0-9a-f]{8,64}$/);

const base = { investigationId: Id, at: z.iso.datetime() };

export const VerdictClassSchema = z.enum([
  'verified_improvement',
  'inconclusive',
  'no_effect',
  'harmful',
  'unverifiable',
]);
export const CandidateKindSchema = z.enum([
  'create_index',
  'drop_redundant_index',
  'analyze_or_stats_target',
  'rewrite_suggestion',
]);
/** why a user rejected or reverted a fix: a class, not text */
export const ReasonClassSchema = z.enum([
  'not_needed',
  'too_risky',
  'did_not_help',
  'wrong_fix',
  'too_expensive',
  'other',
]);

export const EventSchemas = {
  investigation_started: z
    .object({
      ...base,
      event: z.literal('investigation_started'),
      statementCount: z.number().int().min(0),
      mode: z.enum(['full', 'sampled']),
    })
    .strict(),
  slow_query_opened: z
    .object({
      ...base,
      event: z.literal('slow_query_opened'),
      queryHash: Hash,
      rank: z.number().int().min(1),
    })
    .strict(),
  candidate_viewed: z
    .object({
      ...base,
      event: z.literal('candidate_viewed'),
      candidateId: Id,
      candidateKind: CandidateKindSchema,
      verdictClass: VerdictClassSchema.nullable(),
    })
    .strict(),
  fix_accepted: z
    .object({
      ...base,
      event: z.literal('fix_accepted'),
      candidateId: Id,
      verdictClass: VerdictClassSchema,
    })
    .strict(),
  fix_rejected: z
    .object({
      ...base,
      event: z.literal('fix_rejected'),
      candidateId: Id,
      reasonClass: ReasonClassSchema,
    })
    .strict(),
  fix_reverted: z
    .object({
      ...base,
      event: z.literal('fix_reverted'),
      candidateId: Id,
      reasonClass: ReasonClassSchema,
    })
    .strict(),
  thumbs: z
    .object({
      ...base,
      event: z.literal('thumbs'),
      target: z.enum(['diagnosis', 'candidate', 'verdict']),
      targetId: Id,
      value: z.enum(['up', 'down']),
    })
    .strict(),
  state_shown: z
    .object({
      ...base,
      event: z.literal('state_shown'),
      state: z.enum(['rate_limited', 'quota_exhausted', 'no_problems', 'fix_did_not_help']),
    })
    .strict(),
} as const;

export const LedgerlensEventSchema = z.discriminatedUnion('event', [
  EventSchemas.investigation_started,
  EventSchemas.slow_query_opened,
  EventSchemas.candidate_viewed,
  EventSchemas.fix_accepted,
  EventSchemas.fix_rejected,
  EventSchemas.fix_reverted,
  EventSchemas.thumbs,
  EventSchemas.state_shown,
]);
export type LedgerlensEvent = z.infer<typeof LedgerlensEventSchema>;
export const EVENT_NAMES = Object.keys(EventSchemas) as LedgerlensEvent['event'][];

/** field names that mean "text of a query, a value, or a name from the database" */
const FORBIDDEN_FIELD =
  /(query|sql|statement|stmt|text|literal|param|binding|value|plan|ddl|identifier|table|column|comment|message|note|body|content|prompt)/i;
/** field names that contain one of those words are refused, except these (ids, hashes and counts) */
const ALLOWED_FIELDS = new Set(['value', 'queryHash', 'statementCount']);
/** strings that look like SQL: a keyword followed by something, or a statement separator */
const LOOKS_LIKE_SQL =
  /\b(select\s.+\sfrom|insert\s+into|update\s+\S+\s+set|delete\s+from|create\s+(unique\s+)?index|drop\s+(index|table)|alter\s+table|where\s+\S+\s*(=|<|>|in\b))|;\s*\S/i;

export class EventPrivacyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventPrivacyError';
  }
}

/** Throws when an event (any depth) has a field named like query text, or a value that looks like SQL. */
export function assertNoQueryText(event: unknown, path = 'event'): void {
  if (typeof event === 'string') {
    if (LOOKS_LIKE_SQL.test(event)) throw new EventPrivacyError(`${path} looks like SQL text`);
    return;
  }
  if (Array.isArray(event)) {
    event.forEach((v, i) => assertNoQueryText(v, `${path}[${i}]`));
    return;
  }
  if (event && typeof event === 'object') {
    for (const [k, v] of Object.entries(event)) {
      if (!ALLOWED_FIELDS.has(k) && FORBIDDEN_FIELD.test(k))
        throw new EventPrivacyError(`${path}.${k}: a field named like query text is not allowed`);
      assertNoQueryText(v, `${path}.${k}`);
    }
  }
}

/** The only way to build an event: the privacy scan, then the schema. Throws on either failure. */
export function parseEvent(input: unknown): LedgerlensEvent {
  assertNoQueryText(input);
  return LedgerlensEventSchema.parse(input);
}
