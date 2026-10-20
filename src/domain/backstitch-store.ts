import type { BackstitchRecord, BackstitchStore, Point } from './types';

/** In-memory bytes per backstitch: id, four endpoint coordinates, color and completion. */
export const BACKSTITCH_RECORD_BYTES = Uint32Array.BYTES_PER_ELEMENT * 5 + Uint16Array.BYTES_PER_ELEMENT + Uint8Array.BYTES_PER_ELEMENT;

export function backstitchStoreBytes(count: number): number {
  return count * BACKSTITCH_RECORD_BYTES;
}

/** A zero-filled store with room for `count` backstitches. */
export function allocateBackstitches(count: number): BackstitchStore {
  return {
    ids: new Uint32Array(count),
    x1: new Uint32Array(count),
    y1: new Uint32Array(count),
    x2: new Uint32Array(count),
    y2: new Uint32Array(count),
    colors: new Uint16Array(count),
    completed: new Uint8Array(count)
  };
}

export function cloneBackstitches(store: BackstitchStore): BackstitchStore {
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

export function backstitchesFromRecords(records: readonly BackstitchRecord[]): BackstitchStore {
  const store = allocateBackstitches(records.length);
  records.forEach((record, index) => {
    store.ids[index] = record.id;
    store.x1[index] = record.x1;
    store.y1[index] = record.y1;
    store.x2[index] = record.x2;
    store.y2[index] = record.y2;
    store.colors[index] = record.color;
    store.completed[index] = record.completed ? 1 : 0;
  });
  return store;
}

export function readBackstitch(store: BackstitchStore, index: number): BackstitchRecord {
  const start = { x: store.x1[index], y: store.y1[index] };
  const end = { x: store.x2[index], y: store.y2[index] };
  return { id: store.ids[index], x1: start.x, y1: start.y, x2: end.x, y2: end.y, start, end, color: store.colors[index], completed: store.completed[index] !== 0 };
}

/** Copies the backstitch at `fromIndex` into `to` at `toIndex`, shifting its endpoints by `offset` fixed-point units. */
export function copyBackstitch(from: BackstitchStore, fromIndex: number, to: BackstitchStore, toIndex: number, offset: Point = { x: 0, y: 0 }): void {
  to.ids[toIndex] = from.ids[fromIndex];
  to.x1[toIndex] = from.x1[fromIndex] + offset.x;
  to.y1[toIndex] = from.y1[fromIndex] + offset.y;
  to.x2[toIndex] = from.x2[fromIndex] + offset.x;
  to.y2[toIndex] = from.y2[fromIndex] + offset.y;
  to.colors[toIndex] = from.colors[fromIndex];
  to.completed[toIndex] = from.completed[fromIndex];
}

/** The endpoint planes a store and a fragment's backstitches share. */
export type BackstitchEndpoints = Pick<BackstitchStore, 'x1' | 'y1' | 'x2' | 'y2'>;

/** Identifies a segment by its endpoints; two lines with the same key are duplicates. */
export function segmentKey(store: BackstitchEndpoints, index: number): string {
  return `${String(store.x1[index])},${String(store.y1[index])},${String(store.x2[index])},${String(store.y2[index])}`;
}

/** `segmentKey` for a segment given by its endpoints; both forms produce the same key. */
export function pointsSegmentKey(start: Point, end: Point): string {
  return `${String(start.x)},${String(start.y)},${String(end.x)},${String(end.y)}`;
}

/** Storage position of every backstitch, keyed by id. */
export function positionsById(store: BackstitchStore): Map<number, number> {
  const positions = new Map<number, number>();
  for (let index = 0; index < store.ids.length; index += 1) positions.set(store.ids[index], index);
  return positions;
}

/** Whether both stores hold the same backstitches in the same order, completion included. */
export function backstitchStoresEqual(left: BackstitchStore, right: BackstitchStore): boolean {
  if (!backstitchLinesEqual(left, right)) return false;
  for (let index = 0; index < left.ids.length; index += 1) if (left.completed[index] !== right.completed[index]) return false;
  return true;
}

/**
 * Whether both stores hold the same backstitches in the same order, ignoring
 * `completed`. Marks change `completed` through Track's own history, not the
 * editor history, so the editor history's replay checks must not compare it.
 */
export function backstitchLinesEqual(left: BackstitchStore, right: BackstitchStore): boolean {
  if (left.ids.length !== right.ids.length) return false;
  for (let index = 0; index < left.ids.length; index += 1) {
    if (left.ids[index] !== right.ids[index] || left.x1[index] !== right.x1[index] || left.y1[index] !== right.y1[index] || left.x2[index] !== right.x2[index] || left.y2[index] !== right.y2[index] || left.colors[index] !== right.colors[index]) return false;
  }
  return true;
}
