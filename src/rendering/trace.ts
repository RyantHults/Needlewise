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
import { intersectRect } from '../editor/rect';
import { isWithinImageDecodeBounds, MAX_IMAGE_DECODE_BYTES } from '../image/limits';
import { fitImageWithinWorkingBounds, MAX_WORKING_IMAGE_DIMENSION, MAX_WORKING_IMAGE_PIXELS } from '../image/image-sizing';
import { readImageHeader } from '../image/header';
import { createReadableSurface, preScaleSource, safeCloseBitmap, type PreScaledSource, type ReadableSurface, type ReadableSurfaceFactory } from '../image/surface';
import { clipToRect } from './context';

export const MAX_TRACE_IMAGE_PIXELS = MAX_WORKING_IMAGE_PIXELS;
export const MAX_TRACE_IMAGE_BYTES = MAX_IMAGE_DECODE_BYTES;
const MAX_TRACE_HEADER_BYTES = 64 * 1024;

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

export interface TraceSamplingOptions {
  readonly surfaceFactory?: () => ReadableSurface | undefined;
}

export interface TraceDecodeOptions {
  readonly createImageBitmap?: TraceCreateImageBitmap;
  /** Working overlay bound; oversized decodes are pre-scaled down to it. */
  readonly maxPixels?: number;
  readonly maxBytes?: number;
  /** Sized surface factory used to pre-scale oversized decodes. */
  readonly surfaceFactory?: ReadableSurfaceFactory;
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

export type TraceDecodeErrorCode = 'unsupported-format' | 'too-large' | 'unavailable' | 'decode-failed' | 'invalid-dimensions';

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
  const visibleRect = intersectRect(screenRect, { x: 0, y: 0, width: Math.max(0, metrics.cssWidth), height: Math.max(0, metrics.cssHeight) });
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
  const surface = options.surfaceFactory?.() ?? createReadableSurface(1, 1);
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

/** Aspect-preserving contain fit of an oversized decode into the shared working bounds. */
function fitTraceDecodeBounds(width: number, height: number, workingPixels: number): { width: number; height: number } {
  return fitImageWithinWorkingBounds(width, height, MAX_WORKING_IMAGE_DIMENSION, workingPixels);
}

export async function decodeTraceImage(blob: Blob, options: TraceDecodeOptions = {}): Promise<DecodedTraceImage> {
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
  // The format comes from the bytes, not the declared type, so a mislabelled
  // upload still decodes.
  const dimensions = readImageHeader(new Uint8Array(header));
  if (!dimensions) throw new TraceDecodeError('unsupported-format', 'Reference images must be PNG, JPEG, or WebP.');
  // The decode ceiling (shared with conversion and persistence) gates
  // allocation; the working overlay bound is enforced by pre-scaling the
  // decoded bitmap down to it.
  if (!isWithinImageDecodeBounds(dimensions.width, dimensions.height)) {
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
    safeCloseBitmap(bitmap);
    throw new TraceDecodeError('invalid-dimensions', 'The decoded reference image dimensions are invalid or exceed the pixel limit.');
  }
  // Oversized decodes are pre-scaled to the working overlay bound instead of
  // being rejected; the trace image reports the pre-scaled dimensions so the
  // projection/sampling math stays consistent with the held source.
  const workingPixels = options.maxPixels ?? MAX_TRACE_IMAGE_PIXELS;
  let prepared: PreScaledSource | undefined;
  if (bitmap.width * bitmap.height > workingPixels) {
    try {
      const fitted = fitTraceDecodeBounds(bitmap.width, bitmap.height, workingPixels);
      prepared = preScaleSource(bitmap, bitmap.width, bitmap.height, fitted.width, fitted.height, options.surfaceFactory);
    } catch (error) {
      safeCloseBitmap(bitmap);
      throw error;
    }
    if (!prepared) {
      safeCloseBitmap(bitmap);
      throw new TraceDecodeError('unavailable', 'This environment cannot pre-scale local reference images.');
    }
  }
  // The full-resolution decode is no longer needed once the pre-scaled canvas
  // exists, so release it immediately instead of holding both in memory.
  // Capture the decoded dimensions before release: a closed ImageBitmap
  // reports width/height as 0 in browsers, which would zero the persisted
  // source descriptor on pre-scaled uploads.
  const bitmapClosed = prepared !== undefined;
  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;
  if (prepared) safeCloseBitmap(bitmap);
  let disposed = false;
  return {
    bitmap,
    source: prepared?.source ?? bitmap,
    width: prepared?.width ?? sourceWidth,
    height: prepared?.height ?? sourceHeight,
    sourceWidth,
    sourceHeight,
    visible: true,
    opacity: 1,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      prepared?.dispose();
      if (!bitmapClosed) safeCloseBitmap(bitmap);
    }
  };
}

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
  const width = Math.min(patternWidth, Math.max(1, Math.round(imageWidth * powerScale)));
  const height = Math.min(patternHeight, Math.max(1, Math.round(imageHeight * powerScale)));
  // Round the fitted dimensions first, then recenter them. This keeps every
  // persisted bound a safe integer while ensuring rounding cannot overflow the
  // containing pattern.
  const x = Math.round((patternWidth - width) / 2);
  const y = Math.round((patternHeight - height) / 2);
  return { x, y, width, height };
}
