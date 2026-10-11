import { describe, expect, it } from 'vitest';
import { finishedSizeLine, formatLength, formatSkeins, materialLine, materialYardage, number, pdfFilename, stitchSummary } from './material-format';

const material = (extra: Record<string, unknown> = {}) => ({ estimatedMeters: 1, estimatedSkeins: 0.12, ...extra }) as never;

describe('material formatting', () => {
  it('prints numbers without trailing zeros', () => {
    expect(number(3)).toBe('3');
    expect(number(0.5)).toBe('0.5');
    expect(number(1 / 3)).toBe('0.33');
  });

  it('reports skeins, collapsing identical ranges', () => {
    expect(materialLine(undefined)).toBe('Physical estimate unavailable');
    expect(materialLine({ estimatedMeters: undefined, estimatedSkeins: undefined } as never)).toBe('Physical estimate unavailable');
    expect(materialLine(material())).toBe('0.12 skeins');
    expect(materialLine(material({ estimateRange: { skeins: { min: 0, max: 0 } } }))).toBe('0 skeins');
    expect(materialLine(material({ estimateRange: { skeins: { min: 1, max: 2 } } }))).toBe('1–2 skeins');
  });

  it('reports yardage from meters', () => {
    expect(materialYardage(undefined)).toBeNull();
    expect(materialYardage(material({ estimatedMeters: undefined }))).toBeNull();
    expect(materialYardage(material())).toBe('1.09 yd');
    expect(materialYardage(material({ estimateRange: { meters: { min: 1, max: 2 } } }))).toBe('1.09–2.19 yd');
  });

  it('formats legend lengths and skeins', () => {
    expect(formatLength(undefined)).toBeNull();
    expect(formatLength({ unit: 'm', value: 2, min: 2, max: 2 })).toBe('2 m');
    expect(formatLength({ unit: 'yd', value: 2, min: 1, max: 3 })).toBe('1–3 yd');
    expect(formatSkeins(undefined)).toBe('Physical estimate unavailable');
    expect(formatSkeins({ min: 0.5, max: 1 })).toBe('0.5–1 skeins');
  });

  it('formats finished size in the display units', () => {
    const size = { widthInches: 1, heightInches: 0.5, widthCm: 2.54, heightCm: 1.27 };
    expect(finishedSizeLine(size, 'metric')).toBe('2.54 × 1.27 cm');
    expect(finishedSizeLine(size, 'imperial')).toBe('1 × 0.5 in');
    expect(finishedSizeLine(undefined, 'metric')).toBeNull();
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
