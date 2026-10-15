// Cell lattice detection from a page's axis-aligned strokes (and thin fills,
// which some generators use to draw grid lines). Pure: no pdf.js import.
import type { PdfGrid, PdfPagePrimitives } from './types';

/** Smallest lattice, in cells per axis, that counts as a chart grid. */
const MIN_CELLS = 10;
/** Pitches below this are hatching or text decoration, not stitch cells. */
const MIN_PITCH = 2;
/** A step may differ from the running pitch by this fraction and still be uniform. */
const PITCH_TOLERANCE = 0.12;
/** Line positions within half the thinner stroke width (or this many points) are one line. */
const MIN_CLUSTER_TOLERANCE = 0.25;
/** A fill this many times longer than thick is a line candidate. */
const THIN_FILL_ASPECT = 10;
/** A thin fill only counts as a grid line when it is at most this fraction of the pitch thick. */
const THIN_FILL_MAX_PITCH = 0.15;
/** An end line must reach this fraction of the lattice's other extent, and be crossed by this fraction of the other axis's lines. */
const SPAN_FRACTION = 0.8;
const CROSSING_FRACTION = 0.5;
/** Heavier lines must be at least this many times wider than the thinnest to mark major lines. */
const MAJOR_WIDTH_RATIO = 1.3;

interface Segment {
  /** Position across the line (y of a horizontal line, x of a vertical one). */
  readonly at: number;
  readonly from: number;
  readonly to: number;
  readonly width: number;
  readonly fromFill: boolean;
}

interface Line {
  at: number;
  /** Thinnest member width, for the clustering tolerance. */
  minWidth: number;
  /** Heaviest member width, for major-line detection. */
  maxWidth: number;
  /** Merged coverage along the line, sorted and disjoint. */
  spans: Array<[number, number]>;
  members: number;
}

function addSpan(spans: Array<[number, number]>, from: number, to: number): void {
  spans.push([from, to]);
  spans.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1] + MIN_CLUSTER_TOLERANCE) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  spans.splice(0, spans.length, ...merged);
}

/** Length of `line` covered between `lo` and `hi`. */
function coverage(line: Line, lo: number, hi: number): number {
  let total = 0;
  for (const [from, to] of line.spans) total += Math.max(0, Math.min(to, hi) - Math.max(from, lo));
  return total;
}

function covers(line: Line, at: number, tolerance: number): boolean {
  return line.spans.some(([from, to]) => at >= from - tolerance && at <= to + tolerance);
}

function cluster(segments: readonly Segment[]): Line[] {
  const sorted = [...segments].sort((a, b) => a.at - b.at);
  const lines: Line[] = [];
  for (const segment of sorted) {
    const last = lines[lines.length - 1];
    const tolerance = last ? Math.max(0.5 * Math.min(last.minWidth, segment.width), MIN_CLUSTER_TOLERANCE) : 0;
    if (last && segment.at - last.at <= tolerance) {
      last.at = (last.at * last.members + segment.at) / (last.members + 1);
      last.members += 1;
      last.minWidth = Math.min(last.minWidth, segment.width);
      last.maxWidth = Math.max(last.maxWidth, segment.width);
      addSpan(last.spans, segment.from, segment.to);
    } else {
      lines.push({ at: segment.at, minWidth: segment.width, maxWidth: segment.width, spans: [[segment.from, segment.to]], members: 1 });
    }
  }
  return lines;
}

function nearest(lines: readonly Line[], at: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].at < at) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(lines[lo - 1].at - at) <= Math.abs(lines[lo].at - at)) return lo - 1;
  return lo;
}

/**
 * The longest run of lines at a nearly uniform pitch. Each step must land
 * within `PITCH_TOLERANCE` of the running mean pitch, so stray lines between
 * lattice lines are skipped rather than breaking the run.
 */
function longestRun(lines: readonly Line[]): Line[] {
  let best: Line[] = [];
  let bestError = Infinity;
  for (let i = 0; i < lines.length; i += 1) {
    // Try the next two lines as the first step, so one stray line after the start is tolerated.
    for (let j = i + 1; j <= i + 2 && j < lines.length; j += 1) {
      let pitch = lines[j].at - lines[i].at;
      if (pitch < MIN_PITCH) continue;
      const run = [lines[i]];
      let error = 0;
      for (;;) {
        const target = run[run.length - 1].at + pitch;
        const next = lines[nearest(lines, target)];
        const miss = Math.abs(next.at - target);
        if (next.at <= run[run.length - 1].at || miss > PITCH_TOLERANCE * pitch) break;
        run.push(next);
        error += miss;
        pitch = (next.at - run[0].at) / (run.length - 1);
      }
      if (run.length > best.length || (run.length === best.length && error < bestError)) {
        best = run;
        bestError = error;
      }
    }
  }
  return best;
}

/**
 * Drop end lines that do not belong to the lattice: lines that do not span the
 * other axis's extent, or that the other axis's lines do not reach (a page
 * frame or table rule that happens to sit one pitch past the grid).
 */
function trimEnds(run: Line[], across: readonly Line[], tolerance: number): Line[] {
  if (across.length < 2) return run;
  const lo = across[0].at;
  const hi = across[across.length - 1].at;
  const belongs = (line: Line): boolean =>
    coverage(line, lo, hi) >= SPAN_FRACTION * (hi - lo) &&
    across.filter((other) => covers(other, line.at, tolerance)).length >= CROSSING_FRACTION * across.length;
  let start = 0;
  let end = run.length;
  while (start < end && !belongs(run[start])) start += 1;
  while (end > start && !belongs(run[end - 1])) end -= 1;
  return run.slice(start, end);
}

function lattice(horizontal: readonly Segment[], vertical: readonly Segment[]): { xs: Line[]; ys: Line[] } | null {
  const hLines = cluster(horizontal);
  const vLines = cluster(vertical);
  let xs = longestRun(vLines);
  let ys = longestRun(hLines);
  for (let pass = 0; pass < 4; pass += 1) {
    if (xs.length < 2 || ys.length < 2) return null;
    const pitch = Math.min((xs[xs.length - 1].at - xs[0].at) / (xs.length - 1), (ys[ys.length - 1].at - ys[0].at) / (ys.length - 1));
    const tolerance = PITCH_TOLERANCE * pitch;
    const nextXs = trimEnds(xs, ys, tolerance);
    const nextYs = trimEnds(ys, xs, tolerance);
    if (nextXs.length === xs.length && nextYs.length === ys.length) break;
    xs = nextXs;
    ys = nextYs;
  }
  if (xs.length < MIN_CELLS + 1 || ys.length < MIN_CELLS + 1) return null;
  return { xs, ys };
}

/** Spacing in cells of the heavier lines, from both axes; undefined without a consistent signal. */
function detectMajorEvery(axes: ReadonlyArray<readonly Line[]>): number | undefined {
  const widths = axes.flat().map((line) => line.maxWidth);
  const thin = Math.min(...widths);
  const heavy = Math.max(...widths);
  if (heavy < thin * MAJOR_WIDTH_RATIO) return undefined;
  const threshold = (thin + heavy) / 2;
  const votes = new Map<number, number>();
  for (const lines of axes) {
    // The lattice border is often drawn heavier regardless of the major interval, so ends do not vote.
    const indices = lines.map((line, i) => (i > 0 && i < lines.length - 1 && line.maxWidth >= threshold ? i : -1)).filter((i) => i >= 0);
    for (let k = 1; k < indices.length; k += 1) {
      const gap = indices[k] - indices[k - 1];
      votes.set(gap, (votes.get(gap) ?? 0) + 1);
    }
  }
  let best: number | undefined;
  let bestVotes = 0;
  let total = 0;
  for (const [gap, count] of votes) {
    total += count;
    if (count > bestVotes || (count === bestVotes && best !== undefined && gap < best)) {
      best = gap;
      bestVotes = count;
    }
  }
  return best !== undefined && best > 1 && bestVotes * 2 > total ? best : undefined;
}

/**
 * Detect the stitch-cell lattice on a page. Returns null unless at least a
 * 10x10 lattice of nearly uniform pitch is found.
 */
export function detectGrid(page: PdfPagePrimitives): PdfGrid | null {
  const horizontal: Segment[] = [];
  const vertical: Segment[] = [];
  for (const stroke of page.strokes) {
    const dx = Math.abs(stroke.x2 - stroke.x1);
    const dy = Math.abs(stroke.y2 - stroke.y1);
    if (dx === 0 && dy === 0) continue;
    if (dx >= dy) {
      horizontal.push({ at: (stroke.y1 + stroke.y2) / 2, from: Math.min(stroke.x1, stroke.x2), to: Math.max(stroke.x1, stroke.x2), width: stroke.width, fromFill: false });
    } else {
      vertical.push({ at: (stroke.x1 + stroke.x2) / 2, from: Math.min(stroke.y1, stroke.y2), to: Math.max(stroke.y1, stroke.y2), width: stroke.width, fromFill: false });
    }
  }
  for (const { bounds } of page.fills) {
    if (bounds.width >= bounds.height * THIN_FILL_ASPECT) {
      horizontal.push({ at: bounds.y + bounds.height / 2, from: bounds.x, to: bounds.x + bounds.width, width: bounds.height, fromFill: true });
    } else if (bounds.height >= bounds.width * THIN_FILL_ASPECT) {
      vertical.push({ at: bounds.x + bounds.width / 2, from: bounds.y, to: bounds.y + bounds.height, width: bounds.width, fromFill: true });
    }
  }

  // The first pass finds the pitch; the second drops fills too thick to be grid lines at that pitch.
  const first = lattice(horizontal, vertical);
  if (!first) return null;
  const roughPitch = (first.xs[first.xs.length - 1].at - first.xs[0].at) / (first.xs.length - 1);
  const thin = (segment: Segment): boolean => !segment.fromFill || segment.width <= THIN_FILL_MAX_PITCH * roughPitch;
  const found = horizontal.every(thin) && vertical.every(thin) ? first : lattice(horizontal.filter(thin), vertical.filter(thin));
  if (!found) return null;

  const xs = found.xs.map((line) => line.at);
  const ys = found.ys.map((line) => line.at);
  const columns = xs.length - 1;
  const rows = ys.length - 1;
  const width = xs[columns] - xs[0];
  const height = ys[rows] - ys[0];
  const majorEvery = detectMajorEvery([found.xs, found.ys]);
  return {
    xs,
    ys,
    columns,
    rows,
    pitch: (width / columns + height / rows) / 2,
    bounds: { x: xs[0], y: ys[0], width, height },
    ...(majorEvery !== undefined ? { majorEvery } : {})
  };
}
