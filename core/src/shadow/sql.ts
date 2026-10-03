/** Quote an identifier. */
export function qi(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quote a string literal. */
export function ql(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** schema.table, both quoted. */
export function qtable(schema: string, name: string): string {
  return `${qi(schema)}.${qi(name)}`;
}

/**
 * Defence in depth for the source database: every statement sent to it through a SourceSession must
 * start with one of these read-only forms and must not contain a write keyword or a function that
 * writes (nextval and setval advance sequences). The role and the session are read-only as well; this
 * guard makes a coding mistake fail before it reaches the server.
 */
const READ_ONLY_START =
  /^\s*(select\b|with\b|show\b|begin\b|rollback\b|commit\b|set\s|copy\s*\(\s*select\b)/i;
const FORBIDDEN =
  /\b(insert|update|delete|truncate|create|alter|drop|grant|revoke|vacuum|reindex|cluster|lock|call|do|merge|nextval|setval|lastval|lo_\w+|dblink\w*|pg_advisory_lock\w*)\b/i;

export function assertReadOnlySql(sql: string): void {
  // Literals and quoted identifiers may contain anything; look only at the bare text.
  const bare = sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/--.*$/gm, '');
  if (!READ_ONLY_START.test(bare)) {
    throw new Error(
      `Refusing to send a non read-only statement to the source: ${sql.slice(0, 60)}`,
    );
  }
  const m = FORBIDDEN.exec(bare);
  if (m) throw new Error(`Refusing to send a statement containing "${m[1]}" to the source`);
  if (/\bfor\s+(no\s+key\s+)?(update|share)\b/i.test(bare)) {
    throw new Error('Refusing to send a row-locking statement to the source');
  }
}
