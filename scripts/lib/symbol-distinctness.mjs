/**
 * Order the symbol pool so that symbols assigned early look as different from
 * each other as possible.
 *
 * Palette entries are auto-assigned pool symbols by id, so the pool's emission
 * order is the order a stitcher meets them in. A chart that uses eight colors
 * should get eight marks that cannot be confused at a glance, and that holds
 * for every prefix of the pool, not just the whole of it.
 *
 * Distance is measured on the rendered silhouette rather than on Unicode
 * metadata: two codepoints from different blocks can draw the same mark, and
 * two from one block can look nothing alike. This module is build-time only
 * and is never bundled.
 */
import { flatten, parsePathData } from './symbol-geometry.mjs';

/** Pixels per side of the reference raster each outline is filled into. */
const RASTER_SIZE = 240;

/**
 * The views compared, from fine to coarse. A chart cell is roughly 10-24
 * device pixels, so marks that differ only in detail finer than that are
 * confusable in use however distinct they look large. The 60px view is blurred
 * so that a one-pixel shift of an edge counts as a small difference rather than
 * a whole row of disagreeing pixels.
 */
const VIEWS = Object.freeze([
  { size: 60, blur: true },
  { size: 24, blur: false },
  { size: 12, blur: false }
]);

/** Gaussian blur applied to the finest view. */
const BLUR_SIGMA = 1;
const BLUR_RADIUS = 3;

/**
 * Fill a path into a square coverage raster over `[-tileView, tileView]`,
 * sampling pixel centers with the nonzero rule. Every contour is treated as
 * closed, because canvas fill implicitly closes each subpath.
 */
function rasterize(d, tileView) {
  const image = new Uint8Array(RASTER_SIZE * RASTER_SIZE);
  const step = (2 * tileView) / RASTER_SIZE;
  const rows = Array.from({ length: RASTER_SIZE }, () => []);
  for (const { points } of flatten(parsePathData(d))) {
    for (let index = 0; index < points.length; index += 1) {
      const [x0, y0] = points[index];
      const [x1, y1] = points[(index + 1) % points.length];
      if (y0 === y1) continue;
      const rising = y1 > y0;
      const lo = rising ? y0 : y1;
      const hi = rising ? y1 : y0;
      // Rows whose center y satisfies lo <= y < hi.
      const first = Math.max(0, Math.ceil((lo + tileView) / step - 0.5));
      const last = Math.min(RASTER_SIZE - 1, Math.ceil((hi + tileView) / step - 0.5) - 1);
      for (let row = first; row <= last; row += 1) {
        const y = -tileView + (row + 0.5) * step;
        if (y < lo || y >= hi) continue;
        const t = (y - y0) / (y1 - y0);
        rows[row].push(x0 + t * (x1 - x0), rising ? 1 : -1);
      }
    }
  }
  for (let row = 0; row < RASTER_SIZE; row += 1) {
    const flat = rows[row];
    if (flat.length < 4) continue;
    const crossings = [];
    for (let index = 0; index < flat.length; index += 2) crossings.push([flat[index], flat[index + 1]]);
    crossings.sort((a, b) => a[0] - b[0]);
    let winding = 0;
    let start = 0;
    for (const [x, direction] of crossings) {
      const before = winding;
      winding += direction;
      if (before === 0 && winding !== 0) start = x;
      else if (before !== 0 && winding === 0) fillSpan(image, row, start, x, tileView, step);
    }
  }
  return image;
}

/** Set the pixels of one row whose center x satisfies start <= x < end. */
function fillSpan(image, row, start, end, tileView, step) {
  const from = Math.max(0, Math.ceil((start + tileView) / step - 0.5));
  const to = Math.min(RASTER_SIZE, Math.ceil((end + tileView) / step - 0.5));
  image.fill(1, row * RASTER_SIZE + from, row * RASTER_SIZE + Math.max(from, to));
}

/** Average non-overlapping square blocks of the raster down to `size` per side. */
function boxDownsample(image, size) {
  const block = RASTER_SIZE / size;
  const out = new Float64Array(size * size);
  const norm = 1 / (block * block);
  for (let y = 0; y < RASTER_SIZE; y += 1) {
    const outRow = Math.floor(y / block) * size;
    const inRow = y * RASTER_SIZE;
    for (let x = 0; x < RASTER_SIZE; x += 1) {
      if (image[inRow + x]) out[outRow + Math.floor(x / block)] += norm;
    }
  }
  return out;
}

const BLUR_KERNEL = (() => {
  const kernel = new Float64Array(2 * BLUR_RADIUS + 1);
  let sum = 0;
  for (let offset = -BLUR_RADIUS; offset <= BLUR_RADIUS; offset += 1) {
    const weight = Math.exp(-(offset * offset) / (2 * BLUR_SIGMA * BLUR_SIGMA));
    kernel[offset + BLUR_RADIUS] = weight;
    sum += weight;
  }
  for (let index = 0; index < kernel.length; index += 1) kernel[index] /= sum;
  return kernel;
})();

/** Separable Gaussian blur of a square view, treating everything outside it as empty. */
function blur(view, size) {
  const pass = (source, horizontal) => {
    const out = new Float64Array(size * size);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        let total = 0;
        for (let offset = -BLUR_RADIUS; offset <= BLUR_RADIUS; offset += 1) {
          const sx = horizontal ? x + offset : x;
          const sy = horizontal ? y : y + offset;
          if (sx < 0 || sx >= size || sy < 0 || sy >= size) continue;
          total += BLUR_KERNEL[offset + BLUR_RADIUS] * source[sy * size + sx];
        }
        out[y * size + x] = total;
      }
    }
    return out;
  };
  return pass(pass(view, true), false);
}

/** Median of the strictly upper-triangle entries, or 1 when there is nothing to scale by. */
function offDiagonalMedian(matrix, n) {
  if (n < 2) return 1;
  const values = new Float64Array((n * (n - 1)) / 2);
  let cursor = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) values[cursor++] = matrix[i * n + j];
  }
  values.sort();
  const middle = values.length >> 1;
  const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  return median > 0 ? median : 1;
}

/**
 * Pairwise visual distance between filled outlines, as a symmetric n*n matrix
 * with a zero diagonal.
 *
 * Each view's distances are divided by that view's median pairwise distance
 * before the views are averaged, so the coarse views, whose vectors are short,
 * weigh as much as the fine one. The result is unitless: 1 is a typical pair.
 */
export function distanceMatrix(paths, tileView) {
  const n = paths.length;
  const result = new Float64Array(n * n);
  const images = paths.map((d) => rasterize(d, tileView));
  for (const { size, blur: blurred } of VIEWS) {
    // One contiguous buffer keeps the pairwise loop on a single typed array.
    const length = size * size;
    const views = new Float64Array(n * length);
    images.forEach((image, index) => {
      const view = boxDownsample(image, size);
      views.set(blurred ? blur(view, size) : view, index * length);
    });
    const distances = new Float64Array(n * n);
    for (let i = 0; i < n; i += 1) {
      const a = i * length;
      for (let j = i + 1; j < n; j += 1) {
        const b = j * length;
        let sum = 0;
        for (let index = 0; index < length; index += 1) {
          const delta = views[a + index] - views[b + index];
          sum += delta * delta;
        }
        const distance = Math.sqrt(sum);
        distances[i * n + j] = distance;
        distances[j * n + i] = distance;
      }
    }
    const median = offDiagonalMedian(distances, n);
    for (let index = 0; index < n * n; index += 1) result[index] += distances[index] / median / VIEWS.length;
  }
  return result;
}

/**
 * Order symbols so every prefix is as visually spread out as a greedy choice
 * can make it.
 *
 * The traversal starts from the two symbols farthest apart. Each next symbol is
 * the one whose nearest already-placed symbol is farthest away. That suits
 * auto-assignment by palette id, which consumes the pool from the front and
 * never knows how many colors a chart will end up with. Near-duplicates are
 * always some placed symbol's nearest neighbour, so they sink to the end.
 *
 * Ties fall to the larger summed distance to the placed set, then to input
 * order, so the result depends only on the input.
 */
export function orderByDistinctness(symbols, { tileView } = {}) {
  const n = symbols.length;
  if (n < 2) return symbols.slice();
  const matrix = distanceMatrix(
    symbols.map((symbol) => symbol.d),
    tileView
  );

  const placed = new Uint8Array(n);
  const order = [];
  const place = (index) => {
    placed[index] = 1;
    order.push(index);
  };
  let best = -1;
  let seed = [0, 1];
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (matrix[i * n + j] > best) {
        best = matrix[i * n + j];
        seed = [i, j];
      }
    }
  }
  place(seed[0]);
  place(seed[1]);

  const nearest = new Float64Array(n).fill(Infinity);
  const total = new Float64Array(n);
  const absorb = (from) => {
    for (let index = 0; index < n; index += 1) {
      const distance = matrix[from * n + index];
      if (distance < nearest[index]) nearest[index] = distance;
      total[index] += distance;
    }
  };
  for (const index of order) absorb(index);
  while (order.length < n) {
    let next = -1;
    for (let index = 0; index < n; index += 1) {
      if (placed[index]) continue;
      if (
        next === -1 ||
        nearest[index] > nearest[next] ||
        (nearest[index] === nearest[next] && total[index] > total[next])
      ) {
        next = index;
      }
    }
    place(next);
    absorb(next);
  }
  return order.map((index) => symbols[index]);
}
