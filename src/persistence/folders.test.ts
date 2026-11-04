import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import { NeedlewiseDatabase } from './database';
import { ProjectRepository } from './repository';
import { PersistenceError } from './errors';
import { arrangeLevel, levelItems } from './gallery-order';
import { MAX_FOLDER_NAME_CHARS, ROOT_LEVEL_ID, TRASH_RETENTION_MS, type ProjectMetadata } from './types';

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

/** The order the gallery displays for a level. */
async function shown(repo: ProjectRepository, levelId: string): Promise<string[]> {
  const [index, projects] = await Promise.all([repo.listGalleryIndex(), repo.listProjects()]);
  return arrangeLevel(levelItems(levelId, { ...index, projects }), index.orders.find((order) => order.levelId === levelId)?.keys);
}

describe('project folders', () => {
  it('creates and lists folders sorted by name then id', async () => {
    const repo = await repository();
    try {
      await repo.createFolder({ name: 'Zebra', id: 'zebra' });
      await repo.createFolder({ name: 'alpha', id: 'alpha' });
      await repo.createFolder({ name: 'Alpha', id: 'alpha-2' });
      const index = await repo.listGalleryIndex();
      expect(index.folders.map((folder) => folder.id)).toEqual(['alpha', 'alpha-2', 'zebra']);
      expect(index.folders[0]).toMatchObject({ id: 'alpha', name: 'alpha', parentId: null, createdAt: 10, updatedAt: 10 });
      expect(index.assignments).toEqual([]);
    } finally {
      await closeRepository(repo);
    }
  });

  it('rejects an empty or overlong folder name', async () => {
    const repo = await repository();
    try {
      await expect(repo.createFolder({ id: 'folder-x1', name: '   ' })).rejects.toMatchObject({ code: 'invalid-metadata' });
      await expect(repo.createFolder({ id: 'folder-x2', name: 'x'.repeat(MAX_FOLDER_NAME_CHARS + 1) })).rejects.toMatchObject({ code: 'invalid-metadata' });
      await expect(repo.createFolder({ id: 'folder-x3', name: 'x'.repeat(MAX_FOLDER_NAME_CHARS) })).resolves.toMatchObject({ folder: { name: 'x'.repeat(MAX_FOLDER_NAME_CHARS) } });
    } finally {
      await closeRepository(repo);
    }
  });

  it('trims folder names', async () => {
    const repo = await repository();
    try {
      const { folder } = await repo.createFolder({ id: 'folder-x4', name: '  Spaced  ' });
      expect(folder.name).toBe('Spaced');
    } finally {
      await closeRepository(repo);
    }
  });

  it('allows a subfolder under a top-level folder but rejects a subfolder under a subfolder', async () => {
    const repo = await repository();
    try {
      const { folder: parent } = await repo.createFolder({ name: 'Parent', id: 'parent' });
      const { folder: child } = await repo.createFolder({ name: 'Child', id: 'child', parentId: parent.id });
      expect(child.parentId).toBe('parent');
      await expect(repo.createFolder({ id: 'folder-x5', name: 'Grandchild', parentId: child.id })).rejects.toMatchObject({ code: 'invalid-metadata' });
    } finally {
      await closeRepository(repo);
    }
  });

  it('rejects a missing parent folder', async () => {
    const repo = await repository();
    try {
      await expect(repo.createFolder({ id: 'folder-x6', name: 'Orphan', parentId: 'does-not-exist' })).rejects.toMatchObject({ code: 'invalid-metadata' });
    } finally {
      await closeRepository(repo);
    }
  });

  it('renames a folder and validates like creation', async () => {
    const repo = await repository();
    try {
      const { folder } = await repo.createFolder({ name: 'Original', id: 'folder-1' });
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
      const { folder } = await repo.createFolder({ name: 'Folder', id: 'folder-1' });
      await repo.db.projects.put(fakeProject('project-1'));
      await repo.moveProjectsToFolder(['project-1'], folder.id);
      let index = await repo.listGalleryIndex();
      expect(index.assignments).toEqual([{ projectId: 'project-1', folderId: 'folder-1', assignedAt: 10 }]);

      await repo.moveProjectsToFolder(['project-1'], null);
      index = await repo.listGalleryIndex();
      expect(index.assignments).toEqual([]);
    } finally {
      await closeRepository(repo);
    }
  });

  it('rejects moving a missing project or into a missing folder', async () => {
    const repo = await repository();
    try {
      await repo.db.projects.put(fakeProject('project-1'));
      await expect(repo.moveProjectsToFolder(['missing-project'], null)).rejects.toMatchObject({ code: 'invalid-metadata' });
      await expect(repo.moveProjectsToFolder(['project-1'], 'missing-folder')).rejects.toMatchObject({ code: 'invalid-metadata' });
    } finally {
      await closeRepository(repo);
    }
  });

  it('reparents child folders and assigned projects when a folder is deleted', async () => {
    const repo = await repository();
    try {
      const { folder: parent } = await repo.createFolder({ name: 'Parent', id: 'parent' });
      const { folder: child } = await repo.createFolder({ name: 'Child', id: 'child', parentId: parent.id });
      await repo.db.projects.put(fakeProject('project-1'));
      await repo.db.projects.put(fakeProject('project-2'));
      await repo.moveProjectsToFolder(['project-1'], child.id);
      await repo.moveProjectsToFolder(['project-2'], parent.id);

      await repo.deleteFolder(child.id);
      let index = await repo.listGalleryIndex();
      expect(index.folders.find((folder) => folder.id === child.id)).toBeUndefined();
      expect(index.assignments.find((assignment) => assignment.projectId === 'project-1')).toMatchObject({ folderId: 'parent' });

      await repo.deleteFolder(parent.id);
      index = await repo.listGalleryIndex();
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
      const { folder } = await repo.createFolder({ name: 'Folder', id: 'folder-1' });
      await repo.db.projects.put(fakeProject('project-1'));
      await repo.moveProjectsToFolder(['project-1'], folder.id);
      await repo.db.projectFolders.put({ projectId: 'ghost-project', folderId: folder.id, assignedAt: 0 });
      await repo.db.projectFolders.put({ projectId: 'project-1', folderId: 'ghost-folder', assignedAt: 0 });
      const index = await repo.listGalleryIndex();
      expect(index.assignments).toEqual([]);
    } finally {
      await closeRepository(repo);
    }
  });

  it('removes the folder assignment when a project is deleted', async () => {
    const repo = await repository();
    try {
      const { folder } = await repo.createFolder({ name: 'Folder', id: 'folder-1' });
      await repo.db.projects.put(fakeProject('project-1'));
      await repo.moveProjectsToFolder(['project-1'], folder.id);
      await repo.trashProjects(['project-1']);
      await repo.trashProjects([]);
      expect(await repo.db.projectFolders.get('project-1')).toBeUndefined();
      const index = await repo.listGalleryIndex();
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
      expect(repo.db.verno).toBe(9);
      const projects = await repo.listProjects();
      expect(projects.map((project) => project.id)).toEqual(['old-project']);
      const { folder } = await repo.createFolder({ name: 'New folder', id: 'new-folder' });
      await repo.moveProjectsToFolder(['old-project'], folder.id);
      const index = await repo.listGalleryIndex();
      expect(index.folders).toHaveLength(1);
      expect(index.assignments).toEqual([{ projectId: 'old-project', folderId: 'new-folder', assignedAt: 10 }]);
    } finally {
      await closeRepository(repo);
    }
  });

  it('assigns projects to a new folder in one transaction and creates nothing for a missing project', async () => {
    const repo = await repository();
    try {
      await repo.db.projects.bulkPut([fakeProject('a'), fakeProject('b')]);
      await repo.createFolder({ name: 'Group', id: 'group', projectIds: ['a', 'b'] });
      await expect(repo.createFolder({ name: 'Broken', id: 'broken', projectIds: ['a', 'missing'] })).rejects.toMatchObject({ code: 'invalid-metadata' });
      const index = await repo.listGalleryIndex();
      expect(index.folders.map((folder) => folder.id)).toEqual(['group']);
      expect(index.assignments).toEqual(expect.arrayContaining([{ projectId: 'a', folderId: 'group', assignedAt: 10 }, { projectId: 'b', folderId: 'group', assignedAt: 10 }]));
      expect(index.assignments).toHaveLength(2);
    } finally {
      await closeRepository(repo);
    }
  });

  it('opens a v7 database with an assignment row at v8 with assignedAt 0', async () => {
    databaseCounter += 1;
    const databaseName = `needlewise-folders-v7-migration-${String(databaseCounter)}`;
    const legacy = new Dexie(databaseName);
    legacy.version(7).stores({
      projects: 'id, aidaCount',
      currentSnapshots: 'projectId',
      recoverySnapshots: 'projectId',
      projectHeads: 'projectId',
      documentHistories: 'projectId',
      assets: '[projectId+id], projectId',
      dailyActivity: '[projectId+date], projectId',
      folders: 'id, parentId',
      projectFolders: 'projectId, folderId'
    });
    await legacy.open();
    await legacy.table('folders').put({ id: 'f', name: 'F', parentId: null, createdAt: 1, updatedAt: 1 });
    await legacy.table('projects').put(fakeProject('p'));
    await legacy.table('projectFolders').put({ projectId: 'p', folderId: 'f' });
    legacy.close();

    const repo = new ProjectRepository(new NeedlewiseDatabase(databaseName), { now: () => 10 });
    try {
      const index = await repo.listGalleryIndex();
      expect(index.assignments).toEqual([{ projectId: 'p', folderId: 'f', assignedAt: 0 }]);
    } finally {
      await closeRepository(repo);
    }
  });

  it('wraps unexpected Dexie errors as storage-failure while passing through PersistenceError', async () => {
    const repo = await repository();
    try {
      await expect(repo.createFolder({ id: 'folder-x7', name: '' })).rejects.toBeInstanceOf(PersistenceError);
      await repo.close();
      await expect(repo.listGalleryIndex()).rejects.toMatchObject({ code: 'storage-failure' });
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
      const { folder: parent } = await repo.createFolder({ name: 'Parent', id: 'parent' });
      const { folder: child } = await repo.createFolder({ name: 'Child', id: 'child', parentId: parent.id });
      await repo.moveFolder(child.id, null);
      const index = await repo.listGalleryIndex();
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
      const { folder: parent } = await repo.createFolder({ name: 'Parent', id: 'parent' });
      const { folder: child } = await repo.createFolder({ name: 'Child', id: 'child', parentId: parent.id });
      const { folder: other } = await repo.createFolder({ name: 'Other', id: 'other' });
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
      const { folder: parent } = await repo.createFolder({ name: 'Parent', id: 'parent' });
      await repo.createFolder({ name: 'Child', id: 'child', parentId: parent.id });
      const { folder: target } = await repo.createFolder({ name: 'Target', id: 'target' });
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
      const { folder: source } = await writer.createFolder({ name: 'Source', id: 'source' });
      const { folder: target } = await writer.createFolder({ name: 'Target', id: 'target' });
      expect(source.updatedAt).toBe(10);
      await mover.moveFolder(source.id, target.id);
      const index = await writer.listGalleryIndex();
      expect(index.folders.find((folder) => folder.id === 'source')).toMatchObject({ parentId: 'target', updatedAt: 20, createdAt: 10 });
    } finally {
      await mover.close();
      await db.delete();
    }
  });
});

describe('gallery order', () => {
  it('saves a level order and returns it from the gallery index after reopening', async () => {
    databaseCounter += 1;
    const databaseName = `needlewise-gallery-order-reopen-${String(databaseCounter)}`;
    const repo = new ProjectRepository(new NeedlewiseDatabase(databaseName), { now: () => 10 });
    await repo.db.projects.bulkPut([fakeProject('a'), fakeProject('b'), fakeProject('c')]);
    await repo.setGalleryOrder(ROOT_LEVEL_ID, ['project:c', 'project:a', 'project:b']);
    await repo.close();
    const reopened = new ProjectRepository(new NeedlewiseDatabase(databaseName), { now: () => 10 });
    try {
      expect((await reopened.listGalleryIndex()).orders).toEqual([{ levelId: 'root', keys: ['project:c', 'project:a', 'project:b'] }]);
    } finally {
      await closeRepository(reopened);
    }
  });

  it('rejects an order with duplicate or unparseable keys, or for a missing folder', async () => {
    const repo = await repository();
    try {
      await expect(repo.setGalleryOrder(ROOT_LEVEL_ID, ['project:a', 'project:a'])).rejects.toMatchObject({ code: 'invalid-metadata' });
      await expect(repo.setGalleryOrder(ROOT_LEVEL_ID, ['bogus'])).rejects.toMatchObject({ code: 'invalid-metadata' });
      await expect(repo.setGalleryOrder('no-such-folder', [])).rejects.toMatchObject({ code: 'invalid-metadata' });
    } finally {
      await closeRepository(repo);
    }
  });

  it('makes a pattern moved into an arranged folder a newcomer there', async () => {
    const repo = await repository();
    try {
      await repo.db.projects.bulkPut([fakeProject('x', 1), fakeProject('y', 2), fakeProject('z', 0)]);
      await repo.createFolder({ name: 'F', id: 'f', projectIds: ['x', 'y'] });
      await repo.setGalleryOrder('f', ['project:y', 'project:x']);
      await repo.moveProjectsToFolder(['z'], 'f');
      expect((await repo.listGalleryIndex()).orders.find((order) => order.levelId === 'f')?.keys).toEqual(['project:y', 'project:x']);
      expect(await shown(repo, 'f')).toEqual(['project:z', 'project:y', 'project:x']);
    } finally {
      await closeRepository(repo);
    }
  });

  it('moves several patterns at once and undo returns each to its folder and spot', async () => {
    const repo = await repository();
    try {
      await repo.db.projects.bulkPut([fakeProject('a', 3), fakeProject('b', 2), fakeProject('c', 1), fakeProject('d', 5), fakeProject('e', 4)]);
      await repo.createFolder({ name: 'F', id: 'f' });
      await repo.createFolder({ name: 'G', id: 'g', projectIds: ['d', 'e'] });
      expect(await shown(repo, ROOT_LEVEL_ID)).toEqual(['folder:g', 'folder:f', 'project:a', 'project:b', 'project:c']);
      expect(await shown(repo, 'g')).toEqual(['project:d', 'project:e']);

      const undo = await repo.moveProjectsToFolder(['b', 'd'], 'f');
      expect(await shown(repo, ROOT_LEVEL_ID)).toEqual(['folder:g', 'folder:f', 'project:a', 'project:c']);
      expect(await shown(repo, 'g')).toEqual(['project:e']);

      await repo.restoreGallery(undo);
      const index = await repo.listGalleryIndex();
      expect(index.assignments.find((assignment) => assignment.projectId === 'b')).toBeUndefined();
      expect(index.assignments.find((assignment) => assignment.projectId === 'd')).toMatchObject({ folderId: 'g' });
      expect(await shown(repo, ROOT_LEVEL_ID)).toEqual(['folder:g', 'folder:f', 'project:a', 'project:b', 'project:c']);
      expect(await shown(repo, 'g')).toEqual(['project:d', 'project:e']);
    } finally {
      await closeRepository(repo);
    }
  });

  it('returns a pattern to its spot after the user rearranged the level in between, keeping that rearrangement', async () => {
    const repo = await repository();
    try {
      await repo.db.projects.bulkPut([fakeProject('a', 4), fakeProject('b', 3), fakeProject('c', 2), fakeProject('d', 1)]);
      await repo.setGalleryOrder(ROOT_LEVEL_ID, ['project:a', 'project:b', 'project:c', 'project:d']);
      await repo.createFolder({ name: 'F', id: 'f' });
      const undo = await repo.moveProjectsToFolder(['b'], 'f');
      await repo.setGalleryOrder(ROOT_LEVEL_ID, ['project:d', 'project:a', 'project:c', 'folder:f']);
      await repo.restoreGallery(undo);
      expect(await shown(repo, ROOT_LEVEL_ID)).toEqual(['project:d', 'project:a', 'project:b', 'project:c', 'folder:f']);
    } finally {
      await closeRepository(repo);
    }
  });

  it('never changes a stored order when restoring an undo', async () => {
    const repo = await repository();
    try {
      await repo.db.projects.bulkPut([fakeProject('a', 2), fakeProject('b', 1)]);
      await repo.createFolder({ name: 'F', id: 'f' });
      const undo = await repo.moveProjectsToFolder(['a'], 'f');
      await repo.setGalleryOrder('f', ['project:a']);
      const before = await repo.db.galleryOrders.toArray();
      await repo.restoreGallery(undo);
      expect(await repo.db.galleryOrders.toArray()).toEqual(before);
    } finally {
      await closeRepository(repo);
    }
  });

  it('records the spot of a pattern leaving a never-arranged level', async () => {
    const repo = await repository();
    try {
      await repo.db.projects.bulkPut([fakeProject('a', 3), fakeProject('b', 2), fakeProject('c', 1)]);
      await repo.createFolder({ name: 'F', id: 'f' });
      const before = await shown(repo, ROOT_LEVEL_ID);
      const undo = await repo.moveProjectsToFolder(['b'], 'f');
      await repo.db.projects.put(fakeProject('n', 20));
      await repo.restoreGallery(undo);
      expect(await shown(repo, ROOT_LEVEL_ID)).toEqual(['project:n', ...before]);
    } finally {
      await closeRepository(repo);
    }
  });

  it('gives a folder made by grouping the target pattern’s spot, and undo returns both patterns to their own spots', async () => {
    const repo = await repository();
    try {
      await repo.db.projects.bulkPut([fakeProject('a', 4), fakeProject('b', 3), fakeProject('c', 2), fakeProject('d', 1)]);
      expect(await shown(repo, ROOT_LEVEL_ID)).toEqual(['project:a', 'project:b', 'project:c', 'project:d']);
      const { undo } = await repo.createFolder({ name: 'New folder', id: 'n', projectIds: ['b', 'd'], takesSpotOf: 'b' });
      expect(await shown(repo, ROOT_LEVEL_ID)).toEqual(['project:a', 'folder:n', 'project:c']);
      await repo.restoreGallery(undo);
      expect((await repo.listGalleryIndex()).folders).toEqual([]);
      expect(await shown(repo, ROOT_LEVEL_ID)).toEqual(['project:a', 'project:b', 'project:c', 'project:d']);
    } finally {
      await closeRepository(repo);
    }
  });

  it('hides trashed patterns and restores them to their spots', async () => {
    const repo = await repository();
    try {
      await repo.db.projects.bulkPut([fakeProject('a', 3), fakeProject('b', 2), fakeProject('c', 1)]);
      await repo.trashProjects(['a', 'c']);
      expect((await repo.listProjects()).map((project) => project.id)).toEqual(['b']);
      expect(await repo.load('a')).toBeUndefined();
      expect(await shown(repo, ROOT_LEVEL_ID)).toEqual(['project:b']);
      await repo.restoreTrashedProjects(['a', 'c']);
      expect(await shown(repo, ROOT_LEVEL_ID)).toEqual(['project:a', 'project:b', 'project:c']);
    } finally {
      await closeRepository(repo);
    }
  });

  it('permanently deletes earlier trashed patterns when a new delete happens', async () => {
    const repo = await repository();
    try {
      await repo.db.projects.bulkPut([fakeProject('a', 2), fakeProject('b', 1)]);
      await repo.trashProjects(['a']);
      await repo.trashProjects(['b']);
      await repo.restoreTrashedProjects(['a']);
      expect(await repo.db.projects.get('a')).toBeUndefined();
      await repo.restoreTrashedProjects(['b']);
      expect((await repo.listProjects()).map((project) => project.id)).toEqual(['b']);
    } finally {
      await closeRepository(repo);
    }
  });

  it('purges only patterns trashed longer ago than the retention period', async () => {
    databaseCounter += 1;
    let time = 0;
    const repo = new ProjectRepository(new NeedlewiseDatabase(`needlewise-gallery-purge-${String(databaseCounter)}`), { now: () => time });
    try {
      await repo.db.projects.bulkPut([fakeProject('a', 2), fakeProject('b', 1)]);
      await repo.trashProjects(['a']);
      time = TRASH_RETENTION_MS;
      await repo.purgeTrashedProjects();
      await repo.restoreTrashedProjects(['a']);
      expect((await repo.listProjects()).map((project) => project.id)).toEqual(['a', 'b']);

      await repo.trashProjects(['a']);
      time += TRASH_RETENTION_MS + 1;
      await repo.purgeTrashedProjects();
      expect(await repo.db.projects.get('a')).toBeUndefined();
      expect((await repo.db.galleryOrders.toArray()).some((order) => order.keys.includes('project:a'))).toBe(false);
    } finally {
      await closeRepository(repo);
    }
  });

  it('keeps the spot of a newcomer that leaves an arranged level', async () => {
    const repo = await repository();
    try {
      await repo.db.projects.bulkPut([fakeProject('a', 1), fakeProject('b', 2), fakeProject('c', 3)]);
      await repo.createFolder({ name: 'F', id: 'f' });
      await repo.setGalleryOrder(ROOT_LEVEL_ID, ['project:a', 'project:b', 'project:c', 'folder:f']);
      await repo.db.projects.bulkPut([fakeProject('n1', 30), fakeProject('n2', 20)]);
      expect(await shown(repo, ROOT_LEVEL_ID)).toEqual(['project:n1', 'project:n2', 'project:a', 'project:b', 'project:c', 'folder:f']);
      const undo = await repo.moveProjectsToFolder(['n2'], 'f');
      await repo.setGalleryOrder(ROOT_LEVEL_ID, ['project:a', 'project:b', 'project:c', 'project:n1', 'folder:f']);
      await repo.restoreGallery(undo);
      expect(await shown(repo, ROOT_LEVEL_ID)).toEqual(['project:a', 'project:b', 'project:c', 'project:n1', 'project:n2', 'folder:f']);
    } finally {
      await closeRepository(repo);
    }
  });

  it('keeps the spot of a trashed newcomer from an arranged level', async () => {
    const repo = await repository();
    try {
      await repo.db.projects.bulkPut([fakeProject('a', 1), fakeProject('b', 2), fakeProject('c', 3)]);
      await repo.setGalleryOrder(ROOT_LEVEL_ID, ['project:a', 'project:b', 'project:c']);
      await repo.db.projects.bulkPut([fakeProject('n1', 30), fakeProject('n2', 20)]);
      await repo.trashProjects(['n2']);
      await repo.setGalleryOrder(ROOT_LEVEL_ID, ['project:a', 'project:b', 'project:c', 'project:n1']);
      await repo.restoreTrashedProjects(['n2']);
      expect(await shown(repo, ROOT_LEVEL_ID)).toEqual(['project:a', 'project:b', 'project:c', 'project:n1', 'project:n2']);
    } finally {
      await closeRepository(repo);
    }
  });

  it('restores a folder to the top level when its old parent can no longer hold it', async () => {
    const repo = await repository();
    try {
      await repo.createFolder({ name: 'P', id: 'p' });
      await repo.createFolder({ name: 'Q', id: 'q' });
      await repo.createFolder({ name: 'C', id: 'c', parentId: 'p' });
      const undo = await repo.moveFolder('c', null);
      await repo.moveFolder('p', 'q');
      await repo.restoreGallery(undo);
      const folders = (await repo.listGalleryIndex()).folders;
      expect(folders.find((folder) => folder.id === 'c')).toMatchObject({ parentId: null });
      expect(folders.find((folder) => folder.id === 'p')).toMatchObject({ parentId: 'q' });
    } finally {
      await closeRepository(repo);
    }
  });

  it('puts a deleted folder’s contents in its spot in the parent', async () => {
    const repo = await repository();
    try {
      await repo.db.projects.bulkPut([fakeProject('a'), fakeProject('b'), fakeProject('x'), fakeProject('y')]);
      await repo.createFolder({ name: 'F', id: 'f', projectIds: ['x', 'y'] });
      await repo.setGalleryOrder(ROOT_LEVEL_ID, ['project:a', 'folder:f', 'project:b']);
      await repo.setGalleryOrder('f', ['project:y', 'project:x']);
      await repo.deleteFolder('f');
      expect((await repo.listGalleryIndex()).orders).toEqual([{ levelId: 'root', keys: ['project:a', 'project:y', 'project:x', 'project:b'] }]);
    } finally {
      await closeRepository(repo);
    }
  });

  it('removes a permanently deleted pattern from every stored order and its opened record', async () => {
    const repo = await repository();
    try {
      await repo.db.projects.bulkPut([fakeProject('a'), fakeProject('b')]);
      await repo.setGalleryOrder(ROOT_LEVEL_ID, ['project:a', 'project:b']);
      await repo.recordProjectOpen('b');
      await repo.trashProjects(['b']);
      await repo.trashProjects([]);
      const index = await repo.listGalleryIndex();
      expect(index.orders).toEqual([{ levelId: 'root', keys: ['project:a'] }]);
      expect(index.opens).toEqual([]);
    } finally {
      await closeRepository(repo);
    }
  });

  it('skips missing entities when restoring an undo', async () => {
    const repo = await repository();
    try {
      await repo.db.projects.bulkPut([fakeProject('a'), fakeProject('b')]);
      await repo.createFolder({ name: 'G', id: 'g', projectIds: ['a'] });
      await repo.createFolder({ name: 'F', id: 'f' });
      const undo = await repo.moveProjectsToFolder(['a', 'b'], 'f');
      await repo.trashProjects(['b']);
      await repo.trashProjects([]);
      await repo.deleteFolder('g');
      await expect(repo.restoreGallery(undo)).resolves.toBeUndefined();
      expect((await repo.listGalleryIndex()).assignments).toEqual([]);
    } finally {
      await closeRepository(repo);
    }
  });

  it('records when a pattern was opened', async () => {
    databaseCounter += 1;
    const repo = new ProjectRepository(new NeedlewiseDatabase(`needlewise-gallery-opened-${String(databaseCounter)}`), { now: () => 42 });
    try {
      await repo.db.projects.put(fakeProject('a'));
      await repo.recordProjectOpen('a');
      expect((await repo.listGalleryIndex()).opens).toEqual([{ projectId: 'a', openedAt: 42 }]);
    } finally {
      await closeRepository(repo);
    }
  });

  it('opens a v8 database at v9 and keeps its folders and assignments', async () => {
    databaseCounter += 1;
    const databaseName = `needlewise-folders-v8-migration-${String(databaseCounter)}`;
    const legacy = new Dexie(databaseName);
    legacy.version(8).stores({
      projects: 'id, aidaCount',
      currentSnapshots: 'projectId',
      recoverySnapshots: 'projectId',
      projectHeads: 'projectId',
      documentHistories: 'projectId',
      assets: '[projectId+id], projectId',
      dailyActivity: '[projectId+date], projectId',
      folders: 'id, parentId',
      projectFolders: 'projectId, folderId'
    });
    await legacy.open();
    await legacy.table('folders').put({ id: 'f', name: 'F', parentId: null, createdAt: 1, updatedAt: 1 });
    await legacy.table('projects').put(fakeProject('p'));
    await legacy.table('projectFolders').put({ projectId: 'p', folderId: 'f', assignedAt: 3 });
    legacy.close();

    const repo = new ProjectRepository(new NeedlewiseDatabase(databaseName), { now: () => 10 });
    try {
      const index = await repo.listGalleryIndex();
      expect(repo.db.verno).toBe(9);
      expect(index.folders.map((folder) => folder.id)).toEqual(['f']);
      expect(index.assignments).toEqual([{ projectId: 'p', folderId: 'f', assignedAt: 3 }]);
      expect(index.orders).toEqual([]);
      expect(index.opens).toEqual([]);
    } finally {
      await closeRepository(repo);
    }
  });
});
