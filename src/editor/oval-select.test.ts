import { describe, expect, it } from 'vitest';
import type { ModelPoint } from './contracts';
import { getCanvasMetrics } from './coordinates';
import { rasterizeFilledOval, rasterizeShapeOutline } from './shapes';
import { at, drag, fixture as layeredFixture, LayeredTestBoundary, plainDocument } from './test-support';

const ZOOM = 16;

function grid(points: readonly ModelPoint[], width: number, height: number): string[] {
  const rows = Array.from({ length: height }, () => Array<string>(width).fill('.'));
  for (const { x, y } of points) rows[y][x] = '#';
  return rows.map((row) => row.join(''));
}

/** A 10x10 layered workspace on its stitch layer with the Select tool's given shape. */
function fixture(shape?: 'rectangle' | 'oval') {
  const { controller, uiStore } = layeredFixture(new LayeredTestBoundary(plainDocument(10, 10)), {
    ui: { viewport: { x: 0, y: 0, zoom: ZOOM } },
    controller: { metrics: getCanvasMetrics(320, 320) }
  });
  controller.setTool(shape ? { tool: 'select', shape } : { tool: 'select' });
  return { controller, uiStore };
}



function indicesOf(points: readonly ModelPoint[], width: number): number[] {
  return points.map(({ x, y }) => y * width + x).sort((left, right) => left - right);
}

describe('filled oval raster', () => {
  it('fills a single cell, a one-cell-wide line, and a 2x2 block', () => {
    expect(rasterizeFilledOval({ x: 3, y: 4 }, { x: 3, y: 4 })).toEqual([{ x: 3, y: 4 }]);
    expect(rasterizeFilledOval({ x: 2, y: 0 }, { x: 2, y: 3 })).toEqual([0, 1, 2, 3].map((y) => ({ x: 2, y })));
    expect(rasterizeFilledOval({ x: 1, y: 1 }, { x: 0, y: 0 })).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }]);
  });

  it('covers the oval outline plus its interior, row-major', () => {
    const filled = rasterizeFilledOval({ x: 0, y: 0 }, { x: 4, y: 2 });
    expect(grid(filled, 5, 3)).toEqual(['.###.', '#####', '.###.']);
    expect(filled).toEqual([...filled].sort((left, right) => left.y - right.y || left.x - right.x));
    const outline = rasterizeShapeOutline('oval', { x: 0, y: 0 }, { x: 6, y: 4 });
    const big = rasterizeFilledOval({ x: 6, y: 4 }, { x: 0, y: 0 });
    for (const point of outline) expect(big).toContainEqual(point);
    expect(grid(big, 7, 5)).toEqual(['..###..', '#######', '#######', '#######', '..###..']);
  });

  it('is symmetric in both axes', () => {
    const rows = grid(rasterizeFilledOval({ x: 0, y: 0 }, { x: 7, y: 5 }), 8, 6);
    expect(rows).toEqual([...rows].reverse());
    expect(rows.map((row) => [...row].reverse().join(''))).toEqual(rows);
  });
});

describe('oval Select on a stitch layer', () => {
  it('publishes a sparse filled-oval selection and leaves no keyboard anchor', () => {
    const { controller, uiStore } = fixture('oval');
    drag(controller, { x: 1, y: 1 }, { x: 5, y: 3 }, 1);
    expect(controller.getSelection()).toEqual({ x: 1, y: 1, width: 5, height: 3 });
    expect(Array.from(controller.getSelectionIndices() ?? [])).toEqual(indicesOf(rasterizeFilledOval({ x: 1, y: 1 }, { x: 5, y: 3 }), 10));
    expect(uiStore.getState().overlay.selection).toMatchObject({ kind: 'sparse' });
    // Keyboard extension is rect-only: with no anchor it starts over from the keyboard cursor.
    controller.handleFocus();
    controller.handleKeyDown({ key: 'ArrowRight', shiftKey: true, preventDefault: () => undefined });
    expect(controller.getSelection()).toEqual({ x: 0, y: 0, width: 2, height: 1 });
    controller.dispose();
  });

  it('keeps an existing selection on a click, as rect select does', () => {
    const { controller, uiStore } = fixture('oval');
    drag(controller, { x: 1, y: 1 }, { x: 5, y: 3 }, 1);
    const indices = Array.from(controller.getSelectionIndices() ?? []);
    controller.handlePointerDown(at(2, 7, 7));
    controller.handlePointerUp(at(2, 7, 7));
    expect(controller.getSelection()).toEqual({ x: 1, y: 1, width: 5, height: 3 });
    expect(Array.from(controller.getSelectionIndices() ?? [])).toEqual(indices);
    expect(uiStore.getState().overlay.selection).toMatchObject({ kind: 'sparse' });
    controller.dispose();
  });

  it('restores the previous selection when the drag is cancelled', () => {
    const { controller } = fixture('oval');
    controller.setSelection({ x: 6, y: 6 }, { x: 7, y: 7 });
    controller.handlePointerDown(at(1, 0, 0));
    controller.handlePointerMove(at(1, 4, 4));
    expect(controller.getSelection()).toEqual({ x: 0, y: 0, width: 5, height: 5 });
    controller.handlePointerCancel(at(1, 4, 4));
    expect(controller.getSelection()).toEqual({ x: 6, y: 6, width: 2, height: 2 });
    controller.dispose();
  });

  it('keeps the selection when switching between rectangle and oval select', () => {
    const { controller, uiStore } = fixture();
    drag(controller, { x: 1, y: 1 }, { x: 3, y: 2 }, 1);
    expect(controller.setTool({ tool: 'select', shape: 'oval' })).toBe(true);
    expect(uiStore.getState().tool).toEqual({ tool: 'select', shape: 'oval' });
    expect(controller.getSelection()).toEqual({ x: 1, y: 1, width: 3, height: 2 });
    drag(controller, { x: 0, y: 0 }, { x: 4, y: 2 }, 2);
    expect(controller.setTool({ tool: 'select' })).toBe(true);
    expect(uiStore.getState().tool).toEqual({ tool: 'select' });
    expect(Array.from(controller.getSelectionIndices() ?? [])).toEqual(indicesOf(rasterizeFilledOval({ x: 0, y: 0 }, { x: 4, y: 2 }), 10));
    controller.dispose();
  });
});
