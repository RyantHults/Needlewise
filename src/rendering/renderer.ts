import {
  CellKind,
  colorComponentMask,
  componentKind,
  componentSlotMask,
  forEachActiveRun,
  isLegacyQuarterKind,
  isThreeQuarterKind,
  isThreeQuarterPairKind,
  type PatternDocument
} from '../domain';
import {
  CHART_EDGE_MARGIN,
  ChartPresentationMode,
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
  type AtlasTargetFactory,
  type Invalidation,
  type InvalidationLayer,
  type LassoPathOverlay,
  type LassoPreviewOverlay,
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
import { intersectRect } from '../editor/rect';
import {
  ColorAtlasCache,
  SymbolAtlasCache,
  isCanvasImageSource,
  overviewColorForPaletteId,
  paintOverviewCell,
  patternBackgroundColor
} from './atlas';
import { clearTarget, clipToRect, createDefaultAtlasTarget, drawImage, prepareTarget, rectPath, restore, save } from './context';
import { compositeHexColor, grayscaleColor, paletteColor } from './colors';
import { contrastSymbolInk, isDarkColor, relativeLuminance } from './contrast';
import { drawPaletteSymbol, drawStitchGeometry } from './symbol-painter';
import { readRendererColors, subscribeThemeChange, type RendererColors } from './theme-colors';
import {
  createThreadSpriteCache,
  drawThreadBackstitch,
  drawThreadFabric,
  drawThreadStitch,
  THREAD_MIN_DETAIL_CELL_PX,
  type ThreadSpriteCache
} from './thread-preview';
import targetSvg from '../assets/ui-icons/target.svg?raw';
import { createTraceImageProjection, drawTraceImage } from './trace';
import { selectionBoundarySegments } from '../editor/lasso';

const EMPTY_STATS: RenderStats = {
  lod: RenderLod.Overview,
  visitedCells: 0,
  drawnCells: 0,
  drawnBackstitches: 0,
  baseRendered: false,
  overlayRendered: false
};

/** Caller settings win over the theme's colours, which win over the defaults. */
function mergeStyle(theme: RendererColors, style: Partial<RendererStyle>): RendererStyle {
  return { ...DEFAULT_RENDERER_STYLE, ...theme, ...style };
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

function defaultFrameRequest(callback: (time: number) => void): number {
  if (typeof globalThis.requestAnimationFrame === 'function') return globalThis.requestAnimationFrame(callback);
  return setTimeout(() => callback(Date.now()), 0) as unknown as number;
}

function defaultFrameCancel(handle: number): void {
  if (typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(handle);
  else clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
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

/** Run `paint` at `alpha`, opening a scope only when that is below the `ambient` alpha already set. */
function withAlpha<T>(context: CanvasContextAdapter, alpha: number, ambient: number, paint: () => T): T {
  if (alpha >= ambient) return paint();
  save(context);
  try {
    setAlpha(context, alpha);
    return paint();
  } finally {
    restore(context);
  }
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

/** The quarter of `rect` that slot `slot` marks: 0 top-left, then clockwise. */
function slotQuadrant(rect: Rect, slot: number): Rect {
  return {
    x: rect.x + (slot === 1 || slot === 2 ? rect.width / 2 : 0),
    y: rect.y + (slot === 2 || slot === 3 ? rect.height / 2 : 0),
    width: rect.width / 2,
    height: rect.height / 2
  };
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

function snapRectToDevicePixels(rect: Rect, pixelRatio: number): Rect {
  const x0 = snapToDevicePixel(rect.x, pixelRatio);
  const x1 = snapToDevicePixel(rect.x + rect.width, pixelRatio);
  const y0 = snapToDevicePixel(rect.y, pixelRatio);
  const y1 = snapToDevicePixel(rect.y + rect.height, pixelRatio);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Alpha for stitches outside the highlighted color; the highlighted color and an unset highlight stay opaque. */
const HIGHLIGHT_DIM_ALPHA = 0.25;
/** Combined mode draws full-size symbols from this many CSS px per cell, below Detail LOD (half-size slotted ones wait for Detail). */
const COMBINED_SYMBOL_MIN_CELL_PX = 8;

function highlightAlpha(style: RendererStyle, id: number): number {
  return style.highlightColor === null || id === style.highlightColor ? 1 : HIGHLIGHT_DIM_ALPHA;
}

/** Below this many CSS px per cell the highlight outline is noise, so it is not drawn. */
const HIGHLIGHT_OUTLINE_MIN_CELL_PX = 4;
/** Highlight outline strokes in CSS px, independent of zoom: a light halo under a dark core. */
const HIGHLIGHT_HALO_WIDTH = 3;
const HIGHLIGHT_OUTLINE_WIDTH = 1.25;

/** Whether a cell on the canvas holds the highlighted color in any component; off-chart counts as out. */
function holdsHighlight(document: PatternDocument, x: number, y: number, color: number): boolean {
  if (x < 0 || y < 0 || x >= document.width || y >= document.height) return false;
  const index = y * document.width + x;
  if (document.canvasMask !== undefined && document.canvasMask[index] !== 1) return false;
  return colorComponentMask(document, index, color) !== 0;
}

/**
 * Trace the boundary of every connected group of the highlighted color within
 * `cells`: the cell edges between a cell that holds the color and one that does
 * not, merged into straight runs, so cells inside a group get no lines.
 */
function drawHighlightOutline(context: CanvasContextAdapter, document: PatternDocument, viewport: Viewport, style: RendererStyle, cells: CellRect): void {
  const color = style.highlightColor;
  if (color === null) return;
  const left = Math.max(0, cells.x);
  const top = Math.max(0, cells.y);
  const right = Math.min(document.width, cells.x + cells.width);
  const bottom = Math.min(document.height, cells.y + cells.height);
  if (right <= left || bottom <= top) return;
  const segments: Array<readonly [number, number, number, number]> = [];
  // Horizontal edges on grid lines top..bottom, then vertical edges on left..right.
  for (let line = top; line <= bottom; line += 1) {
    let start: number | undefined;
    for (let x = left; x <= right; x += 1) {
      const edge = x < right && holdsHighlight(document, x, line - 1, color) !== holdsHighlight(document, x, line, color);
      if (edge && start === undefined) start = x;
      if (!edge && start !== undefined) {
        segments.push([start, line, x, line]);
        start = undefined;
      }
    }
  }
  for (let line = left; line <= right; line += 1) {
    let start: number | undefined;
    for (let y = top; y <= bottom; y += 1) {
      const edge = y < bottom && holdsHighlight(document, line - 1, y, color) !== holdsHighlight(document, line, y, color);
      if (edge && start === undefined) start = y;
      if (!edge && start !== undefined) {
        segments.push([line, start, line, y]);
        start = undefined;
      }
    }
  }
  if (segments.length === 0) return;
  const toScreen = (value: number, origin: number): number => (value - origin) * viewport.zoom;
  save(context);
  setAlpha(context, 1);
  // Square caps close the corner where a horizontal and a vertical run meet.
  context.lineCap = 'square';
  for (const [strokeStyle, lineWidth] of [[style.highlightHaloColor, HIGHLIGHT_HALO_WIDTH], [style.highlightOutlineColor, HIGHLIGHT_OUTLINE_WIDTH]] as const) {
    context.strokeStyle = strokeStyle;
    context.lineWidth = lineWidth;
    context.beginPath();
    for (const [x1, y1, x2, y2] of segments) {
      context.moveTo(toScreen(x1, viewport.x), toScreen(y1, viewport.y));
      context.lineTo(toScreen(x2, viewport.x), toScreen(y2, viewport.y));
    }
    context.stroke();
  }
  restore(context);
}

/** Completion bits as the style shows them: none at all unless `showCompletion` is on. */
function shownCompletion(style: RendererStyle, completed: number): number {
  return style.showCompletion ? completed : 0;
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
  completed = shownCompletion(style, completed);
  // Snap the start and end edges independently (not the width) so neighbouring
  // cells tile with no gap or overlap, and so every shape, seam and mark in the
  // cell shares the same device-pixel rect.
  const rect = snapRectToDevicePixels(cellToScreenRect({ x, y, width: 1, height: 1 }, viewport), pixelRatio);
  const symbolMode = style.mode === ChartPresentationMode.Symbol;
  const paintShape = (id: number, completed: boolean, slot?: number, geometryKind = kind): void => {
    save(context);
    context.fillStyle = symbolMode ? style.symbolBackgroundColor : styleColor(document, id, style);
    setAlpha(context, (completed ? style.completedOpacity : 1) * dimAlpha * highlightAlpha(style, id));
    drawStitchGeometry(context, geometryKind, rect, slot);
    restore(context);
  };
  const paintMarks = (id: number, completed: boolean, slot?: number): void => {
    const markAlpha = dimAlpha * highlightAlpha(style, id);
    // Symbols draw at the ambient alpha, so a dimmed color needs its own scope.
    withAlpha(context, markAlpha, dimAlpha, () => {
      const combinedSymbol = slot === undefined && viewport.zoom >= COMBINED_SYMBOL_MIN_CELL_PX;
      if (lod === RenderLod.Detail || symbolMode || combinedSymbol) drawSymbol(context, document, id, rect, style, slot);
      // A mark line is sub-pixel at Overview zoom, where the fill's fade alone shows completion.
      if (completed && lod !== RenderLod.Overview) completedMark(context, slot === undefined ? rect : slotQuadrant(rect, slot), style, markAlpha);
    });
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
    const mask = componentSlotMask(kind, colors, 0);
    for (let slot = 0; slot < 4; slot += 1) {
      if ((mask & (1 << slot)) !== 0) paintShape(colors[slot], (completed & (1 << slot)) !== 0, slot, componentKind(kind, slot));
    }
    // The seam keeps two same-colored three-quarters from reading as one full stitch. It sits above
    // the fills and below the symbols and completion marks.
    if (mask !== 0 && lod !== RenderLod.Overview) {
      const firstSlot = 31 - Math.clz32(mask & -mask);
      const firstId = colors[firstSlot];
      const backslashSeam = firstSlot === 0;
      save(context);
      context.strokeStyle = contrastSymbolInk(
        symbolMode ? style.symbolBackgroundColor : styleColor(document, firstId, style),
        style.symbolColor
      );
      context.lineWidth = Math.max(1, Math.min(2, viewport.zoom * 0.06));
      setAlpha(context, ((completed & (1 << firstSlot)) !== 0 ? style.completedOpacity : 1) * dimAlpha * highlightAlpha(style, firstId));
      linePath(
        context,
        backslashSeam ? { x: rect.x + rect.width, y: rect.y } : { x: rect.x, y: rect.y },
        backslashSeam ? { x: rect.x, y: rect.y + rect.height } : { x: rect.x + rect.width, y: rect.y + rect.height }
      );
      restore(context);
    }
    for (let slot = 0; slot < 4; slot += 1) {
      if ((mask & (1 << slot)) !== 0) paintMarks(colors[slot], (completed & (1 << slot)) !== 0, slot);
    }
  } else {
    fill(colors[0] ?? 0, (completed & 1) !== 0);
  }
  return true;
}

/**
 * Thread view of one cell: kinds and palette colors only. Completion bits are
 * never read here, so this path cannot draw them.
 */
function drawThreadCell(
  context: CanvasContextAdapter,
  document: PatternDocument,
  x: number,
  y: number,
  style: RendererStyle,
  viewport: Viewport,
  sprites: ThreadSpriteCache,
  dimAlpha = 1
): boolean {
  const index = y * document.width + x;
  const kind = document.kind[index];
  if (kind === CellKind.Empty) return false;
  const colors = document.colors.subarray(index * 4, index * 4 + 4);
  const rect = cellToScreenRect({ x, y, width: 1, height: 1 }, viewport);
  const stitch = (id: number, stitchKind: number, slot: number): void => {
    if (id === 0) return;
    const color = styleColor(document, id, style);
    withAlpha(context, dimAlpha * highlightAlpha(style, id), dimAlpha, () => {
      if (!sprites.draw(context, color, stitchKind, rect, slot)) drawThreadStitch(context, stitchKind, rect, color, slot);
    });
  };
  if (isLegacyQuarterKind(kind)) {
    for (let slot = 0; slot < 4; slot += 1) stitch(colors[slot] ?? 0, kind, slot);
  } else if (isThreeQuarterPairKind(kind)) {
    const mask = componentSlotMask(kind, colors, 0);
    for (let slot = 0; slot < 4; slot += 1) if ((mask & (1 << slot)) !== 0) stitch(colors[slot], componentKind(kind, slot), slot);
  } else {
    stitch(colors[0] ?? 0, kind, 0);
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

type CellTone = 'absent' | 'fabric' | 'light' | 'dark' | 'mixed';

/** 'light' when every stitch beside a grid edge is light, 'dark' when every one is dark, otherwise undefined (theme colors). */
type EdgeContrast = 'light' | 'dark' | undefined;

/** One grid tier's theme color and its variants for lines between light and between dark stitches. */
interface GridTierColors {
  readonly theme: string;
  readonly betweenLight: string;
  readonly betweenDark: string;
}

function gridTierColor(colors: GridTierColors, contrast: EdgeContrast): string {
  if (contrast === 'light') return colors.betweenLight;
  if (contrast === 'dark') return colors.betweenDark;
  return colors.theme;
}

/** Same threshold as the symbol ink, so a cell that gets white ink also gets the light grid. */
function colorsTone(colors: readonly string[]): 'light' | 'dark' | 'mixed' {
  let dark = 0;
  for (const color of colors) {
    const isDark = isDarkColor(color);
    if (isDark === undefined) return 'mixed';
    if (isDark) dark += 1;
  }
  if (dark === colors.length) return 'dark';
  return dark === 0 ? 'light' : 'mixed';
}

/**
 * Build the edge contrast lookup for one draw call: given the two cells a grid
 * edge separates, whether the stitches on both sides are all light or all
 * dark. Undefined in Symbol mode, where every cell shows the symbol background.
 * `pending` cell states stand in for the document cells they cover.
 */
function gridEdgeContrast(
  document: PatternDocument,
  style: RendererStyle,
  pending?: ReadonlyMap<number, PendingCellState>
): ((ax: number, ay: number, bx: number, by: number) => EdgeContrast) | undefined {
  if (style.mode === ChartPresentationMode.Symbol) return undefined;
  const fabricTone = colorsTone([patternBackgroundColor(document)]);
  const mask = document.canvasMask;
  // Full cells are most of a chart, so their tone is cached by palette id and completion.
  const fullTones = new Map<number, CellTone>();
  const cellTone = (x: number, y: number): CellTone => {
    if (x < 0 || y < 0 || x >= document.width || y >= document.height) return 'absent';
    const index = y * document.width + x;
    if (mask !== undefined && mask[index] !== 1) return 'absent';
    const state = pending?.get(index);
    const kind = state ? state.kind : document.kind[index];
    if (kind === CellKind.Empty) return 'fabric';
    const completed = state ? state.completed : document.completed[index];
    if (kind === CellKind.Full) {
      const id = state ? state.colors[0] : document.colors[index * 4];
      const key = id * 2 + (completed & 1);
      let tone = fullTones.get(key);
      if (tone === undefined) {
        tone = colorsTone(cellStateColors(document, kind, [id, 0, 0, 0], completed & 1, style));
        fullTones.set(key, tone);
      }
      return tone;
    }
    const colors = state ? state.colors : document.colors.subarray(index * 4, index * 4 + 4);
    return colorsTone(cellStateColors(document, kind, colors, completed, style));
  };
  return (ax, ay, bx, by) => {
    const first = cellTone(ax, ay);
    const second = cellTone(bx, by);
    const stitched = (tone: CellTone): boolean => tone !== 'absent' && tone !== 'fabric';
    if (!stitched(first) && !stitched(second)) return undefined;
    const a = first === 'fabric' ? fabricTone : first;
    const b = second === 'fabric' ? fabricTone : second;
    if (a === 'mixed' || b === 'mixed') return undefined;
    if (a === 'absent') return b === 'absent' ? undefined : b;
    if (b === 'absent') return a;
    return a === b ? a : undefined;
  };
}

/**
 * Stroke [from, to) of one grid line as maximal runs of one color, so a line
 * whose edges all resolve alike is still a single stroke.
 */
function strokeGridRuns(
  from: number,
  to: number,
  colorAt: ((position: number) => string) | undefined,
  theme: string,
  stroke: (from: number, to: number, color: string) => void
): void {
  if (colorAt === undefined) {
    stroke(from, to, theme);
    return;
  }
  let runStart = from;
  let runColor = colorAt(from);
  for (let position = from + 1; position < to; position += 1) {
    const color = colorAt(position);
    if (color === runColor) continue;
    stroke(runStart, position, runColor);
    runStart = position;
    runColor = color;
  }
  stroke(runStart, to, runColor);
}

function patternCanvasRect(
  document: PatternDocument,
  viewport: Viewport,
  metrics: CanvasMetrics
): Rect | undefined {
  return intersectRect(
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
    const box = intersectRect(cellToScreenRect({ x: 0, y: 0, width: document.width, height: document.height }, viewport), area);
    if (box) context.fillRect(box.x, box.y, box.width, box.height);
    return;
  }
  const cells = intersectRect(visibleCellRect(viewport, metrics, document), screenRectToCellRect(area, viewport));
  if (!cells) return;
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

/**
 * Above the fit zoom, each grid tier appears once a cell is at least this many
 * CSS px on screen, independent of the render LOD.
 */
const MAJOR_GRID_CELL_PX = 3;
const MID_GRID_CELL_PX = 8;
const MINOR_GRID_CELL_PX = 16;
/** Width in CSS px of the 10-cell lines while zoomed out below the 5-cell breakpoint. */
const MAJOR_GRID_ZOOMED_OUT_WIDTH = 1;

function minorGridWidth(lod: RenderLod): number {
  return lod === RenderLod.Detail ? 0.35 : 0.65;
}

function majorGridWidth(lod: RenderLod): number {
  return lod === RenderLod.Detail ? 1.9 : 1.7;
}

function tierMajorWidth(lod: RenderLod, tiers: GridTiers): number {
  return tiers.belowMidBreakpoint ? MAJOR_GRID_ZOOMED_OUT_WIDTH : majorGridWidth(lod);
}

function midGridWidth(lod: RenderLod): number {
  return (minorGridWidth(lod) + majorGridWidth(lod)) / 2;
}

interface GridTiers {
  major: boolean;
  mid: boolean;
  minor: boolean;
  /** Zoom is under the 5-cell breakpoint, whether or not that tier shows. */
  belowMidBreakpoint: boolean;
  majorInterval: number;
  midInterval: number;
}

/** A configured grid interval in whole cells, or `fallback` when it is not a number. */
function gridInterval(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

/** Which grid tiers show at this zoom: none at or below fit, then by on-screen cell size. Every grid caller goes through this. */
function gridTierVisibility(
  document: PatternDocument,
  viewport: Viewport,
  metrics: CanvasMetrics,
  style: RendererStyle
): GridTiers {
  const majorInterval = gridInterval(style.gridInterval, 1);
  const midInterval = gridInterval(style.midGridInterval, 5);
  if (!style.showGrid) return { major: false, mid: false, minor: false, belowMidBreakpoint: false, majorInterval, midInterval };
  const zoom = viewport.zoom > 0 && Number.isFinite(viewport.zoom) ? viewport.zoom : 1;
  const pastFit = zoom > fitViewport(document, metrics, CHART_EDGE_MARGIN).zoom;
  const tier = (cellPx: number): boolean => pastFit && zoom >= cellPx;
  return {
    major: tier(MAJOR_GRID_CELL_PX),
    // An interval of 1 is identical to the per-stitch grid.
    mid: midInterval > 1 && tier(MID_GRID_CELL_PX),
    minor: tier(MINOR_GRID_CELL_PX),
    belowMidBreakpoint: zoom < MID_GRID_CELL_PX,
    majorInterval,
    midInterval
  };
}

function gridTierColors(style: RendererStyle): { minor: GridTierColors; mid: GridTierColors; major: GridTierColors } {
  return {
    minor: { theme: style.gridColor, betweenLight: style.lightStitchGridColor, betweenDark: style.darkStitchGridColor },
    mid: { theme: style.midGridColor, betweenLight: style.lightStitchMidGridColor, betweenDark: style.darkStitchMidGridColor },
    major: { theme: style.majorGridColor, betweenLight: style.lightStitchMajorGridColor, betweenDark: style.darkStitchMajorGridColor }
  };
}

interface GridTier {
  readonly colors: GridTierColors;
  readonly width: number;
}

/**
 * Look up the strongest tier that is both visible and owns grid line `n` of an
 * axis `extent` cells long, if any. The 5-cell tier skips the document edges,
 * which the border owns, so a line there falls through to the next tier.
 */
function gridTierLookup(tiers: GridTiers, style: RendererStyle, lod: RenderLod): (n: number, extent: number) => GridTier | undefined {
  const colors = gridTierColors(style);
  const major = { colors: colors.major, width: tierMajorWidth(lod, tiers) };
  const mid = { colors: colors.mid, width: midGridWidth(lod) };
  const minor = { colors: colors.minor, width: minorGridWidth(lod) };
  return (n, extent) => {
    if (tiers.major && n % tiers.majorInterval === 0) return major;
    if (tiers.mid && n % tiers.midInterval === 0 && n !== 0 && n !== extent) return mid;
    if (tiers.minor) return minor;
    return undefined;
  };
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
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
  const tiers = gridTierVisibility(document, viewport, metrics, style);
  if ((!tiers.major && !tiers.mid && !tiers.minor) || visible.width === 0 || visible.height === 0) return;
  const bounds = patternCanvasRect(document, viewport, metrics);
  if (!bounds) return;
  // The per-stitch tier visits every cell line; below it only the lines of the visible coarser tiers are walked.
  const step = tiers.minor
    ? 1
    : tiers.major && tiers.mid
      ? greatestCommonDivisor(tiers.majorInterval, tiers.midInterval)
      : tiers.major
        ? tiers.majorInterval
        : tiers.midInterval;
  const viewportRect = viewportModelRect(viewport, metrics);
  const left = Math.max(0, visible.x, Math.floor(viewportRect.x));
  const right = Math.min(document.width, visible.x + visible.width, Math.ceil(viewportRect.x + viewportRect.width));
  const top = Math.max(0, visible.y, Math.floor(viewportRect.y));
  const bottom = Math.min(document.height, visible.y + visible.height, Math.ceil(viewportRect.y + viewportRect.height));
  if (right < left || bottom < top) return;
  // A masked canvas draws only the edges that border an active cell.
  const mask = document.canvasMask;
  const edges = mask === undefined ? undefined : maskEdges(mask, document.width, document.height, false);
  const contrast = gridEdgeContrast(document, style);
  const tierAt = gridTierLookup(tiers, style, lod);
  // Lines [from, to] of one axis, each spanning [spanFrom, spanTo): vertical lines run along rows, horizontal ones along columns.
  const strokeGridAxis = (
    vertical: boolean,
    from: number,
    to: number,
    spanFrom: number,
    spanTo: number,
    runs: EdgeRuns | undefined
  ): void => {
    const extent = vertical ? document.width : document.height;
    const boundsStart = vertical ? bounds.x : bounds.y;
    const boundsEnd = boundsStart + (vertical ? bounds.width : bounds.height);
    const point = (line: number, along: number): ModelPoint => (vertical ? { x: line, y: along } : { x: along, y: line });
    const last = Math.floor(to / step) * step;
    for (let line = Math.ceil(from / step) * step; line <= last; line += step) {
      const tier = tierAt(line, extent);
      if (!tier) continue;
      const screen = modelToScreen(point(line, 0), viewport);
      const position = vertical ? screen.x : screen.y;
      if (position < boundsStart || position > boundsEnd) continue;
      const stroke = (start: number, end: number, color: string): void => {
        const segment = clipSegmentToRect(
          modelToScreen(point(line, start), viewport),
          modelToScreen(point(line, end), viewport),
          bounds
        );
        if (segment) gridLine(context, segment.start, segment.end, color, tier.width);
      };
      const colorAt =
        contrast &&
        ((along: number): string =>
          gridTierColor(tier.colors, vertical ? contrast(line - 1, along, line, along) : contrast(along, line - 1, along, line)));
      const strokeLine = (start: number, end: number): void => strokeGridRuns(start, end, colorAt, tier.colors.theme, stroke);
      if (runs === undefined) strokeLine(spanFrom, spanTo);
      else forEachCachedRun(runs, line, spanFrom, spanTo, strokeLine);
    }
  };
  const clipped = clipToRect(context, bounds);
  try {
    strokeGridAxis(true, left, right, top, bottom, edges?.vertical);
    strokeGridAxis(false, top, bottom, left, right, edges?.horizontal);
  } finally {
    if (clipped) restore(context);
  }
}

/**
 * Stitch counts in the margin outside the chart: column numbers above the top
 * edge and row numbers left of the left edge, at every mid-grid interval while
 * that tier shows and every grid interval below it. While the per-stitch grid
 * shows and a label fits at every line, the lines between are numbered too,
 * smaller and fainter. The label
 * names the 1-based column or row that ends at that grid line, so "10" sits
 * over the tenth stitch. Drawn only while the grid is, and not clipped to the
 * chart, so the margin outside it is used.
 */
function drawStitchNumbers(
  context: CanvasContextAdapter,
  document: PatternDocument,
  viewport: Viewport,
  metrics: CanvasMetrics,
  style: RendererStyle
): void {
  if (context.fillText === undefined) return;
  const tiers = gridTierVisibility(document, viewport, metrics, style);
  if (!tiers.major && !tiers.mid) return;
  const zoom = viewport.zoom > 0 && Number.isFinite(viewport.zoom) ? viewport.zoom : 1;
  // The numbers follow the 5-cell tier while it shows.
  const interval = tiers.mid ? tiers.midInterval : tiers.majorInterval;
  const size = Math.min(12, Math.max(8, zoom * 0.9));
  const gap = 4;
  const origin = modelToScreen({ x: 0, y: 0 }, viewport);
  // Widest label sets the stride: skip whole intervals rather than overlap.
  const digits = String(Math.max(document.width, document.height)).length;
  const columnStride = Math.max(1, Math.ceil((digits * size * 0.6 + gap) / (interval * zoom)));
  const rowStride = Math.max(1, Math.ceil((size + gap) / (interval * zoom)));
  save(context);
  context.fillStyle = style.chartBorderColor;
  context.font = `${size}px sans-serif`;
  try {
    context.textAlign = 'center';
    context.textBaseline = 'bottom';
    for (let n = interval * columnStride; n <= document.width; n += interval * columnStride) {
      const x = origin.x + (n - 0.5) * zoom;
      if (x < 0 || x > metrics.cssWidth) continue;
      context.fillText(String(n), x, origin.y - gap);
    }
    context.textAlign = 'right';
    context.textBaseline = 'middle';
    for (let n = interval * rowStride; n <= document.height; n += interval * rowStride) {
      const y = origin.y + (n - 0.5) * zoom;
      if (y < 0 || y > metrics.cssHeight) continue;
      context.fillText(String(n), origin.x - gap, y);
    }
    if (tiers.minor) {
      // Per-stitch labels are never thinned: an axis that cannot fit them all gets none.
      const minorColumns = columnStride === 1 && digits * size * 0.6 + gap <= zoom;
      const minorRows = rowStride === 1 && size + gap <= zoom;
      if (minorColumns) {
        context.textAlign = 'center';
        context.textBaseline = 'bottom';
        for (let n = 1; n <= document.width; n += 1) {
          if (n % interval === 0) continue;
          const x = origin.x + (n - 0.5) * zoom;
          if (x < 0 || x > metrics.cssWidth) continue;
          context.fillText(String(n), x, origin.y - gap);
        }
      }
      if (minorRows) {
        context.textAlign = 'right';
        context.textBaseline = 'middle';
        for (let n = 1; n <= document.height; n += 1) {
          if (n % interval === 0) continue;
          const y = origin.y + (n - 0.5) * zoom;
          if (y < 0 || y > metrics.cssHeight) continue;
          context.fillText(String(n), origin.x - gap, y);
        }
      }
    }
  } finally {
    restore(context);
  }
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
const SELECTION_FILL = 'rgba(34, 102, 204, 0.16)';
const LASSO_PREVIEW_FILL = 'rgba(110, 110, 110, 0.28)';
const LASSO_PREVIEW_STROKE = '#7d7873';
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
  const interval = gridInterval(style.gridInterval, 1);
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
  const area = intersectRect(set.rect, {
    x: viewX,
    y: viewY,
    width: Math.ceil(view.x + view.width) - viewX,
    height: Math.ceil(view.y + view.height) - viewY
  });
  if (!area) return;
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
    rectPath(context, rect);
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
  const inner = intersectRect(from, cut);
  if (!inner) return [from];
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

type CellRun = { readonly x: number; readonly y: number; readonly width: number };

/** One rect per run, clipped to the visible bounds. */
function fillCellRuns(
  context: CanvasContextAdapter,
  runs: readonly CellRun[],
  viewport: Viewport,
  bounds: Rect,
  fillStyle: string
): void {
  if (runs.length === 0) return;
  save(context);
  context.fillStyle = fillStyle;
  for (const run of runs) {
    const topLeft = modelToScreen({ x: run.x, y: run.y }, viewport);
    const bottomRight = modelToScreen({ x: run.x + run.width, y: run.y + 1 }, viewport);
    const left = Math.max(topLeft.x, bounds.x);
    const top = Math.max(topLeft.y, bounds.y);
    const right = Math.min(bottomRight.x, bounds.x + bounds.width);
    const bottom = Math.min(bottomRight.y, bounds.y + bounds.height);
    if (right <= left || bottom <= top) continue;
    context.fillRect(left, top, right - left, bottom - top);
  }
  restore(context);
}

/** Merges consecutive indices within a row into runs, offset into model space. */
function indexRuns(indices: ArrayLike<number>, width: number, originX = 0, originY = 0): CellRun[] {
  const runs: CellRun[] = [];
  let last: { x: number; y: number; width: number } | undefined;
  for (let position = 0; position < indices.length; position += 1) {
    const index = indices[position];
    const x = index % width;
    const y = Math.floor(index / width);
    if (last && last.y === y && last.x + last.width === x) last.width += 1;
    else {
      last = { x, y, width: 1 };
      runs.push(last);
    }
  }
  return originX === 0 && originY === 0 ? runs : runs.map((run) => ({ x: run.x + originX, y: run.y + originY, width: run.width }));
}

/** Runs of set cells in a row-major mask, relative to its rect; cached per set. */
const canvasSelectionRuns = new WeakMap<CanvasCellSet, CellRun[]>();

function canvasSetRuns(set: CanvasCellSet, cells: Uint8Array): CellRun[] {
  const cached = canvasSelectionRuns.get(set);
  if (cached) return cached;
  const { width, height } = set.rect;
  const runs: CellRun[] = [];
  for (let y = 0; y < height; y += 1) {
    forEachActiveRun(cells, width, y, 0, width, (from, to) => {
      runs.push({ x: from + set.rect.x, y: y + set.rect.y, width: to - from });
    });
  }
  canvasSelectionRuns.set(set, runs);
  return runs;
}

function fillSelectionRect(context: CanvasContextAdapter, rect: CellRect, viewport: Viewport, bounds: Rect): void {
  const screenRect = intersectRect(cellToScreenRect(rect, viewport), bounds);
  if (!screenRect) return;
  save(context);
  context.fillStyle = SELECTION_FILL;
  context.fillRect(screenRect.x, screenRect.y, screenRect.width, screenRect.height);
  restore(context);
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
    fillSelectionRect(context, selection.rect, viewport, screen);
    drawSelectionRect(context, selection.rect, viewport, style, screen, selectionColor, false);
    return;
  }
  fillCellRuns(context, canvasSetRuns(selection, cells), viewport, screen, SELECTION_FILL);
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

/** Save the context and clip to the union of `cells` within `bounds`; see clipToRect. */
function clipToCells(context: CanvasContextAdapter, cells: readonly CellRect[], viewport: Viewport, bounds: Rect): boolean {
  if (!context.clip || !context.save || !context.restore) return false;
  context.save();
  context.beginPath();
  for (const cell of cells) {
    const rect = intersectRect(cellToScreenRect(cell, viewport), bounds);
    if (rect) rectPath(context, rect);
  }
  context.clip();
  return true;
}

function drawGridForCells(
  context: CanvasContextAdapter,
  document: PatternDocument,
  viewport: Viewport,
  metrics: CanvasMetrics,
  style: RendererStyle,
  cells: readonly CellRect[],
  lod: RenderLod,
  pending?: ReadonlyMap<number, PendingCellState>
): void {
  const tiers = gridTierVisibility(document, viewport, metrics, style);
  if ((!tiers.major && !tiers.mid && !tiers.minor) || cells.length === 0) return;
  const bounds = patternCanvasRect(document, viewport, metrics);
  if (!bounds) return;
  const tierAt = gridTierLookup(tiers, style, lod);
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
  const contrast = gridEdgeContrast(document, style, pending);
  // Restroke only what the cell masks covered, so lines outside them are not drawn twice.
  const clipped = clipToCells(context, cells, viewport, bounds);
  try {
    for (const { x, y } of vertical.values()) {
      const tier = tierAt(x, document.width);
      if (!tier) continue;
      const segment = clipSegmentToRect(
        modelToScreen({ x, y }, viewport),
        modelToScreen({ x, y: y + 1 }, viewport),
        bounds
      );
      const color = gridTierColor(tier.colors, contrast?.(x - 1, y, x, y));
      if (segment) gridLine(context, segment.start, segment.end, color, tier.width);
    }
    for (const { x, y } of horizontal.values()) {
      const tier = tierAt(y, document.height);
      if (!tier) continue;
      const segment = clipSegmentToRect(
        modelToScreen({ x, y }, viewport),
        modelToScreen({ x: x + 1, y }, viewport),
        bounds
      );
      const color = gridTierColor(tier.colors, contrast?.(x, y - 1, x, y));
      if (segment) gridLine(context, segment.start, segment.end, color, tier.width);
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
  dimAlpha = 1,
  hidden?: ReadonlySet<number>
): number {
  const visible = viewportModelRect(viewport, metrics);
  const store = document.backstitches;
  let drawn = 0;
  for (let index = 0; index < store.ids.length; index += 1) {
    if (hidden?.has(store.ids[index])) continue;
    const start = fixedToModel({ x: store.x1[index], y: store.y1[index] });
    const end = fixedToModel({ x: store.x2[index], y: store.y2[index] });
    if (!segmentIntersectsRect(start, end, visible)) continue;
    if (dirtyModelRect && !segmentIntersectsRect(start, end, dirtyModelRect)) continue;
    drawBackstitchSegment(context, document, viewport, style, start, end, store.colors[index], store.completed[index] === 1, dimAlpha);
    drawn += 1;
  }
  return drawn;
}

/** Thread view of the backstitches: the same segments as `drawBackstitches`, drawn as round-capped thread. */
function drawThreadBackstitches(
  context: CanvasContextAdapter,
  document: PatternDocument,
  viewport: Viewport,
  metrics: CanvasMetrics,
  style: RendererStyle,
  dirtyModelRect?: Rect,
  dimAlpha = 1,
  hidden?: ReadonlySet<number>
): number {
  const visible = viewportModelRect(viewport, metrics);
  const store = document.backstitches;
  const origin = modelToScreen({ x: 0, y: 0 }, viewport);
  let drawn = 0;
  for (let index = 0; index < store.ids.length; index += 1) {
    if (hidden?.has(store.ids[index])) continue;
    const start = fixedToModel({ x: store.x1[index], y: store.y1[index] });
    const end = fixedToModel({ x: store.x2[index], y: store.y2[index] });
    if (!segmentIntersectsRect(start, end, visible)) continue;
    if (dirtyModelRect && !segmentIntersectsRect(start, end, dirtyModelRect)) continue;
    withAlpha(context, dimAlpha * highlightAlpha(style, store.colors[index]), dimAlpha, () => {
      drawThreadBackstitch(context, start, end, viewport.zoom, styleColor(document, store.colors[index], style), origin);
    });
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
  setAlpha(context, (completed && style.showCompletion ? style.completedOpacity : 1) * dimAlpha * highlightAlpha(style, colorId));
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
  bounds: Rect,
  hidden?: ReadonlySet<number>
): void {
  if (cells.length === 0) return;
  const visible = viewportModelRect(viewport, metrics);
  const store = document.backstitches;
  // Segments clear of every cell's bounding rect skip all per-cell work.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const cell of cells) {
    minX = Math.min(minX, cell.x);
    minY = Math.min(minY, cell.y);
    maxX = Math.max(maxX, cell.x + cell.width);
    maxY = Math.max(maxY, cell.y + cell.height);
  }
  const cellsBounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  // With unit cells a segment looks up only the cells under its own bounding box.
  const unitCells = cells.every((cell) => cell.width === 1 && cell.height === 1)
    ? new Map(cells.map((cell) => [cell.y * document.width + cell.x, cell]))
    : undefined;
  for (let index = 0; index < store.ids.length; index += 1) {
    if (hidden?.has(store.ids[index])) continue;
    const start = fixedToModel({ x: store.x1[index], y: store.y1[index] });
    const end = fixedToModel({ x: store.x2[index], y: store.y2[index] });
    if (!segmentIntersectsRect(start, end, visible)) continue;
    if (!segmentIntersectsRect(start, end, cellsBounds)) continue;
    let candidates: readonly CellRect[] = cells;
    if (unitCells) {
      const found: CellRect[] = [];
      const left = Math.max(0, Math.floor(Math.min(start.x, end.x)));
      const right = Math.min(document.width - 1, Math.floor(Math.max(start.x, end.x)));
      const top = Math.max(0, Math.floor(Math.min(start.y, end.y)));
      const bottom = Math.min(document.height - 1, Math.floor(Math.max(start.y, end.y)));
      for (let y = top; y <= bottom; y += 1) {
        for (let x = left; x <= right; x += 1) {
          const cell = unitCells.get(y * document.width + x);
          if (cell) found.push(cell);
        }
      }
      candidates = found;
    }
    for (const cell of candidates) {
      const cellSegment = clipSegmentToRect(start, end, cell);
      if (!cellSegment) continue;
      const cellBounds = intersectRect(cellToScreenRect(cell, viewport), bounds);
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

/** Backstitch ids the base pass leaves out: those lifted by a move and those being erased. */
function hiddenBackstitchIds(overlay: OverlayState): ReadonlySet<number> | undefined {
  const lifted = overlay.floatingPaste?.liftedBackstitchIds;
  const erasing = overlay.erasingBackstitchIds;
  if (!lifted?.size) return erasing;
  if (!erasing?.size) return lifted;
  return new Set([...lifted, ...erasing]);
}

function sameIds(left: ReadonlySet<number> | undefined, right: ReadonlySet<number> | undefined): boolean {
  if (left === right) return true;
  if ((left?.size ?? 0) !== (right?.size ?? 0)) return false;
  for (const id of left ?? []) if (!right?.has(id)) return false;
  return true;
}

/** Whole-cell bounds of the backstitches with these ids, or undefined when none exist. */
function backstitchCellBounds(document: PatternDocument, ...idSets: (ReadonlySet<number> | undefined)[]): CellRect | undefined {
  const store = document.backstitches;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let index = 0; index < store.ids.length; index += 1) {
    if (!idSets.some((ids) => ids?.has(store.ids[index]))) continue;
    const start = fixedToModel({ x: store.x1[index], y: store.y1[index] });
    const end = fixedToModel({ x: store.x2[index], y: store.y2[index] });
    minX = Math.min(minX, start.x, end.x);
    minY = Math.min(minY, start.y, end.y);
    maxX = Math.max(maxX, start.x, end.x);
    maxY = Math.max(maxY, start.y, end.y);
  }
  if (minX > maxX) return undefined;
  const x = Math.floor(minX);
  const y = Math.floor(minY);
  return { x, y, width: Math.max(1, Math.ceil(maxX) - x), height: Math.max(1, Math.ceil(maxY) - y) };
}

function growCellRect(rect: CellRect, cells: number): CellRect {
  return cells === 0 ? rect : { x: rect.x - cells, y: rect.y - cells, width: rect.width + cells * 2, height: rect.height + cells * 2 };
}

function growRect(rect: Rect, amount: number): Rect {
  return { x: rect.x - amount, y: rect.y - amount, width: rect.width + amount * 2, height: rect.height + amount * 2 };
}

function screenRectToCellRect(rect: Rect, viewport: Viewport): CellRect {
  const zoom = viewport.zoom > 0 ? viewport.zoom : 1;
  const x = Math.floor(viewport.x + rect.x / zoom);
  const y = Math.floor(viewport.y + rect.y / zoom);
  const right = Math.ceil(viewport.x + (rect.x + rect.width) / zoom);
  const bottom = Math.ceil(viewport.y + (rect.y + rect.height) / zoom);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function drawOverviewFallback(
  context: CanvasContextAdapter,
  document: PatternDocument,
  viewport: Viewport,
  metrics: CanvasMetrics,
  style: RendererStyle,
  dimAlpha = 1
): { visitedCells: number; drawnCells: number } {
  const visible = visibleCellRect(viewport, metrics, document);
  let drawnCells = 0;
  // The color atlas cannot dim by color, so a highlight reaches the Overview through this path.
  const fill = (id: number, completed: boolean): void => {
    context.fillStyle = overviewColorForPaletteId(document, id, completed, style);
    if (style.highlightColor !== null) setAlpha(context, dimAlpha * highlightAlpha(style, id));
  };
  for (let y = visible.y; y < visible.y + visible.height; y += 1) {
    for (let x = visible.x; x < visible.x + visible.width; x += 1) {
      const index = y * document.width + x;
      if (document.kind[index] === CellKind.Empty) continue;
      const rect = snapRectToDevicePixels(cellToScreenRect({ x, y, width: 1, height: 1 }, viewport), metrics.dpr);
      paintOverviewCell(context, document.kind[index], document.colors, index * 4, document.completed[index], rect, fill);
      drawnCells += 1;
    }
  }
  if (style.highlightColor !== null) setAlpha(context, dimAlpha);
  return { visitedCells: visible.width * visible.height, drawnCells };
}

function drawOverviewSymbolFallback(
  context: CanvasContextAdapter,
  document: PatternDocument,
  viewport: Viewport,
  metrics: CanvasMetrics,
  style: RendererStyle,
  dimAlpha = 1
): { visitedCells: number; drawnCells: number } {
  const visible = visibleCellRect(viewport, metrics, document);
  let drawnCells = 0;
  for (let y = visible.y; y < visible.y + visible.height; y += 1) {
    for (let x = visible.x; x < visible.x + visible.width; x += 1) {
      if (drawCell(context, document, x, y, style, viewport, RenderLod.Overview, dimAlpha, metrics.dpr)) drawnCells += 1;
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
  color?: string,
  start?: ModelPoint,
  closable?: boolean,
  preview?: LassoPreviewOverlay,
  anchors?: readonly ModelPoint[]
): void {
  const hasPath = points !== undefined && points.length >= 2;
  if (!hasPath && !start) return;
  const chart = { x: 0, y: 0, width: document.width, height: document.height };
  if (preview) drawLassoPreview(context, preview, document, viewport, style, bounds, chart);
  save(context);
  context.strokeStyle = color ?? style.selectionColor;
  context.lineWidth = style.overlayLineWidth;
  context.setLineDash?.([6, 4]);
  for (let index = 0; hasPath && index < points.length; index += 1) {
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
  if (anchors && context.arc) {
    save(context);
    context.fillStyle = color ?? style.selectionColor;
    for (let index = 1; index < anchors.length; index += 1) {
      const center = modelToScreen(anchors[index], viewport);
      if (center.x < bounds.x || center.x > bounds.x + bounds.width || center.y < bounds.y || center.y > bounds.y + bounds.height) continue;
      context.beginPath();
      context.arc(center.x, center.y, 3, 0, Math.PI * 2);
      context.fill();
    }
    restore(context);
  }
  if (start) {
    save(context);
    context.strokeStyle = color ?? style.selectionColor;
    drawLassoStartDot(context, modelToScreen(start, viewport), bounds, closable === true);
    restore(context);
  }
}

function drawLassoPreview(
  context: CanvasContextAdapter,
  preview: LassoPreviewOverlay,
  document: PatternDocument,
  viewport: Viewport,
  style: RendererStyle,
  bounds: Rect,
  chart: Rect
): void {
  fillCellRuns(context, preview.runs, viewport, bounds, LASSO_PREVIEW_FILL);
  drawSparseSelectionBoundaries(context, preview.boundaries, document, viewport, style, bounds, LASSO_PREVIEW_STROKE, 0, 0, chart);
}

function drawLassoStartDot(context: CanvasContextAdapter, center: ScreenPoint, bounds: Rect, closable: boolean): void {
  if (!context.arc) return;
  if (center.x < bounds.x || center.x > bounds.x + bounds.width || center.y < bounds.y || center.y > bounds.y + bounds.height) return;
  const selection = context.strokeStyle;
  context.setLineDash?.([]);
  context.lineWidth = 2;
  context.fillStyle = closable ? selection : '#fffdf9';
  context.beginPath();
  context.arc(center.x, center.y, closable ? 7 : 5, 0, Math.PI * 2);
  context.fill();
  context.stroke();
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
  const clipModel = intersectRect(chart, visibleModel);
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
  const clippedCellRect = intersectRect(cellRect, bounds);
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
  target: PatternDocument,
  preview: FloatingPasteOverlay | null | undefined,
  viewport: Viewport,
  metrics: CanvasMetrics,
  style: RendererStyle,
  lod: RenderLod,
  bounds: Rect,
  hidden: ReadonlySet<number> | undefined
): void {
  if (!preview) return;
  // A cross-pattern paste previews its new palette entries as if already created.
  const document = preview.pendingPalette && preview.pendingPalette.length > 0
    ? { ...target, palette: [...target.palette, ...preview.pendingPalette] }
    : target;
  const destination = preview.destination;
  const chart = { x: 0, y: 0, width: document.width, height: document.height };
  const visibleChart = intersectRect(visibleCellRect(viewport, metrics, document), chart);
  if (preview.mode === 'move' && preview.sourceSelection) {
    if (preview.sourceHole && preview.sourceHole.length > 0) {
      // Only hole cells in view, and inside the dirty bounds when partial, are drawn.
      const view = visibleChart && intersectRect(visibleChart, screenRectToCellRect(bounds, viewport));
      const states = view
        ? preview.sourceHole.filter((state) => state.cell.x >= view.x && state.cell.x < view.x + view.width && state.cell.y >= view.y && state.cell.y < view.y + view.height)
        : [];
      const holeCells = drawPendingCellStates(context, document, states, viewport, style, lod, bounds, metrics.dpr);
      const holeStates = new Map<number, PendingCellState>();
      for (const state of states) holeStates.set(state.index, state);
      drawGridForCells(context, document, viewport, metrics, style, holeCells, lod, holeStates);
      drawBackstitchesForCells(context, document, viewport, metrics, style, holeCells, lod, bounds, hidden);
    }
    drawFloatingSelectionContour(context, document, preview.sourceSelection, preview.sourceSelection.rect.x, preview.sourceSelection.rect.y, viewport, style, bounds, style.cursorColor, false);
  }
  const visibleDestination = visibleChart && intersectRect(destination, visibleChart);
  if (visibleDestination) {
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
        const clipped = intersectRect(targetRect, bounds);
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

  if (lod !== RenderLod.Overview && visibleDestination) {
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

/** The colors one cell state shows: its painted slots, composited when completed, plus any exposed pattern background. */
function cellStateColors(
  document: PatternDocument,
  kind: number,
  colors: ArrayLike<number>,
  completed: number,
  style: RendererStyle
): string[] {
  const patternBackground = patternBackgroundColor(document);
  if (kind === CellKind.Empty) return [patternBackground];
  completed = shownCompletion(style, completed);

  const mask = componentSlotMask(kind, colors, 0);
  const visible: string[] = [];
  for (let slot = 0; slot < 4; slot += 1) {
    if ((mask & (1 << slot)) === 0) continue;
    const paletteId = colors[slot];
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

// Pick the brush-preview outline ink for the colors a cell can expose at once.
// A single color delegates to contrastSymbolInk; several keep the best
// worst-case WCAG contrast of white vs `darkInk` across all of them.
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

// What shows under the hover outline: the committed cell's colors, or the
// pattern background for cells past the chart edge.
function visibleCellColors(document: PatternDocument, x: number, y: number, style: RendererStyle): string[] {
  if (x < 0 || y < 0 || x >= document.width || y >= document.height) return [patternBackgroundColor(document)];
  const index = y * document.width + x;
  const offset = index * 4;
  return cellStateColors(document, document.kind[index], document.colors.subarray(offset, offset + 4), document.completed[index], style);
}

function drawBrushPreview(
  context: CanvasContextAdapter,
  document: PatternDocument,
  preview: OverlayState['brushPreview'],
  viewport: Viewport,
  style: RendererStyle,
  bounds: Rect
): void {
  if (!preview?.cells.length) return;
  const cells = new Set<string>();
  for (const cell of preview.cells) cells.add(`${Math.floor(cell.x)},${Math.floor(cell.y)}`);
  save(context);
  setAlpha(context, 1);
  const strokeWidth = Math.max(0.75, Math.min(1.5, viewport.zoom * 0.06));

  // Each outer edge gets its own ink/keyline pair, judged against the colors
  // under the hovered cell and the cell across the edge. The solid, wider
  // keyline stays visible through the dashed ink's gaps.
  const strokeEdge = (from: ScreenPoint, to: ScreenPoint, hoveredColors: readonly string[], neighborColors: readonly string[]): void => {
    const ink = bestContrastInk([...hoveredColors, ...neighborColors], style.symbolColor);
    const keyline = ink === '#ffffff' ? style.symbolColor : '#ffffff';
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.strokeStyle = keyline;
    context.lineWidth = strokeWidth + 1;
    context.setLineDash?.([]);
    context.stroke();
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.strokeStyle = ink;
    context.lineWidth = strokeWidth;
    context.setLineDash?.([3, 2]);
    context.stroke();
  };

  for (const key of cells) {
    const [x, y] = key.split(',').map(Number);
    if (!intersectRect(cellToScreenRect({ x, y, width: 1, height: 1 }, viewport), bounds)) continue;
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
  const clippedDirtyRect = dirtyRect && area ? intersectRect(dirtyRect, area) : undefined;
  if (dirtyRect && !clippedDirtyRect) return;
  const partial = clippedDirtyRect !== undefined && clipToRect(context, clippedDirtyRect);
  if (partial) context.clearRect(clippedDirtyRect.x, clippedDirtyRect.y, clippedDirtyRect.width, clippedDirtyRect.height);
  else clearTarget({ context, width: metrics.pixelWidth, height: metrics.pixelHeight }, metrics);
  if (editing) {
    drawCanvasEditing(context, document, editing, viewport, metrics, style, screen, overlay.showSelection === false ? undefined : overlay.color ?? style.selectionColor);
  }
  if (!bounds) {
    drawBrushPreview(context, document, overlay.brushPreview, viewport, style, screen);
    if (partial) restore(context);
    return;
  }
  const patternClip = clipToRect(context, bounds);
  save(context);
  context.lineWidth = style.overlayLineWidth;
  const hidden = hiddenBackstitchIds(overlay);
  drawBackstitchPreview(context, document, overlay.backstitchPreview, viewport, style, bounds);
  drawFloatingPaste(context, document, overlay.floatingPaste, viewport, metrics, style, lod, bounds, hidden);
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
      if (sparseIndices) fillCellRuns(context, indexRuns(sparseIndices, document.width), viewport, bounds, SELECTION_FILL);
      drawSparseSelectionBoundaries(context, boundaries, document, viewport, style, bounds, overlay.color ?? sparse?.color);
    } else {
      const boundedSelection = intersectRect(selection, { x: 0, y: 0, width: document.width, height: document.height });
      const rect = boundedSelection && intersectRect(cellToScreenRect(boundedSelection, viewport), bounds);
      if (boundedSelection && rect) fillSelectionRect(context, boundedSelection, viewport, bounds);
      if (rect && context.strokeRect) context.strokeRect(rect.x, rect.y, rect.width, rect.height);
      else if (rect) {
        context.beginPath();
        rectPath(context, rect);
        context.stroke();
      }
    }
  }
  if (overlay.showSelection !== false) {
    const path = overlayLassoPoints(overlay.lassoPath);
    const pathValue = overlay.lassoPath && !Array.isArray(overlay.lassoPath) ? overlay.lassoPath as LassoPathOverlay : undefined;
    drawLassoPath(context, path, document, viewport, style, bounds, overlay.color ?? pathValue?.color, pathValue?.start, pathValue?.closable, pathValue?.preview, pathValue?.anchors);
  }
  const cursor = overlayPoint(overlay.cursor);
  if (cursor && overlay.showCursor !== false) {
    const cursorCell = { x: Math.floor(cursor.x), y: Math.floor(cursor.y) };
    if (cursorCell.x >= 0 && cursorCell.y >= 0 && cursorCell.x < document.width && cursorCell.y < document.height) {
      context.strokeStyle = overlay.color ?? style.cursorColor;
      const rect = intersectRect(cellToScreenRect({ x: cursorCell.x, y: cursorCell.y, width: 1, height: 1 }, viewport), bounds);
      if (rect) {
        if (context.strokeRect) context.strokeRect(rect.x, rect.y, rect.width, rect.height);
        else {
          context.beginPath();
          rectPath(context, rect);
          context.stroke();
        }
      }
    }
  }
  drawCenterMark(context, document, viewport, style, bounds);
  restore(context);
  if (patternClip) restore(context);
  drawBrushPreview(context, document, overlay.brushPreview, viewport, style, screen);
  if (partial) restore(context);
}

const CENTER_HALO = 'rgba(255, 255, 255, 0.85)';
const TARGET_ICON_VIEWBOX = 1024;
const TARGET_ICON_SIZE = 20;
const TARGET_ICON_GAP = 4;
const TARGET_ICON_D = /<path[^>]*\sd="([^"]+)"/.exec(targetSvg)?.[1] ?? '';
let targetIconPath: Path2D | undefined;

function targetIcon(): Path2D | undefined {
  if (typeof Path2D !== 'function' || !TARGET_ICON_D) return undefined;
  targetIconPath ??= new Path2D(TARGET_ICON_D);
  return targetIconPath;
}

function drawCenterMark(context: CanvasContextAdapter, document: PatternDocument, viewport: Viewport, style: RendererStyle, bounds: Rect): void {
  if (!style.showCenterMark || document.width <= 0 || document.height <= 0) return;
  const center = modelToScreen({ x: document.width / 2, y: document.height / 2 }, viewport);
  const inX = center.x >= bounds.x && center.x <= bounds.x + bounds.width;
  const inY = center.y >= bounds.y && center.y <= bounds.y + bounds.height;
  if (!inX && !inY) return;
  save(context);
  setAlpha(context, style.centerMarkOpacity);
  context.setLineDash?.([]);
  const path = inX && inY ? targetIcon() : undefined;
  // The lines span the pattern rect, stopping short of the icon.
  const r = path ? TARGET_ICON_SIZE / 2 + TARGET_ICON_GAP : 0;
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;
  type Segment = [number, number, number, number];
  const segments: Segment[] = [];
  if (inY) segments.push(...(path ? [[bounds.x, center.y, center.x - r, center.y], [center.x + r, center.y, right, center.y]] : [[bounds.x, center.y, right, center.y]]) as Segment[]);
  if (inX) segments.push(...(path ? [[center.x, bounds.y, center.x, center.y - r], [center.x, center.y + r, center.x, bottom]] : [[center.x, bounds.y, center.x, bottom]]) as Segment[]);
  for (const [color, width] of [[CENTER_HALO, 3], [style.centerMarkColor, 1]] as const) {
    context.strokeStyle = color;
    context.lineWidth = width;
    context.beginPath();
    for (const [x1, y1, x2, y2] of segments) {
      if (x2 - x1 <= 0 && y2 - y1 <= 0) continue;
      context.moveTo(x1, y1);
      context.lineTo(x2, y2);
    }
    context.stroke();
  }
  if (path) {
    const s = TARGET_ICON_SIZE / TARGET_ICON_VIEWBOX;
    context.translate?.(center.x, center.y);
    context.scale?.(s, s);
    context.translate?.(-TARGET_ICON_VIEWBOX / 2, -TARGET_ICON_VIEWBOX / 2);
    context.strokeStyle = CENTER_HALO;
    context.lineWidth = 3 / s;
    context.lineJoin = 'round';
    context.stroke(path);
    context.fillStyle = style.centerMarkColor;
    context.fill(path);
  }
  restore(context);
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

interface PendingPreview {
  readonly document: PatternDocument;
  /** The states applied, by cell index. */
  readonly states: ReadonlyMap<number, PendingCellState>;
  /** Every cell the preview has written, which must repaint from the document when it ends. */
  readonly touched: Set<number>;
}

export class Canvas2DRenderer implements CanvasRenderer {
  private document: PatternDocument;
  private viewport: Viewport;
  private metrics: CanvasMetrics;
  private style: RendererStyle;
  private styleSettings: Partial<RendererStyle>;
  private themeColors: RendererColors;
  private readonly unsubscribeTheme: () => void;
  private traceImage: TraceImage | undefined;
  private traceDisposer: (() => void) | undefined;
  private traceDisposed = false;
  private patternDimmed = false;
  private overlay: OverlayState;
  /** The document with the overlay's pending cell states applied, while there are any; the base pass draws it. */
  private preview: PendingPreview | undefined;
  private thresholds: LodThresholds;
  private readonly atlas = new ColorAtlasCache();
  private readonly symbolAtlas = new SymbolAtlasCache();
  private threadSprites: ThreadSpriteCache | undefined;
  private readonly atlasFactory: AtlasTargetFactory;
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
    this.styleSettings = options.style ?? {};
    this.themeColors = readRendererColors();
    this.style = mergeStyle(this.themeColors, this.styleSettings);
    this.unsubscribeTheme = subscribeThemeChange(() => this.applyTheme());
    this.traceImage = options.traceImage;
    this.traceDisposer = this.traceImage?.dispose;
    this.overlay = options.overlay ?? {};
    this.thresholds = resolveLodThresholds(options.lodThresholds);
    this.atlasFactory = options.atlasTargetFactory ?? createDefaultAtlasTarget;
    this.requestFrame = options.requestAnimationFrame ?? defaultFrameRequest;
    this.cancelFrame = options.cancelAnimationFrame ?? defaultFrameCancel;
    this.updatePreview(this.overlay.pendingCellStates);
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
    // A document that arrives mid-stroke gets the stroke's states reapplied to a fresh copy.
    if (this.preview) {
      const states = this.overlay.pendingCellStates;
      this.preview = undefined;
      this.updatePreview(states);
    }
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
    this.styleSettings = { ...this.styleSettings, ...style };
    this.style = mergeStyle(this.themeColors, this.styleSettings);
    this.invalidate('all');
  }

  private applyTheme(): void {
    if (this.disposed) return;
    this.themeColors = readRendererColors();
    this.style = mergeStyle(this.themeColors, this.styleSettings);
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
    const previousHidden = hiddenBackstitchIds(this.overlay);
    const nextHidden = hiddenBackstitchIds(overlay);
    this.overlay = overlay;
    this.updatePreview(overlay.pendingCellStates);
    const request: Invalidation = invalidation ? setterInvalidation(invalidation, 'overlay') : { layer: 'overlay', full: true };
    this.invalidate(request);
    // The ghost grid lives in the base target, so entering or leaving canvas
    // editing, or a moved workspace, repaints the base as well.
    const sameWorkspace = previous === next || (previous !== undefined && next !== undefined
      && previous.x === next.x && previous.y === next.y && previous.width === next.width && previous.height === next.height);
    if (!sameWorkspace) this.invalidate('base');
    // Lifting or erasing, and committing or cancelling either, changes which backstitches the base draws.
    if (!sameIds(previousHidden, nextHidden)) {
      const cellRect = backstitchCellBounds(this.document, previousHidden, nextHidden);
      if (cellRect) this.invalidate({ layer: 'base', cellRect: growCellRect(cellRect, 1) });
    }
  }

  /** What the base pass draws: the document, with any pending cell states applied. */
  private get shown(): PatternDocument {
    return this.preview?.document ?? this.document;
  }

  /**
   * Bring the preview in line with `states`: copy the cell planes once when a
   * stroke starts, then write each changed state and restore each cell that
   * dropped out, invalidating only those cells.
   */
  private updatePreview(states: readonly PendingCellState[] | undefined): void {
    const document = this.document;
    const previous = this.preview;
    if (!states) {
      if (!previous) return;
      this.preview = undefined;
      this.invalidatePreviewCells([...previous.touched]);
      return;
    }
    const planes = previous?.document ?? { kind: document.kind.slice(), colors: document.colors.slice(), completed: document.completed.slice() };
    const touched = previous?.touched ?? new Set<number>();
    const next = new Map<number, PendingCellState>();
    const changed: number[] = [];
    const cellCount = document.width * document.height;
    const write = (index: number, kind: number, colors: ArrayLike<number>, completed: number): void => {
      const offset = index * 4;
      if (planes.kind[index] === kind && planes.completed[index] === completed
        && planes.colors[offset] === colors[0] && planes.colors[offset + 1] === colors[1]
        && planes.colors[offset + 2] === colors[2] && planes.colors[offset + 3] === colors[3]) return;
      planes.kind[index] = kind;
      planes.colors.set([colors[0], colors[1], colors[2], colors[3]], offset);
      planes.completed[index] = completed;
      changed.push(index);
    };
    for (const state of states) {
      if (state.index < 0 || state.index >= cellCount) continue;
      next.set(state.index, state);
      write(state.index, state.kind, state.colors, state.completed);
    }
    for (const index of previous?.states.keys() ?? []) {
      if (!next.has(index)) write(index, document.kind[index], document.colors.subarray(index * 4, index * 4 + 4), document.completed[index]);
    }
    for (const index of changed) touched.add(index);
    // Fresh views over the same buffers tell the atlases the planes changed, without another copy.
    const shown = changed.length > 0 || !previous
      ? {
          ...document,
          kind: new Uint8Array(planes.kind.buffer, planes.kind.byteOffset, planes.kind.length),
          colors: new Uint16Array(planes.colors.buffer, planes.colors.byteOffset, planes.colors.length),
          completed: new Uint8Array(planes.completed.buffer, planes.completed.byteOffset, planes.completed.length)
        }
      : previous.document;
    this.preview = { document: shown, states: next, touched };
    this.invalidatePreviewCells(changed);
  }

  /** Repaint the base over `cells` and one cell around them, so the grid lines on their edges follow too. */
  private invalidatePreviewCells(cells: readonly number[]): void {
    if (cells.length === 0) return;
    const width = this.document.width;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const index of cells) {
      const x = index % width;
      const y = Math.floor(index / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    const cellCount = width * this.document.height;
    this.atlas.invalidate(cells, cellCount);
    this.symbolAtlas.invalidate(cells, cellCount);
    this.invalidate({ layer: 'base', cellRect: growCellRect({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }, 1) });
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
    this.unsubscribeTheme();
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
    const patternBackground = patternBackgroundColor(this.shown);
    // A highlight outline straddles cell edges, and a changed cell can add or remove
    // an edge on its neighbors, so a partial redraw covers one more cell around it.
    const outlineMargin = this.style.highlightColor === null ? 0 : 1;
    const cellInvalidationRect = invalidation.cellRect ? cellToScreenRect(growCellRect(invalidation.cellRect, outlineMargin), this.viewport) : undefined;
    const screenInvalidationRect = invalidation.rect && outlineMargin > 0
      ? growRect(invalidation.rect, outlineMargin * this.viewport.zoom)
      : invalidation.rect;
    const rawInvalidationRect = unionRect(screenInvalidationRect, cellInvalidationRect);
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
    if (lod !== RenderLod.Overview || this.shown.canvasMask === undefined) {
      fillCanvasFabric(context, this.shown, this.viewport, this.metrics, fillArea, patternBackground);
    }
    // Move-image mode dims the committed pattern so the reference image reads
    // on top; the reference image itself keeps its configured opacity.
    const dimAlpha = this.patternDimmed ? 0.5 : 1;
    if (lod === RenderLod.Overview) {
      const drawn = withAlpha(context, dimAlpha, 1, () => {
        const cells = this.drawOverviewCells(context, dimAlpha);
        const visible = visibleCellRect(this.viewport, this.metrics, this.shown);
        drawGrid(context, this.shown, this.viewport, this.metrics, this.style, visible, lod);
        drawChartBorder(context, this.shown, this.viewport, this.metrics, this.style);
        drawStitchNumbers(context, this.shown, this.viewport, this.metrics, this.style);
        const drawnBackstitches = drawBackstitches(context, this.shown, this.viewport, this.metrics, this.style, undefined, dimAlpha, hiddenBackstitchIds(this.overlay));
        return { ...cells, drawnBackstitches };
      });
      drawTraceImage(context, this.traceImage, this.shown, this.viewport, this.metrics);
      return drawn;
    }
    const visible = visibleCellRect(this.viewport, this.metrics, this.shown);
    const invalidationCellRect = (invalidation.cellRect && invalidationRect
      ? unionRect(invalidation.cellRect, screenRectToCellRect(invalidationRect, this.viewport))
      : invalidation.cellRect ?? (invalidationRect ? screenRectToCellRect(invalidationRect, this.viewport) : visible));
    const boundedCellRect = invalidationCellRect ?? visible;
    // A partial redraw that misses the visible cells draws none of them.
    const dirtyCells = partial
      ? intersectRect(visible, boundedCellRect)
      : visible;
    let drawnCells = 0;
    const drawnBackstitches = withAlpha(context, dimAlpha, 1, () => {
      const sprites = this.style.threadView && this.viewport.zoom >= THREAD_MIN_DETAIL_CELL_PX ? this.threadSpritesFor() : undefined;
      if (dirtyCells && sprites && this.shown.canvasMask === undefined) {
        // The weave is aligned to whole cells, so a clipped redraw lines up with the rest.
        const origin = cellToScreenRect({ x: dirtyCells.x, y: dirtyCells.y, width: 1, height: 1 }, this.viewport);
        drawThreadFabric(
          context,
          { x: origin.x, y: origin.y, width: dirtyCells.width * this.viewport.zoom, height: dirtyCells.height * this.viewport.zoom },
          this.viewport.zoom,
          patternBackground
        );
      }
      if (dirtyCells) {
        for (let y = dirtyCells.y; y < dirtyCells.y + dirtyCells.height; y += 1) {
          for (let x = dirtyCells.x; x < dirtyCells.x + dirtyCells.width; x += 1) {
            const drawn = sprites
              ? drawThreadCell(context, this.shown, x, y, this.style, this.viewport, sprites, dimAlpha)
              : drawCell(context, this.shown, x, y, this.style, this.viewport, lod, dimAlpha, this.metrics.dpr);
            if (drawn) drawnCells += 1;
          }
        }
        drawGrid(context, this.shown, this.viewport, this.metrics, this.style, dirtyCells, lod);
      }
      drawChartBorder(context, this.shown, this.viewport, this.metrics, this.style);
      drawStitchNumbers(context, this.shown, this.viewport, this.metrics, this.style);
      // Edges of cells just outside the redraw can reach into its clip, so trace one cell further.
      // A redraw that misses the visible cells still traces around the corner nearest them.
      const outlineCells = dirtyCells ?? { x: Math.max(visible.x, boundedCellRect.x), y: Math.max(visible.y, boundedCellRect.y), width: 0, height: 0 };
      if (this.viewport.zoom >= HIGHLIGHT_OUTLINE_MIN_CELL_PX) drawHighlightOutline(context, this.shown, this.viewport, this.style, growCellRect(outlineCells, 1));
      const dirtyModel = partial ? {
        x: this.viewport.x + invalidationRect.x / this.viewport.zoom,
        y: this.viewport.y + invalidationRect.y / this.viewport.zoom,
        width: invalidationRect.width / this.viewport.zoom,
        height: invalidationRect.height / this.viewport.zoom
      } : undefined;
      const hidden = hiddenBackstitchIds(this.overlay);
      return sprites
        ? drawThreadBackstitches(context, this.shown, this.viewport, this.metrics, this.style, dirtyModel, dimAlpha, hidden)
        : drawBackstitches(context, this.shown, this.viewport, this.metrics, this.style, dirtyModel, dimAlpha, hidden);
    });
    drawTraceImage(context, this.traceImage, this.shown, this.viewport, this.metrics);
    if (partial) restore(context);
    return { visitedCells: dirtyCells ? dirtyCells.width * dirtyCells.height : 0, drawnCells, drawnBackstitches };
  }

  /** Thread sprites at the current pixels per cell; a new size starts a new cache. */
  private threadSpritesFor(): ThreadSpriteCache {
    const cellPx = Math.max(1, Math.round(this.viewport.zoom * this.metrics.dpr));
    if (!this.threadSprites || this.threadSprites.cellPx !== cellPx) {
      this.threadSprites = createThreadSpriteCache(this.atlasFactory, cellPx);
    }
    return this.threadSprites;
  }

  /** Draw the Overview cells from the cached atlas when the adapter can, else
   * cell by cell; the caller draws the grid, border, and backstitches over them. */
  private drawOverviewCells(context: CanvasContextAdapter, dimAlpha: number): { visitedCells: number; drawnCells: number } {
    if (this.style.mode === ChartPresentationMode.Symbol) {
      const symbolAtlas = this.symbolAtlas.get(this.shown, this.style, this.atlasFactory);
      const canDrawCachedSymbols = Boolean(
        this.style.highlightColor === null &&
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
            this.shown.width * this.viewport.zoom,
            this.shown.height * this.viewport.zoom
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
      return drawOverviewSymbolFallback(context, this.shown, this.viewport, this.metrics, this.style, dimAlpha);
    }
    context.imageSmoothingEnabled = false;
    const atlas = this.style.highlightColor === null ? this.atlas.get(this.shown, this.style, this.atlasFactory) : undefined;
    if (atlas?.source && context.drawImage && isCanvasImageSource(atlas.source)) {
      drawImage(context, atlas.source, atlas.width, atlas.height, -this.viewport.x * this.viewport.zoom, -this.viewport.y * this.viewport.zoom, this.shown.width * this.viewport.zoom, this.shown.height * this.viewport.zoom);
      return { visitedCells: 0, drawnCells: 0 };
    }
    this.fillMaskedOverviewFabric(context);
    return drawOverviewFallback(context, this.shown, this.viewport, this.metrics, this.style, dimAlpha);
  }

  /** Without an atlas, a masked canvas's fabric is filled run by run like the other levels of detail. */
  private fillMaskedOverviewFabric(context: CanvasContextAdapter): void {
    if (this.shown.canvasMask === undefined) return;
    const screen = { x: 0, y: 0, width: this.metrics.cssWidth, height: this.metrics.cssHeight };
    fillCanvasFabric(context, this.shown, this.viewport, this.metrics, screen, patternBackgroundColor(this.shown));
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
