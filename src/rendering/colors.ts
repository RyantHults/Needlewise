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

/** `foreground` laid over `background` at `alpha`, as one opaque color; an unparseable input keeps `foreground`. */
export function compositeHexColor(foreground: string, background: string, alpha: number): string {
  const opacity = Math.max(0, Math.min(1, alpha));
  const foregroundChannels = parseHexColor(foreground);
  const backgroundChannels = parseHexColor(background);
  if (!foregroundChannels || !backgroundChannels || opacity >= 1) return foreground;
  const [red, green, blue] = foregroundChannels.map((channel, index) => channel * opacity + backgroundChannels[index] * (1 - opacity));
  return rgbToHex(red, green, blue);
}
