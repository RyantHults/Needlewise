import {
  CellKind,
  assertValidDocument,
  createDocument,
  MAX_PERSISTABLE_CELL_COUNT,
  type PaletteEntryInput,
  type PatternDocument
} from '../domain';
import { DMC_CATALOG, DMC_CATALOG_METADATA, type DmcCatalogColor } from '../catalog';
import { MAX_IMAGE_DECODE_BYTES, MAX_IMAGE_DECODE_DIMENSION, MAX_IMAGE_DECODE_PIXELS } from '../shared/limits';
import { MAX_WORKING_IMAGE_DIMENSION, MAX_WORKING_IMAGE_PIXELS } from '../shared/image-sizing';

export const CONVERSION_PROTOCOL = 'needlewise.image-conversion.v1' as const;
export const CONVERSION_REQUEST_TYPE = 'conversion-request' as const;
export const CONVERSION_RESULT_TYPE = 'conversion-result' as const;
export const CONVERSION_CANCEL_TYPE = 'conversion-cancel' as const;
export const CONVERSION_CANCELLED_TYPE = 'conversion-cancelled' as const;
export const CONVERSION_ERROR_TYPE = 'conversion-error' as const;
export const DEFAULT_CONVERSION_PALETTE_BUDGET = 24;
export const MAX_CONVERSION_PALETTE_BUDGET = DMC_CATALOG.length;
export const MAX_CONVERSION_DIMENSION = 1_000;
export const MAX_CONVERSION_SOURCE_DIMENSION = MAX_WORKING_IMAGE_DIMENSION;
export const MAX_CONVERSION_SOURCE_PIXELS = MAX_WORKING_IMAGE_PIXELS;
/**
 * Hard ceiling for a single full-resolution decode. Bitmaps beyond the working
 * bounds but within this ceiling are decoded once and then pre-scaled down to
 * the working bounds (successive exact-2x halvings) before conversion; anything
 * above this ceiling is never decoded, keeping peak memory bounded. Shared
 * with persistence and the editor reference decode via the shared limits so
 * all surfaces agree on the same memory policy.
 */
export const MAX_CONVERSION_DECODE_DIMENSION = MAX_IMAGE_DECODE_DIMENSION;
export const MAX_CONVERSION_DECODE_PIXELS = MAX_IMAGE_DECODE_PIXELS;
export const MAX_CONVERSION_SOURCE_BYTES = MAX_IMAGE_DECODE_BYTES;
export const MAX_CONVERSION_TARGET_PIXELS = MAX_PERSISTABLE_CELL_COUNT;
export const CONVERSION_LOOP_CHUNK = 4_096;
export const MAX_CONVERSION_TOKEN_BOOKKEEPING = 1_024;

export interface ConversionRaster {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray;
  readonly sourceWidth?: number;
  readonly sourceHeight?: number;
}

export interface ConversionToken {
  readonly projectId: string;
  readonly baseRevision: number;
  readonly requestId: string;
}

export interface ConversionSourceImageCandidate {
  readonly assetId?: string;
  readonly mimeType?: string;
  readonly width: number;
  readonly height: number;
  readonly crop: { readonly x: 0; readonly y: 0; readonly width: 1; readonly height: 1 };
  readonly chartBounds: { readonly x: 0; readonly y: 0; readonly width: number; readonly height: number };
  readonly traceVisible: boolean;
  readonly opacity: 1;
}

export interface ConversionStats {
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly targetWidth: number;
  readonly targetHeight: number;
  readonly totalPixels: number;
  readonly transparentPixels: number;
  readonly emptyPixels: number;
  readonly stitchedPixels: number;
  /** Distinct catalog colors matched by pixels surviving the transparent/white/background skips. */
  readonly matchedColorCount: number;
  readonly paletteUsage: readonly {
    readonly paletteId: number;
    readonly catalogId: string;
    readonly count: number;
  }[];
}

export interface ConversionDraft {
  readonly token: ConversionToken;
  readonly document: PatternDocument;
  readonly stats: ConversionStats;
  readonly sourceImage: ConversionSourceImageCandidate;
}

export type AcceptedConversionDraft = ConversionDraft & { readonly accepted: true };

export interface ConversionOptions {
  readonly targetWidth: number;
  readonly targetHeight: number;
  readonly paletteBudget?: number;
  /** A catalog sourceId whose pixels are treated as background and skipped. */
  readonly backgroundSourceId?: string;
  /** Trim empty borders off the source raster before the target mapping. */
  readonly autoCrop?: boolean;
  readonly token?: ConversionToken;
  readonly catalog?: readonly DmcCatalogColor[];
  readonly sourceImage?: Partial<Pick<ConversionSourceImageCandidate, 'assetId' | 'mimeType'>>;
}

export interface ConversionRequestBase {
  readonly protocol: typeof CONVERSION_PROTOCOL;
  readonly type: typeof CONVERSION_REQUEST_TYPE;
  readonly token: ConversionToken;
  readonly targetWidth: number;
  readonly targetHeight: number;
  readonly paletteBudget?: number;
  readonly backgroundSourceId?: string;
  readonly autoCrop?: boolean;
  readonly catalog?: readonly DmcCatalogColor[];
  readonly sourceAssetId?: string;
  readonly sourceMimeType?: string;
}

export interface ConversionRasterRequestMessage extends ConversionRequestBase {
  readonly inputType: 'raster';
  readonly width: number;
  readonly height: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly pixels: Uint8ClampedArray;
}

export interface ConversionImageRequestMessage extends ConversionRequestBase {
  readonly inputType: 'image';
  readonly image: Blob;
  readonly maxBytes?: number;
  readonly maxPixels?: number;
}

export type ConversionRequestMessage = ConversionRasterRequestMessage | ConversionImageRequestMessage;

export interface ConversionResultMessage {
  readonly protocol: typeof CONVERSION_PROTOCOL;
  readonly type: typeof CONVERSION_RESULT_TYPE;
  readonly token: ConversionToken;
  readonly draft: ConversionDraft;
}

export interface ConversionCancelledMessage {
  readonly protocol: typeof CONVERSION_PROTOCOL;
  readonly type: typeof CONVERSION_CANCELLED_TYPE;
  readonly token: ConversionToken;
}

export interface ConversionErrorMessage {
  readonly protocol: typeof CONVERSION_PROTOCOL;
  readonly type: typeof CONVERSION_ERROR_TYPE;
  readonly token?: ConversionToken;
  readonly code: string;
  readonly message: string;
}

export interface ConversionCancelMessage {
  readonly protocol: typeof CONVERSION_PROTOCOL;
  readonly type: typeof CONVERSION_CANCEL_TYPE;
  readonly token: ConversionToken;
}

export type ConversionWorkerRequest = ConversionRequestMessage | ConversionCancelMessage;
export type ConversionWorkerResponse = ConversionResultMessage | ConversionCancelledMessage | ConversionErrorMessage;

export class ConversionError extends Error {
  constructor(readonly code: 'invalid-raster' | 'invalid-target' | 'invalid-palette-budget' | 'invalid-token' | 'invalid-draft' | 'conversion-failed' | 'unavailable', message: string) {
    super(message);
    this.name = 'ConversionError';
  }
}

export class ConversionCancelledError extends Error {
  readonly code = 'conversion-cancelled';

  constructor(readonly requestId = 'conversion') {
    super(`Conversion request ${requestId} was cancelled.`);
    this.name = 'ConversionCancelledError';
  }
}

export interface ConversionCancellation {
  readonly signal?: AbortSignal;
  readonly isCancelled?: () => boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function conversionCancelled(cancellation?: ConversionCancellation, requestId?: string): void {
  if (cancellation?.signal?.aborted === true || cancellation?.isCancelled?.() === true) throw new ConversionCancelledError(requestId);
}

export async function yieldConversionWork(): Promise<void> {
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
}

function assertPositiveDimensions(width: number, height: number, label: string): void {
  const maximum = label === 'raster' ? MAX_CONVERSION_SOURCE_DIMENSION : MAX_CONVERSION_DIMENSION;
  const maximumPixels = label === 'raster' ? MAX_CONVERSION_SOURCE_PIXELS : MAX_CONVERSION_TARGET_PIXELS;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > maximum || height > maximum || width * height > maximumPixels) {
    throw new ConversionError(label === 'target' ? 'invalid-target' : 'invalid-raster', `${label} dimensions are outside the supported bounds.`);
  }
}

/**
 * Original source dimensions may exceed the working conversion bounds: the
 * decode path pre-scales oversized bitmaps down to the working bounds before
 * conversion, while the recorded source dimensions keep the true original
 * size (the retained reference asset stores the original bytes). Only shape is
 * validated here; non-finite, non-positive, and non-safe-integer inputs stay
 * rejected.
 */
function assertPositiveSourceDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new ConversionError('invalid-raster', 'raster dimensions are outside the supported bounds.');
  }
}

function assertRaster(raster: ConversionRaster): void {
  assertPositiveDimensions(raster.width, raster.height, 'raster');
  if (raster.sourceWidth !== undefined || raster.sourceHeight !== undefined) {
    assertPositiveSourceDimensions(raster.sourceWidth ?? raster.width, raster.sourceHeight ?? raster.height);
  }
  if (!(raster.pixels instanceof Uint8ClampedArray) || raster.pixels.length !== raster.width * raster.height * 4) {
    throw new ConversionError('invalid-raster', 'Raster pixels do not match raster dimensions.');
  }
}

function assertToken(token: ConversionToken): void {
  if (!token || typeof token !== 'object' || typeof token.projectId !== 'string' || token.projectId.length < 1 || token.projectId.length > 256 || !Number.isSafeInteger(token.baseRevision) || token.baseRevision < 0 || typeof token.requestId !== 'string' || token.requestId.length < 1 || token.requestId.length > 256) throw new ConversionError('invalid-token', 'The conversion token is malformed.');
}

export function validateConversionToken(value: unknown): value is ConversionToken {
  try {
    assertToken(value as ConversionToken);
    return true;
  } catch {
    return false;
  }
}

export function conversionTokenKey(token: ConversionToken): string {
  assertToken(token);
  return `${token.projectId}\u0000${String(token.baseRevision)}\u0000${token.requestId}`;
}

function rgbDistance(left: readonly [number, number, number], right: readonly [number, number, number]): number {
  const red = left[0] - right[0];
  const green = left[1] - right[1];
  const blue = left[2] - right[2];
  return red * red + green * green + blue * blue;
}

function nearestCatalogIndex(rgb: readonly [number, number, number], catalog: readonly DmcCatalogColor[]): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < catalog.length; index += 1) {
    const distance = rgbDistance(rgb, catalog[index].rgb);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Deterministic palette selection shared by every conversion path. The
 * palette contains ONLY colors actually matched by non-skipped pixels, ranked
 * in descending pixel usage with ascending catalog index as a deterministic
 * tie-break; palette ids are assigned 1..N in rank order (matching the
 * empty-starter convention where nextPaletteId starts at 1). Because the rank
 * is a stable prefix of one sorted list, raising the budget only adds the next
 * most-used color and lowering it only drops the least-used one.
 */
function rankCatalogIndices(counts: ReadonlyMap<number, number>, budget: number): number[] {
  return [...counts.keys()]
    .sort((left, right) => (counts.get(right) ?? 0) - (counts.get(left) ?? 0) || left - right)
    .slice(0, budget);
}

/** Catalog index matching the background sourceId, or -1 when there is none. */
function backgroundCatalogIndex(options: ConversionOptions, catalog: readonly DmcCatalogColor[]): number {
  if (options.backgroundSourceId === undefined || typeof options.backgroundSourceId !== 'string') return -1;
  return catalog.findIndex((color) => color.sourceId === options.backgroundSourceId);
}

/**
 * Bounding box of the content kept by {@link trimDocumentToContent}, in
 * pre-trim document cell coordinates (which match the sampled raster 1:1,
 * since the document is created at the target dimensions).
 */
export interface DocumentContentBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * Trim empty border rows and columns from a converted pattern document down to
 * the stitched-content bounding box. A cell counts as content when it holds
 * any stitch (kind !== Empty) or is touched by a backstitch segment (segments
 * use quarter-cell coordinates, four per cell side, so endpoint coverage maps
 * onto cells by integer division).
 *
 * This mirrors the region remap of the domain crop command without the command
 * machinery: the document is remapped in place (no clone), the revision stays
 * untouched (a fresh draft must remain revision 0), and the pure translation
 * preserves canonical endpoint order so no re-canonicalization is needed.
 * Palette, usage, revision and ID counters are untouched: only Empty cells
 * (whose color slots hold the none-value 0, which usage counting skips) are
 * ever removed. Returns the kept bounding box, or null — leaving the document
 * untouched — when there is no content (never produce a zero-size document)
 * or the content already fills the document.
 */
export function trimDocumentToContent(document: PatternDocument): DocumentContentBox | null {
  let left = document.width;
  let right = -1;
  let top = document.height;
  let bottom = -1;
  const cover = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= document.width || y >= document.height) return;
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  };
  for (let y = 0; y < document.height; y += 1) {
    for (let x = 0; x < document.width; x += 1) {
      if (document.kind[y * document.width + x] !== CellKind.Empty) cover(x, y);
    }
  }
  const stitches = document.backstitches;
  for (let index = 0; index < stitches.ids.length; index += 1) {
    const minX = Math.floor(Math.min(stitches.x1[index], stitches.x2[index]) / 4);
    const maxX = Math.floor(Math.max(stitches.x1[index], stitches.x2[index]) / 4);
    const minY = Math.floor(Math.min(stitches.y1[index], stitches.y2[index]) / 4);
    const maxY = Math.floor(Math.max(stitches.y1[index], stitches.y2[index]) / 4);
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) cover(x, y);
    }
  }
  if (right < left || bottom < top) return null;
  if (left === 0 && top === 0 && right === document.width - 1 && bottom === document.height - 1) return null;
  const width = right - left + 1;
  const height = bottom - top + 1;
  const oldWidth = document.width;
  const nextKind = new Uint8Array(width * height);
  const nextColors = new Uint16Array(width * height * 4);
  const nextCompleted = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const oldIndex = (top + y) * oldWidth + left + x;
      const nextIndex = y * width + x;
      nextKind[nextIndex] = document.kind[oldIndex];
      nextCompleted[nextIndex] = document.completed[oldIndex];
      const oldOffset = oldIndex * 4;
      const nextOffset = nextIndex * 4;
      nextColors[nextOffset] = document.colors[oldOffset];
      nextColors[nextOffset + 1] = document.colors[oldOffset + 1];
      nextColors[nextOffset + 2] = document.colors[oldOffset + 2];
      nextColors[nextOffset + 3] = document.colors[oldOffset + 3];
    }
  }
  document.width = width;
  document.height = height;
  document.kind = nextKind;
  document.colors = nextColors;
  document.completed = nextCompleted;
  const shiftX = left * 4;
  const shiftY = top * 4;
  for (let index = 0; index < stitches.ids.length; index += 1) {
    stitches.x1[index] -= shiftX;
    stitches.x2[index] -= shiftX;
    stitches.y1[index] -= shiftY;
    stitches.y2[index] -= shiftY;
  }
  return { left, top, right, bottom };
}

function paletteEntry(id: number, color: DmcCatalogColor): PaletteEntryInput {
  // `symbol` is intentionally omitted: `normalizePaletteEntry` auto-assigns a
  // curated Unicode glyph via `defaultPaletteSymbol(id)` (cycled past 28),
  // and `isAutoOverflowEntry` flags any cycled-default duplicate so the
  // validator's unique-symbol guard accepts overflow palettes.
  return {
    id,
    name: color.name,
    color: color.hex,
    active: true,
    catalog: {
      catalogId: DMC_CATALOG_METADATA.catalogId,
      sourceId: color.sourceId,
      code: color.code,
      name: color.name,
      hex: color.hex,
      rgb: [...color.rgb] as [number, number, number]
    }
  };
}

function sourceRgb(pixels: Uint8ClampedArray, offset: number): [number, number, number] {
  return [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
}

function defaultToken(): ConversionToken {
  return { projectId: 'local-conversion', baseRevision: 0, requestId: 'conversion-direct' };
}

/** Convert an already decoded/resampled raster without mutating or transferring its pixels. */
export function convertRasterToPattern(raster: ConversionRaster, options: ConversionOptions): ConversionDraft {
  assertRaster(raster);
  assertPositiveDimensions(options.targetWidth, options.targetHeight, 'target');
  const catalog = options.catalog ?? DMC_CATALOG;
  const backgroundIndex = backgroundCatalogIndex(options, catalog);
  const sampled = resampleRaster(raster, options.targetWidth, options.targetHeight);
  const sourceWidth = raster.sourceWidth ?? raster.width;
  const sourceHeight = raster.sourceHeight ?? raster.height;
  const token = options.token ?? defaultToken();
  assertToken(token);
  const budget = options.paletteBudget ?? DEFAULT_CONVERSION_PALETTE_BUDGET;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > MAX_CONVERSION_PALETTE_BUDGET) throw new ConversionError('invalid-palette-budget', 'The palette budget must fit within the supported catalog bound.');
  const counts = new Map<number, number>();
  const matchedColors = new Set<number>();
  let transparentPixels = 0;
  for (let index = 0; index < sampled.width * sampled.height; index += 1) {
    const offset = index * 4;
    if (sampled.pixels[offset + 3] === 0) {
      transparentPixels += 1;
      continue;
    }
    const catalogIndex = nearestCatalogIndex(sourceRgb(sampled.pixels, offset), catalog);
    if (catalogIndex === backgroundIndex) {
      continue;
    }
    counts.set(catalogIndex, (counts.get(catalogIndex) ?? 0) + 1);
    matchedColors.add(catalogIndex);
  }
  const selectedIndices = rankCatalogIndices(counts, budget);
  const selected = [...selectedIndices].sort((left, right) => left - right).map((index) => catalog[index]);
  const selectedCatalogIndices = [...selectedIndices].sort((left, right) => left - right);
  const selectedOrder = selectedIndices.map((catalogIndex, paletteOffset) => ({ catalogIndex, paletteId: paletteOffset + 1 }));
  const paletteInputs: PaletteEntryInput[] = selectedOrder.map(({ catalogIndex, paletteId }) => paletteEntry(paletteId, catalog[catalogIndex]));
  const paletteIdByCatalogIndex = new Map(selectedOrder.map(({ catalogIndex, paletteId }) => [catalogIndex, paletteId]));
  const document = createDocument({ width: options.targetWidth, height: options.targetHeight, palette: paletteInputs });
  const usage = new Map<number, number>();
  let stitchedPixels = 0;
  for (let targetIndex = 0; targetIndex < document.width * document.height; targetIndex += 1) {
    const sourceIndex = targetIndex;
    const offset = sourceIndex * 4;
    if (sampled.pixels[offset + 3] === 0) {
      continue;
    }
    const pixel = sourceRgb(sampled.pixels, offset);
    // The background color is skipped before selection, so it can never be in
    // the palette; check each pixel's true catalog match against it so
    // background pixels stay unstitched instead of remapping to a kept color.
    if (backgroundIndex >= 0 && nearestCatalogIndex(pixel, catalog) === backgroundIndex) {
      continue;
    }
    const sourceCatalogIndex = nearestCatalogIndex(pixel, selected);
    const paletteId = paletteIdByCatalogIndex.get(selectedCatalogIndices[sourceCatalogIndex]);
    if (paletteId === undefined) continue;
    document.kind[targetIndex] = CellKind.Full;
    document.colors[targetIndex * 4] = paletteId;
    usage.set(paletteId, (usage.get(paletteId) ?? 0) + 1);
    stitchedPixels += 1;
  }
  // Trimming only removes Empty cells (zeroed color slots the usage counting
  // skips), so palette and usage stay valid without recomputation. The
  // transparent count is re-scoped to the kept box so every stat describes
  // the final document.
  if (options.autoCrop === true) {
    const box = trimDocumentToContent(document);
    if (box !== null) {
      let keptTransparent = 0;
      for (let y = box.top; y <= box.bottom; y += 1) {
        for (let x = box.left; x <= box.right; x += 1) {
          if (sampled.pixels[(y * sampled.width + x) * 4 + 3] === 0) keptTransparent += 1;
        }
      }
      transparentPixels = keptTransparent;
    }
  }
  const paletteUsage = selectedOrder
    .map(({ catalogIndex, paletteId }) => ({ paletteId, catalogId: catalog[catalogIndex].sourceId, count: usage.get(paletteId) ?? 0 }))
    .filter((entry) => entry.count > 0);
  return {
    token,
    document,
    stats: {
      sourceWidth,
      sourceHeight,
      targetWidth: document.width,
      targetHeight: document.height,
      totalPixels: document.width * document.height,
      transparentPixels,
      emptyPixels: document.width * document.height - stitchedPixels,
      stitchedPixels,
      matchedColorCount: matchedColors.size,
      paletteUsage
    },
    sourceImage: {
      ...(options.sourceImage?.assetId === undefined ? {} : { assetId: options.sourceImage.assetId }),
      ...(options.sourceImage?.mimeType === undefined ? {} : { mimeType: options.sourceImage.mimeType }),
      width: sourceWidth,
      height: sourceHeight,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      chartBounds: { x: 0, y: 0, width: document.width, height: document.height },
      traceVisible: false,
      opacity: 1
    }
  };
}

/**
 * Async equivalent of convertRasterToPattern. The worker and the main-thread
 * fallback both use this path so cancellation and output semantics stay in
 * lockstep for large rasters.
 */
export async function convertRasterToPatternAsync(
  raster: ConversionRaster,
  options: ConversionOptions,
  cancellation?: ConversionCancellation
): Promise<ConversionDraft> {
  assertRaster(raster);
  assertPositiveDimensions(options.targetWidth, options.targetHeight, 'target');
  const token = options.token ?? defaultToken();
  assertToken(token);
  conversionCancelled(cancellation, token.requestId);
  const sampled = await resampleRasterAsync(raster, options.targetWidth, options.targetHeight, cancellation);
  conversionCancelled(cancellation, token.requestId);
  const sourceWidth = raster.sourceWidth ?? raster.width;
  const sourceHeight = raster.sourceHeight ?? raster.height;
  const budget = options.paletteBudget ?? DEFAULT_CONVERSION_PALETTE_BUDGET;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > MAX_CONVERSION_PALETTE_BUDGET) throw new ConversionError('invalid-palette-budget', 'The palette budget must fit within the supported catalog bound.');
  const catalog = options.catalog ?? DMC_CATALOG;
  const backgroundIndex = backgroundCatalogIndex(options, catalog);
  const counts = new Map<number, number>();
  const matchedColors = new Set<number>();
  let transparentPixels = 0;
  for (let index = 0; index < sampled.width * sampled.height; index += 1) {
    const offset = index * 4;
    if (sampled.pixels[offset + 3] === 0) {
      transparentPixels += 1;
    } else {
      const catalogIndex = nearestCatalogIndex(sourceRgb(sampled.pixels, offset), catalog);
      if (catalogIndex !== backgroundIndex) {
        counts.set(catalogIndex, (counts.get(catalogIndex) ?? 0) + 1);
        matchedColors.add(catalogIndex);
      }
    }
    if ((index + 1) % CONVERSION_LOOP_CHUNK === 0) {
      conversionCancelled(cancellation, token.requestId);
      await yieldConversionWork();
      conversionCancelled(cancellation, token.requestId);
    }
  }
  conversionCancelled(cancellation, token.requestId);
  const selectedIndices = rankCatalogIndices(counts, budget);
  const selected = [...selectedIndices].sort((left, right) => left - right).map((index) => catalog[index]);
  const selectedCatalogIndices = [...selectedIndices].sort((left, right) => left - right);
  const selectedOrder = selectedIndices.map((catalogIndex, paletteOffset) => ({ catalogIndex, paletteId: paletteOffset + 1 }));
  const paletteInputs: PaletteEntryInput[] = selectedOrder.map(({ catalogIndex, paletteId }) => paletteEntry(paletteId, catalog[catalogIndex]));
  const paletteIdByCatalogIndex = new Map(selectedOrder.map(({ catalogIndex, paletteId }) => [catalogIndex, paletteId]));
  conversionCancelled(cancellation, token.requestId);
  const document = createDocument({ width: options.targetWidth, height: options.targetHeight, palette: paletteInputs });
  conversionCancelled(cancellation, token.requestId);
  const usage = new Map<number, number>();
  let stitchedPixels = 0;
  for (let targetIndex = 0; targetIndex < document.width * document.height; targetIndex += 1) {
    const offset = targetIndex * 4;
    if (sampled.pixels[offset + 3] === 0) {
      // Keep the default empty-cell planes untouched.
    } else {
      const pixel = sourceRgb(sampled.pixels, offset);
      // The background color is skipped before selection, so it can never be
      // in the palette; check each pixel's true catalog match against it so
      // background pixels stay unstitched instead of remapping to a kept color.
      if (backgroundIndex >= 0 && nearestCatalogIndex(pixel, catalog) === backgroundIndex) {
        // Background pixels are left empty in the assignment pass as well.
      } else {
        const sourceCatalogIndex = nearestCatalogIndex(pixel, selected);
        const paletteId = paletteIdByCatalogIndex.get(selectedCatalogIndices[sourceCatalogIndex]);
        if (paletteId !== undefined) {
          document.kind[targetIndex] = CellKind.Full;
          document.colors[targetIndex * 4] = paletteId;
          usage.set(paletteId, (usage.get(paletteId) ?? 0) + 1);
          stitchedPixels += 1;
        }
      }
    }
    if ((targetIndex + 1) % CONVERSION_LOOP_CHUNK === 0) {
      conversionCancelled(cancellation, token.requestId);
      await yieldConversionWork();
      conversionCancelled(cancellation, token.requestId);
    }
  }
  conversionCancelled(cancellation, token.requestId);
  // Trimming only removes Empty cells (zeroed color slots the usage counting
  // skips), so palette and usage stay valid without recomputation. The
  // transparent count is re-scoped to the kept box so every stat describes
  // the final document.
  if (options.autoCrop === true) {
    const box = trimDocumentToContent(document);
    if (box !== null) {
      let keptTransparent = 0;
      let checked = 0;
      for (let y = box.top; y <= box.bottom; y += 1) {
        for (let x = box.left; x <= box.right; x += 1) {
          if (sampled.pixels[(y * sampled.width + x) * 4 + 3] === 0) keptTransparent += 1;
          checked += 1;
          if (checked % CONVERSION_LOOP_CHUNK === 0) {
            conversionCancelled(cancellation, token.requestId);
            await yieldConversionWork();
            conversionCancelled(cancellation, token.requestId);
          }
        }
      }
      transparentPixels = keptTransparent;
    }
  }
  const paletteUsage = selectedOrder
    .map(({ catalogIndex, paletteId }) => ({ paletteId, catalogId: catalog[catalogIndex].sourceId, count: usage.get(paletteId) ?? 0 }))
    .filter((entry) => entry.count > 0);
  return {
    token,
    document,
    stats: {
      sourceWidth,
      sourceHeight,
      targetWidth: document.width,
      targetHeight: document.height,
      totalPixels: document.width * document.height,
      transparentPixels,
      emptyPixels: document.width * document.height - stitchedPixels,
      stitchedPixels,
      matchedColorCount: matchedColors.size,
      paletteUsage
    },
    sourceImage: {
      ...(options.sourceImage?.assetId === undefined ? {} : { assetId: options.sourceImage.assetId }),
      ...(options.sourceImage?.mimeType === undefined ? {} : { mimeType: options.sourceImage.mimeType }),
      width: sourceWidth,
      height: sourceHeight,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      chartBounds: { x: 0, y: 0, width: document.width, height: document.height },
      traceVisible: false,
      opacity: 1
    }
  };
}

export function validateConversionDraft(draft: ConversionDraft): void {
  if (!draft || typeof draft !== 'object') throw new ConversionError('invalid-draft', 'The conversion draft is malformed.');
  try {
    assertToken(draft.token);
    assertValidDocument(draft.document);
  } catch (error) {
    throw new ConversionError('invalid-draft', error instanceof Error ? error.message : 'The conversion draft document is malformed.');
  }
  assertPositiveDimensions(draft.document.width, draft.document.height, 'target');
  if (draft.document.kind.length !== draft.document.width * draft.document.height || draft.document.colors.length !== draft.document.width * draft.document.height * 4) throw new ConversionError('invalid-draft', 'The conversion draft planes are malformed.');
  if (!draft.stats || draft.stats.targetWidth !== draft.document.width || draft.stats.targetHeight !== draft.document.height || draft.stats.totalPixels !== draft.document.width * draft.document.height || !Number.isSafeInteger(draft.stats.transparentPixels) || !Number.isSafeInteger(draft.stats.emptyPixels) || !Number.isSafeInteger(draft.stats.stitchedPixels) || draft.stats.transparentPixels < 0 || draft.stats.transparentPixels > draft.stats.emptyPixels || draft.stats.emptyPixels < 0 || draft.stats.stitchedPixels < 0 || draft.stats.emptyPixels + draft.stats.stitchedPixels !== draft.stats.totalPixels) throw new ConversionError('invalid-draft', 'The conversion draft statistics do not match its document.');
  assertPositiveSourceDimensions(draft.stats.sourceWidth, draft.stats.sourceHeight);
  if (!draft.sourceImage || (draft.sourceImage.assetId !== undefined && (typeof draft.sourceImage.assetId !== 'string' || draft.sourceImage.assetId.length < 1)) || (draft.sourceImage.mimeType !== undefined && typeof draft.sourceImage.mimeType !== 'string') || draft.sourceImage.width !== draft.stats.sourceWidth || draft.sourceImage.height !== draft.stats.sourceHeight || draft.sourceImage.crop.x !== 0 || draft.sourceImage.crop.y !== 0 || draft.sourceImage.crop.width !== 1 || draft.sourceImage.crop.height !== 1 || draft.sourceImage.chartBounds.x !== 0 || draft.sourceImage.chartBounds.y !== 0 || draft.sourceImage.chartBounds.width !== draft.document.width || draft.sourceImage.chartBounds.height !== draft.document.height || typeof draft.sourceImage.traceVisible !== 'boolean' || draft.sourceImage.opacity !== 1) throw new ConversionError('invalid-draft', 'The conversion draft source image candidate is malformed.');
  const paletteIds = new Set(draft.document.palette.map((entry) => entry.id));
  let usageTotal = 0;
  for (const entry of draft.stats.paletteUsage) {
    if (!paletteIds.has(entry.paletteId) || typeof entry.catalogId !== 'string' || !Number.isSafeInteger(entry.count) || entry.count < 1) throw new ConversionError('invalid-draft', 'The conversion draft palette statistics are malformed.');
    usageTotal += entry.count;
  }
  if (usageTotal !== draft.stats.stitchedPixels) throw new ConversionError('invalid-draft', 'The conversion draft palette statistics do not match stitched pixels.');
}

export function acceptConversionDraft(draft: ConversionDraft): AcceptedConversionDraft {
  validateConversionDraft(draft);
  return { ...draft, accepted: true };
}

export const acceptDraft = acceptConversionDraft;
export const validateDraft = validateConversionDraft;

export function validateAcceptedConversionDraft(draft: AcceptedConversionDraft): void {
  if (!draft || draft.accepted !== true) throw new ConversionError('invalid-draft', 'The conversion draft must be explicitly accepted before project creation.');
  validateConversionDraft(draft);
}

export function resampleRaster(raster: ConversionRaster, targetWidth: number, targetHeight: number): ConversionRaster {
  assertRaster(raster);
  assertPositiveDimensions(targetWidth, targetHeight, 'target');
  if (raster.width === targetWidth && raster.height === targetHeight) return {
    width: raster.width,
    height: raster.height,
    sourceWidth: raster.sourceWidth ?? raster.width,
    sourceHeight: raster.sourceHeight ?? raster.height,
    pixels: new Uint8ClampedArray(raster.pixels)
  };
  const pixels = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(raster.height - 1, Math.floor((y + 0.5) * raster.height / targetHeight));
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(raster.width - 1, Math.floor((x + 0.5) * raster.width / targetWidth));
      const sourceOffset = (sourceY * raster.width + sourceX) * 4;
      const targetOffset = (y * targetWidth + x) * 4;
      pixels.set(raster.pixels.subarray(sourceOffset, sourceOffset + 4), targetOffset);
    }
  }
  return {
    width: targetWidth,
    height: targetHeight,
    sourceWidth: raster.sourceWidth ?? raster.width,
    sourceHeight: raster.sourceHeight ?? raster.height,
    pixels
  };
}

export async function resampleRasterAsync(
  raster: ConversionRaster,
  targetWidth: number,
  targetHeight: number,
  cancellation?: ConversionCancellation
): Promise<ConversionRaster> {
  assertRaster(raster);
  assertPositiveDimensions(targetWidth, targetHeight, 'target');
  conversionCancelled(cancellation);
  if (raster.width === targetWidth && raster.height === targetHeight) {
    const pixels = new Uint8ClampedArray(raster.pixels.length);
    for (let offset = 0; offset < raster.pixels.length; offset += 4) {
      pixels[offset] = raster.pixels[offset];
      pixels[offset + 1] = raster.pixels[offset + 1];
      pixels[offset + 2] = raster.pixels[offset + 2];
      pixels[offset + 3] = raster.pixels[offset + 3];
      if (((offset / 4) + 1) % CONVERSION_LOOP_CHUNK === 0) {
        conversionCancelled(cancellation);
        await yieldConversionWork();
        conversionCancelled(cancellation);
      }
    }
    conversionCancelled(cancellation);
    return {
      width: raster.width,
      height: raster.height,
      sourceWidth: raster.sourceWidth ?? raster.width,
      sourceHeight: raster.sourceHeight ?? raster.height,
      pixels
    };
  }
  const pixels = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  let processed = 0;
  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceY = Math.min(raster.height - 1, Math.floor((y + 0.5) * raster.height / targetHeight));
      const sourceX = Math.min(raster.width - 1, Math.floor((x + 0.5) * raster.width / targetWidth));
      const sourceOffset = (sourceY * raster.width + sourceX) * 4;
      const targetOffset = (y * targetWidth + x) * 4;
      pixels.set(raster.pixels.subarray(sourceOffset, sourceOffset + 4), targetOffset);
      processed += 1;
      if (processed % CONVERSION_LOOP_CHUNK === 0) {
        conversionCancelled(cancellation);
        await yieldConversionWork();
        conversionCancelled(cancellation);
      }
    }
  }
  conversionCancelled(cancellation);
  return {
    width: targetWidth,
    height: targetHeight,
    sourceWidth: raster.sourceWidth ?? raster.width,
    sourceHeight: raster.sourceHeight ?? raster.height,
    pixels
  };
}

export function conversionTokensEqual(left: ConversionToken, right: ConversionToken): boolean {
  return left.projectId === right.projectId && left.baseRevision === right.baseRevision && left.requestId === right.requestId;
}

export function createConversionRequest(
  raster: ConversionRaster,
  options: ConversionOptions
): ConversionRasterRequestMessage {
  assertRaster(raster);
  assertPositiveDimensions(options.targetWidth, options.targetHeight, 'target');
  const token = options.token ?? defaultToken();
  assertToken(token);
  const sourceWidth = raster.sourceWidth ?? raster.width;
  const sourceHeight = raster.sourceHeight ?? raster.height;
  assertPositiveSourceDimensions(sourceWidth, sourceHeight);
  return {
    protocol: CONVERSION_PROTOCOL,
    type: CONVERSION_REQUEST_TYPE,
    inputType: 'raster',
    token,
    width: raster.width,
    height: raster.height,
    targetWidth: options.targetWidth,
    targetHeight: options.targetHeight,
    sourceWidth,
    sourceHeight,
    pixels: new Uint8ClampedArray(raster.pixels),
    ...(options.paletteBudget === undefined ? {} : { paletteBudget: options.paletteBudget }),
    ...(options.backgroundSourceId === undefined ? {} : { backgroundSourceId: options.backgroundSourceId }),
    ...(options.autoCrop === undefined ? {} : { autoCrop: options.autoCrop }),
    ...(options.catalog === undefined ? {} : { catalog: options.catalog.map((color) => ({ ...color, rgb: [...color.rgb] as [number, number, number] })) }),
    ...(options.sourceImage?.assetId === undefined ? {} : { sourceAssetId: options.sourceImage.assetId }),
    ...(options.sourceImage?.mimeType === undefined ? {} : { sourceMimeType: options.sourceImage.mimeType })
  };
}

export interface ConversionImageRequestOptions extends ConversionOptions {
  readonly source: Blob;
  readonly maxBytes?: number;
  readonly maxPixels?: number;
}

function blobLike(value: unknown): value is Blob {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { arrayBuffer?: unknown }).arrayBuffer === 'function'
    && typeof (value as { size?: unknown }).size === 'number';
}

function boundedDecodeLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new ConversionError('invalid-raster', 'The image decode limit is outside the supported bounds.');
  return value;
}

export function createConversionImageRequest(options: ConversionImageRequestOptions): ConversionImageRequestMessage {
  if (!blobLike(options.source)) throw new ConversionError('invalid-raster', 'The conversion image source is unavailable.');
  assertPositiveDimensions(options.targetWidth, options.targetHeight, 'target');
  const token = options.token ?? defaultToken();
  assertToken(token);
  if (!Number.isFinite(options.source.size) || options.source.size > MAX_CONVERSION_SOURCE_BYTES) throw new ConversionError('invalid-raster', 'The image source exceeds the local byte limit.');
  const maxBytes = boundedDecodeLimit(options.maxBytes, MAX_CONVERSION_SOURCE_BYTES, MAX_CONVERSION_SOURCE_BYTES);
  const maxPixels = boundedDecodeLimit(options.maxPixels, MAX_CONVERSION_SOURCE_PIXELS, MAX_CONVERSION_SOURCE_PIXELS);
  if (options.source.size > maxBytes) throw new ConversionError('invalid-raster', 'The image source exceeds the configured byte limit.');
  return {
    protocol: CONVERSION_PROTOCOL,
    type: CONVERSION_REQUEST_TYPE,
    inputType: 'image',
    token,
    targetWidth: options.targetWidth,
    targetHeight: options.targetHeight,
    image: options.source,
    maxBytes,
    maxPixels,
    ...(options.paletteBudget === undefined ? {} : { paletteBudget: options.paletteBudget }),
    ...(options.backgroundSourceId === undefined ? {} : { backgroundSourceId: options.backgroundSourceId }),
    ...(options.autoCrop === undefined ? {} : { autoCrop: options.autoCrop }),
    ...(options.catalog === undefined ? {} : { catalog: options.catalog.map((color) => ({ ...color, rgb: [...color.rgb] as [number, number, number] })) }),
    ...(options.sourceImage?.assetId === undefined ? {} : { sourceAssetId: options.sourceImage.assetId }),
    ...(options.sourceImage?.mimeType === undefined ? {} : { sourceMimeType: options.sourceImage.mimeType })
  };
}

function isRasterRequest(request: ConversionRequestMessage): request is ConversionRasterRequestMessage {
  return request.inputType === 'raster';
}

export function validateConversionRequest(request: ConversionRequestMessage): void {
  if (!request || typeof request !== 'object' || request.protocol !== CONVERSION_PROTOCOL || request.type !== CONVERSION_REQUEST_TYPE) {
    throw new ConversionError('invalid-raster', 'The conversion request protocol is malformed.');
  }
  assertToken(request.token);
  assertPositiveDimensions(request.targetWidth, request.targetHeight, 'target');
  if (isRasterRequest(request)) {
    assertPositiveDimensions(request.width, request.height, 'raster');
    assertPositiveSourceDimensions(request.sourceWidth, request.sourceHeight);
    if (!(request.pixels instanceof Uint8ClampedArray) || request.pixels.length !== request.width * request.height * 4) {
      throw new ConversionError('invalid-raster', 'The conversion request pixel plane is malformed.');
    }
    return;
  }
  if (request.inputType !== 'image' || !blobLike(request.image) || !Number.isFinite(request.image.size) || request.image.size > MAX_CONVERSION_SOURCE_BYTES) throw new ConversionError('invalid-raster', 'The conversion image request is malformed or exceeds the byte limit.');
  boundedDecodeLimit(request.maxBytes, MAX_CONVERSION_SOURCE_BYTES, MAX_CONVERSION_SOURCE_BYTES);
  boundedDecodeLimit(request.maxPixels, MAX_CONVERSION_SOURCE_PIXELS, MAX_CONVERSION_SOURCE_PIXELS);
  if (request.maxBytes !== undefined && request.image.size > request.maxBytes) throw new ConversionError('invalid-raster', 'The conversion image exceeds its configured byte limit.');
}

export function convertConversionRequest(request: ConversionRequestMessage): ConversionResultMessage {
  validateConversionRequest(request);
  if (!isRasterRequest(request)) throw new ConversionError('invalid-raster', 'Image requests must be decoded before synchronous conversion.');
  const draft = convertRasterToPattern({
    width: request.width,
    height: request.height,
    sourceWidth: request.sourceWidth,
    sourceHeight: request.sourceHeight,
    pixels: request.pixels
  }, {
    targetWidth: request.targetWidth,
    targetHeight: request.targetHeight,
    paletteBudget: request.paletteBudget,

    backgroundSourceId: request.backgroundSourceId,
    autoCrop: request.autoCrop,
    token: request.token,
    catalog: request.catalog,
    sourceImage: {
      ...(request.sourceAssetId === undefined ? {} : { assetId: request.sourceAssetId }),
      ...(request.sourceMimeType === undefined ? {} : { mimeType: request.sourceMimeType })
    }
  });
  return { protocol: CONVERSION_PROTOCOL, type: CONVERSION_RESULT_TYPE, token: request.token, draft };
}

export async function convertConversionRequestAsync(
  request: ConversionRequestMessage,
  cancellation?: ConversionCancellation
): Promise<ConversionResultMessage> {
  validateConversionRequest(request);
  if (!isRasterRequest(request)) throw new ConversionError('invalid-raster', 'Image requests must be decoded before conversion.');
  const draft = await convertRasterToPatternAsync({
    width: request.width,
    height: request.height,
    sourceWidth: request.sourceWidth,
    sourceHeight: request.sourceHeight,
    pixels: request.pixels
  }, {
    targetWidth: request.targetWidth,
    targetHeight: request.targetHeight,
    paletteBudget: request.paletteBudget,

    backgroundSourceId: request.backgroundSourceId,
    autoCrop: request.autoCrop,
    token: request.token,
    catalog: request.catalog,
    sourceImage: {
      ...(request.sourceAssetId === undefined ? {} : { assetId: request.sourceAssetId }),
      ...(request.sourceMimeType === undefined ? {} : { mimeType: request.sourceMimeType })
    }
  }, cancellation);
  return { protocol: CONVERSION_PROTOCOL, type: CONVERSION_RESULT_TYPE, token: request.token, draft };
}

export function createConversionCancelled(token: ConversionToken): ConversionCancelledMessage {
  assertToken(token);
  return { protocol: CONVERSION_PROTOCOL, type: CONVERSION_CANCELLED_TYPE, token };
}

export function createConversionCancel(token: ConversionToken): ConversionCancelMessage {
  assertToken(token);
  return { protocol: CONVERSION_PROTOCOL, type: CONVERSION_CANCEL_TYPE, token };
}

export function createConversionError(error: unknown, token?: ConversionToken): ConversionErrorMessage {
  if (token !== undefined) assertToken(token);
  const errorCode = error instanceof ConversionError
    ? error.code
    : isRecord(error) && typeof error.code === 'string'
      ? error.code
      : 'conversion-failed';
  return {
    protocol: CONVERSION_PROTOCOL,
    type: CONVERSION_ERROR_TYPE,
    ...(token === undefined ? {} : { token }),
    code: errorCode,
    message: error instanceof Error ? error.message : 'The image conversion failed.'
  };
}
