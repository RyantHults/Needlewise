import { describe, expect, it } from 'vitest';
import {
  displayLayerOrder,
  isValidLayerDrop,
  layerDragId,
  parseLayerDragId,
  resolveLayerMove,
  sharesLayerGroup,
  stepLayerMove,
} from './layers-dnd';

// Bottom to top: three stitch layers, then two specialty layers.
const layers = [
  { id: 1, type: 'stitch' as const },
  { id: 3, type: 'stitch' as const },
  { id: 4, type: 'stitch' as const },
  { id: 2, type: 'specialty' as const },
  { id: 5, type: 'specialty' as const },
];

describe('layers-dnd', () => {
  it('round-trips drag ids and rejects foreign ids', () => {
    expect(parseLayerDragId(layerDragId(7))).toBe(7);
    expect(parseLayerDragId('project:7')).toBeNull();
    expect(parseLayerDragId('layer:abc')).toBeNull();
    expect(parseLayerDragId(7)).toBeNull();
  });

  it('lists the top of the stack first', () => {
    expect(displayLayerOrder(layers).map((layer) => layer.id)).toEqual([5, 2, 4, 3, 1]);
  });

  it('moves a layer to the drop target position within its own group', () => {
    expect(resolveLayerMove(layers, layerDragId(1), layerDragId(4))).toEqual({ layerId: 1, toIndex: 2 });
    expect(resolveLayerMove(layers, layerDragId(4), layerDragId(1))).toEqual({ layerId: 4, toIndex: 0 });
    expect(resolveLayerMove(layers, layerDragId(5), layerDragId(2))).toEqual({ layerId: 5, toIndex: 3 });
  });

  it('refuses drops across groups, onto itself, or onto unknown rows', () => {
    expect(resolveLayerMove(layers, layerDragId(4), layerDragId(2))).toBeNull();
    expect(resolveLayerMove(layers, layerDragId(2), layerDragId(1))).toBeNull();
    expect(resolveLayerMove(layers, layerDragId(3), layerDragId(3))).toBeNull();
    expect(resolveLayerMove(layers, layerDragId(3), 'canvas')).toBeNull();
    expect(resolveLayerMove(layers, layerDragId(99), layerDragId(3))).toBeNull();
    expect(isValidLayerDrop(layers, layerDragId(1), layerDragId(5))).toBe(false);
    expect(isValidLayerDrop(layers, layerDragId(1), layerDragId(3))).toBe(true);
  });

  it('steps one row at a time and stops at the edge of the group', () => {
    expect(stepLayerMove(layers, 3, 'up')).toEqual({ layerId: 3, toIndex: 2 });
    expect(stepLayerMove(layers, 3, 'down')).toEqual({ layerId: 3, toIndex: 0 });
    expect(stepLayerMove(layers, 4, 'up')).toBeNull();
    expect(stepLayerMove(layers, 1, 'down')).toBeNull();
    expect(stepLayerMove(layers, 2, 'down')).toBeNull();
    expect(stepLayerMove(layers, 5, 'up')).toBeNull();
  });

  it('only highlights rows in the dragged layer group', () => {
    expect(sharesLayerGroup(layers, layerDragId(3), 'stitch')).toBe(true);
    expect(sharesLayerGroup(layers, layerDragId(3), 'specialty')).toBe(false);
    expect(sharesLayerGroup(layers, null, 'stitch')).toBe(false);
  });
});
