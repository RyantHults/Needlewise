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
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { ProjectFolder, ProjectMetadata } from './persistence';
import { isPostHogConfigured, posthog, posthogLogger } from './posthog';

const projectPath = (id: string, view: PatternView = 'edit') => `/patterns/${encodeURIComponent(id)}/${view}`;
/** The pattern page a path names: `/patterns/:projectId/edit` or `/track`. */
const patternView = (pathname: string): PatternView | null =>
  pathname.endsWith('/edit') ? 'edit' : pathname.endsWith('/track') ? 'track' : null;
interface UndoableMove { kind: 'project' | 'folder'; id: string; name: string; from: string | null; to: string | null }
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
    error,
    createProject,
    createProjectFromConversion,
    openProject,
    deleteProject,
    flush,
    refreshProjectList,
    createFolder,
    renameFolder,
    deleteFolder,
    moveProjectToFolder,
    moveFolder,
    duplicateProject,
    renameProject,
  } = useProjectWorkspace({ autoOpenMostRecent: false });
  // The URL is the source of truth for the folder being viewed (so Back
  // works). We only trust it for internal logic (auto-moving newly created
  // patterns, deciding where a folder delete should navigate) once it names
  // a folder that actually exists; the raw value still goes to the gallery,
  // which falls back to the top level on its own.
  const folderIdParam = searchParams.get('folder');
  const currentFolderId = folderIdParam !== null && folders.some((folder) => folder.id === folderIdParam) ? folderIdParam : null;
  const [message, setMessage] = useState('');
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
  const [createBackgroundColor, setCreateBackgroundColor] = useState('#F3EEE5');
  const [, setCreateError] = useState('');
  const [routeIssue, setRouteIssue] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const confirmDeleteTimer = useRef<number | null>(null);
  const clearConfirmDeleteTimer = () => { if (confirmDeleteTimer.current !== null) { window.clearTimeout(confirmDeleteTimer.current); confirmDeleteTimer.current = null; } };
  const [confirmDeleteFolderId, setConfirmDeleteFolderId] = useState<string | null>(null);
  const confirmDeleteFolderTimer = useRef<number | null>(null);
  const clearConfirmDeleteFolderTimer = () => { if (confirmDeleteFolderTimer.current !== null) { window.clearTimeout(confirmDeleteFolderTimer.current); confirmDeleteFolderTimer.current = null; } };
  const [undoMove, setUndoMove] = useState<UndoableMove | null>(null);
  const undoMoveTimer = useRef<number | null>(null);
  const clearUndoMoveTimer = () => { if (undoMoveTimer.current !== null) { window.clearTimeout(undoMoveTimer.current); undoMoveTimer.current = null; } };
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
    return () => { appMounted.current = false; clearConfirmDeleteTimer(); clearConfirmDeleteFolderTimer(); clearUndoMoveTimer(); };
  }, []);
  useEffect(() => installModalScrollLock(), []);

  const active = isProjectPage && state.metadata && state.document ? { metadata: state.metadata, document: state.document } : null;
  const capture = (event: string, properties?: Record<string, string | number | boolean>) => {
    if (isPostHogConfigured) posthog.capture(event, properties);
  };
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
    try { await moveProjectToFolder(projectId, targetFolderId); } catch { setMessage(failureMessage); }
  }

  async function submitCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const width = Number(createWidth); const height = Number(createHeight);
    if (createMode === 'image') return;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 1_000_000) { setCreateError('Use whole numbers from 1 upward, with no more than 1,000,000 cells total.'); return; }
    setCreateError(''); setMessage('Creating and saving your blank pattern…');
    const targetFolderId = currentFolderId;
    try {
      const session = await createProject({ title: createTitle.trim() || 'Untitled sampler', width, height, aidaCount: Number(createAida), settings: { backgroundColor: createBackgroundColor } });
      setCreateOpen(false);
      await moveIntoCurrentFolder(session.projectId, targetFolderId, 'Pattern created, but it could not be moved into the folder.');
      capture('pattern_created', { width, height, aida_count: Number(createAida) });
      posthogLogger.info('local pattern created', { width, height, aida_count: Number(createAida), placed_in_folder: targetFolderId !== null });
      navigate(projectPath(session.projectId));
    } catch { setCreateError('The pattern could not be saved locally.'); }
  }

  async function handleImportCreate({ document, title, aidaCount, format }: ImportedPatternRequest) {
    const targetFolderId = currentFolderId;
    const session = await createProject({ title, document, aidaCount });
    setImportFile(null);
    await moveIntoCurrentFolder(session.projectId, targetFolderId, 'Pattern imported, but it could not be moved into the folder.');
    capture('pattern_imported', { format });
    posthogLogger.info('pattern imported', { format, placed_in_folder: targetFolderId !== null });
    navigate(projectPath(session.projectId));
  }

  async function handleUpdate() {
    if (!pwa) return;
    setUpdating(true); setMessage('Saving before update…');
    try { await (active ? flush() : Promise.resolve()); await pwa.activateUpdate(); setMessage('Update applied.'); } catch { setMessage('Update could not be applied. Your current document was retained.'); } finally { setUpdating(false); }
  }

  function handleDeleteClick(projectId: string, title: string) {
    // Two-step inline confirm: the first click arms the row, the second (or a
    // fresh click after the timeout) actually deletes.
    if (confirmDeleteId !== projectId) {
      clearConfirmDeleteTimer();
      setConfirmDeleteId(projectId);
      confirmDeleteTimer.current = window.setTimeout(() => { setConfirmDeleteId(null); confirmDeleteTimer.current = null; }, 3000);
      return;
    }
    clearConfirmDeleteTimer();
    setConfirmDeleteId(null);
    setMessage(`Deleting “${title}”…`);
    void deleteProject(projectId).then(() => { capture('pattern_deleted'); if (appMounted.current) setMessage('Project deleted.'); }).catch(() => {
      if (appMounted.current) setMessage('The project could not be deleted.');
    });
  }

  async function handleDuplicate(project: ProjectMetadata) {
    setMessage(`Duplicating “${project.title}”…`);
    const targetFolderId = currentFolderId;
    try {
      const copy = await duplicateProject(project.id);
      await moveIntoCurrentFolder(copy.id, targetFolderId, 'Pattern duplicated, but it could not be moved into the folder.');
      capture('pattern_duplicated');
      if (appMounted.current) setMessage('Pattern duplicated.');
    } catch {
      if (appMounted.current) setMessage('The pattern could not be duplicated.');
    }
  }

  async function handleRenameProject(project: ProjectMetadata, title: string) {
    setMessage('');
    try {
      await renameProject(project.id, title);
      capture('pattern_renamed');
      if (appMounted.current) setMessage('Pattern renamed.');
    } catch {
      if (appMounted.current) setMessage('The pattern could not be renamed.');
    }
  }

  function handleNavigateFolder(folderId: string | null) {
    if (folderId === null) { setSearchParams({}); return; }
    setSearchParams({ folder: folderId });
  }

  async function handleCreateFolder(name: string, parentId: string | null) {
    setMessage('');
    try { await createFolder(name, parentId); capture('folder_created', { is_nested: parentId !== null }); setMessage('Folder created.'); } catch { setMessage('The folder could not be created.'); }
  }

  async function handleRenameFolder(folderId: string, name: string) {
    setMessage('');
    try { await renameFolder(folderId, name); capture('folder_renamed'); setMessage('Folder renamed.'); } catch { setMessage('The folder could not be renamed.'); }
  }

  function folderName(folderId: string | null): string {
    if (folderId === null) return 'Projects';
    return folders.find((folder) => folder.id === folderId)?.name ?? 'Projects';
  }

  function showUndoToast(move: UndoableMove) {
    clearUndoMoveTimer();
    setUndoMove(move);
    undoMoveTimer.current = window.setTimeout(() => { setUndoMove(null); undoMoveTimer.current = null; }, 6000);
  }

  function handleUndoMove() {
    if (!undoMove) return;
    clearUndoMoveTimer();
    const move = undoMove;
    setUndoMove(null);
    const reverse = move.kind === 'project' ? moveProjectToFolder(move.id, move.from) : moveFolder(move.id, move.from);
    void reverse.then(() => {
      if (appMounted.current) setMessage('Move undone.');
    }).catch(() => {
      if (appMounted.current) setMessage('The move could not be undone.');
    });
  }

  function handleMoveProject(project: ProjectMetadata, folderId: string | null) {
    setMessage('');
    const previousFolderId = folderAssignments.find((assignment) => assignment.projectId === project.id)?.folderId ?? null;
    void moveProjectToFolder(project.id, folderId).then(() => {
      capture('pattern_moved', { moved_to_top_level: folderId === null });
      if (appMounted.current) showUndoToast({ kind: 'project', id: project.id, name: project.title, from: previousFolderId, to: folderId });
    }).catch(() => {
      if (appMounted.current) setMessage('The pattern could not be moved.');
    });
  }

  function handleMoveFolder(folder: ProjectFolder, parentId: string | null) {
    setMessage('');
    const previousParentId = folder.parentId;
    void moveFolder(folder.id, parentId).then(() => {
      capture('folder_moved', { moved_to_top_level: parentId === null });
      if (appMounted.current) showUndoToast({ kind: 'folder', id: folder.id, name: folder.name, from: previousParentId, to: parentId });
    }).catch(() => {
      if (appMounted.current) setMessage('The folder could not be moved.');
    });
  }

  function handleDeleteFolderClick(folder: ProjectFolder) {
    // Two-step inline confirm, mirroring handleDeleteClick above but with its
    // own state and timer so a project delete and a folder delete don't
    // interfere with each other.
    if (confirmDeleteFolderId !== folder.id) {
      clearConfirmDeleteFolderTimer();
      setConfirmDeleteFolderId(folder.id);
      confirmDeleteFolderTimer.current = window.setTimeout(() => { setConfirmDeleteFolderId(null); confirmDeleteFolderTimer.current = null; }, 3000);
      return;
    }
    clearConfirmDeleteFolderTimer();
    setConfirmDeleteFolderId(null);
    setMessage('Deleting folder…');
    // If the deleted folder is the one being viewed, or is the parent of the
    // one being viewed, the view can no longer show what it was showing:
    // step up to the deleted folder's own parent.
    const viewedFolder = folders.find((candidate) => candidate.id === currentFolderId) ?? null;
    const shouldNavigateUp = currentFolderId === folder.id || viewedFolder?.parentId === folder.id;
    void deleteFolder(folder.id).then(() => {
      capture('folder_deleted');
      if (!appMounted.current) return;
      setMessage('Folder deleted. Its patterns moved up a level.');
      if (shouldNavigateUp) handleNavigateFolder(folder.parentId);
    }).catch(() => {
      if (appMounted.current) setMessage('The folder could not be deleted.');
    });
  }

  const actionDisabled = !initialized || busy || updating;
  const routePending = isProjectPage && (resolvedRoute !== routeIdentity || (!routeIssue && state.projectId !== decodedRouteId));
  const routeError = isProjectPage && Boolean(routeIssue);
  // The gallery carries the brand in its own header; other non-project states keep the plain topbar.
  const galleryVisible = !isProjectPage && initialized;
  // Editor autosaves bypass the hook's actions, so the listing is stale after navigating back.
  useEffect(() => {
    if (galleryVisible) void refreshProjectList();
  }, [galleryVisible, refreshProjectList]);
  const brand = (
    <Link className="brand" to="/" aria-label="Needlewise home">
      <span className="brand-mark" aria-hidden="true">✣</span><span>Needlewise</span>
    </Link>
  );
  return (
    <>
    <div data-application data-testid="application">
    <div className={`app-shell${isProjectPage ? ' app-shell-editor' : ''}`}>
      {!isProjectPage && !galleryVisible && <header className="topbar">{brand}</header>}

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
              brand={brand}
              projects={projects}
              disabled={actionDisabled}
              onOpen={(project) => navigate(projectPath(project.id))}
              onDelete={(project) => handleDeleteClick(project.id, project.title)}
              onRenameProject={handleRenameProject}
              onDuplicate={(project) => void handleDuplicate(project)}
              deleteConfirmId={confirmDeleteId}
              onCreate={handleCreate}
              onImport={() => { importReturnRef.current = globalThis.document.activeElement as HTMLElement | null; setImportUploadOpen(true); }}
              folders={folders}
              folderAssignments={folderAssignments}
              currentFolderId={folderIdParam}
              onNavigateFolder={handleNavigateFolder}
              onCreateFolder={handleCreateFolder}
              onRenameFolder={handleRenameFolder}
              onDeleteFolder={handleDeleteFolderClick}
              folderDeleteConfirmId={confirmDeleteFolderId}
              onMoveProject={handleMoveProject}
              onMoveFolder={handleMoveFolder}
            />}
            {view === 'edit' && active && workspace && state.document && !state.usingRecovery && <EditorSurface key={state.projectId} workspace={workspace} document={state.document} onNavigate={(next) => navigate(projectPath(active.metadata.id, next))} onRenameTitle={(title) => void handleRenameProject(active.metadata, title)} />}
            {view === 'track' && active && workspace && state.document && !state.usingRecovery && <TrackSurface key={state.projectId} workspace={workspace} document={state.document} title={active.metadata.title} metrics={state.metrics ?? null} onNavigate={(next) => navigate(projectPath(active.metadata.id, next))} onRenameTitle={(title) => void handleRenameProject(active.metadata, title)} />}
          </>
        )}
        {!routeError && <div className="feedback" aria-live="polite" role={error && !active ? 'alert' : undefined}>{error ? error.message : message}</div>}
      </main>
      {!isProjectPage && !routeError && undoMove && <div className="undo-toast" role="status"><span className="undo-toast-text">Moved “{undoMove.name}” to {folderName(undoMove.to)}</span><button className="undo-toast-action" type="button" onClick={handleUndoMove}>Undo</button></div>}
      {pwaState.updateAvailable && !routeError && <div className="update-notice" role="status"><strong>A Needlewise update is ready.</strong><span>Your current document will be saved before the update is applied.</span><button className="button button-primary" type="button" disabled={updating} onClick={() => void handleUpdate()}>{updating ? 'Updating…' : 'Update now'}</button></div>}
      <footer className="footer-note"><span aria-hidden="true">⌁</span> Stored on this device <span className="footer-divider" aria-hidden="true">·</span> Works offline</footer>
    </div>
    </div>
    {importUploadOpen && <ImportUploadModal returnFocus={importReturnRef} onClose={() => setImportUploadOpen(false)} onFile={(chosen) => { setImportUploadOpen(false); setImportFile(chosen); }} />}
    {importFile && <ImportReviewDialog file={importFile} returnFocus={importReturnRef} onClose={() => setImportFile(null)} onCreate={handleImportCreate} />}
    {createOpen && <CreateModal onImportFile={(chosen) => { importReturnRef.current = createTriggerRef.current; setCreateOpen(false); setImportFile(chosen); }} returnFocus={createTriggerRef} catalog={DEFAULT_CATALOG_DEFINITION.snapshot} mode={createMode} title={createTitle} width={createWidth} height={createHeight} aida={createAida} backgroundColor={createBackgroundColor} onBackgroundColor={setCreateBackgroundColor} busy={busy} onMode={(next) => { if (!createLockedRef.current) setCreateMode(next); }} onClose={() => { if (!createLockedRef.current) setCreateOpen(false); }} onBlank={(event) => void submitCreate(event)} onDurableCreateChange={(locked) => { createLockedRef.current = locked; }} onConversionCreate={(draft, asset) => { const targetFolderId = currentFolderId; return createProjectFromConversion({ title: createTitle.trim() || 'Untitled sampler', draft, aidaCount: Number(createAida), settings: { backgroundColor: createBackgroundColor }, ...(asset ? { sourceImageAsset: asset } : {}) }).then(async (session) => { await moveIntoCurrentFolder(session.projectId, targetFolderId, 'Pattern created, but it could not be moved into the folder.'); capture('image_pattern_created', { width: draft.document.width, height: draft.document.height, aida_count: Number(createAida), source_image_retained: Boolean(asset) }); return session.projectId; }); }} onCreated={(projectId) => { if (appMounted.current) navigate(projectPath(projectId)); }} onTitle={setCreateTitle} onWidth={setCreateWidth} onHeight={setCreateHeight} onAida={setCreateAida} />}
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

export default function App() {
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
    </BrowserRouter>
  );
}
