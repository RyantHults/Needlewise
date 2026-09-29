import { describe, expect, it } from 'vitest';

import {
  SYMBOL_COUNT,
  SYMBOL_FONT,
  SYMBOL_IDS,
  SYMBOL_OUTLINES,
  SYMBOL_POOL,
  SYMBOL_POOL_VERSION,
  SYMBOL_TILE_VIEW,
  getSymbolOutline,
  toSymbolOutline
} from './index';

describe('symbol pool loader', () => {
  it('exposes a versioned pool', () => {
    expect(SYMBOL_POOL_VERSION).toBe(2);
    expect(SYMBOL_COUNT).toBe(SYMBOL_IDS.length);
    expect(SYMBOL_POOL).toHaveLength(SYMBOL_COUNT);
  });

  it('records the font the outlines were extracted from', () => {
    // Provenance is the only way to tell which font a committed outline came
    // from, since a slug on its own is just a name.
    expect(SYMBOL_FONT.family).toBe('Libertinus Math');
    expect(SYMBOL_FONT.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(SYMBOL_FONT.license).toBe('OFL-1.1');
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

  it('gives every symbol a unique name, because the name is the picker label', () => {
    const names = SYMBOL_POOL.map((entry) => entry.name);
    const counts = new Map<string, number>();
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
    const shared = [...counts].filter(([, count]) => count > 1).map(([name]) => name);
    expect(shared).toEqual([]);
  });

  it('carries each symbol id on its own pool entry', () => {
    for (const entry of SYMBOL_POOL) {
      expect(getSymbolOutline(entry.id)).toBeDefined();
      expect(SYMBOL_OUTLINES[entry.id].d).toBe(entry.d);
    }
  });

  it('uses the codepoint slug for a symbol with no readable Unicode name', () => {
    // Names like "space" and "quotation mark" are fine, but a character whose
    // Unicode name is only "<control>" has nothing to slugify, so the build
    // falls back to the codepoint. If the selection ever picks one up, the id
    // still has to be a valid, unique, addressable slug.
    for (const entry of SYMBOL_POOL) {
      expect(entry.id, entry.name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
    expect(SYMBOL_POOL.some((entry) => entry.id === 'space')).toBe(false);
  });
});
