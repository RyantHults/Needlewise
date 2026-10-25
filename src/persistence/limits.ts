/** Conservative limits keep malformed input from consuming unbounded memory. */
import { MAX_IMAGE_DECODE_BYTES } from '../image/limits';

export const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
/**
 * A single stored asset. Source images are the only production asset kind; the
 * cap matches the shared image decode byte ceiling so a file that converts
 * (bounded by the same 64 MiB ceiling) can also persist as the reference asset.
 */
export const MAX_ASSET_BYTES = MAX_IMAGE_DECODE_BYTES;
/** Aggregate asset bytes per project (a project normally holds one source image). */
export const MAX_ASSET_TOTAL_BYTES = MAX_IMAGE_DECODE_BYTES;
export const MAX_PALETTE_ENTRIES = 0xffff;

/**
 * The document byte limit is still the final bound for a serialized document;
 * the cell limit also prevents a small malformed header from requesting a
 * disproportionately large set of typed arrays.
 */
/** Must stay aligned with the domain's exported persistence ceiling. */
export const MAX_DOCUMENT_CELLS = 1_000_000;
export const MAX_METADATA_STRING_BYTES = 64 * 1024;

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function isBoundedMetadataString(value: string): boolean {
  return utf8ByteLength(value) <= MAX_METADATA_STRING_BYTES;
}

/** IDs accepted by the original local storage format. */
export function isValidAssetId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && isBoundedMetadataString(value);
}
