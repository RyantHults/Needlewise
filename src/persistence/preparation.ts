import { assertValidDocument, type PatternDocument } from '../domain';
import { MAX_DOCUMENT_BYTES } from './limits';
import { sha256 } from './hash';
import { encodeDocument } from './binary';
import { PersistenceError } from './errors';

export const PERSISTENCE_PREPARATION_PROTOCOL = 'needlewise-persistence-preparation-v1' as const;
export const PERSISTENCE_PREPARE_TYPE = 'prepare-document' as const;
export const PERSISTENCE_PREPARED_TYPE = 'prepared-document' as const;
export const PERSISTENCE_PREPARATION_ERROR_TYPE = 'preparation-error' as const;

export interface PersistencePreparationToken {
  projectId: string;
  revision: number;
  requestId: string;
}

export interface PersistencePreparationRequest {
  protocol: typeof PERSISTENCE_PREPARATION_PROTOCOL;
  type: typeof PERSISTENCE_PREPARE_TYPE;
  token: PersistencePreparationToken;
  document: PatternDocument;
}

export interface PersistencePreparedMessage {
  protocol: typeof PERSISTENCE_PREPARATION_PROTOCOL;
  type: typeof PERSISTENCE_PREPARED_TYPE;
  token: PersistencePreparationToken;
  bytes: Uint8Array;
  checksum: string;
}

export interface PersistencePreparationErrorMessage {
  protocol: typeof PERSISTENCE_PREPARATION_PROTOCOL;
  type: typeof PERSISTENCE_PREPARATION_ERROR_TYPE;
  token?: PersistencePreparationToken;
  code: string;
  message: string;
}

export type PersistencePreparationResponse = PersistencePreparedMessage | PersistencePreparationErrorMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validIdentityPart(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

export function validatePreparationToken(value: unknown): value is PersistencePreparationToken {
  return isRecord(value)
    && validIdentityPart(value.projectId)
    && Number.isSafeInteger(value.revision)
    && (value.revision as number) >= 0
    && validIdentityPart(value.requestId);
}

export function preparationTokenKey(token: PersistencePreparationToken): string {
  if (!validatePreparationToken(token)) throw new PersistenceError('invalid-document', 'Persistence preparation identity is malformed.');
  return `${token.projectId}\u0000${String(token.revision)}\u0000${token.requestId}`;
}

export function validatePreparationRequest(value: unknown): asserts value is PersistencePreparationRequest {
  if (!isRecord(value) || value.protocol !== PERSISTENCE_PREPARATION_PROTOCOL || value.type !== PERSISTENCE_PREPARE_TYPE || !validatePreparationToken(value.token) || !isRecord(value.document)) {
    throw new PersistenceError('invalid-document', 'Persistence preparation request is malformed.');
  }
  if (value.document.revision !== value.token.revision) {
    throw new PersistenceError('invalid-document', 'Persistence preparation revision does not match its document.');
  }
}

export function validatePreparedMessage(value: unknown): asserts value is PersistencePreparedMessage {
  if (
    !isRecord(value)
    || value.protocol !== PERSISTENCE_PREPARATION_PROTOCOL
    || value.type !== PERSISTENCE_PREPARED_TYPE
    || !validatePreparationToken(value.token)
    || !(value.bytes instanceof Uint8Array)
    || value.bytes.byteLength === 0
    || value.bytes.byteLength > MAX_DOCUMENT_BYTES
    || typeof value.checksum !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.checksum)
  ) throw new PersistenceError('invalid-document', 'Prepared document output is malformed.');
}

export function validatePreparationError(value: unknown): asserts value is PersistencePreparationErrorMessage {
  if (
    !isRecord(value)
    || value.protocol !== PERSISTENCE_PREPARATION_PROTOCOL
    || value.type !== PERSISTENCE_PREPARATION_ERROR_TYPE
    || (value.token !== undefined && !validatePreparationToken(value.token))
    || typeof value.code !== 'string'
    || value.code.length === 0
    || typeof value.message !== 'string'
    || value.message.length === 0
  ) throw new PersistenceError('invalid-document', 'Persistence preparation error output is malformed.');
}

export function createPreparationRequest(document: PatternDocument, token: PersistencePreparationToken): PersistencePreparationRequest {
  if (!validatePreparationToken(token)) throw new PersistenceError('invalid-document', 'Persistence preparation identity is malformed.');
  return { protocol: PERSISTENCE_PREPARATION_PROTOCOL, type: PERSISTENCE_PREPARE_TYPE, token: { ...token }, document };
}

export function createPreparationError(error: unknown, token?: PersistencePreparationToken): PersistencePreparationErrorMessage {
  const code = error instanceof PersistenceError ? error.code : 'worker-error';
  const message = error instanceof Error && error.message ? error.message : 'The persistence preparation worker failed.';
  return {
    protocol: PERSISTENCE_PREPARATION_PROTOCOL,
    type: PERSISTENCE_PREPARATION_ERROR_TYPE,
    ...(token === undefined ? {} : { token: { ...token } }),
    code,
    message
  };
}

export function createPreparedMessage(token: PersistencePreparationToken, bytes: Uint8Array, checksum: string): PersistencePreparedMessage {
  return { protocol: PERSISTENCE_PREPARATION_PROTOCOL, type: PERSISTENCE_PREPARED_TYPE, token: { ...token }, bytes, checksum };
}

/** Prepare one already persistence-owned document without cloning it. */
export async function prepareDocumentSnapshot(document: PatternDocument, token: PersistencePreparationToken) {
  if (!validatePreparationToken(token)) throw new PersistenceError('invalid-document', 'Persistence preparation identity is malformed.');
  if (document.revision !== token.revision) throw new PersistenceError('invalid-document', 'Persistence preparation revision does not match its document.');
  assertValidDocument(document);
  const bytes = encodeDocument(document);
  const checksum = await sha256(bytes);
  return { projectId: token.projectId, revision: token.revision, requestId: token.requestId, bytes, checksum };
}

/** Transfer only the typed-array buffers owned by a preparation clone. */
export function preparationTransferList(document: PatternDocument): Transferable[] {
  const buffers: Transferable[] = [];
  const seen = new Set<ArrayBuffer>();
  const add = (buffer: ArrayBufferLike): void => {
    if (!(buffer instanceof ArrayBuffer) || seen.has(buffer)) return;
    seen.add(buffer);
    buffers.push(buffer);
  };
  add(document.kind.buffer);
  add(document.colors.buffer);
  add(document.completed.buffer);
  add(document.backstitches.ids.buffer);
  add(document.backstitches.x1.buffer);
  add(document.backstitches.y1.buffer);
  add(document.backstitches.x2.buffer);
  add(document.backstitches.y2.buffer);
  add(document.backstitches.colors.buffer);
  add(document.backstitches.completed.buffer);
  return buffers;
}

export function preparedTransferList(bytes: Uint8Array): Transferable[] {
  return bytes.buffer instanceof ArrayBuffer ? [bytes.buffer] : [];
}
