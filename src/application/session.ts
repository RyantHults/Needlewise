import {
  canAddLayer as canAddLayerOfType,
  commandLayerType,
  commandScope,
  DocumentEditor,
  DomainError,
  findLayer,
  layerAddCommand,
  layerDeleteCommand,
  layerDuplicateCommand,
  LayerErrorCode,
  layerMergeCommand,
  layerMoveCommand,
  layerRenameCommand,
  layerSetVisibilityCommand,
  layerSurface,
  LayerType,
  MAX_LAYERS_PER_TYPE,
  normalizeAidaCount,
  normalizeDisplayUnits,
  normalizeMaterialSettings,
  pasteFragmentCommand,
  topmostVisibleLayer,
  type MetricsOptions,
  updateMaterialSettings,
  type MaterialSettingsUpdate,
  type NormalizedMaterialSettings,
  type CommandResult,
  type DomainCommand,
  type LayeredDocument,
  type PatternDocument,
  type PatternFragment,
  type Point
} from '../domain';
import { cloneLayeredDocument, PersistenceError } from '../persistence';
import {
  cloneProgressActivity,
  normalizeSourceImageDescriptor,
  normalizeSourceImageAsset,
  validateSourceImageDescriptor,
  MAX_SESSION_HISTORY_BYTES,
  type ProgressActivity,
  type ProjectAsset,
  type ProjectAssetInput,
  type ProjectHealth,
  type ProjectMetadata,
  type SaveResult,
  type SaveOptions,
  type PersistencePreparationClient,
  SESSION_HISTORY_ENVELOPE_VERSION,
  type SessionHistoryEnvelope,
  type TraceHistoryAsset,
  type TraceHistoryAssetState,
  type TraceHistoryEntry as PersistedTraceHistoryEntry,
  type StoredProjectHead,
  type SourceImageDescriptor,
  type SourceImageReplacementInput,
  type SourceImageSettingsInput
} from '../persistence';
import { WorkspaceError } from './errors';
import { ProgressMetricsService, type SessionProgressStats } from './progress';
import type {
  ActiveLayerId,
  ActiveLayerInfo,
  CompositeInvalidation,
  EditorLayerSnapshot,
  LayerSummary,
  PasteCommitResult,
  PasteDestination,
  ProjectSessionOptions,
  MaterialSettingsChanges,
  SaveState,
  SessionCommandResult,
  WorkspaceRepository
} from './types';

function asError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error;
  return new WorkspaceError('save-failed', fallback, error);
}

function cloneAsset(asset: ProjectAsset): ProjectAsset {
  return { ...asset, data: new Uint8Array(asset.data) };
}

function cloneSourceImage(sourceImage: SourceImageDescriptor | undefined): SourceImageDescriptor | undefined {
  return sourceImage === undefined ? undefined : {
    ...sourceImage,
    crop: { ...sourceImage.crop },
    chartBounds: { ...sourceImage.chartBounds }
  };
}

function cloneHealth(health: ProjectHealth | null): ProjectHealth | null {
  if (!health) return null;
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

interface SaveAttempt {
  revision: number;
  metadataVersion: number;
  assetsVersion: number;
  historyVersion: number;
  mutationSequence: number;
}

export const MAX_AUTOSAVE_DIRTY_AGE_MS = 5_000;

export interface TraceImageHistoryOptions {
  label?: string;
}

interface TraceHistoryEntry {
  label: string;
  beforeDescriptor: SourceImageDescriptor | undefined;
  afterDescriptor: SourceImageDescriptor | undefined;
  beforeAsset: ProjectAsset | undefined;
  afterAsset: ProjectAsset | undefined;
}

type HistoryKind = 'document' | 'trace';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneTraceAsset(asset: ProjectAsset): TraceHistoryAsset {
  return { id: asset.id, name: asset.name, mimeType: asset.mimeType, data: new Uint8Array(asset.data), checksum: asset.checksum };
}

function toTraceAssetState(source: SourceImageDescriptor | undefined, asset: ProjectAsset | undefined, cloneAssetBytes = true): TraceHistoryAssetState {
  if (source === undefined) return { kind: 'absent' };
  if (asset === undefined) return { kind: 'unchanged' };
  if (asset.id !== source.assetId) throw new Error('Trace history asset does not match its source descriptor.');
  return {
    kind: 'captured',
    asset: cloneAssetBytes
      ? cloneTraceAsset(asset)
      : { id: asset.id, name: asset.name, mimeType: asset.mimeType, data: asset.data, checksum: asset.checksum }
  };
}

function fromTraceAssetState(state: unknown, source: SourceImageDescriptor | undefined): ProjectAsset | undefined {
  if (!isRecord(state) || typeof state.kind !== 'string') throw new Error('Trace history asset state is malformed.');
  if (state.kind === 'absent') {
    if (source !== undefined) throw new Error('Trace history absent asset has a source descriptor.');
    return undefined;
  }
  if (state.kind === 'unchanged') {
    if (source === undefined) throw new Error('Trace history unchanged asset has no source descriptor.');
    return undefined;
  }
  if (state.kind !== 'captured' || !isRecord(state.asset) || !(state.asset.data instanceof Uint8Array)) throw new Error('Trace history captured asset is malformed.');
  const asset = state.asset as unknown as TraceHistoryAsset;
  if (source === undefined || asset.id !== source.assetId || typeof asset.id !== 'string' || typeof asset.name !== 'string' || typeof asset.mimeType !== 'string' || typeof asset.checksum !== 'string' || !(asset.data instanceof Uint8Array)) throw new Error('Trace history captured asset does not match its source descriptor.');
  return { id: asset.id, name: asset.name, mimeType: asset.mimeType, data: new Uint8Array(asset.data), checksum: asset.checksum };
}

function toPersistedTraceEntry(entry: TraceHistoryEntry, cloneAssetBytes = true): PersistedTraceHistoryEntry {
  return {
    label: entry.label,
    sourceBefore: entry.beforeDescriptor === undefined ? null : cloneAssetBytes ? cloneSourceImage(entry.beforeDescriptor) as SourceImageDescriptor : entry.beforeDescriptor,
    sourceAfter: entry.afterDescriptor === undefined ? null : cloneAssetBytes ? cloneSourceImage(entry.afterDescriptor) as SourceImageDescriptor : entry.afterDescriptor,
    assetBefore: toTraceAssetState(entry.beforeDescriptor, entry.beforeAsset, cloneAssetBytes),
    assetAfter: toTraceAssetState(entry.afterDescriptor, entry.afterAsset, cloneAssetBytes)
  };
}

function isTypedArray(value: unknown): value is Uint8Array | Uint16Array | Uint32Array {
  if (!ArrayBuffer.isView(value)) return false;
  const tag = Object.prototype.toString.call(value);
  return tag === '[object Uint8Array]' || tag === '[object Uint16Array]' || tag === '[object Uint32Array]';
}

function estimateHistoryValueBytes(value: unknown, seen: WeakSet<object> = new WeakSet()): number {
  if (typeof value === 'string') return 16 + value.length * 2;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return 16;
  if (isTypedArray(value) || value instanceof ArrayBuffer) return 24 + (value instanceof ArrayBuffer ? value.byteLength : value.byteLength);
  if (typeof value !== 'object') throw new Error('Session history contains an unsupported value.');
  if (seen.has(value)) throw new Error('Session history contains a cycle.');
  seen.add(value);
  let total: number;
  if (Array.isArray(value)) {
    total = 24 + value.length * 8;
    for (const child of value) total += estimateHistoryValueBytes(child, seen);
  } else {
    total = 64 + Object.keys(value).length * 8;
    for (const [key, child] of Object.entries(value)) total += key.length * 2 + estimateHistoryValueBytes(child, seen);
  }
  seen.delete(value);
  return total;
}

function fromPersistedTraceEntry(entry: unknown): TraceHistoryEntry {
  if (!isRecord(entry) || typeof entry.label !== 'string' || !('sourceBefore' in entry) || !('sourceAfter' in entry) || !('assetBefore' in entry) || !('assetAfter' in entry)) throw new Error('Trace history entry is malformed.');
  const beforeDescriptor = entry.sourceBefore === null ? undefined : cloneSourceImage(validateSourceImageDescriptor(entry.sourceBefore));
  const afterDescriptor = entry.sourceAfter === null ? undefined : cloneSourceImage(validateSourceImageDescriptor(entry.sourceAfter));
  return {
    label: entry.label,
    beforeDescriptor,
    afterDescriptor,
    beforeAsset: fromTraceAssetState(entry.assetBefore, beforeDescriptor),
    afterAsset: fromTraceAssetState(entry.assetAfter, afterDescriptor)
  };
}

function markerKinds(value: unknown, documentDepth: number, traceDepth: number): HistoryKind[] {
  if (!Array.isArray(value) || value.length !== documentDepth + traceDepth) throw new Error('Session history markers do not match their stacks.');
  const result: HistoryKind[] = [];
  let nextDocument = 0;
  let nextTrace = 0;
  for (const marker of value) {
    if (!isRecord(marker) || (marker.kind !== 'document' && marker.kind !== 'trace') || typeof marker.index !== 'number' || !Number.isSafeInteger(marker.index) || marker.index < 0) throw new Error('Session history marker is malformed.');
    if (marker.kind === 'document') {
      if (marker.index !== nextDocument || marker.index >= documentDepth) throw new Error('Session history document markers are not chronological.');
      nextDocument += 1;
    } else {
      if (marker.index !== nextTrace || marker.index >= traceDepth) throw new Error('Session history trace markers are not chronological.');
      nextTrace += 1;
    }
    result.push(marker.kind);
  }
  if (nextDocument !== documentDepth || nextTrace !== traceDepth) throw new Error('Session history markers do not cover their stacks.');
  return result;
}

function markersFromKinds(kinds: readonly HistoryKind[]): Array<{ kind: HistoryKind; index: number }> {
  let documentIndex = 0;
  let traceIndex = 0;
  return kinds.map((kind) => kind === 'document'
    ? { kind, index: documentIndex++ }
    : { kind, index: traceIndex++ });
}

function reconcileMarkerKinds(kinds: readonly HistoryKind[], documentDepth: number, traceDepth: number): HistoryKind[] {
  const result = [...kinds];
  const trim = (kind: HistoryKind, depth: number): void => {
    while (result.filter((entry) => entry === kind).length > depth) {
      const index = result.indexOf(kind);
      if (index < 0) break;
      result.splice(index, 1);
    }
  };
  trim('document', documentDepth);
  trim('trace', traceDepth);
  return result;
}

/** On open, and when the selected layer disappears: topmost visible stitch layer, else topmost visible layer, else Canvas. */
export function defaultActiveLayerId(document: LayeredDocument): ActiveLayerId {
  return (topmostVisibleLayer(document, LayerType.Stitch) ?? topmostVisibleLayer(document))?.id ?? 'canvas';
}

/** The layer type a clipboard fragment needs, or null for an empty or mixed fragment. */
export function fragmentLayerType(fragment: PatternFragment): LayerType | null {
  const required = commandLayerType({ type: 'paste-fragment', fragment });
  return required === 'mixed' ? null : required;
}

function layerSummariesOf(document: LayeredDocument, previous: readonly LayerSummary[]): readonly LayerSummary[] {
  const next = document.layers.map((layer, index) => ({ id: layer.id, type: layer.type, name: layer.name, visible: layer.visible, index }));
  const same = next.length === previous.length && next.every((summary, index) => {
    const before = previous[index];
    return before.id === summary.id && before.type === summary.type && before.name === summary.name && before.visible === summary.visible;
  });
  return same ? previous : next;
}

/** Adds the selected layer to layer-scoped commands (and batch children) that do not name one. */
function stampLayerId(command: DomainCommand, layerId: number): DomainCommand {
  if (command.type === 'batch' && Array.isArray(command.commands)) {
    return { ...command, commands: (command.commands as DomainCommand[]).map((child) => stampLayerId(child, layerId)) };
  }
  if (commandScope(command) !== 'layer' || typeof command.layerId === 'number') return command;
  return { ...command, layerId };
}

function needsLayer(command: DomainCommand): boolean {
  if (command.type === 'batch' && Array.isArray(command.commands)) return (command.commands as DomainCommand[]).some(needsLayer);
  return commandScope(command) === 'layer' && typeof command.layerId !== 'number';
}

const LAYER_TYPE_NOUN: Record<LayerType, string> = {
  [LayerType.Stitch]: 'stitch',
  [LayerType.Specialty]: 'specialty'
};

const PASTE_HIDDEN_MESSAGE: Record<LayerType, string> = {
  [LayerType.Stitch]: 'Your stitch layers are all hidden, so nothing was pasted. Show one to paste these stitches.',
  [LayerType.Specialty]: 'Your specialty layers are all hidden, so nothing was pasted. Show one to paste these backstitches.'
};

function invalidationFrom(result: CommandResult): CompositeInvalidation {
  const indices = result.compositeChangedIndices;
  return {
    revision: result.revision,
    full: result.compositeFull === true || indices === undefined,
    ...(indices === undefined ? {} : { indices })
  };
}

export class ProjectSession {
  readonly projectId: string;
  private readonly repository: WorkspaceRepository;
  private readonly preparationClient: PersistencePreparationClient;
  private readonly clock: ProjectSessionOptions['clock'];
  private readonly debounceMs: number;
  private editor: DocumentEditor;
  private projectMetadata: ProjectMetadata;
  private projectAssets: ProjectAsset[];
  private projectHealth: ProjectHealth | null;
  private readonly progressService: ProgressMetricsService;
  private materialAssumptionsState: NormalizedMaterialSettings;
  private materialSettingsPersisted: boolean;
  private metricOptions: MetricsOptions;
  private dailyProgressActivity: ProgressActivity;
  private readonly sessionStartedAt: number;
  private sessionMarked = 0;
  private sessionUnmarked = 0;
  private recoverySession: boolean;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private maxDirtyAgeTimer: ReturnType<typeof setTimeout> | undefined;
  private maxDirtyAgeDue = false;
  private saveQueue: Promise<void> = Promise.resolve();
  private traceMutationQueue: Promise<void> = Promise.resolve();
  private traceMutationQueueDepth = 0;
  private saveOperationPending = false;
  private mutationSequence = 0;
  private followUpMutationSequence: number | null = null;
  private activeSave: SaveAttempt | null = null;
  private pendingRevision: number | null = null;
  private lastSavedRevision: number;
  private projectHead: StoredProjectHead | null;
  private metadataVersion = 0;
  private savedMetadataVersion = 0;
  private assetsVersion = 0;
  private savedAssetsVersion = 0;
  private historyVersion = 0;
  private savedHistoryVersion = 0;
  private status: SaveState['status'] = 'idle';
  private saveError: Error | null = null;
  private disposed = false;
  private readonly listeners = new Set<() => void>();
  private traceUndoStack: TraceHistoryEntry[] = [];
  private traceRedoStack: TraceHistoryEntry[] = [];
  private historyKindsUndo: Array<'document' | 'trace'> = [];
  private historyKindsRedo: Array<'document' | 'trace'> = [];
  private activeLayerIdState: ActiveLayerId;
  private layerSummaries: readonly LayerSummary[] = [];
  private activeLayerInfo: ActiveLayerInfo | null = null;
  private compositeInvalidation: CompositeInvalidation | null = null;
  private editorSnapshot: EditorLayerSnapshot | null = null;

  constructor(options: ProjectSessionOptions) {
    this.projectId = options.metadata.id;
    this.repository = options.repository;
    this.preparationClient = options.preparationClient;
    this.clock = options.clock;
    this.debounceMs = Math.max(0, Math.floor(options.debounceMs));
    this.editor = new DocumentEditor(options.document, options.historyLimitBytes === undefined ? undefined : { historyLimitBytes: options.historyLimitBytes });
    const suppliedMaterialSettings = options.materialSettings ?? options.metadata.materialSettings;
    this.materialSettingsPersisted = suppliedMaterialSettings !== undefined;
    // The stitch count lives in the document settings, which metrics read directly.
    this.materialAssumptionsState = normalizeMaterialSettings(this.editor.composite, this.materialSettingsPersisted ? suppliedMaterialSettings : undefined);
    this.metricOptions = this.materialSettingsPersisted ? { ...this.materialAssumptionsState } : {};
    const metadata = { ...options.metadata };
    delete metadata.aidaCount;
    this.projectMetadata = {
      ...metadata,
      ...(this.materialSettingsPersisted ? { materialSettings: { ...this.materialAssumptionsState } } : {})
    };
    this.projectAssets = (options.assets ?? []).map(cloneAsset);
    this.projectHealth = cloneHealth(options.health ?? null);
    this.recoverySession = options.usingRecovery === true;
    this.progressService = new ProgressMetricsService(this.editor.composite, this.metricOptions);
    this.dailyProgressActivity = cloneProgressActivity(options.activity);
    this.sessionStartedAt = options.sessionStartedAt ?? this.clock.now();
    this.lastSavedRevision = options.document.revision;
    this.projectHead = options.head === undefined ? null : { ...options.head };
    this.activeLayerIdState = defaultActiveLayerId(options.document);
    this.refreshLayerState();
    if (!this.recoverySession) this.restoreHistory(options.history);
  }

  /** Re-derive layer summaries and the active layer, reselecting the default when the active layer is gone. */
  private refreshLayerState(documentChanged = true): void {
    const document = this.editor.document;
    this.layerSummaries = layerSummariesOf(document, this.layerSummaries);
    const active = this.activeLayerIdState;
    if (typeof active === 'number' && findLayer(document, active) === undefined) this.activeLayerIdState = defaultActiveLayerId(document);
    const next = this.describeActiveLayer();
    const previous = this.activeLayerInfo;
    const activeChanged = previous === null || previous.id !== next.id || previous.kind !== next.kind || previous.visible !== next.visible || previous.name !== next.name;
    if (activeChanged) this.activeLayerInfo = next;
    if (documentChanged || activeChanged) this.editorSnapshot = null;
  }

  private describeActiveLayer(): ActiveLayerInfo {
    const id = this.activeLayerIdState;
    if (id === 'canvas') return { id, kind: 'canvas', visible: true, name: 'Canvas' };
    if (id === 'reference') return { id, kind: 'reference', visible: this.projectMetadata.sourceImage?.traceVisible ?? false, name: 'Reference image' };
    const layer = findLayer(this.editor.document, id);
    if (!layer) return { id: 'canvas', kind: 'canvas', visible: true, name: 'Canvas' };
    return { id, kind: layer.type, visible: layer.visible, name: layer.name };
  }

  private restoreHistory(history: SessionHistoryEnvelope | undefined): void {
    if (history === undefined) return;
    try {
      if (history.version !== SESSION_HISTORY_ENVELOPE_VERSION || !isRecord(history.trace) || !Array.isArray(history.trace.undo) || !Array.isArray(history.trace.redo)) throw new Error('Session history envelope is malformed.');
      const traceUndo = history.trace.undo.map(fromPersistedTraceEntry);
      const traceRedo = history.trace.redo.map(fromPersistedTraceEntry);
      this.editor.importHistory(history.document);
      if (this.editor.undoDepth !== history.document.undo.length || this.editor.redoDepth !== history.document.redo.length) throw new Error('Document history depth changed during restore.');
      const historyKindsUndo = markerKinds(history.undoOrder, history.document.undo.length, traceUndo.length);
      const historyKindsRedo = markerKinds(history.redoOrder, history.document.redo.length, traceRedo.length);
      this.traceUndoStack = traceUndo;
      this.traceRedoStack = traceRedo;
      this.historyKindsUndo = historyKindsUndo;
      this.historyKindsRedo = historyKindsRedo;
      this.reconcileHistoryMarkers();
      if (this.historyKindsUndo.length !== this.editor.undoDepth + this.traceUndoStack.length || this.historyKindsRedo.length !== this.editor.redoDepth + this.traceRedoStack.length) throw new Error('Session history markers do not match restored stacks.');
    } catch {
      this.editor.clearHistory();
      this.traceUndoStack = [];
      this.traceRedoStack = [];
      this.historyKindsUndo = [];
      this.historyKindsRedo = [];
    }
  }

  private reconcileHistoryMarkers(): void {
    this.historyKindsUndo = reconcileMarkerKinds(this.historyKindsUndo, this.editor.undoDepth, this.traceUndoStack.length);
    this.historyKindsRedo = reconcileMarkerKinds(this.historyKindsRedo, this.editor.redoDepth, this.traceRedoStack.length);
  }

  private exportHistoryEnvelope(extraTraceEntry?: TraceHistoryEntry): SessionHistoryEnvelope {
    this.reconcileHistoryMarkers();
    const exportedDocument = this.editor.exportHistory();
    const documentUndo = [...exportedDocument.undo];
    const documentRedo = extraTraceEntry === undefined ? [...exportedDocument.redo] : [];
    const traceUndo = extraTraceEntry === undefined ? [...this.traceUndoStack] : [...this.traceUndoStack, extraTraceEntry];
    const traceRedo = extraTraceEntry === undefined ? [...this.traceRedoStack] : [];
    const historyKindsUndo: HistoryKind[] = extraTraceEntry === undefined ? [...this.historyKindsUndo] : [...this.historyKindsUndo, 'trace'];
    const historyKindsRedo: HistoryKind[] = extraTraceEntry === undefined ? [...this.historyKindsRedo] : [];
    const traceUndoShapes = traceUndo.map((entry) => toPersistedTraceEntry(entry, false));
    const traceRedoShapes = traceRedo.map((entry) => toPersistedTraceEntry(entry, false));

    const emptyDocument = { ...exportedDocument, undo: [], redo: [] };
    const emptyEnvelope = {
      version: SESSION_HISTORY_ENVELOPE_VERSION,
      document: emptyDocument,
      trace: { undo: [], redo: [] },
      undoOrder: [],
      redoOrder: []
    };
    const safeEstimate = (value: unknown): number => {
      try {
        const estimate = estimateHistoryValueBytes(value);
        return Number.isFinite(estimate) ? Math.min(estimate, MAX_SESSION_HISTORY_BYTES + 1) : MAX_SESSION_HISTORY_BYTES + 1;
      } catch {
        return MAX_SESSION_HISTORY_BYTES + 1;
      }
    };
    const arrayEntryCost = (value: unknown): number => safeEstimate(value) + 8;
    const documentUndoCosts = documentUndo.map(arrayEntryCost);
    const documentRedoCosts = documentRedo.map(arrayEntryCost);
    const traceUndoCosts = traceUndoShapes.map(arrayEntryCost);
    const traceRedoCosts = traceRedoShapes.map(arrayEntryCost);
    const documentMarkerCosts = arrayEntryCost({ kind: 'document', index: 0 });
    const traceMarkerCosts = arrayEntryCost({ kind: 'trace', index: 0 });
    let total = safeEstimate(emptyEnvelope);
    for (const cost of documentUndoCosts) total += cost;
    for (const cost of documentRedoCosts) total += cost;
    for (const cost of traceUndoCosts) total += cost;
    for (const cost of traceRedoCosts) total += cost;
    for (const kind of historyKindsUndo) total += kind === 'document' ? documentMarkerCosts : traceMarkerCosts;
    for (const kind of historyKindsRedo) total += kind === 'document' ? documentMarkerCosts : traceMarkerCosts;

    let undoOffset = 0;
    let undoDocumentOffset = 0;
    let undoTraceOffset = 0;
    while (total > MAX_SESSION_HISTORY_BYTES && undoOffset < historyKindsUndo.length) {
      const kind = historyKindsUndo[undoOffset++];
      total -= kind === 'document' ? documentMarkerCosts + documentUndoCosts[undoDocumentOffset++] : traceMarkerCosts + traceUndoCosts[undoTraceOffset++];
    }
    let redoOffset = 0;
    let redoDocumentOffset = 0;
    let redoTraceOffset = 0;
    while (total > MAX_SESSION_HISTORY_BYTES && redoOffset < historyKindsRedo.length) {
      const kind = historyKindsRedo[redoOffset++];
      total -= kind === 'document' ? documentMarkerCosts + documentRedoCosts[redoDocumentOffset++] : traceMarkerCosts + traceRedoCosts[redoTraceOffset++];
    }

    const selectedDocumentUndo = documentUndo.slice(undoDocumentOffset);
    const selectedDocumentRedo = documentRedo.slice(redoDocumentOffset);
    const selectedTraceUndo = traceUndo.slice(undoTraceOffset);
    const selectedTraceRedo = traceRedo.slice(redoTraceOffset);
    const selectedHistoryKindsUndo = historyKindsUndo.slice(undoOffset);
    const selectedHistoryKindsRedo = historyKindsRedo.slice(redoOffset);

    const buildEnvelope = (cloneAssetBytes: boolean): SessionHistoryEnvelope => {
      const document = { ...exportedDocument, undo: selectedDocumentUndo, redo: selectedDocumentRedo };
      if (selectedHistoryKindsUndo.filter((kind) => kind === 'document').length !== document.undo.length || selectedHistoryKindsUndo.filter((kind) => kind === 'trace').length !== selectedTraceUndo.length || selectedHistoryKindsRedo.filter((kind) => kind === 'document').length !== document.redo.length || selectedHistoryKindsRedo.filter((kind) => kind === 'trace').length !== selectedTraceRedo.length) throw new Error('Session history markers do not match their underlying stacks.');
      return {
        version: SESSION_HISTORY_ENVELOPE_VERSION,
        document,
        trace: {
          undo: selectedTraceUndo.map((entry) => toPersistedTraceEntry(entry, cloneAssetBytes)),
          redo: selectedTraceRedo.map((entry) => toPersistedTraceEntry(entry, cloneAssetBytes))
        },
        undoOrder: markersFromKinds(selectedHistoryKindsUndo),
        redoOrder: markersFromKinds(selectedHistoryKindsRedo)
      };
    };
    return buildEnvelope(true);
  }

  get metadata(): ProjectMetadata {
    const sourceImage = cloneSourceImage(this.projectMetadata.sourceImage);
    return {
      ...this.projectMetadata,
      ...(this.materialSettingsPersisted ? { materialSettings: { ...this.materialAssumptionsState } } : {}),
      ...(sourceImage === undefined ? {} : { sourceImage })
    };
  }

  /** The flattened, visible-only composite every reader (rendering, metrics, eyedropper) uses. */
  get document(): PatternDocument {
    return this.editor.composite;
  }

  /** The stored layer stack. Callers must change it only through commands. */
  get layeredDocument(): LayeredDocument {
    return this.editor.document;
  }

  get layers(): readonly LayerSummary[] {
    return this.layerSummaries;
  }

  get activeLayerId(): ActiveLayerId {
    return this.activeLayerIdState;
  }

  get activeLayer(): ActiveLayerInfo {
    return this.activeLayerInfo ?? this.describeActiveLayer();
  }

  get lastCompositeInvalidation(): CompositeInvalidation | null {
    return this.compositeInvalidation;
  }

  /** Selecting a layer is session memory only; it is never saved or undone. */
  setActiveLayer(id: ActiveLayerId): void {
    this.ensureActive();
    if (typeof id === 'number' && findLayer(this.editor.document, id) === undefined) throw new DomainError(LayerErrorCode.NotFound, `Layer ${String(id)} does not exist.`);
    if (id === this.activeLayerIdState) return;
    this.activeLayerIdState = id;
    this.refreshLayerState();
    this.notify();
  }

  /** The selected layer's own surface (aliasing its planes), or null for Canvas and Reference. Read-only. */
  activeLayerSurface(): PatternDocument | null {
    const id = this.activeLayerIdState;
    return typeof id === 'number' ? layerSurface(this.editor.document, id) : null;
  }

  /** A stable snapshot for the editor gateway; a new object only after a change. */
  getEditorLayerSnapshot(): EditorLayerSnapshot {
    if (this.editorSnapshot === null || this.editorSnapshot.composite !== this.editor.composite) {
      this.editorSnapshot = {
        editSurface: this.activeLayerSurface(),
        activeLayer: this.activeLayer,
        composite: this.editor.composite,
        compositeInvalidation: this.compositeInvalidation
      };
    }
    return this.editorSnapshot;
  }

  canAddLayer(type: LayerType): boolean {
    return canAddLayerOfType(this.editor.document, type);
  }

  get assets(): ProjectAsset[] {
    return this.projectAssets.map(cloneAsset);
  }

  get sourceImage(): SourceImageDescriptor | undefined {
    return cloneSourceImage(this.projectMetadata.sourceImage);
  }

  getSourceImage(): SourceImageDescriptor | undefined {
    return this.sourceImage;
  }

  get traceUndoDepth(): number {
    return this.traceUndoStack.length;
  }

  get traceRedoDepth(): number {
    return this.traceRedoStack.length;
  }

  get historyUndoDepth(): number {
    return this.historyKindsUndo.length;
  }

  get historyRedoDepth(): number {
    return this.historyKindsRedo.length;
  }

  get canUndo(): boolean {
    return this.historyKindsUndo.length > 0;
  }

  get canRedo(): boolean {
    return this.historyKindsRedo.length > 0;
  }

  getAsset(assetId: string): ProjectAsset | undefined {
    const asset = this.projectAssets.find((candidate) => candidate.id === assetId);
    return asset === undefined ? undefined : cloneAsset(asset);
  }

  get health(): ProjectHealth | null {
    return cloneHealth(this.projectHealth);
  }

  get usingRecovery(): boolean {
    return this.recoverySession;
  }

  get metrics() {
    return this.progressService.metrics;
  }

  get progressMetrics() {
    return this.progressService.metrics;
  }

  get materialAssumptions(): NormalizedMaterialSettings {
    return { ...this.materialAssumptionsState };
  }

  get materialSettings(): NormalizedMaterialSettings {
    return { ...this.materialAssumptionsState };
  }

  getMaterialSettings(): NormalizedMaterialSettings {
    return this.materialSettings;
  }

  getMaterialAssumptions(): NormalizedMaterialSettings {
    return this.materialAssumptions;
  }

  get sessionStats(): SessionProgressStats {
    return { startedAt: this.sessionStartedAt, marked: this.sessionMarked, unmarked: this.sessionUnmarked };
  }

  get activity(): ProgressActivity {
    return cloneProgressActivity(this.dailyProgressActivity);
  }

  get dailyActivity(): ProgressActivity {
    return cloneProgressActivity(this.dailyProgressActivity);
  }

  get progressActivity(): ProgressActivity {
    return cloneProgressActivity(this.dailyProgressActivity);
  }

  get saveState(): SaveState {
    return {
      status: this.status,
      dirty: this.isDirty(),
      pendingRevision: this.pendingRevision,
      lastSavedRevision: this.lastSavedRevision,
      metadataDirty: this.metadataDirty(),
      assetsDirty: this.assetsDirty(),
      conflict: this.status === 'conflict',
      error: this.saveError
    };
  }

  get error(): Error | null {
    return this.saveError;
  }

  get isDisposed(): boolean {
    return this.disposed;
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

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private enqueuePersistence(task: () => Promise<void>): Promise<void> {
    const operation = this.saveQueue.catch(() => undefined).then(task);
    this.saveQueue = operation;
    void operation.catch(() => undefined);
    return operation;
  }

  private enqueueTraceMutation(task: () => Promise<void> | void): Promise<void> {
    this.traceMutationQueueDepth += 1;
    const operation = this.traceMutationQueue.catch(() => undefined).then(task).finally(() => {
      this.traceMutationQueueDepth -= 1;
    });
    this.traceMutationQueue = operation;
    void operation.catch(() => undefined);
    return operation;
  }

  private metadataDirty(): boolean {
    return this.metadataVersion !== this.savedMetadataVersion;
  }

  private assetsDirty(): boolean {
    return this.assetsVersion !== this.savedAssetsVersion;
  }

  private historyDirty(): boolean {
    return this.historyVersion !== this.savedHistoryVersion;
  }

  private hasSaveFailure(): boolean {
    return this.status === 'error' || this.status === 'conflict';
  }

  private isDirty(): boolean {
    return this.document.revision !== this.lastSavedRevision || this.metadataDirty() || this.assetsDirty() || this.historyDirty();
  }

  private hasExactCurrentHead(): boolean {
    return this.projectHead !== null
      && this.projectHead.projectId === this.projectId
      && this.projectHead.revision === this.document.revision
      && typeof this.projectHead.checksum === 'string'
      && /^[0-9a-f]{64}$/.test(this.projectHead.checksum);
  }

  private async savePreparedOrLegacy(
    metadata: ProjectMetadata,
    document: LayeredDocument,
    assets: readonly ProjectAssetInput[] | undefined,
    options: SaveOptions
  ): Promise<SaveResult> {
    const mode = options.mode ?? options.commit ?? options.commitMode ?? 'replace';
    if (mode === 'replace' && this.repository.savePrepared) {
      const prepared = await this.preparationClient.prepare({
        projectId: this.projectId,
        revision: document.revision,
        document
      });
      return this.repository.savePrepared(this.projectId, metadata, prepared, assets, { ...options, preparedRequestId: this.preparationClient.getRequestId(prepared) });
    }
    const legacyDocument = mode === 'replace' ? cloneLayeredDocument(document) : document;
    return this.repository.save(this.projectId, metadata, legacyDocument, assets, options);
  }

  private ensureActive(): void {
    if (this.disposed) throw new WorkspaceError('disposed', 'This project session has been disposed.');
  }

  private ensureWritable(): void {
    this.ensureActive();
    if (this.recoverySession) throw new WorkspaceError('recovery-promotion-required', 'Promote the validated recovery revision before editing this project.');
  }

  /**
   * Runs a command against the layer stack. Layer-scoped commands without a
   * `layerId` target the selected layer; with Canvas or Reference selected
   * they are refused.
   */
  execute(command: DomainCommand): SessionCommandResult {
    this.ensureWritable();
    const active = this.activeLayerIdState;
    if (typeof active !== 'number' && needsLayer(command)) throw new DomainError(LayerErrorCode.NotFound, 'Select a stitch or specialty layer to edit.');
    const result = this.editor.execute(typeof active === 'number' ? stampLayerId(command, active) : command);
    if (result.changed) {
      this.applyDocumentChange(result);
      this.historyKindsUndo.push('document');
      this.historyKindsRedo = [];
      this.traceRedoStack = [];
      this.historyVersion += 1;
      this.reconcileHistoryMarkers();
      this.scheduleSave();
    }
    return result;
  }

  executeBatch(commands: readonly DomainCommand[]): CommandResult {
    return this.execute({ type: 'batch', commands: [...commands] });
  }

  /** Metrics, revision and layer state follow every document change, including undo and redo. */
  private applyDocumentChange(result: CommandResult): void {
    const composite = this.editor.composite;
    this.compositeInvalidation = invalidationFrom(result);
    const settingsChanged = this.progressService.applyComposite(composite, this.compositeInvalidation);
    if (settingsChanged && !this.materialSettingsPersisted) this.materialAssumptionsState = normalizeMaterialSettings(composite);
    this.projectMetadata = { ...this.projectMetadata, revision: result.revision };
    this.refreshLayerState();
  }

  /**
   * Where a paste of `fragmentType` content goes: the selected layer when it
   * is visible and of that type; otherwise a new layer at the top of its group
   * when there is room; otherwise the topmost visible layer of the group; and
   * nowhere when every layer of that type is hidden.
   */
  resolvePaste(fragmentType: LayerType): PasteDestination {
    const document = this.editor.document;
    const active = this.activeLayerIdState;
    const activeLayer = typeof active === 'number' ? findLayer(document, active) : undefined;
    if (activeLayer && activeLayer.type === fragmentType && activeLayer.visible) return { layerType: fragmentType, layerId: activeLayer.id, create: false };
    const noun = LAYER_TYPE_NOUN[fragmentType];
    if (canAddLayerOfType(document, fragmentType)) return { layerType: fragmentType, layerId: null, create: true, message: `Added a new ${noun} layer for your paste.` };
    const top = topmostVisibleLayer(document, fragmentType);
    if (top) return { layerType: fragmentType, layerId: top.id, create: false, message: `You have ${String(MAX_LAYERS_PER_TYPE)} ${noun} layers already, so this went on the top one.` };
    return { layerType: fragmentType, layerId: null, create: false, message: PASTE_HIDDEN_MESSAGE[fragmentType] };
  }

  /**
   * Pastes `fragment` at `at` on the resolved destination as one undo step
   * (creating the layer first when needed) and selects that layer.
   */
  commitPaste(fragment: PatternFragment, at: Point, destination: PasteDestination, expectedRevision?: number): PasteCommitResult {
    this.ensureWritable();
    const message = destination.message === undefined ? {} : { message: destination.message };
    // An empty fragment changes nothing; never add a layer or a history entry for it.
    if (commandLayerType({ type: 'paste-fragment', fragment }) === null) return { result: this.unchangedResult(), layerId: null };
    if (destination.create) {
      const layerId = this.editor.document.nextLayerId;
      const result = this.execute({
        type: 'batch',
        commands: [layerAddCommand(destination.layerType, { id: layerId }), { ...pasteFragmentCommand(fragment, at, expectedRevision), layerId }]
      });
      if (result.changed) this.selectLayerQuietly(layerId);
      return { result, layerId: result.changed ? layerId : null, ...message };
    }
    if (destination.layerId === null) return { result: this.unchangedResult(), layerId: null, ...message };
    const result = this.execute({ ...pasteFragmentCommand(fragment, at, expectedRevision), layerId: destination.layerId });
    this.selectLayerQuietly(destination.layerId);
    return { result, layerId: destination.layerId, ...message };
  }

  private selectLayerQuietly(id: ActiveLayerId): void {
    if (typeof id === 'number' && findLayer(this.editor.document, id) === undefined) return;
    if (id === this.activeLayerIdState) return;
    this.activeLayerIdState = id;
    this.refreshLayerState();
    this.notify();
  }

  /** Adds a layer at the top of its group and selects it. */
  addLayer(type: LayerType, name?: string): SessionCommandResult {
    const id = this.editor.document.nextLayerId;
    const result = this.execute(layerAddCommand(type, name === undefined ? { id } : { id, name }));
    if (result.changed) this.selectLayerQuietly(id);
    return result;
  }

  /** Deletes any layer, hidden ones included; the default layer is selected if the active one goes. */
  deleteLayer(layerId: number): SessionCommandResult {
    return this.execute(layerDeleteCommand(layerId));
  }

  /** `toIndex` is an absolute index into `layeredDocument.layers`, clamped to the layer's group. */
  moveLayer(layerId: number, toIndex: number): SessionCommandResult {
    return this.execute(layerMoveCommand(layerId, toIndex));
  }

  renameLayer(layerId: number, name: string): SessionCommandResult {
    return this.execute(layerRenameCommand(layerId, name));
  }

  setLayerVisibility(layerId: number, visible: boolean): SessionCommandResult {
    return this.execute(layerSetVisibilityCommand(layerId, visible));
  }

  /** Copies a layer directly above itself and selects the copy. */
  duplicateLayer(layerId: number): SessionCommandResult {
    const before = new Set(this.editor.document.layers.map((layer) => layer.id));
    const result = this.execute(layerDuplicateCommand(layerId));
    const copy = this.editor.document.layers.find((layer) => !before.has(layer.id));
    if (result.changed && copy) this.selectLayerQuietly(copy.id);
    return result;
  }

  /** Merges `sourceId` into `targetId` (same type, both visible) and selects the target. */
  mergeLayer(sourceId: number, targetId: number): SessionCommandResult {
    const result = this.execute(layerMergeCommand(sourceId, targetId));
    if (result.changed) this.selectLayerQuietly(targetId);
    return result;
  }

  /** The Canvas stitch count, as an undoable document settings change. */
  setAidaCount(aidaCount: number): SessionCommandResult {
    let normalized: number;
    try {
      normalized = normalizeAidaCount(aidaCount);
    } catch (error) {
      throw new WorkspaceError('save-failed', 'The stitch count is invalid.', error);
    }
    return this.execute({ type: 'document-settings-update', settings: { aidaCount: normalized } });
  }

  private recordTraceEntry(entry: TraceHistoryEntry): void {
    this.traceUndoStack.push(entry);
    this.historyKindsUndo.push('trace');
    this.historyKindsRedo = [];
    this.traceRedoStack = [];
    this.editor.clearRedo();
    this.historyVersion += 1;
    this.reconcileHistoryMarkers();
  }

  private restoreTraceSide(entry: TraceHistoryEntry, side: 'before' | 'after'): void {
    const targetDescriptor = side === 'before' ? entry.beforeDescriptor : entry.afterDescriptor;
    const targetAsset = side === 'before' ? entry.beforeAsset : entry.afterAsset;
    const involvesAssets = entry.beforeAsset !== undefined || entry.afterAsset !== undefined;
    if (involvesAssets) {
      const beforeId = entry.beforeAsset?.id;
      const afterId = entry.afterAsset?.id;
      this.projectAssets = this.projectAssets
        .filter((asset) => asset.id !== beforeId && asset.id !== afterId)
        .map(cloneAsset);
      if (targetAsset !== undefined) this.projectAssets.push(cloneAsset(targetAsset));
      if (targetDescriptor === undefined) {
        const nextMetadata = { ...this.projectMetadata };
        delete nextMetadata.sourceImage;
        this.projectMetadata = nextMetadata;
      } else {
        this.projectMetadata = { ...this.projectMetadata, sourceImage: cloneSourceImage(targetDescriptor) as SourceImageDescriptor };
      }
      this.metadataVersion += 1;
      this.assetsVersion += 1;
      this.refreshLayerState(false);
    } else {
      if (targetDescriptor === undefined) {
        const nextMetadata = { ...this.projectMetadata };
        delete nextMetadata.sourceImage;
        this.projectMetadata = nextMetadata;
      } else {
        this.projectMetadata = { ...this.projectMetadata, sourceImage: cloneSourceImage(targetDescriptor) as SourceImageDescriptor };
      }
      this.metadataVersion += 1;
      this.refreshLayerState(false);
    }
  }

  private traceCommandResult(): CommandResult {
    return {
      document: this.editor.composite,
      changed: true,
      revision: this.editor.document.revision
    };
  }

  private unchangedResult(): CommandResult {
    return {
      document: this.editor.composite,
      changed: false,
      revision: this.editor.document.revision
    };
  }

  undo(): CommandResult {
    this.ensureWritable();
    if (this.traceMutationQueueDepth > 0) {
      void this.enqueueTraceMutation(() => { this.undoNow(); });
      return this.unchangedResult();
    }
    return this.undoNow();
  }

  private undoNow(): CommandResult {
    this.reconcileHistoryMarkers();
    const kind = this.historyKindsUndo.pop();
    if (kind === undefined) return this.unchangedResult();
    if (kind === 'document') {
      const result = this.editor.undo();
      if (result.changed) {
        this.applyDocumentChange(result);
        this.historyKindsRedo.push('document');
        this.historyVersion += 1;
        this.reconcileHistoryMarkers();
        this.scheduleSave();
        return result;
      }
      this.historyKindsUndo.push(kind);
      return result;
    }
    const entry = this.traceUndoStack.pop();
    if (!entry) {
      this.historyKindsUndo.push(kind);
      return this.unchangedResult();
    }
    this.traceRedoStack.push(entry);
    this.historyKindsRedo.push('trace');
    this.restoreTraceSide(entry, 'before');
    this.historyVersion += 1;
    this.reconcileHistoryMarkers();
    this.scheduleSave();
    return this.traceCommandResult();
  }

  redo(): CommandResult {
    this.ensureWritable();
    if (this.traceMutationQueueDepth > 0) {
      void this.enqueueTraceMutation(() => { this.redoNow(); });
      return this.unchangedResult();
    }
    return this.redoNow();
  }

  private redoNow(): CommandResult {
    this.reconcileHistoryMarkers();
    const kind = this.historyKindsRedo.pop();
    if (kind === undefined) return this.unchangedResult();
    if (kind === 'document') {
      const result = this.editor.redo();
      if (result.changed) {
        this.applyDocumentChange(result);
        this.historyKindsUndo.push('document');
        this.historyVersion += 1;
        this.reconcileHistoryMarkers();
        this.scheduleSave();
        return result;
      }
      this.historyKindsRedo.push(kind);
      return result;
    }
    const entry = this.traceRedoStack.pop();
    if (!entry) {
      this.historyKindsRedo.push(kind);
      return this.unchangedResult();
    }
    this.traceUndoStack.push(entry);
    this.historyKindsUndo.push('trace');
    this.restoreTraceSide(entry, 'after');
    this.historyVersion += 1;
    this.reconcileHistoryMarkers();
    this.scheduleSave();
    return this.traceCommandResult();
  }

  /**
   * Title, notes and display units are project metadata. A non-null
   * `aidaCount` is the Canvas stitch count and becomes an undoable document
   * settings change; `null` is ignored because the count is always set.
   */
  updateMetadata(changes: { title?: string; notes?: string; aidaCount?: number | null; units?: ProjectMetadata['units'] | null }): void {
    this.ensureWritable();
    const title = changes.title ?? this.projectMetadata.title;
    const notes = changes.notes ?? this.projectMetadata.notes;
    if (typeof title !== 'string' || typeof notes !== 'string') throw new WorkspaceError('save-failed', 'Project metadata is invalid.');
    let units = this.projectMetadata.units;
    if (Object.prototype.hasOwnProperty.call(changes, 'units')) {
      if (changes.units === null || changes.units === undefined) units = undefined;
      else {
        try {
          units = normalizeDisplayUnits(changes.units);
        } catch (error) {
          throw new WorkspaceError('save-failed', 'Project display units are invalid.', error);
        }
      }
    }
    if (changes.aidaCount !== null && changes.aidaCount !== undefined) this.setAidaCount(changes.aidaCount);
    if (title === this.projectMetadata.title && notes === this.projectMetadata.notes && units === this.projectMetadata.units) return;
    const nextMetadata: ProjectMetadata = { ...this.projectMetadata, title, notes };
    if (units === undefined) delete nextMetadata.units;
    else nextMetadata.units = units;
    this.projectMetadata = nextMetadata;
    this.metadataVersion += 1;
    this.scheduleSave();
  }

  updateMaterialSettings(changes: MaterialSettingsUpdate): void {
    this.ensureWritable();
    const next = updateMaterialSettings(this.materialAssumptionsState, changes);
    if (next.strands === this.materialAssumptionsState.strands
      && next.waste === this.materialAssumptionsState.waste
      && next.stitchLengthMeters === this.materialAssumptionsState.stitchLengthMeters
      && next.skeinLengthMeters === this.materialAssumptionsState.skeinLengthMeters) return;
    this.materialAssumptionsState = next;
    this.materialSettingsPersisted = true;
    this.projectMetadata = { ...this.projectMetadata, materialSettings: { ...next } };
    this.metricOptions = { ...next };
    this.progressService.setMaterialSettings(this.metricOptions);
    this.metadataVersion += 1;
    this.scheduleSave();
  }

  updateMaterialAssumptions(changes: MaterialSettingsChanges): void {
    this.updateMaterialSettings(changes);
  }

  setMaterialSettings(changes: MaterialSettingsChanges): void {
    this.updateMaterialSettings(changes);
  }

  setSourceImage(settings: SourceImageSettingsInput): void {
    this.ensureWritable();
    const asset = this.projectAssets.find((candidate) => candidate.id === settings.assetId);
    if (!asset) throw new PersistenceError('invalid-asset', `Source image asset ${settings.assetId} was not found.`);
    const next = normalizeSourceImageDescriptor(settings, { width: this.document.width, height: this.document.height }, asset);
    this.applyTraceImageChange(next, { label: 'source-image-settings' });
  }

  updateSourceImageSettings(settings: SourceImageSettingsInput): void {
    this.setSourceImage(settings);
  }

  /**
   * The single interleaved entry point for descriptor-only reference changes
   * (move, resize, opacity, visibility). Snapshots the current descriptor,
   * applies the next descriptor, persists via the normal autosave, and pushes
   * exactly one history entry interleaved with document entries. Callers
   * coalesce before reaching here: one call per drag commit, one per arrow
   * nudge, one per slider interaction, one per toggle.
   */
  applyTraceImageChange(next: SourceImageDescriptor | undefined, options?: TraceImageHistoryOptions): void {
    this.ensureWritable();
    const apply = (): void => {
      const label = options?.label ?? 'trace-image-change';
      const before = cloneSourceImage(this.projectMetadata.sourceImage);
      const beforeJson = before === undefined ? undefined : JSON.stringify(before);
      const afterJson = next === undefined ? undefined : JSON.stringify(next);
      if (beforeJson === afterJson) return;
      if (next !== undefined) {
        const asset = this.projectAssets.find((candidate) => candidate.id === next.assetId);
        if (!asset) throw new PersistenceError('invalid-asset', `Source image asset ${next.assetId} was not found.`);
        const normalized = normalizeSourceImageDescriptor(
          {
            assetId: next.assetId,
            mimeType: next.mimeType,
            width: next.width,
            height: next.height,
            ...(next.orientation === undefined ? {} : { orientation: next.orientation }),
            crop: { ...next.crop },
            chartBounds: { ...next.chartBounds },
            traceVisible: next.traceVisible,
            opacity: next.opacity
          },
          { width: this.document.width, height: this.document.height },
          asset
        );
        if (before !== undefined && JSON.stringify(before) === JSON.stringify(normalized)) return;
        this.projectMetadata = { ...this.projectMetadata, sourceImage: normalized };
      } else {
        const nextMetadata = { ...this.projectMetadata };
        delete nextMetadata.sourceImage;
        this.projectMetadata = nextMetadata;
      }
      this.metadataVersion += 1;
      this.refreshLayerState(false);
      const entry: TraceHistoryEntry = {
        label,
        beforeDescriptor: before,
        afterDescriptor: cloneSourceImage(this.projectMetadata.sourceImage),
        beforeAsset: undefined,
        afterAsset: undefined
      };
      this.recordTraceEntry(entry);
      this.scheduleSave();
    };
    if (this.traceMutationQueueDepth > 0) {
      void this.enqueueTraceMutation(apply);
      return;
    }
    apply();
  }

  async replaceSourceImage(input: SourceImageReplacementInput | ProjectAssetInput, settings?: SourceImageSettingsInput): Promise<void> {
    this.ensureWritable();
    const assetInput = 'asset' in input ? input.asset : input;
    const sourceSettings = 'asset' in input ? input.settings : settings;
    if (sourceSettings === undefined) throw new PersistenceError('invalid-metadata', 'Source image settings are required.');
    const requestedSettings: SourceImageSettingsInput = {
      ...sourceSettings,
      ...(sourceSettings.crop === undefined ? {} : { crop: { ...sourceSettings.crop } }),
      ...(sourceSettings.chartBounds === undefined ? {} : { chartBounds: { ...sourceSettings.chartBounds } })
    };
    const nextAssetPromise = normalizeSourceImageAsset(assetInput);
    return this.enqueueTraceMutation(async () => {
      const nextAsset = await nextAssetPromise;
      await this.enqueuePersistence(async () => {
        this.ensureWritable();
        const beforeDescriptor = cloneSourceImage(this.projectMetadata.sourceImage);
        const previousSource = this.projectMetadata.sourceImage;
        const beforeAsset = previousSource === undefined
          ? undefined
          : this.projectAssets.find((asset) => asset.id === previousSource.assetId) === undefined
            ? undefined
            : cloneAsset(this.projectAssets.find((asset) => asset.id === previousSource.assetId) as ProjectAsset);
        const nextDescriptor = normalizeSourceImageDescriptor(requestedSettings, { width: this.document.width, height: this.document.height }, nextAsset);
        const previousSourceAssetId = this.projectMetadata.sourceImage?.assetId;
        const nextAssets = this.projectAssets
          .filter((asset) => asset.id !== previousSourceAssetId && asset.id !== nextAsset.id)
          .map(cloneAsset);
        nextAssets.push(cloneAsset(nextAsset));
        const nextMetadata: ProjectMetadata = { ...this.projectMetadata, sourceImage: nextDescriptor };
        const documentRevisionChanged = this.document.revision !== this.lastSavedRevision;
        const mode = !documentRevisionChanged && this.hasExactCurrentHead() ? 'retain' : 'replace';
        const document = this.layeredDocument;
        const candidateMetadataVersion = this.metadataVersion;
        const candidateAssetsVersion = this.assetsVersion;
        const traceEntry: TraceHistoryEntry = {
          label: 'source-image-replace',
          beforeDescriptor,
          afterDescriptor: cloneSourceImage(nextDescriptor),
          beforeAsset: beforeAsset === undefined ? undefined : cloneAsset(beforeAsset),
          afterAsset: cloneAsset(nextAsset)
        };
        const historyVersionAtCapture = this.historyVersion;
        const history = this.exportHistoryEnvelope(traceEntry);
        const result = await this.savePreparedOrLegacy(
          nextMetadata,
          document,
          nextAssets,
          {
            mode,
            allowSameRevision: !documentRevisionChanged,
            ...(mode === 'retain' && this.projectHead !== null ? { expectedHead: { ...this.projectHead }, expectedRevision: document.revision } : {}),
            activity: cloneProgressActivity(this.dailyProgressActivity),
            history
          }
        );
        if (!result.committed || result.stale) throw new PersistenceError('stale-save', `Source image replacement for ${this.projectId} was not committed.`);
        this.projectHead = result.head === undefined ? null : { ...result.head };

        // Persistence can yield while ordinary commands, metadata edits, or an
        // asset save are queued behind this operation. Merge only the source
        // image change into the latest in-memory state so those newer changes
        // remain dirty and are persisted by the following queued save.
        const currentSourceAssetId = this.projectMetadata.sourceImage?.assetId;
        const replacedAssetIds = new Set([previousSourceAssetId, currentSourceAssetId, nextAsset.id]);
        this.projectAssets = this.projectAssets
          .filter((asset) => !replacedAssetIds.has(asset.id))
          .concat(cloneAsset(nextAsset));
        this.projectMetadata = { ...this.projectMetadata, sourceImage: nextDescriptor };
        this.metadataVersion += 1;
        this.assetsVersion += 1;
        this.savedMetadataVersion = candidateMetadataVersion + 1;
        this.savedAssetsVersion = candidateAssetsVersion + 1;
        // Retain the displaced bytes in the history entry so undo of an
        // import/replace can restore the previous asset even though the live
        // asset list (and repository) no longer holds it.
        this.recordTraceEntry(traceEntry);
        this.refreshLayerState(false);
        if (this.historyVersion === historyVersionAtCapture + 1) this.savedHistoryVersion = this.historyVersion;
        this.lastSavedRevision = Math.max(this.lastSavedRevision, result.revision);
        this.pendingRevision = this.isDirty() ? this.document.revision : null;
        this.saveError = null;
        this.status = this.isDirty() ? 'pending' : 'saved';
        this.notify();
      });
    });
  }

  async replaceSourceImageAsset(input: SourceImageReplacementInput | ProjectAssetInput, settings?: SourceImageSettingsInput): Promise<void> {
    return this.replaceSourceImage(input, settings);
  }

  async clearSourceImage(): Promise<void> {
    return this.removeSourceImage();
  }

  /** Commit removal of the source descriptor and retained asset together. */
  async removeSourceImage(): Promise<void> {
    this.ensureWritable();
    return this.enqueueTraceMutation(async () => {
      await this.enqueuePersistence(async () => {
        this.ensureWritable();
        const beforeDescriptor = cloneSourceImage(this.projectMetadata.sourceImage);
        const removedSource = this.projectMetadata.sourceImage;
        const sourceAssetId = removedSource?.assetId;
        if (sourceAssetId === undefined) return;
        const beforeAsset = this.projectAssets.find((asset) => asset.id === sourceAssetId) === undefined
          ? undefined
          : cloneAsset(this.projectAssets.find((asset) => asset.id === sourceAssetId) as ProjectAsset);
        const metadata = { ...this.projectMetadata };
        delete metadata.sourceImage;
        const nextAssets = this.projectAssets
          .filter((asset) => asset.id !== sourceAssetId)
          .map(cloneAsset);
        const documentRevisionChanged = this.document.revision !== this.lastSavedRevision;
        const mode = !documentRevisionChanged && this.hasExactCurrentHead() ? 'retain' : 'replace';
        const document = this.layeredDocument;
        const candidateMetadataVersion = this.metadataVersion;
        const candidateAssetsVersion = this.assetsVersion;
        const traceEntry: TraceHistoryEntry = {
          label: 'source-image-remove',
          beforeDescriptor,
          afterDescriptor: undefined,
          beforeAsset: beforeAsset === undefined ? undefined : cloneAsset(beforeAsset),
          afterAsset: undefined
        };
        const historyVersionAtCapture = this.historyVersion;
        const history = this.exportHistoryEnvelope(traceEntry);
        const result = await this.savePreparedOrLegacy(
          metadata,
          document,
          nextAssets,
          {
            mode,
            allowSameRevision: !documentRevisionChanged,
            ...(mode === 'retain' && this.projectHead !== null ? { expectedHead: { ...this.projectHead }, expectedRevision: document.revision } : {}),
            activity: cloneProgressActivity(this.dailyProgressActivity),
            history
          }
        );
        if (!result.committed || result.stale) throw new PersistenceError('stale-save', `Source image removal for ${this.projectId} was not committed.`);
        this.projectHead = result.head === undefined ? null : { ...result.head };

        // Keep edits that happened while the transaction was in flight dirty;
        // only merge the source removal itself into the latest session state.
        this.projectAssets = this.projectAssets.filter((asset) => asset.id !== sourceAssetId).map(cloneAsset);
        if (this.projectMetadata.sourceImage?.assetId === sourceAssetId) {
          const nextMetadata = { ...this.projectMetadata };
          delete nextMetadata.sourceImage;
          this.projectMetadata = nextMetadata;
        }
        this.metadataVersion += 1;
        this.assetsVersion += 1;
        this.savedMetadataVersion = candidateMetadataVersion + 1;
        this.savedAssetsVersion = candidateAssetsVersion + 1;
        this.recordTraceEntry(traceEntry);
        this.refreshLayerState(false);
        if (this.historyVersion === historyVersionAtCapture + 1) this.savedHistoryVersion = this.historyVersion;
        this.lastSavedRevision = Math.max(this.lastSavedRevision, result.revision);
        this.pendingRevision = this.isDirty() ? this.document.revision : null;
        this.saveError = null;
        this.status = this.isDirty() ? 'pending' : 'saved';
        this.notify();
      });
    });
  }

  async removeSourceImageAsset(): Promise<void> {
    return this.removeSourceImage();
  }

  replaceAssets(assets: readonly ProjectAsset[]): void {
    this.ensureWritable();
    const next = assets.map(cloneAsset);
    const same = next.length === this.projectAssets.length && next.every((asset, index) => {
      const current = this.projectAssets[index];
      return asset.id === current.id && asset.name === current.name && asset.mimeType === current.mimeType && asset.checksum === current.checksum && asset.data.length === current.data.length && asset.data.every((byte, byteIndex) => byte === current.data[byteIndex]);
    });
    if (same) return;
    this.projectAssets = next;
    this.assetsVersion += 1;
    this.scheduleSave();
  }

  private clearScheduledSaveTimers(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.maxDirtyAgeTimer !== undefined) clearTimeout(this.maxDirtyAgeTimer);
    this.timer = undefined;
    this.maxDirtyAgeTimer = undefined;
    this.maxDirtyAgeDue = false;
    this.followUpMutationSequence = null;
  }

  private scheduleSave(): void {
    this.mutationSequence += 1;
    this.pendingRevision = this.document.revision;
    this.status = 'pending';
    this.notify();
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.requestScheduledSave(false);
    }, this.debounceMs);
    if (this.maxDirtyAgeTimer === undefined && !this.maxDirtyAgeDue) {
      this.maxDirtyAgeTimer = setTimeout(() => {
        this.maxDirtyAgeTimer = undefined;
        this.maxDirtyAgeDue = true;
        this.requestScheduledSave(true);
      }, MAX_AUTOSAVE_DIRTY_AGE_MS);
    }
  }

  private requestScheduledSave(forceMaxAge: boolean): void {
    if (forceMaxAge) this.maxDirtyAgeDue = true;
    if (!this.isDirty()) {
      this.clearScheduledSaveTimers();
      return;
    }
    if (this.saveOperationPending) {
      this.followUpMutationSequence = this.mutationSequence;
      return;
    }
    void this.startSave().catch(() => undefined);
  }

  private startSave(): Promise<void> {
    this.ensureActive();
    if (!this.isDirty()) {
      this.clearScheduledSaveTimers();
      return this.saveQueue;
    }
    if (this.saveOperationPending) return this.saveQueue;
    this.saveOperationPending = true;
    let completedSuccessfully = false;
    let shouldFollowUp = false;
    let attempt: SaveAttempt | null = null;
    const operation = this.enqueuePersistence(async () => {
      try {
        // Capture every persisted value after this operation reaches the queue.
        // A save request may wait behind a source-image replacement; capturing
        // before enqueueing would let that stale request restore old metadata
        // and assets after the replacement commits.
        this.ensureActive();
        if (!this.isDirty()) {
          this.clearScheduledSaveTimers();
          return;
        }
        const documentRevisionChanged = this.document.revision !== this.lastSavedRevision;
        const mode = !documentRevisionChanged && this.hasExactCurrentHead() ? 'retain' : 'replace';
        const snapshot = this.layeredDocument;
        const history = this.exportHistoryEnvelope();
        attempt = {
          revision: snapshot.revision,
          metadataVersion: this.metadataVersion,
          assetsVersion: this.assetsVersion,
          historyVersion: this.historyVersion,
          mutationSequence: this.mutationSequence
        };
        this.activeSave = attempt;
        this.pendingRevision = attempt.revision;
        const metadata: ProjectMetadata = {
          ...this.projectMetadata,
          revision: attempt.revision,
          updatedAt: this.clock.now()
        };
        this.projectMetadata = metadata;
        const assetsDirtyAtStart = this.assetsDirty();
        const assets = assetsDirtyAtStart ? this.projectAssets.map((asset) => ({ id: asset.id, name: asset.name, mimeType: asset.mimeType, data: new Uint8Array(asset.data) })) : undefined;
        const saveOptions: SaveOptions = {
          mode,
          // Keep the legacy flag for repository implementations that have not
          // adopted the explicit mode yet.
          allowSameRevision: !documentRevisionChanged,
          ...(mode === 'retain' && this.projectHead !== null ? { expectedHead: { ...this.projectHead }, expectedRevision: attempt.revision } : {}),
          activity: cloneProgressActivity(this.dailyProgressActivity),
          history
        };
        this.notify();
        this.status = 'saving';
        this.notify();
        const saveResult = await this.savePreparedOrLegacy(metadata, snapshot, assets, saveOptions);
        if (!saveResult.committed || saveResult.stale) throw new WorkspaceError('save-conflict', `Revision ${String(attempt.revision)} conflicts with a newer local revision.`);
        this.projectHead = saveResult.head === undefined ? null : { ...saveResult.head };
        this.lastSavedRevision = Math.max(this.lastSavedRevision, saveResult.revision);
        if (this.metadataVersion === attempt.metadataVersion) this.savedMetadataVersion = attempt.metadataVersion;
        if (this.assetsVersion === attempt.assetsVersion) this.savedAssetsVersion = attempt.assetsVersion;
        if (this.historyVersion === attempt.historyVersion) this.savedHistoryVersion = attempt.historyVersion;
        this.pendingRevision = this.isDirty() ? this.document.revision : null;
        this.saveError = null;
        this.status = this.isDirty() ? 'pending' : 'saved';
        this.notify();
        completedSuccessfully = true;
        if (!this.isDirty()) {
          this.clearScheduledSaveTimers();
        } else {
          shouldFollowUp = this.maxDirtyAgeDue || (this.followUpMutationSequence !== null && this.mutationSequence === this.followUpMutationSequence);
          this.followUpMutationSequence = null;
        }
      } catch (error) {
        this.clearScheduledSaveTimers();
        const normalized = asError(error, 'Unable to save the project locally.');
        this.saveError = normalized;
        this.status = normalized instanceof WorkspaceError && normalized.code === 'save-conflict' || normalized instanceof PersistenceError && normalized.code === 'stale-save' ? 'conflict' : 'error';
        this.pendingRevision = this.document.revision;
        this.notify();
        throw normalized;
      } finally {
        if (attempt !== null && this.activeSave === attempt) this.activeSave = null;
        this.saveOperationPending = false;
        if (completedSuccessfully && shouldFollowUp && this.isDirty()) void this.startSave().catch(() => undefined);
      }
    });
    return operation;
  }

  async retrySave(): Promise<void> {
    this.ensureActive();
    await this.traceMutationQueue;
    if (this.recoverySession) return;
    if (!this.isDirty()) return;
    this.clearScheduledSaveTimers();
    this.saveError = null;
    this.status = 'pending';
    this.notify();
    while (this.isDirty()) {
      this.clearScheduledSaveTimers();
      await this.startSave();
      if (this.isDirty() && this.hasSaveFailure()) throw this.saveError ?? new WorkspaceError('save-failed', 'Unable to save the project locally.');
    }
  }

  async flush(): Promise<void> {
    this.ensureActive();
    await this.traceMutationQueue;
    if (this.recoverySession && !this.isDirty()) return;
    this.clearScheduledSaveTimers();
    while (this.isDirty()) {
      this.clearScheduledSaveTimers();
      await this.startSave();
      if (this.isDirty() && this.hasSaveFailure()) throw this.saveError ?? new WorkspaceError('save-failed', 'Unable to save the project locally.');
    }
    await this.saveQueue;
    if (this.saveError) throw this.saveError;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    try {
      await this.flush();
    } finally {
      this.clearScheduledSaveTimers();
      this.disposed = true;
      this.status = 'disposed';
      this.notify();
      this.listeners.clear();
    }
  }
}

export const ProjectWorkspaceSession = ProjectSession;
