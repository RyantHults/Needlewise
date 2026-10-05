import { describe, expect, it } from 'vitest';
import { createDocument, createEditor, createLayeredDocument, flattenDocument } from '../domain';
import { DEFAULT_CATALOG_DEFINITION } from '../catalog';
import type { CanvasRenderer, ModelPoint, RenderStats, RendererStyle, Viewport } from './contracts';
import { getCanvasMetrics } from './coordinates';
import { EditorSurfaceController } from './controller';
import { createWorkspaceEditorGateway, type WorkspaceEditorBoundary } from './gateway';
import type { PointerSample } from './input';
import { createUiStore } from './ui-store';

const ZOOM = 16;
/** Square vertices on cell corners, enclosing cells x, y in 1..4. */
const SQUARE: readonly ModelPoint[] = [{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 5, y: 5 }, { x: 1, y: 5 }];

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

function start(boundary: WorkspaceEditorBoundary) {
  const uiStore = createUiStore({ viewport: { x: 0, y: 0, zoom: ZOOM } });
  const controller = new EditorSurfaceController({ gateway: createWorkspaceEditorGateway(boundary), uiStore, renderer: rendererFixture(), metrics: getCanvasMetrics(320, 320) });
  controller.start();
  controller.setTool({ tool: 'lasso', shape: 'polygon' });
  return { controller, uiStore };
}

/** A single-surface 10x10 workspace with the polygon lasso selected. */
function fixture() {
  const editor = createEditor(createDocument({ width: 10, height: 10, catalog: DEFAULT_CATALOG_DEFINITION.association, palette: [{ id: 1, name: 'Red', color: '#d33' }] }));
  const listeners = new Set<() => void>();
  return start({
    activeProjectId: 'project-a',
    get document() { return editor.document; },
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    execute: (command) => editor.execute(command),
    executeBatch: (commands) => editor.executeBatch(commands),
    undo: () => editor.undo(),
    redo: () => editor.redo()
  });
}

/** A 10x10 layered workspace with the Canvas layer selected; polygon selection never commits. */
function canvasFixture() {
  const layered = createLayeredDocument({ width: 10, height: 10, catalog: DEFAULT_CATALOG_DEFINITION.association, palette: [{ id: 1, name: 'Red', color: '#d33', active: true }] });
  const unused = (): never => { throw new Error('unexpected command'); };
  const result = start({
    activeProjectId: 'project-a',
    layeredDocument: layered,
    document: flattenDocument(layered),
    activeLayerId: 'canvas',
    activeLayerSurface: () => null,
    subscribe: () => () => undefined,
    execute: unused,
    executeBatch: unused,
    undo: unused,
    redo: unused
  });
  result.controller.setCanvasCropActive(true);
  result.controller.setCanvasMode('advanced');
  result.controller.setTool({ tool: 'lasso', shape: 'polygon' });
  return result;
}

let clock = 0;

/** A pointer sample at a model point; each one is a second after the last, so presses are never double-clicks by accident. */
function sample(pointerId: number, point: ModelPoint, extra: Partial<PointerSample> = {}): PointerSample {
  clock += 1000;
  return { pointerId, pointerType: 'mouse', screenX: point.x * ZOOM, screenY: point.y * ZOOM, button: 0, buttons: 1, isPrimary: true, timeStamp: clock, ...extra };
}

function click(controller: EditorSurfaceController, pointerId: number, point: ModelPoint, extra: Partial<PointerSample> = {}): void {
  controller.handlePointerDown(sample(pointerId, point, extra));
  controller.handlePointerUp(sample(pointerId, point, { ...extra, buttons: 0 }));
}

function clickAll(controller: EditorSurfaceController, points: readonly ModelPoint[], extra: Partial<PointerSample> = {}): void {
  points.forEach((point, index) => click(controller, index + 1, point, index === 0 ? extra : {}));
}

function key(controller: EditorSurfaceController, name: string): void {
  controller.handleKeyDown({ key: name, preventDefault: () => undefined });
}

function lassoPoints(uiStore: ReturnType<typeof createUiStore>): readonly ModelPoint[] | undefined {
  const path = uiStore.getState().overlay.lassoPath;
  return path && 'points' in path ? path.points : undefined;
}

describe('polygon lasso on a stitch layer', () => {
  it('adds a vertex per click and closes on a click near the first vertex', () => {
    const { controller, uiStore } = fixture();
    clickAll(controller, SQUARE);
    expect(lassoPoints(uiStore)).toEqual(SQUARE);
    expect(controller.getSelection()).toBeUndefined();
    // Within 10 screen pixels of the first vertex.
    click(controller, 9, { x: 1.4, y: 1.4 });
    expect(controller.getSelection()).toEqual({ x: 1, y: 1, width: 4, height: 4 });
    expect(controller.getSelectionIndices()).toHaveLength(16);
    expect(uiStore.getState().overlay.lassoPath).toBeUndefined();
    controller.dispose();
  });

  it('closes on Enter and on a double-click', () => {
    const enter = fixture();
    clickAll(enter.controller, SQUARE);
    key(enter.controller, 'Enter');
    expect(enter.controller.getSelection()).toEqual({ x: 1, y: 1, width: 4, height: 4 });
    enter.controller.dispose();

    const double = fixture();
    clickAll(double.controller, SQUARE);
    // The last down was a second before the last up.
    const lastDown = clock - 1000;
    double.controller.handlePointerDown({ ...sample(9, SQUARE[3]), timeStamp: lastDown + 200 });
    expect(double.controller.getSelection()).toEqual({ x: 1, y: 1, width: 4, height: 4 });
    expect(double.uiStore.getState().overlay.lassoPath).toBeUndefined();
    double.controller.dispose();
  });

  it('discards a polygon of fewer than three distinct vertices', () => {
    const { controller, uiStore } = fixture();
    controller.setSelection({ x: 8, y: 8 });
    clickAll(controller, [SQUARE[0], SQUARE[1], SQUARE[1]]);
    key(controller, 'Enter');
    expect(controller.getSelection()).toEqual({ x: 8, y: 8, width: 1, height: 1 });
    expect(uiStore.getState().overlay.lassoPath).toBeUndefined();
    controller.dispose();
  });

  it('cancels on Escape, keeping the previous selection until a second Escape', () => {
    const { controller, uiStore } = fixture();
    controller.setSelection({ x: 8, y: 8 });
    clickAll(controller, SQUARE);
    key(controller, 'Escape');
    expect(uiStore.getState().overlay.lassoPath).toBeUndefined();
    expect(controller.getSelection()).toEqual({ x: 8, y: 8, width: 1, height: 1 });
    key(controller, 'Enter');
    expect(controller.getSelection()).toEqual({ x: 8, y: 8, width: 1, height: 1 });
    key(controller, 'Escape');
    expect(controller.getSelection()).toBeUndefined();
    controller.dispose();
  });

  it('removes the last vertex on Backspace and cancels when none remain', () => {
    const { controller, uiStore } = fixture();
    clickAll(controller, [SQUARE[0], SQUARE[1], { x: 9, y: 9 }]);
    key(controller, 'Backspace');
    expect(lassoPoints(uiStore)).toEqual([SQUARE[0], SQUARE[1]]);
    click(controller, 5, SQUARE[2]);
    click(controller, 6, SQUARE[3]);
    key(controller, 'Enter');
    expect(controller.getSelection()).toEqual({ x: 1, y: 1, width: 4, height: 4 });

    clickAll(controller, [{ x: 7, y: 7 }]);
    key(controller, 'Backspace');
    expect(uiStore.getState().overlay.lassoPath).toBeUndefined();
    // Backspace with no polygon deletes the selection as before, rather than touching a polygon.
    key(controller, 'Enter');
    expect(controller.getSelection()).toEqual({ x: 1, y: 1, width: 4, height: 4 });
    controller.dispose();
  });

  it('unions with Shift and subtracts with Alt on the first press', () => {
    const { controller, uiStore } = fixture();
    controller.setSelection({ x: 8, y: 8 });
    clickAll(controller, SQUARE, { shiftKey: true });
    key(controller, 'Enter');
    expect(controller.getSelectionIndices()).toHaveLength(17);
    expect(controller.getSelection()).toEqual({ x: 1, y: 1, width: 8, height: 8 });

    // Starting inside the selection adds a vertex rather than offering Copy.
    controller.setSelection({ x: 1, y: 1 }, { x: 4, y: 4 });
    clickAll(controller, [{ x: 1.5, y: 1.5 }, { x: 3, y: 0 }, { x: 3, y: 6 }, { x: 0, y: 6 }, { x: 0, y: 0 }], { altKey: true });
    key(controller, 'Enter');
    expect(controller.getSelection()).toEqual({ x: 3, y: 1, width: 2, height: 4 });
    expect(uiStore.getState().overlay.touchCopyRequest).toBeUndefined();
    controller.dispose();
  });

  it('previews the polygon closing from the hovering pointer', () => {
    const { controller, uiStore } = fixture();
    clickAll(controller, [SQUARE[0], SQUARE[1]]);
    controller.handlePointerMove(sample(1, { x: 5, y: 6 }, { buttons: 0 }));
    expect(lassoPoints(uiStore)).toEqual([SQUARE[0], SQUARE[1], { x: 5, y: 6 }]);
    controller.dispose();
  });

  it('adds a vertex for a touch tap but not for a one-finger pan', () => {
    const { controller, uiStore } = fixture();
    const touch = { pointerType: 'touch' } as const;
    controller.handlePointerDown(sample(1, SQUARE[0], touch));
    expect(uiStore.getState().overlay.lassoPath).toBeUndefined();
    controller.handlePointerUp(sample(1, SQUARE[0], touch));
    expect(lassoPoints(uiStore)).toEqual([SQUARE[0]]);

    const viewport = uiStore.getState().viewport;
    controller.handlePointerDown(sample(2, SQUARE[1], touch));
    controller.handlePointerMove(sample(2, { x: 2, y: 3 }, touch));
    controller.handlePointerUp(sample(2, { x: 2, y: 3 }, touch));
    expect(uiStore.getState().viewport).not.toEqual(viewport);
    expect(lassoPoints(uiStore)).toEqual([SQUARE[0]]);
    controller.dispose();
  });

  it('cancels when the tool or the lasso shape changes', () => {
    const { controller, uiStore } = fixture();
    clickAll(controller, SQUARE);
    controller.setTool({ tool: 'select' });
    expect(uiStore.getState().overlay.lassoPath).toBeUndefined();
    key(controller, 'Enter');
    expect(controller.getSelection()).toBeUndefined();

    controller.setTool({ tool: 'lasso', shape: 'polygon' });
    clickAll(controller, SQUARE);
    controller.setTool({ tool: 'lasso' });
    expect(uiStore.getState().overlay.lassoPath).toBeUndefined();
    key(controller, 'Enter');
    expect(controller.getSelection()).toBeUndefined();
    controller.dispose();
  });

  it('keeps the selection when switching between freehand and polygon', () => {
    const { controller, uiStore } = fixture();
    clickAll(controller, SQUARE);
    key(controller, 'Enter');
    expect(controller.setTool({ tool: 'lasso' })).toBe(true);
    expect(uiStore.getState().tool).toEqual({ tool: 'lasso' });
    expect(controller.getSelection()).toEqual({ x: 1, y: 1, width: 4, height: 4 });
    expect(controller.setTool({ tool: 'lasso', shape: 'polygon' })).toBe(true);
    expect(uiStore.getState().tool).toEqual({ tool: 'lasso', shape: 'polygon' });
    expect(controller.getSelection()).toEqual({ x: 1, y: 1, width: 4, height: 4 });
    controller.dispose();
  });
});

describe('polygon lasso on the Canvas layer', () => {
  it('selects the polygon as a canvas cell set, including cells beyond the canvas', () => {
    const { controller, uiStore } = canvasFixture();
    clickAll(controller, [{ x: -2, y: -2 }, { x: 2, y: -2 }, { x: 2, y: 2 }, { x: -2, y: 2 }]);
    expect(controller.getCanvasSelection()).toBeUndefined();
    key(controller, 'Enter');
    const selection = controller.getCanvasSelection();
    expect(selection?.rect).toEqual({ x: -2, y: -2, width: 4, height: 4 });
    expect(Array.from(selection?.cells ?? [])).toEqual(Array<number>(16).fill(1));
    expect(uiStore.getState().overlay.canvasEditing?.selection).toEqual(selection);
    expect(uiStore.getState().overlay.lassoPath).toBeUndefined();
    controller.dispose();
  });

  it('cancels when crop mode turns off', () => {
    const { controller, uiStore } = canvasFixture();
    clickAll(controller, SQUARE);
    controller.setCanvasCropActive(false);
    expect(uiStore.getState().overlay.lassoPath).toBeUndefined();
    controller.dispose();
  });
});
