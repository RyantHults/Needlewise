import {
  assertValidDocument,
  assertValidLayeredDocument,
  cloneDocument,
  createDocument,
  flattenDocument,
  layeredFromSurface,
  normalizeAidaCount,
  normalizeDisplayUnits,
  normalizeMaterialSettings,
  normalizePatternSettings,
  type DomainCommand,
  type LayeredDocument,
  type LayerType,
  type PatternDocument,
  type PaletteEntryInput,
  type PatternFragment,
  type PatternSettings,
  type Point,
  type ProgressCommand
} from '../domain';
import {
  cloneLayeredDocument,
  PersistenceError,
  ProjectRepository,
  type ProjectFolder,
  type ProjectFolderIndex,
  type ProjectHealth,
  type ProjectMetadata,
  type ProjectRecord,
  type ProjectAssetInput,
  type SourceImageDescriptor,
  type SourceImageReplacementInput,
  type SourceImageSettingsInput,
  normalizeSourceImageAsset,
  normalizeSourceImageDescriptor,
  createPersistencePreparationClient,
  expectedThumbnailDimensions,
  isProjectId,
  type PersistencePreparationClient
} from '../persistence';
import { validateAcceptedConversionDraft, type AcceptedConversionDraft } from '../conversion/image-to-pattern';
import type { PatternMetrics } from '../domain';
import { createCatalogReference, DEFAULT_CATALOG_DEFINITION, INSTALLED_CATALOG_REGISTRY, type CatalogDefinition } from '../catalog';
import { asError, WorkspaceError } from './errors';
import { ProjectSession } from './session';
import type {
  ActiveLayerId,
  LayerSelection,
  ActiveLayerInfo,
  ActiveWorkspaceState,
  ActiveMetadataChanges,
  EditorLayerSnapshot,
  LayerSummary,
  PasteCommitResult,
  PasteDestination,
  CreateProjectOptions,
  CreateConvertedProjectOptions,
  SaveState,
  WorkspaceClock,
  WorkspaceOptions,
  WorkspaceRepository
} from './types';

const DEFAULT_WIDTH = 100;
const DEFAULT_HEIGHT = 100;
const DEFAULT_TITLE = 'Untitled pattern';
const DEFAULT_DEBOUNCE_MS = 1_000;
let fallbackIdCounter = 0;

const EMPTY_SAVE_STATE: SaveState = {
  status: 'idle',
  dirty: false,
  pendingRevision: null,
  lastSavedRevision: null,
  metadataDirty: false,
  assetsDirty: false,
  conflict: false,
  error: null
};

function asClock(clock: WorkspaceOptions['clock']): WorkspaceClock {
  if (typeof clock === 'function') return { now: clock };
  return clock ?? { now: () => Date.now() };
}

function createBrowserProjectId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  if (cryptoApi?.getRandomValues) {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  fallbackIdCounter += 1;
  return `project-${Date.now().toString(36)}-${fallbackIdCounter.toString(36)}`;
}

export function createStarterDocument(options: Pick<CreateProjectOptions, 'width' | 'height' | 'settings'> = {}): PatternDocument {
  // New projects seed their palette with catalog Black 310 so there is always a usable color.
  // `createDocument` seeds `nextPaletteId` at 2 for that single entry.
  const definition = DEFAULT_CATALOG_DEFINITION;
  const black = definition.getByHex('#000000');
  return createDocument({
    width: options.width ?? DEFAULT_WIDTH,
    height: options.height ?? DEFAULT_HEIGHT,
    catalog: definition.association,
    palette: black
      ? [{
          id: 1,
          name: black.name,
          color: black.hex,
          catalog: createCatalogReference(definition, black)
        }]
      : [],
    settings: options.settings
  });
}

function isLayeredDocument(document: PatternDocument | LayeredDocument): document is LayeredDocument {
  return Array.isArray((document as Partial<LayeredDocument>).layers);
}

/**
 * The stored document for a new project: an explicit layered document as
 * given, or a single surface (starter or image conversion) split into the
 * "Stitches" and "Specialty" layers. A supplied document keeps its own
 * settings; `settings` only shape the starter. An explicit Canvas stitch
 * count applies to either.
 */
function layeredProjectDocument(options: CreateProjectOptions): LayeredDocument {
  const aida: Partial<PatternSettings> = options.aidaCount === undefined ? {} : { aidaCount: normalizeAidaCount(options.aidaCount) };
  const source = options.document;
  if (source !== undefined && isLayeredDocument(source)) {
    const document = cloneLayeredDocument(source);
    if (aida.aidaCount !== undefined) document.settings = normalizePatternSettings({ ...document.settings, ...aida });
    return document;
  }
  const surface = source === undefined ? createStarterDocument(options) : cloneDocument(source);
  assertValidDocument(surface);
  return layeredFromSurface(surface, aida);
}

const EMPTY_LAYERS: readonly LayerSummary[] = [];

function emptyState(): ActiveWorkspaceState {
  return { projectId: null, metadata: null, document: null, health: null, usingRecovery: false, save: { ...EMPTY_SAVE_STATE }, error: null, materialSettings: null, layeredDocument: null, layers: EMPTY_LAYERS, activeLayer: null, layerSelection: null };
}

export class ProjectWorkspace {
  readonly repository: WorkspaceRepository;
  private readonly preparationClient: PersistencePreparationClient;
  private readonly clock: WorkspaceClock;
  private readonly debounceMs: number;
  private readonly projectIdFactory: () => string;
  private active: ProjectSession | null = null;
  private operationError: Error | null = null;
  private disposed = false;
  private operationToken = 0;
  private readonly listeners = new Set<() => void>();
  private unsubscribeFromSession: (() => void) | null = null;
  private stateSnapshot: ActiveWorkspaceState = emptyState();

  constructor(options: WorkspaceOptions = {}) {
    this.repository = options.repository ?? new ProjectRepository(undefined, { databaseName: 'needlewise-local' });
    this.preparationClient = options.preparationClient ?? createPersistencePreparationClient();
    this.clock = asClock(options.clock);
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.projectIdFactory = options.projectIdFactory ?? createBrowserProjectId;
  }

  get session(): ProjectSession | null {
    return this.active;
  }

  get activeProjectId(): string | null {
    return this.active?.projectId ?? null;
  }

  get metadata(): ProjectMetadata | null {
    return this.active?.metadata ?? null;
  }

  /** The flattened, visible-only composite of the active project. */
  get document(): PatternDocument | null {
    return this.active?.document ?? null;
  }

  get layeredDocument(): LayeredDocument | null {
    return this.active?.layeredDocument ?? null;
  }

  get layers(): readonly LayerSummary[] {
    return this.active?.layers ?? EMPTY_LAYERS;
  }

  get activeLayer(): ActiveLayerInfo | null {
    return this.active?.activeLayer ?? null;
  }

  get activeLayerId(): ActiveLayerId | null {
    return this.active?.activeLayerId ?? null;
  }

  get layerSelection(): LayerSelection | null {
    return this.active?.layerSelection ?? null;
  }

  get selectedLayerIds(): readonly number[] | null {
    return this.active?.layerSelection.layerIds ?? null;
  }

  get health(): ProjectHealth | null {
    return this.active?.health ?? null;
  }

  get usingRecovery(): boolean {
    return this.active?.usingRecovery ?? false;
  }

  get metrics(): PatternMetrics | null {
    return this.active?.metrics ?? null;
  }

  get materialSettings() {
    return this.active?.materialSettings ?? null;
  }

  get sourceImage(): SourceImageDescriptor | undefined {
    return this.active?.sourceImage;
  }

  catalogFor(document: Pick<PatternDocument, 'catalog'> | null | undefined): CatalogDefinition | undefined {
    return document === null || document === undefined ? undefined : INSTALLED_CATALOG_REGISTRY.resolve(document.catalog);
  }

  availableCatalogs(): readonly CatalogDefinition[] {
    return INSTALLED_CATALOG_REGISTRY.definitions;
  }

  getAsset(assetId: string) {
    return this.active?.getAsset(assetId);
  }

  get saveState(): SaveState {
    return this.active?.saveState ?? { ...EMPTY_SAVE_STATE };
  }

  get error(): Error | null {
    return this.active?.error ?? this.operationError;
  }

  get saveError(): Error | null {
    return this.error;
  }

  get state(): ActiveWorkspaceState {
    return this.stateSnapshot;
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  getStateSnapshot(): ActiveWorkspaceState {
    return this.stateSnapshot;
  }

  private notify(): void {
    this.stateSnapshot = {
      projectId: this.activeProjectId,
      metadata: this.metadata,
      document: this.document,
      health: this.health,
      usingRecovery: this.usingRecovery,
      save: this.saveState,
      error: this.error,
      metrics: this.metrics,
      materialSettings: this.materialSettings,
      sourceImage: this.sourceImage,
      layeredDocument: this.layeredDocument,
      layers: this.layers,
      activeLayer: this.activeLayer,
      layerSelection: this.layerSelection,
      canUndoMark: this.canUndoMark,
      canRedoMark: this.canRedoMark
    };
    for (const listener of [...this.listeners]) listener();
  }

  private setActive(session: ProjectSession): void {
    const previous = this.active;
    this.unsubscribeFromSession?.();
    this.active = session;
    this.unsubscribeFromSession = session.subscribe(() => this.notify());
    if (previous && previous !== session) this.retireSession(previous);
    this.notify();
  }

  private ensureActiveWorkspace(): void {
    if (this.disposed) throw new WorkspaceError('disposed', 'This project workspace has been disposed.');
  }

  private ensureOperation(token: number): void {
    this.ensureActiveWorkspace();
    if (token !== this.operationToken) throw new WorkspaceError('stale-operation', 'The workspace operation is no longer current.');
  }

  private startOperation(): number {
    this.ensureActiveWorkspace();
    this.operationToken += 1;
    return this.operationToken;
  }

  private ensureActiveSession(): ProjectSession {
    this.ensureActiveWorkspace();
    if (!this.active) throw new WorkspaceError('no-active-project', 'There is no active local project.');
    return this.active;
  }

  private rememberOperationError(error: unknown, message: string): never {
    const normalized = asError(error, message);
    this.operationError = normalized;
    this.notify();
    throw normalized;
  }

  /**
   * Runs a repository operation under the operation-token protocol. With
   * `supersede` it starts a new operation, cancelling any in flight; without
   * it, it reads the current token, so a background listing never cancels an
   * in-flight open. A stale result throws `stale-operation`; any other failure
   * becomes the remembered operation error.
   */
  private async runRepositoryOperation<T>(message: string, operation: (token: number) => Promise<T>, { supersede }: { supersede: boolean }): Promise<T> {
    const token = supersede ? this.startOperation() : this.operationToken;
    try {
      const result = await operation(token);
      this.ensureOperation(token);
      this.operationError = null;
      this.notify();
      return result;
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === 'stale-operation') throw error;
      return this.rememberOperationError(error, message);
    }
  }

  /**
   * Applies a change to the active session and clears the operation error.
   * With `flushWhenImmediate` it also saves when autosave is not debounced.
   */
  private async mutateActiveSession(message: string, mutation: (session: ProjectSession) => void | Promise<void>, { flushWhenImmediate }: { flushWhenImmediate: boolean }): Promise<void> {
    const session = this.ensureActiveSession();
    try {
      // Synchronous mutations stay synchronous, so the state change and notify are not deferred a tick.
      const pending = mutation(session);
      if (pending !== undefined) await pending;
      if (flushWhenImmediate && this.debounceMs === 0) await session.flush();
      this.operationError = null;
      this.notify();
    } catch (error) {
      return this.rememberOperationError(error, message);
    }
  }

  private makeSession(record: ProjectRecord, usingRecovery = false, health?: ProjectHealth | null): ProjectSession {
    assertValidLayeredDocument(record.document);
    return new ProjectSession({
      repository: this.repository,
      metadata: record.metadata,
      document: record.document,
      head: record.head,
      preparationClient: this.preparationClient,
      assets: record.assets,
      history: usingRecovery ? undefined : record.history,
      health: health ?? record.health ?? null,
      usingRecovery,
      clock: this.clock,
      debounceMs: this.debounceMs
    });
  }

  private retireSession(session: ProjectSession | null): void {
    if (!session) return;
    void session.dispose().catch(() => undefined);
  }

  private async flushActiveBeforeSwitch(token: number): Promise<void> {
    if (this.active) {
      await this.active.flush();
      this.ensureOperation(token);
    }
  }

  async createProject(options: CreateProjectOptions = {}): Promise<ProjectSession> {
    const token = this.startOperation();
    await this.flushActiveBeforeSwitch(token);
    this.ensureOperation(token);
    const projectId = options.id ?? this.projectIdFactory();
    if (!isProjectId(projectId)) throw new WorkspaceError('save-failed', 'Generated project ID is invalid.');
    const document = layeredProjectDocument(options);
    assertValidLayeredDocument(document);
    const units = options.units === undefined ? undefined : normalizeDisplayUnits(options.units);
    const materialSettings = options.materialSettings === undefined ? undefined : normalizeMaterialSettings(flattenDocument(document), options.materialSettings);
    const now = this.clock.now();
    const metadata: ProjectMetadata = { id: projectId, title: options.title ?? DEFAULT_TITLE, notes: options.notes ?? '', createdAt: now, updatedAt: now, revision: document.revision, ...(units === undefined ? {} : { units }), ...(materialSettings === undefined ? {} : { materialSettings }), ...(options.sourceImage === undefined ? {} : { sourceImage: options.sourceImage }) };
    try {
      const saveResult = await this.repository.save(projectId, metadata, document, options.assets);
      this.ensureOperation(token);
      if (!saveResult.committed || saveResult.stale) throw new PersistenceError('stale-save', `Project ${projectId} was not committed.`);
      const savedRecord = await this.repository.load(projectId);
      this.ensureOperation(token);
      const sessionRecord = savedRecord === undefined
        ? { metadata, document, head: saveResult.head, recovery: null, assets: [] }
        : savedRecord.head === undefined && saveResult.head !== undefined
          ? { ...savedRecord, head: saveResult.head }
          : savedRecord;
      const session = this.makeSession(sessionRecord);
      this.ensureOperation(token);
      this.setActive(session);
      this.operationError = null;
      this.notify();
      return session;
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === 'stale-operation') throw error;
      return this.rememberOperationError(error, 'Unable to create the local project.');
    }
  }

  /**
   * Commit an accepted conversion as one normal project save. The source image
   * is optional; when supplied, its asset and validated descriptor are included
   * in the same transaction as the converted document.
   */
  async createProjectFromConversion(options: CreateConvertedProjectOptions): Promise<ProjectSession> {
    validateAcceptedConversionDraft(options.draft);
    // Snapshot the accepted draft before the first await. Conversion results
    // are application-owned values, but callers may still hold mutable typed
    // arrays or nested objects at runtime.
    const draft: AcceptedConversionDraft = {
      ...options.draft,
      document: cloneDocument(options.draft.document),
      stats: {
        ...options.draft.stats,
        paletteUsage: options.draft.stats.paletteUsage.map((entry) => ({ ...entry }))
      },
      sourceImage: {
        ...options.draft.sourceImage,
        crop: { ...options.draft.sourceImage.crop },
        chartBounds: { ...options.draft.sourceImage.chartBounds }
      }
    };
    if (options.settings !== undefined) {
      draft.document.settings = normalizePatternSettings({ ...draft.document.settings, ...options.settings });
    }
    const assets = [...(options.assets ?? [])];
    let sourceImage: SourceImageDescriptor | undefined;
    const sourceInput = options.sourceImageAsset
      ?? (draft.sourceImage.assetId === undefined ? undefined : assets.find((asset) => asset.id === draft.sourceImage.assetId));
    if (sourceInput) {
      if (draft.sourceImage.assetId !== undefined && sourceInput.id !== draft.sourceImage.assetId) throw new WorkspaceError('save-failed', 'The retained source image asset does not match the conversion draft.');
      const normalizedAsset = await normalizeSourceImageAsset(sourceInput);
      const settings: SourceImageSettingsInput = {
        assetId: normalizedAsset.id,
        ...(draft.sourceImage.mimeType === undefined ? {} : { mimeType: draft.sourceImage.mimeType as SourceImageSettingsInput['mimeType'] }),
        width: draft.sourceImage.width,
        height: draft.sourceImage.height,
        crop: { ...draft.sourceImage.crop },
        chartBounds: { ...draft.sourceImage.chartBounds },
        traceVisible: draft.sourceImage.traceVisible,
        opacity: draft.sourceImage.opacity
      };
      sourceImage = normalizeSourceImageDescriptor(settings, { width: draft.document.width, height: draft.document.height }, normalizedAsset);
      const existingIndex = assets.findIndex((asset) => asset.id === normalizedAsset.id);
      // Pass the normalized, detached bytes onward. The caller's input may be
      // a mutable Uint8Array and must never become the persisted source asset.
      if (existingIndex >= 0) assets[existingIndex] = normalizedAsset;
      else assets.push(normalizedAsset);
    }
    return this.createProject({
      id: options.id,
      title: options.title,
      notes: options.notes,
      aidaCount: options.aidaCount,
      // The converted surface becomes the "Stitches" layer.
      document: draft.document,
      assets,
      materialSettings: options.materialSettings,
      ...(sourceImage === undefined ? {} : { sourceImage })
    });
  }

  async updateActiveMetadata(changes: ActiveMetadataChanges): Promise<void> {
    return this.mutateActiveSession('Unable to update the active project metadata.', (session) => session.updateMetadata(changes), { flushWhenImmediate: true });
  }

  /** The Canvas stitch count: an undoable document settings change. `null` is ignored. */
  async updateActiveAidaCount(aidaCount: number | null): Promise<void> {
    if (aidaCount === null) return;
    return this.mutateActiveSession('Unable to update the stitch count.', (session) => { session.setAidaCount(aidaCount); }, { flushWhenImmediate: true });
  }

  async listProjects(): Promise<ProjectMetadata[]> {
    return this.runRepositoryOperation('Unable to list local projects.', async () => {
      const projects = await this.repository.listProjects();
      return projects.map((project) => ({ ...project }))
        .sort((left, right) => right.updatedAt - left.updatedAt || right.revision - left.revision || left.id.localeCompare(right.id));
    }, { supersede: false });
  }

  /**
   * Loading a project makes the repository backfill its derived summary, so
   * loading each out-of-date thumbnail refreshes it. This is deliberately
   * outside the operation-token protocol: it never changes the active session
   * or the operation error, and per-project failures are ignored.
   */
  async refreshStaleThumbnails(candidates?: readonly ProjectMetadata[]): Promise<number> {
    let refreshed = 0;
    try {
      const projects = candidates ?? await this.repository.listProjects();
      for (const project of projects) {
        if (this.disposed) break;
        if (project.id === this.active?.projectId) continue;
        const { width, height, thumbnail } = project;
        if (width === undefined || height === undefined || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) continue;
        const expected = expectedThumbnailDimensions(width, height);
        if (thumbnail !== undefined && thumbnail.columns === expected.columns && thumbnail.rows === expected.rows && thumbnail.backstitches !== undefined) continue;
        try {
          await this.repository.load(project.id);
          refreshed += 1;
        } catch {
          // Best effort: one unreadable project must not stop the others.
        }
      }
    } catch {
      return refreshed;
    }
    if (refreshed > 0 && !this.disposed) this.notify();
    return refreshed;
  }

  async openProject(projectId: string): Promise<ProjectSession> {
    const token = this.startOperation();
    await this.flushActiveBeforeSwitch(token);
    this.ensureOperation(token);
    let record: ProjectRecord | undefined;
    try {
      record = await this.repository.load(projectId);
      this.ensureOperation(token);
    } catch (error) {
      this.ensureOperation(token);
      if (!this.repository.inspectProjectHealth || !this.repository.loadRecoveryRevision) return this.rememberOperationError(error, 'Unable to open the local project.');
      try {
        const health = await this.repository.inspectProjectHealth(projectId);
        this.ensureOperation(token);
        if (!health || !health.metadata || !health.recoveryAvailable) return this.rememberOperationError(error, 'Unable to open the local project.');
        const recovery = await this.repository.loadRecoveryRevision(projectId, health.recovery.revision ?? undefined);
        this.ensureOperation(token);
        if (!recovery) return this.rememberOperationError(error, 'Unable to open the local project recovery.');
        const session = this.makeSession(recovery, true, health);
        this.ensureOperation(token);
        this.setActive(session);
        this.operationError = null;
        this.notify();
        return session;
      } catch (recoveryError) {
        if (recoveryError instanceof WorkspaceError && recoveryError.code === 'stale-operation') throw recoveryError;
        return this.rememberOperationError(recoveryError, 'Unable to open the local project recovery.');
      }
    }
    if (!record) {
      const notFound = new WorkspaceError('project-not-found', `Project ${projectId} was not found.`);
      this.operationError = notFound;
      this.notify();
      throw notFound;
    }
    try {
      const session = this.makeSession(record, false, record.health ?? null);
      this.ensureOperation(token);
      this.setActive(session);
      this.operationError = null;
      this.notify();
      return session;
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === 'stale-operation') throw error;
      return this.rememberOperationError(error, 'Unable to open the local project.');
    }
  }

  async deleteProject(projectId: string): Promise<void> {
    this.ensureActiveWorkspace();
    if (!isProjectId(projectId)) return this.rememberOperationError(new WorkspaceError('save-failed', 'Project ID is invalid.'), 'Unable to delete the local project.');
    return this.runRepositoryOperation('Unable to delete the local project.', async (token) => {
      if (this.active?.projectId === projectId) {
        // Detach the session before deleting. dispose() commits any pending
        // autosave to the record (so it is part of the same deletion), then
        // cancels the debounce timer, so a later save can never re-create the
        // deleted record. A failed flush is irrelevant: the user confirmed the
        // deletion, and dispose still clears its timers in a finally block.
        const previous = this.active;
        this.unsubscribeFromSession?.();
        this.unsubscribeFromSession = null;
        this.active = null;
        try {
          await previous.dispose();
        } catch {
          // The session is disposed regardless; the record is deleted next.
        }
        this.ensureOperation(token);
      }
      // The repository deletes the record, its assets (source images), current
      // snapshots, recovery snapshots, and activity in one transaction.
      // Deleting a project that no longer exists is a safe no-op.
      await this.repository.deleteProject(projectId);
    }, { supersede: true });
  }

  async listFolderIndex(): Promise<ProjectFolderIndex> {
    return this.runRepositoryOperation('Unable to list local folders.', async () => {
      const index = await this.repository.listFolderIndex();
      return { folders: index.folders.map((folder) => ({ ...folder })), assignments: index.assignments.map((assignment) => ({ ...assignment })) };
    }, { supersede: false });
  }

  async createFolder(name: string, parentId: string | null = null): Promise<ProjectFolder> {
    return this.runRepositoryOperation('Unable to create the folder.', async () => {
      const folder = await this.repository.createFolder({ name, parentId, id: this.projectIdFactory() });
      return { ...folder };
    }, { supersede: true });
  }

  async renameFolder(folderId: string, name: string): Promise<ProjectFolder> {
    return this.runRepositoryOperation('Unable to rename the folder.', async () => {
      const folder = await this.repository.renameFolder(folderId, name);
      return { ...folder };
    }, { supersede: true });
  }

  async deleteFolder(folderId: string): Promise<void> {
    return this.runRepositoryOperation('Unable to delete the folder.', async () => {
      await this.repository.deleteFolder(folderId);
    }, { supersede: true });
  }

  async moveProjectToFolder(projectId: string, folderId: string | null): Promise<void> {
    return this.runRepositoryOperation('Unable to move the project.', async () => {
      await this.repository.moveProjectToFolder(projectId, folderId);
    }, { supersede: true });
  }

  async moveFolder(folderId: string, parentId: string | null): Promise<void> {
    return this.runRepositoryOperation('Unable to move the folder.', async () => {
      await this.repository.moveFolder(folderId, parentId);
    }, { supersede: true });
  }

  async renameProject(projectId: string, title: string): Promise<ProjectMetadata> {
    this.ensureActiveWorkspace();
    const trimmed = typeof title === 'string' ? title.trim() : '';
    if (!isProjectId(projectId) || trimmed === '') return this.rememberOperationError(new WorkspaceError('save-failed', 'Project ID or title is invalid.'), 'Unable to rename the local project.');
    return this.runRepositoryOperation('Unable to rename the local project.', async (token) => {
      if (this.active?.projectId === projectId) {
        // Route through the session so the open editor and its record agree.
        const session = this.active;
        session.updateMetadata({ title: trimmed });
        await session.flush();
        return session.metadata;
      }
      const record = await this.repository.load(projectId);
      this.ensureOperation(token);
      if (!record) throw new WorkspaceError('project-not-found', `Project ${projectId} was not found.`);
      const metadata: ProjectMetadata = { ...record.metadata, title: trimmed };
      // Retain keeps the stored document snapshot; only the metadata changes.
      const saveResult = await this.repository.save(projectId, metadata, record.document, undefined, { mode: 'retain', expectedHead: record.head, expectedRevision: record.document.revision });
      this.ensureOperation(token);
      if (!saveResult.committed || saveResult.stale) throw new PersistenceError('stale-save', `Project ${projectId} was not committed.`);
      return metadata;
    }, { supersede: true });
  }

  async duplicateProject(projectId: string): Promise<ProjectMetadata> {
    this.ensureActiveWorkspace();
    if (!isProjectId(projectId)) return this.rememberOperationError(new WorkspaceError('save-failed', 'Project ID is invalid.'), 'Unable to duplicate the local project.');
    return this.runRepositoryOperation('Unable to duplicate the local project.', async (token) => {
      // Unlike forkActiveProject, the copy is saved without becoming the active
      // session, so the gallery can duplicate any project in place.
      const active = this.active?.projectId === projectId ? this.active : null;
      if (active && active.saveState.status !== 'conflict' && active.saveState.status !== 'error') {
        await active.flush();
        this.ensureOperation(token);
      }
      const record = await this.repository.load(projectId);
      this.ensureOperation(token);
      if (!record) throw new WorkspaceError('project-not-found', `Project ${projectId} was not found.`);
      const copyId = this.projectIdFactory();
      if (!isProjectId(copyId)) throw new WorkspaceError('save-failed', 'Generated project ID is invalid.');
      const document = cloneLayeredDocument(record.document);
      const { units, materialSettings, sourceImage } = record.metadata;
      const now = this.clock.now();
      const metadata: ProjectMetadata = { id: copyId, title: `${record.metadata.title} copy`, notes: record.metadata.notes, createdAt: now, updatedAt: now, revision: document.revision, ...(units === undefined ? {} : { units }), ...(materialSettings === undefined ? {} : { materialSettings }), ...(sourceImage === undefined ? {} : { sourceImage }) };
      const saveResult = await this.repository.save(copyId, metadata, document, record.assets);
      this.ensureOperation(token);
      if (!saveResult.committed || saveResult.stale) throw new PersistenceError('stale-save', `Project ${copyId} was not committed.`);
      return metadata;
    }, { supersede: true });
  }

  execute(command: DomainCommand) {
    return this.ensureActiveSession().execute(command);
  }

  setActiveLayer(id: ActiveLayerId): void {
    this.ensureActiveSession().setActiveLayer(id);
  }

  toggleLayerSelected(id: number): void {
    this.ensureActiveSession().toggleLayerSelected(id);
  }

  selectLayerRange(id: number): void {
    this.ensureActiveSession().selectLayerRange(id);
  }

  activeLayerSurface(): PatternDocument | null {
    return this.active?.activeLayerSurface() ?? null;
  }

  getEditorLayerSnapshot(): EditorLayerSnapshot | null {
    return this.active?.getEditorLayerSnapshot() ?? null;
  }

  canAddLayer(type: LayerType): boolean {
    return this.active?.canAddLayer(type) ?? false;
  }

  addLayer(type: LayerType, name?: string) {
    return this.ensureActiveSession().addLayer(type, name);
  }

  deleteLayer(layerId: number) {
    return this.ensureActiveSession().deleteLayer(layerId);
  }

  moveLayer(layerId: number, toIndex: number) {
    return this.ensureActiveSession().moveLayer(layerId, toIndex);
  }

  renameLayer(layerId: number, name: string) {
    return this.ensureActiveSession().renameLayer(layerId, name);
  }

  setLayerVisibility(layerId: number, visible: boolean) {
    return this.ensureActiveSession().setLayerVisibility(layerId, visible);
  }

  duplicateLayer(layerId: number) {
    return this.ensureActiveSession().duplicateLayer(layerId);
  }

  mergeSelectedLayers() {
    return this.ensureActiveSession().mergeSelectedLayers();
  }

  setAidaCount(aidaCount: number) {
    return this.ensureActiveSession().setAidaCount(aidaCount);
  }

  resolvePaste(fragmentType: LayerType): PasteDestination {
    return this.ensureActiveSession().resolvePaste(fragmentType);
  }

  commitPaste(fragment: PatternFragment, at: Point, destination: PasteDestination, expectedRevision?: number, palette?: readonly PaletteEntryInput[]): PasteCommitResult {
    return this.ensureActiveSession().commitPaste(fragment, at, destination, expectedRevision, palette);
  }

  async updateActiveMaterialSettings(changes: Parameters<ProjectSession['updateMaterialSettings']>[0]): Promise<void> {
    return this.mutateActiveSession('Unable to update the active material settings.', (session) => session.updateMaterialSettings(changes), { flushWhenImmediate: true });
  }

  async updateMaterialSettings(changes: Parameters<ProjectSession['updateMaterialSettings']>[0]): Promise<void> {
    return this.updateActiveMaterialSettings(changes);
  }

  async setMaterialSettings(changes: Parameters<ProjectSession['updateMaterialSettings']>[0]): Promise<void> {
    return this.updateActiveMaterialSettings(changes);
  }

  async setActiveSourceImage(settings: SourceImageSettingsInput): Promise<void> {
    return this.mutateActiveSession('Unable to update the active source image.', (session) => session.setSourceImage(settings), { flushWhenImmediate: true });
  }

  async setSourceImage(settings: SourceImageSettingsInput): Promise<void> {
    return this.setActiveSourceImage(settings);
  }

  /**
   * Interleaved entry point for descriptor-only reference changes (move,
   * resize, opacity, visibility). One call pushes exactly one history entry
   * shared with document edits; a visibility toggle is saved without one.
   * Gesture layers coalesce before calling:
   * one call per drag commit, one per arrow nudge, one per slider release.
   */
  async applyTraceImageChange(next: SourceImageDescriptor | undefined, options?: { label?: string }): Promise<void> {
    return this.mutateActiveSession('Unable to update the active source image.', (session) => session.applyTraceImageChange(next, options), { flushWhenImmediate: true });
  }

  async replaceSourceImage(input: SourceImageReplacementInput | ProjectAssetInput, settings?: SourceImageSettingsInput): Promise<void> {
    return this.mutateActiveSession('Unable to replace the active source image.', (session) => session.replaceSourceImage(input, settings), { flushWhenImmediate: false });
  }

  /** Atomically removes the source-image descriptor and its retained asset. */
  async removeSourceImage(): Promise<void> {
    return this.mutateActiveSession('Unable to clear the active source image.', (session) => session.removeSourceImage(), { flushWhenImmediate: false });
  }

  executeBatch(commands: readonly DomainCommand[]) {
    return this.ensureActiveSession().executeBatch(commands);
  }

  undo() {
    return this.ensureActiveSession().undo();
  }

  redo() {
    return this.ensureActiveSession().redo();
  }

  markProgress(command: ProgressCommand) {
    return this.ensureActiveSession().markProgress(command);
  }

  undoMark() {
    return this.ensureActiveSession().undoMark();
  }

  redoMark() {
    return this.ensureActiveSession().redoMark();
  }

  clearMarkHistory(): void {
    this.active?.clearMarkHistory();
  }

  get canUndoMark(): boolean {
    return this.active?.canUndoMark ?? false;
  }

  get canRedoMark(): boolean {
    return this.active?.canRedoMark ?? false;
  }

  async flush(): Promise<void> {
    this.ensureActiveWorkspace();
    if (this.active) await this.active.flush();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.operationToken += 1;
    let failure: unknown;
    try {
      if (this.active) await this.active.dispose();
    } catch (error) {
      failure = error;
    } finally {
      this.unsubscribeFromSession?.();
      this.unsubscribeFromSession = null;
      this.preparationClient.dispose();
      if (this.repository.close) await this.repository.close();
      this.notify();
      this.listeners.clear();
    }
    if (failure) throw failure;
  }
}

export function getEmptyWorkspaceState(): ActiveWorkspaceState {
  return emptyState();
}
