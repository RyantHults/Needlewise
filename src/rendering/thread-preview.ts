import { CellKind, isThreeQuarterPairKind } from '../domain';
import { parseHexColor, rgbToHex } from '../domain/color';
import type { CanvasContextAdapter, CanvasTarget, Rect, ScreenPoint } from '../editor/contracts';
import { isCanvasImageSource } from './atlas';
import { drawStitchGeometry } from './symbol-painter';

/**
 * Thread-view painter.
 *
 * It reads stitch kinds and thread colors only. Nothing here accepts, reads or
 * draws completion state, so the Preview cannot show marks through this path.
 * The caller resolves a cell's palette id to a color (as the symbol painter's
 * callers do) and passes the color string.
 */

/** Below this many pixels per cell the strokes are sub-pixel mush; draw flat color instead. */
export const THREAD_MIN_DETAIL_CELL_PX = 4;

/** Cross-stitch stroke width in cell units. */
export const THREAD_STITCH_WIDTH = 0.3;
/** Backstitch stroke width in cell units. */
export const THREAD_BACKSTITCH_WIDTH = 0.18;

/** Dark rim is a little wider than the thread so it reads as the strand's shadowed edge. */
const EDGE_WIDTH = THREAD_STITCH_WIDTH + 0.04;
const HIGHLIGHT_WIDTH = 0.1;
/** Highlight sits toward the upper left, the conventional light direction. */
const HIGHLIGHT_OFFSET = -0.04;
const BACKSTITCH_EDGE_WIDTH = THREAD_BACKSTITCH_WIDTH + 0.03;
const BACKSTITCH_HIGHLIGHT_WIDTH = 0.07;
/** Keeps a stroke and its round cap inside the cell: cap radius (half of EDGE_WIDTH) equals the inset. */
const NEAR = EDGE_WIDTH / 2;
const FAR = 1 - NEAR;
const MID = 0.5;

/** `[x1, y1, x2, y2]` in unit-cell coordinates, +y down. */
type Stroke = readonly [number, number, number, number];

const BACKSLASH: Stroke = [NEAR, NEAR, FAR, FAR];
const SLASH: Stroke = [FAR, NEAR, NEAR, FAR];
/** Corner-to-center strokes, indexed by legacy quarter slot: NW, NE, SE, SW. */
const CORNER_TO_CENTER: readonly Stroke[] = [
  [NEAR, NEAR, MID, MID],
  [FAR, NEAR, MID, MID],
  [FAR, FAR, MID, MID],
  [NEAR, FAR, MID, MID]
];

/**
 * Strokes for a kind, ordered bottom to top: `\` strokes first so `/` lies over
 * them, as in a worked cross. A three-quarter stitch is its half-stitch
 * diagonal plus a corner-to-center stroke on the other diagonal.
 */
function threadStrokes(kind: number, slot: number): readonly Stroke[] {
  if (kind === CellKind.Full) return [BACKSLASH, SLASH];
  if (kind === CellKind.HalfBackslash) return [BACKSLASH];
  if (kind === CellKind.HalfSlash) return [SLASH];
  if (kind === CellKind.ThreeQuarterNW) return [CORNER_TO_CENTER[0], SLASH];
  if (kind === CellKind.ThreeQuarterNE) return [BACKSLASH, CORNER_TO_CENTER[1]];
  if (kind === CellKind.ThreeQuarterSE) return [CORNER_TO_CENTER[2], SLASH];
  if (kind === CellKind.ThreeQuarterSW) return [BACKSLASH, CORNER_TO_CENTER[3]];
  // Callers split a pair into its components, as the symbol painter's callers do.
  if (isThreeQuarterPairKind(kind) || kind === CellKind.Empty) return [];
  return [CORNER_TO_CENTER[slot] ?? CORNER_TO_CENTER[0]];
}

/** Blend `color` toward `target` (0-255 gray) by `amount`; an unparseable color is returned unchanged. */
function mixToward(color: string, target: number, amount: number): string {
  const rgb = parseHexColor(color);
  if (!rgb) return color;
  const [red, green, blue] = rgb.map((value) => value * (1 - amount) + target * amount);
  return rgbToHex(red, green, blue);
}

/** Shaded edge of a thread color. */
export function threadEdgeColor(color: string): string {
  return mixToward(color, 0, 0.35);
}

/** Lit highlight of a thread color. */
export function threadHighlightColor(color: string): string {
  return mixToward(color, 255, 0.4);
}

interface StrokeStyleState {
  readonly strokeStyle: string;
  readonly lineWidth: number;
  readonly lineCap: string | undefined;
  readonly lineJoin: string | undefined;
}

/** Run `paint` with round-capped strokes, restoring the caller's stroke state afterwards. */
function withRoundStroke(context: CanvasContextAdapter, paint: () => void): void {
  const previous: StrokeStyleState = {
    strokeStyle: context.strokeStyle,
    lineWidth: context.lineWidth,
    lineCap: context.lineCap,
    lineJoin: context.lineJoin
  };
  context.lineCap = 'round';
  context.lineJoin = 'round';
  try {
    paint();
  } finally {
    context.strokeStyle = previous.strokeStyle;
    context.lineWidth = previous.lineWidth;
    if (previous.lineCap !== undefined) context.lineCap = previous.lineCap;
    else delete context.lineCap;
    if (previous.lineJoin !== undefined) context.lineJoin = previous.lineJoin;
    else delete context.lineJoin;
  }
}

function line(context: CanvasContextAdapter, from: ScreenPoint, to: ScreenPoint, width: number, color: string): void {
  context.strokeStyle = color;
  context.lineWidth = width;
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x, to.y);
  context.stroke();
}

/** One strand: dark edge, thread body, then highlight, each a round-capped line. */
function strand(
  context: CanvasContextAdapter,
  from: ScreenPoint,
  to: ScreenPoint,
  cellSize: number,
  widths: { readonly edge: number; readonly body: number; readonly highlight: number },
  color: string
): void {
  line(context, from, to, widths.edge * cellSize, threadEdgeColor(color));
  line(context, from, to, widths.body * cellSize, color);
  const shift = HIGHLIGHT_OFFSET * cellSize;
  line(
    context,
    { x: from.x + shift, y: from.y + shift },
    { x: to.x + shift, y: to.y + shift },
    widths.highlight * cellSize,
    threadHighlightColor(color)
  );
}

const STITCH_WIDTHS = { edge: EDGE_WIDTH, body: THREAD_STITCH_WIDTH, highlight: HIGHLIGHT_WIDTH };
const BACKSTITCH_WIDTHS = {
  edge: BACKSTITCH_EDGE_WIDTH,
  body: THREAD_BACKSTITCH_WIDTH,
  highlight: BACKSTITCH_HIGHLIGHT_WIDTH
};

/**
 * Paint one stitch as thread inside `rect` (a square cell; the smaller side
 * sets stroke widths). `slot` selects the corner of a legacy quarter, as in
 * `drawStitchGeometry`. A three-quarter pair paints nothing: draw its two
 * components with their own kinds and colors.
 */
export function drawThreadStitch(
  context: CanvasContextAdapter,
  kind: number,
  rect: Rect,
  color: string,
  slot = 0
): void {
  const strokes = threadStrokes(kind, slot);
  if (strokes.length === 0) return;
  const cellSize = Math.min(rect.width, rect.height);
  withRoundStroke(context, () => {
    for (const [x1, y1, x2, y2] of strokes) {
      strand(
        context,
        { x: rect.x + x1 * rect.width, y: rect.y + y1 * rect.height },
        { x: rect.x + x2 * rect.width, y: rect.y + y2 * rect.height },
        cellSize,
        STITCH_WIDTHS,
        color
      );
    }
  });
}

/**
 * Paint a backstitch between two points given in cell coordinates (cell
 * (3, 2)'s top-left corner is `{ x: 3, y: 2 }`). `origin` is the screen
 * position of cell (0, 0).
 */
export function drawThreadBackstitch(
  context: CanvasContextAdapter,
  from: ScreenPoint,
  to: ScreenPoint,
  cellSize: number,
  color: string,
  origin: ScreenPoint = { x: 0, y: 0 }
): void {
  withRoundStroke(context, () => {
    strand(
      context,
      { x: origin.x + from.x * cellSize, y: origin.y + from.y * cellSize },
      { x: origin.x + to.x * cellSize, y: origin.y + to.y * cellSize },
      cellSize,
      BACKSTITCH_WIDTHS,
      color
    );
  });
}

/** Flat-color stitch for cells below `THREAD_MIN_DETAIL_CELL_PX`; the caller decides via LOD. */
export function drawThreadFlat(
  context: CanvasContextAdapter,
  kind: number,
  rect: Rect,
  color: string,
  slot = 0
): void {
  context.fillStyle = color;
  drawStitchGeometry(context, kind, rect, slot);
}

/**
 * Fill `rect` with fabric: the background color plus a faint Aida weave grid
 * on every cell boundary, aligned to `rect`'s top-left. The weave is one path
 * and one stroke, so cost does not grow with cell count.
 */
export function drawThreadFabric(
  context: CanvasContextAdapter,
  rect: Rect,
  cellSize: number,
  background: string
): void {
  context.fillStyle = background;
  context.fillRect(rect.x, rect.y, rect.width, rect.height);
  if (cellSize < THREAD_MIN_DETAIL_CELL_PX) return;
  const previous = { strokeStyle: context.strokeStyle, lineWidth: context.lineWidth };
  context.strokeStyle = mixToward(background, 0, 0.12);
  context.lineWidth = Math.max(1, cellSize * 0.06);
  context.beginPath();
  for (let x = rect.x; x <= rect.x + rect.width + 1e-6; x += cellSize) {
    context.moveTo(x, rect.y);
    context.lineTo(x, rect.y + rect.height);
  }
  for (let y = rect.y; y <= rect.y + rect.height + 1e-6; y += cellSize) {
    context.moveTo(rect.x, y);
    context.lineTo(rect.x + rect.width, y);
  }
  context.stroke();
  context.strokeStyle = previous.strokeStyle;
  context.lineWidth = previous.lineWidth;
}

export interface ThreadSpriteCache {
  /** Pixels per cell the sprites were painted at; a new size needs a new cache. */
  readonly cellPx: number;
  /** Number of cached sprites. */
  readonly size: number;
  /** The painted sprite for `(color, kind, slot)`, or undefined when no target could be allocated. */
  get(color: string, kind: number, slot?: number): CanvasImageSource | undefined;
  /**
   * Blit the sprite into `rect`'s top-left corner at the cache's cell size.
   * Returns false when no sprite is available, so the caller can draw
   * directly with `drawThreadStitch` or `drawThreadFlat`.
   */
  draw(context: CanvasContextAdapter, color: string, kind: number, rect: Rect, slot?: number): boolean;
  clear(): void;
}

const DEFAULT_MAX_SPRITES = 4096;

/**
 * Cache of one transparent cell-sized sprite per `(color, kind, slot)` at a
 * fixed pixel size. `targetFactory` allocates a `width x height` target (an
 * `OffscreenCanvas` or canvas in the renderer); when it returns undefined or
 * throws, `get` returns undefined and nothing is cached.
 */
export function createThreadSpriteCache(
  targetFactory: (width: number, height: number) => CanvasTarget | undefined,
  cellPx: number,
  maxSprites = DEFAULT_MAX_SPRITES
): ThreadSpriteCache {
  const sprites = new Map<string, CanvasImageSource>();
  const spriteSize = Math.max(1, Math.round(cellPx));

  function get(color: string, kind: number, slot = 0): CanvasImageSource | undefined {
    const key = `${kind}:${slot}:${color}`;
    const cached = sprites.get(key);
    if (cached) return cached;
    let source: CanvasImageSource | undefined;
    try {
      const target = targetFactory(spriteSize, spriteSize);
      if (target && isCanvasImageSource(target.source)) {
        drawThreadStitch(target.context, kind, { x: 0, y: 0, width: spriteSize, height: spriteSize }, color, slot);
        source = target.source;
      }
    } catch {
      // Allocation is optional in workers and restricted browsers; the caller draws directly.
      source = undefined;
    }
    if (!source) return undefined;
    if (sprites.size >= maxSprites) sprites.clear();
    sprites.set(key, source);
    return source;
  }

  return {
    cellPx: spriteSize,
    get size() {
      return sprites.size;
    },
    get,
    draw(context, color, kind, rect, slot = 0) {
      if (!context.drawImage) return false;
      const sprite = get(color, kind, slot);
      if (!sprite) return false;
      context.drawImage(sprite, rect.x, rect.y, rect.width, rect.height);
      return true;
    },
    clear() {
      sprites.clear();
    }
  };
}
