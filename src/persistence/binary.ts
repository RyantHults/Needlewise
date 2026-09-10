import {
  assertValidDocument,
  migratePatternDocument,
  type LegacyPatternDocument,
  PALETTE_ID_RESERVED,
  type PaletteCatalogReference,
  type PaletteEntry,
  type PaletteMaterial,
  type PatternSettings,
  type PatternDocument
} from '../domain';
import { PersistenceError } from './errors';
import {
  isBoundedMetadataString,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_CELLS,
  MAX_METADATA_STRING_BYTES,
  MAX_PALETTE_ENTRIES
} from './limits';

const MAGIC = new Uint8Array([0x53, 0x54, 0x59, 0x44, 0x4f, 0x43, 0x01, 0x00]);
const BINARY_SCHEMA_VERSION = 4;
const PRIOR_BINARY_SCHEMA_VERSION = 3;
const PENULTIMATE_BINARY_SCHEMA_VERSION = 2;
const LEGACY_BINARY_SCHEMA_VERSION = 1;
const LITTLE_ENDIAN_MARKER = 1;
const HEADER_BYTES = 40;

function fail(message: string): never {
  throw new PersistenceError('invalid-document', message);
}

function asBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new PersistenceError('invalid-document', 'Document text is not valid UTF-8.', error);
  }
}

function stringBytes(value: string, label: string): Uint8Array {
  const bytes = utf8(value);
  if (!isBoundedMetadataString(value) || bytes.length > MAX_METADATA_STRING_BYTES) fail(`${label} exceeds the text size limit.`);
  return bytes;
}

function checkedLength(value: number, label: string, max = MAX_DOCUMENT_BYTES): number {
  if (!Number.isInteger(value) || value < 0 || value > max) fail(`${label} has an invalid length.`);
  return value;
}

function checkedDocumentDimensions(width: number, height: number): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) fail('Document dimensions are invalid.');
  const cellCount = BigInt(width) * BigInt(height);
  if (cellCount > BigInt(MAX_DOCUMENT_CELLS) || cellCount > BigInt(Number.MAX_SAFE_INTEGER)) fail('Document dimensions are too large.');
  return Number(cellCount);
}

function sameMagic(bytes: Uint8Array): boolean {
  return MAGIC.every((byte, index) => bytes[index] === byte);
}

function byteLengthFor(document: PatternDocument): number {
  let length = BigInt(HEADER_BYTES) + BigInt(document.kind.length) + BigInt(document.colors.length) * 2n + BigInt(document.completed.length);
  for (const entry of document.palette) {
    const name = stringBytes(entry.name, 'Palette name');
    const color = stringBytes(entry.color, 'Palette color');
    const symbol = stringBytes(entry.symbol, 'Palette symbol');
    const materialKind = stringBytes(entry.material.kind, 'Palette material kind');
    const materialLabel = stringBytes(entry.material.label, 'Palette material label');
    const materialUnit = stringBytes(entry.material.unit, 'Palette material unit');
    length += 2n + 1n + 4n + BigInt(name.length) + 4n + BigInt(color.length) + 4n + BigInt(symbol.length);
    length += 4n + BigInt(materialKind.length) + 4n + BigInt(materialLabel.length) + 4n + BigInt(materialUnit.length) + 1n + (entry.material.amount === undefined ? 0n : 8n);
    if (entry.catalog === undefined) {
      length += 1n;
    } else {
      length += 1n;
      for (const value of [entry.catalog.catalogId, entry.catalog.sourceId, entry.catalog.code, entry.catalog.name, entry.catalog.hex]) length += 4n + BigInt(stringBytes(value, 'Palette catalog field').length);
      length += 3n;
    }
  }
  length += 4n + BigInt(stringBytes(document.settings.symbolSet, 'Document symbol set').length);
  length += 4n + BigInt(stringBytes(document.settings.materialUnit, 'Document material unit').length);
  length += BigInt(document.backstitches.ids.length) * 23n;
  if (length > BigInt(MAX_DOCUMENT_BYTES) || length > BigInt(Number.MAX_SAFE_INTEGER)) fail('Document snapshot exceeds the size limit.');
  return Number(length);
}

function writeString(view: DataView, bytes: Uint8Array, offset: number, value: string, label: string): number {
  const encoded = stringBytes(value, label);
  view.setUint32(offset, encoded.length, true);
  offset += 4;
  bytes.set(encoded, offset);
  return offset + encoded.length;
}

export function encodeDocument(document: PatternDocument): Uint8Array {
  checkedDocumentDimensions(document.width, document.height);
  assertValidDocument(document);
  if (document.revision > 0xffffffff || document.nextBackstitchId > 0x100000000) fail('Document counters exceed the binary format.');
  const length = byteLengthFor(document);
  if (length > MAX_DOCUMENT_BYTES) fail('Document snapshot exceeds the size limit.');
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  bytes.set(MAGIC, 0);
  view.setUint16(8, BINARY_SCHEMA_VERSION, true);
  view.setUint8(10, LITTLE_ENDIAN_MARKER);
  view.setUint8(11, 0);
  view.setUint32(12, document.width, true);
  view.setUint32(16, document.height, true);
  view.setUint32(20, document.revision, true);
  view.setUint32(24, document.nextBackstitchId === 0x100000000 ? 0 : document.nextBackstitchId, true);
  view.setUint32(28, document.nextPaletteId, true);
  view.setUint32(32, document.palette.length, true);
  view.setUint32(36, document.backstitches.ids.length, true);
  let offset = HEADER_BYTES;
  for (const entry of document.palette) {
    view.setUint16(offset, entry.id, true);
    offset += 2;
    view.setUint8(offset, entry.active ? 1 : 0);
    offset += 1;
    offset = writeString(view, bytes, offset, entry.name, 'Palette name');
    offset = writeString(view, bytes, offset, entry.color, 'Palette color');
    offset = writeString(view, bytes, offset, entry.symbol, 'Palette symbol');
    offset = writeString(view, bytes, offset, entry.material.kind, 'Palette material kind');
    offset = writeString(view, bytes, offset, entry.material.label, 'Palette material label');
    offset = writeString(view, bytes, offset, entry.material.unit, 'Palette material unit');
    view.setUint8(offset, entry.material.amount === undefined ? 0 : 1);
    offset += 1;
    if (entry.material.amount !== undefined) {
      view.setFloat64(offset, entry.material.amount, true);
      offset += 8;
    }
    if (entry.catalog === undefined) {
      view.setUint8(offset, 0);
      offset += 1;
    } else {
      view.setUint8(offset, 1);
      offset += 1;
      offset = writeString(view, bytes, offset, entry.catalog.catalogId, 'Palette catalog ID');
      offset = writeString(view, bytes, offset, entry.catalog.sourceId, 'Palette catalog source ID');
      offset = writeString(view, bytes, offset, entry.catalog.code, 'Palette catalog code');
      offset = writeString(view, bytes, offset, entry.catalog.name, 'Palette catalog name');
      offset = writeString(view, bytes, offset, entry.catalog.hex, 'Palette catalog HEX');
      bytes[offset] = entry.catalog.rgb[0];
      bytes[offset + 1] = entry.catalog.rgb[1];
      bytes[offset + 2] = entry.catalog.rgb[2];
      offset += 3;
    }
  }
  offset = writeString(view, bytes, offset, document.settings.symbolSet, 'Document symbol set');
  offset = writeString(view, bytes, offset, document.settings.materialUnit, 'Document material unit');
  bytes.set(document.kind, offset);
  offset += document.kind.length;
  for (const color of document.colors) {
    view.setUint16(offset, color, true);
    offset += 2;
  }
  bytes.set(document.completed, offset);
  offset += document.completed.length;
  for (let index = 0; index < document.backstitches.ids.length; index += 1) {
    view.setUint32(offset, document.backstitches.ids[index], true);
    offset += 4;
    view.setUint32(offset, document.backstitches.x1[index], true);
    offset += 4;
    view.setUint32(offset, document.backstitches.y1[index], true);
    offset += 4;
    view.setUint32(offset, document.backstitches.x2[index], true);
    offset += 4;
    view.setUint32(offset, document.backstitches.y2[index], true);
    offset += 4;
    view.setUint16(offset, document.backstitches.colors[index], true);
    offset += 2;
    view.setUint8(offset, document.backstitches.completed[index]);
    offset += 1;
  }
  return bytes;
}

function take(bytes: Uint8Array, offset: number, length: number, label: string): Uint8Array {
  checkedLength(length, label);
  if (offset < 0 || BigInt(offset) + BigInt(length) > BigInt(bytes.length)) fail(`Document ended while reading ${label}.`);
  return bytes.slice(offset, offset + length);
}

function readString(bytes: Uint8Array, view: DataView, offset: number, label: string): { value: string; offset: number } {
  if (offset + 4 > bytes.length) fail(`Document ended while reading ${label} length.`);
  const length = view.getUint32(offset, true);
  offset += 4;
  checkedLength(length, label, MAX_METADATA_STRING_BYTES);
  const value = decodeUtf8(take(bytes, offset, length, label));
  return { value, offset: offset + length };
}

export function decodeDocument(input: Uint8Array | ArrayBuffer): PatternDocument {
  const bytes = asBytes(input);
  if (bytes.length > MAX_DOCUMENT_BYTES) fail('Document snapshot exceeds the size limit.');
  if (bytes.length < HEADER_BYTES || !sameMagic(bytes)) fail('Document binary magic is invalid.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const binaryVersion = view.getUint16(8, true);
  if (binaryVersion !== BINARY_SCHEMA_VERSION && binaryVersion !== PRIOR_BINARY_SCHEMA_VERSION && binaryVersion !== PENULTIMATE_BINARY_SCHEMA_VERSION && binaryVersion !== LEGACY_BINARY_SCHEMA_VERSION) throw new PersistenceError('unsupported-version', 'Document binary schema is unsupported.');
  if (view.getUint8(10) !== LITTLE_ENDIAN_MARKER) fail('Document byte order is unsupported.');
  if (view.getUint8(11) !== 0) fail('Document header flags are invalid.');
  const width = view.getUint32(12, true);
  const height = view.getUint32(16, true);
  const cellCount = checkedDocumentDimensions(width, height);
  const revision = view.getUint32(20, true);
  const encodedNextBackstitchId = view.getUint32(24, true);
  const nextBackstitchId = encodedNextBackstitchId === 0 ? 0x100000000 : encodedNextBackstitchId;
  const nextPaletteId = view.getUint32(28, true);
  const paletteCount = view.getUint32(32, true);
  const backstitchCount = view.getUint32(36, true);
  if (paletteCount > MAX_PALETTE_ENTRIES) fail('Palette count exceeds the size limit.');
  if (backstitchCount > 0x1000000) fail('Backstitch count exceeds the size limit.');

  // Validate all count-derived minimum sizes before allocating any typed
  // arrays. In particular, a forged backstitch count must not reach the
  // constructors below merely because the count fits in a uint32.
  const minimumPayload = BigInt(paletteCount) * 11n
    + BigInt(cellCount) * 10n
    + BigInt(backstitchCount) * 23n
    + (binaryVersion >= PENULTIMATE_BINARY_SCHEMA_VERSION ? 8n : 0n);
  if (minimumPayload > BigInt(bytes.length - HEADER_BYTES)) fail('Document counts exceed the remaining payload.');

  let offset = HEADER_BYTES;
  const legacyPalette: LegacyPatternDocument['palette'] = [];
  const palette: PaletteEntry[] = [];
  for (let index = 0; index < paletteCount; index += 1) {
    if (offset + 7 > bytes.length) fail('Document ended while reading the palette.');
    const id = view.getUint16(offset, true);
    offset += 2;
    if (id === PALETTE_ID_RESERVED) fail('Palette uses a reserved ID.');
    const activeValue = view.getUint8(offset);
    offset += 1;
    if (activeValue > 1) fail('Palette active flag is invalid.');
    const nameResult = readString(bytes, view, offset, 'Palette name');
    offset = nameResult.offset;
    const colorResult = readString(bytes, view, offset, 'Palette color');
    offset = colorResult.offset;
    if (binaryVersion === LEGACY_BINARY_SCHEMA_VERSION) {
      legacyPalette.push({ id, name: nameResult.value, color: colorResult.value, active: activeValue === 1 });
      continue;
    }
    const symbolResult = readString(bytes, view, offset, 'Palette symbol');
    offset = symbolResult.offset;
    const materialKindResult = readString(bytes, view, offset, 'Palette material kind');
    offset = materialKindResult.offset;
    const materialLabelResult = readString(bytes, view, offset, 'Palette material label');
    offset = materialLabelResult.offset;
    const materialUnitResult = readString(bytes, view, offset, 'Palette material unit');
    offset = materialUnitResult.offset;
    if (offset >= bytes.length) fail('Document ended while reading palette material amount flag.');
    const hasAmount = view.getUint8(offset);
    offset += 1;
    if (hasAmount > 1) fail('Palette material amount flag is invalid.');
    let amount: number | undefined;
    if (hasAmount === 1) {
      if (offset + 8 > bytes.length) fail('Document ended while reading palette material amount.');
      amount = view.getFloat64(offset, true);
      offset += 8;
    }
    if (offset >= bytes.length) fail('Document ended while reading palette catalog flag.');
    const hasCatalog = view.getUint8(offset);
    offset += 1;
    if (hasCatalog > 1) fail('Palette catalog flag is invalid.');
    let catalog: PaletteCatalogReference | undefined;
    if (hasCatalog === 1) {
      const catalogId = readString(bytes, view, offset, 'Palette catalog ID');
      offset = catalogId.offset;
      const sourceId = readString(bytes, view, offset, 'Palette catalog source ID');
      offset = sourceId.offset;
      const code = readString(bytes, view, offset, 'Palette catalog code');
      offset = code.offset;
      const catalogName = readString(bytes, view, offset, 'Palette catalog name');
      offset = catalogName.offset;
      const hex = readString(bytes, view, offset, 'Palette catalog HEX');
      offset = hex.offset;
      if (offset + 3 > bytes.length) fail('Document ended while reading palette catalog RGB.');
      catalog = { catalogId: catalogId.value, sourceId: sourceId.value, code: code.value, name: catalogName.value, hex: hex.value, rgb: [bytes[offset], bytes[offset + 1], bytes[offset + 2]] };
      offset += 3;
    }
    palette.push({
      id,
      name: nameResult.value,
      color: colorResult.value,
      active: activeValue === 1,
      symbol: symbolResult.value,
      material: { kind: materialKindResult.value as PaletteMaterial['kind'], label: materialLabelResult.value, unit: materialUnitResult.value as PaletteMaterial['unit'], ...(amount === undefined ? {} : { amount }) },
      ...(catalog === undefined ? {} : { catalog })
    });
  }
  let settings: PatternSettings | undefined;
  if (binaryVersion >= PENULTIMATE_BINARY_SCHEMA_VERSION) {
    const symbolSet = readString(bytes, view, offset, 'Document symbol set');
    offset = symbolSet.offset;
    const materialUnit = readString(bytes, view, offset, 'Document material unit');
    offset = materialUnit.offset;
    settings = { symbolSet: symbolSet.value, materialUnit: materialUnit.value as PatternSettings['materialUnit'] };
  }
  const kindBytes = take(bytes, offset, cellCount, 'cell kinds');
  offset += cellCount;
  const colorsByteLength = cellCount * 4 * 2;
  const colorsBytes = take(bytes, offset, colorsByteLength, 'cell colors');
  offset += colorsByteLength;
  const completedBytes = take(bytes, offset, cellCount, 'cell completion');
  offset += cellCount;
  const expectedBackstitchBytesBig = BigInt(backstitchCount) * 23n;
  if (expectedBackstitchBytesBig > BigInt(bytes.length - offset)) fail('Backstitch payload exceeds the document size limit.');
  const expectedBackstitchBytes = Number(expectedBackstitchBytesBig);
  if (offset + expectedBackstitchBytes !== bytes.length) fail('Document contains an invalid trailing payload.');

  const ids = new Uint32Array(backstitchCount);
  const x1 = new Uint32Array(backstitchCount);
  const y1 = new Uint32Array(backstitchCount);
  const x2 = new Uint32Array(backstitchCount);
  const y2 = new Uint32Array(backstitchCount);
  const colors = new Uint16Array(backstitchCount);
  const completed = new Uint8Array(backstitchCount);
  const backstitchView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < backstitchCount; index += 1) {
    ids[index] = backstitchView.getUint32(offset, true);
    offset += 4;
    x1[index] = backstitchView.getUint32(offset, true);
    offset += 4;
    y1[index] = backstitchView.getUint32(offset, true);
    offset += 4;
    x2[index] = backstitchView.getUint32(offset, true);
    offset += 4;
    y2[index] = backstitchView.getUint32(offset, true);
    offset += 4;
    colors[index] = backstitchView.getUint16(offset, true);
    offset += 2;
    completed[index] = backstitchView.getUint8(offset);
    offset += 1;
  }
  const decodedColors = new Uint16Array(cellCount * 4);
  const colorView = new DataView(colorsBytes.buffer, colorsBytes.byteOffset, colorsBytes.byteLength);
  for (let index = 0; index < decodedColors.length; index += 1) decodedColors[index] = colorView.getUint16(index * 2, true);
  const rawDocument = {
    width,
    height,
    kind: new Uint8Array(kindBytes),
    colors: decodedColors,
    completed: new Uint8Array(completedBytes),
    backstitches: { ids, x1, y1, x2, y2, colors, completed },
    revision,
    nextBackstitchId,
    nextPaletteId
  };
  let document: PatternDocument;
  try {
    document = migratePatternDocument({
      ...rawDocument,
      version: binaryVersion,
      palette: binaryVersion === LEGACY_BINARY_SCHEMA_VERSION ? legacyPalette : palette,
      ...(settings === undefined ? {} : { settings })
    });
    assertValidDocument(document);
  } catch (error) {
    throw new PersistenceError('invalid-document', 'Decoded document failed domain validation.', error);
  }
  return document;
}

export const serializeDocument = encodeDocument;
export const deserializeDocument = decodeDocument;
export const encodePatternDocument = encodeDocument;
export const decodePatternDocument = decodeDocument;
