import { describe, expect, it } from 'vitest';
import { DEFAULT_EXPORT_SETTINGS, type ExportSettings } from './export-settings';
import { estimateTotalPages, layoutChartPages, legendPageCount, pageGeometry, paginateAxis } from './layout';

const settings = (patch: Partial<ExportSettings> = {}): ExportSettings => ({ ...DEFAULT_EXPORT_SETTINGS, ...patch });

describe('pageGeometry', () => {
  it('computes cells per page for letter at 4 mm', () => {
    const g = pageGeometry(settings());
    expect(g.cellsPerPageX).toBe(39);
    expect(g.cellsPerPageY).toBe(51);
  });

  it('shrinks the grid with larger cells and narrow margins grow it', () => {
    for (const paper of ['letter', 'a4'] as const) {
      const small = pageGeometry(settings({ paper, cellSizeMm: 3.2 }));
      const mid = pageGeometry(settings({ paper, cellSizeMm: 4 }));
      const big = pageGeometry(settings({ paper, cellSizeMm: 5 }));
      expect(small.cellsPerPageX).toBeGreaterThan(mid.cellsPerPageX);
      expect(mid.cellsPerPageX).toBeGreaterThan(big.cellsPerPageX);
      expect(small.cellsPerPageY).toBeGreaterThan(big.cellsPerPageY);
      expect(pageGeometry(settings({ paper, margins: 'narrow' })).cellsPerPageX).toBeGreaterThan(mid.cellsPerPageX);
      expect(mid.cellsPerPageX).toBe(Math.floor(mid.chartWidth / mid.cellSizePt));
    }
  });

  it('swaps the page for landscape: more cells per row, fewer per column', () => {
    const portrait = pageGeometry(settings());
    const landscape = pageGeometry(settings({ orientation: 'landscape' }));
    expect(landscape.pageWidth).toBe(792);
    expect(landscape.pageHeight).toBe(612);
    expect(landscape.cellsPerPageX).toBeGreaterThan(portrait.cellsPerPageX);
    expect(landscape.cellsPerPageY).toBeLessThan(portrait.cellsPerPageY);
  });

  it('uses A4 point sizes and its own margin', () => {
    const g = pageGeometry(settings({ paper: 'a4' }));
    expect(g.pageWidth).toBeCloseTo(595.28);
    expect(g.margin).toBeCloseTo(70.87);
  });

  it('does not change with the page-number toggle', () => {
    expect(pageGeometry(settings({ pageNumbers: false }))).toEqual(pageGeometry(settings({ pageNumbers: true })));
  });
});

describe('paginateAxis', () => {
  it.each([0, 1, 2, 3])('repeats %i cells between pages', (overlap) => {
    const spans = paginateAxis(100, 39, overlap);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i - 1].end - spans[i].start).toBe(overlap);
      expect(spans[i].overlapBefore).toBe(overlap);
      expect(spans[i - 1].overlapAfter).toBe(overlap);
    }
    expect(spans[0].start).toBe(0);
    expect(spans[spans.length - 1].end).toBe(100);
    expect(spans[0].overlapBefore).toBe(0);
    expect(spans[spans.length - 1].overlapAfter).toBe(0);
  });

  it('handles empty, single-cell and oversized overlap', () => {
    expect(paginateAxis(0, 39, 1)).toEqual([]);
    expect(paginateAxis(1, 39, 3)).toEqual([{ start: 0, end: 1, overlapBefore: 0, overlapAfter: 0 }]);
    const spans = paginateAxis(5, 2, 9);
    expect(spans.length).toBe(4);
    expect(spans[3].end).toBe(5);
  });
});

describe('layoutChartPages', () => {
  it('tiles 100x80 on letter with overlap 1', () => {
    const layout = layoutChartPages(100, 80, settings({ overlap: 1 }), 1);
    // x: 39 per page, step 38 -> starts 0,38,76 ; y: 51 per page, step 50 -> starts 0,50
    expect(layout.columns).toBe(3);
    expect(layout.rows).toBe(2);
    expect(layout.chartPages).toBe(6);
    expect(layout.totalPages).toBe(1 + 1 + 6);
    expect(layout.firstChartPageNumber).toBe(3);
    const edge = layout.pages[2];
    expect(edge.x0).toBe(76);
    expect(edge.x1).toBe(100);
    expect(edge.x1 - edge.x0).toBeLessThan(39);
    expect(edge.isRightEdge).toBe(true);
    expect(edge.isTopEdge).toBe(true);
    expect(edge.overlapLeft).toBe(1);
    expect(layout.pages[3].overlapTop).toBe(1);
    expect(layout.pages.map((p) => p.pageNumber)).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it('has no chart pages for an empty pattern', () => {
    const layout = layoutChartPages(0, 0, settings(), 1);
    expect(layout.chartPages).toBe(0);
    expect(layout.totalPages).toBe(2);
    expect(layout.firstChartPageNumber).toBe(0);
  });

  it('puts a 1x1 pattern on one page', () => {
    const layout = layoutChartPages(1, 1, settings({ overlap: 3 }), 1);
    expect(layout.chartPages).toBe(1);
    expect(layout.pages[0]).toMatchObject({ x0: 0, x1: 1, y0: 0, y1: 1, overlapLeft: 0, overlapBottom: 0 });
  });

  it('page numbers off keeps the same pagination', () => {
    expect(layoutChartPages(100, 80, settings({ pageNumbers: false })).pages)
      .toEqual(layoutChartPages(100, 80, settings({ pageNumbers: true })).pages);
  });

  it('counts legend pages', () => {
    expect(legendPageCount(0, settings())).toBe(1);
    expect(legendPageCount(500, settings())).toBeGreaterThan(1);
    expect(estimateTotalPages(10, 10, settings(), 0)).toBe(3);
    expect(layoutChartPages(10, 10, settings(), 3).totalPages).toBe(1 + 3 + 1);
  });
});
