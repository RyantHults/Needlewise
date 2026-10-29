import { describe, expect, it, vi } from 'vitest';
import { createPatternFragment, LayerType, type DomainCommand, type ProgressCommand } from '../domain';
import { createWorkspaceEditorGateway, hasRevision, StaleEditorTransactionError, tokenOf } from './gateway';
import { LayeredTestBoundary, plainDocument } from './test-support';
import { cell } from '../domain/test-fixtures';

const paint: DomainCommand = cell(2, { type: 'set-full', x: 0, y: 0, color: 1 });

describe('WorkspaceEditorGateway', () => {
  it('takes a revision token only from a snapshot of an open project', () => {
    const gateway = createWorkspaceEditorGateway(new LayeredTestBoundary(plainDocument(2, 2)));
    const open = gateway.getSnapshot();
    expect(hasRevision(open)).toBe(true);
    expect(hasRevision({ ...open, projectId: null })).toBe(false);
    expect(hasRevision({ ...open, revision: null })).toBe(false);
    if (hasRevision(open)) expect(tokenOf(open)).toEqual({ projectId: 'project-a', revision: open.revision });
    gateway.dispose();
  });

  it('exposes project/revision snapshots and forwards durable commands', () => {
    const gateway = createWorkspaceEditorGateway(new LayeredTestBoundary(plainDocument(2, 2)));
    const before = gateway.getDocumentSnapshot().revision!;
    expect(gateway.getDocumentSnapshot()).toMatchObject({ projectId: 'project-a' });
    const result = gateway.execute(paint);
    expect(result.revision).toBe(before + 1);
    expect(gateway.getSnapshot().revision).toBe(before + 1);
    gateway.dispose();
  });

  it('forwards the palette entries of a paste to the boundary', () => {
    const boundary = new LayeredTestBoundary(plainDocument(2, 2));
    const commitPaste = vi.spyOn(boundary, 'commitPaste');
    const gateway = createWorkspaceEditorGateway(boundary);
    const fragment = createPatternFragment(boundary.document, { kind: 'rect', rect: { x: 0, y: 0, width: 1, height: 1 } });
    const palette = [{ id: 2, name: 'Green', color: '#3a3' }];
    gateway.commitPaste(fragment, { x: 0, y: 0 }, [{ layerType: LayerType.Stitch, layerId: null, create: false }], undefined, palette);
    expect(commitPaste.mock.calls[0]?.[4]).toEqual(palette);
    gateway.dispose();
  });

  it('rejects stale transaction commits across revision and project changes', () => {
    const boundary = new LayeredTestBoundary(plainDocument(2, 2));
    const gateway = createWorkspaceEditorGateway(boundary);
    const transaction = gateway.beginTransaction();
    gateway.execute(paint);
    expect(() => transaction.commit(paint)).toThrowError(StaleEditorTransactionError);
    const second = gateway.beginTransaction();
    boundary.open(plainDocument(3, 1), 'project-b');
    expect(() => second.commit(paint)).toThrowError(StaleEditorTransactionError);
    gateway.dispose();
  });

  it('forwards progress marks to the workspace and refreshes listeners', () => {
    const boundary = new LayeredTestBoundary(plainDocument(2, 2));
    boundary.seed(paint);
    const markProgress = vi.spyOn(boundary, 'markProgress');
    const undoMark = vi.spyOn(boundary, 'undoMark');
    const redoMark = vi.spyOn(boundary, 'redoMark');
    const command: ProgressCommand = { cells: { indices: Uint32Array.of(0), masks: Uint8Array.of(1) }, operation: 'toggle' };
    const gateway = createWorkspaceEditorGateway(boundary);
    let seen = gateway.getSnapshot();
    gateway.subscribe((snapshot) => { seen = snapshot; });
    expect(gateway.markProgress(command)).toBe(true);
    expect(markProgress).toHaveBeenCalledWith(command);
    expect(seen.document?.completed[0]).toBe(1);
    expect(gateway.undoMark()).toBe(true);
    expect(seen.document?.completed[0]).toBe(0);
    expect(gateway.redoMark()).toBe(true);
    expect(seen.document?.completed[0]).toBe(1);
    // Nothing is left to redo.
    expect(gateway.redoMark()).toBe(false);
    expect(undoMark).toHaveBeenCalledTimes(1);
    expect(redoMark).toHaveBeenCalledTimes(2);
    gateway.dispose();
  });
});
