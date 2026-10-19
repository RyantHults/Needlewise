import { describe, expect, it } from 'vitest';
import {
  fitImageWithinWorkingBounds,
  MAX_WORKING_IMAGE_DIMENSION,
  MAX_WORKING_IMAGE_PIXELS
} from './image-sizing';

describe('shared image working bounds', () => {
  it('passes an image within both working bounds through unchanged', () => {
    expect(fitImageWithinWorkingBounds(3_000, 2_000)).toEqual({ width: 3_000, height: 2_000 });
  });

  it('applies the limiting axis before the pixel-area bound', () => {
    expect(fitImageWithinWorkingBounds(8_000, 6_000)).toEqual({ width: 4_096, height: 3_072 });
    expect(fitImageWithinWorkingBounds(8_192, 8_192)).toEqual({ width: 4_000, height: 4_000 });
    expect(fitImageWithinWorkingBounds(8_000, 8_000).width).toBeLessThanOrEqual(MAX_WORKING_IMAGE_DIMENSION);
    expect(fitImageWithinWorkingBounds(8_000, 8_000).width * fitImageWithinWorkingBounds(8_000, 8_000).height).toBeLessThanOrEqual(MAX_WORKING_IMAGE_PIXELS);
  });

  it('never upscales and keeps degenerate aspect ratios positive', () => {
    expect(fitImageWithinWorkingBounds(100, 50)).toEqual({ width: 100, height: 50 });
    expect(fitImageWithinWorkingBounds(12_600, 1)).toEqual({ width: 4_096, height: 1 });
  });

  it('rejects invalid dimensions and working bounds', () => {
    expect(() => fitImageWithinWorkingBounds(0, 10)).toThrow(RangeError);
    expect(() => fitImageWithinWorkingBounds(10, Number.NaN)).toThrow(RangeError);
    expect(() => fitImageWithinWorkingBounds(10, 10, 0)).toThrow(RangeError);
    expect(() => fitImageWithinWorkingBounds(10, 10, 4_096, 0)).toThrow(RangeError);
  });
});
