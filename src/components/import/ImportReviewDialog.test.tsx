import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDmcColor } from '../../catalog';
import { SYMBOL_IDS, getSymbolOutline } from '../../symbols';
import { ImportError, type ImportAnalysis } from '../../import/types';
import { ImportReviewDialog } from './ImportReviewDialog';

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  reanalyze: vi.fn(),
  dispose: vi.fn(),
  build: vi.fn(),
  propose: vi.fn(),
  assign: vi.fn(),
  max: vi.fn()
}));
vi.mock('../../import/import-client', () => ({
  createPatternImportClient: () => ({ open: mocks.open, reanalyze: mocks.reanalyze, close: vi.fn(), dispose: mocks.dispose })
}));
vi.mock('../../import/build-document', () => ({
  buildImportedDocument: mocks.build,
  proposeMappings: mocks.propose,
  assignSymbolSlugs: mocks.assign,
  maxImportColors: mocks.max
}));

const slug = SYMBOL_IDS[0];
const black = getDmcColor('310')?.hex ?? '#000000';
const red = getDmcColor('321');

function analysis(overrides: Partial<ImportAnalysis> = {}): ImportAnalysis {
  return {
    format: 'pdf',
    pages: [
      { index: 0, role: 'chart', detectedRole: 'chart', width: 600, height: 800, grid: { columns: 20, rows: 30 } },
      { index: 1, role: 'key', detectedRole: 'key', width: 600, height: 800 }
    ],
    chart: {
      width: 3,
      height: 2,
      cells: new Uint16Array([1, 2, 0, 2, 1, 1]),
      symbols: [
        { key: 'a', outlineD: 'M0 0H1V1H0Z', count: 3 },
        { key: 'b', outlineD: 'M0 0H1V1Z', count: 2 }
      ],
      key: [{ symbolKey: 'a', brand: 'DMC', code: '310' }],
      warnings: [{ code: 'key-entry-unused', message: 'Key entry 321 is never used.' }],
      title: 'Garden',
      fabricCount: 18
    },
    ...overrides
  };
}

const proposals = [
  { symbolKey: 'a', catalogCode: '310', status: 'matched' as const },
  { symbolKey: 'b', status: 'unmapped' as const, reason: 'No code in the key' }
];

interface Recorded { fillRect: Array<[number, number, number, number, string]>; fills: string[] }
let recorded: Recorded;

beforeEach(() => {
  vi.clearAllMocks();
  recorded = { fillRect: [], fills: [] };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => {
    const context = {
      fillStyle: '',
      fillRect: (x: number, y: number, w: number, h: number) => recorded.fillRect.push([x, y, w, h, context.fillStyle]),
      fill: (path: { d: string }) => recorded.fills.push(path.d),
      save: vi.fn(), restore: vi.fn(), translate: vi.fn(), scale: vi.fn()
    };
    return context;
  }) as never);
  mocks.open.mockResolvedValue(analysis());
  mocks.reanalyze.mockResolvedValue(analysis());
  mocks.propose.mockReturnValue(proposals);
  mocks.assign.mockReturnValue(new Map([['a', slug]]));
  mocks.build.mockReturnValue({ width: 3, height: 2 });
  mocks.max.mockReturnValue(100);
  let urls = 0;
  Object.assign(URL, { createObjectURL: vi.fn(() => `blob:page-${++urls}`), revokeObjectURL: vi.fn() });
});
afterEach(() => vi.restoreAllMocks());

function renderDialog(overrides: { onCreate?: () => Promise<void>; onClose?: () => void } = {}) {
  const onCreate = overrides.onCreate ?? vi.fn().mockResolvedValue(undefined);
  const onClose = overrides.onClose ?? vi.fn();
  const view = render(<ImportReviewDialog file={new File(['%PDF-'], 'garden.pdf', { type: 'application/pdf' })} onClose={onClose} onCreate={onCreate} />);
  return { ...view, onCreate, onClose };
}
const next = () => fireEvent.click(screen.getByRole('button', { name: 'Next' }));
const wizard = () => screen.getByRole('dialog', { name: 'Import a pattern' });
async function openKeyStep() {
  await screen.findByRole('heading', { name: 'Pages' });
  next(); next();
  await screen.findByRole('heading', { name: 'Key' });
}
/** Picks DMC 321 Red in the open thread picker. Label queries throughout: role queries walk the whole catalog grid and are slow. */
function pickRed() {
  const picker = screen.getByLabelText(/Choose thread for symbol/);
  fireEvent.change(within(picker).getByLabelText('Search DMC catalog'), { target: { value: '321' } });
  fireEvent.click(within(picker).getByLabelText(`${red?.name}, color 321`));
  fireEvent.click(within(picker).getByLabelText(`Use ${red?.name}`));
}

describe('ImportReviewDialog', () => {
  it('shows progress while reading, then lists the pages', async () => {
    let resolve: (value: ImportAnalysis) => void = () => undefined;
    mocks.open.mockImplementation((_file, _name, options) => new Promise<ImportAnalysis>((done) => { resolve = done; options.onProgress({ stage: 'reading', done: 1, total: 4 }); }));
    renderDialog();
    expect(await screen.findByText('Reading page 2 of 4…')).toBeInTheDocument();
    expect(screen.getByLabelText('Reading the PDF')).toBeInTheDocument();
    await act(async () => resolve(analysis()));
    expect(await screen.findByRole('heading', { name: 'Pages' })).toBeInTheDocument();
    expect(screen.getByLabelText('Role of page 1')).toHaveValue('chart');
    expect(screen.getByLabelText('Role of page 2')).toHaveValue('key');
  });

  it('re-reads the pattern when a page role changes', async () => {
    renderDialog();
    fireEvent.change(await screen.findByLabelText('Role of page 2'), { target: { value: 'other' } });
    await waitFor(() => expect(mocks.reanalyze).toHaveBeenCalledWith({ pageRoles: { 0: 'chart', 1: 'other' } }));
  });

  it('previews the chart with mapped colours and pool outlines', async () => {
    renderDialog();
    await screen.findByRole('heading', { name: 'Pages' });
    next();
    expect(await screen.findByRole('img', { name: 'Chart preview, 3 by 2 stitches' })).toBeInTheDocument();
    expect(screen.getByText('3 × 2 stitches, 2 symbols.')).toBeInTheDocument();
    expect(screen.getByText('Key entry 321 is never used.')).toBeInTheDocument();
    // Symbol a (3 cells) is painted in the DMC colour; unmapped b is not coloured; the empty cell is skipped.
    expect(recorded.fillRect.filter(([, , , , color]) => color === black)).toHaveLength(3);
    expect(recorded.fills).toEqual([getSymbolOutline(slug)?.d, getSymbolOutline(slug)?.d, getSymbolOutline(slug)?.d]);
  });

  it('highlights unmapped rows, blocks creation until every symbol has a thread, then builds the pattern', async () => {
    const { onCreate } = renderDialog();
    await screen.findByRole('heading', { name: 'Pages' });
    next(); next();
    expect(await screen.findByRole('heading', { name: 'Key' })).toHaveFocus();
    const rows = screen.getAllByRole('row').filter((item) => item.hasAttribute('data-status'));
    expect(rows.map((row) => row.getAttribute('data-status'))).toEqual(['matched', 'unmapped']);
    expect(within(rows[0]).getByText('DMC 310')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Not in key')).toBeInTheDocument();
    expect(screen.getByText('1 symbol has no thread yet. Choose one before creating the pattern.')).toBeInTheDocument();

    fireEvent.click(within(rows[1]).getByRole('button', { name: /Change/ }));
    pickRed();
    expect(screen.queryByRole('dialog', { name: /Choose thread/ })).not.toBeInTheDocument();
    expect(within(rows[1]).getByText(`DMC 321 ${red?.name}`)).toBeInTheDocument();
    expect(screen.queryByText(/has no thread yet/)).not.toBeInTheDocument();

    next();
    expect(screen.getByLabelText('Title')).toHaveValue('Garden');
    expect(screen.getByLabelText('Aida count')).toHaveValue('18');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: ' My sampler ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create pattern' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({ document: { width: 3, height: 2 }, title: 'My sampler', aidaCount: 18, format: 'pdf' }));
    expect(mocks.build).toHaveBeenCalledWith(expect.anything(), [
      { symbolKey: 'a', catalogCode: '310', color: undefined, symbolSlug: undefined },
      { symbolKey: 'b', catalogCode: '321' }
    ], { aidaCount: 18 });
  });

  it('disables Create while any symbol has no thread', async () => {
    renderDialog();
    await screen.findByRole('heading', { name: 'Pages' });
    next(); next(); next();
    expect(screen.getByRole('button', { name: 'Create pattern' })).toBeDisabled();
  });

  it('reports a file that cannot be read', async () => {
    mocks.open.mockRejectedValue(new ImportError('encrypted-pdf', 'x'));
    const { onClose } = renderDialog();
    expect(await screen.findByRole('alert')).toHaveTextContent('password protected');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('reports a failed save and stays open', async () => {
    mocks.propose.mockReturnValue([proposals[0], { symbolKey: 'b', catalogCode: '321', status: 'matched' }]);
    renderDialog({ onCreate: vi.fn().mockRejectedValue(new Error('disk full')) });
    await screen.findByRole('heading', { name: 'Pages' });
    next(); next(); next();
    fireEvent.click(screen.getByRole('button', { name: 'Create pattern' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The pattern could not be saved locally.');
    expect(screen.getByRole('button', { name: 'Create pattern' })).toBeEnabled();
  });

  it('disposes the client when it unmounts', async () => {
    const { unmount } = renderDialog();
    await screen.findByRole('heading', { name: 'Pages' });
    unmount();
    expect(mocks.dispose).toHaveBeenCalled();
  });

  it('keeps the page roles on screen when a re-read fails', async () => {
    renderDialog();
    const select = await screen.findByLabelText('Role of page 2');
    mocks.reanalyze.mockRejectedValueOnce(new Error('worker died'));
    fireEvent.change(select, { target: { value: 'other' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('The pattern could not be re-read.');
    expect(screen.getByLabelText('Role of page 2')).toHaveValue('key');
    // The failed change was not committed: the next re-read starts from the roles on screen.
    fireEvent.change(screen.getByLabelText('Role of page 1'), { target: { value: 'other' } });
    await waitFor(() => expect(mocks.reanalyze).toHaveBeenLastCalledWith({ pageRoles: { 0: 'other', 1: 'key' } }));
  });

  it('explains an empty chart and blocks creation', async () => {
    const emptyChart = { ...analysis().chart, width: 0, height: 0, cells: new Uint16Array(0), symbols: [], key: [], warnings: [] };
    mocks.reanalyze.mockResolvedValue(analysis({ chart: emptyChart, pages: [{ index: 0, role: 'other', detectedRole: 'chart', width: 600, height: 800 }] }));
    mocks.propose.mockReturnValue([]);
    renderDialog();
    fireEvent.change(await screen.findByLabelText('Role of page 2'), { target: { value: 'other' } });
    expect(await screen.findByText('No chart pages are selected. Mark at least one page as a chart.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    next();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('warns when the chart has more colors than the catalog allows and blocks creation', async () => {
    mocks.max.mockReturnValue(1);
    mocks.propose.mockReturnValue([proposals[0], { symbolKey: 'b', catalogCode: '321', status: 'matched' }]);
    renderDialog();
    await screen.findByRole('heading', { name: 'Pages' });
    next();
    expect(screen.getByText('This chart uses 2 colors, but at most 1 are supported, so it cannot be created.')).toBeInTheDocument();
    next(); next();
    expect(screen.getByRole('button', { name: 'Create pattern' })).toBeDisabled();
  });

  it('shows the importer message for too-many-colors and too-large failures', async () => {
    mocks.propose.mockReturnValue([proposals[0], { symbolKey: 'b', catalogCode: '321', status: 'matched' }]);
    renderDialog({ onCreate: vi.fn().mockRejectedValue(new ImportError('too-many-colors', 'This chart uses 900 colors.')) });
    await screen.findByRole('heading', { name: 'Pages' });
    next(); next(); next();
    fireEvent.click(screen.getByRole('button', { name: 'Create pattern' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This chart uses 900 colors.');
  });

  it('ignores Escape while the pattern is being created', async () => {
    mocks.propose.mockReturnValue([proposals[0], { symbolKey: 'b', catalogCode: '321', status: 'matched' }]);
    const { onClose } = renderDialog({ onCreate: () => new Promise<void>(() => undefined) });
    await screen.findByRole('heading', { name: 'Pages' });
    next(); next(); next();
    fireEvent.click(screen.getByRole('button', { name: 'Create pattern' }));
    expect(await screen.findByRole('button', { name: 'Creating…' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('returns focus to the row Change button after choosing a thread', async () => {
    renderDialog();
    await openKeyStep();
    const change = screen.getAllByRole('button', { name: /Change/ })[1];
    fireEvent.click(change);
    pickRed();
    await waitFor(() => expect(change).toHaveFocus());
  });

  it('shows each page thumbnail and revokes its URL when it changes or unmounts', async () => {
    const first = new Blob(['png'], { type: 'image/png' });
    const pages = analysis().pages;
    mocks.open.mockResolvedValue(analysis({ pages: [{ ...pages[0], thumbnail: first }, pages[1]] }));
    mocks.reanalyze.mockResolvedValue(analysis({ pages: [{ ...pages[0], thumbnail: new Blob(['png2'], { type: 'image/png' }) }, { ...pages[1], role: 'other' }] }));
    const { unmount } = renderDialog();
    const image = await screen.findByRole('img', { name: 'Page 1 preview' });
    expect(image).toHaveAttribute('src', 'blob:page-1');
    expect(URL.createObjectURL).toHaveBeenCalledWith(first);
    expect(screen.queryByRole('img', { name: 'Page 2 preview' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Role of page 2'), { target: { value: 'other' } });
    await waitFor(() => expect(screen.getByRole('img', { name: 'Page 1 preview' })).toHaveAttribute('src', 'blob:page-2'));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:page-1');
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:page-2');
  });

  it('explains that the chart must print a symbol in each cell when none is found', async () => {
    mocks.open.mockRejectedValue(new ImportError('no-chart-found', 'x'));
    renderDialog();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('No cross stitch chart was found in this PDF.');
    expect(alert).toHaveTextContent('The chart needs a symbol printed in each stitched cell, because Needlewise reads the symbols to rebuild the pattern.');
  });

  it('lays the key out as a table with a notice on the detected symbols', async () => {
    renderDialog();
    await openKeyStep();
    const headers = screen.getAllByRole('columnheader');
    // The notice is a tip on the symbol heading, plus a copy by the description for the stacked phone layout.
    const info = within(headers[0]).getByRole('button', { name: 'Detected symbol information' });
    expect(info).toHaveAccessibleDescription();
    expect(screen.getByRole('button', { name: 'About the detected symbols' })).toBeInTheDocument();
    const rows = screen.getAllByRole('row').filter((item) => item.hasAttribute('data-status'));
    expect(within(rows[0]).getByText('3')).toBeInTheDocument();
    expect(within(rows[1]).getByText(/No code in the key/)).toBeInTheDocument();
  });

  it('opens the shared picker on the current thread, and a custom pick keeps its hex and catalog match', async () => {
    renderDialog();
    await openKeyStep();
    fireEvent.click(screen.getAllByRole('button', { name: /Change/ })[0]);
    const picker = screen.getByLabelText('Choose thread for symbol 1');
    const selection = picker.querySelector<HTMLElement>('.catalog-selection') as HTMLElement;
    const custom = picker.querySelector<HTMLElement>('.custom-color-action') as HTMLElement;
    expect(within(selection).getByLabelText('Use Black')).toBeInTheDocument();
    fireEvent.change(within(picker).getByLabelText('Hex color'), { target: { value: '#123456' } });
    expect(custom).toHaveAccessibleName('Use #123456');
    // A hex that is exactly a catalog thread becomes that thread, and the button says so.
    fireEvent.change(within(picker).getByLabelText('Hex color'), { target: { value: '#C72B3B' } });
    expect(custom).toHaveAccessibleName(`Use ${red?.name}`);
    fireEvent.click(custom);
    // #C72B3B is DMC 321, so the catalog code rides along with the hex and names the row.
    const rows = screen.getAllByRole('row').filter((item) => item.hasAttribute('data-status'));
    expect(within(rows[0]).getByText(`DMC 321 ${red?.name}`)).toBeInTheDocument();
  });

  it('closes only the picker on Escape, leaving the wizard open', async () => {
    const { onClose } = renderDialog();
    await openKeyStep();
    const change = screen.getAllByRole('button', { name: /Change/ })[1];
    fireEvent.click(change);
    const picker = screen.getByLabelText('Choose thread for symbol 2');
    fireEvent.keyDown(within(picker).getByLabelText('Search DMC catalog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /Choose thread/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Leave import?' })).not.toBeInTheDocument();
    expect(wizard()).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(change).toHaveFocus());
  });

  it('asks before leaving when Escape is pressed with focus on the page', async () => {
    renderDialog();
    await screen.findByRole('heading', { name: 'Pages' });
    (document.activeElement as HTMLElement).blur();

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(screen.getByRole('dialog', { name: 'Leave import?' })).toBeInTheDocument();
  });

  it('opens the symbol info on click, and Escape closes only the tip', async () => {
    const { onClose } = renderDialog();
    await openKeyStep();
    const info = screen.getByRole('button', { name: 'Detected symbol information' });
    fireEvent.click(info);
    expect(info).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(info, { key: 'Escape' });
    expect(info).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog', { name: 'Leave import?' })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    // With the tip closed, Escape goes back to asking about leaving.
    fireEvent.keyDown(info, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Leave import?' })).toBeInTheDocument();
  });

  it('asks before leaving once the analysis has loaded', async () => {
    const { onClose } = renderDialog();
    await screen.findByRole('heading', { name: 'Pages' });
    fireEvent.keyDown(wizard(), { key: 'Escape' });
    const confirm = screen.getByRole('dialog', { name: 'Leave import?' });
    // Escape inside the confirm closes only the confirm.
    fireEvent.keyDown(within(confirm).getByRole('button', { name: 'Keep importing' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Leave import?' })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Close import dialog' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep importing' }));
    expect(screen.queryByRole('dialog', { name: 'Leave import?' })).not.toBeInTheDocument();
    expect(wizard()).toBeInTheDocument();

    fireEvent.click(wizard().parentElement as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes without asking while the file is still opening', async () => {
    mocks.open.mockReturnValue(new Promise(() => undefined));
    const { onClose } = renderDialog();
    expect(await screen.findByLabelText('Reading the PDF')).toBeInTheDocument();
    fireEvent.keyDown(wizard(), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Leave import?' })).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes without asking after the file fails to open', async () => {
    mocks.open.mockRejectedValue(new ImportError('invalid-pdf', 'x'));
    const { onClose } = renderDialog();
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Close import dialog' }));
    expect(screen.queryByRole('dialog', { name: 'Leave import?' })).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
