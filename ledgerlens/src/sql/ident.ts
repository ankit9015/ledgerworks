/**
 * The ONE place SQL text for identifiers and string constants is built (principle 5 of the plan:
 * database text is untrusted; generated SQL quotes every identifier and never interpolates an
 * untrusted string). Every function here either returns text that PostgreSQL reads back as exactly the
 * given name or constant, or throws. Nothing is ever "cleaned": a name that cannot be represented is
 * refused, never altered.
 *
 * What PostgreSQL accepts (checked against a real server in ident.test.ts): a double-quoted identifier
 * may contain any character except NUL, with `"` written as `""`; semicolons, newlines, comment
 * markers and Unicode are plain characters inside the quotes; the name may be at most 63 BYTES of
 * UTF-8 (a longer one is silently truncated by the server, which would point a statement at a
 * different object, so it is refused here).
 */

export const MAX_IDENTIFIER_BYTES = 63;

/** true when the string has no lone UTF-16 surrogate (it can be encoded as UTF-8 without loss) */
function isWellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
      else return false;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

export class IdentifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentifierError';
  }
}

export function assertIdentifier(name: string): void {
  if (typeof name !== 'string') throw new IdentifierError('an identifier must be a string');
  if (name.length === 0) throw new IdentifierError('an identifier cannot be empty');
  if (name.includes('\u0000')) throw new IdentifierError('an identifier cannot contain NUL');
  if (!isWellFormed(name)) throw new IdentifierError('an identifier must be well-formed Unicode');
  const bytes = Buffer.byteLength(name, 'utf8');
  if (bytes > MAX_IDENTIFIER_BYTES)
    throw new IdentifierError(
      `an identifier is at most ${MAX_IDENTIFIER_BYTES} bytes, this one is ${bytes} (the server would truncate it silently)`,
    );
}

/** "name", always quoted (so reserved words and odd characters are safe), `"` doubled. */
export function quoteIdent(name: string): string {
  assertIdentifier(name);
  return `"${name.replaceAll('"', '""')}"`;
}

/** "schema"."name" */
export function quoteQualified(schema: string | null | undefined, name: string): string {
  return schema ? `${quoteIdent(schema)}.${quoteIdent(name)}` : quoteIdent(name);
}

/**
 * A string constant. `'` is doubled. A backslash is only a plain character when
 * standard_conforming_strings is on, so a value containing one is written as an E'' string with the
 * backslash doubled, which reads back the same under either setting. NUL cannot be represented.
 */
export function quoteLiteral(value: string): string {
  if (typeof value !== 'string') throw new IdentifierError('a literal must be a string');
  if (value.includes('\u0000')) throw new IdentifierError('a literal cannot contain NUL');
  if (!isWellFormed(value)) throw new IdentifierError('a literal must be well-formed Unicode');
  const body = value.replaceAll("'", "''");
  return value.includes('\\') ? `E'${body.replaceAll('\\', '\\\\')}'` : `'${body}'`;
}

/** For a comment that carries a name (migration headers): control characters and line breaks removed. */
export function safeCommentText(text: string, max = 120): string {
  const flat = [...text]
    .filter((ch) => {
      const c = ch.codePointAt(0)!;
      return !(c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029);
    })
    .join('')
    .replaceAll('*/', '* /')
    .replaceAll('--', '- -');
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max).join('')}...` : flat;
}
