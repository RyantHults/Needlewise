import type { CanvasContextAdapter, ScreenPoint } from '../editor/contracts';
import { restore, save } from './context';

/**
 * UI icons drawn on the chart canvas from their inline svg: the svg's first
 * path becomes a Path2D, drawn at a fixed screen size with a halo stroke under
 * the fill so it reads over any fabric or stitch.
 */

const icons = new Map<string, Path2D | null>();

/** The svg's first `<path d>` as a Path2D, built once per svg; undefined without Path2D or a path. */
export function canvasIcon(svg: string): Path2D | undefined {
  if (typeof Path2D !== 'function') return undefined;
  let icon = icons.get(svg);
  if (icon === undefined) {
    const d = /<path[^>]*\sd="([^"]+)"/.exec(svg)?.[1];
    icon = d ? new Path2D(d) : null;
    icons.set(svg, icon);
  }
  return icon ?? undefined;
}

/** Draw `icon`, authored in a square `viewBox`, `sizePx` across and centred on `center`: a `halo` stroke, then the `fill`. */
export function drawCanvasIcon(
  context: CanvasContextAdapter,
  icon: Path2D,
  center: ScreenPoint,
  sizePx: number,
  viewBox: number,
  fill: string,
  halo: string
): void {
  const scale = sizePx / viewBox;
  save(context);
  context.translate?.(center.x, center.y);
  context.scale?.(scale, scale);
  context.translate?.(-viewBox / 2, -viewBox / 2);
  context.strokeStyle = halo;
  context.lineWidth = 3 / scale;
  context.lineJoin = 'round';
  context.stroke(icon);
  context.fillStyle = fill;
  context.fill(icon);
  restore(context);
}
