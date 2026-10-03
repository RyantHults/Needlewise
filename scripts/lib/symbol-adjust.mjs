/**
 * Per-glyph adjustments the authored selection can carry: embolden, scale, and
 * offset, applied after extent normalization.
 *
 * Normalization makes every symbol the same overall size, but it cannot make a
 * hairline glyph carry the ink of its neighbours. An adjustment is the one
 * place a single symbol is tuned, and it is applied to the geometry in the
 * build, so the runtime still draws nothing but the generated path data. This
 * module is build-time only and is never bundled.
 */
import ClipperLib from 'clipper-lib';
import { centerOn, flatten, measure, scale } from './symbol-geometry.mjs';
import { formatEntry, parseEntry } from './selection.mjs';

/**
 * Clipper works in integers, so cell coordinates are scaled by this before
 * clipping and divided back after. A millionth of a cell is far below the
 * precision the artifact keeps, and integer math is what makes the offset
 * byte-stable across hosts.
 */
const CLIPPER_SCALE = 1e6;

/**
 * Largest distance, in scaled units, a round join's chords may stray from the
 * true arc: a quarter of the artifact's 0.001 cell precision, so the polygonal
 * approximation never shows in the written path.
 */
const ARC_TOLERANCE = 250;

/**
 * Largest distance, in scaled units, a simplified contour may stray from the
 * offset one: 0.0003 cell, below the artifact's 0.001 precision, so the
 * simplification cannot show at any chart size. Without it every flattened
 * curve segment survives the offset as its own vertex and an emboldened path
 * is an order of magnitude larger than its source.
 */
const SIMPLIFY_TOLERANCE = 300;

/** Miter limit Clipper requires; unused by round joins. */
const MITER_LIMIT = 2;

const DEFAULTS = Object.freeze({ embolden: 0, scale: 1, offset: Object.freeze([0, 0]) });
const FIELDS = Object.freeze(Object.keys(DEFAULTS));

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Read the selection's `adjustments` object into one entry per glyph, with
 * every field filled.
 *
 * Keys are canonicalized the same way selection entries are, so a hand-written
 * `u+0192` names the same glyph as `U+0192`. An adjustment for a glyph that is
 * not selected is an error rather than a no-op, because it would otherwise
 * silently stop applying the moment the glyph was re-added under another key.
 */
export function parseAdjustments(raw, selection) {
  const adjustments = new Map();
  if (raw === undefined) return adjustments;
  if (!isPlainObject(raw)) {
    throw new Error('Symbol adjustments must be an object keyed by "<font-slug>:U+XXXX" entries.');
  }
  const selected = new Set(selection.map((entry) => {
    const { font, codepoint } = parseEntry(entry);
    return formatEntry(font, codepoint);
  }));
  for (const [key, value] of Object.entries(raw)) {
    let canonical;
    try {
      const { font, codepoint } = parseEntry(key);
      canonical = formatEntry(font, codepoint);
    } catch (error) {
      throw new Error(`Adjustment key "${key}" is not a selection entry: ${error.message}`, { cause: error });
    }
    const fail = (message) => {
      throw new Error(`Adjustment for "${canonical}": ${message}`);
    };
    if (!selected.has(canonical)) fail('the glyph is not in the selection.');
    if (adjustments.has(canonical)) fail(`"${key}" names a glyph that is already adjusted.`);
    if (!isPlainObject(value)) fail('expected an object of { embolden, scale, offset }.');
    for (const field of Object.keys(value)) {
      if (!FIELDS.includes(field)) fail(`unknown field "${field}"; expected one of ${FIELDS.join(', ')}.`);
    }
    const { embolden = DEFAULTS.embolden, scale: factor = DEFAULTS.scale, offset = DEFAULTS.offset } = value;
    if (!Number.isFinite(embolden) || embolden < 0) {
      fail(`"embolden" must be a number >= 0, got ${JSON.stringify(embolden)}.`);
    }
    if (!Number.isFinite(factor) || factor <= 0) {
      fail(`"scale" must be a number > 0, got ${JSON.stringify(factor)}.`);
    }
    if (!Array.isArray(offset) || offset.length !== 2 || !offset.every(Number.isFinite)) {
      fail(`"offset" must be [dx, dy] with two finite numbers, got ${JSON.stringify(offset)}.`);
    }
    adjustments.set(canonical, { embolden, scale: factor, offset: [offset[0], offset[1]] });
  }
  return adjustments;
}

/**
 * Thicken a filled outline by offsetting it outward by `distance` cell units.
 *
 * The contours are first unioned under the nonzero rule, the same rule the
 * canvas fills with, so overlapping contours offset as one silhouette instead
 * of each growing on its own, and a counter wound against its outline stays a
 * hole that shrinks rather than a contour that fills. Joins are round, so a
 * thickened mark keeps its corners soft at small sizes rather than sprouting
 * spikes. Each resulting contour is then simplified within
 * `SIMPLIFY_TOLERANCE`.
 */
export function embolden(commands, distance) {
  if (distance === 0) return commands;
  const subject = flatten(commands).map(({ points }) =>
    points.map(([x, y]) => ({ X: Math.round(x * CLIPPER_SCALE), Y: Math.round(y * CLIPPER_SCALE) }))
  );
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
  const union = [];
  clipper.Execute(
    ClipperLib.ClipType.ctUnion,
    union,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero
  );
  const offsetter = new ClipperLib.ClipperOffset(MITER_LIMIT, ARC_TOLERANCE);
  offsetter.AddPaths(union, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const grown = [];
  offsetter.Execute(grown, distance * CLIPPER_SCALE);

  const out = [];
  for (const path of grown.map(simplifyClosed)) {
    path.forEach(({ X, Y }, index) => out.push([index === 0 ? 'M' : 'L', X / CLIPPER_SCALE, Y / CLIPPER_SCALE]));
    out.push(['Z']);
  }
  return out;
}

/**
 * Douglas-Peucker simplification of a closed contour.
 *
 * A closed contour has no endpoints, so it is split at its first point and the
 * point farthest from it, and each half is simplified as an open chain. Both
 * anchors depend only on the input order, so the result is deterministic. A
 * contour that would collapse below three points is kept as it is.
 */
function simplifyClosed(path) {
  const n = path.length;
  if (n <= 3) return path;
  let far = 0;
  let farthest = -1;
  for (let index = 1; index < n; index += 1) {
    const distance = Math.hypot(path[index].X - path[0].X, path[index].Y - path[0].Y);
    if (distance > farthest) {
      farthest = distance;
      far = index;
    }
  }
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[far] = 1;
  const at = (index) => path[index % n];
  const stack = [[0, far], [far, n]];
  while (stack.length > 0) {
    const [from, to] = stack.pop();
    const a = at(from);
    const b = at(to);
    const length = Math.hypot(b.X - a.X, b.Y - a.Y);
    let worst = -1;
    let worstDistance = SIMPLIFY_TOLERANCE;
    for (let index = from + 1; index < to; index += 1) {
      const p = at(index);
      const distance = length === 0
        ? Math.hypot(p.X - a.X, p.Y - a.Y)
        : Math.abs((b.X - a.X) * (a.Y - p.Y) - (a.X - p.X) * (b.Y - a.Y)) / length;
      if (distance > worstDistance) {
        worstDistance = distance;
        worst = index;
      }
    }
    if (worst !== -1) {
      keep[worst] = 1;
      stack.push([from, worst], [worst, to]);
    }
  }
  const simplified = path.filter((_, index) => keep[index]);
  return simplified.length >= 3 ? simplified : path;
}

/**
 * Apply one glyph's adjustment to its already-normalized outline.
 *
 * Emboldening grows the extent, so the result is re-centered and scaled
 * uniformly back to the extent it had before, and a bolder glyph stays its
 * own size rather than outgrowing its neighbours. That is the extent the
 * outline arrived with, not the pool's target: a small mark that
 * normalization deliberately left below the target stays small.
 * Scale is about the cell center and offset moves the glyph in cell units,
 * +x right and +y down. Ink past `tileView` would be cropped by the tile, so
 * that is an error; the caller names the glyph.
 */
export function applyAdjustment(commands, adjustment, normalization) {
  const { embolden: distance, scale: factor, offset: [dx, dy] } = adjustment;
  let adjusted = commands;
  if (distance > 0) {
    const before = measure(adjusted);
    const grown = embolden(adjusted, distance);
    const after = measure(grown);
    adjusted = scale(centerOn(grown, after.cx, after.cy), before.extent / after.extent);
  }
  if (factor !== 1) adjusted = scale(adjusted, factor);
  // Centering on (-dx, -dy) moves the origin, and so the glyph, by (dx, dy).
  if (dx !== 0 || dy !== 0) adjusted = centerOn(adjusted, -dx, -dy);
  for (const command of adjusted) {
    for (let index = 1; index < command.length; index += 1) {
      if (Math.abs(command[index]) > normalization.tileView) {
        throw new Error(
          `The adjusted outline reaches ${command[index]}, outside the tile's ±${normalization.tileView}, so the tile would crop it.`
        );
      }
    }
  }
  return adjusted;
}
