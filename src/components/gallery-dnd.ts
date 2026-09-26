import { closestCenter, pointerWithin, type CollisionDetection, type Modifier } from '@dnd-kit/core';
import type { ProjectFolder, ProjectFolderAssignment, ProjectMetadata } from '../persistence';

/**
 * Pure, unit-tested drag-and-drop logic for the project gallery. Kept free of
 * React so the move rules, and the small pieces of @dnd-kit composition below,
 * can be tested directly with plain function calls.
 */

export type DragKind = 'project' | 'folder';

export interface ParsedDrag {
  kind: DragKind;
  id: string;
}

export interface MoveTarget {
  kind: DragKind;
  id: string;
  targetFolderId: string | null;
}

export interface MoveContext {
  folders: readonly ProjectFolder[];
  folderAssignments: readonly ProjectFolderAssignment[];
  /** The folder currently being viewed, used to resolve the "up" drop target's parent. */
  currentFolderId: string | null;
}

export interface AnnouncementContext extends MoveContext {
  projects: readonly ProjectMetadata[];
}

const PROJECT_DRAG_PREFIX = 'project:';
const FOLDER_DRAG_PREFIX = 'folder:';
const FOLDER_DROP_PREFIX = 'folder:';

export const UP_DROP_ID = 'up';

export function projectDragId(id: string): string {
  return `${PROJECT_DRAG_PREFIX}${id}`;
}

export function folderDragId(id: string): string {
  return `${FOLDER_DRAG_PREFIX}${id}`;
}

export function folderDropId(id: string): string {
  return `${FOLDER_DROP_PREFIX}${id}`;
}

export function parseDragId(rawId: string): ParsedDrag | null {
  if (rawId.startsWith(PROJECT_DRAG_PREFIX)) return { kind: 'project', id: rawId.slice(PROJECT_DRAG_PREFIX.length) };
  if (rawId.startsWith(FOLDER_DRAG_PREFIX)) return { kind: 'folder', id: rawId.slice(FOLDER_DRAG_PREFIX.length) };
  return null;
}

/**
 * The folder id a drop id represents: `null` for the top level, or
 * `undefined` when the drop id is unrecognized or currently unavailable
 * (e.g. "up" while viewing the top level). Folder cards and the move-up bar
 * are the only drop targets; the breadcrumb is plain navigation.
 */
export function resolveDropFolderId(dropId: string, context: MoveContext): string | null | undefined {
  if (dropId === UP_DROP_ID) {
    if (context.currentFolderId === null) return undefined;
    const currentFolder = context.folders.find((folder) => folder.id === context.currentFolderId);
    return currentFolder ? currentFolder.parentId : undefined;
  }
  if (dropId.startsWith(FOLDER_DROP_PREFIX)) return dropId.slice(FOLDER_DROP_PREFIX.length);
  return undefined;
}

/**
 * Resolves a drag-end (or a candidate drop, for disabled-state rendering)
 * into the move it would perform. Returns null for unrecognized ids,
 * nonexistent targets, and no-ops.
 */
export function resolveMoveTarget(draggedId: string, dropId: string, context: MoveContext): MoveTarget | null {
  const dragged = parseDragId(draggedId);
  if (!dragged) return null;

  const targetFolderId = resolveDropFolderId(dropId, context);
  if (targetFolderId === undefined) return null;
  if (targetFolderId !== null && !context.folders.some((folder) => folder.id === targetFolderId)) return null;

  if (dragged.kind === 'project') {
    const currentFolderId = context.folderAssignments.find((assignment) => assignment.projectId === dragged.id)?.folderId ?? null;
    if (targetFolderId === currentFolderId) return null;
    return { kind: 'project', id: dragged.id, targetFolderId };
  }

  if (targetFolderId === dragged.id) return null;

  const draggedFolder = context.folders.find((folder) => folder.id === dragged.id);
  if (!draggedFolder) return null;
  if (targetFolderId === draggedFolder.parentId) return null;

  if (targetFolderId !== null) {
    const targetFolder = context.folders.find((folder) => folder.id === targetFolderId);
    if (!targetFolder || targetFolder.parentId !== null) return null;
  }

  const hasChildFolders = context.folders.some((folder) => folder.parentId === dragged.id);
  if (hasChildFolders && targetFolderId !== null) return null;

  return { kind: 'folder', id: dragged.id, targetFolderId };
}

export function isValidDropTarget(draggedId: string, dropId: string, context: MoveContext): boolean {
  return resolveMoveTarget(draggedId, dropId, context) !== null;
}

export function describeDraggedName(draggedId: string, context: AnnouncementContext): string {
  const dragged = parseDragId(draggedId);
  if (!dragged) return 'item';
  if (dragged.kind === 'project') return context.projects.find((project) => project.id === dragged.id)?.title ?? 'pattern';
  return context.folders.find((folder) => folder.id === dragged.id)?.name ?? 'folder';
}

export function describeDropTargetName(dropId: string, context: MoveContext): string {
  const folderId = resolveDropFolderId(dropId, context);
  if (folderId === undefined) return '';
  if (folderId === null) return 'Projects';
  return context.folders.find((folder) => folder.id === folderId)?.name ?? 'Projects';
}

/** Pure keyboard-navigation helpers: pick the nearest droppable rect in an arrow direction. */

export type Direction = 'up' | 'down' | 'left' | 'right';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function centerOf(rect: Rect): Point {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

export function pickNextDropTarget<T extends { rect: Rect }>(direction: Direction, from: Point, candidates: readonly T[]): T | null {
  let best: T | null = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const center = centerOf(candidate.rect);
    const dx = center.x - from.x;
    const dy = center.y - from.y;
    const inDirection = direction === 'right' ? dx > 0
      : direction === 'left' ? dx < 0
      : direction === 'down' ? dy > 0
      : dy < 0;
    if (!inDirection) continue;
    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

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
