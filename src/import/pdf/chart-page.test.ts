import { describe, expect, it } from 'vitest';
import { readChartPage } from './chart-page';
import { normalizeSvgPath, outlineKey } from './outline';
import type { PdfFillRect, PdfGrid, PdfMark, PdfPagePrimitives, PdfTextRun } from './types';

const PITCH = 10;
const LEFT = 100;
const TOP = 80;

function lattice(columns: number, rows: number): PdfGrid {
  return {
    xs: Array.from({ length: columns + 1 }, (_, i) => LEFT + i * PITCH),
    ys: Array.from({ length: rows + 1 }, (_, i) => TOP + i * PITCH),
    columns,
    rows,
    pitch: PITCH,
    bounds: { x: LEFT, y: TOP, width: columns * PITCH, height: rows * PITCH }
  };
}

const page = (parts: { marks?: PdfMark[]; fills?: PdfFillRect[]; text?: PdfTextRun[] }): PdfPagePrimitives => ({
  pageIndex: 2, width: 612, height: 792, strokes: [], marks: parts.marks ?? [], fills: parts.fills ?? [], text: parts.text ?? [], imageCoverage: 0
});

/** A mark of `size` (in pitches) centred on cell (column, row), optionally nudged. */
function mark(key: string, column: number, row: number, size = 0.6, nudge = 0): PdfMark {
  const side = size * PITCH;
  return {
    kind: 'glyph',
    bounds: { x: LEFT + (column + 0.5) * PITCH - side / 2 + nudge, y: TOP + (row + 0.5) * PITCH - side / 2 + nudge, width: side, height: side },
    symbolKey: key,
    outlineD: `M0 0L1 1Z ${key}`,
    ...(key === 'a' ? { unicode: '●' } : {}),
    color: '#000000'
  };
}

const cellFill = (column: number, row: number, color: `#${string}`, inset = 0): PdfFillRect => ({
  bounds: { x: LEFT + column * PITCH + inset, y: TOP + row * PITCH + inset, width: PITCH - 2 * inset, height: PITCH - 2 * inset },
  color
});

/** A ruler label centred at (x, y). */
const label = (text: string, x: number, y: number): PdfTextRun => ({ text, bounds: { x: x - 4, y: y - 3, width: 8, height: 6 }, fontSize: 6 });

describe('readChartPage', () => {
  it('assigns marks to the cells their centres fall in', () => {
    const grid = lattice(12, 10);
    const cells = readChartPage(page({
      marks: [
        mark('a', 0, 0),
        mark('b', 11, 9, 0.8, 1.5), // off-centre, still inside its cell
        mark('a', 4, 3),
        mark('c', 5, 5, 1.2), // larger than a cell: a legend glyph or decoration
        { ...mark('d', 0, 0), bounds: { x: LEFT - 20, y: TOP, width: 5, height: 5 } } // outside the lattice
      ]
    }), grid);
    expect(cells.columns).toBe(12);
    expect(cells.rows).toBe(10);
    expect(cells.pageIndex).toBe(2);
    expect(cells.keys[0]).toBe('a');
    expect(cells.keys[9 * 12 + 11]).toBe('b');
    expect(cells.keys[3 * 12 + 4]).toBe('a');
    expect(cells.keys[5 * 12 + 5]).toBeNull();
    expect(cells.keys.filter((key) => key !== null)).toHaveLength(3);
    expect([...cells.symbols.keys()].sort()).toEqual(['a', 'b']);
    expect(cells.symbols.get('a')).toEqual({ outlineD: 'M0 0L1 1Z a', unicode: '●' });
    expect(cells.symbols.get('b')).toEqual({ outlineD: 'M0 0L1 1Z b' });
    expect(cells.warnings).toEqual([]);
    expect(cells.rulerOffset).toBeUndefined();
  });

  it('keeps the largest mark of a two-symbol cell and warns', () => {
    const cells = readChartPage(page({ marks: [mark('small', 3, 2, 0.3, -2), mark('big', 3, 2, 0.5, 1)] }), lattice(10, 10));
    expect(cells.keys[2 * 10 + 3]).toBe('big');
    expect(cells.symbols.has('small')).toBe(false);
    expect(cells.warnings).toEqual([expect.objectContaining({ code: 'multi-symbol-cell', page: 2, cell: { x: 3, y: 2 } })]);
  });

  it('records fills that cover a cell, with white as empty', () => {
    const cells = readChartPage(page({
      fills: [
        cellFill(0, 0, '#FF0000'),
        cellFill(1, 0, '#00ff00', 0.4), // inset by the line width: still the cell's colour
        cellFill(2, 0, '#ffffff'),
        cellFill(3, 0, '#0000ff', 2), // a swatch inside the cell, not its background
        { bounds: { x: LEFT, y: TOP + PITCH, width: 3 * PITCH, height: PITCH }, color: '#808080' }, // a strip over three cells
        cellFill(4, 0, '#123456'),
        cellFill(4, 0, '#ffffff') // painted over in white
      ]
    }), lattice(10, 10));
    expect(cells.fills.slice(0, 5)).toEqual(['#ff0000', '#00ff00', null, null, null]);
    expect(cells.fills.slice(10, 13)).toEqual([null, null, null]);
  });

  it('reads small filled rectangles inside a cell as rectangular symbols', () => {
    const square = cellFill(2, 1, '#000000', 2.5); // 5x5 in a 10pt cell
    const tall = { bounds: { x: LEFT + 6 * PITCH + 3.5, y: TOP + 4 * PITCH + 1.5, width: 3, height: 7 }, color: '#000000' } as const;
    const cells = readChartPage(page({
      marks: [mark('a', 6, 4, 0.3)], // smaller than the rectangle it shares a cell with
      fills: [square, tall, cellFill(0, 0, '#ff0000'), cellFill(3, 3, '#00ff00', 1.5)] // 7x7: 0.7 of the cell
    }), lattice(10, 10));
    const squareD = normalizeSvgPath(`M ${String(LEFT + 22.5)} ${String(TOP + 12.5)} H ${String(LEFT + 27.5)} V ${String(TOP + 17.5)} H ${String(LEFT + 22.5)} Z`);
    expect(cells.keys[1 * 10 + 2]).toBe(outlineKey(squareD));
    expect(cells.symbols.get(outlineKey(squareD))).toEqual({ outlineD: squareD });
    expect(cells.keys[3 * 10 + 3]).toBe(outlineKey(squareD)); // equal outlines regardless of size
    const tallKey = cells.keys[4 * 10 + 6];
    expect(tallKey).not.toBe('a');
    expect(tallKey).not.toBe(outlineKey(squareD));
    expect(cells.warnings).toEqual([expect.objectContaining({ code: 'multi-symbol-cell', cell: { x: 6, y: 4 } })]);
    // A cell-covering fill stays a background colour, not a symbol.
    expect(cells.keys[0]).toBeNull();
    expect(cells.fills[0]).toBe('#ff0000');
    expect(cells.fills[1 * 10 + 2]).toBeNull();
  });

  it('reads inset squares in many colours as cell colours, not a symbol', () => {
    const colors = ['#ff0000', '#00ff00', '#0000ff', '#FFAA00'] as const;
    const fills = Array.from({ length: 100 }, (_, i) => cellFill(i % 10, Math.floor(i / 10), colors[(i * 7) % 4], 1.25)); // 0.75 of the cell
    const cells = readChartPage(page({ fills }), lattice(10, 10));
    expect(cells.symbols.size).toBe(0);
    expect(cells.keys.every((key) => key === null)).toBe(true);
    expect(cells.fills).toEqual(fills.map((fill) => fill.color.toLowerCase()));
    expect(cells.warnings).toEqual([]);
  });

  it('keeps a rectangle symbol drawn in two inks', () => {
    const fills = [cellFill(1, 1, '#000000', 2.5), cellFill(2, 2, '#ffffff', 2.5), cellFill(3, 3, '#000000', 2.5)];
    const cells = readChartPage(page({ fills }), lattice(10, 10));
    expect(cells.symbols.size).toBe(1);
    expect(cells.keys.filter((key) => key !== null)).toHaveLength(3);
  });

  it('reads ruler labels that sit on major boundaries', () => {
    // This page's top-left cell is chart column 40, row 20; labels count cells before each boundary.
    const grid = lattice(25, 22);
    const text = [
      label('50', LEFT + 10 * PITCH, TOP - 6),
      label('60', LEFT + 20 * PITCH, TOP - 6),
      label('30', LEFT - 8, TOP + 10 * PITCH),
      label('40', LEFT - 8, TOP + 20 * PITCH),
      label('7', 300, 760) // page number, far from the lattice
    ];
    expect(readChartPage(page({ text }), grid).rulerOffset).toEqual({ x: 40, y: 20 });
  });

  it('reads ruler labels centred on the cells they number', () => {
    // Needlewise's own export numbers the first cell and every tenth cell from 1.
    const grid = lattice(20, 20);
    const text = [
      label('41', LEFT + 0.5 * PITCH, TOP - 6),
      label('50', LEFT + 9.5 * PITCH, TOP - 6),
      label('60', LEFT + 19.5 * PITCH, TOP - 6),
      label('1', LEFT - 8, TOP + 0.5 * PITCH),
      label('10', LEFT - 8, TOP + 9.5 * PITCH)
    ];
    expect(readChartPage(page({ text }), grid).rulerOffset).toEqual({ x: 40, y: 0 });
  });

  it('omits the ruler offset when only one axis is labelled', () => {
    const text = [label('10', LEFT + 10 * PITCH, TOP - 6), label('Columns 1–20', LEFT, TOP - 20)];
    expect(readChartPage(page({ text }), lattice(20, 20)).rulerOffset).toBeUndefined();
  });
});
