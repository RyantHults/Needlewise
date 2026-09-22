import {
  CONVERSION_CANCELLED_TYPE,
  CONVERSION_ERROR_TYPE,
  CONVERSION_RESULT_TYPE,
  ConversionError,
  ConversionCancelledError,
  ConversionCancellation,
  MAX_CONVERSION_TOKEN_BOOKKEEPING,
  conversionCancelled,
  conversionTokenKey,
  cloneCatalogSnapshot,
  createConversionCancel,
  createConversionImageRequest,
  createConversionRequest,
  convertConversionRequestAsync,
  validateConversionDraft,
  validateConversionToken,
  conversionTokensEqual,
  type ConversionDraft,
  type ConversionOptions,
  type ConversionRequestMessage,
  type ConversionRasterRequestMessage,
  type ConversionResultMessage,
  type ConversionToken,
  type ConversionRaster
} from './image-to-pattern';
import { rasterForConversion, type ConversionRasterOptions } from './raster';

export { ConversionCancelledError } from './image-to-pattern';

export class ConversionStaleResultError extends Error {
  readonly code = 'stale-conversion-result';

  constructor(readonly expected: ConversionToken, readonly actual: ConversionToken) {
    super(`The conversion result for ${actual.projectId}@${String(actual.baseRevision)}:${actual.requestId} is stale.`);
    this.name = 'ConversionStaleResultError';
  }
}

export class ConversionWorkerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ConversionWorkerError';
  }
}

export class ConversionWorkerTransportError extends ConversionWorkerError {
  constructor(message: string) {
    super('worker-transport', message);
    this.name = 'ConversionWorkerTransportError';
  }
}

export interface ConversionWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener?(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  terminate?(): void;
}

export type ConversionWorkerFactory = () => ConversionWorkerLike | null;

export interface ConversionRequestInput extends Omit<ConversionOptions, 'token' | 'targetWidth' | 'targetHeight'> {
  readonly raster: ConversionRaster;
  readonly targetWidth: number;
  readonly targetHeight: number;
  readonly projectId: string;
  readonly baseRevision: number;
  readonly requestId?: string;
}

export type ConversionImageInput = Omit<ConversionRequestInput, 'raster'>;

export interface ConversionJob {
  readonly request: ConversionRequestMessage;
  readonly promise: Promise<ConversionResultMessage>;
  cancel(): void;
}

export interface ConversionWorkerClientOptions {
  readonly workerFactory?: ConversionWorkerFactory;
  readonly requestIdFactory?: () => string;
  readonly useWorker?: boolean;
  /** Decode/rasterize options used by convertImageToPattern. */
  readonly rasterOptions?: ConversionRasterOptions;
}

interface PendingConversion {
  readonly request: ConversionRequestMessage;
  readonly resolve: (result: ConversionResultMessage) => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  signalCleanup: () => void;
  fallbackCancel?: () => boolean;
}

interface MainThreadTask<T> {
  run?: () => Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
  cancelled: boolean;
}

interface MainThreadQueueJob<T> {
  readonly promise: Promise<T>;
  cancel(): boolean;
}

export const MAX_QUEUED_MAIN_THREAD_CONVERSIONS = 32;

class MainThreadConversionQueue {
  private readonly queue: Array<MainThreadTask<unknown>> = [];
  private running = false;

  enqueue<T>(run: () => Promise<T>): MainThreadQueueJob<T> {
    if (this.queue.length >= MAX_QUEUED_MAIN_THREAD_CONVERSIONS) return {
      promise: Promise.reject(new ConversionWorkerError('main-thread-busy', 'Too many image conversions are queued on the main thread.')),
      cancel: () => false
    };
    let task!: MainThreadTask<T>;
    const promise = new Promise<T>((resolve, reject) => {
      task = { run, resolve, reject, cancelled: false };
      this.queue.push(task as MainThreadTask<unknown>);
      this.pump();
    });
    return {
      promise,
      cancel: () => {
        if (task.cancelled) return false;
        task.cancelled = true;
        task.run = undefined;
        const index = this.queue.indexOf(task as MainThreadTask<unknown>);
        if (index >= 0) {
          this.queue.splice(index, 1);
          task.reject(new ConversionCancelledError('queued'));
        }
        return true;
      }
    };
  }

  private pump(): void {
    if (this.running) return;
    const task = this.queue.shift();
    if (!task) return;
    this.running = true;
    // Always yield once before starting fallback work. This gives an abort or
    // superseding request a chance to remove a queued job before conversion
    // allocates a target surface or enters the CPU-bound mapper.
    globalThis.queueMicrotask(() => {
      if (task.cancelled || task.run === undefined) {
        task.reject(new ConversionCancelledError('queued'));
        this.running = false;
        this.pump();
        return;
      }
      const run = task.run;
      task.run = undefined;
      void Promise.resolve()
        .then(run)
        .then(task.resolve, task.reject)
        .finally(() => {
          this.running = false;
          this.pump();
        });
    });
  }
}

const mainThreadConversionQueue = new MainThreadConversionQueue();

interface ConversionWorkerEventTarget {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isImageSource(value: ConversionRaster | Blob | File): value is Blob | File {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

function workerEventTarget(worker: ConversionWorkerLike): ConversionWorkerEventTarget {
  return worker as unknown as ConversionWorkerEventTarget;
}

function eventMessage(event: unknown, fallback: string): string {
  if (event instanceof Error && event.message) return event.message;
  if (isRecord(event) && typeof event.message === 'string' && event.message) return event.message;
  return fallback;
}

function createDefaultWorker(): ConversionWorkerLike | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('../workers/image-conversion.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

function createRequestId(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.randomUUID) return cryptoObject.randomUUID();
  conversionRequestSequence += 1;
  return `conversion-${Date.now().toString(36)}-${String(conversionRequestSequence)}`;
}

let conversionRequestSequence = 0;

function requestFromInput(input: ConversionRequestInput, requestIdFactory: () => string): ConversionRasterRequestMessage {
  return createConversionRequest(input.raster, {
    targetWidth: input.targetWidth,
    targetHeight: input.targetHeight,
    paletteBudget: input.paletteBudget,
    backgroundSourceId: input.backgroundSourceId,
    autoCrop: input.autoCrop,
    catalog: input.catalog,
    sourceImage: input.sourceImage,
    token: {
      projectId: input.projectId,
      baseRevision: input.baseRevision,
      requestId: input.requestId ?? requestIdFactory()
    }
  });
}

function copyRequest(request: ConversionRequestMessage): ConversionRequestMessage {
  const token = { ...request.token };
  return request.inputType === 'raster'
    ? { ...request, token, pixels: new Uint8ClampedArray(request.pixels), catalog: cloneCatalogSnapshot(request.catalog) }
    : { ...request, token, catalog: cloneCatalogSnapshot(request.catalog) };
}

function requestKey(token: ConversionToken): string {
  return conversionTokenKey(token);
}

function responseToken(value: unknown): ConversionToken | undefined {
  if (!isRecord(value) || !isRecord(value.token)) return undefined;
  const token = value.token;
  if (!validateConversionToken(token)) return undefined;
  return token;
}

function assertCurrentResult(message: unknown, request: ConversionRequestMessage): asserts message is ConversionResultMessage {
  if (!isRecord(message) || message.protocol !== request.protocol || message.type !== CONVERSION_RESULT_TYPE) {
    throw new ConversionError('invalid-draft', 'The conversion worker returned an unknown result.');
  }
  const actual = responseToken(message);
  if (!actual) throw new ConversionError('invalid-token', 'The conversion worker result token is malformed.');
  if (!conversionTokensEqual(actual, request.token)) throw new ConversionStaleResultError(request.token, actual);
  const draft = message.draft as ConversionDraft;
  validateConversionDraft(draft);
  if (!conversionTokensEqual(draft.token, request.token)) throw new ConversionStaleResultError(request.token, draft.token);
}

export class ConversionWorkerClient {
  private readonly workerFactory: ConversionWorkerFactory;
  private readonly requestIdFactory: () => string;
  private readonly useWorker: boolean;
  private readonly rasterOptions: ConversionRasterOptions;
  private worker: ConversionWorkerLike | null = null;
  private readonly pending = new Map<string, PendingConversion>();
  private readonly issuedTokens = new Set<string>();
  private tokenNamespaceExhausted = false;
  private tokenSerial = 0n;
  private disposed = false;
  private readonly onMessage = (event: MessageEvent<unknown>): void => this.handleMessage(event.data);
  private readonly onWorkerError = (event: unknown): void => this.handleWorkerFailure(new ConversionWorkerTransportError(eventMessage(event, 'The conversion worker failed.')));
  private readonly onWorkerMessageError = (event: unknown): void => this.handleWorkerFailure(new ConversionWorkerTransportError(eventMessage(event, 'The conversion worker could not read a message.')));

  constructor(options: ConversionWorkerClientOptions = {}) {
    this.workerFactory = options.workerFactory ?? createDefaultWorker;
    this.requestIdFactory = options.requestIdFactory ?? createRequestId;
    this.useWorker = options.useWorker ?? true;
    this.rasterOptions = options.rasterOptions ?? {};
  }

  get tokenBookkeepingSize(): number {
    return this.issuedTokens.size;
  }

  private reserveToken(request: ConversionRequestMessage): ConversionRequestMessage {
    const originalKey = requestKey(request.token);
    if (!this.tokenNamespaceExhausted) {
      if (this.issuedTokens.has(originalKey)) throw new ConversionError('invalid-token', `Conversion token ${request.token.requestId} has already been used.`);
      this.issuedTokens.add(originalKey);
      if (this.issuedTokens.size >= MAX_CONVERSION_TOKEN_BOOKKEEPING) this.tokenNamespaceExhausted = true;
      return request;
    }
    let token: ConversionToken;
    do {
      this.tokenSerial += 1n;
      const suffix = `~${this.tokenSerial.toString(36)}`;
      const baseLength = Math.max(1, 256 - suffix.length);
      token = { ...request.token, requestId: `${request.token.requestId.slice(0, baseLength)}${suffix}` };
    } while (this.issuedTokens.has(requestKey(token)));
    // Once the bounded namespace is exhausted, the monotonic suffix is the
    // uniqueness proof; no additional historical keys are retained.
    return { ...request, token };
  }

  private createPending(request: ConversionRequestMessage, signal?: AbortSignal): { request: ConversionRequestMessage; pending: PendingConversion; promise: Promise<ConversionResultMessage> } {
    const uniqueRequest = this.reserveToken(copyRequest(request));
    const internalRequest = copyRequest(uniqueRequest);
    const key = requestKey(internalRequest.token);
    let resolvePromise!: (result: ConversionResultMessage) => void;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<ConversionResultMessage>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const pending: PendingConversion = { request: internalRequest, resolve: resolvePromise, reject: rejectPromise, signal, signalCleanup: () => undefined };
    this.pending.set(key, pending);
    if (signal) {
      const abort = (): void => { this.cancel(internalRequest.token); };
      signal.addEventListener('abort', abort, { once: true });
      pending.signalCleanup = () => signal.removeEventListener('abort', abort);
      if (signal.aborted) this.cancel(internalRequest.token);
    }
    return { request: internalRequest, pending, promise };
  }

  submit(input: ConversionRequestInput, options: { readonly signal?: AbortSignal } = {}): ConversionJob {
    if (this.disposed) throw new Error('The conversion worker client has been disposed.');
    const requested = requestFromInput(input, this.requestIdFactory);
    const { request: internalRequest, promise } = this.createPending(requested, options.signal);
    const cancellationToken = Object.freeze({ ...internalRequest.token });
    this.dispatch(copyRequest(internalRequest), options.signal);
    return { request: copyRequest(internalRequest), promise, cancel: () => this.cancel(cancellationToken) };
  }

  submitImage(source: Blob | File, input: ConversionImageInput, options: { readonly signal?: AbortSignal } = {}): ConversionJob {
    if (this.disposed) throw new Error('The conversion worker client has been disposed.');
    const requested = createConversionImageRequest({
      ...input,
      source,
      maxBytes: this.rasterOptions.maxBytes,
      maxPixels: this.rasterOptions.maxPixels,
      token: {
        projectId: input.projectId,
        baseRevision: input.baseRevision,
        requestId: input.requestId ?? this.requestIdFactory()
      }
    });
    const { request: internalRequest, promise } = this.createPending(requested, options.signal);
    const cancellationToken = Object.freeze({ ...internalRequest.token });
    this.dispatch(copyRequest(internalRequest), options.signal);
    return { request: copyRequest(internalRequest), promise, cancel: () => this.cancel(cancellationToken) };
  }

  request(input: ConversionRequestInput, options: { readonly signal?: AbortSignal } = {}): Promise<ConversionResultMessage> {
    return this.submit(input, options).promise;
  }

  requestImage(source: Blob | File, input: ConversionImageInput, options: { readonly signal?: AbortSignal } = {}): Promise<ConversionResultMessage> {
    return this.submitImage(source, input, options).promise;
  }

  convert(input: ConversionRequestInput, options: { readonly signal?: AbortSignal } = {}): Promise<ConversionResultMessage> {
    return this.request(input, options);
  }

  convertImage(source: Blob | File, input: ConversionImageInput, options: { readonly signal?: AbortSignal } = {}): Promise<ConversionResultMessage> {
    return this.requestImage(source, input, options);
  }

  cancel(request: string | ConversionToken): boolean {
    let key: string | undefined;
    if (typeof request === 'string') {
      const matches = [...this.pending.entries()].filter(([, pending]) => pending.request.token.requestId === request);
      if (matches.length !== 1) return false;
      key = matches[0][0];
    } else {
      try {
        key = requestKey(request);
      } catch {
        return false;
      }
    }
    if (!key) return false;
    const pending = this.pending.get(key);
    if (!pending) return false;
    pending.fallbackCancel?.();
    pending.fallbackCancel = undefined;
    pending.signalCleanup();
    this.pending.delete(key);
    pending.reject(new ConversionCancelledError(pending.request.token.requestId));
    try {
      this.worker?.postMessage(createConversionCancel(pending.request.token));
    } catch {
      // Cancellation already rejected the local job; transport failure is immaterial.
    }
    return true;
  }

  private dispatch(request: ConversionRequestMessage, signal?: AbortSignal, forceFallback = false): void {
    const key = requestKey(request.token);
    if (!this.pending.has(key) || this.disposed) return;
    const worker = forceFallback ? null : this.ensureWorker();
    if (worker) {
      try {
        const wireRequest = copyRequest(request);
        if (wireRequest.inputType === 'raster') worker.postMessage(wireRequest, [wireRequest.pixels.buffer]);
        else worker.postMessage(wireRequest);
      } catch (error) {
        this.handleWorkerFailure(new ConversionWorkerTransportError(eventMessage(error, 'The conversion worker could not receive the request.')));
      }
      return;
    }
    const queueJob = mainThreadConversionQueue.enqueue(async () => {
      const cancellation: ConversionCancellation = { signal, isCancelled: () => !this.pending.has(key) || this.disposed };
      conversionCancelled(cancellation, request.token.requestId);
      const workRequest = copyRequest(request);
      let result: ConversionResultMessage;
      if (workRequest.inputType === 'image') {
        const raster = await rasterForConversion(workRequest.image, workRequest.targetWidth, workRequest.targetHeight, this.rasterOptions, cancellation);
        conversionCancelled(cancellation, request.token.requestId);
        const rasterRequest = createConversionRequest(raster, {
          targetWidth: workRequest.targetWidth,
          targetHeight: workRequest.targetHeight,
          paletteBudget: workRequest.paletteBudget,
          backgroundSourceId: workRequest.backgroundSourceId,
          autoCrop: workRequest.autoCrop,
          catalog: workRequest.catalog,
          token: workRequest.token,
          sourceImage: {
            ...(workRequest.sourceAssetId === undefined ? {} : { assetId: workRequest.sourceAssetId }),
            ...(workRequest.sourceMimeType === undefined ? {} : { mimeType: workRequest.sourceMimeType })
          }
        });
        conversionCancelled(cancellation, workRequest.token.requestId);
        result = await convertConversionRequestAsync(rasterRequest, cancellation);
      } else {
        result = await convertConversionRequestAsync(workRequest, cancellation);
      }
      conversionCancelled(cancellation, request.token.requestId);
      return result;
    });
    const pending = this.pending.get(key);
    if (pending) pending.fallbackCancel = queueJob.cancel;
    void queueJob.promise.then((result) => this.resolvePending(key, result), (error: unknown) => this.rejectPending(key, error));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of [...this.pending.values()]) this.cancel(pending.request.token);
    this.removeWorkerListeners(this.worker);
    try {
      this.worker?.terminate?.();
    } catch {
      // Disposal is best effort.
    }
    this.worker = null;
  }

  private ensureWorker(): ConversionWorkerLike | null {
    if (!this.useWorker || this.worker) return this.worker;
    let worker: ConversionWorkerLike | null;
    try {
      worker = this.workerFactory();
    } catch {
      worker = null;
    }
    this.worker = worker;
    if (worker) {
      const target = workerEventTarget(worker);
      target.addEventListener('message', this.onMessage as unknown as (event: unknown) => void);
      target.addEventListener('error', this.onWorkerError);
      target.addEventListener('messageerror', this.onWorkerMessageError);
    }
    return worker;
  }

  private removeWorkerListeners(worker: ConversionWorkerLike | null): void {
    if (!worker) return;
    const target = workerEventTarget(worker);
    target.removeEventListener?.('message', this.onMessage as unknown as (event: unknown) => void);
    target.removeEventListener?.('error', this.onWorkerError);
    target.removeEventListener?.('messageerror', this.onWorkerMessageError);
  }

  private handleWorkerFailure(error: ConversionWorkerTransportError): void {
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
    for (const job of pending) {
      job.fallbackCancel?.();
      job.fallbackCancel = undefined;
      job.signalCleanup();
      job.reject(error);
    }
  }

  private handleMessage(message: unknown): void {
    if (this.disposed) return;
    const token = responseToken(message);
    if (!token) return;
    const key = requestKey(token);
    const pending = this.pending.get(key);
    if (!pending) {
      const sameRequestId = [...this.pending.values()].filter((candidate) => candidate.request.token.requestId === token.requestId);
      if (sameRequestId.length === 1 && !this.issuedTokens.has(key)) {
        const candidate = sameRequestId[0];
        this.rejectPending(requestKey(candidate.request.token), new ConversionStaleResultError(candidate.request.token, token));
      }
      return;
    }
    try {
      if (!isRecord(message) || message.protocol !== pending.request.protocol) {
        return;
      }
      if (message.type === CONVERSION_RESULT_TYPE) {
        assertCurrentResult(message, pending.request);
        this.resolvePending(key, message);
      } else if (isRecord(message) && message.type === CONVERSION_CANCELLED_TYPE) {
        this.rejectPending(key, new ConversionCancelledError(token.requestId));
      } else if (isRecord(message) && message.type === CONVERSION_ERROR_TYPE) {
        const code = typeof message.code === 'string' ? message.code : 'worker-error';
        const text = typeof message.message === 'string' ? message.message : 'The conversion worker failed.';
        if (code === 'unavailable' && pending.request.inputType === 'image') {
          this.dispatch(pending.request, pending.signal, true);
          return;
        }
        this.rejectPending(key, new ConversionWorkerError(code, text));
      } else {
        this.rejectPending(key, new ConversionError('invalid-draft', 'The conversion worker returned an unknown response.'));
      }
    } catch (error) {
      this.rejectPending(key, error);
    }
  }

  private resolvePending(key: string, result: ConversionResultMessage): void {
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    pending.fallbackCancel = undefined;
    pending.signalCleanup();
    pending.resolve(result);
  }

  private rejectPending(key: string, error: unknown): void {
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    pending.fallbackCancel = undefined;
    pending.signalCleanup();
    pending.reject(error);
  }
}

export async function convertImageToPattern(
  source: ConversionRaster | Blob | File,
  input: ConversionImageInput,
  clientOptions: ConversionWorkerClientOptions = {},
  requestOptions: { readonly signal?: AbortSignal } = {}
): Promise<ConversionResultMessage> {
  const client = createConversionWorkerClient(clientOptions);
  try {
    if (isImageSource(source)) return await client.requestImage(source, input, requestOptions);
    return await client.request({ ...input, raster: source }, requestOptions);
  } finally {
    client.dispose();
  }
}

export function createConversionWorkerClient(options: ConversionWorkerClientOptions = {}): ConversionWorkerClient {
  return new ConversionWorkerClient(options);
}

export const createImageConversionClient = createConversionWorkerClient;
