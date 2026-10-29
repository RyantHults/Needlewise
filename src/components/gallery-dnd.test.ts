import { describe, expect, it } from 'vitest';
import type { ProjectFolder, ProjectFolderAssignment, ProjectMetadata } from '../persistence';
import {
  UP_DROP_ID,
  centerOf,
  describeDraggedName,
  describeDropTargetName,
  folderDragId,
  folderDropId,
  isValidDropTarget,
  parseDragId,
  pickNextDropTarget,
  projectDragId,
  projectDropId,
  resolveDropFolderId,
  resolveGroupTarget,
  resolveMoveTarget,
  type MoveContext
} from './gallery-dnd';

function folder(id: string, name: string, parentId: string | null): ProjectFolder {
  return { id, name, parentId, createdAt: 0, updatedAt: 0 };
}

function project(id: string, title: string): ProjectMetadata {
  return { id, title, notes: '', createdAt: 0, updatedAt: 0, revision: 1 };
}

function assignment(projectId: string, folderId: string): ProjectFolderAssignment {
  return { projectId, folderId, assignedAt: 1 };
}

const top1 = folder('top1', 'Top One', null);
const top2 = folder('top2', 'Top Two', null);
const child1 = folder('child1', 'Child One', 'top1');

const folders = [top1, top2, child1];
const folderAssignments = [assignment('p1', 'top1'), assignment('p2', 'child1')];

function context(currentFolderId: string | null = null): MoveContext {
  return { folders, folderAssignments, currentFolderId };
}

describe('parseDragId', () => {
  it('parses a project drag id', () => {
    expect(parseDragId(projectDragId('p1'))).toEqual({ kind: 'project', id: 'p1' });
  });

  it('parses a folder drag id', () => {
    expect(parseDragId(folderDragId('top1'))).toEqual({ kind: 'folder', id: 'top1' });
  });

  it('returns null for an unrecognized id', () => {
    expect(parseDragId('bogus:1')).toBeNull();
  });
});

describe('resolveDropFolderId', () => {
  it('resolves a folder drop id to its own id', () => {
    expect(resolveDropFolderId(folderDropId('top1'), context())).toBe('top1');
  });

  it('does not read a folder drag id as a drop id', () => {
    expect(folderDropId('top1')).not.toBe(folderDragId('top1'));
    expect(resolveDropFolderId(folderDragId('top1'), context())).toBeUndefined();
  });

  it('resolves "up" to the current folder\'s parent', () => {
    expect(resolveDropFolderId(UP_DROP_ID, context('child1'))).toBe('top1');
  });

  it('resolves "up" to the top level when the current folder is a top-level folder', () => {
    expect(resolveDropFolderId(UP_DROP_ID, context('top1'))).toBeNull();
  });

  it('is invalid for "up" at the top level', () => {
    expect(resolveDropFolderId(UP_DROP_ID, context(null))).toBeUndefined();
  });

  it('is invalid for "up" when the current folder no longer exists', () => {
    expect(resolveDropFolderId(UP_DROP_ID, context('missing'))).toBeUndefined();
  });

  it('is invalid for an unrecognized drop id', () => {
    expect(resolveDropFolderId('nonsense', context())).toBeUndefined();
  });
});

describe('resolveMoveTarget: projects', () => {
  it('moves an unassigned project into a folder', () => {
    expect(resolveMoveTarget(projectDragId('p3'), folderDropId('top1'), context())).toEqual({
      kind: 'project', id: 'p3', targetFolderId: 'top1'
    });
  });

  it('moves a project into a subfolder via a folder card', () => {
    expect(resolveMoveTarget(projectDragId('p3'), folderDropId('child1'), context())).toEqual({
      kind: 'project', id: 'p3', targetFolderId: 'child1'
    });
  });

  it('moves a project up out of a subfolder via the up bar', () => {
    expect(resolveMoveTarget(projectDragId('p2'), UP_DROP_ID, context('child1'))).toEqual({
      kind: 'project', id: 'p2', targetFolderId: 'top1'
    });
  });

  it('is a no-op when dropped on its current folder', () => {
    expect(resolveMoveTarget(projectDragId('p1'), folderDropId('top1'), context())).toBeNull();
  });

  it('is a no-op when an unassigned project is dropped at the top level via the up bar', () => {
    // Viewing top1 (a top-level folder, so its "up" target is the top level),
    // an unassigned project already sits at the top level.
    expect(resolveMoveTarget(projectDragId('p3'), UP_DROP_ID, context('top1'))).toBeNull();
  });

  it('rejects a nonexistent target folder', () => {
    expect(resolveMoveTarget(projectDragId('p3'), folderDropId('missing'), context())).toBeNull();
  });
});

describe('resolveMoveTarget: folders', () => {
  it('moves a subfolder to a different top-level folder', () => {
    expect(resolveMoveTarget(folderDragId('child1'), folderDropId('top2'), context())).toEqual({
      kind: 'folder', id: 'child1', targetFolderId: 'top2'
    });
  });

  it('moves a subfolder up to the top level via the up bar (viewing its top-level parent)', () => {
    expect(resolveMoveTarget(folderDragId('child1'), UP_DROP_ID, context('top1'))).toEqual({
      kind: 'folder', id: 'child1', targetFolderId: null
    });
  });

  it('rejects dropping a folder on itself', () => {
    expect(resolveMoveTarget(folderDragId('top1'), folderDropId('top1'), context())).toBeNull();
  });

  it('is a no-op when dropped on its current parent', () => {
    expect(resolveMoveTarget(folderDragId('child1'), folderDropId('top1'), context())).toBeNull();
  });

  it('is a no-op when an already-top-level folder is dropped at the top level via the up bar', () => {
    expect(resolveMoveTarget(folderDragId('top2'), UP_DROP_ID, context('top1'))).toBeNull();
  });

  it('rejects dropping a folder onto a subfolder (non-top-level target)', () => {
    expect(resolveMoveTarget(folderDragId('top2'), folderDropId('child1'), context())).toBeNull();
  });

  it('rejects moving a folder that has subfolders into another top-level folder (depth limit)', () => {
    expect(resolveMoveTarget(folderDragId('top1'), folderDropId('top2'), context())).toBeNull();
  });

  it('allows a folder with subfolders to move to the top level (already there is still a no-op)', () => {
    expect(resolveMoveTarget(folderDragId('top1'), UP_DROP_ID, context('top1'))).toBeNull();
  });

  it('rejects a nonexistent target folder', () => {
    expect(resolveMoveTarget(folderDragId('top1'), folderDropId('missing'), context())).toBeNull();
  });

  it('rejects a dragged folder that no longer exists', () => {
    expect(resolveMoveTarget(folderDragId('ghost'), folderDropId('top2'), context())).toBeNull();
  });
});

describe('resolveMoveTarget: malformed ids', () => {
  it('rejects an unrecognized dragged id', () => {
    expect(resolveMoveTarget('bogus:1', folderDropId('top1'), context())).toBeNull();
  });

  it('rejects an unrecognized drop id', () => {
    expect(resolveMoveTarget(projectDragId('p3'), 'nonsense', context())).toBeNull();
  });
});

describe('isValidDropTarget', () => {
  it('mirrors resolveMoveTarget for a valid move', () => {
    expect(isValidDropTarget(projectDragId('p3'), folderDropId('top1'), context())).toBe(true);
  });

  it('mirrors resolveMoveTarget for an invalid move', () => {
    expect(isValidDropTarget(folderDragId('top1'), folderDropId('top1'), context())).toBe(false);
  });
});

describe('announcements', () => {
  const projects = [project('p1', 'Garden sampler'), project('p2', 'Night sky')];
  const annContext = { ...context(), projects };

  it('describes a dragged project by title', () => {
    expect(describeDraggedName(projectDragId('p1'), annContext)).toBe('Garden sampler');
  });

  it('describes a dragged folder by name', () => {
    expect(describeDraggedName(folderDragId('top1'), annContext)).toBe('Top One');
  });

  it('falls back to a generic label for an unrecognized dragged id', () => {
    expect(describeDraggedName('bogus:1', annContext)).toBe('item');
  });

  it('describes the up target as Projects when viewing a top-level folder', () => {
    expect(describeDropTargetName(UP_DROP_ID, context('top1'))).toBe('Projects');
  });

  it('describes a folder drop target by name', () => {
    expect(describeDropTargetName(folderDropId('child1'), context())).toBe('Child One');
  });

  it('describes the up target by the parent folder\'s name', () => {
    expect(describeDropTargetName(UP_DROP_ID, context('child1'))).toBe('Top One');
  });

  it('returns an empty description for an invalid drop id', () => {
    expect(describeDropTargetName('nonsense', context())).toBe('');
  });
});

describe('keyboard coordinate helpers', () => {
  it('computes the center of a rect', () => {
    expect(centerOf({ left: 10, top: 20, width: 100, height: 50 })).toEqual({ x: 60, y: 45 });
  });

  it('picks the nearest candidate in the pressed direction', () => {
    const near = { id: 'near', rect: { left: 100, top: -10, width: 20, height: 20 } };
    const far = { id: 'far', rect: { left: 300, top: -10, width: 20, height: 20 } };
    expect(pickNextDropTarget('right', { x: 0, y: 0 }, [far, near])).toBe(near);
  });

  it('ignores candidates in the wrong direction', () => {
    const behind = { id: 'behind', rect: { left: -100, top: 0, width: 20, height: 20 } };
    expect(pickNextDropTarget('right', { x: 0, y: 0 }, [behind])).toBeNull();
  });

  it('returns null when there are no candidates', () => {
    expect(pickNextDropTarget('down', { x: 0, y: 0 }, [])).toBeNull();
  });

  it('picks the nearest candidate below for the down direction', () => {
    const near = { id: 'near', rect: { left: -10, top: 100, width: 20, height: 20 } };
    const far = { id: 'far', rect: { left: -10, top: 400, width: 20, height: 20 } };
    expect(pickNextDropTarget('down', { x: 0, y: 0 }, [near, far])).toBe(near);
  });
});

describe('resolveGroupTarget', () => {
  it('groups a pattern onto another pattern at the top level', () => {
    expect(resolveGroupTarget(projectDragId('p1'), projectDropId('p3'), context())).toEqual({
      draggedProjectId: 'p1',
      targetProjectId: 'p3',
      parentId: null
    });
  });

  it('groups inside a top-level folder', () => {
    expect(resolveGroupTarget(projectDragId('p1'), projectDropId('p3'), context('top1'))?.parentId).toBe('top1');
  });

  it('rejects a pattern dropped on itself', () => {
    expect(resolveGroupTarget(projectDragId('p1'), projectDropId('p1'), context())).toBeNull();
  });

  it('rejects grouping inside a nested folder', () => {
    expect(resolveGroupTarget(projectDragId('p2'), projectDropId('p3'), context('child1'))).toBeNull();
  });

  it('rejects a folder dragged onto a pattern', () => {
    expect(resolveGroupTarget(folderDragId('top1'), projectDropId('p3'), context())).toBeNull();
  });

  it('rejects unknown drop ids', () => {
    expect(resolveGroupTarget(projectDragId('p1'), folderDropId('top1'), context())).toBeNull();
  });

  it('counts as a valid drop target', () => {
    expect(isValidDropTarget(projectDragId('p1'), projectDropId('p3'), context())).toBe(true);
  });
});
