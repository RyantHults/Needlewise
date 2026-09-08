import { PersistenceError } from './errors';

function bytesOf(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 is provided by the browser crypto adapter; no network or server is involved. */
export async function sha256(value: Uint8Array | ArrayBuffer): Promise<string> {
  const bytes = bytesOf(value);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new PersistenceError('storage-failure', 'This environment does not provide SHA-256 support.');
  }
  try {
    const digest = await subtle.digest('SHA-256', bytes as BufferSource);
    return hex(new Uint8Array(digest));
  } catch (error) {
    throw new PersistenceError('storage-failure', 'Unable to calculate a SHA-256 checksum.', error);
  }
}
