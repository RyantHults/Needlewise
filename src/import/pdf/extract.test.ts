import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import {
  beginText,
  endText,
  fill,
  moveText,
  nextLine,
  PDFArray,
  PDFDocument,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames,
  popGraphicsState,
  pushGraphicsState,
  concatTransformationMatrix,
  rectangle,
  rgb,
  setCharacterSpacing,
  setCharacterSqueeze,
  setFillingRgbColor,
  setFontAndSize,
  setLineHeight,
  setTextMatrix,
  setTextRenderingMode,
  setTextRise,
  showText,
  StandardFonts,
  TextRenderingMode,
  type PDFFont,
  type PDFPage
} from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG_DEFINITION } from '../../catalog';
import { computePatternMetrics, createDocument } from '../../domain';
import { DEFAULT_EXPORT_SETTINGS } from '../../export/export-settings';
import { writePatternPdf } from '../../export/pdf-writer';
import { getSymbolOutline } from '../../symbols';
import { extractPagePrimitives, readPdfTitle } from './extract';
import { normalizeSvgPath, outlineDistance } from './outline';
import { openPdf } from './pdfjs';
import type { PdfMark, PdfPagePrimitives } from './types';
import { applyCommand, cell } from '../../domain/test-fixtures';

// Vitest's jsdom URL is not a file URL, so fonts resolve from the repo root.
const fontBytes = (file: string): Uint8Array => new Uint8Array(readFileSync(resolve(process.cwd(), 'fonts', file)));
const SYMBOLS_FONT = fontBytes('NotoSansSymbols2-Regular.ttf');
const SQUARE = '■';
// 1x1 PNG.
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

const W = 400;
const H = 800;

const open: PDFDocumentProxy[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((pdf) => pdf.loadingTask.destroy()));
});

async function load(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const pdf = await openPdf(bytes);
  open.push(pdf);
  return pdf;
}

/** The ■ glyph's ink box and advance, in em, straight from the font file. */
function squareMetrics(): { minX: number; minY: number; maxX: number; maxY: number; advance: number } {
  const font = fontkit.create(Buffer.from(SYMBOLS_FONT)) as unknown as {
    unitsPerEm: number;
    glyphForCodePoint(cp: number): { bbox: { minX: number; minY: number; maxX: number; maxY: number }; advanceWidth: number };
  };
  const glyph = font.glyphForCodePoint(SQUARE.codePointAt(0) ?? 0);
  const em = font.unitsPerEm;
  return { minX: glyph.bbox.minX / em, minY: glyph.bbox.minY / em, maxX: glyph.bbox.maxX / em, maxY: glyph.bbox.maxY / em, advance: glyph.advanceWidth / em };
}

const showAdjusted = (page: PDFPage, items: Array<ReturnType<PDFFont['encodeText']> | number>): PDFOperator => {
  const array = PDFArray.withContext(page.doc.context);
  for (const item of items) array.push(typeof item === 'number' ? PDFNumber.of(item) : item);
  return PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [array]);
};

async function textPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(SYMBOLS_FONT, { subset: true });
  const page = doc.addPage([W, H]);
  const name = page.node.newFontDictionary(font.name, font.ref);
  const square = font.encodeText(SQUARE);
  page.pushOperators(
    setFillingRgbColor(0, 0.5, 0),
    // A: plain.
    beginText(), setFontAndSize(name, 12), setTextMatrix(1, 0, 0, 1, 50, 700), showText(square), endText(),
    // B: character spacing, 50% horizontal scale and a TJ adjustment.
    beginText(), setFontAndSize(name, 10), setCharacterSpacing(2), setCharacterSqueeze(50), setTextMatrix(1, 0, 0, 1, 50, 650),
    showAdjusted(page, [square, -500, square]), setCharacterSqueeze(100), setCharacterSpacing(0), endText(),
    // C: Td, then T* with leading.
    beginText(), setFontAndSize(name, 8), setLineHeight(14), moveText(100, 600), showText(square), nextLine(), showText(square), endText(),
    // D: text rise.
    beginText(), setFontAndSize(name, 8), setTextRise(3), setTextMatrix(1, 0, 0, 1, 200, 600), showText(square), setTextRise(0), endText(),
    // E: under a scaling CTM.
    pushGraphicsState(), concatTransformationMatrix(2, 0, 0, 2, 0, 0),
    beginText(), setFontAndSize(name, 6), setTextMatrix(1, 0, 0, 1, 30, 100), showText(square), endText(), popGraphicsState(),
    // F: invisible, like an OCR layer.
    beginText(), setFontAndSize(name, 12), setTextRenderingMode(TextRenderingMode.Invisible), setTextMatrix(1, 0, 0, 1, 300, 300), showText(square), endText()
  );
  return doc.save();
}

async function shapesPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('  Rose Garden ');
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([W, H]);
  page.drawRectangle({ x: 10, y: 20, width: 30, height: 40, color: rgb(1, 0, 0), borderWidth: 0 });
  page.pushOperators(
    pushGraphicsState(), setFillingRgbColor(0, 0, 1),
    // One fill painting three adjacent cell backgrounds.
    rectangle(100, 100, 10, 10), rectangle(110, 100, 10, 10), rectangle(120, 100, 10, 10), fill(),
    // A hollow square: nested rectangles, even-odd.
    rectangle(200, 100, 20, 20), rectangle(205, 105, 10, 10), PDFOperator.of(PDFOperatorNames.FillEvenOdd),
    popGraphicsState()
  );
  page.drawSvgPath('M 0 0 L 10 0 L 5 -8 Z', { x: 300, y: 300, color: rgb(0, 0, 0) });
  page.drawRectangle({ x: 50, y: 500, width: 100, height: 50, borderColor: rgb(0, 0, 0), borderWidth: 1 });
  page.drawLine({ start: { x: 0, y: 400 }, end: { x: 400, y: 400 }, thickness: 0.5, color: rgb(0, 0, 1) });
  page.drawLine({ start: { x: 250, y: 0 }, end: { x: 250, y: 800 }, thickness: 1.5, color: rgb(0, 0, 0) });
  page.drawLine({ start: { x: 0, y: 0 }, end: { x: 100, y: 100 }, thickness: 1, color: rgb(0, 0, 0) });
  page.drawText('DMC 310', { x: 50, y: 300, size: 10, font: helvetica });

  const imagePage = doc.addPage([W, H]);
  imagePage.drawImage(await doc.embedPng(png), { x: 0, y: 0, width: W, height: H / 2 });
  return doc.save();
}

const near = (actual: number, expected: number, tolerance = 0.05): void => {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThan(tolerance);
};

describe('extractPagePrimitives: text', () => {
  it('places glyph ink bounds through the text state and CTM', async () => {
    const pdf = await load(await textPdf());
    const page = await extractPagePrimitives(pdf, 0);
    const g = squareMetrics();
    expect(page.width).toBe(W);
    expect(page.height).toBe(H);
    expect(page.marks).toHaveLength(7);
    expect(page.marks.every((mark) => mark.kind === 'glyph' && mark.unicode === SQUARE && mark.color === '#008000')).toBe(true);

    /** Expected y-down bounds for a glyph whose origin is (ox, oy) in y-up page space. */
    const box = (ox: number, oy: number, size: number, h = 1): [number, number, number, number] =>
      [ox + g.minX * size * h, H - (oy + g.maxY * size), (g.maxX - g.minX) * size * h, (g.maxY - g.minY) * size];
    const advance = g.advance * 10 + 2;
    const expected = [
      box(50, 700, 12),
      box(50, 650, 10, 0.5),
      box(50 + 0.5 * (advance + 5), 650, 10, 0.5),
      box(100, 600, 8),
      box(100, 586, 8),
      box(200, 603, 8),
      box(60, 200, 12)
    ];
    page.marks.forEach((mark, i) => {
      const [x, y, width, height] = expected[i];
      near(mark.bounds.x, x);
      near(mark.bounds.y, y);
      near(mark.bounds.width, width);
      near(mark.bounds.height, height);
    });

    // One glyph at any size or position is one symbol; the squeezed ones are another shape.
    const keys = page.marks.map((mark) => mark.symbolKey);
    expect(new Set([keys[0], ...keys.slice(3)]).size).toBe(1);
    expect(keys[1]).toBe(keys[2]);
    expect(keys[1]).not.toBe(keys[0]);
  });
});

describe('extractPagePrimitives: paths, images and text runs', () => {
  it('splits fills, strokes and path marks', async () => {
    const pdf = await load(await shapesPdf());
    const page = await extractPagePrimitives(pdf, 0);

    expect(page.fills.map((f) => [f.bounds.x, f.bounds.y, f.bounds.width, f.bounds.height, f.color])).toEqual([
      [10, H - 60, 30, 40, '#ff0000'],
      [100, H - 110, 10, 10, '#0000ff'],
      [110, H - 110, 10, 10, '#0000ff'],
      [120, H - 110, 10, 10, '#0000ff']
    ]);

    expect(page.marks.map((mark) => mark.kind)).toEqual(['path', 'path']);
    const [hollow, triangle] = page.marks;
    expect(hollow.bounds).toEqual({ x: 200, y: H - 120, width: 20, height: 20 });
    expect(hollow.outlineD).toBe(normalizeSvgPath('M0 1H1V0H0Z M0.25 0.75H0.75V0.25H0.25Z'));
    expect(triangle.color).toBe('#000000');
    // SVG y runs down, so the apex at -8 sits above the base at y = 300.
    expect(triangle.bounds).toEqual({ x: 300, y: H - 308, width: 10, height: 8 });

    const strokes = page.strokes.map((s) => [s.x1, s.y1, s.x2, s.y2, s.width, s.color]);
    // The bordered rectangle yields its four edges; the diagonal line yields nothing.
    expect(strokes).toHaveLength(6);
    expect(strokes).toContainEqual([0, H - 400, 400, H - 400, 0.5, '#0000ff']);
    expect(strokes).toContainEqual([250, H, 250, 0, 1.5, '#000000']);
    const edges = strokes.filter((s) => s[4] === 1);
    expect(edges).toHaveLength(4);
    for (const [x1, y1, x2, y2] of edges) {
      expect([x1, x2].every((x) => x === 50 || x === 150)).toBe(true);
      expect([y1, y2].every((y) => y === H - 500 || y === H - 550)).toBe(true);
    }

    const run = page.text.find((t) => t.text === 'DMC 310');
    expect(run).toBeDefined();
    near(run?.bounds.x ?? 0, 50);
    near(run?.bounds.y ?? 0, H - 310);
    near(run?.fontSize ?? 0, 10);
    expect(run?.bounds.width ?? 0).toBeGreaterThan(30);
    expect(page.imageCoverage).toBe(0);
  });

  it('measures painted image area', async () => {
    const pdf = await load(await shapesPdf());
    const page = await extractPagePrimitives(pdf, 1);
    expect(page.pageIndex).toBe(1);
    near(page.imageCoverage, 0.5, 1e-6);
    expect(page.marks).toHaveLength(0);
  });

  it('reads the document title', async () => {
    expect(await readPdfTitle(await load(await shapesPdf()))).toBe('Rose Garden');
    const untitled = await PDFDocument.create();
    untitled.addPage();
    expect(await readPdfTitle(await load(await untitled.save()))).toBeUndefined();
  });

  it('stops when cancelled', async () => {
    const pdf = await load(await shapesPdf());
    const controller = new AbortController();
    controller.abort();
    await expect(extractPagePrimitives(pdf, 0, controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('extractPagePrimitives: Needlewise round trip', () => {
  it('recovers pool symbols as path marks with one key per symbol', async () => {
    let document = createDocument({
      catalog: DEFAULT_CATALOG_DEFINITION.association,
      width: 12,
      height: 12,
      palette: [{ name: 'Red', color: '#d33' }, { name: 'Blue', color: '#113' }, { name: 'Green', color: '#3a3' }]
    });
    for (let y = 0; y < 12; y += 1) {
      for (let x = 0; x < 12; x += 1) {
        document = applyCommand(document, cell(12, { type: 'set-full', x, y, color: 1 + ((x + y) % 3) })).document;
      }
    }
    const bytes = await writePatternPdf({
      document,
      metrics: computePatternMetrics(document, { aidaCount: 14, strands: 2, waste: 0.1 }),
      settings: DEFAULT_EXPORT_SETTINGS,
      units: 'metric',
      name: 'Round trip',
      fontBytes: fontBytes('LibertinusMath-Regular.ttf')
    });
    const pdf = await load(bytes);
    const pages: PdfPagePrimitives[] = [];
    for (let i = 0; i < pdf.numPages; i += 1) pages.push(await extractPagePrimitives(pdf, i));
    const chart = pages[pages.length - 1];
    const legend = pages[1];

    const sources = document.palette.map((entry) => getSymbolOutline(entry.symbol)?.d ?? '');
    // Quadratic sources check the writer's exact Q→C conversion.
    expect(sources.some((d) => /Q/.test(d))).toBe(true);
    const pool = sources.map(normalizeSvgPath);
    const matches = (marks: readonly PdfMark[], d: string): PdfMark[] =>
      marks.filter((mark) => mark.kind === 'path' && outlineDistance(mark.outlineD, d) < 0.004);

    const chartKeys = pool.map((d) => {
      const found = matches(chart.marks, d);
      // Every cell of this color carries the symbol, under one key.
      expect(found).toHaveLength(48);
      expect(new Set(found.map((mark) => mark.symbolKey)).size).toBe(1);
      return found[0].symbolKey;
    });
    expect(new Set(chartKeys).size).toBe(3);
    // The legend draws the same symbols at another size: same keys.
    for (const [i, d] of pool.entries()) expect(matches(legend.marks, d)[0]?.symbolKey).toBe(chartKeys[i]);
    // And the symbols stay clearly apart from each other.
    expect(outlineDistance(pool[0], pool[1])).toBeGreaterThan(0.02);
    expect(outlineDistance(pool[1], pool[2])).toBeGreaterThan(0.02);
  });
});
