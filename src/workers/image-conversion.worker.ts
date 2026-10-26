import {
  CONVERSION_CANCEL_TYPE,
  CONVERSION_PROTOCOL,
  ConversionCancelledError,
  ConversionError,
  cloneCatalogSnapshot,
  conversionTokenKey,
  createConversionCancelled,
  createConversionError,
  validateConversionRequest,
  type ConversionCancelMessage,
  type ConversionRequestMessage,
  type ConversionToken,
  type ConversionWorkerResponse,
  validateConversionToken
} from '../conversion/image-to-pattern';
import { runConversionRequest } from '../conversion/run-request';
import { bootWorker, type WorkerScope } from './runtime';
import { isRecord } from '../domain/guards';

interface ActiveConversion {
  cancelled: boolean;
}

function isToken(value: unknown): value is ConversionToken {
  return validateConversionToken(value);
}

function requestKey(token: ConversionToken): string {
  return conversionTokenKey(token);
}

function isCancelMessage(value: unknown): value is ConversionCancelMessage {
  return isRecord(value) && value.protocol === CONVERSION_PROTOCOL && value.type === CONVERSION_CANCEL_TYPE;
}

/** Handle one conversion message without depending on a concrete WorkerGlobalScope. */
export function handleImageConversionWorkerMessage(
  value: unknown,
  postMessage: (message: ConversionWorkerResponse) => void,
  activeRequests: Map<string, ActiveConversion> = new Map()
): void {
  if (isCancelMessage(value)) {
    if (!isToken(value.token)) {
      postMessage(createConversionError(new ConversionError('invalid-token', 'The conversion cancellation token is malformed.')));
      return;
    }
    const active = activeRequests.get(requestKey(value.token));
    if (active) active.cancelled = true;
    return;
  }

  try {
    validateConversionRequest(value as ConversionRequestMessage);
  } catch (error) {
    postMessage(createConversionError(error, isRecord(value) && isToken(value.token) ? value.token : undefined));
    return;
  }
  const incoming = value as ConversionRequestMessage;
  const request: ConversionRequestMessage = incoming.inputType === 'raster'
    ? { ...incoming, pixels: new Uint8ClampedArray(incoming.pixels), catalog: cloneCatalogSnapshot(incoming.catalog) }
    : { ...incoming, catalog: cloneCatalogSnapshot(incoming.catalog) };
  const key = requestKey(request.token);
  const active: ActiveConversion = { cancelled: false };
  activeRequests.set(key, active);

  // Deferring allows a cancellation task already queued behind this request to
  // run before decode/rasterization starts. The worker remains single-threaded,
  // and every active entry is deleted in the terminal finally block.
  setTimeout(() => {
    void runConversionRequest(request, { isCancelled: () => active.cancelled })
      .then((result) => {
        if (active.cancelled) postMessage(createConversionCancelled(request.token));
        else postMessage(result);
      })
      .catch((error: unknown) => {
        if (active.cancelled || error instanceof ConversionCancelledError) postMessage(createConversionCancelled(request.token));
        else postMessage(createConversionError(error, request.token));
      })
      .finally(() => {
        activeRequests.delete(key);
      });
  }, 0);
}

function installImageConversionWorker(scope: WorkerScope<ConversionWorkerResponse>): void {
  const activeRequests = new Map<string, ActiveConversion>();
  scope.addEventListener('message', (event) => {
    handleImageConversionWorkerMessage(event.data, (message) => scope.postMessage(message), activeRequests);
  });
}

bootWorker(installImageConversionWorker);
