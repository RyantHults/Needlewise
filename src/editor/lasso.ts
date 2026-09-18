import type { CellRect, GridRect, ModelPoint } from './contracts';

/** One exposed edge of a sparse cell selection. */
export interface SelectionBoundarySegment {
  readonly start: ModelPoint;
  readonly end: ModelPoint;
  /** Whether the unselected side is connected to the outside of the selection. */
  readonly kind: 'exterior' | 'interior';
}

export type LassoSelectionOperation = 'replace' | 'union' | 'subtract';

/** Maximum number of model-space samples retained for a lasso gesture. */
export const MAX_LASSO_PATH_POINTS = 2048;

const GEOMETRY_EPSILON = 1e-9;

function samePoint(left: ModelPoint, right: ModelPoint): boolean {
  return left.x === right.x && left.y === right.y;
}

function signedArea(points: readonly ModelPoint[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}

function pointOnSegment(point: ModelPoint, start: ModelPoint, end: ModelPoint): boolean {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const cross = (point.x - start.x) * dy - (point.y - start.y) * dx;
  const tolerance = 1e-9 * Math.max(1, Math.abs(dx), Math.abs(dy), Math.abs(point.x), Math.abs(point.y));
  if (Math.abs(cross) > tolerance) return false;
  return point.x >= Math.min(start.x, end.x) - tolerance
    && point.x <= Math.max(start.x, end.x) + tolerance
    && point.y >= Math.min(start.y, end.y) - tolerance
    && point.y <= Math.max(start.y, end.y) + tolerance;
}

/** Point-in-polygon with the polygon boundary included. */
export function pointInOrOnPolygon(point: ModelPoint, polygon: readonly ModelPoint[]): boolean {
  if (polygon.length === 0) return false;
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const current = polygon[index];
    const prior = polygon[previous];
    if (pointOnSegment(point, prior, current)) return true;
    const crosses = (current.y > point.y) !== (prior.y > point.y)
      && point.x < (prior.x - current.x) * (point.y - current.y) / (prior.y - current.y) + current.x;
    if (crosses) inside = !inside;
  }
  return inside;
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

/** Remove repeated/collinear samples and apply the same hard cap as gestures. */
export function normalizeLassoPath(points: readonly ModelPoint[], maxPoints = MAX_LASSO_PATH_POINTS): ModelPoint[] {
  const normalized: ModelPoint[] = [];
  for (const point of points) appendLassoPoint(normalized, point, maxPoints);
  return normalized;
}

function finiteLassoPath(points: readonly ModelPoint[]): ModelPoint[] {
  const normalized: ModelPoint[] = [];
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    if (normalized.length === 0 || !samePoint(normalized[normalized.length - 1], point)) normalized.push({ x: point.x, y: point.y });
  }
  return normalized;
}

function validStartingCell(point: ModelPoint | undefined, width: number, height: number): number | undefined {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined;
  const x = Math.floor(point.x);
  const y = Math.floor(point.y);
  return x >= 0 && y >= 0 && x < width && y < height ? y * width + x : undefined;
}

/**
 * Capture the cells whose centres are covered by a freehand lasso. The result
 * is always sorted by document index, which makes later domain operations
 * deterministic and cheap to validate.
 */
export function lassoCellIndices(
  points: readonly ModelPoint[],
  width: number,
  height: number,
  startingPoint?: ModelPoint
): Uint32Array {
  if (width < 1 || height < 1) return new Uint32Array();
  const polygon = finiteLassoPath(points);
  const startIndex = validStartingCell(startingPoint ?? polygon[0], width, height);
  if (polygon.length < 3 || Math.abs(signedArea(polygon)) <= GEOMETRY_EPSILON) {
    return startIndex === undefined ? new Uint32Array() : new Uint32Array([startIndex]);
  }

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of polygon) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  const firstX = Math.max(0, Math.ceil(minX - 0.5 - 1e-9));
  const lastX = Math.min(width - 1, Math.floor(maxX - 0.5 + 1e-9));
  const firstY = Math.max(0, Math.ceil(minY - 0.5 - 1e-9));
  const lastY = Math.min(height - 1, Math.floor(maxY - 0.5 + 1e-9));
  if (firstX > lastX || firstY > lastY) return new Uint32Array();

  return rasterizeLassoScanlines(polygon, width, height, firstX, lastX, firstY, lastY);
}

interface LassoEdge {
  readonly start: ModelPoint;
  readonly end: ModelPoint;
  readonly minY: number;
  readonly maxY: number;
  readonly slope: number;
}

function scanlineRange(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.ceil(value - 0.5 - GEOMETRY_EPSILON)));
}

/**
 * Edge-bucket scanline rasterization. Each row evaluates active polygon
 * edges, then fills x-centre spans; it never tests every cell against every
 * polygon edge as the old point-in-polygon loop did.
 */
function rasterizeLassoScanlines(
  polygon: readonly ModelPoint[],
  width: number,
  height: number,
  firstX: number,
  lastX: number,
  firstY: number,
  lastY: number
): Uint32Array {
  const horizontalRows = new Map<number, Array<readonly [number, number]>>();
  const startBuckets = new Map<number, LassoEdge[]>();
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    if (samePoint(start, end)) continue;
    if (Math.abs(start.y - end.y) <= GEOMETRY_EPSILON) {
      const row = Math.round(start.y - 0.5);
      if (Math.abs(start.y - (row + 0.5)) <= GEOMETRY_EPSILON && row >= firstY && row <= lastY) {
        const ranges = horizontalRows.get(row) ?? [];
        ranges.push([Math.min(start.x, end.x), Math.max(start.x, end.x)]);
        horizontalRows.set(row, ranges);
      }
      continue;
    }
    const minY = Math.min(start.y, end.y);
    const maxY = Math.max(start.y, end.y);
    const edge: LassoEdge = { start, end, minY, maxY, slope: (end.x - start.x) / (end.y - start.y) };
    const firstRow = scanlineRange(minY, firstY, lastY);
    const bucket = startBuckets.get(firstRow) ?? [];
    bucket.push(edge);
    startBuckets.set(firstRow, bucket);
  }

  const indices: number[] = [];
  const active: LassoEdge[] = [];
  for (let y = firstY; y <= lastY; y += 1) {
    const starting = startBuckets.get(y);
    if (starting) active.push(...starting);
    const scanY = y + 0.5;
    for (let position = active.length - 1; position >= 0; position -= 1) {
      if (active[position].maxY < scanY - GEOMETRY_EPSILON) active.splice(position, 1);
    }

    const intersections: number[] = [];
    const boundaryXs: number[] = [];
    for (const edge of active) {
      if (scanY < edge.minY - GEOMETRY_EPSILON || scanY > edge.maxY + GEOMETRY_EPSILON) continue;
      const x = edge.start.x + (scanY - edge.start.y) * edge.slope;
      boundaryXs.push(x);
      // Half-open crossings avoid counting a shared vertex twice. Boundary
      // points are added separately so cell-centre-on-edge remains inclusive.
      if (scanY >= edge.minY - GEOMETRY_EPSILON && scanY < edge.maxY - GEOMETRY_EPSILON) intersections.push(x);
    }
    intersections.sort((left, right) => left - right);
    const rowCells = new Set<number>();
    for (let position = 0; position + 1 < intersections.length; position += 2) {
      // Derive endpoints before document clipping. Clamping first can turn a
      // span wholly outside the document into a false in-document span.
      const unclampedLeft = Math.ceil(intersections[position] - 0.5 - GEOMETRY_EPSILON);
      const unclampedRight = Math.floor(intersections[position + 1] - 0.5 + GEOMETRY_EPSILON);
      if (unclampedLeft > unclampedRight) continue;
      const left = Math.max(firstX, unclampedLeft);
      const right = Math.min(lastX, unclampedRight);
      if (left > right) continue;
      for (let x = left; x <= right; x += 1) rowCells.add(x);
    }
    for (const x of boundaryXs) {
      const cellX = Math.round(x - 0.5);
      if (Math.abs(x - (cellX + 0.5)) <= GEOMETRY_EPSILON && cellX >= firstX && cellX <= lastX) rowCells.add(cellX);
    }
    for (const [left, right] of horizontalRows.get(y) ?? []) {
      const unclampedStartX = Math.ceil(left - 0.5 - GEOMETRY_EPSILON);
      const unclampedEndX = Math.floor(right - 0.5 + GEOMETRY_EPSILON);
      if (unclampedStartX > unclampedEndX || unclampedEndX < firstX || unclampedStartX > lastX) continue;
      const startX = Math.max(firstX, unclampedStartX);
      const endX = Math.min(lastX, unclampedEndX);
      for (let x = startX; x <= endX; x += 1) rowCells.add(x);
    }
    for (const x of [...rowCells].sort((left, right) => left - right)) indices.push(y * width + x);
  }
  // `height` is part of the public rasterizer contract and guards future
  // callers that provide a clipped range independently of the document.
  return new Uint32Array(indices.filter((index) => index >= 0 && index < width * height));
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

export function selectionBoundsForIndices(indices: ArrayLike<number>, width: number, height: number): GridRect | undefined {
  if (width < 1 || height < 1 || indices.length === 0) return undefined;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let position = 0; position < indices.length; position += 1) {
    const index = indices[position];
    if (!Number.isSafeInteger(index) || index < 0 || index >= width * height) continue;
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

function adjacentIndex(x: number, y: number, width: number, height: number): number | undefined {
  return x < 0 || y < 0 || x >= width || y >= height ? undefined : y * width + x;
}

/**
 * Return every exposed edge, including edges around holes. The tight bounds
 * are used as the flood-fill frame so a boundary can be identified as an
 * exterior edge or an interior (hole) edge without losing concave corners.
 */
export function selectionBoundarySegments(indices: ArrayLike<number>, width: number, height: number): SelectionBoundarySegment[] {
  const valid = Array.from({ length: indices.length }, (_, position) => indices[position])
    .filter((index) => Number.isSafeInteger(index) && index >= 0 && index < width * height)
    .map((index) => Math.floor(index))
    .sort((left, right) => left - right)
    .filter((index, position, sortedValues) => position === 0 || index !== sortedValues[position - 1]);
  const selected = new Set(valid);
  const bounds = selectionBoundsForIndices(valid, width, height);
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
  const values = Array.from({ length: indices.length }, (_, position) => indices[position])
    .filter((index) => Number.isSafeInteger(index) && index >= 0 && index < width * height)
    .map((index) => Math.floor(index))
    .sort((left, right) => left - right)
    .filter((index, position, sortedValues) => position === 0 || index !== sortedValues[position - 1]);
  const sorted = new Uint32Array(values);
  const bounds = selectionBoundsForIndices(sorted, width, height);
  return bounds ? { indices: sorted, bounds, boundaries: selectionBoundarySegments(sorted, width, height) } : undefined;
}

export function selectionRectToIndices(rect: GridRect, width: number, height: number): Uint32Array {
  const indices: number[] = [];
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.min(width, rect.x + rect.width);
  const bottom = Math.min(height, rect.y + rect.height);
  for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) indices.push(y * width + x);
  return new Uint32Array(indices);
}

export function selectionCellRect(rect: GridRect): CellRect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}
