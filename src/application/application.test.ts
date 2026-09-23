import { describe, expect, it, vi } from 'vitest';
import {
  CellKind,
  cloneDocument,
  createDocument as createDomainDocument,
  defaultPaletteSymbol,
  type PatternDocument
} from '../domain';
import {
  decodeDocument,
  encodeDocument,
  exportArchive,
  importArchive,
  cloneSessionHistory,
  PersistenceError,
  PersistencePreparationWorkerClient,
  sha256,
  type ArchiveImportOptions,
  type ProjectAsset,
  type ProjectAssetInput,
  type ProjectMetadata,
  type ProjectRecord,
  type PreparedDocumentCapability,
  type PersistencePreparationInput,
  type PersistencePreparationClient,
  type SaveOptions,
  type SaveResult,
  type SessionHistoryEnvelope
} from '../persistence';
import { consumePreparedDocumentCapability } from '../persistence/preparation-client';
import { createStarterDocument, ProjectWorkspace } from './index';
import { ProjectSession } from './session';
import type { WorkspaceRepository } from './types';
import { acceptConversionDraft, type AcceptedConversionDraft } from '../conversion/image-to-pattern';
import { decodeTraceImage } from '../rendering/trace';
import { createInstalledCatalogRegistry, DEFAULT_CATALOG_DEFINITION, createCatalogReference, type CatalogDefinition, type CatalogRecord } from '../catalog';

function createDocument(options: Omit<Parameters<typeof createDomainDocument>[0], 'catalog'>): PatternDocument {
  return createDomainDocument({ ...options, catalog: DEFAULT_CATALOG_DEFINITION.association });
}

function syntheticCatalogDefinition(catalogId: string, brandLabel: string): CatalogDefinition {
  const record: CatalogRecord = Object.freeze({
    sourceId: `${catalogId}-blue`,
    code: 'B1',
    name: `${brandLabel} Blue`,
    hex: '#123456',
    rgb: Object.freeze([18, 52, 86]) as readonly [number, number, number]
  });
  const records = Object.freeze([record]);
  const association = Object.freeze({ catalogId, brandLabel, colorCount: records.length });
  return Object.freeze({
    association,
    records,
    compatibilityLabel: `${brandLabel} compatible`,
    snapshot: Object.freeze({ association, records }),
    search: (query: string, options: { readonly limit?: number } = {}) => {
      const needle = query.trim().toLowerCase();
      const matches = needle === '' ? [record] : [record].filter((candidate) => [candidate.sourceId, candidate.code, candidate.name, candidate.hex].some((value) => value.toLowerCase().includes(needle)));
      return Object.freeze(options.limit === undefined ? matches : matches.slice(0, options.limit));
    },
    getByHex: (hex: string) => hex.trim().toUpperCase() === record.hex ? record : undefined,
    nearest: () => record
  });
}

function copyRecord(record: ProjectRecord): ProjectRecord {
  return {
    metadata: { ...record.metadata },
    document: cloneDocument(record.document),
    ...(record.head === undefined ? {} : { head: { ...record.head } }),
    recovery: record.recovery === null ? null : { revision: record.recovery.revision, document: cloneDocument(record.recovery.document) },
    assets: record.assets.map((asset) => ({ ...asset, data: new Uint8Array(asset.data) })),
    ...(record.history === undefined ? {} : { history: cloneSessionHistory(record.history) })
  };
}

class MemoryRepository implements WorkspaceRepository {
  readonly records = new Map<string, ProjectRecord>();
  readonly saveCalls: Array<{ id: string; revision: number }> = [];
  readonly saveModes: Array<SaveOptions['mode']> = [];
  readonly saveDocuments: PatternDocument[] = [];
  readonly preparedSaveCalls: string[] = [];
  failSaves = false;
  beforeSave: (() => Promise<void> | void) | undefined;

  async save(projectId: string, metadata: ProjectMetadata, document: PatternDocument, assets?: readonly ProjectAssetInput[], options: SaveOptions = {}): Promise<SaveResult> {
    if (this.failSaves) throw new PersistenceError('storage-failure', 'Test storage failure.');
    await this.beforeSave?.();
    this.saveModes.push(options.mode);
    this.saveDocuments.push(document);
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
      : { projectId, revision: persistedDocument.revision, checksum: await sha256(encodeDocument(persistedDocument)) };
    const nextAssets: ProjectAsset[] = assets === undefined
      ? current?.assets ?? []
      : [];
    if (assets !== undefined) {
      for (const asset of assets) {
        const data = asset.data instanceof Uint8Array ? asset.data.slice() : asset.data instanceof ArrayBuffer ? new Uint8Array(asset.data).slice() : new Uint8Array(await asset.data.arrayBuffer());
        nextAssets.push({ id: asset.id, name: asset.name, mimeType: asset.mimeType, data, checksum: await sha256(data) });
      }
    }
    this.saveCalls.push({ id: projectId, revision: persistedDocument.revision });
    this.records.set(projectId, {
      metadata: { ...metadata },
      document: cloneDocument(persistedDocument),
      ...(head === undefined ? {} : { head }),
      recovery: retained ? current?.recovery ?? null : current === undefined ? null : { revision: current.document.revision, document: cloneDocument(current.document) },
      assets: nextAssets,
      ...(options.history !== undefined && 'trace' in options.history ? { history: cloneSessionHistory(options.history as SessionHistoryEnvelope) } : {})
    });
    return { committed: true, stale: false, revision: persistedDocument.revision, head };
  }

  async savePrepared(projectId: string, metadata: ProjectMetadata, prepared: PreparedDocumentCapability, assets?: readonly ProjectAssetInput[], options: SaveOptions = {}): Promise<SaveResult> {
    this.preparedSaveCalls.push(options.preparedRequestId ?? '');
    return consumePreparedDocumentCapability(
      prepared,
      { projectId, revision: metadata.revision, requestId: options.preparedRequestId ?? '' },
      (bytes) => this.save(projectId, metadata, decodeDocument(bytes), assets, options)
    );
  }

  async load(projectId: string): Promise<ProjectRecord | undefined> {
    const record = this.records.get(projectId);
    return record === undefined ? undefined : copyRecord(record);
  }

  async listProjects(): Promise<ProjectMetadata[]> {
    return [...this.records.values()].sort((left, right) => right.metadata.updatedAt - left.metadata.updatedAt).map((record) => ({ ...record.metadata }));
  }

  async deleteProject(projectId: string): Promise<void> {
    this.records.delete(projectId);
  }

  async exportProject(projectId: string): Promise<Uint8Array> {
    const record = this.records.get(projectId);
    if (!record) throw new PersistenceError('storage-failure', 'Missing test project.');
    return exportArchive({ metadata: record.metadata, document: record.document, assets: record.assets });
  }

  async importProject(input: Uint8Array | ArrayBuffer | Blob, options: ArchiveImportOptions = {}): Promise<ProjectRecord> {
    const bundle = await importArchive(input, options);
    const record: ProjectRecord = { metadata: bundle.metadata, document: bundle.document, head: { projectId: bundle.metadata.id, revision: bundle.document.revision, checksum: await sha256(encodeDocument(bundle.document)) }, recovery: null, assets: bundle.assets };
    this.records.set(bundle.metadata.id, copyRecord(record));
    return copyRecord(record);
  }
}

class ImmediateRepository {
  readonly saveCalls: Array<{ id: string; revision: number }> = [];
  readonly records = new Map<string, ProjectRecord>();
  beforeSave: (() => Promise<void> | void) | undefined;

  async save(projectId: string, metadata: ProjectMetadata, document: PatternDocument): Promise<SaveResult> {
    await this.beforeSave?.();
    this.saveCalls.push({ id: projectId, revision: document.revision });
    const head = { projectId, revision: document.revision, checksum: '0'.repeat(64) };
    this.records.set(projectId, { metadata: { ...metadata }, document: cloneDocument(document), head, recovery: null, assets: [] });
    return { committed: true, stale: false, revision: document.revision, head };
  }

  async load(projectId: string): Promise<ProjectRecord | undefined> {
    const record = this.records.get(projectId);
    return record === undefined ? undefined : {
      metadata: { ...record.metadata },
      document: cloneDocument(record.document),
      ...(record.head === undefined ? {} : { head: { ...record.head } }),
      recovery: record.recovery,
      assets: []
    };
  }
}

class FakePreparationClient implements PersistencePreparationClient {
  readonly requests: PersistencePreparationInput[] = [];
  private readonly delegate = new PersistencePreparationWorkerClient({ useWorker: false });
  disposed = false;

  async prepare(input: PersistencePreparationInput): Promise<PreparedDocumentCapability> {
    this.requests.push(input);
    return this.delegate.prepare({ ...input, requestId: `prepared-${String(this.requests.length)}` });
  }

  getRequestId(capability: PreparedDocumentCapability): string {
    return this.delegate.getRequestId(capability);
  }

  dispose(): void {
    this.delegate.dispose();
    this.disposed = true;
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
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

function createTestConversionDraft(options: {
  width: number;
  height: number;
  sourceWidth?: number;
  sourceHeight?: number;
  assetId?: string;
  mimeType?: string;
  requestId: string;
}): AcceptedConversionDraft {
  const document = createStarterDocument({ width: options.width, height: options.height });
  document.kind[0] = CellKind.Full;
  document.colors[0] = 1;
  const totalPixels = options.width * options.height;
  const sourceWidth = options.sourceWidth ?? options.width;
  const sourceHeight = options.sourceHeight ?? options.height;
  return acceptConversionDraft({
    token: { projectId: 'conversion', baseRevision: 0, requestId: options.requestId },
    document,
    stats: {
      sourceWidth,
      sourceHeight,
      targetWidth: options.width,
      targetHeight: options.height,
      totalPixels,
      transparentPixels: 0,
      emptyPixels: totalPixels - 1,
      stitchedPixels: 1,
      matchedColorCount: 1,
      paletteUsage: [{ paletteId: 1, catalogId: document.catalog.catalogId, count: 1 }]
    },
    sourceImage: {
      ...(options.assetId === undefined ? {} : { assetId: options.assetId }),
      ...(options.mimeType === undefined ? {} : { mimeType: options.mimeType }),
      width: sourceWidth,
      height: sourceHeight,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      chartBounds: { x: 0, y: 0, width: options.width, height: options.height },
      traceVisible: false,
      opacity: 1
    }
  });
}

describe('headless project workspace', () => {
  it('creates an accepted converted project atomically with an optional retained source asset', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'converted' });
    const draft = createTestConversionDraft({ width: 2, height: 2, assetId: 'source', mimeType: 'image/png', requestId: 'accepted' });
    try {
      const asset: ProjectAssetInput = { id: 'source', name: 'source.png', mimeType: 'image/png', data: pngBytes(2, 2) };
      const session = await workspace.createProjectFromConversion({ id: 'converted', title: 'Converted', draft, sourceImageAsset: asset });
      expect(session.document.kind.some((kind) => kind === CellKind.Full)).toBe(true);
      expect(repository.saveCalls).toEqual([{ id: 'converted', revision: 0 }]);
      const saved = repository.records.get('converted');
      expect(saved?.assets.map(({ id }) => id)).toEqual(['source']);
      expect(saved?.metadata.sourceImage).toMatchObject({ assetId: 'source', width: 2, height: 2, chartBounds: { width: 2, height: 2 }, traceVisible: false });
      expect(session.sourceImage?.traceVisible).toBe(false);
      session.applyTraceImageChange({ ...session.sourceImage!, traceVisible: true }, { label: 'trace-image-visibility' });
      expect(session.sourceImage?.traceVisible).toBe(true);
      await session.flush();
      expect((await repository.load('converted'))?.metadata.sourceImage?.traceVisible).toBe(true);
    } finally {
      await workspace.dispose();
    }
  });

  it('detaches the retained conversion source bytes before the create save', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'immutable-conversion' });
    const sourceBytes = pngBytes(2, 2);
    const draft = createTestConversionDraft({ width: 2, height: 2, assetId: 'source', mimeType: 'image/png', requestId: 'immutable' });
    try {
      const sourceAsset: ProjectAssetInput = { id: 'source', name: 'source.png', mimeType: 'image/png', data: sourceBytes };
      const creation = workspace.createProjectFromConversion({ id: 'immutable-conversion', draft, sourceImageAsset: sourceAsset });
      sourceBytes[0] = 0;
      await creation;
      expect(workspace.getAsset('source')?.data).toEqual(pngBytes(2, 2));
    } finally {
      await workspace.dispose();
    }
  });

  it('creates a converted project retaining a large source reference asset and decodes it in the working bound', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'large-converted' });
    const sourceBytes = pngBytes(8_000, 6_000);
    // The conversion draft reports the ORIGINAL (oversized) source dimensions;
    // the pre-scaled working raster is small because the decode path downscales.
    const draft = createTestConversionDraft({ width: 2, height: 2, sourceWidth: 8_000, sourceHeight: 6_000, assetId: 'source', mimeType: 'image/png', requestId: 'large' });
    try {
      const asset: ProjectAssetInput = { id: 'source', name: 'source.png', mimeType: 'image/png', data: sourceBytes };
      const session = await workspace.createProjectFromConversion({ id: 'large-converted', title: 'Large', draft, sourceImageAsset: asset });
      expect(session.document.kind.some((kind) => kind === CellKind.Full)).toBe(true);
      const saved = repository.records.get('large-converted');
      expect(saved?.metadata.sourceImage).toMatchObject({ assetId: 'source', width: 8_000, height: 6_000, chartBounds: { width: 2, height: 2 } });
      // The stored reference asset (original bytes) decodes in the editor and
      // is pre-scaled to the trace working bound.
      const stored = workspace.getAsset('source')?.data;
      expect(stored).toEqual(sourceBytes);
      const decoded = await decodeTraceImage(new Blob([new Uint8Array(stored ?? [])], { type: 'image/png' }), {
        createImageBitmap: async () => ({ width: 8_000, height: 6_000, close: vi.fn() }),
        surfaceFactory: (width: number, height: number) => ({ canvas: { width, height }, context: { drawImage: () => undefined, getImageData: () => ({ data: new Uint8ClampedArray(4) }) }, dispose: () => undefined })
      });
      expect(decoded.width * decoded.height).toBeLessThanOrEqual(16_000_000);
      expect(decoded.width / decoded.height).toBeCloseTo(8_000 / 6_000, 3);
      decoded.dispose?.();
    } finally {
      await workspace.dispose();
    }
  });

  it('does not create a project when the atomic converted-project save fails', async () => {
    const repository = new MemoryRepository();
    repository.failSaves = true;
    const workspace = new ProjectWorkspace({ repository, projectIdFactory: () => 'failed-conversion' });
    const draft = createTestConversionDraft({ width: 1, height: 1, requestId: 'failed' });
    try {
      await expect(workspace.createProjectFromConversion({ id: 'failed-conversion', draft })).rejects.toThrow('Test storage failure.');
      expect(repository.records.has('failed-conversion')).toBe(false);
      expect(repository.saveCalls).toHaveLength(0);
    } finally {
      await workspace.dispose();
    }
  });

  it('creates configurable blank projects with bounded dimensions and a black 310 starter palette', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'blank' });
    try {
      const defaults = createStarterDocument();
      expect(defaults.width).toBe(100);
      expect(defaults.height).toBe(100);
      expect(defaults.palette).toHaveLength(1);
      expect(defaults.palette[0]).toMatchObject({
        id: 1, name: 'Black', color: '#000000', active: true,
        catalog: { catalogId: 'dmc-compatible-screen-approximation', sourceId: 'dmc-310', code: '310', name: 'Black', hex: '#000000', rgb: [0, 0, 0] }
      });
      expect(defaults.palette[0].symbol).toBe(defaultPaletteSymbol(1));
      expect(defaults.palette[0].material.kind).toBe('floss');
      expect(defaults.nextPaletteId).toBe(2);

      const session = await workspace.createProject({ id: 'blank', title: 'My blank project', width: 3, height: 4 });
      expect(session.metadata.title).toBe('My blank project');
      expect(session.document.width).toBe(3);
      expect(session.document.height).toBe(4);
      expect(session.document.palette).toHaveLength(1);
      expect(session.document.palette[0]).toMatchObject({ id: 1, name: 'Black', color: '#000000' });
      expect(session.document.nextPaletteId).toBe(2);

      expect(() => createStarterDocument({ width: 0, height: 1 })).toThrow();
      expect(() => createStarterDocument({ width: 1.5, height: 1 })).toThrow();
      expect(() => createStarterDocument({ width: 1_000_001, height: 1 })).toThrow();
      expect(() => createStarterDocument({ width: 1_001, height: 1_000 })).toThrow();
    } finally {
      await workspace.dispose();
    }
  });

  it('seeds the default catalog association and Black 310 through the generic catalog APIs', () => {
    const document = createStarterDocument({ width: 2, height: 2 });
    const black = DEFAULT_CATALOG_DEFINITION.getByHex('#000000');
    expect(black).toBeDefined();
    expect(document.catalog).toEqual(DEFAULT_CATALOG_DEFINITION.association);
    expect(document.palette[0].catalog).toEqual(createCatalogReference(DEFAULT_CATALOG_DEFINITION, black!));
  });

  it('resolves exact catalog associations without blocking unavailable saved documents', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'unavailable' });
    const document = createStarterDocument({ width: 2, height: 2 });
    const unavailable = {
      ...document,
      catalog: { ...document.catalog, catalogId: 'uninstalled-revision' },
      palette: document.palette.map((entry) => entry.catalog === undefined
        ? entry
        : { ...entry, catalog: { ...entry.catalog, catalogId: 'uninstalled-revision' } })
    };
    repository.records.set('unavailable', {
      metadata: { id: 'unavailable', title: 'Unavailable catalog', notes: '', createdAt: 100, updatedAt: 100, revision: unavailable.revision },
      document: unavailable,
      recovery: null,
      assets: []
    });
    try {
      expect(workspace.catalogFor(null)).toBeUndefined();
      const resolvedDmc = workspace.catalogFor(document);
      expect(resolvedDmc).toMatchObject({ association: DEFAULT_CATALOG_DEFINITION.association });
      expect(resolvedDmc?.records).toEqual(DEFAULT_CATALOG_DEFINITION.records);
      expect(resolvedDmc).not.toBe(DEFAULT_CATALOG_DEFINITION);
      expect(resolvedDmc?.getByHex('#000000')?.code).toBe('310');
      expect(workspace.catalogFor({ ...document, catalog: { ...document.catalog, brandLabel: 'Other' } })).toBeUndefined();
      expect(workspace.catalogFor({ ...document, catalog: { ...document.catalog, colorCount: 1 } })).toBeUndefined();
      expect(workspace.catalogFor(unavailable)).toBeUndefined();
      const session = await workspace.openProject('unavailable');
      expect(session.document.catalog.catalogId).toBe('uninstalled-revision');
      expect(workspace.error).toBeNull();
    } finally {
      await workspace.dispose();
    }
  });

  it('exposes installed catalogs independently of the document primary catalog', async () => {
    const repository = new MemoryRepository();
    const catalogB = syntheticCatalogDefinition('catalog-b', 'Catalog B');
    const catalogRegistry = createInstalledCatalogRegistry([DEFAULT_CATALOG_DEFINITION, catalogB]);
    const workspace = new ProjectWorkspace({ repository, catalogRegistry });
    const primaryDmc = createStarterDocument({ width: 2, height: 2 });
    const unavailablePrimary: PatternDocument = {
      ...primaryDmc,
      catalog: { ...primaryDmc.catalog, catalogId: 'not-installed' }
    };

    try {
      const resolvedDmc = workspace.catalogFor(primaryDmc);
      expect(resolvedDmc).toMatchObject({ association: DEFAULT_CATALOG_DEFINITION.association });
      expect(resolvedDmc?.records).toEqual(DEFAULT_CATALOG_DEFINITION.records);
      expect(resolvedDmc).not.toBe(DEFAULT_CATALOG_DEFINITION);

      const availableCatalogs = workspace.availableCatalogs();
      expect(availableCatalogs.map((definition) => definition.association)).toEqual([DEFAULT_CATALOG_DEFINITION.association, catalogB.association]);
      expect(availableCatalogs.map((definition) => definition.records)).toEqual([DEFAULT_CATALOG_DEFINITION.records, catalogB.records]);
      expect(availableCatalogs[1]).not.toBe(catalogB);

      const resolvedCatalogB = workspace.catalogById('catalog-b');
      expect(resolvedCatalogB).toMatchObject({ association: catalogB.association, records: catalogB.records });
      expect(resolvedCatalogB).not.toBe(catalogB);
      expect(resolvedCatalogB).toBe(availableCatalogs[1]);
      const bRecord = catalogB.records[0];
      expect(resolvedCatalogB?.search('catalog b blue')).toEqual([bRecord]);
      expect(resolvedCatalogB?.getByHex('#123456')).toEqual(bRecord);
      expect(resolvedCatalogB?.records[0]).not.toBe(bRecord);
      expect(DEFAULT_CATALOG_DEFINITION.getByHex('#123456')).toBeUndefined();
      expect(createCatalogReference(catalogB, bRecord)).toMatchObject({ catalogId: 'catalog-b', sourceId: 'catalog-b-blue', hex: '#123456' });

      expect(workspace.catalogFor(unavailablePrimary)).toBeUndefined();
      const availableAfterUnavailablePrimary = workspace.availableCatalogs();
      expect(availableAfterUnavailablePrimary.map((definition) => definition.association)).toEqual([DEFAULT_CATALOG_DEFINITION.association, catalogB.association]);
      expect(availableAfterUnavailablePrimary.map((definition) => definition.records)).toEqual([DEFAULT_CATALOG_DEFINITION.records, catalogB.records]);
      expect(workspace.catalogById('catalog-b')).toMatchObject({ association: catalogB.association, records: catalogB.records });
      expect(workspace.catalogById('catalog-b')).not.toBe(catalogB);
    } finally {
      await workspace.dispose();
    }
  });

  it('does not save a DMC starter when the injected registry does not install DMC', async () => {
    const repository = new MemoryRepository();
    const catalogB = syntheticCatalogDefinition('catalog-b', 'Catalog B');
    const workspace = new ProjectWorkspace({ repository, catalogRegistry: createInstalledCatalogRegistry([catalogB]) });

    try {
      await expect(workspace.createProject({ id: 'missing-default-catalog' })).rejects.toThrow(/default catalog.*not installed|explicit document/i);
      expect(repository.saveCalls).toHaveLength(0);
      expect(repository.records.has('missing-default-catalog')).toBe(false);
    } finally {
      await workspace.dispose();
    }
  });

  it('creates a starter document with its default black palette that round-trips through persistence', () => {
    const starter = createStarterDocument();
    expect(starter.width).toBe(100);
    expect(starter.height).toBe(100);
    expect(starter.palette).toHaveLength(1);
    expect(starter.palette[0]).toMatchObject({ id: 1, name: 'Black', color: '#000000' });
    expect(starter.nextPaletteId).toBe(2);
    const decoded = decodeDocument(encodeDocument(starter));
    expect(decoded.palette).toEqual(starter.palette);
    expect(decoded.nextPaletteId).toBe(2);
    expect(decoded.width).toBe(100);
    expect(decoded.height).toBe(100);
  });

  it('creates and persists a starter project, then loads it', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'created-project' });
    try {
      const session = await workspace.createProject({ title: 'Created locally', width: 4, height: 4 });
      expect(session.projectId).toBe('created-project');
      expect(session.document.width).toBe(4);
      expect(repository.saveCalls).toHaveLength(1);
      expect((await repository.load('created-project'))?.metadata.title).toBe('Created locally');
      await workspace.openProject('created-project');
      expect(workspace.activeProjectId).toBe('created-project');
    } finally {
      await workspace.dispose();
    }
  });

  it('only debounces successful changed commands and flushes the pending save', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, debounceMs: 30, clock: { now: () => 100 }, projectIdFactory: () => 'debounced' });
    try {
      await workspace.createProject({ width: 4, height: 4, document: createDocument({ width: 4, height: 4, palette: [{ id: 1, name: 'Ruby', color: '#b44' }] }) });
      const initialSaves = repository.saveCalls.length;
      const noOp = workspace.execute({ type: 'erase-cell', x: 2, y: 2 });
      expect(noOp.changed).toBe(false);
      await wait(40);
      expect(repository.saveCalls).toHaveLength(initialSaves);

      const changed = workspace.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
      expect(changed.changed).toBe(true);
      await wait(5);
      expect(repository.saveCalls).toHaveLength(initialSaves);
      await workspace.flush();
      expect(repository.saveCalls).toHaveLength(initialSaves + 1);
      expect(repository.saveCalls.at(-1)?.revision).toBe(changed.document.revision);

      const same = workspace.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
      expect(same.changed).toBe(false);
      await wait(40);
      expect(repository.saveCalls).toHaveLength(initialSaves + 1);
    } finally {
      await workspace.dispose();
    }
  });

  it('does not autosave before the one-second trailing quiet deadline', async () => {
    vi.useFakeTimers();
    const repository = new ImmediateRepository();
    const workspace = new ProjectWorkspace({ repository: repository as unknown as WorkspaceRepository, clock: { now: () => 100 }, projectIdFactory: () => 'quiet-deadline' });
    try {
      const session = await workspace.createProject({ width: 4, height: 4, document: createDocument({ width: 4, height: 4, palette: [{ id: 1, name: 'Ruby', color: '#b44' }] }) });
      const initialSaves = repository.saveCalls.length;
      session.execute({ type: 'set-full', x: 0, y: 0, color: 1 });

      await vi.advanceTimersByTimeAsync(999);
      await settle();
      expect(repository.saveCalls).toHaveLength(initialSaves);

      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(repository.saveCalls).toHaveLength(initialSaves + 1);
    } finally {
      await workspace.dispose();
      vi.useRealTimers();
    }
  });

  it('coalesces an edit and undo burst into one latest-state save', async () => {
    vi.useFakeTimers();
    const repository = new ImmediateRepository();
    const workspace = new ProjectWorkspace({ repository: repository as unknown as WorkspaceRepository, clock: { now: () => 100 }, projectIdFactory: () => 'burst-save' });
    try {
      const session = await workspace.createProject({ width: 4, height: 4, document: createDocument({ width: 4, height: 4, palette: [{ id: 1, name: 'Ruby', color: '#b44' }] }) });
      const initialSaves = repository.saveCalls.length;
      session.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
      session.execute({ type: 'set-full', x: 1, y: 0, color: 1 });
      session.undo();

      await vi.advanceTimersByTimeAsync(1_000);
      await settle();
      expect(repository.saveCalls).toHaveLength(initialSaves + 1);
      expect(repository.saveCalls.at(-1)?.revision).toBe(session.document.revision);
    } finally {
      await workspace.dispose();
      vi.useRealTimers();
    }
  });

  it('checkpoints continuous changes at the five-second maximum dirty age', async () => {
    vi.useFakeTimers();
    const repository = new ImmediateRepository();
    const workspace = new ProjectWorkspace({ repository: repository as unknown as WorkspaceRepository, clock: { now: () => 100 }, projectIdFactory: () => 'max-dirty-age' });
    try {
      const session = await workspace.createProject({ width: 4, height: 4, document: createDocument({ width: 4, height: 4, palette: [{ id: 1, name: 'Ruby', color: '#b44' }] }) });
      const initialSaves = repository.saveCalls.length;
      session.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
      for (let step = 1; step <= 5; step += 1) {
        await vi.advanceTimersByTimeAsync(900);
        session.execute({ type: 'set-full', x: step % 4, y: Math.floor(step / 4), color: 1 });
      }

      await vi.advanceTimersByTimeAsync(499);
      await settle();
      expect(repository.saveCalls).toHaveLength(initialSaves);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(repository.saveCalls).toHaveLength(initialSaves + 1);
      expect(repository.saveCalls.at(-1)?.revision).toBe(session.document.revision);
    } finally {
      await workspace.dispose();
      vi.useRealTimers();
    }
  });

  it('lets explicit flush bypass the autosave quiet period', async () => {
    vi.useFakeTimers();
    const repository = new ImmediateRepository();
    const workspace = new ProjectWorkspace({ repository: repository as unknown as WorkspaceRepository, clock: { now: () => 100 }, projectIdFactory: () => 'flush-bypass' });
    try {
      const session = await workspace.createProject({ width: 4, height: 4, document: createDocument({ width: 4, height: 4, palette: [{ id: 1, name: 'Ruby', color: '#b44' }] }) });
      const initialSaves = repository.saveCalls.length;
      session.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
      await session.flush();
      expect(repository.saveCalls).toHaveLength(initialSaves + 1);
    } finally {
      await workspace.dispose();
      vi.useRealTimers();
    }
  });

  it('queues exactly one ordered latest-state follow-up for a change during an active save', async () => {
    vi.useFakeTimers();
    const repository = new ImmediateRepository();
    const workspace = new ProjectWorkspace({ repository: repository as unknown as WorkspaceRepository, debounceMs: 1_000, clock: { now: () => 100 }, projectIdFactory: () => 'active-follow-up' });
    let releaseSave!: () => void;
    let saveEntered!: () => void;
    const saveStarted = new Promise<void>((resolve) => { saveEntered = resolve; });
    const saveRelease = new Promise<void>((resolve) => { releaseSave = resolve; });
    try {
      const session = await workspace.createProject({ width: 4, height: 4, document: createDocument({ width: 4, height: 4, palette: [{ id: 1, name: 'Ruby', color: '#b44' }] }) });
      const initialSaves = repository.saveCalls.length;
      repository.beforeSave = async () => {
        repository.beforeSave = undefined;
        saveEntered();
        await saveRelease;
      };
      session.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
      await vi.advanceTimersByTimeAsync(1_000);
      await saveStarted;

      session.execute({ type: 'set-full', x: 1, y: 0, color: 1 });
      releaseSave();
      await settle();
      expect(repository.saveCalls).toHaveLength(initialSaves + 1);

      await vi.advanceTimersByTimeAsync(999);
      await settle();
      expect(repository.saveCalls).toHaveLength(initialSaves + 1);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(repository.saveCalls).toHaveLength(initialSaves + 2);
      expect(repository.saveCalls.slice(initialSaves).map(({ revision }) => revision)).toEqual([1, 2]);
    } finally {
      repository.beforeSave = undefined;
      releaseSave?.();
      await workspace.dispose();
      vi.useRealTimers();
    }
  });

  it('updates active metadata through the workspace and persists it when flushed', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, debounceMs: 30, clock: { now: () => 100 }, projectIdFactory: () => 'metadata' });
    const notifications: string[] = [];
    try {
      await workspace.createProject({ title: 'Before', notes: 'old' });
      workspace.subscribe(() => notifications.push(workspace.metadata?.title ?? ''));

      await workspace.updateActiveMetadata({ title: 'After', notes: 'new' });
      await workspace.flush();
      expect(workspace.metadata).toMatchObject({ title: 'After', notes: 'new' });
      expect(workspace.saveState.metadataDirty).toBe(false);
      expect(notifications.length).toBeGreaterThan(0);

      expect((await repository.load('metadata'))?.metadata).toMatchObject({ title: 'After', notes: 'new' });

      await workspace.updateActiveMetadata({ aidaCount: 16 });
      await workspace.flush();
      expect(workspace.metadata?.aidaCount).toBe(16);
      expect((await repository.load('metadata'))?.metadata.aidaCount).toBe(16);
      await workspace.updateActiveMetadata({ aidaCount: null });
      await workspace.flush();
      expect(workspace.metadata?.aidaCount).toBeUndefined();

      expect(workspace.metadata?.units).toBeUndefined();
      await workspace.updateActiveMetadata({ units: 'imperial' });
      await workspace.flush();
      expect(workspace.metadata?.units).toBe('imperial');
      expect((await repository.load('metadata'))?.metadata.units).toBe('imperial');
      await workspace.updateActiveMetadata({ units: null });
      await workspace.flush();
      expect(workspace.metadata?.units).toBeUndefined();
      expect((await repository.load('metadata'))?.metadata.units).toBeUndefined();
    } finally {
      await workspace.dispose();
    }
  });

  it('uses retain for same-revision session saves without preparing the document', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, debounceMs: 0, clock: { now: () => 100 }, projectIdFactory: () => 'save-modes' });
    try {
      const session = await workspace.createProject({
        id: 'save-modes',
        width: 2,
        height: 2,
        document: createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] })
      });
      session.updateMetadata({ title: 'Retained' });
      await session.flush();
      expect(repository.saveModes.at(-1)).toBe('retain');
      expect(repository.saveDocuments.at(-1)).toBe(session.document);

      session.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
      await session.flush();
      expect(repository.saveModes.at(-1)).toBe('replace');
      expect(repository.saveDocuments.at(-1)).not.toBe(session.document);
    } finally {
      await workspace.dispose();
    }
  });

  it('prepares each replace revision once and never prepares a retain save', async () => {
    const repository = new MemoryRepository();
    const preparation = new FakePreparationClient();
    const workspace = new ProjectWorkspace({ repository, preparationClient: preparation, debounceMs: 0, clock: { now: () => 100 }, projectIdFactory: () => 'prepared-session' });
    try {
      const session = await workspace.createProject({
        id: 'prepared-session',
        width: 2,
        height: 2,
        document: createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] })
      });
      session.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
      await session.flush();
      expect(preparation.requests).toHaveLength(1);
      expect(preparation.requests[0].document).toBe(session.document);
      expect(repository.preparedSaveCalls).toHaveLength(1);

      session.updateMetadata({ title: 'Retained metadata' });
      await session.flush();
      expect(preparation.requests).toHaveLength(1);
      expect(repository.preparedSaveCalls).toHaveLength(1);
      expect(repository.saveDocuments.at(-1)).toBe(session.document);

      session.execute({ type: 'set-full', x: 1, y: 1, color: 1 });
      await session.flush();
      expect(preparation.requests).toHaveLength(2);
      expect(repository.preparedSaveCalls).toHaveLength(2);
    } finally {
      await workspace.dispose();
      expect(preparation.disposed).toBe(true);
    }
  });

  it('passes one detached replacement snapshot to a legacy repository while keeping the editor live', async () => {
    let received: PatternDocument | undefined;
    const save = vi.fn(async (_projectId: string, _metadata: ProjectMetadata, next: PatternDocument): Promise<SaveResult> => {
      received = next;
      return { committed: true, stale: false, revision: next.revision };
    });
    const repository = { save } as unknown as WorkspaceRepository;
    const preparation = new FakePreparationClient();
    const document = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    const session = new ProjectSession({
      repository,
      metadata: { id: 'legacy-session', title: 'Legacy', notes: '', createdAt: 1, updatedAt: 1, revision: document.revision },
      document,
      preparationClient: preparation,
      clock: { now: () => 100 },
      debounceMs: 0
    });

    try {
      session.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
      await session.flush();
      if (!received) throw new Error('legacy repository did not receive a document');
      const persistedSnapshot = received;
      expect(preparation.requests).toHaveLength(0);
      expect(persistedSnapshot).not.toBe(session.document);
      expect(persistedSnapshot.revision).toBe(session.document.revision);

      session.execute({ type: 'set-full', x: 1, y: 1, color: 1 });
      expect(session.document.revision).toBeGreaterThan(persistedSnapshot.revision);
      expect(persistedSnapshot.revision).toBe(1);
    } finally {
      await session.dispose();
      preparation.dispose();
    }
  });

  it('rejects a same-revision session retain after the durable head changes', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, debounceMs: 0, clock: { now: () => 100 }, projectIdFactory: () => 'head-race' });
    try {
      const session = await workspace.createProject({
        id: 'head-race',
        width: 1,
        height: 1,
        document: createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] })
      });
      const replacement = createDocument({ width: 2, height: 1, palette: [{ id: 1, name: 'Blue', color: '#36c' }] });
      await repository.save('head-race', { id: 'head-race', title: 'External', notes: '', createdAt: 100, updatedAt: 100, revision: replacement.revision }, replacement, undefined, { allowSameRevision: true });

      session.updateMetadata({ title: 'Must reject' });
      await expect(session.flush()).rejects.toMatchObject({ code: 'save-conflict' });
      expect(repository.saveModes.at(-1)).toBe('retain');
      expect(repository.records.get('head-race')?.metadata.title).toBe('External');
    } finally {
      await workspace.dispose().catch(() => undefined);
    }
  });

  it('reads and persists calibrated material assumptions without changing document revision', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'material-settings' });
    try {
      const session = await workspace.createProject({ width: 1, height: 1, document: createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Ruby', color: '#b44' }] }) });
      session.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
      const designRevision = session.document.revision;
      expect(session.metadata.aidaCount).toBe(14);
      expect(session.materialSettings).toEqual({ strands: 2, waste: 0 });
      expect(session.metrics.palettes[0].material.estimatedMeters).toBeCloseTo(0.04064);

      await workspace.updateActiveMaterialSettings({ strands: 2, waste: 0.1, stitchLengthMeters: 0.1, skeinLengthMeters: 8 });
      await workspace.flush();
      expect(workspace.materialSettings).toEqual({ strands: 2, waste: 0.1, stitchLengthMeters: 0.1, skeinLengthMeters: 8 });
      expect(workspace.document?.revision).toBe(designRevision);
      expect(workspace.metrics?.palettes[0].material.requiredSkeins).toBe(1);

      await workspace.updateMaterialAssumptions({ stitchLengthMeters: null });
      await workspace.flush();
      expect(workspace.materialSettings?.stitchLengthMeters).toBeUndefined();
      expect(workspace.metrics?.palettes[0].material.estimatedMeters).toBeCloseTo(0.04064);
      expect((await repository.load('material-settings'))?.metadata.materialSettings).toEqual({ strands: 2, waste: 0.1, skeinLengthMeters: 8 });

      await workspace.openProject('material-settings');
      expect(workspace.materialSettings).toEqual({ strands: 2, waste: 0.1, skeinLengthMeters: 8 });
      expect(workspace.metrics?.palettes[0].material.requiredSkeins).toBe(1);
    } finally {
      await workspace.dispose();
    }
  });

  it('preserves every material calibration field through Save As Copy', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'material-copy' });
    try {
      await workspace.createProject({ id: 'material-source', width: 1, height: 1 });
      const settings = { strands: 3, waste: 0.18, stitchLengthMeters: 0.125, skeinLengthMeters: 8.4 };
      await workspace.updateActiveMaterialSettings(settings);
      await workspace.flush();

      const copy = await workspace.saveAsCopy({ id: 'material-copy' });
      expect(copy.materialSettings).toEqual(settings);
      expect((await repository.load('material-copy'))?.metadata.materialSettings).toEqual(settings);
    } finally {
      await workspace.dispose();
    }
  });

  it('uses the current Aida default when a copied project has no count', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'aida-copy' });
    const document = createStarterDocument({ width: 1, height: 1 });
    repository.records.set('unknown-aida', {
      metadata: { id: 'unknown-aida', title: 'Older project', notes: '', createdAt: 1, updatedAt: 1, revision: document.revision },
      document: cloneDocument(document),
      recovery: null,
      assets: []
    });
    try {
      await workspace.openProject('unknown-aida');
      expect(workspace.metadata?.aidaCount).toBeUndefined();
      const copy = await workspace.saveAsCopy({ id: 'aida-copy' });
      expect(copy.metadata.aidaCount).toBe(14);
      expect((await repository.load('aida-copy'))?.metadata.aidaCount).toBe(14);
    } finally {
      await workspace.dispose();
    }
  });

  it('atomically sets, persists, clears, and explicitly retrieves a source image asset', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'source-image' });
    try {
      await workspace.createProject({ id: 'source-image', width: 4, height: 3, assets: [{ id: 'reference', name: 'reference.png', mimeType: 'image/png', data: pngBytes(2, 3) }] });
      const descriptor = {
        assetId: 'reference',
        mimeType: 'image/png' as const,
        width: 2,
        height: 3,
        crop: { x: 0.1, y: 0.2, width: 0.8, height: 0.7 },
        chartBounds: { x: 1, y: 0, width: 3, height: 3 },
        traceVisible: false,
        opacity: 0.4
      };
      await workspace.setSourceImage(descriptor);
      await workspace.flush();
      expect(workspace.sourceImage).toEqual(descriptor);
      expect(workspace.getAsset('reference')?.data).toEqual(pngBytes(2, 3));
      expect((await repository.load('source-image'))?.metadata.sourceImage).toEqual(descriptor);

      const copy = await workspace.saveAsCopy({ id: 'source-image-copy' });
      expect(copy.sourceImage).toEqual(descriptor);
      expect(copy.getAsset('reference')?.data).toEqual(pngBytes(2, 3));
      await workspace.openProject('source-image');

      await expect(workspace.setSourceImage({ ...descriptor, assetId: 'missing' })).rejects.toMatchObject({ code: 'invalid-asset' });
      expect(workspace.sourceImage).toEqual(descriptor);
      await expect(workspace.setSourceImage({ ...descriptor, opacity: 1.1 })).rejects.toMatchObject({ code: 'invalid-metadata' });
      await expect(workspace.setSourceImage({ ...descriptor, crop: { x: 0.5, y: 0, width: 0.6, height: 1 } })).rejects.toMatchObject({ code: 'invalid-metadata' });
      expect(workspace.sourceImage).toEqual(descriptor);
      await workspace.clearSourceImage();
      expect(workspace.sourceImage).toBeUndefined();
      expect((await repository.load('source-image'))?.metadata.sourceImage).toBeUndefined();
      expect((await repository.load('source-image'))?.assets).toHaveLength(0);
    } finally {
      await workspace.dispose();
    }
  });

  it('removes the source descriptor and asset atomically', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'source-remove' });
    const bytes = pngBytes(2, 2);
    const descriptor = {
      assetId: 'reference', mimeType: 'image/png' as const, width: 2, height: 2,
      crop: { x: 0, y: 0, width: 1, height: 1 }, chartBounds: { x: 0, y: 0, width: 2, height: 2 }, traceVisible: true, opacity: 1
    };
    try {
      await workspace.createProject({ id: 'source-remove', width: 2, height: 2, assets: [{ id: 'reference', name: 'reference.png', mimeType: 'image/png', data: bytes }] });
      await workspace.setSourceImage(descriptor);
      await workspace.flush();
      repository.failSaves = true;
      await expect(workspace.removeSourceImage()).rejects.toMatchObject({ code: 'storage-failure' });
      expect(workspace.sourceImage).toEqual(descriptor);
      expect(workspace.getAsset('reference')?.data).toEqual(bytes);
      repository.failSaves = false;
      await workspace.removeSourceImage();
      expect(workspace.sourceImage).toBeUndefined();
      expect(workspace.getAsset('reference')).toBeUndefined();
      expect((await repository.load('source-remove'))?.assets).toHaveLength(0);
    } finally {
      repository.failSaves = false;
      await workspace.dispose();
    }
  });

  it('replaces source images as one atomic asset-and-descriptor commit', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'source-replace' });
    const oldBytes = pngBytes(2, 2);
    const newBytes = pngBytes(3, 2);
    const oldDescriptor = {
      assetId: 'old-reference', mimeType: 'image/png' as const, width: 2, height: 2,
      crop: { x: 0, y: 0, width: 1, height: 1 }, chartBounds: { x: 0, y: 0, width: 4, height: 3 }, traceVisible: true, opacity: 0.8
    };
    const newDescriptor = { ...oldDescriptor, assetId: 'new-reference', width: 3, height: 2, opacity: 0.5 };
    try {
      await workspace.createProject({ id: 'source-replace', width: 4, height: 3, assets: [{ id: 'old-reference', name: 'old.png', mimeType: 'image/png', data: oldBytes }] });
      await workspace.setSourceImage(oldDescriptor);
      await workspace.flush();

      await expect(workspace.replaceSourceImage({ asset: { id: 'bad-reference', name: 'bad.png', mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) }, settings: { ...newDescriptor, assetId: 'bad-reference' } })).rejects.toMatchObject({ code: 'invalid-asset' });
      expect(workspace.sourceImage).toEqual(oldDescriptor);
      expect(workspace.getAsset('old-reference')?.data).toEqual(oldBytes);

      repository.failSaves = true;
      await expect(workspace.replaceSourceImage({ asset: { id: 'new-reference', name: 'new.png', mimeType: 'image/png', data: newBytes }, settings: newDescriptor })).rejects.toMatchObject({ code: 'storage-failure' });
      expect(workspace.sourceImage).toEqual(oldDescriptor);
      expect(workspace.getAsset('old-reference')?.data).toEqual(oldBytes);
      expect(workspace.getAsset('new-reference')).toBeUndefined();
      repository.failSaves = false;

      await workspace.replaceSourceImage({ asset: { id: 'new-reference', name: 'new.png', mimeType: 'image/png', data: newBytes }, settings: newDescriptor });
      expect(workspace.sourceImage).toEqual(newDescriptor);
      expect(workspace.getAsset('old-reference')).toBeUndefined();
      expect(workspace.getAsset('new-reference')?.data).toEqual(newBytes);
      expect((await repository.load('source-replace'))?.metadata.sourceImage).toEqual(newDescriptor);
    } finally {
      repository.failSaves = false;
      await workspace.dispose();
    }
  });

  it('serializes replacement with concurrent document and metadata autosaves', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, debounceMs: 0, clock: { now: () => 100 }, projectIdFactory: () => 'source-interleave' });
    const oldBytes = pngBytes(2, 2);
    const newBytes = pngBytes(3, 2);
    const oldDescriptor = {
      assetId: 'old-reference', mimeType: 'image/png' as const, width: 2, height: 2,
      crop: { x: 0, y: 0, width: 1, height: 1 }, chartBounds: { x: 0, y: 0, width: 4, height: 3 }, traceVisible: true, opacity: 0.8
    };
    const newDescriptor = { ...oldDescriptor, assetId: 'new-reference', width: 3, height: 2, opacity: 0.5 };
    let releaseSave!: () => void;
    let saveEntered!: () => void;
    const saveStarted = new Promise<void>((resolve) => { saveEntered = resolve; });
    const saveRelease = new Promise<void>((resolve) => { releaseSave = resolve; });
    try {
      await workspace.createProject({ id: 'source-interleave', width: 4, height: 3, document: createDocument({ width: 4, height: 3, palette: [{ id: 1, name: 'Ruby', color: '#b44' }] }), assets: [{ id: 'old-reference', name: 'old.png', mimeType: 'image/png', data: oldBytes }] });
      await workspace.setSourceImage(oldDescriptor);
      await workspace.flush();
      repository.beforeSave = async () => {
        repository.beforeSave = undefined;
        saveEntered();
        await saveRelease;
      };

      const replacement = workspace.replaceSourceImage({ asset: { id: 'new-reference', name: 'new.png', mimeType: 'image/png', data: newBytes }, settings: newDescriptor });
      await saveStarted;
      workspace.session?.execute({ type: 'set-full', x: 1, y: 1, color: 1 });
      workspace.session?.updateMetadata({ title: 'Changed while replacing' });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      releaseSave();
      await replacement;
      await workspace.flush();

      const loaded = await repository.load('source-interleave');
      expect(loaded?.metadata.title).toBe('Changed while replacing');
      expect(loaded?.metadata.sourceImage).toEqual(newDescriptor);
      expect(loaded?.document.revision).toBe(1);
      expect(loaded?.assets.map((asset) => asset.id)).toEqual(['new-reference']);
    } finally {
      repository.beforeSave = undefined;
      await workspace.dispose();
    }
  });

  it('keeps an autosave already in flight from overwriting a later replacement', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, debounceMs: 0, clock: { now: () => 100 }, projectIdFactory: () => 'source-before' });
    const oldBytes = pngBytes(2, 2);
    const newBytes = pngBytes(3, 2);
    const oldDescriptor = {
      assetId: 'old-reference', mimeType: 'image/png' as const, width: 2, height: 2,
      crop: { x: 0, y: 0, width: 1, height: 1 }, chartBounds: { x: 0, y: 0, width: 4, height: 3 }, traceVisible: true, opacity: 0.8
    };
    const newDescriptor = { ...oldDescriptor, assetId: 'new-reference', width: 3, height: 2, opacity: 0.5 };
    let releaseSave!: () => void;
    let saveEntered!: () => void;
    const saveStarted = new Promise<void>((resolve) => { saveEntered = resolve; });
    const saveRelease = new Promise<void>((resolve) => { releaseSave = resolve; });
    try {
      await workspace.createProject({ id: 'source-before', width: 4, height: 3, document: createDocument({ width: 4, height: 3, palette: [{ id: 1, name: 'Ruby', color: '#b44' }] }), assets: [{ id: 'old-reference', name: 'old.png', mimeType: 'image/png', data: oldBytes }] });
      await workspace.setSourceImage(oldDescriptor);
      await workspace.flush();
      repository.beforeSave = async () => {
        repository.beforeSave = undefined;
        saveEntered();
        await saveRelease;
      };
      workspace.session?.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
      await saveStarted;

      const replacement = workspace.replaceSourceImage({ asset: { id: 'new-reference', name: 'new.png', mimeType: 'image/png', data: newBytes }, settings: newDescriptor });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      workspace.session?.updateMetadata({ title: 'Changed after autosave started' });
      releaseSave();
      await replacement;
      await workspace.flush();

      const loaded = await repository.load('source-before');
      expect(loaded?.metadata.title).toBe('Changed after autosave started');
      expect(loaded?.metadata.sourceImage).toEqual(newDescriptor);
      expect(loaded?.document.kind[0]).toBe(1);
      expect(loaded?.assets.map((asset) => asset.id)).toEqual(['new-reference']);
    } finally {
      repository.beforeSave = undefined;
      await workspace.dispose();
    }
  });

  it('keeps failed metadata updates dirty so retry can complete the save', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, debounceMs: 30, clock: { now: () => 100 }, projectIdFactory: () => 'metadata-retry' });
    try {
      await workspace.createProject({ title: 'Before' });
      repository.failSaves = true;

      await workspace.updateActiveMetadata({ title: 'After' });
      await expect(workspace.flush()).rejects.toMatchObject({ code: 'storage-failure' });
      expect(workspace.metadata).toMatchObject({ title: 'After' });
      expect(workspace.saveState.metadataDirty).toBe(true);
      expect(workspace.saveState.status).toBe('error');

      repository.failSaves = false;
      await workspace.retrySave();
      expect(workspace.saveState.metadataDirty).toBe(false);
      expect(workspace.error).toBeNull();
      expect((await repository.load('metadata-retry'))?.metadata.title).toBe('After');
    } finally {
      repository.failSaves = false;
      await workspace.dispose();
    }
  });

  it('surfaces a local save failure without replacing the in-memory document', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, debounceMs: 0, clock: { now: () => 100 }, projectIdFactory: () => 'failure' });
    try {
      await workspace.createProject({ width: 4, height: 4, document: createDocument({ width: 4, height: 4, palette: [{ id: 1, name: 'Ruby', color: '#b44' }] }) });
      repository.failSaves = true;
      workspace.execute({ type: 'set-full', x: 1, y: 1, color: 1 });
      await expect(workspace.flush()).rejects.toMatchObject({ code: 'storage-failure' });
      expect(workspace.document?.kind[5]).toBe(CellKind.Full);
      expect(workspace.error).toMatchObject({ code: 'storage-failure' });
      expect(workspace.saveState.status).toBe('error');
    } finally {
      repository.failSaves = false;
      await workspace.dispose().catch(() => undefined);
    }
  });

  it('exports and imports the active project only after archive validation', async () => {
    const sourceRepository = new MemoryRepository();
    const source = new ProjectWorkspace({ repository: sourceRepository, clock: { now: () => 100 }, projectIdFactory: () => 'source' });
    const targetRepository = new MemoryRepository();
    const target = new ProjectWorkspace({ repository: targetRepository, clock: { now: () => 200 }, projectIdFactory: () => 'target' });
    try {
      await source.createProject({ width: 4, height: 4, document: createDocument({ width: 4, height: 4, palette: [{ id: 1, name: 'Ruby', color: '#b44' }] }), assets: [{ id: 'reference', name: 'reference.bin', mimeType: 'application/octet-stream', data: new Uint8Array([4, 5, 6]) }] });
      source.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
      const archive = await source.exportActiveProject();
      await target.importProject(archive);
      expect(target.activeProjectId).toBe('source');
      expect(target.document?.kind[0]).toBe(CellKind.Full);
      expect(target.session?.assets[0].data).toEqual(new Uint8Array([4, 5, 6]));
      await expect(target.importProject(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({ code: 'invalid-archive' });
      expect(target.activeProjectId).toBe('source');
    } finally {
      await source.dispose();
      await target.dispose();
    }
  });

  it('selects an explicit known project and otherwise uses the newest valid candidate', async () => {
    const repository = new MemoryRepository();
    let id = 0;
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => ++id }, projectIdFactory: () => `project-${String(id)}` });
    try {
      await workspace.createProject({ id: 'older' });
      await workspace.createProject({ id: 'newer' });
      await workspace.selectProject('older');
      expect(workspace.activeProjectId).toBe('older');
      await workspace.selectProject();
      expect(workspace.activeProjectId).toBe('newer');
    } finally {
      await workspace.dispose();
    }
  });

  it('deletes a project record, closing it first when it is the active session', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, projectIdFactory: () => 'target' });
    try {
      await workspace.createProject({ id: 'target' });
      expect(workspace.activeProjectId).toBe('target');
      let notified = 0;
      workspace.subscribe(() => { notified += 1; });
      await workspace.deleteProject('target');
      // The active session was detached and the workspace returned to the
      // empty state with the record gone.
      expect(workspace.activeProjectId).toBeNull();
      expect(workspace.session).toBeNull();
      expect(repository.records.has('target')).toBe(false);
      expect(notified).toBeGreaterThan(0);
    } finally {
      await workspace.dispose();
    }
  });

  it('deletes a non-active project without touching the active session', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, projectIdFactory: () => 'other' });
    try {
      await workspace.createProject({ id: 'other' });
      await workspace.createProject({ id: 'keeper' });
      await workspace.selectProject('other');
      await workspace.deleteProject('keeper');
      expect(repository.records.has('keeper')).toBe(false);
      expect(workspace.activeProjectId).toBe('other');
      expect(repository.records.has('other')).toBe(true);
    } finally {
      await workspace.dispose();
    }
  });

  it('treats deleting an unknown project id as a safe no-op', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, projectIdFactory: () => 'known' });
    try {
      await workspace.createProject({ id: 'known' });
      await workspace.deleteProject('missing');
      expect(workspace.activeProjectId).toBe('known');
      expect(repository.records.has('known')).toBe(true);
      await expect(workspace.deleteProject('missing')).resolves.toBeUndefined();
    } finally {
      await workspace.dispose();
    }
  });
});
