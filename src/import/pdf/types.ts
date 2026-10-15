// PDF page primitives shared by the extraction, layout and key stages.
// All geometry is in page points with the origin at the top-left and y down,
// so it matches the symbol pool's orientation.
import type { ImportColor, ImportWarning } from '../types';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A symbol candidate: a font glyph with ink, or a filled path that is not an axis-aligned rectangle. */
export interface PdfMark {
  readonly kind: 'glyph' | 'path';
  readonly bounds: Rect;
  /** Outline hash; equal outlines give equal keys regardless of size or position. */
  readonly symbolKey: string;
  /** Normalized outline (see `outline.ts`): unit box, y down. */
  readonly outlineD: string;
  /** From the font's ToUnicode map, glyph marks only. */
  readonly unicode?: string;
  readonly color: ImportColor;
}

export interface PdfStroke {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly width: number;
  readonly color: ImportColor;
}

/** A filled axis-aligned rectangle (cell backgrounds, key swatches). */
export interface PdfFillRect {
  readonly bounds: Rect;
  readonly color: ImportColor;
}

/** Readable text from `getTextContent`, for thread codes, names and rulers. */
export interface PdfTextRun {
  readonly text: string;
  readonly bounds: Rect;
  readonly fontSize: number;
}

export interface PdfPagePrimitives {
  /** Zero-based. */
  readonly pageIndex: number;
  readonly width: number;
  readonly height: number;
  readonly marks: readonly PdfMark[];
  /** Axis-aligned stroked segments only; a stroked rectangle yields four. */
  readonly strokes: readonly PdfStroke[];
  readonly fills: readonly PdfFillRect[];
  readonly text: readonly PdfTextRun[];
  /** Fraction (0..1) of the page area covered by painted images. */
  readonly imageCoverage: number;
}

export interface PdfGrid {
  /** Cell boundary x positions, ascending; `columns + 1` entries. */
  readonly xs: readonly number[];
  /** Cell boundary y positions, ascending; `rows + 1` entries. */
  readonly ys: readonly number[];
  readonly columns: number;
  readonly rows: number;
  /** Mean cell pitch in points. */
  readonly pitch: number;
  readonly bounds: Rect;
  /** Spacing of heavier lines in cells (usually 10), if detected. */
  readonly majorEvery?: number;
}

export interface ChartPageSymbol {
  readonly outlineD: string;
  readonly unicode?: string;
}

/** One chart page's cells, before multi-page assembly. */
export interface ChartPageCells {
  readonly pageIndex: number;
  readonly grid: PdfGrid;
  readonly columns: number;
  readonly rows: number;
  /** Row-major symbol keys; null is an empty cell. */
  readonly keys: readonly (string | null)[];
  /** Row-major cell background fills; null when unfilled or white. */
  readonly fills: readonly (ImportColor | null)[];
  readonly symbols: ReadonlyMap<string, ChartPageSymbol>;
  /** Chart coordinates of this page's top-left cell, from ruler numbers, when printed. */
  readonly rulerOffset?: { readonly x: number; readonly y: number };
  readonly warnings: readonly ImportWarning[];
}

export interface AssembledCells {
  readonly width: number;
  readonly height: number;
  readonly keys: readonly (string | null)[];
  readonly fills: readonly (ImportColor | null)[];
  readonly symbols: ReadonlyMap<string, ChartPageSymbol>;
  readonly overlap: number;
  readonly detectedOverlap: number;
  /** Top-left placement of each chart page, keyed by page index. */
  readonly placements: ReadonlyMap<number, { readonly x: number; readonly y: number }>;
  readonly warnings: readonly ImportWarning[];
}
