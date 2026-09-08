import { describe, expect, it } from 'vitest';
import { cellKey, supercoverLine } from './interpolation';

describe('editor supercover interpolation', () => {
  it('covers horizontal, vertical, and reverse directions', () => {
    expect(supercoverLine({ x: 0, y: 2 }, { x: 4, y: 2 })).toEqual([
      { x: 0, y: 2 }, { x: 1, y: 2 }, { x: 2, y: 2 }, { x: 3, y: 2 }, { x: 4, y: 2 }
    ]);
    expect(supercoverLine({ x: 3, y: 4 }, { x: 3, y: 0 })).toEqual([
      { x: 3, y: 4 }, { x: 3, y: 3 }, { x: 3, y: 2 }, { x: 3, y: 1 }, { x: 3, y: 0 }
    ]);
    expect(supercoverLine({ x: 3, y: 0 }, { x: 0, y: 0 })).toHaveLength(4);
  });

  it('includes both sides of corner crossings and has no duplicate keys', () => {
    const cells = supercoverLine({ x: 0, y: 0 }, { x: 2, y: 2 });
    expect(cells).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 1, y: 2 },
      { x: 2, y: 2 }
    ]);
    expect(new Set(cells.map(cellKey)).size).toBe(cells.length);
    expect(supercoverLine({ x: 4, y: 4 }, { x: 4, y: 4 })).toEqual([{ x: 4, y: 4 }]);
  });

  it('uses exact cross-products for steep, shallow, and reverse walks', () => {
    const steep = supercoverLine({ x: 0, y: 0 }, { x: 1, y: 7 });
    expect(steep).toEqual([
      { x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }, { x: 0, y: 3 },
      { x: 1, y: 3 }, { x: 0, y: 4 }, { x: 1, y: 4 }, { x: 1, y: 5 },
      { x: 1, y: 6 }, { x: 1, y: 7 }
    ]);
    expect(supercoverLine({ x: 1, y: 7 }, { x: 0, y: 0 })).toEqual([
      { x: 1, y: 7 }, { x: 1, y: 6 }, { x: 1, y: 5 }, { x: 1, y: 4 },
      { x: 0, y: 4 }, { x: 1, y: 3 }, { x: 0, y: 3 }, { x: 0, y: 2 },
      { x: 0, y: 1 }, { x: 0, y: 0 }
    ]);
    expect(supercoverLine({ x: 0, y: 0 }, { x: 7, y: 1 })).toHaveLength(10);
  });
});
