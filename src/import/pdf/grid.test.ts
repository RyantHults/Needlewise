import { describe, expect, it } from 'vitest';
import { detectGrid } from './grid';
import type { PdfFillRect, PdfPagePrimitives, PdfStroke } from './types';

const page = (strokes: PdfStroke[], fills: PdfFillRect[] = []): PdfPagePrimitives => ({
  pageIndex: 0, width: 612, height: 792, marks: [], strokes, fills, text: [], imageCoverage: 0
});

const stroke = (x1: number, y1: number, x2: number, y2: number, width = 0.25): PdfStroke => ({ x1, y1, x2, y2, width, color: '#c8c8c8' });

interface Lattice { x: number; y: number; columns: number; rows: number; pitch: number; width?: (n: number) => number }

function latticeStrokes({ x, y, columns, rows, pitch, width = () => 0.25 }: Lattice): PdfStroke[] {
  const strokes: PdfStroke[] = [];
  for (let c = 0; c <= columns; c += 1) strokes.push(stroke(x + c * pitch, y, x + c * pitch, y + rows * pitch, width(c)));
  for (let r = 0; r <= rows; r += 1) strokes.push(stroke(x, y + r * pitch, x + columns * pitch, y + r * pitch, width(r)));
  return strokes;
}

describe('detectGrid', () => {
  it('finds a uniform lattice among noise strokes', () => {
    const grid = { x: 50, y: 60, columns: 20, rows: 15, pitch: 8 };
    const noise = [
      stroke(50 + 3.5 * 8, 60, 50 + 3.5 * 8, 60 + 15 * 8, 0.3), // misaligned full-height rule
      stroke(60, 40, 140, 40, 0.5), // title underline
      stroke(400, 300, 400, 305), // stray tick
      stroke(52, 61, 52, 63),
      stroke(30, 500, 580, 500, 1) // footer rule
    ];
    const result = detectGrid(page([...noise, ...latticeStrokes(grid)]));
    expect(result).not.toBeNull();
    expect(result?.columns).toBe(20);
    expect(result?.rows).toBe(15);
    expect(result?.pitch).toBeCloseTo(8);
    expect(result?.bounds).toEqual({ x: 50, y: 60, width: 160, height: 120 });
    expect(result?.xs[0]).toBeCloseTo(50);
    expect(result?.ys[15]).toBeCloseTo(180);
  });

  it('ignores a page frame, even one that sits a pitch outside the lattice', () => {
    const grid = { x: 48, y: 64, columns: 12, rows: 18, pitch: 8 };
    const frame = (l: number, t: number, r: number, b: number): PdfStroke[] =>
      [stroke(l, t, r, t, 1), stroke(l, b, r, b, 1), stroke(l, t, l, b, 1), stroke(r, t, r, b, 1)];
    const strokes = [...frame(20, 20, 592, 772), ...frame(40, 56, 48 + 13 * 8, 64 + 19 * 8), ...latticeStrokes(grid)];
    const result = detectGrid(page(strokes));
    expect(result?.columns).toBe(12);
    expect(result?.rows).toBe(18);
    expect(result?.bounds).toEqual({ x: 48, y: 64, width: 96, height: 144 });
  });

  it('reads a lattice drawn as thin filled rectangles', () => {
    const pitch = 10;
    const fills: PdfFillRect[] = [];
    for (let c = 0; c <= 14; c += 1) fills.push({ bounds: { x: 100 + c * pitch - 0.3, y: 100, width: 0.6, height: 12 * pitch }, color: '#000000' });
    for (let r = 0; r <= 12; r += 1) fills.push({ bounds: { x: 100, y: 100 + r * pitch - 0.3, width: 14 * pitch, height: 0.6 }, color: '#000000' });
    // Cell backgrounds and a wide tint strip are fills too, and must not read as lines.
    fills.push({ bounds: { x: 100, y: 100, width: pitch, height: pitch }, color: '#ff0000' });
    fills.push({ bounds: { x: 100 + 13 * pitch, y: 100, width: pitch, height: 12 * pitch }, color: '#808080' });
    const result = detectGrid(page([], fills));
    expect(result?.columns).toBe(14);
    expect(result?.rows).toBe(12);
    expect(result?.pitch).toBeCloseTo(10);
  });

  it('detects the major-line interval from heavier strokes', () => {
    // A page cut from the middle of a chart: chart column 37 is its first, so majors fall 3 cells in.
    const width = (n: number): number => {
      const chart = n + 37;
      return chart % 10 === 0 ? 0.9 : chart % 5 === 0 ? 0.5 : 0.25;
    };
    const lattice = { x: 40, y: 40, columns: 30, rows: 30, pitch: 7, width };
    const border = [stroke(40, 40, 250, 40, 1), stroke(40, 250, 250, 250, 1), stroke(40, 40, 40, 250, 1), stroke(250, 40, 250, 250, 1)];
    const result = detectGrid(page([...latticeStrokes(lattice), ...border]));
    expect(result?.columns).toBe(30);
    expect(result?.majorEvery).toBe(10);
  });

  it('leaves majorEvery undefined when every line has the same weight', () => {
    expect(detectGrid(page(latticeStrokes({ x: 0, y: 0, columns: 10, rows: 10, pitch: 9 })))?.majorEvery).toBeUndefined();
  });

  it('rejects lattices smaller than 10x10 and key tables', () => {
    expect(detectGrid(page(latticeStrokes({ x: 0, y: 0, columns: 9, rows: 30, pitch: 8 })))).toBeNull();
    // A key table: evenly spaced row rules, a handful of irregular column rules.
    const table: PdfStroke[] = [];
    for (let r = 0; r <= 20; r += 1) table.push(stroke(50, 100 + r * 14, 550, 100 + r * 14));
    for (const x of [50, 90, 160, 380, 550]) table.push(stroke(x, 100, x, 380));
    expect(detectGrid(page(table))).toBeNull();
    expect(detectGrid(page([]))).toBeNull();
  });
});
