import type { Catalog, CatalogRelation } from './source.js';
import type { SamplingRule, TableManifest } from './manifest.js';
import { qi, qtable } from './sql.js';

export type Selection = TableManifest['selection'];

export interface LogicalTable {
  oid: number;
  schema: string;
  name: string;
  key: string; // schema.name
}

export interface TablePlan {
  table: LogicalTable;
  selection: Selection;
  /** SQL boolean expression over alias "t" (the table being copied); null = copy every row */
  predicate: string | null;
}

export const DEFAULT_RULE: Pick<SamplingRule, 'seed' | 'uncovered' | 'isolated' | 'fullTables'> = {
  seed: 1,
  uncovered: 'referenced',
  isolated: 'full',
  fullTables: [],
};

export function fullRule(
  rule: Partial<SamplingRule> & Pick<SamplingRule, 'rootTable' | 'ratio'>,
): SamplingRule {
  return { ...DEFAULT_RULE, ...rule };
}

/** Deterministic selection of a key: the same key and seed always give the same answer. */
export function hashSelect(keyExpr: string, rule: Pick<SamplingRule, 'seed' | 'ratio'>): string {
  const threshold = Math.round(rule.ratio * 1_000_000);
  return `((hashtextextended((${keyExpr})::text, ${Math.trunc(rule.seed)}) & 9223372036854775807) % 1000000) < ${threshold}`;
}

function keyExpression(alias: string, cols: string[]): string {
  const refs = cols.map((c) => `${alias}.${qi(c)}`);
  return refs.length === 1 ? refs[0]! : `ROW(${refs.join(', ')})`;
}

/** The top-level logical table of a relation (a partition maps to its partitioned ancestor). */
function topLevel(rel: CatalogRelation, byOid: Map<number, CatalogRelation>): CatalogRelation {
  let cur = rel;
  while (cur.parentOid !== null) {
    const p = byOid.get(cur.parentOid);
    if (!p) break;
    cur = p;
  }
  return cur;
}

export function logicalTables(catalog: Catalog): LogicalTable[] {
  const byOid = new Map(catalog.relations.map((r) => [r.oid, r]));
  const seen = new Map<number, LogicalTable>();
  for (const r of catalog.relations) {
    const top = topLevel(r, byOid);
    if (!seen.has(top.oid)) {
      seen.set(top.oid, {
        oid: top.oid,
        schema: top.schema,
        name: top.name,
        key: `${top.schema}.${top.name}`,
      });
    }
  }
  return [...seen.values()];
}

/**
 * Plans which rows of each table are copied, so that every foreign key between copied tables is
 * satisfied. The graph rules:
 *  - the root table is sampled by a deterministic hash of its primary key;
 *  - a table with a foreign key to a sampled table keeps exactly the rows whose referenced row is
 *    kept (whole parent rows with all their children), for every such foreign key;
 *  - a table not reached that way, but referenced by kept rows, keeps the rows that are referenced
 *    (rule.uncovered = 'referenced'), or everything / nothing;
 *  - a table with no foreign-key link to the sampled graph follows rule.isolated;
 *  - rule.fullTables are always copied completely.
 * Self-references are not followed; the foreign keys are validated when the constraints are
 * created on the shadow, so a rule that cannot keep integrity fails loudly instead of silently.
 */
export function planSampling(catalog: Catalog, rule: SamplingRule): TablePlan[] {
  const tables = logicalTables(catalog);
  const byKey = new Map(tables.map((t) => [t.key, t]));
  const byOid = new Map(tables.map((t) => [t.oid, t]));
  const root = byKey.get(rule.rootTable);
  if (!root) throw new Error(`Sampling root table "${rule.rootTable}" not found in the source`);
  const full = new Set(rule.fullTables);
  for (const f of full)
    if (!byKey.has(f)) throw new Error(`fullTables entry "${f}" not found in the source`);
  const relByOid = new Map(catalog.relations.map((r) => [r.oid, r]));
  const topOid = (oid: number): number => topLevel(relByOid.get(oid)!, relByOid).oid;
  const pkOf = (t: LogicalTable): string[] => {
    const pk = catalog.primaryKeys.get(t.oid);
    if (!pk || pk.length === 0)
      throw new Error(`Table ${t.key} has no primary key (needed as a sampling key)`);
    return pk;
  };

  // Foreign keys between logical tables, self-references dropped.
  const fks = catalog.fks
    .map((f) => ({ ...f, childOid: topOid(f.childOid), parentOid: topOid(f.parentOid) }))
    .filter((f) => f.childOid !== f.parentOid);

  // 1. Covered tables: root plus everything with a foreign key into the covered set, to a fixpoint.
  const covered = new Set<number>([root.oid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const t of tables) {
      if (covered.has(t.oid) || full.has(t.key)) continue;
      if (fks.some((f) => f.childOid === t.oid && covered.has(f.parentOid))) {
        covered.add(t.oid);
        changed = true;
      }
    }
  }
  // 2. Referenced tables: not covered, but referenced by a covered or referenced table.
  const referenced = new Set<number>();
  if (rule.uncovered === 'referenced') {
    for (let changed = true; changed;) {
      changed = false;
      for (const t of tables) {
        if (covered.has(t.oid) || referenced.has(t.oid) || full.has(t.key)) continue;
        if (
          fks.some(
            (f) => f.parentOid === t.oid && (covered.has(f.childOid) || referenced.has(f.childOid)),
          )
        ) {
          referenced.add(t.oid);
          changed = true;
        }
      }
    }
  }

  let aliasCounter = 0;
  const nextAlias = (): string => `s${++aliasCounter}`;

  // Predicate for table `t` over alias `a`. `stack` prevents cycles in the 'referenced' direction.
  const predicateFor = (t: LogicalTable, a: string, stack: Set<number>): string => {
    if (t.oid === root.oid) return hashSelect(keyExpression(a, pkOf(t)), rule);
    if (covered.has(t.oid)) {
      const parts: string[] = [];
      for (const f of fks.filter((x) => x.childOid === t.oid && covered.has(x.parentOid))) {
        const parent = byOid.get(f.parentOid)!;
        const childCols = f.childCols.map((c) => `${a}.${qi(c)}`);
        const nullGuard = childCols.map((c) => `${c} IS NULL`).join(' OR ');
        let inner: string;
        if (parent.oid === root.oid && sameCols(f.parentCols, pkOf(root))) {
          inner = hashSelect(keyExpression(a, f.childCols), rule);
        } else {
          const pa = nextAlias();
          const join = f.parentCols
            .map((pc, i) => `${pa}.${qi(pc)} = ${childCols[i]}`)
            .join(' AND ');
          inner = `EXISTS (SELECT 1 FROM ${qtable(parent.schema, parent.name)} ${pa} WHERE ${join} AND ${predicateFor(parent, pa, stack)})`;
        }
        parts.push(`(${nullGuard} OR ${inner})`);
      }
      return parts.join(' AND ');
    }
    // referenced: rows pointed at by kept rows of a covered or referenced child
    const nextStack = new Set(stack).add(t.oid);
    const alternatives: string[] = [];
    for (const f of fks.filter((x) => x.parentOid === t.oid)) {
      if (!(covered.has(f.childOid) || referenced.has(f.childOid)) || nextStack.has(f.childOid))
        continue;
      const child = byOid.get(f.childOid)!;
      const ca = nextAlias();
      const join = f.childCols
        .map((cc, i) => `${ca}.${qi(cc)} = ${a}.${qi(f.parentCols[i]!)}`)
        .join(' AND ');
      alternatives.push(
        `EXISTS (SELECT 1 FROM ${qtable(child.schema, child.name)} ${ca} WHERE ${join} AND ${predicateFor(child, ca, nextStack)})`,
      );
    }
    return alternatives.length ? `(${alternatives.join(' OR ')})` : 'false';
  };

  return tables.map((t): TablePlan => {
    if (full.has(t.key)) return { table: t, selection: 'full-override', predicate: null };
    if (t.oid === root.oid)
      return { table: t, selection: 'root', predicate: predicateFor(t, 't', new Set()) };
    if (covered.has(t.oid))
      return { table: t, selection: 'child', predicate: predicateFor(t, 't', new Set()) };
    if (referenced.has(t.oid))
      return { table: t, selection: 'referenced', predicate: predicateFor(t, 't', new Set()) };
    if (rule.uncovered === 'full') return { table: t, selection: 'full-override', predicate: null };
    if (rule.uncovered === 'empty') return { table: t, selection: 'empty', predicate: 'false' };
    // not reachable at all
    return rule.isolated === 'full'
      ? { table: t, selection: 'isolated-full', predicate: null }
      : { table: t, selection: 'empty', predicate: 'false' };
  });
}

function sameCols(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

/** Plan for a full copy: every table, no filter. */
export function planFull(catalog: Catalog): TablePlan[] {
  return logicalTables(catalog).map((table) => ({
    table,
    selection: 'all' as const,
    predicate: null,
  }));
}
