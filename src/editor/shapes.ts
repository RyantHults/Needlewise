import type { ModelPoint, ShapeKind } from './contracts';
import { supercoverLine } from './interpolation';

function cell(point: ModelPoint): ModelPoint {
  return { x: Math.floor(point.x), y: Math.floor(point.y) };
}

function pointKey(point: ModelPoint): string {
  return `${point.x}:${point.y}`;
}

function rowMajorUnique(points: readonly ModelPoint[]): ModelPoint[] {
  const unique = new Map<string, ModelPoint>();
  for (const point of points) unique.set(pointKey(point), point);
  return [...unique.values()].sort((left, right) => left.y - right.y || left.x - right.x);
}

/** Bresenham's integer line walk; diagonal-only neighboring cells are intentional. */
function bresenhamLine(start: ModelPoint, end: ModelPoint): ModelPoint[] {
  let x = Math.floor(start.x);
  let y = Math.floor(start.y);
  const targetX = Math.floor(end.x);
  const targetY = Math.floor(end.y);
  const deltaX = Math.abs(targetX - x);
  const stepX = x < targetX ? 1 : -1;
  const deltaY = -Math.abs(targetY - y);
  const stepY = y < targetY ? 1 : -1;
  let error = deltaX + deltaY;
  const points: ModelPoint[] = [];

  while (true) {
    points.push({ x, y });
    if (x === targetX && y === targetY) break;
    const doubledError = 2 * error;
    if (doubledError >= deltaY) {
      error += deltaY;
      x += stepX;
    }
    if (doubledError <= deltaX) {
      error += deltaX;
      y += stepY;
    }
  }
  return points;
}

function addThinSegment(points: ModelPoint[], start: ModelPoint, end: ModelPoint): void {
  points.push(...bresenhamLine(start, end));
}

function rasterizeRectangle(left: number, top: number, right: number, bottom: number): ModelPoint[] {
  const points: ModelPoint[] = [];
  const topLeft = { x: left, y: top };
  const topRight = { x: right, y: top };
  const bottomRight = { x: right, y: bottom };
  const bottomLeft = { x: left, y: bottom };
  // Preserve the established axis-aligned supercover edge behavior for rectangles.
  points.push(...supercoverLine(topLeft, topRight));
  points.push(...supercoverLine(topRight, bottomRight));
  points.push(...supercoverLine(bottomRight, bottomLeft));
  points.push(...supercoverLine(bottomLeft, topLeft));
  return rowMajorUnique(points);
}

function rasterizeCircle(left: number, top: number, right: number, bottom: number): ModelPoint[] {
  const centerX2 = left + right;
  const centerY2 = top + bottom;
  const radius2 = Math.min(right - left, bottom - top);
  const integralGrid = (centerX2 % 2 === 0) && (centerY2 % 2 === 0) && (radius2 % 2 === 0);
  let x = integralGrid ? radius2 / 2 : radius2;
  let y = 0;
  let error = 0;
  const points: ModelPoint[] = [];

  const cellCoordinates = (doubled: number, centerDoubled: number, min: number, max: number): number[] => {
    if (integralGrid) return doubled >= min && doubled <= max ? [doubled] : [];
    if (doubled % 2 === 0) return [doubled / 2].filter((coordinate) => coordinate >= min && coordinate <= max);
    if (doubled === centerDoubled) {
      return [Math.floor(doubled / 2), Math.ceil(doubled / 2)].filter((coordinate) => coordinate >= min && coordinate <= max);
    }
    const coordinate = doubled < centerDoubled ? Math.floor(doubled / 2) : Math.ceil(doubled / 2);
    return coordinate >= min && coordinate <= max ? [coordinate] : [];
  };
  const addCirclePoint = (pointX: number, pointY: number): void => {
    const xs = cellCoordinates(pointX, centerX2, left, right);
    const ys = cellCoordinates(pointY, centerY2, top, bottom);
    for (const cellX of xs) for (const cellY of ys) points.push({ x: cellX, y: cellY });
  };
  const scaledCenterX = integralGrid ? centerX2 / 2 : centerX2;
  const scaledCenterY = integralGrid ? centerY2 / 2 : centerY2;

  while (x >= y) {
    addCirclePoint(scaledCenterX + x, scaledCenterY + y);
    addCirclePoint(scaledCenterX + y, scaledCenterY + x);
    addCirclePoint(scaledCenterX - y, scaledCenterY + x);
    addCirclePoint(scaledCenterX - x, scaledCenterY + y);
    addCirclePoint(scaledCenterX - x, scaledCenterY - y);
    addCirclePoint(scaledCenterX - y, scaledCenterY - x);
    addCirclePoint(scaledCenterX + y, scaledCenterY - x);
    addCirclePoint(scaledCenterX + x, scaledCenterY - y);

    y += 1;
    if (error <= 0) error += 2 * y + 1;
    if (error > 0) {
      x -= 1;
      error -= 2 * x + 1;
    }
  }
  return rowMajorUnique(points);
}

function rasterizeOval(left: number, top: number, right: number, bottom: number): ModelPoint[] {
  if (left === right || top === bottom) return rowMajorUnique(bresenhamLine({ x: left, y: top }, { x: right, y: bottom }));

  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const radiusX = (right - left) / 2;
  const radiusY = (bottom - top) / 2;
  const points: ModelPoint[] = [];
  const nearestCells = (coordinate: number, min: number, max: number): number[] => {
    const lower = Math.floor(coordinate);
    if (Math.abs(coordinate - lower - 0.5) < 1e-9) {
      return [lower, lower + 1].filter((value) => value >= min && value <= max);
    }
    const nearest = Math.max(min, Math.min(max, Math.round(coordinate)));
    return [nearest];
  };
  const roots = (
    axisCenter: number,
    axisRadius: number,
    offset: number,
    spanCenter: number,
    spanRadius: number,
    min: number,
    max: number
  ): number[] => {
    const normalized = (offset - axisCenter) / axisRadius;
    const remaining = 1 - normalized * normalized;
    if (remaining < -1e-9) return [];
    const halfSpan = spanRadius * Math.sqrt(Math.max(0, remaining));
    return [
      ...nearestCells(spanCenter - halfSpan, min, max),
      ...nearestCells(spanCenter + halfSpan, min, max)
    ];
  };

  let previousLeft: ModelPoint | undefined;
  let previousRight: ModelPoint | undefined;
  for (let y = top; y <= bottom; y += 1) {
    const xs = roots(centerY, radiusY, y, centerX, radiusX, left, right);
    if (xs.length === 0) continue;
    const leftPoint = { x: Math.min(...xs), y };
    const rightPoint = { x: Math.max(...xs), y };
    points.push(leftPoint, rightPoint);
    if (previousLeft) addThinSegment(points, previousLeft, leftPoint);
    if (previousRight) addThinSegment(points, previousRight, rightPoint);
    previousLeft = leftPoint;
    previousRight = rightPoint;
  }

  let previousTop: ModelPoint | undefined;
  let previousBottom: ModelPoint | undefined;
  for (let x = left; x <= right; x += 1) {
    const ys = roots(centerX, radiusX, x, centerY, radiusY, top, bottom);
    if (ys.length === 0) continue;
    const topPoint = { x, y: Math.min(...ys) };
    const bottomPoint = { x, y: Math.max(...ys) };
    points.push(topPoint, bottomPoint);
    if (previousTop) addThinSegment(points, previousTop, topPoint);
    if (previousBottom) addThinSegment(points, previousBottom, bottomPoint);
    previousTop = topPoint;
    previousBottom = bottomPoint;
  }
  return rowMajorUnique(points);
}

function rasterizeTriangle(left: number, top: number, right: number, bottom: number): ModelPoint[] {
  const apex = { x: Math.floor((left + right) / 2), y: top };
  const bottomLeft = { x: left, y: bottom };
  const bottomRight = { x: right, y: bottom };
  const points: ModelPoint[] = [];
  addThinSegment(points, apex, bottomLeft);
  addThinSegment(points, apex, bottomRight);
  addThinSegment(points, bottomLeft, bottomRight);
  return rowMajorUnique(points);
}

function rasterizeRightTriangle(start: ModelPoint, end: ModelPoint): ModelPoint[] {
  const rightAngle = cell(start);
  const endpoint = cell(end);
  const adjacentVertical = { x: endpoint.x, y: rightAngle.y };
  const adjacentHorizontal = { x: rightAngle.x, y: endpoint.y };
  const points: ModelPoint[] = [];
  addThinSegment(points, rightAngle, adjacentVertical);
  addThinSegment(points, rightAngle, adjacentHorizontal);
  addThinSegment(points, adjacentVertical, adjacentHorizontal);
  return rowMajorUnique(points);
}

/**
 * Expand the shorter endpoint delta to produce equal inclusive cell dimensions.
 * A missing direction is resolved positively so drags remain deterministic.
 */
export function constrainShapeEndpoint(start: ModelPoint, end: ModelPoint): ModelPoint {
  const normalizedStart = cell(start);
  const normalizedEnd = cell(end);
  const deltaX = normalizedEnd.x - normalizedStart.x;
  const deltaY = normalizedEnd.y - normalizedStart.y;
  const magnitudeX = Math.abs(deltaX);
  const magnitudeY = Math.abs(deltaY);

  if (magnitudeX === magnitudeY) return normalizedEnd;
  if (magnitudeX > magnitudeY) {
    return {
      x: normalizedEnd.x,
      y: normalizedStart.y + (deltaY < 0 ? -1 : 1) * magnitudeX
    };
  }
  return {
    x: normalizedStart.x + (deltaX < 0 ? -1 : 1) * magnitudeY,
    y: normalizedEnd.y
  };
}

/** Rasterize a shape outline in inclusive normalized cell bounds. */
export function rasterizeShapeOutline(shape: ShapeKind, start: ModelPoint, end: ModelPoint): ModelPoint[] {
  const first = cell(start);
  const second = cell(end);
  const left = Math.min(first.x, second.x);
  const right = Math.max(first.x, second.x);
  const top = Math.min(first.y, second.y);
  const bottom = Math.max(first.y, second.y);

  if (shape === 'line') return rowMajorUnique(bresenhamLine(first, second));
  if (shape === 'rectangle' || shape === 'square') return rasterizeRectangle(left, top, right, bottom);
  if (shape === 'circle') return rasterizeCircle(left, top, right, bottom);
  if (shape === 'oval') return rasterizeOval(left, top, right, bottom);
  if (shape === 'triangle') return rasterizeTriangle(left, top, right, bottom);
  return rasterizeRightTriangle(first, second);
}
