import { describe, expect, it } from 'vitest';
import { createDocument, createEditor } from '../domain';
import { DEFAULT_CATALOG_DEFINITION } from '../catalog';
import type { CanvasRenderer, ModelPoint, RenderStats, RendererStyle, Viewport } from './contracts';
import { getCanvasMetrics } from './coordinates';
import { EditorSurfaceController } from './controller';
import { createWorkspaceEditorGateway, type WorkspaceEditorBoundary } from './gateway';
import type { PointerSample } from './input';
import { rasterizeFilledOval, rasterizeShapeOutline } from './shapes';
import { createUiStore } from './ui-store';

const ZOOM = 16;

function grid(points: readonly ModelPoint[], width: number, height: number): string[] {
  const rows = Array.from({ length: height }, () => Array<string>(width).fill('.'));
  for (const { x, y } of points) rows[y][x] = '#';
  return rows.map((row) => row.join(''));
}

function rendererFixture(): CanvasRenderer {
  let viewport: Viewport = { x: 0, y: 0, zoom: ZOOM };
  const renderer = {
    lastStats: { lod: 'detail', visitedCells: 0, drawnCells: 0, drawnBackstitches: 0, baseRendered: false, overlayRendered: false } as RenderStats,
    getDocument: () => undefined,
    getViewport: () => viewport,
    getStyle: () => ({}) as RendererStyle,
    getTraceImage: () => undefined,
    setDocument: () => undefined,
    setViewport: (next: Viewport) => { viewport = next; },
    setMetrics: () => undefined,
    setStyle: () => undefined,
    setTraceImage: () => undefined,
    setOverlay: () => undefined,
    invalidate: () => undefined,
    requestRender: () => undefined,
    render: () => renderer.lastStats,
    renderNow: () => renderer.lastStats,
    getLastInvalidation: () => ({ base: false, overlay: false, reasons: [] }),
    dispose: () => undefined,
    destroy: () => undefined
  } as unknown as CanvasRenderer;
  return renderer;
}

/** A single-surface 10x10 workspace with the Select tool's given shape. */
function fixture(shape?: 'rectangle' | 'oval') {
  const editor = createEditor(createDocument({ width: 10, height: 10, catalog: DEFAULT_CATALOG_DEFINITION.association, palette: [{ id: 1, name: 'Red', color: '#d33' }] }));
  const listeners = new Set<() => void>();
  const boundary: WorkspaceEditorBoundary = {
    activeProjectId: 'project-a',
    get document() { return editor.document; },
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    execute: (command) => editor.execute(command),
    executeBatch: (commands) => editor.executeBatch(commands),
    undo: () => editor.undo(),
    redo: () => editor.redo()
  };
  const uiStore = createUiStore({ viewport: { x: 0, y: 0, zoom: ZOOM } });
  const controller = new EditorSurfaceController({ gateway: createWorkspaceEditorGateway(boundary), uiStore, renderer: rendererFixture(), metrics: getCanvasMetrics(320, 320) });
  controller.start();
  controller.setTool(shape ? { tool: 'select', shape } : { tool: 'select' });
  return { controller, uiStore };
}

function at(pointerId: number, x: number, y: number): PointerSample {
  return { pointerId, pointerType: 'mouse', screenX: (x + 0.5) * ZOOM, screenY: (y + 0.5) * ZOOM, button: 0, buttons: 1, isPrimary: true };
}

function drag(controller: EditorSurfaceController, pointerId: number, from: ModelPoint, to: ModelPoint): void {
  controller.handlePointerDown(at(pointerId, from.x, from.y));
  controller.handlePointerMove(at(pointerId, to.x, to.y));
  controller.handlePointerUp(at(pointerId, to.x, to.y));
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
    drag(controller, 1, { x: 1, y: 1 }, { x: 5, y: 3 });
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
    drag(controller, 1, { x: 1, y: 1 }, { x: 5, y: 3 });
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
    drag(controller, 1, { x: 1, y: 1 }, { x: 3, y: 2 });
    expect(controller.setTool({ tool: 'select', shape: 'oval' })).toBe(true);
    expect(uiStore.getState().tool).toEqual({ tool: 'select', shape: 'oval' });
    expect(controller.getSelection()).toEqual({ x: 1, y: 1, width: 3, height: 2 });
    drag(controller, 2, { x: 0, y: 0 }, { x: 4, y: 2 });
    expect(controller.setTool({ tool: 'select' })).toBe(true);
    expect(uiStore.getState().tool).toEqual({ tool: 'select' });
    expect(Array.from(controller.getSelectionIndices() ?? [])).toEqual(indicesOf(rasterizeFilledOval({ x: 0, y: 0 }, { x: 4, y: 2 }), 10));
    controller.dispose();
  });
});
