import { describe, expect, it } from 'vitest';
import { cloneDocument, createDocument, type CommandResult, type DomainCommand, type PatternDocument } from '../domain';
import { createWorkspaceEditorGateway, StaleEditorTransactionError, type WorkspaceEditorBoundary } from './gateway';

function boundaryFixture() {
  let projectId: string | null = 'project-a';
  let document: PatternDocument | null = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Thread', color: '#123' }] });
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
      document = createDocument({ width: 3, height: 1, palette: [{ id: 1, name: 'Thread', color: '#123' }] });
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
});
