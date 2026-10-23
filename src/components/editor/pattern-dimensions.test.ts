import { describe, expect, it } from 'vitest';
import type { PatternDocument } from '../../domain';
import { patternDimensionInfo } from './pattern-dimensions';

describe('patternDimensionInfo', () => {
  it('reports imperial size', () => {
    const document = { width: 28, height: 14, settings: { aidaCount: 14 } } as PatternDocument;
    expect(patternDimensionInfo({ session: null, metadata: { units: 'imperial' } } as never, document).summary)
      .toBe(`28 × 14 stitches · 2 in × 1 in`);
  });
});
