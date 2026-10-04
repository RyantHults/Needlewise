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
    expect(contrastSymbolInk('#000', '#242424')).toBe('#ffffff');
    expect(contrastSymbolInk('#223344', '#242424')).toBe('#ffffff');
    expect(contrastSymbolInk('#b40000', '#242424')).toBe('#ffffff');
  });

  it('favors white ink up to 60% gray', () => {
    expect(contrastSymbolInk('#808080', '#242424')).toBe('#ffffff');
    expect(contrastSymbolInk('#8c8c8c', '#242424')).toBe('#ffffff');
    expect(contrastSymbolInk('#999999', '#242424')).toBe('#242424');
    expect(contrastSymbolInk('#a0a0a0', '#242424')).toBe('#242424');
  });

  it('keeps a custom dark ink at and above the threshold', () => {
    expect(contrastSymbolInk('#ffffff', '#ffffff')).toBe('#ffffff');
    expect(contrastSymbolInk('#ffffff', '#101010')).toBe('#101010');
    expect(contrastSymbolInk('#000000', '#101010')).toBe('#ffffff');
  });

  it('returns the dark ink for unparseable colors', () => {
    expect(contrastSymbolInk('not-a-color', '#242424')).toBe('#242424');
    expect(contrastSymbolInk('#GGGGGG', '#242424')).toBe('#242424');
    expect(contrastSymbolInk('#GGG', '#242424')).toBe('#242424');
    expect(contrastSymbolInk('garbage', '#242424')).toBe('#242424');
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
    expect(relativeLuminance('#fff')).toBeCloseTo(1, 4);
    expect(relativeLuminance('#000')).toBeCloseTo(0, 4);
    expect(relativeLuminance('#242424')).toBeCloseTo(0.01764, 4);
    expect(relativeLuminance('#b40000')).toBeCloseTo(0.097, 3);
  });

  it('rejects anything that is not 3- or 6-digit hex', () => {
    expect(relativeLuminance('red')).toBeUndefined();
    expect(relativeLuminance('#GGG')).toBeUndefined();
    expect(relativeLuminance('')).toBeUndefined();
  });
});
