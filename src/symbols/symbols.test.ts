import { describe, expect, it } from 'vitest';

import {
  SYMBOL_FONTS,
  SYMBOL_IDS,
  SYMBOL_OUTLINES,
  SYMBOL_POOL,
  SYMBOL_POOL_VERSION,
  SYMBOL_TILE_VIEW,
  getSymbolOutline,
  toSymbolOutline
} from './index';

/**
 * What the loader does with the artifact it is handed.
 *
 * Test mode swaps `./pool-asset` for the committed fixture pool, so the pool
 * these cases read is fixed and the first case below pins that it is not empty:
 * every remaining case loops over it, and a loop over nothing would pass in
 * silence.
 */
describe('symbol pool loader', () => {
  it('reads a non-empty pool, so the invariants below are not vacuous', () => {
    expect(SYMBOL_IDS.length).toBeGreaterThan(0);
    expect(Object.keys(SYMBOL_FONTS).length).toBeGreaterThan(0);
  });

  it('exposes a versioned pool', () => {
    expect(SYMBOL_POOL_VERSION).toBe(3);
    expect(SYMBOL_POOL).toHaveLength(SYMBOL_IDS.length);
  });

  it('gives every pool entry a font that the artifact records', () => {
    for (const entry of SYMBOL_POOL) {
      expect(SYMBOL_FONTS[entry.font], entry.id).toBeDefined();
      expect(entry.family).toBe(SYMBOL_FONTS[entry.font].family);
    }
  });

  it('looks a symbol up by slug', () => {
    const first = SYMBOL_IDS[0];
    expect(getSymbolOutline(first)).toBe(SYMBOL_OUTLINES[first]);
    expect(getSymbolOutline(first)?.d.length).toBeGreaterThan(0);
  });

  it('returns undefined for a slug that is not in the pool', () => {
    expect(getSymbolOutline('not-a-symbol')).toBeUndefined();
    expect(toSymbolOutline('not-a-symbol')).toBeUndefined();
  });

  it('hands the painter a usable outline', () => {
    const outline = toSymbolOutline(SYMBOL_IDS[0]);
    expect(outline?.d.startsWith('M')).toBe(true);
  });

  it('holds only path data the painter can consume', () => {
    for (const id of SYMBOL_IDS) {
      const entry = getSymbolOutline(id);
      expect(entry, id).toBeDefined();
      expect(entry?.d, id).toMatch(/^[MLCQZ0-9.\-\s]+$/);
      expect(entry?.name, id).toBeTruthy();
      expect(entry?.block, id).toBeTruthy();
      expect(entry?.codepoint, id).toBeGreaterThan(0);
    }
  });

  it('keeps every outline inside the picker tile viewport', () => {
    // A tile shows a window centred on the origin; the farthest ink of any
    // outline must stay inside it or the largest marks get cropped. Outlines
    // are normalized to the pool's target extent, and the build emits the tile
    // window beside them, so this is really a check that the two agree.
    for (const id of SYMBOL_IDS) {
      const numbers = SYMBOL_OUTLINES[id].d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/g)?.map(Number) ?? [];
      const farthest = Math.max(...numbers.map((value) => Math.abs(value)));
      expect(farthest, `${id} is cropped by the tile viewport`).toBeLessThanOrEqual(SYMBOL_TILE_VIEW);
    }
  });

  it('gives every symbol a unique name within its font, because the name is the picker label', () => {
    // Two fonts can both draw U+2666, so a bare Unicode name is not unique
    // across the pool. It is unique within one font, which is what lets a
    // picker label a variant as "black diamond suit" plus the font it came from.
    const byFont = new Map<string, Set<string>>();
    const clashes: string[] = [];
    for (const entry of SYMBOL_POOL) {
      const names = byFont.get(entry.font) ?? new Set<string>();
      if (names.has(entry.name)) clashes.push(`${entry.font}: ${entry.name}`);
      names.add(entry.name);
      byFont.set(entry.font, names);
    }
    expect(clashes).toEqual([]);
  });

  it('uses the codepoint slug for a symbol with no readable Unicode name', () => {
    // Names like "space" and "quotation mark" are fine, but a character whose
    // Unicode name is only "<control>" has nothing to slugify, so the build
    // falls back to the codepoint. If the selection ever picks one up, the id
    // still has to be a valid, unique, addressable slug.
    for (const entry of SYMBOL_POOL) {
      expect(entry.id, entry.name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });
});
