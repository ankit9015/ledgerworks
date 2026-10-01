import { describe, expect, it } from 'vitest';
import { name } from './index.js';

describe('ledgerline skeleton', () => {
  it('exports its package name', () => {
    expect(name).toBe('ledgerline');
  });
});
