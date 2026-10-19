import { describe, expect, it } from 'vitest';
import { clampCell, indexBounds, intersectRect, rectsEqual } from './rect';

describe('rect helpers', () => {
  it('intersects half-open rects and returns undefined when they only touch', () => {
    expect(intersectRect({ x: 0, y: 0, width: 4, height: 4 }, { x: 2, y: 1, width: 4, height: 4 })).toEqual({ x: 2, y: 1, width: 2, height: 3 });
    expect(intersectRect({ x: 0, y: 0, width: 2, height: 2 }, { x: 2, y: 0, width: 2, height: 2 })).toBeUndefined();
  });

  it('compares rects, treating two absent rects as equal', () => {
    expect(rectsEqual(undefined, undefined)).toBe(true);
    expect(rectsEqual({ x: 0, y: 0, width: 1, height: 1 }, undefined)).toBe(false);
    expect(rectsEqual({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 4 })).toBe(true);
    expect(rectsEqual({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 5 })).toBe(false);
  });

  it('bounds row-major indices and skips ones outside the grid', () => {
    expect(indexBounds([7, 2, 99, -1, 1.5], 5, 3)).toEqual({ x: 2, y: 0, width: 1, height: 2 });
    expect(indexBounds([99], 5, 3)).toBeUndefined();
    expect(indexBounds([], 5, 3)).toBeUndefined();
  });

  it('clamps a point to a cell inside the bounds, or to the origin of empty bounds', () => {
    expect(clampCell({ x: 12.5, y: -3 }, { x: 2, y: 2, width: 4, height: 4 })).toEqual({ x: 5, y: 2 });
    expect(clampCell({ x: 3, y: 3 }, { x: 0, y: 0, width: 0, height: 0 })).toEqual({ x: 0, y: 0 });
  });
});
