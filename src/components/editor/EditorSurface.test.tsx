import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorSurface } from './EditorSurface';
import { searchDmcColors } from '../../catalog';
import { PALETTE_SYMBOLS } from '../../domain';

const f = vi.hoisted(() => ({
  c: { start: vi.fn(), setMetrics: vi.fn(), setDocument: vi.fn(), dispose: vi.fn(), setBrush: vi.fn(), setTool: vi.fn(), setEraserMode: vi.fn(), selectPalette: vi.fn(), selectCreatedPalette: vi.fn(), setChartMode: vi.fn(), setGridVisible: vi.fn(), setBrushSize: vi.fn(), setTouchMovementOnly: vi.fn(), deleteSelection: vi.fn(), handleKeyDown: vi.fn(() => false), getTraceImage: vi.fn(() => undefined), setTraceImage: vi.fn(), setTraceImageSettings: vi.fn(), clearTraceImage: vi.fn() },
  adapter: vi.fn(() => ({ dispose: vi.fn() })),
  r: { dispose: vi.fn() }, resize: undefined as (() => void) | undefined,
  uiState: { mode: 'color', gridVisible: true, overlay: {}, tool: { tool: 'paint' }, paletteId: 1, pendingPaletteId: null as number | null },
  capturedCallback: null as ((bounds: { x: number; y: number; width: number; height: number }) => void) | null
}));
vi.mock('../../rendering/context', () => ({ createCanvasTarget: vi.fn(() => ({ context: {} })) }));
vi.mock('../../rendering/renderer', () => ({ createCanvasRenderer: vi.fn(() => f.r) }));
vi.mock('../../rendering/trace', async () => {
  const actual = await vi.importActual<typeof import('../../rendering/trace')>('../../rendering/trace');
  return { ...actual, decodeTraceImage: vi.fn(async () => ({ source: {}, bitmap: {}, width: 2, height: 2, dispose: vi.fn() })) };
});
vi.mock('../../editor/coordinates', () => ({ getCanvasMetrics: vi.fn(() => ({ cssWidth: 640, cssHeight: 480, pixelWidth: 640, pixelHeight: 480, backingWidth: 640, backingHeight: 480, requestedDpr: 1, dpr: 1, maxDpr: 2, maxBackingPixels: 1e6 })) }));
vi.mock('../../editor', () => ({ ChartPresentationMode: { Color: 'color', Symbol: 'symbol', Grayscale: 'grayscale', Combined: 'combined' }, createUiStore: vi.fn(() => ({ getState: () => f.uiState, subscribe: vi.fn(() => () => undefined) })), createWorkspaceEditorGateway: vi.fn(() => ({ dispose: vi.fn() })), createPointerEventsAdapter: f.adapter, createEditorSurfaceController: vi.fn((options: unknown) => { f.capturedCallback = (options as { onTraceBoundsChange?: (b: { x: number; y: number; width: number; height: number }) => void }).onTraceBoundsChange ?? null; return f.c as never; }) }));
const ws = { metadata: { title: 'Sampler', notes: '', aidaCount: 14 }, updateActiveMetadata: vi.fn(), updateActiveAidaCount: vi.fn(), execute: vi.fn(), getStateSnapshot: vi.fn(), setSourceImage: vi.fn(() => Promise.resolve()), applyTraceImageChange: vi.fn(() => Promise.resolve()), getAsset: vi.fn(), sourceImage: undefined as ({ chartBounds: { x: number; y: number; width: number; height: number } } | undefined) } as never;
const doc = { width: 16, height: 16, colors: new Uint16Array(1024), palette: [{ id: 1, name: 'Ruby', color: '#b44', active: true, catalog: { code: '321', name: 'Ruby', hex: '#b44', rgb: [0, 0, 0], catalogId: 'dmc-compatible-screen-approximation', sourceId: 'x' } }], backstitches: { ids: new Uint32Array() } } as never;
const two = { width: 16, height: 16, colors: new Uint16Array(1024), palette: [{ id: 1, name: 'Ruby', color: '#b44', active: true, catalog: { code: '321' } }, { id: 2, name: 'Sky', color: '#48c', active: true }], backstitches: { ids: new Uint32Array() } } as never;
const paletteDetailsDoc = { width: 16, height: 16, colors: new Uint16Array(1024), palette: [{ id: 1, name: 'Ruby', color: '#b44', active: true, symbol: '✦', catalog: { code: '321', name: 'Ruby', hex: '#b44', rgb: [0, 0, 0], catalogId: 'dmc-compatible-screen-approximation', sourceId: 'x' } }], backstitches: { ids: new Uint32Array() } } as never;
// Mirrors the picker's render predicate: every pool symbol except those held by
// another palette entry (the open entry's own symbol is always kept). Computed by
// value so pool reordering or enrichment never hardcodes glyphs or indices.
const expectedTiles = (palette: { id: number; symbol: string }[], openId: number) => {
  const open = palette.find((e) => e.id === openId);
  if (!open) return 0;
  const held = new Set(palette.filter((e) => e.id !== openId).map((e) => e.symbol));
  return PALETTE_SYMBOLS.filter((s) => s === open.symbol || !held.has(s)).length;
};
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); f.uiState.pendingPaletteId = null; f.uiState.tool = { tool: 'paint' }; f.uiState.gridVisible = true; (ws as { sourceImage: unknown }).sourceImage = undefined; vi.stubGlobal('ResizeObserver', vi.fn(function (cb: () => void) { f.resize = cb; return { observe: vi.fn(), disconnect: vi.fn() }; })); });
afterEach(() => { vi.useRealTimers(); localStorage.clear(); });

describe('EditorSurface', () => {
  it('preserves UI state when the document changes', () => {
    const view = render(<EditorSurface workspace={ws} document={doc} />);
    fireEvent.change(screen.getByRole('slider', { name: /Brush size/ }), { target: { value: '7' } });
    const next = { width: 20, height: 16, colors: new Uint16Array(1024), palette: [{ id: 1, name: 'Ruby', color: '#b44', active: true }], backstitches: { ids: new Uint32Array() } } as never;
    view.rerender(<EditorSurface workspace={ws} document={next} />);
    expect(f.c.start).toHaveBeenCalledOnce(); expect(f.c.dispose).not.toHaveBeenCalled(); expect(f.c.setDocument).toHaveBeenCalledWith(next, expect.objectContaining({ reason: 'external-document' }));
    expect(screen.getByText(/20 × 16 stitches/)).toBeInTheDocument(); expect(screen.getByRole('slider', { name: /Brush size/ })).toHaveValue('7');
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
    const red = searchDmcColors('321')[0];
    const createdDocument = {
      width: 16,
      height: 16,
      colors: new Uint16Array(1024),
      palette: [
        { id: 1, name: 'Ruby', color: '#b44', active: true, catalog: { code: '321' } },
        { id: 2, name: red.name, color: red.hex, active: true, catalog: { code: red.code } }
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

    fireEvent.change(within(addDialog).getByLabelText('Search offline catalog'), { target: { value: '321' } });
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
  it('wires the top-level stitch tools and relocated brush size control', () => { render(<EditorSurface workspace={ws} document={doc} />); f.resize?.(); expect(f.c.setMetrics).toHaveBeenCalled(); const brushSettings = screen.getByRole('heading', { name: 'Brush settings' }).parentElement as HTMLElement; const size = within(brushSettings).getByRole('slider', { name: /Brush size/ }); fireEvent.change(size, { target: { value: '7' } }); expect(f.c.setBrushSize).toHaveBeenCalledWith(7); fireEvent.click(screen.getByRole('button', { name: 'Full stitch' })); expect(f.c.setBrush).toHaveBeenCalledWith({ kind: 'full', paletteId: 1 }); fireEvent.click(screen.getByRole('button', { name: 'Half stitch' })); expect(f.c.setBrush).toHaveBeenCalledWith({ kind: 'half', paletteId: 1 }); fireEvent.click(screen.getByRole('button', { name: '3/4 stitch' })); expect(f.c.setBrush).toHaveBeenCalledWith({ kind: 'three-quarter', paletteId: 1 }); expect(screen.queryByRole('button', { name: 'Stitch' })).not.toBeInTheDocument(); });
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
    expect(screen.getByRole('slider', { name: /Brush size/ })).toBeInTheDocument();
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
    const brush = screen.getByRole('heading', { name: 'Brush settings' });
    expect(brush).toBeInTheDocument();
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
  it('renders settings sections, immediate rail placement, and delete controls', () => { render(<EditorSurface workspace={ws} document={doc} />); expect(screen.getByRole('button', { name: 'Delete selection' })).toBeDisabled(); expect(screen.queryByRole('button', { name: /Move controls/ })).not.toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: 'Open settings' })); expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument(); expect(screen.getByRole('heading', { name: 'Project' })).toBeInTheDocument(); expect(screen.getByRole('heading', { name: 'Editor' })).toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: 'Right' })); expect(screen.getByRole('button', { name: 'Right' })).toHaveAttribute('aria-pressed', 'true'); expect(screen.getByRole('button', { name: 'Left' })).toHaveAttribute('aria-pressed', 'false'); expect(document.querySelector('.editor-layout')).toHaveClass('rail-right'); fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }); expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); });
  it('hydrates global editor preferences across workspace changes', () => {
    localStorage.setItem('needlewise-editor-preferences:v1', JSON.stringify({ version: 1, railSide: 'right', paletteDisplay: { symbols: false, numbers: false } }));
    const view = render(<EditorSurface workspace={ws} document={doc} />);
    expect(document.querySelector('.editor-layout')).toHaveClass('rail-right');
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    let settings = screen.getByRole('dialog', { name: 'Settings' });
    expect(within(settings).getByRole('button', { name: 'Right' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(settings).getByRole('checkbox', { name: 'Show palette symbols' })).not.toBeChecked();
    expect(within(settings).getByRole('checkbox', { name: 'Show palette numbers' })).not.toBeChecked();
    view.unmount();

    const otherWorkspace = { ...(ws as unknown as { metadata: Record<string, unknown> }), metadata: { ...(ws as unknown as { metadata: Record<string, unknown> }).metadata, id: 'different-project' } } as never;
    render(<EditorSurface workspace={otherWorkspace} document={doc} />);
    expect(document.querySelector('.editor-layout')).toHaveClass('rail-right');
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    settings = screen.getByRole('dialog', { name: 'Settings' });
    expect(within(settings).getByRole('button', { name: 'Right' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(settings).getByRole('checkbox', { name: 'Show palette symbols' })).not.toBeChecked();
    expect(within(settings).getByRole('checkbox', { name: 'Show palette numbers' })).not.toBeChecked();
  });
  it('writes the complete global editor preferences envelope immediately', async () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
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
    expect(within(settings).getByRole('button', { name: 'Left' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(settings).getByRole('checkbox', { name: 'Show palette symbols' })).toBeChecked();
    expect(within(settings).getByRole('checkbox', { name: 'Show palette numbers' })).toBeChecked();
  });
  it('migrates legacy palette display preferences into the global envelope', async () => {
    localStorage.setItem('needlewise-editor-palette:default', JSON.stringify({ symbols: false, numbers: true }));
    render(<EditorSurface workspace={ws} document={doc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    const settings = screen.getByRole('dialog', { name: 'Settings' });
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
    expect(within(screen.getByRole('dialog', { name: 'Settings' })).getByRole('checkbox', { name: 'Enable pencil mode' })).toBeChecked();
    expect(f.c.setTouchMovementOnly).toHaveBeenCalledWith(true);
    await waitFor(() => expect(JSON.parse(localStorage.getItem('needlewise-editor-preferences:v1') ?? 'null')).toEqual({ version: 1, railSide: 'left', paletteDisplay: { symbols: true, numbers: true }, pencilModeEnabled: true }));
  });
  it('provides an accessible pencil mode tooltip trigger', () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    const settings = screen.getByRole('dialog', { name: 'Settings' });
    const info = within(settings).getByRole('button', { name: 'Pencil mode information' });
    const tooltip = within(settings).getByRole('tooltip');
    expect(info).toHaveAttribute('aria-describedby', 'pencil-mode-tooltip');
    expect(tooltip).toHaveTextContent(/finger touch for movement controls while a pen or stylus can draw/);
    expect(info).toHaveAttribute('type', 'button');
  });
  it('independently toggles the palette symbol and number settings', () => {
    render(<EditorSurface workspace={ws} document={doc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    const settings = screen.getByRole('dialog', { name: 'Settings' });
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
  it('filters the thread-color grid, selects a swatch, and adds the summary color', () => { render(<EditorSurface workspace={ws} document={doc} />); fireEvent.click(screen.getByRole('button', { name: /Add new color/ })); const grid = screen.getByRole('list', { name: 'Available thread colors' }); expect(within(grid).getAllByRole('button').length).toBeGreaterThan(8); fireEvent.change(screen.getByLabelText('Search offline catalog'), { target: { value: '321' } }); const red = within(grid).getByRole('button', { name: /Red, color 321/ }); expect(within(grid).getAllByRole('button')).toHaveLength(1); expect(within(grid).queryByText('Red')).not.toBeInTheDocument(); expect(within(grid).queryByText('#321')).not.toBeInTheDocument(); fireEvent.click(red); expect(red).toHaveAttribute('aria-pressed', 'true'); expect(screen.getByRole('button', { name: 'Add Red' })).toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: 'Add Red' })); expect((ws as { execute: ReturnType<typeof vi.fn> }).execute).toHaveBeenCalledWith(expect.objectContaining({ type: 'palette-create', name: 'Red', color: '#C72B3B' })); });
  it('shows a clear empty state when no thread colors match', () => { render(<EditorSurface workspace={ws} document={doc} />); fireEvent.click(screen.getByRole('button', { name: /Add new color/ })); fireEvent.change(screen.getByLabelText('Search offline catalog'), { target: { value: 'not-a-real-thread-color' } }); expect(screen.getByText('No matching colors.')).toBeInTheDocument(); expect(within(screen.getByRole('list', { name: 'Available thread colors' })).queryAllByRole('button')).toHaveLength(0); });
  it('keeps query 31 results limited to matching names or codes', async () => { render(<EditorSurface workspace={ws} document={doc} />); fireEvent.click(screen.getByRole('button', { name: /Add new color/ })); const grid = screen.getByRole('list', { name: 'Available thread colors' }); fireEvent.change(screen.getByLabelText('Search offline catalog'), { target: { value: '31' } }); await waitFor(() => expect(within(grid).getAllByRole('button').length).toBeGreaterThan(0)); for (const button of within(grid).getAllByRole('button')) { const label = button.getAttribute('aria-label') ?? ''; const [name, code] = label.split(', color '); expect(name?.toLowerCase().includes('31') || code?.includes('31')).toBe(true); } expect(within(grid).queryByRole('button', { name: /Bright Red/ })).not.toBeInTheDocument(); });
  it('marks the pending palette color and clears it when not pending', () => { f.uiState.pendingPaletteId = 1; const first = render(<EditorSurface workspace={ws} document={doc} />); expect(screen.getByRole('button', { name: '321Ruby' })).toHaveClass('palette-pending'); first.unmount(); f.uiState.pendingPaletteId = null; render(<EditorSurface workspace={ws} document={doc} />); expect(screen.getByRole('button', { name: '321Ruby' })).not.toHaveClass('palette-pending'); });
  it('orders the pending palette color first in the palette roster', () => { f.uiState.pendingPaletteId = 2; render(<EditorSurface workspace={ws} document={two} />); const sky = screen.getByRole('button', { name: 'Sky' }); const ruby = screen.getByRole('button', { name: '321Ruby' }); expect(sky).toHaveClass('palette-pending'); expect(sky.compareDocumentPosition(ruby) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); });
  it('keeps the palette add action and swatches together in the palette rail', () => { f.uiState.pendingPaletteId = 2; render(<EditorSurface workspace={ws} document={two} />); const rail = screen.getByRole('complementary', { name: 'Editor controls' }); const dock = screen.getByRole('region', { name: 'Thread colors' }); const add = screen.getByRole('button', { name: /Add new color/ }); const sky = screen.getByRole('button', { name: 'Sky' }); const ruby = screen.getByRole('button', { name: '321Ruby' }); expect(rail).toContainElement(dock); expect(dock).toHaveClass('palette-rail'); expect(dock).toContainElement(add); expect(dock).toContainElement(sky); expect(dock).toContainElement(ruby); });
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
  it('hides the remove button on pending unreferenced rows and shows it once referenced or settled', () => { f.uiState.pendingPaletteId = 1; const pending = render(<EditorSurface workspace={ws} document={doc} />); expect(screen.queryByRole('button', { name: 'Remove Ruby' })).not.toBeInTheDocument(); pending.unmount(); const referenced = { width: 16, height: 16, colors: Uint16Array.from([1]), palette: [{ id: 1, name: 'Ruby', color: '#b44', active: true, catalog: { code: '321' } }], backstitches: { ids: new Uint32Array() } } as never; const settled = render(<EditorSurface workspace={ws} document={referenced} />); expect(screen.getByRole('button', { name: 'Remove Ruby' })).toHaveAttribute('title', 'Remove or replace this color'); settled.unmount(); f.uiState.pendingPaletteId = null; render(<EditorSurface workspace={ws} document={two} />); expect(screen.getByRole('button', { name: 'Remove Ruby' })).toHaveAttribute('title', 'Remove or replace this color'); expect(screen.getByRole('button', { name: 'Remove Sky' })).toBeInTheDocument(); });
  it('opens the remove dialog and shows the no-candidates note for a single color', () => { render(<EditorSurface workspace={ws} document={doc} />); fireEvent.click(screen.getByRole('button', { name: 'Remove Ruby' })); expect(screen.getByRole('dialog', { name: 'Remove Ruby' })).toBeInTheDocument(); expect(screen.getByText('No other active palette colors yet. Add one, or search the offline catalog below.')).toBeInTheDocument(); });
  it('replaces the removed color with an existing palette color', () => { render(<EditorSurface workspace={ws} document={two} />); fireEvent.click(screen.getByRole('button', { name: 'Remove Ruby' })); fireEvent.click(screen.getByRole('button', { name: 'Replace with Sky' })); expect((ws as { execute: ReturnType<typeof vi.fn> }).execute).toHaveBeenCalledWith(expect.objectContaining({ type: 'palette-merge', from: 1, to: 2 })); expect(f.c.selectPalette).toHaveBeenCalledWith(2); expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); });
  it('replaces the removed color with a catalog color', () => { const match = searchDmcColors('salmon')[0]; const merged = { width: 16, height: 16, colors: new Uint16Array(1024), palette: [{ id: 1, name: 'Ruby', color: '#b44', active: true, catalog: { code: '321', name: 'Ruby', hex: '#b44', rgb: [0, 0, 0], catalogId: 'dmc-compatible-screen-approximation', sourceId: 'x' } }, { id: 2, name: match.name, color: match.hex, active: true, catalog: { catalogId: 'dmc-compatible-screen-approximation', sourceId: match.sourceId, code: match.code, name: match.name, hex: match.hex, rgb: [...match.rgb] } }], backstitches: { ids: new Uint32Array() } } as never; (ws as { execute: ReturnType<typeof vi.fn> }).execute.mockReturnValue({}); (ws as { getStateSnapshot: ReturnType<typeof vi.fn> }).getStateSnapshot.mockReturnValue({ document: merged }); render(<EditorSurface workspace={ws} document={doc} />); fireEvent.click(screen.getByRole('button', { name: 'Remove Ruby' })); fireEvent.change(screen.getByLabelText('Search offline catalog for a replacement'), { target: { value: 'salmon' } }); fireEvent.click(screen.getByRole('button', { name: `Replace with ${match.name} from the catalog` })); expect((ws as { execute: ReturnType<typeof vi.fn> }).execute).toHaveBeenCalledWith(expect.objectContaining({ type: 'palette-merge', from: 1, createTo: expect.objectContaining({ name: match.name, color: match.hex }) })); expect(f.c.selectPalette).toHaveBeenCalledWith(2); });
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
