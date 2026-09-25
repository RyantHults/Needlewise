import { describe, expect, it } from 'vitest';
import type { ModelPoint } from './contracts';
import { rasterizeShapeOutline } from './shapes';

function pointKey(point: ModelPoint): string {
  return `${point.x},${point.y}`;
}

function expectRowMajorUnique(points: readonly ModelPoint[]): void {
  expect(new Set(points.map(pointKey)).size).toBe(points.length);
  expect(points).toEqual([...points].sort((left, right) => left.y - right.y || left.x - right.x));
}

describe('shape outline geometry', () => {
  it('draws a thin diagonal line with diagonal-only neighboring cells', () => {
    const points = rasterizeShapeOutline('line', { x: 0, y: 0 }, { x: 2, y: 2 });

    expect(points.map(pointKey)).toEqual(['0,0', '1,1', '2,2']);
    expectRowMajorUnique(points);
  });

  it('draws all inclusive rectangle edges and supports reversed bounds', () => {
    const expected = [
      '1,2', '2,2', '3,2', '4,2',
      '1,3', '4,3',
      '1,4', '2,4', '3,4', '4,4'
    ];
    const forward = rasterizeShapeOutline('rectangle', { x: 1, y: 2 }, { x: 4, y: 4 });
    const reversed = rasterizeShapeOutline('rectangle', { x: 4, y: 4 }, { x: 1, y: 2 });

    expect(forward.map(pointKey)).toEqual(expected);
    expect(reversed).toEqual(forward);
    expectRowMajorUnique(forward);
  });

  it('keeps square outlines inclusive and axis-aligned', () => {
    expect(rasterizeShapeOutline('square', { x: 1, y: 1 }, { x: 3, y: 3 }).map(pointKey)).toEqual([
      '1,1', '2,1', '3,1',
      '1,2', '3,2',
      '1,3', '2,3', '3,3'
    ]);
  });

  it('draws a true thin circle from square bounds', () => {
    const points = rasterizeShapeOutline('circle', { x: 0, y: 0 }, { x: 4, y: 4 });

    expect(points.map(pointKey)).toEqual([
      '2,0',
      '1,1', '3,1',
      '0,2', '4,2',
      '1,3', '3,3',
      '2,4'
    ]);
    expect(points).not.toContainEqual({ x: 0, y: 0 });
    expectRowMajorUnique(points);
  });

  it('keeps an even-cell circle symmetric without filling its interior', () => {
    expect(rasterizeShapeOutline('circle', { x: 0, y: 0 }, { x: 3, y: 3 }).map(pointKey)).toEqual([
      '1,0', '2,0',
      '0,1', '3,1',
      '0,2', '3,2',
      '1,3', '2,3'
    ]);
  });

  it('draws a thin freeform oval across its full rectangular bounds', () => {
    const points = rasterizeShapeOutline('oval', { x: 0, y: 0 }, { x: 6, y: 4 });
    const keys = new Set(points.map(pointKey));

    expect(keys).toContain('3,0');
    expect(keys).toContain('3,4');
    expect(keys).toContain('0,2');
    expect(keys).toContain('6,2');
    expect(keys).not.toContain('0,0');
    expect(keys).not.toContain('6,0');
    expect(keys).not.toContain('0,4');
    expect(keys).not.toContain('6,4');
    expect(keys).not.toContain('3,2');
    expect(points.every(({ x, y }) => x >= 0 && x <= 6 && y >= 0 && y <= 4)).toBe(true);
    expectRowMajorUnique(points);
  });

  it('draws an upward triangle with thin diagonal sides and an inclusive base', () => {
    const points = rasterizeShapeOutline('triangle', { x: 0, y: 0 }, { x: 4, y: 4 });

    expect(points.map(pointKey)).toEqual([
      '2,0',
      '1,1', '3,1',
      '1,2', '3,2',
      '0,3', '4,3',
      '0,4', '1,4', '2,4', '3,4', '4,4'
    ]);
    expectRowMajorUnique(points);
  });

  it('keeps the right-angle vertex at the drag start in all four drag quadrants', () => {
    const cases = [
      {
        start: { x: 0, y: 0 }, end: { x: 2, y: 2 },
        expected: ['0,0', '1,0', '2,0', '0,1', '1,1', '0,2']
      },
      {
        start: { x: 2, y: 0 }, end: { x: 0, y: 2 },
        expected: ['0,0', '1,0', '2,0', '1,1', '2,1', '2,2']
      },
      {
        start: { x: 0, y: 2 }, end: { x: 2, y: 0 },
        expected: ['0,0', '0,1', '1,1', '0,2', '1,2', '2,2']
      },
      {
        start: { x: 2, y: 2 }, end: { x: 0, y: 0 },
        expected: ['2,0', '1,1', '2,1', '0,2', '1,2', '2,2']
      }
    ] as const;

    for (const { start, end, expected } of cases) {
      const points = rasterizeShapeOutline('right-triangle', start, end);
      expect(points.map(pointKey)).toEqual(expected);
      expect(points).toContainEqual(start);
      expectRowMajorUnique(points);
    }
  });

  it('retains continuous degenerate rectangle and upward-triangle outlines', () => {
    expect(rasterizeShapeOutline('rectangle', { x: 1, y: 3 }, { x: 4, y: 3 })).toEqual([
      { x: 1, y: 3 }, { x: 2, y: 3 }, { x: 3, y: 3 }, { x: 4, y: 3 }
    ]);
    expect(rasterizeShapeOutline('triangle', { x: 3, y: 1 }, { x: 3, y: 4 })).toEqual([
      { x: 3, y: 1 }, { x: 3, y: 2 }, { x: 3, y: 3 }, { x: 3, y: 4 }
    ]);
  });
});
