import { describe, expect, it } from 'vitest';
import {
  EVENT_NAMES,
  EventPrivacyError,
  EventSchemas,
  assertNoQueryText,
  parseEvent,
} from './events.js';
import { verdictLabel } from '../verdict/vocabulary.js';

const base = { investigationId: 'inv_1', at: '2026-10-05T10:00:00.000Z' };
const valid: Record<string, Record<string, unknown>> = {
  investigation_started: { event: 'investigation_started', statementCount: 12, mode: 'full' },
  slow_query_opened: { event: 'slow_query_opened', queryHash: 'a1b2c3d4e5f60718', rank: 1 },
  candidate_viewed: {
    event: 'candidate_viewed',
    candidateId: 'cand_1',
    candidateKind: 'create_index',
    verdictClass: null,
  },
  fix_accepted: {
    event: 'fix_accepted',
    candidateId: 'cand_1',
    verdictClass: 'verified_improvement',
  },
  fix_rejected: { event: 'fix_rejected', candidateId: 'cand_1', reasonClass: 'too_risky' },
  fix_reverted: { event: 'fix_reverted', candidateId: 'cand_1', reasonClass: 'did_not_help' },
  thumbs: { event: 'thumbs', target: 'verdict', targetId: 'v_1', value: 'down' },
  state_shown: { event: 'state_shown', state: 'rate_limited' },
};

describe('event taxonomy', () => {
  it('has exactly the events of the plan, and a valid example of each parses', () => {
    expect([...EVENT_NAMES].sort()).toEqual(
      [
        'candidate_viewed',
        'fix_accepted',
        'fix_rejected',
        'fix_reverted',
        'investigation_started',
        'slow_query_opened',
        'state_shown',
        'thumbs',
      ].sort(),
    );
    for (const name of EVENT_NAMES) {
      expect(parseEvent({ ...base, ...valid[name] }).event).toBe(name);
    }
  });

  it('every event schema is strict: an unknown field is rejected', () => {
    for (const name of EVENT_NAMES)
      expect(EventSchemas[name].safeParse({ ...base, ...valid[name], extra: 1 }).success).toBe(
        false,
      );
  });

  it('rejects an event that contains a field named like query text, at any depth', () => {
    for (const field of [
      'query',
      'queryText',
      'sql',
      'statement',
      'normalized_query',
      'text',
      'literals',
      'params',
      'planText',
      'tableName',
      'columnName',
      'comment',
      'message',
      'prompt',
    ]) {
      const e = { ...base, ...valid.slow_query_opened, [field]: 'x' };
      expect(() => parseEvent(e), field).toThrow(EventPrivacyError);
      expect(() => assertNoQueryText({ nested: { deeper: [{ [field]: 1 }] } }), field).toThrow(
        EventPrivacyError,
      );
    }
  });

  it('rejects a value that looks like SQL even in an allowed field', () => {
    const sql = [
      'SELECT id FROM users WHERE email = $1',
      'CREATE INDEX CONCURRENTLY ON t (a)',
      'x; DROP TABLE users',
      'DELETE FROM t',
      'UPDATE t SET a = 1',
    ];
    for (const s of sql) {
      expect(() => parseEvent({ ...base, ...valid.fix_accepted, candidateId: s })).toThrow();
      expect(() => assertNoQueryText({ candidateId: s })).toThrow(EventPrivacyError);
    }
  });

  it('ids must be short tokens and reasons must be classes, not free text', () => {
    expect(() =>
      parseEvent({ ...base, ...valid.fix_rejected, reasonClass: 'it was slow on my laptop' }),
    ).toThrow();
    expect(() =>
      parseEvent({ ...base, ...valid.fix_accepted, candidateId: 'has spaces and text' }),
    ).toThrow();
    expect(() =>
      parseEvent({ ...base, ...valid.slow_query_opened, queryHash: 'SELECT' }),
    ).toThrow();
  });
});

describe('verdict vocabulary', () => {
  it('a sampled improvement is never called verified', () => {
    expect(verdictLabel('verified_improvement', 'verified')).toBe('verified improvement');
    const sampled = verdictLabel('verified_improvement', 'indicative');
    expect(sampled).toMatch(/indicative/);
    expect(sampled).not.toMatch(/^verified/);
    expect(verdictLabel('no_effect', 'indicative')).toMatch(/sample/);
  });
});
