/* eslint-disable @typescript-eslint/no-explicit-any --
   The parser returns PostgreSQL's own parse tree as plain JSON. This file is the only reader of
   that tree; everything it returns is typed. */
import { loadModule, parse } from 'libpg-query';

/**
 * Reads SQL with PostgreSQL's own grammar (libpg-query: the real parser, compiled to WebAssembly,
 * PostgreSQL 16 grammar). Used to find which column each `$n` parameter is compared with.
 * No regular expression looks at SQL text in this file or anywhere that needs the structure of a query.
 */

export interface TableRef {
  schema: string | null;
  name: string;
  alias: string | null;
}

export type ParamRole =
  | 'equality'
  | 'range_lower' // col > $1, col >= $1
  | 'range_upper' // col < $1, col <= $1
  | 'between_lower'
  | 'between_upper'
  | 'in_list'
  | 'any_array' // col = ANY($1)
  | 'like'
  | 'inequality' // col <> $1
  | 'limit'
  | 'offset'
  | 'insert_value'
  | 'update_set'
  | 'other'; // a parameter used some other way (function argument, expression, ...)

export interface ColumnReference {
  /** the table alias or name written before the column, or null */
  qualifier: string | null;
  name: string;
  /** set when the column is wrapped in a function, e.g. lower(email): an index on the bare column would not help */
  viaFunction: string | null;
}

export interface ParamUsage {
  /** 1-based, as in $1 */
  param: number;
  role: ParamRole;
  operator: string | null;
  column: ColumnReference | null;
  /** INSERT without a column list: the position in the VALUES row (0-based) */
  insertPosition: number | null;
  /** the table an INSERT / UPDATE writes to, for insert_value and update_set */
  targetTable: TableRef | null;
  /** tables visible where the parameter appears, innermost first */
  scope: TableRef[];
  /** explicit cast on the parameter, e.g. $1::uuid -> "uuid" (as written, lower-case) */
  castType: string | null;
  /** the parameter is a direct argument of a function call: the function (lower-case, schema-qualified when written so) and the argument position */
  functionArg: { name: string; index: number } | null;
}

export interface SortItem {
  /** a plain column, or null when the key is an expression, an ordinal, or an output alias */
  column: ColumnReference | null;
  desc: boolean;
  nullsFirst: boolean | null;
  /** ORDER BY names an output alias that is NOT the same bare column (the Ledgerline E1 problem): the sort is on an expression */
  viaAlias: boolean;
}

export interface ColumnUse {
  ref: ColumnReference;
  /** tables visible where it appears, innermost first */
  scope: TableRef[];
}

export type StatementKind = 'select' | 'insert' | 'update' | 'delete' | 'merge' | 'utility';

export interface ParsedStatement {
  kind: StatementKind;
  /** the parse tree contained exactly one statement */
  single: boolean;
  /** the highest $n used (0 when none) */
  paramCount: number;
  /** every real table the statement reads or writes (CTE names excluded), in order of appearance, without duplicates */
  tables: TableRef[];
  usages: ParamUsage[];
  /** every function called, as written (lower-case), without duplicates: lets the caller tell a statement that calls user functions from one that touches nothing */
  functions: { schema: string | null; name: string }[];
  /** true when the statement has a part this reader does not understand (a derived table, a CTE, MERGE, ...) */
  hasDerivedRelations: boolean;
  /** the top-level SELECT only (empty for other statements and for UNION / VALUES): */
  orderBy: SortItem[];
  hasLimit: boolean;
  selectsStar: boolean;
  /** every column the top-level SELECT mentions anywhere */
  columns: ColumnUse[];
  /** column = column comparisons (join conditions and WHERE) */
  joinEqualities: { left: ColumnReference; right: ColumnReference; scope: TableRef[] }[];
  hasSubqueries: boolean;
}

let loaded: Promise<void> | undefined;
async function ensureLoaded(): Promise<void> {
  loaded ??= loadModule();
  await loaded;
}

export class SqlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlParseError';
  }
}

const KIND: Record<string, StatementKind> = {
  SelectStmt: 'select',
  InsertStmt: 'insert',
  UpdateStmt: 'update',
  DeleteStmt: 'delete',
  MergeStmt: 'merge',
};

const str = (n: any): string | null =>
  n && typeof n.String?.sval === 'string' ? n.String.sval : null;
const nodeName = (n: any): string | null =>
  n && typeof n === 'object' ? (Object.keys(n)[0] ?? null) : null;
const sameTable = (a: TableRef, b: TableRef): boolean =>
  a.schema === b.schema && a.name === b.name && a.alias === b.alias;

function rangeVar(rv: any): TableRef {
  return {
    schema: rv.schemaname ?? null,
    name: rv.relname,
    alias: rv.alias?.aliasname ?? null,
  };
}

function typeNameOf(tn: any): string | null {
  const parts = (tn?.names ?? []).map(str).filter((s: string | null): s is string => s !== null);
  const name = parts.filter((p: string) => p !== 'pg_catalog').join('.');
  return name ? name.toLowerCase() + (tn.arrayBounds ? '[]' : '') : null;
}

/** Parses SQL into the facts the workload model needs. Throws SqlParseError for text that is not valid PostgreSQL SQL. */
export async function parseStatement(sql: string): Promise<ParsedStatement> {
  await ensureLoaded();
  let tree: any;
  try {
    tree = await parse(sql);
  } catch (e) {
    throw new SqlParseError(e instanceof Error ? e.message : String(e));
  }
  const stmts: any[] = tree.stmts ?? [];
  const first = stmts[0]?.stmt;
  const key = nodeName(first);
  const out: ParsedStatement = {
    kind: key && KIND[key] ? KIND[key]! : 'utility',
    single: stmts.length === 1,
    paramCount: 0,
    tables: [],
    usages: [],
    hasDerivedRelations: false,
    functions: [],
    orderBy: [],
    hasLimit: false,
    selectsStar: false,
    columns: [],
    joinEqualities: [],
    hasSubqueries: false,
  };
  if (!first || !key || !KIND[key]) return out;
  const w = new Walker(out);
  w.prepare(first);
  w.statement(first[key], key, []);
  w.finish(first);
  return out;
}

class Walker {
  private cteNames = new Set<string>();
  private claimed = new Set<any>(); // ParamRef nodes already explained by a usage

  constructor(private out: ParsedStatement) {}

  /** CTE names must be known before any table is classified (withClause comes after fromClause in the tree) */
  prepare(root: any): void {
    const visit = (n: any): void => {
      if (Array.isArray(n)) return n.forEach(visit);
      if (!n || typeof n !== 'object') return;
      if (n.CommonTableExpr?.ctename) this.cteNames.add(n.CommonTableExpr.ctename);
      Object.values(n).forEach(visit);
    };
    visit(root);
  }

  /** every ParamRef not explained by a usage becomes a role "other" usage; also counts tables and the parameter count */
  finish(root: any): void {
    this.collectAll(root, null);
  }

  private collectAll(n: any, scope: TableRef[] | null): void {
    if (Array.isArray(n)) return n.forEach((x) => this.collectAll(x, scope));
    if (!n || typeof n !== 'object') return;
    for (const [k, v] of Object.entries(n)) {
      if (k === 'ParamRef') {
        const num = (v as any).number as number;
        this.out.paramCount = Math.max(this.out.paramCount, num);
        if (!this.claimed.has(v))
          this.out.usages.push(this.usage(num, 'other', null, null, scope ?? []));
      } else if (k === 'FuncCall') {
        const parts = ((v as any).funcname ?? [])
          .map(str)
          .filter((x: string | null): x is string => x !== null);
        const name = (parts.pop() ?? '').toLowerCase();
        const schema = parts.length ? parts.join('.').toLowerCase() : null;
        if (name && !this.out.functions.some((f) => f.name === name && f.schema === schema))
          this.out.functions.push({ schema, name });
        this.collectAll(v, scope);
      } else if (k === 'RangeVar') {
        const t = rangeVar(v);
        const isCte = !t.schema && this.cteNames.has(t.name);
        if (!isCte && !this.out.tables.some((x) => sameTable(x, t))) this.out.tables.push(t);
      } else this.collectAll(v, scope);
    }
  }

  private addTable(t: TableRef): void {
    if (!this.out.tables.some((x) => sameTable(x, t))) this.out.tables.push(t);
  }

  private usage(
    param: number,
    role: ParamRole,
    operator: string | null,
    column: ColumnReference | null,
    scope: TableRef[],
    extra: Partial<ParamUsage> = {},
  ): ParamUsage {
    return {
      param,
      role,
      operator,
      column,
      insertPosition: null,
      targetTable: null,
      scope,
      castType: null,
      functionArg: null,
      ...extra,
    };
  }

  /** peels TypeCast / RelabelType off an expression; returns the inner node and the outermost cast type */
  private peel(e: any): { node: any; cast: string | null } {
    let cast: string | null = null;
    let cur = e;
    while (cur?.TypeCast) {
      cast ??= typeNameOf(cur.TypeCast.typeName);
      cur = cur.TypeCast.arg;
    }
    return { node: cur, cast };
  }

  private columnOf(e: any): ColumnReference | null {
    const { node } = this.peel(e);
    if (node?.ColumnRef) {
      const names = (node.ColumnRef.fields ?? []).map(str);
      if (names.some((s: string | null) => s === null)) return null; // A_Star
      const name = names[names.length - 1] as string;
      const qualifier = names.length >= 2 ? (names[names.length - 2] as string) : null;
      return { qualifier, name, viaFunction: null };
    }
    if (node?.FuncCall) {
      const args: any[] = node.FuncCall.args ?? [];
      const cols = args
        .map((a) => this.columnOf(a))
        .filter((c): c is ColumnReference => c !== null);
      const fname = (node.FuncCall.funcname ?? []).map(str).filter(Boolean).join('.');
      if (cols.length === 1 && !cols[0]!.viaFunction) return { ...cols[0]!, viaFunction: fname };
    }
    return null;
  }

  /** the only parameter inside an expression that reads no column (COALESCE($1::timestamptz, now()), $1 + 1, ...), with the cast written on it */
  private soleParam(e: any): { ref: any; cast: string | null; wrapped: boolean } | null {
    const found: { ref: any; cast: string | null }[] = [];
    let columns = 0;
    const walk = (n: any, cast: string | null): void => {
      if (Array.isArray(n)) return n.forEach((x) => walk(x, null));
      if (!n || typeof n !== 'object') return;
      if (n.ColumnRef) columns++;
      if (n.ParamRef) found.push({ ref: n.ParamRef, cast });
      for (const [k, v] of Object.entries(n)) {
        if (k === 'TypeCast') {
          const t = typeNameOf((v as any).typeName);
          const arg = (v as any).arg;
          if (arg?.ParamRef) found.push({ ref: arg.ParamRef, cast: t });
          else walk(arg, null);
        } else if (k !== 'ParamRef') walk(v, null);
      }
    };
    walk(e, null);
    const refs = new Set(found.map((f) => f.ref));
    if (refs.size !== 1 || columns > 0) return null;
    const first = found.find((f) => f.cast !== null) ?? found[0]!;
    return { ref: first.ref, cast: first.cast, wrapped: false };
  }

  /** the parameter an expression is, when it is exactly a parameter (maybe cast, or wrapped in a one-argument function) */
  private paramOf(e: any): { ref: any; cast: string | null; wrapped: boolean } | null {
    const { node, cast } = this.peel(e);
    if (node?.ParamRef) return { ref: node.ParamRef, cast, wrapped: false };
    if (node?.FuncCall) {
      const args: any[] = node.FuncCall.args ?? [];
      if (args.length === 1) {
        const inner = this.paramOf(args[0]);
        if (inner) return { ...inner, wrapped: true };
      }
    }
    return null;
  }

  private claim(
    p: { ref: any; cast: string | null },
    role: ParamRole,
    op: string | null,
    col: ColumnReference | null,
    scope: TableRef[],
    extra: Partial<ParamUsage> = {},
  ): void {
    this.claimed.add(p.ref);
    this.out.paramCount = Math.max(this.out.paramCount, p.ref.number);
    this.out.usages.push(
      this.usage(p.ref.number, role, op, col, scope, { castType: p.cast, ...extra }),
    );
  }

  /** the tables a FROM clause brings into scope; derived tables and CTEs make the statement "derived" */
  private fromScope(from: any[] | undefined): TableRef[] {
    const scope: TableRef[] = [];
    const visit = (n: any): void => {
      if (n?.RangeVar) {
        if (!n.RangeVar.schemaname && this.cteNames.has(n.RangeVar.relname)) {
          this.out.hasDerivedRelations = true;
          return;
        }
        scope.push(rangeVar(n.RangeVar));
      } else if (n?.JoinExpr) {
        visit(n.JoinExpr.larg);
        visit(n.JoinExpr.rarg);
      } else if (n?.RangeSubselect || n?.RangeFunction || n?.RangeTableFunc) {
        this.out.hasDerivedRelations = true;
      }
    };
    (from ?? []).forEach(visit);
    return scope;
  }

  private joinQuals(from: any[] | undefined, scope: TableRef[], outer: TableRef[]): void {
    const visit = (n: any): void => {
      if (n?.JoinExpr) {
        visit(n.JoinExpr.larg);
        visit(n.JoinExpr.rarg);
        if (n.JoinExpr.quals) this.expr(n.JoinExpr.quals, [...scope, ...outer]);
      } else if (n?.RangeSubselect?.subquery?.SelectStmt) {
        this.statement(n.RangeSubselect.subquery.SelectStmt, 'SelectStmt', scope.concat(outer));
      }
    };
    (from ?? []).forEach(visit);
  }

  private depth = 0;

  statement(s: any, key: string, outer: TableRef[]): void {
    const top = this.depth++ === 0;
    try {
      this.statementInner(s, key, outer, top);
    } finally {
      this.depth--;
    }
  }

  /** column references anywhere inside a node */
  private columnsIn(n: any, scope: TableRef[], into: ColumnUse[]): void {
    if (Array.isArray(n)) return n.forEach((x) => this.columnsIn(x, scope, into));
    if (!n || typeof n !== 'object') return;
    if (n.ColumnRef) {
      const names = (n.ColumnRef.fields ?? []).map(str);
      if (names.some((x: string | null) => x === null)) return;
      into.push({
        ref: {
          name: names[names.length - 1] as string,
          qualifier: names.length >= 2 ? (names[names.length - 2] as string) : null,
          viaFunction: null,
        },
        scope,
      });
      return;
    }
    for (const v of Object.values(n)) this.columnsIn(v, scope, into);
  }

  private topLevelFacts(s: any, scope: TableRef[]): void {
    const out = this.out;
    const aliases = new Map<string, any>();
    for (const t of s.targetList ?? []) {
      const r = t.ResTarget;
      if (r?.name) aliases.set(r.name, r.val);
      if (r?.val?.ColumnRef?.fields?.some((f: any) => f.A_Star)) out.selectsStar = true;
    }
    for (const item of s.sortClause ?? []) {
      const sb = item.SortBy;
      const node = sb?.node;
      const desc = sb?.sortby_dir === 'SORTBY_DESC';
      const nullsFirst =
        sb?.sortby_nulls === 'SORTBY_NULLS_FIRST'
          ? true
          : sb?.sortby_nulls === 'SORTBY_NULLS_LAST'
            ? false
            : null;
      const names = node?.ColumnRef ? (node.ColumnRef.fields ?? []).map(str) : null;
      if (!names || names.some((x: string | null) => x === null)) {
        out.orderBy.push({ column: null, desc, nullsFirst, viaAlias: false });
        continue;
      }
      const name = names[names.length - 1] as string;
      if (names.length === 1 && aliases.has(name)) {
        // an unqualified name that is also an output column name refers to the OUTPUT column
        const val = aliases.get(name);
        const bare = val?.ColumnRef ? (val.ColumnRef.fields ?? []).map(str) : null;
        const same =
          bare && bare[bare.length - 1] === name && bare.every((x: string | null) => x !== null);
        if (!same) {
          out.orderBy.push({ column: null, desc, nullsFirst, viaAlias: true });
          continue;
        }
      }
      out.orderBy.push({
        column: {
          name,
          qualifier: names.length >= 2 ? (names[names.length - 2] as string) : null,
          viaFunction: null,
        },
        desc,
        nullsFirst,
        viaAlias: false,
      });
    }
    out.hasLimit = s.limitCount !== undefined && s.limitCount !== null;
    for (const part of [
      s.targetList,
      s.whereClause,
      s.sortClause,
      s.groupClause,
      s.havingClause,
      s.fromClause,
    ])
      this.columnsIn(part, scope, out.columns);
    // column = column
    const visit = (n: any): void => {
      if (Array.isArray(n)) return n.forEach(visit);
      if (!n || typeof n !== 'object') return;
      if (n.SubLink || n.RangeSubselect) out.hasSubqueries = true;
      const a = n.A_Expr;
      if (a?.kind === 'AEXPR_OP' && (a.name ?? []).map(str).pop() === '=') {
        const l: ColumnUse[] = [];
        const r: ColumnUse[] = [];
        const peel = (e: any): any => (e?.TypeCast ? peel(e.TypeCast.arg) : e);
        if (peel(a.lexpr)?.ColumnRef && peel(a.rexpr)?.ColumnRef) {
          this.columnsIn(peel(a.lexpr), scope, l);
          this.columnsIn(peel(a.rexpr), scope, r);
          if (l[0] && r[0]) out.joinEqualities.push({ left: l[0].ref, right: r[0].ref, scope });
        }
      }
      for (const v of Object.values(n)) visit(v);
    };
    visit(s.whereClause);
    visit(s.fromClause);
  }

  private statementInner(s: any, key: string, outer: TableRef[], top: boolean): void {
    for (const w of s.withClause?.ctes ?? []) {
      const c = w.CommonTableExpr;
      if (c?.ctename) this.cteNames.add(c.ctename);
    }
    for (const w of s.withClause?.ctes ?? []) {
      const q = w.CommonTableExpr?.ctequery;
      const k = nodeName(q);
      if (q && k && q[k]) this.statement(q[k], k, outer);
      this.out.hasDerivedRelations = true;
    }
    if (key === 'SelectStmt') {
      if (s.larg || s.rarg) {
        // UNION / INTERSECT / EXCEPT
        if (s.larg) this.statement(s.larg, 'SelectStmt', outer);
        if (s.rarg) this.statement(s.rarg, 'SelectStmt', outer);
        this.out.hasDerivedRelations = true;
        return;
      }
      if (s.valuesLists) {
        this.out.hasDerivedRelations = true;
        return;
      }
      const scope = this.fromScope(s.fromClause);
      const all = [...scope, ...outer];
      this.joinQuals(s.fromClause, scope, outer);
      for (const t of s.targetList ?? []) this.expr(t.ResTarget?.val, all);
      if (s.whereClause) this.expr(s.whereClause, all);
      if (s.havingClause) this.expr(s.havingClause, all);
      this.limit(s.limitCount, 'limit', all);
      this.limit(s.limitOffset, 'offset', all);
      if (top) this.topLevelFacts(s, all);
    } else if (key === 'InsertStmt') {
      const target = rangeVar(s.relation);
      this.addTable(target);
      const cols: string[] | null = s.cols ? s.cols.map((c: any) => c.ResTarget?.name) : null;
      const sel = s.selectStmt?.SelectStmt;
      if (sel?.valuesLists) {
        for (const row of sel.valuesLists) {
          (row.List?.items ?? []).forEach((item: any, i: number) => {
            const p = this.paramOf(item) ?? this.soleParam(item);
            if (p && !p.wrapped)
              this.claim(
                p,
                'insert_value',
                null,
                cols?.[i] ? { qualifier: null, name: cols[i]!, viaFunction: null } : null,
                [target],
                { insertPosition: cols ? null : i, targetTable: target },
              );
          });
        }
      } else if (sel) {
        this.statement(sel, 'SelectStmt', outer);
      }
      for (const t of s.onConflictClause?.targetList ?? []) {
        const p = this.paramOf(t.ResTarget?.val);
        if (p && !p.wrapped && t.ResTarget?.name)
          this.claim(
            p,
            'update_set',
            '=',
            { qualifier: null, name: t.ResTarget.name, viaFunction: null },
            [target],
            {
              targetTable: target,
            },
          );
      }
    } else if (key === 'UpdateStmt') {
      const target = rangeVar(s.relation);
      this.addTable(target);
      const scope = [target, ...this.fromScope(s.fromClause)];
      const all = [...scope, ...outer];
      for (const t of s.targetList ?? []) {
        const p = this.paramOf(t.ResTarget?.val);
        if (p && !p.wrapped && t.ResTarget?.name)
          this.claim(
            p,
            'update_set',
            '=',
            { qualifier: null, name: t.ResTarget.name, viaFunction: null },
            all,
            {
              targetTable: target,
            },
          );
        else this.expr(t.ResTarget?.val, all);
      }
      if (s.whereClause) this.expr(s.whereClause, all);
    } else if (key === 'DeleteStmt') {
      const target = rangeVar(s.relation);
      this.addTable(target);
      const scope = [target, ...this.fromScope(s.usingClause)];
      if (s.whereClause) this.expr(s.whereClause, [...scope, ...outer]);
    } else if (key === 'MergeStmt') {
      this.out.hasDerivedRelations = true;
    }
    if (key !== 'SelectStmt')
      for (const t of s.returningList ?? [])
        this.expr(t.ResTarget?.val, [
          ...(this.out.tables.length ? [rangeVar(s.relation)] : []),
          ...outer,
        ]);
  }

  private limit(e: any, role: 'limit' | 'offset', scope: TableRef[]): void {
    const p = this.paramOf(e);
    if (p) this.claim(p, role, null, null, scope);
    else if (e) this.expr(e, scope);
  }

  /** walks an expression, recording how each parameter is used */
  private expr(e: any, scope: TableRef[]): void {
    if (Array.isArray(e)) return e.forEach((x) => this.expr(x, scope));
    if (!e || typeof e !== 'object') return;
    if (e.BoolExpr) return this.expr(e.BoolExpr.args, scope);
    if (e.SubLink) {
      this.expr(e.SubLink.testexpr, scope);
      const sub = e.SubLink.subselect?.SelectStmt;
      if (sub) this.statement(sub, 'SelectStmt', scope);
      return;
    }
    if (e.A_Expr) return this.aExpr(e.A_Expr, scope);
    if (e.FuncCall) {
      const parts = (e.FuncCall.funcname ?? [])
        .map(str)
        .filter((x: string | null): x is string => x !== null);
      const name = parts.join('.').toLowerCase();
      (e.FuncCall.args ?? []).forEach((arg: any, index: number) => {
        const { node, cast } = this.peel(arg);
        if (node?.ParamRef)
          this.claim({ ref: node.ParamRef, cast }, 'other', null, null, scope, {
            functionArg: { name: parts[parts.length - 1]!.toLowerCase(), index },
          });
        else this.expr(arg, scope);
      });
      void name;
      return;
    }
    // anything else: look inside for nested comparisons (CASE, COALESCE, function arguments, ...)
    for (const v of Object.values(e)) {
      if (v && typeof v === 'object' && !(v as any).number) this.expr(v, scope);
    }
  }

  private aExpr(a: any, scope: TableRef[]): void {
    const op: string = (a.name ?? []).map(str).filter(Boolean).pop() ?? '';
    if (a.kind === 'AEXPR_OP' && a.lexpr?.RowExpr && a.rexpr?.RowExpr) {
      // row comparison, e.g. keyset pagination: (occurred_at, id) < ($1, $2): pair the columns with the parameters in order
      const ls: any[] = a.lexpr.RowExpr.args ?? [];
      const rs: any[] = a.rexpr.RowExpr.args ?? [];
      if (ls.length === rs.length) {
        ls.forEach((l, i) =>
          this.aExpr({ kind: 'AEXPR_OP', name: a.name, lexpr: l, rexpr: rs[i] }, scope),
        );
        return;
      }
    }
    const colL = this.columnOf(a.lexpr);
    const colR = this.columnOf(a.rexpr);
    const pL = this.paramOf(a.lexpr);
    const pR = this.paramOf(a.rexpr);
    switch (a.kind) {
      case 'AEXPR_OP': {
        const side =
          colL && pR
            ? { col: colL, p: pR, flip: false }
            : colR && pL
              ? { col: colR, p: pL, flip: true }
              : null;
        if (side) {
          let role: ParamRole = 'other';
          let o = op;
          if (side.flip) o = { '<': '>', '<=': '>=', '>': '<', '>=': '<=' }[op] ?? op;
          if (o === '=') role = 'equality';
          else if (o === '>' || o === '>=') role = 'range_lower';
          else if (o === '<' || o === '<=') role = 'range_upper';
          else if (o === '<>' || o === '!=') role = 'inequality';
          else if (o === '~~' || o === '~~*' || o === '!~~' || o === '!~~*') role = 'like';
          this.claim(side.p, role, o, side.col, scope);
          return;
        }
        break;
      }
      case 'AEXPR_LIKE':
      case 'AEXPR_ILIKE': {
        if (colL && pR) return this.claim(pR, 'like', op, colL, scope);
        break;
      }
      case 'AEXPR_IN': {
        if (colL) {
          for (const item of a.rexpr?.List?.items ?? []) {
            const p = this.paramOf(item);
            if (p) this.claim(p, 'in_list', op, colL, scope);
            else this.expr(item, scope);
          }
          return;
        }
        break;
      }
      case 'AEXPR_OP_ANY':
      case 'AEXPR_OP_ALL': {
        if (colL && pR) return this.claim(pR, 'any_array', op, colL, scope);
        break;
      }
      case 'AEXPR_BETWEEN':
      case 'AEXPR_NOT_BETWEEN':
      case 'AEXPR_BETWEEN_SYM':
      case 'AEXPR_NOT_BETWEEN_SYM': {
        const items: any[] = a.rexpr?.List?.items ?? [];
        if (colL && items.length === 2) {
          const [lo, hi] = items.map((i) => this.paramOf(i));
          if (lo) this.claim(lo, 'between_lower', 'BETWEEN', colL, scope);
          else this.expr(items[0], scope);
          if (hi) this.claim(hi, 'between_upper', 'BETWEEN', colL, scope);
          else this.expr(items[1], scope);
          return;
        }
        break;
      }
      default:
        break;
    }
    this.expr(a.lexpr, scope);
    this.expr(a.rexpr, scope);
  }
}

// ------------------------------------------------------------------------------------------------
// fragments of plans: conditions and sort keys, read by the same parser (never executed)

export interface ConditionFacts {
  /** every column reference in the condition */
  columns: ColumnReference[];
  /** column = column comparisons (join conditions), in the order written */
  equalities: [ColumnReference, ColumnReference][];
}

/** Reads the text of a plan condition such as `((e.tenant_id = t.id) AND (e.x > 5))`. null when it cannot be parsed. */
export async function parseCondition(cond: string): Promise<ConditionFacts | null> {
  await ensureLoaded();
  let tree: any;
  try {
    tree = await parse(`SELECT 1 WHERE ${cond}`);
  } catch {
    return null;
  }
  if ((tree.stmts ?? []).length !== 1) return null;
  const where = tree.stmts[0]?.stmt?.SelectStmt?.whereClause;
  if (!where) return null;
  const facts: ConditionFacts = { columns: [], equalities: [] };
  const colOf = (n: any): ColumnReference | null => {
    let cur = n;
    while (cur?.TypeCast) cur = cur.TypeCast.arg;
    if (!cur?.ColumnRef) return null;
    const names = (cur.ColumnRef.fields ?? []).map(str);
    if (names.some((x: string | null) => x === null)) return null;
    return {
      name: names[names.length - 1] as string,
      qualifier: names.length >= 2 ? (names[names.length - 2] as string) : null,
      viaFunction: null,
    };
  };
  const visit = (n: any): void => {
    if (Array.isArray(n)) return n.forEach(visit);
    if (!n || typeof n !== 'object') return;
    if (n.ColumnRef) {
      const c = colOf(n);
      if (c) facts.columns.push(c);
    }
    if (n.A_Expr?.kind === 'AEXPR_OP' && (n.A_Expr.name ?? []).map(str).pop() === '=') {
      const l = colOf(n.A_Expr.lexpr);
      const r = colOf(n.A_Expr.rexpr);
      if (l && r) facts.equalities.push([l, r]);
    }
    for (const v of Object.values(n)) visit(v);
  };
  visit(where);
  return facts;
}

export interface SortKeyFacts {
  /** a plain column (possibly qualified), or null when the key is an expression or could not be read */
  column: ColumnReference | null;
  desc: boolean;
}

/** Reads one `Sort Key` entry of a plan (it is valid ORDER BY syntax: `t.col DESC NULLS FIRST`). */
export async function parseSortKey(key: string): Promise<SortKeyFacts> {
  await ensureLoaded();
  let tree: any;
  try {
    tree = await parse(`SELECT 1 ORDER BY ${key}`);
  } catch {
    return { column: null, desc: false };
  }
  const sorts: any[] = tree.stmts?.[0]?.stmt?.SelectStmt?.sortClause ?? [];
  if ((tree.stmts ?? []).length !== 1 || sorts.length !== 1) return { column: null, desc: false };
  const sb = sorts[0].SortBy;
  const node = sb?.node;
  const names = node?.ColumnRef ? (node.ColumnRef.fields ?? []).map(str) : null;
  const ok = names && !names.some((x: string | null) => x === null);
  return {
    column: ok
      ? {
          name: names[names.length - 1] as string,
          qualifier: names.length >= 2 ? (names[names.length - 2] as string) : null,
          viaFunction: null,
        }
      : null,
    desc: sb?.sortby_dir === 'SORTBY_DESC',
  };
}
