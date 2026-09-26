import { useEffect, useId, useMemo, useRef, useState } from 'react';
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
  type DragStartEvent,
  type KeyboardCoordinateGetter
} from '@dnd-kit/core';
import { MAX_FOLDER_NAME_CHARS, type ProjectFolder, type ProjectFolderAssignment, type ProjectMetadata } from '../persistence';
import { ProjectThumbnail } from './ProjectThumbnail';
import { NewFolderModal } from './NewFolderModal';
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
  pointerWithinOrClosestCenter,
  projectDragId,
  resolveMoveTarget,
  snapCenterToPointer,
  type AnnouncementContext,
  type Direction,
  type MoveContext,
  type Rect
} from './gallery-dnd';

const DROP_ANIMATION = { duration: 150, easing: 'ease' };

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

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

interface ProjectGalleryProps {
  projects: readonly ProjectMetadata[];
  disabled?: boolean;
  onOpen: (project: ProjectMetadata) => void;
  onDelete: (project: ProjectMetadata) => void;
  deleteConfirmId?: string | null;
  onCreate: (button: HTMLButtonElement) => void;
  onImport: () => void;
  folders?: readonly ProjectFolder[];
  folderAssignments?: readonly ProjectFolderAssignment[];
  currentFolderId?: string | null;
  onNavigateFolder?: (folderId: string | null) => void;
  onCreateFolder?: (name: string, parentId: string | null) => Promise<unknown> | void;
  onRenameFolder?: (folderId: string, name: string) => Promise<unknown> | void;
  onDeleteFolder?: (folder: ProjectFolder) => void;
  folderDeleteConfirmId?: string | null;
  onMoveProject?: (project: ProjectMetadata, folderId: string | null) => void;
  onMoveFolder?: (folder: ProjectFolder, parentId: string | null) => void;
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

function mostRecentProject(candidates: readonly ProjectMetadata[]): ProjectMetadata | undefined {
  return candidates.reduce<ProjectMetadata | undefined>((best, candidate) => {
    if (!best) return candidate;
    if (candidate.updatedAt !== best.updatedAt) return candidate.updatedAt > best.updatedAt ? candidate : best;
    return candidate.revision > best.revision ? candidate : best;
  }, undefined);
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
  preview: ProjectMetadata | undefined;
  confirming: boolean;
  dragActive: boolean;
  dropActive: boolean;
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
  onNavigateFolder,
  onRenameFolder,
  onDeleteFolder
}: FolderCardProps) {
  const metadataDescriptionId = useId();
  const renameInputId = useId();
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(folder.name);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const settledRef = useRef(false);

  const { attributes, listeners, setNodeRef: setDragNodeRef, setActivatorNodeRef, isDragging } = useDraggable({ id: folderDragId(folder.id), disabled: disabled || renaming });
  const { setNodeRef: setDropNodeRef, isOver } = useDroppable({ id: folderDropId(folder.id), disabled: !dropActive });

  useEffect(() => {
    if (renaming) renameInputRef.current?.focus();
  }, [renaming]);

  const meta = `${patternCount} pattern${patternCount === 1 ? '' : 's'}${folderCount > 0 ? ` · ${folderCount} folder${folderCount === 1 ? '' : 's'}` : ''}`;

  function startRename() {
    settledRef.current = false;
    setRenameValue(folder.name);
    setRenaming(true);
  }

  function commitRename() {
    if (settledRef.current) return;
    settledRef.current = true;
    const trimmed = renameValue.trim();
    setRenaming(false);
    if (trimmed && trimmed !== folder.name) onRenameFolder?.(folder.id, trimmed);
  }

  function cancelRename() {
    if (settledRef.current) return;
    settledRef.current = true;
    setRenameValue(folder.name);
    setRenaming(false);
  }

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
      {...listeners}
    >
      <span className="project-gallery-folder-tab" aria-hidden="true" />
      {dragActive && dropActive && (
        <span className="project-gallery-drop-label" aria-hidden="true">Move into {folder.name}</span>
      )}
      <button
        className="project-gallery-open"
        type="button"
        disabled={disabled}
        onClick={() => onNavigateFolder?.(folder.id)}
        aria-label={`Open folder ${folder.name}`}
        aria-describedby={metadataDescriptionId}
      >
        <span className="project-gallery-folder-preview">
          <ProjectThumbnail
            revision={preview?.revision}
            width={preview?.width}
            height={preview?.height}
            thumbnail={preview?.thumbnail}
          />
        </span>
        <span className="project-gallery-copy">
          <span id={metadataDescriptionId} className="project-gallery-meta">{meta}</span>
          {!renaming && <span className="project-gallery-name">{folder.name}</span>}
        </span>
      </button>
      {renaming && (
        <div className="project-gallery-folder-rename">
          <label className="visually-hidden" htmlFor={renameInputId}>Rename folder {folder.name}</label>
          <input
            ref={renameInputRef}
            id={renameInputId}
            value={renameValue}
            maxLength={MAX_FOLDER_NAME_CHARS}
            onChange={(event) => setRenameValue(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); commitRename(); }
              else if (event.key === 'Escape') { event.preventDefault(); cancelRename(); }
            }}
          />
        </div>
      )}
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
        {onRenameFolder && !renaming && (
          <button className="project-gallery-rename" type="button" disabled={disabled} onClick={startRename}>
            Rename
          </button>
        )}
        {onDeleteFolder && (
          <button
            className={`project-gallery-delete${confirming ? ' project-gallery-delete-confirming' : ''}`}
            type="button"
            disabled={disabled}
            aria-label={confirming ? `Confirm delete folder ${folder.name}` : `Delete folder ${folder.name}`}
            onClick={() => onDeleteFolder(folder)}
          >
            {confirming ? 'Confirm delete?' : 'Delete'}
          </button>
        )}
        <button
          className="project-gallery-footer-open"
          type="button"
          disabled={disabled}
          onClick={() => onNavigateFolder?.(folder.id)}
          aria-label={`Open folder: ${folder.name}`}
          aria-describedby={metadataDescriptionId}
        >
          <span aria-hidden="true">Open →</span>
        </button>
      </div>
    </article>
  );
}

interface ProjectCardProps {
  project: ProjectMetadata;
  disabled: boolean;
  confirming: boolean;
  onOpen: (project: ProjectMetadata) => void;
  onDelete: (project: ProjectMetadata) => void;
}

function ProjectCard({ project, disabled, confirming, onOpen, onDelete }: ProjectCardProps) {
  const metadataDescriptionId = useId();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({ id: projectDragId(project.id), disabled });
  const size = typeof project.width === 'number' && typeof project.height === 'number'
    && Number.isInteger(project.width) && Number.isInteger(project.height)
    && project.width > 0 && project.height > 0
    ? `${project.width} × ${project.height} stitches`
    : 'Size unavailable';

  return (
    <article
      ref={setNodeRef}
      className={`project-gallery-card${isDragging ? ' project-gallery-dragging' : ''}`}
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
        <span className="project-gallery-copy">
          <span id={metadataDescriptionId} className="project-gallery-meta">
            {size} | Edited {editedDate(project.updatedAt)}
          </span>
          <span className="project-gallery-name">{project.title}</span>
        </span>
      </button>
      <div className="project-gallery-card-actions">
        <button
          ref={setActivatorNodeRef}
          className="project-gallery-drag-handle"
          type="button"
          disabled={disabled}
          aria-label={`Drag ${project.title}`}
          {...attributes}
        >
          <span aria-hidden="true">⠿</span>
        </button>
        <button
          className={`project-gallery-delete${confirming ? ' project-gallery-delete-confirming' : ''}`}
          type="button"
          disabled={disabled}
          aria-label={confirming ? `Confirm delete ${project.title}` : `Delete ${project.title}`}
          onClick={() => onDelete(project)}
        >
          {confirming ? 'Confirm delete?' : 'Delete'}
        </button>
        <button
          className="project-gallery-footer-open"
          type="button"
          disabled={disabled}
          onClick={() => onOpen(project)}
          aria-label={`Open pattern: ${project.title}`}
          aria-describedby={metadataDescriptionId}
        >
          <span aria-hidden="true">Open →</span>
        </button>
      </div>
    </article>
  );
}

export function ProjectGallery({
  projects,
  disabled = false,
  onOpen,
  onDelete,
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
  onMoveFolder
}: ProjectGalleryProps) {
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
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

  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${describeDraggedName(String(active.id), announceContext)}.`,
    onDragOver: ({ active, over }) => {
      if (!over) return undefined;
      const targetName = describeDropTargetName(String(over.id), announceContext);
      if (!targetName) return undefined;
      return `${describeDraggedName(String(active.id), announceContext)} is over ${targetName}.`;
    },
    onDragEnd: ({ active, over }) => {
      const name = describeDraggedName(String(active.id), announceContext);
      if (!over) return `Cancelled moving ${name}.`;
      const target = resolveMoveTarget(String(active.id), String(over.id), announceContext);
      if (!target) return `Cancelled moving ${name}.`;
      return `Moved ${name} to ${describeDropTargetName(String(over.id), announceContext)}.`;
    },
    onDragCancel: ({ active }) => `Cancelled moving ${describeDraggedName(String(active.id), announceContext)}.`
  };

  function handleDragStart(event: DragStartEvent) {
    setActiveDragId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    const draggedId = String(event.active.id);
    const dropId = event.over ? String(event.over.id) : null;
    setActiveDragId(null);
    if (!dropId) return;
    const target = resolveMoveTarget(draggedId, dropId, moveContext);
    if (!target) return;
    if (target.kind === 'project') {
      const project = projectsById.get(target.id);
      if (project) onMoveProject?.(project, target.targetFolderId);
    } else {
      const folder = folderById.get(target.id);
      if (folder) onMoveFolder?.(folder, target.targetFolderId);
    }
  }

  function handleDragCancel() {
    setActiveDragId(null);
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
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <section className="project-gallery" aria-labelledby="projects-title">
        <header className="project-gallery-header">
          <div>
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
              <button className="button button-secondary" type="button" disabled={disabled} onClick={onImport}>
                Import Pattern
              </button>
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
            <p>Start a new pattern from scratch or an image, or import a .needlewise archive.</p>
            <div className="project-gallery-start-actions">
              <button className="button button-primary project-gallery-start-button" type="button" disabled={disabled} onClick={(event) => onCreate(event.currentTarget)}>
                <span aria-hidden="true">＋</span> New Pattern
              </button>
              <button className="button button-secondary project-gallery-start-button" type="button" disabled={disabled} onClick={onImport}>
                Import Pattern
              </button>
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
                  preview={mostRecentProject(scopedProjects)}
                  confirming={folderDeleteConfirmId === folder.id}
                  dragActive={activeDragId !== null}
                  dropActive={isActiveTarget(dropId)}
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
                onOpen={onOpen}
                onDelete={onDelete}
              />
            ))}
          </div>
        )}
      </section>
      <DragOverlay dropAnimation={reducedMotion ? null : DROP_ANIMATION} modifiers={[snapCenterToPointer]}>
        {activeDragInfo && (
          <div className="project-gallery-drag-preview" aria-hidden="true">
            {activeDragInfo.kind === 'project' ? (
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
                <span className="project-gallery-drag-preview-folder-mark" aria-hidden="true" />
                <span className="project-gallery-drag-preview-name">{activeDragInfo.folder.name}</span>
              </>
            )}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
