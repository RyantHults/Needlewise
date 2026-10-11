import type { PdfPatternInput } from './pdf-writer';

export const PDF_EXPORT_PROTOCOL = 'needlewise.pdf-export.v1';

/** What crosses the worker boundary. The label font is loaded inside the worker. */
export type PdfExportWorkerInput = Omit<PdfPatternInput, 'fontBytes'>;

export interface PdfExportRequestMessage {
  readonly protocol: typeof PDF_EXPORT_PROTOCOL;
  readonly type: 'export';
  readonly requestId: string;
  readonly input: PdfExportWorkerInput;
}

export interface PdfExportCancelMessage {
  readonly protocol: typeof PDF_EXPORT_PROTOCOL;
  readonly type: 'cancel';
  readonly requestId: string;
}

export type PdfExportWorkerResponse =
  | { readonly protocol: typeof PDF_EXPORT_PROTOCOL; readonly type: 'progress'; readonly requestId: string; readonly completed: number; readonly total: number }
  | { readonly protocol: typeof PDF_EXPORT_PROTOCOL; readonly type: 'result'; readonly requestId: string; readonly pdf: Uint8Array }
  | { readonly protocol: typeof PDF_EXPORT_PROTOCOL; readonly type: 'cancelled'; readonly requestId: string }
  | { readonly protocol: typeof PDF_EXPORT_PROTOCOL; readonly type: 'error'; readonly requestId: string; readonly message: string };
