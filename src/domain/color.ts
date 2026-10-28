/** Colour helpers shared by every layer. Stored colours are always `#rrggbb`. */

export type Rgb = readonly [number, number, number];

/** `#rrggbb` (any case) → 8-bit channels, or `undefined` for anything else. */
export function parseHexColor(color: string): Rgb | undefined {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color.trim());
  if (!hex) return undefined;
  return [Number.parseInt(hex[1], 16), Number.parseInt(hex[2], 16), Number.parseInt(hex[3], 16)];
}

/** Channels → lower-case `#rrggbb`, each rounded and clamped to 0-255. */
export function rgbToHex(red: number, green: number, blue: number): string {
  const channel = (value: number): string => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

/** Rounded Rec. 709 luma, the grayscale value of a colour. */
export function luma(rgb: Rgb): number {
  return Math.round(rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722);
}

/** Canonical `#RRGGBB` for typed hex input, which may omit `#` or use `#rgb` shorthand. */
export const normalizeHexColor = (value: string): string | undefined => {
  const digits = value.trim().replace(/^#/, '');
  if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(digits)) return undefined;
  const expanded = digits.length === 3
    ? digits.split('').map((digit) => `${digit}${digit}`).join('')
    : digits;
  return `#${expanded.toUpperCase()}`;
};

/** Hue in degrees (0-360), saturation and value in 0-1. */
export type Hsv = readonly [hue: number, saturation: number, value: number];

/** Hue in degrees (0-360), saturation and lightness in 0-1. */
export type Hsl = readonly [hue: number, saturation: number, lightness: number];

/** The channels' extremes and hue, in 0-1 and degrees; hue is 0 for a grey. */
function hueAndExtremes([red, green, blue]: Rgb): { hue: number; max: number; min: number } {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let sector = 0;
  if (delta > 0) {
    if (max === r) sector = ((g - b) / delta + 6) % 6;
    else if (max === g) sector = (b - r) / delta + 2;
    else sector = (r - g) / delta + 4;
  }
  return { hue: sector * 60, max, min };
}

/** 8-bit channels → HSV. A grey has hue 0; keeping a hue through grey is the caller's job. */
export function rgbToHsv(rgb: Rgb): Hsv {
  const { hue, max, min } = hueAndExtremes(rgb);
  return [hue, max === 0 ? 0 : (max - min) / max, max];
}

/** Hue wrapped into [0, 360). */
const wrapHue = (hue: number): number => ((hue % 360) + 360) % 360;

/** HSV → 8-bit channels, rounded. Follows the CSS Color 4 conversion. */
export function hsvToRgb([hue, saturation, value]: Hsv): Rgb {
  const channel = (n: number): number => {
    const k = (n + wrapHue(hue) / 60) % 6;
    return Math.round(255 * (value - value * saturation * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [channel(5), channel(3), channel(1)];
}

/** 8-bit channels → HSL. A grey has hue 0. */
export function rgbToHsl(rgb: Rgb): Hsl {
  const { hue, max, min } = hueAndExtremes(rgb);
  const lightness = (max + min) / 2;
  const saturation = max === min ? 0 : (max - min) / (1 - Math.abs(2 * lightness - 1));
  return [hue, saturation, lightness];
}

/** HSL → 8-bit channels, rounded. Follows the CSS Color 4 conversion. */
export function hslToRgb([hue, saturation, lightness]: Hsl): Rgb {
  const a = saturation * Math.min(lightness, 1 - lightness);
  const channel = (n: number): number => {
    const k = (n + wrapHue(hue) / 30) % 12;
    return Math.round(255 * (lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [channel(0), channel(8), channel(4)];
}
