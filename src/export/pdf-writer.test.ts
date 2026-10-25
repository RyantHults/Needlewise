// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PDFArray, PDFDocument, decodePDFRawStream, type PDFRawStream } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { CellKind, computePatternMetrics, createDocument, HalfDirection, QuarterCorner, type PatternDocument } from '../domain';
import { DEFAULT_CATALOG_DEFINITION } from '../catalog';
import { SYMBOL_POOL_VERSION } from '../symbols';
import { DEFAULT_EXPORT_SETTINGS, type ExportSettings } from './export-settings';
import { PAPER_SIZES_PT } from './export-settings';
import { ExportCancelledError } from './cancellation';
import { estimateTotalPages, layoutChartPages, pageGeometry, AXIS_GUTTER_PT, HEADER_RESERVE_PT } from './layout';
import {
  centerMarkSegments,
  clipSegment,
  fitCoverImage,
  landscapeCoverColumns,
  layoutIndexBlock,
  sanitizeLabel,
  stitchPolygons,
  symbolPlacement,
  writePatternPdf,
  type PdfPatternInput
} from './pdf-writer';
import { applyCommand, cell } from '../domain/test-fixtures';

const fontBytes = new Uint8Array(readFileSync(new URL('../../fonts/LibertinusMath-Regular.ttf', import.meta.url)));
// 1x1 PNG.
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

function patternOf(width: number, height: number, fill: (apply: (command: Parameters<typeof applyCommand>[1]) => void) => void = () => undefined): PatternDocument {
  let pattern = createDocument({
    catalog: DEFAULT_CATALOG_DEFINITION.association,
    width,
    height,
    palette: [{ name: 'Red', color: '#dd3333' }, { name: 'Midnight 日本 Blue', color: '#111133' }]
  });
  fill((command) => { pattern = applyCommand(pattern, command).document; });
  return pattern;
}

function inputFor(document: PatternDocument, patch: Partial<PdfPatternInput> = {}, aida = true): PdfPatternInput {
  return {
    document,
    metrics: computePatternMetrics(document, aida ? { aidaCount: 14, strands: 2, waste: 0.1 } : undefined),
    settings: DEFAULT_EXPORT_SETTINGS,
    units: 'metric',
    name: 'Test pattern',
    fontBytes,
    ...patch
  };
}

async function load(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes);
}

function legendRows(input: PdfPatternInput): number {
  return input.document.palette.filter((entry) => {
    const item = input.metrics.byPalette.get(entry.id);
    return entry.active && item && item.full + item.half + item.quarter + (item.threeQuarter ?? 0) + item.backstitch > 0;
  }).length;
}

function stitched(document: PatternDocument): PatternDocument {
  return document;
}

const withStitches = (width: number, height: number): PatternDocument => stitched(patternOf(width, height, (apply) => {
  apply(cell(width, { type: 'set-full', x: 0, y: 0, color: 1 }));
  apply(cell(width, { type: 'set-half', x: 1, y: 0, direction: HalfDirection.Slash, color: 2 }));
  apply(cell(width, { type: 'set-quarter', x: 2, y: 0, corner: QuarterCorner.NW, color: 1 }));
  apply({ type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: width * 4, y: height * 4 }, color: 2 });
}));

describe('symbol placement (drawSvgPath spike)', () => {
  it('centers the outline on the cell and scales cell units to points', () => {
    expect(symbolPlacement(100, 50, 10, 792)).toEqual({ x: 105, y: 792 - 55, scale: 10 });
    expect(symbolPlacement(0, 0, 8, 100, 0.5).scale).toBe(4);
  });

});

describe('helpers', () => {
  it('clips segments to a page range', () => {
    expect(clipSegment(0, 0, 10, 0, 2, -1, 6, 1)).toEqual([2, 0, 6, 0]);
    expect(clipSegment(0, 5, 10, 5, 0, 0, 4, 4)).toBeUndefined();
    expect(clipSegment(1, 1, 3, 3, 0, 0, 4, 4)).toEqual([1, 1, 3, 3]);
    expect(clipSegment(-2, 2, 2, 2, 0, 0, 4, 4)).toEqual([0, 2, 2, 2]);
  });

  it('records the editor stitch geometry', () => {
    expect(stitchPolygons(CellKind.Full)).toHaveLength(1);
    expect(stitchPolygons(CellKind.HalfSlash)[0]).toHaveLength(6);
    expect(stitchPolygons(CellKind.Quarters, 2)[0]).toHaveLength(3);
    expect(stitchPolygons(CellKind.ThreeQuarterNW)[0]).toHaveLength(3);
  });

  it('replaces characters the font lacks', () => {
    const supported = new Set([...'Blue '].map((c) => c.codePointAt(0) ?? 0));
    expect(sanitizeLabel('Blue 日\n', supported)).toBe('Blue ? ');
  });
});

describe('cover placement', () => {
  const area = { left: 72, top: 300, width: 468, height: 200 };

  it('puts the index label above the grid, at the grid left edge', () => {
    for (const align of ['center', 'start'] as const) {
      const block = layoutIndexBlock(area, 3, 2, align);
      expect(block).not.toBeNull();
      if (!block) continue;
      expect(block.labelX).toBe(block.gridLeft);
      // The baseline sits above the first row by more than a descender.
      expect(block.labelBaseline + 4).toBeLessThan(block.gridTop);
      expect(block.gridTop + 2 * (block.box + block.gap)).toBeCloseTo(area.top + area.height);
      expect(block.gridLeft).toBeGreaterThanOrEqual(area.left);
      expect(block.gridLeft + block.gridWidth).toBeLessThanOrEqual(area.left + area.width + 1e-9);
    }
    expect(layoutIndexBlock(area, 3, 2, 'start')?.gridLeft).toBe(area.left);
  });

  it('draws no index block when the grid is too small', () => {
    expect(layoutIndexBlock({ ...area, width: 60 }, 40, 2, 'center')).toBeNull();
    expect(layoutIndexBlock({ ...area, height: 24 }, 2, 2, 'center')).toBeNull();
  });

  it('keeps the landscape text, index and image in their own columns', () => {
    const geometry = pageGeometry({ ...DEFAULT_EXPORT_SETTINGS, orientation: 'landscape' });
    const { left, right } = landscapeCoverColumns(geometry.margin, geometry.printableWidth);
    expect(left.left + left.width).toBeLessThan(right.left);
    expect(right.left + right.width).toBeCloseTo(geometry.margin + geometry.printableWidth);
    const block = layoutIndexBlock({ left: left.left, top: 200, width: left.width, height: 300 }, 4, 3, 'start');
    expect(block).not.toBeNull();
    if (block) {
      expect(block.gridLeft).toBeGreaterThanOrEqual(left.left);
      expect(block.gridLeft + block.gridWidth).toBeLessThanOrEqual(left.left + left.width + 1e-9);
    }
    const column = { left: right.left, top: geometry.margin, width: right.width, height: 400 };
    for (const [w, h] of [[100, 100], [300, 100], [100, 300]] as const) {
      const placed = fitCoverImage(w, h, column, 'center');
      expect(placed).not.toBeNull();
      if (!placed) continue;
      expect(placed.left).toBeGreaterThanOrEqual(column.left - 1e-9);
      expect(placed.left + placed.width).toBeLessThanOrEqual(column.left + column.width + 1e-9);
      expect(placed.top).toBeGreaterThanOrEqual(column.top - 1e-9);
      expect(placed.top + placed.height).toBeLessThanOrEqual(column.top + column.height + 1e-9);
      const fillsWidth = Math.abs(placed.width - column.width) < 1e-6;
      const fillsHeight = Math.abs(placed.height - column.height) < 1e-6;
      expect(fillsWidth || fillsHeight).toBe(true);
      expect(placed.left + placed.width / 2).toBeCloseTo(column.left + column.width / 2);
      expect(placed.top + placed.height / 2).toBeCloseTo(column.top + column.height / 2);
    }
  });

  it('keeps the portrait image top-aligned and horizontally centered', () => {
    const placed = fitCoverImage(200, 100, { left: 72, top: 200, width: 468, height: 400 }, 'top');
    expect(placed).toEqual({ left: 72, top: 200, width: 468, height: 234 });
    const tall = fitCoverImage(100, 400, { left: 72, top: 200, width: 468, height: 400 }, 'top');
    expect(tall).toEqual({ left: 72 + (468 - 100) / 2, top: 200, width: 100, height: 400 });
  });
});

describe('writePatternPdf', () => {
  it('writes cover, legend and chart pages with metadata', async () => {
    const input = inputFor(withStitches(20, 15), { coverImagePng: png });
    const pdf = await load(await writePatternPdf(input));
    expect(pdf.getPageCount()).toBe(estimateTotalPages(20, 15, input.settings, legendRows(input)));
    expect(pdf.getPageCount()).toBe(3);
    expect(pdf.getTitle()).toBe('Test pattern');
    expect(pdf.getCreator()).toBe('Needlewise');
    expect(pdf.getSubject()).toContain(String(SYMBOL_POOL_VERSION));
    expect(pdf.getKeywords()).toContain(`symbol-pool-${String(SYMBOL_POOL_VERSION)}`);
    const size = pdf.getPage(0).getSize();
    expect(size.width).toBeCloseTo(PAPER_SIZES_PT.letter.width);
    expect(size.height).toBeCloseTo(PAPER_SIZES_PT.letter.height);
  });

  it('uses a landscape Letter page size', async () => {
    const input = inputFor(withStitches(5, 5), { settings: { ...DEFAULT_EXPORT_SETTINGS, orientation: 'landscape' } });
    const pdf = await load(await writePatternPdf(input));
    for (const page of pdf.getPages()) {
      expect(page.getWidth()).toBeCloseTo(792);
      expect(page.getHeight()).toBeCloseTo(612);
    }
  });

  it('writes a landscape cover with a preview image', async () => {
    const input = inputFor(withStitches(100, 80), { coverImagePng: png, settings: { ...DEFAULT_EXPORT_SETTINGS, orientation: 'landscape' } });
    const pdf = await load(await writePatternPdf(input));
    expect(pdf.getPageCount()).toBe(estimateTotalPages(100, 80, input.settings, legendRows(input)));
    expect(pdf.getPage(0).getSize()).toEqual({ width: 792, height: 612 });
  });

  it('uses A4 page size', async () => {
    const input = inputFor(withStitches(5, 5), { settings: { ...DEFAULT_EXPORT_SETTINGS, paper: 'a4' } });
    const pdf = await load(await writePatternPdf(input));
    for (const page of pdf.getPages()) {
      expect(page.getWidth()).toBeCloseTo(595.28);
      expect(page.getHeight()).toBeCloseTo(841.89);
    }
  });

  it.each([0, 1, 2, 3])('paginates a 100x80 pattern with overlap %i', async (overlap) => {
    const settings: ExportSettings = { ...DEFAULT_EXPORT_SETTINGS, overlap };
    const input = inputFor(withStitches(100, 80), { settings });
    const pdf = await load(await writePatternPdf(input));
    expect(pdf.getPageCount()).toBe(estimateTotalPages(100, 80, settings, legendRows(input)));
    expect(pdf.getPageCount()).toBeGreaterThan(3);
  });

  it.each(['symbol', 'color', 'combined'] as const)('renders chartStyle %s and page numbers off', async (chartStyle) => {
    const input = inputFor(withStitches(12, 12), { settings: { ...DEFAULT_EXPORT_SETTINGS, chartStyle, pageNumbers: false } });
    const pdf = await load(await writePatternPdf(input));
    expect(pdf.getPageCount()).toBe(3);
  });

  it('handles an empty pattern, a 1x1 pattern and no physical estimate', async () => {
    const empty = inputFor(patternOf(1, 1), {}, false);
    const pdf = await load(await writePatternPdf(empty));
    expect(pdf.getPageCount()).toBe(estimateTotalPages(1, 1, empty.settings, 0));
    const noAida = inputFor(withStitches(4, 4), {}, false);
    expect((await load(await writePatternPdf(noAida))).getPageCount()).toBe(3);
  });

  it('draws imperial units and many legend rows across legend pages', async () => {
    const document = patternOf(30, 30, (apply) => {
      for (let i = 0; i < 25; i += 1) apply(cell(30, { type: 'set-full', x: i, y: 0, color: 1 }));
    });
    const input = inputFor(document, { units: 'imperial' });
    expect((await load(await writePatternPdf(input))).getPageCount()).toBe(estimateTotalPages(30, 30, input.settings, legendRows(input)));
  });

  it('reports progress per page and honours cancellation', async () => {
    const input = inputFor(withStitches(100, 80));
    const seen: number[] = [];
    const total = estimateTotalPages(100, 80, input.settings, legendRows(input));
    await writePatternPdf(input, { onProgress: (progress) => { seen.push(progress.completed); expect(progress.total).toBe(total); } });
    expect(seen).toEqual(Array.from({ length: total }, (_, index) => index + 1));

    const controller = new AbortController();
    await expect(writePatternPdf(input, {
      signal: controller.signal,
      onProgress: ({ completed }) => { if (completed === 2) controller.abort(); }
    })).rejects.toBeInstanceOf(ExportCancelledError);
    const aborted = new AbortController();
    aborted.abort();
    await expect(writePatternPdf(input, { signal: aborted.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

/** Line segments stroked in `rgb` (0-1 channels, 3 decimals) on one page, in page points, y-up. */
async function strokedSegments(bytes: Uint8Array, pageIndex: number, rgb: string): Promise<Array<[number, number, number, number]>> {
  const pdf = await load(bytes);
  const contents = pdf.getPage(pageIndex).node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => pdf.context.lookup(ref)) : [contents];
  const text = streams.map((stream) => new TextDecoder().decode(decodePDFRawStream(stream as PDFRawStream).decode())).join('\n');
  const out: Array<[number, number, number, number]> = [];
  // Filled symbol outlines use `l` too, so a path's segments count only once it is stroked.
  let path: Array<[number, number, number, number]> = [];
  let stroke = '';
  let from: [number, number] | undefined;
  for (const raw of text.split('\n')) {
    const op = raw.trim().split(/\s+/);
    const name = op[op.length - 1];
    const nums = op.slice(0, -1).map(Number);
    if (name === 'RG') stroke = nums.map((n) => n.toFixed(3)).join(' ');
    else if (name === 'm') from = [nums[0], nums[1]];
    else if (name === 'l' && from) path.push([from[0], from[1], nums[0], nums[1]]);
    else if (name === 'S' || name === 'f' || name === 'B' || name === 'n') {
      if (name === 'S' && stroke === rgb) out.push(...path);
      path = [];
    }
  }
  return out;
}

/** Backstitch segments (stroked in palette color 2, #113) on one page, in page points, y-up. */
const backstitchSegments = (bytes: Uint8Array, pageIndex: number): Promise<Array<[number, number, number, number]>> =>
  strokedSegments(bytes, pageIndex, '0.067 0.067 0.200');

describe('center mark', () => {
  /** The center ink, #cc4422. */
  const CENTER = '0.800 0.267 0.133';
  const length = ([x1, y1, x2, y2]: [number, number, number, number]): number => Math.hypot(x2 - x1, y2 - y1);

  it('prints only the margin ticks by default', async () => {
    const bytes = await writePatternPdf(inputFor(withStitches(10, 10)));
    const segments = await strokedSegments(bytes, 2, CENTER);
    expect(segments).toHaveLength(4);
    segments.forEach((segment) => { expect(length(segment)).toBeLessThanOrEqual(5); });
  });

  it.each([
    // Both odd outlines the center cell; both even is a plus; a mix is an H or an I.
    ['a box', 9, 9, [['h', 1], ['h', 1], ['v', 1], ['v', 1]]],
    ['a plus', 10, 10, [['h', 2], ['v', 2]]],
    ['an H', 9, 10, [['h', 1], ['v', 2], ['v', 2]]],
    ['an I', 10, 9, [['h', 2], ['h', 2], ['v', 1]]]
  ] as const)('draws %s around a %ix%i center when enabled', async (_, width, height, expected) => {
    const settings = { ...DEFAULT_EXPORT_SETTINGS, centerMark: true };
    const cs = pageGeometry(settings).cellSizePt;
    const bytes = await writePatternPdf(inputFor(withStitches(width, height), { settings }));
    const marks = (await strokedSegments(bytes, 2, CENTER))
      .filter((segment) => length(segment) > 5)
      .map((segment) => [segment[0] === segment[2] ? 'v' : 'h', Math.round(length(segment) / cs)] as const)
      .sort();
    expect(marks).toEqual(expected);
  });

  it('places the segments in cell units', () => {
    expect(centerMarkSegments(10, 10)).toEqual([[5, 4, 5, 6], [4, 5, 6, 5]]);
    expect(centerMarkSegments(9, 10)).toEqual([[4, 4, 4, 6], [5, 4, 5, 6], [4, 5, 5, 5]]);
  });
});

describe('backstitch coordinates (fixed-point store, 4 units per cell)', () => {
  const cellsToPoints = (settings: ExportSettings, column: number, row: number, x0 = 0, y0 = 0): [number, number] => {
    const g = pageGeometry(settings);
    return [
      g.margin + AXIS_GUTTER_PT + (column - x0) * g.cellSizePt,
      g.pageHeight - (g.margin + HEADER_RESERVE_PT + AXIS_GUTTER_PT + (row - y0) * g.cellSizePt)
    ];
  };
  const withBackstitch = (width: number, height: number, start: [number, number], end: [number, number]): PatternDocument =>
    patternOf(width, height, (apply) => {
      apply({ type: 'add-backstitch', start: { x: start[0], y: start[1] }, end: { x: end[0], y: end[1] }, color: 2 });
    });

  it('draws a one-cell segment from cell (2,3) to (3,3), stored as (8,12)->(12,12)', async () => {
    const document = withBackstitch(10, 10, [8, 12], [12, 12]);
    expect([document.backstitches.x1[0], document.backstitches.y1[0], document.backstitches.x2[0]]).toEqual([8, 12, 12]);
    const bytes = await writePatternPdf(inputFor(document));
    const [x1, y1] = cellsToPoints(DEFAULT_EXPORT_SETTINGS, 2, 3);
    const [x2, y2] = cellsToPoints(DEFAULT_EXPORT_SETTINGS, 3, 3);
    const segments = await backstitchSegments(bytes, 2);
    expect(segments).toHaveLength(1);
    segments[0].forEach((value, index) => { expect(value).toBeCloseTo([x1, y1, x2, y2][index], 2); });
  });

  it('draws a diagonal in cell units', async () => {
    const bytes = await writePatternPdf(inputFor(withBackstitch(10, 10, [8, 8], [20, 16])));
    const [x1, y1] = cellsToPoints(DEFAULT_EXPORT_SETTINGS, 2, 2);
    const [x2, y2] = cellsToPoints(DEFAULT_EXPORT_SETTINGS, 5, 4);
    const [segment] = await backstitchSegments(bytes, 2);
    [x1, y1, x2, y2].forEach((value, index) => { expect(segment[index]).toBeCloseTo(value, 2); });
  });

  // The command splits a long backstitch at cell boundaries, so compare the drawn extent.
  const expectExtent = (segments: Array<[number, number, number, number]>, expected: [number, number, number, number]): void => {
    const drawn = segments.filter(([x1, y1, x2, y2]) => x1 !== x2 || y1 !== y2);
    expect(drawn.length).toBeGreaterThan(0);
    expect(Math.min(...drawn.map((segment) => Math.min(segment[0], segment[2])))).toBeCloseTo(expected[0], 2);
    expect(Math.max(...drawn.map((segment) => Math.max(segment[0], segment[2])))).toBeCloseTo(expected[2], 2);
    for (const segment of drawn) { expect(segment[1]).toBeCloseTo(expected[1], 2); expect(segment[3]).toBeCloseTo(expected[3], 2); }
  };

  it('does not draw a dot for a segment that only touches a page edge', async () => {
    const settings = DEFAULT_EXPORT_SETTINGS;
    const layout = layoutChartPages(60, 20, settings, 1);
    expect(layout.pages[0].x1).toBe(39);
    // Cell (39,5)->(40,5) starts exactly where page 0 ends and lies in page 1's overlap column.
    const touching = await writePatternPdf(inputFor(withBackstitch(60, 20, [39 * 4, 5 * 4], [40 * 4, 5 * 4]), { settings }));
    expect(await backstitchSegments(touching, layout.pages[0].pageNumber - 1)).toEqual([]);
    const next = await backstitchSegments(touching, layout.pages[1].pageNumber - 1);
    const [from, y] = cellsToPoints(settings, 39, 5, layout.pages[1].x0);
    const [to] = cellsToPoints(settings, 40, 5, layout.pages[1].x0);
    expectExtent(next, [from, y, to, y]);
    // A segment ending exactly at the edge from the inside still draws.
    const inside = await writePatternPdf(inputFor(withBackstitch(60, 20, [37 * 4, 5 * 4], [39 * 4, 5 * 4]), { settings }));
    const [a, ay] = cellsToPoints(settings, 37, 5);
    const [b] = cellsToPoints(settings, 39, 5);
    expectExtent(await backstitchSegments(inside, layout.pages[0].pageNumber - 1), [a, ay, b, ay]);
  });

  it('clips a segment that crosses a page boundary onto both pages', async () => {
    // Letter at 4 mm: 39 cells per page, overlap 1, so page 2 starts at column 38.
    const settings = { ...DEFAULT_EXPORT_SETTINGS, overlap: 1 };
    const layout = layoutChartPages(100, 20, settings, 1);
    expect(layout.pages[1].x0).toBe(38);
    const document = withBackstitch(100, 20, [36 * 4, 5 * 4], [42 * 4, 5 * 4]);
    const bytes = await writePatternPdf(inputFor(document, { settings }));
    const first = layout.pages[0];
    const second = layout.pages[1];
    const [a, ay] = cellsToPoints(settings, 36, 5);
    const [b] = cellsToPoints(settings, first.x1, 5);
    const onFirst = await backstitchSegments(bytes, first.pageNumber - 1);
    expectExtent(onFirst, [a, ay, b, ay]);
    const [c] = cellsToPoints(settings, second.x0, 5, second.x0);
    const [d] = cellsToPoints(settings, 42, 5, second.x0);
    const onSecond = await backstitchSegments(bytes, second.pageNumber - 1);
    expectExtent(onSecond, [c, ay, d, ay]);
  });
});
