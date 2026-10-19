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
