import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { applyCommand, CellKind, cloneDocument, computePatternMetrics, createDocument as createDomainDocument, createEditor, QuarterCorner, type CatalogAssociation, type CreateDocumentOptions, type PatternDocument } from '../domain';
import { DMC_CATALOG_DEFINITION } from '../catalog';
import * as binaryModule from './binary';
import * as hashModule from './hash';
import { prepareDocumentSnapshot, type PersistencePreparationResponse } from './preparation';
import { handlePersistencePreparationWorkerMessage } from '../workers/persistence-preparation.worker';
import {
  decodeDocument,
  encodeDocument,
  exportArchive,
  validateArchiveManifest,
  MAX_ARCHIVE_BYTES,
  MAX_ASSET_BYTES,
  MAX_DOCUMENT_CELLS,
  MAX_DOCUMENT_BYTES,
  MAX_SESSION_HISTORY_BYTES,
  PERSISTENCE_SCHEMA_VERSION,
  parseArchive,
  PersistenceError,
  PersistencePreparationWorkerClient,
  prepareSessionHistory,
  ProjectRepository,
  NeedlewiseDatabase,
  deriveProjectSummary,
  inspectRasterAsset,
  normalizeSourceImageAsset,
  normalizeSourceImageDescriptor,
  sha256,
  traceStateFingerprint,
  type ProjectMetadata,
  type PreparedDocumentCapability,
  type StoredDocumentSnapshot,
  type SessionHistoryEnvelope,
  type SourceImageDescriptor,
  type TraceHistoryAsset
} from './index';
import { describe, expect, it, vi } from 'vitest';

let databaseCounter = 0;

const TEST_CATALOG: CatalogAssociation = { catalogId: 'test-catalog-v1', brandLabel: 'Test catalog', colorCount: 32 };

function createDocument(options: Omit<CreateDocumentOptions, 'catalog'> & { catalog?: CatalogAssociation }): PatternDocument {
  return createDomainDocument({ ...options, catalog: options.catalog ?? TEST_CATALOG });
}

function makeDocument(): PatternDocument {
  let document = createDocument({
    width: 3,
    height: 2,
    palette: [
      { id: 1, name: 'Red', color: '#d33' },
      { id: 2, name: 'Blue', color: '#36c' }
    ]
  });
  document = applyCommand(document, { type: 'set-full', x: 0, y: 0, color: 1 }).document;
  document = applyCommand(document, { type: 'set-quarter', x: 1, y: 0, corner: 0, color: 2 }).document;
  document = applyCommand(document, { type: 'set-quarter', x: 1, y: 0, corner: 2, color: 1 }).document;
  document = applyCommand(document, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 12, y: 8 }, color: 2 }).document;
  return document;
}

function legacyV1Snapshot(): Uint8Array {
  const text = new TextEncoder();
  const strings = ['test-catalog', 'Test catalog', 'default', 'skeins'].map((value) => text.encode(value));
  const payloadLength = strings.reduce((length, value) => length + 4 + value.length, 0) + 4 + 10;
  const bytes = new Uint8Array(40 + payloadLength);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4e, 0x57, 0x44, 0x4f, 0x43, 0x31, 0x01, 0x00], 0);
  view.setUint16(8, 1, true);
  view.setUint8(10, 1);
  view.setUint32(12, 1, true);
  view.setUint32(16, 1, true);
  view.setUint32(24, 1, true);
  view.setUint32(28, 1, true);
  let offset = 40;
  for (const value of strings.slice(0, 2)) {
    view.setUint32(offset, value.length, true);
    offset += 4;
    bytes.set(value, offset);
    offset += value.length;
  }
  view.setUint32(offset, TEST_CATALOG.colorCount, true);
  offset += 4;
  for (const value of strings.slice(2)) {
    view.setUint32(offset, value.length, true);
    offset += 4;
    bytes.set(value, offset);
    offset += value.length;
  }
  // Empty cell kind, four empty color slots, and empty completion plane.
  return bytes;
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

function jpegBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(21);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(7, height, false);
  view.setUint16(9, width, false);
  return bytes;
}

function jpegBytesWithExifOrientation(width: number, height: number, orientation: number): Uint8Array {
  const exif = new Uint8Array(32);
  exif.set([69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0], 0);
  const exifView = new DataView(exif.buffer);
  exifView.setUint16(14, 1, true);
  exifView.setUint16(16, 0x0112, true);
  exifView.setUint16(18, 3, true);
  exifView.setUint32(20, 1, true);
  exifView.setUint16(24, orientation, true);

  const bytes = new Uint8Array(2 + 2 + 2 + exif.length + 2 + 2 + 11);
  let offset = 0;
  bytes.set([0xff, 0xd8, 0xff, 0xe1], offset); offset += 4;
  new DataView(bytes.buffer).setUint16(offset, exif.length + 2, false); offset += 2;
  bytes.set(exif, offset); offset += exif.length;
  bytes.set([0xff, 0xc0], offset); offset += 2;
  new DataView(bytes.buffer).setUint16(offset, 11, false); offset += 2;
  bytes[offset++] = 8;
  new DataView(bytes.buffer).setUint16(offset, height, false); offset += 2;
  new DataView(bytes.buffer).setUint16(offset, width, false); offset += 2;
  bytes.set([1, 1, 0x11, 0], offset);
  return bytes;
}

function webpBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([82, 73, 70, 70, 22, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 88, 10, 0, 0, 0], 0);
  bytes[24] = (width - 1) & 0xff;
  bytes[25] = ((width - 1) >> 8) & 0xff;
  bytes[26] = ((width - 1) >> 16) & 0xff;
  bytes[27] = (height - 1) & 0xff;
  bytes[28] = ((height - 1) >> 8) & 0xff;
  bytes[29] = ((height - 1) >> 16) & 0xff;
  return bytes;
}

function webpLosslessBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(25);
  bytes.set([82, 73, 70, 70, 18, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 76, 5, 0, 0, 0, 47], 0);
  const encodedWidth = width - 1;
  const encodedHeight = height - 1;
  bytes[21] = encodedWidth & 0xff;
  bytes[22] = ((encodedWidth >> 8) & 0x3f) | ((encodedHeight & 0x03) << 6);
  bytes[23] = (encodedHeight >> 2) & 0xff;
  bytes[24] = (encodedHeight >> 10) & 0x3f;
  return bytes;
}

function metadata(document: PatternDocument, id = 'project-1'): ProjectMetadata {
  return { id, title: 'Test project', notes: 'Local notes', createdAt: 1, updatedAt: Date.now(), revision: document.revision };
}

async function traceHistoryFixture(document: PatternDocument, assetId = 'reference'): Promise<{ history: SessionHistoryEnvelope; asset: TraceHistoryAsset; descriptor: SourceImageDescriptor }> {
  const data = pngBytes(2, 2);
  const asset: TraceHistoryAsset = { id: assetId, name: 'reference.png', mimeType: 'image/png', data, checksum: await sha256(data) };
  const descriptor: SourceImageDescriptor = {
    assetId,
    mimeType: 'image/png',
    width: 2,
    height: 2,
    crop: { x: 0, y: 0, width: 1, height: 1 },
    chartBounds: { x: 0, y: 0, width: document.width, height: document.height },
    traceVisible: true,
    opacity: 0.8
  };
  return {
    history: {
      version: 1,
      document: createEditor(document).exportHistory(),
      trace: {
        undo: [{ label: 'import reference', sourceBefore: null, sourceAfter: descriptor, assetBefore: { kind: 'absent' }, assetAfter: { kind: 'captured', asset } }],
        redo: []
      },
      undoOrder: [{ kind: 'trace', index: 0 }],
      redoOrder: []
    },
    asset,
    descriptor
  };
}

async function repository(): Promise<ProjectRepository> {
  databaseCounter += 1;
  const db = new NeedlewiseDatabase(`needlewise-persistence-test-${String(databaseCounter)}`);
  return new ProjectRepository(db, { now: () => 10 });
}

async function closeRepository(repo: ProjectRepository): Promise<void> {
  await repo.close();
  await repo.db.delete();
}

function cachedCurrent(repo: ProjectRepository): StoredDocumentSnapshot | undefined {
  return (repo as unknown as { verifiedCurrentCache?: StoredDocumentSnapshot }).verifiedCurrentCache;
}

function centralDirectoryOffset(archive: Uint8Array): number {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  for (let offset = archive.length - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return view.getUint32(offset + 16, true);
  }
  throw new Error('missing EOCD');
}

function mutateFirstCentralEntry(archive: Uint8Array, mutate: (view: DataView, offset: number) => void): Uint8Array {
  const result = archive.slice();
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  mutate(view, centralDirectoryOffset(result));
  return result;
}

function corruptBytes(bytes: Uint8Array): Uint8Array {
  const result = bytes.slice();
  result[0] ^= 0xff;
  return result;
}

class RepositoryPreparationWorker {
  private readonly listeners = new Map<string, (event: unknown) => void>();

  postMessage(message: unknown): void {
    handlePersistencePreparationWorkerMessage(message, (response: PersistencePreparationResponse) => {
      this.listeners.get('message')?.({ data: response });
    });
  }

  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: unknown) => void): void {
    this.listeners.set(type, listener);
  }

  removeEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: unknown) => void): void {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }

  terminate(): void {
    this.listeners.clear();
  }
}

describe('durable document history persistence', () => {
  it('round-trips detached history anchored to the exact current head', async () => {
    const repo = await repository();
    try {
      const base = createDocument({ width: 2, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const editor = createEditor(base);
      const document = editor.execute({ type: 'set-full', x: 0, y: 0, color: 1 }).document;
      const history = editor.exportHistory();
      expect(await prepareSessionHistory(document, history)).toBeDefined();
      await repo.save('history-round-trip', metadata(document, 'history-round-trip'), document, undefined, { history });

      const stored = await repo.db.documentHistories.get('history-round-trip');
      const head = await repo.db.projectHeads.get('history-round-trip');
      expect(stored).toMatchObject({ projectId: 'history-round-trip', revision: document.revision, checksum: head?.checksum, savedAt: 10 });
      expect(stored?.history.version).toBe(history.version);
      expect(stored?.history.document.undo).toHaveLength(history.undo.length);
      expect(stored?.history.document.redo).toHaveLength(history.redo.length);
      expect(stored?.history.document.undo[0]?.kind).toBe(history.undo[0]?.kind);
      expect(Array.from((stored?.history.document.undo[0] as { kind: 'delta'; delta: { cells: { indices: Uint32Array } } }).delta.cells.indices)).toEqual(Array.from((history.undo[0] as { kind: 'delta'; delta: { cells: { indices: Uint32Array } } }).delta.cells.indices));
      const loaded = await repo.load('history-round-trip');
      expect(loaded?.history?.document.undo).toHaveLength(history.undo.length);
      expect(loaded?.history?.undoOrder).toEqual([{ kind: 'document', index: 0 }]);

      const twoStepEditor = createEditor(base);
      twoStepEditor.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
      const twoStep = twoStepEditor.execute({ type: 'set-full', x: 1, y: 0, color: 1 }).document;
      const reversedMarkers = {
        version: 1 as const,
        document: twoStepEditor.exportHistory(),
        trace: { undo: [], redo: [] },
        undoOrder: [{ kind: 'document' as const, index: 1 }, { kind: 'document' as const, index: 0 }],
        redoOrder: []
      };
      expect(await prepareSessionHistory(twoStep, reversedMarkers)).toBeUndefined();
      expect(await prepareSessionHistory(twoStep, { ...reversedMarkers, undoOrder: [] })).toBeUndefined();

      const aliased = twoStepEditor.exportHistory();
      const aliasedEntry = aliased.undo[0] as unknown as { kind: 'delta'; delta: { cells: Record<string, unknown> } };
      const sharedIndices = aliasedEntry.delta.cells.indices;
      aliasedEntry.delta.cells.afterKind = sharedIndices;
      expect(await prepareSessionHistory(twoStep, aliased)).toBeUndefined();
    } finally {
      await closeRepository(repo);
    }
  });

  it('keeps settings-only history for a maximum-size document within the session persistence budget', async () => {
    const document = createDocument({ width: 1_000_000, height: 1, palette: [] });
    const editor = createEditor(document);
    const changed = editor.execute({ type: 'document-settings-update', settings: { backgroundColor: '#aabbcc' } }).document;
    const prepared = await prepareSessionHistory(changed, editor.exportHistory());

    expect(editor.historyBytes).toBeLessThan(MAX_SESSION_HISTORY_BYTES);
    expect(prepared).toBeDefined();
    const entry = prepared?.document.undo[0];
    expect(entry?.kind).toBe('delta');
    if (entry?.kind === 'delta') expect(entry.delta.cells.indices).toHaveLength(0);
  });

  it('accepts legacy session snapshots after validating their old accounting', async () => {
    const original = createDocument({ width: 1, height: 2, palette: [] });
    const editor = createEditor(original);
    const document = editor.execute({ type: 'rotate-cw' }).document;
    const documentHistory = editor.exportHistory();
    const entry = documentHistory.undo[0] as unknown as { before: PatternDocument; after: PatternDocument; bytes: number };
    const oldSnapshotBytes = (snapshot: PatternDocument) => {
      const store = snapshot.backstitches;
      return snapshot.kind.byteLength + snapshot.colors.byteLength + snapshot.completed.byteLength
        + store.ids.byteLength + store.x1.byteLength + store.y1.byteLength + store.x2.byteLength + store.y2.byteLength
        + store.colors.byteLength + store.completed.byteLength
        + JSON.stringify(snapshot.catalog).length * 2
        + JSON.stringify(snapshot.palette).length * 2
        + 64;
    };
    for (const snapshot of [entry.before, entry.after]) {
      snapshot.settings = { symbolSet: snapshot.settings.symbolSet, materialUnit: snapshot.settings.materialUnit } as PatternDocument['settings'];
    }
    entry.bytes = oldSnapshotBytes(entry.before) + oldSnapshotBytes(entry.after);
    const envelope = {
      version: 1 as const,
      document: documentHistory,
      trace: { undo: [], redo: [] },
      undoOrder: [{ kind: 'document' as const, index: 0 }],
      redoOrder: []
    };

    const prepared = await prepareSessionHistory(document, envelope);

    expect(prepared).toBeDefined();
    expect(Object.hasOwn(entry.before.settings, 'backgroundColor')).toBe(false);
    expect(Object.hasOwn(entry.after.settings, 'backgroundColor')).toBe(false);
  });

  it('discards malformed or stale history without blocking the canonical document load', async () => {
    const repo = await repository();
    try {
      const document = createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const history = createEditor(document).exportHistory();
      await repo.save('history-corrupt', metadata(document, 'history-corrupt'), document, undefined, { history });
      const stored = await repo.db.documentHistories.get('history-corrupt');
      if (!stored) throw new Error('missing history record');

      await repo.db.documentHistories.put({ ...stored, checksum: '0'.repeat(64) });
      expect((await repo.load('history-corrupt'))?.document.revision).toBe(document.revision);
      expect((await repo.load('history-corrupt'))?.history).toBeUndefined();
      expect(await repo.db.documentHistories.get('history-corrupt')).toBeUndefined();

      const head = await repo.db.projectHeads.get('history-corrupt');
      if (!head) throw new Error('missing project head');
      await repo.db.documentHistories.put({ ...stored, revision: head.revision, checksum: head.checksum, history: { version: 99, undo: [], redo: [] } as never });
      expect((await repo.load('history-corrupt'))?.document.revision).toBe(document.revision);
      expect(await repo.db.documentHistories.get('history-corrupt')).toBeUndefined();

      const malformed = { ...stored } as Record<string, unknown>;
      delete malformed.generation;
      await repo.db.documentHistories.put(malformed as never);
      expect((await repo.load('history-corrupt'))?.document.revision).toBe(document.revision);
      expect(await repo.db.documentHistories.get('history-corrupt')).toBeUndefined();
    } finally {
      await closeRepository(repo);
    }
  });

  it('keeps canonical saves successful when a history write fails', async () => {
    const repo = await repository();
    try {
      const base = createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const editor = createEditor(base);
      const document = editor.execute({ type: 'set-full', x: 0, y: 0, color: 1 }).document;
      const history = editor.exportHistory();
      const historyPut = vi.spyOn(repo.db.documentHistories, 'put').mockRejectedValueOnce(new Error('quota'));

      await expect(repo.save('history-fallback', metadata(document, 'history-fallback'), document, undefined, { history })).resolves.toMatchObject({ committed: true, stale: false });
      historyPut.mockRestore();
      expect((await repo.load('history-fallback'))?.document.revision).toBe(document.revision);
      expect((await repo.load('history-fallback'))?.history).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
      await closeRepository(repo);
    }
  });

  it('clears history when replacing, promoting recovery, importing, or deleting a project', async () => {
    const repo = await repository();
    try {
      const base = createDocument({ width: 2, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }, { id: 2, name: 'Blue', color: '#36c' }] });
      const editor = createEditor(base);
      const document = editor.execute({ type: 'set-full', x: 0, y: 0, color: 1 }).document;
      await repo.save('history-lifecycle', metadata(document, 'history-lifecycle'), document, undefined, { history: editor.exportHistory() });
      expect(await repo.db.documentHistories.get('history-lifecycle')).toBeDefined();

      const archive = await repo.exportProject('history-lifecycle');
      await repo.importProject(archive, { collision: 'replace' });
      expect(await repo.db.documentHistories.get('history-lifecycle')).toBeUndefined();

      const replacement = applyCommand(document, { type: 'set-full', x: 1, y: 0, color: 1 }).document;
      await repo.save('history-lifecycle', metadata(replacement, 'history-lifecycle'), replacement);
      expect(await repo.db.documentHistories.get('history-lifecycle')).toBeUndefined();

      const replacementEditor = createEditor(replacement);
      const replacementWithHistory = replacementEditor.execute({ type: 'set-full', x: 1, y: 0, color: 2 }).document;
      await repo.save('history-lifecycle', metadata(replacementWithHistory, 'history-lifecycle'), replacementWithHistory, undefined, { history: replacementEditor.exportHistory() });
      expect(await repo.db.documentHistories.get('history-lifecycle')).toBeDefined();
      await repo.promoteRecoveryRevision('history-lifecycle');
      expect(await repo.db.documentHistories.get('history-lifecycle')).toBeUndefined();
      await repo.deleteProject('history-lifecycle');
      expect(await repo.db.documentHistories.get('history-lifecycle')).toBeUndefined();
    } finally {
      await closeRepository(repo);
    }
  });

  it('round-trips a document-only envelope and rejects trace data after fingerprint drift', async () => {
    const repo = await repository();
    try {
      const document = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const fixture = await traceHistoryFixture(document);
      const projectMetadata = { ...metadata(document, 'history-envelope'), sourceImage: fixture.descriptor };
      await repo.save('history-envelope', projectMetadata, document, [{ ...fixture.asset }], { history: fixture.history });
      const loaded = await repo.load('history-envelope');
      expect(loaded?.history?.trace.undo[0]?.label).toBe('import reference');
      const stored = await repo.db.documentHistories.get('history-envelope');
      expect(stored?.generation).toBe(1);
      expect(stored?.traceFingerprint).toBe(await traceStateFingerprint(projectMetadata, loaded?.assets ?? []));

      const disconnected = {
        ...fixture.history,
        trace: {
          undo: [fixture.history.trace.undo[0], { ...fixture.history.trace.undo[0], sourceBefore: { ...fixture.descriptor, opacity: 0.1 } }],
          redo: []
        },
        undoOrder: [{ kind: 'trace' as const, index: 0 }, { kind: 'trace' as const, index: 1 }]
      };
      expect(await prepareSessionHistory(document, disconnected, { metadata: projectMetadata, assets: [fixture.asset] })).toBeUndefined();
      const staleEndpoint = {
        ...fixture.history,
        trace: { undo: [{ ...fixture.history.trace.undo[0], sourceAfter: { ...fixture.descriptor, opacity: 0.1 } }], redo: [] }
      };
      expect(await prepareSessionHistory(document, staleEndpoint, { metadata: projectMetadata, assets: [fixture.asset] })).toBeUndefined();

      if (!stored) throw new Error('missing trace envelope');
      const malformedTrace = {
        ...stored.history,
        trace: {
          ...stored.history.trace,
          undo: [{ ...stored.history.trace.undo[0], assetAfter: { kind: 'captured' as const, asset: { ...fixture.asset, data: new Uint8Array([1]), checksum: '0'.repeat(64) } } }]
        }
      };
      await repo.db.documentHistories.put({ ...stored, history: malformedTrace });
      expect((await repo.load('history-envelope'))?.history).toBeUndefined();
      expect(await repo.db.documentHistories.get('history-envelope')).toBeUndefined();

      await repo.save('history-envelope', projectMetadata, document, [{ ...fixture.asset }], { history: fixture.history });

      const persistedMetadata = await repo.db.projects.get('history-envelope');
      if (!persistedMetadata) throw new Error('missing envelope metadata');
      await repo.db.projects.put({ ...persistedMetadata, sourceImage: { ...fixture.descriptor, opacity: 0.2 } });
      expect((await repo.load('history-envelope'))?.history).toBeUndefined();
      expect(await repo.db.documentHistories.get('history-envelope')).toBeUndefined();
    } finally {
      await closeRepository(repo);
    }
  });

  it('uses the document-only fallback for warm history write failure and advances generation', async () => {
    const repo = await repository();
    try {
      const base = createDocument({ width: 2, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      await repo.save('warm-history-fallback', metadata(base, 'warm-history-fallback'), base);
      await repo.load('warm-history-fallback');
      const editor = createEditor(base);
      const next = editor.execute({ type: 'set-full', x: 0, y: 0, color: 1 }).document;
      const put = vi.spyOn(repo.db.documentHistories, 'put').mockRejectedValueOnce(new Error('history quota'));
      await expect(repo.save('warm-history-fallback', metadata(next, 'warm-history-fallback'), next, undefined, { history: editor.exportHistory() })).resolves.toMatchObject({ committed: true, stale: false, head: { historyGeneration: 2 } });
      put.mockRestore();
      expect(await repo.db.documentHistories.get('warm-history-fallback')).toBeUndefined();
      expect((await repo.load('warm-history-fallback'))?.document.revision).toBe(next.revision);
    } finally {
      vi.restoreAllMocks();
      await closeRepository(repo);
    }
  });

  it('keeps high-Unicode trace fingerprints distinct', async () => {
    const document = createDocument({ width: 1, height: 1, palette: [] });
    const data = new Uint8Array([1, 2, 3]);
    const checksum = await sha256(data);
    const first = [{ id: 'unicode', name: 'é', mimeType: 'application/octet-stream', data, checksum }];
    const second = [{ id: 'unicode', name: String.fromCodePoint(0x100), mimeType: 'application/octet-stream', data, checksum }];
    const firstFingerprint = await traceStateFingerprint(metadata(document, 'unicode'), first);
    const secondFingerprint = await traceStateFingerprint(metadata(document, 'unicode'), second);
    expect(firstFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(secondFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(secondFingerprint).not.toBe(firstFingerprint);
  });

  it('persists descriptor-only and mixed trace asset-state chains', async () => {
    const repo = await repository();
    try {
      const document = createDocument({ width: 2, height: 2, palette: [] });
      const fixture = await traceHistoryFixture(document);
      const movedDescriptor = { ...fixture.descriptor, opacity: 0.4 };
      const descriptorOnly: SessionHistoryEnvelope = {
        version: 1,
        document: createEditor(document).exportHistory(),
        trace: {
          undo: [{ label: 'move reference', sourceBefore: fixture.descriptor, sourceAfter: movedDescriptor, assetBefore: { kind: 'unchanged' }, assetAfter: { kind: 'unchanged' } }],
          redo: []
        },
        undoOrder: [{ kind: 'trace', index: 0 }],
        redoOrder: []
      };
      expect(await prepareSessionHistory(document, descriptorOnly, { metadata: { ...metadata(document, 'descriptor-only-trace'), sourceImage: movedDescriptor }, assets: [fixture.asset] })).toBeDefined();
      const otherAsset = { ...fixture.asset, id: 'other-reference', data: fixture.asset.data.slice() };
      const switchedDescriptor = { ...movedDescriptor, assetId: otherAsset.id };
      const switchedAssetId = {
        ...descriptorOnly,
        trace: {
          ...descriptorOnly.trace,
          undo: [{ ...descriptorOnly.trace.undo[0], sourceAfter: switchedDescriptor }]
        }
      };
      expect(await prepareSessionHistory(document, switchedAssetId, { metadata: { ...metadata(document, 'descriptor-only-trace'), sourceImage: switchedDescriptor }, assets: [fixture.asset, otherAsset] })).toBeUndefined();
      await repo.save('descriptor-only-trace', { ...metadata(document, 'descriptor-only-trace'), sourceImage: movedDescriptor }, document, [{ ...fixture.asset }], { history: descriptorOnly } as never);
      expect((await repo.load('descriptor-only-trace'))?.history?.trace.undo[0]?.assetAfter.kind).toBe('unchanged');

      const removedMetadata = metadata(document, 'mixed-trace');
      const addedDescriptor = fixture.descriptor;
      const movedAgain = { ...addedDescriptor, opacity: 0.5 };
      const mixed: SessionHistoryEnvelope = {
        version: 1,
        document: createEditor(document).exportHistory(),
        trace: {
          undo: [
            { label: 'add reference', sourceBefore: null, sourceAfter: addedDescriptor, assetBefore: { kind: 'absent' }, assetAfter: { kind: 'captured', asset: fixture.asset } },
            { label: 'move reference', sourceBefore: addedDescriptor, sourceAfter: movedAgain, assetBefore: { kind: 'unchanged' }, assetAfter: { kind: 'unchanged' } },
            { label: 'remove reference', sourceBefore: movedAgain, sourceAfter: null, assetBefore: { kind: 'captured', asset: fixture.asset }, assetAfter: { kind: 'absent' } }
          ],
          redo: []
        },
        undoOrder: [{ kind: 'trace', index: 0 }, { kind: 'trace', index: 1 }, { kind: 'trace', index: 2 }],
        redoOrder: []
      };
      await repo.save('mixed-trace', removedMetadata, document, [], { history: mixed } as never);
      expect((await repo.load('mixed-trace'))?.history?.trace.undo).toHaveLength(3);

      const malformed = { ...descriptorOnly, trace: { ...descriptorOnly.trace, undo: [{ ...descriptorOnly.trace.undo[0], assetBefore: { kind: 'mystery' } }] } };
      expect(await prepareSessionHistory(document, malformed)).toBeUndefined();
    } finally {
      await closeRepository(repo);
    }
  });

  it('validates oversized retain and prepared history before cloning and keeps canonical saves usable', async () => {
    const repo = await repository();
    const preparation = new PersistencePreparationWorkerClient({ workerFactory: () => new RepositoryPreparationWorker() });
    try {
      const document = createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      await repo.save('history-invalid-input', metadata(document, 'history-invalid-input'), document);
      const oversized = {
        version: 1,
        undo: [{
          kind: 'delta',
          delta: {
            cells: {
              indices: new Uint8Array(MAX_SESSION_HISTORY_BYTES + 1),
              beforeKind: new Uint8Array(),
              beforeColors: new Uint16Array(),
              beforeCompleted: new Uint8Array(),
              afterKind: new Uint8Array(),
              afterColors: new Uint16Array(),
              afterCompleted: new Uint8Array()
            }
          },
          bytes: 1,
          progress: { cellIndices: new Uint32Array(), backstitchIds: new Uint32Array(), marked: 0, unmarked: 0 },
          recalculateMetrics: false
        }],
        redo: []
      };
      await expect(repo.save('history-invalid-input', metadata(document, 'history-invalid-input'), { revision: document.revision } as PatternDocument, undefined, { mode: 'retain', expectedRevision: document.revision, history: oversized as never })).resolves.toMatchObject({ committed: true, stale: false });
      expect(await repo.db.documentHistories.get('history-invalid-input')).toBeUndefined();

      const prepared = await preparation.prepare({ projectId: 'history-prepared-invalid', revision: document.revision, document, requestId: 'history-prepared-invalid' });
      await expect(repo.savePrepared('history-prepared-invalid', metadata(document, 'history-prepared-invalid'), prepared, undefined, { preparedRequestId: 'history-prepared-invalid', history: { version: 99, undo: [], redo: [] } as never })).resolves.toMatchObject({ committed: true, stale: false });
      expect(await repo.db.documentHistories.get('history-prepared-invalid')).toBeUndefined();
    } finally {
      preparation.dispose();
      await closeRepository(repo);
    }
  });

  it('clears the previous generation after same-head replace and retain history fallbacks', async () => {
    const repo = await repository();
    try {
      const document = createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const editor = createEditor(document);
      const history = editor.exportHistory();
      await repo.save('same-head-history', metadata(document, 'same-head-history'), document, undefined, { history });
      const firstHead = await repo.db.projectHeads.get('same-head-history');
      if (!firstHead) throw new Error('missing same-head history head');

      const replacePut = vi.spyOn(repo.db.documentHistories, 'put').mockRejectedValueOnce(new Error('same-head replace quota'));
      await expect(repo.save('same-head-history', metadata(document, 'same-head-history'), document, undefined, { allowSameRevision: true, history })).resolves.toMatchObject({ committed: true, head: { historyGeneration: 2 } });
      replacePut.mockRestore();
      expect(await repo.db.documentHistories.get('same-head-history')).toBeUndefined();

      const retainPut = vi.spyOn(repo.db.documentHistories, 'put').mockRejectedValueOnce(new Error('same-head retain quota'));
      await expect(repo.save('same-head-history', metadata(document, 'same-head-history'), { revision: document.revision } as PatternDocument, undefined, { mode: 'retain', expectedHead: { ...firstHead, historyGeneration: 2 }, history })).resolves.toMatchObject({ committed: true, head: { historyGeneration: 3 } });
      retainPut.mockRestore();
      expect(await repo.db.documentHistories.get('same-head-history')).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
      await closeRepository(repo);
    }
  });
});

describe('session history lifecycle transaction rollback', () => {
  it('rolls back recovery promotion, archive replacement, and deletion when history cleanup fails', async () => {
    const repo = await repository();
    try {
      const revision0 = createDocument({ width: 2, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const editor0 = createEditor(revision0);
      const revision1 = editor0.execute({ type: 'set-full', x: 0, y: 0, color: 1 }).document;
      await repo.save('rollback-target', metadata(revision0, 'rollback-target'), revision0, undefined, { history: editor0.exportHistory() });
      const editor1 = createEditor(revision1);
      const revision2 = editor1.execute({ type: 'set-full', x: 1, y: 0, color: 1 }).document;
      await repo.save('rollback-target', metadata(revision2, 'rollback-target'), revision2, undefined, { history: editor1.exportHistory() });
      const currentBeforePromotion = await repo.db.currentSnapshots.get('rollback-target');
      const historyBeforePromotion = await repo.db.documentHistories.get('rollback-target');
      const deleteForPromotion = vi.spyOn(repo.db.documentHistories, 'delete').mockRejectedValueOnce(new Error('promotion history cleanup failed'));
      await expect(repo.promoteRecovery('rollback-target')).rejects.toBeInstanceOf(PersistenceError);
      deleteForPromotion.mockRestore();
      expect(await repo.db.currentSnapshots.get('rollback-target')).toEqual(currentBeforePromotion);
      expect(await repo.db.documentHistories.get('rollback-target')).toEqual(historyBeforePromotion);

      const archiveSource = createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Blue', color: '#36c' }] });
      const sourceRepo = await repository();
      let archive: Uint8Array;
      try {
        await sourceRepo.save('rollback-source', metadata(archiveSource, 'rollback-source'), archiveSource);
        archive = await sourceRepo.exportProject('rollback-source');
      } finally {
        await closeRepository(sourceRepo);
      }
      const currentBeforeImport = await repo.db.currentSnapshots.get('rollback-target');
      const deleteForImport = vi.spyOn(repo.db.documentHistories, 'delete').mockRejectedValueOnce(new Error('import history cleanup failed'));
      await expect(repo.importProject(archive, { targetProjectId: 'rollback-target', collision: 'replace' })).rejects.toBeInstanceOf(PersistenceError);
      deleteForImport.mockRestore();
      expect(await repo.db.currentSnapshots.get('rollback-target')).toEqual(currentBeforeImport);
      expect(await repo.db.documentHistories.get('rollback-target')).toEqual(historyBeforePromotion);

      const currentBeforeDelete = await repo.db.currentSnapshots.get('rollback-target');
      const deleteForProject = vi.spyOn(repo.db.documentHistories, 'delete').mockRejectedValueOnce(new Error('project history cleanup failed'));
      await expect(repo.deleteProject('rollback-target')).rejects.toBeDefined();
      deleteForProject.mockRestore();
      expect(await repo.db.currentSnapshots.get('rollback-target')).toEqual(currentBeforeDelete);
      expect(await repo.db.documentHistories.get('rollback-target')).toBeDefined();
    } finally {
      vi.restoreAllMocks();
      await closeRepository(repo);
    }
  });
});

describe('binary document persistence', () => {
  it('validates local PNG, JPEG, and WebP source image signatures and dimensions', () => {
    expect(inspectRasterAsset({ mimeType: 'image/png', data: pngBytes(2, 3) })).toEqual({ mimeType: 'image/png', width: 2, height: 3 });
    expect(inspectRasterAsset({ mimeType: 'image/jpeg', data: jpegBytes(4, 5) })).toEqual({ mimeType: 'image/jpeg', width: 4, height: 5 });
    expect(inspectRasterAsset({ mimeType: 'image/webp', data: webpBytes(6, 7) })).toEqual({ mimeType: 'image/webp', width: 6, height: 7 });
    expect(inspectRasterAsset({ mimeType: 'image/webp', data: webpLosslessBytes(6, 257) })).toEqual({ mimeType: 'image/webp', width: 6, height: 257 });
    // Large source images are accepted up to the shared decode ceiling so a
    // converted pattern can keep the original file as its reference asset.
    expect(inspectRasterAsset({ mimeType: 'image/png', data: pngBytes(8_000, 6_000) })).toEqual({ mimeType: 'image/png', width: 8_000, height: 6_000 });
    expect(() => inspectRasterAsset({ mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) })).toThrow(PersistenceError);
    expect(() => inspectRasterAsset({ mimeType: 'image/png', data: pngBytes(8_193, 1) })).toThrow(PersistenceError);
    expect(() => inspectRasterAsset({ mimeType: 'image/png', data: pngBytes(9_000, 8_000) })).toThrow(PersistenceError);
  });

  it('canonicalizes a WebP asset declared as JPEG and persists matching source metadata', async () => {
    const data = webpBytes(1_057, 1_600);
    const normalizedAsset = await normalizeSourceImageAsset({ id: 'monalisa', name: 'monalisa.jpg', mimeType: 'image/jpeg', data });
    expect(normalizedAsset.mimeType).toBe('image/webp');
    expect(inspectRasterAsset({ mimeType: 'image/jpeg', data })).toEqual({ mimeType: 'image/webp', width: 1_057, height: 1_600 });

    const descriptor = normalizeSourceImageDescriptor({
      assetId: 'monalisa',
      mimeType: 'image/jpeg',
      width: 1_057,
      height: 1_600,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      chartBounds: { x: 0, y: 0, width: 2, height: 2 },
      traceVisible: false,
      opacity: 1
    }, { width: 2, height: 2 }, normalizedAsset);
    expect(descriptor).toMatchObject({ assetId: 'monalisa', mimeType: 'image/webp', width: 1_057, height: 1_600, traceVisible: false });

    const repo = await repository();
    try {
      const document = createDocument({ width: 2, height: 2, palette: [] });
      await repo.save('mislabeled-webp', { ...metadata(document, 'mislabeled-webp'), sourceImage: descriptor }, document, [normalizedAsset]);
      const loaded = await repo.load('mislabeled-webp');
      expect(loaded?.metadata.sourceImage).toMatchObject({ mimeType: 'image/webp', width: 1_057, height: 1_600 });
      expect(loaded?.assets[0]).toMatchObject({ id: 'monalisa', mimeType: 'image/webp' });
      expect(loaded?.health?.sourceImage).toMatchObject({ assetId: 'monalisa', status: 'valid' });
    } finally {
      await closeRepository(repo);
    }
  });

  it('round-trips a large source image reference within the shared decode ceiling', async () => {
    const data = pngBytes(8_000, 6_000);
    const repo = await repository();
    try {
      const document = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const sourceImage = {
        assetId: 'reference', mimeType: 'image/png' as const, width: 8_000, height: 6_000,
        crop: { x: 0, y: 0, width: 1, height: 1 }, chartBounds: { x: 0, y: 0, width: 2, height: 2 }, traceVisible: true, opacity: 1
      };
      await repo.save('large-source', { ...metadata(document, 'large-source'), sourceImage }, document, [{ id: 'reference', name: 'reference.png', mimeType: 'image/png', data }]);
      const loaded = await repo.load('large-source');
      expect(loaded?.metadata.sourceImage).toEqual(sourceImage);
      expect(loaded?.health?.sourceImage).toMatchObject({ assetId: 'reference', status: 'valid' });
      expect(loaded?.assets[0].data).toEqual(data);
    } finally {
      await closeRepository(repo);
    }
  });

  it('uses EXIF-adjusted JPEG dimensions and retains the orientation-bearing bytes', async () => {
    const data = jpegBytesWithExifOrientation(4, 3, 6);
    expect(inspectRasterAsset({ mimeType: 'image/jpeg', data })).toEqual({ mimeType: 'image/jpeg', width: 3, height: 4, orientation: 6 });
    expect(inspectRasterAsset({ mimeType: 'image/jpeg', data: jpegBytesWithExifOrientation(4, 3, 8) })).toMatchObject({ width: 3, height: 4, orientation: 8 });

    const repo = await repository();
    try {
      const document = createDocument({ width: 3, height: 4, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const sourceImage = {
        assetId: 'reference', mimeType: 'image/jpeg' as const, width: 3, height: 4, orientation: 6 as const,
        crop: { x: 0, y: 0, width: 1, height: 1 }, chartBounds: { x: 0, y: 0, width: 3, height: 4 }, traceVisible: true, opacity: 1
      };
      await repo.save('jpeg-orientation', { ...metadata(document, 'jpeg-orientation'), sourceImage }, document, [{ id: 'reference', name: 'reference.jpg', mimeType: 'image/jpeg', data }]);
      const loaded = await repo.load('jpeg-orientation');
      expect(loaded?.metadata.sourceImage).toEqual(sourceImage);
      expect(loaded?.health?.sourceImage).toMatchObject({ assetId: 'reference', status: 'valid' });
      expect(loaded?.assets[0].data).toEqual(data);
      const parsed = await parseArchive(await repo.exportProject('jpeg-orientation'));
      expect(parsed.metadata.sourceImage).toEqual(sourceImage);
      expect(parsed.assets[0].data).toEqual(data);
    } finally {
      await closeRepository(repo);
    }
  });

  it('round-trips typed arrays without JSON array encoding', () => {
    const original = makeDocument();
    const bytes = encodeDocument(original);
    const decoded = decodeDocument(bytes);

    expect(decoded.kind).toBeInstanceOf(Uint8Array);
    expect(decoded.colors).toBeInstanceOf(Uint16Array);
    expect(decoded.completed).toBeInstanceOf(Uint8Array);
    expect(decoded.kind).toEqual(original.kind);
    expect(decoded.colors).toEqual(original.colors);
    expect(decoded.completed).toEqual(original.completed);
    expect(decoded.backstitches.ids).toEqual(original.backstitches.ids);
    expect(decoded.backstitches.x1).toEqual(original.backstitches.x1);
    expect(decoded.backstitches.colors).toEqual(original.backstitches.colors);
    expect(decoded.revision).toBe(original.revision);
    expect(decoded.catalog).toEqual(original.catalog);
  });

  it('round-trips canonical background color using binary schema v2', () => {
    const original = createDocument({
      width: 1,
      height: 1,
      settings: { backgroundColor: '#a1b2c3' }
    });
    const bytes = encodeDocument(original);
    const decoded = decodeDocument(bytes);

    expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(8, true)).toBe(2);
    expect(decoded.settings.backgroundColor).toBe('#A1B2C3');
    expect(decoded.settings).toEqual(original.settings);
  });

  it('upgrades legacy binary schema v1 documents with the neutral Aida background', () => {
    const decoded = decodeDocument(legacyV1Snapshot());

    expect(decoded.settings).toEqual({ symbolSet: 'default', materialUnit: 'skeins', backgroundColor: '#F3EEE5' });
    expect(decoded.width).toBe(1);
    expect(decoded.height).toBe(1);
    expect(decoded.kind).toEqual(new Uint8Array([0]));
  });

  it('round-trips directional three-quarter kinds as compact single-slot cells', () => {
    let original = createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    original = applyCommand(original, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.SW, color: 1 }).document;
    original = applyCommand(original, { type: 'set-completion', x: 0, y: 0, completed: true }).document;
    const decoded = decodeDocument(encodeDocument(original));

    expect(decoded.kind[0]).toBe(CellKind.ThreeQuarterSW);
    expect(decoded.colors).toEqual(new Uint16Array([1, 0, 0, 0]));
    expect(decoded.completed[0]).toBe(1);
    expect(decoded.version).toBe(1);
    expect(encodeDocument(decoded)).toEqual(encodeDocument(original));
  });

  it('round-trips paired three-quarter kinds with physical colors and completion bits', () => {
    let original = createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }, { id: 2, name: 'Blue', color: '#36c' }] });
    original = applyCommand(original, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.NW, color: 1 }).document;
    original = applyCommand(original, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.SE, color: 2 }).document;
    original = applyCommand(original, { type: 'set-completion', x: 0, y: 0, corner: QuarterCorner.NW, completed: true }).document;
    original = applyCommand(original, { type: 'set-completion', x: 0, y: 0, corner: QuarterCorner.SE, completed: true }).document;
    const decoded = decodeDocument(encodeDocument(original));

    expect(decoded.kind[0]).toBe(CellKind.ThreeQuarterPair);
    expect(decoded.colors).toEqual(new Uint16Array([1, 0, 2, 0]));
    expect(decoded.completed[0]).toBe(5);
    expect(decoded.version).toBe(1);
    expect(encodeDocument(decoded)).toEqual(encodeDocument(original));
  });

  it('rejects incompatible binary discriminators and versions before loading counts', () => {
    const original = encodeDocument(createDocument({ width: 1, height: 1, palette: [] }));
    const oldMagic = new Uint8Array([0x53, 0x54, 0x59, 0x44, 0x4f, 0x43, 0x01, 0x00]);
    const oldPayload = original.slice();
    oldPayload.set(oldMagic, 0);
    expect(() => decodeDocument(oldPayload)).toThrow(/magic is invalid/i);

    const wrongMagic = original.slice();
    wrongMagic[0] ^= 0xff;
    expect(() => decodeDocument(wrongMagic)).toThrow(/magic is invalid/i);

    const wrongVersion = original.slice();
    const wrongVersionView = new DataView(wrongVersion.buffer);
    wrongVersionView.setUint16(8, 3, true);
    wrongVersionView.setUint32(32, 0xffffffff, true);
    expect(() => decodeDocument(wrongVersion)).toThrow(/schema is unsupported/i);
  });

  it('round-trips the exact catalog association through the clean binary format', () => {
    const original = createDocument({ width: 2, height: 3, palette: [] });
    expect(decodeDocument(encodeDocument(original)).catalog).toEqual(TEST_CATALOG);
  });

  it('matches the domain one-million-cell persistence boundary', () => {
    const boundary = createDocument({ width: 1_000, height: 1_000 });
    expect(boundary.kind.length).toBe(MAX_DOCUMENT_CELLS);
    const bytes = encodeDocument(boundary);
    const decoded = decodeDocument(bytes);
    expect(decoded.width * decoded.height).toBe(MAX_DOCUMENT_CELLS);

    const overBoundary = { ...boundary, width: MAX_DOCUMENT_CELLS + 1, height: 1 };
    expect(() => encodeDocument(overBoundary)).toThrow(PersistenceError);
    const malformed = bytes.slice();
    new DataView(malformed.buffer).setUint32(12, MAX_DOCUMENT_CELLS + 1, true);
    expect(() => decodeDocument(malformed)).toThrow(PersistenceError);
  });

  it('round-trips v2 palette metadata and document settings', () => {
    const original = createDocument({
      width: 1,
      height: 1,
      settings: { symbolSet: 'letters', materialUnit: 'meters' },
      palette: [{
        id: 1,
        name: 'Black',
        color: '#000',
        symbol: '✚',
        material: { kind: 'floss', label: 'Cotton', unit: 'meters', amount: 2.5 },
        catalog: { catalogId: TEST_CATALOG.catalogId, sourceId: 'test-black', code: '310', name: 'Black', hex: '#000000', rgb: [0, 0, 0] }
      }]
    });
    const decoded = decodeDocument(encodeDocument(original));
    expect(decoded.version).toBe(1);
    expect(decoded.settings).toEqual({ symbolSet: 'letters', materialUnit: 'meters', backgroundColor: '#F3EEE5' });
    expect(decoded.palette[0]).toEqual(original.palette[0]);
  });

  it('preserves mixed-catalog and custom palette entries through binary, archive, repository, and history round trips', async () => {
    const dmcRecord = DMC_CATALOG_DEFINITION.records[0]!;
    const dmcReference = {
      catalogId: DMC_CATALOG_DEFINITION.association.catalogId,
      sourceId: dmcRecord.sourceId,
      code: dmcRecord.code,
      name: dmcRecord.name,
      hex: dmcRecord.hex,
      rgb: [...dmcRecord.rgb] as [number, number, number]
    };
    const brandBReference = {
      catalogId: 'brand-b-v1',
      sourceId: 'brand-b-blue-17',
      code: 'B17',
      name: 'Brand B Blue',
      hex: '#336699',
      rgb: [51, 102, 153] as [number, number, number]
    };
    const original = createDocument({
      width: 1,
      height: 1,
      catalog: DMC_CATALOG_DEFINITION.association,
      palette: [
        { id: 1, name: dmcRecord.name, color: dmcRecord.hex, catalog: dmcReference },
        { id: 2, name: 'Brand B Blue', color: '#336699', catalog: brandBReference },
        { id: 3, name: 'Custom Violet', color: '#AABBCC' }
      ]
    });

    const decoded = decodeDocument(encodeDocument(original));
    expect(decoded.catalog).toEqual(DMC_CATALOG_DEFINITION.association);
    expect(decoded.catalog.catalogId).not.toBe(brandBReference.catalogId);
    expect(decoded.palette).toEqual(original.palette);
    expect(decoded.palette[1].catalog).toEqual(brandBReference);
    expect(decoded.palette[2].catalog).toBeUndefined();

    const archive = await exportArchive({ metadata: metadata(original, 'mixed-catalog'), document: original, assets: [] });
    const parsed = await parseArchive(archive);
    expect(parsed.document.catalog).toEqual(DMC_CATALOG_DEFINITION.association);
    expect(parsed.document.catalog.catalogId).not.toBe(brandBReference.catalogId);
    expect(parsed.document.palette).toEqual(original.palette);

    const repo = await repository();
    try {
      const editor = createEditor(original);
      const brandBAddition = {
        catalogId: brandBReference.catalogId,
        sourceId: 'brand-b-green-29',
        code: 'B29',
        name: 'Brand B Green',
        hex: '#228844',
        rgb: [34, 136, 68] as [number, number, number]
      };
      const savedDocument = editor.execute({
        type: 'palette-create',
        name: brandBAddition.name,
        color: brandBAddition.hex,
        catalog: brandBAddition
      }).document;
      await repo.save('mixed-catalog-history', metadata(savedDocument, 'mixed-catalog-history'), savedDocument, undefined, { history: editor.exportHistory() });

      const loaded = await repo.load('mixed-catalog-history');
      expect(loaded?.document.catalog).toEqual(DMC_CATALOG_DEFINITION.association);
      expect(loaded?.document.catalog.catalogId).not.toBe(brandBReference.catalogId);
      expect(loaded?.document.palette).toEqual(savedDocument.palette);
      expect(loaded?.document.palette.find((entry) => entry.catalog?.catalogId === brandBReference.catalogId)?.catalog).toEqual(brandBReference);
      expect(loaded?.document.palette.find((entry) => entry.catalog?.catalogId === brandBReference.catalogId && entry.catalog.sourceId === brandBAddition.sourceId)?.catalog).toEqual(brandBAddition);
      expect(loaded?.document.palette.find((entry) => entry.id === 3)?.catalog).toBeUndefined();

      expect(loaded?.history).toBeDefined();
      if (!loaded?.history) throw new Error('Missing persisted document history.');
      const restoredEditor = createEditor(loaded.document);
      restoredEditor.importHistory(loaded.history.document);
      expect(restoredEditor.undo().document.palette).toEqual(original.palette);
      expect(restoredEditor.redo().document.palette).toEqual(savedDocument.palette);
      expect(restoredEditor.document.catalog).toEqual(DMC_CATALOG_DEFINITION.association);
    } finally {
      await closeRepository(repo);
    }
  });

  it('round-trips calibrated material assumptions in project metadata', async () => {
    const document = createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    const projectMetadata: ProjectMetadata = {
      id: 'material',
      title: 'Material',
      notes: '',
      createdAt: 1,
      updatedAt: 1,
      revision: document.revision,
      materialSettings: { strands: 2, waste: 0.15, stitchLengthMeters: 0.12, skeinLengthMeters: 8 }
    };
    const archive = await exportArchive({ metadata: projectMetadata, document, assets: [] });
    const parsed = await parseArchive(archive);
    expect(parsed.metadata.materialSettings).toEqual(projectMetadata.materialSettings);
  });

  it('keeps canonical waste fractions unchanged through repository and archive persistence', async () => {
    const repo = await repository();
    try {
      let document = createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      document = applyCommand(document, { type: 'set-full', x: 0, y: 0, color: 1 }).document;
      const settings = { strands: 1, waste: 1.25, stitchLengthMeters: 0.1 };
      await repo.save('canonical-waste', { ...metadata(document, 'canonical-waste'), materialSettings: settings }, document);

      const loaded = await repo.load('canonical-waste');
      expect(loaded?.metadata.materialSettings).toEqual(settings);
      const loadedEstimate = computePatternMetrics(document, loaded?.metadata.materialSettings);
      const archive = await repo.exportProject('canonical-waste');
      const parsed = await parseArchive(archive);
      expect(parsed.metadata.materialSettings).toEqual(settings);
      expect(computePatternMetrics(document, parsed.metadata.materialSettings)).toEqual(loadedEstimate);
    } finally {
      await closeRepository(repo);
    }
  });

  it('round-trips the optional Aida count without adding it to the binary document', async () => {
    const document = createDocument({ width: 2, height: 3, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    const projectMetadata: ProjectMetadata = { ...metadata(document, 'aida-metadata'), aidaCount: 18 };
    const binary = encodeDocument(document);
    const archive = await exportArchive({ metadata: projectMetadata, document, assets: [] });
    const parsed = await parseArchive(archive);
    expect(parsed.metadata.aidaCount).toBe(18);
    expect(encodeDocument(parsed.document)).toEqual(binary);
    expect(() => encodeDocument(document)).not.toThrow();
    await expect((async () => {
      const repo = await repository();
      try {
        await repo.save('invalid-aida', { ...metadata(document, 'invalid-aida'), aidaCount: Infinity }, document);
      } finally {
        await closeRepository(repo);
      }
    })()).rejects.toMatchObject({ code: 'invalid-metadata' });
  });

  it('round-trips the optional display units without adding them to the binary document', async () => {
    const document = createDocument({ width: 2, height: 3, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    const projectMetadata: ProjectMetadata = { ...metadata(document, 'units-metadata'), units: 'imperial' };
    const binary = encodeDocument(document);
    const archive = await exportArchive({ metadata: projectMetadata, document, assets: [] });
    const parsed = await parseArchive(archive);
    expect(parsed.metadata.units).toBe('imperial');
    expect(encodeDocument(parsed.document)).toEqual(binary);
    // Absent units stay absent through the archive boundary (metric by default).
    const plain = await parseArchive(await exportArchive({ metadata: metadata(document, 'units-default'), document, assets: [] }));
    expect(plain.metadata.units).toBeUndefined();
    // Invalid units are rejected at both persistence boundaries.
    await expect((async () => {
      const repo = await repository();
      try {
        await repo.save('invalid-units', { ...metadata(document, 'invalid-units'), units: 'furlongs' as never }, document);
      } finally {
        await closeRepository(repo);
      }
    })()).rejects.toMatchObject({ code: 'invalid-metadata' });
    await expect(exportArchive({ metadata: { ...metadata(document, 'invalid-units-archive'), units: 'furlongs' as never }, document, assets: [] })).rejects.toMatchObject({ code: 'invalid-metadata' });
  });

  it('accepts and round-trips unbounded negative and overflowing source image chart bounds', async () => {
    const document = createDocument({ width: 4, height: 3, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    const sourceImage = {
      assetId: 'reference',
      mimeType: 'image/png' as const,
      width: 2,
      height: 3,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      chartBounds: { x: -3, y: -2, width: 6, height: 5 },
      traceVisible: true,
      opacity: 1
    };
    const data = pngBytes(2, 3);
    const repo = await repository();
    try {
      await repo.save('unbounded-source', { ...metadata(document, 'unbounded-source'), sourceImage }, document, [{ id: 'reference', name: 'reference.png', mimeType: 'image/png', data }]);
      const loaded = await repo.load('unbounded-source');
      expect(loaded?.metadata.sourceImage?.chartBounds).toEqual({ x: -3, y: -2, width: 6, height: 5 });
      expect(loaded?.health?.sourceImage).toMatchObject({ assetId: 'reference', status: 'valid' });
      const parsed = await parseArchive(await repo.exportProject('unbounded-source'));
      expect(parsed.metadata.sourceImage?.chartBounds).toEqual({ x: -3, y: -2, width: 6, height: 5 });
    } finally {
      await closeRepository(repo);
    }
  });

  it('round-trips source image metadata without placing it in the binary document', async () => {
    const document = createDocument({ width: 4, height: 3, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    const sourceImage = {
      assetId: 'reference',
      mimeType: 'image/png' as const,
      width: 2,
      height: 3,
      crop: { x: 0.1, y: 0, width: 0.9, height: 1 },
      chartBounds: { x: 0, y: 0, width: 4, height: 3 },
      traceVisible: true,
      opacity: 0.65
    };
    const data = pngBytes(2, 3);
    const archive = await exportArchive({
      metadata: { ...metadata(document, 'source-image'), sourceImage },
      document,
      assets: [{ id: 'reference', name: 'reference.png', mimeType: 'image/png', data, checksum: await sha256(data) }]
    });
    const parsed = await parseArchive(archive);
    expect(parsed.metadata.sourceImage).toEqual(sourceImage);
    expect(parsed.document).not.toHaveProperty('sourceImage');
    expect(parsed.assets[0].id).toBe('reference');

    const files = unzipSync(archive);
    files['assets/reference'][0] ^= 0xff;
    const degraded = await parseArchive(zipSync(files));
    expect(degraded.document.width).toBe(4);
    expect(degraded.assets).toHaveLength(0);
    expect(degraded.warnings?.join(' ')).toContain('ignored');
  });

  it('omits corrupt optional source image data and metadata during export without changing the pattern', async () => {
    const document = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    const sourceImage = {
      assetId: 'reference', mimeType: 'image/png' as const, width: 2, height: 3,
      crop: { x: 0, y: 0, width: 1, height: 1 }, chartBounds: { x: 0, y: 0, width: 2, height: 2 }, traceVisible: true, opacity: 1
    };
    const data = pngBytes(2, 3);
    const checksum = await sha256(data);
    data[0] ^= 0xff;
    const warnings: string[] = [];
    const archive = await exportArchive({
      metadata: { ...metadata(document, 'corrupt-export'), sourceImage },
      document,
      assets: [{ id: 'reference', name: 'reference.png', mimeType: 'image/png', data, checksum }]
    }, { onWarning: (warning) => warnings.push(warning) });
    expect(warnings.join(' ')).toContain('omitted');
    expect(document.width).toBe(2);
    const imported = await parseArchive(archive);
    expect(imported.document.width).toBe(2);
    expect(imported.metadata.sourceImage).toBeUndefined();
    expect(imported.assets).toHaveLength(0);

    const descriptorWarnings: string[] = [];
    const descriptorArchive = await exportArchive({
      metadata: { ...metadata(document, 'corrupt-descriptor'), sourceImage: { ...sourceImage, opacity: 2 } as SourceImageDescriptor },
      document,
      assets: []
    }, { onWarning: (warning) => descriptorWarnings.push(warning) });
    expect(descriptorWarnings.join(' ')).toContain('settings');
    expect((await parseArchive(descriptorArchive)).metadata.sourceImage).toBeUndefined();
  });

});

describe('local project repository', () => {
  it('keeps valid pattern loads usable when an optional source image is missing or corrupt', async () => {
    const repo = await repository();
    try {
      const document = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const sourceImage = {
        assetId: 'reference',
        mimeType: 'image/png' as const,
        width: 2,
        height: 2,
        crop: { x: 0, y: 0, width: 1, height: 1 },
        chartBounds: { x: 0, y: 0, width: 2, height: 2 },
        traceVisible: true,
        opacity: 1
      };
      await repo.save('missing-source', { ...metadata(document, 'missing-source'), sourceImage }, document);
      const missing = await repo.load('missing-source');
      expect(missing?.document.width).toBe(2);
      expect(missing?.health?.sourceImage).toMatchObject({ assetId: 'reference', status: 'missing' });
      expect(missing?.health?.warnings.join(' ')).toContain('the reference image is unavailable');

      await repo.save('corrupt-source', { ...metadata(document, 'corrupt-source'), sourceImage }, document, [{ id: 'reference', name: 'reference.png', mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) }]);
      const corrupt = await repo.load('corrupt-source');
      expect(corrupt?.document.width).toBe(2);
      expect(corrupt?.health?.sourceImage).toMatchObject({ assetId: 'reference', status: 'corrupt' });
      expect(await repo.getAsset('corrupt-source', 'reference')).toBeDefined();
      const exported = await repo.exportProject('corrupt-source');
      expect(repo.exportWarnings.join(' ')).toContain('omitted');
      const reimported = await repo.importProject(exported, { targetProjectId: 'corrupt-source-copy' });
      expect(reimported.document.width).toBe(2);
      expect(reimported.metadata.sourceImage).toBeUndefined();
    } finally {
      await closeRepository(repo);
    }
  });

  it('persists material assumptions independently of the document revision', async () => {
    const repo = await repository();
    try {
      const document = createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const settings = { strands: 2, waste: 0.2, stitchLengthMeters: 0.11, skeinLengthMeters: 8 };
      await repo.save('material-settings', { ...metadata(document, 'material-settings'), materialSettings: settings }, document);
      const loaded = await repo.load('material-settings');
      expect(loaded?.metadata.materialSettings).toEqual(settings);
    } finally {
      await closeRepository(repo);
    }
  });

  it('retains both document snapshots while atomically mutating metadata, assets, and activity', async () => {
    const repo = await repository();
    try {
      const revision0 = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const revision1 = applyCommand(revision0, { type: 'set-full', x: 0, y: 0, color: 1 }).document;
      await repo.save('retain', metadata(revision0, 'retain'), revision0, [{ id: 'old', name: 'old.bin', mimeType: 'application/octet-stream', data: new Uint8Array([1]) }], {
        activity: { daily: [{ date: '2026-08-30', marked: 1, unmarked: 0 }] }
      });
      await repo.save('retain', metadata(revision1, 'retain'), revision1);

      const currentBefore = await repo.db.currentSnapshots.get('retain');
      const recoveryBefore = await repo.db.recoverySnapshots.get('retain');
      if (!currentBefore || !recoveryBefore) throw new Error('missing retain snapshots');

      const retainedMetadata = { ...metadata(revision1, 'retain'), title: 'Retained metadata', updatedAt: 20 };
      const result = await repo.save(
        'retain',
        retainedMetadata,
        { revision: revision1.revision } as PatternDocument,
        [{ id: 'new', name: 'new.bin', mimeType: 'application/octet-stream', data: new Uint8Array([2, 3]) }],
        {
          mode: 'retain',
          expectedHead: { revision: revision1.revision, checksum: currentBefore.checksum },
          activity: { daily: [{ date: '2026-08-31', marked: 4, unmarked: 2 }] }
        }
      );

      expect(result).toMatchObject({ committed: true, stale: false, revision: revision1.revision, head: { projectId: 'retain', revision: revision1.revision, checksum: currentBefore.checksum } });
      expect(await repo.db.currentSnapshots.get('retain')).toEqual(currentBefore);
      expect(await repo.db.recoverySnapshots.get('retain')).toEqual(recoveryBefore);
      const loaded = await repo.load('retain');
      expect(loaded?.metadata.title).toBe('Retained metadata');
      expect(loaded?.assets.map((asset) => asset.id)).toEqual(['new']);
      expect(loaded?.activity).toEqual({ daily: [{ date: '2026-08-31', marked: 4, unmarked: 2 }] });
    } finally {
      await closeRepository(repo);
    }
  });

  it('uses only the compact head record for a normal retain commit', async () => {
    const repo = await repository();
    try {
      const document = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      await repo.save('retain-head', metadata(document, 'retain-head'), document);
      const head = await repo.db.projectHeads.get('retain-head');
      if (!head) throw new Error('missing compact project head');
      const currentRead = vi.spyOn(repo.db.currentSnapshots, 'get');

      const result = await repo.save(
        'retain-head',
        { ...metadata(document, 'retain-head'), title: 'Head-only retain' },
        { revision: document.revision } as PatternDocument,
        undefined,
        { mode: 'retain', expectedHead: head }
      );

      expect(result).toMatchObject({ committed: true, stale: false, head });
      expect(currentRead).not.toHaveBeenCalled();
      currentRead.mockRestore();
    } finally {
      await closeRepository(repo);
    }
  });

  it('keeps retain summaries complete and never combines partial fields', async () => {
    const repo = await repository();
    try {
      const document = createDocument({ width: 3, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const summary = deriveProjectSummary(document);
      await repo.save('retain-summary', metadata(document, 'retain-summary'), document);
      const head = await repo.db.projectHeads.get('retain-summary');
      const stored = await repo.db.projects.get('retain-summary');
      if (!head || !stored) throw new Error('missing retain summary state');

      // A complete stored summary wins over a conflicting incoming cache.
      await repo.save(
        'retain-summary',
        { ...metadata(document, 'retain-summary'), ...summary, width: 999, height: 999 },
        { revision: document.revision } as PatternDocument,
        undefined,
        { mode: 'retain', expectedHead: head }
      );
      expect(await repo.db.projects.get('retain-summary')).toMatchObject(summary);

      // A legacy record with only one summary field is repaired from a
      // complete incoming summary, as one atomic unit.
      const partial = { ...stored, width: 999 };
      delete partial.height;
      delete partial.thumbnail;
      await repo.db.projects.put(partial);
      await repo.save(
        'retain-summary',
        { ...metadata(document, 'retain-summary'), ...summary },
        { revision: document.revision } as PatternDocument,
        undefined,
        { mode: 'retain', expectedHead: head }
      );
      expect(await repo.db.projects.get('retain-summary')).toMatchObject(summary);

      // If neither side has a complete valid summary, no summary fields are
      // retained, rather than preserving a misleading partial cache.
      const malformed = await repo.db.projects.get('retain-summary');
      if (!malformed) throw new Error('missing repaired metadata');
      malformed.width = summary.width;
      malformed.thumbnail = { ...summary.thumbnail, revision: summary.thumbnail.revision + 1 };
      delete malformed.height;
      await repo.db.projects.put(malformed);
      await repo.save(
        'retain-summary',
        metadata(document, 'retain-summary'),
        { revision: document.revision } as PatternDocument,
        undefined,
        { mode: 'retain', expectedHead: head }
      );
      const withoutSummary = await repo.db.projects.get('retain-summary');
      expect(withoutSummary).not.toHaveProperty('width');
      expect(withoutSummary).not.toHaveProperty('height');
      expect(withoutSummary).not.toHaveProperty('thumbnail');
      expect((await repo.load('retain-summary'))?.metadata).toMatchObject(summary);
      expect(await repo.db.projects.get('retain-summary')).toMatchObject(summary);
    } finally {
      await closeRepository(repo);
    }
  });

  it('rejects an explicit retain when the compact head checksum is stale', async () => {
    const repo = await repository();
    try {
      const document = createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      await repo.save('retain-checksum', metadata(document, 'retain-checksum'), document);
      const head = await repo.db.projectHeads.get('retain-checksum');
      if (!head) throw new Error('missing compact project head');
      const currentBefore = await repo.db.currentSnapshots.get('retain-checksum');
      const result = await repo.save(
        'retain-checksum',
        { ...metadata(document, 'retain-checksum'), title: 'Rejected' },
        { revision: document.revision } as PatternDocument,
        undefined,
        { mode: 'retain', expectedHead: { ...head, checksum: '0'.repeat(64) } }
      );

      expect(result).toMatchObject({ committed: false, stale: true, revision: document.revision });
      expect(await repo.db.projectHeads.get('retain-checksum')).toEqual(head);
      expect(await repo.db.currentSnapshots.get('retain-checksum')).toEqual(currentBefore);
      expect((await repo.load('retain-checksum'))?.metadata.title).toBe('Test project');
    } finally {
      await closeRepository(repo);
    }
  });

  it('backfills a missing legacy project head through the one-time snapshot fallback', async () => {
    const repo = await repository();
    try {
      const document = createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      await repo.save('retain-backfill', metadata(document, 'retain-backfill'), document);
      const head = await repo.db.projectHeads.get('retain-backfill');
      if (!head) throw new Error('missing compact project head');
      await repo.db.projectHeads.delete('retain-backfill');
      const currentRead = vi.spyOn(repo.db.currentSnapshots, 'get');

      await expect(repo.save(
        'retain-backfill',
        { ...metadata(document, 'retain-backfill'), title: 'Backfilled' },
        { revision: document.revision } as PatternDocument,
        undefined,
        { mode: 'retain', expectedHead: head }
      )).resolves.toMatchObject({ committed: true, head });

      expect(currentRead).toHaveBeenCalledTimes(1);
      expect(await repo.db.projectHeads.get('retain-backfill')).toEqual(head);
      currentRead.mockRestore();
    } finally {
      await closeRepository(repo);
    }
  });

  it('rejects a retain commit whose expected revision or head is stale', async () => {
    const repo = await repository();
    try {
      const revision0 = createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const revision1 = applyCommand(revision0, { type: 'set-full', x: 0, y: 0, color: 1 }).document;
      await repo.save('retain-stale', metadata(revision0, 'retain-stale'), revision0);
      await repo.save('retain-stale', metadata(revision1, 'retain-stale'), revision1);

      const staleRevision = await repo.save(
        'retain-stale',
        { ...metadata(revision0, 'retain-stale'), title: 'Stale revision' },
        { revision: revision0.revision } as PatternDocument,
        undefined,
        { mode: 'retain', expectedRevision: revision0.revision }
      );
      expect(staleRevision).toEqual({ committed: false, stale: true, revision: revision1.revision });
      expect((await repo.load('retain-stale'))?.metadata.title).toBe('Test project');

      const current = await repo.db.currentSnapshots.get('retain-stale');
      if (!current) throw new Error('missing current retain snapshot');
      const staleHead = await repo.save(
        'retain-stale',
        { ...metadata(revision1, 'retain-stale'), title: 'Stale head' },
        { revision: revision1.revision } as PatternDocument,
        undefined,
        { mode: 'retain', expectedHead: { revision: revision1.revision, checksum: '0'.repeat(64) } }
      );
      expect(staleHead).toEqual({ committed: false, stale: true, revision: current.revision });
      expect((await repo.load('retain-stale'))?.metadata.title).toBe('Test project');
    } finally {
      await closeRepository(repo);
    }
  });

  it('deletes the project record together with its assets and snapshots', async () => {
    const repo = await repository();
    try {
      const document = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const sourceImage = {
        assetId: 'reference',
        mimeType: 'image/png' as const,
        width: 2,
        height: 2,
        crop: { x: 0, y: 0, width: 1, height: 1 },
        chartBounds: { x: 0, y: 0, width: 2, height: 2 },
        traceVisible: true,
        opacity: 1
      };
      await repo.save('to-delete', { ...metadata(document, 'to-delete'), sourceImage }, document, [{ id: 'reference', name: 'reference.png', mimeType: 'image/png', data: new Uint8Array([1, 2, 3, 4]) }]);
      expect(await repo.db.projectHeads.get('to-delete')).toMatchObject({ projectId: 'to-delete', revision: document.revision });
      expect(await repo.load('to-delete')).toBeDefined();
      expect(await repo.getAsset('to-delete', 'reference')).toBeDefined();
      await repo.deleteProject('to-delete');
      expect(await repo.db.projectHeads.get('to-delete')).toBeUndefined();
      expect(await repo.load('to-delete')).toBeUndefined();
      expect(await repo.getAsset('to-delete', 'reference')).toBeUndefined();
      // Deleting a missing id is a safe no-op.
      await expect(repo.deleteProject('to-delete')).resolves.toBeUndefined();
      await expect(repo.deleteProject('never-existed')).resolves.toBeUndefined();
    } finally {
      await closeRepository(repo);
    }
  });

  it('retains the immediately previous valid recovery revision', async () => {
    const repo = await repository();
    try {
      const revision0 = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      await repo.save('project-1', metadata(revision0), revision0);
      expect((await repo.load('project-1'))?.recovery).toBeNull();

      const revision1 = applyCommand(revision0, { type: 'set-full', x: 0, y: 0, color: 1 }).document;
      await repo.save('project-1', metadata(revision1), revision1);
      expect((await repo.load('project-1'))?.recovery?.revision).toBe(revision0.revision);
      expect(await repo.db.projectHeads.get('project-1')).toMatchObject({ projectId: 'project-1', revision: revision1.revision, checksum: (await repo.db.currentSnapshots.get('project-1'))?.checksum });

      const revision2 = applyCommand(revision1, { type: 'set-full', x: 1, y: 1, color: 1 }).document;
      await repo.save('project-1', metadata(revision2), revision2);
      const loaded = await repo.load('project-1');
      expect(loaded?.document.revision).toBe(revision2.revision);
      expect(loaded?.recovery?.revision).toBe(revision1.revision);
      expect(await repo.db.projectHeads.get('project-1')).toMatchObject({ projectId: 'project-1', revision: revision2.revision, checksum: (await repo.db.currentSnapshots.get('project-1'))?.checksum });
    } finally {
      await closeRepository(repo);
    }
  });

  it('serializes saves and rejects an older revision after a newer one commits', async () => {
    const repo = await repository();
    try {
      const revision0 = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const revision1 = applyCommand(revision0, { type: 'set-full', x: 0, y: 0, color: 1 }).document;
      const revision2 = applyCommand(revision1, { type: 'set-full', x: 1, y: 1, color: 1 }).document;
      const newest = repo.save('project-1', metadata(revision2), revision2);
      const stale = repo.save('project-1', metadata(revision1), revision1);
      expect(await newest).toMatchObject({ committed: true, stale: false, revision: revision2.revision });
      expect(await stale).toMatchObject({ committed: false, stale: true, revision: revision2.revision });
      expect((await repo.load('project-1'))?.document.revision).toBe(revision2.revision);
    } finally {
      await closeRepository(repo);
    }
  });

  it('preserves legacy allowSameRevision replacement and validates the equal revision document', async () => {
    const repo = await repository();
    try {
      const original = createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      await repo.save('legacy-equal', metadata(original, 'legacy-equal'), original);
      await expect(repo.save(
        'legacy-equal',
        metadata(original, 'legacy-equal'),
        { revision: original.revision } as PatternDocument,
        undefined,
        { allowSameRevision: true }
      )).rejects.toThrow();

      const replacement = createDocument({ width: 2, height: 1, palette: [{ id: 1, name: 'Blue', color: '#36c' }] });
      const result = await repo.save('legacy-equal', { ...metadata(replacement, 'legacy-equal'), title: 'Equal replacement' }, replacement, undefined, { allowSameRevision: true });
      expect(result).toMatchObject({ committed: true, stale: false, revision: original.revision });
      expect((await repo.load('legacy-equal'))?.document.width).toBe(2);
      expect((await repo.load('legacy-equal'))?.recovery).toBeNull();
      expect(await repo.db.projectHeads.get('legacy-equal')).toMatchObject({ projectId: 'legacy-equal', revision: original.revision, checksum: result.head?.checksum });
    } finally {
      await closeRepository(repo);
    }
  });

  it('commits an authenticated prepared capability without main-side byte work and preserves recovery/head ordering', async () => {
    const repo = await repository();
    const preparation = new PersistencePreparationWorkerClient({ workerFactory: () => new RepositoryPreparationWorker() });
    const encodeSpy = vi.spyOn(binaryModule, 'encodeDocument');
    const hashSpy = vi.spyOn(hashModule, 'sha256');
    try {
      const revision0 = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const revision1 = applyCommand(revision0, { type: 'set-full', x: 1, y: 1, color: 1 }).document;
      await repo.save('prepared', metadata(revision0, 'prepared'), revision0);
      const rawPrepared = await prepareDocumentSnapshot(cloneDocument(revision1), { projectId: 'prepared', revision: revision1.revision, requestId: 'raw-prepared' });
      const preparedSummary = deriveProjectSummary(revision1);
      const validRevision1 = cloneDocument(revision1);
      const prepared = await preparation.prepare({ projectId: 'prepared', revision: revision1.revision, document: revision1, requestId: 'prepared-1' });
      // The preparation client must retain its summary from the owned clone,
      // not from a document the caller continues to mutate.
      revision1.colors.fill(0);
      const preparedRequestId = preparation.getRequestId(prepared);
      encodeSpy.mockClear();
      hashSpy.mockClear();
      const result = await repo.savePrepared('prepared', metadata(revision1, 'prepared'), prepared, undefined, { preparedRequestId });

      expect(result).toMatchObject({ committed: true, stale: false, revision: revision1.revision, head: { projectId: 'prepared', revision: revision1.revision } });
      expect(encodeSpy).not.toHaveBeenCalled();
      expect(hashSpy.mock.calls.some(([value]) => value instanceof Uint8Array && value.length === rawPrepared.bytes.length && value.every((byte, index) => byte === rawPrepared.bytes[index]))).toBe(false);
      expect(await repo.db.projects.get('prepared')).toMatchObject({
        width: preparedSummary.width,
        height: preparedSummary.height,
        thumbnail: preparedSummary.thumbnail
      });
      expect((await repo.load('prepared'))?.metadata).toMatchObject({
        width: preparedSummary.width,
        height: preparedSummary.height,
        thumbnail: preparedSummary.thumbnail
      });
      expect((await repo.load('prepared'))?.recovery?.revision).toBe(revision0.revision);
      expect(await repo.db.projectHeads.get('prepared')).toEqual(result.head);

      const before = await repo.db.currentSnapshots.get('prepared');
      await expect(repo.savePrepared('prepared', metadata(revision1, 'prepared'), rawPrepared as unknown as PreparedDocumentCapability, undefined, { preparedRequestId: 'raw-prepared' })).rejects.toMatchObject({ code: 'invalid-document' });
      await expect(repo.savePrepared('prepared', metadata(revision1, 'prepared'), Object.freeze({}) as PreparedDocumentCapability, undefined, { preparedRequestId: preparedRequestId })).rejects.toMatchObject({ code: 'invalid-document' });

      const wrongProject = await preparation.prepare({ projectId: 'other-project', revision: revision1.revision, document: validRevision1, requestId: 'wrong-project' });
      await expect(repo.savePrepared('prepared', metadata(revision1, 'prepared'), wrongProject, undefined, { preparedRequestId: 'wrong-project' })).rejects.toMatchObject({ code: 'invalid-document' });

      const wrongRevision = await preparation.prepare({ projectId: 'prepared', revision: revision0.revision, document: revision0, requestId: 'wrong-revision' });
      await expect(repo.savePrepared('prepared', metadata(revision1, 'prepared'), wrongRevision, undefined, { preparedRequestId: 'wrong-revision' })).rejects.toMatchObject({ code: 'invalid-document' });

      const otherRequest = await preparation.prepare({ projectId: 'prepared', revision: revision1.revision, document: validRevision1, requestId: 'other-request' });
      await expect(repo.savePrepared('prepared', metadata(revision1, 'prepared'), otherRequest, undefined, { preparedRequestId: preparedRequestId })).rejects.toMatchObject({ code: 'invalid-document' });
      await expect(repo.savePrepared('prepared', metadata(revision1, 'prepared'), prepared, undefined, { preparedRequestId })).rejects.toMatchObject({ code: 'invalid-document' });
      expect(await repo.db.currentSnapshots.get('prepared')).toEqual(before);
    } finally {
      encodeSpy.mockRestore();
      hashSpy.mockRestore();
      preparation.dispose();
      await closeRepository(repo);
    }
  });

  it('uses a loaded verified-current cache for a warm prepared revision advance', async () => {
    databaseCounter += 1;
    const db = new NeedlewiseDatabase(`needlewise-persistence-test-${String(databaseCounter)}`);
    const writer = new ProjectRepository(db, { now: () => 10 });
    const repo = new ProjectRepository(db, { now: () => 11 });
    const preparation = new PersistencePreparationWorkerClient({ workerFactory: () => new RepositoryPreparationWorker() });
    try {
      const revision0 = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const revision1 = applyCommand(revision0, { type: 'set-full', x: 1, y: 1, color: 1 }).document;
      await writer.save('warm-cache', metadata(revision0, 'warm-cache'), revision0);
      await repo.load('warm-cache');
      const oldSnapshot = await db.currentSnapshots.get('warm-cache');
      if (!oldSnapshot) throw new Error('missing warm-cache snapshot');
      const prepared = await preparation.prepare({ projectId: 'warm-cache', revision: revision1.revision, document: revision1, requestId: 'warm-revision' });

      const currentGet = vi.spyOn(db.currentSnapshots, 'get');
      const hashSpy = vi.spyOn(hashModule, 'sha256');
      const decodeSpy = vi.spyOn(binaryModule, 'decodeDocument');
      currentGet.mockClear();
      hashSpy.mockClear();
      decodeSpy.mockClear();

      const result = await repo.savePrepared('warm-cache', metadata(revision1, 'warm-cache'), prepared, undefined, { preparedRequestId: preparation.getRequestId(prepared) });

      expect(result.committed).toBe(true);
      expect(currentGet).not.toHaveBeenCalled();
      expect(hashSpy).not.toHaveBeenCalled();
      expect(decodeSpy).not.toHaveBeenCalled();
      const recovery = await db.recoverySnapshots.get('warm-cache');
      expect(recovery).toMatchObject({ projectId: 'warm-cache', revision: revision0.revision, checksum: oldSnapshot.checksum });
      expect(recovery?.bytes).toEqual(oldSnapshot.bytes);
      expect(cachedCurrent(repo)).toMatchObject({ projectId: 'warm-cache', revision: revision1.revision });
      currentGet.mockRestore();
      hashSpy.mockRestore();
      decodeSpy.mockRestore();
    } finally {
      preparation.dispose();
      await repo.close();
      await db.delete();
    }
  });

  it('falls back to full verified current-snapshot recovery on a cold cache', async () => {
    databaseCounter += 1;
    const db = new NeedlewiseDatabase(`needlewise-persistence-test-${String(databaseCounter)}`);
    const writer = new ProjectRepository(db, { now: () => 10 });
    const repo = new ProjectRepository(db, { now: () => 11 });
    const preparation = new PersistencePreparationWorkerClient({ workerFactory: () => new RepositoryPreparationWorker() });
    try {
      const revision0 = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const revision1 = applyCommand(revision0, { type: 'set-full', x: 1, y: 1, color: 1 }).document;
      await writer.save('cold-cache', metadata(revision0, 'cold-cache'), revision0);
      const prepared = await preparation.prepare({ projectId: 'cold-cache', revision: revision1.revision, document: revision1, requestId: 'cold-revision' });
      const currentGet = vi.spyOn(db.currentSnapshots, 'get');
      const hashSpy = vi.spyOn(hashModule, 'sha256');
      const decodeSpy = vi.spyOn(binaryModule, 'decodeDocument');
      currentGet.mockClear();
      hashSpy.mockClear();
      decodeSpy.mockClear();

      await repo.savePrepared('cold-cache', metadata(revision1, 'cold-cache'), prepared, undefined, { preparedRequestId: preparation.getRequestId(prepared) });

      expect(currentGet).toHaveBeenCalled();
      expect(hashSpy).toHaveBeenCalled();
      expect(decodeSpy).toHaveBeenCalled();
      expect((await db.recoverySnapshots.get('cold-cache'))?.revision).toBe(revision0.revision);
      currentGet.mockRestore();
      hashSpy.mockRestore();
      decodeSpy.mockRestore();
    } finally {
      preparation.dispose();
      await repo.close();
      await db.delete();
    }
  });

  it('invalidates a cached current snapshot when the compact head is stale', async () => {
    const repo = await repository();
    const preparation = new PersistencePreparationWorkerClient({ workerFactory: () => new RepositoryPreparationWorker() });
    try {
      const revision0 = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const revision1 = applyCommand(revision0, { type: 'set-full', x: 1, y: 1, color: 1 }).document;
      await repo.save('stale-cache', metadata(revision0, 'stale-cache'), revision0);
      const current = await repo.db.currentSnapshots.get('stale-cache');
      const head = await repo.db.projectHeads.get('stale-cache');
      if (!current || !head) throw new Error('missing stale-cache state');
      await repo.db.projectHeads.put({ ...head, checksum: 'f'.repeat(64) });
      const prepared = await preparation.prepare({ projectId: 'stale-cache', revision: revision1.revision, document: revision1, requestId: 'stale-head-revision' });
      const currentGet = vi.spyOn(repo.db.currentSnapshots, 'get');
      const hashSpy = vi.spyOn(hashModule, 'sha256');
      const decodeSpy = vi.spyOn(binaryModule, 'decodeDocument');
      currentGet.mockClear();
      hashSpy.mockClear();
      decodeSpy.mockClear();

      await repo.savePrepared('stale-cache', metadata(revision1, 'stale-cache'), prepared, undefined, { preparedRequestId: preparation.getRequestId(prepared) });

      expect(currentGet).toHaveBeenCalled();
      expect(hashSpy).toHaveBeenCalled();
      expect(decodeSpy).toHaveBeenCalled();
      expect((await repo.db.recoverySnapshots.get('stale-cache'))?.bytes).toEqual(current.bytes);
      currentGet.mockRestore();
      hashSpy.mockRestore();
      decodeSpy.mockRestore();
    } finally {
      preparation.dispose();
      await closeRepository(repo);
    }
  });

  it('uses only the verified cached bytes when the durable current record is later corrupted', async () => {
    const repo = await repository();
    const preparation = new PersistencePreparationWorkerClient({ workerFactory: () => new RepositoryPreparationWorker() });
    try {
      const revision0 = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const revision1 = applyCommand(revision0, { type: 'set-full', x: 1, y: 1, color: 1 }).document;
      await repo.save('corrupt-warm', metadata(revision0, 'corrupt-warm'), revision0);
      const verified = await repo.db.currentSnapshots.get('corrupt-warm');
      if (!verified) throw new Error('missing corrupt-warm snapshot');
      const corrupted = { ...verified, bytes: verified.bytes.slice() };
      corrupted.bytes[0] ^= 0xff;
      await repo.db.currentSnapshots.put(corrupted);
      const prepared = await preparation.prepare({ projectId: 'corrupt-warm', revision: revision1.revision, document: revision1, requestId: 'corrupt-warm-revision' });

      await repo.savePrepared('corrupt-warm', metadata(revision1, 'corrupt-warm'), prepared, undefined, { preparedRequestId: preparation.getRequestId(prepared) });

      const recovery = await repo.db.recoverySnapshots.get('corrupt-warm');
      expect(recovery?.bytes).toEqual(verified.bytes);
      expect(recovery?.checksum).toBe(verified.checksum);
    } finally {
      preparation.dispose();
      await closeRepository(repo);
    }
  });

  it('does not use a corrupt current record as recovery on a cold cache', async () => {
    databaseCounter += 1;
    const db = new NeedlewiseDatabase(`needlewise-persistence-test-${String(databaseCounter)}`);
    const writer = new ProjectRepository(db, { now: () => 10 });
    const repo = new ProjectRepository(db, { now: () => 11 });
    const preparation = new PersistencePreparationWorkerClient({ workerFactory: () => new RepositoryPreparationWorker() });
    try {
      const revision0 = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const revision1 = applyCommand(revision0, { type: 'set-full', x: 1, y: 1, color: 1 }).document;
      await writer.save('corrupt-cold', metadata(revision0, 'corrupt-cold'), revision0);
      const current = await db.currentSnapshots.get('corrupt-cold');
      if (!current) throw new Error('missing corrupt-cold snapshot');
      current.bytes[0] ^= 0xff;
      await db.currentSnapshots.put(current);
      const prepared = await preparation.prepare({ projectId: 'corrupt-cold', revision: revision1.revision, document: revision1, requestId: 'corrupt-cold-revision' });

      await repo.savePrepared('corrupt-cold', metadata(revision1, 'corrupt-cold'), prepared, undefined, { preparedRequestId: preparation.getRequestId(prepared) });

      expect(await db.recoverySnapshots.get('corrupt-cold')).toBeUndefined();
    } finally {
      preparation.dispose();
      await repo.close();
      await db.delete();
    }
  });

  it('keeps one cache entry, refreshes it after import/promotion, and clears it on delete/close', async () => {
    const repo = await repository();
    try {
      const first = createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const second = createDocument({ width: 2, height: 1, palette: [{ id: 1, name: 'Blue', color: '#36c' }] });
      await repo.save('evict-first', metadata(first, 'evict-first'), first);
      expect(cachedCurrent(repo)).toMatchObject({ projectId: 'evict-first', revision: first.revision });
      await repo.save('evict-second', metadata(second, 'evict-second'), second);
      expect(cachedCurrent(repo)).toMatchObject({ projectId: 'evict-second', revision: second.revision });

      const imported = createDocument({ width: 3, height: 1, palette: [{ id: 1, name: 'Green', color: '#3c3' }] });
      const archive = await exportArchive({ metadata: metadata(imported, 'lifecycle'), document: imported, assets: [] });
      await repo.save('lifecycle', metadata(first, 'lifecycle'), first);
      await repo.importProject(archive, { collision: 'replace' });
      expect(cachedCurrent(repo)).toMatchObject({ projectId: 'lifecycle', revision: imported.revision });

      const advanced = applyCommand(imported, { type: 'set-full', x: 0, y: 0, color: 1 }).document;
      await repo.save('lifecycle', metadata(advanced, 'lifecycle'), advanced);
      await repo.promoteRecoveryRevision('lifecycle', imported.revision);
      expect(cachedCurrent(repo)).toMatchObject({ projectId: 'lifecycle', revision: imported.revision });

      await repo.deleteProject('lifecycle');
      expect(cachedCurrent(repo)).toBeUndefined();
      await repo.save('close-cache', metadata(second, 'close-cache'), second);
      expect(cachedCurrent(repo)).toMatchObject({ projectId: 'close-cache' });
      await repo.close();
      expect(cachedCurrent(repo)).toBeUndefined();
      await repo.db.delete();
    } catch (error) {
      await repo.close();
      await repo.db.delete();
      throw error;
    }
  });

  it('does not publish an uncommitted snapshot to the cache when the transaction fails', async () => {
    const repo = await repository();
    const preparation = new PersistencePreparationWorkerClient({ workerFactory: () => new RepositoryPreparationWorker() });
    try {
      const revision0 = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const revision1 = applyCommand(revision0, { type: 'set-full', x: 1, y: 1, color: 1 }).document;
      await repo.save('failed-cache', metadata(revision0, 'failed-cache'), revision0);
      const prepared = await preparation.prepare({ projectId: 'failed-cache', revision: revision1.revision, document: revision1, requestId: 'failed-cache-revision' });
      const currentPut = vi.spyOn(repo.db.currentSnapshots, 'put').mockRejectedValueOnce(new Error('forced transaction failure'));

      await expect(repo.savePrepared('failed-cache', metadata(revision1, 'failed-cache'), prepared, undefined, { preparedRequestId: preparation.getRequestId(prepared) })).rejects.toMatchObject({ code: 'storage-failure' });

      expect(cachedCurrent(repo)).toMatchObject({ projectId: 'failed-cache', revision: revision0.revision });
      expect((await repo.db.currentSnapshots.get('failed-cache'))?.revision).toBe(revision0.revision);
      expect(await repo.db.recoverySnapshots.get('failed-cache')).toBeUndefined();
      currentPut.mockRestore();
    } finally {
      preparation.dispose();
      await closeRepository(repo);
    }
  });

  it('preserves omitted assets and clears them only when an empty asset list is supplied', async () => {
    const repo = await repository();
    try {
      const document = createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      await repo.save('asset-omission', metadata(document, 'asset-omission'), document, [{ id: 'kept', name: 'kept.bin', mimeType: 'application/octet-stream', data: new Uint8Array([1]) }]);
      let head = await repo.db.projectHeads.get('asset-omission');
      if (!head) throw new Error('missing compact project head');

      await repo.save('asset-omission', { ...metadata(document, 'asset-omission'), title: 'Omitted' }, { revision: document.revision } as PatternDocument, undefined, { mode: 'retain', expectedHead: head });
      expect((await repo.load('asset-omission'))?.assets.map((asset) => asset.id)).toEqual(['kept']);

      await repo.save('asset-omission', { ...metadata(document, 'asset-omission'), title: 'Cleared' }, { revision: document.revision } as PatternDocument, [], { mode: 'retain', expectedHead: head });
      expect((await repo.load('asset-omission'))?.assets).toEqual([]);
      head = (await repo.db.projectHeads.get('asset-omission')) as typeof head;
      expect(head.revision).toBe(document.revision);
    } finally {
      await closeRepository(repo);
    }
  });

  it('reports a corrupt current independently and explicitly loads valid recovery', async () => {
    const repo = await repository();
    try {
      const revision0 = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const revision1 = applyCommand(revision0, { type: 'set-full', x: 0, y: 0, color: 1 }).document;
      await repo.save('recoverable', metadata(revision0, 'recoverable'), revision0);
      await repo.save('recoverable', metadata(revision1, 'recoverable'), revision1);
      const current = await repo.db.currentSnapshots.get('recoverable');
      if (!current) throw new Error('missing current test snapshot');
      current.bytes = corruptBytes(current.bytes);
      await repo.db.currentSnapshots.put(current);

      await expect(repo.load('recoverable')).rejects.toMatchObject({ code: 'storage-failure' });
      await expect(repo.listProjectHealth()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ projectId: 'recoverable', current: expect.objectContaining({ status: 'corrupt' }), recovery: expect.objectContaining({ status: 'valid' }), recoveryAvailable: true })
      ]));
      const recovered = await repo.loadRecovery('recoverable', revision0.revision);
      expect(recovered?.document.revision).toBe(revision0.revision);
      expect(recovered?.metadata).toMatchObject({ width: revision0.width, height: revision0.height, thumbnail: deriveProjectSummary(revision0).thumbnail });
    } finally {
      await closeRepository(repo);
    }
  });

  it('loads a valid current with a corrupt recovery and returns a warning', async () => {
    const repo = await repository();
    try {
      const revision0 = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const revision1 = applyCommand(revision0, { type: 'set-full', x: 0, y: 0, color: 1 }).document;
      await repo.save('warning', metadata(revision0, 'warning'), revision0);
      await repo.save('warning', metadata(revision1, 'warning'), revision1);
      const recovery = await repo.db.recoverySnapshots.get('warning');
      if (!recovery) throw new Error('missing recovery test snapshot');
      recovery.bytes = corruptBytes(recovery.bytes);
      await repo.db.recoverySnapshots.put(recovery);

      const loaded = await repo.load('warning');
      expect(loaded?.document.revision).toBe(revision1.revision);
      expect(loaded?.recovery).toBeNull();
      expect(loaded?.health).toMatchObject({ current: { status: 'valid' }, recovery: { status: 'corrupt' } });
      expect(loaded?.health?.warnings.length).toBeGreaterThan(0);
    } finally {
      await closeRepository(repo);
    }
  });

  it('keeps the verified current document when one optional asset is corrupt', async () => {
    const repo = await repository();
    try {
      const document = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      await repo.save('asset-warning', metadata(document, 'asset-warning'), document, [
        { id: 'good', name: 'good.bin', mimeType: 'application/octet-stream', data: new Uint8Array([1, 2]) },
        { id: 'bad', name: 'bad.bin', mimeType: 'application/octet-stream', data: new Uint8Array([3, 4]) }
      ]);
      const bad = await repo.db.assets.get(['asset-warning', 'bad']);
      if (!bad) throw new Error('missing asset test record');
      bad.data[0] ^= 0xff;
      await repo.db.assets.put(bad);

      const loaded = await repo.load('asset-warning');
      expect(loaded?.document.revision).toBe(document.revision);
      expect(loaded?.assets.map((asset) => asset.id)).toEqual(['good']);
      expect(loaded?.health?.assets).toMatchObject({ status: 'corrupt', count: 2, validCount: 1, corruptCount: 1 });
      expect(loaded?.health?.warnings.some((warning) => warning.includes('bad'))).toBe(true);
    } finally {
      await closeRepository(repo);
    }
  });

  it('keeps a verified recovery document available when an optional asset is corrupt', async () => {
    const repo = await repository();
    try {
      const revision0 = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const revision1 = applyCommand(revision0, { type: 'set-full', x: 0, y: 0, color: 1 }).document;
      await repo.save('recovery-asset-warning', metadata(revision0, 'recovery-asset-warning'), revision0, [{ id: 'bad', name: 'bad.bin', mimeType: 'application/octet-stream', data: new Uint8Array([7, 8]) }]);
      await repo.save('recovery-asset-warning', metadata(revision1, 'recovery-asset-warning'), revision1);
      const bad = await repo.db.assets.get(['recovery-asset-warning', 'bad']);
      if (!bad) throw new Error('missing recovery asset test record');
      bad.data[0] ^= 0xff;
      await repo.db.assets.put(bad);

      const recovered = await repo.loadRecovery('recovery-asset-warning', revision0.revision);
      expect(recovered?.document.revision).toBe(revision0.revision);
      expect(recovered?.assets).toHaveLength(0);
      expect(recovered?.health).toMatchObject({ recovery: { status: 'valid' }, assets: { status: 'corrupt', validCount: 0, corruptCount: 1 } });
      expect(recovered?.health?.warnings.some((warning) => warning.includes('bad'))).toBe(true);
    } finally {
      await closeRepository(repo);
    }
  });

  it('updates the compact head when promoting recovery to current', async () => {
    const repo = await repository();
    try {
      const revision0 = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const revision1 = applyCommand(revision0, { type: 'set-full', x: 0, y: 0, color: 1 }).document;
      await repo.save('promotion-head', metadata(revision0, 'promotion-head'), revision0);
      await repo.save('promotion-head', metadata(revision1, 'promotion-head'), revision1);

      const promoted = await repo.promoteRecovery('promotion-head', revision0.revision);
      const current = await repo.db.currentSnapshots.get('promotion-head');
      const head = await repo.db.projectHeads.get('promotion-head');
      expect(promoted.document.revision).toBe(revision0.revision);
      expect(promoted.metadata).toMatchObject({ width: revision0.width, height: revision0.height, thumbnail: deriveProjectSummary(revision0).thumbnail });
      expect(head).toMatchObject({ projectId: 'promotion-head', revision: revision0.revision, checksum: current?.checksum, historyGeneration: 3 });
    } finally {
      await closeRepository(repo);
    }
  });

  it('rejects recovery promotion when current state changes after preflight', async () => {
    databaseCounter += 1;
    const db = new NeedlewiseDatabase(`needlewise-persistence-test-${String(databaseCounter)}`);
    const repo = new ProjectRepository(db, { now: () => 10 });
    try {
      const revision0 = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const revision1 = applyCommand(revision0, { type: 'set-full', x: 0, y: 0, color: 1 }).document;
      await repo.save('promotion-race', metadata(revision0, 'promotion-race'), revision0);
      await repo.save('promotion-race', metadata(revision1, 'promotion-race'), revision1);

      type TransactionCall = (mode: 'r' | 'rw', ...args: unknown[]) => Promise<unknown>;
      const originalTransaction = db.transaction.bind(db) as unknown as TransactionCall;
      let firstRead = true;
      db.transaction = ((mode: 'r' | 'rw', ...args: unknown[]) => {
        const result = originalTransaction(mode, ...args);
        if (!firstRead) return result;
        firstRead = false;
        return result.then(async (value) => {
          const current = await db.currentSnapshots.get('promotion-race');
          if (!current) throw new Error('missing current promotion record');
          current.revision += 1;
          await db.currentSnapshots.put(current);
          return value;
        });
      }) as unknown as typeof db.transaction;

      await expect(repo.promoteRecovery('promotion-race', revision0.revision)).rejects.toMatchObject({ code: 'stale-save' });
      expect((await db.currentSnapshots.get('promotion-race'))?.revision).toBe(revision1.revision + 1);
    } finally {
      await closeRepository(repo);
    }
  });

  it('lists known projects without hiding incomplete records and exposes health', async () => {
    const repo = await repository();
    const currentRead = vi.spyOn(repo.db.currentSnapshots, 'get');
    try {
      const valid = createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      await repo.save('valid', { ...metadata(valid, 'valid'), updatedAt: 30 }, valid);
      await repo.db.projects.put({ id: 'incomplete', title: 'Incomplete', notes: '', createdAt: 1, updatedAt: 50, revision: 0 });
      await repo.db.projects.put({ id: 'corrupt', title: 'Corrupt', notes: '', createdAt: 1, updatedAt: 40, revision: 0 });
      await repo.db.currentSnapshots.put({ projectId: 'corrupt', revision: 0, bytes: new Uint8Array([0, 1, 2]), checksum: '0'.repeat(64), savedAt: 1 });
      await repo.db.projects.put({
        ...metadata(valid, 'malformed-summary'),
        updatedAt: 35,
        width: valid.width,
        thumbnail: { version: 1, revision: valid.revision, columns: 1, rows: 1, palette: [], indices: [0] }
      });
      currentRead.mockClear();
      expect((await repo.listProjects()).map((project) => project.id)).toEqual(['incomplete', 'corrupt', 'malformed-summary', 'valid']);
      expect(currentRead).not.toHaveBeenCalled();
      const visibleMalformed = (await repo.listProjects()).find((project) => project.id === 'malformed-summary');
      expect(visibleMalformed).toMatchObject({ id: 'malformed-summary' });
      expect(visibleMalformed?.width).toBeUndefined();
      expect(visibleMalformed?.thumbnail).toBeUndefined();
      const health = await repo.listProjectHealth();
      expect(health.find((project) => project.projectId === 'valid')).toMatchObject({ current: { status: 'valid' } });
      expect(health.find((project) => project.projectId === 'corrupt')).toMatchObject({ current: { status: 'corrupt' } });
      expect(health.find((project) => project.projectId === 'incomplete')).toMatchObject({ current: { status: 'missing' } });
    } finally {
      currentRead.mockRestore();
      await closeRepository(repo);
    }
  });

  it('does not fail a verified load when summary cache backfill cannot write', async () => {
    const repo = await repository();
    try {
      const document = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      await repo.save('backfill-write-failure', metadata(document, 'backfill-write-failure'), document);
      const stored = await repo.db.projects.get('backfill-write-failure');
      if (!stored) throw new Error('missing backfill metadata');
      delete stored.width;
      delete stored.height;
      delete stored.thumbnail;
      await repo.db.projects.put(stored);

      const currentRead = vi.spyOn(repo.db.currentSnapshots, 'get');
      currentRead.mockClear();
      const projectPut = vi.spyOn(repo.db.projects, 'put').mockRejectedValueOnce(new Error('cache write failed'));
      try {
        await expect(repo.load('backfill-write-failure')).resolves.toMatchObject({ document: { width: 2, height: 2 } });
        expect(currentRead).toHaveBeenCalledTimes(1);
      } finally {
        projectPut.mockRestore();
        currentRead.mockRestore();
      }
    } finally {
      await closeRepository(repo);
    }
  });

  it('does not open a backfill transaction for an already canonical summary', async () => {
    const repo = await repository();
    try {
      const document = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      await repo.save('canonical-backfill', metadata(document, 'canonical-backfill'), document);
      const transaction = vi.spyOn(repo.db, 'transaction');
      try {
        await repo.load('canonical-backfill');
        expect(transaction).toHaveBeenCalledTimes(1);
      } finally {
        transaction.mockRestore();
      }
    } finally {
      await closeRepository(repo);
    }
  });

  it('does not let a stale load backfill over a concurrent replacement summary', async () => {
    databaseCounter += 1;
    const db = new NeedlewiseDatabase(`needlewise-persistence-test-${String(databaseCounter)}`);
    const staleLoader = new ProjectRepository(db, { now: () => 10 });
    const writer = new ProjectRepository(db, { now: () => 11 });
    try {
      const oldDocument = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const newDocument = createDocument({ width: 3, height: 1, palette: [{ id: 1, name: 'Blue', color: '#36c' }] });
      await writer.save('backfill-race', metadata(oldDocument, 'backfill-race'), oldDocument);
      const legacyMetadata = await db.projects.get('backfill-race');
      if (!legacyMetadata) throw new Error('missing race metadata');
      delete legacyMetadata.width;
      delete legacyMetadata.height;
      delete legacyMetadata.thumbnail;
      await db.projects.put(legacyMetadata);

      type TransactionCall = (mode: 'r' | 'rw', ...args: unknown[]) => Promise<unknown>;
      const originalTransaction = db.transaction.bind(db) as unknown as TransactionCall;
      let firstRead = true;
      db.transaction = ((mode: 'r' | 'rw', ...args: unknown[]) => {
        const result = originalTransaction(mode, ...args);
        if (!firstRead) return result;
        firstRead = false;
        return result.then(async (value) => {
          await writer.save('backfill-race', metadata(newDocument, 'backfill-race'), newDocument, undefined, { allowSameRevision: true });
          return value;
        });
      }) as unknown as typeof db.transaction;

      const loaded = await staleLoader.load('backfill-race');
      expect(loaded?.document.width).toBe(oldDocument.width);
      const newestMetadata = await db.projects.get('backfill-race');
      expect(newestMetadata).toMatchObject({
        width: newDocument.width,
        height: newDocument.height,
        thumbnail: deriveProjectSummary(newDocument).thumbnail
      });
    } finally {
      await staleLoader.close();
      await db.delete();
    }
  });

  it('round-trips an archive and an optional local asset', async () => {
    const repo = await repository();
    const importedRepo = await repository();
    try {
      const document = makeDocument();
      const asset = new Uint8Array([1, 2, 3, 4, 5]);
      const projectMetadata = metadata(document);
      await repo.save('project-1', projectMetadata, document, [{ id: 'reference', name: 'reference.bin', mimeType: 'application/octet-stream', data: asset }]);
      expect((await repo.load('project-1'))?.document.catalog).toEqual(document.catalog);
      expect((await repo.load('project-1'))?.metadata).toMatchObject({ width: document.width, height: document.height, thumbnail: deriveProjectSummary(document).thumbnail });
      const archive = await repo.exportProject('project-1');
      const archivedMetadata = JSON.parse(strFromU8(unzipSync(archive)['metadata.json'])) as Record<string, unknown>;
      expect(archivedMetadata).not.toHaveProperty('thumbnail');
      const parsed = await parseArchive(archive);
      expect(parsed.manifest.document.catalog).toEqual(document.catalog);
      expect(parsed.document.catalog).toEqual(document.catalog);
      expect(parsed.metadata).not.toHaveProperty('thumbnail');
      expect(parsed.metadata).toMatchObject({ width: document.width, height: document.height });
      const imported = await importedRepo.importProject(archive);
      expect(imported.metadata).toMatchObject(projectMetadata);
      expect(imported.metadata).toMatchObject({ width: document.width, height: document.height, thumbnail: deriveProjectSummary(document).thumbnail });
      expect(imported.document.kind).toEqual(document.kind);
      expect(imported.document.colors).toEqual(document.colors);
      expect(imported.document.catalog).toEqual(document.catalog);
      expect(imported.head).toMatchObject({ projectId: 'project-1', revision: document.revision, checksum: (await importedRepo.db.currentSnapshots.get('project-1'))?.checksum });
      expect(imported.assets).toHaveLength(1);
      expect(imported.assets[0].data).toEqual(asset);
    } finally {
      await closeRepository(repo);
      await closeRepository(importedRepo);
    }
  });

  it('loads and rewrites existing local assets with legacy arbitrary IDs', async () => {
    const repo = await repository();
    try {
      const document = createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const ids = ['.', '..', ' ', '%', '/', '\uD800'];
      const data = pngBytes(1, 1);
      const sourceImage = {
        assetId: ids[0], mimeType: 'image/png' as const, width: 1, height: 1,
        crop: { x: 0, y: 0, width: 1, height: 1 }, chartBounds: { x: 0, y: 0, width: 1, height: 1 }, traceVisible: true, opacity: 1
      };
      await repo.save('legacy-local', metadata(document, 'legacy-local'), document);
      for (const id of ids) await repo.db.assets.put({ projectId: 'legacy-local', id, name: 'reference.png', mimeType: 'image/png', data, checksum: await sha256(data) });
      await repo.db.projects.put({ ...metadata(document, 'legacy-local'), sourceImage });

      const loaded = await repo.load('legacy-local');
      expect(loaded?.assets.map((asset) => asset.id).sort()).toEqual([...ids].sort());
      expect(loaded?.metadata.sourceImage).toEqual(sourceImage);
      expect(loaded?.health?.sourceImage).toMatchObject({ assetId: ids[0], status: 'valid' });

      await repo.save('legacy-local', { ...loaded!.metadata, title: 'Updated', sourceImage }, loaded!.document, loaded!.assets, { allowSameRevision: true });
      const rewritten = await repo.load('legacy-local');
      expect(rewritten?.metadata.title).toBe('Updated');
      expect(rewritten?.assets.map((asset) => asset.id).sort()).toEqual([...ids].sort());
      expect(rewritten?.metadata.sourceImage?.assetId).toBe(ids[0]);
      const parsed = await parseArchive(await repo.exportProject('legacy-local'));
      expect(parsed.assets.map((asset) => asset.id).sort()).toEqual([...ids].sort());
    } finally {
      await closeRepository(repo);
    }
  });

  it('rejects import ID collisions by default and replaces only explicitly', async () => {
    const source = await repository();
    const target = await repository();
    try {
      const sourceDocument = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      await source.save('collision', metadata(sourceDocument, 'collision'), sourceDocument);
      const archive = await source.exportProject('collision');
      const targetDocument = createDocument({ width: 3, height: 3, palette: [{ id: 1, name: 'Blue', color: '#36c' }] });
      await target.save('collision', metadata(targetDocument, 'collision'), targetDocument);

      await expect(target.importProject(archive)).rejects.toMatchObject({ code: 'import-collision' });
      expect((await target.load('collision'))?.document.width).toBe(3);
      await expect(target.importProject(archive, { collision: 'replace' })).resolves.toMatchObject({ document: { width: 2 } });
    } finally {
      await closeRepository(source);
      await closeRepository(target);
    }
  });

  it('does not copy a corrupt current snapshot into recovery during replacement', async () => {
    const source = await repository();
    const target = await repository();
    try {
      const old0 = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const old1 = applyCommand(old0, { type: 'set-full', x: 0, y: 0, color: 1 }).document;
      await target.save('replace-corrupt', metadata(old0, 'replace-corrupt'), old0);
      await target.save('replace-corrupt', metadata(old1, 'replace-corrupt'), old1);
      const current = await target.db.currentSnapshots.get('replace-corrupt');
      if (!current) throw new Error('missing current test snapshot');
      current.bytes = corruptBytes(current.bytes);
      await target.db.currentSnapshots.put(current);

      const importedDocument = applyCommand(old1, { type: 'set-full', x: 1, y: 1, color: 1 }).document;
      await source.save('replace-corrupt', metadata(importedDocument, 'replace-corrupt'), importedDocument);
      await target.importProject(await source.exportProject('replace-corrupt'), { collision: 'replace' });
      const loaded = await target.load('replace-corrupt');
      expect(loaded?.document.revision).toBe(importedDocument.revision);
      expect(loaded?.recovery?.revision).toBe(old0.revision);
      expect(loaded?.health?.recovery.status).toBe('valid');
    } finally {
      await closeRepository(source);
      await closeRepository(target);
    }
  });

  it('does not write when archive checksum or manifest validation fails', async () => {
    const repo = await repository();
    try {
      const original = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      await repo.save('project-1', metadata(original), original);
      const archive = await repo.exportProject('project-1');
      const files = unzipSync(archive);
      const damagedDocument = files['document.bin'].slice();
      damagedDocument[damagedDocument.length - 1] ^= 0xff;
      files['document.bin'] = damagedDocument;
      const damagedArchive = zipSync(files);
      await expect(repo.importProject(damagedArchive)).rejects.toMatchObject({ code: 'checksum-mismatch' });
      expect((await repo.load('project-1'))?.document.revision).toBe(original.revision);

      const manifest = JSON.parse(strFromU8(files['manifest.json'])) as { document: { sha256: string } };
      manifest.document.sha256 = '0'.repeat(64);
      files['manifest.json'] = strToU8(JSON.stringify(manifest));
      const damagedManifestArchive = zipSync(files);
      await expect(repo.importProject(damagedManifestArchive)).rejects.toBeInstanceOf(PersistenceError);
      expect((await repo.load('project-1'))?.recovery).toBeNull();
    } finally {
      await closeRepository(repo);
    }
  });
});

describe('archive validation', () => {
  it('validates only the clean archive identity, schema, and catalog association', async () => {
    const document = createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    const archive = await exportArchive({ metadata: metadata(document), document, assets: [] });
    const parsed = await parseArchive(archive);
    const validated = validateArchiveManifest(parsed.manifest);
    expect(validated).toEqual(parsed.manifest);
    expect(validated).not.toBe(parsed.manifest);
    expect(validated.document.catalog).toEqual(document.catalog);

    expect(() => validateArchiveManifest({ ...parsed.manifest, format: 'needlewise-project' } as never)).toThrow(/identity or version is invalid/i);
    expect(() => validateArchiveManifest({ ...parsed.manifest, archiveVersion: 2 } as never)).toThrow(/identity or version is invalid/i);
    expect(() => validateArchiveManifest({
      ...parsed.manifest,
      document: { ...parsed.manifest.document, schemaVersion: 0 }
    } as never)).toThrow(/version is invalid/i);
    expect(() => validateArchiveManifest({
      ...parsed.manifest,
      document: { ...parsed.manifest.document, catalog: { ...parsed.manifest.document.catalog, colorCount: 0 } }
    } as never)).toThrow(/catalog association is invalid/i);

    const invalid = encodeDocument(document);
    new DataView(invalid.buffer).setUint32(40, 0xffffffff, true);
    expect(() => decodeDocument(invalid)).toThrow();
  });

  it('rejects a valid manifest catalog that differs from the decoded document', async () => {
    const document = createDocument({ width: 1, height: 1, palette: [] });
    const archive = await exportArchive({ metadata: metadata(document, 'catalog-mismatch'), document, assets: [] });
    const files = unzipSync(archive);
    const manifest = JSON.parse(strFromU8(files['manifest.json'])) as { document: { catalog: CatalogAssociation } };
    manifest.document.catalog = {
      catalogId: 'other-catalog-v1',
      brandLabel: 'Other catalog',
      colorCount: document.catalog.colorCount
    };
    expect(manifest.document.catalog).not.toEqual(document.catalog);
    files['manifest.json'] = strToU8(JSON.stringify(manifest));

    await expect(parseArchive(zipSync(files))).rejects.toMatchObject({ code: 'invalid-archive' });
  });

  it('migrates an existing v5 database project into the v6 history schema', async () => {
    databaseCounter += 1;
    const databaseName = `needlewise-v5-migration-${String(databaseCounter)}`;
    const legacy = new Dexie(databaseName);
    legacy.version(5).stores({
      projects: 'id, aidaCount',
      currentSnapshots: 'projectId',
      recoverySnapshots: 'projectId',
      projectHeads: 'projectId',
      assets: '[projectId+id], projectId',
      dailyActivity: '[projectId+date], projectId'
    });
    await legacy.open();
    const document = createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    const bytes = encodeDocument(document);
    const checksum = await sha256(bytes);
    await legacy.table('projects').put(metadata(document, 'old-database-project'));
    await legacy.table('currentSnapshots').put({ projectId: 'old-database-project', revision: document.revision, bytes, checksum, savedAt: 10 });
    await legacy.table('projectHeads').put({ projectId: 'old-database-project', revision: document.revision, checksum });
    legacy.close();
    const repo = new ProjectRepository(new NeedlewiseDatabase(databaseName), { now: () => 10 });
    try {
      const loaded = await repo.load('old-database-project');
      expect(loaded?.metadata.aidaCount).toBeUndefined();
      expect(repo.db.verno).toBe(7);
      expect(await repo.db.documentHistories.get('old-database-project')).toBeUndefined();
    } finally {
      await closeRepository(repo);
    }
  });

  it('round-trips every legacy local asset ID through binary-safe archive paths', async () => {
    const document = createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    const ids = ['.', '..', ' ', '%', '/', '\uD800'];
    const assets = ids.map((id, index) => ({ id, name: `${String(index)}.bin`, mimeType: 'application/octet-stream', data: new Uint8Array([index + 1]), checksum: '' }));
    for (const asset of assets) asset.checksum = await sha256(asset.data);
    const archive = await exportArchive({
      metadata: metadata(document, 'legacy-archive'),
      document,
      assets
    });
    const files = unzipSync(archive);
    const manifest = JSON.parse(strFromU8(files['manifest.json'])) as { archiveVersion: number; assets: Array<{ id: string; path: string }> };
    expect(manifest.archiveVersion).toBe(PERSISTENCE_SCHEMA_VERSION);
    expect(manifest.assets.map((asset) => asset.path)).toEqual(ids.map(() => expect.stringMatching(/^assets\/legacy~[A-Za-z0-9_-]+$/)));
    const parsed = await parseArchive(archive);
    expect(parsed.assets.map((asset) => asset.id)).toEqual(ids);
    expect(parsed.assets.map((asset) => [...asset.data])).toEqual(assets.map((asset) => [...asset.data]));
  });

  it('rejects noncanonical percent-encoded asset paths while rejecting traversal', async () => {
    const document = createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    const id = 'legacy image/%/reference';
    const data = new Uint8Array([1, 2, 3]);
    const archive = await exportArchive({
      metadata: metadata(document, 'legacy-v2'),
      document,
      assets: [{ id, name: 'reference.bin', mimeType: 'application/octet-stream', data, checksum: await sha256(data) }]
    });
    const files = unzipSync(archive);
    const manifest = JSON.parse(strFromU8(files['manifest.json'])) as { assets: Array<{ id: string; path: string }> };
    const currentPath = manifest.assets[0].path;
    const noncanonicalPath = `assets/${encodeURIComponent(id)}`;
    expect(noncanonicalPath).not.toBe(currentPath);
    manifest.assets[0].path = noncanonicalPath;
    files['manifest.json'] = strToU8(JSON.stringify(manifest));
    await expect(parseArchive(zipSync(files))).rejects.toMatchObject({ code: 'invalid-manifest' });

    const traversal = zipSync({ ...unzipSync(archive), 'assets/../escape': new Uint8Array([9]) });
    await expect(parseArchive(traversal)).rejects.toMatchObject({ code: 'invalid-archive' });
  });

  it('rejects oversized Blob input before reading it', async () => {
    const archiveBlob = new Blob([new Uint8Array([1])]);
    Object.defineProperty(archiveBlob, 'size', { configurable: true, value: MAX_ARCHIVE_BYTES + 1 });
    const archiveRead = vi.spyOn(archiveBlob, 'arrayBuffer');
    await expect(parseArchive(archiveBlob)).rejects.toMatchObject({ code: 'archive-too-large' });
    expect(archiveRead).not.toHaveBeenCalled();

    const repo = await repository();
    try {
      const document = createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      const assetBlob = new Blob([new Uint8Array([1])]);
      Object.defineProperty(assetBlob, 'size', { configurable: true, value: MAX_ASSET_BYTES + 1 });
      const assetRead = vi.spyOn(assetBlob, 'arrayBuffer');
      await expect(repo.save('large-asset', metadata(document, 'large-asset'), document, [{ id: 'large', name: 'large', mimeType: 'application/octet-stream', data: assetBlob }])).rejects.toMatchObject({ code: 'invalid-asset' });
      expect(assetRead).not.toHaveBeenCalled();
    } finally {
      await closeRepository(repo);
    }
  });

  it('preflights expansion, streaming flags, and unknown files before extraction', async () => {
    const document = createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    const archive = await exportArchive({ metadata: metadata(document), document, assets: [] });
    const excessiveExpansion = mutateFirstCentralEntry(archive, (view, offset) => view.setUint32(offset + 24, MAX_DOCUMENT_BYTES + 1, true));
    await expect(parseArchive(excessiveExpansion)).rejects.toBeInstanceOf(PersistenceError);

    const dataDescriptor = mutateFirstCentralEntry(archive, (view, offset) => view.setUint16(offset + 8, 0x0008, true));
    await expect(parseArchive(dataDescriptor)).rejects.toMatchObject({ code: 'invalid-archive' });

    const files = unzipSync(archive);
    const unknownFile = zipSync({ ...files, 'unknown.txt': new Uint8Array([1, 2, 3]) });
    await expect(parseArchive(unknownFile)).rejects.toMatchObject({ code: 'invalid-archive' });
  });

  it('caps actual aggregate asset expansion while entries are being streamed', async () => {
    const document = createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    const base = await exportArchive({ metadata: metadata(document, 'aggregate-expansion'), document, assets: [] });
    const files = unzipSync(base);
    const manifest = JSON.parse(strFromU8(files['manifest.json'])) as { assets: unknown[] };
    const assets = await Promise.all([0, 1, 2, 3, 4, 5].map(async (index) => {
      const id = `expanded-${String(index)}`;
      const data = new Uint8Array(12_600_000);
      return { id, name: `${id}.bin`, mimeType: 'application/octet-stream', data, checksum: await sha256(data) };
    }));
    manifest.assets = assets.map(({ id, name, mimeType, data, checksum }) => ({ id, path: `assets/${id}`, name, mimeType, byteLength: data.length, sha256: checksum }));
    files['manifest.json'] = strToU8(JSON.stringify(manifest));
    for (const asset of assets) files[`assets/${asset.id}`] = asset.data;
    const archive = zipSync(files, { level: 9 });
    await expect(parseArchive(archive)).rejects.toMatchObject({ code: 'archive-too-large' });
  }, 15_000);

  it('accepts single assets at the shared decode byte ceiling and rejects just past it', async () => {
    const repo = await repository();
    try {
      const document = createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      // At the ceiling: a Blob whose declared size is exactly MAX_ASSET_BYTES
      // passes the size gate (the real payload stays tiny for the test).
      const atLimit = new Blob([new Uint8Array([1])], { type: 'image/png' });
      Object.defineProperty(atLimit, 'size', { configurable: true, value: MAX_ASSET_BYTES });
      await repo.save('asset-at-limit', metadata(document, 'asset-at-limit'), document, [{ id: 'at', name: 'at.png', mimeType: 'image/png', data: atLimit }]);
      expect((await repo.load('asset-at-limit'))?.assets[0].data).toEqual(new Uint8Array([1]));

      // Just past the ceiling: rejected before any bytes are read.
      const overLimit = new Blob([new Uint8Array([1])], { type: 'image/png' });
      Object.defineProperty(overLimit, 'size', { configurable: true, value: MAX_ASSET_BYTES + 1 });
      const read = vi.spyOn(overLimit, 'arrayBuffer');
      await expect(repo.save('asset-over-limit', metadata(document, 'asset-over-limit'), document, [{ id: 'over', name: 'over.png', mimeType: 'image/png', data: overLimit }])).rejects.toMatchObject({ code: 'invalid-asset' });
      expect(read).not.toHaveBeenCalled();
    } finally {
      await closeRepository(repo);
    }
  });

  it('rejects unsafe IDs on new local asset writes', async () => {
    const document = createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    const repo = await repository();
    try {
      await expect(repo.save('unsafe-asset', metadata(document, 'unsafe-asset'), document, [{ id: 'a/b', name: 'unsafe.bin', mimeType: 'application/octet-stream', data: new Uint8Array([1]) }])).rejects.toMatchObject({ code: 'invalid-asset' });
    } finally {
      await closeRepository(repo);
    }
  });

  it('applies the activity limit before decompression allocation', async () => {
    const document = createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    const archive = await exportArchive({ metadata: metadata(document, 'activity-limit'), document, assets: [], activity: { daily: [] } });
    const files = unzipSync(archive);
    files['activity.json'] = new Uint8Array(64 * 1024 + 1);
    const oversizedActivity = zipSync(files);
    await expect(parseArchive(oversizedActivity)).rejects.toMatchObject({ code: 'invalid-archive' });
  });

  it('checks binary count and metadata bounds before allocation', () => {
    const document = createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    const excessiveBackstitches = encodeDocument(document);
    new DataView(excessiveBackstitches.buffer).setUint32(36, 0xffffffff, true);
    expect(() => decodeDocument(excessiveBackstitches)).toThrow(PersistenceError);

    const malformedMetadata = encodeDocument(document);
    new DataView(malformedMetadata.buffer).setUint32(43, 0xffffffff, true);
    expect(() => decodeDocument(malformedMetadata)).toThrow(PersistenceError);
  });
});
