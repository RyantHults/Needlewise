import { describe, expect, it } from 'vitest';
import { contrastSymbolInk, relativeLuminance } from './contrast';

describe('contrastSymbolInk', () => {
  it('keeps the dark ink on light backgrounds', () => {
    expect(contrastSymbolInk('#ffffff', '#242424')).toBe('#242424');
    expect(contrastSymbolInk('#ffdddd', '#242424')).toBe('#242424');
    expect(contrastSymbolInk('#f0f0f0', '#242424')).toBe('#242424');
  });

  it('flips to white on dark backgrounds', () => {
    expect(contrastSymbolInk('#000000', '#242424')).toBe('#ffffff');
    expect(contrastSymbolInk('#223344', '#242424')).toBe('#ffffff');
    expect(contrastSymbolInk('#b40000', '#242424')).toBe('#ffffff');
  });

  it('flips at the WCAG crossover between consecutive mid-tone grays', () => {
    // #818181 is still slightly above the crossover (dark ink keeps its
    // ratio); #808080 dips below it and white becomes the higher-contrast ink.
    expect(contrastSymbolInk('#818181', '#242424')).toBe('#242424');
    expect(contrastSymbolInk('#808080', '#242424')).toBe('#ffffff');
  });

  it('resolves exact contrast ties toward the dark ink', () => {
    expect(contrastSymbolInk('#ffffff', '#ffffff')).toBe('#ffffff');
  });

  it('returns the dark ink for unparseable colors', () => {
    expect(contrastSymbolInk('not-a-color', '#242424')).toBe('#242424');
    // Only 6-digit hex is accepted; shorthand #f00 is not a valid palette color.
    expect(contrastSymbolInk('#f00', '#242424')).toBe('#242424');
    expect(contrastSymbolInk('#GGGGGG', '#242424')).toBe('#242424');
    expect(contrastSymbolInk('', '#242424')).toBe('#242424');
    // A broken dark ink falls back to itself too.
    expect(contrastSymbolInk('#ffffff', 'oops')).toBe('oops');
  });

  it('parses 6-digit hex case-insensitively', () => {
    expect(contrastSymbolInk('#FFFFFF', '#242424')).toBe('#242424');
    expect(contrastSymbolInk('#FFDDDD', '#242424')).toBe('#242424');
    expect(contrastSymbolInk('#B40000', '#242424')).toBe('#ffffff');
  });
});

describe('relativeLuminance', () => {
  it('computes standard WCAG relative luminance', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 4);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 4);
    expect(relativeLuminance('#242424')).toBeCloseTo(0.01764, 4);
    expect(relativeLuminance('#b40000')).toBeCloseTo(0.097, 3);
  });

  it('rejects anything that is not 6-digit hex', () => {
    expect(relativeLuminance('red')).toBeUndefined();
    expect(relativeLuminance('#f00')).toBeUndefined();
    expect(relativeLuminance('')).toBeUndefined();
  });
});