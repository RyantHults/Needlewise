import type { GridRect, ModelPoint } from './contracts';
import { indexBounds, intersectRect } from './rect';

/** One exposed edge of a sparse cell selection. */
export interface SelectionBoundarySegment {
  readonly start: ModelPoint;
  readonly end: ModelPoint;
  /** Whether the unselected side is connected to the outside of the selection. */
  readonly kind: 'exterior' | 'interior';
}

export type LassoSelectionOperation = 'replace' | 'union' | 'subtract';

export interface RectangularSelection {
  readonly kind: 'rect';
  readonly rect: GridRect;
  readonly documentWidth: number;
  readonly documentHeight: number;
}

export interface SparseSelection {
  readonly kind: 'sparse';
  readonly indices: Uint32Array;
  readonly bounds: GridRect;
  readonly boundaries: readonly SelectionBoundarySegment[];
  readonly documentWidth: number;
  readonly documentHeight: number;
}

export type FinalizedSelection = RectangularSelection | SparseSelection;

/** Maximum number of model-space samples retained for a lasso gesture. */
export const MAX_LASSO_PATH_POINTS = 2048;

const GEOMETRY_EPSILON = 1e-9;

function samePoint(left: ModelPoint, right: ModelPoint): boolean {
  return left.x === right.x && left.y === right.y;
}

function canCollapseMiddle(previous: ModelPoint, middle: ModelPoint, next: ModelPoint): boolean {
  const firstX = middle.x - previous.x;
  const firstY = middle.y - previous.y;
  const secondX = next.x - middle.x;
  const secondY = next.y - middle.y;
  const cross = firstX * secondY - firstY * secondX;
  const scale = Math.max(1, Math.abs(firstX), Math.abs(firstY), Math.abs(secondX), Math.abs(secondY));
  const dot = firstX * secondX + firstY * secondY;
  return Math.abs(cross) <= GEOMETRY_EPSILON * scale && dot >= -GEOMETRY_EPSILON;
}

/**
 * Append one sample without allowing a coalesced pointer stream to grow the
 * retained path without bound. Straight runs collapse to their endpoint;
 * when the hard cap is reached, every other interior sample is decimated
 * while the original start and newest end are retained.
 */
export function appendLassoPoint(
  path: ModelPoint[],
  point: ModelPoint,
  maxPoints = MAX_LASSO_PATH_POINTS
): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  const limit = Math.max(3, Math.floor(maxPoints));
  const next = { x: point.x, y: point.y };
  if (path.length > 0 && samePoint(path[path.length - 1], next)) return false;
  if (path.length >= 2 && canCollapseMiddle(path[path.length - 2], path[path.length - 1], next)) {
    path[path.length - 1] = next;
    return true;
  }
  path.push(next);
  if (path.length <= limit) return true;

  const decimated: ModelPoint[] = [path[0]];
  for (let index = 1; index < path.length - 1; index += 2) decimated.push(path[index]);
  decimated.push(path[path.length - 1]);
  path.splice(0, path.length, ...decimated);
  return true;
}

function validStartingCell(point: ModelPoint | undefined, width: number, height: number): number | undefined {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined;
  const x = Math.floor(point.x);
  const y = Math.floor(point.y);
  return x >= 0 && y >= 0 && x < width && y < height ? y * width + x : undefined;
}

export interface LassoRasterAccumulator {
  readonly width: number;
  readonly height: number;
  readonly firstPoint: ModelPoint;
  readonly startIndex: number | undefined;
  readonly crossingEvents: Uint8Array;
  readonly boundaryCells: Uint8Array;
  lastPoint: ModelPoint;
  pointCount: number;
  areaTwice: number;
}

export function createLassoRasterAccumulator(
  width: number,
  height: number,
  firstPoint: ModelPoint,
  startingPoint = firstPoint
): LassoRasterAccumulator {
  const cellCount = Math.max(0, width * height);
  return {
    width,
    height,
    firstPoint: { ...firstPoint },
    startIndex: validStartingCell(startingPoint, width, height),
    crossingEvents: new Uint8Array(cellCount),
    boundaryCells: new Uint8Array(cellCount),
    lastPoint: { ...firstPoint },
    pointCount: 1,
    areaTwice: 0
  };
}

function toggleEvent(accumulator: LassoRasterAccumulator, row: number, column: number): void {
  if (row < 0 || row >= accumulator.height) return;
  const offset = row * accumulator.width;
  if (column >= 0 && column < accumulator.width) accumulator.crossingEvents[offset + column] ^= 1;
}

function markBoundaryCell(accumulator: LassoRasterAccumulator, x: number, y: number): void {
  if (x < 0 || y < 0 || x >= accumulator.width || y >= accumulator.height) return;
  accumulator.boundaryCells[y * accumulator.width + x] = 1;
}

function addRasterSegment(accumulator: LassoRasterAccumulator, start: ModelPoint, end: ModelPoint): void {
  accumulator.areaTwice += start.x * end.y - end.x * start.y;
  if (samePoint(start, end)) return;
  const minY = Math.min(start.y, end.y);
  const maxY = Math.max(start.y, end.y);
  if (Math.abs(start.y - end.y) <= GEOMETRY_EPSILON) {
    const row = Math.round(start.y - 0.5);
    if (Math.abs(start.y - (row + 0.5)) <= GEOMETRY_EPSILON) {
      const rawFirstX = Math.ceil(Math.min(start.x, end.x) - 0.5 - GEOMETRY_EPSILON);
      const rawLastX = Math.floor(Math.max(start.x, end.x) - 0.5 + GEOMETRY_EPSILON);
      const firstX = Math.max(0, rawFirstX);
      const lastX = Math.min(accumulator.width - 1, rawLastX);
      if (firstX > lastX) return;
      for (let x = firstX; x <= lastX; x += 1) markBoundaryCell(accumulator, x, row);
    }
    return;
  }

  const boundaryFirstRow = Math.max(0, Math.ceil(minY - 0.5 - GEOMETRY_EPSILON));
  const boundaryLastRow = Math.min(accumulator.height - 1, Math.floor(maxY - 0.5 + GEOMETRY_EPSILON));
  const crossingFirstRow = Math.max(0, Math.ceil(minY - 0.5 - GEOMETRY_EPSILON));
  const crossingLastRow = Math.min(accumulator.height - 1, Math.ceil(maxY - 0.5 - GEOMETRY_EPSILON) - 1);
  const slope = (end.x - start.x) / (end.y - start.y);

  for (let row = boundaryFirstRow; row <= boundaryLastRow; row += 1) {
    const scanY = row + 0.5;
    if (scanY < minY - GEOMETRY_EPSILON || scanY > maxY + GEOMETRY_EPSILON) continue;
    const x = start.x + (scanY - start.y) * slope;
    const cellX = Math.round(x - 0.5);
    if (Math.abs(x - (cellX + 0.5)) <= GEOMETRY_EPSILON) markBoundaryCell(accumulator, cellX, row);
  }
  for (let row = crossingFirstRow; row <= crossingLastRow; row += 1) {
    const scanY = row + 0.5;
    if (scanY < minY - GEOMETRY_EPSILON || scanY >= maxY - GEOMETRY_EPSILON) continue;
    const x = start.x + (scanY - start.y) * slope;
    // The even/odd rule toggles centres strictly to the left of an edge
    // intersection. Two difference events encode that prefix in O(1) space.
    const lastLeftCell = Math.ceil(x - 0.5 - GEOMETRY_EPSILON) - 1;
    if (lastLeftCell < 0) continue;
    toggleEvent(accumulator, row, 0);
    if (lastLeftCell + 1 < accumulator.width) toggleEvent(accumulator, row, lastLeftCell + 1);
  }
}

export function appendLassoRasterPoint(accumulator: LassoRasterAccumulator, point: ModelPoint): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  if (samePoint(accumulator.lastPoint, point)) return false;
  addRasterSegment(accumulator, accumulator.lastPoint, point);
  accumulator.lastPoint = { x: point.x, y: point.y };
  accumulator.pointCount += 1;
  return true;
}

export function finishLassoRaster(accumulator: LassoRasterAccumulator): Uint32Array {
  addRasterSegment(accumulator, accumulator.lastPoint, accumulator.firstPoint);
  if (accumulator.pointCount < 3 || Math.abs(accumulator.areaTwice) <= GEOMETRY_EPSILON) {
    return accumulator.startIndex === undefined ? new Uint32Array() : new Uint32Array([accumulator.startIndex]);
  }
  const indices: number[] = [];
  for (let y = 0; y < accumulator.height; y += 1) {
    let parity = 0;
    const offset = y * accumulator.width;
    for (let x = 0; x < accumulator.width; x += 1) {
      parity ^= accumulator.crossingEvents[offset + x];
      if (parity !== 0 || accumulator.boundaryCells[offset + x] !== 0) indices.push(offset + x);
    }
  }
  return new Uint32Array(indices);
}

function adjacentIndex(x: number, y: number, width: number, height: number): number | undefined {
  return x < 0 || y < 0 || x >= width || y >= height ? undefined : y * width + x;
}

/**
 * Return every exposed edge, including edges around holes. The tight bounds
 * are used as the flood-fill frame so a boundary can be identified as an
 * exterior edge or an interior (hole) edge without losing concave corners.
 */
export function selectionBoundarySegments(indices: ArrayLike<number>, width: number, height: number): SelectionBoundarySegment[] {
  const valid = normalizeIndices(indices, width * height);
  const selected = new Set(valid);
  const bounds = indexBounds(valid, width, height);
  if (!bounds) return [];

  // Flood unselected cells in the tight bounds. Unvisited unselected cells
  // are holes; selected cells are never traversed.
  const outside = new Set<number>();
  const queue: number[] = [];
  for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
    for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
      const index = y * width + x;
      if (selected.has(index)) continue;
      if (x === bounds.x || x === bounds.x + bounds.width - 1 || y === bounds.y || y === bounds.y + bounds.height - 1) {
        outside.add(index);
        queue.push(index);
      }
    }
  }
  for (let position = 0; position < queue.length; position += 1) {
    const index = queue[position];
    const x = index % width;
    const y = Math.floor(index / width);
    for (const [nextX, nextY] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
      if (nextX < bounds.x || nextY < bounds.y || nextX >= bounds.x + bounds.width || nextY >= bounds.y + bounds.height) continue;
      const next = nextY * width + nextX;
      if (!selected.has(next) && !outside.has(next)) {
        outside.add(next);
        queue.push(next);
      }
    }
  }

  const segments: SelectionBoundarySegment[] = [];
  for (const index of valid) {
    const x = index % width;
    const y = Math.floor(index / width);
    const sides: readonly [number, number, ModelPoint, ModelPoint][] = [
      [x, y - 1, { x, y }, { x: x + 1, y }],
      [x + 1, y, { x: x + 1, y }, { x: x + 1, y: y + 1 }],
      [x, y + 1, { x: x + 1, y: y + 1 }, { x, y: y + 1 }],
      [x - 1, y, { x, y: y + 1 }, { x, y }]
    ];
    for (const [neighborX, neighborY, start, end] of sides) {
      const neighbor = adjacentIndex(neighborX, neighborY, width, height);
      if (neighbor !== undefined && selected.has(neighbor)) continue;
      const kind = neighbor !== undefined && !outside.has(neighbor) ? 'interior' : 'exterior';
      segments.push({ start, end, kind });
    }
  }
  return segments;
}

export interface SparseSelectionGeometry {
  readonly indices: Uint32Array;
  readonly bounds: GridRect;
  readonly boundaries: readonly SelectionBoundarySegment[];
}

export function sparseSelectionGeometry(indices: ArrayLike<number>, width: number, height: number): SparseSelectionGeometry | undefined {
  const sorted = normalizeIndices(indices, width * height);
  const bounds = indexBounds(sorted, width, height);
  return bounds ? { indices: sorted, bounds, boundaries: selectionBoundarySegments(sorted, width, height) } : undefined;
}

export function selectionRectToIndices(rect: GridRect, width: number, height: number): Uint32Array {
  const indices: number[] = [];
  const bounded = intersectRect(rect, { x: 0, y: 0, width, height });
  if (!bounded) return new Uint32Array(0);
  for (let y = bounded.y; y < bounded.y + bounded.height; y += 1) for (let x = bounded.x; x < bounded.x + bounded.width; x += 1) indices.push(y * width + x);
  return new Uint32Array(indices);
}

/** The integer indices below `cellCount`, sorted ascending without duplicates. */
export function normalizeIndices(indices: ArrayLike<number>, cellCount: number): Uint32Array {
  const valid: number[] = [];
  for (let position = 0; position < indices.length; position += 1) {
    const index = indices[position];
    if (Number.isSafeInteger(index) && index >= 0 && index < cellCount) valid.push(index);
  }
  const sorted = new Uint32Array(valid).sort();
  return sorted.filter((index, position) => position === 0 || index !== sorted[position - 1]);
}

/**
 * Combine a lasso's captured cells with the current selection's by the lasso
 * operation, in sorted order. Replace keeps the captured cells as they are.
 */
export function combineSelection(current: ArrayLike<number>, captured: Uint32Array, operation: LassoSelectionOperation, cellCount: number): Uint32Array {
  if (operation === 'replace') return captured;
  const flags = new Uint8Array(cellCount);
  for (let position = 0; position < current.length; position += 1) flags[current[position]] = 1;
  const value = operation === 'union' ? 1 : 0;
  for (const index of captured) flags[index] = value;
  const combined: number[] = [];
  for (let index = 0; index < flags.length; index += 1) if (flags[index] === 1) combined.push(index);
  return new Uint32Array(combined);
}

export function rectSelection(rect: GridRect, document: { readonly width: number; readonly height: number }): RectangularSelection {
  return { kind: 'rect', rect, documentWidth: document.width, documentHeight: document.height };
}

/** A sparse selection of `indices` in the document, or undefined when none is in it. */
export function sparseSelection(indices: ArrayLike<number>, document: { readonly width: number; readonly height: number }): SparseSelection | undefined {
  const sparse = sparseSelectionGeometry(indices, document.width, document.height);
  return sparse ? { kind: 'sparse', ...sparse, documentWidth: document.width, documentHeight: document.height } : undefined;
}
