import {
  CellKind,
  DomainError,
  type BackstitchRecord,
  type BackstitchStore,
  type CreateDocumentOptions,
  type PaletteEntry,
  type PaletteEntryInput,
  type PaletteCatalogReference,
  type PaletteMaterial,
  type PatternSettings,
  type PatternDocument,
  type CatalogAssociation,
  type QuarterCorner,
  DEFAULT_PATTERN_SETTINGS,
  MaterialKind,
  MaterialUnit,
  DOCUMENT_SCHEMA_VERSION,
  PALETTE_ID_MAX,
  MAX_PERSISTABLE_CELL_COUNT
} from './types';
import { SYMBOL_IDS } from '../symbols';
import { allocateBackstitches, cloneBackstitches, readBackstitch } from './backstitch-store';
import { isRecord } from './guards';
import { assertValidDocument } from './validation';
import { parseHexColor } from './color';
import { canvasFields } from './canvas';

const UINT32_MAX = 0xffffffff;

/** True when `id` names a symbol the generated pool can actually draw. */
export function isKnownSymbolId(id: string): boolean {
  return SYMBOL_IDS.includes(id);
}

export function clonePaletteEntry(entry: PaletteEntry): PaletteEntry {
  return {
    id: entry.id,
    name: entry.name,
    color: entry.color,
    active: entry.active,
    symbol: entry.symbol,
    material: {
      kind: entry.material.kind,
      label: entry.material.label,
      unit: entry.material.unit,
      ...(entry.material.amount === undefined ? {} : { amount: entry.material.amount })
    },
    ...(entry.catalog === undefined
      ? {}
      : {
          catalog: {
            catalogId: entry.catalog.catalogId,
            sourceId: entry.catalog.sourceId,
            code: entry.catalog.code,
            name: entry.catalog.name,
            hex: entry.catalog.hex,
            rgb: [...entry.catalog.rgb] as [number, number, number]
          }
        })
  };
}

export function defaultPaletteSymbol(id: number): string {
  if (!Number.isSafeInteger(id) || id < 1) throw new DomainError('invalid-palette-id', `Palette ID ${String(id)} is invalid.`);
  // The pool is whatever the selection holds, and an empty selection is a state
  // the picker can save, so there is nothing here to index into. Naming the tool
  // that fills the pool is the whole answer: the id is fine, the pool is not.
  if (SYMBOL_IDS.length === 0) {
    throw new DomainError(
      'empty-symbol-pool',
      'The symbol pool is empty, so a color has no symbol to draw. Choose symbols in the picker at /__symbols, then run: pnpm symbols:build'
    );
  }
  // Palette IDs start at 1. The curated pool does not cover the (larger) brand
  // palette ceiling, so ids past the end of the pool cycle deterministically
  // and the default repeats; see isAutoOverflowEntry for how the duplicate
  // guards treat those cycled defaults. Ids inside the pool still map one-to-one
  // in pool order, which is distinctness order: each symbol is the least like
  // those before it.
  return SYMBOL_IDS[(id - 1) % SYMBOL_IDS.length];
}

/**
 * True when this entry's symbol is the cycled default for its own id AND
 * that cycled default is already taken by a sibling — i.e. the entry was
 * produced by the auto-assign overflow path and so is exempt from the
 * validator's duplicate-symbol guard. Explicit symbol assignment and
 * palette-update reassignment keep the guard, so only true auto-overflow
 * entries are flagged here. Reachable whenever the curated pool is smaller
 * than the catalog palette ceiling.
 */
export function isAutoOverflowEntry(entry: PaletteEntry, palette: readonly PaletteEntry[]): boolean {
  if (entry.symbol !== defaultPaletteSymbol(entry.id)) return false;
  for (const other of palette) {
    if (other.id !== entry.id && other.symbol === entry.symbol) return true;
  }
  return false;
}

export function defaultPaletteMaterial(name: string, catalog?: PaletteCatalogReference): PaletteMaterial {
  return {
    kind: catalog === undefined ? MaterialKind.Custom : MaterialKind.Floss,
    label: catalog?.name ?? name,
    unit: MaterialUnit.Skeins
  };
}

export function clonePatternSettings(settings: PatternSettings): PatternSettings {
  return { symbolSet: settings.symbolSet, materialUnit: settings.materialUnit, backgroundColor: settings.backgroundColor, aidaCount: settings.aidaCount };
}

export function normalizePatternSettings(settings: Partial<PatternSettings> | undefined): PatternSettings {
  const symbolSet = settings?.symbolSet ?? DEFAULT_PATTERN_SETTINGS.symbolSet;
  const materialUnit = settings?.materialUnit ?? DEFAULT_PATTERN_SETTINGS.materialUnit;
  const suppliedBackgroundColor = settings?.backgroundColor === undefined
    ? DEFAULT_PATTERN_SETTINGS.backgroundColor
    : settings.backgroundColor;
  const aidaCount = settings?.aidaCount ?? DEFAULT_PATTERN_SETTINGS.aidaCount;
  if (typeof symbolSet !== 'string' || symbolSet.trim() === '') throw new DomainError('invalid-settings', 'The symbol set must be a non-empty string.');
  if (![MaterialUnit.Skeins, MaterialUnit.Meters, MaterialUnit.Count].includes(materialUnit)) throw new DomainError('invalid-settings', `Material unit ${String(materialUnit)} is invalid.`);
  if (typeof suppliedBackgroundColor !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(suppliedBackgroundColor)) throw new DomainError('invalid-settings', 'The background color must be a 6-digit HEX color.');
  if (typeof aidaCount !== 'number' || !Number.isFinite(aidaCount) || aidaCount <= 0) throw new DomainError('invalid-settings', 'The stitch count must be a finite number greater than zero.');
  return { symbolSet, materialUnit, backgroundColor: suppliedBackgroundColor.toUpperCase(), aidaCount };
}

function normalizeCatalogReference(value: unknown): PaletteCatalogReference | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new DomainError('invalid-catalog-reference', 'Catalog references must be objects.');
  const candidate = value;
  if (typeof candidate.catalogId !== 'string' || !candidate.catalogId.trim() || typeof candidate.sourceId !== 'string' || !candidate.sourceId.trim() || typeof candidate.code !== 'string' || !candidate.code.trim() || typeof candidate.name !== 'string' || !candidate.name.trim() || typeof candidate.hex !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(candidate.hex) || !Array.isArray(candidate.rgb) || candidate.rgb.length !== 3 || candidate.rgb.some((channel) => !Number.isSafeInteger(channel) || channel < 0 || channel > 255)) throw new DomainError('invalid-catalog-reference', 'Catalog references have invalid identity or color data.');
  const rgb = candidate.rgb as number[];
  const expected = parseHexColor(candidate.hex);
  if (!expected || rgb.some((channel, index) => channel !== expected[index])) throw new DomainError('invalid-catalog-reference', 'Catalog HEX and RGB values must agree.');
  return { catalogId: candidate.catalogId, sourceId: candidate.sourceId, code: candidate.code, name: candidate.name, hex: candidate.hex.toUpperCase(), rgb: [...rgb] as [number, number, number] };
}

export function paletteLimit(document: Pick<PatternDocument, 'catalog'>): number {
  return Math.min(document.catalog.colorCount, PALETTE_ID_MAX);
}

function normalizeMaterial(value: unknown, fallbackName: string, catalog?: PaletteCatalogReference): PaletteMaterial {
  if (value === undefined) return defaultPaletteMaterial(fallbackName, catalog);
  if (!isRecord(value)) throw new DomainError('invalid-material', 'Palette materials must be objects.');
  const candidate = value;
  const kind = candidate.kind;
  const label = candidate.label;
  const unit = candidate.unit;
  if (kind !== MaterialKind.Floss && kind !== MaterialKind.Custom) throw new DomainError('invalid-material', 'Palette material kind is invalid.');
  if (typeof label !== 'string' || !label.trim()) throw new DomainError('invalid-material', 'Palette material labels must not be empty.');
  if (unit !== MaterialUnit.Skeins && unit !== MaterialUnit.Meters && unit !== MaterialUnit.Count) throw new DomainError('invalid-material', 'Palette material unit is invalid.');
  const amount = candidate.amount;
  if (amount !== undefined && (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0)) throw new DomainError('invalid-material', 'Palette material amount must be a non-negative finite number.');
  return { kind, label, unit, ...(amount === undefined ? {} : { amount }) };
}

export function normalizePaletteEntry(input: PaletteEntryInput | PaletteEntry, idOverride?: number): PaletteEntry {
  if (!isRecord(input)) throw new DomainError('invalid-palette', 'Palette entries must be objects.');
  const entryId = idOverride ?? input.id;
  if (typeof entryId !== 'number' || !Number.isSafeInteger(entryId) || entryId < 1 || entryId > PALETTE_ID_MAX) throw new DomainError('invalid-palette-id', `Palette ID ${String(entryId)} is invalid.`);
  const id: number = entryId;
  if (typeof input.name !== 'string' || input.name.trim() === '') throw new DomainError('invalid-palette', 'Palette names must not be empty.');
  if (typeof input.color !== 'string' || input.color.trim() === '') throw new DomainError('invalid-palette', 'Palette colors must not be empty.');
  const catalog = normalizeCatalogReference(input.catalog);
  const symbol = input.symbol ?? defaultPaletteSymbol(id);
  if (typeof symbol !== 'string' || symbol.trim() === '') throw new DomainError('invalid-palette-symbol', 'Palette symbols must not be empty.');
  if (!isKnownSymbolId(symbol)) throw new DomainError('invalid-palette-symbol', `Palette symbol ${symbol} is not in the symbol pool.`);
  const material = normalizeMaterial(input.material, input.name, catalog);
  return { id, name: input.name, color: input.color, active: input.active !== false, symbol, material, ...(catalog === undefined ? {} : { catalog }) };
}

export function emptyBackstitches(): BackstitchStore {
  return allocateBackstitches(0);
}

function normalizePalette(
  entries: Array<PaletteEntryInput | PaletteEntry> | undefined,
  catalog: CatalogAssociation
): { palette: PaletteEntry[]; nextPaletteId: number } {
  const palette: PaletteEntry[] = [];
  const ids = new Set<number>();
  let nextId = 1;
  const limit = Math.min(catalog.colorCount, PALETTE_ID_MAX);

  for (const input of entries ?? []) {
    const id = input.id === undefined ? nextId : input.id;
    if (typeof id === 'number' && id > limit) {
      throw new DomainError('invalid-palette-id', `The palette cannot exceed the brand's color count (${String(limit)}).`);
    }
    if (!Number.isSafeInteger(id) || id < 1 || id > limit || ids.has(id)) {
      throw new DomainError('invalid-palette-id', `Palette ID ${String(id)} is invalid or duplicated.`);
    }
    const entry = normalizePaletteEntry(input, id);
    // Auto-overflow — a palette grown past the curated pool whose tail entries
    // reuse their cycled default — is exempt from the duplicate guard, matching
    // the palette-create command path, so a document the app grew past the pool
    // can round-trip through create/restore instead of failing to load.
    if (!isAutoOverflowEntry(entry, palette) && palette.some((candidate) => candidate.symbol === entry.symbol)) throw new DomainError('invalid-palette-symbol', `Palette symbol ${entry.symbol} is duplicated.`);
    ids.add(id);
    palette.push(entry);
    nextId = Math.max(nextId, id + 1);
  }

  if (nextId > PALETTE_ID_MAX) {
    nextId = PALETTE_ID_MAX + 1;
  }
  return { palette, nextPaletteId: nextId };
}

export function createDocument(options: CreateDocumentOptions): PatternDocument;
export function createDocument(options: CreateDocumentOptions): PatternDocument {
  if (
    !Number.isSafeInteger(options.width) ||
    !Number.isSafeInteger(options.height) ||
    options.width < 1 ||
    options.height < 1
  ) {
    throw new DomainError('invalid-dimensions', 'Pattern dimensions must be positive integers.');
  }
  const cellCount = options.width * options.height;
  if (!Number.isSafeInteger(cellCount) || cellCount > MAX_PERSISTABLE_CELL_COUNT) {
    throw new DomainError('invalid-dimensions', 'Pattern dimensions are too large.');
  }

  if (!isRecord(options.catalog)) {
    throw new DomainError('invalid-catalog', 'A catalog association is required.');
  }
  const catalog = {
    catalogId: options.catalog.catalogId,
    brandLabel: options.catalog.brandLabel,
    colorCount: options.catalog.colorCount
  };
  const { palette, nextPaletteId } = normalizePalette(options.palette, catalog);
  const document: PatternDocument = {
    version: DOCUMENT_SCHEMA_VERSION,
    catalog,
    width: options.width,
    height: options.height,
    kind: new Uint8Array(cellCount),
    colors: new Uint16Array(cellCount * 4),
    completed: new Uint8Array(cellCount),
    backstitches: emptyBackstitches(),
    palette,
    settings: normalizePatternSettings(options.settings),
    revision: 0,
    nextBackstitchId: 1,
    nextPaletteId
  };
  assertValidDocument(document);
  return document;
}

export function cloneDocument(document: PatternDocument): PatternDocument {
  return {
    version: DOCUMENT_SCHEMA_VERSION,
    catalog: {
      catalogId: document.catalog.catalogId,
      brandLabel: document.catalog.brandLabel,
      colorCount: document.catalog.colorCount
    },
    width: document.width,
    height: document.height,
    kind: document.kind.slice(),
    colors: document.colors.slice(),
    completed: document.completed.slice(),
    backstitches: cloneBackstitches(document.backstitches),
    palette: document.palette.map(clonePaletteEntry),
    settings: clonePatternSettings(document.settings),
    revision: document.revision,
    nextBackstitchId: document.nextBackstitchId,
    nextPaletteId: document.nextPaletteId,
    ...canvasFields(document)
  };
}

export function cellIndex(document: PatternDocument, x: number, y: number): number {
  if (
    !Number.isSafeInteger(x) ||
    !Number.isSafeInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= document.width ||
    y >= document.height
  ) {
    throw new DomainError('out-of-bounds', `Cell (${String(x)}, ${String(y)}) is out of bounds.`);
  }
  return y * document.width + x;
}

export function colorsOffset(index: number): number {
  return index * 4;
}

export function findPaletteEntry(document: PatternDocument, id: number): PaletteEntry | undefined {
  return document.palette.find((entry) => entry.id === id);
}

export function requirePaletteEntry(document: PatternDocument, id: number): PaletteEntry {
  if (!Number.isSafeInteger(id) || id < 1 || id > PALETTE_ID_MAX) {
    throw new DomainError('invalid-palette-id', `Palette ID ${String(id)} is invalid.`);
  }
  const entry = findPaletteEntry(document, id);
  if (!entry) {
    throw new DomainError('unknown-palette', `Palette ID ${String(id)} does not exist.`);
  }
  if (!entry.active) {
    throw new DomainError('inactive-palette', `Palette ID ${String(id)} is inactive.`);
  }
  return entry;
}

export function listBackstitches(document: PatternDocument): BackstitchRecord[] {
  return Array.from(document.backstitches.ids, (_, index) => readBackstitch(document.backstitches, index));
}

export { UINT32_MAX };

export function isThreeQuarterPairKind(kind: number): boolean {
  return kind === CellKind.ThreeQuarterPair;
}

export function isThreeQuarterKind(kind: number): boolean {
  return kind === CellKind.ThreeQuarterNW
    || kind === CellKind.ThreeQuarterNE
    || kind === CellKind.ThreeQuarterSE
    || kind === CellKind.ThreeQuarterSW;
}

export function threeQuarterKindForCorner(corner: QuarterCorner): CellKind {
  if (!Number.isSafeInteger(corner) || corner < 0 || corner > 3) throw new DomainError('invalid-corner', `Three-quarter corner ${String(corner)} is invalid.`);
  return [CellKind.ThreeQuarterNW, CellKind.ThreeQuarterNE, CellKind.ThreeQuarterSE, CellKind.ThreeQuarterSW][corner] as CellKind;
}

export function threeQuarterCornerForKind(kind: number): QuarterCorner | undefined {
  if (kind === CellKind.ThreeQuarterNW) return 0;
  if (kind === CellKind.ThreeQuarterNE) return 1;
  if (kind === CellKind.ThreeQuarterSE) return 2;
  if (kind === CellKind.ThreeQuarterSW) return 3;
  return undefined;
}

export function oppositeQuarterCorner(corner: QuarterCorner): QuarterCorner {
  if (!Number.isSafeInteger(corner) || corner < 0 || corner > 3) throw new DomainError('invalid-corner', `Quarter corner ${String(corner)} is invalid.`);
  return ((corner + 2) % 4) as QuarterCorner;
}
