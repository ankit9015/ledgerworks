/* eslint-disable @typescript-eslint/no-explicit-any --
   reads the parse tree of PostgreSQL's own parser, like parse.ts */
import { loadModule, parse } from 'libpg-query';

/**
 * What pg_get_indexdef and pg_get_constraintdef say, as structure. The text is read by the real
 * parser (CREATE INDEX ... is a statement; a constraint definition is read as part of ALTER TABLE ... ADD CONSTRAINT).
 */

export interface ParsedIndexColumn {
  /** the column name, or null for an expression */
  name: string | null;
  desc: boolean;
  nullsFirst: boolean | null;
  opclass: string | null;
}

export interface ParsedIndexDef {
  schema: string | null;
  table: string;
  method: string;
  unique: boolean;
  columns: ParsedIndexColumn[];
  include: string[];
  /** the predicate of a partial index as written in the definition (whitespace collapsed), or null */
  predicate: string | null;
}

let loaded: Promise<void> | undefined;
const ready = (): Promise<void> => (loaded ??= loadModule());

const str = (n: any): string | null => (typeof n?.String?.sval === 'string' ? n.String.sval : null);

/** the leftmost `location` found inside a node (where its text starts in the source) */
function minLocation(n: any): number | null {
  let min: number | null = null;
  const walk = (x: any): void => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== 'object') return;
    for (const [k, v] of Object.entries(x)) {
      if (k === 'location' && typeof v === 'number' && v >= 0)
        min = min === null ? v : Math.min(min, v);
      else walk(v);
    }
  };
  walk(n);
  return min;
}

export async function parseIndexDefinition(def: string): Promise<ParsedIndexDef> {
  await ready();
  const tree: any = await parse(def);
  const idx = tree.stmts?.[0]?.stmt?.IndexStmt;
  if (!idx) throw new Error('not a CREATE INDEX statement');
  const columns: ParsedIndexColumn[] = (idx.indexParams ?? []).map((p: any) => {
    const e = p.IndexElem;
    return {
      name: typeof e.name === 'string' ? e.name : null,
      desc: e.ordering === 'SORTBY_DESC',
      nullsFirst:
        e.nulls_ordering === 'SORTBY_NULLS_FIRST'
          ? true
          : e.nulls_ordering === 'SORTBY_NULLS_LAST'
            ? false
            : null,
      opclass:
        (e.opclass ?? [])
          .map((o: any) => str(o))
          .filter(Boolean)
          .pop() ?? null,
    };
  });
  let predicate: string | null = null;
  if (idx.whereClause) {
    const at = minLocation(idx.whereClause);
    if (at !== null) {
      // pg_get_indexdef writes "... WHERE (predicate)": take the text from the first token of the predicate and drop unbalanced closing parentheses
      let tail = def.slice(at).trim();
      let depth = 0;
      for (const ch of tail) depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
      while (depth < 0 && tail.endsWith(')')) {
        tail = tail.slice(0, -1).trimEnd();
        depth++;
      }
      predicate = tail.replace(/\s+/g, ' ');
    }
  }
  return {
    schema: idx.relation?.schemaname ?? null,
    table: idx.relation?.relname,
    method: idx.accessMethod ?? 'btree',
    unique: idx.unique === true,
    columns,
    include: (idx.indexIncludingParams ?? []).map((p: any) => p.IndexElem?.name).filter(Boolean),
    predicate,
  };
}

export interface ParsedForeignKey {
  columns: string[];
  refSchema: string | null;
  refTable: string;
  refColumns: string[];
}

/** `FOREIGN KEY (a, b) REFERENCES public.t(x, y)` as structure; null for any other kind of constraint */
export async function parseForeignKeyDefinition(def: string): Promise<ParsedForeignKey | null> {
  await ready();
  const tree: any = await parse(`ALTER TABLE ll_x ADD CONSTRAINT ll_c ${def}`);
  const cmd = tree.stmts?.[0]?.stmt?.AlterTableStmt?.cmds?.[0]?.AlterTableCmd;
  const c = cmd?.def?.Constraint;
  if (!c || c.contype !== 'CONSTR_FOREIGN') return null;
  return {
    columns: (c.fk_attrs ?? []).map(str).filter(Boolean) as string[],
    refSchema: c.pktable?.schemaname ?? null,
    refTable: c.pktable?.relname,
    refColumns: (c.pk_attrs ?? []).map(str).filter(Boolean) as string[],
  };
}

/** The columns of a partition key as pg_get_partkeydef writes it (`RANGE (occurred_at)`); expressions are left out. */
export async function parsePartitionKey(
  def: string,
): Promise<{ strategy: string; columns: string[]; hasExpression: boolean } | null> {
  await ready();
  let tree: any;
  try {
    tree = await parse(`CREATE TABLE ll_x (a int) PARTITION BY ${def}`);
  } catch {
    return null;
  }
  const spec = tree.stmts?.[0]?.stmt?.CreateStmt?.partspec;
  if (!spec) return null;
  const params: any[] = spec.partParams ?? [];
  const cols = params
    .map((p) => p.PartitionElem?.name)
    .filter((n: unknown): n is string => typeof n === 'string');
  return {
    strategy: String(spec.strategy ?? '')
      .replace('PARTITION_STRATEGY_', '')
      .toLowerCase(),
    columns: cols,
    hasExpression: cols.length !== params.length,
  };
}

/**
 * The kind of each top-level statement in a piece of SQL, as the parser names them
 * (`IndexStmt`, `AlterTableStmt`, `DropStmt`, `VacuumStmt` for ANALYZE, ...). Used to check that
 * generated SQL contains only the statements it is meant to, however its text was assembled.
 */
export async function statementKinds(sql: string): Promise<string[]> {
  await ready();
  const tree: any = await parse(sql);
  return (tree.stmts ?? []).map((s: any) => Object.keys(s.stmt ?? {})[0] ?? 'unknown');
}
