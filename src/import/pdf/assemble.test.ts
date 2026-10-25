import { describe, expect, it } from 'vitest';
import type { ImportColor } from '../types';
import { assembleChart } from './assemble';
import type { ChartPageCells, PdfGrid } from './types';

const SYMBOLS = ['a', 'b', 'c', 'd', 'e'];

/** A deterministic chart with no repeated columns or rows, so only the true overlap matches. */
function chart(width: number, height: number): Array<string | null> {
  let seed = 7;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  return Array.from({ length: width * height }, () => {
    const roll = next();
    return roll < 0.15 ? null : SYMBOLS[Math.floor(roll * 997) % SYMBOLS.length];
  });
}

/** Axis spans as Needlewise's exporter cuts them: equal pages, the last one shorter. */
function spans(total: number, size: number, overlap: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let start = 0; ; start += size - overlap) {
    const end = Math.min(total, start + size);
    out.push([start, end]);
    if (end >= total) return out;
  }
}

const grid = (columns: number, rows: number): PdfGrid => ({ xs: [], ys: [], columns, rows, pitch: 8, bounds: { x: 0, y: 0, width: columns * 8, height: rows * 8 } });

function paginate(
  cells: ReadonlyArray<string | null>, width: number, height: number, pageWidth: number, pageHeight: number, overlap: number, rulers = false
): ChartPageCells[] {
  const pages: ChartPageCells[] = [];
  for (const [y0, y1] of spans(height, pageHeight, overlap)) {
    for (const [x0, x1] of spans(width, pageWidth, overlap)) {
      const columns = x1 - x0;
      const rows = y1 - y0;
      const keys: Array<string | null> = [];
      for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) keys.push(cells[y * width + x]);
      pages.push({
        pageIndex: pages.length + 3,
        grid: grid(columns, rows),
        columns,
        rows,
        keys,
        fills: keys.map((key): ImportColor | null => (key === 'a' ? '#ff0000' : null)),
        symbols: new Map(keys.filter((key): key is string => key !== null).map((key) => [key, { outlineD: `M${key}` }])),
        ...(rulers ? { rulerOffset: { x: x0, y: y0 } } : {}),
        warnings: []
      });
    }
  }
  return pages;
}

describe('assembleChart', () => {
  const width = 25;
  const height = 22;
  const source = chart(width, height);

  it('assembles a 2x2 page layout without overlap', () => {
    const pages = paginate(source, width, height, 15, 12, 0);
    expect(pages.map((page) => [page.columns, page.rows])).toEqual([[15, 12], [10, 12], [15, 10], [10, 10]]);
    const result = assembleChart(pages);
    expect([result.width, result.height]).toEqual([width, height]);
    expect(result.keys).toEqual(source);
    expect(result.fills.filter((fill) => fill !== null)).toHaveLength(source.filter((key) => key === 'a').length);
    expect(result.overlap).toBe(0);
    expect([...result.placements]).toEqual([[3, { x: 0, y: 0 }], [4, { x: 15, y: 0 }], [5, { x: 0, y: 12 }], [6, { x: 15, y: 12 }]]);
    expect([...result.symbols.keys()].sort()).toEqual(SYMBOLS);
    expect(result.warnings).toEqual([]);
  });

  it.each([1, 2, 3])('detects an overlap of %i', (overlap) => {
    const pages = paginate(source, width, height, 15, 12, overlap);
    const result = assembleChart(pages);
    expect(result.overlap).toBe(overlap);
    expect(result.keys).toEqual(source);
    expect(result.warnings).toEqual([]);
  });

  it('detects the overlap and the row break for equal-sized pages', () => {
    // 28x24 cut into 15x13 pages with overlap 2: four equal pages that would also fit one row or one column.
    const equal = chart(28, 24);
    const pages = paginate(equal, 28, 24, 15, 13, 2);
    expect(new Set(pages.map((page) => `${String(page.columns)}x${String(page.rows)}`)).size).toBe(1);
    const result = assembleChart(pages);
    expect(result.overlap).toBe(2);
    expect([result.width, result.height]).toEqual([28, 24]);
    expect(result.keys).toEqual(equal);
  });

  it('reports no overlap when solid edges match at every overlap', () => {
    const solid = new Array<string | null>(24 * 10).fill('a');
    const result = assembleChart(paginate(solid, 24, 10, 12, 10, 0));
    expect(result.overlap).toBe(0);
    expect(result.keys).toHaveLength(240);
    expect(result.warnings).toEqual([]);
  });

  it('detects a true overlap of 2 inside a mostly solid chart', () => {
    // One varied row in a tall solid chart: every k scores within 0.02 of 1, and only k=2 matches the varied cells.
    const mostlySolid = Array.from({ length: 22 * 60 }, (_, i) => (Math.floor(i / 22) === 30 ? SYMBOLS[i % 22 % 5] : 'a'));
    const result = assembleChart(paginate(mostlySolid, 22, 60, 12, 60, 2));
    expect(result.overlap).toBe(2);
    expect([result.width, result.height]).toEqual([22, 60]);
    expect(result.keys).toEqual(mostlySolid);
  });

  it('ignores an overlap with too few compared cells', () => {
    // Two 12x10 pages whose only non-empty edge cells are three matching rows (six pairs): below the sample minimum.
    const sparse = new Array<string | null>(22 * 10).fill(null);
    for (const row of [1, 4, 7]) {
      sparse[row * 22 + 10] = SYMBOLS[row % 5];
      sparse[row * 22 + 11] = SYMBOLS[(row + 1) % 5];
    }
    expect(assembleChart(paginate(sparse, 22, 10, 12, 10, 2)).overlap).toBe(0);
  });

  it('warns about cells that disagree inside an overlap and keeps the first page', () => {
    const pages = paginate(source, width, height, 15, 12, 2);
    // Page 4 (top right) starts at chart column 13; its first column repeats page 3's column 13.
    const right = pages[1];
    const keys = [...right.keys];
    keys[5 * right.columns] = keys[5 * right.columns] === 'e' ? 'd' : 'e';
    pages[1] = { ...right, keys };
    const result = assembleChart(pages);
    expect(result.keys).toEqual(source);
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'overlap-mismatch', page: 4, cell: { x: 13, y: 5 } })]);
  });

  it('places pages by their ruler offsets when every page has one', () => {
    const pages = paginate(source, width, height, 15, 12, 1, true);
    const result = assembleChart([pages[3], pages[0], pages[2], pages[1]]);
    expect(result.keys).toEqual(source);
    expect(result.overlap).toBe(1);
    expect(result.placements.get(6)).toEqual({ x: 14, y: 11 });
  });

  it('starts a ruler-placed chart at 0,0 when its first pages are missing', () => {
    // Only the right-hand pages: their rulers start at chart column 14.
    const pages = paginate(source, width, height, 15, 12, 1, true).filter((page) => page.rulerOffset?.x === 14);
    const result = assembleChart(pages);
    expect([result.width, result.height]).toEqual([11, height]);
    expect(result.placements.get(4)).toEqual({ x: 0, y: 0 });
    expect(result.placements.get(6)).toEqual({ x: 0, y: 11 });
    expect(result.keys.slice(0, 11)).toEqual(source.slice(14, 25));
  });

  it.each([
    ['a gap between pages', { x: 30, y: 0 }],
    ['pages repeating more than three cells', { x: 5, y: 0 }]
  ])('falls back to reading order when ruler offsets leave %s', (_, misread) => {
    const pages = paginate(source, width, height, 15, 12, 0, true);
    pages[1] = { ...pages[1], rulerOffset: misread };
    const result = assembleChart(pages);
    expect([result.width, result.height]).toEqual([width, height]);
    expect(result.keys).toEqual(source);
    expect(result.placements.get(4)).toEqual({ x: 15, y: 0 });
  });

  it('moves page warnings into chart coordinates', () => {
    const pages = paginate(source, width, height, 15, 12, 0);
    pages[3] = { ...pages[3], warnings: [{ code: 'multi-symbol-cell', message: 'two symbols', page: 6, cell: { x: 1, y: 2 } }] };
    expect(assembleChart(pages).warnings).toEqual([expect.objectContaining({ code: 'multi-symbol-cell', cell: { x: 16, y: 14 } })]);
  });

  it('warns when the page sizes form no consistent grid', () => {
    const pages = paginate(source, width, height, 15, 12, 0);
    pages[2] = { ...pages[2], columns: 14, grid: grid(14, 10), keys: pages[2].keys.slice(0, 140), fills: pages[2].fills.slice(0, 140) };
    const result = assembleChart(pages);
    expect(result.warnings.map((warning) => warning.code)).toContain('uneven-page-grid');
    expect(result.height).toBe(12);
  });

  it('returns an empty chart for no pages', () => {
    const result = assembleChart([]);
    expect([result.width, result.height, result.keys.length]).toEqual([0, 0, 0]);
    expect(result.warnings).toEqual([]);
  });
});
