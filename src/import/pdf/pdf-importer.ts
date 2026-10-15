// The PDF `PatternImporter`: pdf.js reads every page into primitives once in
// `open`, then `analyze` classifies pages, reads the chart and key, and builds
// an `ImportedChart`, as often as the user changes page roles or overlap.
import { getDmcColor } from '../../catalog';
import {
  ImportError,
  type ImportAnalysis,
  type ImportColor,
  type ImportedKeyEntry,
  type ImportedSymbol,
  type ImportOverrides,
  type ImportPageRole,
  type ImportPageSummary,
  type ImportRunOptions,
  type ImportSession,
  type ImportWarning,
  type PatternImporter
} from '../types';
import { assembleChart } from './assemble';
import { readChartPage } from './chart-page';
import { extractPagePrimitives, readPdfTitle } from './extract';
import { detectGrid } from './grid';
import { readKeyPage } from './key';
import { openPdf } from './pdfjs';
import { renderPageThumbnail } from './thumbnail';
import type { AssembledCells, PdfGrid, PdfPagePrimitives } from './types';

const PDF_MAGIC = '%PDF-';
/** The PDF spec lets the header sit anywhere in the first 1024 bytes. */
const PDF_HEADER_WINDOW = 1024;
/** A page mostly covered by images, with no chart found, is a scan. */
const SCANNED_IMAGE_COVERAGE = 0.5;

interface DetectedPage {
  readonly grid: PdfGrid | null;
  readonly role: ImportPageRole;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ImportError('cancelled', 'The import was cancelled.');
}

function detectPage(page: PdfPagePrimitives): DetectedPage {
  const grid = detectGrid(page);
  if (grid) {
    const { x, y, width, height } = grid.bounds;
    const marked = page.marks.some((mark) => {
      const cx = mark.bounds.x + mark.bounds.width / 2;
      const cy = mark.bounds.y + mark.bounds.height / 2;
      return cx >= x && cx <= x + width && cy >= y && cy <= y + height;
    });
    if (marked) return { grid, role: 'chart' };
  }
  return { grid, role: readKeyPage(page).length > 0 ? 'key' : 'other' };
}

/** True when the page has a lattice with cell fills inside it but no marks: a colour-block chart. */
function colourOnlyChart(page: PdfPagePrimitives, grid: PdfGrid | null): boolean {
  if (!grid) return false;
  const { x, y, width, height } = grid.bounds;
  const inside = (r: { x: number; y: number; width: number; height: number }): boolean => {
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    return cx >= x && cx <= x + width && cy >= y && cy <= y + height;
  };
  return page.fills.some((fill) => inside(fill.bounds)) && !page.marks.some((mark) => inside(mark.bounds));
}

const COLOUR_ONLY_MESSAGE = 'This chart prints colour blocks without symbols, which cannot be imported yet.';

function titleFrom(fileName: string | undefined): string | undefined {
  const stem = fileName?.replace(/\.pdf$/i, '').trim();
  return stem || undefined;
}

/** The most common non-null fill per symbol key. */
function dominantFills(keys: readonly (string | null)[], fills: readonly (ImportColor | null)[]): Map<string, ImportColor> {
  const tallies = new Map<string, Map<ImportColor, number>>();
  keys.forEach((key, index) => {
    const fill = fills[index];
    if (key === null || !fill) return;
    let tally = tallies.get(key);
    if (!tally) tallies.set(key, (tally = new Map()));
    tally.set(fill, (tally.get(fill) ?? 0) + 1);
  });
  const result = new Map<string, ImportColor>();
  for (const [key, tally] of tallies) {
    let best: ImportColor | undefined;
    let bestCount = 0;
    for (const [fill, count] of tally) {
      if (count > bestCount) {
        best = fill;
        bestCount = count;
      }
    }
    if (best) result.set(key, best);
  }
  return result;
}

function keyWarnings(key: readonly ImportedKeyEntry[]): ImportWarning[] {
  const warnings: ImportWarning[] = [];
  for (const entry of key) {
    const label = `${entry.brand ?? ''} ${entry.code ?? ''}`.trim();
    if (entry.brand && entry.brand !== 'DMC') {
      warnings.push({ code: 'unsupported-brand', message: `${label} is not a DMC thread; choose a DMC match.`, symbolKey: entry.symbolKey });
    } else if (entry.blendCodes) {
      warnings.push({ code: 'blend-not-supported', message: `Blended threads aren't supported (${entry.blendCodes.join('+')}); the colour was matched from the chart.`, symbolKey: entry.symbolKey });
    } else if (entry.code && !getDmcColor(entry.code)) {
      warnings.push({ code: 'unknown-thread-code', message: `DMC ${entry.code} is not in the catalog.`, symbolKey: entry.symbolKey });
    }
  }
  return warnings;
}

function createSession(pages: PdfPagePrimitives[], thumbnails: (Blob | undefined)[], title: string | undefined): ImportSession {
  let detected: DetectedPage[] | null = null;

  return {
    async analyze(overrides: ImportOverrides = {}, options: ImportRunOptions = {}): Promise<ImportAnalysis> {
      const { signal, onProgress } = options;
      throwIfCancelled(signal);
      if (!detected) {
        const result: DetectedPage[] = [];
        for (const page of pages) {
          result.push(detectPage(page));
          onProgress?.({ stage: 'analyzing', done: result.length, total: pages.length });
          await Promise.resolve();
          throwIfCancelled(signal);
        }
        detected = result;
      }
      const roles = pages.map((page, index) => overrides.pageRoles?.[index] ?? detected?.[index]?.role ?? 'other');

      // A page the user marks as a chart still needs a lattice to read.
      const charted = pages.flatMap((page, index) => {
        const grid = roles[index] === 'chart' ? detected?.[index]?.grid ?? detectGrid(page) : null;
        return grid ? [{ page, grid }] : [];
      });
      // With user roles, no chart page is a state to review, not a failure.
      const initial = overrides.pageRoles === undefined;
      if (charted.length === 0 && initial) {
        if (pages.some((page, index) => colourOnlyChart(page, detected?.[index]?.grid ?? null))) {
          throw new ImportError('no-chart-found', COLOUR_ONLY_MESSAGE);
        }
        if (pages.some((page) => page.imageCoverage > SCANNED_IMAGE_COVERAGE)) {
          throw new ImportError('unsupported-scanned-pdf', 'This PDF is a scanned image. Only PDFs with a vector chart can be imported.');
        }
        throw new ImportError('no-chart-found', 'No chart grid was found in this PDF.');
      }

      const chartPages = charted.map(({ page, grid }) => readChartPage(page, grid));
      const assembled: AssembledCells = chartPages.length > 0
        ? assembleChart(chartPages, overrides.overlap === undefined ? undefined : { overlap: overrides.overlap })
        : { width: 0, height: 0, keys: [], fills: [], symbols: new Map(), overlap: overrides.overlap ?? 0, detectedOverlap: 0, placements: new Map(), warnings: [] };
      throwIfCancelled(signal);
      if (initial && chartPages.length > 0 && assembled.keys.every((cellKey) => cellKey === null) && assembled.fills.some((fill) => fill !== null)) {
        throw new ImportError('no-chart-found', COLOUR_ONLY_MESSAGE);
      }

      // Keys print on their own pages; a single-sheet pattern prints it beside the chart.
      const keyPages = pages.filter((page, index) => roles[index] === 'key');
      const keyRows = keyPages.length > 0
        ? keyPages.flatMap((page) => readKeyPage(page))
        : charted.flatMap(({ page, grid }) => readKeyPage(page, [grid.bounds]));
      const key: ImportedKeyEntry[] = [];
      const keyed = new Set<string>();
      for (const entry of keyRows) {
        if (keyed.has(entry.symbolKey)) continue;
        keyed.add(entry.symbolKey);
        key.push(entry);
      }

      const counts = new Map<string, number>();
      for (const cellKey of assembled.keys) if (cellKey !== null) counts.set(cellKey, (counts.get(cellKey) ?? 0) + 1);
      const fills = dominantFills(assembled.keys, assembled.fills);
      const symbols: ImportedSymbol[] = [];
      const indexOf = new Map<string, number>();
      for (const [symbolKey, symbol] of assembled.symbols) {
        const count = counts.get(symbolKey) ?? 0;
        if (count === 0) continue;
        const fillColor = fills.get(symbolKey);
        symbols.push({
          key: symbolKey,
          outlineD: symbol.outlineD,
          ...(symbol.unicode === undefined ? {} : { unicode: symbol.unicode }),
          count,
          ...(fillColor ? { fillColor } : {})
        });
        indexOf.set(symbolKey, symbols.length);
      }
      if (symbols.length > 0xfffe) throw new ImportError('too-large', 'This chart uses more symbols than a pattern can hold.');
      const cells = new Uint16Array(assembled.width * assembled.height);
      assembled.keys.forEach((cellKey, index) => {
        if (cellKey !== null) cells[index] = indexOf.get(cellKey) ?? 0;
      });

      const used = new Set(symbols.map((symbol) => symbol.key));
      const warnings: ImportWarning[] = [
        ...assembled.warnings,
        ...symbols.filter((symbol) => !keyed.has(symbol.key)).map((symbol): ImportWarning => ({
          code: 'symbol-missing-from-key',
          message: `A symbol used in ${String(symbol.count)} cell${symbol.count === 1 ? '' : 's'} is not in the key.`,
          symbolKey: symbol.key
        })),
        ...key.filter((entry) => !used.has(entry.symbolKey)).map((entry): ImportWarning => ({
          code: 'key-entry-unused',
          message: `Key entry ${`${entry.brand ?? ''} ${entry.code ?? ''}`.trim()} is not used in the chart.`,
          symbolKey: entry.symbolKey
        })),
        ...keyWarnings(key.filter((entry) => used.has(entry.symbolKey)))
      ];

      const summaries: ImportPageSummary[] = pages.map((page, index) => {
        const role = roles[index];
        const grid = role === 'chart' ? charted.find((chart) => chart.page === page)?.grid : undefined;
        const placement = grid ? assembled.placements.get(page.pageIndex) : undefined;
        const thumbnail = thumbnails[index];
        return {
          index,
          role,
          detectedRole: detected?.[index]?.role ?? 'other',
          width: page.width,
          height: page.height,
          ...(grid ? { grid: { columns: grid.columns, rows: grid.rows } } : {}),
          ...(placement ? { placement } : {}),
          ...(thumbnail ? { thumbnail } : {})
        };
      });

      return {
        format: pdfImporter.id,
        pages: summaries,
        overlap: assembled.overlap,
        detectedOverlap: assembled.detectedOverlap,
        chart: {
          width: assembled.width,
          height: assembled.height,
          cells,
          symbols,
          key,
          warnings,
          ...(title ? { title } : {})
        }
      };
    },

    async close(): Promise<void> {
      pages = [];
      thumbnails = [];
      detected = null;
    }
  };
}

export const pdfImporter: PatternImporter = {
  id: 'pdf',
  label: 'PDF',
  accept: ['.pdf', 'application/pdf'],

  sniff(head) {
    const window = String.fromCharCode(...head.subarray(0, PDF_HEADER_WINDOW));
    return window.includes(PDF_MAGIC);
  },

  /** pdf.js detaches `bytes.buffer`; pass a copy if the caller still needs the bytes. */
  async open(bytes, options = {}): Promise<ImportSession> {
    const { signal, onProgress, fileName } = options;
    throwIfCancelled(signal);
    let pdf: Awaited<ReturnType<typeof openPdf>>;
    try {
      pdf = await openPdf(bytes);
    } catch (error) {
      if ((error as { name?: unknown } | null)?.name === 'PasswordException') {
        throw new ImportError('encrypted-pdf', 'This PDF is password protected.', { cause: error });
      }
      throw new ImportError('invalid-pdf', 'This file could not be read as a PDF.', { cause: error });
    }

    try {
      const pages: PdfPagePrimitives[] = [];
      // Thumbnails render while the PDF is loaded; every analysis reuses them.
      const thumbnails: (Blob | undefined)[] = [];
      for (let index = 0; index < pdf.numPages; index += 1) {
        throwIfCancelled(signal);
        pages.push(await extractPagePrimitives(pdf, index, signal));
        throwIfCancelled(signal);
        thumbnails.push(await pdf.getPage(index + 1).then((page) => renderPageThumbnail(page), () => undefined));
        onProgress?.({ stage: 'reading', done: index + 1, total: pdf.numPages });
      }
      const title = (await readPdfTitle(pdf))?.trim() || titleFrom(fileName);
      return createSession(pages, thumbnails, title);
    } catch (error) {
      throwIfCancelled(signal);
      throw error;
    } finally {
      await pdf.loadingTask.destroy();
    }
  }
};
