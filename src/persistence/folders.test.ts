import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import { NeedlewiseDatabase } from './database';
import { ProjectRepository } from './repository';
import { PersistenceError } from './errors';
import { MAX_FOLDER_NAME_CHARS, type ProjectMetadata } from './types';

let databaseCounter = 0;

async function repository(): Promise<ProjectRepository> {
  databaseCounter += 1;
  const db = new NeedlewiseDatabase(`needlewise-folders-test-${String(databaseCounter)}`);
  return new ProjectRepository(db, { now: () => 10 });
}

async function closeRepository(repo: ProjectRepository): Promise<void> {
  await repo.close();
  await repo.db.delete();
}

function fakeProject(id: string, updatedAt = 10): ProjectMetadata {
  return { id, title: `Project ${id}`, notes: '', createdAt: updatedAt, updatedAt, revision: 0 };
}

describe('project folders', () => {
  it('creates and lists folders sorted by name then id', async () => {
    const repo = await repository();
    try {
      await repo.createFolder({ name: 'Zebra', id: 'zebra' });
      await repo.createFolder({ name: 'alpha', id: 'alpha' });
      await repo.createFolder({ name: 'Alpha', id: 'alpha-2' });
      const index = await repo.listFolderIndex();
      expect(index.folders.map((folder) => folder.id)).toEqual(['alpha', 'alpha-2', 'zebra']);
      expect(index.folders[0]).toMatchObject({ id: 'alpha', name: 'alpha', parentId: null, createdAt: 10, updatedAt: 10 });
      expect(index.assignments).toEqual([]);
    } finally {
      await closeRepository(repo);
    }
  });

  it('generates an id with crypto.randomUUID when none is supplied', async () => {
    const repo = await repository();
    try {
      const folder = await repo.createFolder({ name: 'Generated' });
      expect(typeof folder.id).toBe('string');
      expect(folder.id.length).toBeGreaterThan(0);
    } finally {
      await closeRepository(repo);
    }
  });

  it('rejects an empty or overlong folder name', async () => {
    const repo = await repository();
    try {
      await expect(repo.createFolder({ name: '   ' })).rejects.toMatchObject({ code: 'invalid-metadata' });
      await expect(repo.createFolder({ name: 'x'.repeat(MAX_FOLDER_NAME_CHARS + 1) })).rejects.toMatchObject({ code: 'invalid-metadata' });
      await expect(repo.createFolder({ name: 'x'.repeat(MAX_FOLDER_NAME_CHARS) })).resolves.toMatchObject({ name: 'x'.repeat(MAX_FOLDER_NAME_CHARS) });
    } finally {
      await closeRepository(repo);
    }
  });

  it('trims folder names', async () => {
    const repo = await repository();
    try {
      const folder = await repo.createFolder({ name: '  Spaced  ' });
      expect(folder.name).toBe('Spaced');
    } finally {
      await closeRepository(repo);
    }
  });

  it('allows a subfolder under a top-level folder but rejects a subfolder under a subfolder', async () => {
    const repo = await repository();
    try {
      const parent = await repo.createFolder({ name: 'Parent', id: 'parent' });
      const child = await repo.createFolder({ name: 'Child', id: 'child', parentId: parent.id });
      expect(child.parentId).toBe('parent');
      await expect(repo.createFolder({ name: 'Grandchild', parentId: child.id })).rejects.toMatchObject({ code: 'invalid-metadata' });
    } finally {
      await closeRepository(repo);
    }
  });

  it('rejects a missing parent folder', async () => {
    const repo = await repository();
    try {
      await expect(repo.createFolder({ name: 'Orphan', parentId: 'does-not-exist' })).rejects.toMatchObject({ code: 'invalid-metadata' });
    } finally {
      await closeRepository(repo);
    }
  });

  it('renames a folder and validates like creation', async () => {
    const repo = await repository();
    try {
      const folder = await repo.createFolder({ name: 'Original', id: 'folder-1' });
      const renamed = await repo.renameFolder(folder.id, '  Renamed  ');
      expect(renamed).toMatchObject({ id: 'folder-1', name: 'Renamed', updatedAt: 10 });
      await expect(repo.renameFolder(folder.id, '')).rejects.toMatchObject({ code: 'invalid-metadata' });
      await expect(repo.renameFolder('missing', 'Name')).rejects.toMatchObject({ code: 'invalid-metadata' });
    } finally {
      await closeRepository(repo);
    }
  });

  it('moves a project into a folder and back to the top level', async () => {
    const repo = await repository();
    try {
      const folder = await repo.createFolder({ name: 'Folder', id: 'folder-1' });
      await repo.db.projects.put(fakeProject('project-1'));
      await repo.moveProjectToFolder('project-1', folder.id);
      let index = await repo.listFolderIndex();
      expect(index.assignments).toEqual([{ projectId: 'project-1', folderId: 'folder-1' }]);

      await repo.moveProjectToFolder('project-1', null);
      index = await repo.listFolderIndex();
      expect(index.assignments).toEqual([]);
    } finally {
      await closeRepository(repo);
    }
  });

  it('rejects moving a missing project or into a missing folder', async () => {
    const repo = await repository();
    try {
      await repo.db.projects.put(fakeProject('project-1'));
      await expect(repo.moveProjectToFolder('missing-project', null)).rejects.toMatchObject({ code: 'invalid-metadata' });
      await expect(repo.moveProjectToFolder('project-1', 'missing-folder')).rejects.toMatchObject({ code: 'invalid-metadata' });
    } finally {
      await closeRepository(repo);
    }
  });

  it('reparents child folders and assigned projects when a folder is deleted', async () => {
    const repo = await repository();
    try {
      const parent = await repo.createFolder({ name: 'Parent', id: 'parent' });
      const child = await repo.createFolder({ name: 'Child', id: 'child', parentId: parent.id });
      await repo.db.projects.put(fakeProject('project-1'));
      await repo.db.projects.put(fakeProject('project-2'));
      await repo.moveProjectToFolder('project-1', child.id);
      await repo.moveProjectToFolder('project-2', parent.id);

      await repo.deleteFolder(child.id);
      let index = await repo.listFolderIndex();
      expect(index.folders.find((folder) => folder.id === child.id)).toBeUndefined();
      expect(index.assignments.find((assignment) => assignment.projectId === 'project-1')).toMatchObject({ folderId: 'parent' });

      await repo.deleteFolder(parent.id);
      index = await repo.listFolderIndex();
      expect(index.folders).toEqual([]);
      expect(index.assignments).toEqual([]);
    } finally {
      await closeRepository(repo);
    }
  });

  it('is a no-op deleting a missing folder', async () => {
    const repo = await repository();
    try {
      await expect(repo.deleteFolder('does-not-exist')).resolves.toBeUndefined();
    } finally {
      await closeRepository(repo);
    }
  });

  it('excludes assignments whose folder or project no longer exists', async () => {
    const repo = await repository();
    try {
      const folder = await repo.createFolder({ name: 'Folder', id: 'folder-1' });
      await repo.db.projects.put(fakeProject('project-1'));
      await repo.moveProjectToFolder('project-1', folder.id);
      await repo.db.projectFolders.put({ projectId: 'ghost-project', folderId: folder.id });
      await repo.db.projectFolders.put({ projectId: 'project-1', folderId: 'ghost-folder' });
      const index = await repo.listFolderIndex();
      expect(index.assignments).toEqual([]);
    } finally {
      await closeRepository(repo);
    }
  });

  it('removes the folder assignment when a project is deleted', async () => {
    const repo = await repository();
    try {
      const folder = await repo.createFolder({ name: 'Folder', id: 'folder-1' });
      await repo.db.projects.put(fakeProject('project-1'));
      await repo.moveProjectToFolder('project-1', folder.id);
      await repo.deleteProject('project-1');
      expect(await repo.db.projectFolders.get('project-1')).toBeUndefined();
      const index = await repo.listFolderIndex();
      expect(index.assignments).toEqual([]);
    } finally {
      await closeRepository(repo);
    }
  });

  it('opens a v6 database and upgrades it to v7 with folder tables', async () => {
    databaseCounter += 1;
    const databaseName = `needlewise-folders-v6-migration-${String(databaseCounter)}`;
    const legacy = new Dexie(databaseName);
    legacy.version(6).stores({
      projects: 'id, aidaCount',
      currentSnapshots: 'projectId',
      recoverySnapshots: 'projectId',
      projectHeads: 'projectId',
      documentHistories: 'projectId',
      assets: '[projectId+id], projectId',
      dailyActivity: '[projectId+date], projectId'
    });
    await legacy.open();
    await legacy.table('projects').put(fakeProject('old-project'));
    legacy.close();

    const repo = new ProjectRepository(new NeedlewiseDatabase(databaseName), { now: () => 10 });
    try {
      expect(repo.db.verno).toBe(7);
      const projects = await repo.listProjects();
      expect(projects.map((project) => project.id)).toEqual(['old-project']);
      const folder = await repo.createFolder({ name: 'New folder', id: 'new-folder' });
      await repo.moveProjectToFolder('old-project', folder.id);
      const index = await repo.listFolderIndex();
      expect(index.folders).toHaveLength(1);
      expect(index.assignments).toEqual([{ projectId: 'old-project', folderId: 'new-folder' }]);
    } finally {
      await closeRepository(repo);
    }
  });

  it('wraps unexpected Dexie errors as storage-failure while passing through PersistenceError', async () => {
    const repo = await repository();
    try {
      await expect(repo.createFolder({ name: '' })).rejects.toBeInstanceOf(PersistenceError);
      await repo.close();
      await expect(repo.listFolderIndex()).rejects.toMatchObject({ code: 'storage-failure' });
    } finally {
      await repo.db.delete().catch(() => undefined);
    }
  });
});

describe('moveFolder', () => {
  it('rejects moving a folder that does not exist', async () => {
    const repo = await repository();
    try {
      await expect(repo.moveFolder('does-not-exist', null)).rejects.toMatchObject({ code: 'invalid-metadata' });
    } finally {
      await closeRepository(repo);
    }
  });

  it('moves a subfolder to the top level when parentId is null', async () => {
    const repo = await repository();
    try {
      const parent = await repo.createFolder({ name: 'Parent', id: 'parent' });
      const child = await repo.createFolder({ name: 'Child', id: 'child', parentId: parent.id });
      await repo.moveFolder(child.id, null);
      const index = await repo.listFolderIndex();
      expect(index.folders.find((folder) => folder.id === 'child')).toMatchObject({ parentId: null });
    } finally {
      await closeRepository(repo);
    }
  });

  it('rejects a missing target parent', async () => {
    const repo = await repository();
    try {
      await repo.createFolder({ name: 'Folder', id: 'folder-1' });
      await expect(repo.moveFolder('folder-1', 'does-not-exist')).rejects.toMatchObject({ code: 'invalid-metadata' });
    } finally {
      await closeRepository(repo);
    }
  });

  it('rejects a target parent that is itself a subfolder', async () => {
    const repo = await repository();
    try {
      const parent = await repo.createFolder({ name: 'Parent', id: 'parent' });
      const child = await repo.createFolder({ name: 'Child', id: 'child', parentId: parent.id });
      const other = await repo.createFolder({ name: 'Other', id: 'other' });
      await expect(repo.moveFolder(other.id, child.id)).rejects.toMatchObject({ code: 'invalid-metadata' });
    } finally {
      await closeRepository(repo);
    }
  });

  it('rejects moving a folder into itself', async () => {
    const repo = await repository();
    try {
      await repo.createFolder({ name: 'Folder', id: 'folder-1' });
      await expect(repo.moveFolder('folder-1', 'folder-1')).rejects.toMatchObject({ code: 'invalid-metadata' });
    } finally {
      await closeRepository(repo);
    }
  });

  it('rejects moving a folder that has subfolders into another folder', async () => {
    const repo = await repository();
    try {
      const parent = await repo.createFolder({ name: 'Parent', id: 'parent' });
      await repo.createFolder({ name: 'Child', id: 'child', parentId: parent.id });
      const target = await repo.createFolder({ name: 'Target', id: 'target' });
      await expect(repo.moveFolder(parent.id, target.id)).rejects.toMatchObject({ code: 'invalid-metadata' });
    } finally {
      await closeRepository(repo);
    }
  });

  it('moves a top-level folder without subfolders into another top-level folder and updates updatedAt', async () => {
    const db = new NeedlewiseDatabase('needlewise-move-folder-updated-at');
    const writer = new ProjectRepository(db, { now: () => 10 });
    const mover = new ProjectRepository(db, { now: () => 20 });
    try {
      const source = await writer.createFolder({ name: 'Source', id: 'source' });
      const target = await writer.createFolder({ name: 'Target', id: 'target' });
      expect(source.updatedAt).toBe(10);
      await mover.moveFolder(source.id, target.id);
      const index = await writer.listFolderIndex();
      expect(index.folders.find((folder) => folder.id === 'source')).toMatchObject({ parentId: 'target', updatedAt: 20, createdAt: 10 });
    } finally {
      await mover.close();
      await db.delete();
    }
  });
});
