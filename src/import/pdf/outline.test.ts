import { describe, expect, it } from 'vitest';
import { SYMBOL_POOL } from '../../symbols';
import {
  drawOpsToPoints,
  multiply,
  normalizeDrawOps,
  normalizeSvgPath,
  outlineDistance,
  outlineKey,
  roundToFloat16,
  subpathBounds,
  toCubicSvgPath,
  type Matrix
} from './outline';

const M = 0, L = 1, C = 2, Q = 3, Z = 4;

/** A diamond with one curved side, as a DrawOps buffer in em units (y up). */
const glyph = [M, 0.1, 0.35, L, 0.35, 0.1, Q, 0.6, 0.35, 0.35, 0.6, L, 0.1, 0.35, Z];

describe('multiply', () => {
  it('applies the right matrix first, like pdf.js Util.transform', () => {
    const translate: Matrix = [1, 0, 0, 1, 10, 20];
    const scale: Matrix = [2, 0, 0, 3, 0, 0];
    // Scale, then translate.
    expect(multiply(translate, scale)).toEqual([2, 0, 0, 3, 10, 20]);
    // Translate, then scale.
    expect(multiply(scale, translate)).toEqual([2, 0, 0, 3, 20, 60]);
  });
});

describe('roundToFloat16', () => {
  it('rounds to the nearest half float, ties to even', () => {
    expect(Array.from(roundToFloat16([0, 1, -2, 1 / 3, 65504, 70000, 2049, 2051, 1e-9, 6e-8]))).toEqual([
      0, 1, -2, 0.333251953125, 65504, Infinity, 2048, 2052, 0, 2 ** -24
    ]);
  });

  it('gives the same values from Float32 and float64 sources', () => {
    const source = glyph.map((v) => v * 0.73 + 0.0001);
    expect(Array.from(roundToFloat16(Float32Array.from(source)))).toEqual(Array.from(roundToFloat16(source)));
  });
});

describe('drawOpsToPoints', () => {
  it('maps points, elevates quadratics and keeps subpaths', () => {
    const subpaths = drawOpsToPoints([M, 0, 0, L, 1, 0, Q, 1, 1, 0, 1, Z, M, 5, 5, L, 6, 5], [2, 0, 0, 2, 10, 0]);
    expect(subpaths).toHaveLength(2);
    expect(subpaths[0]).toMatchObject({ x: 10, y: 0, closed: true });
    // Q from (12, 0) via (12, 2) to (10, 2), elevated exactly.
    expect(subpaths[0].segments[1]).toEqual([12, 4 / 3, 34 / 3, 2, 10, 2]);
    expect(subpaths[1]).toMatchObject({ x: 20, y: 10, closed: false });
  });

  it('measures exact curve bounds', () => {
    // A quarter-circle-like bulge peaks at x = 0.75 for this cubic.
    const bounds = subpathBounds(drawOpsToPoints([M, 0, 0, C, 1, 0, 1, 1, 0, 1], [1, 0, 0, 1, 0, 0]));
    expect(bounds?.width).toBeCloseTo(0.75, 10);
    expect(bounds?.height).toBeCloseTo(1, 10);
  });
});

describe('normalization', () => {
  it('removes size and position and flips into y-down page space', () => {
    const small = normalizeDrawOps(glyph, [12, 0, 0, 12, 100, 500], 792);
    const large = normalizeDrawOps(glyph, [30, 0, 0, 30, 7, 20], 792);
    expect(large.d).toBe(small.d);
    expect(small.bounds.x).toBeCloseTo(100 + 0.1 * 12, 10);
    // The top of the ink (em y 0.6) is nearest the top of the page.
    expect(small.bounds.y).toBeCloseTo(792 - (500 + 0.6 * 12), 10);
    // The quadratic bulges to x = 0.475, short of its control point.
    expect(small.bounds.width).toBeCloseTo(0.375 * 12, 10);
  });

  it('matches the SVG form of the same outline, including Q vs C', () => {
    const fromOps = normalizeDrawOps(glyph, [1, 0, 0, 1, 0, 0], 1).d;
    // The same shape in y-down SVG with the quadratic written as its cubic.
    const c1 = [0.35 + (2 / 3) * 0.25, 0.9 - (2 / 3) * 0.25];
    const c2 = [0.35 + (2 / 3) * 0.25, 0.4 + (2 / 3) * 0.25];
    const svg = `M0.1 0.65L0.35 0.9C${c1.join(' ')} ${c2.join(' ')} 0.35 0.4L0.1 0.65Z`;
    expect(normalizeSvgPath(svg)).toBe(fromOps);
    expect(normalizeSvgPath('M0.1 0.65 l0.25 0.25 q0.25 -0.25 0 -0.5 L0.1 0.65 z')).toBe(fromOps);
  });

  it('fits the longer side to the unit box and centers the shorter one', () => {
    expect(normalizeSvgPath('M0 0H4V2H0Z')).toBe('M0 0.25L1 0.25L1 0.75L0 0.75Z');
  });
});

describe('toCubicSvgPath', () => {
  it('rewrites quadratics as their exact cubics in absolute coordinates', () => {
    expect(toCubicSvgPath('M0 0Q3 3 6 0T12 0l1 1z')).toBe('M0 0C2 2 4 2 6 0C8 -2 10 -2 12 0L13 1Z');
  });

  it('keeps the shape', () => {
    for (const entry of SYMBOL_POOL) {
      expect(normalizeSvgPath(toCubicSvgPath(entry.d))).toBe(normalizeSvgPath(entry.d));
    }
  });
});

describe('outlineKey', () => {
  it('is equal for the same glyph from Float16 and Float32 buffers at any size and position', () => {
    const em = scaleCoordinates(glyph, 0.917);
    // What a browser receives: values already rounded to half precision.
    const half = roundToFloat16(em);
    const keys = [
      normalizeDrawOps(roundToFloat16(Float32Array.from(em)), [11, 0, 0, 11, 40, 300], 792).d,
      normalizeDrawOps(roundToFloat16(half), [11, 0, 0, 11, 40, 300], 792).d,
      normalizeDrawOps(roundToFloat16(Float32Array.from(em)), [7.5, 0, 0, 7.5, 333.3, 12.7], 600).d
    ].map(outlineKey);
    expect(new Set(keys).size).toBe(1);
  });

  it('ignores noise below a thousandth of the box but separates real differences', () => {
    const base = 'M0 0L1 0L0.5 1Z';
    expect(outlineKey('M0.0001 0L1 0L0.5 1Z')).toBe(outlineKey(base));
    expect(outlineKey('M0.01 0L1 0L0.5 1Z')).not.toBe(outlineKey(base));
    expect(outlineKey(base)).toMatch(/^o[0-9a-f]{16}$/);
  });
});

describe('outlineDistance', () => {
  const pool = SYMBOL_POOL.map((entry) => ({ id: entry.id, d: normalizeSvgPath(entry.d) }));

  it('is 0 for the same outline whatever its encoding, start point or direction', () => {
    const square = normalizeSvgPath('M0 0H1V1H0Z');
    expect(outlineDistance(square, square)).toBe(0);
    expect(outlineDistance(square, normalizeSvgPath('M1 1L1 0L0 0L0 1Z'))).toBeLessThan(1e-9);
    for (const { d } of pool) {
      // pdf-lib draws `Q` as `C`; the normalized forms must still coincide.
      const asCubic = normalizeDrawOps(svgToCubicOps(d), [1, 0, 0, 1, 0, 0], 0).d;
      expect(outlineDistance(asCubic, d)).toBeLessThan(0.002);
    }
  });

  it('separates an empty outline from a drawn one', () => {
    expect(outlineDistance('', '')).toBe(0);
    expect(outlineDistance('', normalizeSvgPath('M0 0H1V1Z'))).toBe(1);
  });
});

/** Scale the coordinates of a DrawOps buffer, leaving its opcodes alone. */
function scaleCoordinates(ops: readonly number[], k: number): number[] {
  const arity: Record<number, number> = { [M]: 2, [L]: 2, [C]: 6, [Q]: 4, [Z]: 0 };
  const out: number[] = [];
  for (let i = 0; i < ops.length;) {
    const op = ops[i++];
    out.push(op);
    for (let n = 0; n < arity[op]; n += 1) out.push(ops[i++] * k);
  }
  return out;
}

/** Re-encode a normalized M/L/C/Z path as DrawOps with every segment a cubic (y up). */
function svgToCubicOps(d: string): number[] {
  const ops: number[] = [];
  const tokens = d.match(/[MLCZ]|-?[\d.]+(?:e-?\d+)?/g) ?? [];
  let x = 0, y = 0, sx = 0, sy = 0;
  for (let i = 0; i < tokens.length;) {
    const command = tokens[i++];
    const n = (): number => Number(tokens[i++]);
    if (command === 'M') {
      x = sx = n();
      y = sy = n();
      ops.push(M, x, -y);
    } else if (command === 'L') {
      const nx = n(), ny = n();
      ops.push(C, x + (nx - x) / 3, -(y + (ny - y) / 3), x + (2 * (nx - x)) / 3, -(y + (2 * (ny - y)) / 3), nx, -ny);
      x = nx;
      y = ny;
    } else if (command === 'C') {
      const v = [n(), n(), n(), n(), n(), n()];
      ops.push(C, v[0], -v[1], v[2], -v[3], v[4], -v[5]);
      x = v[4];
      y = v[5];
    } else {
      ops.push(Z);
      x = sx;
      y = sy;
    }
  }
  return ops;
}
