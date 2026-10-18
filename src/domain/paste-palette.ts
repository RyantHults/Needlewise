import { SYMBOL_IDS } from '../symbols';
import { paletteLimit } from './model';
import { clonePatternFragment } from './fragment';
import { DomainError, type PaletteEntry, type PaletteEntryInput, type PatternDocument, type PatternFragment } from './types';

export interface PastePalettePlan {
  /** source palette id -> target palette id, for every source entry. */
  readonly idMap: ReadonlyMap<number, number>;
  /** New target entries, explicit `id` ascending from target.nextPaletteId; explicit `symbol` unless every SYMBOL_IDS slug is used. */
  readonly creates: readonly PaletteEntryInput[];
}

/** Prefer the same palette id, then an active entry, then the first. */
function preferred(candidates: readonly PaletteEntry[], sourceId: number): PaletteEntry | undefined {
  return candidates.find((entry) => entry.id === sourceId) ?? candidates.find((entry) => entry.active) ?? candidates[0];
}

function findTargetMatch(target: PatternDocument, source: PaletteEntry): PaletteEntry | undefined {
  const ref = source.catalog;
  // A catalogued source matches on catalogId + code only, never on hex.
  if (ref !== undefined) return preferred(target.palette.filter((entry) => entry.catalog?.catalogId === ref.catalogId && entry.catalog.code === ref.code), source.id);
  const hex = source.color.toLowerCase();
  return preferred(target.palette.filter((entry) => entry.catalog === undefined && entry.color.toLowerCase() === hex), source.id);
}

export function planPastePalette(target: PatternDocument, source: readonly PaletteEntry[]): PastePalettePlan {
  const idMap = new Map<number, number>();
  const creates: PaletteEntryInput[] = [];
  const usedSymbols = new Set(target.palette.map((entry) => entry.symbol));
  const limit = paletteLimit(target);
  let nextId = target.nextPaletteId;
  for (const entry of [...source].sort((a, b) => a.id - b.id)) {
    const match = findTargetMatch(target, entry);
    if (match !== undefined) {
      idMap.set(entry.id, match.id);
      continue;
    }
    if (nextId > limit) throw new DomainError('palette-full', `The palette cannot exceed the brand's color count (${String(limit)}).`);
    const symbol = !usedSymbols.has(entry.symbol) ? entry.symbol : SYMBOL_IDS.find((slug) => !usedSymbols.has(slug));
    if (symbol !== undefined) usedSymbols.add(symbol);
    creates.push({
      id: nextId,
      name: entry.name,
      color: entry.color,
      material: entry.material,
      ...(entry.catalog === undefined ? {} : { catalog: entry.catalog }),
      ...(symbol === undefined ? {} : { symbol })
    });
    idMap.set(entry.id, nextId);
    nextId += 1;
  }
  return { idMap, creates };
}

export function remapFragmentColors(fragment: PatternFragment, idMap: ReadonlyMap<number, number>): PatternFragment {
  const result = clonePatternFragment(fragment);
  for (const colors of [result.colors, result.backstitches.colors]) {
    for (let index = 0; index < colors.length; index += 1) colors[index] = idMap.get(colors[index]) ?? colors[index];
  }
  return result;
}

export function fragmentPaletteIds(fragment: PatternFragment): number[] {
  const ids = new Set<number>();
  for (const colors of [fragment.colors, fragment.backstitches.colors]) for (const id of colors) if (id !== 0) ids.add(id);
  return [...ids].sort((a, b) => a - b);
}
