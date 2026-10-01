import { describe, expect, it } from 'vitest';
import { name } from './index.js';

describe('core skeleton', () => {
  it('exports its package name', () => {
    expect(name).toBe('core');
  });
});
