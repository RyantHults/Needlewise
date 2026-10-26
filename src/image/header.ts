export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';
export type ImageOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface ImageHeader {
  readonly mimeType: ImageMimeType;
  /** Displayed width: JPEG dimensions are swapped when the EXIF orientation rotates the image. */
  readonly width: number;
  readonly height: number;
  /** Present when a well-formed JPEG EXIF orientation tag was found. */
  readonly orientation?: ImageOrientation;
}

interface Dimensions {
  width: number;
  height: number;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function ascii(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset + value.length > bytes.length) return false;
  return [...value].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
}

function pngDimensions(bytes: Uint8Array): Dimensions | undefined {
  if (bytes.length < 24 || !ascii(bytes, 0, '\x89PNG\r\n\x1a\n') || !ascii(bytes, 12, 'IHDR')) return undefined;
  return { width: view(bytes).getUint32(16, false), height: view(bytes).getUint32(20, false) };
}

function isOrientation(value: number): value is ImageOrientation {
  return Number.isSafeInteger(value) && value >= 1 && value <= 8;
}

/** Orientation from an APP1 payload; malformed EXIF yields none, as browsers ignore it too. */
function exifOrientation(bytes: Uint8Array, payloadStart: number, payloadEnd: number): ImageOrientation | undefined {
  if (payloadStart + 6 > payloadEnd || !ascii(bytes, payloadStart, 'Exif\0\0')) return undefined;
  const tiffStart = payloadStart + 6;
  if (tiffStart + 8 > payloadEnd) return undefined;
  const littleEndian = ascii(bytes, tiffStart, 'II');
  if (!littleEndian && !ascii(bytes, tiffStart, 'MM')) return undefined;
  const data = view(bytes);
  const read16 = (offset: number): number => data.getUint16(offset, littleEndian);
  const read32 = (offset: number): number => data.getUint32(offset, littleEndian);
  if (read16(tiffStart + 2) !== 42) return undefined;
  const ifdStart = tiffStart + read32(tiffStart + 4);
  if (ifdStart + 2 > payloadEnd) return undefined;
  const entryCount = read16(ifdStart);
  const entriesStart = ifdStart + 2;
  if (entriesStart + entryCount * 12 > payloadEnd) return undefined;
  for (let index = 0; index < entryCount; index += 1) {
    const entry = entriesStart + index * 12;
    if (read16(entry) !== 0x0112) continue;
    if (read16(entry + 2) !== 3 || read32(entry + 4) !== 1) return undefined;
    const orientation = read16(entry + 8);
    return isOrientation(orientation) ? orientation : undefined;
  }
  return undefined;
}

function isStartOfFrame(marker: number): boolean {
  return (marker >= 0xc0 && marker <= 0xc3)
    || (marker >= 0xc5 && marker <= 0xc7)
    || (marker >= 0xc9 && marker <= 0xcb)
    || (marker >= 0xcd && marker <= 0xcf);
}

/**
 * Scans markers up to the start of scan, over whatever bytes are passed, so
 * an APP1 that follows the frame header still orients the dimensions. Bytes
 * that end before the start of scan keep the frame header already read.
 */
function jpegHeader(bytes: Uint8Array): Omit<ImageHeader, 'mimeType'> | undefined {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let dimensions: Dimensions | undefined;
  let orientation: ImageOrientation | undefined;
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = view(bytes).getUint16(offset, false);
    if (length < 2 || offset + length > bytes.length) break;
    if (marker === 0xe1 && orientation === undefined) orientation = exifOrientation(bytes, offset + 2, offset + length);
    if (isStartOfFrame(marker) && length >= 7 && dimensions === undefined) {
      dimensions = { height: view(bytes).getUint16(offset + 3, false), width: view(bytes).getUint16(offset + 5, false) };
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

function webpDimensions(bytes: Uint8Array): Dimensions | undefined {
  if (bytes.length < 16 || !ascii(bytes, 0, 'RIFF') || !ascii(bytes, 8, 'WEBP')) return undefined;
  const data = view(bytes);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunk = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const length = data.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    // Recognized chunks only need the bytes read here: a simple-format VP8/VP8L
    // chunk holds the whole bitstream and routinely extends past a header probe.
    if (chunk === 'VP8X') {
      if (length < 10 || dataOffset + 10 > bytes.length) return undefined;
      return { width: 1 + little24(bytes, dataOffset + 4), height: 1 + little24(bytes, dataOffset + 7) };
    }
    if (chunk === 'VP8L') {
      if (length < 5 || dataOffset + 5 > bytes.length || bytes[dataOffset] !== 0x2f) return undefined;
      return {
        width: 1 + ((bytes[dataOffset + 1] | (bytes[dataOffset + 2] << 8)) & 0x3fff),
        height: 1 + (((bytes[dataOffset + 2] >> 6) | (bytes[dataOffset + 3] << 2) | (bytes[dataOffset + 4] << 10)) & 0x3fff)
      };
    }
    if (chunk === 'VP8 ') {
      if (length < 10 || dataOffset + 10 > bytes.length || bytes[dataOffset + 3] !== 0x9d || bytes[dataOffset + 4] !== 0x01 || bytes[dataOffset + 5] !== 0x2a) return undefined;
      return { width: data.getUint16(dataOffset + 6, true) & 0x3fff, height: data.getUint16(dataOffset + 8, true) & 0x3fff };
    }
    if (dataOffset + length > bytes.length) return undefined;
    offset = dataOffset + length + (length & 1);
  }
  return undefined;
}

/** Format and displayed dimensions sniffed from the bytes alone; undefined when no supported header is readable. */
export function readImageHeader(bytes: Uint8Array): ImageHeader | undefined {
  const png = pngDimensions(bytes);
  if (png) return { mimeType: 'image/png', ...png };
  const jpeg = jpegHeader(bytes);
  if (jpeg) return { mimeType: 'image/jpeg', ...jpeg };
  const webp = webpDimensions(bytes);
  if (webp) return { mimeType: 'image/webp', ...webp };
  return undefined;
}
