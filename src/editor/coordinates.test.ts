import { describe, expect, it } from 'vitest';
import {
  clampViewport,
  fixedToScreen,
  fitViewport,
  getCanvasMetrics,
  modelToScreen,
  screenToFixed,
  screenToModel,
  screenToCellUnclamped,
  visibleCellRect,
  zoomAt
} from './coordinates';
import { getRenderLod } from './viewport';

describe('canvas coordinate foundation', () => {
  const metrics = { cssWidth: 200, cssHeight: 100 };

  it('round-trips model, screen, and fixed-point coordinates', () => {
    const viewport = { x: 3.25, y: -2, zoom: 8 };
    const model = { x: 7.5, y: 4.125 };
    expect(screenToModel(modelToScreen(model, viewport), viewport)).toEqual(model);
    expect(fixedToScreen({ x: 12, y: 20 }, viewport)).toEqual({ x: -2, y: 56 });
    expect(screenToFixed({ x: -2, y: 56 }, viewport)).toEqual({ x: 12, y: 20 });
  });

  it('keeps the cursor anchor fixed while zooming', () => {
    const viewport = { x: 4, y: 3, zoom: 10 };
    const cursor = { x: 75, y: 25 };
    const before = screenToModel(cursor, viewport);
    const afterViewport = zoomAt(viewport, cursor, 20);
    expect(screenToModel(cursor, afterViewport)).toEqual(before);
  });

  it('keeps finite off-chart origins while visible-cell queries reject off-chart space', () => {
    const viewport = clampViewport({ x: 99, y: -10, zoom: 10 }, { width: 20, height: 20 }, metrics);
    expect(viewport).toEqual({ x: 99, y: -10, zoom: 10 });
    expect(visibleCellRect({ x: 4.5, y: 2.25, zoom: 10 }, metrics, { width: 20, height: 20 })).toEqual({
      x: 4,
      y: 2,
      width: 16,
      height: 11
    });
    expect(visibleCellRect(viewport, metrics, { width: 20, height: 20 })).toEqual({ x: 20, y: 0, width: 0, height: 0 });
  });

  it('fits a chart back into view after an unbounded pan', () => {
    const offChart = { x: 100, y: -100, zoom: 10 };
    const fitted = fitViewport({ width: 20, height: 10 }, metrics);
    expect(fitted).toEqual({ x: 0, y: 0, zoom: 10 });
    expect(clampViewport(offChart, { width: 20, height: 10 }, metrics)).toEqual(offChart);
  });

  it('rejects non-finite screen and model samples before conversion', () => {
    const viewport = { x: 4, y: 3, zoom: 10 };
    expect(() => screenToCellUnclamped({ x: Number.NaN, y: 2 }, viewport)).toThrow(/finite/);
    expect(() => screenToCellUnclamped({ x: Number.POSITIVE_INFINITY, y: 2 }, viewport)).toThrow(/finite/);
    expect(() => modelToScreen({ x: Number.NaN, y: 2 }, viewport)).toThrow(/finite/);
  });

  it('caps device pixel ratio and backing-store pixels', () => {
    const capped = getCanvasMetrics(500, 500, { dpr: 4, maxDpr: 2 });
    expect(capped.dpr).toBe(2);
    expect(capped.pixelWidth * capped.pixelHeight).toBe(1_000_000);
    const budgeted = getCanvasMetrics(500, 500, { dpr: 2, maxBackingPixels: 10_000 });
    expect(budgeted.pixelWidth * budgeted.pixelHeight).toBeLessThanOrEqual(10_000);
  });

  it('selects overview, compact, and detail levels deterministically', () => {
    expect(getRenderLod(3.99)).toBe('overview');
    expect(getRenderLod(4)).toBe('compact');
    expect(getRenderLod(11.99)).toBe('compact');
    expect(getRenderLod(12)).toBe('detail');
  });
});
