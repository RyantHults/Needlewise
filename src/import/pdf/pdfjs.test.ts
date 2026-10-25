import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb } from 'pdf-lib';
import type { PDFPageProxy } from 'pdfjs-dist';
import { describe, expect, it } from 'vitest';
import { DrawOps, glyphOutline, loadPdfjs, openPdf, type Pdfjs } from './pdfjs';

// Vitest's jsdom URL is not a file URL, so fonts resolve from the repo root.
const fontBytes = (file: string): Uint8Array => new Uint8Array(readFileSync(resolve(process.cwd(), 'fonts', file)));

type Matrix = [number, number, number, number, number, number];

interface Op {
  readonly fn: number;
  readonly args: unknown[];
  /** Current transformation matrix before the op runs. */
  readonly ctm: Matrix;
}

const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]
];

/** Flatten the operator list with the CTM each op sees. */
async function operators(pdfjs: Pdfjs, page: PDFPageProxy): Promise<Op[]> {
  const list = await page.getOperatorList();
  const stack: Matrix[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  return list.fnArray.map((fn, i) => {
    const args = (list.argsArray[i] ?? []) as unknown[];
    const op = { fn, args, ctm };
    if (fn === pdfjs.OPS.save) stack.push(ctm);
    if (fn === pdfjs.OPS.restore) ctm = stack.pop() ?? ctm;
    if (fn === pdfjs.OPS.transform) ctm = multiply(ctm, args as Matrix);
    return op;
  });
}

/** `constructPath` operands: [paint op, [path buffer | null], bbox | null]. */
const pathOf = (op: Op): { paint: number; buffer: Float32Array } =>
  ({ paint: op.args[0] as number, buffer: (op.args[1] as [Float32Array])[0] });

const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function bounds(path: ArrayLike<number>): { w: number; h: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < path.length;) {
    const op = path[i++];
    const pairs = op === DrawOps.curveTo ? 3 : op === DrawOps.quadraticCurveTo ? 2 : op === DrawOps.closePath ? 0 : 1;
    for (let p = 0; p < pairs; p += 1) {
      xs.push(path[i++]);
      ys.push(path[i++]);
    }
  }
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

async function syntheticChart(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes('NotoSansSymbols2-Regular.ttf'), { subset: true });
  const page = doc.addPage([200, 200]);
  page.drawRectangle({ x: 10, y: 20, width: 30, height: 40, color: rgb(1, 0, 0), borderWidth: 0 });
  page.drawLine({ start: { x: 0, y: 100 }, end: { x: 200, y: 100 }, thickness: 0.5, color: rgb(0, 0, 1) });
  page.drawLine({ start: { x: 120, y: 0 }, end: { x: 120, y: 200 }, thickness: 1.5, color: rgb(0, 0, 0) });
  page.drawText('■▲■', { x: 50, y: 50, size: 12, font, color: rgb(0, 0.5, 0) });
  return doc.save();
}

describe('pdf.js loader', () => {
  it('loads once and runs without a browser worker', async () => {
    const pdfjs = await loadPdfjs();
    expect(await loadPdfjs()).toBe(pdfjs);
  });

  it('exposes showText glyphs, their font and per-glyph outlines', async () => {
    const pdfjs = await loadPdfjs();
    const pdf = await openPdf(await syntheticChart());
    const page = await pdf.getPage(1);
    const ops = await operators(pdfjs, page);

    const setFont = ops.find((op) => op.fn === pdfjs.OPS.setFont);
    const showText = ops.find((op) => op.fn === pdfjs.OPS.showText);
    expect(setFont && showText).toBeTruthy();
    if (!setFont || !showText) return;
    const [fontName, size] = setFont.args as [string, number];
    expect(size).toBe(12);
    expect((page.commonObjs.get(fontName) as { name: string }).name).toMatch(/NotoSansSymbols2/);

    const glyphs = (showText.args[0] as Array<{ fontChar: string; unicode: string; width: number } | number>)
      .filter((glyph) => typeof glyph === 'object');
    expect(glyphs.map((glyph) => glyph.unicode)).toEqual(['■', '▲', '■']);
    // Repeated glyphs share a fontChar, so they share one outline.
    expect(glyphs[0].fontChar).toBe(glyphs[2].fontChar);
    expect(glyphs[0].fontChar).not.toBe(glyphs[1].fontChar);

    const square = glyphOutline(page, fontName, glyphs[0].fontChar);
    const triangle = glyphOutline(page, fontName, glyphs[1].fontChar);
    expect(square?.[0]).toBe(DrawOps.moveTo);
    expect(triangle?.[0]).toBe(DrawOps.moveTo);
    if (!square || !triangle) return;
    // Outlines are in em units: the font matrix is already applied.
    const box = bounds(square);
    expect(box.w).toBeGreaterThan(0.3);
    expect(box.w).toBeLessThan(1);
    expect(box.h).toBeCloseTo(box.w, 2);
    expect(Array.from(triangle)).not.toEqual(Array.from(square));
    expect(glyphOutline(page, fontName, 'missing')).toBeNull();

    const fill = ops.filter((op) => op.fn === pdfjs.OPS.setFillRGBColor).map((op) => op.args[0]);
    expect(fill).toEqual(['#ff0000', '#008000']);
    await pdf.loadingTask.destroy();
  });

  it('reports stroke and fill geometry through constructPath', async () => {
    const pdfjs = await loadPdfjs();
    const pdf = await openPdf(await syntheticChart());
    const page = await pdf.getPage(1);
    const ops = await operators(pdfjs, page);
    const paths = ops.filter((op) => op.fn === pdfjs.OPS.constructPath);

    const strokes = paths.filter((op) => pathOf(op).paint === pdfjs.OPS.stroke);
    expect(strokes).toHaveLength(2);
    const ends = strokes.map((op) => {
      const { buffer } = pathOf(op);
      return [...apply(op.ctm, buffer[buffer.length - 5], buffer[buffer.length - 4]), ...apply(op.ctm, buffer[buffer.length - 2], buffer[buffer.length - 1])];
    });
    expect(ends).toEqual([[0, 100, 200, 100], [120, 0, 120, 200]]);
    const widths = ops.filter((op) => op.fn === pdfjs.OPS.setLineWidth).map((op) => op.args[0]);
    expect(widths).toContain(0.5);
    expect(widths).toContain(1.5);
    expect(ops.filter((op) => op.fn === pdfjs.OPS.setStrokeRGBColor).map((op) => op.args[0])).toEqual(['#0000ff', '#000000']);

    const fills = paths.filter((op) => pathOf(op).paint === pdfjs.OPS.fill);
    expect(fills).toHaveLength(1);
    const rect = fills[0];
    // bbox operand is in the path's own space; the CTM places it on the page.
    const [x0, y0, x1, y1] = rect.args[2] as Float32Array;
    expect([...apply(rect.ctm, x0, y0), ...apply(rect.ctm, x1, y1)]).toEqual([10, 20, 40, 60]);
    await pdf.loadingTask.destroy();
  });
});
