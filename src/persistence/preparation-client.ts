import {
  createPreparationRequest,
  prepareDocumentSnapshot,
  preparationTransferList,
  validatePreparationError,
  validatePreparationToken,
  validatePreparedMessage,
  type PersistencePreparationToken,
  type PersistencePreparationResponse,
  type PersistencePreparedMessage
} from './preparation';
import type { LayeredDocument } from '../domain';
import { cloneLayeredDocument } from './binary';
import { PersistenceError } from './errors';
import type { ProjectDocumentSummary } from './project-thumbnail';
import type { PreparedDocumentCapability } from './types';
import { isRecord } from '../domain';
import { WorkerConnection, createDeferred, createRequestId, type WorkerLike } from '../workers/client';

export interface PersistencePreparationInput {
  projectId: string;
  revision: number;
  document: LayeredDocument;
}

export interface PersistencePreparationClientOptions {
  readonly workerFactory?: () => WorkerLike | null;
  readonly useWorker?: boolean;
}

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
  readonly summary: ProjectDocumentSummary;
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
  consume: (bytes: Uint8Array, checksum: string, summary: ProjectDocumentSummary) => T
): T {
  const payload = payloadForCapability(capability);
  if (!payload) throw new PersistenceError('invalid-document', 'Prepared document capability is not authenticated.');
  if (payload.projectId !== expected.projectId || payload.revision !== expected.revision || payload.requestId !== expected.requestId) {
    throw new PersistenceError('invalid-document', 'Prepared document capability identity does not match the save attempt.');
  }
  preparedCapabilities.delete(capability);
  const { backstitches } = payload.summary.thumbnail;
  return consume(payload.bytes, payload.checksum, {
    width: payload.summary.width,
    height: payload.summary.height,
    thumbnail: {
      ...payload.summary.thumbnail,
      palette: [...payload.summary.thumbnail.palette],
      indices: payload.summary.thumbnail.indices.slice(),
      ...(backstitches === undefined ? {} : { backstitches: { points: backstitches.points.slice(), colors: backstitches.colors.slice() } })
    }
  });
}

interface PendingPreparation {
  readonly token: PersistencePreparationToken;
  /** Dimensions of the document that was sent, checked against the worker's summary. */
  readonly width: number;
  readonly height: number;
  readonly resolve: (result: PreparedDocumentCapability) => void;
  readonly reject: (error: unknown) => void;
}

function createDefaultWorker(): WorkerLike {
  return new Worker(new URL('../workers/persistence-preparation.worker.ts', import.meta.url), { type: 'module' });
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

export class PersistencePreparationWorkerClient implements PersistencePreparationClient {
  private readonly capabilityOwner = {};
  private readonly connection: WorkerConnection<WorkerLike>;
  /** Pending jobs are keyed by request id. */
  private readonly pending = new Map<string, PendingPreparation>();
  private disposed = false;

  constructor(options: PersistencePreparationClientOptions = {}) {
    const workerFactory = options.workerFactory ?? createDefaultWorker;
    this.connection = new WorkerConnection({
      label: 'persistence preparation worker',
      create: options.useWorker === false ? () => null : workerFactory,
      onMessage: (data) => { this.handleMessage(data); },
      transportError: (message) => new PersistencePreparationTransportError(message),
      onFailure: (error) => { this.rejectAll(error); }
    });
  }

  prepare(input: PersistencePreparationInput): Promise<PreparedDocumentCapability> {
    if (this.disposed) return Promise.reject(new PersistencePreparationClientError('disposed', 'The persistence preparation client has been disposed.'));
    if (input.document.revision !== input.revision) return Promise.reject(new PersistencePreparationClientError('invalid-document', 'Persistence preparation revision does not match its document.'));
    const token: PersistencePreparationToken = {
      projectId: input.projectId,
      revision: input.revision,
      requestId: createRequestId('preparation')
    };
    // The client owns the structured-clone equivalent. The caller may keep
    // editing its live document while preparation is queued or running.
    // The summary (a full flatten plus thumbnail sampling) is derived where
    // the document is encoded, off the main thread when a worker is available.
    const ownedDocument = cloneLayeredDocument(input.document);
    const request = createPreparationRequest(ownedDocument, token);
    const { promise, resolve, reject } = createDeferred<PreparedDocumentCapability>();
    this.pending.set(token.requestId, { token, width: ownedDocument.width, height: ownedDocument.height, resolve, reject });
    const worker = this.connection.ensure();
    if (worker) {
      this.connection.post(worker, request, preparationTransferList(ownedDocument));
    } else {
      void Promise.resolve()
        .then(() => prepareDocumentSnapshot(ownedDocument, token))
        .then((result) => this.resolvePending(token.requestId, result), (error: unknown) => this.rejectPending(token.requestId, error));
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
    this.rejectAll(new PersistencePreparationClientError('disposed', 'The persistence preparation client has been disposed.'));
    this.connection.dispose();
  }

  private rejectAll(error: unknown): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const job of pending) job.reject(error);
  }

  private handleMessage(message: unknown): void {
    const token = tokenFromResponse(message);
    if (!token) {
      if (this.pending.size > 0) this.connection.fail('The persistence preparation worker returned a malformed response.');
      return;
    }
    if (!this.pending.has(token.requestId)) return;
    const parsed = responseMessage(message);
    if (!parsed) {
      this.rejectPending(token.requestId, new PersistencePreparationClientError('invalid-response', 'The persistence preparation worker returned a malformed response.'));
      return;
    }
    if (parsed.type === 'preparation-error') {
      this.rejectPending(token.requestId, new PersistencePreparationClientError(parsed.code, parsed.message));
      return;
    }
    const result = parsed as PersistencePreparedMessage;
    this.resolvePending(token.requestId, {
      projectId: result.token.projectId,
      revision: result.token.revision,
      requestId: result.token.requestId,
      bytes: result.bytes,
      checksum: result.checksum,
      summary: result.summary
    });
  }

  private resolvePending(requestId: string, result: Omit<PreparedDocumentPayload, 'owner'>): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    if (result.projectId !== pending.token.projectId || result.revision !== pending.token.revision || result.summary.width !== pending.width || result.summary.height !== pending.height) {
      pending.reject(new PersistencePreparationClientError('invalid-response', 'The persistence preparation result does not match its exact request token.'));
      return;
    }
    pending.resolve(createPreparedCapability(this.capabilityOwner, result));
  }

  private rejectPending(requestId: string, error: unknown): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    pending.reject(error);
  }
}

export function createPersistencePreparationClient(options: PersistencePreparationClientOptions = {}): PersistencePreparationClient {
  return new PersistencePreparationWorkerClient(options);
}
