/**
 * Cross-surface image decode ceilings shared by every surface that touches a
 * full-resolution image:
 *
 * - Conversion pre-scales oversized decodes to the shared working bounds
 *   (4096 axis / 16,000,000 pixels).
 * - Persistence accepts reference assets up to the decode ceiling so a large
 *   image that converts can also be kept as the project's source image.
 * - The editor reference decode pre-scales oversized bitmaps down to its own
 *   working bound (16,000,000 pixels) before holding them as live overlays.
 *
 * All three surfaces must agree on these ceilings so the same image can flow
 * through conversion, persistence, and the editor without drifting apart.
 */
export const MAX_IMAGE_DECODE_DIMENSION = 8_192;
export const MAX_IMAGE_DECODE_PIXELS = MAX_IMAGE_DECODE_DIMENSION * MAX_IMAGE_DECODE_DIMENSION;
/** Byte ceiling for a single full-resolution image decode; reference assets and conversion sources share it. */
export const MAX_IMAGE_DECODE_BYTES = 64 * 1024 * 1024;

export function isWithinImageDecodeBounds(width: number, height: number): boolean {
  return Number.isSafeInteger(width)
    && Number.isSafeInteger(height)
    && width >= 1
    && height >= 1
    && width <= MAX_IMAGE_DECODE_DIMENSION
    && height <= MAX_IMAGE_DECODE_DIMENSION
    && width * height <= MAX_IMAGE_DECODE_PIXELS;
}
