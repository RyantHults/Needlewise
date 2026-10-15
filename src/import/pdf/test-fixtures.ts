// PDF builders for import tests. Nothing here ships: tests build every PDF
// they read, so no third-party pattern is checked in.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { PDFDict, PDFDocument, PDFName, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { DEFAULT_CATALOG_DEFINITION, createCatalogReference, getDmcColor } from '../../catalog';
import { CellKind, computePatternMetrics, createDocument, type PatternDocument } from '../../domain';
import { DEFAULT_EXPORT_SETTINGS, type ExportSettings } from '../../export/export-settings';
import { writePatternPdf } from '../../export/pdf-writer';
import type { ImportColor } from '../types';

// Vitest's jsdom URL is not a file URL, so fonts resolve from the repo root.
export const fixtureFont = (file: string): Uint8Array => new Uint8Array(readFileSync(resolve(process.cwd(), 'fonts', file)));

export const LABEL_FONT = 'LibertinusMath-Regular.ttf';
export const SYMBOL_FONT = 'NotoSansSymbols2-Regular.ttf';

// --- Needlewise round trip ----------------------------------------------

/**
 * A full-stitch document whose palette is the given DMC codes, in order, on
 * the fixture symbol pool. `cell(x, y)` returns a 1-based palette id, or 0.
 */
export function dmcDocument(width: number, height: number, codes: readonly string[], cell: (x: number, y: number) => number): PatternDocument {
  const document = createDocument({
    catalog: DEFAULT_CATALOG_DEFINITION.association,
    width,
    height,
    palette: codes.map((code, index) => {
      const record = getDmcColor(code);
      if (!record) throw new Error(`DMC ${code} is not in the catalog.`);
      return { id: index + 1, name: record.name, color: record.hex, catalog: createCatalogReference(DEFAULT_CATALOG_DEFINITION, record) };
    })
  });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const id = cell(x, y);
      if (id === 0) continue;
      const index = y * width + x;
      document.kind[index] = CellKind.Full;
      document.colors[index * 4] = id;
    }
  }
  return document;
}

/** Write a document the way the app exports it. */
export function writeNeedlewisePdf(document: PatternDocument, name: string, settings: Partial<ExportSettings> = {}): Promise<Uint8Array> {
  return writePatternPdf({
    document,
    metrics: computePatternMetrics(document, { aidaCount: 14, strands: 2, waste: 0.1 }),
    settings: { ...DEFAULT_EXPORT_SETTINGS, ...settings },
    units: 'metric',
    name,
    fontBytes: fixtureFont(LABEL_FONT)
  });
}

// --- third-party-style charts -------------------------------------------

export interface SyntheticSymbol {
  /** Character drawn from the symbol font. */
  readonly char: string;
  readonly code: string;
  readonly name: string;
  readonly color: ImportColor;
}

export interface SyntheticChartOptions {
  readonly width: number;
  readonly height: number;
  /** Row-major, `width * height`; a 1-based index into `symbols`, 0 is empty. */
  readonly cells: readonly number[];
  readonly symbols: readonly SyntheticSymbol[];
  /** Cells per chart page; the whole chart fits one page by default. */
  readonly pageColumns?: number;
  readonly pageRows?: number;
  /** Rows/columns repeated on adjacent pages. */
  readonly overlap?: number;
  /** Brand printed as the key's code column header. */
  readonly brand?: 'DMC' | 'Anchor';
  /** 1-based symbol indexes left out of the key. */
  readonly omitFromKey?: readonly number[];
  /** A second, smaller mark in a cell (a fractional stitch in a real chart). */
  readonly extraMarks?: ReadonlyArray<{ readonly x: number; readonly y: number; readonly symbol: number }>;
  readonly title?: string;
  readonly cellSize?: number;
}

const MARGIN = 36;
const CHART_TOP = 72;
const MINOR = 0.3;
const MAJOR = 1.1;

function hex(color: string): ReturnType<typeof rgb> {
  const value = Number.parseInt(color.slice(1), 16);
  return rgb(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
}

/** Symbol-font characters that exist in the font, in a stable order. */
export function symbolChars(count: number): string[] {
  const font = fontkit.create(Buffer.from(fixtureFont(SYMBOL_FONT))) as unknown as { hasGlyphForCodePoint(cp: number): boolean };
  const candidates = [0x25a0, 0x25b2, 0x25cf, 0x2605, 0x2665, 0x2666, 0x2663, 0x2660, 0x25c6, 0x2716, 0x271a, 0x2767, 0x25bc, 0x2b1f, 0x2b22, 0x2726];
  const chars = candidates.filter((cp) => font.hasGlyphForCodePoint(cp)).map((cp) => String.fromCodePoint(cp));
  if (chars.length < count) throw new Error(`The symbol font draws only ${String(chars.length)} of the fixture symbols.`);
  return chars.slice(0, count);
}

/** pdf-lib always writes a ToUnicode map; real subset fonts often have none. */
async function dropToUnicode(doc: PDFDocument, font: PDFFont): Promise<void> {
  await doc.flush();
  const dict = doc.context.lookup(font.ref, PDFDict);
  dict.delete(PDFName.of('ToUnicode'));
}

function drawGlyph(page: PDFPage, font: PDFFont, char: string, centerX: number, centerTop: number, size: number): void {
  const width = font.widthOfTextAtSize(char, size);
  const height = font.heightAtSize(size, { descender: false });
  page.drawText(char, { x: centerX - width / 2, y: page.getHeight() - centerTop - height / 2 + size * 0.12, size, font, color: rgb(0, 0, 0) });
}

function drawChartTile(
  page: PDFPage,
  fonts: { label: PDFFont; symbol: PDFFont },
  options: SyntheticChartOptions,
  x0: number, y0: number, x1: number, y1: number
): void {
  const cs = options.cellSize ?? 10;
  const pageHeight = page.getHeight();
  const left = MARGIN + 20;
  const top = CHART_TOP;
  const symbolSize = cs * 0.7;
  const colX = (c: number): number => left + (c - x0) * cs;
  const rowY = (r: number): number => top + (r - y0) * cs;

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const symbol = options.symbols[(options.cells[y * options.width + x] ?? 0) - 1];
      if (symbol) page.drawRectangle({ x: colX(x), y: pageHeight - rowY(y) - cs, width: cs, height: cs, color: hex(symbol.color), borderWidth: 0 });
    }
  }
  for (let c = x0; c <= x1; c += 1) {
    const thickness = c % 10 === 0 || c === x0 || c === x1 ? MAJOR : MINOR;
    page.drawLine({ start: { x: colX(c), y: pageHeight - rowY(y0) }, end: { x: colX(c), y: pageHeight - rowY(y1) }, thickness, color: rgb(0, 0, 0) });
  }
  for (let r = y0; r <= y1; r += 1) {
    const thickness = r % 10 === 0 || r === y0 || r === y1 ? MAJOR : MINOR;
    page.drawLine({ start: { x: colX(x0), y: pageHeight - rowY(r) }, end: { x: colX(x1), y: pageHeight - rowY(r) }, thickness, color: rgb(0, 0, 0) });
  }
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const symbol = options.symbols[(options.cells[y * options.width + x] ?? 0) - 1];
      if (!symbol) continue;
      const extra = options.extraMarks?.find((mark) => mark.x === x && mark.y === y);
      if (extra) {
        // Two half-size marks in opposite corners, as a fractional stitch prints.
        drawGlyph(page, fonts.symbol, symbol.char, colX(x) + cs * 0.3, rowY(y) + cs * 0.3, cs * 0.4);
        const second = options.symbols[extra.symbol - 1];
        drawGlyph(page, fonts.symbol, second.char, colX(x) + cs * 0.7, rowY(y) + cs * 0.7, cs * 0.4);
      } else drawGlyph(page, fonts.symbol, symbol.char, colX(x) + cs / 2, rowY(y) + cs / 2, symbolSize);
    }
  }
  // Ruler numbers every 10 cells, outside the lattice.
  for (let c = x0; c < x1; c += 1) {
    if ((c + 1) % 10 !== 0) continue;
    const label = String(c + 1);
    page.drawText(label, { x: colX(c) + cs / 2 - fonts.label.widthOfTextAtSize(label, 6) / 2, y: pageHeight - top + 4, size: 6, font: fonts.label });
  }
  for (let r = y0; r < y1; r += 1) {
    if ((r + 1) % 10 !== 0) continue;
    const label = String(r + 1);
    page.drawText(label, { x: left - 4 - fonts.label.widthOfTextAtSize(label, 6), y: pageHeight - rowY(r) - cs / 2 - 2, size: 6, font: fonts.label });
  }
}

function drawKeyPage(page: PDFPage, fonts: { label: PDFFont; symbol: PDFFont }, options: SyntheticChartOptions): void {
  const pageHeight = page.getHeight();
  const brand = options.brand ?? 'DMC';
  const label = (value: string, x: number, top: number, size = 9): void => {
    page.drawText(value, { x, y: pageHeight - top, size, font: fonts.label, color: rgb(0, 0, 0) });
  };
  label(`Floss key (${brand})`, MARGIN, 50, 14);
  const columns = { symbol: MARGIN, code: MARGIN + 60, name: MARGIN + 120, stitches: MARGIN + 340 };
  label('Symbol', columns.symbol, 90);
  label(brand, columns.code, 90);
  label('Name', columns.name, 90);
  label('Stitches', columns.stitches, 90);
  const counts = new Map<number, number>();
  for (const id of options.cells) if (id > 0) counts.set(id, (counts.get(id) ?? 0) + 1);
  let top = 100;
  options.symbols.forEach((symbol, index) => {
    if (options.omitFromKey?.includes(index + 1)) return;
    page.drawRectangle({ x: columns.symbol, y: pageHeight - top - 16, width: 16, height: 16, color: hex(symbol.color), borderWidth: 0 });
    drawGlyph(page, fonts.symbol, symbol.char, columns.symbol + 8, top + 8, 11);
    label(symbol.code, columns.code, top + 12);
    label(symbol.name, columns.name, top + 12);
    label(String(counts.get(index + 1) ?? 0), columns.stitches, top + 12);
    top += 22;
  });
}

/**
 * A chart in the style of commercial designer PDFs: symbols are text glyphs of
 * a subset font with no ToUnicode map, every cell has a color fill, the grid is
 * stroked with bold lines every 10 cells, and a key page lists the threads.
 * Chart pages come first in reading order, then the key.
 */
export async function buildSyntheticChartPdf(options: SyntheticChartOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  if (options.title) doc.setTitle(options.title);
  const fonts = {
    label: await doc.embedFont(fixtureFont(LABEL_FONT), { subset: true }),
    symbol: await doc.embedFont(fixtureFont(SYMBOL_FONT), { subset: true })
  };
  const overlap = options.overlap ?? 0;
  const pageColumns = options.pageColumns ?? options.width;
  const pageRows = options.pageRows ?? options.height;
  const starts = (size: number, per: number): number[] => {
    const result = [0];
    while (result[result.length - 1] + per < size) result.push(result[result.length - 1] + per - overlap);
    return result;
  };
  for (const y0 of starts(options.height, pageRows)) {
    for (const x0 of starts(options.width, pageColumns)) {
      const page = doc.addPage([612, 792]);
      drawChartTile(page, fonts, options, x0, y0, Math.min(options.width, x0 + pageColumns), Math.min(options.height, y0 + pageRows));
    }
  }
  drawKeyPage(doc.addPage([612, 792]), fonts, options);
  await dropToUnicode(doc, fonts.symbol);
  return doc.save();
}

// 1x1 PNG.
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

/** A scanned pattern: each page is one image covering the page. */
export async function buildImageOnlyPdf(pages = 2): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(PNG);
  for (let index = 0; index < pages; index += 1) {
    const page = doc.addPage([612, 792]);
    page.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
  }
  return doc.save();
}
