import 'fake-indexeddb/auto';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CreatedFolder, GalleryUndo, ProjectFolder, ProjectGalleryIndex } from '../persistence';
import { NeedlewiseDatabase, ProjectRepository } from '../persistence';
import { ProjectWorkspace, useProjectWorkspace } from './index';
import { MemoryRepository } from './test-support';

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
  it('delegates folder operations to the repository', async () => {
    const index: ProjectGalleryIndex = { folders: [folder('a', 'Alphas')], assignments: [{ projectId: 'p1', folderId: 'a', assignedAt: 0 }], orders: [{ levelId: 'root', keys: ['folder:a'] }], opens: [{ projectId: 'p1', openedAt: 3 }] };
    const undo: GalleryUndo = { assignments: [{ projectId: 'p1', assignment: null }], folderParents: [], createdFolderId: null };
    const created: CreatedFolder = { folder: folder('b', 'Betas'), undo: { assignments: [], folderParents: [], createdFolderId: 'b' } };
    const renamed = folder('b', 'Betas renamed');
    const repository = Object.assign(new MemoryRepository(), {
      listGalleryIndex: vi.fn(async () => index),
      createFolder: vi.fn(async (input) => {
        expect(input).toEqual({ name: 'Betas', parentId: null, id: expect.any(String), projectIds: [] });
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
      moveProjectsToFolder: vi.fn(async (projectIds, folderId) => {
        expect(projectIds).toEqual(['p1']);
        expect(folderId).toBe('a');
        return undo;
      }),
      moveFolder: vi.fn(async (folderId, parentId) => {
        expect(folderId).toBe('b');
        expect(parentId).toBe('a');
        return undo;
      })
    });
    const workspace = new ProjectWorkspace({ repository });

    expect(await workspace.listGalleryIndex()).toEqual(index);
    expect(await workspace.createFolder('Betas')).toEqual(created);
    expect(await workspace.renameFolder('b', 'Betas renamed')).toEqual(renamed);

    await workspace.deleteFolder('b');
    expect(repository.deleteFolder).toHaveBeenCalled();

    expect(await workspace.moveProjectsToFolder(['p1'], 'a')).toEqual(undo);
    expect(await workspace.moveFolder('b', 'a')).toEqual(undo);
  });

  it('passes the parentId and the spot to take through to createFolder', async () => {
    const created: CreatedFolder = { folder: folder('child', 'Child', 'parent'), undo: { assignments: [], folderParents: [], createdFolderId: 'child' } };
    const createFolder = vi.fn(async () => created);
    const repository = Object.assign(new MemoryRepository(), { createFolder });
    const workspace = new ProjectWorkspace({ repository });

    await workspace.createFolder('Child', 'parent');
    expect(createFolder).toHaveBeenCalledWith({ name: 'Child', parentId: 'parent', id: expect.any(String), projectIds: [] });
    await workspace.createFolder('Group', null, ['p1', 'p2'], 'p1');
    expect(createFolder).toHaveBeenLastCalledWith({ name: 'Group', parentId: null, id: expect.any(String), projectIds: ['p1', 'p2'], takesSpotOf: 'p1' });
  });

  it('records an open when a project is opened and lists it in the gallery index', async () => {
    const repository = new MemoryRepository(() => 77);
    const workspace = new ProjectWorkspace({ repository, projectIdFactory: () => 'opened' });
    try {
      await workspace.createProject({ id: 'opened' });
      await workspace.openProject('opened');
      expect((await workspace.listGalleryIndex()).opens).toEqual([{ projectId: 'opened', openedAt: 77 }]);
    } finally {
      await workspace.dispose();
    }
  });

  it('still opens a project when recording the open fails', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, projectIdFactory: () => 'opened' });
    try {
      await workspace.createProject({ id: 'opened' });
      vi.spyOn(repository, 'recordProjectOpen').mockRejectedValue(new Error('x'));
      await expect(workspace.openProject('opened')).resolves.toBeTruthy();
      expect(workspace.activeProjectId).toBe('opened');
      expect(workspace.error).toBeNull();
    } finally {
      await workspace.dispose();
    }
  });

  it('saves a level order and lists it in the gallery index', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository });
    try {
      await workspace.createProject({ id: 'a' });
      await workspace.createProject({ id: 'b' });
      await workspace.setGalleryOrder('root', ['project:a', 'project:b']);
      expect((await workspace.listGalleryIndex()).orders).toEqual([{ levelId: 'root', keys: ['project:a', 'project:b'] }]);
    } finally {
      await workspace.dispose();
    }
  });

  it('undoes a bulk move through restoreGallery', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository, projectIdFactory: () => 'kits' });
    try {
      await workspace.createProject({ id: 'a' });
      await workspace.createProject({ id: 'b' });
      const { folder: created } = await workspace.createFolder('Kits');
      const undo = await workspace.moveProjectsToFolder(['a', 'b'], created.id);
      expect((await workspace.listGalleryIndex()).assignments.map((assignment) => assignment.projectId).sort()).toEqual(['a', 'b']);
      await workspace.restoreGallery(undo);
      expect((await workspace.listGalleryIndex()).assignments).toEqual([]);
    } finally {
      await workspace.dispose();
    }
  });

  it('deletes the open project and restores it on undo', async () => {
    const repository = new MemoryRepository();
    const workspace = new ProjectWorkspace({ repository });
    try {
      await workspace.createProject({ id: 'a' });
      await workspace.createProject({ id: 'b' });
      await workspace.openProject('a');
      await workspace.deleteProjects(['a', 'b']);
      expect(await workspace.listProjects()).toEqual([]);
      expect(workspace.activeProjectId).toBeNull();
      expect(workspace.session).toBeNull();
      await workspace.restoreDeletedProjects(['a', 'b']);
      expect((await workspace.listProjects()).map((project) => project.id).sort()).toEqual(['a', 'b']);
      await expect(workspace.openProject('a')).resolves.toBeTruthy();
    } finally {
      await workspace.dispose();
    }
  });
});

describe('useProjectWorkspace folder state', () => {
  it('exposes folders and folderAssignments after init and after createFolder', async () => {
    const repository = makeRepository();
    const rendered = renderHook(() => useProjectWorkspace({ repository }));
    try {
      await waitFor(() => expect(rendered.result.current.initialized).toBe(true));
      expect(rendered.result.current.folders).toEqual([]);
      expect(rendered.result.current.folderAssignments).toEqual([]);

      let created: ProjectFolder | undefined;
      await act(async () => {
        created = (await rendered.result.current.createFolder('Sampler kits')).folder;
      });
      expect(created?.name).toBe('Sampler kits');
      expect(rendered.result.current.folders.map((f) => f.name)).toEqual(['Sampler kits']);

      await act(async () => {
        await rendered.result.current.createProject({ width: 2, height: 2 });
      });
      const projectId = rendered.result.current.state.projectId;
      expect(projectId).not.toBeNull();
      await act(async () => {
        await rendered.result.current.moveProjectsToFolder([projectId as string], created?.id ?? null);
      });
      expect(rendered.result.current.folderAssignments).toEqual([{ projectId, folderId: created?.id, assignedAt: expect.any(Number) }]);

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
    const rendered = renderHook(() => useProjectWorkspace({ repository }));
    try {
      await waitFor(() => expect(rendered.result.current.initialized).toBe(true));

      let parent: ProjectFolder | undefined;
      let child: ProjectFolder | undefined;
      await act(async () => {
        parent = (await rendered.result.current.createFolder('Parent')).folder;
      });
      await act(async () => {
        child = (await rendered.result.current.createFolder('Child')).folder;
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
