import { describe, expect, it } from 'vitest';
import { assertLocalDevDatabase } from './seed.js';

describe('seed safety guard', () => {
  it('accepts only the local development database', () => {
    expect(() =>
      assertLocalDevDatabase('postgres://ledgerworks:ledgerworks@localhost:5432/ledgerworks'),
    ).not.toThrow();
    expect(() =>
      assertLocalDevDatabase('postgres://ledgerworks:ledgerworks@127.0.0.1:5432/ledgerworks'),
    ).not.toThrow();
  });

  it('refuses remote hosts', () => {
    expect(() => assertLocalDevDatabase('postgres://u:p@db.example.com:5432/ledgerworks')).toThrow(
      /not local/,
    );
    expect(() => assertLocalDevDatabase('postgres://u:p@10.0.0.5:5432/ledgerworks')).toThrow(
      /not local/,
    );
  });

  it('refuses any other database name, including the test database', () => {
    expect(() => assertLocalDevDatabase('postgres://u:p@localhost:5432/ledgerline_test')).toThrow(
      /not "ledgerworks"/,
    );
    expect(() => assertLocalDevDatabase('postgres://u:p@localhost:5432/postgres')).toThrow(
      /not "ledgerworks"/,
    );
  });
});
