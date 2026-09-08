import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { useProjectWorkspace } from './application/react';

vi.mock('./application/react', () => ({ useProjectWorkspace: vi.fn() }));
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

const mockedWorkspace = vi.mocked(useProjectWorkspace);
const createProject = vi.fn().mockResolvedValue({ projectId: 'new-project' });
const createProjectFromConversion = vi.fn().mockResolvedValue({ projectId: 'new-project' });
const importProjectAsCopy = vi.fn().mockResolvedValue(undefined);
const exportProject = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
const openProject = vi.fn().mockResolvedValue(undefined);
const flush = vi.fn().mockResolvedValue(undefined);
const deleteProject = vi.fn().mockResolvedValue(undefined);
const editorWorkspace = { metadata: { title: 'Garden sampler', notes: '', aidaCount: 14 } };

const baseWorkspace = {
  initialized: true,
  busy: false,
  state: { projectId: null, metadata: null, document: null, save: { status: 'idle', dirty: false, pendingRevision: null, lastSavedRevision: null, error: null }, error: null },
  projects: [],
  error: null,
  saveState: { status: 'idle', dirty: false, pendingRevision: null, lastSavedRevision: null, error: null },
  workspace: null,
  createProject,
  createProjectFromConversion,
  openProject,
  selectProject: vi.fn(),
  deleteProject,
  importProjectAsCopy,
  exportProject,
  flush,
};

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/patterns');
  pwaControls.adapter.state.updateAvailable = false;
  pwaControls.adapter.register.mockResolvedValue(pwaControls.adapter.state);
  mockedWorkspace.mockReturnValue(baseWorkspace as never);
});

describe('application shell', () => {
  it('shows a truthful loading state while the workspace initializes', () => {
    mockedWorkspace.mockReturnValue({ ...baseWorkspace, initialized: false, busy: true } as never);
    render(<App />);

    expect(screen.getByRole('heading', { name: 'Opening your workspace…' })).toBeInTheDocument();
    expect(screen.queryByText('Saved locally')).not.toBeInTheDocument();
  });

  it('creates the starter project from the empty workspace', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /Create a new pattern/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create blank pattern' }));

    await waitFor(() => expect(createProject).toHaveBeenCalledOnce());
  });

  it('sends a selected archive to the adapter and reports import failures', async () => {
    const importError = new Error('Archive is not a valid Needlewise project.');
    importProjectAsCopy.mockRejectedValueOnce(importError);
    mockedWorkspace.mockReturnValue({ ...baseWorkspace, error: importError } as never);
    render(<App />);
    const file = new File(['bad'], 'broken.needlewise', { type: 'application/octet-stream' });
    fireEvent.change(screen.getByLabelText('Choose a Needlewise project archive'), { target: { files: [file] } });

    await waitFor(() => expect(importProjectAsCopy).toHaveBeenCalledWith(file));
    expect(screen.getByRole('alert')).toHaveTextContent(importError.message);
  });

  it('exports an archive through a downloaded blob', async () => {
    window.history.replaceState({}, '', '/patterns/one/edit');
    const createObjectURL = vi.fn().mockReturnValue('blob:needlewise');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
    mockedWorkspace.mockReturnValue({ ...baseWorkspace, workspace: editorWorkspace, state: { ...baseWorkspace.state, projectId: 'one', metadata: { id: 'one', title: 'Garden sampler', notes: '', createdAt: 1, updatedAt: 2, revision: 4 }, document: { width: 16, height: 16, palette: [], colors: new Uint16Array(), backstitches: { ids: new Uint32Array() } } }, saveState: { ...baseWorkspace.saveState, status: 'saved' } } as never);
    render(<App />);
    const editorDownload = await screen.findByRole('button', { name: 'Download Pattern' });
    expect(editorDownload).toBeInTheDocument();
    fireEvent.click(editorDownload);

    await waitFor(() => expect(exportProject).toHaveBeenCalledOnce());
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:needlewise');
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
    expect(await screen.findByRole('button', { name: 'Download Pattern' })).toBeInTheDocument();
  });

  it('owns focus and makes the complete application inert while create is open', async () => {
    render(<App />);
    const trigger = screen.getByRole('button', { name: /Create a new pattern/ });
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

  it('uses roving focus and arrow selection for creation modes', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /Create a new pattern/ }));
    const blank = await screen.findByRole('radio', { name: 'Blank canvas' });
    const image = screen.getByRole('radio', { name: /From image/ });
    expect(blank).toHaveAttribute('tabindex', '0');
    expect(image).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(blank, { key: 'ArrowRight' });
    expect(image).toHaveAttribute('aria-checked', 'true');
    expect(image).toHaveAttribute('tabindex', '0');
    expect(document.activeElement).toBe(image);
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
    expect(screen.getByRole('button', { name: 'Delete Garden sampler' })).toHaveTextContent('Confirm delete?');
    // Second click performs the deletion.
    fireEvent.click(screen.getByRole('button', { name: 'Delete Garden sampler' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Delete Garden sampler' }));
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
    fireEvent.click(screen.getByRole('button', { name: /Create a new pattern/ }));
    const select = screen.getByLabelText('Aida count');
    expect(select).toHaveValue('14');
    fireEvent.change(select, { target: { value: '18' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create blank pattern' }));

    await waitFor(() => expect(createProject).toHaveBeenCalledOnce());
    expect(createProject.mock.calls[0][0]).toMatchObject({ aidaCount: 18, title: 'Untitled sampler' });
  });

  it('passes the selected aida count when creating from an image', async () => {
    conversion.convert.mockResolvedValue({ draft: { stats: { sourceWidth: 640, sourceHeight: 480 }, document: { width: 2, height: 2, palette: [], colors: new Uint16Array(16) } } });
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn().mockReturnValue('blob:test'), configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    images.length = 0;
    vi.stubGlobal('Image', MockImage);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /Create a new pattern/ }));
    fireEvent.click(screen.getByRole('radio', { name: /From image/ }));
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    act(() => { images[0].onload?.(); });
    await screen.findByLabelText('Width');
    await screen.findByRole('slider', { name: /Color budget/ });
    fireEvent.change(screen.getByLabelText('Aida count'), { target: { value: '22' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create from image' }));

    await waitFor(() => expect(createProjectFromConversion).toHaveBeenCalledOnce());
    expect(createProjectFromConversion.mock.calls[0][0]).toMatchObject({ aidaCount: 22, title: 'Untitled sampler' });
    expect(createProjectFromConversion.mock.calls[0][0].draft).toBeDefined();
    vi.unstubAllGlobals();
  });
});
