/**
 * WCAG contrast helpers for picking the symbol ink with the highest contrast
 * against the stitch color underneath it in Combined chart presentation mode.
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

function contrastRatio(lighter: number, darker: number): number {
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Pick the symbol ink that maximizes WCAG contrast against a stitch color.
 * `darkInk` is the configured symbol color (default `#242424`) and the light
 * alternative is always `#ffffff`. Unparseable inputs and exact contrast ties
 * keep `darkInk`, so light-background rendering is behavior-preserving and a
 * dark stitch color flips the glyph to white.
 */
export function contrastSymbolInk(backgroundHex: string, darkInk: string): string {
  const background = relativeLuminance(backgroundHex);
  const dark = relativeLuminance(darkInk);
  if (background === undefined || dark === undefined) return darkInk;
  const white = 1;
  const darkRatio = contrastRatio(Math.max(background, dark), Math.min(background, dark));
  const whiteRatio = contrastRatio(Math.max(background, white), Math.min(background, white));
  return whiteRatio > darkRatio ? '#ffffff' : darkInk;
}
