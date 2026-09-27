import { describe, expect, it } from 'vitest';
import {
  CellKind,
  createLayeredDocument,
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
  type PersistencePreparationClient,
  type ProjectMetadata,
  type ProjectRecord,
  type SaveResult
} from '../persistence';
import { DEFAULT_CATALOG_DEFINITION } from '../catalog';
import { acceptConversionDraft } from '../conversion/image-to-pattern';
import { createStarterDocument, ProjectWorkspace } from './workspace';
import { defaultActiveLayerId, fragmentLayerType, ProjectSession } from './session';
import type { WorkspaceRepository } from './types';

class LayeredMemoryRepository implements WorkspaceRepository {
  readonly records = new Map<string, ProjectRecord>();

  async save(projectId: string, metadata: ProjectMetadata, document: LayeredDocument): Promise<SaveResult> {
    const head = { projectId, revision: document.revision, checksum: '0'.repeat(64) };
    this.records.set(projectId, { metadata: { ...metadata }, document: cloneLayeredDocument(document), head, recovery: null, assets: [] });
    return { committed: true, stale: false, revision: document.revision, head };
  }

  async load(projectId: string): Promise<ProjectRecord | undefined> {
    const record = this.records.get(projectId);
    return record === undefined ? undefined : { ...record, metadata: { ...record.metadata }, document: cloneLayeredDocument(record.document) };
  }

  async listProjects(): Promise<ProjectMetadata[]> {
    return [...this.records.values()].map((record) => ({ ...record.metadata }));
  }

  async deleteProject(projectId: string): Promise<void> {
    this.records.delete(projectId);
  }

  async exportProject(): Promise<Uint8Array> {
    throw new Error('Not used by these tests.');
  }

  async importProject(): Promise<ProjectRecord> {
    throw new Error('Not used by these tests.');
  }
}

const unusedPreparationClient: PersistencePreparationClient = {
  prepare: () => Promise.reject(new Error('Not used by these tests.')),
  getRequestId: () => '',
  dispose: () => undefined
};

function layeredDocument(width = 4, height = 4): LayeredDocument {
  return createLayeredDocument({
    width,
    height,
    catalog: DEFAULT_CATALOG_DEFINITION.association,
    palette: [{ id: 1, name: 'Red', color: '#d33' }, { id: 2, name: 'Blue', color: '#36c' }]
  });
}

function openSession(document: LayeredDocument): ProjectSession {
  const metadata: ProjectMetadata = { id: 'layers', title: 'Layers', notes: '', createdAt: 0, updatedAt: 0, revision: document.revision };
  return new ProjectSession({
    repository: new LayeredMemoryRepository(),
    metadata,
    document,
    preparationClient: unusedPreparationClient,
    clock: { now: () => 0 },
    debounceMs: 60_000
  });
}

/** Stitches (1), Stitches 2 (3) and Stitches 3 (4) below Specialty (2). */
function threeStitchLayers(): LayeredDocument {
  const document = layeredDocument();
  applyLayerStructureCommand(document, layerAddCommand(LayerType.Stitch, { id: 3 }));
  applyLayerStructureCommand(document, layerAddCommand(LayerType.Stitch, { id: 4 }));
  return document;
}

function cellFragment(): PatternFragment {
  const source = layeredDocument();
  const session = openSession(source);
  session.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
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
    session.execute({ type: 'set-full', x: 1, y: 1, color: 1 });
    session.executeBatch([{ type: 'set-full', x: 2, y: 2, color: 2 }]);
    // Edits replace layer objects, so read the current stack each time.
    const stitches = (id: number) => session.layeredDocument.layers.find((layer) => layer.id === id) as StitchLayer;
    expect(stitches(3).kind[1 * 4 + 1]).toBe(CellKind.Full);
    expect(stitches(3).kind[2 * 4 + 2]).toBe(CellKind.Full);
    expect(stitches(1).kind[1 * 4 + 1]).toBe(CellKind.Empty);
    expect(session.document.kind[1 * 4 + 1]).toBe(CellKind.Full);

    // An explicit layerId wins over the selection.
    session.execute({ type: 'set-full', x: 0, y: 0, color: 1, layerId: 1 });
    expect(stitches(1).kind[0]).toBe(CellKind.Full);
    expect(stitches(3).kind[0]).toBe(CellKind.Empty);

    session.setActiveLayer('canvas');
    expect(() => session.execute({ type: 'set-full', x: 3, y: 3, color: 1 })).toThrow(/Select a stitch or specialty layer/);
  });

  it('resolves pastes: create with room, topmost visible at the cap, nothing when all are hidden', () => {
    const roomy = openSession(layeredDocument());
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
    const session = openSession(layeredDocument());
    session.setActiveLayer(2);
    const fragment = cellFragment();
    expect(fragmentLayerType(fragment)).toBe(LayerType.Stitch);
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

  it('ignores an empty paste without adding a layer or a history entry', () => {
    const session = openSession(layeredDocument());
    session.setActiveLayer(2);
    const empty = createPatternFragment(session.document, { kind: 'rect', rect: { x: 0, y: 0, width: 1, height: 1 } });
    expect(fragmentLayerType(empty)).toBeNull();
    const destination = session.resolvePaste(LayerType.Stitch);
    expect(destination.create).toBe(true);
    const revision = session.document.revision;
    const commit = session.commitPaste(empty, { x: 0, y: 0 }, destination);
    expect(commit.result.changed).toBe(false);
    expect(commit.layerId).toBeNull();
    expect(commit.message).toBeUndefined();
    expect(session.layeredDocument.layers.map((layer) => layer.id)).toEqual([1, 2]);
    expect(session.document.revision).toBe(revision);
    expect(session.canUndo).toBe(false);
    expect(session.activeLayerId).toBe(2);
  });

  it('wraps layer operations, selecting added, duplicated and merge-target layers', () => {
    const session = openSession(layeredDocument());
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
    session.mergeLayer(copy.id as number, 3);
    expect(session.activeLayerId).toBe(3);
    session.setLayerVisibility(3, false);
    expect(session.activeLayer.visible).toBe(false);
    session.deleteLayer(3);
    expect(session.activeLayerId).toBe(1);
    expect(new Set(layerChanges).size).toBeGreaterThan(3);
    session.undo();
    expect(session.layers.map((layer) => layer.id)).toContain(3);
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
    const session = openSession(layeredDocument());
    session.setActiveLayer(1);
    session.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    session.execute({ type: 'set-full', x: 1, y: 0, color: 1 });
    expect(session.metrics.totals.full).toBe(2);
    session.setLayerVisibility(1, false);
    expect(session.metrics.totals.full).toBe(0);
    session.undo();
    expect(session.metrics.totals.full).toBe(2);
  });
});

describe('workspace layered projects', () => {
  it('creates a blank project with Canvas settings, a stitch layer and a specialty layer', async () => {
    const workspace = new ProjectWorkspace({ repository: new LayeredMemoryRepository(), preparationClient: unusedPreparationClient, debounceMs: 60_000, projectIdFactory: () => 'blank' });
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
    const workspace = new ProjectWorkspace({ repository: new LayeredMemoryRepository(), preparationClient: unusedPreparationClient, debounceMs: 60_000, projectIdFactory: () => 'converted' });
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

  it('routes the active stitch count through an undoable settings change', async () => {
    const workspace = new ProjectWorkspace({ repository: new LayeredMemoryRepository(), preparationClient: unusedPreparationClient, debounceMs: 60_000, projectIdFactory: () => 'aida' });
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
