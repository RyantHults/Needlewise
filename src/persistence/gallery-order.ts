import { ROOT_LEVEL_ID, type GalleryOrder, type GalleryUndo, type ProjectFolder, type ProjectFolderAssignment, type ProjectMetadata } from './types';

export type ItemKind = 'project' | 'folder';

/** One item shown in a gallery level, keyed for the level's stored order. */
export interface LevelItem {
  key: string;
  createdAt: number;
}

/** The folders, assignments, and visible projects that make up the gallery's levels. */
export interface GalleryLevelData {
  folders: readonly ProjectFolder[];
  assignments: readonly ProjectFolderAssignment[];
  projects: readonly { id: string; createdAt: number }[];
}

/** An item about to leave level `from`. */
export interface LeavingItem {
  key: string;
  from: string;
}

export const MAX_GALLERY_ORDER_KEYS = 10_000;

const PROJECT_PREFIX = 'project:';
const FOLDER_PREFIX = 'folder:';

export function projectItemKey(id: string): string {
  return `${PROJECT_PREFIX}${id}`;
}

export function folderItemKey(id: string): string {
  return `${FOLDER_PREFIX}${id}`;
}

export function parseItemKey(key: string): { kind: ItemKind; id: string } | null {
  if (key.startsWith(PROJECT_PREFIX) && key.length > PROJECT_PREFIX.length) {
    return { kind: 'project', id: key.slice(PROJECT_PREFIX.length) };
  }
  if (key.startsWith(FOLDER_PREFIX) && key.length > FOLDER_PREFIX.length) {
    return { kind: 'folder', id: key.slice(FOLDER_PREFIX.length) };
  }
  return null;
}

/**
 * Items missing from `stored` come first, newest created first, then the
 * stored keys that are still present, in stored order. Stored keys whose item
 * is absent are hidden.
 */
export function arrangeLevel(items: readonly LevelItem[], stored: readonly string[] | undefined): string[] {
  const storedKeys = new Set(stored ?? []);
  const present = new Set(items.map((item) => item.key));
  const newcomers = items
    .filter((item) => !storedKeys.has(item.key))
    .sort((a, b) => b.createdAt - a.createdAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((item) => item.key);
  return [...newcomers, ...(stored ?? []).filter((key) => present.has(key))];
}

/** The folders and projects shown in one level; an assignment to a missing folder counts as top level. */
export function levelItems(levelId: string, data: GalleryLevelData): LevelItem[] {
  const folderIds = new Set(data.folders.map((folder) => folder.id));
  const parentOf = (folder: ProjectFolder) => (folder.parentId !== null && folderIds.has(folder.parentId) ? folder.parentId : ROOT_LEVEL_ID);
  const assigned = new Map<string, string>();
  for (const assignment of data.assignments) {
    if (folderIds.has(assignment.folderId)) assigned.set(assignment.projectId, assignment.folderId);
  }
  return [
    ...data.folders
      .filter((folder) => parentOf(folder) === levelId)
      .map((folder) => ({ key: folderItemKey(folder.id), createdAt: folder.createdAt })),
    ...data.projects
      .filter((project) => (assigned.get(project.id) ?? ROOT_LEVEL_ID) === levelId)
      .map((project) => ({ key: projectItemKey(project.id), createdAt: project.createdAt }))
  ];
}

/**
 * `visible` with every key of `previous` it lacks put back after that key's
 * nearest preceding key from `previous` that is in the result, or at the front.
 */
export function keepHiddenKeys(previous: readonly string[], visible: readonly string[]): string[] {
  const result = [...visible];
  const placed = new Set(visible);
  let anchor: string | null = null;
  for (const key of previous) {
    if (!placed.has(key)) {
      result.splice(anchor === null ? 0 : result.indexOf(anchor) + 1, 0, key);
      placed.add(key);
    }
    anchor = key;
  }
  return result;
}

/** Folders by name, ignoring case and accents, then by id. */
export function compareFolders(left: ProjectFolder, right: ProjectFolder): number {
  return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }) || left.id.localeCompare(right.id);
}

/** Projects most recently modified first, then highest revision, then by id. */
export function compareProjectsByModified(left: Pick<ProjectMetadata, 'id' | 'updatedAt' | 'revision'>, right: Pick<ProjectMetadata, 'id' | 'updatedAt' | 'revision'>): number {
  return right.updatedAt - left.updatedAt || right.revision - left.revision || left.id.localeCompare(right.id);
}

/** The level a project shows in; an assignment to a missing folder counts as top level. */
export function levelOfProject(data: GalleryLevelData, projectId: string): string {
  const folderId = data.assignments.find((assignment) => assignment.projectId === projectId)?.folderId;
  return folderId !== undefined && data.folders.some((folder) => folder.id === folderId) ? folderId : ROOT_LEVEL_ID;
}

/** The level a folder shows in; a missing parent counts as top level. */
export function levelOfFolder(data: GalleryLevelData, folder: ProjectFolder): string {
  return folder.parentId !== null && data.folders.some((parent) => parent.id === folder.parentId) ? folder.parentId : ROOT_LEVEL_ID;
}

export function projectsLeaving(data: GalleryLevelData, projectIds: readonly string[]): LeavingItem[] {
  return projectIds.map((projectId) => ({ key: projectItemKey(projectId), from: levelOfProject(data, projectId) }));
}

/** Each project's assignment before a move, for its undo. */
export function priorAssignments(data: GalleryLevelData, projectIds: readonly string[]): GalleryUndo['assignments'] {
  return projectIds.map((projectId) => ({ projectId, assignment: data.assignments.find((assignment) => assignment.projectId === projectId) ?? null }));
}

export function storedKeys(orders: readonly GalleryOrder[], levelId: string): string[] | undefined {
  return orders.find((order) => order.levelId === levelId)?.keys;
}

function withLevelOrder(orders: readonly GalleryOrder[], levelId: string, keys: string[]): GalleryOrder[] {
  return [...orders.filter((order) => order.levelId !== levelId), { levelId, keys }];
}

/** The level's arranged order with its hidden keys kept, so every shown item has a stored spot. */
function fixedLevelOrder(data: GalleryLevelData, orders: readonly GalleryOrder[], levelId: string): string[] {
  const stored = storedKeys(orders, levelId);
  return keepHiddenKeys(stored ?? [], arrangeLevel(levelItems(levelId, data), stored));
}

/**
 * The stored orders after items leave their levels for `targetLevelId`, or
 * for nowhere when it is null (a trash). Each source level records every
 * leaving key, which then stays as a hidden key; the target forgets the keys so
 * they arrive as newcomers. `data` is the state before the move.
 */
export function ordersAfterLeaving(data: GalleryLevelData, orders: readonly GalleryOrder[], leaving: readonly LeavingItem[], targetLevelId: string | null): GalleryOrder[] {
  const moved = leaving.filter((item) => item.from !== targetLevelId);
  let next = [...orders];
  for (const levelId of new Set(moved.map((item) => item.from))) {
    const stored = storedKeys(next, levelId);
    if (stored === undefined || moved.some((item) => item.from === levelId && !stored.includes(item.key))) {
      next = withLevelOrder(next, levelId, fixedLevelOrder(data, next, levelId));
    }
  }
  const target = targetLevelId === null ? undefined : storedKeys(next, targetLevelId);
  const arriving = new Set(moved.map((item) => item.key));
  if (targetLevelId !== null && target !== undefined && target.some((key) => arriving.has(key))) {
    next = withLevelOrder(next, targetLevelId, target.filter((key) => !arriving.has(key)));
  }
  return next;
}

/** The stored orders with a new folder's key placed immediately before a project's key in the project's level. */
export function ordersTakingSpot(data: GalleryLevelData, orders: readonly GalleryOrder[], levelId: string, projectId: string, folderId: string): GalleryOrder[] {
  const keys = fixedLevelOrder(data, orders, levelId);
  keys.splice(keys.indexOf(projectItemKey(projectId)), 0, folderItemKey(folderId));
  return withLevelOrder(orders, levelId, keys);
}

/**
 * The stored orders after a folder is deleted: its arranged contents take its
 * spot in the parent level, its own row goes, and its key leaves every row.
 */
export function ordersAfterFolderDelete(data: GalleryLevelData, orders: readonly GalleryOrder[], folder: ProjectFolder): GalleryOrder[] {
  const parentLevel = levelOfFolder(data, folder);
  const folderKey = folderItemKey(folder.id);
  const parentStored = storedKeys(orders, parentLevel);
  const contents = arrangeLevel(levelItems(folder.id, data), storedKeys(orders, folder.id));
  const arranged = arrangeLevel(levelItems(parentLevel, data), parentStored).flatMap((key) => (key === folderKey ? contents : [key]));
  const parentKeys = keepHiddenKeys((parentStored ?? []).filter((key) => key !== folderKey), arranged);
  const rest = ordersWithoutKeys(orders.filter((order) => order.levelId !== folder.id), new Set([folderKey]));
  return withLevelOrder(rest, parentLevel, parentKeys);
}

/** The stored orders with `keys` removed from every row. */
export function ordersWithoutKeys(orders: readonly GalleryOrder[], keys: ReadonlySet<string>): GalleryOrder[] {
  return orders.map((order) => (order.keys.some((key) => keys.has(key)) ? { levelId: order.levelId, keys: order.keys.filter((key) => !keys.has(key)) } : order));
}

/**
 * The parent an undo can give back to a folder: the old parent only if it
 * still exists and is top level, and the folder has no subfolders, as
 * moveFolder requires; otherwise the top level.
 */
export function restoredParentId(folders: readonly ProjectFolder[], folderId: string, parentId: string | null): string | null {
  if (parentId === null || parentId === folderId) return null;
  const parent = folders.find((folder) => folder.id === parentId);
  const hasChildren = folders.some((folder) => folder.parentId === folderId);
  return parent !== undefined && parent.parentId === null && !hasChildren ? parent.id : null;
}

export interface GalleryMemberships {
  folders: ProjectFolder[];
  assignments: ProjectFolderAssignment[];
}

/**
 * The folders and assignments after an undo puts its memberships back.
 * Projects not in `projectIds` and folders that no longer exist are skipped,
 * an assignment to a missing folder becomes top level, and the folder the
 * move created is removed, its subfolders moving to its parent. It plans no
 * order change: only the created folder's own order row should be deleted.
 */
export function restoreMemberships(undo: GalleryUndo, current: { folders: readonly ProjectFolder[]; assignments: readonly ProjectFolderAssignment[] }, projectIds: ReadonlySet<string>, now: number): GalleryMemberships {
  const folders = new Map(current.folders.map((folder) => [folder.id, folder]));
  const assignments = new Map(current.assignments.map((assignment) => [assignment.projectId, assignment]));
  for (const { projectId, assignment } of undo.assignments) {
    if (!projectIds.has(projectId)) continue;
    if (assignment === null || !folders.has(assignment.folderId)) assignments.delete(projectId);
    else assignments.set(projectId, { ...assignment });
  }
  for (const { folderId, parentId } of undo.folderParents) {
    const folder = folders.get(folderId);
    if (!folder) continue;
    folders.set(folderId, { ...folder, parentId: restoredParentId([...folders.values()], folderId, parentId), updatedAt: now });
  }
  const created = undo.createdFolderId === null ? undefined : folders.get(undo.createdFolderId);
  if (created) {
    for (const child of folders.values()) {
      if (child.parentId === created.id) folders.set(child.id, { ...child, parentId: created.parentId, updatedAt: now });
    }
    for (const [projectId, assignment] of assignments) if (assignment.folderId === created.id) assignments.delete(projectId);
    folders.delete(created.id);
  }
  return { folders: [...folders.values()], assignments: [...assignments.values()] };
}
