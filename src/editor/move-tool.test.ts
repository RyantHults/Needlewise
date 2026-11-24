import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG_DEFINITION } from '../catalog';
import { millHillBeadEntry } from '../catalog/test-support';
import { CellKind, LayerType, findLayer, layerSurface, type BeadOrientation, type DomainCommand, type LayeredDocument } from '../domain';
import { SPECIALTY_LAYER_ID, STITCH_LAYER_ID, applyCommand, cell, commitLayerSurface, createLayeredDocument } from '../domain/test-fixtures';
import { FOCUS_COLOR_PROTECTED_HINT } from './contracts';
import type { PointerSample } from './input';
import { LayeredTestBoundary, at, drag, fixture, layeredDocument } from './test-support';

function seed(document: LayeredDocument, layerId: number, command: DomainCommand): void {
  commitLayerSurface(document, layerId, applyCommand(layerSurface(document, layerId), command).document);
}

function stitchFixture() {
  const document = layeredDocument();
  seed(document, STITCH_LAYER_ID, cell(document.width, { type: 'set-full', x: 1, y: 1, color: 1 }));
  return fixture(new LayeredTestBoundary(document, { activeLayerId: STITCH_LAYER_ID }));
}

/** The stitch fixture with cell (1, 1) selected, under the Move tool. */
function selectedFixture() {
  const result = stitchFixture();
  result.controller.setTool({ tool: 'select' });
  result.controller.setSelection({ x: 1, y: 1 });
  result.controller.setTool({ tool: 'pan' });
  return result;
}

function specialtyFixture() {
  const document = layeredDocument();
  seed(document, SPECIALTY_LAYER_ID, { type: 'add-backstitch', start: { x: 8, y: 8 }, end: { x: 12, y: 8 }, color: 1 });
  const result = fixture(new LayeredTestBoundary(document, { activeLayerId: SPECIALTY_LAYER_ID }));
  result.controller.setTool({ tool: 'pan' });
  return result;
}

function backstitchCount(boundary: LayeredTestBoundary): number | false {
  const layer = findLayer(boundary.layeredDocument, SPECIALTY_LAYER_ID)!;
  return layer.type === LayerType.Specialty && layer.backstitches.ids.length;
}

describe('Move tool', () => {
  it('lifts a selection and drags it on the same press, then commits the move', () => {
    const { controller, boundary, uiStore } = selectedFixture();
    const viewport = uiStore.getState().viewport;

    drag(controller, { x: 1, y: 1 }, { x: 3, y: 2 });
    expect(uiStore.getState().overlay.floatingPaste).toMatchObject({ mode: 'move', destination: { x: 3, y: 2, width: 1, height: 1 } });
    expect(uiStore.getState().viewport).toEqual(viewport);

    expect(controller.confirmFloatingPaste()).toBe(true);
    const surface = boundary.activeLayerSurface()!;
    expect(surface.kind[1 * surface.width + 1]).toBe(CellKind.Empty);
    expect(surface.kind[2 * surface.width + 3]).toBe(CellKind.Full);
    controller.dispose();
  });

  it('does nothing on a click inside or outside the selection', () => {
    const { controller, uiStore } = selectedFixture();
    const viewport = uiStore.getState().viewport;
    for (const target of [{ x: 1, y: 1 }, { x: 5, y: 5 }]) {
      drag(controller, target, target);
      expect(uiStore.getState().overlay.floatingPaste).toBeUndefined();
      expect(uiStore.getState().viewport).toEqual(viewport);
      expect(controller.getSelection()).toEqual({ x: 1, y: 1, width: 1, height: 1 });
    }
    controller.dispose();
  });

  it('moves the selection by the drag offset when the drag starts outside it', () => {
    const { controller, uiStore } = selectedFixture();
    const viewport = uiStore.getState().viewport;
    drag(controller, { x: 5, y: 5 }, { x: 7, y: 6 });
    expect(uiStore.getState().overlay.floatingPaste).toMatchObject({ mode: 'move', destination: { x: 3, y: 2 } });
    expect(uiStore.getState().viewport).toEqual(viewport);
    controller.dispose();
  });

  it('drags a floating move from a press on or off it, and a click does not nudge it', () => {
    const { controller, uiStore } = selectedFixture();
    drag(controller, { x: 1, y: 1 }, { x: 3, y: 2 });
    drag(controller, { x: 3, y: 2 }, { x: 4, y: 2 });
    expect(uiStore.getState().overlay.floatingPaste?.destination).toMatchObject({ x: 4, y: 2 });
    drag(controller, { x: 0, y: 7 }, { x: 1, y: 6 });
    expect(uiStore.getState().overlay.floatingPaste?.destination).toMatchObject({ x: 5, y: 1 });
    const viewport = uiStore.getState().viewport;
    drag(controller, { x: 0, y: 0 }, { x: 0, y: 0 });
    expect(uiStore.getState().overlay.floatingPaste?.destination).toMatchObject({ x: 5, y: 1 });
    expect(uiStore.getState().viewport).toEqual(viewport);
    controller.dispose();
  });

  it('starts a pinch, not a lift, when a second finger lands before the drag passes the slop', () => {
    const { controller, uiStore } = selectedFixture();
    const touch = { pointerType: 'touch' as const };
    controller.handlePointerDown(at(1, 1, 1, touch));
    controller.handlePointerDown(at(2, 4, 4, touch));
    controller.handlePointerMove(at(2, 6, 6, touch));
    controller.handlePointerMove(at(1, 0, 0, touch));
    controller.handlePointerUp(at(2, 6, 6, touch));
    controller.handlePointerUp(at(1, 0, 0, touch));
    expect(uiStore.getState().overlay.floatingPaste).toBeUndefined();
    expect(controller.getSelection()).toEqual({ x: 1, y: 1, width: 1, height: 1 });
    controller.dispose();
  });

  it('pans over a selection while Space is held or with the middle button', () => {
    const { controller, uiStore } = selectedFixture();
    const start = uiStore.getState().viewport;

    controller.handleKeyDown({ key: ' ', code: 'Space', preventDefault: () => undefined });
    drag(controller, { x: 1, y: 1 }, { x: 2, y: 2 });
    controller.handleKeyUp({ key: ' ', code: 'Space', preventDefault: () => undefined });
    expect(uiStore.getState().overlay.floatingPaste).toBeUndefined();
    const afterSpace = uiStore.getState().viewport;
    expect(afterSpace).not.toEqual(start);

    controller.handlePointerDown(at(2, 2, 2, { button: 1, buttons: 4 }));
    controller.handlePointerMove(at(2, 3, 3, { button: 1, buttons: 4 }));
    controller.handlePointerUp(at(2, 3, 3, { button: 1, buttons: 4 }));
    expect(uiStore.getState().overlay.floatingPaste).toBeUndefined();
    expect(uiStore.getState().viewport).not.toEqual(afterSpace);
    controller.dispose();
  });

  it('drags a backstitch endpoint on a specialty layer', () => {
    const { controller, boundary, uiStore } = specialtyFixture();
    const viewport = uiStore.getState().viewport;
    // The stitch runs from (2, 2) to (3, 2); press beside its end corner.
    controller.handlePointerDown({ ...at(1, 0, 0), screenX: 46, screenY: 32 });
    controller.handlePointerMove({ ...at(1, 0, 0), screenX: 48, screenY: 48 });
    controller.handlePointerUp({ ...at(1, 0, 0), screenX: 48, screenY: 48 });
    expect(boundary.log.at(-1)).toMatchObject({ type: 'move-backstitch', start: { x: 8, y: 8 }, end: { x: 12, y: 12 } });
    expect(uiStore.getState().viewport).toEqual(viewport);
    controller.dispose();
  });

  it('pans when the press misses every backstitch', () => {
    const { controller, boundary, uiStore } = specialtyFixture();
    const viewport = uiStore.getState().viewport;
    drag(controller, { x: 6, y: 6 }, { x: 7, y: 7 });
    expect(uiStore.getState().viewport).not.toEqual(viewport);
    expect(controller.getSelectedBackstitchId()).toBeUndefined();
    expect(boundary.log).toEqual([]);
    controller.dispose();
  });

  it('deletes the tapped backstitch with Delete', () => {
    const { controller, boundary } = specialtyFixture();
    controller.handlePointerDown({ ...at(1, 0, 0), screenX: 40, screenY: 32 });
    controller.handlePointerUp({ ...at(1, 0, 0), screenX: 40, screenY: 32 });
    expect(controller.getSelectedBackstitchId()).toBeDefined();
    controller.handleKeyDown({ key: 'Delete', preventDefault: () => undefined });
    expect(backstitchCount(boundary)).toBe(0);
    controller.dispose();
  });
});

const THREAD = 1;
const BEAD = 2;

/** A specialty layer with a thread and a bead color, under the Move tool. */
function pointFixture() {
  const document = createLayeredDocument({
    width: 8,
    height: 8,
    catalog: DEFAULT_CATALOG_DEFINITION.association,
    palette: [{ id: THREAD, name: 'Red', color: '#d33' }, millHillBeadEntry(BEAD)]
  });
  const result = fixture(new LayeredTestBoundary(document, { activeLayerId: SPECIALTY_LAYER_ID }));
  result.controller.setTool({ tool: 'pan' });
  return result;
}

function place(boundary: LayeredTestBoundary, x: number, y: number, color = THREAD, orientation: BeadOrientation = 0): void {
  boundary.seed({ type: 'add-point-stitch', point: { x, y }, color, orientation });
}

/** A mouse sample at model point (`x`, `y`), 16 px per cell. */
function atPoint(x: number, y: number): PointerSample {
  return { ...at(1, 0, 0), screenX: x * 16, screenY: y * 16 };
}

function dragPoint(controller: ReturnType<typeof fixture>['controller'], from: [number, number], to: [number, number]): void {
  controller.handlePointerDown(atPoint(...from));
  controller.handlePointerMove(atPoint(...to));
  controller.handlePointerUp(atPoint(...to));
}

function points(boundary: LayeredTestBoundary) {
  const store = layerSurface(boundary.layeredDocument, SPECIALTY_LAYER_ID).pointStitches;
  return Array.from(store.ids, (id, index) => ({ x: store.x[index], y: store.y[index], color: store.colors[index], orientation: store.orientations[index] }));
}

describe('Move tool on knots and beads', () => {
  it('drags a knot to the snapped point under the pointer, previewing it there, and one undo restores it', () => {
    const { controller, boundary, uiStore } = pointFixture();
    place(boundary, 8, 8);
    const viewport = uiStore.getState().viewport;
    controller.handlePointerDown(atPoint(2, 2));
    controller.handlePointerMove(atPoint(4.1, 2.9));
    expect(uiStore.getState().overlay.pointStitchPreview).toMatchObject({ point: { x: 16, y: 12 }, paletteId: THREAD });
    expect(uiStore.getState().overlay.erasingPointStitchIds?.size).toBe(1);
    controller.handlePointerUp(atPoint(4.1, 2.9));
    expect(uiStore.getState().overlay.pointStitchPreview).toBeUndefined();
    expect(uiStore.getState().overlay.erasingPointStitchIds).toBeUndefined();
    expect(points(boundary)).toEqual([{ x: 16, y: 12, color: THREAD, orientation: 0 }]);
    expect(uiStore.getState().viewport).toEqual(viewport);

    controller.handleKeyDown({ key: 'z', ctrlKey: true, preventDefault: () => undefined });
    expect(points(boundary)).toEqual([{ x: 8, y: 8, color: THREAD, orientation: 0 }]);
    controller.dispose();
  });

  it('moves a bead onto a cell centre and keeps its orientation', () => {
    const { controller, boundary } = pointFixture();
    place(boundary, 8, 8, BEAD, 2);
    dragPoint(controller, [2, 2], [3.5, 4.5]);
    expect(points(boundary)).toEqual([{ x: 14, y: 18, color: BEAD, orientation: 2 }]);
    controller.dispose();
  });

  it('selects a knot on a tap and deletes it with Delete', () => {
    const { controller, boundary } = pointFixture();
    place(boundary, 8, 8);
    dragPoint(controller, [2, 2], [2, 2]);
    expect(points(boundary)).toHaveLength(1);
    controller.handleKeyDown({ key: 'Delete', preventDefault: () => undefined });
    expect(points(boundary)).toEqual([]);
    controller.dispose();
  });

  it('leaves a knot in place when it is dropped on another one', () => {
    const { controller, boundary } = pointFixture();
    place(boundary, 8, 8);
    place(boundary, 16, 8);
    const undoDepth = boundary.undoDepth;
    dragPoint(controller, [2, 2], [4, 2]);
    expect(points(boundary)).toEqual([{ x: 8, y: 8, color: THREAD, orientation: 0 }, { x: 16, y: 8, color: THREAD, orientation: 0 }]);
    expect(boundary.undoDepth).toBe(undoDepth);
    controller.dispose();
  });

  it('protects another color\'s bead under Focus Color', () => {
    const { controller, boundary, notices, uiStore } = pointFixture();
    place(boundary, 8, 8, BEAD);
    controller.selectPalette(THREAD);
    controller.setFocusColor(true);
    const viewport = uiStore.getState().viewport;
    dragPoint(controller, [2, 2], [4, 4]);
    expect(notices.at(-1)).toBe(FOCUS_COLOR_PROTECTED_HINT);
    expect(points(boundary)).toEqual([{ x: 8, y: 8, color: BEAD, orientation: 0 }]);
    expect(uiStore.getState().viewport).toEqual(viewport);
    controller.dispose();
  });

  it('picks a knot before the backstitch it sits on', () => {
    const { controller, boundary } = pointFixture();
    boundary.seed({ type: 'add-backstitch', start: { x: 8, y: 8 }, end: { x: 16, y: 8 }, color: THREAD });
    place(boundary, 12, 8);
    dragPoint(controller, [3, 2], [3, 4]);
    expect(points(boundary)).toEqual([{ x: 12, y: 16, color: THREAD, orientation: 0 }]);
    const layer = layerSurface(boundary.layeredDocument, SPECIALTY_LAYER_ID).backstitches;
    expect([layer.x1[0], layer.y1[0], layer.x2[layer.ids.length - 1], layer.y2[layer.ids.length - 1]]).toEqual([8, 8, 16, 8]);
    controller.dispose();
  });
});
