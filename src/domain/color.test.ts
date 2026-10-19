import { describe, expect, it } from 'vitest';
import { luma, normalizeHexColor, parseHexColor, rgbToHex } from './color';

describe('parseHexColor', () => {
  it('reads #rrggbb in any case and rejects every other form', () => {
    expect(parseHexColor('#C72b3B')).toEqual([199, 43, 59]);
    expect(parseHexColor(' #000000 ')).toEqual([0, 0, 0]);
    expect(parseHexColor('#abc')).toBeUndefined();
    expect(parseHexColor('c72b3b')).toBeUndefined();
    expect(parseHexColor('rgb(1, 2, 3)')).toBeUndefined();
  });
});

describe('rgbToHex', () => {
  it('rounds and clamps each channel into lower-case #rrggbb', () => {
    expect(rgbToHex(199, 43, 59)).toBe('#c72b3b');
    expect(rgbToHex(-4, 300, 10.6)).toBe('#00ff0b');
  });
});

describe('luma', () => {
  it('weights channels by Rec. 709 and rounds', () => {
    expect(luma([255, 255, 255])).toBe(255);
    expect(luma([255, 0, 0])).toBe(54);
  });
});

describe('normalizeHexColor', () => {
  it('expands and uppercases 3- and 6-digit values and rejects others', () => {
    expect(normalizeHexColor('#abc')).toBe('#AABBCC');
    expect(normalizeHexColor(' c72b3b ')).toBe('#C72B3B');
    expect(normalizeHexColor('#abcd')).toBeUndefined();
  });
});
