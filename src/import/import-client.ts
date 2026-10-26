import {
  PATTERN_IMPORT_PROTOCOL,
  deserializeImportError,
  isPatternImportResponse,
  SNIFF_BYTES,
  readBlobBytes,
  type PatternImportRequest
} from './import-protocol';
import { isAbortError } from '../workers/abort';
import { createDeferred, createRequestId, eventMessage, linkAbort, tryCreateWorker, type WorkerLike } from '../workers/client';
import { findImporter } from './registry';
import {
  ImportError,
  importCancelledError,
  type ImportAnalysis,
  type ImportOverrides,
  type ImportProgress,
  type ImportRunOptions
} from './types';

export interface PatternImportClient {
  /** Finds the importer by sniffing the file, opens it and analyzes with no overrides. */
  open(file: Blob, fileName: string, options?: ImportRunOptions): Promise<ImportAnalysis>;
  reanalyze(overrides: ImportOverrides, options?: ImportRunOptions): Promise<ImportAnalysis>;
  /** Terminates the worker; pending requests reject as cancelled. */
  dispose(): void;
}

export interface PatternImportClientOptions {
  readonly workerFactory?: () => WorkerLike | null;
  /** Runs requests on the calling thread when no worker can be created. */
  readonly fallback?: () => PatternImportFallback;
}

/** The main-thread stand-in for the worker; same operations, no messages. */
export interface PatternImportFallback {
  open(file: Blob, fileName: string, options: ImportRunOptions): Promise<ImportAnalysis>;
  reanalyze(overrides: ImportOverrides, options: ImportRunOptions): Promise<ImportAnalysis>;
  /** Releases the open session. */
  close(): Promise<void>;
}

interface Pending {
  readonly resolve: (value: ImportAnalysis) => void;
  readonly reject: (error: unknown) => void;
  readonly onProgress: ((progress: ImportProgress) => void) | undefined;
}

function createDefaultWorker(): WorkerLike {
  return new Worker(new URL('../workers/pattern-import.worker.ts', import.meta.url), { type: 'module' });
}

function createDefaultFallback(): PatternImportFallback {
  let session: import('./types').ImportSession | null = null;
  return {
    async open(file, fileName, options) {
      const bytes = await readBlobBytes(file);
      const importer = findImporter(bytes.subarray(0, SNIFF_BYTES));
      if (!importer) throw new ImportError('unsupported-format', 'This file type is not supported.');
      session = await importer.open(bytes, { ...options, fileName });
      return session.analyze(undefined, options);
    },
    reanalyze(overrides, options) {
      if (!session) return Promise.reject(new ImportError('unsupported-format', 'No file is open.'));
      return session.analyze(overrides, options);
    },
    async close() {
      const open = session;
      session = null;
      await open?.close();
    }
  };
}

export function createPatternImportClient(clientOptions: PatternImportClientOptions = {}): PatternImportClient {
  const pending = new Map<string, Pending>();
  let worker: WorkerLike | null = null;
  let fallback: PatternImportFallback | null = null;
  let disposed = false;

  function failAll(error: unknown): void {
    const entries = [...pending.values()];
    pending.clear();
    for (const entry of entries) entry.reject(error);
  }

  function failWorker(failed: WorkerLike, message: string): void {
    failed.terminate?.();
    if (worker === failed) worker = null;
    failAll(new Error(message));
  }

  function ensureWorker(): WorkerLike | null {
    if (worker) return worker;
    const created = tryCreateWorker(clientOptions.workerFactory ?? createDefaultWorker);
    if (!created) return null;
    created.addEventListener('message', (event) => {
      const data = (event as MessageEvent<unknown>).data;
      if (!isPatternImportResponse(data)) return;
      const entry = pending.get(data.requestId);
      if (!entry) return;
      if (data.type === 'progress') { entry.onProgress?.(data.progress); return; }
      pending.delete(data.requestId);
      if (data.type === 'result') entry.resolve(data.analysis);
      else if (data.type === 'cancelled') entry.reject(importCancelledError());
      else entry.reject(deserializeImportError(data.error));
    });
    created.addEventListener('error', (event) => { failWorker(created, eventMessage(event, 'The import worker failed.')); });
    created.addEventListener('messageerror', (event) => { failWorker(created, eventMessage(event, 'The import worker could not read a message.')); });
    worker = created;
    return created;
  }

  function request(
    build: (requestId: string) => PatternImportRequest,
    viaFallback: (fb: PatternImportFallback, signal: AbortSignal) => Promise<ImportAnalysis>,
    options: ImportRunOptions = {}
  ): Promise<ImportAnalysis> {
    if (disposed) return Promise.reject(new Error('The import client was disposed.'));
    if (options.signal?.aborted) return Promise.reject(importCancelledError());
    const requestId = createRequestId('pattern-import');
    const target = ensureWorker();
    const controller = new AbortController();
    const { promise, resolve, reject } = createDeferred<ImportAnalysis>();
    const cleanup = linkAbort(options.signal, () => {
      if (!pending.delete(requestId)) return;
      controller.abort();
      target?.postMessage({ protocol: PATTERN_IMPORT_PROTOCOL, type: 'cancel', requestId } satisfies PatternImportRequest);
      reject(importCancelledError());
    });
    pending.set(requestId, {
      resolve: (value) => { cleanup(); resolve(value); },
      reject: (error) => { cleanup(); reject(error instanceof Error ? error : new Error(String(error))); },
      onProgress: options.onProgress
    });
    if (target) {
      try {
        target.postMessage(build(requestId));
      } catch (error) {
        pending.get(requestId)?.reject(error);
        pending.delete(requestId);
      }
      return promise;
    }
    fallback ??= (clientOptions.fallback ?? createDefaultFallback)();
    viaFallback(fallback, controller.signal).then(
      (value) => { const entry = pending.get(requestId); if (entry) { pending.delete(requestId); entry.resolve(value); } },
      (error: unknown) => {
        const entry = pending.get(requestId);
        if (!entry) return;
        pending.delete(requestId);
        entry.reject(controller.signal.aborted || isAbortError(error) ? importCancelledError() : error);
      }
    );
    return promise;
  }

  const runOptions = (options: ImportRunOptions | undefined, signal: AbortSignal): ImportRunOptions => ({
    signal,
    ...(options?.onProgress ? { onProgress: options.onProgress } : {})
  });

  return {
    open(file, fileName, options) {
      return request(
        (requestId) => ({ protocol: PATTERN_IMPORT_PROTOCOL, type: 'open', requestId, file, fileName }),
        (fb, signal) => fb.open(file, fileName, runOptions(options, signal)),
        options
      );
    },
    reanalyze(overrides, options) {
      return request(
        (requestId) => ({ protocol: PATTERN_IMPORT_PROTOCOL, type: 'reanalyze', requestId, overrides }),
        (fb, signal) => fb.reanalyze(overrides, runOptions(options, signal)),
        options
      );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const terminating = worker;
      worker = null;
      failAll(importCancelledError());
      terminating?.terminate?.();
      void fallback?.close();
    }
  };
}
