import { describe, expect, it } from 'vitest';
import {
  DocumentEditor,
  MaterialKind,
  MaterialUnit,
  type DomainCommand,
  type LayeredDocument,
  type Point
} from './index';
import { cell, createLayeredDocument, errorCode, specialtyLayer, SPECIALTY_LAYER_ID, STITCH_LAYER_ID, TEST_CATALOG } from './test-fixtures';

const RED = 1;
const BLUE = 2;
const BEAD = 3;

function layered(canvasMask?: Uint8Array): LayeredDocument {
  const document = createLayeredDocument({
    width: 4,
    height: 3,
    catalog: TEST_CATALOG,
    palette: [
      { id: RED, name: 'Red', color: '#d33' },
      { id: BLUE, name: 'Blue', color: '#36c' },
      {
        id: BEAD,
        name: 'Bead',
        color: '#123456',
        catalog: { catalogId: TEST_CATALOG.catalogId, sourceId: 'bead', code: '00123', name: 'Test bead', hex: '#123456', rgb: [18, 52, 86] },
        material: { kind: MaterialKind.Bead, label: 'Test bead', unit: MaterialUnit.Count }
      }
    ]
  });
  return canvasMask === undefined ? document : { ...document, canvasMask };
}

function editor(canvasMask?: Uint8Array): DocumentEditor {
  return new DocumentEditor(layered(canvasMask));
}

function place(target: DocumentEditor, point: Point, color: number, layerId = SPECIALTY_LAYER_ID) {
  return target.execute({ type: 'add-point-stitch', point, color, layerId, orientation: 0 });
}

function points(target: DocumentEditor) {
  const store = specialtyLayer(target.document).pointStitches;
  return Array.from(store.ids, (id, index) => ({ id, x: store.x[index], y: store.y[index], color: store.colors[index], completed: store.completed[index] }));
}

describe('point stitch commands', () => {
  it('places knots and beads on corners and centres, allocating specialty ids', () => {
    const target = editor();
    target.execute({ type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: RED, layerId: SPECIALTY_LAYER_ID });
    expect(Array.from(place(target, { x: 4, y: 4 }, RED).changedPointStitchIds ?? [])).toEqual([2]);
    place(target, { x: 6, y: 2 }, BEAD);
    expect(points(target)).toEqual([
      { id: 2, x: 4, y: 4, color: RED, completed: 0 },
      { id: 3, x: 6, y: 2, color: BEAD, completed: 0 }
    ]);
    expect(target.document.nextBackstitchId).toBe(4);
    expect(Array.from(target.composite.pointStitches.ids)).toEqual([2, 3]);
  });

  it('rejects edge midpoints, positions off the canvas and stitch layers', () => {
    const target = editor();
    expect(errorCode(() => place(target, { x: 2, y: 0 }, RED))).toBe('invalid-point-stitch');
    expect(errorCode(() => place(target, { x: 18, y: 2 }, RED))).toBe('out-of-bounds');
    expect(errorCode(() => place(target, { x: 4, y: 4 }, RED, STITCH_LAYER_ID))).toBe('layer-type-mismatch');

    const canvasMask = new Uint8Array(12).fill(1);
    canvasMask[5] = 0;
    const masked = editor(canvasMask);
    expect(errorCode(() => place(masked, { x: 6, y: 6 }, RED))).toBe('outside-canvas');
    place(masked, { x: 4, y: 4 }, RED);
    expect(points(masked)).toHaveLength(1);
  });

  it('recolours an occupied point and clears its progress; the same colour is a duplicate even when completed', () => {
    const target = editor();
    place(target, { x: 4, y: 4 }, RED);
    expect(errorCode(() => place(target, { x: 4, y: 4 }, RED))).toBe('duplicate-point-stitch');
    target.applyProgress({ pointStitchIds: Uint32Array.of(1), operation: 'set' });
    expect(errorCode(() => place(target, { x: 4, y: 4 }, RED))).toBe('duplicate-point-stitch');
    expect(points(target)).toEqual([{ id: 1, x: 4, y: 4, color: RED, completed: 1 }]);
    place(target, { x: 4, y: 4 }, BLUE);
    expect(points(target)).toEqual([{ id: 1, x: 4, y: 4, color: BLUE, completed: 0 }]);
    place(target, { x: 4, y: 4 }, BEAD);
    expect(points(target)).toEqual([{ id: 1, x: 4, y: 4, color: BEAD, completed: 0 }]);
    expect(target.document.nextBackstitchId).toBe(2);
  });

  it('moves a point keeping its id and completion, and undo restores it', () => {
    const target = editor();
    place(target, { x: 4, y: 4 }, RED);
    target.applyProgress({ pointStitchIds: Uint32Array.of(1), operation: 'set' });
    const moved = target.execute({ type: 'move-point-stitch', id: 1, dx: 2, dy: -2, layerId: SPECIALTY_LAYER_ID });
    expect(Array.from(moved.changedPointStitchIds ?? [])).toEqual([1]);
    expect(points(target)).toEqual([{ id: 1, x: 6, y: 2, color: RED, completed: 1 }]);
    target.undo();
    expect(points(target)).toEqual([{ id: 1, x: 4, y: 4, color: RED, completed: 1 }]);
    target.redo();
    expect(points(target)).toEqual([{ id: 1, x: 6, y: 2, color: RED, completed: 1 }]);
  });

  it('rejects a point move onto another point, off the grid or off the canvas', () => {
    const target = editor();
    place(target, { x: 4, y: 4 }, RED);
    place(target, { x: 8, y: 4 }, BLUE);
    const move = (dx: number, dy: number) => target.execute({ type: 'move-point-stitch', id: 1, dx, dy, layerId: SPECIALTY_LAYER_ID });
    expect(errorCode(() => move(4, 0))).toBe('point-stitch-collision');
    expect(errorCode(() => move(2, 0))).toBe('invalid-point-stitch');
    expect(errorCode(() => move(16, 0))).toBe('out-of-bounds');
    expect(points(target).map(({ x, y }) => ({ x, y }))).toEqual([{ x: 4, y: 4 }, { x: 8, y: 4 }]);
    expect(target.undoDepth).toBe(2);
  });

  it('removes a point, and undo and redo restore it', () => {
    const target = editor();
    place(target, { x: 4, y: 4 }, RED);
    target.execute({ type: 'remove-point-stitch', id: 1, layerId: SPECIALTY_LAYER_ID });
    expect(points(target)).toEqual([]);
    target.undo();
    expect(points(target)).toEqual([{ id: 1, x: 4, y: 4, color: RED, completed: 0 }]);
    target.undo();
    expect(points(target)).toEqual([]);
    target.redo();
    target.redo();
    expect(points(target)).toEqual([]);
    target.undo();
    expect(Array.from(target.composite.pointStitches.ids)).toEqual([1]);
  });

  it('keeps a point\'s progress through undo of a later edit', () => {
    const target = editor();
    place(target, { x: 4, y: 4 }, RED);
    place(target, { x: 8, y: 8 }, BLUE);
    specialtyLayer(target.document).pointStitches.completed[0] = 1;
    target.undo();
    expect(points(target)).toEqual([{ id: 1, x: 4, y: 4, color: RED, completed: 1 }]);
    target.redo();
    expect(points(target).map((point) => point.completed)).toEqual([1, 0]);
  });

  it('keeps beads off cells and backstitches', () => {
    const target = editor();
    expect(errorCode(() => target.execute({ ...cell(4, { type: 'set-full', x: 0, y: 0, color: BEAD }), layerId: STITCH_LAYER_ID }))).toBe('palette-material-mismatch');
    expect(errorCode(() => target.execute({ type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: BEAD, layerId: SPECIALTY_LAYER_ID }))).toBe('palette-material-mismatch');
    target.execute({ ...cell(4, { type: 'set-full', x: 0, y: 0, color: RED }), layerId: STITCH_LAYER_ID });
    expect(errorCode(() => target.execute({ type: 'bulk-recolor', indices: new Uint32Array([0]), masks: new Uint8Array([1]), fromColor: RED, toColor: BEAD, layerId: STITCH_LAYER_ID }))).toBe('palette-material-mismatch');
  });

  it('refuses to merge a bead with a thread, and merges threads on points', () => {
    const target = editor();
    place(target, { x: 4, y: 4 }, RED);
    expect(errorCode(() => target.execute({ type: 'palette-merge', from: RED, to: BEAD }))).toBe('palette-material-mismatch');
    expect(errorCode(() => target.execute({ type: 'palette-merge', from: BEAD, to: BLUE }))).toBe('palette-material-mismatch');
    target.execute({ type: 'palette-merge', from: RED, to: BLUE });
    expect(points(target).map((point) => point.color)).toEqual([BLUE]);
  });

  it('removes the points of a deleted palette entry, and undo restores them', () => {
    const target = editor();
    place(target, { x: 4, y: 4 }, BEAD);
    place(target, { x: 6, y: 6 }, RED);
    target.execute({ type: 'palette-delete', id: BEAD });
    expect(points(target).map((point) => point.color)).toEqual([RED]);
    target.undo();
    expect(points(target).map((point) => point.color)).toEqual([BEAD, RED]);
  });

  it('keeps point completion out of the pattern editor', () => {
    const target = editor();
    place(target, { x: 4, y: 4 }, RED);
    const command: DomainCommand = { type: 'bulk-point-stitch-completion', ids: new Uint32Array([1]), operation: 'set', layerId: SPECIALTY_LAYER_ID };
    expect(errorCode(() => target.execute(command))).toBe('invalid-command');
  });
});
