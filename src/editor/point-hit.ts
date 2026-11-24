import { FIXED_POINT_UNITS_PER_CELL, type PointStitchStore } from '../domain';
import type { ModelPoint } from './contracts';

/** Distance in cells from `point` to the segment `start`–`end`. */
export function distanceToSegment(point: ModelPoint, start: ModelPoint, end: ModelPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const projection = Math.min(1, Math.max(0, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + projection * dx), point.y - (start.y + projection * dy));
}

function pointModel(store: PointStitchStore, position: number): ModelPoint {
  return { x: store.x[position] / FIXED_POINT_UNITS_PER_CELL, y: store.y[position] / FIXED_POINT_UNITS_PER_CELL };
}

/**
 * Storage position of the knot or bead nearest `point` within `tolerance`
 * cells, among those `accept` allows; undefined when none is that close.
 */
export function nearestPointStitch(store: PointStitchStore, point: ModelPoint, tolerance: number, accept: (position: number) => boolean = () => true): number | undefined {
  let best: { position: number; distance: number } | undefined;
  for (let position = 0; position < store.ids.length; position += 1) {
    if (!accept(position)) continue;
    const at = pointModel(store, position);
    const distance = Math.hypot(point.x - at.x, point.y - at.y);
    if (distance <= tolerance && (!best || distance < best.distance)) best = { position, distance };
  }
  return best?.position;
}

/** Add the ids of the knots and beads within `radius` cells of the path `from`→`to`. */
export function pointStitchesNearPath(store: PointStitchStore, from: ModelPoint, to: ModelPoint, radius: number, into: Set<number>): void {
  for (let position = 0; position < store.ids.length; position += 1) {
    if (distanceToSegment(pointModel(store, position), from, to) <= radius) into.add(store.ids[position]);
  }
}

