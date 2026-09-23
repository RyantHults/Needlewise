import { CellKind, DOCUMENT_SCHEMA_VERSION, DomainError, MaterialKind, MaterialUnit, MAX_PERSISTABLE_CELL_COUNT, PALETTE_ID_MAX, type PatternDocument, type ValidationResult } from './types';
import { UINT32_MAX, isAutoOverflowEntry, isThreeQuarterKind, isThreeQuarterPairKind, paletteLimit } from './model';

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isKnownCellKind(kind: number): boolean {
  return kind === CellKind.Empty
    || kind === CellKind.Full
    || kind === CellKind.HalfBackslash
    || kind === CellKind.HalfSlash
    || kind === CellKind.Quarters
    || isThreeQuarterKind(kind)
    || isThreeQuarterPairKind(kind);
}

export function collectValidationErrors(document: PatternDocument): string[] {
  const errors: string[] = [];
  if (!document || document.version !== DOCUMENT_SCHEMA_VERSION) {
    errors.push(`Document version must be ${String(DOCUMENT_SCHEMA_VERSION)}.`);
    return errors;
  }
  const catalog = document.catalog;
  const validCatalog = typeof catalog === 'object' && catalog !== null;
  if (!validCatalog) {
    errors.push('Document catalog association is required.');
  } else {
    if (typeof catalog.catalogId !== 'string' || catalog.catalogId.trim() === '') errors.push('Document catalog ID must be a non-empty string.');
    if (typeof catalog.brandLabel !== 'string' || catalog.brandLabel.trim() === '') errors.push('Document catalog brand label must be a non-empty string.');
    if (!Number.isSafeInteger(catalog.colorCount) || catalog.colorCount < 1 || catalog.colorCount > PALETTE_ID_MAX) errors.push(`Document catalog color count must be a positive safe integer no larger than ${String(PALETTE_ID_MAX)}.`);
  }
  if (!isPositiveInteger(document.width) || !isPositiveInteger(document.height)) {
    errors.push('Document dimensions must be positive integers.');
    return errors;
  }

  const cellCount = document.width * document.height;
  if (!Number.isSafeInteger(cellCount) || cellCount > MAX_PERSISTABLE_CELL_COUNT) {
    errors.push('Document dimensions are too large.');
    return errors;
  }
  if (!(document.kind instanceof Uint8Array) || document.kind.length !== cellCount) {
    errors.push('kind must be a Uint8Array with one value per cell.');
  }
  if (
    !(document.colors instanceof Uint16Array) ||
    document.colors.length !== cellCount * 4
  ) {
    errors.push('colors must be a Uint16Array with four slots per cell.');
  }
  if (!(document.completed instanceof Uint8Array) || document.completed.length !== cellCount) {
    errors.push('completed must be a Uint8Array with one value per cell.');
  }
  if (errors.length > 0) return errors;

  const paletteIds = new Set<number>();
  const activePaletteIds = new Set<number>();
  const limit = validCatalog ? paletteLimit(document) : PALETTE_ID_MAX;
  if (document.palette.length > limit) {
    errors.push(`The palette cannot exceed the brand's color count (${String(limit)}).`);
  }
  for (const entry of document.palette) {
    if (entry.id > limit) {
      errors.push(`Palette ID ${String(entry.id)} is above the brand's color count (${String(limit)}).`);
    }
    if (
      !Number.isInteger(entry.id) ||
      entry.id < 1 ||
      entry.id > PALETTE_ID_MAX ||
      paletteIds.has(entry.id)
    ) {
      errors.push(`Palette ID ${String(entry.id)} is invalid or duplicated.`);
    }
    if (typeof entry.name !== 'string' || entry.name.trim() === '') {
      errors.push(`Palette ID ${String(entry.id)} has an empty name.`);
    }
    if (typeof entry.color !== 'string' || entry.color.trim() === '') {
      errors.push(`Palette ID ${String(entry.id)} has an empty color.`);
    }
    if (typeof entry.active !== 'boolean') {
      errors.push(`Palette ID ${String(entry.id)} must have a boolean active flag.`);
    }
    if (typeof entry.symbol !== 'string' || entry.symbol.trim() === '') {
      errors.push(`Palette ID ${String(entry.id)} has an empty symbol.`);
    }
    if (!entry.material || typeof entry.material !== 'object') {
      errors.push(`Palette ID ${String(entry.id)} has invalid material data.`);
    } else {
      if (entry.material.kind !== MaterialKind.Floss && entry.material.kind !== MaterialKind.Custom) errors.push(`Palette ID ${String(entry.id)} has an invalid material kind.`);
      if (typeof entry.material.label !== 'string' || entry.material.label.trim() === '') errors.push(`Palette ID ${String(entry.id)} has an empty material label.`);
      if (entry.material.unit !== MaterialUnit.Skeins && entry.material.unit !== MaterialUnit.Meters && entry.material.unit !== MaterialUnit.Count) errors.push(`Palette ID ${String(entry.id)} has an invalid material unit.`);
      if (entry.material.amount !== undefined && (!Number.isFinite(entry.material.amount) || entry.material.amount < 0)) errors.push(`Palette ID ${String(entry.id)} has an invalid material amount.`);
    }
    if (entry.catalog !== undefined) {
      const catalog = entry.catalog;
      const expectedRgb = typeof catalog.hex === 'string' && /^#[0-9a-f]{6}$/i.test(catalog.hex)
        ? [Number.parseInt(catalog.hex.slice(1, 3), 16), Number.parseInt(catalog.hex.slice(3, 5), 16), Number.parseInt(catalog.hex.slice(5, 7), 16)]
        : undefined;
      if (typeof catalog.catalogId !== 'string' || !catalog.catalogId.trim() || typeof catalog.sourceId !== 'string' || !catalog.sourceId.trim() || typeof catalog.code !== 'string' || !catalog.code.trim() || typeof catalog.name !== 'string' || !catalog.name.trim() || expectedRgb === undefined || !Array.isArray(catalog.rgb) || catalog.rgb.length !== 3 || catalog.rgb.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255) || catalog.rgb.some((channel, index) => channel !== expectedRgb[index])) {
        errors.push(`Palette ID ${String(entry.id)} has invalid catalog data.`);
      }
    }
    paletteIds.add(entry.id);
    if (entry.active === true) activePaletteIds.add(entry.id);
  }

  const symbols = new Set<string>();
  for (const entry of document.palette) {
    if (typeof entry.symbol === 'string') {
      // The auto-create overflow path (all curated glyphs taken, palette
      // grows past PALETTE_SYMBOLS.length) intentionally reuses the cycled
      // default. Validation still rejects explicit symbol duplicates on
      // create-with-symbol and on palette-update — only entries the
      // auto-assign path produced are exempt, identified by the helper.
      if (!isAutoOverflowEntry(entry, document.palette) && symbols.has(entry.symbol)) errors.push(`Palette symbol ${entry.symbol} is duplicated.`);
      symbols.add(entry.symbol);
    }
  }

  if (!document.settings || typeof document.settings !== 'object') {
    errors.push('Document settings are invalid.');
  } else {
    if (typeof document.settings.symbolSet !== 'string' || document.settings.symbolSet.trim() === '') errors.push('Document symbolSet must be a non-empty string.');
    if (![MaterialUnit.Skeins, MaterialUnit.Meters, MaterialUnit.Count].includes(document.settings.materialUnit)) errors.push('Document materialUnit is invalid.');
  }

  if (
    !Number.isInteger(document.nextPaletteId) ||
    document.nextPaletteId < 1 ||
    document.nextPaletteId > PALETTE_ID_MAX + 1
  ) {
    errors.push('nextPaletteId is invalid.');
  } else if (document.palette.some((entry) => entry.id >= document.nextPaletteId)) {
    errors.push('nextPaletteId must be greater than every allocated palette ID.');
  }

  const hasCellData = document.kind.some((value) => value !== CellKind.Empty)
    || document.colors.some((value) => value !== 0)
    || document.completed.some((value) => value !== 0);
  if (hasCellData) for (let index = 0; index < cellCount; index += 1) {
    const kind = document.kind[index];
    const offset = index * 4;
    const completion = document.completed[index];
    if (!isKnownCellKind(kind)) {
      errors.push(`Cell ${String(index)} has an unknown kind.`);
      continue;
    }
    if (completion > 0x0f) errors.push(`Cell ${String(index)} has invalid completion bits.`);

    if (kind === CellKind.Empty) {
      if (completion !== 0 || document.colors[offset] !== 0 || document.colors[offset + 1] !== 0 || document.colors[offset + 2] !== 0 || document.colors[offset + 3] !== 0) {
        errors.push(`Empty cell ${String(index)} contains data.`);
      }
      continue;
    }

    if (isThreeQuarterPairKind(kind)) {
      const occupiedMask = [0, 1, 2, 3].reduce((mask, slot) => mask | (document.colors[offset + slot] === 0 ? 0 : 1 << slot), 0);
      if (occupiedMask !== 0b0101 && occupiedMask !== 0b1010) errors.push(`Three-quarter pair cell ${String(index)} must contain exactly one opposite occupied pair.`);
      for (let slot = 0; slot < 4; slot += 1) {
        const color = document.colors[offset + slot];
        const bit = 1 << slot;
        if (color === 0) {
          if ((completion & bit) !== 0) errors.push(`Three-quarter pair completion is set for an empty slot at cell ${String(index)}.`);
        } else if (!activePaletteIds.has(color)) {
          errors.push(`Three-quarter pair at cell ${String(index)} has an unknown palette ID.`);
        }
      }
      continue;
    }

    if (kind === CellKind.Full || kind === CellKind.HalfBackslash || kind === CellKind.HalfSlash || isThreeQuarterKind(kind)) {
      if (document.colors[offset] === 0 || !activePaletteIds.has(document.colors[offset])) {
        errors.push(`Cell ${String(index)} has an invalid primary palette ID.`);
      }
      if (document.colors[offset + 1] !== 0 || document.colors[offset + 2] !== 0 || document.colors[offset + 3] !== 0 || (completion & 0x0e) !== 0) {
        errors.push(`Non-quarter cell ${String(index)} has quarter data.`);
      }
      continue;
    }

    let quarterCount = 0;
    for (let slot = 0; slot < 4; slot += 1) {
      const color = document.colors[offset + slot];
      const bit = 1 << slot;
      if (color === 0) {
        if ((completion & bit) !== 0) errors.push(`Quarter completion is set for an empty slot at cell ${String(index)}.`);
      } else {
        quarterCount += 1;
        if (!activePaletteIds.has(color)) errors.push(`Quarter at cell ${String(index)} has an unknown palette ID.`);
      }
    }
    if (quarterCount < 1 || quarterCount > 4) errors.push(`Quarter cell ${String(index)} must contain one to four quarters.`);
  }

  const store = document.backstitches;
  const recordLengths = [store.ids.length, store.x1.length, store.y1.length, store.x2.length, store.y2.length, store.colors.length, store.completed.length];
  if (recordLengths.some((length) => length !== store.ids.length)) {
    errors.push('Backstitch typed arrays must have equal lengths.');
  }
  const ids = new Set<number>();
  const segments = new Set<string>();
  const maxX = document.width * 4;
  const maxY = document.height * 4;
  let maxId = 0;
  for (let index = 0; index < store.ids.length; index += 1) {
    const id = store.ids[index];
    const x1 = store.x1[index];
    const y1 = store.y1[index];
    const x2 = store.x2[index];
    const y2 = store.y2[index];
    const key = `${String(x1)},${String(y1)},${String(x2)},${String(y2)}`;
    if (id === 0 || id > UINT32_MAX || ids.has(id)) errors.push(`Backstitch ID ${String(id)} is invalid or duplicated.`);
    if (x1 > maxX || x2 > maxX || y1 > maxY || y2 > maxY) errors.push(`Backstitch ${String(id)} is outside the document boundary.`);
    if (x1 === x2 && y1 === y2) errors.push(`Backstitch ${String(id)} has identical endpoints.`);
    if (x1 > x2 || (x1 === x2 && y1 > y2)) errors.push(`Backstitch ${String(id)} endpoints are not canonical.`);
    if (segments.has(key)) errors.push(`Backstitch ${String(id)} duplicates another segment.`);
    if (!activePaletteIds.has(store.colors[index])) errors.push(`Backstitch ${String(id)} has an unknown palette ID.`);
    if (store.completed[index] > 1) errors.push(`Backstitch ${String(id)} has an invalid completion bit.`);
    ids.add(id);
    segments.add(key);
    maxId = Math.max(maxId, id);
  }
  if (!Number.isInteger(document.nextBackstitchId) || document.nextBackstitchId < 1 || document.nextBackstitchId > UINT32_MAX + 1) {
    errors.push('nextBackstitchId is invalid.');
  } else if (document.nextBackstitchId <= maxId) {
    errors.push('nextBackstitchId must be greater than every allocated backstitch ID.');
  }

  if (!Number.isInteger(document.revision) || document.revision < 0) errors.push('revision must be a non-negative integer.');
  return errors;
}

export function validateDocument(document: PatternDocument): boolean {
  return collectValidationErrors(document).length === 0;
}

export function getValidationResult(document: PatternDocument): ValidationResult {
  const errors = collectValidationErrors(document);
  return { valid: errors.length === 0, errors };
}

export function assertValidDocument(document: PatternDocument): void {
  const errors = collectValidationErrors(document);
  if (errors.length > 0) {
    throw new DomainError('invalid-document', errors.join(' '));
  }
}

export const validatePatternDocument = validateDocument;
export const assertDocumentValid = assertValidDocument;
export const isValidDocument = validateDocument;
export const validateInvariants = validateDocument;
export const assertInvariants = assertValidDocument;
