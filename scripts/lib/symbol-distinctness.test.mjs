import { describe, expect, it } from 'vitest';
import { distanceMatrix, orderByDistinctness } from './symbol-distinctness.mjs';

const TILE_VIEW = 0.5;
const SQUARE = 'M-0.4 -0.4L0.4 -0.4L0.4 0.4L-0.4 0.4Z';
const TRIANGLE = 'M0 -0.4L0.4 0.4L-0.4 0.4Z';
const BAR = 'M-0.4 -0.1L0.4 -0.1L0.4 0.1L-0.4 0.1Z';
const POST = 'M-0.1 -0.4L0.1 -0.4L0.1 0.4L-0.1 0.4Z';
const DOT = 'M-0.1 -0.1L0.1 -0.1L0.1 0.1L-0.1 0.1Z';
const RING = `${SQUARE}M-0.2 -0.2L-0.2 0.2L0.2 0.2L0.2 -0.2Z`;

const symbol = (codepoint, d) => ({ id: `s-${codepoint.toString(16)}`, codepoint, d });

describe('distanceMatrix', () => {
  it('is symmetric with a zero diagonal, and identical paths are at distance 0', () => {
    const paths = [SQUARE, TRIANGLE, SQUARE, BAR];
    const n = paths.length;

    const matrix = distanceMatrix(paths, TILE_VIEW);

    expect(matrix).toHaveLength(n * n);
    for (let i = 0; i < n; i += 1) {
      expect(matrix[i * n + i]).toBe(0);
      for (let j = 0; j < n; j += 1) expect(matrix[i * n + j]).toBe(matrix[j * n + i]);
    }
    expect(matrix[0 * n + 2]).toBe(0);
    expect(matrix[0 * n + 1]).toBeGreaterThan(0);
  });

  it('treats an opposite-winding inner contour as a hole', () => {
    const [, solidToRing] = distanceMatrix([SQUARE, RING], TILE_VIEW);

    expect(solidToRing).toBeGreaterThan(0);
  });

  it('returns an empty matrix for no paths', () => {
    expect(distanceMatrix([], TILE_VIEW)).toHaveLength(0);
  });
});

describe('orderByDistinctness', () => {
  it('starts from the farthest-apart pair', () => {
    const paths = [SQUARE, TRIANGLE, BAR, POST, DOT, RING];
    const symbols = paths.map((d, index) => symbol(0x41 + index, d));
    const n = paths.length;
    const matrix = distanceMatrix(paths, TILE_VIEW);
    let farthest = [0, 1];
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        if (matrix[i * n + j] > matrix[farthest[0] * n + farthest[1]]) farthest = [i, j];
      }
    }

    const ordered = orderByDistinctness(symbols, { tileView: TILE_VIEW });

    expect(ordered.slice(0, 2)).toEqual(farthest.map((index) => symbols[index]));
  });

  it('sorts a duplicate shape after the distinct ones', () => {
    const symbols = [symbol(0x41, SQUARE), symbol(0x42, SQUARE), symbol(0x43, TRIANGLE)];

    const ordered = orderByDistinctness(symbols, { tileView: TILE_VIEW });

    expect(ordered.slice(0, 2).map((entry) => entry.codepoint)).toEqual([0x41, 0x43]);
    expect(ordered[2].codepoint).toBe(0x42);
  });

  it('returns a permutation of the same objects', () => {
    const symbols = [SQUARE, TRIANGLE, BAR, POST, DOT, RING].map((d, index) => symbol(0x41 + index, d));

    const ordered = orderByDistinctness(symbols, { tileView: TILE_VIEW });

    expect(ordered).not.toBe(symbols);
    expect(ordered).toHaveLength(symbols.length);
    expect(new Set(ordered)).toEqual(new Set(symbols));
  });

  it('handles empty and single inputs', () => {
    const only = symbol(0x41, SQUARE);

    expect(orderByDistinctness([], { tileView: TILE_VIEW })).toEqual([]);
    expect(orderByDistinctness([only], { tileView: TILE_VIEW })).toEqual([only]);
  });

  it('depends only on the input', () => {
    const symbols = [SQUARE, TRIANGLE, BAR, POST, DOT, RING, SQUARE].map((d, index) => symbol(0x41 + index, d));
    const copy = symbols.map((entry) => ({ ...entry }));

    const ids = (list) => orderByDistinctness(list, { tileView: TILE_VIEW }).map((entry) => entry.id);

    expect(ids(copy)).toEqual(ids(symbols));
  });
});
