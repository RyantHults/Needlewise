import { describe, expect, it } from 'vitest';
import { parseSymbolFont, symbolFontForCell } from './symbol-font';

describe('parseSymbolFont', () => {
  it('returns the parts for an em-sized shorthand', () => {
    expect(parseSymbolFont('600 1em sans-serif')).toEqual({ weight: '600', fraction: 1, family: 'sans-serif' });
    expect(parseSymbolFont('600 0.75em sans-serif')).toEqual({ weight: '600', fraction: 0.75, family: 'sans-serif' });
    expect(parseSymbolFont('  600  0.5em  serif  ')).toEqual({ weight: '600', fraction: 0.5, family: 'serif' });
  });

  it('keeps a multi-word family intact', () => {
    expect(parseSymbolFont('400 1em Trebuchet MS')).toEqual({ weight: '400', fraction: 1, family: 'Trebuchet MS' });
  });

  it('returns undefined for non-em sizes', () => {
    expect(parseSymbolFont('600 14px serif')).toBeUndefined();
    expect(parseSymbolFont('12pt sans-serif')).toBeUndefined();
  });

  it('returns undefined for malformed input', () => {
    expect(parseSymbolFont('')).toBeUndefined();
    expect(parseSymbolFont('600 1em')).toBeUndefined();
    expect(parseSymbolFont('em without size')).toBeUndefined();
    expect(parseSymbolFont('600 abc sans-serif')).toBeUndefined();
    expect(parseSymbolFont('600 -1em sans-serif')).toBeUndefined();
  });
});

describe('symbolFontForCell', () => {
  it('resolves a 1em font to the full cell size', () => {
    expect(symbolFontForCell('600 1em sans-serif', 16)).toBe('600 16px sans-serif');
  });

  it('resolves fractional em values proportionally', () => {
    expect(symbolFontForCell('600 0.5em sans-serif', 16)).toBe('600 8px sans-serif');
    expect(symbolFontForCell('600 0.75em serif', 20)).toBe('600 15px serif');
  });

  it('rounds fractional pixel products', () => {
    expect(symbolFontForCell('600 0.5em sans-serif', 19)).toBe('600 10px sans-serif'); // 9.5
    expect(symbolFontForCell('600 0.75em sans-serif', 21)).toBe('600 16px sans-serif'); // 15.75
    expect(symbolFontForCell('600 1em sans-serif', 17)).toBe('600 17px sans-serif');
  });

  it('passes non-em and malformed input through unchanged', () => {
    expect(symbolFontForCell('600 14px serif', 16)).toBe('600 14px serif');
    expect(symbolFontForCell('12pt sans-serif', 16)).toBe('12pt sans-serif');
    expect(symbolFontForCell('garbage', 16)).toBe('garbage');
    expect(symbolFontForCell('', 16)).toBe('');
  });

  it('clamps a zero or negative cell size to 1px', () => {
    expect(symbolFontForCell('600 1em sans-serif', 0)).toBe('600 1px sans-serif');
    expect(symbolFontForCell('600 1em sans-serif', -8)).toBe('600 1px sans-serif');
    expect(symbolFontForCell('600 0.25em sans-serif', 0)).toBe('600 1px sans-serif');
  });
});