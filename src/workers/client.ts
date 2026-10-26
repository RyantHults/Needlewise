import { isRecord } from '../domain/guards';

/** The part of `Worker` a main-thread client uses, so tests can stand in for it. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: unknown) => void): void;
  removeEventListener?(type: 'message' | 'error' | 'messageerror', listener: (event: unknown) => void): void;
  terminate?(): void;
}

export function eventMessage(event: unknown, fallback: string): string {
  if (event instanceof Error && event.message) return event.message;
  if (isRecord(event) && typeof event.message === 'string' && event.message) return event.message;
  return fallback;
}

let requestSequence = 0;

export function createRequestId(prefix: string): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.randomUUID) return cryptoObject.randomUUID();
  requestSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${String(requestSequence)}`;
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/**
 * Returns null when the worker cannot be created, including when `Worker`
 * itself is undefined. Callers keep their `new Worker(new URL(...))` literal
 * in `create`, because Vite finds workers by that expression.
 */
export function tryCreateWorker<W>(create: () => W | null): W | null {
  try {
    return create();
  } catch {
    return null;
  }
}

/** Calls `onAbort` once when `signal` aborts, and returns the cleanup that detaches it. */
export function linkAbort(signal: AbortSignal | undefined, onAbort: () => void): () => void {
  if (!signal) return () => undefined;
  signal.addEventListener('abort', onAbort, { once: true });
  return () => { signal.removeEventListener('abort', onAbort); };
}

export interface WorkerConnectionOptions<W extends WorkerLike> {
  /** Names the worker in transport error messages, as in "The fill worker failed." */
  readonly label: string;
  readonly create: () => W | null;
  readonly onMessage: (data: unknown) => void;
  readonly transportError: (message: string) => Error;
  /** Rejects every pending request and cancels any fallback run. */
  readonly onFailure: (error: Error) => void;
}

/**
 * Owns one lazily created worker. A transport failure (`error`,
 * `messageerror`, or a `postMessage` that throws) terminates the worker and
 * reports one error; the next `ensure` creates a fresh worker.
 */
export class WorkerConnection<W extends WorkerLike> {
  private worker: W | null = null;
  private disposed = false;
  private readonly onMessage = (event: unknown): void => {
    if (!this.disposed) this.options.onMessage((event as MessageEvent<unknown>).data);
  };
  private readonly onError = (event: unknown): void => {
    this.fail(eventMessage(event, `The ${this.options.label} failed.`));
  };
  private readonly onMessageError = (event: unknown): void => {
    this.fail(eventMessage(event, `The ${this.options.label} could not read a message.`));
  };

  constructor(private readonly options: WorkerConnectionOptions<W>) {}

  /** The live worker, if one has been created and has not failed. */
  get current(): W | null {
    return this.worker;
  }

  ensure(): W | null {
    if (this.disposed || this.worker) return this.worker;
    const worker = tryCreateWorker(this.options.create);
    if (worker) {
      worker.addEventListener('message', this.onMessage);
      worker.addEventListener('error', this.onError);
      worker.addEventListener('messageerror', this.onMessageError);
    }
    this.worker = worker;
    return worker;
  }

  /** Posts to the live worker; a throwing `postMessage` fails the connection. */
  post(worker: W, message: unknown, transfer?: Transferable[]): void {
    try {
      if (transfer) worker.postMessage(message, transfer);
      else worker.postMessage(message);
    } catch (error) {
      this.fail(eventMessage(error, `The ${this.options.label} could not receive the request.`));
    }
  }

  fail(message: string): void {
    if (this.disposed) return;
    this.release();
    this.options.onFailure(this.options.transportError(message));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.release();
  }

  private release(): void {
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    worker.removeEventListener?.('message', this.onMessage);
    worker.removeEventListener?.('error', this.onError);
    worker.removeEventListener?.('messageerror', this.onMessageError);
    try {
      worker.terminate?.();
    } catch {
      // A failed worker may already be terminated.
    }
  }
}
