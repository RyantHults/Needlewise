import type { ProjectFolder, ProjectFolderAssignment, ProjectMetadata } from '../persistence';

/**
 * Pure, unit-tested drag-and-drop logic for the project gallery. Kept free of
 * React so the move rules, and the small pieces of @dnd-kit composition below,
 * can be tested directly with plain function calls.
 */

/** What a drag carries: the selected patterns, or one folder. Drag ids are persistence item keys. */
export type DragSubject = { kind: 'projects'; ids: readonly string[] } | { kind: 'folder'; id: string };

export interface MoveTarget {
  subject: DragSubject;
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

const FOLDER_DROP_PREFIX = 'folder-drop:';
const PROJECT_DROP_PREFIX = 'project-drop:';

export const UP_DROP_ID = 'up';

export function folderDropId(id: string): string {
  return `${FOLDER_DROP_PREFIX}${id}`;
}

export function projectDropId(id: string): string {
  return `${PROJECT_DROP_PREFIX}${id}`;
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
export function resolveMoveTarget(subject: DragSubject, dropId: string, context: MoveContext): MoveTarget | null {
  const targetFolderId = resolveDropFolderId(dropId, context);
  if (targetFolderId === undefined) return null;
  if (targetFolderId !== null && !context.folders.some((folder) => folder.id === targetFolderId)) return null;

  if (subject.kind === 'projects') {
    const alreadyThere = subject.ids.some((id) =>
      (context.folderAssignments.find((assignment) => assignment.projectId === id)?.folderId ?? null) === targetFolderId
    );
    return alreadyThere ? null : { subject, targetFolderId };
  }

  if (targetFolderId === subject.id) return null;

  const draggedFolder = context.folders.find((folder) => folder.id === subject.id);
  if (!draggedFolder) return null;
  if (targetFolderId === draggedFolder.parentId) return null;

  if (targetFolderId !== null) {
    const targetFolder = context.folders.find((folder) => folder.id === targetFolderId);
    if (!targetFolder || targetFolder.parentId !== null) return null;
  }

  const hasChildFolders = context.folders.some((folder) => folder.parentId === subject.id);
  if (hasChildFolders && targetFolderId !== null) return null;

  return { subject, targetFolderId };
}

export interface GroupTarget {
  projectIds: readonly string[];
  targetProjectId: string;
  parentId: string | null;
}

/**
 * Patterns dropped on another pattern in a view that can hold a new folder:
 * the top level or a top-level folder. Returns null otherwise, including when
 * the target is one of the dragged patterns.
 */
export function resolveGroupTarget(subject: DragSubject, dropId: string, context: MoveContext): GroupTarget | null {
  if (subject.kind !== 'projects') return null;
  if (!dropId.startsWith(PROJECT_DROP_PREFIX)) return null;
  const targetProjectId = dropId.slice(PROJECT_DROP_PREFIX.length);
  if (subject.ids.includes(targetProjectId)) return null;
  const parentId = context.currentFolderId;
  if (parentId !== null) {
    const parent = context.folders.find((folder) => folder.id === parentId);
    if (!parent || parent.parentId !== null) return null;
  }
  return { projectIds: subject.ids, targetProjectId, parentId };
}

export function isValidDropTarget(subject: DragSubject, dropId: string, context: MoveContext): boolean {
  return resolveMoveTarget(subject, dropId, context) !== null || resolveGroupTarget(subject, dropId, context) !== null;
}

export function describeSubject(subject: DragSubject, context: AnnouncementContext): string {
  if (subject.kind === 'folder') return context.folders.find((folder) => folder.id === subject.id)?.name ?? 'folder';
  if (subject.ids.length !== 1) return `${subject.ids.length} patterns`;
  const [id] = subject.ids;
  return context.projects.find((project) => project.id === id)?.title ?? 'pattern';
}

export function describeDropTargetName(dropId: string, context: MoveContext): string {
  const folderId = resolveDropFolderId(dropId, context);
  if (folderId === undefined) return '';
  if (folderId === null) return 'Projects';
  return context.folders.find((folder) => folder.id === folderId)?.name ?? 'Projects';
}

/** Pure pointer and keyboard geometry: drop zones on a card, and the nearest drop point in an arrow direction. */

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

export type DropZone = 'before' | 'into' | 'after';

/**
 * Where over a card the pointer sits. With `intoAllowed` the outer quarters
 * are the gaps before and after the card and the middle drops into it;
 * otherwise each half is a gap.
 */
export function resolveDropZone(pointer: Point, rect: Rect, intoAllowed: boolean): DropZone {
  const fraction = (pointer.x - rect.left) / rect.width;
  if (!intoAllowed) return fraction < 0.5 ? 'before' : 'after';
  if (fraction < 0.25) return 'before';
  if (fraction > 0.75) return 'after';
  return 'into';
}

export function containsPoint(rect: Rect, point: Point): boolean {
  return point.x >= rect.left && point.x < rect.left + rect.width && point.y >= rect.top && point.y < rect.top + rect.height;
}

/**
 * A custom-order drag lifts the dragged items out of the level and shows
 * `count` empty slots at `gapIndex` among the rest. The slots are the level's
 * grid cells, measured before the drag, so they stay put while cards slide
 * between them.
 */
export interface GapLayout {
  /** One grid cell per item in the level. */
  slots: readonly Rect[];
  /** How many items the drag leaves in place; `slots.length - count`. */
  restLength: number;
  /** Where the empty slots sit among the remaining items, 0 to `restLength`. */
  gapIndex: number;
  count: number;
}

/** The slot a remaining item is shown in. */
function slotOf(layout: GapLayout, restIndex: number): number {
  return restIndex < layout.gapIndex ? restIndex : restIndex + layout.count;
}

export type GapHit = { kind: 'gap'; gapIndex: number } | { kind: 'into'; restIndex: number };

/**
 * What the pointer is over during a custom-order drag. The empty slots keep
 * the gap; a card's edge moves the gap beside it, and its middle drops into it
 * where that is allowed. Moving the gap puts an empty slot under the pointer,
 * or leaves the card under it with the same edge, so the gap never flips back.
 * The gutters inside the grid keep the gap; outside the grid there is no hit.
 */
export function resolveGapHit(pointer: Point, layout: GapLayout, intoAllowed: (restIndex: number) => boolean): GapHit | null {
  const slot = layout.slots.findIndex((rect) => containsPoint(rect, pointer));
  if (slot === -1) {
    const inside = pointer.x >= Math.min(...layout.slots.map((rect) => rect.left))
      && pointer.x < Math.max(...layout.slots.map((rect) => rect.left + rect.width))
      && pointer.y >= Math.min(...layout.slots.map((rect) => rect.top))
      && pointer.y < Math.max(...layout.slots.map((rect) => rect.top + rect.height));
    return inside ? { kind: 'gap', gapIndex: layout.gapIndex } : null;
  }
  if (slot >= layout.gapIndex && slot < layout.gapIndex + layout.count) return { kind: 'gap', gapIndex: layout.gapIndex };
  const restIndex = slot < layout.gapIndex ? slot : slot - layout.count;
  const zone = resolveDropZone(pointer, layout.slots[slot], intoAllowed(restIndex));
  if (zone === 'into') return { kind: 'into', restIndex };
  return { kind: 'gap', gapIndex: zone === 'before' ? restIndex : restIndex + 1 };
}

/**
 * The keyboard's stops during a custom-order drag: exactly one per gap (the
 * empty slot for the current gap, otherwise the edge of the card it opens
 * before, or after the last card), and the middle of each card that can be
 * dropped into. Each stop resolves through `resolveGapHit` to its own target.
 */
export function gapStops(layout: GapLayout, intoAllowed: (restIndex: number) => boolean): Point[] {
  const stops: Point[] = [];
  for (let gapIndex = 0; gapIndex <= layout.restLength; gapIndex += 1) {
    if (gapIndex === layout.gapIndex) {
      if (layout.count > 0) stops.push(centerOf(layout.slots[layout.gapIndex]));
    } else if (gapIndex < layout.restLength) {
      const rect = layout.slots[slotOf(layout, gapIndex)];
      stops.push({ x: rect.left + 0.1 * rect.width, y: rect.top + rect.height / 2 });
    } else {
      const rect = layout.slots[slotOf(layout, gapIndex - 1)];
      stops.push({ x: rect.left + 0.9 * rect.width, y: rect.top + rect.height / 2 });
    }
  }
  for (let restIndex = 0; restIndex < layout.restLength; restIndex += 1) {
    if (intoAllowed(restIndex)) stops.push(centerOf(layout.slots[slotOf(layout, restIndex)]));
  }
  return stops;
}

export function pickNextPoint(direction: Direction, from: Point, points: readonly Point[]): Point | null {
  let best: Point | null = null;
  let bestDistance = Infinity;
  for (const point of points) {
    const dx = point.x - from.x;
    const dy = point.y - from.y;
    const inDirection = direction === 'right' ? dx > 0
      : direction === 'left' ? dx < 0
      : direction === 'down' ? dy > 0
      : dy < 0;
    if (!inDirection) continue;
    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }
  return best;
}
