import { beforeEach, describe, expect, it } from 'vitest';
import { clearClipboard } from './clipboard-store';
import {
  CellKind,
  layerSurface,
  type DomainCommand,
  type LayeredDocument
} from '../domain';
import { EditorSurfaceController } from './controller';
import { FOCUS_COLOR_PROTECTED_HINT } from './contracts';
import { getCanvasMetrics } from './coordinates';
import { createWorkspaceEditorGateway, type ActiveLayerId } from './gateway';
import { createUiStore } from './ui-store';
import { LayeredTestBoundary, at, layeredDocument, rendererFixture } from './test-support';
import { applyCommand, commitLayerSurface, cell } from '../domain/test-fixtures';




/** Apply a command straight to one layer, bypassing the editor, to arrange a test. */
function seed(document: LayeredDocument, layerId: number, command: DomainCommand): void {
  const result = applyCommand(layerSurface(document, layerId), command);
  commitLayerSurface(document, layerId, result.document);
}

function full(x: number, y: number, color: number): DomainCommand {
  return cell(8, { type: 'set-full', x, y, color });
}

function backstitch(x1: number, y1: number, x2: number, y2: number, color: number): DomainCommand {
  return { type: 'add-backstitch', start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, color };
}

/** Layer 1 is a stitch layer and layer 2 a specialty layer; Focus Color starts on with color 1 active. */
function fixture(document = layeredDocument(), activeLayerId: ActiveLayerId = 1) {
  const boundary = new LayeredTestBoundary(document, { activeLayerId });
  const gateway = createWorkspaceEditorGateway(boundary);
  const uiStore = createUiStore({ tool: { tool: 'paint', brush: { kind: 'full', paletteId: 1 } }, paletteId: 1 });
  const notices: string[] = [];
  const controller = new EditorSurfaceController({
    gateway,
    uiStore,
    renderer: rendererFixture().renderer,
    metrics: getCanvasMetrics(128, 128),
    onNotice: (message) => notices.push(message)
  });
  controller.start();
  controller.handleFocus();
  controller.setFocusColor(true);
  /** Color of the full stitch at (x, y) on the stitch layer; 0 when empty. */
  const colorAt = (x: number, y: number): number => {
    const surface = layerSurface(boundary.layeredDocument, 1);
    const index = y * surface.width + x;
    return surface.kind[index] === CellKind.Empty ? 0 : surface.colors[index * 4];
  };
  /** Colors of the specialty layer's backstitches, keyed by their start and end. */
  const backstitches = (): Record<string, number> => {
    const store = layerSurface(boundary.layeredDocument, 2).backstitches;
    return Object.fromEntries(Array.from(store.ids, (_, position) => [`${String(store.x1[position])},${String(store.y1[position])}-${String(store.x2[position])},${String(store.y2[position])}`, store.colors[position]]));
  };
  return { boundary, uiStore, controller, notices, colorAt, backstitches };
}


function drag(controller: EditorSurfaceController, cells: ReadonlyArray<readonly [number, number]>): void {
  const [first, ...rest] = cells;
  controller.handlePointerDown(at(1, first[0], first[1]));
  for (const [x, y] of rest) controller.handlePointerMove(at(1, x, y));
  const last = cells[cells.length - 1];
  controller.handlePointerUp(at(1, last[0], last[1]));
}

// The clipboard outlives controllers, so each case starts without one.
beforeEach(clearClipboard);

describe('Focus Color', () => {
  it('highlights the active color, follows palette changes and clears when turned off', () => {
    const { controller, uiStore } = fixture();
    expect(uiStore.getState()).toMatchObject({ focusColor: true, highlightColor: 1 });
    controller.selectPalette(2);
    expect(uiStore.getState().highlightColor).toBe(2);
    uiStore.setPaletteId(1);
    expect(uiStore.getState().highlightColor).toBe(1);
    controller.toggleFocusColor();
    expect(uiStore.getState()).toMatchObject({ focusColor: false, highlightColor: null });
    controller.selectPalette(2);
    expect(uiStore.getState().highlightColor).toBeNull();
    controller.dispose();
  });

  it('is never on in the read-only viewer', () => {
    const boundary = new LayeredTestBoundary(layeredDocument());
    const uiStore = createUiStore();
    const controller = new EditorSurfaceController({ gateway: createWorkspaceEditorGateway(boundary), uiStore, renderer: rendererFixture().renderer, readOnly: true });
    controller.start();
    controller.setHighlightColor(2);
    controller.toggleFocusColor();
    expect(uiStore.getState()).toMatchObject({ focusColor: false, highlightColor: 2 });
    controller.dispose();
  });

  it('paints empty and focus-color cells but skips other colors', () => {
    const document = layeredDocument();
    seed(document, 1, full(1, 0, 2));
    const { controller, colorAt, notices } = fixture(document);
    drag(controller, [[0, 0], [1, 0], [2, 0]]);
    expect([colorAt(0, 0), colorAt(1, 0), colorAt(2, 0)]).toEqual([1, 2, 1]);
    expect(notices).toEqual([]);

    drag(controller, [[1, 0]]);
    expect(colorAt(1, 0)).toBe(2);
    expect(notices).toEqual([FOCUS_COLOR_PROTECTED_HINT]);
    controller.dispose();
  });

  it('erases only focus-color cells', () => {
    const document = layeredDocument();
    seed(document, 1, full(0, 0, 1));
    seed(document, 1, full(1, 0, 2));
    const { controller, colorAt, notices } = fixture(document);
    controller.setTool({ tool: 'eraser' });
    drag(controller, [[0, 0], [1, 0]]);
    expect([colorAt(0, 0), colorAt(1, 0)]).toEqual([0, 2]);

    drag(controller, [[1, 0]]);
    expect(colorAt(1, 0)).toBe(2);
    expect(notices).toEqual([FOCUS_COLOR_PROTECTED_HINT]);
    controller.dispose();
  });

  it('blocks a fill that would recolor another color but fills empty regions', async () => {
    const document = layeredDocument();
    for (let y = 0; y < 8; y += 1) seed(document, 1, full(2, y, 2));
    const { boundary, controller, colorAt, notices } = fixture(document);
    controller.setTool({ tool: 'fill' });
    expect(controller.handlePointerDown(at(1, 2, 0))).toBe(true);
    for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
    expect(boundary.log).toEqual([]);
    expect(colorAt(2, 0)).toBe(2);
    expect(notices).toEqual([FOCUS_COLOR_PROTECTED_HINT]);

    expect(controller.handlePointerDown(at(2, 0, 0))).toBe(true);
    for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
    expect([colorAt(0, 7), colorAt(1, 3), colorAt(2, 3), colorAt(3, 3)]).toEqual([1, 1, 2, 0]);
    controller.dispose();
  });

  it('deletes only the focus-color cells of a selection', () => {
    const document = layeredDocument();
    seed(document, 1, full(0, 0, 1));
    seed(document, 1, full(1, 0, 2));
    seed(document, 1, full(2, 2, 2));
    const { controller, colorAt, notices } = fixture(document);
    controller.setTool({ tool: 'select' });
    controller.setSelection({ x: 0, y: 0 }, { x: 1, y: 0 });
    expect(controller.deleteSelection()).toBe(true);
    expect([colorAt(0, 0), colorAt(1, 0)]).toEqual([0, 2]);

    controller.setSelection({ x: 2, y: 2 });
    expect(controller.deleteSelection()).toBe(false);
    expect(colorAt(2, 2)).toBe(2);
    expect(notices).toEqual([FOCUS_COLOR_PROTECTED_HINT]);
    controller.dispose();
  });

  it('pastes only focus-color cells, and none onto another color', () => {
    const document = layeredDocument();
    seed(document, 1, full(0, 0, 1));
    seed(document, 1, full(1, 0, 1));
    seed(document, 1, full(2, 0, 2));
    seed(document, 1, full(1, 3, 2));
    const { controller, colorAt } = fixture(document);
    controller.setFocusColor(false);
    controller.setTool({ tool: 'select' });
    controller.setSelection({ x: 0, y: 0 }, { x: 2, y: 0 });
    controller.copySelection();
    controller.setFocusColor(true);
    controller.setSelection({ x: 0, y: 3 });
    expect(controller.pasteSelection()).toBe(true);
    expect(controller.confirmFloatingPaste()).toBe(true);
    expect([colorAt(0, 3), colorAt(1, 3), colorAt(2, 3)]).toEqual([1, 2, 0]);
    controller.dispose();
  });

  it('copies only the focus-color cells of a selection', () => {
    const document = layeredDocument();
    seed(document, 1, full(0, 0, 1));
    seed(document, 1, full(1, 0, 2));
    const { controller } = fixture(document);
    controller.setTool({ tool: 'select' });
    controller.setSelection({ x: 0, y: 0 }, { x: 1, y: 0 });
    const copied = controller.copySelection()!;
    expect(Array.from(copied.colors).filter((color) => color !== 0)).toEqual([1]);
    controller.dispose();
  });

  it('refuses a move that would land on another color', () => {
    const document = layeredDocument();
    seed(document, 1, full(0, 0, 1));
    seed(document, 1, full(1, 0, 2));
    const { controller, colorAt, notices } = fixture(document);
    controller.setTool({ tool: 'select' });
    controller.setSelection({ x: 0, y: 0 }, { x: 1, y: 0 });
    expect(controller.moveSelection()).toBe(true);
    // A press right of the floating cell nudges it one cell, onto the blue stitch.
    controller.handlePointerDown(at(1, 3, 0));
    controller.handlePointerUp(at(1, 3, 0));
    expect(controller.confirmFloatingPaste()).toBe(false);
    expect(notices).toEqual([FOCUS_COLOR_PROTECTED_HINT]);
    expect([colorAt(0, 0), colorAt(1, 0)]).toEqual([1, 2]);
    controller.dispose();
  });

  it('erases and deletes only focus-color backstitches on a specialty layer', () => {
    const document = layeredDocument();
    seed(document, 2, backstitch(0, 0, 4, 0, 1));
    seed(document, 2, backstitch(0, 4, 4, 4, 2));
    seed(document, 2, backstitch(16, 16, 20, 16, 1));
    seed(document, 2, backstitch(16, 20, 20, 20, 2));
    const { controller, backstitches, notices } = fixture(document, 2);
    controller.setTool({ tool: 'eraser' });
    drag(controller, [[0, 0]]);
    expect(backstitches()).toEqual({ '0,4-4,4': 2, '16,16-20,16': 1, '16,20-20,20': 2 });

    controller.setTool({ tool: 'select' });
    controller.setSelection({ x: 4, y: 4 }, { x: 5, y: 5 });
    expect(controller.deleteSelection()).toBe(true);
    expect(backstitches()).toEqual({ '0,4-4,4': 2, '16,20-20,20': 2 });

    controller.setSelection({ x: 4, y: 4 }, { x: 5, y: 5 });
    expect(controller.deleteSelection()).toBe(false);
    expect(notices).toEqual([FOCUS_COLOR_PROTECTED_HINT]);
    controller.dispose();
  });

  it('moves only focus-color backstitches on a specialty layer', () => {
    const document = layeredDocument();
    seed(document, 2, backstitch(0, 0, 4, 0, 1));
    seed(document, 2, backstitch(0, 4, 4, 4, 2));
    const { controller, backstitches } = fixture(document, 2);
    controller.setTool({ tool: 'select' });
    controller.setSelection({ x: 0, y: 0 }, { x: 1, y: 1 });
    expect(controller.moveSelection()).toBe(true);
    controller.handlePointerDown(at(1, 4, 0));
    controller.handlePointerUp(at(1, 4, 0));
    expect(controller.confirmFloatingPaste()).toBe(true);
    expect(backstitches()).toEqual({ '4,0-8,0': 1, '0,4-4,4': 2 });
    controller.dispose();
  });

  it('does not draw a backstitch over one of another color', () => {
    const document = layeredDocument();
    seed(document, 2, backstitch(0, 0, 4, 0, 2));
    const { controller, backstitches, notices } = fixture(document, 2);
    controller.setTool({ tool: 'backstitch' });
    controller.handlePointerDown({ ...at(1, 0, 0), screenX: 0, screenY: 0 });
    controller.handlePointerUp({ ...at(1, 0, 0), screenX: 16, screenY: 0 });
    expect(backstitches()).toEqual({ '0,0-4,0': 2 });
    expect(notices).toEqual([FOCUS_COLOR_PROTECTED_HINT]);
    controller.dispose();
  });

  it('restores full editing when turned off', () => {
    const document = layeredDocument();
    seed(document, 1, full(1, 0, 2));
    const { controller, colorAt } = fixture(document);
    controller.toggleFocusColor();
    drag(controller, [[1, 0]]);
    expect(colorAt(1, 0)).toBe(1);
    controller.dispose();
  });
});
