export type PersistenceErrorCode =
  | 'invalid-document'
  | 'invalid-archive'
  | 'archive-too-large'
  | 'invalid-manifest'
  | 'checksum-mismatch'
  | 'unsupported-version'
  | 'invalid-metadata'
  | 'invalid-asset'
  | 'invalid-activity'
  | 'storage-failure'
  | 'stale-save'
  | 'import-collision'
  | 'cancelled';

export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;
  readonly cause?: unknown;

  constructor(code: PersistenceErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'PersistenceError';
    this.code = code;
    this.cause = cause;
  }
}

export function persistenceError(
  code: PersistenceErrorCode,
  message: string,
  cause?: unknown
): PersistenceError {
  return new PersistenceError(code, message, cause);
}
