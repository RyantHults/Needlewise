import type {
  CommandResult,
  DomainCommand,
  PatternDocument
} from '../domain';
import type { ProjectWorkspace } from '../application/workspace';

export interface WorkspaceEditorSnapshot {
  readonly projectId: string | null;
  readonly revision: number | null;
  readonly document: PatternDocument | null;
}

export interface EditorRevisionToken {
  readonly projectId: string;
  readonly revision: number;
}

export class StaleEditorTransactionError extends Error {
  readonly code = 'stale-editor-transaction';
  readonly expected: EditorRevisionToken;
  readonly actual: WorkspaceEditorSnapshot;

  constructor(expected: EditorRevisionToken, actual: WorkspaceEditorSnapshot) {
    super(`The editor transaction for ${expected.projectId}@${String(expected.revision)} is stale.`);
    this.name = 'StaleEditorTransactionError';
    this.expected = expected;
    this.actual = actual;
  }
}

export interface WorkspaceEditorBoundary {
  readonly activeProjectId: string | null;
  readonly document: PatternDocument | null;
  subscribe(listener: () => void): () => void;
  execute(command: DomainCommand): CommandResult;
  executeBatch(commands: readonly DomainCommand[]): CommandResult;
  undo(): CommandResult;
  redo(): CommandResult;
}

export interface EditorTransaction {
  readonly token: EditorRevisionToken;
  commit(command: DomainCommand): CommandResult;
  commitBatch(commands: readonly DomainCommand[]): CommandResult;
}

export interface WorkspaceEditorGateway {
  getSnapshot(): WorkspaceEditorSnapshot;
  getDocumentSnapshot(): WorkspaceEditorSnapshot;
  subscribe(listener: (snapshot: WorkspaceEditorSnapshot) => void): () => void;
  beginTransaction(): EditorTransaction;
  execute(command: DomainCommand, expected?: EditorRevisionToken): CommandResult;
  executeBatch(commands: readonly DomainCommand[], expected?: EditorRevisionToken): CommandResult;
  undo(expected?: EditorRevisionToken): CommandResult;
  redo(expected?: EditorRevisionToken): CommandResult;
  dispose(): void;
}

function snapshotOf(boundary: WorkspaceEditorBoundary): WorkspaceEditorSnapshot {
  const document = boundary.document;
  return {
    projectId: boundary.activeProjectId,
    revision: document?.revision ?? null,
    document
  };
}

function expectedToken(token: EditorRevisionToken | undefined, snapshot: WorkspaceEditorSnapshot): void {
  if (!token) return;
  if (snapshot.projectId !== token.projectId || snapshot.revision !== token.revision) throw new StaleEditorTransactionError(token, snapshot);
}

class WorkspaceEditorGatewayImpl implements WorkspaceEditorGateway {
  private snapshot: WorkspaceEditorSnapshot;
  private readonly listeners = new Set<(snapshot: WorkspaceEditorSnapshot) => void>();
  private readonly unsubscribeBoundary: () => void;
  private disposed = false;

  constructor(private readonly boundary: WorkspaceEditorBoundary) {
    this.snapshot = snapshotOf(boundary);
    this.unsubscribeBoundary = boundary.subscribe(() => this.refresh());
  }

  getSnapshot(): WorkspaceEditorSnapshot {
    return this.snapshot;
  }

  getDocumentSnapshot(): WorkspaceEditorSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: WorkspaceEditorSnapshot) => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  beginTransaction(): EditorTransaction {
    this.refreshFromBoundary();
    const snapshot = this.snapshot;
    if (!snapshot.projectId || snapshot.revision === null) throw new Error('There is no active editor project.');
    const token: EditorRevisionToken = { projectId: snapshot.projectId, revision: snapshot.revision };
    let committed = false;
    return {
      token,
      commit: (command) => {
        if (committed) throw new StaleEditorTransactionError(token, this.snapshot);
        const result = this.execute(command, token);
        committed = true;
        return result;
      },
      commitBatch: (commands) => {
        if (committed) throw new StaleEditorTransactionError(token, this.snapshot);
        const result = this.executeBatch(commands, token);
        committed = true;
        return result;
      }
    };
  }

  execute(command: DomainCommand, expected?: EditorRevisionToken): CommandResult {
    this.ensureLive();
    this.refreshFromBoundary();
    expectedToken(expected, this.snapshot);
    const result = this.boundary.execute(command);
    this.refresh();
    return result;
  }

  executeBatch(commands: readonly DomainCommand[], expected?: EditorRevisionToken): CommandResult {
    this.ensureLive();
    this.refreshFromBoundary();
    expectedToken(expected, this.snapshot);
    const result = this.boundary.executeBatch(commands);
    this.refresh();
    return result;
  }

  undo(expected?: EditorRevisionToken): CommandResult {
    this.ensureLive();
    this.refreshFromBoundary();
    expectedToken(expected, this.snapshot);
    const result = this.boundary.undo();
    this.refresh();
    return result;
  }

  redo(expected?: EditorRevisionToken): CommandResult {
    this.ensureLive();
    this.refreshFromBoundary();
    expectedToken(expected, this.snapshot);
    const result = this.boundary.redo();
    this.refresh();
    return result;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeBoundary();
    this.listeners.clear();
  }

  private ensureLive(): void {
    if (this.disposed) throw new Error('The editor gateway has been disposed.');
  }

  private refresh(): void {
    if (this.disposed) return;
    this.snapshot = snapshotOf(this.boundary);
    for (const listener of [...this.listeners]) listener(this.snapshot);
  }

  private refreshFromBoundary(): void {
    this.snapshot = snapshotOf(this.boundary);
  }
}

export function createWorkspaceEditorGateway(boundary: WorkspaceEditorBoundary | ProjectWorkspace): WorkspaceEditorGateway {
  return new WorkspaceEditorGatewayImpl(boundary);
}

export const createEditorGateway = createWorkspaceEditorGateway;
