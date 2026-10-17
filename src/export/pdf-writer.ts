import type { PDFDocument, PDFFont, PDFPage, RGB } from 'pdf-lib';
import type { DisplayUnits, PatternDocument, PatternMetrics } from '../domain';
import { CellKind, FIXED_POINT_UNITS_PER_CELL } from '../domain';
import { DEFAULT_RENDERER_STYLE, type CanvasContextAdapter } from '../editor/contracts';
import { isLegacyQuarterKind, isThreeQuarterPairKind, threeQuarterPairComponents } from '../editor/cell-kinds';
import { contrastSymbolInk, relativeLuminance } from '../rendering/contrast';
import { drawStitchGeometry } from '../rendering/symbol-painter';
import { getSymbolOutline, SYMBOL_POOL_VERSION } from '../symbols';
import { toCubicSvgPath } from '../import/pdf/outline';
import { ChartPresentationMode } from '../editor/contracts';
import type { ExportSettings } from './export-settings';
import {
  AXIS_GUTTER_PT,
  FOOTER_RESERVE_PT,
  HEADER_RESERVE_PT,
  LEGEND_ROW_HEIGHT_PT,
  layoutChartPages,
  legendPageCount,
  legendRowsPerPage,
  type ChartLayout,
  type ChartPage
} from './layout';
import { buildLegend, type ExportLegend, type LegendCounts, type LegendLength, type LegendRow, type LegendSkeins } from './legend';

/**
 * The flattened, visible pattern. Completion planes are deliberately not part
 * of this type: the writer reads stitch kinds and colors only, so it cannot
 * draw completion state.
 */
export type PdfPatternDocument = Pick<PatternDocument, 'width' | 'height' | 'kind' | 'colors' | 'backstitches' | 'palette'> & {
  readonly canvasMask?: Uint8Array;
};

export interface PdfPatternInput {
  readonly document: PdfPatternDocument;
  readonly metrics: PatternMetrics;
  readonly settings: ExportSettings;
  readonly units: DisplayUnits;
  readonly name: string;
  /** Embedded label font (TTF/OTF bytes); see `loadPdfLabelFont`. */
  readonly fontBytes: Uint8Array;
  /** Rendered thread preview for the cover. The caller rasterizes it; the writer never touches a canvas. */
  readonly coverImagePng?: Uint8Array;
}

export interface PdfProgress {
  /** Pages finished so far and the total, including the cover. */
  readonly completed: number;
  readonly total: number;
}

export interface PdfWriteOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: PdfProgress) => void;
}

export class PdfExportCancelledError extends Error {
  constructor() {
    super('PDF export cancelled.');
    this.name = 'AbortError';
  }
}

export const PDF_CREATOR = 'Needlewise';
export const PDF_ESTIMATE_DISCLAIMER = 'Estimates; actual use varies.';
export const PDF_ESTIMATE_UNAVAILABLE = 'Physical estimate unavailable';

const INK = '#242424';
const MUTED = '#5f5f5f';
const PARTIAL_FILL = '#d9d9d9';
const GRID_THIN = '#c8c8c8';
const GRID_MID = '#8a8a8a';
const GRID_MAJOR = '#4a4a4a';
const OVERLAP_TINT = '#808080';
const CENTER_MARK = '#cc4422';
const MISSING_COLOR = DEFAULT_RENDERER_STYLE.missingPaletteColor;

type PdfLib = typeof import('pdf-lib');

interface Context {
  readonly lib: PdfLib;
  readonly doc: PDFDocument;
  readonly font: PDFFont;
  readonly supported: ReadonlySet<number>;
  readonly input: PdfPatternInput;
  readonly layout: ChartLayout;
  readonly legend: ExportLegend;
  readonly legendPages: number;
}

// --- geometry helpers (pure, exported for tests) -------------------------

/**
 * `page.drawSvgPath` emits `translate(x, y) scale(s, -s)` and then the path, so
 * pool outlines (centered on the origin, +y down, in cell units) land with
 * their center at the page point `(x, y)` (PDF y-up) and the right way up when
 * `x, y` is the cell center and `scale` the cell size in points.
 */
export function symbolPlacement(cellLeft: number, cellTop: number, cellSize: number, pageHeight: number, scale = 1): { x: number; y: number; scale: number } {
  return { x: cellLeft + cellSize / 2, y: pageHeight - (cellTop + cellSize / 2), scale: cellSize * scale };
}

/** Clip a segment to a rectangle (Liang-Barsky). Returns undefined when nothing remains. */
export function clipSegment(
  x1: number, y1: number, x2: number, y2: number,
  minX: number, minY: number, maxX: number, maxY: number
): [number, number, number, number] | undefined {
  let t0 = 0;
  let t1 = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const checks: ReadonlyArray<readonly [number, number]> = [
    [-dx, x1 - minX], [dx, maxX - x1], [-dy, y1 - minY], [dy, maxY - y1]
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return undefined;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return undefined;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return undefined;
        if (r < t1) t1 = r;
      }
    }
  }
  return [x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy];
}

type Polygon = readonly (readonly [number, number])[];

const polygonCache = new Map<string, readonly Polygon[]>();

/** Unit-cell polygons for a kind, recorded from the editor's own `drawStitchGeometry`. */
export function stitchPolygons(kind: number, slot = 0): readonly Polygon[] {
  const key = `${String(kind)}:${String(slot)}`;
  const cached = polygonCache.get(key);
  if (cached) return cached;
  const polygons: Polygon[] = [];
  let current: [number, number][] = [];
  const noop = (): void => undefined;
  const recorder: CanvasContextAdapter = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, font: '',
    clearRect: noop,
    fillRect: (x, y, width, height) => { polygons.push([[x, y], [x + width, y], [x + width, y + height], [x, y + height]]); },
    beginPath: () => { current = []; },
    moveTo: (x, y) => { current.push([x, y]); },
    lineTo: (x, y) => { current.push([x, y]); },
    fill: () => { if (current.length) polygons.push(current); current = []; },
    stroke: noop
  };
  drawStitchGeometry(recorder, kind, { x: 0, y: 0, width: 1, height: 1 }, slot);
  polygonCache.set(key, polygons);
  return polygons;
}

// --- low-level drawing ---------------------------------------------------

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new PdfExportCancelledError();
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

function color(ctx: Context, hex: string, fallback = INK): RGB {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  let value = match?.[1] ?? fallback.slice(1);
  if (value.length === 3) value = value.split('').map((c) => c + c).join('');
  const n = parseInt(value, 16);
  return ctx.lib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Replace characters the embedded font cannot draw, so a catalog name never fails the export. */
export function sanitizeLabel(text: string, supported: ReadonlySet<number>): string {
  let out = '';
  for (const char of text.normalize('NFC')) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13) out += ' ';
    else if (code < 32 || code === 127) continue;
    else out += supported.has(code) ? char : '?';
  }
  return out;
}

interface TextOptions {
  readonly align?: 'left' | 'center' | 'right';
  readonly color?: string;
  readonly maxWidth?: number;
}

/** Draw one line with its baseline `top` points below the page top. */
function text(ctx: Context, page: PDFPage, value: string, x: number, top: number, size: number, options: TextOptions = {}): void {
  let line = sanitizeLabel(value, ctx.supported);
  if (!line) return;
  const { font } = ctx;
  if (options.maxWidth !== undefined && font.widthOfTextAtSize(line, size) > options.maxWidth) {
    while (line.length > 1 && font.widthOfTextAtSize(`${line}...`, size) > options.maxWidth) line = line.slice(0, -1);
    line = `${line.trimEnd()}...`;
  }
  const width = font.widthOfTextAtSize(line, size);
  const left = options.align === 'right' ? x - width : options.align === 'center' ? x - width / 2 : x;
  page.drawText(line, { x: left, y: page.getHeight() - top, size, font, color: color(ctx, options.color ?? INK) });
}

function wrap(ctx: Context, value: string, size: number, maxWidth: number): string[] {
  const words = sanitizeLabel(value, ctx.supported).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && ctx.font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(line);
      line = word;
    } else line = candidate;
  }
  if (line) lines.push(line);
  return lines;
}

function line(ctx: Context, page: PDFPage, x1: number, top1: number, x2: number, top2: number, thickness: number, hex: string, cap?: 'round'): void {
  const height = page.getHeight();
  page.drawLine({
    start: { x: x1, y: height - top1 },
    end: { x: x2, y: height - top2 },
    thickness,
    color: color(ctx, hex),
    ...(cap === 'round' ? { lineCap: ctx.lib.LineCapStyle.Round } : {})
  });
}

function rect(ctx: Context, page: PDFPage, x: number, top: number, width: number, height: number, hex: string, opacity?: number): void {
  page.drawRectangle({ x, y: page.getHeight() - top - height, width, height, color: color(ctx, hex), borderWidth: 0, ...(opacity === undefined ? {} : { opacity }) });
}

// pdf-lib draws `Q` as an inexact `v`, so symbols are drawn from exact cubics.
const cubicSymbolPaths = new Map<string, string>();

function drawSymbol(ctx: Context, page: PDFPage, slug: string, left: number, top: number, size: number, ink: string, scale = 1): void {
  const outline = getSymbolOutline(slug);
  if (!outline) return;
  let d = cubicSymbolPaths.get(slug);
  if (d === undefined) {
    d = toCubicSvgPath(outline.d);
    cubicSymbolPaths.set(slug, d);
  }
  const placement = symbolPlacement(left, top, size, page.getHeight(), scale);
  page.drawSvgPath(d, { ...placement, color: color(ctx, ink) });
}

/**
 * The grid lines that outline a pattern's center, in cells. Per axis, an odd
 * count puts the center inside a cell, bracketed by the two lines around it,
 * and an even count puts it on a line, which runs one cell to either side.
 * Both odd outlines the center cell, both even draws a plus, and a mix draws
 * an H or an I.
 */
export function centerMarkSegments(width: number, height: number): Array<[number, number, number, number]> {
  const axis = (n: number): { lines: number[]; from: number; to: number } => {
    const mid = Math.floor(n / 2);
    return n % 2 === 1 ? { lines: [mid, mid + 1], from: mid, to: mid + 1 } : { lines: [mid], from: mid - 1, to: mid + 1 };
  };
  const x = axis(width);
  const y = axis(height);
  return [
    ...x.lines.map((c): [number, number, number, number] => [c, y.from, c, y.to]),
    ...y.lines.map((r): [number, number, number, number] => [x.from, r, x.to, r])
  ];
}

function drawPolygon(ctx: Context, page: PDFPage, polygon: Polygon, left: number, top: number, size: number, hex: string): void {
  const d = `${polygon.map(([u, v], i) => `${i === 0 ? 'M' : 'L'} ${u} ${v}`).join(' ')} Z`;
  page.drawSvgPath(d, { x: left, y: page.getHeight() - top, scale: size, color: color(ctx, hex) });
}

// --- formatting ----------------------------------------------------------

function fmt(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: value >= 100 ? 0 : 1 });
}

function fmtRange(min: number, max: number): string {
  const a = fmt(min);
  const b = fmt(max);
  return a === b ? a : `${a}–${b}`;
}

function fmtLength(length: LegendLength | undefined): string {
  return length ? `${fmtRange(length.min, length.max)} ${length.unit}` : '';
}

function fmtSkeins(skeins: LegendSkeins | undefined): string {
  return skeins ? `${fmtRange(skeins.min, skeins.max)} skeins` : '';
}

function stitchTotal(counts: LegendCounts): number {
  return counts.full + counts.half + counts.threeQuarter + counts.quarter;
}

function paletteColor(document: PdfPatternDocument, id: number): string {
  return document.palette.find((entry) => entry.id === id)?.color ?? MISSING_COLOR;
}

// --- shared page chrome --------------------------------------------------

function footer(ctx: Context, page: PDFPage, pageNumber: number, chartPage?: ChartPage): void {
  const { margin, printableWidth, printableHeight } = ctx.layout.geometry;
  const baseline = margin + printableHeight - 6;
  if (ctx.input.settings.pageNumbers) {
    text(ctx, page, `Page ${String(pageNumber)} of ${String(ctx.layout.totalPages)}`, margin + printableWidth / 2, baseline, 8, { align: 'center', color: MUTED });
  }
  const { columns, rows } = ctx.layout;
  if (!chartPage || columns * rows < 2) return;
  const bw = Math.min(8, 72 / columns);
  const bh = Math.min(6, 14 / rows);
  if (bw < 1.2 || bh < 1.2) return;
  const originX = margin + printableWidth - columns * bw;
  const originTop = baseline - rows * bh + 2;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < columns; c += 1) {
      const current = r === chartPage.row && c === chartPage.column;
      rect(ctx, page, originX + c * bw, originTop + r * bh, bw - 0.6, bh - 0.6, current ? INK : '#d0d0d0');
    }
  }
}

// --- cover ---------------------------------------------------------------

const INDEX_LABEL_SIZE = 10;
/** Label baseline below the block top, and the gap from that baseline to the grid's first row (clears descenders). */
const INDEX_LABEL_BASELINE = 10;
const INDEX_LABEL_TO_GRID = 6;
const INDEX_HEADER_HEIGHT = INDEX_LABEL_BASELINE + INDEX_LABEL_TO_GRID;
const INDEX_GAP = 1.5;
const INDEX_MAX_BOX = 34;
const INDEX_MAX_HEIGHT = 210;
const COVER_GUTTER = 24;
const COVER_LEFT_SHARE = 0.35;
const COVER_BLOCK_SPACING = 12;

export interface CoverRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The "Page index" label and its grid, placed as one block. All `top` values are measured down from the page top. */
export interface IndexBlock {
  readonly labelX: number;
  readonly labelBaseline: number;
  readonly gridLeft: number;
  readonly gridTop: number;
  readonly box: number;
  readonly gap: number;
  readonly gridWidth: number;
  readonly height: number;
}

/**
 * Lay out the page index block in `area`, bottom-aligned, with the grid centered or start-aligned in it and the
 * label at the grid's left edge. Returns null when the grid would be too small to draw, so neither is drawn.
 */
export function layoutIndexBlock(area: CoverRect, columns: number, rows: number, align: 'center' | 'start'): IndexBlock | null {
  if (columns < 1 || rows < 1) return null;
  const box = Math.min(
    INDEX_MAX_BOX,
    (area.width - INDEX_GAP * columns) / columns,
    (Math.min(area.height, INDEX_MAX_HEIGHT) - INDEX_HEADER_HEIGHT - INDEX_GAP * rows) / rows
  );
  if (!(box >= 4)) return null;
  const gridWidth = columns * (box + INDEX_GAP);
  const height = INDEX_HEADER_HEIGHT + rows * (box + INDEX_GAP);
  const gridLeft = align === 'center' ? area.left + (area.width - gridWidth) / 2 : area.left;
  const blockTop = area.top + area.height - height;
  return {
    labelX: gridLeft,
    labelBaseline: blockTop + INDEX_LABEL_BASELINE,
    gridLeft,
    gridTop: blockTop + INDEX_HEADER_HEIGHT,
    box,
    gap: INDEX_GAP,
    gridWidth,
    height
  };
}

/** Fit an image inside `area` at its own aspect ratio, centered horizontally and either top-aligned or centered vertically. */
export function fitCoverImage(imageWidth: number, imageHeight: number, area: CoverRect, vertical: 'top' | 'center'): CoverRect | null {
  if (!(area.width > 0) || !(area.height > 20) || !(imageWidth > 0) || !(imageHeight > 0)) return null;
  const fit = Math.min(area.width / imageWidth, area.height / imageHeight);
  const width = imageWidth * fit;
  const height = imageHeight * fit;
  return {
    left: area.left + (area.width - width) / 2,
    top: vertical === 'center' ? area.top + (area.height - height) / 2 : area.top,
    width,
    height
  };
}

/** Landscape cover columns: text and page index on the left, the preview image on the right. */
export function landscapeCoverColumns(margin: number, printableWidth: number): { readonly left: { left: number; width: number }; readonly right: { left: number; width: number } } {
  const leftWidth = Math.floor(printableWidth * COVER_LEFT_SHARE);
  const rightLeft = margin + leftWidth + COVER_GUTTER;
  return {
    left: { left: margin, width: leftWidth },
    right: { left: rightLeft, width: margin + printableWidth - rightLeft }
  };
}

function coverFacts(ctx: Context): string[] {
  const { input, legend } = ctx;
  const facts: string[] = [`${String(input.document.width)} × ${String(input.document.height)} stitches`];
  const finished = input.metrics.finishedSize;
  if (finished) {
    const size = input.units === 'metric'
      ? `${fmt(finished.widthCm)} × ${fmt(finished.heightCm)} cm`
      : `${fmt(finished.widthInches)} × ${fmt(finished.heightInches)} in`;
    facts.push(`Finished size: ${size}${legend.aidaCount === undefined ? '' : ` on ${String(legend.aidaCount)}-count Aida`}`);
  }
  facts.push(`${String(legend.rows.length)} colors · ${fmt(stitchTotal(legend.totals.counts))} stitches · ${fmt(legend.totals.counts.backstitch)} backstitch`);
  facts.push(legend.totals.length
    ? `Thread: ${fmtLength(legend.totals.length)}${legend.totals.skeins ? ` · ${fmtSkeins(legend.totals.skeins)}` : ''}`
    : `Thread: ${PDF_ESTIMATE_UNAVAILABLE}`);
  return facts;
}

/** Title and fact lines wrapped to `width`, starting at `left`/`top`. Returns the top below the block. */
function drawCoverText(ctx: Context, page: PDFPage, left: number, top: number, width: number, maxTitleLines: number): number {
  let y = top;
  for (const titleLine of wrap(ctx, ctx.input.name || 'Untitled pattern', 24, width).slice(0, maxTitleLines)) {
    y += 26;
    text(ctx, page, titleLine, left, y, 24);
  }
  y += 8;
  for (const fact of coverFacts(ctx)) {
    for (const factLine of wrap(ctx, fact, 11, width)) {
      y += 16;
      text(ctx, page, factLine, left, y, 11);
    }
  }
  return y + 12;
}

function drawIndexBlock(ctx: Context, page: PDFPage, block: IndexBlock): void {
  text(ctx, page, 'Page index', block.labelX, block.labelBaseline, INDEX_LABEL_SIZE, { color: MUTED });
  for (const chartPage of ctx.layout.pages) {
    const left = block.gridLeft + chartPage.column * (block.box + block.gap);
    const cellTop = block.gridTop + chartPage.row * (block.box + block.gap);
    rect(ctx, page, left, cellTop, block.box, block.box, '#eeeeee');
    if (block.box >= 11) text(ctx, page, String(chartPage.pageNumber), left + block.box / 2, cellTop + block.box / 2 + 2.5, Math.min(8, block.box * 0.45), { align: 'center' });
  }
}

async function drawCover(ctx: Context): Promise<void> {
  const { doc, input, layout } = ctx;
  const { pageWidth, pageHeight, margin, printableWidth, printableHeight } = layout.geometry;
  const page = doc.addPage([pageWidth, pageHeight]);
  const bottom = margin + printableHeight - FOOTER_RESERVE_PT;
  const image = input.coverImagePng ? await doc.embedPng(input.coverImagePng) : undefined;

  if (input.settings.orientation === 'landscape') {
    const columns = landscapeCoverColumns(margin, printableWidth);
    const textBottom = drawCoverText(ctx, page, columns.left.left, margin, columns.left.width, 3);
    if (layout.chartPages > 0) {
      const block = layoutIndexBlock({ left: columns.left.left, top: textBottom, width: columns.left.width, height: bottom - textBottom }, layout.columns, layout.rows, 'start');
      if (block) drawIndexBlock(ctx, page, block);
    }
    const placed = image && fitCoverImage(image.width, image.height, { left: columns.right.left, top: margin, width: columns.right.width, height: bottom - margin }, 'center');
    if (image && placed) page.drawImage(image, { x: placed.left, y: pageHeight - placed.top - placed.height, width: placed.width, height: placed.height });
    footer(ctx, page, 1);
    return;
  }

  const top = drawCoverText(ctx, page, margin, margin, printableWidth, 2);
  const block = layout.chartPages > 0
    ? layoutIndexBlock({ left: margin, top, width: printableWidth, height: bottom - top }, layout.columns, layout.rows, 'center')
    : null;
  if (image) {
    const reserve = block ? block.height + COVER_BLOCK_SPACING : 0;
    const placed = fitCoverImage(image.width, image.height, { left: margin, top, width: printableWidth, height: bottom - reserve - top }, 'top');
    if (placed) page.drawImage(image, { x: placed.left, y: pageHeight - placed.top - placed.height, width: placed.width, height: placed.height });
  }
  if (block) drawIndexBlock(ctx, page, block);
  footer(ctx, page, 1);
}

// --- legend --------------------------------------------------------------

function legendColumns(printableWidth: number): { symbol: number; code: number; name: number; counts: number; length: number; skeins: number; nameWidth: number } {
  const symbol = 0;
  const code = 26;
  const countWidth = 32;
  const lengthWidth = 78;
  const skeinsWidth = 56;
  const nameWidth = Math.max(40, printableWidth - code - 54 - countWidth * 5 - lengthWidth - skeinsWidth);
  const name = code + 54;
  const counts = name + nameWidth;
  return { symbol, code, name, counts, length: counts + countWidth * 5, skeins: counts + countWidth * 5 + lengthWidth, nameWidth };
}

function drawLegendHeading(ctx: Context, page: PDFPage, pageIndex: number): void {
  const { margin, printableWidth } = ctx.layout.geometry;
  const { legend } = ctx;
  text(ctx, page, pageIndex === 0 ? 'Thread legend' : 'Thread legend (continued)', margin, margin + 16, 14);
  const strands = `${String(legend.strands)} strand${legend.strands === 1 ? '' : 's'} per stitch · ${String(legend.backstitchStrands)} strand${legend.backstitchStrands === 1 ? '' : 's'} backstitch · ${fmt(legend.waste * 100)}% waste`;
  text(ctx, page, strands, margin, margin + 30, 8.5, { color: MUTED });
  const cols = legendColumns(printableWidth);
  const headerTop = margin + 46;
  const labels: ReadonlyArray<readonly [string, number, 'left' | 'right']> = [
    ['Symbol', cols.symbol, 'left'], ['Code', cols.code, 'left'], ['Name', cols.name, 'left'],
    ['Full', cols.counts + 28, 'right'], ['Half', cols.counts + 60, 'right'], ['3/4', cols.counts + 92, 'right'],
    ['1/4', cols.counts + 124, 'right'], ['Back', cols.counts + 156, 'right'],
    ['Length', cols.length + 4, 'left'], ['Skeins', cols.skeins + 4, 'left']
  ];
  for (const [label, offset, align] of labels) text(ctx, page, label, margin + offset, headerTop, 8, { align, color: MUTED });
  line(ctx, page, margin, headerTop + 5, margin + printableWidth, headerTop + 5, 0.6, GRID_MID);
}

function drawLegendCounts(ctx: Context, page: PDFPage, counts: LegendCounts, left: number, baseline: number, size: number): void {
  const values = [counts.full, counts.half, counts.threeQuarter, counts.quarter, counts.backstitch];
  values.forEach((value, index) => {
    text(ctx, page, value === 0 ? '–' : fmt(value), left + 28 + index * 32, baseline, size, { align: 'right' });
  });
}

function drawLegendRow(ctx: Context, page: PDFPage, row: LegendRow, top: number): void {
  const { margin, printableWidth } = ctx.layout.geometry;
  const cols = legendColumns(printableWidth);
  const left = margin;
  const baseline = top + LEGEND_ROW_HEIGHT_PT / 2 + 3;
  const swatch = 18;
  const swatchTop = top + (LEGEND_ROW_HEIGHT_PT - swatch) / 2;
  rect(ctx, page, left + cols.symbol, swatchTop, swatch, swatch, row.color);
  drawSymbol(ctx, page, row.symbol, left + cols.symbol, swatchTop, swatch, contrastSymbolInk(row.color, INK));
  text(ctx, page, row.catalogCode ?? '', left + cols.code, baseline, 9, { maxWidth: 50 });
  const nameLines = wrap(ctx, row.name, 9, cols.nameWidth - 4).slice(0, 2);
  if (nameLines.length <= 1) text(ctx, page, nameLines[0] ?? '', left + cols.name, baseline, 9, { maxWidth: cols.nameWidth - 4 });
  else nameLines.forEach((nameLine, index) => text(ctx, page, nameLine, left + cols.name, baseline - 5 + index * 10, 9, { maxWidth: cols.nameWidth - 4 }));
  drawLegendCounts(ctx, page, row.counts, left + cols.counts, baseline, 9);
  if (row.length) {
    text(ctx, page, fmtLength(row.length), left + cols.length + 4, baseline, 9, { maxWidth: 74 });
    text(ctx, page, fmtSkeins(row.skeins), left + cols.skeins + 4, baseline, 9, { maxWidth: 52 });
  } else {
    wrap(ctx, PDF_ESTIMATE_UNAVAILABLE, 6.5, 128).slice(0, 2).forEach((unavailable, index) => {
      text(ctx, page, unavailable, left + cols.length + 4, baseline - 3 + index * 8, 6.5, { color: MUTED });
    });
  }
  line(ctx, page, margin, top + LEGEND_ROW_HEIGHT_PT, margin + printableWidth, top + LEGEND_ROW_HEIGHT_PT, 0.25, GRID_THIN);
}

function drawLegendFooter(ctx: Context, page: PDFPage, top: number): void {
  const { margin, printableWidth } = ctx.layout.geometry;
  const { legend } = ctx;
  const cols = legendColumns(printableWidth);
  const baseline = top + LEGEND_ROW_HEIGHT_PT / 2 + 3;
  line(ctx, page, margin, top, margin + printableWidth, top, 0.8, GRID_MAJOR);
  text(ctx, page, 'Total', margin + cols.name, baseline, 9.5);
  drawLegendCounts(ctx, page, legend.totals.counts, margin + cols.counts, baseline, 9.5);
  if (legend.totals.length) {
    text(ctx, page, fmtLength(legend.totals.length), margin + cols.length + 4, baseline, 9.5, { maxWidth: 74 });
    text(ctx, page, fmtSkeins(legend.totals.skeins), margin + cols.skeins + 4, baseline, 9.5, { maxWidth: 52 });
  } else {
    text(ctx, page, PDF_ESTIMATE_UNAVAILABLE, margin + cols.length + 4, baseline, 7, { color: MUTED });
  }
  const note = [legend.note, PDF_ESTIMATE_DISCLAIMER].filter(Boolean).join(' ');
  wrap(ctx, note, 7.5, printableWidth).slice(0, 4).forEach((noteLine, index) => {
    text(ctx, page, noteLine, margin, top + LEGEND_ROW_HEIGHT_PT + 12 + index * 10, 7.5, { color: MUTED });
  });
}

function drawLegendPage(ctx: Context, rows: readonly LegendRow[], pageIndex: number, pageNumber: number, last: boolean): void {
  const { pageWidth, pageHeight, margin } = ctx.layout.geometry;
  const page = ctx.doc.addPage([pageWidth, pageHeight]);
  drawLegendHeading(ctx, page, pageIndex);
  let top = margin + 52;
  if (ctx.legend.rows.length === 0) text(ctx, page, 'No stitches have been placed yet.', margin, top + 18, 10, { color: MUTED });
  for (const row of rows) {
    drawLegendRow(ctx, page, row, top);
    top += LEGEND_ROW_HEIGHT_PT;
  }
  if (last) drawLegendFooter(ctx, page, top + (rows.length === 0 ? LEGEND_ROW_HEIGHT_PT : 0));
  footer(ctx, page, pageNumber);
}

// --- chart pages ---------------------------------------------------------

function drawChartPage(ctx: Context, chartPage: ChartPage): void {
  const { input, layout } = ctx;
  const { document, settings } = input;
  const { geometry } = layout;
  const { pageWidth, pageHeight, margin } = geometry;
  const cs = geometry.cellSizePt;
  const page = ctx.doc.addPage([pageWidth, pageHeight]);
  const left = margin + AXIS_GUTTER_PT;
  const topEdge = margin + HEADER_RESERVE_PT + AXIS_GUTTER_PT;
  const cols = chartPage.x1 - chartPage.x0;
  const rows = chartPage.y1 - chartPage.y0;
  const colX = (c: number): number => left + (c - chartPage.x0) * cs;
  const rowY = (r: number): number => topEdge + (r - chartPage.y0) * cs;
  const mode = settings.chartStyle;
  const showFill = mode !== ChartPresentationMode.Symbol;
  const showSymbols = mode !== ChartPresentationMode.Color;
  const { gridInterval, midGridInterval } = DEFAULT_RENDERER_STYLE;
  const symbolInkFor = (hex: string): string => mode === ChartPresentationMode.Combined ? contrastSymbolInk(hex, INK) : INK;

  text(ctx, page, input.name, margin, margin + 10, 9, { maxWidth: geometry.printableWidth * 0.55 });
  text(ctx, page, `Columns ${String(chartPage.x0 + 1)}–${String(chartPage.x1)} · rows ${String(chartPage.y0 + 1)}–${String(chartPage.y1)}`,
    margin + geometry.printableWidth, margin + 10, 8, { align: 'right', color: MUTED });

  const mask = document.canvasMask;
  const symbolPass: Array<() => void> = [];
  const paintStitch = (id: number, kind: number, slot: number | undefined, left0: number, top0: number): void => {
    if (id === 0) return;
    const hex = paletteColor(document, id);
    const quarter = slot !== undefined;
    const fillHex = showFill ? hex : PARTIAL_FILL;
    if (kind === CellKind.Full) {
      if (showFill) rect(ctx, page, left0, top0, cs, cs, hex);
    } else {
      for (const polygon of stitchPolygons(kind, slot ?? 0)) drawPolygon(ctx, page, polygon, left0, top0, cs, fillHex);
    }
    if (!showSymbols) return;
    const slug = document.palette.find((entry) => entry.id === id)?.symbol;
    if (!slug) return;
    const ink = symbolInkFor(showFill ? hex : '#ffffff');
    // Symbols are drawn after the grid, so lines never cut through a mark.
    if (!quarter) symbolPass.push(() => { drawSymbol(ctx, page, slug, left0, top0, cs, ink); });
    else {
      const dx = slot === 1 || slot === 2 ? cs / 4 : -cs / 4;
      const dy = slot === 2 || slot === 3 ? cs / 4 : -cs / 4;
      symbolPass.push(() => { drawSymbol(ctx, page, slug, left0 + dx, top0 + dy, cs, ink, 0.5); });
    }
  };

  // Fills first, so the overlap tint and grid sit above them.
  for (let r = chartPage.y0; r < chartPage.y1; r += 1) {
    for (let c = chartPage.x0; c < chartPage.x1; c += 1) {
      const index = r * document.width + c;
      const kind = document.kind[index];
      if (kind === CellKind.Empty || (mask && mask[index] === 0)) continue;
      const offset = index * 4;
      const x = colX(c);
      const y = rowY(r);
      if (isLegacyQuarterKind(kind)) {
        for (let slot = 0; slot < 4; slot += 1) paintStitch(document.colors[offset + slot] ?? 0, kind, slot, x, y);
      } else if (isThreeQuarterPairKind(kind)) {
        const colors = [0, 1, 2, 3].map((slot) => document.colors[offset + slot] ?? 0);
        for (const component of threeQuarterPairComponents(colors)) {
          paintStitch(colors[component.slot] ?? 0, component.kind, component.slot, x, y);
        }
      } else paintStitch(document.colors[offset] ?? 0, kind, undefined, x, y);
    }
  }
  const tint = (x: number, y: number, w: number, h: number): void => {
    if (w > 0 && h > 0) rect(ctx, page, x, y, w, h, OVERLAP_TINT, 0.2);
  };
  tint(left, topEdge, chartPage.overlapLeft * cs, rows * cs);
  tint(left + (cols - chartPage.overlapRight) * cs, topEdge, chartPage.overlapRight * cs, rows * cs);
  tint(left + chartPage.overlapLeft * cs, topEdge, (cols - chartPage.overlapLeft - chartPage.overlapRight) * cs, chartPage.overlapTop * cs);
  tint(left + chartPage.overlapLeft * cs, topEdge + (rows - chartPage.overlapBottom) * cs, (cols - chartPage.overlapLeft - chartPage.overlapRight) * cs, chartPage.overlapBottom * cs);

  const gridStyle = (n: number): readonly [number, string] =>
    n % gridInterval === 0 ? [0.9, GRID_MAJOR] : n % midGridInterval === 0 ? [0.5, GRID_MID] : [0.25, GRID_THIN];
  for (let c = chartPage.x0; c <= chartPage.x1; c += 1) {
    const [thickness, hex] = gridStyle(c);
    line(ctx, page, colX(c), topEdge, colX(c), topEdge + rows * cs, thickness, hex);
  }
  for (let r = chartPage.y0; r <= chartPage.y1; r += 1) {
    const [thickness, hex] = gridStyle(r);
    line(ctx, page, left, rowY(r), left + cols * cs, rowY(r), thickness, hex);
  }

  if (settings.centerMark && document.width > 0 && document.height > 0) {
    // Over the grid and under the symbols, so the bold lines never cut through a mark.
    for (const segment of centerMarkSegments(document.width, document.height)) {
      const clipped = clipSegment(...segment, chartPage.x0, chartPage.y0, chartPage.x1, chartPage.y1);
      if (!clipped || Math.hypot(clipped[2] - clipped[0], clipped[3] - clipped[1]) < 1e-6) continue;
      line(ctx, page, colX(clipped[0]), rowY(clipped[1]), colX(clipped[2]), rowY(clipped[3]), 1.6, CENTER_MARK);
    }
  }

  symbolPass.forEach((run) => { run(); });

  // Backstitch runs over the symbols, clipped to this page's cell range.
  // The store is fixed-point (FIXED_POINT_UNITS_PER_CELL per cell); work in cells from here on.
  const store = document.backstitches;
  const unit = FIXED_POINT_UNITS_PER_CELL;
  for (let i = 0; i < store.ids.length; i += 1) {
    const clipped = clipSegment(
      store.x1[i] / unit, store.y1[i] / unit, store.x2[i] / unit, store.y2[i] / unit,
      chartPage.x0, chartPage.y0, chartPage.x1, chartPage.y1
    );
    // A segment that only touches the page edge clips to a point; its round cap would print a dot.
    if (!clipped || Math.hypot(clipped[2] - clipped[0], clipped[3] - clipped[1]) < 1e-6) continue;
    const hex = paletteColor(document, store.colors[i]);
    const lum = relativeLuminance(hex);
    line(ctx, page,
      left + (clipped[0] - chartPage.x0) * cs, topEdge + (clipped[1] - chartPage.y0) * cs,
      left + (clipped[2] - chartPage.x0) * cs, topEdge + (clipped[3] - chartPage.y0) * cs,
      Math.max(0.7, cs * 0.14), lum !== undefined && lum > 0.85 ? GRID_MID : hex, 'round');
  }

  const border = (): void => {
    line(ctx, page, left, topEdge, left + cols * cs, topEdge, 1, GRID_MAJOR);
    line(ctx, page, left, topEdge + rows * cs, left + cols * cs, topEdge + rows * cs, 1, GRID_MAJOR);
    line(ctx, page, left, topEdge, left, topEdge + rows * cs, 1, GRID_MAJOR);
    line(ctx, page, left + cols * cs, topEdge, left + cols * cs, topEdge + rows * cs, 1, GRID_MAJOR);
  };
  border();

  const axisSize = Math.min(7, cs * 0.6);
  const nearTen = (n: number): boolean => n % gridInterval === 0 || (gridInterval - (n % gridInterval)) < 3;
  for (let c = chartPage.x0; c < chartPage.x1; c += 1) {
    const n = c + 1;
    if (n % gridInterval === 0 || (c === chartPage.x0 && !nearTen(n))) {
      text(ctx, page, String(n), colX(c) + cs / 2, topEdge - 4, axisSize, { align: 'center', color: MUTED });
    }
  }
  for (let r = chartPage.y0; r < chartPage.y1; r += 1) {
    const n = r + 1;
    if (n % gridInterval === 0 || (r === chartPage.y0 && !nearTen(n))) {
      text(ctx, page, String(n), left - 3, rowY(r) + cs / 2 + axisSize * 0.35, axisSize, { align: 'right', color: MUTED });
    }
  }

  const centerX = document.width / 2;
  const centerY = document.height / 2;
  if (centerX >= chartPage.x0 && centerX <= chartPage.x1) {
    const x = colX(chartPage.x0) + (centerX - chartPage.x0) * cs;
    line(ctx, page, x, topEdge - 5, x, topEdge, 1.4, CENTER_MARK);
    line(ctx, page, x, topEdge + rows * cs, x, topEdge + rows * cs + 4, 1.4, CENTER_MARK);
  }
  if (centerY >= chartPage.y0 && centerY <= chartPage.y1) {
    const y = topEdge + (centerY - chartPage.y0) * cs;
    line(ctx, page, left - 5, y, left, y, 1.4, CENTER_MARK);
    line(ctx, page, left + cols * cs, y, left + cols * cs + 4, y, 1.4, CENTER_MARK);
  }

  footer(ctx, page, chartPage.pageNumber, chartPage);
}

// --- entry point ---------------------------------------------------------

/**
 * Write the pattern PDF: cover, legend pages, then chart pages.
 *
 * `pdf-lib` and its font plugin load through dynamic imports so they stay out
 * of the main bundle. Output pages always equal
 * `estimateTotalPages(width, height, settings, legendRows)`.
 */
export async function writePatternPdf(input: PdfPatternInput, options: PdfWriteOptions = {}): Promise<Uint8Array> {
  const { signal, onProgress } = options;
  throwIfAborted(signal);
  const [lib, fontkitModule] = await Promise.all([import('pdf-lib'), import('@pdf-lib/fontkit')]);
  throwIfAborted(signal);

  const doc = await lib.PDFDocument.create();
  doc.registerFontkit(fontkitModule.default);
  const font = await doc.embedFont(input.fontBytes, { subset: true });
  const legend = buildLegend(input.document.palette, input.metrics, input.units);
  const legendPages = legendPageCount(legend.rows.length, input.settings);
  const layout = layoutChartPages(input.document.width, input.document.height, input.settings, legendPages);
  const ctx: Context = {
    lib, doc, font, input, layout, legend, legendPages,
    supported: new Set(font.getCharacterSet())
  };

  doc.setTitle(input.name || 'Untitled pattern', { showInWindowTitleBar: true });
  doc.setCreator(PDF_CREATOR);
  doc.setProducer(PDF_CREATOR);
  doc.setSubject(`Cross-stitch pattern (symbol pool version ${String(SYMBOL_POOL_VERSION)})`);
  doc.setKeywords([PDF_CREATOR, 'cross-stitch', `symbol-pool-${String(SYMBOL_POOL_VERSION)}`]);

  const total = layout.totalPages;
  let completed = 0;
  const step = async (): Promise<void> => {
    completed += 1;
    onProgress?.({ completed, total });
    // Let a queued cancel message run between pages.
    await yieldToEventLoop();
    throwIfAborted(signal);
  };

  await drawCover(ctx);
  await step();

  const perPage = legendRowsPerPage(input.settings);
  for (let index = 0; index < legendPages; index += 1) {
    drawLegendPage(ctx, legend.rows.slice(index * perPage, (index + 1) * perPage), index, 2 + index, index === legendPages - 1);
    await step();
  }
  for (const chartPage of layout.pages) {
    drawChartPage(ctx, chartPage);
    await step();
  }

  const bytes = await doc.save();
  throwIfAborted(signal);
  return bytes;
}
