import {
  PATTERN_IMPORT_PROTOCOL,
  deserializeImportError,
  isPatternImportResponse,
  SNIFF_BYTES,
  readBlobBytes,
  type PatternImportRequest
} from './import-protocol';
import { findImporter } from './registry';
import {
  ImportError,
  type ImportAnalysis,
  type ImportOverrides,
  type ImportProgress,
  type ImportRunOptions
} from './types';

export interface PatternImportClient {
  /** Finds the importer by sniffing the file, opens it and analyzes with no overrides. */
  open(file: Blob, fileName: string, options?: ImportRunOptions): Promise<ImportAnalysis>;
  reanalyze(overrides: ImportOverrides, options?: ImportRunOptions): Promise<ImportAnalysis>;
  close(): Promise<void>;
  /** Terminates the worker; pending requests reject as cancelled. */
  dispose(): void;
}

export interface PatternImportWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message' | 'error', listener: (event: unknown) => void): void;
  terminate?(): void;
}

export interface PatternImportClientOptions {
  readonly workerFactory?: () => PatternImportWorkerLike | null;
  readonly requestIdFactory?: () => string;
  /** Runs requests on the calling thread when no worker can be created. */
  readonly fallback?: () => PatternImportFallback;
}

/** The main-thread stand-in for the worker; same operations, no messages. */
export interface PatternImportFallback {
  open(file: Blob, fileName: string, options: ImportRunOptions): Promise<ImportAnalysis>;
  reanalyze(overrides: ImportOverrides, options: ImportRunOptions): Promise<ImportAnalysis>;
  close(): Promise<void>;
}

interface Pending {
  readonly resolve: (value: ImportAnalysis | undefined) => void;
  readonly reject: (error: unknown) => void;
  readonly onProgress: ((progress: ImportProgress) => void) | undefined;
}

let requestCounter = 0;
const defaultRequestId = (): string => `pattern-import-${String(Date.now())}-${String(requestCounter++)}`;

const cancelledError = (): ImportError => new ImportError('cancelled', 'The import was cancelled.');

function createDefaultWorker(): PatternImportWorkerLike | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('../workers/pattern-import.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

function createDefaultFallback(): PatternImportFallback {
  let session: import('./types').ImportSession | null = null;
  const drop = async (): Promise<void> => {
    const previous = session;
    session = null;
    await previous?.close();
  };
  return {
    async open(file, fileName, options) {
      await drop();
      const bytes = await readBlobBytes(file);
      const importer = findImporter(bytes.subarray(0, SNIFF_BYTES));
      if (!importer) throw new ImportError('unsupported-format', 'This file type is not supported.');
      const opened = await importer.open(bytes, { ...options, fileName });
      const replaced = session;
      session = opened;
      await replaced?.close();
      return opened.analyze(undefined, options);
    },
    reanalyze(overrides, options) {
      if (!session) return Promise.reject(new ImportError('unsupported-format', 'No file is open.'));
      return session.analyze(overrides, options);
    },
    close: drop
  };
}

export function createPatternImportClient(clientOptions: PatternImportClientOptions = {}): PatternImportClient {
  const pending = new Map<string, Pending>();
  let worker: PatternImportWorkerLike | null = null;
  let fallback: PatternImportFallback | null = null;
  let disposed = false;

  function failAll(error: unknown): void {
    const entries = [...pending.values()];
    pending.clear();
    for (const entry of entries) entry.reject(error);
  }

  function ensureWorker(): PatternImportWorkerLike | null {
    if (worker) return worker;
    const created = (clientOptions.workerFactory ?? createDefaultWorker)();
    if (!created) return null;
    created.addEventListener('message', (event) => {
      const data = (event as MessageEvent<unknown>).data;
      if (!isPatternImportResponse(data)) return;
      const entry = pending.get(data.requestId);
      if (!entry) return;
      if (data.type === 'progress') { entry.onProgress?.(data.progress); return; }
      pending.delete(data.requestId);
      if (data.type === 'result') entry.resolve(data.analysis);
      else if (data.type === 'closed') entry.resolve(undefined);
      else if (data.type === 'cancelled') entry.reject(cancelledError());
      else entry.reject(deserializeImportError(data.error));
    });
    created.addEventListener('error', (event) => {
      const message = (event as { message?: string }).message || 'The import worker failed.';
      created.terminate?.();
      if (worker === created) worker = null;
      failAll(new Error(message));
    });
    worker = created;
    return created;
  }

  function request(
    build: (requestId: string) => PatternImportRequest,
    viaFallback: (fb: PatternImportFallback, signal: AbortSignal) => Promise<ImportAnalysis | undefined>,
    options: ImportRunOptions = {}
  ): Promise<ImportAnalysis | undefined> {
    if (disposed) return Promise.reject(new Error('The import client was disposed.'));
    if (options.signal?.aborted) return Promise.reject(cancelledError());
    const requestId = (clientOptions.requestIdFactory ?? defaultRequestId)();
    const target = ensureWorker();
    const controller = new AbortController();
    return new Promise<ImportAnalysis | undefined>((resolve, reject) => {
      const onAbort = (): void => {
        if (!pending.delete(requestId)) return;
        controller.abort();
        target?.postMessage({ protocol: PATTERN_IMPORT_PROTOCOL, type: 'cancel', requestId } satisfies PatternImportRequest);
        reject(cancelledError());
      };
      const cleanup = (): void => { options.signal?.removeEventListener('abort', onAbort); };
      pending.set(requestId, {
        resolve: (value) => { cleanup(); resolve(value); },
        reject: (error) => { cleanup(); reject(error instanceof Error ? error : new Error(String(error))); },
        onProgress: options.onProgress
      });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (target) {
        try {
          target.postMessage(build(requestId));
        } catch (error) {
          pending.get(requestId)?.reject(error);
          pending.delete(requestId);
        }
        return;
      }
      fallback ??= (clientOptions.fallback ?? createDefaultFallback)();
      viaFallback(fallback, controller.signal).then(
        (value) => { const entry = pending.get(requestId); if (entry) { pending.delete(requestId); entry.resolve(value); } },
        (error: unknown) => {
          const entry = pending.get(requestId);
          if (!entry) return;
          pending.delete(requestId);
          entry.reject(controller.signal.aborted || (error instanceof Error && error.name === 'AbortError') ? cancelledError() : error);
        }
      );
    });
  }

  const runOptions = (options: ImportRunOptions | undefined, signal: AbortSignal): ImportRunOptions => ({
    signal,
    ...(options?.onProgress ? { onProgress: options.onProgress } : {})
  });

  return {
    async open(file, fileName, options) {
      const result = await request(
        (requestId) => ({ protocol: PATTERN_IMPORT_PROTOCOL, type: 'open', requestId, file, fileName }),
        (fb, signal) => fb.open(file, fileName, runOptions(options, signal)),
        options
      );
      if (!result) throw new Error('The import produced no result.');
      return result;
    },
    async reanalyze(overrides, options) {
      const result = await request(
        (requestId) => ({ protocol: PATTERN_IMPORT_PROTOCOL, type: 'reanalyze', requestId, overrides }),
        (fb, signal) => fb.reanalyze(overrides, runOptions(options, signal)),
        options
      );
      if (!result) throw new Error('The import produced no result.');
      return result;
    },
    async close() {
      await request(
        (requestId) => ({ protocol: PATTERN_IMPORT_PROTOCOL, type: 'close', requestId }),
        async (fb) => { await fb.close(); return undefined; }
      );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const terminating = worker;
      worker = null;
      failAll(cancelledError());
      terminating?.terminate?.();
      void fallback?.close();
    }
  };
}
