import { describe, expect, it, vi } from 'vitest';
import { getCanvasMetrics } from '../editor/coordinates';
import type { CanvasContextAdapter, TraceImage } from '../editor/contracts';
import {
  MAX_TRACE_IMAGE_BYTES,
  MAX_TRACE_IMAGE_PIXELS,
  TraceDecodeError,
  createTraceImageProjection,
  decodeTraceImage,
  drawTraceImage,
  fitTraceImageBounds,
  sampleTraceImage
} from './trace';
import { MAX_WORKING_IMAGE_DIMENSION, MAX_WORKING_IMAGE_PIXELS } from '../shared/image-sizing';

interface RecordingContext extends CanvasContextAdapter {
  records: Array<{ name: string; args: unknown[]; globalAlpha: number; strokeStyle: string }>;
  imageSmoothingQuality: string;
}

function recordingContext(): RecordingContext {
  const context: RecordingContext = {
    records: [],
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'low',
    clearRect: function (): void {},
    fillRect: function (): void {},
    rect: function (): void {},
    clip: function (this: RecordingContext, ...args: unknown[]): void { this.records.push({ name: 'clip', args, globalAlpha: this.globalAlpha, strokeStyle: this.strokeStyle }); },
    beginPath: function (): void {},
    closePath: function (): void {},
    moveTo: function (): void {},
    lineTo: function (): void {},
    fill: function (): void {},
    stroke: function (): void {},
    drawImage: function (this: RecordingContext, ...args: unknown[]): void { this.records.push({ name: 'drawImage', args, globalAlpha: this.globalAlpha, strokeStyle: this.strokeStyle }); },
    save: function (): void {},
    restore: function (): void {}
  };
  return context;
}

function trace(overrides: Partial<TraceImage> = {}): TraceImage {
  return {
    source: { width: 100, height: 50 },
    width: 100,
    height: 50,
    visible: true,
    opacity: 1,
    ...overrides
  };
}

const validPngHeader = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);

interface TraceDrawRecord {
  source: unknown;
  sourceRect: number[];
  destinationRect: number[];
  smoothing: boolean | undefined;
  quality: string | undefined;
}

/** Fake sized canvas/surface harness mirroring the trace pre-scale surface contract. */
function traceSurfaceHarness() {
  const created: { width: number; height: number; freed: boolean }[] = [];
  const draws: TraceDrawRecord[] = [];
  const factory = (width: number, height: number) => {
    const canvas = { width, height, freed: false };
    created.push(canvas);
    const context = {
      drawImage: (...args: unknown[]) => {
        draws.push({
          source: args[0],
          sourceRect: args.slice(1, 5) as number[],
          destinationRect: args.slice(5, 9) as number[],
          smoothing: context.imageSmoothingEnabled,
          quality: context.imageSmoothingQuality
        });
      },
      getImageData: (_sx: number, _sy: number, width: number, height: number) => ({ data: new Uint8ClampedArray(Math.max(4, width * height * 4)) }),
      imageSmoothingEnabled: undefined as boolean | undefined,
      imageSmoothingQuality: undefined as string | undefined
    };
    return {
      canvas,
      context,
      dispose: () => {
        canvas.freed = true;
        canvas.width = 0;
        canvas.height = 0;
      }
    };
  };
  return { factory, draws, created };
}

describe('trace image projection and local raster utilities', () => {
  it('maps a cropped source exactly into chart bounds and preserves CSS/DPR alignment', () => {
    const projection = createTraceImageProjection(
      trace({ crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 }, chartBounds: { x: 2, y: 1, width: 4, height: 3 } }),
      { width: 10, height: 8 },
      { x: 1, y: 0.5, zoom: 20 },
      getCanvasMetrics(100, 80, { dpr: 2 })
    );
    expect(projection).toMatchObject({
      sourceRect: { x: 10, y: 10, width: 50, height: 20 },
      modelRect: { x: 2, y: 1, width: 4, height: 3 },
      screenRect: { x: 20, y: 10, width: 80, height: 60 },
      visibleRect: { x: 20, y: 10, width: 80, height: 60 },
      backingRect: { x: 40, y: 20, width: 160, height: 120 },
      visibleBackingRect: { x: 40, y: 20, width: 160, height: 120 },
      opacity: 1
    });
  });

  it('projects unbounded chart bounds into the canvas margins and clips the draw to the canvas', () => {
    const projection = createTraceImageProjection(
      trace({ chartBounds: { x: -2, y: -1, width: 4, height: 3 } }),
      { width: 10, height: 8 },
      { x: 0, y: 0, zoom: 20 },
      getCanvasMetrics(100, 80, { dpr: 2 })
    );
    expect(projection).toMatchObject({
      modelRect: { x: -2, y: -1, width: 4, height: 3 },
      screenRect: { x: -40, y: -20, width: 80, height: 60 },
      visibleRect: { x: 0, y: 0, width: 40, height: 40 }
    });
    const context = recordingContext();
    expect(drawTraceImage(context, trace({ chartBounds: { x: -2, y: -1, width: 4, height: 3 } }), { width: 10, height: 8 }, { x: 0, y: 0, zoom: 20 }, getCanvasMetrics(100, 80))).toBe(true);
    const draw = context.records.find((record) => record.name === 'drawImage');
    // Source rect is the visible sub-rect of the source image, destination the
    // on-canvas portion (the off-canvas margin is clipped by the canvas itself).
    expect(draw?.args[0]).toEqual({ width: 100, height: 50 });
    expect(draw?.args[1]).toBeCloseTo(50, 6);
    expect(draw?.args[2]).toBeCloseTo(50 / 3, 6);
    expect(draw?.args[3]).toBeCloseTo(50, 6);
    expect(draw?.args[4]).toBeCloseTo(100 / 3, 6);
    expect(draw?.args.slice(5)).toEqual([0, 0, 40, 40]);
  });

  it('samples the reference image hanging off the pattern edge', () => {
    const context = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([12, 34, 56, 255]) }))
    };
    const sampled = sampleTraceImage(
      trace({ chartBounds: { x: -2, y: -1, width: 4, height: 3 } }),
      { width: 10, height: 8 },
      { x: 0, y: 0, zoom: 20 },
      getCanvasMetrics(100, 80),
      { x: 30, y: 30 },
      { surfaceFactory: () => ({ context, dispose: vi.fn() }) }
    );
    expect(sampled).toEqual({ r: 12, g: 34, b: 56 });
    expect(context.drawImage).toHaveBeenCalledWith({ width: 100, height: 50 }, 87, 41, 1, 1, 0, 0, 1, 1);
  });

  it('draws only the clipped chart intersection with the mapped source crop', () => {
    const context = recordingContext();
    const didDraw = drawTraceImage(
      context,
      trace({ crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 }, opacity: 0.35 }),
      { width: 10, height: 8 },
      { x: 2, y: 1, zoom: 10 },
      getCanvasMetrics(100, 80, { dpr: 2 })
    );
    expect(didDraw).toBe(true);
    const draw = context.records.find((record) => record.name === 'drawImage');
    expect(draw?.args).toEqual([{ width: 100, height: 50 }, 20, 12.5, 40, 17.5, 0, 0, 80, 70]);
    expect(draw?.globalAlpha).toBe(0.35);
    expect(context.records.some((record) => record.name === 'clip')).toBe(true);
    // The reference image is mapped to stitch cells with nearest-neighbor so
    // edges stay sharp; smoothing quality is left untouched (a no-op with
    // smoothing disabled).
    expect(context.imageSmoothingEnabled).toBe(false);
    expect(context.imageSmoothingQuality).toBe('low');
    expect(drawTraceImage(context, trace({ visible: false }), { width: 10, height: 8 }, { x: 0, y: 0, zoom: 10 }, getCanvasMetrics(100, 80))).toBe(false);
    expect(drawTraceImage(context, trace({ opacity: 0 }), { width: 10, height: 8 }, { x: 0, y: 0, zoom: 10 }, getCanvasMetrics(100, 80))).toBe(false);
  });

  it('samples the same projected source pixel used by rendering', () => {
    const context = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([12, 34, 56, 255]) }))
    };
    const sampled = sampleTraceImage(
      trace({ crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 } }),
      { width: 4, height: 3 },
      { x: 1, y: 0.5, zoom: 20 },
      getCanvasMetrics(100, 80, { dpr: 2 }),
      { x: 20, y: 10 },
      { surfaceFactory: () => ({ context, dispose: vi.fn() }) }
    );
    expect(sampled).toEqual({ r: 12, g: 34, b: 56 });
    expect(context.drawImage).toHaveBeenCalledWith({ width: 100, height: 50 }, 35, 16, 1, 1, 0, 0, 1, 1);
    expect(sampleTraceImage(trace({ visible: false }), { width: 4, height: 3 }, { x: 0, y: 0, zoom: 20 }, getCanvasMetrics(100, 80), { x: 1, y: 1 }, { surfaceFactory: () => ({ context, dispose: vi.fn() }) })).toBeUndefined();
  });

  it('decodes supported local rasters with EXIF orientation and disposes bitmaps exactly once', async () => {
    const bitmap = { width: 3, height: 2, close: vi.fn() };
    const createImageBitmap = vi.fn(async (_blob: Blob, options?: { imageOrientation?: string }) => {
      expect(options).toEqual({ imageOrientation: 'from-image' });
      return bitmap;
    });
    const decoded = await decodeTraceImage(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x03, 0x01, 0x01, 0x11, 0x00])], { type: 'image/jpeg' }), { createImageBitmap });
    expect(decoded.width).toBe(3);
    expect(decoded.height).toBe(2);
    decoded.dispose?.();
    decoded.dispose?.();
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('rejects unsupported, oversized, failed, and invalid-dimension rasters safely', async () => {
    const validJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x03, 0x01, 0x01, 0x11, 0x00]);
    const validPng = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);
    await expect(decodeTraceImage(new Blob(['x'], { type: 'image/gif' }), { createImageBitmap: vi.fn() })).rejects.toMatchObject({ code: 'unsupported-format' });
    await expect(decodeTraceImage(new Blob(['x'], { type: 'image/png' }), { maxBytes: 0, createImageBitmap: vi.fn() })).rejects.toMatchObject({ code: 'too-large' });
    await expect(decodeTraceImage(new Blob([validJpeg], { type: 'image/jpeg' }), { createImageBitmap: vi.fn(async () => { throw new Error('bad'); }) })).rejects.toMatchObject({ code: 'decode-failed' });
    const bitmap = { width: 0, height: 2, close: vi.fn() };
    await expect(decodeTraceImage(new Blob([validPng], { type: 'image/png' }), { createImageBitmap: vi.fn(async () => bitmap) })).rejects.toMatchObject({ code: 'invalid-dimensions' });
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(MAX_TRACE_IMAGE_BYTES).toBeGreaterThan(0);
    expect(TraceDecodeError).toBeDefined();
  });

  it('rejects oversized blobs before reading them and static oversized headers before bitmap allocation', async () => {
    const oversized = new Blob(['x'], { type: 'image/png' });
    const read = vi.fn();
    Object.defineProperty(oversized, 'arrayBuffer', { configurable: true, value: read });
    await expect(decodeTraceImage(oversized, { maxBytes: 0, createImageBitmap: vi.fn() })).rejects.toMatchObject({ code: 'too-large' });
    expect(read).not.toHaveBeenCalled();

    const header = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 1, 0, 0, 0, 1, 0, 0]);
    const view = new DataView(header.buffer);
    view.setUint32(16, 100_000, false);
    view.setUint32(20, 100_000, false);
    const createImageBitmap = vi.fn();
    await expect(decodeTraceImage(new Blob([header], { type: 'image/png' }), { maxPixels: 1_000, createImageBitmap })).rejects.toMatchObject({ code: 'invalid-dimensions' });
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('accepts an exact VP8L fixture with the packed little-endian dimensions', async () => {
    const fixture = new Uint8Array([
      82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80,
      86, 80, 56, 76, 6, 0, 0, 0,
      47, 9, 192, 4, 0, 0
    ]);
    const bitmap = { width: 10, height: 20, close: vi.fn() };
    const createImageBitmap = vi.fn(async () => bitmap);
    const decoded = await decodeTraceImage(new Blob([fixture], { type: 'image/webp' }), { createImageBitmap, maxPixels: 200 });
    expect(createImageBitmap).toHaveBeenCalledOnce();
    expect(decoded.width).toBe(10);
    expect(decoded.height).toBe(20);
    decoded.dispose?.();
  });

  it('rejects oversized VP8L header dimensions before createImageBitmap', async () => {
    const fixture = new Uint8Array([
      82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80,
      86, 80, 56, 76, 6, 0, 0, 0,
      47, 207, 199, 195, 9, 0
    ]);
    const createImageBitmap = vi.fn();
    await expect(decodeTraceImage(new Blob([fixture], { type: 'image/webp' }), { createImageBitmap })).rejects.toMatchObject({ code: 'invalid-dimensions' });
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('accepts exact VP8 dimensions using little-endian 14-bit masks', async () => {
    const fixture = new Uint8Array([
      82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80,
      86, 80, 56, 32, 10, 0, 0, 0,
      0, 0, 0, 157, 1, 42, 136, 19, 184, 11
    ]);
    const bitmap = { width: 0x1388, height: 0x0bb8, close: vi.fn() };
    const createImageBitmap = vi.fn(async () => bitmap);
    const decoded = await decodeTraceImage(new Blob([fixture], { type: 'image/webp' }), { createImageBitmap, maxPixels: 50_000_000 });
    expect(createImageBitmap).toHaveBeenCalledOnce();
    expect(decoded.width).toBe(0x1388);
    expect(decoded.height).toBe(0x0bb8);
    decoded.dispose?.();
  });

  it('passes reference images within the working bound through unchanged', async () => {
    const harness = traceSurfaceHarness();
    const bitmap = { width: 3_000, height: 2_000, close: vi.fn() };
    const decoded = await decodeTraceImage(new Blob([validPngHeader], { type: 'image/png' }), {
      createImageBitmap: async () => bitmap,
      surfaceFactory: harness.factory
    });
    expect(decoded.width).toBe(3_000);
    expect(decoded.height).toBe(2_000);
    expect(decoded.sourceWidth).toBe(3_000);
    expect(decoded.sourceHeight).toBe(2_000);
    expect(decoded.source).toBe(bitmap);
    expect(harness.created).toHaveLength(0);
    expect(bitmap.close).not.toHaveBeenCalled();
    decoded.dispose?.();
    decoded.dispose?.();
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('pre-scales an oversized decoded reference image to the working pixel bound', async () => {
    const harness = traceSurfaceHarness();
    const bitmap = { width: 8_000, height: 6_000, close: vi.fn() };
    const decoded = await decodeTraceImage(new Blob([validPngHeader], { type: 'image/png' }), {
      createImageBitmap: async () => bitmap,
      surfaceFactory: harness.factory
    });
    const scale = Math.min(
      1,
      MAX_WORKING_IMAGE_DIMENSION / 8_000,
      MAX_WORKING_IMAGE_DIMENSION / 6_000,
      Math.sqrt(MAX_WORKING_IMAGE_PIXELS / (8_000 * 6_000))
    );
    const fittedWidth = Math.floor(8_000 * scale);
    const fittedHeight = Math.floor(6_000 * scale);
    // One final high-quality draw to the exact fitted size (final factor <=2x).
    expect(harness.draws.map((draw) => draw.destinationRect)).toEqual([[0, 0, fittedWidth, fittedHeight]]);
    expect(harness.draws[0]?.smoothing).toBe(true);
    expect(harness.draws[0]?.quality).toBe('high');
    // The trace image reports the pre-scaled dimensions and holds the canvas.
    expect(decoded.width).toBe(fittedWidth);
    expect(decoded.height).toBe(fittedHeight);
    // The original decoded dimensions stay available for the persisted descriptor.
    expect(decoded.sourceWidth).toBe(8_000);
    expect(decoded.sourceHeight).toBe(6_000);
    expect(decoded.source).toBe(harness.created[0]);
    expect(decoded.width * decoded.height).toBeLessThanOrEqual(MAX_TRACE_IMAGE_PIXELS);
    // The full-resolution decode is released immediately once pre-scaled.
    expect(bitmap.close).toHaveBeenCalledOnce();
    decoded.dispose?.();
    decoded.dispose?.();
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(harness.created[0]?.freed).toBe(true);
    expect(harness.created[0]?.width).toBe(0);
    expect(harness.created[0]?.height).toBe(0);
  });

  it('keeps decoded source dimensions after closing an oversized bitmap (browser close semantics)', async () => {
    const harness = traceSurfaceHarness();
    let closed = false;
    const close = vi.fn(() => { closed = true; });
    // Browsers zero out an ImageBitmap's width/height after close(); the mock
    // mirrors that so the persisted source descriptor cannot be zeroed.
    const bitmap = {
      get width() { return closed ? 0 : 3_300; },
      get height() { return closed ? 0 : 5_100; },
      close
    };
    const decoded = await decodeTraceImage(new Blob([validPngHeader], { type: 'image/png' }), {
      createImageBitmap: async () => bitmap,
      surfaceFactory: harness.factory
    });
    // 3300x5100 = 16.83 MP exceeds the working bound, so the decode is
    // pre-scaled and the full-resolution bitmap is closed inside decode.
    expect(closed).toBe(true);
    expect(decoded.width * decoded.height).toBeLessThanOrEqual(MAX_TRACE_IMAGE_PIXELS);
    expect(decoded.sourceWidth).toBe(3_300);
    expect(decoded.sourceHeight).toBe(5_100);
    decoded.dispose?.();
    expect(close).toHaveBeenCalledOnce();
  });

  it('pre-scales an oversized reference image through successive 2x halvings then a final quality draw', async () => {
    const harness = traceSurfaceHarness();
    const bitmap = { width: 8_192, height: 8_192, close: vi.fn() };
    const decoded = await decodeTraceImage(new Blob([validPngHeader], { type: 'image/png' }), {
      createImageBitmap: async () => bitmap,
      surfaceFactory: harness.factory
    });
    // Fitted: 4000x4000; 8192 halved once to 4096, then 4096 -> 4000.
    expect(harness.draws.map((draw) => draw.destinationRect)).toEqual([
      [0, 0, 4_096, 4_096],
      [0, 0, 4_000, 4_000]
    ]);
    expect(decoded.width).toBe(4_000);
    expect(decoded.height).toBe(4_000);
    expect(harness.draws[0]?.source).toBe(bitmap);
    expect(harness.draws[1]?.source).toBe(harness.created[0]);
    expect(harness.draws.every((draw) => draw.smoothing === true && draw.quality === 'high')).toBe(true);
    expect(bitmap.close).toHaveBeenCalledOnce();
    decoded.dispose?.();
    expect(harness.created.every((canvas) => canvas.freed)).toBe(true);
    expect(harness.created.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
  });

  it('fits an 8000x6000 decode within both working bounds', async () => {
    const harness = traceSurfaceHarness();
    const bitmap = { width: 8_000, height: 6_000, close: vi.fn() };
    const boundedFactory = (width: number, height: number) => {
      if (width > MAX_WORKING_IMAGE_DIMENSION || height > MAX_WORKING_IMAGE_DIMENSION) {
        throw new Error('working surface exceeds the axis bound');
      }
      return harness.factory(width, height);
    };
    const decoded = await decodeTraceImage(new Blob([validPngHeader], { type: 'image/png' }), {
      createImageBitmap: async () => bitmap,
      surfaceFactory: boundedFactory
    });
    expect(decoded.width).toBe(4_096);
    expect(decoded.height).toBe(3_072);
    expect(decoded.width * decoded.height).toBeLessThanOrEqual(MAX_WORKING_IMAGE_PIXELS);
    expect(harness.draws.map((draw) => draw.destinationRect)).toEqual([[0, 0, 4_096, 3_072]]);
    decoded.dispose?.();
  });

  it('rejects decoded reference images past the shared decode ceiling', async () => {
    const square = { width: 8_193, height: 8_193, close: vi.fn() };
    await expect(decodeTraceImage(new Blob([validPngHeader], { type: 'image/png' }), { createImageBitmap: async () => square })).rejects.toMatchObject({ code: 'invalid-dimensions' });
    expect(square.close).toHaveBeenCalledOnce();
    const tall = { width: 1_000, height: 9_000, close: vi.fn() };
    await expect(decodeTraceImage(new Blob([validPngHeader], { type: 'image/png' }), { createImageBitmap: async () => tall })).rejects.toMatchObject({ code: 'invalid-dimensions' });
    expect(tall.close).toHaveBeenCalledOnce();
  });

  it('fails cleanly when no readable surface can pre-scale an oversized decode', async () => {
    const bitmap = { width: 8_000, height: 6_000, close: vi.fn() };
    await expect(decodeTraceImage(new Blob([validPngHeader], { type: 'image/png' }), {
      createImageBitmap: async () => bitmap,
      surfaceFactory: () => undefined
    })).rejects.toMatchObject({ code: 'unavailable' });
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('fits an exact image size to the full pattern', () => {
    expect(fitTraceImageBounds(100, 50, 100, 50)).toEqual({ x: 0, y: 0, width: 100, height: 50 });
  });

  it('fits an exact power-of-two downscale to the full pattern', () => {
    expect(fitTraceImageBounds(200, 100, 100, 50)).toEqual({ x: 0, y: 0, width: 100, height: 50 });
  });

  it('snaps a non-power-of-two downscale to the largest power of two', () => {
    expect(fitTraceImageBounds(300, 150, 100, 50)).toEqual({ x: 13, y: 6, width: 75, height: 38 });
  });

  it('centers a large downscale using the largest power of two', () => {
    expect(fitTraceImageBounds(1000, 500, 100, 50)).toEqual({ x: 19, y: 10, width: 63, height: 31 });
  });

  it('rounds fractional aspect-fit bounds into positive safe integers inside the pattern', () => {
    const bounds = fitTraceImageBounds(301, 157, 100, 50);
    expect(bounds).toEqual({ x: 13, y: 6, width: 75, height: 39 });
    expect(Object.values(bounds).every((value) => Number.isSafeInteger(value))).toBe(true);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(100);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(50);
  });

  it('upscales a small image so each source pixel block covers an integer cell count', () => {
    expect(fitTraceImageBounds(25, 25, 100, 100)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });

  it('falls back to the full pattern for invalid inputs', () => {
    expect(fitTraceImageBounds(0, 50, 100, 50)).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    expect(fitTraceImageBounds(100, -5, 100, 50)).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    expect(fitTraceImageBounds(Number.NaN, 50, 100, 50)).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    expect(fitTraceImageBounds(100, 50, 0, 50)).toEqual({ x: 0, y: 0, width: 0, height: 50 });
  });
});
