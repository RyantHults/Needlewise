import { MARGIN_SIZES_PT, PAPER_SIZES_PT, type ExportSettings } from './export-settings';

const POINTS_PER_MM = 72 / 25.4;

/**
 * Space reserved on every chart page, in points. The header and footer reserve
 * is constant so the cell grid does not change when page numbers are toggled.
 */
export const HEADER_RESERVE_PT = 24;
export const FOOTER_RESERVE_PT = 24;
/** Width of the row-number gutter and height of the column-number strip. */
export const AXIS_GUTTER_PT = 16;
/** Legend row height and the vertical space the legend title and totals take on a page. */
export const LEGEND_ROW_HEIGHT_PT = 26;
export const LEGEND_PAGE_RESERVE_PT = 128;

export interface PageGeometry {
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly margin: number;
  readonly printableWidth: number;
  readonly printableHeight: number;
  readonly cellSizePt: number;
  /** Chart area after header, footer and axis reserves. */
  readonly chartWidth: number;
  readonly chartHeight: number;
  readonly cellsPerPageX: number;
  readonly cellsPerPageY: number;
}

export function pageGeometry(settings: ExportSettings): PageGeometry {
  const paper = PAPER_SIZES_PT[settings.paper];
  const landscape = settings.orientation === 'landscape';
  const width = landscape ? paper.height : paper.width;
  const height = landscape ? paper.width : paper.height;
  const margin = MARGIN_SIZES_PT[settings.paper][settings.margins];
  const printableWidth = width - margin * 2;
  const printableHeight = height - margin * 2;
  const cellSizePt = settings.cellSizeMm * POINTS_PER_MM;
  const chartWidth = Math.max(0, printableWidth - AXIS_GUTTER_PT);
  const chartHeight = Math.max(0, printableHeight - HEADER_RESERVE_PT - FOOTER_RESERVE_PT - AXIS_GUTTER_PT);
  return {
    pageWidth: width,
    pageHeight: height,
    margin,
    printableWidth,
    printableHeight,
    cellSizePt,
    chartWidth,
    chartHeight,
    cellsPerPageX: Math.max(1, Math.floor(chartWidth / cellSizePt)),
    cellsPerPageY: Math.max(1, Math.floor(chartHeight / cellSizePt))
  };
}

/** A half-open cell range `[start, end)` on one axis, with how many leading/trailing cells repeat a neighbour page. */
export interface AxisSpan {
  readonly start: number;
  readonly end: number;
  readonly overlapBefore: number;
  readonly overlapAfter: number;
}

/**
 * Split `total` cells into pages of at most `perPage`. Page n+1 starts at the
 * previous page's end minus `overlap`; overlap is clamped below `perPage` so
 * every page advances.
 */
export function paginateAxis(total: number, perPage: number, overlap: number): AxisSpan[] {
  const cells = Math.max(0, Math.floor(total));
  if (cells === 0) return [];
  const size = Math.max(1, Math.floor(perPage));
  const repeat = Math.min(Math.max(0, Math.floor(overlap)), size - 1);
  const step = size - repeat;
  const spans: AxisSpan[] = [];
  for (let start = 0; ; start += step) {
    const end = Math.min(cells, start + size);
    spans.push({ start, end, overlapBefore: 0, overlapAfter: 0 });
    if (end >= cells) break;
  }
  return spans.map((span, index) => ({
    ...span,
    overlapBefore: index > 0 ? spans[index - 1].end - span.start : 0,
    overlapAfter: index < spans.length - 1 ? span.end - spans[index + 1].start : 0
  }));
}

export interface ChartPage {
  /** Zero-based column and row in the page grid. */
  readonly column: number;
  readonly row: number;
  /** Cell range `[x0, x1) x [y0, y1)`. */
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
  /** Cells at each edge that repeat a neighbouring page, to be tinted. */
  readonly overlapLeft: number;
  readonly overlapRight: number;
  readonly overlapTop: number;
  readonly overlapBottom: number;
  /** One-based page number within the whole document (cover is 1). */
  readonly pageNumber: number;
  readonly isLeftEdge: boolean;
  readonly isRightEdge: boolean;
  readonly isTopEdge: boolean;
  readonly isBottomEdge: boolean;
}

export interface ChartLayout {
  readonly geometry: PageGeometry;
  readonly columns: number;
  readonly rows: number;
  /** Row-major, `pages[row * columns + column]`. */
  readonly pages: readonly ChartPage[];
  readonly coverPages: number;
  readonly legendPages: number;
  readonly chartPages: number;
  readonly totalPages: number;
  /** Page number of the first chart page; 0 when there are none. */
  readonly firstChartPageNumber: number;
}

export const COVER_PAGE_COUNT = 1;

/** Legend rows that fit on one page after the title block and the totals/notes block. */
export function legendRowsPerPage(settings: ExportSettings): number {
  const { printableHeight } = pageGeometry(settings);
  return Math.max(1, Math.floor((printableHeight - LEGEND_PAGE_RESERVE_PT) / LEGEND_ROW_HEIGHT_PT));
}

/** Pages needed for `rowCount` legend rows. The legend always occupies at least one page. */
export function legendPageCount(rowCount: number, settings: ExportSettings): number {
  const perPage = legendRowsPerPage(settings);
  return Math.max(1, Math.ceil(Math.max(0, rowCount) / perPage));
}

/**
 * Tile a `width x height` cell pattern into chart pages. `legendPages` is the
 * actual legend page count when known, otherwise pass `legendPageCount(...)`.
 */
export function layoutChartPages(width: number, height: number, settings: ExportSettings, legendPages = 1): ChartLayout {
  const geometry = pageGeometry(settings);
  const xs = paginateAxis(width, geometry.cellsPerPageX, settings.overlap);
  const ys = paginateAxis(height, geometry.cellsPerPageY, settings.overlap);
  const legend = Math.max(0, Math.floor(legendPages));
  const firstChartPageNumber = xs.length && ys.length ? COVER_PAGE_COUNT + legend + 1 : 0;
  const pages: ChartPage[] = [];
  ys.forEach((y, row) => xs.forEach((x, column) => {
    pages.push({
      column,
      row,
      x0: x.start,
      x1: x.end,
      y0: y.start,
      y1: y.end,
      overlapLeft: x.overlapBefore,
      overlapRight: x.overlapAfter,
      overlapTop: y.overlapBefore,
      overlapBottom: y.overlapAfter,
      pageNumber: firstChartPageNumber + pages.length,
      isLeftEdge: column === 0,
      isRightEdge: column === xs.length - 1,
      isTopEdge: row === 0,
      isBottomEdge: row === ys.length - 1
    });
  }));
  return {
    geometry,
    columns: xs.length,
    rows: ys.length,
    pages,
    coverPages: COVER_PAGE_COUNT,
    legendPages: legend,
    chartPages: pages.length,
    totalPages: COVER_PAGE_COUNT + legend + pages.length,
    firstChartPageNumber
  };
}

/** Total page count for the UI, from the pattern size and the number of legend rows. */
export function estimateTotalPages(width: number, height: number, settings: ExportSettings, legendRowCount = 0): number {
  return layoutChartPages(width, height, settings, legendPageCount(legendRowCount, settings)).totalPages;
}
