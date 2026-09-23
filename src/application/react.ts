import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react';
import { ProjectWorkspace } from './workspace';
import { WorkspaceError } from './errors';
import type {
  ActiveWorkspaceState,
  ActiveMetadataChanges,
  CreateProjectOptions,
  CreateConvertedProjectOptions,
  SaveState,
  WorkspaceInitializationOptions,
  WorkspaceOptions
} from './types';
import type { ArchiveImportOptions, ProgressActivity, ProjectMetadata } from '../persistence';
import type { ProjectSession } from './session';
import type { CommandResult, DomainCommand, PatternMetrics } from '../domain';
import type { SessionProgressStats } from './progress';

export interface UseProjectWorkspaceOptions extends WorkspaceOptions {
  workspaceFactory?: (options: WorkspaceOptions) => ProjectWorkspace;
  initialProjectId?: string;
  autoOpenMostRecent?: boolean;
}

export interface UseProjectWorkspaceResult {
  workspace: ProjectWorkspace | null;
  initialized: boolean;
  busy: boolean;
  state: ActiveWorkspaceState;
  projects: ProjectMetadata[];
  error: Error | null;
  saveState: SaveState;
  metrics: PatternMetrics | null;
  sessionStats: SessionProgressStats | null;
  activity: ProgressActivity | null;
  createProject(options?: CreateProjectOptions): Promise<ProjectSession>;
  createProjectFromConversion(options: CreateConvertedProjectOptions): Promise<ProjectSession>;
  initialize(options?: WorkspaceInitializationOptions): Promise<ProjectSession | undefined>;
  updateActiveMetadata(changes: ActiveMetadataChanges): Promise<void>;
  openProject(projectId: string): Promise<ProjectSession>;
  selectProject(projectId?: string): Promise<ProjectSession | undefined>;
  deleteProject(projectId: string): Promise<void>;
  importProject(input: Uint8Array | ArrayBuffer | Blob, options?: ArchiveImportOptions): Promise<ProjectSession>;
  importProjectAsCopy(input: Uint8Array | ArrayBuffer | Blob, options?: ArchiveImportOptions): Promise<ProjectSession>;
  exportProject(): Promise<Uint8Array>;
  promoteRecovery(revision?: number): Promise<ProjectSession>;
  saveAsCopy(options?: CreateProjectOptions): Promise<ProjectSession>;
  retrySave(): Promise<void>;
  flush(): Promise<void>;
  execute(command: DomainCommand): Promise<CommandResult>;
  executeCommand(command: DomainCommand): Promise<CommandResult>;
  executeBatch(commands: readonly DomainCommand[]): Promise<CommandResult>;
  undo(): Promise<CommandResult>;
  redo(): Promise<CommandResult>;
}

const EMPTY_STATE: ActiveWorkspaceState = {
  projectId: null,
  metadata: null,
  document: null,
  health: null,
  usingRecovery: false,
  save: {
    status: 'idle',
    dirty: false,
    pendingRevision: null,
    lastSavedRevision: null,
    metadataDirty: false,
    assetsDirty: false,
    conflict: false,
    error: null
  },
  error: null
};

function workspaceOptionsFrom(options: UseProjectWorkspaceOptions): WorkspaceOptions {
  return {
    repository: options.repository,
    clock: options.clock,
    debounceMs: options.debounceMs,
    projectIdFactory: options.projectIdFactory,
    catalogRegistry: options.catalogRegistry
  };
}

function normalizeActionError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new WorkspaceError('save-failed', 'The workspace action failed.', error);
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
    const nextProjects = await instance.listProjects();
    if (lifecycleRef.current.mounted && workspaceRef.current === instance) setProjects(nextProjects);
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
      const normalized = normalizeActionError(error);
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
          const initialProjects = await refreshProjects(instance);
          if (!lifecycleRef.current.mounted || initializationTokenRef.current !== token || workspaceRef.current !== instance) return;
          if (options.initialProjectId !== undefined) {
            await instance.openProject(options.initialProjectId);
          } else if (options.autoOpenMostRecent !== false) {
            await instance.selectProject(undefined, initialProjects);
          }
        } catch (error) {
          if (lifecycleRef.current.mounted && initializationTokenRef.current === token && workspaceRef.current === instance) setActionError(normalizeActionError(error));
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
  const initialize = useCallback((initializeOptions: WorkspaceInitializationOptions = {}) => runAction((instance) => instance.initialize(initializeOptions)), [runAction]);
  const updateActiveMetadata = useCallback((changes: ActiveMetadataChanges) => runAction((instance) => instance.updateActiveMetadata(changes)), [runAction]);
  const openProject = useCallback((projectId: string) => runAction((instance) => instance.openProject(projectId)), [runAction]);
  const selectProject = useCallback((projectId?: string) => runAction((instance) => instance.selectProject(projectId)), [runAction]);
  const deleteProject = useCallback((projectId: string) => runAction((instance) => instance.deleteProject(projectId)), [runAction]);
  const importProject = useCallback((input: Uint8Array | ArrayBuffer | Blob, importOptions: ArchiveImportOptions = {}) => runAction((instance) => instance.importProject(input, importOptions)), [runAction]);
  const importProjectAsCopy = useCallback((input: Uint8Array | ArrayBuffer | Blob, importOptions: ArchiveImportOptions = {}) => runAction((instance) => instance.importProjectAsCopy(input, importOptions)), [runAction]);
  const exportProject = useCallback(() => runAction((instance) => instance.exportActiveProject()), [runAction]);
  const promoteRecovery = useCallback((revision?: number) => runAction((instance) => instance.promoteRecovery(revision)), [runAction]);
  const saveAsCopy = useCallback((copyOptions: CreateProjectOptions = {}) => runAction((instance) => instance.saveAsCopy(copyOptions)), [runAction]);
  const retrySave = useCallback(() => runAction((instance) => instance.retrySave()), [runAction]);
  const flush = useCallback(() => runAction((instance) => instance.flush()), [runAction]);
  const execute = useCallback((command: DomainCommand) => runAction(async (instance) => instance.execute(command)), [runAction]);
  const executeCommand = execute;
  const executeBatch = useCallback((commands: readonly DomainCommand[]) => runAction(async (instance) => instance.executeBatch(commands)), [runAction]);
  const undo = useCallback(() => runAction(async (instance) => instance.undo()), [runAction]);
  const redo = useCallback(() => runAction(async (instance) => instance.redo()), [runAction]);

  return {
    workspace,
    initialized,
    busy,
    state,
    projects,
    error: state.error ?? actionError,
    saveState: state.save,
    metrics: state.metrics ?? null,
    sessionStats: state.sessionStats ?? null,
    activity: state.activity ?? null,
    createProject,
    createProjectFromConversion,
    initialize,
    updateActiveMetadata,
    openProject,
    selectProject,
    deleteProject,
    importProject,
    importProjectAsCopy,
    exportProject,
    promoteRecovery,
    saveAsCopy,
    retrySave,
    flush,
    execute,
    executeCommand,
    executeBatch,
    undo,
    redo
  };
}

export const useWorkspace = useProjectWorkspace;
