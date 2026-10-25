import { describe, expect, it } from 'vitest';
import { CellKind } from '../domain';
import { getCanvasMetrics } from './coordinates';
import type { EditorSurfaceController } from './controller';
import type { PointerSample } from './input';
import { at, drag, fixture as layeredFixture, LayeredTestBoundary, plainDocument } from './test-support';

const ZOOM = 16;
const WIDTH = 10;

/** A 10x10 layered workspace on its stitch layer that can switch to another project. */
function fixture() {
  const boundary = new LayeredTestBoundary(plainDocument(WIDTH, WIDTH));
  const { controller, uiStore } = layeredFixture(boundary, {
    ui: { viewport: { x: 0, y: 0, zoom: ZOOM }, tool: { tool: 'select' } },
    controller: { metrics: getCanvasMetrics(320, 320) }
  });
  const switchProject = (): void => boundary.open(plainDocument(4, 4), 'project-b');
  // Edits land on the selected layer, so read the cell from it.
  const kind = (x: number, y: number) => boundary.activeLayerSurface()!.kind[y * WIDTH + x];
  return { boundary, controller, uiStore, switchProject, kind };
}



function click(controller: EditorSurfaceController, x: number, y: number): void {
  controller.handlePointerDown(at(1, x, y));
  controller.handlePointerUp(at(1, x, y));
}

/** Lasso one cell by clicking its corners and then its first corner again, which closes the path. */
function lassoCell(controller: EditorSurfaceController, x: number, y: number, extra: Partial<PointerSample> = {}): void {
  const corners = [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]];
  corners.forEach(([cornerX, cornerY], index) => {
    const sample: PointerSample = { pointerId: index + 1, pointerType: 'mouse', screenX: cornerX * ZOOM, screenY: cornerY * ZOOM, button: 0, buttons: 1, isPrimary: true, ...(index === 0 ? extra : {}) };
    controller.handlePointerDown(sample);
    controller.handlePointerUp({ ...sample, buttons: 0 });
  });
}

const prevent = () => undefined;
const undo = (controller: EditorSurfaceController) => controller.handleKeyDown({ key: 'z', ctrlKey: true, preventDefault: prevent });
const redo = (controller: EditorSurfaceController) => controller.handleKeyDown({ key: 'z', ctrlKey: true, shiftKey: true, preventDefault: prevent });
const redoY = (controller: EditorSurfaceController) => controller.handleKeyDown({ key: 'y', ctrlKey: true, preventDefault: prevent });

describe('selection history', () => {
  it('undoes and redoes a marquee drag', () => {
    const { controller } = fixture();
    drag(controller, { x: 1, y: 1 }, { x: 3, y: 3 });
    expect(controller.getSelection()).toEqual({ x: 1, y: 1, width: 3, height: 3 });
    undo(controller);
    expect(controller.getSelection()).toBeUndefined();
    redo(controller);
    expect(controller.getSelection()).toEqual({ x: 1, y: 1, width: 3, height: 3 });
    undo(controller);
    expect(controller.getSelection()).toBeUndefined();
    redoY(controller);
    expect(controller.getSelection()).toEqual({ x: 1, y: 1, width: 3, height: 3 });
    controller.dispose();
  });

  it('restores the first marquee when the second is undone', () => {
    const { controller } = fixture();
    drag(controller, { x: 1, y: 1 }, { x: 3, y: 3 });
    drag(controller, { x: 5, y: 5 }, { x: 7, y: 6 });
    expect(controller.getSelection()).toEqual({ x: 5, y: 5, width: 3, height: 2 });
    undo(controller);
    expect(controller.getSelection()).toEqual({ x: 1, y: 1, width: 3, height: 3 });
    undo(controller);
    expect(controller.getSelection()).toBeUndefined();
    redo(controller);
    redo(controller);
    expect(controller.getSelection()).toEqual({ x: 5, y: 5, width: 3, height: 2 });
    controller.dispose();
  });

  it('restores a selection cleared by Escape', () => {
    const { controller } = fixture();
    drag(controller, { x: 1, y: 1 }, { x: 3, y: 3 });
    controller.handleKeyDown({ key: 'Escape', preventDefault: prevent });
    expect(controller.getSelection()).toBeUndefined();
    undo(controller);
    expect(controller.getSelection()).toEqual({ x: 1, y: 1, width: 3, height: 3 });
    redo(controller);
    expect(controller.getSelection()).toBeUndefined();
    controller.dispose();
  });

  it('records setSelection and clearSelection as steps', () => {
    const { controller } = fixture();
    controller.setSelection({ x: 2, y: 2 }, { x: 3, y: 3 });
    controller.clearSelection();
    undo(controller);
    expect(controller.getSelection()).toEqual({ x: 2, y: 2, width: 2, height: 2 });
    undo(controller);
    expect(controller.getSelection()).toBeUndefined();
    controller.dispose();
  });

  it('interleaves a paint stroke and its selection in one timeline', () => {
    const { controller, kind } = fixture();
    drag(controller, { x: 1, y: 1 }, { x: 3, y: 3 });
    controller.setTool({ tool: 'paint', brush: { kind: 'full', paletteId: 1 } });
    click(controller, 2, 2);
    expect(kind(2, 2)).toBe(CellKind.Full);

    undo(controller);
    expect(kind(2, 2)).toBe(CellKind.Empty);
    expect(controller.getSelection()).toEqual({ x: 1, y: 1, width: 3, height: 3 });
    undo(controller);
    expect(controller.getSelection()).toBeUndefined();

    redo(controller);
    expect(controller.getSelection()).toEqual({ x: 1, y: 1, width: 3, height: 3 });
    expect(kind(2, 2)).toBe(CellKind.Empty);
    redo(controller);
    expect(kind(2, 2)).toBe(CellKind.Full);
    expect(controller.getSelection()).toEqual({ x: 1, y: 1, width: 3, height: 3 });
    controller.dispose();
  });

  it('records no step for a click that keeps the selection', () => {
    const { controller, kind } = fixture();
    controller.setTool({ tool: 'paint', brush: { kind: 'full', paletteId: 1 } });
    click(controller, 8, 8);
    controller.setTool({ tool: 'select' });
    drag(controller, { x: 1, y: 1 }, { x: 3, y: 3 });
    click(controller, 6, 6);
    expect(controller.getSelection()).toEqual({ x: 1, y: 1, width: 3, height: 3 });

    undo(controller);
    expect(controller.getSelection()).toBeUndefined();
    expect(kind(8, 8)).toBe(CellKind.Full);
    undo(controller);
    expect(kind(8, 8)).toBe(CellKind.Empty);
    controller.dispose();
  });

  it('undoes lasso union and subtract steps one at a time', () => {
    const { controller } = fixture();
    controller.setTool({ tool: 'lasso' });
    lassoCell(controller, 0, 0);
    lassoCell(controller, 2, 0, { shiftKey: true });
    lassoCell(controller, 0, 0, { altKey: true });
    expect(Array.from(controller.getSelectionIndices() ?? [])).toEqual([2]);

    undo(controller);
    expect(Array.from(controller.getSelectionIndices() ?? [])).toEqual([0, 2]);
    undo(controller);
    expect(Array.from(controller.getSelectionIndices() ?? [])).toEqual([0]);
    undo(controller);
    expect(controller.getSelectionIndices()).toBeUndefined();

    redo(controller);
    redo(controller);
    expect(Array.from(controller.getSelectionIndices() ?? [])).toEqual([0, 2]);
    redo(controller);
    expect(Array.from(controller.getSelectionIndices() ?? [])).toEqual([2]);
    controller.dispose();
  });

  it('undoes Shift+arrow extension', () => {
    const { controller } = fixture();
    controller.handleFocus();
    controller.handleKeyDown({ key: 'ArrowRight', shiftKey: true, preventDefault: prevent });
    controller.handleKeyDown({ key: 'ArrowDown', shiftKey: true, preventDefault: prevent });
    const extended = controller.getSelection();
    expect(extended).toEqual({ x: 0, y: 0, width: 2, height: 2 });

    undo(controller);
    expect(controller.getSelection()).toEqual({ x: 0, y: 0, width: 2, height: 1 });
    undo(controller);
    expect(controller.getSelection()).toBeUndefined();
    redo(controller);
    redo(controller);
    expect(controller.getSelection()).toEqual(extended);
    controller.dispose();
  });

  it('restores both the cells and the selection with one undo after deleting the selection', () => {
    const { controller, kind } = fixture();
    controller.setTool({ tool: 'paint', brush: { kind: 'full', paletteId: 1 } });
    click(controller, 2, 2);
    click(controller, 3, 3);
    controller.setTool({ tool: 'select' });
    drag(controller, { x: 1, y: 1 }, { x: 4, y: 4 });
    expect(controller.deleteSelection()).toBe(true);
    expect(kind(2, 2)).toBe(CellKind.Empty);
    expect(controller.getSelection()).toBeUndefined();

    undo(controller);
    expect(kind(2, 2)).toBe(CellKind.Full);
    expect(kind(3, 3)).toBe(CellKind.Full);
    expect(controller.getSelection()).toEqual({ x: 1, y: 1, width: 4, height: 4 });

    redo(controller);
    expect(kind(2, 2)).toBe(CellKind.Empty);
    expect(controller.getSelection()).toBeUndefined();
    controller.dispose();
  });

  it('clears the redo timeline when a new selection follows an undo', () => {
    const { controller } = fixture();
    drag(controller, { x: 1, y: 1 }, { x: 3, y: 3 });
    undo(controller);
    expect(controller.getSelection()).toBeUndefined();
    drag(controller, { x: 5, y: 5 }, { x: 6, y: 6 });
    redo(controller);
    expect(controller.getSelection()).toEqual({ x: 5, y: 5, width: 2, height: 2 });
    undo(controller);
    expect(controller.getSelection()).toBeUndefined();
    controller.dispose();
  });

  it('does not redo a paint after a new selection follows its undo', () => {
    const { controller, kind } = fixture();
    drag(controller, { x: 1, y: 1 }, { x: 3, y: 3 });
    controller.setTool({ tool: 'paint', brush: { kind: 'full', paletteId: 1 } });
    click(controller, 2, 2);
    undo(controller);
    expect(kind(2, 2)).toBe(CellKind.Empty);
    controller.setTool({ tool: 'select' });
    drag(controller, { x: 5, y: 5 }, { x: 6, y: 6 });

    redo(controller);
    expect(kind(2, 2)).toBe(CellKind.Empty);
    expect(controller.getSelection()).toEqual({ x: 5, y: 5, width: 2, height: 2 });
    redoY(controller);
    expect(kind(2, 2)).toBe(CellKind.Empty);
    controller.dispose();
  });

  it('clears the timeline on a project switch', () => {
    const { controller, switchProject } = fixture();
    drag(controller, { x: 1, y: 1 }, { x: 2, y: 2 });
    undo(controller);
    drag(controller, { x: 1, y: 1 }, { x: 2, y: 2 });
    switchProject();
    expect(controller.getSelection()).toBeUndefined();
    undo(controller);
    expect(controller.getSelection()).toBeUndefined();
    redo(controller);
    expect(controller.getSelection()).toBeUndefined();
    controller.dispose();
  });
});
