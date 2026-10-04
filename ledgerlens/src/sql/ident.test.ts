import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, createScratchDb, type ScratchDb } from '../testing/db.js';
import {
  IdentifierError,
  MAX_IDENTIFIER_BYTES,
  quoteIdent,
  quoteLiteral,
  quoteQualified,
  safeCommentText,
} from './ident.js';

// bytes, not characters: 21 x "é" is 42 bytes, 32 x "é" is 64
const HOSTILE_NAMES: Record<string, string> = {
  'a double quote': 'we"ird',
  'only quotes': '"""',
  'a semicolon and a second statement': 'x"; DROP TABLE victim; --',
  'a newline': 'two\nlines',
  'carriage return and tab': 'a\r\nb\tc',
  'comment markers': 'a--b/*c*/d',
  unicode: 'tablé 日本語 😀',
  'right-to-left override': 'abc‮def',
  'a reserved word': 'select',
  'another reserved word': 'user',
  'a name that looks like SQL': 'x) ; DELETE FROM victim WHERE (1=1',
  'exactly 63 bytes': 'a'.repeat(MAX_IDENTIFIER_BYTES),
  'exactly 63 bytes of multibyte': 'é'.repeat(31) + 'a',
  'a dollar and a backslash': 'a$b\\c',
  'upper case (case must be kept)': 'MixedCase',
  'a space': 'a b',
};

let db: ScratchDb;
let c: pg.Client;
beforeAll(async () => {
  db = await createScratchDb(['CREATE TABLE victim (id int)', 'INSERT INTO victim VALUES (1)']);
  c = new pg.Client({ connectionString: db.adminUrl });
  await c.connect();
});
afterAll(async () => {
  await c.end();
  await db.drop();
});

describe('quoteIdent against a real server', () => {
  for (const [label, name] of Object.entries(HOSTILE_NAMES)) {
    it(`a table and a column named with ${label} are created, read back with exactly that name, and nothing else happens`, async () => {
      expect(Buffer.byteLength(name)).toBeLessThanOrEqual(MAX_IDENTIFIER_BYTES);
      const q = quoteIdent(name);
      await c.query(`CREATE TABLE ${q} (${q} int, other int)`);
      const t = await c.query<{ relname: string }>(
        'SELECT relname FROM pg_class WHERE relname = $1 AND relkind = $2',
        [name, 'r'],
      );
      expect(t.rows.map((r) => r.relname)).toEqual([name]);
      const col = await c.query<{ attname: string }>(
        'SELECT attname FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 ORDER BY attnum',
        [q],
      );
      expect(col.rows.map((r) => r.attname)).toEqual([name, 'other']);
      // it can be used in an index and a query too
      await c.query(`CREATE INDEX ON ${q} (${q})`);
      await c.query(`SELECT ${q} FROM ${q} WHERE ${q} = 1`);
      await c.query(`DROP TABLE ${q}`);
      // the injected statement did not run
      expect((await c.query('SELECT count(*)::int AS n FROM victim')).rows[0]!.n).toBe(1);
    });
  }

  it('refuses a name the server could not store exactly, instead of altering it', async () => {
    const tooLong = 'a'.repeat(64);
    expect(() => quoteIdent(tooLong)).toThrow(IdentifierError);
    expect(() => quoteIdent('é'.repeat(32))).toThrow(/64/); // 64 BYTES, 32 characters
    expect(() => quoteIdent('')).toThrow(IdentifierError);
    expect(() => quoteIdent('a\u0000b')).toThrow(/NUL/);
    expect(() => quoteIdent('a\ud800b')).toThrow(/Unicode/);
    expect(() => quoteQualified('s', 'x'.repeat(70))).toThrow(IdentifierError);
    // why it matters: the server truncates silently, which would point the statement at another object
    await c.query(`CREATE TABLE "${tooLong}" (a int)`);
    const r = await c.query<{ relname: string }>(
      "SELECT relname FROM pg_class WHERE relname LIKE 'aaaa%' AND relkind = 'r'",
    );
    expect(r.rows[0]!.relname).toHaveLength(63);
    await c.query(`DROP TABLE "${'a'.repeat(63)}"`);
  });

  it('quoteQualified quotes both parts', () => {
    expect(quoteQualified('public', 'we"ird')).toBe('"public"."we""ird"');
    expect(quoteQualified(null, 'x')).toBe('"x"');
  });
});

describe('quoteLiteral against a real server', () => {
  const VALUES = [
    "O'Brien",
    "'; DROP TABLE victim; --",
    "x' OR '1'='1",
    'back\\slash',
    'trailing backslash\\',
    "\\' mixed \\\\ ' ",
    'new\nline',
    'unicode 日本語 😀',
    '$1 and $$ and $tag$',
    '',
  ];
  for (const standard of ['on', 'off']) {
    it(`reads back exactly the given text with standard_conforming_strings = ${standard}`, async () => {
      const k = new pg.Client({ connectionString: db.adminUrl });
      await k.connect();
      try {
        await k.query(`SET standard_conforming_strings = ${standard}`);
        for (const v of VALUES) {
          const r = await k.query<{ v: string }>(`SELECT ${quoteLiteral(v)}::text AS v`);
          expect(r.rows[0]!.v).toBe(v);
        }
        expect((await k.query('SELECT count(*)::int AS n FROM victim')).rows[0]!.n).toBe(1);
      } finally {
        await k.end();
      }
    });
  }
  it('refuses NUL and broken Unicode', () => {
    expect(() => quoteLiteral('a\u0000')).toThrow(IdentifierError);
    expect(() => quoteLiteral('a\udc00')).toThrow(IdentifierError);
  });
});

describe('safeCommentText', () => {
  it('cannot close a comment or start a line comment, and has no line breaks or control characters', () => {
    const odd = [10, 13, 7, 0x2028].map((c) => String.fromCharCode(c));
    const t = safeCommentText(`evil */ DROP TABLE x; -- ${odd.join(' ')} end`);
    expect(t).not.toContain('*/');
    expect(t).not.toContain('--');
    expect([...t].some((ch) => odd.includes(ch))).toBe(false);
    expect(safeCommentText('x'.repeat(500))).toHaveLength(123);
  });
});

void admin;
