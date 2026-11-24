import type { PaletteEntry, PatternDocument } from '../domain';
import { luma, parseHexColor, rgbToHex } from '../domain/color';

/** Color helpers shared by the atlas, the symbol painter, and the renderer. */

/**
 * Entries by id per palette array, built on first lookup. A document's palette
 * is replaced rather than edited in place, so the array identity is the key.
 */
const paletteIndexes = new WeakMap<readonly PaletteEntry[], Map<number, PaletteEntry>>();

export function paletteEntry(palette: readonly PaletteEntry[], id: number): PaletteEntry | undefined {
  let index = paletteIndexes.get(palette);
  if (index === undefined) {
    index = new Map(palette.map((entry) => [entry.id, entry]));
    paletteIndexes.set(palette, index);
  }
  return index.get(id);
}

/** A palette id's color; `missing` stands in for a dangling non-zero id (id 0 is "no thread" and callers skip it). */
export function paletteColor(document: PatternDocument, id: number, missing: string): string {
  return paletteEntry(document.palette, id)?.color ?? missing;
}

/** A stored color's deterministic luminance gray; anything but `#rrggbb` is mid-gray. */
export function grayscaleColor(color: string): string {
  const rgb = parseHexColor(color);
  if (!rgb) return '#808080';
  const value = luma(rgb);
  return rgbToHex(value, value, value);
}

/** Blend `color` toward `target` (0-255 gray) by `amount`; an unparseable color is returned unchanged. */
export function mixToward(color: string, target: number, amount: number): string {
  const rgb = parseHexColor(color);
  if (!rgb) return color;
  const [red, green, blue] = rgb.map((value) => value * (1 - amount) + target * amount);
  return rgbToHex(red, green, blue);
}

/** Shaded edge of a thread or bead color. */
export function threadEdgeColor(color: string): string {
  return mixToward(color, 0, 0.35);
}

/** Lit highlight of a thread or bead color. */
export function threadHighlightColor(color: string): string {
  return mixToward(color, 255, 0.4);
}
