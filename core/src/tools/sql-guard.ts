/**
 * A conservative check that a piece of SQL is exactly ONE plain SELECT (or WITH ... SELECT), used
 * before the text is put after EXPLAIN. It is a refusal list on a "skeleton" of the text in which
 * comments, string literals, dollar-quoted strings and quoted identifiers have been blanked, so a
 * semicolon or a keyword hidden inside any of them neither triggers nor hides a refusal. It errs
 * on the side of refusing. It is the first of three layers: the statement also runs in a READ ONLY
 * transaction with a statement timeout, as a role that cannot write.
 */
export type GuardCode =
  | 'empty'
  | 'too_long'
  | 'unterminated'
  | 'multiple_statements'
  | 'not_select'
  | 'explain'
  | 'write_keyword'
  | 'select_into'
  | 'locking_clause'
  | 'dangerous_function';

export type GuardResult =
  | { ok: true; skeleton: string; placeholders: number[] }
  | { ok: false; code: GuardCode; reason: string };

/** Blanks comments (nested /* *\/ too), strings, dollar quotes and quoted identifiers. */
export function skeletonOf(
  sql: string,
): { ok: true; text: string } | { ok: false; reason: string } {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const e = sql.indexOf('\n', i);
      i = e === -1 ? n : e;
      out += ' ';
    } else if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth > 0) return { ok: false, reason: 'an unterminated /* comment' };
      out += ' ';
    } else if (c === "'") {
      const escape = /[Ee]$/.test(out) && !/[A-Za-z0-9_]/.test(out[out.length - 2] ?? '');
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (escape && sql[j] === '\\') j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") {
          closed = true;
          j++;
          break;
        } else j++;
      }
      if (!closed) return { ok: false, reason: 'an unterminated string literal' };
      out += "''";
      i = j;
    } else if (c === '"') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (sql[j] === '"' && sql[j + 1] === '"') j += 2;
        else if (sql[j] === '"') {
          closed = true;
          j++;
          break;
        } else j++;
      }
      if (!closed) return { ok: false, reason: 'an unterminated quoted identifier' };
      out += '"x"';
      i = j;
    } else if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const close = sql.indexOf(m[0], i + m[0].length);
        if (close === -1) return { ok: false, reason: 'an unterminated dollar-quoted string' };
        out += "''";
        i = close + m[0].length;
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return { ok: true, text: out };
}

const WRITE_WORDS =
  /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|copy|call|vacuum|reindex|cluster|refresh|lock|listen|notify|prepare|execute|discard|load|set|reset|begin|commit|rollback|savepoint)\b/i;
const DANGEROUS_FUNCTIONS =
  /\b(pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_promote|pg_switch_wal|pg_create_restore_point|pg_start_backup|pg_stop_backup|lo_import|lo_export|lo_unlink|lo_create|lo_from_bytea|dblink\w*|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_ls_\w+|pg_stat_file|pg_advisory\w*|pg_notify|set_config|nextval|setval|pg_sleep\w*|pg_replication_slot_advance|pg_drop_replication_slot|pg_create_\w*_replication_slot|pg_logical_emit_message|query_to_xml\w*|table_to_xml\w*|database_to_xml\w*|cursor_to_xml|pg_backend_memory_contexts|pg_import_system_collations|pg_stat_reset\w*|pg_wal_replay_\w+|pg_file_\w+)\s*\(/i;

export function checkSingleSelect(sql: string, maxLength = 20_000): GuardResult {
  if (typeof sql !== 'string' || sql.trim() === '')
    return { ok: false, code: 'empty', reason: 'the query is empty' };
  if (sql.length > maxLength)
    return {
      ok: false,
      code: 'too_long',
      reason: `the query is longer than ${maxLength} characters`,
    };
  const sk = skeletonOf(sql);
  if (!sk.ok) return { ok: false, code: 'unterminated', reason: `the query has ${sk.reason}` };
  let text = sk.text.trim();
  text = text.replace(/;\s*$/, '').trim(); // one trailing semicolon is fine
  if (text.includes(';'))
    return { ok: false, code: 'multiple_statements', reason: 'only a single statement is allowed' };
  const stripped = text.replace(/^[\s(]+/, '');
  const first = /^[A-Za-z_]+/.exec(stripped)?.[0]?.toLowerCase() ?? '';
  if (first === 'explain')
    return {
      ok: false,
      code: 'explain',
      reason:
        'send the SELECT itself: the tool adds EXPLAIN, and EXPLAIN ANALYZE is never run on the source database',
    };
  if (first !== 'select' && first !== 'with')
    return {
      ok: false,
      code: 'not_select',
      reason: 'only a SELECT (or WITH ... SELECT) is allowed',
    };
  if (/\bexplain\b/i.test(text) || /\banalyze\b|\banalyse\b/i.test(text)) {
    return {
      ok: false,
      code: 'explain',
      reason:
        'EXPLAIN and ANALYZE are not allowed inside the query; EXPLAIN ANALYZE is never run on the source database',
    };
  }
  if (/\bfor\s+(no\s+key\s+update|update|share|key\s+share)\b/i.test(text)) {
    return {
      ok: false,
      code: 'locking_clause',
      reason: 'locking clauses (FOR UPDATE, FOR SHARE) are not allowed',
    };
  }
  const w = WRITE_WORDS.exec(text);
  if (w)
    return {
      ok: false,
      code: 'write_keyword',
      reason: `the keyword "${w[1]!.toLowerCase()}" is not allowed (a data-modifying CTE or a statement other than SELECT)`,
    };
  if (/\binto\b/i.test(text))
    return {
      ok: false,
      code: 'select_into',
      reason: 'SELECT ... INTO creates a table and is not allowed',
    };
  const f = DANGEROUS_FUNCTIONS.exec(text);
  if (f)
    return {
      ok: false,
      code: 'dangerous_function',
      reason: `the function "${f[1]!.toLowerCase()}" is not allowed`,
    };
  const placeholders = [...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  return { ok: true, skeleton: text, placeholders };
}
