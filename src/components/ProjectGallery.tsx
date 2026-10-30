import { useId, useMemo, useState } from 'react';
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
  type Announcements,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter
} from '@dnd-kit/core';
import { MAX_FOLDER_NAME_CHARS, type ProjectFolder, type ProjectFolderAssignment, type ProjectMetadata } from '../persistence';
import { ProjectThumbnail } from './ProjectThumbnail';
import { NewFolderModal } from './NewFolderModal';
import { CardActionButton } from './CardActionButton';
import {
  UP_DROP_ID,
  centerOf,
  describeDraggedName,
  describeDropTargetName,
  folderDragId,
  folderDropId,
  isValidDropTarget,
  parseDragId,
  pickNextDropTarget,
  projectDragId,
  projectDropId,
  resolveGroupTarget,
  resolveMoveTarget,
  type AnnouncementContext,
  type Direction,
  type MoveContext,
  type Rect
} from './gallery-dnd';
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

/** Jumps keyboard-drag focus between droppable rects in the arrow direction, instead of the default 25px step. */
const galleryCoordinateGetter: KeyboardCoordinateGetter = (event, { currentCoordinates, context }) => {
  const direction = ARROW_DIRECTIONS[event.code];
  if (!direction) return undefined;
  const candidates: { id: string; rect: Rect }[] = [];
  for (const container of context.droppableContainers.getEnabled()) {
    const rect = context.droppableRects.get(container.id);
    if (rect) candidates.push({ id: String(container.id), rect });
  }
  const next = pickNextDropTarget(direction, currentCoordinates, candidates);
  return next ? centerOf(next.rect) : undefined;
};

interface ProjectGalleryProps {
  projects: readonly ProjectMetadata[];
  /** The header's left cell, e.g. the app brand link. */
  brand: React.ReactNode;
  disabled?: boolean;
  onOpen: (project: ProjectMetadata) => void;
  onDelete: (project: ProjectMetadata) => void;
  onDuplicate: (project: ProjectMetadata) => void;
  onRenameProject: (project: ProjectMetadata, title: string) => Promise<unknown> | void;
  deleteConfirmId?: string | null;
  onCreate: (button: HTMLButtonElement) => void;
  onImport?: () => void;
  folders?: readonly ProjectFolder[];
  folderAssignments?: readonly ProjectFolderAssignment[];
  currentFolderId?: string | null;
  onNavigateFolder?: (folderId: string | null) => void;
  onCreateFolder?: (name: string, parentId: string | null) => Promise<unknown> | void;
  onRenameFolder?: (folderId: string, name: string) => Promise<unknown> | void;
  onDeleteFolder?: (folder: ProjectFolder) => void;
  folderDeleteConfirmId?: string | null;
  onMoveProject?: (project: ProjectMetadata, folderId: string | null) => Promise<unknown> | void;
  onMoveFolder?: (folder: ProjectFolder, parentId: string | null) => Promise<unknown> | void;
  onGroupProjects?: (dragged: ProjectMetadata, target: ProjectMetadata, parentId: string | null) => Promise<unknown> | void;
}

function editedDate(value: number): string {
  return new Date(value).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  });
}

function sortFolders(folders: readonly ProjectFolder[]): ProjectFolder[] {
  return [...folders].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
    || left.id.localeCompare(right.id)
  );
}

function sortProjects(projects: readonly ProjectMetadata[]): ProjectMetadata[] {
  return [...projects].sort((left, right) =>
    right.updatedAt - left.updatedAt
    || right.revision - left.revision
    || left.id.localeCompare(right.id)
  );
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

function DragPreviewFolderMark() {
  return (
    <svg className="project-gallery-drag-preview-folder-mark" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
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
}

function UpDropBar({ label, active }: UpDropBarProps) {
  const { setNodeRef, isOver } = useDroppable({ id: UP_DROP_ID, disabled: !active });
  return (
    <div ref={setNodeRef} className={`project-gallery-up-bar${dropStateClassName(true, active, isOver)}`} aria-hidden="true">
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
  dropActive: boolean;
  settling: boolean;
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
  dropActive,
  settling,
  onNavigateFolder,
  onRenameFolder,
  onDeleteFolder
}: FolderCardProps) {
  const metadataDescriptionId = useId();
  const renameInputId = useId();
  const { editing: renaming, start: startRename, triggerRef: renameTriggerRef, inputProps: renameInputProps } = useInlineEdit(folder.name, (name) => onRenameFolder?.(folder.id, name));

  const { attributes, listeners, setNodeRef: setDragNodeRef, setActivatorNodeRef, isDragging } = useDraggable({ id: folderDragId(folder.id), disabled: disabled || renaming });
  const { setNodeRef: setDropNodeRef, isOver } = useDroppable({ id: folderDropId(folder.id), disabled: !dropActive });

  const meta = `${patternCount} pattern${patternCount === 1 ? '' : 's'}${folderCount > 0 ? ` · ${folderCount} folder${folderCount === 1 ? '' : 's'}` : ''}`;

  const className = [
    'project-gallery-card',
    'project-gallery-folder',
    isDragging && 'project-gallery-dragging',
    dropStateClassName(dragActive, dropActive, isOver).trim()
  ].filter(Boolean).join(' ');

  return (
    <article
      ref={(node) => { setDragNodeRef(node); setDropNodeRef(node); }}
      className={className}
      style={settling ? SETTLING_STYLE : undefined}
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
  dropActive: boolean;
  settling: boolean;
  onOpen: (project: ProjectMetadata) => void;
  onDelete: (project: ProjectMetadata) => void;
  onDuplicate: (project: ProjectMetadata) => void;
  onRenameProject: (project: ProjectMetadata, title: string) => Promise<unknown> | void;
}

function ProjectCard({ project, disabled, confirming, dropActive, settling, onOpen, onDelete, onDuplicate, onRenameProject }: ProjectCardProps) {
  const metadataDescriptionId = useId();
  const renameInputId = useId();
  const { editing: renaming, start: startRename, triggerRef: renameTriggerRef, inputProps: renameInputProps } = useInlineEdit(project.title, (title) => onRenameProject(project, title));
  const { attributes, listeners, setNodeRef: setDragNodeRef, setActivatorNodeRef, isDragging } = useDraggable({ id: projectDragId(project.id), disabled: disabled || renaming });
  const { setNodeRef: setDropNodeRef, isOver } = useDroppable({ id: projectDropId(project.id), disabled: !dropActive });
  const groupOver = isOver && dropActive;

  const size = typeof project.width === 'number' && typeof project.height === 'number'
    && Number.isInteger(project.width) && Number.isInteger(project.height)
    && project.width > 0 && project.height > 0
    ? `${project.width} × ${project.height} stitches`
    : 'Size unavailable';

  return (
    <article
      ref={(node) => { setDragNodeRef(node); setDropNodeRef(node); }}
      className={`project-gallery-card${isDragging ? ' project-gallery-dragging' : ''}${groupOver ? ' project-gallery-drop-over' : ''}`}
      style={settling ? SETTLING_STYLE : undefined}
      {...listeners}
    >
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
          onClick={() => onDuplicate(project)}
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
  onDuplicate,
  onRenameProject,
  deleteConfirmId = null,
  onCreate,
  onImport,
  folders = [],
  folderAssignments = [],
  currentFolderId = null,
  onNavigateFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  folderDeleteConfirmId = null,
  onMoveProject,
  onMoveFolder,
  onGroupProjects,
  brand
}: ProjectGalleryProps) {
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [settlingId, setSettlingId] = useState<string | null>(null);
  const [reducedMotion] = useState(prefersReducedMotion);

  const mouseSensor = useSensor(MouseSensor, { activationConstraint: { distance: 6 } });
  const touchSensor = useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } });
  const keyboardSensor = useSensor(KeyboardSensor, { coordinateGetter: galleryCoordinateGetter });
  const sensors = useSensors(mouseSensor, touchSensor, keyboardSensor);

  const sortedFolders = useMemo(() => sortFolders(folders), [folders]);
  const folderById = useMemo(() => new Map(sortedFolders.map((folder) => [folder.id, folder])), [sortedFolders]);
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
    for (const folder of sortedFolders) {
      const list = map.get(folder.parentId);
      if (list) list.push(folder); else map.set(folder.parentId, [folder]);
    }
    return map;
  }, [sortedFolders]);

  const visibleFolders = childFoldersOf.get(currentFolder ? currentFolder.id : null) ?? [];
  const visibleProjects = sortProjects(
    currentFolder ? projectsByFolderId.get(currentFolder.id) ?? [] : projects.filter((item) => !folderIdByProjectId.has(item.id))
  );

  const canCreateFolderHere = currentFolder === null || currentFolder.parentId === null;
  const newFolderParentId = currentFolder ? currentFolder.id : null;

  const isEmpty = visibleFolders.length === 0 && visibleProjects.length === 0;
  const isTopLevel = currentFolder === null;

  const moveContext: MoveContext = useMemo(() => ({
    folders: sortedFolders,
    folderAssignments,
    currentFolderId: currentFolder ? currentFolder.id : null
  }), [sortedFolders, folderAssignments, currentFolder]);

  const announceContext: AnnouncementContext = useMemo(() => ({ ...moveContext, projects }), [moveContext, projects]);

  function isActiveTarget(dropId: string): boolean {
    return activeDragId !== null && isValidDropTarget(activeDragId, dropId, moveContext);
  }

  const activeDragInfo = useMemo(() => {
    if (!activeDragId) return null;
    const parsed = parseDragId(activeDragId);
    if (!parsed) return null;
    if (parsed.kind === 'project') {
      const project = projectsById.get(parsed.id);
      return project ? { kind: 'project' as const, project } : null;
    }
    const folder = folderById.get(parsed.id);
    return folder ? { kind: 'folder' as const, folder } : null;
  }, [activeDragId, projectsById, folderById]);

  const groupingOver = activeDragId !== null && overId !== null && resolveGroupTarget(activeDragId, overId, moveContext) !== null;

  const addingToFolder = activeDragId !== null && overId !== null && overId !== UP_DROP_ID
    && activeDragInfo?.kind === 'project' && resolveMoveTarget(activeDragId, overId, moveContext) !== null;

  function groupTargetTitle(draggedId: string, dropId: string): string | null {
    const group = resolveGroupTarget(draggedId, dropId, moveContext);
    return group ? projectsById.get(group.targetProjectId)?.title ?? null : null;
  }

  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${describeDraggedName(String(active.id), announceContext)}.`,
    onDragOver: ({ active, over }) => {
      if (!over) return undefined;
      const groupTitle = groupTargetTitle(String(active.id), String(over.id));
      if (groupTitle !== null) {
        return `${describeDraggedName(String(active.id), announceContext)} is over ${groupTitle}. Drop to create a folder with both.`;
      }
      const targetName = describeDropTargetName(String(over.id), announceContext);
      if (!targetName) return undefined;
      return `${describeDraggedName(String(active.id), announceContext)} is over ${targetName}.`;
    },
    onDragEnd: ({ active, over }) => {
      const name = describeDraggedName(String(active.id), announceContext);
      if (!over) return `Cancelled moving ${name}.`;
      const groupTitle = groupTargetTitle(String(active.id), String(over.id));
      if (groupTitle !== null) return `Created a folder with ${name} and ${groupTitle}.`;
      const target = resolveMoveTarget(String(active.id), String(over.id), announceContext);
      if (!target) return `Cancelled moving ${name}.`;
      return `Moved ${name} to ${describeDropTargetName(String(over.id), announceContext)}.`;
    },
    onDragCancel: ({ active }) => `Cancelled moving ${describeDraggedName(String(active.id), announceContext)}.`
  };

  function handleDragStart(event: DragStartEvent) {
    setActiveDragId(String(event.active.id));
  }

  function handleDragOver(event: DragOverEvent) {
    setOverId(event.over ? String(event.over.id) : null);
  }

  function handleDragEnd(event: DragEndEvent) {
    const draggedId = String(event.active.id);
    const dropId = event.over ? String(event.over.id) : null;
    setActiveDragId(null);
    setOverId(null);
    if (!dropId) return;
    const drop = performDrop(draggedId, dropId);
    if (drop === null) return;
    // Set in the same batch that clears the active drag, so the overlay skips its animation home.
    setSettlingId(draggedId);
    const settle = () => setSettlingId((current) => (current === draggedId ? null : current));
    void Promise.resolve(drop).then(settle, settle);
  }

  /** Runs the drop's handler, or returns null when the drop does nothing. */
  function performDrop(draggedId: string, dropId: string): Promise<unknown> | void | null {
    const group = resolveGroupTarget(draggedId, dropId, moveContext);
    if (group) {
      const dragged = projectsById.get(group.draggedProjectId);
      const target = projectsById.get(group.targetProjectId);
      return dragged && target ? onGroupProjects?.(dragged, target, group.parentId) : null;
    }
    const target = resolveMoveTarget(draggedId, dropId, moveContext);
    if (!target) return null;
    if (target.kind === 'project') {
      const project = projectsById.get(target.id);
      return project ? onMoveProject?.(project, target.targetFolderId) : null;
    }
    const folder = folderById.get(target.id);
    return folder ? onMoveFolder?.(folder, target.targetFolderId) : null;
  }

  function handleDragCancel() {
    setActiveDragId(null);
    setOverId(null);
  }

  const upBarLabel = currentFolder
    ? `↑ Drop here to move out to ${currentFolder.parentId ? folderById.get(currentFolder.parentId)?.name ?? 'Projects' : 'Projects'}`
    : '';

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithinOrClosestCenter}
      accessibility={{ announcements }}
      onDragStart={handleDragStart}
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
          {!(isTopLevel && isEmpty) && (
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
          )}
        </header>

        {onCreateFolder && creatingFolder && (
          <NewFolderModal
            parentName={currentFolder ? currentFolder.name : null}
            busy={disabled}
            onSubmit={(name) => { onCreateFolder(name, newFolderParentId); setCreatingFolder(false); }}
            onClose={() => setCreatingFolder(false)}
          />
        )}

        {activeDragId && currentFolder && (
          <UpDropBar label={upBarLabel} active={isActiveTarget(UP_DROP_ID)} />
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
          <div className="project-gallery-grid">
            {visibleFolders.map((folder) => {
              const children = childFoldersOf.get(folder.id) ?? [];
              const scopedFolderIds = [folder.id, ...children.map((child) => child.id)];
              const scopedProjects = scopedFolderIds.flatMap((id) => projectsByFolderId.get(id) ?? []);
              const dropId = folderDropId(folder.id);
              return (
                <FolderCard
                  key={folder.id}
                  folder={folder}
                  disabled={disabled}
                  patternCount={scopedProjects.length}
                  folderCount={children.length}
                  preview={folderPreviewProjects(scopedProjects, assignedAtByProjectId)}
                  confirming={folderDeleteConfirmId === folder.id}
                  dragActive={activeDragId !== null}
                  dropActive={isActiveTarget(dropId)}
                  settling={settlingId === folderDragId(folder.id)}
                  onNavigateFolder={onNavigateFolder}
                  onRenameFolder={onRenameFolder}
                  onDeleteFolder={onDeleteFolder}
                />
              );
            })}
            {visibleProjects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                disabled={disabled}
                confirming={deleteConfirmId === project.id}
                dropActive={isActiveTarget(projectDropId(project.id))}
                settling={settlingId === projectDragId(project.id)}
                onOpen={onOpen}
                onDelete={onDelete}
                onDuplicate={onDuplicate}
                onRenameProject={onRenameProject}
              />
            ))}
          </div>
        )}
      </section>
      <DragOverlay dropAnimation={reducedMotion || settlingId !== null ? null : DROP_ANIMATION} modifiers={[snapCenterToPointer]}>
        {activeDragInfo && (
          <div className="project-gallery-drag-preview" aria-hidden="true">
            {groupingOver || addingToFolder ? (
              <>
                <DragPreviewFolderMark />
                <span className="project-gallery-drag-preview-name">{groupingOver ? 'Create folder' : 'Add to folder'}</span>
              </>
            ) : activeDragInfo.kind === 'project' ? (
              <>
                <ProjectThumbnail
                  revision={activeDragInfo.project.revision}
                  width={activeDragInfo.project.width}
                  height={activeDragInfo.project.height}
                  thumbnail={activeDragInfo.project.thumbnail}
                />
                <span className="project-gallery-drag-preview-name">{activeDragInfo.project.title}</span>
              </>
            ) : (
              <>
                <DragPreviewFolderMark />
                <span className="project-gallery-drag-preview-name">{activeDragInfo.folder.name}</span>
              </>
            )}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
