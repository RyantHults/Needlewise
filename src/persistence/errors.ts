export type PersistenceErrorCode =
  | 'invalid-document'
  | 'checksum-mismatch'
  | 'unsupported-version'
  | 'invalid-metadata'
  | 'invalid-asset'
  | 'storage-failure'
  | 'stale-save'
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
