import { describe, expect, it } from 'vitest';
import { patternDimensionSummary } from './pattern-dimensions';

const measure = (value: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);

describe('patternDimensionSummary', () => {
  it('reports stitches and metric size', () => {
    expect(patternDimensionSummary({ width: 28, height: 14, aidaCount: 14, units: 'metric' }))
      .toBe(`28 × 14 stitches · ${measure(2 * 2.54)} cm × ${measure(2.54)} cm`);
  });

  it('reports imperial size', () => {
    expect(patternDimensionSummary({ width: 28, height: 14, aidaCount: 14, units: 'imperial' }))
      .toBe(`28 × 14 stitches · ${measure(2)} in × ${measure(1)} in`);
  });
});
