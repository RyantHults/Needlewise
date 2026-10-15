import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PDFPageProxy } from 'pdfjs-dist';
import { renderPageThumbnail } from './thumbnail';

function fakePage(render: () => Promise<void>) {
  return {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 400 * scale, height: 600 * scale })),
    render: vi.fn(() => ({ promise: render() })),
    cleanup: vi.fn()
  };
}

class FakeOffscreenCanvas {
  constructor(readonly width: number, readonly height: number) {}
  convertToBlob = vi.fn(async (options: { type: string }) => new Blob(['png'], { type: options.type }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('renderPageThumbnail', () => {
  it('returns undefined without OffscreenCanvas and does not touch the page', async () => {
    expect(typeof OffscreenCanvas).toBe('undefined');
    const page = fakePage(async () => undefined);
    await expect(renderPageThumbnail(page as unknown as PDFPageProxy)).resolves.toBeUndefined();
    expect(page.render).not.toHaveBeenCalled();
  });

  it('renders at the target width into a PNG', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    const page = fakePage(async () => undefined);
    const blob = await renderPageThumbnail(page as unknown as PDFPageProxy, 100);
    expect(blob?.type).toBe('image/png');
    const [[params]] = page.render.mock.calls as unknown as [[{ canvas: FakeOffscreenCanvas; viewport: { width: number } }]];
    expect([params.canvas.width, params.canvas.height]).toEqual([100, 150]);
    expect(page.cleanup).toHaveBeenCalledOnce();
  });

  it('returns undefined when rendering fails', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    const page = fakePage(async () => { throw new Error('bad operator'); });
    await expect(renderPageThumbnail(page as unknown as PDFPageProxy)).resolves.toBeUndefined();
    expect(page.cleanup).toHaveBeenCalledOnce();
  });
});
