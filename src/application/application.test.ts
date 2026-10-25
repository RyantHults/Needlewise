import { describe, expect, it, vi } from 'vitest';
import {
  CellKind,
  createDocument as createDomainDocument,
  defaultPaletteSymbol,
  flattenDocument,
  layeredFromSurface,
  LayerType,
  type PatternDocument
} from '../domain';
import {
  PersistencePreparationWorkerClient,
  type ProjectAssetInput,
  type ProjectThumbnailSummary,
  type PreparedDocumentCapability,
  type PersistencePreparationInput,
  type PersistencePreparationClient
} from '../persistence';
import { createStarterDocument, paletteProgress, ProjectWorkspace } from './index';
import { MAX_MARK_HISTORY_STEPS } from './session';
import { MemoryRepository } from './test-support';
import { cell } from '../domain/test-fixtures';
import type { WorkspaceRepository } from './types';
import { acceptConversionDraft, type AcceptedConversionDraft } from '../conversion/image-to-pattern';
import { decodeTraceImage } from '../rendering/trace';
import { DEFAULT_CATALOG_DEFINITION, createCatalogReference } from '../catalog';

function createDocument(options: Omit<Parameters<typeof createDomainDocument>[0], 'catalog'>): PatternDocument {
  return createDomainDocument({ ...options, catalog: DEFAULT_CATALOG_DEFINITION.association });
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

// Captured before fake timers replace them: saves hash and prepare on the real event loop.
const nextMacrotask = setImmediate;
const realSetTimeout = setTimeout;

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => nextMacrotask(resolve));
}

async function savesReach(repository: MemoryRepository, count: number): Promise<void> {
  for (let attempt = 0; attempt < 400 && repository.saveCalls.length < count; attempt += 1) await new Promise<void>((resolve) => realSetTimeout(resolve, 5));
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

  it('applies a requested background color to a converted draft before persistence', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'converted-background' });
    const draft = createTestConversionDraft({ width: 2, height: 2, requestId: 'converted-background' });
    try {
      const session = await workspace.createProjectFromConversion({
        id: 'converted-background',
        draft,
        settings: { backgroundColor: '#aabbcc' }
      });

      expect(session.document.settings.backgroundColor).toBe('#AABBCC');
      expect(repository.saveDocuments[0]?.settings.backgroundColor).toBe('#AABBCC');
      expect(repository.records.get('converted-background')?.document.settings.backgroundColor).toBe('#AABBCC');
      expect(draft.document.settings.backgroundColor).toBe('#F3EEE5');
    } finally {
      await workspace.dispose();
    }
  });

  it('leaves a fully supplied document authoritative when project settings are omitted from the document', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'supplied-background' });
    const supplied = createDocument({ width: 1, height: 1, palette: [], settings: { backgroundColor: '#123456' } });
    try {
      const session = await workspace.createProject({
        id: 'supplied-background',
        document: supplied,
        settings: { backgroundColor: '#aabbcc' }
      });

      expect(session.document.settings.backgroundColor).toBe('#123456');
      expect(repository.records.get('supplied-background')?.document.settings.backgroundColor).toBe('#123456');
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

  it('persists the requested background color for a blank starter project', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'blank-background' });
    try {
      const session = await workspace.createProject({
        id: 'blank-background',
        width: 2,
        height: 2,
        settings: { backgroundColor: '#abcdef' }
      });

      expect(session.document.settings.backgroundColor).toBe('#ABCDEF');
      expect(repository.saveDocuments[0]?.settings.backgroundColor).toBe('#ABCDEF');
      expect(repository.records.get('blank-background')?.document.settings.backgroundColor).toBe('#ABCDEF');
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
    const document = layeredFromSurface(createStarterDocument({ width: 2, height: 2 }));
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

  it('only debounces successful changed commands and flushes the pending save', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, debounceMs: 30, clock: { now: () => 100 }, projectIdFactory: () => 'debounced' });
    try {
      await workspace.createProject({ width: 4, height: 4, document: createDocument({ width: 4, height: 4, palette: [{ id: 1, name: 'Ruby', color: '#b44' }] }) });
      const initialSaves = repository.saveCalls.length;
      const noOp = workspace.execute(cell(workspace.document!, { type: 'erase-cell', x: 2, y: 2 }));
      expect(noOp.changed).toBe(false);
      await wait(40);
      expect(repository.saveCalls).toHaveLength(initialSaves);

      const changed = workspace.execute(cell(workspace.document!, { type: 'set-full', x: 0, y: 0, color: 1 }));
      expect(changed.changed).toBe(true);
      await wait(5);
      expect(repository.saveCalls).toHaveLength(initialSaves);
      await workspace.flush();
      expect(repository.saveCalls).toHaveLength(initialSaves + 1);
      expect(repository.saveCalls.at(-1)?.revision).toBe(changed.document.revision);

      const same = workspace.execute(cell(workspace.document!, { type: 'set-full', x: 0, y: 0, color: 1 }));
      expect(same.changed).toBe(false);
      await wait(40);
      expect(repository.saveCalls).toHaveLength(initialSaves + 1);
    } finally {
      await workspace.dispose();
    }
  });

  it('does not autosave before the one-second trailing quiet deadline', async () => {
    vi.useFakeTimers();
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'quiet-deadline' });
    try {
      const session = await workspace.createProject({ width: 4, height: 4, document: createDocument({ width: 4, height: 4, palette: [{ id: 1, name: 'Ruby', color: '#b44' }] }) });
      const initialSaves = repository.saveCalls.length;
      session.execute(cell(session.document, { type: 'set-full', x: 0, y: 0, color: 1 }));

      await vi.advanceTimersByTimeAsync(999);
      await settle();
      expect(repository.saveCalls).toHaveLength(initialSaves);

      await vi.advanceTimersByTimeAsync(1);
      await savesReach(repository, initialSaves + 1);
      expect(repository.saveCalls).toHaveLength(initialSaves + 1);
    } finally {
      await workspace.dispose();
      vi.useRealTimers();
    }
  });

  it('coalesces an edit and undo burst into one latest-state save', async () => {
    vi.useFakeTimers();
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'burst-save' });
    try {
      const session = await workspace.createProject({ width: 4, height: 4, document: createDocument({ width: 4, height: 4, palette: [{ id: 1, name: 'Ruby', color: '#b44' }] }) });
      const initialSaves = repository.saveCalls.length;
      session.execute(cell(session.document, { type: 'set-full', x: 0, y: 0, color: 1 }));
      session.execute(cell(session.document, { type: 'set-full', x: 1, y: 0, color: 1 }));
      session.undo();

      await vi.advanceTimersByTimeAsync(1_000);
      await savesReach(repository, initialSaves + 1);
      expect(repository.saveCalls).toHaveLength(initialSaves + 1);
      expect(repository.saveCalls.at(-1)?.revision).toBe(session.document.revision);
    } finally {
      await workspace.dispose();
      vi.useRealTimers();
    }
  });

  it('checkpoints continuous changes at the five-second maximum dirty age', async () => {
    vi.useFakeTimers();
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'max-dirty-age' });
    try {
      const session = await workspace.createProject({ width: 4, height: 4, document: createDocument({ width: 4, height: 4, palette: [{ id: 1, name: 'Ruby', color: '#b44' }] }) });
      const initialSaves = repository.saveCalls.length;
      session.execute(cell(session.document, { type: 'set-full', x: 0, y: 0, color: 1 }));
      for (let step = 1; step <= 5; step += 1) {
        await vi.advanceTimersByTimeAsync(900);
        session.execute(cell(session.document, { type: 'set-full', x: step % 4, y: Math.floor(step / 4), color: 1 }));
      }

      await vi.advanceTimersByTimeAsync(499);
      await settle();
      expect(repository.saveCalls).toHaveLength(initialSaves);
      await vi.advanceTimersByTimeAsync(1);
      await savesReach(repository, initialSaves + 1);
      expect(repository.saveCalls).toHaveLength(initialSaves + 1);
      expect(repository.saveCalls.at(-1)?.revision).toBe(session.document.revision);
    } finally {
      await workspace.dispose();
      vi.useRealTimers();
    }
  });

  it('lets explicit flush bypass the autosave quiet period', async () => {
    vi.useFakeTimers();
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'flush-bypass' });
    try {
      const session = await workspace.createProject({ width: 4, height: 4, document: createDocument({ width: 4, height: 4, palette: [{ id: 1, name: 'Ruby', color: '#b44' }] }) });
      const initialSaves = repository.saveCalls.length;
      session.execute(cell(session.document, { type: 'set-full', x: 0, y: 0, color: 1 }));
      await session.flush();
      expect(repository.saveCalls).toHaveLength(initialSaves + 1);
    } finally {
      await workspace.dispose();
      vi.useRealTimers();
    }
  });

  it('queues exactly one ordered latest-state follow-up for a change during an active save', async () => {
    vi.useFakeTimers();
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, debounceMs: 1_000, clock: { now: () => 100 }, projectIdFactory: () => 'active-follow-up' });
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
      session.execute(cell(session.document, { type: 'set-full', x: 0, y: 0, color: 1 }));
      await vi.advanceTimersByTimeAsync(1_000);
      await saveStarted;

      session.execute(cell(session.document, { type: 'set-full', x: 1, y: 0, color: 1 }));
      releaseSave();
      await savesReach(repository, initialSaves + 1);
      expect(repository.saveCalls).toHaveLength(initialSaves + 1);

      await vi.advanceTimersByTimeAsync(999);
      await settle();
      expect(repository.saveCalls).toHaveLength(initialSaves + 1);
      await vi.advanceTimersByTimeAsync(1);
      await savesReach(repository, initialSaves + 2);
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
      session.execute(cell(session.document, { type: 'set-full', x: 0, y: 0, color: 1 }));
      await session.flush();
      expect(preparation.requests).toHaveLength(1);
      expect(repository.preparedSaveCalls).toHaveLength(1);

      session.updateMetadata({ title: 'Retained metadata' });
      await session.flush();
      expect(preparation.requests).toHaveLength(1);
      expect(repository.preparedSaveCalls).toHaveLength(1);

      session.execute(cell(session.document, { type: 'set-full', x: 1, y: 1, color: 1 }));
      await session.flush();
      expect(preparation.requests).toHaveLength(2);
      expect(repository.preparedSaveCalls).toHaveLength(2);
    } finally {
      await workspace.dispose();
      expect(preparation.disposed).toBe(true);
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
      await repository.save('head-race', { id: 'head-race', title: 'External', notes: '', createdAt: 100, updatedAt: 100, revision: replacement.revision }, layeredFromSurface(replacement), undefined, { allowSameRevision: true });

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
      session.execute(cell(session.document, { type: 'set-full', x: 0, y: 0, color: 1 }));
      const designRevision = session.document.revision;
      expect(session.document.settings.aidaCount).toBe(14);
      expect(session.materialSettings).toEqual({ strands: 2, backstitchStrands: 1, waste: 0 });
      expect(session.metrics.palettes[0].material.estimatedMeters).toBeCloseTo(0.04064);

      await workspace.updateActiveMaterialSettings({ strands: 2, backstitchStrands: 2, waste: 0.1, stitchLengthMeters: 0.1, skeinLengthMeters: 8 });
      await workspace.flush();
      expect(workspace.materialSettings).toEqual({ strands: 2, backstitchStrands: 2, waste: 0.1, stitchLengthMeters: 0.1, skeinLengthMeters: 8 });
      expect(workspace.document?.revision).toBe(designRevision);
      expect(workspace.metrics?.palettes[0].material.requiredSkeins).toBe(1);

      await workspace.updateActiveMaterialSettings({ stitchLengthMeters: null });
      await workspace.flush();
      expect(workspace.materialSettings?.stitchLengthMeters).toBeUndefined();
      expect(workspace.metrics?.palettes[0].material.estimatedMeters).toBeCloseTo(0.04064);
      expect((await repository.load('material-settings'))?.metadata.materialSettings).toEqual({ strands: 2, backstitchStrands: 2, waste: 0.1, skeinLengthMeters: 8 });

      await workspace.openProject('material-settings');
      expect(workspace.materialSettings).toEqual({ strands: 2, backstitchStrands: 2, waste: 0.1, skeinLengthMeters: 8 });
      expect(workspace.metrics?.palettes[0].material.requiredSkeins).toBe(1);
    } finally {
      await workspace.dispose();
    }
  });

  it('persists backstitchStrands without bumping the document revision and rejects invalid values', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'backstitch-strands' });
    try {
      await workspace.createProject({ width: 1, height: 1 });
      const revision = workspace.document?.revision;
      expect(workspace.materialSettings?.backstitchStrands).toBe(1);
      await workspace.updateActiveMaterialSettings({ backstitchStrands: 2 });
      await workspace.flush();
      expect(workspace.materialSettings?.backstitchStrands).toBe(2);
      expect(workspace.document?.revision).toBe(revision);
      expect((await repository.load('backstitch-strands'))?.metadata.materialSettings?.backstitchStrands).toBe(2);
      await expect(workspace.updateActiveMaterialSettings({ backstitchStrands: 0 })).rejects.toMatchObject({ code: 'invalid-material-settings' });
      expect(workspace.materialSettings?.backstitchStrands).toBe(2);
    } finally {
      await workspace.dispose();
    }
  });

  it('lets a project listing finish without superseding an in-flight open', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'unused' });
    try {
      await workspace.createProject({ id: 'listing-a', title: 'A', width: 1, height: 1 });
      await workspace.createProject({ id: 'listing-b', title: 'B', width: 1, height: 1 });
      await workspace.flush();

      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const load = repository.load.bind(repository);
      repository.load = async (projectId) => {
        await gate;
        return load(projectId);
      };
      const opening = workspace.openProject('listing-a');
      const projects = await workspace.listProjects();
      expect(projects.map((project) => project.id).sort()).toEqual(['listing-a', 'listing-b']);
      release();
      const session = await opening;
      expect(session.projectId).toBe('listing-a');
      expect(workspace.metadata?.id).toBe('listing-a');
      expect(workspace.error).toBeNull();
    } finally {
      await workspace.dispose();
    }
  });

  it('duplicates a non-active project without changing the active session', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'duplicate-copy' });
    try {
      await workspace.createProject({ id: 'duplicate-source', title: 'Source', notes: 'keep me', width: 2, height: 2 });
      await workspace.flush();
      await workspace.createProject({ id: 'duplicate-active', title: 'Active', width: 1, height: 1 });

      const copy = await workspace.duplicateProject('duplicate-source');
      expect(copy).toMatchObject({ id: 'duplicate-copy', title: 'Source copy', notes: 'keep me', createdAt: 100, updatedAt: 100 });
      expect(workspace.metadata?.id).toBe('duplicate-active');
      const projects = await workspace.listProjects();
      expect(projects.map((project) => project.id).sort()).toEqual(['duplicate-active', 'duplicate-copy', 'duplicate-source']);
      const source = await repository.load('duplicate-source');
      const saved = await repository.load('duplicate-copy');
      expect(saved?.metadata.title).toBe('Source copy');
      expect(saved?.document).toEqual(source?.document);
    } finally {
      await workspace.dispose();
    }
  });

  it('carries the source image asset through project duplication', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'duplicate-image-copy' });
    try {
      await workspace.createProject({ id: 'duplicate-image', width: 4, height: 3, assets: [{ id: 'reference', name: 'reference.png', mimeType: 'image/png', data: pngBytes(2, 3) }] });
      const descriptor = {
        assetId: 'reference',
        mimeType: 'image/png' as const,
        width: 2,
        height: 3,
        crop: { x: 0, y: 0, width: 1, height: 1 },
        chartBounds: { x: 0, y: 0, width: 4, height: 3 },
        traceVisible: true,
        opacity: 1
      };
      await workspace.setSourceImage(descriptor);
      await workspace.flush();

      await workspace.duplicateProject('duplicate-image');
      const saved = await repository.load('duplicate-image-copy');
      expect(saved?.metadata.sourceImage).toEqual(descriptor);
      expect(saved?.assets.map((asset) => asset.id)).toEqual(['reference']);
      expect(workspace.metadata?.id).toBe('duplicate-image');
    } finally {
      await workspace.dispose();
    }
  });

  it('rejects duplicating an unknown project', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'duplicate-missing-copy' });
    try {
      await workspace.createProject({ id: 'duplicate-existing', width: 1, height: 1 });
      await expect(workspace.duplicateProject('does-not-exist')).rejects.toMatchObject({ code: 'project-not-found' });
      expect(await repository.load('duplicate-missing-copy')).toBeUndefined();
    } finally {
      await workspace.dispose();
    }
  });

  it('renames a non-active project without touching its document or the active session', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 } });
    try {
      await workspace.createProject({ id: 'rename-source', title: 'Before', width: 2, height: 2 });
      await workspace.flush();
      await workspace.createProject({ id: 'rename-active', title: 'Active', width: 1, height: 1 });
      const before = await repository.load('rename-source');

      const renamed = await workspace.renameProject('rename-source', '  After  ');
      expect(renamed.title).toBe('After');
      const after = await repository.load('rename-source');
      expect(after?.metadata.title).toBe('After');
      expect(after?.metadata.updatedAt).toBe(before?.metadata.updatedAt);
      expect(after?.document).toEqual(before?.document);
      expect(workspace.metadata).toMatchObject({ id: 'rename-active', title: 'Active' });
    } finally {
      await workspace.dispose();
    }
  });

  it('renames the active project through its session', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 } });
    try {
      await workspace.createProject({ id: 'rename-open', title: 'Before', width: 1, height: 1 });
      const renamed = await workspace.renameProject('rename-open', 'After');
      expect(renamed.title).toBe('After');
      expect(workspace.metadata?.title).toBe('After');
      expect((await repository.load('rename-open'))?.metadata.title).toBe('After');
    } finally {
      await workspace.dispose();
    }
  });

  it('rejects renaming an unknown project or to an empty title', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 } });
    try {
      await workspace.createProject({ id: 'rename-keep', title: 'Keep', width: 1, height: 1 });
      await workspace.flush();
      await expect(workspace.renameProject('does-not-exist', 'Name')).rejects.toMatchObject({ code: 'project-not-found' });
      await expect(workspace.renameProject('rename-keep', '   ')).rejects.toMatchObject({ code: 'save-failed' });
      expect((await repository.load('rename-keep'))?.metadata.title).toBe('Keep');
    } finally {
      await workspace.dispose();
    }
  });

  it('refreshes only stale gallery thumbnails in the background', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 } });
    const thumbnail = (columns: number, rows: number): ProjectThumbnailSummary => ({ version: 2 as const, revision: 1, columns, rows, palette: ['#ffffff'], indices: new Uint8Array(columns * rows), backstitches: { points: new Uint32Array(0), colors: new Uint8Array(0) } });
    try {
      await workspace.createProject({ id: 'thumb-stale', width: 300, height: 200 });
      await workspace.createProject({ id: 'thumb-fresh', width: 4, height: 3 });
      await workspace.createProject({ id: 'thumb-active', width: 300, height: 200 });
      await workspace.flush();
      const stale = repository.records.get('thumb-stale')!;
      const fresh = repository.records.get('thumb-fresh')!;
      const active = repository.records.get('thumb-active')!;
      stale.metadata = { ...stale.metadata, width: 300, height: 200, thumbnail: thumbnail(128, 85) };
      fresh.metadata = { ...fresh.metadata, width: 4, height: 3, thumbnail: thumbnail(4, 3) };
      active.metadata = { ...active.metadata, width: 300, height: 200, thumbnail: thumbnail(128, 85) };
      // MemoryRepository does not backfill on load like the Dexie repository, so emulate it.
      const loadedIds: string[] = [];
      const load = repository.load.bind(repository);
      vi.spyOn(repository, 'load').mockImplementation(async (projectId) => {
        loadedIds.push(projectId);
        const record = repository.records.get(projectId);
        if (record?.metadata.width !== undefined && record.metadata.height !== undefined) record.metadata = { ...record.metadata, thumbnail: thumbnail(record.metadata.width, record.metadata.height) };
        return load(projectId);
      });

      expect(await workspace.refreshStaleThumbnails()).toBe(1);
      expect(loadedIds).toEqual(['thumb-stale']);
      const projects = await workspace.listProjects();
      expect(projects.find((project) => project.id === 'thumb-stale')?.thumbnail).toMatchObject({ columns: 300, rows: 200 });
      expect(workspace.metadata?.id).toBe('thumb-active');
      expect(await workspace.refreshStaleThumbnails()).toBe(0);

      const legacy: ProjectThumbnailSummary = thumbnail(4, 3);
      delete legacy.backstitches;
      fresh.metadata = { ...fresh.metadata, thumbnail: legacy };
      loadedIds.length = 0;
      expect(await workspace.refreshStaleThumbnails()).toBe(1);
      expect(loadedIds).toEqual(['thumb-fresh']);
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

      await expect(workspace.setSourceImage({ ...descriptor, assetId: 'missing' })).rejects.toMatchObject({ code: 'invalid-asset' });
      expect(workspace.sourceImage).toEqual(descriptor);
      await expect(workspace.setSourceImage({ ...descriptor, opacity: 1.1 })).rejects.toMatchObject({ code: 'invalid-metadata' });
      await expect(workspace.setSourceImage({ ...descriptor, crop: { x: 0.5, y: 0, width: 0.6, height: 1 } })).rejects.toMatchObject({ code: 'invalid-metadata' });
      expect(workspace.sourceImage).toEqual(descriptor);
      await workspace.removeSourceImage();
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
      workspace.execute(cell(workspace.document!, { type: 'set-full', x: 1, y: 1, color: 1 }));
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
      workspace.execute(cell(workspace.document!, { type: 'set-full', x: 0, y: 0, color: 1 }));
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
      expect(flattenDocument(loaded!.document).kind[0]).toBe(1);
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
      await workspace.flush();
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
      workspace.execute(cell(workspace.document!, { type: 'set-full', x: 1, y: 1, color: 1 }));
      await expect(workspace.flush()).rejects.toMatchObject({ code: 'storage-failure' });
      expect(workspace.document?.kind[5]).toBe(CellKind.Full);
      expect(workspace.error).toMatchObject({ code: 'storage-failure' });
      expect(workspace.saveState.status).toBe('error');
    } finally {
      repository.failSaves = false;
      await workspace.dispose().catch(() => undefined);
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
      await workspace.openProject('other');
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

describe('Track progress marks', () => {
  const twoColors = (): PatternDocument => createDocument({ width: 4, height: 4, palette: [{ id: 1, name: 'Ruby', color: '#b44' }, { id: 2, name: 'Blue', color: '#36c' }] });
  const markCell = (index: number, operation: 'toggle' | 'set' | 'clear' = 'toggle') => ({ cells: { indices: Uint32Array.of(index), masks: Uint8Array.of(1) }, operation });

  async function paintedWorkspace(id: string, repository: WorkspaceRepository = new MemoryRepository()) {
    const workspace = new ProjectWorkspace({ repository, debounceMs: 30, clock: { now: () => 100 }, projectIdFactory: () => id });
    const session = await workspace.createProject({ width: 4, height: 4, document: twoColors() });
    session.execute(cell(session.document, { type: 'set-full', x: 0, y: 0, color: 1 }));
    session.execute(cell(session.document, { type: 'set-full', x: 1, y: 0, color: 1 }));
    session.execute(cell(session.document, { type: 'set-full', x: 2, y: 0, color: 2 }));
    return { workspace, session };
  }

  it('marks, undoes and redoes on its own stack without touching document history', async () => {
    const { workspace, session } = await paintedWorkspace('marks');
    try {
      const documentDepth = session.historyUndoDepth;
      const marked = session.markProgress(markCell(0));
      expect(marked.changed).toBe(true);
      expect(session.document.completed[0] & 1).toBe(1);
      expect(session.canUndoMark).toBe(true);
      expect(session.canRedoMark).toBe(false);
      expect(session.historyUndoDepth).toBe(documentDepth);

      expect(session.undoMark().changed).toBe(true);
      expect(session.document.completed[0] & 1).toBe(0);
      expect(session.canUndoMark).toBe(false);
      expect(session.canRedoMark).toBe(true);

      expect(session.redoMark().changed).toBe(true);
      expect(session.document.completed[0] & 1).toBe(1);
      expect(session.canRedoMark).toBe(false);

      session.undoMark();
      session.markProgress(markCell(1));
      expect(session.canRedoMark).toBe(false);
      expect(session.undoMark().changed).toBe(true);
      expect(session.undoMark().changed).toBe(false);
    } finally {
      await workspace.dispose();
    }
  });

  it('clears the mark history and reports it through the workspace snapshot', async () => {
    const { workspace, session } = await paintedWorkspace('clear-marks');
    try {
      session.markProgress(markCell(0));
      session.markProgress(markCell(1));
      session.undoMark();
      expect(workspace.getStateSnapshot()).toMatchObject({ canUndoMark: true, canRedoMark: true });
      const listener = vi.fn();
      const unsubscribe = workspace.subscribe(listener);
      workspace.clearMarkHistory();
      unsubscribe();
      expect(listener).toHaveBeenCalled();
      expect(session.canUndoMark).toBe(false);
      expect(session.canRedoMark).toBe(false);
      expect(workspace.getStateSnapshot()).toMatchObject({ canUndoMark: false, canRedoMark: false });
      expect(session.document.completed[0] & 1).toBe(1);
      expect(session.undoMark().changed).toBe(false);
    } finally {
      await workspace.dispose();
    }
  });

  it('caps the mark history at its step limit', async () => {
    const { workspace, session } = await paintedWorkspace('capped-marks');
    try {
      for (let step = 0; step < MAX_MARK_HISTORY_STEPS + 1; step += 1) session.markProgress(markCell(0));
      let undone = 0;
      while (session.canUndoMark) {
        session.undoMark();
        undone += 1;
      }
      expect(undone).toBe(MAX_MARK_HISTORY_STEPS);
    } finally {
      await workspace.dispose();
    }
  });

  it('never reverts a mark through document undo', async () => {
    const { workspace, session } = await paintedWorkspace('document-undo');
    try {
      session.markProgress(markCell(0));
      expect(session.undo().changed).toBe(true);
      expect(session.document.kind[2]).toBe(0);
      expect(session.document.completed[0] & 1).toBe(1);
      expect(session.canUndoMark).toBe(true);
    } finally {
      await workspace.dispose();
    }
  });

  it('autosaves a mark', async () => {
    const repository = new MemoryRepository();
    const { workspace, session } = await paintedWorkspace('saved-marks', repository);
    try {
      await workspace.flush();
      const saves = repository.saveCalls.length;
      session.markProgress(markCell(0));
      expect(session.saveState.dirty).toBe(true);
      await wait(40);
      await workspace.flush();
      expect(repository.saveCalls.length).toBeGreaterThan(saves);
      const saved = await repository.load('saved-marks');
      expect(saved === undefined ? 0 : flattenDocument(saved.document).completed[0] & 1).toBe(1);
    } finally {
      await workspace.dispose();
    }
  });

  it('updates per-color progress after a mark, backstitches included', async () => {
    const { workspace, session } = await paintedWorkspace('color-progress');
    try {
      session.addLayer(LayerType.Specialty);
      const added = session.execute({ type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 2, y: 0 }, color: 1 });
      const backstitchId = added.backstitchId ?? -1;
      expect(paletteProgress(session.metrics, 1)).toMatchObject({ completedComponents: 0, totalComponents: 3, percent: 0 });

      session.markProgress(markCell(0));
      expect(paletteProgress(session.metrics, 1)).toMatchObject({ completedComponents: 1, totalComponents: 3, remainingComponents: 2 });
      expect(paletteProgress(session.metrics, 2)).toMatchObject({ completedComponents: 0, totalComponents: 1 });
      const stateMetrics = workspace.getStateSnapshot().metrics;
      expect(stateMetrics?.byPalette.get(1)).toMatchObject({ completedComponents: 1, totalComponents: 3 });
      expect(stateMetrics?.progress).toMatchObject({ completedComponents: 1, totalComponents: 4, percent: 25 });

      session.markProgress({ backstitchIds: Uint32Array.of(backstitchId), operation: 'set' });
      expect(paletteProgress(session.metrics, 1).fraction).toBeCloseTo(2 / 3);
      expect(paletteProgress(session.metrics, null)).toMatchObject({ completedComponents: 2, totalComponents: 4, percent: 50 });
      expect(paletteProgress(session.metrics, 99)).toMatchObject({ completedComponents: 0, totalComponents: 0, percent: 0 });

      session.undoMark();
      session.undoMark();
      expect(paletteProgress(session.metrics, null).completedComponents).toBe(0);
    } finally {
      await workspace.dispose();
    }
  });
});
