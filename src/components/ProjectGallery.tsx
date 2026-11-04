import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Active,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter
} from '@dnd-kit/core';
import {
  MAX_FOLDER_NAME_CHARS,
  ROOT_LEVEL_ID,
  folderItemKey,
  parseItemKey,
  projectItemKey,
  type GalleryOrder,
  type ProjectFolder,
  type ProjectFolderAssignment,
  type ProjectMetadata,
  type ProjectOpened
} from '../persistence';
import { ProjectThumbnail } from './ProjectThumbnail';
import { NewFolderModal } from './NewFolderModal';
import { MoveToFolderModal } from './MoveToFolderModal';
import { GallerySelectionBar } from './GallerySelectionBar';
import { ConfirmDialog } from './ConfirmDialog';
import { CardActionButton } from './CardActionButton';
import { Icon } from './controls/Icon';
import {
  UP_DROP_ID,
  centerOf,
  containsPoint,
  describeDropTargetName,
  describeSubject,
  folderDropId,
  gapStops,
  isValidDropTarget,
  pickNextPoint,
  projectDropId,
  resolveGapHit,
  resolveGroupTarget,
  resolveMoveTarget,
  type AnnouncementContext,
  type Direction,
  type DragSubject,
  type GapLayout,
  type MoveContext,
  type Point,
  type Rect
} from './gallery-dnd';
import {
  GALLERY_SORT_OPTIONS,
  insertBlock,
  orderGalleryItems,
  readGallerySort,
  selectRange,
  writeGallerySort,
  type GalleryItem,
  type GallerySort
} from './gallery-sort';
import { pointerWithinOrClosestCenter, snapCenterToPointer } from './dnd-shared';
import { useInlineEdit } from './inline-edit';
import { prefersReducedMotion } from './motion';

const DROP_ANIMATION = { duration: 150, easing: 'ease' };

/** A dropped card stays hidden in its slot until the drop lands, so it does not flash back before it leaves. */
const SETTLING_STYLE = { visibility: 'hidden' } as const;

const ARROW_DIRECTIONS: Record<string, Direction> = {
  ArrowRight: 'right',
  ArrowLeft: 'left',
  ArrowDown: 'down',
  ArrowUp: 'up'
};

/** The most thumbnails a group drag's overlay stacks. */
const STACKED_THUMBNAILS = 3;

/**
 * Jumps keyboard-drag focus between drop stops in the arrow direction, instead
 * of the default 25px step: the custom-order stops while a custom drag lays out
 * its gap, otherwise the centre of each enabled droppable. The sensor's
 * coordinates are the dragged rect's top-left, so the rect's centre is what
 * lands on a stop. Before the first step the drag stands at the centre of the
 * card it lifted.
 */
function galleryCoordinateGetter(customStops: () => Point[] | null): KeyboardCoordinateGetter {
  return (event, { currentCoordinates, context }) => {
    const direction = ARROW_DIRECTIONS[event.code];
    if (!direction) return undefined;
    const halfWidth = (context.collisionRect?.width ?? 0) / 2;
    const halfHeight = (context.collisionRect?.height ?? 0) / 2;
    const moved = context.scrollAdjustedTranslate !== null
      && (context.scrollAdjustedTranslate.x !== 0 || context.scrollAdjustedTranslate.y !== 0);
    const from = moved || !context.activeNode
      ? { x: currentCoordinates.x + halfWidth, y: currentCoordinates.y + halfHeight }
      : centerOf(context.activeNode.getBoundingClientRect());
    let points = customStops();
    if (points === null) {
      points = [];
      for (const container of context.droppableContainers.getEnabled()) {
        const rect = context.droppableRects.get(container.id);
        if (rect) points.push(centerOf(rect));
      }
    }
    const next = pickNextPoint(direction, from, points);
    return next ? { x: next.x - halfWidth, y: next.y - halfHeight } : undefined;
  };
}

/** A custom-order drag hit-tests its own gap layout, so dnd-kit picks no target. */
const NO_COLLISIONS: CollisionDetection = () => [];

/** What a custom-order drag is over: the gap, or a card or the up bar to drop into. */
type CustomHit = { kind: 'gap'; gapIndex: number } | { kind: 'drop'; dropId: string };

/** A dragged card leaves the grid in custom order: it keeps its old cell's box, out of flow and unseen, so its slot closes up. */
function liftedStyle(slot: Rect): CSSProperties {
  return { position: 'absolute', left: slot.left, top: slot.top, width: slot.width, height: slot.height, visibility: 'hidden' };
}

/** The card's current transform offset, which is mid-slide when a FLIP animation is running. */
function currentTranslate(node: HTMLElement): Point {
  const transform = getComputedStyle(node).transform;
  if (!transform || transform === 'none' || typeof DOMMatrixReadOnly !== 'function') return { x: 0, y: 0 };
  const matrix = new DOMMatrixReadOnly(transform);
  return { x: matrix.m41, y: matrix.m42 };
}

function dropIdOf(item: GalleryItem): string {
  return item.kind === 'folder' ? folderDropId(item.folder.id) : projectDropId(item.project.id);
}

function itemName(item: GalleryItem): string {
  return item.kind === 'folder' ? item.folder.name : item.project.title;
}

function subjectKeys(subject: DragSubject): string[] {
  return subject.kind === 'folder' ? [folderItemKey(subject.id)] : subject.ids.map(projectItemKey);
}

function isTextEntry(target: EventTarget | null): boolean {
  return target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && target.type === 'text');
}

interface ProjectGalleryProps {
  projects: readonly ProjectMetadata[];
  /** The header's left cell, e.g. the app brand link. */
  brand: React.ReactNode;
  disabled?: boolean;
  onOpen: (project: ProjectMetadata) => void;
  onDelete: (project: ProjectMetadata) => void;
  onDuplicateProjects: (projects: readonly ProjectMetadata[]) => Promise<unknown> | void;
  /** Bulk delete; the card's own Delete keeps `onDelete` and its inline confirm. */
  onDeleteProjects: (projects: readonly ProjectMetadata[]) => Promise<unknown> | void;
  onRenameProject: (project: ProjectMetadata, title: string) => Promise<unknown> | void;
  deleteConfirmId?: string | null;
  onCreate: (button: HTMLButtonElement) => void;
  onImport?: () => void;
  folders?: readonly ProjectFolder[];
  folderAssignments?: readonly ProjectFolderAssignment[];
  galleryOrders?: readonly GalleryOrder[];
  projectOpens?: readonly ProjectOpened[];
  currentFolderId?: string | null;
  onNavigateFolder?: (folderId: string | null) => void;
  onCreateFolder?: (name: string, parentId: string | null) => Promise<unknown> | void;
  onRenameFolder?: (folderId: string, name: string) => Promise<unknown> | void;
  onDeleteFolder?: (folder: ProjectFolder) => void;
  folderDeleteConfirmId?: string | null;
  onMoveProjects?: (projects: readonly ProjectMetadata[], folderId: string | null) => Promise<unknown> | void;
  onMoveFolder?: (folder: ProjectFolder, parentId: string | null) => Promise<unknown> | void;
  onGroupProjects?: (dragged: readonly ProjectMetadata[], target: ProjectMetadata, parentId: string | null) => Promise<unknown> | void;
  onReorder?: (levelId: string, keys: readonly string[]) => Promise<unknown> | void;
}

function editedDate(value: number): string {
  return new Date(value).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  });
}

const FOLDER_PREVIEW_SLOTS = 4;

/** The patterns a folder card previews: the most recently put into a folder first, then the most recently edited. */
function folderPreviewProjects(candidates: readonly ProjectMetadata[], assignedAtByProjectId: ReadonlyMap<string, number>): ProjectMetadata[] {
  return [...candidates].sort((left, right) =>
    (assignedAtByProjectId.get(right.id) ?? 0) - (assignedAtByProjectId.get(left.id) ?? 0)
    || right.updatedAt - left.updatedAt
    || left.id.localeCompare(right.id)
  ).slice(0, FOLDER_PREVIEW_SLOTS);
}

function FolderPreview({ projects }: { projects: readonly ProjectMetadata[] }) {
  if (projects.length < 2) {
    const [only] = projects;
    return <ProjectThumbnail revision={only?.revision} width={only?.width} height={only?.height} thumbnail={only?.thumbnail} />;
  }
  const emptySlots = FOLDER_PREVIEW_SLOTS - projects.length;
  return (
    <span className="project-gallery-folder-grid">
      {projects.map((item) => (
        <ProjectThumbnail key={item.id} revision={item.revision} width={item.width} height={item.height} thumbnail={item.thumbnail} />
      ))}
      {Array.from({ length: emptySlots }, (_, index) => (
        <span key={index} className="project-gallery-folder-grid-empty"><ProjectThumbnail /></span>
      ))}
    </span>
  );
}

function dropStateClassName(dragActive: boolean, dropActive: boolean, isOver: boolean): string {
  if (!dragActive) return '';
  if (!dropActive) return ' project-gallery-drop-disabled';
  return isOver ? ' project-gallery-drop-over' : ' project-gallery-drop-ready';
}


interface UpDropBarProps {
  label: string;
  active: boolean;
  isOver: boolean;
  barRef: React.RefObject<HTMLDivElement | null>;
}

function UpDropBar({ label, active, isOver, barRef }: UpDropBarProps) {
  const { setNodeRef } = useDroppable({ id: UP_DROP_ID, disabled: !active });
  return (
    <div
      ref={(node) => { setNodeRef(node); barRef.current = node; }}
      className={`project-gallery-up-bar${dropStateClassName(true, active, isOver)}`}
      aria-hidden="true"
    >
      <span>{label}</span>
    </div>
  );
}

interface FolderCardProps {
  folder: ProjectFolder;
  disabled: boolean;
  patternCount: number;
  folderCount: number;
  preview: readonly ProjectMetadata[];
  confirming: boolean;
  dragActive: boolean;
  /** Whether the card takes drops at all; in custom order its gaps do even when its middle does not. */
  dropEnabled: boolean;
  /** Whether a drop on the card's middle would move the dragged items into it. */
  intoAllowed: boolean;
  intoOver: boolean;
  /** Hides the card while a drop settles, or lifts it out of the grid during a custom-order drag. */
  style: CSSProperties | undefined;
  nodeRef: (node: HTMLElement | null) => void;
  onNavigateFolder?: (folderId: string | null) => void;
  onRenameFolder?: (folderId: string, name: string) => Promise<unknown> | void;
  onDeleteFolder?: (folder: ProjectFolder) => void;
}

function FolderCard({
  folder,
  disabled,
  patternCount,
  folderCount,
  preview,
  confirming,
  dragActive,
  dropEnabled,
  intoAllowed,
  intoOver,
  style,
  nodeRef,
  onNavigateFolder,
  onRenameFolder,
  onDeleteFolder
}: FolderCardProps) {
  const metadataDescriptionId = useId();
  const renameInputId = useId();
  const { editing: renaming, start: startRename, triggerRef: renameTriggerRef, inputProps: renameInputProps } = useInlineEdit(folder.name, (name) => onRenameFolder?.(folder.id, name));

  const { attributes, listeners, setNodeRef: setDragNodeRef, setActivatorNodeRef, isDragging } = useDraggable({ id: folderItemKey(folder.id), disabled: disabled || renaming });
  const { setNodeRef: setDropNodeRef } = useDroppable({ id: folderDropId(folder.id), disabled: !dropEnabled });

  const meta = `${patternCount} pattern${patternCount === 1 ? '' : 's'}${folderCount > 0 ? ` · ${folderCount} folder${folderCount === 1 ? '' : 's'}` : ''}`;

  const className = [
    'project-gallery-card',
    'project-gallery-folder',
    isDragging && 'project-gallery-dragging',
    dragActive && (intoAllowed || !dropEnabled) && dropStateClassName(dragActive, intoAllowed, intoOver).trim()
  ].filter(Boolean).join(' ');

  return (
    <article
      ref={(node) => { setDragNodeRef(node); setDropNodeRef(node); nodeRef(node); }}
      className={className}
      style={style}
      {...listeners}
    >
      <span className="project-gallery-folder-tab" aria-hidden="true" />
      <button
        className="project-gallery-open"
        type="button"
        disabled={disabled}
        onClick={() => onNavigateFolder?.(folder.id)}
        aria-label={`Open folder ${folder.name}`}
        aria-describedby={metadataDescriptionId}
      >
        <span className="project-gallery-folder-preview">
          <FolderPreview projects={preview} />
        </span>
        <span className="project-gallery-copy">
          <span id={metadataDescriptionId} className="project-gallery-meta">{meta}</span>
        </span>
      </button>
      <div className="project-gallery-title-row">
        {renaming ? (
          <>
            <label className="visually-hidden" htmlFor={renameInputId}>Rename folder {folder.name}</label>
            <input
              id={renameInputId}
              className="project-gallery-title-input"
              maxLength={MAX_FOLDER_NAME_CHARS}
              {...renameInputProps}
            />
          </>
        ) : (
          <button
            ref={renameTriggerRef}
            className="project-gallery-name project-gallery-name-button"
            type="button"
            disabled={disabled || !onRenameFolder}
            aria-label={`Rename ${folder.name}`}
            onClick={startRename}
          >
            {folder.name}
          </button>
        )}
      </div>
      <div className="project-gallery-card-actions">
        <button
          ref={setActivatorNodeRef}
          className="project-gallery-drag-handle"
          type="button"
          disabled={disabled || renaming}
          aria-label={`Drag ${folder.name}`}
          {...attributes}
        >
          <span aria-hidden="true">⠿</span>
        </button>
        {onDeleteFolder && (
          <CardActionButton
            armed={confirming}
            disabled={disabled}
            aria-label={confirming ? `Confirm delete folder ${folder.name}` : `Delete folder ${folder.name}`}
            onClick={() => onDeleteFolder(folder)}
          >
            {confirming ? 'Confirm delete?' : 'Delete'}
          </CardActionButton>
        )}
        <CardActionButton
          disabled={disabled}
          onClick={() => onNavigateFolder?.(folder.id)}
          aria-label={`Open folder: ${folder.name}`}
          aria-describedby={metadataDescriptionId}
        >
          <span aria-hidden="true">Open →</span>
        </CardActionButton>
      </div>
    </article>
  );
}

interface ProjectCardProps {
  project: ProjectMetadata;
  disabled: boolean;
  confirming: boolean;
  selected: boolean;
  /** Carried by a group drag, so dimmed in place with the card being dragged. */
  carried: boolean;
  /** Whether the card takes drops at all; in custom order its gaps do even when its middle does not. */
  dropEnabled: boolean;
  /** Over the card's middle, where a drop groups the dragged patterns with it. */
  groupOver: boolean;
  /** Hides the card while a drop settles, or lifts it out of the grid during a custom-order drag. */
  style: CSSProperties | undefined;
  nodeRef: (node: HTMLElement | null) => void;
  onToggleSelected: (project: ProjectMetadata, range: boolean) => void;
  onOpen: (project: ProjectMetadata) => void;
  onDelete: (project: ProjectMetadata) => void;
  onDuplicateProjects: (projects: readonly ProjectMetadata[]) => Promise<unknown> | void;
  onRenameProject: (project: ProjectMetadata, title: string) => Promise<unknown> | void;
}

function ProjectCard({
  project,
  disabled,
  confirming,
  selected,
  carried,
  dropEnabled,
  groupOver,
  style,
  nodeRef,
  onToggleSelected,
  onOpen,
  onDelete,
  onDuplicateProjects,
  onRenameProject
}: ProjectCardProps) {
  const metadataDescriptionId = useId();
  const renameInputId = useId();
  const { editing: renaming, start: startRename, triggerRef: renameTriggerRef, inputProps: renameInputProps } = useInlineEdit(project.title, (title) => onRenameProject(project, title));
  const { attributes, listeners, setNodeRef: setDragNodeRef, setActivatorNodeRef, isDragging } = useDraggable({ id: projectItemKey(project.id), disabled: disabled || renaming });
  const { setNodeRef: setDropNodeRef } = useDroppable({ id: projectDropId(project.id), disabled: !dropEnabled });

  const size = typeof project.width === 'number' && typeof project.height === 'number'
    && Number.isInteger(project.width) && Number.isInteger(project.height)
    && project.width > 0 && project.height > 0
    ? `${project.width} × ${project.height} stitches`
    : 'Size unavailable';

  const className = [
    'project-gallery-card',
    selected && 'project-gallery-selected',
    (isDragging || carried) && 'project-gallery-dragging',
    groupOver && 'project-gallery-drop-over'
  ].filter(Boolean).join(' ');

  return (
    <article
      ref={(node) => { setDragNodeRef(node); setDropNodeRef(node); nodeRef(node); }}
      className={className}
      style={style}
      {...listeners}
    >
      <input
        className="project-gallery-select"
        type="checkbox"
        checked={selected}
        disabled={disabled}
        aria-label={`Select ${project.title}`}
        onChange={(event) => onToggleSelected(project, (event.nativeEvent as MouseEvent).shiftKey)}
      />
      <button
        className="project-gallery-open"
        type="button"
        disabled={disabled}
        onClick={() => onOpen(project)}
        aria-label={`Open ${project.title}`}
        aria-describedby={metadataDescriptionId}
      >
        <ProjectThumbnail revision={project.revision} width={project.width} height={project.height} thumbnail={project.thumbnail} />
        <span className="project-gallery-copy project-gallery-copy-tight">
          <span id={metadataDescriptionId} className="project-gallery-meta">
            {size} | Edited {editedDate(project.updatedAt)}
          </span>
        </span>
      </button>
      <div className="project-gallery-title-row">
        {renaming ? (
          <>
            <label className="visually-hidden" htmlFor={renameInputId}>Rename pattern {project.title}</label>
            <input
              id={renameInputId}
              className="project-gallery-title-input"
              {...renameInputProps}
            />
          </>
        ) : (
          <button
            ref={renameTriggerRef}
            className="project-gallery-name project-gallery-name-button"
            type="button"
            disabled={disabled}
            aria-label={`Rename ${project.title}`}
            onClick={startRename}
          >
            {project.title}
          </button>
        )}
      </div>
      <div className="project-gallery-card-actions">
        <button
          ref={setActivatorNodeRef}
          className="project-gallery-drag-handle"
          type="button"
          disabled={disabled || renaming}
          aria-label={`Drag ${project.title}`}
          {...attributes}
        >
          <span aria-hidden="true">⠿</span>
        </button>
        <CardActionButton
          disabled={disabled}
          aria-label={`Duplicate ${project.title}`}
          onClick={() => onDuplicateProjects([project])}
        >
          Duplicate
        </CardActionButton>
        <CardActionButton
          armed={confirming}
          disabled={disabled}
          aria-label={confirming ? `Confirm delete ${project.title}` : `Delete ${project.title}`}
          onClick={() => onDelete(project)}
        >
          {confirming ? 'Confirm delete?' : 'Delete'}
        </CardActionButton>
        <CardActionButton
          disabled={disabled}
          onClick={() => onOpen(project)}
          aria-label={`Open pattern: ${project.title}`}
          aria-describedby={metadataDescriptionId}
        >
          <span aria-hidden="true">Open →</span>
        </CardActionButton>
      </div>
    </article>
  );
}

export function ProjectGallery({
  projects,
  disabled = false,
  onOpen,
  onDelete,
  onDuplicateProjects,
  onDeleteProjects,
  onRenameProject,
  deleteConfirmId = null,
  onCreate,
  onImport,
  folders = [],
  folderAssignments = [],
  galleryOrders = [],
  projectOpens = [],
  currentFolderId = null,
  onNavigateFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  folderDeleteConfirmId = null,
  onMoveProjects,
  onMoveFolder,
  onGroupProjects,
  onReorder,
  brand
}: ProjectGalleryProps) {
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [movingSelection, setMovingSelection] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [sort, setSort] = useState<GallerySort>(() => readGallerySort(localStorage));
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [selectionFolderId, setSelectionFolderId] = useState(currentFolderId);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  /** The card or up bar a drop would go into; in custom order, null while over the gap. */
  const [overId, setOverId] = useState<string | null>(null);
  /** The level's grid cells, keyed by the item in each when a custom-order drag starts, relative to the grid. */
  const [dragCells, setDragCells] = useState<{ keys: readonly string[]; cells: ReadonlyMap<string, Rect> } | null>(null);
  /** Cards out of the grid's flow in custom order: while they are dragged, and until an into drop settles. */
  const [liftedCells, setLiftedCells] = useState<ReadonlyMap<string, Rect>>(() => new Map());
  const [gapIndex, setGapIndex] = useState(0);
  /** A dropped custom order, shown until its save settles so the cards do not slide back first. */
  const [pendingOrder, setPendingOrder] = useState<{ levelId: string; keys: readonly string[] } | null>(null);
  const [settlingKeys, setSettlingKeys] = useState<readonly string[]>([]);
  const [reducedMotion] = useState(prefersReducedMotion);
  const lastAnnounced = useRef<string | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const upBarRef = useRef<HTMLDivElement | null>(null);
  const nodesRef = useRef(new Map<string, HTMLElement>());
  const layoutOffsetsRef = useRef(new Map<string, Point & { lifted: boolean }>());
  const customStopsRef = useRef<() => Point[] | null>(() => null);

  // The selection belongs to one folder view.
  if (selectionFolderId !== currentFolderId) {
    setSelectionFolderId(currentFolderId);
    setSelectedIds(new Set());
    setAnchorId(null);
  }

  const custom = sort === 'custom';
  const coordinateGetter = useMemo(() => galleryCoordinateGetter(() => customStopsRef.current()), []);
  const mouseSensor = useSensor(MouseSensor, { activationConstraint: { distance: 6 } });
  const touchSensor = useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } });
  const keyboardSensor = useSensor(KeyboardSensor, { coordinateGetter });
  const sensors = useSensors(mouseSensor, touchSensor, keyboardSensor);

  const folderById = useMemo(() => new Map(folders.map((folder) => [folder.id, folder])), [folders]);
  const currentFolder = currentFolderId ? folderById.get(currentFolderId) ?? null : null;

  const ancestors = useMemo(() => {
    const chain: ProjectFolder[] = [];
    let cursor: ProjectFolder | null = currentFolder;
    while (cursor && cursor.parentId) {
      const parent = folderById.get(cursor.parentId) ?? null;
      if (!parent) break;
      chain.unshift(parent);
      cursor = parent;
    }
    return chain;
  }, [currentFolder, folderById]);

  const projectsById = useMemo(() => new Map(projects.map((item) => [item.id, item])), [projects]);
  const folderIdByProjectId = useMemo(() => {
    const map = new Map<string, string>();
    for (const assignment of folderAssignments) {
      if (projectsById.has(assignment.projectId) && folderById.has(assignment.folderId)) {
        map.set(assignment.projectId, assignment.folderId);
      }
    }
    return map;
  }, [folderAssignments, projectsById, folderById]);
  const assignedAtByProjectId = useMemo(
    () => new Map(folderAssignments.map((assignment) => [assignment.projectId, assignment.assignedAt])),
    [folderAssignments]
  );
  const projectsByFolderId = useMemo(() => {
    const map = new Map<string, ProjectMetadata[]>();
    for (const [projectId, folderId] of folderIdByProjectId) {
      const project = projectsById.get(projectId);
      if (!project) continue;
      const list = map.get(folderId);
      if (list) list.push(project); else map.set(folderId, [project]);
    }
    return map;
  }, [folderIdByProjectId, projectsById]);

  const childFoldersOf = useMemo(() => {
    const map = new Map<string | null, ProjectFolder[]>();
    for (const folder of folders) {
      const list = map.get(folder.parentId);
      if (list) list.push(folder); else map.set(folder.parentId, [folder]);
    }
    return map;
  }, [folders]);

  const openedAt = useMemo(() => new Map(projectOpens.map((open) => [open.projectId, open.openedAt])), [projectOpens]);
  const levelId = currentFolder ? currentFolder.id : ROOT_LEVEL_ID;
  const items = orderGalleryItems({
    sort,
    folders: childFoldersOf.get(currentFolder ? currentFolder.id : null) ?? [],
    projects: currentFolder ? projectsByFolderId.get(currentFolder.id) ?? [] : projects.filter((item) => !folderIdByProjectId.has(item.id)),
    storedOrder: (pendingOrder?.levelId === levelId ? pendingOrder.keys : undefined) ?? galleryOrders.find((order) => order.levelId === levelId)?.keys,
    openedAt
  });
  const visibleProjects = items.flatMap((item) => (item.kind === 'project' ? [item.project] : []));
  const selectedProjects = visibleProjects.filter((project) => selectedIds.has(project.id));

  // A pattern that leaves the view is deselected for good, so it does not come back ticked after an undo.
  if (selectedProjects.length !== selectedIds.size) setSelectedIds(new Set(selectedProjects.map((project) => project.id)));
  if (anchorId !== null && !visibleProjects.some((project) => project.id === anchorId)) setAnchorId(null);

  const canCreateFolderHere = currentFolder === null || currentFolder.parentId === null;
  const newFolderParentId = currentFolder ? currentFolder.id : null;

  const isEmpty = items.length === 0;
  const isTopLevel = currentFolder === null;

  const moveContext: MoveContext = useMemo(() => ({
    folders,
    folderAssignments,
    currentFolderId: currentFolder ? currentFolder.id : null
  }), [folders, folderAssignments, currentFolder]);

  const announceContext: AnnouncementContext = useMemo(() => ({ ...moveContext, projects }), [moveContext, projects]);

  /** What dragging `dragId` carries: every visible selected pattern when it is one of two or more, otherwise just itself. */
  function subjectOf(dragId: string): DragSubject | null {
    const parsed = parseItemKey(dragId);
    if (!parsed) return null;
    if (parsed.kind === 'folder') return { kind: 'folder', id: parsed.id };
    if (selectedIds.has(parsed.id) && selectedProjects.length >= 2) return { kind: 'projects', ids: selectedProjects.map((project) => project.id) };
    return { kind: 'projects', ids: [parsed.id] };
  }

  const activeSubject = activeDragId ? subjectOf(activeDragId) : null;
  const carriedKeys = new Set(activeSubject ? subjectKeys(activeSubject) : []);

  function intoAllowed(dropId: string): boolean {
    return activeSubject !== null && isValidDropTarget(activeSubject, dropId, moveContext);
  }

  /** In custom order every card but the carried ones shows as a target, for its gaps; otherwise only valid targets do. */
  function dropEnabled(item: GalleryItem): boolean {
    if (activeSubject === null) return false;
    return custom ? !carriedKeys.has(item.key) : intoAllowed(dropIdOf(item));
  }

  // During a custom-order drag the carried items leave the level and the rest close up around the gap.
  const rest = items.filter((item) => !carriedKeys.has(item.key));
  const itemKeys = items.map((item) => item.key).join('\n');
  // The cells only describe the level the drag started over; a refresh that changes it mid-drag cancels the drag.
  const dragStale = dragCells !== null && dragCells.keys.join('\n') !== itemKeys;
  const layout: GapLayout | null = custom && activeSubject !== null && dragCells !== null && !dragStale
    ? {
      slots: dragCells.keys.map((key) => dragCells.cells.get(key) as Rect),
      restLength: rest.length,
      gapIndex: Math.min(gapIndex, rest.length),
      count: items.length - rest.length
    }
    : null;
  useEffect(() => {
    // dnd-kit has no call to cancel a drag; every sensor cancels on an Escape keydown, which the selection and dialog handlers ignore without its key.
    if (dragStale) document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true, cancelable: true }));
  }, [dragStale]);

  function restIntoAllowed(restIndex: number): boolean {
    const item = rest[restIndex];
    return item !== undefined && intoAllowed(dropIdOf(item));
  }

  function gridOrigin(): Point {
    const rect = gridRef.current?.getBoundingClientRect();
    return { x: rect?.left ?? 0, y: rect?.top ?? 0 };
  }

  /** What the dragged rect's centre is over during a custom-order drag: the up bar, a card's middle, or the gap. */
  function customHit(active: Active): CustomHit | null {
    const translated = active.rect.current.translated;
    if (!layout || !translated) return null;
    const pointer = centerOf(translated);
    const upBar = upBarRef.current?.getBoundingClientRect();
    if (upBar && intoAllowed(UP_DROP_ID) && containsPoint(upBar, pointer)) return { kind: 'drop', dropId: UP_DROP_ID };
    const origin = gridOrigin();
    const hit = resolveGapHit({ x: pointer.x - origin.x, y: pointer.y - origin.y }, layout, restIntoAllowed);
    if (hit?.kind === 'into') return { kind: 'drop', dropId: dropIdOf(rest[hit.restIndex]) };
    return hit;
  }

  customStopsRef.current = () => {
    if (!layout) return null;
    const origin = gridOrigin();
    const stops = gapStops(layout, restIntoAllowed).map((point) => ({ x: point.x + origin.x, y: point.y + origin.y }));
    const upBar = upBarRef.current?.getBoundingClientRect();
    if (upBar && intoAllowed(UP_DROP_ID)) stops.push(centerOf(upBar));
    return stops;
  };

  /** The order a gap drop would save, or null when it would change nothing. */
  function reorderedKeys(subject: DragSubject, gap: number): string[] | null {
    const arranged = items.map((item) => item.key);
    const block = subjectKeys(subject);
    const remaining = arranged.filter((key) => !block.includes(key));
    const index = gap < remaining.length ? arranged.indexOf(remaining[gap]) : arranged.length;
    const keys = insertBlock(arranged, block, index);
    return keys.every((key, position) => key === arranged[position]) ? null : keys;
  }

  function projectsOf(ids: readonly string[]): ProjectMetadata[] {
    return ids.flatMap((id) => projectsById.get(id) ?? []);
  }

  function groupTargetTitle(subject: DragSubject, dropId: string): string | null {
    const group = resolveGroupTarget(subject, dropId, moveContext);
    return group ? projectsById.get(group.targetProjectId)?.title ?? null : null;
  }

  function describeGap(subject: DragSubject, gap: number): string | undefined {
    const name = describeSubject(subject, announceContext);
    if (gap < rest.length) return `${name} is before ${itemName(rest[gap])}.`;
    const last = rest.at(-1);
    return last ? `${name} is after ${itemName(last)}.` : undefined;
  }

  function describeInto(subject: DragSubject, dropId: string): string | undefined {
    const name = describeSubject(subject, announceContext);
    const groupTitle = groupTargetTitle(subject, dropId);
    if (groupTitle !== null) return `${name} is over ${groupTitle}. Drop to create a folder with both.`;
    const targetName = describeDropTargetName(dropId, announceContext);
    return targetName ? `${name} is over ${targetName}.` : undefined;
  }

  function describeDrop(subject: DragSubject, dropId: string): string {
    const name = describeSubject(subject, announceContext);
    const groupTitle = groupTargetTitle(subject, dropId);
    if (groupTitle !== null) return `Created a folder with ${name} and ${groupTitle}.`;
    if (!resolveMoveTarget(subject, dropId, announceContext)) return `Cancelled moving ${name}.`;
    return `Moved ${name} to ${describeDropTargetName(dropId, announceContext)}.`;
  }

  const announcements: Announcements = {
    onDragStart: ({ active }) => {
      lastAnnounced.current = null;
      const subject = subjectOf(String(active.id));
      return subject ? `Picked up ${describeSubject(subject, announceContext)}.` : undefined;
    },
    onDragOver: ({ active, over }) => {
      const subject = subjectOf(String(active.id));
      return subject && over ? describeInto(subject, String(over.id)) : undefined;
    },
    // A custom-order drag picks no dnd-kit target, so its gap and middle targets are announced as they change.
    onDragMove: ({ active }) => {
      const subject = subjectOf(String(active.id));
      const hit = custom && subject ? customHit(active) : null;
      if (!subject || !hit) return undefined;
      const key = hit.kind === 'gap' ? `gap:${hit.gapIndex}` : hit.dropId;
      if (key === lastAnnounced.current) return undefined;
      lastAnnounced.current = key;
      return hit.kind === 'gap' ? describeGap(subject, hit.gapIndex) : describeInto(subject, hit.dropId);
    },
    onDragEnd: ({ active, over }) => {
      const subject = subjectOf(String(active.id));
      if (!subject) return undefined;
      const name = describeSubject(subject, announceContext);
      if (custom) {
        const hit = customHit(active);
        if (hit?.kind === 'drop') return describeDrop(subject, hit.dropId);
        return hit && reorderedKeys(subject, hit.gapIndex) ? `Moved ${name} to here.` : `Cancelled moving ${name}.`;
      }
      return over ? describeDrop(subject, String(over.id)) : `Cancelled moving ${name}.`;
    },
    onDragCancel: ({ active }) => {
      const subject = subjectOf(String(active.id));
      return subject ? `Cancelled moving ${describeSubject(subject, announceContext)}.` : undefined;
    }
  };

  function handleDragStart(event: DragStartEvent) {
    const key = String(event.active.id);
    setActiveDragId(key);
    const subject = subjectOf(key);
    if (!custom || !subject) return;
    // Layout boxes, which ignore the hover lift and any slide still running.
    const cells = new Map(items.map((item): [string, Rect] => {
      const node = nodesRef.current.get(item.key);
      return [item.key, node ? { left: node.offsetLeft, top: node.offsetTop, width: node.offsetWidth, height: node.offsetHeight } : { left: 0, top: 0, width: 0, height: 0 }];
    }));
    const carried = subjectKeys(subject);
    setDragCells({ keys: items.map((item) => item.key), cells });
    setLiftedCells(new Map(carried.flatMap((carriedKey): [string, Rect][] => {
      const cell = cells.get(carriedKey);
      return cell ? [[carriedKey, cell]] : [];
    })));
    // The gap opens where the lifted card was, among the items that stay.
    const index = items.findIndex((item) => item.key === key);
    setGapIndex(items.slice(0, index).filter((item) => !carried.includes(item.key)).length);
  }

  function handleDragMove(event: DragMoveEvent) {
    if (!custom) return;
    const hit = customHit(event.active);
    if (hit?.kind === 'gap') setGapIndex(hit.gapIndex);
    setOverId(hit?.kind === 'drop' ? hit.dropId : null);
  }

  function handleDragOver(event: DragOverEvent) {
    if (custom) return;
    setOverId(event.over ? String(event.over.id) : null);
  }

  function handleDragEnd(event: DragEndEvent) {
    const subject = subjectOf(String(event.active.id));
    const hit = custom ? customHit(event.active) : event.over ? { kind: 'drop' as const, dropId: String(event.over.id) } : null;
    clearDrag();
    const drop = subject && hit?.kind === 'drop' ? performDrop(subject, hit.dropId) : null;
    if (subject && hit?.kind === 'gap') performReorder(subject, hit.gapIndex);
    if (!subject || drop === null) {
      setLiftedCells(new Map());
      return;
    }
    // Set in the same batch that clears the active drag, so the overlay skips its animation home. In custom order
    // the carried cards stay out of the grid until the drop lands, so the others close up once instead of parting first.
    const keys = subjectKeys(subject);
    setSettlingKeys(keys);
    const settle = () => {
      setSettlingKeys((current) => (current === keys ? [] : current));
      setLiftedCells((current) => (keys.every((key) => current.has(key)) ? new Map() : current));
    };
    void Promise.resolve(drop).then(settle, settle);
  }

  function handleDragCancel() {
    clearDrag();
    setLiftedCells(new Map());
  }

  /** Runs the drop's handler, or returns null when the drop does nothing. */
  function performDrop(subject: DragSubject, dropId: string): Promise<unknown> | void | null {
    const group = resolveGroupTarget(subject, dropId, moveContext);
    if (group) {
      const target = projectsById.get(group.targetProjectId);
      return target && onGroupProjects ? onGroupProjects(projectsOf(group.projectIds), target, group.parentId) : null;
    }
    const target = resolveMoveTarget(subject, dropId, moveContext);
    if (!target) return null;
    if (subject.kind === 'projects') {
      return onMoveProjects ? onMoveProjects(projectsOf(subject.ids), target.targetFolderId) : null;
    }
    const folder = folderById.get(subject.id);
    return folder && onMoveFolder ? onMoveFolder(folder, target.targetFolderId) : null;
  }

  /** Saves the order a gap drop makes, showing it at once; the lifted cards land in their new slots under the overlay. */
  function performReorder(subject: DragSubject, gap: number) {
    const keys = reorderedKeys(subject, gap);
    if (!keys || !onReorder) return;
    const pending = { levelId, keys };
    setPendingOrder(pending);
    const settle = () => setPendingOrder((current) => (current === pending ? null : current));
    void Promise.resolve(onReorder(levelId, keys)).then(settle, settle);
  }

  function clearDrag() {
    setActiveDragId(null);
    setOverId(null);
    setDragCells(null);
  }

  function clearSelection() {
    setSelectedIds(new Set());
    setAnchorId(null);
  }

  function toggleSelected(project: ProjectMetadata, range: boolean) {
    if (range) {
      const ids = selectRange(visibleProjects.map((item) => item.id), anchorId ?? project.id, project.id);
      setSelectedIds((current) => new Set([...current, ...ids]));
      setAnchorId(project.id);
      return;
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(project.id)) next.delete(project.id); else next.add(project.id);
      return next;
    });
    setAnchorId(project.id);
  }

  function changeSort(next: GallerySort) {
    setSort(next);
    writeGallerySort(localStorage, next);
  }

  const hasSelection = selectedProjects.length > 0;
  const dialogOpen = creatingFolder || movingSelection || confirmingDelete;
  const dragging = activeDragId !== null;
  useEffect(() => {
    if (!hasSelection || dialogOpen || dragging) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isTextEntry(event.target)) return;
      clearSelection();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [hasSelection, dialogOpen, dragging]);

  const upBarParentName = describeDropTargetName(UP_DROP_ID, moveContext);
  const upBarLabel = currentFolder ? `↑ Drop here to move out to ${upBarParentName}` : '';

  const activeItem = activeDragId === null ? null : items.find((item) => item.key === activeDragId) ?? null;
  const overInto = activeSubject !== null && overId !== null;
  const groupingOver = overInto && resolveGroupTarget(activeSubject, overId, moveContext) !== null;
  const movingOver = overInto && resolveMoveTarget(activeSubject, overId, moveContext) !== null;
  const carriedProjects = activeSubject?.kind === 'projects' ? projectsOf(activeSubject.ids) : [];

  function nodeRefFor(key: string) {
    return (node: HTMLElement | null) => {
      if (node) nodesRef.current.set(key, node); else nodesRef.current.delete(key);
    };
  }

  /**
   * The grid's children as one keyed list. Lifted cards come first: they are out of flow, so their place in the
   * list does not change the layout, and React never moves the first nodes of a list, so a dragged card keeps its
   * element and its handle keeps focus. The rest follow in order, with the gap's empty slots among them.
   */
  function gridChildren(): { key: string; node: React.ReactNode }[] {
    const lifted = items.flatMap((item) => {
      const cell = liftedCells.get(item.key);
      return custom && cell ? [{ key: `^${item.key}`, node: renderItem(item, liftedStyle(cell)) }] : [];
    });
    const placeholders = layout
      ? Array.from({ length: layout.count }, (_, index) => ({
        key: `gap-${index}`,
        node: <div key={`gap-${index}`} className="project-gallery-placeholder" style={{ minHeight: layout.slots[0]?.height }} aria-hidden="true" />
      }))
      : [];
    const inFlow = items
      .filter((item) => !(custom && liftedCells.has(item.key)))
      .map((item) => ({ key: item.key, node: renderItem(item, settlingKeys.includes(item.key) ? SETTLING_STYLE : undefined) }));
    const gapAt = layout ? layout.gapIndex : inFlow.length;
    return [...lifted, ...inFlow.slice(0, gapAt), ...placeholders, ...inFlow.slice(gapAt)];
  }
  const children = gridChildren();
  const flipSignature = custom ? children.map((child) => child.key).join('\n') : '';

  // Custom order slides cards to their new cells (FLIP): each card that moved in the layout starts from where it was seen and eases home.
  useLayoutEffect(() => {
    if (!flipSignature) {
      layoutOffsetsRef.current = new Map();
      return;
    }
    const previous = layoutOffsetsRef.current;
    const next = new Map<string, Point & { lifted: boolean }>();
    for (const [key, node] of nodesRef.current) {
      const offset = { x: node.offsetLeft, y: node.offsetTop, lifted: liftedCells.has(key) };
      next.set(key, offset);
      const before = previous.get(key);
      if (reducedMotion || !before || before.lifted || offset.lifted) continue;
      if (before.x === offset.x && before.y === offset.y) continue;
      const seen = currentTranslate(node);
      node.style.transition = 'none';
      node.style.transform = `translate(${before.x + seen.x - offset.x}px, ${before.y + seen.y - offset.y}px)`;
      void node.offsetWidth;
      node.style.transition = '';
      node.style.transform = '';
    }
    layoutOffsetsRef.current = next;
  }, [flipSignature]);

  function renderItem(item: GalleryItem, style: CSSProperties | undefined) {
    const dropId = dropIdOf(item);
    const intoOver = overId === dropId;
    if (item.kind === 'folder') {
      const { folder } = item;
      const children = childFoldersOf.get(folder.id) ?? [];
      const scopedFolderIds = [folder.id, ...children.map((child) => child.id)];
      const scopedProjects = scopedFolderIds.flatMap((id) => projectsByFolderId.get(id) ?? []);
      return (
        <FolderCard
          key={item.key}
          folder={folder}
          disabled={disabled}
          patternCount={scopedProjects.length}
          folderCount={children.length}
          preview={folderPreviewProjects(scopedProjects, assignedAtByProjectId)}
          confirming={folderDeleteConfirmId === folder.id}
          dragActive={activeSubject !== null}
          dropEnabled={dropEnabled(item)}
          intoAllowed={intoAllowed(dropId)}
          intoOver={intoOver}
          style={style}
          nodeRef={nodeRefFor(item.key)}
          onNavigateFolder={onNavigateFolder}
          onRenameFolder={onRenameFolder}
          onDeleteFolder={onDeleteFolder}
        />
      );
    }
    const { project } = item;
    return (
      <ProjectCard
        key={item.key}
        project={project}
        disabled={disabled}
        confirming={deleteConfirmId === project.id}
        selected={selectedIds.has(project.id)}
        carried={carriedKeys.size > 1 && carriedKeys.has(item.key)}
        dropEnabled={dropEnabled(item)}
        groupOver={intoOver && intoAllowed(dropId)}
        style={style}
        nodeRef={nodeRefFor(item.key)}
        onToggleSelected={toggleSelected}
        onOpen={onOpen}
        onDelete={onDelete}
        onDuplicateProjects={onDuplicateProjects}
        onRenameProject={onRenameProject}
      />
    );
  }

  function groupDragLabel(count: number): string {
    if (groupingOver && overId !== null) return `Create folder with ${groupTargetTitle(activeSubject as DragSubject, overId)} (${count + 1})`;
    if (movingOver && overId === UP_DROP_ID) return `Move ${count} out to ${upBarParentName}`;
    if (movingOver && overId !== null) return `Move ${count} to ${describeDropTargetName(overId, moveContext)}`;
    return `${count} patterns`;
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={custom ? NO_COLLISIONS : pointerWithinOrClosestCenter}
      accessibility={{ announcements }}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <section className="project-gallery" aria-labelledby="projects-title">
        <header className="project-gallery-header">
          <div className="project-gallery-brand">{brand}</div>
          <div className="project-gallery-heading">
            {currentFolder && (
              <nav className="project-gallery-breadcrumb" aria-label="Folder breadcrumb">
                <button type="button" onClick={() => onNavigateFolder?.(null)}>Projects</button>
                {ancestors.map((ancestor) => (
                  <span key={ancestor.id}>
                    <span aria-hidden="true"> › </span>
                    <button type="button" onClick={() => onNavigateFolder?.(ancestor.id)}>{ancestor.name}</button>
                  </span>
                ))}
                <span aria-hidden="true"> › </span>
                <span>{currentFolder.name}</span>
              </nav>
            )}
            <h1 id="projects-title">{currentFolder ? currentFolder.name : 'Projects'}</h1>
          </div>
        </header>

        {!(isTopLevel && isEmpty) && (
          <div className="project-gallery-toolbar">
            <select
              className="project-gallery-sort"
              aria-label="Sort patterns"
              value={sort}
              onChange={(event) => changeSort(event.target.value as GallerySort)}
            >
              {GALLERY_SORT_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
            <div className="project-gallery-actions">
              {onCreateFolder && canCreateFolderHere && (
                <button className="button button-secondary" type="button" disabled={disabled} onClick={() => setCreatingFolder(true)}>
                  New folder
                </button>
              )}
              {onImport && (
                <button className="button button-secondary" type="button" disabled={disabled} onClick={onImport}>
                  Import Pattern
                </button>
              )}
              <button className="button button-primary" type="button" disabled={disabled} onClick={(event) => onCreate(event.currentTarget)}>
                <span aria-hidden="true">＋</span> New Pattern
              </button>
            </div>
          </div>
        )}

        {onCreateFolder && creatingFolder && (
          <NewFolderModal
            parentName={currentFolder ? currentFolder.name : null}
            busy={disabled}
            onSubmit={(name) => { onCreateFolder(name, newFolderParentId); setCreatingFolder(false); }}
            onClose={() => setCreatingFolder(false)}
          />
        )}

        {hasSelection && (
          <GallerySelectionBar
            count={selectedProjects.length}
            disabled={disabled}
            onSelectAll={() => setSelectedIds(new Set(visibleProjects.map((project) => project.id)))}
            onMove={() => setMovingSelection(true)}
            onDuplicate={() => {
              clearSelection();
              void onDuplicateProjects(selectedProjects);
            }}
            onDelete={() => setConfirmingDelete(true)}
            onClear={clearSelection}
          />
        )}

        {movingSelection && hasSelection && (
          <MoveToFolderModal
            folders={folders}
            currentFolderId={currentFolder ? currentFolder.id : null}
            onSelect={(folderId) => {
              setMovingSelection(false);
              clearSelection();
              void onMoveProjects?.(selectedProjects, folderId);
            }}
            onClose={() => setMovingSelection(false)}
          />
        )}

        {confirmingDelete && hasSelection && (
          <ConfirmDialog
            title={`Delete ${selectedProjects.length} pattern${selectedProjects.length === 1 ? '' : 's'}?`}
            message="You can undo this from the notice that follows."
            confirmLabel="Delete"
            onConfirm={() => {
              setConfirmingDelete(false);
              clearSelection();
              void onDeleteProjects(selectedProjects);
            }}
            onCancel={() => setConfirmingDelete(false)}
          />
        )}

        {activeDragId && currentFolder && (
          <UpDropBar label={upBarLabel} active={intoAllowed(UP_DROP_ID)} isOver={overId === UP_DROP_ID} barRef={upBarRef} />
        )}

        {isTopLevel && isEmpty ? (
          <div className="project-gallery-empty project-gallery-empty-start" role="status">
            <h2>Your canvas is ready</h2>
            <p>Start a new pattern from scratch or an image, or import a PDF pattern.</p>
            <div className="project-gallery-start-actions">
              <button className="button button-primary project-gallery-start-button" type="button" disabled={disabled} onClick={(event) => onCreate(event.currentTarget)}>
                <span aria-hidden="true">＋</span> New Pattern
              </button>
              {onImport && (
                <button className="button button-secondary project-gallery-start-button" type="button" disabled={disabled} onClick={onImport}>
                  Import Pattern
                </button>
              )}
            </div>
          </div>
        ) : !isTopLevel && isEmpty ? (
          <div className="project-gallery-empty project-gallery-folder-empty" role="status">
            <p>This folder is empty. Drag patterns here, or create a new pattern.</p>
          </div>
        ) : (
          <div ref={gridRef} className={`project-gallery-grid${hasSelection ? ' project-gallery-selecting' : ''}`}>
            {children.map((child) => child.node)}
          </div>
        )}
      </section>
      <DragOverlay dropAnimation={reducedMotion || settlingKeys.length > 0 ? null : DROP_ANIMATION} modifiers={[snapCenterToPointer]}>
        {activeSubject && (
          <div className="project-gallery-drag-preview" aria-hidden="true">
            {carriedProjects.length > 1 ? (
              <>
                <span className="project-gallery-drag-stack">
                  {carriedProjects.slice(0, STACKED_THUMBNAILS).map((item) => (
                    <ProjectThumbnail key={item.id} revision={item.revision} width={item.width} height={item.height} thumbnail={item.thumbnail} />
                  ))}
                  <span className="project-gallery-drag-count">{carriedProjects.length}</span>
                </span>
                <span className="project-gallery-drag-preview-name">{groupDragLabel(carriedProjects.length)}</span>
              </>
            ) : groupingOver || (movingOver && activeSubject.kind === 'projects' && overId !== UP_DROP_ID) ? (
              <>
                <span className="project-gallery-drag-preview-folder-mark" aria-hidden="true"><Icon name="folder" /></span>
                <span className="project-gallery-drag-preview-name">{groupingOver ? 'Create folder' : 'Add to folder'}</span>
              </>
            ) : activeItem?.kind === 'project' ? (
              <>
                <ProjectThumbnail
                  revision={activeItem.project.revision}
                  width={activeItem.project.width}
                  height={activeItem.project.height}
                  thumbnail={activeItem.project.thumbnail}
                />
                <span className="project-gallery-drag-preview-name">{activeItem.project.title}</span>
              </>
            ) : activeItem?.kind === 'folder' ? (
              <>
                <span className="project-gallery-drag-preview-folder-mark" aria-hidden="true"><Icon name="folder" /></span>
                <span className="project-gallery-drag-preview-name">{activeItem.folder.name}</span>
              </>
            ) : null}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
