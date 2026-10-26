import { isRecord } from '../domain';
import {
  PDF_EXPORT_PROTOCOL,
  type PdfExportRequestMessage,
  type PdfExportWorkerResponse
} from '../export/pdf-export-protocol';
import { loadPdfLabelFont } from '../export/pdf-font';
import { writePatternPdf, type PdfPatternInput, type PdfWriteOptions } from '../export/pdf-writer';
import { bootWorker, runAbortable, type WorkerScope } from './runtime';

export interface PdfExportWorkerDependencies {
  readonly loadFont: () => Promise<Uint8Array>;
  readonly write: (input: PdfPatternInput, options: PdfWriteOptions) => Promise<Uint8Array>;
}

const defaultDependencies: PdfExportWorkerDependencies = {
  loadFont: () => loadPdfLabelFont(),
  write: writePatternPdf
};

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
  runAbortable(active, requestId, async (signal) => {
    const fontBytes = await dependencies.loadFont();
    if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
    const pdf = await dependencies.write({ ...request.input, fontBytes }, {
      signal,
      onProgress: ({ completed, total }) => {
        post({ protocol: PDF_EXPORT_PROTOCOL, type: 'progress', requestId, completed, total });
      }
    });
    if (signal.aborted) post({ protocol: PDF_EXPORT_PROTOCOL, type: 'cancelled', requestId });
    else post({ protocol: PDF_EXPORT_PROTOCOL, type: 'result', requestId, pdf }, [pdf.buffer as ArrayBuffer]);
  }, {
    cancelled: () => { post({ protocol: PDF_EXPORT_PROTOCOL, type: 'cancelled', requestId }); },
    failed: (error) => {
      post({ protocol: PDF_EXPORT_PROTOCOL, type: 'error', requestId, message: error instanceof Error ? error.message : 'The PDF could not be created.' });
    }
  });
}

function installPdfExportWorker(scope: WorkerScope<PdfExportWorkerResponse>): void {
  const active = new Map<string, AbortController>();
  scope.addEventListener('message', (event) => {
    handlePdfExportWorkerMessage(event.data, (message, transfer) => { scope.postMessage(message, transfer); }, active);
  });
}

bootWorker(installPdfExportWorker);
