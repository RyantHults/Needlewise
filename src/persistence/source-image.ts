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
import { isValidAssetId } from './limits';
import { isWithinImageDecodeBounds } from '../image/limits';
import { readImageHeader, type ImageHeader } from '../image/header';
import { readAssetInputBytes, isSha256Hex } from './asset-input';
import { sha256 } from './hash';
import { isRecord } from '../domain';

export const SUPPORTED_SOURCE_IMAGE_MIME_TYPES: readonly SourceImageMimeType[] = ['image/png', 'image/jpeg', 'image/webp'];

export async function normalizeSourceImageAsset(input: ProjectAssetInput): Promise<ProjectAsset> {
  const data = await readAssetInputBytes(input);
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

function isFinitePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isSupportedMimeType(value: unknown): value is SourceImageMimeType {
  return typeof value === 'string' && (SUPPORTED_SOURCE_IMAGE_MIME_TYPES as readonly string[]).includes(value.toLowerCase() as SourceImageMimeType);
}

function isOrientation(value: unknown): value is SourceImageOrientation {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 8;
}

/** The asset's format and displayed dimensions, sniffed from its bytes; the declared MIME type must still be a supported one. */
export function inspectRasterAsset(asset: Pick<ProjectAsset, 'mimeType' | 'data'>): ImageHeader {
  if (!isSupportedMimeType(asset.mimeType.trim())) invalidAsset(`Source image MIME type ${asset.mimeType} is not supported.`);
  const header = readImageHeader(asset.data);
  if (!header || !isWithinImageDecodeBounds(header.width, header.height)) invalidAsset('Source image signature is invalid or its dimensions exceed the pixel limit.');
  return header;
}

function assertDescriptorMatchesAsset(descriptor: SourceImageDescriptor, asset: ProjectAsset): void {
  const header = inspectRasterAsset(asset);
  if (header.mimeType !== descriptor.mimeType || header.width !== descriptor.width || header.height !== descriptor.height) throw new Error('Source image descriptor does not match the stored asset.');
  if (descriptor.orientation !== undefined && descriptor.orientation !== (header.orientation ?? 1)) throw new Error('Source image orientation does not match the stored asset.');
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
  // Opacity 0 is never stored: hiding is `traceVisible`. A reference at 0 was
  // already invisible, so hidden at full opacity looks the same and shows usably later.
  const zeroOpacity = value.opacity === 0;
  return {
    assetId: value.assetId,
    mimeType: value.mimeType.toLowerCase() as SourceImageMimeType,
    width: value.width,
    height: value.height,
    ...(value.orientation === undefined ? {} : { orientation: value.orientation }),
    crop: validateCrop(value.crop),
    chartBounds: validateChartBounds(value.chartBounds),
    traceVisible: zeroOpacity ? false : value.traceVisible,
    opacity: zeroOpacity ? 1 : value.opacity
  };
}

export function normalizeSourceImageDescriptor(
  input: SourceImageSettingsInput,
  documentSize: { width: number; height: number },
  asset: ProjectAsset
): SourceImageDescriptor {
  if (!isRecord(input) || typeof input.assetId !== 'string' || input.assetId !== asset.id) invalidMetadata('Source image asset ID does not match the selected asset.');
  if (!isSha256Hex(asset.checksum)) invalidAsset(`Source image asset ${asset.id} does not have a valid checksum.`);
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
    assertDescriptorMatchesAsset(normalized, asset);
    return { assetId: normalized.assetId, status: 'valid' };
  } catch (error) {
    return { assetId, status: 'corrupt', warning: `Optional source image asset ${assetId} is corrupt; the reference image is unavailable: ${error instanceof Error ? error.message : 'invalid source image data'}` };
  }
}
