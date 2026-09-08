import {
  type CanvasMetrics,
  type CellRect,
  type DprOptions,
  type DocumentSize,
  type FixedPoint,
  type ModelPoint,
  type Rect,
  type ScreenPoint,
  type Viewport
} from './contracts';

export const FIXED_POINT_UNITS_PER_CELL = 4;
export const DEFAULT_MAX_DPR = 2;
export const DEFAULT_MAX_BACKING_PIXELS = 16_777_216;

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sizeOf(size: DocumentSize | { width: number; height: number }): DocumentSize {
  return { width: Math.max(0, Math.floor(size.width)), height: Math.max(0, Math.floor(size.height)) };
}

export function isFiniteModelPoint(point: ModelPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

export function isFiniteScreenPoint(point: ScreenPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

export function isFiniteFixedPoint(point: FixedPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

export function isFiniteViewport(viewport: Viewport): boolean {
  return Number.isFinite(viewport.x) && Number.isFinite(viewport.y) && Number.isFinite(viewport.zoom) && viewport.zoom > 0;
}

function assertFinitePoint(point: ModelPoint | ScreenPoint | FixedPoint, label: string): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new RangeError(`${label} coordinates must be finite.`);
}

function assertFiniteViewport(viewport: Viewport): void {
  if (!isFiniteViewport(viewport)) throw new RangeError('Viewport coordinates and zoom must be finite, with a positive zoom.');
}

/** Model coordinates are in cells; screen coordinates are in CSS pixels. */
export function modelToScreen(point: ModelPoint, viewport: Viewport): ScreenPoint {
  assertFinitePoint(point, 'Model');
  assertFiniteViewport(viewport);
  const originX = viewport.x;
  const originY = viewport.y;
  const zoom = viewport.zoom;
  return {
    x: (point.x - originX) * zoom,
    y: (point.y - originY) * zoom
  };
}

export function screenToModel(point: ScreenPoint, viewport: Viewport): ModelPoint {
  assertFinitePoint(point, 'Screen');
  assertFiniteViewport(viewport);
  const zoom = viewport.zoom;
  return {
    x: viewport.x + point.x / zoom,
    y: viewport.y + point.y / zoom
  };
}

export function fixedToModel(point: FixedPoint): ModelPoint {
  assertFinitePoint(point, 'Fixed-point');
  return {
    x: point.x / FIXED_POINT_UNITS_PER_CELL,
    y: point.y / FIXED_POINT_UNITS_PER_CELL
  };
}

export function modelToFixed(point: ModelPoint): FixedPoint {
  assertFinitePoint(point, 'Model');
  return {
    x: point.x * FIXED_POINT_UNITS_PER_CELL,
    y: point.y * FIXED_POINT_UNITS_PER_CELL
  };
}

export const fixedPointToModel = fixedToModel;
export const modelToFixedPoint = modelToFixed;

export function fixedToScreen(point: FixedPoint, viewport: Viewport): ScreenPoint {
  return modelToScreen(fixedToModel(point), viewport);
}

export function screenToFixed(point: ScreenPoint, viewport: Viewport): FixedPoint {
  const model = screenToModel(point, viewport);
  return {
    x: Math.round(model.x * FIXED_POINT_UNITS_PER_CELL),
    y: Math.round(model.y * FIXED_POINT_UNITS_PER_CELL)
  };
}

export const fixedPointToScreen = fixedToScreen;
export const screenToFixedPoint = screenToFixed;

export function cellToScreenRect(cell: CellRect | { x: number; y: number; width?: number; height?: number }, viewport: Viewport): Rect {
  const width = cell.width === undefined ? 1 : cell.width;
  const height = cell.height === undefined ? 1 : cell.height;
  assertFinitePoint(cell, 'Cell');
  if (!Number.isFinite(width) || !Number.isFinite(height)) throw new RangeError('Cell dimensions must be finite.');
  assertFiniteViewport(viewport);
  const topLeft = modelToScreen({ x: cell.x, y: cell.y }, viewport);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: width * viewport.zoom,
    height: height * viewport.zoom
  };
}

export function cellToModel(cell: ModelPoint): ModelPoint {
  assertFinitePoint(cell, 'Cell');
  return { x: cell.x, y: cell.y };
}

export function modelToCell(point: ModelPoint): ModelPoint {
  assertFinitePoint(point, 'Model');
  return { x: Math.floor(point.x), y: Math.floor(point.y) };
}

export const cellToScreen = cellToScreenRect;

export function screenToCell(point: ScreenPoint, viewport: Viewport, documentSize?: DocumentSize): ModelPoint {
  const model = screenToCellUnclamped(point, viewport);
  let x = model.x;
  let y = model.y;
  if (documentSize) {
    const size = sizeOf(documentSize);
    x = Math.min(Math.max(x, 0), Math.max(0, size.width - 1));
    y = Math.min(Math.max(y, 0), Math.max(0, size.height - 1));
  }
  return { x, y };
}

/** Paint hit testing uses this form so a pointer in the canvas margin never clamps to an edge cell. */
export function screenToCellUnclamped(point: ScreenPoint, viewport: Viewport): ModelPoint {
  assertFinitePoint(point, 'Screen');
  assertFiniteViewport(viewport);
  const model = screenToModel(point, viewport);
  return { x: Math.floor(model.x), y: Math.floor(model.y) };
}

export const hitTestCell = screenToCellUnclamped;

export function viewportModelRect(viewport: Viewport, metrics: Pick<CanvasMetrics, 'cssWidth' | 'cssHeight'>): Rect {
  assertFiniteViewport(viewport);
  const zoom = viewport.zoom;
  return {
    x: finite(viewport.x, 0),
    y: finite(viewport.y, 0),
    width: Math.max(0, metrics.cssWidth) / zoom,
    height: Math.max(0, metrics.cssHeight) / zoom
  };
}

/**
 * Return only cells which can contribute a pixel to the viewport. The result
 * is half-open, so its right and bottom edges can be used as loop bounds.
 */
export function visibleCellRect(
  viewport: Viewport,
  metrics: Pick<CanvasMetrics, 'cssWidth' | 'cssHeight'>,
  documentSize: DocumentSize
): CellRect {
  const size = sizeOf(documentSize);
  if (size.width === 0 || size.height === 0 || metrics.cssWidth <= 0 || metrics.cssHeight <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const modelRect = viewportModelRect(viewport, metrics);
  const left = Math.min(size.width, Math.max(0, Math.floor(modelRect.x)));
  const top = Math.min(size.height, Math.max(0, Math.floor(modelRect.y)));
  const right = Math.max(left, Math.min(size.width, Math.ceil(modelRect.x + modelRect.width)));
  const bottom = Math.max(top, Math.min(size.height, Math.ceil(modelRect.y + modelRect.height)));
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top)
  };
}

export const getVisibleCellRect = visibleCellRect;

export interface ViewportClampOptions {
  readonly minZoom?: number;
  readonly maxZoom?: number;
}

export function clampViewport(
  viewport: Viewport,
  _documentSize?: DocumentSize,
  _metrics?: Pick<CanvasMetrics, 'cssWidth' | 'cssHeight'>,
  options: ViewportClampOptions = {}
): Viewport {
  const zoom = Math.min(
    positive(options.maxZoom ?? Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY),
    Math.max(positive(options.minZoom ?? 0.01, 0.01), positive(viewport.zoom, 1))
  );
  return {
    // Panning is intentionally unbounded. The controller/UI store owns this
    // state; a renderer must not silently move the user's viewport back onto
    // the chart while rendering or resizing.
    x: finite(viewport.x, 0),
    y: finite(viewport.y, 0),
    zoom
  };
}

/** Normalize viewport values without imposing chart bounds. */
export const normalizeViewport = clampViewport;

/** Keep the model point under `anchor` fixed while changing zoom. */
export function zoomAt(
  viewport: Viewport,
  anchor: ScreenPoint,
  nextZoom: number,
  options: ViewportClampOptions = {}
): Viewport {
  assertFiniteViewport(viewport);
  assertFinitePoint(anchor, 'Screen');
  const oldZoom = viewport.zoom;
  const modelAtAnchor = {
    x: viewport.x + anchor.x / oldZoom,
    y: viewport.y + anchor.y / oldZoom
  };
  const zoom = Math.min(
    positive(options.maxZoom ?? Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY),
    Math.max(positive(options.minZoom ?? 0.01, 0.01), positive(nextZoom, oldZoom))
  );
  return {
    x: modelAtAnchor.x - anchor.x / zoom,
    y: modelAtAnchor.y - anchor.y / zoom,
    zoom
  };
}

export const zoomAtCursor = zoomAt;

export function zoomBy(
  viewport: Viewport,
  anchor: ScreenPoint,
  factor: number,
  options: ViewportClampOptions = {}
): Viewport {
  return zoomAt(viewport, anchor, viewport.zoom * factor, options);
}

export function fitViewport(
  documentSize: DocumentSize,
  metrics: Pick<CanvasMetrics, 'cssWidth' | 'cssHeight'>,
  padding = 0,
  options: ViewportClampOptions = {}
): Viewport {
  const size = sizeOf(documentSize);
  const width = Math.max(1, metrics.cssWidth - padding * 2);
  const height = Math.max(1, metrics.cssHeight - padding * 2);
  const fittedZoom = Math.min(width / Math.max(1, size.width), height / Math.max(1, size.height));
  const zoom = Math.min(
    positive(options.maxZoom ?? Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY),
    Math.max(positive(options.minZoom ?? 0.01, 0.01), fittedZoom)
  );
  const fitted = {
    x: (size.width - width / zoom) / 2 - padding / zoom,
    y: (size.height - height / zoom) / 2 - padding / zoom,
    zoom
  };
  return clampViewport(fitted, size, metrics, options);
}

/**
 * Calculate a backing store while capping both device pixel ratio and total
 * pixels. The returned dpr is the actual CSS-to-backing scale.
 */
export function getCanvasMetrics(
  cssWidth: number,
  cssHeight: number,
  options?: DprOptions
): CanvasMetrics;
export function getCanvasMetrics(
  cssWidth: number,
  cssHeight: number,
  dpr?: number,
  options?: DprOptions
): CanvasMetrics;
export function getCanvasMetrics(
  size: { width: number; height: number },
  options?: DprOptions
): CanvasMetrics;
export function getCanvasMetrics(
  cssWidthOrSize: number | { width: number; height: number },
  cssHeightOrOptions: number | DprOptions = 0,
  dprOrOptions: number | DprOptions = 0,
  suppliedOptions: DprOptions = {}
): CanvasMetrics {
  const objectSize = typeof cssWidthOrSize === 'object';
  const cssWidth = objectSize ? cssWidthOrSize.width : cssWidthOrSize;
  const cssHeight = objectSize
    ? 0
    : typeof cssHeightOrOptions === 'number' ? cssHeightOrOptions : 0;
  const options = typeof dprOrOptions === 'object'
    ? dprOrOptions
    : typeof cssHeightOrOptions === 'object' ? cssHeightOrOptions : suppliedOptions;
  const requestedDprValue = typeof dprOrOptions === 'number' && dprOrOptions > 0
    ? dprOrOptions
    : options.dpr ?? options.devicePixelRatio;
  const width = Math.max(0, finite(cssWidth, 0));
  const height = Math.max(0, finite(objectSize ? cssWidthOrSize.height : cssHeight, 0));
  const requestedDpr = positive(requestedDprValue ?? 1, 1);
  const maxDpr = positive(options.maxDpr ?? options.maxDevicePixelRatio ?? DEFAULT_MAX_DPR, DEFAULT_MAX_DPR);
  const maxBackingPixels = Math.max(1, Math.floor(positive(options.maxBackingPixels ?? options.maxPixels ?? options.pixelBudget ?? DEFAULT_MAX_BACKING_PIXELS, DEFAULT_MAX_BACKING_PIXELS)));
  let dpr = Math.min(requestedDpr, maxDpr);
  if (width > 0 && height > 0) dpr = Math.min(dpr, Math.sqrt(maxBackingPixels / (width * height)));
  if (!Number.isFinite(dpr) || dpr <= 0) dpr = 1;
  let pixelWidth = Math.max(1, Math.round(width * dpr));
  let pixelHeight = Math.max(1, Math.round(height * dpr));
  if (pixelWidth * pixelHeight > maxBackingPixels) {
    const scale = Math.sqrt(maxBackingPixels / (pixelWidth * pixelHeight));
    dpr *= scale;
    pixelWidth = Math.max(1, Math.floor(width * dpr));
    pixelHeight = Math.max(1, Math.floor(height * dpr));
  }
  let safety = 0;
  while (pixelWidth * pixelHeight > maxBackingPixels && safety < 32) {
    dpr *= 0.5;
    pixelWidth = Math.max(1, Math.floor(width * dpr));
    pixelHeight = Math.max(1, Math.floor(height * dpr));
    safety += 1;
  }
  return {
    cssWidth: width,
    cssHeight: height,
    pixelWidth,
    pixelHeight,
    backingWidth: pixelWidth,
    backingHeight: pixelHeight,
    requestedDpr,
    dpr,
    maxDpr,
    maxBackingPixels
  };
}

export const calculateCanvasMetrics = getCanvasMetrics;
export const canvasMetrics = getCanvasMetrics;
