import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyLayerStructureCommand, createLayeredDocument, layerAddCommand, type LayeredDocument } from '../../domain';
import { LAYER_LONG_PRESS_MS, LayersPanel } from './LayersPanel';

const thumbnails = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock('../../rendering/layer-thumbnail', async () => {
  const actual = await vi.importActual<typeof import('../../rendering/layer-thumbnail')>('../../rendering/layer-thumbnail');
  thumbnails.render.mockImplementation(actual.renderLayerThumbnailPixels);
  return { ...actual, renderLayerThumbnailPixels: thumbnails.render };
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
    activeLayerId={1}
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
});
afterEach(() => {
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
