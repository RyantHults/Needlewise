import { act, fireEvent, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyLayerStructureCommand, CellKind, layerAddCommand, layerSetVisibilityCommand, type LayeredDocument, type StitchLayer } from '../../domain';
import { LAYER_LONG_PRESS_MS, LayersPanel } from './LayersPanel';
import { createLayeredDocument } from '../../domain/test-fixtures';

const thumbnails = vi.hoisted(() => ({ render: vi.fn(), paint: vi.fn() }));
vi.mock('../../rendering/layer-thumbnail', async () => {
  const actual = await vi.importActual<typeof import('../../rendering/layer-thumbnail')>('../../rendering/layer-thumbnail');
  thumbnails.render.mockImplementation(actual.renderLayerThumbnailPixels);
  // jsdom has no Canvas 2D, so capture what would be painted.
  thumbnails.paint.mockReturnValue(true);
  return { ...actual, renderLayerThumbnailPixels: thumbnails.render, paintLayerThumbnail: thumbnails.paint };
});

const catalog = { catalogId: 'test', brandLabel: 'Test', colorCount: 500 } as never;
const makeDocument = (): LayeredDocument => {
  const document = createLayeredDocument({ width: 8, height: 8, catalog, palette: [{ name: 'Red', color: '#FF0000' }] });
  applyLayerStructureCommand(document, layerAddCommand('stitch', { name: 'Border' }));
  return document;
};
const panel = (document: LayeredDocument) => (
  <LayersPanel
    document={document}
    layerSelection={{ primary: 1, layerIds: [1] }}
    backgroundColor="#F3EEE5"
    reference={{ present: false, visible: true }}
    onSelect={vi.fn()}
    onToggleVisibility={vi.fn()}
    onToggleReferenceVisibility={vi.fn()}
    onAddReference={vi.fn()}
    onMove={vi.fn()}
    onAdd={vi.fn()}
  />
);
/** The document T2 produces after an edit to one layer: a new document shell and a new object for that layer only. */
const editLayer = (document: LayeredDocument, layerId: number): LayeredDocument => ({
  ...document,
  palette: [...document.palette],
  revision: document.revision + 1,
  layers: document.layers.map((layer) => (layer.id === layerId ? { ...layer } : layer)),
});
const renderedIds = () => thumbnails.render.mock.calls.map(([, layer]) => (layer as { id: number }).id);

beforeEach(() => {
  vi.useFakeTimers();
  thumbnails.render.mockClear();
  thumbnails.paint.mockClear();
});
afterEach(() => {
  // dnd-kit swallows the click after a drag until a timer fires; flush it before the fake clock goes away.
  act(() => vi.runOnlyPendingTimers());
  vi.useRealTimers();
});

describe('LayersPanel thumbnails', () => {
  it('paints thumbnails from the idle queue, not during render', () => {
    render(panel(makeDocument()));
    expect(thumbnails.render).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(0));
    expect(renderedIds().sort()).toEqual([1, 2, 3]);
  });

  it('recomputes only the edited layer and ignores new palette and document identities', () => {
    let document = makeDocument();
    const view = render(panel(document));
    act(() => vi.advanceTimersByTime(600));
    thumbnails.render.mockClear();
    document = editLayer(document, 3);
    view.rerender(panel(document));
    act(() => vi.advanceTimersByTime(600));
    expect(renderedIds()).toEqual([3]);
  });

  it('coalesces a burst of edits into at most one recompute per window', () => {
    let document = makeDocument();
    const view = render(panel(document));
    act(() => vi.advanceTimersByTime(600));
    thumbnails.render.mockClear();
    for (let edit = 0; edit < 10; edit += 1) {
      document = editLayer(document, 1);
      view.rerender(panel(document));
      act(() => vi.advanceTimersByTime(40));
    }
    // 400 ms of edits: the first runs right away, the rest wait for the next window.
    expect(thumbnails.render.mock.calls.length).toBeLessThanOrEqual(1);
    act(() => vi.advanceTimersByTime(500));
    expect(thumbnails.render.mock.calls.length).toBeLessThanOrEqual(2);
    expect(renderedIds().every((id) => id === 1)).toBe(true);
  });

  it('paints a pre-filled stitch layer under StrictMode, as after creating a pattern from an image', () => {
    // Regression: the queue lived in a memo and StrictMode's replayed effect
    // cleanup disposed it, so no thumbnail was ever painted.
    const document = makeDocument();
    const stitches = document.layers.find((layer) => layer.id === 1) as StitchLayer;
    stitches.kind.fill(CellKind.Full);
    for (let index = 0; index < stitches.kind.length; index += 1) stitches.colors[index * 4] = document.palette[0]!.id;
    render(<StrictMode>{panel(document)}</StrictMode>);
    act(() => vi.advanceTimersByTime(600));
    const painted = thumbnails.paint.mock.calls.map(([, pixels]) => pixels as { data: Uint8ClampedArray });
    expect(painted).toHaveLength(3);
    const opaque = (pixels: { data: Uint8ClampedArray }) => pixels.data.filter((_, offset) => offset % 4 === 3 && pixels.data[offset] === 255).length;
    expect(painted.map(opaque).sort((a, b) => b - a)[0]).toBe(40 * 40);
  });

  it('does not recompute any thumbnail when a layer is shown or hidden', () => {
    let document = makeDocument();
    const view = render(panel(document));
    act(() => vi.advanceTimersByTime(600));
    thumbnails.render.mockClear();
    applyLayerStructureCommand(document, layerSetVisibilityCommand(3, false));
    document = { ...document, palette: [...document.palette] };
    view.rerender(panel(document));
    act(() => vi.advanceTimersByTime(600));
    expect(thumbnails.render).not.toHaveBeenCalled();
  });

  it('repaints every layer when a palette color changes', () => {
    let document = makeDocument();
    const view = render(panel(document));
    act(() => vi.advanceTimersByTime(600));
    thumbnails.render.mockClear();
    document = { ...document, palette: document.palette.map((entry) => ({ ...entry, color: '#00FF00' })) };
    view.rerender(panel(document));
    act(() => vi.advanceTimersByTime(600));
    expect(renderedIds().sort()).toEqual([1, 2, 3]);
  });
});

describe('LayersPanel long-press reorder', () => {
  const row = (container: HTMLElement, name: string) => container.querySelector<HTMLElement>(`button[aria-label^="${name},"]`)!.closest('li')!;

  it('starts a reorder drag after a pen long-press on the row', () => {
    const { container } = render(panel(makeDocument()));
    const border = row(container, 'Border');
    fireEvent.pointerDown(border, { pointerType: 'pen', isPrimary: true, button: 0, clientX: 10, clientY: 10 });
    act(() => vi.advanceTimersByTime(LAYER_LONG_PRESS_MS - 1));
    expect(border).not.toHaveClass('layer-row-dragging');
    act(() => vi.advanceTimersByTime(1));
    expect(border).toHaveClass('layer-row-dragging');
    fireEvent.pointerUp(document, { pointerType: 'pen', isPrimary: true, clientX: 10, clientY: 10 });
  });

  it('does not start a drag from a mouse press on the row body', () => {
    const { container } = render(panel(makeDocument()));
    const border = row(container, 'Border');
    fireEvent.pointerDown(border, { pointerType: 'mouse', isPrimary: true, button: 0 });
    act(() => vi.advanceTimersByTime(LAYER_LONG_PRESS_MS * 2));
    expect(border).not.toHaveClass('layer-row-dragging');
  });
});

describe('LayersPanel multi-select', () => {
  const selectionPanel = (onSelect = vi.fn(), layerSelection = { primary: 3 as number | 'canvas', layerIds: [1, 3] }) => (
    <LayersPanel
      document={makeDocument()}
      layerSelection={layerSelection}
      backgroundColor="#F3EEE5"
      reference={{ present: false, visible: true }}
      onSelect={onSelect}
      onToggleVisibility={vi.fn()}
      onToggleReferenceVisibility={vi.fn()}
      onAddReference={vi.fn()}
      onMove={vi.fn()}
      onAdd={vi.fn()}
    />
  );
  const rowButton = (view: ReturnType<typeof render>, layerId: number) =>
    view.container.querySelectorAll<HTMLElement>('.layer-row[data-layer-type="stitch"] .layer-row-select')[layerId === 1 ? 1 : 0]!;

  it('marks every selected row and the primary', () => {
    const view = render(selectionPanel());
    expect(view.container.querySelectorAll('.layer-row-selected')).toHaveLength(2);
    const primary = view.container.querySelectorAll('.layer-row-primary');
    expect(primary).toHaveLength(1);
    expect(primary[0]!.classList.contains('layer-row-selected')).toBe(true);
    expect(view.container.querySelectorAll('.layer-row-select[aria-pressed="true"]')).toHaveLength(2);
  });

  it('reports ctrl/meta as toggle and shift as range, with plain clicks unmodified', () => {
    const onSelect = vi.fn();
    const view = render(selectionPanel(onSelect));
    const button = rowButton(view, 1);
    fireEvent.click(button);
    fireEvent.click(button, { ctrlKey: true });
    fireEvent.click(button, { metaKey: true });
    fireEvent.click(button, { shiftKey: true });
    expect(onSelect.mock.calls).toEqual([
      [1, { toggle: false, range: false }],
      [1, { toggle: true, range: false }],
      [1, { toggle: true, range: false }],
      [1, { toggle: false, range: true }],
    ]);
  });

  it('collapses on Canvas with a plain select', () => {
    const onSelect = vi.fn();
    const view = render(selectionPanel(onSelect));
    fireEvent.click(view.container.querySelector('[data-layer-type="canvas"] .layer-row-select')!, { ctrlKey: true });
    expect(onSelect).toHaveBeenCalledWith('canvas');
  });

  describe('swipe', () => {
    const swipeRow = (view: ReturnType<typeof render>, name: string) => view.container.querySelector<HTMLElement>(`button[aria-label^="${name},"]`)!.closest('li')!;
    const gesture = (row: HTMLElement, to: { dx: number; dy?: number }, pointerType = 'touch') => {
      const base = { pointerType, pointerId: 7, isPrimary: true, button: 0 };
      fireEvent.pointerDown(row, { ...base, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(row, { ...base, clientX: 100 + to.dx, clientY: 100 + (to.dy ?? 0) });
      fireEvent.pointerUp(row, { ...base, clientX: 100 + to.dx, clientY: 100 + (to.dy ?? 0) });
    };

    it('toggles on a touch or pen swipe right past the threshold and swallows the following click', () => {
      const onSelect = vi.fn();
      const view = render(selectionPanel(onSelect));
      const row = swipeRow(view, 'Border');
      gesture(row, { dx: 60, dy: 10 });
      expect(onSelect.mock.calls).toEqual([[3, { toggle: true }]]);
      fireEvent.click(row.querySelector('.layer-row-select')!);
      expect(onSelect).toHaveBeenCalledTimes(1);
      // Only that one click is swallowed.
      fireEvent.click(row.querySelector('.layer-row-select')!);
      expect(onSelect).toHaveBeenCalledTimes(2);
      gesture(row, { dx: 60 }, 'pen');
      expect(onSelect).toHaveBeenCalledTimes(3);
    });

    it('shows swipe feedback while moving and snaps back on release', () => {
      const view = render(selectionPanel());
      const row = swipeRow(view, 'Border');
      const base = { pointerType: 'touch', pointerId: 7, isPrimary: true, button: 0 };
      fireEvent.pointerDown(row, { ...base, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(row, { ...base, clientX: 200, clientY: 100 });
      expect(row.querySelector<HTMLElement>('.layer-row-select')!.style.transform).toBe('translateX(40px)');
      expect(row).toHaveClass('layer-row-swipe-remove');
      fireEvent.pointerUp(row, { ...base, clientX: 200, clientY: 100 });
      expect(row.querySelector<HTMLElement>('.layer-row-select')!.style.transform).toBe('');
      expect(row).not.toHaveClass('layer-row-swipe-remove');
    });

    it.each([
      ['a short swipe', { dx: 20 }, 'touch'],
      ['a left swipe', { dx: -80 }, 'touch'],
      ['a vertical move', { dx: 10, dy: 80 }, 'touch'],
      ['a diagonal move', { dx: 60, dy: 50 }, 'touch'],
      ['a mouse drag', { dx: 80 }, 'mouse'],
    ])('ignores %s', (_name, to, pointerType) => {
      const onSelect = vi.fn();
      const view = render(selectionPanel(onSelect));
      const row = swipeRow(view, 'Border');
      gesture(row, to, pointerType);
      expect(onSelect).not.toHaveBeenCalled();
      fireEvent.click(row.querySelector('.layer-row-select')!);
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it('ignores swipes on Canvas', () => {
      const onSelect = vi.fn();
      const view = render(selectionPanel(onSelect));
      gesture(view.container.querySelector<HTMLElement>('[data-layer-type="canvas"]')!, { dx: 80 });
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('does not toggle when a long-press reorder drag takes over', () => {
      const onSelect = vi.fn();
      const view = render(selectionPanel(onSelect));
      const row = swipeRow(view, 'Border');
      const base = { pointerType: 'pen', pointerId: 7, isPrimary: true, button: 0 };
      fireEvent.pointerDown(row, { ...base, clientX: 100, clientY: 100 });
      act(() => vi.advanceTimersByTime(LAYER_LONG_PRESS_MS));
      expect(row).toHaveClass('layer-row-dragging');
      fireEvent.pointerMove(row, { ...base, clientX: 100, clientY: 160 });
      fireEvent.pointerUp(row, { ...base, clientX: 100, clientY: 160 });
      expect(onSelect).not.toHaveBeenCalled();
    });
  });
});
