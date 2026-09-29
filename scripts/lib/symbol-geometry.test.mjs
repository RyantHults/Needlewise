import { describe, expect, it } from 'vitest';
import {
  centerOn,
  flatten,
  measure,
  normalizeOutline,
  parsePathData,
  scale,
  shapeKey,
  toPathData
} from './symbol-geometry.mjs';

describe('measure', () => {
  it('reports the box, area, center, and extent of a closed square', () => {
    const square = [['M', 0, 0], ['L', 1, 0], ['L', 1, 1], ['L', 0, 1], ['Z']];

    const result = measure(square);

    expect(result.bbox).toEqual({ minX: 0, minY: 0, maxX: 1, maxY: 1 });
    expect(result.area).toBe(1);
    expect(result.cx).toBe(0.5);
    expect(result.cy).toBe(0.5);
    // Farthest vertex from the center is a corner: sqrt(0.5^2 + 0.5^2).
    expect(result.extent).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it('treats an opposite-winding inner contour as a hole', () => {
    // Outer square side 2 (area 4) with an inner square side 1 (area 1)
    // wound the other way, so the overlap is cut out.
    const ring = [
      ['M', -1, -1], ['L', 1, -1], ['L', 1, 1], ['L', -1, 1], ['Z'],
      ['M', -0.5, -0.5], ['L', -0.5, 0.5], ['L', 0.5, 0.5], ['L', 0.5, -0.5], ['Z']
    ];

    expect(measure(ring).area).toBe(3);
  });

  it('fills an inner contour that winds the same way as the outer one', () => {
    const discWithSquare = [
      ['M', -1, -1], ['L', 1, -1], ['L', 1, 1], ['L', -1, 1], ['Z'],
      ['M', -0.5, -0.5], ['L', 0.5, -0.5], ['L', 0.5, 0.5], ['L', -0.5, 0.5], ['Z']
    ];

    // Same winding inside a shape is still solid: the inner square is already
    // covered, so the fill is the outer 2x2 square and not 4 + 1.
    expect(measure(discWithSquare).area).toBe(4);
  });

  it('measures a cubic curve by its true shape, not its chord', () => {
    // y(t) = 3t(1-t)^2 + 3(1-t)t^2 = 3t(1-t), which peaks at 0.75 for t=0.5.
    // Treating the curve as a straight line to its endpoint would report 0.
    const arch = [['M', 0, 0], ['C', 0, 1, 1, 1, 1, 0]];

    const result = measure(arch);

    expect(result.bbox.minX).toBe(0);
    expect(result.bbox.maxX).toBe(1);
    expect(result.bbox.maxY).toBeCloseTo(0.75, 12);
  });

  it('measures a quadratic curve by its true shape', () => {
    // y(t) = 2t(1-t), which peaks at 0.5 for t=0.5.
    const arch = [['M', 0, 0], ['Q', 1, 1, 1, 0]];

    expect(measure(arch).bbox.maxY).toBeCloseTo(0.5, 12);
  });

  it('subdivides curves into more than their endpoints', () => {
    const contours = flatten([['M', 0, 0], ['C', 0, 1, 1, 1, 1, 0]]);

    expect(contours[0].points.length).toBeGreaterThan(2);
  });

  it('reports the path length of an open line that encloses no area', () => {
    const line = [['M', 0, 0], ['L', 1, 0]];

    const result = measure(line);

    // Length is still measured, but a glyph is always filled, so ink is the
    // enclosed area and a line contributes none.
    expect(result.length).toBe(1);
    expect(result.area).toBe(0);
  });

  it('reports the perimeter of a closed square', () => {
    const square = [['M', 0, 0], ['L', 1, 0], ['L', 1, 1], ['L', 0, 1], ['Z']];

    expect(measure(square).length).toBe(4);
  });
});

describe('centerOn', () => {
  it('moves the given center onto the origin', () => {
    const square = [['M', 0, 0], ['L', 1, 0], ['L', 1, 1], ['L', 0, 1], ['Z']];

    const result = measure(centerOn(square, 0.5, 0.5));

    expect(result.cx).toBeCloseTo(0, 12);
    expect(result.cy).toBeCloseTo(0, 12);
  });

  it('leaves a curve on the same normalized shape as its flattened points', () => {
    const arch = [['M', 0, 0], ['C', 0, 1, 1, 1, 1, 0]];

    const centered = measure(centerOn(arch, 0.5, 0.375));

    expect(centered.bbox.minX).toBeCloseTo(-0.5, 12);
    expect(centered.bbox.maxX).toBeCloseTo(0.5, 12);
  });
});

describe('scale', () => {
  it('scales area by the square of the factor', () => {
    const square = [['M', 0, 0], ['L', 1, 0], ['L', 1, 1], ['L', 0, 1], ['Z']];

    const result = measure(scale(square, 2));

    expect(result.area).toBe(4);
    expect(result.bbox.maxX).toBe(2);
  });
});

describe('toPathData', () => {
  it('serializes a closed square as SVG path data', () => {
    const square = [['M', 0, 0], ['L', 1, 0], ['L', 1, 1], ['L', 0, 1], ['Z']];

    expect(toPathData(square)).toBe('M0 0L1 0L1 1L0 1Z');
  });

  it('rounds to a fixed precision so generated output is reproducible', () => {
    const noisy = [['M', 0.123456789, -0.0000001]];

    expect(toPathData(noisy)).toBe('M0.1235 0');
  });

  it('serializes curve control points', () => {
    const arch = [['M', 0, 0], ['C', 0, 1, 1, 1, 1, 0]];

    expect(toPathData(arch)).toBe('M0 0C0 1 1 1 1 0');
  });
});

describe('filled area', () => {
  const square = (x0, y0, x1, y1) => [['M', x0, y0], ['L', x1, y0], ['L', x1, y1], ['L', x0, y1], ['Z']];

  it('measures a plain shape', () => {
    expect(measure(square(-1, -1, 1, 1)).area).toBeCloseTo(4, 3);
  });

  it('carves a nested hole of the opposite winding', () => {
    const hole = [
      ['M', 0.5, 0.5], ['L', 0.5, -0.5], ['L', -0.5, -0.5], ['L', -0.5, 0.5], ['Z']
    ];
    expect(measure([...square(-1, -1, 1, 1), ...hole]).area).toBeCloseTo(3, 2);
  });

  it('handles a contour that partially overlaps another', () => {
    // A unit square with a box covering its right half. Summing signed contour
    // areas would report the box's whole area, because the two overlap rather
    // than nest. The nonzero rule leaves exactly the left half.
    const half = [...square(-1, -1, 1, 1), ['M', 0, -1], ['L', 0, 1], ['L', 1, 1], ['L', 1, -1], ['Z']];
    expect(measure(half).area).toBeCloseTo(2, 2);
  });

  it('fills the overhang of a clip box that escapes the shape', () => {
    // Why clip boxes must stay inside the cell: this one is wound to carve, but
    // the part of it outside the square has winding 1 and therefore paints.
    const escaping = [...square(-1, -1, 1, 1), ['M', 0, -2], ['L', 0, 2], ['L', 2, 2], ['L', 2, -2], ['Z']];
    expect(measure(escaping).area).toBeCloseTo(8, 1);
  });

  it('unions two shapes that overlap in the same winding', () => {
    const overlapping = [...square(-1, -1, 0, 1), ...square(0, -1, 1, 1)];
    expect(measure(overlapping).area).toBeCloseTo(4, 2);
  });

  it('reports nothing for an open path with no enclosed span', () => {
    expect(measure([['M', -1, 0], ['L', 1, 0]]).area).toBeCloseTo(0, 3);
  });
});

describe('path data round trip', () => {
  it('reads back what it writes', () => {
    const commands = [
      ['M', 0, 0.5],
      ['C', 0.25, 0.75, 0.75, 0.75, 1, 0.5],
      ['Q', 0.5, 0, 0, 0.5],
      ['L', -0.5, -0.5],
      ['Z']
    ];
    expect(parsePathData(toPathData(commands, 6))).toEqual(commands);
  });

  it('honours the requested precision', () => {
    const commands = [['M', 0.123456, -0.987654], ['L', 1, 0], ['Z']];
    expect(toPathData(commands, 2)).toBe('M0.12 -0.99L1 0Z');
    expect(toPathData(commands, 4)).toBe('M0.1235 -0.9877L1 0Z');
  });

  it('rejects path data it cannot trust', () => {
    expect(() => parsePathData('M0 0 L1')).toThrow(/Malformed/);
    expect(() => parsePathData('M0 0 X5 5')).toThrow(/Unexpected/);
  });
});

describe('normalizeOutline', () => {
  const options = { targetExtent: 0.4, maxExtent: 0.48, minScale: 0.4, maxScale: 2.5 };

  it('centers the outline on the origin so no per-glyph offset is needed', () => {
    const offCenter = [['M', 0.2, 0.8], ['L', 1.2, 0.8], ['L', 1.2, 1.8], ['L', 0.2, 1.8], ['Z']];

    const result = measure(normalizeOutline(offCenter, options).commands);

    expect(result.cx).toBeCloseTo(0, 6);
    expect(result.cy).toBeCloseTo(0, 6);
  });

  it('gives outlines drawn at different sizes the same extent', () => {
    const full = [['M', -0.5, -0.5], ['L', 0.5, -0.5], ['L', 0.5, 0.5], ['L', -0.5, 0.5], ['Z']];
    const half = [['M', -0.25, -0.25], ['L', 0.25, -0.25], ['L', 0.25, 0.25], ['L', -0.25, 0.25], ['Z']];

    expect(normalizeOutline(full, options).extent).toBeCloseTo(0.4, 6);
    expect(normalizeOutline(half, options).extent).toBeCloseTo(0.4, 6);
  });

  it('reports filled ink as enclosed area', () => {
    const square = [['M', -0.5, -0.5], ['L', 0.5, -0.5], ['L', 0.5, 0.5], ['L', -0.5, 0.5], ['Z']];

    // Side 1 scaled by 0.4 / sqrt(0.5) leaves area 0.32.
    expect(normalizeOutline(square, options).inkArea).toBeCloseTo(0.32, 6);
  });

  it('caps the scale so a tiny outline is not inflated past the clamp', () => {
    const dot = [['M', -0.01, -0.01], ['L', 0.01, -0.01], ['L', 0.01, 0.01], ['L', -0.01, 0.01], ['Z']];

    const result = normalizeOutline(dot, options);

    expect(result.appliedScale).toBe(options.maxScale);
    expect(result.extent).toBeLessThan(options.targetExtent);
  });

  it('shrinks any outline that would overflow the cell', () => {
    const big = [['M', -8, -8], ['L', 8, -8], ['L', 8, 8], ['L', -8, 8], ['Z']];

    const result = normalizeOutline(big, options);

    expect(result.extent).toBeCloseTo(options.maxExtent, 6);
  });

  it('applies a per-definition weight multiplier to the target extent', () => {
    const square = [['M', -0.5, -0.5], ['L', 0.5, -0.5], ['L', 0.5, 0.5], ['L', -0.5, 0.5], ['Z']];

    const result = normalizeOutline(square, { ...options, weight: 0.75 });

    expect(result.extent).toBeCloseTo(0.3, 6);
  });
});

describe('shapeKey', () => {
  const options = { targetExtent: 0.4, maxExtent: 0.48, minScale: 0.4, maxScale: 2.5 };
  const square = (size) => [
    ['M', -size, -size], ['L', size, -size], ['L', size, size], ['L', -size, size], ['Z']
  ];

  it('treats a scaled, centered copy as the same shape', () => {
    expect(shapeKey(square(0.4))).toBe(shapeKey(square(0.9)));
  });

  it('treats a translated copy as the same shape', () => {
    const moved = square(0.5).map((command) =>
      command[0] === 'Z' ? command : [command[0], command[1] + 3, command[2] - 2]);

    expect(shapeKey(moved)).toBe(shapeKey(square(0.5)));
  });

  it('keeps shapes that differ in proportion apart', () => {
    const wide = [['M', -1, -0.5], ['L', 1, -0.5], ['L', 1, 0.5], ['L', -1, 0.5], ['Z']];
    const tall = [['M', -0.5, -1], ['L', 0.5, -1], ['L', 0.5, 1], ['L', -0.5, 1], ['Z']];

    expect(shapeKey(wide)).not.toBe(shapeKey(tall));
  });

  it('agrees with what normalization actually renders', () => {
    // The key is only useful if it matches the rendered output, so compare it
    // against the real normalization rather than trusting the shortcut. Both
    // sizes must sit inside the scale clamps, or the clamp alone explains the
    // difference and the comparison proves nothing.
    const small = normalizeOutline(square(0.5), options);
    const large = normalizeOutline(square(0.7), options);

    expect(toPathData(small.commands)).toBe(toPathData(large.commands));
  });
});
