import { describe, expect, it } from 'vitest';
import {
  CellKind,
  createPatternFragment,
  layerAddCommand,
  layerSetVisibilityCommand,
  applyLayerStructureCommand,
  LayerType,
  type LayeredDocument,
  type PatternFragment,
  type StitchLayer
} from '../domain';
import {
  cloneLayeredDocument,
  createPersistencePreparationClient,
  type ProjectMetadata
} from '../persistence';
import { acceptConversionDraft } from '../conversion/image-to-pattern';
import { createStarterDocument, ProjectWorkspace } from './workspace';
import { defaultActiveLayerId, ProjectSession } from './session';
import { MemoryRepository } from './test-support';
import { cell } from '../domain/test-fixtures';
import { layeredDocument } from '../editor/test-support';

function openSession(document: LayeredDocument): ProjectSession {
  const metadata: ProjectMetadata = { id: 'layers', title: 'Layers', notes: '', createdAt: 0, updatedAt: 0, revision: document.revision };
  return new ProjectSession({
    repository: new MemoryRepository(),
    metadata,
    document,
    preparationClient: createPersistencePreparationClient({ useWorker: false }),
    clock: { now: () => 0 },
    debounceMs: 60_000
  });
}

/** Stitches (1), Stitches 2 (3) and Stitches 3 (4) below Specialty (2). */
function threeStitchLayers(): LayeredDocument {
  const document = layeredDocument(4, 4);
  applyLayerStructureCommand(document, layerAddCommand(LayerType.Stitch, { id: 3 }));
  applyLayerStructureCommand(document, layerAddCommand(LayerType.Stitch, { id: 4 }));
  return document;
}

function cellFragment(): PatternFragment {
  const source = layeredDocument(4, 4);
  const session = openSession(source);
  session.execute(cell(session.document, { type: 'set-full', x: 0, y: 0, color: 1 }));
  return createPatternFragment(session.activeLayerSurface()!, { kind: 'rect', rect: { x: 0, y: 0, width: 1, height: 1 } });
}

describe('project session layers', () => {
  it('selects the topmost visible stitch layer, then the topmost visible layer, then Canvas on open', () => {
    const document = threeStitchLayers();
    expect(defaultActiveLayerId(document)).toBe(4);
    applyLayerStructureCommand(document, layerSetVisibilityCommand(4, false));
    expect(openSession(cloneLayeredDocument(document)).activeLayerId).toBe(3);
    for (const id of [1, 3]) applyLayerStructureCommand(document, layerSetVisibilityCommand(id, false));
    expect(openSession(cloneLayeredDocument(document)).activeLayerId).toBe(2);
    applyLayerStructureCommand(document, layerSetVisibilityCommand(2, false));
    const session = openSession(document);
    expect(session.activeLayerId).toBe('canvas');
    expect(session.activeLayer).toMatchObject({ id: 'canvas', kind: 'canvas', visible: true });
    expect(session.activeLayerSurface()).toBeNull();
  });

  it('stamps the selected layer on layer-scoped commands and batch children', () => {
    const session = openSession(threeStitchLayers());
    session.setActiveLayer(3);
    session.execute(cell(session.document, { type: 'set-full', x: 1, y: 1, color: 1 }));
    session.executeBatch([cell(session.document, { type: 'set-full', x: 2, y: 2, color: 2 })]);
    // Edits replace layer objects, so read the current stack each time.
    const stitches = (id: number) => session.layeredDocument.layers.find((layer) => layer.id === id) as StitchLayer;
    expect(stitches(3).kind[1 * 4 + 1]).toBe(CellKind.Full);
    expect(stitches(3).kind[2 * 4 + 2]).toBe(CellKind.Full);
    expect(stitches(1).kind[1 * 4 + 1]).toBe(CellKind.Empty);
    expect(session.document.kind[1 * 4 + 1]).toBe(CellKind.Full);

    // An explicit layerId wins over the selection.
    session.execute(cell(session.document, { type: 'set-full', x: 0, y: 0, color: 1, layerId: 1 }));
    expect(stitches(1).kind[0]).toBe(CellKind.Full);
    expect(stitches(3).kind[0]).toBe(CellKind.Empty);

    session.setActiveLayer('canvas');
    expect(() => session.execute(cell(session.document, { type: 'set-full', x: 3, y: 3, color: 1 }))).toThrow(/Select a stitch or specialty layer/);
  });

  it('resolves pastes: create with room, topmost visible at the cap, nothing when all are hidden', () => {
    const roomy = openSession(layeredDocument(4, 4));
    roomy.setActiveLayer(1);
    expect(roomy.resolvePaste(LayerType.Stitch)).toEqual({ layerType: LayerType.Stitch, layerId: 1, create: false });
    roomy.setActiveLayer(2);
    expect(roomy.resolvePaste(LayerType.Stitch)).toEqual({ layerType: LayerType.Stitch, layerId: null, create: true, message: 'Added a new stitch layer for your paste.' });

    const full = threeStitchLayers();
    applyLayerStructureCommand(full, layerSetVisibilityCommand(4, false));
    const capped = openSession(full);
    capped.setActiveLayer(2);
    expect(capped.resolvePaste(LayerType.Stitch)).toEqual({ layerType: LayerType.Stitch, layerId: 3, create: false, message: 'You have 3 stitch layers already, so this went on the top one.' });

    const hidden = threeStitchLayers();
    for (const id of [1, 3, 4]) applyLayerStructureCommand(hidden, layerSetVisibilityCommand(id, false));
    const none = openSession(hidden);
    const destination = none.resolvePaste(LayerType.Stitch);
    expect(destination.layerId).toBeNull();
    expect(destination.create).toBe(false);
    expect(destination.message).toMatch(/hidden/);
    const commit = none.commitPaste(cellFragment(), { x: 0, y: 0 }, destination);
    expect(commit.result.changed).toBe(false);
    expect(commit.message).toBe(destination.message);
  });

  it('commits a paste onto a new layer as one undo step and selects that layer', () => {
    const session = openSession(layeredDocument(4, 4));
    session.setActiveLayer(2);
    const fragment = cellFragment();
    const destination = session.resolvePaste(LayerType.Stitch);
    const commit = session.commitPaste(fragment, { x: 2, y: 1 }, destination);
    expect(commit.result.changed).toBe(true);
    expect(commit.message).toBe('Added a new stitch layer for your paste.');
    expect(session.layeredDocument.layers.map((layer) => layer.type)).toEqual(['stitch', 'stitch', 'specialty']);
    expect(session.activeLayerId).toBe(commit.layerId);
    expect(session.document.kind[1 * 4 + 2]).toBe(CellKind.Full);

    session.undo();
    expect(session.layeredDocument.layers.map((layer) => layer.id)).toEqual([1, 2]);
    expect(session.document.kind[1 * 4 + 2]).toBe(CellKind.Empty);
    // The pasted layer is gone, so the default selection returns.
    expect(session.activeLayerId).toBe(1);
  });

  it('commits a paste with new palette entries as one undo step, onto an existing and a new layer', () => {
    const entries = [{ id: 3, name: 'Green', color: '#3a3' }, { id: 4, name: 'Gold', color: '#da3' }];
    const paletteIds = (session: ProjectSession) => session.document.palette.map((entry) => entry.id);

    const existing = openSession(layeredDocument(4, 4));
    existing.setActiveLayer(1);
    const destination = existing.resolvePaste(LayerType.Stitch);
    expect(destination.create).toBe(false);
    expect(existing.commitPaste(cellFragment(), { x: 2, y: 1 }, destination, undefined, entries).result.changed).toBe(true);
    expect(paletteIds(existing)).toEqual([1, 2, 3, 4]);
    expect(existing.document.kind[1 * 4 + 2]).toBe(CellKind.Full);
    existing.undo();
    expect(paletteIds(existing)).toEqual([1, 2]);
    expect(existing.document.kind[1 * 4 + 2]).toBe(CellKind.Empty);
    expect(existing.historyUndoDepth).toBe(0);
    existing.redo();
    expect(paletteIds(existing)).toEqual([1, 2, 3, 4]);
    expect(existing.document.kind[1 * 4 + 2]).toBe(CellKind.Full);

    const fresh = openSession(layeredDocument(4, 4));
    fresh.setActiveLayer(2);
    const created = fresh.resolvePaste(LayerType.Stitch);
    expect(created.create).toBe(true);
    const commit = fresh.commitPaste(cellFragment(), { x: 2, y: 1 }, created, undefined, entries.slice(0, 1));
    expect(commit.result.changed).toBe(true);
    expect(paletteIds(fresh)).toEqual([1, 2, 3]);
    expect(fresh.layeredDocument.layers).toHaveLength(3);
    fresh.undo();
    expect(paletteIds(fresh)).toEqual([1, 2]);
    expect(fresh.layeredDocument.layers).toHaveLength(2);
    expect(fresh.historyUndoDepth).toBe(0);
    fresh.redo();
    expect(paletteIds(fresh)).toEqual([1, 2, 3]);
    expect(fresh.layeredDocument.layers).toHaveLength(3);
    expect(fresh.document.kind[1 * 4 + 2]).toBe(CellKind.Full);
  });

  it('ignores an empty paste without adding a layer or a history entry', () => {
    const session = openSession(layeredDocument(4, 4));
    session.setActiveLayer(2);
    const empty = createPatternFragment(session.document, { kind: 'rect', rect: { x: 0, y: 0, width: 1, height: 1 } });
    const destination = session.resolvePaste(LayerType.Stitch);
    expect(destination.create).toBe(true);
    const revision = session.document.revision;
    const commit = session.commitPaste(empty, { x: 0, y: 0 }, destination);
    expect(commit.result.changed).toBe(false);
    expect(commit.layerId).toBeNull();
    expect(commit.message).toBeUndefined();
    expect(session.layeredDocument.layers.map((layer) => layer.id)).toEqual([1, 2]);
    expect(session.document.revision).toBe(revision);
    expect(session.historyUndoDepth).toBe(0);
    expect(session.activeLayerId).toBe(2);
  });

  it('wraps layer operations, selecting added, duplicated and merge-target layers', () => {
    const session = openSession(layeredDocument(4, 4));
    const layerChanges: unknown[] = [];
    session.subscribe(() => layerChanges.push(session.layers));
    session.addLayer(LayerType.Stitch);
    expect(session.activeLayer).toMatchObject({ id: 3, kind: 'stitch', name: 'Stitches 2' });
    session.renameLayer(3, 'Outline');
    expect(session.layers.find((layer) => layer.id === 3)?.name).toBe('Outline');
    session.duplicateLayer(1);
    const copy = session.activeLayer;
    expect(copy.name).toBe('Stitches copy');
    expect(session.canAddLayer(LayerType.Stitch)).toBe(false);
    expect(session.layers.map((layer) => layer.id)).toEqual([1, copy.id, 3, 2]);
    session.setActiveLayer(3);
    session.mergeSelectedLayers();
    expect(session.activeLayerId).toBe(copy.id);
    expect(session.layers.map((layer) => layer.id)).toEqual([1, copy.id, 2]);
    session.setLayerVisibility(copy.id as number, false);
    expect(session.activeLayer.visible).toBe(false);
    session.deleteLayer(copy.id as number);
    expect(session.activeLayerId).toBe(1);
    expect(new Set(layerChanges).size).toBeGreaterThan(3);
    session.undo();
    expect(session.layers.map((layer) => layer.id)).toContain(copy.id);
  });

  it('toggles layers in and out of the selection, keeping stack order and a primary', () => {
    const session = openSession(threeStitchLayers());
    expect(session.layerSelection).toEqual({ primary: 4, layerIds: [4] });
    session.toggleLayerSelected(1);
    expect(session.layerSelection).toEqual({ primary: 1, layerIds: [1, 4] });
    session.toggleLayerSelected(2);
    expect(session.layerSelection).toEqual({ primary: 2, layerIds: [1, 4, 2] });
    session.toggleLayerSelected(2);
    expect(session.layerSelection).toEqual({ primary: 4, layerIds: [1, 4] });
    session.toggleLayerSelected(1);
    expect(session.layerSelection).toEqual({ primary: 4, layerIds: [4] });
    session.toggleLayerSelected(4);
    expect(session.layerSelection).toEqual({ primary: 4, layerIds: [4] });
    expect(() => session.toggleLayerSelected(99)).toThrow();
  });

  it('selects a range from the primary and collapses on Canvas, Reference and a plain select', () => {
    const session = openSession(threeStitchLayers());
    session.setActiveLayer(1);
    session.selectLayerRange(4);
    expect(session.layerSelection).toEqual({ primary: 4, layerIds: [1, 3, 4] });
    session.selectLayerRange(2);
    expect(session.layerSelection).toEqual({ primary: 2, layerIds: [4, 2] });
    expect(session.getEditorLayerSnapshot().selectedLayerIds).toEqual([4, 2]);
    session.setActiveLayer('canvas');
    expect(session.layerSelection).toEqual({ primary: 'canvas', layerIds: [] });
    session.selectLayerRange(3);
    expect(session.layerSelection).toEqual({ primary: 3, layerIds: [3] });
    session.toggleLayerSelected(1);
    session.setActiveLayer('reference');
    expect(session.layerSelection).toEqual({ primary: 'reference', layerIds: [] });
    session.toggleLayerSelected(1);
    session.toggleLayerSelected(3);
    session.setActiveLayer(3);
    expect(session.layerSelection).toEqual({ primary: 3, layerIds: [3] });
  });

  it('notifies on selection changes and publishes a new editor snapshot', () => {
    const session = openSession(threeStitchLayers());
    let notifications = 0;
    session.subscribe(() => { notifications += 1; });
    const before = session.getEditorLayerSnapshot();
    expect(session.getEditorLayerSnapshot()).toBe(before);
    session.toggleLayerSelected(1);
    expect(notifications).toBe(1);
    const after = session.getEditorLayerSnapshot();
    expect(after).not.toBe(before);
    expect(after.selectedLayerIds).toEqual([1, 4]);
    expect(after.activeLayer.id).toBe(1);
  });

  it('prunes deleted layers from the selection, promoting the topmost remaining when the primary goes', () => {
    const session = openSession(threeStitchLayers());
    session.selectLayerRange(1);
    expect(session.layerSelection).toEqual({ primary: 1, layerIds: [1, 3, 4] });
    session.deleteLayer(3);
    expect(session.layerSelection).toEqual({ primary: 1, layerIds: [1, 4] });
    session.deleteLayer(1);
    expect(session.layerSelection).toEqual({ primary: 4, layerIds: [4] });
    session.deleteLayer(4);
    expect(session.layerSelection).toEqual({ primary: 2, layerIds: [2] });
  });

  it('collapses to the new layer on add and duplicate, and does not persist the selection', () => {
    const session = openSession(layeredDocument(4, 4));
    session.toggleLayerSelected(2);
    session.addLayer(LayerType.Stitch);
    expect(session.layerSelection).toEqual({ primary: 3, layerIds: [3] });
    session.toggleLayerSelected(1);
    session.duplicateLayer(1);
    expect(session.layerSelection.layerIds).toEqual([session.activeLayerId]);
    const reopened = openSession(cloneLayeredDocument(session.layeredDocument));
    expect(reopened.layerSelection.layerIds).toHaveLength(1);
    expect(reopened.layerSelection.primary).toBe(reopened.activeLayerId);
  });

  it('merges the selection as one undo step, topmost winning conflicts, and selects the target', () => {
    const session = openSession(threeStitchLayers());
    const place = (x: number, color: number) => session.execute(cell(session.document, { type: 'set-full', x, y: 0, color }));
    session.setActiveLayer(1);
    place(0, 1);
    place(1, 1);
    session.setActiveLayer(4);
    place(1, 2);
    session.selectLayerRange(1);
    session.toggleLayerSelected(3);
    expect(session.layerSelection.layerIds).toEqual([1, 4]);
    session.toggleLayerSelected(3);
    expect(session.layerSelection.layerIds).toEqual([1, 3, 4]);
    const depth = session.layers.length;
    const result = session.mergeSelectedLayers();
    expect(result.changed).toBe(true);
    expect(session.layers.map((layer) => layer.id)).toEqual([1, 2]);
    expect(session.layerSelection).toEqual({ primary: 1, layerIds: [1] });
    const merged = session.activeLayerSurface()!;
    expect([merged.colors[0], merged.colors[4]]).toEqual([1, 2]);
    session.undo();
    expect(session.layers).toHaveLength(depth);
    expect(session.layers.map((layer) => layer.id)).toEqual([1, 3, 4, 2]);
  });

  it('merges one layer down, and leaves the document alone when the plan is disabled', () => {
    const session = openSession(threeStitchLayers());
    session.mergeSelectedLayers();
    expect(session.layers.map((layer) => layer.id)).toEqual([1, 3, 2]);
    expect(session.layerSelection).toEqual({ primary: 3, layerIds: [3] });
    session.setActiveLayer(1);
    expect(session.mergeSelectedLayers().changed).toBe(false);
    session.setActiveLayer('canvas');
    expect(session.mergeSelectedLayers().changed).toBe(false);
    expect(session.layers.map((layer) => layer.id)).toEqual([1, 3, 2]);
  });

  it('keeps the stitch count in settings as an undoable change that drives metrics', () => {
    const session = openSession(layeredDocument(28, 14));
    expect(session.document.settings.aidaCount).toBe(14);
    expect(session.metrics.finishedSize).toMatchObject({ widthInches: 2, heightInches: 1 });
    session.setAidaCount(28);
    expect(session.layeredDocument.settings.aidaCount).toBe(28);
    expect(session.metrics.finishedSize).toMatchObject({ widthInches: 1, heightInches: 0.5 });
    expect(session.metadata.aidaCount).toBeUndefined();
    session.undo();
    expect(session.document.settings.aidaCount).toBe(14);
    expect(session.metrics.finishedSize).toMatchObject({ widthInches: 2, heightInches: 1 });
  });

  it('counts only visible content in metrics', () => {
    const session = openSession(layeredDocument(4, 4));
    session.setActiveLayer(1);
    session.execute(cell(session.document, { type: 'set-full', x: 0, y: 0, color: 1 }));
    session.execute(cell(session.document, { type: 'set-full', x: 1, y: 0, color: 1 }));
    expect(session.metrics.totals.full).toBe(2);
    session.setLayerVisibility(1, false);
    expect(session.metrics.totals.full).toBe(0);
    session.setLayerVisibility(1, true);
    expect(session.metrics.totals.full).toBe(2);
  });

  it('keeps layer visibility out of undo history without clearing redo', () => {
    const session = openSession(layeredDocument(4, 4));
    session.setActiveLayer(1);
    session.execute(cell(session.document, { type: 'set-full', x: 0, y: 0, color: 1 }));
    session.execute(cell(session.document, { type: 'set-full', x: 1, y: 0, color: 1 }));
    session.undo();
    expect(session.historyRedoDepth).toBeGreaterThan(0);
    const revision = session.layeredDocument.revision;
    session.setLayerVisibility(1, false);
    expect(session.layeredDocument.revision).toBe(revision + 1);
    expect(session.layers.find((layer) => layer.id === 1)?.visible).toBe(false);
    expect(session.metrics.totals.full).toBe(0);
    expect(session.historyRedoDepth).toBeGreaterThan(0);

    // Undo steps over the toggle to the edit before it; the layer stays hidden.
    session.undo();
    const stitches = session.layeredDocument.layers.find((layer) => layer.id === 1) as StitchLayer;
    expect(stitches.kind[0]).toBe(CellKind.Empty);
    expect(stitches.visible).toBe(false);
    expect(session.historyUndoDepth).toBe(0);
    session.redo();
    session.redo();
    expect((session.layeredDocument.layers.find((layer) => layer.id === 1) as StitchLayer).kind[1]).toBe(CellKind.Full);
    expect(session.layers.find((layer) => layer.id === 1)?.visible).toBe(false);
  });
});

describe('workspace layered projects', () => {
  it('creates a blank project with Canvas settings, a stitch layer and a specialty layer', async () => {
    const workspace = new ProjectWorkspace({ repository: new MemoryRepository(), preparationClient: createPersistencePreparationClient({ useWorker: false }), debounceMs: 60_000, projectIdFactory: () => 'blank' });
    try {
      const session = await workspace.createProject({ width: 10, height: 8, aidaCount: 18, settings: { backgroundColor: '#FAF0E6' } });
      expect(session.layeredDocument.layers.map((layer) => [layer.type, layer.name])).toEqual([['stitch', 'Stitches'], ['specialty', 'Specialty']]);
      expect(session.layeredDocument.settings).toMatchObject({ aidaCount: 18, backgroundColor: '#FAF0E6' });
      expect(session.metadata.aidaCount).toBeUndefined();
      expect(workspace.state.layers).toHaveLength(2);
      expect(workspace.state.activeLayer).toMatchObject({ id: 1, kind: 'stitch' });
    } finally {
      await workspace.dispose();
    }
  });

  it('puts conversion output in the stitch layer', async () => {
    const workspace = new ProjectWorkspace({ repository: new MemoryRepository(), preparationClient: createPersistencePreparationClient({ useWorker: false }), debounceMs: 60_000, projectIdFactory: () => 'converted' });
    try {
      const document = createStarterDocument({ width: 3, height: 2 });
      document.kind[4] = CellKind.Full;
      document.colors[16] = 1;
      const draft = acceptConversionDraft({
        token: { projectId: 'conversion', baseRevision: 0, requestId: 'layers' },
        document,
        stats: { sourceWidth: 3, sourceHeight: 2, targetWidth: 3, targetHeight: 2, totalPixels: 6, transparentPixels: 0, emptyPixels: 5, stitchedPixels: 1, matchedColorCount: 1, paletteUsage: [{ paletteId: 1, catalogId: document.catalog.catalogId, count: 1 }] },
        sourceImage: { width: 3, height: 2, crop: { x: 0, y: 0, width: 1, height: 1 }, chartBounds: { x: 0, y: 0, width: 3, height: 2 }, traceVisible: false, opacity: 1 }
      });
      const session = await workspace.createProjectFromConversion({ draft, aidaCount: 16 });
      const [stitches, specialty] = session.layeredDocument.layers;
      expect(stitches.type).toBe(LayerType.Stitch);
      expect(stitches.type === LayerType.Stitch && stitches.kind[4]).toBe(CellKind.Full);
      expect(specialty.type).toBe(LayerType.Specialty);
      expect(session.document.kind[4]).toBe(CellKind.Full);
      expect(session.document.settings.aidaCount).toBe(16);
      expect(session.metrics.totals.full).toBe(1);
    } finally {
      await workspace.dispose();
    }
  });

  it('saves a layer visibility toggle that is not an undo step', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, preparationClient: createPersistencePreparationClient({ useWorker: false }), debounceMs: 60_000, projectIdFactory: () => 'visibility' });
    try {
      const session = await workspace.createProject({ width: 4, height: 4 });
      await workspace.flush();
      workspace.setLayerVisibility(2, false);
      expect(session.historyUndoDepth).toBe(0);
      await workspace.flush();
      const saved = await repository.load('visibility');
      expect(saved?.document.layers.find((layer) => layer.id === 2)?.visible).toBe(false);
    } finally {
      await workspace.dispose();
    }
  });

  it('routes the active stitch count through an undoable settings change', async () => {
    const workspace = new ProjectWorkspace({ repository: new MemoryRepository(), preparationClient: createPersistencePreparationClient({ useWorker: false }), debounceMs: 60_000, projectIdFactory: () => 'aida' });
    try {
      await workspace.createProject({ width: 4, height: 4 });
      await workspace.updateActiveAidaCount(22);
      expect(workspace.document?.settings.aidaCount).toBe(22);
      await workspace.updateActiveAidaCount(null);
      expect(workspace.document?.settings.aidaCount).toBe(22);
      workspace.undo();
      expect(workspace.document?.settings.aidaCount).toBe(14);
    } finally {
      await workspace.dispose();
    }
  });
});
