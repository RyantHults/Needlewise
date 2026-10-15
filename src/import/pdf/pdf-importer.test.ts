import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportError, type ImportedKeyEntry } from '../types';
import type { AssembledCells, ChartPageCells, PdfGrid, PdfPagePrimitives } from './types';

const mocks = vi.hoisted(() => ({
  openPdf: vi.fn(),
  extractPagePrimitives: vi.fn(),
  readPdfTitle: vi.fn(),
  detectGrid: vi.fn(),
  readChartPage: vi.fn(),
  assembleChart: vi.fn(),
  readKeyPage: vi.fn(),
  renderPageThumbnail: vi.fn()
}));

vi.mock('./pdfjs', () => ({ openPdf: mocks.openPdf }));
vi.mock('./extract', () => ({ extractPagePrimitives: mocks.extractPagePrimitives, readPdfTitle: mocks.readPdfTitle }));
vi.mock('./grid', () => ({ detectGrid: mocks.detectGrid }));
vi.mock('./chart-page', () => ({ readChartPage: mocks.readChartPage }));
vi.mock('./assemble', () => ({ assembleChart: mocks.assembleChart }));
vi.mock('./key', () => ({ readKeyPage: mocks.readKeyPage }));
vi.mock('./thumbnail', () => ({ renderPageThumbnail: mocks.renderPageThumbnail }));

const { pdfImporter } = await import('./pdf-importer');

const grid: PdfGrid = { xs: [], ys: [], columns: 2, rows: 1, pitch: 10, bounds: { x: 0, y: 0, width: 20, height: 10 } };

function page(pageIndex: number, patch: Partial<PdfPagePrimitives> = {}): PdfPagePrimitives {
  return { pageIndex, width: 612, height: 792, marks: [], strokes: [], fills: [], text: [], imageCoverage: 0, ...patch };
}

const chartMark = { kind: 'glyph', bounds: { x: 2, y: 2, width: 6, height: 6 }, symbolKey: 'a', outlineD: 'M0 0Z', color: '#000000' } as const;

const assembled: AssembledCells = {
  width: 3,
  height: 1,
  keys: ['a', 'b', 'a'],
  fills: ['#ff0000', null, '#ff0000'],
  symbols: new Map([['a', { outlineD: 'A', unicode: 'x' }], ['b', { outlineD: 'B' }], ['c', { outlineD: 'C' }]]),
  overlap: 0,
  detectedOverlap: 0,
  placements: new Map([[1, { x: 0, y: 0 }]]),
  warnings: [{ code: 'multi-symbol-cell', message: 'two marks', cell: { x: 1, y: 0 } }]
};

const fakePdf = (numPages: number) => ({
  numPages,
  getPage: vi.fn(async (pageNumber: number) => ({ pageNumber })),
  loadingTask: { destroy: vi.fn(async () => undefined) }
});

function setup(pages: PdfPagePrimitives[], key: ImportedKeyEntry[] = []) {
  const pdf = fakePdf(pages.length);
  mocks.openPdf.mockResolvedValue(pdf);
  mocks.extractPagePrimitives.mockImplementation(async (_pdf: unknown, index: number) => pages[index]);
  mocks.readPdfTitle.mockResolvedValue(undefined);
  mocks.detectGrid.mockImplementation((p: PdfPagePrimitives) => (p.marks.length > 0 ? grid : null));
  mocks.readChartPage.mockImplementation((p: PdfPagePrimitives) => ({ pageIndex: p.pageIndex }) as ChartPageCells);
  mocks.assembleChart.mockReturnValue(assembled);
  mocks.readKeyPage.mockImplementation((p: PdfPagePrimitives) => (p.text.length > 0 ? key : []));
  mocks.renderPageThumbnail.mockResolvedValue(undefined);
  return pdf;
}

const keyPage = (index: number) => page(index, { text: [{ text: 'DMC', bounds: { x: 0, y: 0, width: 10, height: 10 }, fontSize: 9 }] });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('pdfImporter', () => {
  it('sniffs the PDF header within the first 1024 bytes', () => {
    expect(pdfImporter.sniff(new TextEncoder().encode('%PDF-1.7\n'))).toBe(true);
    expect(pdfImporter.sniff(new TextEncoder().encode(`${' '.repeat(100)}%PDF-1.4`))).toBe(true);
    expect(pdfImporter.sniff(new TextEncoder().encode('PK\u0003\u0004'))).toBe(false);
    expect(pdfImporter.accept).toEqual(['.pdf', 'application/pdf']);
  });

  it('maps a password failure to encrypted-pdf and anything else to invalid-pdf', async () => {
    mocks.openPdf.mockRejectedValueOnce(Object.assign(new Error('pw'), { name: 'PasswordException' }));
    await expect(pdfImporter.open(new Uint8Array())).rejects.toMatchObject({ code: 'encrypted-pdf' });
    mocks.openPdf.mockRejectedValueOnce(new Error('bad xref'));
    await expect(pdfImporter.open(new Uint8Array())).rejects.toMatchObject({ code: 'invalid-pdf' });
  });

  it('extracts every page with progress, then releases pdf.js', async () => {
    const pdf = setup([keyPage(0), page(1, { marks: [chartMark] })]);
    const onProgress = vi.fn();
    await pdfImporter.open(new Uint8Array(), { onProgress });
    expect(mocks.extractPagePrimitives).toHaveBeenCalledTimes(2);
    expect(onProgress.mock.calls.map(([p]) => p)).toEqual([
      { stage: 'reading', done: 1, total: 2 },
      { stage: 'reading', done: 2, total: 2 }
    ]);
    expect(pdf.loadingTask.destroy).toHaveBeenCalledOnce();
  });

  it('renders each page thumbnail once and attaches it to every analysis', async () => {
    const pdf = setup([keyPage(0), page(1, { marks: [chartMark] }), page(2)], [{ symbolKey: 'a', code: '310' }]);
    const first = new Blob(['first'], { type: 'image/png' });
    const second = new Blob(['second'], { type: 'image/png' });
    mocks.renderPageThumbnail.mockImplementation(async (p: { pageNumber: number }) => (p.pageNumber === 1 ? first : p.pageNumber === 2 ? second : undefined));
    pdf.getPage.mockImplementation(async (pageNumber: number) => {
      if (pageNumber === 3) throw new Error('page gone');
      return { pageNumber };
    });
    const session = await pdfImporter.open(new Uint8Array());
    const analysis = await session.analyze();
    expect(analysis.pages.map((p) => p.thumbnail)).toEqual([first, second, undefined]);
    expect('thumbnail' in analysis.pages[2]).toBe(false);
    const again = await session.analyze({ pageRoles: { 2: 'key' } });
    expect(again.pages.map((p) => p.thumbnail)).toEqual([first, second, undefined]);
    expect(mocks.renderPageThumbnail).toHaveBeenCalledTimes(2);
  });

  it('builds the chart: roles, symbols in order with counts and fills, key, warnings and title', async () => {
    setup([keyPage(0), page(1, { marks: [chartMark] }), page(2)], [
      { symbolKey: 'a', brand: 'DMC', code: '310' },
      { symbolKey: 'z', brand: 'DMC', code: '666' }
    ]);
    const session = await pdfImporter.open(new Uint8Array(), { fileName: 'Rose garden.PDF' });
    const analysis = await session.analyze();

    expect(analysis.format).toBe('pdf');
    expect(analysis.pages.map((p) => [p.role, p.detectedRole])).toEqual([['key', 'key'], ['chart', 'chart'], ['other', 'other']]);
    expect(analysis.pages[1]).toMatchObject({ grid: { columns: 2, rows: 1 }, placement: { x: 0, y: 0 } });
    const { chart } = analysis;
    expect(chart.title).toBe('Rose garden');
    expect([...chart.cells]).toEqual([1, 2, 1]);
    expect(chart.symbols).toEqual([
      { key: 'a', outlineD: 'A', unicode: 'x', count: 2, fillColor: '#ff0000' },
      { key: 'b', outlineD: 'B', count: 1 }
    ]);
    expect(chart.key).toHaveLength(2);
    expect(chart.warnings.map((w) => [w.code, w.symbolKey])).toEqual([
      ['multi-symbol-cell', undefined],
      ['symbol-missing-from-key', 'b'],
      ['key-entry-unused', 'z']
    ]);
  });

  it('prefers the PDF title and warns about brands, blends and unknown codes', async () => {
    setup([keyPage(0), page(1, { marks: [chartMark] })], [
      { symbolKey: 'a', brand: 'ANCHOR', code: '403' },
      { symbolKey: 'b', brand: 'DMC', code: '310', blendCodes: ['310', '413'] }
    ]);
    mocks.readPdfTitle.mockResolvedValue(' Roses ');
    const { chart } = await (await pdfImporter.open(new Uint8Array(), { fileName: 'x.pdf' })).analyze();
    expect(chart.title).toBe('Roses');
    expect(chart.warnings.map((w) => w.code)).toEqual(['multi-symbol-cell', 'unsupported-brand', 'blend-not-supported']);
    expect(chart.warnings[2].message).toBe("Blended threads aren't supported (310+413); the colour was matched from the chart.");

    setup([keyPage(0), page(1, { marks: [chartMark] })], [{ symbolKey: 'a', brand: 'DMC', code: '9999' }]);
    const again = await (await pdfImporter.open(new Uint8Array())).analyze();
    expect(again.chart.warnings.map((w) => w.code)).toContain('unknown-thread-code');
  });

  it('applies role and overlap overrides without re-reading the PDF', async () => {
    setup([keyPage(0), page(1, { marks: [chartMark] }), page(2, { marks: [chartMark] })], [{ symbolKey: 'a', code: '310' }]);
    const session = await pdfImporter.open(new Uint8Array());
    await session.analyze();
    const analysis = await session.analyze({ pageRoles: { 2: 'other' }, overlap: 2 });
    expect(mocks.extractPagePrimitives).toHaveBeenCalledTimes(3);
    expect(analysis.pages.map((p) => [p.role, p.detectedRole])).toEqual([['key', 'key'], ['chart', 'chart'], ['other', 'chart']]);
    expect(mocks.readChartPage).toHaveBeenLastCalledWith(expect.objectContaining({ pageIndex: 1 }), grid);
    expect(mocks.assembleChart).toHaveBeenLastCalledWith([{ pageIndex: 1 }], { overlap: 2 });
  });

  it('reads the key beside the chart when no page is a key page', async () => {
    setup([page(0, { marks: [chartMark] })]);
    await (await pdfImporter.open(new Uint8Array())).analyze();
    expect(mocks.readKeyPage).toHaveBeenLastCalledWith(expect.objectContaining({ pageIndex: 0 }), [grid.bounds]);
  });

  it('rejects image-only PDFs as scanned and others without a chart as no-chart-found', async () => {
    setup([page(0, { imageCoverage: 0.9 })]);
    const scanned = (await pdfImporter.open(new Uint8Array())).analyze();
    await expect(scanned).rejects.toBeInstanceOf(ImportError);
    await expect(scanned).rejects.toMatchObject({ code: 'unsupported-scanned-pdf' });

    setup([keyPage(0)]);
    await expect((await pdfImporter.open(new Uint8Array())).analyze()).rejects.toMatchObject({ code: 'no-chart-found' });
  });

  it('honours cancellation', async () => {
    setup([page(0, { marks: [chartMark] })]);
    const controller = new AbortController();
    controller.abort();
    await expect(pdfImporter.open(new Uint8Array(), { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
    const session = await pdfImporter.open(new Uint8Array());
    await expect(session.analyze({}, { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('returns an empty chart, with the key, when overrides leave no chart page', async () => {
    setup([keyPage(0), page(1, { marks: [chartMark] })], [{ symbolKey: 'a', brand: 'DMC', code: '310' }]);
    const session = await pdfImporter.open(new Uint8Array());
    const analysis = await session.analyze({ pageRoles: { 1: 'other' } });
    expect(analysis.pages.map((p) => p.role)).toEqual(['key', 'other']);
    expect(analysis.chart).toMatchObject({ width: 0, height: 0, symbols: [] });
    expect(analysis.chart.cells).toHaveLength(0);
    expect(analysis.chart.key).toEqual([{ symbolKey: 'a', brand: 'DMC', code: '310' }]);
    // Restoring the role recovers the chart.
    expect((await session.analyze({ pageRoles: { 1: 'chart' } })).chart.width).toBe(3);
  });

  it('rejects colour-block charts without symbols', async () => {
    const fill = { bounds: { x: 0, y: 0, width: 10, height: 10 }, color: '#ff0000' } as const;
    setup([page(0, { fills: [fill] })]);
    mocks.detectGrid.mockReturnValue(grid);
    const colourOnly = (await pdfImporter.open(new Uint8Array())).analyze();
    await expect(colourOnly).rejects.toMatchObject({ code: 'no-chart-found', message: expect.stringContaining('without symbols') });

    // A chart page whose marks all fall outside cells reads as fills only.
    setup([page(0, { marks: [chartMark] })]);
    mocks.assembleChart.mockReturnValue({ ...assembled, keys: [null, null, null], symbols: new Map() });
    await expect((await pdfImporter.open(new Uint8Array())).analyze()).rejects.toMatchObject({ code: 'no-chart-found', message: expect.stringContaining('without symbols') });
  });
});
