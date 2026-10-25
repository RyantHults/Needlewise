import {
  canAddLayer as canAddLayerOfType,
  commandScope,
  createPaletteCommand,
  DocumentEditor,
  DomainError,
  findLayer,
  fragmentLayerRequirement,
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
  isRecord,
  type MetricsOptions,
  updateMaterialSettings,
  type MaterialSettingsUpdate,
  type NormalizedMaterialSettings,
  type CommandResult,
  type DomainCommand,
  type LayeredDocument,
  type PatternDocument,
  type PaletteEntryInput,
  type PatternFragment,
  type Point,
  type ProgressCommand,
  type ProgressEntry
} from '../domain';
import { cloneProjectHealth, PersistenceError } from '../persistence';
import {
  normalizeSourceImageDescriptor,
  normalizeSourceImageAsset,
  validateSourceImageDescriptor,
  MAX_SESSION_HISTORY_BYTES,
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
import { asError, WorkspaceError } from './errors';
import { planLayerMerge } from './layer-merge';
import { ProgressMetricsService } from './progress';
import type {
  ActiveLayerId,
  LayerSelection,
  ActiveLayerInfo,
  CompositeInvalidation,
  EditorLayerSnapshot,
  LayerSummary,
  PasteCommitResult,
  PasteDestination,
  ProjectSessionOptions,
  SaveState,
  SessionCommandResult,
  WorkspaceRepository
} from './types';

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

interface SaveAttempt {
  revision: number;
  metadataVersion: number;
  assetsVersion: number;
  historyVersion: number;
  mutationSequence: number;
}

export const MAX_AUTOSAVE_DIRTY_AGE_MS = 5_000;

/** Track keeps this many mark steps to undo. */
export const MAX_MARK_HISTORY_STEPS = 200;

/** The label reference visibility toggles use; such a change is saved but is not recorded in history. */
const TRACE_VISIBILITY_LABEL = 'trace-image-visibility';

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

/** A source-image change committed with its Track entry; see `commitTraceAssetTransaction`. */
interface TraceAssetTransaction {
  readonly metadata: ProjectMetadata;
  readonly assets: ProjectAsset[];
  readonly traceEntry: TraceHistoryEntry;
  readonly staleMessage: string;
  readonly mergeLive: () => void;
}

type HistoryKind = 'document' | 'trace';

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
  if (command.type === 'batch') {
    return { ...command, commands: command.commands.map((child) => stampLayerId(child, layerId)) };
  }
  if (commandScope(command) !== 'layer' || typeof command.layerId === 'number') return command;
  return { ...command, layerId };
}

function needsLayer(command: DomainCommand): boolean {
  if (command.type === 'batch') return command.commands.some(needsLayer);
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
  private markUndoStack: ProgressEntry[] = [];
  private markRedoStack: ProgressEntry[] = [];
  private activeLayerIdState: ActiveLayerId;
  private layerSummaries: readonly LayerSummary[] = [];
  private activeLayerInfo: ActiveLayerInfo | null = null;
  private selectedLayerIdsState: readonly number[] = [];
  private layerSelectionState: LayerSelection = { primary: 'canvas', layerIds: [] };
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
    this.projectHealth = options.health ? cloneProjectHealth(options.health) : null;
    this.recoverySession = options.usingRecovery === true;
    this.progressService = new ProgressMetricsService(this.editor.composite, this.metricOptions);
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
    let selected = this.selectedLayerIdsState.filter((id) => findLayer(document, id) !== undefined);
    const stackIndex = new Map(this.layerSummaries.map((layer) => [layer.id, layer.index]));
    let active = this.activeLayerIdState;
    if (typeof active === 'number' && findLayer(document, active) === undefined) {
      // The primary is gone: the topmost remaining selected layer takes over, else the default rule.
      const remaining = [...selected].sort((a, b) => (stackIndex.get(b) ?? 0) - (stackIndex.get(a) ?? 0));
      active = remaining[0] ?? defaultActiveLayerId(document);
      this.activeLayerIdState = active;
    }
    if (typeof active !== 'number') selected = [];
    else if (!selected.includes(active)) selected = [active];
    selected.sort((a, b) => (stackIndex.get(a) ?? 0) - (stackIndex.get(b) ?? 0));
    const selectionChanged = this.layerSelectionState.primary !== active || selected.length !== this.layerSelectionState.layerIds.length || selected.some((id, i) => id !== this.layerSelectionState.layerIds[i]);
    if (selectionChanged) {
      this.selectedLayerIdsState = selected;
      this.layerSelectionState = { primary: active, layerIds: selected };
    }
    const next = this.describeActiveLayer();
    const previous = this.activeLayerInfo;
    const activeChanged = previous === null || previous.id !== next.id || previous.kind !== next.kind || previous.visible !== next.visible || previous.name !== next.name;
    if (activeChanged) this.activeLayerInfo = next;
    if (documentChanged || activeChanged || selectionChanged) this.editorSnapshot = null;
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

  get layerSelection(): LayerSelection {
    return this.layerSelectionState;
  }

  /** Selecting a layer is session memory only; it is never saved or undone. */
  setActiveLayer(id: ActiveLayerId): void {
    this.ensureActive();
    if (typeof id === 'number' && findLayer(this.editor.document, id) === undefined) throw new DomainError(LayerErrorCode.NotFound, `Layer ${String(id)} does not exist.`);
    if (id === this.activeLayerIdState && this.selectedLayerIdsState.length <= 1) return;
    this.activeLayerIdState = id;
    this.selectedLayerIdsState = [];
    this.refreshLayerState();
    this.notify();
  }

  /** Ctrl/Cmd+click: adds the layer to the selection and makes it primary, or removes it. The last selected layer stays. */
  toggleLayerSelected(id: number): void {
    this.ensureActive();
    this.requireLayer(id);
    const selected = this.selectedLayerIdsState;
    if (!selected.includes(id)) {
      this.selectedLayerIdsState = [...selected, id];
      this.activeLayerIdState = id;
    } else {
      if (selected.length <= 1) return;
      const remaining = selected.filter((other) => other !== id);
      this.selectedLayerIdsState = remaining;
      // `selected` is in stack order, so the last remaining id is the topmost.
      if (id === this.activeLayerIdState) this.activeLayerIdState = remaining[remaining.length - 1] as number;
    }
    this.refreshLayerState(false);
    this.notify();
  }

  /** Shift+click: selects every layer between the primary and `id` in stack order; `id` becomes primary. */
  selectLayerRange(id: number): void {
    this.ensureActive();
    this.requireLayer(id);
    const layers = this.editor.document.layers;
    const primary = this.activeLayerIdState;
    const from = typeof primary === 'number' ? layers.findIndex((layer) => layer.id === primary) : -1;
    const to = layers.findIndex((layer) => layer.id === id);
    const [low, high] = from < 0 ? [to, to] : [Math.min(from, to), Math.max(from, to)];
    this.selectedLayerIdsState = layers.slice(low, high + 1).map((layer) => layer.id);
    this.activeLayerIdState = id;
    this.refreshLayerState(false);
    this.notify();
  }

  private requireLayer(id: number): void {
    if (findLayer(this.editor.document, id) === undefined) throw new DomainError(LayerErrorCode.NotFound, `Layer ${String(id)} does not exist.`);
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
        selectedLayerIds: this.layerSelectionState.layerIds,
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

  get historyUndoDepth(): number {
    return this.historyKindsUndo.length;
  }

  get historyRedoDepth(): number {
    return this.historyKindsRedo.length;
  }

  get canUndoMark(): boolean {
    return this.markUndoStack.length > 0;
  }

  get canRedoMark(): boolean {
    return this.markRedoStack.length > 0;
  }

  getAsset(assetId: string): ProjectAsset | undefined {
    const asset = this.projectAssets.find((candidate) => candidate.id === assetId);
    return asset === undefined ? undefined : cloneAsset(asset);
  }

  get health(): ProjectHealth | null {
    return this.projectHealth === null ? null : cloneProjectHealth(this.projectHealth);
  }

  get usingRecovery(): boolean {
    return this.recoverySession;
  }

  get metrics() {
    return this.progressService.metrics;
  }

  get materialSettings(): NormalizedMaterialSettings {
    return { ...this.materialAssumptionsState };
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

  /** Retains the stored document when only metadata, assets or history changed, guarded by the current head. */
  private saveModeFor(): Pick<SaveOptions, 'mode' | 'allowSameRevision' | 'expectedHead' | 'expectedRevision'> {
    const documentRevisionChanged = this.document.revision !== this.lastSavedRevision;
    const mode = !documentRevisionChanged && this.hasExactCurrentHead() ? 'retain' : 'replace';
    return {
      mode,
      // Keep the legacy flag for repository implementations that have not
      // adopted the explicit mode yet.
      allowSameRevision: !documentRevisionChanged,
      ...(mode === 'retain' && this.projectHead !== null ? { expectedHead: { ...this.projectHead }, expectedRevision: this.document.revision } : {})
    };
  }

  private hasExactCurrentHead(): boolean {
    return this.projectHead !== null
      && this.projectHead.projectId === this.projectId
      && this.projectHead.revision === this.document.revision
      && typeof this.projectHead.checksum === 'string'
      && /^[0-9a-f]{64}$/.test(this.projectHead.checksum);
  }

  private async savePreparedOrRetain(
    metadata: ProjectMetadata,
    document: LayeredDocument,
    assets: readonly ProjectAssetInput[] | undefined,
    options: SaveOptions
  ): Promise<SaveResult> {
    const mode = options.mode ?? options.commit ?? options.commitMode ?? 'replace';
    if (mode !== 'replace') return this.repository.save(this.projectId, metadata, document, assets, options);
    const prepared = await this.preparationClient.prepare({
      projectId: this.projectId,
      revision: document.revision,
      document
    });
    return this.repository.savePrepared(this.projectId, metadata, prepared, assets, { ...options, preparedRequestId: this.preparationClient.getRequestId(prepared) });
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
      // The editor keeps a top-level visibility toggle out of history, so it leaves both stacks alone.
      if (command.type !== 'layer-set-visibility') {
        this.historyKindsUndo.push('document');
        this.historyKindsRedo = [];
        this.traceRedoStack = [];
        this.historyVersion += 1;
        this.reconcileHistoryMarkers();
      }
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
   * (creating the layer first when needed) and selects that layer. Any `palette`
   * entries are created in the same step, ahead of the paste.
   */
  commitPaste(fragment: PatternFragment, at: Point, destination: PasteDestination, expectedRevision?: number, palette: readonly PaletteEntryInput[] = []): PasteCommitResult {
    this.ensureWritable();
    const message = destination.message === undefined ? {} : { message: destination.message };
    // An empty fragment changes nothing; never add a layer or a history entry for it.
    if (fragmentLayerRequirement(fragment) === null) return { result: this.unchangedResult(), layerId: null };
    const creates = palette.map(createPaletteCommand);
    if (destination.create) {
      const layerId = this.editor.document.nextLayerId;
      const result = this.execute({
        type: 'batch',
        commands: [...creates, layerAddCommand(destination.layerType, { id: layerId }), { ...pasteFragmentCommand(fragment, at, expectedRevision), layerId }]
      });
      if (result.changed) this.selectLayerQuietly(layerId);
      return { result, layerId: result.changed ? layerId : null, ...message };
    }
    if (destination.layerId === null) return { result: this.unchangedResult(), layerId: null, ...message };
    const paste: DomainCommand = { ...pasteFragmentCommand(fragment, at, expectedRevision), layerId: destination.layerId };
    const result = this.execute(creates.length === 0 ? paste : { type: 'batch', commands: [...creates, paste] });
    this.selectLayerQuietly(destination.layerId);
    return { result, layerId: destination.layerId, ...message };
  }

  private selectLayerQuietly(id: ActiveLayerId): void {
    if (typeof id === 'number' && findLayer(this.editor.document, id) === undefined) return;
    if (id === this.activeLayerIdState && this.selectedLayerIdsState.length <= 1) return;
    this.activeLayerIdState = id;
    this.selectedLayerIdsState = [];
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

  /** Saved with the document but not an undo step: undo and redo skip over it. */
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

  /** Merges the selected layers (or merges the one selected layer down) as one undo step and selects the target. */
  mergeSelectedLayers(): SessionCommandResult {
    const plan = planLayerMerge(this.editor.document, this.layerSelectionState);
    if (plan === null || !('targetId' in plan)) return this.unchangedResult();
    const result = this.executeBatch(plan.sourceIds.map((sourceId) => layerMergeCommand(sourceId, plan.targetId)));
    if (result.changed) this.selectLayerQuietly(plan.targetId);
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

  /** A reference that is still there keeps its current visibility, which is set outside history. */
  private restoreTraceSide(entry: TraceHistoryEntry, side: 'before' | 'after'): void {
    const recorded = side === 'before' ? entry.beforeDescriptor : entry.afterDescriptor;
    const current = this.projectMetadata.sourceImage;
    const targetDescriptor = recorded === undefined || current === undefined ? recorded : { ...recorded, traceVisible: current.traceVisible };
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
   * Marks stitches done or not done on the visible composite. Marks bypass
   * document history: each one is a step on Track's own in-memory stack,
   * which `clearMarkHistory` empties when Track closes.
   */
  markProgress(command: ProgressCommand): SessionCommandResult {
    this.ensureWritable();
    const applied = this.editor.applyProgress(command);
    if (applied === null || !applied.result.changed) return applied?.result ?? this.unchangedResult();
    this.markUndoStack.push(applied.entry);
    if (this.markUndoStack.length > MAX_MARK_HISTORY_STEPS) this.markUndoStack.shift();
    this.markRedoStack = [];
    this.applyProgressChange(applied.result);
    return applied.result;
  }

  undoMark(): CommandResult {
    this.ensureWritable();
    const entry = this.markUndoStack.pop();
    if (entry === undefined) return this.unchangedResult();
    this.markRedoStack.push(entry);
    const result = this.editor.applyProgressEntry(entry, false);
    this.applyProgressChange(result);
    return result;
  }

  redoMark(): CommandResult {
    this.ensureWritable();
    const entry = this.markRedoStack.pop();
    if (entry === undefined) return this.unchangedResult();
    this.markUndoStack.push(entry);
    const result = this.editor.applyProgressEntry(entry, true);
    this.applyProgressChange(result);
    return result;
  }

  clearMarkHistory(): void {
    if (this.markUndoStack.length === 0 && this.markRedoStack.length === 0) return;
    this.markUndoStack = [];
    this.markRedoStack = [];
    this.notify();
  }

  /** A step whose layers are all gone changes nothing but still moves between the stacks. */
  private applyProgressChange(result: CommandResult): void {
    if (!result.changed) {
      this.notify();
      return;
    }
    this.applyDocumentChange(result);
    this.scheduleSave();
  }

  /**
   * Title, notes and display units are project metadata.
   */
  updateMetadata(changes: { title?: string; notes?: string; units?: ProjectMetadata['units'] | null }): void {
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
      && next.backstitchStrands === this.materialAssumptionsState.backstitchStrands
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

  setSourceImage(settings: SourceImageSettingsInput): void {
    this.ensureWritable();
    const asset = this.projectAssets.find((candidate) => candidate.id === settings.assetId);
    if (!asset) throw new PersistenceError('invalid-asset', `Source image asset ${settings.assetId} was not found.`);
    const next = normalizeSourceImageDescriptor(settings, { width: this.document.width, height: this.document.height }, asset);
    this.applyTraceImageChange(next, { label: 'source-image-settings' });
  }

  /**
   * The single interleaved entry point for descriptor-only reference changes
   * (move, resize, opacity, visibility). Snapshots the current descriptor,
   * applies the next descriptor, persists via the normal autosave, and pushes
   * exactly one history entry interleaved with document entries, except for
   * a visibility toggle, which is saved without one. Callers coalesce before
   * reaching here: one call per drag commit, one per arrow nudge, one per
   * slider interaction.
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
      // Showing or hiding the reference, like any layer, is saved but is not an undo step.
      if (label === TRACE_VISIBILITY_LABEL) {
        this.scheduleSave();
        return;
      }
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
        const previousSourceAssetId = this.projectMetadata.sourceImage?.assetId;
        const nextDescriptor = normalizeSourceImageDescriptor(requestedSettings, { width: this.document.width, height: this.document.height }, nextAsset);
        const nextAssets = this.projectAssets
          .filter((asset) => asset.id !== previousSourceAssetId && asset.id !== nextAsset.id)
          .map(cloneAsset);
        nextAssets.push(cloneAsset(nextAsset));
        await this.commitTraceAssetTransaction({
          metadata: { ...this.projectMetadata, sourceImage: nextDescriptor },
          assets: nextAssets,
          traceEntry: {
            label: 'source-image-replace',
            beforeDescriptor: cloneSourceImage(this.projectMetadata.sourceImage),
            afterDescriptor: cloneSourceImage(nextDescriptor),
            beforeAsset: this.findAssetClone(previousSourceAssetId),
            afterAsset: cloneAsset(nextAsset)
          },
          staleMessage: `Source image replacement for ${this.projectId} was not committed.`,
          mergeLive: () => {
            const replacedAssetIds = new Set([previousSourceAssetId, nextAsset.id]);
            this.projectAssets = this.projectAssets
              .filter((asset) => !replacedAssetIds.has(asset.id))
              .concat(cloneAsset(nextAsset));
            this.projectMetadata = { ...this.projectMetadata, sourceImage: nextDescriptor };
          }
        });
      });
    });
  }

  /** Commit removal of the source descriptor and retained asset together. */
  async removeSourceImage(): Promise<void> {
    this.ensureWritable();
    return this.enqueueTraceMutation(async () => {
      await this.enqueuePersistence(async () => {
        this.ensureWritable();
        const sourceAssetId = this.projectMetadata.sourceImage?.assetId;
        if (sourceAssetId === undefined) return;
        const metadata = { ...this.projectMetadata };
        delete metadata.sourceImage;
        await this.commitTraceAssetTransaction({
          metadata,
          assets: this.projectAssets.filter((asset) => asset.id !== sourceAssetId).map(cloneAsset),
          traceEntry: {
            label: 'source-image-remove',
            beforeDescriptor: cloneSourceImage(this.projectMetadata.sourceImage),
            afterDescriptor: undefined,
            beforeAsset: this.findAssetClone(sourceAssetId),
            afterAsset: undefined
          },
          staleMessage: `Source image removal for ${this.projectId} was not committed.`,
          mergeLive: () => {
            this.projectAssets = this.projectAssets.filter((asset) => asset.id !== sourceAssetId).map(cloneAsset);
            if (this.projectMetadata.sourceImage?.assetId === sourceAssetId) {
              const nextMetadata = { ...this.projectMetadata };
              delete nextMetadata.sourceImage;
              this.projectMetadata = nextMetadata;
            }
          }
        });
      });
    });
  }

  private findAssetClone(id: string | undefined): ProjectAsset | undefined {
    const asset = id === undefined ? undefined : this.projectAssets.find((candidate) => candidate.id === id);
    return asset === undefined ? undefined : cloneAsset(asset);
  }

  /**
   * Saves a source-image change and its Track entry in one commit, from inside
   * the persistence queue. Persistence can yield while ordinary commands,
   * metadata edits or an asset save are queued behind this operation, so
   * `mergeLive` merges only this change into the latest in-memory state and
   * those newer changes stay dirty for the following queued save.
   */
  private async commitTraceAssetTransaction(transaction: TraceAssetTransaction): Promise<void> {
    const saveMode = this.saveModeFor();
    const document = this.layeredDocument;
    const candidateMetadataVersion = this.metadataVersion;
    const candidateAssetsVersion = this.assetsVersion;
    const historyVersionAtCapture = this.historyVersion;
    const history = this.exportHistoryEnvelope(transaction.traceEntry);
    // As in `startSave`, the saved metadata is stamped so the gallery order follows image changes.
    const metadata: ProjectMetadata = { ...transaction.metadata, updatedAt: this.clock.now() };
    const result = await this.savePreparedOrRetain(metadata, document, transaction.assets, {
      ...saveMode,
      history
    });
    if (!result.committed || result.stale) throw new PersistenceError('stale-save', transaction.staleMessage);
    this.projectHead = result.head === undefined ? null : { ...result.head };
    transaction.mergeLive();
    this.projectMetadata = { ...this.projectMetadata, updatedAt: metadata.updatedAt };
    this.metadataVersion += 1;
    this.assetsVersion += 1;
    this.savedMetadataVersion = candidateMetadataVersion + 1;
    this.savedAssetsVersion = candidateAssetsVersion + 1;
    // The entry keeps the displaced bytes, so undo can restore the previous
    // asset even though the live asset list and the repository no longer hold it.
    this.recordTraceEntry(transaction.traceEntry);
    this.refreshLayerState(false);
    if (this.historyVersion === historyVersionAtCapture + 1) this.savedHistoryVersion = this.historyVersion;
    this.lastSavedRevision = Math.max(this.lastSavedRevision, result.revision);
    this.pendingRevision = this.isDirty() ? this.document.revision : null;
    this.saveError = null;
    this.status = this.isDirty() ? 'pending' : 'saved';
    this.notify();
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
        const saveMode = this.saveModeFor();
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
          ...saveMode,
          history
        };
        this.notify();
        this.status = 'saving';
        this.notify();
        const saveResult = await this.savePreparedOrRetain(metadata, snapshot, assets, saveOptions);
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
