import {
  assertValidDocument,
  cloneDocument,
  createDocument,
  DEFAULT_AIDA_COUNT,
  normalizeAidaCount,
  normalizeDisplayUnits,
  normalizeMaterialSettings,
  normalizePatternSettings,
  type DomainCommand,
  type PatternDocument
} from '../domain';
import {
  PersistenceError,
  ProjectRepository,
  type ArchiveImportOptions,
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
  type PersistencePreparationClient
} from '../persistence';
import { validateAcceptedConversionDraft, type AcceptedConversionDraft } from '../conversion/image-to-pattern';
import type { ProgressActivity } from '../persistence';
import type { PatternMetrics } from '../domain';
import { createCatalogReference, DEFAULT_CATALOG_DEFINITION, INSTALLED_CATALOG_REGISTRY, type CatalogDefinition, type InstalledCatalogRegistry } from '../catalog';
import { WorkspaceError } from './errors';
import { ProjectSession } from './session';
import type {
  ActiveWorkspaceState,
  ActiveMetadataChanges,
  CreateProjectOptions,
  CreateConvertedProjectOptions,
  SaveState,
  WorkspaceClock,
  WorkspaceInitializationOptions,
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

function isProjectId(value: string): boolean {
  return value.length > 0 && value.length <= 256;
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

function cloneHealth(health: ProjectHealth): ProjectHealth {
  return {
    ...health,
    metadata: health.metadata ? { ...health.metadata } : null,
    current: { ...health.current },
    recovery: { ...health.recovery },
    assets: { ...health.assets },
    ...(health.sourceImage === undefined ? {} : { sourceImage: { ...health.sourceImage } }),
    warnings: [...health.warnings]
  };
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

export const createStarterPattern = createStarterDocument;

function emptyState(): ActiveWorkspaceState {
  return { projectId: null, metadata: null, document: null, health: null, usingRecovery: false, save: { ...EMPTY_SAVE_STATE }, error: null, materialSettings: null };
}

export class ProjectWorkspace {
  readonly repository: WorkspaceRepository;
  private readonly preparationClient: PersistencePreparationClient;
  private readonly clock: WorkspaceClock;
  private readonly debounceMs: number;
  private readonly projectIdFactory: () => string;
  private readonly catalogRegistry: InstalledCatalogRegistry;
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
    this.catalogRegistry = options.catalogRegistry ?? INSTALLED_CATALOG_REGISTRY;
  }

  get session(): ProjectSession | null {
    return this.active;
  }

  get activeSession(): ProjectSession | null {
    return this.active;
  }

  get activeProjectId(): string | null {
    return this.active?.projectId ?? null;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get metadata(): ProjectMetadata | null {
    return this.active?.metadata ?? null;
  }

  get document(): PatternDocument | null {
    return this.active?.document ?? null;
  }

  get health(): ProjectHealth | null {
    const health = this.active?.health;
    return health ? cloneHealth(health) : null;
  }

  get usingRecovery(): boolean {
    return this.active?.usingRecovery ?? false;
  }

  get metrics(): PatternMetrics | null {
    return this.active?.metrics ?? null;
  }

  get progressMetrics(): PatternMetrics | null {
    return this.active?.progressMetrics ?? null;
  }

  get materialSettings() {
    return this.active?.materialSettings ?? null;
  }

  get materialAssumptions() {
    return this.active?.materialAssumptions ?? null;
  }

  get sourceImage(): SourceImageDescriptor | undefined {
    return this.active?.sourceImage;
  }

  getSourceImage(): SourceImageDescriptor | undefined {
    return this.sourceImage;
  }

  catalogFor(document: PatternDocument | null | undefined): CatalogDefinition | undefined {
    return document === null || document === undefined ? undefined : this.catalogRegistry.resolve(document.catalog);
  }

  availableCatalogs(): readonly CatalogDefinition[] {
    return this.catalogRegistry.definitions;
  }

  catalogById(catalogId: string): CatalogDefinition | undefined {
    return this.catalogRegistry.getById(catalogId);
  }

  getAsset(assetId: string) {
    return this.active?.getAsset(assetId);
  }

  getMaterialSettings() {
    return this.materialSettings;
  }

  getMaterialAssumptions() {
    return this.materialAssumptions;
  }

  get sessionStats() {
    return this.active?.sessionStats ?? null;
  }

  get activity(): ProgressActivity | null {
    return this.active?.activity ?? null;
  }

  get dailyActivity(): ProgressActivity | null {
    return this.active?.dailyActivity ?? null;
  }

  get saveState(): SaveState {
    return this.active?.saveState ?? { ...EMPTY_SAVE_STATE };
  }

  get error(): Error | null {
    return this.active?.error ?? this.operationError;
  }

  get saveStatus(): SaveState['status'] {
    return this.saveState.status;
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
      sessionStats: this.sessionStats,
      activity: this.activity,
      dailyActivity: this.dailyActivity,
      materialSettings: this.materialSettings,
      sourceImage: this.sourceImage
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

  private rememberOperationError(error: unknown, code: 'import-failed' | 'save-failed', message: string): never {
    const normalized = error instanceof Error ? error : new WorkspaceError(code, message, error);
    this.operationError = normalized;
    this.notify();
    throw normalized;
  }

  private makeSession(record: ProjectRecord, usingRecovery = false, health?: ProjectHealth | null): ProjectSession {
    assertValidDocument(record.document);
    return new ProjectSession({
      repository: this.repository,
      metadata: record.metadata,
      document: record.document,
      head: record.head,
      preparationClient: this.preparationClient,
      assets: record.assets,
      activity: record.activity,
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
    return this.createProjectInternal(options, true);
  }

  private async createProjectInternal(options: CreateProjectOptions, flushExisting: boolean, allowLegacyAssetIds = false): Promise<ProjectSession> {
    const token = this.startOperation();
    if (flushExisting) await this.flushActiveBeforeSwitch(token);
    this.ensureOperation(token);
    if (options.document === undefined && this.catalogRegistry.resolve(DEFAULT_CATALOG_DEFINITION.association) === undefined) {
      throw new WorkspaceError('save-failed', 'The default catalog is not installed; an explicit document is required to create a project.');
    }
    const projectId = options.id ?? this.projectIdFactory();
    if (!isProjectId(projectId)) throw new WorkspaceError('save-failed', 'Generated project ID is invalid.');
    const document = cloneDocument(options.document ?? createStarterDocument(options));
    assertValidDocument(document);
    const aidaCount = options.aidaCount === undefined ? DEFAULT_AIDA_COUNT : normalizeAidaCount(options.aidaCount);
    const units = options.units === undefined ? undefined : normalizeDisplayUnits(options.units);
    const materialSettings = normalizeMaterialSettings(document, {
      ...(options.materialSettings ?? {}),
      ...(aidaCount === undefined ? {} : { aidaCount })
    });
    const now = this.clock.now();
    const metadata: ProjectMetadata = { id: projectId, title: options.title ?? DEFAULT_TITLE, notes: options.notes ?? '', createdAt: now, updatedAt: now, revision: document.revision, ...(aidaCount === undefined ? {} : { aidaCount }), ...(units === undefined ? {} : { units }), ...(options.materialSettings === undefined ? {} : { materialSettings }), ...(options.sourceImage === undefined ? {} : { sourceImage: options.sourceImage }) };
    try {
      const saveResult = await this.repository.save(projectId, metadata, document, options.assets, allowLegacyAssetIds ? { allowLegacyAssetIds: true } : undefined);
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
      return this.rememberOperationError(error, 'save-failed', 'Unable to create the local project.');
    }
  }

  async createLocalProject(options: CreateProjectOptions = {}): Promise<ProjectSession> {
    return this.createProject(options);
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
      document: draft.document,
      assets,
      materialSettings: options.materialSettings,
      ...(sourceImage === undefined ? {} : { sourceImage })
    });
  }

  async createConvertedProject(options: CreateConvertedProjectOptions): Promise<ProjectSession> {
    return this.createProjectFromConversion(options);
  }

  async updateActiveMetadata(changes: ActiveMetadataChanges): Promise<void> {
    const session = this.ensureActiveSession();
    try {
      session.updateMetadata(changes);
      if (this.debounceMs === 0) await session.flush();
      this.operationError = null;
      this.notify();
    } catch (error) {
      return this.rememberOperationError(error, 'save-failed', 'Unable to update the active project metadata.');
    }
  }

  async updateActiveAidaCount(aidaCount: number | null): Promise<void> {
    return this.updateActiveMetadata({ aidaCount });
  }

  async updateAidaCount(aidaCount: number | null): Promise<void> {
    return this.updateActiveAidaCount(aidaCount);
  }

  async listProjectHealth(): Promise<ProjectHealth[]> {
    const token = this.operationToken;
    try {
      const health = this.repository.listProjectHealth ? await this.repository.listProjectHealth() : (await this.repository.listProjects()).map((metadata) => ({ projectId: metadata.id, metadata, current: { status: 'valid' as const, revision: metadata.revision }, recovery: { status: 'missing' as const, revision: null }, assets: { status: 'unchecked' as const, count: 0 }, usableRevision: metadata.revision, recoveryAvailable: false, warnings: [] }));
      this.ensureOperation(token);
      this.operationError = null;
      this.notify();
      return health.map(cloneHealth);
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === 'stale-operation') throw error;
      return this.rememberOperationError(error, 'save-failed', 'Unable to inspect local project health.');
    }
  }

  async listProjects(): Promise<ProjectMetadata[]> {
    const token = this.operationToken;
    try {
      const projects = await this.repository.listProjects();
      this.ensureOperation(token);
      this.operationError = null;
      this.notify();
      return projects.map((project) => ({ ...project }))
        .sort((left, right) => right.updatedAt - left.updatedAt || right.revision - left.revision || left.id.localeCompare(right.id));
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === 'stale-operation') throw error;
      return this.rememberOperationError(error, 'save-failed', 'Unable to list local projects.');
    }
  }

  async listProjectMetadata(): Promise<ProjectMetadata[]> {
    return this.listProjects();
  }

  async initialize(options: WorkspaceInitializationOptions = {}): Promise<ProjectSession | undefined> {
    this.ensureActiveWorkspace();
    if (options.projectId !== undefined) return this.openProject(options.projectId);
    const candidates = await this.listProjectMetadata();
    if (options.autoOpenMostRecent === false) return undefined;
    return this.selectProject(undefined, candidates);
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
      if (!this.repository.inspectProjectHealth || !this.repository.loadRecoveryRevision) return this.rememberOperationError(error, 'save-failed', 'Unable to open the local project.');
      try {
        const health = await this.repository.inspectProjectHealth(projectId);
        this.ensureOperation(token);
        if (!health || !health.metadata || !health.recoveryAvailable) return this.rememberOperationError(error, 'save-failed', 'Unable to open the local project.');
        const recovery = await this.repository.loadRecoveryRevision(projectId, health.recovery.revision ?? undefined);
        this.ensureOperation(token);
        if (!recovery) return this.rememberOperationError(error, 'save-failed', 'Unable to open the local project recovery.');
        const session = this.makeSession(recovery, true, health);
        this.ensureOperation(token);
        this.setActive(session);
        this.operationError = null;
        this.notify();
        return session;
      } catch (recoveryError) {
        if (recoveryError instanceof WorkspaceError && recoveryError.code === 'stale-operation') throw recoveryError;
        return this.rememberOperationError(recoveryError, 'save-failed', 'Unable to open the local project recovery.');
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
      return this.rememberOperationError(error, 'save-failed', 'Unable to open the local project.');
    }
  }

  async loadProject(projectId: string): Promise<ProjectSession> {
    return this.openProject(projectId);
  }

  async selectProject(projectId?: string, metadataCandidates?: readonly ProjectMetadata[]): Promise<ProjectSession | undefined> {
    this.ensureActiveWorkspace();
    if (projectId !== undefined) return this.openProject(projectId);
    const candidates = metadataCandidates === undefined ? await this.listProjectMetadata() : metadataCandidates;
    for (const candidate of candidates) {
      try {
        return await this.openProject(candidate.id);
      } catch (error) {
        if (error instanceof WorkspaceError && (error.code === 'stale-operation' || error.code === 'disposed')) throw error;
        // Continue to the next durable candidate if a full load (for example,
        // asset verification) rejects this one.
      }
    }
    return undefined;
  }

  async deleteProject(projectId: string): Promise<void> {
    this.ensureActiveWorkspace();
    if (!isProjectId(projectId)) return this.rememberOperationError(new WorkspaceError('save-failed', 'Project ID is invalid.'), 'save-failed', 'Unable to delete the local project.');
    const token = this.startOperation();
    try {
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
      this.ensureOperation(token);
      this.operationError = null;
      this.notify();
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === 'stale-operation') throw error;
      return this.rememberOperationError(error, 'save-failed', 'Unable to delete the local project.');
    }
  }

  async listFolderIndex(): Promise<ProjectFolderIndex> {
    const token = this.operationToken;
    try {
      const index = this.repository.listFolderIndex ? await this.repository.listFolderIndex() : { folders: [], assignments: [] };
      this.ensureOperation(token);
      this.operationError = null;
      this.notify();
      return { folders: index.folders.map((folder) => ({ ...folder })), assignments: index.assignments.map((assignment) => ({ ...assignment })) };
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === 'stale-operation') throw error;
      return this.rememberOperationError(error, 'save-failed', 'Unable to list local folders.');
    }
  }

  async createFolder(name: string, parentId: string | null = null): Promise<ProjectFolder> {
    const token = this.startOperation();
    try {
      if (!this.repository.createFolder) throw new WorkspaceError('save-failed', 'This repository cannot create folders.');
      const folder = await this.repository.createFolder({ name, parentId, id: this.projectIdFactory() });
      this.ensureOperation(token);
      this.operationError = null;
      this.notify();
      return { ...folder };
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === 'stale-operation') throw error;
      return this.rememberOperationError(error, 'save-failed', 'Unable to create the folder.');
    }
  }

  async renameFolder(folderId: string, name: string): Promise<ProjectFolder> {
    const token = this.startOperation();
    try {
      if (!this.repository.renameFolder) throw new WorkspaceError('save-failed', 'This repository cannot rename folders.');
      const folder = await this.repository.renameFolder(folderId, name);
      this.ensureOperation(token);
      this.operationError = null;
      this.notify();
      return { ...folder };
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === 'stale-operation') throw error;
      return this.rememberOperationError(error, 'save-failed', 'Unable to rename the folder.');
    }
  }

  async deleteFolder(folderId: string): Promise<void> {
    const token = this.startOperation();
    try {
      if (!this.repository.deleteFolder) throw new WorkspaceError('save-failed', 'This repository cannot delete folders.');
      await this.repository.deleteFolder(folderId);
      this.ensureOperation(token);
      this.operationError = null;
      this.notify();
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === 'stale-operation') throw error;
      return this.rememberOperationError(error, 'save-failed', 'Unable to delete the folder.');
    }
  }

  async moveProjectToFolder(projectId: string, folderId: string | null): Promise<void> {
    const token = this.startOperation();
    try {
      if (!this.repository.moveProjectToFolder) throw new WorkspaceError('save-failed', 'This repository cannot move projects between folders.');
      await this.repository.moveProjectToFolder(projectId, folderId);
      this.ensureOperation(token);
      this.operationError = null;
      this.notify();
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === 'stale-operation') throw error;
      return this.rememberOperationError(error, 'save-failed', 'Unable to move the project.');
    }
  }

  async moveFolder(folderId: string, parentId: string | null): Promise<void> {
    const token = this.startOperation();
    try {
      if (!this.repository.moveFolder) throw new WorkspaceError('save-failed', 'This repository cannot move folders.');
      await this.repository.moveFolder(folderId, parentId);
      this.ensureOperation(token);
      this.operationError = null;
      this.notify();
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === 'stale-operation') throw error;
      return this.rememberOperationError(error, 'save-failed', 'Unable to move the folder.');
    }
  }

  async promoteRecovery(revision?: number): Promise<ProjectSession> {
    const session = this.ensureActiveSession();
    if (!session.usingRecovery) return session;
    if (!this.repository.promoteRecoveryRevision) throw new WorkspaceError('recovery-promotion-required', 'This repository cannot promote recovery revisions.');
    const token = this.startOperation();
    const record = await this.repository.promoteRecoveryRevision(session.projectId, revision);
    this.ensureOperation(token);
    const promoted = this.makeSession(record, false, record.health ?? null);
    this.ensureOperation(token);
    this.setActive(promoted);
    this.operationError = null;
    this.notify();
    return promoted;
  }

  async promoteRecoveryRevision(revision?: number): Promise<ProjectSession> {
    return this.promoteRecovery(revision);
  }

  async restoreRecovery(revision?: number): Promise<ProjectSession> {
    return this.promoteRecovery(revision);
  }

  async importProject(input: Uint8Array | ArrayBuffer | Blob, options: ArchiveImportOptions = {}): Promise<ProjectSession> {
    const token = this.startOperation();
    await this.flushActiveBeforeSwitch(token);
    this.ensureOperation(token);
    const importOptions: ArchiveImportOptions = { ...options, collision: options.collision ?? 'reject' };
    try {
      const record = await this.repository.importProject(input, importOptions);
      this.ensureOperation(token);
      const session = this.makeSession(record, false, record.health ?? null);
      this.ensureOperation(token);
      this.setActive(session);
      this.operationError = null;
      this.notify();
      return session;
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === 'stale-operation') throw error;
      return this.rememberOperationError(error, 'import-failed', 'Unable to import the local project archive.');
    }
  }

  async importProjectArchive(input: Uint8Array | ArrayBuffer | Blob, options: ArchiveImportOptions = {}): Promise<ProjectSession> {
    return this.importProject(input, options);
  }

  async importProjectAsCopy(input: Uint8Array | ArrayBuffer | Blob, options: ArchiveImportOptions = {}): Promise<ProjectSession> {
    return this.importProject(input, { ...options, targetProjectId: options.targetProjectId ?? this.projectIdFactory(), collision: options.collision ?? 'reject' });
  }

  async exportActiveProject(): Promise<Uint8Array> {
    const session = this.ensureActiveSession();
    const token = this.operationToken;
    await session.flush();
    this.ensureOperation(token);
    try {
      const archive = await this.repository.exportProject(session.projectId);
      this.ensureOperation(token);
      this.operationError = null;
      this.notify();
      return archive;
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === 'stale-operation') throw error;
      return this.rememberOperationError(error, 'save-failed', 'Unable to export the local project archive.');
    }
  }

  async exportProjectArchive(): Promise<Uint8Array> {
    return this.exportActiveProject();
  }

  async forkActiveProject(options: CreateProjectOptions = {}): Promise<ProjectSession> {
    const source = this.ensureActiveSession();
    if (source.saveState.status !== 'conflict' && source.saveState.status !== 'error') await source.flush();
    const projectId = options.id ?? this.projectIdFactory();
    const copiedMaterialSettings = options.materialSettings ?? source.metadata.materialSettings;
    const copiedAidaCount = options.aidaCount === undefined ? source.metadata.aidaCount : options.aidaCount;
    const copiedUnits = options.units === undefined ? source.metadata.units : options.units;
    const copiedSourceImage = options.sourceImage ?? source.sourceImage;
    // When the caller supplies custom assets without a matching descriptor,
    // the source reference would dangle, so only carry it when the asset set
    // is the source set (or a matching descriptor was supplied explicitly).
    const carrySourceImage = copiedSourceImage !== undefined && (options.assets === undefined || options.sourceImage !== undefined);
    const copy = await this.createProjectInternal({ ...options, id: projectId, title: options.title ?? `${source.metadata.title} copy`, notes: options.notes ?? source.metadata.notes, aidaCount: copiedAidaCount, units: copiedUnits, document: cloneDocument(source.document), assets: options.assets ?? source.assets, ...(copiedMaterialSettings === undefined ? {} : { materialSettings: copiedMaterialSettings }), ...(carrySourceImage && copiedSourceImage !== undefined ? { sourceImage: copiedSourceImage } : {}) }, false, true);
    return copy;
  }

  async saveAsCopy(options: CreateProjectOptions = {}): Promise<ProjectSession> {
    return this.forkActiveProject(options);
  }

  execute(command: DomainCommand) {
    return this.ensureActiveSession().execute(command);
  }

  async updateActiveMaterialSettings(changes: Parameters<ProjectSession['updateMaterialSettings']>[0]): Promise<void> {
    const session = this.ensureActiveSession();
    try {
      session.updateMaterialSettings(changes);
      if (this.debounceMs === 0) await session.flush();
      this.operationError = null;
      this.notify();
    } catch (error) {
      return this.rememberOperationError(error, 'save-failed', 'Unable to update the active material settings.');
    }
  }

  async updateMaterialSettings(changes: Parameters<ProjectSession['updateMaterialSettings']>[0]): Promise<void> {
    return this.updateActiveMaterialSettings(changes);
  }

  async setMaterialSettings(changes: Parameters<ProjectSession['updateMaterialSettings']>[0]): Promise<void> {
    return this.updateActiveMaterialSettings(changes);
  }

  async updateMaterialAssumptions(changes: Parameters<ProjectSession['updateMaterialSettings']>[0]): Promise<void> {
    return this.updateActiveMaterialSettings(changes);
  }

  async setActiveSourceImage(settings: SourceImageSettingsInput): Promise<void> {
    const session = this.ensureActiveSession();
    try {
      session.setSourceImage(settings);
      if (this.debounceMs === 0) await session.flush();
      this.operationError = null;
      this.notify();
    } catch (error) {
      return this.rememberOperationError(error, 'save-failed', 'Unable to update the active source image.');
    }
  }

  async setSourceImage(settings: SourceImageSettingsInput): Promise<void> {
    return this.setActiveSourceImage(settings);
  }

  async updateSourceImageSettings(settings: SourceImageSettingsInput): Promise<void> {
    return this.setActiveSourceImage(settings);
  }

  /**
   * Interleaved entry point for descriptor-only reference changes (move,
   * resize, opacity, visibility). One call pushes exactly one history entry
   * shared with document edits. Gesture layers coalesce before calling:
   * one call per drag commit, one per arrow nudge, one per slider release.
   */
  async applyTraceImageChange(next: SourceImageDescriptor | undefined, options?: { label?: string }): Promise<void> {
    const session = this.ensureActiveSession();
    try {
      session.applyTraceImageChange(next, options);
      if (this.debounceMs === 0) await session.flush();
      this.operationError = null;
      this.notify();
    } catch (error) {
      return this.rememberOperationError(error, 'save-failed', 'Unable to update the active source image.');
    }
  }

  async replaceSourceImage(input: SourceImageReplacementInput | ProjectAssetInput, settings?: SourceImageSettingsInput): Promise<void> {
    const session = this.ensureActiveSession();
    try {
      await session.replaceSourceImage(input, settings);
      this.operationError = null;
      this.notify();
    } catch (error) {
      return this.rememberOperationError(error, 'save-failed', 'Unable to replace the active source image.');
    }
  }

  async replaceSourceImageAsset(input: SourceImageReplacementInput | ProjectAssetInput, settings?: SourceImageSettingsInput): Promise<void> {
    return this.replaceSourceImage(input, settings);
  }

  async clearSourceImage(): Promise<void> {
    return this.removeSourceImage();
  }

  /** Atomically removes the source-image descriptor and its retained asset. */
  async removeSourceImage(): Promise<void> {
    const session = this.ensureActiveSession();
    try {
      await session.removeSourceImage();
      this.operationError = null;
      this.notify();
    } catch (error) {
      return this.rememberOperationError(error, 'save-failed', 'Unable to clear the active source image.');
    }
  }

  async removeSourceImageAsset(): Promise<void> {
    return this.removeSourceImage();
  }

  setBackstitchCompletion(id: number, completed: boolean) {
    return this.ensureActiveSession().setBackstitchCompletion(id, completed);
  }

  toggleBackstitchCompletion(id: number) {
    return this.ensureActiveSession().toggleBackstitchCompletion(id);
  }

  completeBackstitches(ids: Uint32Array, operation: Parameters<ProjectSession['completeBackstitches']>[1] = 'set') {
    return this.ensureActiveSession().completeBackstitches(ids, operation);
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

  async retrySave(): Promise<void> {
    const session = this.ensureActiveSession();
    await session.retrySave();
    this.operationError = null;
    this.notify();
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

export const ApplicationService = ProjectWorkspace;
export const ProjectWorkspaceService = ProjectWorkspace;
export const WorkspaceService = ProjectWorkspace;

export function createWorkspace(options: WorkspaceOptions = {}): ProjectWorkspace {
  return new ProjectWorkspace(options);
}

export const createApplicationService = createWorkspace;

export function getEmptyWorkspaceState(): ActiveWorkspaceState {
  return emptyState();
}
