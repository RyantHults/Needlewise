import { isRecord } from '../domain/guards';
import { ImportError, type ImportAnalysis, type ImportErrorCode, type ImportOverrides, type ImportProgress } from './types';

export const PATTERN_IMPORT_PROTOCOL = 'needlewise.pattern-import.v1';

type Envelope<T extends string, Extra = object> = {
  readonly protocol: typeof PATTERN_IMPORT_PROTOCOL;
  readonly type: T;
  readonly requestId: string;
} & Extra;

export type PatternImportRequest =
  | Envelope<'open', { readonly file: Blob; readonly fileName: string }>
  | Envelope<'reanalyze', { readonly overrides: ImportOverrides }>
  | Envelope<'close'>
  | Envelope<'cancel'>;

/** An `ImportError` or other failure as it crosses the worker boundary. */
export interface SerializedImportError {
  /** Absent for failures that are not an `ImportError`. */
  readonly code?: ImportErrorCode;
  readonly message: string;
}

export type PatternImportResponse =
  | Envelope<'progress', { readonly progress: ImportProgress }>
  | Envelope<'result', { readonly analysis: ImportAnalysis }>
  | Envelope<'closed'>
  | Envelope<'cancelled'>
  | Envelope<'error', { readonly error: SerializedImportError }>;

const ERROR_CODES: ReadonlySet<string> = new Set<ImportErrorCode>([
  'unsupported-format', 'unsupported-scanned-pdf', 'encrypted-pdf', 'invalid-pdf',
  'no-chart-found', 'too-large', 'unmapped-symbols', 'cancelled'
]);

/** Leading bytes handed to `findImporter`; the PDF sniffer looks up to 1024 bytes in. */
export const SNIFF_BYTES = 1024;

function isEnvelope(value: unknown): value is Record<string, unknown> & { type: string; requestId: string } {
  return isRecord(value)
    && value.protocol === PATTERN_IMPORT_PROTOCOL
    && typeof value.type === 'string'
    && typeof value.requestId === 'string';
}

function isOverrides(value: unknown): value is ImportOverrides {
  if (!isRecord(value)) return false;
  if (value.overlap !== undefined && (typeof value.overlap !== 'number' || !Number.isInteger(value.overlap))) return false;
  const roles = value.pageRoles;
  if (roles === undefined) return true;
  return isRecord(roles) && Object.values(roles).every((role) => role === 'chart' || role === 'key' || role === 'other');
}

export function isPatternImportRequest(value: unknown): value is PatternImportRequest {
  if (!isEnvelope(value)) return false;
  switch (value.type) {
    case 'open': return value.file instanceof Blob && typeof value.fileName === 'string';
    case 'reanalyze': return isOverrides(value.overrides);
    case 'close':
    case 'cancel': return true;
    default: return false;
  }
}

function isProgress(value: unknown): value is ImportProgress {
  return isRecord(value)
    && (value.stage === 'reading' || value.stage === 'analyzing')
    && typeof value.done === 'number'
    && typeof value.total === 'number';
}

export function isSerializedImportError(value: unknown): value is SerializedImportError {
  return isRecord(value)
    && typeof value.message === 'string'
    && (value.code === undefined || (typeof value.code === 'string' && ERROR_CODES.has(value.code)));
}

/** A page thumbnail is a `Blob`, which `postMessage` clones. */
function isPageSummary(value: unknown): boolean {
  return isRecord(value) && typeof value.index === 'number'
    && (value.thumbnail === undefined || value.thumbnail instanceof Blob);
}

function isAnalysis(value: unknown): value is ImportAnalysis {
  if (!isRecord(value) || typeof value.format !== 'string' || !Array.isArray(value.pages)) return false;
  if (!value.pages.every(isPageSummary)) return false;
  const chart = value.chart;
  return isRecord(chart) && chart.cells instanceof Uint16Array
    && typeof chart.width === 'number' && typeof chart.height === 'number';
}

export function isPatternImportResponse(value: unknown): value is PatternImportResponse {
  if (!isEnvelope(value)) return false;
  switch (value.type) {
    case 'progress': return isProgress(value.progress);
    case 'result': return isAnalysis(value.analysis);
    case 'closed':
    case 'cancelled': return true;
    case 'error': return isSerializedImportError(value.error);
    default: return false;
  }
}

export function serializeImportError(error: unknown): SerializedImportError {
  if (error instanceof ImportError) return { code: error.code, message: error.message };
  return { message: error instanceof Error ? error.message : 'The file could not be imported.' };
}

export function deserializeImportError(error: SerializedImportError): Error {
  return error.code ? new ImportError(error.code, error.message) : new Error(error.message);
}

export async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Cells are transferred, so they must own their whole buffer; a view onto a
 * larger buffer is copied first. Page thumbnails are Blobs, which are cloned
 * by reference to the same data rather than transferred.
 */
export function transferableAnalysis(analysis: ImportAnalysis): { analysis: ImportAnalysis; transfer: Transferable[] } {
  const { cells } = analysis.chart;
  if (cells.byteOffset === 0 && cells.byteLength === cells.buffer.byteLength) {
    return { analysis, transfer: [cells.buffer] };
  }
  const owned = cells.slice();
  return { analysis: { ...analysis, chart: { ...analysis.chart, cells: owned } }, transfer: [owned.buffer] };
}
