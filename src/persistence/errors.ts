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

/** Runs a storage operation, reporting any failure that is not already a `PersistenceError` as `storage-failure`. */
export async function wrapStorage<T>(message: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    throw new PersistenceError('storage-failure', message, error);
  }
}
