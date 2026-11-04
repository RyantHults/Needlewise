import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useProjectWorkspace } from './application/react';
import { createPwaUpdateAdapter, type PwaUpdateAdapter, type PwaUpdateState } from './pwa';
import { EditorSurface } from './components/editor/EditorSurface';
import type { PatternView } from './components/editor/ViewSwitch';
import { TrackSurface } from './components/track/TrackSurface';
import { CreateModal } from './components/CreateModal';
import { ImportReviewDialog, type ImportedPatternRequest } from './components/import/ImportReviewDialog';
import { ImportUploadModal } from './components/import/ImportUploadModal';
import { ProjectGallery } from './components/ProjectGallery';
import { HomePage } from './components/HomePage';
import { installModalScrollLock } from './components/modal-scroll-lock';
import { DEFAULT_CATALOG_DEFINITION } from './catalog';
import { DEFAULT_PATTERN_SETTINGS } from './domain';
import { BrandLink } from './components/controls/BrandLink';
import { StorageFooter } from './components/controls/StorageFooter';
import { useTimedValue } from './components/timed-value';
import { ToastProvider, usePinnedToast, useToast } from './components/toast';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { GalleryUndo, ProjectFolder, ProjectMetadata } from './persistence';

const projectPath = (id: string, view: PatternView = 'edit') => `/patterns/${encodeURIComponent(id)}/${view}`;
/** The pattern page a path names: `/patterns/:projectId/edit` or `/track`. */
const patternView = (pathname: string): PatternView | null =>
  pathname.endsWith('/edit') ? 'edit' : pathname.endsWith('/track') ? 'track' : null;
function WorkspaceApp() {
  const navigate = useNavigate();
  const location = useLocation();
  const { projectId: routeProjectId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    initialized,
    busy,
    workspace,
    state,
    projects,
    folders,
    folderAssignments,
    galleryOrders,
    projectOpens,
    error,
    createProject,
    createProjectFromConversion,
    openProject,
    deleteProjects,
    restoreDeletedProjects,
    flush,
    refreshProjectList,
    createFolder,
    renameFolder,
    deleteFolder,
    moveProjectsToFolder,
    moveFolder,
    setGalleryOrder,
    restoreGallery,
    duplicateProjects,
    renameProject,
  } = useProjectWorkspace();
  // The URL is the source of truth for the folder being viewed (so Back
  // works). We only trust it for internal logic (auto-moving newly created
  // patterns, deciding where a folder delete should navigate) once it names
  // a folder that actually exists; the raw value still goes to the gallery,
  // which falls back to the top level on its own.
  const folderIdParam = searchParams.get('folder');
  const currentFolderId = folderIdParam !== null && folders.some((folder) => folder.id === folderIdParam) ? folderIdParam : null;
  const showToast = useToast();
  const [pwa, setPwa] = useState<PwaUpdateAdapter | null>(null);
  const [pwaState, setPwaState] = useState<PwaUpdateState>({ supported: false, registered: false, updateAvailable: false, offlineReady: false, error: null });
  const [updating, setUpdating] = useState(false);
  const [importUploadOpen, setImportUploadOpen] = useState(false);
  const importReturnRef = useRef<HTMLElement | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createMode, setCreateMode] = useState<'blank' | 'image' | 'import'>('blank');
  const [createTitle, setCreateTitle] = useState('Untitled sampler');
  const [createWidth, setCreateWidth] = useState('100');
  const [createHeight, setCreateHeight] = useState('100');
  const [createAida, setCreateAida] = useState('14');
  const [createBackgroundColor, setCreateBackgroundColor] = useState(DEFAULT_PATTERN_SETTINGS.backgroundColor);
  const [, setCreateError] = useState('');
  const [routeIssue, setRouteIssue] = useState('');
  const [confirmDeleteId, setConfirmDeleteId, clearConfirmDeleteId] = useTimedValue<string>(3000);
  const [confirmDeleteFolderId, setConfirmDeleteFolderId, clearConfirmDeleteFolderId] = useTimedValue<string>(3000);
  const attemptedRoute = useRef<string | null>(null);
  const view = patternView(location.pathname);
  const isProjectPage = view !== null;
  // The project, not the page: switching between Edit and Track keeps the open project.
  const routeIdentity = isProjectPage ? location.pathname.slice(0, location.pathname.lastIndexOf('/')) : null;
  const [resolvedRoute, setResolvedRoute] = useState<string | null>(null);
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const appMounted = useRef(true);
  const createLockedRef = useRef(false);
  useEffect(() => {
    appMounted.current = true;
    return () => { appMounted.current = false; };
  }, []);
  useEffect(() => installModalScrollLock(), []);

  const active = isProjectPage && state.metadata && state.document ? { metadata: state.metadata, document: state.document } : null;
  useEffect(() => {
    const adapter = createPwaUpdateAdapter();
    setPwa(adapter);
    const unsubscribe = adapter.subscribe(() => setPwaState(adapter.state));
    void adapter.register().then(setPwaState).catch(() => setPwaState(adapter.state));
    return unsubscribe;
  }, []);
  // React Router has already decoded this value. Never decode it a second time.
  const decodedRouteId = routeProjectId;
  useEffect(() => {
    if (resolvedRoute === routeIdentity) return;
    setResolvedRoute(routeIdentity);
    setRouteIssue('');
    attemptedRoute.current = null;
  }, [resolvedRoute, routeIdentity]);
  useEffect(() => {
    if (!isProjectPage || resolvedRoute !== routeIdentity || !initialized || state.projectId === decodedRouteId || busy || attemptedRoute.current === routeIdentity) return;
    attemptedRoute.current = routeIdentity;
    if (typeof decodedRouteId !== 'string' || decodedRouteId.length === 0 || decodedRouteId.trim() !== decodedRouteId || decodedRouteId.includes('/')) {
      setRouteIssue('This project link is malformed. Return to your patterns.');
      return;
    }
    if (!projects.some((project) => project.id === decodedRouteId)) { setRouteIssue('That local project could not be found.'); return; }
    void openProject(decodedRouteId).catch(() => {
      if (attemptedRoute.current === routeIdentity) setRouteIssue('That local project could not be opened.');
    });
  }, [busy, decodedRouteId, initialized, isProjectPage, openProject, projects, resolvedRoute, routeIdentity, state.projectId]);

  function handleCreate(trigger: HTMLButtonElement) {
    createTriggerRef.current = trigger;
    setCreateError(''); setCreateOpen(true);
  }
  async function moveIntoCurrentFolder(projectId: string, targetFolderId: string | null, failureMessage: string) {
    if (!targetFolderId) return;
    try { await moveProjectsToFolder([projectId], targetFolderId); } catch { showToast({ message: failureMessage, tone: 'error' }); }
  }

  async function submitCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const width = Number(createWidth); const height = Number(createHeight);
    if (createMode === 'image') return;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 1_000_000) { setCreateError('Use whole numbers from 1 upward, with no more than 1,000,000 cells total.'); return; }
    setCreateError('');
    const targetFolderId = currentFolderId;
    try {
      const session = await createProject({ title: createTitle.trim() || 'Untitled sampler', width, height, aidaCount: Number(createAida), settings: { backgroundColor: createBackgroundColor } });
      setCreateOpen(false);
      await moveIntoCurrentFolder(session.projectId, targetFolderId, 'Pattern created, but it could not be moved into the folder.');
      navigate(projectPath(session.projectId));
    } catch { setCreateError('The pattern could not be saved locally.'); }
  }

  async function handleImportCreate({ document, title, aidaCount }: ImportedPatternRequest) {
    const targetFolderId = currentFolderId;
    const session = await createProject({ title, document, aidaCount });
    setImportFile(null);
    await moveIntoCurrentFolder(session.projectId, targetFolderId, 'Pattern imported, but it could not be moved into the folder.');
    navigate(projectPath(session.projectId));
  }

  async function handleUpdate() {
    if (!pwa) return;
    setUpdating(true);
    try { await (active ? flush() : Promise.resolve()); await pwa.activateUpdate(); showToast({ message: 'Update applied.' }); } catch { showToast({ message: 'Update could not be applied. Your current document was retained.', tone: 'error' }); } finally { setUpdating(false); }
  }

  function handleDeleteClick(project: ProjectMetadata) {
    // Two-step inline confirm: the first click arms the row, the second (or a
    // fresh click after the timeout) actually deletes.
    if (confirmDeleteId !== project.id) {
      setConfirmDeleteId(project.id);
      return;
    }
    clearConfirmDeleteId();
    void handleDeleteProjects([project]);
  }

  async function handleDeleteProjects(selected: readonly ProjectMetadata[]) {
    const ids = selected.map((project) => project.id);
    const single = ids.length === 1;
    try {
      await deleteProjects(ids);
    } catch {
      showToast({ message: single ? 'The pattern could not be deleted.' : 'The patterns could not be deleted.', tone: 'error' });
      return;
    }
    if (!appMounted.current) return;
    showToast({
      message: single ? 'Pattern deleted.' : `Deleted ${ids.length} patterns.`,
      action: {
        label: 'Undo',
        run: () => {
          void restoreDeletedProjects(ids).then(() => {
            showToast({ message: 'Delete undone.' });
          }).catch(() => {
            showToast({ message: 'The delete could not be undone.', tone: 'error' });
          });
        },
      },
    });
  }

  async function handleDuplicateProjects(selected: readonly ProjectMetadata[]) {
    try {
      await duplicateProjects(selected.map((project) => project.id), currentFolderId);
      showToast({ message: selected.length === 1 ? 'Pattern duplicated.' : `Duplicated ${selected.length} patterns.` });
    } catch {
      showToast({ message: 'The pattern could not be duplicated.', tone: 'error' });
    }
  }

  async function handleReorder(levelId: string, keys: readonly string[]) {
    try { await setGalleryOrder(levelId, keys); } catch { showToast({ message: 'The order could not be saved.', tone: 'error' }); }
  }

  async function handleRenameProject(project: ProjectMetadata, title: string) {
    try {
      await renameProject(project.id, title);
      showToast({ message: 'Pattern renamed.' });
    } catch {
      showToast({ message: 'The pattern could not be renamed.', tone: 'error' });
    }
  }

  function handleNavigateFolder(folderId: string | null) {
    if (folderId === null) { setSearchParams({}); return; }
    setSearchParams({ folder: folderId });
  }

  async function handleCreateFolder(name: string, parentId: string | null) {
    try { await createFolder(name, parentId); showToast({ message: 'Folder created.' }); } catch { showToast({ message: 'The folder could not be created.', tone: 'error' }); }
  }

  async function handleRenameFolder(folderId: string, name: string) {
    try { await renameFolder(folderId, name); showToast({ message: 'Folder renamed.' }); } catch { showToast({ message: 'The folder could not be renamed.', tone: 'error' }); }
  }

  function folderName(folderId: string | null): string {
    if (folderId === null) return 'Projects';
    return folders.find((folder) => folder.id === folderId)?.name ?? 'Projects';
  }

  function showMoveToast(message: string, undo: GalleryUndo) {
    showToast({
      message,
      action: {
        label: 'Undo',
        run: () => {
          void restoreGallery(undo).then(() => {
            showToast({ message: 'Move undone.' });
          }).catch(() => {
            showToast({ message: 'The move could not be undone.', tone: 'error' });
          });
        },
      },
    });
  }

  function handleMoveProjects(selected: readonly ProjectMetadata[], folderId: string | null) {
    const single = selected.length === 1;
    return moveProjectsToFolder(selected.map((project) => project.id), folderId).then((undo) => {
      if (appMounted.current) showMoveToast(single ? `Moved “${selected[0].title}” to ${folderName(folderId)}` : `Moved ${selected.length} patterns to ${folderName(folderId)}`, undo);
    }).catch(() => {
      showToast({ message: single ? 'The pattern could not be moved.' : 'The patterns could not be moved.', tone: 'error' });
    });
  }

  async function handleGroupProjects(dragged: readonly ProjectMetadata[], target: ProjectMetadata, parentId: string | null) {
    try {
      const created = await createFolder('New folder', parentId, [target.id, ...dragged.map((project) => project.id)], target.id);
      if (!appMounted.current) return;
      showToast({
        message: dragged.length === 1
          ? `Created “New folder” with “${target.title}” and “${dragged[0].title}”`
          : `Created “New folder” with ${dragged.length + 1} patterns`,
        action: {
          label: 'Undo',
          run: () => {
            void restoreGallery(created.undo).then(() => {
              showToast({ message: 'Folder removed.' });
            }).catch(() => {
              showToast({ message: 'The folder could not be removed.', tone: 'error' });
            });
          },
        },
      });
    } catch {
      showToast({ message: 'The folder could not be created.', tone: 'error' });
    }
  }

  function handleMoveFolder(folder: ProjectFolder, parentId: string | null) {
    return moveFolder(folder.id, parentId).then((undo) => {
      if (appMounted.current) showMoveToast(`Moved “${folder.name}” to ${folderName(parentId)}`, undo);
    }).catch(() => {
      showToast({ message: 'The folder could not be moved.', tone: 'error' });
    });
  }

  function handleDeleteFolderClick(folder: ProjectFolder) {
    // Two-step inline confirm, mirroring handleDeleteClick above but with its
    // own state and timer so a project delete and a folder delete don't
    // interfere with each other.
    if (confirmDeleteFolderId !== folder.id) {
      setConfirmDeleteFolderId(folder.id);
      return;
    }
    clearConfirmDeleteFolderId();
    // If the deleted folder is the one being viewed, or is the parent of the
    // one being viewed, the view can no longer show what it was showing:
    // step up to the deleted folder's own parent.
    const viewedFolder = folders.find((candidate) => candidate.id === currentFolderId) ?? null;
    const shouldNavigateUp = currentFolderId === folder.id || viewedFolder?.parentId === folder.id;
    void deleteFolder(folder.id).then(() => {
      showToast({ message: 'Folder deleted. Its patterns moved up a level.' });
      if (shouldNavigateUp && appMounted.current) handleNavigateFolder(folder.parentId);
    }).catch(() => {
      showToast({ message: 'The folder could not be deleted.', tone: 'error' });
    });
  }

  const actionDisabled = !initialized || busy || updating;
  const routePending = isProjectPage && (resolvedRoute !== routeIdentity || (!routeIssue && state.projectId !== decodedRouteId));
  const routeError = isProjectPage && Boolean(routeIssue);
  useEffect(() => {
    if (error) showToast({ message: error.message, tone: 'error' });
  }, [error, showToast]);
  usePinnedToast(pwaState.updateAvailable && !routeError ? {
    message: 'A Needlewise update is ready. Your current document will be saved first.',
    action: { label: updating ? 'Updating…' : 'Update now', run: () => void handleUpdate() },
  } : null);
  // The gallery carries the brand in its own header; other non-project states keep the plain topbar.
  const galleryVisible = !isProjectPage && initialized;
  // Editor autosaves bypass the hook's actions, so the listing is stale after navigating back.
  useEffect(() => {
    if (galleryVisible) void refreshProjectList();
  }, [galleryVisible, refreshProjectList]);
  return (
    <>
    <div data-application data-testid="application">
    <div className={`app-shell${isProjectPage ? ' app-shell-editor' : ''}`}>
      {!isProjectPage && !galleryVisible && <header className="topbar"><BrandLink /></header>}

      <main id="workspace" data-page={view === 'track' ? 'track' : isProjectPage ? 'editor' : 'patterns'}>
        {!initialized || routePending || routeError ? (
          <section className={`loading-panel${routeError ? ' not-found-panel' : ''}`} aria-busy={routeError ? undefined : 'true'} aria-labelledby="loading-title">
            <span className="loading-mark" aria-hidden="true">✣</span>
            <h1 id="loading-title">{routeIssue ? 'Project not found' : 'Opening your workspace…'}</h1>
            <p>{routeIssue || 'Checking for projects stored on this device.'}</p>
            {routeError && <Link className="button button-primary" to="/patterns">Return to your patterns</Link>}
          </section>
        ) : (
          <>
            {!isProjectPage && <ProjectGallery
              brand={<BrandLink />}
              projects={projects}
              disabled={actionDisabled}
              onOpen={(project) => navigate(projectPath(project.id))}
              onDelete={handleDeleteClick}
              onRenameProject={handleRenameProject}
              onDuplicateProjects={handleDuplicateProjects}
              onDeleteProjects={handleDeleteProjects}
              deleteConfirmId={confirmDeleteId}
              onCreate={handleCreate}
              onImport={() => { importReturnRef.current = globalThis.document.activeElement as HTMLElement | null; setImportUploadOpen(true); }}
              folders={folders}
              folderAssignments={folderAssignments}
              galleryOrders={galleryOrders}
              projectOpens={projectOpens}
              currentFolderId={folderIdParam}
              onNavigateFolder={handleNavigateFolder}
              onCreateFolder={handleCreateFolder}
              onRenameFolder={handleRenameFolder}
              onDeleteFolder={handleDeleteFolderClick}
              folderDeleteConfirmId={confirmDeleteFolderId}
              onMoveProjects={handleMoveProjects}
              onMoveFolder={handleMoveFolder}
              onGroupProjects={handleGroupProjects}
              onReorder={handleReorder}
            />}
            {view === 'edit' && active && workspace && state.document && !state.usingRecovery && <EditorSurface key={state.projectId} workspace={workspace} document={state.document} onNavigate={(next) => navigate(projectPath(active.metadata.id, next))} onRenameTitle={(title) => void handleRenameProject(active.metadata, title)} />}
            {view === 'track' && active && workspace && state.document && !state.usingRecovery && <TrackSurface key={state.projectId} workspace={workspace} document={state.document} title={active.metadata.title} metrics={state.metrics ?? null} onNavigate={(next) => navigate(projectPath(active.metadata.id, next))} onRenameTitle={(title) => void handleRenameProject(active.metadata, title)} />}
          </>
        )}
      </main>
      <StorageFooter />
    </div>
    </div>
    {importUploadOpen && <ImportUploadModal returnFocus={importReturnRef} onClose={() => setImportUploadOpen(false)} onFile={(chosen) => { setImportUploadOpen(false); setImportFile(chosen); }} />}
    {importFile && <ImportReviewDialog file={importFile} returnFocus={importReturnRef} onClose={() => setImportFile(null)} onCreate={handleImportCreate} />}
    {createOpen && <CreateModal onImportFile={(chosen) => { importReturnRef.current = createTriggerRef.current; setCreateOpen(false); setImportFile(chosen); }} returnFocus={createTriggerRef} catalog={DEFAULT_CATALOG_DEFINITION.snapshot} mode={createMode} title={createTitle} width={createWidth} height={createHeight} aida={createAida} backgroundColor={createBackgroundColor} onBackgroundColor={setCreateBackgroundColor} busy={busy} onMode={(next) => { if (!createLockedRef.current) setCreateMode(next); }} onClose={() => { if (!createLockedRef.current) setCreateOpen(false); }} onBlank={(event) => void submitCreate(event)} onDurableCreateChange={(locked) => { createLockedRef.current = locked; }} onConversionCreate={(draft, asset) => { const targetFolderId = currentFolderId; return createProjectFromConversion({ title: createTitle.trim() || 'Untitled sampler', draft, aidaCount: Number(createAida), settings: { backgroundColor: createBackgroundColor }, ...(asset ? { sourceImageAsset: asset } : {}) }).then(async (session) => { await moveIntoCurrentFolder(session.projectId, targetFolderId, 'Pattern created, but it could not be moved into the folder.'); return session.projectId; }); }} onCreated={(projectId) => { if (appMounted.current) navigate(projectPath(projectId)); }} onTitle={setCreateTitle} onWidth={setCreateWidth} onHeight={setCreateHeight} onAida={setCreateAida} />}
    </>
  );
}

/**
 * The symbol pool curation tool. It only exists in a dev build, and is loaded
 * lazily so the picker, the font it previews, and the dev-only save endpoint
 * never reach a deployed bundle.
 */
const SymbolPickerPage = import.meta.env.DEV
  ? lazy(() => import('./dev/SymbolPickerPage'))
  : null;

/**
 * The theme editor overlay. Like the symbol picker it only exists in a dev
 * build, and is loaded lazily so the panel and the dev-only theme file
 * endpoints never reach a deployed bundle. It sits outside the routes so it
 * stays open across navigation. Vitest runs as dev too, so test mode is
 * excluded to keep the overlay out of the App tests.
 */
const ThemeEditor = import.meta.env.DEV && import.meta.env.MODE !== 'test'
  ? lazy(() => import('./dev/ThemeEditor'))
  : null;

function AppContent() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/patterns" element={<WorkspaceApp />} />
        <Route path="/patterns/:projectId/edit" element={<WorkspaceApp />} />
        <Route path="/patterns/:projectId/track" element={<WorkspaceApp />} />
        {SymbolPickerPage && (
          <Route
            path="/__symbols"
            element={<Suspense fallback={<p className="loading-panel">Loading the symbol picker…</p>}><SymbolPickerPage /></Suspense>}
          />
        )}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {ThemeEditor && <Suspense fallback={null}><ThemeEditor /></Suspense>}
    </BrowserRouter>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AppContent />
    </ToastProvider>
  );
}
