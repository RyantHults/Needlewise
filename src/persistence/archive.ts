import {
  strToU8,
  Unzip,
  UnzipInflate,
  UnzipPassThrough,
  zipSync
} from 'fflate';
import { assertValidDocument, DOCUMENT_SCHEMA_VERSION, LEGACY_DOCUMENT_SCHEMA_VERSION, PENULTIMATE_DOCUMENT_SCHEMA_VERSION, PRIOR_DOCUMENT_SCHEMA_VERSION, normalizeAidaCount, normalizeDisplayUnits, normalizeMaterialAssumptions } from '../domain';
import { PersistenceError } from './errors';
import {
  ARCHIVE_FORMAT,
  LEGACY_PERSISTENCE_SCHEMA_VERSION,
  PRIOR_PERSISTENCE_SCHEMA_VERSION,
  PERSISTENCE_SCHEMA_VERSION,
  type ArchiveAssetManifest,
  type ArchiveBundle,
  type ArchiveExportOptions,
  type ArchiveImportOptions,
  type ArchiveManifest,
  type ProjectAsset,
  type ProjectMetadata
} from './types';
import type { MaterialSettingsV2 } from '../domain';
import { normalizeProgressActivity, type ProgressActivity } from './activity';
import {
  isBoundedMetadataString,
  isArchiveSafeAssetId,
  isValidAssetId,
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_EXPANSION_BYTES,
  MAX_ASSET_BYTES,
  MAX_ASSET_TOTAL_BYTES,
  MAX_DOCUMENT_BYTES,
  MAX_DAILY_ACTIVITY_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_METADATA_BYTES
} from './limits';
import { sha256 } from './hash';
import { decodeDocument, encodeDocument } from './binary';
import { inspectRasterAsset, validateSourceImageDescriptor } from './source-image';
import { deriveProjectSummary } from './project-thumbnail';

const MANIFEST_PATH = 'manifest.json';
const METADATA_PATH = 'metadata.json';
const DOCUMENT_PATH = 'document.bin';
const ACTIVITY_PATH = 'activity.json';
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_ALLOWED_FLAGS = ZIP_UTF8_FLAG;
const ZIP_STORE = 0;
const ZIP_DEFLATE = 8;
const ZIP_FIXED_BYTES = 46;
const ZIP_LOCAL_FIXED_BYTES = 30;

interface ZipEntry {
  readonly name: string;
  readonly rawName: Uint8Array;
  readonly compression: number;
  readonly flags: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

interface ZipPreflight {
  readonly entries: ZipEntry[];
  readonly byName: Map<string, ZipEntry>;
}

function invalidArchive(message: string, cause?: unknown): never {
  throw new PersistenceError('invalid-archive', message, cause);
}

function invalidManifest(message: string): never {
  throw new PersistenceError('invalid-manifest', message);
}

function bytesOf(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? value.slice() : new Uint8Array(value).slice();
}

async function bytesOfArchive(value: Uint8Array | ArrayBuffer | Blob): Promise<Uint8Array> {
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    // Blob.arrayBuffer() is an allocation boundary. Reject by the advertised
    // size before crossing it, rather than reading and then discarding data.
    if (value.size > MAX_ARCHIVE_BYTES) throw new PersistenceError('archive-too-large', 'Archive exceeds the maximum supported size.');
    return new Uint8Array(await value.arrayBuffer());
  }
  if (value instanceof Uint8Array && value.byteLength > MAX_ARCHIVE_BYTES) throw new PersistenceError('archive-too-large', 'Archive exceeds the maximum supported size.');
  if (value instanceof ArrayBuffer && value.byteLength > MAX_ARCHIVE_BYTES) throw new PersistenceError('archive-too-large', 'Archive exceeds the maximum supported size.');
  return bytesOf(value as Uint8Array | ArrayBuffer);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isProjectId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && isBoundedMetadataString(value);
}

interface ValidatedMetadata {
  metadata: ProjectMetadata;
  warnings: string[];
}

function validateMetadata(value: unknown): ValidatedMetadata {
  if (
    !isRecord(value)
    || !isProjectId(value.id)
    || typeof value.title !== 'string'
    || typeof value.notes !== 'string'
    || !isBoundedMetadataString(value.title)
    || !isBoundedMetadataString(value.notes)
    || !isNonNegativeInteger(value.createdAt)
    || !isNonNegativeInteger(value.updatedAt)
    || !isNonNegativeInteger(value.revision)
  ) {
    throw new PersistenceError('invalid-metadata', 'Project metadata is malformed.');
  }
  let aidaCount: ProjectMetadata['aidaCount'];
  if (value.aidaCount !== undefined) {
    try {
      aidaCount = normalizeAidaCount(value.aidaCount);
    } catch (error) {
      throw new PersistenceError('invalid-metadata', 'Project Aida count is malformed.', error);
    }
  }
  let materialSettings: ProjectMetadata['materialSettings'];
  if (value.materialSettings !== undefined) {
    try {
      materialSettings = normalizeMaterialAssumptions(value.materialSettings as MaterialSettingsV2);
    } catch (error) {
      throw new PersistenceError('invalid-metadata', 'Project material settings are malformed.', error);
    }
  }
  let units: ProjectMetadata['units'];
  if (value.units !== undefined) {
    try {
      units = normalizeDisplayUnits(value.units);
    } catch (error) {
      throw new PersistenceError('invalid-metadata', 'Project display units are malformed.', error);
    }
  }
  let sourceImage: ProjectMetadata['sourceImage'];
  const warnings: string[] = [];
  if (value.sourceImage !== undefined) {
    try {
      sourceImage = validateSourceImageDescriptor(value.sourceImage);
    } catch (error) {
      warnings.push(`Optional source image settings were omitted: ${error instanceof Error ? error.message : 'malformed metadata'}.`);
    }
  }
  return {
    metadata: {
      id: value.id,
      title: value.title,
      notes: value.notes,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      revision: value.revision,
      ...(aidaCount === undefined ? {} : { aidaCount }),
      ...(units === undefined ? {} : { units }),
      ...(materialSettings === undefined ? {} : { materialSettings }),
      ...(sourceImage === undefined ? {} : { sourceImage })
    },
    warnings
  };
}

function withoutSourceImage(metadata: ProjectMetadata): ProjectMetadata {
  const next = { ...metadata };
  delete next.sourceImage;
  return next;
}

function validateAssetInput(asset: ProjectAsset): void {
  if (
    !isValidAssetId(asset.id)
    || typeof asset.name !== 'string'
    || asset.name.length > 512
    || typeof asset.mimeType !== 'string'
    || asset.mimeType.length > 256
    || asset.data.length > MAX_ASSET_BYTES
    || !isSha256(asset.checksum)
  ) {
    throw new PersistenceError('invalid-asset', `Asset ${String(asset.id)} is malformed or too large.`);
  }
}

function validateManifestShape(value: unknown): ArchiveManifest {
  if (!isRecord(value) || value.format !== ARCHIVE_FORMAT || (value.archiveVersion !== LEGACY_PERSISTENCE_SCHEMA_VERSION && value.archiveVersion !== PRIOR_PERSISTENCE_SCHEMA_VERSION && value.archiveVersion !== PERSISTENCE_SCHEMA_VERSION) || !isProjectId(value.projectId)) invalidManifest('Archive manifest identity or version is invalid.');
  const metadata = value.metadata;
  const document = value.document;
  if (!isRecord(metadata) || metadata.path !== METADATA_PATH || !isNonNegativeInteger(metadata.byteLength) || metadata.byteLength > MAX_METADATA_BYTES || !isSha256(metadata.sha256)) invalidManifest('Archive metadata descriptor is invalid.');
  if (!isRecord(document) || document.path !== DOCUMENT_PATH || (document.schemaVersion !== LEGACY_DOCUMENT_SCHEMA_VERSION && document.schemaVersion !== PENULTIMATE_DOCUMENT_SCHEMA_VERSION && document.schemaVersion !== PRIOR_DOCUMENT_SCHEMA_VERSION && document.schemaVersion !== DOCUMENT_SCHEMA_VERSION) || !isNonNegativeInteger(document.byteLength) || document.byteLength > MAX_DOCUMENT_BYTES || !isSha256(document.sha256)) invalidManifest('Archive document descriptor is invalid.');
  if (!Array.isArray(value.assets) || value.assets.length > MAX_ARCHIVE_ENTRIES - 3 - (value.activity === undefined ? 0 : 1)) invalidManifest('Archive asset manifest is invalid.');
  const paths = new Set<string>([MANIFEST_PATH, METADATA_PATH, DOCUMENT_PATH]);
  const ids = new Set<string>();
  const assets: ArchiveAssetManifest[] = [];
  for (const candidate of value.assets) {
    if (
      !isRecord(candidate)
      || !isValidAssetId(candidate.id)
      || ids.has(candidate.id)
      || typeof candidate.path !== 'string'
      || !isArchivePathForAsset(candidate.id, candidate.path)
      || paths.has(candidate.path)
      || typeof candidate.name !== 'string'
      || candidate.name.length > 512
      || typeof candidate.mimeType !== 'string'
      || candidate.mimeType.length > 256
      || !isNonNegativeInteger(candidate.byteLength)
      || candidate.byteLength > MAX_ASSET_BYTES
      || !isSha256(candidate.sha256)
    ) invalidManifest('Archive asset descriptor is invalid.');
    ids.add(candidate.id);
    paths.add(candidate.path);
    assets.push({ id: candidate.id, path: candidate.path, name: candidate.name, mimeType: candidate.mimeType, byteLength: candidate.byteLength, sha256: candidate.sha256 });
  }
  let activity: ArchiveManifest['activity'];
  if (value.activity !== undefined) {
    const candidate = value.activity;
    if (!isRecord(candidate) || candidate.path !== ACTIVITY_PATH || !isNonNegativeInteger(candidate.byteLength) || candidate.byteLength > MAX_DAILY_ACTIVITY_BYTES || !isSha256(candidate.sha256)) invalidManifest('Archive activity descriptor is invalid.');
    activity = { path: ACTIVITY_PATH, byteLength: candidate.byteLength, sha256: candidate.sha256 };
  }
  return {
    format: ARCHIVE_FORMAT,
    archiveVersion: PERSISTENCE_SCHEMA_VERSION,
    projectId: value.projectId,
    metadata: { path: METADATA_PATH, byteLength: metadata.byteLength, sha256: metadata.sha256 },
    document: { path: DOCUMENT_PATH, schemaVersion: DOCUMENT_SCHEMA_VERSION, byteLength: document.byteLength, sha256: document.sha256 },
    ...(activity === undefined ? {} : { activity }),
    assets
  };
}

/**
 * Migrations always receive and return separate values. v1 has no changes yet,
 * but this boundary prevents a future migration from mutating parsed input.
 */
export function migrateArchiveManifest(input: unknown): ArchiveManifest {
  let copy: unknown;
  try {
    copy = JSON.parse(JSON.stringify(input)) as unknown;
  } catch (error) {
    throw new PersistenceError('invalid-manifest', 'Archive manifest cannot be copied.', error);
  }
  return validateManifestShape(copy);
}

export const migrateManifest = migrateArchiveManifest;

function parseJson(bytes: Uint8Array, label: string, maxBytes: number): unknown {
  if (bytes.length > maxBytes) invalidArchive(`${label} exceeds the size limit.`);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new PersistenceError('invalid-archive', `${label} is not valid UTF-8 JSON.`, error);
  }
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function utf16Bytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length * 2);
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    bytes[index * 2] = codeUnit >>> 8;
    bytes[index * 2 + 1] = codeUnit & 0xff;
  }
  return bytes;
}

function base64Url(bytes: Uint8Array): string {
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const first = bytes[offset];
    const second = offset + 1 < bytes.length ? bytes[offset + 1] : 0;
    const third = offset + 2 < bytes.length ? bytes[offset + 2] : 0;
    result += BASE64URL_ALPHABET[first >>> 2];
    result += BASE64URL_ALPHABET[((first & 0x03) << 4) | (second >>> 4)];
    if (offset + 1 < bytes.length) result += BASE64URL_ALPHABET[((second & 0x0f) << 2) | (third >>> 6)];
    if (offset + 2 < bytes.length) result += BASE64URL_ALPHABET[third & 0x3f];
  }
  return result;
}

function legacyArchivePathForAsset(id: string): string {
  const encoded = base64Url(utf16Bytes(id));
  const path = `assets/legacy~${encoded}`;
  if (path.length > 1024) invalidArchive('Archive asset path exceeds the size limit.');
  return path;
}

function legacyPercentArchivePathForAsset(id: string): string | undefined {
  try {
    return `assets/${encodeURIComponent(id)}`;
  } catch {
    // encodeURIComponent rejects lone surrogate code units. Such IDs use the
    // binary-safe path encoding for new exports and cannot be old percent
    // encoded archive names.
    return undefined;
  }
}

function decodeBase64Url(value: string): Uint8Array | undefined {
  if (value.length % 4 === 1 || !/^[A-Za-z0-9_-]*$/.test(value)) return undefined;
  const bytes: number[] = [];
  for (let offset = 0; offset < value.length; offset += 4) {
    const first = BASE64URL_ALPHABET.indexOf(value[offset]);
    const second = BASE64URL_ALPHABET.indexOf(value[offset + 1] ?? '');
    const third = value[offset + 2] === undefined ? 0 : BASE64URL_ALPHABET.indexOf(value[offset + 2]);
    const fourth = value[offset + 3] === undefined ? 0 : BASE64URL_ALPHABET.indexOf(value[offset + 3]);
    if (first < 0 || second < 0 || third < 0 || fourth < 0) return undefined;
    bytes.push((first << 2) | (second >>> 4));
    if (offset + 2 < value.length) bytes.push(((second & 0x0f) << 4) | (third >>> 2));
    if (offset + 3 < value.length) bytes.push(((third & 0x03) << 6) | fourth);
  }
  return new Uint8Array(bytes);
}

function decodeLegacyArchiveAssetPath(path: string): string | undefined {
  const prefix = 'assets/legacy~';
  if (!path.startsWith(prefix)) return undefined;
  const bytes = decodeBase64Url(path.slice(prefix.length));
  if (!bytes || bytes.length === 0 || bytes.length % 2 !== 0) return undefined;
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 2) result += String.fromCharCode((bytes[offset] << 8) | bytes[offset + 1]);
  return result;
}

function archivePathForAsset(id: string): string {
  if (!isArchiveSafeAssetId(id)) return legacyArchivePathForAsset(id);
  const path = `assets/${id}`;
  if (path.length > 1024) invalidArchive('Archive asset path exceeds the size limit.');
  return path;
}

function isArchivePathForAsset(id: string, path: string): boolean {
  if (!isValidAssetId(id)) return false;
  if (path === archivePathForAsset(id)) return true;
  if (decodeLegacyArchiveAssetPath(path) === id && path === legacyArchivePathForAsset(id)) return true;
  return legacyPercentArchivePathForAsset(id) === path;
}

function ensureArchiveEntryPath(path: string): void {
  if (path === MANIFEST_PATH || path === METADATA_PATH || path === DOCUMENT_PATH || path === ACTIVITY_PATH) return;
  if (
    !path.startsWith('assets/')
    || path.length > 1024
    || path.endsWith('/')
    || path.includes('\\')
    || path.includes('\0')
    || path.startsWith('/')
    || path.split('/').some((part) => part === '' || part === '.' || part === '..')
    || path.slice('assets/'.length).includes('/')
    || /[^\x20-\x7e]/.test(path)
  ) invalidArchive('Archive contains an unsafe or unsupported file path.');
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function readU16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function decodeZipName(bytes: Uint8Array, flags: number): string {
  if ((flags & ZIP_UTF8_FLAG) === 0 && bytes.some((byte) => byte > 0x7f)) invalidArchive('Archive paths must use the strict UTF-8 profile.');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    invalidArchive('Archive contains an invalid UTF-8 path.', error);
  }
}

function declaredLimitForPath(path: string): number {
  if (path === MANIFEST_PATH) return MAX_MANIFEST_BYTES;
  if (path === METADATA_PATH) return MAX_METADATA_BYTES;
  if (path === DOCUMENT_PATH) return MAX_DOCUMENT_BYTES;
  if (path === ACTIVITY_PATH) return MAX_DAILY_ACTIVITY_BYTES;
  return MAX_ASSET_BYTES;
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const first = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= first; offset -= 1) {
    if (readU32(view, offset) === ZIP_EOCD_SIGNATURE && offset + 22 + readU16(view, offset + 20) === bytes.length) return offset;
  }
  invalidArchive('Archive end-of-central-directory record is missing or malformed.');
}

/**
 * Admission is intentionally independent of fflate. It makes all ZIP sizes,
 * offsets, flags, and local records safe before fflate sees any input.
 */
function preflightZip(bytes: Uint8Array): ZipPreflight {
  if (bytes.length < 22) invalidArchive('Archive is too small to be a ZIP file.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(bytes);
  const disk = readU16(view, eocdOffset + 4);
  const centralDisk = readU16(view, eocdOffset + 6);
  const entriesOnDisk = readU16(view, eocdOffset + 8);
  const entryCount = readU16(view, eocdOffset + 10);
  const centralSize = readU32(view, eocdOffset + 12);
  const centralOffset = readU32(view, eocdOffset + 16);
  const commentLength = readU16(view, eocdOffset + 20);
  if (commentLength !== 0 || disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) invalidArchive('Archive uses unsupported ZIP features.');
  if (entryCount > MAX_ARCHIVE_ENTRIES) throw new PersistenceError('archive-too-large', 'Archive contains too many files.');
  if (entryCount === 0) invalidArchive('Archive contains no files.');
  if (centralSize === 0xffffffff || centralOffset === 0xffffffff) invalidArchive('ZIP64 archives are not supported.');
  const centralEndBig = BigInt(centralOffset) + BigInt(centralSize);
  if (centralEndBig !== BigInt(eocdOffset)) invalidArchive('Archive central-directory bounds are invalid.');
  const centralEnd = Number(centralEndBig);
  const entries: ZipEntry[] = [];
  const byName = new Map<string, ZipEntry>();
  let offset = centralOffset;
  let expanded = 0n;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + ZIP_FIXED_BYTES > centralEnd || readU32(view, offset) !== ZIP_CENTRAL_SIGNATURE) invalidArchive('Archive central-directory record is invalid.');
    const versionNeeded = readU16(view, offset + 6);
    const flags = readU16(view, offset + 8);
    const compression = readU16(view, offset + 10);
    const crc32 = readU32(view, offset + 16);
    const compressedSize = readU32(view, offset + 20);
    const uncompressedSize = readU32(view, offset + 24);
    const nameLength = readU16(view, offset + 28);
    const extraLength = readU16(view, offset + 30);
    const recordCommentLength = readU16(view, offset + 32);
    const localOffset = readU32(view, offset + 42);
    const recordEndBig = BigInt(offset) + BigInt(ZIP_FIXED_BYTES) + BigInt(nameLength) + BigInt(extraLength) + BigInt(recordCommentLength);
    if (recordEndBig > BigInt(centralEnd) || recordEndBig < BigInt(offset) || recordCommentLength !== 0 || extraLength !== 0) invalidArchive('Archive central-directory bounds or fields are invalid.');
    const recordEnd = Number(recordEndBig);
    if (versionNeeded > 20 || (flags & ~ZIP_ALLOWED_FLAGS) !== 0 || (flags & 0x0001) !== 0 || (flags & 0x0008) !== 0) invalidArchive('Archive uses encrypted, streaming, or unsupported ZIP flags.');
    if (compression !== ZIP_STORE && compression !== ZIP_DEFLATE) invalidArchive('Archive uses an unsupported compression method.');
    const rawName = bytes.slice(offset + ZIP_FIXED_BYTES, offset + ZIP_FIXED_BYTES + nameLength);
    const name = decodeZipName(rawName, flags);
    ensureArchiveEntryPath(name);
    if (byName.has(name)) invalidArchive('Archive contains duplicate file entries.');
    if (BigInt(compressedSize) > BigInt(MAX_ARCHIVE_BYTES) || BigInt(uncompressedSize) > BigInt(declaredLimitForPath(name))) invalidArchive('Archive entry exceeds its size limit.');
    if (compression === ZIP_STORE && compressedSize !== uncompressedSize) invalidArchive('Stored ZIP entries have inconsistent lengths.');
    expanded += BigInt(uncompressedSize);
    if (expanded > BigInt(MAX_ARCHIVE_EXPANSION_BYTES)) throw new PersistenceError('archive-too-large', 'Archive declared expansion exceeds the supported limit.');
    const entry: ZipEntry = { name, rawName, compression, flags, crc32, compressedSize, uncompressedSize, localOffset };
    entries.push(entry);
    byName.set(name, entry);
    offset = recordEnd;
  }
  if (offset !== centralEnd) invalidArchive('Archive central-directory bounds are invalid.');

  const physicalEntries = [...entries].sort((left, right) => left.localOffset - right.localOffset);
  let expectedLocalOffset = 0;
  for (const entry of physicalEntries) {
    const localOffset = entry.localOffset;
    if (localOffset !== expectedLocalOffset || BigInt(localOffset) + BigInt(ZIP_LOCAL_FIXED_BYTES) > BigInt(centralOffset) || readU32(view, localOffset) !== ZIP_LOCAL_SIGNATURE) invalidArchive('Archive local-file bounds are invalid.');
    const localVersionNeeded = readU16(view, localOffset + 4);
    const localFlags = readU16(view, localOffset + 6);
    const localCompression = readU16(view, localOffset + 8);
    const localCrc32 = readU32(view, localOffset + 14);
    const localCompressedSize = readU32(view, localOffset + 18);
    const localUncompressedSize = readU32(view, localOffset + 22);
    const localNameLength = readU16(view, localOffset + 26);
    const localExtraLength = readU16(view, localOffset + 28);
    const localNameEndBig = BigInt(localOffset) + BigInt(ZIP_LOCAL_FIXED_BYTES) + BigInt(localNameLength) + BigInt(localExtraLength);
    if (localVersionNeeded > 20 || localExtraLength !== 0 || localNameEndBig > BigInt(centralOffset) || localNameEndBig < BigInt(localOffset)) invalidArchive('Archive local-file fields are invalid.');
    const localNameEnd = Number(localNameEndBig);
    const localName = bytes.slice(localOffset + ZIP_LOCAL_FIXED_BYTES, localOffset + ZIP_LOCAL_FIXED_BYTES + localNameLength);
    if (!equalBytes(localName, entry.rawName) || localFlags !== entry.flags || localCompression !== entry.compression || localCrc32 !== entry.crc32 || localCompressedSize !== entry.compressedSize || localUncompressedSize !== entry.uncompressedSize) invalidArchive('Archive local and central records do not match.');
    if ((localFlags & ~ZIP_ALLOWED_FLAGS) !== 0 || (localFlags & 0x0008) !== 0) invalidArchive('Archive local record uses streaming flags.');
    const dataEndBig = BigInt(localNameEnd) + BigInt(entry.compressedSize);
    if (dataEndBig > BigInt(centralOffset) || dataEndBig < BigInt(localNameEnd)) invalidArchive('Archive compressed data bounds are invalid.');
    const dataEnd = Number(dataEndBig);
    expectedLocalOffset = dataEnd;
  }
  if (expectedLocalOffset !== centralOffset) invalidArchive('Archive contains gaps or trailing bytes before its central directory.');
  return { entries, byName };
}

function cancelled(): never {
  throw new PersistenceError('cancelled', 'Archive extraction was cancelled.');
}

function extractEntries(
  bytes: Uint8Array,
  preflight: ZipPreflight,
  allowlist: ReadonlySet<string>,
  signal?: AbortSignal,
  assetPaths: ReadonlySet<string> = new Set()
): Record<string, Uint8Array> {
  if (signal?.aborted) return cancelled();
  const files: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  const seen = new Set<string>();
  let aggregateOutput = 0;
  let aggregateAssetOutput = 0;
  const unzipper = new Unzip((file) => {
    if (signal?.aborted) cancelled();
    const entry = preflight.byName.get(file.name);
    if (!entry || seen.has(file.name)) invalidArchive('Archive local entries do not match the preflight directory.');
    seen.add(file.name);
    if (!allowlist.has(file.name)) return;
    const chunks: Uint8Array[] = [];
    let outputLength = 0;
    file.ondata = (error, data, final) => {
      if (error) {
        file.terminate();
        if (error instanceof PersistenceError) throw error;
        throw new PersistenceError('invalid-archive', `Archive entry ${file.name} could not be extracted.`, error);
      }
      if (signal?.aborted) {
        file.terminate();
        cancelled();
      }
      const chunk = data ?? new Uint8Array();
      const nextLength = outputLength + chunk.length;
      const isAsset = assetPaths.has(entry.name);
      if (isAsset) aggregateAssetOutput += chunk.length;
      if (nextLength > entry.uncompressedSize || nextLength > declaredLimitForPath(entry.name) || nextLength > MAX_ARCHIVE_EXPANSION_BYTES || aggregateOutput + chunk.length > MAX_ARCHIVE_EXPANSION_BYTES || aggregateAssetOutput > MAX_ASSET_TOTAL_BYTES) {
        file.terminate();
        throw new PersistenceError('archive-too-large', isAsset ? 'Archive assets exceed the aggregate size limit.' : `Archive entry ${file.name} expanded beyond its limit.`);
      }
      outputLength = nextLength;
      aggregateOutput += chunk.length;
      if (chunk.length > 0) chunks.push(chunk.slice());
      if (final) {
        if (outputLength !== entry.uncompressedSize) {
          file.terminate();
          throw new PersistenceError('invalid-archive', `Archive entry ${file.name} has an invalid expanded length.`);
        }
        const result = new Uint8Array(outputLength);
        let resultOffset = 0;
        for (const part of chunks) {
          result.set(part, resultOffset);
          resultOffset += part.length;
        }
        files[file.name] = result;
      }
    };
    try {
      file.start();
    } catch (error) {
      file.terminate();
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError('invalid-archive', `Archive entry ${file.name} could not be extracted.`, error);
    }
  });
  unzipper.register(UnzipInflate);
  unzipper.register(UnzipPassThrough);
  try {
    const chunkSize = 64 * 1024;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      if (signal?.aborted) return cancelled();
      const end = Math.min(bytes.length, offset + chunkSize);
      unzipper.push(bytes.subarray(offset, end), end === bytes.length);
    }
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    throw new PersistenceError('invalid-archive', 'Archive ZIP data is invalid.', error);
  }
  for (const path of allowlist) {
    if (!seen.has(path) || files[path] === undefined) invalidArchive('Archive is missing an allowlisted file.');
  }
  return files;
}

export async function exportArchive(bundle: Omit<ArchiveBundle, 'manifest'>, options: ArchiveExportOptions = {}): Promise<Uint8Array> {
  assertValidDocument(bundle.document);
  const validatedMetadata = validateMetadata(bundle.metadata);
  let metadata = validatedMetadata.metadata;
  const warnings = [...validatedMetadata.warnings];
  if (metadata.sourceImage !== undefined) {
    try {
      validateSourceImageDescriptor(metadata.sourceImage);
    } catch (error) {
      warnings.push(`Optional source image settings were omitted from export: ${error instanceof Error ? error.message : 'invalid chart bounds'}.`);
      metadata = withoutSourceImage(metadata);
    }
  }
  if (metadata.revision !== bundle.document.revision) throw new PersistenceError('invalid-metadata', 'Project metadata and document revisions must match.');
  const summary = deriveProjectSummary(bundle.document);
  // Archives carry stable document dimensions for compatibility, but the
  // thumbnail is a local cache and is deliberately never serialized.
  metadata = { ...metadata, width: summary.width, height: summary.height };
  const documentBytes = encodeDocument(bundle.document);
  if (documentBytes.length > MAX_DOCUMENT_BYTES) invalidArchive('Document snapshot exceeds the archive limit.');
  const assets: ProjectAsset[] = [];
  let totalAssetBytes = 0n;
  for (const input of bundle.assets) {
    const isOptionalSource = metadata.sourceImage?.assetId === input.id;
    try {
      validateAssetInput(input);
      if (assets.some((asset) => asset.id === input.id)) throw new PersistenceError('invalid-asset', `Asset ${input.id} is duplicated.`);
      const nextTotalAssetBytes = totalAssetBytes + BigInt(input.data.length);
      if (nextTotalAssetBytes > BigInt(MAX_ASSET_TOTAL_BYTES)) throw new PersistenceError('invalid-asset', 'Assets exceed the archive size limit.');
      const checksum = await sha256(input.data);
      if (checksum !== input.checksum) throw new PersistenceError('checksum-mismatch', `Asset ${input.id} checksum does not match its data.`);
      assets.push({ ...input, data: input.data.slice(), checksum });
      totalAssetBytes = nextTotalAssetBytes;
    } catch (error) {
      if (!isOptionalSource) throw error;
      warnings.push(`Optional source image asset ${input.id} was omitted from export: ${error instanceof Error ? error.message : 'invalid asset'}.`);
    }
  }
  if (metadata.sourceImage !== undefined) {
    const sourceAsset = assets.find((asset) => asset.id === metadata.sourceImage?.assetId);
    if (sourceAsset === undefined) {
      warnings.push(`Optional source image asset ${metadata.sourceImage.assetId} was omitted from export; the reference image is unavailable.`);
      metadata = withoutSourceImage(metadata);
    } else {
      try {
        const dimensions = inspectRasterAsset(sourceAsset);
        if (dimensions.mimeType !== metadata.sourceImage.mimeType || dimensions.width !== metadata.sourceImage.width || dimensions.height !== metadata.sourceImage.height || (metadata.sourceImage.orientation !== undefined && metadata.sourceImage.orientation !== (dimensions.orientation ?? 1))) throw new Error('Source image descriptor does not match its asset.');
      } catch (error) {
        warnings.push(`Optional source image asset ${sourceAsset.id} was omitted from export: ${error instanceof Error ? error.message : 'invalid raster data'}.`);
        const assetIndex = assets.indexOf(sourceAsset);
        assets.splice(assetIndex, 1);
        metadata = withoutSourceImage(metadata);
      }
    }
  }
  const metadataBytes = strToU8(JSON.stringify(metadata));
  if (metadataBytes.length > MAX_METADATA_BYTES) throw new PersistenceError('invalid-metadata', 'Project metadata exceeds the size limit.');
  let activity: ProgressActivity;
  try {
    activity = normalizeProgressActivity(bundle.activity);
  } catch (error) {
    throw new PersistenceError('invalid-activity', 'Project activity is malformed.', error);
  }
  const activityBytes = strToU8(JSON.stringify(activity));
  if (activityBytes.length > MAX_DAILY_ACTIVITY_BYTES) throw new PersistenceError('invalid-activity', 'Project activity exceeds the size limit.');
  const manifest: ArchiveManifest = {
    format: ARCHIVE_FORMAT,
    archiveVersion: PERSISTENCE_SCHEMA_VERSION,
    projectId: metadata.id,
    metadata: { path: METADATA_PATH, byteLength: metadataBytes.length, sha256: await sha256(metadataBytes) },
    document: { path: DOCUMENT_PATH, schemaVersion: DOCUMENT_SCHEMA_VERSION, byteLength: documentBytes.length, sha256: await sha256(documentBytes) },
    assets: await Promise.all(assets.map(async (asset) => ({
      id: asset.id,
      path: archivePathForAsset(asset.id),
      name: asset.name,
      mimeType: asset.mimeType,
      byteLength: asset.data.length,
      sha256: asset.checksum
    }))),
    ...(bundle.activity === undefined ? {} : {
      activity: { path: ACTIVITY_PATH, byteLength: activityBytes.length, sha256: await sha256(activityBytes) }
    })
  };
  const manifestBytes = strToU8(JSON.stringify(manifest));
  if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new PersistenceError('invalid-manifest', 'Archive manifest exceeds the size limit.');
  const files: Record<string, Uint8Array> = {
    [MANIFEST_PATH]: manifestBytes,
    [METADATA_PATH]: metadataBytes,
    [DOCUMENT_PATH]: documentBytes
  };
  if (bundle.activity !== undefined) files[ACTIVITY_PATH] = activityBytes;
  for (const asset of assets) files[archivePathForAsset(asset.id)] = asset.data;
  const archive = zipSync(files, { level: 6 });
  if (archive.length > MAX_ARCHIVE_BYTES) throw new PersistenceError('archive-too-large', 'Archive exceeds the maximum supported size.');
  for (const warning of warnings) options.onWarning?.(warning);
  return archive;
}

export async function parseArchive(input: Uint8Array | ArrayBuffer | Blob, options: Pick<ArchiveImportOptions, 'signal'> = {}): Promise<ArchiveBundle> {
  const bytes = await bytesOfArchive(input);
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new PersistenceError('archive-too-large', 'Archive exceeds the maximum supported size.');
  if (options.signal?.aborted) cancelled();
  const preflight = preflightZip(bytes);
  if (!preflight.byName.has(MANIFEST_PATH) || !preflight.byName.has(METADATA_PATH) || !preflight.byName.has(DOCUMENT_PATH)) invalidArchive('Archive is missing a required file.');

  // Read the manifest first. Unknown asset paths are never decompressed until
  // the manifest has made them part of the exact allowlist.
  const manifestFiles = extractEntries(bytes, preflight, new Set([MANIFEST_PATH]), options.signal);
  const manifest = migrateArchiveManifest(parseJson(manifestFiles[MANIFEST_PATH], 'Archive manifest', MAX_MANIFEST_BYTES));
  const knownPaths = new Set([
    MANIFEST_PATH,
    manifest.metadata.path,
    manifest.document.path,
    ...(manifest.activity === undefined ? [] : [manifest.activity.path]),
    ...manifest.assets.map((asset) => asset.path)
  ]);
  if (knownPaths.size !== preflight.entries.length || preflight.entries.some((entry) => !knownPaths.has(entry.name))) invalidArchive('Archive contains an unlisted or missing file.');
  const metadataEntry = preflight.byName.get(METADATA_PATH);
  const documentEntry = preflight.byName.get(DOCUMENT_PATH);
  if (!metadataEntry || !documentEntry || metadataEntry.uncompressedSize !== manifest.metadata.byteLength || documentEntry.uncompressedSize !== manifest.document.byteLength) throw new PersistenceError('invalid-archive', 'Archive file lengths do not match its manifest.');
  const activityEntry = manifest.activity === undefined ? undefined : preflight.byName.get(manifest.activity.path);
  if (manifest.activity !== undefined && (!activityEntry || activityEntry.uncompressedSize !== manifest.activity.byteLength || activityEntry.uncompressedSize > MAX_DAILY_ACTIVITY_BYTES)) throw new PersistenceError('invalid-archive', 'Archive activity is missing or has an invalid declared length.');
  for (const descriptor of manifest.assets) {
    const entry = preflight.byName.get(descriptor.path);
    if (!entry || entry.uncompressedSize !== descriptor.byteLength || entry.uncompressedSize > MAX_ASSET_BYTES) throw new PersistenceError('invalid-archive', `Asset ${descriptor.id} is missing or has an invalid declared length.`);
  }

  const assetPaths = new Set(manifest.assets.map((asset) => asset.path));
  const files = extractEntries(bytes, preflight, knownPaths, options.signal, assetPaths);
  const metadataBytes = files[METADATA_PATH];
  const documentBytes = files[DOCUMENT_PATH];
  if (metadataBytes.length !== manifest.metadata.byteLength || documentBytes.length !== manifest.document.byteLength) throw new PersistenceError('invalid-archive', 'Archive file lengths do not match its manifest.');
  if (await sha256(metadataBytes) !== manifest.metadata.sha256 || await sha256(documentBytes) !== manifest.document.sha256) throw new PersistenceError('checksum-mismatch', 'Archive metadata or document checksum is invalid.');
  const validatedMetadata = validateMetadata(parseJson(metadataBytes, 'Archive metadata', MAX_METADATA_BYTES));
  let metadata = validatedMetadata.metadata;
  const warnings = [...validatedMetadata.warnings];
  if (metadata.id !== manifest.projectId) invalidManifest('Archive project metadata does not match its manifest.');
  const document = decodeDocument(documentBytes);
  if (document.revision !== metadata.revision) invalidArchive('Archive metadata and document revisions do not match.');
  // Derived archive fields are never trusted. Rebuild dimensions from the
  // validated document and leave the thumbnail for repository persistence.
  metadata = { ...metadata, width: document.width, height: document.height };
  if (metadata.sourceImage !== undefined) {
    try {
      validateSourceImageDescriptor(metadata.sourceImage);
    } catch (error) {
      warnings.push(`Optional source image settings were ignored: ${error instanceof Error ? error.message : 'invalid chart bounds'}.`);
      metadata = withoutSourceImage(metadata);
    }
  }
  const assets: ProjectAsset[] = [];
  let totalAssetBytes = 0n;
  for (const descriptor of manifest.assets) {
    const data = files[descriptor.path];
    if (data === undefined || data.length !== descriptor.byteLength) throw new PersistenceError('invalid-archive', `Asset ${descriptor.id} is missing or has an invalid length.`);
    const nextTotalAssetBytes = totalAssetBytes + BigInt(data.length);
    if (nextTotalAssetBytes > BigInt(MAX_ASSET_TOTAL_BYTES)) throw new PersistenceError('archive-too-large', 'Assets exceed the archive size limit.');
    if (await sha256(data) !== descriptor.sha256) {
      if (metadata.sourceImage?.assetId === descriptor.id) {
        warnings.push(`Optional source image asset ${descriptor.id} failed its checksum and was ignored.`);
        continue;
      }
      throw new PersistenceError('checksum-mismatch', `Asset ${descriptor.id} checksum is invalid.`);
    }
    if (metadata.sourceImage?.assetId === descriptor.id) {
      try {
        const dimensions = inspectRasterAsset({ mimeType: descriptor.mimeType, data });
        if (dimensions.mimeType !== metadata.sourceImage.mimeType || dimensions.width !== metadata.sourceImage.width || dimensions.height !== metadata.sourceImage.height || (metadata.sourceImage.orientation !== undefined && metadata.sourceImage.orientation !== (dimensions.orientation ?? 1))) throw new Error('Source image descriptor does not match its asset.');
      } catch (error) {
        warnings.push(`Optional source image asset ${descriptor.id} was ignored: ${error instanceof Error ? error.message : 'invalid raster data'}.`);
        continue;
      }
    }
    totalAssetBytes = nextTotalAssetBytes;
    assets.push({ id: descriptor.id, name: descriptor.name, mimeType: descriptor.mimeType, data: data.slice(), checksum: descriptor.sha256 });
  }
  if (metadata.sourceImage !== undefined && !assets.some((asset) => asset.id === metadata.sourceImage?.assetId)) {
    warnings.push(`Optional source image asset ${metadata.sourceImage.assetId} is missing; the reference image is unavailable.`);
    metadata = withoutSourceImage(metadata);
  }
  let activity: ProgressActivity | undefined;
  if (manifest.activity !== undefined) {
    const activityBytes = files[manifest.activity.path];
    if (activityBytes === undefined || await sha256(activityBytes) !== manifest.activity.sha256) throw new PersistenceError('checksum-mismatch', 'Archive activity checksum is invalid.');
    try {
      activity = normalizeProgressActivity(parseJson(activityBytes, 'Archive activity', MAX_DAILY_ACTIVITY_BYTES));
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError('invalid-activity', 'Archive activity is malformed.', error);
    }
  }
  return { manifest, metadata, document, assets, ...(activity === undefined ? {} : { activity }), ...(warnings.length === 0 ? {} : { warnings }) };
}

export async function importArchive(input: Uint8Array | ArrayBuffer | Blob, options: ArchiveImportOptions = {}): Promise<ArchiveBundle> {
  if (options.collision !== undefined && options.collision !== 'reject' && options.collision !== 'replace') throw new PersistenceError('invalid-archive', 'Archive collision behavior is invalid.');
  const bundle = await parseArchive(input, options);
  if (options.targetProjectId !== undefined) {
    if (!isProjectId(options.targetProjectId)) throw new PersistenceError('invalid-metadata', 'Target project ID is invalid.');
    bundle.metadata = { ...bundle.metadata, id: options.targetProjectId };
    bundle.manifest = { ...bundle.manifest, projectId: options.targetProjectId };
  }
  return bundle;
}

export const exportProjectArchive = exportArchive;
export const importProjectArchive = importArchive;
export const decodeArchive = parseArchive;
