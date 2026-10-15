import { describe, expect, it } from 'vitest';
import type { ImportColor } from '../types';
import { readKeyPage } from './key';
import type { PdfFillRect, PdfMark, PdfPagePrimitives, PdfTextRun } from './types';

const CHAR = 5;
const SIZE = 9;

interface Parts {
  marks: PdfMark[];
  text: PdfTextRun[];
  fills: PdfFillRect[];
}

const blank = (): Parts => ({ marks: [], text: [], fills: [] });

/** Label text: one run plus a glyph mark per character, keyed by the letter (the label font). */
function label(parts: Parts, value: string, x: number, top: number): void {
  parts.text.push({ text: value, bounds: { x, y: top, width: value.length * CHAR, height: SIZE }, fontSize: SIZE });
  [...value].forEach((char, i) => {
    if (char === ' ') return;
    parts.marks.push({
      kind: 'glyph',
      bounds: { x: x + i * CHAR, y: top, width: CHAR, height: SIZE },
      symbolKey: `label:${char}`,
      outlineD: '',
      unicode: char,
      color: '#000000'
    });
  });
}

function symbol(parts: Parts, key: string, x: number, top: number, kind: PdfMark['kind'] = 'path', asText?: string): void {
  parts.marks.push({ kind, bounds: { x, y: top, width: 10, height: 10 }, symbolKey: key, outlineD: 'M0 0Z', color: '#000000' });
  if (asText) parts.text.push({ text: asText, bounds: { x, y: top, width: 10, height: 10 }, fontSize: 10 });
}

function swatch(parts: Parts, x: number, top: number, color: ImportColor): void {
  parts.fills.push({ bounds: { x, y: top, width: 14, height: 14 }, color });
}

function page(parts: Parts): PdfPagePrimitives {
  return { pageIndex: 0, width: 612, height: 792, ...parts, strokes: [], imageCoverage: 0 };
}

describe('readKeyPage', () => {
  it('returns [] for a page without key rows', () => {
    const parts = blank();
    label(parts, 'Thread legend', 40, 40);
    label(parts, 'Page 2 of 4', 40, 700);
    expect(readKeyPage(page(parts))).toEqual([]);
  });

  it('reads symbol, code, name and swatch under a Symbol / DMC / Name header', () => {
    const parts = blank();
    label(parts, 'Symbol', 40, 40);
    label(parts, 'DMC', 90, 40);
    label(parts, 'Name', 140, 40);
    label(parts, 'Stitches', 260, 40);
    swatch(parts, 40, 58, '#111111');
    symbol(parts, 'sym:a', 42, 60);
    label(parts, '310', 90, 60);
    label(parts, 'Black', 140, 60);
    label(parts, '120', 260, 60);
    swatch(parts, 40, 78, '#ffffff');
    symbol(parts, 'sym:b', 42, 80);
    label(parts, 'B5200', 90, 80);
    label(parts, 'Snow White', 140, 80);
    label(parts, '8', 260, 80);
    label(parts, 'Total', 140, 100);
    label(parts, '128', 260, 100);

    expect(readKeyPage(page(parts))).toEqual([
      { symbolKey: 'sym:a', brand: 'DMC', code: '310', name: 'Black', color: '#111111' },
      { symbolKey: 'sym:b', brand: 'DMC', code: 'B5200', name: 'Snow White', color: '#ffffff' }
    ]);
  });

  it('defaults to DMC without headers and takes the leftmost non-label mark', () => {
    const parts = blank();
    symbol(parts, 'sym:a', 40, 60, 'glyph', '\u0003');
    label(parts, '3865', 60, 60);
    label(parts, 'Winter White', 90, 60);
    label(parts, '42', 200, 60);
    symbol(parts, 'sym:b', 40, 80, 'glyph', '\u0004');
    label(parts, 'Ecru', 60, 80);
    expect(readKeyPage(page(parts))).toEqual([
      { symbolKey: 'sym:a', brand: 'DMC', code: '3865', name: 'Winter White' },
      { symbolKey: 'sym:b', brand: 'DMC', code: 'Ecru' }
    ]);
  });

  it('never makes a letter inside a word a symbol outside a Symbol column', () => {
    const parts = blank();
    label(parts, 'Total 310', 40, 60);
    label(parts, 'Mix', 90, 60);
    expect(readKeyPage(page(parts))).toEqual([]);
  });

  it('accepts a label-font letter symbol whose letter also appears in names, with no header', () => {
    const parts = blank();
    label(parts, 'X', 40, 60);
    label(parts, '321', 60, 60);
    label(parts, 'Xmas Red', 90, 60);
    label(parts, 'S', 40, 80);
    label(parts, '3865', 60, 80);
    label(parts, 'Snow White', 90, 80);
    expect(readKeyPage(page(parts))).toEqual([
      { symbolKey: 'label:X', brand: 'DMC', code: '321', name: 'Xmas Red' },
      { symbolKey: 'label:S', brand: 'DMC', code: '3865', name: 'Snow White' }
    ]);
  });

  it('accepts a label-font letter that sits in a Symbol column', () => {
    const parts = blank();
    label(parts, 'Symbol', 40, 40);
    label(parts, 'DMC', 90, 40);
    label(parts, 'A', 42, 60);
    label(parts, '310', 90, 60);
    expect(readKeyPage(page(parts))).toEqual([{ symbolKey: 'label:A', brand: 'DMC', code: '310' }]);
  });

  it('reads codes under an Anchor header as Anchor', () => {
    const parts = blank();
    label(parts, 'Symbol', 40, 40);
    label(parts, 'Anchor', 90, 40);
    label(parts, 'Name', 140, 40);
    symbol(parts, 'sym:a', 42, 60);
    label(parts, '403', 90, 60);
    label(parts, 'Black', 140, 60);
    expect(readKeyPage(page(parts))).toEqual([{ symbolKey: 'sym:a', brand: 'ANCHOR', code: '403', name: 'Black' }]);
  });

  it('prefers the DMC column when a key prints DMC and Anchor', () => {
    const parts = blank();
    label(parts, 'Symbol', 40, 40);
    label(parts, 'Anchor', 90, 40);
    label(parts, 'DMC', 140, 40);
    symbol(parts, 'sym:a', 42, 60);
    label(parts, '403', 90, 60);
    label(parts, '310', 140, 60);
    expect(readKeyPage(page(parts))).toEqual([{ symbolKey: 'sym:a', brand: 'DMC', code: '310' }]);
  });

  it('names a non-DMC brand only mentioned on the page', () => {
    const parts = blank();
    label(parts, 'Madeira threads', 40, 20);
    symbol(parts, 'sym:a', 40, 60);
    label(parts, '2400', 60, 60);
    expect(readKeyPage(page(parts))).toEqual([{ symbolKey: 'sym:a', brand: 'MADEIRA', code: '2400' }]);
  });

  it('records blends with + and /', () => {
    const parts = blank();
    symbol(parts, 'sym:a', 40, 60);
    label(parts, '310+413', 60, 60);
    label(parts, 'Blend', 110, 60);
    symbol(parts, 'sym:b', 40, 80);
    label(parts, '3865/B5200', 60, 80);
    expect(readKeyPage(page(parts))).toEqual([
      { symbolKey: 'sym:a', brand: 'DMC', code: '310', name: 'Blend', blendCodes: ['310', '413'] },
      { symbolKey: 'sym:b', brand: 'DMC', code: '3865', blendCodes: ['3865', 'B5200'] }
    ]);
  });

  it('reads side-by-side key tables that repeat their header', () => {
    const parts = blank();
    for (const left of [40, 300]) {
      label(parts, 'Symbol', left, 40);
      label(parts, 'DMC', left + 50, 40);
      label(parts, 'Name', left + 100, 40);
    }
    symbol(parts, 'sym:a', 42, 60);
    label(parts, '310', 90, 60);
    label(parts, 'Black', 140, 60);
    symbol(parts, 'sym:b', 302, 60);
    label(parts, '666', 350, 60);
    label(parts, 'Red', 400, 60);
    expect(readKeyPage(page(parts))).toEqual([
      { symbolKey: 'sym:a', brand: 'DMC', code: '310', name: 'Black' },
      { symbolKey: 'sym:b', brand: 'DMC', code: '666', name: 'Red' }
    ]);
  });

  it('ignores marks, text and fills inside excluded rects', () => {
    const parts = blank();
    symbol(parts, 'cell', 40, 60);
    label(parts, '12', 60, 60);
    symbol(parts, 'sym:a', 40, 300);
    label(parts, '310', 60, 300);
    expect(readKeyPage(page(parts), [{ x: 30, y: 50, width: 100, height: 100 }])).toEqual([
      { symbolKey: 'sym:a', brand: 'DMC', code: '310' }
    ]);
  });

  it('keeps the first row of a symbol listed twice', () => {
    const parts = blank();
    symbol(parts, 'sym:a', 40, 60);
    label(parts, '310', 60, 60);
    symbol(parts, 'sym:a', 40, 80);
    label(parts, '415', 60, 80);
    expect(readKeyPage(page(parts))).toEqual([{ symbolKey: 'sym:a', brand: 'DMC', code: '310' }]);
  });
});
