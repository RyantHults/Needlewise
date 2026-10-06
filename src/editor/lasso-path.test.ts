import { describe, expect, it } from 'vitest';
import { createDocument, createEditor, createLayeredDocument, flattenDocument } from '../domain';
import { DEFAULT_CATALOG_DEFINITION } from '../catalog';
import type { CanvasCellSet, CanvasRenderer, LassoPathOverlay, ModelPoint, RenderStats, RendererStyle, Viewport } from './contracts';
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
  controller.setTool({ tool: 'lasso' });
  return { controller, uiStore };
}

/** A single-surface 10x10 workspace with the lasso selected. */
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

/** A 10x10 layered workspace with the Canvas layer selected; lasso selection never commits. */
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
  result.controller.setTool({ tool: 'lasso' });
  return result;
}

/** A pointer sample at a model point under the fixture's fixed viewport. */
function sample(pointerId: number, point: ModelPoint, extra: Partial<PointerSample> = {}): PointerSample {
  return { pointerId, pointerType: 'mouse', screenX: point.x * ZOOM, screenY: point.y * ZOOM, button: 0, buttons: 1, isPrimary: true, ...extra };
}

function click(controller: EditorSurfaceController, pointerId: number, point: ModelPoint, extra: Partial<PointerSample> = {}): void {
  controller.handlePointerDown(sample(pointerId, point, extra));
  controller.handlePointerUp(sample(pointerId, point, { ...extra, buttons: 0 }));
}

function clickAll(controller: EditorSurfaceController, points: readonly ModelPoint[], extra: Partial<PointerSample> = {}): void {
  points.forEach((point, index) => click(controller, index + 1, point, index === 0 ? extra : {}));
}

/** Press on the first point, move through the rest, and release on the last. */
function drag(controller: EditorSurfaceController, pointerId: number, points: readonly ModelPoint[], extra: Partial<PointerSample> = {}): void {
  controller.handlePointerDown(sample(pointerId, points[0], extra));
  for (const point of points.slice(1)) controller.handlePointerMove(sample(pointerId, point, extra));
  controller.handlePointerUp(sample(pointerId, points[points.length - 1], { ...extra, buttons: 0 }));
}

function key(controller: EditorSurfaceController, name: string): void {
  controller.handleKeyDown({ key: name, preventDefault: () => undefined });
}

function lassoPath(uiStore: ReturnType<typeof createUiStore>): LassoPathOverlay | null | undefined {
  const path = uiStore.getState().overlay.lassoPath;
  if (path && !('points' in path)) throw new Error('The lasso publishes its path as an overlay object.');
  return path;
}

function lassoPoints(uiStore: ReturnType<typeof createUiStore>): readonly ModelPoint[] | undefined {
  return lassoPath(uiStore)?.points;
}

/** The preview's captured cells as sorted "x,y" keys. */
function previewCells(uiStore: ReturnType<typeof createUiStore>): string[] | undefined {
  const preview = lassoPath(uiStore)?.preview;
  if (!preview) return undefined;
  const cells: string[] = [];
  for (const run of preview.runs) for (let x = run.x; x < run.x + run.width; x += 1) cells.push(`${String(x)},${String(run.y)}`);
  return cells.sort();
}

/** The stitch selection's cells as sorted "x,y" keys, for the 10-wide fixture. */
function selectionCells(controller: EditorSurfaceController): string[] {
  return Array.from(controller.getSelectionIndices() ?? [], (index) => `${String(index % 10)},${String(Math.floor(index / 10))}`).sort();
}

/** A canvas cell set's cells as sorted "x,y" keys in model space. */
function canvasCells(selection: CanvasCellSet | undefined): string[] {
  if (!selection) return [];
  const { rect, cells } = selection;
  const keys: string[] = [];
  for (let y = 0; y < rect.height; y += 1) {
    for (let x = 0; x < rect.width; x += 1) {
      if (!cells || cells[y * rect.width + x] === 1) keys.push(`${String(rect.x + x)},${String(rect.y + y)}`);
    }
  }
  return keys.sort();
}

describe('lasso on a stitch layer', () => {
  it('adds a vertex per click and closes on a click on the start dot', () => {
    const { controller, uiStore } = fixture();
    clickAll(controller, SQUARE);
    expect(lassoPoints(uiStore)).toEqual(SQUARE);
    expect(lassoPath(uiStore)?.start).toEqual(SQUARE[0]);
    expect(controller.getSelection()).toBeUndefined();
    // Within 10 screen pixels of the first vertex.
    click(controller, 9, { x: 1.4, y: 1.4 });
    expect(controller.getSelection()).toEqual({ x: 1, y: 1, width: 4, height: 4 });
    expect(controller.getSelectionIndices()).toHaveLength(16);
    expect(lassoPath(uiStore)).toBeUndefined();
    controller.dispose();
  });

  it('draws freehand points with a drag and leaves the path open', () => {
    const { controller, uiStore } = fixture();
    controller.handlePointerDown(sample(1, SQUARE[0]));
    expect(lassoPath(uiStore)).toMatchObject({ points: [SQUARE[0]], start: SQUARE[0] });
    controller.handlePointerMove(sample(1, SQUARE[1]));
    controller.handlePointerMove(sample(1, SQUARE[2]));
    expect(lassoPoints(uiStore)).toEqual(SQUARE.slice(0, 3));
    controller.handlePointerMove(sample(1, SQUARE[3]));
    controller.handlePointerUp(sample(1, SQUARE[3], { buttons: 0 }));
    expect(lassoPoints(uiStore)).toEqual(SQUARE);
    expect(controller.getSelection()).toBeUndefined();
    key(controller, 'Enter');
    expect(controller.getSelection()).toEqual({ x: 1, y: 1, width: 4, height: 4 });
    expect(lassoPath(uiStore)).toBeUndefined();
    controller.dispose();
  });

  it('mixes clicks and drags in one path', () => {
    const { controller, uiStore } = fixture();
    click(controller, 1, SQUARE[0]);
    drag(controller, 2, [SQUARE[1], SQUARE[2]]);
    click(controller, 3, SQUARE[3]);
    expect(lassoPoints(uiStore)).toEqual(SQUARE);
    click(controller, 4, SQUARE[0]);
    expect(controller.getSelection()).toEqual({ x: 1, y: 1, width: 4, height: 4 });
    expect(lassoPath(uiStore)).toBeUndefined();
    controller.dispose();
  });

  it('closes when a drag is released on the start dot', () => {
    const whole = fixture();
    drag(whole.controller, 1, [...SQUARE, SQUARE[0]]);
    expect(whole.controller.getSelection()).toEqual({ x: 1, y: 1, width: 4, height: 4 });
    expect(lassoPath(whole.uiStore)).toBeUndefined();
    whole.controller.dispose();

    const later = fixture();
    click(later.controller, 1, SQUARE[0]);
    drag(later.controller, 2, [SQUARE[1], SQUARE[2], SQUARE[3], { x: 1.2, y: 1.2 }]);
    expect(later.controller.getSelection()).toEqual({ x: 1, y: 1, width: 4, height: 4 });
    expect(lassoPath(later.uiStore)).toBeUndefined();
    later.controller.dispose();
  });

  it('cancels on a press on the start dot while the path has fewer than three vertices, keeping the selection', () => {
    const one = fixture();
    one.controller.setSelection({ x: 8, y: 8 });
    click(one.controller, 1, SQUARE[0]);
    click(one.controller, 2, { x: 1.2, y: 1.2 });
    expect(lassoPath(one.uiStore)).toBeUndefined();
    expect(one.controller.getSelection()).toEqual({ x: 8, y: 8, width: 1, height: 1 });
    // The next press starts a new path.
    click(one.controller, 3, SQUARE[1]);
    expect(lassoPath(one.uiStore)).toMatchObject({ points: [SQUARE[1]], start: SQUARE[1] });
    one.controller.dispose();

    const two = fixture();
    two.controller.setSelection({ x: 8, y: 8 });
    clickAll(two.controller, [SQUARE[0], SQUARE[1], { x: 1.2, y: 1.2 }]);
    expect(lassoPath(two.uiStore)).toBeUndefined();
    expect(two.controller.getSelection()).toEqual({ x: 8, y: 8, width: 1, height: 1 });
    two.controller.dispose();
  });

  it('cancels a one-vertex path on Escape, keeping the selection until a second Escape', () => {
    const { controller, uiStore } = fixture();
    controller.setSelection({ x: 8, y: 8 });
    click(controller, 1, SQUARE[0]);
    expect(lassoPath(uiStore)).toBeDefined();
    key(controller, 'Escape');
    expect(lassoPath(uiStore)).toBeUndefined();
    expect(controller.getSelection()).toEqual({ x: 8, y: 8, width: 1, height: 1 });
    key(controller, 'Escape');
    expect(controller.getSelection()).toBeUndefined();
    controller.dispose();
  });

  it('discards a path of fewer than three distinct vertices on Enter', () => {
    const { controller, uiStore } = fixture();
    controller.setSelection({ x: 8, y: 8 });
    clickAll(controller, [SQUARE[0], SQUARE[1], SQUARE[1]]);
    key(controller, 'Enter');
    expect(controller.getSelection()).toEqual({ x: 8, y: 8, width: 1, height: 1 });
    expect(lassoPath(uiStore)).toBeUndefined();
    controller.dispose();
  });

  it('cancels on Escape, keeping the previous selection until a second Escape', () => {
    const { controller, uiStore } = fixture();
    controller.setSelection({ x: 8, y: 8 });
    clickAll(controller, SQUARE);
    key(controller, 'Escape');
    expect(lassoPath(uiStore)).toBeUndefined();
    expect(controller.getSelection()).toEqual({ x: 8, y: 8, width: 1, height: 1 });
    key(controller, 'Enter');
    expect(controller.getSelection()).toEqual({ x: 8, y: 8, width: 1, height: 1 });
    key(controller, 'Escape');
    expect(controller.getSelection()).toBeUndefined();
    controller.dispose();
  });

  it('removes the last stroke on Backspace and cancels when none remain', () => {
    const { controller, uiStore } = fixture();
    click(controller, 1, SQUARE[0]);
    drag(controller, 2, [SQUARE[1], { x: 8, y: 2 }, { x: 9, y: 9 }]);
    expect(lassoPoints(uiStore)).toEqual([SQUARE[0], SQUARE[1], { x: 8, y: 2 }, { x: 9, y: 9 }]);
    // The whole drag goes at once, not just its last point.
    key(controller, 'Backspace');
    expect(lassoPoints(uiStore)).toEqual([SQUARE[0]]);
    expect(lassoPath(uiStore)?.start).toEqual(SQUARE[0]);
    clickAll(controller, SQUARE.slice(1));
    key(controller, 'Enter');
    expect(controller.getSelection()).toEqual({ x: 1, y: 1, width: 4, height: 4 });

    click(controller, 5, { x: 7, y: 7 });
    key(controller, 'Backspace');
    expect(lassoPath(uiStore)).toBeUndefined();
    // Backspace with no path deletes the selection as before, rather than touching a path.
    key(controller, 'Enter');
    expect(controller.getSelection()).toEqual({ x: 1, y: 1, width: 4, height: 4 });
    controller.dispose();
  });

  it('takes Shift and Alt from the first press only', () => {
    const { controller } = fixture();
    controller.setSelection({ x: 8, y: 8 });
    clickAll(controller, SQUARE, { shiftKey: true });
    key(controller, 'Enter');
    expect(controller.getSelectionIndices()).toHaveLength(17);
    expect(controller.getSelection()).toEqual({ x: 1, y: 1, width: 8, height: 8 });

    controller.setSelection({ x: 1, y: 1 }, { x: 4, y: 4 });
    clickAll(controller, [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 6 }, { x: 0, y: 6 }], { altKey: true });
    key(controller, 'Enter');
    expect(controller.getSelection()).toEqual({ x: 3, y: 1, width: 2, height: 4 });

    // Modifiers on later presses change nothing: this lasso replaces the selection.
    controller.setSelection({ x: 8, y: 8 });
    click(controller, 1, SQUARE[0]);
    SQUARE.slice(1).forEach((point, index) => click(controller, index + 2, point, { shiftKey: true }));
    click(controller, 9, SQUARE[0], { altKey: true });
    expect(controller.getSelection()).toEqual({ x: 1, y: 1, width: 4, height: 4 });
    expect(controller.getSelectionIndices()).toHaveLength(16);
    controller.dispose();
  });

  it('marks the start dot closable on hover with a single vertex', () => {
    const { controller, uiStore } = fixture();
    click(controller, 1, SQUARE[0]);
    controller.handlePointerMove(sample(1, { x: 3, y: 3 }, { buttons: 0 }));
    expect(lassoPath(uiStore)?.closable).toBeFalsy();
    controller.handlePointerMove(sample(1, { x: 1.3, y: 1.3 }, { buttons: 0 }));
    expect(lassoPath(uiStore)).toMatchObject({ start: SQUARE[0], closable: true });
    controller.dispose();
  });

  it('previews the hovering pointer and marks the start dot closable', () => {
    const { controller, uiStore } = fixture();
    clickAll(controller, [SQUARE[0], SQUARE[1]]);
    controller.handlePointerMove(sample(1, { x: 5, y: 6 }, { buttons: 0 }));
    expect(lassoPoints(uiStore)).toEqual([SQUARE[0], SQUARE[1], { x: 5, y: 6 }]);
    expect(lassoPath(uiStore)?.start).toEqual(SQUARE[0]);
    expect(lassoPath(uiStore)?.closable).toBeFalsy();
    // On the start dot a click cancels a short path, so the dot is closable at any vertex count.
    controller.handlePointerMove(sample(1, { x: 1.3, y: 1.3 }, { buttons: 0 }));
    expect(lassoPath(uiStore)?.closable).toBe(true);

    click(controller, 3, SQUARE[2]);
    controller.handlePointerMove(sample(1, { x: 1.3, y: 1.3 }, { buttons: 0 }));
    expect(lassoPoints(uiStore)).toEqual([SQUARE[0], SQUARE[1], SQUARE[2], { x: 1.3, y: 1.3 }]);
    expect(lassoPath(uiStore)?.closable).toBe(true);
    controller.handlePointerMove(sample(1, { x: 3, y: 3 }, { buttons: 0 }));
    expect(lassoPath(uiStore)?.closable).toBeFalsy();

    // A stroke whose latest point reaches the start dot is closable too.
    controller.handlePointerDown(sample(4, SQUARE[3]));
    controller.handlePointerMove(sample(4, { x: 1.2, y: 1.2 }));
    expect(lassoPath(uiStore)?.closable).toBe(true);
    controller.handlePointerUp(sample(4, { x: 1.2, y: 1.2 }, { buttons: 0 }));
    expect(controller.getSelection()).toEqual({ x: 1, y: 1, width: 4, height: 4 });
    controller.dispose();
  });

  it('adds a vertex for a touch tap and draws with a touch drag', () => {
    const { controller, uiStore } = fixture();
    const touch = { pointerType: 'touch' } as const;
    const viewport = uiStore.getState().viewport;
    controller.handlePointerDown(sample(1, SQUARE[0], touch));
    expect(lassoPoints(uiStore)).toEqual([SQUARE[0]]);
    controller.handlePointerUp(sample(1, SQUARE[0], { ...touch, buttons: 0 }));
    expect(lassoPoints(uiStore)).toEqual([SQUARE[0]]);

    drag(controller, 2, [SQUARE[1], SQUARE[2], SQUARE[3]], touch);
    expect(lassoPoints(uiStore)).toEqual(SQUARE);
    expect(uiStore.getState().viewport).toEqual(viewport);
    click(controller, 3, SQUARE[0], touch);
    expect(controller.getSelection()).toEqual({ x: 1, y: 1, width: 4, height: 4 });
    controller.dispose();
  });

  it('reverts the current touch stroke when a second finger lands, keeping the path through the pinch', () => {
    const { controller, uiStore } = fixture();
    const touch = { pointerType: 'touch' } as const;
    drag(controller, 1, [SQUARE[0], SQUARE[1]], touch);
    click(controller, 2, SQUARE[2], touch);
    const viewport = uiStore.getState().viewport;

    controller.handlePointerDown(sample(3, SQUARE[3], touch));
    controller.handlePointerMove(sample(3, { x: 2, y: 7 }, touch));
    expect(lassoPoints(uiStore)).toEqual([...SQUARE.slice(0, 3), SQUARE[3], { x: 2, y: 7 }]);
    controller.handlePointerDown(sample(4, { x: 8, y: 8 }, touch));
    expect(lassoPoints(uiStore)).toEqual(SQUARE.slice(0, 3));
    controller.handlePointerMove(sample(4, { x: 9, y: 9 }, touch));
    expect(uiStore.getState().viewport).not.toEqual(viewport);
    controller.handlePointerUp(sample(4, { x: 9, y: 9 }, { ...touch, buttons: 0 }));
    controller.handlePointerUp(sample(3, { x: 2, y: 7 }, { ...touch, buttons: 0 }));
    expect(lassoPoints(uiStore)).toEqual(SQUARE.slice(0, 3));
    expect(controller.getSelection()).toBeUndefined();
    key(controller, 'Enter');
    expect(controller.getSelectionIndices()?.length).toBeGreaterThan(0);
    controller.dispose();
  });

  it('cancels the path when a second finger reverts its only stroke', () => {
    const { controller, uiStore } = fixture();
    const touch = { pointerType: 'touch' } as const;
    controller.handlePointerDown(sample(1, SQUARE[0], touch));
    controller.handlePointerMove(sample(1, SQUARE[1], touch));
    controller.handlePointerDown(sample(2, SQUARE[2], touch));
    expect(lassoPath(uiStore)).toBeUndefined();
    controller.handlePointerUp(sample(2, SQUARE[2], { ...touch, buttons: 0 }));
    controller.handlePointerUp(sample(1, SQUARE[1], { ...touch, buttons: 0 }));
    expect(lassoPath(uiStore)).toBeUndefined();
    expect(controller.getSelection()).toBeUndefined();
    controller.dispose();
  });

  it('only pans with a finger in movement-only touch mode', () => {
    const { controller, uiStore } = fixture();
    controller.setTouchMovementOnly(true);
    const viewport = uiStore.getState().viewport;
    drag(controller, 1, [SQUARE[0], SQUARE[2]], { pointerType: 'touch' });
    expect(uiStore.getState().viewport).not.toEqual(viewport);
    expect(lassoPath(uiStore)).toBeUndefined();
    controller.dispose();
  });

  it('treats a press inside the selection like any other press', () => {
    const clicked = fixture();
    clicked.controller.setSelection({ x: 1, y: 1 }, { x: 4, y: 4 });
    click(clicked.controller, 1, { x: 2.5, y: 2.5 });
    expect(lassoPath(clicked.uiStore)).toMatchObject({ points: [{ x: 2.5, y: 2.5 }], start: { x: 2.5, y: 2.5 } });
    click(clicked.controller, 2, { x: 3, y: 2 });
    expect(lassoPoints(clicked.uiStore)).toEqual([{ x: 2.5, y: 2.5 }, { x: 3, y: 2 }]);
    expect(clicked.controller.getSelection()).toEqual({ x: 1, y: 1, width: 4, height: 4 });
    clicked.controller.dispose();

    for (const pointerType of ['mouse', 'pen', 'touch'] as const) {
      const dragged = fixture();
      dragged.controller.setSelection({ x: 1, y: 1 }, { x: 4, y: 4 });
      drag(dragged.controller, 1, [{ x: 2.5, y: 2.5 }, { x: 8, y: 8 }], { pointerType });
      expect(lassoPath(dragged.uiStore)).toMatchObject({ points: [{ x: 2.5, y: 2.5 }, { x: 8, y: 8 }], start: { x: 2.5, y: 2.5 } });
      expect(dragged.controller.getSelection()).toEqual({ x: 1, y: 1, width: 4, height: 4 });
      dragged.controller.dispose();
    }
  });

  it('cancels when the tool changes', () => {
    const { controller, uiStore } = fixture();
    clickAll(controller, SQUARE);
    controller.setTool({ tool: 'select' });
    expect(lassoPath(uiStore)).toBeUndefined();
    key(controller, 'Enter');
    expect(controller.getSelection()).toBeUndefined();
    controller.dispose();
  });
});

describe('lasso on the Canvas layer', () => {
  it('selects the lasso as a canvas cell set, including cells beyond the canvas', () => {
    const { controller, uiStore } = canvasFixture();
    const corners = [{ x: -2, y: -2 }, { x: 2, y: -2 }, { x: 2, y: 2 }, { x: -2, y: 2 }];
    clickAll(controller, corners);
    expect(controller.getCanvasSelection()).toBeUndefined();
    expect(lassoPath(uiStore)).toMatchObject({ points: corners, start: corners[0] });
    click(controller, 9, corners[0]);
    const selection = controller.getCanvasSelection();
    expect(selection?.rect).toEqual({ x: -2, y: -2, width: 4, height: 4 });
    expect(Array.from(selection?.cells ?? [])).toEqual(Array<number>(16).fill(1));
    expect(uiStore.getState().overlay.canvasEditing?.selection).toEqual(selection);
    expect(lassoPath(uiStore)).toBeUndefined();
    controller.dispose();
  });

  it('mixes a drag and clicks, and closes on Enter', () => {
    const { controller, uiStore } = canvasFixture();
    drag(controller, 1, [SQUARE[0], SQUARE[1], SQUARE[2]]);
    click(controller, 2, SQUARE[3]);
    expect(lassoPoints(uiStore)).toEqual(SQUARE);
    key(controller, 'Enter');
    expect(controller.getCanvasSelection()?.rect).toEqual({ x: 1, y: 1, width: 4, height: 4 });
    expect(lassoPath(uiStore)).toBeUndefined();
    controller.dispose();
  });

  it('cancels when crop mode turns off', () => {
    const { controller, uiStore } = canvasFixture();
    clickAll(controller, SQUARE);
    controller.setCanvasCropActive(false);
    expect(lassoPath(uiStore)).toBeUndefined();
    controller.dispose();
  });
});

describe('lasso capture preview', () => {
  it('shows no preview with fewer than three points', () => {
    const { controller, uiStore } = fixture();
    click(controller, 1, SQUARE[0]);
    expect(lassoPath(uiStore)?.preview).toBeUndefined();
    click(controller, 2, SQUARE[1]);
    expect(lassoPath(uiStore)).toBeDefined();
    expect(lassoPath(uiStore)?.preview).toBeUndefined();
    controller.dispose();
  });

  it('previews exactly the cells that closing at the hovered point selects', () => {
    const { controller, uiStore } = fixture();
    clickAll(controller, SQUARE.slice(0, 3));
    controller.handlePointerMove(sample(1, SQUARE[3], { buttons: 0 }));
    const preview = previewCells(uiStore);
    expect(preview).toHaveLength(16);
    expect(lassoPath(uiStore)?.preview?.boundaries.length).toBeGreaterThan(0);
    click(controller, 4, SQUARE[3]);
    key(controller, 'Enter');
    expect(selectionCells(controller)).toEqual(preview);
    controller.dispose();
  });

  it('updates the preview as a freehand stroke moves', () => {
    const { controller, uiStore } = fixture();
    controller.handlePointerDown(sample(1, SQUARE[0]));
    controller.handlePointerMove(sample(1, SQUARE[1]));
    expect(lassoPath(uiStore)?.preview).toBeUndefined();
    controller.handlePointerMove(sample(1, SQUARE[2]));
    const triangle = previewCells(uiStore);
    expect(triangle?.length).toBeGreaterThan(0);
    controller.handlePointerMove(sample(1, SQUARE[3]));
    const square = previewCells(uiStore);
    expect(square).toHaveLength(16);
    expect(square).not.toEqual(triangle);
    controller.handlePointerUp(sample(1, SQUARE[3], { buttons: 0 }));
    expect(previewCells(uiStore)).toEqual(square);
    key(controller, 'Enter');
    expect(selectionCells(controller)).toEqual(square);
    controller.dispose();
  });

  it('clears the preview on close, on cancel, and when Backspace leaves fewer than three points', () => {
    const closed = fixture();
    clickAll(closed.controller, SQUARE);
    expect(lassoPath(closed.uiStore)?.preview).toBeDefined();
    click(closed.controller, 9, SQUARE[0]);
    expect(lassoPath(closed.uiStore)).toBeUndefined();
    closed.controller.dispose();

    const cancelled = fixture();
    clickAll(cancelled.controller, SQUARE);
    expect(lassoPath(cancelled.uiStore)?.preview).toBeDefined();
    key(cancelled.controller, 'Escape');
    expect(lassoPath(cancelled.uiStore)).toBeUndefined();
    cancelled.controller.dispose();

    const shortened = fixture();
    clickAll(shortened.controller, SQUARE.slice(0, 3));
    expect(lassoPath(shortened.uiStore)?.preview).toBeDefined();
    key(shortened.controller, 'Backspace');
    expect(lassoPoints(shortened.uiStore)).toEqual(SQUARE.slice(0, 2));
    expect(lassoPath(shortened.uiStore)?.preview).toBeUndefined();
    shortened.controller.dispose();
  });

  it('gives a fresh preview for a new stroke after Backspace, even with the same point count and closing point', () => {
    const { controller, uiStore } = fixture();
    click(controller, 1, SQUARE[0]);
    drag(controller, 2, [SQUARE[1], { x: 8, y: 2 }, { x: 9, y: 9 }]);
    expect(lassoPoints(uiStore)).toHaveLength(4);
    const first = previewCells(uiStore);
    expect(first?.length).toBeGreaterThan(0);
    key(controller, 'Backspace');
    expect(lassoPath(uiStore)?.preview).toBeUndefined();

    drag(controller, 3, [{ x: 2, y: 8 }, { x: 6, y: 6 }, { x: 9, y: 9 }]);
    expect(lassoPoints(uiStore)).toHaveLength(4);
    const second = previewCells(uiStore);
    expect(second?.length).toBeGreaterThan(0);
    expect(second).not.toEqual(first);
    key(controller, 'Enter');
    expect(selectionCells(controller)).toEqual(second);
    controller.dispose();
  });

  it('places Canvas-layer preview runs in model space, beyond the canvas', () => {
    const { controller, uiStore } = canvasFixture();
    const corners = [{ x: -2, y: -2 }, { x: 2, y: -2 }, { x: 2, y: 2 }, { x: -2, y: 2 }];
    clickAll(controller, corners.slice(0, 3));
    controller.handlePointerMove(sample(1, corners[3], { buttons: 0 }));
    const preview = previewCells(uiStore);
    expect(preview).toHaveLength(16);
    expect(preview).toContain('-2,-2');
    expect(preview).toContain('1,1');
    click(controller, 4, corners[3]);
    key(controller, 'Enter');
    expect(canvasCells(controller.getCanvasSelection())).toEqual(preview);
    controller.dispose();
  });
});

describe('lasso anchors', () => {
  it('places one anchor per click', () => {
    const { controller, uiStore } = fixture();
    clickAll(controller, SQUARE.slice(0, 3));
    expect(lassoPath(uiStore)?.anchors).toEqual(SQUARE.slice(0, 3));
    controller.dispose();
  });

  it('anchors a drag at its press point only, while its points still grow', () => {
    const { controller, uiStore } = fixture();
    click(controller, 1, SQUARE[0]);
    controller.handlePointerDown(sample(2, SQUARE[1]));
    expect(lassoPath(uiStore)?.anchors).toEqual([SQUARE[0], SQUARE[1]]);
    controller.handlePointerMove(sample(2, { x: 8, y: 2 }));
    controller.handlePointerMove(sample(2, { x: 9, y: 9 }));
    controller.handlePointerUp(sample(2, { x: 9, y: 9 }, { buttons: 0 }));
    expect(lassoPoints(uiStore)).toEqual([SQUARE[0], SQUARE[1], { x: 8, y: 2 }, { x: 9, y: 9 }]);
    expect(lassoPath(uiStore)?.anchors).toEqual([SQUARE[0], SQUARE[1]]);
    click(controller, 3, SQUARE[3]);
    expect(lassoPath(uiStore)?.anchors).toEqual([SQUARE[0], SQUARE[1], SQUARE[3]]);
    controller.dispose();
  });

  it('drops the last anchor on Backspace', () => {
    const { controller, uiStore } = fixture();
    click(controller, 1, SQUARE[0]);
    drag(controller, 2, [SQUARE[1], { x: 8, y: 2 }, { x: 9, y: 9 }]);
    click(controller, 3, SQUARE[3]);
    key(controller, 'Backspace');
    expect(lassoPath(uiStore)?.anchors).toEqual([SQUARE[0], SQUARE[1]]);
    key(controller, 'Backspace');
    expect(lassoPath(uiStore)?.anchors).toEqual([SQUARE[0]]);
    controller.dispose();
  });

  it('clears the anchors on close and on cancel', () => {
    const closed = fixture();
    clickAll(closed.controller, SQUARE);
    expect(lassoPath(closed.uiStore)?.anchors).toEqual(SQUARE);
    click(closed.controller, 9, SQUARE[0]);
    expect(lassoPath(closed.uiStore)).toBeUndefined();
    closed.controller.dispose();

    const cancelled = fixture();
    clickAll(cancelled.controller, SQUARE);
    key(cancelled.controller, 'Escape');
    expect(lassoPath(cancelled.uiStore)).toBeUndefined();
    cancelled.controller.dispose();
  });

  it('anchors clicks and drag presses the same way on the Canvas layer', () => {
    const { controller, uiStore } = canvasFixture();
    const corners = [{ x: -2, y: -2 }, { x: 2, y: -2 }, { x: 2, y: 2 }, { x: -2, y: 2 }];
    click(controller, 1, corners[0]);
    drag(controller, 2, [corners[1], { x: 3, y: 0 }, corners[2]]);
    click(controller, 3, corners[3]);
    expect(lassoPoints(uiStore)).toEqual([corners[0], corners[1], { x: 3, y: 0 }, corners[2], corners[3]]);
    expect(lassoPath(uiStore)?.anchors).toEqual([corners[0], corners[1], corners[3]]);
    key(controller, 'Backspace');
    expect(lassoPath(uiStore)?.anchors).toEqual([corners[0], corners[1]]);
    key(controller, 'Escape');
    expect(lassoPath(uiStore)).toBeUndefined();
    controller.dispose();
  });
});
