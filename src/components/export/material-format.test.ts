import { describe, expect, it } from 'vitest';
import { formatLength, formatSkeins, pdfFilename, stitchSummary } from './material-format';

describe('material formatting', () => {
  it('formats legend lengths and skeins', () => {
    expect(formatLength(undefined)).toBeNull();
    expect(formatLength({ unit: 'm', value: 2, min: 2, max: 2 })).toBe('2 m');
    expect(formatLength({ unit: 'yd', value: 2, min: 1, max: 3 })).toBe('1–3 yd');
    expect(formatSkeins(undefined)).toBe('Physical estimate unavailable');
    expect(formatSkeins({ min: 0.5, max: 1 })).toBe('0.5–1 skeins');
  });

  it('summarizes stitch counts', () => {
    expect(stitchSummary({ full: 2, half: 0, quarter: 1, threeQuarter: 3, backstitch: 4 })).toBe('2 full · 3 3/4 · 1 quarter · 4 backstitch');
    expect(stitchSummary({ full: 0, half: 0, quarter: 0, backstitch: 0 })).toBe('No stitches');
  });

  it('sanitizes the PDF filename', () => {
    expect(pdfFilename('My Quilt: v2/final')).toBe('My Quilt- v2-final.pdf');
    expect(pdfFilename('  ...  ')).toBe('pattern.pdf');
    expect(pdfFilename('Größe')).toBe('Größe.pdf');
  });
});
