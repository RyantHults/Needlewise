import { CellKind, type PatternDocument } from '../domain';

/** Largest supported confetti distance; lower distances flag more stitches. */
export const MAX_CONFETTI_DISTANCE = 5;

type Rgb = readonly [number, number, number];

const NEIGHBOUR_OFFSETS: readonly (readonly [number, number])[] = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

function rgbDistance(left: Rgb, right: Rgb): number {
  const red = left[0] - right[0];
  const green = left[1] - right[1];
  const blue = left[2] - right[2];
  return red * red + green * green + blue * blue;
}

export function isConfettiDistance(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_CONFETTI_DISTANCE;
}

function hasSameColorWithin(ids: Uint16Array, width: number, height: number, x: number, y: number, distance: number): boolean {
  const id = ids[y * width + x];
  const top = Math.max(0, y - distance);
  const bottom = Math.min(height - 1, y + distance);
  const left = Math.max(0, x - distance);
  const right = Math.min(width - 1, x + distance);
  for (let row = top; row <= bottom; row += 1) {
    for (let column = left; column <= right; column += 1) {
      if ((row !== y || column !== x) && ids[row * width + column] === id) return true;
    }
  }
  return false;
}

/**
 * Mode of the eight immediate snapshot neighbours (out-of-bounds ignored, 0 =
 * empty). Ties go to the non-empty color closest in RGB to the original stitch
 * (then the lower palette id); empty only wins an outright majority. Returns
 * null when the cell has no in-bounds neighbours.
 */
function replacementFor(ids: Uint16Array, width: number, height: number, x: number, y: number, colorOf: (paletteId: number) => Rgb | undefined): number | null {
  const candidates: number[] = [];
  const counts: number[] = [];
  for (const [dx, dy] of NEIGHBOUR_OFFSETS) {
    const column = x + dx;
    const row = y + dy;
    if (column < 0 || row < 0 || column >= width || row >= height) continue;
    const id = ids[row * width + column];
    const slot = candidates.indexOf(id);
    if (slot < 0) {
      candidates.push(id);
      counts.push(1);
    } else {
      counts[slot] += 1;
    }
  }
  if (candidates.length === 0) return null;
  const original = colorOf(ids[y * width + x]);
  let best = -1;
  let bestCount = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let slot = 0; slot < candidates.length; slot += 1) {
    const id = candidates[slot];
    const count = counts[slot];
    if (count < bestCount) continue;
    const rgb = id === 0 ? undefined : colorOf(id);
    const distance = id === 0 ? Number.POSITIVE_INFINITY : rgb === undefined || original === undefined ? Number.MAX_VALUE : rgbDistance(rgb, original);
    if (count > bestCount || distance < bestDistance || (distance === bestDistance && id < best)) {
      best = id;
      bestCount = count;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Replace confetti stitches in place: a stitched cell is confetti when no
 * other cell with the same palette id lies within Chebyshev `distance`. Each
 * confetti cell takes the mode of its eight immediate neighbours. Detection
 * and replacement read a snapshot of the pre-pass document, so the result is
 * order-independent (no cascading). `usage` (palette id → stitch count) is
 * adjusted to match. Yields after every `chunk` cells so async callers can
 * check cancellation; the return value is the number of cells cleared to
 * empty.
 */
export function* reduceConfettiSteps(
  document: PatternDocument,
  distance: number,
  colorOf: (paletteId: number) => Rgb | undefined,
  usage: Map<number, number>,
  chunk: number
): Generator<void, number> {
  const { width, height } = document;
  const cellCount = width * height;
  const ids = new Uint16Array(cellCount);
  for (let index = 0; index < cellCount; index += 1) {
    if (document.kind[index] !== CellKind.Empty) ids[index] = document.colors[index * 4];
    if ((index + 1) % chunk === 0) yield;
  }
  let cleared = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const id = ids[index];
    const x = index % width;
    const y = (index - x) / width;
    if (id !== 0 && !hasSameColorWithin(ids, width, height, x, y, distance)) {
      const replacement = replacementFor(ids, width, height, x, y, colorOf);
      if (replacement !== null) {
        usage.set(id, (usage.get(id) ?? 0) - 1);
        if (replacement === 0) {
          document.kind[index] = CellKind.Empty;
          document.colors[index * 4] = 0;
          cleared += 1;
        } else {
          document.colors[index * 4] = replacement;
          usage.set(replacement, (usage.get(replacement) ?? 0) + 1);
        }
      }
    }
    if ((index + 1) % chunk === 0) yield;
  }
  return cleared;
}

/** Synchronous {@link reduceConfettiSteps}; returns the number of cells cleared to empty. */
export function reduceConfetti(
  document: PatternDocument,
  distance: number,
  colorOf: (paletteId: number) => Rgb | undefined,
  usage: Map<number, number>
): number {
  const steps = reduceConfettiSteps(document, distance, colorOf, usage, Number.POSITIVE_INFINITY);
  let step = steps.next();
  while (step.done !== true) step = steps.next();
  return step.value;
}
