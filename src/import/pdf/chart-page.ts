// Reads one chart page's cells from its primitives and detected lattice.
// Pure: no pdf.js import.
import type { ImportColor, ImportWarning } from '../types';
import { normalizeSvgPath, outlineKey } from './outline';
import type { ChartPageCells, ChartPageSymbol, PdfFillRect, PdfGrid, PdfMark, PdfPagePrimitives, Rect } from './types';
import { rectCenter } from './types';

/** A mark larger than this fraction of the pitch is not a cell symbol. */
const MAX_MARK_PITCH = 0.9;
/** A fill records a cell's colour when each side is within this fraction of the cell's. */
const FILL_SIZE_TOLERANCE = 0.1;
/** A fill no larger than this fraction of its cell on each side is a rectangular symbol, not the background. */
const MAX_FILL_MARK_CELL = 0.8;
/** Rectangle marks sharing one outline in this many colours on a page are colour blocks, not a symbol. */
const MIN_BLOCK_COLORS = 3;
/** A ruler label may sit at most this many pitches (or font sizes) outside the lattice. */
const RULER_REACH = 3;
/** A label within this fraction of a pitch of a boundary labels the boundary; otherwise it labels the cell. */
const BOUNDARY_SNAP = 0.25;
const WHITE = '#ffffff';

/** Index of the cell `[edges[i], edges[i + 1])` holding `at`, or -1 outside the lattice. */
function cellIndex(edges: readonly number[], at: number): number {
  if (at < edges[0] || at >= edges[edges.length - 1]) return -1;
  let lo = 0;
  let hi = edges.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (edges[mid] <= at) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * One axis's ruler: integers printed just outside the lattice give the chart
 * coordinate of the page's first cell. A label on a boundary counts the cells
 * before it (rulers usually count from 1, so `10` sits after ten cells); a
 * label centred on a cell numbers that cell from 1. The most common offset wins.
 */
function rulerAxisOffset(labels: ReadonlyArray<{ value: number; at: number }>, edges: readonly number[]): number | undefined {
  const pitch = (edges[edges.length - 1] - edges[0]) / (edges.length - 1);
  const votes = new Map<number, number>();
  for (const { value, at } of labels) {
    const f = (at - edges[0]) / pitch;
    const boundary = Math.round(f);
    const offset = Math.abs(f - boundary) <= BOUNDARY_SNAP ? value - boundary : value - 1 - Math.floor(f);
    if (offset >= 0) votes.set(offset, (votes.get(offset) ?? 0) + 1);
  }
  let best: number | undefined;
  let bestVotes = 0;
  for (const [offset, count] of votes) {
    if (count > bestVotes) {
      best = offset;
      bestVotes = count;
    }
  }
  return best;
}

function readRulerOffset(page: PdfPagePrimitives, grid: PdfGrid): { x: number; y: number } | undefined {
  const { x: left, y: top, width, height } = grid.bounds;
  const right = left + width;
  const bottom = top + height;
  const columnLabels: Array<{ value: number; at: number }> = [];
  const rowLabels: Array<{ value: number; at: number }> = [];
  for (const run of page.text) {
    const text = run.text.trim();
    if (!/^\d+$/.test(text)) continue;
    const value = Number(text);
    const reach = RULER_REACH * Math.max(grid.pitch, run.fontSize);
    const { x, y } = rectCenter(run.bounds);
    const besideColumns = x >= left - grid.pitch / 2 && x <= right + grid.pitch / 2;
    const besideRows = y >= top - grid.pitch / 2 && y <= bottom + grid.pitch / 2;
    if (besideColumns && ((y < top && top - y <= reach) || (y > bottom && y - bottom <= reach))) columnLabels.push({ value, at: x });
    else if (besideRows && ((x < left && left - x <= reach) || (x > right && x - right <= reach))) rowLabels.push({ value, at: y });
  }
  const x = rulerAxisOffset(columnLabels, grid.xs);
  const y = rulerAxisOffset(rowLabels, grid.ys);
  return x !== undefined && y !== undefined ? { x, y } : undefined;
}

/** A small filled rectangle as a path mark: some pool symbols are plain rectangles, which extraction reports as fills. */
function fillMark({ bounds, color }: PdfFillRect): PdfMark {
  const { x, y, width, height } = bounds;
  const outlineD = normalizeSvgPath(`M ${String(x)} ${String(y)} H ${String(x + width)} V ${String(y + height)} H ${String(x)} Z`);
  return { kind: 'path', bounds, symbolKey: outlineKey(outlineD), outlineD, color };
}

/** Assign the page's marks and cell fills to the lattice's cells. */
export function readChartPage(page: PdfPagePrimitives, grid: PdfGrid): ChartPageCells {
  const { columns, rows } = grid;
  const count = columns * rows;
  const chosen: Array<PdfMark | null> = new Array<PdfMark | null>(count).fill(null);
  const crowded = new Set<number>();
  const maxSize = MAX_MARK_PITCH * grid.pitch;
  const cellOf = (rect: Rect): { column: number; row: number; width: number; height: number } | null => {
    const { x, y } = rectCenter(rect);
    const column = cellIndex(grid.xs, x);
    const row = cellIndex(grid.ys, y);
    if (column < 0 || row < 0) return null;
    return { column, row, width: grid.xs[column + 1] - grid.xs[column], height: grid.ys[row + 1] - grid.ys[row] };
  };
  const rectMarks = new Map<PdfFillRect, PdfMark>();
  for (const fill of page.fills) {
    const cell = cellOf(fill.bounds);
    const { width, height } = fill.bounds;
    if (cell && width > 0 && height > 0 && width <= MAX_FILL_MARK_CELL * cell.width && height <= MAX_FILL_MARK_CELL * cell.height) {
      rectMarks.set(fill, fillMark(fill));
    }
  }
  // Colour-block charts inset a coloured square in every cell. A rectangle drawn in
  // many colours is that background, not a symbol, which has one or two inks.
  const inks = new Map<string, Set<string>>();
  for (const mark of rectMarks.values()) {
    const colors = inks.get(mark.symbolKey) ?? new Set<string>();
    colors.add(mark.color.toLowerCase());
    inks.set(mark.symbolKey, colors);
  }
  const blocks = new Set<PdfFillRect>();
  for (const [fill, mark] of rectMarks) {
    if ((inks.get(mark.symbolKey)?.size ?? 0) >= MIN_BLOCK_COLORS) {
      blocks.add(fill);
      rectMarks.delete(fill);
    }
  }
  for (const mark of [...page.marks, ...rectMarks.values()]) {
    if (mark.bounds.width > maxSize || mark.bounds.height > maxSize) continue;
    const cell = cellOf(mark.bounds);
    if (!cell) continue;
    const index = cell.row * columns + cell.column;
    const current = chosen[index];
    if (current) {
      crowded.add(index);
      if (mark.bounds.width * mark.bounds.height > current.bounds.width * current.bounds.height) chosen[index] = mark;
    } else chosen[index] = mark;
  }

  // Later fills paint over earlier ones, so the last fill covering a cell wins.
  const fills: Array<ImportColor | null> = new Array<ImportColor | null>(count).fill(null);
  for (const fill of page.fills) {
    const cell = cellOf(fill.bounds);
    if (!cell) continue;
    if (!blocks.has(fill)) {
      if (Math.abs(fill.bounds.width - cell.width) > FILL_SIZE_TOLERANCE * cell.width) continue;
      if (Math.abs(fill.bounds.height - cell.height) > FILL_SIZE_TOLERANCE * cell.height) continue;
    }
    const color = fill.color.toLowerCase() as ImportColor;
    fills[cell.row * columns + cell.column] = color === WHITE ? null : color;
  }

  const symbols = new Map<string, ChartPageSymbol>();
  const keys = chosen.map((mark) => {
    if (!mark) return null;
    if (!symbols.has(mark.symbolKey)) {
      symbols.set(mark.symbolKey, mark.unicode !== undefined ? { outlineD: mark.outlineD, unicode: mark.unicode } : { outlineD: mark.outlineD });
    }
    return mark.symbolKey;
  });

  // Warning cells are page-local here; `assembleChart` moves them into chart coordinates.
  const warnings: ImportWarning[] = [...crowded].sort((a, b) => a - b).map((index) => {
    const cell = { x: index % columns, y: Math.floor(index / columns) };
    return {
      code: 'multi-symbol-cell',
      message: `Page ${String(page.pageIndex + 1)}, cell ${String(cell.x + 1)},${String(cell.y + 1)} has more than one symbol; kept the largest.`,
      page: page.pageIndex,
      cell
    };
  });

  const rulerOffset = readRulerOffset(page, grid);
  return {
    pageIndex: page.pageIndex,
    grid,
    columns,
    rows,
    keys,
    fills,
    symbols,
    ...(rulerOffset ? { rulerOffset } : {}),
    warnings
  };
}
