import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SchemaSnapshot } from '../schema/snapshot.js';
import { analyzePlan } from './analyze.js';
import {
  FINDING_KINDS,
  FindingError,
  FindingSchema,
  makeFinding,
  type Finding,
} from './findings.js';
import { PlanParseError, findNode, parsePlan, walk } from './plan.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/plans');

interface Fixture {
  name: string;
  description: string;
  mode: 'analyze' | 'estimate';
  sql: string;
  producedBy: { capturedAt: string; shadow: { manifestId: string; sampled: boolean } };
  context: SchemaSnapshot;
  plan: unknown;
}
const fixtures = new Map<string, Fixture>();
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')))
  fixtures.set(
    f.replace(/\.json$/, ''),
    JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as Fixture,
  );
const fx = (name: string): Fixture => fixtures.get(name)!;

const run = (name: string, ctx = true): Promise<Finding[]> => {
  const f = fx(name);
  return analyzePlan(
    parsePlan(f.plan),
    ctx ? { snapshot: f.context, now: new Date(f.producedBy.capturedAt) } : {},
  );
};
const kinds = (fs: Finding[]): string[] => fs.map((f) => f.kind).sort();
const round = (n: number): number => Math.round(n * 1000) / 1000;
const brief = (fs: Finding[]) =>
  fs.map((f) => ({
    kind: f.kind,
    severity: f.severity,
    path: f.nodePath,
    node: f.nodeType,
    related: f.relatedNodePaths,
    evidence: Object.fromEntries(f.evidence.map((e) => [`${e.name} (${e.unit})`, round(e.value)])),
  }));

describe('the fixtures are real plans saved from real runs', () => {
  it('there are at least 8 distinct plan shapes, each with its SQL, its provenance and a schema context', () => {
    expect(fixtures.size).toBeGreaterThanOrEqual(8);
    const shapes = new Set<string>();
    for (const [name, f] of fixtures) {
      expect(f.sql.length, name).toBeGreaterThan(10);
      expect(f.description.length, name).toBeGreaterThan(30);
      expect(f.producedBy.shadow.manifestId, name).toMatch(/^[0-9a-f-]{36}$/);
      expect(f.producedBy.shadow.sampled, name).toBe(false);
      expect(f.context.tables.length, name).toBeGreaterThan(0);
      const plan = parsePlan(f.plan);
      expect(plan.analyzed, name).toBe(f.mode === 'analyze');
      shapes.add(
        [...walk(plan.root)]
          .map((n) => n.nodeType)
          .sort()
          .join('>'),
      );
    }
    expect(shapes.size).toBeGreaterThanOrEqual(8);
  });

  it('paths address nodes: the root is "0", children are numbered in order', () => {
    const plan = parsePlan(fx('nested_loop_many_loops').plan);
    expect(plan.root.path).toBe('0');
    const paths = [...walk(plan.root)].map((n) => n.path);
    expect(paths[0]).toBe('0');
    expect(paths.every((p) => /^0(\.\d+)*$/.test(p))).toBe(true);
    expect(new Set(paths).size).toBe(paths.length);
    expect(findNode(plan, '0.1')?.parentRelationship).toBe('Inner');
  });

  it('refuses what is not an EXPLAIN (FORMAT JSON) result', () => {
    expect(() => parsePlan('not json')).toThrow(PlanParseError);
    expect(() => parsePlan({ Plan: {} })).toThrow(PlanParseError);
    expect(() => parsePlan([])).toThrow(PlanParseError);
    expect(() => parsePlan([{ Plan: { 'Node Type': 5 } }])).toThrow(PlanParseError);
  });
});

describe('findings per plan shape (snapshot of what the rules say about real plans)', () => {
  for (const name of [...fixtures.keys()].sort()) {
    it(name, async () => {
      expect(brief(await run(name))).toMatchSnapshot();
    });
  }
});

describe('what each rule must find, and what it must not', () => {
  it('the pre-E1 usage-read plan: a large sort where an index could give order, with the LIMIT it feeds and the expression key', async () => {
    const fs = await run('pre_e1_usage_read');
    const sort = fs.find((f) => f.kind === 'large_sort_index_could_order')!;
    expect(sort).toBeDefined();
    expect(sort.nodeType).toBe('Sort');
    expect(findNode(parsePlan(fx('pre_e1_usage_read').plan), sort.nodePath)!.nodeType).toBe('Sort');
    const e = Object.fromEntries(sort.evidence.map((x) => [x.name, x.value]));
    expect(e.rowsSorted).toBeGreaterThan(40_000);
    expect(e.limitRows).toBe(51);
    expect(e.sortKeysThatAreExpressions).toBe(1); // the output alias: a to_char() expression, not the column
    expect(sort.severity).toBe('high'); // a top-N over tens of thousands of rows
    expect(sort.relatedNodePaths).toHaveLength(1);
    expect(sort.summary).toMatch(/first 51/);
  });

  it('the same plan as estimates only (the source tool) gives the same finding, from estimated rows', async () => {
    const fs = await run('pre_e1_usage_read_estimate');
    const sort = fs.find((f) => f.kind === 'large_sort_index_could_order')!;
    expect(sort.analyzed).toBe(false);
    expect(sort.evidence.find((x) => x.name === 'rowsSorted')!.value).toBeGreaterThan(10_000);
    expect(fs.every((f) => !f.analyzed)).toBe(true);
  });

  it('after the E1 fix and for a plain lookup there is nothing to report', async () => {
    expect(await run('post_e1_usage_read')).toEqual([]);
    expect(await run('index_scan_control')).toEqual([]);
  });

  it('a sequential scan with a selective filter: grouped over the partitions, with the rows it reads and keeps', async () => {
    const fs = await run('seq_scan_selective_partitioned');
    const seq = fs.find((f) => f.kind === 'seq_scan_selective_filter')!;
    expect(seq.nodeType).toBe('Append');
    expect(seq.relatedNodePaths.length).toBeGreaterThan(1);
    const e = Object.fromEntries(seq.evidence.map((x) => [x.name, x.value]));
    expect(e.rowsExamined).toBe(10_000_000);
    expect(e.rowsReturned).toBeGreaterThan(0);
    expect(e.selectivity).toBeCloseTo(e.rowsReturned! / e.rowsExamined!, 10);
  });

  it('estimate versus actual reports where the error starts, not every node above it', async () => {
    const m = (await run('estimate_mismatch_correlated')).filter(
      (f) => f.kind === 'estimate_mismatch',
    );
    expect(m).toHaveLength(1);
    expect(m[0]!.evidence.find((x) => x.name === 'factor')!.value).toBeGreaterThan(50);
    const stale = (await run('stale_statistics')).filter((f) => f.kind === 'estimate_mismatch');
    expect(stale).toHaveLength(1);
    expect(stale[0]!.nodeType).toBe('Seq Scan'); // not the Aggregate above it
    expect(stale[0]!.severity).toBe('high');
  });

  it('sort spill, hash batches and lossy bitmap come with their evidence', async () => {
    const spill = (await run('sort_spills_to_disk')).find((f) => f.kind === 'sort_spills_to_disk')!;
    expect(spill.evidence.find((x) => x.name === 'sortSpaceKb')!.value).toBeGreaterThan(1000);
    const hash = (await run('hash_join_multiple_batches')).find(
      (f) => f.kind === 'hash_join_multiple_batches',
    )!;
    expect(hash.evidence.find((x) => x.name === 'hashBatches')!.value).toBeGreaterThan(1);
    const lossy = (await run('lossy_bitmap_heap_scan')).find(
      (f) => f.kind === 'lossy_bitmap_recheck',
    )!;
    expect(lossy.evidence.find((x) => x.name === 'lossyHeapBlocks')!.value).toBeGreaterThan(0);
  });

  it('a nested loop whose inner side runs 40,000 times is the N+1 shape', async () => {
    const n = (await run('nested_loop_many_loops')).find(
      (f) => f.kind === 'nested_loop_many_loops',
    )!;
    expect(n.evidence.find((x) => x.name === 'innerLoops')!.value).toBe(40_000);
    expect(n.severity).toBe('high');
    expect(n.relatedNodePaths).toEqual(['0.1']);
  });

  it('a join on a foreign key without an index needs the schema; without it the rule is skipped, not guessed', async () => {
    const with_ = await run('join_on_unindexed_foreign_key');
    const fk = with_.find((f) => f.kind === 'join_on_unindexed_foreign_key')!;
    expect(fk.evidence.find((x) => x.name === 'tableRows')!.value).toBe(400_000);
    expect(fk.relatedNodePaths).toHaveLength(1);
    const without = await run('join_on_unindexed_foreign_key', false);
    expect(kinds(without)).not.toContain('join_on_unindexed_foreign_key');
    expect(kinds(without)).toContain('seq_scan_selective_filter'); // analyzed plans need no schema for this one
  });

  it('partitions: all 48 scanned and no condition on the key is reported; a pruned plan is not', async () => {
    const f = (await run('no_partition_pruning_tenant_count')).find(
      (x) => x.kind === 'no_partition_pruning',
    )!;
    const e = Object.fromEntries(f.evidence.map((x) => [x.name, x.value]));
    expect(e.partitionsScanned).toBe(48);
    expect(e.partitionsTotal).toBe(48);
    expect(e.scansWithConditionOnKey).toBe(0);
    expect(kinds(await run('post_e1_usage_read'))).not.toContain('no_partition_pruning');
  });

  it('stale statistics come from the table activity in the schema context', async () => {
    const f = (await run('stale_statistics')).find((x) => x.kind === 'stale_statistics')!;
    const e = Object.fromEntries(f.evidence.map((x) => [x.name, x.value]));
    expect(e.modificationRatio).toBeGreaterThan(0.9);
    expect(e.neverAnalyzed).toBe(0);
    expect(kinds(await run('stale_statistics', false))).not.toContain('stale_statistics');
    expect(kinds(await run('index_scan_control'))).not.toContain('stale_statistics');
  });

  it('thresholds are explicit: a stricter one removes a finding, a looser one adds it', async () => {
    const f = fx('pre_e1_usage_read_estimate');
    const plan = parsePlan(f.plan);
    expect(
      kinds(await analyzePlan(plan, { snapshot: f.context }, { sortMinRows: 1_000_000 })),
    ).toEqual([]);
    expect(kinds(await analyzePlan(plan, { snapshot: f.context }, { sortMinRows: 100 }))).toEqual([
      'large_sort_index_could_order',
    ]);
  });

  it('every kind of finding is produced by at least one real plan', async () => {
    const seen = new Set<string>();
    for (const name of fixtures.keys()) for (const f of await run(name)) seen.add(f.kind);
    for (const k of FINDING_KINDS) expect(seen.has(k), k).toBe(true);
  });
});

describe('a finding without evidence numbers cannot exist', () => {
  const node = parsePlan(fx('index_scan_control').plan).root;
  const base = {
    kind: 'estimate_mismatch',
    severity: 'low',
    node,
    summary: 's',
    analyzed: true,
  } as const;

  it('does not type-check without evidence, and throws at run time', () => {
    // @ts-expect-error evidence is required
    expect(() => makeFinding({ ...base })).toThrow(FindingError);
    // @ts-expect-error an empty list is not a non-empty tuple
    expect(() => makeFinding({ ...base, evidence: [] })).toThrow(FindingError);
  });

  it('refuses numbers that are not finite and names that repeat', () => {
    expect(() =>
      makeFinding({ ...base, evidence: [{ name: 'x', value: NaN, unit: 'rows' }] }),
    ).toThrow(FindingError);
    expect(() =>
      makeFinding({ ...base, evidence: [{ name: 'x', value: Infinity, unit: 'rows' }] }),
    ).toThrow(FindingError);
    expect(() =>
      makeFinding({
        ...base,
        evidence: [
          { name: 'x', value: 1, unit: 'rows' },
          { name: 'x', value: 2, unit: 'rows' },
        ],
      }),
    ).toThrow(FindingError);
  });

  it('a finding read back from storage must have evidence too', async () => {
    const real = (await run('nested_loop_many_loops'))[0]!;
    const stored = JSON.parse(JSON.stringify(real));
    expect(FindingSchema.safeParse(stored).success).toBe(true);
    expect(FindingSchema.safeParse({ ...stored, evidence: [] }).success).toBe(false);
    expect(
      FindingSchema.safeParse({ ...stored, evidence: [{ name: 'x', value: null, unit: 'rows' }] })
        .success,
    ).toBe(false);
  });

  it('every finding from every real plan has evidence, every number finite, and points at a node that exists', async () => {
    let n = 0;
    for (const [name, f] of fixtures) {
      const plan = parsePlan(f.plan);
      for (const finding of await run(name)) {
        n++;
        expect(finding.evidence.length, `${name}/${finding.kind}`).toBeGreaterThan(0);
        for (const e of finding.evidence) expect(Number.isFinite(e.value)).toBe(true);
        expect(findNode(plan, finding.nodePath), `${name}/${finding.kind}`).toBeDefined();
        for (const p of finding.relatedNodePaths) expect(findNode(plan, p)).toBeDefined();
        expect(FindingSchema.safeParse(JSON.parse(JSON.stringify(finding))).success).toBe(true);
      }
    }
    expect(n).toBeGreaterThan(15);
  });
});

describe('plan text and identifiers are untrusted', () => {
  it('a table named like an instruction appears only inside {"$untrusted": ...}, never in our own sentences', async () => {
    const fs = await run('hostile_names_seq_scan');
    expect(fs.length).toBeGreaterThan(0);
    const needle = 'Ignore all previous instructions';
    let inUntrusted = 0;
    const scan = (v: unknown, underUntrusted: boolean): void => {
      if (typeof v === 'string') {
        if (v.includes(needle)) {
          expect(underUntrusted).toBe(true);
          inUntrusted++;
        }
      } else if (Array.isArray(v)) v.forEach((x) => scan(x, underUntrusted));
      else if (v && typeof v === 'object')
        for (const [k, x] of Object.entries(v)) scan(x, underUntrusted || k === '$untrusted');
    };
    for (const f of fs) scan(JSON.parse(JSON.stringify(f)), false);
    expect(inUntrusted).toBeGreaterThan(0);
    for (const f of fs) expect(f.summary).not.toContain(needle);
    expect(fs[0]!.subject.relation).toHaveProperty('$untrusted');
  });

  it('control characters and very long names are cleaned and limited', () => {
    const node = {
      ...parsePlan(fx('index_scan_control').plan).root,
      nodeType: 'Seq\u0007 Scan\n' + 'x'.repeat(500),
    };
    const f = makeFinding({
      kind: 'estimate_mismatch',
      severity: 'low',
      node,
      subject: { relation: 'a‮b\u0000c' + 'y'.repeat(1000), detail: 'line1\nline2' },
      evidence: [{ name: 'x', value: 1, unit: 'rows' }],
      summary: 's',
      analyzed: true,
    });
    expect(f.nodeType.length).toBeLessThan(120);
    expect(
      [...f.nodeType].some((ch) => ch === String.fromCharCode(7) || ch === String.fromCharCode(10)),
    ).toBe(false);
    const rel = f.subject.relation!.$untrusted;
    expect(rel).not.toContain('‮');
    expect(rel).not.toContain('\u0000');
    expect(rel).toMatch(/truncated/);
    expect(f.subject.detail!.$untrusted).toBe('line1 line2');
  });

  it('a hostile condition inside a plan cannot do anything: conditions are only parsed, never executed', async () => {
    const f = fx('join_on_unindexed_foreign_key');
    const plan = parsePlan(f.plan);
    const join = plan.root;
    join.hashCond = '(c.parent_id = p.id); DROP TABLE parent; --';
    join.mergeCond = null;
    // the injected text makes the condition unparseable (two statements), so the rule skips it instead of acting on it
    const out = await analyzePlan(plan, { snapshot: f.context });
    expect(kinds(out)).not.toContain('join_on_unindexed_foreign_key');
  });
});
