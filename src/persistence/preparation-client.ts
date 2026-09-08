import {
  createPreparationRequest,
  prepareDocumentSnapshot,
  preparationTokenKey,
  preparationTransferList,
  validatePreparationError,
  validatePreparationToken,
  validatePreparedMessage,
  type PersistencePreparationToken,
  type PersistencePreparationResponse,
  type PersistencePreparedMessage
} from './preparation';
import { cloneDocument, type PatternDocument } from '../domain';
import { PersistenceError } from './errors';
import type { PreparedDocumentCapability } from './types';

export interface PersistencePreparationWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: unknown) => void): void;
  removeEventListener?(type: 'message' | 'error' | 'messageerror', listener: (event: unknown) => void): void;
  terminate?(): void;
}

export type PersistencePreparationWorkerFactory = () => PersistencePreparationWorkerLike | null;

export interface PersistencePreparationInput {
  projectId: string;
  revision: number;
  document: PatternDocument;
  requestId?: string;
}

export interface PersistencePreparationClientOptions {
  readonly workerFactory?: PersistencePreparationWorkerFactory;
  readonly requestIdFactory?: () => string;
  readonly useWorker?: boolean;
}

export const MAX_PERSISTENCE_PREPARATION_TOKEN_BOOKKEEPING = 4096;

export class PersistencePreparationClientError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PersistencePreparationClientError';
  }
}

export class PersistencePreparationTransportError extends PersistencePreparationClientError {
  constructor(message: string) {
    super('worker-transport', message);
    this.name = 'PersistencePreparationTransportError';
  }
}

export class PersistencePreparationStaleError extends PersistencePreparationClientError {
  constructor(readonly expected: PersistencePreparationToken, readonly actual: PersistencePreparationToken) {
    super('stale-preparation', `The persistence preparation result for ${actual.projectId}@${String(actual.revision)}:${actual.requestId} is stale.`);
    this.name = 'PersistencePreparationStaleError';
  }
}

export interface PersistencePreparationClient {
  prepare(input: PersistencePreparationInput): Promise<PreparedDocumentCapability>;
  getRequestId(capability: PreparedDocumentCapability): string;
  dispose(): void;
}

interface PreparedDocumentPayload {
  readonly owner: object;
  readonly projectId: string;
  readonly revision: number;
  readonly requestId: string;
  readonly bytes: Uint8Array;
  readonly checksum: string;
}

const preparedCapabilities = new WeakMap<object, PreparedDocumentPayload>();

function createPreparedCapability(owner: object, payload: Omit<PreparedDocumentPayload, 'owner'>): PreparedDocumentCapability {
  const capability = Object.freeze({}) as PreparedDocumentCapability;
  preparedCapabilities.set(capability, { owner, ...payload });
  return capability;
}

function payloadForCapability(capability: PreparedDocumentCapability): PreparedDocumentPayload | undefined {
  if ((typeof capability !== 'object' && typeof capability !== 'function') || capability === null) return undefined;
  return preparedCapabilities.get(capability);
}

/**
 * Controlled persistence seam for the repository. The payload is never
 * exposed on the capability itself and is available only during consumption.
 */
export function consumePreparedDocumentCapability<T>(
  capability: PreparedDocumentCapability,
  expected: { readonly projectId: string; readonly revision: number; readonly requestId: string },
  consume: (bytes: Uint8Array, checksum: string) => T
): T {
  const payload = payloadForCapability(capability);
  if (!payload) throw new PersistenceError('invalid-document', 'Prepared document capability is not authenticated.');
  if (payload.projectId !== expected.projectId || payload.revision !== expected.revision || payload.requestId !== expected.requestId) {
    throw new PersistenceError('invalid-document', 'Prepared document capability identity does not match the save attempt.');
  }
  preparedCapabilities.delete(capability);
  return consume(payload.bytes, payload.checksum);
}

interface PendingPreparation {
  readonly token: PersistencePreparationToken;
  readonly resolve: (result: PreparedDocumentCapability) => void;
  readonly reject: (error: unknown) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function eventMessage(event: unknown, fallback: string): string {
  if (event instanceof Error && event.message) return event.message;
  if (isRecord(event) && typeof event.message === 'string' && event.message) return event.message;
  return fallback;
}

function createDefaultWorker(): PersistencePreparationWorkerLike | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('../workers/persistence-preparation.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

let preparationRequestSequence = 0;

function createRequestId(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.randomUUID) return cryptoObject.randomUUID();
  preparationRequestSequence += 1;
  return `preparation-${Date.now().toString(36)}-${String(preparationRequestSequence)}`;
}

function tokenFromResponse(value: unknown): PersistencePreparationToken | undefined {
  if (!isRecord(value) || !validatePreparationToken(value.token)) return undefined;
  return value.token;
}

function responseMessage(value: unknown): PersistencePreparationResponse | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === 'prepared-document') {
    try {
      validatePreparedMessage(value);
      return value;
    } catch {
      return undefined;
    }
  }
  if (value.type === 'preparation-error') {
    try {
      validatePreparationError(value);
      return value;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function workerEventTarget(worker: PersistencePreparationWorkerLike): PersistencePreparationWorkerLike {
  return worker;
}

export class PersistencePreparationWorkerClient implements PersistencePreparationClient {
  private readonly workerFactory: PersistencePreparationWorkerFactory;
  private readonly capabilityOwner = {};
  private readonly requestIdFactory: () => string;
  private readonly useWorker: boolean;
  private worker: PersistencePreparationWorkerLike | null = null;
  private readonly pending = new Map<string, PendingPreparation>();
  private readonly issuedTokens = new Set<string>();
  private tokenSerial = 0;
  private tokenNamespaceExhausted = false;
  private disposed = false;
  private readonly onMessage = (event: unknown): void => this.handleMessage(isRecord(event) && 'data' in event ? event.data : event);
  private readonly onWorkerError = (event: unknown): void => this.handleWorkerFailure(new PersistencePreparationTransportError(eventMessage(event, 'The persistence preparation worker failed.')));
  private readonly onWorkerMessageError = (event: unknown): void => this.handleWorkerFailure(new PersistencePreparationTransportError(eventMessage(event, 'The persistence preparation worker could not read a message.')));

  constructor(options: PersistencePreparationClientOptions = {}) {
    this.workerFactory = options.workerFactory ?? createDefaultWorker;
    this.requestIdFactory = options.requestIdFactory ?? createRequestId;
    this.useWorker = options.useWorker ?? true;
  }

  prepare(input: PersistencePreparationInput): Promise<PreparedDocumentCapability> {
    if (this.disposed) return Promise.reject(new PersistencePreparationClientError('disposed', 'The persistence preparation client has been disposed.'));
    if (input.document.revision !== input.revision) return Promise.reject(new PersistencePreparationClientError('invalid-document', 'Persistence preparation revision does not match its document.'));
    // The client owns the structured-clone equivalent. The caller may keep
    // editing its live document while preparation is queued or running.
    const ownedDocument = cloneDocument(input.document);
    let token: PersistencePreparationToken = {
      projectId: input.projectId,
      revision: input.revision,
      requestId: input.requestId ?? this.requestIdFactory()
    };
    let key = preparationTokenKey(token);
    if (!this.tokenNamespaceExhausted) {
      while (this.issuedTokens.has(key)) {
        token = this.withUniqueSuffix(token);
        key = preparationTokenKey(token);
      }
      this.issuedTokens.add(key);
      if (this.issuedTokens.size >= MAX_PERSISTENCE_PREPARATION_TOKEN_BOOKKEEPING) {
        this.issuedTokens.clear();
        this.tokenNamespaceExhausted = true;
      }
    } else {
      token = this.withUniqueSuffix(token);
      key = preparationTokenKey(token);
    }
    const request = createPreparationRequest(ownedDocument, token);

    let resolvePromise!: (result: PreparedDocumentCapability) => void;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<PreparedDocumentCapability>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    this.pending.set(key, { token, resolve: resolvePromise, reject: rejectPromise });
    const worker = this.useWorker ? this.ensureWorker() : null;
    if (worker) {
      try {
        worker.postMessage(request, preparationTransferList(ownedDocument));
      } catch (error) {
        this.handleWorkerFailure(new PersistencePreparationTransportError(eventMessage(error, 'The persistence preparation worker could not receive the request.')));
      }
    } else {
      void Promise.resolve()
        .then(() => prepareDocumentSnapshot(ownedDocument, token))
        .then((result) => this.resolvePending(key, result), (error: unknown) => this.rejectPending(key, error));
    }
    return promise;
  }

  getRequestId(capability: PreparedDocumentCapability): string {
    const payload = payloadForCapability(capability);
    if (!payload || payload.owner !== this.capabilityOwner) throw new PersistencePreparationClientError('invalid-document', 'Prepared document capability is not authenticated by this client.');
    return payload.requestId;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = new PersistencePreparationClientError('disposed', 'The persistence preparation client has been disposed.');
    for (const [key, pending] of this.pending) {
      this.pending.delete(key);
      pending.reject(error);
    }
    this.removeWorkerListeners(this.worker);
    try {
      this.worker?.terminate?.();
    } catch {
      // Disposal is best effort.
    }
    this.worker = null;
  }

  private ensureWorker(): PersistencePreparationWorkerLike | null {
    if (this.worker) return this.worker;
    let worker: PersistencePreparationWorkerLike | null;
    try {
      worker = this.workerFactory();
    } catch {
      worker = null;
    }
    this.worker = worker;
    if (worker) {
      const target = workerEventTarget(worker);
      target.addEventListener('message', this.onMessage);
      target.addEventListener('error', this.onWorkerError);
      target.addEventListener('messageerror', this.onWorkerMessageError);
    }
    return worker;
  }

  private withUniqueSuffix(token: PersistencePreparationToken): PersistencePreparationToken {
    this.tokenSerial += 1;
    const suffix = `~${this.tokenSerial.toString(36)}`;
    const baseLength = Math.max(1, 256 - suffix.length);
    return { ...token, requestId: `${token.requestId.slice(0, baseLength)}${suffix}` };
  }

  private removeWorkerListeners(worker: PersistencePreparationWorkerLike | null): void {
    if (!worker) return;
    worker.removeEventListener?.('message', this.onMessage);
    worker.removeEventListener?.('error', this.onWorkerError);
    worker.removeEventListener?.('messageerror', this.onWorkerMessageError);
  }

  private handleWorkerFailure(error: PersistencePreparationTransportError): void {
    if (this.disposed) return;
    const failedWorker = this.worker;
    this.worker = null;
    this.removeWorkerListeners(failedWorker);
    try {
      failedWorker?.terminate?.();
    } catch {
      // A failed worker may already be terminated.
    }
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const job of pending) job.reject(error);
  }

  private handleMessage(message: unknown): void {
    if (this.disposed) return;
    const token = tokenFromResponse(message);
    if (!token) {
      if (this.pending.size > 0) this.handleWorkerFailure(new PersistencePreparationTransportError('The persistence preparation worker returned a malformed response.'));
      return;
    }
    const key = preparationTokenKey(token);
    const pending = this.pending.get(key);
    if (!pending) {
      const sameRequest = [...this.pending.values()].filter((candidate) => candidate.token.requestId === token.requestId);
      if (sameRequest.length === 1) {
        this.rejectPending(preparationTokenKey(sameRequest[0].token), new PersistencePreparationStaleError(sameRequest[0].token, token));
      }
      return;
    }
    const parsed = responseMessage(message);
    if (!parsed) {
      this.rejectPending(key, new PersistencePreparationClientError('invalid-response', 'The persistence preparation worker returned a malformed response.'));
      return;
    }
    if (parsed.type === 'preparation-error') {
      this.rejectPending(key, new PersistencePreparationClientError(parsed.code, parsed.message));
      return;
    }
    const result = parsed as PersistencePreparedMessage;
    this.resolvePending(key, {
      projectId: result.token.projectId,
      revision: result.token.revision,
      requestId: result.token.requestId,
      bytes: result.bytes,
      checksum: result.checksum
    });
  }

  private resolvePending(key: string, result: Omit<PreparedDocumentPayload, 'owner'>): void {
    const pending = this.pending.get(key);
    if (!pending) return;
    if (result.projectId !== pending.token.projectId || result.revision !== pending.token.revision || result.requestId !== pending.token.requestId) {
      this.pending.delete(key);
      pending.reject(new PersistencePreparationClientError('invalid-response', 'The persistence preparation result does not match its exact request token.'));
      return;
    }
    this.pending.delete(key);
    pending.resolve(createPreparedCapability(this.capabilityOwner, result));
  }

  private rejectPending(key: string, error: unknown): void {
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    pending.reject(error);
  }
}

export function createPersistencePreparationClient(options: PersistencePreparationClientOptions = {}): PersistencePreparationClient {
  return new PersistencePreparationWorkerClient(options);
}

export const createDocumentPreparationClient = createPersistencePreparationClient;
