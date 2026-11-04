import { describe, expect, it } from 'vitest';
import type { ProjectFolder, ProjectMetadata } from '../persistence';
import {
  GALLERY_SORT_OPTIONS,
  insertBlock,
  orderGalleryItems,
  readGallerySort,
  selectRange,
  writeGallerySort,
  type GallerySort
} from './gallery-sort';

function folder(id: string, name: string, createdAt = 0): ProjectFolder {
  return { id, name, parentId: null, createdAt, updatedAt: 0 };
}

function project(id: string, fields: Partial<ProjectMetadata> = {}): ProjectMetadata {
  return { id, title: id, notes: '', createdAt: 0, updatedAt: 0, revision: 1, ...fields };
}

function keys(input: {
  sort: GallerySort;
  folders?: readonly ProjectFolder[];
  projects?: readonly ProjectMetadata[];
  storedOrder?: readonly string[];
  openedAt?: ReadonlyMap<string, number>;
}): string[] {
  return orderGalleryItems({
    sort: input.sort,
    folders: input.folders ?? [],
    projects: input.projects ?? [],
    storedOrder: input.storedOrder,
    openedAt: input.openedAt ?? new Map()
  }).map((item) => item.key);
}

describe('sort preference', () => {
  it('defaults to recently modified for missing, unknown, or unreadable preferences', () => {
    expect(readGallerySort({ getItem: () => null })).toBe('modified');
    expect(readGallerySort({ getItem: () => 'sideways' })).toBe('modified');
    expect(readGallerySort({ getItem: () => { throw new Error('denied'); } })).toBe('modified');
  });

  it('reads back a written preference and survives a storage that refuses writes', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    writeGallerySort(storage, 'custom');
    expect(readGallerySort(storage)).toBe('custom');
    expect(() => writeGallerySort({ setItem: () => { throw new Error('full'); } }, 'opened')).not.toThrow();
  });

  it('lists the four sorts with recently modified first', () => {
    expect(GALLERY_SORT_OPTIONS.map((option) => option.label)).toEqual(['Recently modified', 'Recently opened', 'Recently created', 'Custom']);
  });
});

describe('orderGalleryItems', () => {
  it('sorts recently opened patterns first and never-opened ones after them by modified date', () => {
    const projects = [project('a', { updatedAt: 3 }), project('b', { updatedAt: 2 }), project('c', { updatedAt: 1 })];
    const openedAt = new Map([['c', 9], ['b', 5]]);
    expect(keys({ sort: 'opened', projects, openedAt })).toEqual(['project:c', 'project:b', 'project:a']);
  });

  it('sorts by modified date, then revision', () => {
    const projects = [project('a', { updatedAt: 1 }), project('b', { updatedAt: 2, revision: 1 }), project('c', { updatedAt: 2, revision: 4 })];
    expect(keys({ sort: 'modified', projects })).toEqual(['project:c', 'project:b', 'project:a']);
  });

  it('sorts by created date, newest first', () => {
    const projects = [project('a', { createdAt: 1, updatedAt: 9 }), project('b', { createdAt: 2 })];
    expect(keys({ sort: 'created', projects })).toEqual(['project:b', 'project:a']);
  });

  it('keeps folders first by name in date sorts and mixes them in custom order', () => {
    const folders = [folder('f', 'zebra'), folder('g', 'Apple')];
    const projects = [project('a', { updatedAt: 5 })];
    expect(keys({ sort: 'modified', folders, projects })).toEqual(['folder:g', 'folder:f', 'project:a']);
    expect(keys({ sort: 'custom', folders: [folder('f', 'zebra')], projects, storedOrder: ['project:a', 'folder:f'] })).toEqual(['project:a', 'folder:f']);
  });

  it('puts items missing from the custom order first, newest created first', () => {
    const projects = [project('a', { createdAt: 1 }), project('b', { createdAt: 2 })];
    expect(keys({ sort: 'custom', folders: [folder('f', 'Old', 3)], projects, storedOrder: ['project:a'] })).toEqual(['folder:f', 'project:b', 'project:a']);
  });
});

describe('insertBlock', () => {
  it('inserts a block at a gap, accounting for keys removed before it', () => {
    expect(insertBlock(['a', 'b', 'c', 'd'], ['a', 'c'], 4)).toEqual(['b', 'd', 'a', 'c']);
    expect(insertBlock(['a', 'b', 'c', 'd'], ['d'], 1)).toEqual(['a', 'd', 'b', 'c']);
    expect(insertBlock(['a', 'b', 'c'], ['b'], 2)).toEqual(['a', 'b', 'c']);
  });
});

describe('selectRange', () => {
  it('selects a range in display order in either direction', () => {
    expect(selectRange(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['b', 'c', 'd']);
    expect(selectRange(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['a', 'b', 'c']);
    expect(selectRange(['a', 'b'], 'gone', 'b')).toEqual(['b']);
  });
});
