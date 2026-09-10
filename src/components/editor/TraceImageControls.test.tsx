import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TraceImageControls } from './TraceImageControls';

const { decodeTraceImageMock } = vi.hoisted(() => ({ decodeTraceImageMock: vi.fn() }));

vi.mock('../../rendering/trace', async () => {
  const actual = await vi.importActual<typeof import('../../rendering/trace')>('../../rendering/trace');
  return { ...actual, decodeTraceImage: decodeTraceImageMock };
});

decodeTraceImageMock.mockResolvedValue({ source: {}, bitmap: {}, width: 2, height: 2, sourceWidth: 2, sourceHeight: 2, dispose: vi.fn() });

describe('TraceImageControls lifecycle', () => {
  it('reattaches a valid trace after StrictMode effect replay and disposes on unmount', async () => {
    const controller = { current: undefined as unknown, setTraceImage: vi.fn((value: unknown) => { controller.current = value; }), getTraceImage: vi.fn(() => controller.current), clearTraceImage: vi.fn(() => { (controller.current as { dispose?: () => void } | undefined)?.dispose?.(); controller.current = undefined; }) };
    const descriptor = { assetId: 'trace', mimeType: 'image/png' as const, width: 2, height: 2, crop: { x: 0, y: 0, width: 1, height: 1 }, chartBounds: { x: 0, y: 0, width: 2, height: 2 }, traceVisible: true, opacity: 1 };
    const workspace = { sourceImage: descriptor, getAsset: () => ({ id: 'trace', name: 'trace.png', mimeType: 'image/png', data: new Uint8Array([1]), checksum: '0'.repeat(64) }) } as never;
    const { unmount } = render(<StrictMode><TraceImageControls workspace={workspace} document={{ width: 2, height: 2 } as never} controller={controller as never} /></StrictMode>);
    await waitFor(() => expect(controller.setTraceImage).toHaveBeenCalled());
    expect(controller.getTraceImage()).toBeTruthy();
    unmount();
    expect(controller.clearTraceImage).toHaveBeenCalled();
  });

  it('imports a file with aspect-preserving fitted chart bounds', async () => {
    const controller = { current: undefined as unknown, setTraceImage: vi.fn((value: unknown) => { controller.current = value; }), getTraceImage: vi.fn(() => controller.current), clearTraceImage: vi.fn(() => { (controller.current as { dispose?: () => void } | undefined)?.dispose?.(); controller.current = undefined; }) };
    const replaceSourceImage = vi.fn(async () => undefined);
    const workspace = { sourceImage: undefined, getAsset: () => undefined, replaceSourceImage } as never;
    const { unmount } = render(<TraceImageControls workspace={workspace} document={{ width: 100, height: 50 } as never} controller={controller as never} />);
    const input = document.querySelector('.visually-hidden') as HTMLInputElement;
    const file = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1])], 'ref.png', { type: 'image/png' });
    vi.spyOn(input, 'files', 'get').mockReturnValue({ 0: file, length: 1 } as unknown as FileList);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => expect(replaceSourceImage).toHaveBeenCalled());
    expect(replaceSourceImage).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.objectContaining({ width: 2, height: 2, chartBounds: { x: 34, y: 9, width: 32, height: 32 } })
    }));
    expect(controller.setTraceImage).toHaveBeenCalledWith(expect.objectContaining({ chartBounds: { x: 34, y: 9, width: 32, height: 32 } }));
    unmount();
  });

  it('imports an oversized reference file writing ORIGINAL dimensions to the descriptor while the overlay stays pre-scaled', async () => {
    const controller = { current: undefined as unknown, setTraceImage: vi.fn((value: unknown) => { controller.current = value; }), getTraceImage: vi.fn(() => controller.current), clearTraceImage: vi.fn(() => { (controller.current as { dispose?: () => void } | undefined)?.dispose?.(); controller.current = undefined; }) };
    const replaceSourceImage = vi.fn(async () => undefined);
    const workspace = { sourceImage: undefined, getAsset: () => undefined, replaceSourceImage } as never;
    decodeTraceImageMock.mockResolvedValueOnce({ source: {}, bitmap: {}, width: 2_000, height: 1_500, sourceWidth: 8_000, sourceHeight: 6_000, dispose: vi.fn() });
    const { unmount } = render(<TraceImageControls workspace={workspace} document={{ width: 100, height: 50 } as never} controller={controller as never} />);
    const input = document.querySelector('.visually-hidden') as HTMLInputElement;
    const file = new File([new Uint8Array(24)], 'large.png', { type: 'image/png' });
    vi.spyOn(input, 'files', 'get').mockReturnValue({ 0: file, length: 1 } as unknown as FileList);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => expect(replaceSourceImage).toHaveBeenCalled());
    expect(replaceSourceImage).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.objectContaining({ width: 8_000, height: 6_000, chartBounds: { x: 19, y: 2, width: 63, height: 47 } })
    }));
    // The handoff overlay carries the pre-scaled trace (fit from overlay dims).
    expect(controller.setTraceImage).toHaveBeenCalledWith(expect.objectContaining({ width: 2_000, height: 1_500, chartBounds: { x: 19, y: 2, width: 63, height: 47 } }));
    await waitFor(() => expect(screen.getByText('large.png imported.')).toBeInTheDocument());
    unmount();
  });
});

describe('TraceImageControls reference image tools', () => {
  const descriptor = { assetId: 'trace', mimeType: 'image/png' as const, width: 2, height: 2, crop: { x: 0, y: 0, width: 1, height: 1 }, chartBounds: { x: 0, y: 0, width: 2, height: 2 }, traceVisible: true, opacity: 1 };

  it('keeps image tools visible but disabled without a descriptor', () => {
    const workspace = { sourceImage: undefined, getAsset: () => undefined } as never;
    render(<TraceImageControls workspace={workspace} document={{ width: 2, height: 2 } as never} controller={null} />);
    expect(screen.getByRole('button', { name: 'Move image' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Resize image' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Show image' })).toBeDisabled();
    expect(screen.getByRole('slider')).toBeDisabled();
  });

  it('renders the reference image tools with a descriptor and reflects activeTool via aria-pressed', () => {
    const workspace = { sourceImage: descriptor, getAsset: () => undefined } as never;
    render(<TraceImageControls workspace={workspace} document={{ width: 2, height: 2 } as never} controller={null} activeTool="move-image" />);
    expect(screen.getByRole('group', { name: 'Reference image tools' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move image' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Resize image' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('activates a reference image tool through the controller', () => {
    const setTool = vi.fn();
    const workspace = { sourceImage: descriptor, getAsset: () => undefined } as never;
    render(<TraceImageControls workspace={workspace} document={{ width: 2, height: 2 } as never} controller={{ setTool } as never} />);
    fireEvent.click(screen.getByRole('button', { name: 'Move image' }));
    expect(setTool).toHaveBeenCalledWith(expect.objectContaining({ tool: 'move-image' }));
    fireEvent.click(screen.getByRole('button', { name: 'Resize image' }));
    expect(setTool).toHaveBeenCalledWith(expect.objectContaining({ tool: 'resize-image' }));
  });

  it('coalesces an opacity slider drag into one history entry on release', async () => {
    const applyTraceImageChange = vi.fn(async () => undefined);
    const setTraceImageSettings = vi.fn();
    const workspace = { sourceImage: descriptor, getAsset: () => undefined, applyTraceImageChange, setSourceImage: vi.fn(async () => undefined) } as never;
    const controller = { setTraceImageSettings, getTraceImage: vi.fn(() => undefined), setTraceImage: vi.fn(), clearTraceImage: vi.fn() } as never;
    const { unmount } = render(<TraceImageControls workspace={workspace} document={{ width: 2, height: 2 } as never} controller={controller} />);
    const slider = document.querySelector('.trace-opacity input') as HTMLInputElement;
    expect(slider).toBeInTheDocument();
    expect(screen.getByText('Transparency')).toBeInTheDocument();
    fireEvent.focus(slider);
    fireEvent.change(slider, { target: { value: '0.5' } });
    fireEvent.change(slider, { target: { value: '0.4' } });
    expect(applyTraceImageChange).not.toHaveBeenCalled();
    expect(setTraceImageSettings).toHaveBeenCalledWith(expect.objectContaining({ opacity: 0.5 }));
    fireEvent.blur(slider);
    await waitFor(() => expect(applyTraceImageChange).toHaveBeenCalledTimes(1));
    expect(applyTraceImageChange).toHaveBeenCalledWith(expect.objectContaining({ opacity: 0.4 }), expect.objectContaining({ label: 'trace-image-opacity' }));
    unmount();
  });

  it('sets hidden opacity to zero and restores the persisted opacity when shown again', async () => {
    const sourceImage = { ...descriptor, opacity: 0.65 };
    const applyTraceImageChange = vi.fn(async (next: typeof sourceImage) => { Object.assign(sourceImage, next); });
    const setTraceImageSettings = vi.fn();
    const workspace = { sourceImage, getAsset: () => undefined, applyTraceImageChange } as never;
    render(<TraceImageControls workspace={workspace} document={{ width: 2, height: 2 } as never} controller={{ setTraceImageSettings } as never} />);
    const checkbox = screen.getByRole('checkbox', { name: 'Show image' });
    const slider = screen.getByRole('slider');
    expect(slider).toHaveValue('0.65');

    fireEvent.click(checkbox);
    expect(slider).toHaveValue('0');
    expect(setTraceImageSettings).toHaveBeenLastCalledWith({ visible: false, opacity: 0 });
    await waitFor(() => expect(applyTraceImageChange).toHaveBeenCalledTimes(1));
    expect(sourceImage).toMatchObject({ traceVisible: false, opacity: 0.65 });
    expect(applyTraceImageChange).toHaveBeenLastCalledWith(expect.objectContaining({ traceVisible: false, opacity: 0.65 }), expect.objectContaining({ label: 'trace-image-visibility' }));

    fireEvent.click(checkbox);
    expect(slider).toHaveValue('0.65');
    expect(setTraceImageSettings).toHaveBeenLastCalledWith({ visible: true, opacity: 0.65 });
    await waitFor(() => expect(applyTraceImageChange).toHaveBeenCalledTimes(2));
    expect(sourceImage).toMatchObject({ traceVisible: true, opacity: 0.65 });
    expect(applyTraceImageChange).toHaveBeenLastCalledWith(expect.objectContaining({ traceVisible: true, opacity: 0.65 }), expect.objectContaining({ label: 'trace-image-visibility' }));
  });

  it('restores stored opacity when showing a freshly mounted hidden descriptor', async () => {
    const sourceImage = { ...descriptor, traceVisible: false, opacity: 0.4 };
    const applyTraceImageChange = vi.fn(async (next: typeof sourceImage) => { Object.assign(sourceImage, next); });
    const setTraceImageSettings = vi.fn();
    const workspace = { sourceImage, getAsset: () => undefined, applyTraceImageChange } as never;
    render(<TraceImageControls workspace={workspace} document={{ width: 2, height: 2 } as never} controller={{ setTraceImageSettings } as never} />);
    const slider = screen.getByRole('slider');
    expect(slider).toHaveValue('0');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Show image' }));
    expect(slider).toHaveValue('0.4');
    expect(setTraceImageSettings).toHaveBeenLastCalledWith({ visible: true, opacity: 0.4 });
    await waitFor(() => expect(applyTraceImageChange).toHaveBeenCalledTimes(1));
    expect(sourceImage).toMatchObject({ traceVisible: true, opacity: 0.4 });
    expect(applyTraceImageChange).toHaveBeenLastCalledWith(expect.objectContaining({ traceVisible: true, opacity: 0.4 }), expect.objectContaining({ label: 'trace-image-visibility' }));
  });

  it('commits a visibility toggle as one history entry', async () => {
    const applyTraceImageChange = vi.fn(async () => undefined);
    const workspace = { sourceImage: descriptor, getAsset: () => undefined, applyTraceImageChange, setSourceImage: vi.fn(async () => undefined) } as never;
    const controller = { setTraceImageSettings: vi.fn(), getTraceImage: vi.fn(() => undefined), setTraceImage: vi.fn(), clearTraceImage: vi.fn() } as never;
    const { unmount } = render(<TraceImageControls workspace={workspace} document={{ width: 2, height: 2 } as never} controller={controller} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show image' }));
    await waitFor(() => expect(applyTraceImageChange).toHaveBeenCalledTimes(1));
    expect(applyTraceImageChange).toHaveBeenCalledWith(expect.objectContaining({ traceVisible: false }), expect.objectContaining({ label: 'trace-image-visibility' }));
    unmount();
  });
});
