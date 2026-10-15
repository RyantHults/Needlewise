// Stitches chart pages into one grid: placement, overlap detection and
// removal. Pure: no pdf.js import.
import type { ImportColor, ImportWarning } from '../types';
import type { AssembledCells, ChartPageCells, ChartPageSymbol } from './types';

const MAX_OVERLAP = 3;
/** Overlapping edges must agree on at least this fraction of their non-empty cells to count as overlap. */
const OVERLAP_MATCH = 0.9;
/** An overlap needs at least this many non-empty cells compared before it is believed. */
const MIN_OVERLAP_SAMPLE = 8;
/** Overlaps scoring within this of the best are tied and decided by informative matches. */
const OVERLAP_TIE = 0.02;
/** Per-cell overlap mismatch warnings are capped per page so a wrong overlap cannot flood the review. */
const MAX_MISMATCH_WARNINGS_PER_PAGE = 50;

type Placement = { readonly x: number; readonly y: number };

interface Layout {
  /** Pages per row. */
  readonly perRow: number;
  readonly widths: readonly number[];
  readonly heights: readonly number[];
}

/**
 * Page-grid layouts consistent with the page sizes: pages in a row share
 * `rows`, pages in a column share `columns`, and only the last column may be
 * narrower and the last row shorter.
 */
function consistentLayouts(pages: readonly ChartPageCells[]): Layout[] {
  const layouts: Layout[] = [];
  for (let perRow = 1; perRow <= pages.length; perRow += 1) {
    if (pages.length % perRow !== 0) continue;
    const rowCount = pages.length / perRow;
    const at = (row: number, column: number): ChartPageCells => pages[row * perRow + column];
    const widths = Array.from({ length: perRow }, (_, column) => at(0, column).columns);
    const heights = Array.from({ length: rowCount }, (_, row) => at(row, 0).rows);
    let ok = widths.every((w, c) => c === perRow - 1 ? w <= widths[0] : w === widths[0]) &&
      heights.every((h, r) => r === rowCount - 1 ? h <= heights[0] : h === heights[0]);
    for (let r = 0; ok && r < rowCount; r += 1) {
      for (let c = 0; ok && c < perRow; c += 1) ok = at(r, c).columns === widths[c] && at(r, c).rows === heights[r];
    }
    if (ok) layouts.push({ perRow, widths, heights });
  }
  return layouts;
}

/** Cell identity used to compare overlapping edges: the symbol, else the fill. */
function signature(page: ChartPageCells, column: number, row: number): string | null {
  const index = row * page.columns + column;
  return page.keys[index] ?? page.fills[index];
}

interface Agreement {
  /** Non-empty cell pairs that agree. */
  readonly matching: number;
  /** Cell pairs compared; pairs empty on both sides are skipped. */
  readonly compared: number;
  /** Agreeing pairs whose source cell differs from its inward neighbour, so a solid area cannot fake them. */
  readonly informative: number;
}

/** How well `overlap` explains the layout's adjacent edges. */
function edgeAgreement(pages: readonly ChartPageCells[], layout: Layout, overlap: number): Agreement {
  let matching = 0;
  let compared = 0;
  let informative = 0;
  const compare = (a: string | null, b: string | null, inward: string | null): void => {
    if (a === null && b === null) return;
    compared += 1;
    if (a !== b) return;
    matching += 1;
    if (a !== inward) informative += 1;
  };
  pages.forEach((page, i) => {
    const column = i % layout.perRow;
    const right = column + 1 < layout.perRow ? pages[i + 1] : undefined;
    if (right) {
      for (let k = 0; k < overlap; k += 1) {
        const c = page.columns - overlap + k;
        for (let r = 0; r < Math.min(page.rows, right.rows); r += 1) {
          compare(signature(page, c, r), signature(right, k, r), c > 0 ? signature(page, c - 1, r) : null);
        }
      }
    }
    const below = pages[i + layout.perRow];
    if (below) {
      for (let k = 0; k < overlap; k += 1) {
        const r = page.rows - overlap + k;
        for (let c = 0; c < Math.min(page.columns, below.columns); c += 1) {
          compare(signature(page, c, r), signature(below, c, k), r > 0 ? signature(page, c, r - 1) : null);
        }
      }
    }
  });
  return { matching, compared, informative };
}

/** True when every page and every page-grid track is wider than the overlap it must shed. */
function fits(layout: Layout, overlap: number): boolean {
  return (layout.widths.length < 2 || layout.widths.every((w) => w > overlap)) &&
    (layout.heights.length < 2 || layout.heights.every((h) => h > overlap));
}

/**
 * The overlap (0-3) whose repeated edges best agree; 0 when no overlap agrees
 * well. Solid areas make every k agree, so near-ties go to the k with the most
 * informative matches, and to 0 when none has any: a false overlap drops real
 * cells, which is worse than keeping repeated ones.
 */
function detectOverlap(pages: readonly ChartPageCells[], layout: Layout): { overlap: number; score: number } {
  const candidates: Array<{ overlap: number; score: number; informative: number }> = [];
  for (let overlap = 1; overlap <= MAX_OVERLAP; overlap += 1) {
    if (!fits(layout, overlap)) continue;
    const { matching, compared, informative } = edgeAgreement(pages, layout, overlap);
    if (compared < MIN_OVERLAP_SAMPLE) continue;
    const score = matching / compared;
    if (score >= OVERLAP_MATCH) candidates.push({ overlap, score, informative });
  }
  if (candidates.length === 0) return { overlap: 0, score: 0 };
  const top = Math.max(...candidates.map((candidate) => candidate.score));
  const tied = candidates.filter((candidate) => top - candidate.score <= OVERLAP_TIE);
  if (tied.length === 1) return tied[0];
  // Ascending k, so equal informative counts keep the smaller overlap.
  const best = tied.reduce((a, b) => (b.informative > a.informative ? b : a));
  return best.informative > 0 ? best : { overlap: 0, score: 0 };
}

function place(layout: Layout, overlap: number, count: number): Placement[] {
  const xs = layout.widths.map((_, c) => layout.widths.slice(0, c).reduce((sum, w) => sum + w - overlap, 0));
  const ys = layout.heights.map((_, r) => layout.heights.slice(0, r).reduce((sum, h) => sum + h - overlap, 0));
  return Array.from({ length: count }, (_, i) => ({ x: xs[i % layout.perRow], y: ys[Math.floor(i / layout.perRow)] }));
}

/** Overlap implied by ruler placements: how far the second page in a row (or column) starts inside the first. */
function rulerOverlap(pages: readonly ChartPageCells[]): number {
  for (const a of pages) {
    for (const b of pages) {
      const pa = a.rulerOffset;
      const pb = b.rulerOffset;
      if (!pa || !pb || a === b) continue;
      if (pa.y === pb.y && pb.x > pa.x && pb.x <= pa.x + a.columns) return Math.min(MAX_OVERLAP, pa.x + a.columns - pb.x);
      if (pa.x === pb.x && pb.y > pa.y && pb.y <= pa.y + a.rows) return Math.min(MAX_OVERLAP, pa.y + a.rows - pb.y);
    }
  }
  return 0;
}

/**
 * Ruler placements moved so the chart starts at 0,0, or null when they do not
 * tile a rectangle: a gap between pages, or two pages repeating more than
 * `MAX_OVERLAP` cells, means a misread ruler.
 */
function rulerPlacements(pages: readonly ChartPageCells[]): Placement[] | null {
  const offsets = pages.map((page) => page.rulerOffset as Placement);
  const minX = Math.min(...offsets.map((at) => at.x));
  const minY = Math.min(...offsets.map((at) => at.y));
  const placements = offsets.map((at) => ({ x: at.x - minX, y: at.y - minY }));
  const width = Math.max(...pages.map((page, i) => placements[i].x + page.columns));
  const height = Math.max(...pages.map((page, i) => placements[i].y + page.rows));
  // The pages' union is no larger than their summed area, so a larger bounding box must have a gap.
  if (width * height > pages.reduce((sum, page) => sum + page.columns * page.rows, 0)) return null;
  for (let i = 0; i < pages.length; i += 1) {
    for (let j = i + 1; j < pages.length; j += 1) {
      const across = Math.min(placements[i].x + pages[i].columns, placements[j].x + pages[j].columns) - Math.max(placements[i].x, placements[j].x);
      const down = Math.min(placements[i].y + pages[i].rows, placements[j].y + pages[j].rows) - Math.max(placements[i].y, placements[j].y);
      if (across > MAX_OVERLAP && down > MAX_OVERLAP) return null;
    }
  }
  const covered = new Uint8Array(width * height);
  pages.forEach((page, i) => {
    for (let y = placements[i].y; y < placements[i].y + page.rows; y += 1) covered.fill(1, y * width + placements[i].x, y * width + placements[i].x + page.columns);
  });
  return covered.every((cell) => cell === 1) ? placements : null;
}

/**
 * Assemble chart pages into one grid. Pages are placed by their ruler offsets,
 * shifted to start at 0,0, when every page has one, the offsets tile a
 * rectangle, and no conflicting overlap is forced; otherwise
 * in reading order, rows of pages left to right, with row breaks inferred from
 * the page sizes. Overlapping cells are taken from the first page that holds
 * them.
 */
export function assembleChart(pages: readonly ChartPageCells[], options: { overlap?: number } = {}): AssembledCells {
  const ordered = [...pages].sort((a, b) => a.pageIndex - b.pageIndex);
  const warnings: ImportWarning[] = [];
  const forced = options.overlap === undefined ? undefined : Math.min(MAX_OVERLAP, Math.max(0, Math.floor(options.overlap)));

  let placements: Placement[];
  let overlap: number;
  let detectedOverlap: number;
  const byRuler = ordered.length > 0 && ordered.every((page) => page.rulerOffset !== undefined) ? rulerPlacements(ordered) : null;
  const rulers = byRuler !== null;
  const fromRulers = rulers ? rulerOverlap(ordered) : 0;
  if (byRuler && (forced === undefined || forced === fromRulers)) {
    placements = byRuler;
    overlap = fromRulers;
    detectedOverlap = fromRulers;
  } else {
    const layouts = consistentLayouts(ordered);
    if (layouts.length === 0) {
      if (ordered.length > 0) warnings.push({ code: 'uneven-page-grid', message: 'The chart pages do not form a consistent grid; they were placed in a single row.' });
      layouts.push({ perRow: ordered.length, widths: ordered.map((page) => page.columns), heights: [Math.max(0, ...ordered.map((page) => page.rows))] });
    }
    // Equal-sized pages fit several layouts: prefer the one whose edges overlap best, then the squarest page grid.
    const squareness = (layout: Layout): number => Math.abs(layout.perRow - Math.sqrt(ordered.length));
    const scored = layouts.map((layout) => ({ layout, ...detectOverlap(ordered, layout) }));
    scored.sort((a, b) => b.score - a.score || squareness(a.layout) - squareness(b.layout));
    const chosen = scored[0];
    detectedOverlap = rulers ? fromRulers : chosen.overlap;
    overlap = forced ?? detectedOverlap;
    if (!fits(chosen.layout, overlap)) overlap = detectedOverlap;
    placements = place(chosen.layout, overlap, ordered.length);
  }

  const width = Math.max(0, ...ordered.map((page, i) => placements[i].x + page.columns));
  const height = Math.max(0, ...ordered.map((page, i) => placements[i].y + page.rows));
  const keys: Array<string | null> = new Array<string | null>(width * height).fill(null);
  const fills: Array<ImportColor | null> = new Array<ImportColor | null>(width * height).fill(null);
  const taken = new Uint8Array(width * height);
  const symbols = new Map<string, ChartPageSymbol>();
  const placementMap = new Map<number, Placement>();

  ordered.forEach((page, i) => {
    const at = placements[i];
    placementMap.set(page.pageIndex, at);
    for (const [key, symbol] of page.symbols) if (!symbols.has(key)) symbols.set(key, symbol);
    for (const warning of page.warnings) {
      warnings.push(warning.cell ? { ...warning, cell: { x: warning.cell.x + at.x, y: warning.cell.y + at.y } } : warning);
    }
    let mismatches = 0;
    for (let r = 0; r < page.rows; r += 1) {
      for (let c = 0; c < page.columns; c += 1) {
        const x = at.x + c;
        const y = at.y + r;
        if (x < 0 || y < 0) continue;
        const source = r * page.columns + c;
        const target = y * width + x;
        if (taken[target]) {
          if ((keys[target] !== page.keys[source] || fills[target] !== page.fills[source]) && mismatches < MAX_MISMATCH_WARNINGS_PER_PAGE) {
            mismatches += 1;
            warnings.push({
              code: 'overlap-mismatch',
              message: `Page ${String(page.pageIndex + 1)} disagrees with an earlier page at column ${String(x + 1)}, row ${String(y + 1)}; kept the earlier page's cell.`,
              page: page.pageIndex,
              cell: { x, y }
            });
          }
          continue;
        }
        taken[target] = 1;
        keys[target] = page.keys[source];
        fills[target] = page.fills[source];
      }
    }
  });

  return { width, height, keys, fills, symbols, overlap, detectedOverlap, placements: placementMap, warnings };
}
