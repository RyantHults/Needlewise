import type {
  CommandResult,
  DisplayUnits,
  LayeredDocument,
  LayerType,
  MaterialSettingsV2,
  NormalizedMaterialSettings,
  PatternMetrics,
  PatternDocument,
  PatternSettings
} from '../domain';
import type {
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
import type { AcceptedConversionDraft } from '../conversion/image-to-pattern';

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
  savePrepared(
    projectId: string,
    metadata: ProjectMetadata,
    prepared: PreparedDocumentCapability,
    assets?: readonly ProjectAssetInput[],
    options?: SaveOptions
  ): Promise<SaveResult>;
  load(projectId: string): Promise<ProjectRecord | undefined>;
  listProjects(): Promise<ProjectMetadata[]>;
  deleteProject(projectId: string): Promise<void>;
  getAsset?(projectId: string, assetId: string): Promise<ProjectAsset | undefined>;
  inspectProjectHealth?(projectId: string): Promise<ProjectHealth | undefined>;
  loadRecoveryRevision?(projectId: string, revision?: number): Promise<ProjectRecord | undefined>;
  listFolderIndex(): Promise<ProjectFolderIndex>;
  createFolder(input: CreateFolderInput): Promise<ProjectFolder>;
  renameFolder(folderId: string, name: string): Promise<ProjectFolder>;
  deleteFolder(folderId: string): Promise<void>;
  moveProjectToFolder(projectId: string, folderId: string | null): Promise<void>;
  moveFolder(folderId: string, parentId: string | null): Promise<void>;
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
  /** `null` clears the optional display units (metric is the default). */
  units?: DisplayUnits | null;
}

export interface WorkspaceOptions {
  repository?: WorkspaceRepository;
  preparationClient?: PersistencePreparationClient;
  clock?: WorkspaceClock | (() => number);
  debounceMs?: number;
  projectIdFactory?: () => string;
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
  materialSettings?: NormalizedMaterialSettings | null;
  sourceImage?: SourceImageDescriptor;
  layeredDocument?: LayeredDocument | null;
  layers?: readonly LayerSummary[];
  activeLayer?: ActiveLayerInfo | null;
  layerSelection?: LayerSelection | null;
  /** Track's in-memory mark history; see `ProjectSession.markProgress`. */
  canUndoMark?: boolean;
  canRedoMark?: boolean;
}

export interface ProjectSessionOptions {
  repository: WorkspaceRepository;
  metadata: ProjectMetadata;
  document: LayeredDocument;
  head?: StoredProjectHead;
  preparationClient: PersistencePreparationClient;
  assets?: readonly ProjectAsset[];
  health?: ProjectHealth | null;
  usingRecovery?: boolean;
  materialSettings?: MaterialSettingsV2;
  history?: SessionHistoryEnvelope;
  historyLimitBytes?: number;
  clock: WorkspaceClock;
  debounceMs: number;
}

export type SessionCommandResult = CommandResult;

/** The selected row in the layers panel. Canvas and the reference image are not `layers` entries. */
export type ActiveLayerId = number | 'canvas' | 'reference';
export type ActiveLayerKind = 'stitch' | 'specialty' | 'canvas' | 'reference';

export interface ActiveLayerInfo {
  readonly id: ActiveLayerId;
  readonly kind: ActiveLayerKind;
  readonly visible: boolean;
  readonly name: string;
}

/** The layers panel selection. Session memory only, like the active layer. */
export interface LayerSelection {
  /** The primary layer: tools, controls, copy/paste. Same as the active layer. */
  readonly primary: ActiveLayerId;
  /** Every selected stitch/specialty layer id, bottom to top; includes primary when it is numeric. Empty when primary is canvas or reference. */
  readonly layerIds: readonly number[];
}

export interface LayerSummary {
  readonly id: number;
  readonly type: LayerType;
  readonly name: string;
  readonly visible: boolean;
  /** Absolute index in `LayeredDocument.layers`, bottom to top. */
  readonly index: number;
}

/** Where a paste goes, from `resolvePaste` or `resolveMultiLayerPaste`. `layerId` null and `create` false means nothing is pasted. */
export interface PasteDestination {
  readonly layerType: LayerType;
  readonly layerId: number | null;
  readonly create: boolean;
  /** A short toast when the paste did not simply land on the selected layer. */
  readonly message?: string;
}

export interface PasteCommitResult {
  readonly result: CommandResult;
  /** Every layer the paste landed on; empty when nothing was pasted. */
  readonly layerIds: readonly number[];
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
  /** Selected stitch/specialty layer ids, bottom to top. */
  readonly selectedLayerIds: readonly number[];
  readonly composite: PatternDocument;
  readonly compositeInvalidation: CompositeInvalidation | null;
}
