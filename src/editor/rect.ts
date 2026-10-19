import type { ModelPoint, Rect } from './contracts';

/** The overlap of two half-open rects; undefined when it has no area. */
export function intersectRect(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return undefined;
  return { x, y, width: right - x, height: bottom - y };
}

/** True when both rects are absent or have the same origin and size. */
export function rectsEqual(a: Rect | undefined, b: Rect | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** The tight cell rect of row-major indices into a `width` x `height` grid, skipping invalid ones; undefined when none are valid. */
export function indexBounds(indices: ArrayLike<number>, width: number, height: number): Rect | undefined {
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

/** The cell under `point`, clamped into `bounds`. An empty `bounds` clamps to its origin. */
export function clampCell(point: ModelPoint, bounds: Rect): ModelPoint {
  return {
    x: Math.max(bounds.x, Math.min(bounds.x + bounds.width - 1, Math.floor(point.x))),
    y: Math.max(bounds.y, Math.min(bounds.y + bounds.height - 1, Math.floor(point.y)))
  };
}
