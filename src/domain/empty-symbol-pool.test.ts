import { describe, expect, it, vi } from 'vitest';

import type { CatalogAssociation } from './types';

/**
 * What a curated pool can be empty about.
 *
 * `selection.json` is authored by hand, so an empty pool is a state the
 * application has to be honest about rather than a broken install. A colour
 * cannot be given a symbol to draw, and the failure has to say which tool puts
 * one there, so these cases run against an empty pool whatever the committed
 * selection holds.
 */
vi.mock('../symbols', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../symbols')>();
  return { ...actual, SYMBOL_IDS: [] as string[], SYMBOL_COUNT: 0, SYMBOL_POOL: [] };
});

const { applyCommand, createDocument, defaultPaletteSymbol, DomainError, isKnownSymbolId } = await import('./index');

const CATALOG: CatalogAssociation = { catalogId: 'empty-pool-catalog', brandLabel: 'Empty Pool', colorCount: 8 };

const document = () => createDocument({ width: 1, height: 1, catalog: CATALOG });

describe('an empty symbol pool', () => {
  it('names the picker when a default symbol is asked for', () => {
    // The id-to-symbol map is the one place a default is chosen, and with
    // nothing to choose from it has to say where symbols come from rather than
    // hand back a value indexed into nothing.
    expect(() => defaultPaletteSymbol(1)).toThrow(DomainError);
    expect(() => defaultPaletteSymbol(1)).toThrow(/\/__symbols/);
    expect(() => defaultPaletteSymbol(1)).toThrow(/symbols:build/);
  });

  it('still rejects an invalid palette id as an invalid id', () => {
    // An empty pool says nothing about the id, so the id check stays the one
    // that reports itself.
    expect(() => defaultPaletteSymbol(0)).toThrow(/Palette ID 0 is invalid/);
  });

  it('refuses to create a color, and names the picker', () => {
    let message = '';
    try {
      applyCommand(document(), { type: 'palette-create', name: 'Ruby', color: '#b44' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/symbol pool is empty/i);
    expect(message).toMatch(/\/__symbols/);
  });

  it('refuses to restore a document whose palette entry has no symbol', () => {
    expect(() => createDocument({
      width: 1,
      height: 1,
      catalog: CATALOG,
      palette: [{ id: 1, name: 'Ruby', color: '#b44' }]
    })).toThrow(/\/__symbols/);
  });

  it('draws nothing, because no slug resolves', () => {
    expect(isKnownSymbolId('')).toBe(false);
    expect(isKnownSymbolId('libertinus-math--black-star')).toBe(false);
  });
});
