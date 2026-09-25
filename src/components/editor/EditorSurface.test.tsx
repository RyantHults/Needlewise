import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorSurface } from './EditorSurface';
import { createEditorSurfaceController } from '../../editor';
import { createCatalogReference, DEFAULT_CATALOG_DEFINITION, type CatalogDefinition, type CatalogRecord } from '../../catalog';
import { PALETTE_SYMBOLS } from '../../domain';
import stylesText from '../../styles.css?inline';

const compactDmcRecords = [...new Map([
  ...DEFAULT_CATALOG_DEFINITION.search('31', { limit: 12 }),
  DEFAULT_CATALOG_DEFINITION.search('321', { limit: 1 })[0],
  DEFAULT_CATALOG_DEFINITION.search('salmon', { limit: 1 })[0],
].filter((record): record is CatalogRecord => Boolean(record)).map((record) => [record.sourceId, record])).values()];
const COMPACT_DMC_DEFINITION: CatalogDefinition = {
  ...DEFAULT_CATALOG_DEFINITION,
  records: compactDmcRecords,
  snapshot: { ...DEFAULT_CATALOG_DEFINITION.snapshot, records: compactDmcRecords },
  search: (query, options = {}) => compactDmcRecords.filter((record) => !query || `${record.name} ${record.code}`.toLowerCase().includes(query.toLowerCase())).slice(0, options.limit),
  getByHex: (hex) => compactDmcRecords.find((record) => record.hex.toUpperCase() === hex.toUpperCase()),
};

const f = vi.hoisted(() => ({
  c: { start: vi.fn(), setMetrics: vi.fn(), setDocument: vi.fn(), dispose: vi.fn(), setBrush: vi.fn(), setTool: vi.fn(), setEraserMode: vi.fn(), selectPalette: vi.fn(), selectCreatedPalette: vi.fn(), setChartMode: vi.fn(), setGridVisible: vi.fn(), setBrushSize: vi.fn(), setToolBrushSize: vi.fn(), setTouchMovementOnly: vi.fn(), copySelection: vi.fn(), pasteSelection: vi.fn(), moveSelection: vi.fn(), dismissTouchCopyRequest: vi.fn(), deleteSelection: vi.fn(), handleKeyDown: vi.fn(() => false), getTraceImage: vi.fn(() => undefined), setTraceImage: vi.fn(), setTraceImageSettings: vi.fn(), clearTraceImage: vi.fn() },
  adapter: vi.fn(() => ({ dispose: vi.fn() })),
  r: { dispose: vi.fn() }, resize: undefined as (() => void) | undefined,
  uiState: { mode: 'color', gridVisible: true, overlay: {}, tool: { tool: 'paint' }, paletteId: 1, canPaste: false, toolBrushSizes: { full: 1, half: 1, 'three-quarter': 1, eraser: 1 } }, createdUiState: null as unknown,
  uiListener: null as ((state: unknown) => void) | null,
  capturedCallback: null as ((bounds: { x: number; y: number; width: number; height: number }) => void) | null
}));
vi.mock('../../rendering/context', () => ({ createCanvasTarget: vi.fn(() => ({ context: {} })) }));
vi.mock('../../rendering/renderer', () => ({ createCanvasRenderer: vi.fn(() => f.r) }));
vi.mock('../../rendering/trace', async () => {
  const actual = await vi.importActual<typeof import('../../rendering/trace')>('../../rendering/trace');
  return { ...actual, decodeTraceImage: vi.fn(async () => ({ source: {}, bitmap: {}, width: 2, height: 2, dispose: vi.fn() })) };
});
vi.mock('../../editor/coordinates', () => ({ getCanvasMetrics: vi.fn(() => ({ cssWidth: 640, cssHeight: 480, pixelWidth: 640, pixelHeight: 480, backingWidth: 640, backingHeight: 480, requestedDpr: 1, dpr: 1, maxDpr: 2, maxBackingPixels: 1e6 })), modelToScreen: vi.fn((point: { x: number; y: number }) => point) }));
vi.mock('../../editor', () => ({ ChartPresentationMode: { Color: 'color', Symbol: 'symbol', Grayscale: 'grayscale', Combined: 'combined' }, createUiStore: vi.fn((initial: unknown) => { f.createdUiState = initial; return { getState: () => f.uiState, subscribe: vi.fn((listener: unknown) => { f.uiListener = listener as (state: unknown) => void; return () => undefined; }) }; }), createWorkspaceEditorGateway: vi.fn(() => ({ dispose: vi.fn() })), createPointerEventsAdapter: f.adapter, createEditorSurfaceController: vi.fn((options: unknown) => { f.capturedCallback = (options as { onTraceBoundsChange?: (b: { x: number; y: number; width: number; height: number }) => void }).onTraceBoundsChange ?? null; return f.c as never; }) }));
const ws = { metadata: { title: 'Sampler', notes: '', aidaCount: 14 }, updateActiveMetadata: vi.fn(), updateActiveAidaCount: vi.fn(), execute: vi.fn(), getStateSnapshot: vi.fn(), catalogFor: vi.fn(() => COMPACT_DMC_DEFINITION), availableCatalogs: vi.fn(() => [COMPACT_DMC_DEFINITION]), catalogById: vi.fn((id: string) => id === COMPACT_DMC_DEFINITION.association.catalogId ? COMPACT_DMC_DEFINITION : undefined), setSourceImage: vi.fn(() => Promise.resolve()), applyTraceImageChange: vi.fn(() => Promise.resolve()), getAsset: vi.fn(), sourceImage: undefined as ({ chartBounds: { x: number; y: number; width: number; height: number } } | undefined) } as never;
const executeMock = () => (ws as { execute: ReturnType<typeof vi.fn> }).execute;
const doc = { width: 16, height: 16, colors: new Uint16Array(1024), palette: [{ id: 1, name: 'Ruby', color: '#b44', active: true, catalog: { code: '321', name: 'Ruby', hex: '#b44', rgb: [0, 0, 0], catalogId: 'dmc-compatible-screen-approximation', sourceId: 'x' } }], backstitches: { ids: new Uint32Array() } } as never;
const two = { width: 16, height: 16, colors: new Uint16Array(1024), palette: [{ id: 1, name: 'Ruby', color: '#b44', active: true, catalog: { code: '321' } }, { id: 2, name: 'Sky', color: '#48c', active: true }], backstitches: { ids: new Uint32Array() } } as never;
const paletteDetailsDoc = { width: 16, height: 16, colors: new Uint16Array(1024), palette: [{ id: 1, name: 'Ruby', color: '#b44', active: true, symbol: '✦', catalog: { code: '321', name: 'Ruby', hex: '#b44', rgb: [0, 0, 0], catalogId: 'dmc-compatible-screen-approximation', sourceId: 'x' } }], backstitches: { ids: new Uint32Array() } } as never;
const customColorDocument = (palette: unknown[]) => ({ width: 16, height: 16, colors: new Uint16Array(1024), palette, backstitches: { ids: new Uint32Array() } }) as never;
const makeCatalog = (catalogId: string, brandLabel: string, records: CatalogRecord[]): CatalogDefinition => {
  const byHex = new Map(records.map((record) => [record.hex.toUpperCase(), record]));
  return { association: { catalogId, brandLabel, colorCount: records.length }, records, compatibilityLabel: `${brandLabel}-compatible`, snapshot: { association: { catalogId, brandLabel, colorCount: records.length }, records }, search: (query, options = {}) => records.filter((record) => !query || `${record.name} ${record.code}`.toLowerCase().includes(query.toLowerCase())).slice(0, options.limit), getByHex: (hex) => byHex.get(hex.toUpperCase()), nearest: () => records[0] };
};
const catalogBRecord = { sourceId: 'b-source-1', code: '321', name: 'B Ruby', hex: '#BB0000', rgb: [187, 0, 0] as const } as CatalogRecord;
const catalogB = makeCatalog('catalog-b', 'Brand B', [catalogBRecord]);
const multiCatalogWorkspace = () => {
  const workspace = ws as { catalogFor: ReturnType<typeof vi.fn>; availableCatalogs: ReturnType<typeof vi.fn>; catalogById: ReturnType<typeof vi.fn>; getStateSnapshot: ReturnType<typeof vi.fn> };
  workspace.catalogFor.mockReturnValue(COMPACT_DMC_DEFINITION);
  workspace.availableCatalogs.mockReturnValue([COMPACT_DMC_DEFINITION, catalogB]);
  workspace.catalogById.mockImplementation((id: string) => [COMPACT_DMC_DEFINITION, catalogB].find((item) => item.association.catalogId === id));
  return workspace;
};
const openCustomColorDialog = () => {
  fireEvent.click(screen.getByRole('button', { name: /Add new color/ }));
  return screen.getByRole('dialog', { name: 'Add a thread color' });
};
const customColorAction = (dialog: HTMLElement) => dialog.querySelector('.custom-color-action') as HTMLButtonElement;
// Mirrors the picker's render predicate: every pool symbol except those held by
// another palette entry (the open entry's own symbol is always kept). Computed by
// value so pool reordering or enrichment never hardcodes glyphs or indices.
const expectedTiles = (palette: { id: number; symbol: string }[], openId: number) => {
  const open = palette.find((e) => e.id === openId);
  if (!open) return 0;
  const held = new Set(palette.filter((e) => e.id !== openId).map((e) => e.symbol));
  return PALETTE_SYMBOLS.filter((s) => s === open.symbol || !held.has(s)).length;
};
const dispatchPointerClick = (target: Element, pointerId: number) => {
  const click = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
  Object.defineProperty(click, 'pointerId', { value: pointerId });
  target.dispatchEvent(click);
};
const dispatchContextMenu = (target: Element, pointerType: 'mouse' | 'touch', button: number) => {
  const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button });
  Object.defineProperty(contextMenu, 'pointerType', { value: pointerType });
  act(() => target.dispatchEvent(contextMenu));
};
beforeEach(() => { vi.clearAllMocks(); (ws as { execute: ReturnType<typeof vi.fn> }).execute.mockReset(); (ws as { getStateSnapshot: ReturnType<typeof vi.fn> }).getStateSnapshot.mockReset(); (ws as { catalogFor: ReturnType<typeof vi.fn> }).catalogFor.mockReturnValue(COMPACT_DMC_DEFINITION); (ws as { availableCatalogs: ReturnType<typeof vi.fn> }).availableCatalogs.mockReturnValue([COMPACT_DMC_DEFINITION]); (ws as { catalogById: ReturnType<typeof vi.fn> }).catalogById.mockImplementation((id: string) => id === COMPACT_DMC_DEFINITION.association.catalogId ? COMPACT_DMC_DEFINITION : undefined); localStorage.clear(); f.createdUiState = null; f.uiListener = null; f.uiState.canPaste = false; f.uiState.overlay = {}; f.uiState.tool = { tool: 'paint' }; f.uiState.gridVisible = true; (ws as { sourceImage: unknown }).sourceImage = undefined; vi.stubGlobal('ResizeObserver', vi.fn(function (cb: () => void) { f.resize = cb; return { observe: vi.fn(), disconnect: vi.fn() }; })); });
afterEach(() => { vi.useRealTimers(); localStorage.clear(); });

describe('EditorSurface', () => {
  it('portals palette details outside the workspace and offers separate swap and delete actions', () => {
    render(<EditorSurface workspace={ws} document={paletteDetailsDoc} />);
    const swatch = document.querySelector<HTMLButtonElement>('.palette-button')!;
    fireEvent.contextMenu(swatch);
    const menu = screen.getByRole('menu', { name: 'Details for Ruby' });
    expect(menu.parentElement).toBe(document.body);
    expect(menu.closest('.editor-workspace')).toBeNull();
    expect(within(menu).getByRole('menuitem', { name: 'Change symbol' })).toBeInTheDocument();
    fireEvent.pointerDown(within(menu).getByRole('menuitem', { name: 'Swap color' }));
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Swap color' }));
    const dialog = screen.getByRole('dialog', { name: 'Swap Ruby for a thread color' });
    expect(within(dialog).getByText(/stitches and backstitches using Ruby will be changed/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Swap Bright Red' })).toBeInTheDocument();
    expect(within(dialog).getByRole('tablist', { name: 'Thread catalogs' })).toBeInTheDocument();
  });
  it('returns focus to the swatch that opened the swap picker', async () => {
    render(<EditorSurface workspace={ws} document={paletteDetailsDoc} />);
    const swatch = document.querySelector<HTMLButtonElement>('.palette-button')!;
    fireEvent.contextMenu(swatch);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Swap color' }));
    const dialog = screen.getByRole('dialog', { name: 'Swap Ruby for a thread color' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close catalog dialog' }));
    await waitFor(() => expect(document.activeElement).toBe(swatch));
  });
  it('cancels palette deletion without changing the document', () => {
    render(<EditorSurface workspace={ws} document={paletteDetailsDoc} />);
    fireEvent.keyDown(document.querySelector('.palette-button')!, { key: 'ContextMenu' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete color' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete Ruby?' });
    expect(within(dialog).getByText(/every stitch.*including backstitches/i)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(executeMock()).not.toHaveBeenCalled();
  });
  it('confirms palette deletion with the target id and returns focus to its swatch', async () => {
    render(<EditorSurface workspace={ws} document={paletteDetailsDoc} />);
    const swatch = document.querySelector<HTMLButtonElement>('.palette-button')!;
    fireEvent.contextMenu(swatch);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete color' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete Ruby?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete color' }));
    expect(executeMock()).toHaveBeenCalledWith({ type: 'palette-delete', id: 1 });
    expect(f.c.selectPalette).toHaveBeenCalledWith(null);
    await waitFor(() => expect(document.activeElement).toBe(swatch));
  });
  it('traps Tab navigation inside the palette-delete confirmation dialog', () => {
    render(<EditorSurface workspace={ws} document={paletteDetailsDoc} />);
    fireEvent.contextMenu(document.querySelector('.palette-button')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete color' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete Ruby?' });
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    const confirm = within(dialog).getByRole('button', { name: 'Delete color' });
    confirm.focus();
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(confirm).toHaveFocus();
  });
  it('switches catalog and creates the selected catalog record by catalog identity', async () => {
    const workspace = multiCatalogWorkspace();
    render(<EditorSurface workspace={ws} document={doc} />);
    fireEvent.click(screen.getByRole('button', { name: /Add new color/ }));
    const dialog = screen.getByRole('dialog', { name: 'Add a thread color' });
    expect(within(dialog).getByRole('tab', { name: 'DMC' })).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Search DMC catalog'));
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Brand B' }));
    expect(within(dialog).getByLabelText('Search Brand B catalog')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Search Brand B catalog'), { target: { value: '321' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'B Ruby, color 321' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add B Ruby' }));
    expect(workspace.availableCatalogs).toHaveBeenCalled();
    expect(executeMock()).toHaveBeenCalledWith(expect.objectContaining({ type: 'palette-create', catalog: createCatalogReference(catalogB, catalogBRecord) }));
  });
  it('keeps the selected swatch above accessible catalog tabs and exposes only the active catalog search', () => {
    multiCatalogWorkspace();
    render(<EditorSurface workspace={ws} document={doc} />);
    const dialog = openCustomColorDialog();
    const selection = within(dialog).getByLabelText('Selected thread color');
    const tabs = within(dialog).getByRole('tablist', { name: 'Thread catalogs' });
    expect(selection.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const dmcTab = within(tabs).getByRole('tab', { name: 'DMC' });
    const brandBTab = within(tabs).getByRole('tab', { name: 'Brand B' });
    expect(dmcTab).toHaveAttribute('aria-selected', 'true');
    expect(document.getElementById(dmcTab.getAttribute('aria-controls')!)).toBe(within(dialog).getByRole('tabpanel'));
    expect(document.getElementById(brandBTab.getAttribute('aria-controls')!)).toBe(within(dialog).getByRole('tabpanel'));
    expect(within(dialog).getByRole('tabpanel')).toContainElement(within(dialog).getByLabelText('Search DMC catalog'));
    fireEvent.click(brandBTab);
    expect(brandBTab).toHaveAttribute('aria-selected', 'true');
    expect(dmcTab).toHaveAttribute('aria-selected', 'false');
    expect(document.getElementById(dmcTab.getAttribute('aria-controls')!)).toBe(within(dialog).getByRole('tabpanel'));
    expect(document.getElementById(brandBTab.getAttribute('aria-controls')!)).toBe(within(dialog).getByRole('tabpanel'));
    expect(within(dialog).getByRole('tabpanel')).toHaveAttribute('aria-labelledby', brandBTab.id);
    expect(within(dialog).getByRole('tabpanel')).toContainElement(within(dialog).getByLabelText('Search Brand B catalog'));
    expect(within(dialog).queryByLabelText('Search DMC catalog')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('tabpanel')).toContainElement(within(dialog).getByRole('list', { name: 'Available thread colors' }));
  });
  it('shows a named tab even when only one catalog is installed', () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    fireEvent.click(screen.getByRole('button', { name: /Add new color/ }));
    expect(screen.getByRole('tablist', { name: 'Thread catalogs' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'DMC' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('combobox', { name: 'Catalog' })).not.toBeInTheDocument();
  });
  it('renders every record when an installed catalog tab has an empty search', () => {
    const records = Array.from({ length: 13 }, (_, index) => ({
      sourceId: `full-catalog-${index}`,
      code: String(500 + index),
      name: `Full Catalog ${index}`,
      hex: `#${index.toString(16).padStart(6, '0')}`,
      rgb: [index, index, index] as const,
    } as CatalogRecord));
    const fullCatalog = {
      ...makeCatalog('full-catalog', 'Full Catalog', records),
      search: (query: string, options: { limit?: number } = {}) => records.filter((record) => !query || `${record.name} ${record.code}`.toLowerCase().includes(query.toLowerCase())).slice(0, options.limit),
    };
    const workspace = multiCatalogWorkspace();
    workspace.availableCatalogs.mockReturnValue([COMPACT_DMC_DEFINITION, fullCatalog]);
    render(<EditorSurface workspace={ws} document={doc} />);
    const dialog = openCustomColorDialog();
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Full Catalog' }));
    expect(within(dialog).getByLabelText('Search Full Catalog catalog')).toHaveValue('');
    const grid = within(dialog).getByRole('list', { name: 'Available thread colors' });
    expect(within(grid).getAllByRole('listitem')).toHaveLength(13);
    expect(within(grid).getAllByRole('button')).toHaveLength(13);
  });
  it('supports arrow-key navigation between catalog tabs', async () => {
    multiCatalogWorkspace();
    render(<EditorSurface workspace={ws} document={doc} />);
    const dialog = openCustomColorDialog();
    const dmcTab = within(dialog).getByRole('tab', { name: 'DMC' });
    dmcTab.focus();
    fireEvent.keyDown(dmcTab, { key: 'ArrowRight' });
    const brandBTab = within(dialog).getByRole('tab', { name: 'Brand B' });
    await waitFor(() => expect(document.activeElement).toBe(brandBTab));
    expect(brandBTab).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(brandBTab, { key: 'ArrowLeft' });
    await waitFor(() => expect(document.activeElement).toBe(dmcTab));
    expect(dmcTab).toHaveAttribute('aria-selected', 'true');
  });
  it('prevents default for every handled tab key at selection boundaries and with one tab', () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    const dialog = openCustomColorDialog();
    const tabButton = within(dialog).getByRole('tab', { name: 'DMC' });
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      tabButton.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
  });
  it('keeps custom HEX creation while removing numeric RGB controls', async () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    const dialog = openCustomColorDialog();
    expect(within(dialog).queryByLabelText('Red')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Green')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Blue')).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Hex color'), { target: { value: '#12ab34' } });
    expect(customColorAction(dialog)).toHaveAccessibleName('Add #12AB34');
    fireEvent.click(customColorAction(dialog));
    await waitFor(() => expect(executeMock()).toHaveBeenCalledWith({ type: 'palette-create', name: '#12AB34', color: '#12AB34' }));
  });
  it('shows the default custom hex value and keeps it synchronized with the picker', () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    const dialog = openCustomColorDialog();
    expect(within(dialog).getByLabelText('Hex color')).toHaveValue('#000000');
    fireEvent.change(within(dialog).getByLabelText('Choose custom color'), { target: { value: '#123456' } });
    expect(within(dialog).getByLabelText('Hex color')).toHaveValue('#123456');
  });
  it('keeps the chosen catalog and query when the open picker receives a document update', () => {
    multiCatalogWorkspace();
    const view = render(<EditorSurface workspace={ws} document={doc} />);
    fireEvent.click(screen.getByRole('button', { name: /Add new color/ }));
    const dialog = screen.getByRole('dialog', { name: 'Add a thread color' });
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Brand B' }));
    fireEvent.change(within(dialog).getByLabelText('Search Brand B catalog'), { target: { value: '321' } });
    const updatedDocument = { ...(doc as object), palette: [...(doc as { palette: unknown[] }).palette] } as never;
    view.rerender(<EditorSurface workspace={ws} document={updatedDocument} />);
    expect(within(dialog).getByRole('tab', { name: 'Brand B' })).toHaveAttribute('aria-selected', 'true');
    expect(within(dialog).getByLabelText('Search Brand B catalog')).toHaveValue('321');
    expect(within(dialog).getByRole('button', { name: 'B Ruby, color 321' })).toBeInTheDocument();
  });
  it('keeps the one-catalog picker free of a catalog selector', () => {
    const workspace = multiCatalogWorkspace();
    workspace.availableCatalogs?.mockReturnValue([COMPACT_DMC_DEFINITION]);
    render(<EditorSurface workspace={ws} document={doc} />);
    fireEvent.click(screen.getByRole('button', { name: /Add new color/ }));
    expect(screen.queryByRole('combobox', { name: 'Catalog' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Search DMC catalog')).toBeInTheDocument();
  });
  it('uses an installed catalog even when the document primary is unavailable', () => {
    const workspace = multiCatalogWorkspace();
    workspace.catalogFor.mockReturnValue(undefined);
    const unknownPrimary = { ...(doc as object), catalog: { catalogId: 'missing', brandLabel: 'Missing', colorCount: 1 } } as never;
    render(<EditorSurface workspace={ws} document={unknownPrimary} />);
    fireEvent.click(screen.getByRole('button', { name: /Add new color/ }));
    expect(screen.getByLabelText('Search DMC catalog')).toBeEnabled();
    expect(screen.getByRole('tab', { name: 'DMC' })).toHaveAttribute('aria-selected', 'true');
  });
  it('passes the workspace primary catalog definition to the controller', () => {
    const primary = makeCatalog('primary-test-catalog', 'Primary Brand', [catalogBRecord]);
    (ws as { catalogFor: ReturnType<typeof vi.fn> }).catalogFor.mockReturnValue(primary);
    render(<EditorSurface workspace={ws} document={doc} />);
    expect(vi.mocked(createEditorSurfaceController)).toHaveBeenCalledWith(expect.objectContaining({ catalogDefinition: primary }));
  });
  it('selects a replacement from the explicitly selected catalog', () => {
    const workspace = multiCatalogWorkspace();
    workspace.getStateSnapshot.mockReturnValue({ document: doc });
    render(<EditorSurface workspace={ws} document={doc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ruby' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove Ruby' });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Catalog' }), { target: { value: 'catalog-b' } });
    fireEvent.change(within(dialog).getByLabelText('Search Brand B catalog for a replacement'), { target: { value: '321' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace with B Ruby from Brand B' }));
    expect(executeMock()).toHaveBeenCalledWith(expect.objectContaining({ type: 'palette-merge', createTo: expect.objectContaining({ catalog: createCatalogReference(catalogB, catalogBRecord) }) }));
  });
  it('renders same-code replacement results as distinct catalog records', () => {
    const records = [
      { ...catalogBRecord, sourceId: 'replacement-a', name: 'Ruby A' },
      { ...catalogBRecord, sourceId: 'replacement-b', name: 'Ruby B' },
    ];
    const duplicateCodeCatalog = makeCatalog('catalog-b', 'Brand B', records);
    const workspace = multiCatalogWorkspace();
    workspace.catalogFor.mockReturnValue(DEFAULT_CATALOG_DEFINITION);
    workspace.availableCatalogs.mockReturnValue([DEFAULT_CATALOG_DEFINITION, duplicateCodeCatalog]);
    workspace.catalogById.mockImplementation((id: string) => id === 'catalog-b' ? duplicateCodeCatalog : DEFAULT_CATALOG_DEFINITION);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<EditorSurface workspace={ws} document={doc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ruby' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove Ruby' });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Catalog' }), { target: { value: 'catalog-b' } });
    fireEvent.change(within(dialog).getByLabelText('Search Brand B catalog for a replacement'), { target: { value: '321' } });
    expect(within(dialog).getByRole('button', { name: 'Replace with Ruby A from Brand B' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Replace with Ruby B from Brand B' })).toBeInTheDocument();
    expect(error.mock.calls.map(([message]) => String(message))).not.toEqual(expect.arrayContaining([expect.stringMatching(/same key|duplicate key/i)]));
    error.mockRestore();
  });
  it('shows cross-brand palette chips as compact, separate brand and code lines', () => {
    multiCatalogWorkspace();
    const collision = { width: 16, height: 16, colors: new Uint16Array(1024), palette: [
      { id: 1, name: 'Ruby A', color: '#AA0000', active: true, catalog: { catalogId: DEFAULT_CATALOG_DEFINITION.association.catalogId, sourceId: 'a', code: '321' } },
      { id: 2, name: 'Ruby B', color: '#BB0000', active: true, catalog: { catalogId: 'catalog-b', sourceId: 'b', code: '321' } },
    ], backstitches: { ids: new Uint32Array() } } as never;
    render(<EditorSurface workspace={ws} document={collision} />);
    const chip = screen.getByRole('button', { name: /Brand B 321Ruby B/ });
    expect(within(chip).getByText('Brand B')).toHaveClass('palette-brand-label');
    expect(within(chip).getByText('321')).toHaveClass('palette-code-label');
    expect(stylesText).toContain('.palette-rail .palette-number');
    expect(stylesText).toContain('width:2.75rem');
    const brandRule = stylesText.match(/\.palette-rail \.palette-brand-label\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(brandRule).toContain('white-space:nowrap');
    expect(brandRule).toContain('overflow:hidden');
    expect(brandRule).toContain('text-overflow:ellipsis');
    expect(brandRule).toContain('max-height:.52rem');
    expect(chip).toHaveAccessibleName('Brand B 321Ruby B');
  });
  it('initializes the UI store with Pan while retaining the active palette', () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    expect(f.createdUiState).toEqual({ paletteId: 1, tool: { tool: 'pan' } });
  });
  it('defaults Shape to Triangle and marks Shape as configurable', () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    const shape = screen.getByRole('button', { name: 'Shape' });
    expect(shape.querySelector('[data-shape-icon="triangle"]')).toBeInTheDocument();
    expect(shape.querySelector('.brush-size-corner')).toHaveAttribute('aria-hidden', 'true');
  });
  it('keeps Completion a normal one-cell tool without hold settings', () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    const completion = screen.getByRole('button', { name: 'Completion' });
    expect(completion).not.toHaveAttribute('aria-haspopup');
    expect(completion).not.toHaveAttribute('aria-controls');
    expect(completion).not.toHaveAttribute('title', expect.stringContaining('hold'));
    expect(completion.querySelector('.brush-size-corner')).toBeNull();
    vi.useFakeTimers();
    fireEvent.pointerDown(completion, { pointerId: 88, pointerType: 'touch', isPrimary: true });
    act(() => vi.advanceTimersByTime(600));
    expect(screen.queryByRole('dialog', { name: /Completion brush size/i })).not.toBeInTheDocument();
  });
  it('draws the settings marker as a bottom-right right-angle triangle', () => {
    const markerRule = stylesText.match(/\.brush-size-corner\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(markerRule).toContain('clip-path:polygon(0 100%,100% 0,100% 100%)');
    expect(markerRule).toContain('right:0');
    expect(markerRule).toContain('bottom:0');
    expect(markerRule).not.toContain('border-radius:50%');
  });
  it('preserves UI state when the document changes', () => {
    const view = render(<EditorSurface workspace={ws} document={doc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Full stitch' }));
    const next = { width: 20, height: 16, colors: new Uint16Array(1024), palette: [{ id: 1, name: 'Ruby', color: '#b44', active: true }], backstitches: { ids: new Uint32Array() } } as never;
    view.rerender(<EditorSurface workspace={ws} document={next} />);
    expect(f.c.start).toHaveBeenCalledOnce(); expect(f.c.dispose).not.toHaveBeenCalled(); expect(f.c.setDocument).toHaveBeenCalledWith(next, expect.objectContaining({ reason: 'external-document' }));
    expect(screen.getByText(/20 × 16 stitches/)).toBeInTheDocument();
  });
  it('reuses palette activity when completion changes only the completion plane', () => {
    let colorReads = 0;
    const colors = new Proxy(new Uint16Array(1024), {
      get(target, property) {
        if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property)) colorReads += 1;
        return Reflect.get(target, property);
      }
    });
    type TestDocument = {
      width: number;
      height: number;
      colors: Uint16Array;
      completed: Uint8Array;
      backstitches: { ids: Uint32Array; colors: Uint16Array };
      palette: unknown[];
    };
    const baseDocument = Object.assign({}, doc as object, {
      colors,
      completed: new Uint8Array(256),
      backstitches: { ids: new Uint32Array(), colors: new Uint16Array() }
    }) as TestDocument;
    const view = render(<EditorSurface workspace={ws} document={baseDocument as never} />);
    const readsAfterInitialRender = colorReads;
    const completionDocument = Object.assign({}, baseDocument, {
      completed: Uint8Array.from((baseDocument as { completed: Uint8Array }).completed),
      revision: 1
    }) as TestDocument;
    (completionDocument as { completed: Uint8Array }).completed[0] = 1;

    view.rerender(<EditorSurface workspace={ws} document={completionDocument as never} />);

    expect(colorReads).toBe(readsAfterInitialRender);
  });
  it('opens the Tools and Colors popovers with expanded state and restores focus on Escape', async () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    const tools = screen.getByRole('button', { name: 'Tools', hidden: true });
    const colors = screen.getByRole('button', { name: /^Colors:/, hidden: true });

    expect(tools).toHaveAttribute('aria-expanded', 'false');
    expect(colors).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(tools);
    expect(screen.getByRole('dialog', { name: 'Tools' })).toBeInTheDocument();
    expect(tools).toHaveAttribute('aria-expanded', 'true');
    expect(colors).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Tools' })).not.toBeInTheDocument();
      expect(document.activeElement).toBe(tools);
    });

    fireEvent.click(tools);
    expect(screen.getByRole('dialog', { name: 'Tools' })).toBeInTheDocument();
    fireEvent.click(tools);
    expect(screen.queryByRole('dialog', { name: 'Tools' })).not.toBeInTheDocument();
    expect(tools).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(colors);
    expect(screen.getByRole('dialog', { name: 'Colors' })).toBeInTheDocument();
    expect(colors).toHaveAttribute('aria-expanded', 'true');
    expect(tools).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Colors' })).not.toBeInTheDocument();
      expect(document.activeElement).toBe(colors);
    });
  });
  it('dismisses each mobile popover from an outside pointer', () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    const tools = screen.getByRole('button', { name: 'Tools', hidden: true });
    const colors = screen.getByRole('button', { name: /^Colors:/, hidden: true });

    fireEvent.click(tools);
    expect(screen.getByRole('dialog', { name: 'Tools' })).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog', { name: 'Tools' })).not.toBeInTheDocument();
    expect(tools).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(colors);
    expect(screen.getByRole('dialog', { name: 'Colors' })).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog', { name: 'Colors' })).not.toBeInTheDocument();
    expect(colors).toHaveAttribute('aria-expanded', 'false');
  });
  it('closes Colors after selecting an existing color but stays open for Add new color', () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    const colors = screen.getByRole('button', { name: /^Colors:/, hidden: true });

    fireEvent.click(colors);
    const colorsDialog = screen.getByRole('dialog', { name: 'Colors' });
    fireEvent.click(within(colorsDialog).getByRole('button', { name: '321Ruby' }));
    expect(f.c.selectPalette).toHaveBeenCalledWith(1);
    expect(screen.queryByRole('dialog', { name: 'Colors' })).not.toBeInTheDocument();

    fireEvent.click(colors);
    expect(screen.getByRole('dialog', { name: 'Colors' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add new color' }));
    expect(screen.getByRole('dialog', { name: 'Colors' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Add a thread color' })).toBeInTheDocument();
  });
  it('keeps Colors open through the portalled add-color flow until an outside pointer dismisses it', async () => {
    const red = DEFAULT_CATALOG_DEFINITION.search('321')[0];
    const createdDocument = {
      width: 16,
      height: 16,
      colors: new Uint16Array(1024),
      palette: [
        { id: 1, name: 'Ruby', color: '#b44', active: true, catalog: { code: '321' } },
        { id: 2, name: red.name, color: red.hex, active: true, catalog: createCatalogReference(DEFAULT_CATALOG_DEFINITION, red) }
      ],
      backstitches: { ids: new Uint32Array() }
    } as never;
    (ws as { execute: ReturnType<typeof vi.fn> }).execute.mockResolvedValueOnce({ document: createdDocument });
    render(<EditorSurface workspace={ws} document={doc} />);
    const colors = screen.getByRole('button', { name: /^Colors:/, hidden: true });

    fireEvent.click(colors);
    const colorsDialog = screen.getByRole('dialog', { name: 'Colors' });
    fireEvent.click(within(colorsDialog).getByRole('button', { name: 'Add new color' }));
    const addDialog = screen.getByRole('dialog', { name: 'Add a thread color' });
    expect(screen.getByRole('dialog', { name: 'Colors' })).toBeInTheDocument();

    fireEvent.pointerDown(addDialog);
    expect(screen.getByRole('dialog', { name: 'Colors' })).toBeInTheDocument();

    fireEvent.change(within(addDialog).getByLabelText('Search DMC catalog'), { target: { value: '321' } });
    fireEvent.click(within(addDialog).getByRole('button', { name: /Red, color 321/ }));
    fireEvent.click(within(addDialog).getByRole('button', { name: 'Add Red' }));
    await waitFor(() => expect((ws as { execute: ReturnType<typeof vi.fn> }).execute).toHaveBeenCalled());
    await waitFor(() => expect(f.c.selectCreatedPalette).toHaveBeenCalledWith(2));
    expect(screen.queryByRole('dialog', { name: 'Add a thread color' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Colors' })).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog', { name: 'Colors' })).not.toBeInTheDocument();
  });
  it('binds keyboard delivery to the workspace while retaining canvas pointer delivery', () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    expect(f.adapter).toHaveBeenCalledOnce();
    const [pointerSurface, , options] = f.adapter.mock.calls[0] as unknown as [
      HTMLElement,
      unknown,
      { keyboardSurface: HTMLElement },
    ];
    expect(pointerSurface).toHaveClass('canvas-frame');
    expect(options.keyboardSurface).toHaveClass('editor-workspace');
    expect(options.keyboardSurface).toBe(document.querySelector('.editor-workspace'));
    expect(pointerSurface).not.toBe(options.keyboardSurface);
  });
  it('excludes Shape and brush controls and the brush dialog from native keyboard routing', () => {
    vi.useFakeTimers();
    render(<EditorSurface workspace={ws} document={doc} />);
    const adapterOptions = (f.adapter.mock.calls[0] as unknown as [unknown, unknown, {
      shouldExcludeTarget: (target: unknown, eventType: string) => boolean;
    }])[2];
    const shape = screen.getByRole('button', { name: 'Shape' });
    const path = shape.querySelector('path')!;
    const full = screen.getByRole('button', { name: 'Full stitch' });
    const brushDescendant = full.querySelector('.stitch-brush-icon-full')!;
    expect(adapterOptions.shouldExcludeTarget(shape, 'keydown')).toBe(true);
    expect(adapterOptions.shouldExcludeTarget(path, 'keydown')).toBe(true);
    expect(adapterOptions.shouldExcludeTarget(full, 'keydown')).toBe(true);
    expect(adapterOptions.shouldExcludeTarget(brushDescendant, 'keydown')).toBe(true);
    expect(adapterOptions.shouldExcludeTarget(document.querySelector('.canvas-frame'), 'keydown')).toBe(false);
    const touchCopyTarget = document.createElement('button');
    touchCopyTarget.className = 'touch-copy-menu';
    expect(adapterOptions.shouldExcludeTarget(touchCopyTarget, 'pointerdown')).toBe(true);
    fireEvent.pointerDown(full, { pointerId: 30, pointerType: 'mouse', isPrimary: true, button: 0 });
    act(() => vi.advanceTimersByTime(500));
    const brushDialog = screen.getByRole('dialog', { name: /Full stitch brush size/i });
    expect(adapterOptions.shouldExcludeTarget(brushDialog, 'keydown')).toBe(true);
    expect(adapterOptions.shouldExcludeTarget(brushDialog.querySelector('input')!, 'keydown')).toBe(true);
    vi.useRealTimers();
  });
  it('wires the top-level stitch tools and removes separate brush settings', () => { render(<EditorSurface workspace={ws} document={doc} />); f.resize?.(); expect(f.c.setMetrics).toHaveBeenCalled(); expect(screen.queryByRole('heading', { name: 'Brush settings' })).not.toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: 'Full stitch' })); expect(f.c.setBrush).toHaveBeenCalledWith({ kind: 'full', paletteId: 1 }); fireEvent.click(screen.getByRole('button', { name: 'Half stitch' })); expect(f.c.setBrush).toHaveBeenCalledWith({ kind: 'half', paletteId: 1 }); fireEvent.click(screen.getByRole('button', { name: '3/4 stitch' })); expect(f.c.setBrush).toHaveBeenCalledWith({ kind: 'three-quarter', paletteId: 1 }); expect(screen.queryByRole('button', { name: 'Stitch' })).not.toBeInTheDocument(); });
  it('opens an anchored brush-size dialog on hold without switching tools', () => {
    vi.useFakeTimers();
    render(<EditorSurface workspace={ws} document={doc} />);
    const full = screen.getByRole('button', { name: 'Full stitch' });
    fireEvent.pointerDown(full, { pointerId: 4, pointerType: 'mouse', isPrimary: true });
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole('dialog', { name: /Full stitch brush size/i })).toBeInTheDocument();
    const slider = screen.getByRole('slider', { name: /Full stitch brush size/i });
    fireEvent.change(slider, { target: { value: '7' } });
    expect(f.c.setToolBrushSize).toHaveBeenCalledWith('full', 7);
    expect(f.c.setBrush).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'Brush settings' })).not.toBeInTheDocument();
  });
  it.each([['Full stitch','full'],['Half stitch','half'],['3/4 stitch','three-quarter'],['Eraser','eraser']] as const)('supports the %s hold trigger and its affordances', (name, key) => {
    vi.useFakeTimers(); render(<EditorSurface workspace={ws} document={doc} />);
    const trigger = screen.getByRole('button', { name });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger.querySelector('.brush-size-corner')).toHaveClass('brush-size-corner');
    fireEvent.pointerDown(trigger, { pointerId: 31, isPrimary: true }); act(() => vi.advanceTimersByTime(499));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: new RegExp(name) })).toHaveFocus();
    fireEvent.change(within(screen.getByRole('dialog')).getByRole('slider'), { target: { value: '6' } });
    expect(f.c.setToolBrushSize).toHaveBeenCalledWith(key, 6);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(trigger).toHaveFocus();
  });
  it('keeps Backstitch outside brush-size hold and context-menu behavior', () => {
    vi.useFakeTimers(); render(<EditorSurface workspace={ws} document={doc} />);
    const backstitch = screen.getByRole('button', { name: 'Backstitch' });
    fireEvent.pointerDown(backstitch, { pointerId: 19, isPrimary: true }); act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.contextMenu(backstitch); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('opens brush size immediately for mouse and keyboard context-menu commands', () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    const full = screen.getByRole('button', { name: 'Full stitch' });

    dispatchContextMenu(full, 'mouse', 2);
    expect(screen.getByRole('dialog', { name: /Full stitch brush size/i })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(full, { key: 'ContextMenu' });
    expect(screen.getByRole('dialog', { name: /Full stitch brush size/i })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(full, { key: 'F10', shiftKey: true });
    expect(screen.getByRole('dialog', { name: /Full stitch brush size/i })).toBeInTheDocument();
  });
  it('defers a touch contextmenu during its primary press to the hold threshold', () => {
    vi.useFakeTimers();
    render(<EditorSurface workspace={ws} document={doc} />);
    const full = screen.getByRole('button', { name: 'Full stitch' });
    fireEvent.pointerDown(full, { pointerId: 108, pointerType: 'touch', isPrimary: true, button: 0 });
    fireEvent.contextMenu(full, { pointerType: 'touch' });
    expect(screen.queryByRole('dialog', { name: /Full stitch brush size/i })).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(499));
    expect(screen.queryByRole('dialog', { name: /Full stitch brush size/i })).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('dialog', { name: /Full stitch brush size/i })).toBeInTheDocument();
    fireEvent.pointerUp(full, { pointerId: 108, clientX: 0, clientY: 0 });
    fireEvent.click(full, { detail: 1, pointerId: 108, pointerType: 'touch' });
    expect(f.c.setBrush).not.toHaveBeenCalled();
  });
  it('keeps a touch contextmenu deferred after pointercancel through the guard window', () => {
    vi.useFakeTimers();
    render(<EditorSurface workspace={ws} document={doc} />);
    const full = screen.getByRole('button', { name: 'Full stitch' });
    fireEvent.pointerDown(full, { pointerId: 203, pointerType: 'touch', isPrimary: true, button: 0 });
    fireEvent.pointerCancel(document.body, { pointerId: 203, pointerType: 'touch' });
    fireEvent.contextMenu(full, { button: 0 });
    expect(screen.queryByRole('dialog', { name: /Full stitch brush size/i })).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(499));
    fireEvent.contextMenu(full, { button: 0 });
    expect(screen.queryByRole('dialog', { name: /Full stitch brush size/i })).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole('dialog', { name: /Full stitch brush size/i })).not.toBeInTheDocument();
  });
  it('defers an active touch contextmenu even if its button value is 2', () => {
    vi.useFakeTimers();
    render(<EditorSurface workspace={ws} document={doc} />);
    const full = screen.getByRole('button', { name: 'Full stitch' });
    fireEvent.pointerDown(full, { pointerId: 204, pointerType: 'touch', isPrimary: true, button: 0 });
    dispatchContextMenu(full, 'touch', 2);
    expect(screen.queryByRole('dialog', { name: /Full stitch brush size/i })).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole('dialog', { name: /Full stitch brush size/i })).toBeInTheDocument();
  });
  it('defers a post-cancel touch contextmenu with button 2 through the guard window', () => {
    vi.useFakeTimers();
    render(<EditorSurface workspace={ws} document={doc} />);
    const full = screen.getByRole('button', { name: 'Full stitch' });
    fireEvent.pointerDown(full, { pointerId: 205, pointerType: 'touch', isPrimary: true, button: 0 });
    fireEvent.pointerCancel(document.body, { pointerId: 205, pointerType: 'touch' });
    dispatchContextMenu(full, 'touch', 2);
    expect(screen.queryByRole('dialog', { name: /Full stitch brush size/i })).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole('dialog', { name: /Full stitch brush size/i })).not.toBeInTheDocument();
  });
  it('keeps the mobile Tools popover open when Escape dismisses the brush dialog', () => {
    vi.useFakeTimers();
    render(<EditorSurface workspace={ws} document={doc} />);
    const tools = screen.getByRole('button', { name: 'Tools', hidden: true });
    fireEvent.click(tools);
    const full = screen.getByRole('button', { name: 'Full stitch' });
    fireEvent.pointerDown(full, { pointerId: 109, pointerType: 'touch', isPrimary: true, button: 0 });
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole('dialog', { name: 'Tools' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /Full stitch brush size/i })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /Full stitch brush size/i })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Tools' })).toBeInTheDocument();
  });
  it('suppresses only the originating pointer click when dialog closes before release', () => {
    vi.useFakeTimers(); render(<EditorSurface workspace={ws} document={doc} />);
    const full = screen.getByRole('button', { name: 'Full stitch' });
    fireEvent.pointerDown(full, { pointerId: 41, isPrimary: true }); act(() => vi.advanceTimersByTime(500));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.pointerUp(full, { pointerId: 41 }); fireEvent.click(full, { detail: 1 });
    expect(f.c.setBrush).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Half stitch' }));
    expect(f.c.setBrush).toHaveBeenCalledWith({ kind: 'half', paletteId: 1 });
  });
  it('suppresses an originating touch click dispatched after a normal delay', () => {
    vi.useFakeTimers();
    render(<EditorSurface workspace={ws} document={doc} />);
    const full = screen.getByRole('button', { name: 'Full stitch' });
    fireEvent.pointerDown(full, { pointerId: 42, pointerType: 'touch', isPrimary: true, button: 0 });
    act(() => vi.advanceTimersByTime(500));
    fireEvent.pointerUp(full, { pointerId: 42, pointerType: 'touch' });
    act(() => vi.advanceTimersByTime(350));
    dispatchPointerClick(full, 42);
    expect(f.c.setBrush).not.toHaveBeenCalled();
  });
  it('uses anchor-only suppression for a delayed click with no pointer identity', () => {
    vi.useFakeTimers();
    render(<EditorSurface workspace={ws} document={doc} />);
    const full = screen.getByRole('button', { name: 'Full stitch' });
    fireEvent.pointerDown(full, { pointerId: 46, pointerType: 'touch', isPrimary: true, button: 0 });
    act(() => vi.advanceTimersByTime(500));
    fireEvent.pointerUp(full, { pointerId: 46, pointerType: 'touch' });
    act(() => vi.advanceTimersByTime(350));
    const anonymousClick = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
    expect('pointerId' in anonymousClick).toBe(false);
    full.dispatchEvent(anonymousClick);
    expect(f.c.setBrush).not.toHaveBeenCalled();
  });
  it('does not let an outside mouse release leave a token for a reused pointer id', () => {
    vi.useFakeTimers();
    render(<EditorSurface workspace={ws} document={doc} />);
    const full = screen.getByRole('button', { name: 'Full stitch' });
    vi.spyOn(full, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 40, bottom: 40, width: 40, height: 40, toJSON: () => ({}) });

    fireEvent.pointerDown(full, { pointerId: 202, pointerType: 'mouse', isPrimary: true, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(document.body, { pointerId: 202, pointerType: 'mouse', clientX: 80, clientY: 10 });
    fireEvent.pointerDown(full, { pointerId: 202, pointerType: 'mouse', isPrimary: true, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(full, { pointerId: 202, pointerType: 'mouse', clientX: 10, clientY: 10 });
    dispatchPointerClick(full, 202);

    expect(f.c.setBrush).toHaveBeenCalledTimes(1);
    expect(f.c.setBrush).toHaveBeenCalledWith({ kind: 'full', paletteId: 1 });
  });
  it('expires suppression when an opened press produces no click', () => {
    vi.useFakeTimers();
    render(<EditorSurface workspace={ws} document={doc} />);
    const full = screen.getByRole('button', { name: 'Full stitch' });
    fireEvent.pointerDown(full, { pointerId: 43, pointerType: 'touch', isPrimary: true, button: 0 });
    act(() => vi.advanceTimersByTime(500));
    fireEvent.pointerUp(full, { pointerId: 43, pointerType: 'touch' });
    act(() => vi.advanceTimersByTime(1001));

    dispatchPointerClick(full, 43);
    expect(f.c.setBrush).toHaveBeenCalledWith({ kind: 'full', paletteId: 1 });
  });
  it('does not let an intervening same-tool press consume an older click or lose its own activation', () => {
    vi.useFakeTimers();
    render(<EditorSurface workspace={ws} document={doc} />);
    const full = screen.getByRole('button', { name: 'Full stitch' });
    fireEvent.pointerDown(full, { pointerId: 44, pointerType: 'touch', isPrimary: true, button: 0 });
    act(() => vi.advanceTimersByTime(500));
    fireEvent.pointerUp(full, { pointerId: 44, pointerType: 'touch' });

    fireEvent.pointerDown(full, { pointerId: 45, pointerType: 'touch', isPrimary: true, button: 0 });
    fireEvent.click(full, { detail: 1 });
    fireEvent.pointerUp(full, { pointerId: 45, pointerType: 'touch' });
    fireEvent.click(full, { detail: 1 });
    expect(f.c.setBrush).toHaveBeenCalledTimes(1);
    expect(f.c.setBrush).toHaveBeenCalledWith({ kind: 'full', paletteId: 1 });
  });
  it('cancels a pending hold on pointer leave and ignores unrelated pointer releases', () => {
    vi.useFakeTimers(); render(<EditorSurface workspace={ws} document={doc} />);
    const full = screen.getByRole('button', { name: 'Full stitch' });
    fireEvent.pointerDown(full, { pointerId: 51, isPrimary: true }); fireEvent.pointerUp(full, { pointerId: 99 });
    fireEvent.pointerLeave(full, { pointerId: 51 }); act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('orders movement and selection tools first without reordering the remaining tools', () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    const rail = within(screen.getByRole('navigation', { name: 'Editor sections' }));
    expect(rail.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      'Pan', 'Select', 'Lasso select', 'Full stitch', 'Half stitch', '3/4 stitch',
      'Shape', 'Backstitch', 'Completion', 'Eraser', 'Fill', 'Eyedropper',
    ]);
  });
  it('offers a default Triangle shape tool and a long-press shape picker', () => {
    vi.useFakeTimers();
    render(<EditorSurface workspace={ws} document={doc} />);
    const shape = screen.getByRole('button', { name: 'Shape' });
    expect(shape.querySelector('[data-shape-icon="triangle"]')).toBeInTheDocument();
    expect(shape).toBeEnabled();
    fireEvent.pointerDown(shape, { pointerId: 1, pointerType: 'touch', isPrimary: true });
    act(() => vi.advanceTimersByTime(499));
    expect(screen.queryByRole('menu', { name: 'Choose shape' })).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    const menu = screen.getByRole('menu', { name: 'Choose shape' });
    expect(menu.parentElement).toBe(document.body);
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(7);
    expect(f.c.setTool).not.toHaveBeenCalled();
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Circle' }));
    expect(shape.querySelector('[data-shape-icon="circle"]')).toBeInTheDocument();
    expect(shape).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(shape, { detail: 1, pointerId: 21, pointerType: 'touch' });
    expect(f.c.setTool).toHaveBeenCalledWith({ tool: 'shape', shape: 'circle' });
    vi.useRealTimers();
  });
  it('presents seven icon-only choices including a distinct, accessible Oval in compact rows', () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    const shape = screen.getByRole('button', { name: 'Shape' });
    fireEvent.contextMenu(shape);
    const menu = screen.getByRole('menu', { name: 'Choose shape' });
    for (const [name, icon] of [['Line', 'line'], ['Rectangle', 'rectangle'], ['Square', 'square'], ['Circle', 'circle'], ['Triangle', 'triangle'], ['Right triangle', 'right-triangle'], ['Oval', 'oval']]) {
      const choice = within(menu).getByRole('menuitemradio', { name });
      expect(choice.querySelector(`[data-shape-icon="${icon}"]`)).toBeInTheDocument();
      expect(choice).toHaveAttribute('title', name);
      expect(choice.textContent?.trim()).toBe('');
    }
    expect(within(menu).queryByRole('menuitemcheckbox')).not.toBeInTheDocument();
    const rightTrianglePath = menu.querySelector('[data-shape-icon="right-triangle"] path')?.getAttribute('d');
    expect(rightTrianglePath).toBe('M5 5V19H19Z');
    expect(rightTrianglePath).not.toContain('M8 16');
    const ovalPath = menu.querySelector('[data-shape-icon="oval"] path')?.getAttribute('d');
    expect(ovalPath).toBe('M12 4a8 6 0 1 0 0 12 8 6 0 0 0 0-12');
    expect(stylesText).toMatch(/\.shape-picker-menu\s*\{[^}]*grid-template-columns:\s*repeat\(7,/s);
    expect(stylesText).toMatch(/@media\s*\(max-width:\s*520px\)[\s\S]*?\.shape-picker-menu\s*\{[^}]*grid-template-columns:\s*repeat\(4,/);
  });
  it('activates a chosen shape immediately when the current tool is not Shape', () => {
    f.uiState.tool = { tool: 'paint' } as never;
    render(<EditorSurface workspace={ws} document={doc} />);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Shape' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Oval' }));
    expect(f.c.setTool).toHaveBeenCalledWith({ tool: 'shape', shape: 'oval' });
    expect(screen.getByRole('button', { name: 'Shape' }).querySelector('[data-shape-icon="oval"]')).toBeInTheDocument();
  });
  it('opens shape menu from context-menu keys and restores focus when dismissed', async () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    const shape = screen.getByRole('button', { name: 'Shape' });
    fireEvent.keyDown(shape, { key: 'F10', shiftKey: true });
    expect(screen.getByRole('menu', { name: 'Choose shape' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(shape));
    fireEvent.contextMenu(shape);
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(document.activeElement).toBe(shape));
    fireEvent.click(shape);
    expect(f.c.setTool).toHaveBeenCalledWith({ tool: 'shape', shape: 'triangle' });
  });
  it('disables shape without an active thread', () => {
    const empty = { ...(doc as object), palette: [] } as never;
    render(<EditorSurface workspace={ws} document={empty} />);
    expect(screen.getByRole('button', { name: 'Shape' })).toBeDisabled();
  });
  it('updates the active shape tool when its selected shape changes', () => {
    f.uiState.tool = { tool: 'shape', shape: 'line' } as never;
    render(<EditorSurface workspace={ws} document={doc} />);
    const shape = screen.getByRole('button', { name: 'Shape' });
    fireEvent.contextMenu(shape);
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Circle' }));
    expect(f.c.setTool).toHaveBeenLastCalledWith({ tool: 'shape', shape: 'circle' });
  });
  it('supports menu keyboard navigation and keeps the mobile Tools popover open on Escape', () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    const tools = screen.getByRole('button', { name: 'Tools', hidden: true });
    fireEvent.click(tools);
    const shape = screen.getByRole('button', { name: 'Shape' });
    fireEvent.keyDown(shape, { key: 'ContextMenu' });
    const menu = screen.getByRole('menu', { name: 'Choose shape' });
    const triangle = within(menu).getByRole('menuitemradio', { name: 'Triangle' });
    expect(triangle).toHaveFocus();
    fireEvent.keyDown(triangle, { key: 'ArrowDown' });
    const rightTriangle = within(menu).getByRole('menuitemradio', { name: 'Right triangle' });
    expect(rightTriangle).toHaveFocus();
    fireEvent.keyDown(rightTriangle, { key: 'End' });
    expect(rightTriangle).toHaveFocus();
    fireEvent.keyDown(rightTriangle, { key: 'Home' });
    const line = within(menu).getByRole('menuitemradio', { name: 'Line' });
    expect(line).toHaveFocus();
    fireEvent.keyDown(line, { key: ' ' });
    expect(f.c.setTool).toHaveBeenCalledWith({ tool: 'shape', shape: 'line' });
    fireEvent.keyDown(line, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Choose shape' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Tools' })).toBeInTheDocument();
    expect(shape).toHaveFocus();
  });
  it('supports arrow-key navigation across all seven shape choices', () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Shape' }), { key: 'ContextMenu' });
    const menu = screen.getByRole('menu', { name: 'Choose shape' });
    const triangle = within(menu).getByRole('menuitemradio', { name: 'Triangle' });
    const lastChoice = within(menu).getByRole('menuitemradio', { name: 'Right triangle' });
    fireEvent.keyDown(triangle, { key: 'ArrowRight' });
    expect(within(menu).getByRole('menuitemradio', { name: 'Right triangle' })).toHaveFocus();
    fireEvent.keyDown(triangle, { key: 'End' });
    expect(lastChoice).toHaveFocus();
    fireEvent.keyDown(lastChoice, { key: 'ArrowRight' });
    expect(within(menu).getByRole('menuitemradio', { name: 'Line' })).toHaveFocus();
  });
  it('restores focus to the selected Oval when reopening the picker and continues keyboard navigation', () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    const trigger = screen.getByRole('button', { name: 'Shape' });
    fireEvent.keyDown(trigger, { key: 'ContextMenu' });
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Oval' }));

    fireEvent.keyDown(trigger, { key: 'ContextMenu' });
    const menu = screen.getByRole('menu', { name: 'Choose shape' });
    const oval = within(menu).getByRole('menuitemradio', { name: 'Oval' });
    expect(oval).toHaveFocus();
    fireEvent.keyDown(oval, { key: 'ArrowLeft' });
    expect(within(menu).getByRole('menuitemradio', { name: 'Circle' })).toHaveFocus();
  });
  it('activates Shape from a nested SVG target and remains activatable after outside release', () => {
    vi.useFakeTimers();
    render(<EditorSurface workspace={ws} document={doc} />);
    const shape = screen.getByRole('button', { name: 'Shape' });
    fireEvent.click(shape.querySelector('path')!);
    expect(f.c.setTool).toHaveBeenCalledWith({ tool: 'shape', shape: 'triangle' });
    f.c.setTool.mockClear();
    fireEvent.pointerDown(shape, { pointerId: 12, pointerType: 'touch', isPrimary: true });
    fireEvent.pointerUp(document.body, { pointerId: 12 });
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole('menu', { name: 'Choose shape' })).not.toBeInTheDocument();
    fireEvent.keyDown(shape, { key: 'Enter' });
    fireEvent.click(shape);
    expect(f.c.setTool).toHaveBeenCalledWith({ tool: 'shape', shape: 'triangle' });
    vi.useRealTimers();
  });
  it('does not let an outside release after opening the long-press menu suppress the next Shape activation', () => {
    vi.useFakeTimers();
    render(<EditorSurface workspace={ws} document={doc} />);
    const shape = screen.getByRole('button', { name: 'Shape' });
    fireEvent.pointerDown(shape, { pointerId: 19, pointerType: 'touch', isPrimary: true });
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole('menu', { name: 'Choose shape' })).toBeInTheDocument();
    fireEvent.pointerUp(document.body, { pointerId: 19 });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Choose shape' })).not.toBeInTheDocument();
    fireEvent.keyDown(shape, { key: 'Enter' });
    fireEvent.click(shape);
    expect(f.c.setTool).toHaveBeenCalledWith({ tool: 'shape', shape: 'triangle' });
    vi.useRealTimers();
  });
  it.each(['Full stitch','Half stitch','3/4 stitch','Eraser'] as const)('tracks %s movement at document capture and irrevocably cancels an out-and-back press', (name) => {
    vi.useFakeTimers(); render(<EditorSurface workspace={ws} document={doc} />);
    const trigger = screen.getByRole('button', { name });
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 40, bottom: 40, width: 40, height: 40, toJSON: () => ({}) });
    fireEvent.pointerDown(trigger, { pointerId: 71, pointerType: 'touch', button: 0, isPrimary: true, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(document, { pointerId: 71, clientX: 80, clientY: 10 });
    fireEvent.pointerMove(trigger, { pointerId: 71, clientX: 10, clientY: 10 });
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole('dialog', { name: new RegExp(name) })).not.toBeInTheDocument();
    fireEvent.pointerUp(document.body, { pointerId: 71 });
  });
  it('opens Shape only if captured-pointer coordinates remain inside its original geometry', () => {
    vi.useFakeTimers(); render(<EditorSurface workspace={ws} document={doc} />);
    const trigger = screen.getByRole('button', { name: 'Shape' });
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 40, bottom: 40, width: 40, height: 40, toJSON: () => ({}) });
    fireEvent.pointerDown(trigger, { pointerId: 72, pointerType: 'touch', button: 0, isPrimary: true, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(trigger, { pointerId: 72, clientX: 80, clientY: 10 });
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole('menu', { name: 'Choose shape' })).not.toBeInTheDocument();
    fireEvent.pointerUp(document.body, { pointerId: 72 });
  });
  it('does not let a captured out-and-back brush press activate on its trailing click', () => {
    vi.useFakeTimers(); render(<EditorSurface workspace={ws} document={doc} />);
    const trigger = screen.getByRole('button', { name: 'Full stitch' });
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 40, bottom: 40, width: 40, height: 40, toJSON: () => ({}) });
    fireEvent.pointerDown(trigger, { pointerId: 91, pointerType: 'touch', button: 0, isPrimary: true, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(trigger, { pointerId: 91, clientX: 80, clientY: 10 });
    fireEvent.pointerMove(trigger, { pointerId: 91, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(trigger, { pointerId: 91, clientX: 10, clientY: 10 });
    fireEvent.click(trigger, { detail: 1, pointerId: 91, pointerType: 'touch' });
    expect(f.c.setBrush).not.toHaveBeenCalled();
    fireEvent.pointerDown(trigger, { pointerId: 92, pointerType: 'touch', button: 0, isPrimary: true, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(trigger, { pointerId: 92, clientX: 10, clientY: 10 });
    fireEvent.click(trigger, { detail: 1, pointerId: 92, pointerType: 'touch' });
    expect(f.c.setBrush).toHaveBeenCalledWith({ kind: 'full', paletteId: 1 });
  });
  it('does not activate a short press released outside its trigger bounds', () => {
    vi.useFakeTimers();
    render(<EditorSurface workspace={ws} document={doc} />);
    const trigger = screen.getByRole('button', { name: 'Full stitch' });
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 40, bottom: 40, width: 40, height: 40, toJSON: () => ({}) });

    fireEvent.pointerDown(trigger, { pointerId: 94, pointerType: 'touch', button: 0, isPrimary: true, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(trigger, { pointerId: 94, clientX: 80, clientY: 10 });
    fireEvent.click(trigger, { detail: 1, pointerId: 94, pointerType: 'touch' });

    expect(f.c.setBrush).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
  it('rechecks current trigger geometry on a stationary hold timeout', () => {
    vi.useFakeTimers();
    render(<EditorSurface workspace={ws} document={doc} />);
    const trigger = screen.getByRole('button', { name: 'Full stitch' });
    let currentRect = { x: 0, y: 0, left: 0, top: 0, right: 40, bottom: 40, width: 40, height: 40, toJSON: () => ({}) };
    vi.spyOn(trigger, 'getBoundingClientRect').mockImplementation(() => currentRect as DOMRect);

    fireEvent.pointerDown(trigger, { pointerId: 95, pointerType: 'touch', isPrimary: true, button: 0, clientX: 10, clientY: 10 });
    currentRect = { ...currentRect, x: 100, left: 100, right: 140 };
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole('dialog', { name: /Full stitch brush size/i })).not.toBeInTheDocument();
    fireEvent.pointerUp(trigger, { pointerId: 95, clientX: 10, clientY: 10 });
    fireEvent.click(trigger, { detail: 1, pointerId: 95, pointerType: 'touch' });
    expect(f.c.setBrush).not.toHaveBeenCalled();
  });
  it('rechecks current trigger geometry on captured move and release', () => {
    vi.useFakeTimers();
    render(<EditorSurface workspace={ws} document={doc} />);
    const trigger = screen.getByRole('button', { name: 'Full stitch' });
    let currentRect = { x: 0, y: 0, left: 0, top: 0, right: 40, bottom: 40, width: 40, height: 40, toJSON: () => ({}) };
    vi.spyOn(trigger, 'getBoundingClientRect').mockImplementation(() => currentRect as DOMRect);

    fireEvent.pointerDown(trigger, { pointerId: 96, pointerType: 'touch', isPrimary: true, button: 0, clientX: 10, clientY: 10 });
    currentRect = { ...currentRect, x: 100, left: 100, right: 140 };
    fireEvent.pointerMove(document, { pointerId: 96, clientX: 10, clientY: 10 });
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole('dialog', { name: /Full stitch brush size/i })).not.toBeInTheDocument();
    fireEvent.pointerUp(trigger, { pointerId: 96, clientX: 10, clientY: 10 });
    fireEvent.click(trigger, { detail: 1, pointerId: 96, pointerType: 'touch' });
    expect(f.c.setBrush).not.toHaveBeenCalled();

    currentRect = { ...currentRect, x: 0, left: 0, right: 40 };
    fireEvent.pointerDown(trigger, { pointerId: 97, pointerType: 'touch', isPrimary: true, button: 0, clientX: 10, clientY: 10 });
    currentRect = { ...currentRect, x: 100, left: 100, right: 140 };
    fireEvent.pointerUp(trigger, { pointerId: 97, clientX: 10, clientY: 10 });
    fireEvent.click(trigger, { detail: 1, pointerId: 97, pointerType: 'touch' });
    expect(f.c.setBrush).not.toHaveBeenCalled();
  });
  it('retains Shape click suppression through menu selection and its original release', () => {
    vi.useFakeTimers(); render(<EditorSurface workspace={ws} document={doc} />);
    const shape = screen.getByRole('button', { name: 'Shape' });
    fireEvent.pointerDown(shape, { pointerId: 93, pointerType: 'touch', button: 0, isPrimary: true });
    act(() => vi.advanceTimersByTime(500));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Circle' }));
    fireEvent.pointerUp(shape, { pointerId: 93 });
    fireEvent.click(shape, { detail: 1, pointerId: 93, pointerType: 'touch' });
    expect(f.c.setTool).toHaveBeenCalledTimes(1);
    expect(f.c.setTool).toHaveBeenCalledWith({ tool: 'shape', shape: 'circle' });
  });
  it('ignores a competing pointer until the owning brush session ends', () => {
    vi.useFakeTimers();
    render(<EditorSurface workspace={ws} document={doc} />);
    const full = screen.getByRole('button', { name: 'Full stitch' });
    const shape = screen.getByRole('button', { name: 'Shape' });

    fireEvent.pointerDown(full, { pointerId: 101, pointerType: 'touch', isPrimary: true, button: 0 });
    fireEvent.pointerDown(shape, { pointerId: 102, pointerType: 'touch', isPrimary: false, button: 0 });
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole('dialog', { name: /Full stitch brush size/i })).toBeInTheDocument();
    expect(screen.queryByRole('menu', { name: 'Choose shape' })).not.toBeInTheDocument();

    fireEvent.pointerUp(document.body, { pointerId: 102 });
    fireEvent.click(shape, { detail: 1, pointerId: 102, pointerType: 'touch' });
    expect(f.c.setTool).not.toHaveBeenCalled();
    fireEvent.pointerUp(full, { pointerId: 101 });
    fireEvent.click(full, { detail: 1, pointerId: 101, pointerType: 'touch' });
    expect(f.c.setBrush).not.toHaveBeenCalled();
  });
  it('ignores a competing pointer click released after the owning session', () => {
    vi.useFakeTimers();
    render(<EditorSurface workspace={ws} document={doc} />);
    const full = screen.getByRole('button', { name: 'Full stitch' });
    const half = screen.getByRole('button', { name: 'Half stitch' });
    fireEvent.pointerDown(full, { pointerId: 110, pointerType: 'touch', isPrimary: true, button: 0 });
    fireEvent.pointerDown(half, { pointerId: 111, pointerType: 'touch', isPrimary: false, button: 0 });
    act(() => vi.advanceTimersByTime(500));

    fireEvent.pointerUp(full, { pointerId: 110, pointerType: 'touch' });
    fireEvent.pointerUp(half, { pointerId: 111, pointerType: 'touch' });
    fireEvent.click(half, { detail: 1, pointerId: 111, pointerType: 'touch' });
    fireEvent.click(full, { detail: 1, pointerId: 110, pointerType: 'touch' });
    expect(f.c.setBrush).not.toHaveBeenCalled();
  });
  it('keeps tracking a competing pointer after the owner cancels', () => {
    vi.useFakeTimers();
    render(<EditorSurface workspace={ws} document={doc} />);
    const full = screen.getByRole('button', { name: 'Full stitch' });
    const half = screen.getByRole('button', { name: 'Half stitch' });
    fireEvent.pointerDown(full, { pointerId: 310, pointerType: 'touch', isPrimary: true, button: 0 });
    fireEvent.pointerDown(half, { pointerId: 311, pointerType: 'touch', isPrimary: false, button: 0 });

    fireEvent.pointerCancel(document.body, { pointerId: 310, pointerType: 'touch' });
    fireEvent.pointerUp(half, { pointerId: 311, pointerType: 'touch' });
    dispatchPointerClick(half, 311);
    expect(f.c.setBrush).not.toHaveBeenCalled();
  });
  it('preserves a competing pointer click token when its owner cancels later', () => {
    vi.useFakeTimers();
    render(<EditorSurface workspace={ws} document={doc} />);
    const full = screen.getByRole('button', { name: 'Full stitch' });
    const half = screen.getByRole('button', { name: 'Half stitch' });
    fireEvent.pointerDown(full, { pointerId: 312, pointerType: 'touch', isPrimary: true, button: 0 });
    fireEvent.pointerDown(half, { pointerId: 313, pointerType: 'touch', isPrimary: false, button: 0 });
    fireEvent.pointerUp(half, { pointerId: 313, pointerType: 'touch' });
    fireEvent.pointerCancel(document.body, { pointerId: 312, pointerType: 'touch' });

    act(() => vi.advanceTimersByTime(350));
    dispatchPointerClick(half, 313);
    expect(f.c.setBrush).not.toHaveBeenCalled();
  });
  it('does not retain click suppression after an opened press is canceled', () => {
    vi.useFakeTimers();
    render(<EditorSurface workspace={ws} document={doc} />);
    const full = screen.getByRole('button', { name: 'Full stitch' });
    fireEvent.pointerDown(full, { pointerId: 103, pointerType: 'touch', isPrimary: true, button: 0 });
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole('dialog', { name: /Full stitch brush size/i })).toBeInTheDocument();

    fireEvent.pointerCancel(document.body, { pointerId: 103 });
    fireEvent.click(full, { detail: 0 });
    expect(f.c.setBrush).toHaveBeenCalledWith({ kind: 'full', paletteId: 1 });
  });
  it('clears the press session on window blur and allows a fresh same-tool tap', () => {
    vi.useFakeTimers();
    render(<EditorSurface workspace={ws} document={doc} />);
    const full = screen.getByRole('button', { name: 'Full stitch' });
    fireEvent.pointerDown(full, { pointerId: 107, pointerType: 'touch', isPrimary: true, button: 0 });
    act(() => vi.advanceTimersByTime(500));
    fireEvent(window, new Event('blur'));

    fireEvent.click(full, { detail: 0 });
    expect(f.c.setBrush).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(full, { pointerId: 108, pointerType: 'touch', isPrimary: true, button: 0 });
    fireEvent.pointerUp(full, { pointerId: 108 });
    fireEvent.click(full, { detail: 1, pointerId: 108, pointerType: 'touch' });
    expect(f.c.setBrush).toHaveBeenCalledTimes(2);
  });
  it('keeps an outside-dismissed Shape press owned until its trailing click is consumed', () => {
    vi.useFakeTimers();
    render(<EditorSurface workspace={ws} document={doc} />);
    const shape = screen.getByRole('button', { name: 'Shape' });
    fireEvent.pointerDown(shape, { pointerId: 104, pointerType: 'touch', isPrimary: true, button: 0 });
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole('menu', { name: 'Choose shape' })).toBeInTheDocument();

    fireEvent.pointerDown(document.body, { pointerId: 105, pointerType: 'touch', isPrimary: true, button: 0 });
    expect(screen.queryByRole('menu', { name: 'Choose shape' })).not.toBeInTheDocument();
    fireEvent.pointerUp(shape, { pointerId: 104 });
    fireEvent.click(shape, { detail: 1, pointerId: 104, pointerType: 'touch' });
    expect(f.c.setTool).not.toHaveBeenCalled();
    fireEvent.click(shape);
    expect(f.c.setTool).toHaveBeenCalledWith({ tool: 'shape', shape: 'triangle' });
  });
  it('removes captured lifecycle listeners when an active press unmounts', () => {
    vi.useFakeTimers();
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const view = render(<EditorSurface workspace={ws} document={doc} />);
    const full = screen.getByRole('button', { name: 'Full stitch' });
    fireEvent.pointerDown(full, { pointerId: 106, pointerType: 'touch', isPrimary: true, button: 0 });
    const moveListener = addSpy.mock.calls.find(([type, , capture]) => type === 'pointermove' && capture === true)?.[1];
    expect(moveListener).toBeTypeOf('function');

    view.unmount();
    expect(removeSpy).toHaveBeenCalledWith('pointermove', moveListener, true);
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
  it('keeps the long-press click suppressed when Escape closes the menu before release', () => {
    vi.useFakeTimers();
    render(<EditorSurface workspace={ws} document={doc} />);
    const shape = screen.getByRole('button', { name: 'Shape' });
    fireEvent.pointerDown(shape, { pointerId: 21, pointerType: 'touch', isPrimary: true });
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole('menu', { name: 'Choose shape' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Choose shape' })).not.toBeInTheDocument();
    fireEvent.pointerUp(shape, { pointerId: 21 });
    fireEvent.click(shape, { detail: 1, pointerId: 21, pointerType: 'touch' });
    expect(f.c.setTool).not.toHaveBeenCalled();
    fireEvent.click(shape, { detail: 1, pointerId: 21, pointerType: 'touch' });
    expect(f.c.setTool).toHaveBeenCalledWith({ tool: 'shape', shape: 'triangle' });
    vi.useRealTimers();
  });
  it('clears long-press suppression after release outside before Escape', () => {
    vi.useFakeTimers();
    render(<EditorSurface workspace={ws} document={doc} />);
    const shape = screen.getByRole('button', { name: 'Shape' });
    fireEvent.pointerDown(shape, { pointerId: 22, pointerType: 'touch', isPrimary: true });
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole('menu', { name: 'Choose shape' })).toBeInTheDocument();
    fireEvent.pointerUp(document.body, { pointerId: 22 });
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(shape);
    expect(f.c.setTool).toHaveBeenCalledWith({ tool: 'shape', shape: 'triangle' });
    vi.useRealTimers();
  });
  it('cancels long press when the pointer leaves and ignores an outside release', () => {
    vi.useFakeTimers();
    render(<EditorSurface workspace={ws} document={doc} />);
    const shape = screen.getByRole('button', { name: 'Shape' });
    fireEvent.pointerDown(shape, { pointerId: 4, pointerType: 'touch', isPrimary: true });
    fireEvent.pointerLeave(shape, { pointerId: 4 });
    fireEvent.pointerUp(document.body, { pointerId: 4 });
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole('menu', { name: 'Choose shape' })).not.toBeInTheDocument();
    expect(f.c.setTool).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
  it('disables Shape when the selected palette id is missing', () => {
    (f.uiState as { paletteId: number | null }).paletteId = null;
    render(<EditorSurface workspace={ws} document={two} />);
    const shape = screen.getByRole('button', { name: 'Shape' });
    expect(shape).toBeDisabled();
    fireEvent.click(shape);
    expect(f.c.setTool).not.toHaveBeenCalled();
  });
  it.each(['Enter', ' '])('activates the selected Shape from the toolbar with %s without canvas keyboard editing', (key) => {
    f.uiState.paletteId = 1;
    render(<EditorSurface workspace={ws} document={doc} />);
    const shape = screen.getByRole('button', { name: 'Shape' });
    f.c.handleKeyDown.mockClear();
    fireEvent.keyDown(shape, { key });
    expect(f.c.setTool).toHaveBeenCalledWith({ tool: 'shape', shape: 'triangle' });
    expect(f.c.handleKeyDown).not.toHaveBeenCalled();
  });
  it('marks the current choice selected and exposes all six menu items', () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Shape' }));
    const menu = screen.getByRole('menu', { name: 'Choose shape' });
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(7);
    expect(within(menu).getByRole('menuitemradio', { name: 'Triangle' })).toHaveAttribute('aria-checked', 'true');
  });
  it('keeps selection actions out of the rail', () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    const rail = within(screen.getByRole('navigation', { name: 'Editor sections' }));
    expect(rail.queryByRole('button', { name: 'Paste selection' })).not.toBeInTheDocument();
    expect(rail.queryByRole('button', { name: 'Delete selection' })).not.toBeInTheDocument();
  });
  it('renders and dismisses the touch Copy menu at clamped screen coordinates', async () => {
    const view = render(<EditorSurface workspace={ws} document={doc} />);
    const canvas = screen.getByRole('group', { name: 'Stitch chart canvas' });
    canvas.focus();
    Object.defineProperty(canvas, 'clientWidth', { configurable: true, value: 320 });
    Object.defineProperty(canvas, 'clientHeight', { configurable: true, value: 240 });
    act(() => {
      f.uiState.overlay = {
        touchCopyRequest: { cell: { x: 12, y: 18 }, selection: { x: 12, y: 18, width: 2, height: 2 }, screenX: 160, screenY: 120 },
      };
      f.uiListener?.({ ...f.uiState });
    });
    const menu = screen.getByRole('group', { name: 'Selection actions' });
    const adapterCall = f.adapter.mock.calls.at(-1) as unknown as [unknown, unknown, { shouldExcludeTarget?: (target: unknown, eventType: string) => boolean } | undefined] | undefined;
    const adapterOptions = adapterCall?.[2];
    expect(adapterOptions?.shouldExcludeTarget?.(within(menu).getByRole('button', { name: 'Copy selection' }), 'pointerdown')).toBe(true);
    expect(adapterOptions?.shouldExcludeTarget?.(document.querySelector('.canvas-frame'), 'pointerdown')).toBe(false);
    expect(within(menu).getByRole('button', { name: 'Copy selection' })).toHaveFocus();
    expect(within(menu).getByRole('button', { name: 'Copy selection' })).toHaveProperty('tabIndex', 0);
    expect(menu).toHaveStyle({ left: '85px', top: '96px' });
    Object.defineProperty(menu, 'offsetWidth', { configurable: true, value: 260 });
    Object.defineProperty(menu, 'offsetHeight', { configurable: true, value: 48 });
    f.uiState.overlay = { touchCopyRequest: { cell: { x: 12, y: 18 }, selection: { x: 12, y: 18, width: 2, height: 2 }, screenX: 160, screenY: 120 } };
    act(() => f.uiListener?.({ ...f.uiState }));
    await waitFor(() => expect(menu).toHaveStyle({ left: '30px', top: '96px' }));
    expect(within(menu).getAllByRole('button').map((item) => item.textContent)).toEqual([
      'Copy', 'Paste', 'Move', 'Delete',
    ]);
    expect(stylesText).toMatch(/\.touch-copy-menu button \{[^}]*min-width:2\.75rem;[^}]*min-height:2\.75rem;/);
    const copy = within(menu).getByRole('button', { name: 'Copy selection' });
    const paste = within(menu).getByRole('button', { name: 'Paste selection' });
    const move = within(menu).getByRole('button', { name: 'Move selection' });
    const del = within(menu).getByRole('button', { name: 'Delete selection' });
    expect(paste).toBeDisabled();
    fireEvent.keyDown(menu, { key: 'Enter' });
    expect(f.c.copySelection).not.toHaveBeenCalled();
    fireEvent.keyDown(copy, { key: 'Enter' });
    expect(f.c.copySelection).toHaveBeenCalledOnce();
    expect(f.c.dismissTouchCopyRequest).toHaveBeenCalled();
    act(() => {
      f.uiState.canPaste = true;
      f.uiListener?.({ ...f.uiState });
    });
    expect(paste).toBeEnabled();
    fireEvent.pointerDown(paste, { pointerType: 'touch' });
    fireEvent.click(paste);
    fireEvent.click(move, { detail: 1 });
    expect(f.c.moveSelection).not.toHaveBeenCalled();
    fireEvent.pointerDown(move, { pointerType: 'touch' });
    fireEvent.click(move, { detail: 1 });
    fireEvent.pointerDown(del, { pointerType: 'touch' });
    fireEvent.click(del);
    expect(f.c.pasteSelection).toHaveBeenCalledOnce();
    expect(f.c.moveSelection).toHaveBeenCalledOnce();
    expect(f.c.deleteSelection).toHaveBeenCalledOnce();
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector('.canvas-frame')));
    fireEvent.keyDown(copy, { key: 'Escape' });
    fireEvent.pointerDown(document.body);
    expect(f.c.dismissTouchCopyRequest).toHaveBeenCalled();
    f.uiState.overlay = { touchCopyRequest: { cell: { x: 1, y: 1 }, selection: { x: 1, y: 1, width: 1, height: 1 }, screenX: 319, screenY: 239 } };
    act(() => f.uiListener?.({ ...f.uiState }));
    await waitFor(() => expect(menu).toHaveStyle({ left: '60px', top: '192px' }));
    view.unmount();
  });
  it('marks top-level stitch tools with accessible pressed state and fill icons', () => { f.uiState.tool = { tool: 'paint', brush: { kind: 'half', paletteId: 1 } } as never; const view = render(<EditorSurface workspace={ws} document={doc} />); expect(screen.getByRole('button', { name: 'Full stitch' })).toHaveAttribute('aria-pressed', 'false'); expect(screen.getByRole('button', { name: 'Half stitch' })).toHaveAttribute('aria-pressed', 'true'); expect(screen.getByRole('button', { name: '3/4 stitch' })).toHaveAttribute('aria-pressed', 'false'); expect(screen.getByRole('button', { name: 'Full stitch' }).querySelector('.stitch-brush-icon-full')).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Half stitch' }).querySelector('.stitch-brush-icon-half')).toBeInTheDocument(); expect(screen.getByRole('button', { name: '3/4 stitch' }).querySelector('.stitch-brush-icon-three-quarter')).toBeInTheDocument(); view.unmount(); f.uiState.tool = { tool: 'backstitch' }; render(<EditorSurface workspace={ws} document={doc} />); expect(screen.getByRole('button', { name: 'Backstitch' })).toHaveAttribute('aria-pressed', 'true'); expect(screen.getByRole('button', { name: 'Full stitch' })).toHaveAttribute('aria-pressed', 'false'); });
   it('invokes Completion as a top-level tool and exposes its pressed state', () => { f.uiState.tool = { tool: 'completion' }; render(<EditorSurface workspace={ws} document={doc} />); const completion = screen.getByRole('button', { name: 'Completion' }); expect(completion).toHaveAttribute('title', 'Completion'); expect(completion).toHaveAttribute('aria-pressed', 'true'); expect(completion.querySelector('[data-icon="completion"]')).toBeInTheDocument(); fireEvent.click(completion); expect(f.c.setTool).toHaveBeenCalledWith({ tool: 'completion' }); });
  it('surfaces the project name, selected-unit size, rail controls, header history, and palette rail', () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    expect(screen.getByRole('heading', { name: 'Sampler' })).toBeInTheDocument();
    expect(screen.getByText(/16 × 16 stitches · 2.9 cm × 2.9 cm/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Redo' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Paint' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Paint' })).not.toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: /Brush size/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Full stitch' })).toBeVisible();
    const paletteRegion = screen.getByRole('region', { name: 'Thread colors' });
    const rail = screen.getByRole('complementary', { name: 'Editor controls' });
    expect(rail).toContainElement(paletteRegion);
    expect(paletteRegion).toHaveClass('palette-rail');
    expect(rail.querySelector('nav.editor-rail')).toBeInTheDocument();
  });
  it('keeps the condensed export and save indicators semantic', () => {
    render(<EditorSurface workspace={ws} document={doc} onExport={vi.fn()} exportDisabled saveMessage="Local save needs attention" saveStatus="error" />);
    const download = screen.getByRole('button', { name: 'Download Pattern' });
    expect(download).toBeDisabled();
    expect(download).toHaveAttribute('title', 'Download Pattern');
    expect(download.querySelector('[data-icon="download"]')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Needlewise home' }).compareDocumentPosition(download) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const saveStatus = screen.getByRole('status', { name: 'Local save needs attention' });
    expect(saveStatus).toHaveAttribute('title', 'Local save needs attention');
    expect(saveStatus.querySelector('.save-dot')).toHaveClass('save-dot-error');
    expect(screen.queryByText('Local save needs attention')).not.toBeInTheDocument();
  });
  it('keeps section popovers separate from the canvas action row', () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    const brush = screen.queryByRole('heading', { name: 'Brush settings' });
    expect(brush).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Full stitch' }).closest('.editor-control-panel')).toBeNull();
    const actions = document.querySelector('.canvas-actions') as HTMLElement;
    const reference = within(actions).getByRole('toolbar', { name: 'Reference image' });
    const view = within(actions).getByRole('group', { name: 'View settings' });
    expect(reference).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'View settings' })).toBeInTheDocument();
    expect(within(view).queryByRole('checkbox', { name: 'Show grid' })).not.toBeInTheDocument();
    for (const name of ['Color', 'Symbol', 'B/W', 'Both']) {
      expect(within(view).getByRole('button', { name })).toHaveAttribute('title', name);
    }
    const zoomIn = within(actions).getByRole('button', { name: 'Zoom in' });
    const fit = within(actions).getByRole('button', { name: 'Fit' });
    expect(reference.compareDocumentPosition(view) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(view.compareDocumentPosition(zoomIn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(zoomIn.compareDocumentPosition(fit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Full stitch' })).toBeVisible();
  });
  it('uses the bucket marker for Fill and exposes one active direct tool', () => {
    f.uiState.tool = { tool: 'fill' };
    render(<EditorSurface workspace={ws} document={doc} />);
    const fill = screen.getByRole('button', { name: 'Fill' });
    expect(fill).toHaveAttribute('aria-pressed', 'true');
    expect(fill.querySelector('[data-icon="paint-bucket"]')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select' }).querySelector('[data-icon="select"]')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pan' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Eraser' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Full stitch' })).toHaveAttribute('aria-pressed', 'false');
  });
  it('wires Lasso select beside Select with an accessible pressed state', () => {
    f.uiState.tool = { tool: 'lasso' };
    render(<EditorSurface workspace={ws} document={doc} />);
    const select = screen.getByRole('button', { name: 'Select' });
    const lasso = screen.getByRole('button', { name: 'Lasso select' });
    expect(lasso).toHaveAttribute('title', 'Lasso select');
    expect(lasso).toHaveAttribute('aria-pressed', 'true');
    expect(lasso.querySelector('[data-icon="lasso"]')).toBeInTheDocument();
    expect(select.compareDocumentPosition(lasso) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(lasso);
    expect(f.c.setTool).toHaveBeenCalledWith({ tool: 'lasso' });
  });
  it('auto-fits the pattern once on init with the Fit-button routine', () => { render(<EditorSurface workspace={ws} document={doc} />); expect(f.c.setMetrics).toHaveBeenCalled(); const fits = () => (f.c.handleKeyDown as ReturnType<typeof vi.fn>).mock.calls.filter(([event]) => (event as { key: string }).key === '0'); expect(fits()).toHaveLength(1); fireEvent.click(screen.getByRole('button', { name: 'Fit' })); expect(fits()).toHaveLength(2); });
  it('renders settings sections and immediate rail placement', () => { render(<EditorSurface workspace={ws} document={doc} />); expect(screen.queryByRole('button', { name: 'Delete selection' })).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Paste selection' })).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: /Move controls/ })).not.toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: 'Open settings' })); const settings = screen.getByRole('dialog', { name: 'Settings' }); expect(within(settings).getByRole('heading', { name: 'Project' })).toBeInTheDocument(); fireEvent.click(within(settings).getByRole('tab', { name: 'Editor' })); expect(within(settings).getByRole('heading', { name: 'Editor' })).toBeInTheDocument(); fireEvent.click(within(settings).getByRole('button', { name: 'Right' })); expect(within(settings).getByRole('button', { name: 'Right' })).toHaveAttribute('aria-pressed', 'true'); expect(within(settings).getByRole('button', { name: 'Left' })).toHaveAttribute('aria-pressed', 'false'); expect(document.querySelector('.editor-layout')).toHaveClass('rail-right'); fireEvent.keyDown(settings, { key: 'Escape' }); expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); });
  it('synchronizes and saves the pattern background color in Settings', async () => {
    const pattern = { ...(doc as object), settings: { backgroundColor: '#F3EEE5' } } as never;
    render(<EditorSurface workspace={ws} document={pattern} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    const settings = screen.getByRole('dialog', { name: 'Settings' });
    const picker = within(settings).getByLabelText('Background color');
    const hex = within(settings).getByLabelText('HEX Code');
    expect(picker).toHaveValue('#f3eee5');
    fireEvent.change(picker, { target: { value: '#12ab34' } });
    expect(hex).toHaveValue('#12AB34');
    fireEvent.change(hex, { target: { value: 'abc' } });
    expect(picker).toHaveValue('#aabbcc');
    fireEvent.click(within(settings).getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(executeMock()).toHaveBeenCalledWith({ type: 'document-settings-update', settings: { backgroundColor: '#AABBCC' } }));
  });
  it('groups Aida count and background color controls in Aida Settings', () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Aida' }));
    const section = within(dialog).getByRole('region', { name: 'Aida Settings' });
    expect(within(section).getByLabelText('Aida count')).toBeInTheDocument();
    expect(within(section).getByLabelText('Background color')).toBeInTheDocument();
    expect(within(section).getByLabelText('HEX Code')).toBeInTheDocument();
    expect(within(section).getByText(/three- or six-digit hex value/)).toBeInTheDocument();
  });
  it('opens Settings on Project and exposes accessible Project, Aida, and Editor tabs', async () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    const tabs = within(dialog).getByRole('tablist', { name: 'Settings sections' });
    const project = within(tabs).getByRole('tab', { name: 'Project' });
    const aidaTab = within(tabs).getByRole('tab', { name: 'Aida' });
    const editor = within(tabs).getByRole('tab', { name: 'Editor' });
    expect(project).toHaveAttribute('aria-selected', 'true');
    expect(within(dialog).getByRole('tabpanel')).toHaveAttribute('aria-labelledby', project.id);
    expect(within(dialog).getByLabelText('Title')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Draft title' } });
    fireEvent.click(aidaTab);
    fireEvent.click(project);
    expect(within(dialog).getByLabelText('Title')).toHaveValue('Draft title');
    fireEvent.click(aidaTab);
    let panel = within(dialog).getByRole('tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', aidaTab.id);
    expect(within(panel).getByLabelText('Aida count')).toBeInTheDocument();
    expect(within(panel).getByLabelText('Background color')).toBeInTheDocument();
    fireEvent.click(editor);
    panel = within(dialog).getByRole('tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', editor.id);
    expect(within(panel).getByRole('checkbox', { name: 'Show palette symbols' })).toBeInTheDocument();
    editor.focus();
    fireEvent.keyDown(editor, { key: 'Home' });
    await waitFor(() => expect(project).toHaveFocus());
    expect(project).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(project, { key: 'ArrowRight' });
    await waitFor(() => expect(aidaTab).toHaveFocus());
    expect(aidaTab).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(aidaTab, { key: 'End' });
    await waitFor(() => expect(editor).toHaveFocus());
    expect(editor).toHaveAttribute('aria-selected', 'true');
  });
  it('refreshes pristine settings color from document updates and reopened settings', () => {
    const first = { ...(doc as object), settings: { backgroundColor: '#F3EEE5' } } as never;
    const view = render(<EditorSurface workspace={ws} document={first} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    const hex = within(dialog).getByLabelText('HEX Code');
    fireEvent.change(hex, { target: { value: '#abc' } });
    const updated = { ...(doc as object), settings: { backgroundColor: '#123456' } } as never;
    view.rerender(<EditorSurface workspace={ws} document={updated} />);
    expect(hex).toHaveValue('#AABBCC');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(within(screen.getByRole('dialog', { name: 'Settings' })).getByLabelText('HEX Code')).toHaveValue('#123456');
  });
  it('keeps Settings open and does not save metadata for invalid background HEX', async () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    fireEvent.change(within(dialog).getByLabelText('HEX Code'), { target: { value: '#12' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save settings' }));
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect((ws as { updateActiveMetadata: ReturnType<typeof vi.fn> }).updateActiveMetadata).not.toHaveBeenCalled();
  });
  it('returns to Aida and exposes invalid HEX help when Save is submitted from another tab', async () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Aida' }));
    const hex = within(dialog).getByLabelText('HEX Code');
    fireEvent.change(hex, { target: { value: '#12' } });
    expect(within(dialog).getByText('Enter a 3- or 6-digit hex color.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Project' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save settings' }));
    expect(within(dialog).getByRole('tab', { name: 'Aida' })).toHaveAttribute('aria-selected', 'true');
    expect(within(dialog).getByText('Enter a 3- or 6-digit hex color.')).toBeVisible();
    await waitFor(() => expect(hex).toHaveFocus());
    expect((ws as { execute: ReturnType<typeof vi.fn> }).execute).not.toHaveBeenCalled();
    expect((ws as { updateActiveMetadata: ReturnType<typeof vi.fn> }).updateActiveMetadata).not.toHaveBeenCalled();
    expect(dialog).toBeInTheDocument();
  });
  it('hydrates global editor preferences across workspace changes', () => {
    localStorage.setItem('needlewise-editor-preferences:v1', JSON.stringify({ version: 1, railSide: 'right', paletteDisplay: { symbols: false, numbers: false } }));
    const view = render(<EditorSurface workspace={ws} document={doc} />);
    expect(document.querySelector('.editor-layout')).toHaveClass('rail-right');
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    let settings = screen.getByRole('dialog', { name: 'Settings' });
    fireEvent.click(within(settings).getByRole('tab', { name: 'Editor' }));
    expect(within(settings).getByRole('button', { name: 'Right' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(settings).getByRole('checkbox', { name: 'Show palette symbols' })).not.toBeChecked();
    expect(within(settings).getByRole('checkbox', { name: 'Show palette numbers' })).not.toBeChecked();
    view.unmount();

    const otherWorkspace = { ...(ws as unknown as { metadata: Record<string, unknown> }), metadata: { ...(ws as unknown as { metadata: Record<string, unknown> }).metadata, id: 'different-project' } } as never;
    render(<EditorSurface workspace={otherWorkspace} document={doc} />);
    expect(document.querySelector('.editor-layout')).toHaveClass('rail-right');
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    settings = screen.getByRole('dialog', { name: 'Settings' });
    fireEvent.click(within(settings).getByRole('tab', { name: 'Editor' }));
    expect(within(settings).getByRole('button', { name: 'Right' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(settings).getByRole('checkbox', { name: 'Show palette symbols' })).not.toBeChecked();
    expect(within(settings).getByRole('checkbox', { name: 'Show palette numbers' })).not.toBeChecked();
  });
  it('writes the complete global editor preferences envelope immediately', async () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Editor' }));
    fireEvent.click(screen.getByRole('button', { name: 'Right' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Settings' })).getByRole('checkbox', { name: 'Show palette symbols' }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem('needlewise-editor-preferences:v1') ?? 'null')).toEqual({ version: 1, railSide: 'right', paletteDisplay: { symbols: false, numbers: true }, pencilModeEnabled: false }));
  });
  it('falls back to default editor preferences for malformed global storage', () => {
    localStorage.setItem('needlewise-editor-preferences:v1', '{not-json');
    render(<EditorSurface workspace={ws} document={doc} />);
    expect(document.querySelector('.editor-layout')).toHaveClass('rail-left');
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    const settings = screen.getByRole('dialog', { name: 'Settings' });
    fireEvent.click(within(settings).getByRole('tab', { name: 'Editor' }));
    expect(within(settings).getByRole('button', { name: 'Left' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(settings).getByRole('checkbox', { name: 'Show palette symbols' })).toBeChecked();
    expect(within(settings).getByRole('checkbox', { name: 'Show palette numbers' })).toBeChecked();
  });
  it('falls back to default editor preferences for invalid global fields', () => {
    localStorage.setItem('needlewise-editor-preferences:v1', JSON.stringify({ version: 2, railSide: 'right', paletteDisplay: { symbols: false, numbers: false } }));
    render(<EditorSurface workspace={ws} document={doc} />);
    expect(document.querySelector('.editor-layout')).toHaveClass('rail-left');
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    const settings = screen.getByRole('dialog', { name: 'Settings' });
    fireEvent.click(within(settings).getByRole('tab', { name: 'Editor' }));
    expect(within(settings).getByRole('button', { name: 'Left' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(settings).getByRole('checkbox', { name: 'Show palette symbols' })).toBeChecked();
    expect(within(settings).getByRole('checkbox', { name: 'Show palette numbers' })).toBeChecked();
  });
  it('migrates legacy palette display preferences into the global envelope', async () => {
    localStorage.setItem('needlewise-editor-palette:default', JSON.stringify({ symbols: false, numbers: true }));
    render(<EditorSurface workspace={ws} document={doc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    const settings = screen.getByRole('dialog', { name: 'Settings' });
    fireEvent.click(within(settings).getByRole('tab', { name: 'Editor' }));
    expect(within(settings).getByRole('button', { name: 'Left' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(settings).getByRole('checkbox', { name: 'Show palette symbols' })).not.toBeChecked();
    expect(within(settings).getByRole('checkbox', { name: 'Show palette numbers' })).toBeChecked();
    await waitFor(() => expect(JSON.parse(localStorage.getItem('needlewise-editor-preferences:v1') ?? 'null')).toEqual({ version: 1, railSide: 'left', paletteDisplay: { symbols: false, numbers: true }, pencilModeEnabled: false }));
  });
  it('defaults pencil mode off and updates the controller', () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    expect(f.c.setTouchMovementOnly).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    const settings = screen.getByRole('dialog', { name: 'Settings' });
    fireEvent.click(within(settings).getByRole('tab', { name: 'Editor' }));
    const pencil = within(settings).getByRole('checkbox', { name: 'Enable pencil mode' });
    expect(pencil).not.toBeChecked();
    fireEvent.click(pencil);
    expect(pencil).toBeChecked();
    expect(f.c.setTouchMovementOnly).toHaveBeenLastCalledWith(true);
  });
  it('migrates the inverse touch preference into pencil mode', async () => {
    localStorage.setItem('needlewise-editor-preferences:v1', JSON.stringify({ version: 1, railSide: 'left', paletteDisplay: { symbols: true, numbers: true }, touchEditingEnabled: false }));
    render(<EditorSurface workspace={ws} document={doc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    const settings = screen.getByRole('dialog', { name: 'Settings' });
    fireEvent.click(within(settings).getByRole('tab', { name: 'Editor' }));
    expect(within(settings).getByRole('checkbox', { name: 'Enable pencil mode' })).toBeChecked();
    expect(f.c.setTouchMovementOnly).toHaveBeenCalledWith(true);
    await waitFor(() => expect(JSON.parse(localStorage.getItem('needlewise-editor-preferences:v1') ?? 'null')).toEqual({ version: 1, railSide: 'left', paletteDisplay: { symbols: true, numbers: true }, pencilModeEnabled: true }));
  });
  it('provides an accessible pencil mode tooltip trigger', () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    const settings = screen.getByRole('dialog', { name: 'Settings' });
    fireEvent.click(within(settings).getByRole('tab', { name: 'Editor' }));
    const info = within(settings).getByRole('button', { name: 'Pencil mode information' });
    const tooltip = within(settings).getByRole('tooltip');
    expect(info).toHaveAttribute('aria-describedby', 'pencil-mode-tooltip');
    expect(tooltip).toHaveTextContent(/Normal touch can only move or zoom/);
    expect(info).toHaveAttribute('type', 'button');
  });
  it('independently toggles the palette symbol and number settings', () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    const settings = screen.getByRole('dialog', { name: 'Settings' });
    fireEvent.click(within(settings).getByRole('tab', { name: 'Editor' }));
    const symbols = within(settings).getByRole('checkbox', { name: 'Show palette symbols' });
    const numbers = within(settings).getByRole('checkbox', { name: 'Show palette numbers' });
    expect(symbols).toBeChecked();
    expect(numbers).toBeChecked();
    fireEvent.click(symbols);
    expect(symbols).not.toBeChecked();
    expect(numbers).toBeChecked();
    fireEvent.click(numbers);
    expect(symbols).not.toBeChecked();
    expect(numbers).not.toBeChecked();
  });
  it('defaults project details to metric units and saves a switch through metadata', () => { render(<EditorSurface workspace={ws} document={doc} />); fireEvent.click(screen.getByRole('button', { name: 'Open settings' })); expect(screen.getByRole('button', { name: 'Metric' })).toHaveAttribute('aria-pressed', 'true'); expect(screen.getByRole('button', { name: 'Imperial' })).toHaveAttribute('aria-pressed', 'false'); fireEvent.click(screen.getByRole('button', { name: 'Imperial' })); expect(screen.getByRole('button', { name: 'Imperial' })).toHaveAttribute('aria-pressed', 'true'); fireEvent.click(screen.getByRole('button', { name: 'Save settings' })); expect((ws as { updateActiveMetadata: ReturnType<typeof vi.fn> }).updateActiveMetadata).toHaveBeenCalledWith({ title: 'Sampler', notes: '', units: 'imperial' }); });
  it('reflects a stored imperial preference when project details opens', () => { const base = ws as unknown as { metadata: Record<string, unknown> }; const imperialWs = { ...base, metadata: { ...base.metadata, units: 'imperial' } } as never; render(<EditorSurface workspace={imperialWs} document={doc} />); fireEvent.click(screen.getByRole('button', { name: 'Open settings' })); expect(screen.getByRole('button', { name: 'Imperial' })).toHaveAttribute('aria-pressed', 'true'); expect(screen.getByRole('button', { name: 'Metric' })).toHaveAttribute('aria-pressed', 'false'); });
  it('applies units immediately on toggle without waiting for save', () => { render(<EditorSurface workspace={ws} document={doc} />); fireEvent.click(screen.getByRole('button', { name: 'Open settings' })); fireEvent.click(screen.getByRole('button', { name: 'Imperial' })); expect((ws as { updateActiveMetadata: ReturnType<typeof vi.fn> }).updateActiveMetadata).toHaveBeenCalledWith({ units: 'imperial' }); expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument(); });
  it('guides users without a thread while keeping Completion available', () => { const empty = { width: 16, height: 16, colors: new Uint16Array(1024), palette: [{ id: 1, name: 'Ruby', color: '#b44', active: false }], backstitches: { ids: new Uint32Array() } } as never; render(<EditorSurface workspace={ws} document={empty} />); expect(screen.queryByRole('button', { name: 'Paint' })).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Fill' })).toBeDisabled(); expect(screen.getByRole('button', { name: 'Backstitch' })).toBeDisabled(); fireEvent.click(screen.getByRole('button', { name: 'Completion' })); expect(f.c.setTool).toHaveBeenCalledWith({ tool: 'completion' }); });
  it('shows catalog code before the palette name and exposes command buttons', () => { render(<EditorSurface workspace={ws} document={doc} />); const ruby = screen.getByRole('button', { name: '321Ruby' }); expect(ruby).toBeInTheDocument(); for (const name of ['Undo', 'Redo', 'Zoom in', 'Zoom out', 'Fit']) expect(screen.getByRole('button', { name })).toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: 'Undo' })); expect(f.c.handleKeyDown).toHaveBeenCalledWith(expect.objectContaining({ key: 'z', ctrlKey: true })); fireEvent.click(screen.getByRole('button', { name: 'Redo' })); expect(f.c.handleKeyDown).toHaveBeenCalledWith(expect.objectContaining({ key: 'y', ctrlKey: true })); fireEvent.click(screen.getByRole('button', { name: 'Zoom out' })); expect(f.c.handleKeyDown).toHaveBeenCalledWith(expect.objectContaining({ key: '-' })); });
  it('filters the thread-color grid, selects a swatch, and adds the summary color', async () => {
    const createdDocument = customColorDocument([
      ...(doc as { palette: unknown[] }).palette,
      { id: 2, name: 'Red', color: '#C72B3B', active: true, catalog: createCatalogReference(DEFAULT_CATALOG_DEFINITION, DEFAULT_CATALOG_DEFINITION.getByHex('#C72B3B')!) },
    ]);
    executeMock().mockResolvedValueOnce({ document: createdDocument });
    render(<EditorSurface workspace={ws} document={doc} />);
    fireEvent.click(screen.getByRole('button', { name: /Add new color/ }));
    const grid = screen.getByRole('list', { name: 'Available thread colors' });
    expect(within(grid).getAllByRole('button').length).toBeGreaterThan(8);
    fireEvent.change(screen.getByLabelText('Search DMC catalog'), { target: { value: '321' } });
    const red = within(grid).getByRole('button', { name: /Red, color 321/ });
    expect(within(grid).getAllByRole('button')).toHaveLength(1);
    expect(within(grid).queryByText('Red')).not.toBeInTheDocument();
    expect(within(grid).queryByText('#321')).not.toBeInTheDocument();
    fireEvent.click(red);
    expect(red).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Add Red' }));
    await waitFor(() => expect(executeMock()).toHaveBeenCalledWith(expect.objectContaining({ type: 'palette-create', name: 'Red', color: '#C72B3B' })));
    await waitFor(() => expect(f.c.selectCreatedPalette).toHaveBeenCalledWith(2));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add a thread color' })).not.toBeInTheDocument());
  });
  it('validates and exposes accessible custom color controls', () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    fireEvent.click(screen.getByRole('button', { name: /Add new color/ }));
    const dialog = screen.getByRole('dialog', { name: 'Add a thread color' });
    const picker = within(dialog).getByLabelText('Choose custom color');
    const hex = within(dialog).getByLabelText('Hex color');
    expect(picker).toHaveAttribute('type', 'color');
    expect(hex).toHaveValue('#000000');
    expect(within(dialog).getByRole('button', { name: 'Add #000000' })).toBeEnabled();
    fireEvent.change(hex, { target: { value: '#c72b3b' } });
    expect(within(dialog).getByRole('button', { name: 'Add Red' })).toBeEnabled();
    fireEvent.change(picker, { target: { value: '#123456' } });
    expect(hex).toHaveValue('#123456');
    fireEvent.change(hex, { target: { value: '#12' } });
    expect(within(dialog).getByRole('button', { name: 'Add custom color' })).toBeDisabled();
    expect(within(dialog).getByText(/enter a 3- or 6-digit hex color/i)).toBeInTheDocument();
    expect((ws as { execute: ReturnType<typeof vi.fn> }).execute).not.toHaveBeenCalled();
  }, 10000);
  it('canonicalizes optional-hash six-digit and three-digit custom input', () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    fireEvent.click(screen.getByRole('button', { name: /Add new color/ }));
    const dialog = screen.getByRole('dialog', { name: 'Add a thread color' });
    const hex = within(dialog).getByLabelText('Hex color');

    fireEvent.change(hex, { target: { value: 'c72b3b' } });
    expect(within(dialog).getByRole('button', { name: 'Add Red' })).toBeEnabled();
    fireEvent.change(hex, { target: { value: '#c7b' } });
    expect(within(dialog).getByRole('button', { name: 'Add #CC77BB' })).toBeEnabled();
  });
  it('synchronizes the circular color picker and HEX input while preserving the last valid color', () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    const dialog = openCustomColorDialog();
    const picker = within(dialog).getByLabelText('Choose custom color');
    const hex = within(dialog).getByLabelText('Hex color');
    fireEvent.change(picker, { target: { value: '#123456' } });
    expect(hex).toHaveValue('#123456');
    fireEvent.change(hex, { target: { value: '#12' } });
    expect(hex).toHaveValue('#12');
    expect(picker).toHaveValue('#123456');
    expect(customColorAction(dialog)).toBeDisabled();
  });
  it('keeps custom creation available when the runtime catalog is unavailable', () => {
    (ws as { catalogFor: ReturnType<typeof vi.fn> }).catalogFor.mockReturnValue(undefined);
    (ws as { availableCatalogs: ReturnType<typeof vi.fn> }).availableCatalogs.mockReturnValue([]);
    render(<EditorSurface workspace={ws} document={doc} />);
    const dialog = openCustomColorDialog();
    expect(within(dialog).getByText('Catalog unavailable')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Search catalog')).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Hex color'), { target: { value: '#12ab34' } });
    expect(customColorAction(dialog)).toBeEnabled();
    expect(within(dialog).queryByRole('button', { name: /Add Ruby/ })).not.toBeInTheDocument();
  });
  it('selects an active catalog match before an active custom match without executing', async () => {
    const matchingDocument = customColorDocument([
      { id: 2, name: 'Custom Ruby', color: '#BB4444', active: true },
      { id: 1, name: 'Catalog Ruby', color: '#b44', active: true, catalog: { catalogId: DEFAULT_CATALOG_DEFINITION.association.catalogId, sourceId: 'catalog-ruby', code: '321' } },
    ]);
    render(<EditorSurface workspace={ws} document={matchingDocument} />);
    const dialog = openCustomColorDialog();
    fireEvent.change(within(dialog).getByLabelText('Hex color'), { target: { value: '#b44' } });
    expect(customColorAction(dialog)).toHaveAccessibleName('Select Catalog Ruby');
    fireEvent.click(customColorAction(dialog));
    await waitFor(() => expect(f.c.selectPalette).toHaveBeenCalledWith(1));
    expect(f.c.selectPalette).not.toHaveBeenCalledWith(2);
    expect(executeMock()).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Add a thread color' })).not.toBeInTheDocument();
  });
  it('uses canonical source identity when same-catalog records share an exact hex', async () => {
    const noncanonical = { sourceId: 'same-hex-a', code: 'A1', name: 'Alternate Ruby', hex: '#BB0000', rgb: [187, 0, 0] as const } as CatalogRecord;
    const canonical = { sourceId: 'same-hex-b', code: 'B1', name: 'Canonical Ruby', hex: '#BB0000', rgb: [187, 0, 0] as const } as CatalogRecord;
    const definition = makeCatalog('same-hex-catalog', 'Same Hex', [noncanonical, canonical]);
    const workspace = ws as { catalogFor: ReturnType<typeof vi.fn>; availableCatalogs: ReturnType<typeof vi.fn> };
    workspace.catalogFor.mockReturnValue(definition);
    workspace.availableCatalogs.mockReturnValue([definition]);
    const document = customColorDocument([{ id: 1, name: noncanonical.name, color: noncanonical.hex, active: true, catalog: createCatalogReference(definition, noncanonical) }]);
    render(<EditorSurface workspace={ws} document={document} />);
    const dialog = openCustomColorDialog();
    fireEvent.change(within(dialog).getByLabelText('Hex color'), { target: { value: '#bb0000' } });
    expect(customColorAction(dialog)).toHaveAccessibleName('Add Canonical Ruby');
    fireEvent.click(customColorAction(dialog));
    await waitFor(() => expect(executeMock()).toHaveBeenCalledWith(expect.objectContaining({ type: 'palette-create', catalog: createCatalogReference(definition, canonical) })));
    expect(f.c.selectPalette).not.toHaveBeenCalled();
  });
  it('does not select a canonical catalog entry whose palette swatch was recolored', async () => {
    const canonical = { sourceId: 'canonical-source', code: 'C1', name: 'Canonical Ruby', hex: '#BB0000', rgb: [187, 0, 0] as const } as CatalogRecord;
    const definition = makeCatalog('recolored-catalog', 'Recolored Brand', [canonical]);
    const workspace = ws as { catalogFor: ReturnType<typeof vi.fn>; availableCatalogs: ReturnType<typeof vi.fn> };
    workspace.catalogFor.mockReturnValue(definition);
    workspace.availableCatalogs.mockReturnValue([definition]);
    const originalDocument = customColorDocument([{ id: 1, name: canonical.name, color: '#0000BB', active: true, catalog: createCatalogReference(definition, canonical) }]);
    const createdDocument = customColorDocument([
      ...(originalDocument as { palette: unknown[] }).palette,
      { id: 2, name: canonical.name, color: canonical.hex, active: true, catalog: createCatalogReference(definition, canonical) },
    ]);
    executeMock().mockResolvedValueOnce({ document: createdDocument });
    render(<EditorSurface workspace={ws} document={originalDocument} />);
    const dialog = openCustomColorDialog();
    fireEvent.change(within(dialog).getByLabelText('Hex color'), { target: { value: canonical.hex } });
    expect(customColorAction(dialog)).toHaveAccessibleName('Add Canonical Ruby');
    fireEvent.click(customColorAction(dialog));
    await waitFor(() => expect(executeMock()).toHaveBeenCalledWith(expect.objectContaining({ type: 'palette-create', catalog: createCatalogReference(definition, canonical) })));
    await waitFor(() => expect(f.c.selectCreatedPalette).toHaveBeenCalledWith(2));
    expect(f.c.selectPalette).not.toHaveBeenCalledWith(1);
  });
  it('selects an active custom match after expanding a short hex without executing', async () => {
    const matchingDocument = customColorDocument([
      { id: 1, name: 'Ruby', color: '#b44', active: true, catalog: { catalogId: DEFAULT_CATALOG_DEFINITION.association.catalogId, sourceId: 'catalog-ruby', code: '321' } },
      { id: 2, name: 'Sky', color: '#4488CC', active: true },
    ]);
    render(<EditorSurface workspace={ws} document={matchingDocument} />);
    const dialog = openCustomColorDialog();
    fireEvent.change(within(dialog).getByLabelText('Hex color'), { target: { value: '#48c' } });
    expect(customColorAction(dialog)).toHaveAccessibleName('Select Sky');
    fireEvent.click(customColorAction(dialog));
    await waitFor(() => expect(f.c.selectPalette).toHaveBeenCalledWith(2));
    expect(executeMock()).not.toHaveBeenCalled();
  });
  it('adds an absent exact DMC color with catalog metadata', async () => {
    const createdDocument = customColorDocument([
      { id: 1, name: 'Ruby', color: '#b44', active: true, catalog: { catalogId: DEFAULT_CATALOG_DEFINITION.association.catalogId, sourceId: 'ruby', code: '321' } },
      { id: 2, name: 'Red', color: '#C72B3B', active: true, catalog: createCatalogReference(DEFAULT_CATALOG_DEFINITION, DEFAULT_CATALOG_DEFINITION.getByHex('#C72B3B')!) },
    ]);
    (ws as { execute: ReturnType<typeof vi.fn> }).execute.mockResolvedValueOnce({ document: createdDocument });
    render(<EditorSurface workspace={ws} document={doc} />);
    const dialog = openCustomColorDialog();
    fireEvent.change(within(dialog).getByLabelText('Hex color'), { target: { value: '#c72b3b' } });
    expect(customColorAction(dialog)).toHaveAccessibleName('Add Red');
    fireEvent.click(customColorAction(dialog));
    await waitFor(() => expect(executeMock()).toHaveBeenCalledWith(expect.objectContaining({
      type: 'palette-create',
      catalog: expect.objectContaining({ code: '321', hex: '#C72B3B' }),
    })));
    await waitFor(() => expect(f.c.selectCreatedPalette).toHaveBeenCalledWith(2));
    expect(screen.queryByRole('dialog', { name: 'Add a thread color' })).not.toBeInTheDocument();
  });
  it('creates a novel custom color without catalog metadata', async () => {
    const createdDocument = customColorDocument([
      { id: 1, name: 'Ruby', color: '#b44', active: true, catalog: { code: '321' } },
      { id: 2, name: '#12AB34', color: '#12AB34', active: true },
    ]);
    (ws as { execute: ReturnType<typeof vi.fn> }).execute.mockResolvedValueOnce({ document: createdDocument });
    render(<EditorSurface workspace={ws} document={doc} />);
    const dialog = openCustomColorDialog();
    fireEvent.change(within(dialog).getByLabelText('Hex color'), { target: { value: '#12ab34' } });
    expect(customColorAction(dialog)).toHaveAccessibleName('Add #12AB34');
    fireEvent.click(customColorAction(dialog));
    await waitFor(() => expect(executeMock()).toHaveBeenCalledWith({
      type: 'palette-create',
      name: '#12AB34',
      color: '#12AB34',
    }));
    await waitFor(() => expect(f.c.selectCreatedPalette).toHaveBeenCalledWith(2));
    expect(screen.queryByRole('dialog', { name: 'Add a thread color' })).not.toBeInTheDocument();
  });
  it('ignores inactive matches and follows the creation path', async () => {
    const inactiveDocument = customColorDocument([
      { id: 1, name: 'Inactive custom', color: '#12AB34', active: false },
    ]);
    const createdDocument = customColorDocument([
      { id: 1, name: 'Inactive custom', color: '#12AB34', active: false },
      { id: 2, name: '#12AB34', color: '#12AB34', active: true },
    ]);
    executeMock().mockResolvedValueOnce({ document: createdDocument });
    render(<EditorSurface workspace={ws} document={inactiveDocument} />);
    const dialog = openCustomColorDialog();
    fireEvent.change(within(dialog).getByLabelText('Hex color'), { target: { value: '#12ab34' } });
    expect(customColorAction(dialog)).toHaveAccessibleName('Add #12AB34');
    fireEvent.click(customColorAction(dialog));
    await waitFor(() => expect(executeMock()).toHaveBeenCalledWith({
      type: 'palette-create',
      name: '#12AB34',
      color: '#12AB34',
    }));
    expect(f.c.selectPalette).not.toHaveBeenCalled();
    await waitFor(() => expect(f.c.selectCreatedPalette).toHaveBeenCalledWith(2));
    expect(screen.queryByRole('dialog', { name: 'Add a thread color' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('keeps the dialog open and shows the rejection when custom creation fails', async () => {
    (ws as { execute: ReturnType<typeof vi.fn> }).execute.mockRejectedValueOnce(new Error('Custom color rejected'));
    render(<EditorSurface workspace={ws} document={doc} />);
    const dialog = openCustomColorDialog();
    fireEvent.change(within(dialog).getByLabelText('Hex color'), { target: { value: '#12ab34' } });
    fireEvent.click(customColorAction(dialog));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Custom color rejected'));
    expect(screen.getByRole('dialog', { name: 'Add a thread color' })).toBeInTheDocument();
  });
  it('resets custom input and action state when the catalog dialog reopens', () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    fireEvent.click(screen.getByRole('button', { name: /Add new color/ }));
    const firstDialog = screen.getByRole('dialog', { name: 'Add a thread color' });
    fireEvent.change(within(firstDialog).getByLabelText('Hex color'), { target: { value: '#c72b3b' } });
    fireEvent.click(within(firstDialog).getByRole('button', { name: 'Close catalog dialog' }));
    fireEvent.click(screen.getByRole('button', { name: /Add new color/ }));
    const reopened = screen.getByRole('dialog', { name: 'Add a thread color' });
    expect(within(reopened).getByLabelText('Hex color')).toHaveValue('#000000');
    expect(within(reopened).getByRole('button', { name: 'Add #000000' })).toBeEnabled();
  }, 15000);
  it('shows a clear empty state when no thread colors match', () => { render(<EditorSurface workspace={ws} document={doc} />); fireEvent.click(screen.getByRole('button', { name: /Add new color/ })); fireEvent.change(screen.getByLabelText('Search DMC catalog'), { target: { value: 'not-a-real-thread-color' } }); expect(screen.getByText('No matching colors.')).toBeInTheDocument(); expect(within(screen.getByRole('list', { name: 'Available thread colors' })).queryAllByRole('button')).toHaveLength(0); });
  it('keeps query 31 results limited to catalog matches', async () => { render(<EditorSurface workspace={ws} document={doc} />); fireEvent.click(screen.getByRole('button', { name: /Add new color/ })); const grid = screen.getByRole('list', { name: 'Available thread colors' }); fireEvent.change(screen.getByLabelText('Search DMC catalog'), { target: { value: '31' } }); await waitFor(() => expect(within(grid).getAllByRole('button').length).toBeGreaterThan(0)); for (const button of within(grid).getAllByRole('button')) { const label = button.getAttribute('aria-label') ?? ''; const code = label.split(', color ')[1] ?? ''; const record = DEFAULT_CATALOG_DEFINITION.records.find((entry) => entry.code === code); expect(record).toBeDefined(); expect([record?.code ?? '', record?.name ?? '', record?.hex ?? '', record?.sourceId ?? ''].some((field) => field.toLowerCase().includes('31'))).toBe(true); } expect(within(grid).queryByRole('button', { name: /Snow White/ })).not.toBeInTheDocument(); });
  it('never applies the palette-pending class to a palette button', () => { render(<EditorSurface workspace={ws} document={two} />); expect(screen.getByRole('button', { name: '321Ruby' })).not.toHaveClass('palette-pending'); expect(screen.getByRole('button', { name: 'Sky' })).not.toHaveClass('palette-pending'); });
  it('renders the palette roster in palette order regardless of reference status', () => { render(<EditorSurface workspace={ws} document={two} />); const ruby = screen.getByRole('button', { name: '321Ruby' }); const sky = screen.getByRole('button', { name: 'Sky' }); expect(ruby.compareDocumentPosition(sky) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); });
  it('keeps the palette add action and swatches together in the palette rail', () => { render(<EditorSurface workspace={ws} document={two} />); const rail = screen.getByRole('complementary', { name: 'Editor controls' }); const dock = screen.getByRole('region', { name: 'Thread colors' }); const add = screen.getByRole('button', { name: /Add new color/ }); const sky = screen.getByRole('button', { name: 'Sky' }); const ruby = screen.getByRole('button', { name: '321Ruby' }); expect(rail).toContainElement(dock); expect(dock).toHaveClass('palette-rail'); expect(dock).toContainElement(add); expect(dock).toContainElement(sky); expect(dock).toContainElement(ruby); });
  it('shows a normalized custom hex label in the palette rail', () => {
    render(<EditorSurface workspace={ws} document={customColorDocument([{ id: 2, name: 'Custom Ruby', color: '#12AB34', active: true }])} />);
    const number = screen.getByText('#12AB34', { selector: '.palette-number' });
    expect(number).toHaveClass('palette-number-hex');
  });
  it('shows a normalized custom hex label in the palette details menu', () => {
    render(<EditorSurface workspace={ws} document={customColorDocument([{ id: 2, name: 'Custom Ruby', color: '#12AB34', active: true }])} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Custom Ruby' }), { key: 'ContextMenu' });
    const menu = screen.getByRole('menu', { name: 'Details for Custom Ruby' });
    expect(menu).toHaveTextContent('#12AB34');
  });
  it('opens a color details menu from the accessible context-menu key', () => {
    render(<EditorSurface workspace={ws} document={paletteDetailsDoc} />);
    const color = screen.getByRole('button', { name: '321Ruby' });
    fireEvent.keyDown(color, { key: 'ContextMenu' });
    const menu = screen.getByRole('menu', { name: 'Details for Ruby' });
    expect(menu).toHaveTextContent('Ruby');
    expect(menu).toHaveTextContent('321');
    expect(menu).toHaveTextContent('Symbol ✦');
    expect(within(menu).getByRole('menuitem', { name: 'Delete color' })).toBeInTheDocument();
  });
  it('opens the color details menu after a 500ms press without selecting the color', () => {
    vi.useFakeTimers();
    try {
      render(<EditorSurface workspace={ws} document={paletteDetailsDoc} />);
      const color = screen.getByRole('button', { name: '321Ruby' });
      fireEvent.pointerDown(color);
      act(() => { vi.advanceTimersByTime(499); });
      expect(screen.queryByRole('menu', { name: 'Details for Ruby' })).not.toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(1); });
      expect(screen.getByRole('menu', { name: 'Details for Ruby' })).toBeInTheDocument();
      fireEvent.pointerUp(color);
      fireEvent.click(color);
      expect(f.c.selectPalette).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it('shows the remove button for an unreferenced palette color', () => { render(<EditorSurface workspace={ws} document={doc} />); expect(screen.getByRole('button', { name: 'Remove Ruby' })).toHaveAttribute('title', 'Remove or replace this color'); });
  it('shows swap and delete menu items for an unreferenced palette color', () => { render(<EditorSurface workspace={ws} document={doc} />); const swatch = document.querySelector<HTMLButtonElement>('.palette-button')!; fireEvent.contextMenu(swatch); const menu = screen.getByRole('menu', { name: 'Details for Ruby' }); expect(within(menu).getByRole('menuitem', { name: 'Swap color' })).toBeInTheDocument(); expect(within(menu).getByRole('menuitem', { name: 'Delete color' })).toBeInTheDocument(); });
  it('opens the remove dialog and shows the no-candidates note for a single color', () => { render(<EditorSurface workspace={ws} document={doc} />); fireEvent.click(screen.getByRole('button', { name: 'Remove Ruby' })); expect(screen.getByRole('dialog', { name: 'Remove Ruby' })).toBeInTheDocument(); expect(screen.getByText('No other active palette colors yet. Add one, or search the DMC catalog below.')).toBeInTheDocument(); });
  it('replaces the removed color with an existing palette color', () => { render(<EditorSurface workspace={ws} document={two} />); fireEvent.click(screen.getByRole('button', { name: 'Remove Ruby' })); fireEvent.click(screen.getByRole('button', { name: 'Replace with Sky' })); expect((ws as { execute: ReturnType<typeof vi.fn> }).execute).toHaveBeenCalledWith(expect.objectContaining({ type: 'palette-merge', from: 1, to: 2 })); expect(f.c.selectPalette).toHaveBeenCalledWith(2); expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); });
  it('replaces the removed color with a catalog color', () => { const match = DEFAULT_CATALOG_DEFINITION.search('salmon')[0]; const merged = { width: 16, height: 16, colors: new Uint16Array(1024), palette: [{ id: 1, name: 'Ruby', color: '#b44', active: true, catalog: { code: '321', name: 'Ruby', hex: '#b44', rgb: [0, 0, 0], catalogId: 'dmc-compatible-screen-approximation', sourceId: 'x' } }, { id: 2, name: match.name, color: match.hex, active: true, catalog: { catalogId: 'dmc-compatible-screen-approximation', sourceId: match.sourceId, code: match.code, name: match.name, hex: match.hex, rgb: [...match.rgb] } }], backstitches: { ids: new Uint32Array() } } as never; (ws as { execute: ReturnType<typeof vi.fn> }).execute.mockReturnValue({}); (ws as { getStateSnapshot: ReturnType<typeof vi.fn> }).getStateSnapshot.mockReturnValue({ document: merged }); render(<EditorSurface workspace={ws} document={doc} />); fireEvent.click(screen.getByRole('button', { name: 'Remove Ruby' })); fireEvent.change(screen.getByLabelText('Search DMC catalog for a replacement'), { target: { value: 'salmon' } }); fireEvent.click(screen.getByRole('button', { name: `Replace with ${match.name} from DMC` })); expect((ws as { execute: ReturnType<typeof vi.fn> }).execute).toHaveBeenCalledWith(expect.objectContaining({ type: 'palette-merge', from: 1, createTo: expect.objectContaining({ name: match.name, color: match.hex }) })); expect(f.c.selectPalette).toHaveBeenCalledWith(2); });
  it('keeps the dialog open and reports a failed replacement', () => { (ws as { execute: ReturnType<typeof vi.fn> }).execute.mockImplementationOnce(() => { throw new Error('boom'); }); render(<EditorSurface workspace={ws} document={two} />); fireEvent.click(screen.getByRole('button', { name: 'Remove Ruby' })); fireEvent.click(screen.getByRole('button', { name: 'Replace with Sky' })); expect(screen.getByRole('dialog', { name: 'Remove Ruby' })).toBeInTheDocument(); expect(screen.getByRole('alert')).toHaveTextContent('boom'); });
  it('closes the remove dialog on Escape', () => { render(<EditorSurface workspace={ws} document={doc} />); fireEvent.click(screen.getByRole('button', { name: 'Remove Ruby' })); fireEvent.keyDown(screen.getByRole('dialog', { name: 'Remove Ruby' }), { key: 'Escape' }); expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); });
  it('portals the details dialog outside the application root and closes it from the backdrop', async () => { const shell = document.createElement('div'); shell.dataset.application = ''; document.body.append(shell); render(<EditorSurface workspace={ws} document={doc} />); fireEvent.click(screen.getByRole('button', { name: 'Open settings' })); const dialog = screen.getByRole('dialog', { name: 'Settings' }); expect(dialog.closest('[data-application]')).toBeNull(); expect(shell).toHaveProperty('inert', true); fireEvent.click(dialog); expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument(); fireEvent.click(dialog.closest('.modal-backdrop') as HTMLElement); await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument()); expect(shell).toHaveProperty('inert', false); shell.remove(); });
  it('portals the add-color dialog outside the application root and closes it from the backdrop', async () => { const shell = document.createElement('div'); shell.dataset.application = ''; document.body.append(shell); render(<EditorSurface workspace={ws} document={doc} />); fireEvent.click(screen.getByRole('button', { name: /Add new color/ })); const dialog = screen.getByRole('dialog', { name: 'Add a thread color' }); expect(dialog.closest('[data-application]')).toBeNull(); expect(shell).toHaveProperty('inert', true); fireEvent.click(dialog); expect(screen.getByRole('dialog', { name: 'Add a thread color' })).toBeInTheDocument(); fireEvent.click(dialog.closest('.modal-backdrop') as HTMLElement); await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument()); expect(shell).toHaveProperty('inert', false); shell.remove(); });
  it('portals the remove dialog outside the application root and closes it from the backdrop', async () => { const shell = document.createElement('div'); shell.dataset.application = ''; document.body.append(shell); render(<EditorSurface workspace={ws} document={doc} />); fireEvent.click(screen.getByRole('button', { name: 'Remove Ruby' })); const dialog = screen.getByRole('dialog', { name: 'Remove Ruby' }); expect(dialog.closest('[data-application]')).toBeNull(); expect(shell).toHaveProperty('inert', true); fireEvent.click(dialog); expect(screen.getByRole('dialog', { name: 'Remove Ruby' })).toBeInTheDocument(); fireEvent.click(dialog.closest('.modal-backdrop') as HTMLElement); await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument()); expect(shell).toHaveProperty('inert', false); shell.remove(); });
  it('disables the reference image tools without a reference image', () => { render(<EditorSurface workspace={ws} document={doc} />); expect(screen.getByRole('button', { name: 'Move image' })).toBeDisabled(); expect(screen.getByRole('button', { name: 'Resize image' })).toBeDisabled(); expect(screen.getByRole('checkbox', { name: 'Show image' })).toBeDisabled(); });
  it('activates Move image from the compact reference toolbar', async () => { (ws as { sourceImage: unknown }).sourceImage = { assetId: 'trace', mimeType: 'image/png', width: 2, height: 2, crop: { x: 0, y: 0, width: 1, height: 1 }, chartBounds: { x: 0, y: 0, width: 2, height: 2 }, traceVisible: true, opacity: 1 }; (ws as { getAsset: ReturnType<typeof vi.fn> }).getAsset.mockReturnValue({ id: 'trace', name: 'trace.png', mimeType: 'image/png', data: new Uint8Array([1]), checksum: '0'.repeat(64) }); f.uiState.tool = { tool: 'move-image' }; render(<EditorSurface workspace={ws} document={doc} />); const actionRow = document.querySelector('.canvas-actions') as HTMLElement; const toolbar = within(actionRow).getByRole('toolbar', { name: 'Reference image' }); const button = within(toolbar).getByRole('button', { name: 'Move image' }); expect(button).toHaveAttribute('aria-pressed', 'true'); expect(within(toolbar).getByRole('button', { name: 'Resize image' })).toHaveAttribute('aria-pressed', 'false'); expect(button.closest('[role="toolbar"]')).toBe(toolbar); fireEvent.click(button); expect(f.c.setTool).toHaveBeenCalledWith(expect.objectContaining({ tool: 'move-image' })); await waitFor(() => expect(f.c.setTraceImage).toHaveBeenCalled()); });
  it('keeps a persisted visible reference image attached in the canvas action row', async () => {
    (ws as { sourceImage: unknown }).sourceImage = { assetId: 'trace', mimeType: 'image/png', width: 2, height: 2, crop: { x: 0, y: 0, width: 1, height: 1 }, chartBounds: { x: 0, y: 0, width: 2, height: 2 }, traceVisible: true, opacity: 1 };
    (ws as { getAsset: ReturnType<typeof vi.fn> }).getAsset.mockReturnValue({ id: 'trace', name: 'trace.png', mimeType: 'image/png', data: new Uint8Array([1]), checksum: '0'.repeat(64) });
    render(<EditorSurface workspace={ws} document={doc} />);
    await waitFor(() => expect(f.c.setTraceImage).toHaveBeenCalledWith(expect.objectContaining({ visible: true })));
    const attached = f.c.setTraceImage.mock.calls.length;
    const actionRow = document.querySelector('.canvas-actions') as HTMLElement;
    const toolbar = within(actionRow).getByRole('toolbar', { name: 'Reference image' });
    expect(toolbar).toBeInTheDocument();
    expect(within(toolbar).getByRole('checkbox', { name: 'Show image' })).toBeChecked();
    expect(screen.queryByRole('button', { name: 'View settings' })).not.toBeInTheDocument();
    expect(f.c.clearTraceImage).not.toHaveBeenCalled();
    expect(f.c.setTraceImage).toHaveBeenCalledTimes(attached);
    expect(within(toolbar).getByRole('checkbox', { name: 'Show image' })).toBeChecked();
  });

  it('keeps a hidden reference image hidden after the canvas action changes it', async () => {
    (ws as { sourceImage: unknown }).sourceImage = { assetId: 'trace', mimeType: 'image/png', width: 2, height: 2, crop: { x: 0, y: 0, width: 1, height: 1 }, chartBounds: { x: 0, y: 0, width: 2, height: 2 }, traceVisible: true, opacity: 1 };
    (ws as { getAsset: ReturnType<typeof vi.fn> }).getAsset.mockReturnValue({ id: 'trace', name: 'trace.png', mimeType: 'image/png', data: new Uint8Array([1]), checksum: '0'.repeat(64) });
    const applyTraceImageChange = (ws as { applyTraceImageChange: ReturnType<typeof vi.fn> }).applyTraceImageChange;
    applyTraceImageChange.mockImplementation(async (next: unknown) => { (ws as { sourceImage: unknown }).sourceImage = next; });
    render(<EditorSurface workspace={ws} document={doc} />);
    await waitFor(() => expect(f.c.setTraceImage).toHaveBeenCalled());
    const toolbar = screen.getByRole('toolbar', { name: 'Reference image' });
    const toggle = within(toolbar).getByRole('checkbox', { name: 'Show image' });
    fireEvent.click(toggle);
    await waitFor(() => expect(applyTraceImageChange).toHaveBeenCalledWith(expect.objectContaining({ traceVisible: false }), expect.objectContaining({ label: 'trace-image-visibility' })));
    expect(toggle).not.toBeChecked();
    expect(f.c.clearTraceImage).not.toHaveBeenCalled();
    expect(within(toolbar).getByRole('checkbox', { name: 'Show image' })).not.toBeChecked();
  });

  it('sanitizes fractional bounds by rounding without clamping to the pattern', async () => {
    const draft = { source: {}, width: 2, height: 2, chartBounds: { x: -2.6, y: 2.6, width: 3.2, height: 3.8 } };
    (f.c as { getTraceImage: ReturnType<typeof vi.fn> }).getTraceImage.mockReturnValue(draft);
    (f.c as { setTraceImage: ReturnType<typeof vi.fn> }).setTraceImage.mockImplementation((next: unknown) => { (f.c as { getTraceImage: ReturnType<typeof vi.fn> }).getTraceImage.mockReturnValue(next); });
    (ws as { sourceImage: unknown }).sourceImage = { assetId: 'trace', mimeType: 'image/png', width: 2, height: 2, crop: { x: 0, y: 0, width: 1, height: 1 }, chartBounds: { x: -2.6, y: 2.6, width: 3.2, height: 3.8 }, traceVisible: true, opacity: 1 };
    render(<EditorSurface workspace={ws} document={doc} />);
    f.capturedCallback?.({ x: -2.6, y: 2.6, width: 3.2, height: 3.8 });
    await waitFor(() => expect((ws as { applyTraceImageChange: ReturnType<typeof vi.fn> }).applyTraceImageChange).toHaveBeenCalled());
    // Negative x is preserved (unbounded placement); only rounding is applied.
    expect((ws as { applyTraceImageChange: ReturnType<typeof vi.fn> }).applyTraceImageChange).toHaveBeenCalledWith(expect.objectContaining({ chartBounds: { x: -3, y: 3, width: 3, height: 4 } }), expect.objectContaining({ label: 'trace-image-bounds' }));
    expect(f.c.setTraceImage).toHaveBeenCalledWith(expect.objectContaining({ chartBounds: { x: -3, y: 3, width: 3, height: 4 } }));
  });
  it('keeps grid state internal and removes the grid toggle from the action row', () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    expect(screen.queryByRole('checkbox', { name: 'Show grid' })).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'View settings' })).toBeInTheDocument();
  });
  it('activates Resize image from the compact reference toolbar', async () => { (ws as { sourceImage: unknown }).sourceImage = { assetId: 'trace', mimeType: 'image/png', width: 2, height: 2, crop: { x: 0, y: 0, width: 1, height: 1 }, chartBounds: { x: 0, y: 0, width: 2, height: 2 }, traceVisible: true, opacity: 1 }; (ws as { getAsset: ReturnType<typeof vi.fn> }).getAsset.mockReturnValue({ id: 'trace', name: 'trace.png', mimeType: 'image/png', data: new Uint8Array([1]), checksum: '0'.repeat(64) }); f.uiState.tool = { tool: 'resize-image' }; render(<EditorSurface workspace={ws} document={doc} />); const toolbar = screen.getByRole('toolbar', { name: 'Reference image' }); const button = within(toolbar).getByRole('button', { name: 'Resize image' }); expect(button).toHaveAttribute('aria-pressed', 'true'); expect(within(toolbar).getByRole('button', { name: 'Move image' })).toHaveAttribute('aria-pressed', 'false'); fireEvent.click(button); expect(f.c.setTool).toHaveBeenCalledWith(expect.objectContaining({ tool: 'resize-image' })); await waitFor(() => expect(f.c.setTraceImage).toHaveBeenCalled()); });
  it('opens the symbol picker from a palette chip and assigns a free symbol', async () => {
    const palette = [{ id: 1, name: 'Ruby', color: '#b44', active: true, symbol: '●' }, { id: 2, name: 'Sky', color: '#48c', active: true, symbol: '■' }];
    const symDoc = { width: 16, height: 16, colors: new Uint16Array(1024), palette, backstitches: { ids: new Uint32Array() } } as never;
    render(<EditorSurface workspace={ws} document={symDoc} />);
    const chip = screen.getByRole('button', { name: 'Change symbol for Ruby' });
    expect(chip).toHaveTextContent('●');
    fireEvent.click(chip);
    expect(screen.getByRole('dialog', { name: 'Symbol for Ruby' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Assign / })).toHaveLength(expectedTiles(palette, 1));
    expect(screen.queryByRole('button', { name: 'Assign ■ to Ruby' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Assign ▲ to Ruby' }));
    expect((ws as { execute: ReturnType<typeof vi.fn> }).execute).toHaveBeenCalledWith({ type: 'palette-update', id: 1, symbol: '▲' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(chip));
  });
  it('renders every reachable symbol as one continuous grid without held tiles, categories, or pagination', () => {
    const palette = [{ id: 1, name: 'Ruby', color: '#b44', active: true, symbol: '●' }, { id: 2, name: 'Sky', color: '#48c', active: true, symbol: '■' }];
    const symDoc = { width: 16, height: 16, colors: new Uint16Array(1024), palette, backstitches: { ids: new Uint32Array() } } as never;
    render(<EditorSurface workspace={ws} document={symDoc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change symbol for Ruby' }));
    const dialog = screen.getByRole('dialog', { name: 'Symbol for Ruby' });
    expect(within(dialog).getAllByRole('button', { name: /Assign / })).toHaveLength(expectedTiles(palette, 1));
    expect(within(dialog).queryByRole('button', { name: /^Show all / })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('heading', { level: 3 })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('group')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Assign ● to Ruby' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).getByRole('button', { name: 'Assign ▲ to Ruby' })).toHaveAttribute('aria-pressed', 'false');
  });
  it('hides symbols assigned to other colors and keeps only the open color’s own symbol selected', () => {
    const palette = [{ id: 1, name: 'Ruby', color: '#b44', active: true, symbol: '●' }, { id: 2, name: 'Sky', color: '#48c', active: true, symbol: '■' }, { id: 3, name: 'Sea', color: '#38a', active: true, symbol: '♡' }];
    const symDoc = { width: 16, height: 16, colors: new Uint16Array(1024), palette, backstitches: { ids: new Uint32Array() } } as never;
    render(<EditorSurface workspace={ws} document={symDoc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change symbol for Ruby' }));
    const dialog = screen.getByRole('dialog', { name: 'Symbol for Ruby' });
    expect(within(dialog).getByRole('button', { name: 'Assign ● to Ruby' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).queryByRole('button', { name: 'Assign ■ to Ruby' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Assign ♡ to Ruby' })).not.toBeInTheDocument();
    expect(within(dialog).getAllByRole('button', { name: /Assign / })).toHaveLength(expectedTiles(palette, 1));
  });
  it('closes the symbol picker on Escape and backdrop click with focus restore', async () => {
    const symDoc = { width: 16, height: 16, colors: new Uint16Array(1024), palette: [{ id: 1, name: 'Ruby', color: '#b44', active: true, symbol: '●' }], backstitches: { ids: new Uint32Array() } } as never;
    render(<EditorSurface workspace={ws} document={symDoc} />);
    const chip = screen.getByRole('button', { name: 'Change symbol for Ruby' });
    fireEvent.click(chip);
    const dialog = screen.getByRole('dialog', { name: 'Symbol for Ruby' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(chip));
    fireEvent.click(chip);
    const reopened = screen.getByRole('dialog', { name: 'Symbol for Ruby' });
    fireEvent.click(reopened.closest('.modal-backdrop') as HTMLElement);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect((ws as { execute: ReturnType<typeof vi.fn> }).execute).not.toHaveBeenCalled();
  });
  it('assigns a typed custom character through the palette-update command', async () => {
    const symDoc = { width: 16, height: 16, colors: new Uint16Array(1024), palette: [{ id: 1, name: 'Ruby', color: '#b44', active: true, symbol: '●' }, { id: 2, name: 'Sky', color: '#48c', active: true, symbol: '■' }], backstitches: { ids: new Uint32Array() } } as never;
    render(<EditorSurface workspace={ws} document={symDoc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change symbol for Ruby' }));
    const entry = screen.getByLabelText('Symbol character');
    fireEvent.change(entry, { target: { value: '⚑' } });
    expect(screen.getByRole('button', { name: 'Assign ⚑ to Ruby (custom)' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Assign ⚑ to Ruby (custom)' }));
    expect((ws as { execute: ReturnType<typeof vi.fn> }).execute).toHaveBeenCalledWith({ type: 'palette-update', id: 1, symbol: '⚑' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
  it('commits a typed custom character on Enter', async () => {
    const symDoc = { width: 16, height: 16, colors: new Uint16Array(1024), palette: [{ id: 1, name: 'Ruby', color: '#b44', active: true, symbol: '●' }, { id: 2, name: 'Sky', color: '#48c', active: true, symbol: '■' }], backstitches: { ids: new Uint32Array() } } as never;
    render(<EditorSurface workspace={ws} document={symDoc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change symbol for Ruby' }));
    const entry = screen.getByLabelText('Symbol character');
    fireEvent.change(entry, { target: { value: '♠' } });
    fireEvent.keyDown(entry, { key: 'Enter' });
    expect((ws as { execute: ReturnType<typeof vi.fn> }).execute).toHaveBeenCalledWith({ type: 'palette-update', id: 1, symbol: '♠' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
  it('rejects empty and whitespace-only custom symbols with feedback and no command', async () => {
    const symDoc = { width: 16, height: 16, colors: new Uint16Array(1024), palette: [{ id: 1, name: 'Ruby', color: '#b44', active: true, symbol: '●' }], backstitches: { ids: new Uint32Array() } } as never;
    render(<EditorSurface workspace={ws} document={symDoc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change symbol for Ruby' }));
    const entry = screen.getByLabelText('Symbol character');
    const execute = (ws as { execute: ReturnType<typeof vi.fn> }).execute;
    fireEvent.keyDown(entry, { key: 'Enter' });
    expect(screen.getByRole('alert')).toHaveTextContent('Type or paste a single non-alphanumeric character, then press Enter to assign it.');
    fireEvent.change(entry, { target: { value: '   ' } });
    fireEvent.keyDown(entry, { key: 'Enter' });
    expect(screen.getByRole('alert')).toHaveTextContent('Type or paste a single non-alphanumeric character, then press Enter to assign it.');
    expect(execute).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Symbol for Ruby' })).toBeInTheDocument();
  });
  it('rejects over-length custom symbols with feedback and no command', async () => {
    const symDoc = { width: 16, height: 16, colors: new Uint16Array(1024), palette: [{ id: 1, name: 'Ruby', color: '#b44', active: true, symbol: '●' }], backstitches: { ids: new Uint32Array() } } as never;
    render(<EditorSurface workspace={ws} document={symDoc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change symbol for Ruby' }));
    const entry = screen.getByLabelText('Symbol character');
    const execute = (ws as { execute: ReturnType<typeof vi.fn> }).execute;
    fireEvent.change(entry, { target: { value: '◐◑◒◓★' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/That's 5 UTF-16 code units/);
    expect(screen.getByRole('alert')).toHaveTextContent(/at most 4/);
    expect(screen.queryByRole('button', { name: /\(custom/ })).not.toBeInTheDocument();
    fireEvent.keyDown(entry, { key: 'Enter' });
    expect(execute).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Symbol for Ruby' })).toBeInTheDocument();
  });
  it('rejects alphanumeric custom symbols with live feedback and no command', async () => {
    const symDoc = { width: 16, height: 16, colors: new Uint16Array(1024), palette: [{ id: 1, name: 'Ruby', color: '#b44', active: true, symbol: '●' }], backstitches: { ids: new Uint32Array() } } as never;
    render(<EditorSurface workspace={ws} document={symDoc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change symbol for Ruby' }));
    const entry = screen.getByLabelText('Symbol character');
    const execute = (ws as { execute: ReturnType<typeof vi.fn> }).execute;
    fireEvent.change(entry, { target: { value: 'S3' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Palette symbols must be non-alphanumeric');
    expect(screen.queryByRole('button', { name: /\(custom/ })).not.toBeInTheDocument();
    fireEvent.keyDown(entry, { key: 'Enter' });
    expect(execute).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Symbol for Ruby' })).toBeInTheDocument();
  });
  it('routes a typed character held by another row through the swap path', async () => {
    const symDoc = { width: 16, height: 16, colors: new Uint16Array(1024), palette: [{ id: 1, name: 'Ruby', color: '#b44', active: true, symbol: '●' }, { id: 2, name: 'Sky', color: '#48c', active: true, symbol: '■' }], backstitches: { ids: new Uint32Array() } } as never;
    render(<EditorSurface workspace={ws} document={symDoc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change symbol for Ruby' }));
    const entry = screen.getByLabelText('Symbol character');
    fireEvent.change(entry, { target: { value: '■' } });
    expect(screen.getByText(/Sky already uses ■/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Assign ■ to Ruby (custom, swaps with Sky)' })).toBeInTheDocument();
    fireEvent.keyDown(entry, { key: 'Enter' });
    const execute = (ws as { execute: ReturnType<typeof vi.fn> }).execute;
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0][0]).toEqual({ type: 'palette-update', id: 2, symbol: '●' });
    expect(execute.mock.calls[1][0]).toEqual({ type: 'palette-update', id: 1, symbol: '■' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
  it('filters the symbol grid by a typed query', async () => {
    const symDoc = { width: 16, height: 16, colors: new Uint16Array(1024), palette: [{ id: 1, name: 'Ruby', color: '#b44', active: true, symbol: '●' }], backstitches: { ids: new Uint32Array() } } as never;
    render(<EditorSurface workspace={ws} document={symDoc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change symbol for Ruby' }));
    const filter = screen.getByLabelText('Filter symbols');
    fireEvent.change(filter, { target: { value: '⊕' } });
    expect(screen.getByRole('button', { name: 'Assign ⊕ to Ruby' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Assign ● to Ruby' })).not.toBeInTheDocument();
    fireEvent.change(filter, { target: { value: 'zzz' } });
    expect(screen.getByText(/No symbols match "zzz"/)).toBeInTheDocument();
  });
});
