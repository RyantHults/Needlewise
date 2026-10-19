// Format-agnostic import model. Every importer (PDF today; OXS, PAT and
// others later) reduces its source to an `ImportedChart`, so mapping,
// document building, the worker protocol and the review UI are shared.

/** Colors are `#rrggbb`, lowercase. */
export type ImportColor = `#${string}`;

export interface ImportedSymbol {
  /** Stable identity of the mark within one import (an outline hash for PDFs). */
  readonly key: string;
  /** Outline as an SVG path in a unit box, y down, origin top-left. */
  readonly outlineD: string;
  /** Unicode the source font claims for the mark, when it has one. */
  readonly unicode?: string;
  /** Cells in the assembled chart that carry this symbol. */
  readonly count: number;
  /** Dominant cell background fill under this symbol, for colored charts. */
  readonly fillColor?: ImportColor;
}

export interface ImportedKeyEntry {
  readonly symbolKey: string;
  /** Thread brand as printed, normalized to upper case (`DMC`, `ANCHOR`). */
  readonly brand?: string;
  /** Thread code as printed (`310`, `B5200`, `Ecru`). */
  readonly code?: string;
  readonly name?: string;
  /** Swatch color printed beside the key row, if any. */
  readonly color?: ImportColor;
  /** Every code of a blended row (`310+413`); `code` holds the first. */
  readonly blendCodes?: readonly string[];
}

export type ImportWarningCode =
  | 'multi-symbol-cell'
  | 'symbol-missing-from-key'
  | 'key-entry-unused'
  | 'unsupported-brand'
  | 'blend-not-supported'
  | 'overlap-mismatch'
  | 'uneven-page-grid'
  | 'unknown-thread-code';

export interface ImportWarning {
  readonly code: ImportWarningCode;
  readonly message: string;
  /** Zero-based source page. */
  readonly page?: number;
  /** Cell in the assembled chart. */
  readonly cell?: { readonly x: number; readonly y: number };
  readonly symbolKey?: string;
}

export interface ImportedChart {
  readonly width: number;
  readonly height: number;
  /** Row-major, `width * height`; a 1-based index into `symbols`, 0 is empty. */
  readonly cells: Uint16Array;
  readonly symbols: readonly ImportedSymbol[];
  readonly key: readonly ImportedKeyEntry[];
  readonly warnings: readonly ImportWarning[];
  readonly title?: string;
  readonly fabricCount?: number;
}

export type ImportPageRole = 'chart' | 'key' | 'other';

export interface ImportPageSummary {
  /** Zero-based. */
  readonly index: number;
  readonly role: ImportPageRole;
  readonly detectedRole: ImportPageRole;
  /** Page size in points. */
  readonly width: number;
  readonly height: number;
  /** Detected cell lattice, chart pages only. */
  readonly grid?: { readonly columns: number; readonly rows: number };
  /** Placement of this page's cells in the assembled chart, chart pages only. */
  readonly placement?: { readonly x: number; readonly y: number };
  /** Small PNG render of the page, when the platform can render off-screen. */
  readonly thumbnail?: Blob;
}

export interface ImportAnalysis {
  /** The importer `id` that produced this analysis. */
  readonly format: string;
  readonly pages: readonly ImportPageSummary[];
  /** Rows/columns repeated between adjacent chart pages (0-3). */
  readonly overlap: number;
  readonly detectedOverlap: number;
  readonly chart: ImportedChart;
}

export interface ImportOverrides {
  readonly pageRoles?: Readonly<Record<number, ImportPageRole>>;
  readonly overlap?: number;
}

export interface ImportProgress {
  readonly stage: 'reading' | 'analyzing';
  readonly done: number;
  readonly total: number;
}

export interface ImportRunOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ImportProgress) => void;
}

/**
 * An opened source. Expensive parsing happens once in `open`; `analyze` can
 * run again with user overrides against the cached primitives.
 */
export interface ImportSession {
  analyze(overrides?: ImportOverrides, options?: ImportRunOptions): Promise<ImportAnalysis>;
  close(): Promise<void>;
}

export interface PatternImporter {
  readonly id: string;
  readonly label: string;
  /** File extensions (with dot) and MIME types, for `<input accept>`. */
  readonly accept: readonly string[];
  /** True when the leading bytes belong to this format. */
  sniff(head: Uint8Array): boolean;
  open(bytes: Uint8Array, options?: ImportRunOptions & { readonly fileName?: string }): Promise<ImportSession>;
}

export type ImportErrorCode =
  | 'unsupported-format'
  | 'unsupported-scanned-pdf'
  | 'encrypted-pdf'
  | 'invalid-pdf'
  | 'no-chart-found'
  | 'too-large'
  | 'too-many-colors'
  | 'unmapped-symbols'
  | 'cancelled';

export class ImportError extends Error {
  constructor(readonly code: ImportErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ImportError';
  }
}

export function importCancelledError(): ImportError {
  return new ImportError('cancelled', 'The import was cancelled.');
}

export function throwIfImportCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw importCancelledError();
}

/** How one imported symbol becomes a palette entry; decided in review. */
export interface SymbolMapping {
  readonly symbolKey: string;
  /** DMC code to use; wins over `color` when it resolves. */
  readonly catalogCode?: string;
  /** Custom color when there is no catalog thread. */
  readonly color?: ImportColor;
  /** Pool slug override; otherwise the build picks one. */
  readonly symbolSlug?: string;
}

export type MappingStatus = 'matched' | 'guessed' | 'unmapped';

export interface SymbolMappingProposal extends SymbolMapping {
  readonly status: MappingStatus;
  /** Why the proposal is guessed or unmapped, for the review UI. */
  readonly reason?: string;
}
