import { PersistenceError } from './errors';
import type {
  NormalizedSourceImageCrop,
  ProjectAsset,
  ProjectAssetInput,
  SourceImageChartBounds,
  SourceImageDescriptor,
  SourceImageHealth,
  SourceImageMimeType,
  SourceImageOrientation,
  SourceImageSettingsInput
} from './types';
import { isArchiveSafeAssetId, isValidAssetId, MAX_ASSET_BYTES } from './limits';
import { isWithinImageDecodeBounds, MAX_IMAGE_DECODE_PIXELS } from '../shared/limits';
import { sha256 } from './hash';

/**
 * A reference asset may hold the original full-resolution image, which the
 * conversion pipeline pre-scales to its working bounds; the persistence
 * ceiling matches the shared image decode ceiling so conversion, persistence,
 * and the editor reference decode all agree.
 */
export const MAX_SOURCE_IMAGE_PIXELS = MAX_IMAGE_DECODE_PIXELS;
export const SUPPORTED_SOURCE_IMAGE_MIME_TYPES: readonly SourceImageMimeType[] = ['image/png', 'image/jpeg', 'image/webp'];

export interface RasterImageDimensions {
  mimeType: SourceImageMimeType;
  width: number;
  height: number;
  /** Present when a valid JPEG EXIF orientation tag was retained. */
  orientation?: SourceImageOrientation;
}

export async function normalizeSourceImageAsset(input: ProjectAssetInput): Promise<ProjectAsset> {
  if (!isArchiveSafeAssetId(input.id) || typeof input.name !== 'string' || input.name.length > 512 || typeof input.mimeType !== 'string' || input.mimeType.length > 256) invalidAsset('Source image asset metadata is malformed.');
  let data: Uint8Array;
  if (typeof Blob !== 'undefined' && input.data instanceof Blob) {
    if (input.data.size > MAX_ASSET_BYTES) invalidAsset(`Source image asset ${input.id} exceeds the size limit.`);
    data = new Uint8Array(await input.data.arrayBuffer());
  } else if (input.data instanceof Uint8Array) {
    data = input.data.slice();
  } else if (input.data instanceof ArrayBuffer) {
    data = new Uint8Array(input.data).slice();
  } else {
    invalidAsset(`Source image asset ${input.id} has unsupported data.`);
  }
  if (data.length > MAX_ASSET_BYTES) invalidAsset(`Source image asset ${input.id} exceeds the size limit.`);
  const dimensions = inspectRasterAsset({ mimeType: input.mimeType, data });
  const asset = { id: input.id, name: input.name, mimeType: dimensions.mimeType, data, checksum: await sha256(data) };
  return asset;
}

function invalidAsset(message: string): never {
  throw new PersistenceError('invalid-asset', message);
}

function invalidMetadata(message: string): never {
  throw new PersistenceError('invalid-metadata', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFinitePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isSupportedMimeType(value: unknown): value is SourceImageMimeType {
  return typeof value === 'string' && (SUPPORTED_SOURCE_IMAGE_MIME_TYPES as readonly string[]).includes(value.toLowerCase() as SourceImageMimeType);
}

function bytesOf(asset: Pick<ProjectAsset, 'data'>): Uint8Array {
  return asset.data;
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function ascii(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset + value.length > bytes.length) return false;
  return [...value].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24 || !bytes.slice(0, 8).every((byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index]) || !ascii(bytes, 12, 'IHDR')) return undefined;
  const view = dataView(bytes);
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}

function isOrientation(value: unknown): value is SourceImageOrientation {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 8;
}

function readExifOrientation(bytes: Uint8Array, payloadStart: number, payloadEnd: number): SourceImageOrientation | undefined {
  if (payloadStart + 6 > payloadEnd || !ascii(bytes, payloadStart, 'Exif\0\0')) return undefined;
  const tiffStart = payloadStart + 6;
  if (tiffStart + 8 > payloadEnd) invalidAsset('JPEG EXIF orientation data is truncated.');
  const littleEndian = ascii(bytes, tiffStart, 'II');
  const bigEndian = ascii(bytes, tiffStart, 'MM');
  if (!littleEndian && !bigEndian) invalidAsset('JPEG EXIF byte order is invalid.');
  const view = dataView(bytes);
  const read16 = (offset: number): number => view.getUint16(offset, littleEndian);
  const read32 = (offset: number): number => view.getUint32(offset, littleEndian);
  if (read16(tiffStart + 2) !== 42) invalidAsset('JPEG EXIF TIFF header is invalid.');
  const ifdOffset = read32(tiffStart + 4);
  const ifdStart = tiffStart + ifdOffset;
  if (!Number.isSafeInteger(ifdStart) || ifdStart < tiffStart || ifdStart + 2 > payloadEnd) invalidAsset('JPEG EXIF directory offset is invalid.');
  const entryCount = read16(ifdStart);
  const entriesStart = ifdStart + 2;
  const entriesEnd = entriesStart + entryCount * 12;
  if (!Number.isSafeInteger(entriesEnd) || entriesEnd > payloadEnd) invalidAsset('JPEG EXIF directory is truncated.');
  for (let index = 0; index < entryCount; index += 1) {
    const entry = entriesStart + index * 12;
    if (read16(entry) !== 0x0112) continue;
    const type = read16(entry + 2);
    const count = read32(entry + 4);
    if (type !== 3 || count !== 1) invalidAsset('JPEG EXIF orientation has an invalid representation.');
    const orientation = read16(entry + 8);
    if (!isOrientation(orientation)) invalidAsset('JPEG EXIF orientation is outside the supported range.');
    return orientation;
  }
  return undefined;
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number; orientation?: SourceImageOrientation } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  let dimensions: { width: number; height: number } | undefined;
  let orientation: SourceImageOrientation | undefined;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return undefined;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return undefined;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return undefined;
    const isSof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (marker === 0xe1 && orientation === undefined) orientation = readExifOrientation(bytes, offset + 2, offset + length);
    if (isSof && length >= 7 && dimensions === undefined) {
      dimensions = { height: (bytes[offset + 3] << 8) | bytes[offset + 4], width: (bytes[offset + 5] << 8) | bytes[offset + 6] };
    }
    offset += length;
  }
  if (dimensions === undefined) return undefined;
  const swapsDimensions = orientation !== undefined && orientation >= 5;
  return {
    width: swapsDimensions ? dimensions.height : dimensions.width,
    height: swapsDimensions ? dimensions.width : dimensions.height,
    ...(orientation === undefined ? {} : { orientation })
  };
}

function little24(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 16 || !ascii(bytes, 0, 'RIFF') || !ascii(bytes, 8, 'WEBP')) return undefined;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunk = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true);
    const dataOffset = offset + 8;
    if (dataOffset + length > bytes.length) return undefined;
    if (chunk === 'VP8X' && length >= 10) return { width: 1 + little24(bytes, dataOffset + 4), height: 1 + little24(bytes, dataOffset + 7) };
    if (chunk === 'VP8L' && length >= 5 && bytes[dataOffset] === 0x2f) {
      const width = 1 + ((bytes[dataOffset + 1] | (bytes[dataOffset + 2] << 8)) & 0x3fff);
      const height = 1 + (((bytes[dataOffset + 2] >> 6) | (bytes[dataOffset + 3] << 2) | ((bytes[dataOffset + 4] & 0x3f) << 10)) & 0x3fff);
      return { width, height };
    }
    if (chunk === 'VP8 ' && length >= 10 && bytes[dataOffset + 3] === 0x9d && bytes[dataOffset + 4] === 0x01 && bytes[dataOffset + 5] === 0x2a) {
      const view = dataView(bytes);
      return { width: view.getUint16(dataOffset + 6, true) & 0x3fff, height: view.getUint16(dataOffset + 8, true) & 0x3fff };
    }
    offset = dataOffset + length + (length & 1);
  }
  return undefined;
}

function detectRasterDimensions(bytes: Uint8Array): { mimeType: SourceImageMimeType; dimensions: { width: number; height: number; orientation?: SourceImageOrientation } } | undefined {
  const png = pngDimensions(bytes);
  if (png) return { mimeType: 'image/png', dimensions: png };
  const jpeg = jpegDimensions(bytes);
  if (jpeg) return { mimeType: 'image/jpeg', dimensions: jpeg };
  const webp = webpDimensions(bytes);
  if (webp) return { mimeType: 'image/webp', dimensions: webp };
  return undefined;
}

function ensureDimensions(mimeType: SourceImageMimeType, dimensions: { width: number; height: number; orientation?: SourceImageOrientation } | undefined): RasterImageDimensions {
  if (!dimensions || !isWithinImageDecodeBounds(dimensions.width, dimensions.height)) invalidAsset('Source image signature is invalid or its dimensions exceed the pixel limit.');
  return { mimeType, width: dimensions.width, height: dimensions.height, ...(dimensions.orientation === undefined ? {} : { orientation: dimensions.orientation }) };
}

export function inspectRasterAsset(asset: Pick<ProjectAsset, 'mimeType' | 'data'>): RasterImageDimensions {
  const mimeType = asset.mimeType.trim().toLowerCase();
  if (!isSupportedMimeType(mimeType)) invalidAsset(`Source image MIME type ${asset.mimeType} is not supported.`);
  const bytes = bytesOf(asset);
  const detected = detectRasterDimensions(bytes);
  return ensureDimensions(detected?.mimeType ?? mimeType, detected?.dimensions);
}

function validateCrop(value: unknown): NormalizedSourceImageCrop {
  if (!isRecord(value)) invalidMetadata('Source image crop is malformed.');
  const { x, y, width, height } = value;
  if ([x, y, width, height].some((entry) => typeof entry !== 'number' || !Number.isFinite(entry)) || (x as number) < 0 || (y as number) < 0 || (width as number) <= 0 || (height as number) <= 0 || (x as number) + (width as number) > 1 || (y as number) + (height as number) > 1) invalidMetadata('Source image crop must be normalized within the source image.');
  return { x: x as number, y: y as number, width: width as number, height: height as number };
}

function validateChartBounds(value: unknown): SourceImageChartBounds {
  // Unbounded placement: x/y may be negative (offscreen or in the canvas
  // margins) and the rect may overflow the document. Only safe-integer
  // coordinates with positive width/height are required.
  if (!isRecord(value) || !isFinitePositiveInteger(value.width) || !isFinitePositiveInteger(value.height) || typeof value.x !== 'number' || typeof value.y !== 'number' || !Number.isSafeInteger(value.x) || !Number.isSafeInteger(value.y)) invalidMetadata('Source image chart bounds are malformed.');
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

export function validateSourceImageDescriptor(value: unknown): SourceImageDescriptor {
  if (!isRecord(value) || !isValidAssetId(value.assetId) || !isSupportedMimeType(value.mimeType) || (value.orientation !== undefined && !isOrientation(value.orientation)) || !isFinitePositiveInteger(value.width) || !isFinitePositiveInteger(value.height) || !isWithinImageDecodeBounds(value.width, value.height) || typeof value.traceVisible !== 'boolean' || typeof value.opacity !== 'number' || !Number.isFinite(value.opacity) || value.opacity < 0 || value.opacity > 1) invalidMetadata('Source image descriptor is malformed.');
  return {
    assetId: value.assetId,
    mimeType: value.mimeType.toLowerCase() as SourceImageMimeType,
    width: value.width,
    height: value.height,
    ...(value.orientation === undefined ? {} : { orientation: value.orientation }),
    crop: validateCrop(value.crop),
    chartBounds: validateChartBounds(value.chartBounds),
    traceVisible: value.traceVisible,
    opacity: value.opacity
  };
}

export function normalizeSourceImageDescriptor(
  input: SourceImageSettingsInput,
  documentSize: { width: number; height: number },
  asset: ProjectAsset
): SourceImageDescriptor {
  if (!isRecord(input) || typeof input.assetId !== 'string' || input.assetId !== asset.id) invalidMetadata('Source image asset ID does not match the selected asset.');
  if (typeof asset.checksum !== 'string' || !/^[0-9a-f]{64}$/.test(asset.checksum)) invalidAsset(`Source image asset ${asset.id} does not have a valid checksum.`);
  const dimensions = inspectRasterAsset(asset);
  if (input.mimeType !== undefined && !isSupportedMimeType(input.mimeType)) invalidMetadata('Source image MIME type is not supported.');
  if (input.width !== undefined && input.width !== dimensions.width) invalidMetadata('Source image width does not match the selected asset.');
  if (input.height !== undefined && input.height !== dimensions.height) invalidMetadata('Source image height does not match the selected asset.');
  if (input.orientation !== undefined && input.orientation !== (dimensions.orientation ?? 1)) invalidMetadata('Source image orientation does not match the selected asset.');
  return validateSourceImageDescriptor({
    assetId: asset.id,
    mimeType: dimensions.mimeType,
    width: dimensions.width,
    height: dimensions.height,
    ...(dimensions.orientation === undefined ? {} : { orientation: dimensions.orientation }),
    crop: input.crop ?? { x: 0, y: 0, width: 1, height: 1 },
    chartBounds: input.chartBounds ?? { x: 0, y: 0, width: documentSize.width, height: documentSize.height },
    traceVisible: input.traceVisible ?? true,
    opacity: input.opacity ?? 1
  });
}

export function inspectSourceImage(
  descriptor: SourceImageDescriptor | undefined,
  assets: readonly ProjectAsset[]
): SourceImageHealth | undefined {
  if (descriptor === undefined) return undefined;
  const assetId = isRecord(descriptor) && typeof descriptor.assetId === 'string' ? descriptor.assetId : 'unknown';
  try {
    const normalized = validateSourceImageDescriptor(descriptor);
    const asset = assets.find((candidate) => candidate.id === normalized.assetId);
    if (!asset) return { assetId: normalized.assetId, status: 'missing', warning: `Optional source image asset ${normalized.assetId} is missing; the reference image is unavailable.` };
    const dimensions = inspectRasterAsset(asset);
    if (dimensions.mimeType !== normalized.mimeType || dimensions.width !== normalized.width || dimensions.height !== normalized.height) throw new Error('Source image descriptor does not match the stored asset.');
    if (normalized.orientation !== undefined && normalized.orientation !== (dimensions.orientation ?? 1)) throw new Error('Source image orientation does not match the stored asset.');
    return { assetId: normalized.assetId, status: 'valid' };
  } catch (error) {
    return { assetId, status: 'corrupt', warning: `Optional source image asset ${assetId} is corrupt; the reference image is unavailable: ${error instanceof Error ? error.message : 'invalid source image data'}` };
  }
}
