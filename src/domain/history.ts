import {
  applyOneToDraft,
  applyBulkCellCommand,
  applyBulkCompletionCommand,
  applyBulkBackstitchCompletionCommand,
  applyPasteFragmentCommand,
  applyMixedEraseCommand,
  applyDeleteRegionCommand,
  assertBulkBatchPolicy,
  commandRequiresSnapshot,
  estimateBulkCellHistoryBytes,
  estimateBulkCompletionHistoryBytes,
  estimateBulkBackstitchCompletionHistoryBytes,
  estimatePasteFragmentHistoryBytes,
  estimateMixedEraseHistoryBytes,
  estimateDeleteRegionHistoryBytes,
  isBatchCommand,
  isBulkCellCommand,
  isBulkCompletionCommand,
  isBulkBackstitchCompletionCommand,
  isPasteFragmentCommand,
  isMixedEraseCommand,
  isDeleteRegionCommand,
  MutationTracker,
  preflightPasteFragmentCommand,
  preflightBulkCellCommand,
  preflightBulkCompletionCommand,
  preflightBulkBackstitchCompletionCommand,
  preflightMixedEraseCommand,
  preflightDeleteRegionCommand,
  type MutationInfo,
  type SparseMutationDelta
} from './commands';
import { cloneDocument, clonePaletteEntry } from './model';
import type {
  CommandResult,
  CropRect,
  DomainCommand,
  HalfDirection,
  PatternDocument,
  Point,
  QuarterCorner,
  ProgressChangeSet
} from './types';
import { DomainError } from './types';
import { assertValidDocument } from './validation';

export const DEFAULT_HISTORY_LIMIT_BYTES = 64 * 1024 * 1024;

export interface HistoryOptions {
  historyLimitBytes?: number;
  maxHistoryBytes?: number;
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

function applyDelta(document: PatternDocument, delta: SparseMutationDelta, useAfter: boolean): PatternDocument {
  const next = cloneDocument(document);
  const cells = delta.cells;
  for (let position = 0; position < cells.indices.length; position += 1) {
    const index = cells.indices[position];
    const colorOffset = position * 4;
    const sourceColors = useAfter ? cells.afterColors : cells.beforeColors;
    const documentOffset = index * 4;
    next.kind[index] = useAfter ? cells.afterKind[position] : cells.beforeKind[position];
    next.completed[index] = useAfter ? cells.afterCompleted[position] : cells.beforeCompleted[position];
    for (let slot = 0; slot < 4; slot += 1) next.colors[documentOffset + slot] = sourceColors[colorOffset + slot];
  }
  const cellCompletionDelta = delta.cellCompletions;
  if (cellCompletionDelta !== undefined) {
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
  if (completionDelta !== undefined) {
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
  return bytes + 32;
}

function snapshotBytes(document: PatternDocument): number {
  const store = document.backstitches;
  return document.kind.byteLength + document.colors.byteLength + document.completed.byteLength + store.ids.byteLength + store.x1.byteLength + store.y1.byteLength + store.x2.byteLength + store.y2.byteLength + store.colors.byteLength + store.completed.byteLength + JSON.stringify(document.palette).length * 2 + 64;
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
    ...(details?.createdBackstitchIds === undefined ? {} : { createdBackstitchIds: details.createdBackstitchIds.slice() })
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

  get lastHistoryEntryKind(): 'delta' | 'snapshot' | null {
    return this.undoStack.length === 0 ? null : this.undoStack[this.undoStack.length - 1].kind;
  }

  execute(command: DomainCommand): CommandResult {
    if (isBulkCellCommand(command)) return this.executeBulkCellCommand(command);
    if (isBulkCompletionCommand(command)) return this.executeBulkCompletionCommand(command);
    if (isBulkBackstitchCompletionCommand(command)) return this.executeBulkBackstitchCompletionCommand(command);
    if (isPasteFragmentCommand(command)) return this.executePasteFragmentCommand(command);
    if (isMixedEraseCommand(command)) return this.executeMixedEraseCommand(command);
    if (isDeleteRegionCommand(command)) return this.executeDeleteRegionCommand(command);
    if (isBatchCommand(command) && Array.isArray(command.commands)) {
      assertBulkBatchPolicy(command.commands as DomainCommand[]);
      if (command.commands.length === 1 && isBulkCellCommand(command.commands[0] as DomainCommand)) {
        return this.executeBulkCellCommand(command.commands[0] as DomainCommand);
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
      if (command.commands.length === 1 && isMixedEraseCommand(command.commands[0] as DomainCommand)) {
        return this.executeMixedEraseCommand(command.commands[0] as DomainCommand);
      }
      if (command.commands.length === 1 && isDeleteRegionCommand(command.commands[0] as DomainCommand)) {
        return this.executeDeleteRegionCommand(command.commands[0] as DomainCommand);
      }
    }
    if (commandRequiresSnapshot(command)) return this.executeSnapshotCommand(command);

    const draft = cloneDocument(this.current);
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
    const draft = cloneDocument(this.current);
    const mutation = applyBulkCompletionCommand(draft, command, preflight);
    draft.revision = this.current.revision + 1;
    assertValidDocument(draft);
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

    const draft = cloneDocument(this.current);
    const mutation = applyDeleteRegionCommand(draft, command, preflight);
    draft.revision = this.current.revision + 1;
    assertValidDocument(draft);
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
    return result(this.current, true, undefined, undefined, mutation);
  }

  private executeSnapshotCommand(command: DomainCommand): CommandResult {
    const before = cloneDocument(this.current);
    const draft = cloneDocument(this.current);
    const mutation: MutationInfo = applyOneToDraft(draft, command);
    if (!mutation.changed) return result(this.current, false);
    draft.revision = this.current.revision + 1;
    assertValidDocument(draft);
    const entry: SnapshotEntry = { kind: 'snapshot', before, after: cloneDocument(draft), bytes: snapshotBytes(draft) + snapshotBytes(before), progress: cloneProgress(mutation.progress), recalculateMetrics: mutation.recalculateMetrics === true };
    ensureHistoryEntryFits(entry.bytes, this.historyLimit);
    this.current = draft;
    this.pushHistory(entry);
    return result(this.current, true, mutation.backstitchId, mutation.paletteId, mutation);
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
    return result(this.current, true, undefined, undefined, { changed: true, snapshot: entry.kind === 'snapshot', progress: reverseProgress(entry.progress), recalculateMetrics: entry.recalculateMetrics });
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
    return result(this.current, true, undefined, undefined, { changed: true, snapshot: entry.kind === 'snapshot', progress: cloneProgress(entry.progress), recalculateMetrics: entry.recalculateMetrics });
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

export function execute(editor: DocumentEditor, command: DomainCommand): CommandResult {
  return editor.execute(command);
}

export function undo(editor: DocumentEditor): CommandResult {
  return editor.undo();
}

export function redo(editor: DocumentEditor): CommandResult {
  return editor.redo();
}
