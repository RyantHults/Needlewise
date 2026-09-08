import { describe, expect, it } from 'vitest';
import {
  cloneDocument,
  createDocument,
  type PatternDocument
} from '../domain';
import {
  PersistenceError,
  sha256,
  type ProjectAsset,
  type ProjectAssetInput,
  type ProjectMetadata,
  type ProjectRecord,
  type SaveOptions,
  type SaveResult
} from '../persistence';
import { ProjectWorkspace } from './index';
import type { WorkspaceRepository } from './types';

function copyRecord(record: ProjectRecord): ProjectRecord {
  return {
    metadata: { ...record.metadata },
    document: cloneDocument(record.document),
    ...(record.head === undefined ? {} : { head: { ...record.head } }),
    recovery: record.recovery === null ? null : { revision: record.recovery.revision, document: cloneDocument(record.recovery.document) },
    assets: record.assets.map((asset) => ({ ...asset, data: new Uint8Array(asset.data) }))
  };
}

class MemoryRepository implements WorkspaceRepository {
  readonly records = new Map<string, ProjectRecord>();

  async save(projectId: string, metadata: ProjectMetadata, document: PatternDocument, assets?: readonly ProjectAssetInput[], options: SaveOptions = {}): Promise<SaveResult> {
    const current = this.records.get(projectId);
    if (options.mode === 'retain') {
      const expectedHead = options.expectedHead;
      const expectedRevision = options.expectedRevision ?? (typeof expectedHead === 'number' ? expectedHead : expectedHead?.revision);
      const expectedChecksum = typeof expectedHead === 'object' && expectedHead !== null ? expectedHead.checksum : undefined;
      if (!current?.head || expectedRevision !== current.head.revision || (expectedChecksum !== undefined && expectedChecksum !== current.head.checksum)) return { committed: false, stale: true, revision: current?.document.revision ?? document.revision };
    } else if (current && (current.document.revision > document.revision || (current.document.revision === document.revision && !options.allowSameRevision))) return { committed: false, stale: true, revision: current.document.revision };
    const retained = options.mode === 'retain';
    const persistedDocument = retained && current ? current.document : document;
    const head = retained && current?.head
      ? { ...current.head }
      : { projectId, revision: persistedDocument.revision, checksum: await sha256(new TextEncoder().encode(JSON.stringify(persistedDocument))) };
    const nextAssets: ProjectAsset[] = assets === undefined
      ? current?.assets ?? []
      : [];
    if (assets !== undefined) {
      for (const asset of assets) {
        const data = asset.data instanceof Uint8Array ? asset.data.slice() : asset.data instanceof ArrayBuffer ? new Uint8Array(asset.data).slice() : new Uint8Array(await asset.data.arrayBuffer());
        nextAssets.push({ id: asset.id, name: asset.name, mimeType: asset.mimeType, data, checksum: await sha256(data) });
      }
    }
    this.records.set(projectId, {
      metadata: { ...metadata },
      document: cloneDocument(persistedDocument),
      head,
      recovery: retained ? current?.recovery ?? null : current === undefined ? null : { revision: current.document.revision, document: cloneDocument(current.document) },
      assets: nextAssets
    });
    return { committed: true, stale: false, revision: persistedDocument.revision, head };
  }

  async load(projectId: string): Promise<ProjectRecord | undefined> {
    const record = this.records.get(projectId);
    return record === undefined ? undefined : copyRecord(record);
  }

  async listProjects(): Promise<ProjectMetadata[]> {
    return [...this.records.values()].map((record) => ({ ...record.metadata }));
  }

  async deleteProject(projectId: string): Promise<void> {
    this.records.delete(projectId);
  }

  async exportProject(): Promise<Uint8Array> {
    throw new PersistenceError('storage-failure', 'Not used in trace-history tests.');
  }

  async importProject(): Promise<ProjectRecord> {
    throw new PersistenceError('storage-failure', 'Not used in trace-history tests.');
  }
}

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
    document: createDocument({ width: 4, height: 4, palette: [{ id: 1, name: 'Ruby', color: '#b44' }] }),
    assets: [{ id: 'reference', name: 'reference.png', mimeType: 'image/png', data: pngBytes(2, 2) }],
    sourceImage: { ...TRACE_DESCRIPTOR }
  });
  return workspace;
}

describe('trace image unified history', () => {
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

  it('coalesces one drag to one entry, three arrows to three entries, and a toggle to one entry', async () => {
    const workspace = await openTracedWorkspace('trace-coalesce');
    try {
      const session = workspace.session;
      if (!session) throw new Error('Missing session.');

      // One drag gesture commits once.
      session.applyTraceImageChange(
        { ...TRACE_DESCRIPTOR, chartBounds: { x: 2, y: 1, width: 2, height: 2 } },
        { label: 'trace-image-bounds' }
      );
      expect(session.traceUndoDepth).toBe(1);

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

      // One visibility toggle is one entry.
      const toggled = session.sourceImage;
      if (!toggled) throw new Error('Missing descriptor.');
      const depthBeforeToggle = session.traceUndoDepth;
      session.applyTraceImageChange({ ...toggled, traceVisible: false }, { label: 'trace-image-visibility' });
      expect(session.traceUndoDepth).toBe(depthBeforeToggle + 1);
      expect(session.sourceImage?.traceVisible).toBe(false);
      session.undo();
      expect(session.sourceImage?.traceVisible).toBe(true);

      // One slider interaction commits once.
      const slid = session.sourceImage;
      if (!slid) throw new Error('Missing descriptor.');
      const depthBeforeSlider = session.traceUndoDepth;
      session.applyTraceImageChange({ ...slid, opacity: 0.4 }, { label: 'trace-image-opacity' });
      expect(session.traceUndoDepth).toBe(depthBeforeSlider + 1);
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
      expect(session.canRedo).toBe(false);
      const redone = session.redo();
      expect(redone.changed).toBe(false);
      expect(session.sourceImage?.assetId).toBe('reference');

      // A new trace action also clears document redo.
      session.undo();
      expect(session.canRedo).toBe(true);
      const moved = session.sourceImage;
      if (!moved) throw new Error('Missing descriptor.');
      session.applyTraceImageChange({ ...moved, chartBounds: { x: 1, y: 1, width: 2, height: 2 } }, { label: 'trace-image-bounds' });
      expect(session.canRedo).toBe(false);
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
        document: createDocument({ width: 4, height: 4, palette: [{ id: 1, name: 'Ruby', color: '#b44' }] }),
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
