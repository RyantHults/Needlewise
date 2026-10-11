import { describe, expect, it } from 'vitest';
import {
  applyCommandsToDraft,
  applyLayerStructureCommand,
  CellKind,
  colorComponentMask,
  commitLayerSurface,
  coveringBackstitchLayerId,
  coveringLayerId,
  createLayeredDocument,
  findLayer,
  flattenDocument,
  layerAddCommand,
  layerSetVisibilityCommand,
  layerSurface,
  LayerType,
  type DomainCommand,
  type LayeredDocument,
  type StitchLayer
} from './index';

function layered(): LayeredDocument {
  return createLayeredDocument({
    width: 4,
    height: 3,
    catalog: { catalogId: 'test-catalog', brandLabel: 'Test Catalog', colorCount: 489 },
    palette: [
      { id: 1, name: 'Red', color: '#d33' },
      { id: 2, name: 'Blue', color: '#36c' },
      { id: 3, name: 'Gold', color: '#da2' }
    ]
  });
}

function run(doc: LayeredDocument, layerId: number, ...commands: DomainCommand[]): void {
  const surface = layerSurface(doc, layerId);
  applyCommandsToDraft(surface, commands);
  commitLayerSurface(doc, layerId, surface);
}

function stitch(doc: LayeredDocument, id: number): StitchLayer {
  const layer = findLayer(doc, id);
  if (layer?.type !== LayerType.Stitch) throw new Error(`Layer ${String(id)} is not a stitch layer.`);
  return layer;
}

describe('covering layers', () => {
  it('names the topmost visible non-empty stitch layer for a cell', () => {
    const doc = layered();
    applyLayerStructureCommand(doc, layerAddCommand(LayerType.Stitch));
    run(doc, 1, { type: 'set-full', x: 0, y: 0, color: 1 }, { type: 'set-full', x: 1, y: 0, color: 1 });
    run(doc, 3, { type: 'set-full', x: 0, y: 0, color: 2 });
    expect([coveringLayerId(doc, 0), coveringLayerId(doc, 1), coveringLayerId(doc, 2)]).toEqual([3, 1, null]);
    applyLayerStructureCommand(doc, layerSetVisibilityCommand(3, false));
    expect(coveringLayerId(doc, 0)).toBe(1);
  });

  it('names the specialty layer whose copy of a segment the composite keeps', () => {
    const doc = layered();
    const { layerId } = applyLayerStructureCommand(doc, layerAddCommand(LayerType.Specialty));
    run(doc, 2, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 1 }, { type: 'add-backstitch', start: { x: 0, y: 4 }, end: { x: 4, y: 4 }, color: 1 });
    run(doc, layerId!, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 3 });
    expect(Array.from(flattenDocument(doc).backstitches.ids)).toEqual([2, 3]);
    expect(coveringBackstitchLayerId(doc, 2)).toBe(2);
    expect(coveringBackstitchLayerId(doc, 3)).toBe(layerId);
    // The covered lower copy is not in the composite.
    expect(coveringBackstitchLayerId(doc, 1)).toBeNull();
    expect(coveringBackstitchLayerId(doc, 99)).toBeNull();
    applyLayerStructureCommand(doc, layerSetVisibilityCommand(layerId!, false));
    expect(coveringBackstitchLayerId(doc, 1)).toBe(2);
    expect(coveringBackstitchLayerId(doc, 3)).toBeNull();
  });
});

describe('colorComponentMask', () => {
  it('keeps whole-cell stitches only when their color matches', () => {
    const doc = layered();
    run(doc, 1, { type: 'set-full', x: 0, y: 0, color: 1 });
    const composite = flattenDocument(doc);
    expect(colorComponentMask(composite, 0, null)).toBe(1);
    expect(colorComponentMask(composite, 0, 1)).toBe(1);
    expect(colorComponentMask(composite, 0, 2)).toBe(0);
    expect(colorComponentMask(composite, 1, null)).toBe(0);
  });

  it('filters quarter and three-quarter-pair components by slot color', () => {
    const doc = layered();
    const layer = stitch(doc, 1);
    layer.kind[0] = CellKind.Quarters;
    layer.colors.set([1, 0, 2, 1], 0);
    layer.kind[1] = CellKind.ThreeQuarterPair;
    layer.colors.set([0, 2, 0, 3], 4);
    const composite = flattenDocument(doc);
    expect(colorComponentMask(composite, 0, null)).toBe(0b1101);
    expect(colorComponentMask(composite, 0, 1)).toBe(0b1001);
    expect(colorComponentMask(composite, 0, 2)).toBe(0b0100);
    expect(colorComponentMask(composite, 0, 3)).toBe(0);
    expect(colorComponentMask(composite, 1, null)).toBe(0b1010);
    expect(colorComponentMask(composite, 1, 3)).toBe(0b1000);
  });
});
