import { describe, expect, it } from 'vitest';

import {
  SYMBOL_COUNT,
  SYMBOL_FONTS,
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
    expect(SYMBOL_POOL_VERSION).toBe(3);
    expect(SYMBOL_COUNT).toBe(SYMBOL_IDS.length);
    expect(SYMBOL_POOL).toHaveLength(SYMBOL_COUNT);
  });

  it('exposes the fonts the pool was drawn from', () => {
    // Provenance is the only way to tell which font a committed outline came
    // from, since a slug on its own is just a name.
    const slugs = Object.keys(SYMBOL_FONTS);
    expect(slugs.length).toBeGreaterThan(0);
    for (const slug of slugs) {
      const font = SYMBOL_FONTS[slug];
      expect(font.family.length).toBeGreaterThan(0);
      expect(font.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(font.licenseUrl).toMatch(/openfontlicense\.org|scripts\.sil\.org\/OFL/);
      expect(font.unitsPerEm).toBeGreaterThan(0);
    }
  });

  it('gives every pool entry a font that the artifact records', () => {
    for (const entry of SYMBOL_POOL) {
      expect(SYMBOL_FONTS[entry.font], entry.id).toBeDefined();
      expect(entry.family).toBe(SYMBOL_FONTS[entry.font].family);
    }
  });

  it('qualifies every id with the font it came from', () => {
    for (const entry of SYMBOL_POOL) {
      expect(entry.id.startsWith(`${entry.font}--`), entry.id).toBe(true);
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

  it('disambiguates a shared name with the font each variant came from', () => {
    const byName = new Map<string, typeof SYMBOL_POOL>();
    for (const entry of SYMBOL_POOL) {
      byName.set(entry.name, [...(byName.get(entry.name) ?? []), entry]);
    }
    const shared = [...byName.values()].filter((group) => group.length > 1);
    // The loop below is the only thing that fails when a shared name is gone, so
    // require the pool to still share one rather than assert over nothing.
    expect(shared.length).toBeGreaterThan(0);
    for (const group of shared) {
      expect(new Set(group.map((entry) => entry.font)).size).toBe(group.length);
    }
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
