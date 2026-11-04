import { describe, expect, it } from 'vitest';
import { arrangeLevel, folderItemKey, keepHiddenKeys, levelItems, parseItemKey, projectItemKey } from './gallery-order';
import { ROOT_LEVEL_ID } from './types';

describe('gallery order', () => {
  it('puts newcomers first, newest created first, then stored keys in stored order', () => {
    const items = [{ key: 'project:a', createdAt: 1 }, { key: 'project:b', createdAt: 2 }, { key: 'project:c', createdAt: 3 }, { key: 'folder:f', createdAt: 4 }];
    expect(arrangeLevel(items, ['project:a', 'project:missing', 'project:c'])).toEqual(['folder:f', 'project:b', 'project:a', 'project:c']);
  });

  it('arranges an unstored level purely by created date', () => {
    expect(arrangeLevel([{ key: 'project:a', createdAt: 1 }, { key: 'project:b', createdAt: 2 }], undefined)).toEqual(['project:b', 'project:a']);
  });

  it('round-trips item keys and rejects unknown prefixes', () => {
    expect(parseItemKey(projectItemKey('x'))).toEqual({ kind: 'project', id: 'x' });
    expect(parseItemKey(folderItemKey('y'))).toEqual({ kind: 'folder', id: 'y' });
    expect(parseItemKey('other:z')).toBeNull();
  });

  it('keeps hidden keys beside their old neighbours when a reorder is saved', () => {
    expect(keepHiddenKeys(['a', 'b', 'c', 'd'], ['d', 'a', 'c'])).toEqual(['d', 'a', 'b', 'c']);
    expect(keepHiddenKeys(['x', 'a', 'b'], ['b', 'a'])).toEqual(['x', 'b', 'a']);
  });

  it('lists a level’s folders and projects, treating an orphaned assignment as top level', () => {
    const data = {
      folders: [
        { id: 't', name: 'T', parentId: null, createdAt: 5, updatedAt: 5 },
        { id: 'c', name: 'C', parentId: 't', createdAt: 6, updatedAt: 6 }
      ],
      assignments: [
        { projectId: 'p2', folderId: 't', assignedAt: 1 },
        { projectId: 'p3', folderId: 'gone', assignedAt: 1 }
      ],
      projects: [{ id: 'p1', createdAt: 1 }, { id: 'p2', createdAt: 2 }, { id: 'p3', createdAt: 3 }]
    };
    expect(levelItems(ROOT_LEVEL_ID, data).map((item) => item.key).sort()).toEqual(['folder:t', 'project:p1', 'project:p3']);
    expect(levelItems('t', data).map((item) => item.key).sort()).toEqual(['folder:c', 'project:p2']);
  });
});
