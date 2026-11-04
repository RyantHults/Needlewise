import {
  arrangeLevel,
  compareFolders,
  compareProjectsByModified,
  folderItemKey,
  projectItemKey,
  type ProjectFolder,
  type ProjectMetadata
} from '../persistence';

/**
 * Pure ordering logic for the project gallery: the sort preference, the order
 * each sort shows a level in, and the key arithmetic behind reorder drops and
 * range selection.
 */

export type GallerySort = 'modified' | 'opened' | 'created' | 'custom';

export const GALLERY_SORT_OPTIONS: readonly { id: GallerySort; label: string }[] = [
  { id: 'modified', label: 'Recently modified' },
  { id: 'opened', label: 'Recently opened' },
  { id: 'created', label: 'Recently created' },
  { id: 'custom', label: 'Custom' }
];

export const GALLERY_SORT_KEY = 'needlewise-gallery-sort:v1';

export function readGallerySort(storage: Pick<Storage, 'getItem'>): GallerySort {
  try {
    const stored = storage.getItem(GALLERY_SORT_KEY);
    return GALLERY_SORT_OPTIONS.find((option) => option.id === stored)?.id ?? 'modified';
  } catch {
    return 'modified';
  }
}

export function writeGallerySort(storage: Pick<Storage, 'setItem'>, sort: GallerySort): void {
  try {
    storage.setItem(GALLERY_SORT_KEY, sort);
  } catch {
    // The preference is a convenience; a storage that refuses it keeps the default.
  }
}

export type GalleryItem =
  | { kind: 'folder'; key: string; folder: ProjectFolder }
  | { kind: 'project'; key: string; project: ProjectMetadata };

function folderItem(folder: ProjectFolder): GalleryItem {
  return { kind: 'folder', key: folderItemKey(folder.id), folder };
}

function projectItem(project: ProjectMetadata): GalleryItem {
  return { kind: 'project', key: projectItemKey(project.id), project };
}

export function orderGalleryItems(input: {
  sort: GallerySort;
  folders: readonly ProjectFolder[];
  projects: readonly ProjectMetadata[];
  storedOrder: readonly string[] | undefined;
  openedAt: ReadonlyMap<string, number>;
}): GalleryItem[] {
  const { sort, folders, projects, openedAt } = input;
  if (sort === 'custom') {
    const items = [...folders.map(folderItem), ...projects.map(projectItem)];
    const itemByKey = new Map(items.map((item) => [item.key, item]));
    const levelItems = items.map((item) => ({ key: item.key, createdAt: item.kind === 'folder' ? item.folder.createdAt : item.project.createdAt }));
    return arrangeLevel(levelItems, input.storedOrder).flatMap((key) => itemByKey.get(key) ?? []);
  }

  const compareProjects = sort === 'created'
    ? (left: ProjectMetadata, right: ProjectMetadata) => right.createdAt - left.createdAt || left.id.localeCompare(right.id)
    : sort === 'opened'
      ? (left: ProjectMetadata, right: ProjectMetadata) => {
        const leftOpened = openedAt.get(left.id);
        const rightOpened = openedAt.get(right.id);
        if (leftOpened !== undefined && rightOpened !== undefined) return rightOpened - leftOpened || compareProjectsByModified(left, right);
        if (leftOpened !== undefined) return -1;
        if (rightOpened !== undefined) return 1;
        return compareProjectsByModified(left, right);
      }
      : compareProjectsByModified;

  return [
    ...[...folders].sort(compareFolders).map(folderItem),
    ...[...projects].sort(compareProjects).map(projectItem)
  ];
}

/**
 * Moves `block` to the gap at `insertionIndex` (0 to `sequence.length`, counted
 * in the original sequence), keeping the block's own order.
 */
export function insertBlock(sequence: readonly string[], block: readonly string[], insertionIndex: number): string[] {
  const moving = new Set(block);
  const removedBefore = sequence.slice(0, insertionIndex).filter((key) => moving.has(key)).length;
  const remaining = sequence.filter((key) => !moving.has(key));
  const gap = insertionIndex - removedBefore;
  return [...remaining.slice(0, gap), ...block, ...remaining.slice(gap)];
}

/** The ids from the anchor to `id` inclusive, in display order; just `id` when the anchor is gone. */
export function selectRange(orderedIds: readonly string[], anchorId: string, id: string): string[] {
  const anchorIndex = orderedIds.indexOf(anchorId);
  const index = orderedIds.indexOf(id);
  if (anchorIndex === -1 || index === -1) return [id];
  return orderedIds.slice(Math.min(anchorIndex, index), Math.max(anchorIndex, index) + 1);
}
