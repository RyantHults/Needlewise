import 'fake-indexeddb/auto';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  ProjectFolder,
  ProjectFolderIndex,
  ProjectMetadata,
  ProjectRecord
} from '../persistence';
import { NeedlewiseDatabase, ProjectRepository } from '../persistence';
import { ProjectWorkspace, useProjectWorkspace } from './index';
import type { WorkspaceRepository } from './types';

/**
 * A repository stub implementing only the methods `WorkspaceRepository`
 * requires, as instance properties so `{ ...minimalRepository() }` copies
 * them (unlike prototype methods, which spread would drop).
 */
function minimalRepository(): WorkspaceRepository {
  return {
    save: async () => {
      throw new Error('save was not expected in this test.');
    },
    load: async (): Promise<ProjectRecord | undefined> => undefined,
    listProjects: async (): Promise<ProjectMetadata[]> => [],
    deleteProject: async (): Promise<void> => undefined,
    exportProject: async (): Promise<Uint8Array> => new Uint8Array(),
    importProject: async (): Promise<ProjectRecord> => {
      throw new Error('importProject was not expected in this test.');
    }
  };
}

function folder(id: string, name: string, parentId: string | null = null): ProjectFolder {
  return { id, name, parentId, createdAt: 1, updatedAt: 1 };
}

let databaseCounter = 2000;

function makeRepository(): ProjectRepository {
  databaseCounter += 1;
  return new ProjectRepository(new NeedlewiseDatabase(`needlewise-folders-test-${String(databaseCounter)}`));
}

async function deleteRepository(repository: ProjectRepository): Promise<void> {
  const database = repository.db;
  await repository.close();
  await database.delete();
}

describe('ProjectWorkspace folder delegation', () => {
  it('delegates listFolderIndex, createFolder, renameFolder, deleteFolder, and moveProjectToFolder to the repository, cloning results', async () => {
    const index: ProjectFolderIndex = { folders: [folder('a', 'Alphas')], assignments: [{ projectId: 'p1', folderId: 'a' }] };
    const created = folder('b', 'Betas');
    const renamed = folder('b', 'Betas renamed');
    const repository: WorkspaceRepository = {
      ...minimalRepository(),
      listFolderIndex: vi.fn(async () => index),
      createFolder: vi.fn(async (input) => {
        expect(input).toEqual({ name: 'Betas', parentId: null, id: expect.any(String) });
        return created;
      }),
      renameFolder: vi.fn(async (folderId, name) => {
        expect(folderId).toBe('b');
        expect(name).toBe('Betas renamed');
        return renamed;
      }),
      deleteFolder: vi.fn(async (folderId) => {
        expect(folderId).toBe('b');
      }),
      moveProjectToFolder: vi.fn(async (projectId, folderId) => {
        expect(projectId).toBe('p1');
        expect(folderId).toBe('a');
      }),
      moveFolder: vi.fn(async (folderId, parentId) => {
        expect(folderId).toBe('b');
        expect(parentId).toBe('a');
      })
    };
    const workspace = new ProjectWorkspace({ repository });

    const listed = await workspace.listFolderIndex();
    expect(listed).toEqual(index);
    expect(listed.folders).not.toBe(index.folders);
    expect(listed.folders[0]).not.toBe(index.folders[0]);

    const createdResult = await workspace.createFolder('Betas');
    expect(createdResult).toEqual(created);
    expect(createdResult).not.toBe(created);

    const renamedResult = await workspace.renameFolder('b', 'Betas renamed');
    expect(renamedResult).toEqual(renamed);

    await workspace.deleteFolder('b');
    expect(repository.deleteFolder).toHaveBeenCalledOnce();

    await workspace.moveProjectToFolder('p1', 'a');
    expect(repository.moveProjectToFolder).toHaveBeenCalledOnce();

    await workspace.moveFolder('b', 'a');
    expect(repository.moveFolder).toHaveBeenCalledOnce();
  });

  it('passes the parentId through to createFolder', async () => {
    const created = folder('child', 'Child', 'parent');
    const createFolder = vi.fn(async () => created);
    const repository: WorkspaceRepository = { ...minimalRepository(), createFolder };
    const workspace = new ProjectWorkspace({ repository });

    await workspace.createFolder('Child', 'parent');
    expect(createFolder).toHaveBeenCalledWith({ name: 'Child', parentId: 'parent', id: expect.any(String) });
  });

  it('falls back to an empty index when the repository has no listFolderIndex', async () => {
    const workspace = new ProjectWorkspace({ repository: minimalRepository() });
    await expect(workspace.listFolderIndex()).resolves.toEqual({ folders: [], assignments: [] });
  });

  it('rejects folder mutations with a save-failed WorkspaceError when the repository lacks the method', async () => {
    const workspace = new ProjectWorkspace({ repository: minimalRepository() });
    await expect(workspace.createFolder('Name')).rejects.toMatchObject({ code: 'save-failed' });
    await expect(workspace.renameFolder('id', 'Name')).rejects.toMatchObject({ code: 'save-failed' });
    await expect(workspace.deleteFolder('id')).rejects.toMatchObject({ code: 'save-failed' });
    await expect(workspace.moveProjectToFolder('project', 'id')).rejects.toMatchObject({ code: 'save-failed' });
    await expect(workspace.moveFolder('id', null)).rejects.toMatchObject({ code: 'save-failed' });
  });
});

describe('useProjectWorkspace folder state', () => {
  it('exposes folders and folderAssignments after init and after createFolder', async () => {
    const repository = makeRepository();
    const rendered = renderHook(() => useProjectWorkspace({ repository, autoOpenMostRecent: false }));
    try {
      await waitFor(() => expect(rendered.result.current.initialized).toBe(true));
      expect(rendered.result.current.folders).toEqual([]);
      expect(rendered.result.current.folderAssignments).toEqual([]);

      let created: ProjectFolder | undefined;
      await act(async () => {
        created = await rendered.result.current.createFolder('Sampler kits');
      });
      expect(created?.name).toBe('Sampler kits');
      expect(rendered.result.current.folders.map((f) => f.name)).toEqual(['Sampler kits']);

      await act(async () => {
        await rendered.result.current.createProject({ width: 2, height: 2 });
      });
      const projectId = rendered.result.current.state.projectId;
      expect(projectId).not.toBeNull();
      await act(async () => {
        await rendered.result.current.moveProjectToFolder(projectId as string, created?.id ?? null);
      });
      expect(rendered.result.current.folderAssignments).toEqual([{ projectId, folderId: created?.id }]);

      await act(async () => {
        await rendered.result.current.renameFolder(created?.id as string, 'Renamed kits');
      });
      expect(rendered.result.current.folders.map((f) => f.name)).toEqual(['Renamed kits']);

      await act(async () => {
        await rendered.result.current.deleteFolder(created?.id as string);
      });
      expect(rendered.result.current.folders).toEqual([]);
      expect(rendered.result.current.folderAssignments).toEqual([]);
    } finally {
      rendered.unmount();
      await Promise.resolve();
      await deleteRepository(repository);
    }
  });

  it('moves a folder under a top-level parent via moveFolder', async () => {
    const repository = makeRepository();
    const rendered = renderHook(() => useProjectWorkspace({ repository, autoOpenMostRecent: false }));
    try {
      await waitFor(() => expect(rendered.result.current.initialized).toBe(true));

      let parent: ProjectFolder | undefined;
      let child: ProjectFolder | undefined;
      await act(async () => {
        parent = await rendered.result.current.createFolder('Parent');
      });
      await act(async () => {
        child = await rendered.result.current.createFolder('Child');
      });
      expect(rendered.result.current.folders.map((f) => f.parentId).sort()).toEqual([null, null]);

      await act(async () => {
        await rendered.result.current.moveFolder(child?.id as string, parent?.id as string);
      });
      const moved = rendered.result.current.folders.find((f) => f.id === child?.id);
      expect(moved?.parentId).toBe(parent?.id);

      await act(async () => {
        await rendered.result.current.moveFolder(child?.id as string, null);
      });
      const movedBack = rendered.result.current.folders.find((f) => f.id === child?.id);
      expect(movedBack?.parentId).toBeNull();
    } finally {
      rendered.unmount();
      await Promise.resolve();
      await deleteRepository(repository);
    }
  });
});
