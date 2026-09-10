import {
  CellKind,
  type PatternDocument
} from '../domain';
import {
  ChartPresentationMode,
  DEFAULT_LOD_THRESHOLDS,
  DEFAULT_RENDERER_STYLE,
  RenderLod,
  type CanvasContextAdapter,
  type CanvasMetrics,
  type CanvasRenderer,
  type CanvasRendererOptions,
  type CellRect,
  type CoalescedInvalidation,
  type FixedPoint,
  type Invalidation,
  type InvalidationLayer,
  type LodThresholds,
  type ModelPoint,
  type OverlayState,
  type PendingCellState,
  type RenderStats,
  type RendererStyle,
  type Rect,
  type ScreenPoint,
  type TraceImage,
  type Viewport
} from '../editor/contracts';
import {
  cellToScreenRect,
  fixedToModel,
  fitViewport,
  modelToScreen,
  viewportModelRect,
  visibleCellRect
} from '../editor/coordinates';
import { getRenderLod, resolveLodThresholds } from '../editor/viewport';
import {
  ColorAtlasCache,
  SymbolAtlasCache,
  isCanvasImageSource,
  overviewColorForPaletteId
} from './atlas';
import { clearTarget, defaultAtlasTargetFactory, drawImage, prepareTarget, restore, save } from './context';
import { grayscaleColor } from './symbols';
import { drawPaletteSymbol, drawStitchGeometry } from './symbol-painter';
import { createTraceImageProjection, drawTraceImage } from './trace';
import { isLegacyQuarterKind, isThreeQuarterPairKind, threeQuarterPairComponents } from '../editor/cell-kinds';

const EMPTY_STATS: RenderStats = {
  lod: RenderLod.Overview,
  visitedCells: 0,
  drawnCells: 0,
  drawnBackstitches: 0,
  baseRendered: false,
  overlayRendered: false
};

function mergeStyle(style: Partial<RendererStyle> | undefined): RendererStyle {
  return { ...DEFAULT_RENDERER_STYLE, ...style };
}

function unionRect(left: Rect | undefined, right: Rect | undefined): Rect | undefined {
  if (!left) return right;
  if (!right) return left;
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const rightEdge = Math.max(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: rightEdge - x, height: bottomEdge - y };
}

/** Coalesce invalidations before a frame is requested. */
export function coalesceInvalidations(invalidations: readonly Invalidation[]): CoalescedInvalidation {
  let base = false;
  let overlay = false;
  let rect: Rect | undefined;
  let cellRect: CellRect | undefined;
  const dirtyRects: Rect[] = [];
  const dirtyCellRects: CellRect[] = [];
  const reasons: string[] = [];
  for (const invalidation of invalidations) {
    if (invalidation.layer === 'base' || invalidation.layer === 'all') base = true;
    if (invalidation.layer === 'overlay' || invalidation.layer === 'all') overlay = true;
    if (invalidation.rect) {
      rect = unionRect(rect, invalidation.rect);
      dirtyRects.push(invalidation.rect);
    }
    if (invalidation.cellRect) {
      cellRect = unionRect(cellRect, invalidation.cellRect);
      dirtyCellRects.push(invalidation.cellRect);
    }
    if (invalidation.reason && !reasons.includes(invalidation.reason)) reasons.push(invalidation.reason);
  }
  return {
    base,
    overlay,
    ...(rect ? { rect } : {}),
    ...(cellRect ? { cellRect } : {}),
    ...(dirtyRects.length ? { dirtyRects } : {}),
    ...(dirtyCellRects.length ? { dirtyCellRects } : {}),
    reasons
  };
}

export const coalesceInvalidation = coalesceInvalidations;
export const mergeInvalidations = coalesceInvalidations;

function defaultFrameRequest(callback: (time: number) => void): number {
  if (typeof globalThis.requestAnimationFrame === 'function') return globalThis.requestAnimationFrame(callback);
  return setTimeout(() => callback(Date.now()), 0) as unknown as number;
}

function defaultFrameCancel(handle: number): void {
  if (typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(handle);
  else clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
}

function paletteColor(document: PatternDocument, id: number, missing: string): string {
  if (id === 0) return missing;
  return document.palette.find((entry) => entry.id === id)?.color ?? missing;
}

function styleColor(document: PatternDocument, id: number, style: RendererStyle): string {
  const color = paletteColor(document, id, style.missingPaletteColor);
  return style.mode === ChartPresentationMode.Grayscale ? grayscaleColor(color) : color;
}

function linePath(context: CanvasContextAdapter, from: ScreenPoint, to: ScreenPoint): void {
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x, to.y);
  context.stroke();
}

function setAlpha(context: CanvasContextAdapter, alpha: number): void {
  context.globalAlpha = Math.max(0, Math.min(1, alpha));
}

function completedMark(
  context: CanvasContextAdapter,
  rect: Rect,
  style: RendererStyle,
  dimAlpha = 1
): void {
  save(context);
  context.strokeStyle = style.completedColor;
  context.lineWidth = style.completedMarkWidth;
  setAlpha(context, 0.8 * dimAlpha);
  linePath(
    context,
    { x: rect.x + rect.width * 0.2, y: rect.y + rect.height * 0.5 },
    { x: rect.x + rect.width * 0.8, y: rect.y + rect.height * 0.5 }
  );
  restore(context);
}

function drawSymbol(
  context: CanvasContextAdapter,
  document: PatternDocument,
  id: number,
  rect: Rect,
  style: RendererStyle,
  slot?: number
): void {
  drawPaletteSymbol(context, document, id, rect, style, slot);
}

function drawCellState(
  context: CanvasContextAdapter,
  document: PatternDocument,
  x: number,
  y: number,
  kind: number,
  colors: ArrayLike<number>,
  completed: number,
  style: RendererStyle,
  viewport: Viewport,
  lod: RenderLod,
  dimAlpha = 1
): boolean {
  if (kind === CellKind.Empty) return false;
  const rect = cellToScreenRect({ x, y, width: 1, height: 1 }, viewport);
  const symbolMode = style.mode === ChartPresentationMode.Symbol;
  const fill = (id: number, completed: boolean, slot?: number, geometryKind = kind): void => {
    save(context);
    context.fillStyle = symbolMode ? style.symbolBackgroundColor : styleColor(document, id, style);
    setAlpha(context, (completed ? style.completedOpacity : 1) * dimAlpha);
    if (geometryKind === CellKind.Full) context.fillRect(rect.x, rect.y, rect.width, rect.height);
    else drawStitchGeometry(context, geometryKind, rect, slot);
    restore(context);
    if (lod === RenderLod.Detail || symbolMode) drawSymbol(context, document, id, rect, style, slot);
    if (completed && lod === RenderLod.Detail) {
      const completionRect = slot === undefined ? rect : {
        x: rect.x + (slot === 1 || slot === 2 ? rect.width / 2 : 0),
        y: rect.y + (slot === 2 || slot === 3 ? rect.height / 2 : 0),
        width: rect.width / 2,
        height: rect.height / 2
      };
      completedMark(context, completionRect, style, dimAlpha);
    }
  };

  if (isLegacyQuarterKind(kind)) {
    for (let slot = 0; slot < 4; slot += 1) {
      const id = colors[slot] ?? 0;
      if (id !== 0) fill(id, (completed & (1 << slot)) !== 0, slot);
    }
  } else if (isThreeQuarterPairKind(kind)) {
    for (const component of threeQuarterPairComponents(colors)) {
      const id = colors[component.slot] ?? 0;
      if (id !== 0) fill(id, (completed & (1 << component.slot)) !== 0, component.slot, component.kind);
    }
  } else {
    fill(colors[0] ?? 0, (completed & 1) !== 0);
  }
  return true;
}

function drawCell(
  context: CanvasContextAdapter,
  document: PatternDocument,
  x: number,
  y: number,
  style: RendererStyle,
  viewport: Viewport,
  lod: RenderLod,
  dimAlpha = 1
): boolean {
  const index = y * document.width + x;
  return drawCellState(
    context,
    document,
    x,
    y,
    document.kind[index],
    document.colors.subarray(index * 4, index * 4 + 4),
    document.completed[index],
    style,
    viewport,
    lod,
    dimAlpha
  );
}

function gridLine(
  context: CanvasContextAdapter,
  from: ScreenPoint,
  to: ScreenPoint,
  color: string,
  width: number
): void {
  context.strokeStyle = color;
  context.lineWidth = width;
  linePath(context, from, to);
}

function intersectRects(left: Rect, right: Rect): Rect | undefined {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const rightEdge = Math.min(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.min(left.y + left.height, right.y + right.height);
  if (rightEdge <= x || bottomEdge <= y) return undefined;
  return { x, y, width: rightEdge - x, height: bottomEdge - y };
}

function patternCanvasRect(
  document: PatternDocument,
  viewport: Viewport,
  metrics: CanvasMetrics
): Rect | undefined {
  return intersectRects(
    cellToScreenRect({ x: 0, y: 0, width: document.width, height: document.height }, viewport),
    { x: 0, y: 0, width: metrics.cssWidth, height: metrics.cssHeight }
  );
}

const GRID_SHOW_AT_FIT_RATIO = 1.2;

function minorGridWidth(lod: RenderLod): number {
  return lod === RenderLod.Detail ? 0.35 : 0.65;
}

function midGridWidth(lod: RenderLod): number {
  return lod === RenderLod.Detail ? 1 : 1.5;
}

function majorGridWidth(lod: RenderLod): number {
  return lod === RenderLod.Detail ? 2.5 : 2.25;
}

function shouldDrawGrid(
  document: PatternDocument,
  viewport: Viewport,
  metrics: CanvasMetrics,
  style: RendererStyle
): boolean {
  if (!style.showGrid) return false;
  const currentZoom = viewport.zoom > 0 && Number.isFinite(viewport.zoom) ? viewport.zoom : 1;
  const fitZoom = fitViewport(document, metrics, 0).zoom;
  return currentZoom >= fitZoom * GRID_SHOW_AT_FIT_RATIO;
}

function drawGrid(
  context: CanvasContextAdapter,
  document: PatternDocument,
  viewport: Viewport,
  metrics: CanvasMetrics,
  style: RendererStyle,
  visible: CellRect,
  lod: RenderLod
): void {
  if (!shouldDrawGrid(document, viewport, metrics, style) || visible.width === 0 || visible.height === 0) return;
  const bounds = patternCanvasRect(document, viewport, metrics);
  if (!bounds) return;
  const configuredInterval = Number.isFinite(style.gridInterval) ? Math.max(1, Math.floor(style.gridInterval)) : 1;
  const zoom = viewport.zoom > 0 && Number.isFinite(viewport.zoom) ? viewport.zoom : 1;
  // At overview/minimum zoom, drawing every cell line either makes the grid
  // disappear into sub-pixel strokes or makes work proportional to the chart
  // size. Select a stable cell step that keeps lines legible and only visit
  // coordinates which can produce pixels in this viewport.
  const minimumCellStep = Math.max(1, Math.ceil(8 / zoom));
  const interval = lod === RenderLod.Overview
    ? adaptiveGridStep(minimumCellStep, 1)
    : lod === RenderLod.Detail
      ? 1
      : Math.max(configuredInterval, minimumCellStep);
  const viewportRect = viewportModelRect(viewport, metrics);
  const left = Math.max(0, visible.x, Math.floor(viewportRect.x));
  const right = Math.min(document.width, visible.x + visible.width, Math.ceil(viewportRect.x + viewportRect.width));
  const top = Math.max(0, visible.y, Math.floor(viewportRect.y));
  const bottom = Math.min(document.height, visible.y + visible.height, Math.ceil(viewportRect.y + viewportRect.height));
  if (right < left || bottom < top) return;
  const clipped = clipToRect(context, bounds);
  try {
    const firstX = Math.ceil(left / interval) * interval;
    const lastX = Math.floor(right / interval) * interval;
    for (let x = firstX; x <= lastX; x += interval) {
      const screenX = modelToScreen({ x, y: 0 }, viewport).x;
      if (screenX < bounds.x || screenX > bounds.x + bounds.width) continue;
      // Compact LOD keeps the configured hierarchy (the 5-cell tier is
      // drawn separately), but drops the per-cell lines. Overview is the
      // exception: its adaptive step is itself the visible grid.
      const major = lod === RenderLod.Overview || x % configuredInterval === 0;
      if (lod === RenderLod.Compact && !major) continue;
      const segment = clipSegmentToRect(
        modelToScreen({ x, y: top }, viewport),
        modelToScreen({ x, y: bottom }, viewport),
        bounds
      );
      if (segment) gridLine(context, segment.start, segment.end, major ? style.majorGridColor : style.gridColor, major ? majorGridWidth(lod) : minorGridWidth(lod));
    }
    const firstY = Math.ceil(top / interval) * interval;
    const lastY = Math.floor(bottom / interval) * interval;
    for (let y = firstY; y <= lastY; y += interval) {
      const screenY = modelToScreen({ x: 0, y }, viewport).y;
      if (screenY < bounds.y || screenY > bounds.y + bounds.height) continue;
      const major = lod === RenderLod.Overview || y % configuredInterval === 0;
      if (lod === RenderLod.Compact && !major) continue;
      const segment = clipSegmentToRect(
        modelToScreen({ x: left, y }, viewport),
        modelToScreen({ x: right, y }, viewport),
        bounds
      );
      if (segment) gridLine(context, segment.start, segment.end, major ? style.majorGridColor : style.gridColor, major ? majorGridWidth(lod) : minorGridWidth(lod));
    }
  } finally {
    if (clipped) restore(context);
  }
}

/** Draw the 5-cell highlight tier between the per-stitch grid and the 10-cell grid. */
function drawMidGrid(
  context: CanvasContextAdapter,
  document: PatternDocument,
  viewport: Viewport,
  metrics: CanvasMetrics,
  style: RendererStyle,
  visible: CellRect,
  lod: RenderLod
): void {
  if (!shouldDrawGrid(document, viewport, metrics, style) || lod === RenderLod.Overview || visible.width === 0 || visible.height === 0) return;
  const bounds = patternCanvasRect(document, viewport, metrics);
  if (!bounds) return;
  const interval = Number.isFinite(style.midGridInterval) ? Math.max(1, Math.floor(style.midGridInterval)) : 5;
  if (interval === 1) return; // Degenerate: identical to the per-stitch grid.
  const viewportRect = viewportModelRect(viewport, metrics);
  const left = Math.max(0, visible.x, Math.floor(viewportRect.x));
  const right = Math.min(document.width, visible.x + visible.width, Math.ceil(viewportRect.x + viewportRect.width));
  const top = Math.max(0, visible.y, Math.floor(viewportRect.y));
  const bottom = Math.min(document.height, visible.y + visible.height, Math.ceil(viewportRect.y + viewportRect.height));
  if (right < left || bottom < top) return;
  const clipped = clipToRect(context, bounds);
  try {
    const firstX = Math.ceil(left / interval) * interval;
    const lastX = Math.floor(right / interval) * interval;
    for (let x = firstX; x <= lastX; x += interval) {
      if (x === 0 || x === document.width) continue; // Skip document edges (the border owns them).
      const screenX = modelToScreen({ x, y: 0 }, viewport).x;
      if (screenX < bounds.x || screenX > bounds.x + bounds.width) continue;
      const segment = clipSegmentToRect(
        modelToScreen({ x, y: top }, viewport),
        modelToScreen({ x, y: bottom }, viewport),
        bounds
      );
      if (segment) gridLine(context, segment.start, segment.end, style.midGridColor, midGridWidth(lod));
    }
    const firstY = Math.ceil(top / interval) * interval;
    const lastY = Math.floor(bottom / interval) * interval;
    for (let y = firstY; y <= lastY; y += interval) {
      if (y === 0 || y === document.height) continue; // Skip document edges.
      const screenY = modelToScreen({ x: 0, y }, viewport).y;
      if (screenY < bounds.y || screenY > bounds.y + bounds.height) continue;
      const segment = clipSegmentToRect(
        modelToScreen({ x: left, y }, viewport),
        modelToScreen({ x: right, y }, viewport),
        bounds
      );
      if (segment) gridLine(context, segment.start, segment.end, style.midGridColor, midGridWidth(lod));
    }
  } finally {
    if (clipped) restore(context);
  }
}

function adaptiveGridStep(minimumCellStep: number, configuredInterval: number): number {
  if (configuredInterval >= minimumCellStep) return configuredInterval;
  let magnitude = 1;
  while (magnitude * 10 < minimumCellStep) magnitude *= 10;
  for (const multiple of [1, 2, 5, 10]) {
    const candidate = multiple * magnitude;
    if (candidate >= minimumCellStep) return candidate;
  }
  return magnitude * 10;
}

/** Draw only the visible portions of the document border. */
function drawChartBorder(
  context: CanvasContextAdapter,
  document: PatternDocument,
  viewport: Viewport,
  metrics: CanvasMetrics,
  style: RendererStyle
): void {
  const canvas = { x: 0, y: 0, width: metrics.cssWidth, height: metrics.cssHeight };
  save(context);
  context.strokeStyle = style.chartBorderColor;
  context.lineWidth = 1.5;
  const clipped = clipToRect(context, canvas);
  try {
    const sides: readonly [ModelPoint, ModelPoint][] = [
      [{ x: 0, y: 0 }, { x: document.width, y: 0 }],
      [{ x: document.width, y: 0 }, { x: document.width, y: document.height }],
      [{ x: document.width, y: document.height }, { x: 0, y: document.height }],
      [{ x: 0, y: document.height }, { x: 0, y: 0 }]
    ];
    for (const [start, end] of sides) {
      const segment = clipSegmentToRect(modelToScreen(start, viewport), modelToScreen(end, viewport), canvas);
      if (segment) linePath(context, segment.start, segment.end);
    }
  } finally {
    if (clipped) restore(context);
    restore(context);
  }
}

function drawGridForCells(
  context: CanvasContextAdapter,
  document: PatternDocument,
  viewport: Viewport,
  metrics: CanvasMetrics,
  style: RendererStyle,
  cells: readonly CellRect[],
  lod: RenderLod
): void {
  if (!shouldDrawGrid(document, viewport, metrics, style) || lod === RenderLod.Overview || cells.length === 0) return;
  const bounds = patternCanvasRect(document, viewport, metrics);
  if (!bounds) return;
  const interval = Math.max(1, Math.floor(style.gridInterval));
  const vertical = new Map<string, { x: number; y: number }>();
  const horizontal = new Map<string, { x: number; y: number }>();
  for (const cell of cells) {
    const left = Math.floor(cell.x);
    const top = Math.floor(cell.y);
    const right = left + Math.max(0, Math.floor(cell.width));
    const bottom = top + Math.max(0, Math.floor(cell.height));
    for (let y = top; y < bottom; y += 1) {
      for (const x of [left, right]) {
        const key = `${String(x)}:${String(y)}`;
        vertical.set(key, { x, y });
      }
    }
    for (let x = left; x < right; x += 1) {
      for (const y of [top, bottom]) {
        const key = `${String(x)}:${String(y)}`;
        horizontal.set(key, { x, y });
      }
    }
  }
  const clipped = clipToRect(context, bounds);
  try {
    for (const { x, y } of vertical.values()) {
      const major = x % interval === 0;
      if (lod === RenderLod.Compact && !major) continue;
      const segment = clipSegmentToRect(
        modelToScreen({ x, y }, viewport),
        modelToScreen({ x, y: y + 1 }, viewport),
        bounds
      );
      if (segment) gridLine(context, segment.start, segment.end, major ? style.majorGridColor : style.gridColor, major ? majorGridWidth(lod) : minorGridWidth(lod));
    }
    for (const { x, y } of horizontal.values()) {
      const major = y % interval === 0;
      if (lod === RenderLod.Compact && !major) continue;
      const segment = clipSegmentToRect(
        modelToScreen({ x, y }, viewport),
        modelToScreen({ x: x + 1, y }, viewport),
        bounds
      );
      if (segment) gridLine(context, segment.start, segment.end, major ? style.majorGridColor : style.gridColor, major ? majorGridWidth(lod) : minorGridWidth(lod));
    }
  } finally {
    if (clipped) restore(context);
  }
}

function segmentIntersectsRect(start: ModelPoint, end: ModelPoint, rect: Rect): boolean {
  const left = rect.x;
  const right = rect.x + rect.width;
  const top = rect.y;
  const bottom = rect.y + rect.height;
  const minX = Math.min(start.x, end.x);
  const maxX = Math.max(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const maxY = Math.max(start.y, end.y);
  if (maxX < left || minX > right || maxY < top || minY > bottom) return false;
  let entering = 0;
  let leaving = 1;
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const edges: readonly (readonly [number, number])[] = [
    [-deltaX, start.x - left],
    [deltaX, right - start.x],
    [-deltaY, start.y - top],
    [deltaY, bottom - start.y]
  ];
  for (const [coefficient, distance] of edges) {
    if (coefficient === 0) {
      if (distance < 0) return false;
      continue;
    }
    const time = distance / coefficient;
    if (coefficient < 0) entering = Math.max(entering, time);
    else leaving = Math.min(leaving, time);
    if (entering > leaving) return false;
  }
  return true;
}

function clipSegmentToRect(start: ModelPoint, end: ModelPoint, rect: Rect): { start: ModelPoint; end: ModelPoint } | undefined {
  let entering = 0;
  let leaving = 1;
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const edges: readonly (readonly [number, number])[] = [
    [-deltaX, start.x - rect.x],
    [deltaX, rect.x + rect.width - start.x],
    [-deltaY, start.y - rect.y],
    [deltaY, rect.y + rect.height - start.y]
  ];
  for (const [coefficient, distance] of edges) {
    if (coefficient === 0) {
      if (distance < 0) return undefined;
      continue;
    }
    const time = distance / coefficient;
    if (coefficient < 0) entering = Math.max(entering, time);
    else leaving = Math.min(leaving, time);
    if (entering > leaving) return undefined;
  }
  return {
    start: { x: start.x + deltaX * entering, y: start.y + deltaY * entering },
    end: { x: start.x + deltaX * leaving, y: start.y + deltaY * leaving }
  };
}

function drawBackstitches(
  context: CanvasContextAdapter,
  document: PatternDocument,
  viewport: Viewport,
  metrics: CanvasMetrics,
  style: RendererStyle,
  dirtyModelRect?: Rect,
  dimAlpha = 1
): number {
  const visible = viewportModelRect(viewport, metrics);
  const store = document.backstitches;
  let drawn = 0;
  for (let index = 0; index < store.ids.length; index += 1) {
    const start = fixedToModel({ x: store.x1[index], y: store.y1[index] });
    const end = fixedToModel({ x: store.x2[index], y: store.y2[index] });
    if (!segmentIntersectsRect(start, end, visible)) continue;
    if (dirtyModelRect && !segmentIntersectsRect(start, end, dirtyModelRect)) continue;
    drawBackstitchSegment(context, document, viewport, style, start, end, store.colors[index], store.completed[index] === 1, dimAlpha);
    drawn += 1;
  }
  return drawn;
}

function drawBackstitchSegment(
  context: CanvasContextAdapter,
  document: PatternDocument,
  viewport: Viewport,
  style: RendererStyle,
  start: ModelPoint,
  end: ModelPoint,
  colorId: number,
  completed: boolean,
  dimAlpha = 1
): void {
  drawBackstitchScreenSegment(
    context,
    document,
    viewport,
    style,
    modelToScreen(start, viewport),
    modelToScreen(end, viewport),
    colorId,
    completed,
    dimAlpha
  );
}

function drawBackstitchScreenSegment(
  context: CanvasContextAdapter,
  document: PatternDocument,
  viewport: Viewport,
  style: RendererStyle,
  start: ScreenPoint,
  end: ScreenPoint,
  colorId: number,
  completed: boolean,
  dimAlpha = 1
): void {
  save(context);
  context.strokeStyle = styleColor(document, colorId, style);
  context.lineWidth = Math.max(1, Math.min(3, viewport.zoom * 0.1));
  setAlpha(context, (completed ? style.completedOpacity : 1) * dimAlpha);
  linePath(context, start, end);
  restore(context);
}

function drawBackstitchesForCells(
  context: CanvasContextAdapter,
  document: PatternDocument,
  viewport: Viewport,
  metrics: CanvasMetrics,
  style: RendererStyle,
  cells: readonly CellRect[],
  lod: RenderLod,
  bounds: Rect
): void {
  if (lod === RenderLod.Overview || cells.length === 0) return;
  const visible = viewportModelRect(viewport, metrics);
  const store = document.backstitches;
  for (let index = 0; index < store.ids.length; index += 1) {
    const start = fixedToModel({ x: store.x1[index], y: store.y1[index] });
    const end = fixedToModel({ x: store.x2[index], y: store.y2[index] });
    if (!segmentIntersectsRect(start, end, visible)) continue;
    for (const cell of cells) {
      const cellSegment = clipSegmentToRect(start, end, cell);
      if (!cellSegment) continue;
      const cellBounds = intersectRects(cellToScreenRect(cell, viewport), bounds);
      if (!cellBounds) continue;
      const screenSegment = clipSegmentToRect(
        modelToScreen(cellSegment.start, viewport),
        modelToScreen(cellSegment.end, viewport),
        bounds
      );
      if (!screenSegment) continue;
      const clipped = clipToRect(context, cellBounds);
      drawBackstitchScreenSegment(context, document, viewport, style, screenSegment.start, screenSegment.end, store.colors[index], store.completed[index] === 1);
      if (clipped) restore(context);
    }
  }
}

function intersectCellRects(left: CellRect, right: CellRect): CellRect {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const rightEdge = Math.min(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.min(left.y + left.height, right.y + right.height);
  return { x, y, width: Math.max(0, rightEdge - x), height: Math.max(0, bottomEdge - y) };
}

function screenRectToCellRect(rect: Rect, viewport: Viewport): CellRect {
  const zoom = viewport.zoom > 0 ? viewport.zoom : 1;
  const x = Math.floor(viewport.x + rect.x / zoom);
  const y = Math.floor(viewport.y + rect.y / zoom);
  const right = Math.ceil(viewport.x + (rect.x + rect.width) / zoom);
  const bottom = Math.ceil(viewport.y + (rect.y + rect.height) / zoom);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
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

function drawOverviewFallback(
  context: CanvasContextAdapter,
  document: PatternDocument,
  viewport: Viewport,
  metrics: CanvasMetrics,
  style: RendererStyle
): { visitedCells: number; drawnCells: number } {
  const visible = visibleCellRect(viewport, metrics, document);
  let drawnCells = 0;
  for (let y = visible.y; y < visible.y + visible.height; y += 1) {
    for (let x = visible.x; x < visible.x + visible.width; x += 1) {
      const index = y * document.width + x;
      if (document.kind[index] === CellKind.Empty) continue;
      const offset = index * 4;
      const rect = cellToScreenRect({ x, y, width: 1, height: 1 }, viewport);
      if (isLegacyQuarterKind(document.kind[index])) {
        const halfWidth = rect.width / 2;
        const halfHeight = rect.height / 2;
        for (let slot = 0; slot < 4; slot += 1) {
          const id = document.colors[offset + slot];
          if (id === 0) continue;
          context.fillStyle = overviewColorForPaletteId(document, id, style);
          context.fillRect(
            rect.x + (slot === 1 || slot === 2 ? halfWidth : 0),
            rect.y + (slot === 2 || slot === 3 ? halfHeight : 0),
            halfWidth,
            halfHeight
          );
        }
      } else if (isThreeQuarterPairKind(document.kind[index])) {
        for (const component of threeQuarterPairComponents(document.colors.subarray(offset, offset + 4))) {
          const id = document.colors[offset + component.slot];
          if (id === 0) continue;
          context.fillStyle = overviewColorForPaletteId(document, id, style);
          drawStitchGeometry(context, component.kind, rect);
        }
      } else {
        context.fillStyle = overviewColorForPaletteId(document, document.colors[offset], style);
        if (document.kind[index] === CellKind.Full) context.fillRect(rect.x, rect.y, rect.width, rect.height);
        else drawStitchGeometry(context, document.kind[index], rect);
      }
      drawnCells += 1;
    }
  }
  return { visitedCells: visible.width * visible.height, drawnCells };
}

function drawOverviewSymbolFallback(
  context: CanvasContextAdapter,
  document: PatternDocument,
  viewport: Viewport,
  metrics: CanvasMetrics,
  style: RendererStyle
): { visitedCells: number; drawnCells: number } {
  const visible = visibleCellRect(viewport, metrics, document);
  let drawnCells = 0;
  for (let y = visible.y; y < visible.y + visible.height; y += 1) {
    for (let x = visible.x; x < visible.x + visible.width; x += 1) {
      if (drawCell(context, document, x, y, style, viewport, RenderLod.Overview)) drawnCells += 1;
    }
  }
  return { visitedCells: visible.width * visible.height, drawnCells };
}

function overlayRect(value: OverlayState['selection']): CellRect | undefined {
  if (!value) return undefined;
  if ('rect' in value) return value.rect;
  return value;
}

function overlayPoint(value: OverlayState['cursor']): ModelPoint | undefined {
  if (!value) return undefined;
  if ('cell' in value) return value.cell;
  return value;
}

function drawPendingCells(
  context: CanvasContextAdapter,
  document: PatternDocument,
  pendingCells: readonly ModelPoint[] | undefined,
  viewport: Viewport,
  style: RendererStyle,
  bounds: Rect
): void {
  if (!pendingCells || pendingCells.length === 0) return;
  save(context);
  context.fillStyle = style.pendingCellColor;
  setAlpha(context, style.pendingCellOpacity);
  for (const cell of pendingCells) {
    if (cell.x < 0 || cell.y < 0 || cell.x >= document.width || cell.y >= document.height) continue;
    const rect = cellToScreenRect({ x: Math.floor(cell.x), y: Math.floor(cell.y), width: 1, height: 1 }, viewport);
    const clipped = intersectRects(rect, bounds);
    if (clipped) context.fillRect(clipped.x, clipped.y, clipped.width, clipped.height);
  }
  restore(context);
}

function drawPendingCellState(
  context: CanvasContextAdapter,
  document: PatternDocument,
  state: PendingCellState,
  viewport: Viewport,
  style: RendererStyle,
  lod: RenderLod,
  bounds: Rect
): CellRect | undefined {
  const x = Math.floor(state.cell.x);
  const y = Math.floor(state.cell.y);
  if (x < 0 || y < 0 || x >= document.width || y >= document.height || state.index !== y * document.width + x) return undefined;
  const cellRect = cellToScreenRect({ x, y, width: 1, height: 1 }, viewport);
  const clippedCellRect = intersectRects(cellRect, bounds);
  if (!clippedCellRect) return undefined;

  // The overlay sits above the committed layer. Mask the old cell first so an
  // erase or a legacy-quarter edit presents the exact sparse after-state.
  save(context);
  context.fillStyle = style.backgroundColor;
  setAlpha(context, 1);
  context.fillRect(clippedCellRect.x, clippedCellRect.y, clippedCellRect.width, clippedCellRect.height);
  restore(context);
  drawCellState(context, document, x, y, state.kind, state.colors, state.completed, style, viewport, lod);
  return { x, y, width: 1, height: 1 };
}

function drawPendingCellStates(
  context: CanvasContextAdapter,
  document: PatternDocument,
  states: readonly PendingCellState[] | undefined,
  viewport: Viewport,
  style: RendererStyle,
  lod: RenderLod,
  bounds: Rect
): CellRect[] {
  if (!states || states.length === 0) return [];
  const cells: CellRect[] = [];
  for (const state of states) {
    const cell = drawPendingCellState(context, document, state, viewport, style, lod, bounds);
    if (cell) cells.push(cell);
  }
  return cells;
}

function drawBackstitchPreview(
  context: CanvasContextAdapter,
  document: PatternDocument,
  preview: OverlayState['backstitchPreview'],
  viewport: Viewport,
  style: RendererStyle,
  bounds: Rect
): void {
  if (!preview) return;
  const modelSegment = clipSegmentToRect(
    fixedToModel(preview.start as FixedPoint),
    fixedToModel(preview.end as FixedPoint),
    { x: 0, y: 0, width: document.width, height: document.height }
  );
  if (!modelSegment) return;
  const screenSegment = clipSegmentToRect(
    modelToScreen(modelSegment.start, viewport),
    modelToScreen(modelSegment.end, viewport),
    bounds
  );
  if (!screenSegment) return;
  save(context);
  context.strokeStyle = preview.color ?? style.selectionColor;
  context.lineWidth = Math.max(style.overlayLineWidth, Math.min(4, viewport.zoom * 0.12));
  context.setLineDash?.([6, 4]);
  linePath(context, screenSegment.start, screenSegment.end);
  restore(context);
}

function drawOverlay(
  context: CanvasContextAdapter,
  document: PatternDocument,
  overlay: OverlayState,
  viewport: Viewport,
  metrics: CanvasMetrics,
  style: RendererStyle,
  lod: RenderLod,
  dirtyRect?: Rect
): void {
  const bounds = patternCanvasRect(document, viewport, metrics);
  const clippedDirtyRect = dirtyRect && bounds ? intersectRects(dirtyRect, bounds) : undefined;
  if (dirtyRect && !clippedDirtyRect) return;
  const partial = clippedDirtyRect !== undefined && clipToRect(context, clippedDirtyRect);
  if (partial) context.clearRect(clippedDirtyRect.x, clippedDirtyRect.y, clippedDirtyRect.width, clippedDirtyRect.height);
  else clearTarget({ context, width: metrics.pixelWidth, height: metrics.pixelHeight }, metrics);
  if (!bounds) {
    if (partial) restore(context);
    return;
  }
  const patternClip = clipToRect(context, bounds);
  save(context);
  context.lineWidth = style.overlayLineWidth;
  let pendingStateCells: CellRect[] = [];
  if (overlay.pendingCellStates !== undefined) {
    pendingStateCells = drawPendingCellStates(context, document, overlay.pendingCellStates, viewport, style, lod, bounds);
  } else {
    drawPendingCells(context, document, overlay.pendingCells, viewport, style, bounds);
  }
  drawGridForCells(context, document, viewport, metrics, style, pendingStateCells, lod);
  drawBackstitchesForCells(context, document, viewport, metrics, style, pendingStateCells, lod, bounds);
  drawBackstitchPreview(context, document, overlay.backstitchPreview, viewport, style, bounds);
  const selection = overlayRect(overlay.selection);
  if (selection && overlay.showSelection !== false) {
    context.strokeStyle = overlay.color ?? style.selectionColor;
    const boundedSelection = intersectCellRects(selection, { x: 0, y: 0, width: document.width, height: document.height });
    const rect = boundedSelection.width > 0 && boundedSelection.height > 0
      ? intersectRects(cellToScreenRect(boundedSelection, viewport), bounds)
      : undefined;
    if (rect && context.strokeRect) context.strokeRect(rect.x, rect.y, rect.width, rect.height);
    else if (rect) {
      context.beginPath();
      context.moveTo(rect.x, rect.y);
      context.lineTo(rect.x + rect.width, rect.y);
      context.lineTo(rect.x + rect.width, rect.y + rect.height);
      context.lineTo(rect.x, rect.y + rect.height);
      context.closePath?.();
      context.stroke();
    }
  }
  const cursor = overlayPoint(overlay.cursor);
  if (cursor && overlay.showCursor !== false) {
    const cursorCell = { x: Math.floor(cursor.x), y: Math.floor(cursor.y) };
    if (cursorCell.x >= 0 && cursorCell.y >= 0 && cursorCell.x < document.width && cursorCell.y < document.height) {
      context.strokeStyle = overlay.color ?? style.cursorColor;
      const rect = intersectRects(cellToScreenRect({ x: cursorCell.x, y: cursorCell.y, width: 1, height: 1 }, viewport), bounds);
      if (rect) {
        if (context.strokeRect) context.strokeRect(rect.x, rect.y, rect.width, rect.height);
        else {
          context.beginPath();
          context.moveTo(rect.x, rect.y);
          context.lineTo(rect.x + rect.width, rect.y);
          context.lineTo(rect.x + rect.width, rect.y + rect.height);
          context.lineTo(rect.x, rect.y + rect.height);
          context.closePath?.();
          context.stroke();
        }
      }
    }
  }
  restore(context);
  if (patternClip) restore(context);
  if (partial) restore(context);
}

function setterInvalidation(request: Invalidation, layer: 'base' | 'overlay'): Invalidation {
  // A setter owns its corresponding surface. A caller may still request an
  // atomic `all` invalidation, while a mismatched single-layer request is
  // normalized instead of silently leaving the changed surface stale.
  return request.layer === 'all' || request.layer === layer
    ? request
    : { ...request, layer };
}

export class Canvas2DRenderer implements CanvasRenderer {
  private document: PatternDocument;
  private viewport: Viewport;
  private metrics: CanvasMetrics;
  private style: RendererStyle;
  private traceImage: TraceImage | undefined;
  private traceDisposer: (() => void) | undefined;
  private traceDisposed = false;
  private patternDimmed = false;
  private overlay: OverlayState;
  private thresholds: LodThresholds;
  private readonly atlas = new ColorAtlasCache();
  private readonly symbolAtlas = new SymbolAtlasCache();
  private readonly atlasFactory: CanvasRendererOptions['atlasTargetFactory'];
  private readonly requestFrame: (callback: (time: number) => void) => number;
  private readonly cancelFrame: (handle: number) => void;
  private frameHandle: number | undefined;
  private frameScheduled = false;
  private pendingBase = true;
  private pendingOverlay = true;
  private pendingBaseFull = true;
  private pendingOverlayFull = true;
  private pendingInvalidations: Invalidation[] = [];
  private lastInvalidation: CoalescedInvalidation = { base: true, overlay: true, reasons: [] };
  private disposed = false;
  private stats: RenderStats = EMPTY_STATS;

  constructor(private readonly options: CanvasRendererOptions) {
    this.document = options.document;
    this.metrics = options.metrics;
    // Viewport state is projected into the renderer by the controller. Keep
    // it as supplied; rendering must never pan or zoom the chart implicitly.
    this.viewport = options.viewport ?? { x: 0, y: 0, zoom: 16 };
    this.style = mergeStyle(options.style);
    this.traceImage = options.traceImage ?? options.trace;
    this.traceDisposer = this.traceImage?.dispose;
    this.overlay = options.overlay ?? {};
    this.thresholds = resolveLodThresholds({ ...DEFAULT_LOD_THRESHOLDS, ...options.lodThresholds });
    this.atlasFactory = options.atlasTargetFactory ?? defaultAtlasTargetFactory;
    this.requestFrame = options.requestAnimationFrame ?? defaultFrameRequest;
    this.cancelFrame = options.cancelAnimationFrame ?? defaultFrameCancel;
  }

  get lastStats(): RenderStats {
    return this.stats;
  }

  getDocument(): PatternDocument {
    return this.document;
  }

  getViewport(): Viewport {
    return this.viewport;
  }

  getStyle(): RendererStyle {
    return this.style;
  }

  getTraceImage(): TraceImage | undefined {
    return this.traceImage;
  }

  getLastInvalidation(): CoalescedInvalidation {
    return this.lastInvalidation;
  }

  setDocument(document: PatternDocument, invalidation?: Invalidation): void {
    if (this.disposed) return;
    this.document = document;
    const request: Invalidation = invalidation ? setterInvalidation(invalidation, 'base') : { layer: 'all', full: true };
    this.invalidate(request);
  }

  setViewport(viewport: Viewport): void {
    if (this.disposed) return;
    this.viewport = viewport;
    this.invalidate('all');
  }

  setMetrics(metrics: CanvasMetrics): void {
    if (this.disposed) return;
    this.metrics = metrics;
    this.invalidate('all');
  }

  setStyle(style: Partial<RendererStyle>): void {
    if (this.disposed) return;
    this.style = mergeStyle({ ...this.style, ...style });
    this.invalidate('all');
  }

  setTraceImage(trace: TraceImage | undefined): void {
    if (this.disposed || this.traceImage === trace) return;
    const previous = this.traceImage;
    const sameSource = previous !== undefined && trace !== undefined && previous.source === trace.source;
    if (!sameSource) this.disposeTraceImage();
    this.traceImage = trace;
    this.traceDisposer = trace?.dispose ?? (sameSource ? this.traceDisposer : undefined);
    this.traceDisposed = false;
    this.invalidate('base');
  }

  setTraceImageSettings(settings: Pick<TraceImage, 'visible' | 'opacity'>): void {
    if (this.disposed || !this.traceImage) return;
    this.traceImage = { ...this.traceImage, ...settings };
    this.invalidate('base');
  }

  /** Dim the committed pattern layer (move-image mode) so the reference image reads on top. */
  setPatternDimmed(dimmed: boolean): void {
    if (this.disposed || this.patternDimmed === dimmed) return;
    this.patternDimmed = dimmed;
    this.invalidate('base');
  }

  clearTraceImage(): void {
    this.setTraceImage(undefined);
  }

  setOverlay(overlay: OverlayState, invalidation?: Invalidation): void {
    if (this.disposed) return;
    this.overlay = overlay;
    const request: Invalidation = invalidation ? setterInvalidation(invalidation, 'overlay') : { layer: 'overlay', full: true };
    this.invalidate(request);
  }

  invalidate(invalidation: Invalidation | InvalidationLayer = 'all'): void {
    if (this.disposed) return;
    const request: Invalidation = typeof invalidation === 'string'
      ? { layer: invalidation, full: true }
      : invalidation;
    this.pendingInvalidations.push(request);
    this.lastInvalidation = coalesceInvalidations(this.pendingInvalidations);
    const layer = request.layer;
    const bounded = Boolean((request.rect || request.cellRect) && request.full !== true);
    if (layer === 'base' || layer === 'all') this.pendingBase = true;
    if (layer === 'overlay' || layer === 'all') this.pendingOverlay = true;
    if (layer === 'base' || layer === 'all') this.pendingBaseFull = this.pendingBaseFull || !bounded;
    if (layer === 'overlay' || layer === 'all') this.pendingOverlayFull = this.pendingOverlayFull || !bounded;
    if (!this.frameScheduled) {
      this.frameScheduled = true;
      this.frameHandle = this.requestFrame(() => {
        this.frameScheduled = false;
        this.frameHandle = undefined;
        if (!this.disposed) this.renderNow();
      });
    }
  }

  requestRender(): void {
    this.invalidate('all');
  }

  render(): RenderStats {
    return this.renderNow();
  }

  renderNow(): RenderStats {
    if (this.disposed) return this.stats;
    const base = this.pendingBase;
    const overlay = this.pendingOverlay;
    const baseFull = this.pendingBaseFull;
    const overlayFull = this.pendingOverlayFull;
    const invalidation = this.lastInvalidation;
    this.pendingBase = false;
    this.pendingOverlay = false;
    this.pendingBaseFull = false;
    this.pendingOverlayFull = false;
    this.pendingInvalidations = [];
    if (!base && !overlay) return this.stats;
    const lod = getRenderLod(this.viewport.zoom, this.thresholds);
    let visitedCells = 0;
    let drawnCells = 0;
    let drawnBackstitches = 0;
    if (base) {
      const result = this.renderBase(lod, invalidation, baseFull);
      visitedCells = result.visitedCells;
      drawnCells = result.drawnCells;
      drawnBackstitches = result.drawnBackstitches;
    }
    if (overlay) this.renderOverlay(overlayFull, invalidation, lod);
    this.stats = {
      lod,
      visitedCells,
      drawnCells,
      drawnBackstitches,
      baseRendered: base,
      overlayRendered: overlay
    };
    return this.stats;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frameScheduled && this.frameHandle !== undefined) this.cancelFrame(this.frameHandle);
    this.frameHandle = undefined;
    this.frameScheduled = false;
    this.disposeTraceImage();
    this.traceImage = undefined;
    this.atlas.clear();
    this.symbolAtlas.clear();
  }

  private disposeTraceImage(): void {
    if (this.traceDisposed) return;
    this.traceDisposed = true;
    const disposer = this.traceDisposer;
    this.traceDisposer = undefined;
    disposer?.();
  }

  destroy(): void {
    this.dispose();
  }

  private renderBase(
    lod: RenderLod,
    invalidation: CoalescedInvalidation,
    fullInvalidation: boolean
  ): { visitedCells: number; drawnCells: number; drawnBackstitches: number } {
    const target = this.options.targets.base;
    prepareTarget(target, this.metrics);
    const context = target.context;
    const cellInvalidationRect = invalidation.cellRect ? cellToScreenRect(invalidation.cellRect, this.viewport) : undefined;
    const invalidationRect = unionRect(invalidation.rect, cellInvalidationRect);
    const partial = !fullInvalidation && lod !== RenderLod.Overview && invalidationRect !== undefined && clipToRect(context, invalidationRect);
    if (!partial) {
      clearTarget(target, this.metrics);
      context.fillStyle = this.style.backgroundColor;
      context.globalAlpha = 1;
      context.fillRect(0, 0, this.metrics.cssWidth, this.metrics.cssHeight);
    } else {
      context.clearRect(invalidationRect.x, invalidationRect.y, invalidationRect.width, invalidationRect.height);
      context.fillStyle = this.style.backgroundColor;
      context.globalAlpha = 1;
      context.fillRect(invalidationRect.x, invalidationRect.y, invalidationRect.width, invalidationRect.height);
    }
    // Move-image mode dims the committed pattern so the reference image reads
    // on top; the reference image itself keeps its configured opacity.
    const dimAlpha = this.patternDimmed ? 0.5 : 1;
    if (lod === RenderLod.Overview) {
      if (dimAlpha < 1) save(context);
      if (dimAlpha < 1) setAlpha(context, dimAlpha);
      if (this.style.mode === ChartPresentationMode.Symbol) {
        const symbolAtlas = this.symbolAtlas.get(this.document, this.style, this.atlasFactory);
        const canDrawCachedSymbols = Boolean(
          symbolAtlas.source &&
          context.drawImage &&
          isCanvasImageSource(symbolAtlas.source) &&
          (symbolAtlas.textAvailable || !context.fillText)
        );
        if (canDrawCachedSymbols) {
          const previousSmoothing = context.imageSmoothingEnabled;
          let drawnFromAtlas = false;
          try {
            if (previousSmoothing !== undefined) context.imageSmoothingEnabled = true;
            drawImage(
              context,
              symbolAtlas.source,
              symbolAtlas.width,
              symbolAtlas.height,
              -this.viewport.x * this.viewport.zoom,
              -this.viewport.y * this.viewport.zoom,
              this.document.width * this.viewport.zoom,
              this.document.height * this.viewport.zoom
            );
            drawnFromAtlas = true;
          } catch {
            // An adapter can expose drawImage but still reject this source;
            // use the direct visible-cell Symbol path below.
          } finally {
            if (previousSmoothing !== undefined) context.imageSmoothingEnabled = previousSmoothing;
          }
          if (drawnFromAtlas) {
            const visible = visibleCellRect(this.viewport, this.metrics, this.document);
            drawGrid(context, this.document, this.viewport, this.metrics, this.style, visible, lod);
            drawChartBorder(context, this.document, this.viewport, this.metrics, this.style);
            if (dimAlpha < 1) restore(context);
            drawTraceImage(context, this.traceImage, this.document, this.viewport, this.metrics);
            return { visitedCells: 0, drawnCells: 0, drawnBackstitches: 0 };
          }
        }
        const fallback = drawOverviewSymbolFallback(context, this.document, this.viewport, this.metrics, this.style);
        const visible = visibleCellRect(this.viewport, this.metrics, this.document);
        drawGrid(context, this.document, this.viewport, this.metrics, this.style, visible, lod);
        drawChartBorder(context, this.document, this.viewport, this.metrics, this.style);
        if (dimAlpha < 1) restore(context);
        drawTraceImage(context, this.traceImage, this.document, this.viewport, this.metrics);
        return { ...fallback, drawnBackstitches: 0 };
      }
      context.imageSmoothingEnabled = false;
      const atlas = this.atlas.get(this.document, this.style, this.atlasFactory);
      const visible = visibleCellRect(this.viewport, this.metrics, this.document);
      if (atlas.source && context.drawImage && isCanvasImageSource(atlas.source)) {
        drawImage(context, atlas.source, atlas.width, atlas.height, -this.viewport.x * this.viewport.zoom, -this.viewport.y * this.viewport.zoom, this.document.width * this.viewport.zoom, this.document.height * this.viewport.zoom);
        drawGrid(context, this.document, this.viewport, this.metrics, this.style, visible, lod);
        drawChartBorder(context, this.document, this.viewport, this.metrics, this.style);
        if (dimAlpha < 1) restore(context);
        drawTraceImage(context, this.traceImage, this.document, this.viewport, this.metrics);
        return { visitedCells: 0, drawnCells: 0, drawnBackstitches: 0 };
      }
      const fallback = drawOverviewFallback(context, this.document, this.viewport, this.metrics, this.style);
      drawGrid(context, this.document, this.viewport, this.metrics, this.style, visible, lod);
      drawChartBorder(context, this.document, this.viewport, this.metrics, this.style);
      if (dimAlpha < 1) restore(context);
      drawTraceImage(context, this.traceImage, this.document, this.viewport, this.metrics);
      return { ...fallback, drawnBackstitches: 0 };
    }
    const visible = visibleCellRect(this.viewport, this.metrics, this.document);
    const invalidationCellRect = (invalidation.cellRect && invalidationRect
      ? unionRect(invalidation.cellRect, screenRectToCellRect(invalidationRect, this.viewport))
      : invalidation.cellRect ?? (invalidationRect ? screenRectToCellRect(invalidationRect, this.viewport) : visible));
    const boundedCellRect = invalidationCellRect ?? visible;
    const dirtyCells = partial
      ? intersectCellRects(visible, boundedCellRect)
      : visible;
    let drawnCells = 0;
    if (dimAlpha < 1) save(context);
    if (dimAlpha < 1) setAlpha(context, dimAlpha);
    for (let y = dirtyCells.y; y < dirtyCells.y + dirtyCells.height; y += 1) {
      for (let x = dirtyCells.x; x < dirtyCells.x + dirtyCells.width; x += 1) {
        if (drawCell(context, this.document, x, y, this.style, this.viewport, lod, dimAlpha)) drawnCells += 1;
      }
    }
    drawGrid(context, this.document, this.viewport, this.metrics, this.style, dirtyCells, lod);
    drawMidGrid(context, this.document, this.viewport, this.metrics, this.style, dirtyCells, lod);
    drawChartBorder(context, this.document, this.viewport, this.metrics, this.style);
    const dirtyModel = partial ? {
      x: this.viewport.x + invalidationRect.x / this.viewport.zoom,
      y: this.viewport.y + invalidationRect.y / this.viewport.zoom,
      width: invalidationRect.width / this.viewport.zoom,
      height: invalidationRect.height / this.viewport.zoom
    } : undefined;
    const drawnBackstitches = drawBackstitches(context, this.document, this.viewport, this.metrics, this.style, dirtyModel, dimAlpha);
    if (dimAlpha < 1) restore(context);
    drawTraceImage(context, this.traceImage, this.document, this.viewport, this.metrics);
    if (partial) restore(context);
    return { visitedCells: dirtyCells.width * dirtyCells.height, drawnCells, drawnBackstitches };
  }

  private renderOverlay(fullInvalidation: boolean, invalidation: CoalescedInvalidation, lod: RenderLod): void {
    const target = this.options.targets.overlay;
    prepareTarget(target, this.metrics);
    const dirtyRect = !fullInvalidation
      ? unionRect(invalidation.rect, invalidation.cellRect ? cellToScreenRect(invalidation.cellRect, this.viewport) : undefined)
      : undefined;
    drawOverlay(target.context, this.document, this.overlay, this.viewport, this.metrics, this.style, lod, dirtyRect);
    if (this.overlay.imageResizeHandles && this.traceImage) {
      drawResizeHandles(target.context, this.traceImage, this.document, this.viewport, this.style, this.overlay.color ?? this.style.selectionColor);
    }
  }
}

/** Resize-mode corner handles at the projected image corners (8px screen squares). */
function drawResizeHandles(
  context: CanvasContextAdapter,
  trace: TraceImage,
  document: PatternDocument,
  viewport: Viewport,
  style: RendererStyle,
  color: string
): void {
  const projection = createTraceImageProjection(trace, document, viewport, { cssWidth: 0, cssHeight: 0, dpr: 1 });
  if (!projection) return;
  const rect = projection.screenRect;
  const size = 8;
  const half = size / 2;
  const corners: readonly ScreenPoint[] = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x, y: rect.y + rect.height },
    { x: rect.x + rect.width, y: rect.y + rect.height }
  ];
  for (const corner of corners) {
    save(context);
    context.fillStyle = 'rgba(255, 255, 255, 0.95)';
    context.fillRect(corner.x - half, corner.y - half, size, size);
    context.strokeStyle = color;
    context.lineWidth = 1.5;
    if (context.strokeRect) context.strokeRect(corner.x - half, corner.y - half, size, size);
    restore(context);
  }
}

export function createCanvasRenderer(options: CanvasRendererOptions): CanvasRenderer {
  return new Canvas2DRenderer(options);
}

export const createRenderer = createCanvasRenderer;
