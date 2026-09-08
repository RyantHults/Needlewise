import {
  cloneDocument,
  defaultPaletteSymbol,
  normalizePaletteEntry,
  normalizePatternSettings
} from './model';
import { assertValidDocument } from './validation';
import {
  DEFAULT_PATTERN_SETTINGS,
  DOCUMENT_SCHEMA_VERSION,
  DomainError,
  LEGACY_DOCUMENT_SCHEMA_VERSION,
  type PaletteEntry,
  type PatternDocument
} from './types';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function typedArray<T extends Uint8Array | Uint16Array | Uint32Array>(value: unknown, Constructor: new (value: ArrayLike<number>) => T, label: string): T {
  if (!(value instanceof Constructor)) throw new DomainError('invalid-document', `${label} must be a typed array.`);
  return value.slice() as T;
}

function clonePalette(input: unknown): PaletteEntry[] {
  if (!Array.isArray(input)) throw new DomainError('invalid-document', 'Document palette must be an array.');
  const entries = input.map((entry, index) => {
    if (!isObject(entry)) throw new DomainError('invalid-palette', `Palette entry ${String(index)} is invalid.`);
    const id = entry.id;
    if (typeof id !== 'number' || !Number.isInteger(id)) throw new DomainError('invalid-palette-id', `Palette entry ${String(index)} has an invalid ID.`);
    return normalizePaletteEntry({
      id,
      name: entry.name as string,
      color: entry.color as string,
      active: entry.active as boolean,
      ...(entry.symbol === undefined ? {} : { symbol: entry.symbol as string }),
      ...(entry.material === undefined ? {} : { material: entry.material as PaletteEntry['material'] }),
      ...(entry.catalog === undefined ? {} : { catalog: entry.catalog as PaletteEntry['catalog'] })
    });
  });
  const symbols = new Set<string>();
  for (const entry of entries) {
    if (symbols.has(entry.symbol)) throw new DomainError('invalid-palette-symbol', `Palette symbol ${entry.symbol} is duplicated.`);
    symbols.add(entry.symbol);
  }
  return entries;
}

function nextId(value: unknown, entries: readonly PaletteEntry[], label: string): number {
  const maximum = entries.reduce((current, entry) => Math.max(current, entry.id), 0) + 1;
  if (value === undefined) return maximum;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < maximum) throw new DomainError('invalid-document', `${label} must be greater than every allocated ID.`);
  return value;
}

function nextBackstitchId(value: unknown, document: { backstitches: PatternDocument['backstitches'] }): number {
  const maximum = Array.from(document.backstitches.ids).reduce((current, id) => Math.max(current, id), 0) + 1;
  if (value === undefined) return maximum;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < maximum) throw new DomainError('invalid-document', 'nextBackstitchId must be greater than every allocated backstitch ID.');
  return value;
}

/** Copy-on-write migration from the v1 document grammar to the v2 domain grammar. */
export function migratePatternDocument(input: unknown): PatternDocument {
  if (!isObject(input)) throw new DomainError('invalid-document', 'Pattern document must be an object.');
  if (input.version !== LEGACY_DOCUMENT_SCHEMA_VERSION && input.version !== DOCUMENT_SCHEMA_VERSION) throw new DomainError('unsupported-version', `Pattern document version ${String(input.version)} is unsupported.`);
  const palette = clonePalette(input.palette);
  const migrated: PatternDocument = {
    version: DOCUMENT_SCHEMA_VERSION,
    width: input.width as number,
    height: input.height as number,
    kind: typedArray(input.kind, Uint8Array, 'kind'),
    colors: typedArray(input.colors, Uint16Array, 'colors'),
    completed: typedArray(input.completed, Uint8Array, 'completed'),
    backstitches: {
      ids: typedArray(isObject(input.backstitches) ? input.backstitches.ids : undefined, Uint32Array, 'backstitch IDs'),
      x1: typedArray(isObject(input.backstitches) ? input.backstitches.x1 : undefined, Uint32Array, 'backstitch x1'),
      y1: typedArray(isObject(input.backstitches) ? input.backstitches.y1 : undefined, Uint32Array, 'backstitch y1'),
      x2: typedArray(isObject(input.backstitches) ? input.backstitches.x2 : undefined, Uint32Array, 'backstitch x2'),
      y2: typedArray(isObject(input.backstitches) ? input.backstitches.y2 : undefined, Uint32Array, 'backstitch y2'),
      colors: typedArray(isObject(input.backstitches) ? input.backstitches.colors : undefined, Uint16Array, 'backstitch colors'),
      completed: typedArray(isObject(input.backstitches) ? input.backstitches.completed : undefined, Uint8Array, 'backstitch completion')
    },
    palette,
    settings: normalizePatternSettings(isObject(input.settings) ? input.settings : DEFAULT_PATTERN_SETTINGS),
    revision: input.revision as number,
    nextBackstitchId: 1,
    nextPaletteId: nextId(input.nextPaletteId, palette, 'nextPaletteId')
  };
  migrated.nextBackstitchId = nextBackstitchId(input.nextBackstitchId, migrated);
  assertValidDocument(migrated);
  return cloneDocument(migrated);
}

export const migrateDocument = migratePatternDocument;
export const migratePattern = migratePatternDocument;
export { defaultPaletteSymbol };
