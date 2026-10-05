import {
  CellKind,
  DomainError,
  FIXED_POINT_UNITS_PER_CELL,
  LayerType,
  MAX_PERSISTABLE_CELL_COUNT,
  type BackstitchRecord,
  type BackstitchStore,
  type CanvasCellsCommand,
  type CanvasEdges,
  type CanvasResizeCommand,
  type CropRect,
  type DomainCommand,
  type Layer,
  type LayeredDocument,
  type PatternDocument
} from './types';

/** The workspace is at least this many cells on each axis. */
export const WORKSPACE_MIN_EXTENT = 1000;
/** The workspace reaches at least this many cells past each side of the box. */
export const WORKSPACE_MIN_MARGIN = 100;

const UNITS = FIXED_POINT_UNITS_PER_CELL;

type CanvasShape = Pick<PatternDocument, 'width' | 'height' | 'canvasMask'>;

/** Every cell of the box is active when there is no mask. */
export function isActiveCell(doc: Pick<PatternDocument, 'width' | 'canvasMask'>, index: number): boolean {
  return doc.canvasMask === undefined || doc.canvasMask[index] === 1;
}

export function isRectangularCanvas(doc: { canvasMask?: Uint8Array }): boolean {
  return doc.canvasMask === undefined;
}

export function activeCellCount(doc: CanvasShape): number {
  const mask = doc.canvasMask;
  if (mask === undefined) return doc.width * doc.height;
  let count = 0;
  for (let index = 0; index < mask.length; index += 1) count += mask[index];
  return count;
}

/**
 * The workspace in local coordinates: centred on the box, each axis
 * `max(WORKSPACE_MIN_EXTENT, dim + 2 * WORKSPACE_MIN_MARGIN)` cells long.
 */
export function canvasWorkspace(doc: { width: number; height: number }): CropRect {
  const width = Math.max(WORKSPACE_MIN_EXTENT, doc.width + 2 * WORKSPACE_MIN_MARGIN);
  const height = Math.max(WORKSPACE_MIN_EXTENT, doc.height + 2 * WORKSPACE_MIN_MARGIN);
  return { x: Math.floor((doc.width - width) / 2), y: Math.floor((doc.height - height) / 2), width, height };
}

/** True for an origin coordinate the binary format can store (a 32-bit signed integer). */
export function isValidCanvasOrigin(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff;
}

/**
 * The canvas fields of a document, for building surfaces that share them by
 * reference. An origin of 0 is the same as an absent one, so both are omitted.
 */
export function canvasFields(doc: Pick<PatternDocument, 'originX' | 'originY' | 'canvasMask'>): Pick<PatternDocument, 'originX' | 'originY' | 'canvasMask'> {
  return {
    ...(doc.originX === undefined || doc.originX === 0 ? {} : { originX: doc.originX }),
    ...(doc.originY === undefined || doc.originY === 0 ? {} : { originY: doc.originY }),
    ...(doc.canvasMask === undefined ? {} : { canvasMask: doc.canvasMask })
  };
}

/** Packs a 0/1 mask at one bit per cell, least significant bit first (bit `i & 7` of byte `i >> 3`); padding bits are zero. */
export function packCanvasMask(mask: Uint8Array): Uint8Array {
  const bits = new Uint8Array(Math.ceil(mask.length / 8));
  for (let index = 0; index < mask.length; index += 1) if (mask[index] === 1) bits[index >> 3] |= 1 << (index & 7);
  return bits;
}

/** Inverse of `packCanvasMask` for `cellCount` cells. */
export function unpackCanvasMask(bits: Uint8Array, cellCount: number): Uint8Array {
  const mask = new Uint8Array(cellCount);
  for (let index = 0; index < cellCount; index += 1) mask[index] = (bits[index >> 3] >> (index & 7)) & 1;
  return mask;
}

// ---------------------------------------------------------------------------
// Backstitch coverage

/** An exact rational coordinate `n / d` in fixed-point units, with `d > 0`. */
interface Coordinate {
  readonly n: number;
  readonly d: number;
}

function floorDiv(n: number, m: number): number {
  let quotient = Math.floor(n / m);
  if (quotient * m > n) quotient -= 1;
  else if ((quotient + 1) * m <= n) quotient += 1;
  return quotient;
}

/** The cells whose closed extent on one axis contains the coordinate: two on a grid line, otherwise one. */
function cellsAt(value: Coordinate): [number, number] {
  const span = UNITS * value.d;
  const cell = floorDiv(value.n, span);
  return value.n - cell * span === 0 ? [cell - 1, cell] : [cell, cell];
}

function cellActive(doc: CanvasShape, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return false;
  return isActiveCell(doc, y * doc.width + x);
}

function anyActive(doc: CanvasShape, columns: readonly [number, number], rows: readonly [number, number]): boolean {
  for (let x = columns[0]; x <= columns[1]; x += 1) for (let y = rows[0]; y <= rows[1]; y += 1) if (cellActive(doc, x, y)) return true;
  return false;
}

/** A parameter `p / q` along the segment, with `q > 0`. */
interface Parameter {
  readonly p: number;
  readonly q: number;
}

function compareParameters(left: Parameter, right: Parameter): number {
  return left.p * right.q - right.p * left.q;
}

/** Parameters where the segment crosses a grid line on one axis, strictly between its ends. */
function gridCrossings(start: number, delta: number, parameters: Parameter[]): void {
  if (delta === 0) return;
  const step = delta > 0 ? 1 : -1;
  const q = Math.abs(delta);
  const end = start + delta;
  let line = step > 0 ? floorDiv(start, UNITS) + 1 : -floorDiv(-start, UNITS) - 1;
  for (; step > 0 ? line * UNITS < end : line * UNITS > end; line += step) parameters.push({ p: (line * UNITS - start) * step, q });
}

/**
 * True when every point of the segment lies in the union of the closed
 * squares of active cells; cells outside the box are inactive. Coordinates
 * are fixed point, `FIXED_POINT_UNITS_PER_CELL` per cell. On a full rectangle
 * this keeps lines on the outer border.
 */
export function backstitchWithinCanvas(doc: CanvasShape, x1: number, y1: number, x2: number, y2: number): boolean {
  const maxX = doc.width * UNITS;
  const maxY = doc.height * UNITS;
  const inBox = (x: number, y: number): boolean => x >= 0 && y >= 0 && x <= maxX && y <= maxY;
  if (!inBox(x1, y1) || !inBox(x2, y2)) return false;
  // The box is convex, so a full rectangle needs only the endpoints.
  if (doc.canvasMask === undefined) return true;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const parameters: Parameter[] = [{ p: 0, q: 1 }, { p: 1, q: 1 }];
  gridCrossings(x1, dx, parameters);
  gridCrossings(y1, dy, parameters);
  parameters.sort(compareParameters);
  const unique = parameters.filter((parameter, index) => index === 0 || compareParameters(parameter, parameters[index - 1]) !== 0);
  const pointAt = (parameter: Parameter): { x: Coordinate; y: Coordinate } => ({
    x: { n: x1 * parameter.q + parameter.p * dx, d: parameter.q },
    y: { n: y1 * parameter.q + parameter.p * dy, d: parameter.q }
  });
  // Between neighbouring parameters the open piece stays inside one cell, or on one grid line when the segment is axis aligned.
  const pieceCells = (start: Coordinate, end: Coordinate, delta: number): [number, number] => {
    if (delta === 0) return cellsAt(start);
    const low = start.n * end.d <= end.n * start.d ? start : end;
    const cell = floorDiv(low.n, UNITS * low.d);
    return [cell, cell];
  };
  let previous = pointAt(unique[0]);
  if (!anyActive(doc, cellsAt(previous.x), cellsAt(previous.y))) return false;
  for (let index = 1; index < unique.length; index += 1) {
    const point = pointAt(unique[index]);
    if (!anyActive(doc, pieceCells(previous.x, point.x, dx), pieceCells(previous.y, point.y, dy))) return false;
    if (!anyActive(doc, cellsAt(point.x), cellsAt(point.y))) return false;
    previous = point;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Commands

export function canvasResizeCommand(edges: CanvasEdges): CanvasResizeCommand {
  return { type: 'canvas-resize', edges: { top: edges.top, right: edges.right, bottom: edges.bottom, left: edges.left } };
}

export function canvasCellsCommand(operation: 'add' | 'remove', rect: CropRect, cells?: Uint8Array): CanvasCellsCommand {
  return { type: 'canvas-cells', operation, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, ...(cells === undefined ? {} : { cells }) };
}

function canvasCommandType(command: DomainCommand): string | undefined {
  if (!command || typeof command.type !== 'string') return undefined;
  const type = command.type.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();
  return type === 'canvas-resize' || type === 'canvas-cells' ? type : undefined;
}

export function isCanvasCommand(command: DomainCommand): boolean {
  return canvasCommandType(command) !== undefined;
}

export interface CanvasRemoval {
  /** Per stitch layer: before-frame cell indices that held content, with their kind/colors. */
  readonly cells: ReadonlyArray<{ layerId: number; indices: Uint32Array; kind: Uint8Array; colors: Uint16Array }>;
  /** Per specialty layer: full records of the removed backstitches. */
  readonly backstitches: ReadonlyArray<{ layerId: number; records: BackstitchRecord[] }>;
}

export interface CanvasCommandResult {
  readonly document: LayeredDocument;
  readonly changed: boolean;
  readonly removal: CanvasRemoval;
}

const NO_REMOVAL: CanvasRemoval = { cells: [], backstitches: [] };

function invalid(message: string): never {
  throw new DomainError('invalid-command', message);
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid(`${label} must be an integer.`);
  return value;
}

function contains(outer: CropRect, inner: CropRect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

function assertBoxSize(width: number, height: number): void {
  if (width < 1 || height < 1) throw new DomainError('canvas-empty', 'The canvas must keep at least one cell.');
  if (width * height > MAX_PERSISTABLE_CELL_COUNT) throw new DomainError('canvas-too-large', `The canvas cannot exceed ${String(MAX_PERSISTABLE_CELL_COUNT)} cells.`);
}

/**
 * Applies `canvas-resize` or `canvas-cells`. Pure: the input document and its
 * planes are never written; a changed result has new planes for every layer
 * whose content moved or was cleared. Revision and counters are unchanged.
 */
export function applyCanvasCommand(doc: LayeredDocument, command: DomainCommand): CanvasCommandResult {
  const type = canvasCommandType(command);
  if (type === 'canvas-resize') return applyResize(doc, command);
  if (type === 'canvas-cells') return applyCells(doc, command);
  return invalid(`${String(command?.type)} is not a canvas command.`);
}

function applyResize(doc: LayeredDocument, command: DomainCommand): CanvasCommandResult {
  const edges = command.edges as Partial<CanvasEdges> | undefined;
  if (typeof edges !== 'object' || edges === null) invalid('canvas-resize requires edges.');
  const top = integer(edges.top, 'edges.top');
  const right = integer(edges.right, 'edges.right');
  const bottom = integer(edges.bottom, 'edges.bottom');
  const left = integer(edges.left, 'edges.left');
  if (doc.canvasMask !== undefined) throw new DomainError('canvas-not-rectangular', 'Only a rectangular canvas can be resized by its edges.');
  if (top === 0 && right === 0 && bottom === 0 && left === 0) return { document: doc, changed: false, removal: NO_REMOVAL };
  const box: CropRect = { x: -left, y: -top, width: doc.width + left + right, height: doc.height + top + bottom };
  assertBoxSize(box.width, box.height);
  if (!contains(canvasWorkspace(doc), box)) throw new DomainError('canvas-outside-workspace', 'The canvas cannot grow past the workspace.');
  return reframe(doc, box, undefined);
}

function applyCells(doc: LayeredDocument, command: DomainCommand): CanvasCommandResult {
  const operation = command.operation;
  if (operation !== 'add' && operation !== 'remove') invalid('canvas-cells operation must be add or remove.');
  const source = command.rect as Partial<CropRect> | undefined;
  if (typeof source !== 'object' || source === null) invalid('canvas-cells requires a rect.');
  const rect: CropRect = { x: integer(source.x, 'rect.x'), y: integer(source.y, 'rect.y'), width: integer(source.width, 'rect.width'), height: integer(source.height, 'rect.height') };
  if (rect.width < 1 || rect.height < 1) invalid('canvas-cells rect must be at least one cell.');
  const cells = command.cells;
  if (cells !== undefined) {
    if (!(cells instanceof Uint8Array) || cells.length !== rect.width * rect.height) invalid('canvas-cells cells must be a Uint8Array with one value per rect cell.');
    for (let index = 0; index < cells.length; index += 1) if (cells[index] > 1) invalid('canvas-cells cells must hold only 0 or 1.');
  }
  const selected = (x: number, y: number): boolean => cells === undefined || cells[(y - rect.y) * rect.width + x - rect.x] === 1;

  // Clip to the workspace (adding) or to the box (removing: nothing outside it is active).
  const limit = operation === 'add' ? canvasWorkspace(doc) : { x: 0, y: 0, width: doc.width, height: doc.height };
  const clipX = Math.max(rect.x, limit.x);
  const clipY = Math.max(rect.y, limit.y);
  const clipRight = Math.min(rect.x + rect.width, limit.x + limit.width);
  const clipBottom = Math.min(rect.y + rect.height, limit.y + limit.height);
  const unchanged = { document: doc, changed: false, removal: NO_REMOVAL };
  if (clipX >= clipRight || clipY >= clipBottom) return unchanged;
  // Adding a whole rect makes the box cover it, so reject an oversized one before walking it.
  if (operation === 'add' && cells === undefined) assertBoxSize(Math.max(doc.width, clipRight) - Math.min(0, clipX), Math.max(doc.height, clipBottom) - Math.min(0, clipY));

  // The frame holds the box and every selected cell, so the result's tight bounds lie inside it.
  let frameX = 0;
  let frameY = 0;
  let frameRight = doc.width;
  let frameBottom = doc.height;
  let changes = 0;
  for (let y = clipY; y < clipBottom; y += 1) {
    for (let x = clipX; x < clipRight; x += 1) {
      if (!selected(x, y)) continue;
      const inBox = x >= 0 && y >= 0 && x < doc.width && y < doc.height;
      const active = inBox && isActiveCell(doc, y * doc.width + x);
      if (active === (operation === 'add')) continue;
      changes += 1;
      if (x < frameX) frameX = x;
      if (y < frameY) frameY = y;
      if (x + 1 > frameRight) frameRight = x + 1;
      if (y + 1 > frameBottom) frameBottom = y + 1;
    }
  }
  if (changes === 0) return unchanged;

  const frameWidth = frameRight - frameX;
  const frameHeight = frameBottom - frameY;
  // Every added cell stays active and the old box is tight, so an add's frame is its result box.
  if (operation === 'add') assertBoxSize(frameWidth, frameHeight);
  const frame = new Uint8Array(frameWidth * frameHeight);
  for (let y = 0; y < doc.height; y += 1) {
    const row = (y - frameY) * frameWidth - frameX;
    if (doc.canvasMask === undefined) frame.fill(1, row, row + doc.width);
    else frame.set(doc.canvasMask.subarray(y * doc.width, (y + 1) * doc.width), row);
  }
  const value = operation === 'add' ? 1 : 0;
  for (let y = clipY; y < clipBottom; y += 1) {
    for (let x = clipX; x < clipRight; x += 1) if (selected(x, y)) frame[(y - frameY) * frameWidth + x - frameX] = value;
  }

  let left = frameWidth;
  let top = frameHeight;
  let right = -1;
  let bottom = -1;
  let active = 0;
  for (let y = 0; y < frameHeight; y += 1) {
    for (let x = 0; x < frameWidth; x += 1) {
      if (frame[y * frameWidth + x] === 0) continue;
      active += 1;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (active === 0) throw new DomainError('canvas-empty', 'The canvas must keep at least one cell.');
  const box: CropRect = { x: frameX + left, y: frameY + top, width: right - left + 1, height: bottom - top + 1 };
  assertBoxSize(box.width, box.height);
  let mask: Uint8Array | undefined;
  if (active !== box.width * box.height) {
    mask = new Uint8Array(box.width * box.height);
    for (let y = 0; y < box.height; y += 1) {
      const start = (top + y) * frameWidth + left;
      mask.set(frame.subarray(start, start + box.width), y * box.width);
    }
  }
  return reframe(doc, box, mask);
}

function toRecord(store: BackstitchStore, index: number): BackstitchRecord {
  const start = { x: store.x1[index], y: store.y1[index] };
  const end = { x: store.x2[index], y: store.y2[index] };
  return { id: store.ids[index], x1: start.x, y1: start.y, x2: end.x, y2: end.y, start, end, color: store.colors[index], completed: store.completed[index] !== 0 };
}

/**
 * Moves every layer into `box` (old-local coordinates) with `mask` as the new
 * active set, clearing content that is no longer on an active cell and
 * recording it as the removal.
 */
function reframe(doc: LayeredDocument, box: CropRect, mask: Uint8Array | undefined): CanvasCommandResult {
  const shape: CanvasShape = { width: box.width, height: box.height, canvasMask: mask };
  const oldWidth = doc.width;
  const oldHeight = doc.height;
  const cellCount = box.width * box.height;
  const sameBox = box.x === 0 && box.y === 0 && box.width === oldWidth && box.height === oldHeight;
  const activeAfter = (x: number, y: number): boolean => cellActive(shape, x - box.x, y - box.y);
  // Overlap of the old and new boxes, in old-local coordinates.
  const overlapX = Math.max(0, box.x);
  const overlapY = Math.max(0, box.y);
  const overlapRight = Math.min(oldWidth, box.x + box.width);
  const overlapBottom = Math.min(oldHeight, box.y + box.height);
  const removedCells: Array<CanvasRemoval['cells'][number]> = [];
  const removedLines: Array<CanvasRemoval['backstitches'][number]> = [];

  const layers = doc.layers.map((layer): Layer => {
    if (layer.type === LayerType.Stitch) {
      const indices: number[] = [];
      for (let index = 0; index < layer.kind.length; index += 1) {
        if (layer.kind[index] !== CellKind.Empty && !activeAfter(index % oldWidth, Math.floor(index / oldWidth))) indices.push(index);
      }
      if (sameBox && indices.length === 0) return layer;
      if (indices.length > 0) {
        const kind = new Uint8Array(indices.length);
        const colors = new Uint16Array(indices.length * 4);
        indices.forEach((index, position) => {
          kind[position] = layer.kind[index];
          colors.set(layer.colors.subarray(index * 4, index * 4 + 4), position * 4);
        });
        removedCells.push({ layerId: layer.id, indices: Uint32Array.from(indices), kind, colors });
      }
      const kind = new Uint8Array(cellCount);
      const colors = new Uint16Array(cellCount * 4);
      // The boxes may not overlap at all, for example after shrinking one edge and growing the opposite one.
      for (let y = overlapY; overlapX < overlapRight && y < overlapBottom; y += 1) {
        const from = y * oldWidth;
        const to = (y - box.y) * box.width - box.x;
        kind.set(layer.kind.subarray(from + overlapX, from + overlapRight), to + overlapX);
        colors.set(layer.colors.subarray((from + overlapX) * 4, (from + overlapRight) * 4), (to + overlapX) * 4);
      }
      for (const index of indices) {
        const x = index % oldWidth - box.x;
        const y = Math.floor(index / oldWidth) - box.y;
        if (x < 0 || y < 0 || x >= box.width || y >= box.height) continue;
        const target = y * box.width + x;
        kind[target] = CellKind.Empty;
        colors.fill(0, target * 4, target * 4 + 4);
      }
      return { ...layer, kind, colors, completed: sameBox ? layer.completed : new Uint8Array(cellCount) };
    }
    const store = layer.backstitches;
    const dx = box.x * UNITS;
    const dy = box.y * UNITS;
    const kept: number[] = [];
    const records: BackstitchRecord[] = [];
    for (let index = 0; index < store.ids.length; index += 1) {
      if (backstitchWithinCanvas(shape, store.x1[index] - dx, store.y1[index] - dy, store.x2[index] - dx, store.y2[index] - dy)) kept.push(index);
      else records.push(toRecord(store, index));
    }
    if (records.length > 0) removedLines.push({ layerId: layer.id, records });
    if (records.length === 0 && dx === 0 && dy === 0) return layer;
    const next: BackstitchStore = {
      ids: new Uint32Array(kept.length),
      x1: new Uint32Array(kept.length),
      y1: new Uint32Array(kept.length),
      x2: new Uint32Array(kept.length),
      y2: new Uint32Array(kept.length),
      colors: new Uint16Array(kept.length),
      completed: new Uint8Array(kept.length)
    };
    kept.forEach((index, position) => {
      next.ids[position] = store.ids[index];
      next.x1[position] = store.x1[index] - dx;
      next.y1[position] = store.y1[index] - dy;
      next.x2[position] = store.x2[index] - dx;
      next.y2[position] = store.y2[index] - dy;
      next.colors[position] = store.colors[index];
      next.completed[position] = store.completed[index];
    });
    return { ...layer, backstitches: next };
  });

  const originX = (doc.originX ?? 0) + box.x;
  const originY = (doc.originY ?? 0) + box.y;
  if (!isValidCanvasOrigin(originX) || !isValidCanvasOrigin(originY)) throw new DomainError('canvas-outside-workspace', 'The canvas cannot move that far from where it started.');
  const document: LayeredDocument = { ...doc, width: box.width, height: box.height, layers, originX, originY, canvasMask: mask };
  // An origin of 0 and a full rectangle are stored as absent fields, so equal canvases read the same.
  if (originX === 0) delete document.originX;
  if (originY === 0) delete document.originY;
  if (mask === undefined) delete document.canvasMask;
  return { document, changed: true, removal: { cells: removedCells, backstitches: removedLines } };
}
