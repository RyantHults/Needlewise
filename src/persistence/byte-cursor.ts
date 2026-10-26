import { PersistenceError } from './errors';
import { MAX_DOCUMENT_BYTES, MAX_METADATA_STRING_BYTES } from './limits';

function fail(message: string): never {
  throw new PersistenceError('invalid-document', message);
}

/** A little-endian read cursor over a snapshot. Call `require` before a fixed-size read; every failure is an `invalid-document` error. */
export class ByteReader {
  offset: number;
  private readonly view: DataView;

  constructor(readonly bytes: Uint8Array, offset = 0) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = offset;
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  /** Fail with `message` unless `count` more bytes remain. */
  require(count: number, message: string): void {
    if (this.offset + count > this.bytes.length) fail(message);
  }

  u8(): number {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  u16(): number {
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u32(): number {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  i32(): number {
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  f64(): number {
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }

  /** A copy of the next `length` bytes. */
  take(length: number, label: string): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_DOCUMENT_BYTES) fail(`${label} has an invalid length.`);
    if (BigInt(this.offset) + BigInt(length) > BigInt(this.bytes.length)) fail(`Document ended while reading ${label}.`);
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  /** A uint32 length prefix and that many UTF-8 bytes. */
  string(label: string): string {
    this.require(4, `Document ended while reading ${label} length.`);
    const length = this.u32();
    if (length > MAX_METADATA_STRING_BYTES) fail(`${label} has an invalid length.`);
    const bytes = this.take(length, label);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      throw new PersistenceError('invalid-document', 'Document text is not valid UTF-8.', error);
    }
  }
}
