import { describe, expect, it } from 'vitest';
import { hslToRgb, hsvToRgb, luma, normalizeHexColor, parseHexColor, rgbToHex, rgbToHsl, rgbToHsv } from './color';
import type { Rgb } from './color';

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

const SAMPLES: Rgb[] = [
  [255, 0, 0], [0, 255, 0], [0, 0, 255],
  [255, 255, 255], [0, 0, 0], [128, 128, 128],
  [199, 43, 59]
];

describe('rgbToHsv and hsvToRgb', () => {
  it('round-trips the primaries, white, black, mid-grey and a thread red', () => {
    for (const rgb of SAMPLES) expect(hsvToRgb(rgbToHsv(rgb))).toEqual(rgb);
  });

  it('converts #C72B3B both ways', () => {
    const [hue, saturation, value] = rgbToHsv([199, 43, 59]);
    expect(hue).toBeCloseTo(353.85, 2);
    expect(saturation).toBeCloseTo(156 / 199);
    expect(value).toBeCloseTo(199 / 255);
    expect(hsvToRgb([120, 1, 1])).toEqual([0, 255, 0]);
    expect(hsvToRgb([240, 0.5, 0.5])).toEqual([64, 64, 128]);
  });

  it('gives a grey hue 0, and any hue at zero saturation draws that grey', () => {
    expect(rgbToHsv([128, 128, 128])).toEqual([0, 0, 128 / 255]);
    expect(hsvToRgb([200, 0, 128 / 255])).toEqual([128, 128, 128]);
    expect(hsvToRgb([360, 1, 1])).toEqual([255, 0, 0]);
  });
});

describe('rgbToHsl and hslToRgb', () => {
  it('round-trips the primaries, white, black, mid-grey and a thread red', () => {
    for (const rgb of SAMPLES) expect(hslToRgb(rgbToHsl(rgb))).toEqual(rgb);
  });

  it('converts #C72B3B both ways', () => {
    const [hue, saturation, lightness] = rgbToHsl([199, 43, 59]);
    expect(hue).toBeCloseTo(353.85, 2);
    expect(saturation).toBeCloseTo(156 / 242);
    expect(lightness).toBeCloseTo(121 / 255);
    expect(hslToRgb([0, 1, 0.5])).toEqual([255, 0, 0]);
    expect(hslToRgb([210, 0.5, 0.25])).toEqual([32, 64, 96]);
  });

  it('gives a grey hue 0, and any hue at zero saturation draws that grey', () => {
    expect(rgbToHsl([255, 255, 255])).toEqual([0, 0, 1]);
    expect(hslToRgb([200, 0, 0.5])).toEqual([128, 128, 128]);
  });
});
