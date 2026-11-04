import { describe, expect, it } from 'vitest';
import type { ProjectFolder, ProjectFolderAssignment, ProjectMetadata } from '../persistence';
import {
  UP_DROP_ID,
  centerOf,
  describeDropTargetName,
  describeSubject,
  gapStops,
  folderDropId,
  isValidDropTarget,
  pickNextPoint,
  projectDropId,
  resolveDropFolderId,
  resolveDropZone,
  resolveGapHit,
  resolveGroupTarget,
  resolveMoveTarget,
  type DragSubject,
  type GapLayout,
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

function projects(...ids: string[]): DragSubject {
  return { kind: 'projects', ids };
}

function context(currentFolderId: string | null = null): MoveContext {
  return { folders, folderAssignments, currentFolderId };
}

describe('resolveDropFolderId', () => {
  it('resolves a folder drop id to its own id', () => {
    expect(resolveDropFolderId(folderDropId('top1'), context())).toBe('top1');
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
    expect(resolveMoveTarget(projects('p3'), folderDropId('top1'), context())).toEqual({
      subject: projects('p3'), targetFolderId: 'top1'
    });
  });

  it('moves a project into a subfolder via a folder card', () => {
    expect(resolveMoveTarget(projects('p3'), folderDropId('child1'), context())).toEqual({
      subject: projects('p3'), targetFolderId: 'child1'
    });
  });

  it('moves a project up out of a subfolder via the up bar', () => {
    expect(resolveMoveTarget(projects('p2'), UP_DROP_ID, context('child1'))).toEqual({
      subject: projects('p2'), targetFolderId: 'top1'
    });
  });

  it('is a no-op when dropped on its current folder', () => {
    expect(resolveMoveTarget(projects('p1'), folderDropId('top1'), context())).toBeNull();
  });

  it('is a no-op when an unassigned project is dropped at the top level via the up bar', () => {
    // Viewing top1 (a top-level folder, so its "up" target is the top level),
    // an unassigned project already sits at the top level.
    expect(resolveMoveTarget(projects('p3'), UP_DROP_ID, context('top1'))).toBeNull();
  });

  it('rejects a nonexistent target folder', () => {
    expect(resolveMoveTarget(projects('p3'), folderDropId('missing'), context())).toBeNull();
  });
});

describe('resolveMoveTarget: folders', () => {
  it('moves a subfolder to a different top-level folder', () => {
    expect(resolveMoveTarget({ kind: 'folder', id: 'child1' }, folderDropId('top2'), context())).toEqual({
      subject: { kind: 'folder', id: 'child1' }, targetFolderId: 'top2'
    });
  });

  it('moves a subfolder up to the top level via the up bar (viewing its top-level parent)', () => {
    expect(resolveMoveTarget({ kind: 'folder', id: 'child1' }, UP_DROP_ID, context('top1'))).toEqual({
      subject: { kind: 'folder', id: 'child1' }, targetFolderId: null
    });
  });

  it('rejects dropping a folder on itself', () => {
    expect(resolveMoveTarget({ kind: 'folder', id: 'top1' }, folderDropId('top1'), context())).toBeNull();
  });

  it('is a no-op when dropped on its current parent', () => {
    expect(resolveMoveTarget({ kind: 'folder', id: 'child1' }, folderDropId('top1'), context())).toBeNull();
  });

  it('is a no-op when an already-top-level folder is dropped at the top level via the up bar', () => {
    expect(resolveMoveTarget({ kind: 'folder', id: 'top2' }, UP_DROP_ID, context('top1'))).toBeNull();
  });

  it('rejects dropping a folder onto a subfolder (non-top-level target)', () => {
    expect(resolveMoveTarget({ kind: 'folder', id: 'top2' }, folderDropId('child1'), context())).toBeNull();
  });

  it('rejects moving a folder that has subfolders into another top-level folder (depth limit)', () => {
    expect(resolveMoveTarget({ kind: 'folder', id: 'top1' }, folderDropId('top2'), context())).toBeNull();
  });

  it('allows a folder with subfolders to move to the top level (already there is still a no-op)', () => {
    expect(resolveMoveTarget({ kind: 'folder', id: 'top1' }, UP_DROP_ID, context('top1'))).toBeNull();
  });

  it('rejects a nonexistent target folder', () => {
    expect(resolveMoveTarget({ kind: 'folder', id: 'top1' }, folderDropId('missing'), context())).toBeNull();
  });

  it('rejects a dragged folder that no longer exists', () => {
    expect(resolveMoveTarget({ kind: 'folder', id: 'ghost' }, folderDropId('top2'), context())).toBeNull();
  });
});

describe('resolveMoveTarget: malformed ids', () => {
  it('rejects an unrecognized drop id', () => {
    expect(resolveMoveTarget(projects('p3'), 'nonsense', context())).toBeNull();
  });
});

describe('isValidDropTarget', () => {
  it('mirrors resolveMoveTarget for a valid move', () => {
    expect(isValidDropTarget(projects('p3'), folderDropId('top1'), context())).toBe(true);
  });

  it('mirrors resolveMoveTarget for an invalid move', () => {
    expect(isValidDropTarget({ kind: 'folder', id: 'top1' }, folderDropId('top1'), context())).toBe(false);
  });
});

describe('announcements', () => {
  const titled = [project('p1', 'Garden sampler'), project('p2', 'Night sky')];
  const annContext = { ...context(), projects: titled };

  it('describes a dragged project by title', () => {
    expect(describeSubject(projects('p1'), annContext)).toBe('Garden sampler');
  });

  it('describes a dragged folder by name', () => {
    expect(describeSubject({ kind: 'folder', id: 'top1' }, annContext)).toBe('Top One');
  });

  it('describes a dragged selection by its size', () => {
    expect(describeSubject({ kind: 'projects', ids: ['p1', 'p2'] }, annContext)).toBe('2 patterns');
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

  it('picks the nearest point in the pressed direction', () => {
    const near = { x: 110, y: 0 };
    const far = { x: 310, y: 0 };
    expect(pickNextPoint('right', { x: 0, y: 0 }, [far, near])).toBe(near);
  });

  it('ignores points in the wrong direction', () => {
    expect(pickNextPoint('right', { x: 0, y: 0 }, [{ x: -90, y: 10 }])).toBeNull();
  });

  it('returns null when there are no points', () => {
    expect(pickNextPoint('down', { x: 0, y: 0 }, [])).toBeNull();
  });

  it('picks the nearest point below for the down direction', () => {
    const near = { x: 0, y: 110 };
    const far = { x: 0, y: 410 };
    expect(pickNextPoint('down', { x: 0, y: 0 }, [near, far])).toBe(near);
  });
});

describe('resolveGroupTarget', () => {
  it('groups a pattern onto another pattern at the top level', () => {
    expect(resolveGroupTarget(projects('p1'), projectDropId('p3'), context())).toEqual({
      projectIds: ['p1'],
      targetProjectId: 'p3',
      parentId: null
    });
  });

  it('groups inside a top-level folder', () => {
    expect(resolveGroupTarget(projects('p1'), projectDropId('p3'), context('top1'))?.parentId).toBe('top1');
  });

  it('rejects a pattern dropped on itself', () => {
    expect(resolveGroupTarget(projects('p1'), projectDropId('p1'), context())).toBeNull();
  });

  it('rejects grouping inside a nested folder', () => {
    expect(resolveGroupTarget(projects('p2'), projectDropId('p3'), context('child1'))).toBeNull();
  });

  it('rejects a folder dragged onto a pattern', () => {
    expect(resolveGroupTarget({ kind: 'folder', id: 'top1' }, projectDropId('p3'), context())).toBeNull();
  });

  it('rejects unknown drop ids', () => {
    expect(resolveGroupTarget(projects('p1'), folderDropId('top1'), context())).toBeNull();
  });

  it('counts as a valid drop target', () => {
    expect(isValidDropTarget(projects('p1'), projectDropId('p3'), context())).toBe(true);
  });
});

describe('group drags', () => {
  const topLevel = context();

  it('refuses to group a selection onto one of its own patterns', () => {
    expect(resolveGroupTarget(projects('a', 'b'), projectDropId('b'), topLevel)).toBeNull();
  });

  it('groups a selection onto another pattern with every selected id', () => {
    expect(resolveGroupTarget(projects('a', 'b'), projectDropId('c'), topLevel)).toEqual({ projectIds: ['a', 'b'], targetProjectId: 'c', parentId: null });
  });

  it('moves a selection into a folder', () => {
    expect(resolveMoveTarget(projects('a', 'b'), folderDropId('top1'), topLevel)?.targetFolderId).toBe('top1');
  });

  it('refuses to move a selection into a folder that already holds one of its patterns', () => {
    expect(resolveMoveTarget(projects('p3', 'p1'), folderDropId('top1'), topLevel)).toBeNull();
  });
});

describe('resolveDropZone', () => {
  const rect = { left: 0, top: 0, width: 100, height: 100 };

  it('splits a card into before, into, and after zones', () => {
    expect(resolveDropZone({ x: 10, y: 50 }, rect, true)).toBe('before');
    expect(resolveDropZone({ x: 50, y: 50 }, rect, true)).toBe('into');
    expect(resolveDropZone({ x: 90, y: 50 }, rect, true)).toBe('after');
    expect(resolveDropZone({ x: 40, y: 50 }, rect, false)).toBe('before');
  });

  it('splits a card into halves when it cannot be dropped into', () => {
    expect(resolveDropZone({ x: 60, y: 50 }, rect, false)).toBe('after');
  });
});

describe('custom-order gap', () => {
  /** Four cells in a row, 100 wide with 20 between. */
  const slots = [0, 1, 2, 3].map((index) => ({ left: index * 120, top: 0, width: 100, height: 100 }));
  function layout(gapIndex: number, count = 1): GapLayout {
    return { slots, restLength: slots.length - count, gapIndex, count };
  }
  const always = () => true;
  const never = () => false;

  it('keeps the gap while the pointer is over an empty slot or a gutter', () => {
    expect(resolveGapHit({ x: 130, y: 50 }, layout(1), always)).toEqual({ kind: 'gap', gapIndex: 1 });
    expect(resolveGapHit({ x: 110, y: 50 }, layout(1), always)).toEqual({ kind: 'gap', gapIndex: 1 });
  });

  it('has no hit outside the grid', () => {
    expect(resolveGapHit({ x: 50, y: 150 }, layout(1), always)).toBeNull();
  });

  it('moves the gap to the edge of a card and drops into its middle', () => {
    // Gap at 1: the remaining items 0, 1, 2 show in slots 0, 2, 3, and slot 1 is empty.
    expect(resolveGapHit({ x: 250, y: 50 }, layout(1), always)).toEqual({ kind: 'gap', gapIndex: 1 });
    expect(resolveGapHit({ x: 330, y: 50 }, layout(1), always)).toEqual({ kind: 'gap', gapIndex: 2 });
    expect(resolveGapHit({ x: 290, y: 50 }, layout(1), always)).toEqual({ kind: 'into', restIndex: 1 });
    expect(resolveGapHit({ x: 50, y: 50 }, layout(1), always)).toEqual({ kind: 'into', restIndex: 0 });
  });

  it('splits a card in halves when it cannot be dropped into', () => {
    expect(resolveGapHit({ x: 40, y: 50 }, layout(1), never)).toEqual({ kind: 'gap', gapIndex: 0 });
    expect(resolveGapHit({ x: 60, y: 50 }, layout(1), never)).toEqual({ kind: 'gap', gapIndex: 1 });
  });

  it('does not flip a moved gap back when the cards shift under the pointer', () => {
    // The edge before item 2 (in slot 3 while the gap is at 1) moves the gap to 2; item 2 stays in slot 3, so the same edge holds it there.
    const pointer = { x: 370, y: 50 };
    expect(resolveGapHit(pointer, layout(1), never)).toEqual({ kind: 'gap', gapIndex: 2 });
    expect(resolveGapHit(pointer, layout(2), never)).toEqual({ kind: 'gap', gapIndex: 2 });
    // The edge before item 0 moves the gap to 0, and the empty slot then sits under the pointer.
    expect(resolveGapHit({ x: 10, y: 50 }, layout(2), never)).toEqual({ kind: 'gap', gapIndex: 0 });
    expect(resolveGapHit({ x: 10, y: 50 }, layout(0), never)).toEqual({ kind: 'gap', gapIndex: 0 });
  });

  it('gives the keyboard one stop per gap and one per card it can drop into', () => {
    const current = layout(1, 2);
    const allowed = (restIndex: number) => restIndex === 1;
    const targets = gapStops(current, allowed).map((point) => resolveGapHit(point, current, allowed));
    expect(targets).toEqual([
      { kind: 'gap', gapIndex: 0 },
      { kind: 'gap', gapIndex: 1 },
      { kind: 'gap', gapIndex: 2 },
      { kind: 'into', restIndex: 1 }
    ]);
  });

  it('offers no stop for a card middle it cannot drop into', () => {
    expect(gapStops(layout(0), never)).toHaveLength(4);
  });
});
