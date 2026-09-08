import { describe, expect, it, vi } from 'vitest';
import { createDocument } from '../domain';
import { setDailyProgress, type PersistencePreparationClient, type ProgressActivity, type ProjectMetadata, type SaveResult } from '../persistence';
import { ProjectSession } from './session';
import type { WorkspaceRepository } from './types';

function metadata(id: string, revision: number): ProjectMetadata {
  return { id, title: 'Progress test', notes: '', createdAt: 1, updatedAt: 1, revision };
}

const testPreparationClient: PersistencePreparationClient = {
  prepare: async () => { throw new Error('Preparation was not expected in this legacy repository seam.'); },
  getRequestId: () => { throw new Error('Preparation was not expected in this legacy repository seam.'); },
  dispose: () => undefined
};

describe('application progress integration', () => {
  it('updates metrics from change sets and records ephemeral plus durable activity', async () => {
    const saves: Array<{ revision: number; activity?: unknown }> = [];
    const save = vi.fn(async (_projectId: string, _metadata: ProjectMetadata, document: ReturnType<typeof createDocument>, _assets: undefined, options: { activity?: unknown }): Promise<SaveResult> => {
      saves.push({ revision: document.revision, activity: options.activity });
      return { committed: true, stale: false, revision: document.revision };
    });
    const repository = { save } as unknown as WorkspaceRepository;
    const document = createDocument({ width: 2, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    const session = new ProjectSession({
      repository,
      metadata: metadata('progress', document.revision),
      document,
      preparationClient: testPreparationClient,
      clock: { now: () => Date.UTC(2026, 7, 30, 12) },
      debounceMs: 0
    });

    session.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    session.execute({ type: 'set-completion', x: 0, y: 0, completed: true });
    expect(session.metrics.totals).toMatchObject({ full: 1, completedComponents: 1, remainingComponents: 0 });
    expect(session.sessionStats).toEqual({ startedAt: Date.UTC(2026, 7, 30, 12), marked: 1, unmarked: 0 });

    const cleared = session.execute({ type: 'bulk-completion', indices: new Uint32Array([0]), operation: 'clear' });
    expect(cleared.changedIndices).toEqual(new Uint32Array([0]));
    expect(session.metrics.progress).toMatchObject({ completedComponents: 0, remainingComponents: 1, fraction: 0 });
    expect(session.sessionStats).toMatchObject({ marked: 1, unmarked: 1 });
    expect(session.activity).toEqual({ daily: [{ date: '2026-08-30', marked: 1, unmarked: 1 }] });

    await session.flush();
    expect(save).toHaveBeenCalledOnce();
    expect(saves[0]).toMatchObject({ revision: 3, activity: { daily: [{ date: '2026-08-30', marked: 1, unmarked: 1 }] } });
    await session.retrySave();
    expect(save).toHaveBeenCalledOnce();
    await session.dispose();
  });

  it('keeps the activity window bounded and idempotent across repeated snapshots', () => {
    let activity: ProgressActivity | undefined;
    for (let day = 0; day < 400; day += 1) {
      const date = new Date(Date.UTC(2025, 0, 1 + day));
      activity = setDailyProgress(activity, date, 1, 0);
    }
    expect(activity?.daily).toHaveLength(366);
    expect(activity?.daily[0].date).toBe('2025-02-04');
    expect(activity?.daily.at(-1)).toMatchObject({ date: '2026-02-04', marked: 1, unmarked: 0 });
    const repeated = setDailyProgress(activity, '2026-02-04', 1, 0);
    expect(repeated).toEqual(activity);
  });

  it('does not record activity for identity-preserving transforms, but does record undo progress', async () => {
    const repository = { save: vi.fn(async (_id: string, _metadata: ProjectMetadata, next: ReturnType<typeof createDocument>): Promise<SaveResult> => ({ committed: true, stale: false, revision: next.revision })) } as unknown as WorkspaceRepository;
    const document = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    const session = new ProjectSession({
      repository,
      metadata: metadata('identity-progress', document.revision),
      document,
      preparationClient: testPreparationClient,
      clock: { now: () => Date.UTC(2026, 7, 30, 12) },
      debounceMs: 0
    });

    session.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    session.execute({ type: 'set-completion', x: 0, y: 0, completed: true });
    expect(session.sessionStats).toMatchObject({ marked: 1, unmarked: 0 });

    session.execute({ type: 'rotate-cw' });
    expect(session.sessionStats).toMatchObject({ marked: 1, unmarked: 0 });
    const undoTransform = session.undo();
    expect(undoTransform.progress).toEqual({ cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0), marked: 0, unmarked: 0 });
    expect(session.sessionStats).toMatchObject({ marked: 1, unmarked: 0 });
    const undoCompletion = session.undo();
    expect(undoCompletion.progress).toEqual({ cellIndices: new Uint32Array([0]), backstitchIds: new Uint32Array(0), marked: 0, unmarked: 1 });
    expect(session.sessionStats).toMatchObject({ marked: 1, unmarked: 1 });
    session.redo();
    expect(session.sessionStats).toMatchObject({ marked: 2, unmarked: 1 });
    await session.dispose();
  });

  it('exposes stable-ID backstitch completion helpers backed by domain validation', async () => {
    const repository = { save: vi.fn(async (_id: string, _metadata: ProjectMetadata, next: ReturnType<typeof createDocument>): Promise<SaveResult> => ({ committed: true, stale: false, revision: next.revision })) } as unknown as WorkspaceRepository;
    const document = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    const session = new ProjectSession({ repository, metadata: metadata('backstitch-progress', document.revision), document, preparationClient: testPreparationClient, clock: { now: () => Date.UTC(2026, 7, 30) }, debounceMs: 0 });
    try {
      const created = session.execute({ type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 4 }, color: 1 });
      const id = created.backstitchId;
      if (id === undefined) throw new Error('backstitch ID was not allocated');
      const completed = session.completeBackstitches(new Uint32Array([id]));
      expect(completed.changed).toBe(true);
      expect(completed.changedBackstitchIds).toEqual(new Uint32Array([id]));
      expect(session.document.backstitches.completed[0]).toBe(1);
      session.toggleBackstitchCompletion(id);
      expect(session.document.backstitches.completed[0]).toBe(0);
    } finally {
      await session.dispose();
    }
  });
});
