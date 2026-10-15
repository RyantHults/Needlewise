import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { useProjectWorkspace } from './application/react';
import { ProjectGallery } from './components/ProjectGallery';
import { DEFAULT_CATALOG_DEFINITION } from './catalog';
import { createDocument } from './domain';

vi.mock('./application/react', () => ({ useProjectWorkspace: vi.fn() }));
// Wraps the real gallery so every existing test still renders it unchanged;
// the undo-toast tests below swap in a persistent override (reset to the
// real component before every test) to trigger onMoveProject directly
// instead of driving the gallery's drag-and-drop, which jsdom can't
// simulate. A `mockImplementationOnce` isn't enough here: WorkspaceApp
// re-renders (its effects fire post-mount) call the gallery mock more than
// once, so a one-shot override gets replaced by the real component before a
// test can interact with it.
const galleryControls = vi.hoisted(() => ({ real: null as unknown as typeof import('./components/ProjectGallery').ProjectGallery }));
vi.mock('./components/ProjectGallery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./components/ProjectGallery')>();
  galleryControls.real = actual.ProjectGallery as never;
  return { ProjectGallery: vi.fn(actual.ProjectGallery) };
});
const conversion = vi.hoisted(() => ({ convert: vi.fn() }));
vi.mock('./conversion/image-conversion-client', () => ({
  convertImageToPattern: conversion.convert,
  ConversionCancelledError: class ConversionCancelledError extends Error {}
}));
// The mocked conversion drafts are intentionally minimal (no token/planes),
// so draft acceptance is a passthrough here; the conversion-create test needs
// create() to reach the workspace call instead of failing draft validation.
vi.mock('./conversion/image-to-pattern', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./conversion/image-to-pattern')>();
  return { ...actual, acceptConversionDraft: (draft: unknown) => draft };
});
const pwaControls = vi.hoisted(() => ({
  adapter: { state: { supported: true, registered: true, updateAvailable: false, offlineReady: false, error: null }, register: vi.fn(), activateUpdate: vi.fn(), subscribe: vi.fn(() => () => undefined) },
}));
vi.mock('./pwa', () => ({ createPwaUpdateAdapter: vi.fn(() => pwaControls.adapter) }));

const images: MockImage[] = [];
class MockImage {
  naturalWidth = 1;
  naturalHeight = 1;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) { images.push(this); }
}

vi.mock('./import/registry', () => ({
  importerAccept: () => '.pdf,application/pdf',
  findImporter: (head: Uint8Array) => (new TextDecoder().decode(head).startsWith('%PDF-') ? { id: 'pdf' } : undefined)
}));
vi.mock('./components/import/ImportReviewDialog', () => ({
  ImportReviewDialog: ({ file, onCreate }: { file: File; onCreate: (request: unknown) => Promise<void> }) => (
    <div role="dialog" aria-label="Import review">{file.name}<button type="button" onClick={() => void onCreate({ document: { width: 1, height: 1 }, title: 'Imported', aidaCount: 14, format: 'pdf' })}>Finish import</button></div>
  )
}));

const mockedWorkspace = vi.mocked(useProjectWorkspace);
const createProject = vi.fn().mockResolvedValue({ projectId: 'new-project' });
const createProjectFromConversion = vi.fn().mockResolvedValue({ projectId: 'new-project' });
const exportProject = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
const openProject = vi.fn().mockResolvedValue(undefined);
const flush = vi.fn().mockResolvedValue(undefined);
const deleteProject = vi.fn().mockResolvedValue(undefined);
const createFolder = vi.fn().mockResolvedValue({ id: 'folder-new', name: 'New folder', parentId: null, createdAt: 1, updatedAt: 1 });
const renameFolder = vi.fn().mockResolvedValue({ id: 'folder-one', name: 'Renamed', parentId: null, createdAt: 1, updatedAt: 2 });
const deleteFolder = vi.fn().mockResolvedValue(undefined);
const moveProjectToFolder = vi.fn().mockResolvedValue(undefined);
const moveFolder = vi.fn().mockResolvedValue(undefined);
const renameProject = vi.fn().mockResolvedValue({ id: 'one', title: 'Renamed', notes: '', createdAt: 1, updatedAt: 2, revision: 4 });
const duplicateProject = vi.fn().mockResolvedValue({ id: 'copy-id', title: 'Garden sampler copy', notes: '', createdAt: 3, updatedAt: 3, revision: 4 });
const editorWorkspace = { metadata: { title: 'Garden sampler', notes: '', aidaCount: 14 }, canUndoProgress: false, canRedoProgress: false, clearProgressHistory: vi.fn(), catalogFor: () => DEFAULT_CATALOG_DEFINITION, availableCatalogs: () => [DEFAULT_CATALOG_DEFINITION], catalogById: (id: string) => id === DEFAULT_CATALOG_DEFINITION.association.catalogId ? DEFAULT_CATALOG_DEFINITION : undefined };

const baseWorkspace = {
  initialized: true,
  busy: false,
  state: { projectId: null, metadata: null, document: null, save: { status: 'idle', dirty: false, pendingRevision: null, lastSavedRevision: null, error: null }, error: null },
  projects: [],
  folders: [],
  folderAssignments: [],
  error: null,
  saveState: { status: 'idle', dirty: false, pendingRevision: null, lastSavedRevision: null, error: null },
  workspace: null,
  createProject,
  createProjectFromConversion,
  openProject,
  selectProject: vi.fn(),
  deleteProject,
  exportProject,
  flush,
  createFolder,
  renameFolder,
  deleteFolder,
  moveProjectToFolder,
  moveFolder,
  duplicateProject,
  renameProject,
};

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/patterns');
  pwaControls.adapter.state.updateAvailable = false;
  pwaControls.adapter.register.mockResolvedValue(pwaControls.adapter.state);
  mockedWorkspace.mockReturnValue(baseWorkspace as never);
  // clearAllMocks() only clears call history, not implementations: restore
  // the real gallery so a previous test's onMoveProject-triggering override
  // (see the undo-toast tests below) never leaks into the next test.
  vi.mocked(ProjectGallery).mockImplementation(galleryControls.real);
});

describe('application shell', () => {
  it('shows a truthful loading state while the workspace initializes', () => {
    mockedWorkspace.mockReturnValue({ ...baseWorkspace, initialized: false, busy: true } as never);
    render(<App />);

    expect(screen.getByRole('heading', { name: 'Opening your workspace…' })).toBeInTheDocument();
    expect(screen.queryByText('Saved locally')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Needlewise home' }).closest('header')).toHaveClass('topbar');
  });

  it('puts the brand in the gallery header instead of the topbar once the gallery shows', () => {
    window.history.replaceState({}, '', '/patterns');
    render(<App />);
    const brands = screen.getAllByRole('link', { name: 'Needlewise home' });
    expect(brands).toHaveLength(1);
    expect(brands[0].closest('header')).toHaveClass('project-gallery-header');
    expect(document.querySelector('header.topbar')).toBeNull();
  });

  it('creates the starter project from the empty workspace', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'New Pattern' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create blank pattern' }));

    await waitFor(() => expect(createProject).toHaveBeenCalledOnce());
  });

  it('opens the import review for a chosen PDF and creates the project from it', async () => {
    window.history.replaceState({}, '', '/patterns?folder=folder-one');
    mockedWorkspace.mockReturnValue({ ...baseWorkspace, projects: [{ id: 'one', title: 'One', notes: '', createdAt: 1, updatedAt: 2, revision: 1 }], folders: [{ id: 'folder-one', name: 'Folder', parentId: null, createdAt: 1, updatedAt: 1 }] } as never);
    render(<App />);
    expect(screen.queryByLabelText('Choose a pattern file to import')).not.toBeInTheDocument();
    const importButton = screen.getAllByRole('button', { name: 'Import Pattern' })[0];
    importButton.focus();
    fireEvent.click(importButton);
    const upload = screen.getByRole('dialog', { name: 'Import a pattern' });
    const input = within(upload).getByLabelText('Choose a pattern file to import');
    expect(input).toHaveAttribute('accept', '.pdf,application/pdf');

    fireEvent.change(input, { target: { files: [new File(['plain text'], 'notes.txt', { type: 'text/plain' })] } });
    expect(await within(upload).findByRole('alert')).toHaveTextContent('not a pattern Needlewise can import');
    expect(screen.queryByRole('dialog', { name: 'Import review' })).not.toBeInTheDocument();

    const file = new File(['%PDF-'], 'garden.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByRole('dialog', { name: 'Import review' })).toHaveTextContent('garden.pdf');
    expect(screen.queryByRole('dialog', { name: 'Import a pattern' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Finish import' }));
    await waitFor(() => expect(createProject).toHaveBeenCalledWith({ title: 'Imported', document: { width: 1, height: 1 }, aidaCount: 14 }));
    await waitFor(() => expect(moveProjectToFolder).toHaveBeenCalledWith('new-project', 'folder-one'));
    await waitFor(() => expect(window.location.pathname).toBe('/patterns/new-project/edit'));
  });

  it('returns focus to the gallery Import Pattern button when the upload modal is closed', async () => {
    mockedWorkspace.mockReturnValue({ ...baseWorkspace, projects: [{ id: 'one', title: 'One', notes: '', createdAt: 1, updatedAt: 2, revision: 1 }] } as never);
    render(<App />);
    const importButton = screen.getAllByRole('button', { name: 'Import Pattern' })[0];
    importButton.focus();
    fireEvent.click(importButton);
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Import a pattern' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Import a pattern' })).not.toBeInTheDocument();
    await waitFor(() => expect(importButton).toHaveFocus());
  });

  it('flushes before explicitly activating an available update', async () => {
    window.history.replaceState({}, '', '/patterns/one/edit');
    pwaControls.adapter.state.updateAvailable = true;
    pwaControls.adapter.activateUpdate.mockResolvedValue(true);
    mockedWorkspace.mockReturnValue({ ...baseWorkspace, state: { ...baseWorkspace.state, projectId: 'one', metadata: { id: 'one', title: 'Garden sampler', notes: '', createdAt: 1, updatedAt: 2, revision: 4 }, document: { width: 16, height: 16, palette: [] } } } as never);
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Update now' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Update now' }));
    await waitFor(() => expect(pwaControls.adapter.activateUpdate).toHaveBeenCalledOnce());
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(pwaControls.adapter.activateUpdate.mock.invocationCallOrder[0]);
  });

  it('turns an unknown deep link into a terminal not-found view', async () => {
    window.history.replaceState({}, '', '/patterns/missing/edit');
    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Project not found' })).toBeInTheDocument());
    expect(screen.getByText('That local project could not be found.')).toBeInTheDocument();
    expect(screen.queryByText('Opening your workspace…')).not.toBeInTheDocument();
    expect(screen.queryByText('Tools & shortcuts')).not.toBeInTheDocument();
    expect(screen.queryByText('Editor')).not.toBeInTheDocument();
  });

  it('rejects a decoded malformed project id instead of opening forever', async () => {
    window.history.replaceState({}, '', '/patterns/%2F/edit');
    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Project not found' })).toBeInTheDocument());
    expect(screen.getByText('This project link is malformed. Return to your patterns.')).toBeInTheDocument();
    expect(screen.queryByText('Opening your workspace…')).not.toBeInTheDocument();
  });

  it('keeps the dashboard out of the editor route', async () => {
    window.history.replaceState({}, '', '/patterns/one/edit');
    mockedWorkspace.mockReturnValue({ ...baseWorkspace, workspace: editorWorkspace, state: { ...baseWorkspace.state, projectId: 'one', metadata: { id: 'one', title: 'Garden sampler', notes: '', createdAt: 1, updatedAt: 2, revision: 4 }, document: { width: 16, height: 16, palette: [], colors: new Uint16Array(), backstitches: { ids: new Uint32Array() } } }, projects: [{ id: 'one', title: 'Garden sampler', notes: '', createdAt: 1, updatedAt: 2, revision: 4 }] } as never);
    render(<App />);

    expect(screen.queryByRole('heading', { name: 'Cross-stitch patterns' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Tools & shortcuts' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Projects' })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Export pattern' })).toBeInTheDocument();
  });

  it('shows an Edit | Track switch with Track enabled and no materials button', async () => {
    window.history.replaceState({}, '', '/patterns/one/edit');
    mockedWorkspace.mockReturnValue({ ...baseWorkspace, workspace: editorWorkspace, state: { ...baseWorkspace.state, projectId: 'one', metadata: { id: 'one', title: 'Garden sampler', notes: '', createdAt: 1, updatedAt: 2, revision: 4 }, document: { width: 16, height: 16, palette: [], colors: new Uint16Array(), backstitches: { ids: new Uint32Array() } } }, projects: [{ id: 'one', title: 'Garden sampler', notes: '', createdAt: 1, updatedAt: 2, revision: 4 }] } as never);
    render(<App />);

    expect(await screen.findByRole('button', { name: 'Export pattern' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Materials and progress' })).not.toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Pattern view' });
    expect(within(nav).getByRole('button', { name: 'Edit' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('button', { name: 'Track' })).toBeEnabled();
  });

  it('opens the project on /track and shows the Track page', async () => {
    window.history.replaceState({}, '', '/patterns/one/track');
    const projects = [{ id: 'one', title: 'Garden sampler', notes: '', createdAt: 1, updatedAt: 2, revision: 4 }];
    mockedWorkspace.mockReturnValue({ ...baseWorkspace, workspace: editorWorkspace, projects } as never);
    const view = render(<App />);
    await waitFor(() => expect(openProject).toHaveBeenCalledWith('one'));

    mockedWorkspace.mockReturnValue({ ...baseWorkspace, workspace: editorWorkspace, state: { ...baseWorkspace.state, projectId: 'one', metadata: projects[0], document: createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 4, height: 4, palette: [{ id: 1, name: 'Ruby', color: '#AA0000' }] }) }, projects } as never);
    view.rerender(<App />);

    expect(await screen.findByRole('heading', { name: 'Garden sampler' })).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Pattern view' })).getByRole('button', { name: 'Track' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Undo mark' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export pattern' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('data-page', 'track');
  });

  it('renames the open pattern from the Track title', async () => {
    window.history.replaceState({}, '', '/patterns/one/track');
    const projects = [{ id: 'one', title: 'Garden sampler', notes: '', createdAt: 1, updatedAt: 2, revision: 4 }];
    mockedWorkspace.mockReturnValue({ ...baseWorkspace, workspace: editorWorkspace, state: { ...baseWorkspace.state, projectId: 'one', metadata: projects[0], document: createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 4, height: 4, palette: [{ id: 1, name: 'Ruby', color: '#AA0000' }] }) }, projects } as never);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Rename Garden sampler' }));
    const input = screen.getByRole('textbox', { name: 'Rename pattern Garden sampler' });
    fireEvent.change(input, { target: { value: 'Winter sampler' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(renameProject).toHaveBeenCalledWith('one', 'Winter sampler'));
    expect(await screen.findByText('Pattern renamed.')).toBeInTheDocument();
  });

  it('switches between Edit and Track without reopening the project', async () => {
    window.history.replaceState({}, '', '/patterns/one/edit');
    mockedWorkspace.mockReturnValue({ ...baseWorkspace, workspace: editorWorkspace, state: { ...baseWorkspace.state, projectId: 'one', metadata: { id: 'one', title: 'Garden sampler', notes: '', createdAt: 1, updatedAt: 2, revision: 4 }, document: createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 4, height: 4, palette: [{ id: 1, name: 'Ruby', color: '#AA0000' }] }) }, projects: [{ id: 'one', title: 'Garden sampler', notes: '', createdAt: 1, updatedAt: 2, revision: 4 }] } as never);
    render(<App />);

    expect(await screen.findByRole('button', { name: 'Export pattern' })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Pattern view' })).getByRole('button', { name: 'Track' }));
    expect(await screen.findByRole('button', { name: 'Undo mark' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/patterns/one/track');

    fireEvent.click(within(screen.getByRole('navigation', { name: 'Pattern view' })).getByRole('button', { name: 'Edit' }));
    expect(await screen.findByRole('button', { name: 'Export pattern' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/patterns/one/edit');
    expect(screen.queryByRole('heading', { name: 'Opening your workspace…' })).not.toBeInTheDocument();
    expect(openProject).not.toHaveBeenCalled();
  });

  it('opens the export dialog from the editor header', async () => {
    window.history.replaceState({}, '', '/patterns/one/edit');
    mockedWorkspace.mockReturnValue({ ...baseWorkspace, workspace: { ...editorWorkspace, activeProjectId: 'one', materialSettings: { strands: 2, backstitchStrands: 1, waste: 0.1, skeinLengthMeters: 8 }, updateActiveMaterialSettings: vi.fn(), updateActiveMetadata: vi.fn(), updateActiveAidaCount: vi.fn() }, state: { ...baseWorkspace.state, projectId: 'one', metadata: { id: 'one', title: 'Garden sampler', notes: '', createdAt: 1, updatedAt: 2, revision: 4 }, document: createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 16, height: 16, palette: [{ id: 1, name: 'Ruby', color: '#AA0000' }] }) }, projects: [{ id: 'one', title: 'Garden sampler', notes: '', createdAt: 1, updatedAt: 2, revision: 4 }] } as never);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Export pattern' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export pattern' });
    expect(within(dialog).getByRole('region', { name: 'Thread totals' })).toBeInTheDocument();
  });

  it('no longer routes /preview to the editor', async () => {
    window.history.replaceState({}, '', '/patterns/one/preview');
    render(<App />);

    expect(screen.queryByRole('button', { name: 'Export pattern' })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Pattern view' })).not.toBeInTheDocument();
  });

  it('owns focus and makes the complete application inert while create is open', async () => {
    render(<App />);
    const trigger = screen.getByRole('button', { name: 'New Pattern' });
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBe(document.querySelector('[role="dialog"]'));
    expect(dialog.closest('[data-application]')).toBeNull();
    expect(screen.getByTestId('application')).toHaveProperty('inert', true);
    expect(document.activeElement).toBe(screen.getByLabelText('Title'));

    const submit = screen.getByRole('button', { name: 'Create blank pattern' });
    submit.focus();
    fireEvent.keyDown(submit, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close create pattern dialog' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
  });

  it('restores focus to the empty-state create trigger after closing the modal', async () => {
    render(<App />);
    const trigger = screen.getByRole('button', { name: 'New Pattern' });
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    expect(document.activeElement).toBe(trigger);
  });

  it('uses roving focus and arrow selection for creation modes', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'New Pattern' }));
    const blank = await screen.findByRole('radio', { name: 'Blank canvas' });
    const image = screen.getByRole('radio', { name: /From image/ });
    expect(blank).toHaveAttribute('tabindex', '0');
    expect(image).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(blank, { key: 'ArrowRight' });
    expect(image).toHaveAttribute('aria-checked', 'true');
    expect(image).toHaveAttribute('tabindex', '0');
    expect(document.activeElement).toBe(image);
  });

  it('navigates to the editor when a landing gallery project is opened', async () => {
    const project = { id: 'one', title: 'Garden sampler', notes: '', createdAt: 1, updatedAt: 2, revision: 4, width: 16, height: 16 };
    mockedWorkspace.mockReturnValue({ ...baseWorkspace, projects: [project] } as never);
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Open Garden sampler' }));

    await waitFor(() => expect(openProject).toHaveBeenCalledWith('one'));
    expect(window.location.pathname).toBe('/patterns/one/edit');
  });

  it('duplicates a pattern from the gallery without opening the copy', async () => {
    const project = { id: 'one', title: 'Garden sampler', notes: '', createdAt: 1, updatedAt: 2, revision: 4 };
    mockedWorkspace.mockReturnValue({ ...baseWorkspace, projects: [project] } as never);
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate Garden sampler' }));

    await waitFor(() => expect(duplicateProject).toHaveBeenCalledWith('one'));
    expect(await screen.findByText('Pattern duplicated.')).toBeInTheDocument();
    expect(moveProjectToFolder).not.toHaveBeenCalled();
    expect(openProject).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/patterns');
  });

  it('moves a duplicated pattern into the folder being viewed', async () => {
    window.history.replaceState({}, '', '/patterns?folder=folder-one');
    const folder = { id: 'folder-one', name: 'Crafts', parentId: null, createdAt: 1, updatedAt: 1 };
    const project = { id: 'one', title: 'Garden sampler', notes: '', createdAt: 1, updatedAt: 2, revision: 4 };
    mockedWorkspace.mockReturnValue({ ...baseWorkspace, projects: [project], folders: [folder], folderAssignments: [{ projectId: 'one', folderId: 'folder-one' }] } as never);
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate Garden sampler' }));

    await waitFor(() => expect(moveProjectToFolder).toHaveBeenCalledWith('copy-id', 'folder-one'));
  });

  it('reports a failed duplicate', async () => {
    const project = { id: 'one', title: 'Garden sampler', notes: '', createdAt: 1, updatedAt: 2, revision: 4 };
    duplicateProject.mockRejectedValueOnce(new Error('nope'));
    mockedWorkspace.mockReturnValue({ ...baseWorkspace, projects: [project] } as never);
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate Garden sampler' }));

    expect(await screen.findByText('The pattern could not be duplicated.')).toBeInTheDocument();
  });

  it('renames a pattern from its gallery card without opening it', async () => {
    const project = { id: 'one', title: 'Garden sampler', notes: '', createdAt: 1, updatedAt: 2, revision: 4 };
    mockedWorkspace.mockReturnValue({ ...baseWorkspace, projects: [project] } as never);
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Rename Garden sampler' }));
    const input = screen.getByLabelText('Rename pattern Garden sampler');
    fireEvent.change(input, { target: { value: '  Renamed  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(renameProject).toHaveBeenCalledWith('one', 'Renamed'));
    expect(await screen.findByText('Pattern renamed.')).toBeInTheDocument();
    expect(openProject).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/patterns');
  });

  it('reports a failed pattern rename', async () => {
    const project = { id: 'one', title: 'Garden sampler', notes: '', createdAt: 1, updatedAt: 2, revision: 4 };
    renameProject.mockRejectedValueOnce(new Error('nope'));
    mockedWorkspace.mockReturnValue({ ...baseWorkspace, projects: [project] } as never);
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Rename Garden sampler' }));
    const input = screen.getByLabelText('Rename pattern Garden sampler');
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(await screen.findByText('The pattern could not be renamed.')).toBeInTheDocument();
  });

  it('deletes a project from the landing list through a two-step inline confirm', async () => {
    window.history.replaceState({}, '', '/patterns');
    mockedWorkspace.mockReturnValue({
      ...baseWorkspace,
      projects: [{ id: 'one', title: 'Garden sampler', notes: '', createdAt: 1, updatedAt: 2, revision: 4 }],
      deleteProject: deleteProject.mockResolvedValue(undefined)
    } as never);
    deleteProject.mockClear();
    render(<App />);

    const deleteButton = screen.getByRole('button', { name: 'Delete Garden sampler' });
    expect(deleteButton).toHaveTextContent('Delete');
    // First click arms the confirm state; nothing is deleted yet.
    fireEvent.click(deleteButton);
    expect(deleteProject).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Confirm delete Garden sampler' })).toHaveTextContent('Confirm delete?');
    // Second click performs the deletion.
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Garden sampler' }));
    await waitFor(() => expect(deleteProject).toHaveBeenCalledWith('one'));
    expect(screen.getByText('Project deleted.')).toBeInTheDocument();
  });

  it('drops the deleted project from the list after the workspace refreshes', async () => {
    window.history.replaceState({}, '', '/patterns');
    const remaining = [{ id: 'two', title: 'Keeper', notes: '', createdAt: 1, updatedAt: 3, revision: 2 }];
    const deleteThenRefresh = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<App />);
    mockedWorkspace.mockReturnValue({
      ...baseWorkspace,
      projects: [
        { id: 'one', title: 'Garden sampler', notes: '', createdAt: 1, updatedAt: 2, revision: 4 },
        ...remaining
      ],
      deleteProject: deleteThenRefresh
    } as never);
    rerender(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Garden sampler' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Garden sampler' }));
    await waitFor(() => expect(deleteThenRefresh).toHaveBeenCalledWith('one'));
    // The refreshed list (which the adapter re-reads after every action) no
    // longer contains the deleted row.
    mockedWorkspace.mockReturnValue({ ...baseWorkspace, projects: remaining, deleteProject: deleteThenRefresh } as never);
    rerender(<App />);
    expect(screen.queryByRole('button', { name: 'Delete Garden sampler' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Keeper' })).toBeInTheDocument();
  });

  it('passes the selected aida count when creating a blank pattern', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'New Pattern' }));
    const select = screen.getByLabelText('Aida count');
    fireEvent.change(screen.getByLabelText('Background color', { selector: 'input[type="color"]' }), { target: { value: '#aabbcc' } });
    expect(select).toHaveValue('14');
    fireEvent.change(select, { target: { value: '18' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create blank pattern' }));

    await waitFor(() => expect(createProject).toHaveBeenCalledOnce());
    expect(createProject.mock.calls[0][0]).toMatchObject({ aidaCount: 18, title: 'Untitled sampler', settings: { backgroundColor: '#AABBCC' } });
  });

  it('passes the selected aida count when creating from an image', async () => {
    conversion.convert.mockResolvedValue({ draft: {
      stats: { sourceWidth: 640, sourceHeight: 480 },
      document: { width: 2, height: 2, palette: [], colors: new Uint16Array(16) },
      sourceImage: {
        width: 640,
        height: 480,
        crop: { x: 0, y: 0, width: 1, height: 1 },
        chartBounds: { x: 0, y: 0, width: 2, height: 2 },
        traceVisible: false,
        opacity: 1
      }
    } });
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn().mockReturnValue('blob:test'), configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    images.length = 0;
    vi.stubGlobal('Image', MockImage);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'New Pattern' }));
    fireEvent.click(screen.getByRole('radio', { name: /From image/ }));
    fireEvent.change(screen.getByLabelText('Background color', { selector: 'input[type="color"]' }), { target: { value: '#aabbcc' } });
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    act(() => { images[0].onload?.(); });
    await screen.findByLabelText('Width');
    await screen.findByRole('slider', { name: /Color budget/ });
    fireEvent.change(screen.getByLabelText('Aida count'), { target: { value: '22' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create from image' }));

    await waitFor(() => expect(createProjectFromConversion).toHaveBeenCalledOnce());
    expect(createProjectFromConversion.mock.calls[0][0]).toMatchObject({ aidaCount: 22, title: 'Untitled sampler', settings: { backgroundColor: '#AABBCC' } });
    expect(createProjectFromConversion.mock.calls[0][0].draft).toBeDefined();
    expect(createProjectFromConversion.mock.calls[0][0].draft.sourceImage).toMatchObject({ traceVisible: false });
    expect(createProjectFromConversion.mock.calls[0][0].sourceImageAsset).toMatchObject({ name: 'one.png', mimeType: 'image/png' });
    vi.unstubAllGlobals();
  });

  it('navigates into a folder and reflects it in the URL and header', async () => {
    const folder = { id: 'folder-one', name: 'Crafts', parentId: null, createdAt: 1, updatedAt: 1 };
    mockedWorkspace.mockReturnValue({ ...baseWorkspace, folders: [folder] } as never);
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Open folder Crafts' }));

    await waitFor(() => expect(window.location.search).toBe('?folder=folder-one'));
    expect(await screen.findByRole('heading', { name: 'Crafts' })).toBeInTheDocument();
  });

  it('moves a newly created pattern into the folder being viewed', async () => {
    window.history.replaceState({}, '', '/patterns?folder=folder-one');
    const folder = { id: 'folder-one', name: 'Crafts', parentId: null, createdAt: 1, updatedAt: 1 };
    mockedWorkspace.mockReturnValue({ ...baseWorkspace, folders: [folder] } as never);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'New Pattern' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create blank pattern' }));

    await waitFor(() => expect(moveProjectToFolder).toHaveBeenCalledWith('new-project', 'folder-one'));
  });

  it('deletes a folder through a two-step inline confirm', async () => {
    const folder = { id: 'folder-one', name: 'Crafts', parentId: null, createdAt: 1, updatedAt: 1 };
    mockedWorkspace.mockReturnValue({ ...baseWorkspace, folders: [folder] } as never);
    render(<App />);

    const deleteButton = screen.getByRole('button', { name: 'Delete folder Crafts' });
    expect(deleteButton).toHaveTextContent('Delete');
    // First click arms the confirm state; nothing is deleted yet.
    fireEvent.click(deleteButton);
    expect(deleteFolder).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Confirm delete folder Crafts' })).toHaveTextContent('Confirm delete?');
    // Second click performs the deletion.
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete folder Crafts' }));
    await waitFor(() => expect(deleteFolder).toHaveBeenCalledWith('folder-one'));
    expect(screen.getByText('Folder deleted. Its patterns moved up a level.')).toBeInTheDocument();
  });

  it('shows an undo toast after a drag move, and undo reverses it', async () => {
    const project = { id: 'one', title: 'Garden sampler', notes: '', createdAt: 1, updatedAt: 2, revision: 4 };
    const folder = { id: 'folder-two', name: 'Archive', parentId: null, createdAt: 1, updatedAt: 1 };
    mockedWorkspace.mockReturnValue({ ...baseWorkspace, projects: [project], folders: [folder], folderAssignments: [] } as never);
    vi.mocked(ProjectGallery).mockImplementation((props) => (
      <button type="button" onClick={() => props.onMoveProject?.(project, 'folder-two')}>trigger move</button>
    ));
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'trigger move' }));
    await waitFor(() => expect(moveProjectToFolder).toHaveBeenCalledWith('one', 'folder-two'));
    expect(screen.getByText('Moved “Garden sampler” to Archive')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    // The pattern had no prior folder assignment, so undo moves it back to the top level.
    await waitFor(() => expect(moveProjectToFolder).toHaveBeenLastCalledWith('one', null));
    expect(screen.getByText('Move undone.')).toBeInTheDocument();
    expect(screen.queryByText('Moved “Garden sampler” to Archive')).not.toBeInTheDocument();
  });

  it('auto-hides the undo toast after 6 seconds', async () => {
    vi.useFakeTimers();
    try {
      const project = { id: 'one', title: 'Garden sampler', notes: '', createdAt: 1, updatedAt: 2, revision: 4 };
      const folder = { id: 'folder-two', name: 'Archive', parentId: null, createdAt: 1, updatedAt: 1 };
      mockedWorkspace.mockReturnValue({ ...baseWorkspace, projects: [project], folders: [folder], folderAssignments: [] } as never);
      vi.mocked(ProjectGallery).mockImplementation((props) => (
        <button type="button" onClick={() => props.onMoveProject?.(project, 'folder-two')}>trigger move</button>
      ));
      render(<App />);

      fireEvent.click(screen.getByRole('button', { name: 'trigger move' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByText('Moved “Garden sampler” to Archive')).toBeInTheDocument();

      await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
      expect(screen.queryByText('Moved “Garden sampler” to Archive')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the homepage at the root path with a link to the patterns page', () => {
    window.history.replaceState({}, '', '/');
    render(<App />);

    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Go to your patterns/ })).toHaveAttribute('href', '/patterns');
  });

  it('redirects an unknown path to the homepage', () => {
    window.history.replaceState({}, '', '/nope');
    render(<App />);

    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Go to your patterns/ })).toHaveAttribute('href', '/patterns');
  });
});
