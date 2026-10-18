import { describe, expect, it } from 'vitest';
import type { CatalogRecord } from '../catalog';
import { oklab, selectPaletteIndices } from './palette-selection';

type Rgb = readonly [number, number, number];

function records(colors: readonly Rgb[]): CatalogRecord[] {
  return colors.map((rgb, index) => ({
    sourceId: `c${String(index)}`,
    code: String(index),
    name: `Color ${String(index)}`,
    hex: `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`,
    rgb
  }));
}

/** Catalog index → count, from `[index, count]` pairs. */
const counts = (entries: readonly (readonly [number, number])[]): Map<number, number> => new Map(entries);

describe('oklab', () => {
  it('maps white and black to the ends of the lightness axis', () => {
    const white = oklab([255, 255, 255]);
    const black = oklab([0, 0, 0]);
    expect(white[0]).toBeCloseTo(1, 3);
    expect(white[1]).toBeCloseTo(0, 3);
    expect(white[2]).toBeCloseTo(0, 3);
    expect(black).toEqual([0, 0, 0]);
  });
});

describe('selectPaletteIndices', () => {
  it('picks the most-used color first', () => {
    const catalog = records([[255, 0, 0], [0, 255, 0], [0, 0, 255]]);
    expect(selectPaletteIndices(counts([[0, 10], [1, 30], [2, 20]]), catalog, 1)).toEqual([1]);
  });

  it('prefers a small distinct accent over a redundant near-shade with more pixels', () => {
    const catalog = records([[0, 0, 255], [10, 10, 250], [255, 0, 0]]);
    const usage = counts([[0, 1000], [1, 400], [2, 50]]);
    expect(selectPaletteIndices(usage, catalog, 2)).toEqual([0, 2]);
    expect(selectPaletteIndices(usage, catalog, 3)).toEqual([0, 2, 1]);
  });

  it('returns a stable prefix as the budget grows', () => {
    const colors: Rgb[] = [];
    const usage = new Map<number, number>();
    for (let index = 0; index < 16; index += 1) {
      colors.push([(index * 67) % 256, (index * 131) % 256, (index * 193) % 256]);
      usage.set(index, 20 + ((index * 37) % 50) * 10);
    }
    const catalog = records(colors);
    const full = selectPaletteIndices(usage, catalog, usage.size);
    expect(new Set(full).size).toBe(usage.size);
    for (let budget = 1; budget <= usage.size; budget += 1) {
      expect(selectPaletteIndices(usage, catalog, budget)).toEqual(full.slice(0, budget));
    }
    expect(selectPaletteIndices(usage, catalog, usage.size + 5)).toEqual(full);
    expect(selectPaletteIndices(usage, catalog, 0)).toEqual([]);
  });

  it('keeps a sub-floor singleton out while a real color remains', () => {
    const catalog = records([[0, 0, 255], [40, 40, 220], [255, 255, 0]]);
    // Floor is max(2, ceil(8001 * 0.0005)) = 5, so the vivid yellow singleton is noise.
    const usage = counts([[0, 5000], [1, 3000], [2, 1]]);
    expect(selectPaletteIndices(usage, catalog, 2)).toEqual([0, 1]);
  });

  it('fills the budget with sub-floor colors in descending count once real colors run out', () => {
    const catalog = records([[0, 0, 255], [255, 0, 0], [0, 255, 0], [255, 255, 0]]);
    const usage = counts([[0, 10000], [1, 1], [2, 3], [3, 3]]);
    expect(selectPaletteIndices(usage, catalog, 4)).toEqual([0, 2, 3, 1]);
  });

  it('treats every color as eligible when none meets the floor', () => {
    const catalog = records([[0, 0, 255], [10, 10, 250], [255, 0, 0]]);
    expect(selectPaletteIndices(counts([[0, 1], [1, 1], [2, 1]]), catalog, 2)).toEqual([0, 2]);
  });

  it('breaks ties by count, then by lower catalog index', () => {
    const catalog = records([[0, 0, 255], [0, 0, 255], [0, 0, 255], [0, 0, 255]]);
    // Identical colors give every later pick zero gain, so the tie order decides.
    const usage = counts([[3, 50], [2, 50], [1, 80], [0, 50]]);
    expect(selectPaletteIndices(usage, catalog, 4)).toEqual([1, 0, 2, 3]);
  });
});
