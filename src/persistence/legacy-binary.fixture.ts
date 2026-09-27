import type { PatternDocument } from '../domain';

/**
 * Test-only encoder for the pre-layers single-surface binary formats (v1 and
 * v2). Production code only decodes these; it always writes v3.
 */
export function encodeLegacyDocument(document: PatternDocument, version: 1 | 2 = 2): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: number[] = [];
  const u8 = (value: number): void => {
    chunks.push(value & 0xff);
  };
  const u16 = (value: number): void => {
    u8(value);
    u8(value >>> 8);
  };
  const u32 = (value: number): void => {
    u16(value & 0xffff);
    u16(value >>> 16);
  };
  const f64 = (value: number): void => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    chunks.push(...bytes);
  };
  const str = (value: string): void => {
    const bytes = encoder.encode(value);
    u32(bytes.length);
    chunks.push(...bytes);
  };

  chunks.push(0x4e, 0x57, 0x44, 0x4f, 0x43, 0x31, 0x01, 0x00);
  u16(version);
  u8(1);
  u8(0);
  u32(document.width);
  u32(document.height);
  u32(document.revision);
  u32(document.nextBackstitchId === 0x100000000 ? 0 : document.nextBackstitchId);
  u32(document.nextPaletteId);
  u32(document.palette.length);
  u32(document.backstitches.ids.length);
  str(document.catalog.catalogId);
  str(document.catalog.brandLabel);
  u32(document.catalog.colorCount);
  for (const entry of document.palette) {
    u16(entry.id);
    u8(entry.active ? 1 : 0);
    str(entry.name);
    str(entry.color);
    str(entry.symbol);
    str(entry.material.kind);
    str(entry.material.label);
    str(entry.material.unit);
    u8(entry.material.amount === undefined ? 0 : 1);
    if (entry.material.amount !== undefined) f64(entry.material.amount);
    u8(entry.catalog === undefined ? 0 : 1);
    if (entry.catalog !== undefined) {
      for (const value of [entry.catalog.catalogId, entry.catalog.sourceId, entry.catalog.code, entry.catalog.name, entry.catalog.hex]) str(value);
      chunks.push(...entry.catalog.rgb);
    }
  }
  str(document.settings.symbolSet);
  str(document.settings.materialUnit);
  if (version >= 2) str(document.settings.backgroundColor);
  for (const kind of document.kind) u8(kind);
  for (const color of document.colors) u16(color);
  for (const completed of document.completed) u8(completed);
  const store = document.backstitches;
  for (let index = 0; index < store.ids.length; index += 1) {
    u32(store.ids[index]);
    u32(store.x1[index]);
    u32(store.y1[index]);
    u32(store.x2[index]);
    u32(store.y2[index]);
    u16(store.colors[index]);
    u8(store.completed[index]);
  }
  return new Uint8Array(chunks);
}
