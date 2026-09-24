import { useEffect, useRef, useState } from 'react';
import { useProjectWorkspace } from './application/react';
import { createPwaUpdateAdapter, type PwaUpdateAdapter, type PwaUpdateState } from './pwa';
import { EditorSurface } from './components/editor/EditorSurface';
import { Phase3Panel } from './components/Phase3Panel';
import { CreateModal } from './components/CreateModal';
import { ProjectGallery } from './components/ProjectGallery';
import { DEFAULT_CATALOG_DEFINITION } from './catalog';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';

const projectPath = (id: string) => `/patterns/${encodeURIComponent(id)}/edit`;
function WorkspaceApp() {
  const navigate = useNavigate();
  const location = useLocation();
  const { projectId: routeProjectId } = useParams();
  const {
    initialized,
    busy,
    workspace,
    state,
    projects,
    error,
    saveState,
    createProject,
    createProjectFromConversion,
    openProject,
    deleteProject,
    importProjectAsCopy,
    exportProject,
    flush,
    metrics,
    sessionStats,
    activity,
    execute,
  } = useProjectWorkspace({ autoOpenMostRecent: false });
  const inputRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState('');
  const [pwa, setPwa] = useState<PwaUpdateAdapter | null>(null);
  const [pwaState, setPwaState] = useState<PwaUpdateState>({ supported: false, registered: false, updateAvailable: false, offlineReady: false, error: null });
  const [updating, setUpdating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [materialsOpen, setMaterialsOpen] = useState(false);
  const [createMode, setCreateMode] = useState<'blank' | 'image'>('blank');
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
  const attemptedRoute = useRef<string | null>(null);
  const isEditor = location.pathname.endsWith('/edit');
  const routeIdentity = isEditor ? location.pathname : null;
  const [resolvedRoute, setResolvedRoute] = useState<string | null>(null);
  const createDialogRef = useRef<HTMLDivElement>(null);
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const appMounted = useRef(true);
  const createLockedRef = useRef(false);
  useEffect(() => {
    appMounted.current = true;
    return () => { appMounted.current = false; clearConfirmDeleteTimer(); };
  }, []);
  const applicationRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const dialogWasOpen = useRef(false);

  const active = isEditor && state.metadata && state.document ? { metadata: state.metadata, document: state.document } : null;
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
    if (!isEditor || resolvedRoute !== routeIdentity || !initialized || state.projectId === decodedRouteId || busy || attemptedRoute.current === routeIdentity) return;
    attemptedRoute.current = routeIdentity;
    if (typeof decodedRouteId !== 'string' || decodedRouteId.length === 0 || decodedRouteId.trim() !== decodedRouteId || decodedRouteId.includes('/')) {
      setRouteIssue('This project link is malformed. Return to your patterns.');
      return;
    }
    if (!projects.some((project) => project.id === decodedRouteId)) { setRouteIssue('That local project could not be found.'); return; }
    void openProject(decodedRouteId).catch(() => {
      if (attemptedRoute.current === routeIdentity) setRouteIssue('That local project could not be opened.');
    });
  }, [busy, decodedRouteId, initialized, isEditor, openProject, projects, resolvedRoute, routeIdentity, state.projectId]);
  useEffect(() => {
    const application = applicationRef.current;
    if (!createOpen) {
      if (application) application.inert = false;
      if (dialogWasOpen.current) {
        const target = restoreFocusRef.current;
        const isRestorable = target?.isConnected && target.matches('a,button,input,textarea,select,[tabindex]:not([tabindex="-1"])');
        (isRestorable ? target : createTriggerRef.current)?.focus();
      }
      dialogWasOpen.current = false;
      return;
    }
    dialogWasOpen.current = true;
    const activeElement = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    restoreFocusRef.current = activeElement ?? restoreFocusRef.current ?? createTriggerRef.current;
    if (application) application.inert = true;
    const dialog = createDialogRef.current;
    if (!dialog) return;
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, [href], [tabindex]')].filter((item) => !item.hasAttribute('disabled') && item.tabIndex >= 0);
    focusable().find((item) => item.id === 'new-project-title')?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key === 'Escape') { event.preventDefault(); if (!createLockedRef.current) setCreateOpen(false); return; }
      if (target.getAttribute('role') === 'radio' && ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        const radios = [...dialog.querySelectorAll<HTMLElement>('[role="radio"]')];
        const current = radios.indexOf(target);
        const next = (current + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1) + radios.length) % radios.length;
        setCreateMode(next === 0 ? 'blank' : 'image');
        radios[next]?.focus();
        return;
      }
      if (event.key === 'Tab') {
        const items = focusable(); const first = items[0]; const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    dialog.addEventListener('keydown', handleKeyDown);
    return () => dialog.removeEventListener('keydown', handleKeyDown);
  }, [createOpen]);
  const saveMessage = !active
    ? ''
    : saveState.status === 'saved'
      ? 'Saved locally'
      : saveState.status === 'pending' || saveState.status === 'saving'
        ? 'Saving locally…'
        : saveState.status === 'error'
          ? 'Local save needs attention'
          : 'Local project loaded';

  function handleCreate(trigger: HTMLButtonElement) {
    createTriggerRef.current = trigger;
    restoreFocusRef.current = trigger;
    setCreateError(''); setCreateOpen(true);
  }
  async function submitCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const width = Number(createWidth); const height = Number(createHeight);
    if (createMode === 'image') return;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 1_000_000) { setCreateError('Use whole numbers from 1 upward, with no more than 1,000,000 cells total.'); return; }
    setCreateError(''); setMessage('Creating and saving your blank pattern…');
    try { const session = await createProject({ title: createTitle.trim() || 'Untitled sampler', width, height, aidaCount: Number(createAida), settings: { backgroundColor: createBackgroundColor } }); setCreateOpen(false); navigate(projectPath(session.projectId)); } catch { setCreateError('The pattern could not be saved locally.'); }
  }

  async function handleImport(file: File) {
    setMessage('');
    try {
      const session = await importProjectAsCopy(file);
      setMessage('Project imported and saved locally.');
      navigate(projectPath(session.projectId));
    } catch {
      // The accessible error below is sourced from the adapter.
    } finally {
      if (inputRef.current) inputRef.current.value = '';
    }
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
    void deleteProject(projectId).then(() => { if (appMounted.current) setMessage('Project deleted.'); }).catch(() => {
      if (appMounted.current) setMessage('The project could not be deleted.');
    });
  }

  async function handleExport() {
    setMessage('');
    try {
      const bytes = await exportProject();
      const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${(active?.metadata.title || 'needlewise-project').replace(/[^a-z0-9-_]+/gi, '-').toLowerCase()}.needlewise`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setMessage('Local archive exported.');
    } catch {
      // The adapter error is rendered below.
    }
  }

  const actionDisabled = !initialized || busy || updating;
  const routePending = isEditor && (resolvedRoute !== routeIdentity || (!routeIssue && state.projectId !== decodedRouteId));
  const routeError = isEditor && Boolean(routeIssue);
  return (
    <>
    <div ref={applicationRef} inert={createOpen} data-application data-testid="application">
    <div className={`app-shell${isEditor ? ' app-shell-editor' : ''}`}>
      {!isEditor && <header className="topbar">
        <a className="brand" href="/patterns" aria-label="Needlewise home">
          <span className="brand-mark" aria-hidden="true">✣</span><span>Needlewise</span>
        </a>
      </header>}

      <main id="workspace" data-page={isEditor ? 'editor' : 'patterns'}>
        {!initialized || routePending || routeError ? (
          <section className={`loading-panel${routeError ? ' not-found-panel' : ''}`} aria-busy={routeError ? undefined : 'true'} aria-labelledby="loading-title">
            <span className="loading-mark" aria-hidden="true">✣</span>
            <h1 id="loading-title">{routeIssue ? 'Project not found' : 'Opening your workspace…'}</h1>
            <p>{routeIssue || 'Checking for projects stored on this device.'}</p>
            {routeError && <a className="button button-primary" href="/patterns">Return to your patterns</a>}
          </section>
        ) : (
          <>
            {!isEditor && <ProjectGallery
              projects={projects}
              disabled={actionDisabled}
              onOpen={(project) => navigate(projectPath(project.id))}
              onDelete={(project) => handleDeleteClick(project.id, project.title)}
              deleteConfirmId={confirmDeleteId}
              onCreate={handleCreate}
              onImport={() => inputRef.current?.click()}
            />}
            {active && workspace && state.document && !state.usingRecovery && <EditorSurface key={state.projectId} workspace={workspace} document={state.document} onExport={() => void handleExport()} exportDisabled={actionDisabled} saveMessage={saveMessage} saveStatus={saveState.status} onOpenMaterials={() => setMaterialsOpen(true)} />}
            {isEditor && active && workspace && state.document && !state.usingRecovery && <Phase3Panel document={state.document} workspace={workspace} metrics={metrics} sessionStats={sessionStats} activity={activity} execute={execute} open={materialsOpen} onClose={() => { setMaterialsOpen(false); window.setTimeout(() => document.querySelector<HTMLButtonElement>('.info-button')?.focus(), 0); }} />}
          </>
        )}
        {!routeError && <input ref={inputRef} className="visually-hidden" type="file" accept=".needlewise,application/octet-stream" aria-label="Choose a Needlewise project archive" disabled={actionDisabled} onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleImport(file); }} />}
        {!routeError && <div className="feedback" aria-live="polite" role={error && !active ? 'alert' : undefined}>{error ? error.message : message}</div>}
      </main>
      {pwaState.updateAvailable && !routeError && <div className="update-notice" role="status"><strong>A Needlewise update is ready.</strong><span>Your current document will be saved before the update is applied.</span><button className="button button-primary" type="button" disabled={updating} onClick={() => void handleUpdate()}>{updating ? 'Updating…' : 'Update now'}</button></div>}
      <footer className="footer-note"><span aria-hidden="true">⌁</span> Local archives are your backup path <span className="footer-divider" aria-hidden="true">·</span> Keep a copy somewhere safe</footer>
    </div>
    </div>
    {createOpen && <div ref={createDialogRef}><CreateModal catalog={DEFAULT_CATALOG_DEFINITION.snapshot} mode={createMode} title={createTitle} width={createWidth} height={createHeight} aida={createAida} backgroundColor={createBackgroundColor} onBackgroundColor={setCreateBackgroundColor} busy={busy} onMode={(next) => { if (!createLockedRef.current) setCreateMode(next); }} onClose={() => { if (!createLockedRef.current) setCreateOpen(false); }} onBlank={(event) => void submitCreate(event)} onDurableCreateChange={(locked) => { createLockedRef.current = locked; }} onConversionCreate={(draft, asset) => createProjectFromConversion({ title: createTitle.trim() || 'Untitled sampler', draft, aidaCount: Number(createAida), settings: { backgroundColor: createBackgroundColor }, ...(asset ? { sourceImageAsset: asset } : {}) }).then((session) => session.projectId)} onCreated={(projectId) => { if (appMounted.current) navigate(projectPath(projectId)); }} onTitle={setCreateTitle} onWidth={setCreateWidth} onHeight={setCreateHeight} onAida={setCreateAida} /></div>}
    </>
  );
}

export default function App() { return <BrowserRouter><Routes><Route path="/patterns" element={<WorkspaceApp />} /><Route path="/patterns/:projectId/edit" element={<WorkspaceApp />} /><Route path="*" element={<Navigate to="/patterns" replace />} /></Routes></BrowserRouter>; }
