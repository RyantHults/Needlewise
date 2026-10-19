import { describe, expect, it } from 'vitest';
import { finishedSizeLine, number } from './number-format';

describe('number formatting', () => {
  it('prints numbers without trailing zeros', () => {
    expect(number(3)).toBe('3');
    expect(number(0.5)).toBe('0.5');
    expect(number(1 / 3)).toBe('0.33');
  });

  it('formats finished size in the display units', () => {
    const size = { widthInches: 1, heightInches: 0.5, widthCm: 2.54, heightCm: 1.27 };
    expect(finishedSizeLine(size, 'metric')).toBe('2.54 cm × 1.27 cm');
    expect(finishedSizeLine(size, 'imperial')).toBe('1 in × 0.5 in');
    expect(finishedSizeLine(undefined, 'metric')).toBeNull();
  });
});
