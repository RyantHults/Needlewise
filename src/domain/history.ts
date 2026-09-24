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
import { cloneDocument, clonePaletteEntry, clonePatternSettings } from './model';
import type {
  BackstitchStore,
  CommandResult,
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
import { DEFAULT_PATTERN_SETTINGS, DomainError, MaterialUnit, MAX_PERSISTABLE_CELL_COUNT, PALETTE_ID_MAX } from './types';
import { assertValidDocument } from './validation';
import {
  attachDeleteMetricsImpactForDelta
} from './internal-metrics-impact';

export const DEFAULT_HISTORY_LIMIT_BYTES = 64 * 1024 * 1024;
export const DOCUMENT_EDITOR_HISTORY_VERSION = 1 as const;
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

export type DocumentEditorHistoryEntryDto = HistoryDeltaEntryDto | HistorySnapshotEntryDto;

export interface DocumentEditorHistoryDto {
  readonly version: typeof DOCUMENT_EDITOR_HISTORY_VERSION;
  readonly undo: readonly DocumentEditorHistoryEntryDto[];
  readonly redo: readonly DocumentEditorHistoryEntryDto[];
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

function isLegacySnapshotEntry(entry: DocumentEditorHistoryEntryDto): entry is HistorySnapshotEntryDto {
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
      backgroundColor: DEFAULT_PATTERN_SETTINGS.backgroundColor
    }
  };
}

function cloneHistoryDocument(document: PatternDocument, allowLegacy: boolean): PatternDocument {
  const clone = cloneDocument(document);
  if (allowLegacy && isLegacyPatternSettings(document.settings as unknown as HistoryRecord)) {
    clone.settings = {
      symbolSet: document.settings.symbolSet,
      materialUnit: document.settings.materialUnit,
      backgroundColor: DEFAULT_PATTERN_SETTINGS.backgroundColor
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

function snapshotSettingsChanged(entry: SnapshotEntry): boolean {
  return entry.before.settings.symbolSet !== entry.after.settings.symbolSet
    || entry.before.settings.materialUnit !== entry.after.settings.materialUnit
    || entry.before.settings.backgroundColor !== entry.after.settings.backgroundColor;
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
  historyKeys(settings, legacySettings ? ['symbolSet', 'materialUnit'] : ['symbolSet', 'materialUnit', 'backgroundColor'], [], `${label}.settings`);
  if (typeof settings.symbolSet !== 'string' || typeof settings.materialUnit !== 'string') throw new DomainError('invalid-history-state', `${label}.settings is invalid.`);
  historyBoundedString(settings.symbolSet, `${label}.settings.symbolSet`);
  historyBoundedString(settings.materialUnit, `${label}.settings.materialUnit`);
  if (!legacySettings) {
    if (typeof settings.backgroundColor !== 'string') throw new DomainError('invalid-history-state', `${label}.settings.backgroundColor is invalid.`);
    historyBoundedString(settings.backgroundColor, `${label}.settings.backgroundColor`);
    if (!/^#[0-9A-F]{6}$/.test(settings.backgroundColor)) throw new DomainError('invalid-history-state', `${label}.settings.backgroundColor is invalid.`);
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
    && left.settings.symbolSet === right.settings.symbolSet
    && left.settings.materialUnit === right.settings.materialUnit
    && left.settings.backgroundColor === right.settings.backgroundColor
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
  historyKeys(settings, ['symbolSet', 'materialUnit', 'backgroundColor'], [], label);
  if (typeof settings.symbolSet !== 'string' || settings.symbolSet.trim() === '') throw new DomainError('invalid-history-state', `${label}.symbolSet is invalid.`);
  if (settings.materialUnit !== MaterialUnit.Skeins && settings.materialUnit !== MaterialUnit.Meters && settings.materialUnit !== MaterialUnit.Count) throw new DomainError('invalid-history-state', `${label}.materialUnit is invalid.`);
  if (typeof settings.backgroundColor !== 'string' || !/^#[0-9A-F]{6}$/.test(settings.backgroundColor)) throw new DomainError('invalid-history-state', `${label}.backgroundColor is invalid.`);
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

function historyEntry(value: unknown, cellCount: number, label: string): asserts value is DocumentEditorHistoryEntryDto {
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

function historyState(value: unknown): asserts value is DocumentEditorHistoryDto {
  const state = historyRecord(value, 'history');
  historyKeys(state, ['version', 'undo', 'redo'], [], 'history');
  if (state.version !== DOCUMENT_EDITOR_HISTORY_VERSION) throw new DomainError('unsupported-history-version', `History version ${String(state.version)} is not supported.`);
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

function historyRawEntry(total: number, entry: DocumentEditorHistoryEntryDto): number {
  let next = historyRawObject(total, 5);
  next = historyRawString(next, entry.kind);
  next = historyRawAdd(next, 9);
  next = historyRawProgress(next, entry.progress);
  if (entry.kind === 'delta') return historyRawDelta(next, entry.delta);
  next = historyRawDocument(next, entry.before);
  return historyRawDocument(next, entry.after);
}

function historyRawState(state: DocumentEditorHistoryDto): number {
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
  if (settings !== undefined && (document.settings.symbolSet !== settings.symbolSet || document.settings.materialUnit !== settings.materialUnit || document.settings.backgroundColor !== settings.backgroundColor)) historyStateMismatch(`${label}.settings`);
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

function historyEntryToInternal(entry: DocumentEditorHistoryEntryDto): HistoryEntry {
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

function historyEntryToDto(entry: HistoryEntry): DocumentEditorHistoryEntryDto {
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
    && (delta.beforeSettings.symbolSet !== delta.afterSettings?.symbolSet
      || delta.beforeSettings.materialUnit !== delta.afterSettings?.materialUnit
      || delta.beforeSettings.backgroundColor !== delta.afterSettings?.backgroundColor);
  return changedCells || changedCompletions || changedBackstitchCompletions || changedPalette || changedBackstitches || changedAllocators || changedSettings;
}

function validateHistoryEntryContent(entry: DocumentEditorHistoryEntryDto, label: string): void {
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
  const state = value as unknown as DocumentEditorHistoryDto;
  historyRawState(state);
  const validateStack = (entries: readonly DocumentEditorHistoryEntryDto[], label: string): void => {
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

function trimHistoryForExport(undo: readonly HistoryEntry[], redo: readonly HistoryEntry[], maxBytes: number | undefined): { undo: HistoryEntry[]; redo: HistoryEntry[] } {
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

export class DocumentEditor {
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
  exportHistory(options: HistoryExportOptions = {}): DocumentEditorHistoryDto {
    const selected = trimHistoryForExport(this.undoStack, this.redoStack, options.maxBytes);
    const undo = selected.undo.map(historyEntryToDto);
    const redo = selected.redo.map(historyEntryToDto);
    return {
      version: DOCUMENT_EDITOR_HISTORY_VERSION,
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
    if (isBulkCellCommand(command)) return this.executeBulkCellCommand(command);
    if (isBulkRecolorCommand(command)) return this.executeBulkRecolorCommand(command);
    if (isBulkCompletionCommand(command)) return this.executeBulkCompletionCommand(command);
    if (isBulkBackstitchCompletionCommand(command)) return this.executeBulkBackstitchCompletionCommand(command);
    if (isPasteFragmentCommand(command)) return this.executePasteFragmentCommand(command);
    if (isMoveFragmentCommand(command)) return this.executeMoveFragmentCommand(command);
    if (isMixedEraseCommand(command)) return this.executeMixedEraseCommand(command);
    if (isDeleteRegionCommand(command)) return this.executeDeleteRegionCommand(command);
    if (isDeleteCellSetCommand(command)) return this.executeDeleteCellSetCommand(command);
    if (isBatchCommand(command) && Array.isArray(command.commands)) {
      assertBulkBatchPolicy(command.commands as DomainCommand[]);
      if (command.commands.length === 1 && isBulkCellCommand(command.commands[0] as DomainCommand)) {
        return this.executeBulkCellCommand(command.commands[0] as DomainCommand);
      }
      if (command.commands.length === 1 && isBulkRecolorCommand(command.commands[0] as DomainCommand)) {
        return this.executeBulkRecolorCommand(command.commands[0] as DomainCommand);
      }
      if (command.commands.length === 1 && isBulkCompletionCommand(command.commands[0] as DomainCommand)) {
        return this.executeBulkCompletionCommand(command.commands[0] as DomainCommand);
      }
      if (command.commands.length === 1 && isBulkBackstitchCompletionCommand(command.commands[0] as DomainCommand)) {
        return this.executeBulkBackstitchCompletionCommand(command.commands[0] as DomainCommand);
      }
      if (command.commands.length === 1 && isPasteFragmentCommand(command.commands[0] as DomainCommand)) {
        return this.executePasteFragmentCommand(command.commands[0] as DomainCommand);
      }
      if (command.commands.length === 1 && isMoveFragmentCommand(command.commands[0] as DomainCommand)) {
        return this.executeMoveFragmentCommand(command.commands[0] as DomainCommand);
      }
      if (command.commands.length === 1 && isMixedEraseCommand(command.commands[0] as DomainCommand)) {
        return this.executeMixedEraseCommand(command.commands[0] as DomainCommand);
      }
      if (command.commands.length === 1 && isDeleteRegionCommand(command.commands[0] as DomainCommand)) {
        return this.executeDeleteRegionCommand(command.commands[0] as DomainCommand);
      }
      if (command.commands.length === 1 && isDeleteCellSetCommand(command.commands[0] as DomainCommand)) {
        return this.executeDeleteCellSetCommand(command.commands[0] as DomainCommand);
      }
    }
    if (isPaletteMetadataOnlyCommand(command)) return this.executePaletteMetadataCommand(command);
    if (commandRequiresSnapshot(command)) return this.executeSnapshotCommand(command);

    const draft = cloneDocument(this.current);
    // Settings are immutable across current command paths. Reuse the object so
    // sparse edits and their undo/redo transitions preserve settings identity.
    draft.settings = this.current.settings;
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
      return result(this.current, false, mutation.backstitchId, mutation.paletteId, mutation);
    }
    draft.revision = this.current.revision + 1;
    assertValidDocument(draft);
    const delta = tracker.toDelta(draft);
    const entry: DeltaEntry = { kind: 'delta', delta, bytes: typedDeltaBytes(delta), progress: cloneProgress(mutation.progress), recalculateMetrics: mutation.recalculateMetrics === true };
    ensureHistoryEntryFits(entry.bytes, this.historyLimit);
    this.current = draft;
    this.pushHistory(entry);
    const commandResult = result(this.current, true, mutation.backstitchId, mutation.paletteId, mutation);
    if (delta.beforeSettings !== undefined) commandResult.requiresFullRedraw = true;
    return commandResult;
  }

  private executePaletteMetadataCommand(command: DomainCommand): CommandResult {
    // Palette metadata commands are preflighted by applyOneToDraft and do not
    // touch dimensions, dense cell planes, or backstitches. Keep those
    // structures shared so this path remains bounded by palette metadata.
    const draft: PatternDocument = { ...this.current, palette: this.current.palette.slice() };
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
      return result(this.current, false, mutation.backstitchId, mutation.paletteId, mutation);
    }
    draft.revision = this.current.revision + 1;
    // The current document was validated when it entered history, and the
    // palette command preflight validates every changed metadata field and
    // reference rule. Since all content-bearing planes remain shared, a full
    // document validation here would only reread the unchanged dense planes.
    const delta = tracker.toDelta(draft);
    const entry: DeltaEntry = { kind: 'delta', delta, bytes: typedDeltaBytes(delta), progress: cloneProgress(mutation.progress), recalculateMetrics: mutation.recalculateMetrics === true };
    ensureHistoryEntryFits(entry.bytes, this.historyLimit);
    this.current = draft;
    this.pushHistory(entry);
    return result(this.current, true, mutation.backstitchId, mutation.paletteId, mutation);
  }

  private executeBulkCellCommand(command: DomainCommand): CommandResult {
    const preflight = preflightBulkCellCommand(this.current, command);
    const estimatedBytes = estimateBulkCellHistoryBytes(preflight.changedIndices.length);
    ensureHistoryEntryFits(estimatedBytes, this.historyLimit);
    if (preflight.changedIndices.length === 0) {
      return result(this.current, false, undefined, undefined, {
        changed: false,
        snapshot: false,
        touchedIndices: preflight.indices,
        changedIndices: preflight.changedIndices,
        progress: { cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0), marked: 0, unmarked: 0 }
      });
    }

    // Bulk edits bypass MutationTracker entirely. The draft is the only
    // document mutated, and the packed delta returned by the canonical bulk
    // command is passed directly to history without being rebuilt.
    const draft = cloneDocument(this.current);
    const mutation = applyBulkCellCommand(draft, command, preflight);
    draft.revision = this.current.revision + 1;
    assertValidDocument(draft);
    if (mutation.delta === undefined) throw new DomainError('invalid-bulk-edit', 'A changed bulk edit did not produce a history delta.');
    const entry: DeltaEntry = { kind: 'delta', delta: mutation.delta, bytes: typedDeltaBytes(mutation.delta), progress: cloneProgress(mutation.progress), recalculateMetrics: mutation.recalculateMetrics === true };
    ensureHistoryEntryFits(entry.bytes, this.historyLimit);
    this.current = draft;
    this.pushHistory(entry);
    return result(this.current, true, undefined, undefined, mutation);
  }

  private executeBulkRecolorCommand(command: DomainCommand): CommandResult {
    const preflight = preflightBulkRecolorCommand(this.current, command);
    const estimatedBytes = estimateBulkRecolorHistoryBytes(preflight.changedIndices.length);
    ensureHistoryEntryFits(estimatedBytes, this.historyLimit);
    if (preflight.changedIndices.length === 0) {
      return result(this.current, false, undefined, undefined, {
        changed: false,
        snapshot: false,
        touchedIndices: preflight.indices,
        changedIndices: preflight.changedIndices,
        progress: emptyProgress()
      });
    }
    const draft = cloneDocument(this.current);
    const mutation = applyBulkRecolorCommand(draft, command, preflight);
    draft.revision = this.current.revision + 1;
    assertValidDocument(draft);
    if (mutation.delta === undefined) throw new DomainError('invalid-bulk-recolor', 'A changed bulk recolor did not produce a history delta.');
    const entry: DeltaEntry = { kind: 'delta', delta: mutation.delta, bytes: typedDeltaBytes(mutation.delta), progress: cloneProgress(mutation.progress), recalculateMetrics: mutation.recalculateMetrics === true };
    ensureHistoryEntryFits(entry.bytes, this.historyLimit);
    this.current = draft;
    this.pushHistory(entry);
    return result(this.current, true, undefined, undefined, mutation);
  }

  private executeBulkCompletionCommand(command: DomainCommand): CommandResult {
    const preflight = preflightBulkCompletionCommand(this.current, command);
    const estimatedBytes = estimateBulkCompletionHistoryBytes(preflight.changedIndices.length);
    ensureHistoryEntryFits(estimatedBytes, this.historyLimit);
    if (preflight.changedIndices.length === 0) {
      return result(this.current, false, undefined, undefined, {
        changed: false,
        snapshot: false,
        touchedIndices: preflight.indices,
        changedIndices: preflight.changedIndices,
        progress: { cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0), marked: 0, unmarked: 0 }
      });
    }
    // Invariant: preflight validated every target, and completion apply mutates only this copied dense plane.
    const draft: PatternDocument = { ...this.current, completed: this.current.completed.slice() };
    const mutation = applyBulkCompletionCommand(draft, command, preflight);
    draft.revision = this.current.revision + 1;
    if (mutation.delta === undefined) throw new DomainError('invalid-completion-command', 'A changed bulk completion did not produce a history delta.');
    const entry: DeltaEntry = { kind: 'delta', delta: mutation.delta, bytes: typedDeltaBytes(mutation.delta), progress: cloneProgress(mutation.progress), recalculateMetrics: mutation.recalculateMetrics === true };
    ensureHistoryEntryFits(entry.bytes, this.historyLimit);
    this.current = draft;
    this.pushHistory(entry);
    return result(this.current, true, undefined, undefined, mutation);
  }

  private executeBulkBackstitchCompletionCommand(command: DomainCommand): CommandResult {
    const preflight = preflightBulkBackstitchCompletionCommand(this.current, command);
    const estimatedBytes = estimateBulkBackstitchCompletionHistoryBytes(preflight.changedIds.length);
    ensureHistoryEntryFits(estimatedBytes, this.historyLimit);
    if (preflight.changedIds.length === 0) {
      return result(this.current, false, undefined, undefined, {
        changed: false,
        snapshot: false,
        touchedBackstitchIds: preflight.ids,
        changedBackstitchIds: preflight.changedIds,
        progress: { cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0), marked: 0, unmarked: 0 }
      });
    }
    const draft = cloneDocument(this.current);
    const mutation = applyBulkBackstitchCompletionCommand(draft, command, preflight);
    draft.revision = this.current.revision + 1;
    assertValidDocument(draft);
    if (mutation.delta === undefined) throw new DomainError('invalid-completion-command', 'A changed bulk backstitch completion did not produce a history delta.');
    const entry: DeltaEntry = { kind: 'delta', delta: mutation.delta, bytes: typedDeltaBytes(mutation.delta), progress: cloneProgress(mutation.progress), recalculateMetrics: mutation.recalculateMetrics === true };
    ensureHistoryEntryFits(entry.bytes, this.historyLimit);
    this.current = draft;
    this.pushHistory(entry);
    return result(this.current, true, undefined, undefined, mutation);
  }

  private executePasteFragmentCommand(command: DomainCommand): CommandResult {
    const preflight = preflightPasteFragmentCommand(this.current, command);
    const estimatedBytes = estimatePasteFragmentHistoryBytes(preflight.changedCellCount, this.current.backstitches.ids.length, preflight.newBackstitchCount);
    ensureHistoryEntryFits(estimatedBytes, this.historyLimit);
    if (estimatedBytes === 0) return result(this.current, false);

    const draft = cloneDocument(this.current);
    const mutation = applyPasteFragmentCommand(draft, command, preflight);
    draft.revision = this.current.revision + 1;
    assertValidDocument(draft);
    if (mutation.delta === undefined) throw new DomainError('invalid-fragment', 'A changed paste did not produce a history delta.');
    const entry: DeltaEntry = { kind: 'delta', delta: mutation.delta, bytes: typedDeltaBytes(mutation.delta), progress: cloneProgress(mutation.progress), recalculateMetrics: mutation.recalculateMetrics === true };
    ensureHistoryEntryFits(entry.bytes, this.historyLimit);
    this.current = draft;
    this.pushHistory(entry);
    return result(this.current, true, undefined, undefined, mutation);
  }

  private executeMoveFragmentCommand(command: DomainCommand): CommandResult {
    const preflight = preflightMoveFragmentCommand(this.current, command, this.historyLimit);
    const estimatedBytes = estimateMoveFragmentHistoryBytes(
      preflight.changedIndices.length,
      this.current.backstitches.ids.length,
      preflight.backstitchesChanged ? preflight.movedBackstitchIds.length : 0
    );
    ensureHistoryEntryFits(estimatedBytes, this.historyLimit);
    if (estimatedBytes === 0) {
      return result(this.current, false, undefined, undefined, {
        changed: false,
        snapshot: false,
        changedIndices: preflight.changedIndices,
        movedBackstitchIds: new Uint32Array(0),
        progress: cloneProgress(undefined)
      });
    }
    const draft = cloneDocument(this.current);
    const mutation = applyMoveFragmentCommand(draft, command, preflight);
    draft.revision = this.current.revision + 1;
    assertValidDocument(draft);
    if (mutation.delta === undefined) throw new DomainError('invalid-move-fragment', 'A changed move did not produce a history delta.');
    const entry: DeltaEntry = {
      kind: 'delta',
      delta: mutation.delta,
      bytes: typedDeltaBytes(mutation.delta),
      progress: cloneProgress(mutation.progress),
      recalculateMetrics: true
    };
    ensureHistoryEntryFits(entry.bytes, this.historyLimit);
    this.current = draft;
    this.pushHistory(entry);
    return result(this.current, true, undefined, undefined, mutation);
  }

  private executeMixedEraseCommand(command: DomainCommand): CommandResult {
    const preflight = preflightMixedEraseCommand(this.current, command);
    const estimatedBytes = estimateMixedEraseHistoryBytes(preflight.changedCellCount);
    ensureHistoryEntryFits(estimatedBytes, this.historyLimit);
    if (estimatedBytes === 0) return result(this.current, false);

    const draft = cloneDocument(this.current);
    const mutation = applyMixedEraseCommand(draft, command, preflight);
    draft.revision = this.current.revision + 1;
    assertValidDocument(draft);
    if (mutation.delta === undefined) throw new DomainError('invalid-mixed-erase', 'A changed mixed erase did not produce a history delta.');
    const entry: DeltaEntry = { kind: 'delta', delta: mutation.delta, bytes: typedDeltaBytes(mutation.delta), progress: cloneProgress(mutation.progress), recalculateMetrics: mutation.recalculateMetrics === true };
    ensureHistoryEntryFits(entry.bytes, this.historyLimit);
    this.current = draft;
    this.pushHistory(entry);
    return result(this.current, true, undefined, undefined, mutation);
  }

  private executeDeleteRegionCommand(command: DomainCommand): CommandResult {
    const preflight = preflightDeleteRegionCommand(this.current, command);
    const estimatedBytes = estimateDeleteRegionHistoryBytes(
      preflight.changedIndices.length,
      this.current.backstitches.ids.length,
      preflight.changedBackstitchIds.length
    );
    ensureHistoryEntryFits(estimatedBytes, this.historyLimit);
    if (estimatedBytes === 0) {
      return result(this.current, false, undefined, undefined, {
        changed: false,
        snapshot: false,
        touchedIndices: preflight.touchedIndices,
        changedIndices: preflight.changedIndices,
        changedBackstitchIds: preflight.changedBackstitchIds,
        progress: emptyProgress()
      });
    }

    const draft = cloneForDelete(this.current);
    const mutation = applyDeleteRegionCommand(draft, command, preflight);
    draft.revision = this.current.revision + 1;
    if (mutation.delta === undefined) throw new DomainError('invalid-delete-region', 'A changed delete-region command did not produce a history delta.');
    const entry: DeltaEntry = {
      kind: 'delta',
      delta: mutation.delta,
      bytes: typedDeltaBytes(mutation.delta),
      progress: cloneProgress(mutation.progress),
      recalculateMetrics: mutation.recalculateMetrics === true
    };
    ensureHistoryEntryFits(entry.bytes, this.historyLimit);
    this.current = draft;
    this.pushHistory(entry);
    const commandResult = result(this.current, true, undefined, undefined, mutation);
    attachDeleteMetricsImpactForDelta(commandResult, mutation.delta, 'after');
    return commandResult;
  }

  private executeDeleteCellSetCommand(command: DomainCommand): CommandResult {
    const preflight = preflightDeleteCellSetCommand(this.current, command);
    const estimatedBytes = estimateDeleteCellSetHistoryBytes(
      preflight.changedIndices.length,
      this.current.backstitches.ids.length,
      preflight.changedBackstitchIds.length
    );
    ensureHistoryEntryFits(estimatedBytes, this.historyLimit);
    if (estimatedBytes === 0) {
      return result(this.current, false, undefined, undefined, {
        changed: false,
        snapshot: false,
        touchedIndices: preflight.touchedIndices,
        changedIndices: preflight.changedIndices,
        changedBackstitchIds: preflight.changedBackstitchIds,
        progress: emptyProgress()
      });
    }

    const draft = cloneForDelete(this.current);
    const mutation = applyDeleteCellSetCommand(draft, command, preflight);
    draft.revision = this.current.revision + 1;
    if (mutation.delta === undefined) throw new DomainError('invalid-delete-cell-set', 'A changed delete-cell-set command did not produce a history delta.');
    const entry: DeltaEntry = {
      kind: 'delta',
      delta: mutation.delta,
      bytes: typedDeltaBytes(mutation.delta),
      progress: cloneProgress(mutation.progress),
      recalculateMetrics: mutation.recalculateMetrics === true
    };
    ensureHistoryEntryFits(entry.bytes, this.historyLimit);
    this.current = draft;
    this.pushHistory(entry);
    const commandResult = result(this.current, true, undefined, undefined, mutation);
    attachDeleteMetricsImpactForDelta(commandResult, mutation.delta, 'after');
    return commandResult;
  }

  private executeSnapshotCommand(command: DomainCommand): CommandResult {
    const before = cloneDocument(this.current);
    const draft = cloneDocument(this.current);
    const mutation: MutationInfo = applyOneToDraft(draft, command);
    if (!mutation.changed) return result(this.current, false);
    const settingsChanged = before.settings.symbolSet !== draft.settings.symbolSet
      || before.settings.materialUnit !== draft.settings.materialUnit
      || before.settings.backgroundColor !== draft.settings.backgroundColor;
    draft.revision = this.current.revision + 1;
    assertValidDocument(draft);
    const entry: SnapshotEntry = { kind: 'snapshot', before, after: cloneDocument(draft), bytes: snapshotBytes(draft) + snapshotBytes(before), progress: cloneProgress(mutation.progress), recalculateMetrics: mutation.recalculateMetrics === true };
    ensureHistoryEntryFits(entry.bytes, this.historyLimit);
    this.current = draft;
    this.pushHistory(entry);
    const commandResult = result(this.current, true, mutation.backstitchId, mutation.paletteId, mutation);
    if (settingsChanged) commandResult.requiresFullRedraw = true;
    return commandResult;
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
    const currentNextBackstitchId = this.current.nextBackstitchId;
    const currentNextPaletteId = this.current.nextPaletteId;
    const next = entry.kind === 'snapshot' ? cloneDocument(entry.before) : applyDelta(this.current, entry.delta, false);
    next.revision = this.current.revision + 1;
    // Allocators are monotonic even when content is undone. This prevents an
    // ID from being reused after an add/remove/undo sequence.
    next.nextBackstitchId = Math.max(next.nextBackstitchId, currentNextBackstitchId);
    next.nextPaletteId = Math.max(next.nextPaletteId, currentNextPaletteId);
    if (entry.kind === 'snapshot') assertValidDocument(next);
    this.redoStack.push(entry);
    this.redoBytes += entry.bytes;
    this.current = next;
    const commandResult = result(this.current, true, undefined, undefined, {
      changed: true,
      snapshot: entry.kind === 'snapshot',
      ...(entry.kind === 'delta' ? { changedIndices: entry.delta.cells.indices.slice() } : {}),
      progress: reverseProgress(entry.progress),
      recalculateMetrics: entry.recalculateMetrics
    });
    if (entry.kind === 'delta') {
      if (deltaRequiresFullRedraw(entry.delta)) commandResult.requiresFullRedraw = true;
      attachDeleteMetricsImpactForDelta(commandResult, entry.delta, 'before');
    } else if (snapshotSettingsChanged(entry)) commandResult.requiresFullRedraw = true;
    return commandResult;
  }

  redo(): CommandResult {
    const entry = this.redoStack.pop();
    if (!entry) return result(this.current, false);
    this.redoBytes -= entry.bytes;
    const currentNextBackstitchId = this.current.nextBackstitchId;
    const currentNextPaletteId = this.current.nextPaletteId;
    const next = entry.kind === 'snapshot' ? cloneDocument(entry.after) : applyDelta(this.current, entry.delta, true);
    next.revision = this.current.revision + 1;
    next.nextBackstitchId = Math.max(next.nextBackstitchId, currentNextBackstitchId);
    next.nextPaletteId = Math.max(next.nextPaletteId, currentNextPaletteId);
    if (entry.kind === 'snapshot') assertValidDocument(next);
    this.undoStack.push(entry);
    this.undoBytes += entry.bytes;
    this.current = next;
    const commandResult = result(this.current, true, undefined, undefined, {
      changed: true,
      snapshot: entry.kind === 'snapshot',
      ...(entry.kind === 'delta' ? { changedIndices: entry.delta.cells.indices.slice() } : {}),
      progress: cloneProgress(entry.progress),
      recalculateMetrics: entry.recalculateMetrics
    });
    if (entry.kind === 'delta') {
      if (deltaRequiresFullRedraw(entry.delta)) commandResult.requiresFullRedraw = true;
      attachDeleteMetricsImpactForDelta(commandResult, entry.delta, 'after');
    } else if (snapshotSettingsChanged(entry)) commandResult.requiresFullRedraw = true;
    return commandResult;
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

export function createEditor(document: PatternDocument, options: HistoryOptions = {}): DocumentEditor {
  return new DocumentEditor(document, options);
}

export const createDocumentEditor = createEditor;
export const createHistory = createEditor;
export const createCommandHistory = createEditor;
export { DocumentEditor as CommandHistory };

export function exportDocumentEditorHistory(editor: DocumentEditor, options: HistoryExportOptions = {}): DocumentEditorHistoryDto {
  return editor.exportHistory(options);
}

export function importDocumentEditorHistory(editor: DocumentEditor, state: unknown): void {
  editor.importHistory(state);
}

export function createEditorFromHistory(document: PatternDocument, state: unknown, options: HistoryOptions = {}): DocumentEditor {
  const editor = new DocumentEditor(document, options);
  editor.importHistory(state);
  return editor;
}

export function execute(editor: DocumentEditor, command: DomainCommand): CommandResult {
  return editor.execute(command);
}

export function undo(editor: DocumentEditor): CommandResult {
  return editor.undo();
}

export function redo(editor: DocumentEditor): CommandResult {
  return editor.redo();
}
