export type WorkspaceErrorCode = 'no-active-project' | 'project-not-found' | 'disposed' | 'save-failed' | 'import-failed' | 'save-conflict' | 'recovery-promotion-required' | 'stale-operation';

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly cause?: unknown;

  constructor(code: WorkspaceErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
    this.cause = cause;
  }
}
