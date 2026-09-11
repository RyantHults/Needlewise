import {
  decodeTraceImage,
  MAX_TRACE_HEADER_BYTES,
  type TraceCreateImageBitmap,
  type TraceDecodeOptions,
  type TraceBitmap
} from '../rendering/trace';
import {
  ConversionError,
  conversionCancelled,
  MAX_CONVERSION_DECODE_DIMENSION,
  MAX_CONVERSION_DECODE_PIXELS,
  MAX_CONVERSION_DIMENSION,
  MAX_CONVERSION_SOURCE_BYTES,
  MAX_CONVERSION_TARGET_PIXELS,
  resampleRaster,
  type ConversionCancellation,
  type ConversionRaster
} from './image-to-pattern';
import { fitImageWithinWorkingBounds, MAX_WORKING_IMAGE_DIMENSION, MAX_WORKING_IMAGE_PIXELS } from '../shared/image-sizing';

export interface ConversionRasterContext {
  drawImage(...args: unknown[]): void;
  getImageData(sx: number, sy: number, width: number, height: number): { readonly data: ArrayLike<number> };
  imageSmoothingEnabled?: boolean;
  imageSmoothingQuality?: string;
}

/** Backing canvas of a raster surface; needed as the drawImage source when chaining resample steps. */
export interface ConversionRasterCanvas {
  width: number;
  height: number;
  dispose?(): void;
}

export interface ConversionRasterSurface {
  readonly context: ConversionRasterContext;
  readonly canvas?: ConversionRasterCanvas;
  dispose?(): void;
}

export interface ConversionRasterOptions extends TraceDecodeOptions {
  readonly surfaceFactory?: (width: number, height: number) => ConversionRasterSurface | undefined;
}

type EncodedImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

interface EncodedImageDimensions {
  readonly mimeType: EncodedImageMimeType;
  readonly width: number;
  readonly height: number;
}

interface EncodedSourceProbe {
  readonly mimeType: EncodedImageMimeType;
  readonly header: Uint8Array;
}

function defaultSurface(width: number, height: number): ConversionRasterSurface | undefined {
  try {
    if (typeof globalThis.OffscreenCanvas === 'function') {
      const canvas = new globalThis.OffscreenCanvas(width, height);
      const context = canvas.getContext('2d', { willReadFrequently: true }) as ConversionRasterContext | null;
      if (context) return { context, canvas: canvas as unknown as ConversionRasterCanvas, dispose: () => undefined };
    }
  } catch {
    // Fall through to a detached DOM canvas.
  }
  try {
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true }) as ConversionRasterContext | null;
      if (context) return { context, canvas: canvas as unknown as ConversionRasterCanvas, dispose: () => undefined };
    }
  } catch {
    // Restricted workers and jsdom may not provide a readable canvas.
  }
  return undefined;
}

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

function assertTargetDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > MAX_CONVERSION_DIMENSION || height > MAX_CONVERSION_DIMENSION || width * height > MAX_CONVERSION_TARGET_PIXELS) {
    throw new ConversionError('invalid-target', 'Target dimensions are outside the supported bounds.');
  }
}

function readUint16(bytes: Uint8Array, offset: number, littleEndian = false): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, littleEndian);
}

function readUint32(bytes: Uint8Array, offset: number, littleEndian = false): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, littleEndian);
}

function ascii(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset + value.length > bytes.length) return false;
  return [...value].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24 || !ascii(bytes, 0, '\x89PNG\r\n\x1a\n') || !ascii(bytes, 12, 'IHDR')) return undefined;
  return { width: readUint32(bytes, 16), height: readUint32(bytes, 20) };
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return undefined;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) return undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return undefined;
    const length = readUint16(bytes, offset);
    if (length < 2 || offset + length > bytes.length) return undefined;
    const isSof = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf);
    if (isSof && length >= 7) return { height: readUint16(bytes, offset + 3), width: readUint16(bytes, offset + 5) };
    offset += length;
  }
  return undefined;
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 16 || !ascii(bytes, 0, 'RIFF') || !ascii(bytes, 8, 'WEBP')) return undefined;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunk = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const length = readUint32(bytes, offset + 4, true);
    const dataOffset = offset + 8;
    if (chunk === 'VP8X') {
      if (length < 10 || dataOffset + 10 > bytes.length) return undefined;
      return {
        width: 1 + (bytes[dataOffset + 4] | (bytes[dataOffset + 5] << 8) | (bytes[dataOffset + 6] << 16)),
        height: 1 + (bytes[dataOffset + 7] | (bytes[dataOffset + 8] << 8) | (bytes[dataOffset + 9] << 16))
      };
    }
    if (chunk === 'VP8L') {
      if (length < 5 || dataOffset + 5 > bytes.length || bytes[dataOffset] !== 0x2f) return undefined;
      return {
        width: 1 + ((bytes[dataOffset + 1] | (bytes[dataOffset + 2] << 8)) & 0x3fff),
        height: 1 + (((bytes[dataOffset + 2] >> 6) | (bytes[dataOffset + 3] << 2) | (bytes[dataOffset + 4] << 10)) & 0x3fff)
      };
    }
    if (chunk === 'VP8 ') {
      if (length < 10 || dataOffset + 10 > bytes.length || bytes[dataOffset + 3] !== 0x9d || bytes[dataOffset + 4] !== 0x01 || bytes[dataOffset + 5] !== 0x2a) return undefined;
      return { width: readUint16(bytes, dataOffset + 6, true) & 0x3fff, height: readUint16(bytes, dataOffset + 8, true) & 0x3fff };
    }
    if (!Number.isSafeInteger(dataOffset + length) || dataOffset + length > bytes.length) return undefined;
    offset = dataOffset + length + (length & 1);
  }
  return undefined;
}

function detectEncodedImageDimensions(bytes: Uint8Array): EncodedImageDimensions | undefined {
  const png = pngDimensions(bytes);
  if (png) return { mimeType: 'image/png', ...png };
  const jpeg = jpegDimensions(bytes);
  if (jpeg) return { mimeType: 'image/jpeg', ...jpeg };
  const webp = webpDimensions(bytes);
  if (webp) return { mimeType: 'image/webp', ...webp };
  return undefined;
}

async function assertEncodedSourceBounds(source: Blob, options: ConversionRasterOptions, cancellation?: ConversionCancellation): Promise<EncodedSourceProbe> {
  const maxBytes = options.maxBytes ?? MAX_CONVERSION_SOURCE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CONVERSION_SOURCE_BYTES) throw new ConversionError('invalid-raster', 'The image decode limit is outside the supported bounds.');
  if (!Number.isFinite(source.size) || source.size > maxBytes) throw new ConversionError('invalid-raster', 'The image source exceeds the local byte limit.');
  conversionCancelled(cancellation);
  const header = new Uint8Array(await source.slice(0, Math.min(source.size, MAX_TRACE_HEADER_BYTES)).arrayBuffer());
  conversionCancelled(cancellation);
  // The browser-provided MIME is only a hint: uploads can carry a misleading
  // extension or MIME (for example, a WebP named .jpg). Inspect the bytes once
  // and use the detected type for both bounds validation and decoding.
  const dimensions = detectEncodedImageDimensions(header);
  // The conversion pipeline pre-scales oversized decodes to the working bounds
  // itself, so the encoded header only guards against decodes past the memory
  // ceiling (MAX_CONVERSION_DECODE_*).
  if (!dimensions || !Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height) || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > MAX_CONVERSION_DECODE_DIMENSION || dimensions.height > MAX_CONVERSION_DECODE_DIMENSION || dimensions.width * dimensions.height > MAX_CONVERSION_DECODE_PIXELS) {
    throw new ConversionError('invalid-raster', 'The encoded source image dimensions are outside the supported bounds.');
  }
  return { mimeType: dimensions.mimeType, header };
}

/**
 * The shared trace decoder also probes a bounded header. For a recognized WebP
 * chunk whose payload extends beyond that probe, give it a probe-sized chunk
 * length while keeping the original full source for createImageBitmap. The
 * dimensions have already been checked from the required bytes above; this
 * only keeps the decoder's static header inspection from mistaking a valid
 * large chunk for a truncated header.
 */
function traceDecodeSource(source: Blob, mimeType: EncodedImageMimeType, header: Uint8Array): Blob {
  if (mimeType !== 'image/webp' || header.length < 20) return source;
  const chunk = String.fromCharCode(header[12], header[13], header[14], header[15]);
  const required = chunk === 'VP8X' ? 10 : chunk === 'VP8L' ? 5 : chunk === 'VP8 ' ? 10 : 0;
  if (required === 0) return source;
  const length = readUint32(header, 16, true);
  const dataOffset = 20;
  if (length < required || dataOffset + required > header.length || dataOffset + length <= header.length) return source;
  const probe = header.slice();
  new DataView(probe.buffer, probe.byteOffset, probe.byteLength).setUint32(16, probe.length - dataOffset, true);
  const probeBlob = new Blob([probe], { type: mimeType });
  return {
    type: mimeType,
    size: source.size,
    arrayBuffer: () => source.arrayBuffer(),
    slice: (start?: number, end?: number, contentType?: string) => probeBlob.slice(start, end, contentType)
  } as unknown as Blob;
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

export interface PreparedRasterSource {
  /** The final prepared drawImage source (an intermediate canvas or the original source). */
  readonly source: unknown;
  readonly width: number;
  readonly height: number;
  /** Releases every surface created during pre-scaling, including the final one. */
  dispose(): void;
}

/**
 * Pre-scale a decoded source to the fitted working dimensions using the
 * established high-quality downscale approach: successive exact-2x halvings
 * (each with high-quality smoothing) while a single final draw would still
 * reduce an axis by more than 2x, then one final high-quality draw to the
 * exact fitted size (final reduction factor <=2x per axis, never upscaling).
 * Every intermediate canvas is released on success and on failure.
 */
export function preScaleRasterSource(
  source: unknown,
  width: number,
  height: number,
  fittedWidth: number,
  fittedHeight: number,
  surfaceFactory: ((width: number, height: number) => ConversionRasterSurface | undefined) | undefined,
  cancellation?: ConversionCancellation
): PreparedRasterSource {
  const factory = surfaceFactory ?? defaultSurface;
  const surfaces: ConversionRasterSurface[] = [];
  const releaseAll = (): void => {
    for (const surface of surfaces) {
      if (surface.canvas) {
        surface.canvas.width = 0;
        surface.canvas.height = 0;
      }
      surface.dispose?.();
    }
    surfaces.length = 0;
  };
  let current = source;
  let currentWidth = width;
  let currentHeight = height;
  try {
    while (currentWidth > fittedWidth * 2 || currentHeight > fittedHeight * 2) {
      conversionCancelled(cancellation);
      const halfWidth = Math.ceil(currentWidth / 2);
      const halfHeight = Math.ceil(currentHeight / 2);
      const surface = factory(halfWidth, halfHeight);
      if (!surface) throw new ConversionError('unavailable', 'A readable local raster surface is unavailable.');
      surfaces.push(surface);
      surface.context.imageSmoothingEnabled = true;
      surface.context.imageSmoothingQuality = 'high';
      surface.context.drawImage(current, 0, 0, currentWidth, currentHeight, 0, 0, halfWidth, halfHeight);
      if (!surface.canvas) throw new ConversionError('unavailable', 'A readable local raster surface is unavailable.');
      current = surface.canvas;
      currentWidth = halfWidth;
      currentHeight = halfHeight;
    }
    conversionCancelled(cancellation);
    if (currentWidth !== fittedWidth || currentHeight !== fittedHeight) {
      const surface = factory(fittedWidth, fittedHeight);
      if (!surface) throw new ConversionError('unavailable', 'A readable local raster surface is unavailable.');
      surfaces.push(surface);
      surface.context.imageSmoothingEnabled = true;
      surface.context.imageSmoothingQuality = 'high';
      surface.context.drawImage(current, 0, 0, currentWidth, currentHeight, 0, 0, fittedWidth, fittedHeight);
      if (!surface.canvas) throw new ConversionError('unavailable', 'A readable local raster surface is unavailable.');
      current = surface.canvas;
      currentWidth = fittedWidth;
      currentHeight = fittedHeight;
    }
    return { source: current, width: currentWidth, height: currentHeight, dispose: releaseAll };
  } catch (error) {
    releaseAll();
    throw error;
  }
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
  const detected = await assertEncodedSourceBounds(source, options, cancellation);
  const detectedMimeType = detected.mimeType;
  conversionCancelled(cancellation);
  const createImageBitmap = options.createImageBitmap ?? (typeof globalThis.createImageBitmap === 'function' ? globalThis.createImageBitmap.bind(globalThis) as TraceCreateImageBitmap : undefined);
  const declaredMimeType = source.type.trim().toLowerCase();
  const canonicalSource = declaredMimeType === detectedMimeType ? source : source.slice(0, source.size, detectedMimeType);
  const sourceForDecode = traceDecodeSource(canonicalSource, detectedMimeType, detected.header);
  // The conversion pipeline pre-scales oversized decodes to the working bounds,
  // so the trace decode limit is raised to the full decode ceiling.
  const decodeOptions: ConversionRasterOptions = {
    ...options,
    maxBytes: options.maxBytes,
    maxPixels: MAX_CONVERSION_DECODE_PIXELS,
    ...(createImageBitmap === undefined ? {} : {
      createImageBitmap: async (blob, bitmapOptions) => {
        conversionCancelled(cancellation);
        let bitmap: TraceBitmap | undefined;
        try {
          bitmap = await createImageBitmap(canonicalSource, bitmapOptions);
          conversionCancelled(cancellation);
          return bitmap;
        } catch (error) {
          try {
            bitmap?.close?.();
          } catch {
            // Preserve the decode or cancellation failure.
          }
          throw error;
        }
      }
    })
  };
  let decoded;
  try {
    decoded = await decodeTraceImage(sourceForDecode, decodeOptions);
  } catch (error) {
    conversionCancelled(cancellation);
    throw error;
  }
  try {
    conversionCancelled(cancellation);
    if (!Number.isSafeInteger(decoded.width) || !Number.isSafeInteger(decoded.height) || decoded.width < 1 || decoded.height < 1 || decoded.width > MAX_CONVERSION_DECODE_DIMENSION || decoded.height > MAX_CONVERSION_DECODE_DIMENSION || decoded.width * decoded.height > MAX_CONVERSION_DECODE_PIXELS) {
      throw new ConversionError('invalid-raster', 'The decoded source image dimensions are outside the supported bounds.');
    }
    conversionCancelled(cancellation);
    // Oversized decodes are pre-scaled down to the working bounds
    // (aspect-preserving) instead of being rejected; the recorded source
    // dimensions keep the true original size.
    const fitted = fitRasterWithinBounds(decoded.width, decoded.height);
    let prepared: PreparedRasterSource | undefined;
    if (fitted.width !== decoded.width || fitted.height !== decoded.height) {
      prepared = preScaleRasterSource(decoded.source, decoded.width, decoded.height, fitted.width, fitted.height, options.surfaceFactory, cancellation);
    }
    conversionCancelled(cancellation);
    const surface = options.surfaceFactory?.(targetWidth, targetHeight) ?? defaultSurface(targetWidth, targetHeight);
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
