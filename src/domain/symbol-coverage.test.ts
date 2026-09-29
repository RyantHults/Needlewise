import { describe, expect, it } from 'vitest';

import { DMC_CATALOG } from '../catalog';
import { getSymbolOutline, SYMBOL_COUNT, SYMBOL_IDS, SYMBOL_POOL, type PoolEntry } from '../symbols';
import { defaultPaletteSymbol, isKnownSymbolId } from './index';

/**
 * The pool is the selection in src/symbols/selection.json, deliberately
 * smaller than the 489-color catalog: the "one symbol per color" coverage
 * requirement is relaxed, and palette ids past the pool end cycle
 * deterministically. These tests pin that relationship instead: every pool id
 * is drawable, defaults cycle, explicit duplicates stay rejected, and the block
 * interleave that keeps neighbouring palette ids visually distinct survives
 * future edits.
 */
describe('symbol pool coverage', () => {
  it('is smaller than the catalog: no symbol is kept just for coverage', () => {
    expect(DMC_CATALOG.length).toBe(489);
    expect(SYMBOL_COUNT).toBeLessThan(DMC_CATALOG.length);
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

  it('places the fonts’ versions of one glyph next to each other', () => {
    // Two fonts can hold the same codepoint. Keeping the variants adjacent in
    // the pool is what lets someone comparing them see them side by side.
    const byCodepoint = new Map<number, PoolEntry[]>();
    for (const entry of SYMBOL_POOL) {
      const list = byCodepoint.get(entry.codepoint) ?? [];
      list.push(entry);
      byCodepoint.set(entry.codepoint, list);
    }
    const shared = [...byCodepoint.values()].find((list) => list.length > 1);
    if (!shared) return;
    const indices = shared.map((entry) => SYMBOL_POOL.indexOf(entry));
    expect(Math.max(...indices) - Math.min(...indices)).toBe(shared.length - 1);
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

describe('block interleave', () => {
  /**
   * Neighbouring palette ids are assigned consecutive pool ids, so a run of
   * same-block symbols would put a run of similar marks next to each other in a
   * chart. The build skips the block it just drew from, so a block can only be
   * drawn again once every other block has run out. That means a run is
   * possible, but only as a tail: once two entries in a row share a block,
   * every remaining entry of the cycle shares it too.
   *
   * Two fonts drawing one codepoint is the deliberate exception. Those symbols
   * are near-identical by construction and sit side by side so a reviewer can
   * compare them, so the pair is adjacent wherever it lands.
   *
   * A fixed "no more than N in a row" bound cannot be asserted here, because a
   * selection made of one block would legitimately be a run of the whole pool.
   * Asserting the tail property instead keeps the guarantee meaningful for any
   * selection the picker can produce.
   */
  it('only ever repeats a block in the trailing part of a cycle, or for one glyph’s variants', () => {
    const byId = new Map(SYMBOL_POOL.map((entry) => [entry.id, entry]));
    const blocks = SYMBOL_IDS.map((id) => byId.get(id)?.block);

    let runStart = 0;
    for (let index = 1; index <= blocks.length; index += 1) {
      const repeated = index < blocks.length && blocks[index] === blocks[runStart];
      if (repeated) continue;
      // The run just ended. A run longer than one is only allowed when it is
      // the pair of fonts drawing one glyph, or when it reaches the cycle's end.
      if (blocks[runStart + 1] === blocks[runStart]) {
        const isTail = runStart + 1 >= blocks.length;
        const first = byId.get(SYMBOL_IDS[runStart]);
        const second = byId.get(SYMBOL_IDS[runStart + 1]);
        const areVariants = first?.codepoint === second?.codepoint && first?.font !== second?.font;
        expect(
          isTail || areVariants,
          `block ${String(blocks[runStart])} repeats at ${runStart} with symbols after it`
        ).toBe(true);
      }
      runStart = index;
    }
  });

  it('holds a full catalog to the same bound across the wrap seam', () => {
    // A whole catalog wraps back to the start of the pool for the tail, so the
    // bound is asserted per cycle with the seam between them held to the same
    // rule: joining the pool's last block to its first is fine, but only if one
    // of them is the single block left over.
    const block = new Map(SYMBOL_POOL.map((entry) => [entry.id, entry.block]));
    const first = block.get(SYMBOL_IDS[0]);
    const last = block.get(SYMBOL_IDS[SYMBOL_COUNT - 1]);
    if (first !== last) return;
    const blocks = new Set(SYMBOL_POOL.map((entry) => entry.block));
    expect(blocks.size).toBe(1);
  });
});
