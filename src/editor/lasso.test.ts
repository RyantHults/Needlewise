import { describe, expect, it } from 'vitest';
import {
  lassoCellIndices,
  MAX_LASSO_PATH_POINTS,
  normalizeLassoPath,
  appendLassoRasterPoint,
  createLassoRasterAccumulator,
  finishLassoRaster,
  selectionBoundarySegments,
  sparseSelectionGeometry
} from './lasso';

describe('lasso geometry', () => {
  it('selects concave cell centres, includes polygon edges, and clips to the document', () => {
    const indices = lassoCellIndices([
      { x: -1, y: -1 },
      { x: 4, y: -1 },
      { x: 4, y: 1 },
      { x: 2, y: 1 },
      { x: 2, y: 4 },
      { x: -1, y: 4 }
    ], 3, 3);
    expect(Array.from(indices)).toEqual([0, 1, 2, 3, 4, 6, 7]);
  });

  it('falls back to the valid starting cell for a click or degenerate path', () => {
    expect(Array.from(lassoCellIndices([{ x: 1.5, y: 1.5 }], 4, 4))).toEqual([5]);
    expect(Array.from(lassoCellIndices([{ x: 1.5, y: 1.5 }, { x: 3.5, y: 1.5 }], 4, 4))).toEqual([5]);
    expect(Array.from(lassoCellIndices([{ x: -1, y: -1 }], 4, 4))).toEqual([]);
  });

  it('retains exterior and hole boundaries for a sparse ring', () => {
    const geometry = sparseSelectionGeometry(new Uint32Array([0, 1, 2, 3, 5, 6, 7, 8]), 3, 3);
    expect(geometry?.bounds).toEqual({ x: 0, y: 0, width: 3, height: 3 });
    expect(geometry?.boundaries).toHaveLength(16);
    expect(geometry?.boundaries.filter((segment) => segment.kind === 'interior')).toHaveLength(4);
    expect(selectionBoundarySegments(new Uint32Array([0, 4]), 3, 3)).toHaveLength(8);
  });

  it('caps highly coalesced paths while retaining their start and latest endpoint', () => {
    const samples = Array.from({ length: MAX_LASSO_PATH_POINTS * 12 }, (_, index) => ({
      x: index,
      y: index % 2 === 0 ? 0 : 1
    }));
    const path = normalizeLassoPath(samples);
    expect(path.length).toBeLessThanOrEqual(MAX_LASSO_PATH_POINTS);
    expect(path[0]).toEqual(samples[0]);
    expect(path.at(-1)).toEqual(samples.at(-1));
  });

  it('rasterizes a large clipped polygon into bounded document indices', () => {
    const samples = Array.from({ length: MAX_LASSO_PATH_POINTS * 4 }, (_, index) => ({
      x: index % 2 === 0 ? -10 : 138,
      y: Math.floor(index / 2) % 140 - 10
    }));
    const indices = lassoCellIndices(samples, 128, 128, { x: 0.5, y: 0.5 });
    expect(indices.length).toBeGreaterThan(0);
    expect(indices[0]).toBeGreaterThanOrEqual(0);
    expect(indices.at(-1)).toBeLessThan(128 * 128);
  });

  it('clips spans only after deriving unclamped endpoints', () => {
    expect(Array.from(lassoCellIndices([
      { x: 3.2, y: 0 },
      { x: 2.9, y: 3 },
      { x: 1, y: 0 },
      { x: 2.9, y: -1 }
    ], 4, 4))).toEqual([1, 2, 6]);
  });

  it('does not turn an off-document horizontal span into cell 15', () => {
    expect(Array.from(lassoCellIndices([
      { x: 4.5, y: 3.5 },
      { x: 4, y: 3.5 },
      { x: 3, y: 5 },
      { x: 4, y: 3 },
      { x: 3.5, y: 3 }
    ], 4, 4))).toEqual([]);
  });

  it('bounds far-off horizontal boundary marking to document width', () => {
    const accumulator = createLassoRasterAccumulator(4, 4, { x: -1e12, y: 0.5 });
    appendLassoRasterPoint(accumulator, { x: 1e12, y: 0.5 });
    expect(accumulator.boundaryCells.reduce((count, marked) => count + marked, 0)).toBe(4);
    expect(finishLassoRaster(accumulator)).toEqual(new Uint32Array());
  });

  it('keeps an above-cap concave notch exactly equivalent to the uncapped reference', () => {
    const corners = [
      { x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 8 }, { x: 5, y: 8 },
      { x: 5, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 8 }, { x: 0, y: 8 }
    ];
    const points = corners.flatMap((corner, index) => {
      const next = corners[(index + 1) % corners.length];
      return Array.from({ length: 350 }, (_, step) => ({
        x: corner.x + (next.x - corner.x) * step / 350,
        y: corner.y + (next.y - corner.y) * step / 350
      }));
    });
    expect(points.length).toBeGreaterThan(MAX_LASSO_PATH_POINTS);
    const reference = lassoCellIndices(points, 8, 8, { x: 0.5, y: 0.5 });
    const accumulator = createLassoRasterAccumulator(8, 8, points[0], { x: 0.5, y: 0.5 });
    for (const point of points.slice(1)) appendLassoRasterPoint(accumulator, point);
    expect(finishLassoRaster(accumulator)).toEqual(reference);
  });

  it('keeps above-cap cell-centre boundary paths exact', () => {
    const corners = [{ x: 0.5, y: 0.5 }, { x: 6.5, y: 0.5 }, { x: 6.5, y: 4.5 }, { x: 0.5, y: 4.5 }];
    const points = corners.flatMap((corner, index) => {
      const next = corners[(index + 1) % corners.length];
      return Array.from({ length: 700 }, (_, step) => ({
        x: corner.x + (next.x - corner.x) * step / 700,
        y: corner.y + (next.y - corner.y) * step / 700
      }));
    });
    const reference = lassoCellIndices(points, 7, 5, { x: 0.5, y: 0.5 });
    const accumulator = createLassoRasterAccumulator(7, 5, points[0], { x: 0.5, y: 0.5 });
    for (const point of points.slice(1)) appendLassoRasterPoint(accumulator, point);
    expect(finishLassoRaster(accumulator)).toEqual(reference);
  });
});
