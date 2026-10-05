import { describe, expect, it } from 'vitest';
import { canvasCellsCommand, canvasResizeCommand, createDocument, type LayeredDocument } from '../domain';
import {
  PersistenceError,
  cloneSessionHistory,
  decodeDocument,
  encodeDocument,
  type ProjectMetadata,
  type ProjectRecord,
  type SaveOptions,
  type SaveResult,
  type SessionHistoryEnvelope
} from '../persistence';
import { DEFAULT_CATALOG_DEFINITION } from '../catalog';
import { createWorkspaceEditorGateway } from '../editor/gateway';
import { ProjectWorkspace } from './index';
import type { WorkspaceRepository } from './types';

/** Stores documents as binary, so a reload goes through the real encoder and decoder. */
class BinaryMemoryRepository implements WorkspaceRepository {
  readonly records = new Map<string, { metadata: ProjectMetadata; bytes: Uint8Array; history?: SessionHistoryEnvelope }>();

  async save(projectId: string, metadata: ProjectMetadata, document: LayeredDocument, _assets?: unknown, options: SaveOptions = {}): Promise<SaveResult> {
    const head = { projectId, revision: document.revision, checksum: '0'.repeat(64) };
    const history = options.history !== undefined && 'trace' in options.history ? cloneSessionHistory(options.history as SessionHistoryEnvelope) : this.records.get(projectId)?.history;
    this.records.set(projectId, { metadata: { ...metadata }, bytes: encodeDocument(document), ...(history === undefined ? {} : { history }) });
    return { committed: true, stale: false, revision: document.revision, head };
  }

  async load(projectId: string): Promise<ProjectRecord | undefined> {
    const record = this.records.get(projectId);
    if (!record) return undefined;
    const document = decodeDocument(record.bytes);
    return {
      metadata: { ...record.metadata },
      document,
      head: { projectId, revision: document.revision, checksum: '0'.repeat(64) },
      recovery: null,
      assets: [],
      ...(record.history === undefined ? {} : { history: cloneSessionHistory(record.history) })
    };
  }

  async listProjects(): Promise<ProjectMetadata[]> {
    return [...this.records.values()].map((record) => ({ ...record.metadata }));
  }

  async deleteProject(projectId: string): Promise<void> {
    this.records.delete(projectId);
  }

  async exportProject(): Promise<Uint8Array> {
    throw new PersistenceError('storage-failure', 'Not used in canvas tests.');
  }

  async importProject(): Promise<ProjectRecord> {
    throw new PersistenceError('storage-failure', 'Not used in canvas tests.');
  }
}

function blank() {
  return createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 6, height: 4, palette: [{ id: 1, name: 'Ruby', color: '#b44' }] });
}

describe('canvas edits through the project session', () => {
  it('routes canvas commands from the editor gateway with the Canvas layer selected, updating metrics and invalidating the composite', async () => {
    const workspace = new ProjectWorkspace({ repository: new BinaryMemoryRepository(), clock: { now: () => 100 }, projectIdFactory: () => 'canvas-route', debounceMs: 0 });
    try {
      const session = await workspace.createProject({ id: 'canvas-route', width: 6, height: 4, document: blank() });
      session.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
      workspace.setActiveLayer('canvas');
      const gateway = createWorkspaceEditorGateway(workspace);
      expect(gateway.getSnapshot().activeLayer).toMatchObject({ kind: 'canvas' });
      const result = gateway.execute(canvasResizeCommand({ top: 0, right: 0, bottom: 0, left: 2 }));
      expect(result.changed).toBe(true);
      expect(gateway.getSnapshot().document).toMatchObject({ width: 8, height: 4, originX: -2 });
      expect(gateway.getSnapshot().compositeInvalidation).toMatchObject({ full: true, revision: result.revision });
      // The stitch moved with the reframe and metrics still count it.
      expect(session.document.kind[2]).toBe(1);
      expect(session.metrics.totals.full).toBe(1);
      expect(session.historyUndoDepth).toBe(2);
    } finally {
      await workspace.dispose();
    }
  });

  it('saves and reloads the mask and origin, and undoes across the reload', async () => {
    const repository = new BinaryMemoryRepository();
    const workspace = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'canvas-reload', debounceMs: 0 });
    await workspace.createProject({ id: 'canvas-reload', width: 6, height: 4, document: blank() });
    const session = workspace.session;
    if (!session) throw new Error('Missing session.');
    session.execute(canvasResizeCommand({ top: 1, right: 0, bottom: 0, left: 0 }));
    session.execute(canvasCellsCommand('remove', { x: 2, y: 2, width: 1, height: 1 }));
    expect(session.document).toMatchObject({ width: 6, height: 5, originY: -1 });
    expect(session.document.canvasMask?.[2 * 6 + 2]).toBe(0);
    await workspace.flush();
    await workspace.dispose();

    const reopened = new ProjectWorkspace({ repository, clock: { now: () => 100 }, projectIdFactory: () => 'canvas-reload', debounceMs: 0 });
    try {
      const restored = await reopened.openProject('canvas-reload');
      expect(restored.document).toMatchObject({ width: 6, height: 5, originY: -1 });
      expect(Array.from(restored.document.canvasMask ?? [])).toEqual(Array.from(session.document.canvasMask ?? []));
      expect(restored.historyUndoDepth).toBe(2);
      restored.undo();
      expect(restored.document.canvasMask).toBeUndefined();
      expect(restored.document).toMatchObject({ width: 6, height: 5, originY: -1 });
      restored.undo();
      expect(restored.document).toMatchObject({ width: 6, height: 4 });
      expect(restored.document.originY ?? 0).toBe(0);
      restored.redo();
      expect(restored.document.originY).toBe(-1);
    } finally {
      await reopened.dispose();
    }
  });
});
