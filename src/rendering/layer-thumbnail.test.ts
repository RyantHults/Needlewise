import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLayeredDocument, CellKind, FIXED_POINT_UNITS_PER_CELL, type SpecialtyLayer, type StitchLayer } from '../domain';
import { createThumbnailScheduler, renderLayerThumbnailPixels, thumbnailDimensions } from './layer-thumbnail';

const catalog = { catalogId: 'test', brandLabel: 'Test', colorCount: 500 } as never;
const makeDocument = (width: number, height: number) => createLayeredDocument({
  width,
  height,
  catalog,
  palette: [{ name: 'Red', color: '#FF0000' }, { name: 'Blue', color: '#0000FF' }],
});
const pixelAt = (pixels: { width: number; data: Uint8ClampedArray }, x: number, y: number) => Array.from(pixels.data.slice((y * pixels.width + x) * 4, (y * pixels.width + x) * 4 + 4));

afterEach(() => { vi.useRealTimers(); });

describe('layer thumbnails', () => {
  it('keeps the pattern aspect ratio inside the thumbnail box', () => {
    expect(thumbnailDimensions(200, 100, 40)).toMatchObject({ width: 40, height: 20 });
    expect(thumbnailDimensions(10, 10, 40)).toMatchObject({ width: 40, height: 40, scale: 4 });
  });

  it("draws a stitch layer's own cells in palette colors and leaves empty cells transparent", () => {
    const document = makeDocument(4, 4);
    const layer = document.layers.find((entry) => entry.type === 'stitch') as StitchLayer;
    const [red] = document.palette;
    layer.kind[0] = CellKind.Full;
    layer.colors[0] = red!.id;
    const pixels = renderLayerThumbnailPixels(document, layer, 8);
    expect(pixels.width).toBe(8);
    expect(pixelAt(pixels, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(pixels, 1, 1)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(pixels, 4, 4)).toEqual([0, 0, 0, 0]);
  });

  it('keeps sparse stitches visible when a large pattern is downsampled', () => {
    const document = makeDocument(400, 400);
    const layer = document.layers.find((entry) => entry.type === 'stitch') as StitchLayer;
    const index = 399 * 400 + 399;
    layer.kind[index] = CellKind.HalfSlash;
    layer.colors[index * 4] = document.palette[1]!.id;
    const pixels = renderLayerThumbnailPixels(document, layer, 40);
    expect(pixelAt(pixels, 39, 39)).toEqual([0, 0, 255, 255]);
    expect(pixels.data.filter((_, offset) => offset % 4 === 3 && pixels.data[offset] === 255)).toHaveLength(1);
  });

  it('draws backstitch lines for a specialty layer', () => {
    const document = makeDocument(10, 10);
    const layer = document.layers.find((entry) => entry.type === 'specialty') as SpecialtyLayer;
    const u = FIXED_POINT_UNITS_PER_CELL;
    layer.backstitches = {
      ids: new Uint32Array([1]),
      x1: new Uint32Array([0]),
      y1: new Uint32Array([0]),
      x2: new Uint32Array([10 * u]),
      y2: new Uint32Array([10 * u]),
      colors: new Uint16Array([document.palette[0]!.id]),
      completed: new Uint8Array([0]),
    };
    const pixels = renderLayerThumbnailPixels(document, layer, 20);
    for (const step of [0, 5, 10, 19]) expect(pixelAt(pixels, step, step)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(pixels, 19, 0)).toEqual([0, 0, 0, 0]);
  });

  it('coalesces refresh requests to at most one per interval', () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const scheduler = createThumbnailScheduler(refresh, 500);
    scheduler.request();
    scheduler.request();
    vi.advanceTimersByTime(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    scheduler.request();
    scheduler.request();
    vi.advanceTimersByTime(499);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    scheduler.request();
    scheduler.dispose();
    vi.advanceTimersByTime(1000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
