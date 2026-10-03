import { describe, expect, it } from 'vitest';

import { DMC_CATALOG } from '../catalog';
import committedOutlines from '../symbols/outlines.generated.json';
import { getSymbolOutline, SYMBOL_COUNT, SYMBOL_IDS, SYMBOL_POOL } from '../symbols';
import { defaultPaletteSymbol, isKnownSymbolId } from './index';

/**
 * The pool is the selection in src/symbols/selection.json, deliberately
 * smaller than the 489-color catalog: the "one symbol per color" coverage
 * requirement is relaxed, and palette ids past the pool end cycle
 * deterministically.
 *
 * Every property below is a property of a pool of glyphs, so these run against
 * the fixture pool the rest of the suite reads, not against the committed
 * selection: an empty or freshly curated pool would make them assert nothing.
 * Skipping them on an empty pool would hide the ordering and cycling rules
 * behind whatever happened to be selected, so instead the committed pool is
 * held to the one claim that survives it, that it does not have to cover the
 * catalog.
 */
describe('symbol pool coverage', () => {
  it('is smaller than the catalog: no symbol is kept just for coverage', () => {
    expect(DMC_CATALOG.length).toBe(489);
    expect(SYMBOL_COUNT).toBeLessThan(DMC_CATALOG.length);
  });

  it('leaves the committed pool smaller than the catalog too', () => {
    // The rule is about the curated selection, so it is stated against the
    // curated selection rather than the fixture. A pool with no glyphs in it
    // satisfies it; a pool grown past the catalog would not.
    expect(Object.keys(committedOutlines.symbols).length).toBeLessThan(DMC_CATALOG.length);
  });

  it('resolves every pool id to a drawable outline', () => {
    for (const id of SYMBOL_IDS) {
      const outline = getSymbolOutline(id);
      expect(outline, `${id} has no outline`).toBeDefined();
      expect(outline?.d.length, `${id} has empty path data`).toBeGreaterThan(0);
      expect(outline?.block, `${id} has no block`).toBeTruthy();
      expect(outline?.codepoint, `${id} has no codepoint`).toBeGreaterThan(0);
    }
  });

  it('has no duplicate ids', () => {
    expect(new Set(SYMBOL_IDS).size).toBe(SYMBOL_IDS.length);
    expect(SYMBOL_POOL.map((entry) => entry.id)).toEqual([...SYMBOL_IDS]);
  });

  it('draws each symbol from its own codepoint within its font', () => {
    // Two fonts can both draw U+2666, so a codepoint is unique only inside one
    // font. Across the pool the font-qualified id is what identifies a glyph.
    const seen = new Set<string>();
    const clashes: string[] = [];
    for (const entry of SYMBOL_POOL) {
      const key = `${entry.font} ${entry.codepoint}`;
      if (seen.has(key)) clashes.push(key);
      seen.add(key);
    }
    expect(clashes).toEqual([]);
  });

  it('accepts every pool id as a palette symbol', () => {
    for (const id of SYMBOL_IDS) expect(isKnownSymbolId(id)).toBe(true);
    expect(isKnownSymbolId('not-a-real-symbol')).toBe(false);
    expect(isKnownSymbolId('')).toBe(false);
  });
});

describe('cyclic default assignment', () => {
  it('covers the pool in order and cycles past the pool end', () => {
    // One cycle covers the whole pool in pool order; the catalog ceiling then
    // maps through one full cycle plus a partial second one.
    const oneCycle = DMC_CATALOG.slice(0, SYMBOL_COUNT).map((_, index) => defaultPaletteSymbol(index + 1));
    expect(oneCycle).toEqual(SYMBOL_IDS);
    for (let id = SYMBOL_COUNT + 1; id <= DMC_CATALOG.length; id += 1) {
      expect(defaultPaletteSymbol(id)).toBe(SYMBOL_IDS[(id - 1) % SYMBOL_COUNT]);
    }
  });

  it('assigns only symbols the pool can draw', () => {
    for (let id = 1; id <= DMC_CATALOG.length; id += 1) {
      expect(isKnownSymbolId(defaultPaletteSymbol(id))).toBe(true);
    }
  });

  it('is stable for a given id', () => {
    expect(defaultPaletteSymbol(7)).toBe(defaultPaletteSymbol(7));
  });

  it('cycles deterministically past the end of the pool', () => {
    // The relaxed requirement makes this the reaching path for palette ids past
    // the pool end rather than a safety tail.
    const overflow = SYMBOL_COUNT + 1;
    expect(defaultPaletteSymbol(overflow)).toBe(defaultPaletteSymbol(1));
  });
});
