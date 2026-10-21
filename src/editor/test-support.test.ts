import { describe, expect, it } from 'vitest';
import { CellKind, findLayer, LayerType, createPatternFragment, layerSurface, type StitchLayer } from '../domain';
import { SPECIALTY_LAYER_ID, STITCH_LAYER_ID } from '../domain/test-fixtures';
import { drag, fixture, LayeredTestBoundary, layeredDocument, plainDocument } from './test-support';

describe('LayeredTestBoundary', () => {
  it('opens a flat document on the default layers with the stitch layer selected', () => {
    const boundary = new LayeredTestBoundary(plainDocument());
    expect(boundary.layeredDocument.layers.map((layer) => layer.type)).toEqual([LayerType.Stitch, LayerType.Specialty]);
    expect(boundary.activeLayerId).toBe(STITCH_LAYER_ID);
    expect(boundary.selectedLayerIds).toEqual([STITCH_LAYER_ID]);
  });

  it('runs a controller stroke on the selected layer as one undo step', () => {
    const { boundary, controller } = fixture();
    drag(controller, { x: 0, y: 0 }, { x: 2, y: 0 });
    const stitches = findLayer(boundary.layeredDocument, STITCH_LAYER_ID) as StitchLayer;
    expect(Array.from(stitches.kind.slice(0, 3))).toEqual([CellKind.Full, CellKind.Full, CellKind.Full]);
    expect(boundary.document.kind[0]).toBe(CellKind.Full);
    expect(boundary.undoDepth).toBe(1);
    boundary.undo();
    expect(boundary.document.kind[0]).toBe(CellKind.Empty);
    controller.dispose();
  });

  it('refuses a layer edit on Canvas and a stitch edit on the specialty layer', () => {
    const canvas = new LayeredTestBoundary(layeredDocument(), { activeLayerId: 'canvas' });
    expect(() => canvas.execute({ type: 'set-full', x: 0, y: 0, color: 1 })).toThrow('Select a stitch or specialty layer to edit.');
    const specialty = new LayeredTestBoundary(layeredDocument(), { activeLayerId: SPECIALTY_LAYER_ID });
    expect(() => specialty.execute({ type: 'set-full', x: 0, y: 0, color: 1 })).toThrow();
  });

  it('seeds an edit on the default layer for its kind', () => {
    const boundary = new LayeredTestBoundary(layeredDocument());
    boundary.seed({ type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 4 }, color: 1 });
    expect(layerSurface(boundary.layeredDocument, SPECIALTY_LAYER_ID).backstitches.ids).toHaveLength(1);
    expect(boundary.log).toHaveLength(0);
  });

  it('pastes onto a new layer when the selected one is of the other type, and selects it', () => {
    const source = new LayeredTestBoundary(layeredDocument());
    source.seed({ type: 'set-full', x: 0, y: 0, color: 1 });
    const fragment = createPatternFragment(source.document, { x: 0, y: 0, width: 1, height: 1 });
    const boundary = new LayeredTestBoundary(layeredDocument(), { activeLayerId: SPECIALTY_LAYER_ID });
    const destination = boundary.resolvePaste(LayerType.Stitch);
    expect(destination).toMatchObject({ layerId: null, create: true });
    const outcome = boundary.commitPaste(fragment, { x: 3, y: 3 }, destination);
    expect(outcome.layerId).toBe(boundary.activeLayerId);
    expect(boundary.document.kind[3 * 8 + 3]).toBe(CellKind.Full);
    expect(boundary.undoDepth).toBe(1);
  });

  it('keeps marks on their own history', () => {
    const boundary = new LayeredTestBoundary(layeredDocument());
    boundary.seed({ type: 'set-full', x: 0, y: 0, color: 1 });
    const marked = boundary.markProgress({ cells: { indices: Uint32Array.of(0), masks: Uint8Array.of(1) }, operation: 'set' });
    expect(marked.changed).toBe(true);
    expect(boundary.document.completed[0]).toBe(1);
    expect(boundary.undoDepth).toBe(1);
    expect(boundary.undoMark().changed).toBe(true);
    expect(boundary.document.completed[0]).toBe(0);
    expect(boundary.redoMark().changed).toBe(true);
    expect(boundary.document.completed[0]).toBe(1);
  });

  it('opens another project and tells subscribers', () => {
    const boundary = new LayeredTestBoundary(layeredDocument());
    let notified = 0;
    boundary.subscribe(() => { notified += 1; });
    boundary.open(plainDocument(4, 4), 'project-b');
    expect(boundary.activeProjectId).toBe('project-b');
    expect(boundary.document.width).toBe(4);
    expect(notified).toBe(1);
  });
});
