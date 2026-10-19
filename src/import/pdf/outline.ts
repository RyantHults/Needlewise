// Outline geometry for imported symbols. Pure: no pdf.js import, so the pool
// matcher in `build-document.ts` can use it without loading the parser.
//
// A normalized outline is an SVG path of M/L/C/Z commands in a unit box, y
// down: the ink bounds are scaled uniformly so the longer side is 1 and the
// shorter side is centered. Glyphs, PDF paths and pool `d` strings all go
// through the same normalization, so they can be compared with each other.
import type { Rect } from './types';

/** PDF matrix `[a, b, c, d, e, f]`: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** A line end point `[x, y]`, or a cubic `[x1, y1, x2, y2, x, y]`. */
export type Segment = readonly [number, number] | readonly [number, number, number, number, number, number];

export interface Subpath {
  readonly x: number;
  readonly y: number;
  readonly segments: readonly Segment[];
  readonly closed: boolean;
}

/** pdf.js `DrawOPS` codes (mirrored from `pdfjs.ts` so this module stays pure). */
const MOVE = 0;
const LINE = 1;
const CURVE = 2;
const QUAD = 3;
const CLOSE = 4;

/** The matrix that applies `b` first, then `a` (pdf.js `Util.transform(a, b)`). */
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5]
  ];
}

/**
 * Round each value to the nearest IEEE half float. Browsers hand glyph
 * outlines over as Float16Array and Node as Float32Array; rounding both to
 * half precision makes an outline bit-identical in either environment.
 */
export function roundToFloat16(values: ArrayLike<number>): Float64Array {
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i += 1) out[i] = f16(values[i]);
  return out;
}

function f16(value: number): number {
  if (!Number.isFinite(value) || value === 0) return value;
  const magnitude = Math.abs(value);
  if (magnitude >= 65520) return Math.sign(value) * Infinity;
  // Subnormals share the smallest normal's quantum, 2^-24.
  let exponent = Math.max(-14, Math.floor(Math.log2(magnitude)));
  if (2 ** exponent > magnitude) exponent -= 1;
  else if (2 ** (exponent + 1) <= magnitude) exponent += 1;
  const quantum = 2 ** (Math.max(-14, exponent) - 10);
  const scaled = magnitude / quantum;
  let rounded = Math.floor(scaled);
  const rest = scaled - rounded;
  if (rest > 0.5 || (rest === 0.5 && rounded % 2 === 1)) rounded += 1;
  return Math.sign(value) * rounded * quantum;
}

export const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

class PathBuilder {
  readonly subpaths: Subpath[] = [];
  private current: { x: number; y: number; segments: Segment[]; closed: boolean } | null = null;
  /** Current point, for relative SVG commands and quadratic elevation. */
  cx = 0;
  cy = 0;

  move(x: number, y: number): void {
    this.flush();
    this.current = { x, y, segments: [], closed: false };
    this.cx = x;
    this.cy = y;
  }

  private open(): { x: number; y: number; segments: Segment[]; closed: boolean } {
    if (!this.current || this.current.closed) this.move(this.cx, this.cy);
    return this.current as { x: number; y: number; segments: Segment[]; closed: boolean };
  }

  line(x: number, y: number): void {
    this.open().segments.push([x, y]);
    this.cx = x;
    this.cy = y;
  }

  cubic(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
    this.open().segments.push([x1, y1, x2, y2, x, y]);
    this.cx = x;
    this.cy = y;
  }

  /** Exact degree elevation, the same conversion pdf-lib applies to `Q`. */
  quad(qx: number, qy: number, x: number, y: number): void {
    const { cx, cy } = this;
    this.cubic(cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy), x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y);
  }

  close(): void {
    if (!this.current || this.current.closed) return;
    this.current.closed = true;
    this.cx = this.current.x;
    this.cy = this.current.y;
  }

  flush(): Subpath[] {
    if (this.current && this.current.segments.length > 0) this.subpaths.push(this.current);
    this.current = null;
    return this.subpaths;
  }
}

/** Decode a pdf.js DrawOps buffer into subpaths, each point mapped through `m`. */
export function drawOpsToPoints(ops: ArrayLike<number>, m: Matrix): Subpath[] {
  const path = new PathBuilder();
  const at = (i: number): [number, number] => apply(m, ops[i], ops[i + 1]);
  for (let i = 0; i < ops.length;) {
    switch (ops[i++]) {
      case MOVE:
        path.move(...at(i));
        i += 2;
        break;
      case LINE:
        path.line(...at(i));
        i += 2;
        break;
      case CURVE:
        path.cubic(...at(i), ...at(i + 2), ...at(i + 4));
        i += 6;
        break;
      case QUAD:
        path.quad(...at(i), ...at(i + 2));
        i += 4;
        break;
      case CLOSE:
        path.close();
        break;
      default:
        // Unknown opcode: the rest of the buffer cannot be decoded.
        return path.flush();
    }
  }
  return path.flush();
}

const SVG_TOKEN = /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

/** Parse an SVG path. Arcs are approximated by their chord; the pool has none. */
function parseSvgPath(d: string): Subpath[] {
  const tokens = d.match(SVG_TOKEN) ?? [];
  const path = new PathBuilder();
  let i = 0;
  let command = '';
  // Reflected control points for S and T.
  let lastCubic: [number, number] | null = null;
  let lastQuad: [number, number] | null = null;
  const num = (): number => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) command = tokens[i++];
    const relative = command === command.toLowerCase();
    const ox = relative ? path.cx : 0;
    const oy = relative ? path.cy : 0;
    let cubic: [number, number] | null = null;
    let quad: [number, number] | null = null;
    switch (command.toUpperCase()) {
      case 'M': {
        const x = num() + ox;
        const y = num() + oy;
        path.move(x, y);
        // Further pairs after a moveto are implicit linetos.
        command = relative ? 'l' : 'L';
        break;
      }
      case 'L': {
        const x = num() + ox;
        path.line(x, num() + oy);
        break;
      }
      case 'H':
        path.line(num() + ox, path.cy);
        break;
      case 'V':
        path.line(path.cx, num() + oy);
        break;
      case 'C': {
        const x1 = num() + ox, y1 = num() + oy, x2 = num() + ox, y2 = num() + oy, x = num() + ox, y = num() + oy;
        path.cubic(x1, y1, x2, y2, x, y);
        cubic = [x2, y2];
        break;
      }
      case 'S': {
        const x1: number = lastCubic ? 2 * path.cx - lastCubic[0] : path.cx;
        const y1: number = lastCubic ? 2 * path.cy - lastCubic[1] : path.cy;
        const x2 = num() + ox, y2 = num() + oy, x = num() + ox, y = num() + oy;
        path.cubic(x1, y1, x2, y2, x, y);
        cubic = [x2, y2];
        break;
      }
      case 'Q': {
        const qx = num() + ox, qy = num() + oy, x = num() + ox, y = num() + oy;
        path.quad(qx, qy, x, y);
        quad = [qx, qy];
        break;
      }
      case 'T': {
        const qx: number = lastQuad ? 2 * path.cx - lastQuad[0] : path.cx;
        const qy: number = lastQuad ? 2 * path.cy - lastQuad[1] : path.cy;
        const x = num() + ox, y = num() + oy;
        path.quad(qx, qy, x, y);
        quad = [qx, qy];
        break;
      }
      case 'A': {
        i += 5;
        const x = num() + ox;
        path.line(x, num() + oy);
        break;
      }
      case 'Z':
        path.close();
        break;
      default:
        // Stray number with no command: skip it.
        i += 1;
    }
    lastCubic = cubic;
    lastQuad = quad;
    if (command.toUpperCase() === 'Z') command = '';
  }
  return path.flush();
}

/** Parameters in (0, 1) where one coordinate of a cubic has a local extremum. */
function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const roots: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) roots.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      roots.push((-b + sq) / (2 * a), (-b - sq) / (2 * a));
    }
  }
  return roots.filter((t) => t > 0 && t < 1);
}

const cubicAt = (p0: number, p1: number, p2: number, p3: number, t: number): number => {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
};

/** Exact ink bounds of the subpaths (curve extrema included), or null when empty. */
export function subpathBounds(subpaths: readonly Subpath[]): Rect | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number): void => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const subpath of subpaths) {
    let px = subpath.x, py = subpath.y;
    add(px, py);
    for (const segment of subpath.segments) {
      if (segment.length === 2) {
        [px, py] = segment;
        add(px, py);
        continue;
      }
      const [x1, y1, x2, y2, x, y] = segment;
      for (const t of cubicExtrema(px, x1, x2, x)) add(cubicAt(px, x1, x2, x, t), cubicAt(py, y1, y2, y, t));
      for (const t of cubicExtrema(py, y1, y2, y)) add(cubicAt(px, x1, x2, x, t), cubicAt(py, y1, y2, y, t));
      add(x, y);
      px = x;
      py = y;
    }
  }
  return minX === Infinity ? null : { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

const fmt = (value: number): string => {
  const rounded = Math.round(value * 1e4) / 1e4;
  return String(rounded === 0 ? 0 : rounded);
};

/** Fit the subpaths into the unit box and print them as M/L/C/Z. */
function normalizeSubpaths(subpaths: readonly Subpath[]): { d: string; bounds: Rect } {
  const bounds = subpathBounds(subpaths) ?? { x: 0, y: 0, width: 0, height: 0 };
  const size = Math.max(bounds.width, bounds.height) || 1;
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const px = (x: number): string => fmt((x - cx) / size + 0.5);
  const py = (y: number): string => fmt((y - cy) / size + 0.5);
  const parts: string[] = [];
  for (const subpath of subpaths) {
    parts.push(`M${px(subpath.x)} ${py(subpath.y)}`);
    for (const s of subpath.segments) {
      parts.push(s.length === 2
        ? `L${px(s[0])} ${py(s[1])}`
        : `C${px(s[0])} ${py(s[1])} ${px(s[2])} ${py(s[3])} ${px(s[4])} ${py(s[5])}`);
    }
    if (subpath.closed) parts.push('Z');
  }
  return { d: parts.join(''), bounds };
}

/**
 * Normalize a pdf.js DrawOps buffer. `m` maps the buffer into PDF page space
 * (y up); the result's `bounds` are the ink bounds in y-down page space
 * (`y' = pageHeight - y`), and `d` is the normalized outline.
 */
export function normalizeDrawOps(ops: ArrayLike<number>, m: Matrix, pageHeight: number): { d: string; bounds: Rect } {
  return normalizeSubpaths(drawOpsToPoints(ops, multiply([1, 0, 0, -1, 0, pageHeight], m)));
}

/** Normalize an SVG path (y down, such as a pool symbol `d`) the same way. */
export function normalizeSvgPath(d: string): string {
  return normalizeSubpaths(parseSvgPath(d)).d;
}

/**
 * The same SVG path with every `Q`/`T` converted to its exact cubic, as
 * absolute M/L/C/Z. pdf-lib's `drawSvgPath` draws `Q` as the PDF `v`
 * operator, which is not the quadratic, so the PDF writer passes symbols
 * through this first.
 */
export function toCubicSvgPath(d: string): string {
  const parts: string[] = [];
  for (const subpath of parseSvgPath(d)) {
    parts.push(`M${String(subpath.x)} ${String(subpath.y)}`);
    for (const s of subpath.segments) parts.push(`${s.length === 2 ? 'L' : 'C'}${s.join(' ')}`);
    if (subpath.closed) parts.push('Z');
  }
  return parts.join('');
}

/**
 * Hash of a normalized outline. Coordinates are quantized to 1/1000 of the
 * unit box before hashing, so printing noise below that does not split a
 * symbol; equal outlines at any size or position give equal keys because the
 * normalization has already removed both.
 */
export function outlineKey(normalizedD: string): string {
  const tokens = normalizedD.match(SVG_TOKEN) ?? [];
  // Two FNV-1a lanes with different offsets give a 64-bit key.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x9e3779b9;
  const feed = (text: string): void => {
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ code, 0x01000193);
      h2 = Math.imul(h2 ^ code, 0x01000193) ^ (h2 >>> 15);
    }
  };
  for (const token of tokens) {
    feed(/[a-zA-Z]/.test(token) ? token : `${String(Math.round(Number(token) * 1000) || 0)},`);
  }
  const hex = (h: number): string => (h >>> 0).toString(16).padStart(8, '0');
  return `o${hex(h1)}${hex(h2)}`;
}

// --- distance ----------------------------------------------------------

interface Shape {
  /** The outline flattened into polylines: the target of exact distances. */
  readonly polylines: readonly Float64Array[];
  /** Points about SAMPLE_SPACING apart along the outline: the queries. */
  readonly samples: Float64Array;
  /**
   * Distance from each node of a FIELD_SIZE² grid over the unit box to the
   * nearest sample, exact up to FIELD_REACH and capped there.
   */
  readonly field: Float32Array;
}

const CURVE_STEPS = 10;
const SAMPLE_SPACING = 0.02;
const MAX_SAMPLES = 512;
const FIELD_SIZE = 65;
const FIELD_REACH = 0.15;
/**
 * How far a field lookup can fall below the true distance: the outline can
 * pass half a sample spacing closer than the nearest sample, and bilinear
 * interpolation of a 1-Lipschitz function errs by up to half a grid diagonal.
 */
const FIELD_SLACK = SAMPLE_SPACING / 2 + Math.SQRT2 / (FIELD_SIZE - 1) / 2;
/** Distances the field cannot place at or above this are computed exactly. */
const EXACT_BELOW = 0.05;
const shapeCache = new Map<string, Shape>();

function flatten(subpath: Subpath): Float64Array {
  const points = [subpath.x, subpath.y];
  let px = subpath.x, py = subpath.y;
  for (const s of subpath.segments) {
    if (s.length === 2) {
      points.push(s[0], s[1]);
    } else {
      for (let k = 1; k <= CURVE_STEPS; k += 1) {
        const t = k / CURVE_STEPS;
        points.push(cubicAt(px, s[0], s[2], s[4], t), cubicAt(py, s[1], s[3], s[5], t));
      }
    }
    px = s[s.length - 2];
    py = s[s.length - 1];
  }
  if (subpath.closed) points.push(subpath.x, subpath.y);
  return Float64Array.from(points);
}

function lengthOf(points: Float64Array): number {
  let total = 0;
  for (let i = 2; i < points.length; i += 2) total += Math.hypot(points[i] - points[i - 2], points[i + 1] - points[i - 1]);
  return total;
}

/** `count` points evenly spaced by arc length along a polyline, both ends included. */
function resample(points: Float64Array, count: number, length: number, out: number[]): void {
  if (points.length < 4) {
    out.push(points[0], points[1]);
    return;
  }
  let walked = 0;
  let i = 2;
  for (let k = 0; k < count; k += 1) {
    const target = (length * k) / (count - 1);
    while (i < points.length - 2) {
      const step = Math.hypot(points[i] - points[i - 2], points[i + 1] - points[i - 1]);
      if (walked + step >= target) break;
      walked += step;
      i += 2;
    }
    const step = Math.hypot(points[i] - points[i - 2], points[i + 1] - points[i - 1]);
    const t = step === 0 ? 0 : Math.min(1, Math.max(0, (target - walked) / step));
    out.push(points[i - 2] + (points[i] - points[i - 2]) * t, points[i - 1] + (points[i + 1] - points[i - 1]) * t);
  }
}

function pointToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function nearestOnPolylines(polylines: readonly Float64Array[], x: number, y: number): number {
  let best = Infinity;
  for (const line of polylines) {
    if (line.length === 2) best = Math.min(best, Math.hypot(x - line[0], y - line[1]));
    for (let j = 2; j < line.length; j += 2) {
      const distance = pointToSegment(x, y, line[j - 2], line[j - 1], line[j], line[j + 1]);
      if (distance < best) best = distance;
    }
  }
  return best;
}

function shapeOf(d: string): Shape {
  const cached = shapeCache.get(d);
  if (cached) return cached;
  const polylines = parseSvgPath(d).map(flatten);
  const lengths = polylines.map(lengthOf);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const count = Math.min(MAX_SAMPLES, Math.ceil(total / SAMPLE_SPACING));
  const sampled: number[] = [];
  polylines.forEach((points, i) => {
    resample(points, Math.max(2, Math.round(total === 0 ? 2 : (count * lengths[i]) / total)), lengths[i], sampled);
  });
  const samples = Float64Array.from(sampled);
  // Each sample only lowers the nodes within reach, so building stays linear in samples.
  const field = new Float32Array(FIELD_SIZE * FIELD_SIZE).fill(FIELD_REACH);
  const scale = FIELD_SIZE - 1;
  const reach = Math.ceil(FIELD_REACH * scale);
  for (let k = 0; k < samples.length; k += 2) {
    const sx = samples[k], sy = samples[k + 1];
    const col0 = Math.round(sx * scale), row0 = Math.round(sy * scale);
    for (let row = Math.max(0, row0 - reach); row <= Math.min(scale, row0 + reach); row += 1) {
      for (let col = Math.max(0, col0 - reach); col <= Math.min(scale, col0 + reach); col += 1) {
        const distance = Math.hypot(col / scale - sx, row / scale - sy);
        const index = row * FIELD_SIZE + col;
        if (distance < field[index]) field[index] = distance;
      }
    }
  }
  const shape = { polylines, samples, field };
  if (shapeCache.size > 4096) shapeCache.clear();
  shapeCache.set(d, shape);
  return shape;
}

/** Bilinear lookup in a distance field; points outside the unit box add their distance to it. */
function fieldAt(field: Float32Array, x: number, y: number): number {
  const scale = FIELD_SIZE - 1;
  const cx = Math.min(1, Math.max(0, x));
  const cy = Math.min(1, Math.max(0, y));
  const fx = cx * scale, fy = cy * scale;
  const col = Math.min(scale - 1, Math.floor(fx));
  const row = Math.min(scale - 1, Math.floor(fy));
  const tx = fx - col, ty = fy - row;
  const at = (r: number, c: number): number => field[r * FIELD_SIZE + c];
  const top = at(row, col) * (1 - tx) + at(row, col + 1) * tx;
  const bottom = at(row + 1, col) * (1 - tx) + at(row + 1, col + 1) * tx;
  return top * (1 - ty) + bottom * ty + Math.hypot(x - cx, y - cy);
}

/** The farthest sample of `a` from `b`, estimated from `b`'s field or exact. */
function directed(a: Shape, b: Shape, exact: boolean): number {
  let worst = 0;
  for (let i = 0; i < a.samples.length; i += 2) {
    const x = a.samples[i], y = a.samples[i + 1];
    worst = Math.max(worst, exact ? nearestOnPolylines(b.polylines, x, y) : fieldAt(b.field, x, y));
  }
  return worst;
}

/**
 * Shape distance between two normalized outlines in unit-box units: the
 * sampled Hausdorff distance, the farthest any point sampled along one
 * outline lies from the other outline. 0 is the same shape. It ignores start
 * point, direction, subpath order and curve encoding (`Q` vs `C`). It is
 * exact below 0.05; above, it may be a distance-field estimate (capped near
 * 0.15), which only ever tells clearly different shapes apart. An empty
 * outline is 0 from another empty one and 1 from anything else.
 */
export function outlineDistance(a: string, b: string): number {
  if (a === b) return 0;
  const sa = shapeOf(a);
  const sb = shapeOf(b);
  if (sa.polylines.length === 0 || sb.polylines.length === 0) return sa.polylines.length === sb.polylines.length ? 0 : 1;
  const estimate = Math.max(directed(sa, sb, false), directed(sb, sa, false));
  if (estimate - FIELD_SLACK >= EXACT_BELOW) return estimate;
  return Math.max(directed(sa, sb, true), directed(sb, sa, true));
}
