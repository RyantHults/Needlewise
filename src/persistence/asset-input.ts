import { PersistenceError } from './errors';
import { isValidAssetId, MAX_ASSET_BYTES } from './limits';
import type { ProjectAssetInput } from './types';

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/** The id, name, and MIME type bounds every stored or incoming asset must meet. */
export function isValidAssetMetadata(asset: { id: unknown; name: unknown; mimeType: unknown }): boolean {
  return isValidAssetId(asset.id)
    && typeof asset.name === 'string'
    && asset.name.length <= 512
    && typeof asset.mimeType === 'string'
    && asset.mimeType.length <= 256;
}

/** Checks an incoming asset's metadata and returns an owned copy of its bytes, within the asset size limit. */
export async function readAssetInputBytes(input: ProjectAssetInput): Promise<Uint8Array> {
  if (!isValidAssetMetadata(input)) throw new PersistenceError('invalid-asset', 'Asset metadata is malformed.');
  let bytes: Uint8Array;
  if (typeof Blob !== 'undefined' && input.data instanceof Blob) {
    if (input.data.size > MAX_ASSET_BYTES) throw new PersistenceError('invalid-asset', `Asset ${input.id} exceeds the size limit.`);
    bytes = new Uint8Array(await input.data.arrayBuffer());
  } else if (input.data instanceof Uint8Array) {
    bytes = input.data.slice();
  } else if (input.data instanceof ArrayBuffer) {
    bytes = new Uint8Array(input.data).slice();
  } else {
    throw new PersistenceError('invalid-asset', `Asset ${input.id} has unsupported data.`);
  }
  if (bytes.length > MAX_ASSET_BYTES) throw new PersistenceError('invalid-asset', `Asset ${input.id} exceeds the size limit.`);
  return bytes;
}
