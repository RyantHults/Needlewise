import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react';
import { ProjectWorkspace, getEmptyWorkspaceState } from './workspace';
import { asError, WorkspaceError } from './errors';
import type {
  ActiveWorkspaceState,
  CreateProjectOptions,
  CreateConvertedProjectOptions,
  WorkspaceOptions
} from './types';
import type { CreatedFolder, GalleryOrder, GalleryUndo, ProjectFolder, ProjectFolderAssignment, ProjectMetadata, ProjectOpened } from '../persistence';
import type { ProjectSession } from './session';

export interface UseProjectWorkspaceOptions extends WorkspaceOptions {
  workspaceFactory?: (options: WorkspaceOptions) => ProjectWorkspace;
}

export interface UseProjectWorkspaceResult {
  workspace: ProjectWorkspace | null;
  initialized: boolean;
  busy: boolean;
  state: ActiveWorkspaceState;
  projects: ProjectMetadata[];
  folders: ProjectFolder[];
  folderAssignments: ProjectFolderAssignment[];
  galleryOrders: GalleryOrder[];
  projectOpens: ProjectOpened[];
  error: Error | null;
  createProject(options?: CreateProjectOptions): Promise<ProjectSession>;
  createProjectFromConversion(options: CreateConvertedProjectOptions): Promise<ProjectSession>;
  openProject(projectId: string): Promise<ProjectSession>;
  deleteProjects(projectIds: readonly string[]): Promise<void>;
  restoreDeletedProjects(projectIds: readonly string[]): Promise<void>;
  duplicateProjects(projectIds: readonly string[], folderId: string | null): Promise<ProjectMetadata[]>;
  renameProject(projectId: string, title: string): Promise<ProjectMetadata>;
  createFolder(name: string, parentId?: string | null, projectIds?: readonly string[], takesSpotOf?: string): Promise<CreatedFolder>;
  renameFolder(folderId: string, name: string): Promise<ProjectFolder>;
  deleteFolder(folderId: string): Promise<void>;
  moveProjectsToFolder(projectIds: readonly string[], folderId: string | null): Promise<GalleryUndo>;
  moveFolder(folderId: string, parentId: string | null): Promise<GalleryUndo>;
  setGalleryOrder(levelId: string, keys: readonly string[]): Promise<void>;
  restoreGallery(undo: GalleryUndo): Promise<void>;
  flush(): Promise<void>;
  /** Flush pending saves and re-read the project listing without marking the hook busy. */
  refreshProjectList(): Promise<void>;
}

const EMPTY_STATE = getEmptyWorkspaceState();

function workspaceOptionsFrom(options: UseProjectWorkspaceOptions): WorkspaceOptions {
  return {
    repository: options.repository,
    clock: options.clock,
    debounceMs: options.debounceMs,
    projectIdFactory: options.projectIdFactory
  };
}

/**
 * React's adapter owns lifecycle only. The workspace remains the source of
 * truth for documents and persistence; useSyncExternalStore observes its
 * stable snapshots without polling.
 */
export function useProjectWorkspace(options: UseProjectWorkspaceOptions = {}): UseProjectWorkspaceResult {
  const workspaceRef = useRef<ProjectWorkspace | null>(null);
  const workspaceFactoryRef = useRef<(workspaceOptions: WorkspaceOptions) => ProjectWorkspace>(
    options.workspaceFactory ?? ((workspaceOptions) => new ProjectWorkspace(workspaceOptions))
  );
  const workspaceOptionsRef = useRef<WorkspaceOptions>(workspaceOptionsFrom(options));
  const lifecycleRef = useRef({ mounted: false });
  const initializationStartedRef = useRef(false);
  const initializationTokenRef = useRef(0);
  const busyCountRef = useRef(1);
  const [workspace, setWorkspace] = useState<ProjectWorkspace | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [busy, setBusy] = useState(true);
  const [projects, setProjects] = useState<ProjectMetadata[]>([]);
  const [folders, setFolders] = useState<ProjectFolder[]>([]);
  const [folderAssignments, setFolderAssignments] = useState<ProjectFolderAssignment[]>([]);
  const [galleryOrders, setGalleryOrders] = useState<GalleryOrder[]>([]);
  const [projectOpens, setProjectOpens] = useState<ProjectOpened[]>([]);
  const [actionError, setActionError] = useState<Error | null>(null);

  const subscribe = useCallback((listener: () => void) => {
    if (!workspace) return () => undefined;
    return workspace.subscribe(listener);
  }, [workspace]);
  const getSnapshot = useCallback(() => workspace?.getStateSnapshot() ?? EMPTY_STATE, [workspace]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const beginBusy = useCallback(() => {
    busyCountRef.current += 1;
    setBusy(true);
  }, []);
  const endBusy = useCallback(() => {
    busyCountRef.current = Math.max(0, busyCountRef.current - 1);
    if (lifecycleRef.current.mounted) setBusy(busyCountRef.current > 0);
  }, []);

  const refreshProjects = useCallback(async (instance: ProjectWorkspace): Promise<ProjectMetadata[]> => {
    const [nextProjects, galleryIndex] = await Promise.all([instance.listProjects(), instance.listGalleryIndex()]);
    if (lifecycleRef.current.mounted && workspaceRef.current === instance) {
      setProjects(nextProjects);
      setFolders(galleryIndex.folders);
      setFolderAssignments(galleryIndex.assignments);
      setGalleryOrders(galleryIndex.orders);
      setProjectOpens(galleryIndex.opens);
    }
    return nextProjects;
  }, []);

  const runAction = useCallback(async <T,>(operation: (instance: ProjectWorkspace) => Promise<T>): Promise<T> => {
    const instance = workspaceRef.current;
    if (!instance) throw new WorkspaceError('disposed', 'The workspace is not ready.');
    beginBusy();
    setActionError(null);
    try {
      const value = await operation(instance);
      await refreshProjects(instance);
      return value;
    } catch (error) {
      const normalized = asError(error, 'The workspace action failed.');
      if (lifecycleRef.current.mounted && workspaceRef.current === instance) setActionError(normalized);
      throw normalized;
    } finally {
      endBusy();
    }
  }, [beginBusy, endBusy, refreshProjects]);

  useEffect(() => {
    lifecycleRef.current.mounted = true;
    let instance = workspaceRef.current;
    if (!instance) {
      instance = workspaceFactoryRef.current(workspaceOptionsRef.current);
      workspaceRef.current = instance;
      setWorkspace(instance);
    }
    if (!initializationStartedRef.current) {
      initializationStartedRef.current = true;
      const token = ++initializationTokenRef.current;
      void (async () => {
        try {
          // Patterns a previous session deleted can no longer be undone.
          await instance.purgeDeletedProjects().catch(() => undefined);
          const initialProjects = await refreshProjects(instance);
          // Out-of-date thumbnails refresh in the background; failures are ignored.
          void instance.refreshStaleThumbnails?.(initialProjects).then((refreshed) => {
            if (refreshed > 0 && lifecycleRef.current.mounted && workspaceRef.current === instance) return refreshProjects(instance);
            return undefined;
          }).catch(() => undefined);
        } catch (error) {
          if (lifecycleRef.current.mounted && initializationTokenRef.current === token && workspaceRef.current === instance) setActionError(asError(error, 'The workspace action failed.'));
        } finally {
          if (lifecycleRef.current.mounted && initializationTokenRef.current === token && workspaceRef.current === instance) {
            setInitialized(true);
            endBusy();
          }
        }
      })();
    }

    function flushOnLifecycle(): void {
      // Lifecycle events cannot wait for an IndexedDB transaction. Starting a
      // best-effort flush here still lets an already-open transaction finish,
      // while keeping event handlers synchronous and Strict Mode-safe.
      void instance?.flush().catch(() => undefined);
    }

    function onVisibilityChange(): void {
      if (document.visibilityState === 'hidden') flushOnLifecycle();
    }

    window.addEventListener('pagehide', flushOnLifecycle);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      lifecycleRef.current.mounted = false;
      window.removeEventListener('pagehide', flushOnLifecycle);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      // React Strict Mode replays effects synchronously. Deferring disposal
      // lets the replayed setup reuse the same instance while a real unmount
      // still disposes it before the next task.
      queueMicrotask(() => {
        if (lifecycleRef.current.mounted) return;
        const stale = workspaceRef.current;
        workspaceRef.current = null;
        if (stale) void stale.dispose().catch(() => undefined);
      });
    };

  }, [endBusy, refreshProjects]);

  const createProject = useCallback((createOptions: CreateProjectOptions = {}) => runAction((instance) => instance.createProject(createOptions)), [runAction]);
  const createProjectFromConversion = useCallback((createOptions: CreateConvertedProjectOptions) => runAction((instance) => instance.createProjectFromConversion(createOptions)), [runAction]);
  const openProject = useCallback((projectId: string) => runAction((instance) => instance.openProject(projectId)), [runAction]);
  const deleteProjects = useCallback((projectIds: readonly string[]) => runAction((instance) => instance.deleteProjects(projectIds)), [runAction]);
  const restoreDeletedProjects = useCallback((projectIds: readonly string[]) => runAction((instance) => instance.restoreDeletedProjects(projectIds)), [runAction]);
  const createFolder = useCallback((name: string, parentId: string | null = null, projectIds: readonly string[] = [], takesSpotOf?: string) => runAction((instance) => instance.createFolder(name, parentId, projectIds, takesSpotOf)), [runAction]);
  const renameFolder = useCallback((folderId: string, name: string) => runAction((instance) => instance.renameFolder(folderId, name)), [runAction]);
  const deleteFolder = useCallback((folderId: string) => runAction((instance) => instance.deleteFolder(folderId)), [runAction]);
  const moveProjectsToFolder = useCallback((projectIds: readonly string[], folderId: string | null) => runAction((instance) => instance.moveProjectsToFolder(projectIds, folderId)), [runAction]);
  const moveFolder = useCallback((folderId: string, parentId: string | null) => runAction((instance) => instance.moveFolder(folderId, parentId)), [runAction]);
  const setGalleryOrder = useCallback((levelId: string, keys: readonly string[]) => runAction((instance) => instance.setGalleryOrder(levelId, keys)), [runAction]);
  const restoreGallery = useCallback((undo: GalleryUndo) => runAction((instance) => instance.restoreGallery(undo)), [runAction]);
  const duplicateProjects = useCallback((projectIds: readonly string[], folderId: string | null) => runAction((instance) => instance.duplicateProjects(projectIds, folderId)), [runAction]);
  const renameProject = useCallback((projectId: string, title: string) => runAction((instance) => instance.renameProject(projectId, title)), [runAction]);
  const flush = useCallback(() => runAction((instance) => instance.flush()), [runAction]);
  // Passive: editor autosaves bypass runAction, so the listing is re-read on demand without toggling busy.
  const refreshProjectList = useCallback(async (): Promise<void> => {
    const instance = workspaceRef.current;
    if (!instance) return;
    try {
      await instance.flush().catch(() => undefined);
      await refreshProjects(instance);
    } catch {
      // Best effort: a failed refresh keeps the previous listing.
    }
  }, [refreshProjects]);

  return {
    workspace,
    initialized,
    busy,
    state,
    projects,
    folders,
    folderAssignments,
    galleryOrders,
    projectOpens,
    error: state.error ?? actionError,
    createProject,
    createProjectFromConversion,
    openProject,
    deleteProjects,
    restoreDeletedProjects,
    duplicateProjects,
    renameProject,
    createFolder,
    renameFolder,
    deleteFolder,
    moveProjectsToFolder,
    moveFolder,
    setGalleryOrder,
    restoreGallery,
    flush,
    refreshProjectList
  };
}
