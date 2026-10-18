import { describe, expect, it } from 'vitest';
import { cloneDocument, createDocument, createPatternFragment, type CommandResult, type DomainCommand, type PatternDocument, type ProgressCommand } from '../domain';
import { createWorkspaceEditorGateway, StaleEditorTransactionError, type WorkspaceEditorBoundary } from './gateway';
import { DEFAULT_CATALOG_DEFINITION } from '../catalog';

function boundaryFixture() {
  let projectId: string | null = 'project-a';
  let document: PatternDocument | null = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 2, height: 2, palette: [{ id: 1, name: 'Thread', color: '#123' }] });
  const listeners = new Set<() => void>();
  const boundary: WorkspaceEditorBoundary = {
    get activeProjectId() { return projectId; },
    get document() { return document; },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    execute(command: DomainCommand): CommandResult {
      void command;
      const next = cloneDocument(document!);
      next.revision += 1;
      document = next;
      listeners.forEach((listener) => listener());
      return { document: next, changed: true, revision: next.revision };
    },
    executeBatch(commands) { return this.execute({ type: 'batch', commands }); },
    undo() { return this.execute({ type: 'undo' }); },
    redo() { return this.execute({ type: 'redo' }); }
  };
  return {
    boundary,
    switchProject(id: string): void {
      projectId = id;
      document = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 3, height: 1, palette: [{ id: 1, name: 'Thread', color: '#123' }] });
      listeners.forEach((listener) => listener());
    }
  };
}

describe('WorkspaceEditorGateway', () => {
  it('exposes project/revision snapshots and forwards durable commands', () => {
    const fixture = boundaryFixture();
    const gateway = createWorkspaceEditorGateway(fixture.boundary);
    expect(gateway.getDocumentSnapshot()).toMatchObject({ projectId: 'project-a', revision: 0 });
    const result = gateway.execute({ type: 'noop' });
    expect(result.revision).toBe(1);
    expect(gateway.getSnapshot().revision).toBe(1);
    gateway.dispose();
  });

  it('forwards the palette entries of a paste to the boundary', () => {
    const fixture = boundaryFixture();
    const calls: unknown[][] = [];
    const boundary: WorkspaceEditorBoundary = {
      get activeProjectId() { return fixture.boundary.activeProjectId; },
      get document() { return fixture.boundary.document; },
      subscribe: (listener) => fixture.boundary.subscribe(listener),
      execute: (command) => fixture.boundary.execute(command),
      executeBatch: (commands) => fixture.boundary.executeBatch(commands),
      undo: () => fixture.boundary.undo(),
      redo: () => fixture.boundary.redo(),
      commitPaste(...args) {
        calls.push(args);
        return { result: fixture.boundary.execute({ type: 'noop' }), layerId: null };
      }
    };
    const gateway = createWorkspaceEditorGateway(boundary);
    const fragment = createPatternFragment(boundary.document!, { kind: 'rect', rect: { x: 0, y: 0, width: 1, height: 1 } });
    const palette = [{ id: 2, name: 'Green', color: '#3a3' }];
    gateway.commitPaste!(fragment, { x: 0, y: 0 }, { layerId: null, create: false }, undefined, palette);
    expect(calls[0]?.[4]).toEqual(palette);
    gateway.dispose();
  });

  it('rejects stale transaction commits across revision and project changes', () => {
    const fixture = boundaryFixture();
    const gateway = createWorkspaceEditorGateway(fixture.boundary);
    const transaction = gateway.beginTransaction();
    gateway.execute({ type: 'other' });
    expect(() => transaction.commit({ type: 'paint' })).toThrowError(StaleEditorTransactionError);
    const second = gateway.beginTransaction();
    fixture.switchProject('project-b');
    expect(() => second.commit({ type: 'paint' })).toThrowError(StaleEditorTransactionError);
    gateway.dispose();
  });

  it('forwards progress marks to the workspace and refreshes listeners', () => {
    const fixture = boundaryFixture();
    const calls: string[] = [];
    const progress = (name: string, changed: boolean) => (): CommandResult => {
      calls.push(name);
      return { document: fixture.boundary.document!, changed, revision: fixture.boundary.document!.revision };
    };
    const command: ProgressCommand = { backstitchIds: Uint32Array.of(1), operation: 'toggle' };
    const boundary: WorkspaceEditorBoundary = {
      ...fixture.boundary,
      get activeProjectId() { return fixture.boundary.activeProjectId; },
      get document() { return fixture.boundary.document; },
      markProgress: (received) => {
        expect(received).toBe(command);
        return progress('mark', true)();
      },
      undoProgress: progress('undo', true),
      redoProgress: progress('redo', false)
    };
    const gateway = createWorkspaceEditorGateway(boundary);
    let notified = 0;
    gateway.subscribe(() => { notified += 1; });
    expect(gateway.markProgress(command)).toBe(true);
    expect(gateway.undoProgress()).toBe(true);
    expect(gateway.redoProgress()).toBe(false);
    expect(calls).toEqual(['mark', 'undo', 'redo']);
    expect(notified).toBe(3);
    gateway.dispose();
  });

  it('reports no progress change when the boundary cannot record marks', () => {
    const gateway = createWorkspaceEditorGateway(boundaryFixture().boundary);
    expect(gateway.markProgress({ operation: 'toggle' })).toBe(false);
    expect(gateway.undoProgress()).toBe(false);
    expect(gateway.redoProgress()).toBe(false);
    gateway.dispose();
  });
});
