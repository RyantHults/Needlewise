import { DOCUMENT_SCHEMA_VERSION } from '../domain';
import type { DisplayUnits, DocumentEditorHistoryDto, NormalizedMaterialSettings, PatternDocument } from '../domain';
import type { ProgressActivity } from './activity';

export const PERSISTENCE_SCHEMA_VERSION = 3 as const;
export const LEGACY_PERSISTENCE_SCHEMA_VERSION = 1 as const;
export const PRIOR_PERSISTENCE_SCHEMA_VERSION = 2 as const;
export const ARCHIVE_FORMAT = 'needlewise-project' as const;
export const SESSION_HISTORY_ENVELOPE_VERSION = 1 as const;
export const MAX_SESSION_HISTORY_BYTES = 16 * 1024 * 1024;
export const MAX_SESSION_HISTORY_DECODE_BYTES = 64 * 1024 * 1024;
export const MAX_SESSION_HISTORY_ENTRIES = 100_000;
export const MAX_SESSION_HISTORY_LABEL_CHARS = 4_000;

export interface NormalizedSourceImageCrop {
  /** Normalized source-image coordinates, each in the closed interval [0, 1]. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SourceImageChartBounds {
  /** Integer chart-cell bounds occupied by the source image. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export type SourceImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';
export type SourceImageOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface SourceImageDescriptor {
  assetId: string;
  mimeType: SourceImageMimeType;
  width: number;
  height: number;
  /** EXIF orientation retained by the JPEG asset, when present. */
  orientation?: SourceImageOrientation;
  crop: NormalizedSourceImageCrop;
  chartBounds: SourceImageChartBounds;
  traceVisible: boolean;
  opacity: number;
}

export type SourceImageSettings = SourceImageDescriptor;

export interface SourceImageSettingsInput {
  assetId: string;
  mimeType?: SourceImageMimeType;
  width?: number;
  height?: number;
  orientation?: SourceImageOrientation;
  crop?: NormalizedSourceImageCrop;
  chartBounds?: SourceImageChartBounds;
  traceVisible?: boolean;
  opacity?: number;
}

export interface SourceImageReplacementInput {
  asset: ProjectAssetInput;
  settings: SourceImageSettingsInput;
}

/** The bounded, cacheable color sample used by project listings. */
export interface ProjectThumbnailSummary {
  version: 1;
  revision: number;
  columns: number;
  rows: number;
  /** Palette index zero is always the neutral fabric color. */
  palette: string[];
  /** One palette index for every sampled cell, in row-major order. */
  indices: number[];
}

export type ProjectThumbnail = ProjectThumbnailSummary;

export interface ProjectMetadata {
  id: string;
  title: string;
  notes: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  /** Optional fabric count in stitches per inch. Old records omit it. */
  aidaCount?: number;
  /** Optional display units for measurement readouts. Old records omit it; metric is the default. */
  units?: DisplayUnits;
  /** Persisted material assumptions; derived estimates remain out of the document. */
  materialSettings?: NormalizedMaterialSettings;
  /** Optional semantic reference to a checked, separately stored source image asset. */
  sourceImage?: SourceImageDescriptor;
  /** Canonical dimensions of the saved document, when available. */
  width?: number;
  height?: number;
  /** Canonical bounded color sample of the saved document, when available. */
  thumbnail?: ProjectThumbnailSummary;
}

export interface ProjectAssetInput {
  id: string;
  name: string;
  mimeType: string;
  data: Blob | Uint8Array | ArrayBuffer;
}

export interface ProjectAsset {
  id: string;
  name: string;
  mimeType: string;
  data: Uint8Array;
  checksum: string;
}

/** Opaque capability for one exact revision-advance save attempt. */
declare const preparedDocumentCapabilityBrand: unique symbol;
export interface PreparedDocumentCapability {
  readonly [preparedDocumentCapabilityBrand]: never;
}

export interface StoredDocumentSnapshot {
  projectId: string;
  revision: number;
  bytes: Uint8Array;
  checksum: string;
  savedAt: number;
}

export interface StoredProjectAsset extends ProjectAsset {
  projectId: string;
}

export interface StoredDailyProgressAggregate {
  projectId: string;
  date: string;
  marked: number;
  unmarked: number;
}

export interface ProjectRecord {
  metadata: ProjectMetadata;
  document: PatternDocument;
  /** Exact durable current head, when supplied by a repository. */
  head?: StoredProjectHead;
  /** Valid local session history anchored to the returned current head. */
  history?: SessionHistoryEnvelope;
  recovery: {
    revision: number;
    document: PatternDocument;
  } | null;
  assets: ProjectAsset[];
  /** Bounded, date-keyed progress activity; absent means an older record. */
  activity?: ProgressActivity;
  /** Health is populated by repository loads when a related recovery record is bad. */
  health?: ProjectHealth;
}

export type SnapshotHealthStatus = 'valid' | 'corrupt' | 'missing';

export interface SnapshotHealth {
  status: SnapshotHealthStatus;
  revision: number | null;
  warning?: string;
}

export type AssetHealthStatus = 'unchecked' | 'valid' | 'corrupt' | 'missing';

export interface AssetHealth {
  status: AssetHealthStatus;
  count: number;
  validCount?: number;
  corruptCount?: number;
  warning?: string;
  warnings?: string[];
}

export type SourceImageHealthStatus = 'unchecked' | 'valid' | 'corrupt' | 'missing';

export interface SourceImageHealth {
  assetId: string;
  status: SourceImageHealthStatus;
  warning?: string;
}

/** A non-destructive, startup-friendly view of a local project's durability. */
export interface ProjectHealth {
  projectId: string;
  metadata: ProjectMetadata | null;
  current: SnapshotHealth;
  recovery: SnapshotHealth;
  assets: AssetHealth;
  sourceImage?: SourceImageHealth;
  usableRevision: number | null;
  recoveryAvailable: boolean;
  warnings: string[];
}

export interface SaveResult {
  committed: boolean;
  stale: boolean;
  revision: number;
  /** Exact durable current head after a successful repository save. */
  head?: StoredProjectHead;
}

/** The durable document operation performed by a project save. */
export type SaveCommitMode = 'replace' | 'retain';

/** Compact durable identity for the current document snapshot. */
export interface StoredProjectHead {
  projectId: string;
  revision: number;
  checksum: string;
  /** Repository-owned monotonic counter for session-history generations. */
  historyGeneration?: number;
}

export interface TraceHistoryAsset {
  id: string;
  name: string;
  mimeType: string;
  data: Uint8Array;
  checksum: string;
}

export type TraceHistoryAssetState =
  | { kind: 'unchanged' }
  | { kind: 'absent' }
  | { kind: 'captured'; asset: TraceHistoryAsset };

export interface TraceHistoryEntry {
  label: string;
  sourceBefore: SourceImageDescriptor | null;
  sourceAfter: SourceImageDescriptor | null;
  assetBefore: TraceHistoryAssetState;
  assetAfter: TraceHistoryAssetState;
}

export type SessionHistoryMarkerKind = 'document' | 'trace';

export interface SessionHistoryMarker {
  kind: SessionHistoryMarkerKind;
  index: number;
}

export interface SessionHistoryMarkerStacks {
  undo: readonly SessionHistoryMarker[];
  redo: readonly SessionHistoryMarker[];
}

export interface SessionHistoryEnvelope {
  version: typeof SESSION_HISTORY_ENVELOPE_VERSION;
  document: DocumentEditorHistoryDto;
  trace: {
    undo: readonly TraceHistoryEntry[];
    redo: readonly TraceHistoryEntry[];
  };
  /** Chronological unified stacks; indices refer to the matching document/trace stack. */
  undoOrder: readonly SessionHistoryMarker[];
  redoOrder: readonly SessionHistoryMarker[];
}

export type SessionHistoryInput = SessionHistoryEnvelope | DocumentEditorHistoryDto;

/** Local-only session history for one exact document/trace state. */
export interface StoredDocumentHistory {
  projectId: string;
  revision: number;
  checksum: string;
  generation: number;
  traceFingerprint: string;
  history: SessionHistoryEnvelope;
  savedAt: number;
}

export type StoredSessionHistory = StoredDocumentHistory;

/**
 * The head a retain commit is allowed to update. A checksum is optional so a
 * caller with a complete head can protect against a same-revision replacement
 * without preparing the document again.
 */
export interface ExpectedProjectHead {
  projectId?: string;
  revision: number;
  checksum?: string;
  historyGeneration?: number;
}

export interface SaveOptions {
  /** Legacy spelling for allowing a same-revision save when no mode is supplied. */
  allowSameRevision?: boolean;
  /** Explicitly select whether the document snapshot is replaced or retained. */
  mode?: SaveCommitMode;
  /** Alias for `mode`, for callers that name the operation a commit. */
  commit?: SaveCommitMode;
  /** Alias for `mode` for repository integrations using commitMode terminology. */
  commitMode?: SaveCommitMode;
  /** Expected current document revision for a retain commit. */
  expectedRevision?: number;
  /** Expected current head for a retain commit; a number is shorthand for revision. */
  expectedHead?: number | ExpectedProjectHead;
  /** Replaces the project's durable activity snapshot when supplied. */
  activity?: ProgressActivity;
  /** Replaces the local undo/redo history when supplied. */
  history?: SessionHistoryInput;
  /** Explicitly permits copying already-normalized legacy asset IDs. */
  allowLegacyAssetIds?: boolean;
  /** Internal exact preparation request identity for a prepared commit. */
  preparedRequestId?: string;
}

export interface ArchiveAssetManifest {
  id: string;
  /** v2 writes safe IDs directly and maps legacy IDs to a binary-safe path. */
  path: string;
  name: string;
  mimeType: string;
  byteLength: number;
  sha256: string;
}

export interface ArchiveManifest {
  format: typeof ARCHIVE_FORMAT;
  archiveVersion: typeof PERSISTENCE_SCHEMA_VERSION;
  projectId: string;
  metadata: {
    path: 'metadata.json';
    byteLength: number;
    sha256: string;
  };
  document: {
    path: 'document.bin';
    schemaVersion: typeof DOCUMENT_SCHEMA_VERSION;
    byteLength: number;
    sha256: string;
  };
  activity?: {
    path: 'activity.json';
    byteLength: number;
    sha256: string;
  };
  assets: ArchiveAssetManifest[];
}

export interface ArchiveBundle {
  manifest: ArchiveManifest;
  metadata: ProjectMetadata;
  document: PatternDocument;
  assets: ProjectAsset[];
  activity?: ProgressActivity;
  warnings?: string[];
}

export interface ArchiveExportOptions {
  onWarning?: (warning: string) => void;
}

export interface ArchiveImportOptions {
  targetProjectId?: string;
  /** Import rejects an existing project unless replacement is explicitly requested. */
  collision?: 'reject' | 'replace';
  signal?: AbortSignal;
}

export interface RepositoryOptions {
  databaseName?: string;
  now?: () => number;
}
