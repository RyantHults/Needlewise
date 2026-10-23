import { describe, expect, it } from 'vitest';
import { nextRovingIndex } from './roving';

describe('nextRovingIndex', () => {
  it('moves along the orientation and wraps', () => {
    expect(nextRovingIndex('ArrowRight', 0, 3, 'horizontal')).toBe(1);
    expect(nextRovingIndex('ArrowRight', 2, 3, 'horizontal')).toBe(0);
    expect(nextRovingIndex('ArrowLeft', 0, 3, 'horizontal')).toBe(2);
    expect(nextRovingIndex('ArrowDown', 2, 3, 'vertical')).toBe(0);
    expect(nextRovingIndex('ArrowUp', 0, 3, 'vertical')).toBe(2);
  });

  it('ignores the other axis unless both', () => {
    expect(nextRovingIndex('ArrowDown', 0, 3, 'horizontal')).toBeNull();
    expect(nextRovingIndex('ArrowLeft', 1, 3, 'vertical')).toBeNull();
    expect(nextRovingIndex('ArrowDown', 0, 3, 'both')).toBe(1);
    expect(nextRovingIndex('ArrowLeft', 0, 3, 'both')).toBe(2);
  });

  it('jumps to the ends in every orientation', () => {
    for (const orientation of ['horizontal', 'vertical', 'both'] as const) {
      expect(nextRovingIndex('Home', 2, 4, orientation)).toBe(0);
      expect(nextRovingIndex('End', 1, 4, orientation)).toBe(3);
    }
  });

  it('returns null for other keys and empty groups', () => {
    expect(nextRovingIndex('Enter', 0, 3, 'both')).toBeNull();
    expect(nextRovingIndex('Home', 0, 0, 'both')).toBeNull();
  });
});
