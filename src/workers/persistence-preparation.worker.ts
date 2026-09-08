import {
  createPreparationError,
  createPreparedMessage,
  prepareDocumentSnapshot,
  preparedTransferList,
  preparationTokenKey,
  validatePreparationRequest,
  validatePreparationToken,
  type PersistencePreparationErrorMessage,
  type PersistencePreparationResponse,
  type PersistencePreparationToken
} from '../persistence/preparation';

export interface PersistencePreparationWorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: PersistencePreparationResponse, transfer?: Transferable[]): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function tokenFromMessage(value: unknown): PersistencePreparationToken | undefined {
  return isRecord(value) && validatePreparationToken(value.token) ? value.token : undefined;
}

function postError(postMessage: (message: PersistencePreparationResponse, transfer?: Transferable[]) => void, error: unknown, token?: PersistencePreparationToken): void {
  const response: PersistencePreparationErrorMessage = createPreparationError(error, token);
  postMessage(response);
}

/** Handle one preparation request without depending on a concrete WorkerGlobalScope. */
export function handlePersistencePreparationWorkerMessage(
  value: unknown,
  postMessage: (message: PersistencePreparationResponse, transfer?: Transferable[]) => void,
  activeRequests: Set<string> = new Set()
): void {
  try {
    validatePreparationRequest(value);
  } catch (error) {
    postError(postMessage, error, tokenFromMessage(value));
    return;
  }
  const request = value;
  const key = preparationTokenKey(request.token);
  if (activeRequests.has(key)) {
    postError(postMessage, new Error('The persistence preparation request is already active.'), request.token);
    return;
  }
  activeRequests.add(key);
  void prepareDocumentSnapshot(request.document, request.token)
    .then((prepared) => {
      postMessage(createPreparedMessage(request.token, prepared.bytes, prepared.checksum), preparedTransferList(prepared.bytes));
    })
    .catch((error: unknown) => {
      postError(postMessage, error, request.token);
    })
    .finally(() => {
      activeRequests.delete(key);
    });
}

export function installPersistencePreparationWorker(scope: PersistencePreparationWorkerScope): void {
  const activeRequests = new Set<string>();
  scope.addEventListener('message', (event) => {
    handlePersistencePreparationWorkerMessage(event.data, (message, transfer) => scope.postMessage(message, transfer), activeRequests);
  });
}

export const handlePreparationWorkerMessage = handlePersistencePreparationWorkerMessage;
export const installPreparationWorker = installPersistencePreparationWorker;

function isWorkerScope(value: unknown): value is PersistencePreparationWorkerScope {
  return isRecord(value)
    && typeof value.postMessage === 'function'
    && typeof value.addEventListener === 'function'
    && !('document' in value);
}

const globalScope: unknown = typeof globalThis === 'undefined' ? undefined : globalThis;
if (isWorkerScope(globalScope)) installPersistencePreparationWorker(globalScope);
