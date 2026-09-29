import { CellKind, defaultPaletteSymbol, type PatternDocument } from '../domain';
import {
  ChartPresentationMode,
  type CanvasContextAdapter,
  type RendererStyle,
  type Rect,
  type ScreenPoint
} from '../editor/contracts';
import { contrastSymbolInk } from './contrast';
import { getSymbolOutline } from '../symbols';
import { grayscaleColor } from './colors';
import {
  isThreeQuarterKind,
  isThreeQuarterPairKind,
  ThreeQuarterNE,
  ThreeQuarterNW,
  ThreeQuarterSE,
  ThreeQuarterSW
} from '../editor/cell-kinds';

/**
 * A symbol outline in cell-relative units, already centered on its origin.
 * `d` is SVG path data so the same string can back a canvas Path2D and an
 * SVG sprite reference.
 *
 * There is no paint mode. A glyph contour is already the solid silhouette of
 * the mark, so the path is simply filled; stroking it would trace a border
 * around an already-filled shape, doubling the weight of every stem and
 * closing the counters of marks like `o`, `8` and the zodiac glyphs.
 */
export interface SymbolOutline {
  readonly d: string;
}

/**
 * Paint a normalized outline centered on `position` and scaled to `cellSize`.
 *
 * The transform is composed with translate/scale rather than setTransform, so
 * the renderer's device-pixel-ratio matrix survives.
 */
export function drawSymbolOutline(
  context: CanvasContextAdapter,
  outline: SymbolOutline,
  position: ScreenPoint,
  cellSize: number,
  ink: string
): void {
  context.save?.();
  try {
    context.translate?.(position.x, position.y);
    context.scale?.(cellSize, cellSize);
    context.fillStyle = ink;
    context.fill(new Path2D(outline.d));
  } finally {
    context.restore?.();
  }
}

function polygon(context: CanvasContextAdapter, points: readonly ScreenPoint[]): void {
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index += 1) context.lineTo(points[index].x, points[index].y);
  context.closePath?.();
  context.fill();
}

/** Paint stitch geometry using the current fill. Legacy quarters remain slot-based. */
export function drawStitchGeometry(
  context: CanvasContextAdapter,
  kind: number,
  rect: Rect,
  slot = 0
): void {
  if (kind === CellKind.Full) {
    context.fillRect(rect.x, rect.y, rect.width, rect.height);
    return;
  }
  const left = rect.x;
  const top = rect.y;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  const holeWidth = rect.width * Math.SQRT1_2;
  const holeHeight = rect.height * Math.SQRT1_2;
  if (kind === CellKind.HalfBackslash) {
    polygon(context, [
      { x: left, y: top },
      { x: right - holeWidth, y: top },
      { x: right, y: top + holeHeight },
      { x: right, y: bottom },
      { x: left + holeWidth, y: bottom },
      { x: left, y: bottom - holeHeight }
    ]);
    return;
  }
  if (kind === CellKind.HalfSlash) {
    polygon(context, [
      { x: left + holeWidth, y: top },
      { x: right, y: top },
      { x: right, y: bottom - holeHeight },
      { x: right - holeWidth, y: bottom },
      { x: left, y: bottom },
      { x: left, y: top + holeHeight }
    ]);
    return;
  }
  if (isThreeQuarterKind(kind)) {
    if (kind === ThreeQuarterNW) {
      polygon(context, [
        { x: left, y: top },
        { x: right, y: top },
        { x: left, y: bottom }
      ]);
    } else if (kind === ThreeQuarterNE) {
      polygon(context, [
        { x: left, y: top },
        { x: right, y: top },
        { x: right, y: bottom }
      ]);
    } else if (kind === ThreeQuarterSE) {
      polygon(context, [
        { x: right, y: top },
        { x: right, y: bottom },
        { x: left, y: bottom }
      ]);
    } else if (kind === ThreeQuarterSW) {
      polygon(context, [
        { x: left, y: top },
        { x: right, y: bottom },
        { x: left, y: bottom }
      ]);
    }
    return;
  }
  if (isThreeQuarterPairKind(kind)) return;
  const center = { x: left + rect.width / 2, y: top + rect.height / 2 };
  const corners: readonly (readonly [ScreenPoint, ScreenPoint, ScreenPoint])[] = [
    [{ x: left, y: top }, { x: left + rect.width / 2, y: top }, center],
    [{ x: right, y: top }, { x: right, y: top + rect.height / 2 }, center],
    [{ x: right, y: bottom }, { x: left + rect.width / 2, y: bottom }, center],
    [{ x: left, y: bottom }, { x: left, y: top + rect.height / 2 }, center]
  ];
  polygon(context, corners[slot] ?? corners[0]);
}

function paletteColor(document: PatternDocument, id: number, missing: string): string {
  if (id === 0) return missing;
  return document.palette.find((entry) => entry.id === id)?.color ?? missing;
}

/** A palette id's own slug, falling back to the same default the domain assigns. */
function paletteSymbol(document: PatternDocument, id: number): string {
  return document.palette.find((entry) => entry.id === id)?.symbol ?? defaultPaletteSymbol(id);
}

function symbolInkColor(document: PatternDocument, id: number, style: RendererStyle): string {
  const color = paletteColor(document, id, style.missingPaletteColor);
  const stitchColor = style.mode === ChartPresentationMode.Grayscale ? grayscaleColor(color) : color;
  return style.mode === ChartPresentationMode.Combined
    ? contrastSymbolInk(stitchColor, style.symbolColor)
    : style.symbolColor;
}

function symbolPosition(rect: Rect, slot?: number): ScreenPoint {
  if (slot === undefined) return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const column = slot === 1 || slot === 2 ? 0.75 : 0.25;
  const row = slot === 2 || slot === 3 ? 0.75 : 0.25;
  return { x: rect.x + rect.width * column, y: rect.y + rect.height * row };
}

/**
 * Paint one palette color's symbol from the generated pool.
 *
 * A palette id with no symbol of its own is not a failure: it takes the domain
 * default, so every id in a valid document draws something. Neither is an id
 * whose slug the pool does not own, which the domain already refuses to
 * validate; painting nothing there is correct rather than exceptional.
 */
export function drawPaletteSymbol(
  context: CanvasContextAdapter,
  document: PatternDocument,
  id: number,
  rect: Rect,
  style: RendererStyle,
  slot?: number
): void {
  if (!style.showSymbols || style.mode === ChartPresentationMode.Color || style.mode === ChartPresentationMode.Grayscale) return;
  const outline = getSymbolOutline(paletteSymbol(document, id));
  if (!outline) return;
  const position = symbolPosition(rect, slot);
  const cellSize = Math.min(rect.width, rect.height);
  try {
    drawSymbolOutline(context, outline, position, cellSize, symbolInkColor(document, id, style));
  } catch {
    // A restricted or partially implemented canvas may expose the path methods
    // but reject a particular operation. The cell geometry the caller painted
    // first is the fallback, so a rejected symbol must not abort the frame.
  }
}
