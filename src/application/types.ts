import type {
  CommandResult,
  DisplayUnits,
  DocumentEditor,
  MaterialSettingsV2,
  MaterialSettingsUpdate,
  NormalizedMaterialSettings,
  PatternMetrics,
  PatternDocument,
  PatternSettings
} from '../domain';
import type {
  ArchiveImportOptions,
  ProjectAsset,
  ProjectAssetInput,
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
    document: PatternDocument,
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
  aidaCount?: number;
  units?: DisplayUnits;
}

export interface CreateProjectOptions extends StarterProjectOptions {
  document?: PatternDocument;
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
  /** `null` clears the optional fabric count. */
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
}

export type MaterialSettingsChanges = MaterialSettingsUpdate;

export interface ProjectSessionOptions {
  repository: WorkspaceRepository;
  metadata: ProjectMetadata;
  document: PatternDocument;
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
