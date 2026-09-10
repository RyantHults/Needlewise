import { CellKind, type PatternDocument } from '../domain';
import {
  ChartPresentationMode,
  type CanvasContextAdapter,
  type RendererStyle,
  type Rect,
  type ScreenPoint
} from '../editor/contracts';
import { contrastSymbolInk } from './contrast';
import { SYMBOL_RENDER_OVERRIDES, symbolFontForCell } from './symbol-font';
import { grayscaleColor, symbolForPaletteId } from './symbols';
import {
  isThreeQuarterKind,
  isThreeQuarterPairKind,
  ThreeQuarterNE,
  ThreeQuarterNW,
  ThreeQuarterSE,
  ThreeQuarterSW
} from '../editor/cell-kinds';

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

/** Preserve the renderer's exact custom-symbol/fallback lookup semantics. */
function paletteSymbol(document: PatternDocument, id: number): string {
  return document.palette.find((entry) => entry.id === id)?.symbol ?? symbolForPaletteId(id);
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

/** Paint one actual palette glyph with the renderer's shared symbol semantics. */
export function drawPaletteSymbol(
  context: CanvasContextAdapter,
  document: PatternDocument,
  id: number,
  rect: Rect,
  style: RendererStyle,
  slot?: number
): boolean {
  if (!context.fillText || !style.showSymbols || style.mode === ChartPresentationMode.Color || style.mode === ChartPresentationMode.Grayscale) return false;
  const symbol = paletteSymbol(document, id);
  // A missing id has no glyph to paint, but it does not mean the canvas text
  // capability is unavailable to the atlas.
  if (!symbol) return true;
  const position = symbolPosition(rect, slot);
  // Per-glyph corrections for denser/off-centre keepers (see symbol-font.ts):
  // scale shrinks the em fraction so full-cell ink stays inside the cell, and
  // dy nudges the baseline-relative ink high/low bias back to centre. Glyphs
  // without an entry keep the identity (scale 1 / dy 0) exactly as before.
  const override = SYMBOL_RENDER_OVERRIDES[symbol];
  const cellSize = Math.min(rect.width, rect.height) * (override?.scale ?? 1);
  const dy = override?.dy ?? 0;
  context.save?.();
  try {
    context.fillStyle = symbolInkColor(document, id, style);
    context.font = symbolFontForCell(style.symbolFont, cellSize);
    if (context.textAlign !== undefined) context.textAlign = 'center';
    if (context.textBaseline !== undefined) context.textBaseline = 'middle';
    context.fillText(symbol, position.x, position.y + dy);
    return true;
  } catch {
    // A restricted or partially implemented canvas may expose fillText but
    // reject a particular text operation. Geometry remains a safe fallback.
    return false;
  } finally {
    context.restore?.();
  }
}
