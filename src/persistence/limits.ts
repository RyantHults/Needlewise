/** Conservative limits keep malformed archives from consuming unbounded memory. */
import { MAX_IMAGE_DECODE_BYTES } from '../shared/limits';

export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
/**
 * A single stored asset. Source images are the only production asset kind; the
 * cap matches the shared image decode byte ceiling so a file that converts
 * (bounded by the same 64 MiB ceiling) can also persist as the reference asset.
 */
export const MAX_ASSET_BYTES = MAX_IMAGE_DECODE_BYTES;
/** Aggregate asset bytes per project (a project normally holds one source image). */
export const MAX_ASSET_TOTAL_BYTES = MAX_IMAGE_DECODE_BYTES;
export const MAX_ARCHIVE_ENTRIES = 1024;
export const MAX_PALETTE_ENTRIES = 0xffff;

/**
 * These limits are deliberately shared by the binary and archive boundaries.
 * The document byte limit is still the final bound for a serialized document;
 * the cell limit also prevents a small malformed header from requesting a
 * disproportionately large set of typed arrays.
 */
/** Must stay aligned with the domain's exported persistence ceiling. */
export const MAX_DOCUMENT_CELLS = 1_000_000;
export const MAX_CELL_COUNT = MAX_DOCUMENT_CELLS;
export const MAX_METADATA_STRING_BYTES = 64 * 1024;
export const MAX_METADATA_TEXT_BYTES = MAX_METADATA_STRING_BYTES;
export const MAX_METADATA_BYTES = 256 * 1024;
export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const MAX_DAILY_ACTIVITY_BYTES = 64 * 1024;
export const MAX_ARCHIVE_EXPANSION_BYTES = 128 * 1024 * 1024;
export const MAX_ARCHIVE_EXPANDED_BYTES = MAX_ARCHIVE_EXPANSION_BYTES;

/** Asset IDs are also used as single archive path components. */
const ARCHIVE_SAFE_ASSET_ID = /^[A-Za-z0-9._-]{1,256}$/;

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

export function isArchiveSafeAssetId(value: unknown): value is string {
  return isValidAssetId(value)
    && value !== '.'
    && value !== '..'
    && ARCHIVE_SAFE_ASSET_ID.test(value);
}
