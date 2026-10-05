import { createRef } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CanvasEdgeControls } from './CanvasEdgeControls';
import { LayerControls } from './LayerControls';
import { CANVAS_BASIC_LOCKED_HINT } from '../../editor/contracts';
import { createLayeredDocument } from '../../domain';
import { DEFAULT_CATALOG_DEFINITION } from '../../catalog';

function controllerMock() {
  return {
    resizeCanvasEdge: vi.fn(() => true),
    beginCanvasEdgeDrag: vi.fn(() => true),
    updateCanvasEdgeDrag: vi.fn(() => true),
    endCanvasEdgeDrag: vi.fn(() => true),
    cancelCanvasEdgeDrag: vi.fn()
  };
}

/** Renders the controls in a 400×300 frame at the frame's origin on screen. */
function renderControls(options: { width?: number; height?: number; viewport?: { x: number; y: number; zoom: number }; previewBox?: { x: number; y: number; width: number; height: number } } = {}) {
  const frameElement = document.createElement('div');
  Object.defineProperty(frameElement, 'clientWidth', { configurable: true, value: 400 });
  Object.defineProperty(frameElement, 'clientHeight', { configurable: true, value: 300 });
  frameElement.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, x: 0, y: 0, toJSON: () => ({}) });
  const frame = createRef<HTMLElement>() as { current: HTMLElement | null };
  frame.current = frameElement;
  const controller = controllerMock();
  const element = (next: typeof options) => <CanvasEdgeControls controller={controller as never} viewport={next.viewport ?? { x: -5, y: -5, zoom: 10 }} width={next.width ?? 10} height={next.height ?? 8} frame={frame} previewBox={next.previewBox} />;
  const view = render(element(options));
  return { controller, view, frame, rerender: (next: typeof options) => view.rerender(element({ ...options, ...next })) };
}

function clusterStyle(edge: string): { left: number; top: number } {
  const cluster = document.querySelector<HTMLElement>(`.canvas-edge-${edge}`)!;
  return { left: Number.parseFloat(cluster.style.left), top: Number.parseFloat(cluster.style.top) };
}

describe('CanvasEdgeControls', () => {
  it('offers labelled − / + buttons per edge that resize by one', () => {
    const { controller } = renderControls();
    fireEvent.click(screen.getByRole('button', { name: 'Add a row at the top' }));
    expect(controller.resizeCanvasEdge).toHaveBeenLastCalledWith('top', 1);
    fireEvent.click(screen.getByRole('button', { name: 'Remove a column on the right' }));
    expect(controller.resizeCanvasEdge).toHaveBeenLastCalledWith('right', -1);
    fireEvent.click(screen.getByRole('button', { name: 'Add a column on the left' }));
    expect(controller.resizeCanvasEdge).toHaveBeenLastCalledWith('left', 1);
    fireEvent.click(screen.getByRole('button', { name: 'Remove a row at the bottom' }));
    expect(controller.resizeCanvasEdge).toHaveBeenLastCalledWith('bottom', -1);
  });

  it('disables − when that dimension is one cell', () => {
    // Zoomed in enough that a 1×3 canvas has room for every cluster.
    renderControls({ width: 1, height: 3, viewport: { x: -1, y: -0.2, zoom: 80 } });
    expect(screen.getByRole('button', { name: 'Remove a column on the left' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove a column on the right' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove a row at the top' })).toBeEnabled();
  });

  it('draws half-size buttons with a larger hit area that never overlaps a neighbour', async () => {
    const css = (await import('../../styles.css?inline')).default;
    expect(css).toMatch(/\.canvas-edge-button \{[^}]*width:22px;[^}]*height:22px;/);
    expect(css).toMatch(/\.canvas-edge-cluster \{[^}]*gap:4px;/);
    // 2px along the edge each side fills exactly half the 4px gap.
    expect(css).toMatch(/\.canvas-edge-button::after \{[^}]*inset:-7px -2px;/);
    expect(css).toMatch(/\.canvas-edge-cluster-vertical \.canvas-edge-button::after \{[^}]*inset:-2px -7px;/);
  });

  it('centres each cluster on its edge line, the handle straddling the border', () => {
    // The box spans x 50..150 and y 50..130 on screen; a cluster is 74×22 (or 22×74), its handle in the middle.
    renderControls();
    expect(clusterStyle('top')).toEqual({ left: 100 - 37, top: 50 - 11 });
    expect(clusterStyle('bottom')).toEqual({ left: 100 - 37, top: 130 - 11 });
    expect(clusterStyle('left')).toEqual({ left: 50 - 11, top: 90 - 37 });
    expect(clusterStyle('right')).toEqual({ left: 150 - 11, top: 90 - 37 });
    // Along each edge the order is −, handle, +.
    const top = document.querySelector('.canvas-edge-top')!;
    expect([...top.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'))).toEqual(['Remove a row at the top', 'Drag the top edge', 'Add a row at the top']);
  });

  it('slides along a partly visible edge, staying on the line', () => {
    // A 60×8 canvas: x 50..650, so the top edge is visible from 50 to 400 and the right edge is off screen.
    renderControls({ width: 60 });
    expect(clusterStyle('top')).toEqual({ left: 225 - 37, top: 50 - 11 });
    expect(clusterStyle('bottom')).toEqual({ left: 225 - 37, top: 130 - 11 });
    expect(document.querySelector('.canvas-edge-right')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Drag the right edge' })).not.toBeInTheDocument();
    expect(clusterStyle('left')).toEqual({ left: 50 - 11, top: 90 - 37 });
  });

  it('hides edges whose line is off screen or whose visible part is shorter than the cluster', () => {
    // Zoomed in so every edge line lies outside the frame.
    renderControls({ viewport: { x: 2, y: 2, zoom: 100 } });
    expect(document.querySelectorAll('.canvas-edge-cluster')).toHaveLength(0);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('hides an edge whose visible part is too short for the cluster', () => {
    // A 5-cell-wide canvas is 50px wide on screen, less than the 74px cluster.
    renderControls({ width: 5 });
    expect(document.querySelector('.canvas-edge-top')).toBeNull();
    expect(document.querySelector('.canvas-edge-bottom')).toBeNull();
    expect(document.querySelector('.canvas-edge-left')).not.toBeNull();
  });

  it('follows the previewed box during a drag and keeps the dragged cluster when its edge leaves the frame', () => {
    const { controller, rerender } = renderControls();
    const handle = screen.getByRole('button', { name: 'Drag the right edge' });
    handle.setPointerCapture = vi.fn();
    fireEvent.pointerDown(handle, { pointerId: 4, button: 0, clientX: 150, clientY: 90 });
    rerender({ previewBox: { x: 0, y: 0, width: 13, height: 8 } });
    // The previewed right edge is at (13 + 5) × 10 = 180.
    expect(clusterStyle('right')).toEqual({ left: 180 - 11, top: 90 - 37 });
    expect(clusterStyle('top')).toEqual({ left: 115 - 37, top: 50 - 11 });
    // Pushed past the frame: the dragged cluster stays, clamped inside, and keeps the same element.
    rerender({ previewBox: { x: 0, y: 0, width: 60, height: 8 } });
    expect(clusterStyle('right')).toEqual({ left: 400 - 22, top: 90 - 37 });
    expect(screen.getByRole('button', { name: 'Drag the right edge' })).toBe(handle);
    fireEvent.pointerMove(handle, { pointerId: 4, clientX: 700, clientY: 90 });
    expect(controller.updateCanvasEdgeDrag).toHaveBeenLastCalledWith({ x: 700, y: 90 });
    fireEvent.pointerUp(handle, { pointerId: 4 });
    expect(controller.endCanvasEdgeDrag).toHaveBeenCalledOnce();
    // Once released, an off-screen edge is hidden again.
    expect(document.querySelector('.canvas-edge-right')).toBeNull();
  });

  it('drags an edge with pointer capture and commits on release', () => {
    const { controller } = renderControls();
    const handle = screen.getByRole('button', { name: 'Drag the right edge' });
    handle.setPointerCapture = vi.fn();
    fireEvent.pointerDown(handle, { pointerId: 3, button: 0, clientX: 150, clientY: 90 });
    expect(controller.beginCanvasEdgeDrag).toHaveBeenCalledWith('right', { x: 150, y: 90 });
    expect(handle.setPointerCapture).toHaveBeenCalledWith(3);
    expect(handle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.pointerMove(handle, { pointerId: 3, clientX: 180, clientY: 90 });
    expect(controller.updateCanvasEdgeDrag).toHaveBeenCalledWith({ x: 180, y: 90 });
    fireEvent.pointerUp(handle, { pointerId: 3, clientX: 180, clientY: 90 });
    expect(controller.endCanvasEdgeDrag).toHaveBeenCalledOnce();
    fireEvent.lostPointerCapture(handle, { pointerId: 3 });
    expect(controller.cancelCanvasEdgeDrag).not.toHaveBeenCalled();
  });

  it('cancels a drag on Escape and on pointer cancel', () => {
    const { controller } = renderControls();
    const handle = screen.getByRole('button', { name: 'Drag the top edge' });
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 100, clientY: 50 });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(controller.cancelCanvasEdgeDrag).toHaveBeenCalledOnce();
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(controller.endCanvasEdgeDrag).not.toHaveBeenCalled();
    fireEvent.pointerDown(handle, { pointerId: 2, button: 0, clientX: 100, clientY: 50 });
    fireEvent.pointerCancel(handle, { pointerId: 2 });
    expect(controller.cancelCanvasEdgeDrag).toHaveBeenCalledTimes(2);
  });

  it('resizes from the keyboard with arrow keys on a handle', () => {
    const { controller } = renderControls();
    const handle = screen.getByRole('button', { name: 'Drag the bottom edge' });
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(controller.resizeCanvasEdge).toHaveBeenLastCalledWith('bottom', 1);
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(controller.resizeCanvasEdge).toHaveBeenLastCalledWith('bottom', -1);
  });

  it('lets pointer events through everywhere except its buttons', async () => {
    renderControls();
    const css = (await import('../../styles.css?inline')).default;
    expect(css).toMatch(/\.canvas-edge-controls \{[^}]*pointer-events:none;/);
    expect(css).toMatch(/\.canvas-edge-button \{[^}]*pointer-events:auto;/);
    expect(css).toMatch(/\.canvas-edge-cluster:not\(\.canvas-edge-cluster-vertical\) \.canvas-edge-handle \{ cursor:ns-resize; \}/);
    expect(css).toMatch(/\.canvas-edge-cluster-vertical \.canvas-edge-handle \{ cursor:ew-resize; \}/);
  });
});

describe('Crop split button', () => {
  const layered = createLayeredDocument({ width: 4, height: 4, catalog: DEFAULT_CATALOG_DEFINITION.association, palette: [] });
  const base = {
    document: layered,
    activeLayerId: 'canvas' as const,
    backgroundColor: '#FFFFFF',
    aidaCount: 14,
    onChooseBackground: vi.fn(),
    onAidaCountChange: vi.fn(),
    onRename: vi.fn(),
    onDuplicate: vi.fn(),
    onMerge: vi.fn(),
    onDelete: vi.fn()
  };

  it('toggles crop mode from the main button and keeps the canvas settings', () => {
    const onCanvasCropToggle = vi.fn();
    const view = render(<LayerControls {...base} canvasMode="basic" canvasBasicAvailable canvasCropActive={false} onCanvasModeChange={vi.fn()} onCanvasCropToggle={onCanvasCropToggle} />);
    const main = screen.getByRole('button', { name: 'Crop' });
    expect(main).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(main);
    expect(onCanvasCropToggle).toHaveBeenCalledOnce();
    view.rerender(<LayerControls {...base} canvasMode="advanced" canvasBasicAvailable canvasCropActive onCanvasModeChange={vi.fn()} onCanvasCropToggle={onCanvasCropToggle} />);
    expect(screen.getByRole('button', { name: 'Advanced crop' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Stitch count')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Change background color/ })).toBeInTheDocument();
  });

  it('chooses the mode from a menu that closes on Escape and outside clicks, returning focus', () => {
    const onCanvasModeChange = vi.fn();
    render(<LayerControls {...base} canvasMode="basic" canvasBasicAvailable canvasCropActive={false} onCanvasModeChange={onCanvasModeChange} onCanvasCropToggle={vi.fn()} />);
    const arrow = screen.getByRole('button', { name: 'Crop options' });
    expect(arrow).toHaveAttribute('aria-haspopup', 'menu');
    fireEvent.click(arrow);
    expect(arrow).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('menu', { name: 'Crop mode' });
    const crop = within(menu).getByRole('menuitemradio', { name: 'Crop' });
    const advanced = within(menu).getByRole('menuitemradio', { name: 'Advanced crop' });
    expect(crop).toHaveAttribute('aria-checked', 'true');
    expect(crop).toHaveFocus();
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(advanced).toHaveFocus();
    fireEvent.click(advanced);
    expect(onCanvasModeChange).toHaveBeenCalledWith('advanced');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(arrow).toHaveFocus();

    fireEvent.click(arrow);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(arrow).toHaveFocus();
    fireEvent.click(arrow);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('locks Crop with the hint and reads Advanced crop while the canvas is not a rectangle', () => {
    render(<LayerControls {...base} canvasMode="basic" canvasBasicAvailable={false} canvasCropActive={false} onCanvasModeChange={vi.fn()} onCanvasCropToggle={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Advanced crop' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Crop options' }));
    const crop = screen.getByRole('menuitemradio', { name: 'Crop' });
    expect(crop).toBeDisabled();
    expect(crop).toHaveAttribute('title', CANVAS_BASIC_LOCKED_HINT);
    expect(crop).toHaveAttribute('aria-description', CANVAS_BASIC_LOCKED_HINT);
    expect(screen.getByRole('menuitemradio', { name: 'Advanced crop' })).toHaveAttribute('aria-checked', 'true');
  });
});
