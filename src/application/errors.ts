export type WorkspaceErrorCode = 'no-active-project' | 'project-not-found' | 'disposed' | 'save-failed' | 'save-conflict' | 'recovery-promotion-required' | 'stale-operation';

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

/** `error` itself when it is an Error, so codes and subclasses survive; otherwise a save failure carrying it as the cause. */
export function asError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error;
  return new WorkspaceError('save-failed', fallback, error);
}
