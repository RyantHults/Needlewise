import { MAX_PERSISTABLE_CELL_COUNT, isActiveCell, type CanvasEdges, type PatternDocument } from '../domain';
import type { CanvasCellSet, CellRect, ModelPoint } from './contracts';
import { rasterizeFilledOval } from './shapes';

/*
 * Pure geometry for the Canvas-layer tools. Every rect and point is in local
 * cell coordinates (0,0 = the canvas box's top-left), so it may be negative or
 * lie past the box. Gestures collect cells as indices into a workspace frozen
 * at gesture start: `(y - workspace.y) * workspace.width + (x - workspace.x)`.
 */

export type CanvasEdge = keyof CanvasEdges;

/** The local cell under a model point, clamped into the workspace. */
export function clampToWorkspace(point: ModelPoint, workspace: CellRect): ModelPoint {
  return {
    x: Math.min(workspace.x + workspace.width - 1, Math.max(workspace.x, Math.floor(point.x))),
    y: Math.min(workspace.y + workspace.height - 1, Math.max(workspace.y, Math.floor(point.y)))
  };
}

/** True when a local cell is an active canvas cell of `document`. */
export function isActiveCanvasCell(document: Pick<PatternDocument, 'width' | 'height' | 'canvasMask'>, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < document.width && y < document.height && isActiveCell(document, y * document.width + x);
}

/**
 * Add the disk stamp centred on `center` to `into`, clipped to the workspace.
 * Brush size is the disk diameter, as for stitch brushes. `accept` filters
 * cells, so the eraser collects only active ones.
 */
export function stampCanvasBrush(
  into: Set<number>,
  center: ModelPoint,
  size: number,
  workspace: CellRect,
  accept?: (x: number, y: number) => boolean
): void {
  const cellX = Math.floor(center.x);
  const cellY = Math.floor(center.y);
  const radius = size / 2;
  const radiusSquared = radius * radius;
  const minX = Math.max(workspace.x, Math.ceil(cellX - radius));
  const maxX = Math.min(workspace.x + workspace.width - 1, Math.floor(cellX + radius));
  const minY = Math.max(workspace.y, Math.ceil(cellY - radius));
  const maxY = Math.min(workspace.y + workspace.height - 1, Math.floor(cellY + radius));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x - cellX;
      const dy = y - cellY;
      if (dx * dx + dy * dy > radiusSquared || (accept && !accept(x, y))) continue;
      into.add((y - workspace.y) * workspace.width + x - workspace.x);
    }
  }
}

/** The tight local rect and 0/1 bitmap of a set of workspace indices; undefined when empty. */
export function canvasCellSet(indices: Iterable<number>, workspace: CellRect): CanvasCellSet | undefined {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  const cells: number[] = [];
  for (const index of indices) {
    const x = index % workspace.width;
    const y = Math.floor(index / workspace.width);
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
    cells.push(index);
  }
  if (cells.length === 0) return undefined;
  const width = right - left + 1;
  const height = bottom - top + 1;
  const bitmap = new Uint8Array(width * height);
  for (const index of cells) bitmap[(Math.floor(index / workspace.width) - top) * width + index % workspace.width - left] = 1;
  return { rect: { x: workspace.x + left, y: workspace.y + top, width, height }, cells: bitmap };
}

/** The rect from `anchor` to `current` (inclusive cells), as a whole-rect cell set clipped to the workspace. */
export function canvasRectSelection(anchor: ModelPoint, current: ModelPoint, workspace: CellRect): CanvasCellSet | undefined {
  const left = Math.max(workspace.x, Math.min(Math.floor(anchor.x), Math.floor(current.x)));
  const top = Math.max(workspace.y, Math.min(Math.floor(anchor.y), Math.floor(current.y)));
  const right = Math.min(workspace.x + workspace.width, Math.max(Math.floor(anchor.x), Math.floor(current.x)) + 1);
  const bottom = Math.min(workspace.y + workspace.height, Math.max(Math.floor(anchor.y), Math.floor(current.y)) + 1);
  if (right <= left || bottom <= top) return undefined;
  return { rect: { x: left, y: top, width: right - left, height: bottom - top } };
}

/** The filled oval inscribed in the rect from `anchor` to `current` (inclusive cells), as a bitmap cell set clipped to the workspace. */
export function canvasOvalSelection(anchor: ModelPoint, current: ModelPoint, workspace: CellRect): CanvasCellSet | undefined {
  const indices: number[] = [];
  for (const { x, y } of rasterizeFilledOval(anchor, current)) {
    if (x < workspace.x || y < workspace.y || x >= workspace.x + workspace.width || y >= workspace.y + workspace.height) continue;
    indices.push((y - workspace.y) * workspace.width + x - workspace.x);
  }
  return canvasCellSet(indices, workspace);
}

/** True when the local cell belongs to the set. */
export function canvasCellSetContains(set: CanvasCellSet, x: number, y: number): boolean {
  const { rect, cells } = set;
  if (x < rect.x || y < rect.y || x >= rect.x + rect.width || y >= rect.y + rect.height) return false;
  return cells === undefined || cells[(y - rect.y) * rect.width + x - rect.x] === 1;
}

/** The number of cells in the set. */
export function canvasCellSetSize(set: CanvasCellSet): number {
  if (set.cells === undefined) return set.rect.width * set.rect.height;
  let count = 0;
  for (const value of set.cells) count += value;
  return count;
}

/** Mark the set's cells that lie in the workspace with `value` in a workspace-sized flag plane. */
export function markCanvasCellSet(flags: Uint8Array, set: CanvasCellSet, workspace: CellRect, value: 0 | 1): void {
  const { rect, cells } = set;
  for (let y = Math.max(rect.y, workspace.y); y < Math.min(rect.y + rect.height, workspace.y + workspace.height); y += 1) {
    for (let x = Math.max(rect.x, workspace.x); x < Math.min(rect.x + rect.width, workspace.x + workspace.width); x += 1) {
      if (cells === undefined || cells[(y - rect.y) * rect.width + x - rect.x] === 1) flags[(y - workspace.y) * workspace.width + x - workspace.x] = value;
    }
  }
}

/** The set translated by whole cells. */
export function shiftCanvasCellSet(set: CanvasCellSet, dx: number, dy: number): CanvasCellSet {
  return { ...set, rect: { ...set.rect, x: set.rect.x + dx, y: set.rect.y + dy } };
}

/** The `canvas-resize` edges that move one edge outward by `delta` cells (negative shrinks). */
export function canvasEdges(edge: CanvasEdge, delta: number): CanvasEdges {
  return { top: 0, right: 0, bottom: 0, left: 0, [edge]: delta };
}

/** The local box a rectangular canvas of `width`×`height` gets from `edges`. */
export function resizedCanvasBox(width: number, height: number, edges: CanvasEdges): CellRect {
  return { x: 0 - edges.left, y: 0 - edges.top, width: width + edges.left + edges.right, height: height + edges.top + edges.bottom };
}

/**
 * How far an edge drag moves the edge outward, in whole cells: the pointer's
 * model displacement from `start` along the edge's outward normal, rounded.
 * Clamped so the box stays at least one cell, inside the workspace, and within
 * the persistable cell cap.
 */
export function canvasEdgeDragDelta(
  edge: CanvasEdge,
  width: number,
  height: number,
  workspace: CellRect,
  start: ModelPoint,
  current: ModelPoint
): number {
  const horizontal = edge === 'left' || edge === 'right';
  const displacement = edge === 'right' ? current.x - start.x
    : edge === 'left' ? start.x - current.x
      : edge === 'bottom' ? current.y - start.y
        : start.y - current.y;
  const dimension = horizontal ? width : height;
  const other = horizontal ? height : width;
  const room = edge === 'right' ? workspace.x + workspace.width - width
    : edge === 'left' ? -workspace.x
      : edge === 'bottom' ? workspace.y + workspace.height - height
        : -workspace.y;
  const max = Math.min(room, Math.floor(MAX_PERSISTABLE_CELL_COUNT / other) - dimension);
  const min = 1 - dimension;
  const delta = Math.round(displacement);
  return Math.max(min, Math.min(max, delta)) || 0;
}
