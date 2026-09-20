import {
  cellIndex,
  cloneDocument,
  colorsOffset,
  defaultPaletteSymbol,
  findPaletteEntry,
  listBackstitches,
  MAX_PALETTE_COLORS,
  requirePaletteEntry,
  normalizePaletteEntry,
  clonePaletteEntry,
  PALETTE_SYMBOLS,
  UINT32_MAX,
  isThreeQuarterKind,
  isThreeQuarterPairKind,
  isThreeQuarterSingleKind,
  oppositeQuarterCorner,
  threeQuarterCornerForKind,
  threeQuarterKindForCorner
} from './model';
import {
  CellKind,
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
  type BackstitchRecord,
  type BackstitchStore,
  type CommandResult,
  type CropRect,
  type DeleteCellSetCommand,
  type DeleteRegionCommand,
  type DomainCommand,
  type MixedEraseCommand,
  type PaletteEntryInput,
  type PatternDocument,
  type PaletteEntry,
  type PasteFragmentCommand,
  type Point,
  type PatternFragment,
  type ProgressChangeSet
} from './types';
import { assertValidDocument } from './validation';
import { assertValidPatternFragment, backstitchEndpointsContainedInCellUnion } from './fragment';
import { fixedPointBackstitchLength } from './metrics';
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
}

function cloneBackstitchStore(store: BackstitchStore): BackstitchStore {
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
  } else if (isThreeQuarterPairKind(kind)) {
    for (const corner of [QuarterCorner.NW, QuarterCorner.NE, QuarterCorner.SE, QuarterCorner.SW]) {
      const color = document.colors[offset + corner];
      if (color !== 0) addDeletedCellComponentImpact(entries, color, 'removedThreeQuarter', (completion & (1 << corner)) !== 0);
    }
  } else if (isThreeQuarterSingleKind(kind)) {
    addDeletedCellComponentImpact(entries, document.colors[offset], 'removedThreeQuarter', (completion & 1) !== 0);
  } else if (kind === CellKind.Quarters) {
    for (let slot = 0; slot < 4; slot += 1) {
      const color = document.colors[offset + slot];
      if (color !== 0) addDeletedCellComponentImpact(entries, color, 'removedQuarter', (completion & (1 << slot)) !== 0);
    }
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

function sameBackstitchStore(left: BackstitchStore, right: BackstitchStore): boolean {
  if (left.ids.length !== right.ids.length) return false;
  for (let index = 0; index < left.ids.length; index += 1) {
    if (left.ids[index] !== right.ids[index] || left.x1[index] !== right.x1[index] || left.y1[index] !== right.y1[index] || left.x2[index] !== right.x2[index] || left.y2[index] !== right.y2[index] || left.colors[index] !== right.colors[index] || left.completed[index] !== right.completed[index]) return false;
  }
  return true;
}

function samePalette(left: readonly PaletteEntry[], right: readonly PaletteEntry[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    if (entry.id !== other.id || entry.name !== other.name || entry.color !== other.color || entry.active !== other.active || entry.symbol !== other.symbol) return false;
    if (entry.material.kind !== other.material.kind || entry.material.label !== other.material.label || entry.material.unit !== other.material.unit || entry.material.amount !== other.material.amount) return false;
    if (entry.catalog === undefined || other.catalog === undefined) return entry.catalog === undefined && other.catalog === undefined;
    return entry.catalog.catalogId === other.catalog.catalogId
      && entry.catalog.sourceId === other.catalog.sourceId
      && entry.catalog.code === other.catalog.code
      && entry.catalog.name === other.catalog.name
      && entry.catalog.hex === other.catalog.hex
      && entry.catalog.rgb[0] === other.catalog.rgb[0]
      && entry.catalog.rgb[1] === other.catalog.rgb[1]
      && entry.catalog.rgb[2] === other.catalog.rgb[2];
  });
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
    this.beforeBackstitches = cloneBackstitchStore(document.backstitches);
    this.beforeNextBackstitchId = document.nextBackstitchId;
  }

  touchPalette(document: PatternDocument): void {
    if (this.beforePalette !== undefined) return;
    this.beforePalette = document.palette.map(clonePaletteEntry);
    this.beforeNextPaletteId = document.nextPaletteId;
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
    if (this.beforeBackstitches !== undefined) document.backstitches = cloneBackstitchStore(this.beforeBackstitches);
    if (this.beforePalette !== undefined) document.palette = this.beforePalette.map(clonePaletteEntry);
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
    if (this.beforePalette !== undefined && !samePalette(this.beforePalette, document.palette)) {
      delta.beforePalette = this.beforePalette.map(clonePaletteEntry);
      delta.afterPalette = document.palette.map(clonePaletteEntry);
      delta.beforeNextPaletteId = this.beforeNextPaletteId;
      delta.afterNextPaletteId = document.nextPaletteId;
    }
    if (this.beforeBackstitches !== undefined && !sameBackstitchStore(this.beforeBackstitches, document.backstitches)) {
      delta.beforeBackstitches = cloneBackstitchStore(this.beforeBackstitches);
      delta.afterBackstitches = cloneBackstitchStore(document.backstitches);
      delta.beforeNextBackstitchId = this.beforeNextBackstitchId;
      delta.afterNextBackstitchId = document.nextBackstitchId;
    } else if (this.beforeBackstitches !== undefined && this.beforeNextBackstitchId !== document.nextBackstitchId) {
      delta.beforeNextBackstitchId = this.beforeNextBackstitchId;
      delta.afterNextBackstitchId = document.nextBackstitchId;
    }
    return delta;
  }

  hasChanges(document: PatternDocument): boolean {
    const delta = this.toDelta(document);
    return delta.cells.indices.length > 0 || delta.beforePalette !== undefined || delta.beforeBackstitches !== undefined || delta.beforeNextBackstitchId !== undefined || delta.beforeNextPaletteId !== undefined;
  }
}

function noChange(): MutationInfo {
  return { changed: false, snapshot: false, progress: emptyProgressChangeSet() };
}

function emptyProgressChangeSet(): ProgressChangeSet {
  return { cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0), marked: 0, unmarked: 0 };
}

function changed(snapshot = false, progress = emptyProgressChangeSet()): MutationInfo {
  return { changed: true, snapshot, progress, recalculateMetrics: snapshot };
}

function progressForCell(index: number, before: number, after: number): ProgressChangeSet {
  return { cellIndices: new Uint32Array([index]), backstitchIds: new Uint32Array(0), marked: Math.max(0, after - before), unmarked: Math.max(0, before - after) };
}

function progressForBackstitch(id: number, before: number, after: number): ProgressChangeSet {
  return { cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array([id]), marked: Math.max(0, after - before), unmarked: Math.max(0, before - after) };
}

function valueOf(command: DomainCommand, ...names: string[]): unknown {
  for (const name of names) {
    if (command[name] !== undefined) return command[name];
  }
  return undefined;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new DomainError('invalid-command', `${label} must be an integer.`);
  }
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new DomainError('invalid-command', `${label} must be a boolean.`);
  }
  return value;
}

function parseBulkProgressOperation(command: DomainCommand): BulkProgressOperation {
  const operation = valueOf(command, 'operation', 'op', 'action', 'mode');
  if (operation !== undefined) {
    if (typeof operation !== 'string') throw new DomainError('invalid-completion-operation', 'Bulk completion operation must be set, clear, or toggle.');
    const normalized = operation.toLowerCase().replace(/[-_ ]/g, '');
    if (normalized === 'set' || normalized === 'complete' || normalized === 'completed' || normalized === 'mark') return 'set';
    if (normalized === 'clear' || normalized === 'unset' || normalized === 'incomplete' || normalized === 'uncomplete') return 'clear';
    if (normalized === 'toggle' || normalized === 'flip') return 'toggle';
    throw new DomainError('invalid-completion-operation', `Bulk completion operation ${String(operation)} is not supported.`);
  }
  const rawType = typeof command.type === 'string' ? command.type.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase() : '';
  if (rawType === 'bulk-set-completion' || rawType === 'bulk-complete' || rawType === 'bulk-set-backstitch-completion' || rawType === 'bulk-backstitch-complete') return 'set';
  if (rawType === 'bulk-clear-completion' || rawType === 'bulk-clear-backstitch-completion') return 'clear';
  if (rawType === 'bulk-toggle-completion' || rawType === 'bulk-toggle-backstitch-completion') return 'toggle';
  const completed = valueOf(command, 'completed', 'complete');
  if (typeof completed === 'boolean') return completed ? 'set' : 'clear';
  throw new DomainError('invalid-completion-operation', 'Bulk completion requires a set, clear, or toggle operation.');
}

function applyProgressOperation(before: number, mask: number, operation: BulkProgressOperation): number {
  if (operation === 'set') return before | mask;
  if (operation === 'clear') return before & ~mask;
  return before ^ mask;
}

function normalizeType(type: string): string {
  const normalized = type.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();
  const aliases: Record<string, string> = {
    full: 'set-full',
    'full-cross': 'set-full',
    'paint-full': 'set-full',
    half: 'set-half',
    quarter: 'set-quarter',
    quarters: 'set-quarters',
    'three-quarter': 'set-three-quarter',
    threequarter: 'set-three-quarter',
    threequarters: 'set-three-quarter',
    'three-quarter-stitch': 'set-three-quarter',
    'set-threequarter': 'set-three-quarter',
    'set-three-quarters': 'set-three-quarter',
    'paint-half': 'set-half',
    'paint-quarter': 'set-quarter',
    'paint-three-quarter': 'set-three-quarter',
    'paint-threequarter': 'set-three-quarter',
    paint: 'set-cell',
    'paint-cell': 'set-cell',
    'set-stitch': 'set-cell',
    cell: 'set-cell',
    erase: 'erase-cell',
    'clear-cell': 'erase-cell',
    'clear-quarter': 'erase-quarter',
    'delete-cell': 'erase-cell',
    complete: 'set-completion',
    'mark-complete': 'set-completion',
    'toggle-complete': 'toggle-completion',
    'mark-cell-complete': 'set-completion',
    'add-segment': 'add-backstitch',
    'add-back-stitch': 'add-backstitch',
    'backstitch-add': 'add-backstitch',
    'create-backstitch': 'add-backstitch',
    'delete-backstitch': 'remove-backstitch',
    'remove-segment': 'remove-backstitch',
    'remove-back-stitch': 'remove-backstitch',
    'backstitch-remove': 'remove-backstitch',
    'update-segment': 'update-backstitch',
    'move-segment': 'move-backstitch',
    'backstitch-move': 'move-backstitch',
    'recolor-segment': 'recolor-backstitch',
    'backstitch-recolor': 'recolor-backstitch',
    'backstitch-complete': 'set-backstitch-completion',
    'create-palette': 'palette-create',
    'add-palette': 'palette-create',
    'palette-add': 'palette-create',
    'update-palette': 'palette-update',
    'deactivate-color': 'palette-deactivate',
    'deactivate-palette-color': 'palette-deactivate',
    'merge-palette': 'palette-merge',
    'palette-merge-color': 'palette-merge',
    'remove-and-replace-palette': 'palette-merge',
    'rotate-clockwise': 'rotate-cw',
    'rotate-counterclockwise': 'rotate-ccw',
    'mirror-x': 'mirror-horizontal',
    'mirror-y': 'mirror-vertical',
    'bulk-cells': 'bulk-cell',
    'bulk-cell-edit': 'bulk-cell',
    'bulk-complete': 'bulk-completion',
    'bulk-set-completion': 'bulk-completion',
    'bulk-clear-completion': 'bulk-completion',
    'bulk-toggle-completion': 'bulk-completion',
    'bulk-backstitch-complete': 'bulk-backstitch-completion',
    'bulk-set-backstitch-completion': 'bulk-backstitch-completion',
    'bulk-clear-backstitch-completion': 'bulk-backstitch-completion',
    'bulk-toggle-backstitch-completion': 'bulk-backstitch-completion',
    paste: 'paste-fragment',
    'paste-fragment-command': 'paste-fragment',
    'mixed-erase-command': 'mixed-erase',
    'delete-cell-set-command': 'delete-cell-set',
    'delete-cells': 'delete-cell-set',
    'delete-selection': 'delete-region',
    'clear-region': 'delete-region',
    'erase-region': 'delete-region',
    'delete-region-command': 'delete-region'
  };
  return aliases[normalized] ?? normalized;
}

export function commandRequiresSnapshot(command: DomainCommand): boolean {
  if (!command || typeof command.type !== 'string') return false;
  const type = normalizeType(command.type);
  if (type === 'batch') return Array.isArray(command.commands) && command.commands.some((child) => commandRequiresSnapshot(child as DomainCommand));
  return type === 'crop' || type === 'rotate' || type === 'rotate-cw' || type === 'rotate-ccw' || type === 'mirror' || type === 'mirror-horizontal' || type === 'mirror-vertical' || type === 'mirror-left-right' || type === 'mirror-top-bottom' || type === 'palette-merge';
}

function touchCommandTargets(document: PatternDocument, command: DomainCommand, tracker: MutationTracker): void {
  const type = normalizeType(command.type);
  if (type === 'batch') return;
  const cellTypes = new Set(['set-cell', 'set-full', 'set-half', 'set-quarter', 'set-quarters', 'set-three-quarter', 'erase-cell', 'erase-quarter', 'recolor-cell', 'recolor', 'set-completion', 'toggle-completion']);
  if (cellTypes.has(type)) {
    const x = valueOf(command, 'x', 'column');
    const y = valueOf(command, 'y', 'row');
    if (typeof x === 'number' && typeof y === 'number' && Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < document.width && y < document.height) tracker.touchCell(document, cellIndex(document, x, y));
  }
  const backstitchTypes = new Set(['add-backstitch', 'remove-backstitch', 'move-backstitch', 'recolor-backstitch', 'set-backstitch-completion', 'toggle-backstitch-completion', 'update-backstitch']);
  if (backstitchTypes.has(type)) tracker.touchBackstitches(document);
  if (type === 'palette-create' || type === 'palette-update' || type === 'palette-deactivate') tracker.touchPalette(document);
}

function parseColor(command: DomainCommand): number {
  return requiredNumber(valueOf(command, 'color', 'paletteId', 'colorId'), 'color');
}

function parseCorner(value: unknown): QuarterCorner {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3) {
    return value as QuarterCorner;
  }
  if (typeof value === 'string') {
    const normalized = value.toLowerCase().replace(/[-_ ]/g, '');
    const corners: Record<string, QuarterCorner> = {
      nw: QuarterCorner.NW,
      northwest: QuarterCorner.NW,
      topleft: QuarterCorner.NW,
      ne: QuarterCorner.NE,
      northeast: QuarterCorner.NE,
      topright: QuarterCorner.NE,
      se: QuarterCorner.SE,
      southeast: QuarterCorner.SE,
      bottomright: QuarterCorner.SE,
      sw: QuarterCorner.SW,
      southwest: QuarterCorner.SW,
      bottomleft: QuarterCorner.SW
    };
    if (corners[normalized] !== undefined) return corners[normalized];
  }
  throw new DomainError('invalid-corner', `Quarter corner ${String(value)} is invalid.`);
}

function parseDirection(value: unknown): HalfDirection {
  if (value === HalfDirection.Backslash || value === 'backslash' || value === 'back-slash' || value === '\\') {
    return HalfDirection.Backslash;
  }
  if (value === HalfDirection.Slash || value === 'slash' || value === '/') return HalfDirection.Slash;
  throw new DomainError('invalid-direction', `Half direction ${String(value)} is invalid.`);
}

function parseKind(value: unknown): CellKind {
  if (typeof value === 'number' && value >= CellKind.Empty && value <= CellKind.ThreeQuarterPair && Number.isInteger(value)) return value as CellKind;
  if (typeof value === 'string') {
    const normalized = value.toLowerCase().replace(/[-_ ]/g, '');
    if (normalized === 'empty') return CellKind.Empty;
    if (normalized === 'full' || normalized === 'cross') return CellKind.Full;
    if (normalized === 'half' || normalized === 'halfcross') return CellKind.HalfBackslash;
    if (normalized === 'halfbackslash' || normalized === 'backslash') return CellKind.HalfBackslash;
    if (normalized === 'halfslash' || normalized === 'slash') return CellKind.HalfSlash;
    if (normalized === 'quarter' || normalized === 'quarters') return CellKind.Quarters;
    if (normalized === 'threequarternw' || normalized === 'threequarternorthwest') return CellKind.ThreeQuarterNW;
    if (normalized === 'threequarterne' || normalized === 'threequarternortheast') return CellKind.ThreeQuarterNE;
    if (normalized === 'threequarterse' || normalized === 'threequartersoutheast') return CellKind.ThreeQuarterSE;
    if (normalized === 'threequartersw' || normalized === 'threequartersouthwest') return CellKind.ThreeQuarterSW;
    if (normalized === 'threequarterpair' || normalized === 'pairedthreequarter' || normalized === 'pairedthreequarters') return CellKind.ThreeQuarterPair;
  }
  throw new DomainError('invalid-kind', `Cell kind ${String(value)} is invalid.`);
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

function bulkEditSource(command: DomainCommand): Record<string, unknown> {
  const nested = valueOf(command, 'edit', 'operation', 'intent');
  if (typeof nested === 'object' && nested !== null) return nested as Record<string, unknown>;
  return command;
}

function bulkEditValue(command: DomainCommand, source: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (source[name] !== undefined) return source[name];
  }
  if (source !== command) return valueOf(command, ...names);
  return undefined;
}

function normalizeBulkKind(value: unknown): string {
  if (typeof value !== 'string') throw new DomainError('invalid-bulk-intent', 'A bulk cell edit requires a supported intent.');
  return value.toLowerCase().replace(/[-_ ]/g, '');
}

function parseBulkEdit(command: DomainCommand): BulkCellEdit {
  const source = bulkEditSource(command);
  const nested = valueOf(command, 'edit', 'operation', 'intent');
  const kindValue = typeof nested === 'string'
    ? nested
    : bulkEditValue(command, source, 'kind', 'mode', 'stitch', 'action', 'type');
  const kind = normalizeBulkKind(kindValue);
  if (kind === 'full' || kind === 'cross' || kind === 'setfull' || kind === 'fullcross') {
    return { kind: 'full', color: requiredNumber(bulkEditValue(command, source, 'color', 'paletteId', 'colorId'), 'bulk color') };
  }
  if (kind === 'half' || kind === 'halfcross' || kind === 'sethalf') {
    const direction = parseDirection(bulkEditValue(command, source, 'direction', 'diagonal', 'slash'));
    return { kind: 'half', direction, color: requiredNumber(bulkEditValue(command, source, 'color', 'paletteId', 'colorId'), 'bulk color') };
  }
  if (kind === 'quarter' || kind === 'setquarter' || kind === 'quarters') {
    const corner = parseCorner(bulkEditValue(command, source, 'corner', 'quarter', 'slot'));
    return { kind: 'quarter', corner, color: requiredNumber(bulkEditValue(command, source, 'color', 'paletteId', 'colorId'), 'bulk color') };
  }
  if (kind === 'threequarter' || kind === 'setthreequarter' || kind === 'threequarters') {
    const corner = parseCorner(bulkEditValue(command, source, 'corner', 'quarter', 'slot'));
    return { kind: 'three-quarter', corner, color: requiredNumber(bulkEditValue(command, source, 'color', 'paletteId', 'colorId'), 'bulk color') };
  }
  if (kind === 'erase' || kind === 'erasecell' || kind === 'clear' || kind === 'clearcell') return { kind: 'erase-cell' };
  if (kind === 'erasequarter' || kind === 'removequarter' || kind === 'clearquarter') {
    return { kind: 'erase-quarter', corner: parseCorner(bulkEditValue(command, source, 'corner', 'quarter', 'slot')) };
  }
  throw new DomainError('invalid-bulk-intent', `Bulk cell intent ${String(kindValue)} is not supported.`);
}

function validateBulkRevision(document: PatternDocument, command: DomainCommand): void {
  const expectedValue = valueOf(command, 'expectedRevision', 'baseRevision', 'revision');
  if (expectedValue === undefined) return;
  const expected = requiredNumber(expectedValue, 'expected revision');
  if (expected < 0 || expected !== document.revision) {
    throw new DomainError('stale-command', `Bulk cell edit expected revision ${String(expected)} but the document is at revision ${String(document.revision)}.`);
  }
}

function validateExpectedCommandRevision(document: PatternDocument, command: DomainCommand): void {
  const expectedValue = valueOf(command, 'expectedRevision', 'baseRevision');
  if (expectedValue === undefined) return;
  const expected = requiredNumber(expectedValue, 'expected revision');
  if (expected < 0 || expected !== document.revision) throw new DomainError('stale-command', `Command expected revision ${String(expected)} but the document is at revision ${String(document.revision)}.`);
}

function validateBulkIndices(document: PatternDocument, command: DomainCommand): Uint32Array {
  const indices = command.indices;
  if (!(indices instanceof Uint32Array)) throw new DomainError('invalid-bulk-indices', 'Bulk cell indices must be a Uint32Array.');
  let previous = -1;
  for (const index of indices) {
    if (index <= previous) throw new DomainError('invalid-bulk-indices', 'Bulk cell indices must be strictly increasing and unique.');
    if (index >= document.kind.length) throw new DomainError('out-of-bounds', `Bulk cell index ${String(index)} is out of bounds.`);
    previous = index;
  }
  return indices;
}

function threeQuarterComponentPresent(document: PatternDocument, index: number, corner: QuarterCorner): boolean {
  const offset = colorsOffset(index);
  const singleCorner = threeQuarterCornerForKind(document.kind[index]);
  if (singleCorner !== undefined) return singleCorner === corner && document.colors[offset] !== 0;
  return isThreeQuarterPairKind(document.kind[index]) && document.colors[offset + corner] !== 0;
}

function bulkCellWouldChange(document: PatternDocument, index: number, edit: BulkCellEdit): boolean {
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
export function preflightBulkCellCommand(document: PatternDocument, command: DomainCommand): BulkCellPreflight {
  if (!command || normalizeType(command.type) !== 'bulk-cell') throw new DomainError('invalid-command', 'A bulk cell command must have type bulk-cell.');
  validateBulkRevision(document, command);
  const edit = parseBulkEdit(command);
  if (edit.kind === 'full' || edit.kind === 'half' || edit.kind === 'quarter' || edit.kind === 'three-quarter') requirePaletteEntry(document, edit.color);
  const indices = validateBulkIndices(document, command);
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
export function estimateBulkCellHistoryBytes(changedCellCount: number): number {
  if (!Number.isSafeInteger(changedCellCount) || changedCellCount < 0) throw new DomainError('invalid-bulk-indices', 'Changed cell count is invalid.');
  return changedCellCount === 0 ? 0 : changedCellCount * 24 + 32;
}

export interface BulkRecolorPreflight {
  readonly fromColor: number;
  readonly toColor: number;
  readonly indices: Uint32Array;
  readonly masks: Uint8Array;
  readonly changedIndices: Uint32Array;
}

function occupiedColorMask(document: PatternDocument, index: number): number {
  const kind = document.kind[index];
  const offset = colorsOffset(index);
  if (kind === CellKind.Empty) return 0;
  if (kind === CellKind.Full || kind === CellKind.HalfBackslash || kind === CellKind.HalfSlash || isThreeQuarterSingleKind(kind)) {
    return document.colors[offset] === 0 ? 0 : 1;
  }
  let mask = 0;
  for (let slot = 0; slot < 4; slot += 1) if (document.colors[offset + slot] !== 0) mask |= 1 << slot;
  return mask;
}

/** Validate a component-aware recolor without changing the document. */
export function preflightBulkRecolorCommand(document: PatternDocument, command: DomainCommand): BulkRecolorPreflight {
  if (!command || normalizeType(command.type) !== 'bulk-recolor') throw new DomainError('invalid-command', 'A bulk recolor command must have type bulk-recolor.');
  validateBulkRevision(document, command);
  const fromColor = requiredNumber(valueOf(command, 'fromColor', 'sourceColor', 'from'), 'recolor source color');
  const toColor = requiredNumber(valueOf(command, 'toColor', 'destinationColor', 'to'), 'recolor destination color');
  // Validate both ends before deriving the sparse change set. This keeps a
  // malformed fill result from becoming a history entry with an unknown
  // palette reference.
  requirePaletteEntry(document, fromColor);
  requirePaletteEntry(document, toColor);
  const indices = validateBulkIndices(document, command);
  const rawMasks = command.masks;
  if (!(rawMasks instanceof Uint8Array)) throw new DomainError('invalid-bulk-recolor', 'Bulk recolor masks must be a Uint8Array.');
  if (rawMasks.length !== indices.length) throw new DomainError('invalid-bulk-recolor', 'Bulk recolor masks must align one-to-one with cell indices.');
  const masks = rawMasks.slice();
  for (let position = 0; position < indices.length; position += 1) {
    const index = indices[position];
    const mask = masks[position];
    if (mask === 0) throw new DomainError('invalid-bulk-recolor', `Bulk recolor mask for cell ${String(index)} must be nonzero.`);
    const occupied = occupiedColorMask(document, index);
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
  let previous = -1;
  for (const index of indices) {
    if (index <= previous) throw new DomainError('invalid-completion-targets', `${label} must be strictly increasing and unique.`);
    previous = index;
  }
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
  if (isThreeQuarterPairKind(kind)) {
    let mask = 0;
    for (const slot of [QuarterCorner.NW, QuarterCorner.NE, QuarterCorner.SE, QuarterCorner.SW]) if (document.colors[offset + slot] !== 0) mask |= 1 << slot;
    if (mask === 0) throw new DomainError('invalid-completion-target', `Cell ${String(index)} has no occupied three-quarter geometry.`);
    return mask;
  }
  if (kind !== CellKind.Quarters) return 1;
  let mask = 0;
  for (let slot = 0; slot < 4; slot += 1) if (document.colors[offset + slot] !== 0) mask |= 1 << slot;
  if (mask === 0) throw new DomainError('invalid-completion-target', `Cell ${String(index)} has no occupied quarter geometry.`);
  return mask;
}

function completionMasksForCommand(document: PatternDocument, command: DomainCommand, indices: Uint32Array): { corner?: QuarterCorner; masks: Uint8Array } {
  const cornerValue = valueOf(command, 'corner', 'quarter', 'slot');
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

function completedComponentCountForCell(document: PatternDocument, index: number): number {
  const kind = document.kind[index];
  const offset = colorsOffset(index);
  if (kind === CellKind.Full || kind === CellKind.HalfBackslash || kind === CellKind.HalfSlash) return (document.completed[index] & 1) !== 0 ? 1 : 0;
  if (isThreeQuarterSingleKind(kind)) return (document.completed[index] & 1) !== 0 ? 1 : 0;
  if (isThreeQuarterPairKind(kind)) {
    let count = 0;
    for (const corner of [QuarterCorner.NW, QuarterCorner.NE, QuarterCorner.SE, QuarterCorner.SW]) if (document.colors[offset + corner] !== 0 && (document.completed[index] & (1 << corner)) !== 0) count += 1;
    return count;
  }
  if (kind !== CellKind.Quarters) return 0;
  let count = 0;
  for (let slot = 0; slot < 4; slot += 1) if (document.colors[offset + slot] !== 0 && (document.completed[index] & (1 << slot)) !== 0) count += 1;
  return count;
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
      const progress = progressForCell(index, completedComponentCountForCell(before, index), completedComponentCountForCell(after, index));
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
  for (const id of candidates) {
    const beforePosition = before.backstitches.ids.findIndex((candidate) => candidate === id);
    const afterPosition = after.backstitches.ids.findIndex((candidate) => candidate === id);
    const progress = progressForBackstitch(
      id,
      beforePosition < 0 ? 0 : before.backstitches.completed[beforePosition],
      afterPosition < 0 ? 0 : after.backstitches.completed[afterPosition]
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
export function preflightBulkCompletionCommand(document: PatternDocument, command: DomainCommand): BulkCompletionPreflight {
  if (!command || normalizeType(command.type) !== 'bulk-completion') throw new DomainError('invalid-command', 'A bulk completion command must have type bulk-completion.');
  validateBulkRevision(document, command);
  const indices = validateProgressIndices(command.indices, 'Bulk completion indices');
  for (const index of indices) if (index >= document.kind.length) throw new DomainError('out-of-bounds', `Bulk completion cell index ${String(index)} is out of bounds.`);
  const target = completionMasksForCommand(document, command, indices);
  const operation = parseBulkProgressOperation(command);
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
  if (!Number.isSafeInteger(changedCellCount) || changedCellCount < 0) throw new DomainError('invalid-completion-targets', 'Changed cell count is invalid.');
  return changedCellCount === 0 ? 0 : changedCellCount * 6 + 32;
}

export interface BulkBackstitchCompletionPreflight {
  readonly operation: BulkProgressOperation;
  readonly ids: Uint32Array;
  readonly changedIds: Uint32Array;
}

/** Validates a backstitch progress command without changing the document. */
export function preflightBulkBackstitchCompletionCommand(document: PatternDocument, command: DomainCommand): BulkBackstitchCompletionPreflight {
  if (!command || normalizeType(command.type) !== 'bulk-backstitch-completion') throw new DomainError('invalid-command', 'A bulk backstitch completion command must have type bulk-backstitch-completion.');
  validateBulkRevision(document, command);
  const ids = validateProgressIndices(command.ids, 'Bulk backstitch IDs');
  if (ids.some((id) => id === 0)) throw new DomainError('invalid-completion-targets', 'Backstitch IDs must be positive.');
  const operation = parseBulkProgressOperation(command);
  const changed = [] as number[];
  for (const id of ids) {
    const position = backstitchIndex(document, id);
    if (position < 0) throw new DomainError('invalid-completion-target', `Backstitch ID ${String(id)} does not exist.`);
    const next = applyProgressOperation(document.backstitches.completed[position], 1, operation);
    if (next !== document.backstitches.completed[position]) changed.push(id);
  }
  return { operation, ids, changedIds: new Uint32Array(changed) };
}

/** Exact packed backstitch-completion delta size used by history preflight. */
export function estimateBulkBackstitchCompletionHistoryBytes(changedBackstitchCount: number): number {
  if (!Number.isSafeInteger(changedBackstitchCount) || changedBackstitchCount < 0) throw new DomainError('invalid-completion-targets', 'Changed backstitch count is invalid.');
  return changedBackstitchCount === 0 ? 0 : changedBackstitchCount * 6 + 32;
}

export function isBulkCellCommand(command: DomainCommand): command is BulkCellCommand {
  return Boolean(command) && typeof command.type === 'string' && normalizeType(command.type) === 'bulk-cell';
}

export function isBulkRecolorCommand(command: DomainCommand): command is BulkRecolorCommand {
  return Boolean(command) && typeof command.type === 'string' && normalizeType(command.type) === 'bulk-recolor';
}

export function isBulkCompletionCommand(command: DomainCommand): command is BulkCompletionCommand {
  return Boolean(command) && typeof command.type === 'string' && normalizeType(command.type) === 'bulk-completion';
}

export function isBulkBackstitchCompletionCommand(command: DomainCommand): command is BulkBackstitchCompletionCommand {
  return Boolean(command) && typeof command.type === 'string' && normalizeType(command.type) === 'bulk-backstitch-completion';
}

export function isBatchCommand(command: DomainCommand): boolean {
  return Boolean(command) && typeof command.type === 'string' && normalizeType(command.type) === 'batch';
}

export function isPasteFragmentCommand(command: DomainCommand): command is PasteFragmentCommand {
  return Boolean(command) && typeof command.type === 'string' && normalizeType(command.type) === 'paste-fragment';
}

export function isMixedEraseCommand(command: DomainCommand): command is MixedEraseCommand {
  return Boolean(command) && typeof command.type === 'string' && normalizeType(command.type) === 'mixed-erase';
}

export function isDeleteRegionCommand(command: DomainCommand): command is DeleteRegionCommand {
  return Boolean(command) && typeof command.type === 'string' && normalizeType(command.type) === 'delete-region';
}

export function isDeleteCellSetCommand(command: DomainCommand): command is DeleteCellSetCommand {
  return Boolean(command) && typeof command.type === 'string' && normalizeType(command.type) === 'delete-cell-set';
}

function containsAtomicCommand(command: DomainCommand): boolean {
  if (!command || typeof command !== 'object') return false;
  if (isBulkCellCommand(command) || isBulkRecolorCommand(command) || isBulkCompletionCommand(command) || isBulkBackstitchCompletionCommand(command) || isPasteFragmentCommand(command) || isMixedEraseCommand(command) || isDeleteRegionCommand(command) || isDeleteCellSetCommand(command)) return true;
  return isBatchCommand(command)
    && Array.isArray(command.commands)
    && command.commands.some((child) => containsAtomicCommand(child as DomainCommand));
}

/**
 * A bulk command is already a complete atomic gesture. Keeping it out of
 * multi-command batches prevents the packed delta from being silently
 * separated from the other batch mutations.
 */
export function assertBulkBatchPolicy(commands: readonly DomainCommand[]): void {
  const hasBulk = commands.some((command) => containsAtomicCommand(command));
  const isStandaloneBulk = commands.length === 1 && (isBulkCellCommand(commands[0]) || isBulkRecolorCommand(commands[0]) || isBulkCompletionCommand(commands[0]) || isBulkBackstitchCompletionCommand(commands[0]) || isPasteFragmentCommand(commands[0]) || isMixedEraseCommand(commands[0]) || isDeleteRegionCommand(commands[0]) || isDeleteCellSetCommand(commands[0]));
  if (hasBulk && !isStandaloneBulk) {
    throw new DomainError('bulk-batch-unsupported', 'Bulk cell, recolor, completion, backstitch completion, paste-fragment, mixed-erase, delete-region, and delete-cell-set commands must be executed as standalone commands, not in a multi-command batch.');
  }
}

export function applyBulkRecolorCommand(document: PatternDocument, command: DomainCommand, preflight = preflightBulkRecolorCommand(document, command)): MutationInfo {
  if (preflight.changedIndices.length === 0) {
    return {
      changed: false,
      snapshot: false,
      touchedIndices: preflight.indices,
      changedIndices: preflight.changedIndices,
      progress: emptyProgressChangeSet()
    };
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
    progress: emptyProgressChangeSet(),
    delta: {
      cells: { indices: changedIndices, beforeKind, beforeColors, beforeCompleted, afterKind, afterColors, afterCompleted }
    }
  };
}

export function applyBulkCellCommand(document: PatternDocument, command: DomainCommand, preflight = preflightBulkCellCommand(document, command)): MutationInfo {
  if (preflight.changedIndices.length === 0) {
    return {
      changed: false,
      snapshot: false,
      touchedIndices: preflight.indices,
      changedIndices: preflight.changedIndices,
      progress: emptyProgressChangeSet()
    };
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
    progress: emptyProgressChangeSet(),
    delta
  };
}

export function applyBulkCompletionCommand(document: PatternDocument, command: DomainCommand, preflight = preflightBulkCompletionCommand(document, command)): MutationInfo {
  if (preflight.changedIndices.length === 0) {
    return {
      changed: false,
      snapshot: false,
      touchedIndices: preflight.indices,
      changedIndices: preflight.changedIndices,
      progress: emptyProgressChangeSet()
    };
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
    marked += Math.max(0, afterCount - beforeCount);
    unmarked += Math.max(0, beforeCount - afterCount);
  }
  return {
    changed: true,
    snapshot: false,
    touchedIndices: preflight.indices,
    changedIndices: preflight.changedIndices,
    progress: { cellIndices: preflight.changedIndices, backstitchIds: new Uint32Array(0), marked, unmarked },
    delta: {
      cells: {
        indices: new Uint32Array(0),
        beforeKind: new Uint8Array(0),
        beforeColors: new Uint16Array(0),
        beforeCompleted: new Uint8Array(0),
        afterKind: new Uint8Array(0),
        afterColors: new Uint16Array(0),
        afterCompleted: new Uint8Array(0)
      },
      cellCompletions: { indices: preflight.changedIndices, beforeCompleted, afterCompleted }
    }
  };
}

export function applyBulkBackstitchCompletionCommand(document: PatternDocument, command: DomainCommand, preflight = preflightBulkBackstitchCompletionCommand(document, command)): MutationInfo {
  if (preflight.changedIds.length === 0) {
    return {
      changed: false,
      snapshot: false,
      touchedBackstitchIds: preflight.ids,
      changedBackstitchIds: preflight.changedIds,
      progress: emptyProgressChangeSet()
    };
  }
  const beforeCompleted = new Uint8Array(preflight.changedIds.length);
  const afterCompleted = new Uint8Array(preflight.changedIds.length);
  let marked = 0;
  let unmarked = 0;
  for (let position = 0; position < preflight.changedIds.length; position += 1) {
    const id = preflight.changedIds[position];
    const backstitchPosition = backstitchIndex(document, id);
    if (backstitchPosition < 0) throw new DomainError('invalid-completion-target', `Backstitch ID ${String(id)} no longer exists.`);
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
      cells: {
        indices: new Uint32Array(0),
        beforeKind: new Uint8Array(0),
        beforeColors: new Uint16Array(0),
        beforeCompleted: new Uint8Array(0),
        afterKind: new Uint8Array(0),
        afterColors: new Uint16Array(0),
        afterCompleted: new Uint8Array(0)
      },
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
  operationOrCompleted: BulkProgressOperation | boolean,
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
  const command: BulkCompletionCommand = {
    type: 'bulk-completion',
    indices: canonicalIndices,
    ...(typeof operationOrCompleted === 'boolean' ? { completed: operationOrCompleted } : { operation: operationOrCompleted }),
    ...(corner === undefined ? {} : { corner: parseCorner(corner) }),
    ...(masks === undefined ? {} : { masks: masks.slice() }),
    ...(expectedRevision === undefined ? {} : { expectedRevision })
  };
  parseBulkProgressOperation(command);
  return command;
}

export const createBulkCompletionCommand = bulkCompletionCommand;

export function bulkSetCompletionCommand(indices: Uint32Array, corner?: QuarterCorner, expectedRevision?: number, masks?: Uint8Array): BulkCompletionCommand {
  return bulkCompletionCommand(indices, 'set', corner, expectedRevision, masks);
}

export function bulkClearCompletionCommand(indices: Uint32Array, corner?: QuarterCorner, expectedRevision?: number, masks?: Uint8Array): BulkCompletionCommand {
  return bulkCompletionCommand(indices, 'clear', corner, expectedRevision, masks);
}

export function bulkToggleCompletionCommand(indices: Uint32Array, corner?: QuarterCorner, expectedRevision?: number, masks?: Uint8Array): BulkCompletionCommand {
  return bulkCompletionCommand(indices, 'toggle', corner, expectedRevision, masks);
}

export function bulkBackstitchCompletionCommand(
  ids: Uint32Array,
  operationOrCompleted: BulkProgressOperation | boolean,
  expectedRevision?: number
): BulkBackstitchCompletionCommand {
  const canonicalIds = validateProgressCommandArray(ids, 'Bulk backstitch IDs');
  validateExpectedRevision(expectedRevision);
  const command: BulkBackstitchCompletionCommand = {
    type: 'bulk-backstitch-completion',
    ids: canonicalIds,
    ...(typeof operationOrCompleted === 'boolean' ? { completed: operationOrCompleted } : { operation: operationOrCompleted }),
    ...(expectedRevision === undefined ? {} : { expectedRevision })
  };
  parseBulkProgressOperation(command);
  return command;
}

export const createBulkBackstitchCompletionCommand = bulkBackstitchCompletionCommand;

export function bulkSetBackstitchCompletionCommand(ids: Uint32Array, expectedRevision?: number): BulkBackstitchCompletionCommand {
  return bulkBackstitchCompletionCommand(ids, 'set', expectedRevision);
}

export function bulkClearBackstitchCompletionCommand(ids: Uint32Array, expectedRevision?: number): BulkBackstitchCompletionCommand {
  return bulkBackstitchCompletionCommand(ids, 'clear', expectedRevision);
}

export function bulkToggleBackstitchCompletionCommand(ids: Uint32Array, expectedRevision?: number): BulkBackstitchCompletionCommand {
  return bulkBackstitchCompletionCommand(ids, 'toggle', expectedRevision);
}

export function bulkCellCommand(indices: Uint32Array, edit: BulkCellEdit, expectedRevision?: number): BulkCellCommand {
  if (!(indices instanceof Uint32Array)) throw new DomainError('invalid-bulk-indices', 'Bulk cell indices must be a Uint32Array.');
  let previous = -1;
  for (const index of indices) {
    if (index <= previous) throw new DomainError('invalid-bulk-indices', 'Bulk cell indices must be strictly increasing and unique.');
    previous = index;
  }
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw new DomainError('stale-command', 'Expected revision must be a non-negative integer.');
  const canonicalEdit = parseBulkEdit({ type: 'bulk-cell', edit, indices });
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
  let previous = -1;
  for (const index of indices) {
    if (index <= previous) throw new DomainError('invalid-bulk-indices', 'Bulk recolor indices must be strictly increasing and unique.');
    previous = index;
  }
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
  let previousWhole = -1;
  for (const index of wholeCellIndices) {
    if (index <= previousWhole) throw new DomainError('invalid-mixed-erase', 'Whole cell targets must be strictly increasing and unique.');
    previousWhole = index;
  }
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

export function preflightMixedEraseCommand(document: PatternDocument, command: DomainCommand): MixedErasePreflight {
  if (!command || normalizeType(command.type) !== 'mixed-erase') throw new DomainError('invalid-command', 'A mixed erase command must have type mixed-erase.');
  validateBulkRevision(document, command);
  const targets = validateMixedEraseArrays(command.wholeCellIndices, command.componentCellIndices, command.componentCorners, valueOf(command, 'expectedRevision', 'baseRevision', 'revision'));
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

export function applyMixedEraseCommand(document: PatternDocument, command: DomainCommand, preflight = preflightMixedEraseCommand(document, command)): MutationInfo {
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
  if (changedPosition === 0) return { changed: false, snapshot: false, changedIndices, progress: emptyProgressChangeSet() };
  const delta: SparseMutationDelta = { cells: { indices: changedIndices, beforeKind, beforeColors, beforeCompleted, afterKind, afterColors, afterCompleted } };
  return { changed: true, snapshot: false, changedIndices, progress: emptyProgressChangeSet(), delta };
}

export function mixedEraseCommand(wholeCellIndices: Uint32Array, componentCellIndices: Uint32Array, componentCorners: Uint8Array, expectedRevision?: number): MixedEraseCommand {
  const targets = validateMixedEraseArrays(wholeCellIndices, componentCellIndices, componentCorners, expectedRevision);
  return { type: 'mixed-erase', wholeCellIndices: targets.wholeCellIndices.slice(), componentCellIndices: targets.componentCellIndices.slice(), componentCorners: targets.componentCorners.slice(), ...(expectedRevision === undefined ? {} : { expectedRevision }) };
}

export const createMixedEraseCommand = mixedEraseCommand;
export const eraseMixedCommand = mixedEraseCommand;

function parseDeleteRegion(command: DomainCommand): CropRect {
  const raw = valueOf(command, 'rect', 'region', 'selection');
  const source = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : command;
  const x = requiredNumber(source.x ?? source.left ?? source.x0, 'delete region x');
  const y = requiredNumber(source.y ?? source.top ?? source.y0, 'delete region y');
  const widthValue = source.width;
  const heightValue = source.height;
  const right = source.right ?? source.x1;
  const bottom = source.bottom ?? source.y1;
  const width = widthValue === undefined ? requiredNumber(right, 'delete region right') - x : requiredNumber(widthValue, 'delete region width');
  const height = heightValue === undefined ? requiredNumber(bottom, 'delete region bottom') - y : requiredNumber(heightValue, 'delete region height');
  return { x, y, width, height };
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
export function preflightDeleteRegionCommand(document: PatternDocument, command: DomainCommand): DeleteRegionPreflight {
  if (!command || normalizeType(command.type) !== 'delete-region') throw new DomainError('invalid-command', 'A delete-region command must have type delete-region.');
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
  if (!Number.isSafeInteger(changedCellCount) || changedCellCount < 0
    || !Number.isSafeInteger(existingBackstitchCount) || existingBackstitchCount < 0
    || !Number.isSafeInteger(deletedBackstitchCount) || deletedBackstitchCount < 0
    || deletedBackstitchCount > existingBackstitchCount) {
    throw new DomainError('invalid-delete-region', 'Delete region history counts are invalid.');
  }
  if (changedCellCount === 0 && deletedBackstitchCount === 0) return 0;
  const cellBytes = changedCellCount * 24;
  const backstitchBytes = deletedBackstitchCount === 0
    ? 0
    : backstitchStoreBytes(existingBackstitchCount) + backstitchStoreBytes(existingBackstitchCount - deletedBackstitchCount);
  return cellBytes + backstitchBytes + 32;
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
    beforeBackstitches = cloneBackstitchStore(document.backstitches);
    const deleted = new Set<number>(preflight.changedBackstitchIds);
    const retained: BackstitchRecord[] = [];
    for (const record of listBackstitches(document)) {
      addBackstitchImpact(impactEntries, record, 'before');
      if (!deleted.has(record.id)) {
        addBackstitchImpact(impactEntries, record, 'after');
        retained.push(record);
      }
    }
    replaceBackstitches(document, retained);
    afterBackstitches = cloneBackstitchStore(document.backstitches);
  } else if (impactEntries.size > 0) {
    for (const record of listBackstitches(document)) {
      addBackstitchImpact(impactEntries, record, 'before');
      addBackstitchImpact(impactEntries, record, 'after');
    }
  }

  if (changedIndices.length === 0 && preflight.changedBackstitchIds.length === 0) {
    return {
      changed: false,
      snapshot: false,
      touchedIndices: preflight.touchedIndices,
      changedIndices,
      changedBackstitchIds: preflight.changedBackstitchIds,
      progress: emptyProgressChangeSet()
    };
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
    progress: emptyProgressChangeSet(),
    recalculateMetrics: true,
    delta
  };
}

export function applyDeleteRegionCommand(
  document: PatternDocument,
  command: DomainCommand,
  preflight = preflightDeleteRegionCommand(document, command)
): MutationInfo {
  return applyDeleteSelectionCommand(document, preflight);
}

export interface DeleteCellSetPreflight extends DeleteSelectionPreflight {
  readonly indices: Uint32Array;
}

function validateDeleteCellSetIndices(document: PatternDocument, indices: unknown): Uint32Array {
  if (!(indices instanceof Uint32Array) || indices.length === 0) throw new DomainError('invalid-delete-cell-set', 'Delete cell-set indices must be a non-empty Uint32Array.');
  let previous = -1;
  for (const index of indices) {
    if (index <= previous) throw new DomainError('invalid-delete-cell-set', 'Delete cell-set indices must be strictly increasing and unique.');
    if (index >= document.kind.length) throw new DomainError('out-of-bounds', `Delete cell-set index ${String(index)} is out of bounds.`);
    previous = index;
  }
  return indices;
}

/** Validate a sparse cell-set deletion without changing the document. */
export function preflightDeleteCellSetCommand(document: PatternDocument, command: DomainCommand): DeleteCellSetPreflight {
  if (!command || normalizeType(command.type) !== 'delete-cell-set') throw new DomainError('invalid-command', 'A delete-cell-set command must have type delete-cell-set.');
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
  command: DomainCommand,
  preflight = preflightDeleteCellSetCommand(document, command)
): MutationInfo {
  return applyDeleteSelectionCommand(document, preflight);
}

export function deleteCellSetCommand(indices: Uint32Array, expectedRevision?: number): DeleteCellSetCommand {
  if (!(indices instanceof Uint32Array) || indices.length === 0) throw new DomainError('invalid-delete-cell-set', 'Delete cell-set indices must be a non-empty Uint32Array.');
  let previous = -1;
  for (const index of indices) {
    if (index <= previous) throw new DomainError('invalid-delete-cell-set', 'Delete cell-set indices must be strictly increasing and unique.');
    previous = index;
  }
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

function parsePasteDestination(command: DomainCommand): { x: number; y: number } {
  const raw = valueOf(command, 'destination', 'origin', 'at');
  const source = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : command;
  return {
    x: requiredNumber(source.x, 'paste destination x'),
    y: requiredNumber(source.y, 'paste destination y')
  };
}

function pasteCellWouldChange(document: PatternDocument, targetIndex: number, fragment: PatternFragment, sourceIndex: number): boolean {
  const sourceKind = fragment.kind[sourceIndex];
  if (sourceKind === CellKind.Empty) return false;
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

function validatePasteBackstitches(document: PatternDocument, fragment: PatternFragment, destinationX: number, destinationY: number): void {
  const geometries = new Set<string>();
  for (let index = 0; index < document.backstitches.ids.length; index += 1) geometries.add(`${String(document.backstitches.x1[index])},${String(document.backstitches.y1[index])},${String(document.backstitches.x2[index])},${String(document.backstitches.y2[index])}`);
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
    const key = `${String(x1)},${String(y1)},${String(x2)},${String(y2)}`;
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
}

export function preflightPasteFragmentCommand(document: PatternDocument, command: DomainCommand): PasteFragmentPreflight {
  if (!command || normalizeType(command.type) !== 'paste-fragment') throw new DomainError('invalid-command', 'A paste fragment command must have type paste-fragment.');
  validateBulkRevision(document, command);
  const fragment = command.fragment as PatternFragment;
  assertValidPatternFragment(fragment);
  const destination = parsePasteDestination(command);
  if (destination.x < 0 || destination.y < 0 || destination.x + fragment.width > document.width || destination.y + fragment.height > document.height) throw new DomainError('paste-out-of-bounds', 'The fragment must fit entirely inside the destination document.');
  validatePastePalette(document, fragment);
  validatePasteBackstitches(document, fragment, destination.x, destination.y);
  const nextId = document.nextBackstitchId;
  if (fragment.backstitches.x1.length > 0 && (nextId > UINT32_MAX || nextId + fragment.backstitches.x1.length - 1 > UINT32_MAX)) throw new DomainError('backstitch-id-exhausted', 'The destination has no remaining backstitch IDs for this paste.');
  let changedCellCount = 0;
  for (let y = 0; y < fragment.height; y += 1) {
    for (let x = 0; x < fragment.width; x += 1) {
      const sourceIndex = y * fragment.width + x;
      const targetIndex = (destination.y + y) * document.width + destination.x + x;
      if (pasteCellWouldChange(document, targetIndex, fragment, sourceIndex)) changedCellCount += 1;
    }
  }
  return { fragment, destinationX: destination.x, destinationY: destination.y, changedCellCount, newBackstitchCount: fragment.backstitches.x1.length };
}

function backstitchStoreBytes(count: number): number {
  return count * 23;
}

export function estimatePasteFragmentHistoryBytes(changedCellCount: number, existingBackstitchCount: number, newBackstitchCount: number): number {
  if (!Number.isSafeInteger(changedCellCount) || changedCellCount < 0 || !Number.isSafeInteger(existingBackstitchCount) || existingBackstitchCount < 0 || !Number.isSafeInteger(newBackstitchCount) || newBackstitchCount < 0) throw new DomainError('invalid-fragment', 'Paste history counts are invalid.');
  if (changedCellCount === 0 && newBackstitchCount === 0) return 0;
  const cellBytes = changedCellCount * 24;
  const backstitchBytes = newBackstitchCount === 0 ? 0 : backstitchStoreBytes(existingBackstitchCount) + backstitchStoreBytes(existingBackstitchCount + newBackstitchCount);
  return cellBytes + backstitchBytes + 32;
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

function createPastedBackstitches(document: PatternDocument, fragment: PatternFragment, destinationX: number, destinationY: number): { before: BackstitchStore; after: BackstitchStore; ids: Uint32Array } {
  const before = cloneBackstitchStore(document.backstitches);
  const oldCount = document.backstitches.ids.length;
  const newCount = fragment.backstitches.x1.length;
  const after: BackstitchStore = {
    ids: new Uint32Array(oldCount + newCount),
    x1: new Uint32Array(oldCount + newCount),
    y1: new Uint32Array(oldCount + newCount),
    x2: new Uint32Array(oldCount + newCount),
    y2: new Uint32Array(oldCount + newCount),
    colors: new Uint16Array(oldCount + newCount),
    completed: new Uint8Array(oldCount + newCount)
  };
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
    const id = document.nextBackstitchId + index;
    ids[index] = id;
    after.ids[target] = id;
    after.x1[target] = fragment.backstitches.x1[index] + offsetX;
    after.y1[target] = fragment.backstitches.y1[index] + offsetY;
    after.x2[target] = fragment.backstitches.x2[index] + offsetX;
    after.y2[target] = fragment.backstitches.y2[index] + offsetY;
    after.colors[target] = fragment.backstitches.colors[index];
  }
  return { before, after, ids };
}

export function applyPasteFragmentCommand(document: PatternDocument, command: DomainCommand, preflight = preflightPasteFragmentCommand(document, command)): MutationInfo {
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
    const stores = createPastedBackstitches(document, preflight.fragment, preflight.destinationX, preflight.destinationY);
    beforeBackstitches = stores.before;
    afterBackstitches = stores.after;
    createdBackstitchIds = stores.ids;
    document.backstitches = cloneBackstitchStore(stores.after);
    document.nextBackstitchId += preflight.newBackstitchCount;
  }
  const changed = changedIndices.length > 0 || preflight.newBackstitchCount > 0;
  if (!changed) return { changed: false, snapshot: false, changedIndices, progress: emptyProgressChangeSet() };
  const delta: SparseMutationDelta = {
    cells: { indices: changedIndices, beforeKind, beforeColors, beforeCompleted, afterKind, afterColors, afterCompleted },
    ...(beforeBackstitches === undefined ? {} : { beforeBackstitches, afterBackstitches }),
    ...(preflight.newBackstitchCount === 0 ? {} : { beforeNextBackstitchId: document.nextBackstitchId - preflight.newBackstitchCount, afterNextBackstitchId: document.nextBackstitchId })
  };
  return { changed: true, snapshot: false, changedIndices, createdBackstitchIds, progress: emptyProgressChangeSet(), delta };
}

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

function writeQuarters(document: PatternDocument, x: number, y: number, colors: number[]): boolean {
  if (colors.length !== 4) throw new DomainError('invalid-command', 'A quarter set requires four color slots.');
  const index = cellIndex(document, x, y);
  return writeQuartersAtIndex(document, index, colors);
}

function cellCommand(document: PatternDocument, command: DomainCommand): MutationInfo {
  const x = requiredNumber(valueOf(command, 'x', 'column'), 'x');
  const y = requiredNumber(valueOf(command, 'y', 'row'), 'y');
  const modeValue = valueOf(command, 'kind', 'mode', 'stitch');
  const normalizedMode = typeof modeValue === 'string' ? modeValue.toLowerCase().replace(/[-_ ]/g, '') : '';
  if (normalizedMode === 'threequarter' || normalizedMode === 'threequarters') {
    return writeThreeQuarter(document, x, y, parseCorner(valueOf(command, 'corner', 'quarter', 'slot')), parseColor(command)) ? changed() : noChange();
  }
  const kind = modeValue === undefined ? CellKind.Full : parseKind(modeValue);
  if (kind === CellKind.Empty) return clearCell(document, cellIndex(document, x, y)) ? changed() : noChange();
  if (kind === CellKind.Full) return writeFull(document, x, y, parseColor(command)) ? changed() : noChange();
  if (kind === CellKind.ThreeQuarterPair) {
    const rawColors = valueOf(command, 'colors', 'threeQuarterColors', 'pairColors');
    if (!Array.isArray(rawColors) || rawColors.length !== 4) throw new DomainError('invalid-command', 'A three-quarter pair requires four physical color slots.');
    const pairColors = rawColors.map((value) => requiredNumber(value, 'three-quarter pair color'));
    for (const color of pairColors) if (color !== 0) requirePaletteEntry(document, color);
    return writeThreeQuarterPairAtIndex(document, cellIndex(document, x, y), pairColors) ? changed() : noChange();
  }
  if (isThreeQuarterKind(kind)) {
    const color = parseColor(command);
    requirePaletteEntry(document, color);
    return writeThreeQuarterKindAtIndex(document, cellIndex(document, x, y), kind, color) ? changed() : noChange();
  }
  if (kind === CellKind.HalfBackslash || kind === CellKind.HalfSlash) {
    const direction = typeof modeValue === 'string' && modeValue.toLowerCase() === 'half'
      ? parseDirection(valueOf(command, 'direction', 'diagonal', 'slash'))
      : kind === CellKind.HalfBackslash ? HalfDirection.Backslash : HalfDirection.Slash;
    return writeFull(document, x, y, parseColor(command), direction) ? changed() : noChange();
  }
  if (kind === CellKind.Quarters) {
    const rawColors = valueOf(command, 'colors', 'quarterColors');
    if (Array.isArray(rawColors)) {
      const quarterColors = rawColors.map((value) => requiredNumber(value, 'quarter color'));
      return writeQuarters(document, x, y, quarterColors) ? changed() : noChange();
    }
    const cornerValue = valueOf(command, 'corner', 'quarter', 'slot');
    return writeQuarter(document, x, y, parseCorner(cornerValue), parseColor(command)) ? changed() : noChange();
  }
  return noChange();
}

function applySetFullCommand(document: PatternDocument, command: DomainCommand): MutationInfo {
  const x = requiredNumber(valueOf(command, 'x', 'column'), 'x');
  const y = requiredNumber(valueOf(command, 'y', 'row'), 'y');
  return writeFull(document, x, y, parseColor(command)) ? changed() : noChange();
}

function applySetHalfCommand(document: PatternDocument, command: DomainCommand): MutationInfo {
  const x = requiredNumber(valueOf(command, 'x', 'column'), 'x');
  const y = requiredNumber(valueOf(command, 'y', 'row'), 'y');
  const direction = parseDirection(valueOf(command, 'direction', 'diagonal', 'slash'));
  return writeFull(document, x, y, parseColor(command), direction) ? changed() : noChange();
}

function applySetThreeQuarterCommand(document: PatternDocument, command: DomainCommand): MutationInfo {
  const x = requiredNumber(valueOf(command, 'x', 'column'), 'x');
  const y = requiredNumber(valueOf(command, 'y', 'row'), 'y');
  const corner = parseCorner(valueOf(command, 'corner', 'quarter', 'slot'));
  return writeThreeQuarter(document, x, y, corner, parseColor(command)) ? changed() : noChange();
}

function quarterCommand(document: PatternDocument, command: DomainCommand): MutationInfo {
  const x = requiredNumber(valueOf(command, 'x', 'column'), 'x');
  const y = requiredNumber(valueOf(command, 'y', 'row'), 'y');
  const corner = parseCorner(valueOf(command, 'corner', 'quarter', 'slot'));
  const rawColor = valueOf(command, 'color', 'paletteId', 'colorId');
  const color = requiredNumber(rawColor, 'color');
  if (color === 0) return removeQuarter(document, x, y, corner) ? changed() : noChange();
  return writeQuarter(document, x, y, corner, color) ? changed() : noChange();
}

function recolorCell(document: PatternDocument, command: DomainCommand): MutationInfo {
  const x = requiredNumber(valueOf(command, 'x', 'column'), 'x');
  const y = requiredNumber(valueOf(command, 'y', 'row'), 'y');
  const color = parseColor(command);
  requirePaletteEntry(document, color);
  const index = cellIndex(document, x, y);
  const offset = colorsOffset(index);
  const cornerValue = valueOf(command, 'corner', 'quarter', 'slot');
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

function completionCommand(document: PatternDocument, command: DomainCommand, toggle: boolean): MutationInfo {
  const x = requiredNumber(valueOf(command, 'x', 'column'), 'x');
  const y = requiredNumber(valueOf(command, 'y', 'row'), 'y');
  const index = cellIndex(document, x, y);
  const offset = colorsOffset(index);
  const cornerValue = valueOf(command, 'corner', 'quarter', 'slot');
  const requested = toggle ? undefined : requiredBoolean(valueOf(command, 'completed', 'complete'), 'completed');
  if (document.kind[index] === CellKind.Empty) return noChange();
  const beforeCount = completedComponentCountForCell(document, index);
  if (document.kind[index] === CellKind.Quarters && cornerValue !== undefined) {
    const corner = parseCorner(cornerValue);
    if (document.colors[offset + corner] === 0) return noChange();
    const bit = 1 << corner;
    const next = toggle ? (document.completed[index] ^ bit) : requested ? document.completed[index] | bit : document.completed[index] & ~bit;
    if (next === document.completed[index]) return noChange();
    document.completed[index] = next;
    return changed(false, progressForCell(index, beforeCount, completedComponentCountForCell(document, index)));
  }
  if (cornerValue !== undefined && (isThreeQuarterKind(document.kind[index]) || isThreeQuarterPairKind(document.kind[index]))) {
    const requestedCorner = parseCorner(cornerValue);
    const singleCorner = threeQuarterCornerForKind(document.kind[index]);
    const bit = singleCorner === undefined ? 1 << requestedCorner : singleCorner === requestedCorner ? 1 : 0;
    if (bit === 0 || (isThreeQuarterPairKind(document.kind[index]) && document.colors[offset + requestedCorner] === 0)) return noChange();
    const next = toggle ? document.completed[index] ^ bit : requested ? document.completed[index] | bit : document.completed[index] & ~bit;
    if (next === document.completed[index]) return noChange();
    document.completed[index] = next;
    return changed(false, progressForCell(index, beforeCount, completedComponentCountForCell(document, index)));
  }
  const slots = document.kind[index] === CellKind.Quarters
    ? [0, 1, 2, 3]
    : isThreeQuarterPairKind(document.kind[index]) ? [0, 1, 2, 3] : [0];
  let nextMask = document.completed[index];
  for (const slot of slots) {
    if (document.colors[offset + slot] === 0) continue;
    const bit = 1 << slot;
    nextMask = toggle ? nextMask ^ bit : requested ? nextMask | bit : nextMask & ~bit;
  }
  if (nextMask === document.completed[index]) return noChange();
  document.completed[index] = nextMask;
  return changed(false, progressForCell(index, beforeCount, completedComponentCountForCell(document, index)));
}

function parsePoint(value: unknown, label: string): Point {
  if (Array.isArray(value) && value.length === 2) {
    return { x: requiredNumber(value[0], `${label}.x`), y: requiredNumber(value[1], `${label}.y`) };
  }
  if (typeof value === 'object' && value !== null && 'x' in value && 'y' in value) {
    const pointValue = value as { x: unknown; y: unknown };
    return { x: requiredNumber(pointValue.x, `${label}.x`), y: requiredNumber(pointValue.y, `${label}.y`) };
  }
  throw new DomainError('invalid-point', `${label} must contain integer x and y coordinates.`);
}

function parseEndpoints(command: DomainCommand): { start: Point; end: Point } {
  const startValue = valueOf(command, 'start', 'from', 'a');
  const endValue = valueOf(command, 'end', 'to', 'b');
  if (startValue !== undefined && endValue !== undefined) return canonicalEndpoints(parsePoint(startValue, 'start'), parsePoint(endValue, 'end'));
  const start = { x: requiredNumber(valueOf(command, 'x1', 'startX', 'fromX'), 'x1'), y: requiredNumber(valueOf(command, 'y1', 'startY', 'fromY'), 'y1') };
  const end = { x: requiredNumber(valueOf(command, 'x2', 'endX', 'toX'), 'x2'), y: requiredNumber(valueOf(command, 'y2', 'endY', 'toY'), 'y2') };
  return canonicalEndpoints(start, end);
}

function snapBackstitchEndpoint(point: Point): Point {
  return { x: Math.round(point.x / 4) * 4, y: Math.round(point.y / 4) * 4 };
}

function snapBackstitchEndpoints(document: PatternDocument, start: Point, end: Point): { start: Point; end: Point } {
  if (!endpointInBounds(document, start) || !endpointInBounds(document, end)) {
    throw new DomainError('out-of-bounds', 'Backstitch endpoints must be within the document boundary.');
  }
  return canonicalEndpoints(
    snapBackstitchEndpoint(start),
    snapBackstitchEndpoint(end)
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
    start.x === current.x1 && start.y === current.y1 ? start : snapBackstitchEndpoint(start),
    end.x === current.x2 && end.y === current.y2 ? end : snapBackstitchEndpoint(end)
  );
}

function canonicalEndpoints(start: Point, end: Point): { start: Point; end: Point } {
  if (start.x < end.x || (start.x === end.x && start.y <= end.y)) return { start, end };
  return { start: end, end: start };
}

function segmentKey(start: Point, end: Point): string {
  return `${String(start.x)},${String(start.y)},${String(end.x)},${String(end.y)}`;
}

function endpointInBounds(document: PatternDocument, pointValue: Point): boolean {
  return pointValue.x >= 0 && pointValue.y >= 0 && pointValue.x <= document.width * 4 && pointValue.y <= document.height * 4;
}

function ensureBackstitchEndpoints(document: PatternDocument, start: Point, end: Point): void {
  if (start.x === end.x && start.y === end.y) throw new DomainError('invalid-backstitch', 'A backstitch cannot have identical endpoints.');
  if (!endpointInBounds(document, start) || !endpointInBounds(document, end)) throw new DomainError('out-of-bounds', 'Backstitch endpoints must be within the document boundary.');
}

function backstitchIndex(document: PatternDocument, id: number): number {
  for (let index = 0; index < document.backstitches.ids.length; index += 1) if (document.backstitches.ids[index] === id) return index;
  return -1;
}

function replaceBackstitches(document: PatternDocument, records: BackstitchRecord[]): void {
  const store = {
    ids: new Uint32Array(records.length),
    x1: new Uint32Array(records.length),
    y1: new Uint32Array(records.length),
    x2: new Uint32Array(records.length),
    y2: new Uint32Array(records.length),
    colors: new Uint16Array(records.length),
    completed: new Uint8Array(records.length)
  };
  records.forEach((record, index) => {
    store.ids[index] = record.id;
    store.x1[index] = record.x1;
    store.y1[index] = record.y1;
    store.x2[index] = record.x2;
    store.y2[index] = record.y2;
    store.colors[index] = record.color;
    store.completed[index] = record.completed ? 1 : 0;
  });
  document.backstitches = store;
}

function applyAddBackstitch(document: PatternDocument, command: DomainCommand): MutationInfo {
  const requested = parseEndpoints(command);
  const { start, end } = snapBackstitchEndpoints(document, requested.start, requested.end);
  ensureBackstitchEndpoints(document, start, end);
  const color = parseColor(command);
  requirePaletteEntry(document, color);
  const key = segmentKey(start, end);
  if (listBackstitches(document).some((record) => segmentKey(record.start, record.end) === key)) {
    throw new DomainError('duplicate-backstitch', 'A backstitch with these endpoints already exists.');
  }
  const requestedId = valueOf(command, 'id', 'backstitchId', 'segmentId');
  const id = requestedId === undefined ? document.nextBackstitchId : requiredNumber(requestedId, 'id');
  if (id < 1 || id > UINT32_MAX || id < document.nextBackstitchId || backstitchIndex(document, id) >= 0) {
    throw new DomainError('invalid-backstitch-id', `Backstitch ID ${String(id)} cannot be allocated.`);
  }
  const records = listBackstitches(document);
  records.push({
    id,
    x1: start.x,
    y1: start.y,
    x2: end.x,
    y2: end.y,
    start,
    end,
    color,
    completed: false
  });
  replaceBackstitches(document, records);
  document.nextBackstitchId = id + 1;
  return { ...changed(), backstitchId: id };
}

function applyRemoveBackstitch(document: PatternDocument, command: DomainCommand): MutationInfo {
  const id = requiredNumber(valueOf(command, 'id', 'backstitchId', 'segmentId'), 'id');
  const index = backstitchIndex(document, id);
  if (index < 0) return noChange();
  const records = listBackstitches(document);
  records.splice(index, 1);
  replaceBackstitches(document, records);
  return changed();
}

function applyMoveBackstitch(document: PatternDocument, command: DomainCommand): MutationInfo {
  const id = requiredNumber(valueOf(command, 'id', 'backstitchId', 'segmentId'), 'id');
  const index = backstitchIndex(document, id);
  if (index < 0) return noChange();
  const records = listBackstitches(document);
  const current = records[index];
  let endpoints: { start: Point; end: Point };
  if (valueOf(command, 'dx') !== undefined || valueOf(command, 'dy') !== undefined) {
    const dx = requiredNumber(valueOf(command, 'dx'), 'dx');
    const dy = requiredNumber(valueOf(command, 'dy'), 'dy');
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
  const key = segmentKey(start, end);
  if (records.some((record, candidateIndex) => candidateIndex !== index && segmentKey(record.start, record.end) === key)) {
    throw new DomainError('duplicate-backstitch', 'A backstitch with these endpoints already exists.');
  }
  if (current.x1 === start.x && current.y1 === start.y && current.x2 === end.x && current.y2 === end.y) return noChange();
  // Changing endpoints changes the stitch geometry. A whole-document rotate
  // or mirror is handled separately and deliberately carries this bit along.
  records[index] = { ...current, x1: start.x, y1: start.y, x2: end.x, y2: end.y, start, end, completed: false };
  replaceBackstitches(document, records);
  return changed();
}

function applyRecolorBackstitch(document: PatternDocument, command: DomainCommand): MutationInfo {
  const id = requiredNumber(valueOf(command, 'id', 'backstitchId', 'segmentId'), 'id');
  const index = backstitchIndex(document, id);
  if (index < 0) return noChange();
  const color = parseColor(command);
  requirePaletteEntry(document, color);
  if (document.backstitches.colors[index] === color) return noChange();
  document.backstitches.colors[index] = color;
  return changed();
}

function applySetBackstitchCompletion(document: PatternDocument, command: DomainCommand, toggle: boolean): MutationInfo {
  const id = requiredNumber(valueOf(command, 'id', 'backstitchId', 'segmentId'), 'id');
  const index = backstitchIndex(document, id);
  if (index < 0) return noChange();
  const before = document.backstitches.completed[index] === 0 ? 0 : 1;
  const next = toggle ? document.backstitches.completed[index] ^ 1 : requiredBoolean(valueOf(command, 'completed', 'complete'), 'completed') ? 1 : 0;
  if (document.backstitches.completed[index] === next) return noChange();
  document.backstitches.completed[index] = next;
  return changed(false, progressForBackstitch(id, before, next));
}

function applyUpdateBackstitch(document: PatternDocument, command: DomainCommand): MutationInfo {
  const id = requiredNumber(valueOf(command, 'id', 'backstitchId', 'segmentId'), 'id');
  const index = backstitchIndex(document, id);
  if (index < 0) return noChange();
  const hasEndpoints = valueOf(command, 'start', 'from', 'a', 'x1', 'startX', 'fromX', 'dx', 'dy') !== undefined;
  let didChange = false;
  if (hasEndpoints) {
    const moveResult = applyMoveBackstitch(document, command);
    didChange = moveResult.changed;
  }
  if (valueOf(command, 'color', 'paletteId', 'colorId') !== undefined) {
    const recolorResult = applyRecolorBackstitch(document, command);
    didChange = recolorResult.changed || didChange;
  }
  return didChange ? changed() : noChange();
}

function paletteCreate(document: PatternDocument, command: DomainCommand): MutationInfo {
  const source = typeof command.entry === 'object' && command.entry !== null ? command.entry as Record<string, unknown> : command;
  const requestedId = source.id;
  const id = requestedId === undefined ? document.nextPaletteId : requiredNumber(requestedId, 'id');
  const name = source.name;
  const color = source.color;
  if (typeof name !== 'string' || name.trim() === '' || typeof color !== 'string' || color.trim() === '') throw new DomainError('invalid-palette', 'Palette name and color are required.');
  if (id > MAX_PALETTE_COLORS) throw new DomainError('invalid-palette-id', `The palette cannot exceed the brand's color count (${String(MAX_PALETTE_COLORS)}).`);
  if (id < 1 || id > PALETTE_ID_MAX || id < document.nextPaletteId || findPaletteEntry(document, id)) throw new DomainError('invalid-palette-id', `Palette ID ${String(id)} cannot be allocated.`);
  // Auto-assignment takes the first glyph not already used in the document so
  // growing palettes never collide. Only once every glyph is taken does it
  // overflow onto the cycled default — that overflow is exempt from the
  // duplicate guard below so auto-adding colors never fails. Explicit symbols
  // keep the guard.
  let autoOverflow = false;
  let symbol: string;
  if (source.symbol !== undefined) {
    symbol = source.symbol as string;
  } else {
    const used = new Set(document.palette.map((candidate) => candidate.symbol));
    const free = PALETTE_SYMBOLS.find((glyph) => !used.has(glyph));
    if (free !== undefined) {
      symbol = free;
    } else {
      symbol = defaultPaletteSymbol(id);
      autoOverflow = true;
    }
  }
  const entry = normalizePaletteEntry({
    id,
    name: name as string,
    color: color as string,
    active: source.active !== false,
    symbol,
    ...(source.material === undefined ? {} : { material: source.material as PaletteEntry['material'] }),
    ...(source.catalog === undefined ? {} : { catalog: source.catalog as PaletteEntry['catalog'] })
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

function paletteUpdate(document: PatternDocument, command: DomainCommand): MutationInfo {
  const id = requiredNumber(valueOf(command, 'id', 'paletteId', 'colorId'), 'id');
  const entry = findPaletteEntry(document, id);
  if (!entry) throw new DomainError('unknown-palette', `Palette ID ${String(id)} does not exist.`);
  const nextName = valueOf(command, 'name');
  const nextColor = valueOf(command, 'color');
  const nextActive = valueOf(command, 'active');
  const nextSymbol = valueOf(command, 'symbol');
  const nextMaterial = valueOf(command, 'material');
  const nextCatalog = valueOf(command, 'catalog');
  if (nextName !== undefined && (typeof nextName !== 'string' || nextName.trim() === '')) throw new DomainError('invalid-palette', 'Palette names must not be empty.');
  if (nextColor !== undefined && (typeof nextColor !== 'string' || nextColor.trim() === '')) throw new DomainError('invalid-palette', 'Palette colors must not be empty.');
  if (nextActive !== undefined && typeof nextActive !== 'boolean') throw new DomainError('invalid-palette', 'Palette active must be a boolean.');
  const next = normalizePaletteEntry({
    ...entry,
    name: nextName === undefined ? entry.name : nextName as string,
    color: nextColor === undefined ? entry.color : nextColor as string,
    active: nextActive === undefined ? entry.active : nextActive as boolean,
    symbol: nextSymbol === undefined ? entry.symbol : nextSymbol as string,
    material: nextMaterial === undefined ? entry.material : nextMaterial as PaletteEntry['material'],
    catalog: nextCatalog === undefined ? entry.catalog : nextCatalog as PaletteEntry['catalog']
  });
  if (document.palette.some((candidate) => candidate.id !== id && candidate.symbol === next.symbol)) throw new DomainError('invalid-palette-symbol', `Palette symbol ${next.symbol} is duplicated.`);
  if (nextActive === false && entry.active && paletteIsReferenced(document, id)) throw new DomainError('palette-in-use', `Palette ID ${String(id)} is referenced by the document.`);
  const changedEntry = !samePalette([entry], [next]);
  if (!changedEntry) return noChange();
  document.palette = document.palette.map((candidate) => candidate.id !== id ? candidate : next);
  return changed();
}

function paletteDeactivate(document: PatternDocument, command: DomainCommand): MutationInfo {
  const id = requiredNumber(valueOf(command, 'id', 'paletteId', 'colorId'), 'id');
  const entry = findPaletteEntry(document, id);
  if (!entry) throw new DomainError('unknown-palette', `Palette ID ${String(id)} does not exist.`);
  if (!entry.active) return noChange();
  if (paletteIsReferenced(document, id)) throw new DomainError('palette-in-use', `Palette ID ${String(id)} is referenced by the document.`);
  document.palette = document.palette.map((candidate) => candidate.id === id ? { ...candidate, active: false } : candidate);
  return changed();
}

function paletteMerge(document: PatternDocument, command: DomainCommand): MutationInfo {
  const from = requiredNumber(valueOf(command, 'from', 'fromId', 'targetId', 'sourceId', 'removeId', 'paletteId', 'id'), 'from');
  const createInput = valueOf(command, 'createTo', 'createReplacement');
  const toValue = valueOf(command, 'to', 'toId', 'replaceWithId', 'replacement', 'mergeInto');
  const fromEntry = findPaletteEntry(document, from);
  if (!fromEntry) throw new DomainError('unknown-palette', `Palette ID ${String(from)} does not exist.`);
  const to = toValue === undefined ? document.nextPaletteId : requiredNumber(toValue, 'to');
  let toEntry = findPaletteEntry(document, to);
  if (!toEntry) {
    if (createInput === undefined || typeof createInput !== 'object' || createInput === null) throw new DomainError('unknown-palette', `Palette ID ${String(to)} does not exist.`);
    paletteCreate(document, { type: 'palette-create', ...createInput as Record<string, unknown>, id: to, active: true });
    toEntry = findPaletteEntry(document, to);
  }
  if (from === to) throw new DomainError('palette-merge', 'A palette color cannot merge into itself.');
  if (!toEntry) throw new DomainError('unknown-palette', `Palette ID ${String(to)} does not exist.`);
  if (!toEntry.active) throw new DomainError('palette-inactive', `Palette ID ${String(to)} is not active.`);
  const before = cloneDocument(document);
  for (let index = 0; index < document.colors.length; index += 1) if (document.colors[index] === from) document.colors[index] = to;
  for (let index = 0; index < document.backstitches.colors.length; index += 1) if (document.backstitches.colors[index] === from) document.backstitches.colors[index] = to;
  if (fromEntry.active) document.palette = document.palette.map((candidate) => candidate.id === from ? { ...candidate, active: false } : candidate);
  return sameContent(before, document) ? noChange() : changed(true);
}

function mapCornerCW(corner: QuarterCorner): QuarterCorner {
  return [QuarterCorner.NE, QuarterCorner.SE, QuarterCorner.SW, QuarterCorner.NW][corner] as QuarterCorner;
}

function mapCornerCCW(corner: QuarterCorner): QuarterCorner {
  return [QuarterCorner.SW, QuarterCorner.NW, QuarterCorner.NE, QuarterCorner.SE][corner] as QuarterCorner;
}

function mapCornerHorizontal(corner: QuarterCorner): QuarterCorner {
  return [QuarterCorner.NE, QuarterCorner.NW, QuarterCorner.SW, QuarterCorner.SE][corner] as QuarterCorner;
}

function mapCornerVertical(corner: QuarterCorner): QuarterCorner {
  return [QuarterCorner.SW, QuarterCorner.SE, QuarterCorner.NE, QuarterCorner.NW][corner] as QuarterCorner;
}

function rotatePoint(pointValue: Point, width: number, height: number, clockwise: boolean): Point {
  return clockwise ? { x: height * 4 - pointValue.y, y: pointValue.x } : { x: pointValue.y, y: width * 4 - pointValue.x };
}

function rotateOnce(document: PatternDocument, clockwise: boolean): void {
  const oldWidth = document.width;
  const oldHeight = document.height;
  const oldKind = document.kind;
  const oldColors = document.colors;
  const oldCompleted = document.completed;
  const nextWidth = oldHeight;
  const nextHeight = oldWidth;
  const nextKind = new Uint8Array(nextWidth * nextHeight);
  const nextColors = new Uint16Array(nextWidth * nextHeight * 4);
  const nextCompleted = new Uint8Array(nextWidth * nextHeight);
  for (let y = 0; y < oldHeight; y += 1) {
    for (let x = 0; x < oldWidth; x += 1) {
      const oldIndex = y * oldWidth + x;
      const nextX = clockwise ? oldHeight - 1 - y : y;
      const nextY = clockwise ? x : oldWidth - 1 - x;
      const nextIndex = nextY * nextWidth + nextX;
      const oldOffset = oldIndex * 4;
      const nextOffset = nextIndex * 4;
      const kind = oldKind[oldIndex];
      nextKind[nextIndex] = kind;
      if (isThreeQuarterPairKind(kind)) {
        const mapCorner = clockwise ? mapCornerCW : mapCornerCCW;
        for (let slot = 0; slot < 4; slot += 1) {
          const nextSlot = mapCorner(slot as QuarterCorner);
          nextColors[nextOffset + nextSlot] = oldColors[oldOffset + slot];
          if (oldCompleted[oldIndex] & (1 << slot)) nextCompleted[nextIndex] |= 1 << nextSlot;
        }
      } else if (isThreeQuarterSingleKind(kind)) {
        const corner = threeQuarterCornerForKind(kind);
        if (corner !== undefined) {
          const mapCorner = clockwise ? mapCornerCW : mapCornerCCW;
          nextKind[nextIndex] = threeQuarterKindForCorner(mapCorner(corner));
        }
        nextColors[nextOffset] = oldColors[oldOffset];
        nextCompleted[nextIndex] = oldCompleted[oldIndex] & 1;
      } else if (kind === CellKind.Quarters) {
        const mapCorner = clockwise ? mapCornerCW : mapCornerCCW;
        for (let slot = 0; slot < 4; slot += 1) {
          const nextSlot = mapCorner(slot as QuarterCorner);
          nextColors[nextOffset + nextSlot] = oldColors[oldOffset + slot];
          if (oldCompleted[oldIndex] & (1 << slot)) nextCompleted[nextIndex] |= 1 << nextSlot;
        }
      } else if (kind !== CellKind.Empty) {
        nextColors[nextOffset] = oldColors[oldOffset];
        nextCompleted[nextIndex] = oldCompleted[oldIndex] & 1;
        if (kind === CellKind.HalfBackslash) nextKind[nextIndex] = CellKind.HalfSlash;
        else if (kind === CellKind.HalfSlash) nextKind[nextIndex] = CellKind.HalfBackslash;
      }
    }
  }
  const records = listBackstitches(document).map((record) => {
    const start = rotatePoint(record.start, oldWidth, oldHeight, clockwise);
    const end = rotatePoint(record.end, oldWidth, oldHeight, clockwise);
    const canonical = canonicalEndpoints(start, end);
    return { ...record, x1: canonical.start.x, y1: canonical.start.y, x2: canonical.end.x, y2: canonical.end.y, start: canonical.start, end: canonical.end };
  });
  document.width = nextWidth;
  document.height = nextHeight;
  document.kind = nextKind;
  document.colors = nextColors;
  document.completed = nextCompleted;
  replaceBackstitches(document, records);
}

function mirror(document: PatternDocument, horizontal: boolean): void {
  const oldKind = document.kind;
  const oldColors = document.colors;
  const oldCompleted = document.completed;
  const nextKind = new Uint8Array(oldKind.length);
  const nextColors = new Uint16Array(oldColors.length);
  const nextCompleted = new Uint8Array(oldCompleted.length);
  for (let y = 0; y < document.height; y += 1) {
    for (let x = 0; x < document.width; x += 1) {
      const oldIndex = y * document.width + x;
      const nextX = horizontal ? document.width - 1 - x : x;
      const nextY = horizontal ? y : document.height - 1 - y;
      const nextIndex = nextY * document.width + nextX;
      const oldOffset = oldIndex * 4;
      const nextOffset = nextIndex * 4;
      const kind = oldKind[oldIndex];
      nextKind[nextIndex] = kind;
      if (isThreeQuarterPairKind(kind)) {
        const mapCorner = horizontal ? mapCornerHorizontal : mapCornerVertical;
        for (let slot = 0; slot < 4; slot += 1) {
          const nextSlot = mapCorner(slot as QuarterCorner);
          nextColors[nextOffset + nextSlot] = oldColors[oldOffset + slot];
          if (oldCompleted[oldIndex] & (1 << slot)) nextCompleted[nextIndex] |= 1 << nextSlot;
        }
      } else if (isThreeQuarterSingleKind(kind)) {
        const corner = threeQuarterCornerForKind(kind);
        if (corner !== undefined) {
          const mapCorner = horizontal ? mapCornerHorizontal : mapCornerVertical;
          nextKind[nextIndex] = threeQuarterKindForCorner(mapCorner(corner));
        }
        nextColors[nextOffset] = oldColors[oldOffset];
        nextCompleted[nextIndex] = oldCompleted[oldIndex] & 1;
      } else if (kind === CellKind.Quarters) {
        const mapCorner = horizontal ? mapCornerHorizontal : mapCornerVertical;
        for (let slot = 0; slot < 4; slot += 1) {
          const nextSlot = mapCorner(slot as QuarterCorner);
          nextColors[nextOffset + nextSlot] = oldColors[oldOffset + slot];
          if (oldCompleted[oldIndex] & (1 << slot)) nextCompleted[nextIndex] |= 1 << nextSlot;
        }
      } else if (kind !== CellKind.Empty) {
        nextColors[nextOffset] = oldColors[oldOffset];
        nextCompleted[nextIndex] = oldCompleted[oldIndex] & 1;
        if (kind === CellKind.HalfBackslash) nextKind[nextIndex] = CellKind.HalfSlash;
        else if (kind === CellKind.HalfSlash) nextKind[nextIndex] = CellKind.HalfBackslash;
      }
    }
  }
  const records = listBackstitches(document).map((record) => {
    const start = horizontal ? { x: document.width * 4 - record.start.x, y: record.start.y } : { x: record.start.x, y: document.height * 4 - record.start.y };
    const end = horizontal ? { x: document.width * 4 - record.end.x, y: record.end.y } : { x: record.end.x, y: document.height * 4 - record.end.y };
    const canonical = canonicalEndpoints(start, end);
    return { ...record, x1: canonical.start.x, y1: canonical.start.y, x2: canonical.end.x, y2: canonical.end.y, start: canonical.start, end: canonical.end };
  });
  document.kind = nextKind;
  document.colors = nextColors;
  document.completed = nextCompleted;
  replaceBackstitches(document, records);
}

function parseTurns(command: DomainCommand, clockwiseDefault: boolean): number {
  const degreesValue = valueOf(command, 'degrees');
  if (degreesValue !== undefined) {
    const degrees = requiredNumber(degreesValue, 'degrees');
    if (degrees % 90 !== 0) throw new DomainError('invalid-transform', 'Rotation degrees must be a multiple of 90.');
    return ((degrees / 90) * (clockwiseDefault ? 1 : -1) + 4) % 4;
  }
  const turnsValue = valueOf(command, 'turns', 'quarterTurns');
  if (turnsValue !== undefined) {
    const turns = requiredNumber(turnsValue, 'turns');
    return ((turns * (clockwiseDefault ? 1 : -1)) % 4 + 4) % 4;
  }
  return clockwiseDefault ? 1 : 3;
}

function sameContent(left: PatternDocument, right: PatternDocument): boolean {
  if (left.width !== right.width || left.height !== right.height || left.palette.length !== right.palette.length || left.backstitches.ids.length !== right.backstitches.ids.length || left.nextBackstitchId !== right.nextBackstitchId || left.nextPaletteId !== right.nextPaletteId) return false;
  for (let index = 0; index < left.kind.length; index += 1) {
    if (left.kind[index] !== right.kind[index] || left.completed[index] !== right.completed[index]) return false;
    const offset = index * 4;
    for (let slot = 0; slot < 4; slot += 1) if (left.colors[offset + slot] !== right.colors[offset + slot]) return false;
  }
  if (!samePalette(left.palette, right.palette)) return false;
  for (let index = 0; index < left.backstitches.ids.length; index += 1) {
    if (left.backstitches.ids[index] !== right.backstitches.ids[index] || left.backstitches.x1[index] !== right.backstitches.x1[index] || left.backstitches.y1[index] !== right.backstitches.y1[index] || left.backstitches.x2[index] !== right.backstitches.x2[index] || left.backstitches.y2[index] !== right.backstitches.y2[index] || left.backstitches.colors[index] !== right.backstitches.colors[index] || left.backstitches.completed[index] !== right.backstitches.completed[index]) return false;
  }
  return true;
}

export const documentsEqual = sameContent;

function transformCommand(document: PatternDocument, command: DomainCommand, type: string): MutationInfo {
  if (type === 'rotate-cw' || type === 'rotate-ccw' || type === 'rotate') {
    const before = cloneDocument(document);
    const clockwiseDefault = type !== 'rotate-ccw';
    let turns = parseTurns(command, clockwiseDefault);
    if (type === 'rotate' && valueOf(command, 'direction') !== undefined) {
      const direction = String(valueOf(command, 'direction')).toLowerCase();
      turns = parseTurns(command, direction !== 'counterclockwise' && direction !== 'ccw');
    }
    if (turns === 0) return noChange();
    // `turns` is normalized to clockwise turns, so three clockwise turns
    // represent one counter-clockwise turn without a second coordinate path.
    for (let turn = 0; turn < turns; turn += 1) rotateOnce(document, true);
    return sameContent(before, document) ? noChange() : changed(true);
  }
  const before = cloneDocument(document);
  const horizontal = type === 'mirror-horizontal' || type === 'mirror-left-right';
  mirror(document, horizontal);
  return sameContent(before, document) ? noChange() : changed(true);
}

function parseCrop(command: DomainCommand): CropRect {
  const source = typeof command.rect === 'object' && command.rect !== null ? command.rect as Record<string, unknown> : command;
  const x = requiredNumber(source.x ?? source.left ?? source.x0, 'crop x');
  const y = requiredNumber(source.y ?? source.top ?? source.y0, 'crop y');
  const widthValue = source.width;
  const heightValue = source.height;
  const right = source.right ?? source.x1;
  const bottom = source.bottom ?? source.y1;
  const width = widthValue === undefined ? requiredNumber(right, 'crop right') - x : requiredNumber(widthValue, 'crop width');
  const height = heightValue === undefined ? requiredNumber(bottom, 'crop bottom') - y : requiredNumber(heightValue, 'crop height');
  return { x, y, width, height };
}

function applyCrop(document: PatternDocument, command: DomainCommand): MutationInfo {
  const rect = parseCrop(command);
  if (!Number.isInteger(rect.x) || !Number.isInteger(rect.y) || !Number.isInteger(rect.width) || !Number.isInteger(rect.height) || rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1 || rect.x + rect.width > document.width || rect.y + rect.height > document.height) {
    throw new DomainError('invalid-crop', 'Crop rectangle must be a non-empty rectangle inside the document.');
  }
  if (rect.x === 0 && rect.y === 0 && rect.width === document.width && rect.height === document.height) return noChange();
  const oldWidth = document.width;
  const oldKind = document.kind;
  const oldColors = document.colors;
  const oldCompleted = document.completed;
  const nextKind = new Uint8Array(rect.width * rect.height);
  const nextColors = new Uint16Array(rect.width * rect.height * 4);
  const nextCompleted = new Uint8Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y += 1) {
    for (let x = 0; x < rect.width; x += 1) {
      const oldIndex = (rect.y + y) * oldWidth + rect.x + x;
      const nextIndex = y * rect.width + x;
      nextKind[nextIndex] = oldKind[oldIndex];
      nextCompleted[nextIndex] = oldCompleted[oldIndex];
      const oldOffset = oldIndex * 4;
      const nextOffset = nextIndex * 4;
      for (let slot = 0; slot < 4; slot += 1) nextColors[nextOffset + slot] = oldColors[oldOffset + slot];
    }
  }
  const left = rect.x * 4;
  const top = rect.y * 4;
  const right = (rect.x + rect.width) * 4;
  const bottom = (rect.y + rect.height) * 4;
  const records = listBackstitches(document).filter((record) => record.x1 >= left && record.x1 <= right && record.x2 >= left && record.x2 <= right && record.y1 >= top && record.y1 <= bottom && record.y2 >= top && record.y2 <= bottom).map((record) => {
    const start = { x: record.x1 - left, y: record.y1 - top };
    const end = { x: record.x2 - left, y: record.y2 - top };
    const canonical = canonicalEndpoints(start, end);
    return { ...record, x1: canonical.start.x, y1: canonical.start.y, x2: canonical.end.x, y2: canonical.end.y, start: canonical.start, end: canonical.end };
  });
  document.width = rect.width;
  document.height = rect.height;
  document.kind = nextKind;
  document.colors = nextColors;
  document.completed = nextCompleted;
  replaceBackstitches(document, records);
  return changed(true);
}

function applyCellCompletion(document: PatternDocument, command: DomainCommand): MutationInfo {
  return completionCommand(document, command, false);
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
  if (!command || typeof command.type !== 'string') throw new DomainError('invalid-command', 'Every command must have a type.');
  validateExpectedCommandRevision(document, command);
  const type = normalizeType(command.type);
  if (type === 'bulk-cell') {
    const preflight = preflightBulkCellCommand(document, command);
    return applyBulkCellCommand(document, command, preflight);
  }
  if (type === 'bulk-recolor') {
    const preflight = preflightBulkRecolorCommand(document, command);
    return applyBulkRecolorCommand(document, command, preflight);
  }
  if (type === 'bulk-completion') {
    const preflight = preflightBulkCompletionCommand(document, command);
    return applyBulkCompletionCommand(document, command, preflight);
  }
  if (type === 'bulk-backstitch-completion') {
    const preflight = preflightBulkBackstitchCompletionCommand(document, command);
    return applyBulkBackstitchCompletionCommand(document, command, preflight);
  }
  if (tracker !== undefined) touchCommandTargets(document, command, tracker);
  switch (type) {
    case 'batch': {
      if (!Array.isArray(command.commands)) throw new DomainError('invalid-command', 'A batch requires a commands array.');
      return applyCommandsToDraft(document, command.commands as DomainCommand[], tracker);
    }
    case 'set-cell': return cellCommand(document, command);
    case 'set-full': return applySetFullCommand(document, command);
    case 'set-half': return applySetHalfCommand(document, command);
    case 'set-quarter': return quarterCommand(document, command);
    case 'set-three-quarter': return applySetThreeQuarterCommand(document, command);
    case 'set-quarters': {
      const x = requiredNumber(valueOf(command, 'x', 'column'), 'x');
      const y = requiredNumber(valueOf(command, 'y', 'row'), 'y');
      const rawColors = valueOf(command, 'colors', 'quarterColors');
      if (!Array.isArray(rawColors)) throw new DomainError('invalid-command', 'set-quarters requires four colors.');
      return writeQuarters(document, x, y, rawColors.map((value) => requiredNumber(value, 'quarter color'))) ? changed() : noChange();
    }
    case 'bulk-cell': return applyBulkCellCommand(document, command);
    case 'bulk-recolor': return applyBulkRecolorCommand(document, command);
    case 'bulk-completion': return applyBulkCompletionCommand(document, command);
    case 'bulk-backstitch-completion': return applyBulkBackstitchCompletionCommand(document, command);
    case 'paste-fragment': return applyPasteFragmentCommand(document, command);
    case 'mixed-erase': return applyMixedEraseCommand(document, command);
    case 'delete-region': return applyDeleteRegionCommand(document, command);
    case 'delete-cell-set': return applyDeleteCellSetCommand(document, command);
    case 'erase-cell': {
      const x = requiredNumber(valueOf(command, 'x', 'column'), 'x');
      const y = requiredNumber(valueOf(command, 'y', 'row'), 'y');
      return clearCell(document, cellIndex(document, x, y)) ? changed() : noChange();
    }
    case 'erase-quarter': {
      const x = requiredNumber(valueOf(command, 'x', 'column'), 'x');
      const y = requiredNumber(valueOf(command, 'y', 'row'), 'y');
      return removeQuarter(document, x, y, parseCorner(valueOf(command, 'corner', 'quarter', 'slot'))) ? changed() : noChange();
    }
    case 'recolor-cell':
    case 'recolor': return recolorCell(document, command);
    case 'set-completion': return applyCellCompletion(document, command);
    case 'toggle-completion': return completionCommand(document, command, true);
    case 'add-backstitch': return applyAddBackstitch(document, command);
    case 'remove-backstitch': return applyRemoveBackstitch(document, command);
    case 'move-backstitch': return applyMoveBackstitch(document, command);
    case 'recolor-backstitch': return applyRecolorBackstitch(document, command);
    case 'set-backstitch-completion': return applySetBackstitchCompletion(document, command, false);
    case 'toggle-backstitch-completion': return applySetBackstitchCompletion(document, command, true);
    case 'update-backstitch': return applyUpdateBackstitch(document, command);
    case 'palette-create': return paletteCreate(document, command);
    case 'palette-update': return paletteUpdate(document, command);
    case 'palette-deactivate': return paletteDeactivate(document, command);
    case 'palette-merge': return paletteMerge(document, command);
    case 'rotate-cw':
    case 'rotate-ccw':
    case 'rotate':
    case 'mirror-horizontal':
    case 'mirror-vertical':
    case 'mirror-left-right':
    case 'mirror-top-bottom': return transformCommand(document, command, type);
    case 'mirror': {
      const axis = String(valueOf(command, 'axis', 'direction') ?? 'horizontal').toLowerCase();
      return transformCommand(document, command, axis === 'vertical' || axis === 'y' || axis === 'top-bottom' ? 'mirror-vertical' : 'mirror-horizontal');
    }
    case 'crop': return applyCrop(document, command);
    default: throw new DomainError('unknown-command', `Unknown command type ${command.type}.`);
  }
}

export function applyOneToDraft(document: PatternDocument, command: DomainCommand, tracker?: MutationTracker): MutationInfo {
  return applyOneToDraftInternal(document, command, tracker);
}

export function applyCommand(document: PatternDocument, command: DomainCommand): CommandResult {
  assertValidDocument(document);
  const draft = cloneDocument(document);
  const commandList = normalizeType(command.type) === 'batch' ? command.commands as DomainCommand[] : [command];
  if (!Array.isArray(commandList)) throw new DomainError('invalid-command', 'A batch requires a commands array.');
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
      ...(result.createdBackstitchIds === undefined ? {} : { createdBackstitchIds: result.createdBackstitchIds.slice() })
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
    ...(result.createdBackstitchIds === undefined ? {} : { createdBackstitchIds: result.createdBackstitchIds.slice() })
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

export function fullCommand(x: number, y: number, color: number, completed?: boolean): DomainCommand {
  return { type: 'set-full', x, y, color, ...(completed === undefined ? {} : { completed }) };
}

export function halfCommand(x: number, y: number, direction: HalfDirection, color: number, completed?: boolean): DomainCommand {
  return { type: 'set-half', x, y, direction, color, ...(completed === undefined ? {} : { completed }) };
}

export function quarterCommandFor(x: number, y: number, corner: QuarterCorner, color: number, completed?: boolean): DomainCommand {
  return { type: 'set-quarter', x, y, corner, color, ...(completed === undefined ? {} : { completed }) };
}

export function threeQuarterCommandFor(x: number, y: number, corner: QuarterCorner, color: number, completed?: boolean): DomainCommand {
  return { type: 'set-three-quarter', x, y, corner, color, ...(completed === undefined ? {} : { completed }) };
}

export const setFullCommand = fullCommand;
export const setHalfCommand = halfCommand;
export const setQuarterCommand = quarterCommandFor;
export const setThreeQuarterCommand = threeQuarterCommandFor;
export const threeQuarterCommand = threeQuarterCommandFor;

export function createPaletteCommand(input: PaletteEntryInput): DomainCommand {
  return { type: 'palette-create', ...input };
}

export function createPaletteMergeCommand(from: number, to: number): DomainCommand {
  return { type: 'palette-merge', from, to };
}

export const mergePaletteCommand = createPaletteMergeCommand;

export const addPaletteCommand = createPaletteCommand;

export function createBackstitchCommand(start: Point, end: Point, color: number, completed = false): DomainCommand {
  return { type: 'add-backstitch', start, end, color, completed };
}

export const addBackstitchCommand = createBackstitchCommand;

export function rotateCommand(direction: 'cw' | 'ccw' = 'cw', quarterTurns = 1): DomainCommand {
  return { type: direction === 'cw' ? 'rotate-cw' : 'rotate-ccw', quarterTurns };
}

export function mirrorCommand(axis: 'horizontal' | 'vertical' = 'horizontal'): DomainCommand {
  return { type: axis === 'horizontal' ? 'mirror-horizontal' : 'mirror-vertical' };
}

export function cropCommand(rect: CropRect): DomainCommand {
  return { type: 'crop', ...rect };
}

export function setFull(document: PatternDocument, x: number, y: number, color: number, completed?: boolean): CommandResult {
  return applyCommand(document, fullCommand(x, y, color, completed));
}

export function setHalf(document: PatternDocument, x: number, y: number, direction: HalfDirection, color: number, completed?: boolean): CommandResult {
  return applyCommand(document, halfCommand(x, y, direction, color, completed));
}

export function setQuarter(document: PatternDocument, x: number, y: number, corner: QuarterCorner, color: number, completed?: boolean): CommandResult {
  return applyCommand(document, quarterCommandFor(x, y, corner, color, completed));
}

export function setThreeQuarter(document: PatternDocument, x: number, y: number, corner: QuarterCorner, color: number, completed?: boolean): CommandResult {
  return applyCommand(document, threeQuarterCommandFor(x, y, corner, color, completed));
}

export function eraseCell(document: PatternDocument, x: number, y: number): CommandResult {
  return applyCommand(document, { type: 'erase-cell', x, y });
}

export function deleteRegion(document: PatternDocument, rect: CropRect): CommandResult {
  return applyCommand(document, deleteRegionCommand(rect));
}

export function setCompletion(document: PatternDocument, x: number, y: number, completed: boolean, corner?: QuarterCorner): CommandResult {
  return applyCommand(document, { type: 'set-completion', x, y, completed, ...(corner === undefined ? {} : { corner }) });
}

export function toggleCompletion(document: PatternDocument, x: number, y: number, corner?: QuarterCorner): CommandResult {
  return applyCommand(document, { type: 'toggle-completion', x, y, ...(corner === undefined ? {} : { corner }) });
}

export function recolor(document: PatternDocument, x: number, y: number, color: number, corner?: QuarterCorner): CommandResult {
  return applyCommand(document, { type: 'recolor-cell', x, y, color, ...(corner === undefined ? {} : { corner }) });
}

export function addBackstitch(document: PatternDocument, start: Point, end: Point, color: number, completed = false): CommandResult {
  return applyCommand(document, createBackstitchCommand(start, end, color, completed));
}

export function updateBackstitch(document: PatternDocument, id: number, changes: Partial<{ start: Point; end: Point; color: number; completed: boolean }>): CommandResult {
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

export function setBackstitchCompletion(document: PatternDocument, id: number, completed: boolean): CommandResult {
  return applyCommand(document, { type: 'set-backstitch-completion', id, completed });
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
export const setCellCompletion = setCompletion;

export function rotate(document: PatternDocument, direction: 'cw' | 'ccw' = 'cw', quarterTurns = 1): CommandResult {
  return applyCommand(document, rotateCommand(direction, quarterTurns));
}

export function mirrorDocument(document: PatternDocument, axis: 'horizontal' | 'vertical' = 'horizontal'): CommandResult {
  return applyCommand(document, mirrorCommand(axis));
}

export function cropDocument(document: PatternDocument, rect: CropRect): CommandResult {
  return applyCommand(document, cropCommand(rect));
}

export const rotateClockwise = (document: PatternDocument, quarterTurns = 1): CommandResult => rotate(document, 'cw', quarterTurns);
export const rotateCounterClockwise = (document: PatternDocument, quarterTurns = 1): CommandResult => rotate(document, 'ccw', quarterTurns);
export const mirrorHorizontal = (document: PatternDocument): CommandResult => mirrorDocument(document, 'horizontal');
export const mirrorVertical = (document: PatternDocument): CommandResult => mirrorDocument(document, 'vertical');
export const crop = cropDocument;
export const deleteSelectedRegion = deleteRegion;

export const clearCellCommand = (x: number, y: number): DomainCommand => ({ type: 'erase-cell', x, y });
export const eraseCommand = clearCellCommand;
export const setCompletionCommand = (x: number, y: number, completed: boolean, corner?: QuarterCorner): DomainCommand => ({ type: 'set-completion', x, y, completed, ...(corner === undefined ? {} : { corner }) });
export const toggleCompletionCommand = (x: number, y: number, corner?: QuarterCorner): DomainCommand => ({ type: 'toggle-completion', x, y, ...(corner === undefined ? {} : { corner }) });
export const removeBackstitchCommand = (id: number): DomainCommand => ({ type: 'remove-backstitch', id });
export const moveBackstitchCommand = (id: number, start: Point, end: Point): DomainCommand => ({ type: 'move-backstitch', id, start, end });
export const recolorBackstitchCommand = (id: number, color: number): DomainCommand => ({ type: 'recolor-backstitch', id, color });
export const setBackstitchCompletionCommand = (id: number, completed: boolean): DomainCommand => ({ type: 'set-backstitch-completion', id, completed });
