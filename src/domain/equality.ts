import type { PaletteCatalogReference, PaletteEntry, PaletteMaterial, PatternSettings } from './types';

/** Element-wise equality; the same array is equal to itself without a scan. */
export function typedArraysEqual(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

export function settingsEqual(left: PatternSettings, right: PatternSettings): boolean {
  return left.symbolSet === right.symbolSet
    && left.materialUnit === right.materialUnit
    && left.backgroundColor === right.backgroundColor
    && left.aidaCount === right.aidaCount;
}

/** Two absent references are equal; one absent reference is not. */
export function catalogReferencesEqual(left: PaletteCatalogReference | undefined, right: PaletteCatalogReference | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.catalogId === right.catalogId
    && left.sourceId === right.sourceId
    && left.code === right.code
    && left.name === right.name
    && left.hex === right.hex
    && left.rgb[0] === right.rgb[0]
    && left.rgb[1] === right.rgb[1]
    && left.rgb[2] === right.rgb[2];
}

function materialsEqual(left: PaletteMaterial, right: PaletteMaterial): boolean {
  return left.kind === right.kind
    && left.label === right.label
    && left.unit === right.unit
    && left.amount === right.amount;
}

export function palettesEqual(left: readonly PaletteEntry[], right: readonly PaletteEntry[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    return entry.id === other.id
      && entry.name === other.name
      && entry.color === other.color
      && entry.active === other.active
      && entry.symbol === other.symbol
      && materialsEqual(entry.material, other.material)
      && catalogReferencesEqual(entry.catalog, other.catalog);
  });
}
