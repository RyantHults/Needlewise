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
import { isRecord } from '../domain';

interface FillWorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: FillWorkerResponse, transfer?: Transferable[]): void;
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

interface ActiveFill {
  cancelled: boolean;
}

/**
 * Handle one worker message without depending on a concrete WorkerGlobalScope.
 * This keeps the entrypoint directly testable and makes cancellation cooperative.
 */
export function handleFillWorkerMessage(
  value: unknown,
  postMessage: (message: FillWorkerResponse, transfer?: Transferable[]) => void,
  activeRequests: Map<string, ActiveFill> = new Map()
): void {
  if (isCancelMessage(value)) {
    const cancel = value;
    try {
      assertValidFillCancel(cancel);
    } catch (error) {
      postMessage(errorMessage(error, cancel));
      return;
    }
    const target = activeRequests.get(fillRequestIdentityKey(cancel));
    if (target) target.cancelled = true;
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
  const active: ActiveFill = { cancelled: false };
  activeRequests.set(requestKey, active);

  void runExactFloodFillAsync(request, { isCancelled: () => active.cancelled })
    .then((traversal) => {
      if (active.cancelled) {
        postMessage(cancelledMessage(request));
        return;
      }
      const result = createFillResult(request, traversal.indices, traversal.masks);
      postMessage(result, [result.indices.buffer, result.masks.buffer]);
    })
    .catch((error: unknown) => {
      if (error instanceof FillCancelledError) {
        postMessage(cancelledMessage(request));
        return;
      }
      postMessage(errorMessage(error, request));
    })
    .finally(() => { activeRequests.delete(requestKey); });
}

function installFillWorker(scope: FillWorkerScope): void {
  const activeRequests = new Map<string, ActiveFill>();
  scope.addEventListener('message', (event) => {
    handleFillWorkerMessage(event.data, (message, transfer) => scope.postMessage(message, transfer), activeRequests);
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
