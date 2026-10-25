import { describe, expect, it } from 'vitest';
import {
  createDocument
} from '../domain';
import {
  createPersistencePreparationClient,
  type PersistencePreparationClient,
  type SessionHistoryEnvelope
} from '../persistence';
import { ProjectSession, ProjectWorkspace } from './index';
import { MemoryRepository } from './test-support';
import { createInstalledCatalogRegistry, DEFAULT_CATALOG_DEFINITION } from '../catalog';
import { createLayeredDocument } from '../domain/test-fixtures';

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

const TRACE_DESCRIPTOR = {
  assetId: 'reference',
  mimeType: 'image/png' as const,
  width: 2,
  height: 2,
  crop: { x: 0, y: 0, width: 1, height: 1 },
  chartBounds: { x: 0, y: 0, width: 2, height: 2 },
  traceVisible: true,
  opacity: 1
};

async function openTracedWorkspace(id: string): Promise<ProjectWorkspace> {
  const repository = new MemoryRepository();
  const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => id, debounceMs: 0 });
  await workspace.createProject({
    id,
    width: 4,
    height: 4,
    document: createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 4, height: 4, palette: [{ id: 1, name: 'Ruby', color: '#b44' }] }),
    assets: [{ id: 'reference', name: 'reference.png', mimeType: 'image/png', data: pngBytes(2, 2) }],
    sourceImage: { ...TRACE_DESCRIPTOR }
  });
  return workspace;
}

describe('trace image unified history', () => {
  it('preserves a palette reference whose Brand B runtime definition is unavailable', async () => {
    const repository = new MemoryRepository();
    const brandBReference = {
      catalogId: 'brand-b-v1',
      sourceId: 'brand-b-blue-17',
      code: 'B17',
      name: 'Brand B Blue',
      hex: '#336699',
      rgb: [51, 102, 153] as [number, number, number]
    };
    const document = createDocument({
      catalog: DEFAULT_CATALOG_DEFINITION.association,
      width: 2,
      height: 2,
      palette: [
        { id: 1, name: 'DMC Red', color: '#CC3333' },
        { id: 2, name: brandBReference.name, color: brandBReference.hex, catalog: brandBReference },
        { id: 3, name: 'Custom Violet', color: '#AABBCC' }
      ]
    });
    const installedDmcOnly = createInstalledCatalogRegistry([DEFAULT_CATALOG_DEFINITION]);
    const workspace = new ProjectWorkspace({
      repository,
      clock: { now: () => 100 },
      projectIdFactory: () => 'unavailable-brand-b',
      debounceMs: 0,
      catalogRegistry: installedDmcOnly
    });
    await workspace.createProject({ id: 'unavailable-brand-b', width: 2, height: 2, document });
    await workspace.flush();
    const resolvedDmc = workspace.catalogFor(document);
    expect(resolvedDmc).toMatchObject({ association: DEFAULT_CATALOG_DEFINITION.association });
    expect(resolvedDmc?.records).toEqual(DEFAULT_CATALOG_DEFINITION.records);
    expect(resolvedDmc).not.toBe(DEFAULT_CATALOG_DEFINITION);
    expect(workspace.availableCatalogs().find((definition) => definition.association.catalogId === brandBReference.catalogId)).toBeUndefined();
    expect(workspace.document?.catalog).toEqual(DEFAULT_CATALOG_DEFINITION.association);
    expect(workspace.document?.palette[1].catalog).toEqual(brandBReference);
    await workspace.dispose();

    const reopened = new ProjectWorkspace({
      repository,
      clock: { now: () => 100 },
      projectIdFactory: () => 'unavailable-brand-b',
      debounceMs: 0,
      catalogRegistry: installedDmcOnly
    });
    try {
      const session = await reopened.openProject('unavailable-brand-b');
      const reopenedDmc = reopened.catalogFor(session.document);
      expect(reopenedDmc).toMatchObject({ association: DEFAULT_CATALOG_DEFINITION.association });
      expect(reopenedDmc?.records).toEqual(DEFAULT_CATALOG_DEFINITION.records);
      expect(reopenedDmc).not.toBe(DEFAULT_CATALOG_DEFINITION);
      expect(reopened.availableCatalogs().find((definition) => definition.association.catalogId === brandBReference.catalogId)).toBeUndefined();
      expect(session.document.catalog).toEqual(DEFAULT_CATALOG_DEFINITION.association);
      expect(session.document.palette[1].catalog).toEqual(brandBReference);
      expect(session.document.palette[2].catalog).toBeUndefined();
    } finally {
      await reopened.dispose();
    }
  });

  it('restores paint undo/redo across refresh and clears restored redo on a new action', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'refresh-paint', debounceMs: 0 });
    await workspace.createProject({ id: 'refresh-paint', width: 4, height: 4, document: createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 4, height: 4, palette: [{ id: 1, name: 'Ruby', color: '#b44' }] }) });
    const session = workspace.session;
    if (!session) throw new Error('Missing session.');
    session.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    session.execute({ type: 'set-full', x: 1, y: 1, color: 1 });
    session.undo();
    await workspace.flush();
    await workspace.dispose();

    const reopened = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'refresh-paint', debounceMs: 0 });
    try {
      const restored = await reopened.openProject('refresh-paint');
      expect(restored.historyUndoDepth).toBe(1);
      expect(restored.historyRedoDepth).toBe(1);
      restored.redo();
      expect(restored.document.kind[5]).toBe(1);
      restored.undo();
      restored.execute({ type: 'set-full', x: 2, y: 2, color: 1 });
      expect(restored.historyRedoDepth).toBe(0);
    } finally {
      await reopened.dispose();
    }
  });

  it('never saves a reference opacity of zero, hiding at full opacity instead', async () => {
    const workspace = await openTracedWorkspace('zero-opacity');
    try {
      const session = workspace.session;
      if (!session) throw new Error('Missing session.');
      session.applyTraceImageChange({ ...TRACE_DESCRIPTOR, opacity: 0 }, { label: 'trace-image-opacity' });
      expect(session.sourceImage).toMatchObject({ traceVisible: false, opacity: 1 });
    } finally {
      await workspace.dispose();
    }
  });

  it('restores an interleaved paint/trace/paint order across refresh', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'refresh-interleave', debounceMs: 0 });
    await workspace.createProject({
      id: 'refresh-interleave',
      width: 4,
      height: 4,
      document: createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 4, height: 4, palette: [{ id: 1, name: 'Ruby', color: '#b44' }] }),
      assets: [{ id: 'reference', name: 'reference.png', mimeType: 'image/png', data: pngBytes(2, 2) }],
      sourceImage: { ...TRACE_DESCRIPTOR }
    });
    const session = workspace.session;
    if (!session) throw new Error('Missing session.');
    session.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    session.applyTraceImageChange({ ...TRACE_DESCRIPTOR, opacity: 0.5 }, { label: 'opacity' });
    session.execute({ type: 'set-full', x: 1, y: 1, color: 1 });
    await workspace.flush();
    await workspace.dispose();

    const reopened = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'refresh-interleave', debounceMs: 0 });
    try {
      const restored = await reopened.openProject('refresh-interleave');
      expect(restored.historyUndoDepth).toBe(3);
      restored.undo();
      expect(restored.document.kind[5]).toBe(0);
      expect(restored.sourceImage?.opacity).toBe(0.5);
      restored.undo();
      expect(restored.sourceImage?.opacity).toBe(1);
      expect(restored.document.kind[0]).toBe(1);
      restored.undo();
      expect(restored.document.kind[0]).toBe(0);
      restored.redo();
      restored.redo();
      restored.redo();
      expect(restored.document.kind[5]).toBe(1);
      expect(restored.sourceImage?.opacity).toBe(0.5);
    } finally {
      await reopened.dispose();
    }
  });

  it('restores replacement and removal asset bytes after refresh', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'refresh-assets', debounceMs: 0 });
    await workspace.createProject({
      id: 'refresh-assets',
      width: 4,
      height: 4,
      document: createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 4, height: 4, palette: [{ id: 1, name: 'Ruby', color: '#b44' }] }),
      assets: [{ id: 'reference', name: 'reference.png', mimeType: 'image/png', data: pngBytes(2, 2) }],
      sourceImage: { ...TRACE_DESCRIPTOR }
    });
    const session = workspace.session;
    if (!session) throw new Error('Missing session.');
    const replacementBytes = pngBytes(3, 2);
    await session.replaceSourceImage({ asset: { id: 'replacement', name: 'replacement.png', mimeType: 'image/png', data: replacementBytes }, settings: { assetId: 'replacement', chartBounds: { x: 0, y: 0, width: 2, height: 2 } } });
    await workspace.flush();
    await workspace.dispose();

    const reopened = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'refresh-assets', debounceMs: 0 });
    try {
      const restored = await reopened.openProject('refresh-assets');
      restored.undo();
      expect(restored.sourceImage?.assetId).toBe('reference');
      expect(restored.getAsset('reference')?.data).toEqual(pngBytes(2, 2));
      restored.redo();
      expect(restored.getAsset('replacement')?.data).toEqual(replacementBytes);
      await restored.removeSourceImage();
      await reopened.flush();
      await reopened.dispose();

      const afterRemoval = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'refresh-assets', debounceMs: 0 });
      try {
        const removalRestored = await afterRemoval.openProject('refresh-assets');
        removalRestored.undo();
        expect(removalRestored.sourceImage?.assetId).toBe('replacement');
        expect(removalRestored.getAsset('replacement')?.data).toEqual(replacementBytes);
      } finally {
        await afterRemoval.dispose();
      }
    } finally {
      await reopened.dispose();
    }
  });

  it('stamps updatedAt when the source image is replaced and when it is removed', async () => {
    let now = 100;
    const workspace = new ProjectWorkspace({ repository: new MemoryRepository(), clock: { now: () => now }, projectIdFactory: () => 'stamped-source', debounceMs: 0 });
    try {
      await workspace.createProject({
        id: 'stamped-source',
        width: 4,
        height: 4,
        document: createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 4, height: 4, palette: [{ id: 1, name: 'Ruby', color: '#b44' }] }),
        assets: [{ id: 'reference', name: 'reference.png', mimeType: 'image/png', data: pngBytes(2, 2) }],
        sourceImage: { ...TRACE_DESCRIPTOR }
      });
      const session = workspace.session;
      if (!session) throw new Error('Missing session.');
      const created = session.metadata.updatedAt;

      now = 200;
      await session.replaceSourceImage({ asset: { id: 'replacement', name: 'replacement.png', mimeType: 'image/png', data: pngBytes(3, 2) }, settings: { assetId: 'replacement', chartBounds: { x: 0, y: 0, width: 2, height: 2 } } });
      expect(session.metadata.updatedAt).toBe(200);
      expect(session.metadata.updatedAt).toBeGreaterThan(created);

      now = 300;
      await session.removeSourceImage();
      expect(session.metadata.updatedAt).toBe(300);
    } finally {
      await workspace.dispose();
    }
  });

  it('serializes trace actions queued during an async replacement and restores their exact order', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'serialized-trace', debounceMs: 0 });
    await workspace.createProject({
      id: 'serialized-trace',
      width: 4,
      height: 4,
      document: createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 4, height: 4, palette: [{ id: 1, name: 'Ruby', color: '#b44' }] }),
      assets: [{ id: 'reference', name: 'reference.png', mimeType: 'image/png', data: pngBytes(2, 2) }],
      sourceImage: { ...TRACE_DESCRIPTOR }
    });
    const session = workspace.session;
    if (!session) throw new Error('Missing session.');
    let releaseSave!: () => void;
    let saveEntered!: () => void;
    const saveStarted = new Promise<void>((resolve) => { saveEntered = resolve; });
    const saveRelease = new Promise<void>((resolve) => { releaseSave = resolve; });
    repository.beforeSave = async () => {
      repository.beforeSave = undefined;
      saveEntered();
      await saveRelease;
    };
    const replacementBytes = pngBytes(3, 2);
    const replacement = session.replaceSourceImage({
      asset: { id: 'replacement', name: 'replacement.png', mimeType: 'image/png', data: replacementBytes },
      settings: { assetId: 'replacement', chartBounds: { x: 0, y: 0, width: 2, height: 2 }, opacity: 0.5 }
    });
    await saveStarted;
    const replacementDescriptor = { ...TRACE_DESCRIPTOR, assetId: 'replacement', width: 3, opacity: 0.5 };
    session.applyTraceImageChange({ ...replacementDescriptor, opacity: 0.25 }, { label: 'queued-descriptor' });
    session.undo();
    session.redo();
    releaseSave();
    await replacement;
    await workspace.flush();

    expect(session.sourceImage?.assetId).toBe('replacement');
    expect(session.sourceImage?.opacity).toBe(0.25);
    expect((await repository.load('serialized-trace'))?.history?.trace.undo.map((entry) => entry.label)).toEqual(['source-image-replace', 'queued-descriptor']);
    await workspace.dispose();

    const reopened = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'serialized-trace', debounceMs: 0 });
    try {
      const restored = await reopened.openProject('serialized-trace');
      restored.undo();
      expect(restored.sourceImage?.opacity).toBe(0.5);
      restored.undo();
      expect(restored.sourceImage?.assetId).toBe('reference');
      restored.redo();
      expect(restored.sourceImage?.assetId).toBe('replacement');
      expect(restored.sourceImage?.opacity).toBe(0.5);
      restored.redo();
      expect(restored.sourceImage?.opacity).toBe(0.25);
    } finally {
      await reopened.dispose();
    }
  });

  it('serializes a removal requested during replacement and restores the empty source state', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'queued-removal', debounceMs: 0 });
    await workspace.createProject({
      id: 'queued-removal',
      width: 4,
      height: 4,
      document: createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 4, height: 4, palette: [{ id: 1, name: 'Ruby', color: '#b44' }] }),
      assets: [{ id: 'reference', name: 'reference.png', mimeType: 'image/png', data: pngBytes(2, 2) }],
      sourceImage: { ...TRACE_DESCRIPTOR }
    });
    const session = workspace.session;
    if (!session) throw new Error('Missing session.');
    let releaseSave!: () => void;
    let saveEntered!: () => void;
    const saveStarted = new Promise<void>((resolve) => { saveEntered = resolve; });
    const saveRelease = new Promise<void>((resolve) => { releaseSave = resolve; });
    repository.beforeSave = async () => {
      repository.beforeSave = undefined;
      saveEntered();
      await saveRelease;
    };
    const replacement = session.replaceSourceImage({
      asset: { id: 'replacement', name: 'replacement.png', mimeType: 'image/png', data: pngBytes(3, 2) },
      settings: { assetId: 'replacement', chartBounds: { x: 0, y: 0, width: 2, height: 2 }, opacity: 0.5 }
    });
    await saveStarted;
    const removal = session.removeSourceImage();
    releaseSave();
    await replacement;
    await removal;
    await workspace.flush();
    expect(session.sourceImage).toBeUndefined();
    expect((await repository.load('queued-removal'))?.history?.trace.undo.map((entry) => entry.label)).toEqual(['source-image-replace', 'source-image-remove']);
    await workspace.dispose();

    const reopened = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'queued-removal', debounceMs: 0 });
    try {
      const restored = await reopened.openProject('queued-removal');
      expect(restored.sourceImage).toBeUndefined();
      restored.undo();
      expect(restored.sourceImage?.assetId).toBe('replacement');
      restored.undo();
      expect(restored.sourceImage?.assetId).toBe('reference');
      restored.redo();
      restored.redo();
      expect(restored.sourceImage).toBeUndefined();
    } finally {
      await reopened.dispose();
    }
  });

  it('bounds trace export before cloning repeated captured asset bytes', async () => {
    const repository = new MemoryRepository();
    const session = new ProjectSession({
      repository,
      metadata: { id: 'bounded-trace-export', title: 'Bounded', notes: '', createdAt: 100, updatedAt: 100, revision: 0 },
      document: createLayeredDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 2, height: 2, palette: [] }),
      preparationClient: {
        prepare: async () => { throw new Error('not used'); },
        getRequestId: () => 'bounded',
        dispose: () => undefined
      } as PersistencePreparationClient,
      clock: { now: () => 100 },
      debounceMs: 0
    });
    const data = new Uint8Array(1024 * 1024);
    const asset = { id: 'reference', name: 'large.png', mimeType: 'image/png', data, checksum: '0'.repeat(64) };
    const entries = Array.from({ length: 9 }, (_, index) => ({
      label: `large-replacement-${String(index)}`,
      beforeDescriptor: { ...TRACE_DESCRIPTOR, opacity: index / 10 },
      afterDescriptor: { ...TRACE_DESCRIPTOR, opacity: (index + 1) / 10 },
      beforeAsset: asset,
      afterAsset: asset
    }));
    const internal = session as unknown as {
      traceUndoStack: typeof entries;
      historyKindsUndo: Array<'document' | 'trace'>;
      exportHistoryEnvelope: () => SessionHistoryEnvelope;
    };
    internal.traceUndoStack = entries;
    internal.historyKindsUndo = entries.map(() => 'trace');
    const exported = internal.exportHistoryEnvelope();
    const retainedLabels = exported.trace.undo.map((entry) => entry.label);
    expect(retainedLabels.length).toBeGreaterThan(0);
    expect(retainedLabels).toEqual(entries.slice(entries.length - retainedLabels.length).map((entry) => entry.label));
    expect(exported.undoOrder).toEqual(retainedLabels.map((_, index) => ({ kind: 'trace', index })));
    const captured = exported.trace.undo[0]?.assetBefore;
    if (!captured || captured.kind !== 'captured') throw new Error('Missing retained captured asset.');
    if (captured.asset.data.byteLength !== data.byteLength) throw new Error(`Unexpected retained byte length ${String(captured.asset.data.byteLength)}.`);
    if (captured.asset.data === data) throw new Error('Retained captured asset was not detached.');
  });

  it('discards rejected restored history without losing the canonical project', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'rejected-history', debounceMs: 0 });
    await workspace.createProject({ id: 'rejected-history', width: 4, height: 4, document: createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 4, height: 4, palette: [{ id: 1, name: 'Ruby', color: '#b44' }] }) });
    const session = workspace.session;
    if (!session) throw new Error('Missing session.');
    session.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    await workspace.flush();
    const stored = repository.records.get('rejected-history');
    if (!stored?.history) throw new Error('Missing stored history.');
    stored.history = { ...stored.history, undoOrder: [] };
    await workspace.dispose();

    const reopened = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'rejected-history', debounceMs: 0 });
    try {
      const restored = await reopened.openProject('rejected-history');
      expect(restored.document.kind[0]).toBe(1);
      expect(restored.historyUndoDepth).toBe(0);
      expect(restored.historyUndoDepth).toBe(0);
    } finally {
      await reopened.dispose();
    }
  });

  it('reconciles unified markers when the document history evicts entries', async () => {
    const repository = new MemoryRepository();
    const session = new ProjectSession({
      repository,
      metadata: { id: 'eviction', title: 'Eviction', notes: '', createdAt: 100, updatedAt: 100, revision: 0 },
      document: createLayeredDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 4, height: 4, palette: [{ id: 1, name: 'Ruby', color: '#b44' }] }),
      preparationClient: createPersistencePreparationClient({ useWorker: false }),
      clock: { now: () => 100 },
      debounceMs: 0,
      historyLimitBytes: 256
    });
    try {
      for (let index = 0; index < 16; index += 1) session.execute({ type: 'set-full', x: index % 4, y: Math.floor(index / 4), color: 1 });
      const editor = (session as unknown as { editor: { undoDepth: number } }).editor;
      expect(editor.undoDepth).toBeLessThan(16);
      expect(session.historyUndoDepth).toBe(editor.undoDepth);
      while (editor.undoDepth > 0) session.undo();
      expect(session.historyUndoDepth).toBe(0);
      expect(session.historyUndoDepth).toBe(0);
    } finally {
      await session.dispose();
    }
  });

  it('interleaves paint, move, and paint chronologically through one undo/redo flow', async () => {
    const workspace = await openTracedWorkspace('trace-interleave');
    try {
      const session = workspace.session;
      if (!session) throw new Error('Missing session.');
      expect(session.historyUndoDepth).toBe(0);

      session.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
      session.applyTraceImageChange(
        { ...TRACE_DESCRIPTOR, chartBounds: { x: 1, y: 0, width: 2, height: 2 } },
        { label: 'trace-image-bounds' }
      );
      session.execute({ type: 'set-full', x: 1, y: 1, color: 1 });
      expect(session.historyUndoDepth).toBe(3);
      expect(session.document.kind[0]).toBe(1);
      expect(session.document.kind[5]).toBe(1);
      expect(session.sourceImage?.chartBounds).toEqual({ x: 1, y: 0, width: 2, height: 2 });

      session.undo();
      expect(session.document.kind[5]).toBe(0);
      expect(session.document.kind[0]).toBe(1);
      expect(session.sourceImage?.chartBounds).toEqual({ x: 1, y: 0, width: 2, height: 2 });

      session.undo();
      expect(session.sourceImage?.chartBounds).toEqual({ x: 0, y: 0, width: 2, height: 2 });
      expect(session.document.kind[0]).toBe(1);

      session.undo();
      expect(session.document.kind[0]).toBe(0);
      expect(session.sourceImage?.chartBounds).toEqual({ x: 0, y: 0, width: 2, height: 2 });
      expect(session.historyUndoDepth).toBe(0);
      expect(session.historyRedoDepth).toBe(3);

      session.redo();
      expect(session.document.kind[0]).toBe(1);
      expect(session.sourceImage?.chartBounds).toEqual({ x: 0, y: 0, width: 2, height: 2 });

      session.redo();
      expect(session.sourceImage?.chartBounds).toEqual({ x: 1, y: 0, width: 2, height: 2 });

      session.redo();
      expect(session.document.kind[5]).toBe(1);
      expect(session.historyRedoDepth).toBe(0);
    } finally {
      await workspace.dispose();
    }
  });

  it('coalesces one drag to one entry, three arrows to three entries, and a toggle to none', async () => {
    const workspace = await openTracedWorkspace('trace-coalesce');
    try {
      const session = workspace.session;
      if (!session) throw new Error('Missing session.');

      // One drag gesture commits once.
      session.applyTraceImageChange(
        { ...TRACE_DESCRIPTOR, chartBounds: { x: 2, y: 1, width: 2, height: 2 } },
        { label: 'trace-image-bounds' }
      );
      expect(session.historyUndoDepth).toBe(1);

      session.undo();
      expect(session.sourceImage?.chartBounds).toEqual({ x: 0, y: 0, width: 2, height: 2 });
      session.redo();
      expect(session.sourceImage?.chartBounds).toEqual({ x: 2, y: 1, width: 2, height: 2 });

      // Three arrow nudges are three entries.
      const moved = session.sourceImage;
      if (!moved) throw new Error('Missing descriptor.');
      session.applyTraceImageChange({ ...moved, chartBounds: { x: 3, y: 1, width: 2, height: 2 } }, { label: 'trace-image-bounds' });
      session.applyTraceImageChange({ ...moved, chartBounds: { x: 4, y: 1, width: 2, height: 2 } }, { label: 'trace-image-bounds' });
      session.applyTraceImageChange({ ...moved, chartBounds: { x: 5, y: 1, width: 2, height: 2 } }, { label: 'trace-image-bounds' });
      expect(session.sourceImage?.chartBounds).toEqual({ x: 5, y: 1, width: 2, height: 2 });
      session.undo();
      expect(session.sourceImage?.chartBounds).toEqual({ x: 4, y: 1, width: 2, height: 2 });
      session.undo();
      expect(session.sourceImage?.chartBounds).toEqual({ x: 3, y: 1, width: 2, height: 2 });
      session.undo();
      expect(session.sourceImage?.chartBounds).toEqual({ x: 2, y: 1, width: 2, height: 2 });

      // A visibility toggle is saved but is no entry, and it keeps redo.
      const toggled = session.sourceImage;
      if (!toggled) throw new Error('Missing descriptor.');
      const depthBeforeToggle = session.historyUndoDepth;
      session.applyTraceImageChange({ ...toggled, traceVisible: false }, { label: 'trace-image-visibility' });
      expect(session.historyUndoDepth).toBe(depthBeforeToggle);
      expect(session.historyRedoDepth).toBeGreaterThan(0);
      expect(session.sourceImage?.traceVisible).toBe(false);
      expect(session.saveState.status).toBe('pending');
      // Undo and redo move the reference without showing it again.
      session.undo();
      expect(session.sourceImage?.chartBounds).toEqual({ x: 0, y: 0, width: 2, height: 2 });
      expect(session.sourceImage?.traceVisible).toBe(false);
      session.redo();
      expect(session.sourceImage?.chartBounds).toEqual({ x: 2, y: 1, width: 2, height: 2 });
      expect(session.sourceImage?.traceVisible).toBe(false);
      session.applyTraceImageChange({ ...session.sourceImage!, traceVisible: true }, { label: 'trace-image-visibility' });
      expect(session.sourceImage?.traceVisible).toBe(true);

      // One slider interaction commits once.
      const slid = session.sourceImage;
      if (!slid) throw new Error('Missing descriptor.');
      const depthBeforeSlider = session.historyUndoDepth;
      session.applyTraceImageChange({ ...slid, opacity: 0.4 }, { label: 'trace-image-opacity' });
      expect(session.historyUndoDepth).toBe(depthBeforeSlider + 1);
      expect(session.sourceImage?.opacity).toBe(0.4);
      session.undo();
      expect(session.sourceImage?.opacity).toBe(1);
    } finally {
      await workspace.dispose();
    }
  });

  it('restores previous asset bytes and the descriptor on import undo, and re-applies on redo', async () => {
    const workspace = await openTracedWorkspace('trace-import');
    try {
      const session = workspace.session;
      if (!session) throw new Error('Missing session.');
      const oldBytes = pngBytes(2, 2);
      const newBytes = pngBytes(3, 2);
      expect(session.getAsset('reference')?.data).toEqual(oldBytes);

      await session.replaceSourceImage(
        { asset: { id: 'replacement', name: 'replacement.png', mimeType: 'image/png', data: newBytes }, settings: { assetId: 'replacement', chartBounds: { x: 0, y: 0, width: 2, height: 2 } } }
      );
      expect(session.sourceImage?.assetId).toBe('replacement');
      expect(session.getAsset('reference')).toBeUndefined();
      expect(session.getAsset('replacement')?.data).toEqual(newBytes);

      session.undo();
      expect(session.sourceImage?.assetId).toBe('reference');
      expect(session.sourceImage).toMatchObject({ width: 2, height: 2 });
      expect(session.getAsset('reference')?.data).toEqual(oldBytes);
      expect(session.getAsset('replacement')).toBeUndefined();

      session.redo();
      expect(session.sourceImage?.assetId).toBe('replacement');
      expect(session.getAsset('replacement')?.data).toEqual(newBytes);
      expect(session.getAsset('reference')).toBeUndefined();
    } finally {
      await workspace.dispose();
    }
  });

  it('restores the descriptor and bytes on remove undo, and clears redo on a new action', async () => {
    const workspace = await openTracedWorkspace('trace-remove');
    try {
      const session = workspace.session;
      if (!session) throw new Error('Missing session.');
      const kept = pngBytes(2, 2);

      await session.removeSourceImage();
      expect(session.sourceImage).toBeUndefined();
      expect(session.getAsset('reference')).toBeUndefined();

      session.undo();
      expect(session.sourceImage?.assetId).toBe('reference');
      expect(session.getAsset('reference')?.data).toEqual(kept);

      session.redo();
      expect(session.sourceImage).toBeUndefined();
      expect(session.getAsset('reference')).toBeUndefined();

      session.undo();
      expect(session.sourceImage?.assetId).toBe('reference');

      // A new stitch action clears the redo stack (standard).
      session.execute({ type: 'set-full', x: 2, y: 2, color: 1 });
      expect(session.historyRedoDepth).toBe(0);
      const redone = session.redo();
      expect(redone.changed).toBe(false);
      expect(session.sourceImage?.assetId).toBe('reference');

      // A new trace action also clears document redo.
      session.undo();
      expect(session.historyRedoDepth).toBeGreaterThan(0);
      const moved = session.sourceImage;
      if (!moved) throw new Error('Missing descriptor.');
      session.applyTraceImageChange({ ...moved, chartBounds: { x: 1, y: 1, width: 2, height: 2 } }, { label: 'trace-image-bounds' });
      expect(session.historyRedoDepth).toBe(0);
    } finally {
      await workspace.dispose();
    }
  });

  it('persists undone trace state through the normal autosave', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'trace-persist', debounceMs: 0 });
    try {
      await workspace.createProject({
        id: 'trace-persist',
        width: 4,
        height: 4,
        document: createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 4, height: 4, palette: [{ id: 1, name: 'Ruby', color: '#b44' }] }),
        assets: [{ id: 'reference', name: 'reference.png', mimeType: 'image/png', data: pngBytes(2, 2) }],
        sourceImage: { ...TRACE_DESCRIPTOR }
      });
      const session = workspace.session;
      if (!session) throw new Error('Missing session.');
      session.applyTraceImageChange(
        { ...TRACE_DESCRIPTOR, opacity: 0.25 },
        { label: 'trace-image-opacity' }
      );
      await workspace.flush();
      expect((await repository.load('trace-persist'))?.metadata.sourceImage).toMatchObject({ opacity: 0.25 });
      session.undo();
      await workspace.flush();
      expect((await repository.load('trace-persist'))?.metadata.sourceImage).toMatchObject({ opacity: 1 });
    } finally {
      await workspace.dispose();
    }
  });
});
