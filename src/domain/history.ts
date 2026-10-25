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
  emptyCellDelta,
  noChange,
  bulkCompletionCommand,
  bulkBackstitchCompletionCommand,
  type MutationInfo,
  type SparseMutationDelta
} from './commands';
import { UINT32_MAX, cloneDocument, clonePaletteEntry, clonePatternSettings, emptyBackstitches } from './model';
import type {
  BackstitchStore,
  BulkBackstitchCompletionCommand,
  BulkCellCommand,
  BulkCompletionCommand,
  BulkRecolorCommand,
  CanvasCellsCommand,
  CanvasResizeCommand,
  CommandResult,
  DeleteCellSetCommand,
  DeleteRegionCommand,
  Layer,
  LayeredDocument,
  DomainCommand,
  MixedEraseCommand,
  MoveFragmentCommand,
  PasteFragmentCommand,
  PaletteEntry,
  PatternSettings,
  PatternDocument,
  ProgressChangeSet,
  StitchLayer
} from './types';
import { CellKind, DOCUMENT_SCHEMA_VERSION, DomainError, LAYERED_DOCUMENT_VERSION, LayerType, MAX_LAYER_NAME_CHARS, MAX_LAYERS_PER_TYPE, MaterialUnit, MAX_PERSISTABLE_CELL_COUNT } from './types';
import { assertValidDocument, collectValidationErrors } from './validation';
import { allocateBackstitches, backstitchesFromRecords, backstitchLinesEqual, backstitchStoreBytes, backstitchStoresEqual, cloneBackstitches, copyBackstitch, positionsById, segmentKey } from './backstitch-store';
import { palettesEqual, settingsEqual, typedArraysEqual } from './equality';
import { assertStrictlyIncreasing } from './guards';
import {
  applyLayerStructureCommand,
  assertValidLayeredDocument,
  collectLayeredValidationErrors,
  commandLayerType,
  commandScope,
  FlattenCache,
  findLayer,
  layerSurface,
  requireEditableLayer,
  visibleBackstitchOwners
} from './layers';
import { cloneProgress, coveringLayerId, emptyProgress, type ProgressCommand, type ProgressEntry, type ProgressEntryPart } from './progress';
import { applyCanvasCommand, backstitchWithinCanvas, canvasCellsCommand, canvasFields, canvasResizeCommand, isValidCanvasOrigin, packCanvasMask, unpackCanvasMask, type CanvasRemoval } from './canvas';

export const DEFAULT_HISTORY_LIMIT_BYTES = 64 * 1024 * 1024;
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

function isPaletteMetadataOnlyCommand(command: DomainCommand): boolean {
  if (command.type === 'batch') return command.commands.length > 0 && command.commands.every(isPaletteMetadataOnlyCommand);
  return command.type === 'palette-create' || command.type === 'palette-update' || command.type === 'palette-swap' || command.type === 'palette-deactivate';
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
  if (backstitches !== undefined) next.backstitches = cloneBackstitches(backstitches);
  const completionDelta = delta.backstitchCompletions;
  if (completionDelta !== undefined && completionDelta.ids.length > 0) {
    if (backstitches === undefined) cloneBackstitchCompletionPlane(next);
    const positions = positionsById(next.backstitches);
    for (let position = 0; position < completionDelta.ids.length; position += 1) {
      const backstitchPosition = positions.get(completionDelta.ids[position]);
      if (backstitchPosition !== undefined) next.backstitches.completed[backstitchPosition] = useAfter ? completionDelta.afterCompleted[position] : completionDelta.beforeCompleted[position];
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
    if (store) bytes += backstitchStoreBytes(store.ids.length);
  }
  if (delta.cellCompletions) bytes += delta.cellCompletions.indices.byteLength + delta.cellCompletions.beforeCompleted.byteLength + delta.cellCompletions.afterCompleted.byteLength;
  if (delta.backstitchCompletions) bytes += delta.backstitchCompletions.ids.byteLength + delta.backstitchCompletions.beforeCompleted.byteLength + delta.backstitchCompletions.afterCompleted.byteLength;
  for (const palette of [delta.beforePalette, delta.afterPalette]) if (palette) bytes += JSON.stringify(palette).length * 2;
  for (const settings of [delta.beforeSettings, delta.afterSettings]) if (settings) bytes += JSON.stringify(settings).length * 2;
  return bytes + 32;
}

function snapshotBytes(document: PatternDocument): number {
  const store = document.backstitches;
  return document.kind.byteLength + document.colors.byteLength + document.completed.byteLength + backstitchStoreBytes(store.ids.length) + JSON.stringify(document.catalog).length * 2 + JSON.stringify(document.palette).length * 2 + JSON.stringify(document.settings).length * 2 + 64;
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
    ...(details?.progress === undefined ? {} : { progress: cloneProgress(details.progress) }),
    ...(details?.recalculateMetrics === undefined ? {} : { recalculateMetrics: details.recalculateMetrics }),
    ...(details?.createdBackstitchIds === undefined ? {} : { createdBackstitchIds: details.createdBackstitchIds.slice() }),
    ...(details?.movedBackstitchIds === undefined ? {} : { movedBackstitchIds: details.movedBackstitchIds.slice() })
  };
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
  assertStrictlyIncreasing(value, 'invalid-history-state', label);
  if (value.length > 0 && value[value.length - 1] >= limit) throw new DomainError('invalid-history-state', `${label} contains an illegal index.`);
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
    if (!Array.isArray(catalog.rgb) || catalog.rgb.length !== 3 || catalog.rgb.some((channel) => typeof channel !== 'number' || !Number.isSafeInteger(channel) || channel < 0 || channel > 255)) throw new DomainError('invalid-history-state', `${label}.catalog.rgb is invalid.`);
  }
}

function historyPalette(value: unknown, label: string): asserts value is PaletteEntry[] {
  const entries = historyArray(value, label);
  for (let index = 0; index < entries.length; index += 1) historyPaletteEntry(entries[index], `${label}[${String(index)}]`);
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

function historyStateMismatch(label: string): never {
  throw new DomainError('invalid-history-state', `${label} is incompatible with the supplied current document.`);
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
    ...(delta.beforeBackstitches === undefined ? {} : { beforeBackstitches: cloneBackstitches(delta.beforeBackstitches) }),
    ...(delta.afterBackstitches === undefined ? {} : { afterBackstitches: cloneBackstitches(delta.afterBackstitches) }),
    ...(delta.beforeNextBackstitchId === undefined ? {} : { beforeNextBackstitchId: delta.beforeNextBackstitchId }),
    ...(delta.afterNextBackstitchId === undefined ? {} : { afterNextBackstitchId: delta.afterNextBackstitchId }),
    ...(delta.beforeNextPaletteId === undefined ? {} : { beforeNextPaletteId: delta.beforeNextPaletteId }),
    ...(delta.afterNextPaletteId === undefined ? {} : { afterNextPaletteId: delta.afterNextPaletteId }),
    ...(delta.beforeSettings === undefined ? {} : { beforeSettings: clonePatternSettings(delta.beforeSettings) }),
    ...(delta.afterSettings === undefined ? {} : { afterSettings: clonePatternSettings(delta.afterSettings) })
  };
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
    ...(delta.beforeBackstitches === undefined ? {} : { beforeBackstitches: cloneBackstitches(delta.beforeBackstitches) }),
    ...(delta.afterBackstitches === undefined ? {} : { afterBackstitches: cloneBackstitches(delta.afterBackstitches) }),
    ...(delta.beforeNextBackstitchId === undefined ? {} : { beforeNextBackstitchId: delta.beforeNextBackstitchId }),
    ...(delta.afterNextBackstitchId === undefined ? {} : { afterNextBackstitchId: delta.afterNextBackstitchId }),
    ...(delta.beforeNextPaletteId === undefined ? {} : { beforeNextPaletteId: delta.beforeNextPaletteId }),
    ...(delta.afterNextPaletteId === undefined ? {} : { afterNextPaletteId: delta.afterNextPaletteId }),
    ...(delta.beforeSettings === undefined ? {} : { beforeSettings: clonePatternSettings(delta.beforeSettings) }),
    ...(delta.afterSettings === undefined ? {} : { afterSettings: clonePatternSettings(delta.afterSettings) })
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
  const changedPalette = delta.beforePalette !== undefined && !palettesEqual(delta.beforePalette, delta.afterPalette ?? []);
  const changedBackstitches = delta.beforeBackstitches !== undefined && !backstitchStoresEqual(delta.beforeBackstitches, delta.afterBackstitches as BackstitchStore);
  const changedAllocators = delta.beforeNextBackstitchId !== delta.afterNextBackstitchId || delta.beforeNextPaletteId !== delta.afterNextPaletteId;
  const changedSettings = delta.beforeSettings !== undefined
    && (delta.afterSettings === undefined || !settingsEqual(delta.beforeSettings, delta.afterSettings));
  return changedCells || changedCompletions || changedBackstitchCompletions || changedPalette || changedBackstitches || changedAllocators || changedSettings;
}

function historySumBytes(left: number, right: number, label: string): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) throw new DomainError('invalid-history-state', `${label} byte accounting overflowed.`);
  return total;
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

interface DeltaRun extends SurfaceRun {
  readonly next: PatternDocument;
  readonly entry: DeltaEntry;
}

/** The shared tail of a packed-delta runner: the next revision, its history entry and the fit check. */
function commitDeltaRun(current: PatternDocument, draft: PatternDocument, mutation: MutationInfo, limit: number, missingDelta: { readonly code: string; readonly message: string }): DeltaRun {
  draft.revision = current.revision + 1;
  if (mutation.delta === undefined) throw new DomainError(missingDelta.code, missingDelta.message);
  const entry: DeltaEntry = { kind: 'delta', delta: mutation.delta, bytes: typedDeltaBytes(mutation.delta), progress: cloneProgress(mutation.progress), recalculateMetrics: mutation.recalculateMetrics === true };
  ensureHistoryEntryFits(entry.bytes, limit);
  return { result: result(draft, true, undefined, undefined, mutation), next: draft, entry };
}

/** Applies `command` to `draft` under a tracker, rolling the draft back if it throws. */
function applyWithTracker(draft: PatternDocument, command: DomainCommand): { tracker: MutationTracker; mutation: MutationInfo } {
  const tracker = new MutationTracker();
  try {
    return { tracker, mutation: applyOneToDraft(draft, command, tracker) };
  } catch (error) {
    tracker.rollback(draft);
    throw error;
  }
}

function runSurfaceCommand(current: PatternDocument, command: DomainCommand, limit: number): SurfaceRun {
  if (command.type === 'batch') assertBulkBatchPolicy(command.commands);
  // An atomic command runs standalone or as the only child of a batch.
  const atomic = command.type === 'batch' && command.commands.length === 1 ? command.commands[0] : command;
  switch (atomic.type) {
    case 'bulk-cell': return runBulkCellCommand(current, atomic, limit);
    case 'bulk-recolor': return runBulkRecolorCommand(current, atomic, limit);
    case 'bulk-completion': return runBulkCompletionCommand(current, atomic, limit);
    case 'bulk-backstitch-completion': return runBulkBackstitchCompletionCommand(current, atomic, limit);
    case 'paste-fragment': return runPasteFragmentCommand(current, atomic, limit);
    case 'move-fragment': return runMoveFragmentCommand(current, atomic, limit);
    case 'mixed-erase': return runMixedEraseCommand(current, atomic, limit);
    case 'delete-region': return runDeleteRegionCommand(current, atomic, limit);
    case 'delete-cell-set': return runDeleteCellSetCommand(current, atomic, limit);
    default: break;
  }
  if (isPaletteMetadataOnlyCommand(command)) return runPaletteMetadataCommand(current, command, limit);
  if (commandRequiresSnapshot(command)) return runSnapshotCommand(current, command, limit);

  const draft = cloneDocument(current);
  // Settings are immutable across current command paths. Reuse the object so
  // sparse edits and their undo/redo transitions preserve settings identity.
  draft.settings = current.settings;
  const { tracker, mutation } = applyWithTracker(draft, command);
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
  const { tracker, mutation } = applyWithTracker(draft, command);
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

function runBulkCellCommand(current: PatternDocument, command: BulkCellCommand, limit: number): SurfaceRun {
  const preflight = preflightBulkCellCommand(current, command);
  const estimatedBytes = estimateBulkCellHistoryBytes(preflight.changedIndices.length);
  ensureHistoryEntryFits(estimatedBytes, limit);
  if (preflight.changedIndices.length === 0) {
    return { result: result(current, false, undefined, undefined, noChange({ touchedIndices: preflight.indices, changedIndices: preflight.changedIndices })) };
  }

  // Bulk edits bypass MutationTracker entirely. The draft is the only
  // document mutated, and the packed delta returned by the canonical bulk
  // command is passed directly to history without being rebuilt.
  const draft = cloneDocument(current);
  const mutation = applyBulkCellCommand(draft, command, preflight);
  assertValidDocument(draft);
  return commitDeltaRun(current, draft, mutation, limit, { code: 'invalid-bulk-edit', message: 'A changed bulk edit did not produce a history delta.' });
}

function runBulkRecolorCommand(current: PatternDocument, command: BulkRecolorCommand, limit: number): SurfaceRun {
  const preflight = preflightBulkRecolorCommand(current, command);
  const estimatedBytes = estimateBulkRecolorHistoryBytes(preflight.changedIndices.length);
  ensureHistoryEntryFits(estimatedBytes, limit);
  if (preflight.changedIndices.length === 0) {
    return { result: result(current, false, undefined, undefined, noChange({ touchedIndices: preflight.indices, changedIndices: preflight.changedIndices })) };
  }
  const draft = cloneDocument(current);
  const mutation = applyBulkRecolorCommand(draft, command, preflight);
  assertValidDocument(draft);
  return commitDeltaRun(current, draft, mutation, limit, { code: 'invalid-bulk-recolor', message: 'A changed bulk recolor did not produce a history delta.' });
}

function runBulkCompletionCommand(current: PatternDocument, command: BulkCompletionCommand, limit: number): SurfaceRun {
  const preflight = preflightBulkCompletionCommand(current, command);
  const estimatedBytes = estimateBulkCompletionHistoryBytes(preflight.changedIndices.length);
  ensureHistoryEntryFits(estimatedBytes, limit);
  if (preflight.changedIndices.length === 0) {
    return { result: result(current, false, undefined, undefined, noChange({ touchedIndices: preflight.indices, changedIndices: preflight.changedIndices })) };
  }
  // Invariant: preflight validated every target, and completion apply mutates only this copied dense plane.
  const draft: PatternDocument = { ...current, completed: current.completed.slice() };
  const mutation = applyBulkCompletionCommand(draft, command, preflight);
  return commitDeltaRun(current, draft, mutation, limit, { code: 'invalid-completion-command', message: 'A changed bulk completion did not produce a history delta.' });
}

function runBulkBackstitchCompletionCommand(current: PatternDocument, command: BulkBackstitchCompletionCommand, limit: number): SurfaceRun {
  const preflight = preflightBulkBackstitchCompletionCommand(current, command);
  const estimatedBytes = estimateBulkBackstitchCompletionHistoryBytes(preflight.changedIds.length);
  ensureHistoryEntryFits(estimatedBytes, limit);
  if (preflight.changedIds.length === 0) {
    return { result: result(current, false, undefined, undefined, noChange({ touchedBackstitchIds: preflight.ids, changedBackstitchIds: preflight.changedIds })) };
  }
  const draft = cloneDocument(current);
  const mutation = applyBulkBackstitchCompletionCommand(draft, command, preflight);
  assertValidDocument(draft);
  return commitDeltaRun(current, draft, mutation, limit, { code: 'invalid-completion-command', message: 'A changed bulk backstitch completion did not produce a history delta.' });
}

function runPasteFragmentCommand(current: PatternDocument, command: PasteFragmentCommand, limit: number): SurfaceRun {
  const preflight = preflightPasteFragmentCommand(current, command);
  const estimatedBytes = estimatePasteFragmentHistoryBytes(preflight.changedCellCount, current.backstitches.ids.length, preflight.newBackstitchCount);
  ensureHistoryEntryFits(estimatedBytes, limit);
  if (estimatedBytes === 0) return { result: result(current, false) };

  const draft = cloneDocument(current);
  const mutation = applyPasteFragmentCommand(draft, command, preflight);
  assertValidDocument(draft);
  return commitDeltaRun(current, draft, mutation, limit, { code: 'invalid-fragment', message: 'A changed paste did not produce a history delta.' });
}

function runMoveFragmentCommand(current: PatternDocument, command: MoveFragmentCommand, limit: number): SurfaceRun {
  const preflight = preflightMoveFragmentCommand(current, command, limit);
  const estimatedBytes = estimateMoveFragmentHistoryBytes(
    preflight.changedIndices.length,
    current.backstitches.ids.length,
    preflight.backstitchesChanged ? preflight.movedBackstitchIds.length : 0
  );
  ensureHistoryEntryFits(estimatedBytes, limit);
  if (estimatedBytes === 0) {
    return { result: result(current, false, undefined, undefined, noChange({ changedIndices: preflight.changedIndices, movedBackstitchIds: new Uint32Array(0) })) };
  }
  const draft = cloneDocument(current);
  const mutation = applyMoveFragmentCommand(draft, command, preflight);
  assertValidDocument(draft);
  // A move always changes where stitches sit, so metrics are recalculated.
  return commitDeltaRun(current, draft, { ...mutation, recalculateMetrics: true }, limit, { code: 'invalid-move-fragment', message: 'A changed move did not produce a history delta.' });
}

function runMixedEraseCommand(current: PatternDocument, command: MixedEraseCommand, limit: number): SurfaceRun {
  const preflight = preflightMixedEraseCommand(current, command);
  const estimatedBytes = estimateMixedEraseHistoryBytes(preflight.changedCellCount);
  ensureHistoryEntryFits(estimatedBytes, limit);
  if (estimatedBytes === 0) return { result: result(current, false) };

  const draft = cloneDocument(current);
  const mutation = applyMixedEraseCommand(draft, command, preflight);
  assertValidDocument(draft);
  return commitDeltaRun(current, draft, mutation, limit, { code: 'invalid-mixed-erase', message: 'A changed mixed erase did not produce a history delta.' });
}

function runDeleteRegionCommand(current: PatternDocument, command: DeleteRegionCommand, limit: number): SurfaceRun {
  const preflight = preflightDeleteRegionCommand(current, command);
  const estimatedBytes = estimateDeleteRegionHistoryBytes(
    preflight.changedIndices.length,
    current.backstitches.ids.length,
    preflight.changedBackstitchIds.length
  );
  ensureHistoryEntryFits(estimatedBytes, limit);
  if (estimatedBytes === 0) {
    return { result: result(current, false, undefined, undefined, noChange({ touchedIndices: preflight.touchedIndices, changedIndices: preflight.changedIndices, changedBackstitchIds: preflight.changedBackstitchIds })) };
  }

  const draft = cloneForDelete(current);
  const mutation = applyDeleteRegionCommand(draft, command, preflight);
  return commitDeltaRun(current, draft, mutation, limit, { code: 'invalid-delete-region', message: 'A changed delete-region command did not produce a history delta.' });
}

function runDeleteCellSetCommand(current: PatternDocument, command: DeleteCellSetCommand, limit: number): SurfaceRun {
  const preflight = preflightDeleteCellSetCommand(current, command);
  const estimatedBytes = estimateDeleteCellSetHistoryBytes(
    preflight.changedIndices.length,
    current.backstitches.ids.length,
    preflight.changedBackstitchIds.length
  );
  ensureHistoryEntryFits(estimatedBytes, limit);
  if (estimatedBytes === 0) {
    return { result: result(current, false, undefined, undefined, noChange({ touchedIndices: preflight.touchedIndices, changedIndices: preflight.changedIndices, changedBackstitchIds: preflight.changedBackstitchIds })) };
  }

  const draft = cloneForDelete(current);
  const mutation = applyDeleteCellSetCommand(draft, command, preflight);
  return commitDeltaRun(current, draft, mutation, limit, { code: 'invalid-delete-cell-set', message: 'A changed delete-cell-set command did not produce a history delta.' });
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

// ---------------------------------------------------------------------------
// Layered history

/** Version of the layered `DocumentEditor` history DTO. Version 1 (single surface) is not accepted. */
export const DOCUMENT_EDITOR_HISTORY_VERSION = 2 as const;

/**
 * One layer on one side of a `layers` entry. Content is omitted
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
  /** Stitch progress, one value per cell. Only present with `kind` and `colors`, and absent when no cell is marked. */
  readonly completed?: Uint8Array;
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

/** The canvas a `canvas` entry undoes back to. Absent fields stay absent. */
export interface HistoryCanvasFrameDto {
  readonly width: number;
  readonly height: number;
  readonly originX?: number;
  readonly originY?: number;
  /** The mask packed by `packCanvasMask`: ceil(width * height / 8) bytes, zero padding. Absent for a full rectangle. */
  readonly canvasMaskBits?: Uint8Array;
}

/** Stitch content a canvas edit cleared from one layer, at before-frame cell indices (ascending). */
export interface HistoryCanvasRemovedCellsDto {
  readonly layerId: number;
  readonly indices: Uint32Array;
  readonly kind: Uint8Array;
  readonly colors: Uint16Array;
  /** Stitch progress aligned with `indices`; absent when none of the removed cells was marked. */
  readonly completed?: Uint8Array;
}

/** Backstitches a canvas edit dropped from one layer, with their ascending positions in the before store. */
export interface HistoryCanvasRemovedLinesDto {
  readonly layerId: number;
  readonly positions: Uint32Array;
  readonly backstitches: BackstitchStore;
}

/**
 * A canvas resize or cell edit. Undo rebuilds `before` from the current
 * geometry plus `removal`; redo runs `command` again. Whole planes are never
 * stored.
 */
export interface HistoryCanvasEntryDto {
  readonly kind: 'canvas';
  readonly command: CanvasResizeCommand | CanvasCellsCommand;
  readonly before: HistoryCanvasFrameDto;
  readonly removal: {
    readonly cells: readonly HistoryCanvasRemovedCellsDto[];
    readonly backstitches: readonly HistoryCanvasRemovedLinesDto[];
  };
  readonly bytes: number;
}

/** Several entries recorded as one undo step, oldest first (for example add a layer, then paste into it). */
export interface HistoryGroupEntryDto {
  readonly kind: 'group';
  readonly entries: readonly Exclude<DocumentEditorHistoryEntryDto, HistoryGroupEntryDto>[];
  readonly bytes: number;
}

export type DocumentEditorHistoryEntryDto = HistoryLayerDeltaEntryDto | HistoryLayersEntryDto | HistoryCanvasEntryDto | HistoryGroupEntryDto;

export interface DocumentEditorHistoryDto {
  readonly version: typeof DOCUMENT_EDITOR_HISTORY_VERSION;
  readonly undo: readonly DocumentEditorHistoryEntryDto[];
  readonly redo: readonly DocumentEditorHistoryEntryDto[];
}

interface StitchContent {
  readonly kind: Uint8Array;
  readonly colors: Uint16Array;
  /** Absent when no cell is marked. */
  readonly completed?: Uint8Array;
}

interface SpecialtyContent {
  readonly backstitches: BackstitchStore;
}

/** `'empty'` is an all-zero layer. */
type LayerContent = StitchContent | SpecialtyContent | 'empty';

interface LayerRecord {
  readonly id: number;
  readonly type: LayerType;
  readonly name: string;
  readonly visible: boolean;
  /** Null when the content equals the other side's; it is then taken from the current document. */
  readonly content: LayerContent | null;
}

/**
 * One side of a `layers` entry. Structure and document commands never change
 * the canvas, so a side does not store the origin or mask: restoring keeps the
 * current document's, which are the same on both sides.
 */
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

interface CanvasEntry {
  kind: 'canvas';
  command: CanvasResizeCommand | CanvasCellsCommand;
  before: HistoryCanvasFrameDto;
  removal: {
    cells: readonly HistoryCanvasRemovedCellsDto[];
    backstitches: readonly HistoryCanvasRemovedLinesDto[];
  };
  bytes: number;
}

type LeafHistoryEntry = LayerDeltaEntry | LayersEntry | CanvasEntry;

interface GroupEntry {
  kind: 'group';
  entries: LeafHistoryEntry[];
  bytes: number;
}

type LayeredHistoryEntry = LeafHistoryEntry | GroupEntry;

const EMPTY_KIND = new Uint8Array(0);
const EMPTY_COLORS = new Uint16Array(0);

function layerContent(layer: Layer): StitchContent | SpecialtyContent {
  if (layer.type === LayerType.Specialty) return { backstitches: layer.backstitches };
  return hasNonZero(layer.completed) ? { kind: layer.kind, colors: layer.colors, completed: layer.completed } : { kind: layer.kind, colors: layer.colors };
}

function sameLayerContent(left: Layer, right: Layer): boolean {
  if (left.type === LayerType.Stitch && right.type === LayerType.Stitch) return left.kind === right.kind && left.colors === right.colors && left.completed === right.completed;
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

/**
 * Builds a layer from a record. Marks are made outside document history, so
 * when `current` is the same layer, every stitch or line whose geometry the
 * record leaves unchanged keeps its current progress; the stored progress
 * applies only to geometry the entry restores. Completion records no color,
 * so a recolor alone never moves a mark. Visibility is also set outside
 * history, so `current` keeps its own; only a layer the entry re-creates
 * takes the recorded value.
 */
function buildLayer(record: LayerRecord, content: LayerContent, cellCount: number, current?: Layer): Layer {
  if (record.type === LayerType.Stitch) {
    const cells = content === 'empty' ? { kind: new Uint8Array(cellCount), colors: new Uint16Array(cellCount * 4) } : content as StitchContent;
    const completed = current?.type === LayerType.Stitch && current.kind.length === cellCount
      ? keepCellCompletion(cells.kind, cells.colors, cells.completed, current)
      : cells.completed ?? new Uint8Array(cellCount);
    return { id: record.id, type: LayerType.Stitch, name: record.name, visible: current?.visible ?? record.visible, kind: cells.kind, colors: cells.colors, completed };
  }
  const backstitches = content === 'empty' ? emptyBackstitches() : (content as SpecialtyContent).backstitches;
  return { id: record.id, type: LayerType.Specialty, name: record.name, visible: current?.visible ?? record.visible, backstitches: current?.type === LayerType.Specialty ? keepLineCompletion(backstitches, current.backstitches) : backstitches };
}

/** The progress plane for restored cells: cells with the same kind and occupied slots keep `current`'s progress, the rest take `stored` (zero when absent). */
function keepCellCompletion(kind: Uint8Array, colors: Uint16Array, stored: Uint8Array | undefined, current: StitchLayer): Uint8Array {
  if (current.kind === kind && current.colors === colors) return current.completed;
  const completed = stored === undefined ? new Uint8Array(kind.length) : stored.slice();
  for (let index = 0; index < kind.length; index += 1) {
    const offset = index * 4;
    if (kind[index] === current.kind[index]
      && (colors[offset] === 0) === (current.colors[offset] === 0)
      && (colors[offset + 1] === 0) === (current.colors[offset + 1] === 0)
      && (colors[offset + 2] === 0) === (current.colors[offset + 2] === 0)
      && (colors[offset + 3] === 0) === (current.colors[offset + 3] === 0)) completed[index] = current.completed[index];
  }
  return completed;
}

/** A restored store whose lines that `current` still holds at the same ends keep their current progress. */
function keepLineCompletion(restored: BackstitchStore, current: BackstitchStore): BackstitchStore {
  if (restored === current || current.ids.length === 0 || restored.ids.length === 0) return restored;
  const positionOf = positionsById(current);
  let completed: Uint8Array | undefined;
  for (let index = 0; index < restored.ids.length; index += 1) {
    const position = positionOf.get(restored.ids[index]);
    if (position === undefined || current.completed[position] === restored.completed[index]) continue;
    if (current.x1[position] !== restored.x1[index] || current.y1[position] !== restored.y1[index] || current.x2[position] !== restored.x2[index] || current.y2[position] !== restored.y2[index]) continue;
    completed ??= restored.completed.slice();
    completed[index] = current.completed[position];
  }
  return completed === undefined ? restored : { ...restored, completed };
}

function layerContentBytes(content: LayerContent): number {
  if (content === 'empty') return 0;
  return 'backstitches' in content ? backstitchStoreBytes(content.backstitches.ids.length) : content.kind.byteLength + content.colors.byteLength + (content.completed?.byteLength ?? 0);
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
    case 'canvas': return canvasEntryBytes(entry);
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
    const existing = currentById.get(record.id);
    if (record.content !== null) return buildLayer(record, record.content, cellCount, existing?.type === record.type ? existing : undefined);
    // Unchanged cell planes only fit the same dimensions; an unchanged backstitch store is valid in both.
    if (existing === undefined || existing.type !== record.type || (existing.type === LayerType.Stitch && (current.width !== side.width || current.height !== side.height))) {
      throw new DomainError('invalid-history-state', `History layer ${String(record.id)} is incompatible with the current document.`);
    }
    return buildLayer(record, layerContent(existing), cellCount, existing);
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

// ---------------------------------------------------------------------------
// Canvas entries

function canvasFrame(document: Pick<LayeredDocument, 'width' | 'height' | 'originX' | 'originY' | 'canvasMask'>): HistoryCanvasFrameDto {
  const { canvasMask, ...origin } = canvasFields(document);
  return { width: document.width, height: document.height, ...origin, ...(canvasMask === undefined ? {} : { canvasMaskBits: packCanvasMask(canvasMask) }) };
}

/** The canonical, detached form of a command `applyCanvasCommand` already accepted. */
function canonicalCanvasCommand(command: DomainCommand): CanvasResizeCommand | CanvasCellsCommand {
  if (command.type === 'canvas-resize') return canvasResizeCommand(command.edges);
  if (command.type === 'canvas-cells') return canvasCellsCommand(command.operation, command.rect, command.cells?.slice());
  throw new DomainError('invalid-command', `${command.type} is not a canvas command.`);
}

function canvasEntryBytes(entry: CanvasEntry): number {
  let bytes = 128 + (entry.before.canvasMaskBits?.byteLength ?? 0) + (entry.command.type === 'canvas-cells' ? entry.command.cells?.byteLength ?? 0 : 0);
  for (const cells of entry.removal.cells) bytes += 32 + cells.indices.byteLength + cells.kind.byteLength + cells.colors.byteLength + (cells.completed?.byteLength ?? 0);
  for (const lines of entry.removal.backstitches) bytes += 32 + lines.positions.byteLength + backstitchStoreBytes(lines.backstitches.ids.length);
  return bytes;
}

/** Removed cells as stored: progress is kept only when some removed cell was marked. */
function removedCells(removal: CanvasRemoval): HistoryCanvasRemovedCellsDto[] {
  return removal.cells.map(({ layerId, indices, kind, colors, completed }) => hasNonZero(completed) ? { layerId, indices, kind, colors, completed } : { layerId, indices, kind, colors });
}

/** Removed lines with the positions they held in the before store, so undo restores the store order exactly. */
function removedLines(before: LayeredDocument, removal: CanvasRemoval): HistoryCanvasRemovedLinesDto[] {
  return removal.backstitches.map(({ layerId, records }) => {
    const layer = findLayer(before, layerId);
    if (layer?.type !== LayerType.Specialty) throw new DomainError('invalid-history-state', `Canvas removal names layer ${String(layerId)}, which is not a specialty layer.`);
    const positionOf = positionsById(layer.backstitches);
    const positions = Uint32Array.from(records, (record) => positionOf.get(record.id) ?? -1);
    return { layerId, positions, backstitches: backstitchesFromRecords(records) };
  });
}

function captureCanvasEntry(before: LayeredDocument, command: DomainCommand, removal: CanvasRemoval): CanvasEntry {
  const entry: CanvasEntry = {
    kind: 'canvas',
    command: canonicalCanvasCommand(command),
    before: canvasFrame(before),
    removal: { cells: removedCells(removal), backstitches: removedLines(before, removal) },
    bytes: 0
  };
  entry.bytes = canvasEntryBytes(entry);
  return entry;
}

/** Inserts removed lines back at their before-store positions between the translated survivors. */
function mergeRemovedLines(survivors: BackstitchStore, dx: number, dy: number, removed: HistoryCanvasRemovedLinesDto | undefined): BackstitchStore {
  const removedCount = removed?.positions.length ?? 0;
  const total = survivors.ids.length + removedCount;
  const store = allocateBackstitches(total);
  let survivor = 0;
  let next = 0;
  for (let index = 0; index < total; index += 1) {
    if (removed !== undefined && next < removedCount && removed.positions[next] === index) {
      copyBackstitch(removed.backstitches, next, store, index);
      next += 1;
      continue;
    }
    if (survivor >= survivors.ids.length) throw new DomainError('invalid-history-state', 'Canvas removal positions are out of range.');
    copyBackstitch(survivors, survivor, store, index, { x: dx, y: dy });
    survivor += 1;
  }
  if (next !== removedCount) throw new DomainError('invalid-history-state', 'Canvas removal positions are out of range.');
  return store;
}

/**
 * Undo of a canvas entry: rebuilds the before frame from the current document.
 * Origins place both boxes in the workspace, so the current box sits at
 * `origin - before.origin` in the before frame. Planes are copied over that
 * overlap, removed cells and lines are written back, and the mask and origin
 * are restored. The revision advances by one.
 */
function restoreCanvasFrame(current: LayeredDocument, entry: CanvasEntry): LayeredDocument {
  const before = entry.before;
  const offsetX = (current.originX ?? 0) - (before.originX ?? 0);
  const offsetY = (current.originY ?? 0) - (before.originY ?? 0);
  const cellCount = before.width * before.height;
  const cellsById = new Map(entry.removal.cells.map((cells) => [cells.layerId, cells]));
  const linesById = new Map(entry.removal.backstitches.map((lines) => [lines.layerId, lines]));
  const startX = Math.max(0, -offsetX);
  const endX = Math.min(current.width, before.width - offsetX);
  const layers = current.layers.map((layer): Layer => {
    if (layer.type === LayerType.Specialty) {
      return { ...layer, backstitches: mergeRemovedLines(layer.backstitches, offsetX * 4, offsetY * 4, linesById.get(layer.id)) };
    }
    const kind = new Uint8Array(cellCount);
    const colors = new Uint16Array(cellCount * 4);
    const completed = new Uint8Array(cellCount);
    if (startX < endX) {
      for (let y = Math.max(0, -offsetY); y < Math.min(current.height, before.height - offsetY); y += 1) {
        const from = y * current.width;
        const to = (y + offsetY) * before.width + offsetX;
        kind.set(layer.kind.subarray(from + startX, from + endX), to + startX);
        colors.set(layer.colors.subarray((from + startX) * 4, (from + endX) * 4), (to + startX) * 4);
        completed.set(layer.completed.subarray(from + startX, from + endX), to + startX);
      }
    }
    const removed = cellsById.get(layer.id);
    if (removed !== undefined) {
      removed.indices.forEach((index, position) => {
        kind[index] = removed.kind[position];
        colors.set(removed.colors.subarray(position * 4, position * 4 + 4), index * 4);
        completed[index] = removed.completed?.[position] ?? 0;
      });
    }
    return { ...layer, kind, colors, completed };
  });
  const document: LayeredDocument = { ...current, width: before.width, height: before.height, layers, revision: current.revision + 1 };
  delete document.originX;
  delete document.originY;
  delete document.canvasMask;
  const mask = before.canvasMaskBits === undefined ? {} : { canvasMask: unpackCanvasMask(before.canvasMaskBits, cellCount) };
  return Object.assign(document, canvasFields({ originX: before.originX, originY: before.originY }), mask);
}

/** Redo of a canvas entry: the recorded command runs again on the before frame. */
function replayCanvasEntry(current: LayeredDocument, entry: CanvasEntry): LayeredDocument {
  return { ...applyCanvasCommand(current, entry.command).document, revision: current.revision + 1 };
}

function canvasEntryToDto(entry: CanvasEntry): HistoryCanvasEntryDto {
  return {
    kind: 'canvas',
    command: canonicalCanvasCommand(entry.command),
    before: { ...entry.before, ...(entry.before.canvasMaskBits === undefined ? {} : { canvasMaskBits: entry.before.canvasMaskBits.slice() }) },
    removal: {
      cells: entry.removal.cells.map((cells) => ({
        layerId: cells.layerId,
        indices: cells.indices.slice(),
        kind: cells.kind.slice(),
        colors: cells.colors.slice(),
        ...(cells.completed === undefined ? {} : { completed: cells.completed.slice() })
      })),
      backstitches: entry.removal.backstitches.map((lines) => ({ layerId: lines.layerId, positions: lines.positions.slice(), backstitches: cloneBackstitches(lines.backstitches) }))
    },
    bytes: entry.bytes
  };
}

/** A detached internal entry; the caller recomputes `bytes`. */
function canvasEntryFromDto(dto: HistoryCanvasEntryDto): CanvasEntry {
  return canvasEntryToDto(dto);
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
    nextPaletteId: document.nextPaletteId,
    ...canvasFields(document)
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

function batchChildren(command: DomainCommand): readonly DomainCommand[] | undefined {
  return command.type === 'batch' ? command.commands : undefined;
}

/** Marks go through `applyProgress` and Track's history, so the layered editor refuses completion edits. */
function rejectProgressCommand(command: DomainCommand): void {
  if (command.type === 'batch') command.commands.forEach(rejectProgressCommand);
  else if (command.type === 'bulk-completion' || command.type === 'bulk-backstitch-completion') throw new DomainError('invalid-command', 'Stitch progress cannot be edited in the pattern editor.');
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

/** True for a batch whose children name more than one layer: each child then runs on its own layer. */
function batchSpansLayers(command: DomainCommand): boolean {
  if (batchChildren(command) === undefined) return false;
  const ids = new Set<number>();
  collectLayerIds(command, ids);
  return ids.size > 1;
}

/** True when the command, and every child of a batch, only changes document-wide state. */
function isPureDocumentCommand(command: DomainCommand): boolean {
  const children = batchChildren(command);
  if (children !== undefined) return children.length > 0 && children.every(isPureDocumentCommand);
  return commandScope(command) === 'document';
}

/** Keeps the layer object when a document-wide command left its content unchanged. */
function layerWithSurfaceContent(layer: Layer, surface: PatternDocument): Layer {
  if (layer.type === LayerType.Stitch) {
    if (typedArraysEqual(layer.kind, surface.kind) && typedArraysEqual(layer.colors, surface.colors)) return layer;
    return { ...layer, kind: surface.kind, colors: surface.colors, completed: surface.completed };
  }
  if (backstitchStoresEqual(layer.backstitches, surface.backstitches)) return layer;
  return { ...layer, backstitches: surface.backstitches };
}

/**
 * Runs a document-wide content command (palette merge or delete, settings)
 * over every layer, hidden ones included. Every surface starts from the same
 * state with its own palette copy, so palette and settings change exactly
 * once: they are taken from the last surface. These commands recolor or erase
 * in place, so stitch layers get copies of their planes. Specialty layers keep
 * their shared all-zero cell planes, which these commands never write.
 */
function applyDocumentCommandToLayers(document: LayeredDocument, command: DomainCommand): LayeredDocument {
  const draftFor = (layer: Layer): PatternDocument => {
    const surface = layerSurface(document, layer.id);
    const draft: PatternDocument = { ...surface, palette: surface.palette.slice(), backstitches: cloneBackstitches(surface.backstitches) };
    if (layer.type === LayerType.Stitch) {
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
    palette: palettesEqual(document.palette, last.palette) ? document.palette : last.palette,
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

/** Cells whose kind, colors or progress differ between two composites of the same size. */
function diffCompositeCells(previous: PatternDocument, next: PatternDocument): Uint32Array {
  const changed: number[] = [];
  const { kind, colors, completed } = next;
  for (let index = 0; index < kind.length; index += 1) {
    const offset = index * 4;
    if (kind[index] !== previous.kind[index]
      || completed[index] !== previous.completed[index]
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
  const { type } = command;
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
 * Palette merge and delete, and snapshot-scoped document batches over every
 * layer. The entry keeps both sides of the changed layers.
 */
function planDocumentCommand(document: LayeredDocument, command: DomainCommand): LayeredPlan {
  const applied = applyDocumentCommandToLayers(document, command);
  if (sameLayeredContent(document, applied)) return { result: result(metadataSurface(document), false) };
  const next: LayeredDocument = { ...applied, revision: document.revision + 1 };
  assertChangedLayersValid(document, next);
  return { result: wholeDocumentResult(metadataSurface(next), true), document: next, entry: captureLayersEntry(document, next), rebuild: 'full' };
}

/** A canvas resize or cell edit over every layer, recorded as a `canvas` entry. */
function planCanvasCommand(document: LayeredDocument, command: DomainCommand): LayeredPlan {
  const applied = applyCanvasCommand(document, command);
  if (!applied.changed) return { result: result(metadataSurface(document), false) };
  const next: LayeredDocument = { ...applied.document, revision: document.revision + 1 };
  return { result: wholeDocumentResult(metadataSurface(next), true), document: next, entry: captureCanvasEntry(document, command, applied.removal), rebuild: 'full' };
}

function planSingleCommand(document: LayeredDocument, command: DomainCommand, limit: number, fallbackLayerId?: number): LayeredPlan {
  const scope = commandScope(command);
  if (scope === 'layer' && !batchSpansLayers(command)) return planLayerCommand(document, command, limit, fallbackLayerId);
  if (scope === 'canvas' && batchChildren(command) === undefined) return planCanvasCommand(document, command);
  if (scope === 'structure' && batchChildren(command) === undefined) return planStructureCommand(document, command);
  if (isPureDocumentCommand(command) && !commandRequiresSnapshot(command)) return planMetadataCommand(document, command, limit);
  if (batchChildren(command) === undefined) return planDocumentCommand(document, command);
  return planBatchCommand(document, command, limit);
}

/**
 * Structure, document, mixed and multi-layer batches: children run in order
 * on a working copy and their entries become one undo step. Inside a batch, a layer
 * command without a layerId targets the layer the batch most recently added
 * or duplicated. Canvas commands batch only with other canvas commands, so a
 * canvas reframe never has to compose with layer or document entries. Any
 * failure leaves the document untouched.
 */
function planBatchCommand(document: LayeredDocument, command: DomainCommand, limit: number): LayeredPlan {
  const children = batchChildren(command) ?? [];
  const scopes = children.map(commandScope);
  if (scopes.includes('canvas') && scopes.some((scope) => scope !== 'canvas')) throw new DomainError('invalid-command', 'Canvas edits cannot be batched with other edits.');
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
      const layer = entry.layerId === null ? undefined : findLayer(document, entry.layerId);
      if (entry.layerId !== null && layer === undefined) throw new DomainError('invalid-history-state', `History layer ${String(entry.layerId)} no longer exists.`);
      const surface = layer === undefined ? metadataSurface(document) : layerSurface(document, layer.id);
      const applied = applyDelta(surface, entry.delta, useAfter);
      // A store snapshot predates any marks made since; lines it leaves unchanged keep them.
      const next = layer?.type === LayerType.Specialty && applied.backstitches !== surface.backstitches
        ? { ...applied, backstitches: keepLineCompletion(applied.backstitches, layer.backstitches) }
        : applied;
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
    case 'canvas': {
      const next = useAfter ? replayCanvasEntry(document, entry) : restoreCanvasFrame(document, entry);
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
  if ('backstitches' in record.content) return { ...header, backstitches: cloneBackstitches(record.content.backstitches) };
  const { kind, colors, completed } = record.content;
  return { ...header, kind: kind.slice(), colors: colors.slice(), ...(completed === undefined ? {} : { completed: completed.slice() }) };
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
    case 'canvas': return canvasEntryToDto(entry);
  }
}

function layeredEntryToDto(entry: LayeredHistoryEntry): DocumentEditorHistoryEntryDto {
  return entry.kind === 'group' ? { kind: 'group', entries: entry.entries.map(leafEntryToDto), bytes: entry.bytes } : leafEntryToDto(entry);
}

function historyLayerDto(value: unknown, width: number, height: number, label: string): asserts value is HistoryLayerDto {
  const layer = historyRecord(value, label);
  historyKeys(layer, ['id', 'type', 'name', 'visible'], ['empty', 'kind', 'colors', 'completed', 'backstitches'], label);
  historySafeInteger(layer.id, `${label}.id`, 1);
  if (typeof layer.name !== 'string') throw new DomainError('invalid-history-state', `${label}.name is invalid.`);
  const nameLength = Array.from(layer.name).length;
  if (nameLength < 1 || nameLength > MAX_LAYER_NAME_CHARS) throw new DomainError('invalid-history-state', `${label}.name is invalid.`);
  historyBoolean(layer.visible, `${label}.visible`);
  if (layer.empty !== undefined && (layer.empty !== true || layer.kind !== undefined || layer.colors !== undefined || layer.completed !== undefined || layer.backstitches !== undefined)) throw new DomainError('invalid-history-state', `${label}.empty is invalid.`);
  if (layer.type === LayerType.Stitch) {
    if (layer.backstitches !== undefined) throw new DomainError('invalid-history-state', `${label} is a stitch layer with backstitches.`);
    if ((layer.kind === undefined) !== (layer.colors === undefined)) throw new DomainError('invalid-history-state', `${label} cell planes must be paired.`);
    if (layer.kind !== undefined) {
      historyUint8(layer.kind, `${label}.kind`);
      historyUint16(layer.colors, `${label}.colors`);
      historyLength(layer.kind, width * height, `${label}.kind`);
      historyLength(layer.colors as Uint16Array, width * height * 4, `${label}.colors`);
    }
    if (layer.completed !== undefined) {
      if (layer.kind === undefined) throw new DomainError('invalid-history-state', `${label}.completed requires cell planes.`);
      historyUint8(layer.completed, `${label}.completed`);
      historyLength(layer.completed, width * height, `${label}.completed`);
    }
  } else if (layer.type === LayerType.Specialty) {
    if (layer.kind !== undefined || layer.colors !== undefined || layer.completed !== undefined) throw new DomainError('invalid-history-state', `${label} is a specialty layer with cells.`);
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

function historySignedInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new DomainError('invalid-history-state', `${label} must be a safe integer.`);
  return value;
}

/** The canonical command shapes `canonicalCanvasCommand` produces; values are checked again when the chain replays them. */
function historyCanvasCommand(value: unknown, label: string): void {
  const command = historyRecord(value, label);
  if (command.type === 'canvas-resize') {
    historyKeys(command, ['type', 'edges'], [], label);
    const edges = historyRecord(command.edges, `${label}.edges`);
    historyKeys(edges, ['top', 'right', 'bottom', 'left'], [], `${label}.edges`);
    for (const edge of ['top', 'right', 'bottom', 'left']) historySignedInteger(edges[edge], `${label}.edges.${edge}`);
    return;
  }
  if (command.type !== 'canvas-cells') throw new DomainError('invalid-history-state', `${label}.type is unsupported.`);
  historyKeys(command, ['type', 'operation', 'rect'], ['cells'], label);
  if (command.operation !== 'add' && command.operation !== 'remove') throw new DomainError('invalid-history-state', `${label}.operation is unsupported.`);
  const rect = historyRecord(command.rect, `${label}.rect`);
  historyKeys(rect, ['x', 'y', 'width', 'height'], [], `${label}.rect`);
  historySignedInteger(rect.x, `${label}.rect.x`);
  historySignedInteger(rect.y, `${label}.rect.y`);
  const width = historySafeInteger(rect.width, `${label}.rect.width`, 1);
  const height = historySafeInteger(rect.height, `${label}.rect.height`, 1);
  if (command.cells !== undefined) {
    historyUint8(command.cells, `${label}.cells`);
    historyLength(command.cells, width * height, `${label}.cells`);
  }
}

function historyCanvasEntry(entry: HistoryRecord, label: string): void {
  historyKeys(entry, ['kind', 'command', 'before', 'removal', 'bytes'], [], label);
  historyCanvasCommand(entry.command, `${label}.command`);
  const before = historyRecord(entry.before, `${label}.before`);
  historyKeys(before, ['width', 'height'], ['originX', 'originY', 'canvasMaskBits'], `${label}.before`);
  const width = historySafeInteger(before.width, `${label}.before.width`, 1);
  const height = historySafeInteger(before.height, `${label}.before.height`, 1);
  const cellCount = width * height;
  if (!Number.isSafeInteger(cellCount) || cellCount > MAX_PERSISTABLE_CELL_COUNT) throw new DomainError('invalid-history-state', `${label}.before dimensions are too large.`);
  for (const axis of ['originX', 'originY'] as const) {
    if (before[axis] !== undefined && !isValidCanvasOrigin(before[axis])) throw new DomainError('invalid-history-state', `${label}.before.${axis} must be a 32-bit integer.`);
  }
  if (before.canvasMaskBits !== undefined) {
    const bits = before.canvasMaskBits;
    historyUint8(bits, `${label}.before.canvasMaskBits`);
    historyLength(bits, Math.ceil(cellCount / 8), `${label}.before.canvasMaskBits`);
    if (cellCount % 8 !== 0 && bits[bits.length - 1] >> (cellCount % 8) !== 0) throw new DomainError('invalid-history-state', `${label}.before.canvasMaskBits has nonzero padding.`);
    let active = 0;
    for (const byte of bits) for (let bit = byte; bit !== 0; bit &= bit - 1) active += 1;
    if (active === 0 || active === cellCount) throw new DomainError('invalid-history-state', `${label}.before.canvasMaskBits must hold some but not all cells.`);
  }
  const removal = historyRecord(entry.removal, `${label}.removal`);
  historyKeys(removal, ['cells', 'backstitches'], [], `${label}.removal`);
  const layerIds = new Set<number>();
  historyArray(removal.cells, `${label}.removal.cells`).forEach((value, index) => {
    const cellsLabel = `${label}.removal.cells[${String(index)}]`;
    const cells = historyRecord(value, cellsLabel);
    historyKeys(cells, ['layerId', 'indices', 'kind', 'colors'], ['completed'], cellsLabel);
    const layerId = historySafeInteger(cells.layerId, `${cellsLabel}.layerId`, 1);
    if (layerIds.has(layerId)) throw new DomainError('invalid-history-state', `${cellsLabel}.layerId is duplicated.`);
    layerIds.add(layerId);
    historyStrictIndices(cells.indices, cellCount, `${cellsLabel}.indices`);
    historyUint8(cells.kind, `${cellsLabel}.kind`);
    historyUint16(cells.colors, `${cellsLabel}.colors`);
    historyLength(cells.kind, cells.indices.length, `${cellsLabel}.kind`);
    historyLength(cells.colors, cells.indices.length * 4, `${cellsLabel}.colors`);
    if (cells.completed !== undefined) {
      historyUint8(cells.completed, `${cellsLabel}.completed`);
      historyLength(cells.completed, cells.indices.length, `${cellsLabel}.completed`);
    }
  });
  historyArray(removal.backstitches, `${label}.removal.backstitches`).forEach((value, index) => {
    const linesLabel = `${label}.removal.backstitches[${String(index)}]`;
    const lines = historyRecord(value, linesLabel);
    historyKeys(lines, ['layerId', 'positions', 'backstitches'], [], linesLabel);
    const layerId = historySafeInteger(lines.layerId, `${linesLabel}.layerId`, 1);
    if (layerIds.has(layerId)) throw new DomainError('invalid-history-state', `${linesLabel}.layerId is duplicated.`);
    layerIds.add(layerId);
    historyBackstitches(lines.backstitches, `${linesLabel}.backstitches`);
    historyStrictIndices(lines.positions, UINT32_MAX, `${linesLabel}.positions`);
    historyLength(lines.positions, lines.backstitches.ids.length, `${linesLabel}.positions`);
  });
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
  } else if (entry.kind === 'canvas') {
    historyCanvasEntry(entry, label);
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
  if (layer.type === LayerType.Specialty) return { ...header, content: layer.backstitches === undefined ? null : { backstitches: cloneBackstitches(layer.backstitches) } };
  if (layer.kind === undefined || layer.colors === undefined) return { ...header, content: null };
  return { ...header, content: { kind: layer.kind.slice(), colors: layer.colors.slice(), ...(layer.completed === undefined ? {} : { completed: layer.completed.slice() }) } };
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
    case 'canvas': leaf = canvasEntryFromDto(entry); break;
  }
  leaf.bytes = leafEntryBytes(leaf);
  return leaf;
}

function layeredEntryFromDto(entry: DocumentEditorHistoryEntryDto): LayeredHistoryEntry {
  if (entry.kind !== 'group') return leafEntryFromDto(entry);
  const entries = entry.entries.map(leafEntryFromDto);
  return { kind: 'group', entries, bytes: entries.reduce((total, child) => total + child.bytes, 0) };
}

interface ChainLayerBase {
  readonly id: number;
  name: string;
  visible: boolean;
  /** Palette id to reference count in this layer. */
  colorUse: Map<number, number>;
  /** Backstitch ids on this layer. */
  lineIds: Set<number>;
}

interface ChainStitchLayer extends ChainLayerBase {
  readonly type: typeof LayerType.Stitch;
  /** Exact stitch planes. Planes are copied before validation writes into them. */
  kind: Uint8Array;
  colors: Uint16Array;
  ownsPlanes: boolean;
}

interface ChainSpecialtyLayer extends ChainLayerBase {
  readonly type: typeof LayerType.Specialty;
  backstitches: BackstitchStore;
}

type ChainLayer = ChainStitchLayer | ChainSpecialtyLayer;

/**
 * The state an imported history chain is checked against. Stack, dimensions,
 * palette, settings, allocators and layer content are always exact.
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
  originX?: number;
  originY?: number;
  /** Shared by reference with the documents the chain was built from; never written. */
  canvasMask?: Uint8Array;
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
  return { id: layer.id, type: layer.type, name: layer.name, visible: layer.visible, backstitches: layer.backstitches, colorUse: countColors(layer.backstitches.colors), lineIds: new Set(layer.backstitches.ids) };
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
    backstitchIdLimit: document.nextBackstitchId,
    ...canvasFields(document)
  };
}

/** Validates written cells and their progress as a one-row surface, so the cost follows the number of cells written. */
function assertWrittenCellsValid(state: ChainState, kind: Uint8Array, colors: Uint16Array, completed: Uint8Array | undefined, palette: readonly PaletteEntry[], label: string): void {
  if (kind.length === 0) return;
  const probe: PatternDocument = {
    version: DOCUMENT_SCHEMA_VERSION,
    catalog: state.catalog,
    width: kind.length,
    height: 1,
    kind,
    colors,
    completed: completed ?? new Uint8Array(kind.length),
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
  const mask = state.width === width && state.height === height ? state.canvasMask : undefined;
  for (let index = 0; index < store.ids.length; index += 1) {
    const id = store.ids[index];
    const x1 = store.x1[index];
    const y1 = store.y1[index];
    const x2 = store.x2[index];
    const y2 = store.y2[index];
    if (id === 0 || id >= state.backstitchIdLimit || ids.has(id) || others.some((layer) => layer.lineIds.has(id))) fail();
    if (x1 > width * 4 || x2 > width * 4 || y1 > height * 4 || y2 > height * 4) fail();
    if ((x1 === x2 && y1 === y2) || x1 > x2 || (x1 === x2 && y1 > y2)) fail();
    const key = segmentKey(store, index);
    if (segments.has(key) || !active.has(store.colors[index]) || store.completed[index] > 1) fail();
    if (mask !== undefined && !backstitchWithinCanvas({ width, height, canvasMask: mask }, x1, y1, x2, y2)) fail();
    ids.add(id);
    segments.add(key);
  }
}

/** A whole stitch plane written on a masked canvas must leave its inactive cells empty. */
function assertCellsInCanvas(state: ChainState, kind: Uint8Array, label: string): void {
  const mask = state.canvasMask;
  if (mask === undefined || kind.length !== mask.length) return;
  for (let index = 0; index < kind.length; index += 1) if (mask[index] === 0 && kind[index] !== CellKind.Empty) historyStateMismatch(`${label}.kind`);
}

/** Every color still referenced by content must stay an active palette entry. */
function assertColorsInPalette(layers: readonly ChainLayer[], palette: readonly PaletteEntry[], label: string): void {
  const active = new Set(palette.filter((entry) => entry.active).map((entry) => entry.id));
  for (const layer of layers) {
    for (const [color, count] of layer.colorUse) if (count > 0 && !active.has(color)) historyStateMismatch(`${label}.palette`);
  }
}

/** Checks that `state` is the side an entry applies from: stack, dimensions, palette, settings and content. */
function chainMatchesSide(state: ChainState, side: LayeredSide, label: string): void {
  if (state.width !== side.width || state.height !== side.height || state.layers.length !== side.layers.length) historyStateMismatch(label);
  side.layers.forEach((record, index) => {
    const layer = state.layers[index];
    // Visibility changes outside history, so a recorded flag need not match.
    if (layer.id !== record.id || layer.type !== record.type || layer.name !== record.name) historyStateMismatch(`${label}.layers[${String(index)}]`);
    if (record.content === null) return;
    if (record.content === 'empty') {
      const hasContent = layer.type === LayerType.Stitch ? hasNonZero(layer.kind) : layer.backstitches.ids.length > 0;
      if (hasContent || [...layer.colorUse.values()].some((count) => count > 0)) historyStateMismatch(`${label}.layers[${String(index)}]`);
      return;
    }
    if ('backstitches' in record.content) {
      if (layer.type !== LayerType.Specialty || !backstitchLinesEqual(layer.backstitches, record.content.backstitches)) historyStateMismatch(`${label}.layers[${String(index)}]`);
    } else if (layer.type !== LayerType.Stitch || (!typedArraysEqual(layer.kind, record.content.kind) || !typedArraysEqual(layer.colors, record.content.colors))) {
      historyStateMismatch(`${label}.layers[${String(index)}]`);
    }
  });
  if (side.palette !== null && !palettesEqual(state.palette, side.palette)) historyStateMismatch(`${label}.palette`);
  if (side.settings !== null && !settingsEqual(state.settings, side.settings)) historyStateMismatch(`${label}.settings`);
  // The opposite direction writes this side, so its stored content must be valid too.
  side.layers.forEach((record, index) => {
    if (record.content === null || record.content === 'empty') return;
    const recordLabel = `${label}.layers[${String(index)}]`;
    if ('backstitches' in record.content) assertWrittenLinesValid(state, record.id, record.content.backstitches, side.width, side.height, state.palette, state.layers, recordLabel);
    else {
      assertWrittenCellsValid(state, record.content.kind, record.content.colors, record.content.completed, state.palette, recordLabel);
      assertCellsInCanvas(state, record.content.kind, recordLabel);
    }
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
      const existing = findLayer(state, record.id);
      if (existing === undefined || existing.type !== record.type) historyStateMismatch(recordLabel);
      if (record.type === LayerType.Stitch && (state.width !== side.width || state.height !== side.height)) historyStateMismatch(recordLabel);
      return { ...existing, name: record.name };
    }
    // As in `buildLayer`, a layer that still exists keeps its visibility.
    const kept = state.layers.find((layer) => layer.id === record.id && layer.type === record.type);
    const header = { id: record.id, name: record.name, visible: kept?.visible ?? record.visible };
    if (record.content === 'empty') {
      return record.type === LayerType.Stitch
        ? { ...header, type: LayerType.Stitch, kind: new Uint8Array(cellCount), colors: new Uint16Array(cellCount * 4), ownsPlanes: true, colorUse: new Map(), lineIds: new Set() }
        : { ...header, type: LayerType.Specialty, backstitches: emptyBackstitches(), colorUse: new Map(), lineIds: new Set() };
    }
    if ('backstitches' in record.content) {
      const store = record.content.backstitches;
      return { ...header, type: LayerType.Specialty, backstitches: store, colorUse: countColors(store.colors), lineIds: new Set(store.ids) };
    }
    assertWrittenCellsValid(state, record.content.kind, record.content.colors, record.content.completed, palette, recordLabel);
    assertCellsInCanvas(state, record.content.kind, recordLabel);
    return { ...header, type: LayerType.Stitch, kind: record.content.kind, colors: record.content.colors, ownsPlanes: false, colorUse: countColors(record.content.colors), lineIds: new Set() };
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
  if (fromPalette !== undefined && !palettesEqual(state.palette, fromPalette)) historyStateMismatch(`${label}.palette`);
  if (fromSettings !== undefined && !settingsEqual(state.settings, fromSettings)) historyStateMismatch(`${label}.settings`);
  const palette = toPalette ?? state.palette;
  const from = packedCellsSide(cells, !useAfter);
  const to = packedCellsSide(cells, useAfter);

  if (entry.layerId !== null) {
    const layer = findLayer(state, entry.layerId);
    if (layer === undefined) historyStateMismatch(`${label}.layerId`);
    const cellCount = state.width * state.height;
    for (const index of cells.indices) if (index >= cellCount) historyStateMismatch(`${label}.cells`);
    const fromStore = useAfter ? delta.beforeBackstitches : delta.afterBackstitches;
    const toStore = useAfter ? delta.afterBackstitches : delta.beforeBackstitches;
    const foreign = layer.type === LayerType.Specialty ? cells.indices.length > 0 : (fromStore?.ids.length ?? 0) > 0 || (toStore?.ids.length ?? 0) > 0;
    if (foreign) historyStateMismatch(`${label}.layerId`);

    if (layer.type === LayerType.Stitch && cells.indices.length > 0) {
      // Undo writes one side and redo the other, so both must be valid against the palette in effect there.
      assertWrittenCellsValid(state, from.kind, from.colors, from.completed, state.palette, `${label}.cells`);
      assertWrittenCellsValid(state, to.kind, to.colors, to.completed, palette, `${label}.cells`);
      const mask = state.canvasMask;
      if (mask !== undefined) {
        cells.indices.forEach((index, position) => {
          if (mask[index] === 0 && (from.kind[position] !== CellKind.Empty || to.kind[position] !== CellKind.Empty)) historyStateMismatch(`${label}.cells[${String(position)}]`);
        });
      }
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
      const use = layer.colorUse;
      for (let slot = 0; slot < from.colors.length; slot += 1) {
        if (from.colors[slot] !== 0) use.set(from.colors[slot], (use.get(from.colors[slot]) ?? 0) - 1);
        if (to.colors[slot] !== 0) use.set(to.colors[slot], (use.get(to.colors[slot]) ?? 0) + 1);
      }
    }
    if (layer.type === LayerType.Specialty && fromStore !== undefined && toStore !== undefined) {
      if (!backstitchLinesEqual(layer.backstitches, fromStore)) historyStateMismatch(`${label}.backstitches`);
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

/** The chain state as a layered document, sharing its planes and stores. */
function chainDocument(state: ChainState): LayeredDocument {
  const completed = new Uint8Array(state.width * state.height);
  return {
    version: LAYERED_DOCUMENT_VERSION,
    catalog: state.catalog,
    width: state.width,
    height: state.height,
    layers: state.layers.map((layer): Layer => layer.type === LayerType.Stitch
      ? { id: layer.id, type: layer.type, name: layer.name, visible: layer.visible, kind: layer.kind, colors: layer.colors, completed }
      : { id: layer.id, type: layer.type, name: layer.name, visible: layer.visible, backstitches: layer.backstitches }),
    palette: [...state.palette],
    settings: state.settings,
    revision: 0,
    nextBackstitchId: state.nextBackstitchId,
    nextPaletteId: state.nextPaletteId,
    nextLayerId: state.nextLayerId,
    ...canvasFields(state)
  };
}

function adoptChainDocument(state: ChainState, document: LayeredDocument): void {
  state.width = document.width;
  state.height = document.height;
  state.layers = document.layers.map(chainLayerFromLayer);
  delete state.originX;
  delete state.originY;
  delete state.canvasMask;
  Object.assign(state, canvasFields(document));
}

function sameCanvasFrame(left: HistoryCanvasFrameDto, right: HistoryCanvasFrameDto): boolean {
  return left.width === right.width
    && left.height === right.height
    && (left.originX ?? 0) === (right.originX ?? 0)
    && (left.originY ?? 0) === (right.originY ?? 0)
    && (left.canvasMaskBits === undefined ? right.canvasMaskBits === undefined : right.canvasMaskBits !== undefined && typedArraysEqual(left.canvasMaskBits, right.canvasMaskBits));
}

function sameLayeredGeometry(left: LayeredDocument, right: LayeredDocument): boolean {
  return left.width === right.width
    && left.height === right.height
    && (left.originX ?? 0) === (right.originX ?? 0)
    && (left.originY ?? 0) === (right.originY ?? 0)
    && (left.canvasMask === undefined ? right.canvasMask === undefined : right.canvasMask !== undefined && typedArraysEqual(left.canvasMask, right.canvasMask))
    && left.layers.length === right.layers.length
    && left.layers.every((layer, index) => {
      const other = right.layers[index];
      if (layer.id !== other.id) return false;
      if (layer.type === LayerType.Stitch) return other.type === LayerType.Stitch && typedArraysEqual(layer.kind, other.kind) && typedArraysEqual(layer.colors, other.colors);
      return other.type === LayerType.Specialty && backstitchLinesEqual(layer.backstitches, other.backstitches);
    });
}

/** Compares removed content; progress is ignored because the chain does not track marks, which change outside history. */
function sameCanvasRemoval(left: CanvasEntry['removal'], right: CanvasEntry['removal']): boolean {
  return left.cells.length === right.cells.length
    && left.cells.every((cells, index) => {
      const other = right.cells[index];
      return cells.layerId === other.layerId && typedArraysEqual(cells.indices, other.indices) && typedArraysEqual(cells.kind, other.kind) && typedArraysEqual(cells.colors, other.colors);
    })
    && left.backstitches.length === right.backstitches.length
    && left.backstitches.every((lines, index) => {
      const other = right.backstitches[index];
      return lines.layerId === other.layerId && typedArraysEqual(lines.positions, other.positions) && backstitchLinesEqual(lines.backstitches, other.backstitches);
    });
}

/** Runs the entry's command on `document`, reporting a rejected or unchanged replay as a mismatch. */
function replayCanvasForValidation(document: LayeredDocument, entry: CanvasEntry, label: string): CanvasEntry['removal'] & { document: LayeredDocument } {
  let applied: ReturnType<typeof applyCanvasCommand>;
  try {
    applied = applyCanvasCommand(document, entry.command);
  } catch (error) {
    if (error instanceof DomainError) historyStateMismatch(`${label}.command`);
    throw error;
  }
  if (!applied.changed) historyStateMismatch(`${label}.command`);
  return { document: applied.document, cells: removedCells(applied.removal), backstitches: removedLines(document, applied.removal) };
}

/**
 * Checks a canvas entry by running it. Redo starts from `before`, so the
 * state must match it and the replay must remove exactly the recorded
 * content. Undo rebuilds the before frame the same way `undo` does, checks
 * that it is a valid document, and then requires the command to turn it back
 * into the current state with the same removal.
 */
function stepCanvasForValidation(state: ChainState, entry: CanvasEntry, useAfter: boolean, label: string): void {
  const current = chainDocument(state);
  if (useAfter) {
    if (!sameCanvasFrame(canvasFrame(current), entry.before)) historyStateMismatch(`${label}.before`);
    const replayed = replayCanvasForValidation(current, entry, label);
    if (!sameCanvasRemoval(replayed, entry.removal)) historyStateMismatch(`${label}.removal`);
    adoptChainDocument(state, replayed.document);
    return;
  }
  let before: LayeredDocument;
  try {
    before = restoreCanvasFrame(current, entry);
  } catch (error) {
    if (error instanceof DomainError || error instanceof RangeError) historyStateMismatch(`${label}.removal`);
    throw error;
  }
  if (collectLayeredValidationErrors({ ...before, revision: 0 }).length > 0) historyStateMismatch(`${label}.before`);
  const replayed = replayCanvasForValidation(before, entry, label);
  if (!sameLayeredGeometry(replayed.document, current) || !sameCanvasRemoval(replayed, entry.removal)) historyStateMismatch(label);
  adoptChainDocument(state, before);
}

/**
 * Checks that `entry` applies to `state` from the side it will be applied
 * from and moves the state to the other side (`useAfter` is redo). Every
 * value an entry writes is validated and no unchanged cell plane is reread.
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
    case 'canvas':
      stepCanvasForValidation(state, entry, useAfter, label);
      return;
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

/** One layer's share of a Track mark: composite cells with their masks, or backstitch ids. */
interface ProgressTarget {
  readonly layerId: number;
  readonly cells: Map<number, number>;
  readonly lines: Set<number>;
}

/**
 * Splits a composite-space mark by the layer that supplies each visible cell
 * or line, in stack order. Empty and hidden targets are dropped, and masks
 * for a repeated cell are combined.
 */
function progressTargets(document: LayeredDocument, command: ProgressCommand): ProgressTarget[] {
  const byLayer = new Map<number, ProgressTarget>();
  const targetFor = (layerId: number): ProgressTarget => {
    let target = byLayer.get(layerId);
    if (target === undefined) {
      target = { layerId, cells: new Map(), lines: new Set() };
      byLayer.set(layerId, target);
    }
    return target;
  };
  const cells = command.cells;
  if (cells !== undefined) {
    if (!(cells.indices instanceof Uint32Array) || !(cells.masks instanceof Uint8Array) || cells.masks.length !== cells.indices.length) {
      throw new DomainError('invalid-completion-targets', 'Progress cells need a Uint32Array of indices and one Uint8Array mask per index.');
    }
    const cellCount = document.width * document.height;
    for (let position = 0; position < cells.indices.length; position += 1) {
      const index = cells.indices[position];
      if (index >= cellCount) throw new DomainError('out-of-bounds', `Progress cell index ${String(index)} is out of bounds.`);
      const mask = cells.masks[position];
      if (mask === 0) continue;
      const layerId = coveringLayerId(document, index);
      if (layerId === null) continue;
      const target = targetFor(layerId).cells;
      target.set(index, (target.get(index) ?? 0) | mask);
    }
  }
  const ids = command.backstitchIds;
  if (ids !== undefined) {
    if (!(ids instanceof Uint32Array)) throw new DomainError('invalid-completion-targets', 'Progress backstitch ids must be a Uint32Array.');
    const owners = visibleBackstitchOwners(document);
    for (const id of ids) {
      const layerId = owners.get(id);
      if (layerId !== undefined) targetFor(layerId).lines.add(id);
    }
  }
  return document.layers.flatMap((layer) => byLayer.get(layer.id) ?? []);
}

/** The completion command a target runs on its layer's surface. */
function progressTargetCommand(target: ProgressTarget, operation: ProgressCommand['operation']): DomainCommand {
  if (target.lines.size > 0) return bulkBackstitchCompletionCommand(Uint32Array.from(target.lines).sort(), operation);
  const indices = Uint32Array.from(target.cells.keys()).sort();
  return bulkCompletionCommand(indices, operation, undefined, undefined, Uint8Array.from(indices, (index) => target.cells.get(index) ?? 0));
}

/**
 * Undo/redo over a `LayeredDocument`. Layer-scoped commands (cells,
 * backstitches, fragments, erase, delete) run on the target layer's surface
 * and are stored as sparse deltas tagged with the layer id. Palette and
 * settings metadata are document deltas. Structure commands store only the
 * layers they change; batches group their children's entries into one undo
 * step.
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
    // Visibility is saved with the document but is not an undo step, so a
    // toggle neither adds an entry nor clears redo. Only a top-level toggle
    // skips history; one inside a batch is part of that batch's entry.
    if (command.type === 'layer-set-visibility') {
      this.layered = plan.document;
      return this.publish(plan.result, plan.rebuild);
    }
    this.pushHistory(plan.entry);
    this.layered = plan.document;
    return this.publish(plan.result, plan.rebuild);
  }

  executeBatch(commands: readonly DomainCommand[]): CommandResult {
    return this.execute({ type: 'batch', commands: [...commands] });
  }

  /**
   * Applies a Track mark outside document history. Composite cells and lines
   * are split by the layer that supplies them and marked there with the
   * completion planners. Returns null when nothing changed.
   */
  applyProgress(command: ProgressCommand): { result: CommandResult; entry: ProgressEntry } | null {
    if (command.expectedRevision !== undefined && command.expectedRevision !== this.layered.revision) {
      throw new DomainError('stale-command', `Progress expected revision ${String(command.expectedRevision)} but the document is at revision ${String(this.layered.revision)}.`);
    }
    const revision = this.layered.revision + 1;
    let document = this.layered;
    const parts: ProgressEntryPart[] = [];
    const cellIndices: number[] = [];
    const backstitchIds: number[] = [];
    let marked = 0;
    let unmarked = 0;
    for (const target of progressTargets(document, command)) {
      // Progress never enters document history, so the history byte limit does not apply.
      const run = runSurfaceCommand(layerSurface(document, target.layerId), progressTargetCommand(target, command.operation), Number.MAX_SAFE_INTEGER);
      if (run.next === undefined || run.entry?.kind !== 'delta') continue;
      const { cellCompletions, backstitchCompletions } = run.entry.delta;
      document = commitSurfaceToLayer(document, target.layerId, run.next, revision);
      parts.push({ layerId: target.layerId, ...(cellCompletions === undefined ? {} : { cells: cellCompletions }), ...(backstitchCompletions === undefined ? {} : { backstitches: backstitchCompletions }) });
      cellIndices.push(...run.entry.progress.cellIndices);
      backstitchIds.push(...run.entry.progress.backstitchIds);
      marked += run.entry.progress.marked;
      unmarked += run.entry.progress.unmarked;
    }
    if (parts.length === 0) return null;
    this.layered = document;
    return { result: this.publishProgress({ marked, unmarked, cellIndices: Uint32Array.from(cellIndices).sort(), backstitchIds: Uint32Array.from(backstitchIds).sort() }), entry: { parts } };
  }

  /**
   * Replays a Track mark: `forward` writes its after values (redo), otherwise
   * its before values (undo). Parts whose layer no longer exists are skipped.
   */
  applyProgressEntry(entry: ProgressEntry, forward: boolean): CommandResult {
    const revision = this.layered.revision + 1;
    let document = this.layered;
    const cellIndices: number[] = [];
    const backstitchIds: number[] = [];
    let marked = 0;
    let unmarked = 0;
    for (const part of entry.parts) {
      const layer = findLayer(document, part.layerId);
      if (layer === undefined || (layer.type === LayerType.Stitch ? part.cells === undefined : part.backstitches === undefined)) continue;
      const surface = layerSurface(document, layer.id);
      const delta: SparseMutationDelta = {
        cells: emptyCellDelta(),
        ...(part.cells === undefined ? {} : { cellCompletions: part.cells }),
        ...(part.backstitches === undefined ? {} : { backstitchCompletions: part.backstitches })
      };
      const next = applyDelta(surface, delta, forward);
      const changed = deriveExplicitCompletionProgress(surface, next, part.cells?.indices, part.backstitches?.ids);
      document = commitSurfaceToLayer(document, layer.id, next, revision);
      cellIndices.push(...changed.cellIndices);
      backstitchIds.push(...changed.backstitchIds);
      marked += changed.marked;
      unmarked += changed.unmarked;
    }
    if (document === this.layered) return result(this.composite, false);
    this.layered = document;
    return this.publishProgress({ marked, unmarked, cellIndices: Uint32Array.from(cellIndices).sort(), backstitchIds: Uint32Array.from(backstitchIds).sort() });
  }

  /** An entry whose apply throws stays on its stack. */
  undo(): CommandResult {
    const entry = this.undoStack.at(-1);
    if (!entry) return result(this.composite, false);
    const applied = applyLayeredEntry(this.layered, entry, false);
    this.undoStack.pop();
    this.undoBytes -= entry.bytes;
    this.redoStack.push(entry);
    this.redoBytes += entry.bytes;
    this.layered = applied.document;
    return this.publish(applied.result, applied.rebuild);
  }

  redo(): CommandResult {
    const entry = this.redoStack.at(-1);
    if (!entry) return result(this.composite, false);
    const applied = applyLayeredEntry(this.layered, entry, true);
    this.redoStack.pop();
    this.redoBytes -= entry.bytes;
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
   * both `changedIndices` and `compositeChangedIndices`. A diff carries no
   * backstitch ids, so when the visible lines changed it asks for a full
   * redraw and a metrics rescan: lines can sit outside the changed cells'
   * bounds, which a cell-bounded redraw would leave stale. Falls back to a
   * full rebuild when the size changed.
   */
  private publishDiff(base: CommandResult): CommandResult {
    const previous = this.cache.document;
    const composite = this.cache.full(this.layered);
    if (previous === null || previous.width !== composite.width || previous.height !== composite.height) {
      return { ...base, document: composite, revision: this.layered.revision, requiresFullRedraw: true, recalculateMetrics: true, compositeFull: true };
    }
    const changedIndices = diffCompositeCells(previous, composite);
    const linesChanged = !backstitchStoresEqual(previous.backstitches, composite.backstitches);
    return {
      ...base,
      document: composite,
      revision: this.layered.revision,
      changedIndices,
      compositeChangedIndices: changedIndices.slice(),
      recalculateMetrics: linesChanged,
      ...(linesChanged ? { requiresFullRedraw: true } : {}),
      ...(changedIndices.length === 0 && !linesChanged ? { compositeUnchanged: true } : {})
    };
  }

  /** Publishes a progress-only change: the composite refreshes the marked cells, and backstitches are recomputed as usual. */
  private publishProgress(progress: ProgressChangeSet): CommandResult {
    const base = result(metadataSurface(this.layered), true, undefined, undefined, {
      changed: true,
      snapshot: false,
      changedIndices: progress.cellIndices,
      changedBackstitchIds: progress.backstitchIds,
      progress
    });
    return this.publish(base, progress.cellIndices);
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

export function createEditorFromHistory(document: LayeredDocument, state: unknown, options: HistoryOptions = {}): DocumentEditor {
  const editor = new DocumentEditor(document, options);
  editor.importHistory(state);
  return editor;
}
