import type {
  CanvasContextAdapter,
  CanvasMetrics,
  DocumentSize,
  Rect,
  ScreenPoint,
  TraceImage,
  TraceImageCrop,
  TraceRgb,
  Viewport
} from '../editor/contracts';
import { cellToScreenRect } from '../editor/coordinates';
import { isWithinImageDecodeBounds, MAX_IMAGE_DECODE_BYTES } from '../shared/limits';

export const MAX_TRACE_IMAGE_PIXELS = 16_000_000;
export const MAX_TRACE_IMAGE_BYTES = MAX_IMAGE_DECODE_BYTES;
export const MAX_TRACE_HEADER_BYTES = 64 * 1024;
export const TRACE_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export interface TraceImageProjection {
  readonly sourceRect: Rect;
  readonly modelRect: Rect;
  /** Full destination in CSS pixels, before canvas clipping. */
  readonly screenRect: Rect;
  /** Destination intersected with the CSS canvas and chart bounds. */
  readonly visibleRect: Rect | undefined;
  readonly backingRect: Rect;
  readonly visibleBackingRect: Rect | undefined;
  readonly opacity: number;
}

export interface TraceSamplingContext {
  drawImage(...args: unknown[]): void;
  getImageData(sx: number, sy: number, width: number, height: number): { readonly data: ArrayLike<number> };
  imageSmoothingEnabled?: boolean;
  imageSmoothingQuality?: string;
}

export interface TraceSamplingCanvas {
  width: number;
  height: number;
  dispose?(): void;
}

export interface TraceSamplingSurface {
  readonly context: TraceSamplingContext;
  readonly canvas?: TraceSamplingCanvas;
  dispose?(): void;
}

export interface TraceSamplingOptions {
  readonly surfaceFactory?: () => TraceSamplingSurface | undefined;
}

export interface TraceDecodeOptions {
  readonly createImageBitmap?: TraceCreateImageBitmap;
  /** Working overlay bound; oversized decodes are pre-scaled down to it. */
  readonly maxPixels?: number;
  readonly maxBytes?: number;
  /** Sized surface factory used to pre-scale oversized decodes. */
  readonly surfaceFactory?: (width: number, height: number) => TraceSamplingSurface | undefined;
}

export interface TraceBitmap {
  readonly width: number;
  readonly height: number;
  close?(): void;
}

export type TraceCreateImageBitmap = (
  source: Blob,
  options?: { readonly imageOrientation?: 'from-image' | 'none' }
) => Promise<TraceBitmap>;

export interface DecodedTraceImage extends TraceImage {
  readonly bitmap: TraceBitmap;
  /**
   * Original decoded dimensions before pre-scaling to the working overlay
   * bound. Equal to width/height when the bitmap already fits; when oversized,
   * the descriptor (persisted metadata about the original asset) must use
   * these, while width/height describe the pre-scaled overlay source.
   */
  readonly sourceWidth?: number;
  readonly sourceHeight?: number;
}

export type TraceDecodeErrorCode = 'unsupported-format' | 'too-large' | 'unavailable' | 'decode-failed' | 'invalid-signature' | 'invalid-dimensions';

export class TraceDecodeError extends Error {
  constructor(readonly code: TraceDecodeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TraceDecodeError';
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validCrop(crop: TraceImageCrop): boolean {
  return [crop.x, crop.y, crop.width, crop.height].every((value) => Number.isFinite(value))
    && crop.x >= 0
    && crop.y >= 0
    && crop.width > 0
    && crop.height > 0
    && crop.x + crop.width <= 1
    && crop.y + crop.height <= 1;
}

function intersectRects(left: Rect, right: Rect): Rect | undefined {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const rightEdge = Math.min(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.min(left.y + left.height, right.y + right.height);
  if (rightEdge <= x || bottomEdge <= y) return undefined;
  return { x, y, width: rightEdge - x, height: bottomEdge - y };
}

function chartModelRect(trace: TraceImage, document: DocumentSize): Rect | undefined {
  const source = trace.chartBounds ?? { x: 0, y: 0, width: document.width, height: document.height };
  if (![source.x, source.y, source.width, source.height].every((value) => Number.isFinite(value)) || source.width <= 0 || source.height <= 0) return undefined;
  // Unbounded placement: negative origins and overflow past the document edge
  // are valid. The projection intersects the model rect with the CSS canvas
  // (visibleRect) so off-chart margins render and clip correctly.
  return { x: source.x, y: source.y, width: source.width, height: source.height };
}

function dprOf(metrics: Pick<CanvasMetrics, 'dpr'>): number {
  return Number.isFinite(metrics.dpr) && metrics.dpr > 0 ? metrics.dpr : 1;
}

function opacityOf(trace: TraceImage): number {
  return Number.isFinite(trace.opacity ?? 1) ? clamp(trace.opacity ?? 1, 0, 1) : 0;
}

function scaleRect(rect: Rect, scale: number): Rect {
  return { x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale };
}

/**
 * Return the one canonical source-to-chart projection. Both drawing and
 * eyedropper sampling use this projection so pan, zoom, crop, and DPR cannot
 * drift apart.
 */
export function createTraceImageProjection(
  trace: TraceImage,
  document: DocumentSize,
  viewport: Viewport,
  metrics: Pick<CanvasMetrics, 'cssWidth' | 'cssHeight' | 'dpr'>
): TraceImageProjection | undefined {
  if (!positiveInteger(trace.width) || !positiveInteger(trace.height)) return undefined;
  const crop = trace.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  if (!validCrop(crop)) return undefined;
  const modelRect = chartModelRect(trace, document);
  if (!modelRect) return undefined;
  const screenRect = cellToScreenRect(modelRect, viewport);
  const visibleRect = intersectRects(screenRect, { x: 0, y: 0, width: Math.max(0, metrics.cssWidth), height: Math.max(0, metrics.cssHeight) });
  const sourceRect = {
    x: crop.x * trace.width,
    y: crop.y * trace.height,
    width: crop.width * trace.width,
    height: crop.height * trace.height
  };
  const dpr = dprOf(metrics);
  return {
    sourceRect,
    modelRect,
    screenRect,
    visibleRect,
    backingRect: scaleRect(screenRect, dpr),
    visibleBackingRect: visibleRect ? scaleRect(visibleRect, dpr) : undefined,
    opacity: opacityOf(trace)
  };
}

export const createTraceProjection = createTraceImageProjection;
export const traceImageProjection = createTraceImageProjection;
export const projectTraceImage = createTraceImageProjection;

function sourceRectForDestination(projection: TraceImageProjection, destination: Rect): Rect {
  const xRatio = projection.screenRect.width === 0 ? 0 : (destination.x - projection.screenRect.x) / projection.screenRect.width;
  const yRatio = projection.screenRect.height === 0 ? 0 : (destination.y - projection.screenRect.y) / projection.screenRect.height;
  const widthRatio = projection.screenRect.width === 0 ? 0 : destination.width / projection.screenRect.width;
  const heightRatio = projection.screenRect.height === 0 ? 0 : destination.height / projection.screenRect.height;
  return {
    x: projection.sourceRect.x + projection.sourceRect.width * xRatio,
    y: projection.sourceRect.y + projection.sourceRect.height * yRatio,
    width: projection.sourceRect.width * widthRatio,
    height: projection.sourceRect.height * heightRatio
  };
}

function clipToRect(context: CanvasContextAdapter, rect: Rect): boolean {
  if (!context.clip || !context.save || !context.restore) return false;
  context.save();
  context.beginPath();
  context.moveTo(rect.x, rect.y);
  context.lineTo(rect.x + rect.width, rect.y);
  context.lineTo(rect.x + rect.width, rect.y + rect.height);
  context.lineTo(rect.x, rect.y + rect.height);
  context.closePath?.();
  context.clip();
  return true;
}

export function drawTraceImage(
  context: CanvasContextAdapter,
  trace: TraceImage | undefined,
  document: DocumentSize,
  viewport: Viewport,
  metrics: Pick<CanvasMetrics, 'cssWidth' | 'cssHeight' | 'dpr'>
): boolean {
  if (!trace || trace.visible === false || !trace.source || typeof context.drawImage !== 'function') return false;
  const projection = createTraceImageProjection(trace, document, viewport, metrics);
  if (!projection?.visibleRect || projection.opacity <= 0) return false;
  const destination = projection.visibleRect;
  const source = sourceRectForDestination(projection, destination);
  const clipped = clipToRect(context, destination);
  context.save?.();
  context.globalAlpha = projection.opacity;
  // Nearest-neighbor keeps the reference image edges sharp when mapping pixels to stitch cells; smoothing would invent colors between distant source pixels.
  if (context.imageSmoothingEnabled !== undefined) context.imageSmoothingEnabled = false;
  context.drawImage(
    trace.source,
    source.x,
    source.y,
    source.width,
    source.height,
    destination.x,
    destination.y,
    destination.width,
    destination.height
  );
  context.restore?.();
  if (clipped) context.restore?.();
  return true;
}

export const drawTrace = drawTraceImage;

function createSamplingSurface(width: number, height: number): TraceSamplingSurface | undefined {
  try {
    if (typeof globalThis.OffscreenCanvas === 'function') {
      const canvas = new globalThis.OffscreenCanvas(width, height);
      const context = canvas.getContext('2d', { willReadFrequently: true }) as TraceSamplingContext | null;
      if (context) return { context, canvas: canvas as unknown as TraceSamplingCanvas, dispose: () => undefined };
    }
  } catch {
    // Fall through to a detached DOM canvas.
  }
  try {
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true }) as TraceSamplingContext | null;
      if (context) return { context, canvas: canvas as unknown as TraceSamplingCanvas, dispose: () => undefined };
    }
  } catch {
    // Restricted workers and jsdom may not provide a readable canvas.
  }
  return undefined;
}

function defaultSamplingSurface(): TraceSamplingSurface | undefined {
  return createSamplingSurface(1, 1);
}

function containsPoint(rect: Rect, point: ScreenPoint): boolean {
  return point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.width && point.y < rect.y + rect.height;
}

export function sampleTraceImage(
  trace: TraceImage | undefined,
  document: DocumentSize,
  viewport: Viewport,
  metrics: Pick<CanvasMetrics, 'cssWidth' | 'cssHeight' | 'dpr'>,
  point: ScreenPoint,
  options: TraceSamplingOptions = {}
): TraceRgb | undefined {
  if (!trace || trace.visible === false) return undefined;
  const projection = createTraceImageProjection(trace, document, viewport, metrics);
  if (!projection?.visibleRect || !containsPoint(projection.visibleRect, point)) return undefined;
  const sourcePoint = sourceRectForDestination(projection, { x: point.x, y: point.y, width: 0, height: 0 });
  const sourceX = clamp(Math.floor(sourcePoint.x), 0, trace.width - 1);
  const sourceY = clamp(Math.floor(sourcePoint.y), 0, trace.height - 1);
  const surface = options.surfaceFactory?.() ?? defaultSamplingSurface();
  if (!surface) return undefined;
  try {
    surface.context.drawImage(trace.source, sourceX, sourceY, 1, 1, 0, 0, 1, 1);
    const data = surface.context.getImageData(0, 0, 1, 1).data;
    if (data.length < 3) return undefined;
    return { r: Number(data[0]), g: Number(data[1]), b: Number(data[2]) };
  } catch {
    return undefined;
  } finally {
    surface.dispose?.();
  }
}

export const sampleTraceAt = sampleTraceImage;
export const sampleTraceRgb = sampleTraceImage;

function supportedMimeType(value: string): boolean {
  return (TRACE_IMAGE_MIME_TYPES as readonly string[]).includes(value.toLowerCase());
}

function validSignature(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === 'image/png') {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    return bytes.length >= 24
      && signature.every((byte, index) => bytes[index] === byte)
      && bytes[12] === 73
      && bytes[13] === 72
      && bytes[14] === 68
      && bytes[15] === 82;
  }
  if (mimeType === 'image/jpeg') return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
  return bytes.length >= 12
    && bytes[0] === 82
    && bytes[1] === 73
    && bytes[2] === 70
    && bytes[3] === 70
    && bytes[8] === 87
    && bytes[9] === 69
    && bytes[10] === 66
    && bytes[11] === 80;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, false);
}

function readUint16LittleEndian(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function jpegHeaderDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
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

function webpHeaderDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunk = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true);
    const dataOffset = offset + 8;
    if (dataOffset + length > bytes.length) return undefined;
    if (chunk === 'VP8X' && length >= 10) {
      return {
        width: 1 + (bytes[dataOffset + 4] | (bytes[dataOffset + 5] << 8) | (bytes[dataOffset + 6] << 16)),
        height: 1 + (bytes[dataOffset + 7] | (bytes[dataOffset + 8] << 8) | (bytes[dataOffset + 9] << 16))
      };
    }
    if (chunk === 'VP8L' && length >= 6 && bytes[dataOffset] === 0x2f) {
      return {
        width: 1 + ((bytes[dataOffset + 1] | (bytes[dataOffset + 2] << 8)) & 0x3fff),
        height: 1 + (((bytes[dataOffset + 2] >> 6) | (bytes[dataOffset + 3] << 2) | (bytes[dataOffset + 4] << 10)) & 0x3fff)
      };
    }
    if (chunk === 'VP8 ' && length >= 10 && bytes[dataOffset + 3] === 0x9d && bytes[dataOffset + 4] === 0x01 && bytes[dataOffset + 5] === 0x2a) {
      return {
        width: readUint16LittleEndian(bytes, dataOffset + 6) & 0x3fff,
        height: readUint16LittleEndian(bytes, dataOffset + 8) & 0x3fff
      };
    }
    offset = dataOffset + length + (length & 1);
  }
  return undefined;
}

function staticDimensions(bytes: Uint8Array, mimeType: string): { width: number; height: number } | undefined {
  if (mimeType === 'image/png' && bytes.length >= 24) return { width: readUint32(bytes, 16), height: readUint32(bytes, 20) };
  if (mimeType === 'image/jpeg' && bytes.length >= 2) return jpegHeaderDimensions(bytes);
  if (mimeType === 'image/webp' && bytes.length >= 16) return webpHeaderDimensions(bytes);
  return undefined;
}

function closeBitmap(bitmap: TraceBitmap): void {
  try {
    bitmap.close?.();
  } catch {
    // A failed close must not hide the decode validation error.
  }
}

/** Aspect-preserving contain fit of an oversized decode into a working pixel bound (round down, min 1). */
function fitTraceDecodeBounds(width: number, height: number, workingPixels: number): { width: number; height: number } {
  const scale = Math.sqrt(workingPixels / (width * height));
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale))
  };
}

interface PreparedTraceSource {
  readonly source: unknown;
  readonly width: number;
  readonly height: number;
  dispose(): void;
}

/**
 * Pre-scale an oversized decoded source to the fitted working dimensions using
 * the same approach as the conversion pipeline: successive exact-2x halvings
 * (each with high-quality smoothing) while a single final draw would still
 * reduce an axis by more than 2x, then one final high-quality draw to the
 * exact fitted size (final reduction factor <=2x per axis, never upscaling).
 * Every intermediate canvas is released on success and on failure.
 */
function preScaleTraceSource(
  source: unknown,
  width: number,
  height: number,
  fittedWidth: number,
  fittedHeight: number,
  surfaceFactory: ((width: number, height: number) => TraceSamplingSurface | undefined) | undefined
): PreparedTraceSource {
  const factory = surfaceFactory ?? createSamplingSurface;
  const surfaces: TraceSamplingSurface[] = [];
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
      const halfWidth = Math.ceil(currentWidth / 2);
      const halfHeight = Math.ceil(currentHeight / 2);
      const surface = factory(halfWidth, halfHeight);
      if (!surface) throw new TraceDecodeError('unavailable', 'This environment cannot pre-scale local reference images.');
      surfaces.push(surface);
      surface.context.imageSmoothingEnabled = true;
      surface.context.imageSmoothingQuality = 'high';
      surface.context.drawImage(current, 0, 0, currentWidth, currentHeight, 0, 0, halfWidth, halfHeight);
      if (!surface.canvas) throw new TraceDecodeError('unavailable', 'This environment cannot pre-scale local reference images.');
      current = surface.canvas;
      currentWidth = halfWidth;
      currentHeight = halfHeight;
    }
    if (currentWidth !== fittedWidth || currentHeight !== fittedHeight) {
      const surface = factory(fittedWidth, fittedHeight);
      if (!surface) throw new TraceDecodeError('unavailable', 'This environment cannot pre-scale local reference images.');
      surfaces.push(surface);
      surface.context.imageSmoothingEnabled = true;
      surface.context.imageSmoothingQuality = 'high';
      surface.context.drawImage(current, 0, 0, currentWidth, currentHeight, 0, 0, fittedWidth, fittedHeight);
      if (!surface.canvas) throw new TraceDecodeError('unavailable', 'This environment cannot pre-scale local reference images.');
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

export async function decodeTraceImage(blob: Blob, options: TraceDecodeOptions = {}): Promise<DecodedTraceImage> {
  const mimeType = typeof blob?.type === 'string' ? blob.type.trim().toLowerCase() : '';
  if (!supportedMimeType(mimeType)) throw new TraceDecodeError('unsupported-format', 'Reference images must be PNG, JPEG, or WebP.');
  if (!blob || typeof blob.arrayBuffer !== 'function') throw new TraceDecodeError('decode-failed', 'The local reference image data is unavailable.');
  const maxBytes = options.maxBytes ?? MAX_TRACE_IMAGE_BYTES;
  if (!Number.isFinite(blob.size) || blob.size > maxBytes) throw new TraceDecodeError('too-large', 'Reference image data exceeds the local size limit.');
  let header: ArrayBuffer;
  try {
    const headerBlob = blob.slice(0, Math.min(blob.size, MAX_TRACE_HEADER_BYTES));
    header = await headerBlob.arrayBuffer();
  } catch (error) {
    throw new TraceDecodeError('decode-failed', 'The local reference image data could not be read.', { cause: error });
  }
  const headerBytes = new Uint8Array(header);
  if (!validSignature(headerBytes, mimeType)) throw new TraceDecodeError('invalid-signature', 'The local reference image signature does not match its MIME type.');
  const dimensions = staticDimensions(headerBytes, mimeType);
  // The decode ceiling (shared with conversion and persistence) gates
  // allocation; the working overlay bound is enforced by pre-scaling the
  // decoded bitmap down to it.
  if (!dimensions || !isWithinImageDecodeBounds(dimensions.width, dimensions.height)) {
    throw new TraceDecodeError('invalid-dimensions', 'The encoded reference image dimensions are invalid or exceed the pixel limit.');
  }
  const createImageBitmap = options.createImageBitmap ?? (typeof globalThis.createImageBitmap === 'function' ? globalThis.createImageBitmap.bind(globalThis) as TraceCreateImageBitmap : undefined);
  if (!createImageBitmap) throw new TraceDecodeError('unavailable', 'This environment cannot decode local reference images.');
  let bitmap: TraceBitmap | undefined;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch (error) {
    throw new TraceDecodeError('decode-failed', 'The local reference image could not be decoded.', { cause: error });
  }
  if (!bitmap || !isWithinImageDecodeBounds(bitmap.width, bitmap.height)) {
    if (bitmap) closeBitmap(bitmap);
    throw new TraceDecodeError('invalid-dimensions', 'The decoded reference image dimensions are invalid or exceed the pixel limit.');
  }
  // Oversized decodes are pre-scaled to the working overlay bound instead of
  // being rejected; the trace image reports the pre-scaled dimensions so the
  // projection/sampling math stays consistent with the held source.
  const workingPixels = options.maxPixels ?? MAX_TRACE_IMAGE_PIXELS;
  let prepared: PreparedTraceSource | undefined;
  if (bitmap.width * bitmap.height > workingPixels) {
    try {
      const fitted = fitTraceDecodeBounds(bitmap.width, bitmap.height, workingPixels);
      prepared = preScaleTraceSource(bitmap, bitmap.width, bitmap.height, fitted.width, fitted.height, options.surfaceFactory);
    } catch (error) {
      closeBitmap(bitmap);
      throw error;
    }
  }
  // The full-resolution decode is no longer needed once the pre-scaled canvas
  // exists, so release it immediately instead of holding both in memory.
  const bitmapClosed = prepared !== undefined;
  if (prepared) closeBitmap(bitmap);
  let disposed = false;
  return {
    bitmap,
    source: prepared?.source ?? bitmap,
    width: prepared?.width ?? bitmap.width,
    height: prepared?.height ?? bitmap.height,
    sourceWidth: bitmap.width,
    sourceHeight: bitmap.height,
    visible: true,
    opacity: 1,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      prepared?.dispose();
      if (!bitmapClosed) closeBitmap(bitmap);
    }
  };
}

export const decodeTraceAsset = decodeTraceImage;
export const decodeLocalTraceImage = decodeTraceImage;

export function disposeTraceImage(trace: TraceImage | undefined): void {
  trace?.dispose?.();
}

/**
 * Compute the chart-cell rectangle an imported reference image should occupy
 * so the image is contained within the pattern, keeps its aspect ratio, and
 * maps each chart cell to a clean power-of-two block of source pixels. The
 * snapped scale also works when enlarging (each chart cell then corresponds
 * to a clean 2^k×2^k sub-grid of cells per source pixel region).
 */
export function fitTraceImageBounds(
  imageWidth: number,
  imageHeight: number,
  patternWidth: number,
  patternHeight: number
): { x: number; y: number; width: number; height: number } {
  const fallback = { x: 0, y: 0, width: patternWidth, height: patternHeight };
  if (!positiveInteger(imageWidth) || !positiveInteger(imageHeight) || !positiveInteger(patternWidth) || !positiveInteger(patternHeight)) return fallback;
  const fitScale = Math.min(patternWidth / imageWidth, patternHeight / imageHeight);
  const powerScale = Math.pow(2, Math.floor(Math.log2(fitScale)));
  const width = imageWidth * powerScale;
  const height = imageHeight * powerScale;
  // Clamp with a small epsilon so floating point cannot push x+width (or
  // y+height) just past the pattern edge while leaving a hairline gap on the
  // other side after the round trip through layout arithmetic.
  const x = Math.min(Math.max(0, (patternWidth - width) / 2), Math.max(0, patternWidth - width));
  const y = Math.min(Math.max(0, (patternHeight - height) / 2), Math.max(0, patternHeight - height));
  return { x, y, width, height };
}

export const fitTraceBounds = fitTraceImageBounds;
