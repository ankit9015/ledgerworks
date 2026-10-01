import { describe, expect, it } from 'vitest';
import { name } from './index.js';

describe('evals skeleton', () => {
  it('exports its package name', () => {
    expect(name).toBe('evals');
  });
});
