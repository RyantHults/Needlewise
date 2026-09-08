import 'fake-indexeddb/auto';
import { StrictMode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createDocument, CellKind } from '../domain';
import { NeedlewiseDatabase, ProjectRepository, type ProjectMetadata } from '../persistence';
import { ProjectWorkspace, useProjectWorkspace } from './index';

let databaseCounter = 1000;

function makeRepository(): ProjectRepository {
  databaseCounter += 1;
  return new ProjectRepository(new NeedlewiseDatabase(`needlewise-react-test-${String(databaseCounter)}`));
}

function projectMetadata(id: string, revision: number, updatedAt: number): ProjectMetadata {
  return { id, title: id, notes: '', createdAt: 1, updatedAt, revision };
}

async function deleteRepository(repository: ProjectRepository): Promise<void> {
  const database = repository.db;
  await repository.close();
  await database.delete();
}

describe('ProjectWorkspace observable adapter', () => {
  it('initializes with the newest valid project and disposes once under Strict Mode replay', async () => {
    const repository = makeRepository();
    const document = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    await repository.save('older', projectMetadata('older', 0, 10), document);
    await repository.save('newer', projectMetadata('newer', 0, 20), document);
    const listProjects = vi.spyOn(repository, 'listProjects');
    const listProjectHealth = vi.spyOn(repository, 'listProjectHealth');
    let createdWorkspace: ProjectWorkspace | undefined;
    const factory = vi.fn((options: ConstructorParameters<typeof ProjectWorkspace>[0]) => {
      const workspace = new ProjectWorkspace(options);
      createdWorkspace = workspace;
      return workspace;
    });
    const rendered = renderHook(() => useProjectWorkspace({ repository, workspaceFactory: factory }), { wrapper: StrictMode });
    try {
      await waitFor(() => expect(rendered.result.current.initialized).toBe(true));
      expect(factory).toHaveBeenCalledTimes(1);
      expect(listProjects).toHaveBeenCalledOnce();
      expect(listProjectHealth).not.toHaveBeenCalled();
      expect(rendered.result.current.projects.map((project) => project.id)).toEqual(['newer', 'older']);
      expect(rendered.result.current.state.projectId).toBe('newer');
    } finally {
      rendered.unmount();
      await waitFor(() => expect(createdWorkspace?.isDisposed).toBe(true));
      await deleteRepository(repository);
    }
  });

  it('can defer most-recent startup selection so a route can open its project ID explicitly', async () => {
    const repository = makeRepository();
    const document = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    await repository.save('older', projectMetadata('older', 0, 10), document);
    await repository.save('newer', projectMetadata('newer', 0, 20), document);
    const rendered = renderHook(() => useProjectWorkspace({ repository, autoOpenMostRecent: false }));
    try {
      await waitFor(() => expect(rendered.result.current.initialized).toBe(true));
      expect(rendered.result.current.state.projectId).toBeNull();

      await act(async () => {
        await rendered.result.current.openProject('older');
      });
      expect(rendered.result.current.state.projectId).toBe('older');
    } finally {
      rendered.unmount();
      await Promise.resolve();
      await deleteRepository(repository);
    }
  });

  it('creates projects, observes save-state changes, and flushes debounced edits', async () => {
    const repository = makeRepository();
    const rendered = renderHook(() => useProjectWorkspace({ repository, debounceMs: 40, projectIdFactory: () => 'created', clock: { now: () => 100 } }));
    try {
      await waitFor(() => expect(rendered.result.current.initialized).toBe(true));
      await act(async () => {
        await rendered.result.current.createProject({ width: 2, height: 2, document: createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] }) });
      });
      expect(rendered.result.current.state.projectId).toBe('created');
      await act(async () => {
        rendered.result.current.workspace?.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
      });
      await waitFor(() => expect(rendered.result.current.saveState.status).toBe('pending'));
      expect(rendered.result.current.saveState.pendingRevision).toBe(1);
      await act(async () => {
        await rendered.result.current.flush();
      });
      expect(rendered.result.current.saveState.status).toBe('saved');
      expect((await repository.load('created'))?.document.kind[0]).toBe(CellKind.Full);
    } finally {
      rendered.unmount();
      await Promise.resolve();
      await deleteRepository(repository);
    }
  });

  it('forwards active metadata updates and leaves durability to the explicit flush', async () => {
    const repository = makeRepository();
    const rendered = renderHook(() => useProjectWorkspace({ repository, projectIdFactory: () => 'metadata', clock: { now: () => 100 } }));
    try {
      await waitFor(() => expect(rendered.result.current.initialized).toBe(true));
      await act(async () => {
        await rendered.result.current.createProject({ title: 'Before', notes: 'old', width: 2, height: 2 });
      });

      let update: Promise<void> | undefined;
      act(() => {
        update = rendered.result.current.updateActiveMetadata({ title: 'After', notes: 'new' });
      });
      await act(async () => {
        await update;
      });
      expect(rendered.result.current.state.metadata).toMatchObject({ title: 'After', notes: 'new' });
      expect(rendered.result.current.saveState.metadataDirty).toBe(true);
      await act(async () => {
        await rendered.result.current.flush();
      });
      expect(rendered.result.current.saveState.metadataDirty).toBe(false);
      expect((await repository.load('metadata'))?.metadata).toMatchObject({ title: 'After', notes: 'new' });
      expect(rendered.result.current.busy).toBe(false);
    } finally {
      rendered.unmount();
      await Promise.resolve();
      await deleteRepository(repository);
    }
  });

  it('does not let lifecycle flushes cancel a delayed startup open', async () => {
    const repository = makeRepository();
    const patternDocument = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    await repository.save('delayed', projectMetadata('delayed', 0, 10), patternDocument);
    const originalLoad = repository.load.bind(repository);
    let releaseLoad!: () => void;
    const loadReleased = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    let loadStarted!: () => void;
    const loadHasStarted = new Promise<void>((resolve) => {
      loadStarted = resolve;
    });
    vi.spyOn(repository, 'load').mockImplementation(async (projectId) => {
      loadStarted();
      await loadReleased;
      return originalLoad(projectId);
    });
    const rendered = renderHook(() => useProjectWorkspace({ repository }));
    const initialVisibilityState = document.visibilityState;
    try {
      await act(async () => {
        await loadHasStarted;
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        window.dispatchEvent(new Event('pagehide'));
        document.dispatchEvent(new Event('visibilitychange'));
        releaseLoad();
      });
      await waitFor(() => expect(rendered.result.current.initialized).toBe(true));
      expect(rendered.result.current.state.projectId).toBe('delayed');
    } finally {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: initialVisibilityState });
      rendered.unmount();
      await Promise.resolve();
      await deleteRepository(repository);
    }
  });

  it('reports metadata action errors and leaves the adapter idle when no project is active', async () => {
    const repository = makeRepository();
    const rendered = renderHook(() => useProjectWorkspace({ repository }));
    try {
      await waitFor(() => expect(rendered.result.current.initialized).toBe(true));
      await act(async () => {
        await expect(rendered.result.current.updateActiveMetadata({ title: 'Unavailable' })).rejects.toMatchObject({ code: 'no-active-project' });
      });
      expect(rendered.result.current.busy).toBe(false);
      expect(rendered.result.current.error).toMatchObject({ code: 'no-active-project' });
    } finally {
      rendered.unmount();
      await Promise.resolve();
      await deleteRepository(repository);
    }
  });

  it('rejects invalid imports, exposes the error, and cleans up subscriptions', async () => {
    const repository = makeRepository();
    const rendered = renderHook(() => useProjectWorkspace({ repository, projectIdFactory: () => 'created' }));
    try {
      await waitFor(() => expect(rendered.result.current.initialized).toBe(true));
      await act(async () => {
        await rendered.result.current.createProject({ width: 2, height: 2, document: createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] }) });
      });
      await act(async () => {
        await expect(rendered.result.current.importProject(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({ code: 'invalid-archive' });
      });
      expect(rendered.result.current.state.projectId).toBe('created');
      expect(rendered.result.current.error).toMatchObject({ code: 'invalid-archive' });

      const workspace = rendered.result.current.workspace;
      expect(workspace).not.toBeNull();
      let notifications = 0;
      const unsubscribe = workspace?.subscribe(() => {
        notifications += 1;
      });
      unsubscribe?.();
      unsubscribe?.();
      await act(async () => {
        workspace?.execute({ type: 'set-full', x: 1, y: 1, color: 1 });
      });
      expect(notifications).toBe(0);
    } finally {
      rendered.unmount();
      await Promise.resolve();
      await deleteRepository(repository);
    }
  });

  it('exposes durable command, undo, and redo wrappers through the React adapter', async () => {
    const repository = makeRepository();
    const rendered = renderHook(() => useProjectWorkspace({ repository, projectIdFactory: () => 'commands' }));
    try {
      await waitFor(() => expect(rendered.result.current.initialized).toBe(true));
      await act(async () => {
        await rendered.result.current.createProject({ width: 2, height: 2, document: createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] }) });
      });
      let resultRevision = 0;
      await act(async () => {
        resultRevision = (await rendered.result.current.execute({ type: 'set-full', x: 0, y: 0, color: 1 })).revision;
      });
      expect(resultRevision).toBe(1);
      await act(async () => {
        expect((await rendered.result.current.undo()).revision).toBe(2);
        expect((await rendered.result.current.redo()).revision).toBe(3);
      });
      expect(rendered.result.current.state.document?.revision).toBe(3);
    } finally {
      rendered.unmount();
      await Promise.resolve();
      await deleteRepository(repository);
    }
  });
});
