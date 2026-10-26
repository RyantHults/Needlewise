import {
  CONVERSION_CANCELLED_TYPE,
  CONVERSION_ERROR_TYPE,
  CONVERSION_RESULT_TYPE,
  ConversionError,
  ConversionCancelledError,
  ConversionCancellation,
  cloneCatalogSnapshot,
  createConversionCancel,
  createConversionImageRequest,
  createConversionRequest,
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
import { runConversionRequest } from './run-request';
import { isRecord } from '../domain';
import { WorkerConnection, createDeferred, createRequestId, linkAbort, type WorkerLike } from '../workers/client';

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

export interface ConversionRequestInput extends Omit<ConversionOptions, 'token' | 'targetWidth' | 'targetHeight'> {
  readonly raster: ConversionRaster;
  readonly targetWidth: number;
  readonly targetHeight: number;
  readonly projectId: string;
  readonly baseRevision: number;
}

export type ConversionImageInput = Omit<ConversionRequestInput, 'raster'>;

export interface ConversionJob {
  readonly promise: Promise<ConversionResultMessage>;
  cancel(): void;
}

export interface ConversionWorkerClientOptions {
  readonly workerFactory?: () => WorkerLike | null;
  readonly useWorker?: boolean;
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

function isImageSource(value: ConversionRaster | Blob | File): value is Blob | File {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

function createDefaultWorker(): WorkerLike {
  return new Worker(new URL('../workers/image-conversion.worker.ts', import.meta.url), { type: 'module' });
}

function requestFromInput(input: ConversionRequestInput): ConversionRasterRequestMessage {
  return createConversionRequest(input.raster, {
    targetWidth: input.targetWidth,
    targetHeight: input.targetHeight,
    paletteBudget: input.paletteBudget,
    backgroundSourceId: input.backgroundSourceId,
    autoCrop: input.autoCrop,
    confettiDistance: input.confettiDistance,
    catalog: input.catalog,
    sourceImage: input.sourceImage,
    token: {
      projectId: input.projectId,
      baseRevision: input.baseRevision,
      requestId: createRequestId('conversion')
    }
  });
}

function copyRequest(request: ConversionRequestMessage): ConversionRequestMessage {
  const token = { ...request.token };
  return request.inputType === 'raster'
    ? { ...request, token, pixels: new Uint8ClampedArray(request.pixels), catalog: cloneCatalogSnapshot(request.catalog) }
    : { ...request, token, catalog: cloneCatalogSnapshot(request.catalog) };
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
  private readonly connection: WorkerConnection<WorkerLike>;
  private pending: PendingConversion | null = null;
  private disposed = false;

  constructor(options: ConversionWorkerClientOptions = {}) {
    const workerFactory = options.workerFactory ?? createDefaultWorker;
    this.connection = new WorkerConnection({
      label: 'conversion worker',
      create: options.useWorker === false ? () => null : workerFactory,
      onMessage: (data) => { this.handleMessage(data); },
      transportError: (message) => new ConversionWorkerTransportError(message),
      onFailure: (error) => { this.failPending(error); }
    });
  }

  private createPending(request: ConversionRequestMessage, signal?: AbortSignal): { request: ConversionRequestMessage; pending: PendingConversion; promise: Promise<ConversionResultMessage> } {
    if (this.pending) throw new Error('The conversion worker client is already running a conversion.');
    const internalRequest = copyRequest(request);
    const { promise, resolve, reject } = createDeferred<ConversionResultMessage>();
    const pending: PendingConversion = { request: internalRequest, resolve, reject, signal, signalCleanup: () => undefined };
    this.pending = pending;
    pending.signalCleanup = linkAbort(signal, () => { this.cancel(pending); });
    if (signal?.aborted) this.cancel(pending);
    return { request: internalRequest, pending, promise };
  }

  submit(input: ConversionRequestInput, options: { readonly signal?: AbortSignal } = {}): ConversionJob {
    if (this.disposed) throw new Error('The conversion worker client has been disposed.');
    const requested = requestFromInput(input);
    const { request: internalRequest, pending, promise } = this.createPending(requested, options.signal);
    this.dispatch(pending, copyRequest(internalRequest));
    return { promise, cancel: () => this.cancel(pending) };
  }

  submitImage(source: Blob | File, input: ConversionImageInput, options: { readonly signal?: AbortSignal } = {}): ConversionJob {
    if (this.disposed) throw new Error('The conversion worker client has been disposed.');
    const requested = createConversionImageRequest({
      ...input,
      source,
      token: {
        projectId: input.projectId,
        baseRevision: input.baseRevision,
        requestId: createRequestId('conversion')
      }
    });
    const { request: internalRequest, pending, promise } = this.createPending(requested, options.signal);
    this.dispatch(pending, copyRequest(internalRequest));
    return { promise, cancel: () => this.cancel(pending) };
  }

  request(input: ConversionRequestInput, options: { readonly signal?: AbortSignal } = {}): Promise<ConversionResultMessage> {
    return this.submit(input, options).promise;
  }

  requestImage(source: Blob | File, input: ConversionImageInput, options: { readonly signal?: AbortSignal } = {}): Promise<ConversionResultMessage> {
    return this.submitImage(source, input, options).promise;
  }

  private cancel(pending: PendingConversion): void {
    if (this.pending !== pending) return;
    this.pending = null;
    pending.fallbackCancel?.();
    pending.fallbackCancel = undefined;
    pending.signalCleanup();
    pending.reject(new ConversionCancelledError(pending.request.token.requestId));
    try {
      this.connection.current?.postMessage(createConversionCancel(pending.request.token));
    } catch {
      // Cancellation already rejected the local job; transport failure is immaterial.
    }
  }

  private dispatch(pending: PendingConversion, request: ConversionRequestMessage, forceFallback = false): void {
    if (this.pending !== pending || this.disposed) return;
    const { signal } = pending;
    const worker = forceFallback ? null : this.connection.ensure();
    if (worker) {
      const wireRequest = copyRequest(request);
      this.connection.post(worker, wireRequest, wireRequest.inputType === 'raster' ? [wireRequest.pixels.buffer] : undefined);
      return;
    }
    const queueJob = mainThreadConversionQueue.enqueue(() => {
      const cancellation: ConversionCancellation = { signal, isCancelled: () => this.pending !== pending || this.disposed };
      return runConversionRequest(copyRequest(request), cancellation);
    });
    pending.fallbackCancel = queueJob.cancel;
    void queueJob.promise.then((result) => this.resolvePending(pending, result), (error: unknown) => this.rejectPending(pending, error));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pending) this.cancel(this.pending);
    this.connection.dispose();
  }

  private handleMessage(message: unknown): void {
    if (this.disposed) return;
    const token = responseToken(message);
    if (!token) return;
    const pending = this.pending;
    if (!pending || !conversionTokensEqual(token, pending.request.token)) return;
    try {
      if (!isRecord(message) || message.protocol !== pending.request.protocol) {
        return;
      }
      if (message.type === CONVERSION_RESULT_TYPE) {
        assertCurrentResult(message, pending.request);
        this.resolvePending(pending, message);
      } else if (isRecord(message) && message.type === CONVERSION_CANCELLED_TYPE) {
        this.rejectPending(pending, new ConversionCancelledError(token.requestId));
      } else if (isRecord(message) && message.type === CONVERSION_ERROR_TYPE) {
        const code = typeof message.code === 'string' ? message.code : 'worker-error';
        const text = typeof message.message === 'string' ? message.message : 'The conversion worker failed.';
        if (code === 'unavailable' && pending.request.inputType === 'image') {
          this.dispatch(pending, pending.request, true);
          return;
        }
        this.rejectPending(pending, new ConversionWorkerError(code, text));
      } else {
        this.rejectPending(pending, new ConversionError('invalid-draft', 'The conversion worker returned an unknown response.'));
      }
    } catch (error) {
      this.rejectPending(pending, error);
    }
  }

  /** A worker failure can arrive while the job runs on the fallback queue, so it cancels that run too. */
  private failPending(error: Error): void {
    const job = this.pending;
    if (!job) return;
    job.fallbackCancel?.();
    this.rejectPending(job, error);
  }

  private resolvePending(pending: PendingConversion, result: ConversionResultMessage): void {
    if (this.pending !== pending) return;
    this.pending = null;
    pending.fallbackCancel = undefined;
    pending.signalCleanup();
    pending.resolve(result);
  }

  private rejectPending(pending: PendingConversion, error: unknown): void {
    if (this.pending !== pending) return;
    this.pending = null;
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
