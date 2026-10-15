// @vitest-environment node
// End-to-end: real PDFs built in-test, read through pdf.js and every stage.
import { describe, expect, it } from 'vitest';
import { buildImportedDocument, proposeMappings } from '../build-document';
import type { ImportAnalysis, ImportOverrides } from '../types';
import { pdfImporter } from './pdf-importer';
import {
  buildImageOnlyPdf,
  buildSyntheticChartPdf,
  dmcDocument,
  symbolChars,
  writeNeedlewisePdf,
  type SyntheticChartOptions,
  type SyntheticSymbol
} from './test-fixtures';

async function importPdf(bytes: Uint8Array, fileName?: string, overrides?: ImportOverrides): Promise<ImportAnalysis> {
  const session = await pdfImporter.open(bytes, fileName === undefined ? {} : { fileName });
  try {
    return await session.analyze(overrides);
  } finally {
    await session.close();
  }
}

/** The DMC code the key gives each cell, row-major; null for an empty cell or an unkeyed symbol. */
function cellCodes(analysis: ImportAnalysis): (string | null)[] {
  const { chart } = analysis;
  const codeOf = new Map(chart.key.map((entry) => [entry.symbolKey, entry.code ?? null]));
  return [...chart.cells].map((index) => (index === 0 ? null : codeOf.get(chart.symbols[index - 1].key) ?? null));
}

describe('Needlewise PDF round trip', () => {
  const codes = ['310', '666', '3865', '798', 'B5200'];
  const pattern = (x: number, y: number): number => ((x * 3 + y * 7) % 7) % 6;
  const width = 60;
  const height = 70;

  for (const overlap of [0, 2]) {
    it(`reads back a multi-page export with overlap ${String(overlap)}`, { timeout: 60_000 }, async () => {
      const document = dmcDocument(width, height, codes, pattern);
      const bytes = await writeNeedlewisePdf(document, 'Round trip', { overlap });
      const analysis = await importPdf(bytes, 'ignored.pdf');

      expect(analysis.pages.filter((page) => page.role === 'chart').length).toBeGreaterThan(1);
      expect(analysis.pages.some((page) => page.role === 'key')).toBe(true);
      expect(analysis.overlap).toBe(overlap);
      const { chart } = analysis;
      expect(chart.title).toBe('Round trip');
      expect([chart.width, chart.height]).toEqual([width, height]);
      expect(chart.symbols).toHaveLength(codes.length);

      const expected: (string | null)[] = [];
      for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) expected.push(codes[pattern(x, y) - 1] ?? null);
      expect(cellCodes(analysis)).toEqual(expected);
      expect(chart.warnings.filter((warning) => warning.code !== 'multi-symbol-cell')).toEqual([]);

      // Same cells, colors and symbols once built into a document.
      const proposals = proposeMappings(chart);
      expect(proposals.every((proposal) => proposal.status === 'matched')).toBe(true);
      const rebuilt = buildImportedDocument(chart, proposals, {});
      const slugOf = (doc: typeof document, id: number): string | undefined => doc.palette.find((entry) => entry.id === id)?.symbol;
      const codeOf = (doc: typeof document, id: number): string | undefined => doc.palette.find((entry) => entry.id === id)?.catalog?.code;
      for (let index = 0; index < width * height; index += 1) {
        const original = document.colors[index * 4];
        const imported = rebuilt.colors[index * 4];
        expect(imported === 0).toBe(original === 0);
        if (original === 0) continue;
        expect(codeOf(rebuilt, imported)).toBe(codeOf(document, original));
        expect(slugOf(rebuilt, imported)).toBe(slugOf(document, original));
      }
    });
  }
});

describe('third-party-style PDFs', () => {
  const chars = symbolChars(6);
  const palette: SyntheticSymbol[] = [
    { char: chars[0], code: '310', name: 'Black', color: '#000000' },
    { char: chars[1], code: '666', name: 'Bright Red', color: '#e31d42' },
    { char: chars[2], code: '3865', name: 'Winter White', color: '#f9f7f1' },
    { char: chars[3], code: '798', name: 'Dark Delft Blue', color: '#466a8e' },
    { char: chars[4], code: '704', name: 'Bright Chartreuse', color: '#9ecf34' }
  ];
  const chart = (width: number, height: number, patch: Partial<SyntheticChartOptions> = {}): SyntheticChartOptions => {
    const count = (patch.symbols ?? palette).length;
    const cells: number[] = [];
    // Every symbol used, with some empty cells scattered through the chart.
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) cells.push((x * 7 + y * 3) % 11 === 4 ? 0 : ((x + 2 * y) % count) + 1);
    return { width, height, cells, symbols: palette, title: 'Synthetic', ...patch };
  };
  const expectedCodes = (options: SyntheticChartOptions): (string | null)[] =>
    options.cells.map((id) => (id === 0 ? null : options.symbols[id - 1].code));

  it('imports a basic one-page chart', { timeout: 30_000 }, async () => {
    const options = chart(30, 24);
    const analysis = await importPdf(await buildSyntheticChartPdf(options));
    expect(analysis.pages.map((page) => page.role)).toEqual(['chart', 'key']);
    expect([analysis.chart.width, analysis.chart.height]).toEqual([30, 24]);
    expect(analysis.chart.title).toBe('Synthetic');
    expect(cellCodes(analysis)).toEqual(expectedCodes(options));
    expect(analysis.chart.key.map((entry) => [entry.brand, entry.code, entry.name])).toEqual(
      palette.map((symbol) => ['DMC', symbol.code, symbol.name])
    );
    const black = analysis.chart.symbols.find((symbol) => analysis.chart.key.find((entry) => entry.code === '310')?.symbolKey === symbol.key);
    expect(black?.fillColor).toBe('#000000');
    expect(analysis.chart.warnings).toEqual([]);
  });

  it('assembles a chart split across 4 pages with overlap', { timeout: 30_000 }, async () => {
    const options = chart(56, 50, { pageColumns: 30, pageRows: 27, overlap: 2 });
    const analysis = await importPdf(await buildSyntheticChartPdf(options));
    expect(analysis.pages.map((page) => page.role)).toEqual(['chart', 'chart', 'chart', 'chart', 'key']);
    expect(analysis.detectedOverlap).toBe(2);
    expect([analysis.chart.width, analysis.chart.height]).toEqual([56, 50]);
    expect(cellCodes(analysis)).toEqual(expectedCodes(options));
  });

  it('flags a symbol missing from the key', { timeout: 30_000 }, async () => {
    const options = chart(20, 20, { omitFromKey: [2] });
    const analysis = await importPdf(await buildSyntheticChartPdf(options));
    const missing = analysis.chart.warnings.filter((warning) => warning.code === 'symbol-missing-from-key');
    expect(missing).toHaveLength(1);
    const symbol = analysis.chart.symbols.find((candidate) => candidate.key === missing[0].symbolKey);
    expect(symbol?.fillColor).toBe(palette[1].color);
    expect(analysis.chart.key.map((entry) => entry.code)).toEqual(['310', '3865', '798', '704']);
  });

  it('reads an Anchor-only key as Anchor and warns', { timeout: 30_000 }, async () => {
    const anchor = palette.map((symbol, index) => ({ ...symbol, code: ['403', '46', '1', '132', '238'][index] }));
    const options = chart(20, 20, { symbols: anchor, brand: 'Anchor' });
    const analysis = await importPdf(await buildSyntheticChartPdf(options));
    expect(analysis.chart.key.map((entry) => [entry.brand, entry.code])).toEqual(anchor.map((symbol) => ['ANCHOR', symbol.code]));
    expect(analysis.chart.warnings.filter((warning) => warning.code === 'unsupported-brand')).toHaveLength(anchor.length);
    expect(proposeMappings(analysis.chart).every((proposal) => proposal.status === 'guessed')).toBe(true);
  });

  it('warns about a cell holding two symbols', { timeout: 30_000 }, async () => {
    const options = chart(20, 20, { extraMarks: [{ x: 3, y: 2, symbol: 4 }] });
    const analysis = await importPdf(await buildSyntheticChartPdf(options));
    const multi = analysis.chart.warnings.filter((warning) => warning.code === 'multi-symbol-cell');
    expect(multi).toHaveLength(1);
    expect(multi[0].cell).toEqual({ x: 3, y: 2 });
    expect(analysis.chart.cells[2 * 20 + 3]).not.toBe(0);
  });

  it('rejects an image-only PDF as scanned', { timeout: 30_000 }, async () => {
    await expect(importPdf(await buildImageOnlyPdf())).rejects.toMatchObject({ code: 'unsupported-scanned-pdf' });
  });
});
