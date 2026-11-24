import type { BeadOrientation, Point, PointStitchRecord, PointStitchStore } from './types';

/** In-memory bytes per point stitch: id, two coordinates, color, completion and orientation. */
export const POINT_STITCH_RECORD_BYTES = Uint32Array.BYTES_PER_ELEMENT * 3 + Uint16Array.BYTES_PER_ELEMENT + Uint8Array.BYTES_PER_ELEMENT * 2;

export function pointStitchStoreBytes(count: number): number {
  return count * POINT_STITCH_RECORD_BYTES;
}

/** A zero-filled store with room for `count` point stitches. */
export function allocatePointStitches(count: number): PointStitchStore {
  return {
    ids: new Uint32Array(count),
    x: new Uint32Array(count),
    y: new Uint32Array(count),
    colors: new Uint16Array(count),
    completed: new Uint8Array(count),
    orientations: new Uint8Array(count)
  };
}

export function clonePointStitches(store: PointStitchStore): PointStitchStore {
  return {
    ids: store.ids.slice(),
    x: store.x.slice(),
    y: store.y.slice(),
    colors: store.colors.slice(),
    completed: store.completed.slice(),
    orientations: store.orientations.slice()
  };
}

export function pointStitchesFromRecords(records: readonly PointStitchRecord[]): PointStitchStore {
  const store = allocatePointStitches(records.length);
  records.forEach((record, index) => {
    store.ids[index] = record.id;
    store.x[index] = record.x;
    store.y[index] = record.y;
    store.colors[index] = record.color;
    store.completed[index] = record.completed ? 1 : 0;
    store.orientations[index] = record.orientation;
  });
  return store;
}

export function readPointStitch(store: PointStitchStore, index: number): PointStitchRecord {
  return { id: store.ids[index], x: store.x[index], y: store.y[index], color: store.colors[index], completed: store.completed[index] !== 0, orientation: store.orientations[index] as BeadOrientation };
}

/** Copies the point stitch at `fromIndex` into `to` at `toIndex`, shifting it by `offset` fixed-point units. */
export function copyPointStitch(from: PointStitchStore, fromIndex: number, to: PointStitchStore, toIndex: number, offset: Point = { x: 0, y: 0 }): void {
  to.ids[toIndex] = from.ids[fromIndex];
  to.x[toIndex] = from.x[fromIndex] + offset.x;
  to.y[toIndex] = from.y[fromIndex] + offset.y;
  to.colors[toIndex] = from.colors[fromIndex];
  to.completed[toIndex] = from.completed[fromIndex];
  to.orientations[toIndex] = from.orientations[fromIndex];
}

/** Identifies a point stitch position; two points with the same key occupy the same place. */
export function pointKey(x: number, y: number): string {
  return `${String(x)},${String(y)}`;
}

/** Storage position of every point stitch, keyed by id. */
export function pointStitchPositionsById(store: PointStitchStore): Map<number, number> {
  const positions = new Map<number, number>();
  for (let index = 0; index < store.ids.length; index += 1) positions.set(store.ids[index], index);
  return positions;
}

/** Whether both stores hold the same point stitches in the same order, completion included. */
export function pointStitchStoresEqual(left: PointStitchStore, right: PointStitchStore): boolean {
  if (!pointStitchPlacementsEqual(left, right)) return false;
  for (let index = 0; index < left.ids.length; index += 1) if (left.completed[index] !== right.completed[index]) return false;
  return true;
}

/**
 * Whether both stores hold the same point stitches in the same order,
 * orientation included, ignoring
 * `completed`. Marks change `completed` through Track's own history, not the
 * editor history, so the editor history's replay checks must not compare it.
 */
export function pointStitchPlacementsEqual(left: PointStitchStore, right: PointStitchStore): boolean {
  if (left.ids.length !== right.ids.length) return false;
  for (let index = 0; index < left.ids.length; index += 1) {
    if (left.ids[index] !== right.ids[index] || left.x[index] !== right.x[index] || left.y[index] !== right.y[index] || left.colors[index] !== right.colors[index] || left.orientations[index] !== right.orientations[index]) return false;
  }
  return true;
}
