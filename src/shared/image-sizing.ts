/**
 * Bounds for decoded images held temporarily by the editor and conversion
 * pipelines. These are working-memory bounds, not encoded-image admission
 * limits.
 */
export const MAX_WORKING_IMAGE_DIMENSION = 4_096;
export const MAX_WORKING_IMAGE_PIXELS = 16_000_000;

export interface ImageWorkingSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Fit an image into both a maximum axis and a maximum pixel area without
 * upscaling. Rounding down keeps the result inside both limits.
 */
export function fitImageWithinWorkingBounds(
  width: number,
  height: number,
  maxDimension = MAX_WORKING_IMAGE_DIMENSION,
  maxPixels = MAX_WORKING_IMAGE_PIXELS
): ImageWorkingSize {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new RangeError('Image dimensions must be positive safe integers.');
  }
  if (!Number.isSafeInteger(maxDimension) || maxDimension < 1 || !Number.isSafeInteger(maxPixels) || maxPixels < 1) {
    throw new RangeError('Image working bounds must be positive safe integers.');
  }

  const scale = Math.min(
    1,
    maxDimension / width,
    maxDimension / height,
    Math.sqrt(maxPixels / (width * height))
  );
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale))
  };
}
