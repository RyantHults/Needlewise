import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CellKind, createDocument } from '../../domain';
import { DEFAULT_CATALOG_DEFINITION } from '../../catalog';
import { DEFAULT_EXPORT_SETTINGS } from '../../export';
import { createExportPdf } from './export-pdf';

const start = vi.hoisted(() => vi.fn());
const cover = vi.hoisted(() => vi.fn());
vi.mock('../../export/cover-image', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../export/cover-image')>()), renderCoverPng: cover }));
vi.mock('../../export/pdf-export-client', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../export/pdf-export-client')>()), startPdfExport: start }));

function pattern() {
  const document = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 3, height: 2, palette: [{ id: 1, name: 'Red', color: '#ff0000' }] });
  document.kind[0] = CellKind.Full;
  document.colors[0] = 1;
  document.completed[0] = 1;
  return document;
}

describe('createExportPdf', () => {
  beforeEach(() => {
    start.mockReset();
    cover.mockReset();
    cover.mockResolvedValue(new Uint8Array([9]));
  });

  it('hands the composite, current settings and units to the worker client and maps progress to a fraction', async () => {
    const bytes = new Uint8Array([1, 2]);
    start.mockReturnValue({ promise: Promise.resolve(bytes), cancel: vi.fn() });
    const document = pattern();
    const workspace = { metadata: { units: 'imperial' }, materialSettings: { strands: 2, backstitchStrands: 1, waste: 0.1 } } as never;
    const fractions: number[] = [];
    const signal = new AbortController().signal;

    const result = await createExportPdf(document, workspace, 'Garden')(DEFAULT_EXPORT_SETTINGS, { signal, onProgress: (fraction) => fractions.push(fraction) });

    expect(result).toBe(bytes);
    const [input, options] = start.mock.calls[0];
    options.onProgress({ completed: 1, total: 4 });
    expect(fractions).toEqual([0.25]);
    expect(input).toMatchObject({ name: 'Garden', units: 'imperial', settings: DEFAULT_EXPORT_SETTINGS });
    expect('completed' in input.document).toBe(false);
    expect(input.metrics.totals.full).toBe(1);
    expect(options.signal).toBe(signal);
    expect(input.coverImagePng).toEqual(new Uint8Array([9]));
  });

  it('crops the chart, finished size and cover to the stitched content unless auto-crop is off', async () => {
    start.mockReturnValue({ promise: Promise.resolve(new Uint8Array()), cancel: vi.fn() });
    const document = pattern();
    const workspace = { metadata: null, materialSettings: null } as never;
    const exportPdf = createExportPdf(document, workspace, 'Garden');
    const options = { signal: new AbortController().signal, onProgress: () => undefined };

    await exportPdf(DEFAULT_EXPORT_SETTINGS, options);
    await exportPdf({ ...DEFAULT_EXPORT_SETTINGS, autoCrop: false }, options);

    const [cropped, whole] = start.mock.calls.map(([input]) => input);
    expect(cropped.document).toMatchObject({ width: 1, height: 1 });
    expect(cropped.metrics.finishedSize.widthInches).toBeCloseTo(1 / document.settings.aidaCount);
    expect(cover.mock.calls[0][0].document).toMatchObject({ width: 1, height: 1 });
    expect(whole.document).toMatchObject({ width: 3, height: 2 });
    expect(whole.metrics.finishedSize.widthInches).toBeCloseTo(3 / document.settings.aidaCount);
    expect(document.width).toBe(3);
  });
});
