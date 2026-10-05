import { describe, expect, it } from 'vitest';
import {
  applyCommandsToDraft,
  applyLayerStructureCommand,
  assertValidLayeredDocument,
  canAddLayer,
  CellKind,
  collectLayeredValidationErrors,
  commandLayerType,
  commandScope,
  commitLayerSurface,
  createDocument,
  createLayeredDocument,
  DEFAULT_PATTERN_AIDA_COUNT,
  DomainError,
  findLayer,
  FlattenCache,
  flattenDocument,
  HalfDirection,
  isSharedEmptyCellPlane,
  layerAddCommand,
  layerDeleteCommand,
  layerDuplicateCommand,
  layeredFromSurface,
  LayerErrorCode,
  layerMergeCommand,
  layerMoveCommand,
  layerRenameCommand,
  layersOfType,
  layerSetVisibilityCommand,
  layerSurface,
  LayerType,
  MAX_LAYERS_PER_TYPE,
  nextDefaultLayerName,
  normalizePatternSettings,
  requireEditableLayer,
  topmostVisibleLayer,
  type CatalogAssociation,
  type DomainCommand,
  type LayeredDocument,
  type SpecialtyLayer,
  type StitchLayer
} from './index';

const TEST_CATALOG: CatalogAssociation = { catalogId: 'test-catalog', brandLabel: 'Test Catalog', colorCount: 489 };

function layered(width = 4, height = 3): LayeredDocument {
  return createLayeredDocument({
    width,
    height,
    catalog: TEST_CATALOG,
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

function specialty(doc: LayeredDocument, id: number): SpecialtyLayer {
  const layer = findLayer(doc, id);
  if (layer?.type !== LayerType.Specialty) throw new Error(`Layer ${String(id)} is not a specialty layer.`);
  return layer;
}

function errorCode(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof DomainError ? error.code : 'not-domain-error';
  }
  return undefined;
}

describe('layered documents', () => {
  it('creates canvas settings plus a Stitches and a Specialty layer', () => {
    const doc = layered();
    expect(doc.version).toBe(2);
    expect(doc.layers.map((layer) => [layer.id, layer.type, layer.name, layer.visible])).toEqual([
      [1, 'stitch', 'Stitches', true],
      [2, 'specialty', 'Specialty', true]
    ]);
    expect(doc.nextLayerId).toBe(3);
    expect(doc.settings.aidaCount).toBe(DEFAULT_PATTERN_AIDA_COUNT);
    expect(stitch(doc, 1).kind).toHaveLength(12);
    expect(stitch(doc, 1).colors).toHaveLength(48);
    assertValidLayeredDocument(doc);
  });

  it('carries aidaCount through settings normalization', () => {
    expect(normalizePatternSettings(undefined).aidaCount).toBe(14);
    expect(normalizePatternSettings({ aidaCount: 18 }).aidaCount).toBe(18);
    expect(errorCode(() => normalizePatternSettings({ aidaCount: 0 }))).toBe('invalid-settings');
    const doc = createLayeredDocument({ width: 2, height: 2, catalog: TEST_CATALOG, settings: { aidaCount: 16, backgroundColor: '#abcdef' } });
    expect(doc.settings).toMatchObject({ aidaCount: 16, backgroundColor: '#ABCDEF' });
  });

  it('builds from a legacy surface: cells to Stitches, backstitches to Specialty, completion dropped', () => {
    const surface = createDocument({ width: 3, height: 3, catalog: TEST_CATALOG, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    applyCommandsToDraft(surface, [
      { type: 'set-full', x: 1, y: 1, color: 1 },
      { type: 'set-completion', x: 1, y: 1, completed: true },
      { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 1 }
    ]);
    expect(surface.completed[4]).not.toBe(0);
    const doc = layeredFromSurface(surface, { aidaCount: 11 });
    expect(stitch(doc, 1).kind[4]).toBe(CellKind.Full);
    expect(stitch(doc, 1).completed.every((value) => value === 0)).toBe(true);
    expect(specialty(doc, 2).backstitches.ids).toEqual(new Uint32Array([1]));
    expect(doc.settings.aidaCount).toBe(11);
    expect(doc.nextBackstitchId).toBe(2);
    assertValidLayeredDocument(doc);
  });
});

describe('layer surfaces', () => {
  it('aliases a stitch layer so commands write through, and commit writes shared fields back', () => {
    const doc = layered();
    const surface = layerSurface(doc, 1);
    expect(surface.kind).toBe(stitch(doc, 1).kind);
    expect(surface.palette).toBe(doc.palette);
    expect(surface.backstitches.ids).toHaveLength(0);
    applyCommandsToDraft(surface, [
      { type: 'set-full', x: 0, y: 0, color: 1 },
      { type: 'palette-create', name: 'Green', color: '#0a0' }
    ]);
    expect(stitch(doc, 1).kind[0]).toBe(CellKind.Full);
    commitLayerSurface(doc, 1, surface);
    expect(doc.palette.map((entry) => entry.name)).toContain('Green');
    expect(doc.nextPaletteId).toBe(surface.nextPaletteId);
    assertValidLayeredDocument(doc);
  });

  it('gives specialty layers shared, never-written zero cell planes and aliases their backstitches', () => {
    const doc = layered();
    const first = layerSurface(doc, 2);
    const second = layerSurface(doc, 2);
    expect(first.kind).toBe(second.kind);
    expect(isSharedEmptyCellPlane(first.kind)).toBe(true);
    expect(isSharedEmptyCellPlane(stitch(doc, 1).kind)).toBe(false);
    run(doc, 2, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 4 }, color: 2 });
    expect(specialty(doc, 2).backstitches.ids).toEqual(new Uint32Array([1]));
    expect(doc.nextBackstitchId).toBe(2);
    expect(first.kind.every((value) => value === 0)).toBe(true);
    expect(stitch(doc, 1).kind.every((value) => value === 0)).toBe(true);
  });

  it('rejects unknown layers', () => {
    expect(errorCode(() => layerSurface(layered(), 99))).toBe(LayerErrorCode.NotFound);
  });
});

describe('flattening', () => {
  function twoStitchLayers(): LayeredDocument {
    const doc = layered();
    applyLayerStructureCommand(doc, layerAddCommand(LayerType.Stitch));
    return doc;
  }

  it('lets the topmost non-empty cell cover whole cells, with a half covering a full', () => {
    const doc = twoStitchLayers();
    expect(doc.layers.map((layer) => layer.id)).toEqual([1, 3, 2]);
    run(doc, 1, { type: 'set-full', x: 0, y: 0, color: 1 }, { type: 'set-full', x: 1, y: 0, color: 1 });
    run(doc, 3, { type: 'set-half', x: 0, y: 0, direction: HalfDirection.Slash, color: 2 });
    const composite = flattenDocument(doc);
    expect(composite.kind[0]).toBe(CellKind.HalfSlash);
    expect(Array.from(composite.colors.subarray(0, 4))).toEqual([2, 0, 0, 0]);
    // An empty upper cell lets the lower one through.
    expect(composite.kind[1]).toBe(CellKind.Full);
    expect(composite.colors[4]).toBe(1);
    expect(composite.completed.every((value) => value === 0)).toBe(true);
    expect(composite.palette).toBe(doc.palette);
  });

  it('ignores hidden layers', () => {
    const doc = twoStitchLayers();
    run(doc, 1, { type: 'set-full', x: 0, y: 0, color: 1 });
    run(doc, 3, { type: 'set-full', x: 0, y: 0, color: 2 });
    run(doc, 2, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 1 });
    applyLayerStructureCommand(doc, layerSetVisibilityCommand(3, false));
    applyLayerStructureCommand(doc, layerSetVisibilityCommand(2, false));
    const composite = flattenDocument(doc);
    expect(composite.colors[0]).toBe(1);
    expect(composite.backstitches.ids).toHaveLength(0);
  });

  it('concatenates visible specialty layers bottom to top, keeping the topmost duplicate segment', () => {
    const doc = layered();
    const { layerId } = applyLayerStructureCommand(doc, layerAddCommand(LayerType.Specialty));
    run(doc, 2, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 1 }, { type: 'add-backstitch', start: { x: 0, y: 4 }, end: { x: 4, y: 4 }, color: 1 });
    run(doc, layerId!, { type: 'add-backstitch', start: { x: 0, y: 8 }, end: { x: 4, y: 8 }, color: 2 }, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 3 });
    const composite = flattenDocument(doc);
    expect(Array.from(composite.backstitches.ids)).toEqual([2, 3, 4]);
    expect(Array.from(composite.backstitches.colors)).toEqual([1, 2, 3]);
  });

  it('keeps an incremental flatten identical to a full flatten', () => {
    const doc = twoStitchLayers();
    const cache = new FlattenCache();
    cache.full(doc);
    run(doc, 1, { type: 'set-full', x: 2, y: 1, color: 1 }, { type: 'set-full', x: 3, y: 2, color: 3 });
    cache.update(doc, new Uint32Array([6, 11]));
    run(doc, 3, { type: 'set-half', x: 2, y: 1, direction: HalfDirection.Backslash, color: 2 });
    const beforeHalf = cache.document!;
    const updated = cache.update(doc, new Uint32Array([6]));
    // Earlier composites are immutable snapshots.
    expect(updated).not.toBe(beforeHalf);
    expect(beforeHalf.kind[6]).toBe(CellKind.Full);
    expect(updated.kind[6]).toBe(CellKind.HalfBackslash);
    run(doc, 2, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 4 }, color: 2 });
    const lines = cache.update(doc);
    const full = flattenDocument(doc);
    expect(lines).not.toBe(updated);
    expect(lines.kind).toBe(updated.kind);
    expect(updated.backstitches.ids).toHaveLength(0);
    expect(cache.document).toBe(lines);
    expect(lines.kind).toEqual(full.kind);
    expect(lines.colors).toEqual(full.colors);
    expect(lines.backstitches).toEqual(full.backstitches);
    applyLayerStructureCommand(doc, layerRenameCommand(1, 'Base'));
    doc.revision += 1;
    const touched = cache.touch(doc);
    expect(touched).not.toBe(lines);
    expect(touched.kind).toBe(lines.kind);
    expect(touched.backstitches).toBe(lines.backstitches);
    expect(touched.revision).toBe(doc.revision);
    // A dimension change falls back to a full flatten.
    const small = layered(2, 2);
    expect(cache.update(small).kind).toHaveLength(4);
  });

  it('shares the canvas fields with surfaces and the composite, and rebuilds when they change', () => {
    const doc = layered(2, 2);
    expect('canvasMask' in flattenDocument(doc)).toBe(false);
    expect('originX' in layerSurface(doc, 1)).toBe(false);
    run(doc, 1, { type: 'set-full', x: 0, y: 0, color: 1 });
    const cache = new FlattenCache();
    const before = cache.full(doc);
    const mask = new Uint8Array([1, 1, 1, 0]);
    const masked: LayeredDocument = { ...doc, canvasMask: mask, originX: -3, originY: 2 };
    expect(layerSurface(masked, 1).canvasMask).toBe(mask);
    expect(layerSurface(masked, 2).originX).toBe(-3);
    expect(flattenDocument(masked).canvasMask).toBe(mask);
    const touched = cache.touch(masked);
    expect(touched.kind).not.toBe(before.kind);
    expect(touched.canvasMask).toBe(mask);
    expect([touched.originX, touched.originY]).toEqual([-3, 2]);
    const moved = cache.update({ ...masked, originY: 5 });
    expect(moved.kind).not.toBe(touched.kind);
    expect(moved.originY).toBe(5);
    expect(cache.update({ ...masked, originY: 5 }).kind).toBe(moved.kind);
  });
});

describe('layer queries', () => {
  it('names, caps and finds layers', () => {
    const doc = layered();
    expect(nextDefaultLayerName(doc, LayerType.Stitch)).toBe('Stitches 2');
    applyLayerStructureCommand(doc, layerAddCommand(LayerType.Stitch));
    applyLayerStructureCommand(doc, layerAddCommand(LayerType.Stitch));
    expect(layersOfType(doc, LayerType.Stitch).map((layer) => layer.name)).toEqual(['Stitches', 'Stitches 2', 'Stitches 3']);
    expect(canAddLayer(doc, LayerType.Stitch)).toBe(false);
    expect(canAddLayer(doc, LayerType.Specialty)).toBe(true);
    expect(errorCode(() => applyLayerStructureCommand(doc, layerAddCommand(LayerType.Stitch)))).toBe(LayerErrorCode.Limit);
    // The lowest free number is reused.
    applyLayerStructureCommand(doc, layerDeleteCommand(3));
    expect(nextDefaultLayerName(doc, LayerType.Stitch)).toBe('Stitches 2');
    expect(nextDefaultLayerName(doc, LayerType.Specialty)).toBe('Specialty 2');
    expect(topmostVisibleLayer(doc)?.id).toBe(2);
    expect(topmostVisibleLayer(doc, LayerType.Stitch)?.id).toBe(4);
    applyLayerStructureCommand(doc, layerSetVisibilityCommand(4, false));
    expect(topmostVisibleLayer(doc, LayerType.Stitch)?.id).toBe(1);
  });

  it('gates layer-scoped edits by visibility and type', () => {
    const doc = layered();
    expect(requireEditableLayer(doc, 1, LayerType.Stitch).id).toBe(1);
    expect(errorCode(() => requireEditableLayer(doc, 2, LayerType.Stitch))).toBe(LayerErrorCode.TypeMismatch);
    expect(errorCode(() => requireEditableLayer(doc, 9))).toBe(LayerErrorCode.NotFound);
    applyLayerStructureCommand(doc, layerSetVisibilityCommand(1, false));
    expect(errorCode(() => requireEditableLayer(doc, 1, LayerType.Stitch))).toBe(LayerErrorCode.Hidden);
  });

  it('classifies command scope and required layer type', () => {
    expect(commandScope({ type: 'set-full' })).toBe('layer');
    expect(commandScope({ type: 'bulk-cell' })).toBe('layer');
    expect(commandScope({ type: 'paste-fragment' })).toBe('layer');
    expect(commandScope({ type: 'remove-backstitch' })).toBe('layer');
    expect(commandScope({ type: 'palette-merge' })).toBe('document');
    expect(commandScope({ type: 'mergePalette' })).toBe('document');
    expect(commandScope({ type: 'document-settings-update' })).toBe('document');
    expect(commandScope({ type: 'layer-merge' })).toBe('structure');
    expect(commandScope({ type: 'canvas-resize' })).toBe('canvas');
    expect(commandScope({ type: 'canvasCells' })).toBe('canvas');
    expect(commandScope({ type: 'batch', commands: [{ type: 'palette-merge' }, { type: 'canvas-cells' }] })).toBe('canvas');
    expect(commandScope({ type: 'batch', commands: [{ type: 'layer-add' }, { type: 'canvas-cells' }] })).toBe('structure');
    expect(commandScope({ type: 'batch', commands: [{ type: 'layer-add' }, { type: 'paste-fragment' }] })).toBe('structure');
    expect(commandScope({ type: 'batch', commands: [{ type: 'set-full' }, { type: 'add-backstitch' }] })).toBe('layer');

    expect(commandLayerType({ type: 'set-full' })).toBe('stitch');
    expect(commandLayerType({ type: 'mixed-erase' })).toBe('stitch');
    expect(commandLayerType({ type: 'add-backstitch' })).toBe('specialty');
    expect(commandLayerType({ type: 'remove-segment' })).toBe('specialty');
    expect(commandLayerType({ type: 'delete-region' })).toBeNull();
    expect(commandLayerType({ type: 'move-fragment' })).toBeNull();
    const lines = { x1: new Uint32Array([0]) };
    expect(commandLayerType({ type: 'paste-fragment', fragment: { kind: new Uint8Array([1]), backstitches: { x1: new Uint32Array(0) } } })).toBe('stitch');
    expect(commandLayerType({ type: 'paste-fragment', fragment: { kind: new Uint8Array([0]), backstitches: lines } })).toBe('specialty');
    expect(commandLayerType({ type: 'paste-fragment', fragment: { kind: new Uint8Array([1]), backstitches: lines } })).toBe('mixed');
    expect(commandLayerType({ type: 'batch', commands: [{ type: 'set-full' }, { type: 'add-backstitch' }] })).toBe('mixed');
  });
});

describe('layer structure commands', () => {
  it('adds at the top of the group by default and clamps an explicit index to the group', () => {
    const doc = layered();
    const added = applyLayerStructureCommand(doc, layerAddCommand(LayerType.Specialty, { name: '  Outlines ' }));
    expect(added.layerId).toBe(3);
    expect(findLayer(doc, 3)?.name).toBe('Outlines');
    applyLayerStructureCommand(doc, layerAddCommand(LayerType.Stitch, { index: 99 }));
    applyLayerStructureCommand(doc, layerAddCommand(LayerType.Specialty, { index: 0, id: 10 }));
    expect(doc.layers.map((layer) => layer.id)).toEqual([1, 4, 10, 2, 3]);
    expect(doc.nextLayerId).toBe(11);
    expect(errorCode(() => applyLayerStructureCommand(doc, layerRenameCommand(1, '   ')))).toBe('invalid-layer-name');
    expect(errorCode(() => applyLayerStructureCommand(doc, layerRenameCommand(1, 'x'.repeat(61))))).toBe('invalid-layer-name');
    assertValidLayeredDocument(doc);
  });

  it('moves only within the layer group', () => {
    const doc = layered();
    applyLayerStructureCommand(doc, layerAddCommand(LayerType.Stitch));
    applyLayerStructureCommand(doc, layerAddCommand(LayerType.Specialty));
    expect(doc.layers.map((layer) => layer.id)).toEqual([1, 3, 2, 4]);
    applyLayerStructureCommand(doc, layerMoveCommand(1, 3));
    expect(doc.layers.map((layer) => layer.id)).toEqual([3, 1, 2, 4]);
    applyLayerStructureCommand(doc, layerMoveCommand(4, 0));
    expect(doc.layers.map((layer) => layer.id)).toEqual([3, 1, 4, 2]);
    expect(applyLayerStructureCommand(doc, layerMoveCommand(3, -5)).changed).toBe(false);
  });

  it('never mutates existing layer objects, so a copy of the prior stack restores exactly', () => {
    const doc = layered();
    const original = doc.layers[0];
    const prior = [...doc.layers];
    applyLayerStructureCommand(doc, layerRenameCommand(1, 'Base'));
    expect(original.name).toBe('Stitches');
    expect(findLayer(doc, 1)?.name).toBe('Base');
    applyLayerStructureCommand(doc, layerSetVisibilityCommand(1, false));
    expect(original.visible).toBe(true);
    expect(findLayer(doc, 1)).toMatchObject({ name: 'Base', visible: false });
    expect(prior[0]).toBe(original);
    expect(applyLayerStructureCommand(doc, layerSetVisibilityCommand(1, false)).changed).toBe(false);
  });

  it('deletes any layer, including hidden and last-of-type layers', () => {
    const doc = layered();
    applyLayerStructureCommand(doc, layerSetVisibilityCommand(2, false));
    applyLayerStructureCommand(doc, layerDeleteCommand(2));
    applyLayerStructureCommand(doc, layerDeleteCommand(1));
    expect(doc.layers).toEqual([]);
    expect(errorCode(() => applyLayerStructureCommand(doc, layerDeleteCommand(1)))).toBe(LayerErrorCode.NotFound);
    assertValidLayeredDocument(doc);
  });

  it('duplicates directly above the source with fresh backstitch ids and a copy name', () => {
    const doc = layered();
    run(doc, 1, { type: 'set-full', x: 0, y: 0, color: 1 });
    run(doc, 2, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 1 });
    const stitchCopy = applyLayerStructureCommand(doc, layerDuplicateCommand(1));
    const lineCopy = applyLayerStructureCommand(doc, layerDuplicateCommand(2));
    expect(doc.layers.map((layer) => [layer.id, layer.name])).toEqual([[1, 'Stitches'], [3, 'Stitches copy'], [2, 'Specialty'], [4, 'Specialty copy']]);
    expect(stitch(doc, stitchCopy.layerId!).kind).not.toBe(stitch(doc, 1).kind);
    expect(stitch(doc, 3).kind[0]).toBe(CellKind.Full);
    expect(Array.from(specialty(doc, lineCopy.layerId!).backstitches.ids)).toEqual([2]);
    expect(doc.nextBackstitchId).toBe(3);
    applyLayerStructureCommand(doc, layerRenameCommand(1, 'y'.repeat(60)));
    applyLayerStructureCommand(doc, layerDeleteCommand(3));
    applyLayerStructureCommand(doc, layerDuplicateCommand(1));
    expect(Array.from(findLayer(doc, 5)!.name)).toHaveLength(60);
    expect(findLayer(doc, 5)!.name.endsWith(' copy')).toBe(true);
    assertValidLayeredDocument(doc);
  });

  it('counts duplicates toward the cap', () => {
    const doc = layered();
    for (let count = 1; count < MAX_LAYERS_PER_TYPE; count += 1) applyLayerStructureCommand(doc, layerDuplicateCommand(2));
    expect(errorCode(() => applyLayerStructureCommand(doc, layerDuplicateCommand(2)))).toBe(LayerErrorCode.Limit);
  });

  it('merges stitch layers with conflicts going to the higher layer, keeping the target name and position', () => {
    const doc = layered();
    applyLayerStructureCommand(doc, layerAddCommand(LayerType.Stitch, { name: 'Top' }));
    run(doc, 1, { type: 'set-full', x: 0, y: 0, color: 1 }, { type: 'set-full', x: 1, y: 0, color: 1 });
    run(doc, 3, { type: 'set-full', x: 0, y: 0, color: 2 }, { type: 'set-full', x: 2, y: 0, color: 2 });
    const oldTarget = findLayer(doc, 1);
    const prior = [...doc.layers];
    // Merge the higher layer down into the lower one: the higher content still wins.
    const merged = applyLayerStructureCommand(doc, layerMergeCommand(3, 1));
    expect(merged.layerId).toBe(1);
    expect(doc.layers.map((layer) => [layer.id, layer.name])).toEqual([[1, 'Stitches'], [2, 'Specialty']]);
    const target = stitch(doc, 1);
    expect([target.colors[0], target.colors[4], target.colors[8]]).toEqual([2, 1, 2]);
    // The original target is untouched, so undo restores it.
    expect(oldTarget).not.toBe(target);
    expect((oldTarget as StitchLayer).colors[0]).toBe(1);
    doc.layers = prior;
    expect(doc.layers.map((layer) => layer.id)).toEqual([1, 3, 2]);
    // Merging up keeps the upper target's name and position.
    applyLayerStructureCommand(doc, layerMergeCommand(1, 3));
    expect(doc.layers.map((layer) => [layer.id, layer.name])).toEqual([[3, 'Top'], [2, 'Specialty']]);
    expect(stitch(doc, 3).colors[4]).toBe(1);
    assertValidLayeredDocument(doc);
  });

  it('combines backstitches on merge, deduplicating identical segments in favor of the higher layer', () => {
    const doc = layered();
    applyLayerStructureCommand(doc, layerAddCommand(LayerType.Specialty));
    run(doc, 2, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 1 }, { type: 'add-backstitch', start: { x: 0, y: 4 }, end: { x: 4, y: 4 }, color: 1 });
    run(doc, 3, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 3 });
    applyLayerStructureCommand(doc, layerMergeCommand(3, 2));
    const store = specialty(doc, 2).backstitches;
    expect(Array.from(store.ids)).toEqual([2, 3]);
    expect(Array.from(store.colors)).toEqual([1, 3]);
    assertValidLayeredDocument(doc);
  });

  it('rejects merging into itself, across types, or with a hidden layer', () => {
    const doc = layered();
    applyLayerStructureCommand(doc, layerAddCommand(LayerType.Stitch));
    expect(errorCode(() => applyLayerStructureCommand(doc, layerMergeCommand(1, 1)))).toBe(LayerErrorCode.MergeInvalid);
    expect(errorCode(() => applyLayerStructureCommand(doc, layerMergeCommand(1, 2)))).toBe(LayerErrorCode.MergeInvalid);
    applyLayerStructureCommand(doc, layerSetVisibilityCommand(3, false));
    expect(errorCode(() => applyLayerStructureCommand(doc, layerMergeCommand(1, 3)))).toBe(LayerErrorCode.MergeInvalid);
    expect(errorCode(() => applyLayerStructureCommand(doc, layerMergeCommand(3, 1)))).toBe(LayerErrorCode.MergeInvalid);
    expect(errorCode(() => applyLayerStructureCommand(doc, layerMergeCommand(1, 9)))).toBe(LayerErrorCode.NotFound);
  });
});

describe('layered validation', () => {
  it('reports group order, caps, ids, names, plane sizes and cross-layer backstitch ids', () => {
    const doc = layered();
    run(doc, 2, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 1 });
    expect(collectLayeredValidationErrors(doc)).toEqual([]);

    const reordered = { ...doc, layers: [doc.layers[1], doc.layers[0]] };
    expect(collectLayeredValidationErrors(reordered).join(' ')).toContain('stitch layer above a specialty layer');

    const capped = layered();
    for (let id = 3; id <= 4; id += 1) applyLayerStructureCommand(capped, layerAddCommand(LayerType.Specialty, { index: 99 }));
    capped.layers.push({ id: 9, type: LayerType.Specialty, name: 'Extra', visible: true, backstitches: specialty(capped, 2).backstitches });
    capped.nextLayerId = 10;
    expect(collectLayeredValidationErrors(capped).join(' ')).toContain('at most 3 specialty layers');

    const badId = { ...doc, nextLayerId: 2 };
    expect(collectLayeredValidationErrors(badId).join(' ')).toContain('below nextLayerId');

    const badName = { ...doc, layers: [{ ...doc.layers[0], name: '' }, doc.layers[1]] };
    expect(collectLayeredValidationErrors(badName).join(' ')).toContain('name must be 1 to 60 characters');

    const badPlane = { ...doc, layers: [{ ...stitch(doc, 1), kind: new Uint8Array(3) }, doc.layers[1]] };
    expect(collectLayeredValidationErrors(badPlane).join(' ')).toContain('kind must be a Uint8Array');

    const shared = { ...doc, layers: [...doc.layers, { id: 3, type: LayerType.Specialty, name: 'Twin', visible: true, backstitches: { ...specialty(doc, 2).backstitches, y1: new Uint32Array([4]), y2: new Uint32Array([4]) } } as SpecialtyLayer], nextLayerId: 4 };
    expect(collectLayeredValidationErrors(shared).join(' ')).toContain('used by more than one layer');

    const stale = { ...doc, nextBackstitchId: 1 };
    expect(collectLayeredValidationErrors(stale).join(' ')).toContain('nextBackstitchId must be greater');
  });
});
