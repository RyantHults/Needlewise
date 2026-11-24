import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG_DEFINITION } from '../catalog';
import { CellKind, layerSurface, type BeadOrientation, type PaletteEntryInput, type Point } from '../domain';
import { createLayeredDocument, SPECIALTY_LAYER_ID, STITCH_LAYER_ID } from '../domain/test-fixtures';
import { millHillBeadEntry } from '../catalog/test-support';
import { clearClipboard } from './clipboard-store';
import { BEAD_COLOR_HINT, BEAD_TOOL_HINT, FOCUS_COLOR_PROTECTED_HINT, type EditorToolState } from './contracts';
import { EditorSurfaceController } from './controller';
import { getCanvasMetrics } from './coordinates';
import { createWorkspaceEditorGateway } from './gateway';
import type { PointerSample } from './input';
import { LayeredTestBoundary, rendererFixture } from './test-support';
import { createUiStore } from './ui-store';

const THREAD = 1;
const BEAD = 2;

function fixture(readOnly = false, activeLayerId = SPECIALTY_LAYER_ID, palette: PaletteEntryInput[] = [{ id: THREAD, name: 'Red', color: '#d33' }, millHillBeadEntry(BEAD)]) {
  const document = createLayeredDocument({
    width: 8,
    height: 8,
    catalog: DEFAULT_CATALOG_DEFINITION.association,
    palette
  });
  const boundary = new LayeredTestBoundary(document, { activeLayerId });
  const uiStore = createUiStore({ tool: { tool: 'pan' } });
  const notices: string[] = [];
  const controller = new EditorSurfaceController({
    gateway: createWorkspaceEditorGateway(boundary),
    uiStore,
    renderer: rendererFixture().renderer,
    metrics: getCanvasMetrics(128, 128),
    onNotice: (message) => notices.push(message),
    readOnly
  });
  controller.start();
  controller.handleFocus();
  uiStore.setViewport({ x: 0, y: 0, zoom: 16 });
  return { boundary, uiStore, controller, notices };
}

/** A mouse press and release at model point (`x`, `y`), 16 px per cell. */
function tap(controller: EditorSurfaceController, x: number, y: number, extra: Partial<PointerSample> = {}): void {
  const sample: PointerSample = { pointerId: 1, pointerType: 'mouse', screenX: x * 16, screenY: y * 16, button: 0, buttons: 1, isPrimary: true, ...extra };
  controller.handlePointerDown(sample);
  controller.handlePointerUp(sample);
}

function points(boundary: LayeredTestBoundary) {
  const store = layerSurface(boundary.layeredDocument, SPECIALTY_LAYER_ID).pointStitches;
  return Array.from(store.ids, (id, index) => ({ x: store.x[index], y: store.y[index], color: store.colors[index], completed: store.completed[index] }));
}

function compositePoints(boundary: LayeredTestBoundary) {
  const store = boundary.document.pointStitches;
  return Array.from(store.ids, (id, index) => ({ id, completed: store.completed[index] }));
}

function place(boundary: LayeredTestBoundary, point: Point, color = THREAD, orientation: BeadOrientation = 0): void {
  boundary.seed({ type: 'add-point-stitch', point, color, orientation });
}

function useTool(controller: EditorSurfaceController, tool: EditorToolState, paletteId = THREAD): void {
  controller.selectPalette(paletteId);
  expect(controller.setTool(tool)).toBe(true);
}

beforeEach(clearClipboard);

describe('knots and beads in the editor', () => {
  it('places a knot at the nearest corner or centre', () => {
    const { boundary, controller } = fixture();
    useTool(controller, { tool: 'specialty', stitch: 'french-knot' });
    tap(controller, 2.1, 2.05);
    tap(controller, 2.6, 2.45);
    // A touch places on release.
    tap(controller, 4.9, 1.1, { pointerType: 'touch' });
    expect(points(boundary)).toEqual([
      { x: 8, y: 8, color: THREAD, completed: 0 },
      { x: 10, y: 10, color: THREAD, completed: 0 },
      { x: 20, y: 4, color: THREAD, completed: 0 }
    ]);
    boundary.undo();
    expect(points(boundary)).toHaveLength(2);
    controller.dispose();
  });

  it('switches to Bead when a bead is picked, and back to French knot for a thread', () => {
    const { boundary, controller, uiStore } = fixture();
    useTool(controller, { tool: 'specialty', stitch: 'french-knot' });
    controller.selectPalette(BEAD);
    expect(uiStore.getState().tool).toEqual({ tool: 'specialty', stitch: 'bead' });
    tap(controller, 1.5, 1.5);
    expect(points(boundary)).toEqual([{ x: 6, y: 6, color: BEAD, completed: 0 }]);
    controller.selectPalette(THREAD);
    expect(uiStore.getState().tool).toEqual({ tool: 'specialty', stitch: 'french-knot' });
    controller.dispose();
  });

  it('keeps Focus Color from replacing a point of another color', () => {
    const { boundary, controller, notices } = fixture();
    place(boundary, { x: 10, y: 10 }, BEAD);
    useTool(controller, { tool: 'specialty', stitch: 'french-knot' });
    controller.setFocusColor(true);
    tap(controller, 2.5, 2.5);
    expect(points(boundary)).toEqual([{ x: 10, y: 10, color: BEAD, completed: 0 }]);
    expect(notices.at(-1)).toBe(FOCUS_COLOR_PROTECTED_HINT);
    controller.dispose();
  });

  it('moves only focus-color knots under Focus Color, keeping their Track marks', () => {
    const { boundary, controller } = fixture();
    place(boundary, { x: 6, y: 6 });
    place(boundary, { x: 8, y: 8 }, BEAD);
    boundary.markProgress({ pointStitchIds: Uint32Array.of(1), operation: 'set' });
    useTool(controller, { tool: 'select' });
    controller.setSelection({ x: 1, y: 1 });
    controller.setFocusColor(true);
    expect(controller.moveSelection()).toBe(true);
    const press = (screenX: number, screenY: number): PointerSample => ({ pointerId: 2, pointerType: 'mouse', screenX, screenY, button: 0, buttons: 1, isPrimary: true });
    controller.handlePointerDown(press(24, 24));
    controller.handlePointerMove(press(40, 24));
    controller.handlePointerUp(press(40, 24));
    expect(controller.confirmFloatingPaste()).toBe(true);
    // The bead on the selection's corner is another color, so it stays.
    expect(points(boundary).map(({ x, y, color }) => ({ x, y, color }))).toEqual([{ x: 10, y: 6, color: THREAD }, { x: 8, y: 8, color: BEAD }]);
    expect(compositePoints(boundary)).toEqual([{ id: 1, completed: 1 }, { id: 2, completed: 0 }]);
    controller.dispose();
  });

  it('refuses a Focus Color move onto a knot that stays, even of the focus color', () => {
    const { boundary, controller, notices } = fixture();
    place(boundary, { x: 6, y: 6 });
    place(boundary, { x: 10, y: 6 });
    useTool(controller, { tool: 'select' });
    controller.setSelection({ x: 1, y: 1 });
    controller.setFocusColor(true);
    expect(controller.moveSelection()).toBe(true);
    const press = (screenX: number, screenY: number): PointerSample => ({ pointerId: 2, pointerType: 'mouse', screenX, screenY, button: 0, buttons: 1, isPrimary: true });
    controller.handlePointerDown(press(24, 24));
    controller.handlePointerMove(press(40, 24));
    controller.handlePointerUp(press(40, 24));
    expect(controller.confirmFloatingPaste()).toBe(false);
    expect(notices.at(-1)).toBe(FOCUS_COLOR_PROTECTED_HINT);
    expect(points(boundary).map(({ x, y }) => ({ x, y }))).toEqual([{ x: 6, y: 6 }, { x: 10, y: 6 }]);
    controller.dispose();
  });

  it('erases a knot the eraser passes over and keeps the rest', () => {
    const { boundary, controller, uiStore } = fixture();
    place(boundary, { x: 10, y: 10 });
    place(boundary, { x: 24, y: 24 });
    useTool(controller, { tool: 'eraser' });
    controller.handlePointerDown({ pointerId: 1, pointerType: 'mouse', screenX: 40, screenY: 40, button: 0, buttons: 1, isPrimary: true });
    expect(uiStore.getState().overlay.erasingPointStitchIds?.size).toBe(1);
    controller.handlePointerUp({ pointerId: 1, pointerType: 'mouse', screenX: 40, screenY: 40, button: 0, buttons: 1, isPrimary: true });
    expect(points(boundary).map(({ x, y }) => ({ x, y }))).toEqual([{ x: 24, y: 24 }]);
    controller.dispose();
  });

  it('copies, pastes and moves the knots and beads inside a selection', () => {
    const { boundary, controller } = fixture();
    // A corner on the selection border and a bead in it are carried; a knot outside stays.
    place(boundary, { x: 4, y: 4 });
    place(boundary, { x: 10, y: 10 }, BEAD);
    place(boundary, { x: 26, y: 26 });
    useTool(controller, { tool: 'select' });
    controller.setSelection({ x: 1, y: 1 }, { x: 2, y: 2 });
    const copied = controller.copySelection();
    expect(Array.from(copied?.pointStitches.colors ?? [])).toEqual([THREAD, BEAD]);

    controller.clearSelection();
    controller.setSelection({ x: 4, y: 0 });
    expect(controller.pasteSelection()).toBe(true);
    expect(controller.confirmFloatingPaste()).toBe(true);
    expect(points(boundary).map(({ x, y, color }) => ({ x, y, color }))).toContainEqual({ x: 22, y: 6, color: BEAD });

    controller.setSelection({ x: 1, y: 1 }, { x: 2, y: 2 });
    expect(controller.moveSelection()).toBe(true);
    const press = (screenX: number, screenY: number): PointerSample => ({ pointerId: 2, pointerType: 'mouse', screenX, screenY, button: 0, buttons: 1, isPrimary: true });
    controller.handlePointerDown(press(24, 24));
    controller.handlePointerMove(press(24, 72));
    controller.handlePointerUp(press(24, 72));
    expect(controller.confirmFloatingPaste()).toBe(true);
    const after = points(boundary).map(({ x, y }) => `${String(x)},${String(y)}`);
    expect(after).toEqual(expect.arrayContaining(['4,16', '10,22', '26,26']));
    expect(after).not.toContain('4,4');
    controller.handleKeyDown({ key: 'z', ctrlKey: true, preventDefault: () => undefined });
    expect(points(boundary).map(({ x, y }) => `${String(x)},${String(y)}`)).toEqual(expect.arrayContaining(['4,4', '10,10']));
    controller.dispose();
  });

  it('refuses a paste onto an occupied point and keeps it floating', () => {
    const { boundary, controller, uiStore } = fixture();
    place(boundary, { x: 6, y: 6 });
    useTool(controller, { tool: 'select' });
    controller.setSelection({ x: 1, y: 1 });
    controller.copySelection();
    expect(controller.pasteSelection()).toBe(true);
    expect(controller.confirmFloatingPaste()).toBe(false);
    expect(uiStore.getState().overlay.floatingPaste).toBeDefined();
    expect(points(boundary)).toHaveLength(1);
    controller.dispose();
  });

  it('deletes the knots and beads inside a selection', () => {
    const { boundary, controller } = fixture();
    place(boundary, { x: 8, y: 8 });
    place(boundary, { x: 6, y: 6 }, BEAD);
    place(boundary, { x: 20, y: 20 });
    useTool(controller, { tool: 'select' });
    controller.setSelection({ x: 1, y: 1 });
    expect(controller.deleteSelection()).toBe(true);
    expect(points(boundary).map(({ x, y }) => ({ x, y }))).toEqual([{ x: 20, y: 20 }]);
    controller.dispose();
  });
});

describe('bead orientation', () => {
  function orientations(boundary: LayeredTestBoundary) {
    const store = layerSurface(boundary.layeredDocument, SPECIALTY_LAYER_ID).pointStitches;
    return Array.from(store.orientations);
  }

  it('turns a bead of the selected color / | \\ - on each click, and undo turns it back', () => {
    const { boundary, controller } = fixture();
    useTool(controller, { tool: 'specialty', stitch: 'bead' }, BEAD);
    tap(controller, 2.55, 2.5);
    expect(orientations(boundary)).toEqual([0]);
    const seen: number[] = [];
    for (let click = 0; click < 4; click += 1) {
      tap(controller, 2.55, 2.5);
      seen.push(orientations(boundary)[0]);
    }
    expect(seen).toEqual([1, 2, 3, 0]);
    boundary.undo();
    expect(orientations(boundary)).toEqual([3]);
    expect(points(boundary)).toHaveLength(1);
    controller.dispose();
  });

  it('places the next new bead at the last orientation, and a knot upright', () => {
    const { boundary, controller } = fixture();
    place(boundary, { x: 10, y: 10 }, BEAD);
    useTool(controller, { tool: 'specialty', stitch: 'bead' }, BEAD);
    tap(controller, 2.55, 2.5);
    tap(controller, 4.5, 4.5);
    expect(orientations(boundary)).toEqual([1, 1]);
    useTool(controller, { tool: 'specialty', stitch: 'french-knot' });
    tap(controller, 6.5, 6.5);
    expect(orientations(boundary)).toEqual([1, 1, 0]);
    controller.dispose();
  });
});

describe('the bead hover preview', () => {
  function hover(controller: EditorSurfaceController, x: number, y: number, pointerType: PointerSample['pointerType'] = 'mouse'): void {
    controller.handlePointerMove({ pointerId: 1, pointerType, screenX: x * 16, screenY: y * 16, button: 0, buttons: 0, isPrimary: true });
  }

  it('shows the selected bead at the snapped point, and clears when the tool changes', () => {
    const { controller, uiStore } = fixture();
    useTool(controller, { tool: 'specialty', stitch: 'bead' }, BEAD);
    hover(controller, 2.55, 2.5);
    expect(uiStore.getState().overlay.pointStitchPreview).toEqual({ point: { x: 10, y: 10 }, paletteId: BEAD, orientation: 0 });
    expect(controller.setTool({ tool: 'select' })).toBe(true);
    expect(uiStore.getState().overlay.pointStitchPreview).toBeFalsy();
    controller.dispose();
  });

  it('shows nothing off the chart (where a press places nothing) or for touch', () => {
    const { boundary, controller, uiStore } = fixture();
    place(boundary, { x: 10, y: 10 }, BEAD);
    useTool(controller, { tool: 'specialty', stitch: 'bead' }, BEAD);
    hover(controller, 12.5, 12.5);
    expect(uiStore.getState().overlay.pointStitchPreview).toBeFalsy();
    tap(controller, 12.5, 12.5);
    expect(points(boundary)).toHaveLength(1);
    hover(controller, 4.5, 4.5, 'touch');
    expect(uiStore.getState().overlay.pointStitchPreview).toBeFalsy();
    hover(controller, 4.5, 4.5);
    expect(uiStore.getState().overlay.pointStitchPreview).toEqual({ point: { x: 18, y: 18 }, paletteId: BEAD, orientation: 0 });
    controller.dispose();
  });

  it('previews a French knot on a free point and nothing on a knot of the selected color', () => {
    const { boundary, controller, uiStore } = fixture();
    place(boundary, { x: 10, y: 10 });
    useTool(controller, { tool: 'specialty', stitch: 'french-knot' });
    hover(controller, 4.5, 4.5);
    expect(uiStore.getState().overlay.pointStitchPreview).toEqual({ point: { x: 18, y: 18 }, paletteId: THREAD, orientation: 0 });
    hover(controller, 2.55, 2.5);
    expect(uiStore.getState().overlay.pointStitchPreview).toBeUndefined();
    expect(uiStore.getState().overlay.pointStitchRotate).toBeUndefined();
    controller.dispose();
  });

  it('marks a bead of the selected color as one a press turns, with no ghost', () => {
    const { boundary, controller, uiStore } = fixture();
    place(boundary, { x: 10, y: 10 }, BEAD, 2);
    useTool(controller, { tool: 'specialty', stitch: 'bead' }, BEAD);
    hover(controller, 2.55, 2.5);
    expect(uiStore.getState().overlay.pointStitchPreview).toBeUndefined();
    expect(uiStore.getState().overlay.pointStitchRotate).toEqual({ point: { x: 10, y: 10 } });
    hover(controller, 4.5, 4.5);
    expect(uiStore.getState().overlay.pointStitchRotate).toBeUndefined();
    controller.dispose();
  });

  it('keeps the hover hint after a click or an undo with the pointer still', () => {
    const { boundary, controller, uiStore } = fixture();
    useTool(controller, { tool: 'specialty', stitch: 'bead' }, BEAD);
    hover(controller, 2.55, 2.5);
    tap(controller, 2.55, 2.5);
    expect(points(boundary)).toHaveLength(1);
    // The new bead is the selected color, so a further press would turn it.
    expect(uiStore.getState().overlay.pointStitchPreview).toBeUndefined();
    expect(uiStore.getState().overlay.pointStitchRotate).toEqual({ point: { x: 10, y: 10 } });

    tap(controller, 2.55, 2.5);
    expect(Array.from(layerSurface(boundary.layeredDocument, SPECIALTY_LAYER_ID).pointStitches.orientations)).toEqual([1]);
    expect(uiStore.getState().overlay.pointStitchRotate).toEqual({ point: { x: 10, y: 10 } });

    boundary.undo();
    boundary.undo();
    expect(points(boundary)).toHaveLength(0);
    // The ghost takes the orientation the last turn set.
    expect(uiStore.getState().overlay.pointStitchPreview).toEqual({ point: { x: 10, y: 10 }, paletteId: BEAD, orientation: 1 });
    controller.dispose();
  });

  it('shows neither a ghost nor a turn over a bead Focus Color protects', () => {
    const OTHER_BEAD = 4;
    const { boundary, controller, uiStore } = fixture(false, SPECIALTY_LAYER_ID, [{ id: THREAD, name: 'Red', color: '#d33' }, millHillBeadEntry(BEAD), millHillBeadEntry(OTHER_BEAD, '00020')]);
    place(boundary, { x: 10, y: 10 }, OTHER_BEAD);
    useTool(controller, { tool: 'specialty', stitch: 'bead' }, BEAD);
    controller.setFocusColor(true);
    hover(controller, 2.55, 2.5);
    expect(uiStore.getState().overlay.pointStitchPreview).toBeUndefined();
    expect(uiStore.getState().overlay.pointStitchRotate).toBeUndefined();
    controller.dispose();
  });

  it('previews the selected bead over another color: a bead keeps its orientation, a knot takes the last one', () => {
    const OTHER_BEAD = 4;
    const { boundary, controller, uiStore } = fixture(false, SPECIALTY_LAYER_ID, [{ id: THREAD, name: 'Red', color: '#d33' }, millHillBeadEntry(BEAD), millHillBeadEntry(OTHER_BEAD, '00020')]);
    place(boundary, { x: 10, y: 10 }, OTHER_BEAD, 2);
    place(boundary, { x: 18, y: 18 });
    useTool(controller, { tool: 'specialty', stitch: 'bead' }, BEAD);
    hover(controller, 2.55, 2.5);
    expect(uiStore.getState().overlay.pointStitchPreview).toEqual({ point: { x: 10, y: 10 }, paletteId: BEAD, orientation: 2 });
    expect(uiStore.getState().overlay.pointStitchRotate).toBeUndefined();
    hover(controller, 4.5, 4.5);
    expect(uiStore.getState().overlay.pointStitchPreview).toEqual({ point: { x: 18, y: 18 }, paletteId: BEAD, orientation: 0 });
    controller.dispose();
  });

  it('previews a knot over a bead in French knot mode', () => {
    const { boundary, controller, uiStore } = fixture();
    place(boundary, { x: 10, y: 10 }, BEAD, 1);
    useTool(controller, { tool: 'specialty', stitch: 'french-knot' });
    hover(controller, 2.55, 2.5);
    expect(uiStore.getState().overlay.pointStitchPreview).toEqual({ point: { x: 10, y: 10 }, paletteId: THREAD, orientation: 0 });
    controller.dispose();
  });
});

describe('beads on a stitch layer', () => {
  it('keeps a bead off the paint brush, and a brush set with a bead paints with the last thread', () => {
    const { boundary, controller, uiStore, notices } = fixture(false, STITCH_LAYER_ID);
    controller.setBrush({ kind: 'full', paletteId: THREAD });
    controller.selectPalette(BEAD);
    expect(uiStore.getState().tool).toEqual({ tool: 'paint', brush: { kind: 'full', paletteId: THREAD } });
    expect(notices.at(-1)).toBe(BEAD_TOOL_HINT);

    controller.setBrush({ kind: 'full', paletteId: BEAD });
    expect(uiStore.getState()).toMatchObject({ tool: { tool: 'paint', brush: { kind: 'full', paletteId: THREAD } }, paletteId: THREAD });
    tap(controller, 1.5, 1.5);
    expect(layerSurface(boundary.layeredDocument, STITCH_LAYER_ID).kind[9]).toBe(CellKind.Full);
    controller.dispose();
  });
});

describe('the palette selection follows the kind the tool shows', () => {
  const THREAD_2 = 3;
  const BEAD_2 = 4;
  const palette: PaletteEntryInput[] = [
    { id: THREAD, name: 'Red', color: '#d33' },
    millHillBeadEntry(BEAD),
    { id: THREAD_2, name: 'Blue', color: '#33d' },
    millHillBeadEntry(BEAD_2, '00020')
  ];

  it('selects the last bead for Bead, and the last thread for French knot and Stitch', () => {
    const { controller, uiStore } = fixture(false, SPECIALTY_LAYER_ID, palette);
    controller.selectPalette(BEAD_2);
    controller.selectPalette(THREAD_2);
    expect(controller.setTool({ tool: 'specialty', stitch: 'bead' })).toBe(true);
    expect(uiStore.getState().paletteId).toBe(BEAD_2);
    expect(controller.setTool({ tool: 'specialty', stitch: 'french-knot' })).toBe(true);
    expect(uiStore.getState().paletteId).toBe(THREAD_2);

    expect(controller.setTool({ tool: 'specialty', stitch: 'bead' })).toBe(true);
    controller.setBrush({ kind: 'full', paletteId: BEAD_2 });
    expect(uiStore.getState()).toMatchObject({ tool: { tool: 'paint', brush: { paletteId: THREAD_2 } }, paletteId: THREAD_2 });
    controller.dispose();
  });

  it('falls back to the first active bead when the last one is gone', () => {
    const { boundary, controller, uiStore } = fixture(false, SPECIALTY_LAYER_ID, palette);
    controller.selectPalette(BEAD_2);
    controller.selectPalette(THREAD);
    boundary.seed({ type: 'palette-delete', id: BEAD_2 });
    expect(controller.setTool({ tool: 'specialty', stitch: 'bead' })).toBe(true);
    expect(uiStore.getState().paletteId).toBe(BEAD);
    controller.dispose();
  });

  it('keeps the thread on Bead when the palette has no beads, and places nothing with it', () => {
    const { boundary, controller, uiStore, notices } = fixture(false, SPECIALTY_LAYER_ID, [{ id: THREAD, name: 'Red', color: '#d33' }]);
    useTool(controller, { tool: 'specialty', stitch: 'bead' });
    expect(uiStore.getState().paletteId).toBe(THREAD);
    tap(controller, 2.5, 2.5);
    expect(points(boundary)).toEqual([]);
    expect(notices.at(-1)).toBe(BEAD_COLOR_HINT);
    controller.dispose();
  });
});

describe('knots and beads in Track', () => {
  it('toggles a knot on a tap, and Track undo restores it', () => {
    const { boundary, controller } = fixture(true);
    place(boundary, { x: 10, y: 10 });
    expect(controller.setTool({ tool: 'mark' })).toBe(true);
    tap(controller, 2.55, 2.5);
    expect(compositePoints(boundary)).toEqual([{ id: 1, completed: 1 }]);
    boundary.undoMark();
    expect(compositePoints(boundary)).toEqual([{ id: 1, completed: 0 }]);
    controller.dispose();
  });
});
