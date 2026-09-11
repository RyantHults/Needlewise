import { describe, expect, it } from 'vitest';
import { ConversionError } from './image-to-pattern';
import { decodeAndResampleImage, fitRasterWithinBounds, preScaleRasterSource, type ConversionRasterSurface } from './raster';

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

function pngSource(width: number, height: number): Blob {
  return new Blob([pngBytes(width, height).buffer as ArrayBuffer], { type: 'image/png' });
}

function webpSource(width: number, height: number, mimeType = 'image/webp'): Blob {
  const bytes = new Uint8Array(30);
  bytes.set([82, 73, 70, 70, 22, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 88, 10, 0, 0, 0], 0);
  bytes[24] = (width - 1) & 0xff;
  bytes[25] = ((width - 1) >> 8) & 0xff;
  bytes[26] = ((width - 1) >> 16) & 0xff;
  bytes[27] = (height - 1) & 0xff;
  bytes[28] = ((height - 1) >> 8) & 0xff;
  bytes[29] = ((height - 1) >> 16) & 0xff;
  return new Blob([bytes.buffer as ArrayBuffer], { type: mimeType });
}

function largeVp8HeaderSource(width: number, height: number): Blob {
  const bytes = new Uint8Array(64 * 1024);
  bytes.set([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 32], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 337_014, true);
  view.setUint32(16, 337_002, true);
  bytes[23] = 0x9d;
  bytes[24] = 0x01;
  bytes[25] = 0x2a;
  view.setUint16(26, width, true);
  view.setUint16(28, height, true);
  return new Blob([bytes.buffer as ArrayBuffer], { type: 'image/webp' });
}

interface RecordedDraw {
  source: unknown;
  sourceRect: number[];
  destinationRect: number[];
  smoothing: boolean | undefined;
  quality: string | undefined;
}

/** Fake canvas/surface harness mirroring the raster pipeline's surface contract. */
function surfaceHarness() {
  const created: { width: number; height: number; freed: boolean }[] = [];
  const draws: RecordedDraw[] = [];
  let getImageDataPixels: Uint8ClampedArray = new Uint8ClampedArray([1, 2, 3, 255]);
  const factory = (width: number, height: number): ConversionRasterSurface => {
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
      getImageData: (_sx: number, _sy: number, width: number, height: number) => {
        const plane = new Uint8ClampedArray(width * height * 4);
        plane.set(getImageDataPixels.subarray(0, Math.min(plane.length, getImageDataPixels.length)));
        return { data: plane };
      },
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
  return {
    factory,
    draws,
    created,
    setPixels: (pixels: Uint8ClampedArray): void => { getImageDataPixels = pixels; }
  };
}

describe('bounded conversion rasterization', () => {
  it('requests EXIF-aware decoding, disables smoothing, and disposes decoded resources', async () => {
    let orientation: string | undefined;
    let closed = 0;
    let smoothing: boolean | undefined;
    let drawArguments: unknown[] | undefined;
    const source = pngSource(2, 2);
    const result = await decodeAndResampleImage(source, 1, 1, {
      createImageBitmap: async (_blob, options) => {
        orientation = options?.imageOrientation;
        return { width: 2, height: 2, close: () => { closed += 1; } };
      },
      surfaceFactory: () => {
        const context = {
          imageSmoothingEnabled: undefined as boolean | undefined,
          drawImage: (...args: unknown[]) => { drawArguments = args; },
          getImageData: () => ({ data: new Uint8ClampedArray([1, 2, 3, 255]) })
        };
        return {
          context,
          dispose: () => { smoothing = context.imageSmoothingEnabled; }
        };
      }
    });
    expect(orientation).toBe('from-image');
    expect(drawArguments).toEqual([expect.anything(), 0, 0, 2, 2, 0, 0, 1, 1]);
    expect(result.pixels).toEqual(new Uint8ClampedArray([1, 2, 3, 255]));
    expect(result.sourceWidth).toBe(2);
    expect(closed).toBe(1);
    expect(smoothing).toBe(false);
  });

  it('uses the WebP header when a browser declares the content as JPEG', async () => {
    const harness = surfaceHarness();
    let decodedMimeType = '';
    const result = await decodeAndResampleImage(webpSource(1_057, 1_600, 'image/jpeg'), 2, 2, {
      createImageBitmap: async (blob) => {
        decodedMimeType = blob.type;
        return { width: 1_057, height: 1_600 };
      },
      surfaceFactory: harness.factory
    });
    expect(decodedMimeType).toBe('image/webp');
    expect(result.sourceWidth).toBe(1_057);
    expect(result.sourceHeight).toBe(1_600);
    expect(result.width).toBe(2);
    expect(result.height).toBe(2);
  });

  it('accepts VP8 dimensions when the declared chunk extends beyond the header probe', async () => {
    const harness = surfaceHarness();
    let decoded = false;
    const result = await decodeAndResampleImage(largeVp8HeaderSource(1_057, 1_600), 2, 2, {
      createImageBitmap: async () => {
        decoded = true;
        return { width: 1_057, height: 1_600 };
      },
      surfaceFactory: harness.factory
    });
    expect(decoded).toBe(true);
    expect(result.sourceWidth).toBe(1_057);
    expect(result.sourceHeight).toBe(1_600);
  });

  it('rejects target allocations outside conversion bounds before decoding', async () => {
    let decoded = false;
    const source = pngSource(1, 1);
    await expect(decodeAndResampleImage(source, 1_001, 1, {
      createImageBitmap: async () => {
        decoded = true;
        return { width: 1, height: 1 };
      }
    })).rejects.toBeInstanceOf(ConversionError);
    expect(decoded).toBe(false);
  });

  it('rejects genuinely invalid encoded dimensions before invoking the decoder', async () => {
    let decoded = false;
    await expect(decodeAndResampleImage(pngSource(0, 1), 1, 1, {
      createImageBitmap: async () => {
        decoded = true;
        return { width: 1, height: 1 };
      }
    })).rejects.toBeInstanceOf(ConversionError);
    expect(decoded).toBe(false);
  });

  it('rejects encoded dimensions past the decode ceiling before invoking the decoder', async () => {
    let decoded = false;
    await expect(decodeAndResampleImage(pngSource(8_193, 1), 1, 1, {
      createImageBitmap: async () => {
        decoded = true;
        return { width: 1, height: 1 };
      }
    })).rejects.toBeInstanceOf(ConversionError);
    expect(decoded).toBe(false);
  });

  it('decodes encoded dimensions beyond the working bound when within the decode ceiling', async () => {
    let decoded = false;
    const harness = surfaceHarness();
    const result = await decodeAndResampleImage(pngSource(4_097, 1), 1, 1, {
      createImageBitmap: async () => {
        decoded = true;
        return { width: 4_097, height: 1 };
      },
      surfaceFactory: harness.factory
    });
    expect(decoded).toBe(true);
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
    // One pre-scale final draw (4097x1 -> 4096x1) then the target draw.
    expect(harness.draws[0]?.sourceRect).toEqual([0, 0, 4_097, 1]);
    expect(harness.draws[0]?.destinationRect).toEqual([0, 0, 4_096, 1]);
    expect(harness.draws[1]?.destinationRect).toEqual([0, 0, 1, 1]);
  });

  it('pre-scales a decoded bitmap exceeding both bounds with a single quality draw', async () => {
    const harness = surfaceHarness();
    const result = await decodeAndResampleImage(pngSource(6_000, 4_000), 100, 50, {
      createImageBitmap: async () => ({ width: 6_000, height: 4_000 }),
      surfaceFactory: harness.factory
    });
    // Fitted working size: 4096 x floor(4000 * 4096 / 6000) = 4096 x 2730.
    expect(harness.draws.map((draw) => draw.destinationRect)).toEqual([
      [0, 0, 4_096, 2_730],
      [0, 0, 100, 50]
    ]);
    // The pre-scale draw uses high-quality smoothing; the target draw stays nearest-neighbor.
    expect(harness.draws[0]?.smoothing).toBe(true);
    expect(harness.draws[0]?.quality).toBe('high');
    expect(harness.draws[1]?.smoothing).toBe(false);
    // The target draw consumes the pre-scaled canvas, not the decoded bitmap.
    expect(harness.draws[1]?.source).toBe(harness.created[0]);
    // The recorded source dimensions keep the true original size.
    expect(result.sourceWidth).toBe(6_000);
    expect(result.sourceHeight).toBe(4_000);
    // Every pre-scaled intermediate (and the target surface) is released.
    expect(harness.created.every((canvas) => canvas.freed)).toBe(true);
    expect(harness.created.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
  });

  it('pre-scales an oversized bitmap to the shared working bounds', async () => {
    const harness = surfaceHarness();
    const result = await decodeAndResampleImage(pngSource(8_000, 6_000), 100, 100, {
      createImageBitmap: async () => ({ width: 8_000, height: 6_000 }),
      surfaceFactory: harness.factory
    });
    // Fitted: min(1, 4096/8000, 4096/6000, sqrt(16_000_000 / 48_000_000)) applied to 8000x6000.
    const scale = Math.min(1, 4_096 / 8_000, 4_096 / 6_000, Math.sqrt(16_000_000 / 48_000_000));
    const fittedWidth = Math.max(1, Math.floor(8_000 * scale));
    const fittedHeight = Math.max(1, Math.floor(6_000 * scale));
    // The exact fitted size is within a factor of 2, so it is reached in one draw.
    expect(harness.draws.map((draw) => draw.destinationRect)).toEqual([
      [0, 0, fittedWidth, fittedHeight],
      [0, 0, 100, 100]
    ]);
    expect(harness.draws[0]?.smoothing).toBe(true);
    expect(harness.draws[1]?.smoothing).toBe(false);
    // The target draw consumes the pre-scaled canvas.
    expect(harness.draws[1]?.source).toBe(harness.created[0]);
    expect(result.sourceWidth).toBe(8_000);
    expect(result.sourceHeight).toBe(6_000);
    expect(harness.created.every((canvas) => canvas.freed)).toBe(true);
  });
});

describe('fitRasterWithinBounds', () => {
  it('passes sources within the working bounds through untouched', () => {
    expect(fitRasterWithinBounds(3_000, 2_000)).toEqual({ width: 3_000, height: 2_000 });
    expect(fitRasterWithinBounds(4_000, 4_000)).toEqual({ width: 4_000, height: 4_000 });
  });

  it('clamps the limiting axis to the bound and scales the other proportionally', () => {
    expect(fitRasterWithinBounds(6_000, 4_000)).toEqual({ width: 4_096, height: 2_730 });
    expect(fitRasterWithinBounds(4_000, 6_000)).toEqual({ width: 2_730, height: 4_096 });
  });

  it('respects the pixel bound when both axes fit individually', () => {
    expect(fitRasterWithinBounds(8_191, 8_191, 4_096)).toEqual({ width: 4_000, height: 4_000 });
    expect(fitRasterWithinBounds(8_192, 8_192, 4_096)).toEqual({ width: 4_000, height: 4_000 });
  });

  it('keeps degenerate aspect ratios at a minimum of one pixel', () => {
    expect(fitRasterWithinBounds(12_600, 1)).toEqual({ width: 4_096, height: 1 });
  });

  it('rejects non-finite, non-positive, and unsafe dimensions', () => {
    expect(() => fitRasterWithinBounds(0, 10)).toThrow(ConversionError);
    expect(() => fitRasterWithinBounds(10, 0)).toThrow(ConversionError);
    expect(() => fitRasterWithinBounds(Number.NaN, 10)).toThrow(ConversionError);
    expect(() => fitRasterWithinBounds(10, Number.POSITIVE_INFINITY)).toThrow(ConversionError);
    expect(() => fitRasterWithinBounds(1.5, 10)).toThrow(ConversionError);
  });
});

describe('preScaleRasterSource', () => {
  it('halves only until a final draw fits within 2x, then draws to the exact fitted size', () => {
    const harness = surfaceHarness();
    const original = { kind: 'bitmap' };
    const prepared = preScaleRasterSource(original, 20_000, 10_000, 4_096, 2_048, harness.factory);
    // 20000x10000 -> 10000x5000 -> 5000x2500, then 5000x2500 -> 4096x2048.
    expect(harness.created.map((canvas) => [canvas.width, canvas.height])).toEqual([
      [10_000, 5_000],
      [5_000, 2_500],
      [4_096, 2_048]
    ]);
    expect(harness.draws.map((draw) => draw.destinationRect)).toEqual([
      [0, 0, 10_000, 5_000],
      [0, 0, 5_000, 2_500],
      [0, 0, 4_096, 2_048]
    ]);
    expect(harness.draws[0]?.source).toBe(original);
    expect(harness.draws[1]?.source).toBe(harness.created[0]);
    expect(harness.draws[2]?.source).toBe(harness.created[1]);
    expect(harness.draws.every((draw) => draw.smoothing === true && draw.quality === 'high')).toBe(true);
    expect(prepared.width).toBe(4_096);
    expect(prepared.height).toBe(2_048);
    prepared.dispose();
    expect(harness.created.every((canvas) => canvas.freed)).toBe(true);
    expect(harness.created.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
  });

  it('releases intermediate surfaces when no surface can be allocated', () => {
    const harness = surfaceHarness();
    const factory = (width: number, height: number): ConversionRasterSurface | undefined => {
      if (width === 10_000) return undefined;
      return harness.factory(width, height);
    };
    expect(() => preScaleRasterSource({ kind: 'bitmap' }, 20_000, 10_000, 4_096, 2_048, factory)).toThrow(ConversionError);
    expect(harness.created).toHaveLength(0);
  });

  it('releases created surfaces when a later step throws', () => {
    const harness = surfaceHarness();
    const original = { kind: 'bitmap' };
    let created = 0;
    const factory = (width: number, height: number): ConversionRasterSurface => {
      created += 1;
      if (created >= 2) throw new ConversionError('unavailable', 'A readable local raster surface is unavailable.');
      return harness.factory(width, height);
    };
    expect(() => preScaleRasterSource(original, 20_000, 10_000, 4_096, 2_048, factory)).toThrow(ConversionError);
    expect(harness.created).toHaveLength(1);
    expect(harness.created[0]?.freed).toBe(true);
    expect(harness.created[0]?.width).toBe(0);
    expect(harness.created[0]?.height).toBe(0);
  });
});
