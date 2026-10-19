import { describe, expect, it } from 'vitest';
import { patternDimensionSummary } from './pattern-dimensions';

describe('patternDimensionSummary', () => {
  it('reports stitches and metric size', () => {
    expect(patternDimensionSummary({ width: 28, height: 14, aidaCount: 14, units: 'metric' }))
      .toBe(`28 × 14 stitches · 5.08 cm × 2.54 cm`);
  });

  it('reports imperial size', () => {
    expect(patternDimensionSummary({ width: 28, height: 14, aidaCount: 14, units: 'imperial' }))
      .toBe(`28 × 14 stitches · 2 in × 1 in`);
  });
});
