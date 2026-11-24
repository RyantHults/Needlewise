import { describe, expect, it } from 'vitest';
import {
  DocumentEditor,
  LayerType,
  MaterialKind,
  createDocument,
  createPatternFragment,
  fragmentLayerRequirement,
  fragmentPaletteIds,
  normalizePaletteEntry,
  planPastePalette,
  pointStitchesFromRecords,
  remapFragmentColors,
  type LayeredDocument,
  type PatternDocument,
  type PatternFragment,
  type Point
} from './index';
import { createLayeredDocument, errorCode, specialtyLayer, SPECIALTY_LAYER_ID, STITCH_LAYER_ID, TEST_CATALOG } from './test-fixtures';
import { millHillBeadEntry } from '../catalog/test-support';

const RED = 1;
const BEAD = 2;
const palette = [{ id: RED, name: 'Red', color: '#d33' }, millHillBeadEntry(BEAD)];

/** A 4x3 single-surface document holding `points` as knots in RED. */
function surface(points: readonly Point[]): PatternDocument {
  const document = createDocument({ width: 4, height: 3, catalog: TEST_CATALOG, palette });
  document.pointStitches = pointStitchesFromRecords(points.map((point, index) => ({ id: index + 1, x: point.x, y: point.y, color: RED, completed: false, orientation: 0 })));
  document.nextBackstitchId = points.length + 1;
  return document;
}

function fragmentPoints(fragment: PatternFragment): Point[] {
  return Array.from(fragment.pointStitches.x, (x, index) => ({ x, y: fragment.pointStitches.y[index] }));
}

function editor(): DocumentEditor {
  const document: LayeredDocument = createLayeredDocument({ width: 4, height: 3, catalog: TEST_CATALOG, palette });
  return new DocumentEditor(document);
}

function place(target: DocumentEditor, point: Point, color = RED): void {
  target.execute({ type: 'add-point-stitch', point, color, layerId: SPECIALTY_LAYER_ID, orientation: 0 });
}

function points(target: DocumentEditor) {
  const store = specialtyLayer(target.document).pointStitches;
  return Array.from(store.ids, (id, index) => ({ id, x: store.x[index], y: store.y[index], color: store.colors[index] }));
}

describe('point stitches in fragments', () => {
  it('captures knots on a rect selection border, rebased to the fragment origin', () => {
    // Rect cells (1,1)-(2,1): its corners run x 4..12, y 4..8.
    const document = surface([{ x: 4, y: 4 }, { x: 12, y: 8 }, { x: 6, y: 6 }, { x: 2, y: 2 }, { x: 16, y: 4 }]);
    const fragment = createPatternFragment(document, { x: 1, y: 1, width: 2, height: 1 });
    expect(fragmentPoints(fragment)).toEqual([{ x: 0, y: 0 }, { x: 8, y: 4 }, { x: 2, y: 2 }]);
    expect(fragmentLayerRequirement(fragment)).toBe(LayerType.Specialty);
  });

  it('captures a sparse selection by the closed cell-union rule', () => {
    // Cells (0,0) and (1,1) touch only at the corner (4,4).
    const document = surface([{ x: 4, y: 4 }, { x: 8, y: 8 }, { x: 2, y: 2 }, { x: 10, y: 6 }, { x: 8, y: 0 }]);
    const fragment = createPatternFragment(document, { kind: 'sparse', rect: { x: 0, y: 0, width: 2, height: 2 }, indices: Uint32Array.of(0, 5) });
    expect(fragmentPoints(fragment)).toEqual([{ x: 4, y: 4 }, { x: 8, y: 8 }, { x: 2, y: 2 }]);
  });

  it('pastes points alone onto a specialty layer with fresh ids, and a stitch layer refuses them', () => {
    const target = editor();
    place(target, { x: 0, y: 0 });
    const fragment = createPatternFragment(surface([{ x: 4, y: 4 }, { x: 6, y: 6 }]), { x: 1, y: 1, width: 1, height: 1 });
    const result = target.execute({ type: 'paste-fragment', fragment, destination: { x: 2, y: 0 }, layerId: SPECIALTY_LAYER_ID });
    expect(Array.from(result.changedPointStitchIds ?? [])).toEqual([2, 3]);
    expect(points(target)).toEqual([
      { id: 1, x: 0, y: 0, color: RED },
      { id: 2, x: 8, y: 0, color: RED },
      { id: 3, x: 10, y: 2, color: RED }
    ]);
    expect(errorCode(() => target.execute({ type: 'paste-fragment', fragment, destination: { x: 0, y: 1 }, layerId: STITCH_LAYER_ID }))).toBe('layer-type-mismatch');
    target.undo();
    expect(points(target)).toEqual([{ id: 1, x: 0, y: 0, color: RED }]);
  });

  it('rejects a paste that lands a knot on an existing one', () => {
    const target = editor();
    place(target, { x: 8, y: 0 });
    const fragment = createPatternFragment(surface([{ x: 4, y: 4 }]), { x: 1, y: 1, width: 1, height: 1 });
    expect(errorCode(() => target.execute({ type: 'paste-fragment', fragment, destination: { x: 2, y: 0 }, layerId: SPECIALTY_LAYER_ID }))).toBe('duplicate-point-stitch');
  });

  it('pastes a bead into another pattern as a new bead entry, never onto a thread of the same hex', () => {
    const bead = normalizePaletteEntry(millHillBeadEntry(7));
    const target = createDocument({ width: 4, height: 3, catalog: TEST_CATALOG, palette: [{ id: 1, name: 'Look-alike', color: bead.color }] });
    const plan = planPastePalette(target, [bead]);
    const [created] = plan.creates;
    expect(plan.creates).toHaveLength(1);
    expect(created?.material?.kind).toBe(MaterialKind.Bead);
    expect(created?.catalog).toEqual(bead.catalog);
    expect(plan.idMap.get(7)).toBe(2);

    const source = createDocument({ width: 4, height: 3, catalog: TEST_CATALOG, palette: [millHillBeadEntry(7)] });
    source.pointStitches = pointStitchesFromRecords([{ id: 1, x: 4, y: 4, color: 7, completed: false, orientation: 0 }]);
    source.nextBackstitchId = 2;
    const fragment = createPatternFragment(source, { x: 1, y: 1, width: 1, height: 1 });
    expect(fragmentPaletteIds(fragment)).toEqual([7]);
    expect(Array.from(remapFragmentColors(fragment, plan.idMap).pointStitches.colors)).toEqual([2]);
  });

  it('moves contained points with the selection, and undo puts them back', () => {
    const target = editor();
    place(target, { x: 4, y: 4 });
    place(target, { x: 2, y: 2 }, BEAD);
    place(target, { x: 14, y: 10 });
    target.execute({ type: 'move-fragment', selection: { x: 0, y: 0, width: 1, height: 1 }, destination: { x: 1, y: 1 }, layerId: SPECIALTY_LAYER_ID });
    expect(points(target)).toEqual([
      { id: 1, x: 8, y: 8, color: RED },
      { id: 2, x: 6, y: 6, color: BEAD },
      { id: 3, x: 14, y: 10, color: RED }
    ]);
    target.undo();
    expect(points(target).map(({ x, y }) => ({ x, y }))).toEqual([{ x: 4, y: 4 }, { x: 2, y: 2 }, { x: 14, y: 10 }]);
  });

  it('rejects a move that lands a point on one outside the selection', () => {
    const target = editor();
    place(target, { x: 2, y: 2 });
    place(target, { x: 6, y: 2 });
    expect(errorCode(() => target.execute({ type: 'move-fragment', selection: { x: 0, y: 0, width: 1, height: 1 }, destination: { x: 1, y: 0 }, layerId: SPECIALTY_LAYER_ID }))).toBe('point-stitch-collision');
  });

  it('deletes only the points a region or cell set contains', () => {
    const target = editor();
    for (const point of [{ x: 4, y: 4 }, { x: 6, y: 6 }, { x: 2, y: 2 }, { x: 12, y: 4 }]) place(target, point);
    target.execute({ type: 'delete-region', x: 1, y: 1, width: 1, height: 1, layerId: SPECIALTY_LAYER_ID });
    expect(points(target).map(({ x, y }) => ({ x, y }))).toEqual([{ x: 2, y: 2 }, { x: 12, y: 4 }]);
    target.execute({ type: 'delete-cell-set', indices: Uint32Array.of(0), layerId: SPECIALTY_LAYER_ID });
    expect(points(target).map(({ x, y }) => ({ x, y }))).toEqual([{ x: 12, y: 4 }]);
    target.undo();
    target.undo();
    expect(points(target)).toHaveLength(4);
  });
});
