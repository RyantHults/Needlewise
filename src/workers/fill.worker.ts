import {
  FILL_CANCEL_TYPE,
  FILL_CANCELLED_TYPE,
  FILL_ERROR_TYPE,
  FILL_PROTOCOL,
  FillCancelledError,
  FillProtocolError,
  assertValidFillCancel,
  assertValidFillRequest,
  createFillResult,
  fillRequestIdentityKey,
  runExactFloodFillAsync,
  type FillCancelMessage,
  type FillCancelledMessage,
  type FillErrorMessage,
  type FillRequestMessage,
  type FillWorkerResponse
} from '../editor/fill';

export interface FillWorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: FillWorkerResponse, transfer?: Transferable[]): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function cancelledMessage(request: Pick<FillCancelMessage, 'projectId' | 'baseRevision' | 'requestId'>): FillCancelledMessage {
  return {
    protocol: FILL_PROTOCOL,
    type: FILL_CANCELLED_TYPE,
    projectId: request.projectId,
    baseRevision: request.baseRevision,
    requestId: request.requestId
  };
}

function errorMessage(
  error: unknown,
  request?: Partial<Pick<FillRequestMessage, 'projectId' | 'baseRevision' | 'requestId'>>
): FillErrorMessage {
  const code = error instanceof FillProtocolError
    ? error.code
    : error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'fill-worker-error';
  const message = error instanceof Error ? error.message : 'The fill worker failed.';
  return {
    protocol: FILL_PROTOCOL,
    type: FILL_ERROR_TYPE,
    ...(typeof request?.projectId === 'string' ? { projectId: request.projectId } : {}),
    ...(typeof request?.baseRevision === 'number' ? { baseRevision: request.baseRevision } : {}),
    ...(typeof request?.requestId === 'string' ? { requestId: request.requestId } : {}),
    code,
    message
  };
}

function isCancelMessage(value: unknown): value is FillCancelMessage {
  return isRecord(value) && value.protocol === FILL_PROTOCOL && value.type === FILL_CANCEL_TYPE;
}

/** Track active requests separately so pre-cancels can expire if orphaned. */
const activeRequestKeys = new WeakMap<Set<string>, Set<string>>();

function activeKeysFor(cancelledRequests: Set<string>): Set<string> {
  let active = activeRequestKeys.get(cancelledRequests);
  if (active === undefined) {
    active = new Set<string>();
    activeRequestKeys.set(cancelledRequests, active);
  }
  return active;
}

function rememberCancellation(cancelledRequests: Set<string>, request: FillCancelMessage): void {
  const key = fillRequestIdentityKey(request);
  const active = activeKeysFor(cancelledRequests);
  cancelledRequests.add(key);
  if (active.has(key)) return;
  // A direct pre-cancel is useful when both messages are already queued in
  // the same task, but must not live forever and poison a later ID reuse.
  globalThis.queueMicrotask(() => {
    if (!active.has(key)) cancelledRequests.delete(key);
  });
}

function forgetRequest(cancelledRequests: Set<string>, key: string): void {
  cancelledRequests.delete(key);
  activeKeysFor(cancelledRequests).delete(key);
}

/**
 * Handle one worker message without depending on a concrete WorkerGlobalScope.
 * This keeps the entrypoint directly testable and makes cancellation cooperative.
 */
export function handleFillWorkerMessage(
  value: unknown,
  postMessage: (message: FillWorkerResponse, transfer?: Transferable[]) => void,
  cancelledRequests: Set<string> = new Set()
): void {
  if (isCancelMessage(value)) {
    const cancel = value;
    try {
      assertValidFillCancel(cancel);
    } catch (error) {
      postMessage(errorMessage(error, cancel));
      return;
    }
    rememberCancellation(cancelledRequests, cancel);
    return;
  }

  let request: FillRequestMessage;
  try {
    assertValidFillRequest(value);
    request = value;
  } catch (error) {
    postMessage(errorMessage(error, isRecord(value) ? value as Partial<Pick<FillRequestMessage, 'projectId' | 'baseRevision' | 'requestId'>> : undefined));
    return;
  }

  const requestKey = fillRequestIdentityKey(request);
  const active = activeKeysFor(cancelledRequests);
  active.add(requestKey);
  if (cancelledRequests.has(requestKey)) {
    forgetRequest(cancelledRequests, requestKey);
    postMessage(cancelledMessage(request));
    return;
  }

  void runExactFloodFillAsync(request, { isCancelled: () => cancelledRequests.has(requestKey) })
    .then((traversal) => {
      if (cancelledRequests.has(requestKey)) {
        forgetRequest(cancelledRequests, requestKey);
        postMessage(cancelledMessage(request));
        return;
      }
      const result = createFillResult(request, traversal.indices, traversal.masks);
      forgetRequest(cancelledRequests, requestKey);
      postMessage(result, [result.indices.buffer, result.masks.buffer]);
    })
    .catch((error: unknown) => {
      forgetRequest(cancelledRequests, requestKey);
      if (error instanceof FillCancelledError) {
        postMessage(cancelledMessage(request));
        return;
      }
      postMessage(errorMessage(error, request));
    });
}

export function installFillWorker(scope: FillWorkerScope): void {
  const cancelledRequests = new Set<string>();
  scope.addEventListener('message', (event) => {
    handleFillWorkerMessage(event.data, (message, transfer) => scope.postMessage(message, transfer), cancelledRequests);
  });
}

function isWorkerScope(value: unknown): value is FillWorkerScope {
  if (!isRecord(value)) return false;
  return typeof value.postMessage === 'function'
    && typeof value.addEventListener === 'function'
    && !('document' in value);
}

const globalScope: unknown = typeof globalThis === 'undefined' ? undefined : globalThis;
if (isWorkerScope(globalScope)) installFillWorker(globalScope);
