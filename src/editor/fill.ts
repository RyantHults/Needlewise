import { CellKind } from '../domain';

/** The structured-clone protocol shared by the fill client and worker. */
export const FILL_PROTOCOL = 'needlewise.fill.v1' as const;
export const FILL_PROTOCOL_VERSION = 1 as const;
export const FILL_REQUEST_TYPE = 'fill-request' as const;
export const FILL_RESULT_TYPE = 'fill-result' as const;
export const FILL_CANCEL_TYPE = 'fill-cancel' as const;
export const FILL_CANCELLED_TYPE = 'fill-cancelled' as const;
export const FILL_ERROR_TYPE = 'fill-error' as const;

/** Fill is deliberately bounded independently of the document/persistence limits. */
export const MAX_FILL_DIMENSION = 1_000_000;
export const MAX_FILL_CELL_COUNT = 1_000_000;
export const MAX_FILL_COLOR_SLOTS = 4;
export const MAX_FILL_PLANE_BYTES = MAX_FILL_CELL_COUNT + MAX_FILL_CELL_COUNT * MAX_FILL_COLOR_SLOTS * 2;
export const MAX_FILL_RESULT_BYTES = MAX_FILL_CELL_COUNT * 4;
export const MAX_FILL_TAG_LENGTH = 256;

export interface FillRequestInput {
  readonly projectId: string;
  readonly baseRevision: number;
  readonly requestId?: string;
  readonly width: number;
  readonly height: number;
  readonly startIndex: number;
  readonly kind: Uint8Array;
  readonly colors: Uint16Array;
}

export interface FillRequestMessage {
  readonly protocol: typeof FILL_PROTOCOL;
  readonly type: typeof FILL_REQUEST_TYPE;
  readonly projectId: string;
  readonly baseRevision: number;
  readonly requestId: string;
  readonly width: number;
  readonly height: number;
  readonly startIndex: number;
  /** A copied one-byte geometry plane. */
  readonly kind: Uint8Array;
  /** A copied four-slot-per-cell color plane. */
  readonly colors: Uint16Array;
}

export interface FillResultMessage {
  readonly protocol: typeof FILL_PROTOCOL;
  readonly type: typeof FILL_RESULT_TYPE;
  readonly projectId: string;
  readonly baseRevision: number;
  readonly requestId: string;
  readonly width: number;
  readonly height: number;
  readonly startIndex: number;
  /** Strictly increasing, duplicate-free cell indices. */
  readonly indices: Uint32Array;
}

export interface FillCancelMessage {
  readonly protocol: typeof FILL_PROTOCOL;
  readonly type: typeof FILL_CANCEL_TYPE;
  readonly projectId: string;
  readonly baseRevision: number;
  readonly requestId: string;
}

export interface FillCancelledMessage {
  readonly protocol: typeof FILL_PROTOCOL;
  readonly type: typeof FILL_CANCELLED_TYPE;
  readonly projectId: string;
  readonly baseRevision: number;
  readonly requestId: string;
}

export interface FillErrorMessage {
  readonly protocol: typeof FILL_PROTOCOL;
  readonly type: typeof FILL_ERROR_TYPE;
  readonly projectId?: string;
  readonly baseRevision?: number;
  readonly requestId?: string;
  readonly code: string;
  readonly message: string;
}

export type FillWorkerMessage = FillRequestMessage | FillCancelMessage;
export type FillWorkerResponse = FillResultMessage | FillCancelledMessage | FillErrorMessage;

export class FillProtocolError extends Error {
  readonly code = 'invalid-fill-payload';

  constructor(message: string) {
    super(message);
    this.name = 'FillProtocolError';
  }
}

export class FillCancelledError extends Error {
  readonly code = 'fill-cancelled';
  readonly requestId: string;

  constructor(requestId: string) {
    super(`Fill request ${requestId} was cancelled.`);
    this.name = 'FillCancelledError';
    this.requestId = requestId;
  }
}

export class FillStaleResultError extends Error {
  readonly code = 'stale-fill-result';
  readonly expected: FillResultIdentity;
  readonly actual: FillResultIdentity;

  constructor(expected: FillResultIdentity, actual: FillResultIdentity) {
    super(`The fill result for ${actual.projectId}@${String(actual.baseRevision)}:${actual.requestId} is stale.`);
    this.name = 'FillStaleResultError';
    this.expected = expected;
    this.actual = actual;
  }
}

export class FillWorkerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'FillWorkerError';
    this.code = code;
  }
}

export class FillWorkerTransportError extends FillWorkerError {
  constructor(message: string) {
    super('worker-transport', message);
    this.name = 'FillWorkerTransportError';
  }
}

export interface FillResultIdentity {
  readonly projectId: string;
  readonly baseRevision: number;
  readonly requestId: string;
}

export interface FillCancellation {
  readonly signal?: AbortSignal;
  readonly isCancelled?: () => boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isBoundedTag(value: unknown, label: string): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_FILL_TAG_LENGTH) {
    throw new FillProtocolError(`${label} must be a non-empty string of at most ${String(MAX_FILL_TAG_LENGTH)} characters.`);
  }
  return true;
}

function isNonNegativeInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new FillProtocolError(`${label} must be a non-negative integer no greater than ${String(maximum)}.`);
  }
  return true;
}

function assertDimensions(width: unknown, height: unknown): asserts width is number {
  if (!Number.isSafeInteger(width) || (width as number) < 1 || (width as number) > MAX_FILL_DIMENSION) {
    throw new FillProtocolError(`width must be a positive integer no greater than ${String(MAX_FILL_DIMENSION)}.`);
  }
  if (!Number.isSafeInteger(height) || (height as number) < 1 || (height as number) > MAX_FILL_DIMENSION) {
    throw new FillProtocolError(`height must be a positive integer no greater than ${String(MAX_FILL_DIMENSION)}.`);
  }
  const cellCount = (width as number) * (height as number);
  if (!Number.isSafeInteger(cellCount) || cellCount > MAX_FILL_CELL_COUNT) {
    throw new FillProtocolError(`The fill grid cannot contain more than ${String(MAX_FILL_CELL_COUNT)} cells.`);
  }
}

function isUint8Plane(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && !(typeof SharedArrayBuffer !== 'undefined' && value.buffer instanceof SharedArrayBuffer);
}

function isUint16Plane(value: unknown): value is Uint16Array {
  return value instanceof Uint16Array && !(typeof SharedArrayBuffer !== 'undefined' && value.buffer instanceof SharedArrayBuffer);
}

function isUint32Plane(value: unknown): value is Uint32Array {
  return value instanceof Uint32Array && !(typeof SharedArrayBuffer !== 'undefined' && value.buffer instanceof SharedArrayBuffer);
}

function assertPlanes(kind: unknown, colors: unknown, cellCount: number): asserts kind is Uint8Array {
  if (!isUint8Plane(kind) || kind.length !== cellCount) {
    throw new FillProtocolError(`kind must be a Uint8Array with exactly ${String(cellCount)} cells.`);
  }
  if (!isUint16Plane(colors) || colors.length !== cellCount * MAX_FILL_COLOR_SLOTS) {
    throw new FillProtocolError(`colors must be a Uint16Array with exactly ${String(cellCount * MAX_FILL_COLOR_SLOTS)} slots.`);
  }
  if (kind.byteLength + colors.byteLength > MAX_FILL_PLANE_BYTES) {
    throw new FillProtocolError(`Fill planes exceed the ${String(MAX_FILL_PLANE_BYTES)}-byte limit.`);
  }
  for (const value of kind) {
    if (value > CellKind.Quarters) throw new FillProtocolError(`Cell kind ${String(value)} is invalid.`);
  }
}

function assertIdentity(value: Pick<FillResultIdentity, 'projectId' | 'baseRevision' | 'requestId'>): void {
  isBoundedTag(value.projectId, 'projectId');
  isNonNegativeInteger(value.baseRevision, 'baseRevision', 0xffffffff);
  isBoundedTag(value.requestId, 'requestId');
}

export function assertValidFillRequest(value: unknown): asserts value is FillRequestMessage {
  if (!isRecord(value) || value.protocol !== FILL_PROTOCOL || value.type !== FILL_REQUEST_TYPE) {
    throw new FillProtocolError('The fill request protocol tag is invalid.');
  }
  assertIdentity(value as unknown as FillResultIdentity);
  assertDimensions(value.width, value.height);
  const cellCount = (value.width as number) * (value.height as number);
  isNonNegativeInteger(value.startIndex, 'startIndex', cellCount - 1);
  assertPlanes(value.kind, value.colors, cellCount);
}

export function validateFillRequest(value: unknown): value is FillRequestMessage {
  try {
    assertValidFillRequest(value);
    return true;
  } catch {
    return false;
  }
}

export function assertValidFillResult(value: unknown): asserts value is FillResultMessage {
  if (!isRecord(value) || value.protocol !== FILL_PROTOCOL || value.type !== FILL_RESULT_TYPE) {
    throw new FillProtocolError('The fill result protocol tag is invalid.');
  }
  assertIdentity(value as unknown as FillResultIdentity);
  assertDimensions(value.width, value.height);
  const cellCount = (value.width as number) * (value.height as number);
  isNonNegativeInteger(value.startIndex, 'startIndex', cellCount - 1);
  if (!isUint32Plane(value.indices)) throw new FillProtocolError('indices must be a Uint32Array.');
  if (value.indices.length === 0 || value.indices.length > cellCount) {
    throw new FillProtocolError('indices must contain at least one and no more than one cell per grid cell.');
  }
  if (value.indices.byteLength > MAX_FILL_RESULT_BYTES) {
    throw new FillProtocolError(`indices exceed the ${String(MAX_FILL_RESULT_BYTES)}-byte limit.`);
  }
  let previous = -1;
  for (const index of value.indices) {
    if (index >= cellCount || index <= previous) {
      throw new FillProtocolError('indices must be sorted, duplicate-free, and inside the grid.');
    }
    previous = index;
  }
}

export function validateFillResult(value: unknown): value is FillResultMessage {
  try {
    assertValidFillResult(value);
    return true;
  } catch {
    return false;
  }
}

export function createFillRequest(input: FillRequestInput): FillRequestMessage {
  const requestId = input.requestId ?? createFillRequestId();
  const request: FillRequestMessage = {
    protocol: FILL_PROTOCOL,
    type: FILL_REQUEST_TYPE,
    projectId: input.projectId,
    baseRevision: input.baseRevision,
    requestId,
    width: input.width,
    height: input.height,
    startIndex: input.startIndex,
    // These copies are the only planes that are ever sent to a worker.
    kind: isUint8Plane(input.kind) ? new Uint8Array(input.kind) : input.kind,
    colors: isUint16Plane(input.colors) ? new Uint16Array(input.colors) : input.colors
  } as FillRequestMessage;
  assertValidFillRequest(request);
  return request;
}

export function createFillCancel(request: Pick<FillResultIdentity, 'projectId' | 'baseRevision' | 'requestId'>): FillCancelMessage {
  assertIdentity(request);
  return {
    protocol: FILL_PROTOCOL,
    type: FILL_CANCEL_TYPE,
    projectId: request.projectId,
    baseRevision: request.baseRevision,
    requestId: request.requestId
  };
}

export function assertValidFillCancel(value: unknown): asserts value is FillCancelMessage {
  if (!isRecord(value) || value.protocol !== FILL_PROTOCOL || value.type !== FILL_CANCEL_TYPE) {
    throw new FillProtocolError('The fill cancellation protocol tag is invalid.');
  }
  assertIdentity(value as unknown as FillResultIdentity);
}

export function validateFillCancel(value: unknown): value is FillCancelMessage {
  try {
    assertValidFillCancel(value);
    return true;
  } catch {
    return false;
  }
}

export function createFillResult(request: FillRequestMessage, indices: Uint32Array): FillResultMessage {
  assertValidFillRequest(request);
  const result: FillResultMessage = {
    protocol: FILL_PROTOCOL,
    type: FILL_RESULT_TYPE,
    projectId: request.projectId,
    baseRevision: request.baseRevision,
    requestId: request.requestId,
    width: request.width,
    height: request.height,
    startIndex: request.startIndex,
    indices
  };
  assertValidFillResult(result);
  return result;
}

export function isFillResultCurrent(result: unknown, expected: FillResultIdentity): result is FillResultMessage {
  if (!validateFillResult(result)) return false;
  return result.projectId === expected.projectId
    && result.baseRevision === expected.baseRevision
    && result.requestId === expected.requestId;
}

export const isCurrentFillResult = isFillResultCurrent;

function cancellationRequested(cancellation?: FillCancellation): boolean {
  return cancellation?.signal?.aborted === true || cancellation?.isCancelled?.() === true;
}

interface FillRunState {
  readonly request: FillRequestMessage;
  readonly targetKind: number;
  readonly targetOffset: number;
  readonly queue: Uint32Array;
  readonly visited: Uint8Array;
  readonly output: Uint32Array;
  head: number;
  tail: number;
  outputLength: number;
}

function createFillRunState(request: FillRequestMessage, cancellation?: FillCancellation): FillRunState {
  assertValidFillRequest(request);
  if (cancellationRequested(cancellation)) throw new FillCancelledError(request.requestId);
  const state: FillRunState = {
    request,
    targetKind: request.kind[request.startIndex],
    targetOffset: request.startIndex * MAX_FILL_COLOR_SLOTS,
    queue: new Uint32Array(request.width * request.height),
    visited: new Uint8Array(request.width * request.height),
    output: new Uint32Array(request.width * request.height),
    head: 0,
    tail: 1,
    outputLength: 0
  };
  state.queue[0] = request.startIndex;
  state.visited[request.startIndex] = 1;
  return state;
}

function matchesTarget(state: FillRunState, index: number): boolean {
  if (state.request.kind[index] !== state.targetKind) return false;
  const offset = index * MAX_FILL_COLOR_SLOTS;
  const targetColors = state.targetOffset;
  for (let slot = 0; slot < MAX_FILL_COLOR_SLOTS; slot += 1) {
    if (state.request.colors[offset + slot] !== state.request.colors[targetColors + slot]) return false;
  }
  return true;
}

function visitNeighbor(state: FillRunState, index: number): void {
  if (state.visited[index] !== 0) return;
  state.visited[index] = 1;
  if (matchesTarget(state, index)) state.queue[state.tail++] = index;
}

function processFillBatch(state: FillRunState, cancellation: FillCancellation | undefined, batchSize: number): boolean {
  let processed = 0;
  const { width, height } = state.request;
  while (state.head < state.tail && processed < batchSize) {
    if (cancellationRequested(cancellation)) throw new FillCancelledError(state.request.requestId);
    const index = state.queue[state.head++];
    state.output[state.outputLength++] = index;
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0) visitNeighbor(state, index - 1);
    if (x + 1 < width) visitNeighbor(state, index + 1);
    if (y > 0) visitNeighbor(state, index - width);
    if (y + 1 < height) visitNeighbor(state, index + width);
    processed += 1;
  }
  return state.head >= state.tail;
}

function finishFill(state: FillRunState): Uint32Array {
  const result = state.output.slice(0, state.outputLength);
  result.sort();
  return result;
}

/** Run the exact, four-connected fill synchronously (useful for fallback/tests). */
export function runExactFloodFill(request: FillRequestMessage, cancellation?: FillCancellation): Uint32Array {
  const state = createFillRunState(request, cancellation);
  processFillBatch(state, cancellation, Number.MAX_SAFE_INTEGER);
  return finishFill(state);
}

/** Worker-side form which yields between bounded batches so cancel messages are observable. */
export function runExactFloodFillAsync(request: FillRequestMessage, cancellation?: FillCancellation): Promise<Uint32Array> {
  const state = createFillRunState(request, cancellation);
  return new Promise((resolve, reject) => {
    const process = (): void => {
      try {
        if (processFillBatch(state, cancellation, 8_192)) {
          resolve(finishFill(state));
          return;
        }
        globalThis.setTimeout(process, 0);
      } catch (error) {
        reject(error);
      }
    };
    process();
  });
}

export interface FillWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener?(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  terminate?(): void;
}

export type FillWorkerFactory = () => FillWorkerLike | null;

export interface FillJob {
  readonly request: FillRequestMessage;
  readonly promise: Promise<FillResultMessage>;
  cancel(): void;
}

export interface FillWorkerClientOptions {
  readonly workerFactory?: FillWorkerFactory;
  readonly requestIdFactory?: () => string;
  readonly useWorker?: boolean;
}

interface PendingFill {
  readonly request: FillRequestMessage;
  readonly resolve: (result: FillResultMessage) => void;
  readonly reject: (error: unknown) => void;
  signalCleanup: () => void;
  cancelled: boolean;
}

interface FillWorkerEventTarget {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
}

function workerEventTarget(worker: FillWorkerLike): FillWorkerEventTarget {
  return worker as unknown as FillWorkerEventTarget;
}

function eventMessage(event: unknown, fallback: string): string {
  if (event instanceof Error && event.message) return event.message;
  if (isRecord(event) && typeof event.message === 'string' && event.message) return event.message;
  return fallback;
}

function createDefaultWorker(): FillWorkerLike | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('../workers/fill.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

function copyFillRequest(request: FillRequestMessage): FillRequestMessage {
  return {
    ...request,
    kind: new Uint8Array(request.kind),
    colors: new Uint16Array(request.colors)
  };
}

function createFillRequestId(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.randomUUID) return cryptoObject.randomUUID();
  return `fill-${Date.now().toString(36)}-${String(++fillRequestSequence)}`;
}

let fillRequestSequence = 0;

function asIdentity(value: FillResultIdentity): FillResultIdentity {
  return { projectId: value.projectId, baseRevision: value.baseRevision, requestId: value.requestId };
}

function assertCurrentResult(result: unknown, request: FillRequestMessage): asserts result is FillResultMessage {
  if (!validateFillResult(result)) throw new FillProtocolError('The worker returned a malformed fill result.');
  const expected = asIdentity(request);
  const actual = asIdentity(result);
  if (!isFillResultCurrent(result, expected)) throw new FillStaleResultError(expected, actual);
  if (result.width !== request.width || result.height !== request.height || result.startIndex !== request.startIndex) {
    throw new FillStaleResultError(expected, actual);
  }
}

function responseRequestId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.requestId === 'string' ? value.requestId : undefined;
}

export class FillWorkerClient {
  private readonly workerFactory: FillWorkerFactory;
  private readonly requestIdFactory: () => string;
  private readonly useWorker: boolean;
  private worker: FillWorkerLike | null = null;
  private readonly pending = new Map<string, PendingFill>();
  private disposed = false;
  private readonly onMessage = (event: MessageEvent<unknown>): void => this.handleMessage(event.data);
  private readonly onWorkerError = (event: unknown): void => this.handleWorkerFailure(new FillWorkerTransportError(eventMessage(event, 'The fill worker failed.')));
  private readonly onWorkerMessageError = (event: unknown): void => this.handleWorkerFailure(new FillWorkerTransportError(eventMessage(event, 'The fill worker could not read a message.')));

  constructor(options: FillWorkerClientOptions = {}) {
    this.workerFactory = options.workerFactory ?? createDefaultWorker;
    this.requestIdFactory = options.requestIdFactory ?? createFillRequestId;
    this.useWorker = options.useWorker ?? true;
  }

  submit(input: FillRequestInput, options: { readonly signal?: AbortSignal } = {}): FillJob {
    if (this.disposed) throw new Error('The fill worker client has been disposed.');
    const request = createFillRequest({ ...input, requestId: input.requestId ?? this.requestIdFactory() });
    if (this.pending.has(request.requestId)) throw new FillProtocolError(`Fill request ID ${request.requestId} is already pending.`);
    let resolvePromise!: (result: FillResultMessage) => void;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<FillResultMessage>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const pending: PendingFill = {
      request,
      resolve: resolvePromise,
      reject: rejectPromise,
      signalCleanup: () => undefined,
      cancelled: false
    };
    this.pending.set(request.requestId, pending);
    const signal = options.signal;
    if (signal) {
      const abort = (): void => { this.cancel(request.requestId); };
      signal.addEventListener('abort', abort, { once: true });
      pending.signalCleanup = () => signal.removeEventListener('abort', abort);
      if (signal.aborted) {
        this.cancel(request.requestId);
        return { request, promise, cancel: () => this.cancel(request.requestId) };
      }
    }

    const worker = this.ensureWorker();
    if (worker) {
      try {
        const wireRequest = copyFillRequest(request);
        worker.postMessage(wireRequest, [wireRequest.kind.buffer, wireRequest.colors.buffer]);
      } catch (error) {
        this.handleWorkerFailure(new FillWorkerTransportError(eventMessage(error, 'The fill worker could not receive the request.')));
      }
    } else {
      globalThis.queueMicrotask(() => {
        const current = this.pending.get(request.requestId);
        if (!current) return;
        try {
          const indices = runExactFloodFill(current.request, { isCancelled: () => current.cancelled });
          this.resolvePending(request.requestId, createFillResult(current.request, indices));
        } catch (error) {
          this.rejectPending(request.requestId, error);
        }
      });
    }
    return { request, promise, cancel: () => this.cancel(request.requestId) };
  }

  request(input: FillRequestInput, options: { readonly signal?: AbortSignal } = {}): Promise<FillResultMessage> {
    return this.submit(input, options).promise;
  }

  fill(input: FillRequestInput, options: { readonly signal?: AbortSignal } = {}): Promise<FillResultMessage> {
    return this.request(input, options);
  }

  cancel(requestId: string): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    pending.cancelled = true;
    pending.signalCleanup();
    this.pending.delete(requestId);
    pending.reject(new FillCancelledError(requestId));
    const worker = this.worker;
    if (worker) {
      try {
        worker.postMessage(createFillCancel(pending.request));
      } catch {
        // Cancellation has already been applied locally; a transport failure is immaterial.
      }
    }
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const requestId of [...this.pending.keys()]) this.cancel(requestId);
    this.removeWorkerListeners(this.worker);
    try {
      this.worker?.terminate?.();
    } catch {
      // Disposal is best effort; the worker reference is still cleared below.
    }
    this.worker = null;
  }

  private ensureWorker(): FillWorkerLike | null {
    if (!this.useWorker || this.worker) return this.worker;
    let worker: FillWorkerLike | null;
    try {
      worker = this.workerFactory();
    } catch {
      worker = null;
    }
    this.worker = worker;
    if (this.worker) {
      const target = workerEventTarget(this.worker);
      target.addEventListener('message', this.onMessage as unknown as (event: unknown) => void);
      target.addEventListener('error', this.onWorkerError);
      target.addEventListener('messageerror', this.onWorkerMessageError);
    }
    return this.worker;
  }

  private removeWorkerListeners(worker: FillWorkerLike | null): void {
    if (!worker) return;
    const target = workerEventTarget(worker);
    target.removeEventListener?.('message', this.onMessage as unknown as (event: unknown) => void);
    target.removeEventListener?.('error', this.onWorkerError);
    target.removeEventListener?.('messageerror', this.onWorkerMessageError);
  }

  private handleWorkerFailure(error: FillWorkerTransportError): void {
    const failedWorker = this.worker;
    this.worker = null;
    this.removeWorkerListeners(failedWorker);
    try {
      failedWorker?.terminate?.();
    } catch {
      // A failed worker may already have been terminated by the platform.
    }
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const job of pending) {
      job.signalCleanup();
      job.reject(error);
    }
  }

  private handleMessage(message: unknown): void {
    const requestId = responseRequestId(message);
    if (!requestId) return;
    const pending = this.pending.get(requestId);
    if (!pending) return;
    try {
      if (isRecord(message) && message.type === FILL_RESULT_TYPE) {
        assertCurrentResult(message, pending.request);
        this.resolvePending(requestId, message);
      } else if (isRecord(message) && message.type === FILL_CANCELLED_TYPE) {
        this.rejectPending(requestId, new FillCancelledError(requestId));
      } else if (isRecord(message) && message.type === FILL_ERROR_TYPE) {
        const code = typeof message.code === 'string' ? message.code : 'worker-error';
        const text = typeof message.message === 'string' ? message.message : 'The fill worker failed.';
        this.rejectPending(requestId, new FillWorkerError(code, text));
      } else {
        this.rejectPending(requestId, new FillProtocolError('The worker returned an unknown fill response.'));
      }
    } catch (error) {
      this.rejectPending(requestId, error);
    }
  }

  private resolvePending(requestId: string, result: FillResultMessage): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    pending.signalCleanup();
    pending.resolve(result);
  }

  private rejectPending(requestId: string, error: unknown): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    pending.signalCleanup();
    pending.reject(error);
  }
}

export function createFillWorkerClient(options: FillWorkerClientOptions = {}): FillWorkerClient {
  return new FillWorkerClient(options);
}

export const createFillClient = createFillWorkerClient;
