import { describe, expect, it } from 'vitest';
import { createDocument, LayerType, type LayeredDocument, type SpecialtyLayer } from '../domain';
import { DEFAULT_CATALOG_DEFINITION } from '../catalog';
import { ProjectWorkspace } from './index';
import { MemoryRepository } from './test-support';

const PROJECT = 'point-history';

function specialty(document: LayeredDocument): SpecialtyLayer {
  const layer = document.layers.find((candidate): candidate is SpecialtyLayer => candidate.type === LayerType.Specialty);
  if (!layer) throw new Error('Missing specialty layer.');
  return layer;
}

async function openWithKnot(repository: MemoryRepository): Promise<ProjectWorkspace> {
  const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => PROJECT, debounceMs: 0 });
  await workspace.createProject({ id: PROJECT, width: 4, height: 4, document: createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 4, height: 4, palette: [{ id: 1, name: 'Ruby', color: '#b44' }] }) });
  const session = workspace.session;
  if (!session) throw new Error('Missing session.');
  session.execute({ type: 'add-point-stitch', point: { x: 6, y: 6 }, color: 1, orientation: 0, layerId: specialty(session.layeredDocument).id });
  return workspace;
}

describe('point stitch session history', () => {
  it('discards stored history from before point stitches and still loads the project', async () => {
    const repository = new MemoryRepository();
    const workspace = await openWithKnot(repository);
    await workspace.flush();
    const stored = repository.records.get(PROJECT);
    if (!stored?.history) throw new Error('Missing stored history.');
    stored.history = { ...stored.history, document: { ...stored.history.document, version: 2 } as unknown as typeof stored.history.document };
    await workspace.dispose();

    const reopened = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => PROJECT, debounceMs: 0 });
    try {
      const restored = await reopened.openProject(PROJECT);
      expect(Array.from(specialty(restored.layeredDocument).pointStitches.x)).toEqual([6]);
      expect(restored.historyUndoDepth).toBe(0);
    } finally {
      await reopened.dispose();
    }
  });

  it('undoes and redoes a Track mark on a knot', async () => {
    const workspace = await openWithKnot(new MemoryRepository());
    const session = workspace.session;
    if (!session) throw new Error('Missing session.');
    try {
      const id = specialty(session.layeredDocument).pointStitches.ids[0];
      session.markProgress({ pointStitchIds: Uint32Array.of(id), operation: 'toggle' });
      expect(specialty(session.layeredDocument).pointStitches.completed[0]).toBe(1);
      session.undoMark();
      expect(specialty(session.layeredDocument).pointStitches.completed[0]).toBe(0);
      session.redoMark();
      expect(specialty(session.layeredDocument).pointStitches.completed[0]).toBe(1);
      session.undo();
      expect(specialty(session.layeredDocument).pointStitches.ids).toHaveLength(0);
    } finally {
      await workspace.dispose();
    }
  });
});
