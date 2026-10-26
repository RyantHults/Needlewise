import { describe, expect, it } from 'vitest';
import { readImageHeader } from './header';

function segment(marker: number, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(4 + payload.length);
  bytes.set([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff], 0);
  bytes.set(payload, 4);
  return bytes;
}

function exif(orientation: number, byteOrder = [73, 73]): Uint8Array {
  const payload = new Uint8Array(32);
  payload.set([69, 120, 105, 102, 0, 0, ...byteOrder, 42, 0, 8, 0, 0, 0], 0);
  const view = new DataView(payload.buffer);
  view.setUint16(14, 1, true);
  view.setUint16(16, 0x0112, true);
  view.setUint16(18, 3, true);
  view.setUint32(20, 1, true);
  view.setUint16(24, orientation, true);
  return segment(0xe1, payload);
}

function startOfFrame(width: number, height: number): Uint8Array {
  return segment(0xc0, new Uint8Array([8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]));
}

function jpeg(...segments: Uint8Array[]): Uint8Array {
  const parts = [new Uint8Array([0xff, 0xd8]), ...segments, new Uint8Array([0xff, 0xda, 0, 2])];
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

describe('readImageHeader', () => {
  it('orients JPEG dimensions from an EXIF tag before or after the frame header', () => {
    expect(readImageHeader(jpeg(exif(6), startOfFrame(4, 3)))).toEqual({ mimeType: 'image/jpeg', width: 3, height: 4, orientation: 6 });
    expect(readImageHeader(jpeg(startOfFrame(4, 3), exif(8)))).toEqual({ mimeType: 'image/jpeg', width: 3, height: 4, orientation: 8 });
    expect(readImageHeader(jpeg(exif(3), startOfFrame(4, 3)))).toEqual({ mimeType: 'image/jpeg', width: 4, height: 3, orientation: 3 });
  });

  it('ignores malformed EXIF and keeps the encoded JPEG dimensions', () => {
    expect(readImageHeader(jpeg(exif(6, [0, 0]), startOfFrame(4, 3)))).toEqual({ mimeType: 'image/jpeg', width: 4, height: 3 });
    expect(readImageHeader(jpeg(exif(9), startOfFrame(4, 3)))).toEqual({ mimeType: 'image/jpeg', width: 4, height: 3 });
  });

  it('reads a JPEG frame header from bytes that end before the start of scan', () => {
    const whole = jpeg(exif(6), startOfFrame(4, 3), segment(0xc4, new Uint8Array(40)));
    expect(readImageHeader(whole.subarray(0, whole.length - 20))).toEqual({ mimeType: 'image/jpeg', width: 3, height: 4, orientation: 6 });
    expect(readImageHeader(whole.subarray(0, 40))).toBeUndefined();
  });
});
