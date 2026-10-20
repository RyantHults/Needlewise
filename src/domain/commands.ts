import {
  cellIndex,
  cloneDocument,
  colorsOffset,
  defaultPaletteSymbol,
  findPaletteEntry,
  listBackstitches,
  paletteLimit,
  requirePaletteEntry,
  normalizePaletteEntry,
  clonePaletteEntry,
  clonePatternSettings,
  normalizePatternSettings,
  UINT32_MAX,
  isThreeQuarterKind,
  isThreeQuarterPairKind,
  isThreeQuarterSingleKind,
  oppositeQuarterCorner,
  threeQuarterCornerForKind,
  threeQuarterKindForCorner
} from './model';
import {
  ATOMIC_COMMAND_TYPES,
  CellKind,
  type AddBackstitchCommand,
  type AtomicCommand,
  type BulkCellCommand,
  type BulkRecolorCommand,
  type BulkCellEdit,
  type BulkProgressOperation,
  type BulkCompletionCommand,
  type BulkBackstitchCompletionCommand,
  DomainError,
  HalfDirection,
  QuarterCorner,
  PALETTE_ID_MAX,
  FIXED_POINT_UNITS_PER_CELL,
  MAX_PERSISTABLE_CELL_COUNT,
  type BackstitchRecord,
  type BackstitchStore,
  type CommandResult,
  type CropRect,
  type DeleteCellSetCommand,
  type DeleteRegionCommand,
  type DomainCommand,
  type EraseCellCommand,
  type FragmentSelection,
  type MoveBackstitchCommand,
  type MoveFragmentCommand,
  type MixedEraseCommand,
  type PaletteCreateCommand,
  type PaletteDeactivateCommand,
  type PaletteDeleteCommand,
  type PaletteEntryInput,
  type PaletteMergeCommand,
  type PaletteSwapCommand,
  type PaletteUpdateCommand,
  type PatternDocument,
  type PatternSettings,
  type PaletteEntry,
  type PasteFragmentCommand,
  type Point,
  type PatternFragment,
  type ProgressChangeSet,
  type RecolorBackstitchCommand,
  type RecolorCellCommand,
  type RemoveBackstitchCommand,
  type SetFullCommand,
  type SetHalfCommand,
  type SetQuarterCommand,
  type SetThreeQuarterCommand,
  type UpdateBackstitchCommand
} from './types';
import { SYMBOL_IDS } from '../symbols';
import { assertStrictlyIncreasing, requireCommandInteger } from './guards';
import { palettesEqual, settingsEqual, typedArraysEqual } from './equality';
import { allocateBackstitches, backstitchStoreBytes, backstitchStoresEqual, backstitchesFromRecords, cloneBackstitches, copyBackstitch, pointsSegmentKey, positionsById, segmentKey } from './backstitch-store';
import { completedComponentCount, componentSlotMask } from './cell-components';
import { emptyProgress, progressActivity } from './progress';
import { assertValidDocument } from './validation';
import { assertValidPatternFragment, backstitchEndpointsContainedInCellUnion } from './fragment';
import { fixedPointBackstitchLength } from './metrics';
import { backstitchWithinCanvas, isActiveCell } from './canvas';
import {
  attachDeleteMetricsImpactForDelta,
  createDeleteMetricsImpact,
  registerDeleteMetricsImpact,
  type DeleteMetricsImpactEntry
} from './internal-metrics-impact';

export interface MutationInfo {
  changed: boolean;
  snapshot: boolean;
  backstitchId?: number;
  paletteId?: number;
  touchedIndices?: Uint32Array;
  changedIndices?: Uint32Array;
  touchedBackstitchIds?: Uint32Array;
  changedBackstitchIds?: Uint32Array;
  progress?: ProgressChangeSet;
  recalculateMetrics?: boolean;
  /** A packed bulk delta, constructed once and reusable by history callers. */
  delta?: SparseMutationDelta;
  createdBackstitchIds?: Uint32Array;
  movedBackstitchIds?: Uint32Array;
}

export interface PackedCellDelta {
  indices: Uint32Array;
  beforeKind: Uint8Array;
  beforeColors: Uint16Array;
  beforeCompleted: Uint8Array;
  afterKind: Uint8Array;
  afterColors: Uint16Array;
  afterCompleted: Uint8Array;
}

export interface PackedBackstitchCompletionDelta {
  /** Stable backstitch IDs, sorted in command order. */
  ids: Uint32Array;
  beforeCompleted: Uint8Array;
  afterCompleted: Uint8Array;
}

export interface PackedCellCompletionDelta {
  /** Cell indices, sorted in command order. */
  indices: Uint32Array;
  beforeCompleted: Uint8Array;
  afterCompleted: Uint8Array;
}

export interface SparseMutationDelta {
  cells: PackedCellDelta;
  cellCompletions?: PackedCellCompletionDelta;
  backstitchCompletions?: PackedBackstitchCompletionDelta;
  beforePalette?: PaletteEntry[];
  afterPalette?: PaletteEntry[];
  beforeBackstitches?: BackstitchStore;
  afterBackstitches?: BackstitchStore;
  beforeNextBackstitchId?: number;
  afterNextBackstitchId?: number;
  beforeNextPaletteId?: number;
  afterNextPaletteId?: number;
  beforeSettings?: PatternSettings;
  afterSettings?: PatternSettings;
}

interface MutableDeleteMetricsImpactEntry {
  paletteId: number;
  removedFull: number;
  removedHalf: number;
  removedQuarter: number;
  removedThreeQuarter: number;
  removedCellCompleted: number;
  beforeBackstitchCount: number;
  afterBackstitchCount: number;
  beforeBackstitchCompleted: number;
  afterBackstitchCompleted: number;
  beforeBackstitchLengthFixed: number;
  afterBackstitchLengthFixed: number;
}

function emptyDeleteMetricsImpactEntry(paletteId: number): MutableDeleteMetricsImpactEntry {
  return {
    paletteId,
    removedFull: 0,
    removedHalf: 0,
    removedQuarter: 0,
    removedThreeQuarter: 0,
    removedCellCompleted: 0,
    beforeBackstitchCount: 0,
    afterBackstitchCount: 0,
    beforeBackstitchCompleted: 0,
    afterBackstitchCompleted: 0,
    beforeBackstitchLengthFixed: 0,
    afterBackstitchLengthFixed: 0
  };
}

function deleteMetricsEntry(entries: Map<number, MutableDeleteMetricsImpactEntry>, paletteId: number): MutableDeleteMetricsImpactEntry {
  let entry = entries.get(paletteId);
  if (entry === undefined) {
    entry = emptyDeleteMetricsImpactEntry(paletteId);
    entries.set(paletteId, entry);
  }
  return entry;
}

function addDeletedCellComponentImpact(
  entries: Map<number, MutableDeleteMetricsImpactEntry>,
  paletteId: number,
  field: 'removedFull' | 'removedHalf' | 'removedQuarter' | 'removedThreeQuarter',
  completed: boolean,
  amount = 1
): void {
  if (paletteId === 0) return;
  const entry = deleteMetricsEntry(entries, paletteId);
  entry[field] += amount;
  if (completed) entry.removedCellCompleted += amount;
}

function addDeletedCellImpact(
  entries: Map<number, MutableDeleteMetricsImpactEntry>,
  document: PatternDocument,
  index: number
): void {
  const kind = document.kind[index];
  const offset = colorsOffset(index);
  const completion = document.completed[index];
  if (kind === CellKind.Full) {
    addDeletedCellComponentImpact(entries, document.colors[offset], 'removedFull', (completion & 1) !== 0);
  } else if (kind === CellKind.HalfBackslash || kind === CellKind.HalfSlash) {
    addDeletedCellComponentImpact(entries, document.colors[offset], 'removedHalf', (completion & 1) !== 0);
  } else if (kind === CellKind.Quarters || kind === CellKind.ThreeQuarterPair) {
    const field = kind === CellKind.Quarters ? 'removedQuarter' : 'removedThreeQuarter';
    for (let slot = 0; slot < 4; slot += 1) {
      const color = document.colors[offset + slot];
      if (color !== 0) addDeletedCellComponentImpact(entries, color, field, (completion & (1 << slot)) !== 0);
    }
  } else if (kind !== CellKind.Empty) {
    addDeletedCellComponentImpact(entries, document.colors[offset], 'removedThreeQuarter', (completion & 1) !== 0);
  }
}

function addBackstitchImpact(
  entries: Map<number, MutableDeleteMetricsImpactEntry>,
  record: BackstitchRecord,
  side: 'before' | 'after'
): void {
  const entry = deleteMetricsEntry(entries, record.color);
  if (side === 'before') {
    entry.beforeBackstitchCount += 1;
    if (record.completed) entry.beforeBackstitchCompleted += 1;
    entry.beforeBackstitchLengthFixed += fixedPointBackstitchLength(record.x1, record.y1, record.x2, record.y2);
  } else {
    entry.afterBackstitchCount += 1;
    if (record.completed) entry.afterBackstitchCompleted += 1;
    entry.afterBackstitchLengthFixed += fixedPointBackstitchLength(record.x1, record.y1, record.x2, record.y2);
  }
}

function finalizeDeleteMetricsImpact(entries: Map<number, MutableDeleteMetricsImpactEntry>): ReturnType<typeof createDeleteMetricsImpact> {
  return createDeleteMetricsImpact([...entries.values()] as DeleteMetricsImpactEntry[]);
}

/**
 * Captures only targets touched by an ordinary command. It also provides the
 * rollback path used when a later command in an atomic batch rejects.
 */
export class MutationTracker {
  private readonly cells = new Map<number, { kind: number; colors: [number, number, number, number]; completed: number }>();
  private beforeBackstitches: BackstitchStore | undefined;
  private beforePalette: PaletteEntry[] | undefined;
  private beforeNextBackstitchId: number | undefined;
  private beforeNextPaletteId: number | undefined;
  private beforeSettings: PatternSettings | undefined;

  touchCell(document: PatternDocument, index: number): void {
    if (this.cells.has(index)) return;
    const offset = colorsOffset(index);
    this.cells.set(index, {
      kind: document.kind[index],
      colors: [document.colors[offset], document.colors[offset + 1], document.colors[offset + 2], document.colors[offset + 3]],
      completed: document.completed[index]
    });
  }

  touchBackstitches(document: PatternDocument): void {
    if (this.beforeBackstitches !== undefined) return;
    this.beforeBackstitches = cloneBackstitches(document.backstitches);
    this.beforeNextBackstitchId = document.nextBackstitchId;
  }

  touchPalette(document: PatternDocument): void {
    if (this.beforePalette !== undefined) return;
    this.beforePalette = document.palette.map(clonePaletteEntry);
    this.beforeNextPaletteId = document.nextPaletteId;
  }

  touchSettings(document: PatternDocument): void {
    if (this.beforeSettings !== undefined) return;
    this.beforeSettings = clonePatternSettings(document.settings);
  }

  rollback(document: PatternDocument): void {
    for (const [index, before] of this.cells) {
      const offset = colorsOffset(index);
      document.kind[index] = before.kind;
      document.colors[offset] = before.colors[0];
      document.colors[offset + 1] = before.colors[1];
      document.colors[offset + 2] = before.colors[2];
      document.colors[offset + 3] = before.colors[3];
      document.completed[index] = before.completed;
    }
    if (this.beforeBackstitches !== undefined) document.backstitches = cloneBackstitches(this.beforeBackstitches);
    if (this.beforePalette !== undefined) document.palette = this.beforePalette.map(clonePaletteEntry);
    if (this.beforeSettings !== undefined) document.settings = clonePatternSettings(this.beforeSettings);
    if (this.beforeNextBackstitchId !== undefined) document.nextBackstitchId = this.beforeNextBackstitchId;
    if (this.beforeNextPaletteId !== undefined) document.nextPaletteId = this.beforeNextPaletteId;
  }

  toDelta(document: PatternDocument): SparseMutationDelta {
    const changedCells = [...this.cells.entries()].filter(([index, before]) => {
      const offset = colorsOffset(index);
      return before.kind !== document.kind[index] || before.completed !== document.completed[index] || before.colors[0] !== document.colors[offset] || before.colors[1] !== document.colors[offset + 1] || before.colors[2] !== document.colors[offset + 2] || before.colors[3] !== document.colors[offset + 3];
    });
    const indices = new Uint32Array(changedCells.length);
    const beforeKind = new Uint8Array(changedCells.length);
    const beforeColors = new Uint16Array(changedCells.length * 4);
    const beforeCompleted = new Uint8Array(changedCells.length);
    const afterKind = new Uint8Array(changedCells.length);
    const afterColors = new Uint16Array(changedCells.length * 4);
    const afterCompleted = new Uint8Array(changedCells.length);
    changedCells.forEach(([index, before], position) => {
      const beforeOffset = position * 4;
      const afterOffset = colorsOffset(index);
      indices[position] = index;
      beforeKind[position] = before.kind;
      beforeColors[beforeOffset] = before.colors[0];
      beforeColors[beforeOffset + 1] = before.colors[1];
      beforeColors[beforeOffset + 2] = before.colors[2];
      beforeColors[beforeOffset + 3] = before.colors[3];
      beforeCompleted[position] = before.completed;
      afterKind[position] = document.kind[index];
      afterColors[beforeOffset] = document.colors[afterOffset];
      afterColors[beforeOffset + 1] = document.colors[afterOffset + 1];
      afterColors[beforeOffset + 2] = document.colors[afterOffset + 2];
      afterColors[beforeOffset + 3] = document.colors[afterOffset + 3];
      afterCompleted[position] = document.completed[index];
    });
    const delta: SparseMutationDelta = {
      cells: { indices, beforeKind, beforeColors, beforeCompleted, afterKind, afterColors, afterCompleted }
    };
    if (this.beforePalette !== undefined && !palettesEqual(this.beforePalette, document.palette)) {
      delta.beforePalette = this.beforePalette.map(clonePaletteEntry);
      delta.afterPalette = document.palette.map(clonePaletteEntry);
      delta.beforeNextPaletteId = this.beforeNextPaletteId;
      delta.afterNextPaletteId = document.nextPaletteId;
    }
    if (this.beforeBackstitches !== undefined && !backstitchStoresEqual(this.beforeBackstitches, document.backstitches)) {
      delta.beforeBackstitches = cloneBackstitches(this.beforeBackstitches);
      delta.afterBackstitches = cloneBackstitches(document.backstitches);
      delta.beforeNextBackstitchId = this.beforeNextBackstitchId;
      delta.afterNextBackstitchId = document.nextBackstitchId;
    } else if (this.beforeBackstitches !== undefined && this.beforeNextBackstitchId !== document.nextBackstitchId) {
      delta.beforeNextBackstitchId = this.beforeNextBackstitchId;
      delta.afterNextBackstitchId = document.nextBackstitchId;
    }
    if (this.beforeSettings !== undefined && !settingsEqual(this.beforeSettings, document.settings)) {
      delta.beforeSettings = clonePatternSettings(this.beforeSettings);
      delta.afterSettings = clonePatternSettings(document.settings);
    }
    return delta;
  }

  hasChanges(document: PatternDocument): boolean {
    const delta = this.toDelta(document);
    return delta.cells.indices.length > 0 || delta.beforePalette !== undefined || delta.beforeBackstitches !== undefined || delta.beforeNextBackstitchId !== undefined || delta.beforeNextPaletteId !== undefined || delta.beforeSettings !== undefined;
  }
}

/** The targets a command addressed, reported even when it changed nothing. */
export type MutationTargets = Pick<MutationInfo, 'touchedIndices' | 'changedIndices' | 'touchedBackstitchIds' | 'changedBackstitchIds' | 'movedBackstitchIds'>;

export function noChange(targets: MutationTargets = {}): MutationInfo {
  return { changed: false, snapshot: false, ...targets, progress: emptyProgress() };
}

/** A cell delta with no cells, for commands whose delta lives in another part. */
export function emptyCellDelta(): PackedCellDelta {
  return {
    indices: new Uint32Array(0),
    beforeKind: new Uint8Array(0),
    beforeColors: new Uint16Array(0),
    beforeCompleted: new Uint8Array(0),
    afterKind: new Uint8Array(0),
    afterColors: new Uint16Array(0),
    afterCompleted: new Uint8Array(0)
  };
}

function changed(snapshot = false, progress = emptyProgress()): MutationInfo {
  return { changed: true, snapshot, progress, recalculateMetrics: snapshot };
}

function parseBulkProgressOperation(operation: unknown): BulkProgressOperation {
  if (operation === 'set' || operation === 'clear' || operation === 'toggle') return operation;
  throw new DomainError('invalid-completion-operation', `Bulk completion operation ${String(operation)} is not supported.`);
}

function applyProgressOperation(before: number, mask: number, operation: BulkProgressOperation): number {
  if (operation === 'set') return before | mask;
  if (operation === 'clear') return before & ~mask;
  return before ^ mask;
}

export function commandRequiresSnapshot(command: DomainCommand): boolean {
  if (command.type === 'batch') return command.commands.some((child) => child.type === 'document-settings-update' || commandRequiresSnapshot(child));
  return command.type === 'palette-merge' || command.type === 'palette-delete';
}

function touchCommandTargets(document: PatternDocument, command: DomainCommand, tracker: MutationTracker): void {
  switch (command.type) {
    case 'set-full':
    case 'set-half':
    case 'set-quarter':
    case 'set-quarters':
    case 'set-three-quarter':
    case 'erase-cell':
    case 'erase-quarter':
    case 'recolor-cell': {
      const { x, y } = command;
      if (Number.isSafeInteger(x) && Number.isSafeInteger(y) && x >= 0 && y >= 0 && x < document.width && y < document.height) tracker.touchCell(document, cellIndex(document, x, y));
      return;
    }
    case 'add-backstitch':
    case 'remove-backstitch':
    case 'move-backstitch':
    case 'recolor-backstitch':
    case 'update-backstitch':
      tracker.touchBackstitches(document);
      return;
    case 'palette-create':
    case 'palette-update':
    case 'palette-swap':
    case 'palette-deactivate':
      tracker.touchPalette(document);
      return;
    case 'document-settings-update':
      tracker.touchSettings(document);
      return;
    default:
      return;
  }
}

function parseCorner(value: unknown): QuarterCorner {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 3) {
    return value as QuarterCorner;
  }
  throw new DomainError('invalid-corner', `Quarter corner ${String(value)} is invalid.`);
}

function parseDirection(value: unknown): HalfDirection {
  if (value === HalfDirection.Backslash || value === HalfDirection.Slash) return value;
  throw new DomainError('invalid-direction', `Half direction ${String(value)} is invalid.`);
}

function clearCell(document: PatternDocument, index: number): boolean {
  const offset = colorsOffset(index);
  if (document.kind[index] === CellKind.Empty && document.completed[index] === 0 && document.colors[offset] === 0 && document.colors[offset + 1] === 0 && document.colors[offset + 2] === 0 && document.colors[offset + 3] === 0) {
    return false;
  }
  document.kind[index] = CellKind.Empty;
  document.completed[index] = 0;
  document.colors.fill(0, offset, offset + 4);
  return true;
}

function writeFullAtIndex(
  document: PatternDocument,
  index: number,
  color: number,
  halfDirection?: HalfDirection
): boolean {
  if (!isActiveCell(document, index)) return false;
  const desiredKind = halfDirection === undefined
    ? CellKind.Full
    : halfDirection === HalfDirection.Backslash
      ? CellKind.HalfBackslash
      : CellKind.HalfSlash;
  const offset = colorsOffset(index);
  const sameGeometry = document.kind[index] === desiredKind;
  const oldCompletion = document.completed[index] & 1;
  const nextCompletion = sameGeometry ? oldCompletion : 0;
  const isSame = document.kind[index] === desiredKind && document.colors[offset] === color && document.completed[index] === nextCompletion && document.colors[offset + 1] === 0 && document.colors[offset + 2] === 0 && document.colors[offset + 3] === 0;
  if (isSame) return false;
  document.kind[index] = desiredKind;
  document.colors[offset] = color;
  document.colors[offset + 1] = 0;
  document.colors[offset + 2] = 0;
  document.colors[offset + 3] = 0;
  document.completed[index] = nextCompletion;
  return true;
}

function writeFull(
  document: PatternDocument,
  x: number,
  y: number,
  color: number,
  halfDirection?: HalfDirection
): boolean {
  const index = cellIndex(document, x, y);
  requirePaletteEntry(document, color);
  return writeFullAtIndex(document, index, color, halfDirection);
}

function writeQuarterAtIndex(
  document: PatternDocument,
  index: number,
  corner: QuarterCorner,
  color: number
): boolean {
  if (!isActiveCell(document, index)) return false;
  const offset = colorsOffset(index);
  const wasQuarter = document.kind[index] === CellKind.Quarters;
  if (!wasQuarter) {
    document.kind[index] = CellKind.Quarters;
    document.colors.fill(0, offset, offset + 4);
    document.completed[index] = 0;
  }
  const oldColor = document.colors[offset + corner];
  const oldBit = document.completed[index] & (1 << corner);
  const nextBit = wasQuarter && oldColor !== 0 ? oldBit : 0;
  const nextCompletion = (document.completed[index] & ~(1 << corner)) | nextBit;
  if (oldColor === color && document.completed[index] === nextCompletion && document.kind[index] === CellKind.Quarters) return false;
  document.colors[offset + corner] = color;
  document.completed[index] = nextCompletion;
  return true;
}

function writeQuarter(
  document: PatternDocument,
  x: number,
  y: number,
  corner: QuarterCorner,
  color: number
): boolean {
  const index = cellIndex(document, x, y);
  requirePaletteEntry(document, color);
  return writeQuarterAtIndex(document, index, corner, color);
}

function writeThreeQuarterAtIndex(
  document: PatternDocument,
  index: number,
  corner: QuarterCorner,
  color: number
): boolean {
  if (!isActiveCell(document, index)) return false;
  const currentKind = document.kind[index];
  const currentCorner = threeQuarterCornerForKind(currentKind);
  if (isThreeQuarterSingleKind(currentKind)) {
    if (currentCorner === undefined) return false;
    if (corner === currentCorner) return writeThreeQuarterKindAtIndex(document, index, currentKind, color);
    if (corner === oppositeQuarterCorner(currentCorner)) {
      const offset = colorsOffset(index);
      const existingColor = document.colors[offset];
      const existingCompleted = document.completed[index] & 1;
      document.kind[index] = CellKind.ThreeQuarterPair;
      document.colors.fill(0, offset, offset + 4);
      document.colors[offset + currentCorner] = existingColor;
      document.colors[offset + corner] = color;
      document.completed[index] = existingCompleted === 0 ? 0 : 1 << currentCorner;
      return true;
    }
    return false;
  }
  if (isThreeQuarterPairKind(currentKind)) {
    const offset = colorsOffset(index);
    if (document.colors[offset + corner] === 0 || document.colors[offset + corner] === color) return false;
    document.colors[offset + corner] = color;
    return true;
  }
  if (currentKind === CellKind.Full) {
    // A full stitch keeps its color and completion on the corner the new three-quarter leaves uncovered.
    const offset = colorsOffset(index);
    const fullColor = document.colors[offset];
    const fullCompleted = document.completed[index] & 1;
    const opposite = oppositeQuarterCorner(corner);
    document.kind[index] = CellKind.ThreeQuarterPair;
    document.colors.fill(0, offset, offset + 4);
    document.colors[offset + corner] = color;
    document.colors[offset + opposite] = fullColor;
    document.completed[index] = fullCompleted === 0 ? 0 : 1 << opposite;
    return true;
  }
  const desiredKind = threeQuarterKindForCorner(corner);
  return writeThreeQuarterKindAtIndex(document, index, desiredKind, color);
}

function writeThreeQuarterKindAtIndex(
  document: PatternDocument,
  index: number,
  desiredKind: number,
  color: number
): boolean {
  if (!isThreeQuarterSingleKind(desiredKind)) throw new DomainError('invalid-kind', `Cell kind ${String(desiredKind)} is not a single three-quarter kind.`);
  if (!isActiveCell(document, index)) return false;
  const offset = colorsOffset(index);
  const nextCompletion = document.kind[index] === desiredKind ? document.completed[index] & 1 : 0;
  const same = document.kind[index] === desiredKind
    && document.colors[offset] === color
    && document.colors[offset + 1] === 0
    && document.colors[offset + 2] === 0
    && document.colors[offset + 3] === 0
    && document.completed[index] === nextCompletion;
  if (same) return false;
  document.kind[index] = desiredKind;
  document.colors[offset] = color;
  document.colors[offset + 1] = 0;
  document.colors[offset + 2] = 0;
  document.colors[offset + 3] = 0;
  document.completed[index] = nextCompletion;
  return true;
}

function writeThreeQuarterPairAtIndex(document: PatternDocument, index: number, colors: ArrayLike<number>, sourceOffset = 0): boolean {
  if (!isActiveCell(document, index)) return false;
  const color0 = colors[sourceOffset];
  const color1 = colors[sourceOffset + 1];
  const color2 = colors[sourceOffset + 2];
  const color3 = colors[sourceOffset + 3];
  const isNorthwestSoutheast = color0 !== 0 && color2 !== 0 && color1 === 0 && color3 === 0;
  const isNortheastSouthwest = color1 !== 0 && color3 !== 0 && color0 === 0 && color2 === 0;
  if (!isNorthwestSoutheast && !isNortheastSouthwest) throw new DomainError('invalid-kind', 'A three-quarter pair must occupy exactly one opposite corner pair.');
  const offset = colorsOffset(index);
  const sameGeometry = document.kind[index] === CellKind.ThreeQuarterPair;
  let nextCompletion = 0;
  if (sameGeometry) {
    for (let slot = 0; slot < 4; slot += 1) {
      if (colors[sourceOffset + slot] !== 0 && document.colors[offset + slot] !== 0) nextCompletion |= document.completed[index] & (1 << slot);
    }
  }
  const same = document.kind[index] === CellKind.ThreeQuarterPair
    && document.colors[offset] === color0
    && document.colors[offset + 1] === color1
    && document.colors[offset + 2] === color2
    && document.colors[offset + 3] === color3;
  if (same) return false;
  document.kind[index] = CellKind.ThreeQuarterPair;
  document.colors[offset] = color0;
  document.colors[offset + 1] = color1;
  document.colors[offset + 2] = color2;
  document.colors[offset + 3] = color3;
  document.completed[index] = nextCompletion;
  return true;
}

function writeThreeQuarter(
  document: PatternDocument,
  x: number,
  y: number,
  corner: QuarterCorner,
  color: number
): boolean {
  const index = cellIndex(document, x, y);
  requirePaletteEntry(document, color);
  return writeThreeQuarterAtIndex(document, index, corner, color);
}

function removeThreeQuarterAtIndex(document: PatternDocument, index: number, corner: QuarterCorner): boolean {
  const kind = document.kind[index];
  const offset = colorsOffset(index);
  const singleCorner = threeQuarterCornerForKind(kind);
  if (singleCorner !== undefined) {
    if (singleCorner !== corner || document.colors[offset] === 0) return false;
    document.kind[index] = CellKind.Empty;
    document.completed[index] = 0;
    document.colors.fill(0, offset, offset + 4);
    return true;
  }
  if (!isThreeQuarterPairKind(kind) || document.colors[offset + corner] === 0) return false;
  document.colors[offset + corner] = 0;
  document.completed[index] &= ~(1 << corner);
  const survivors = [0, 1, 2, 3].filter((candidate) => document.colors[offset + candidate] !== 0) as QuarterCorner[];
  if (survivors.length === 0) {
    document.kind[index] = CellKind.Empty;
    document.completed[index] = 0;
  } else if (survivors.length === 1) {
    const survivor = survivors[0];
    const survivorColor = document.colors[offset + survivor];
    const survivorCompleted = document.completed[index] & (1 << survivor);
    document.kind[index] = threeQuarterKindForCorner(survivor);
    document.colors.fill(0, offset, offset + 4);
    document.colors[offset] = survivorColor;
    document.completed[index] = survivorCompleted === 0 ? 0 : 1;
  }
  return true;
}

function removeQuarterAtIndex(document: PatternDocument, index: number, corner: QuarterCorner): boolean {
  if (isThreeQuarterKind(document.kind[index]) || isThreeQuarterPairKind(document.kind[index])) return removeThreeQuarterAtIndex(document, index, corner);
  if (document.kind[index] !== CellKind.Quarters) return false;
  const offset = colorsOffset(index);
  if (document.colors[offset + corner] === 0 && (document.completed[index] & (1 << corner)) === 0) return false;
  document.colors[offset + corner] = 0;
  document.completed[index] &= ~(1 << corner);
  if (document.colors[offset] === 0 && document.colors[offset + 1] === 0 && document.colors[offset + 2] === 0 && document.colors[offset + 3] === 0) {
    document.kind[index] = CellKind.Empty;
    document.completed[index] = 0;
  }
  return true;
}

function removeQuarter(document: PatternDocument, x: number, y: number, corner: QuarterCorner): boolean {
  return removeQuarterAtIndex(document, cellIndex(document, x, y), corner);
}

function parseBulkEdit(edit: BulkCellEdit): BulkCellEdit {
  if (typeof edit !== 'object' || edit === null) throw new DomainError('invalid-bulk-intent', 'A bulk cell edit requires a supported intent.');
  switch (edit.kind) {
    case 'full': return { kind: 'full', color: requireCommandInteger(edit.color, 'bulk color') };
    case 'half': return { kind: 'half', direction: parseDirection(edit.direction), color: requireCommandInteger(edit.color, 'bulk color') };
    case 'quarter': return { kind: 'quarter', corner: parseCorner(edit.corner), color: requireCommandInteger(edit.color, 'bulk color') };
    case 'three-quarter': return { kind: 'three-quarter', corner: parseCorner(edit.corner), color: requireCommandInteger(edit.color, 'bulk color') };
    case 'erase-cell': return { kind: 'erase-cell' };
    case 'erase-quarter': return { kind: 'erase-quarter', corner: parseCorner(edit.corner) };
    default: throw new DomainError('invalid-bulk-intent', `Bulk cell intent ${String((edit as { kind: unknown }).kind)} is not supported.`);
  }
}

function validateBulkRevision(document: PatternDocument, command: DomainCommand): void {
  const expectedValue = command.expectedRevision;
  if (expectedValue === undefined) return;
  const expected = requireCommandInteger(expectedValue, 'expected revision');
  if (expected < 0 || expected !== document.revision) {
    throw new DomainError('stale-command', `Bulk cell edit expected revision ${String(expected)} but the document is at revision ${String(document.revision)}.`);
  }
}

function validateExpectedCommandRevision(document: PatternDocument, command: DomainCommand): void {
  const expectedValue = command.expectedRevision;
  if (expectedValue === undefined) return;
  const expected = requireCommandInteger(expectedValue, 'expected revision');
  if (expected < 0 || expected !== document.revision) throw new DomainError('stale-command', `Command expected revision ${String(expected)} but the document is at revision ${String(document.revision)}.`);
}

function validateBulkIndices(document: PatternDocument, indices: Uint32Array): Uint32Array {
  if (!(indices instanceof Uint32Array)) throw new DomainError('invalid-bulk-indices', 'Bulk cell indices must be a Uint32Array.');
  assertStrictlyIncreasing(indices, 'invalid-bulk-indices', 'Bulk cell indices', document.kind.length);
  return indices;
}

function threeQuarterComponentPresent(document: PatternDocument, index: number, corner: QuarterCorner): boolean {
  const offset = colorsOffset(index);
  const singleCorner = threeQuarterCornerForKind(document.kind[index]);
  if (singleCorner !== undefined) return singleCorner === corner && document.colors[offset] !== 0;
  return isThreeQuarterPairKind(document.kind[index]) && document.colors[offset + corner] !== 0;
}

function bulkCellWouldChange(document: PatternDocument, index: number, edit: BulkCellEdit): boolean {
  if (!isActiveCell(document, index)) return false;
  const offset = colorsOffset(index);
  if (edit.kind === 'erase-cell') {
    return document.kind[index] !== CellKind.Empty
      || document.completed[index] !== 0
      || document.colors[offset] !== 0
      || document.colors[offset + 1] !== 0
      || document.colors[offset + 2] !== 0
      || document.colors[offset + 3] !== 0;
  }
  if (edit.kind === 'erase-quarter') {
    return document.kind[index] === CellKind.Quarters
      ? document.colors[offset + edit.corner] !== 0 || (document.completed[index] & (1 << edit.corner)) !== 0
      : threeQuarterComponentPresent(document, index, edit.corner);
  }
  if (edit.kind === 'full' || edit.kind === 'half') {
    const desiredKind = edit.kind === 'full'
      ? CellKind.Full
      : edit.direction === HalfDirection.Backslash ? CellKind.HalfBackslash : CellKind.HalfSlash;
    const nextCompletion = document.kind[index] === desiredKind ? document.completed[index] & 1 : 0;
    return document.kind[index] !== desiredKind
      || document.colors[offset] !== edit.color
      || document.completed[index] !== nextCompletion
      || document.colors[offset + 1] !== 0
      || document.colors[offset + 2] !== 0
      || document.colors[offset + 3] !== 0;
  }
  if (edit.kind === 'three-quarter') {
    const currentKind = document.kind[index];
    const currentCorner = threeQuarterCornerForKind(currentKind);
    if (currentCorner !== undefined) {
      if (edit.corner === currentCorner) return document.colors[offset] !== edit.color;
      return edit.corner === oppositeQuarterCorner(currentCorner);
    }
    if (isThreeQuarterPairKind(currentKind)) return document.colors[offset + edit.corner] !== 0 && document.colors[offset + edit.corner] !== edit.color;
    return true;
  }
  if (document.kind[index] !== CellKind.Quarters) return true;
  const oldColor = document.colors[offset + edit.corner];
  const oldBit = document.completed[index] & (1 << edit.corner);
  const nextBit = oldColor !== 0 ? oldBit : 0;
  const nextCompletion = (document.completed[index] & ~(1 << edit.corner)) | nextBit;
  return oldColor !== edit.color || document.completed[index] !== nextCompletion;
}

export interface BulkCellPreflight {
  readonly edit: BulkCellEdit;
  readonly indices: Uint32Array;
  readonly changedIndices: Uint32Array;
}

/**
 * Validates a bulk command without changing the document. The returned
 * changed-index list is also the exact sparse-history cardinality.
 */
export function preflightBulkCellCommand(document: PatternDocument, command: BulkCellCommand): BulkCellPreflight {
  validateBulkRevision(document, command);
  const edit = parseBulkEdit(command.edit);
  if (edit.kind === 'full' || edit.kind === 'half' || edit.kind === 'quarter' || edit.kind === 'three-quarter') requirePaletteEntry(document, edit.color);
  const indices = validateBulkIndices(document, command.indices);
  let changedCount = 0;
  for (const index of indices) if (bulkCellWouldChange(document, index, edit)) changedCount += 1;
  const changedIndices = new Uint32Array(changedCount);
  let changedPosition = 0;
  for (const index of indices) {
    if (!bulkCellWouldChange(document, index, edit)) continue;
    changedIndices[changedPosition] = index;
    changedPosition += 1;
  }
  return { edit, indices, changedIndices };
}

/** Exact packed cell-only delta size used by the editor's history preflight. */
/** Fixed bytes every history entry costs on top of its deltas. */
const HISTORY_ENTRY_BYTES = 32;
/** Packed bytes per changed cell: index, kind, four colors and completion, before and after. */
const PACKED_CELL_BYTES = 24;
/** Packed bytes per completion change: a 4-byte target and the before and after completion. */
const PACKED_COMPLETION_BYTES = 6;

/** History bytes of a delta of `count` packed records; an empty delta is not stored. */
function packedDeltaBytes(count: number, recordBytes: number): number {
  return count === 0 ? 0 : count * recordBytes + HISTORY_ENTRY_BYTES;
}

/**
 * History bytes of a cell delta plus a backstitch snapshot pair costing
 * `backstitchBytes`; nothing is stored when no cell or backstitch changed.
 */
function cellAndBackstitchDeltaBytes(changedCellCount: number, changedBackstitchCount: number, backstitchBytes: number): number {
  if (changedCellCount === 0 && changedBackstitchCount === 0) return 0;
  return changedCellCount * PACKED_CELL_BYTES + backstitchBytes + HISTORY_ENTRY_BYTES;
}

export function estimateBulkCellHistoryBytes(changedCellCount: number): number {
  return packedDeltaBytes(changedCellCount, PACKED_CELL_BYTES);
}

export interface BulkRecolorPreflight {
  readonly fromColor: number;
  readonly toColor: number;
  readonly indices: Uint32Array;
  readonly masks: Uint8Array;
  readonly changedIndices: Uint32Array;
}

/** Validate a component-aware recolor without changing the document. */
export function preflightBulkRecolorCommand(document: PatternDocument, command: BulkRecolorCommand): BulkRecolorPreflight {
  validateBulkRevision(document, command);
  const fromColor = requireCommandInteger(command.fromColor, 'recolor source color');
  const toColor = requireCommandInteger(command.toColor, 'recolor destination color');
  // Validate both ends before deriving the sparse change set. This keeps a
  // malformed fill result from becoming a history entry with an unknown
  // palette reference.
  requirePaletteEntry(document, fromColor);
  requirePaletteEntry(document, toColor);
  const indices = validateBulkIndices(document, command.indices);
  const rawMasks = command.masks;
  if (!(rawMasks instanceof Uint8Array)) throw new DomainError('invalid-bulk-recolor', 'Bulk recolor masks must be a Uint8Array.');
  if (rawMasks.length !== indices.length) throw new DomainError('invalid-bulk-recolor', 'Bulk recolor masks must align one-to-one with cell indices.');
  const masks = rawMasks.slice();
  for (let position = 0; position < indices.length; position += 1) {
    const index = indices[position];
    const mask = masks[position];
    if (mask === 0) throw new DomainError('invalid-bulk-recolor', `Bulk recolor mask for cell ${String(index)} must be nonzero.`);
    const occupied = componentSlotMask(document.kind[index], document.colors, colorsOffset(index));
    if ((mask & ~occupied) !== 0) throw new DomainError('invalid-bulk-recolor', `Bulk recolor mask for cell ${String(index)} is not a subset of its occupied components.`);
    const offset = colorsOffset(index);
    for (let slot = 0; slot < 4; slot += 1) {
      if ((mask & (1 << slot)) !== 0 && document.colors[offset + slot] !== fromColor) {
        throw new DomainError('stale-command', `Bulk recolor target cell ${String(index)} no longer matches source palette ${String(fromColor)}.`);
      }
    }
  }
  return { fromColor, toColor, indices, masks, changedIndices: fromColor === toColor ? new Uint32Array(0) : indices.slice() };
}

/** Exact packed cell-only delta size used by the editor's recolor preflight. */
export function estimateBulkRecolorHistoryBytes(changedCellCount: number): number {
  return estimateBulkCellHistoryBytes(changedCellCount);
}

function validateProgressIndices(indices: unknown, label: string): Uint32Array {
  if (!(indices instanceof Uint32Array)) throw new DomainError('invalid-completion-targets', `${label} must be a Uint32Array.`);
  assertStrictlyIncreasing(indices, 'invalid-completion-targets', label);
  return indices;
}

function completionMaskForCell(document: PatternDocument, index: number, corner: QuarterCorner | undefined): number {
  const kind = document.kind[index];
  const offset = colorsOffset(index);
  if (kind === CellKind.Empty) throw new DomainError('invalid-completion-target', `Cell ${String(index)} has no occupied geometry.`);
  if (corner !== undefined) {
    if (kind === CellKind.Quarters) {
      if (document.colors[offset + corner] === 0) throw new DomainError('invalid-completion-target', `Cell ${String(index)} has no occupied quarter at corner ${String(corner)}.`);
      return 1 << corner;
    }
    const singleCorner = threeQuarterCornerForKind(kind);
    if (singleCorner !== undefined) {
      if (singleCorner !== corner) throw new DomainError('invalid-completion-target', `Cell ${String(index)} has no three-quarter component at corner ${String(corner)}.`);
      return 1;
    }
    if (isThreeQuarterPairKind(kind) && document.colors[offset + corner] !== 0) return 1 << corner;
    throw new DomainError('invalid-completion-target', `Cell ${String(index)} does not contain quarter geometry at corner ${String(corner)}.`);
  }
  const mask = componentSlotMask(kind, document.colors, offset);
  if (mask === 0) throw new DomainError('invalid-completion-target', `Cell ${String(index)} has no occupied geometry.`);
  return mask;
}

function completionMasksForCommand(document: PatternDocument, command: BulkCompletionCommand, indices: Uint32Array): { corner?: QuarterCorner; masks: Uint8Array } {
  const cornerValue = command.corner;
  const rawMasks = command.masks;
  if (rawMasks !== undefined && cornerValue !== undefined) throw new DomainError('invalid-completion-targets', 'Bulk completion masks cannot be combined with a corner target.');
  if (rawMasks !== undefined) {
    if (!(rawMasks instanceof Uint8Array)) throw new DomainError('invalid-completion-targets', 'Bulk completion masks must be a Uint8Array.');
    if (rawMasks.length !== indices.length) throw new DomainError('invalid-completion-targets', 'Bulk completion masks must align one-to-one with cell indices.');
    const masks = rawMasks.slice();
    for (let position = 0; position < indices.length; position += 1) {
      const mask = masks[position];
      if (mask === 0) continue;
      const occupied = completionMaskForCell(document, indices[position], undefined);
      if ((mask & ~occupied) !== 0) throw new DomainError('invalid-completion-target', `Completion mask for cell ${String(indices[position])} is not a subset of its occupied components.`);
    }
    return { masks };
  }
  const corner = cornerValue === undefined ? undefined : parseCorner(cornerValue);
  const masks = new Uint8Array(indices.length);
  for (let position = 0; position < indices.length; position += 1) masks[position] = completionMaskForCell(document, indices[position], corner);
  return { ...(corner === undefined ? {} : { corner }), masks };
}

/** Reconstruct explicit completion activity from a validated before/after transition. */
export function deriveExplicitCompletionProgress(
  before: PatternDocument,
  after: PatternDocument,
  candidateCellIndices?: Uint32Array,
  candidateBackstitchIds?: Uint32Array
): ProgressChangeSet {
  const cellIndices: number[] = [];
  let marked = 0;
  let unmarked = 0;
  if (candidateCellIndices !== undefined && before.width === after.width && before.height === after.height) {
    const candidates = [...new Set(candidateCellIndices)].sort((left, right) => left - right);
    for (const index of candidates) {
      if (index >= before.kind.length || index >= after.kind.length) continue;
      const progress = progressActivity(completedComponentCount(before, index), completedComponentCount(after, index));
      if (progress.marked > 0 || progress.unmarked > 0) {
        cellIndices.push(index);
        marked += progress.marked;
        unmarked += progress.unmarked;
      }
    }
  }
  const candidates = candidateBackstitchIds === undefined
    ? []
    : [...new Set(candidateBackstitchIds)].sort((left, right) => left - right);
  const backstitchIds: number[] = [];
  const beforePositions = positionsById(before.backstitches);
  const afterPositions = positionsById(after.backstitches);
  for (const id of candidates) {
    const beforePosition = beforePositions.get(id);
    const afterPosition = afterPositions.get(id);
    const progress = progressActivity(
      beforePosition === undefined ? 0 : before.backstitches.completed[beforePosition],
      afterPosition === undefined ? 0 : after.backstitches.completed[afterPosition]
    );
    if (progress.marked > 0 || progress.unmarked > 0) {
      backstitchIds.push(id);
      marked += progress.marked;
      unmarked += progress.unmarked;
    }
  }
  return { cellIndices: new Uint32Array(cellIndices), backstitchIds: new Uint32Array(backstitchIds), marked, unmarked };
}

function progressCountFromMask(mask: number): number {
  let count = 0;
  for (let bit = 1; bit <= 8; bit <<= 1) if ((mask & bit) !== 0) count += 1;
  return count;
}

function progressCountForCellMask(document: PatternDocument, index: number, mask: number): number {
  return progressCountFromMask(mask);
}

export interface BulkCompletionPreflight {
  readonly operation: BulkProgressOperation;
  readonly corner?: QuarterCorner;
  readonly indices: Uint32Array;
  readonly changedIndices: Uint32Array;
  /** Completion masks aligned one-to-one with `changedIndices`. */
  readonly masks: Uint8Array;
}

/** Validates a cell progress command without changing the document. */
export function preflightBulkCompletionCommand(document: PatternDocument, command: BulkCompletionCommand): BulkCompletionPreflight {
  validateBulkRevision(document, command);
  const indices = validateProgressIndices(command.indices, 'Bulk completion indices');
  for (const index of indices) if (index >= document.kind.length) throw new DomainError('out-of-bounds', `Bulk completion cell index ${String(index)} is out of bounds.`);
  const target = completionMasksForCommand(document, command, indices);
  const operation = parseBulkProgressOperation(command.operation);
  const changed = [] as number[];
  const changedMasks = [] as number[];
  for (let position = 0; position < indices.length; position += 1) {
    const index = indices[position];
    const mask = target.masks[position];
    const next = applyProgressOperation(document.completed[index], mask, operation);
    if (next !== document.completed[index]) {
      changed.push(index);
      changedMasks.push(mask);
    }
  }
  return { operation, ...(target.corner === undefined ? {} : { corner: target.corner }), indices, changedIndices: new Uint32Array(changed), masks: new Uint8Array(changedMasks) };
}

/** Exact packed cell-completion delta size used by history preflight. */
export function estimateBulkCompletionHistoryBytes(changedCellCount: number): number {
  return packedDeltaBytes(changedCellCount, PACKED_COMPLETION_BYTES);
}

export interface BulkBackstitchCompletionPreflight {
  readonly operation: BulkProgressOperation;
  readonly ids: Uint32Array;
  readonly changedIds: Uint32Array;
}

/** Validates a backstitch progress command without changing the document. */
export function preflightBulkBackstitchCompletionCommand(document: PatternDocument, command: BulkBackstitchCompletionCommand): BulkBackstitchCompletionPreflight {
  validateBulkRevision(document, command);
  const ids = validateProgressIndices(command.ids, 'Bulk backstitch IDs');
  if (ids.some((id) => id === 0)) throw new DomainError('invalid-completion-targets', 'Backstitch IDs must be positive.');
  const operation = parseBulkProgressOperation(command.operation);
  const changed = [] as number[];
  const positions = positionsById(document.backstitches);
  for (const id of ids) {
    const position = positions.get(id);
    if (position === undefined) throw new DomainError('invalid-completion-target', `Backstitch ID ${String(id)} does not exist.`);
    const next = applyProgressOperation(document.backstitches.completed[position], 1, operation);
    if (next !== document.backstitches.completed[position]) changed.push(id);
  }
  return { operation, ids, changedIds: new Uint32Array(changed) };
}

/** Exact packed backstitch-completion delta size used by history preflight. */
export function estimateBulkBackstitchCompletionHistoryBytes(changedBackstitchCount: number): number {
  return packedDeltaBytes(changedBackstitchCount, PACKED_COMPLETION_BYTES);
}

export function isAtomicCommand(command: DomainCommand): command is AtomicCommand {
  return (ATOMIC_COMMAND_TYPES as readonly string[]).includes(command.type);
}

function containsAtomicCommand(command: DomainCommand): boolean {
  return isAtomicCommand(command) || (command.type === 'batch' && command.commands.some(containsAtomicCommand));
}

/**
 * A bulk command is already a complete atomic gesture. Keeping it out of
 * multi-command batches prevents the packed delta from being silently
 * separated from the other batch mutations.
 */
export function assertBulkBatchPolicy(commands: readonly DomainCommand[]): void {
  const hasBulk = commands.some(containsAtomicCommand);
  const isStandaloneBulk = commands.length === 1 && isAtomicCommand(commands[0]);
  if (hasBulk && !isStandaloneBulk) {
    throw new DomainError('bulk-batch-unsupported', 'Bulk cell, recolor, completion, backstitch completion, paste-fragment, move-fragment, mixed-erase, delete-region, and delete-cell-set commands must be executed as standalone commands, not in a multi-command batch.');
  }
}

export function applyBulkRecolorCommand(document: PatternDocument, command: BulkRecolorCommand, preflight = preflightBulkRecolorCommand(document, command)): MutationInfo {
  if (preflight.changedIndices.length === 0) {
    return noChange({ touchedIndices: preflight.indices, changedIndices: preflight.changedIndices });
  }
  const changedIndices = preflight.changedIndices;
  const beforeKind = new Uint8Array(changedIndices.length);
  const beforeColors = new Uint16Array(changedIndices.length * 4);
  const beforeCompleted = new Uint8Array(changedIndices.length);
  const afterKind = new Uint8Array(changedIndices.length);
  const afterColors = new Uint16Array(changedIndices.length * 4);
  const afterCompleted = new Uint8Array(changedIndices.length);
  for (let position = 0; position < changedIndices.length; position += 1) {
    const index = changedIndices[position];
    const documentOffset = colorsOffset(index);
    const packedOffset = position * 4;
    beforeKind[position] = document.kind[index];
    beforeCompleted[position] = document.completed[index];
    for (let slot = 0; slot < 4; slot += 1) beforeColors[packedOffset + slot] = document.colors[documentOffset + slot];
    const mask = preflight.masks[position];
    for (let slot = 0; slot < 4; slot += 1) {
      if ((mask & (1 << slot)) !== 0) document.colors[documentOffset + slot] = preflight.toColor;
    }
    afterKind[position] = document.kind[index];
    afterCompleted[position] = document.completed[index];
    for (let slot = 0; slot < 4; slot += 1) afterColors[packedOffset + slot] = document.colors[documentOffset + slot];
  }
  return {
    changed: true,
    snapshot: false,
    touchedIndices: preflight.indices,
    changedIndices,
    progress: emptyProgress(),
    delta: {
      cells: { indices: changedIndices, beforeKind, beforeColors, beforeCompleted, afterKind, afterColors, afterCompleted }
    }
  };
}

export function applyBulkCellCommand(document: PatternDocument, command: BulkCellCommand, preflight = preflightBulkCellCommand(document, command)): MutationInfo {
  if (preflight.changedIndices.length === 0) {
    return noChange({ touchedIndices: preflight.indices, changedIndices: preflight.changedIndices });
  }
  const beforeKind = new Uint8Array(preflight.changedIndices.length);
  const beforeColors = new Uint16Array(preflight.changedIndices.length * 4);
  const beforeCompleted = new Uint8Array(preflight.changedIndices.length);
  const afterKind = new Uint8Array(preflight.changedIndices.length);
  const afterColors = new Uint16Array(preflight.changedIndices.length * 4);
  const afterCompleted = new Uint8Array(preflight.changedIndices.length);
  for (let position = 0; position < preflight.changedIndices.length; position += 1) {
    const index = preflight.changedIndices[position];
    const beforeOffset = position * 4;
    const documentOffset = index * 4;
    beforeKind[position] = document.kind[index];
    beforeCompleted[position] = document.completed[index];
    beforeColors[beforeOffset] = document.colors[documentOffset];
    beforeColors[beforeOffset + 1] = document.colors[documentOffset + 1];
    beforeColors[beforeOffset + 2] = document.colors[documentOffset + 2];
    beforeColors[beforeOffset + 3] = document.colors[documentOffset + 3];
    switch (preflight.edit.kind) {
      case 'full': writeFullAtIndex(document, index, preflight.edit.color); break;
      case 'half': writeFullAtIndex(document, index, preflight.edit.color, preflight.edit.direction); break;
      case 'quarter': writeQuarterAtIndex(document, index, preflight.edit.corner, preflight.edit.color); break;
      case 'three-quarter': writeThreeQuarterAtIndex(document, index, preflight.edit.corner, preflight.edit.color); break;
      case 'erase-cell': clearCell(document, index); break;
      case 'erase-quarter': removeQuarterAtIndex(document, index, preflight.edit.corner); break;
    }
    afterKind[position] = document.kind[index];
    afterCompleted[position] = document.completed[index];
    afterColors[beforeOffset] = document.colors[documentOffset];
    afterColors[beforeOffset + 1] = document.colors[documentOffset + 1];
    afterColors[beforeOffset + 2] = document.colors[documentOffset + 2];
    afterColors[beforeOffset + 3] = document.colors[documentOffset + 3];
  }
  const delta: SparseMutationDelta = {
    cells: {
      indices: preflight.changedIndices,
      beforeKind,
      beforeColors,
      beforeCompleted,
      afterKind,
      afterColors,
      afterCompleted
    }
  };
  return {
    changed: true,
    snapshot: false,
    touchedIndices: preflight.indices,
    changedIndices: preflight.changedIndices,
    progress: emptyProgress(),
    delta
  };
}

export function applyBulkCompletionCommand(document: PatternDocument, command: BulkCompletionCommand, preflight = preflightBulkCompletionCommand(document, command)): MutationInfo {
  if (preflight.changedIndices.length === 0) {
    return noChange({ touchedIndices: preflight.indices, changedIndices: preflight.changedIndices });
  }
  const beforeCompleted = new Uint8Array(preflight.changedIndices.length);
  const afterCompleted = new Uint8Array(preflight.changedIndices.length);
  let marked = 0;
  let unmarked = 0;
  for (let position = 0; position < preflight.changedIndices.length; position += 1) {
    const index = preflight.changedIndices[position];
    const mask = preflight.masks[position];
    const beforeCount = progressCountForCellMask(document, index, document.completed[index] & mask);
    beforeCompleted[position] = document.completed[index];
    document.completed[index] = applyProgressOperation(document.completed[index], mask, preflight.operation);
    afterCompleted[position] = document.completed[index];
    const afterCount = progressCountForCellMask(document, index, document.completed[index] & mask);
    const activity = progressActivity(beforeCount, afterCount);
    marked += activity.marked;
    unmarked += activity.unmarked;
  }
  return {
    changed: true,
    snapshot: false,
    touchedIndices: preflight.indices,
    changedIndices: preflight.changedIndices,
    progress: { cellIndices: preflight.changedIndices, backstitchIds: new Uint32Array(0), marked, unmarked },
    delta: {
      cells: emptyCellDelta(),
      cellCompletions: { indices: preflight.changedIndices, beforeCompleted, afterCompleted }
    }
  };
}

export function applyBulkBackstitchCompletionCommand(document: PatternDocument, command: BulkBackstitchCompletionCommand, preflight = preflightBulkBackstitchCompletionCommand(document, command)): MutationInfo {
  if (preflight.changedIds.length === 0) {
    return noChange({ touchedBackstitchIds: preflight.ids, changedBackstitchIds: preflight.changedIds });
  }
  const beforeCompleted = new Uint8Array(preflight.changedIds.length);
  const afterCompleted = new Uint8Array(preflight.changedIds.length);
  let marked = 0;
  let unmarked = 0;
  const positions = positionsById(document.backstitches);
  for (let position = 0; position < preflight.changedIds.length; position += 1) {
    const id = preflight.changedIds[position];
    const backstitchPosition = positions.get(id);
    if (backstitchPosition === undefined) throw new DomainError('invalid-completion-target', `Backstitch ID ${String(id)} no longer exists.`);
    beforeCompleted[position] = document.backstitches.completed[backstitchPosition];
    document.backstitches.completed[backstitchPosition] = applyProgressOperation(beforeCompleted[position], 1, preflight.operation);
    afterCompleted[position] = document.backstitches.completed[backstitchPosition];
    if (beforeCompleted[position] === 0 && afterCompleted[position] !== 0) marked += 1;
    else if (beforeCompleted[position] !== 0 && afterCompleted[position] === 0) unmarked += 1;
  }
  return {
    changed: true,
    snapshot: false,
    touchedBackstitchIds: preflight.ids,
    changedBackstitchIds: preflight.changedIds,
    progress: { cellIndices: new Uint32Array(0), backstitchIds: preflight.changedIds, marked, unmarked },
    delta: {
      cells: emptyCellDelta(),
      backstitchCompletions: { ids: preflight.changedIds, beforeCompleted, afterCompleted }
    }
  };
}

function validateProgressCommandArray(values: Uint32Array, label: string): Uint32Array {
  validateProgressIndices(values, label);
  return values.slice();
}

function validateExpectedRevision(expectedRevision: number | undefined): void {
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw new DomainError('stale-command', 'Expected revision must be a non-negative integer.');
}

export function bulkCompletionCommand(
  indices: Uint32Array,
  operation: BulkProgressOperation,
  corner?: QuarterCorner,
  expectedRevision?: number,
  masks?: Uint8Array
): BulkCompletionCommand {
  const canonicalIndices = validateProgressCommandArray(indices, 'Bulk completion indices');
  validateExpectedRevision(expectedRevision);
  if (masks !== undefined) {
    if (!(masks instanceof Uint8Array)) throw new DomainError('invalid-completion-targets', 'Bulk completion masks must be a Uint8Array.');
    if (masks.length !== canonicalIndices.length) throw new DomainError('invalid-completion-targets', 'Bulk completion masks must align one-to-one with cell indices.');
    if (corner !== undefined) throw new DomainError('invalid-completion-targets', 'Bulk completion masks cannot be combined with a corner target.');
  }
  return {
    type: 'bulk-completion',
    indices: canonicalIndices,
    operation: parseBulkProgressOperation(operation),
    ...(corner === undefined ? {} : { corner: parseCorner(corner) }),
    ...(masks === undefined ? {} : { masks: masks.slice() }),
    ...(expectedRevision === undefined ? {} : { expectedRevision })
  };
}

export const createBulkCompletionCommand = bulkCompletionCommand;

export function bulkBackstitchCompletionCommand(
  ids: Uint32Array,
  operation: BulkProgressOperation,
  expectedRevision?: number
): BulkBackstitchCompletionCommand {
  const canonicalIds = validateProgressCommandArray(ids, 'Bulk backstitch IDs');
  validateExpectedRevision(expectedRevision);
  return {
    type: 'bulk-backstitch-completion',
    ids: canonicalIds,
    operation: parseBulkProgressOperation(operation),
    ...(expectedRevision === undefined ? {} : { expectedRevision })
  };
}

export const createBulkBackstitchCompletionCommand = bulkBackstitchCompletionCommand;

export function bulkCellCommand(indices: Uint32Array, edit: BulkCellEdit, expectedRevision?: number): BulkCellCommand {
  validateExpectedRevision(expectedRevision);
  const canonicalEdit = parseBulkEdit(edit);
  const command: BulkCellCommand = {
    type: 'bulk-cell',
    indices: indices.slice(),
    edit: canonicalEdit,
    ...(expectedRevision === undefined ? {} : { expectedRevision })
  };
  return command;
}

export const createBulkCellCommand = bulkCellCommand;
export const bulkCellEditCommand = bulkCellCommand;
export const bulkCommand = bulkCellCommand;

export function bulkRecolorCommand(indices: Uint32Array, masks: Uint8Array, fromColor: number, toColor: number, expectedRevision?: number): BulkRecolorCommand;
/** Compatibility overload for the former Full-stitch-only caller. */
export function bulkRecolorCommand(indices: Uint32Array, fromColor: number, toColor: number, expectedRevision?: number): BulkRecolorCommand;
export function bulkRecolorCommand(
  indices: Uint32Array,
  masksOrFromColor: Uint8Array | number,
  fromColorOrToColor: number,
  toColorOrRevision?: number,
  expectedRevision?: number
): BulkRecolorCommand {
  if (!(indices instanceof Uint32Array)) throw new DomainError('invalid-bulk-indices', 'Bulk recolor indices must be a Uint32Array.');
  assertStrictlyIncreasing(indices, 'invalid-bulk-indices', 'Bulk recolor indices');
  const componentAware = masksOrFromColor instanceof Uint8Array;
  const masks = componentAware ? masksOrFromColor.slice() : new Uint8Array(indices.length).fill(1);
  if (componentAware && masks.length !== indices.length) throw new DomainError('invalid-bulk-recolor', 'Bulk recolor masks must align one-to-one with cell indices.');
  const fromColor = componentAware ? fromColorOrToColor : masksOrFromColor;
  const toColor = componentAware ? toColorOrRevision as number : fromColorOrToColor;
  const revision = componentAware ? expectedRevision : toColorOrRevision;
  if (!Number.isSafeInteger(fromColor) || !Number.isSafeInteger(toColor)) throw new DomainError('invalid-palette-id', 'Bulk recolor palette IDs must be integers.');
  validateExpectedRevision(revision);
  return {
    type: 'bulk-recolor',
    indices: indices.slice(),
    masks,
    fromColor,
    toColor,
    ...(revision === undefined ? {} : { expectedRevision: revision })
  };
}

export const createBulkRecolorCommand = bulkRecolorCommand;
export const bulkComponentRecolorCommand = bulkRecolorCommand;
export const createBulkComponentRecolorCommand = bulkRecolorCommand;

export function bulkSetFullCommand(indices: Uint32Array, color: number, expectedRevision?: number): BulkCellCommand {
  return bulkCellCommand(indices, { kind: 'full', color }, expectedRevision);
}

export function bulkSetHalfCommand(indices: Uint32Array, direction: HalfDirection, color: number, expectedRevision?: number): BulkCellCommand {
  return bulkCellCommand(indices, { kind: 'half', direction, color }, expectedRevision);
}

export function bulkSetQuarterCommand(indices: Uint32Array, corner: QuarterCorner, color: number, expectedRevision?: number): BulkCellCommand {
  return bulkCellCommand(indices, { kind: 'quarter', corner, color }, expectedRevision);
}

export function bulkSetThreeQuarterCommand(indices: Uint32Array, corner: QuarterCorner, color: number, expectedRevision?: number): BulkCellCommand {
  return bulkCellCommand(indices, { kind: 'three-quarter', corner, color }, expectedRevision);
}

export const bulkSetThreeQuartersCommand = bulkSetThreeQuarterCommand;

export function bulkEraseCellCommand(indices: Uint32Array, expectedRevision?: number): BulkCellCommand {
  return bulkCellCommand(indices, { kind: 'erase-cell' }, expectedRevision);
}

export function bulkEraseQuarterCommand(indices: Uint32Array, corner: QuarterCorner, expectedRevision?: number): BulkCellCommand {
  return bulkCellCommand(indices, { kind: 'erase-quarter', corner }, expectedRevision);
}

export const bulkFullCommand = bulkSetFullCommand;
export const bulkHalfCommand = bulkSetHalfCommand;
export const bulkQuarterCommand = bulkSetQuarterCommand;
export const bulkThreeQuarterCommand = bulkSetThreeQuarterCommand;
export const bulkThreeQuartersCommand = bulkSetThreeQuarterCommand;
export const bulkEraseCommand = bulkEraseCellCommand;

function validateMixedEraseArrays(
  wholeCellIndices: unknown,
  componentCellIndices: unknown,
  componentCorners: unknown,
  expectedRevision?: unknown
): { wholeCellIndices: Uint32Array; componentCellIndices: Uint32Array; componentCorners: Uint8Array } {
  if (!(wholeCellIndices instanceof Uint32Array)) throw new DomainError('invalid-mixed-erase', 'Whole cell targets must be a Uint32Array.');
  if (!(componentCellIndices instanceof Uint32Array)) throw new DomainError('invalid-mixed-erase', 'Component cell targets must be a Uint32Array.');
  if (!(componentCorners instanceof Uint8Array)) throw new DomainError('invalid-mixed-erase', 'Component corners must be a Uint8Array.');
  if (componentCellIndices.length !== componentCorners.length) throw new DomainError('invalid-mixed-erase', 'Component cell and corner arrays must have equal lengths.');
  if (expectedRevision !== undefined && (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw new DomainError('stale-command', 'Expected revision must be a non-negative integer.');
  assertStrictlyIncreasing(wholeCellIndices, 'invalid-mixed-erase', 'Whole cell targets');
  let previousCell = -1;
  let previousCorner = -1;
  for (let position = 0; position < componentCellIndices.length; position += 1) {
    const cell = componentCellIndices[position];
    const corner = componentCorners[position];
    if (cell < previousCell || (cell === previousCell && corner <= previousCorner)) throw new DomainError('invalid-mixed-erase', 'Component targets must be strictly sorted and unique by cell index and corner.');
    if (corner > 3) throw new DomainError('invalid-mixed-erase', `Component corner ${String(corner)} is invalid.`);
    previousCell = cell;
    previousCorner = corner;
  }
  return { wholeCellIndices, componentCellIndices, componentCorners };
}

function validateMixedEraseDocumentTargets(document: PatternDocument, targets: { wholeCellIndices: Uint32Array; componentCellIndices: Uint32Array; componentCorners: Uint8Array }): void {
  for (const index of targets.wholeCellIndices) if (index >= document.kind.length) throw new DomainError('out-of-bounds', `Whole cell index ${String(index)} is out of bounds.`);
  let wholePosition = 0;
  for (const index of targets.componentCellIndices) {
    while (wholePosition < targets.wholeCellIndices.length && targets.wholeCellIndices[wholePosition] < index) wholePosition += 1;
    if (wholePosition < targets.wholeCellIndices.length && targets.wholeCellIndices[wholePosition] === index) throw new DomainError('invalid-mixed-erase', `Cell ${String(index)} cannot be both a whole-cell and component target.`);
    if (index >= document.kind.length) throw new DomainError('out-of-bounds', `Component cell index ${String(index)} is out of bounds.`);
    if (document.kind[index] !== CellKind.Quarters && !isThreeQuarterKind(document.kind[index]) && !isThreeQuarterPairKind(document.kind[index])) throw new DomainError('invalid-mixed-erase', `Component cell index ${String(index)} is not a quarter or three-quarter cell.`);
  }
}

function mixedComponentWouldChange(document: PatternDocument, cell: number, corners: Uint8Array, start: number, end: number): boolean {
  const offset = colorsOffset(cell);
  if (isThreeQuarterKind(document.kind[cell]) || isThreeQuarterPairKind(document.kind[cell])) {
    let kind = document.kind[cell];
    const colors = [document.colors[offset], document.colors[offset + 1], document.colors[offset + 2], document.colors[offset + 3]];
    let completion = document.completed[cell];
    let changed = false;
    for (let position = start; position < end; position += 1) {
      const corner = corners[position] as QuarterCorner;
      const singleCorner = threeQuarterCornerForKind(kind);
      if (singleCorner !== undefined) {
        if (singleCorner !== corner || colors[0] === 0) continue;
        kind = CellKind.Empty;
        colors[0] = 0;
        colors[1] = 0;
        colors[2] = 0;
        colors[3] = 0;
        completion = 0;
        changed = true;
        continue;
      }
      if (!isThreeQuarterPairKind(kind) || colors[corner] === 0) continue;
      colors[corner] = 0;
      completion &= ~(1 << corner);
      const survivors = [0, 1, 2, 3].filter((candidate) => colors[candidate] !== 0) as QuarterCorner[];
      if (survivors.length === 0) {
        kind = CellKind.Empty;
        completion = 0;
      } else if (survivors.length === 1) {
        const survivor = survivors[0];
        const survivorColor = colors[survivor];
        const survivorCompleted = completion & (1 << survivor);
        kind = threeQuarterKindForCorner(survivor);
        colors[0] = survivorColor;
        colors[1] = 0;
        colors[2] = 0;
        colors[3] = 0;
        completion = survivorCompleted === 0 ? 0 : 1;
      }
      changed = true;
    }
    return changed;
  }
  let color0 = document.colors[offset];
  let color1 = document.colors[offset + 1];
  let color2 = document.colors[offset + 2];
  let color3 = document.colors[offset + 3];
  let completion = document.completed[cell];
  for (let position = start; position < end; position += 1) {
    const corner = corners[position];
    if (corner === QuarterCorner.NW) { color0 = 0; completion &= ~1; }
    else if (corner === QuarterCorner.NE) { color1 = 0; completion &= ~2; }
    else if (corner === QuarterCorner.SE) { color2 = 0; completion &= ~4; }
    else { color3 = 0; completion &= ~8; }
  }
  if (color0 === 0 && color1 === 0 && color2 === 0 && color3 === 0) completion = 0;
  return document.kind[cell] !== (color0 === 0 && color1 === 0 && color2 === 0 && color3 === 0 ? CellKind.Empty : CellKind.Quarters)
    || document.colors[offset] !== color0
    || document.colors[offset + 1] !== color1
    || document.colors[offset + 2] !== color2
    || document.colors[offset + 3] !== color3
    || document.completed[cell] !== completion;
}

export interface MixedErasePreflight {
  readonly wholeCellIndices: Uint32Array;
  readonly componentCellIndices: Uint32Array;
  readonly componentCorners: Uint8Array;
  readonly changedCellCount: number;
}

export function preflightMixedEraseCommand(document: PatternDocument, command: MixedEraseCommand): MixedErasePreflight {
  validateBulkRevision(document, command);
  const targets = validateMixedEraseArrays(command.wholeCellIndices, command.componentCellIndices, command.componentCorners, command.expectedRevision);
  validateMixedEraseDocumentTargets(document, targets);
  let changedCellCount = 0;
  for (const index of targets.wholeCellIndices) if (document.kind[index] !== CellKind.Empty || document.completed[index] !== 0 || document.colors[index * 4] !== 0 || document.colors[index * 4 + 1] !== 0 || document.colors[index * 4 + 2] !== 0 || document.colors[index * 4 + 3] !== 0) changedCellCount += 1;
  let position = 0;
  while (position < targets.componentCellIndices.length) {
    const cell = targets.componentCellIndices[position];
    let end = position + 1;
    while (end < targets.componentCellIndices.length && targets.componentCellIndices[end] === cell) end += 1;
    if (mixedComponentWouldChange(document, cell, targets.componentCorners, position, end)) changedCellCount += 1;
    position = end;
  }
  return { ...targets, changedCellCount };
}

export function estimateMixedEraseHistoryBytes(changedCellCount: number): number {
  return estimateBulkCellHistoryBytes(changedCellCount);
}

function applyMixedEraseCell(document: PatternDocument, cell: number, corners: Uint8Array, start: number, end: number): void {
  for (let position = start; position < end; position += 1) removeQuarterAtIndex(document, cell, corners[position] as QuarterCorner);
}

export function applyMixedEraseCommand(document: PatternDocument, command: MixedEraseCommand, preflight = preflightMixedEraseCommand(document, command)): MutationInfo {
  const changedIndices = new Uint32Array(preflight.changedCellCount);
  const beforeKind = new Uint8Array(preflight.changedCellCount);
  const beforeColors = new Uint16Array(preflight.changedCellCount * 4);
  const beforeCompleted = new Uint8Array(preflight.changedCellCount);
  const afterKind = new Uint8Array(preflight.changedCellCount);
  const afterColors = new Uint16Array(preflight.changedCellCount * 4);
  const afterCompleted = new Uint8Array(preflight.changedCellCount);
  let changedPosition = 0;
  let wholePosition = 0;
  let componentPosition = 0;
  const captureAndApply = (cell: number, apply: () => void): void => {
    const offset = colorsOffset(cell);
    changedIndices[changedPosition] = cell;
    beforeKind[changedPosition] = document.kind[cell];
    beforeCompleted[changedPosition] = document.completed[cell];
    beforeColors[changedPosition * 4] = document.colors[offset];
    beforeColors[changedPosition * 4 + 1] = document.colors[offset + 1];
    beforeColors[changedPosition * 4 + 2] = document.colors[offset + 2];
    beforeColors[changedPosition * 4 + 3] = document.colors[offset + 3];
    apply();
    afterKind[changedPosition] = document.kind[cell];
    afterCompleted[changedPosition] = document.completed[cell];
    afterColors[changedPosition * 4] = document.colors[offset];
    afterColors[changedPosition * 4 + 1] = document.colors[offset + 1];
    afterColors[changedPosition * 4 + 2] = document.colors[offset + 2];
    afterColors[changedPosition * 4 + 3] = document.colors[offset + 3];
    changedPosition += 1;
  };
  while (wholePosition < preflight.wholeCellIndices.length || componentPosition < preflight.componentCellIndices.length) {
    const wholeCell = wholePosition < preflight.wholeCellIndices.length ? preflight.wholeCellIndices[wholePosition] : Number.MAX_SAFE_INTEGER;
    const componentCell = componentPosition < preflight.componentCellIndices.length ? preflight.componentCellIndices[componentPosition] : Number.MAX_SAFE_INTEGER;
    if (wholeCell < componentCell) {
      if (document.kind[wholeCell] !== CellKind.Empty || document.completed[wholeCell] !== 0 || document.colors[wholeCell * 4] !== 0 || document.colors[wholeCell * 4 + 1] !== 0 || document.colors[wholeCell * 4 + 2] !== 0 || document.colors[wholeCell * 4 + 3] !== 0) captureAndApply(wholeCell, () => clearCell(document, wholeCell));
      wholePosition += 1;
    } else {
      const cell = componentCell;
      let end = componentPosition + 1;
      while (end < preflight.componentCellIndices.length && preflight.componentCellIndices[end] === cell) end += 1;
      if (mixedComponentWouldChange(document, cell, preflight.componentCorners, componentPosition, end)) captureAndApply(cell, () => applyMixedEraseCell(document, cell, preflight.componentCorners, componentPosition, end));
      componentPosition = end;
    }
  }
  if (changedPosition === 0) return noChange({ changedIndices });
  const delta: SparseMutationDelta = { cells: { indices: changedIndices, beforeKind, beforeColors, beforeCompleted, afterKind, afterColors, afterCompleted } };
  return { changed: true, snapshot: false, changedIndices, progress: emptyProgress(), delta };
}

export function mixedEraseCommand(wholeCellIndices: Uint32Array, componentCellIndices: Uint32Array, componentCorners: Uint8Array, expectedRevision?: number): MixedEraseCommand {
  const targets = validateMixedEraseArrays(wholeCellIndices, componentCellIndices, componentCorners, expectedRevision);
  return { type: 'mixed-erase', wholeCellIndices: targets.wholeCellIndices.slice(), componentCellIndices: targets.componentCellIndices.slice(), componentCorners: targets.componentCorners.slice(), ...(expectedRevision === undefined ? {} : { expectedRevision }) };
}

export const createMixedEraseCommand = mixedEraseCommand;
export const eraseMixedCommand = mixedEraseCommand;

function parseDeleteRegion(command: DeleteRegionCommand): CropRect {
  return {
    x: requireCommandInteger(command.x, 'delete region x'),
    y: requireCommandInteger(command.y, 'delete region y'),
    width: requireCommandInteger(command.width, 'delete region width'),
    height: requireCommandInteger(command.height, 'delete region height')
  };
}

function cellHasGeometry(document: PatternDocument, index: number): boolean {
  const offset = colorsOffset(index);
  return document.kind[index] !== CellKind.Empty
    || document.completed[index] !== 0
    || document.colors[offset] !== 0
    || document.colors[offset + 1] !== 0
    || document.colors[offset + 2] !== 0
    || document.colors[offset + 3] !== 0;
}

export interface DeleteRegionPreflight {
  readonly rect: CropRect;
  readonly touchedIndices: Uint32Array;
  readonly changedIndices: Uint32Array;
  readonly changedBackstitchIds: Uint32Array;
}

interface DeleteSelectionPreflight {
  readonly touchedIndices: Uint32Array;
  readonly changedIndices: Uint32Array;
  readonly changedBackstitchIds: Uint32Array;
}

/** Validate a selection deletion without changing the document. */
export function preflightDeleteRegionCommand(document: PatternDocument, command: DeleteRegionCommand): DeleteRegionPreflight {
  validateBulkRevision(document, command);
  const rect = parseDeleteRegion(command);
  if (!Number.isSafeInteger(rect.x) || !Number.isSafeInteger(rect.y) || !Number.isSafeInteger(rect.width) || !Number.isSafeInteger(rect.height)
    || rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1
    || rect.x + rect.width > document.width || rect.y + rect.height > document.height) {
    throw new DomainError('invalid-delete-region', 'Delete region must be a non-empty rectangle inside the document.');
  }

  const touchedIndices = new Uint32Array(rect.width * rect.height);
  const changedCells: number[] = [];
  let touchedPosition = 0;
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const index = y * document.width + x;
      touchedIndices[touchedPosition] = index;
      touchedPosition += 1;
      if (cellHasGeometry(document, index)) changedCells.push(index);
    }
  }

  const left = rect.x * 4;
  const top = rect.y * 4;
  const right = (rect.x + rect.width) * 4;
  const bottom = (rect.y + rect.height) * 4;
  const changedLines: number[] = [];
  for (let index = 0; index < document.backstitches.ids.length; index += 1) {
    if (document.backstitches.x1[index] >= left && document.backstitches.x1[index] <= right
      && document.backstitches.x2[index] >= left && document.backstitches.x2[index] <= right
      && document.backstitches.y1[index] >= top && document.backstitches.y1[index] <= bottom
      && document.backstitches.y2[index] >= top && document.backstitches.y2[index] <= bottom) {
      changedLines.push(document.backstitches.ids[index]);
    }
  }
  return {
    rect,
    touchedIndices,
    changedIndices: new Uint32Array(changedCells),
    changedBackstitchIds: new Uint32Array(changedLines)
  };
}

/** Exact packed history size for a region deletion. */
export function estimateDeleteRegionHistoryBytes(
  changedCellCount: number,
  existingBackstitchCount = 0,
  deletedBackstitchCount = 0
): number {
  const backstitchBytes = deletedBackstitchCount === 0
    ? 0
    : backstitchStoreBytes(existingBackstitchCount) + backstitchStoreBytes(existingBackstitchCount - deletedBackstitchCount);
  return cellAndBackstitchDeltaBytes(changedCellCount, deletedBackstitchCount, backstitchBytes);
}

function applyDeleteSelectionCommand(
  document: PatternDocument,
  preflight: DeleteSelectionPreflight
): MutationInfo {
  const changedIndices = preflight.changedIndices;
  const beforeKind = new Uint8Array(changedIndices.length);
  const beforeColors = new Uint16Array(changedIndices.length * 4);
  const beforeCompleted = new Uint8Array(changedIndices.length);
  const afterKind = new Uint8Array(changedIndices.length);
  const afterColors = new Uint16Array(changedIndices.length * 4);
  const afterCompleted = new Uint8Array(changedIndices.length);
  const impactEntries = new Map<number, MutableDeleteMetricsImpactEntry>();

  for (let position = 0; position < changedIndices.length; position += 1) {
    const index = changedIndices[position];
    const documentOffset = colorsOffset(index);
    const packedOffset = position * 4;
    beforeKind[position] = document.kind[index];
    beforeCompleted[position] = document.completed[index];
    for (let slot = 0; slot < 4; slot += 1) beforeColors[packedOffset + slot] = document.colors[documentOffset + slot];
    addDeletedCellImpact(impactEntries, document, index);
  }

  // changedIndices is row-major and contains only cells that are not already
  // canonical empty values. Clear each contiguous changed run in bulk rather
  // than repeatedly writing the four color slots for a dense selection. The
  // after arrays are intentionally left at their zero-initialized canonical
  // empty values.
  let runStart = 0;
  while (runStart < changedIndices.length) {
    let runEnd = runStart + 1;
    while (runEnd < changedIndices.length && changedIndices[runEnd] === changedIndices[runEnd - 1] + 1) runEnd += 1;
    const cellStart = changedIndices[runStart];
    const cellEnd = changedIndices[runEnd - 1] + 1;
    document.kind.fill(0, cellStart, cellEnd);
    document.completed.fill(0, cellStart, cellEnd);
    document.colors.fill(0, cellStart * 4, cellEnd * 4);
    runStart = runEnd;
  }

  let beforeBackstitches: BackstitchStore | undefined;
  let afterBackstitches: BackstitchStore | undefined;
  if (preflight.changedBackstitchIds.length > 0) {
    beforeBackstitches = cloneBackstitches(document.backstitches);
    const deleted = new Set<number>(preflight.changedBackstitchIds);
    const retained: BackstitchRecord[] = [];
    for (const record of listBackstitches(document)) {
      addBackstitchImpact(impactEntries, record, 'before');
      if (!deleted.has(record.id)) {
        addBackstitchImpact(impactEntries, record, 'after');
        retained.push(record);
      }
    }
    document.backstitches = backstitchesFromRecords(retained);
    afterBackstitches = cloneBackstitches(document.backstitches);
  } else if (impactEntries.size > 0) {
    for (const record of listBackstitches(document)) {
      addBackstitchImpact(impactEntries, record, 'before');
      addBackstitchImpact(impactEntries, record, 'after');
    }
  }

  if (changedIndices.length === 0 && preflight.changedBackstitchIds.length === 0) {
    return noChange({ touchedIndices: preflight.touchedIndices, changedIndices, changedBackstitchIds: preflight.changedBackstitchIds });
  }
  const delta: SparseMutationDelta = {
    cells: { indices: changedIndices, beforeKind, beforeColors, beforeCompleted, afterKind, afterColors, afterCompleted },
    ...(beforeBackstitches === undefined ? {} : { beforeBackstitches, afterBackstitches })
  };
  registerDeleteMetricsImpact(delta, finalizeDeleteMetricsImpact(impactEntries));
  return {
    changed: true,
    snapshot: false,
    touchedIndices: preflight.touchedIndices,
    changedIndices,
    changedBackstitchIds: preflight.changedBackstitchIds,
    progress: emptyProgress(),
    recalculateMetrics: true,
    delta
  };
}

export function applyDeleteRegionCommand(
  document: PatternDocument,
  command: DeleteRegionCommand,
  preflight = preflightDeleteRegionCommand(document, command)
): MutationInfo {
  return applyDeleteSelectionCommand(document, preflight);
}

export interface DeleteCellSetPreflight extends DeleteSelectionPreflight {
  readonly indices: Uint32Array;
}

function validateDeleteCellSetIndices(document: PatternDocument, indices: unknown): Uint32Array {
  if (!(indices instanceof Uint32Array) || indices.length === 0) throw new DomainError('invalid-delete-cell-set', 'Delete cell-set indices must be a non-empty Uint32Array.');
  assertStrictlyIncreasing(indices, 'invalid-delete-cell-set', 'Delete cell-set indices', document.kind.length);
  return indices;
}

/** Validate a sparse cell-set deletion without changing the document. */
export function preflightDeleteCellSetCommand(document: PatternDocument, command: DeleteCellSetCommand): DeleteCellSetPreflight {
  validateBulkRevision(document, command);
  const indices = validateDeleteCellSetIndices(document, command.indices);
  const changedCells: number[] = [];
  for (const index of indices) if (cellHasGeometry(document, index)) changedCells.push(index);
  const changedLines: number[] = [];
  for (let index = 0; index < document.backstitches.ids.length; index += 1) {
    const store = document.backstitches;
    if (backstitchEndpointsContainedInCellUnion(store.x1[index], store.y1[index], store.x2[index], store.y2[index], document.width, document.height, indices)) {
      changedLines.push(store.ids[index]);
    }
  }
  return {
    indices,
    touchedIndices: indices,
    changedIndices: new Uint32Array(changedCells),
    changedBackstitchIds: new Uint32Array(changedLines)
  };
}

/** Exact packed history size for a sparse cell-set deletion. */
export function estimateDeleteCellSetHistoryBytes(
  changedCellCount: number,
  existingBackstitchCount = 0,
  deletedBackstitchCount = 0
): number {
  return estimateDeleteRegionHistoryBytes(changedCellCount, existingBackstitchCount, deletedBackstitchCount);
}

export function applyDeleteCellSetCommand(
  document: PatternDocument,
  command: DeleteCellSetCommand,
  preflight = preflightDeleteCellSetCommand(document, command)
): MutationInfo {
  return applyDeleteSelectionCommand(document, preflight);
}

export function deleteCellSetCommand(indices: Uint32Array, expectedRevision?: number): DeleteCellSetCommand {
  validateExpectedRevision(expectedRevision);
  return {
    type: 'delete-cell-set',
    indices: indices.slice(),
    ...(expectedRevision === undefined ? {} : { expectedRevision })
  };
}

export const createDeleteCellSetCommand = deleteCellSetCommand;
export const deleteCellsCommand = deleteCellSetCommand;

export function deleteRegionCommand(rect: CropRect, expectedRevision?: number): DeleteRegionCommand;
export function deleteRegionCommand(x: number, y: number, width: number, height: number, expectedRevision?: number): DeleteRegionCommand;
export function deleteRegionCommand(
  rectOrX: CropRect | number,
  yOrExpectedRevision?: number,
  width?: number,
  height?: number,
  expectedRevision?: number
): DeleteRegionCommand {
  const rect = typeof rectOrX === 'number'
    ? { x: rectOrX, y: yOrExpectedRevision as number, width: width as number, height: height as number }
    : rectOrX;
  const revision = typeof rectOrX === 'number' ? expectedRevision : yOrExpectedRevision;
  if (!rect || !Number.isSafeInteger(rect.x) || !Number.isSafeInteger(rect.y) || !Number.isSafeInteger(rect.width) || !Number.isSafeInteger(rect.height)) {
    throw new DomainError('invalid-delete-region', 'Delete region must contain integer coordinates and dimensions.');
  }
  validateExpectedRevision(revision);
  return {
    type: 'delete-region',
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    ...(revision === undefined ? {} : { expectedRevision: revision })
  };
}

export const createDeleteRegionCommand = deleteRegionCommand;
export const deleteSelectionCommand = deleteRegionCommand;

function parsePasteDestination(destination: Point): Point {
  return {
    x: requireCommandInteger(destination?.x, 'paste destination x'),
    y: requireCommandInteger(destination?.y, 'paste destination y')
  };
}

function pasteCellWouldChange(document: PatternDocument, targetIndex: number, fragment: PatternFragment, sourceIndex: number): boolean {
  const sourceKind = fragment.kind[sourceIndex];
  if (sourceKind === CellKind.Empty || !isActiveCell(document, targetIndex)) return false;
  const targetOffset = colorsOffset(targetIndex);
  const sourceOffset = colorsOffset(sourceIndex);
  if (isThreeQuarterPairKind(sourceKind)) {
    return document.kind[targetIndex] !== CellKind.ThreeQuarterPair
      || document.colors[targetOffset] !== fragment.colors[sourceOffset]
      || document.colors[targetOffset + 1] !== fragment.colors[sourceOffset + 1]
      || document.colors[targetOffset + 2] !== fragment.colors[sourceOffset + 2]
      || document.colors[targetOffset + 3] !== fragment.colors[sourceOffset + 3]
      || document.completed[targetIndex] !== 0;
  }
  if (sourceKind === CellKind.Full || sourceKind === CellKind.HalfBackslash || sourceKind === CellKind.HalfSlash || isThreeQuarterSingleKind(sourceKind)) {
    return document.kind[targetIndex] !== sourceKind
      || document.colors[targetOffset] !== fragment.colors[sourceOffset]
      || document.colors[targetOffset + 1] !== 0
      || document.colors[targetOffset + 2] !== 0
      || document.colors[targetOffset + 3] !== 0
      || document.completed[targetIndex] !== 0;
  }
  if (document.kind[targetIndex] !== CellKind.Quarters || document.completed[targetIndex] !== 0) return true;
  return document.colors[targetOffset] !== fragment.colors[sourceOffset]
    || document.colors[targetOffset + 1] !== fragment.colors[sourceOffset + 1]
    || document.colors[targetOffset + 2] !== fragment.colors[sourceOffset + 2]
    || document.colors[targetOffset + 3] !== fragment.colors[sourceOffset + 3];
}

function validatePastePalette(document: PatternDocument, fragment: PatternFragment): void {
  const count = fragment.width * fragment.height;
  for (let index = 0; index < count; index += 1) {
    if (fragment.kind[index] === CellKind.Empty) continue;
    const offset = colorsOffset(index);
    if (fragment.kind[index] === CellKind.Quarters || isThreeQuarterPairKind(fragment.kind[index])) {
      for (let slot = 0; slot < 4; slot += 1) if (fragment.colors[offset + slot] !== 0) requirePaletteEntry(document, fragment.colors[offset + slot]);
    } else {
      requirePaletteEntry(document, fragment.colors[offset]);
    }
  }
  for (const color of fragment.backstitches.colors) requirePaletteEntry(document, color);
}

function keptPasteBackstitches(document: PatternDocument, fragment: PatternFragment, destinationX: number, destinationY: number): Uint32Array {
  const count = fragment.backstitches.x1.length;
  const kept = new Uint32Array(count);
  let keptCount = 0;
  const offsetX = destinationX * FIXED_POINT_UNITS_PER_CELL;
  const offsetY = destinationY * FIXED_POINT_UNITS_PER_CELL;
  for (let index = 0; index < count; index += 1) {
    if (document.canvasMask !== undefined && !backstitchWithinCanvas(document, fragment.backstitches.x1[index] + offsetX, fragment.backstitches.y1[index] + offsetY, fragment.backstitches.x2[index] + offsetX, fragment.backstitches.y2[index] + offsetY)) continue;
    kept[keptCount] = index;
    keptCount += 1;
  }
  return kept.subarray(0, keptCount);
}

function validatePasteBackstitches(document: PatternDocument, fragment: PatternFragment, destinationX: number, destinationY: number): void {
  const geometries = new Set<string>();
  for (let index = 0; index < document.backstitches.ids.length; index += 1) geometries.add(segmentKey(document.backstitches, index));
  const offsetX = destinationX * 4;
  const offsetY = destinationY * 4;
  const maxX = document.width * 4;
  const maxY = document.height * 4;
  for (let index = 0; index < fragment.backstitches.x1.length; index += 1) {
    const x1 = fragment.backstitches.x1[index] + offsetX;
    const y1 = fragment.backstitches.y1[index] + offsetY;
    const x2 = fragment.backstitches.x2[index] + offsetX;
    const y2 = fragment.backstitches.y2[index] + offsetY;
    if (x1 > maxX || x2 > maxX || y1 > maxY || y2 > maxY) throw new DomainError('paste-out-of-bounds', 'A pasted backstitch is outside the destination document.');
    const key = pointsSegmentKey({ x: x1, y: y1 }, { x: x2, y: y2 });
    if (geometries.has(key)) throw new DomainError('duplicate-backstitch', 'A pasted backstitch duplicates existing geometry.');
    geometries.add(key);
  }
}

export interface PasteFragmentPreflight {
  readonly fragment: PatternFragment;
  readonly destinationX: number;
  readonly destinationY: number;
  readonly changedCellCount: number;
  readonly newBackstitchCount: number;
  /** Fragment backstitch positions that land inside the canvas, ascending. */
  readonly keptBackstitches: Uint32Array;
}

export function preflightPasteFragmentCommand(document: PatternDocument, command: PasteFragmentCommand): PasteFragmentPreflight {
  validateBulkRevision(document, command);
  const fragment = command.fragment;
  assertValidPatternFragment(fragment);
  const destination = parsePasteDestination(command.destination);
  if (destination.x < 0 || destination.y < 0 || destination.x + fragment.width > document.width || destination.y + fragment.height > document.height) throw new DomainError('paste-out-of-bounds', 'The fragment must fit entirely inside the destination document.');
  validatePastePalette(document, fragment);
  validatePasteBackstitches(document, fragment, destination.x, destination.y);
  const keptBackstitches = keptPasteBackstitches(document, fragment, destination.x, destination.y);
  const nextId = document.nextBackstitchId;
  if (keptBackstitches.length > 0 && (nextId > UINT32_MAX || nextId + keptBackstitches.length - 1 > UINT32_MAX)) throw new DomainError('backstitch-id-exhausted', 'The destination has no remaining backstitch IDs for this paste.');
  let changedCellCount = 0;
  for (let y = 0; y < fragment.height; y += 1) {
    for (let x = 0; x < fragment.width; x += 1) {
      const sourceIndex = y * fragment.width + x;
      const targetIndex = (destination.y + y) * document.width + destination.x + x;
      if (pasteCellWouldChange(document, targetIndex, fragment, sourceIndex)) changedCellCount += 1;
    }
  }
  return { fragment, destinationX: destination.x, destinationY: destination.y, changedCellCount, newBackstitchCount: keptBackstitches.length, keptBackstitches };
}

export function estimatePasteFragmentHistoryBytes(changedCellCount: number, existingBackstitchCount: number, newBackstitchCount: number): number {
  const backstitchBytes = newBackstitchCount === 0 ? 0 : backstitchStoreBytes(existingBackstitchCount) + backstitchStoreBytes(existingBackstitchCount + newBackstitchCount);
  return cellAndBackstitchDeltaBytes(changedCellCount, newBackstitchCount, backstitchBytes);
}

function applyPastedCell(document: PatternDocument, targetIndex: number, fragment: PatternFragment, sourceIndex: number): void {
  const sourceKind = fragment.kind[sourceIndex];
  const sourceOffset = colorsOffset(sourceIndex);
  if (sourceKind === CellKind.Full) writeFullAtIndex(document, targetIndex, fragment.colors[sourceOffset]);
  else if (sourceKind === CellKind.HalfBackslash) writeFullAtIndex(document, targetIndex, fragment.colors[sourceOffset], HalfDirection.Backslash);
  else if (sourceKind === CellKind.HalfSlash) writeFullAtIndex(document, targetIndex, fragment.colors[sourceOffset], HalfDirection.Slash);
  else if (isThreeQuarterSingleKind(sourceKind)) writeThreeQuarterKindAtIndex(document, targetIndex, sourceKind, fragment.colors[sourceOffset]);
  else if (isThreeQuarterPairKind(sourceKind)) writeThreeQuarterPairAtIndex(document, targetIndex, fragment.colors, sourceOffset);
  else if (sourceKind === CellKind.Quarters) writeQuartersAtIndex(document, targetIndex, fragment.colors, sourceOffset, false);
  document.completed[targetIndex] = 0;
}

function createPastedBackstitches(document: PatternDocument, fragment: PatternFragment, kept: Uint32Array, destinationX: number, destinationY: number): { before: BackstitchStore; after: BackstitchStore; ids: Uint32Array } {
  const before = cloneBackstitches(document.backstitches);
  const oldCount = document.backstitches.ids.length;
  const newCount = kept.length;
  const after = allocateBackstitches(oldCount + newCount);
  after.ids.set(document.backstitches.ids);
  after.x1.set(document.backstitches.x1);
  after.y1.set(document.backstitches.y1);
  after.x2.set(document.backstitches.x2);
  after.y2.set(document.backstitches.y2);
  after.colors.set(document.backstitches.colors);
  after.completed.set(document.backstitches.completed);
  const ids = new Uint32Array(newCount);
  const offsetX = destinationX * 4;
  const offsetY = destinationY * 4;
  for (let index = 0; index < newCount; index += 1) {
    const target = oldCount + index;
    const source = kept[index];
    const id = document.nextBackstitchId + index;
    ids[index] = id;
    after.ids[target] = id;
    after.x1[target] = fragment.backstitches.x1[source] + offsetX;
    after.y1[target] = fragment.backstitches.y1[source] + offsetY;
    after.x2[target] = fragment.backstitches.x2[source] + offsetX;
    after.y2[target] = fragment.backstitches.y2[source] + offsetY;
    after.colors[target] = fragment.backstitches.colors[source];
  }
  return { before, after, ids };
}

export function applyPasteFragmentCommand(document: PatternDocument, command: PasteFragmentCommand, preflight = preflightPasteFragmentCommand(document, command)): MutationInfo {
  const changedIndices = new Uint32Array(preflight.changedCellCount);
  const beforeKind = new Uint8Array(preflight.changedCellCount);
  const beforeColors = new Uint16Array(preflight.changedCellCount * 4);
  const beforeCompleted = new Uint8Array(preflight.changedCellCount);
  const afterKind = new Uint8Array(preflight.changedCellCount);
  const afterColors = new Uint16Array(preflight.changedCellCount * 4);
  const afterCompleted = new Uint8Array(preflight.changedCellCount);
  let changedPosition = 0;
  for (let y = 0; y < preflight.fragment.height; y += 1) {
    for (let x = 0; x < preflight.fragment.width; x += 1) {
      const sourceIndex = y * preflight.fragment.width + x;
      const targetIndex = (preflight.destinationY + y) * document.width + preflight.destinationX + x;
      if (!pasteCellWouldChange(document, targetIndex, preflight.fragment, sourceIndex)) continue;
      const documentOffset = colorsOffset(targetIndex);
      const packedOffset = changedPosition * 4;
      changedIndices[changedPosition] = targetIndex;
      beforeKind[changedPosition] = document.kind[targetIndex];
      beforeCompleted[changedPosition] = document.completed[targetIndex];
      beforeColors[packedOffset] = document.colors[documentOffset];
      beforeColors[packedOffset + 1] = document.colors[documentOffset + 1];
      beforeColors[packedOffset + 2] = document.colors[documentOffset + 2];
      beforeColors[packedOffset + 3] = document.colors[documentOffset + 3];
      applyPastedCell(document, targetIndex, preflight.fragment, sourceIndex);
      afterKind[changedPosition] = document.kind[targetIndex];
      afterCompleted[changedPosition] = document.completed[targetIndex];
      afterColors[packedOffset] = document.colors[documentOffset];
      afterColors[packedOffset + 1] = document.colors[documentOffset + 1];
      afterColors[packedOffset + 2] = document.colors[documentOffset + 2];
      afterColors[packedOffset + 3] = document.colors[documentOffset + 3];
      changedPosition += 1;
    }
  }
  let beforeBackstitches: BackstitchStore | undefined;
  let afterBackstitches: BackstitchStore | undefined;
  let createdBackstitchIds: Uint32Array | undefined;
  if (preflight.newBackstitchCount > 0) {
    const stores = createPastedBackstitches(document, preflight.fragment, preflight.keptBackstitches, preflight.destinationX, preflight.destinationY);
    beforeBackstitches = stores.before;
    afterBackstitches = stores.after;
    createdBackstitchIds = stores.ids;
    document.backstitches = cloneBackstitches(stores.after);
    document.nextBackstitchId += preflight.newBackstitchCount;
  }
  const changed = changedIndices.length > 0 || preflight.newBackstitchCount > 0;
  if (!changed) return noChange({ changedIndices });
  const delta: SparseMutationDelta = {
    cells: { indices: changedIndices, beforeKind, beforeColors, beforeCompleted, afterKind, afterColors, afterCompleted },
    ...(beforeBackstitches === undefined ? {} : { beforeBackstitches, afterBackstitches }),
    ...(preflight.newBackstitchCount === 0 ? {} : { beforeNextBackstitchId: document.nextBackstitchId - preflight.newBackstitchCount, afterNextBackstitchId: document.nextBackstitchId })
  };
  return { changed: true, snapshot: false, changedIndices, createdBackstitchIds, progress: emptyProgress(), delta };
}

export interface NormalizedMoveSelection {
  readonly rect: CropRect;
  readonly indices: Uint32Array;
  readonly dense: boolean;
  readonly count: number;
}

export interface MoveFragmentPreflight {
  readonly selection: NormalizedMoveSelection;
  readonly destinationX: number;
  readonly destinationY: number;
  readonly changedIndices: Uint32Array;
  readonly changedKinds: Uint8Array;
  readonly changedColors: Uint16Array;
  readonly changedCompleted: Uint8Array;
  readonly changedCellCount: number;
  readonly movedBackstitchIds: Uint32Array;
  readonly movedBackstitchCount: number;
  readonly beforeBackstitches?: BackstitchStore;
  readonly afterBackstitches?: BackstitchStore;
  readonly backstitchesChanged: boolean;
}

function parseMoveRect(value: unknown, label: string): CropRect {
  if (typeof value !== 'object' || value === null) throw new DomainError('invalid-selection', `${label} must be a rectangle.`);
  const source = value as Record<string, unknown>;
  return {
    x: requireCommandInteger(source.x, `${label}.x`),
    y: requireCommandInteger(source.y, `${label}.y`),
    width: requireCommandInteger(source.width, `${label}.width`),
    height: requireCommandInteger(source.height, `${label}.height`)
  };
}

function parseMoveSelection(selection: FragmentSelection): NormalizedMoveSelection {
  if (typeof selection !== 'object' || selection === null) throw new DomainError('invalid-selection', 'Move selection is required.');
  const rect = parseMoveRect('kind' in selection ? selection.rect : selection, 'move selection');
  if (!('kind' in selection) || selection.kind !== 'sparse') {
    const count = rect.width * rect.height;
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_PERSISTABLE_CELL_COUNT) throw new DomainError('invalid-selection', 'Move selection is too large.');
    return { rect, indices: new Uint32Array(0), dense: true, count };
  }
  const rawIndices = selection.indices;
  if (!(rawIndices instanceof Uint32Array) || rawIndices.length === 0) throw new DomainError('invalid-selection', 'Sparse move selection indices are required.');
  const indices = rawIndices.slice();
  assertStrictlyIncreasing(indices, 'invalid-selection', 'Sparse move selection indices');
  return { rect, indices, dense: false, count: indices.length };
}

function validateMoveSelection(document: PatternDocument, selection: NormalizedMoveSelection, destinationX: number, destinationY: number): void {
  const { rect, indices } = selection;
  if (!Number.isSafeInteger(rect.x) || !Number.isSafeInteger(rect.y) || !Number.isSafeInteger(rect.width) || !Number.isSafeInteger(rect.height)
    || rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1
    || rect.x + rect.width > document.width || rect.y + rect.height > document.height) {
    throw new DomainError('invalid-selection', 'Move selection must be a non-empty footprint inside the document.');
  }
  if (destinationX < 0 || destinationY < 0 || destinationX + rect.width > document.width || destinationY + rect.height > document.height) {
    throw new DomainError('move-out-of-bounds', 'The move destination footprint must fit entirely inside the document.');
  }
  // parseMoveSelection checked the order; a sparse index inside the bounds is inside the document.
  for (const index of indices) {
    const x = index % document.width;
    const y = Math.floor(index / document.width);
    if (x < rect.x || x >= rect.x + rect.width || y < rect.y || y >= rect.y + rect.height) throw new DomainError('invalid-selection', 'Sparse move selection indices must lie inside its bounds.');
  }
}

function moveSelectionContains(selection: NormalizedMoveSelection, index: number, documentWidth: number): boolean {
  if (selection.dense) {
    const x = index % documentWidth;
    const y = Math.floor(index / documentWidth);
    return x >= selection.rect.x && x < selection.rect.x + selection.rect.width
      && y >= selection.rect.y && y < selection.rect.y + selection.rect.height;
  }
  let low = 0;
  let high = selection.indices.length - 1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const candidate = selection.indices[middle];
    if (candidate === index) return true;
    if (candidate < index) low = middle + 1;
    else high = middle - 1;
  }
  return false;
}

function moveSelectionIndexAt(selection: NormalizedMoveSelection, position: number, documentWidth: number): number {
  if (!selection.dense) return selection.indices[position];
  const x = position % selection.rect.width;
  const y = Math.floor(position / selection.rect.width);
  return (selection.rect.y + y) * documentWidth + selection.rect.x + x;
}

function forEachMoveSourceIndex(selection: NormalizedMoveSelection, documentWidth: number, callback: (index: number) => void): void {
  for (let position = 0; position < selection.count; position += 1) callback(moveSelectionIndexAt(selection, position, documentWidth));
}

function moveSourceIndexAt(selection: NormalizedMoveSelection, index: number, documentWidth: number): number {
  return moveSelectionContains(selection, index, documentWidth) ? index : -1;
}

function moveTargetSourceIndexAt(
  selection: NormalizedMoveSelection,
  index: number,
  documentWidth: number,
  destinationX: number,
  destinationY: number
): number {
  const x = index % documentWidth;
  const y = Math.floor(index / documentWidth);
  const sourceX = x - destinationX + selection.rect.x;
  const sourceY = y - destinationY + selection.rect.y;
  if (sourceX < selection.rect.x || sourceX >= selection.rect.x + selection.rect.width
    || sourceY < selection.rect.y || sourceY >= selection.rect.y + selection.rect.height) return -1;
  const sourceIndex = sourceY * documentWidth + sourceX;
  return moveSelectionContains(selection, sourceIndex, documentWidth) ? sourceIndex : -1;
}

function forEachMoveUnion(
  selection: NormalizedMoveSelection,
  documentWidth: number,
  destinationX: number,
  destinationY: number,
  callback: (index: number) => void
): void {
  const translation = (destinationY - selection.rect.y) * documentWidth + destinationX - selection.rect.x;
  let sourcePosition = 0;
  let targetPosition = 0;
  while (sourcePosition < selection.count || targetPosition < selection.count) {
    const sourceIndex = sourcePosition < selection.count ? moveSelectionIndexAt(selection, sourcePosition, documentWidth) : Number.POSITIVE_INFINITY;
    const targetIndex = targetPosition < selection.count ? moveSelectionIndexAt(selection, targetPosition, documentWidth) + translation : Number.POSITIVE_INFINITY;
    if (sourceIndex < targetIndex) {
      callback(sourceIndex);
      sourcePosition += 1;
    } else if (targetIndex < sourceIndex) {
      callback(targetIndex);
      targetPosition += 1;
    } else if (sourceIndex !== Number.POSITIVE_INFINITY) {
      callback(sourceIndex);
      sourcePosition += 1;
      targetPosition += 1;
    } else break;
  }
}

function writeOrCompareFinalMoveCell(
  document: PatternDocument,
  selection: NormalizedMoveSelection,
  destinationX: number,
  destinationY: number,
  index: number,
  changedKinds?: Uint8Array,
  changedColors?: Uint16Array,
  changedCompleted?: Uint8Array,
  position = 0
): boolean {
  const sourceIndex = moveSourceIndexAt(selection, index, document.width);
  const targetSourceIndex = moveTargetSourceIndexAt(selection, index, document.width, destinationX, destinationY);
  let kind = sourceIndex < 0 ? document.kind[index] : CellKind.Empty;
  let completed = sourceIndex < 0 ? document.completed[index] : 0;
  let color0 = sourceIndex < 0 ? document.colors[colorsOffset(index)] : 0;
  let color1 = sourceIndex < 0 ? document.colors[colorsOffset(index) + 1] : 0;
  let color2 = sourceIndex < 0 ? document.colors[colorsOffset(index) + 2] : 0;
  let color3 = sourceIndex < 0 ? document.colors[colorsOffset(index) + 3] : 0;
  if (targetSourceIndex >= 0 && document.kind[targetSourceIndex] !== CellKind.Empty && isActiveCell(document, index)) {
    const sourceOffset = colorsOffset(targetSourceIndex);
    kind = document.kind[targetSourceIndex];
    completed = document.completed[targetSourceIndex];
    color0 = document.colors[sourceOffset];
    color1 = document.colors[sourceOffset + 1];
    color2 = document.colors[sourceOffset + 2];
    color3 = document.colors[sourceOffset + 3];
  }
  const documentOffset = colorsOffset(index);
  const differs = document.kind[index] !== kind
    || document.completed[index] !== completed
    || document.colors[documentOffset] !== color0
    || document.colors[documentOffset + 1] !== color1
    || document.colors[documentOffset + 2] !== color2
    || document.colors[documentOffset + 3] !== color3;
  if (differs && changedKinds !== undefined && changedColors !== undefined && changedCompleted !== undefined) {
    changedKinds[position] = kind;
    changedCompleted[position] = completed;
    const changedOffset = position * 4;
    changedColors[changedOffset] = color0;
    changedColors[changedOffset + 1] = color1;
    changedColors[changedOffset + 2] = color2;
    changedColors[changedOffset + 3] = color3;
  }
  return differs;
}

function moveBackstitchContained(
  selection: NormalizedMoveSelection,
  document: PatternDocument,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): boolean {
  if (!selection.dense) return backstitchEndpointsContainedInCellUnion(x1, y1, x2, y2, document.width, document.height, selection.indices);
  const units = FIXED_POINT_UNITS_PER_CELL;
  const left = selection.rect.x * units;
  const top = selection.rect.y * units;
  const right = (selection.rect.x + selection.rect.width) * units;
  const bottom = (selection.rect.y + selection.rect.height) * units;
  return x1 >= left && x1 <= right && x2 >= left && x2 <= right && y1 >= top && y1 <= bottom && y2 >= top && y2 <= bottom;
}

interface MoveBackstitchPlan {
  readonly movedCount: number;
  readonly changed: boolean;
  readonly retainedGeometries: ReadonlySet<string>;
  /** Contained lines whose destination leaves the canvas; they are dropped. */
  readonly dropped: ReadonlySet<number>;
}

function movedBackstitchLeavesCanvas(document: PatternDocument, index: number, deltaX: number, deltaY: number): boolean {
  if (document.canvasMask === undefined) return false;
  const store = document.backstitches;
  return !backstitchWithinCanvas(document, store.x1[index] + deltaX, store.y1[index] + deltaY, store.x2[index] + deltaX, store.y2[index] + deltaY);
}

function inspectMovedBackstitches(
  document: PatternDocument,
  selection: NormalizedMoveSelection,
  destinationX: number,
  destinationY: number
): MoveBackstitchPlan {
  const store = document.backstitches;
  let movedCount = 0;
  const retainedGeometries = new Set<string>();
  const dropped = new Set<number>();
  const deltaX = (destinationX - selection.rect.x) * FIXED_POINT_UNITS_PER_CELL;
  const deltaY = (destinationY - selection.rect.y) * FIXED_POINT_UNITS_PER_CELL;
  for (let index = 0; index < store.ids.length; index += 1) {
    if (moveBackstitchContained(selection, document, store.x1[index], store.y1[index], store.x2[index], store.y2[index])) {
      requirePaletteEntry(document, store.colors[index]);
      if (movedBackstitchLeavesCanvas(document, index, deltaX, deltaY)) dropped.add(index);
      else movedCount += 1;
    } else {
      retainedGeometries.add(segmentKey(store, index));
    }
  }
  if (movedCount > 0 && (deltaX !== 0 || deltaY !== 0)) {
    for (let index = 0; index < store.ids.length; index += 1) {
      if (dropped.has(index) || !moveBackstitchContained(selection, document, store.x1[index], store.y1[index], store.x2[index], store.y2[index])) continue;
      if (retainedGeometries.has(pointsSegmentKey({ x: store.x1[index] + deltaX, y: store.y1[index] + deltaY }, { x: store.x2[index] + deltaX, y: store.y2[index] + deltaY }))) throw new DomainError('backstitch-collision', 'The moved backstitch collides with retained geometry.');
    }
  }
  return { movedCount, changed: (movedCount > 0 && (deltaX !== 0 || deltaY !== 0)) || dropped.size > 0, retainedGeometries, dropped };
}

function materializeMovedBackstitches(
  document: PatternDocument,
  selection: NormalizedMoveSelection,
  destinationX: number,
  destinationY: number,
  plan: MoveBackstitchPlan
): { readonly movedIds: Uint32Array; readonly before?: BackstitchStore; readonly after?: BackstitchStore } {
  if (!plan.changed) return { movedIds: new Uint32Array(0) };
  const store = document.backstitches;
  const movedIds = new Uint32Array(plan.movedCount);
  const before = cloneBackstitches(store);
  const after = cloneBackstitches(store);
  const deltaX = (destinationX - selection.rect.x) * FIXED_POINT_UNITS_PER_CELL;
  const deltaY = (destinationY - selection.rect.y) * FIXED_POINT_UNITS_PER_CELL;
  let movedPosition = 0;
  for (let index = 0; index < store.ids.length; index += 1) {
    if (plan.dropped.has(index) || !moveBackstitchContained(selection, document, store.x1[index], store.y1[index], store.x2[index], store.y2[index])) continue;
    movedIds[movedPosition] = store.ids[index];
    after.x1[index] = store.x1[index] + deltaX;
    after.y1[index] = store.y1[index] + deltaY;
    after.x2[index] = store.x2[index] + deltaX;
    after.y2[index] = store.y2[index] + deltaY;
    movedPosition += 1;
  }
  movedIds.sort();
  if (plan.dropped.size === 0) return { movedIds, before, after };
  const kept = store.ids.length - plan.dropped.size;
  const pruned = allocateBackstitches(kept);
  let position = 0;
  for (let index = 0; index < store.ids.length; index += 1) {
    if (plan.dropped.has(index)) continue;
    copyBackstitch(after, index, pruned, position);
    position += 1;
  }
  return { movedIds, before, after: pruned };
}

export function preflightMoveFragmentCommand(document: PatternDocument, command: MoveFragmentCommand, historyLimitBytes?: number): MoveFragmentPreflight {
  validateBulkRevision(document, command);
  const selection = parseMoveSelection(command.selection);
  const destination = parsePasteDestination(command.destination);
  validateMoveSelection(document, selection, destination.x, destination.y);

  forEachMoveSourceIndex(selection, document.width, (index) => {
    if (document.kind[index] !== CellKind.Empty) {
      const offset = colorsOffset(index);
      if (document.kind[index] === CellKind.Quarters || isThreeQuarterPairKind(document.kind[index])) {
        for (let slot = 0; slot < 4; slot += 1) if (document.colors[offset + slot] !== 0) requirePaletteEntry(document, document.colors[offset + slot]);
      } else requirePaletteEntry(document, document.colors[offset]);
    }
  });
  let changedCellCount = 0;
  forEachMoveUnion(selection, document.width, destination.x, destination.y, (index) => {
    if (writeOrCompareFinalMoveCell(document, selection, destination.x, destination.y, index)) changedCellCount += 1;
  });
  const backstitchPlan = inspectMovedBackstitches(document, selection, destination.x, destination.y);
  const estimatedBytes = estimateMoveFragmentHistoryBytes(changedCellCount, document.backstitches.ids.length, backstitchPlan.changed ? backstitchPlan.movedCount + backstitchPlan.dropped.size : 0);
  if (historyLimitBytes !== undefined) {
    if (!Number.isSafeInteger(historyLimitBytes) || historyLimitBytes < 1) throw new DomainError('invalid-history-limit', 'Move history limit must be a positive integer.');
    if (estimatedBytes > historyLimitBytes) throw new DomainError('history-entry-too-large', `History entry requires ${String(estimatedBytes)} bytes, exceeding the configured ${String(historyLimitBytes)} byte limit.`);
  }
  const changedIndices = new Uint32Array(changedCellCount);
  const changedKinds = new Uint8Array(changedCellCount);
  const changedColors = new Uint16Array(changedCellCount * 4);
  const changedCompleted = new Uint8Array(changedCellCount);
  let changedPosition = 0;
  forEachMoveUnion(selection, document.width, destination.x, destination.y, (index) => {
    if (!writeOrCompareFinalMoveCell(document, selection, destination.x, destination.y, index, changedKinds, changedColors, changedCompleted, changedPosition)) return;
    changedIndices[changedPosition] = index;
    changedPosition += 1;
  });
  const backstitches = materializeMovedBackstitches(document, selection, destination.x, destination.y, backstitchPlan);
  return {
    selection,
    destinationX: destination.x,
    destinationY: destination.y,
    changedIndices,
    changedKinds,
    changedColors,
    changedCompleted,
    changedCellCount,
    movedBackstitchIds: backstitches.movedIds,
    movedBackstitchCount: backstitches.movedIds.length,
    ...(backstitches.before === undefined ? {} : { beforeBackstitches: backstitches.before, afterBackstitches: backstitches.after }),
    backstitchesChanged: backstitchPlan.changed
  };
}

export function estimateMoveFragmentHistoryBytes(changedCellCount: number, existingBackstitchCount: number, changedBackstitchCount: number): number {
  // Both snapshots are sized at the existing count, which bounds the after store when lines are dropped.
  const backstitchBytes = changedBackstitchCount === 0 ? 0 : backstitchStoreBytes(existingBackstitchCount) * 2;
  return cellAndBackstitchDeltaBytes(changedCellCount, changedBackstitchCount, backstitchBytes);
}

export function applyMoveFragmentCommand(document: PatternDocument, command: MoveFragmentCommand, preflight = preflightMoveFragmentCommand(document, command)): MutationInfo {
  if (preflight.changedCellCount === 0 && !preflight.backstitchesChanged) {
    return noChange({ changedIndices: new Uint32Array(0), movedBackstitchIds: new Uint32Array(0) });
  }
  const changedIndices = preflight.changedIndices.slice();
  const beforeKind = new Uint8Array(preflight.changedCellCount);
  const beforeColors = new Uint16Array(preflight.changedCellCount * 4);
  const beforeCompleted = new Uint8Array(preflight.changedCellCount);
  for (let position = 0; position < preflight.changedCellCount; position += 1) {
    const index = changedIndices[position];
    const documentOffset = colorsOffset(index);
    const packedOffset = position * 4;
    beforeKind[position] = document.kind[index];
    beforeCompleted[position] = document.completed[index];
    for (let slot = 0; slot < 4; slot += 1) beforeColors[packedOffset + slot] = document.colors[documentOffset + slot];
    document.kind[index] = preflight.changedKinds[position];
    document.completed[index] = preflight.changedCompleted[position];
    for (let slot = 0; slot < 4; slot += 1) {
      document.colors[documentOffset + slot] = preflight.changedColors[packedOffset + slot];
    }
  }
  if (preflight.backstitchesChanged && preflight.afterBackstitches) document.backstitches = cloneBackstitches(preflight.afterBackstitches);
  const delta: SparseMutationDelta = {
    cells: {
      indices: changedIndices,
      beforeKind,
      beforeColors,
      beforeCompleted,
      afterKind: preflight.changedKinds,
      afterColors: preflight.changedColors,
      afterCompleted: preflight.changedCompleted
    },
    ...(preflight.beforeBackstitches === undefined ? {} : { beforeBackstitches: preflight.beforeBackstitches, afterBackstitches: preflight.afterBackstitches })
  };
  return {
    changed: true,
    snapshot: false,
    changedIndices,
    movedBackstitchIds: preflight.movedBackstitchIds,
    progress: emptyProgress(),
    recalculateMetrics: true,
    delta
  };
}

export function moveFragmentCommand(selection: FragmentSelection, destination: Point, expectedRevision?: number): MoveFragmentCommand {
  if (!Number.isSafeInteger(destination.x) || !Number.isSafeInteger(destination.y)) throw new DomainError('invalid-command', 'Move destination must contain integer x and y coordinates.');
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw new DomainError('stale-command', 'Expected revision must be a non-negative integer.');
  const clonedSelection: FragmentSelection = 'kind' in selection
    ? selection.kind === 'sparse'
      ? { kind: 'sparse', rect: { ...selection.rect }, indices: selection.indices.slice() }
      : { kind: 'rect', rect: { ...selection.rect } }
    : { ...selection };
  return {
    type: 'move-fragment',
    selection: clonedSelection,
    destination: { x: destination.x, y: destination.y },
    ...(expectedRevision === undefined ? {} : { expectedRevision })
  };
}

export const createMoveFragmentCommand = moveFragmentCommand;

export function pasteFragmentCommand(fragment: PatternFragment, destination: Point, expectedRevision?: number): PasteFragmentCommand {
  assertValidPatternFragment(fragment);
  if (!Number.isSafeInteger(destination.x) || !Number.isSafeInteger(destination.y)) throw new DomainError('invalid-command', 'Paste destination must contain integer x and y coordinates.');
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw new DomainError('stale-command', 'Expected revision must be a non-negative integer.');
  return {
    type: 'paste-fragment',
    fragment,
    destination: { x: destination.x, y: destination.y },
    ...(expectedRevision === undefined ? {} : { expectedRevision })
  };
}

export const createPasteFragmentCommand = pasteFragmentCommand;
export const pasteCommand = pasteFragmentCommand;

function writeQuartersAtIndex(document: PatternDocument, index: number, colors: ArrayLike<number>, sourceOffset = 0, validateColors = true): boolean {
  const offset = colorsOffset(index);
  const color0 = colors[sourceOffset];
  const color1 = colors[sourceOffset + 1];
  const color2 = colors[sourceOffset + 2];
  const color3 = colors[sourceOffset + 3];
  const occupied = color0 !== 0 || color1 !== 0 || color2 !== 0 || color3 !== 0;
  if (validateColors) {
    if (color0 !== 0) requirePaletteEntry(document, color0);
    if (color1 !== 0) requirePaletteEntry(document, color1);
    if (color2 !== 0) requirePaletteEntry(document, color2);
    if (color3 !== 0) requirePaletteEntry(document, color3);
  }
  if (!occupied) return clearCell(document, index);
  if (!isActiveCell(document, index)) return false;
  const oldKind = document.kind[index];
  const oldCompletion = document.completed[index];
  let nextCompletion = 0;
  if (oldKind === CellKind.Quarters) {
    for (let slot = 0; slot < 4; slot += 1) {
      const color = colors[sourceOffset + slot];
      if (color !== 0 && document.colors[offset + slot] !== 0) nextCompletion |= oldCompletion & (1 << slot);
    }
  }
  const isSame = oldKind === CellKind.Quarters && nextCompletion === oldCompletion && document.colors[offset] === color0 && document.colors[offset + 1] === color1 && document.colors[offset + 2] === color2 && document.colors[offset + 3] === color3;
  if (isSame) return false;
  document.kind[index] = CellKind.Quarters;
  document.completed[index] = nextCompletion;
  document.colors[offset] = color0;
  document.colors[offset + 1] = color1;
  document.colors[offset + 2] = color2;
  document.colors[offset + 3] = color3;
  return true;
}

function writeQuarters(document: PatternDocument, x: number, y: number, colors: readonly number[]): boolean {
  if (colors.length !== 4) throw new DomainError('invalid-command', 'A quarter set requires four color slots.');
  const index = cellIndex(document, x, y);
  return writeQuartersAtIndex(document, index, colors);
}

function applySetFullCommand(document: PatternDocument, command: SetFullCommand): MutationInfo {
  const x = requireCommandInteger(command.x, 'x');
  const y = requireCommandInteger(command.y, 'y');
  return writeFull(document, x, y, requireCommandInteger(command.color, 'color')) ? changed() : noChange();
}

function applySetHalfCommand(document: PatternDocument, command: SetHalfCommand): MutationInfo {
  const x = requireCommandInteger(command.x, 'x');
  const y = requireCommandInteger(command.y, 'y');
  const direction = parseDirection(command.direction);
  return writeFull(document, x, y, requireCommandInteger(command.color, 'color'), direction) ? changed() : noChange();
}

function applySetThreeQuarterCommand(document: PatternDocument, command: SetThreeQuarterCommand): MutationInfo {
  const x = requireCommandInteger(command.x, 'x');
  const y = requireCommandInteger(command.y, 'y');
  const corner = parseCorner(command.corner);
  return writeThreeQuarter(document, x, y, corner, requireCommandInteger(command.color, 'color')) ? changed() : noChange();
}

function quarterCommand(document: PatternDocument, command: SetQuarterCommand): MutationInfo {
  const x = requireCommandInteger(command.x, 'x');
  const y = requireCommandInteger(command.y, 'y');
  const corner = parseCorner(command.corner);
  const color = requireCommandInteger(command.color, 'color');
  if (color === 0) return removeQuarter(document, x, y, corner) ? changed() : noChange();
  return writeQuarter(document, x, y, corner, color) ? changed() : noChange();
}

function recolorCell(document: PatternDocument, command: RecolorCellCommand): MutationInfo {
  const x = requireCommandInteger(command.x, 'x');
  const y = requireCommandInteger(command.y, 'y');
  const color = requireCommandInteger(command.color, 'color');
  requirePaletteEntry(document, color);
  const index = cellIndex(document, x, y);
  const offset = colorsOffset(index);
  const cornerValue = command.corner;
  if (document.kind[index] === CellKind.Empty) return noChange();
  if (isThreeQuarterSingleKind(document.kind[index])) {
    const singleCorner = threeQuarterCornerForKind(document.kind[index]);
    if (cornerValue !== undefined && parseCorner(cornerValue) !== singleCorner) return noChange();
    if (document.colors[offset] === color) return noChange();
    document.colors[offset] = color;
    return changed();
  }
  if (isThreeQuarterPairKind(document.kind[index])) {
    if (cornerValue !== undefined) {
      const corner = parseCorner(cornerValue);
      if (document.colors[offset + corner] === 0 || document.colors[offset + corner] === color) return noChange();
      document.colors[offset + corner] = color;
      return changed();
    }
    let didChange = false;
    for (const corner of [QuarterCorner.NW, QuarterCorner.NE, QuarterCorner.SE, QuarterCorner.SW]) {
      if (document.colors[offset + corner] !== 0 && document.colors[offset + corner] !== color) {
        document.colors[offset + corner] = color;
        didChange = true;
      }
    }
    return didChange ? changed() : noChange();
  }
  if (document.kind[index] === CellKind.Quarters && cornerValue !== undefined) {
    const corner = parseCorner(cornerValue);
    if (document.colors[offset + corner] === 0 || document.colors[offset + corner] === color) return noChange();
    document.colors[offset + corner] = color;
    return changed();
  }
  let didChange = false;
  const slots = document.kind[index] === CellKind.Quarters ? [0, 1, 2, 3] : [0];
  for (const slot of slots) {
    if (document.colors[offset + slot] !== 0 && document.colors[offset + slot] !== color) {
      document.colors[offset + slot] = color;
      didChange = true;
    }
  }
  return didChange ? changed() : noChange();
}

function parsePoint(value: Point | undefined, label: string): Point {
  if (typeof value !== 'object' || value === null) throw new DomainError('invalid-point', `${label} must contain integer x and y coordinates.`);
  return { x: requireCommandInteger(value.x, `${label}.x`), y: requireCommandInteger(value.y, `${label}.y`) };
}

function parseEndpoints(command: { readonly start?: Point; readonly end?: Point }): { start: Point; end: Point } {
  return canonicalEndpoints(parsePoint(command.start, 'start'), parsePoint(command.end, 'end'));
}

/**
 * Snap a fixed-point position (model x 4) to a backstitch endpoint: the nearest
 * grid intersection, or the midpoint of a cell edge when the position is within
 * a quarter cell (one unit) of it. Corners win otherwise, a cell centre is never
 * returned, and an already-valid endpoint is returned unchanged. With `bounds`
 * (in cells) the position is first clamped to the document.
 */
export function snapBackstitchPoint(fixed: Point, bounds?: { readonly width: number; readonly height: number }): Point {
  const x = bounds ? Math.min(bounds.width * 4, Math.max(0, fixed.x)) : fixed.x;
  const y = bounds ? Math.min(bounds.height * 4, Math.max(0, fixed.y)) : fixed.y;
  const corner = { x: Math.round(x / 4) * 4, y: Math.round(y / 4) * 4 };
  // The nearest midpoint lies on the nearest vertical or horizontal grid line.
  const onVertical = { x: corner.x, y: Math.floor(y / 4) * 4 + 2 };
  const onHorizontal = { x: Math.floor(x / 4) * 4 + 2, y: corner.y };
  const verticalDistance = Math.hypot(x - onVertical.x, y - onVertical.y);
  const horizontalDistance = Math.hypot(x - onHorizontal.x, y - onHorizontal.y);
  const [midpoint, distance] = verticalDistance <= horizontalDistance ? [onVertical, verticalDistance] : [onHorizontal, horizontalDistance];
  return distance <= 1 ? midpoint : corner;
}

function snapBackstitchEndpoints(document: PatternDocument, start: Point, end: Point): { start: Point; end: Point } {
  if (!endpointInBounds(document, start) || !endpointInBounds(document, end)) {
    throw new DomainError('out-of-bounds', 'Backstitch endpoints must be within the document boundary.');
  }
  return canonicalEndpoints(
    snapBackstitchPoint(start),
    snapBackstitchPoint(end)
  );
}

function snapMovedBackstitchEndpoints(
  document: PatternDocument,
  current: BackstitchRecord,
  start: Point,
  end: Point
): { start: Point; end: Point } {
  if (!endpointInBounds(document, start) || !endpointInBounds(document, end)) {
    throw new DomainError('out-of-bounds', 'Backstitch endpoints must be within the document boundary.');
  }
  return canonicalEndpoints(
    start.x === current.x1 && start.y === current.y1 ? start : snapBackstitchPoint(start),
    end.x === current.x2 && end.y === current.y2 ? end : snapBackstitchPoint(end)
  );
}

function canonicalEndpoints(start: Point, end: Point): { start: Point; end: Point } {
  if (start.x < end.x || (start.x === end.x && start.y <= end.y)) return { start, end };
  return { start: end, end: start };
}

function greatestCommonDivisor(left: number, right: number): number {
  return right === 0 ? left : greatestCommonDivisor(right, left % right);
}

/** Splits a canonical line at every grid corner strictly between its endpoints; midpoints never split. */
function splitAtCorners(start: Point, end: Point): Array<{ start: Point; end: Point }> {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const steps = greatestCommonDivisor(Math.abs(dx), Math.abs(dy));
  const pieces: Array<{ start: Point; end: Point }> = [];
  let from = start;
  for (let step = 1; step < steps; step += 1) {
    const x = start.x + (dx / steps) * step;
    const y = start.y + (dy / steps) * step;
    if (x % 4 !== 0 || y % 4 !== 0) continue;
    const to = { x, y };
    pieces.push(canonicalEndpoints(from, to));
    from = to;
  }
  pieces.push(canonicalEndpoints(from, end));
  return pieces;
}

function endpointInBounds(document: PatternDocument, pointValue: Point): boolean {
  return pointValue.x >= 0 && pointValue.y >= 0 && pointValue.x <= document.width * 4 && pointValue.y <= document.height * 4;
}

function ensureBackstitchEndpoints(document: PatternDocument, start: Point, end: Point): void {
  if (start.x === end.x && start.y === end.y) throw new DomainError('invalid-backstitch', 'A backstitch cannot have identical endpoints.');
  if (!endpointInBounds(document, start) || !endpointInBounds(document, end)) throw new DomainError('out-of-bounds', 'Backstitch endpoints must be within the document boundary.');
  if (document.canvasMask !== undefined && !backstitchWithinCanvas(document, start.x, start.y, end.x, end.y)) throw new DomainError('outside-canvas', 'Backstitches must stay inside the canvas.');
}

function applyAddBackstitch(document: PatternDocument, command: AddBackstitchCommand): MutationInfo {
  const requested = parseEndpoints(command);
  const { start, end } = snapBackstitchEndpoints(document, requested.start, requested.end);
  ensureBackstitchEndpoints(document, start, end);
  const color = requireCommandInteger(command.color, 'color');
  requirePaletteEntry(document, color);
  const records = listBackstitches(document);
  const pieces = splitAtCorners(start, end);
  const existing = pieces.map((piece) => {
    const key = pointsSegmentKey(piece.start, piece.end);
    return records.findIndex((record) => pointsSegmentKey(record.start, record.end) === key);
  });
  if (existing.every((index) => index >= 0 && records[index].color === color && !records[index].completed)) {
    throw new DomainError('duplicate-backstitch', 'A backstitch with these endpoints already exists.');
  }
  const createdCount = existing.filter((index) => index < 0).length;
  const firstId = command.id === undefined ? document.nextBackstitchId : requireCommandInteger(command.id, 'id');
  if (createdCount > 0) {
    const lastId = firstId + createdCount - 1;
    if (firstId < 1 || lastId > UINT32_MAX || firstId < document.nextBackstitchId || records.some((record) => record.id >= firstId && record.id <= lastId)) {
      throw new DomainError('invalid-backstitch-id', `Backstitch ID ${String(firstId)} cannot be allocated.`);
    }
  }
  // Pieces that already exist are replaced in place: they take the new color and lose their progress.
  const createdIds: number[] = [];
  let firstReplacedId: number | undefined;
  pieces.forEach((piece, pieceIndex) => {
    const index = existing[pieceIndex];
    if (index >= 0) {
      records[index] = { ...records[index], color, completed: false };
      firstReplacedId ??= records[index].id;
      return;
    }
    const id = firstId + createdIds.length;
    createdIds.push(id);
    records.push({ id, x1: piece.start.x, y1: piece.start.y, x2: piece.end.x, y2: piece.end.y, start: piece.start, end: piece.end, color, completed: false });
  });
  document.backstitches = backstitchesFromRecords(records);
  if (createdIds.length === 0) return { ...changed(), backstitchId: firstReplacedId };
  document.nextBackstitchId = createdIds[createdIds.length - 1] + 1;
  return { ...changed(), backstitchId: createdIds[0], createdBackstitchIds: new Uint32Array(createdIds) };
}

function applyRemoveBackstitch(document: PatternDocument, command: RemoveBackstitchCommand): MutationInfo {
  const id = requireCommandInteger(command.id, 'id');
  const index = document.backstitches.ids.indexOf(id);
  if (index < 0) return noChange();
  const records = listBackstitches(document);
  records.splice(index, 1);
  document.backstitches = backstitchesFromRecords(records);
  return changed();
}

function applyMoveBackstitch(document: PatternDocument, command: MoveBackstitchCommand | UpdateBackstitchCommand): MutationInfo {
  const id = requireCommandInteger(command.id, 'id');
  const index = document.backstitches.ids.indexOf(id);
  if (index < 0) return noChange();
  const records = listBackstitches(document);
  const current = records[index];
  let endpoints: { start: Point; end: Point };
  if (command.dx !== undefined || command.dy !== undefined) {
    const dx = requireCommandInteger(command.dx, 'dx');
    const dy = requireCommandInteger(command.dy, 'dy');
    endpoints = canonicalEndpoints(
      { x: current.x1 + dx, y: current.y1 + dy },
      { x: current.x2 + dx, y: current.y2 + dy }
    );
  } else {
    endpoints = parseEndpoints(command);
  }
  const snapped = snapMovedBackstitchEndpoints(document, current, endpoints.start, endpoints.end);
  const { start, end } = snapped;
  ensureBackstitchEndpoints(document, start, end);
  const pieces = splitAtCorners(start, end);
  if (pieces.length === 1 && current.x1 === start.x && current.y1 === start.y && current.x2 === end.x && current.y2 === end.y) return noChange();
  const firstId = document.nextBackstitchId;
  if (pieces.length > 1 && firstId + pieces.length - 2 > UINT32_MAX) {
    throw new DomainError('invalid-backstitch-id', `Backstitch ID ${String(firstId)} cannot be allocated.`);
  }
  // Changing endpoints changes the stitch geometry; other stitches on the new pieces are replaced.
  const keys = new Set(pieces.map((piece) => pointsSegmentKey(piece.start, piece.end)));
  const createdIds: number[] = [];
  const next = records.flatMap((record, candidateIndex) => {
    if (candidateIndex !== index) return keys.has(pointsSegmentKey(record.start, record.end)) ? [] : [record];
    return pieces.map((piece, pieceIndex) => {
      const pieceId = pieceIndex === 0 ? current.id : firstId + pieceIndex - 1;
      if (pieceIndex > 0) createdIds.push(pieceId);
      return { ...current, id: pieceId, x1: piece.start.x, y1: piece.start.y, x2: piece.end.x, y2: piece.end.y, start: piece.start, end: piece.end, completed: false };
    });
  });
  document.backstitches = backstitchesFromRecords(next);
  if (createdIds.length === 0) return { ...changed(), backstitchId: id };
  document.nextBackstitchId = createdIds[createdIds.length - 1] + 1;
  return { ...changed(), backstitchId: id, createdBackstitchIds: new Uint32Array(createdIds) };
}

function applyRecolorBackstitch(document: PatternDocument, command: RecolorBackstitchCommand | UpdateBackstitchCommand): MutationInfo {
  const id = requireCommandInteger(command.id, 'id');
  const index = document.backstitches.ids.indexOf(id);
  if (index < 0) return noChange();
  const color = requireCommandInteger(command.color, 'color');
  requirePaletteEntry(document, color);
  if (document.backstitches.colors[index] === color) return noChange();
  document.backstitches.colors[index] = color;
  return changed();
}

function applyUpdateBackstitch(document: PatternDocument, command: UpdateBackstitchCommand): MutationInfo {
  const id = requireCommandInteger(command.id, 'id');
  const index = document.backstitches.ids.indexOf(id);
  if (index < 0) return noChange();
  const hasEndpoints = command.start !== undefined || command.dx !== undefined || command.dy !== undefined;
  let didChange = false;
  // Recolor first so every piece the move splits off inherits the new color.
  if (command.color !== undefined) {
    didChange = applyRecolorBackstitch(document, command).changed;
  }
  if (hasEndpoints) {
    const moveResult = applyMoveBackstitch(document, command);
    if (moveResult.changed) return moveResult;
  }
  return didChange ? changed() : noChange();
}

function paletteCreate(document: PatternDocument, command: PaletteCreateCommand): MutationInfo {
  const id = command.id === undefined ? document.nextPaletteId : requireCommandInteger(command.id, 'id');
  const { name, color } = command;
  if (typeof name !== 'string' || name.trim() === '' || typeof color !== 'string' || color.trim() === '') throw new DomainError('invalid-palette', 'Palette name and color are required.');
  if (id > paletteLimit(document)) throw new DomainError('invalid-palette-id', `The palette cannot exceed the brand's color count (${String(paletteLimit(document))}).`);
  if (id < 1 || id > PALETTE_ID_MAX || id < document.nextPaletteId || findPaletteEntry(document, id)) throw new DomainError('invalid-palette-id', `Palette ID ${String(id)} cannot be allocated.`);
  // Auto-assignment takes the first glyph not already used in the document so
  // growing palettes never collide. Only once every glyph is taken does it
  // overflow onto the cycled default — that overflow is exempt from the
  // duplicate guard below so auto-adding colors never fails. Explicit symbols
  // keep the guard.
  let autoOverflow = false;
  let symbol: string;
  if (command.symbol !== undefined) {
    symbol = command.symbol;
  } else {
    const used = new Set(document.palette.map((candidate) => candidate.symbol));
    const free = SYMBOL_IDS.find((slug) => !used.has(slug));
    if (free !== undefined) {
      symbol = free;
    } else {
      symbol = defaultPaletteSymbol(id);
      autoOverflow = true;
    }
  }
  const entry = normalizePaletteEntry({
    id,
    name,
    color,
    active: command.active !== false,
    symbol,
    ...(command.material === undefined ? {} : { material: command.material }),
    ...(command.catalog === undefined ? {} : { catalog: command.catalog })
  });
  if (!autoOverflow && document.palette.some((candidate) => candidate.symbol === entry.symbol)) throw new DomainError('invalid-palette-symbol', `Palette symbol ${entry.symbol} is duplicated.`);
  document.palette.push(entry);
  document.nextPaletteId = id === PALETTE_ID_MAX ? PALETTE_ID_MAX + 1 : id + 1;
  return { ...changed(), paletteId: id };
}

function paletteIsReferenced(document: PatternDocument, id: number): boolean {
  for (const color of document.colors) if (color === id) return true;
  for (const color of document.backstitches.colors) if (color === id) return true;
  return false;
}

function paletteUpdate(document: PatternDocument, command: PaletteUpdateCommand): MutationInfo {
  const id = requireCommandInteger(command.id, 'id');
  const entry = findPaletteEntry(document, id);
  if (!entry) throw new DomainError('unknown-palette', `Palette ID ${String(id)} does not exist.`);
  const { name: nextName, color: nextColor, active: nextActive, symbol: nextSymbol, material: nextMaterial, catalog: nextCatalog } = command;
  if (nextName !== undefined && (typeof nextName !== 'string' || nextName.trim() === '')) throw new DomainError('invalid-palette', 'Palette names must not be empty.');
  if (nextColor !== undefined && (typeof nextColor !== 'string' || nextColor.trim() === '')) throw new DomainError('invalid-palette', 'Palette colors must not be empty.');
  if (nextActive !== undefined && typeof nextActive !== 'boolean') throw new DomainError('invalid-palette', 'Palette active must be a boolean.');
  const next = normalizePaletteEntry({
    ...entry,
    name: nextName ?? entry.name,
    color: nextColor ?? entry.color,
    active: nextActive ?? entry.active,
    symbol: nextSymbol ?? entry.symbol,
    material: nextMaterial ?? entry.material,
    catalog: nextCatalog ?? entry.catalog
  });
  if (document.palette.some((candidate) => candidate.id !== id && candidate.symbol === next.symbol)) throw new DomainError('invalid-palette-symbol', `Palette symbol ${next.symbol} is duplicated.`);
  if (nextActive === false && entry.active && paletteIsReferenced(document, id)) throw new DomainError('palette-in-use', `Palette ID ${String(id)} is referenced by the document.`);
  const changedEntry = !palettesEqual([entry], [next]);
  if (!changedEntry) return noChange();
  document.palette = document.palette.map((candidate) => candidate.id !== id ? candidate : next);
  return changed();
}

function paletteDeactivate(document: PatternDocument, command: PaletteDeactivateCommand): MutationInfo {
  const id = requireCommandInteger(command.id, 'id');
  const entry = findPaletteEntry(document, id);
  if (!entry) throw new DomainError('unknown-palette', `Palette ID ${String(id)} does not exist.`);
  if (!entry.active) return noChange();
  if (paletteIsReferenced(document, id)) throw new DomainError('palette-in-use', `Palette ID ${String(id)} is referenced by the document.`);
  document.palette = document.palette.map((candidate) => candidate.id === id ? { ...candidate, active: false } : candidate);
  return changed();
}

function paletteSwap(document: PatternDocument, command: PaletteSwapCommand): MutationInfo {
  const a = requireCommandInteger(command.a, 'a');
  const b = requireCommandInteger(command.b, 'b');
  if (a === b) throw new DomainError('invalid-palette-id', 'Palette symbol swap needs two distinct colors.');
  const entryA = findPaletteEntry(document, a);
  const entryB = findPaletteEntry(document, b);
  if (!entryA || !entryB) throw new DomainError('unknown-palette', 'Palette symbol swap references a missing color.');
  if (entryA.symbol === entryB.symbol) return noChange();
  // The swap exchanges glyphs atomically: doing it as two palette-update calls
  // would trip the duplicate guard on the first step, because the other entry
  // still holds the symbol being moved. Keeping glyphs unique is the product
  // rule, so the picker's "take a symbol in use elsewhere" needs this one
  // combined step rather than a relaxation of the guard.
  document.palette = document.palette.map((candidate) => {
    if (candidate.id === a) return { ...candidate, symbol: entryB.symbol };
    if (candidate.id === b) return { ...candidate, symbol: entryA.symbol };
    return candidate;
  });
  return changed();
}

function paletteMerge(document: PatternDocument, command: PaletteMergeCommand): MutationInfo {
  const from = requireCommandInteger(command.from, 'from');
  const createInput = command.createTo;
  const toValue = command.to;
  const fromEntry = findPaletteEntry(document, from);
  if (!fromEntry) throw new DomainError('unknown-palette', `Palette ID ${String(from)} does not exist.`);
  const to = toValue === undefined ? document.nextPaletteId : requireCommandInteger(toValue, 'to');
  let toEntry = findPaletteEntry(document, to);
  const createdTo = !toEntry;
  if (!toEntry) {
    if (typeof createInput !== 'object' || createInput === null) throw new DomainError('unknown-palette', `Palette ID ${String(to)} does not exist.`);
    paletteCreate(document, { ...createInput, type: 'palette-create', id: to, active: true });
    toEntry = findPaletteEntry(document, to);
  }
  if (from === to) throw new DomainError('palette-merge', 'A palette color cannot merge into itself.');
  if (!toEntry) throw new DomainError('unknown-palette', `Palette ID ${String(to)} does not exist.`);
  if (!toEntry.active) throw new DomainError('palette-inactive', `Palette ID ${String(to)} is not active.`);
  let didChange = createdTo;
  for (let index = 0; index < document.colors.length; index += 1) {
    if (document.colors[index] !== from) continue;
    document.colors[index] = to;
    didChange = true;
  }
  for (let index = 0; index < document.backstitches.colors.length; index += 1) {
    if (document.backstitches.colors[index] !== from) continue;
    document.backstitches.colors[index] = to;
    didChange = true;
  }
  if (fromEntry.active) {
    document.palette = document.palette.map((candidate) => candidate.id === from ? { ...candidate, active: false } : candidate);
    didChange = true;
  }
  return didChange ? changed(true) : noChange();
}

function paletteDelete(document: PatternDocument, command: PaletteDeleteCommand): MutationInfo {
  const id = requireCommandInteger(command.id, 'id');
  const entry = findPaletteEntry(document, id);
  if (!entry) throw new DomainError('unknown-palette', `Palette ID ${String(id)} does not exist.`);
  if (!entry.active) return noChange();

  for (let index = 0; index < document.kind.length; index += 1) {
    const offset = colorsOffset(index);
    const occupied = componentSlotMask(document.kind[index], document.colors, offset);
    let removed = 0;
    for (let slot = 0; slot < 4; slot += 1) if ((occupied & (1 << slot)) !== 0 && document.colors[offset + slot] === id) removed |= 1 << slot;
    if (removed === 0) continue;
    // A cell whose every component matches is cleared whole; otherwise the matching slots go one by one, which leaves a pair as a single three-quarter.
    if (removed === occupied) clearCell(document, index);
    else for (let slot = 0; slot < 4; slot += 1) if ((removed & (1 << slot)) !== 0) removeQuarterAtIndex(document, index, slot as QuarterCorner);
  }

  const retainedBackstitches = listBackstitches(document).filter((record) => record.color !== id);
  if (retainedBackstitches.length !== document.backstitches.ids.length) document.backstitches = backstitchesFromRecords(retainedBackstitches);
  document.palette = document.palette.map((candidate) => candidate.id === id ? { ...candidate, active: false } : candidate);
  return changed(true);
}

function sameContent(left: PatternDocument, right: PatternDocument): boolean {
  if (left.width !== right.width || left.height !== right.height || left.palette.length !== right.palette.length || left.backstitches.ids.length !== right.backstitches.ids.length || left.nextBackstitchId !== right.nextBackstitchId || left.nextPaletteId !== right.nextPaletteId) return false;
  if (!settingsEqual(left.settings, right.settings)) return false;
  if (!typedArraysEqual(left.kind, right.kind) || !typedArraysEqual(left.completed, right.completed) || !typedArraysEqual(left.colors, right.colors)) return false;
  if (!palettesEqual(left.palette, right.palette)) return false;
  return backstitchStoresEqual(left.backstitches, right.backstitches);
}

export function applyCommandsToDraft(document: PatternDocument, commands: readonly DomainCommand[], tracker?: MutationTracker): MutationInfo {
  assertBulkBatchPolicy(commands);
  if (commands.length === 1) return applyOneToDraft(document, commands[0], tracker);
  let didChange = false;
  let snapshot = false;
  let backstitchId: number | undefined;
  let paletteId: number | undefined;
  const touchedIndices: number[] = [];
  const changedIndices: number[] = [];
  const touchedBackstitchIds: number[] = [];
  const changedBackstitchIds: number[] = [];
  const progressCellIndices: number[] = [];
  const progressBackstitchIds: number[] = [];
  let progressMarked = 0;
  let progressUnmarked = 0;
  let recalculateMetrics = commands.length > 1;
  let hasTouchedIndices = false;
  let hasChangedIndices = false;
  let hasTouchedBackstitchIds = false;
  let hasChangedBackstitchIds = false;
  let directDelta: SparseMutationDelta | undefined;
  let deltaCount = 0;
  for (const command of commands) {
    const result = applyOneToDraft(document, command, tracker);
    didChange = result.changed || didChange;
    snapshot = result.snapshot || snapshot;
    recalculateMetrics = recalculateMetrics || result.recalculateMetrics === true;
    if (result.backstitchId !== undefined) backstitchId = result.backstitchId;
    if (result.paletteId !== undefined) paletteId = result.paletteId;
    if (result.touchedIndices !== undefined) {
      hasTouchedIndices = true;
      for (const index of result.touchedIndices) touchedIndices.push(index);
    }
    if (result.changedIndices !== undefined) {
      hasChangedIndices = true;
      for (const index of result.changedIndices) changedIndices.push(index);
    }
    if (result.touchedBackstitchIds !== undefined) {
      hasTouchedBackstitchIds = true;
      for (const id of result.touchedBackstitchIds) touchedBackstitchIds.push(id);
    }
    if (result.changedBackstitchIds !== undefined) {
      hasChangedBackstitchIds = true;
      for (const id of result.changedBackstitchIds) changedBackstitchIds.push(id);
    }
    if (result.progress !== undefined) {
      for (const index of result.progress.cellIndices) progressCellIndices.push(index);
      for (const id of result.progress.backstitchIds) progressBackstitchIds.push(id);
      progressMarked += result.progress.marked;
      progressUnmarked += result.progress.unmarked;
    }
    if (result.delta !== undefined) {
      directDelta = result.delta;
      deltaCount += 1;
    }
  }
  return {
    changed: didChange,
    snapshot,
    backstitchId,
    paletteId,
    ...(hasTouchedIndices ? { touchedIndices: new Uint32Array(touchedIndices) } : {}),
    ...(hasChangedIndices ? { changedIndices: new Uint32Array(changedIndices) } : {}),
    ...(hasTouchedBackstitchIds ? { touchedBackstitchIds: new Uint32Array(touchedBackstitchIds) } : {}),
    ...(hasChangedBackstitchIds ? { changedBackstitchIds: new Uint32Array(changedBackstitchIds) } : {}),
    progress: { cellIndices: new Uint32Array(progressCellIndices), backstitchIds: new Uint32Array(progressBackstitchIds), marked: progressMarked, unmarked: progressUnmarked },
    recalculateMetrics,
    ...(commands.length === 1 && deltaCount === 1 ? { delta: directDelta } : {})
  };
}

function applyOneToDraftInternal(document: PatternDocument, command: DomainCommand, tracker?: MutationTracker): MutationInfo {
  validateExpectedCommandRevision(document, command);
  if (tracker !== undefined) touchCommandTargets(document, command, tracker);
  switch (command.type) {
    case 'batch': return applyCommandsToDraft(document, command.commands, tracker);
    case 'set-full': return applySetFullCommand(document, command);
    case 'set-half': return applySetHalfCommand(document, command);
    case 'set-quarter': return quarterCommand(document, command);
    case 'set-three-quarter': return applySetThreeQuarterCommand(document, command);
    case 'set-quarters': {
      const x = requireCommandInteger(command.x, 'x');
      const y = requireCommandInteger(command.y, 'y');
      if (!Array.isArray(command.colors) || command.colors.length !== 4) throw new DomainError('invalid-command', 'set-quarters requires four physical color slots.');
      return writeQuarters(document, x, y, command.colors.map((value) => requireCommandInteger(value, 'set-quarters color'))) ? changed() : noChange();
    }
    case 'bulk-cell': return applyBulkCellCommand(document, command);
    case 'bulk-recolor': return applyBulkRecolorCommand(document, command);
    case 'bulk-completion': return applyBulkCompletionCommand(document, command);
    case 'bulk-backstitch-completion': return applyBulkBackstitchCompletionCommand(document, command);
    case 'paste-fragment': return applyPasteFragmentCommand(document, command);
    case 'move-fragment': return applyMoveFragmentCommand(document, command);
    case 'mixed-erase': return applyMixedEraseCommand(document, command);
    case 'delete-region': return applyDeleteRegionCommand(document, command);
    case 'delete-cell-set': return applyDeleteCellSetCommand(document, command);
    case 'document-settings-update': {
      const suppliedSettings = command.settings;
      if (typeof suppliedSettings !== 'object' || suppliedSettings === null || Array.isArray(suppliedSettings)) {
        throw new DomainError('invalid-settings', 'Document settings updates must provide a settings object.');
      }
      const normalized = normalizePatternSettings({ ...document.settings, ...suppliedSettings });
      if (settingsEqual(normalized, document.settings)) return noChange();
      document.settings = normalized;
      return changed();
    }
    case 'erase-cell': {
      const x = requireCommandInteger(command.x, 'x');
      const y = requireCommandInteger(command.y, 'y');
      return clearCell(document, cellIndex(document, x, y)) ? changed() : noChange();
    }
    case 'erase-quarter': {
      const x = requireCommandInteger(command.x, 'x');
      const y = requireCommandInteger(command.y, 'y');
      return removeQuarter(document, x, y, parseCorner(command.corner)) ? changed() : noChange();
    }
    case 'recolor-cell': return recolorCell(document, command);
    case 'add-backstitch': return applyAddBackstitch(document, command);
    case 'remove-backstitch': return applyRemoveBackstitch(document, command);
    case 'move-backstitch': return applyMoveBackstitch(document, command);
    case 'recolor-backstitch': return applyRecolorBackstitch(document, command);
    case 'update-backstitch': return applyUpdateBackstitch(document, command);
    case 'palette-create': return paletteCreate(document, command);
    case 'palette-update': return paletteUpdate(document, command);
    case 'palette-swap': return paletteSwap(document, command);
    case 'palette-deactivate': return paletteDeactivate(document, command);
    case 'palette-merge': return paletteMerge(document, command);
    case 'palette-delete': return paletteDelete(document, command);
    case 'canvas-resize':
    case 'canvas-cells':
    case 'layer-add':
    case 'layer-delete':
    case 'layer-move':
    case 'layer-rename':
    case 'layer-set-visibility':
    case 'layer-duplicate':
    case 'layer-merge':
      throw new DomainError('unknown-command', `Command type ${command.type} only applies to a layered document.`);
    default: {
      const unknown: never = command;
      throw new DomainError('unknown-command', `Unknown command type ${String((unknown as { type: unknown }).type)}.`);
    }
  }
}

export function applyOneToDraft(document: PatternDocument, command: DomainCommand, tracker?: MutationTracker): MutationInfo {
  return applyOneToDraftInternal(document, command, tracker);
}

export function applyCommand(document: PatternDocument, command: DomainCommand): CommandResult {
  assertValidDocument(document);
  const draft = cloneDocument(document);
  const commandList = command.type === 'batch' ? command.commands : [command];
  const snapshot = commandRequiresSnapshot(command);
  const tracker = snapshot ? undefined : new MutationTracker();
  const result = applyCommandsToDraft(draft, commandList, tracker);
  if (!result.changed || (!snapshot && !tracker?.hasChanges(draft) && result.delta === undefined) || (snapshot && sameContent(document, draft))) {
    return {
      document,
      changed: false,
      revision: document.revision,
      ...(result.touchedIndices === undefined ? {} : { touchedIndices: result.touchedIndices.slice() }),
      ...(result.changedIndices === undefined ? {} : { changedIndices: result.changedIndices.slice() }),
      ...(result.touchedBackstitchIds === undefined ? {} : { touchedBackstitchIds: result.touchedBackstitchIds.slice() }),
      ...(result.changedBackstitchIds === undefined ? {} : { changedBackstitchIds: result.changedBackstitchIds.slice() }),
      ...(result.progress === undefined ? {} : { progress: { cellIndices: result.progress.cellIndices.slice(), backstitchIds: result.progress.backstitchIds.slice(), marked: result.progress.marked, unmarked: result.progress.unmarked } }),
      ...(result.recalculateMetrics === undefined ? {} : { recalculateMetrics: result.recalculateMetrics }),
      ...(result.createdBackstitchIds === undefined ? {} : { createdBackstitchIds: result.createdBackstitchIds.slice() }),
      ...(result.movedBackstitchIds === undefined ? {} : { movedBackstitchIds: result.movedBackstitchIds.slice() })
    };
  }
  draft.revision = document.revision + 1;
  assertValidDocument(draft);
  const commandResult: CommandResult = {
    document: draft,
    changed: true,
    revision: draft.revision,
    backstitchId: result.backstitchId,
    paletteId: result.paletteId,
    ...(result.touchedIndices === undefined ? {} : { touchedIndices: result.touchedIndices.slice() }),
    ...(result.changedIndices === undefined ? {} : { changedIndices: result.changedIndices.slice() }),
    ...(result.touchedBackstitchIds === undefined ? {} : { touchedBackstitchIds: result.touchedBackstitchIds.slice() }),
    ...(result.changedBackstitchIds === undefined ? {} : { changedBackstitchIds: result.changedBackstitchIds.slice() }),
    ...(result.progress === undefined ? {} : { progress: { cellIndices: result.progress.cellIndices.slice(), backstitchIds: result.progress.backstitchIds.slice(), marked: result.progress.marked, unmarked: result.progress.unmarked } }),
    ...(result.recalculateMetrics === undefined ? {} : { recalculateMetrics: result.recalculateMetrics }),
    ...(result.createdBackstitchIds === undefined ? {} : { createdBackstitchIds: result.createdBackstitchIds.slice() }),
    ...(result.movedBackstitchIds === undefined ? {} : { movedBackstitchIds: result.movedBackstitchIds.slice() })
  };
  if (result.delta !== undefined) attachDeleteMetricsImpactForDelta(commandResult, result.delta, 'after');
  return commandResult;
}

export function executeCommand(document: PatternDocument, command: DomainCommand): CommandResult;
export function executeCommand(editor: { execute(command: DomainCommand): CommandResult }, command: DomainCommand): CommandResult;
export function executeCommand(target: PatternDocument | { execute(command: DomainCommand): CommandResult }, command: DomainCommand): CommandResult {
  return 'execute' in target ? target.execute(command) : applyCommand(target, command);
}

export const runCommand = executeCommand;

export function applyBatch(document: PatternDocument, commands: readonly DomainCommand[]): CommandResult {
  return applyCommand(document, { type: 'batch', commands: [...commands] });
}

export function fullCommand(x: number, y: number, color: number): SetFullCommand {
  return { type: 'set-full', x, y, color };
}

export function halfCommand(x: number, y: number, direction: HalfDirection, color: number): SetHalfCommand {
  return { type: 'set-half', x, y, direction, color };
}

export function quarterCommandFor(x: number, y: number, corner: QuarterCorner, color: number): SetQuarterCommand {
  return { type: 'set-quarter', x, y, corner, color };
}

export function threeQuarterCommandFor(x: number, y: number, corner: QuarterCorner, color: number): SetThreeQuarterCommand {
  return { type: 'set-three-quarter', x, y, corner, color };
}

export const setFullCommand = fullCommand;
export const setHalfCommand = halfCommand;
export const setQuarterCommand = quarterCommandFor;
export const setThreeQuarterCommand = threeQuarterCommandFor;
export const threeQuarterCommand = threeQuarterCommandFor;

export function createPaletteCommand(input: PaletteEntryInput): PaletteCreateCommand {
  return { type: 'palette-create', ...input };
}

export function createPaletteMergeCommand(from: number, to: number): PaletteMergeCommand {
  return { type: 'palette-merge', from, to };
}

export const mergePaletteCommand = createPaletteMergeCommand;

export const addPaletteCommand = createPaletteCommand;

export function createBackstitchCommand(start: Point, end: Point, color: number): AddBackstitchCommand {
  return { type: 'add-backstitch', start, end, color };
}

export const addBackstitchCommand = createBackstitchCommand;

export function setFull(document: PatternDocument, x: number, y: number, color: number): CommandResult {
  return applyCommand(document, fullCommand(x, y, color));
}

export function setHalf(document: PatternDocument, x: number, y: number, direction: HalfDirection, color: number): CommandResult {
  return applyCommand(document, halfCommand(x, y, direction, color));
}

export function setQuarter(document: PatternDocument, x: number, y: number, corner: QuarterCorner, color: number): CommandResult {
  return applyCommand(document, quarterCommandFor(x, y, corner, color));
}

export function setThreeQuarter(document: PatternDocument, x: number, y: number, corner: QuarterCorner, color: number): CommandResult {
  return applyCommand(document, threeQuarterCommandFor(x, y, corner, color));
}

export function eraseCell(document: PatternDocument, x: number, y: number): CommandResult {
  return applyCommand(document, { type: 'erase-cell', x, y });
}

export function deleteRegion(document: PatternDocument, rect: CropRect): CommandResult {
  return applyCommand(document, deleteRegionCommand(rect));
}

export function recolor(document: PatternDocument, x: number, y: number, color: number, corner?: QuarterCorner): CommandResult {
  return applyCommand(document, { type: 'recolor-cell', x, y, color, ...(corner === undefined ? {} : { corner }) });
}

export function addBackstitch(document: PatternDocument, start: Point, end: Point, color: number): CommandResult {
  return applyCommand(document, createBackstitchCommand(start, end, color));
}

export function updateBackstitch(document: PatternDocument, id: number, changes: Partial<{ start: Point; end: Point; color: number }>): CommandResult {
  return applyCommand(document, { type: 'update-backstitch', id, ...changes });
}

export function moveBackstitch(document: PatternDocument, id: number, start: Point, end: Point): CommandResult {
  return applyCommand(document, { type: 'move-backstitch', id, start, end });
}

export function removeBackstitch(document: PatternDocument, id: number): CommandResult {
  return applyCommand(document, { type: 'remove-backstitch', id });
}

export function recolorBackstitch(document: PatternDocument, id: number, color: number): CommandResult {
  return applyCommand(document, { type: 'recolor-backstitch', id, color });
}

export function createPalette(document: PatternDocument, input: PaletteEntryInput): CommandResult {
  return applyCommand(document, createPaletteCommand(input));
}

export function updatePalette(document: PatternDocument, id: number, changes: Partial<{ name: string; color: string; active: boolean }>): CommandResult {
  return applyCommand(document, { type: 'palette-update', id, ...changes });
}

export function deactivatePalette(document: PatternDocument, id: number): CommandResult {
  return applyCommand(document, { type: 'palette-deactivate', id });
}

export const createPaletteEntry = createPalette;
export const updatePaletteEntry = updatePalette;
export const deactivatePaletteEntry = deactivatePalette;
export const deleteBackstitch = removeBackstitch;

export const deleteSelectedRegion = deleteRegion;

export const clearCellCommand = (x: number, y: number): EraseCellCommand => ({ type: 'erase-cell', x, y });
export const eraseCommand = clearCellCommand;
export const removeBackstitchCommand = (id: number): RemoveBackstitchCommand => ({ type: 'remove-backstitch', id });
export const moveBackstitchCommand = (id: number, start: Point, end: Point): MoveBackstitchCommand => ({ type: 'move-backstitch', id, start, end });
export const recolorBackstitchCommand = (id: number, color: number): RecolorBackstitchCommand => ({ type: 'recolor-backstitch', id, color });
