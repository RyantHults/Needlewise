import {
  decodeTraceImage,
  type TraceCreateImageBitmap,
  type TraceDecodeOptions,
  type TraceBitmap
} from '../rendering/trace';
import {
  ConversionError,
  conversionCancelled,
  MAX_CONVERSION_DECODE_PIXELS,
  MAX_CONVERSION_DIMENSION,
  MAX_CONVERSION_SOURCE_BYTES,
  MAX_CONVERSION_TARGET_PIXELS,
  resampleRaster,
  type ConversionCancellation,
  type ConversionRaster
} from './image-to-pattern';
import { isWithinImageDecodeBounds } from '../image/limits';
import { fitImageWithinWorkingBounds, MAX_WORKING_IMAGE_DIMENSION, MAX_WORKING_IMAGE_PIXELS } from '../image/image-sizing';
import { createReadableSurface, preScaleSource, safeCloseBitmap, type PreScaledSource } from '../image/surface';

export type ConversionRasterOptions = TraceDecodeOptions;

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

function assertTargetDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > MAX_CONVERSION_DIMENSION || height > MAX_CONVERSION_DIMENSION || width * height > MAX_CONVERSION_TARGET_PIXELS) {
    throw new ConversionError('invalid-target', 'Target dimensions are outside the supported bounds.');
  }
}

export interface RasterFit {
  readonly width: number;
  readonly height: number;
}

/**
 * Aspect-preserving contain fit of an oversized source into the working
 * conversion bounds. When the source already fits, it passes through
 * untouched; otherwise the limiting axis is clamped to maxDimension and the
 * other axis is scaled proportionally (rounding down, minimum 1).
 */
export function fitRasterWithinBounds(
  width: number,
  height: number,
  maxDimension = MAX_WORKING_IMAGE_DIMENSION,
  maxPixels = MAX_WORKING_IMAGE_PIXELS
): RasterFit {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new ConversionError('invalid-raster', 'Raster dimensions are outside the supported bounds.');
  }
  if (width <= maxDimension && height <= maxDimension && width * height <= maxPixels) return { width, height };
  return fitImageWithinWorkingBounds(width, height, maxDimension, maxPixels);
}

export async function decodeAndResampleImage(
  source: Blob | File,
  targetWidth: number,
  targetHeight: number,
  options: ConversionRasterOptions = {},
  cancellation?: ConversionCancellation
): Promise<ConversionRaster> {
  assertTargetDimensions(targetWidth, targetHeight);
  conversionCancelled(cancellation);
  const maxBytes = options.maxBytes ?? MAX_CONVERSION_SOURCE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CONVERSION_SOURCE_BYTES) throw new ConversionError('invalid-raster', 'The image decode limit is outside the supported bounds.');
  if (!Number.isFinite(source.size) || source.size > maxBytes) throw new ConversionError('invalid-raster', 'The image source exceeds the local byte limit.');
  const createImageBitmap = options.createImageBitmap ?? (typeof globalThis.createImageBitmap === 'function' ? globalThis.createImageBitmap.bind(globalThis) as TraceCreateImageBitmap : undefined);
  // The conversion pipeline pre-scales oversized decodes to the working bounds,
  // so the trace decode limit is raised to the full decode ceiling. The trace
  // decode reads the format and encoded dimensions from the bytes.
  const decodeOptions: ConversionRasterOptions = {
    ...options,
    maxBytes,
    maxPixels: MAX_CONVERSION_DECODE_PIXELS,
    ...(createImageBitmap === undefined ? {} : {
      createImageBitmap: async (blob, bitmapOptions) => {
        conversionCancelled(cancellation);
        let bitmap: TraceBitmap | undefined;
        try {
          bitmap = await createImageBitmap(blob, bitmapOptions);
          conversionCancelled(cancellation);
          return bitmap;
        } catch (error) {
          safeCloseBitmap(bitmap);
          throw error;
        }
      }
    })
  };
  let decoded;
  try {
    decoded = await decodeTraceImage(source, decodeOptions);
  } catch (error) {
    conversionCancelled(cancellation);
    throw error;
  }
  try {
    conversionCancelled(cancellation);
    if (!isWithinImageDecodeBounds(decoded.width, decoded.height)) {
      throw new ConversionError('invalid-raster', 'The decoded source image dimensions are outside the supported bounds.');
    }
    conversionCancelled(cancellation);
    // Oversized decodes are pre-scaled down to the working bounds
    // (aspect-preserving) instead of being rejected; the recorded source
    // dimensions keep the true original size.
    const fitted = fitRasterWithinBounds(decoded.width, decoded.height);
    let prepared: PreScaledSource | undefined;
    if (fitted.width !== decoded.width || fitted.height !== decoded.height) {
      prepared = preScaleSource(decoded.source, decoded.width, decoded.height, fitted.width, fitted.height, options.surfaceFactory);
      if (!prepared) throw new ConversionError('unavailable', 'A readable local raster surface is unavailable.');
    }
    conversionCancelled(cancellation);
    const surface = options.surfaceFactory?.(targetWidth, targetHeight) ?? createReadableSurface(targetWidth, targetHeight);
    conversionCancelled(cancellation);
    if (!surface) throw new ConversionError('unavailable', 'A readable local raster surface is unavailable.');
    let result: ConversionRaster;
    try {
      conversionCancelled(cancellation);
      surface.context.imageSmoothingEnabled = false;
      surface.context.drawImage(prepared?.source ?? decoded.source, 0, 0, prepared?.width ?? decoded.width, prepared?.height ?? decoded.height, 0, 0, targetWidth, targetHeight);
      conversionCancelled(cancellation);
      const data = surface.context.getImageData(0, 0, targetWidth, targetHeight).data;
      conversionCancelled(cancellation);
      if (data.length < targetWidth * targetHeight * 4) throw new ConversionError('invalid-raster', 'The decoded raster pixel plane is incomplete.');
      conversionCancelled(cancellation);
      const pixels = new Uint8ClampedArray(data as ArrayLike<number>);
      conversionCancelled(cancellation);
      result = {
        width: targetWidth,
        height: targetHeight,
        sourceWidth: decoded.width,
        sourceHeight: decoded.height,
        pixels
      };
    } finally {
      prepared?.dispose();
      surface.dispose?.();
    }
    conversionCancelled(cancellation);
    return result;
  } finally {
    decoded.dispose?.();
  }
}

export async function rasterForConversion(
  source: ConversionRaster | Blob | File,
  targetWidth: number,
  targetHeight: number,
  options: ConversionRasterOptions = {},
  cancellation?: ConversionCancellation
): Promise<ConversionRaster> {
  conversionCancelled(cancellation);
  if (isBlob(source)) return decodeAndResampleImage(source, targetWidth, targetHeight, options, cancellation);
  conversionCancelled(cancellation);
  const raster = resampleRaster(source, targetWidth, targetHeight);
  conversionCancelled(cancellation);
  return raster;
}

export type { TraceCreateImageBitmap, TraceBitmap };
