import { describe, expect, it } from 'vitest';
import { applyAdjustment, embolden, parseAdjustments } from './symbol-adjust.mjs';
import { NORMALIZATION } from './symbol-font.mjs';
import { flatten, measure, normalizeOutline } from './symbol-geometry.mjs';

const square = (half) => [['M', -half, -half], ['L', half, -half], ['L', half, half], ['L', -half, half], ['Z']];
// Outer square of side 0.8 with an opposite-winding inner square of side 0.4.
const RING = [
  ...square(0.4),
  ['M', -0.2, -0.2], ['L', -0.2, 0.2], ['L', 0.2, 0.2], ['L', 0.2, -0.2], ['Z']
];
// A convex disc of 64 quadratic arcs, which flatten into far more segments than it needs.
const DISC = (() => {
  const r = 0.3;
  const arcs = 64;
  const k = r / Math.cos(Math.PI / arcs);
  const commands = [['M', r, 0]];
  for (let step = 1; step <= arcs; step += 1) {
    const mid = ((step - 0.5) * 2 * Math.PI) / arcs;
    const end = (step * 2 * Math.PI) / arcs;
    commands.push(['Q', k * Math.cos(mid), k * Math.sin(mid), r * Math.cos(end), r * Math.sin(end)]);
  }
  commands.push(['Z']);
  return commands;
})();
const SELECTION = ['libertinus-math:U+0192', 'libertinus-math:U+2665'];
const NONE = { embolden: 0, scale: 1, offset: [0, 0] };

describe('embolden', () => {
  it('grows a square by its perimeter times the distance plus the rounded corners', () => {
    const distance = 0.02;

    const grown = measure(embolden(square(0.2), distance));

    // 0.4^2 + 4 * 0.4 * d + pi * d^2: the sides move out and each corner gains a quarter disc.
    expect(grown.area).toBeCloseTo(0.16 + 4 * 0.4 * distance + Math.PI * distance * distance, 3);
    expect(grown.bbox.maxX).toBeCloseTo(0.2 + distance, 6);
  });

  it('shrinks a counter instead of filling it', () => {
    const distance = 0.02;

    const grown = measure(embolden(RING, distance));

    const outer = (0.8 + 2 * distance) ** 2 - (4 - Math.PI) * distance * distance;
    const hole = (0.4 - 2 * distance) ** 2;
    expect(grown.area).toBeCloseTo(outer - hole, 3);
  });

  it('returns the commands unchanged for distance 0', () => {
    const commands = square(0.2);

    expect(embolden(commands, 0)).toBe(commands);
  });

  it('writes only M, L, and Z commands', () => {
    const curved = [['M', -0.2, 0], ['Q', 0, -0.3, 0.2, 0], ['L', 0, 0.2], ['Z']];

    const ops = new Set(embolden(curved, 0.01).map((command) => command[0]));

    expect([...ops].sort()).toEqual(['L', 'M', 'Z']);
  });

  it('simplifies the offset contour without visibly changing it', () => {
    const distance = 0.02;
    const source = measure(DISC);
    const vertices = flatten(DISC).reduce((total, contour) => total + contour.points.length, 0);

    const grown = embolden(DISC, distance);

    // A convex polygon offset by d gains its perimeter times d plus one full disc of radius d.
    const exact = source.area + source.length * distance + Math.PI * distance * distance;
    expect(Math.abs(measure(grown).area - exact) / exact).toBeLessThan(0.005);
    expect(grown.length).toBeLessThan(vertices / 4);
  });

  it('is byte-stable for the same input', () => {
    expect(embolden(RING, 0.015)).toEqual(embolden(RING.map((command) => [...command]), 0.015));
  });
});

describe('applyAdjustment', () => {
  const normalized = normalizeOutline(square(1), NORMALIZATION).commands;

  it('keeps the extent the outline arrived with after emboldening', () => {
    const before = measure(normalized);

    const after = measure(applyAdjustment(normalized, { ...NONE, embolden: 0.03 }, NORMALIZATION));

    expect(after.extent).toBeCloseTo(before.extent, 6);
    expect(after.area).toBeGreaterThan(before.area);
  });

  it('keeps a mark normalization left small at its small extent', () => {
    const dot = normalizeOutline(square(0.001), NORMALIZATION).commands;
    const before = measure(dot);

    const after = measure(applyAdjustment(dot, { ...NONE, embolden: 0.01 }, NORMALIZATION));

    expect(before.extent).toBeLessThan(NORMALIZATION.targetExtent / 2);
    expect(after.extent).toBeCloseTo(before.extent, 6);
  });

  it('scales about the cell center', () => {
    const after = measure(applyAdjustment(normalized, { ...NONE, scale: 0.5 }, NORMALIZATION));

    expect(after.extent).toBeCloseTo(measure(normalized).extent / 2, 9);
    expect(after.cx).toBeCloseTo(0, 9);
    expect(after.cy).toBeCloseTo(0, 9);
  });

  it('offsets +x right and +y down', () => {
    const after = measure(applyAdjustment(normalized, { ...NONE, offset: [0.05, 0.03] }, NORMALIZATION));

    expect(after.cx).toBeCloseTo(0.05, 9);
    expect(after.cy).toBeCloseTo(0.03, 9);
  });

  it('returns the outline unchanged with no adjustment', () => {
    expect(applyAdjustment(normalized, NONE, NORMALIZATION)).toEqual(normalized);
  });

  it('throws when an offset pushes ink past the tile', () => {
    expect(() => applyAdjustment(normalized, { ...NONE, offset: [0.3, 0] }, NORMALIZATION)).toThrow(/tile/);
  });
});

describe('parseAdjustments', () => {
  it('returns an empty map when there are no adjustments', () => {
    expect(parseAdjustments(undefined, SELECTION)).toEqual(new Map());
  });

  it('fills defaults and canonicalizes keys', () => {
    const adjustments = parseAdjustments(
      { 'libertinus-math:u+0192': { embolden: 0.02 }, 'libertinus-math:U+2665': { scale: 0.9, offset: [0, -0.01] } },
      SELECTION
    );

    expect([...adjustments]).toEqual([
      ['libertinus-math:U+0192', { embolden: 0.02, scale: 1, offset: [0, 0] }],
      ['libertinus-math:U+2665', { embolden: 0, scale: 0.9, offset: [0, -0.01] }]
    ]);
  });

  it('rejects an unknown field, naming the entry and the field', () => {
    expect(() => parseAdjustments({ 'libertinus-math:U+0192': { weight: 2 } }, SELECTION)).toThrow(
      /libertinus-math:U\+0192.*"weight"/
    );
  });

  it('rejects a negative embolden', () => {
    expect(() => parseAdjustments({ 'libertinus-math:U+0192': { embolden: -0.01 } }, SELECTION)).toThrow(
      /libertinus-math:U\+0192.*"embolden"/
    );
  });

  it('rejects a zero scale', () => {
    expect(() => parseAdjustments({ 'libertinus-math:U+0192': { scale: 0 } }, SELECTION)).toThrow(
      /libertinus-math:U\+0192.*"scale"/
    );
  });

  it('rejects an offset that is not two numbers', () => {
    for (const offset of [[0.1], [0, 0, 0], ['0', 0], { dx: 0, dy: 0 }]) {
      expect(() => parseAdjustments({ 'libertinus-math:U+0192': { offset } }, SELECTION)).toThrow(
        /libertinus-math:U\+0192.*"offset"/
      );
    }
  });

  it('rejects a glyph that is not in the selection', () => {
    expect(() => parseAdjustments({ 'libertinus-math:U+25CF': { embolden: 0.01 } }, SELECTION)).toThrow(
      /libertinus-math:U\+25CF.*not in the selection/
    );
  });

  it('rejects a malformed key, naming it', () => {
    expect(() => parseAdjustments({ 'not an entry': {} }, SELECTION)).toThrow(/"not an entry"/);
  });

  it('rejects two keys that name the same glyph', () => {
    expect(() =>
      parseAdjustments({ 'libertinus-math:U+0192': {}, 'libertinus-math:u+0192': {} }, SELECTION)
    ).toThrow(/already adjusted/);
  });
});
