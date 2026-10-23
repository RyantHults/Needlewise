import type { Active, DroppableContainer } from '@dnd-kit/core';
import { describe, expect, it } from 'vitest';
import { pointerWithinOrClosestCenter, snapCenterToPointer } from './dnd-shared';

describe('snapCenterToPointer', () => {
  const rect = { top: 50, left: 100, width: 40, height: 20, right: 140, bottom: 70 };
  const baseArgs = {
    active: null,
    activeNodeRect: null,
    containerNodeRect: null,
    over: null,
    overlayNodeRect: null,
    scrollableAncestors: [],
    scrollableAncestorRects: [],
    windowRect: null
  };

  it('snaps the overlay center to the mouse pointer, offsetting for wherever on the card the drag started', () => {
    const event = new MouseEvent('mousedown', { clientX: 130, clientY: 55 });
    const result = snapCenterToPointer({
      ...baseArgs,
      activatorEvent: event,
      draggingNodeRect: rect,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1 }
    });
    expect(result).toEqual({ x: 10, y: -5, scaleX: 1, scaleY: 1 });
  });

  it('snaps the overlay center to the first touch point', () => {
    const event = new TouchEvent('touchstart', { touches: [{ clientX: 130, clientY: 55 } as Touch] });
    const result = snapCenterToPointer({
      ...baseArgs,
      activatorEvent: event,
      draggingNodeRect: rect,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1 }
    });
    expect(result).toEqual({ x: 10, y: -5, scaleX: 1, scaleY: 1 });
  });

  it('leaves the transform unchanged for a keyboard drag, which has no pointer coordinates', () => {
    const event = new KeyboardEvent('keydown', { code: 'ArrowDown' });
    const transform = { x: 7, y: 9, scaleX: 1, scaleY: 1 };
    const result = snapCenterToPointer({ ...baseArgs, activatorEvent: event, draggingNodeRect: rect, transform });
    expect(result).toBe(transform);
  });

  it('leaves the transform unchanged when there is no dragging node rect yet', () => {
    const event = new MouseEvent('mousedown', { clientX: 130, clientY: 55 });
    const transform = { x: 3, y: 4, scaleX: 1, scaleY: 1 };
    const result = snapCenterToPointer({ ...baseArgs, activatorEvent: event, draggingNodeRect: null, transform });
    expect(result).toBe(transform);
  });

  it('leaves the transform unchanged when there is no activator event', () => {
    const transform = { x: 1, y: 2, scaleX: 1, scaleY: 1 };
    const result = snapCenterToPointer({ ...baseArgs, activatorEvent: null, draggingNodeRect: rect, transform });
    expect(result).toBe(transform);
  });
});

describe('pointerWithinOrClosestCenter', () => {
  const collisionRect = { top: 0, left: 0, width: 10, height: 10, right: 10, bottom: 10 };
  const near = { top: 0, left: 0, width: 10, height: 10, right: 10, bottom: 10 };
  const far = { top: 500, left: 500, width: 10, height: 10, right: 510, bottom: 510 };
  const droppableRects = new Map([['near', near], ['far', far]]);
  const droppableContainers = [{ id: 'near' }, { id: 'far' }] as unknown as DroppableContainer[];
  const active = {} as Active;

  it('uses pointerWithin when pointer coordinates are present, finding nothing when the pointer is over neither rect', () => {
    const result = pointerWithinOrClosestCenter({ active, collisionRect, droppableRects, droppableContainers, pointerCoordinates: { x: 9999, y: 9999 } });
    expect(result).toEqual([]);
  });

  it('uses pointerWithin to find the rect actually under the pointer', () => {
    const result = pointerWithinOrClosestCenter({ active, collisionRect, droppableRects, droppableContainers, pointerCoordinates: { x: 5, y: 5 } });
    expect(result.map((collision) => collision.id)).toEqual(['near']);
  });

  it('falls back to closestCenter without pointer coordinates (a keyboard drag), which always finds a nearest target', () => {
    const result = pointerWithinOrClosestCenter({ active, collisionRect, droppableRects, droppableContainers, pointerCoordinates: null });
    expect(result.map((collision) => collision.id)).toEqual(['near', 'far']);
  });
});
