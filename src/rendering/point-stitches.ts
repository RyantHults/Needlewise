import { beadSizeMm } from '../catalog';
import { isBeadEntry, type BeadOrientation, type PaletteEntry, type PatternSettings } from '../domain';
import type { CanvasContextAdapter, ScreenPoint } from '../editor/contracts';
import { paletteEntry, threadEdgeColor } from './colors';

/**
 * Chart marks for French knots and beads. A knot is a filled round dot. A
 * bead lies on its side as it sits on fabric, its hole along the stitch that
 * holds it, so it is drawn as a barrel along its orientation (`/`, `|`, `\`
 * or `-`) at its real size on the pattern's fabric, and can be larger than a
 * cell. Sizes have a pixel floor, so both stay visible when zoomed far out.
 */

/** Knot diameter in cell units. */
export const KNOT_DIAMETER = 0.4;
/** Knot ring width in cell units. */
const KNOT_RING = 0.05;
const MIN_KNOT_RADIUS_PX = 1.5;
const MIN_LINE_PX = 1;
/** A bead is never drawn narrower than this; its length scales with it. */
const MIN_BEAD_WIDTH_PX = 4;
const MM_PER_INCH = 25.4;

/** A bead barrel's corner radius as a share of its width, capped at half its length and half its width. */
export const BEAD_CORNER_FRACTION = 0.35;
/** The bead's rim stroke as a share of its width. */
const BEAD_RIM = 0.06;

/** A unit direction in y-down screen space. */
export interface Vector {
  readonly x: number;
  readonly y: number;
}

/**
 * Per orientation, in y-down screen space: the unit vector along the hole,
 * and the side of the axis the highlight streak sits on (up and to the left
 * where the axis allows, up for `\`).
 */
const BEAD_AXES: readonly Vector[] = [
  { x: Math.SQRT1_2, y: -Math.SQRT1_2 },
  { x: 0, y: 1 },
  { x: Math.SQRT1_2, y: Math.SQRT1_2 },
  { x: 1, y: 0 }
];

/** The unit vector along a bead's hole in y-down screen space: `/` (1, -1)/√2, `|` (0, 1), `\` (1, 1)/√2, `-` (1, 0). */
export function beadAxis(orientation: BeadOrientation): Vector {
  return BEAD_AXES[orientation];
}

/** The axis turned a quarter clockwise on screen, so canvas arc angles follow the barrel's frame. */
function acrossOf(axis: Vector): Vector {
  return { x: -axis.y, y: axis.x };
}

/** A bead's footprint: `width` across the hole axis (its diameter) and `length` along it, in cells or pixels. */
export interface BeadSize {
  readonly width: number;
  readonly length: number;
}

type BeadSizing = { readonly palette: readonly PaletteEntry[]; readonly settings: Pick<PatternSettings, 'aidaCount'> };

/** A bead entry's real footprint in cells on the pattern's fabric; zero when `colorId` names no palette entry. */
export function beadSizeCells(document: BeadSizing, colorId: number): BeadSize {
  const entry = paletteEntry(document.palette, colorId);
  if (!entry) return { width: 0, length: 0 };
  const size = beadSizeMm(entry);
  const cellsPerMm = document.settings.aidaCount / MM_PER_INCH;
  return { width: size.diameterMm * cellsPerMm, length: size.lengthMm * cellsPerMm };
}

function cornerRadius(size: BeadSize): number {
  return Math.min(BEAD_CORNER_FRACTION * size.width, size.width / 2, size.length / 2);
}

/** How far a bead barrel of `size` reaches from its centre in any direction. */
function beadReach(size: BeadSize): number {
  const radius = cornerRadius(size);
  return Math.hypot(size.length / 2 - radius, size.width / 2 - radius) + radius;
}

/** The farthest any of the palette's beads reaches from its centre, in cells, or 0 without beads. */
export function maxBeadReachCells(document: BeadSizing): number {
  let largest = 0;
  for (const entry of document.palette) if (isBeadEntry(entry)) largest = Math.max(largest, beadReach(beadSizeCells(document, entry.id)));
  return largest;
}

/** How far a point mark can reach from its centre, in cell units, at this zoom, when the farthest bead reaches `maxBeadReachCells`. */
export function pointMarkReach(zoom: number, maxBeadReachCells: number): number {
  const scale = zoom > 0 ? zoom : 1;
  return Math.max(
    KNOT_DIAMETER / 2 + KNOT_RING / 2,
    maxBeadReachCells * (1 + BEAD_RIM) + MIN_LINE_PX / scale,
    (MIN_BEAD_WIDTH_PX + MIN_LINE_PX) / scale
  );
}

/** A bead's footprint in screen pixels at `cellSize`, scaled up as a whole to the pixel floor. */
export function beadPixelSize(size: BeadSize, cellSize: number): BeadSize {
  const width = size.width * cellSize;
  const grow = width > 0 ? Math.max(1, MIN_BEAD_WIDTH_PX / width) : 1;
  return { width: width * grow, length: size.length * cellSize * grow };
}

/** Whether the offset (`dx`, `dy`) from a bead's centre falls inside its barrel; `size` and the offset share units. */
export function beadBarrelContains(size: BeadSize, orientation: BeadOrientation, dx: number, dy: number): boolean {
  const axis = beadAxis(orientation);
  const crossing = acrossOf(axis);
  const radius = cornerRadius(size);
  const along = Math.max(0, Math.abs(dx * axis.x + dy * axis.y) - (size.length / 2 - radius));
  const across = Math.max(0, Math.abs(dx * crossing.x + dy * crossing.y) - (size.width / 2 - radius));
  return along * along + across * across <= radius * radius;
}

function barrelPoint(center: ScreenPoint, axis: Vector, along: number, across: number): ScreenPoint {
  const crossing = acrossOf(axis);
  return { x: center.x + along * axis.x + across * crossing.x, y: center.y + along * axis.y + across * crossing.y };
}

/** Trace the outline of a bead barrel of `size` pixels around `center`: a rounded rectangle along the orientation's axis. */
export function beadBarrelPath(context: CanvasContextAdapter, center: ScreenPoint, size: BeadSize, orientation: BeadOrientation): void {
  const arc = context.arc?.bind(context);
  if (!arc) return;
  const axis = beadAxis(orientation);
  const axisAngle = Math.atan2(axis.y, axis.x);
  const radius = cornerRadius(size);
  const along = size.length / 2 - radius;
  const across = size.width / 2 - radius;
  const start = barrelPoint(center, axis, -along, -size.width / 2);
  context.beginPath();
  context.moveTo(start.x, start.y);
  const corners = [[along, -across], [along, across], [-along, across], [-along, -across]] as const;
  corners.forEach(([u, v], index) => {
    const corner = barrelPoint(center, axis, u, v);
    const from = -Math.PI / 2 + (index * Math.PI) / 2 + axisAngle;
    arc(corner.x, corner.y, radius, from, from + Math.PI / 2);
  });
  context.closePath?.();
}

/** A filled knot dot with a darker rim, so it keeps its edge on any fabric or stitch. */
export function drawKnot(context: CanvasContextAdapter, center: ScreenPoint, cellSize: number, color: string): void {
  if (!context.arc) return;
  const radius = Math.max(MIN_KNOT_RADIUS_PX, (KNOT_DIAMETER / 2) * cellSize);
  context.fillStyle = color;
  context.beginPath();
  context.arc(center.x, center.y, radius, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = threadEdgeColor(color);
  context.lineWidth = Math.max(MIN_LINE_PX, cellSize * KNOT_RING);
  context.stroke();
}

/** A bead of `size` cells lying on its side along `orientation`: a barrel filled in its colour with a darker rim. */
export function drawBead(context: CanvasContextAdapter, center: ScreenPoint, cellSize: number, size: BeadSize, orientation: BeadOrientation, color: string): void {
  if (!context.arc) return;
  const pixels = beadPixelSize(size, cellSize);
  beadBarrelPath(context, center, pixels, orientation);
  context.fillStyle = color;
  context.fill();
  context.strokeStyle = threadEdgeColor(color);
  context.lineWidth = Math.max(MIN_LINE_PX, BEAD_RIM * pixels.width);
  context.stroke();
}
