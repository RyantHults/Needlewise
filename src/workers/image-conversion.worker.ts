import {
  CONVERSION_CANCEL_TYPE,
  CONVERSION_PROTOCOL,
  ConversionCancelledError,
  ConversionError,
  conversionCancelled,
  conversionTokenKey,
  convertConversionRequestAsync,
  createConversionCancelled,
  createConversionError,
  createConversionRequest,
  validateConversionRequest,
  type ConversionCancelMessage,
  type ConversionRequestMessage,
  type ConversionToken,
  type ConversionWorkerResponse,
  validateConversionToken
} from '../conversion/image-to-pattern';
import { rasterForConversion } from '../conversion/raster';

export interface ImageConversionWorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: ConversionWorkerResponse): void;
}

interface ActiveConversion {
  cancelled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

async function convertWorkerRequest(request: ConversionRequestMessage, active: ActiveConversion): Promise<ConversionWorkerResponse> {
  const cancellation = { isCancelled: () => active.cancelled };
  conversionCancelled(cancellation, request.token.requestId);
  if (request.inputType === 'raster') {
    const result = await convertConversionRequestAsync(request, cancellation);
    conversionCancelled(cancellation, request.token.requestId);
    return result;
  }
  const raster = await rasterForConversion(request.image, request.targetWidth, request.targetHeight, { maxBytes: request.maxBytes, maxPixels: request.maxPixels }, cancellation);
  conversionCancelled(cancellation, request.token.requestId);
  const rasterRequest = createConversionRequest(raster, {
    targetWidth: request.targetWidth,
    targetHeight: request.targetHeight,
    paletteBudget: request.paletteBudget,
    backgroundSourceId: request.backgroundSourceId,
    autoCrop: request.autoCrop,
    catalog: request.catalog,
    token: request.token,
    sourceImage: {
      ...(request.sourceAssetId === undefined ? {} : { assetId: request.sourceAssetId }),
      ...(request.sourceMimeType === undefined ? {} : { mimeType: request.sourceMimeType })
    }
  });
  conversionCancelled(cancellation, request.token.requestId);
  const result = await convertConversionRequestAsync(rasterRequest, cancellation);
  conversionCancelled(cancellation, request.token.requestId);
  return result;
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
  const request = value as ConversionRequestMessage;
  const key = requestKey(request.token);
  if (activeRequests.has(key)) {
    postMessage(createConversionError(new ConversionError('invalid-token', 'The conversion token is already active.'), request.token));
    return;
  }
  const active: ActiveConversion = { cancelled: false };
  activeRequests.set(key, active);

  // Deferring allows a cancellation task already queued behind this request to
  // run before decode/rasterization starts. The worker remains single-threaded,
  // and every active entry is deleted in the terminal finally block.
  setTimeout(() => {
    void convertWorkerRequest(request, active)
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

export function installImageConversionWorker(scope: ImageConversionWorkerScope): void {
  const activeRequests = new Map<string, ActiveConversion>();
  scope.addEventListener('message', (event) => {
    handleImageConversionWorkerMessage(event.data, (message) => scope.postMessage(message), activeRequests);
  });
}

export const handleConversionWorkerMessage = handleImageConversionWorkerMessage;
export const installConversionWorker = installImageConversionWorker;

function isWorkerScope(value: unknown): value is ImageConversionWorkerScope {
  if (!isRecord(value)) return false;
  return typeof value.postMessage === 'function'
    && typeof value.addEventListener === 'function'
    && !('document' in value);
}

const globalScope: unknown = typeof globalThis === 'undefined' ? undefined : globalThis;
if (isWorkerScope(globalScope)) installImageConversionWorker(globalScope);
