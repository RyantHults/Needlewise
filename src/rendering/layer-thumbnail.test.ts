import { afterEach, describe, expect, it, vi } from 'vitest';
import { BEAD_ORIENTATIONS, CellKind, FIXED_POINT_UNITS_PER_CELL, type SpecialtyLayer, type StitchLayer } from '../domain';
import { createThumbnailScheduler, layerContentChanged, renderLayerThumbnailPixels, thumbnailDimensions } from './layer-thumbnail';
import { createLayeredDocument } from '../domain/test-fixtures';
import { createCatalogReference, INSTALLED_CATALOG_REGISTRY } from '../catalog';

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

  it('draws French knots as dots for a specialty layer', () => {
    const document = makeDocument(10, 10);
    const layer = document.layers.find((entry) => entry.type === 'specialty') as SpecialtyLayer;
    const u = FIXED_POINT_UNITS_PER_CELL;
    layer.pointStitches = {
      ids: new Uint32Array([1]),
      x: new Uint32Array([5 * u]),
      y: new Uint32Array([2 * u + u / 2]),
      colors: new Uint16Array([document.palette[1]!.id]),
      completed: new Uint8Array([0]),
      orientations: new Uint8Array([0]),
    };
    const pixels = renderLayerThumbnailPixels(document, layer, 20);
    expect(pixelAt(pixels, 10, 5)).toEqual([0, 0, 255, 255]);
    expect(pixels.data.filter((_, offset) => offset % 4 === 3 && pixels.data[offset] === 255)).toHaveLength(1);
  });

  it('draws a bead as a barrel on the "/" diagonal at its real size on the fabric', () => {
    const millHill = INSTALLED_CATALOG_REGISTRY.definitions.find((definition) => definition.materialKind === 'bead')!;
    const pebble = millHill.records.find((record) => record.code === '05025')!;
    const document = createLayeredDocument({
      width: 10,
      height: 10,
      catalog,
      settings: { aidaCount: 14 },
      palette: [{ name: pebble.name, color: '#00FF00', material: { kind: 'bead', label: 'Mill Hill', unit: 'count' }, catalog: createCatalogReference(millHill, pebble) }],
    });
    const layer = document.layers.find((entry) => entry.type === 'specialty') as SpecialtyLayer;
    const u = FIXED_POINT_UNITS_PER_CELL;
    layer.pointStitches = {
      ids: new Uint32Array([1]),
      x: new Uint32Array([5 * u]),
      y: new Uint32Array([5 * u]),
      colors: new Uint16Array([document.palette[0]!.id]),
      completed: new Uint8Array([0]),
      orientations: new Uint8Array([0]),
    };
    // 4 px per cell. A 5.5 x 3.85 mm pebble on 14-count is 12 px across the hole and 8.5 px along it,
    // the hole running bottom-left to top-right through (20, 20).
    const pixels = renderLayerThumbnailPixels(document, layer, 40);
    expect(pixelAt(pixels, 20, 20)).toEqual([0, 255, 0, 255]);
    expect(pixelAt(pixels, 23, 23)).toEqual([0, 255, 0, 255]);
    expect(pixelAt(pixels, 22, 17)).toEqual([0, 255, 0, 255]);
    expect(pixelAt(pixels, 23, 16)).toEqual([0, 0, 0, 0]);
    expect(pixelAt(pixels, 26, 26)).toEqual([0, 0, 0, 0]);
    // Turned to lie "-", the same bead is long across y and short along x.
    layer.pointStitches = { ...layer.pointStitches, orientations: new Uint8Array([BEAD_ORIENTATIONS.Horizontal]) };
    const turned = renderLayerThumbnailPixels(document, layer, 40);
    expect(pixelAt(turned, 20, 25)).toEqual([0, 255, 0, 255]);
    expect(pixelAt(turned, 25, 20)).toEqual([0, 0, 0, 0]);
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

  it('treats show/hide and rename as no content change, and edits as a change', () => {
    const document = makeDocument(4, 4);
    const layer = document.layers.find((entry) => entry.type === 'stitch') as StitchLayer;
    expect(layerContentChanged(null, layer)).toBe(true);
    expect(layerContentChanged(layer, layer)).toBe(false);
    expect(layerContentChanged(layer, { ...layer, visible: false })).toBe(false);
    expect(layerContentChanged(layer, { ...layer, name: 'Renamed' })).toBe(false);
    expect(layerContentChanged(layer, { ...layer })).toBe(true);
    expect(layerContentChanged(layer, { ...layer, kind: layer.kind.slice() })).toBe(true);
  });
});
