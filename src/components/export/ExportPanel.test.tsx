import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CATALOG_DEFINITION } from '../../catalog';
import { createDocument } from '../../domain';
import { DEFAULT_EXPORT_SETTINGS, EXPORT_SETTINGS_STORAGE_KEY, type ExportSettings } from '../../export';
import { ExportDialog, ExportPanel, type ExportPanelProps, type ExportPanelWorkspace, type ExportPdf } from './ExportPanel';
import { applyCommand, cell } from '../../domain/test-fixtures';

const palette = [{ id: 1, name: 'Ruby', color: '#AA0000' }];
const makeDocument = (stitched: boolean, width = 14, height = 14) => {
  const pattern = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width, height, palette });
  return stitched ? applyCommand(pattern, cell(width, { type: 'set-full', x: 0, y: 0, color: 1 })).document : pattern;
};

function memoryStorage(initial?: ExportSettings) {
  const data = new Map<string, string>();
  if (initial) data.set(EXPORT_SETTINGS_STORAGE_KEY, JSON.stringify(initial));
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) };
}

function makeWorkspace() {
  const state = { materialSettings: { strands: 2, backstitchStrands: 1, waste: 0.1, skeinLengthMeters: 8 } as Record<string, unknown>, metadata: { units: 'metric' } as { units?: string } };
  const updateActiveMaterialSettings = vi.fn(async (changes: Record<string, unknown>) => { state.materialSettings = { ...state.materialSettings, ...changes }; });
  const updateActiveMetadata = vi.fn(async (changes: { units?: string }) => { Object.assign(state.metadata, changes); });
  const updateActiveAidaCount = vi.fn<ExportPanelWorkspace["updateActiveAidaCount"]>().mockResolvedValue(undefined);
  const workspace = {
    activeProjectId: 'p1',
    get materialSettings() { return state.materialSettings; },
    get metadata() { return state.metadata; },
    updateActiveMaterialSettings,
    updateActiveMetadata,
    updateActiveAidaCount
  } as unknown as ExportPanelWorkspace;
  return { workspace, updateActiveMaterialSettings, updateActiveMetadata, updateActiveAidaCount };
}

function setup(overrides: Partial<ExportPanelProps> = {}) {
  const ws = makeWorkspace();
  const storage = memoryStorage();
  const exportPdf = vi.fn<ExportPdf>().mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
  const props: ExportPanelProps = { document: makeDocument(true), title: 'Units quilt', workspace: ws.workspace, exportPdf, storage, ...overrides };
  const view = render(<ExportPanel {...props} />);
  return { ...ws, storage, exportPdf, view, props };
}

describe('ExportPanel', () => {
  it('shows the project Aida count and saves a change through the workspace', () => {
    const { updateActiveAidaCount } = setup();
    const select = screen.getByLabelText('Aida count');
    expect(select).toHaveValue('14');
    fireEvent.change(select, { target: { value: '18' } });
    expect(updateActiveAidaCount).toHaveBeenCalledWith(18);
  });

  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let click: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    createObjectURL = vi.fn(() => 'blob:export');
    revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  });
  afterEach(() => click.mockRestore());

  it('shows the current material settings and totals', () => {
    setup();
    expect(screen.getByLabelText('Strands per stitch')).toHaveValue(2);
    expect(screen.getByLabelText('Backstitch strands')).toHaveValue(1);
    expect(screen.getByLabelText('Waste allowance (%)')).toHaveValue(10);
    const totals = screen.getByRole('region', { name: 'Thread totals' });
    expect(within(totals).getByText('Ruby')).toBeInTheDocument();
    expect(within(totals).getByText('1 full')).toBeInTheDocument();
    expect(within(totals).getByText(/1 backstitch strand,/)).toBeInTheDocument();
  });

  it('saves strands, backstitch strands and waste automatically', async () => {
    const { updateActiveMaterialSettings } = setup();
    fireEvent.change(screen.getByLabelText('Strands per stitch'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Backstitch strands'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Waste allowance (%)'), { target: { value: '25' } });
    await screen.findByText('Material settings saved.');
    expect(updateActiveMaterialSettings).toHaveBeenCalledWith({ strands: 3, backstitchStrands: 2, waste: 0.25 });
    expect(screen.getByText(/3 strands per stitch, 2 backstitch strands, 25% waste/)).toBeInTheDocument();
  });

  it.each([
    ['Strands per stitch', '0', /Strands per stitch must be a whole number/],
    ['Backstitch strands', '1.5', /Backstitch strands must be a whole number/],
    ['Backstitch strands', '', /Backstitch strands must be a whole number/],
    ['Waste allowance (%)', '-1', /Waste allowance must be zero or more/]
  ])('rejects invalid %s %j without saving', (label, value, message) => {
    const { updateActiveMaterialSettings } = setup();
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.getByLabelText(label)).toBeInvalid();
    expect(updateActiveMaterialSettings).not.toHaveBeenCalled();
  });

  it('changes display units through the workspace', async () => {
    const { updateActiveMetadata } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Imperial' }));
    await waitFor(() => expect(updateActiveMetadata).toHaveBeenCalledWith({ units: 'imperial' }));
    expect(screen.getByRole('button', { name: 'Imperial' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(screen.getByRole('region', { name: 'Thread totals' })).getByText(/1 in × 1 in/)).toBeInTheDocument();
  });

  it('round-trips export settings through storage and updates the page estimate', () => {
    const { storage, view, props } = setup({ document: makeDocument(true, 120, 120) });
    const pages = () => Number(/Estimated length: (\d+) page/.exec(screen.getByTestId('export-page-count').textContent ?? '')?.[1]);
    const initial = pages();
    expect(initial).toBeGreaterThan(1);
    fireEvent.change(screen.getByLabelText('Page overlap (cells)'), { target: { value: '3' } });
    expect(pages()).toBeGreaterThanOrEqual(initial);
    fireEvent.change(screen.getByLabelText('Stitch size'), { target: { value: '5' } });
    const larger = pages();
    expect(larger).toBeGreaterThan(initial);
    fireEvent.change(screen.getByLabelText('Paper size'), { target: { value: 'a4' } });
    fireEvent.change(screen.getByLabelText('Orientation'), { target: { value: 'landscape' } });
    fireEvent.change(screen.getByLabelText('Margins'), { target: { value: 'narrow' } });
    fireEvent.click(screen.getByLabelText('Page numbers'));
    expect(screen.getByLabelText('Center mark')).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByLabelText('Center mark'));
    fireEvent.change(screen.getByLabelText('Chart style'), { target: { value: 'combined' } });
    const saved = JSON.parse(storage.data.get(EXPORT_SETTINGS_STORAGE_KEY) ?? '{}');
    expect(saved).toEqual({ paper: 'a4', orientation: 'landscape', margins: 'narrow', pageNumbers: false, centerMark: true, overlap: 3, cellSizeMm: 5, chartStyle: 'combined' });

    view.unmount();
    render(<ExportPanel {...props} />);
    expect(screen.getByLabelText('Paper size')).toHaveValue('a4');
    expect(screen.getByLabelText('Orientation')).toHaveValue('landscape');
    expect(screen.getByLabelText('Page overlap (cells)')).toHaveValue('3');
    expect(screen.getByRole('switch', { name: 'Page numbers' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Center mark' })).toBeChecked();
  });

  it('downloads a PDF blob and reports progress', async () => {
    let report: (fraction: number) => void = () => undefined;
    let finish: (bytes: Uint8Array) => void = () => undefined;
    const exportPdf = vi.fn<ExportPdf>((_settings, options) => new Promise((resolve) => { report = options.onProgress; finish = resolve; }));
    setup({ exportPdf, title: 'My: Quilt/1' });
    fireEvent.click(screen.getByRole('button', { name: 'Export PDF' }));
    expect(screen.getByRole('button', { name: 'Exporting…' })).toBeDisabled();
    act(() => report(0.5));
    expect(screen.getByRole('progressbar', { name: 'Export progress' })).toHaveAttribute('value', '0.5');
    expect(screen.getByText('50%')).toBeInTheDocument();
    await act(async () => finish(new Uint8Array([1, 2, 3])));
    await screen.findByText('Exported My- Quilt-1.pdf.');
    expect(exportPdf.mock.calls[0][0]).toEqual(DEFAULT_EXPORT_SETTINGS);
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('application/pdf');
    expect(blob.size).toBe(3);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('revokes the object URL after the click has been handled, not synchronously', async () => {
    vi.useFakeTimers();
    try {
      setup();
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Export PDF' })); });
      expect(click).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).not.toHaveBeenCalled();
      await act(async () => { vi.runAllTimers(); });
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:export');
    } finally {
      vi.useRealTimers();
    }
  });

  it('saves a pending material edit when the panel closes', () => {
    const { updateActiveMaterialSettings, view } = setup();
    fireEvent.change(screen.getByLabelText('Strands per stitch'), { target: { value: '4' } });
    view.unmount();
    expect(updateActiveMaterialSettings).toHaveBeenCalledWith({ strands: 4, backstitchStrands: 1, waste: 0.1 });
  });

  it('saves a dirty valid material draft before exporting', async () => {
    const { exportPdf, updateActiveMaterialSettings } = setup();
    fireEvent.change(screen.getByLabelText('Backstitch strands'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export PDF' }));
    await screen.findByText('Exported Units quilt.pdf.');
    expect(updateActiveMaterialSettings).toHaveBeenCalledWith({ strands: 2, backstitchStrands: 2, waste: 0.1 });
    expect(updateActiveMaterialSettings.mock.invocationCallOrder[0]).toBeLessThan(exportPdf.mock.invocationCallOrder[0]);
  });

  it('exports with the saved value the form shows', async () => {
    const { workspace, exportPdf } = setup();
    let seen: unknown;
    exportPdf.mockImplementationOnce(async () => {
      seen = (workspace.materialSettings as { backstitchStrands?: number } | null)?.backstitchStrands;
      return new Uint8Array([1]);
    });
    fireEvent.change(screen.getByLabelText('Backstitch strands'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export PDF' }));
    await screen.findByText('Exported Units quilt.pdf.');
    expect(seen).toBe(2);
  });

  it('blocks the export and shows the validation alert for an invalid draft', async () => {
    const { exportPdf, updateActiveMaterialSettings } = setup();
    fireEvent.change(screen.getByLabelText('Backstitch strands'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export PDF' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Backstitch strands must be a whole number/);
    expect(exportPdf).not.toHaveBeenCalled();
    expect(updateActiveMaterialSettings).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Export PDF' })).toBeEnabled();
  });

  it('does not save material settings when the draft is clean', async () => {
    const { exportPdf, updateActiveMaterialSettings } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Export PDF' }));
    await screen.findByText('Exported Units quilt.pdf.');
    expect(exportPdf).toHaveBeenCalledTimes(1);
    expect(updateActiveMaterialSettings).not.toHaveBeenCalled();
  });

  it('cancels a running export by aborting its signal', async () => {
    let signal: AbortSignal | undefined;
    const exportPdf = vi.fn<ExportPdf>((_settings, options) => new Promise((_resolve, reject) => {
      signal = options.signal;
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    setup({ exportPdf });
    fireEvent.click(screen.getByRole('button', { name: 'Export PDF' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel export' }));
    expect(signal?.aborted).toBe(true);
    await screen.findByText('Export cancelled.');
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Export PDF' })).toBeEnabled();
  });

  it('shows an export error and allows a retry', async () => {
    const exportPdf = vi.fn<ExportPdf>().mockRejectedValueOnce(new Error('Worker crashed')).mockResolvedValueOnce(new Uint8Array([1]));
    setup({ exportPdf });
    fireEvent.click(screen.getByRole('button', { name: 'Export PDF' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Worker crashed');
    expect(screen.getByRole('button', { name: 'Export PDF' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Export PDF' }));
    await screen.findByText('Exported Units quilt.pdf.');
  });

  it('disables export for an empty pattern and says why', () => {
    const { exportPdf } = setup({ document: makeDocument(false) });
    const button = screen.getByRole('button', { name: 'Export PDF' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription('Add stitches to the pattern before exporting.');
    fireEvent.click(button);
    expect(exportPdf).not.toHaveBeenCalled();
  });

  it('aborts a running export when the dialog closes', () => {
    let signal: AbortSignal | undefined;
    const exportPdf = vi.fn<ExportPdf>((_settings, options) => new Promise(() => { signal = options.signal; }));
    const onClose = vi.fn();
    const ws = makeWorkspace();
    const view = render(<ExportDialog document={makeDocument(true)} title="Quilt" workspace={ws.workspace} exportPdf={exportPdf} storage={memoryStorage()} onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: 'Export pattern' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export PDF' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close export' }));
    expect(onClose).toHaveBeenCalled();
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('closes the dialog once the PDF is downloaded', async () => {
    const onClose = vi.fn();
    const ws = makeWorkspace();
    render(<ExportDialog document={makeDocument(true)} title="Quilt" workspace={ws.workspace} exportPdf={vi.fn<ExportPdf>(async () => new Uint8Array([1]))} storage={memoryStorage()} onClose={onClose} />);
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Export pattern' })).getByRole('button', { name: 'Export PDF' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it('does not close the dialog when the export fails', async () => {
    const onClose = vi.fn();
    const ws = makeWorkspace();
    render(<ExportDialog document={makeDocument(true)} title="Quilt" workspace={ws.workspace} exportPdf={vi.fn<ExportPdf>(async () => { throw new Error('Boom.'); })} storage={memoryStorage()} onClose={onClose} />);
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Export pattern' })).getByRole('button', { name: 'Export PDF' }));
    await screen.findByText('Boom.');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows thread totals in the dialog', () => {
    const ws = makeWorkspace();
    render(<ExportDialog document={makeDocument(true)} title="Quilt" workspace={ws.workspace} exportPdf={vi.fn<ExportPdf>()} storage={memoryStorage()} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Export pattern' });
    expect(within(dialog).getByRole('region', { name: 'Thread totals' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Export PDF' })).toBeInTheDocument();
  });
});
