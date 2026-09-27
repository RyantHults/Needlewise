import type {
  CommandResult,
  DisplayUnits,
  DocumentEditor,
  LayeredDocument,
  LayerType,
  MaterialSettingsV2,
  MaterialSettingsUpdate,
  NormalizedMaterialSettings,
  PatternMetrics,
  PatternDocument,
  PatternSettings
} from '../domain';
import type {
  ArchiveImportOptions,
  CreateFolderInput,
  ProjectAsset,
  ProjectAssetInput,
  ProjectFolder,
  ProjectFolderIndex,
  ProjectMetadata,
  ProjectHealth,
  PreparedDocumentCapability,
  ProjectRecord,
  PersistencePreparationClient,
  SessionHistoryEnvelope,
  StoredProjectHead,
  SourceImageDescriptor,
  SaveOptions,
  SaveResult
} from '../persistence';
import type { ProgressActivity } from '../persistence';
import type { SessionProgressStats } from './progress';
import type { AcceptedConversionDraft } from '../conversion/image-to-pattern';
import type { InstalledCatalogRegistry } from '../catalog';

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'conflict' | 'disposed';

export interface SaveState {
  status: SaveStatus;
  dirty: boolean;
  pendingRevision: number | null;
  lastSavedRevision: number | null;
  metadataDirty: boolean;
  assetsDirty: boolean;
  conflict: boolean;
  error: Error | null;
}

export interface WorkspaceRepository {
  save(
    projectId: string,
    metadata: ProjectMetadata,
    document: LayeredDocument,
    assets?: readonly ProjectAssetInput[],
    options?: SaveOptions
  ): Promise<SaveResult>;
  savePrepared?(
    projectId: string,
    metadata: ProjectMetadata,
    prepared: PreparedDocumentCapability,
    assets?: readonly ProjectAssetInput[],
    options?: SaveOptions
  ): Promise<SaveResult>;
  load(projectId: string): Promise<ProjectRecord | undefined>;
  listProjects(): Promise<ProjectMetadata[]>;
  deleteProject(projectId: string): Promise<void>;
  exportProject(projectId: string): Promise<Uint8Array>;
  importProject(input: Uint8Array | ArrayBuffer | Blob, options?: ArchiveImportOptions): Promise<ProjectRecord>;
  getAsset?(projectId: string, assetId: string): Promise<ProjectAsset | undefined>;
  listProjectHealth?(): Promise<ProjectHealth[]>;
  inspectProjectHealth?(projectId: string): Promise<ProjectHealth | undefined>;
  loadRecoveryRevision?(projectId: string, revision?: number): Promise<ProjectRecord | undefined>;
  promoteRecoveryRevision?(projectId: string, revision?: number): Promise<ProjectRecord>;
  listFolderIndex?(): Promise<ProjectFolderIndex>;
  createFolder?(input: CreateFolderInput): Promise<ProjectFolder>;
  renameFolder?(folderId: string, name: string): Promise<ProjectFolder>;
  deleteFolder?(folderId: string): Promise<void>;
  moveProjectToFolder?(projectId: string, folderId: string | null): Promise<void>;
  moveFolder?(folderId: string, parentId: string | null): Promise<void>;
  close?(): Promise<void> | void;
}

export interface WorkspaceClock {
  now(): number;
}

export interface StarterProjectOptions {
  id?: string;
  title?: string;
  notes?: string;
  width?: number;
  height?: number;
  /** The Canvas stitch count, stored in the document settings. */
  aidaCount?: number;
  units?: DisplayUnits;
}

export interface CreateProjectOptions extends StarterProjectOptions {
  /** A single surface becomes the "Stitches" and "Specialty" layers. */
  document?: PatternDocument | LayeredDocument;
  settings?: Partial<PatternSettings>;
  assets?: readonly ProjectAssetInput[];
  materialSettings?: MaterialSettingsV2;
  sourceImage?: SourceImageDescriptor;
}

export interface CreateConvertedProjectOptions extends StarterProjectOptions {
  readonly draft: AcceptedConversionDraft;
  readonly settings?: Partial<PatternSettings>;
  readonly assets?: readonly ProjectAssetInput[];
  readonly sourceImageAsset?: ProjectAssetInput;
  readonly materialSettings?: MaterialSettingsV2;
}

export interface ActiveMetadataChanges {
  title?: string;
  notes?: string;
  /** The Canvas stitch count; an undoable document settings change. `null` is ignored. */
  aidaCount?: number | null;
  /** `null` clears the optional display units (metric is the default). */
  units?: DisplayUnits | null;
}

export interface WorkspaceOptions {
  repository?: WorkspaceRepository;
  preparationClient?: PersistencePreparationClient;
  clock?: WorkspaceClock | (() => number);
  debounceMs?: number;
  projectIdFactory?: () => string;
  catalogRegistry?: InstalledCatalogRegistry;
}

export interface WorkspaceInitializationOptions {
  projectId?: string;
  autoOpenMostRecent?: boolean;
}

export interface ActiveWorkspaceState {
  projectId: string | null;
  metadata: ProjectMetadata | null;
  document: PatternDocument | null;
  health: ProjectHealth | null;
  usingRecovery: boolean;
  save: SaveState;
  error: Error | null;
  metrics?: PatternMetrics | null;
  sessionStats?: SessionProgressStats | null;
  activity?: ProgressActivity | null;
  dailyActivity?: ProgressActivity | null;
  materialSettings?: NormalizedMaterialSettings | null;
  sourceImage?: SourceImageDescriptor;
  layeredDocument?: LayeredDocument | null;
  layers?: readonly LayerSummary[];
  activeLayer?: ActiveLayerInfo | null;
}

export type MaterialSettingsChanges = MaterialSettingsUpdate;

export interface ProjectSessionOptions {
  repository: WorkspaceRepository;
  metadata: ProjectMetadata;
  document: LayeredDocument;
  head?: StoredProjectHead;
  preparationClient: PersistencePreparationClient;
  assets?: readonly ProjectAsset[];
  health?: ProjectHealth | null;
  usingRecovery?: boolean;
  activity?: ProgressActivity;
  materialSettings?: MaterialSettingsV2;
  history?: SessionHistoryEnvelope;
  sessionStartedAt?: number;
  historyLimitBytes?: number;
  clock: WorkspaceClock;
  debounceMs: number;
}

export type SessionCommandResult = CommandResult;
export type SessionEditor = DocumentEditor;

/** The selected row in the layers panel. Canvas and the reference image are not `layers` entries. */
export type ActiveLayerId = number | 'canvas' | 'reference';
export type ActiveLayerKind = 'stitch' | 'specialty' | 'canvas' | 'reference';

export interface ActiveLayerInfo {
  readonly id: ActiveLayerId;
  readonly kind: ActiveLayerKind;
  readonly visible: boolean;
  readonly name: string;
}

export interface LayerSummary {
  readonly id: number;
  readonly type: LayerType;
  readonly name: string;
  readonly visible: boolean;
  /** Absolute index in `LayeredDocument.layers`, bottom to top. */
  readonly index: number;
}

/** Where a paste goes, from `resolvePaste`. `layerId` null and `create` false means nothing is pasted. */
export interface PasteDestination {
  readonly layerType: LayerType;
  readonly layerId: number | null;
  readonly create: boolean;
  /** A short toast when the paste did not simply land on the selected layer. */
  readonly message?: string;
}

export interface PasteCommitResult {
  readonly result: CommandResult;
  readonly layerId: number | null;
  readonly message?: string;
}

/** What the renderer must redraw after the last document change. */
export interface CompositeInvalidation {
  readonly revision: number;
  /** Redraw every cell. */
  readonly full: boolean;
  /** Composite cells that changed when `full` is false. Absent: no cell changed (backstitches, palette or settings may have). */
  readonly indices?: Uint32Array;
}

export interface EditorLayerSnapshot {
  /** The selected layer's own surface, or null for Canvas and Reference. Read-only. */
  readonly editSurface: PatternDocument | null;
  readonly activeLayer: ActiveLayerInfo;
  readonly composite: PatternDocument;
  readonly compositeInvalidation: CompositeInvalidation | null;
}
