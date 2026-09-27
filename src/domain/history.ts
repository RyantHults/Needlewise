import {
  applyOneToDraft,
  applyBulkCellCommand,
  applyBulkRecolorCommand,
  applyBulkCompletionCommand,
  applyBulkBackstitchCompletionCommand,
  applyPasteFragmentCommand,
  applyMoveFragmentCommand,
  applyMixedEraseCommand,
  applyDeleteRegionCommand,
  applyDeleteCellSetCommand,
  assertBulkBatchPolicy,
  canonicalCropCommand,
  canonicalTransformCommand,
  commandRequiresSnapshot,
  estimateBulkCellHistoryBytes,
  estimateBulkRecolorHistoryBytes,
  estimateBulkCompletionHistoryBytes,
  estimateBulkBackstitchCompletionHistoryBytes,
  estimatePasteFragmentHistoryBytes,
  estimateMoveFragmentHistoryBytes,
  estimateMixedEraseHistoryBytes,
  estimateDeleteRegionHistoryBytes,
  estimateDeleteCellSetHistoryBytes,
  isBatchCommand,
  isBulkCellCommand,
  isBulkRecolorCommand,
  isBulkCompletionCommand,
  isBulkBackstitchCompletionCommand,
  isPasteFragmentCommand,
  isMoveFragmentCommand,
  isMixedEraseCommand,
  isDeleteRegionCommand,
  isDeleteCellSetCommand,
  MutationTracker,
  preflightPasteFragmentCommand,
  preflightMoveFragmentCommand,
  preflightBulkCellCommand,
  preflightBulkRecolorCommand,
  preflightBulkCompletionCommand,
  preflightBulkBackstitchCompletionCommand,
  preflightMixedEraseCommand,
  preflightDeleteRegionCommand,
  preflightDeleteCellSetCommand,
  deriveExplicitCompletionProgress,
  type MutationInfo,
  type SparseMutationDelta
} from './commands';
import { cloneDocument, clonePaletteEntry, clonePatternSettings, emptyBackstitches } from './model';
import type {
  BackstitchStore,
  CommandResult,
  Layer,
  LayeredDocument,
  CropRect,
  DomainCommand,
  HalfDirection,
  PaletteEntry,
  PatternSettings,
  PatternDocument,
  Point,
  QuarterCorner,
  ProgressChangeSet
} from './types';
import { DEFAULT_PATTERN_SETTINGS, DOCUMENT_SCHEMA_VERSION, DomainError, LayerType, MAX_LAYER_NAME_CHARS, MAX_LAYERS_PER_TYPE, MaterialUnit, MAX_PERSISTABLE_CELL_COUNT, PALETTE_ID_MAX } from './types';
import { assertValidDocument, collectValidationErrors } from './validation';
import {
  attachDeleteMetricsImpactForDelta
} from './internal-metrics-impact';
import {
  applyLayerStructureCommand,
  assertValidLayeredDocument,
  commandLayerType,
  commandScope,
  FlattenCache,
  layeredFromSurface,
  layerSurface,
  requireEditableLayer
} from './layers';

export const DEFAULT_HISTORY_LIMIT_BYTES = 64 * 1024 * 1024;
/** Version of the single-surface history DTO kept by `SurfaceEditor`. */
export const SURFACE_EDITOR_HISTORY_VERSION = 1 as const;
export const DEFAULT_HISTORY_EXPORT_CAP_BYTES = 16 * 1024 * 1024;
export const MAX_HISTORY_DECODE_BYTES = 64 * 1024 * 1024;
export const MAX_HISTORY_ENTRY_COUNT = 100_000;
const MAX_HISTORY_STRING_CHARS = 4_000_000;

export interface HistoryOptions {
  historyLimitBytes?: number;
  maxHistoryBytes?: number;
}

export interface HistoryExportOptions {
  /** Optional history-accounting cap. Entries are dropped from the oldest end first. */
  maxBytes?: number;
}

export interface HistoryProgressDto {
  readonly cellIndices: Uint32Array;
  readonly backstitchIds: Uint32Array;
  readonly marked: number;
  readonly unmarked: number;
}

export interface HistoryPackedCellDeltaDto {
  readonly indices: Uint32Array;
  readonly beforeKind: Uint8Array;
  readonly beforeColors: Uint16Array;
  readonly beforeCompleted: Uint8Array;
  readonly afterKind: Uint8Array;
  readonly afterColors: Uint16Array;
  readonly afterCompleted: Uint8Array;
}

export interface HistoryCellCompletionDeltaDto {
  readonly indices: Uint32Array;
  readonly beforeCompleted: Uint8Array;
  readonly afterCompleted: Uint8Array;
}

export interface HistoryBackstitchCompletionDeltaDto {
  readonly ids: Uint32Array;
  readonly beforeCompleted: Uint8Array;
  readonly afterCompleted: Uint8Array;
}

export interface HistoryDeltaDto {
  readonly cells: HistoryPackedCellDeltaDto;
  readonly cellCompletions?: HistoryCellCompletionDeltaDto;
  readonly backstitchCompletions?: HistoryBackstitchCompletionDeltaDto;
  readonly beforePalette?: readonly PaletteEntry[];
  readonly afterPalette?: readonly PaletteEntry[];
  readonly beforeBackstitches?: BackstitchStore;
  readonly afterBackstitches?: BackstitchStore;
  readonly beforeNextBackstitchId?: number;
  readonly afterNextBackstitchId?: number;
  readonly beforeNextPaletteId?: number;
  readonly afterNextPaletteId?: number;
  readonly beforeSettings?: PatternSettings;
  readonly afterSettings?: PatternSettings;
}

export interface HistoryDeltaEntryDto {
  readonly kind: 'delta';
  readonly delta: HistoryDeltaDto;
  readonly bytes: number;
  readonly progress: HistoryProgressDto;
  readonly recalculateMetrics: boolean;
}

export interface HistorySnapshotEntryDto {
  readonly kind: 'snapshot';
  readonly before: PatternDocument;
  readonly after: PatternDocument;
  readonly bytes: number;
  readonly progress: HistoryProgressDto;
  readonly recalculateMetrics: boolean;
}

export type SurfaceHistoryEntryDto = HistoryDeltaEntryDto | HistorySnapshotEntryDto;

export interface SurfaceEditorHistoryDto {
  readonly version: typeof SURFACE_EDITOR_HISTORY_VERSION;
  readonly undo: readonly SurfaceHistoryEntryDto[];
  readonly redo: readonly SurfaceHistoryEntryDto[];
}

interface SnapshotEntry {
  kind: 'snapshot';
  before: PatternDocument;
  after: PatternDocument;
  bytes: number;
  progress: ProgressChangeSet;
  recalculateMetrics: boolean;
}

interface DeltaEntry {
  kind: 'delta';
  delta: SparseMutationDelta;
  bytes: number;
  progress: ProgressChangeSet;
  recalculateMetrics: boolean;
}

type HistoryEntry = SnapshotEntry | DeltaEntry;

function writeBackstitches(document: PatternDocument, store: PatternDocument['backstitches']): void {
  document.backstitches = {
    ids: store.ids.slice(),
    x1: store.x1.slice(),
    y1: store.y1.slice(),
    x2: store.x2.slice(),
    y2: store.y2.slice(),
    colors: store.colors.slice(),
    completed: store.completed.slice()
  };
}

function cloneForDelete(document: PatternDocument): PatternDocument {
  return {
    ...document,
    kind: document.kind.slice(),
    colors: document.colors.slice(),
    completed: document.completed.slice()
  };
}

function cloneBackstitchCompletionPlane(document: PatternDocument): void {
  document.backstitches = {
    ...document.backstitches,
    completed: document.backstitches.completed.slice()
  };
}

function normalizedPaletteCommandType(command: DomainCommand): string {
  if (!command || typeof command.type !== 'string') return '';
  const normalized = command.type.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();
  if (normalized === 'create-palette' || normalized === 'add-palette' || normalized === 'palette-add') return 'palette-create';
  if (normalized === 'update-palette') return 'palette-update';
  if (normalized === 'deactivate-color' || normalized === 'deactivate-palette-color') return 'palette-deactivate';
  return normalized;
}

function isPaletteMetadataOnlyCommand(command: DomainCommand): boolean {
  const type = normalizedPaletteCommandType(command);
  if (type === 'palette-create' || type === 'palette-update' || type === 'palette-deactivate') return true;
  if (type !== 'batch' || !Array.isArray(command.commands) || command.commands.length === 0) return false;
  return command.commands.every((child) => isPaletteMetadataOnlyCommand(child as DomainCommand));
}

function applyPackedCellSide(document: PatternDocument, cells: SparseMutationDelta['cells'], useAfter: boolean): void {
  const sourceKind = useAfter ? cells.afterKind : cells.beforeKind;
  const sourceColors = useAfter ? cells.afterColors : cells.beforeColors;
  const sourceCompleted = useAfter ? cells.afterCompleted : cells.beforeCompleted;

  let runStart = 0;
  while (runStart < cells.indices.length) {
    let runEnd = runStart + 1;
    while (runEnd < cells.indices.length && cells.indices[runEnd] === cells.indices[runEnd - 1] + 1) runEnd += 1;
    const runLength = runEnd - runStart;
    const destination = cells.indices[runStart];
    if (runLength > 1) {
      document.kind.set(sourceKind.subarray(runStart, runEnd), destination);
      document.completed.set(sourceCompleted.subarray(runStart, runEnd), destination);
      document.colors.set(sourceColors.subarray(runStart * 4, runEnd * 4), destination * 4);
    } else {
      const colorOffset = runStart * 4;
      const documentOffset = destination * 4;
      document.kind[destination] = sourceKind[runStart];
      document.completed[destination] = sourceCompleted[runStart];
      for (let slot = 0; slot < 4; slot += 1) document.colors[documentOffset + slot] = sourceColors[colorOffset + slot];
    }
    runStart = runEnd;
  }
}

function applyDelta(document: PatternDocument, delta: SparseMutationDelta, useAfter: boolean): PatternDocument {
  const next: PatternDocument = { ...document };
  const cells = delta.cells;
  if (cells.indices.length > 0) {
    next.kind = document.kind.slice();
    next.colors = document.colors.slice();
    next.completed = document.completed.slice();
    applyPackedCellSide(next, cells, useAfter);
  }
  const cellCompletionDelta = delta.cellCompletions;
  if (cellCompletionDelta !== undefined && cellCompletionDelta.indices.length > 0) {
    if (cells.indices.length === 0) next.completed = document.completed.slice();
    for (let position = 0; position < cellCompletionDelta.indices.length; position += 1) {
      const index = cellCompletionDelta.indices[position];
      next.completed[index] = useAfter ? cellCompletionDelta.afterCompleted[position] : cellCompletionDelta.beforeCompleted[position];
    }
  }
  const palette = useAfter ? delta.afterPalette : delta.beforePalette;
  if (palette !== undefined) next.palette = palette.map(clonePaletteEntry);
  const backstitches = useAfter ? delta.afterBackstitches : delta.beforeBackstitches;
  if (backstitches !== undefined) writeBackstitches(next, backstitches);
  const completionDelta = delta.backstitchCompletions;
  if (completionDelta !== undefined && completionDelta.ids.length > 0) {
    if (backstitches === undefined) cloneBackstitchCompletionPlane(next);
    for (let position = 0; position < completionDelta.ids.length; position += 1) {
      const id = completionDelta.ids[position];
      const backstitchPosition = next.backstitches.ids.findIndex((candidate) => candidate === id);
      if (backstitchPosition >= 0) next.backstitches.completed[backstitchPosition] = useAfter ? completionDelta.afterCompleted[position] : completionDelta.beforeCompleted[position];
    }
  }
  const nextBackstitchId = useAfter ? delta.afterNextBackstitchId : delta.beforeNextBackstitchId;
  const nextPaletteId = useAfter ? delta.afterNextPaletteId : delta.beforeNextPaletteId;
  if (nextBackstitchId !== undefined) next.nextBackstitchId = nextBackstitchId;
  if (nextPaletteId !== undefined) next.nextPaletteId = nextPaletteId;
  const settings = useAfter ? delta.afterSettings : delta.beforeSettings;
  if (settings !== undefined) next.settings = clonePatternSettings(settings);
  return next;
}

function typedDeltaBytes(delta: SparseMutationDelta): number {
  const cells = delta.cells;
  let bytes = cells.indices.byteLength + cells.beforeKind.byteLength + cells.beforeColors.byteLength + cells.beforeCompleted.byteLength + cells.afterKind.byteLength + cells.afterColors.byteLength + cells.afterCompleted.byteLength;
  for (const store of [delta.beforeBackstitches, delta.afterBackstitches]) {
    if (store) bytes += store.ids.byteLength + store.x1.byteLength + store.y1.byteLength + store.x2.byteLength + store.y2.byteLength + store.colors.byteLength + store.completed.byteLength;
  }
  if (delta.cellCompletions) bytes += delta.cellCompletions.indices.byteLength + delta.cellCompletions.beforeCompleted.byteLength + delta.cellCompletions.afterCompleted.byteLength;
  if (delta.backstitchCompletions) bytes += delta.backstitchCompletions.ids.byteLength + delta.backstitchCompletions.beforeCompleted.byteLength + delta.backstitchCompletions.afterCompleted.byteLength;
  for (const palette of [delta.beforePalette, delta.afterPalette]) if (palette) bytes += JSON.stringify(palette).length * 2;
  for (const settings of [delta.beforeSettings, delta.afterSettings]) if (settings) bytes += JSON.stringify(settings).length * 2;
  return bytes + 32;
}

function snapshotBytes(document: PatternDocument): number {
  const store = document.backstitches;
  return document.kind.byteLength + document.colors.byteLength + document.completed.byteLength + store.ids.byteLength + store.x1.byteLength + store.y1.byteLength + store.x2.byteLength + store.y2.byteLength + store.colors.byteLength + store.completed.byteLength + JSON.stringify(document.catalog).length * 2 + JSON.stringify(document.palette).length * 2 + JSON.stringify(document.settings).length * 2 + 64;
}

function legacySnapshotBytes(document: PatternDocument): number {
  const store = document.backstitches;
  return document.kind.byteLength + document.colors.byteLength + document.completed.byteLength + store.ids.byteLength + store.x1.byteLength + store.y1.byteLength + store.x2.byteLength + store.y2.byteLength + store.colors.byteLength + store.completed.byteLength + JSON.stringify(document.catalog).length * 2 + JSON.stringify(document.palette).length * 2 + 64;
}

function isLegacySnapshotEntry(entry: SurfaceHistoryEntryDto): entry is HistorySnapshotEntryDto {
  return entry.kind === 'snapshot'
    && isLegacyPatternSettings(entry.before.settings as unknown as HistoryRecord)
    && isLegacyPatternSettings(entry.after.settings as unknown as HistoryRecord);
}

function documentWithUpgradedHistorySettings(document: PatternDocument, allowLegacy: boolean): PatternDocument {
  const settings = document.settings as unknown as HistoryRecord;
  if (!allowLegacy || !isLegacyPatternSettings(settings)) return document;
  return {
    ...document,
    settings: {
      symbolSet: settings.symbolSet as string,
      materialUnit: settings.materialUnit as PatternSettings['materialUnit'],
      backgroundColor: DEFAULT_PATTERN_SETTINGS.backgroundColor,
      aidaCount: DEFAULT_PATTERN_SETTINGS.aidaCount
    }
  };
}

function cloneHistoryDocument(document: PatternDocument, allowLegacy: boolean): PatternDocument {
  const clone = cloneDocument(document);
  if (allowLegacy && isLegacyPatternSettings(document.settings as unknown as HistoryRecord)) {
    clone.settings = {
      symbolSet: document.settings.symbolSet,
      materialUnit: document.settings.materialUnit,
      backgroundColor: DEFAULT_PATTERN_SETTINGS.backgroundColor,
      aidaCount: DEFAULT_PATTERN_SETTINGS.aidaCount
    };
  }
  return clone;
}

function result(document: PatternDocument, changed: boolean, backstitchId?: number, paletteId?: number, details?: MutationInfo): CommandResult {
  return {
    document,
    changed,
    revision: document.revision,
    ...(backstitchId === undefined ? {} : { backstitchId }),
    ...(paletteId === undefined ? {} : { paletteId }),
    ...(details?.touchedIndices === undefined ? {} : { touchedIndices: details.touchedIndices.slice() }),
    ...(details?.changedIndices === undefined ? {} : { changedIndices: details.changedIndices.slice() }),
    ...(details?.touchedBackstitchIds === undefined ? {} : { touchedBackstitchIds: details.touchedBackstitchIds.slice() }),
    ...(details?.changedBackstitchIds === undefined ? {} : { changedBackstitchIds: details.changedBackstitchIds.slice() }),
    ...(details?.progress === undefined ? {} : { progress: { cellIndices: details.progress.cellIndices.slice(), backstitchIds: details.progress.backstitchIds.slice(), marked: details.progress.marked, unmarked: details.progress.unmarked } }),
    ...(details?.recalculateMetrics === undefined ? {} : { recalculateMetrics: details.recalculateMetrics }),
    ...(details?.createdBackstitchIds === undefined ? {} : { createdBackstitchIds: details.createdBackstitchIds.slice() }),
    ...(details?.movedBackstitchIds === undefined ? {} : { movedBackstitchIds: details.movedBackstitchIds.slice() })
  };
}

function emptyProgress(): ProgressChangeSet {
  return { cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0), marked: 0, unmarked: 0 };
}

function cloneProgress(progress: ProgressChangeSet | undefined): ProgressChangeSet {
  return progress === undefined
    ? emptyProgress()
    : { cellIndices: progress.cellIndices.slice(), backstitchIds: progress.backstitchIds.slice(), marked: progress.marked, unmarked: progress.unmarked };
}

function deltaRequiresFullRedraw(delta: SparseMutationDelta): boolean {
  return delta.beforePalette !== undefined
    || delta.afterPalette !== undefined
    || delta.beforeSettings !== undefined
    || delta.afterSettings !== undefined
    || delta.beforeBackstitches !== undefined
    || delta.afterBackstitches !== undefined
    || (delta.backstitchCompletions?.ids.length ?? 0) > 0;
}

function settingsEqual(left: PatternSettings, right: PatternSettings): boolean {
  return left.symbolSet === right.symbolSet
    && left.materialUnit === right.materialUnit
    && left.backgroundColor === right.backgroundColor
    && left.aidaCount === right.aidaCount;
}

function snapshotSettingsChanged(entry: SnapshotEntry): boolean {
  return !settingsEqual(entry.before.settings, entry.after.settings);
}

type HistoryRecord = Record<string, unknown>;

function historyRecord(value: unknown, label: string): HistoryRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new DomainError('invalid-history-state', `${label} must be an object.`);
  return value as HistoryRecord;
}

function historyKeys(value: HistoryRecord, required: readonly string[], optional: readonly string[] = [], label: string): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) throw new DomainError('invalid-history-state', `${label}.${key} is required.`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new DomainError('invalid-history-state', `${label}.${key} is not supported.`);
}

function historySafeInteger(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new DomainError('invalid-history-state', `${label} must be a safe integer >= ${String(minimum)}.`);
  return value as number;
}

function historyBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new DomainError('invalid-history-state', `${label} must be a boolean.`);
  return value;
}

function historyArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new DomainError('invalid-history-state', `${label} must be an array.`);
  return value;
}

function historyBoundedString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length > MAX_HISTORY_STRING_CHARS) throw new DomainError('invalid-history-state', `${label} is not a bounded string.`);
}

function historyUint8(value: unknown, label: string): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.constructor !== Uint8Array) throw new DomainError('invalid-history-state', `${label} must be a Uint8Array.`);
}

function historyUint16(value: unknown, label: string): asserts value is Uint16Array {
  if (!(value instanceof Uint16Array) || value.constructor !== Uint16Array) throw new DomainError('invalid-history-state', `${label} must be a Uint16Array.`);
}

function historyUint32(value: unknown, label: string): asserts value is Uint32Array {
  if (!(value instanceof Uint32Array) || value.constructor !== Uint32Array) throw new DomainError('invalid-history-state', `${label} must be a Uint32Array.`);
}

function historyLength(value: ArrayLike<unknown>, expected: number, label: string): void {
  if (value.length !== expected) throw new DomainError('invalid-history-state', `${label} has an invalid length.`);
}

function historyStrictIndices(value: unknown, limit: number, label: string): asserts value is Uint32Array {
  historyUint32(value, label);
  let previous = -1;
  for (const index of value) {
    if (index <= previous || index >= limit) throw new DomainError('invalid-history-state', `${label} contains an illegal or unsorted index.`);
    previous = index;
  }
}

function historyUniqueIndices(value: unknown, limit: number, label: string): asserts value is Uint32Array {
  historyUint32(value, label);
  const seen = new Set<number>();
  for (const index of value) {
    if (index >= limit || seen.has(index)) throw new DomainError('invalid-history-state', `${label} contains an illegal or duplicate index.`);
    seen.add(index);
  }
}

function historyPaletteEntry(value: unknown, label: string): void {
  const entry = historyRecord(value, label);
  historyKeys(entry, ['id', 'name', 'color', 'active', 'symbol', 'material'], ['catalog'], label);
  historySafeInteger(entry.id, `${label}.id`, 1);
  if (typeof entry.name !== 'string' || typeof entry.color !== 'string' || typeof entry.symbol !== 'string' || typeof entry.active !== 'boolean') throw new DomainError('invalid-history-state', `${label} has invalid scalar fields.`);
  historyBoundedString(entry.name, `${label}.name`);
  historyBoundedString(entry.color, `${label}.color`);
  historyBoundedString(entry.symbol, `${label}.symbol`);
  const material = historyRecord(entry.material, `${label}.material`);
  historyKeys(material, ['kind', 'label', 'unit'], ['amount'], `${label}.material`);
  if (typeof material.kind !== 'string' || typeof material.label !== 'string' || typeof material.unit !== 'string') throw new DomainError('invalid-history-state', `${label}.material has invalid scalar fields.`);
  historyBoundedString(material.kind, `${label}.material.kind`);
  historyBoundedString(material.label, `${label}.material.label`);
  historyBoundedString(material.unit, `${label}.material.unit`);
  if (material.amount !== undefined && (typeof material.amount !== 'number' || !Number.isFinite(material.amount) || material.amount < 0)) throw new DomainError('invalid-history-state', `${label}.material.amount is invalid.`);
  if (entry.catalog !== undefined) {
    const catalog = historyRecord(entry.catalog, `${label}.catalog`);
    historyKeys(catalog, ['catalogId', 'sourceId', 'code', 'name', 'hex', 'rgb'], [], `${label}.catalog`);
    if ([catalog.catalogId, catalog.sourceId, catalog.code, catalog.name, catalog.hex].some((field) => typeof field !== 'string')) throw new DomainError('invalid-history-state', `${label}.catalog has invalid scalar fields.`);
    historyBoundedString(catalog.catalogId, `${label}.catalog.catalogId`);
    historyBoundedString(catalog.sourceId, `${label}.catalog.sourceId`);
    historyBoundedString(catalog.code, `${label}.catalog.code`);
    historyBoundedString(catalog.name, `${label}.catalog.name`);
    historyBoundedString(catalog.hex, `${label}.catalog.hex`);
    if (!Array.isArray(catalog.rgb) || catalog.rgb.length !== 3 || catalog.rgb.some((channel) => typeof channel !== 'number' || !Number.isInteger(channel) || channel < 0 || channel > 255)) throw new DomainError('invalid-history-state', `${label}.catalog.rgb is invalid.`);
  }
}

function historyPalette(value: unknown, label: string): asserts value is PaletteEntry[] {
  const entries = historyArray(value, label);
  for (let index = 0; index < entries.length; index += 1) historyPaletteEntry(entries[index], `${label}[${String(index)}]`);
}

function historyCatalog(value: unknown, label: string): void {
  const catalog = historyRecord(value, label);
  historyKeys(catalog, ['catalogId', 'brandLabel', 'colorCount'], [], label);
  historyBoundedString(catalog.catalogId, `${label}.catalogId`);
  historyBoundedString(catalog.brandLabel, `${label}.brandLabel`);
  const colorCount = historySafeInteger(catalog.colorCount, `${label}.colorCount`, 1);
  if (colorCount > PALETTE_ID_MAX) throw new DomainError('invalid-history-state', `${label}.colorCount exceeds the palette ID limit.`);
}

function historyBackstitches(value: unknown, label: string): asserts value is BackstitchStore {
  const store = historyRecord(value, label);
  historyKeys(store, ['ids', 'x1', 'y1', 'x2', 'y2', 'colors', 'completed'], [], label);
  historyUint32(store.ids, `${label}.ids`);
  historyUint32(store.x1, `${label}.x1`);
  historyUint32(store.y1, `${label}.y1`);
  historyUint32(store.x2, `${label}.x2`);
  historyUint32(store.y2, `${label}.y2`);
  historyUint16(store.colors, `${label}.colors`);
  historyUint8(store.completed, `${label}.completed`);
  const length = store.ids.length;
  historyLength(store.x1, length, `${label}.x1`);
  historyLength(store.y1, length, `${label}.y1`);
  historyLength(store.x2, length, `${label}.x2`);
  historyLength(store.y2, length, `${label}.y2`);
  historyLength(store.colors, length, `${label}.colors`);
  historyLength(store.completed, length, `${label}.completed`);
}

function isLegacyPatternSettings(value: Record<string, unknown>): boolean {
  return Object.keys(value).length === 2
    && Object.prototype.hasOwnProperty.call(value, 'symbolSet')
    && Object.prototype.hasOwnProperty.call(value, 'materialUnit')
    && !Object.prototype.hasOwnProperty.call(value, 'backgroundColor');
}

function historyDocument(value: unknown, label: string): asserts value is PatternDocument {
  const document = historyRecord(value, label) as unknown as PatternDocument;
  historyKeys(document as unknown as HistoryRecord, ['version', 'catalog', 'width', 'height', 'kind', 'colors', 'completed', 'backstitches', 'palette', 'settings', 'revision', 'nextBackstitchId', 'nextPaletteId'], [], label);
  historySafeInteger(document.width, `${label}.width`, 1);
  historySafeInteger(document.height, `${label}.height`, 1);
  const cellCount = document.width * document.height;
  if (!Number.isSafeInteger(cellCount)) throw new DomainError('invalid-history-state', `${label} dimensions overflow.`);
  historyUint8(document.kind, `${label}.kind`);
  historyUint16(document.colors, `${label}.colors`);
  historyUint8(document.completed, `${label}.completed`);
  historyLength(document.kind, cellCount, `${label}.kind`);
  historyLength(document.colors, cellCount * 4, `${label}.colors`);
  historyLength(document.completed, cellCount, `${label}.completed`);
  historyCatalog(document.catalog, `${label}.catalog`);
  historyBackstitches(document.backstitches, `${label}.backstitches`);
  historyPalette(document.palette, `${label}.palette`);
  const settings = historyRecord(document.settings, `${label}.settings`);
  const legacySettings = isLegacyPatternSettings(settings);
  historyKeys(settings, legacySettings ? ['symbolSet', 'materialUnit'] : ['symbolSet', 'materialUnit', 'backgroundColor', 'aidaCount'], [], `${label}.settings`);
  if (typeof settings.symbolSet !== 'string' || typeof settings.materialUnit !== 'string') throw new DomainError('invalid-history-state', `${label}.settings is invalid.`);
  historyBoundedString(settings.symbolSet, `${label}.settings.symbolSet`);
  historyBoundedString(settings.materialUnit, `${label}.settings.materialUnit`);
  if (!legacySettings) {
    if (typeof settings.backgroundColor !== 'string') throw new DomainError('invalid-history-state', `${label}.settings.backgroundColor is invalid.`);
    historyBoundedString(settings.backgroundColor, `${label}.settings.backgroundColor`);
    if (!/^#[0-9A-F]{6}$/.test(settings.backgroundColor)) throw new DomainError('invalid-history-state', `${label}.settings.backgroundColor is invalid.`);
    historyAidaCount(settings.aidaCount, `${label}.settings.aidaCount`);
  }
  historySafeInteger(document.revision, `${label}.revision`);
  historySafeInteger(document.nextBackstitchId, `${label}.nextBackstitchId`, 1);
  historySafeInteger(document.nextPaletteId, `${label}.nextPaletteId`, 1);
}

function historyTypedArraysEqual(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function documentsContentEqual(left: PatternDocument, right: PatternDocument): boolean {
  return left.version === right.version
    && JSON.stringify(left.catalog) === JSON.stringify(right.catalog)
    && left.width === right.width
    && left.height === right.height
    && historyTypedArraysEqual(left.kind, right.kind)
    && historyTypedArraysEqual(left.colors, right.colors)
    && historyTypedArraysEqual(left.completed, right.completed)
    && historyPaletteEqual(left.palette, right.palette)
    && settingsEqual(left.settings, right.settings)
    && left.nextBackstitchId === right.nextBackstitchId
    && left.nextPaletteId === right.nextPaletteId
    && historyTypedArraysEqual(left.backstitches.ids, right.backstitches.ids)
    && historyTypedArraysEqual(left.backstitches.x1, right.backstitches.x1)
    && historyTypedArraysEqual(left.backstitches.y1, right.backstitches.y1)
    && historyTypedArraysEqual(left.backstitches.x2, right.backstitches.x2)
    && historyTypedArraysEqual(left.backstitches.y2, right.backstitches.y2)
    && historyTypedArraysEqual(left.backstitches.colors, right.backstitches.colors)
    && historyTypedArraysEqual(left.backstitches.completed, right.backstitches.completed);
}

function historyPaletteEqual(left: readonly PaletteEntry[], right: readonly PaletteEntry[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index].id !== right[index].id || left[index].name !== right[index].name || left[index].color !== right[index].color || left[index].active !== right[index].active || left[index].symbol !== right[index].symbol) return false;
    if (left[index].material.kind !== right[index].material.kind || left[index].material.label !== right[index].material.label || left[index].material.unit !== right[index].material.unit || left[index].material.amount !== right[index].material.amount) return false;
    if (JSON.stringify(left[index].catalog) !== JSON.stringify(right[index].catalog)) return false;
  }
  return true;
}

function historyProgress(value: unknown, cellCount: number, label: string): asserts value is HistoryProgressDto {
  const progress = historyRecord(value, label);
  historyKeys(progress, ['cellIndices', 'backstitchIds', 'marked', 'unmarked'], [], label);
  historyUint32(progress.cellIndices, `${label}.cellIndices`);
  for (const index of progress.cellIndices) if (index >= cellCount) throw new DomainError('invalid-history-state', `${label}.cellIndices contains an illegal index.`);
  historyUint32(progress.backstitchIds, `${label}.backstitchIds`);
  historySafeInteger(progress.marked, `${label}.marked`);
  historySafeInteger(progress.unmarked, `${label}.unmarked`);
}

function historyPackedCells(value: unknown, cellCount: number, label: string): asserts value is HistoryPackedCellDeltaDto {
  const cells = historyRecord(value, label);
  historyKeys(cells, ['indices', 'beforeKind', 'beforeColors', 'beforeCompleted', 'afterKind', 'afterColors', 'afterCompleted'], [], label);
  historyUniqueIndices(cells.indices, cellCount, `${label}.indices`);
  const count = cells.indices.length;
  historyUint8(cells.beforeKind, `${label}.beforeKind`);
  historyUint16(cells.beforeColors, `${label}.beforeColors`);
  historyUint8(cells.beforeCompleted, `${label}.beforeCompleted`);
  historyUint8(cells.afterKind, `${label}.afterKind`);
  historyUint16(cells.afterColors, `${label}.afterColors`);
  historyUint8(cells.afterCompleted, `${label}.afterCompleted`);
  historyLength(cells.beforeKind, count, `${label}.beforeKind`);
  historyLength(cells.afterKind, count, `${label}.afterKind`);
  historyLength(cells.beforeColors, count * 4, `${label}.beforeColors`);
  historyLength(cells.afterColors, count * 4, `${label}.afterColors`);
  historyLength(cells.beforeCompleted, count, `${label}.beforeCompleted`);
  historyLength(cells.afterCompleted, count, `${label}.afterCompleted`);
}

function historyCellCompletions(value: unknown, cellCount: number, label: string): asserts value is HistoryCellCompletionDeltaDto {
  const completion = historyRecord(value, label);
  historyKeys(completion, ['indices', 'beforeCompleted', 'afterCompleted'], [], label);
  historyStrictIndices(completion.indices, cellCount, `${label}.indices`);
  historyUint8(completion.beforeCompleted, `${label}.beforeCompleted`);
  historyUint8(completion.afterCompleted, `${label}.afterCompleted`);
  historyLength(completion.beforeCompleted, completion.indices.length, `${label}.beforeCompleted`);
  historyLength(completion.afterCompleted, completion.indices.length, `${label}.afterCompleted`);
}

function historyBackstitchCompletions(value: unknown, label: string): asserts value is HistoryBackstitchCompletionDeltaDto {
  const completion = historyRecord(value, label);
  historyKeys(completion, ['ids', 'beforeCompleted', 'afterCompleted'], [], label);
  historyUint32(completion.ids, `${label}.ids`);
  historyUint8(completion.beforeCompleted, `${label}.beforeCompleted`);
  historyUint8(completion.afterCompleted, `${label}.afterCompleted`);
  historyLength(completion.beforeCompleted, completion.ids.length, `${label}.beforeCompleted`);
  historyLength(completion.afterCompleted, completion.ids.length, `${label}.afterCompleted`);
  let previous = 0;
  for (const id of completion.ids) {
    if (id === 0 || id <= previous) throw new DomainError('invalid-history-state', `${label}.ids must be strictly increasing and non-zero.`);
    previous = id;
  }
}

function historyPatternSettings(value: unknown, label: string): asserts value is PatternSettings {
  const settings = historyRecord(value, label);
  historyKeys(settings, ['symbolSet', 'materialUnit', 'backgroundColor', 'aidaCount'], [], label);
  if (typeof settings.symbolSet !== 'string' || settings.symbolSet.trim() === '') throw new DomainError('invalid-history-state', `${label}.symbolSet is invalid.`);
  if (settings.materialUnit !== MaterialUnit.Skeins && settings.materialUnit !== MaterialUnit.Meters && settings.materialUnit !== MaterialUnit.Count) throw new DomainError('invalid-history-state', `${label}.materialUnit is invalid.`);
  if (typeof settings.backgroundColor !== 'string' || !/^#[0-9A-F]{6}$/.test(settings.backgroundColor)) throw new DomainError('invalid-history-state', `${label}.backgroundColor is invalid.`);
  historyAidaCount(settings.aidaCount, `${label}.aidaCount`);
}

function historyAidaCount(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new DomainError('invalid-history-state', `${label} is invalid.`);
}

function historyDelta(value: unknown, cellCount: number, label: string): asserts value is HistoryDeltaDto {
  const delta = historyRecord(value, label);
  historyKeys(delta, ['cells'], ['cellCompletions', 'backstitchCompletions', 'beforePalette', 'afterPalette', 'beforeBackstitches', 'afterBackstitches', 'beforeNextBackstitchId', 'afterNextBackstitchId', 'beforeNextPaletteId', 'afterNextPaletteId', 'beforeSettings', 'afterSettings'], label);
  const cells = historyRecord(delta.cells, `${label}.cells`);
  const cellIndices = cells.indices;
  historyUniqueIndices(cellIndices, cellCount, `${label}.cells.indices`);
  historyPackedCells({ ...cells, indices: cellIndices }, cellCount, `${label}.cells`);
  if (delta.cellCompletions !== undefined) historyCellCompletions(delta.cellCompletions, cellCount, `${label}.cellCompletions`);
  if (delta.backstitchCompletions !== undefined) historyBackstitchCompletions(delta.backstitchCompletions, `${label}.backstitchCompletions`);
  if (delta.beforePalette !== undefined) historyPalette(delta.beforePalette, `${label}.beforePalette`);
  if (delta.afterPalette !== undefined) historyPalette(delta.afterPalette, `${label}.afterPalette`);
  if ((delta.beforePalette === undefined) !== (delta.afterPalette === undefined)) throw new DomainError('invalid-history-state', `${label} palette sides must be paired.`);
  if (delta.beforeBackstitches !== undefined) historyBackstitches(delta.beforeBackstitches, `${label}.beforeBackstitches`);
  if (delta.afterBackstitches !== undefined) historyBackstitches(delta.afterBackstitches, `${label}.afterBackstitches`);
  if ((delta.beforeBackstitches === undefined) !== (delta.afterBackstitches === undefined)) throw new DomainError('invalid-history-state', `${label} backstitch sides must be paired.`);
  if (delta.beforeSettings !== undefined) historyPatternSettings(delta.beforeSettings, `${label}.beforeSettings`);
  if (delta.afterSettings !== undefined) historyPatternSettings(delta.afterSettings, `${label}.afterSettings`);
  if ((delta.beforeSettings === undefined) !== (delta.afterSettings === undefined)) throw new DomainError('invalid-history-state', `${label} settings sides must be paired.`);
  if ((delta.beforeNextBackstitchId === undefined) !== (delta.afterNextBackstitchId === undefined)) throw new DomainError('invalid-history-state', `${label} backstitch allocator sides must be paired.`);
  if ((delta.beforeNextPaletteId === undefined) !== (delta.afterNextPaletteId === undefined)) throw new DomainError('invalid-history-state', `${label} palette allocator sides must be paired.`);
  if (delta.beforeNextBackstitchId !== undefined) {
    historySafeInteger(delta.beforeNextBackstitchId, `${label}.beforeNextBackstitchId`, 1);
    historySafeInteger(delta.afterNextBackstitchId, `${label}.afterNextBackstitchId`, 1);
  }
  if (delta.beforeNextPaletteId !== undefined) {
    historySafeInteger(delta.beforeNextPaletteId, `${label}.beforeNextPaletteId`, 1);
    historySafeInteger(delta.afterNextPaletteId, `${label}.afterNextPaletteId`, 1);
  }
}

function historyEntry(value: unknown, cellCount: number, label: string): asserts value is SurfaceHistoryEntryDto {
  const entry = historyRecord(value, label);
  if (entry.kind === 'delta') {
    historyKeys(entry, ['kind', 'delta', 'bytes', 'progress', 'recalculateMetrics'], [], label);
    historyDelta(entry.delta, cellCount, `${label}.delta`);
  } else if (entry.kind === 'snapshot') {
    historyKeys(entry, ['kind', 'before', 'after', 'bytes', 'progress', 'recalculateMetrics'], [], label);
    historyDocument(entry.before, `${label}.before`);
    historyDocument(entry.after, `${label}.after`);
  } else {
    throw new DomainError('invalid-history-state', `${label}.kind is unsupported.`);
  }
  historySafeInteger(entry.bytes, `${label}.bytes`, 1);
  historyProgress(entry.progress, cellCount, `${label}.progress`);
  historyBoolean(entry.recalculateMetrics, `${label}.recalculateMetrics`);
}

function historyState(value: unknown): asserts value is SurfaceEditorHistoryDto {
  const state = historyRecord(value, 'history');
  historyKeys(state, ['version', 'undo', 'redo'], [], 'history');
  if (state.version !== SURFACE_EDITOR_HISTORY_VERSION) throw new DomainError('unsupported-history-version', `History version ${String(state.version)} is not supported.`);
  const undo = historyArray(state.undo, 'history.undo');
  const redo = historyArray(state.redo, 'history.redo');
  const width = undo.length + redo.length;
  if (!Number.isSafeInteger(width) || width > MAX_HISTORY_ENTRY_COUNT) throw new DomainError('invalid-history-state', 'History entry count is invalid or exceeds the decode bound.');
  for (let index = 0; index < undo.length; index += 1) historyEntry(undo[index], MAX_PERSISTABLE_CELL_COUNT, `history.undo[${String(index)}]`);
  for (let index = 0; index < redo.length; index += 1) historyEntry(redo[index], MAX_PERSISTABLE_CELL_COUNT, `history.redo[${String(index)}]`);
}

function historyRawAdd(total: number, amount: number): number {
  if (!Number.isSafeInteger(amount) || amount < 0 || total > MAX_HISTORY_DECODE_BYTES - amount) throw new DomainError('history-too-large', `History payload exceeds the ${String(MAX_HISTORY_DECODE_BYTES)} byte decode ceiling.`);
  return total + amount;
}

function historyRawString(total: number, value: string): number {
  return historyRawAdd(total, 16 + value.length * 2);
}

function historyRawTyped(total: number, value: Uint8Array | Uint16Array | Uint32Array): number {
  return historyRawAdd(total, 24 + value.byteLength);
}

function historyRawObject(total: number, fields: number): number {
  return historyRawAdd(total, 64 + fields * 8);
}

function historyRawArray(total: number, length: number): number {
  return historyRawAdd(total, 24 + length * 8);
}

function historyRawPaletteEntry(total: number, entry: PaletteEntry): number {
  let next = historyRawObject(total, entry.catalog === undefined ? 6 : 7);
  next = historyRawAdd(next, 8 + 1);
  next = historyRawString(next, entry.name);
  next = historyRawString(next, entry.color);
  next = historyRawString(next, entry.symbol);
  next = historyRawObject(next, entry.material.amount === undefined ? 3 : 4);
  next = historyRawString(next, entry.material.kind);
  next = historyRawString(next, entry.material.label);
  next = historyRawString(next, entry.material.unit);
  if (entry.material.amount !== undefined) next = historyRawAdd(next, 8);
  if (entry.catalog !== undefined) {
    next = historyRawObject(next, 6);
    next = historyRawString(next, entry.catalog.catalogId);
    next = historyRawString(next, entry.catalog.sourceId);
    next = historyRawString(next, entry.catalog.code);
    next = historyRawString(next, entry.catalog.name);
    next = historyRawString(next, entry.catalog.hex);
    next = historyRawArray(next, 3);
    next = historyRawAdd(next, 3 * 8);
  }
  return next;
}

function historyRawPalette(total: number, palette: readonly PaletteEntry[]): number {
  let next = historyRawArray(total, palette.length);
  for (const entry of palette) next = historyRawPaletteEntry(next, entry);
  return next;
}

function historyRawStore(total: number, store: BackstitchStore): number {
  let next = historyRawObject(total, 7);
  next = historyRawTyped(next, store.ids);
  next = historyRawTyped(next, store.x1);
  next = historyRawTyped(next, store.y1);
  next = historyRawTyped(next, store.x2);
  next = historyRawTyped(next, store.y2);
  next = historyRawTyped(next, store.colors);
  return historyRawTyped(next, store.completed);
}

function historyRawSettings(total: number, settings: Record<string, unknown>): number {
  let next = historyRawObject(total, Object.keys(settings).length);
  next = historyRawString(next, settings.symbolSet as string);
  next = historyRawString(next, settings.materialUnit as string);
  if (Object.prototype.hasOwnProperty.call(settings, 'backgroundColor')) next = historyRawString(next, settings.backgroundColor as string);
  if (Object.prototype.hasOwnProperty.call(settings, 'aidaCount')) next = historyRawAdd(next, 8);
  return next;
}

function historyRawDocument(total: number, document: PatternDocument): number {
  let next = historyRawObject(total, 13);
  next = historyRawAdd(next, 8 * 8);
  next = historyRawObject(next, 3);
  next = historyRawString(next, document.catalog.catalogId);
  next = historyRawString(next, document.catalog.brandLabel);
  next = historyRawAdd(next, 8);
  next = historyRawTyped(next, document.kind);
  next = historyRawTyped(next, document.colors);
  next = historyRawTyped(next, document.completed);
  next = historyRawStore(next, document.backstitches);
  next = historyRawPalette(next, document.palette);
  return historyRawSettings(next, document.settings as unknown as Record<string, unknown>);
}

function historyRawProgress(total: number, progress: HistoryProgressDto): number {
  let next = historyRawObject(total, 4);
  next = historyRawTyped(next, progress.cellIndices);
  next = historyRawTyped(next, progress.backstitchIds);
  return historyRawAdd(next, 16);
}

function historyRawDelta(total: number, delta: HistoryDeltaDto): number {
  let next = historyRawObject(total, 12);
  const cells = delta.cells;
  next = historyRawObject(next, 7);
  next = historyRawTyped(next, cells.indices);
  next = historyRawTyped(next, cells.beforeKind);
  next = historyRawTyped(next, cells.beforeColors);
  next = historyRawTyped(next, cells.beforeCompleted);
  next = historyRawTyped(next, cells.afterKind);
  next = historyRawTyped(next, cells.afterColors);
  next = historyRawTyped(next, cells.afterCompleted);
  if (delta.cellCompletions !== undefined) {
    next = historyRawObject(next, 3);
    next = historyRawTyped(next, delta.cellCompletions.indices);
    next = historyRawTyped(next, delta.cellCompletions.beforeCompleted);
    next = historyRawTyped(next, delta.cellCompletions.afterCompleted);
  }
  if (delta.backstitchCompletions !== undefined) {
    next = historyRawObject(next, 3);
    next = historyRawTyped(next, delta.backstitchCompletions.ids);
    next = historyRawTyped(next, delta.backstitchCompletions.beforeCompleted);
    next = historyRawTyped(next, delta.backstitchCompletions.afterCompleted);
  }
  if (delta.beforePalette !== undefined) next = historyRawPalette(next, delta.beforePalette);
  if (delta.afterPalette !== undefined) next = historyRawPalette(next, delta.afterPalette);
  if (delta.beforeBackstitches !== undefined) next = historyRawStore(next, delta.beforeBackstitches);
  if (delta.afterBackstitches !== undefined) next = historyRawStore(next, delta.afterBackstitches);
  if (delta.beforeSettings !== undefined) next = historyRawSettings(next, delta.beforeSettings as unknown as Record<string, unknown>);
  if (delta.afterSettings !== undefined) next = historyRawSettings(next, delta.afterSettings as unknown as Record<string, unknown>);
  return historyRawAdd(next, 4 * 8);
}

function historyRawEntry(total: number, entry: SurfaceHistoryEntryDto): number {
  let next = historyRawObject(total, 5);
  next = historyRawString(next, entry.kind);
  next = historyRawAdd(next, 9);
  next = historyRawProgress(next, entry.progress);
  if (entry.kind === 'delta') return historyRawDelta(next, entry.delta);
  next = historyRawDocument(next, entry.before);
  return historyRawDocument(next, entry.after);
}

function historyRawState(state: SurfaceEditorHistoryDto): number {
  let total = historyRawObject(0, 3);
  total = historyRawAdd(total, 8);
  total = historyRawArray(total, state.undo.length);
  for (const entry of state.undo) total = historyRawEntry(total, entry);
  total = historyRawArray(total, state.redo.length);
  for (const entry of state.redo) total = historyRawEntry(total, entry);
  return total;
}

function historyStoreEqual(left: BackstitchStore, right: BackstitchStore): boolean {
  return historyTypedArraysEqual(left.ids, right.ids)
    && historyTypedArraysEqual(left.x1, right.x1)
    && historyTypedArraysEqual(left.y1, right.y1)
    && historyTypedArraysEqual(left.x2, right.x2)
    && historyTypedArraysEqual(left.y2, right.y2)
    && historyTypedArraysEqual(left.colors, right.colors)
    && historyTypedArraysEqual(left.completed, right.completed);
}

function historyDocumentCompatible(actual: PatternDocument, expected: PatternDocument): boolean {
  return actual.version === expected.version
    && JSON.stringify(actual.catalog) === JSON.stringify(expected.catalog)
    && actual.width === expected.width
    && actual.height === expected.height
    && historyTypedArraysEqual(actual.kind, expected.kind)
    && historyTypedArraysEqual(actual.colors, expected.colors)
    && historyTypedArraysEqual(actual.completed, expected.completed)
    && JSON.stringify(actual.palette) === JSON.stringify(expected.palette)
    && JSON.stringify(actual.settings) === JSON.stringify(expected.settings)
    && historyStoreEqual(actual.backstitches, expected.backstitches)
    && actual.nextBackstitchId >= expected.nextBackstitchId
    && actual.nextPaletteId >= expected.nextPaletteId;
}

function historyStateMismatch(label: string): never {
  throw new DomainError('invalid-history-state', `${label} is incompatible with the supplied current document.`);
}

function historyDeltaSideMatches(document: PatternDocument, delta: SparseMutationDelta, useAfter: boolean, label: string): void {
  const cells = delta.cells;
  const kinds = useAfter ? cells.afterKind : cells.beforeKind;
  const colors = useAfter ? cells.afterColors : cells.beforeColors;
  const completed = useAfter ? cells.afterCompleted : cells.beforeCompleted;
  for (let position = 0; position < cells.indices.length; position += 1) {
    const index = cells.indices[position];
    if (index >= document.kind.length) historyStateMismatch(`${label}.cells.indices[${String(position)}]`);
    if (document.kind[index] !== kinds[position] || document.completed[index] !== completed[position]) historyStateMismatch(`${label}.cells[${String(position)}]`);
    const documentOffset = index * 4;
    const packedOffset = position * 4;
    for (let slot = 0; slot < 4; slot += 1) if (document.colors[documentOffset + slot] !== colors[packedOffset + slot]) historyStateMismatch(`${label}.cells[${String(position)}]`);
  }
  const cellCompletions = delta.cellCompletions;
  if (cellCompletions !== undefined) {
    const values = useAfter ? cellCompletions.afterCompleted : cellCompletions.beforeCompleted;
    for (let position = 0; position < cellCompletions.indices.length; position += 1) {
      const index = cellCompletions.indices[position];
      if (index >= document.completed.length || document.completed[index] !== values[position]) historyStateMismatch(`${label}.cellCompletions[${String(position)}]`);
    }
  }
  const palette = useAfter ? delta.afterPalette : delta.beforePalette;
  if (palette !== undefined && JSON.stringify(document.palette) !== JSON.stringify(palette)) historyStateMismatch(`${label}.palette`);
  const backstitches = useAfter ? delta.afterBackstitches : delta.beforeBackstitches;
  if (backstitches !== undefined && !historyStoreEqual(document.backstitches, backstitches)) historyStateMismatch(`${label}.backstitches`);
  const completion = delta.backstitchCompletions;
  if (completion !== undefined) {
    const values = useAfter ? completion.afterCompleted : completion.beforeCompleted;
    for (let position = 0; position < completion.ids.length; position += 1) {
      const storePosition = document.backstitches.ids.findIndex((id) => id === completion.ids[position]);
      if (storePosition < 0 || document.backstitches.completed[storePosition] !== values[position]) historyStateMismatch(`${label}.backstitchCompletions[${String(position)}]`);
    }
  }
  const nextBackstitchId = useAfter ? delta.afterNextBackstitchId : delta.beforeNextBackstitchId;
  const nextPaletteId = useAfter ? delta.afterNextPaletteId : delta.beforeNextPaletteId;
  const settings = useAfter ? delta.afterSettings : delta.beforeSettings;
  if (nextBackstitchId !== undefined && document.nextBackstitchId < nextBackstitchId) historyStateMismatch(`${label}.nextBackstitchId`);
  if (nextPaletteId !== undefined && document.nextPaletteId < nextPaletteId) historyStateMismatch(`${label}.nextPaletteId`);
  if (settings !== undefined && !settingsEqual(document.settings, settings)) historyStateMismatch(`${label}.settings`);
}

function applyHistoryEntryForValidation(document: PatternDocument, entry: HistoryEntry, useAfter: boolean): PatternDocument {
  const next = entry.kind === 'snapshot'
    ? cloneDocument(useAfter ? entry.after : entry.before)
    : applyDelta(document, entry.delta, useAfter);
  next.revision = document.revision;
  next.nextBackstitchId = Math.max(next.nextBackstitchId, document.nextBackstitchId);
  next.nextPaletteId = Math.max(next.nextPaletteId, document.nextPaletteId);
  assertValidDocument(next);
  return next;
}

function historyProgressForTransition(before: PatternDocument, after: PatternDocument, entry: HistoryEntry): ProgressChangeSet {
  if (entry.kind === 'snapshot') return emptyProgress();
  return deriveExplicitCompletionProgress(
    before,
    after,
    entry.delta.cellCompletions?.indices,
    entry.delta.backstitchCompletions?.ids
  );
}

function historyEntrySideMatches(document: PatternDocument, entry: HistoryEntry, useAfter: boolean, label: string): void {
  if (entry.kind === 'snapshot') {
    if (!historyDocumentCompatible(document, useAfter ? entry.after : entry.before)) historyStateMismatch(label);
    return;
  }
  historyDeltaSideMatches(document, entry.delta, useAfter, label);
}

function validateHistoryChains(document: PatternDocument, undo: readonly HistoryEntry[], redo: readonly HistoryEntry[]): void {
  let state = cloneDocument(document);
  for (let index = undo.length - 1; index >= 0; index -= 1) {
    const entry = undo[index];
    historyEntrySideMatches(state, entry, true, `undo[${String(index)}]`);
    const after = state;
    const before = applyHistoryEntryForValidation(state, entry, false);
    const canonicalProgress = historyProgressForTransition(before, after, entry);
    if (!historyProgressEqual(entry.progress, canonicalProgress)) historyStateMismatch(`undo[${String(index)}].progress`);
    entry.progress = canonicalProgress;
    state = before;
  }
  state = cloneDocument(document);
  for (let index = redo.length - 1; index >= 0; index -= 1) {
    const entry = redo[index];
    historyEntrySideMatches(state, entry, false, `redo[${String(index)}]`);
    const before = state;
    const after = applyHistoryEntryForValidation(state, entry, true);
    const canonicalProgress = historyProgressForTransition(before, after, entry);
    if (!historyProgressEqual(entry.progress, canonicalProgress)) historyStateMismatch(`redo[${String(index)}].progress`);
    entry.progress = canonicalProgress;
    state = after;
  }
}

function cloneHistoryStore(store: BackstitchStore): BackstitchStore {
  return {
    ids: store.ids.slice(),
    x1: store.x1.slice(),
    y1: store.y1.slice(),
    x2: store.x2.slice(),
    y2: store.y2.slice(),
    colors: store.colors.slice(),
    completed: store.completed.slice()
  };
}

function cloneHistoryProgress(progress: HistoryProgressDto): ProgressChangeSet {
  return {
    cellIndices: progress.cellIndices.slice(),
    backstitchIds: progress.backstitchIds.slice(),
    marked: progress.marked,
    unmarked: progress.unmarked
  };
}

function historyProgressEqual(left: ProgressChangeSet, right: ProgressChangeSet): boolean {
  return historyTypedArraysEqual(left.cellIndices, right.cellIndices)
    && historyTypedArraysEqual(left.backstitchIds, right.backstitchIds)
    && left.marked === right.marked
    && left.unmarked === right.unmarked;
}

function historyDeltaToInternal(delta: HistoryDeltaDto): SparseMutationDelta {
  return {
    cells: {
      indices: delta.cells.indices.slice(),
      beforeKind: delta.cells.beforeKind.slice(),
      beforeColors: delta.cells.beforeColors.slice(),
      beforeCompleted: delta.cells.beforeCompleted.slice(),
      afterKind: delta.cells.afterKind.slice(),
      afterColors: delta.cells.afterColors.slice(),
      afterCompleted: delta.cells.afterCompleted.slice()
    },
    ...(delta.cellCompletions === undefined ? {} : {
      cellCompletions: {
        indices: delta.cellCompletions.indices.slice(),
        beforeCompleted: delta.cellCompletions.beforeCompleted.slice(),
        afterCompleted: delta.cellCompletions.afterCompleted.slice()
      }
    }),
    ...(delta.backstitchCompletions === undefined ? {} : {
      backstitchCompletions: {
        ids: delta.backstitchCompletions.ids.slice(),
        beforeCompleted: delta.backstitchCompletions.beforeCompleted.slice(),
        afterCompleted: delta.backstitchCompletions.afterCompleted.slice()
      }
    }),
    ...(delta.beforePalette === undefined ? {} : { beforePalette: delta.beforePalette.map(clonePaletteEntry) }),
    ...(delta.afterPalette === undefined ? {} : { afterPalette: delta.afterPalette.map(clonePaletteEntry) }),
    ...(delta.beforeBackstitches === undefined ? {} : { beforeBackstitches: cloneHistoryStore(delta.beforeBackstitches) }),
    ...(delta.afterBackstitches === undefined ? {} : { afterBackstitches: cloneHistoryStore(delta.afterBackstitches) }),
    ...(delta.beforeNextBackstitchId === undefined ? {} : { beforeNextBackstitchId: delta.beforeNextBackstitchId }),
    ...(delta.afterNextBackstitchId === undefined ? {} : { afterNextBackstitchId: delta.afterNextBackstitchId }),
    ...(delta.beforeNextPaletteId === undefined ? {} : { beforeNextPaletteId: delta.beforeNextPaletteId }),
    ...(delta.afterNextPaletteId === undefined ? {} : { afterNextPaletteId: delta.afterNextPaletteId }),
    ...(delta.beforeSettings === undefined ? {} : { beforeSettings: clonePatternSettings(delta.beforeSettings) }),
    ...(delta.afterSettings === undefined ? {} : { afterSettings: clonePatternSettings(delta.afterSettings) })
  };
}

function historyEntryToInternal(entry: SurfaceHistoryEntryDto): HistoryEntry {
  if (entry.kind === 'snapshot') {
    const allowLegacySettings = isLegacySnapshotEntry(entry);
    return {
      kind: 'snapshot',
      before: cloneHistoryDocument(entry.before, allowLegacySettings),
      after: cloneHistoryDocument(entry.after, allowLegacySettings),
      bytes: entry.bytes,
      progress: cloneHistoryProgress(entry.progress),
      recalculateMetrics: true
    };
  }
  return {
    kind: 'delta',
    delta: historyDeltaToInternal(entry.delta),
    bytes: entry.bytes,
    progress: cloneHistoryProgress(entry.progress),
    recalculateMetrics: true
  };
}

function historyDtoProgress(progress: ProgressChangeSet): HistoryProgressDto {
  return {
    cellIndices: progress.cellIndices.slice(),
    backstitchIds: progress.backstitchIds.slice(),
    marked: progress.marked,
    unmarked: progress.unmarked
  };
}

function historyEntryProgressForDto(entry: HistoryEntry): HistoryProgressDto {
  const explicitCompletion = entry.kind === 'delta'
    && (entry.delta.cellCompletions !== undefined || entry.delta.backstitchCompletions !== undefined);
  return historyDtoProgress(explicitCompletion ? entry.progress : emptyProgress());
}

function historyDeltaToDto(delta: SparseMutationDelta): HistoryDeltaDto {
  return {
    cells: {
      indices: delta.cells.indices.slice(),
      beforeKind: delta.cells.beforeKind.slice(),
      beforeColors: delta.cells.beforeColors.slice(),
      beforeCompleted: delta.cells.beforeCompleted.slice(),
      afterKind: delta.cells.afterKind.slice(),
      afterColors: delta.cells.afterColors.slice(),
      afterCompleted: delta.cells.afterCompleted.slice()
    },
    ...(delta.cellCompletions === undefined ? {} : {
      cellCompletions: {
        indices: delta.cellCompletions.indices.slice(),
        beforeCompleted: delta.cellCompletions.beforeCompleted.slice(),
        afterCompleted: delta.cellCompletions.afterCompleted.slice()
      }
    }),
    ...(delta.backstitchCompletions === undefined ? {} : {
      backstitchCompletions: {
        ids: delta.backstitchCompletions.ids.slice(),
        beforeCompleted: delta.backstitchCompletions.beforeCompleted.slice(),
        afterCompleted: delta.backstitchCompletions.afterCompleted.slice()
      }
    }),
    ...(delta.beforePalette === undefined ? {} : { beforePalette: delta.beforePalette.map(clonePaletteEntry) }),
    ...(delta.afterPalette === undefined ? {} : { afterPalette: delta.afterPalette.map(clonePaletteEntry) }),
    ...(delta.beforeBackstitches === undefined ? {} : { beforeBackstitches: cloneHistoryStore(delta.beforeBackstitches) }),
    ...(delta.afterBackstitches === undefined ? {} : { afterBackstitches: cloneHistoryStore(delta.afterBackstitches) }),
    ...(delta.beforeNextBackstitchId === undefined ? {} : { beforeNextBackstitchId: delta.beforeNextBackstitchId }),
    ...(delta.afterNextBackstitchId === undefined ? {} : { afterNextBackstitchId: delta.afterNextBackstitchId }),
    ...(delta.beforeNextPaletteId === undefined ? {} : { beforeNextPaletteId: delta.beforeNextPaletteId }),
    ...(delta.afterNextPaletteId === undefined ? {} : { afterNextPaletteId: delta.afterNextPaletteId }),
    ...(delta.beforeSettings === undefined ? {} : { beforeSettings: clonePatternSettings(delta.beforeSettings) }),
    ...(delta.afterSettings === undefined ? {} : { afterSettings: clonePatternSettings(delta.afterSettings) })
  };
}

function historyEntryToDto(entry: HistoryEntry): SurfaceHistoryEntryDto {
  return entry.kind === 'snapshot'
    ? {
        kind: 'snapshot',
        before: cloneDocument(entry.before),
        after: cloneDocument(entry.after),
        bytes: entry.bytes,
        progress: historyEntryProgressForDto(entry),
        recalculateMetrics: entry.recalculateMetrics
      }
    : {
        kind: 'delta',
        delta: historyDeltaToDto(entry.delta),
        bytes: entry.bytes,
        progress: historyEntryProgressForDto(entry),
        recalculateMetrics: entry.recalculateMetrics
      };
}

function historyDeltaChanged(delta: HistoryDeltaDto): boolean {
  const cells = delta.cells;
  const changedCells = cells.indices.some((_, index) => cells.beforeKind[index] !== cells.afterKind[index]
    || cells.beforeCompleted[index] !== cells.afterCompleted[index]
    || cells.beforeColors[index * 4] !== cells.afterColors[index * 4]
    || cells.beforeColors[index * 4 + 1] !== cells.afterColors[index * 4 + 1]
    || cells.beforeColors[index * 4 + 2] !== cells.afterColors[index * 4 + 2]
    || cells.beforeColors[index * 4 + 3] !== cells.afterColors[index * 4 + 3]);
  const changedCompletions = delta.cellCompletions?.indices.some((_, index) => delta.cellCompletions!.beforeCompleted[index] !== delta.cellCompletions!.afterCompleted[index]) ?? false;
  const changedBackstitchCompletions = delta.backstitchCompletions?.ids.some((_, index) => delta.backstitchCompletions!.beforeCompleted[index] !== delta.backstitchCompletions!.afterCompleted[index]) ?? false;
  const changedPalette = delta.beforePalette !== undefined && !historyPaletteEqual(delta.beforePalette, delta.afterPalette ?? []);
  const changedBackstitches = delta.beforeBackstitches !== undefined && !historyStoreEqual(delta.beforeBackstitches, delta.afterBackstitches as BackstitchStore);
  const changedAllocators = delta.beforeNextBackstitchId !== delta.afterNextBackstitchId || delta.beforeNextPaletteId !== delta.afterNextPaletteId;
  const changedSettings = delta.beforeSettings !== undefined
    && (delta.afterSettings === undefined || !settingsEqual(delta.beforeSettings, delta.afterSettings));
  return changedCells || changedCompletions || changedBackstitchCompletions || changedPalette || changedBackstitches || changedAllocators || changedSettings;
}

function validateHistoryEntryContent(entry: SurfaceHistoryEntryDto, label: string): void {
  if (entry.kind === 'snapshot') {
    const allowLegacySettings = isLegacySnapshotEntry(entry);
    try {
      const before = documentWithUpgradedHistorySettings(entry.before, allowLegacySettings);
      const after = documentWithUpgradedHistorySettings(entry.after, allowLegacySettings);
      assertValidDocument(before);
      assertValidDocument(after);
      if (documentsContentEqual(before, after)) throw new DomainError('invalid-history-state', `${label} snapshot does not change document content.`);
    } catch (error) {
      if (error instanceof DomainError) throw new DomainError('invalid-history-state', `${label} document is invalid: ${error.message}`);
      throw error;
    }
  } else if (!historyDeltaChanged(entry.delta)) {
    throw new DomainError('invalid-history-state', `${label} contains no mutation.`);
  }
}

function historyPayloadBytes(entry: HistoryEntry): number {
  let bytes = entry.kind === 'snapshot'
    ? snapshotBytes(entry.before) + snapshotBytes(entry.after)
    : typedDeltaBytes(entry.delta);
  bytes += entry.progress.cellIndices.byteLength + entry.progress.backstitchIds.byteLength;
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new DomainError('invalid-history-state', 'History payload byte accounting overflowed.');
  return bytes;
}

function historyCanonicalBytes(entry: HistoryEntry): number {
  return entry.kind === 'snapshot' ? snapshotBytes(entry.before) + snapshotBytes(entry.after) : typedDeltaBytes(entry.delta);
}

function historySumBytes(left: number, right: number, label: string): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) throw new DomainError('invalid-history-state', `${label} byte accounting overflowed.`);
  return total;
}

interface HydratedHistory {
  undo: HistoryEntry[];
  redo: HistoryEntry[];
  undoBytes: number;
  redoBytes: number;
}

function hydrateHistoryState(value: unknown, current: PatternDocument, configuredLimit: number): HydratedHistory {
  historyState(value);
  const state = value as unknown as SurfaceEditorHistoryDto;
  historyRawState(state);
  const validateStack = (entries: readonly SurfaceHistoryEntryDto[], label: string): void => {
    for (let index = 0; index < entries.length; index += 1) {
      const entryLabel = `${label}[${String(index)}]`;
      historyEntry(entries[index], MAX_PERSISTABLE_CELL_COUNT, entryLabel);
      const entry = entries[index];
      if (isLegacySnapshotEntry(entry)) {
        const legacyBytes = legacySnapshotBytes(entry.before) + legacySnapshotBytes(entry.after);
        if (entry.bytes !== legacyBytes) throw new DomainError('invalid-history-state', `${entryLabel} legacy snapshot byte accounting is not canonical.`);
      }
      validateHistoryEntryContent(entries[index], entryLabel);
    }
  };
  validateStack(state.undo, 'history.undo');
  validateStack(state.redo, 'history.redo');
  const undo = state.undo.map(historyEntryToInternal);
  const redo = state.redo.map(historyEntryToInternal);
  const legacyUndo = state.undo.map(isLegacySnapshotEntry);
  const legacyRedo = state.redo.map(isLegacySnapshotEntry);
  for (let index = 0; index < undo.length; index += 1) {
    const canonical = historyCanonicalBytes(undo[index]);
    if (state.undo[index].bytes !== canonical && !legacyUndo[index]) throw new DomainError('invalid-history-state', 'Undo entry byte accounting is not canonical.');
    undo[index].bytes = canonical;
  }
  for (let index = 0; index < redo.length; index += 1) {
    const canonical = historyCanonicalBytes(redo[index]);
    if (state.redo[index].bytes !== canonical && !legacyRedo[index]) throw new DomainError('invalid-history-state', 'Redo entry byte accounting is not canonical.');
    redo[index].bytes = canonical;
  }
  const undoBytes = undo.reduce((total, entry) => historySumBytes(total, entry.bytes, 'undo'), 0);
  const redoBytes = redo.reduce((total, entry) => historySumBytes(total, entry.bytes, 'redo'), 0);
  const totalHistoryBytes = historySumBytes(undoBytes, redoBytes, 'history');
  if (totalHistoryBytes > configuredLimit) throw new DomainError('invalid-history-state', 'History entries exceed the configured history limit.');
  let payloadBytes = 0;
  for (const entry of undo) payloadBytes = historySumBytes(payloadBytes, historyPayloadBytes(entry), 'undo payload');
  for (const entry of redo) payloadBytes = historySumBytes(payloadBytes, historyPayloadBytes(entry), 'redo payload');
  if (payloadBytes > MAX_HISTORY_DECODE_BYTES) throw new DomainError('history-too-large', `History payload exceeds the ${String(MAX_HISTORY_DECODE_BYTES)} byte decode ceiling.`);
  assertValidDocument(current);
  validateHistoryChains(current, undo, redo);
  return { undo, redo, undoBytes, redoBytes };
}

function trimHistoryForExport<T extends { bytes: number }>(undo: readonly T[], redo: readonly T[], maxBytes: number | undefined): { undo: T[]; redo: T[] } {
  const retainedUndo = [...undo];
  const retainedRedo = [...redo];
  if (maxBytes === undefined) return { undo: retainedUndo, redo: retainedRedo };
  historySafeInteger(maxBytes, 'history export maxBytes');
  let total = retainedUndo.reduce((sum, entry) => historySumBytes(sum, entry.bytes, 'history export'), 0);
  total = historySumBytes(total, retainedRedo.reduce((sum, entry) => historySumBytes(sum, entry.bytes, 'history export'), 0), 'history export');
  // Undo storage is oldest-first, so drop its prefix first. Redo storage is
  // newest-first; dropping its prefix retains the next-to-apply suffix and
  // therefore keeps the restored redo chain compatible with the current doc.
  while (total > maxBytes && retainedUndo.length > 0) {
    const removed = retainedUndo.shift();
    if (removed) total -= removed.bytes;
  }
  while (total > maxBytes && retainedRedo.length > 0) {
    const removed = retainedRedo.shift();
    if (removed) total -= removed.bytes;
  }
  return { undo: retainedUndo, redo: retainedRedo };
}

function reverseProgress(progress: ProgressChangeSet): ProgressChangeSet {
  return { cellIndices: progress.cellIndices.slice(), backstitchIds: progress.backstitchIds.slice(), marked: progress.unmarked, unmarked: progress.marked };
}

function ensureHistoryEntryFits(bytes: number, limit: number): void {
  if (bytes > limit) {
    throw new DomainError('history-entry-too-large', `History entry requires ${String(bytes)} bytes, exceeding the configured ${String(limit)} byte limit.`);
  }
}

/** The result of running one command against a single surface, before any history stack is touched. */
interface SurfaceRun {
  readonly result: CommandResult;
  /** The changed surface and its history entry; both are absent for a no-op. */
  readonly next?: PatternDocument;
  readonly entry?: HistoryEntry;
}

/**
 * Applies one surface history entry. `useAfter` is redo; otherwise undo.
 * Revision advances and allocators stay monotonic in both directions.
 */
function stepSurfaceEntry(current: PatternDocument, entry: HistoryEntry, useAfter: boolean): { next: PatternDocument; result: CommandResult } {
  const next = entry.kind === 'snapshot' ? cloneDocument(useAfter ? entry.after : entry.before) : applyDelta(current, entry.delta, useAfter);
  next.revision = current.revision + 1;
  // Allocators are monotonic even when content is undone. This prevents an
  // ID from being reused after an add/remove/undo sequence.
  next.nextBackstitchId = Math.max(next.nextBackstitchId, current.nextBackstitchId);
  next.nextPaletteId = Math.max(next.nextPaletteId, current.nextPaletteId);
  if (entry.kind === 'snapshot') assertValidDocument(next);
  const commandResult = result(next, true, undefined, undefined, {
    changed: true,
    snapshot: entry.kind === 'snapshot',
    ...(entry.kind === 'delta' ? { changedIndices: entry.delta.cells.indices.slice() } : {}),
    progress: useAfter ? cloneProgress(entry.progress) : reverseProgress(entry.progress),
    recalculateMetrics: entry.recalculateMetrics
  });
  if (entry.kind === 'delta') {
    if (deltaRequiresFullRedraw(entry.delta)) commandResult.requiresFullRedraw = true;
    attachDeleteMetricsImpactForDelta(commandResult, entry.delta, useAfter ? 'after' : 'before');
  } else if (snapshotSettingsChanged(entry)) commandResult.requiresFullRedraw = true;
  return { next, result: commandResult };
}

function runSurfaceCommand(current: PatternDocument, command: DomainCommand, limit: number): SurfaceRun {
  if (isBulkCellCommand(command)) return runBulkCellCommand(current, command, limit);
  if (isBulkRecolorCommand(command)) return runBulkRecolorCommand(current, command, limit);
  if (isBulkCompletionCommand(command)) return runBulkCompletionCommand(current, command, limit);
  if (isBulkBackstitchCompletionCommand(command)) return runBulkBackstitchCompletionCommand(current, command, limit);
  if (isPasteFragmentCommand(command)) return runPasteFragmentCommand(current, command, limit);
  if (isMoveFragmentCommand(command)) return runMoveFragmentCommand(current, command, limit);
  if (isMixedEraseCommand(command)) return runMixedEraseCommand(current, command, limit);
  if (isDeleteRegionCommand(command)) return runDeleteRegionCommand(current, command, limit);
  if (isDeleteCellSetCommand(command)) return runDeleteCellSetCommand(current, command, limit);
  if (isBatchCommand(command) && Array.isArray(command.commands)) {
    assertBulkBatchPolicy(command.commands as DomainCommand[]);
    if (command.commands.length === 1 && isBulkCellCommand(command.commands[0] as DomainCommand)) {
      return runBulkCellCommand(current, command.commands[0] as DomainCommand, limit);
    }
    if (command.commands.length === 1 && isBulkRecolorCommand(command.commands[0] as DomainCommand)) {
      return runBulkRecolorCommand(current, command.commands[0] as DomainCommand, limit);
    }
    if (command.commands.length === 1 && isBulkCompletionCommand(command.commands[0] as DomainCommand)) {
      return runBulkCompletionCommand(current, command.commands[0] as DomainCommand, limit);
    }
    if (command.commands.length === 1 && isBulkBackstitchCompletionCommand(command.commands[0] as DomainCommand)) {
      return runBulkBackstitchCompletionCommand(current, command.commands[0] as DomainCommand, limit);
    }
    if (command.commands.length === 1 && isPasteFragmentCommand(command.commands[0] as DomainCommand)) {
      return runPasteFragmentCommand(current, command.commands[0] as DomainCommand, limit);
    }
    if (command.commands.length === 1 && isMoveFragmentCommand(command.commands[0] as DomainCommand)) {
      return runMoveFragmentCommand(current, command.commands[0] as DomainCommand, limit);
    }
    if (command.commands.length === 1 && isMixedEraseCommand(command.commands[0] as DomainCommand)) {
      return runMixedEraseCommand(current, command.commands[0] as DomainCommand, limit);
    }
    if (command.commands.length === 1 && isDeleteRegionCommand(command.commands[0] as DomainCommand)) {
      return runDeleteRegionCommand(current, command.commands[0] as DomainCommand, limit);
    }
    if (command.commands.length === 1 && isDeleteCellSetCommand(command.commands[0] as DomainCommand)) {
      return runDeleteCellSetCommand(current, command.commands[0] as DomainCommand, limit);
    }
  }
  if (isPaletteMetadataOnlyCommand(command)) return runPaletteMetadataCommand(current, command, limit);
  if (commandRequiresSnapshot(command)) return runSnapshotCommand(current, command, limit);

  const draft = cloneDocument(current);
  // Settings are immutable across current command paths. Reuse the object so
  // sparse edits and their undo/redo transitions preserve settings identity.
  draft.settings = current.settings;
  const tracker = new MutationTracker();
  let mutation: MutationInfo;
  try {
    mutation = applyOneToDraft(draft, command, tracker);
  } catch (error) {
    tracker.rollback(draft);
    throw error;
  }
  if (!mutation.changed || !tracker.hasChanges(draft)) {
    tracker.rollback(draft);
    return { result: result(current, false, mutation.backstitchId, mutation.paletteId, mutation) };
  }
  draft.revision = current.revision + 1;
  assertValidDocument(draft);
  const delta = tracker.toDelta(draft);
  const entry: DeltaEntry = { kind: 'delta', delta, bytes: typedDeltaBytes(delta), progress: cloneProgress(mutation.progress), recalculateMetrics: mutation.recalculateMetrics === true };
  ensureHistoryEntryFits(entry.bytes, limit);
  const commandResult = result(draft, true, mutation.backstitchId, mutation.paletteId, mutation);
  if (delta.beforeSettings !== undefined) commandResult.requiresFullRedraw = true;
  return { result: commandResult, next: draft, entry };
}

function runPaletteMetadataCommand(current: PatternDocument, command: DomainCommand, limit: number): SurfaceRun {
  // Palette metadata commands are preflighted by applyOneToDraft and do not
  // touch dimensions, dense cell planes, or backstitches. Keep those
  // structures shared so this path remains bounded by palette metadata.
  const draft: PatternDocument = { ...current, palette: current.palette.slice() };
  const tracker = new MutationTracker();
  let mutation: MutationInfo;
  try {
    mutation = applyOneToDraft(draft, command, tracker);
  } catch (error) {
    tracker.rollback(draft);
    throw error;
  }
  if (!mutation.changed || !tracker.hasChanges(draft)) {
    tracker.rollback(draft);
    return { result: result(current, false, mutation.backstitchId, mutation.paletteId, mutation) };
  }
  draft.revision = current.revision + 1;
  // The current document was validated when it entered history, and the
  // palette command preflight validates every changed metadata field and
  // reference rule. Since all content-bearing planes remain shared, a full
  // document validation here would only reread the unchanged dense planes.
  const delta = tracker.toDelta(draft);
  const entry: DeltaEntry = { kind: 'delta', delta, bytes: typedDeltaBytes(delta), progress: cloneProgress(mutation.progress), recalculateMetrics: mutation.recalculateMetrics === true };
  ensureHistoryEntryFits(entry.bytes, limit);
  return { result: result(draft, true, mutation.backstitchId, mutation.paletteId, mutation), next: draft, entry };
}

function runBulkCellCommand(current: PatternDocument, command: DomainCommand, limit: number): SurfaceRun {
  const preflight = preflightBulkCellCommand(current, command);
  const estimatedBytes = estimateBulkCellHistoryBytes(preflight.changedIndices.length);
  ensureHistoryEntryFits(estimatedBytes, limit);
  if (preflight.changedIndices.length === 0) {
    return { result: result(current, false, undefined, undefined, {
      changed: false,
      snapshot: false,
      touchedIndices: preflight.indices,
      changedIndices: preflight.changedIndices,
      progress: { cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0), marked: 0, unmarked: 0 }
    }) };
  }

  // Bulk edits bypass MutationTracker entirely. The draft is the only
  // document mutated, and the packed delta returned by the canonical bulk
  // command is passed directly to history without being rebuilt.
  const draft = cloneDocument(current);
  const mutation = applyBulkCellCommand(draft, command, preflight);
  draft.revision = current.revision + 1;
  assertValidDocument(draft);
  if (mutation.delta === undefined) throw new DomainError('invalid-bulk-edit', 'A changed bulk edit did not produce a history delta.');
  const entry: DeltaEntry = { kind: 'delta', delta: mutation.delta, bytes: typedDeltaBytes(mutation.delta), progress: cloneProgress(mutation.progress), recalculateMetrics: mutation.recalculateMetrics === true };
  ensureHistoryEntryFits(entry.bytes, limit);
  return { result: result(draft, true, undefined, undefined, mutation), next: draft, entry };
}

function runBulkRecolorCommand(current: PatternDocument, command: DomainCommand, limit: number): SurfaceRun {
  const preflight = preflightBulkRecolorCommand(current, command);
  const estimatedBytes = estimateBulkRecolorHistoryBytes(preflight.changedIndices.length);
  ensureHistoryEntryFits(estimatedBytes, limit);
  if (preflight.changedIndices.length === 0) {
    return { result: result(current, false, undefined, undefined, {
      changed: false,
      snapshot: false,
      touchedIndices: preflight.indices,
      changedIndices: preflight.changedIndices,
      progress: emptyProgress()
    }) };
  }
  const draft = cloneDocument(current);
  const mutation = applyBulkRecolorCommand(draft, command, preflight);
  draft.revision = current.revision + 1;
  assertValidDocument(draft);
  if (mutation.delta === undefined) throw new DomainError('invalid-bulk-recolor', 'A changed bulk recolor did not produce a history delta.');
  const entry: DeltaEntry = { kind: 'delta', delta: mutation.delta, bytes: typedDeltaBytes(mutation.delta), progress: cloneProgress(mutation.progress), recalculateMetrics: mutation.recalculateMetrics === true };
  ensureHistoryEntryFits(entry.bytes, limit);
  return { result: result(draft, true, undefined, undefined, mutation), next: draft, entry };
}

function runBulkCompletionCommand(current: PatternDocument, command: DomainCommand, limit: number): SurfaceRun {
  const preflight = preflightBulkCompletionCommand(current, command);
  const estimatedBytes = estimateBulkCompletionHistoryBytes(preflight.changedIndices.length);
  ensureHistoryEntryFits(estimatedBytes, limit);
  if (preflight.changedIndices.length === 0) {
    return { result: result(current, false, undefined, undefined, {
      changed: false,
      snapshot: false,
      touchedIndices: preflight.indices,
      changedIndices: preflight.changedIndices,
      progress: { cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0), marked: 0, unmarked: 0 }
    }) };
  }
  // Invariant: preflight validated every target, and completion apply mutates only this copied dense plane.
  const draft: PatternDocument = { ...current, completed: current.completed.slice() };
  const mutation = applyBulkCompletionCommand(draft, command, preflight);
  draft.revision = current.revision + 1;
  if (mutation.delta === undefined) throw new DomainError('invalid-completion-command', 'A changed bulk completion did not produce a history delta.');
  const entry: DeltaEntry = { kind: 'delta', delta: mutation.delta, bytes: typedDeltaBytes(mutation.delta), progress: cloneProgress(mutation.progress), recalculateMetrics: mutation.recalculateMetrics === true };
  ensureHistoryEntryFits(entry.bytes, limit);
  return { result: result(draft, true, undefined, undefined, mutation), next: draft, entry };
}

function runBulkBackstitchCompletionCommand(current: PatternDocument, command: DomainCommand, limit: number): SurfaceRun {
  const preflight = preflightBulkBackstitchCompletionCommand(current, command);
  const estimatedBytes = estimateBulkBackstitchCompletionHistoryBytes(preflight.changedIds.length);
  ensureHistoryEntryFits(estimatedBytes, limit);
  if (preflight.changedIds.length === 0) {
    return { result: result(current, false, undefined, undefined, {
      changed: false,
      snapshot: false,
      touchedBackstitchIds: preflight.ids,
      changedBackstitchIds: preflight.changedIds,
      progress: { cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0), marked: 0, unmarked: 0 }
    }) };
  }
  const draft = cloneDocument(current);
  const mutation = applyBulkBackstitchCompletionCommand(draft, command, preflight);
  draft.revision = current.revision + 1;
  assertValidDocument(draft);
  if (mutation.delta === undefined) throw new DomainError('invalid-completion-command', 'A changed bulk backstitch completion did not produce a history delta.');
  const entry: DeltaEntry = { kind: 'delta', delta: mutation.delta, bytes: typedDeltaBytes(mutation.delta), progress: cloneProgress(mutation.progress), recalculateMetrics: mutation.recalculateMetrics === true };
  ensureHistoryEntryFits(entry.bytes, limit);
  return { result: result(draft, true, undefined, undefined, mutation), next: draft, entry };
}

function runPasteFragmentCommand(current: PatternDocument, command: DomainCommand, limit: number): SurfaceRun {
  const preflight = preflightPasteFragmentCommand(current, command);
  const estimatedBytes = estimatePasteFragmentHistoryBytes(preflight.changedCellCount, current.backstitches.ids.length, preflight.newBackstitchCount);
  ensureHistoryEntryFits(estimatedBytes, limit);
  if (estimatedBytes === 0) return { result: result(current, false) };

  const draft = cloneDocument(current);
  const mutation = applyPasteFragmentCommand(draft, command, preflight);
  draft.revision = current.revision + 1;
  assertValidDocument(draft);
  if (mutation.delta === undefined) throw new DomainError('invalid-fragment', 'A changed paste did not produce a history delta.');
  const entry: DeltaEntry = { kind: 'delta', delta: mutation.delta, bytes: typedDeltaBytes(mutation.delta), progress: cloneProgress(mutation.progress), recalculateMetrics: mutation.recalculateMetrics === true };
  ensureHistoryEntryFits(entry.bytes, limit);
  return { result: result(draft, true, undefined, undefined, mutation), next: draft, entry };
}

function runMoveFragmentCommand(current: PatternDocument, command: DomainCommand, limit: number): SurfaceRun {
  const preflight = preflightMoveFragmentCommand(current, command, limit);
  const estimatedBytes = estimateMoveFragmentHistoryBytes(
    preflight.changedIndices.length,
    current.backstitches.ids.length,
    preflight.backstitchesChanged ? preflight.movedBackstitchIds.length : 0
  );
  ensureHistoryEntryFits(estimatedBytes, limit);
  if (estimatedBytes === 0) {
    return { result: result(current, false, undefined, undefined, {
      changed: false,
      snapshot: false,
      changedIndices: preflight.changedIndices,
      movedBackstitchIds: new Uint32Array(0),
      progress: cloneProgress(undefined)
    }) };
  }
  const draft = cloneDocument(current);
  const mutation = applyMoveFragmentCommand(draft, command, preflight);
  draft.revision = current.revision + 1;
  assertValidDocument(draft);
  if (mutation.delta === undefined) throw new DomainError('invalid-move-fragment', 'A changed move did not produce a history delta.');
  const entry: DeltaEntry = {
    kind: 'delta',
    delta: mutation.delta,
    bytes: typedDeltaBytes(mutation.delta),
    progress: cloneProgress(mutation.progress),
    recalculateMetrics: true
  };
  ensureHistoryEntryFits(entry.bytes, limit);
  return { result: result(draft, true, undefined, undefined, mutation), next: draft, entry };
}

function runMixedEraseCommand(current: PatternDocument, command: DomainCommand, limit: number): SurfaceRun {
  const preflight = preflightMixedEraseCommand(current, command);
  const estimatedBytes = estimateMixedEraseHistoryBytes(preflight.changedCellCount);
  ensureHistoryEntryFits(estimatedBytes, limit);
  if (estimatedBytes === 0) return { result: result(current, false) };

  const draft = cloneDocument(current);
  const mutation = applyMixedEraseCommand(draft, command, preflight);
  draft.revision = current.revision + 1;
  assertValidDocument(draft);
  if (mutation.delta === undefined) throw new DomainError('invalid-mixed-erase', 'A changed mixed erase did not produce a history delta.');
  const entry: DeltaEntry = { kind: 'delta', delta: mutation.delta, bytes: typedDeltaBytes(mutation.delta), progress: cloneProgress(mutation.progress), recalculateMetrics: mutation.recalculateMetrics === true };
  ensureHistoryEntryFits(entry.bytes, limit);
  return { result: result(draft, true, undefined, undefined, mutation), next: draft, entry };
}

function runDeleteRegionCommand(current: PatternDocument, command: DomainCommand, limit: number): SurfaceRun {
  const preflight = preflightDeleteRegionCommand(current, command);
  const estimatedBytes = estimateDeleteRegionHistoryBytes(
    preflight.changedIndices.length,
    current.backstitches.ids.length,
    preflight.changedBackstitchIds.length
  );
  ensureHistoryEntryFits(estimatedBytes, limit);
  if (estimatedBytes === 0) {
    return { result: result(current, false, undefined, undefined, {
      changed: false,
      snapshot: false,
      touchedIndices: preflight.touchedIndices,
      changedIndices: preflight.changedIndices,
      changedBackstitchIds: preflight.changedBackstitchIds,
      progress: emptyProgress()
    }) };
  }

  const draft = cloneForDelete(current);
  const mutation = applyDeleteRegionCommand(draft, command, preflight);
  draft.revision = current.revision + 1;
  if (mutation.delta === undefined) throw new DomainError('invalid-delete-region', 'A changed delete-region command did not produce a history delta.');
  const entry: DeltaEntry = {
    kind: 'delta',
    delta: mutation.delta,
    bytes: typedDeltaBytes(mutation.delta),
    progress: cloneProgress(mutation.progress),
    recalculateMetrics: mutation.recalculateMetrics === true
  };
  ensureHistoryEntryFits(entry.bytes, limit);
  const commandResult = result(draft, true, undefined, undefined, mutation);
  attachDeleteMetricsImpactForDelta(commandResult, mutation.delta, 'after');
  return { result: commandResult, next: draft, entry };
}

function runDeleteCellSetCommand(current: PatternDocument, command: DomainCommand, limit: number): SurfaceRun {
  const preflight = preflightDeleteCellSetCommand(current, command);
  const estimatedBytes = estimateDeleteCellSetHistoryBytes(
    preflight.changedIndices.length,
    current.backstitches.ids.length,
    preflight.changedBackstitchIds.length
  );
  ensureHistoryEntryFits(estimatedBytes, limit);
  if (estimatedBytes === 0) {
    return { result: result(current, false, undefined, undefined, {
      changed: false,
      snapshot: false,
      touchedIndices: preflight.touchedIndices,
      changedIndices: preflight.changedIndices,
      changedBackstitchIds: preflight.changedBackstitchIds,
      progress: emptyProgress()
    }) };
  }

  const draft = cloneForDelete(current);
  const mutation = applyDeleteCellSetCommand(draft, command, preflight);
  draft.revision = current.revision + 1;
  if (mutation.delta === undefined) throw new DomainError('invalid-delete-cell-set', 'A changed delete-cell-set command did not produce a history delta.');
  const entry: DeltaEntry = {
    kind: 'delta',
    delta: mutation.delta,
    bytes: typedDeltaBytes(mutation.delta),
    progress: cloneProgress(mutation.progress),
    recalculateMetrics: mutation.recalculateMetrics === true
  };
  ensureHistoryEntryFits(entry.bytes, limit);
  const commandResult = result(draft, true, undefined, undefined, mutation);
  attachDeleteMetricsImpactForDelta(commandResult, mutation.delta, 'after');
  return { result: commandResult, next: draft, entry };
}

function runSnapshotCommand(current: PatternDocument, command: DomainCommand, limit: number): SurfaceRun {
  const before = cloneDocument(current);
  const draft = cloneDocument(current);
  const mutation: MutationInfo = applyOneToDraft(draft, command);
  if (!mutation.changed) return { result: result(current, false) };
  const settingsChanged = !settingsEqual(before.settings, draft.settings);
  draft.revision = current.revision + 1;
  assertValidDocument(draft);
  const entry: SnapshotEntry = { kind: 'snapshot', before, after: cloneDocument(draft), bytes: snapshotBytes(draft) + snapshotBytes(before), progress: cloneProgress(mutation.progress), recalculateMetrics: mutation.recalculateMetrics === true };
  ensureHistoryEntryFits(entry.bytes, limit);
  const commandResult = result(draft, true, mutation.backstitchId, mutation.paletteId, mutation);
  if (settingsChanged) commandResult.requiresFullRedraw = true;
  return { result: commandResult, next: draft, entry };
}

/**
 * Undo/redo over a single `PatternDocument` surface. The layered
 * `DocumentEditor` uses the same command engine per layer; this class remains
 * for single-surface callers and tests.
 */
export class SurfaceEditor {
  private current: PatternDocument;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private readonly historyLimit: number;
  private undoBytes = 0;
  private redoBytes = 0;

  constructor(document: PatternDocument, options: HistoryOptions = {}) {
    assertValidDocument(document);
    const historyLimit = options.historyLimitBytes ?? options.maxHistoryBytes ?? DEFAULT_HISTORY_LIMIT_BYTES;
    if (!Number.isSafeInteger(historyLimit) || historyLimit < 1) throw new DomainError('invalid-history-limit', 'historyLimitBytes must be a positive integer.');
    this.historyLimit = historyLimit;
    this.current = cloneDocument(document);
  }

  get document(): PatternDocument {
    return this.current;
  }

  get state(): PatternDocument {
    return this.current;
  }

  get pattern(): PatternDocument {
    return this.current;
  }

  get revision(): number {
    return this.current.revision;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }

  get redoDepth(): number {
    return this.redoStack.length;
  }

  get historyLimitBytes(): number {
    return this.historyLimit;
  }

  get historyBytes(): number {
    return this.undoBytes + this.redoBytes;
  }

  get historyBytesUsed(): number {
    return this.historyBytes;
  }

  /**
   * Export detached history DTOs. When maxBytes is supplied, the accounting
   * cap is applied to retained entries: oldest undo entries are removed first;
   * if needed, the newest-first redo prefix is removed next so the remaining
   * redo suffix still starts at the supplied current document.
   */
  exportHistory(options: HistoryExportOptions = {}): SurfaceEditorHistoryDto {
    const selected = trimHistoryForExport(this.undoStack, this.redoStack, options.maxBytes);
    const undo = selected.undo.map(historyEntryToDto);
    const redo = selected.redo.map(historyEntryToDto);
    return {
      version: SURFACE_EDITOR_HISTORY_VERSION,
      undo,
      redo
    };
  }

  /** Restore only after the complete detached DTO has validated. */
  importHistory(state: unknown): void {
    const restored = hydrateHistoryState(state, this.current, this.historyLimit);
    this.undoStack = restored.undo;
    this.redoStack = restored.redo;
    this.undoBytes = restored.undoBytes;
    this.redoBytes = restored.redoBytes;
  }

  get lastHistoryEntryKind(): 'delta' | 'snapshot' | null {
    return this.undoStack.length === 0 ? null : this.undoStack[this.undoStack.length - 1].kind;
  }

  execute(command: DomainCommand): CommandResult {
    const run = runSurfaceCommand(this.current, command, this.historyLimit);
    if (run.next !== undefined && run.entry !== undefined) {
      this.current = run.next;
      this.pushHistory(run.entry);
    }
    return run.result;
  }

  private pushHistory(entry: HistoryEntry): void {
    ensureHistoryEntryFits(entry.bytes, this.historyLimit);
    this.redoStack = [];
    this.redoBytes = 0;
    if (entry.bytes > this.historyLimit) {
      // A single operation may exceed the normal budget, but is retained as
      // the sole undoable entry so history memory remains bounded by one
      // operation rather than growing without limit.
      this.undoStack = [entry];
      this.undoBytes = entry.bytes;
      return;
    }
    this.undoStack.push(entry);
    this.undoBytes += entry.bytes;
    while (this.undoBytes > this.historyLimit && this.undoStack.length > 0) {
      const oldest = this.undoStack.shift();
      if (oldest) this.undoBytes -= oldest.bytes;
    }
  }

  executeBatch(commands: readonly DomainCommand[]): CommandResult {
    return this.execute({ type: 'batch', commands: [...commands] });
  }

  executeCommand(command: DomainCommand): CommandResult {
    return this.execute(command);
  }

  setCell(command: DomainCommand): CommandResult {
    return this.execute(command);
  }

  setFull(x: number, y: number, color: number, completed?: boolean): CommandResult {
    return this.execute({ type: 'set-full', x, y, color, ...(completed === undefined ? {} : { completed }) });
  }

  setHalf(x: number, y: number, direction: HalfDirection, color: number, completed?: boolean): CommandResult {
    return this.execute({ type: 'set-half', x, y, direction, color, ...(completed === undefined ? {} : { completed }) });
  }

  setQuarter(x: number, y: number, corner: QuarterCorner, color: number, completed?: boolean): CommandResult {
    return this.execute({ type: 'set-quarter', x, y, corner, color, ...(completed === undefined ? {} : { completed }) });
  }

  setThreeQuarter(x: number, y: number, corner: QuarterCorner, color: number, completed?: boolean): CommandResult {
    return this.execute({ type: 'set-three-quarter', x, y, corner, color, ...(completed === undefined ? {} : { completed }) });
  }

  bulkCompletion(command: DomainCommand): CommandResult {
    return this.execute(command);
  }

  bulkBackstitchCompletion(command: DomainCommand): CommandResult {
    return this.execute(command);
  }

  eraseCell(x: number, y: number): CommandResult {
    return this.execute({ type: 'erase-cell', x, y });
  }

  deleteRegion(rect: CropRect): CommandResult {
    return this.execute({ type: 'delete-region', ...rect });
  }

  deleteCellSet(indices: Uint32Array, expectedRevision?: number): CommandResult {
    return this.execute({ type: 'delete-cell-set', indices, ...(expectedRevision === undefined ? {} : { expectedRevision }) });
  }

  addBackstitch(start: Point, end: Point, color: number, completed = false): CommandResult {
    return this.execute({ type: 'add-backstitch', start, end, color, completed });
  }

  moveBackstitch(id: number, start: Point, end: Point): CommandResult {
    return this.execute({ type: 'move-backstitch', id, start, end });
  }

  removeBackstitch(id: number): CommandResult {
    return this.execute({ type: 'remove-backstitch', id });
  }

  recolorBackstitch(id: number, color: number): CommandResult {
    return this.execute({ type: 'recolor-backstitch', id, color });
  }

  createPalette(input: { name: string; color: string; active?: boolean; id?: number }): CommandResult {
    return this.execute({ type: 'palette-create', ...input });
  }

  updatePalette(id: number, changes: Partial<{ name: string; color: string; active: boolean }>): CommandResult {
    return this.execute({ type: 'palette-update', id, ...changes });
  }

  deactivatePalette(id: number): CommandResult {
    return this.execute({ type: 'palette-deactivate', id });
  }

  rotate(direction: 'cw' | 'ccw' = 'cw', quarterTurns = 1): CommandResult {
    return this.execute({ type: direction === 'cw' ? 'rotate-cw' : 'rotate-ccw', quarterTurns });
  }

  mirror(axis: 'horizontal' | 'vertical' = 'horizontal'): CommandResult {
    return this.execute({ type: axis === 'horizontal' ? 'mirror-horizontal' : 'mirror-vertical' });
  }

  crop(rect: CropRect): CommandResult {
    return this.execute({ type: 'crop', ...rect });
  }

  batch(commands: readonly DomainCommand[]): CommandResult {
    return this.executeBatch(commands);
  }

  undo(): CommandResult {
    const entry = this.undoStack.pop();
    if (!entry) return result(this.current, false);
    this.undoBytes -= entry.bytes;
    const step = stepSurfaceEntry(this.current, entry, false);
    this.redoStack.push(entry);
    this.redoBytes += entry.bytes;
    this.current = step.next;
    return step.result;
  }

  redo(): CommandResult {
    const entry = this.redoStack.pop();
    if (!entry) return result(this.current, false);
    this.redoBytes -= entry.bytes;
    const step = stepSurfaceEntry(this.current, entry, true);
    this.undoStack.push(entry);
    this.undoBytes += entry.bytes;
    this.current = step.next;
    return step.result;
  }

  clearHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.undoBytes = 0;
    this.redoBytes = 0;
  }

  /** Discard redo entries without touching undo (a new action clears redo). */
  clearRedo(): void {
    this.redoStack = [];
    this.redoBytes = 0;
  }
}

// ---------------------------------------------------------------------------
// Layered history

/** Version of the layered `DocumentEditor` history DTO. Version 1 (single surface) is not accepted. */
export const DOCUMENT_EDITOR_HISTORY_VERSION = 2 as const;

/**
 * One layer on one side of a `layers` or `replay` entry. Content is omitted
 * when it equals the other side's (it is then taken from the current
 * document), and `empty: true` stands for all-zero planes or no backstitches.
 */
export interface HistoryLayerDto {
  readonly id: number;
  readonly type: LayerType;
  readonly name: string;
  readonly visible: boolean;
  readonly empty?: true;
  readonly kind?: Uint8Array;
  readonly colors?: Uint16Array;
  readonly backstitches?: BackstitchStore;
}

export interface HistoryLayeredSideDto {
  readonly width: number;
  readonly height: number;
  /** Bottom to top, as in `LayeredDocument.layers`. */
  readonly layers: readonly HistoryLayerDto[];
  /** Present on both sides only when the entry changes the palette. */
  readonly palette?: readonly PaletteEntry[];
  /** Present on both sides only when the entry changes the settings. */
  readonly settings?: PatternSettings;
  readonly nextBackstitchId: number;
  readonly nextPaletteId: number;
  readonly nextLayerId: number;
}

/** A sparse edit of one layer, or of document metadata (palette, settings) when `layerId` is null. */
export interface HistoryLayerDeltaEntryDto {
  readonly kind: 'delta';
  readonly layerId: number | null;
  readonly delta: HistoryDeltaDto;
  readonly bytes: number;
}

/** Layer structure changes and document-wide edits that are not stored more compactly. */
export interface HistoryLayersEntryDto {
  readonly kind: 'layers';
  readonly before: HistoryLayeredSideDto;
  readonly after: HistoryLayeredSideDto;
  readonly bytes: number;
}

/** A rotate or mirror; undo applies `inverse`, redo applies `forward`. */
export interface HistoryTransformEntryDto {
  readonly kind: 'transform';
  readonly forward: DomainCommand;
  readonly inverse: DomainCommand;
  readonly bytes: number;
}

/** A crop; undo restores `before`, redo applies `command` again. */
export interface HistoryReplayEntryDto {
  readonly kind: 'replay';
  readonly command: DomainCommand;
  readonly before: HistoryLayeredSideDto;
  readonly bytes: number;
}

/** Several entries recorded as one undo step, oldest first (for example add a layer, then paste into it). */
export interface HistoryGroupEntryDto {
  readonly kind: 'group';
  readonly entries: readonly Exclude<DocumentEditorHistoryEntryDto, HistoryGroupEntryDto>[];
  readonly bytes: number;
}

export type DocumentEditorHistoryEntryDto = HistoryLayerDeltaEntryDto | HistoryLayersEntryDto | HistoryTransformEntryDto | HistoryReplayEntryDto | HistoryGroupEntryDto;

export interface DocumentEditorHistoryDto {
  readonly version: typeof DOCUMENT_EDITOR_HISTORY_VERSION;
  readonly undo: readonly DocumentEditorHistoryEntryDto[];
  readonly redo: readonly DocumentEditorHistoryEntryDto[];
}

interface StitchContent {
  readonly kind: Uint8Array;
  readonly colors: Uint16Array;
}

interface SpecialtyContent {
  readonly backstitches: BackstitchStore;
}

/** `completed` planes are always zero, so they are never stored; `'empty'` is an all-zero layer. */
type LayerContent = StitchContent | SpecialtyContent | 'empty';

interface LayerRecord {
  readonly id: number;
  readonly type: LayerType;
  readonly name: string;
  readonly visible: boolean;
  /** Null when the content equals the other side's; it is then taken from the current document. */
  readonly content: LayerContent | null;
}

interface LayeredSide {
  readonly width: number;
  readonly height: number;
  readonly layers: readonly LayerRecord[];
  /** Null when the entry leaves it unchanged. */
  readonly palette: readonly PaletteEntry[] | null;
  readonly settings: PatternSettings | null;
  readonly nextBackstitchId: number;
  readonly nextPaletteId: number;
  readonly nextLayerId: number;
}

interface LayerDeltaEntry {
  kind: 'delta';
  layerId: number | null;
  delta: SparseMutationDelta;
  bytes: number;
  progress: ProgressChangeSet;
  recalculateMetrics: boolean;
}

interface LayersEntry {
  kind: 'layers';
  before: LayeredSide;
  after: LayeredSide;
  bytes: number;
}

interface TransformEntry {
  kind: 'transform';
  forward: DomainCommand;
  inverse: DomainCommand;
  bytes: number;
}

interface ReplayEntry {
  kind: 'replay';
  command: DomainCommand;
  before: LayeredSide;
  bytes: number;
}

type LeafHistoryEntry = LayerDeltaEntry | LayersEntry | TransformEntry | ReplayEntry;

interface GroupEntry {
  kind: 'group';
  entries: LeafHistoryEntry[];
  bytes: number;
}

type LayeredHistoryEntry = LeafHistoryEntry | GroupEntry;

const TRANSFORM_ENTRY_BYTES = 64;
const REPLAY_ENTRY_OVERHEAD_BYTES = 64;
const EMPTY_KIND = new Uint8Array(0);
const EMPTY_COLORS = new Uint16Array(0);

function layerContent(layer: Layer): StitchContent | SpecialtyContent {
  return layer.type === LayerType.Stitch ? { kind: layer.kind, colors: layer.colors } : { backstitches: layer.backstitches };
}

function sameLayerContent(left: Layer, right: Layer): boolean {
  if (left.type === LayerType.Stitch && right.type === LayerType.Stitch) return left.kind === right.kind && left.colors === right.colors;
  if (left.type === LayerType.Specialty && right.type === LayerType.Specialty) return left.backstitches === right.backstitches;
  return false;
}

function hasNonZero(values: ArrayLike<number>): boolean {
  for (let index = 0; index < values.length; index += 1) if (values[index] !== 0) return true;
  return false;
}

function isEmptyLayer(layer: Layer): boolean {
  return layer.type === LayerType.Stitch ? !hasNonZero(layer.kind) && !hasNonZero(layer.colors) : layer.backstitches.ids.length === 0;
}

function buildLayer(record: LayerRecord, content: LayerContent, cellCount: number, completed?: Uint8Array): Layer {
  if (record.type === LayerType.Stitch) {
    const cells = content === 'empty' ? { kind: new Uint8Array(cellCount), colors: new Uint16Array(cellCount * 4) } : content as StitchContent;
    return { id: record.id, type: LayerType.Stitch, name: record.name, visible: record.visible, kind: cells.kind, colors: cells.colors, completed: completed ?? new Uint8Array(cellCount) };
  }
  const backstitches = content === 'empty' ? emptyBackstitches() : (content as SpecialtyContent).backstitches;
  return { id: record.id, type: LayerType.Specialty, name: record.name, visible: record.visible, backstitches };
}

function storeBytes(store: BackstitchStore): number {
  return store.ids.byteLength + store.x1.byteLength + store.y1.byteLength + store.x2.byteLength + store.y2.byteLength + store.colors.byteLength + store.completed.byteLength;
}

function layerContentBytes(content: LayerContent): number {
  if (content === 'empty') return 0;
  return 'backstitches' in content ? storeBytes(content.backstitches) : content.kind.byteLength + content.colors.byteLength;
}

function layeredSideBytes(side: LayeredSide): number {
  let bytes = 128;
  for (const record of side.layers) bytes += 64 + record.name.length * 2 + (record.content === null ? 0 : layerContentBytes(record.content));
  if (side.palette !== null) bytes += JSON.stringify(side.palette).length * 2;
  if (side.settings !== null) bytes += JSON.stringify(side.settings).length * 2;
  return bytes;
}

function leafEntryBytes(entry: LeafHistoryEntry): number {
  switch (entry.kind) {
    case 'delta': return typedDeltaBytes(entry.delta);
    case 'layers': return layeredSideBytes(entry.before) + layeredSideBytes(entry.after);
    case 'transform': return TRANSFORM_ENTRY_BYTES;
    case 'replay': return layeredSideBytes(entry.before) + REPLAY_ENTRY_OVERHEAD_BYTES;
  }
}

/** Captures both sides of a transition, keeping only content that differs and marking empty layers. */
function captureLayeredSides(before: LayeredDocument, after: LayeredDocument): { before: LayeredSide; after: LayeredSide } {
  const beforeById = new Map(before.layers.map((layer) => [layer.id, layer]));
  const afterById = new Map(after.layers.map((layer) => [layer.id, layer]));
  const record = (layer: Layer, other: Layer | undefined): LayerRecord => ({
    id: layer.id,
    type: layer.type,
    name: layer.name,
    visible: layer.visible,
    content: other !== undefined && sameLayerContent(layer, other) ? null : isEmptyLayer(layer) ? 'empty' : layerContent(layer)
  });
  const paletteChanged = before.palette !== after.palette;
  const settingsChanged = before.settings !== after.settings;
  const side = (document: LayeredDocument, others: Map<number, Layer>): LayeredSide => ({
    width: document.width,
    height: document.height,
    layers: document.layers.map((layer) => record(layer, others.get(layer.id))),
    palette: paletteChanged ? document.palette : null,
    settings: settingsChanged ? document.settings : null,
    nextBackstitchId: document.nextBackstitchId,
    nextPaletteId: document.nextPaletteId,
    nextLayerId: document.nextLayerId
  });
  return { before: side(before, afterById), after: side(after, beforeById) };
}

function captureLayersEntry(before: LayeredDocument, after: LayeredDocument): LayersEntry {
  const sides = captureLayeredSides(before, after);
  const entry: LayersEntry = { kind: 'layers', ...sides, bytes: 0 };
  entry.bytes = leafEntryBytes(entry);
  return entry;
}

/** Rebuilds a layered state from one side of an entry; omitted content comes from `current`. */
function restoreLayeredSide(current: LayeredDocument, side: LayeredSide): LayeredDocument {
  const currentById = new Map(current.layers.map((layer) => [layer.id, layer]));
  const cellCount = side.width * side.height;
  const layers = side.layers.map((record) => {
    if (record.content !== null) return buildLayer(record, record.content, cellCount);
    const existing = currentById.get(record.id);
    // Unchanged cell planes only fit the same dimensions; an unchanged backstitch store is valid in both.
    if (existing === undefined || existing.type !== record.type || (existing.type === LayerType.Stitch && (current.width !== side.width || current.height !== side.height))) {
      throw new DomainError('invalid-history-state', `History layer ${String(record.id)} is incompatible with the current document.`);
    }
    return buildLayer(record, layerContent(existing), cellCount, existing.type === LayerType.Stitch ? existing.completed : undefined);
  });
  return {
    ...current,
    width: side.width,
    height: side.height,
    layers,
    palette: side.palette === null ? current.palette : side.palette.map(clonePaletteEntry),
    settings: side.settings === null ? current.settings : clonePatternSettings(side.settings),
    revision: current.revision + 1,
    nextBackstitchId: Math.max(current.nextBackstitchId, side.nextBackstitchId),
    nextPaletteId: Math.max(current.nextPaletteId, side.nextPaletteId),
    nextLayerId: Math.max(current.nextLayerId, side.nextLayerId)
  };
}

/** True when a `layers` entry changes only names, so the composite is untouched. */
function layersEntryKeepsComposite(entry: LayersEntry): boolean {
  const { before, after } = entry;
  return before.width === after.width
    && before.height === after.height
    && before.palette === null
    && before.settings === null
    && before.layers.length === after.layers.length
    && before.layers.every((record, index) => {
      const other = after.layers[index];
      return record.id === other.id && record.visible === other.visible && record.content === null && other.content === null;
    });
}

/** A surface carrying only document metadata, for palette and settings deltas. Its planes are empty. */
function metadataSurface(document: LayeredDocument): PatternDocument {
  return {
    version: DOCUMENT_SCHEMA_VERSION,
    catalog: document.catalog,
    width: document.width,
    height: document.height,
    kind: EMPTY_KIND,
    colors: EMPTY_COLORS,
    completed: EMPTY_KIND,
    backstitches: emptyBackstitches(),
    palette: document.palette,
    settings: document.settings,
    revision: document.revision,
    nextBackstitchId: document.nextBackstitchId,
    nextPaletteId: document.nextPaletteId
  };
}

/** A full-size empty surface, used for document commands when a pattern has no layers. */
function bareSurface(document: LayeredDocument): PatternDocument {
  const cellCount = document.width * document.height;
  return {
    ...metadataSurface(document),
    kind: new Uint8Array(cellCount),
    colors: new Uint16Array(cellCount * 4),
    completed: new Uint8Array(cellCount),
    palette: document.palette.slice()
  };
}

/** Writes a changed surface into a new layer object (never mutating the old one) plus shared fields. */
function commitSurfaceToLayer(document: LayeredDocument, layerId: number | null, surface: PatternDocument, revision: number): LayeredDocument {
  const layers = layerId === null
    ? document.layers
    : document.layers.map((layer): Layer => {
        if (layer.id !== layerId) return layer;
        return layer.type === LayerType.Stitch
          ? { ...layer, kind: surface.kind, colors: surface.colors, completed: surface.completed }
          : { ...layer, backstitches: surface.backstitches };
      });
  return {
    ...document,
    layers,
    palette: surface.palette,
    settings: surface.settings,
    revision,
    nextBackstitchId: Math.max(document.nextBackstitchId, surface.nextBackstitchId),
    nextPaletteId: Math.max(document.nextPaletteId, surface.nextPaletteId)
  };
}

/** A layer edit must leave the other content type empty: no cells on specialty layers, no lines on stitch layers. */
function assertSurfaceMatchesLayer(layer: Layer, surface: PatternDocument, cellsChanged: boolean): void {
  const foreign = layer.type === LayerType.Stitch ? surface.backstitches.ids.length > 0 : cellsChanged;
  if (foreign) throw new DomainError('layer-type-mismatch', `This edit cannot be applied to a ${layer.type} layer.`);
}

/** The stack-level invariants a structure command can affect: group order, caps, and ids. */
function assertLayerStack(document: LayeredDocument): void {
  const counts: Record<LayerType, number> = { [LayerType.Stitch]: 0, [LayerType.Specialty]: 0 };
  const ids = new Set<number>();
  let seenSpecialty = false;
  for (const layer of document.layers) {
    if (layer.type === LayerType.Specialty) seenSpecialty = true;
    else if (seenSpecialty) throw new DomainError('invalid-document', 'Stitch layers must sit below specialty layers.');
    counts[layer.type] += 1;
    if (ids.has(layer.id) || layer.id >= document.nextLayerId) throw new DomainError('invalid-document', `Layer id ${String(layer.id)} is invalid.`);
    ids.add(layer.id);
  }
  if (counts[LayerType.Stitch] > MAX_LAYERS_PER_TYPE || counts[LayerType.Specialty] > MAX_LAYERS_PER_TYPE) throw new DomainError('invalid-document', 'A pattern has too many layers.');
}

function normalizedHistoryCommandType(command: DomainCommand): string {
  return typeof command?.type === 'string' ? command.type.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase() : '';
}

function batchChildren(command: DomainCommand): DomainCommand[] | undefined {
  return normalizedHistoryCommandType(command) === 'batch' && Array.isArray(command.commands) ? command.commands as DomainCommand[] : undefined;
}

/** Progress is not stored per layer, so the layered editor refuses completion edits. */
function rejectProgressCommand(command: DomainCommand): void {
  const children = batchChildren(command);
  if (children !== undefined) {
    children.forEach(rejectProgressCommand);
    return;
  }
  const type = normalizedHistoryCommandType(command);
  if (type.includes('complet') || command.completed === true) throw new DomainError('invalid-command', 'Stitch progress cannot be edited in the pattern editor.');
}

function collectLayerIds(command: DomainCommand, ids: Set<number>): void {
  if (command.layerId !== undefined) {
    if (typeof command.layerId !== 'number' || !Number.isSafeInteger(command.layerId)) throw new DomainError('invalid-command', 'layerId must be an integer.');
    ids.add(command.layerId);
  }
  batchChildren(command)?.forEach((child) => collectLayerIds(child, ids));
}

/** The single layer a layer-scoped command targets, from the command, its batch or its children. */
function commandTargetLayerId(command: DomainCommand, fallback?: number): number {
  const ids = new Set<number>();
  collectLayerIds(command, ids);
  if (ids.size > 1) throw new DomainError('invalid-command', 'One edit can only change one layer.');
  const [id] = ids;
  if (id !== undefined) return id;
  if (fallback !== undefined) return fallback;
  throw new DomainError('invalid-command', 'Layer edits require a layerId.');
}

/** True when the command, and every child of a batch, only changes document-wide state. */
function isPureDocumentCommand(command: DomainCommand): boolean {
  const children = batchChildren(command);
  if (children !== undefined) return children.length > 0 && children.every(isPureDocumentCommand);
  return commandScope(command) === 'document';
}

function typedEqual(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  return left === right || (left.length === right.length && historyTypedArraysEqual(left, right));
}

/** Keeps the layer object when a document-wide command left its content unchanged. */
function layerWithSurfaceContent(layer: Layer, surface: PatternDocument): Layer {
  if (layer.type === LayerType.Stitch) {
    if (typedEqual(layer.kind, surface.kind) && typedEqual(layer.colors, surface.colors)) return layer;
    return { ...layer, kind: surface.kind, colors: surface.colors, completed: surface.completed };
  }
  if (historyStoreEqual(layer.backstitches, surface.backstitches)) return layer;
  return { ...layer, backstitches: surface.backstitches };
}

/**
 * Runs a document-wide content command (crop, rotate, mirror, palette merge
 * or delete, settings) over every layer, hidden ones included. Every surface
 * starts from the same state with its own palette copy, so palette and
 * settings change exactly once: they are taken from the last surface.
 * Transforms and crop allocate new planes, so only commands that recolor or
 * erase in place get copies of stitch planes. Specialty layers keep their
 * shared all-zero cell planes, which these commands never write.
 */
function applyDocumentCommandToLayers(document: LayeredDocument, command: DomainCommand): LayeredDocument {
  const writesInPlace = canonicalTransformCommand(command) === undefined && canonicalCropCommand(command) === undefined;
  const draftFor = (layer: Layer): PatternDocument => {
    const surface = layerSurface(document, layer.id);
    const draft: PatternDocument = { ...surface, palette: surface.palette.slice(), backstitches: cloneHistoryStore(surface.backstitches) };
    if (writesInPlace && layer.type === LayerType.Stitch) {
      draft.kind = surface.kind.slice();
      draft.colors = surface.colors.slice();
      draft.completed = surface.completed.slice();
    }
    return draft;
  };
  const drafts = document.layers.length === 0
    ? [{ layer: undefined, draft: bareSurface(document) }]
    : document.layers.map((layer) => ({ layer, draft: draftFor(layer) }));
  for (const { draft } of drafts) applyOneToDraft(draft, command);
  const last = drafts[drafts.length - 1].draft;
  const layers = drafts.flatMap(({ layer, draft }) => layer === undefined ? [] : [layerWithSurfaceContent(layer, draft)]);
  return {
    ...document,
    width: last.width,
    height: last.height,
    layers,
    palette: historyPaletteEqual(document.palette, last.palette) ? document.palette : last.palette,
    settings: settingsEqual(document.settings, last.settings) ? document.settings : last.settings,
    nextBackstitchId: drafts.reduce((value, { draft }) => Math.max(value, draft.nextBackstitchId), document.nextBackstitchId),
    nextPaletteId: Math.max(document.nextPaletteId, last.nextPaletteId)
  };
}

function sameLayeredContent(left: LayeredDocument, right: LayeredDocument): boolean {
  return left.width === right.width
    && left.height === right.height
    && left.palette === right.palette
    && left.settings === right.settings
    && left.layers.length === right.layers.length
    && left.layers.every((layer, index) => layer === right.layers[index]);
}

/** Validates the layers a document-wide command replaced, without rereading unchanged ones. */
function assertChangedLayersValid(before: LayeredDocument, after: LayeredDocument): void {
  const previous = new Set(before.layers);
  for (const layer of after.layers) if (!previous.has(layer)) assertValidDocument(layerSurface(after, layer.id));
}

/**
 * How the composite is refreshed after a change: `full` rebuilds it and
 * reports `compositeFull` (dimension, palette or settings changes); `diff`
 * rebuilds it and reports the cells that actually changed (layer structure);
 * `metadata` and `none` share every plane; an index set updates those cells.
 */
type CompositeRebuild = 'full' | 'diff' | 'metadata' | 'none' | Uint32Array;

/** Cells whose kind or colors differ between two composites of the same size. */
function diffCompositeCells(previous: PatternDocument, next: PatternDocument): Uint32Array {
  const changed: number[] = [];
  const { kind, colors } = next;
  for (let index = 0; index < kind.length; index += 1) {
    const offset = index * 4;
    if (kind[index] !== previous.kind[index]
      || colors[offset] !== previous.colors[offset]
      || colors[offset + 1] !== previous.colors[offset + 1]
      || colors[offset + 2] !== previous.colors[offset + 2]
      || colors[offset + 3] !== previous.colors[offset + 3]) changed.push(index);
  }
  return new Uint32Array(changed);
}

/** Structure-only transitions keep dimensions, palette and settings, so their composite change is a cell diff. */
function layersEntryRebuild(entry: LayersEntry): CompositeRebuild {
  if (layersEntryKeepsComposite(entry)) return 'none';
  const { before, after } = entry;
  return before.width === after.width && before.height === after.height && before.palette === null && before.settings === null ? 'diff' : 'full';
}

function groupRebuild(entries: readonly LeafHistoryEntry[]): CompositeRebuild {
  const diffable = entries.every((entry) => (entry.kind === 'delta' && entry.layerId !== null) || (entry.kind === 'layers' && layersEntryRebuild(entry) !== 'full'));
  return diffable ? 'diff' : 'full';
}

/** A planned change: the next document, its history entry and composite invalidation. No entry means no change. */
interface LayeredPlan {
  readonly result: CommandResult;
  readonly document?: LayeredDocument;
  readonly entry?: LayeredHistoryEntry;
  readonly rebuild?: CompositeRebuild;
  /** The layer a structure command created (add, duplicate). */
  readonly addedLayerId?: number;
}

function wholeDocumentResult(document: PatternDocument, fullRedraw: boolean): CommandResult {
  const commandResult = result(document, true, undefined, undefined, { changed: true, snapshot: fullRedraw, progress: emptyProgress(), recalculateMetrics: fullRedraw });
  if (fullRedraw) commandResult.requiresFullRedraw = true;
  return commandResult;
}

function planLayerCommand(document: LayeredDocument, command: DomainCommand, limit: number, fallbackLayerId?: number): LayeredPlan {
  const layerId = commandTargetLayerId(command, fallbackLayerId);
  const layer = requireEditableLayer(document, layerId, commandLayerType(command));
  const run = runSurfaceCommand(layerSurface(document, layerId), command, limit);
  if (run.next === undefined || run.entry === undefined) return { result: run.result };
  if (run.entry.kind !== 'delta') throw new DomainError('invalid-command', 'A layer edit must be recorded as a sparse change.');
  const delta = run.entry.delta;
  assertSurfaceMatchesLayer(layer, run.next, delta.cells.indices.length > 0);
  return {
    result: run.result,
    document: commitSurfaceToLayer(document, layerId, run.next, document.revision + 1),
    entry: { kind: 'delta', layerId, delta, bytes: run.entry.bytes, progress: run.entry.progress, recalculateMetrics: run.entry.recalculateMetrics },
    rebuild: layer.type === LayerType.Stitch ? delta.cells.indices : new Uint32Array(0)
  };
}

/**
 * Palette metadata and settings commands. Each layer's surface runs the
 * command so reference checks (a color in use on any layer) see every layer;
 * the last run supplies the single palette/settings change.
 */
function planMetadataCommand(document: LayeredDocument, command: DomainCommand, limit: number): LayeredPlan {
  const surfaces = document.layers.length === 0 ? [bareSurface(document)] : document.layers.map((layer) => layerSurface(document, layer.id));
  let run: SurfaceRun | undefined;
  for (const surface of surfaces) run = runSurfaceCommand(surface, command, limit);
  if (run === undefined || run.next === undefined || run.entry === undefined) return { result: run?.result ?? result(metadataSurface(document), false) };
  if (run.entry.kind !== 'delta' || run.entry.delta.cells.indices.length > 0 || run.entry.delta.beforeBackstitches !== undefined) {
    throw new DomainError('invalid-command', 'A palette or settings command changed layer content.');
  }
  return {
    result: run.result,
    document: commitSurfaceToLayer(document, null, run.next, document.revision + 1),
    entry: { kind: 'delta', layerId: null, delta: run.entry.delta, bytes: run.entry.bytes, progress: run.entry.progress, recalculateMetrics: run.entry.recalculateMetrics },
    rebuild: 'metadata'
  };
}

/**
 * Layer structure commands validate only the stack (order, caps, ids): the
 * structure command itself checks names, types and merge rules, and every
 * layer it creates is built from already valid content.
 */
function planStructureCommand(document: LayeredDocument, command: DomainCommand): LayeredPlan {
  const work: LayeredDocument = { ...document };
  const structure = applyLayerStructureCommand(work, command);
  if (!structure.changed) return { result: result(metadataSurface(document), false) };
  const next: LayeredDocument = { ...work, revision: document.revision + 1 };
  assertLayerStack(next);
  const type = normalizedHistoryCommandType(command);
  // A rename or a new empty layer leaves the visible result untouched.
  const keepsComposite = type === 'layer-rename' || type === 'layer-add';
  return {
    result: wholeDocumentResult(metadataSurface(next), false),
    document: next,
    entry: captureLayersEntry(document, next),
    rebuild: keepsComposite ? 'none' : 'diff',
    ...(type === 'layer-add' || type === 'layer-duplicate' ? { addedLayerId: structure.layerId } : {})
  };
}

/**
 * Crop, rotate, mirror, palette merge and delete, and snapshot-scoped
 * document batches over every layer. Rotations and mirrors are stored as the
 * transform and its inverse, a crop keeps only the planes it removes, and
 * anything else keeps both sides of the changed layers.
 */
function planDocumentCommand(document: LayeredDocument, command: DomainCommand): LayeredPlan {
  const applied = applyDocumentCommandToLayers(document, command);
  if (sameLayeredContent(document, applied)) return { result: result(metadataSurface(document), false) };
  const next: LayeredDocument = { ...applied, revision: document.revision + 1 };
  assertChangedLayersValid(document, next);
  const transform = canonicalTransformCommand(command);
  const crop = canonicalCropCommand(command);
  let entry: LeafHistoryEntry;
  if (transform !== undefined) {
    entry = { kind: 'transform', forward: transform.forward, inverse: transform.inverse, bytes: TRANSFORM_ENTRY_BYTES };
  } else if (crop !== undefined) {
    const replay: ReplayEntry = { kind: 'replay', command: crop, before: captureLayeredSides(document, next).before, bytes: 0 };
    replay.bytes = leafEntryBytes(replay);
    entry = replay;
  } else {
    entry = captureLayersEntry(document, next);
  }
  return { result: wholeDocumentResult(metadataSurface(next), true), document: next, entry, rebuild: 'full' };
}

function planSingleCommand(document: LayeredDocument, command: DomainCommand, limit: number, fallbackLayerId?: number): LayeredPlan {
  const scope = commandScope(command);
  if (scope === 'layer') return planLayerCommand(document, command, limit, fallbackLayerId);
  if (scope === 'structure' && batchChildren(command) === undefined) return planStructureCommand(document, command);
  if (isPureDocumentCommand(command) && !commandRequiresSnapshot(command)) return planMetadataCommand(document, command, limit);
  if (batchChildren(command) === undefined) return planDocumentCommand(document, command);
  return planBatchCommand(document, command, limit);
}

/**
 * Structure, document and mixed batches: children run in order on a working
 * copy and their entries become one undo step. Inside a batch, a layer
 * command without a layerId targets the layer the batch most recently added
 * or duplicated. Any failure leaves the document untouched.
 */
function planBatchCommand(document: LayeredDocument, command: DomainCommand, limit: number): LayeredPlan {
  const children = batchChildren(command) ?? [];
  let work = document;
  let addedLayerId: number | undefined;
  const plans: LayeredPlan[] = [];
  for (const child of children) {
    const plan = planSingleCommand(work, child, limit, addedLayerId);
    if (plan.entry === undefined || plan.document === undefined) continue;
    plans.push(plan);
    // Children share the batch's starting revision, as in a single-surface batch.
    work = { ...plan.document, revision: document.revision };
    if (plan.addedLayerId !== undefined) addedLayerId = plan.addedLayerId;
  }
  if (plans.length === 0) return { result: result(metadataSurface(document), false) };
  const next: LayeredDocument = { ...work, revision: document.revision + 1 };
  if (plans.length === 1) return { ...plans[0], document: next };
  const entries = plans.flatMap((plan) => plan.entry === undefined ? [] : plan.entry.kind === 'group' ? plan.entry.entries : [plan.entry]);
  const last = plans[plans.length - 1].result;
  const rebuild = groupRebuild(entries);
  const commandResult = wholeDocumentResult(metadataSurface(next), rebuild === 'full');
  const backstitchId = plans.map((plan) => plan.result.backstitchId).filter((id) => id !== undefined).at(-1);
  const paletteId = plans.map((plan) => plan.result.paletteId).filter((id) => id !== undefined).at(-1);
  return {
    result: {
      ...commandResult,
      ...(backstitchId === undefined ? {} : { backstitchId }),
      ...(paletteId === undefined ? {} : { paletteId }),
      ...(last.createdBackstitchIds === undefined ? {} : { createdBackstitchIds: last.createdBackstitchIds })
    },
    document: next,
    entry: { kind: 'group', entries, bytes: entries.reduce((total, entry) => total + entry.bytes, 0) },
    rebuild,
    ...(addedLayerId === undefined ? {} : { addedLayerId })
  };
}

interface AppliedEntry {
  readonly document: LayeredDocument;
  readonly rebuild: CompositeRebuild;
  readonly result: CommandResult;
}

/** Applies one history entry to `document`: `useAfter` is redo, otherwise undo. Revision advances by one. */
function applyLayeredEntry(document: LayeredDocument, entry: LayeredHistoryEntry, useAfter: boolean): AppliedEntry {
  switch (entry.kind) {
    case 'delta': {
      const layer = entry.layerId === null ? undefined : document.layers.find((candidate) => candidate.id === entry.layerId);
      if (entry.layerId !== null && layer === undefined) throw new DomainError('invalid-history-state', `History layer ${String(entry.layerId)} no longer exists.`);
      const surface = layer === undefined ? metadataSurface(document) : layerSurface(document, layer.id);
      const next = applyDelta(surface, entry.delta, useAfter);
      const commandResult = result(next, true, undefined, undefined, {
        changed: true,
        snapshot: false,
        changedIndices: entry.delta.cells.indices.slice(),
        progress: useAfter ? cloneProgress(entry.progress) : reverseProgress(entry.progress),
        recalculateMetrics: entry.recalculateMetrics
      });
      if (deltaRequiresFullRedraw(entry.delta)) commandResult.requiresFullRedraw = true;
      const rebuild: CompositeRebuild = layer === undefined ? 'metadata' : layer.type === LayerType.Stitch ? entry.delta.cells.indices : new Uint32Array(0);
      return { document: commitSurfaceToLayer(document, entry.layerId, next, document.revision + 1), rebuild, result: commandResult };
    }
    case 'layers': {
      const next = restoreLayeredSide(document, useAfter ? entry.after : entry.before);
      const rebuild = layersEntryRebuild(entry);
      return { document: next, rebuild, result: wholeDocumentResult(metadataSurface(next), rebuild === 'full') };
    }
    case 'transform': {
      const next = { ...applyDocumentCommandToLayers(document, useAfter ? entry.forward : entry.inverse), revision: document.revision + 1 };
      return { document: next, rebuild: 'full', result: wholeDocumentResult(metadataSurface(next), true) };
    }
    case 'replay': {
      const next = useAfter
        ? { ...applyDocumentCommandToLayers(document, entry.command), revision: document.revision + 1 }
        : restoreLayeredSide(document, entry.before);
      return { document: next, rebuild: 'full', result: wholeDocumentResult(metadataSurface(next), true) };
    }
    case 'group': {
      const ordered = useAfter ? entry.entries : [...entry.entries].reverse();
      const next = ordered.reduce((current, child) => applyLayeredEntry(current, child, useAfter).document, document);
      const final = { ...next, revision: document.revision + 1 };
      const rebuild = groupRebuild(entry.entries);
      return { document: final, rebuild, result: wholeDocumentResult(metadataSurface(final), rebuild === 'full') };
    }
  }
}

function recordToDto(record: LayerRecord): HistoryLayerDto {
  const header = { id: record.id, type: record.type, name: record.name, visible: record.visible };
  if (record.content === null) return header;
  if (record.content === 'empty') return { ...header, empty: true };
  if ('backstitches' in record.content) return { ...header, backstitches: cloneHistoryStore(record.content.backstitches) };
  return { ...header, kind: record.content.kind.slice(), colors: record.content.colors.slice() };
}

function sideToDto(side: LayeredSide): HistoryLayeredSideDto {
  return {
    width: side.width,
    height: side.height,
    layers: side.layers.map(recordToDto),
    ...(side.palette === null ? {} : { palette: side.palette.map(clonePaletteEntry) }),
    ...(side.settings === null ? {} : { settings: clonePatternSettings(side.settings) }),
    nextBackstitchId: side.nextBackstitchId,
    nextPaletteId: side.nextPaletteId,
    nextLayerId: side.nextLayerId
  };
}

function leafEntryToDto(entry: LeafHistoryEntry): Exclude<DocumentEditorHistoryEntryDto, HistoryGroupEntryDto> {
  switch (entry.kind) {
    case 'delta': return { kind: 'delta', layerId: entry.layerId, delta: historyDeltaToDto(entry.delta), bytes: entry.bytes };
    case 'layers': return { kind: 'layers', before: sideToDto(entry.before), after: sideToDto(entry.after), bytes: entry.bytes };
    case 'transform': return { kind: 'transform', forward: { ...entry.forward }, inverse: { ...entry.inverse }, bytes: entry.bytes };
    case 'replay': return { kind: 'replay', command: { ...entry.command }, before: sideToDto(entry.before), bytes: entry.bytes };
  }
}

function layeredEntryToDto(entry: LayeredHistoryEntry): DocumentEditorHistoryEntryDto {
  return entry.kind === 'group' ? { kind: 'group', entries: entry.entries.map(leafEntryToDto), bytes: entry.bytes } : leafEntryToDto(entry);
}

function historyLayerDto(value: unknown, width: number, height: number, label: string): asserts value is HistoryLayerDto {
  const layer = historyRecord(value, label);
  historyKeys(layer, ['id', 'type', 'name', 'visible'], ['empty', 'kind', 'colors', 'backstitches'], label);
  historySafeInteger(layer.id, `${label}.id`, 1);
  if (typeof layer.name !== 'string') throw new DomainError('invalid-history-state', `${label}.name is invalid.`);
  const nameLength = Array.from(layer.name).length;
  if (nameLength < 1 || nameLength > MAX_LAYER_NAME_CHARS) throw new DomainError('invalid-history-state', `${label}.name is invalid.`);
  historyBoolean(layer.visible, `${label}.visible`);
  if (layer.empty !== undefined && (layer.empty !== true || layer.kind !== undefined || layer.colors !== undefined || layer.backstitches !== undefined)) throw new DomainError('invalid-history-state', `${label}.empty is invalid.`);
  if (layer.type === LayerType.Stitch) {
    if (layer.backstitches !== undefined) throw new DomainError('invalid-history-state', `${label} is a stitch layer with backstitches.`);
    if ((layer.kind === undefined) !== (layer.colors === undefined)) throw new DomainError('invalid-history-state', `${label} cell planes must be paired.`);
    if (layer.kind !== undefined) {
      historyUint8(layer.kind, `${label}.kind`);
      historyUint16(layer.colors, `${label}.colors`);
      historyLength(layer.kind, width * height, `${label}.kind`);
      historyLength(layer.colors as Uint16Array, width * height * 4, `${label}.colors`);
    }
  } else if (layer.type === LayerType.Specialty) {
    if (layer.kind !== undefined || layer.colors !== undefined) throw new DomainError('invalid-history-state', `${label} is a specialty layer with cells.`);
    if (layer.backstitches !== undefined) historyBackstitches(layer.backstitches, `${label}.backstitches`);
  } else {
    throw new DomainError('invalid-history-state', `${label}.type is unsupported.`);
  }
}

function historyLayeredSide(value: unknown, label: string): asserts value is HistoryLayeredSideDto {
  const side = historyRecord(value, label);
  historyKeys(side, ['width', 'height', 'layers', 'nextBackstitchId', 'nextPaletteId', 'nextLayerId'], ['palette', 'settings'], label);
  const width = historySafeInteger(side.width, `${label}.width`, 1);
  const height = historySafeInteger(side.height, `${label}.height`, 1);
  if (!Number.isSafeInteger(width * height) || width * height > MAX_PERSISTABLE_CELL_COUNT) throw new DomainError('invalid-history-state', `${label} dimensions are too large.`);
  const layers = historyArray(side.layers, `${label}.layers`);
  const ids = new Set<number>();
  layers.forEach((layer, index) => {
    historyLayerDto(layer, width, height, `${label}.layers[${String(index)}]`);
    if (ids.has(layer.id)) throw new DomainError('invalid-history-state', `${label}.layers has a duplicated id.`);
    ids.add(layer.id);
  });
  if (side.palette !== undefined) historyPalette(side.palette, `${label}.palette`);
  if (side.settings !== undefined) historyPatternSettings(side.settings, `${label}.settings`);
  historySafeInteger(side.nextBackstitchId, `${label}.nextBackstitchId`, 1);
  historySafeInteger(side.nextPaletteId, `${label}.nextPaletteId`, 1);
  historySafeInteger(side.nextLayerId, `${label}.nextLayerId`, 1);
}

function historyCanonicalCommand(value: unknown, canonical: (command: DomainCommand) => DomainCommand | undefined, label: string): DomainCommand {
  const command = historyRecord(value, label) as DomainCommand;
  const expected = typeof command.type === 'string' ? canonical(command) : undefined;
  if (expected === undefined || JSON.stringify(expected) !== JSON.stringify(command)) throw new DomainError('invalid-history-state', `${label} is not a canonical command.`);
  return expected;
}

function historyLayeredEntry(value: unknown, label: string, allowGroup = true): asserts value is DocumentEditorHistoryEntryDto {
  const entry = historyRecord(value, label);
  if (entry.kind === 'delta') {
    historyKeys(entry, ['kind', 'layerId', 'delta', 'bytes'], [], label);
    if (entry.layerId !== null) historySafeInteger(entry.layerId, `${label}.layerId`, 1);
    historyDelta(entry.delta, MAX_PERSISTABLE_CELL_COUNT, `${label}.delta`);
    const delta = entry.delta as HistoryDeltaDto;
    if (!historyDeltaChanged(delta)) throw new DomainError('invalid-history-state', `${label} contains no mutation.`);
    if (entry.layerId === null && (delta.cells.indices.length > 0 || delta.cellCompletions !== undefined || delta.backstitchCompletions !== undefined || delta.beforeBackstitches !== undefined)) {
      throw new DomainError('invalid-history-state', `${label} is a document delta with layer content.`);
    }
  } else if (entry.kind === 'layers') {
    historyKeys(entry, ['kind', 'before', 'after', 'bytes'], [], label);
    historyLayeredSide(entry.before, `${label}.before`);
    historyLayeredSide(entry.after, `${label}.after`);
    const before = entry.before as HistoryLayeredSideDto;
    const after = entry.after as HistoryLayeredSideDto;
    if ((before.palette === undefined) !== (after.palette === undefined)) throw new DomainError('invalid-history-state', `${label} palette sides must be paired.`);
    if ((before.settings === undefined) !== (after.settings === undefined)) throw new DomainError('invalid-history-state', `${label} settings sides must be paired.`);
  } else if (entry.kind === 'transform') {
    historyKeys(entry, ['kind', 'forward', 'inverse', 'bytes'], [], label);
    const forward = historyCanonicalCommand(entry.forward, (command) => canonicalTransformCommand(command)?.forward, `${label}.forward`);
    const transform = canonicalTransformCommand(forward);
    if (transform === undefined || JSON.stringify(transform.inverse) !== JSON.stringify(entry.inverse)) throw new DomainError('invalid-history-state', `${label}.inverse does not invert the transform.`);
  } else if (entry.kind === 'replay') {
    historyKeys(entry, ['kind', 'command', 'before', 'bytes'], [], label);
    historyCanonicalCommand(entry.command, canonicalCropCommand, `${label}.command`);
    historyLayeredSide(entry.before, `${label}.before`);
  } else if (entry.kind === 'group' && allowGroup) {
    historyKeys(entry, ['kind', 'entries', 'bytes'], [], label);
    const entries = historyArray(entry.entries, `${label}.entries`);
    if (entries.length < 2) throw new DomainError('invalid-history-state', `${label} must group at least two entries.`);
    entries.forEach((child, index) => historyLayeredEntry(child, `${label}.entries[${String(index)}]`, false));
  } else {
    throw new DomainError('invalid-history-state', `${label}.kind is unsupported.`);
  }
  historySafeInteger(entry.bytes, `${label}.bytes`, 1);
}

function recordFromDto(layer: HistoryLayerDto): LayerRecord {
  const header = { id: layer.id, type: layer.type, name: layer.name, visible: layer.visible };
  if (layer.empty === true) return { ...header, content: 'empty' };
  if (layer.type === LayerType.Specialty) return { ...header, content: layer.backstitches === undefined ? null : { backstitches: cloneHistoryStore(layer.backstitches) } };
  if (layer.kind === undefined || layer.colors === undefined) return { ...header, content: null };
  return { ...header, content: { kind: layer.kind.slice(), colors: layer.colors.slice() } };
}

function sideFromDto(side: HistoryLayeredSideDto): LayeredSide {
  return {
    width: side.width,
    height: side.height,
    layers: side.layers.map(recordFromDto),
    palette: side.palette === undefined ? null : side.palette.map(clonePaletteEntry),
    settings: side.settings === undefined ? null : clonePatternSettings(side.settings),
    nextBackstitchId: side.nextBackstitchId,
    nextPaletteId: side.nextPaletteId,
    nextLayerId: side.nextLayerId
  };
}

function leafEntryFromDto(entry: Exclude<DocumentEditorHistoryEntryDto, HistoryGroupEntryDto>): LeafHistoryEntry {
  let leaf: LeafHistoryEntry;
  switch (entry.kind) {
    case 'delta': leaf = { kind: 'delta', layerId: entry.layerId, delta: historyDeltaToInternal(entry.delta), bytes: 0, progress: emptyProgress(), recalculateMetrics: true }; break;
    case 'layers': leaf = { kind: 'layers', before: sideFromDto(entry.before), after: sideFromDto(entry.after), bytes: 0 }; break;
    case 'transform': leaf = { kind: 'transform', forward: { ...entry.forward }, inverse: { ...entry.inverse }, bytes: 0 }; break;
    case 'replay': leaf = { kind: 'replay', command: { ...entry.command }, before: sideFromDto(entry.before), bytes: 0 }; break;
  }
  leaf.bytes = leafEntryBytes(leaf);
  return leaf;
}

function layeredEntryFromDto(entry: DocumentEditorHistoryEntryDto): LayeredHistoryEntry {
  if (entry.kind !== 'group') return leafEntryFromDto(entry);
  const entries = entry.entries.map(leafEntryFromDto);
  return { kind: 'group', entries, bytes: entries.reduce((total, child) => total + child.bytes, 0) };
}

interface ChainLayer {
  readonly id: number;
  readonly type: LayerType;
  name: string;
  visible: boolean;
  /** Exact stitch planes while known. Planes are copied before validation writes into them. */
  kind?: Uint8Array;
  colors?: Uint16Array;
  ownsPlanes: boolean;
  /** Exact backstitch store while known. */
  backstitches?: BackstitchStore;
  /**
   * Palette id to reference count in this layer. A crop replayed over unknown
   * content keeps the pre-crop counts as an upper bound: a positive count
   * means the color may still be in use.
   */
  colorUse: Map<number, number>;
  /** Backstitch ids on this layer; a superset once a crop has been replayed. */
  lineIds: Set<number>;
}

/**
 * The state an imported history chain is checked against. Stack, dimensions,
 * palette, settings and allocators are always exact. Layer content is exact
 * until the first transform or crop replay, which are never executed; after
 * that only structure, bounds and the values each entry writes are checked.
 */
interface ChainState {
  width: number;
  height: number;
  layers: ChainLayer[];
  palette: readonly PaletteEntry[];
  settings: PatternSettings;
  nextBackstitchId: number;
  nextPaletteId: number;
  nextLayerId: number;
  readonly catalog: LayeredDocument['catalog'];
  /** The largest backstitch allocator in the chain; every written id must sit below it. */
  readonly backstitchIdLimit: number;
}

function countColors(values: ArrayLike<number>, use = new Map<number, number>()): Map<number, number> {
  for (let index = 0; index < values.length; index += 1) {
    const color = values[index];
    if (color !== 0) use.set(color, (use.get(color) ?? 0) + 1);
  }
  return use;
}

function chainLayerFromLayer(layer: Layer): ChainLayer {
  if (layer.type === LayerType.Stitch) {
    return { id: layer.id, type: layer.type, name: layer.name, visible: layer.visible, kind: layer.kind, colors: layer.colors, ownsPlanes: false, colorUse: countColors(layer.colors), lineIds: new Set() };
  }
  return { id: layer.id, type: layer.type, name: layer.name, visible: layer.visible, backstitches: layer.backstitches, ownsPlanes: false, colorUse: countColors(layer.backstitches.colors), lineIds: new Set(layer.backstitches.ids) };
}

function chainFromDocument(document: LayeredDocument): ChainState {
  return {
    width: document.width,
    height: document.height,
    layers: document.layers.map(chainLayerFromLayer),
    palette: document.palette,
    settings: document.settings,
    nextBackstitchId: document.nextBackstitchId,
    nextPaletteId: document.nextPaletteId,
    nextLayerId: document.nextLayerId,
    catalog: document.catalog,
    backstitchIdLimit: document.nextBackstitchId
  };
}

/** Validates written cells as a one-row surface, so the cost follows the number of cells written. */
function assertWrittenCellsValid(state: ChainState, kind: Uint8Array, colors: Uint16Array, palette: readonly PaletteEntry[], label: string): void {
  if (kind.length === 0) return;
  const probe: PatternDocument = {
    version: DOCUMENT_SCHEMA_VERSION,
    catalog: state.catalog,
    width: kind.length,
    height: 1,
    kind,
    colors,
    completed: new Uint8Array(kind.length),
    backstitches: emptyBackstitches(),
    palette: [...palette],
    settings: state.settings,
    revision: 0,
    nextBackstitchId: 1,
    nextPaletteId: palette.reduce((max, entry) => Math.max(max, entry.id), 0) + 1
  };
  const errors = collectValidationErrors(probe);
  if (errors.length > 0) throw new DomainError('invalid-history-state', `${label} writes invalid cells: ${errors[0]}`);
}

/** Validates a written backstitch store against the dimensions, palette, allocator and the other layers' ids. */
function assertWrittenLinesValid(state: ChainState, layerId: number, store: BackstitchStore, width: number, height: number, palette: readonly PaletteEntry[], layers: readonly ChainLayer[], label: string): void {
  const active = new Set(palette.filter((entry) => entry.active).map((entry) => entry.id));
  const others = layers.filter((layer) => layer.id !== layerId);
  const ids = new Set<number>();
  const segments = new Set<string>();
  const fail = (): never => historyStateMismatch(`${label}.backstitches`);
  for (let index = 0; index < store.ids.length; index += 1) {
    const id = store.ids[index];
    const x1 = store.x1[index];
    const y1 = store.y1[index];
    const x2 = store.x2[index];
    const y2 = store.y2[index];
    if (id === 0 || id >= state.backstitchIdLimit || ids.has(id) || others.some((layer) => layer.lineIds.has(id))) fail();
    if (x1 > width * 4 || x2 > width * 4 || y1 > height * 4 || y2 > height * 4) fail();
    if ((x1 === x2 && y1 === y2) || x1 > x2 || (x1 === x2 && y1 > y2)) fail();
    const key = `${String(x1)},${String(y1)},${String(x2)},${String(y2)}`;
    if (segments.has(key) || !active.has(store.colors[index]) || store.completed[index] !== 0) fail();
    ids.add(id);
    segments.add(key);
  }
}

/** Every color still referenced by content must stay an active palette entry. */
function assertColorsInPalette(layers: readonly ChainLayer[], palette: readonly PaletteEntry[], label: string): void {
  const active = new Set(palette.filter((entry) => entry.active).map((entry) => entry.id));
  for (const layer of layers) {
    for (const [color, count] of layer.colorUse) if (count > 0 && !active.has(color)) historyStateMismatch(`${label}.palette`);
  }
}

/**
 * Recounts what a crop keeps when the layer's content is known: cells inside
 * the rectangle and lines fully inside its closed boundary, as the crop
 * command retains them. Unknown content keeps its counts as an upper bound.
 */
function countCropSurvivors(layer: ChainLayer, width: number, rect: CropRect): void {
  if (layer.kind !== undefined && layer.colors !== undefined) {
    const use = new Map<number, number>();
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      const start = (y * width + rect.x) * 4;
      countColors(layer.colors.subarray(start, start + rect.width * 4), use);
    }
    layer.colorUse = use;
  } else if (layer.backstitches !== undefined) {
    const store = layer.backstitches;
    const [left, top, right, bottom] = [rect.x * 4, rect.y * 4, (rect.x + rect.width) * 4, (rect.y + rect.height) * 4];
    const use = new Map<number, number>();
    const ids = new Set<number>();
    for (let index = 0; index < store.ids.length; index += 1) {
      const inside = store.x1[index] >= left && store.x1[index] <= right && store.x2[index] >= left && store.x2[index] <= right
        && store.y1[index] >= top && store.y1[index] <= bottom && store.y2[index] >= top && store.y2[index] <= bottom;
      if (!inside) continue;
      use.set(store.colors[index], (use.get(store.colors[index]) ?? 0) + 1);
      ids.add(store.ids[index]);
    }
    layer.colorUse = use;
    layer.lineIds = ids;
  }
}

function dropLayerContent(layer: ChainLayer): void {
  delete layer.kind;
  delete layer.colors;
  delete layer.backstitches;
  layer.ownsPlanes = false;
}

/** Checks that `state` is the side an entry applies from: stack, dimensions, palette and settings, plus content while it is known. */
function chainMatchesSide(state: ChainState, side: LayeredSide, label: string): void {
  if (state.width !== side.width || state.height !== side.height || state.layers.length !== side.layers.length) historyStateMismatch(label);
  side.layers.forEach((record, index) => {
    const layer = state.layers[index];
    if (layer.id !== record.id || layer.type !== record.type || layer.name !== record.name || layer.visible !== record.visible) historyStateMismatch(`${label}.layers[${String(index)}]`);
    if (record.content === null) return;
    if (record.content === 'empty') {
      if ([...layer.colorUse.values()].some((count) => count > 0) || (layer.type === LayerType.Specialty && layer.backstitches !== undefined && layer.backstitches.ids.length > 0)) historyStateMismatch(`${label}.layers[${String(index)}]`);
      if (layer.kind !== undefined && hasNonZero(layer.kind)) historyStateMismatch(`${label}.layers[${String(index)}]`);
      return;
    }
    if ('backstitches' in record.content) {
      if (layer.backstitches !== undefined && !historyStoreEqual(layer.backstitches, record.content.backstitches)) historyStateMismatch(`${label}.layers[${String(index)}]`);
    } else if (layer.kind !== undefined && layer.colors !== undefined && (!typedEqual(layer.kind, record.content.kind) || !typedEqual(layer.colors, record.content.colors))) {
      historyStateMismatch(`${label}.layers[${String(index)}]`);
    }
  });
  if (side.palette !== null && !historyPaletteEqual(state.palette, side.palette)) historyStateMismatch(`${label}.palette`);
  if (side.settings !== null && !settingsEqual(state.settings, side.settings)) historyStateMismatch(`${label}.settings`);
  // The opposite direction writes this side, so its stored content must be valid too.
  side.layers.forEach((record, index) => {
    if (record.content === null || record.content === 'empty') return;
    const recordLabel = `${label}.layers[${String(index)}]`;
    if ('backstitches' in record.content) assertWrittenLinesValid(state, record.id, record.content.backstitches, side.width, side.height, state.palette, state.layers, recordLabel);
    else assertWrittenCellsValid(state, record.content.kind, record.content.colors, state.palette, recordLabel);
  });
}

/**
 * Moves the chain to `side`, validating every layer record the side writes.
 * Omitted content must name a layer of the same type, and omitted cell planes
 * need unchanged dimensions.
 */
function chainToSide(state: ChainState, side: LayeredSide, label: string): void {
  const palette = side.palette ?? state.palette;
  const cellCount = side.width * side.height;
  const layers = side.layers.map((record, index): ChainLayer => {
    const recordLabel = `${label}.layers[${String(index)}]`;
    if (record.content === null) {
      const existing = state.layers.find((layer) => layer.id === record.id);
      if (existing === undefined || existing.type !== record.type) historyStateMismatch(recordLabel);
      if (record.type === LayerType.Stitch && (state.width !== side.width || state.height !== side.height)) historyStateMismatch(recordLabel);
      return { ...existing, name: record.name, visible: record.visible };
    }
    const header = { id: record.id, type: record.type, name: record.name, visible: record.visible };
    if (record.content === 'empty') {
      return record.type === LayerType.Stitch
        ? { ...header, kind: new Uint8Array(cellCount), colors: new Uint16Array(cellCount * 4), ownsPlanes: true, colorUse: new Map(), lineIds: new Set() }
        : { ...header, backstitches: emptyBackstitches(), ownsPlanes: false, colorUse: new Map(), lineIds: new Set() };
    }
    if ('backstitches' in record.content) {
      const store = record.content.backstitches;
      return { ...header, backstitches: store, ownsPlanes: false, colorUse: countColors(store.colors), lineIds: new Set(store.ids) };
    }
    assertWrittenCellsValid(state, record.content.kind, record.content.colors, palette, recordLabel);
    return { ...header, kind: record.content.kind, colors: record.content.colors, ownsPlanes: false, colorUse: countColors(record.content.colors), lineIds: new Set() };
  });
  side.layers.forEach((record, index) => {
    if (record.content === null || record.content === 'empty' || !('backstitches' in record.content)) return;
    assertWrittenLinesValid(state, record.id, record.content.backstitches, side.width, side.height, palette, layers, `${label}.layers[${String(index)}]`);
  });
  assertColorsInPalette(layers, palette, label);
  state.width = side.width;
  state.height = side.height;
  state.layers = layers;
  state.palette = palette;
  state.settings = side.settings ?? state.settings;
  state.nextBackstitchId = Math.max(state.nextBackstitchId, side.nextBackstitchId);
  state.nextPaletteId = Math.max(state.nextPaletteId, side.nextPaletteId);
  state.nextLayerId = Math.max(state.nextLayerId, side.nextLayerId);
  if (state.layers.some((layer) => layer.id >= state.nextLayerId)) historyStateMismatch(`${label}.nextLayerId`);
}

function cropRect(command: DomainCommand): CropRect {
  return { x: command.x as number, y: command.y as number, width: command.width as number, height: command.height as number };
}

function packedCellsSide(cells: SparseMutationDelta['cells'], useAfter: boolean): { kind: Uint8Array; colors: Uint16Array; completed: Uint8Array } {
  return useAfter
    ? { kind: cells.afterKind, colors: cells.afterColors, completed: cells.afterCompleted }
    : { kind: cells.beforeKind, colors: cells.beforeColors, completed: cells.beforeCompleted };
}

/** Checks and applies a delta entry: it reads its `from` side and writes its `to` side (`useAfter` is redo). */
function stepDeltaForValidation(state: ChainState, entry: LayerDeltaEntry, useAfter: boolean, label: string): void {
  const delta = entry.delta;
  const cells = delta.cells;
  if (delta.cellCompletions !== undefined || delta.backstitchCompletions !== undefined) historyStateMismatch(`${label}.progress`);
  const fromPalette = useAfter ? delta.beforePalette : delta.afterPalette;
  const toPalette = useAfter ? delta.afterPalette : delta.beforePalette;
  const fromSettings = useAfter ? delta.beforeSettings : delta.afterSettings;
  const toSettings = useAfter ? delta.afterSettings : delta.beforeSettings;
  if (fromPalette !== undefined && !historyPaletteEqual(state.palette, fromPalette)) historyStateMismatch(`${label}.palette`);
  if (fromSettings !== undefined && !settingsEqual(state.settings, fromSettings)) historyStateMismatch(`${label}.settings`);
  const palette = toPalette ?? state.palette;
  const from = packedCellsSide(cells, !useAfter);
  const to = packedCellsSide(cells, useAfter);
  if (hasNonZero(from.completed) || hasNonZero(to.completed)) historyStateMismatch(`${label}.progress`);

  if (entry.layerId !== null) {
    const layer = state.layers.find((candidate) => candidate.id === entry.layerId);
    if (layer === undefined) historyStateMismatch(`${label}.layerId`);
    const cellCount = state.width * state.height;
    for (const index of cells.indices) if (index >= cellCount) historyStateMismatch(`${label}.cells`);
    const fromStore = useAfter ? delta.beforeBackstitches : delta.afterBackstitches;
    const toStore = useAfter ? delta.afterBackstitches : delta.beforeBackstitches;
    const foreign = layer.type === LayerType.Specialty ? cells.indices.length > 0 : (fromStore?.ids.length ?? 0) > 0 || (toStore?.ids.length ?? 0) > 0;
    if (foreign) historyStateMismatch(`${label}.layerId`);

    if (cells.indices.length > 0) {
      // Undo writes one side and redo the other, so both must be valid against the palette in effect there.
      assertWrittenCellsValid(state, from.kind, from.colors, state.palette, `${label}.cells`);
      assertWrittenCellsValid(state, to.kind, to.colors, palette, `${label}.cells`);
      if (layer.kind !== undefined && layer.colors !== undefined) {
        for (let position = 0; position < cells.indices.length; position += 1) {
          const index = cells.indices[position];
          if (layer.kind[index] !== from.kind[position]) historyStateMismatch(`${label}.cells[${String(position)}]`);
          for (let slot = 0; slot < 4; slot += 1) if (layer.colors[index * 4 + slot] !== from.colors[position * 4 + slot]) historyStateMismatch(`${label}.cells[${String(position)}]`);
        }
        if (!layer.ownsPlanes) {
          layer.kind = layer.kind.slice();
          layer.colors = layer.colors.slice();
          layer.ownsPlanes = true;
        }
        for (let position = 0; position < cells.indices.length; position += 1) {
          const index = cells.indices[position];
          layer.kind[index] = to.kind[position];
          for (let slot = 0; slot < 4; slot += 1) layer.colors[index * 4 + slot] = to.colors[position * 4 + slot];
        }
      }
      const use = layer.colorUse;
      for (let slot = 0; slot < from.colors.length; slot += 1) {
        if (from.colors[slot] !== 0) use.set(from.colors[slot], (use.get(from.colors[slot]) ?? 0) - 1);
        if (to.colors[slot] !== 0) use.set(to.colors[slot], (use.get(to.colors[slot]) ?? 0) + 1);
      }
    }
    if (fromStore !== undefined && toStore !== undefined) {
      if (layer.backstitches !== undefined && !historyStoreEqual(layer.backstitches, fromStore)) historyStateMismatch(`${label}.backstitches`);
      assertWrittenLinesValid(state, layer.id, fromStore, state.width, state.height, state.palette, state.layers, label);
      assertWrittenLinesValid(state, layer.id, toStore, state.width, state.height, palette, state.layers, label);
      layer.backstitches = toStore;
      layer.colorUse = countColors(toStore.colors);
      layer.lineIds = new Set(toStore.ids);
    }
  }
  if (toPalette !== undefined) assertColorsInPalette(state.layers, palette, label);
  state.palette = palette;
  state.settings = toSettings ?? state.settings;
  const toNextBackstitchId = useAfter ? delta.afterNextBackstitchId : delta.beforeNextBackstitchId;
  const toNextPaletteId = useAfter ? delta.afterNextPaletteId : delta.beforeNextPaletteId;
  if (toNextBackstitchId !== undefined) state.nextBackstitchId = Math.max(state.nextBackstitchId, toNextBackstitchId);
  if (toNextPaletteId !== undefined) state.nextPaletteId = Math.max(state.nextPaletteId, toNextPaletteId);
}

/**
 * Checks that `entry` applies to `state` from the side it will be applied
 * from and moves the state to the other side (`useAfter` is redo). Every
 * value an entry writes is validated; transforms and crops are never
 * executed and no unchanged cell plane is reread.
 */
function stepLayeredEntryForValidation(state: ChainState, entry: LayeredHistoryEntry, useAfter: boolean, label: string): void {
  switch (entry.kind) {
    case 'group': {
      const ordered = entry.entries.map((child, index) => ({ child, index }));
      if (!useAfter) ordered.reverse();
      for (const { child, index } of ordered) stepLayeredEntryForValidation(state, child, useAfter, `${label}.entries[${String(index)}]`);
      return;
    }
    case 'layers':
      chainMatchesSide(state, useAfter ? entry.before : entry.after, label);
      chainToSide(state, useAfter ? entry.after : entry.before, label);
      return;
    case 'transform': {
      // The DTO check already proved forward and inverse are a canonical pair. Colors and ids move with their content.
      const command = useAfter ? entry.forward : entry.inverse;
      if (command.type === 'rotate-cw' && (command.quarterTurns as number) % 2 === 1) [state.width, state.height] = [state.height, state.width];
      state.layers.forEach(dropLayerContent);
      return;
    }
    case 'replay': {
      const rect = cropRect(entry.command);
      if (rect.x + rect.width > entry.before.width || rect.y + rect.height > entry.before.height) historyStateMismatch(`${label}.command`);
      if (useAfter) {
        chainMatchesSide(state, entry.before, label);
        for (const layer of state.layers) {
          countCropSurvivors(layer, entry.before.width, rect);
          dropLayerContent(layer);
        }
        state.width = rect.width;
        state.height = rect.height;
        return;
      }
      if (state.width !== rect.width || state.height !== rect.height || state.layers.length !== entry.before.layers.length) historyStateMismatch(label);
      entry.before.layers.forEach((record, index) => {
        if (state.layers[index].id !== record.id || state.layers[index].type !== record.type) historyStateMismatch(`${label}.layers[${String(index)}]`);
      });
      chainToSide(state, entry.before, label);
      return;
    }
    case 'delta':
      stepDeltaForValidation(state, entry, useAfter, label);
  }
}

function hydrateLayeredHistory(value: unknown, current: LayeredDocument, configuredLimit: number): { undo: LayeredHistoryEntry[]; redo: LayeredHistoryEntry[]; undoBytes: number; redoBytes: number } {
  const state = historyRecord(value, 'history');
  historyKeys(state, ['version', 'undo', 'redo'], [], 'history');
  if (state.version !== DOCUMENT_EDITOR_HISTORY_VERSION) throw new DomainError('unsupported-history-version', `History version ${String(state.version)} is not supported.`);
  const undoDtos = historyArray(state.undo, 'history.undo');
  const redoDtos = historyArray(state.redo, 'history.redo');
  if (undoDtos.length + redoDtos.length > MAX_HISTORY_ENTRY_COUNT) throw new DomainError('invalid-history-state', 'History entry count is invalid or exceeds the decode bound.');
  undoDtos.forEach((entry, index) => historyLayeredEntry(entry, `history.undo[${String(index)}]`));
  redoDtos.forEach((entry, index) => historyLayeredEntry(entry, `history.redo[${String(index)}]`));
  const undo = (undoDtos as DocumentEditorHistoryEntryDto[]).map(layeredEntryFromDto);
  const redo = (redoDtos as DocumentEditorHistoryEntryDto[]).map(layeredEntryFromDto);
  const checkBytes = (entries: readonly LayeredHistoryEntry[], dtos: readonly DocumentEditorHistoryEntryDto[], label: string): number => entries.reduce((total, entry, index) => {
    if (dtos[index].bytes !== entry.bytes) throw new DomainError('invalid-history-state', `${label}[${String(index)}] byte accounting is not canonical.`);
    if (entry.kind === 'group') {
      const group = dtos[index] as HistoryGroupEntryDto;
      entry.entries.forEach((child, childIndex) => {
        if (group.entries[childIndex].bytes !== child.bytes) throw new DomainError('invalid-history-state', `${label}[${String(index)}].entries[${String(childIndex)}] byte accounting is not canonical.`);
      });
    }
    return historySumBytes(total, entry.bytes, label);
  }, 0);
  const undoBytes = checkBytes(undo, undoDtos as DocumentEditorHistoryEntryDto[], 'history.undo');
  const redoBytes = checkBytes(redo, redoDtos as DocumentEditorHistoryEntryDto[], 'history.redo');
  const total = historySumBytes(undoBytes, redoBytes, 'history');
  if (total > MAX_HISTORY_DECODE_BYTES) throw new DomainError('history-too-large', `History payload exceeds the ${String(MAX_HISTORY_DECODE_BYTES)} byte decode ceiling.`);
  if (total > configuredLimit) throw new DomainError('invalid-history-state', 'History entries exceed the configured history limit.');
  const undoChain = chainFromDocument(current);
  for (let index = undo.length - 1; index >= 0; index -= 1) stepLayeredEntryForValidation(undoChain, undo[index], false, `undo[${String(index)}]`);
  const redoChain = chainFromDocument(current);
  for (let index = redo.length - 1; index >= 0; index -= 1) stepLayeredEntryForValidation(redoChain, redo[index], true, `redo[${String(index)}]`);
  return { undo, redo, undoBytes, redoBytes };
}

/**
 * Undo/redo over a `LayeredDocument`. Layer-scoped commands (cells,
 * backstitches, fragments, erase, delete) run on the target layer's surface
 * and are stored as sparse deltas tagged with the layer id. Palette and
 * settings metadata are document deltas. Structure commands store only the
 * layers they change; rotations and mirrors store their inverse; a crop
 * stores the planes it removes; batches group their children's entries into
 * one undo step.
 *
 * `document` and `composite` are replaced, never mutated, on every change, and
 * layer objects and their planes are never written after publication.
 * `CommandResult.document` is the flattened composite.
 */
export class DocumentEditor {
  private layered: LayeredDocument;
  private readonly cache = new FlattenCache();
  private undoStack: LayeredHistoryEntry[] = [];
  private redoStack: LayeredHistoryEntry[] = [];
  private readonly historyLimit: number;
  private undoBytes = 0;
  private redoBytes = 0;

  constructor(document: LayeredDocument, options: HistoryOptions = {}) {
    assertValidLayeredDocument(document);
    const historyLimit = options.historyLimitBytes ?? options.maxHistoryBytes ?? DEFAULT_HISTORY_LIMIT_BYTES;
    if (!Number.isSafeInteger(historyLimit) || historyLimit < 1) throw new DomainError('invalid-history-limit', 'historyLimitBytes must be a positive integer.');
    this.historyLimit = historyLimit;
    this.layered = { ...document, layers: [...document.layers] };
    this.cache.full(this.layered);
  }

  /** Builds an editor over `layeredFromSurface(surface)`: cells on "Stitches" (id 1), backstitches on "Specialty" (id 2). */
  static fromSurface(surface: PatternDocument, options: HistoryOptions = {}): DocumentEditor {
    return new DocumentEditor(layeredFromSurface(cloneDocument(surface)), options);
  }

  get document(): LayeredDocument {
    return this.layered;
  }

  /** The visible flattened result every renderer and metrics reader uses. */
  get composite(): PatternDocument {
    return this.cache.document ?? this.cache.full(this.layered);
  }

  get revision(): number {
    return this.layered.revision;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }

  get redoDepth(): number {
    return this.redoStack.length;
  }

  get historyLimitBytes(): number {
    return this.historyLimit;
  }

  get historyBytes(): number {
    return this.undoBytes + this.redoBytes;
  }

  get historyBytesUsed(): number {
    return this.historyBytes;
  }

  get lastHistoryEntryKind(): LayeredHistoryEntry['kind'] | null {
    return this.undoStack.length === 0 ? null : this.undoStack[this.undoStack.length - 1].kind;
  }

  /** Detached DTOs; `maxBytes` drops the oldest undo entries first, then the newest-first redo prefix. */
  exportHistory(options: HistoryExportOptions = {}): DocumentEditorHistoryDto {
    const selected = trimHistoryForExport(this.undoStack, this.redoStack, options.maxBytes);
    return { version: DOCUMENT_EDITOR_HISTORY_VERSION, undo: selected.undo.map(layeredEntryToDto), redo: selected.redo.map(layeredEntryToDto) };
  }

  /** Restores history only after the whole DTO has validated against the current document. Version 1 throws `unsupported-history-version`. */
  importHistory(state: unknown): void {
    const restored = hydrateLayeredHistory(state, this.layered, this.historyLimit);
    this.undoStack = restored.undo;
    this.redoStack = restored.redo;
    this.undoBytes = restored.undoBytes;
    this.redoBytes = restored.redoBytes;
  }

  execute(command: DomainCommand): CommandResult {
    if (!command || typeof command.type !== 'string') throw new DomainError('invalid-command', 'Every command must have a type.');
    rejectProgressCommand(command);
    const plan = planSingleCommand(this.layered, command, this.historyLimit);
    if (plan.document === undefined || plan.entry === undefined || plan.rebuild === undefined) {
      return { ...plan.result, document: this.composite, revision: this.layered.revision };
    }
    ensureHistoryEntryFits(plan.entry.bytes, this.historyLimit);
    this.layered = plan.document;
    this.pushHistory(plan.entry);
    return this.publish(plan.result, plan.rebuild);
  }

  executeBatch(commands: readonly DomainCommand[]): CommandResult {
    return this.execute({ type: 'batch', commands: [...commands] });
  }

  batch(commands: readonly DomainCommand[]): CommandResult {
    return this.executeBatch(commands);
  }

  undo(): CommandResult {
    const entry = this.undoStack.pop();
    if (!entry) return result(this.composite, false);
    this.undoBytes -= entry.bytes;
    const applied = applyLayeredEntry(this.layered, entry, false);
    this.redoStack.push(entry);
    this.redoBytes += entry.bytes;
    this.layered = applied.document;
    return this.publish(applied.result, applied.rebuild);
  }

  redo(): CommandResult {
    const entry = this.redoStack.pop();
    if (!entry) return result(this.composite, false);
    this.redoBytes -= entry.bytes;
    const applied = applyLayeredEntry(this.layered, entry, true);
    this.undoStack.push(entry);
    this.undoBytes += entry.bytes;
    this.layered = applied.document;
    return this.publish(applied.result, applied.rebuild);
  }

  clearHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.undoBytes = 0;
    this.redoBytes = 0;
  }

  /** Discard redo entries without touching undo (a new action clears redo). */
  clearRedo(): void {
    this.redoStack = [];
    this.redoBytes = 0;
  }

  /**
   * Swaps the planned result's surface for the refreshed composite and adds
   * composite invalidation: full rebuilds and metadata changes report
   * `compositeFull`; cell edits report their indices; name-only changes
   * report `compositeUnchanged` with an empty index set and share every
   * composite plane.
   */
  private publish(base: CommandResult, rebuild: CompositeRebuild): CommandResult {
    if (rebuild === 'diff') return this.publishDiff(base);
    let composite: PatternDocument;
    if (rebuild === 'full') composite = this.cache.full(this.layered);
    else if (rebuild === 'metadata' || rebuild === 'none') composite = this.cache.touch(this.layered);
    else composite = this.cache.update(this.layered, rebuild);
    return {
      ...base,
      document: composite,
      revision: this.layered.revision,
      ...(rebuild === 'full' || rebuild === 'metadata' ? { compositeFull: true } : { compositeChangedIndices: rebuild === 'none' ? new Uint32Array(0) : rebuild.slice() }),
      ...(rebuild === 'none' ? { compositeUnchanged: true } : {})
    };
  }

  /**
   * Rebuilds the composite and reports exactly the cells that changed, as
   * both `changedIndices` and `compositeChangedIndices`. Backstitches follow
   * the usual convention: consumers compare the stores themselves, and
   * metrics rescan only when the visible lines changed. Falls back to a full
   * rebuild when the size changed.
   */
  private publishDiff(base: CommandResult): CommandResult {
    const previous = this.cache.document;
    const composite = this.cache.full(this.layered);
    if (previous === null || previous.width !== composite.width || previous.height !== composite.height) {
      return { ...base, document: composite, revision: this.layered.revision, requiresFullRedraw: true, recalculateMetrics: true, compositeFull: true };
    }
    const changedIndices = diffCompositeCells(previous, composite);
    const linesChanged = !historyStoreEqual(previous.backstitches, composite.backstitches);
    return {
      ...base,
      document: composite,
      revision: this.layered.revision,
      changedIndices,
      compositeChangedIndices: changedIndices.slice(),
      recalculateMetrics: linesChanged,
      ...(changedIndices.length === 0 && !linesChanged ? { compositeUnchanged: true } : {})
    };
  }

  private pushHistory(entry: LayeredHistoryEntry): void {
    ensureHistoryEntryFits(entry.bytes, this.historyLimit);
    this.redoStack = [];
    this.redoBytes = 0;
    this.undoStack.push(entry);
    this.undoBytes += entry.bytes;
    while (this.undoBytes > this.historyLimit && this.undoStack.length > 0) {
      const oldest = this.undoStack.shift();
      if (oldest) this.undoBytes -= oldest.bytes;
    }
  }
}

export function createDocumentEditor(document: LayeredDocument, options: HistoryOptions = {}): DocumentEditor {
  return new DocumentEditor(document, options);
}

export function exportDocumentEditorHistory(editor: DocumentEditor, options: HistoryExportOptions = {}): DocumentEditorHistoryDto {
  return editor.exportHistory(options);
}

export function importDocumentEditorHistory(editor: DocumentEditor, state: unknown): void {
  editor.importHistory(state);
}

export function createEditorFromHistory(document: LayeredDocument, state: unknown, options: HistoryOptions = {}): DocumentEditor {
  const editor = new DocumentEditor(document, options);
  editor.importHistory(state);
  return editor;
}

export function execute(editor: DocumentEditor | SurfaceEditor, command: DomainCommand): CommandResult {
  return editor.execute(command);
}

export function undo(editor: DocumentEditor | SurfaceEditor): CommandResult {
  return editor.undo();
}

export function redo(editor: DocumentEditor | SurfaceEditor): CommandResult {
  return editor.redo();
}

export function createEditor(document: PatternDocument, options: HistoryOptions = {}): SurfaceEditor {
  return new SurfaceEditor(document, options);
}

export const createHistory = createEditor;
export const createCommandHistory = createEditor;
export { SurfaceEditor as CommandHistory };
