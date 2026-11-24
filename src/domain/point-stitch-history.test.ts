import { describe, expect, it } from 'vitest';
import {
  canvasResizeCommand,
  createEditorFromHistory,
  DocumentEditor,
  layerAddCommand,
  layerSetVisibilityCommand,
  LayerType,
  type LayeredDocument,
  type Point
} from './index';
import { createLayeredDocument, errorCode, specialtyLayer, SPECIALTY_LAYER_ID, TEST_CATALOG } from './test-fixtures';

const RED = 1;
const BLUE = 2;

function editor(): DocumentEditor {
  return new DocumentEditor(createLayeredDocument({
    width: 4,
    height: 3,
    catalog: TEST_CATALOG,
    palette: [
      { id: RED, name: 'Red', color: '#d33' },
      { id: BLUE, name: 'Blue', color: '#36c' }
    ]
  }));
}

function knot(target: DocumentEditor, point: Point, color = RED, layerId = SPECIALTY_LAYER_ID): void {
  target.execute({ type: 'add-point-stitch', point, color, layerId, orientation: 0 });
}

function points(document: LayeredDocument, layerId = SPECIALTY_LAYER_ID) {
  const store = specialtyLayer(document, layerId).pointStitches;
  return Array.from(store.ids, (id, index) => ({ id, x: store.x[index], y: store.y[index], color: store.colors[index], completed: store.completed[index] }));
}

describe('point stitch history', () => {
  it('round-trips knot add, remove and recolour through exported history', () => {
    const target = editor();
    knot(target, { x: 4, y: 4 });
    knot(target, { x: 6, y: 6 });
    target.execute({ type: 'remove-point-stitch', id: points(target.document)[0].id, layerId: SPECIALTY_LAYER_ID });
    target.execute({ type: 'palette-merge', from: RED, to: BLUE });
    const finalPoints = points(target.document);

    const restored = createEditorFromHistory(target.document, target.exportHistory());
    expect(restored.undoDepth).toBe(4);
    restored.undo();
    expect(points(restored.document).map((point) => point.color)).toEqual([RED]);
    restored.undo();
    expect(points(restored.document).map(({ x, y }) => ({ x, y }))).toEqual([{ x: 4, y: 4 }, { x: 6, y: 6 }]);
    restored.undo();
    restored.undo();
    expect(points(restored.document)).toEqual([]);
    for (let step = 0; step < 4; step += 1) restored.redo();
    expect(points(restored.document)).toEqual(finalPoints);
  });

  it('rejects history from before point stitches with the unsupported version code', () => {
    const target = editor();
    knot(target, { x: 4, y: 4 });
    const legacy = { ...target.exportHistory(), version: 2 } as unknown as ReturnType<DocumentEditor['exportHistory']>;
    expect(errorCode(() => new DocumentEditor(target.document).importHistory(legacy))).toBe('unsupported-history-version');
  });

  it('splits a mark by the topmost visible layer and ignores hidden layers', () => {
    const target = editor();
    target.execute(layerAddCommand(LayerType.Specialty, { id: 3 }));
    target.execute(layerAddCommand(LayerType.Specialty, { id: 4 }));
    knot(target, { x: 4, y: 4 }, RED, SPECIALTY_LAYER_ID);
    knot(target, { x: 8, y: 4 }, RED, 3);
    knot(target, { x: 8, y: 4 }, BLUE, 4);
    target.execute(layerSetVisibilityCommand(4, false));
    const [lower] = points(target.document);
    const [upper] = points(target.document, 3);
    const [hidden] = points(target.document, 4);

    const applied = target.applyProgress({ pointStitchIds: Uint32Array.of(lower.id, upper.id, hidden.id), operation: 'set' });

    expect(applied?.entry.parts.map((part) => ({ layerId: part.layerId, ids: Array.from(part.pointStitches?.ids ?? []) }))).toEqual([
      { layerId: SPECIALTY_LAYER_ID, ids: [lower.id] },
      { layerId: 3, ids: [upper.id] }
    ]);
    expect(points(target.document)[0].completed).toBe(1);
    expect(points(target.document, 3)[0].completed).toBe(1);
    expect(points(target.document, 4)[0].completed).toBe(0);
  });

  it('undoes and redoes a knot mark from its Track entry', () => {
    const target = editor();
    knot(target, { x: 4, y: 4 });
    const [placed] = points(target.document);
    const applied = target.applyProgress({ pointStitchIds: Uint32Array.of(placed.id), operation: 'toggle' });
    if (applied === null) throw new Error('The mark changed nothing.');
    expect(Array.from(applied.result.changedPointStitchIds ?? [])).toEqual([placed.id]);

    expect(target.applyProgressEntry(applied.entry, false).changed).toBe(true);
    expect(points(target.document)[0].completed).toBe(0);
    target.applyProgressEntry(applied.entry, true);
    expect(points(target.document)[0].completed).toBe(1);
  });

  it('drops a knot the canvas no longer covers and restores it on undo', () => {
    const target = editor();
    knot(target, { x: 2, y: 2 });
    knot(target, { x: 14, y: 6 });
    const before = points(target.document);

    target.execute(canvasResizeCommand({ top: 0, right: -1, bottom: 0, left: 0 }));
    expect(points(target.document).map(({ x, y }) => ({ x, y }))).toEqual([{ x: 2, y: 2 }]);

    target.undo();
    expect(points(target.document)).toEqual(before);
    const restored = createEditorFromHistory(target.document, target.exportHistory());
    restored.redo();
    expect(points(restored.document)).toHaveLength(1);
    restored.undo();
    expect(points(restored.document)).toEqual(before);
  });

  it('moves knots with the canvas when it grows on the left', () => {
    const target = editor();
    knot(target, { x: 2, y: 2 });
    target.execute(canvasResizeCommand({ top: 1, right: 0, bottom: 0, left: 1 }));
    expect(points(target.document).map(({ x, y }) => ({ x, y }))).toEqual([{ x: 6, y: 6 }]);
    expect(createEditorFromHistory(target.document, target.exportHistory()).undoDepth).toBe(2);
  });
});
