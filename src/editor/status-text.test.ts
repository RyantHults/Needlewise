import { describe, expect, it } from 'vitest';
import { countLabel } from './status-text';

describe('countLabel', () => {
  it('uses the singular only for one', () => {
    expect(countLabel(1, 'cell')).toBe('1 cell');
    expect(countLabel(0, 'cell')).toBe('0 cells');
    expect(countLabel(3, 'backstitch', 'backstitches')).toBe('3 backstitches');
  });
});
