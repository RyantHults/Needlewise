import { describe, expect, it } from 'vitest';
import {
  BEAD_ORIENTATIONS,
  createDocument,
  createEditorFromHistory,
  createPatternFragment,
  DocumentEditor,
  pointStitchesFromRecords,
  type BeadOrientation,
  type Point
} from './index';
import { createLayeredDocument, errorCode, specialtyLayer, SPECIALTY_LAYER_ID, TEST_CATALOG } from './test-fixtures';
import { millHillBeadEntry } from '../catalog/test-support';

const RED = 1;
const BEAD = 2;
const OTHER_BEAD = 3;
const palette = [{ id: RED, name: 'Red', color: '#d33' }, millHillBeadEntry(BEAD), millHillBeadEntry(OTHER_BEAD, '00020')];

function editor(): DocumentEditor {
  return new DocumentEditor(createLayeredDocument({ width: 4, height: 3, catalog: TEST_CATALOG, palette }));
}

function place(target: DocumentEditor, point: Point, color = BEAD, orientation: BeadOrientation = BEAD_ORIENTATIONS.Slash): void {
  target.execute({ type: 'add-point-stitch', point, color, orientation, layerId: SPECIALTY_LAYER_ID });
}

function orient(target: DocumentEditor, id: number, orientation: BeadOrientation) {
  return target.execute({ type: 'set-point-stitch-orientation', id, orientation, layerId: SPECIALTY_LAYER_ID });
}

function points(target: DocumentEditor) {
  const store = specialtyLayer(target.document).pointStitches;
  return Array.from(store.ids, (id, index) => ({ id, x: store.x[index], y: store.y[index], color: store.colors[index], orientation: store.orientations[index], completed: store.completed[index] }));
}

describe('bead orientation', () => {
  it('rotates a bead through all four orientations and undoes each turn', () => {
    const target = editor();
    place(target, { x: 4, y: 4 });
    const turns: BeadOrientation[] = [BEAD_ORIENTATIONS.Vertical, BEAD_ORIENTATIONS.Backslash, BEAD_ORIENTATIONS.Horizontal, BEAD_ORIENTATIONS.Slash];
    for (const orientation of turns) {
      expect(Array.from(orient(target, 1, orientation).changedPointStitchIds ?? [])).toEqual([1]);
      expect(points(target)[0].orientation).toBe(orientation);
    }
    target.undo();
    expect(points(target)[0].orientation).toBe(BEAD_ORIENTATIONS.Horizontal);
    target.undo();
    target.undo();
    target.undo();
    expect(points(target)[0].orientation).toBe(BEAD_ORIENTATIONS.Slash);
    target.redo();
    expect(points(target)[0].orientation).toBe(BEAD_ORIENTATIONS.Vertical);
  });

  it('rejects an orientation for a French knot', () => {
    const target = editor();
    expect(errorCode(() => place(target, { x: 4, y: 4 }, RED, BEAD_ORIENTATIONS.Vertical))).toBe('invalid-point-stitch');
    place(target, { x: 4, y: 4 }, RED);
    expect(errorCode(() => orient(target, 1, BEAD_ORIENTATIONS.Vertical))).toBe('invalid-point-stitch');
  });

  it('treats turning a bead to the orientation it already has as a duplicate', () => {
    const target = editor();
    place(target, { x: 4, y: 4 }, BEAD, BEAD_ORIENTATIONS.Backslash);
    expect(errorCode(() => orient(target, 1, BEAD_ORIENTATIONS.Backslash))).toBe('duplicate-point-stitch');
    expect(target.undoDepth).toBe(1);
  });

  it('keeps a bead\'s completion when it turns', () => {
    const target = editor();
    place(target, { x: 4, y: 4 });
    target.applyProgress({ pointStitchIds: Uint32Array.of(1), operation: 'set' });
    orient(target, 1, BEAD_ORIENTATIONS.Horizontal);
    expect(points(target)[0]).toMatchObject({ orientation: BEAD_ORIENTATIONS.Horizontal, completed: 1 });
    target.undo();
    expect(points(target)[0]).toMatchObject({ orientation: BEAD_ORIENTATIONS.Slash, completed: 1 });
  });

  it('keeps the orientation when a bead is recoloured to another bead, and lays a knot at 0', () => {
    const target = editor();
    place(target, { x: 4, y: 4 }, BEAD, BEAD_ORIENTATIONS.Vertical);
    place(target, { x: 4, y: 4 }, OTHER_BEAD);
    expect(points(target)[0]).toMatchObject({ color: OTHER_BEAD, orientation: BEAD_ORIENTATIONS.Vertical });
    place(target, { x: 4, y: 4 }, RED);
    expect(points(target)[0]).toMatchObject({ color: RED, orientation: 0 });
  });

  it('lays a bead placed over a knot in the orientation it was placed with', () => {
    const target = editor();
    place(target, { x: 4, y: 4 }, RED);
    place(target, { x: 4, y: 4 }, BEAD, BEAD_ORIENTATIONS.Backslash);
    expect(points(target)[0]).toMatchObject({ color: BEAD, orientation: BEAD_ORIENTATIONS.Backslash });
  });

  it('keeps orientation when a bead moves alone or with a selection', () => {
    const target = editor();
    place(target, { x: 2, y: 2 }, BEAD, BEAD_ORIENTATIONS.Backslash);
    target.execute({ type: 'move-point-stitch', id: 1, dx: 4, dy: 0, layerId: SPECIALTY_LAYER_ID });
    expect(points(target)[0]).toMatchObject({ x: 6, orientation: BEAD_ORIENTATIONS.Backslash });
    target.execute({ type: 'move-fragment', selection: { x: 1, y: 0, width: 1, height: 1 }, destination: { x: 2, y: 1 }, layerId: SPECIALTY_LAYER_ID });
    expect(points(target)[0]).toMatchObject({ x: 10, y: 6, orientation: BEAD_ORIENTATIONS.Backslash });
  });

  it('keeps orientation through copy and paste', () => {
    const source = createDocument({ width: 4, height: 3, catalog: TEST_CATALOG, palette });
    source.pointStitches = pointStitchesFromRecords([{ id: 1, x: 6, y: 6, color: BEAD, completed: false, orientation: BEAD_ORIENTATIONS.Horizontal }]);
    source.nextBackstitchId = 2;
    const fragment = createPatternFragment(source, { x: 1, y: 1, width: 1, height: 1 });
    const target = editor();
    target.execute({ type: 'paste-fragment', fragment, destination: { x: 0, y: 0 }, layerId: SPECIALTY_LAYER_ID });
    expect(points(target)).toEqual([{ id: 1, x: 2, y: 2, color: BEAD, orientation: BEAD_ORIENTATIONS.Horizontal, completed: 0 }]);
  });

  it('round-trips orientation turns through exported history', () => {
    const target = editor();
    place(target, { x: 4, y: 4 }, BEAD, BEAD_ORIENTATIONS.Vertical);
    orient(target, 1, BEAD_ORIENTATIONS.Horizontal);
    const restored = createEditorFromHistory(target.document, target.exportHistory());
    restored.undo();
    expect(points(restored)[0].orientation).toBe(BEAD_ORIENTATIONS.Vertical);
    restored.undo();
    restored.redo();
    restored.redo();
    expect(points(restored)[0].orientation).toBe(BEAD_ORIENTATIONS.Horizontal);
  });
});
