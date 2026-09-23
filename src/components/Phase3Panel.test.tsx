import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CATALOG_DEFINITION, type CatalogDefinition, type CatalogRecord } from '../catalog';
import { applyCommand, computePatternMetrics, createDocument, QuarterCorner } from '../domain';
import { Phase3Panel } from './Phase3Panel';

type DocumentOptions = Omit<Parameters<typeof createDocument>[0], 'catalog'>;
const makeDocument = (options: DocumentOptions) => createDocument({ ...options, catalog: DEFAULT_CATALOG_DEFINITION.association });
const materialsCatalogBRecord = { sourceId: 'b-source-1', code: '321', name: 'B Ruby', hex: '#BB0000', rgb: [187, 0, 0] as const } as CatalogRecord;
const materialsCatalogB: CatalogDefinition = { association: { catalogId: 'catalog-b', brandLabel: 'Brand B', colorCount: 1 }, records: [materialsCatalogBRecord], compatibilityLabel: 'Brand B-compatible', snapshot: { association: { catalogId: 'catalog-b', brandLabel: 'Brand B', colorCount: 1 }, records: [materialsCatalogBRecord] }, search: (query, options = {}) => (!query || 'B Ruby 321'.toLowerCase().includes(query.toLowerCase()) ? [materialsCatalogBRecord] : []).slice(0, options.limit), getByHex: (hex) => hex.toUpperCase() === '#BB0000' ? materialsCatalogBRecord : undefined, nearest: () => materialsCatalogBRecord };
function renderPanel(execute = vi.fn().mockResolvedValue(undefined), metadata: { units?: 'metric' | 'imperial' } | null = null) {
  const updateActiveMetadata = vi.fn().mockResolvedValue(undefined);
  const workspace = { activeProjectId: 'test', metadata, catalogFor: vi.fn(() => DEFAULT_CATALOG_DEFINITION), availableCatalogs: vi.fn(() => [DEFAULT_CATALOG_DEFINITION]), catalogById: vi.fn(() => DEFAULT_CATALOG_DEFINITION), materialSettings: null, updateActiveMaterialSettings: vi.fn().mockResolvedValue(undefined), updateActiveMetadata } as never;
  render(<Phase3Panel document={makeDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Black', color: '#000000' }, { id: 2, name: 'White', color: '#FFFFFF' }] })} metrics={null} sessionStats={null} activity={null} execute={execute} workspace={workspace} open />);
  return { execute, updateActiveMetadata };
}

describe('Phase3Panel palette controls', () => {
  it('lets Materials choose a catalog before searching and adds its selected record', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const workspace = { activeProjectId: 'multi', metadata: null, catalogFor: vi.fn(() => DEFAULT_CATALOG_DEFINITION), availableCatalogs: vi.fn(() => [DEFAULT_CATALOG_DEFINITION, materialsCatalogB]), catalogById: vi.fn((id: string) => id === 'catalog-b' ? materialsCatalogB : DEFAULT_CATALOG_DEFINITION), materialSettings: null, updateActiveMaterialSettings: vi.fn().mockResolvedValue(undefined), updateActiveMetadata: vi.fn().mockResolvedValue(undefined) } as never;
    render(<Phase3Panel document={makeDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Black', color: '#000000' }] })} metrics={null} sessionStats={null} activity={null} execute={execute} workspace={workspace} open />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a color to the palette' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a thread color' });
    const selector = within(dialog).getByRole('combobox', { name: 'Catalog' });
    fireEvent.change(selector, { target: { value: 'catalog-b' } });
    fireEvent.change(within(dialog).getByLabelText('Search Brand B catalog'), { target: { value: '321' } });
    const close = within(dialog).getByRole('button', { name: 'Close catalog dialog' });
    const last = within(dialog).getByRole('button', { name: 'Add B Ruby' });
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add B Ruby' }));
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ type: 'palette-create', catalog: expect.objectContaining({ catalogId: 'catalog-b', sourceId: 'b-source-1' }) }));
  });
  it('renders same-code Materials results without duplicate React keys', () => {
    const records = [
      { ...materialsCatalogBRecord, sourceId: 'source-a', name: 'Ruby A' },
      { ...materialsCatalogBRecord, sourceId: 'source-b', name: 'Ruby B' },
    ];
    const duplicateCodeCatalog = { ...materialsCatalogB, records, snapshot: { ...materialsCatalogB.snapshot, records }, search: () => records };
    const workspace = { activeProjectId: 'duplicate', metadata: null, catalogFor: vi.fn(() => duplicateCodeCatalog), availableCatalogs: vi.fn(() => [duplicateCodeCatalog]), catalogById: vi.fn(() => duplicateCodeCatalog), materialSettings: null, updateActiveMaterialSettings: vi.fn().mockResolvedValue(undefined), updateActiveMetadata: vi.fn().mockResolvedValue(undefined) } as never;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<Phase3Panel document={makeDocument({ width: 2, height: 2, palette: [] })} metrics={null} sessionStats={null} activity={null} execute={vi.fn().mockResolvedValue(undefined)} workspace={workspace} open />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a color to the palette' }));
    expect(screen.getByRole('button', { name: 'Add Ruby A' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Ruby B' })).toBeInTheDocument();
    expect(error.mock.calls.map(([message]) => String(message))).not.toEqual(expect.arrayContaining([expect.stringMatching(/same key|duplicate key/i)]));
    error.mockRestore();
  });
  it('labels the starter palette Black and White', () => {
    renderPanel();

    expect(screen.getByRole('heading', { name: 'Black and White' })).toBeInTheDocument();
    expect(screen.queryByText(/starter thread/i)).not.toBeInTheDocument();
  });

  it('focuses the offline catalog from the accessible plus control and returns to the palette after adding', async () => {
    const { execute } = renderPanel();
    const plus = screen.getByRole('button', { name: 'Add a color to the palette' });

    fireEvent.click(plus);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Search DMC catalog')));

    fireEvent.change(screen.getByLabelText('Search DMC catalog'), { target: { value: '310' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Add Black' }));
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ type: 'palette-create', name: 'Black', color: '#000000' }));
    await waitFor(() => expect(document.activeElement).toBe(plus));
  });

  it('inerts the whole application while the portalled catalog is open', async () => {
    const shell = document.createElement('div');
    shell.dataset.application = '';
    document.body.append(shell);
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Add a color to the palette' }));

    expect(shell).toHaveProperty('inert', true);
    expect(screen.getByRole('dialog', { name: 'Add a thread color' }).closest('[data-application]')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Plan the thread' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText('Search DMC catalog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add a thread color' })).not.toBeInTheDocument());
    expect(shell).toHaveProperty('inert', true);
    shell.remove();
  });

  it('keeps the nested catalog open and focused across onClose changes; Escape closes only it', async () => {
    const onClose = vi.fn();
    const workspace = { activeProjectId: 'nested', catalogFor: vi.fn(() => DEFAULT_CATALOG_DEFINITION), availableCatalogs: vi.fn(() => [DEFAULT_CATALOG_DEFINITION]), catalogById: vi.fn(() => DEFAULT_CATALOG_DEFINITION), materialSettings: null, updateActiveMaterialSettings: vi.fn().mockResolvedValue(undefined), updateActiveMetadata: vi.fn().mockResolvedValue(undefined) } as never;
    const props = { document: makeDocument({ width: 2, height: 2, palette: [] }), metrics: null, sessionStats: null, activity: null, execute: vi.fn().mockResolvedValue(undefined), workspace, open: true };
    const view = render(<Phase3Panel {...props} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a color to the palette' }));
    const search = screen.getByLabelText('Search DMC catalog');
    await waitFor(() => expect(document.activeElement).toBe(search));
    view.rerender(<Phase3Panel {...props} onClose={() => onClose()} />);
    expect(screen.getByRole('dialog', { name: 'Add a thread color' })).toBeInTheDocument();
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add a thread color' })).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'Plan the thread' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows finished size and per-color plus total physical estimates in metric by default', () => {
    const pattern = makeDocument({ width: 14, height: 14, palette: [{ id: 1, name: 'Ruby', color: '#AA0000' }] });
    const computed = computePatternMetrics(pattern, { aidaCount: 14, strands: 2, waste: 0.2, skeinLengthMeters: 8 });
    render(<Phase3Panel document={pattern} metrics={computed} sessionStats={null} activity={null} execute={vi.fn()} workspace={{ activeProjectId: 'one', catalogFor: vi.fn(() => DEFAULT_CATALOG_DEFINITION), availableCatalogs: vi.fn(() => [DEFAULT_CATALOG_DEFINITION]), catalogById: vi.fn(() => DEFAULT_CATALOG_DEFINITION), materialSettings: computed.materialSettings, updateActiveMaterialSettings: vi.fn().mockResolvedValue(undefined), updateActiveMetadata: vi.fn().mockResolvedValue(undefined) } as never} />);

    // No units on the project: metric is the default single display.
    expect(screen.getByText(/2\.54 × 2\.54 cm/)).toBeInTheDocument();
    expect(screen.queryByText(/1 × 1 in/)).not.toBeInTheDocument();
    // Thread lines show skeins, never raw lengths; equal rounded bounds collapse.
    expect(screen.getByText('0 skeins')).toBeInTheDocument();
    expect(screen.getByText('Total: 0 skeins')).toBeInTheDocument();
    // Yardage sub-lines render in both unit modes, collapsed the same way.
    expect(screen.getAllByText('0 yd').length).toBe(2);
    expect(screen.queryByText(/ m–/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/skein/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Total:/)).toBeInTheDocument();
  });

  it('renders inches and skeins when the project prefers imperial', () => {
    let pattern = makeDocument({ width: 14, height: 14, palette: [{ id: 1, name: 'Ruby', color: '#AA0000' }] });
    pattern = applyCommand(pattern, { type: 'set-full', x: 0, y: 0, color: 1 }).document;
    const computed = computePatternMetrics(pattern, { aidaCount: 14, strands: 2, waste: 0.2, skeinLengthMeters: 8 });
    render(<Phase3Panel document={pattern} metrics={computed} sessionStats={null} activity={null} execute={vi.fn()} workspace={{ activeProjectId: 'one', catalogFor: vi.fn(() => DEFAULT_CATALOG_DEFINITION), availableCatalogs: vi.fn(() => [DEFAULT_CATALOG_DEFINITION]), catalogById: vi.fn(() => DEFAULT_CATALOG_DEFINITION), metadata: { units: 'imperial' }, materialSettings: computed.materialSettings, updateActiveMaterialSettings: vi.fn().mockResolvedValue(undefined), updateActiveMetadata: vi.fn().mockResolvedValue(undefined) } as never} />);

    expect(screen.getByText(/1 × 1 in/)).toBeInTheDocument();
    expect(screen.queryByText(/2\.54 × 2\.54 cm/)).not.toBeInTheDocument();
    // Skein math reuses the meter estimates with the same rounding; equal
    // rounded bounds collapse to a single value.
    const format = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    const skeins = computed.totalMaterial?.estimateRange?.skeins;
    const lo = format(skeins?.min ?? 0);
    const hi = format(skeins?.max ?? 0);
    const expected = lo === hi ? `${lo} skeins` : `${lo}–${hi} skeins`;
    expect(screen.getByText(/Total:/).textContent).toContain(expected);
    // Yardage follows the meter range with the same rounding and collapse.
    const yardsRange = computed.totalMaterial?.estimateRange?.meters;
    const ylo = format((yardsRange?.min ?? 0) * 1.09361);
    const yhi = format((yardsRange?.max ?? 0) * 1.09361);
    const expectedYards = ylo === yhi ? `${ylo} yd` : `${ylo}–${yhi} yd`;
    expect(screen.getByText(/Total:/).textContent).toContain(expectedYards);
    expect(screen.getAllByText(expectedYards).length).toBe(2);
    // The model provenance note names its calibration in both units.
    expect(screen.getByText(/2\.03 cm/)).toBeInTheDocument();
    expect(screen.getAllByText(/skeins/).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/ m–/)).not.toBeInTheDocument();
  });

  it('renders distinct skein bounds as a range', () => {
    let pattern = makeDocument({ width: 14, height: 14, palette: [{ id: 1, name: 'Ruby', color: '#AA0000' }] });
    for (let x = 0; x < 10; x++) pattern = applyCommand(pattern, { type: 'set-full', x, y: 0, color: 1 }).document;
    const computed = computePatternMetrics(pattern, { aidaCount: 14, strands: 2, waste: 0.5, skeinLengthMeters: 8 });
    render(<Phase3Panel document={pattern} metrics={computed} sessionStats={null} activity={null} execute={vi.fn()} workspace={{ activeProjectId: 'one', catalogFor: vi.fn(() => DEFAULT_CATALOG_DEFINITION), availableCatalogs: vi.fn(() => [DEFAULT_CATALOG_DEFINITION]), catalogById: vi.fn(() => DEFAULT_CATALOG_DEFINITION), materialSettings: computed.materialSettings, updateActiveMaterialSettings: vi.fn().mockResolvedValue(undefined), updateActiveMetadata: vi.fn().mockResolvedValue(undefined) } as never} />);

    const format = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    const skeins = computed.totalMaterial?.estimateRange?.skeins;
    const lo = format(skeins?.min ?? 0);
    const hi = format(skeins?.max ?? 0);
    expect(lo).not.toBe(hi);
    expect(screen.getByText(/Total:/).textContent).toContain(`${lo}–${hi} skeins`);
    const yardsRange = computed.totalMaterial?.estimateRange?.meters;
    const ylo = format((yardsRange?.min ?? 0) * 1.09361);
    const yhi = format((yardsRange?.max ?? 0) * 1.09361);
    expect(ylo).not.toBe(yhi);
    expect(screen.getByText(/Total:/).textContent).toContain(`${ylo}–${yhi} yd`);
  });

  it('shows a palette made only of three-quarter stitches', () => {
    let pattern = makeDocument({ width: 2, height: 1, palette: [{ id: 1, name: 'Ruby', color: '#AA0000' }] });
    pattern = applyCommand(pattern, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.NW, color: 1 }).document;
    pattern = applyCommand(pattern, { type: 'set-three-quarter', x: 1, y: 0, corner: QuarterCorner.SE, color: 1 }).document;
    const computed = computePatternMetrics(pattern, { aidaCount: 14, strands: 1, waste: 0, skeinLengthMeters: 8 });

    render(<Phase3Panel document={pattern} metrics={computed} sessionStats={null} activity={null} execute={vi.fn()} workspace={{ activeProjectId: 'one', catalogFor: vi.fn(() => DEFAULT_CATALOG_DEFINITION), availableCatalogs: vi.fn(() => [DEFAULT_CATALOG_DEFINITION]), catalogById: vi.fn(() => DEFAULT_CATALOG_DEFINITION), materialSettings: computed.materialSettings, updateActiveMaterialSettings: vi.fn().mockResolvedValue(undefined), updateActiveMetadata: vi.fn().mockResolvedValue(undefined) } as never} />);

    expect(screen.getByText('0 full · 0 half · 0 quarter · 2 3/4 · 0 backstitch')).toBeInTheDocument();
  });

  it('leaves unit selection to project settings while following metadata units', () => {
    const pattern = makeDocument({ width: 14, height: 14, palette: [{ id: 1, name: 'Ruby', color: '#AA0000' }] });
    const computed = computePatternMetrics(pattern, { aidaCount: 14, strands: 2, waste: 0.2, skeinLengthMeters: 8 });
    const metricWorkspace = { activeProjectId: 'one', catalogFor: vi.fn(() => DEFAULT_CATALOG_DEFINITION), availableCatalogs: vi.fn(() => [DEFAULT_CATALOG_DEFINITION]), catalogById: vi.fn(() => DEFAULT_CATALOG_DEFINITION), materialSettings: computed.materialSettings, updateActiveMaterialSettings: vi.fn().mockResolvedValue(undefined), updateActiveMetadata: vi.fn().mockResolvedValue(undefined) };
    const view = render(<Phase3Panel document={pattern} metrics={computed} sessionStats={null} activity={null} execute={vi.fn()} workspace={metricWorkspace as never} />);
    // The estimate card renders no toggle of its own.
    expect(screen.queryByRole('button', { name: 'Metric' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Imperial' })).not.toBeInTheDocument();
    expect(screen.getByText(/2\.54 × 2\.54 cm/)).toBeInTheDocument();
    view.rerender(<Phase3Panel document={pattern} metrics={computed} sessionStats={null} activity={null} execute={vi.fn()} workspace={{ ...metricWorkspace, metadata: { units: 'imperial' } } as never} />);
    expect(screen.getByText(/1 × 1 in/)).toBeInTheDocument();
    expect(screen.queryByText(/2\.54 × 2\.54 cm/)).not.toBeInTheDocument();
  });
});
