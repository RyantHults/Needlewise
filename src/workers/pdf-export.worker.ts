import { isRecord } from '../domain';
import {
  PDF_EXPORT_PROTOCOL,
  type PdfExportRequestMessage,
  type PdfExportWorkerResponse
} from '../export/pdf-export-protocol';
import { loadPdfLabelFont } from '../export/pdf-font';
import { writePatternPdf, type PdfPatternInput, type PdfWriteOptions } from '../export/pdf-writer';
import { isAbortError } from './abort';

interface PdfExportWorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: PdfExportWorkerResponse, transfer?: Transferable[]): void;
}

export interface PdfExportWorkerDependencies {
  readonly loadFont: () => Promise<Uint8Array>;
  readonly write: (input: PdfPatternInput, options: PdfWriteOptions) => Promise<Uint8Array>;
}

const defaultDependencies: PdfExportWorkerDependencies = {
  loadFont: () => loadPdfLabelFont(),
  write: writePatternPdf
};

function isCancelled(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || isAbortError(error);
}

/** Handle one export or cancel message without depending on a concrete WorkerGlobalScope. */
export function handlePdfExportWorkerMessage(
  value: unknown,
  post: (message: PdfExportWorkerResponse, transfer?: Transferable[]) => void,
  active: Map<string, AbortController> = new Map(),
  dependencies: PdfExportWorkerDependencies = defaultDependencies
): void {
  if (!isRecord(value) || value.protocol !== PDF_EXPORT_PROTOCOL || typeof value.requestId !== 'string') return;
  const requestId = value.requestId;
  if (value.type === 'cancel') {
    active.get(requestId)?.abort();
    return;
  }
  if (value.type !== 'export' || !isRecord(value.input)) return;
  if (active.has(requestId)) {
    post({ protocol: PDF_EXPORT_PROTOCOL, type: 'error', requestId, message: 'The export request is already running.' });
    return;
  }
  const request = value as unknown as PdfExportRequestMessage;
  const controller = new AbortController();
  active.set(requestId, controller);
  void (async () => {
    try {
      const fontBytes = await dependencies.loadFont();
      if (controller.signal.aborted) throw new DOMException('cancelled', 'AbortError');
      const pdf = await dependencies.write({ ...request.input, fontBytes }, {
        signal: controller.signal,
        onProgress: ({ completed, total }) => {
          post({ protocol: PDF_EXPORT_PROTOCOL, type: 'progress', requestId, completed, total });
        }
      });
      if (controller.signal.aborted) post({ protocol: PDF_EXPORT_PROTOCOL, type: 'cancelled', requestId });
      else post({ protocol: PDF_EXPORT_PROTOCOL, type: 'result', requestId, pdf }, [pdf.buffer as ArrayBuffer]);
    } catch (error) {
      if (isCancelled(error, controller.signal)) post({ protocol: PDF_EXPORT_PROTOCOL, type: 'cancelled', requestId });
      else post({ protocol: PDF_EXPORT_PROTOCOL, type: 'error', requestId, message: error instanceof Error ? error.message : 'The PDF could not be created.' });
    } finally {
      active.delete(requestId);
    }
  })();
}

function installPdfExportWorker(scope: PdfExportWorkerScope): void {
  const active = new Map<string, AbortController>();
  scope.addEventListener('message', (event) => {
    handlePdfExportWorkerMessage(event.data, (message, transfer) => { scope.postMessage(message, transfer); }, active);
  });
}

function isWorkerScope(value: unknown): value is PdfExportWorkerScope {
  return isRecord(value)
    && typeof value.postMessage === 'function'
    && typeof value.addEventListener === 'function'
    && !('document' in value);
}

const globalScope: unknown = typeof globalThis === 'undefined' ? undefined : globalThis;
if (isWorkerScope(globalScope)) installPdfExportWorker(globalScope);
