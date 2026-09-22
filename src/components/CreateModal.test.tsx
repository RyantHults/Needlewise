import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calculatePreviewSize, CreateModal, previewFinishedSize, previewLensGeometry, suggestConversionDimensions } from './CreateModal';
import { DEFAULT_CATALOG_DEFINITION, type CatalogSnapshot } from '../catalog';

const DEFAULT_CATALOG_COLOR_COUNT = DEFAULT_CATALOG_DEFINITION.snapshot.association.colorCount;

const conversion = vi.hoisted(() => ({ convert: vi.fn() }));
vi.mock('../conversion/image-conversion-client', () => ({
  convertImageToPattern: conversion.convert,
  ConversionCancelledError: class ConversionCancelledError extends Error {}
}));
// The mocked conversion drafts are intentionally minimal (no token/planes), so
// draft acceptance is a passthrough here; the close-guard test needs create()
// to reach the async 'creating' state instead of failing draft validation.
vi.mock('../conversion/image-to-pattern', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../conversion/image-to-pattern')>();
  return { ...actual, acceptConversionDraft: (draft: unknown) => draft };
});

const images: MockImage[] = [];
class MockImage {
  naturalWidth = 1;
  naturalHeight = 1;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) { images.push(this); }
}

function props(onClose: () => void = vi.fn(), catalog: CatalogSnapshot = DEFAULT_CATALOG_DEFINITION.snapshot) {
  return {
    mode: 'image' as const, title: 'Test', width: '100', height: '100', aida: '14', busy: false, catalog,
    onMode: vi.fn(), onClose, onBlank: vi.fn(), onConversionCreate: vi.fn(), onTitle: vi.fn(), onWidth: vi.fn(), onHeight: vi.fn(), onAida: vi.fn()
  };
}

function ControlledModal(propsOverride: { onClose?: () => void; catalog?: CatalogSnapshot } = {}) {
  const [width, setWidth] = useState('100');
  const [height, setHeight] = useState('100');
  const [aida, setAida] = useState('14');
  return <CreateModal {...props(propsOverride.onClose, propsOverride.catalog)} width={width} height={height} onWidth={setWidth} onHeight={setHeight} aida={aida} onAida={setAida} />;
}

beforeEach(() => {
  vi.useFakeTimers();
  images.length = 0;
  conversion.convert.mockReset();
  conversion.convert.mockResolvedValue({ draft: { stats: { sourceWidth: 640, sourceHeight: 480 }, document: { width: 2, height: 2, palette: [], colors: new Uint16Array(16) } } });
  vi.stubGlobal('Image', MockImage);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('CreateModal image lifecycle', () => {
  it('uses the smallest power-of-two enlargement needed for a minimum preview', () => {
    expect(calculatePreviewSize(50, 50)).toEqual({ width: 400, height: 400 });
    expect(calculatePreviewSize(2, 4)).toEqual({ width: 512, height: 1024 });
    expect(calculatePreviewSize(640, 480)).toEqual({ width: 760, height: 570 });
  });

  it('exposes the color budget as a keyboard-operable range with a live count', async () => {
    render(<ControlledModal />);
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    act(() => { images[0].onload?.(); });
    // The slider lives in the review section, which appears after the first
    // conversion. vi.waitFor advances the fake timers and drains microtasks,
    // so the draft render is awaited instead of assumed.
    act(() => { vi.advanceTimersByTime(300); });
    const slider = await vi.waitFor(() => screen.getByRole('slider', { name: 'Color budget, 24 colors' }));
    expect(slider).toHaveAttribute('min', '1');
    expect(slider).toHaveAttribute('max', String(DEFAULT_CATALOG_COLOR_COUNT));
    expect(slider).toHaveAttribute('step', '1');
    fireEvent.change(slider, { target: { value: '12' } });
    expect(screen.getByRole('slider', { name: 'Color budget, 12 colors' })).toHaveValue('12');
    expect(screen.getByLabelText('Color budget count')).toHaveValue('12');
    expect(screen.getByText('colors')).toBeInTheDocument();
  });

  it('passes the supplied catalog snapshot and bounds the budget by its color count', async () => {
    const smallCatalog: CatalogSnapshot = {
      association: { ...DEFAULT_CATALOG_DEFINITION.association, catalogId: 'small-catalog', colorCount: 2 },
      records: DEFAULT_CATALOG_DEFINITION.records.slice(0, 2)
    };
    render(<ControlledModal catalog={smallCatalog} />);
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    act(() => { images[0].onload?.(); });
    act(() => { vi.advanceTimersByTime(300); });
    const slider = await vi.waitFor(() => screen.getByRole('slider', { name: 'Color budget, 2 colors' }));
    expect(slider).toHaveAttribute('max', '2');
    expect(conversion.convert.mock.calls[0][1]).toMatchObject({ catalog: smallCatalog, paletteBudget: 2 });
  });

  it('keeps the accepted preview visible while replacing it and retains it on failure', async () => {
    render(<ControlledModal />);
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['image'], 'image.png', { type: 'image/png' })] } });
    act(() => { images[0].onload?.(); });
    act(() => { vi.advanceTimersByTime(300); });
    await vi.waitFor(() => expect(screen.getByLabelText('Converted pattern preview')).toBeInTheDocument());
    const preview = screen.getByLabelText('Converted pattern preview');
    expect(preview).toHaveAttribute('width', '512');
    expect(preview).toHaveAttribute('height', '512');
    expect(preview).toHaveClass('conversion-preview');

    conversion.convert.mockRejectedValueOnce(new Error('Replacement failed.'));
    fireEvent.change(screen.getByRole('slider', { name: /Color budget/ }), { target: { value: '12' } });
    expect(screen.getByLabelText('Converted pattern preview')).toBeInTheDocument();
    expect(screen.getByText('Updating preview')).toHaveClass('sr-only');
    act(() => { vi.advanceTimersByTime(300); });
    await vi.waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Replacement failed.'));
    expect(screen.getByLabelText('Converted pattern preview')).toBeInTheDocument();
  });

  it('does not render a layout-shifting converting banner', () => {
    conversion.convert.mockImplementationOnce(() => new Promise(() => undefined));
    render(<ControlledModal />);
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['image'], 'image.png', { type: 'image/png' })] } });
    act(() => { images[0].onload?.(); });
    act(() => { vi.advanceTimersByTime(300); });

    expect(screen.queryByText('Converting image…')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Convert image')).toHaveAttribute('aria-busy', 'true');
  });

  it('waits for the selected image dimensions before starting its debounce', () => {
    render(<ControlledModal />);
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    act(() => { vi.advanceTimersByTime(300); });
    expect(conversion.convert).not.toHaveBeenCalled();

    images[0].naturalWidth = 640;
    images[0].naturalHeight = 480;
    act(() => { images[0].onload?.(); });
    // A 640px long side at 14-count would span ~46in, so the prefill divides
    // down by d=4 to 160×120 (~11.4in long side).
    expect(screen.getByLabelText('Width')).toHaveValue('160');
    expect(screen.getByLabelText('Height')).toHaveValue('120');
    act(() => { vi.advanceTimersByTime(300); });
    expect(conversion.convert).toHaveBeenCalledOnce();
    expect(conversion.convert.mock.calls[0][1]).toMatchObject({ targetWidth: 160, targetHeight: 120 });
  });

  it('invalidates and reruns the preview when the catalog association changes', async () => {
    const alternate: CatalogSnapshot = {
      association: { ...DEFAULT_CATALOG_DEFINITION.association, catalogId: 'future-catalog-revision' },
      records: DEFAULT_CATALOG_DEFINITION.records
    };
    const view = render(<ControlledModal catalog={DEFAULT_CATALOG_DEFINITION.snapshot} />);
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    act(() => { images[0].onload?.(); });
    act(() => { vi.advanceTimersByTime(300); });
    await vi.waitFor(() => expect(conversion.convert).toHaveBeenCalledOnce());

    view.rerender(<ControlledModal catalog={alternate} />);
    act(() => { vi.advanceTimersByTime(300); });
    await vi.waitFor(() => expect(conversion.convert).toHaveBeenCalledTimes(2));
  });

  it('does not publish an old request after the catalog changes before it resolves', async () => {
    let resolveOld!: (value: unknown) => void;
    const staleDraft = {
      draft: {
        stats: { sourceWidth: 640, sourceHeight: 480, matchedColorCount: 1 },
        document: { width: 2, height: 2, palette: [], colors: new Uint16Array(16) }
      }
    };
    const replacementDraft = {
      draft: {
        stats: { sourceWidth: 640, sourceHeight: 480, matchedColorCount: 3 },
        document: { width: 2, height: 2, palette: [], colors: new Uint16Array(16) }
      }
    };
    conversion.convert.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    conversion.convert.mockResolvedValueOnce(replacementDraft);
    const alternate: CatalogSnapshot = {
      association: { ...DEFAULT_CATALOG_DEFINITION.association, catalogId: 'future-catalog-revision' },
      records: DEFAULT_CATALOG_DEFINITION.records
    };
    const view = render(<ControlledModal catalog={DEFAULT_CATALOG_DEFINITION.snapshot} />);
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    act(() => { images[0].onload?.(); });
    act(() => { vi.advanceTimersByTime(300); });
    expect(conversion.convert).toHaveBeenCalledOnce();

    view.rerender(<ControlledModal catalog={alternate} />);
    await act(async () => {
      resolveOld(staleDraft);
      await Promise.resolve();
    });
    expect(screen.queryByLabelText('Color budget count')).not.toBeInTheDocument();
    expect(conversion.convert).toHaveBeenCalledOnce();

    act(() => { vi.advanceTimersByTime(300); });
    await vi.waitFor(() => expect(conversion.convert).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(screen.getByLabelText('Color budget count')).toHaveValue('3'));
  });

  it('ignores an older decode and every decode after close', () => {
    const onClose = vi.fn();
    render(<ControlledModal onClose={onClose} />);
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    const oldImage = images[0];
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['two'], 'two.png', { type: 'image/png' })] } });
    oldImage.naturalWidth = 11; oldImage.naturalHeight = 12;
    act(() => { oldImage.onload?.(); });
    // The current decode is still pending, so the gated controls stay hidden.
    expect(screen.queryByLabelText('Width')).not.toBeInTheDocument();

    const currentImage = images[1];
    currentImage.naturalWidth = 21; currentImage.naturalHeight = 22;
    fireEvent.click(screen.getByRole('button', { name: 'Close create pattern dialog' }));
    act(() => { currentImage.onload?.(); });
    expect(onClose).toHaveBeenCalledOnce();
    // Closing clears the file work, so the gated controls never appear.
    expect(screen.queryByLabelText('Width')).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(600); });
    expect(conversion.convert).not.toHaveBeenCalled();
  });

  it('keeps manual dimensions while allowing the successful decode to convert', () => {
    render(<ControlledModal />);
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['slow'], 'slow.png', { type: 'image/png' })] } });
    images[0].naturalWidth = 640;
    images[0].naturalHeight = 480;
    act(() => { images[0].onload?.(); });
    // Unlock the aspect ratio so the width override does not derive the height.
    fireEvent.click(screen.getByRole('button', { name: 'Lock aspect ratio' }));
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '77' } });
    act(() => { vi.advanceTimersByTime(600); });

    expect(screen.getByLabelText('Width')).toHaveValue('77');
    expect(screen.getByLabelText('Height')).toHaveValue('120');
    expect(conversion.convert).toHaveBeenCalledOnce();
    expect(conversion.convert.mock.calls[0][1]).toMatchObject({ targetWidth: 77, targetHeight: 120 });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('leaves a decode error visible and does not request conversion', () => {
    render(<ControlledModal />);
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['bad'], 'bad.png', { type: 'image/png' })] } });
    act(() => { images[0].onerror?.(); vi.advanceTimersByTime(600); });

    expect(screen.getByRole('alert')).toHaveTextContent(/dimensions could not be read/i);
    expect(conversion.convert).not.toHaveBeenCalled();
  });

  it('keeps the source image reference and the aspect ratio lock on by default', () => {
    render(<ControlledModal />);
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    act(() => { images[0].onload?.(); });
    expect(screen.getByLabelText('Keep source image as a reference')).toBeChecked();
    const toggle = screen.getByRole('button', { name: 'Lock aspect ratio' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(toggle).toBeEnabled();
    expect(toggle).toHaveTextContent('🔒');
    const control = toggle.parentElement as HTMLElement;
    expect(control).toHaveClass('aspect-lock-control');
    expect(control.querySelector('.aspect-lock-label')).toHaveTextContent('aspect ratio');
    expect(control.previousElementSibling?.querySelector('input')?.id).toBe('conversion-width');
    expect(control.nextElementSibling?.querySelector('input')?.id).toBe('conversion-height');
  });

  it('derives the other dimension from the source ratio while locked and stops when unlocked', () => {
    render(<ControlledModal />);
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    images[0].naturalWidth = 640;
    images[0].naturalHeight = 480;
    act(() => { images[0].onload?.(); });
    const toggle = screen.getByRole('button', { name: 'Lock aspect ratio' });
    expect(toggle).toBeEnabled();

    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '320' } });
    expect(screen.getByLabelText('Height')).toHaveValue('240');
    fireEvent.change(screen.getByLabelText('Height'), { target: { value: '360' } });
    expect(screen.getByLabelText('Width')).toHaveValue('480');

    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Lock aspect ratio' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Lock aspect ratio' })).toHaveTextContent('🔓');
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '400' } });
    expect(screen.getByLabelText('Height')).toHaveValue('360');
  });

  it('clamps the derived dimension so the locked pair stays within 1,000,000 cells', () => {
    render(<ControlledModal />);
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    images[0].naturalWidth = 640;
    images[0].naturalHeight = 480;
    act(() => { images[0].onload?.(); });

    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '2000' } });
    // round(2000 * 480 / 640) = 1500 -> axis clamp 1000 -> product cap floor(1e6 / 2000) = 500
    expect(screen.getByLabelText('Height')).toHaveValue('500');
  });

  it('keeps the color budget within the slider bounds without a number input', async () => {
    render(<ControlledModal />);
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    act(() => { images[0].onload?.(); });
    act(() => { vi.advanceTimersByTime(300); });
    const slider = await vi.waitFor(() => screen.getByRole('slider', { name: /Color budget/ }));
    expect(slider).toHaveAttribute('min', '1');
    expect(slider).toHaveAttribute('max', String(DEFAULT_CATALOG_COLOR_COUNT));
    // The number input no longer exists; the slider alone drives the budget.
    expect(screen.queryByLabelText('Detected color count')).not.toBeInTheDocument();
    fireEvent.change(slider, { target: { value: String(DEFAULT_CATALOG_COLOR_COUNT) } });
    act(() => { vi.advanceTimersByTime(300); });
    expect(conversion.convert.mock.calls[1][1]).toMatchObject({ paletteBudget: DEFAULT_CATALOG_COLOR_COUNT });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('caps the color budget slider at the draft matched color count and clamps an over-budget value', async () => {
    const makeDraft = (count: number) => ({ draft: { stats: { sourceWidth: 2, sourceHeight: 1, matchedColorCount: count }, document: { width: 2, height: 1, palette: ['red', 'green', 'blue'].map((id, index) => ({ id: index + 1, name: id, color: '#ff0000', active: true, symbol: `S${index + 1}`, catalog: { catalogId: 'dmc', sourceId: id, code: id, name: id, hex: '#ff0000', rgb: [255, 0, 0] } })), colors: new Uint16Array(4) } } });
    conversion.convert.mockResolvedValue(makeDraft(3));
    render(<ControlledModal />);
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    act(() => { images[0].onload?.(); });
    act(() => { vi.advanceTimersByTime(300); });
    // First conversion ran with the default budget; the result reports only 3
    // matched colors. Await the draft (microtasks drain inside vi.waitFor) so
    // the clamp can schedule the follow-up conversion, then re-convert.
    await vi.waitFor(() => expect(screen.getByRole('slider', { name: /Color budget/ })).toHaveAttribute('max', '3'));
    expect(conversion.convert).toHaveBeenCalledTimes(1);
    expect(conversion.convert.mock.calls[0][1]).toMatchObject({ paletteBudget: 24 });
    act(() => { vi.advanceTimersByTime(300); });
    expect(conversion.convert).toHaveBeenCalledTimes(2);
    expect(conversion.convert.mock.calls[1][1]).toMatchObject({ paletteBudget: 3 });
    // Already at the cap: the clamped budget settles without further churn.
    act(() => { vi.advanceTimersByTime(600); });
    expect(conversion.convert).toHaveBeenCalledTimes(2);
    // The budget slider sits inside the review, before the swatch row.
    const slider = screen.getByRole('slider', { name: /Color budget/ });
    const review = slider.closest('.review') as HTMLElement;
    const swatchRow = review.querySelector('.review-swatches') as HTMLElement;
    expect(slider.compareDocumentPosition(swatchRow) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it('steps the color budget down and up through debounced conversions', async () => {
    render(<ControlledModal />);
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    act(() => { images[0].onload?.(); });
    act(() => { vi.advanceTimersByTime(300); });
    await vi.waitFor(() => screen.getByRole('slider', { name: 'Color budget, 24 colors' }));
    expect(conversion.convert).toHaveBeenCalledTimes(1);
    expect(conversion.convert.mock.calls[0][1]).toMatchObject({ paletteBudget: 24 });

    fireEvent.click(screen.getByRole('button', { name: 'Decrease color budget' }));
    expect(screen.getByLabelText('Color budget count')).toHaveValue('23');
    expect(screen.getByRole('slider', { name: 'Color budget, 23 colors' })).toHaveValue('23');
    act(() => { vi.advanceTimersByTime(300); });
    await vi.waitFor(() => expect(conversion.convert).toHaveBeenCalledTimes(2));
    expect(conversion.convert.mock.calls[1][1]).toMatchObject({ paletteBudget: 23 });

    fireEvent.click(screen.getByRole('button', { name: 'Increase color budget' }));
    expect(screen.getByLabelText('Color budget count')).toHaveValue('24');
    act(() => { vi.advanceTimersByTime(300); });
    await vi.waitFor(() => expect(conversion.convert).toHaveBeenCalledTimes(3));
    expect(conversion.convert.mock.calls[2][1]).toMatchObject({ paletteBudget: 24 });
  });

  it('disables the decrement step at 1 without conversion churn', async () => {
    render(<ControlledModal />);
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    act(() => { images[0].onload?.(); });
    act(() => { vi.advanceTimersByTime(300); });
    await vi.waitFor(() => screen.getByRole('slider', { name: /Color budget/ }));

    fireEvent.change(screen.getByRole('slider', { name: /Color budget/ }), { target: { value: '1' } });
    act(() => { vi.advanceTimersByTime(300); });
    await vi.waitFor(() => expect(screen.getByRole('slider', { name: 'Color budget, 1 colors' })).toBeInTheDocument());
    expect(conversion.convert).toHaveBeenCalledTimes(2);
    expect(conversion.convert.mock.calls[1][1]).toMatchObject({ paletteBudget: 1 });

    const decrease = screen.getByRole('button', { name: 'Decrease color budget' });
    const increase = screen.getByRole('button', { name: 'Increase color budget' });
    expect(decrease).toBeDisabled();
    expect(increase).toBeEnabled();
    expect(screen.getByLabelText('Color budget count')).toHaveValue('1');
    // A disabled step never fires, so idling at the bound stays quiet.
    act(() => { vi.advanceTimersByTime(600); });
    expect(conversion.convert).toHaveBeenCalledTimes(2);

    fireEvent.click(increase);
    expect(screen.getByLabelText('Color budget count')).toHaveValue('2');
    act(() => { vi.advanceTimersByTime(300); });
    await vi.waitFor(() => expect(conversion.convert).toHaveBeenCalledTimes(3));
    expect(conversion.convert.mock.calls[2][1]).toMatchObject({ paletteBudget: 2 });
    expect(screen.getByRole('button', { name: 'Decrease color budget' })).toBeEnabled();
  });

  it('disables the increment step at the dynamic matched-count max', async () => {
    const makeDraft = (count: number) => ({ draft: { stats: { sourceWidth: 2, sourceHeight: 1, matchedColorCount: count }, document: { width: 2, height: 1, palette: ['red', 'green', 'blue'].map((id, index) => ({ id: index + 1, name: id, color: '#ff0000', active: true, symbol: `S${index + 1}`, catalog: { catalogId: 'dmc', sourceId: id, code: id, name: id, hex: '#ff0000', rgb: [255, 0, 0] } })), colors: new Uint16Array(4) } } });
    conversion.convert.mockResolvedValue(makeDraft(5));
    render(<ControlledModal />);
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    act(() => { images[0].onload?.(); });
    act(() => { vi.advanceTimersByTime(300); });
    // Default 24 exceeds the 5-color match, so the draft clamps and re-converts.
    await vi.waitFor(() => expect(screen.getByRole('slider', { name: 'Color budget, 5 colors' })).toBeInTheDocument());
    act(() => { vi.advanceTimersByTime(300); });
    await vi.waitFor(() => expect(conversion.convert).toHaveBeenCalledTimes(2));
    expect(conversion.convert.mock.calls[1][1]).toMatchObject({ paletteBudget: 5 });

    const slider = screen.getByRole('slider', { name: /Color budget/ });
    expect(slider).toHaveAttribute('max', '5');
    expect(screen.getByRole('button', { name: 'Increase color budget' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Decrease color budget' })).toBeEnabled();
    expect(screen.getByLabelText('Color budget count')).toHaveValue('5');
    act(() => { vi.advanceTimersByTime(600); });
    expect(conversion.convert).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Decrease color budget' }));
    act(() => { vi.advanceTimersByTime(300); });
    await vi.waitFor(() => expect(conversion.convert).toHaveBeenCalledTimes(3));
    expect(conversion.convert.mock.calls[2][1]).toMatchObject({ paletteBudget: 4 });
    expect(screen.getByRole('button', { name: 'Increase color budget' })).toBeEnabled();
  });

  it('commits a typed budget on blur and on Enter with a new conversion', async () => {
    render(<ControlledModal />);
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    act(() => { images[0].onload?.(); });
    act(() => { vi.advanceTimersByTime(300); });
    await vi.waitFor(() => screen.getByRole('slider', { name: 'Color budget, 24 colors' }));
    expect(conversion.convert).toHaveBeenCalledTimes(1);

    // Typing alone only edits the draft; the slider and request stay put.
    fireEvent.change(screen.getByLabelText('Color budget count'), { target: { value: '12' } });
    expect(screen.getByLabelText('Color budget count')).toHaveValue('12');
    expect(screen.getByRole('slider', { name: 'Color budget, 24 colors' })).toHaveValue('24');
    expect(conversion.convert).toHaveBeenCalledTimes(1);

    fireEvent.blur(screen.getByLabelText('Color budget count'));
    expect(screen.getByRole('slider', { name: 'Color budget, 12 colors' })).toHaveValue('12');
    act(() => { vi.advanceTimersByTime(300); });
    await vi.waitFor(() => expect(conversion.convert).toHaveBeenCalledTimes(2));
    expect(conversion.convert.mock.calls[1][1]).toMatchObject({ paletteBudget: 12 });

    fireEvent.change(screen.getByLabelText('Color budget count'), { target: { value: '15' } });
    fireEvent.keyDown(screen.getByLabelText('Color budget count'), { key: 'Enter' });
    expect(screen.getByRole('slider', { name: 'Color budget, 15 colors' })).toHaveValue('15');
    act(() => { vi.advanceTimersByTime(300); });
    await vi.waitFor(() => expect(conversion.convert).toHaveBeenCalledTimes(3));
    expect(conversion.convert.mock.calls[2][1]).toMatchObject({ paletteBudget: 15 });
  });

  it('reverts garbage, empty, and out-of-range budgets without converting', async () => {
    render(<ControlledModal />);
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    act(() => { images[0].onload?.(); });
    act(() => { vi.advanceTimersByTime(300); });
    await vi.waitFor(() => screen.getByRole('slider', { name: 'Color budget, 24 colors' }));
    expect(conversion.convert).toHaveBeenCalledTimes(1);

    for (const bad of ['garbage', '', '0', '999', '12.5']) {
      fireEvent.change(screen.getByLabelText('Color budget count'), { target: { value: bad } });
      expect(screen.getByLabelText('Color budget count')).toHaveValue(bad);
      fireEvent.blur(screen.getByLabelText('Color budget count'));
      // Invalid entries revert to the committed budget and stay quiet.
      expect(screen.getByLabelText('Color budget count')).toHaveValue('24');
      expect(screen.getByRole('slider', { name: 'Color budget, 24 colors' })).toHaveValue('24');
      act(() => { vi.advanceTimersByTime(600); });
      expect(conversion.convert).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    }
  });

  it('commits a typed budget of 1 through a debounced conversion', async () => {
    render(<ControlledModal />);
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    act(() => { images[0].onload?.(); });
    act(() => { vi.advanceTimersByTime(300); });
    await vi.waitFor(() => screen.getByRole('slider', { name: 'Color budget, 24 colors' }));
    expect(conversion.convert).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('Color budget count'), { target: { value: '1' } });
    fireEvent.blur(screen.getByLabelText('Color budget count'));
    expect(screen.getByRole('slider', { name: 'Color budget, 1 colors' })).toHaveValue('1');
    act(() => { vi.advanceTimersByTime(300); });
    await vi.waitFor(() => expect(conversion.convert).toHaveBeenCalledTimes(2));
    expect(conversion.convert.mock.calls[1][1]).toMatchObject({ paletteBudget: 1 });
  });

  it('re-committing the current budget does not fire a conversion', async () => {
    render(<ControlledModal />);
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    act(() => { images[0].onload?.(); });
    act(() => { vi.advanceTimersByTime(300); });
    await vi.waitFor(() => screen.getByRole('slider', { name: 'Color budget, 24 colors' }));
    expect(conversion.convert).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('Color budget count'), { target: { value: '24' } });
    fireEvent.blur(screen.getByLabelText('Color budget count'));
    act(() => { vi.advanceTimersByTime(600); });
    expect(conversion.convert).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('slider', { name: 'Color budget, 24 colors' })).toBeInTheDocument();
  });

  it('marks a review swatch as the background color and re-converts with it', async () => {
    const withRed = { draft: { stats: { sourceWidth: 2, sourceHeight: 1 }, document: { width: 2, height: 1, palette: ['red', 'blue'].map((id, index) => ({ id: index + 1, name: id, color: '#ff0000', active: true, symbol: `S${index + 1}`, catalog: { catalogId: 'dmc', sourceId: id, code: id, name: id, hex: '#ff0000', rgb: [255, 0, 0] } })), colors: new Uint16Array(4) } } };
    conversion.convert.mockResolvedValueOnce(withRed);
    render(<ControlledModal />);
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    act(() => { images[0].onload?.(); });
    act(() => { vi.advanceTimersByTime(300); });
    // Await the draft render before touching review content.
    const redSwatch = await vi.waitFor(() => screen.getByRole('button', { name: 'Use red as background' }));
    // The selectable-swatch affordance labels and hints the row.
    expect(screen.getByRole('heading', { name: 'Detected colors' })).toBeInTheDocument();
    expect(screen.getByText('Click a color to set it as the background.')).toBeInTheDocument();
    expect(redSwatch).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(redSwatch);
    expect(screen.getByRole('button', { name: 'Use red as background' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Clear background selection' })).toBeInTheDocument();

    conversion.convert.mockResolvedValueOnce(withRed);
    act(() => { vi.advanceTimersByTime(300); });
    expect(conversion.convert).toHaveBeenCalledTimes(2);
    expect(conversion.convert.mock.calls[1][1]).toMatchObject({ backgroundSourceId: 'red' });
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Use red as background' })).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByRole('button', { name: 'Clear background selection' })).toBeInTheDocument();
  });

  it('keeps the background selection after re-conversion drops the color from the palette', async () => {
    const draftWith = (ids: string[]) => ({ draft: { stats: { sourceWidth: 2, sourceHeight: 1 }, document: { width: 2, height: 1, palette: ids.map((id, index) => ({ id: index + 1, name: id, color: '#ff0000', active: true, symbol: `S${index + 1}`, catalog: { catalogId: 'dmc', sourceId: id, code: id, name: id, hex: '#ff0000', rgb: [255, 0, 0] } })), colors: new Uint16Array(4) } } });
    conversion.convert.mockResolvedValueOnce(draftWith(['red', 'blue']));
    render(<ControlledModal />);
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    act(() => { images[0].onload?.(); });
    act(() => { vi.advanceTimersByTime(300); });
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Use red as background' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Use red as background' }));
    expect(screen.getByRole('button', { name: 'Use red as background' })).toHaveAttribute('aria-pressed', 'true');

    // The follow-up conversion runs with background=red, so red is absent
    // from its palette by design — the selection must persist regardless.
    conversion.convert.mockResolvedValueOnce(draftWith(['blue']));
    act(() => { vi.advanceTimersByTime(300); });
    expect(conversion.convert).toHaveBeenCalledTimes(2);
    expect(conversion.convert.mock.calls[1][1]).toMatchObject({ backgroundSourceId: 'red' });
    // Wait for the second draft to settle: red drops out of the rendered
    // palette by design, while the selection state persists.
    await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Use red as background' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Clear background selection' })).toBeInTheDocument();
    // No auto-clear churn: settling must not schedule a third conversion.
    act(() => { vi.advanceTimersByTime(600); });
    expect(conversion.convert).toHaveBeenCalledTimes(2);
  });

  it('clears the background selection when a new file is chosen', async () => {
    const draftWith = (ids: string[]) => ({ draft: { stats: { sourceWidth: 2, sourceHeight: 1 }, document: { width: 2, height: 1, palette: ids.map((id, index) => ({ id: index + 1, name: id, color: '#ff0000', active: true, symbol: `S${index + 1}`, catalog: { catalogId: 'dmc', sourceId: id, code: id, name: id, hex: '#ff0000', rgb: [255, 0, 0] } })), colors: new Uint16Array(4) } } });
    conversion.convert.mockResolvedValueOnce(draftWith(['red', 'blue']));
    render(<ControlledModal />);
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    act(() => { images[0].onload?.(); });
    act(() => { vi.advanceTimersByTime(300); });
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Use red as background' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Use red as background' }));
    expect(screen.getByRole('button', { name: 'Clear background selection' })).toBeInTheDocument();

    // Choosing a new file resets the color context: the selection clears
    // immediately, before the new decode even resolves.
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['two'], 'two.png', { type: 'image/png' })] } });
    expect(screen.queryByRole('button', { name: 'Clear background selection' })).not.toBeInTheDocument();

    // The next conversion carries no background selection.
    act(() => { images[1].onload?.(); });
    act(() => { vi.advanceTimersByTime(300); });
    await vi.waitFor(() => expect(conversion.convert).toHaveBeenCalledTimes(2));
    expect(conversion.convert.mock.calls[1][1]).toMatchObject({ backgroundSourceId: undefined });
  });

  it('re-converts with autoCrop when the auto-crop checkbox is toggled', async () => {
    render(<ControlledModal />);
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    act(() => { images[0].onload?.(); });
    act(() => { vi.advanceTimersByTime(300); });
    await vi.waitFor(() => screen.getByRole('slider', { name: 'Color budget, 24 colors' }));
    const checkbox = screen.getByLabelText('Auto-crop to content edges');
    expect(checkbox).not.toBeChecked();
    expect(conversion.convert.mock.calls[0][1].autoCrop).toBeUndefined();
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    act(() => { vi.advanceTimersByTime(300); });
    await vi.waitFor(() => expect(conversion.convert).toHaveBeenCalledTimes(2));
    expect(conversion.convert.mock.calls[1][1]).toMatchObject({ autoCrop: true });
  });

  it('keeps the image controls hidden until a file is decoded and ready', async () => {    render(<ControlledModal />);
    // Before any file: only the upload and the title are visible.
    expect(screen.getByLabelText(/Choose a PNG/)).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toBeInTheDocument();
    expect(screen.queryByLabelText('Width')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Height')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Total stitch count' })).not.toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: /Color budget/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Keep source image as a reference')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Converted pattern preview')).not.toBeInTheDocument();

    // While decoding, the controls stay hidden.
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    expect(screen.queryByLabelText('Width')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Keep source image as a reference')).not.toBeInTheDocument();

    // Once the decode resolves, the gated controls appear.
    act(() => { images[0].onload?.(); });
    expect(screen.getByLabelText('Width')).toBeInTheDocument();
    expect(screen.getByLabelText('Height')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Total stitch count' })).toBeInTheDocument();
    expect(screen.getByLabelText('Keep source image as a reference')).toBeInTheDocument();
    // The budget slider is part of the review section, so it appears after the
    // first conversion completes.
    expect(screen.queryByRole('slider', { name: /Color budget/ })).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(300); });
    await vi.waitFor(() => expect(screen.getByRole('slider', { name: /Color budget/ })).toBeInTheDocument());
  });

  it('places the title above the file drop in the image mode field order', () => {
    render(<ControlledModal />);
    const title = screen.getByLabelText('Title');
    const upload = screen.getByLabelText(/Choose a PNG/);
    expect(title.compareDocumentPosition(upload) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it('clamps the lens sample region to the bitmap and the box to the frame', () => {
    // Bitmap 80x60, CSS 100x80, frame 120x120 at (0,0). Pointer at the
    // canvas top-left corner (10,20): the sample centers on the clamped
    // corner and the box stays inside the frame.
    const frame = { left: 0, top: 0, right: 120, bottom: 120 };
    const rect = { left: 10, top: 20, right: 110, bottom: 100 };
    const nearCorner = previewLensGeometry(80, 60, 100, 80, frame, rect, 10, 20);
    expect(nearCorner.sourceLeft).toBe(0);
    expect(nearCorner.sourceTop).toBe(0);
    expect(nearCorner.lensLeft).toBe(0);
    expect(nearCorner.lensTop).toBe(0);
    // Pointer at the canvas bottom-right corner (110,100): the sample cannot
    // fit the 80px-in-both-axes lens into a 60px-tall bitmap, so it clamps to
    // the corner (0,0). The frame (120px) is smaller than the 160px lens, so
    // the box pins to the origin to stay fully inside the frame.
    const farCorner = previewLensGeometry(80, 60, 100, 80, frame, rect, 110, 100);
    expect(farCorner.sourceLeft).toBe(0);
    expect(farCorner.sourceTop).toBe(0);
    expect(farCorner.lensLeft).toBe(0);
    expect(farCorner.lensTop).toBe(0);
  });

  it('shows and moves a decorative 2x preview lens while the pointer hovers', async () => {
    render(<ControlledModal />);
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    act(() => { images[0].onload?.(); });
    act(() => { vi.advanceTimersByTime(300); });
    const preview = await vi.waitFor(() => screen.getByLabelText('Converted pattern preview'));

    const lens = preview.parentElement!.querySelector('.preview-lens') as HTMLCanvasElement;
    expect(lens).toBeInTheDocument();
    expect(lens).toHaveAttribute('aria-hidden', 'true');
    expect(lens).toHaveAttribute('width', '160');
    expect(lens).toHaveAttribute('height', '160');
    expect(lens).toHaveAttribute('style', expect.stringContaining('opacity: 0'));
    expect(lens).toHaveAttribute('style', expect.stringContaining('pointer-events: none'));

    const rect = { left: 10, top: 20, width: 100, height: 80, right: 110, bottom: 100, toJSON: () => undefined };
    vi.spyOn(preview, 'getBoundingClientRect').mockReturnValue(rect as DOMRect);
    // Frame larger than the 160px lens so the box can follow the pointer.
    vi.spyOn(preview.parentElement!, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, toJSON: () => undefined } as DOMRect);

    // The lens context is unavailable in jsdom; drawing must be guarded and
    // the interaction must not crash.
    fireEvent.pointerEnter(preview, { pointerType: 'mouse', clientX: 30, clientY: 40 });
    fireEvent.pointerMove(preview, { pointerType: 'mouse', clientX: 60, clientY: 70 });
    expect(lens).toHaveAttribute('style', expect.stringContaining('opacity: 1'));
    // 60 - 160/2 = -20 clamped into the frame -> 0; 70 - 80 = -10 -> 0.
    expect(lens.style.left).toBe('0px');
    expect(lens.style.top).toBe('0px');
    // An in-bounds move updates the box position (follow behavior).
    fireEvent.pointerMove(preview, { pointerType: 'mouse', clientX: 100, clientY: 95 });
    expect(lens.style.left).toBe('20px');
    expect(lens.style.top).toBe('15px');
    // Leaving hides it again.
    fireEvent.pointerLeave(preview);
    expect(lens).toHaveAttribute('style', expect.stringContaining('opacity: 0'));
  });

  it('ignores touch pointers and never shows the lens for them', async () => {
    render(<ControlledModal />);
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    act(() => { images[0].onload?.(); });
    act(() => { vi.advanceTimersByTime(300); });
    const preview = await vi.waitFor(() => screen.getByLabelText('Converted pattern preview'));
    const lens = preview.parentElement!.querySelector('.preview-lens') as HTMLCanvasElement;

    vi.spyOn(preview, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, width: 100, height: 80, right: 110, bottom: 100, toJSON: () => undefined } as DOMRect);
    vi.spyOn(preview.parentElement!, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, toJSON: () => undefined } as DOMRect);
    fireEvent.pointerEnter(preview, { pointerType: 'touch', clientX: 30, clientY: 40 });
    fireEvent.pointerMove(preview, { pointerType: 'touch', clientX: 60, clientY: 70 });
    expect(lens).toHaveAttribute('style', expect.stringContaining('opacity: 0'));
    // A mouse pointer still works afterwards (reset the position mocks the
    // component refetches on every event).
    fireEvent.pointerEnter(preview, { pointerType: 'mouse', clientX: 30, clientY: 40 });
    fireEvent.pointerMove(preview, { pointerType: 'mouse', clientX: 40, clientY: 50 });
    expect(lens).toHaveAttribute('style', expect.stringContaining('opacity: 1'));
  });

  it('closes via the × button in blank mode', () => {
    const onClose = vi.fn();
    render(<CreateModal {...props(onClose)} mode="blank" />);
    fireEvent.click(screen.getByRole('button', { name: 'Close create pattern dialog' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on backdrop click but not on clicks inside the dialog', () => {
    const onClose = vi.fn();
    render(<ControlledModal onClose={onClose} />);
    const dialog = screen.getByRole('dialog');
    const backdrop = dialog.parentElement as HTMLElement;
    expect(backdrop).toHaveClass('modal-backdrop');
    fireEvent.click(screen.getByLabelText('Title'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<ControlledModal onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('ignores Escape and backdrop clicks while creating', async () => {
    const onClose = vi.fn();
    const onConversionCreate = vi.fn().mockReturnValue(new Promise<string>(() => {}));
    const CreatingModal = () => {
      const [width, setWidth] = useState('100');
      const [height, setHeight] = useState('100');
      return <CreateModal {...props(onClose)} width={width} height={height} onWidth={setWidth} onHeight={setHeight} onConversionCreate={onConversionCreate} />;
    };
    render(<CreatingModal />);
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    act(() => { images[0].onload?.(); });
    act(() => { vi.advanceTimersByTime(300); });
    await vi.waitFor(() => screen.getByRole('slider', { name: /Color budget/ }));
    const create = await vi.waitFor(() => {
      const button = screen.getByRole('button', { name: 'Create from image' });
      expect(button).toBeEnabled();
      return button;
    });
    fireEvent.click(create);
    expect(screen.getByRole('button', { name: 'Close create pattern dialog' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    const backdrop = screen.getByRole('dialog').parentElement as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('offers an Aida count select with the catalog options in blank mode', () => {
    const p = props();
    render(<CreateModal {...p} mode="blank" />);
    const select = screen.getByLabelText('Aida count');
    expect(select).toHaveValue('14');
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['11', '14', '16', '18', '22']);
    fireEvent.change(select, { target: { value: '18' } });
    expect(p.onAida).toHaveBeenCalledWith('18');
  });

  it('gates the Aida count select on a decoded image without reconverting', async () => {
    render(<ControlledModal />);
    expect(screen.queryByLabelText('Aida count')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    act(() => { images[0].onload?.(); });
    act(() => { vi.advanceTimersByTime(300); });
    const select = await vi.waitFor(() => screen.getByLabelText('Aida count'));
    expect(select).toHaveValue('14');
    expect(conversion.convert).toHaveBeenCalledTimes(1);
    // Aida is project metadata, not a conversion input: changing it must not
    // schedule another conversion or disturb the committed budget.
    fireEvent.change(select, { target: { value: '22' } });
    expect(select).toHaveValue('22');
    act(() => { vi.advanceTimersByTime(600); });
    expect(conversion.convert).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('slider', { name: 'Color budget, 24 colors' })).toBeInTheDocument();
    expect(screen.getByLabelText('Color budget count')).toHaveValue('24');
  });

  it('shows a live expected finished size in blank mode', () => {
    const expected = previewFinishedSize('100', '80', '16');
    expect(expected).not.toBeNull();
    render(<CreateModal {...props()} mode="blank" width="100" height="80" aida="16" />);
    expect(screen.getByText(`Expected finished size: ${expected}`)).toBeInTheDocument();
  });

  it('updates the blank expected size when the aida selection changes', () => {
    const p = props();
    const view = render(<CreateModal {...p} mode="blank" />);
    expect(screen.getByText(`Expected finished size: ${previewFinishedSize('100', '100', '14')}`)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Aida count'), { target: { value: '22' } });
    expect(p.onAida).toHaveBeenCalledWith('22');
    view.rerender(<CreateModal {...p} mode="blank" aida="22" />);
    expect(screen.getByText(`Expected finished size: ${previewFinishedSize('100', '100', '22')}`)).toBeInTheDocument();
    expect(screen.queryByText(/at 14-count Aida/)).not.toBeInTheDocument();
  });

  it('hides the expected size while dimensions are invalid', () => {
    expect(previewFinishedSize('0', '100', '14')).toBeNull();
    expect(previewFinishedSize('abc', '100', '14')).toBeNull();
    expect(previewFinishedSize('2000', '100', '14')).toBeNull();
    expect(previewFinishedSize('1000', '1001', '14')).toBeNull();
    const view = render(<CreateModal {...props()} mode="blank" width="0" height="100" />);
    expect(screen.queryByText(/Expected finished size/)).not.toBeInTheDocument();
    view.rerender(<CreateModal {...props()} mode="blank" width="abc" height="100" />);
    expect(screen.queryByText(/Expected finished size/)).not.toBeInTheDocument();
    view.rerender(<CreateModal {...props()} mode="blank" width="2000" height="100" />);
    expect(screen.queryByText(/Expected finished size/)).not.toBeInTheDocument();
    view.rerender(<CreateModal {...props()} mode="blank" width="100" height="100" />);
    expect(screen.getByText(/Expected finished size: /)).toBeInTheDocument();
  });

  it('shows the expected size in the image review from target dims and aida', async () => {
    render(<ControlledModal />);
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    act(() => { images[0].onload?.(); });
    act(() => { vi.advanceTimersByTime(300); });
    await vi.waitFor(() => screen.getByRole('slider', { name: /Color budget/ }));
    // Decode prefills 1×1 target dims; aida defaults to 14.
    const expected = previewFinishedSize('1', '1', '14');
    expect(expected).not.toBeNull();
    expect(screen.getByText(`Expected finished size: ${expected}`)).toBeInTheDocument();
    // Changing aida updates the review line without reconverting.
    const calls = conversion.convert.mock.calls.length;
    fireEvent.change(screen.getByLabelText('Aida count'), { target: { value: '18' } });
    expect(screen.getByText(`Expected finished size: ${previewFinishedSize('1', '1', '18')}`)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(600); });
    expect(conversion.convert.mock.calls.length).toBe(calls);
  });

  it('suggests closest exact-division dims for oversized images', () => {
    // 1568px at 14-count targets 196px: divisor d=8 hits it exactly.
    expect(suggestConversionDimensions(1568, 784, 14)).toEqual({ width: 196, height: 98 });
    // 1275×1875 (gcd 75): d=15 gives 85×125, the long side closest to 196.
    expect(suggestConversionDimensions(1275, 1875, 14)).toEqual({ width: 85, height: 125 });
    // 4000×3000: d=20 gives 200×150 (4px over target), preferred over shrinking further.
    expect(suggestConversionDimensions(4000, 3000, 14)).toEqual({ width: 200, height: 150 });
    // Portrait orientation divides on the height long side.
    expect(suggestConversionDimensions(784, 1568, 14)).toEqual({ width: 98, height: 196 });
    // A custom target works the same way: 1568px at 7in/14ct targets 98px via d=16.
    expect(suggestConversionDimensions(1568, 784, 14, 7)).toEqual({ width: 98, height: 49 });
  });

  it('breaks equidistant long sides toward the smaller one', () => {
    // Synthetic tie: longs 150 (d=2) and 75 (d=4) are both 37.5px from the
    // 112.5px target, so the smaller long side (d=4) must win deterministically.
    expect(suggestConversionDimensions(300, 200, 112.5, 1)).toEqual({ width: 75, height: 50 });
  });

  it('falls back to power-of-two snap when no exact division fits', () => {
    // 2003×1501 are coprime (gcd 1) and exceed the axis limits, so no exact
    // division is valid: the fallback snaps to 2^-4 → 125×94.
    expect(suggestConversionDimensions(2003, 1501, 14)).toEqual({ width: 125, height: 94 });
  });

  it('passes small images through and guards invalid inputs', () => {
    expect(suggestConversionDimensions(100, 80, 14)).toEqual({ width: 100, height: 80 });
    expect(suggestConversionDimensions(196, 100, 14)).toEqual({ width: 196, height: 100 });
    expect(suggestConversionDimensions(0, 100, 14)).toEqual({ width: 0, height: 100 });
    expect(suggestConversionDimensions(Number.NaN, 100, 14)).toEqual({ width: Number.NaN, height: 100 });
    expect(suggestConversionDimensions(100.5, 80, 14)).toEqual({ width: 100.5, height: 80 });
    expect(suggestConversionDimensions(640, 480, 0)).toEqual({ width: 640, height: 480 });
  });

  it('prefills suggested dims when a large file decodes', () => {
    render(<ControlledModal />);
    fireEvent.change(screen.getByLabelText(/Choose a PNG/), { target: { files: [new File(['big'], 'big.png', { type: 'image/png' })] } });
    images[0].naturalWidth = 1568;
    images[0].naturalHeight = 784;
    act(() => { images[0].onload?.(); });
    // 1568×784 at the default 14-count Aida prefills 196×98 (~14in long side).
    expect(screen.getByLabelText('Width')).toHaveValue('196');
    expect(screen.getByLabelText('Height')).toHaveValue('98');
  });
});
