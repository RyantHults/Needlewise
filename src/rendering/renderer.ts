import {
  CellKind,
  type PatternDocument
} from '../domain';
import {
  ChartPresentationMode,
  DEFAULT_LOD_THRESHOLDS,
  DEFAULT_RENDERER_STYLE,
  RenderLod,
  type CanvasCellSet,
  type CanvasContextAdapter,
  type CanvasEditingOverlay,
  type CanvasMetrics,
  type CanvasRenderer,
  type CanvasRendererOptions,
  type CellRect,
  type CoalescedInvalidation,
  type FixedPoint,
  type FloatingPasteOverlay,
  type FloatingPasteSelectionOverlay,
  type Invalidation,
  type InvalidationLayer,
  type LassoPathOverlay,
  type LodThresholds,
  type ModelPoint,
  type OverlayState,
  type PendingCellState,
  type RenderStats,
  type RendererStyle,
  type Rect,
  type SelectionBoundarySegment,
  type SelectionOverlay,
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
  overviewColorForPaletteId,
  patternBackgroundColor
} from './atlas';
import { clearTarget, defaultAtlasTargetFactory, drawImage, prepareTarget, restore, save } from './context';
import { grayscaleColor } from './colors';
import { contrastSymbolInk, relativeLuminance } from './contrast';
import { drawPaletteSymbol, drawStitchGeometry } from './symbol-painter';
import { createTraceImageProjection, drawTraceImage } from './trace';
import { isLegacyQuarterKind, isThreeQuarterKind, isThreeQuarterPairKind, threeQuarterPairComponents } from '../editor/cell-kinds';
import { selectionBoundarySegments } from '../editor/lasso';

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
  setAlpha(context, dimAlpha);
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

/** Grow a partial-redraw rect to cover the outer halves of grid lines on its
 * perimeter (major lines reach 2.5px) and their antialiasing, then snap it
 * outward to whole device pixels. A fractional clip and clearRect leave
 * half-blended edge pixels that read as a seam rectangle around the edit. */
function expandDirtyRect(rect: Rect, pixelRatio: number): Rect {
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  const margin = 2;
  const left = Math.floor((rect.x - margin) * ratio) / ratio;
  const top = Math.floor((rect.y - margin) * ratio) / ratio;
  const right = Math.ceil((rect.x + rect.width + margin) * ratio) / ratio;
  const bottom = Math.ceil((rect.y + rect.height + margin) * ratio) / ratio;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Round a screen coordinate to the nearest device pixel, so adjacent full-cell
 * fills share exact edges instead of leaving anti-aliased seams between them. */
function snapToDevicePixel(value: number, pixelRatio: number): number {
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  return Math.round(value * ratio) / ratio;
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
  dimAlpha = 1,
  pixelRatio = 1
): boolean {
  if (kind === CellKind.Empty) return false;
  const rect = cellToScreenRect({ x, y, width: 1, height: 1 }, viewport);
  const symbolMode = style.mode === ChartPresentationMode.Symbol;
  const paintShape = (id: number, completed: boolean, slot?: number, geometryKind = kind): void => {
    save(context);
    context.fillStyle = symbolMode ? style.symbolBackgroundColor : styleColor(document, id, style);
    setAlpha(context, (completed ? style.completedOpacity : 1) * dimAlpha);
    if (geometryKind === CellKind.Full) {
      // Snap the start and end edges independently (not the width) so
      // neighbouring cells tile with no gap or overlap between them.
      const x0 = snapToDevicePixel(rect.x, pixelRatio);
      const x1 = snapToDevicePixel(rect.x + rect.width, pixelRatio);
      const y0 = snapToDevicePixel(rect.y, pixelRatio);
      const y1 = snapToDevicePixel(rect.y + rect.height, pixelRatio);
      context.fillRect(x0, y0, x1 - x0, y1 - y0);
    } else drawStitchGeometry(context, geometryKind, rect, slot);
    restore(context);
  };
  const paintMarks = (id: number, completed: boolean, slot?: number): void => {
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
  const fill = (id: number, completed: boolean, slot?: number, geometryKind = kind): void => {
    paintShape(id, completed, slot, geometryKind);
    paintMarks(id, completed, slot);
  };

  if (isLegacyQuarterKind(kind)) {
    for (let slot = 0; slot < 4; slot += 1) {
      const id = colors[slot] ?? 0;
      if (id !== 0) fill(id, (completed & (1 << slot)) !== 0, slot);
    }
  } else if (isThreeQuarterPairKind(kind)) {
    const components = threeQuarterPairComponents(colors).filter((component) => (colors[component.slot] ?? 0) !== 0);
    for (const component of components) {
      paintShape(colors[component.slot] ?? 0, (completed & (1 << component.slot)) !== 0, component.slot, component.kind);
    }
    // The seam keeps two same-colored three-quarters from reading as one full stitch. It sits above
    // the fills and below the symbols and completion marks.
    if (components.length > 0 && lod !== RenderLod.Overview) {
      const first = components[0];
      const firstId = colors[first.slot] ?? 0;
      const backslashSeam = first.slot === 0;
      save(context);
      context.strokeStyle = contrastSymbolInk(
        symbolMode ? style.symbolBackgroundColor : styleColor(document, firstId, style),
        style.symbolColor
      );
      context.lineWidth = Math.max(1, Math.min(2, viewport.zoom * 0.06));
      setAlpha(context, ((completed & (1 << first.slot)) !== 0 ? style.completedOpacity : 1) * dimAlpha);
      linePath(
        context,
        backslashSeam ? { x: rect.x + rect.width, y: rect.y } : { x: rect.x, y: rect.y },
        backslashSeam ? { x: rect.x, y: rect.y + rect.height } : { x: rect.x + rect.width, y: rect.y + rect.height }
      );
      restore(context);
    }
    for (const component of components) {
      paintMarks(colors[component.slot] ?? 0, (completed & (1 << component.slot)) !== 0, component.slot);
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
  dimAlpha = 1,
  pixelRatio = 1
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
    dimAlpha,
    pixelRatio
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

/**
 * Emit each maximal run [from, to) of cell positions along one grid line of a
 * masked canvas whose edge is drawn. A vertical line `line` runs along rows,
 * a horizontal one along columns; positions must lie inside the box. With
 * `outline` an edge is drawn where exactly one side is active (the canvas
 * outline), otherwise where at least one side is.
 */
function forEachEdgeRun(
  mask: Uint8Array,
  width: number,
  height: number,
  vertical: boolean,
  line: number,
  from: number,
  to: number,
  outline: boolean,
  emit: (from: number, to: number) => void
): void {
  let runStart = -1;
  for (let position = from; position < to; position += 1) {
    const before = vertical
      ? line > 0 && mask[position * width + line - 1] === 1
      : line > 0 && mask[(line - 1) * width + position] === 1;
    const after = vertical
      ? line < width && mask[position * width + line] === 1
      : line < height && mask[line * width + position] === 1;
    const drawn = outline ? before !== after : before || after;
    if (drawn && runStart < 0) runStart = position;
    else if (!drawn && runStart >= 0) {
      emit(runStart, position);
      runStart = -1;
    }
  }
  if (runStart >= 0) emit(runStart, to);
}

/**
 * The edge runs of every grid line of one mask, in compressed rows: line i's
 * runs are the [from, to) pairs at `runs[2 * k]`, `runs[2 * k + 1]` for k in
 * `starts[i] .. starts[i + 1]`, in increasing order.
 */
interface EdgeRuns {
  readonly starts: Uint32Array;
  readonly runs: Uint32Array;
}

interface MaskEdges {
  readonly width: number;
  readonly vertical: EdgeRuns;
  readonly horizontal: EdgeRuns;
}

/** Outline edges (exactly one active side) and grid edges (at least one) per mask, built once per mask reference. */
const maskOutlineEdges = new WeakMap<Uint8Array, MaskEdges>();
const maskGridEdges = new WeakMap<Uint8Array, MaskEdges>();

function buildEdgeRuns(mask: Uint8Array, width: number, height: number, vertical: boolean, outline: boolean): EdgeRuns {
  const lines = (vertical ? width : height) + 1;
  const length = vertical ? height : width;
  const starts = new Uint32Array(lines + 1);
  const runs: number[] = [];
  for (let line = 0; line < lines; line += 1) {
    starts[line] = runs.length / 2;
    forEachEdgeRun(mask, width, height, vertical, line, 0, length, outline, (from, to) => {
      runs.push(from, to);
    });
  }
  starts[lines] = runs.length / 2;
  return { starts, runs: Uint32Array.from(runs) };
}

/** The cached edge runs of a document's mask, rebuilt only when the mask object (or its width) changes. */
function maskEdges(mask: Uint8Array, width: number, height: number, outline: boolean): MaskEdges {
  const cache = outline ? maskOutlineEdges : maskGridEdges;
  const cached = cache.get(mask);
  if (cached?.width === width) return cached;
  const edges = {
    width,
    vertical: buildEdgeRuns(mask, width, height, true, outline),
    horizontal: buildEdgeRuns(mask, width, height, false, outline)
  };
  cache.set(mask, edges);
  return edges;
}

/** Emit a line's cached runs clipped to [from, to); only the runs of that one line are visited. */
function forEachCachedRun(edges: EdgeRuns, line: number, from: number, to: number, emit: (from: number, to: number) => void): void {
  const end = edges.starts[line + 1];
  for (let run = edges.starts[line]; run < end; run += 1) {
    const start = edges.runs[2 * run];
    const stop = edges.runs[2 * run + 1];
    if (start >= to) return;
    if (stop > from) emit(Math.max(start, from), Math.min(stop, to));
  }
}

/** Emit each maximal run [from, to) of active columns in one box row. */
function forEachActiveRun(mask: Uint8Array, width: number, y: number, from: number, to: number, emit: (from: number, to: number) => void): void {
  const row = y * width;
  let runStart = -1;
  for (let x = from; x < to; x += 1) {
    const active = mask[row + x] === 1;
    if (active && runStart < 0) runStart = x;
    else if (!active && runStart >= 0) {
      emit(runStart, x);
      runStart = -1;
    }
  }
  if (runStart >= 0) emit(runStart, to);
}

/**
 * Paint the fabric over the active cells inside `area` (screen space). A full
 * rectangle is one fill; a masked canvas fills runs of active cells per row.
 */
function fillCanvasFabric(
  context: CanvasContextAdapter,
  document: PatternDocument,
  viewport: Viewport,
  metrics: CanvasMetrics,
  area: Rect,
  color: string
): void {
  context.fillStyle = color;
  const mask = document.canvasMask;
  if (mask === undefined) {
    const box = intersectRects(cellToScreenRect({ x: 0, y: 0, width: document.width, height: document.height }, viewport), area);
    if (box) context.fillRect(box.x, box.y, box.width, box.height);
    return;
  }
  const cells = intersectCellRects(visibleCellRect(viewport, metrics, document), screenRectToCellRect(area, viewport));
  const zoom = viewport.zoom;
  for (let y = cells.y; y < cells.y + cells.height; y += 1) {
    const top = snapToDevicePixel((y - viewport.y) * zoom, metrics.dpr);
    const bottom = snapToDevicePixel((y + 1 - viewport.y) * zoom, metrics.dpr);
    forEachActiveRun(mask, document.width, y, cells.x, cells.x + cells.width, (from, to) => {
      const left = snapToDevicePixel((from - viewport.x) * zoom, metrics.dpr);
      const right = snapToDevicePixel((to - viewport.x) * zoom, metrics.dpr);
      context.fillRect(left, top, right - left, bottom - top);
    });
  }
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
  // A masked canvas draws only the edges that border an active cell.
  const mask = document.canvasMask;
  const edges = mask === undefined ? undefined : maskEdges(mask, document.width, document.height, false);
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
      const line = (from: number, to: number): void => {
        const segment = clipSegmentToRect(
          modelToScreen({ x, y: from }, viewport),
          modelToScreen({ x, y: to }, viewport),
          bounds
        );
        if (segment) gridLine(context, segment.start, segment.end, major ? style.majorGridColor : style.gridColor, major ? majorGridWidth(lod) : minorGridWidth(lod));
      };
      if (edges === undefined) line(top, bottom);
      else if (edges) forEachCachedRun(edges.vertical, x, top, bottom, line);
    }
    const firstY = Math.ceil(top / interval) * interval;
    const lastY = Math.floor(bottom / interval) * interval;
    for (let y = firstY; y <= lastY; y += interval) {
      const screenY = modelToScreen({ x: 0, y }, viewport).y;
      if (screenY < bounds.y || screenY > bounds.y + bounds.height) continue;
      const major = lod === RenderLod.Overview || y % configuredInterval === 0;
      if (lod === RenderLod.Compact && !major) continue;
      const line = (from: number, to: number): void => {
        const segment = clipSegmentToRect(
          modelToScreen({ x: from, y }, viewport),
          modelToScreen({ x: to, y }, viewport),
          bounds
        );
        if (segment) gridLine(context, segment.start, segment.end, major ? style.majorGridColor : style.gridColor, major ? majorGridWidth(lod) : minorGridWidth(lod));
      };
      if (edges === undefined) line(left, right);
      else if (edges) forEachCachedRun(edges.horizontal, y, left, right, line);
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
  // A masked canvas draws only the edges that border an active cell.
  const mask = document.canvasMask;
  const edges = mask === undefined ? undefined : maskEdges(mask, document.width, document.height, false);
  const clipped = clipToRect(context, bounds);
  try {
    const firstX = Math.ceil(left / interval) * interval;
    const lastX = Math.floor(right / interval) * interval;
    for (let x = firstX; x <= lastX; x += interval) {
      if (x === 0 || x === document.width) continue; // Skip document edges (the border owns them).
      const screenX = modelToScreen({ x, y: 0 }, viewport).x;
      if (screenX < bounds.x || screenX > bounds.x + bounds.width) continue;
      const line = (from: number, to: number): void => {
        const segment = clipSegmentToRect(
          modelToScreen({ x, y: from }, viewport),
          modelToScreen({ x, y: to }, viewport),
          bounds
        );
        if (segment) gridLine(context, segment.start, segment.end, style.midGridColor, midGridWidth(lod));
      };
      if (edges === undefined) line(top, bottom);
      else if (edges) forEachCachedRun(edges.vertical, x, top, bottom, line);
    }
    const firstY = Math.ceil(top / interval) * interval;
    const lastY = Math.floor(bottom / interval) * interval;
    for (let y = firstY; y <= lastY; y += interval) {
      if (y === 0 || y === document.height) continue; // Skip document edges.
      const screenY = modelToScreen({ x: 0, y }, viewport).y;
      if (screenY < bounds.y || screenY > bounds.y + bounds.height) continue;
      const line = (from: number, to: number): void => {
        const segment = clipSegmentToRect(
          modelToScreen({ x: from, y }, viewport),
          modelToScreen({ x: to, y }, viewport),
          bounds
        );
        if (segment) gridLine(context, segment.start, segment.end, style.midGridColor, midGridWidth(lod));
      };
      if (edges === undefined) line(left, right);
      else if (edges) forEachCachedRun(edges.horizontal, y, left, right, line);
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
    const mask = document.canvasMask;
    if (mask !== undefined) {
      // A masked canvas outlines its active region: every visible edge with
      // exactly one active side, holes included.
      const visible = visibleCellRect(viewport, metrics, document);
      const right = visible.x + visible.width;
      const bottom = visible.y + visible.height;
      const edges = maskEdges(mask, document.width, document.height, true);
      for (let x = visible.x; x <= right; x += 1) {
        forEachCachedRun(edges.vertical, x, visible.y, bottom, (from, to) => {
          const segment = clipSegmentToRect(modelToScreen({ x, y: from }, viewport), modelToScreen({ x, y: to }, viewport), canvas);
          if (segment) linePath(context, segment.start, segment.end);
        });
      }
      for (let y = visible.y; y <= bottom; y += 1) {
        forEachCachedRun(edges.horizontal, y, visible.x, right, (from, to) => {
          const segment = clipSegmentToRect(modelToScreen({ x: from, y }, viewport), modelToScreen({ x: to, y }, viewport), canvas);
          if (segment) linePath(context, segment.start, segment.end);
        });
      }
      return;
    }
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

/** Ghost lines are skipped once they would sit closer than this many pixels. */
const GHOST_MIN_LINE_SPACING = 8;
const GHOST_MAJOR_WIDTH = 1;
const WORKSPACE_EDGE_WIDTH = 1.5;
const CANVAS_ADD_OPACITY = 0.35;
const CANVAS_REMOVE_OPACITY = 0.25;
const CANVAS_REMOVE_HATCH_OPACITY = 0.8;
const CANVAS_REMOVE_HATCH_SPACING = 8;

/** Modulo that keeps the canvas's major-line phase at negative local coordinates. */
function isMajorLine(value: number, interval: number): boolean {
  return ((value % interval) + interval) % interval === 0;
}

/**
 * The workspace's ghost grid and dashed edge, in local coordinates. It is
 * drawn in the base target under the fabric, so active cells hide it and only
 * off-canvas cells and holes show it. Only the visible part is walked: Detail
 * draws every line, Compact and Overview only the major ones, and lines that
 * would sit closer than GHOST_MIN_LINE_SPACING pixels are skipped.
 */
function drawGhostGrid(
  context: CanvasContextAdapter,
  workspace: CellRect,
  viewport: Viewport,
  metrics: CanvasMetrics,
  style: RendererStyle,
  lod: RenderLod
): void {
  const view = viewportModelRect(viewport, metrics);
  const left = Math.max(workspace.x, Math.floor(view.x));
  const right = Math.min(workspace.x + workspace.width, Math.ceil(view.x + view.width));
  const top = Math.max(workspace.y, Math.floor(view.y));
  const bottom = Math.min(workspace.y + workspace.height, Math.ceil(view.y + view.height));
  if (right < left || bottom < top) return;
  const zoom = viewport.zoom > 0 && Number.isFinite(viewport.zoom) ? viewport.zoom : 1;
  const interval = Number.isFinite(style.gridInterval) ? Math.max(1, Math.floor(style.gridInterval)) : 1;
  const step = lod === RenderLod.Detail && zoom >= GHOST_MIN_LINE_SPACING ? 1 : interval;
  save(context);
  if (step * zoom >= GHOST_MIN_LINE_SPACING) {
    for (let x = Math.ceil(left / step) * step; x <= right; x += step) {
      const major = isMajorLine(x, interval);
      gridLine(context, modelToScreen({ x, y: top }, viewport), modelToScreen({ x, y: bottom }, viewport), major ? style.ghostMajorGridColor : style.ghostGridColor, major ? GHOST_MAJOR_WIDTH : minorGridWidth(lod));
    }
    for (let y = Math.ceil(top / step) * step; y <= bottom; y += step) {
      const major = isMajorLine(y, interval);
      gridLine(context, modelToScreen({ x: left, y }, viewport), modelToScreen({ x: right, y }, viewport), major ? style.ghostMajorGridColor : style.ghostGridColor, major ? GHOST_MAJOR_WIDTH : minorGridWidth(lod));
    }
  }
  const screen = { x: 0, y: 0, width: metrics.cssWidth, height: metrics.cssHeight };
  const edgeRight = workspace.x + workspace.width;
  const edgeBottom = workspace.y + workspace.height;
  const sides: readonly [ModelPoint, ModelPoint][] = [
    [{ x: workspace.x, y: workspace.y }, { x: edgeRight, y: workspace.y }],
    [{ x: edgeRight, y: workspace.y }, { x: edgeRight, y: edgeBottom }],
    [{ x: edgeRight, y: edgeBottom }, { x: workspace.x, y: edgeBottom }],
    [{ x: workspace.x, y: edgeBottom }, { x: workspace.x, y: workspace.y }]
  ];
  context.strokeStyle = style.ghostMajorGridColor;
  context.lineWidth = WORKSPACE_EDGE_WIDTH;
  context.setLineDash?.([6, 4]);
  for (const [start, end] of sides) {
    const segment = clipSegmentToRect(modelToScreen(start, viewport), modelToScreen(end, viewport), screen);
    if (segment) linePath(context, segment.start, segment.end);
  }
  restore(context);
}

/** Emit each visible run of a canvas cell set as a screen rect; the set may lie outside the box. */
function forEachCellSetRun(set: CanvasCellSet, viewport: Viewport, metrics: CanvasMetrics, emit: (rect: Rect) => void): void {
  const view = viewportModelRect(viewport, metrics);
  const viewX = Math.floor(view.x);
  const viewY = Math.floor(view.y);
  const area = intersectCellRects(set.rect, {
    x: viewX,
    y: viewY,
    width: Math.ceil(view.x + view.width) - viewX,
    height: Math.ceil(view.y + view.height) - viewY
  });
  if (area.width === 0 || area.height === 0) return;
  const cells = set.cells;
  if (cells === undefined) {
    emit(cellToScreenRect(area, viewport));
    return;
  }
  const from = area.x - set.rect.x;
  for (let y = area.y; y < area.y + area.height; y += 1) {
    forEachActiveRun(cells, set.rect.width, y - set.rect.y, from, from + area.width, (start, end) => {
      emit(cellToScreenRect({ x: set.rect.x + start, y, width: end - start, height: 1 }, viewport));
    });
  }
}

function drawCanvasAddCells(context: CanvasContextAdapter, set: CanvasCellSet, viewport: Viewport, metrics: CanvasMetrics, style: RendererStyle): void {
  save(context);
  context.fillStyle = style.canvasAddColor;
  setAlpha(context, CANVAS_ADD_OPACITY);
  forEachCellSetRun(set, viewport, metrics, (rect) => context.fillRect(rect.x, rect.y, rect.width, rect.height));
  restore(context);
}

/** A translucent red fill, then a diagonal hatch clipped to the same cells. */
function drawCanvasRemoveCells(context: CanvasContextAdapter, set: CanvasCellSet, viewport: Viewport, metrics: CanvasMetrics, style: RendererStyle): void {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  save(context);
  context.fillStyle = style.canvasRemoveColor;
  setAlpha(context, CANVAS_REMOVE_OPACITY);
  forEachCellSetRun(set, viewport, metrics, (rect) => {
    context.fillRect(rect.x, rect.y, rect.width, rect.height);
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
  });
  restore(context);
  if (right <= left || !context.clip || !context.save || !context.restore) return;
  save(context);
  context.beginPath();
  forEachCellSetRun(set, viewport, metrics, (rect) => {
    context.moveTo(rect.x, rect.y);
    context.lineTo(rect.x + rect.width, rect.y);
    context.lineTo(rect.x + rect.width, rect.y + rect.height);
    context.lineTo(rect.x, rect.y + rect.height);
    context.closePath?.();
  });
  context.clip();
  context.strokeStyle = style.canvasRemoveColor;
  context.lineWidth = 1;
  setAlpha(context, CANVAS_REMOVE_HATCH_OPACITY);
  // Lines x + y = s, phased to the model origin so the hatch stays put on cells while panning.
  const origin = modelToScreen({ x: 0, y: 0 }, viewport);
  const spacing = CANVAS_REMOVE_HATCH_SPACING;
  const phase = (((origin.x + origin.y) % spacing) + spacing) % spacing;
  const first = Math.floor((left + top - phase) / spacing) * spacing + phase;
  for (let sum = first; sum <= right + bottom; sum += spacing) {
    linePath(context, { x: sum - bottom, y: bottom }, { x: sum - top, y: top });
  }
  restore(context);
}

/** `from` minus `cut`, as up to four strips. */
function subtractCellRect(from: CellRect, cut: CellRect): CellRect[] {
  const inner = intersectCellRects(from, cut);
  if (inner.width === 0 || inner.height === 0) return [from];
  const fromRight = from.x + from.width;
  const fromBottom = from.y + from.height;
  const innerRight = inner.x + inner.width;
  const innerBottom = inner.y + inner.height;
  return [
    { x: from.x, y: from.y, width: from.width, height: inner.y - from.y },
    { x: from.x, y: innerBottom, width: from.width, height: fromBottom - innerBottom },
    { x: from.x, y: inner.y, width: inner.x - from.x, height: inner.height },
    { x: innerRight, y: inner.y, width: fromRight - innerRight, height: inner.height }
  ].filter((strip) => strip.width > 0 && strip.height > 0);
}

/** Boundaries of a sparse canvas selection, relative to its rect; cached per set. */
const canvasSelectionBoundaries = new WeakMap<CanvasCellSet, SelectionBoundarySegment[]>();

function canvasSetBoundaries(set: CanvasCellSet, cells: Uint8Array): SelectionBoundarySegment[] {
  const cached = canvasSelectionBoundaries.get(set);
  if (cached) return cached;
  let count = 0;
  for (let index = 0; index < cells.length; index += 1) count += cells[index] === 1 ? 1 : 0;
  const indices = new Uint32Array(count);
  let position = 0;
  for (let index = 0; index < cells.length; index += 1) if (cells[index] === 1) indices[position++] = index;
  const boundaries = selectionBoundarySegments(indices, set.rect.width, set.rect.height);
  canvasSelectionBoundaries.set(set, boundaries);
  return boundaries;
}

/** The pending canvas edit and the canvas selection; both may reach past the box, so they clip to the screen. */
function drawCanvasEditing(
  context: CanvasContextAdapter,
  document: PatternDocument,
  editing: CanvasEditingOverlay,
  viewport: Viewport,
  metrics: CanvasMetrics,
  style: RendererStyle,
  screen: Rect,
  selectionColor: string | undefined
): void {
  const preview = editing.preview;
  if (preview?.kind === 'add') drawCanvasAddCells(context, preview, viewport, metrics, style);
  else if (preview?.kind === 'remove') drawCanvasRemoveCells(context, preview, viewport, metrics, style);
  else if (preview?.kind === 'resize') {
    const box = { x: 0, y: 0, width: document.width, height: document.height };
    for (const rect of subtractCellRect(preview.box, box)) drawCanvasAddCells(context, { rect }, viewport, metrics, style);
    for (const rect of subtractCellRect(box, preview.box)) drawCanvasRemoveCells(context, { rect }, viewport, metrics, style);
    drawSelectionRect(context, preview.box, viewport, style, screen, style.chartBorderColor, true);
  }
  const selection = editing.selection;
  if (!selection || selectionColor === undefined) return;
  const cells = selection.cells;
  if (cells === undefined) {
    drawSelectionRect(context, selection.rect, viewport, style, screen, selectionColor, false);
    return;
  }
  drawSparseSelectionBoundaries(
    context,
    canvasSetBoundaries(selection, cells),
    document,
    viewport,
    style,
    screen,
    selectionColor,
    selection.rect.x,
    selection.rect.y,
    viewportModelRect(viewport, metrics)
  );
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
  context.lineWidth = Math.max(2, Math.min(6, viewport.zoom * 0.2));
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
  if (cells.length === 0) return;
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
      if (drawCell(context, document, x, y, style, viewport, RenderLod.Overview, 1, metrics.dpr)) drawnCells += 1;
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

function overlayLassoPoints(value: OverlayState['lassoPath']): readonly ModelPoint[] | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value : (value as LassoPathOverlay).points;
}

function drawLassoPath(
  context: CanvasContextAdapter,
  points: readonly ModelPoint[] | undefined,
  document: PatternDocument,
  viewport: Viewport,
  style: RendererStyle,
  bounds: Rect,
  color?: string
): void {
  if (!points || points.length < 2) return;
  const chart = { x: 0, y: 0, width: document.width, height: document.height };
  save(context);
  context.strokeStyle = color ?? style.selectionColor;
  context.lineWidth = style.overlayLineWidth;
  context.setLineDash?.([6, 4]);
  for (let index = 0; index < points.length; index += 1) {
    const modelSegment = clipSegmentToRect(points[index], points[(index + 1) % points.length], chart);
    if (!modelSegment) continue;
    const screenSegment = clipSegmentToRect(
      modelToScreen(modelSegment.start, viewport),
      modelToScreen(modelSegment.end, viewport),
      bounds
    );
    if (!screenSegment) continue;
    linePath(context, screenSegment.start, screenSegment.end);
  }
  restore(context);
}

function drawSparseSelectionBoundaries(
  context: CanvasContextAdapter,
  boundaries: readonly SelectionBoundarySegment[],
  document: PatternDocument,
  viewport: Viewport,
  style: RendererStyle,
  bounds: Rect,
  color?: string,
  offsetX = 0,
  offsetY = 0,
  chart: Rect = { x: 0, y: 0, width: document.width, height: document.height }
): void {
  if (boundaries.length === 0) return;
  const zoom = viewport.zoom;
  const visibleModel = {
    x: viewport.x + bounds.x / zoom,
    y: viewport.y + bounds.y / zoom,
    width: bounds.width / zoom,
    height: bounds.height / zoom
  };
  const clipModel = intersectRects(chart, visibleModel);
  if (!clipModel) return;
  save(context);
  context.strokeStyle = color ?? style.selectionColor;
  context.lineWidth = style.overlayLineWidth;
  for (const boundary of boundaries) {
    const startX = boundary.start.x + offsetX;
    const startY = boundary.start.y + offsetY;
    const endX = boundary.end.x + offsetX;
    const endY = boundary.end.y + offsetY;
    const minX = Math.min(startX, endX);
    const maxX = Math.max(startX, endX);
    const minY = Math.min(startY, endY);
    const maxY = Math.max(startY, endY);
    if (maxX < clipModel.x || minX > clipModel.x + clipModel.width
      || maxY < clipModel.y || minY > clipModel.y + clipModel.height) continue;
    const modelSegment = clipSegmentToRect({ x: startX, y: startY }, { x: endX, y: endY }, clipModel);
    if (!modelSegment) continue;
    const screenSegment = clipSegmentToRect(
      modelToScreen(modelSegment.start, viewport),
      modelToScreen(modelSegment.end, viewport),
      bounds
    );
    if (!screenSegment) continue;
    linePath(context, screenSegment.start, screenSegment.end);
  }
  restore(context);
}

function drawSelectionRect(
  context: CanvasContextAdapter,
  rect: CellRect,
  viewport: Viewport,
  style: RendererStyle,
  bounds: Rect,
  color: string | undefined,
  dashed: boolean
): void {
  const screenRect = cellToScreenRect(rect, viewport);
  const edges: readonly [ScreenPoint, ScreenPoint][] = [
    [{ x: screenRect.x, y: screenRect.y }, { x: screenRect.x + screenRect.width, y: screenRect.y }],
    [{ x: screenRect.x + screenRect.width, y: screenRect.y }, { x: screenRect.x + screenRect.width, y: screenRect.y + screenRect.height }],
    [{ x: screenRect.x + screenRect.width, y: screenRect.y + screenRect.height }, { x: screenRect.x, y: screenRect.y + screenRect.height }],
    [{ x: screenRect.x, y: screenRect.y + screenRect.height }, { x: screenRect.x, y: screenRect.y }]
  ];
  save(context);
  context.strokeStyle = color ?? style.selectionColor;
  context.lineWidth = style.overlayLineWidth;
  if (dashed) context.setLineDash?.([6, 4]);
  for (const [start, end] of edges) {
    const clipped = clipSegmentToRect(start, end, bounds);
    if (clipped) linePath(context, clipped.start, clipped.end);
  }
  restore(context);
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
  bounds: Rect,
  pixelRatio = 1
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
  context.fillStyle = patternBackgroundColor(document);
  setAlpha(context, 1);
  context.fillRect(clippedCellRect.x, clippedCellRect.y, clippedCellRect.width, clippedCellRect.height);
  restore(context);
  drawCellState(context, document, x, y, state.kind, state.colors, state.completed, style, viewport, lod, 1, pixelRatio);
  return { x, y, width: 1, height: 1 };
}

function drawPendingCellStates(
  context: CanvasContextAdapter,
  document: PatternDocument,
  states: readonly PendingCellState[] | undefined,
  viewport: Viewport,
  style: RendererStyle,
  lod: RenderLod,
  bounds: Rect,
  pixelRatio = 1
): CellRect[] {
  if (!states || states.length === 0) return [];
  const cells: CellRect[] = [];
  for (const state of states) {
    const cell = drawPendingCellState(context, document, state, viewport, style, lod, bounds, pixelRatio);
    if (cell) cells.push(cell);
  }
  return cells;
}

function drawFloatingSelectionContour(
  context: CanvasContextAdapter,
  document: PatternDocument,
  selection: FloatingPasteSelectionOverlay,
  originX: number,
  originY: number,
  viewport: Viewport,
  style: RendererStyle,
  bounds: Rect,
  color: string | undefined,
  dashed: boolean
): void {
  if (selection.kind === 'sparse' && selection.boundaries) {
    drawSparseSelectionBoundaries(context, selection.boundaries, document, viewport, style, bounds, color, originX, originY);
    return;
  }
  drawSelectionRect(context, { x: originX, y: originY, width: selection.rect.width, height: selection.rect.height }, viewport, style, bounds, color, dashed);
}

function drawFloatingPaste(
  context: CanvasContextAdapter,
  document: PatternDocument,
  preview: FloatingPasteOverlay | null | undefined,
  viewport: Viewport,
  metrics: CanvasMetrics,
  style: RendererStyle,
  lod: RenderLod,
  bounds: Rect
): void {
  if (!preview) return;
  const destination = preview.destination;
  const chart = { x: 0, y: 0, width: document.width, height: document.height };
  if (preview.mode === 'move' && preview.sourceSelection) {
    drawFloatingSelectionContour(context, document, preview.sourceSelection, preview.sourceSelection.rect.x, preview.sourceSelection.rect.y, viewport, style, bounds, style.cursorColor, false);
  }
  const visibleDestination = intersectCellRects(destination, intersectCellRects(visibleCellRect(viewport, metrics, document), chart));
  if (visibleDestination.width > 0 && visibleDestination.height > 0) {
    const sourceLeft = visibleDestination.x - destination.x;
    const sourceTop = visibleDestination.y - destination.y;
    const sourceRight = sourceLeft + visibleDestination.width;
    const sourceBottom = sourceTop + visibleDestination.height;
    for (let y = sourceTop; y < sourceBottom; y += 1) {
      for (let x = sourceLeft; x < sourceRight; x += 1) {
        const sourceIndex = y * preview.fragment.width + x;
        const kind = preview.fragment.kind[sourceIndex] as CellKind;
        if (kind === CellKind.Empty) continue;
        const targetX = destination.x + x;
        const targetY = destination.y + y;
        if (targetX < 0 || targetY < 0 || targetX >= document.width || targetY >= document.height) continue;
        if (document.canvasMask !== undefined && document.canvasMask[targetY * document.width + targetX] !== 1) continue;
        const targetRect = cellToScreenRect({ x: targetX, y: targetY, width: 1, height: 1 }, viewport);
        const clipped = intersectRects(targetRect, bounds);
        if (!clipped) continue;
        const offset = sourceIndex * 4;
        save(context);
        context.fillStyle = style.mode === ChartPresentationMode.Symbol ? style.symbolBackgroundColor : patternBackgroundColor(document);
        setAlpha(context, 1);
        context.fillRect(clipped.x, clipped.y, clipped.width, clipped.height);
        restore(context);
        drawCellState(
          context,
          document,
          targetX,
          targetY,
          kind,
          preview.fragment.colors.subarray(offset, offset + 4),
          preview.completion?.[sourceIndex] ?? 0,
          style,
          viewport,
          lod,
          1,
          metrics.dpr
        );
      }
    }
  }

  if (lod !== RenderLod.Overview && visibleDestination.width > 0 && visibleDestination.height > 0) {
    const backstitches = preview.backstitches ?? {
      ids: [],
      x1: preview.fragment.backstitches.x1,
      y1: preview.fragment.backstitches.y1,
      x2: preview.fragment.backstitches.x2,
      y2: preview.fragment.backstitches.y2,
      colors: preview.fragment.backstitches.colors,
      completed: []
    };
    const offsetX = destination.x * 4;
    const offsetY = destination.y * 4;
    for (let index = 0; index < backstitches.x1.length; index += 1) {
      const start = fixedToModel({
        x: backstitches.x1[index] + offsetX,
        y: backstitches.y1[index] + offsetY
      });
      const end = fixedToModel({
        x: backstitches.x2[index] + offsetX,
        y: backstitches.y2[index] + offsetY
      });
      const clippedModel = clipSegmentToRect(start, end, chart);
      if (!clippedModel) continue;
      const clippedScreen = clipSegmentToRect(modelToScreen(clippedModel.start, viewport), modelToScreen(clippedModel.end, viewport), bounds);
      if (!clippedScreen) continue;
      drawBackstitchScreenSegment(context, document, viewport, style, clippedScreen.start, clippedScreen.end, backstitches.colors[index], (backstitches.completed[index] ?? 0) !== 0);
    }
  }

  const copySelection = preview.copySelection;
  if (copySelection) {
    drawFloatingSelectionContour(context, document, copySelection, destination.x, destination.y, viewport, style, bounds, preview.color, false);
  }
  drawSelectionRect(context, destination, viewport, style, bounds, preview.color, true);
}

/** Mark backstitches an uncommitted specialty-layer erase would remove. */
function drawPendingBackstitchRemovals(
  context: CanvasContextAdapter,
  document: PatternDocument,
  removals: OverlayState['pendingBackstitchRemovals'],
  viewport: Viewport,
  style: RendererStyle,
  bounds: Rect
): void {
  if (!removals || removals.length === 0) return;
  save(context);
  context.strokeStyle = style.pendingCellColor;
  context.lineWidth = Math.max(style.overlayLineWidth * 2, Math.min(8, viewport.zoom * 0.24));
  context.setLineDash?.([4, 3]);
  for (const removal of removals) {
    const modelSegment = clipSegmentToRect(
      fixedToModel(removal.start),
      fixedToModel(removal.end),
      { x: 0, y: 0, width: document.width, height: document.height }
    );
    if (!modelSegment) continue;
    const screenSegment = clipSegmentToRect(modelToScreen(modelSegment.start, viewport), modelToScreen(modelSegment.end, viewport), bounds);
    if (screenSegment) linePath(context, screenSegment.start, screenSegment.end);
  }
  restore(context);
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
  context.lineWidth = Math.max(style.overlayLineWidth * 2, Math.min(8, viewport.zoom * 0.24));
  context.setLineDash?.([6, 4]);
  linePath(context, screenSegment.start, screenSegment.end);
  restore(context);
}

function compositeHexColor(foreground: string, background: string, alpha: number): string {
  const opacity = Math.max(0, Math.min(1, alpha));
  const channels = (color: string): [number, number, number] | undefined => {
    const shorthand = /^#([\da-f])([\da-f])([\da-f])$/i.exec(color);
    if (shorthand) return [1, 2, 3].map((index) => parseInt(shorthand[index] + shorthand[index], 16)) as [number, number, number];
    const full = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color);
    if (full) return [parseInt(full[1], 16), parseInt(full[2], 16), parseInt(full[3], 16)];
    return undefined;
  };
  const foregroundChannels = channels(foreground);
  const backgroundChannels = channels(background);
  if (!foregroundChannels || !backgroundChannels || opacity >= 1) return foreground;
  return `#${foregroundChannels.map((channel, index) =>
    Math.round(channel * opacity + backgroundChannels[index] * (1 - opacity)).toString(16).padStart(2, '0')
  ).join('')}`;
}

// Pick the brush-preview outline ink for the colors a cell can expose at once
// (split-stitch slots, the pattern background, or both). A single color
// delegates to contrastSymbolInk, so it uses its 60%-gray threshold that favors
// white. Several colors deliberately keep the best worst-case WCAG contrast of
// `#ffffff` vs `darkInk` across all of them, because this only inks the preview
// outline, not symbols. Unparseable input keeps darkInk.
function bestContrastInk(colors: readonly string[], darkInk: string): string {
  if (colors.length === 0) return darkInk;
  if (colors.length === 1) return contrastSymbolInk(colors[0], darkInk);
  const luminances = colors.map(relativeLuminance);
  const darkLuminance = relativeLuminance(darkInk);
  if (darkLuminance === undefined || luminances.some((value) => value === undefined)) {
    return contrastSymbolInk(colors[0], darkInk);
  }
  const contrast = (left: number, right: number): number => (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
  const darkContrast = Math.min(...luminances.map((value) => contrast(darkLuminance, value!)));
  const whiteContrast = Math.min(...luminances.map((value) => contrast(1, value!)));
  return whiteContrast > darkContrast ? '#ffffff' : darkInk;
}

// The brush hover preview draws no fill of its own — what's actually on
// screen under it is whatever the committed document already painted there.
// This returns every color a cell could show: the painted slot colors (split
// cells can have several), composited for completed slots, plus the pattern
// background for empty cells, unpainted split slots, and out-of-bounds
// neighbours past the chart edge.
function visibleCellColors(document: PatternDocument, x: number, y: number, style: RendererStyle): string[] {
  const patternBackground = patternBackgroundColor(document);
  if (x < 0 || y < 0 || x >= document.width || y >= document.height) return [patternBackground];

  const index = y * document.width + x;
  const kind = document.kind[index];
  if (kind === CellKind.Empty) return [patternBackground];

  const offset = index * 4;
  const colors = document.colors.subarray(offset, offset + 4);
  const completed = document.completed[index];

  let slots: number[];
  if (isLegacyQuarterKind(kind)) {
    slots = [0, 1, 2, 3];
  } else if (isThreeQuarterPairKind(kind)) {
    slots = threeQuarterPairComponents(colors).map((component) => component.slot);
  } else {
    slots = [0];
  }

  const visible: string[] = [];
  for (const slot of slots) {
    const paletteId = colors[slot] ?? 0;
    if (paletteId === 0) continue;
    const fill = style.mode === ChartPresentationMode.Symbol
      ? style.symbolBackgroundColor
      : styleColor(document, paletteId, style);
    visible.push((completed & (1 << slot)) !== 0
      ? compositeHexColor(fill, patternBackground, style.completedOpacity)
      : fill);
  }
  // Every kind whose drawStitchGeometry shape doesn't fully tile the cell
  // leaves some pattern background exposed: legacy quarters and
  // three-quarter pairs can have an unpainted slot; HalfBackslash/HalfSlash
  // paint a diagonal hexagon that always leaves two opposite corner
  // triangles bare; a single-direction three-quarter stitch (NW/NE/SE/SW)
  // paints one triangle and always leaves the opposite corner bare.
  // CellKind.Full is the only kind that always fully covers its cell.
  const exposesBackground = isLegacyQuarterKind(kind)
    || isThreeQuarterPairKind(kind)
    || kind === CellKind.HalfBackslash
    || kind === CellKind.HalfSlash
    || isThreeQuarterKind(kind);
  if (exposesBackground || visible.length === 0) visible.push(patternBackground);
  return visible;
}

function drawBrushPreview(
  context: CanvasContextAdapter,
  document: PatternDocument,
  preview: OverlayState['brushPreview'],
  viewport: Viewport,
  style: RendererStyle,
  lod: RenderLod,
  bounds: Rect
): void {
  if (!preview?.states.length) return;
  const cells = new Set<string>();
  for (const state of preview.states) {
    const x = Math.floor(state.cell.x);
    const y = Math.floor(state.cell.y);
    if (x >= 0 && y >= 0 && x < document.width && y < document.height) cells.add(`${x},${y}`);
  }
  if (!cells.size) return;
  save(context);
  setAlpha(context, 1);
  const strokeWidth = Math.max(0.75, Math.min(1.5, viewport.zoom * 0.06));

  // Each outer edge segment gets its own ink/keyline pair, judged against the
  // colors actually visible there: the hovered cell and the cell just outside
  // the footprint across that edge. The keyline is drawn solid and wider so it
  // stays visible through the dashed ink's gaps; preview.color (when set)
  // overrides ink only — the keyline still tracks the underlying colors, so it
  // stays legible regardless of what color is being previewed.
  const strokeEdge = (from: ScreenPoint, to: ScreenPoint, hoveredColors: readonly string[], neighborColors: readonly string[]): void => {
    const underlyingColors = [...hoveredColors, ...neighborColors];
    const bestInk = bestContrastInk(underlyingColors, style.symbolColor);
    const keylineInk = bestInk === '#ffffff' ? style.symbolColor : '#ffffff';
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.strokeStyle = keylineInk;
    context.lineWidth = strokeWidth + 1;
    context.setLineDash?.([]);
    context.stroke();
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.strokeStyle = preview.color ?? bestInk;
    context.lineWidth = strokeWidth;
    context.setLineDash?.([3, 2]);
    context.stroke();
  };

  for (const key of cells) {
    const [x, y] = key.split(',').map(Number);
    const rect = intersectRects(cellToScreenRect({ x, y, width: 1, height: 1 }, viewport), bounds);
    if (!rect) continue;
    const hoveredColors = visibleCellColors(document, x, y, style);
    const left = modelToScreen({ x, y }, viewport);
    const right = modelToScreen({ x: x + 1, y }, viewport);
    const bottomRight = modelToScreen({ x: x + 1, y: y + 1 }, viewport);
    const bottom = modelToScreen({ x, y: y + 1 }, viewport);
    if (!cells.has(`${x},${y - 1}`)) strokeEdge(left, right, hoveredColors, visibleCellColors(document, x, y - 1, style));
    if (!cells.has(`${x + 1},${y}`)) strokeEdge(right, bottomRight, hoveredColors, visibleCellColors(document, x + 1, y, style));
    if (!cells.has(`${x},${y + 1}`)) strokeEdge(bottomRight, bottom, hoveredColors, visibleCellColors(document, x, y + 1, style));
    if (!cells.has(`${x - 1},${y}`)) strokeEdge(bottom, left, hoveredColors, visibleCellColors(document, x - 1, y, style));
  }
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
  // Canvas editing draws past the box, so its dirty area is the whole screen.
  const editing = overlay.canvasEditing ?? undefined;
  const screen = { x: 0, y: 0, width: metrics.cssWidth, height: metrics.cssHeight };
  const area = editing ? screen : bounds;
  const clippedDirtyRect = dirtyRect && area ? intersectRects(dirtyRect, area) : undefined;
  if (dirtyRect && !clippedDirtyRect) return;
  const partial = clippedDirtyRect !== undefined && clipToRect(context, clippedDirtyRect);
  if (partial) context.clearRect(clippedDirtyRect.x, clippedDirtyRect.y, clippedDirtyRect.width, clippedDirtyRect.height);
  else clearTarget({ context, width: metrics.pixelWidth, height: metrics.pixelHeight }, metrics);
  if (editing) {
    drawCanvasEditing(context, document, editing, viewport, metrics, style, screen, overlay.showSelection === false ? undefined : overlay.color ?? style.selectionColor);
  }
  if (!bounds) {
    if (partial) restore(context);
    return;
  }
  const patternClip = clipToRect(context, bounds);
  save(context);
  context.lineWidth = style.overlayLineWidth;
  let pendingStateCells: CellRect[] = [];
  if (overlay.pendingCellStates !== undefined) {
    pendingStateCells = drawPendingCellStates(context, document, overlay.pendingCellStates, viewport, style, lod, bounds, metrics.dpr);
  } else {
    drawPendingCells(context, document, overlay.pendingCells, viewport, style, bounds);
  }
  drawGridForCells(context, document, viewport, metrics, style, pendingStateCells, lod);
  drawBrushPreview(context, document, overlay.brushPreview, viewport, style, lod, bounds);
  drawBackstitchesForCells(context, document, viewport, metrics, style, pendingStateCells, lod, bounds);
  drawPendingBackstitchRemovals(context, document, overlay.pendingBackstitchRemovals, viewport, style, bounds);
  drawBackstitchPreview(context, document, overlay.backstitchPreview, viewport, style, bounds);
  drawFloatingPaste(context, document, overlay.floatingPaste, viewport, metrics, style, lod, bounds);
  const selectionValue = overlay.selection;
  const selection = overlayRect(selectionValue);
  if (selection && overlay.showSelection !== false) {
    context.strokeStyle = overlay.color ?? style.selectionColor;
    const sparse = selectionValue && 'rect' in selectionValue ? selectionValue as SelectionOverlay : undefined;
    const sparseIndices = sparse?.indices ?? sparse?.cellIndices;
    const boundaries = sparse?.boundaries
      ?? sparse?.boundarySegments
      ?? sparse?.boundary
      ?? (sparse?.exteriorBoundary || sparse?.interiorBoundary
        ? [...(sparse.exteriorBoundary ?? []), ...(sparse.interiorBoundary ?? [])]
        : undefined)
      ?? (sparse?.kind === 'sparse' && sparseIndices
        ? selectionBoundarySegments(new Uint32Array(sparseIndices), document.width, document.height)
        : undefined);
    if (boundaries && boundaries.length > 0) {
      drawSparseSelectionBoundaries(context, boundaries, document, viewport, style, bounds, overlay.color ?? sparse?.color);
    } else {
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
  }
  if (overlay.showSelection !== false) {
    const path = overlayLassoPoints(overlay.lassoPath);
    const pathValue = overlay.lassoPath && !Array.isArray(overlay.lassoPath) ? overlay.lassoPath as LassoPathOverlay : undefined;
    drawLassoPath(context, path, document, viewport, style, bounds, overlay.color ?? pathValue?.color);
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

/** The cells a document invalidation says changed; undefined when unknown. */
function atlasChangedCells(invalidation: Invalidation, document: PatternDocument): ArrayLike<number> | undefined {
  if (invalidation.cellIndices !== undefined) return invalidation.cellIndices;
  const rect = invalidation.cellRect;
  if (invalidation.full || !rect || rect.width * rect.height > document.width * document.height / 4) return undefined;
  const cells: number[] = [];
  const left = Math.max(0, Math.floor(rect.x));
  const top = Math.max(0, Math.floor(rect.y));
  const right = Math.min(document.width, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(document.height, Math.ceil(rect.y + rect.height));
  for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) cells.push(y * document.width + x);
  return cells;
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
    const changedCells = atlasChangedCells(request, document);
    const cellCount = document.width * document.height;
    this.atlas.invalidate(changedCells, cellCount);
    this.symbolAtlas.invalidate(changedCells, cellCount);
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
    const previous = this.overlay.canvasEditing?.workspace;
    const next = overlay.canvasEditing?.workspace;
    this.overlay = overlay;
    const request: Invalidation = invalidation ? setterInvalidation(invalidation, 'overlay') : { layer: 'overlay', full: true };
    this.invalidate(request);
    // The ghost grid lives in the base target, so entering or leaving canvas
    // editing, or a moved workspace, repaints the base as well.
    const sameWorkspace = previous === next || (previous !== undefined && next !== undefined
      && previous.x === next.x && previous.y === next.y && previous.width === next.width && previous.height === next.height);
    if (!sameWorkspace) this.invalidate('base');
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
    const patternBackground = patternBackgroundColor(this.document);
    const cellInvalidationRect = invalidation.cellRect ? cellToScreenRect(invalidation.cellRect, this.viewport) : undefined;
    const rawInvalidationRect = unionRect(invalidation.rect, cellInvalidationRect);
    const invalidationRect = rawInvalidationRect ? expandDirtyRect(rawInvalidationRect, this.metrics.dpr) : undefined;
    const partial = !fullInvalidation && lod !== RenderLod.Overview && invalidationRect !== undefined && clipToRect(context, invalidationRect);
    const fillArea = partial ? invalidationRect : { x: 0, y: 0, width: this.metrics.cssWidth, height: this.metrics.cssHeight };
    if (!partial) clearTarget(target, this.metrics);
    else context.clearRect(invalidationRect.x, invalidationRect.y, invalidationRect.width, invalidationRect.height);
    // Everything that is not canvas (outside the box, and holes) is off-canvas;
    // the workspace's ghost grid sits on it, under the fabric.
    context.fillStyle = this.style.offCanvasColor;
    context.globalAlpha = 1;
    context.fillRect(fillArea.x, fillArea.y, fillArea.width, fillArea.height);
    const workspace = this.overlay.canvasEditing?.workspace;
    if (workspace) drawGhostGrid(context, workspace, this.viewport, this.metrics, this.style, lod);
    // The overview atlas carries a masked canvas's fabric, so walking its cells here is left to the fallbacks.
    if (lod !== RenderLod.Overview || this.document.canvasMask === undefined) {
      fillCanvasFabric(context, this.document, this.viewport, this.metrics, fillArea, patternBackground);
    }
    // Move-image mode dims the committed pattern so the reference image reads
    // on top; the reference image itself keeps its configured opacity.
    const dimAlpha = this.patternDimmed ? 0.5 : 1;
    if (lod === RenderLod.Overview) {
      if (dimAlpha < 1) save(context);
      if (dimAlpha < 1) setAlpha(context, dimAlpha);
      const cells = this.drawOverviewCells(context);
      const visible = visibleCellRect(this.viewport, this.metrics, this.document);
      drawGrid(context, this.document, this.viewport, this.metrics, this.style, visible, lod);
      drawChartBorder(context, this.document, this.viewport, this.metrics, this.style);
      const drawnBackstitches = drawBackstitches(context, this.document, this.viewport, this.metrics, this.style, undefined, dimAlpha);
      if (dimAlpha < 1) restore(context);
      drawTraceImage(context, this.traceImage, this.document, this.viewport, this.metrics);
      return { ...cells, drawnBackstitches };
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
        if (drawCell(context, this.document, x, y, this.style, this.viewport, lod, dimAlpha, this.metrics.dpr)) drawnCells += 1;
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

  /** Draw the Overview cells from the cached atlas when the adapter can, else
   * cell by cell; the caller draws the grid, border, and backstitches over them. */
  private drawOverviewCells(context: CanvasContextAdapter): { visitedCells: number; drawnCells: number } {
    if (this.style.mode === ChartPresentationMode.Symbol) {
      const symbolAtlas = this.symbolAtlas.get(this.document, this.style, this.atlasFactory);
      const canDrawCachedSymbols = Boolean(
        symbolAtlas.source &&
        context.drawImage &&
        isCanvasImageSource(symbolAtlas.source)
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
        if (drawnFromAtlas) return { visitedCells: 0, drawnCells: 0 };
      }
      this.fillMaskedOverviewFabric(context);
      return drawOverviewSymbolFallback(context, this.document, this.viewport, this.metrics, this.style);
    }
    context.imageSmoothingEnabled = false;
    const atlas = this.atlas.get(this.document, this.style, this.atlasFactory);
    if (atlas.source && context.drawImage && isCanvasImageSource(atlas.source)) {
      drawImage(context, atlas.source, atlas.width, atlas.height, -this.viewport.x * this.viewport.zoom, -this.viewport.y * this.viewport.zoom, this.document.width * this.viewport.zoom, this.document.height * this.viewport.zoom);
      return { visitedCells: 0, drawnCells: 0 };
    }
    this.fillMaskedOverviewFabric(context);
    return drawOverviewFallback(context, this.document, this.viewport, this.metrics, this.style);
  }

  /** Without an atlas, a masked canvas's fabric is filled run by run like the other levels of detail. */
  private fillMaskedOverviewFabric(context: CanvasContextAdapter): void {
    if (this.document.canvasMask === undefined) return;
    const screen = { x: 0, y: 0, width: this.metrics.cssWidth, height: this.metrics.cssHeight };
    fillCanvasFabric(context, this.document, this.viewport, this.metrics, screen, patternBackgroundColor(this.document));
  }

  private renderOverlay(fullInvalidation: boolean, invalidation: CoalescedInvalidation, lod: RenderLod): void {
    const target = this.options.targets.overlay;
    prepareTarget(target, this.metrics);
    const rawDirtyRect = !fullInvalidation
      ? unionRect(invalidation.rect, invalidation.cellRect ? cellToScreenRect(invalidation.cellRect, this.viewport) : undefined)
      : undefined;
    const dirtyRect = rawDirtyRect ? expandDirtyRect(rawDirtyRect, this.metrics.dpr) : undefined;
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
