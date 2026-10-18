import type { CatalogRecord } from '../catalog';

/** Share of matched pixels a color needs before it may take a palette slot. */
const NOISE_FLOOR_SHARE = 0.0005;

function linear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** sRGB 0..255 → OKLab (L 0..1). */
export function oklab(rgb: readonly [number, number, number]): [number, number, number] {
  const r = linear(rgb[0]);
  const g = linear(rgb[1]);
  const b = linear(rgb[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720453 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ];
}

/**
 * Deterministic palette selection shared by every conversion path. `counts`
 * maps catalog index → matched pixel count; the result is up to `budget`
 * catalog indices in pick order, and palette ids are assigned 1..N in that
 * order.
 *
 * The first pick is the most-used color. Each next pick is the one that most
 * reduces Σ count × OKLab distance from every matched color to its nearest
 * pick, so a small but distinct accent beats a near-shade of an already picked
 * gradient that has many more pixels. Ties go to the higher count, then the
 * lower catalog index. Picks are greedy and independent of the budget, so the
 * result is a stable prefix: raising the budget only adds the next pick.
 *
 * Colors below a noise floor (max(2, 0.05% of matched pixels)) still count
 * toward the error but are only picked once every eligible color is, in
 * descending count, so stray pixels cannot take a slot. When nothing meets the
 * floor (tiny rasters), every color is eligible.
 */
export function selectPaletteIndices(counts: ReadonlyMap<number, number>, records: readonly CatalogRecord[], budget: number): number[] {
  // Count-descending, index-ascending order makes "first strictly better" the tie-break.
  const indices = [...counts.keys()].sort((left, right) => (counts.get(right) ?? 0) - (counts.get(left) ?? 0) || left - right);
  const size = indices.length;
  const limit = Math.min(Math.max(0, Math.floor(budget)), size);
  if (limit === 0) return [];

  const weights = new Float64Array(size);
  let total = 0;
  indices.forEach((index, position) => {
    weights[position] = counts.get(index) ?? 0;
    total += weights[position];
  });
  const floor = Math.max(2, Math.ceil(total * NOISE_FLOOR_SHARE));
  const eligible = new Uint8Array(size);
  let anyEligible = false;
  for (let position = 0; position < size; position += 1) {
    if (weights[position] >= floor) {
      eligible[position] = 1;
      anyEligible = true;
    }
  }
  if (!anyEligible) eligible.fill(1);

  const lab = indices.map((index) => oklab(records[index].rgb));
  const distances = new Float64Array(size * size);
  for (let i = 0; i < size; i += 1) {
    for (let j = i + 1; j < size; j += 1) {
      const distance = Math.hypot(lab[i][0] - lab[j][0], lab[i][1] - lab[j][1], lab[i][2] - lab[j][2]) * 100;
      distances[i * size + j] = distance;
      distances[j * size + i] = distance;
    }
  }

  const picked = new Uint8Array(size);
  const nearest = new Float64Array(size).fill(Number.POSITIVE_INFINITY);
  const result: number[] = [];
  const take = (position: number): void => {
    picked[position] = 1;
    result.push(indices[position]);
    const row = position * size;
    for (let i = 0; i < size; i += 1) nearest[i] = Math.min(nearest[i], distances[row + i]);
  };

  // Eligible colors first: the most-used, then the greatest error reduction.
  while (result.length < limit) {
    let best = -1;
    let bestGain = -1;
    for (let candidate = 0; candidate < size; candidate += 1) {
      if (picked[candidate] || !eligible[candidate]) continue;
      if (result.length === 0) {
        best = candidate;
        break;
      }
      const row = candidate * size;
      let gain = 0;
      for (let i = 0; i < size; i += 1) {
        const reduction = nearest[i] - distances[row + i];
        if (reduction > 0) gain += weights[i] * reduction;
      }
      if (gain > bestGain) {
        best = candidate;
        bestGain = gain;
      }
    }
    if (best === -1) break;
    take(best);
  }
  // Then sub-floor colors in count order, so the budget is still honoured.
  for (let position = 0; position < size && result.length < limit; position += 1) {
    if (!picked[position]) take(position);
  }
  return result;
}
