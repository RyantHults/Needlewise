import { closestCenter, pointerWithin, type CollisionDetection, type Modifier } from '@dnd-kit/core';
import type { Point } from './gallery-dnd';

/** Reads client coordinates from a Mouse/Pointer event, or the first touch of a Touch event. `null` for anything else (a KeyboardEvent). */
function pointerCoordinatesFromEvent(event: Event): Point | null {
  if (typeof TouchEvent !== 'undefined' && event instanceof TouchEvent) {
    const touch = event.touches[0] ?? event.changedTouches[0];
    return touch ? { x: touch.clientX, y: touch.clientY } : null;
  }
  // PointerEvent extends MouseEvent, so this also covers pointer-activated drags.
  if (typeof MouseEvent !== 'undefined' && event instanceof MouseEvent) {
    return { x: event.clientX, y: event.clientY };
  }
  return null;
}

/**
 * Equivalent to @dnd-kit/modifiers' snapCenterToCursor, written locally to
 * avoid adding a dependency. DragOverlay otherwise keeps the grabbed card's
 * own top-left origin, so wherever on the card the drag started, the compact
 * overlay preview ends up offset from the pointer instead of centered on it.
 * A keyboard drag has no pointer coordinates, so the transform passes through
 * unchanged and keeps the rect-jump behavior from the coordinate getter.
 */
export const snapCenterToPointer: Modifier = ({ transform, activatorEvent, draggingNodeRect }) => {
  if (!draggingNodeRect || !activatorEvent) return transform;
  const pointer = pointerCoordinatesFromEvent(activatorEvent);
  if (!pointer) return transform;
  return {
    ...transform,
    x: transform.x + (pointer.x - draggingNodeRect.left) - draggingNodeRect.width / 2,
    y: transform.y + (pointer.y - draggingNodeRect.top) - draggingNodeRect.height / 2
  };
};

/**
 * Resolves the drop target under the pointer during a mouse/touch drag, so it
 * matches what snapCenterToPointer shows the user. Falls back to closestCenter
 * when there are no pointer coordinates (a keyboard drag).
 */
export const pointerWithinOrClosestCenter: CollisionDetection = (args) =>
  args.pointerCoordinates ? pointerWithin(args) : closestCenter(args);
