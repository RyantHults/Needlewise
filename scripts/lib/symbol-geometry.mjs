/**
 * Cell-relative path geometry for the symbol pool.
 *
 * Outlines are authored in a unit cell centered on the origin, then measured,
 * normalized, and serialized. This module is build-time only and is never
 * bundled: the application consumes the generated path data, not this math.
 *
 * Commands are plain arrays so they stay JSON-serializable:
 *   ['M', x, y] ['L', x, y] ['C', x1, y1, x2, y2, x, y] ['Q', x1, y1, x, y] ['Z']
 */

/** Reduce curves to polylines this finely; enough for area and box measurement. */
export const FLATTEN_STEPS = 24;

/**
 * Split a path into polylines, one per contour, recording whether each is
 * closed. Curves are subdivided into straight segments so downstream
 * measurement only ever sees points. Closedness matters: only closed contours
 * enclose area, and only closed contours include the segment back to their
 * start.
 */
export function flatten(commands) {
  const contours = [];
  let points = null;
  let x = 0;
  let y = 0;
  const open = () => {
    if (points === null) points = [[x, y]];
    return points;
  };
  const close = (closed) => {
    if (points !== null && points.length > 1) contours.push({ points, closed });
    points = null;
  };
  for (const command of commands) {
    const op = command[0];
    if (op === 'M') {
      close(false);
      x = command[1];
      y = command[2];
      points = [[x, y]];
      continue;
    }
    if (op === 'Z') {
      open();
      close(true);
      continue;
    }
    if (op === 'L') {
      open();
      x = command[1];
      y = command[2];
      points.push([x, y]);
      continue;
    }
    if (op === 'C' || op === 'Q') {
      const target = open();
      const curve = op === 'C'
        ? bernsteinCubic(x, y, command[1], command[2], command[3], command[4], command[5], command[6])
        : bernsteinQuadratic(x, y, command[1], command[2], command[3], command[4]);
      for (const point of curve) target.push(point);
      x = command[command.length - 2];
      y = command[command.length - 1];
      continue;
    }
    open();
  }
  close(false);
  return contours;
}

/** Sample a cubic Bezier at fixed parameter steps, excluding the start point. */
function bernsteinCubic(x0, y0, x1, y1, x2, y2, x3, y3) {
  const points = [];
  for (let step = 1; step <= FLATTEN_STEPS; step += 1) {
    const t = step / FLATTEN_STEPS;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    points.push([a * x0 + b * x1 + c * x2 + d * x3, a * y0 + b * y1 + c * y2 + d * y3]);
  }
  return points;
}

/** Sample a quadratic Bezier at fixed parameter steps, excluding the start point. */
function bernsteinQuadratic(x0, y0, x1, y1, x2, y2) {
  const points = [];
  for (let step = 1; step <= FLATTEN_STEPS; step += 1) {
    const t = step / FLATTEN_STEPS;
    const u = 1 - t;
    const a = u * u;
    const b = 2 * u * t;
    const c = t * t;
    points.push([a * x0 + b * x1 + c * x2, a * y0 + b * y1 + c * y2]);
  }
  return points;
}

/**
 * Area actually covered by the nonzero fill rule.
 *
 * Summing the signed area of each contour is only correct when contours are
 * nested or disjoint. Clipping a shape to a half or quadrant adds a box that
 * partially overlaps it, and for those a signed sum is meaningless: a
 * half-square would report the full box area rather than half of it. So this
 * samples scanlines and accumulates the spans where the winding number is
 * non-zero, which is the same rule the canvas applies. It is exact for polygonal
 * shapes and runs a consistent few percent high on smooth convex ones, because
 * the midpoint rule overestimates there; that is well inside the tolerance of
 * the ink assertions this feeds, and the build is not a metrology tool.
 */
function filledArea(contours, samples) {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const contour of contours) {
    for (const [, y] of contour.points) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const height = maxY - minY;
  if (!(height > 0)) return 0;
  const rowHeight = height / samples;
  // Fill implicitly closes every subpath, so measure them all as closed.
  const edges = [];
  for (const contour of contours) {
    const points = contour.points;
    for (let index = 0; index < points.length; index += 1) {
      edges.push([points[index], points[(index + 1) % points.length]]);
    }
  }

  let area = 0;
  const crossings = [];
  for (let row = 0; row < samples; row += 1) {
    const y = minY + (row + 0.5) * rowHeight;
    crossings.length = 0;
    for (const [from, to] of edges) {
      const rising = to[1] > from[1];
      const lo = rising ? from[1] : to[1];
      const hi = rising ? to[1] : from[1];
      if (y < lo || y >= hi) continue;
      const t = (y - from[1]) / (to[1] - from[1]);
      crossings.push([from[0] + t * (to[0] - from[0]), rising ? 1 : -1]);
    }
    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a[0] - b[0]);
    let winding = 0;
    let runStart = 0;
    for (const [x, direction] of crossings) {
      const before = winding;
      winding += direction;
      if (before === 0 && winding !== 0) runStart = x;
      else if (before !== 0 && winding === 0) area += x - runStart;
    }
  }
  return area * rowHeight;
}
/** Apply a point transform to every coordinate pair in a path. */
function transformCommands(commands, transform) {
  return commands.map((command) => {
    if (command[0] === 'Z') return ['Z'];
    const out = [command[0]];
    for (let index = 1; index < command.length; index += 2) {
      const [x, y] = transform(command[index], command[index + 1]);
      out.push(x, y);
    }
    return out;
  });
}

/** Translate a path so the given point lands on the origin. */
export function centerOn(commands, cx, cy) {
  return transformCommands(commands, (x, y) => [x - cx, y - cy]);
}

/** Scale a path uniformly about the origin. */
export function scale(commands, factor) {
  return transformCommands(commands, (x, y) => [x * factor, y * factor]);
}

/**
 * Decimal places kept in generated path data. A unit cell is at most ~16 device
 * pixels, so this is orders of magnitude below a visible pixel while keeping
 * the committed artifact small and byte-stable.
 */
export const PRECISION = 4;

/** Scanlines per shape when sampling filled area. */
const AREA_SAMPLES = 256;

function formatNumber(value, precision = PRECISION) {
  const rounded = Number(value.toFixed(precision));
  // Avoid emitting "-0" for values that round to negative zero.
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/** Serialize commands to an SVG path data string with fixed precision. */
export function toPathData(commands, precision = PRECISION) {
  return commands
    .map((command) => {
      if (command[0] === 'Z') return 'Z';
      const rest = [];
      for (let index = 1; index < command.length; index += 1) {
        rest.push(formatNumber(command[index], precision));
      }
      return `${command[0]}${rest.join(' ')}`;
    })
    .join('');
}

/**
 * Parse path data back into the command form this module uses. The build only
 * ever writes M, L, C, Q and Z, so the parser stays deliberately narrow: it
 * exists so the committed artifact can be validated by the same measurement
 * code that produced it, rather than trusting that the writer was correct.
 */
export function parsePathData(d) {
  const tokens = d.match(/[MLCQZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  const commands = [];
  const arity = { M: 2, L: 2, C: 6, Q: 4, Z: 0 };
  let index = 0;
  while (index < tokens.length) {
    const letter = tokens[index];
    if (!(letter in arity)) throw new Error(`Unexpected path token "${letter}"`);
    const size = arity[letter];
    const values = tokens.slice(index + 1, index + 1 + size).map(Number);
    if (values.length !== size || values.some((value) => !Number.isFinite(value))) {
      throw new Error(`Malformed ${letter} command in path data`);
    }
    commands.push(size === 0 ? ['Z'] : [letter, ...values]);
    index += 1 + size;
  }
  return commands;
}

/**
 * Center and size an outline so the renderer needs nothing but one uniform
 * scale: no per-glyph offset, no per-glyph scale, no clipping.
 *
 * Extent is the primary invariant, not ink coverage. Equal coverage is not
 * reachable together with a bounded cell: a ring or a thin bar holds far less
 * ink than a filled disc, so matching a disc would need a 1.5-2.6x inflation
 * that overflows the cell, and clamping it back leaves the sparse shape
 * underweight. Sizing by extent instead makes every symbol the same overall
 * size, which is what keeps the chart legible and the grid regular.
 *
 * Ink is therefore reported rather than equalized: `inkArea` is the enclosed
 * area, and `weight` scales one definition's target extent when a shape needs
 * to sit visually heavier or lighter than its neighbours.
 */

/**
 * A shape's identity up to uniform scale, which is the most that can be
 * distinguished once extent normalization has run.
 *
 * Normalizing by extent is a similarity transform per shape, so two shapes
 * collapse to the same rendered outline whenever one is a scaled, centered copy
 * of the other. A 0.4 and a 0.6 corner of a square are both squares; every band
 * of a diamond measured from its tip is a similar triangle. Varying size within
 * one form therefore does not create a new symbol, and the pool has to be
 * deduplicated against this key rather than against the raw path.
 */
export function shapeKey(commands) {
  const normalized = normalizeOutline(commands, {
    targetExtent: 1,
    maxExtent: Infinity,
    minScale: 0,
    maxScale: Infinity
  });
  return toPathData(normalized.commands, 6);
}

/**
 * Center and size one outline into the shared unit cell.
 *
 * Every symbol is filled, so `inkArea` is simply the enclosed area the nonzero
 * fill rule covers. There is no stroke mode: a glyph contour is already the
 * solid silhouette of the mark, so stroking it would trace a border around an
 * already-filled shape.
 */
export function normalizeOutline(commands, options) {
  const { targetExtent, maxExtent, minScale, maxScale, weight = 1 } = options;
  const before = measure(commands);
  if (!(before.extent > 0)) throw new Error('Cannot normalize an outline with no measurable extent');
  const centered = centerOn(commands, before.cx, before.cy);
  const wanted = (targetExtent * weight) / before.extent;
  const appliedScale = Math.min(Math.max(wanted, minScale), maxScale);
  let scaled = scale(centered, appliedScale);
  let after = measure(scaled);
  if (after.extent > maxExtent) {
    scaled = scale(scaled, maxExtent / after.extent);
    after = measure(scaled);
  }
  return {
    commands: scaled,
    extent: after.extent,
    length: after.length,
    inkArea: after.area,
    appliedScale
  };
}

/**
 * Measure a path's box, filled area, center, and extent from its center.
 *
 * `area` is what the nonzero fill rule actually covers, so an inner contour
 * wound the other way carves a hole and a contour that partially overlaps
 * another is handled the way the canvas handles it.
 */
export function measure(commands) {
  const contours = flatten(commands);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let length = 0;
  for (const contour of contours) {
    for (const [px, py] of contour.points) {
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
    for (let index = 1; index < contour.points.length; index += 1) {
      const [ax, ay] = contour.points[index - 1];
      const [bx, by] = contour.points[index];
      length += Math.hypot(bx - ax, by - ay);
    }
    if (contour.closed && contour.points.length > 1) {
      const [sx, sy] = contour.points[0];
      const [ex, ey] = contour.points[contour.points.length - 1];
      length += Math.hypot(sx - ex, sy - ey);
    }
  }
  const area = contours.some((contour) => contour.points.length > 1) ? filledArea(contours, AREA_SAMPLES) : 0;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  let extent = 0;
  for (const contour of contours) {
    for (const [px, py] of contour.points) {
      const distance = Math.hypot(px - cx, py - cy);
      if (distance > extent) extent = distance;
    }
  }
  return { bbox: { minX, minY, maxX, maxY }, area, length, cx, cy, extent };
}
