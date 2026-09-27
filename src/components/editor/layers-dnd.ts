import type { Layer, LayerType } from '../../domain';

/**
 * Pure reorder rules for the layers panel. Kept free of React so the
 * group-only constraint can be tested with plain function calls; the panel
 * wires these into @dnd-kit the same way gallery-dnd.ts does for the gallery.
 *
 * `layers` is always the document order, bottom to top. The panel lists rows
 * top to bottom, so "up" on screen means a higher index here.
 */

type LayerLike = Pick<Layer, 'id' | 'type'>;

export interface LayerMove {
  layerId: number;
  /** Absolute index into `layers` (bottom to top), as `layer-move` expects. */
  toIndex: number;
}

const LAYER_DRAG_PREFIX = 'layer:';

export function layerDragId(id: number): string {
  return `${LAYER_DRAG_PREFIX}${String(id)}`;
}

export function parseLayerDragId(rawId: string | number): number | null {
  if (typeof rawId !== 'string' || !rawId.startsWith(LAYER_DRAG_PREFIX)) return null;
  const id = Number(rawId.slice(LAYER_DRAG_PREFIX.length));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Rows for the panel between the pinned Reference and Canvas rows: top of the stack first. */
export function displayLayerOrder<T extends LayerLike>(layers: readonly T[]): T[] {
  return [...layers].reverse();
}

/**
 * The move a drop of `draggedId` onto `overId` performs, or null when the
 * drop crosses groups, targets something that is not a layer, or is a no-op.
 */
export function resolveLayerMove(layers: readonly LayerLike[], draggedId: string | number, overId: string | number): LayerMove | null {
  const dragged = parseLayerDragId(draggedId);
  const over = parseLayerDragId(overId);
  if (dragged === null || over === null || dragged === over) return null;
  const from = layers.findIndex((layer) => layer.id === dragged);
  const to = layers.findIndex((layer) => layer.id === over);
  if (from < 0 || to < 0) return null;
  if (layers[from]!.type !== layers[to]!.type) return null;
  return { layerId: dragged, toIndex: to };
}

export function isValidLayerDrop(layers: readonly LayerLike[], draggedId: string | number, overId: string | number): boolean {
  return resolveLayerMove(layers, draggedId, overId) !== null;
}

/** One step up or down the panel (keyboard reordering); null at the edge of the layer's group. */
export function stepLayerMove(layers: readonly LayerLike[], layerId: number, direction: 'up' | 'down'): LayerMove | null {
  const from = layers.findIndex((layer) => layer.id === layerId);
  if (from < 0) return null;
  const to = direction === 'up' ? from + 1 : from - 1;
  const neighbor = layers[to];
  if (!neighbor || neighbor.type !== layers[from]!.type) return null;
  return { layerId, toIndex: to };
}

/** Whether a row should render as a drop target while `draggedId` is being dragged. */
export function sharesLayerGroup(layers: readonly LayerLike[], draggedId: string | number | null, type: LayerType): boolean {
  const dragged = draggedId === null ? null : parseLayerDragId(draggedId);
  if (dragged === null) return false;
  return layers.find((layer) => layer.id === dragged)?.type === type;
}
