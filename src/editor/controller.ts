import {
  CellKind,
  preflightBulkRecolorCommand,
  createPatternFragment,
  createPatternFragmentFromCells,
  clonePatternFragment,
  DomainError,
  HalfDirection,
  mixedEraseCommand,
  preflightMixedEraseCommand,
  preflightBulkCompletionCommand,
  deleteRegionCommand,
  deleteCellSetCommand,
  pasteFragmentCommand,
  preflightPasteFragmentCommand,
  moveFragmentCommand,
  backstitchEndpointsContainedInCellUnion,
  preflightBulkCellCommand,
  QuarterCorner,
  type BulkCellEdit,
  type CommandResult,
  type DomainCommand,
  type PatternDocument,
  type PatternFragment,
  type FragmentSelection
} from '../domain';
import type {
  CanvasMetrics,
  CanvasRenderer,
  BrushSizeTool,
  CellRect,
  AuthoringStitchBrush,
  EditorToolState,
  EditorUiStore,
  EraserMode,
  FixedPoint,
  GridRect,
  Invalidation,
  ModelPoint,
  OverlayState,
  PendingCellState,
  ShapeKind,
  SelectedCellSemantics,
  ScreenPoint,
  TraceBoundsChangeCallback,
  TraceImage,
  TraceImageSampler,
  TraceRgb,
  TraceSampleCallback,
  StitchBrush,
  Viewport
} from './contracts';
import { normalizeBrushSize } from './contracts';
import {
  fitViewport,
  hitTestCell,
  isFiniteModelPoint,
  isFiniteScreenPoint,
  isFiniteViewport,
  normalizeViewport,
  screenToCell,
  screenToModel,
  zoomAt,
  zoomBy,
  cellToScreenRect,
  type ViewportClampOptions
} from './coordinates';
import { bresenhamLine, cellKey, supercoverLine } from './interpolation';
import { constrainShapeEndpoint, rasterizeShapeOutline } from './shapes';
import {
  type EditorRevisionToken,
  type EditorTransaction,
  type WorkspaceEditorGateway,
  type WorkspaceEditorSnapshot,
  StaleEditorTransactionError
} from './gateway';
import type { KeyboardSample, PointerSample, WheelSample } from './input';
import {
  FillCancelledError,
  FillStaleResultError,
  MAX_FILL_COLOR_SLOTS,
  createFillWorkerClient,
  isFillResultCurrent,
  type FillJob,
  type FillResultMessage,
  type FillWorkerClient
} from './fill';
import { sampleTraceImage } from '../rendering/trace';
import { createCatalogReference, type CatalogDefinition } from '../catalog';
import {
  appendLassoPoint,
  appendLassoRasterPoint,
  createLassoRasterAccumulator,
  finishLassoRaster,
  MAX_LASSO_PATH_POINTS,
  selectionRectToIndices,
  sparseSelectionGeometry,
  type SelectionBoundarySegment
} from './lasso';
import {
  isThreeQuarterKind,
  isThreeQuarterPairKind,
  isLegacyQuarterKind,
  ThreeQuarterPair,
  threeQuarterCornersShareAxis,
  threeQuarterPairComponents,
  threeQuarterCornerForKind,
  threeQuarterKindForCorner
} from './cell-kinds';

export interface EditorSurfaceControllerOptions {
  readonly gateway: WorkspaceEditorGateway;
  readonly renderer: CanvasRenderer;
  readonly uiStore: EditorUiStore;
  readonly metrics?: CanvasMetrics;
  readonly minZoom?: number;
  readonly maxZoom?: number;
  readonly fillClient?: FillWorkerClient;
  readonly traceImage?: TraceImage;
  readonly traceSampler?: TraceImageSampler;
  readonly catalogDefinition?: CatalogDefinition;
  readonly onTraceSample?: TraceSampleCallback;
  readonly onTraceBoundsChange?: TraceBoundsChangeCallback;
}

export interface EditorSurfaceControllerLifecycle {
  start(): void;
  stop(): void;
  /** Configure whether touch input is restricted to movement-only behavior. */
  setTouchMovementOnly(enabled: boolean): void;
  pasteSelection(): boolean;
  moveSelection(): boolean;
  dismissTouchCopyRequest(): void;
  /** Replace the rendered document without recreating editor interaction state. */
  setDocument(document: PatternDocument, invalidation?: Invalidation): void;
  setMetrics(metrics: CanvasMetrics): void;
  setToolBrushSize(tool: BrushSizeTool, size: number): void;
  setTraceImage(trace: TraceImage | undefined): void;
  clearTraceImage(): void;
  setTraceSampleCallback(callback: TraceSampleCallback | undefined): void;
  dispose(): void;
}

type Gesture = PaintGesture | ShapeGesture | EraserGesture | CompletionGesture | SelectionGesture | LassoGesture | BackstitchGesture | TouchActionGesture | PanGesture | PinchGesture | MoveImageGesture | ResizeImageGesture;

interface PaintGesture {
  readonly kind: 'paint';
  readonly pointerId: number;
  readonly transaction: EditorTransaction;
  readonly brush: StitchBrush;
  /** Geometry captured at pointer-down; every stamped cell uses this edit. */
  readonly edit: BulkCellEdit;
  readonly brushSize: number;
  readonly cells: Map<string, ModelPoint>;
  lastCell: ModelPoint | undefined;
}

interface ShapeGesture {
  readonly kind: 'shape';
  readonly pointerId: number;
  readonly transaction: EditorTransaction;
  readonly shape: ShapeKind;
  readonly anchor: ModelPoint;
  readonly edit: BulkCellEdit;
  readonly brushSize: number;
  readonly cells: Map<string, ModelPoint>;
}

interface EraserGesture {
  readonly kind: 'eraser';
  readonly pointerId: number;
  readonly transaction: EditorTransaction;
  readonly mode: EraserMode;
  readonly brushSize: number;
  readonly cells: Map<string, ModelPoint>;
  readonly components: Map<string, { readonly cell: ModelPoint; readonly corner: number }>;
  lastCell: ModelPoint | undefined;
}

interface CompletionGesture {
  readonly kind: 'completion';
  readonly pointerId: number;
  readonly transaction: EditorTransaction;
  readonly operation: CompletionOperation;
  readonly targets: Map<number, CompletionTarget>;
  lastCell: ModelPoint | undefined;
}

type CompletionOperation = 'set' | 'clear';

interface CompletionTarget {
  readonly cell: ModelPoint;
  readonly mask: number;
}

type FillRecolorSnapshot =
  | { readonly kind: 'recolor'; readonly fromColor: number; readonly toColor: number }
  | { readonly kind: 'empty-region'; readonly toColor: number };

interface SelectionGesture {
  readonly kind: 'selection';
  readonly pointerId: number;
  readonly anchor: ModelPoint | undefined;
  readonly hadSelection: boolean;
  readonly previousSelection: FinalizedSelection | undefined;
  readonly previousSelectionAnchor: ModelPoint | undefined;
  current: ModelPoint | undefined;
}

interface LassoGesture {
  readonly kind: 'lasso';
  readonly pointerId: number;
  readonly token: EditorRevisionToken;
  readonly startingCell?: ModelPoint;
  readonly operation: 'replace' | 'union' | 'subtract';
  /** Display-only path; final selection semantics live in `raster`. */
  readonly points: ModelPoint[];
  readonly raster: ReturnType<typeof createLassoRasterAccumulator>;
  previewSamples: number;
}

interface RectangularSelection {
  readonly kind: 'rect';
  readonly rect: GridRect;
  readonly documentWidth: number;
  readonly documentHeight: number;
}

interface SparseSelection {
  readonly kind: 'sparse';
  readonly indices: Uint32Array;
  readonly bounds: GridRect;
  readonly boundaries: readonly SelectionBoundarySegment[];
  readonly documentWidth: number;
  readonly documentHeight: number;
}

type FinalizedSelection = RectangularSelection | SparseSelection;

interface BackstitchGesture {
  readonly kind: 'backstitch';
  readonly pointerId: number;
  readonly mode: 'create' | 'move';
  readonly token: EditorRevisionToken;
  readonly selectedId?: number;
  readonly movingEndpoint?: 'start' | 'end';
  start: FixedPoint;
  end: FixedPoint;
}

interface TouchActionGesture {
  readonly kind: 'touch-action';
  readonly pointerId: number;
  readonly tool: 'fill' | 'eyedropper';
  readonly token: EditorRevisionToken;
  readonly startScreenX: number;
  readonly startScreenY: number;
}

interface PanGesture {
  readonly kind: 'pan';
  readonly pointerId: number;
  lastX: number;
  lastY: number;
}

interface PinchGesture {
  readonly kind: 'pinch';
  readonly pointerIds: readonly [number, number];
  readonly startViewport: Viewport;
  readonly startMidpoint: ModelPoint;
  readonly startDistance: number;
}

interface MoveImageGesture {
  readonly kind: 'move-image';
  readonly pointerId: number;
  readonly startScreenX: number;
  readonly startScreenY: number;
  readonly startBounds: CellRect;
}

type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';

interface ResizeImageGesture {
  readonly kind: 'resize-image';
  readonly pointerId: number;
  readonly corner: ResizeCorner;
  /** The fixed opposite corner in cell coordinates (may be fractional). */
  readonly anchor: { x: number; y: number };
  readonly startBounds: CellRect;
}

interface FloatingPasteState {
  readonly mode: 'paste' | 'move';
  readonly fragment: PatternFragment;
  readonly copySelection: ClipboardSelectionGeometry;
  readonly sourceSelection?: ClipboardSelectionGeometry;
  readonly moveSelection?: FragmentSelection;
  readonly completion?: Uint8Array;
  readonly backstitches?: FloatingPasteBackstitches;
  readonly destination: GridRect;
  readonly token: EditorRevisionToken;
  readonly previousSelection: FinalizedSelection | undefined;
  readonly previousSelectionAnchor: ModelPoint | undefined;
}

interface FloatingPasteBackstitches {
  readonly ids: Uint32Array;
  readonly x1: Uint32Array;
  readonly y1: Uint32Array;
  readonly x2: Uint32Array;
  readonly y2: Uint32Array;
  readonly colors: Uint16Array;
  readonly completed: Uint8Array;
}

interface ClipboardSelectionGeometry {
  readonly kind: 'rect' | 'sparse';
  readonly rect: CellRect;
  readonly boundaries?: readonly SelectionBoundarySegment[];
}

interface FloatingPasteMoveGesture {
  readonly pointerId: number;
  readonly startScreenX: number;
  readonly startScreenY: number;
  readonly startDestination: GridRect;
}

interface FloatingPasteTouchCandidate {
  readonly pointerId: number;
  readonly action: 'commit' | 'move';
  readonly startScreenX: number;
  readonly startScreenY: number;
}

interface TouchCopyCandidate {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly tool: 'select' | 'lasso';
  readonly cell: ModelPoint;
  readonly sample: PointerSample;
}

/** Screen-pixel distance under which a move-image pointer gesture counts as a tap. */
const MOVE_IMAGE_TAP_PIXELS = 5;
/** Screen-pixel hit radius for resize-mode corner handles. */
const RESIZE_HANDLE_HIT_PIXELS = 12;
/** Screen-pixel distance at which a dragged corner snaps to the canvas edge. */
const RESIZE_EDGE_SNAP_PIXELS = 8;
/** Screen-pixel movement permitted for a stationary multi-touch history tap. */
export const TOUCH_HISTORY_TAP_SLOP_PIXELS = 12;
/** Maximum timestamp span permitted for a stationary multi-touch history tap. */
export const TOUCH_HISTORY_TAP_MAX_DURATION_MS = 350;

const TOUCH_DIAGNOSTIC_PREFIX = '[Needlewise touch]';
type TouchHistoryRejectionReason =
  | 'movement'
  | 'duration'
  | 'distinct-contact-limit'
  | 'concurrent-contact-limit'
  | 'cancelled'
  | 'lost-capture'
  | 'blur'
  | 'project/document reset'
  | 'reference-image-tool';

function debugTouch(event: string, details: Record<string, unknown>): void {
  try {
    const debug = globalThis.console?.debug;
    if (typeof debug === 'function') debug.call(globalThis.console, TOUCH_DIAGNOSTIC_PREFIX, event, details);
  } catch {
    // Diagnostics must never affect editor input.
  }
}

interface TouchHistoryCandidate {
  readonly startPositions: Map<number, ScreenPoint>;
  readonly distinctPointerIds: Set<number>;
  readonly startedAt?: number;
  maxPointers: number;
  invalid: boolean;
  rejectionReason?: TouchHistoryRejectionReason;
}

function cloneCell(cell: ModelPoint): ModelPoint {
  return { x: Math.floor(cell.x), y: Math.floor(cell.y) };
}

/** The cell-coordinate corner opposite the resized corner (stays fixed during a drag). */
function resizeAnchor(corner: ResizeCorner, bounds: CellRect): { x: number; y: number } {
  switch (corner) {
    case 'nw': return { x: bounds.x + bounds.width, y: bounds.y + bounds.height };
    case 'ne': return { x: bounds.x, y: bounds.y + bounds.height };
    case 'sw': return { x: bounds.x + bounds.width, y: bounds.y };
    case 'se': return { x: bounds.x, y: bounds.y };
  }
}

/** Snap a model coordinate to a target edge when within a cell tolerance. */
function snapTowards(value: number, target: number, tolerance: number): number {
  return Math.abs(value - target) <= tolerance ? target : value;
}

function validScreenSample(sample: PointerSample): boolean {
  return isFiniteScreenPoint({ x: sample.screenX, y: sample.screenY });
}

function midpoint(left: PointerSample, right: PointerSample): ModelPoint {
  return { x: (left.screenX + right.screenX) / 2, y: (left.screenY + right.screenY) / 2 };
}

function distance(left: PointerSample, right: PointerSample): number {
  return Math.hypot(left.screenX - right.screenX, left.screenY - right.screenY);
}

function editForBrush(brush: StitchBrush, pointerDownCorner?: QuarterCorner): BulkCellEdit {
  if (brush.kind === 'full') return { kind: 'full', color: brush.paletteId };
  if (brush.kind === 'half') {
    const direction = pointerDownCorner === QuarterCorner.NW || pointerDownCorner === QuarterCorner.SE
      ? HalfDirection.Backslash
      : pointerDownCorner === QuarterCorner.NE || pointerDownCorner === QuarterCorner.SW
        ? HalfDirection.Slash
        : brush.direction ?? HalfDirection.Backslash;
    return { kind: 'half', direction, color: brush.paletteId };
  }
  if (brush.kind === 'three-quarter') {
    return { kind: 'three-quarter', corner: pointerDownCorner ?? QuarterCorner.NW, color: brush.paletteId };
  }
  return { kind: 'quarter', corner: brush.corner, color: brush.paletteId };
}

function indicesForCells(cells: readonly ModelPoint[], width: number): Uint32Array {
  for (const cell of cells) if (!isFiniteModelPoint(cell)) throw new DomainError('invalid-coordinate', 'Cell coordinates must be finite.');
  const indices = [...new Set(cells.map((cell) => Math.floor(cell.y) * width + Math.floor(cell.x)))].sort((left, right) => left - right);
  return new Uint32Array(indices);
}

/**
 * Return the clipped, deterministic disk stamp centered on a hit cell.
 *
 * Brush size is the disk diameter in cell units. Cell centers are integer
 * offsets from the hit cell, so a size-1 brush has a radius of 0.5 and still
 * selects exactly the hit cell.
 */
function brushCells(center: ModelPoint, size: number, document: PatternDocument): ModelPoint[] {
  const cellX = Math.floor(center.x);
  const cellY = Math.floor(center.y);
  const radius = size / 2;
  const radiusSquared = radius * radius;
  const cells: ModelPoint[] = [];
  const minX = Math.max(0, Math.ceil(cellX - radius));
  const maxX = Math.min(document.width - 1, Math.floor(cellX + radius));
  const minY = Math.max(0, Math.ceil(cellY - radius));
  const maxY = Math.min(document.height - 1, Math.floor(cellY + radius));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x - cellX;
      const dy = y - cellY;
      if (dx * dx + dy * dy <= radiusSquared) cells.push({ x, y });
    }
  }
  return cells;
}

function stampBrush(cells: Map<string, ModelPoint>, center: ModelPoint, size: number, document: PatternDocument): void {
  for (const cell of brushCells(center, size, document)) cells.set(cellKey(cell), cell);
}

function boundedSquareOrigin(origin: number, anchor: number, side: number, extent: number): number {
  const min = Math.max(0, anchor - side + 1);
  const max = Math.min(anchor, extent - side);
  return Math.max(min, Math.min(max, origin));
}

function stampCompletionTargets(
  targets: Map<number, CompletionTarget>,
  center: ModelPoint,
  document: PatternDocument,
  local: ModelPoint
): void {
  for (const cell of brushCells(center, 1, document)) {
    const mask = completionTargetForCell(document, cell, local);
    if (mask === 0) continue;
    const index = cell.y * document.width + cell.x;
    const previous = targets.get(index);
    targets.set(index, previous ? { cell: previous.cell, mask: previous.mask | mask } : { cell, mask });
  }
}

function completionTargetCells(targets: Map<number, CompletionTarget>): Map<string, ModelPoint> {
  return new Map([...targets.values()].map((target) => [cellKey(target.cell), target.cell]));
}

function completionMaskForCell(document: PatternDocument, index: number): number {
  const kind = document.kind[index];
  if (kind === CellKind.Empty) return 0;
  const offset = index * 4;
  if (isLegacyQuarterKind(kind) || isThreeQuarterPairKind(kind)) {
    let mask = 0;
    for (let slot = 0; slot < 4; slot += 1) if (document.colors[offset + slot] !== 0) mask |= 1 << slot;
    return mask;
  }
  return 1;
}

function deterministicFillMask(document: PatternDocument, index: number): number {
  const mask = completionMaskForCell(document, index);
  if (mask === 0) return 0;
  const kind = document.kind[index];
  if (!isLegacyQuarterKind(kind) && !isThreeQuarterPairKind(kind) && document.colors[index * MAX_FILL_COLOR_SLOTS] === 0) return 0;
  return mask & -mask;
}

function completionTargetsForCells(cells: readonly ModelPoint[], document: PatternDocument): Map<number, CompletionTarget> {
  const indices = indicesForCells(cells, document.width);
  const targets = new Map<number, CompletionTarget>();
  for (const index of indices) {
    const mask = completionMaskForCell(document, index);
    if (mask !== 0 && (document.completed[index] & mask) !== mask) {
      targets.set(index, { cell: { x: index % document.width, y: Math.floor(index / document.width) }, mask });
    }
  }
  return targets;
}

function completionCommand(
  indices: Uint32Array,
  masks: Uint8Array,
  operation: CompletionOperation,
  expectedRevision: number
): DomainCommand {
  // The masks field is supplied by the domain completion lane. Keep the
  // controller compatible with the pre-mask command type while making the
  // exact per-cell targets explicit at this boundary.
  return {
    type: 'bulk-completion',
    indices,
    masks,
    operation,
    expectedRevision
  } as unknown as DomainCommand;
}

function fillRecolorCommand(
  indices: Uint32Array,
  masks: Uint8Array,
  fromColor: number,
  toColor: number,
  expectedRevision: number
): DomainCommand {
  return {
    type: 'bulk-recolor',
    indices,
    masks,
    fromColor,
    toColor,
    expectedRevision
  } as unknown as DomainCommand;
}

function masksForChangedIndices(indices: Uint32Array, masks: Uint8Array, changedIndices: Uint32Array): Uint8Array {
  const changedMasks = new Uint8Array(changedIndices.length);
  let sourcePosition = 0;
  for (let targetPosition = 0; targetPosition < changedIndices.length; targetPosition += 1) {
    while (sourcePosition < indices.length && indices[sourcePosition] < changedIndices[targetPosition]) sourcePosition += 1;
    if (sourcePosition >= indices.length || indices[sourcePosition] !== changedIndices[targetPosition]) throw new DomainError('invalid-command', 'Fill result masks are not aligned with changed indices.');
    changedMasks[targetPosition] = masks[sourcePosition];
  }
  return changedMasks;
}

function isExactEmptyRegionFillResult(
  document: PatternDocument,
  startIndex: number,
  indices: Uint32Array,
  masks: Uint8Array
): boolean {
  if (indices.length === 0 || indices.length !== masks.length || document.kind[startIndex] !== CellKind.Empty) return false;
  const included = new Uint8Array(document.kind.length);
  for (let position = 0; position < indices.length; position += 1) {
    const index = indices[position];
    if (masks[position] !== 1 || document.kind[index] !== CellKind.Empty) return false;
    included[index] = 1;
  }
  if (included[startIndex] === 0) return false;

  const visited = new Uint8Array(document.kind.length);
  const queue = new Uint32Array(indices.length);
  let head = 0;
  let tail = 0;
  const visit = (neighbor: number): boolean => {
    if (document.kind[neighbor] !== CellKind.Empty) return true;
    if (included[neighbor] === 0) return false;
    if (visited[neighbor] === 0) {
      visited[neighbor] = 1;
      queue[tail++] = neighbor;
    }
    return true;
  };
  queue[tail++] = startIndex;
  visited[startIndex] = 1;
  while (head < tail) {
    const index = queue[head++];
    const x = index % document.width;
    const y = Math.floor(index / document.width);
    if (x > 0 && !visit(index - 1)) return false;
    if (x + 1 < document.width && !visit(index + 1)) return false;
    if (y > 0 && !visit(index - document.width)) return false;
    if (y + 1 < document.height && !visit(index + document.width)) return false;
  }
  return tail === indices.length;
}

function completionPendingState(
  document: PatternDocument,
  index: number,
  mask: number,
  operation: CompletionOperation
): PendingCellState | undefined {
  if (mask === 0) return undefined;
  const completed = operation === 'set'
    ? document.completed[index] | mask
    : document.completed[index] & ~mask;
  if (completed === document.completed[index]) return undefined;
  const offset = index * 4;
  return {
    index,
    cell: { x: index % document.width, y: Math.floor(index / document.width) },
    kind: document.kind[index] as CellKind,
    colors: [document.colors[offset], document.colors[offset + 1], document.colors[offset + 2], document.colors[offset + 3]],
    completed
  };
}

function normalizedPointerPosition(sample: PointerSample, viewport: Viewport): ModelPoint | undefined {
  if (!validScreenSample(sample) || !isFiniteViewport(viewport)) return undefined;
  const point = screenToModel({ x: sample.screenX, y: sample.screenY }, viewport);
  return {
    x: point.x - Math.floor(point.x),
    y: point.y - Math.floor(point.y)
  };
}

/** How far past the crossed edge a drag must reach before a full-stitch stroke claims a new cell. */
const PAINT_CELL_ENTRY_DEPTH = 0.25;

function reachedPaintEntryDepth(from: ModelPoint, to: ModelPoint, local: ModelPoint | undefined): boolean {
  if (!local) return true;
  if (to.x > from.x && local.x < PAINT_CELL_ENTRY_DEPTH) return false;
  if (to.x < from.x && local.x > 1 - PAINT_CELL_ENTRY_DEPTH) return false;
  if (to.y > from.y && local.y < PAINT_CELL_ENTRY_DEPTH) return false;
  if (to.y < from.y && local.y > 1 - PAINT_CELL_ENTRY_DEPTH) return false;
  return true;
}

function completionTargetForCell(
  document: PatternDocument,
  cell: ModelPoint,
  local: ModelPoint
): number {
  const index = cell.y * document.width + cell.x;
  const kind = document.kind[index];
  if (kind === CellKind.Empty) return 0;
  const offset = index * 4;
  if (isLegacyQuarterKind(kind)) {
    const corner = quarterCornerAt({ x: cell.x + local.x, y: cell.y + local.y });
    return document.colors[offset + corner] === 0 ? 0 : 1 << corner;
  }
  if (isThreeQuarterPairKind(kind)) {
    const colors = document.colors.subarray(offset, offset + 4);
    const corner = pairCornerAt({ x: cell.x + local.x, y: cell.y + local.y }, colors);
    const component = threeQuarterPairComponents(colors).find((entry) => entry.corner === corner);
    return component && document.colors[offset + component.slot] !== 0 ? 1 << component.slot : 0;
  }
  if (kind !== CellKind.Full && kind !== CellKind.HalfBackslash && kind !== CellKind.HalfSlash && !isThreeQuarterKind(kind)) return 0;
  return document.colors[offset] === 0 ? 0 : 1;
}

function componentCornerForHit(document: PatternDocument, index: number, corner: 0 | 1 | 2 | 3): 0 | 1 | 2 | 3 | undefined {
  const kind = document.kind[index];
  if (isLegacyQuarterKind(kind)) return corner;
  if (isThreeQuarterKind(kind)) return threeQuarterCornerForKind(kind) === corner ? corner : undefined;
  if (isThreeQuarterPairKind(kind)) {
    const colors = document.colors.subarray(index * 4, index * 4 + 4);
    return threeQuarterPairComponents(colors).some((component) => component.corner === corner) ? corner : undefined;
  }
  return undefined;
}

function applyEraseQuarterState(
  kind: CellKind,
  colors: [number, number, number, number],
  completed: number,
  corner: 0 | 1 | 2 | 3
): { kind: CellKind; colors: [number, number, number, number]; completed: number } {
  if (isLegacyQuarterKind(kind)) {
    colors[corner] = 0;
    completed &= ~(1 << corner);
    if (colors.every((color) => color === 0)) return { kind: CellKind.Empty, colors: [0, 0, 0, 0], completed: 0 };
    return { kind, colors, completed };
  }
  if (isThreeQuarterKind(kind)) {
    if (threeQuarterCornerForKind(kind) !== corner) return { kind, colors, completed };
    return { kind: CellKind.Empty, colors: [0, 0, 0, 0], completed: 0 };
  }
  if (isThreeQuarterPairKind(kind)) {
    const components = threeQuarterPairComponents(colors);
    const remaining = components.find((component) => component.corner !== corner);
    if (!components.some((component) => component.corner === corner) || !remaining) return { kind, colors, completed };
    const nextColors: [number, number, number, number] = [0, 0, 0, 0];
    nextColors[0] = colors[remaining.slot];
    return {
      kind: remaining.kind,
      colors: nextColors,
      completed: (completed & (1 << remaining.slot)) !== 0 ? 1 : 0
    };
  }
  return { kind, colors, completed };
}

function applyThreeQuarterPaintState(
  kind: CellKind,
  colors: [number, number, number, number],
  completed: number,
  corner: 0 | 1 | 2 | 3,
  color: number
): { kind: CellKind; colors: [number, number, number, number]; completed: number } {
  const existingCorner = threeQuarterCornerForKind(kind);
  if (existingCorner !== undefined) {
    if (existingCorner === corner) return { kind, colors: [color, 0, 0, 0], completed: completed & 1 };
    if (!threeQuarterCornersShareAxis(existingCorner, corner)) return { kind, colors, completed };
    const nextColors: [number, number, number, number] = [0, 0, 0, 0];
    nextColors[existingCorner] = colors[0];
    nextColors[corner] = color;
    return {
      kind: ThreeQuarterPair,
      colors: nextColors,
      completed: (completed & 1) !== 0 ? 1 << existingCorner : 0
    };
  }
  if (isThreeQuarterPairKind(kind)) {
    const components = threeQuarterPairComponents(colors);
    if (!components.some((component) => component.corner === corner)) return { kind, colors, completed };
    const nextColors = colors.slice() as [number, number, number, number];
    nextColors[corner] = color;
    return { kind, colors: nextColors, completed };
  }
  return { kind: threeQuarterKindForCorner(corner), colors: [color, 0, 0, 0], completed: 0 };
}

function cellState(document: PatternDocument, index: number, edit: BulkCellEdit): PendingCellState {
  const offset = index * 4;
  let kind = document.kind[index] as CellKind;
  let colors: [number, number, number, number] = [
    document.colors[offset],
    document.colors[offset + 1],
    document.colors[offset + 2],
    document.colors[offset + 3]
  ];
  let completed = document.completed[index];
  if (edit.kind === 'erase-cell') {
    kind = CellKind.Empty;
    colors.fill(0);
    completed = 0;
  } else if (edit.kind === 'erase-quarter') {
    ({ kind, colors, completed } = applyEraseQuarterState(kind, colors, completed, edit.corner));
  } else if (edit.kind === 'full' || edit.kind === 'half') {
    const nextKind = edit.kind === 'full'
      ? CellKind.Full
      : edit.direction === '\\' ? CellKind.HalfBackslash : CellKind.HalfSlash;
    const sameGeometry = kind === nextKind;
    kind = nextKind;
    colors.fill(0);
    colors[0] = edit.color;
    completed = sameGeometry ? completed & 1 : 0;
  } else if (edit.kind === 'three-quarter') {
    ({ kind, colors, completed } = applyThreeQuarterPaintState(kind, colors, completed, edit.corner, edit.color));
  } else {
    const wasQuarter = kind === CellKind.Quarters;
    if (!wasQuarter) {
      kind = CellKind.Quarters;
      colors.fill(0);
      completed = 0;
    }
    const oldColor = colors[edit.corner];
    const oldBit = completed & (1 << edit.corner);
    const nextBit = wasQuarter && oldColor !== 0 ? oldBit : 0;
    colors[edit.corner] = edit.color;
    completed = (completed & ~(1 << edit.corner)) | nextBit;
  }
  return {
    index,
    cell: { x: index % document.width, y: Math.floor(index / document.width) },
    kind,
    colors,
    completed
  };
}

function cellStateChanged(document: PatternDocument, state: PendingCellState): boolean {
  const offset = state.index * 4;
  return document.kind[state.index] !== state.kind
    || document.completed[state.index] !== state.completed
    || document.colors[offset] !== state.colors[0]
    || document.colors[offset + 1] !== state.colors[1]
    || document.colors[offset + 2] !== state.colors[2]
    || document.colors[offset + 3] !== state.colors[3];
}

export function normalizeGridRect(start: ModelPoint, end: ModelPoint): GridRect {
  if (!isFiniteModelPoint(start) || !isFiniteModelPoint(end)) throw new DomainError('invalid-coordinate', 'Selection coordinates must be finite.');
  const left = Math.min(Math.floor(start.x), Math.floor(end.x));
  const top = Math.min(Math.floor(start.y), Math.floor(end.y));
  const right = Math.max(Math.floor(start.x), Math.floor(end.x)) + 1;
  const bottom = Math.max(Math.floor(start.y), Math.floor(end.y)) + 1;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export const gridRectFromPoints = normalizeGridRect;

function boundedGridRect(rect: GridRect, document: PatternDocument): GridRect | undefined {
  const left = Math.max(0, Math.min(document.width, rect.x));
  const top = Math.max(0, Math.min(document.height, rect.y));
  const right = Math.max(left, Math.min(document.width, rect.x + rect.width));
  const bottom = Math.max(top, Math.min(document.height, rect.y + rect.height));
  if (right <= left || bottom <= top) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function clampFloatingDestination(anchor: ModelPoint, fragment: PatternFragment, document: PatternDocument): GridRect {
  const maxX = Math.max(0, document.width - fragment.width);
  const maxY = Math.max(0, document.height - fragment.height);
  return {
    x: Math.min(maxX, Math.max(0, Math.floor(anchor.x))),
    y: Math.min(maxY, Math.max(0, Math.floor(anchor.y))),
    width: fragment.width,
    height: fragment.height
  };
}

function finalizedSelectionBounds(selection: FinalizedSelection | undefined): GridRect | undefined {
  return selection?.kind === 'rect' ? selection.rect : selection?.bounds;
}

function selectionMatchesDocument(selection: FinalizedSelection | undefined, document: PatternDocument | null): boolean {
  return selection === undefined
    || (document !== null
      && selection.documentWidth === document.width
      && selection.documentHeight === document.height);
}

function finalizedSelectionIndices(selection: FinalizedSelection | undefined, document: PatternDocument): Uint32Array | undefined {
  if (!selection) return undefined;
  return selection.kind === 'sparse'
    ? selection.indices
    : selectionRectToIndices(selection.rect, document.width, document.height);
}

function quarterCornerAt(point: ModelPoint): 0 | 1 | 2 | 3 {
  const column = Math.floor((point.x - Math.floor(point.x)) * 2);
  const row = Math.floor((point.y - Math.floor(point.y)) * 2);
  if (row === 0) return column === 0 ? 0 : 1;
  return column === 0 ? 3 : 2;
}

function pairCornerAt(point: ModelPoint, colors: ArrayLike<number>): 0 | 1 | 2 | 3 {
  const localX = point.x - Math.floor(point.x);
  const localY = point.y - Math.floor(point.y);
  const components = threeQuarterPairComponents(colors);
  const first = components[0].corner;
  const second = components[1].corner;
  const firstTriangle = first === 0 ? localX + localY <= 1 : localY <= localX;
  return firstTriangle ? first : second;
}

function fixedPointAt(point: ModelPoint, document: PatternDocument): FixedPoint {
  if (!isFiniteModelPoint(point)) throw new DomainError('invalid-coordinate', 'Backstitch coordinates must be finite.');
  return {
    x: Math.min(document.width * 4, Math.max(0, Math.round(point.x) * 4)),
    y: Math.min(document.height * 4, Math.max(0, Math.round(point.y) * 4))
  };
}

function fixedPointToModel(point: FixedPoint): ModelPoint {
  return { x: point.x / 4, y: point.y / 4 };
}

function distanceToSegment(point: ModelPoint, start: ModelPoint, end: ModelPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const projection = Math.min(1, Math.max(0, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + projection * dx), point.y - (start.y + projection * dy));
}

export function cellRectForIndices(indices: Uint32Array, width: number, height: number): CellRect | undefined {
  if (indices.length === 0 || width < 1 || height < 1) return undefined;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (const index of indices) {
    if (index >= width * height) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return maxX < minX || maxY < minY
    ? undefined
    : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function selectedCellSemantics(document: PatternDocument, cell: ModelPoint): SelectedCellSemantics {
  if (!isFiniteModelPoint(cell)) throw new DomainError('invalid-coordinate', 'Selected cell coordinates must be finite.');
  const x = Math.min(Math.max(0, Math.floor(cell.x)), document.width - 1);
  const y = Math.min(Math.max(0, Math.floor(cell.y)), document.height - 1);
  const index = y * document.width + x;
  const kind = document.kind[index];
  const threeQuarterCorner = threeQuarterCornerForKind(kind);
  const geometry: SelectedCellSemantics['geometry'] = kind === CellKind.Full
    ? 'full'
    : kind === CellKind.HalfBackslash
      ? 'half-backslash'
      : kind === CellKind.HalfSlash
        ? 'half-slash'
        : kind === CellKind.Quarters
          ? 'quarters'
          : isThreeQuarterPairKind(kind)
            ? 'three-quarter-pair'
          : threeQuarterCorner === 0
            ? 'three-quarter-nw'
            : threeQuarterCorner === 1
              ? 'three-quarter-ne'
              : threeQuarterCorner === 2
                ? 'three-quarter-se'
                : threeQuarterCorner === 3
                  ? 'three-quarter-sw'
                  : 'empty';
  const offset = index * 4;
  const slots: readonly number[] = isLegacyQuarterKind(kind)
    ? [0, 1, 2, 3]
    : isThreeQuarterPairKind(kind)
      ? threeQuarterPairComponents(document.colors.subarray(offset, offset + 4)).map((component) => component.slot)
      : kind === CellKind.Empty ? [] : [0];
  const paletteIds: number[] = [];
  let completed = 0;
  for (const slot of slots) {
    const paletteId = document.colors[offset + slot];
    if (paletteId === 0) continue;
    paletteIds.push(paletteId);
    if ((document.completed[index] & (1 << slot)) !== 0) completed += 1;
  }
  const paletteNames = paletteIds.map((paletteId) => document.palette.find((entry) => entry.id === paletteId)?.name ?? `Palette ${String(paletteId)}`);
  const completion: SelectedCellSemantics['completion'] = {
    completed,
    total: paletteIds.length,
    summary: paletteIds.length === 0 ? 'No stitch' : `${String(completed)} of ${String(paletteIds.length)} complete`
  };
  const stitchSummary = geometry === 'empty' ? 'empty' : geometry;
  const paletteSummary = paletteNames.length === 0 ? 'no palette' : paletteNames.join(', ');
  return {
    row: y + 1,
    column: x + 1,
    cell: { x, y },
    geometry,
    paletteId: paletteIds[0] ?? null,
    paletteName: paletteNames[0] ?? null,
    paletteIds,
    paletteNames,
    completion,
    summary: `Row ${String(y + 1)}, column ${String(x + 1)} · ${stitchSummary} · ${paletteSummary} · ${completion.summary}`
  };
}

export function isTextEditingTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const value = target as {
    tagName?: unknown;
    isContentEditable?: unknown;
    getAttribute?: (name: string) => string | null;
    closest?: (selector: string) => unknown;
  };
  if (value.isContentEditable === true) return true;
  if (typeof value.tagName === 'string' && /^(input|textarea|select|option)$/i.test(value.tagName)) return true;
  const contentEditable = value.getAttribute?.('contenteditable');
  if (contentEditable !== null && contentEditable !== undefined && contentEditable !== 'false') return true;
  const editableParent = value.closest?.('[contenteditable]');
  return editableParent !== null && editableParent !== undefined;
}

export class EditorSurfaceController implements EditorSurfaceControllerLifecycle {
  private readonly gateway: WorkspaceEditorGateway;
  private readonly renderer: CanvasRenderer;
  private readonly uiStore: EditorUiStore;
  private metrics: CanvasMetrics | undefined;
  private readonly viewportOptions: ViewportClampOptions;
  private readonly fillClient: FillWorkerClient;
  private readonly ownsFillClient: boolean;
  private traceImage: TraceImage | undefined;
  private readonly traceSampler: TraceImageSampler;
  private readonly catalogDefinition: CatalogDefinition | undefined;
  private traceSampleCallback: TraceSampleCallback | undefined;
  private traceBoundsChangeCallback: TraceBoundsChangeCallback | undefined;
  /** Tool to restore when leaving move/resize-image mode via Escape or a toggle click. */
  private imageToolPreviousTool: EditorToolState | null = null;
  private started = false;
  private disposed = false;
  private editorFocused = false;
  private unsubscribeGateway: (() => void) | undefined;
  private unsubscribeUi: (() => void) | undefined;
  private lastGatewaySnapshot: WorkspaceEditorSnapshot;
  private gesture: Gesture | undefined;
  private readonly touchPointers = new Map<number, PointerSample>();
  private touchHistoryCandidate: TouchHistoryCandidate | undefined;
  /** Touch editing is the default; the UI may opt into movement-only input. */
  private touchMovementOnly = false;
  private lastHoverSample: PointerSample | undefined;
  private spaceHeld = false;
  private commandInFlight = false;
  private selection: FinalizedSelection | undefined;
  private selectionAnchor: ModelPoint | undefined;
  private clipboard: PatternFragment | undefined;
  private clipboardSelection: ClipboardSelectionGeometry | undefined;
  private floatingPaste: FloatingPasteState | undefined;
  private floatingPasteMoveGesture: FloatingPasteMoveGesture | undefined;
  private floatingPasteTouchCandidate: FloatingPasteTouchCandidate | undefined;
  private touchCopyCandidate: TouchCopyCandidate | undefined;
  private eraserCorner: 0 | 1 | 2 | 3 = 0;
  private selectedBackstitchId: number | undefined;
  private keyboardBackstitchAnchor: FixedPoint | undefined;
  private keyboardBackstitchToken: EditorRevisionToken | undefined;
  private fillJob: FillJob | undefined;
  private fillToken: EditorRevisionToken | undefined;
  private fillRecolorSnapshot: FillRecolorSnapshot | undefined;
  /** Window-level keydown listener active only while a reference-image tool is on. */
  private imageToolKeydownListener: ((event: KeyboardEvent) => void) | null = null;

  constructor(options: EditorSurfaceControllerOptions) {
    this.gateway = options.gateway;
    this.renderer = options.renderer;
    this.uiStore = options.uiStore;
    this.metrics = options.metrics;
    this.viewportOptions = { minZoom: options.minZoom, maxZoom: options.maxZoom };
    this.fillClient = options.fillClient ?? createFillWorkerClient();
    this.ownsFillClient = options.fillClient === undefined;
    this.traceImage = options.traceImage;
    this.traceSampler = options.traceSampler ?? ((trace, document, viewport, metrics, point) => sampleTraceImage(trace, document, viewport, metrics, point));
    this.catalogDefinition = options.catalogDefinition;
    this.traceSampleCallback = options.onTraceSample;
    this.traceBoundsChangeCallback = options.onTraceBoundsChange;
    if (this.traceImage) this.renderer.setTraceImage?.(this.traceImage);
    this.lastGatewaySnapshot = this.gateway.getSnapshot();
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.unsubscribeGateway = this.gateway.subscribe((snapshot) => this.onGatewaySnapshot(snapshot));
    this.unsubscribeUi = this.uiStore.subscribe((state, previous) => this.onUiState(state, previous));
    this.lastGatewaySnapshot = this.gateway.getSnapshot();
    this.onGatewaySnapshot(this.lastGatewaySnapshot, true);
    const initialDocument = this.lastGatewaySnapshot.document;
    if (initialDocument && this.metrics) this.projectViewport(normalizeViewport(this.uiStore.getState().viewport, initialDocument, this.metrics, this.viewportOptions));
    this.projectUiState(this.uiStore.getState());
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.unsubscribeGateway?.();
    this.unsubscribeUi?.();
    this.unsubscribeGateway = undefined;
    this.unsubscribeUi = undefined;
    this.discardFloatingPaste();
    this.floatingPasteTouchCandidate = undefined;
    this.touchCopyCandidate = undefined;
    this.cancelGesture();
    this.cancelFill(false);
    this.touchPointers.clear();
    this.spaceHeld = false;
    this.editorFocused = false;
  }

  setDocument(document: PatternDocument, invalidation?: Invalidation): void {
    if (this.disposed) return;
    const snapshot = this.gateway.getSnapshot();
    const documentChanged = snapshot.document !== document || snapshot.revision !== document.revision;
    if (documentChanged && this.floatingPaste) this.discardFloatingPaste();
    this.reconcileSelectionDimensions(document);
    if (documentChanged && this.gesture) {
      this.cancelGesture();
      this.setStatus('Stroke cancelled: project changed');
    }
    if (documentChanged && this.fillJob) this.cancelFill(false);
    const rendererDocument = this.renderer.getDocument?.();
    const rendererOwnsDocumentGeneration = !documentChanged
      && invalidation?.reason !== 'project-switch'
      && rendererDocument === document
      && rendererDocument.revision === document.revision;
    if (rendererOwnsDocumentGeneration) {
      this.publishSelectedCellForDocument(document, true);
      return;
    }
    this.renderer.setDocument(document, invalidation ?? { layer: 'all', full: true, reason: 'external-document' });
    this.publishSelectedCellForDocument(document, true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.exitImageTool();
    this.stop();
    if (this.ownsFillClient) this.fillClient.dispose();
    this.disposed = true;
  }

  setTouchMovementOnly(enabled: boolean): void {
    if (this.touchMovementOnly === enabled) return;
    this.touchMovementOnly = enabled;
    if (this.touchPointers.size === 0) return;
    // Do not let a gesture started under the previous policy commit after the
    // policy changes.
    this.cancelGesture();
    this.touchPointers.clear();
    this.touchCopyCandidate = undefined;
    this.clearTouchCopyRequest();
  }

  setTool(tool: EditorToolState): void {
    const state = this.uiStore.getState();
    if (state.tool.tool !== tool.tool && this.floatingPaste) this.discardFloatingPaste();
    if (state.tool.tool !== tool.tool) this.resetToolTransient();
    if (tool.tool === 'move-image') {
      this.enterMoveImage();
      return;
    }
    if (tool.tool === 'resize-image') {
      this.enterResizeImage();
      return;
    }
    if (state.tool.tool === 'move-image' || state.tool.tool === 'resize-image') {
      // Leaving a reference-image tool by any other tool clears the remembered
      // state and restores full pattern opacity.
      this.exitImageTool();
    }
    if (tool.tool === 'eraser' && tool.corner !== undefined) this.eraserCorner = tool.corner;
    if (tool.tool === 'paint' && tool.brush === undefined) {
      // Normalize brush-less paint states while keeping Fill palette-driven.
      const carried = state.tool.tool === 'paint' ? state.tool.brush : undefined;
      const brush: StitchBrush = carried ?? { kind: 'full', paletteId: state.paletteId ?? this.firstActivePaletteId() ?? 1 };
      this.uiStore.setTool({ tool: 'paint', brush });
      return;
    }
    this.uiStore.setTool(tool);
  }

  setEraserMode(mode: EraserMode): void {
    const current = this.uiStore.getState().tool;
    this.setTool({ tool: 'eraser', mode });
    if (current.tool === 'eraser' && current.mode === mode) this.uiStore.setTool({ ...current, mode });
  }

  setEraserCorner(corner: 0 | 1 | 2 | 3): void {
    this.eraserCorner = corner;
    const current = this.uiStore.getState().tool;
    if (current.tool === 'eraser') this.uiStore.setTool({ ...current, corner });
  }

  getSelection(): GridRect | undefined {
    this.reconcileSelectionDimensions(this.gateway.getSnapshot().document);
    return finalizedSelectionBounds(this.selection);
  }

  /** Ordered indices are kept available for the domain sparse-selection lane. */
  getSelectionIndices(): Uint32Array | undefined {
    const document = this.gateway.getSnapshot().document;
    this.reconcileSelectionDimensions(document);
    return document ? finalizedSelectionIndices(this.selection, document) : undefined;
  }

  setSelection(start: ModelPoint, end = start): GridRect | undefined {
    const document = this.gateway.getSnapshot().document;
    if (!document || !isFiniteModelPoint(start) || !isFiniteModelPoint(end)) return undefined;
    const rect = boundedGridRect(normalizeGridRect(start, end), document);
    this.selection = rect ? { kind: 'rect', rect, documentWidth: document.width, documentHeight: document.height } : undefined;
    this.selectionAnchor = rect ? { x: rect.x, y: rect.y } : undefined;
    this.clearTouchCopyRequest();
    this.publishSelectionOverlay();
    return rect;
  }

  clearSelection(): void {
    this.selection = undefined;
    this.selectionAnchor = undefined;
    this.clearTouchCopyRequest();
    this.publishSelectionOverlay();
  }

  private reconcileSelectionDimensions(document: PatternDocument | null): void {
    if (selectionMatchesDocument(this.selection, document)) return;
    this.selection = undefined;
    this.selectionAnchor = undefined;
    this.clearTouchCopyRequest();
    this.publishSelectionOverlay();
  }

  getClipboard(): PatternFragment | undefined {
    return this.clipboard ? clonePatternFragment(this.clipboard) : undefined;
  }

  private captureMoveSelection(document: PatternDocument, selection: FinalizedSelection): {
    readonly fragment: PatternFragment;
    readonly geometry: ClipboardSelectionGeometry;
    readonly source: FragmentSelection;
    readonly completion: Uint8Array;
    readonly backstitches: FloatingPasteBackstitches;
  } | undefined {
    const bounds = finalizedSelectionBounds(selection);
    const indices = finalizedSelectionIndices(selection, document);
    if (!bounds || !indices || indices.length === 0) return undefined;
    const fragment = clonePatternFragment(selection.kind === 'sparse'
      ? createPatternFragmentFromCells(document, indices)
      : createPatternFragment(document, bounds));
    const completion = new Uint8Array(fragment.width * fragment.height);
    for (const index of indices) {
      const x = index % document.width;
      const y = Math.floor(index / document.width);
      completion[(y - bounds.y) * fragment.width + x - bounds.x] = document.completed[index];
    }
    let containedCount = 0;
    for (let index = 0; index < document.backstitches.ids.length; index += 1) {
      if (backstitchEndpointsContainedInCellUnion(document.backstitches.x1[index], document.backstitches.y1[index], document.backstitches.x2[index], document.backstitches.y2[index], document.width, document.height, indices)) containedCount += 1;
    }
    const backstitches: FloatingPasteBackstitches = {
      ids: new Uint32Array(containedCount),
      x1: new Uint32Array(containedCount),
      y1: new Uint32Array(containedCount),
      x2: new Uint32Array(containedCount),
      y2: new Uint32Array(containedCount),
      colors: new Uint16Array(containedCount),
      completed: new Uint8Array(containedCount)
    };
    let backstitchPosition = 0;
    for (let index = 0; index < document.backstitches.ids.length; index += 1) {
      if (!backstitchEndpointsContainedInCellUnion(document.backstitches.x1[index], document.backstitches.y1[index], document.backstitches.x2[index], document.backstitches.y2[index], document.width, document.height, indices)) continue;
      backstitches.ids[backstitchPosition] = document.backstitches.ids[index];
      backstitches.x1[backstitchPosition] = document.backstitches.x1[index] - bounds.x * 4;
      backstitches.y1[backstitchPosition] = document.backstitches.y1[index] - bounds.y * 4;
      backstitches.x2[backstitchPosition] = document.backstitches.x2[index] - bounds.x * 4;
      backstitches.y2[backstitchPosition] = document.backstitches.y2[index] - bounds.y * 4;
      backstitches.colors[backstitchPosition] = document.backstitches.colors[index];
      backstitches.completed[backstitchPosition] = document.backstitches.completed[index];
      backstitchPosition += 1;
    }
    const geometry: ClipboardSelectionGeometry = selection.kind === 'sparse'
      ? {
        kind: 'sparse',
        rect: { ...bounds },
        boundaries: selection.boundaries.map((boundary) => ({
          start: { x: boundary.start.x - bounds.x, y: boundary.start.y - bounds.y },
          end: { x: boundary.end.x - bounds.x, y: boundary.end.y - bounds.y },
          kind: boundary.kind
        }))
      }
      : { kind: 'rect', rect: { ...bounds } };
    const source: FragmentSelection = selection.kind === 'sparse'
      ? { kind: 'sparse', rect: { ...bounds }, indices: indices.slice() }
      : { kind: 'rect', rect: { ...bounds } };
    return { fragment, geometry, source, completion, backstitches };
  }

  copySelection(): PatternFragment | undefined {
    const snapshot = this.gateway.getSnapshot();
    this.reconcileSelectionDimensions(snapshot.document);
    if (!snapshot.document || !this.selection) return undefined;
    const bounds = finalizedSelectionBounds(this.selection);
    if (!bounds) return undefined;
    const indices = finalizedSelectionIndices(this.selection, snapshot.document);
    const copySelection: ClipboardSelectionGeometry = this.selection.kind === 'sparse'
      ? {
        kind: 'sparse',
        rect: { ...bounds },
        boundaries: this.selection.boundaries.map((boundary) => ({
          start: { x: boundary.start.x - bounds.x, y: boundary.start.y - bounds.y },
          end: { x: boundary.end.x - bounds.x, y: boundary.end.y - bounds.y },
          kind: boundary.kind
        }))
      }
      : { kind: 'rect', rect: { ...bounds } };
    this.clipboard = clonePatternFragment(this.selection.kind === 'sparse' && indices
      ? createPatternFragmentFromCells(snapshot.document, indices)
      : createPatternFragment(snapshot.document, bounds));
    this.clipboardSelection = copySelection;
    this.uiStore.setCanPaste(true);
    this.clearTouchCopyRequest();
    this.setStatus(this.selection.kind === 'sparse'
      ? `Copied ${String(this.selection.indices.length)} cells`
      : `Copied ${String(bounds.width)}×${String(bounds.height)} cells`);
    return clonePatternFragment(this.clipboard);
  }

  moveSelection(): boolean {
    const snapshot = this.gateway.getSnapshot();
    this.reconcileSelectionDimensions(snapshot.document);
    if (!snapshot.document || !snapshot.projectId || snapshot.revision === null || !this.selection) return false;
    const captured = this.captureMoveSelection(snapshot.document, this.selection);
    if (!captured) return false;
    const destination = clampFloatingDestination(finalizedSelectionBounds(this.selection) ?? captured.geometry.rect, captured.fragment, snapshot.document);
    const previousSelection = this.selection;
    const previousSelectionAnchor = this.selectionAnchor;
    this.floatingPasteMoveGesture = undefined;
    this.floatingPasteTouchCandidate = undefined;
    this.touchCopyCandidate = undefined;
    this.clearTouchCopyRequest();
    this.selection = undefined;
    this.selectionAnchor = undefined;
    this.floatingPaste = {
      mode: 'move',
      fragment: captured.fragment,
      copySelection: captured.geometry,
      sourceSelection: captured.geometry,
      moveSelection: captured.source,
      completion: captured.completion,
      backstitches: captured.backstitches,
      destination,
      token: { projectId: snapshot.projectId, revision: snapshot.revision },
      previousSelection,
      previousSelectionAnchor
    };
    this.publishSelectionOverlay();
    this.publishFloatingPasteOverlay();
    this.setStatus('Move ready');
    return true;
  }

  pasteSelection(): boolean {
    const snapshot = this.gateway.getSnapshot();
    this.reconcileSelectionDimensions(snapshot.document);
    if (!snapshot.document || !snapshot.projectId || snapshot.revision === null || !this.clipboard) return false;
    const fragment = clonePatternFragment(this.clipboard);
    if (fragment.width > snapshot.document.width || fragment.height > snapshot.document.height) {
      this.setStatus('Paste unavailable');
      return false;
    }
    const bounds = finalizedSelectionBounds(this.selection);
    const anchor = bounds ? { x: bounds.x, y: bounds.y } : this.uiStore.getState().keyboardCursor;
    if (!anchor) return false;
    const destination = clampFloatingDestination(anchor, fragment, snapshot.document);
    const copySelection = this.clipboardSelection ?? {
      kind: 'rect' as const,
      rect: { x: 0, y: 0, width: fragment.width, height: fragment.height }
    };
    const previous = this.floatingPaste;
    const previousSelection = previous?.previousSelection ?? this.selection;
    const previousSelectionAnchor = previous?.previousSelectionAnchor ?? this.selectionAnchor;
    this.floatingPasteMoveGesture = undefined;
    this.floatingPasteTouchCandidate = undefined;
    this.touchCopyCandidate = undefined;
    this.clearTouchCopyRequest();
    this.selection = undefined;
    this.selectionAnchor = undefined;
    this.floatingPaste = {
      mode: 'paste',
      fragment,
      copySelection,
      destination,
      token: { projectId: snapshot.projectId, revision: snapshot.revision },
      previousSelection,
      previousSelectionAnchor
    };
    this.publishSelectionOverlay();
    this.publishFloatingPasteOverlay();
    this.setStatus('Paste ready');
    return true;
  }

  pasteClipboard(): boolean {
    return this.pasteSelection();
  }

  dismissTouchCopyRequest(): void {
    this.clearTouchCopyRequest();
  }

  private commitFloatingPaste(): boolean {
    const floating = this.floatingPaste;
    if (!floating) return false;
    const snapshot = this.gateway.getSnapshot();
    if (!this.isCurrentTransaction(floating.token, snapshot) || !snapshot.document || !snapshot.projectId || snapshot.revision === null) {
      this.discardFloatingPaste();
      this.setStatus('Paste cancelled: project changed');
      return false;
    }
    const command = floating.mode === 'move'
      ? floating.moveSelection
        ? moveFragmentCommand(floating.moveSelection, { x: floating.destination.x, y: floating.destination.y }, snapshot.revision)
        : undefined
      : pasteFragmentCommand(floating.fragment, { x: floating.destination.x, y: floating.destination.y }, snapshot.revision);
    if (!command) {
      this.discardFloatingPaste();
      return false;
    }
    try {
      if (floating.mode === 'paste') {
        const preflight = preflightPasteFragmentCommand(snapshot.document, command);
        if (preflight.changedCellCount === 0 && preflight.newBackstitchCount === 0) {
          this.discardFloatingPaste();
          this.setStatus('No change');
          return true;
        }
      }
      this.commandInFlight = true;
      const result = this.gateway.execute(command, { projectId: snapshot.projectId, revision: snapshot.revision });
      this.commandInFlight = false;
      if (!result.changed) {
        this.discardFloatingPaste();
        this.setStatus('No change');
        return true;
      }
      this.floatingPaste = undefined;
      this.floatingPasteMoveGesture = undefined;
      this.floatingPasteTouchCandidate = undefined;
      this.selection = undefined;
      this.selectionAnchor = undefined;
      this.publishFloatingPasteOverlay();
      this.projectCommandResult(result, undefined, floating.mode === 'move'
        ? `Moved ${String(floating.fragment.width)}×${String(floating.fragment.height)} cells`
        : `Pasted ${String(floating.fragment.width)}×${String(floating.fragment.height)} cells`);
      this.publishSelectionOverlay();
      return true;
    } catch (error) {
      this.commandInFlight = false;
      if (error instanceof StaleEditorTransactionError) {
        this.discardFloatingPaste();
        this.setStatus('Paste cancelled: project changed');
        return false;
      }
      if (error instanceof DomainError) {
        this.setStatus('Paste unavailable');
        return false;
      }
      throw error;
    }
  }

  cancelFill(showStatus = true): boolean {
    const job = this.fillJob;
    this.fillRecolorSnapshot = undefined;
    if (!job) return false;
    this.fillJob = undefined;
    this.fillToken = undefined;
    job.cancel();
    this.setFillPending(false);
    if (showStatus) this.setStatus('Fill cancelled');
    return true;
  }

  cancelActiveFill(): boolean {
    return this.cancelFill();
  }

  fillAt(cell?: ModelPoint): boolean {
    const target = cell ?? this.uiStore.getState().keyboardCursor ?? { x: 0, y: 0 };
    return this.startFillAt(target);
  }

  isFillPending(): boolean {
    return this.fillJob !== undefined;
  }

  getSelectedBackstitchId(): number | undefined {
    return this.selectedBackstitchId;
  }

  deleteSelectedBackstitch(): boolean {
    if (this.floatingPaste) return false;
    const id = this.selectedBackstitchId;
    const snapshot = this.gateway.getSnapshot();
    if (id === undefined || !snapshot.projectId || snapshot.revision === null) return false;
    const result = this.executeCommandWithToken(
      { type: 'remove-backstitch', id },
      `Deleted backstitch ${String(id)}`
    );
    if (result) this.resetBackstitchState();
    return result;
  }

  /** Delete the current cell selection as one revision-safe history operation. */
  deleteSelection(): boolean {
    if (this.floatingPaste) return false;
    const selectedBackstitchId = this.selectedBackstitchId;
    const snapshot = this.gateway.getSnapshot();
    this.reconcileSelectionDimensions(snapshot.document);
    const currentSelection = this.selection;
    const bounds = finalizedSelectionBounds(currentSelection);
    if (!currentSelection || !bounds || !snapshot.document || !snapshot.projectId || snapshot.revision === null) return false;
    const indices = finalizedSelectionIndices(currentSelection, snapshot.document);
    const command = currentSelection.kind === 'sparse' && indices
      ? deleteCellSetCommand(indices, snapshot.revision)
      : deleteRegionCommand(bounds, snapshot.revision);
    const result = this.executeCommandWithToken(
      command,
      `Deleted ${String(currentSelection.kind === 'sparse' ? currentSelection.indices.length : bounds.width * bounds.height)} cell${(currentSelection.kind === 'sparse' ? currentSelection.indices.length : bounds.width * bounds.height) === 1 ? '' : 's'}`
    );
    const after = this.gateway.getSnapshot().document;
    if (result && selectedBackstitchId !== undefined && after && !after.backstitches.ids.some((id) => id === selectedBackstitchId)) this.resetBackstitchState();
    this.clearSelection();
    return result;
  }

  handleFocus(): void {
    this.editorFocused = true;
  }

  setBrush(brush: StitchBrush): void {
    this.uiStore.setState({ tool: { tool: 'paint', brush }, paletteId: brush.paletteId });
  }

  getBrushSize(): number {
    return normalizeBrushSize(this.uiStore.getBrushSize?.() ?? this.uiStore.getState().brushSize ?? 1);
  }

  setBrushSize(size: number): void {
    this.uiStore.setBrushSize(normalizeBrushSize(size));
  }

  setToolBrushSize(tool: BrushSizeTool, size: number): void {
    this.uiStore.setToolBrushSize(tool, normalizeBrushSize(size));
  }

  setAuthoringBrush(brush: AuthoringStitchBrush): void {
    this.setBrush(brush);
  }

  setChartMode(mode: Parameters<EditorUiStore['setMode']>[0]): void {
    this.uiStore.setMode(mode);
  }

  setMode(mode: Parameters<EditorUiStore['setMode']>[0]): void {
    this.setChartMode(mode);
  }

  setGridVisible(visible: boolean): void {
    this.uiStore.setGridVisible(visible);
  }

  setMetrics(metrics: CanvasMetrics): void {
    if (this.disposed) return;
    // Pointer samples and pinch baselines are expressed in the old viewport
    // coordinate system. Discard them before changing CSS/DPR metrics so a
    // later sample cannot bridge or jump across the resize.
    this.cancelGesture();
    this.touchPointers.clear();
    this.touchCopyCandidate = undefined;
    this.clearTouchCopyRequest();
    this.metrics = metrics;
    this.renderer.setMetrics(metrics);
    const snapshot = this.gateway.getSnapshot();
    if (snapshot.document) this.projectViewport(normalizeViewport(this.uiStore.getState().viewport, snapshot.document, metrics, this.viewportOptions));
  }

  setTraceImage(trace: TraceImage | undefined): void {
    if (this.disposed) return;
    this.traceImage = trace;
    this.renderer.setTraceImage(trace);
  }

  setTraceImageSettings(settings: Pick<TraceImage, 'visible' | 'opacity'>): void {
    if (this.disposed || !this.traceImage) return;
    this.traceImage = { ...this.traceImage, ...settings };
    this.renderer.setTraceImageSettings?.(settings);
  }

  clearTraceImage(): void {
    this.setTraceImage(undefined);
  }

  getTraceImage(): TraceImage | undefined {
    return this.traceImage ?? this.renderer.getTraceImage?.();
  }

  setTraceSampleCallback(callback: TraceSampleCallback | undefined): void {
    this.traceSampleCallback = callback;
  }

  sampleTraceAt(point: ScreenPoint): TraceRgb | undefined {
    const snapshot = this.gateway.getSnapshot();
    const trace = this.getTraceImage();
    if (!isFiniteScreenPoint(point) || !isFiniteViewport(this.uiStore.getState().viewport) || !snapshot.document || !trace || !this.metrics) return undefined;
    return this.traceSampler(trace, snapshot.document, this.uiStore.getState().viewport, this.metrics, point);
  }

  /** Eyedropper: pick a cell's palette color, otherwise sample the reference image. */
  private eyedropperAt(sample: PointerSample, document: PatternDocument): boolean {
    if (!validScreenSample(sample) || !isFiniteViewport(this.uiStore.getState().viewport)) return false;
    const point = screenToModel({ x: sample.screenX, y: sample.screenY }, this.uiStore.getState().viewport);
    const cell = this.paintHitCell(sample, document);
    if (cell) {
      const picked = this.pickCellPalette(document, cell, point);
      if (picked !== undefined) {
        this.activatePickedColor(picked);
        return true;
      }
    }
    const rgb = this.sampleTraceAt({ x: sample.screenX, y: sample.screenY });
    if (!rgb) return false;
    return this.activateSampledColor(rgb);
  }

  private pickCellPalette(document: PatternDocument, cell: ModelPoint, point?: ModelPoint): number | undefined {
    const index = cell.y * document.width + cell.x;
    const kind = document.kind[index];
    if (kind === CellKind.Empty) return undefined;
    const offset = index * 4;
    if (isThreeQuarterPairKind(kind) && point) {
      const colors = document.colors.subarray(offset, offset + 4);
      const corner = pairCornerAt(point, colors);
      const component = threeQuarterPairComponents(colors).find((entry) => entry.corner === corner);
      const paletteId = component && document.colors[offset + component.slot];
      if (paletteId) return paletteId;
    }
    const slots: readonly number[] = isLegacyQuarterKind(kind)
      ? [0, 1, 2, 3]
      : isThreeQuarterPairKind(kind)
        ? threeQuarterPairComponents(document.colors.subarray(offset, offset + 4)).map((component) => component.slot)
        : [0];
    for (const slot of slots) {
      const paletteId = document.colors[offset + slot];
      if (paletteId !== 0) return paletteId;
    }
    return undefined;
  }

  private activatePickedColor(paletteId: number): void {
    this.selectPalette(paletteId);
    this.setTool({ tool: 'paint', brush: { kind: 'full', paletteId } });
  }

  private activateSampledColor(rgb: TraceRgb): boolean {
    const snapshot = this.gateway.getSnapshot();
    const document = snapshot.document;
    const suppliedDefinition = this.catalogDefinition;
    const definition = document
      && suppliedDefinition?.association.catalogId === document.catalog.catalogId
      && suppliedDefinition.association.brandLabel === document.catalog.brandLabel
      && suppliedDefinition.association.colorCount === document.catalog.colorCount
      ? suppliedDefinition
      : undefined;
    if (!document || !definition) {
      this.traceSampleCallback?.(rgb);
      return false;
    }
    const matched = definition.nearest({ r: rgb.r, g: rgb.g, b: rgb.b });
    const existing = matched === undefined ? undefined : document.palette.find((entry) => entry.active
      && entry.catalog?.catalogId === definition.association.catalogId
      && entry.catalog.sourceId === matched.sourceId);
    const paletteId = existing?.id;
    if (paletteId === undefined) {
      if (!matched) {
        this.traceSampleCallback?.(rgb);
        return false;
      }
      try {
        const result = this.gateway.execute({
          type: 'palette-create',
          name: matched.name,
          color: matched.hex,
          active: true,
          catalog: createCatalogReference(definition, matched)
        });
        if (result.paletteId === undefined) return false;
        this.selectCreatedPalette(result.paletteId);
        this.setTool({ tool: 'paint', brush: { kind: 'full', paletteId: result.paletteId } });
      } catch {
        return false;
      }
    } else {
      this.activatePickedColor(paletteId);
    }
    this.traceSampleCallback?.(rgb);
    return true;
  }

  private floatingPasteContains(sample: PointerSample, destination = this.floatingPaste?.destination): boolean {
    if (!destination || !validScreenSample(sample) || !isFiniteViewport(this.uiStore.getState().viewport)) return false;
    const point = screenToModel({ x: sample.screenX, y: sample.screenY }, this.uiStore.getState().viewport);
    return point.x >= destination.x && point.y >= destination.y
      && point.x < destination.x + destination.width && point.y < destination.y + destination.height;
  }

  private updateFloatingPasteDestination(sample: PointerSample, gesture: FloatingPasteMoveGesture): void {
    const floating = this.floatingPaste;
    const snapshot = this.gateway.getSnapshot();
    if (!floating || !snapshot.document || !isFiniteViewport(this.uiStore.getState().viewport)) return;
    const viewport = this.uiStore.getState().viewport;
    const next = clampFloatingDestination({
      x: gesture.startDestination.x + Math.round((sample.screenX - gesture.startScreenX) / viewport.zoom),
      y: gesture.startDestination.y + Math.round((sample.screenY - gesture.startScreenY) / viewport.zoom)
    }, floating.fragment, snapshot.document);
    if (next.x === floating.destination.x && next.y === floating.destination.y) return;
    this.floatingPaste = { ...floating, destination: next };
    this.publishFloatingPasteOverlay();
  }

  private restoreFloatingPasteMove(): void {
    const gesture = this.floatingPasteMoveGesture;
    const floating = this.floatingPaste;
    if (!gesture || !floating) return;
    if (floating.destination.x !== gesture.startDestination.x || floating.destination.y !== gesture.startDestination.y) {
      this.floatingPaste = { ...floating, destination: { ...gesture.startDestination } };
      this.publishFloatingPasteOverlay();
    }
    this.floatingPasteMoveGesture = undefined;
  }

  private handleFloatingPointerDown(sample: PointerSample): boolean | undefined {
    const floating = this.floatingPaste;
    if (!floating) return undefined;
    if (sample.pointerType !== 'touch'
      && (this.spaceHeld || sample.button === 1 || Boolean(sample.buttons && (sample.buttons & 4) !== 0))) return undefined;
    if (sample.pointerType === 'touch') {
      if (this.touchPointers.size === 0) this.beginTouchHistoryCandidate(sample);
      this.touchPointers.set(sample.pointerId, sample);
      this.updateTouchHistoryCandidate(sample);
      if (this.touchPointers.size >= 2) {
        this.restoreFloatingPasteMove();
        this.floatingPasteTouchCandidate = undefined;
        if (this.gesture?.kind !== 'pinch') this.beginPinch();
        return true;
      }
      const inside = this.floatingPasteContains(sample);
      this.floatingPasteTouchCandidate = {
        pointerId: sample.pointerId,
        action: inside ? 'move' : 'commit',
        startScreenX: sample.screenX,
        startScreenY: sample.screenY
      };
      if (inside) {
        this.floatingPasteMoveGesture = {
          pointerId: sample.pointerId,
          startScreenX: sample.screenX,
          startScreenY: sample.screenY,
          startDestination: { ...floating.destination }
        };
      }
      return true;
    }
    if (sample.pointerType !== 'mouse' && sample.pointerType !== 'pen') return true;
    const primary = (sample.button ?? 0) === 0 && !this.spaceHeld;
    if (!primary || sample.button === 1 || Boolean(sample.buttons && (sample.buttons & 4) !== 0)) return true;
    if (this.floatingPasteContains(sample)) {
      this.floatingPasteMoveGesture = {
        pointerId: sample.pointerId,
        startScreenX: sample.screenX,
        startScreenY: sample.screenY,
        startDestination: { ...floating.destination }
      };
      return true;
    }
    this.commitFloatingPaste();
    return true;
  }

  private handleFloatingPointerMove(sample: PointerSample): boolean | undefined {
    if (!this.floatingPaste) return undefined;
    if (sample.pointerType === 'touch' && (this.gesture?.kind === 'pinch' || this.gesture?.kind === 'pan')) return undefined;
    if (this.floatingPasteMoveGesture?.pointerId === sample.pointerId) {
      if (sample.pointerType === 'touch') this.updateTouchHistoryCandidate(sample);
      this.updateFloatingPasteDestination(sample, this.floatingPasteMoveGesture);
      return true;
    }
    if (this.floatingPasteTouchCandidate?.pointerId === sample.pointerId) {
      const candidate = this.floatingPasteTouchCandidate;
      if (Math.hypot(sample.screenX - candidate.startScreenX, sample.screenY - candidate.startScreenY) > TOUCH_HISTORY_TAP_SLOP_PIXELS) {
        this.floatingPasteTouchCandidate = undefined;
        this.floatingPasteMoveGesture = undefined;
        this.rejectTouchHistoryCandidate('movement');
      }
      return true;
    }
    return sample.pointerType === 'touch' ? true : undefined;
  }

  private handleFloatingPointerUp(sample: PointerSample): boolean | undefined {
    if (!this.floatingPaste) return undefined;
    if (sample.pointerType === 'touch' && (this.gesture?.kind === 'pinch' || this.gesture?.kind === 'pan')) return undefined;
    if (this.floatingPasteMoveGesture?.pointerId === sample.pointerId) {
      this.floatingPasteMoveGesture = undefined;
      this.floatingPasteTouchCandidate = undefined;
      if (sample.pointerType === 'touch') this.touchPointers.delete(sample.pointerId);
      if (sample.pointerType === 'touch' && this.touchPointers.size === 0) this.finishTouchHistoryCandidate();
      return true;
    }
    if (this.floatingPasteTouchCandidate?.pointerId === sample.pointerId) {
      const candidate = this.floatingPasteTouchCandidate;
      this.floatingPasteTouchCandidate = undefined;
      if (sample.pointerType === 'touch') this.touchPointers.delete(sample.pointerId);
      if (sample.pointerType === 'touch' && this.touchPointers.size === 0) this.finishTouchHistoryCandidate();
      if (candidate.action === 'commit') this.commitFloatingPaste();
      return true;
    }
    if (sample.pointerType === 'touch') {
      if (this.gesture?.kind === 'pan' && this.gesture.pointerId === sample.pointerId) this.gesture = undefined;
      this.touchPointers.delete(sample.pointerId);
      if (this.touchPointers.size === 0) this.finishTouchHistoryCandidate();
      return true;
    }
    return undefined;
  }

  private handleFloatingPointerCancel(sample: PointerSample, lostCapture = false): boolean | undefined {
    if (!this.floatingPaste) return undefined;
    const ownsMove = this.floatingPasteMoveGesture?.pointerId === sample.pointerId;
    const ownsCandidate = this.floatingPasteTouchCandidate?.pointerId === sample.pointerId;
    if (!ownsMove && !ownsCandidate) return undefined;
    if (sample.pointerType === 'touch') {
      this.rejectTouchHistoryCandidate(lostCapture ? 'lost-capture' : 'cancelled');
      this.touchPointers.delete(sample.pointerId);
    }
    this.discardFloatingPaste();
    return true;
  }

  private touchCopyCell(document: PatternDocument, sample: PointerSample): ModelPoint | undefined {
    if (!this.selection) return undefined;
    const cell = this.paintHitCell(sample, document);
    if (!cell) return undefined;
    const indices = finalizedSelectionIndices(this.selection, document);
    if (!indices) return undefined;
    const index = cell.y * document.width + cell.x;
    for (const selected of indices) if (selected === index) return cell;
    return undefined;
  }

  private beginTouchCopyFallback(candidate: TouchCopyCandidate, sample: PointerSample): boolean {
    const snapshot = this.gateway.getSnapshot();
    const document = snapshot.document;
    if (!document) return true;
    if (candidate.pointerType === 'touch' && this.touchMovementOnly) {
      this.gesture = {
        kind: 'pan',
        pointerId: candidate.pointerId,
        lastX: candidate.sample.screenX,
        lastY: candidate.sample.screenY
      };
      this.updatePan(sample);
      return true;
    }
    const previousSelection = this.selection;
    const previousSelectionAnchor = this.selectionAnchor;
    if (candidate.tool === 'select') {
      const cell = this.paintHitCell(candidate.sample, document);
      if (!cell) return true;
      this.selectionAnchor = cell;
      this.selection = {
        kind: 'rect',
        rect: normalizeGridRect(cell, cell),
        documentWidth: document.width,
        documentHeight: document.height
      };
      this.gesture = {
        kind: 'selection',
        pointerId: candidate.pointerId,
        anchor: cell,
        hadSelection: previousSelection !== undefined,
        previousSelection,
        previousSelectionAnchor,
        current: cell
      };
      this.publishSelectionOverlay();
      return false;
    }
    const point = this.lassoModelPoint(candidate.sample);
    const cell = this.paintHitCell(candidate.sample, document);
    if (!cell || !point || !snapshot.projectId || snapshot.revision === null) return true;
    const operation: LassoGesture['operation'] = candidate.sample.altKey ? 'subtract' : candidate.sample.shiftKey ? 'union' : 'replace';
    this.gesture = {
      kind: 'lasso',
      pointerId: candidate.pointerId,
      token: { projectId: snapshot.projectId, revision: snapshot.revision },
      startingCell: cell,
      operation,
      points: [point],
      raster: createLassoRasterAccumulator(document.width, document.height, point, { x: cell.x + 0.5, y: cell.y + 0.5 }),
      previewSamples: 0
    };
    this.publishLassoPath([point]);
    return false;
  }

  private advanceTouchCopyCandidate(sample: PointerSample): boolean | undefined {
    const candidate = this.touchCopyCandidate;
    if (!candidate || candidate.pointerId !== sample.pointerId) return undefined;
    if (Math.hypot(sample.screenX - candidate.sample.screenX, sample.screenY - candidate.sample.screenY) <= TOUCH_HISTORY_TAP_SLOP_PIXELS) return undefined;
    this.touchCopyCandidate = undefined;
    this.clearTouchCopyRequest();
    return this.beginTouchCopyFallback(candidate, sample);
  }

  private publishTouchCopyRequest(candidate: TouchCopyCandidate, sample: PointerSample): boolean {
    const selection = finalizedSelectionBounds(this.selection);
    if (!selection) return false;
    const state = this.uiStore.getState();
    this.uiStore.setOverlay({
      ...state.overlay,
      touchCopyRequest: {
        cell: { ...candidate.cell },
        selection: { ...selection },
        screenX: sample.screenX,
        screenY: sample.screenY
      }
    });
    return true;
  }

  pointerDown(sample: PointerSample): boolean {
    return this.handlePointerDown(sample);
  }

  pointerMove(sample: PointerSample): boolean {
    return this.handlePointerMove(sample);
  }

  pointerUp(sample: PointerSample): boolean {
    return this.handlePointerUp(sample);
  }

  pointerCancel(sample: PointerSample): boolean {
    return this.handlePointerCancel(sample);
  }

  pointerLostCapture(sample: PointerSample): boolean {
    return this.handlePointerLostCapture(sample);
  }

  wheel(sample: WheelSample): boolean {
    return this.handleWheel(sample);
  }

  keyDown(sample: KeyboardSample): boolean {
    return this.handleKeyDown(sample);
  }

  keyUp(sample: KeyboardSample): boolean {
    return this.handleKeyUp(sample);
  }

  /** Select a palette entry returned by a successful palette-create command. */
  selectCreatedPalette(paletteId: number): void {
    this.setPaletteSelection(paletteId);
  }

  selectPalette(paletteId: number | null): void {
    if (paletteId === null) {
      this.uiStore.setPaletteId(paletteId);
      return;
    }
    this.setPaletteSelection(paletteId);
  }

  private setPaletteSelection(paletteId: number): void {
    const state = this.uiStore.getState();
    if (state.tool.tool !== 'paint') {
      this.uiStore.setPaletteId(paletteId);
      return;
    }
    const brush = state.tool.brush;
    const nextBrush: StitchBrush = brush === undefined
      ? { kind: 'full', paletteId }
      : brush.kind === 'full'
        ? { kind: 'full', paletteId }
        : brush.kind === 'half'
          ? { kind: 'half', ...(brush.direction === undefined ? {} : { direction: brush.direction }), paletteId }
          : brush.kind === 'three-quarter'
            ? { kind: 'three-quarter', paletteId }
            : { kind: 'quarter', corner: brush.corner, paletteId };
    this.uiStore.setState({ paletteId, tool: { tool: 'paint', brush: nextBrush } });
  }

  handlePointerDown(sample: PointerSample): boolean {
    this.ensureStarted();
    if (this.disposed) return false;
    if (!validScreenSample(sample)) return false;
    this.clearBrushPreview();
    this.clearTouchCopyRequest();
    const floatingPointerDown = this.handleFloatingPointerDown(sample);
    if (floatingPointerDown !== undefined) return floatingPointerDown;
    if (sample.pointerType !== 'touch') this.editorFocused = true;
    if (sample.pointerType === 'touch') {
      const tool = this.uiStore.getState().tool.tool;
      if (tool === 'move-image' || tool === 'resize-image') {
        // Single-finger image-tool drags; keep multi-touch ignored.
        this.rejectTouchHistoryCandidate('reference-image-tool');
        debugTouch('history-excluded', { reason: 'reference-image-tool', tool });
        if (this.gesture?.kind === tool && this.gesture.pointerId !== sample.pointerId) return true;
        const snapshot = this.gateway.getSnapshot();
        if (!snapshot.document) return false;
        return tool === 'move-image' ? this.beginMoveImage(sample, snapshot.document) : this.beginResizeImage(sample);
      }
      if (this.touchPointers.size === 0) this.beginTouchHistoryCandidate(sample);
      this.touchPointers.set(sample.pointerId, sample);
      this.updateTouchHistoryCandidate(sample);
      if (this.touchPointers.size === 1 && sample.isPrimary !== false && !this.gesture && (tool === 'select' || tool === 'lasso')) {
        const snapshot = this.gateway.getSnapshot();
        const cell = snapshot.document ? this.touchCopyCell(snapshot.document, sample) : undefined;
        if (cell) {
          this.touchCopyCandidate = { pointerId: sample.pointerId, pointerType: sample.pointerType, tool, cell, sample };
          return true;
        }
      }
      if (this.touchPointers.size >= 2) {
        this.touchCopyCandidate = undefined;
        this.clearTouchCopyRequest();
      }
      if (this.touchMovementOnly) {
        if (this.touchPointers.size >= 2 && this.gesture?.kind !== 'pinch') this.beginPinch();
        else if (this.touchPointers.size === 1) this.gesture = { kind: 'pan', pointerId: sample.pointerId, lastX: sample.screenX, lastY: sample.screenY };
        return true;
      }
      if (this.touchPointers.size >= 2) {
        if (this.gesture?.kind !== 'pinch' && this.gesture?.kind !== 'pan') this.cancelTouchEditingGesture();
        if (this.gesture?.kind !== 'pinch') this.beginPinch();
        return true;
      }
    }
    if (this.gesture) return false;
    const selectedTool = this.uiStore.getState().tool;
    const pan = sample.button === 1 || Boolean(sample.buttons && (sample.buttons & 4) !== 0) || this.spaceHeld || selectedTool.tool === 'pan';
    if (pan) {
      this.gesture = { kind: 'pan', pointerId: sample.pointerId, lastX: sample.screenX, lastY: sample.screenY };
      return true;
    }
    if ((sample.button ?? 0) !== 0 || (sample.pointerType !== 'mouse' && sample.pointerType !== 'pen' && sample.pointerType !== 'touch')) return false;
    const snapshot = this.gateway.getSnapshot();
    if (!snapshot.document || !snapshot.projectId || snapshot.revision === null) return false;
    if (selectedTool.tool === 'move-image') {
      return this.beginMoveImage(sample, snapshot.document);
    }
    if (selectedTool.tool === 'resize-image') {
      return this.beginResizeImage(sample);
    }
    if (sample.isPrimary !== false && (sample.pointerType === 'mouse' || sample.pointerType === 'pen')
      && (selectedTool.tool === 'select' || selectedTool.tool === 'lasso')) {
      const cell = this.touchCopyCell(snapshot.document, sample);
      if (cell) {
        this.touchCopyCandidate = {
          pointerId: sample.pointerId,
          pointerType: sample.pointerType,
          tool: selectedTool.tool,
          cell,
          sample
        };
        return true;
      }
    }
    if (selectedTool.tool === 'eyedropper' && sample.pointerType === 'touch') {
      this.gesture = {
        kind: 'touch-action',
        pointerId: sample.pointerId,
        tool: 'eyedropper',
        token: { projectId: snapshot.projectId, revision: snapshot.revision },
        startScreenX: sample.screenX,
        startScreenY: sample.screenY
      };
      return true;
    }
    if (selectedTool.tool === 'eyedropper') {
      return this.eyedropperAt(sample, snapshot.document);
    }
    if (selectedTool.tool === 'select') {
      const cell = this.paintHitCell(sample, snapshot.document);
      const previousSelection = this.selection;
      const previousSelectionAnchor = this.selectionAnchor;
      if (!cell) {
        const hadSelection = previousSelection !== undefined;
        if (sample.pointerType === 'touch' && hadSelection) {
          this.selection = undefined;
          this.selectionAnchor = undefined;
          this.gesture = {
            kind: 'selection',
            pointerId: sample.pointerId,
            anchor: undefined,
            hadSelection,
            previousSelection,
            previousSelectionAnchor,
            current: undefined
          };
          this.publishSelectionOverlay();
          return true;
        }
        if (hadSelection) this.clearSelection();
        return hadSelection;
      }
      const hadSelection = previousSelection !== undefined;
      this.selectionAnchor = cell;
      this.selection = { kind: 'rect', rect: normalizeGridRect(cell, cell), documentWidth: snapshot.document.width, documentHeight: snapshot.document.height };
      this.gesture = {
        kind: 'selection',
        pointerId: sample.pointerId,
        anchor: cell,
        hadSelection,
        previousSelection,
        previousSelectionAnchor,
        current: cell
      };
      this.publishSelectionOverlay();
      return true;
    }
    if (selectedTool.tool === 'lasso') {
      const cell = this.paintHitCell(sample, snapshot.document);
      const point = this.lassoModelPoint(sample);
      if (!cell || !point) return false;
      const operation: LassoGesture['operation'] = sample.altKey ? 'subtract' : sample.shiftKey ? 'union' : 'replace';
      this.gesture = {
        kind: 'lasso',
        pointerId: sample.pointerId,
        token: { projectId: snapshot.projectId, revision: snapshot.revision },
        startingCell: cell,
        operation,
        points: [point],
        raster: createLassoRasterAccumulator(
          snapshot.document.width,
          snapshot.document.height,
          point,
          { x: cell.x + 0.5, y: cell.y + 0.5 }
        ),
        previewSamples: 0
      };
      this.publishLassoPath([point]);
      return true;
    }
    if (selectedTool.tool === 'shape') {
      const cell = this.paintHitCell(sample, snapshot.document);
      const paletteId = this.uiStore.getState().paletteId;
      const paletteEntry = paletteId === null
        ? undefined
        : snapshot.document.palette.find((entry) => entry.id === paletteId && entry.active);
      if (!cell || !paletteEntry) return false;
      const transaction = this.gateway.beginTransaction();
      const gesture: ShapeGesture = {
        kind: 'shape',
        pointerId: sample.pointerId,
        transaction,
        shape: selectedTool.shape,
        anchor: cell,
        edit: { kind: 'full', color: paletteEntry.id },
        brushSize: this.getBrushSize(),
        cells: new Map<string, ModelPoint>()
      };
      this.gesture = gesture;
      this.updateShapeCells(gesture, cell, snapshot.document);
      this.publishPendingCells(gesture.cells, this.pendingPaintStates(gesture.cells, gesture.edit, transaction.token.revision, snapshot.document));
      return true;
    }
    if (selectedTool.tool === 'fill') {
      const cell = this.paintHitCell(sample, snapshot.document);
      const local = normalizedPointerPosition(sample, this.uiStore.getState().viewport);
      const mask = cell && local ? completionTargetForCell(snapshot.document, cell, local) : 0;
      const isEmpty = cell !== undefined
        && snapshot.document.kind[cell.y * snapshot.document.width + cell.x] === CellKind.Empty;
      if (sample.pointerType === 'touch') {
        if (!cell || (mask === 0 && !isEmpty)) return false;
        this.gesture = {
          kind: 'touch-action',
          pointerId: sample.pointerId,
          tool: 'fill',
          token: { projectId: snapshot.projectId, revision: snapshot.revision },
          startScreenX: sample.screenX,
          startScreenY: sample.screenY
        };
        return true;
      }
      return cell && (mask !== 0 || isEmpty) ? this.startFillAt(cell, mask || undefined) : false;
    }
    if (selectedTool.tool === 'backstitch') return this.beginBackstitch(sample, snapshot);
    if (selectedTool.tool === 'completion') {
      const cell = this.paintHitCell(sample, snapshot.document);
      const local = normalizedPointerPosition(sample, this.uiStore.getState().viewport);
      if (!cell || !local) return false;
      const mask = completionTargetForCell(snapshot.document, cell, local);
      if (mask === 0) return false;
      const transaction = this.gateway.beginTransaction();
      const operation: CompletionOperation = (snapshot.document.completed[cell.y * snapshot.document.width + cell.x] & mask) === mask ? 'clear' : 'set';
      const targets = new Map<number, CompletionTarget>();
      stampCompletionTargets(targets, cell, snapshot.document, local);
      this.gesture = { kind: 'completion', pointerId: sample.pointerId, transaction, operation, targets, lastCell: cell };
      this.publishPendingCells(completionTargetCells(targets), this.pendingCompletionStates(targets, operation, snapshot.document));
      return true;
    }
    if (selectedTool.tool === 'eraser') {
      const cell = this.paintHitCell(sample, snapshot.document);
      if (!cell) return false;
      const transaction = this.gateway.beginTransaction();
      const brushSize = this.getBrushSize();
      const cells = new Map<string, ModelPoint>();
      const components = new Map<string, { readonly cell: ModelPoint; readonly corner: number }>();
      const mode = selectedTool.mode ?? 'whole-cell';
      this.addEraserSample(cells, components, cell, mode, sample, snapshot.document, brushSize);
      this.gesture = { kind: 'eraser', pointerId: sample.pointerId, transaction, mode, brushSize, cells, components, lastCell: cell };
      this.publishPendingCells(cells, this.pendingEraserStates(cells, components, mode, snapshot.document));
      return true;
    }
    if (selectedTool.tool !== 'paint') return false;
    const cell = this.paintHitCell(sample, snapshot.document);
    if (!cell) return false;
    const transaction = this.gateway.beginTransaction();
    const brushSize = this.getBrushSize();
    const cells = new Map<string, ModelPoint>();
    stampBrush(cells, cell, brushSize, snapshot.document);
    const edit = editForBrush(selectedTool.brush, this.paintCorner(sample));
    this.gesture = { kind: 'paint', pointerId: sample.pointerId, transaction, brush: selectedTool.brush, edit, brushSize, cells, lastCell: cell };
    this.publishPendingCells(cells, this.pendingPaintStates(cells, edit, transaction.token.revision, snapshot.document));
    return true;
  }

  handlePointerMove(sample: PointerSample): boolean {
    this.ensureStarted();
    if (this.disposed) return false;
    if (!validScreenSample(sample)) return false;
    const floatingPointerMove = this.handleFloatingPointerMove(sample);
    if (floatingPointerMove !== undefined) return floatingPointerMove;
    if (sample.pointerType !== 'touch') {
      const pointerCopyFallback = this.advanceTouchCopyCandidate(sample);
      if (pointerCopyFallback === true) return true;
    }
    if (sample.pointerType !== 'touch') {
      this.lastHoverSample = sample;
      if (!this.gesture) this.updateBrushPreview(sample);
    }
    if (sample.pointerType === 'touch') {
      if (!this.touchPointers.has(sample.pointerId) && this.gesture?.kind !== 'move-image' && this.gesture?.kind !== 'resize-image') return false;
      this.touchPointers.set(sample.pointerId, sample);
      const stationaryHistoryTap = this.updateTouchHistoryCandidate(sample);
      const touchCopyFallback = this.advanceTouchCopyCandidate(sample);
      if (touchCopyFallback === true) return true;
      if (this.gesture?.kind === 'move-image') {
        if (this.gesture.pointerId === sample.pointerId) this.updateMoveImage(sample);
        return true;
      }
      if (this.gesture?.kind === 'resize-image') {
        if (this.gesture.pointerId === sample.pointerId) this.updateResizeImage(sample);
        return true;
      }
      if (this.gesture?.kind === 'touch-action') {
        if (this.gesture.pointerId === sample.pointerId
          && Math.hypot(sample.screenX - this.gesture.startScreenX, sample.screenY - this.gesture.startScreenY) > TOUCH_HISTORY_TAP_SLOP_PIXELS) this.cancelGesture();
        return true;
      }
      if (this.gesture?.kind === 'pinch') {
        if (!stationaryHistoryTap) this.updatePinch();
      } else if (this.gesture?.kind === 'pan' && this.gesture.pointerId === sample.pointerId) {
        if (!stationaryHistoryTap) this.updatePan(sample);
      } else if (this.touchMovementOnly) {
        return true;
      }
      // Single-finger touch editing uses the same chart-tool paths as mouse
      // and pen input. Multi-touch has already been consumed above.
      if (this.gesture?.kind === 'pinch' || this.gesture?.kind === 'pan') return true;
    }
    const gesture = this.gesture;
    if (!gesture || gesture.kind === 'pinch' || gesture.pointerId !== sample.pointerId) return false;
    if (gesture.kind === 'move-image') {
      this.updateMoveImage(sample);
      return true;
    }
    if (gesture.kind === 'resize-image') {
      this.updateResizeImage(sample);
      return true;
    }
    if (gesture.kind === 'shape') {
      const snapshot = this.gateway.getSnapshot();
      if (!this.isCurrentTransaction(gesture.transaction.token, snapshot)) {
        this.cancelGesture();
        this.setStatus('Stroke cancelled: project changed');
        return true;
      }
      const document = snapshot.document;
      if (!document) return false;
      this.appendShapeSample(gesture, sample, document);
      this.publishPendingCells(gesture.cells, this.pendingPaintStates(gesture.cells, gesture.edit, gesture.transaction.token.revision, document));
      return true;
    }
    if (gesture.kind === 'paint') {
      const snapshot = this.gateway.getSnapshot();
      if (!this.isCurrentTransaction(gesture.transaction.token, snapshot)) {
        this.cancelGesture();
        this.setStatus('Stroke cancelled: project changed');
        return true;
      }
      const document = snapshot.document;
      if (!document) return false;
      this.appendPaintSample(gesture, sample, document);
      this.publishPendingCells(gesture.cells, this.pendingPaintStates(gesture.cells, gesture.edit, gesture.transaction.token.revision, document));
      return true;
    }
    if (gesture.kind === 'completion') {
      const snapshot = this.gateway.getSnapshot();
      if (!this.isCurrentTransaction(gesture.transaction.token, snapshot)) {
        this.cancelGesture();
        this.setStatus('Completion cancelled: project changed');
        return true;
      }
      const document = snapshot.document;
      if (!document) return false;
      this.appendCompletionSample(gesture, sample, document);
      this.publishPendingCells(completionTargetCells(gesture.targets), this.pendingCompletionStates(gesture.targets, gesture.operation, document));
      return true;
    }
    if (gesture.kind === 'eraser') {
      const snapshot = this.gateway.getSnapshot();
      if (!this.isCurrentTransaction(gesture.transaction.token, snapshot)) {
        this.cancelGesture();
        this.setStatus('Erase cancelled: project changed');
        return true;
      }
      const document = snapshot.document;
      if (!document) return false;
      this.appendEraserSample(gesture, sample, document);
      this.publishPendingCells(gesture.cells, this.pendingEraserStates(gesture.cells, gesture.components, gesture.mode, document));
      return true;
    }
    if (gesture.kind === 'lasso') {
      const snapshot = this.gateway.getSnapshot();
      if (!this.isCurrentTransaction(gesture.token, snapshot)) {
        this.cancelGesture();
        this.setStatus('Lasso cancelled: project changed');
        return true;
      }
      const point = this.lassoModelPoint(sample);
      if (point) {
        appendLassoRasterPoint(gesture.raster, point);
      }
      if (point && appendLassoPoint(gesture.points, point)) {
        gesture.previewSamples += 1;
        // Once the hard cap is approached, clone the bounded preview less
        // often. Finalization still uses every retained point and always
        // publishes the latest path before clearing it.
        if (gesture.points.length < MAX_LASSO_PATH_POINTS / 2 || gesture.previewSamples % 16 === 0) this.publishLassoPath(gesture.points);
      }
      return true;
    }
    if (gesture.kind === 'selection') {
      const document = this.gateway.getSnapshot().document;
      if (!document) return false;
      if (!gesture.anchor) return true;
      const cell = this.paintHitCell(sample, document);
      if (!cell) return true;
      gesture.current = cell;
      const rect = boundedGridRect(normalizeGridRect(gesture.anchor, cell), document);
      this.selection = rect ? { kind: 'rect', rect, documentWidth: document.width, documentHeight: document.height } : undefined;
      this.publishSelectionOverlay();
      return true;
    }
    if (gesture.kind === 'backstitch') {
      const document = this.gateway.getSnapshot().document;
      if (!document || !isFiniteViewport(this.uiStore.getState().viewport)) return false;
      const snapped = fixedPointAt(this.backstitchModelPoint(sample), document);
      if (gesture.movingEndpoint === 'start') gesture.start = snapped;
      else gesture.end = snapped;
      this.publishBackstitchPreview(gesture.start, gesture.end);
      return true;
    }
    this.updatePan(sample);
    return true;
  }

  handlePointerUp(sample: PointerSample): boolean {
    this.ensureStarted();
    const touchPointerReleased = sample.pointerType === 'touch';
    if (!validScreenSample(sample)) {
      const gesture = this.gesture;
      if (gesture && gesture.kind !== 'pinch' && gesture.pointerId === sample.pointerId) this.cancelGesture();
      return false;
    }
    const floatingPointerUp = this.handleFloatingPointerUp(sample);
    if (floatingPointerUp !== undefined) return floatingPointerUp;
    const pointerCopyCandidate = this.touchCopyCandidate?.pointerId === sample.pointerId ? this.touchCopyCandidate : undefined;
    if (pointerCopyCandidate && sample.pointerType !== 'touch') {
      if (Math.hypot(sample.screenX - pointerCopyCandidate.sample.screenX, sample.screenY - pointerCopyCandidate.sample.screenY) <= TOUCH_HISTORY_TAP_SLOP_PIXELS) {
        this.touchCopyCandidate = undefined;
        this.publishTouchCopyRequest(pointerCopyCandidate, sample);
        return true;
      }
      const fallbackHandled = this.advanceTouchCopyCandidate(sample);
      if (fallbackHandled !== true) this.handlePointerMove(sample);
    }
    if (sample.pointerType === 'touch') {
      this.updateTouchHistoryCandidate(sample);
      const touchCopyCandidate = this.touchCopyCandidate?.pointerId === sample.pointerId ? this.touchCopyCandidate : undefined;
      if (touchCopyCandidate) {
        const moved = Math.hypot(sample.screenX - touchCopyCandidate.sample.screenX, sample.screenY - touchCopyCandidate.sample.screenY)
          > TOUCH_HISTORY_TAP_SLOP_PIXELS;
        if (!moved) {
          this.touchCopyCandidate = undefined;
          this.touchPointers.delete(sample.pointerId);
          if (this.touchPointers.size === 0) this.finishTouchHistoryCandidate();
          this.publishTouchCopyRequest(touchCopyCandidate, sample);
          return true;
        }
        const fallbackHandled = this.advanceTouchCopyCandidate(sample);
        if (fallbackHandled !== true) this.handlePointerMove(sample);
      }
      this.touchPointers.delete(sample.pointerId);
      if (this.gesture?.kind === 'move-image') {
        if (this.gesture.pointerId === sample.pointerId) this.finishMoveImage(this.gesture, sample);
        return true;
      }
      if (this.gesture?.kind === 'resize-image') {
        if (this.gesture.pointerId === sample.pointerId) this.finishResizeImage();
        return true;
      }
      if (this.gesture?.kind === 'pinch') {
        if (this.gesture.pointerIds.includes(sample.pointerId)) this.rebaseTouchGesture();
      } else if (this.gesture?.kind === 'pan' && this.gesture.pointerId === sample.pointerId) this.gesture = undefined;
      if (this.touchPointers.size === 0) this.finishTouchHistoryCandidate();
      if (this.gesture?.kind === 'pinch' || this.gesture?.kind === 'pan' || this.touchPointers.size > 0) return true;
    }
    const gesture = this.gesture;
    if (gesture?.kind === 'touch-action' && gesture.pointerId === sample.pointerId) {
      this.gesture = undefined;
      this.finishTouchAction(gesture, sample);
      return true;
    }
    if (!gesture || gesture.kind === 'pinch' || gesture.pointerId !== sample.pointerId) {
      if (touchPointerReleased && this.touchPointers.size === 0) this.finishTouchHistoryCandidate();
      return touchPointerReleased;
    }
    if (gesture.kind === 'shape') {
      const document = this.gateway.getSnapshot().document;
      if (document) this.appendShapeSample(gesture, sample, document);
      this.finishShape(true);
    } else if (gesture.kind === 'paint') {
      const document = this.gateway.getSnapshot().document;
      if (document) this.appendPaintSample(gesture, sample, document);
      this.finishPaint(true);
    } else if (gesture.kind === 'completion') {
      const document = this.gateway.getSnapshot().document;
      if (document) this.appendCompletionSample(gesture, sample, document);
      this.finishCompletion(true);
    } else if (gesture.kind === 'eraser') {
      const document = this.gateway.getSnapshot().document;
      if (document) this.appendEraserSample(gesture, sample, document);
      this.finishEraser(true);
    } else if (gesture.kind === 'lasso') {
      const snapshot = this.gateway.getSnapshot();
      if (!this.isCurrentTransaction(gesture.token, snapshot)) {
        this.cancelGesture();
        this.setStatus('Lasso cancelled: project changed');
        if (touchPointerReleased && this.touchPointers.size === 0) this.finishTouchHistoryCandidate();
        return true;
      }
      const point = this.lassoModelPoint(sample);
      if (point) {
        appendLassoRasterPoint(gesture.raster, point);
        appendLassoPoint(gesture.points, point);
      }
      this.finishLasso(gesture);
    } else if (gesture.kind === 'selection') {
      this.gesture = undefined;
      const click = gesture.anchor !== undefined && gesture.current !== undefined
        && gesture.anchor.x === gesture.current.x && gesture.anchor.y === gesture.current.y;
      if (gesture.hadSelection && click) this.clearSelection();
      else this.publishSelectionOverlay();
    } else if (gesture.kind === 'backstitch') {
      const document = this.gateway.getSnapshot().document;
      if (document && isFiniteViewport(this.uiStore.getState().viewport)) {
        const snapped = fixedPointAt(this.backstitchModelPoint(sample), document);
        if (gesture.movingEndpoint === 'start') gesture.start = snapped;
        else gesture.end = snapped;
        this.publishBackstitchPreview(gesture.start, gesture.end);
      }
      this.finishBackstitch(gesture);
    } else if (gesture.kind === 'move-image') {
      this.finishMoveImage(gesture, sample);
    } else if (gesture.kind === 'resize-image') {
      this.finishResizeImage();
    } else this.gesture = undefined;
    if (touchPointerReleased && this.touchPointers.size === 0) this.finishTouchHistoryCandidate();
    return true;
  }

  handlePointerCancel(sample: PointerSample): boolean {
    this.ensureStarted();
    this.spaceHeld = false;
    this.clearBrushPreview();
    const floatingPointerCancel = this.handleFloatingPointerCancel(sample);
    if (floatingPointerCancel !== undefined) return floatingPointerCancel;
    if (sample.pointerType !== 'touch' && this.touchCopyCandidate?.pointerId === sample.pointerId) {
      this.touchCopyCandidate = undefined;
      this.clearTouchCopyRequest();
      return true;
    }
    if (sample.pointerType === 'touch') {
      this.rejectTouchHistoryCandidate('cancelled');
      if (this.touchCopyCandidate?.pointerId === sample.pointerId) {
        this.touchCopyCandidate = undefined;
        this.clearTouchCopyRequest();
      }
      this.touchPointers.delete(sample.pointerId);
      if ((this.gesture?.kind === 'move-image' || this.gesture?.kind === 'resize-image') && this.gesture.pointerId === sample.pointerId) this.gesture = undefined;
      else if (this.gesture?.kind === 'pinch') {
        if (this.gesture.pointerIds.includes(sample.pointerId)) this.rebaseTouchGesture();
      } else if (this.gesture?.kind === 'pan' && this.gesture.pointerId === sample.pointerId) this.gesture = undefined;
      else if (!this.touchMovementOnly && this.gesture?.pointerId === sample.pointerId) this.cancelGesture();
      if (this.touchPointers.size === 0) this.clearTouchHistoryCandidate();
      return true;
    }
    const gesture = this.gesture;
    if (!gesture || gesture.kind === 'pinch' || gesture.pointerId !== sample.pointerId) return false;
    if (gesture.kind === 'shape') this.finishShape(false);
    else if (gesture.kind === 'paint') this.finishPaint(false);
    else if (gesture.kind === 'completion') this.finishCompletion(false);
    else if (gesture.kind === 'eraser') this.finishEraser(false);
    else if (gesture.kind === 'lasso') {
      this.gesture = undefined;
      this.clearLassoPath();
    }
    else if (gesture.kind === 'selection') this.cancelGesture();
    else if (gesture.kind === 'backstitch') this.resetBackstitchState();
    else if (gesture.kind === 'move-image' || gesture.kind === 'resize-image') this.gesture = undefined;
    else this.gesture = undefined;
    return true;
  }

  handlePointerLeave(): void {
    this.lastHoverSample = undefined;
    this.clearBrushPreview();
  }

  handlePointerLostCapture(sample: PointerSample): boolean {
    this.ensureStarted();
    this.spaceHeld = false;
    const floatingPointerLostCapture = this.handleFloatingPointerCancel(sample, true);
    if (floatingPointerLostCapture !== undefined) return floatingPointerLostCapture;
    if (sample.pointerType !== 'touch' && this.touchCopyCandidate?.pointerId === sample.pointerId) {
      this.touchCopyCandidate = undefined;
      this.clearTouchCopyRequest();
      return true;
    }
    if (sample.pointerType === 'touch') {
      // Browsers can emit lostpointercapture immediately after pointerup has
      // already removed this pointer. That notification is not a cancellation
      // of the still-active multi-touch sequence.
      if (!this.touchPointers.has(sample.pointerId)) return true;
      this.rejectTouchHistoryCandidate('lost-capture');
      if (this.touchCopyCandidate?.pointerId === sample.pointerId) {
        this.touchCopyCandidate = undefined;
        this.clearTouchCopyRequest();
      }
      this.touchPointers.delete(sample.pointerId);
      if ((this.gesture?.kind === 'move-image' || this.gesture?.kind === 'resize-image') && this.gesture.pointerId === sample.pointerId) this.gesture = undefined;
      else if (this.gesture?.kind === 'pinch') {
        if (this.gesture.pointerIds.includes(sample.pointerId)) this.rebaseTouchGesture();
      } else if (this.gesture?.kind === 'pan' && this.gesture.pointerId === sample.pointerId) this.gesture = undefined;
      else if (!this.touchMovementOnly && this.gesture?.pointerId === sample.pointerId) this.cancelGesture();
      if (this.touchPointers.size === 0) this.clearTouchHistoryCandidate();
      return true;
    }
    const gesture = this.gesture;
    if (!gesture || gesture.kind === 'pinch' || gesture.pointerId !== sample.pointerId) return false;
    if (gesture.kind === 'move-image' || gesture.kind === 'resize-image') this.gesture = undefined;
    this.cancelGesture();
    return true;
  }

  handleWheel(sample: WheelSample): boolean {
    this.ensureStarted();
    if (this.disposed) return false;
    if (!isFiniteScreenPoint({ x: sample.screenX, y: sample.screenY }) || !Number.isFinite(sample.deltaY)) return false;
    const viewport = this.uiStore.getState().viewport;
    if (!isFiniteViewport(viewport)) return false;
    const factor = Math.exp(-sample.deltaY * 0.001);
    this.projectViewport(zoomAt(viewport, { x: sample.screenX, y: sample.screenY }, viewport.zoom * factor, this.viewportOptions));
    return true;
  }

  handleKeyDown(sample: KeyboardSample): boolean {
    this.ensureStarted();
    if (this.disposed || isTextEditingTarget(sample.target)) return false;
    const key = sample.key;
    const lower = key.toLowerCase();
    const modified = Boolean(sample.ctrlKey || sample.metaKey);
    if (modified && lower === 'z') {
      sample.preventDefault?.();
      this.historyAction(sample.shiftKey ? 'redo' : 'undo');
      return true;
    }
    if (modified && lower === 'y') {
      sample.preventDefault?.();
      this.historyAction('redo');
      return true;
    }
    if (modified && lower === 'c') {
      if (!this.editorFocused || isTextEditingTarget(sample.target)) return false;
      sample.preventDefault?.();
      return this.copySelection() !== undefined;
    }
    if (modified && lower === 'v') {
      if (!this.editorFocused || isTextEditingTarget(sample.target)) return false;
      sample.preventDefault?.();
      return this.pasteSelection();
    }
    if (key === 'Escape') {
      sample.preventDefault?.();
      this.clearTouchCopyRequest();
      if (this.floatingPaste) {
        this.discardFloatingPaste();
        return true;
      }
      if (this.uiStore.getState().tool.tool === 'move-image' || this.uiStore.getState().tool.tool === 'resize-image') {
        this.setTool(this.imageToolPreviousTool ?? { tool: 'pan' });
        return true;
      }
      const hadBackstitchAnchor = this.keyboardBackstitchAnchor !== undefined;
      this.cancelGesture();
      this.clearSelection();
      this.cancelFill();
      this.resetBackstitchState();
      if (hadBackstitchAnchor) this.setStatus('Backstitch start cancelled');
      return true;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') {
      sample.preventDefault?.();
      const cursor = this.uiStore.getState().keyboardCursor ?? { x: 0, y: 0 };
      const delta = key === 'ArrowLeft' ? { x: -1, y: 0 } : key === 'ArrowRight' ? { x: 1, y: 0 } : key === 'ArrowUp' ? { x: 0, y: -1 } : { x: 0, y: 1 };
      this.setKeyboardCursor({ x: cursor.x + delta.x, y: cursor.y + delta.y }, Boolean(sample.shiftKey));
      return true;
    }
    if (key === ' ' || key === 'Spacebar' || key === 'Space') {
      sample.preventDefault?.();
      this.spaceHeld = true;
      return true;
    }
    if (key === 'Enter') {
      sample.preventDefault?.();
      if (this.floatingPaste) return true;
      this.activateKeyboardCursor();
      return true;
    }
    if (key === 'Delete' || key === 'Backspace') {
      sample.preventDefault?.();
      if (this.floatingPaste) return true;
      if (this.selection) this.deleteSelection();
      else if (this.uiStore.getState().tool.tool === 'backstitch' && this.selectedBackstitchId !== undefined) this.deleteSelectedBackstitch();
      else this.eraseAtKeyboardCursor();
      return true;
    }
    if (key === '+' || (key === '=' && sample.shiftKey)) {
      sample.preventDefault?.();
      this.projectViewport(zoomBy(this.uiStore.getState().viewport, this.viewportCenter(), 1.25, this.viewportOptions));
      return true;
    }
    if (key === '-') {
      sample.preventDefault?.();
      this.projectViewport(zoomBy(this.uiStore.getState().viewport, this.viewportCenter(), 0.8, this.viewportOptions));
      return true;
    }
    if (key === '0') {
      sample.preventDefault?.();
      this.fit();
      return true;
    }
    return false;
  }

  handleKeyUp(sample: KeyboardSample): boolean {
    if (sample.key === ' ' || sample.key === 'Spacebar' || sample.key === 'Space') {
      this.spaceHeld = false;
      if (isTextEditingTarget(sample.target)) return false;
      return true;
    }
    if (isTextEditingTarget(sample.target)) return false;
    return false;
  }

  handleBlur(): void {
    this.spaceHeld = false;
    this.editorFocused = false;
    if (this.floatingPaste) this.discardFloatingPaste();
    this.floatingPasteTouchCandidate = undefined;
    this.touchCopyCandidate = undefined;
    this.clearTouchCopyRequest();
    this.rejectTouchHistoryCandidate('blur');
    this.clearTouchHistoryCandidate();
    if (this.gesture?.kind === 'backstitch') this.resetBackstitchState();
  }

  private beginTouchHistoryCandidate(sample: PointerSample): void {
    this.touchHistoryCandidate = {
      startPositions: new Map([[sample.pointerId, { x: sample.screenX, y: sample.screenY }]]),
      distinctPointerIds: new Set([sample.pointerId]),
      ...(Number.isFinite(sample.timeStamp) ? { startedAt: sample.timeStamp } : {}),
      maxPointers: 1,
      invalid: false
    };
    debugTouch('history-candidate-begin', {
      pointerId: sample.pointerId,
      distinctContacts: 1,
      concurrentContacts: 1,
      x: sample.screenX,
      y: sample.screenY,
      timeStamp: sample.timeStamp ?? null
    });
  }

  private rejectTouchHistoryCandidate(reason: TouchHistoryRejectionReason): void {
    const candidate = this.touchHistoryCandidate;
    if (!candidate || candidate.rejectionReason) return;
    candidate.invalid = true;
    candidate.rejectionReason = reason;
    debugTouch('history-candidate-rejected', {
      reason,
      distinctContacts: candidate.distinctPointerIds.size,
      maxConcurrentContacts: candidate.maxPointers
    });
  }

  private updateTouchHistoryCandidate(sample: PointerSample): boolean {
    const candidate = this.touchHistoryCandidate;
    if (!candidate) return false;
    candidate.distinctPointerIds.add(sample.pointerId);
    if (candidate.distinctPointerIds.size > 3) this.rejectTouchHistoryCandidate('distinct-contact-limit');
    candidate.maxPointers = Math.max(candidate.maxPointers, this.touchPointers.size);
    if (candidate.maxPointers > 3) this.rejectTouchHistoryCandidate('concurrent-contact-limit');
    const start = candidate.startPositions.get(sample.pointerId);
    if (!start) candidate.startPositions.set(sample.pointerId, { x: sample.screenX, y: sample.screenY });
    if (start && Math.hypot(sample.screenX - start.x, sample.screenY - start.y) > TOUCH_HISTORY_TAP_SLOP_PIXELS) this.rejectTouchHistoryCandidate('movement');
    if (candidate.startedAt !== undefined && Number.isFinite(sample.timeStamp)
      && sample.timeStamp! - candidate.startedAt > TOUCH_HISTORY_TAP_MAX_DURATION_MS) this.rejectTouchHistoryCandidate('duration');
    return !candidate.invalid;
  }

  private clearTouchHistoryCandidate(): void {
    this.touchHistoryCandidate = undefined;
  }

  private finishTouchHistoryCandidate(): void {
    const candidate = this.touchHistoryCandidate;
    const distinctCount = candidate?.distinctPointerIds.size;
    if (!candidate) return;
    if (!candidate.invalid && (distinctCount !== candidate.maxPointers || (distinctCount !== 2 && distinctCount !== 3))) this.rejectTouchHistoryCandidate('distinct-contact-limit');
    const valid = !candidate.invalid && distinctCount !== undefined && (distinctCount === 2 || distinctCount === 3);
    debugTouch('history-candidate-complete', {
      distinctContacts: distinctCount ?? 0,
      maxConcurrentContacts: candidate.maxPointers,
      valid,
      rejectionReason: candidate.rejectionReason ?? null
    });
    this.touchHistoryCandidate = undefined;
    if (!valid || distinctCount === undefined) return;
    const action = distinctCount === 2 ? 'undo' : 'redo';
    debugTouch('history-dispatch', { action, distinctContacts: distinctCount });
    this.historyAction(action);
  }

  private beginPinch(): void {
    const pointers = [...this.touchPointers.values()];
    if (pointers.length < 2) return;
    const first = pointers[0];
    const second = pointers[1];
    this.gesture = {
      kind: 'pinch',
      pointerIds: [first.pointerId, second.pointerId],
      startViewport: this.uiStore.getState().viewport,
      startMidpoint: midpoint(first, second),
      startDistance: Math.max(1, distance(first, second))
    };
  }

  private rebaseTouchGesture(): void {
    const pointers = [...this.touchPointers.values()];
    if (pointers.length >= 2) {
      const first = pointers[0];
      const second = pointers[1];
      this.gesture = {
        kind: 'pinch',
        pointerIds: [first.pointerId, second.pointerId],
        startViewport: this.uiStore.getState().viewport,
        startMidpoint: midpoint(first, second),
        startDistance: Math.max(1, distance(first, second))
      };
    } else if (pointers.length === 1) {
      const remaining = pointers[0];
      this.gesture = { kind: 'pan', pointerId: remaining.pointerId, lastX: remaining.screenX, lastY: remaining.screenY };
    } else {
      this.gesture = undefined;
    }
  }

  private updatePinch(): void {
    if (this.gesture?.kind !== 'pinch') return;
    const first = this.touchPointers.get(this.gesture.pointerIds[0]);
    const second = this.touchPointers.get(this.gesture.pointerIds[1]);
    if (!first || !second) return;
    const currentMidpoint = midpoint(first, second);
    const currentDistance = Math.max(1, distance(first, second));
    const zoomed = zoomAt(this.gesture.startViewport, this.gesture.startMidpoint, this.gesture.startViewport.zoom * currentDistance / this.gesture.startDistance, this.viewportOptions);
    this.projectViewport({
      x: zoomed.x - (currentMidpoint.x - this.gesture.startMidpoint.x) / zoomed.zoom,
      y: zoomed.y - (currentMidpoint.y - this.gesture.startMidpoint.y) / zoomed.zoom,
      zoom: zoomed.zoom
    });
  }

  private updatePan(sample: PointerSample): void {
    if (this.gesture?.kind !== 'pan') return;
    const delta = { x: sample.screenX - this.gesture.lastX, y: sample.screenY - this.gesture.lastY };
    this.gesture.lastX = sample.screenX;
    this.gesture.lastY = sample.screenY;
    this.projectViewport({
      x: this.uiStore.getState().viewport.x - delta.x / this.uiStore.getState().viewport.zoom,
      y: this.uiStore.getState().viewport.y - delta.y / this.uiStore.getState().viewport.zoom,
      zoom: this.uiStore.getState().viewport.zoom
    });
  }

  /** Run a touch-only one-shot action after the contact sequence is known to be single-finger. */
  private finishTouchAction(gesture: TouchActionGesture, sample: PointerSample): void {
    const snapshot = this.gateway.getSnapshot();
    if (!this.isCurrentTransaction(gesture.token, snapshot) || !snapshot.document) {
      this.setStatus('Action cancelled: project changed');
      return;
    }
    if (gesture.tool === 'eyedropper') {
      this.eyedropperAt(sample, snapshot.document);
      return;
    }
    const cell = this.paintHitCell(sample, snapshot.document);
    const local = normalizedPointerPosition(sample, this.uiStore.getState().viewport);
    const mask = cell && local ? completionTargetForCell(snapshot.document, cell, local) : 0;
    const isEmpty = cell !== undefined
      && snapshot.document.kind[cell.y * snapshot.document.width + cell.x] === CellKind.Empty;
    if (cell && (mask !== 0 || isEmpty)) this.startFillAt(cell, mask || undefined);
  }

  private paintHitCell(sample: PointerSample, document: PatternDocument): ModelPoint | undefined {
    if (!validScreenSample(sample) || !isFiniteViewport(this.uiStore.getState().viewport)) return undefined;
    const cell = hitTestCell({ x: sample.screenX, y: sample.screenY }, this.uiStore.getState().viewport);
    return cell.x < 0 || cell.y < 0 || cell.x >= document.width || cell.y >= document.height ? undefined : cloneCell(cell);
  }

  private lassoModelPoint(sample: PointerSample): ModelPoint | undefined {
    if (!validScreenSample(sample) || !isFiniteViewport(this.uiStore.getState().viewport)) return undefined;
    const point = screenToModel({ x: sample.screenX, y: sample.screenY }, this.uiStore.getState().viewport);
    return isFiniteModelPoint(point) ? point : undefined;
  }

  private finishLasso(gesture: LassoGesture): void {
    this.gesture = undefined;
    const snapshot = this.gateway.getSnapshot();
    const document = snapshot.document;
    this.clearLassoPath();
    if (!document) return;
    const captured = finishLassoRaster(gesture.raster);
    const current = finalizedSelectionIndices(this.selection, document) ?? new Uint32Array();
    let next: Uint32Array;
    if (gesture.operation === 'replace') {
      next = captured;
    } else if (gesture.operation === 'union') {
      next = new Uint32Array([...current, ...captured].sort((left, right) => left - right).filter((index, position, values) => position === 0 || index !== values[position - 1]));
    } else {
      const subtract = new Set(captured);
      next = new Uint32Array(Array.from(current).filter((index) => !subtract.has(index)));
    }
    const sparse = sparseSelectionGeometry(next, document.width, document.height);
    this.selection = sparse
      ? {
          kind: 'sparse',
          indices: sparse.indices,
          bounds: sparse.bounds,
          boundaries: sparse.boundaries,
          documentWidth: document.width,
          documentHeight: document.height
        }
      : undefined;
    this.selectionAnchor = undefined;
    this.publishSelectionOverlay();
  }

  private paintCorner(sample: PointerSample): QuarterCorner | undefined {
    if (!validScreenSample(sample) || !isFiniteViewport(this.uiStore.getState().viewport)) return undefined;
    return quarterCornerAt(screenToModel({ x: sample.screenX, y: sample.screenY }, this.uiStore.getState().viewport));
  }

  private appendPaintSample(gesture: PaintGesture, sample: PointerSample, document: PatternDocument): void {
    const nextCell = this.paintHitCell(sample, document);
    if (!nextCell) {
      // Off-chart travel is a discontinuity. Re-entry is a new stroke origin,
      // not a line segment from the last in-chart sample.
      gesture.lastCell = undefined;
      return;
    }
    if (gesture.lastCell && gesture.brush.kind === 'full' && !reachedPaintEntryDepth(gesture.lastCell, nextCell, normalizedPointerPosition(sample, this.uiStore.getState().viewport))) {
      // The pointer only grazed the new cell; wait for a deeper sample so the
      // stroke does not spill into neighbours along its edges.
      return;
    }
    if (gesture.lastCell) {
      // Full stitches follow an 8-connected line: a supercover walk would claim
      // both side cells whenever the stroke steps diagonally through a corner.
      const segment = gesture.brush.kind === 'full' ? bresenhamLine(gesture.lastCell, nextCell) : supercoverLine(gesture.lastCell, nextCell);
      for (const cell of segment) stampBrush(gesture.cells, cell, gesture.brushSize, document);
    } else {
      stampBrush(gesture.cells, nextCell, gesture.brushSize, document);
    }
    gesture.lastCell = nextCell;
  }

  private shapeEndpoint(sample: PointerSample, document: PatternDocument): ModelPoint | undefined {
    if (!validScreenSample(sample) || !isFiniteViewport(this.uiStore.getState().viewport)) return undefined;
    return screenToCell(
      { x: sample.screenX, y: sample.screenY },
      this.uiStore.getState().viewport,
      document
    );
  }

  private updateShapeCells(gesture: ShapeGesture, endpoint: ModelPoint, document: PatternDocument): void {
    let shapeStart = gesture.anchor;
    let shapeEnd = endpoint;
    if (gesture.shape === 'square' || gesture.shape === 'circle') {
      const constrainedEndpoint = constrainShapeEndpoint(gesture.anchor, endpoint);
      const side = Math.min(
        Math.max(Math.abs(constrainedEndpoint.x - gesture.anchor.x), Math.abs(constrainedEndpoint.y - gesture.anchor.y)) + 1,
        document.width,
        document.height
      );
      const left = boundedSquareOrigin(
        Math.min(gesture.anchor.x, constrainedEndpoint.x),
        gesture.anchor.x,
        side,
        document.width
      );
      const top = boundedSquareOrigin(
        Math.min(gesture.anchor.y, constrainedEndpoint.y),
        gesture.anchor.y,
        side,
        document.height
      );
      shapeStart = { x: left, y: top };
      shapeEnd = { x: left + side - 1, y: top + side - 1 };
    }
    gesture.cells.clear();
    for (const outlineCell of rasterizeShapeOutline(gesture.shape, shapeStart, shapeEnd)) {
      stampBrush(gesture.cells, outlineCell, gesture.brushSize, document);
    }
  }

  private appendShapeSample(gesture: ShapeGesture, sample: PointerSample, document: PatternDocument): void {
    const endpoint = this.shapeEndpoint(sample, document);
    if (endpoint) this.updateShapeCells(gesture, endpoint, document);
  }

  private appendCompletionSample(gesture: CompletionGesture, sample: PointerSample, document: PatternDocument): void {
    const nextCell = this.paintHitCell(sample, document);
    const local = normalizedPointerPosition(sample, this.uiStore.getState().viewport);
    if (!nextCell || !local) {
      gesture.lastCell = undefined;
      return;
    }
    if (gesture.lastCell) {
      for (const cell of supercoverLine(gesture.lastCell, nextCell)) stampCompletionTargets(gesture.targets, cell, document, local);
    } else {
      stampCompletionTargets(gesture.targets, nextCell, document, local);
    }
    gesture.lastCell = nextCell;
  }

  private addEraserSample(
    cells: Map<string, ModelPoint>,
    components: Map<string, { readonly cell: ModelPoint; readonly corner: number }>,
    cell: ModelPoint,
    mode: EraserMode,
    sample: PointerSample,
    document: PatternDocument,
    size: number
  ): void {
    if (!isFiniteViewport(this.uiStore.getState().viewport)) return;
    const stamped = brushCells(cell, size, document);
    const corner = mode === 'component'
      ? quarterCornerAt(screenToModel({ x: sample.screenX, y: sample.screenY }, this.uiStore.getState().viewport))
      : undefined;
    for (const stampedCell of stamped) {
      const key = cellKey(stampedCell);
      cells.set(key, stampedCell);
      const index = stampedCell.y * document.width + stampedCell.x;
      const componentCorner = corner === undefined ? undefined : componentCornerForHit(document, index, corner);
      if (componentCorner !== undefined) components.set(`${key}:${String(componentCorner)}`, { cell: stampedCell, corner: componentCorner });
    }
  }

  private appendEraserSample(gesture: EraserGesture, sample: PointerSample, document: PatternDocument): void {
    const nextCell = this.paintHitCell(sample, document);
    if (!nextCell) {
      gesture.lastCell = undefined;
      return;
    }
    const cells = gesture.lastCell ? supercoverLine(gesture.lastCell, nextCell) : [nextCell];
    const firstCell = gesture.lastCell && cellKey(gesture.lastCell) !== cellKey(nextCell) ? 1 : 0;
    for (let position = firstCell; position < cells.length; position += 1) {
      this.addEraserSample(gesture.cells, gesture.components, cells[position], gesture.mode, sample, document, gesture.brushSize);
    }
    gesture.lastCell = nextCell;
  }

  private finishPaint(commit: boolean): void {
    const gesture = this.gesture;
    if (!gesture || gesture.kind !== 'paint') return;
    this.finishBulkCellGesture(gesture, commit);
  }

  private finishShape(commit: boolean): void {
    const gesture = this.gesture;
    if (!gesture || gesture.kind !== 'shape') return;
    this.finishBulkCellGesture(gesture, commit);
  }

  private finishBulkCellGesture(gesture: PaintGesture | ShapeGesture, commit: boolean): void {
    this.gesture = undefined;
    this.clearPendingCells();
    if (!commit || gesture.cells.size === 0) return;
    const snapshot = this.gateway.getSnapshot();
    if (!snapshot.document) return;
    const indices = indicesForCells([...gesture.cells.values()], snapshot.document.width);
    const command: DomainCommand = {
      type: 'bulk-cell',
      indices,
      edit: gesture.edit,
      expectedRevision: gesture.transaction.token.revision
    };
    try {
      if (!this.isCurrentTransaction(gesture.transaction.token, snapshot)) {
        this.setStatus('Stroke cancelled: project changed');
        return;
      }
      const preflight = preflightBulkCellCommand(snapshot.document, command);
      const changedIndices = gesture.kind === 'paint' && gesture.edit.kind === 'three-quarter'
        ? new Uint32Array(
            Array.from(preflight.changedIndices)
              .map((index) => cellState(snapshot.document!, index, preflight.edit))
              .filter((state) => cellStateChanged(snapshot.document!, state))
              .map((state) => state.index)
          )
        : gesture.kind === 'shape'
          ? preflight.changedIndices
          : indices;
      if (preflight.changedIndices.length === 0 || changedIndices.length === 0) {
        this.setStatus('No change');
        return;
      }
      const effectiveCommand: DomainCommand = { ...command, indices: changedIndices };
      this.commandInFlight = true;
      const result = gesture.transaction.commit(effectiveCommand);
      this.commandInFlight = false;
      this.projectCommandResult(result, changedIndices, `Stitched ${String(changedIndices.length)} cell${changedIndices.length === 1 ? '' : 's'}`);
    } catch (error) {
      this.commandInFlight = false;
      if (error instanceof StaleEditorTransactionError) this.setStatus('Stroke cancelled: project changed');
      else throw error;
    }
  }

  private finishCompletion(commit: boolean): void {
    const gesture = this.gesture;
    if (!gesture || gesture.kind !== 'completion') return;
    this.gesture = undefined;
    this.clearPendingCells();
    if (!commit || gesture.targets.size === 0) return;
    const snapshot = this.gateway.getSnapshot();
    if (!snapshot.document || !snapshot.projectId || snapshot.revision === null) return;
    const orderedTargets = [...gesture.targets.entries()].sort(([left], [right]) => left - right);
    const indices = new Uint32Array(orderedTargets.map(([index]) => index));
    const masks = new Uint8Array(orderedTargets.map(([, target]) => target.mask));
    const command = completionCommand(indices, masks, gesture.operation, gesture.transaction.token.revision);
    try {
      if (!this.isCurrentTransaction(gesture.transaction.token, snapshot)) {
        this.setStatus('Completion cancelled: project changed');
        return;
      }
      const preflight = preflightBulkCompletionCommand(snapshot.document, command);
      if (preflight.changedIndices.length === 0) {
        this.setStatus('No change');
        return;
      }
      this.commandInFlight = true;
      const result = gesture.transaction.commit(command);
      this.commandInFlight = false;
      const changedIndices = preflight.changedIndices.length > 0 ? preflight.changedIndices : indices;
      const verb = gesture.operation === 'set' ? 'Completed' : 'Uncompleted';
      this.projectCommandResult(result, changedIndices, `${verb} ${String(changedIndices.length)} cell${changedIndices.length === 1 ? '' : 's'}`);
    } catch (error) {
      this.commandInFlight = false;
      if (error instanceof StaleEditorTransactionError) this.setStatus('Completion cancelled: project changed');
      else throw error;
    }
  }

  private finishEraser(commit: boolean): void {
    const gesture = this.gesture;
    if (!gesture || gesture.kind !== 'eraser') return;
    this.gesture = undefined;
    this.clearPendingCells();
    if (!commit || gesture.cells.size === 0) return;
    const snapshot = this.gateway.getSnapshot();
    if (!snapshot.document) return;
    const wholeIndices: number[] = [];
    const componentTargets: Array<{ index: number; corner: number }> = [];
    for (const { cell, corner } of gesture.components.values()) {
      componentTargets.push({ index: cell.y * snapshot.document.width + cell.x, corner });
    }
    const targetedIndexes = new Set(componentTargets.map((target) => target.index));
    for (const cell of gesture.cells.values()) {
      const index = cell.y * snapshot.document.width + cell.x;
      const kind = snapshot.document.kind[index];
      const componentGeometry = isLegacyQuarterKind(kind) || isThreeQuarterKind(kind) || isThreeQuarterPairKind(kind);
      if (gesture.mode !== 'component' || !componentGeometry) {
        wholeIndices.push(index);
      } else if (!targetedIndexes.has(index)) {
        // A component gesture that misses the persisted 3/4 component is an
        // intentional no-op, rather than a whole-cell erase.
        continue;
      }
    }
    wholeIndices.sort((left, right) => left - right);
    componentTargets.sort((left, right) => left.index - right.index || left.corner - right.corner);
    const componentIndices = new Uint32Array(componentTargets.length);
    const componentCorners = new Uint8Array(componentTargets.length);
    componentTargets.forEach((target, position) => {
      componentIndices[position] = target.index;
      componentCorners[position] = target.corner;
    });
    const command = mixedEraseCommand(
      new Uint32Array(wholeIndices),
      componentIndices,
      componentCorners,
      gesture.transaction.token.revision
    );
    try {
      if (!this.isCurrentTransaction(gesture.transaction.token, snapshot)) {
        this.setStatus('Erase cancelled: project changed');
        return;
      }
      const preflight = preflightMixedEraseCommand(snapshot.document, command);
      if (preflight.changedCellCount === 0) {
        this.setStatus('No change');
        return;
      }
      this.commandInFlight = true;
      const result = gesture.transaction.commit(command);
      this.commandInFlight = false;
      this.projectCommandResult(result, indicesForCells([...gesture.cells.values()], snapshot.document.width), `Erased ${String(gesture.cells.size)} cell${gesture.cells.size === 1 ? '' : 's'}`);
    } catch (error) {
      this.commandInFlight = false;
      if (error instanceof StaleEditorTransactionError) this.setStatus('Erase cancelled: project changed');
      else throw error;
    }
  }

  private publishSelectionOverlay(): void {
    const state = this.uiStore.getState();
    const selection = this.selection?.kind === 'rect'
      ? this.selection.rect
      : this.selection
        ? {
            rect: this.selection.bounds,
            kind: 'sparse' as const,
            indices: Array.from(this.selection.indices),
            cellIndices: Array.from(this.selection.indices),
            boundaries: this.selection.boundaries,
            boundarySegments: this.selection.boundaries,
            boundary: this.selection.boundaries,
            exteriorBoundary: this.selection.boundaries.filter((segment) => segment.kind === 'exterior'),
            interiorBoundary: this.selection.boundaries.filter((segment) => segment.kind === 'interior')
          }
        : undefined;
    this.uiStore.setOverlay({ ...state.overlay, selection });
  }

  private publishFloatingPasteOverlay(): void {
    const state = this.uiStore.getState();
    this.uiStore.setOverlay({
      ...state.overlay,
      floatingPaste: this.floatingPaste
        ? {
            mode: this.floatingPaste.mode,
            fragment: this.floatingPaste.fragment,
            destination: { ...this.floatingPaste.destination },
            copySelection: this.floatingPaste.copySelection,
            sourceSelection: this.floatingPaste.sourceSelection,
            completion: this.floatingPaste.completion,
            backstitches: this.floatingPaste.backstitches,
            color: this.activePaletteColor()
          }
        : undefined
    });
  }

  private clearTouchCopyRequest(): void {
    const state = this.uiStore.getState();
    if (state.overlay.touchCopyRequest === undefined) return;
    this.uiStore.setOverlay({ ...state.overlay, touchCopyRequest: undefined });
  }

  private discardFloatingPaste(): void {
    const floating = this.floatingPaste;
    this.floatingPaste = undefined;
    this.floatingPasteMoveGesture = undefined;
    this.floatingPasteTouchCandidate = undefined;
    if (floating) {
      this.selection = floating.previousSelection;
      this.selectionAnchor = floating.previousSelectionAnchor;
    }
    this.publishFloatingPasteOverlay();
    if (floating) this.publishSelectionOverlay();
  }

  private publishLassoPath(points: readonly ModelPoint[]): void {
    const state = this.uiStore.getState();
    this.uiStore.setOverlay({ ...state.overlay, lassoPath: { points: points.map((point) => ({ ...point })) } });
  }

  private clearLassoPath(): void {
    const state = this.uiStore.getState();
    if (!state.overlay.lassoPath) return;
    this.uiStore.setOverlay({ ...state.overlay, lassoPath: undefined });
  }

  private publishBackstitchPreview(start: FixedPoint, end: FixedPoint): void {
    const state = this.uiStore.getState();
    this.uiStore.setOverlay({
      ...state.overlay,
      backstitchPreview: {
        start,
        end,
        color: this.activePaletteColor()
      }
    });
  }

  private clearBackstitchPreview(): void {
    const state = this.uiStore.getState();
    if (!state.overlay.backstitchPreview) return;
    this.uiStore.setOverlay({ ...state.overlay, backstitchPreview: undefined });
  }

  private setFillPending(pending: boolean): void {
    const state = this.uiStore.getState();
    this.uiStore.setOverlay({ ...state.overlay, fillPending: pending ? true : undefined });
  }

  private activePaletteColor(): string | undefined {
    const snapshot = this.gateway.getSnapshot();
    const paletteId = this.uiStore.getState().paletteId;
    return snapshot.document?.palette.find((entry) => entry.id === paletteId)?.color;
  }

  private addBackstitchHit(document: PatternDocument, point: ModelPoint): { id: number; start: FixedPoint; end: FixedPoint } | undefined {
    const tolerance = Math.max(0.25, 8 / Math.max(0.01, this.uiStore.getState().viewport.zoom));
    let best: { id: number; distance: number; start: FixedPoint; end: FixedPoint } | undefined;
    const store = document.backstitches;
    for (let index = 0; index < store.ids.length; index += 1) {
      const start = { x: store.x1[index], y: store.y1[index] };
      const end = { x: store.x2[index], y: store.y2[index] };
      const distance = distanceToSegment(point, fixedPointToModel(start), fixedPointToModel(end));
      if (distance <= tolerance && (!best || distance < best.distance)) best = { id: store.ids[index], distance, start, end };
    }
    return best;
  }

  private backstitchModelPoint(sample: PointerSample): ModelPoint {
    if (!validScreenSample(sample) || !isFiniteViewport(this.uiStore.getState().viewport)) throw new DomainError('invalid-coordinate', 'Backstitch screen coordinates must be finite.');
    return screenToModel({ x: sample.screenX, y: sample.screenY }, this.uiStore.getState().viewport);
  }

  private beginBackstitch(sample: PointerSample, snapshot: WorkspaceEditorSnapshot): boolean {
    if (!validScreenSample(sample) || !isFiniteViewport(this.uiStore.getState().viewport) || !snapshot.document || !snapshot.projectId || snapshot.revision === null) return false;
    this.keyboardBackstitchAnchor = undefined;
    this.keyboardBackstitchToken = undefined;
    const point = this.backstitchModelPoint(sample);
    if (point.x < 0 || point.y < 0 || point.x > snapshot.document.width || point.y > snapshot.document.height) return false;
    const hit = this.addBackstitchHit(snapshot.document, point);
    if (hit) {
      this.selectedBackstitchId = hit.id;
      const startDistance = Math.hypot(point.x - fixedPointToModel(hit.start).x, point.y - fixedPointToModel(hit.start).y);
      const endDistance = Math.hypot(point.x - fixedPointToModel(hit.end).x, point.y - fixedPointToModel(hit.end).y);
      this.gesture = {
        kind: 'backstitch',
        pointerId: sample.pointerId,
        mode: 'move',
        token: { projectId: snapshot.projectId, revision: snapshot.revision },
        selectedId: hit.id,
        movingEndpoint: startDistance <= endDistance ? 'start' : 'end',
        start: hit.start,
        end: hit.end
      };
      this.publishBackstitchPreview(hit.start, hit.end);
      this.setStatus(`Selected backstitch ${String(hit.id)}`);
      return true;
    }
    this.selectedBackstitchId = undefined;
    const snapped = fixedPointAt(point, snapshot.document);
    this.gesture = {
      kind: 'backstitch',
      pointerId: sample.pointerId,
      mode: 'create',
      token: { projectId: snapshot.projectId, revision: snapshot.revision },
      start: snapped,
      end: snapped
    };
    this.publishBackstitchPreview(snapped, snapped);
    return true;
  }

  private finishBackstitch(gesture: BackstitchGesture): void {
    this.gesture = undefined;
    this.clearBackstitchPreview();
    const snapshot = this.gateway.getSnapshot();
    if (!snapshot.document || !snapshot.projectId || snapshot.revision === null) {
      this.resetBackstitchState();
      return;
    }
    if (gesture.mode === 'create') {
      if (gesture.start.x === gesture.end.x && gesture.start.y === gesture.end.y) {
        this.resetBackstitchState();
        return;
      }
      const created = this.executeCommandWithToken({
        type: 'add-backstitch',
        start: gesture.start,
        end: gesture.end,
        color: this.uiStore.getState().paletteId ?? 1
      }, 'Created backstitch');
      if (created) {
        const after = this.gateway.getSnapshot().document;
        this.selectedBackstitchId = after && after.backstitches.ids.length > 0
          ? after.backstitches.ids[after.backstitches.ids.length - 1]
          : undefined;
      }
      return;
    }
    if (gesture.selectedId === undefined) return;
    const changed = this.executeCommandWithToken({
      type: 'move-backstitch',
      id: gesture.selectedId,
      start: gesture.start,
      end: gesture.end
    }, 'Moved backstitch');
    if (!changed) this.selectedBackstitchId = gesture.selectedId;
  }

  private activateKeyboardBackstitch(): void {
    const snapshot = this.gateway.getSnapshot();
    if (!snapshot.document || !snapshot.projectId || snapshot.revision === null) return;
    const cursor = this.uiStore.getState().keyboardCursor ?? { x: 0, y: 0 };
    if (!isFiniteModelPoint(cursor)) return;
    if (!this.uiStore.getState().keyboardCursor) this.setKeyboardCursor(cursor);
    const point = fixedPointAt(cursor, snapshot.document);
    if (!this.keyboardBackstitchAnchor) {
      this.keyboardBackstitchAnchor = point;
      this.keyboardBackstitchToken = { projectId: snapshot.projectId, revision: snapshot.revision };
      this.publishBackstitchPreview(point, point);
      this.setStatus(`Backstitch start anchored at (${String(point.x)}, ${String(point.y)}); move cursor and press Enter`);
      return;
    }
    const anchor = this.keyboardBackstitchAnchor;
    const token = this.keyboardBackstitchToken;
    if (!token || token.projectId !== snapshot.projectId || token.revision !== snapshot.revision) {
      this.resetBackstitchState();
      this.setStatus('Backstitch cancelled: project changed');
      return;
    }
    if (anchor.x === point.x && anchor.y === point.y) {
      this.publishBackstitchPreview(anchor, point);
      this.setStatus('Move the cursor before pressing Enter to finish the backstitch');
      return;
    }
    this.keyboardBackstitchAnchor = undefined;
    this.keyboardBackstitchToken = undefined;
    this.clearBackstitchPreview();
    const created = this.executeCommandWithToken({
      type: 'add-backstitch',
      start: anchor,
      end: point,
      color: this.uiStore.getState().paletteId ?? 1
    }, 'Created backstitch', token);
    if (created) {
      const after = this.gateway.getSnapshot().document;
      this.selectedBackstitchId = after && after.backstitches.ids.length > 0
        ? after.backstitches.ids[after.backstitches.ids.length - 1]
        : undefined;
    }
  }

  private resetBackstitchState(): void {
    if (this.gesture?.kind === 'backstitch') this.gesture = undefined;
    this.selectedBackstitchId = undefined;
    this.keyboardBackstitchAnchor = undefined;
    this.keyboardBackstitchToken = undefined;
    this.clearBackstitchPreview();
  }

  private executeCommandWithToken(command: DomainCommand, status: string, expectedToken?: EditorRevisionToken): boolean {
    const snapshot = this.gateway.getSnapshot();
    if (!snapshot.projectId || snapshot.revision === null) return false;
    const token = expectedToken ?? { projectId: snapshot.projectId, revision: snapshot.revision };
    if (token.projectId !== snapshot.projectId || token.revision !== snapshot.revision) {
      this.setStatus(`${status} cancelled: project changed`);
      return false;
    }
    try {
      this.commandInFlight = true;
      const result = this.gateway.execute(command, token);
      this.commandInFlight = false;
      this.projectCommandResult(result, undefined, status);
      return result.changed;
    } catch (error) {
      this.commandInFlight = false;
      if (error instanceof StaleEditorTransactionError) {
        this.setStatus(`${status} cancelled: project changed`);
        return false;
      }
      throw error;
    }
  }

  private startFillAt(cell: ModelPoint, startMask?: number): boolean {
    const snapshot = this.gateway.getSnapshot();
    if (!isFiniteModelPoint(cell) || !snapshot.document || !snapshot.projectId || snapshot.revision === null) return false;
    const cellX = Math.floor(cell.x);
    const cellY = Math.floor(cell.y);
    if (cellX < 0 || cellY < 0 || cellX >= snapshot.document.width || cellY >= snapshot.document.height) return false;
    this.cancelFill(false);
    const selectedPaletteId = this.uiStore.getState().paletteId;
    const startIndex = cellY * snapshot.document.width + cellX;
    const isEmptyStart = snapshot.document.kind[startIndex] === CellKind.Empty;
    const targetMask = isEmptyStart ? 1 : startMask ?? deterministicFillMask(snapshot.document, startIndex);
    if (selectedPaletteId === null || targetMask === 0) {
      this.setStatus('No change');
      return true;
    }
    const sourceSlot = Math.log2(targetMask);
    const sourceColor = snapshot.document.colors[startIndex * MAX_FILL_COLOR_SLOTS + sourceSlot];
    if (!isEmptyStart && (sourceColor === 0 || sourceColor === selectedPaletteId)) {
      this.setStatus('No change');
      return true;
    }
    const token: EditorRevisionToken = { projectId: snapshot.projectId, revision: snapshot.revision };
    let job: FillJob;
    try {
      job = this.fillClient.submit({
        projectId: token.projectId,
        baseRevision: token.revision,
        width: snapshot.document.width,
        height: snapshot.document.height,
        startIndex,
        startMask: targetMask,
        kind: snapshot.document.kind,
        colors: snapshot.document.colors
      });
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : 'Fill could not start');
      return false;
    }
    this.fillJob = job;
    this.fillToken = token;
    this.fillRecolorSnapshot = isEmptyStart
      ? { kind: 'empty-region', toColor: selectedPaletteId }
      : { kind: 'recolor', fromColor: sourceColor, toColor: selectedPaletteId };
    this.setFillPending(true);
    this.setStatus('Filling…');
    void job.promise.then((result) => this.finishFill(job, token, result)).catch((error: unknown) => {
      if (this.fillJob !== job) return;
      this.fillJob = undefined;
      this.fillToken = undefined;
      this.fillRecolorSnapshot = undefined;
      this.setFillPending(false);
      if (error instanceof FillCancelledError) this.setStatus('Fill cancelled');
      else if (error instanceof FillStaleResultError) this.setStatus('Fill discarded: project changed');
      else this.setStatus(error instanceof Error ? error.message : 'Fill failed');
    });
    return true;
  }

  private finishFill(job: FillJob, token: EditorRevisionToken, result: FillResultMessage): void {
    if (this.fillJob !== job) return;
    this.fillJob = undefined;
    this.fillToken = undefined;
    const capturedRecolor = this.fillRecolorSnapshot;
    this.fillRecolorSnapshot = undefined;
    this.setFillPending(false);
    const current = this.gateway.getSnapshot();
    if (!isFillResultCurrent(result, { projectId: token.projectId, baseRevision: token.revision, requestId: job.request.requestId })
      || current.projectId !== token.projectId
      || current.revision !== token.revision
      || !current.document
      || result.width !== current.document.width
      || result.height !== current.document.height
      || result.startIndex < 0) {
      this.setStatus('Fill discarded: project changed');
      return;
    }
    if (capturedRecolor?.kind === 'empty-region') {
      try {
        if (!isExactEmptyRegionFillResult(current.document, result.startIndex, result.indices, result.masks)) {
          this.setStatus('Fill discarded: invalid result');
          return;
        }
        const command: DomainCommand = {
          type: 'bulk-cell',
          indices: result.indices,
          edit: { kind: 'full', color: capturedRecolor.toColor },
          expectedRevision: token.revision
        };
        const preflight = preflightBulkCellCommand(current.document, command);
        if (preflight.changedIndices.length === 0) {
          this.setStatus('No change');
          return;
        }
        this.executeCommandWithToken({ ...command, indices: preflight.changedIndices }, 'Filled region', token);
      } catch (error) {
        if (error instanceof DomainError) {
          this.setStatus(error.message);
          return;
        }
        throw error;
      }
      return;
    }
    if (capturedRecolor?.kind === 'recolor') {
      try {
        const command = fillRecolorCommand(result.indices, result.masks, capturedRecolor.fromColor, capturedRecolor.toColor, token.revision);
        const preflight = preflightBulkRecolorCommand(current.document, command);
        if (preflight.changedIndices.length === 0) {
          this.setStatus('No change');
          return;
        }
        const changedMasks = masksForChangedIndices(result.indices, result.masks, preflight.changedIndices);
        this.executeCommandWithToken(
          fillRecolorCommand(preflight.changedIndices, changedMasks, capturedRecolor.fromColor, capturedRecolor.toColor, token.revision),
          'Filled region',
          token
        );
      } catch (error) {
        if (error instanceof DomainError) {
          this.setStatus(error.message);
          return;
        }
        throw error;
      }
      return;
    }
  }

  private activateKeyboardCursor(): void {
    const tool = this.uiStore.getState().tool;
    if (tool.tool === 'backstitch') {
      this.activateKeyboardBackstitch();
      return;
    }
    if (tool.tool === 'fill') {
      const cursor = this.uiStore.getState().keyboardCursor ?? { x: 0, y: 0 };
      this.startFillAt(cursor);
      return;
    }
    if (tool.tool === 'completion') {
      this.completeAtKeyboardCursor();
      return;
    }
    if (tool.tool === 'eraser') {
      this.eraseAtKeyboardCursor();
      return;
    }
    if (tool.tool === 'eyedropper') {
      this.sampleTraceAtKeyboardCursor();
      return;
    }
    if (tool.tool === 'paint') this.paintAtKeyboardCursor();
  }

  private completeAtKeyboardCursor(): void {
    const state = this.uiStore.getState();
    const snapshot = this.gateway.getSnapshot();
    const cursor = state.keyboardCursor ?? { x: 0, y: 0 };
    if (!snapshot.document || !snapshot.projectId || snapshot.revision === null || !isFiniteModelPoint(cursor)) return;
    const cells = brushCells(cloneCell(cursor), 1, snapshot.document);
    this.executeCompletion(cells, `Completed cell (${String(Math.floor(cursor.x))}, ${String(Math.floor(cursor.y))})`);
  }

  private sampleTraceAtKeyboardCursor(): void {
    const state = this.uiStore.getState();
    const cursor = state.keyboardCursor ?? { x: 0, y: 0 };
    if (!isFiniteModelPoint(cursor) || !isFiniteViewport(state.viewport)) return;
    const rgb = this.sampleTraceAt({
      x: (cursor.x + 0.5 - state.viewport.x) * state.viewport.zoom,
      y: (cursor.y + 0.5 - state.viewport.y) * state.viewport.zoom
    });
    if (rgb) this.activateSampledColor(rgb);
  }

  private paintAtKeyboardCursor(): void {
    const state = this.uiStore.getState();
    if (state.tool.tool !== 'paint') return;
    const snapshot = this.gateway.getSnapshot();
    const cursor = state.keyboardCursor ?? { x: 0, y: 0 };
    if (!snapshot.document || !snapshot.projectId || snapshot.revision === null || !isFiniteModelPoint(cursor) || !isFiniteViewport(state.viewport)) return;
    const cell = cloneCell(cursor);
    if (cell.x < 0 || cell.y < 0 || cell.x >= snapshot.document.width || cell.y >= snapshot.document.height) return;
    this.executeCellEdit(brushCells(cell, this.getBrushSize(), snapshot.document), editForBrush(state.tool.brush), `Stitched cell (${String(cell.x)}, ${String(cell.y)})`);
  }

  private eraseAtKeyboardCursor(): void {
    const state = this.uiStore.getState();
    const snapshot = this.gateway.getSnapshot();
    const cursor = state.keyboardCursor ?? { x: 0, y: 0 };
    if (!snapshot.document || !snapshot.projectId || snapshot.revision === null || !isFiniteModelPoint(cursor) || !isFiniteViewport(state.viewport)) return;
    const cell = cloneCell(cursor);
    if (cell.x < 0 || cell.y < 0 || cell.x >= snapshot.document.width || cell.y >= snapshot.document.height) return;
    const eraser = state.tool.tool === 'eraser' ? state.tool : undefined;
    const index = cell.y * snapshot.document.width + cell.x;
    const corner = eraser?.corner ?? this.eraserCorner;
    const componentKind = snapshot.document.kind[index];
    const edit: BulkCellEdit = eraser?.mode === 'component'
      && (isLegacyQuarterKind(componentKind) || isThreeQuarterKind(componentKind) || isThreeQuarterPairKind(componentKind))
      ? { kind: 'erase-quarter', corner }
      : { kind: 'erase-cell' };
    const status = edit.kind === 'erase-quarter'
      ? `Erased quarter ${String(edit.corner)} at (${String(cell.x)}, ${String(cell.y)})`
      : `Erased cell (${String(cell.x)}, ${String(cell.y)})`;
    this.executeCellEdit(brushCells(cell, this.getBrushSize(), snapshot.document), edit, status);
  }

  private executeCellEdit(cells: readonly ModelPoint[], edit: BulkCellEdit, status: string): void {
    const snapshot = this.gateway.getSnapshot();
    if (!snapshot.document || !snapshot.projectId || snapshot.revision === null) return;
    const indices = indicesForCells(cells, snapshot.document.width);
    const command: DomainCommand = { type: 'bulk-cell', indices, edit, expectedRevision: snapshot.revision };
    try {
      const preflight = preflightBulkCellCommand(snapshot.document, command);
      const changedIndices = edit.kind === 'three-quarter'
        ? new Uint32Array(
            Array.from(preflight.changedIndices)
              .map((index) => cellState(snapshot.document!, index, preflight.edit))
              .filter((state) => cellStateChanged(snapshot.document!, state))
              .map((state) => state.index)
          )
        : indices;
      if (preflight.changedIndices.length === 0 || changedIndices.length === 0) {
        this.setStatus('No change');
        return;
      }
      const effectiveCommand: DomainCommand = { ...command, indices: changedIndices };
      this.commandInFlight = true;
      const result = this.gateway.execute(effectiveCommand, { projectId: snapshot.projectId, revision: snapshot.revision });
      this.commandInFlight = false;
      this.projectCommandResult(result, changedIndices, status);
    } catch (error) {
      this.commandInFlight = false;
      if (error instanceof StaleEditorTransactionError) this.setStatus('Action cancelled: project changed');
      else throw error;
    }
  }

  private executeCompletion(cells: readonly ModelPoint[], status: string): void {
    const snapshot = this.gateway.getSnapshot();
    if (!snapshot.document || !snapshot.projectId || snapshot.revision === null) return;
    const targets = completionTargetsForCells(cells, snapshot.document);
    const orderedTargets = [...targets.entries()].sort(([left], [right]) => left - right);
    const indices = new Uint32Array(orderedTargets.map(([index]) => index));
    if (indices.length === 0) {
      this.setStatus('No change');
      return;
    }
    const masks = new Uint8Array(orderedTargets.map(([, target]) => target.mask));
    const command = completionCommand(indices, masks, 'set', snapshot.revision);
    try {
      const preflight = preflightBulkCompletionCommand(snapshot.document, command);
      if (preflight.changedIndices.length === 0) {
        this.setStatus('No change');
        return;
      }
      this.commandInFlight = true;
      const result = this.gateway.execute(command, { projectId: snapshot.projectId, revision: snapshot.revision });
      this.commandInFlight = false;
      this.projectCommandResult(result, preflight.changedIndices.length > 0 ? preflight.changedIndices : indices, status);
    } catch (error) {
      this.commandInFlight = false;
      if (error instanceof StaleEditorTransactionError) this.setStatus('Completion cancelled: project changed');
      else throw error;
    }
  }

  private historyAction(action: 'undo' | 'redo'): void {
    if (this.floatingPaste) this.discardFloatingPaste();
    const snapshot = this.gateway.getSnapshot();
    if (!snapshot.projectId || snapshot.revision === null) return;
    const token: EditorRevisionToken = { projectId: snapshot.projectId, revision: snapshot.revision };
    try {
      this.commandInFlight = true;
      const result = action === 'undo' ? this.gateway.undo(token) : this.gateway.redo(token);
      this.commandInFlight = false;
      this.projectCommandResult(result, undefined, action === 'undo' ? 'Undid action' : 'Redid action');
    } catch (error) {
      this.commandInFlight = false;
      if (error instanceof StaleEditorTransactionError) this.setStatus('Action cancelled: project changed');
      else throw error;
    }
  }

  private projectCommandResult(result: CommandResult, requestedIndices: Uint32Array | undefined, status: string): void {
    const previous = this.lastGatewaySnapshot;
    this.lastGatewaySnapshot = {
      projectId: previous.projectId,
      revision: result.revision,
      document: result.document
    };
    if (!result.changed) {
      this.setStatus('No change');
      return;
    }
    const changed = result.changedIndices && result.changedIndices.length > 0 ? result.changedIndices : requestedIndices;
    const cellRect = changed ? cellRectForIndices(changed, result.document.width, result.document.height) : undefined;
    const backstitchesChanged = (result.changedBackstitchIds !== undefined && result.changedBackstitchIds.length > 0)
      || (result.movedBackstitchIds !== undefined && result.movedBackstitchIds.length > 0);
    const invalidation: Invalidation = result.requiresFullRedraw === true || backstitchesChanged
      ? { layer: 'base', full: true, reason: 'editor-command' }
      : cellRect
      ? { layer: 'base', cellRect, reason: 'editor-command' }
      : { layer: 'base', full: true, reason: 'editor-command' };
    this.reconcileSelectionDimensions(result.document);
    this.renderer.setDocument(result.document, invalidation);
    this.publishSelectedCell(false);
    this.setStatus(status);
  }

  private onGatewaySnapshot(snapshot: WorkspaceEditorSnapshot, force = false): void {
    if (!this.started || this.commandInFlight) return;
    const previous = this.lastGatewaySnapshot;
    const projectChanged = previous.projectId !== snapshot.projectId;
    const documentChanged = previous.document !== snapshot.document || previous.revision !== snapshot.revision;
    let staleGestureStatus: string | undefined;
    this.lastGatewaySnapshot = snapshot;
    if (!force && !projectChanged && !documentChanged) return;
    if (projectChanged || documentChanged) this.discardFloatingPaste();
    if (documentChanged && this.touchHistoryCandidate) {
      this.rejectTouchHistoryCandidate('project/document reset');
      this.clearTouchHistoryCandidate();
    }
    if (projectChanged || documentChanged) {
      this.touchCopyCandidate = undefined;
      this.clearTouchCopyRequest();
    }
    if (projectChanged) this.resetForProjectSwitch(snapshot);
    else if (this.gesture && ((this.gesture.kind === 'paint' || this.gesture.kind === 'shape' || this.gesture.kind === 'eraser' || this.gesture.kind === 'completion')
      ? (this.gesture.transaction.token.revision !== snapshot.revision || this.gesture.transaction.token.projectId !== snapshot.projectId)
      : (this.gesture.kind === 'backstitch' || this.gesture.kind === 'lasso' || this.gesture.kind === 'touch-action')
        ? (this.gesture.token.revision !== snapshot.revision || this.gesture.token.projectId !== snapshot.projectId)
        : false)) {
      const staleStatus = this.gesture.kind === 'completion'
        ? 'Completion cancelled: project changed'
        : this.gesture.kind === 'lasso' ? 'Lasso cancelled: project changed'
          : this.gesture.kind === 'touch-action' ? 'Action cancelled: project changed' : 'Stroke cancelled: project changed';
      this.cancelGesture();
      staleGestureStatus = staleStatus;
    }
    if (!projectChanged && this.fillJob && this.fillToken
      && (this.fillToken.projectId !== snapshot.projectId || this.fillToken.revision !== snapshot.revision)) this.cancelFill(false);
    if (snapshot.document) {
      if (this.metrics) this.projectViewport(normalizeViewport(this.uiStore.getState().viewport, snapshot.document, this.metrics, this.viewportOptions));
      this.setDocument(snapshot.document, { layer: 'all', full: true, reason: projectChanged ? 'project-switch' : 'external-document' });
    } else {
      this.renderer.setOverlay({});
      this.uiStore.setSelectedCell(null);
    }
    if (staleGestureStatus) this.setStatus(staleGestureStatus);
  }

  private resetForProjectSwitch(snapshot: WorkspaceEditorSnapshot): void {
    this.discardFloatingPaste();
    this.cancelGesture();
    this.cancelFill(false);
    this.resetBackstitchState();
    this.selection = undefined;
    this.selectionAnchor = undefined;
    this.clipboard = undefined;
    this.clipboardSelection = undefined;
    this.uiStore.setCanPaste(false);
    this.touchPointers.clear();
    this.floatingPasteTouchCandidate = undefined;
    this.touchCopyCandidate = undefined;
    this.uiStore.setState({ overlay: {}, keyboardCursor: null, status: null });
    if (snapshot.document && this.metrics) this.projectViewport(fitViewport(snapshot.document, this.metrics, 0, this.viewportOptions));
  }

  private onUiState(state: ReturnType<EditorUiStore['getState']>, previous: ReturnType<EditorUiStore['getState']>): void {
    if (!this.started || this.disposed) return;
    if (state.tool.tool === 'eraser' && state.tool.corner !== undefined) this.eraserCorner = state.tool.corner;
    if (state.tool.tool !== previous.tool.tool) {
      if (this.floatingPaste) this.discardFloatingPaste();
      this.resetToolTransient();
    }
    if (state.viewport !== previous.viewport) this.renderer.setViewport(state.viewport);
    if (state.mode !== previous.mode) this.renderer.setStyle({ mode: state.mode });
    if (state.gridVisible !== previous.gridVisible) this.renderer.setStyle({ showGrid: state.gridVisible });
    if (state.overlay !== previous.overlay) this.renderer.setOverlay(state.overlay);
    if ((state.tool !== previous.tool || state.brushSize !== previous.brushSize || state.viewport !== previous.viewport) && this.lastHoverSample && !this.gesture) this.updateBrushPreview(this.lastHoverSample);
  }

  private projectUiState(state: ReturnType<EditorUiStore['getState']>): void {
    this.renderer.setViewport(state.viewport);
    this.renderer.setStyle({ mode: state.mode, showGrid: state.gridVisible });
    this.renderer.setOverlay(state.overlay);
  }

  private isCurrentTransaction(token: EditorRevisionToken, snapshot: WorkspaceEditorSnapshot): boolean {
    return token.projectId === snapshot.projectId && token.revision === snapshot.revision && snapshot.document !== null;
  }

  private pendingPaintStates(cells: Map<string, ModelPoint>, edit: BulkCellEdit, revision: number, document: PatternDocument): PendingCellState[] {
    const indices = indicesForCells([...cells.values()], document.width);
    const preflight = preflightBulkCellCommand(document, {
      type: 'bulk-cell',
      indices,
      edit,
      expectedRevision: revision
    });
    return Array.from(preflight.changedIndices, (index) => cellState(document, index, preflight.edit))
      .filter((state) => cellStateChanged(document, state));
  }

  private pendingCompletionStates(targets: Map<number, CompletionTarget>, operation: CompletionOperation, document: PatternDocument): PendingCellState[] {
    return [...targets.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, target]) => completionPendingState(document, index, target.mask, operation))
      .filter((state): state is PendingCellState => state !== undefined);
  }

  private pendingEraserStates(
    cells: Map<string, ModelPoint>,
    components: Map<string, { readonly cell: ModelPoint; readonly corner: number }>,
    mode: EraserMode,
    document: PatternDocument
  ): PendingCellState[] {
    const cornersByIndex = new Map<number, number[]>();
    for (const { cell, corner } of components.values()) {
      const index = cell.y * document.width + cell.x;
      const corners = cornersByIndex.get(index) ?? [];
      corners.push(corner);
      cornersByIndex.set(index, corners);
    }
    const states: PendingCellState[] = [];
    for (const index of indicesForCells([...cells.values()], document.width)) {
      const corners = cornersByIndex.get(index) ?? [];
      let state: PendingCellState;
      const originalKind = document.kind[index];
      const componentGeometry = isLegacyQuarterKind(originalKind) || isThreeQuarterKind(originalKind) || isThreeQuarterPairKind(originalKind);
      if (mode !== 'component' || !componentGeometry) {
        state = cellState(document, index, { kind: 'erase-cell' });
      } else if (corners.length === 0) {
        continue;
      } else if (!isLegacyQuarterKind(originalKind)) {
        let kind = originalKind as CellKind;
        let colors: [number, number, number, number] = [
          document.colors[index * 4],
          document.colors[index * 4 + 1],
          document.colors[index * 4 + 2],
          document.colors[index * 4 + 3]
        ];
        let completed = document.completed[index];
        for (const corner of corners) ({ kind, colors, completed } = applyEraseQuarterState(kind, colors, completed, corner as 0 | 1 | 2 | 3));
        state = {
          index,
          cell: { x: index % document.width, y: Math.floor(index / document.width) },
          kind,
          colors,
          completed
        };
      } else {
        const colors: [number, number, number, number] = [
          document.colors[index * 4],
          document.colors[index * 4 + 1],
          document.colors[index * 4 + 2],
          document.colors[index * 4 + 3]
        ];
        let completed = document.completed[index];
        for (const corner of corners) {
          colors[corner as 0 | 1 | 2 | 3] = 0;
          completed &= ~(1 << corner);
        }
        const kind = colors.every((color) => color === 0) ? CellKind.Empty : CellKind.Quarters;
        state = {
          index,
          cell: { x: index % document.width, y: Math.floor(index / document.width) },
          kind,
          colors,
          completed: kind === CellKind.Empty ? 0 : completed
        };
      }
      if (cellStateChanged(document, state)) states.push(state);
    }
    return states;
  }

  private publishPendingCells(cells: Map<string, ModelPoint>, states: readonly PendingCellState[]): void {
    const state = this.uiStore.getState();
    const overlay: OverlayState = { ...state.overlay, pendingCells: [...cells.values()], pendingCellStates: [...states] };
    this.uiStore.setOverlay(overlay);
  }

  private clearPendingCells(): void {
    const state = this.uiStore.getState();
    if (!state.overlay.pendingCells && !state.overlay.pendingCellStates) return;
    this.uiStore.setOverlay({ ...state.overlay, pendingCells: undefined, pendingCellStates: undefined });
  }

  /** Cancel a one-finger chart edit when a second finger takes over. */
  private cancelTouchEditingGesture(): void {
    const candidate = this.touchHistoryCandidate;
    this.cancelGesture();
    this.touchHistoryCandidate = candidate;
  }

  private cancelGesture(): void {
    const selection = this.gesture?.kind === 'selection' ? this.gesture : undefined;
    const backstitch = this.gesture?.kind === 'backstitch';
    this.gesture = undefined;
    this.clearTouchHistoryCandidate();
    this.clearPendingCells();
    this.clearLassoPath();
    if (backstitch) this.resetBackstitchState();
    if (selection) {
      this.selection = selection.previousSelection;
      this.selectionAnchor = selection.previousSelectionAnchor;
      this.publishSelectionOverlay();
    }
    this.spaceHeld = false;
  }

  private resetToolTransient(): void {
    this.cancelGesture();
    this.touchCopyCandidate = undefined;
    this.clearTouchCopyRequest();
    this.cancelFill(false);
    this.resetBackstitchState();
    this.clearBrushPreview();
  }

  private clearBrushPreview(): void {
    const overlay = this.uiStore.getState().overlay;
    if (!overlay.brushPreview) return;
    this.uiStore.setOverlay({ ...overlay, brushPreview: undefined });
  }

  private updateBrushPreview(sample: PointerSample): void {
    const state = this.uiStore.getState();
    const tool = state.tool;
    const snapshot = this.gateway.getSnapshot();
    const document = snapshot.document;
    if (!document || this.spaceHeld || (sample.buttons ?? 0) !== 0) {
      this.clearBrushPreview();
      return;
    }
    const eligible = tool.tool === 'paint' || tool.tool === 'completion' || tool.tool === 'eraser';
    const cell = eligible ? this.paintHitCell(sample, document) : undefined;
    if (!eligible || !cell) {
      this.clearBrushPreview();
      return;
    }
    const brushSize = tool.tool === 'completion' ? 1 : this.getBrushSize();
    let states: PendingCellState[];
    const kind: 'paint' | 'completion' | 'eraser' = tool.tool === 'paint' ? 'paint' : tool.tool === 'completion' ? 'completion' : 'eraser';
    if (tool.tool === 'paint') {
      const cells = new Map<string, ModelPoint>();
      stampBrush(cells, cell, brushSize, document);
      // The hover outline marks the brush footprint, so keep cells the stroke
      // would leave unchanged (e.g. stitches already in the selected color).
      const edit = editForBrush(tool.brush, this.paintCorner(sample));
      states = Array.from(indicesForCells([...cells.values()], document.width), (index) => cellState(document, index, edit));
    } else if (tool.tool === 'completion') {
      const local = normalizedPointerPosition(sample, state.viewport);
      const mask = local ? completionTargetForCell(document, cell, local) : 0;
      if (mask === 0) { this.clearBrushPreview(); return; }
      const targets = new Map<number, CompletionTarget>();
      stampCompletionTargets(targets, cell, document, local!);
      const operation: CompletionOperation = (document.completed[cell.y * document.width + cell.x] & mask) === mask ? 'clear' : 'set';
      states = this.pendingCompletionStates(targets, operation, document);
    } else {
      const cells = new Map<string, ModelPoint>();
      const components = new Map<string, { readonly cell: ModelPoint; readonly corner: number }>();
      const mode = tool.mode ?? 'whole-cell';
      this.addEraserSample(cells, components, cell, mode, sample, document, brushSize);
      states = this.pendingEraserStates(cells, components, mode, document);
    }
    this.uiStore.setOverlay({ ...state.overlay, brushPreview: { states, kind } });
  }

  private firstActivePaletteId(): number | undefined {
    return this.gateway.getSnapshot().document?.palette.find((entry) => entry.active)?.id;
  }

  /**
   * Enter the move-image tool. Without a trace image there is nothing to move,
   * so the request is ignored and the current tool stays active. Clicking the
   * tool again toggles back to the remembered tool.
   */
  private enterMoveImage(): void {
    if (!this.traceImage) return;
    const state = this.uiStore.getState();
    if (state.tool.tool === 'move-image') {
      this.setTool(this.imageToolPreviousTool ?? { tool: 'pan' });
      return;
    }
    this.imageToolPreviousTool = state.tool;
    this.uiStore.setTool({ tool: 'move-image' });
    this.renderer.setPatternDimmed?.(true);
    // Escape/arrows must work even when the canvas does not have focus (the
    // toolbar button keeps focus after clicking it), so listen on the window.
    this.installImageToolKeydownListener();
  }

  /**
   * Enter the resize-image tool, sharing the reference-tool scaffolding with
   * move-image (dimming, window key handling, remembered previous tool).
   */
  private enterResizeImage(): void {
    if (!this.traceImage) return;
    const state = this.uiStore.getState();
    if (state.tool.tool === 'resize-image') {
      this.setTool(this.imageToolPreviousTool ?? { tool: 'pan' });
      return;
    }
    this.imageToolPreviousTool = state.tool;
    this.uiStore.setTool({ tool: 'resize-image' });
    this.renderer.setPatternDimmed?.(true);
    this.uiStore.setOverlay({ ...state.overlay, imageResizeHandles: true });
    this.installImageToolKeydownListener();
  }

  /** Leave either reference-image tool: remove the listener, clear dimming and handles. Idempotent. */
  private exitImageTool(): void {
    this.removeImageToolKeydownListener();
    this.imageToolPreviousTool = null;
    this.renderer.setPatternDimmed?.(false);
    const state = this.uiStore.getState();
    if (state.overlay.imageResizeHandles) this.uiStore.setOverlay({ ...state.overlay, imageResizeHandles: false });
  }

  private installImageToolKeydownListener(): void {
    this.removeImageToolKeydownListener();
    const handler = (event: KeyboardEvent): void => this.handleImageToolKeydown(event);
    this.imageToolKeydownListener = handler;
    globalThis.addEventListener?.('keydown', handler);
  }

  private removeImageToolKeydownListener(): void {
    if (this.imageToolKeydownListener) {
      globalThis.removeEventListener?.('keydown', this.imageToolKeydownListener);
      this.imageToolKeydownListener = null;
    }
  }

  private handleImageToolKeydown(event: KeyboardEvent): void {
    if (this.disposed) return;
    const tool = this.uiStore.getState().tool.tool;
    if (tool !== 'move-image' && tool !== 'resize-image') return;
    const key = event.key;
    if (key === 'Escape') {
      event.preventDefault();
      this.setTool(this.imageToolPreviousTool ?? { tool: 'pan' });
      return;
    }
    if (tool !== 'move-image') return; // Arrow keys are move-only.
    if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') {
      event.preventDefault();
      const dx = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0;
      const dy = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0;
      this.nudgeTraceImage(dx, dy);
    }
  }

  /** Shift the reference image by a whole-cell delta and persist via the callback. */
  private nudgeTraceImage(dx: number, dy: number): void {
    if (!this.traceImage) return;
    const current = this.traceImage;
    const bounds = current.chartBounds;
    if (!bounds) return;
    const chartBounds = { x: bounds.x + dx, y: bounds.y + dy, width: bounds.width, height: bounds.height };
    const next: TraceImage = { ...current, chartBounds };
    this.setTraceImage(next);
    this.renderer.requestRender();
    this.traceBoundsChangeCallback?.({ ...chartBounds });
  }

  private beginMoveImage(sample: PointerSample, document: PatternDocument): boolean {
    if (!this.traceImage) return false;
    const viewport = this.uiStore.getState().viewport;
    if (!isFiniteViewport(viewport)) return false;
    const trace = this.traceImage;
    const bounds: CellRect = trace.chartBounds ?? { x: 0, y: 0, width: document.width, height: document.height };
    this.gesture = { kind: 'move-image', pointerId: sample.pointerId, startScreenX: sample.screenX, startScreenY: sample.screenY, startBounds: bounds };
    return true;
  }

  private finishMoveImage(gesture: MoveImageGesture, sample: PointerSample): void {
    this.gesture = undefined;
    if (Math.hypot(sample.screenX - gesture.startScreenX, sample.screenY - gesture.startScreenY) <= MOVE_IMAGE_TAP_PIXELS) {
      this.tapNudgeTraceImage(sample);
      return;
    }
    const bounds = this.traceImage?.chartBounds;
    if (bounds) this.traceBoundsChangeCallback?.({ ...bounds });
  }

  /** Tap-to-nudge: move the image one cell toward the tap's dominant axis when the tap is outside the image. */
  private tapNudgeTraceImage(sample: PointerSample): void {
    const trace = this.traceImage;
    const document = this.gateway.getSnapshot().document;
    const viewport = this.uiStore.getState().viewport;
    if (!trace || !document || !isFiniteViewport(viewport)) return;
    const bounds = trace.chartBounds ?? { x: 0, y: 0, width: document.width, height: document.height };
    const tap = screenToModel({ x: sample.screenX, y: sample.screenY }, viewport);
    const minX = Math.floor(bounds.x);
    const minY = Math.floor(bounds.y);
    const maxX = Math.ceil(bounds.x + bounds.width);
    const maxY = Math.ceil(bounds.y + bounds.height);
    if (tap.x >= minX && tap.x < maxX && tap.y >= minY && tap.y < maxY) return;
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    const dx = tap.x - centerX;
    const dy = tap.y - centerY;
    if (Math.abs(dx) > Math.abs(dy)) this.nudgeTraceImage(dx > 0 ? 1 : -1, 0);
    else if (Math.abs(dy) > Math.abs(dx)) this.nudgeTraceImage(0, dy > 0 ? 1 : -1);
    else if (dx !== 0) this.nudgeTraceImage(dx > 0 ? 1 : -1, 0);
  }

  private updateMoveImage(sample: PointerSample): void {
    if (this.gesture?.kind !== 'move-image' || !this.traceImage) return;
    const viewport = this.uiStore.getState().viewport;
    if (!isFiniteViewport(viewport)) return;
    const dx = (sample.screenX - this.gesture.startScreenX) / viewport.zoom;
    const dy = (sample.screenY - this.gesture.startScreenY) / viewport.zoom;
    const next: TraceImage = {
      ...this.traceImage,
      chartBounds: {
        x: this.gesture.startBounds.x + dx,
        y: this.gesture.startBounds.y + dy,
        width: this.gesture.startBounds.width,
        height: this.gesture.startBounds.height
      }
    };
    // Reuse the public setter so the renderer sees a trace image with the same
    // source identity (its same-source check keeps the bitmap undisposed).
    this.setTraceImage(next);
    this.renderer.requestRender();
  }

  /** Screen-space corner points of the reference image (same conversion the renderer uses). */
  private resizeCornerPoints(): { corner: ResizeCorner; point: ScreenPoint }[] | undefined {
    const bounds = this.traceImage?.chartBounds;
    const viewport = this.uiStore.getState().viewport;
    if (!bounds || !isFiniteViewport(viewport)) return undefined;
    const rect = cellToScreenRect(bounds, viewport);
    return [
      { corner: 'nw', point: { x: rect.x, y: rect.y } },
      { corner: 'ne', point: { x: rect.x + rect.width, y: rect.y } },
      { corner: 'sw', point: { x: rect.x, y: rect.y + rect.height } },
      { corner: 'se', point: { x: rect.x + rect.width, y: rect.y + rect.height } }
    ];
  }

  private beginResizeImage(sample: PointerSample): boolean {
    if (!this.traceImage) return false;
    const viewport = this.uiStore.getState().viewport;
    if (!isFiniteViewport(viewport)) return false;
    const bounds = this.traceImage.chartBounds;
    if (!bounds) return false;
    const corners = this.resizeCornerPoints();
    if (!corners) return false;
    const radius = RESIZE_HANDLE_HIT_PIXELS;
    const hit = corners.find(({ point }) =>
      (point.x - sample.screenX) ** 2 + (point.y - sample.screenY) ** 2 <= radius * radius
    );
    if (!hit) return false; // Pointer not near a corner: no-op.
    const anchor = resizeAnchor(hit.corner, bounds);
    this.gesture = { kind: 'resize-image', pointerId: sample.pointerId, corner: hit.corner, anchor, startBounds: bounds };
    return true;
  }

  private updateResizeImage(sample: PointerSample): void {
    if (this.gesture?.kind !== 'resize-image' || !this.traceImage) return;
    const viewport = this.uiStore.getState().viewport;
    if (!isFiniteViewport(viewport)) return;
    const document = this.gateway.getSnapshot().document;
    const { corner, anchor, startBounds } = this.gesture;
    const freeform = Boolean(sample.ctrlKey || sample.metaKey);
    // The dragged corner snaps to the nearest canvas edge within a screen-pixel
    // tolerance so flush alignment is trivial; the opposite corner stays fixed.
    const snapCells = document ? RESIZE_EDGE_SNAP_PIXELS / viewport.zoom : 0;
    const pointer = screenToModel({ x: sample.screenX, y: sample.screenY }, viewport);
    const snapped = document
      ? {
          x: snapTowards(pointer.x, corner === 'nw' || corner === 'sw' ? 0 : document.width, snapCells),
          y: snapTowards(pointer.y, corner === 'nw' || corner === 'ne' ? 0 : document.height, snapCells)
        }
      : pointer;
    let left = startBounds.x;
    let top = startBounds.y;
    let right = left + startBounds.width;
    let bottom = top + startBounds.height;
    switch (corner) {
      case 'nw':
        left = Math.min(snapped.x, anchor.x - 1);
        top = Math.min(snapped.y, anchor.y - 1);
        break;
      case 'ne':
        right = Math.max(snapped.x, anchor.x + 1);
        top = Math.min(snapped.y, anchor.y - 1);
        break;
      case 'sw':
        left = Math.min(snapped.x, anchor.x - 1);
        bottom = Math.max(snapped.y, anchor.y + 1);
        break;
      case 'se':
        right = Math.max(snapped.x, anchor.x + 1);
        bottom = Math.max(snapped.y, anchor.y + 1);
        break;
    }
    // Enforce a minimum 1x1 cell so the rect never inverts or collapses.
    if (right - left < 1) right = left + 1;
    if (bottom - top < 1) bottom = top + 1;
    // Preserve the start aspect ratio unless the user holds Ctrl/Meta; the
    // dimension that moved furthest relative to its start drives the other.
    if (!freeform && startBounds.width > 0 && startBounds.height > 0) {
      const relativeWidth = (right - left) / startBounds.width;
      const relativeHeight = (bottom - top) / startBounds.height;
      let width: number;
      let height: number;
      if (relativeWidth >= relativeHeight) {
        width = Math.max(1, right - left);
        height = Math.max(1, (right - left) * (startBounds.height / startBounds.width));
      } else {
        height = Math.max(1, bottom - top);
        width = Math.max(1, (bottom - top) * (startBounds.width / startBounds.height));
      }
      switch (corner) {
        case 'nw':
          right = anchor.x; bottom = anchor.y;
          left = right - width; top = bottom - height;
          break;
        case 'ne':
          left = anchor.x; bottom = anchor.y;
          right = left + width; top = bottom - height;
          break;
        case 'sw':
          right = anchor.x; top = anchor.y;
          left = right - width; bottom = top + height;
          break;
        case 'se':
          left = anchor.x; top = anchor.y;
          right = left + width; bottom = top + height;
          break;
      }
    }
    const chartBounds = { x: left, y: top, width: right - left, height: bottom - top };
    this.setTraceImage({ ...this.traceImage, chartBounds });
    this.renderer.requestRender();
  }

  private finishResizeImage(): void {
    this.gesture = undefined;
    const bounds = this.traceImage?.chartBounds;
    if (bounds) this.traceBoundsChangeCallback?.({ ...bounds });
  }

  private setKeyboardCursor(cursor: ModelPoint, extendSelection = false): void {
    const snapshot = this.gateway.getSnapshot();
    if (!snapshot.document || !isFiniteModelPoint(cursor)) return;
    const bounded = {
      x: Math.min(Math.max(0, Math.floor(cursor.x)), snapshot.document.width - 1),
      y: Math.min(Math.max(0, Math.floor(cursor.y)), snapshot.document.height - 1)
    };
    if (extendSelection) {
      this.selectionAnchor ??= this.uiStore.getState().keyboardCursor ?? { x: 0, y: 0 };
      const rect = boundedGridRect(normalizeGridRect(this.selectionAnchor, bounded), snapshot.document);
      this.selection = rect ? { kind: 'rect', rect, documentWidth: snapshot.document.width, documentHeight: snapshot.document.height } : undefined;
    } else {
      this.selection = undefined;
      this.selectionAnchor = undefined;
    }
    const selected = selectedCellSemantics(snapshot.document, bounded);
    const keyboardBackstitchStatus = this.keyboardBackstitchAnchor
      ? `Backstitch start anchored at (${String(this.keyboardBackstitchAnchor.x)}, ${String(this.keyboardBackstitchAnchor.y)}); press Enter to finish`
      : selected.summary;
    this.uiStore.setState({
      keyboardCursor: bounded,
      overlay: { ...this.uiStore.getState().overlay, cursor: bounded },
      selectedCell: selected,
      status: keyboardBackstitchStatus
    });
    if (this.keyboardBackstitchAnchor) this.publishBackstitchPreview(this.keyboardBackstitchAnchor, fixedPointAt(bounded, snapshot.document));
    this.publishSelectionOverlay();
  }

  private publishSelectedCell(updateStatus: boolean): void {
    this.publishSelectedCellForDocument(this.gateway.getSnapshot().document, updateStatus);
  }

  private publishSelectedCellForDocument(document: PatternDocument | null, updateStatus: boolean): void {
    const cursor = this.uiStore.getState().keyboardCursor;
    const selected = document && cursor && isFiniteModelPoint(cursor) ? selectedCellSemantics(document, cursor) : null;
    this.uiStore.setSelectedCell(selected);
    if (updateStatus) this.uiStore.setStatus(selected?.summary ?? null);
  }

  private projectViewport(viewport: Viewport): void {
    const snapshot = this.gateway.getSnapshot();
    const next = normalizeViewport(viewport, snapshot.document ?? undefined, this.metrics ?? undefined, this.viewportOptions);
    this.uiStore.setViewport(next);
  }

  private viewportCenter(): ModelPoint {
    return { x: (this.metrics?.cssWidth ?? 0) / 2, y: (this.metrics?.cssHeight ?? 0) / 2 };
  }

  private fit(): void {
    const snapshot = this.gateway.getSnapshot();
    if (snapshot.document && this.metrics) this.projectViewport(fitViewport(snapshot.document, this.metrics, 0, this.viewportOptions));
  }

  private setStatus(status: string): void {
    this.uiStore.setStatus(status);
  }

  private ensureStarted(): void {
    if (!this.started && !this.disposed) this.start();
  }
}

export const createEditorSurfaceController = (options: EditorSurfaceControllerOptions): EditorSurfaceController => new EditorSurfaceController(options);
