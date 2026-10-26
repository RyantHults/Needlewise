import { isRecord } from '../domain/guards';
import { isAbortError } from './abort';

export interface WorkerScope<Response> {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: Response, transfer?: Transferable[]): void;
}

export function isWorkerScope<Response>(value: unknown): value is WorkerScope<Response> {
  return isRecord(value)
    && typeof value.postMessage === 'function'
    && typeof value.addEventListener === 'function'
    && !('document' in value);
}

/** Install a worker entrypoint on the global scope, and do nothing on the main thread or under test. */
export function bootWorker<Response>(install: (scope: WorkerScope<Response>) => void): void {
  const globalScope: unknown = typeof globalThis === 'undefined' ? undefined : globalThis;
  if (isWorkerScope<Response>(globalScope)) install(globalScope);
}

/**
 * Run one request under an AbortController registered in `active` for its duration, so a cancel
 * message can abort it by id. An abort reports through `cancelled`; any other failure through `failed`.
 */
export function runAbortable(
  active: Map<string, AbortController>,
  id: string,
  run: (signal: AbortSignal) => Promise<void>,
  { cancelled, failed }: { cancelled: () => void; failed: (error: unknown) => void }
): void {
  const controller = new AbortController();
  active.set(id, controller);
  void run(controller.signal)
    .catch((error: unknown) => {
      if (controller.signal.aborted || isAbortError(error)) cancelled();
      else failed(error);
    })
    .finally(() => { active.delete(id); });
}
