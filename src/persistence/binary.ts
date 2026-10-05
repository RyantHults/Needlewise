import {
  assertValidDocument,
  assertValidLayeredDocument,
  DOCUMENT_SCHEMA_VERSION,
  DEFAULT_PATTERN_SETTINGS,
  LAYERED_DOCUMENT_VERSION,
  LayerType,
  MAX_LAYERS_PER_TYPE,
  PALETTE_ID_RESERVED,
  clonePaletteEntry,
  clonePatternSettings,
  layeredFromSurface,
  type BackstitchStore,
  type Layer,
  type LayeredDocument,
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

const MAGIC = new Uint8Array([0x4e, 0x57, 0x44, 0x4f, 0x43, 0x31, 0x01, 0x00]);
export const BINARY_SCHEMA_VERSION = 4 as const;
/** First layered schema. Layered documents before v4 have no origin or canvas mask. */
const LAYERED_SCHEMA_VERSION = 3;
/** v4 header flags byte: bit 0 means a canvas mask follows the origin. */
const FLAG_CANVAS_MASK = 1;
const LITTLE_ENDIAN_MARKER = 1;
const HEADER_BYTES = 40;
/** v1/v2 backstitch record: id, x1, y1, x2, y2, color, completed. */
const LEGACY_BACKSTITCH_BYTES = 23;
/** v3 backstitch record: id, x1, y1, x2, y2, color. Completion is not stored. */
const BACKSTITCH_BYTES = 22;
const LAYER_TYPE_CODES: Record<LayerType, number> = { [LayerType.Stitch]: 0, [LayerType.Specialty]: 1 };
const MAX_LAYERS = MAX_LAYERS_PER_TYPE * 2;

/** A decoded document plus the binary schema it was read from. */
export interface DecodedDocument {
  document: LayeredDocument;
  binaryVersion: number;
  /**
   * True when the bytes predate layers (v1/v2). Such documents carry the
   * default `settings.aidaCount`; a legacy `ProjectMetadata.aidaCount` should
   * be copied into settings (see `applyLegacyAidaCount`).
   */
  legacy: boolean;
}

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

function paletteByteLength(palette: readonly PaletteEntry[]): bigint {
  let length = 0n;
  for (const entry of palette) {
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
  return length;
}

function byteLengthFor(document: LayeredDocument): number {
  let length = BigInt(HEADER_BYTES);
  const catalogId = stringBytes(document.catalog.catalogId, 'Document catalog ID');
  const brandLabel = stringBytes(document.catalog.brandLabel, 'Document catalog brand label');
  length += 4n + BigInt(catalogId.length) + 4n + BigInt(brandLabel.length) + 4n;
  length += paletteByteLength(document.palette);
  length += 4n + BigInt(stringBytes(document.settings.symbolSet, 'Document symbol set').length);
  length += 4n + BigInt(stringBytes(document.settings.materialUnit, 'Document material unit').length);
  length += 4n + BigInt(stringBytes(document.settings.backgroundColor, 'Document background color').length);
  length += 8n + 4n + 8n;
  if (document.canvasMask !== undefined) length += BigInt(Math.ceil(document.width * document.height / 8));
  for (const layer of document.layers) {
    length += 4n + 1n + 1n + 4n + BigInt(stringBytes(layer.name, 'Layer name').length);
    if (layer.type === LayerType.Stitch) length += BigInt(layer.kind.length) + BigInt(layer.colors.length) * 2n;
    else length += 4n + BigInt(layer.backstitches.ids.length) * BigInt(BACKSTITCH_BYTES);
  }
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

function writePalette(view: DataView, bytes: Uint8Array, offset: number, palette: readonly PaletteEntry[]): number {
  for (const entry of palette) {
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
  return offset;
}

function writeStitchLayer(view: DataView, bytes: Uint8Array, offset: number, kind: Uint8Array, colors: Uint16Array): number {
  bytes.set(kind, offset);
  offset += kind.length;
  for (const color of colors) {
    view.setUint16(offset, color, true);
    offset += 2;
  }
  return offset;
}

function writeBackstitches(view: DataView, offset: number, store: BackstitchStore): number {
  view.setUint32(offset, store.ids.length, true);
  offset += 4;
  for (let index = 0; index < store.ids.length; index += 1) {
    view.setUint32(offset, store.ids[index], true);
    offset += 4;
    view.setUint32(offset, store.x1[index], true);
    offset += 4;
    view.setUint32(offset, store.y1[index], true);
    offset += 4;
    view.setUint32(offset, store.x2[index], true);
    offset += 4;
    view.setUint32(offset, store.y2[index], true);
    offset += 4;
    view.setUint16(offset, store.colors[index], true);
    offset += 2;
  }
  return offset;
}

/**
 * Encodes the v4 layered format: header, catalog, palette, settings (including
 * aidaCount), nextLayerId, originX/originY (int32), the canvas mask bitset when
 * header flag bit 0 is set (LSB first, trailing bits zero), then the layer table
 * bottom to top. Stitch layers
 * store kind and color planes; specialty layers store their backstitches.
 * Completion is never stored.
 */
export function encodeDocument(document: LayeredDocument): Uint8Array {
  checkedDocumentDimensions(document.width, document.height);
  try {
    assertValidLayeredDocument(document);
  } catch (error) {
    throw new PersistenceError('invalid-document', 'Document failed domain validation.', error);
  }
  if (document.revision > 0xffffffff || document.nextBackstitchId > 0x100000000 || document.nextLayerId > 0xffffffff) fail('Document counters exceed the binary format.');
  const length = byteLengthFor(document);
  if (length > MAX_DOCUMENT_BYTES) fail('Document snapshot exceeds the size limit.');
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  bytes.set(MAGIC, 0);
  view.setUint16(8, BINARY_SCHEMA_VERSION, true);
  view.setUint8(10, LITTLE_ENDIAN_MARKER);
  view.setUint8(11, document.canvasMask === undefined ? 0 : FLAG_CANVAS_MASK);
  view.setUint32(12, document.width, true);
  view.setUint32(16, document.height, true);
  view.setUint32(20, document.revision, true);
  view.setUint32(24, document.nextBackstitchId === 0x100000000 ? 0 : document.nextBackstitchId, true);
  view.setUint32(28, document.nextPaletteId, true);
  view.setUint32(32, document.palette.length, true);
  view.setUint32(36, document.layers.length, true);
  let offset = HEADER_BYTES;
  offset = writeString(view, bytes, offset, document.catalog.catalogId, 'Document catalog ID');
  offset = writeString(view, bytes, offset, document.catalog.brandLabel, 'Document catalog brand label');
  view.setUint32(offset, document.catalog.colorCount, true);
  offset += 4;
  offset = writePalette(view, bytes, offset, document.palette);
  offset = writeString(view, bytes, offset, document.settings.symbolSet, 'Document symbol set');
  offset = writeString(view, bytes, offset, document.settings.materialUnit, 'Document material unit');
  offset = writeString(view, bytes, offset, document.settings.backgroundColor, 'Document background color');
  view.setFloat64(offset, document.settings.aidaCount, true);
  offset += 8;
  view.setUint32(offset, document.nextLayerId, true);
  offset += 4;
  // An absent origin is written as 0 and decoded back to absent, so round trips are exact.
  view.setInt32(offset, document.originX ?? 0, true);
  view.setInt32(offset + 4, document.originY ?? 0, true);
  offset += 8;
  if (document.canvasMask !== undefined) {
    for (let index = 0; index < document.canvasMask.length; index += 1) {
      if (document.canvasMask[index] === 1) bytes[offset + (index >> 3)] |= 1 << (index & 7);
    }
    offset += Math.ceil(document.canvasMask.length / 8);
  }
  for (const layer of document.layers) {
    view.setUint32(offset, layer.id, true);
    offset += 4;
    view.setUint8(offset, LAYER_TYPE_CODES[layer.type]);
    offset += 1;
    view.setUint8(offset, layer.visible ? 1 : 0);
    offset += 1;
    offset = writeString(view, bytes, offset, layer.name, 'Layer name');
    offset = layer.type === LayerType.Stitch
      ? writeStitchLayer(view, bytes, offset, layer.kind, layer.colors)
      : writeBackstitches(view, offset, layer.backstitches);
  }
  if (offset !== length) fail('Document snapshot length is inconsistent.');
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

function readPalette(bytes: Uint8Array, view: DataView, offset: number, paletteCount: number): { palette: PaletteEntry[]; offset: number } {
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
  return { palette, offset };
}

function readColorPlane(bytes: Uint8Array, offset: number, cellCount: number): Uint16Array {
  const colorsBytes = take(bytes, offset, cellCount * 4 * 2, 'cell colors');
  const decodedColors = new Uint16Array(cellCount * 4);
  const colorView = new DataView(colorsBytes.buffer, colorsBytes.byteOffset, colorsBytes.byteLength);
  for (let index = 0; index < decodedColors.length; index += 1) decodedColors[index] = colorView.getUint16(index * 2, true);
  return decodedColors;
}

function readBackstitches(view: DataView, offset: number, count: number, recordBytes: number): BackstitchStore {
  const ids = new Uint32Array(count);
  const x1 = new Uint32Array(count);
  const y1 = new Uint32Array(count);
  const x2 = new Uint32Array(count);
  const y2 = new Uint32Array(count);
  const colors = new Uint16Array(count);
  const completed = new Uint8Array(count);
  for (let index = 0; index < count; index += 1) {
    ids[index] = view.getUint32(offset, true);
    offset += 4;
    x1[index] = view.getUint32(offset, true);
    offset += 4;
    y1[index] = view.getUint32(offset, true);
    offset += 4;
    x2[index] = view.getUint32(offset, true);
    offset += 4;
    y2[index] = view.getUint32(offset, true);
    offset += 4;
    colors[index] = view.getUint16(offset, true);
    offset += 2;
    if (recordBytes === LEGACY_BACKSTITCH_BYTES) {
      completed[index] = view.getUint8(offset);
      offset += 1;
    }
  }
  return { ids, x1, y1, x2, y2, colors, completed };
}

interface DecodedHeader {
  binaryVersion: number;
  hasMask: boolean;
  width: number;
  height: number;
  cellCount: number;
  revision: number;
  nextBackstitchId: number;
  nextPaletteId: number;
  paletteCount: number;
  /** Backstitch count for v1/v2, layer count for v3. */
  tableCount: number;
}

function readHeader(bytes: Uint8Array, view: DataView): DecodedHeader {
  const binaryVersion = view.getUint16(8, true);
  if (binaryVersion < 1 || binaryVersion > BINARY_SCHEMA_VERSION) throw new PersistenceError('unsupported-version', 'Document binary schema is unsupported.');
  if (view.getUint8(10) !== LITTLE_ENDIAN_MARKER) fail('Document byte order is unsupported.');
  const flags = view.getUint8(11);
  if (flags !== 0 && (binaryVersion < BINARY_SCHEMA_VERSION || (flags & ~FLAG_CANVAS_MASK) !== 0)) fail('Document header flags are invalid.');
  const width = view.getUint32(12, true);
  const height = view.getUint32(16, true);
  const cellCount = checkedDocumentDimensions(width, height);
  const encodedNextBackstitchId = view.getUint32(24, true);
  const paletteCount = view.getUint32(32, true);
  if (paletteCount > MAX_PALETTE_ENTRIES) fail('Palette count exceeds the size limit.');
  return {
    binaryVersion,
    hasMask: (flags & FLAG_CANVAS_MASK) !== 0,
    width,
    height,
    cellCount,
    revision: view.getUint32(20, true),
    nextBackstitchId: encodedNextBackstitchId === 0 ? 0x100000000 : encodedNextBackstitchId,
    nextPaletteId: view.getUint32(28, true),
    paletteCount,
    tableCount: view.getUint32(36, true)
  };
}

function readCatalog(bytes: Uint8Array, view: DataView, offset: number): { catalog: LayeredDocument['catalog']; offset: number } {
  const catalogIdResult = readString(bytes, view, offset, 'Document catalog ID');
  offset = catalogIdResult.offset;
  const brandLabelResult = readString(bytes, view, offset, 'Document catalog brand label');
  offset = brandLabelResult.offset;
  if (offset + 4 > bytes.length) fail('Document ended while reading catalog color count.');
  const colorCount = view.getUint32(offset, true);
  offset += 4;
  return { catalog: { catalogId: catalogIdResult.value, brandLabel: brandLabelResult.value, colorCount }, offset };
}

/** v1/v2: a single surface, upgraded to the default Stitches + Specialty stack. */
function decodeLegacyDocument(bytes: Uint8Array, view: DataView, header: DecodedHeader): LayeredDocument {
  const { binaryVersion, width, height, cellCount, revision, nextBackstitchId, nextPaletteId, paletteCount } = header;
  const backstitchCount = header.tableCount;
  if (backstitchCount > 0x1000000) fail('Backstitch count exceeds the size limit.');

  // Validate all count-derived minimum sizes before allocating any typed
  // arrays. In particular, a forged backstitch count must not reach the
  // constructors below merely because the count fits in a uint32.
  const minimumPayload = 12n
    + BigInt(paletteCount) * 29n
    + BigInt(cellCount) * 10n
    + BigInt(backstitchCount) * BigInt(LEGACY_BACKSTITCH_BYTES)
    + (binaryVersion === 1 ? 8n : 12n);
  if (minimumPayload > BigInt(bytes.length - HEADER_BYTES)) fail('Document counts exceed the remaining payload.');

  const catalogResult = readCatalog(bytes, view, HEADER_BYTES);
  const paletteResult = readPalette(bytes, view, catalogResult.offset, paletteCount);
  let offset = paletteResult.offset;
  const symbolSet = readString(bytes, view, offset, 'Document symbol set');
  offset = symbolSet.offset;
  const materialUnit = readString(bytes, view, offset, 'Document material unit');
  offset = materialUnit.offset;
  let backgroundColor = DEFAULT_PATTERN_SETTINGS.backgroundColor;
  if (binaryVersion >= 2) {
    const decodedBackgroundColor = readString(bytes, view, offset, 'Document background color');
    backgroundColor = decodedBackgroundColor.value;
    offset = decodedBackgroundColor.offset;
  }
  const settings: PatternSettings = { symbolSet: symbolSet.value, materialUnit: materialUnit.value as PatternSettings['materialUnit'], backgroundColor, aidaCount: DEFAULT_PATTERN_SETTINGS.aidaCount };
  const kindBytes = take(bytes, offset, cellCount, 'cell kinds');
  offset += cellCount;
  const colors = readColorPlane(bytes, offset, cellCount);
  offset += cellCount * 4 * 2;
  const completedBytes = take(bytes, offset, cellCount, 'cell completion');
  offset += cellCount;
  const expectedBackstitchBytesBig = BigInt(backstitchCount) * BigInt(LEGACY_BACKSTITCH_BYTES);
  if (expectedBackstitchBytesBig > BigInt(bytes.length - offset)) fail('Backstitch payload exceeds the document size limit.');
  const expectedBackstitchBytes = Number(expectedBackstitchBytesBig);
  if (offset + expectedBackstitchBytes !== bytes.length) fail('Document contains an invalid trailing payload.');
  const backstitches = readBackstitches(view, offset, backstitchCount, LEGACY_BACKSTITCH_BYTES);

  const surface: PatternDocument = {
    version: DOCUMENT_SCHEMA_VERSION,
    catalog: catalogResult.catalog,
    width,
    height,
    kind: new Uint8Array(kindBytes),
    colors,
    completed: new Uint8Array(completedBytes),
    backstitches,
    revision,
    nextBackstitchId,
    nextPaletteId,
    palette: paletteResult.palette,
    settings
  };
  try {
    assertValidDocument(surface);
  } catch (error) {
    throw new PersistenceError('invalid-document', 'Decoded document failed domain validation.', error);
  }
  return layeredFromSurface(surface);
}

function decodeLayeredDocument(bytes: Uint8Array, view: DataView, header: DecodedHeader): LayeredDocument {
  const { binaryVersion, hasMask, width, height, cellCount, revision, nextBackstitchId, nextPaletteId, paletteCount } = header;
  const layerCount = header.tableCount;
  if (layerCount > MAX_LAYERS) fail('Layer count exceeds the size limit.');
  const minimumPayload = 12n + BigInt(paletteCount) * 29n + 12n + 8n + 4n + (binaryVersion >= BINARY_SCHEMA_VERSION ? 8n : 0n) + BigInt(layerCount) * 10n;
  if (minimumPayload > BigInt(bytes.length - HEADER_BYTES)) fail('Document counts exceed the remaining payload.');

  const catalogResult = readCatalog(bytes, view, HEADER_BYTES);
  const paletteResult = readPalette(bytes, view, catalogResult.offset, paletteCount);
  let offset = paletteResult.offset;
  const symbolSet = readString(bytes, view, offset, 'Document symbol set');
  offset = symbolSet.offset;
  const materialUnit = readString(bytes, view, offset, 'Document material unit');
  offset = materialUnit.offset;
  const backgroundColor = readString(bytes, view, offset, 'Document background color');
  offset = backgroundColor.offset;
  if (offset + 12 > bytes.length) fail('Document ended while reading document settings.');
  const aidaCount = view.getFloat64(offset, true);
  offset += 8;
  const nextLayerId = view.getUint32(offset, true);
  offset += 4;
  const settings: PatternSettings = { symbolSet: symbolSet.value, materialUnit: materialUnit.value as PatternSettings['materialUnit'], backgroundColor: backgroundColor.value, aidaCount };
  let originX = 0;
  let originY = 0;
  let canvasMask: Uint8Array | undefined;
  if (binaryVersion >= BINARY_SCHEMA_VERSION) {
    if (offset + 8 > bytes.length) fail('Document ended while reading the canvas origin.');
    originX = view.getInt32(offset, true);
    originY = view.getInt32(offset + 4, true);
    offset += 8;
    if (hasMask) {
      const maskBytes = take(bytes, offset, Math.ceil(cellCount / 8), 'canvas mask');
      offset += maskBytes.length;
      if (cellCount % 8 !== 0 && maskBytes[maskBytes.length - 1] >> (cellCount % 8) !== 0) fail('Canvas mask padding bits are not zero.');
      canvasMask = new Uint8Array(cellCount);
      for (let index = 0; index < cellCount; index += 1) canvasMask[index] = (maskBytes[index >> 3] >> (index & 7)) & 1;
    }
  }

  const layers: Layer[] = [];
  for (let index = 0; index < layerCount; index += 1) {
    if (offset + 6 > bytes.length) fail('Document ended while reading a layer.');
    const id = view.getUint32(offset, true);
    offset += 4;
    const typeCode = view.getUint8(offset);
    offset += 1;
    const visibleValue = view.getUint8(offset);
    offset += 1;
    if (visibleValue > 1) fail('Layer visible flag is invalid.');
    const name = readString(bytes, view, offset, 'Layer name');
    offset = name.offset;
    if (typeCode === LAYER_TYPE_CODES[LayerType.Stitch]) {
      // Both planes are bounds-checked by `take` before any allocation.
      if (BigInt(cellCount) * 9n > BigInt(bytes.length - offset)) fail('Document ended while reading layer cells.');
      const kind = new Uint8Array(take(bytes, offset, cellCount, 'cell kinds'));
      offset += cellCount;
      const colors = readColorPlane(bytes, offset, cellCount);
      offset += cellCount * 4 * 2;
      layers.push({ id, type: LayerType.Stitch, name: name.value, visible: visibleValue === 1, kind, colors, completed: new Uint8Array(cellCount) });
    } else if (typeCode === LAYER_TYPE_CODES[LayerType.Specialty]) {
      if (offset + 4 > bytes.length) fail('Document ended while reading a backstitch count.');
      const count = view.getUint32(offset, true);
      offset += 4;
      if (count > 0x1000000) fail('Backstitch count exceeds the size limit.');
      const recordBytes = BigInt(count) * BigInt(BACKSTITCH_BYTES);
      if (recordBytes > BigInt(bytes.length - offset)) fail('Backstitch payload exceeds the document size limit.');
      const backstitches = readBackstitches(view, offset, count, BACKSTITCH_BYTES);
      offset += Number(recordBytes);
      layers.push({ id, type: LayerType.Specialty, name: name.value, visible: visibleValue === 1, backstitches });
    } else {
      fail('Layer type is invalid.');
    }
  }
  if (offset !== bytes.length) fail('Document contains an invalid trailing payload.');

  const document: LayeredDocument = {
    version: LAYERED_DOCUMENT_VERSION,
    catalog: catalogResult.catalog,
    width,
    height,
    layers,
    palette: paletteResult.palette,
    settings,
    revision,
    nextBackstitchId,
    nextPaletteId,
    nextLayerId,
    // Origin 0 decodes as absent: encode writes 0 for an absent origin, and old documents never gain fields.
    ...(originX === 0 ? {} : { originX }),
    ...(originY === 0 ? {} : { originY }),
    ...(canvasMask === undefined ? {} : { canvasMask })
  };
  try {
    assertValidLayeredDocument(document);
  } catch (error) {
    throw new PersistenceError('invalid-document', 'Decoded document failed domain validation.', error);
  }
  return document;
}

/** Decodes any supported binary schema and reports which one it was. */
export function decodeDocumentWithInfo(input: Uint8Array | ArrayBuffer): DecodedDocument {
  const bytes = asBytes(input);
  if (bytes.length > MAX_DOCUMENT_BYTES) fail('Document snapshot exceeds the size limit.');
  if (bytes.length < HEADER_BYTES || !sameMagic(bytes)) fail('Document binary magic is invalid.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = readHeader(bytes, view);
  const legacy = header.binaryVersion < LAYERED_SCHEMA_VERSION;
  const document = legacy ? decodeLegacyDocument(bytes, view, header) : decodeLayeredDocument(bytes, view, header);
  return { document, binaryVersion: header.binaryVersion, legacy };
}

export function decodeDocument(input: Uint8Array | ArrayBuffer): LayeredDocument {
  return decodeDocumentWithInfo(input).document;
}

/**
 * Before layers, the stitch count lived in project metadata. Copies a legacy
 * `aidaCount` into the settings of a document decoded from v1/v2 bytes, in
 * place. Returns true when it changed the document.
 */
export function applyLegacyAidaCount(decoded: DecodedDocument, legacyAidaCount: number | undefined): boolean {
  if (!decoded.legacy || legacyAidaCount === undefined || !Number.isFinite(legacyAidaCount) || legacyAidaCount <= 0) return false;
  if (decoded.document.settings.aidaCount === legacyAidaCount) return false;
  decoded.document.settings = { ...decoded.document.settings, aidaCount: legacyAidaCount };
  return true;
}

function cloneBackstitches(store: BackstitchStore): BackstitchStore {
  return { ids: store.ids.slice(), x1: store.x1.slice(), y1: store.y1.slice(), x2: store.x2.slice(), y2: store.y2.slice(), colors: store.colors.slice(), completed: store.completed.slice() };
}

/** A fully detached copy, so persistence never shares planes with a live editor. */
export function cloneLayeredDocument(document: LayeredDocument): LayeredDocument {
  return {
    version: LAYERED_DOCUMENT_VERSION,
    catalog: { catalogId: document.catalog.catalogId, brandLabel: document.catalog.brandLabel, colorCount: document.catalog.colorCount },
    width: document.width,
    height: document.height,
    layers: document.layers.map((layer): Layer => layer.type === LayerType.Stitch
      ? { id: layer.id, type: LayerType.Stitch, name: layer.name, visible: layer.visible, kind: layer.kind.slice(), colors: layer.colors.slice(), completed: layer.completed.slice() }
      : { id: layer.id, type: LayerType.Specialty, name: layer.name, visible: layer.visible, backstitches: cloneBackstitches(layer.backstitches) }),
    palette: document.palette.map(clonePaletteEntry),
    settings: clonePatternSettings(document.settings),
    revision: document.revision,
    nextBackstitchId: document.nextBackstitchId,
    nextPaletteId: document.nextPaletteId,
    nextLayerId: document.nextLayerId,
    ...(document.originX === undefined ? {} : { originX: document.originX }),
    ...(document.originY === undefined ? {} : { originY: document.originY }),
    ...(document.canvasMask === undefined ? {} : { canvasMask: document.canvasMask.slice() })
  };
}

export const serializeDocument = encodeDocument;
export const deserializeDocument = decodeDocument;
export const encodePatternDocument = encodeDocument;
export const decodePatternDocument = decodeDocument;
