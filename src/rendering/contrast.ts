/**
 * Luminance helpers for picking the symbol ink (dark or white, favoring white)
 * against the stitch color underneath it in Combined chart presentation mode,
 * and for telling light stitches from dark ones when choosing grid line colors.
 * Pure functions only — no canvas or document access, so they are unit-testable
 * in isolation.
 */

/** `#rgb` or `#rrggbb` → `[r, g, b]` 8-bit channels, or `undefined` when unparseable. */
function parseHexColor(hex: string): [number, number, number] | undefined {
  if (typeof hex !== 'string') return undefined;
  const shorthand = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(hex);
  if (shorthand !== null) {
    return [
      parseInt(shorthand[1] + shorthand[1], 16),
      parseInt(shorthand[2] + shorthand[2], 16),
      parseInt(shorthand[3] + shorthand[3], 16)
    ];
  }
  const match = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
  if (match === null) return undefined;
  return [
    parseInt(match[1], 16),
    parseInt(match[2], 16),
    parseInt(match[3], 16)
  ];
}

/** Linearize one sRGB 8-bit channel to the WCAG 2.x relative-luminance scale. */
function linearChannel(channel: number): number {
  const value = channel / 255;
  return value > 0.03928 ? Math.pow((value + 0.055) / 1.055, 2.4) : value / 12.92;
}

/**
 * WCAG 2.x relative luminance for an `#rgb` or `#rrggbb` color, or `undefined`
 * for any input that is not a 3- or 6-digit hex color.
 */
export function relativeLuminance(hex: string): number | undefined {
  const rgb = parseHexColor(hex);
  if (rgb === undefined) return undefined;
  return 0.2126 * linearChannel(rgb[0]) + 0.7152 * linearChannel(rgb[1]) + 0.0722 * linearChannel(rgb[2]);
}

/**
 * Backgrounds darker than 60% gray (`#999999`) get white ink. That is
 * deliberately above the 50% WCAG crossover (`#808080`-ish) so white ink is
 * favored on mid-tone stitch colors.
 */
const WHITE_INK_LUMINANCE_THRESHOLD = relativeLuminance('#999999') as number;

/**
 * Whether a stitch color counts as dark: relative luminance strictly below
 * `#999999`'s, the same cutoff that flips symbol ink to white. `undefined` for
 * unparseable input.
 */
export function isDarkColor(hex: string): boolean | undefined {
  const luminance = relativeLuminance(hex);
  if (luminance === undefined) return undefined;
  return luminance < WHITE_INK_LUMINANCE_THRESHOLD;
}

/**
 * Pick the symbol ink for a stitch color: white when the background is dark
 * (see `isDarkColor`), otherwise `darkInk`. `darkInk` is the configured symbol
 * color (default `#242424`). Unparseable inputs keep `darkInk`, so
 * light-background rendering is behavior-preserving.
 */
export function contrastSymbolInk(backgroundHex: string, darkInk: string): string {
  const dark = isDarkColor(backgroundHex);
  if (dark === undefined || relativeLuminance(darkInk) === undefined) return darkInk;
  return dark ? '#ffffff' : darkInk;
}
