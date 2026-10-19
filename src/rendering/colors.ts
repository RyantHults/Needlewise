import type { PatternDocument } from '../domain';
import { luma, parseHexColor, rgbToHex } from '../domain/color';

/** Color helpers shared by the atlas, the symbol painter, and the renderer. */

/** A palette id's color; `missing` stands in for a dangling non-zero id (id 0 is "no thread" and callers skip it). */
export function paletteColor(document: PatternDocument, id: number, missing: string): string {
  return document.palette.find((entry) => entry.id === id)?.color ?? missing;
}

/** A stored color's deterministic luminance gray; anything but `#rrggbb` is mid-gray. */
export function grayscaleColor(color: string): string {
  const rgb = parseHexColor(color);
  if (!rgb) return '#808080';
  const value = luma(rgb);
  return rgbToHex(value, value, value);
}
