import { z } from 'zod';

/**
 * Text that came from a database (query text, identifiers, comments, definitions, plan node text)
 * is never trusted: anyone who can name a table or write a comment can write instructions aimed at
 * a model. It travels as `{ "$untrusted": "<text>" }`, stripped of control characters and limited
 * in length, so it can be recognised as data wherever it ends up.
 */
export interface Untrusted {
  $untrusted: string;
}
export const UntrustedSchema = z.object({ $untrusted: z.string() });
export const isUntrusted = (v: unknown): v is Untrusted =>
  typeof v === 'object' && v !== null && typeof (v as Untrusted).$untrusted === 'string';

/**
 * Removes control characters (C0, DEL, C1), line and paragraph separators, bidirectional overrides
 * and zero-width characters; line breaks and tabs become single spaces. Then cuts to `max`
 * characters and says how much was left out.
 */
export function sanitizeText(text: string, max = 500): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c === 0x0a || c === 0x0d || c === 0x09 || c === 0x2028 || c === 0x2029) out += ' ';
    else if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) continue;
    else if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069))
      continue; // bidi overrides and isolates
    else if (c === 0x200b || c === 0x200c || c === 0x200d || c === 0x2060 || c === 0xfeff)
      continue; // zero width
    else out += ch;
  }
  out = out.replace(/ {2,}/g, ' ').trim();
  const chars = [...out];
  if (chars.length > max)
    return `${chars.slice(0, max).join('')}...[truncated: ${chars.length - max} characters omitted]`;
  return out;
}

/** Marks database-derived text as untrusted (sanitised and limited). null stays null. */
export function untrusted(text: string, max?: number): Untrusted;
export function untrusted(text: string | null | undefined, max?: number): Untrusted | null;
export function untrusted(text: string | null | undefined, max = 500): Untrusted | null {
  if (text === null || text === undefined) return null;
  return { $untrusted: sanitizeText(text, max) };
}

/**
 * Replaces the constants in SQL text with placeholders: string literals (also E'..', $tag$..$tag$),
 * numbers, and bit/hex strings become "?". Placeholders like $1 and identifiers (also "quoted")
 * stay. pg_stat_statements already does this for ordinary queries; utility statements (COMMENT,
 * ALTER ROLE ... PASSWORD, SET) keep their constants, which is why this exists.
 */
export function redactLiterals(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const e = sql.indexOf('\n', i);
      const end = e === -1 ? n : e;
      out += sql.slice(i, end);
      i = end;
    } else if (c === '/' && next === '*') {
      const e = sql.indexOf('*/', i + 2);
      const end = e === -1 ? n : e + 2;
      out += sql.slice(i, end);
      i = end;
    } else if (
      c === "'" ||
      ((c === 'E' || c === 'e' || c === 'B' || c === 'b' || c === 'X' || c === 'x') &&
        next === "'" &&
        !/[A-Za-z0-9_]/.test(sql[i - 1] ?? ''))
    ) {
      const escape = c === 'E' || c === 'e';
      let j = i + (c === "'" ? 1 : 2);
      while (j < n) {
        if (escape && sql[j] === '\\') j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") {
          j++;
          break;
        } else j++;
      }
      out += '?';
      i = Math.min(j, n);
    } else if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const close = sql.indexOf(m[0], i + m[0].length);
        out += '?';
        i = close === -1 ? n : close + m[0].length;
      } else {
        out += c;
        i++;
      }
    } else if (c === '"') {
      let j = i + 1;
      while (j < n && !(sql[j] === '"' && sql[j + 1] !== '"')) j += sql[j] === '"' ? 2 : 1;
      out += sql.slice(i, Math.min(j + 1, n));
      i = Math.min(j + 1, n);
    } else if (/[0-9]/.test(c) && !/[A-Za-z0-9_$]/.test(sql[i - 1] ?? '')) {
      const m = /^(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+)/.exec(sql.slice(i))!;
      out += '?';
      i += m[0].length;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}
