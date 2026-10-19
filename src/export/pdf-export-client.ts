import { isAbortError } from '../workers/abort';
import { ExportCancelledError } from './cancellation';
import {
  PDF_EXPORT_PROTOCOL,
  type PdfExportCancelMessage,
  type PdfExportRequestMessage,
  type PdfExportWorkerInput,
  type PdfExportWorkerResponse
} from './pdf-export-protocol';
import type { PdfProgress } from './pdf-writer';

export interface PdfExportWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message' | 'error', listener: (event: unknown) => void): void;
  terminate?(): void;
}

export interface PdfExportClientOptions {
  readonly workerFactory?: () => PdfExportWorkerLike | null;
  readonly requestIdFactory?: () => string;
  /** Runs the export on the calling thread when no worker can be created. */
  readonly fallback?: (input: PdfExportWorkerInput, options: { signal: AbortSignal; onProgress: (progress: PdfProgress) => void }) => Promise<Uint8Array>;
}

export interface PdfExportRunOptions {
  readonly onProgress?: (progress: PdfProgress) => void;
  readonly signal?: AbortSignal;
}

export interface PdfExportJob {
  readonly promise: Promise<Uint8Array>;
  cancel(): void;
}

export class PdfExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfExportError';
  }
}

let requestCounter = 0;
const defaultRequestId = (): string => `pdf-export-${String(Date.now())}-${String(requestCounter++)}`;

function createDefaultWorker(): PdfExportWorkerLike | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('../workers/pdf-export.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

async function defaultFallback(
  input: PdfExportWorkerInput,
  options: { signal: AbortSignal; onProgress: (progress: PdfProgress) => void }
): Promise<Uint8Array> {
  const [{ writePatternPdf }, { loadPdfLabelFont }] = await Promise.all([import('./pdf-writer'), import('./pdf-font')]);
  return writePatternPdf({ ...input, fontBytes: await loadPdfLabelFont() }, options);
}

/**
 * The worker receives copies of the document arrays, so the live document is
 * never detached by the transfer, and completion planes are never sent.
 */
export function prepareWorkerInput(input: PdfExportWorkerInput): { input: PdfExportWorkerInput; transfer: Transferable[] } {
  const { document } = input;
  const store = document.backstitches;
  const copy = {
    width: document.width,
    height: document.height,
    kind: document.kind.slice(),
    colors: document.colors.slice(),
    backstitches: {
      ids: store.ids.slice(),
      x1: store.x1.slice(),
      y1: store.y1.slice(),
      x2: store.x2.slice(),
      y2: store.y2.slice(),
      colors: store.colors.slice(),
      completed: new Uint8Array(0)
    },
    palette: document.palette,
    ...(document.canvasMask ? { canvasMask: document.canvasMask.slice() } : {})
  };
  const coverImagePng = input.coverImagePng?.slice();
  const transfer: Transferable[] = [
    copy.kind.buffer, copy.colors.buffer,
    copy.backstitches.ids.buffer, copy.backstitches.x1.buffer, copy.backstitches.y1.buffer,
    copy.backstitches.x2.buffer, copy.backstitches.y2.buffer, copy.backstitches.colors.buffer
  ];
  if (copy.canvasMask) transfer.push(copy.canvasMask.buffer);
  if (coverImagePng) transfer.push(coverImagePng.buffer);
  return { input: { ...input, document: copy, ...(coverImagePng ? { coverImagePng } : {}) }, transfer };
}

/** Start an export. Cancel with the returned `cancel` or the options' `signal`. */
export function startPdfExport(input: PdfExportWorkerInput, options: PdfExportRunOptions & PdfExportClientOptions = {}): PdfExportJob {
  const requestId = (options.requestIdFactory ?? defaultRequestId)();
  const controller = new AbortController();
  let settle: { resolve: (pdf: Uint8Array) => void; reject: (error: unknown) => void } | undefined;
  const promise = new Promise<Uint8Array>((resolve, reject) => { settle = { resolve, reject }; });
  let worker: PdfExportWorkerLike | null = null;
  let finished = false;

  const finish = (outcome: () => void): void => {
    if (finished) return;
    finished = true;
    options.signal?.removeEventListener('abort', cancel);
    outcome();
    worker?.terminate?.();
  };

  function cancel(): void {
    if (finished) return;
    controller.abort();
    const message: PdfExportCancelMessage = { protocol: PDF_EXPORT_PROTOCOL, type: 'cancel', requestId };
    worker?.postMessage(message);
    finish(() => { settle?.reject(new ExportCancelledError()); });
  }

  if (options.signal?.aborted) {
    finished = true;
    settle?.reject(new ExportCancelledError());
    return { promise, cancel: () => undefined };
  }
  options.signal?.addEventListener('abort', cancel, { once: true });

  worker = (options.workerFactory ?? createDefaultWorker)();
  if (!worker) {
    const run = options.fallback ?? defaultFallback;
    run(input, { signal: controller.signal, onProgress: (progress) => { if (!finished) options.onProgress?.(progress); } })
      .then((pdf) => { finish(() => { settle?.resolve(pdf); }); },
        (error: unknown) => {
          finish(() => {
            settle?.reject(controller.signal.aborted || isAbortError(error)
              ? new ExportCancelledError()
              : error);
          });
        });
    return { promise, cancel };
  }

  worker.addEventListener('message', (event) => {
    const data = (event as MessageEvent<unknown>).data as PdfExportWorkerResponse | undefined;
    if (!data || data.protocol !== PDF_EXPORT_PROTOCOL || data.requestId !== requestId) return;
    if (data.type === 'progress') {
      if (!finished) options.onProgress?.({ completed: data.completed, total: data.total });
    } else if (data.type === 'result') finish(() => { settle?.resolve(data.pdf); });
    else if (data.type === 'cancelled') finish(() => { settle?.reject(new ExportCancelledError()); });
    else finish(() => { settle?.reject(new PdfExportError(data.message)); });
  });
  worker.addEventListener('error', (event) => {
    finish(() => { settle?.reject(new PdfExportError((event as { message?: string }).message || 'The PDF export worker failed.')); });
  });

  const prepared = prepareWorkerInput(input);
  const message: PdfExportRequestMessage = { protocol: PDF_EXPORT_PROTOCOL, type: 'export', requestId, input: prepared.input };
  try {
    worker.postMessage(message, prepared.transfer);
  } catch (error) {
    finish(() => { settle?.reject(new PdfExportError(error instanceof Error ? error.message : 'The export could not be sent to the worker.')); });
  }
  return { promise, cancel };
}
