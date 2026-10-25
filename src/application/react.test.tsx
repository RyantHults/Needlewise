import 'fake-indexeddb/auto';
import { StrictMode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, type MockInstance } from 'vitest';
import { CellKind, flattenDocument } from '../domain';
import { NeedlewiseDatabase, ProjectRepository, type ProjectMetadata } from '../persistence';
import { ProjectWorkspace, useProjectWorkspace } from './index';
import { DEFAULT_CATALOG_DEFINITION } from '../catalog';
import { cell, createLayeredDocument as createDocument } from '../domain/test-fixtures';

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
  it('lists projects and disposes once under Strict Mode replay', async () => {
    const repository = makeRepository();
    const document = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    await repository.save('older', projectMetadata('older', 0, 10), document);
    await repository.save('newer', projectMetadata('newer', 0, 20), document);
    let dispose: MockInstance<ProjectWorkspace['dispose']> | undefined;
    const factory = vi.fn((options: ConstructorParameters<typeof ProjectWorkspace>[0]) => {
      const workspace = new ProjectWorkspace(options);
      dispose = vi.spyOn(workspace, 'dispose');
      return workspace;
    });
    const rendered = renderHook(() => useProjectWorkspace({ repository, workspaceFactory: factory }), { wrapper: StrictMode });
    try {
      await waitFor(() => expect(rendered.result.current.initialized).toBe(true));
      expect(factory).toHaveBeenCalledTimes(1);
      expect(rendered.result.current.projects.map((project) => project.id)).toEqual(['newer', 'older']);
    } finally {
      rendered.unmount();
      await waitFor(() => expect(dispose).toHaveBeenCalledOnce());
      await deleteRepository(repository);
    }
  });

  it('creates projects, observes save-state changes, and flushes debounced edits', async () => {
    const repository = makeRepository();
    const rendered = renderHook(() => useProjectWorkspace({ repository, debounceMs: 40, projectIdFactory: () => 'created', clock: { now: () => 100 } }));
    try {
      await waitFor(() => expect(rendered.result.current.initialized).toBe(true));
      await act(async () => {
        await rendered.result.current.createProject({ width: 2, height: 2, document: createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] }) });
      });
      expect(rendered.result.current.state.projectId).toBe('created');
      await act(async () => {
        rendered.result.current.workspace?.execute(cell(2, { type: 'set-full', x: 0, y: 0, color: 1 }));
      });
      await waitFor(() => expect(rendered.result.current.state.save.status).toBe('pending'));
      expect(rendered.result.current.state.save.pendingRevision).toBe(1);
      await act(async () => {
        await rendered.result.current.flush();
      });
      expect(rendered.result.current.state.save.status).toBe('saved');
      expect(flattenDocument((await repository.load('created'))!.document).kind[0]).toBe(CellKind.Full);
    } finally {
      rendered.unmount();
      await Promise.resolve();
      await deleteRepository(repository);
    }
  });

  it('refreshes the project list passively after saves that bypass the hook actions', async () => {
    const repository = makeRepository();
    const rendered = renderHook(() => useProjectWorkspace({ repository, debounceMs: 40, projectIdFactory: () => 'created', clock: { now: () => 100 } }));
    try {
      await waitFor(() => expect(rendered.result.current.initialized).toBe(true));
      await act(async () => {
        await rendered.result.current.createProject({ width: 2, height: 2, document: createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] }) });
      });
      const before = rendered.result.current.projects.find((project) => project.id === 'created');
      await act(async () => {
        rendered.result.current.workspace?.execute(cell(2, { type: 'set-full', x: 0, y: 0, color: 1 }));
      });
      // The edit saves through the session, not a hook action, so the listing is still the old one.
      expect(rendered.result.current.projects.find((project) => project.id === 'created')?.revision).toBe(before?.revision);
      await act(async () => {
        await rendered.result.current.refreshProjectList();
      });
      const after = rendered.result.current.projects.find((project) => project.id === 'created');
      expect(after?.revision).toBeGreaterThan(before?.revision ?? 0);
      expect(after?.thumbnail?.palette).toContain('#dd3333');
      expect(rendered.result.current.busy).toBe(false);
    } finally {
      rendered.unmount();
      await Promise.resolve();
      await deleteRepository(repository);
    }
  });

  it('reports action errors and leaves the adapter idle', async () => {
    const repository = makeRepository();
    const rendered = renderHook(() => useProjectWorkspace({ repository }));
    try {
      await waitFor(() => expect(rendered.result.current.initialized).toBe(true));
      await act(async () => {
        await expect(rendered.result.current.openProject('missing')).rejects.toMatchObject({ code: 'project-not-found' });
      });
      expect(rendered.result.current.busy).toBe(false);
      expect(rendered.result.current.error).toMatchObject({ code: 'project-not-found' });
    } finally {
      rendered.unmount();
      await Promise.resolve();
      await deleteRepository(repository);
    }
  });

  it('cleans up subscriptions', async () => {
    const repository = makeRepository();
    const rendered = renderHook(() => useProjectWorkspace({ repository, projectIdFactory: () => 'created' }));
    try {
      await waitFor(() => expect(rendered.result.current.initialized).toBe(true));
      await act(async () => {
        await rendered.result.current.createProject({ width: 2, height: 2, document: createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] }) });
      });
      expect(rendered.result.current.state.projectId).toBe('created');

      const workspace = rendered.result.current.workspace;
      expect(workspace).not.toBeNull();
      let notifications = 0;
      const unsubscribe = workspace?.subscribe(() => {
        notifications += 1;
      });
      unsubscribe?.();
      unsubscribe?.();
      await act(async () => {
        workspace?.execute(cell(2, { type: 'set-full', x: 1, y: 1, color: 1 }));
      });
      expect(notifications).toBe(0);
    } finally {
      rendered.unmount();
      await Promise.resolve();
      await deleteRepository(repository);
    }
  });

});
