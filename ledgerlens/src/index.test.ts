import { describe, expect, it } from 'vitest';
import { name } from './index.js';

describe('ledgerlens skeleton', () => {
  it('exports its package name', () => {
    expect(name).toBe('ledgerlens');
  });
});
