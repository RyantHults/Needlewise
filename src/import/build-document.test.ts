import { describe, expect, it } from 'vitest';
import { getDmcColor } from '../catalog';
import { CellKind } from '../domain/types';
import { MAX_PERSISTABLE_CELL_COUNT } from '../domain/types';
import { assertValidDocument } from '../domain/validation';
import { SYMBOL_IDS, SYMBOL_POOL } from '../symbols';
import { assignSymbolSlugs, buildImportedDocument, maxImportColors, nearestPoolOutline, proposeMappings } from './build-document';
import { normalizeSvgPath } from './pdf/outline';
import { ImportError, type ImportedChart, type ImportedKeyEntry, type ImportedSymbol } from './types';

const noOutlineMatch = () => undefined;

function symbol(key: string, extra: Partial<ImportedSymbol> = {}): ImportedSymbol {
  return { key, outlineD: 'M0 0L1 0L1 1Z', count: 1, ...extra };
}

function chartOf(symbols: ImportedSymbol[], key: ImportedKeyEntry[], cells: number[], width = 2): ImportedChart {
  return { width, height: cells.length / width, cells: Uint16Array.from(cells), symbols, key, warnings: [] };
}

describe('proposeMappings', () => {
  it('matches a DMC key code', () => {
    const chart = chartOf([symbol('a')], [{ symbolKey: 'a', brand: 'DMC', code: '310' }], [1, 0]);
    expect(proposeMappings(chart)).toEqual([{ symbolKey: 'a', catalogCode: getDmcColor('310')!.code, status: 'matched' }]);
  });

  it('treats a missing brand as DMC and resolves aliases', () => {
    const chart = chartOf([symbol('a')], [{ symbolKey: 'a', code: 'White' }], [1, 0]);
    expect(proposeMappings(chart)[0]).toMatchObject({ status: 'matched', catalogCode: getDmcColor('White')!.code });
  });

  it('guesses from the fill color when the code does not resolve', () => {
    const chart = chartOf([symbol('a', { fillColor: '#000000' })], [{ symbolKey: 'a', brand: 'DMC', code: '99999' }], [1, 0]);
    const [proposal] = proposeMappings(chart);
    expect(proposal.status).toBe('guessed');
    expect(proposal.catalogCode).toBeDefined();
    expect(proposal.color).toBe('#000000');
    expect(proposal.reason).toContain('99999');
  });

  it('guesses from the key swatch when there is no fill', () => {
    const chart = chartOf([symbol('a')], [{ symbolKey: 'a', code: 'zzz', color: '#ff0000' }], [1, 0]);
    expect(proposeMappings(chart)[0]).toMatchObject({ status: 'guessed', color: '#ff0000' });
  });

  it('does not map Anchor codes through the DMC catalog', () => {
    const chart = chartOf([symbol('a', { fillColor: '#ffffff' }), symbol('b')], [
      { symbolKey: 'a', brand: 'ANCHOR', code: '310' },
      { symbolKey: 'b', brand: 'ANCHOR', code: '403' }
    ], [1, 2]);
    const [a, b] = proposeMappings(chart);
    expect(a.status).toBe('guessed');
    expect(a.reason).toContain('ANCHOR');
    expect(b).toMatchObject({ status: 'unmapped' });
    expect(b.catalogCode).toBeUndefined();
  });

  it('guesses a blend from its color and leaves it unmapped without one', () => {
    const chart = chartOf([symbol('a', { fillColor: '#222222' }), symbol('b')], [
      { symbolKey: 'a', code: '310', blendCodes: ['310', '413'] },
      { symbolKey: 'b', code: '310', blendCodes: ['310', '413'] }
    ], [1, 2]);
    const [a, b] = proposeMappings(chart);
    expect(a.status).toBe('guessed');
    expect(a.reason).toContain('310+413');
    expect(b.status).toBe('unmapped');
  });

  it('flags symbols missing from the key', () => {
    const chart = chartOf([symbol('a', { fillColor: '#123456' }), symbol('b')], [], [1, 2]);
    const [a, b] = proposeMappings(chart);
    expect(a).toMatchObject({ status: 'guessed', color: '#123456' });
    expect(a.reason).toContain('missing from the key');
    expect(b.status).toBe('unmapped');
  });
});

describe('nearestPoolOutline', () => {
  const a = { id: 'a', d: 'M-0.5 -0.5L0.5 -0.5L0.5 0.5Z' };
  const b = { id: 'b', d: 'M-0.5 -0.5L0.5 0.5L-0.5 0.5Z' };
  const fake = (distances: Record<string, number>) => (_: string, normalized: string) =>
    distances[normalized] ?? Number.POSITIVE_INFINITY;
  const byPath = (x: number, y: number) => ({ [normalizeSvgPath(a.d)]: x, [normalizeSvgPath(b.d)]: y });

  it('picks the nearest candidate, not the first under the cap', () => {
    expect(nearestPoolOutline('x', [b, a], fake(byPath(0.015, 0.018)))).toBe('a');
    expect(nearestPoolOutline('x', [a, b], fake(byPath(0.018, 0.015)))).toBe('b');
  });

  it('rejects candidates over the cap', () => {
    expect(nearestPoolOutline('x', [a, b], fake(byPath(0.021, 0.03)))).toBeUndefined();
  });
});

describe('assignSymbolSlugs', () => {
  it('prefers an outline match', () => {
    const target = SYMBOL_POOL[3].id;
    const chart = chartOf([symbol('a'), symbol('b')], [], [1, 2]);
    const slugs = assignSymbolSlugs(chart, [], {
      matchOutline: (d, candidates) => (d === chart.symbols[1].outlineD && candidates.some((c) => c.id === target) ? target : undefined)
    });
    expect(slugs.get('a')).toBe(target);
  });

  it('falls back to the codepoint, skipping slugs already taken', () => {
    const shared = SYMBOL_POOL.filter((entry) => entry.codepoint === 0x2666);
    expect(shared.length).toBeGreaterThan(1);
    const chart = chartOf([symbol('a', { unicode: '♦' }), symbol('b', { unicode: '♦' })], [], [1, 2]);
    const slugs = assignSymbolSlugs(chart, [], { matchOutline: noOutlineMatch });
    expect(slugs.get('a')).toBe(shared[0].id);
    expect(slugs.get('b')).toBe(shared[1].id);
  });

  it('uses palette default order otherwise and keeps every slug unique', () => {
    const symbols = SYMBOL_IDS.map((_, i) => symbol(`s${i}`, i === 0 ? { unicode: '♦' } : {}));
    const chart = chartOf(symbols, [], symbols.map((_, i) => i + 1), symbols.length);
    const slugs = assignSymbolSlugs(chart, [], { matchOutline: noOutlineMatch });
    expect(new Set(slugs.values()).size).toBe(SYMBOL_IDS.length);
    expect(slugs.get('s1')).toBe(SYMBOL_IDS[1] === slugs.get('s0') ? SYMBOL_IDS[2] : SYMBOL_IDS[1]);
  });

  it('honors an explicit slug and keeps automatic picks off it', () => {
    const chart = chartOf([symbol('a'), symbol('b')], [], [1, 2]);
    const slugs = assignSymbolSlugs(chart, [{ symbolKey: 'b', symbolSlug: SYMBOL_IDS[0] }], { matchOutline: noOutlineMatch });
    expect(slugs.get('b')).toBe(SYMBOL_IDS[0]);
    expect(slugs.get('a')).not.toBe(SYMBOL_IDS[0]);
  });
});

describe('buildImportedDocument', () => {
  const options = { matchOutline: noOutlineMatch, aidaCount: 18 };

  it('builds a valid document with the right cells and palette', () => {
    const chart = chartOf(
      [symbol('a', { unicode: '★' }), symbol('b')],
      [{ symbolKey: 'a', code: '310' }, { symbolKey: 'b', name: 'Sky' }],
      [1, 0, 2, 1, 0, 0],
      3
    );
    const document = buildImportedDocument(chart, [
      { symbolKey: 'a', catalogCode: '310' },
      { symbolKey: 'b', color: '#336699' }
    ], options);
    expect(() => assertValidDocument(document)).not.toThrow();
    expect([document.width, document.height]).toEqual([3, 2]);
    expect(document.settings.aidaCount).toBe(18);
    expect(Array.from(document.kind)).toEqual([1, 0, 1, 1, 0, 0].map((v) => (v ? CellKind.Full : CellKind.Empty)));
    expect([0, 2, 3].map((i) => document.colors[i * 4])).toEqual([1, 2, 1]);
    const dmc = getDmcColor('310')!;
    expect(document.palette.map((p) => p.id)).toEqual([1, 2]);
    expect(document.palette[0]).toMatchObject({ name: dmc.name, color: dmc.hex, catalog: { code: dmc.code } });
    expect(document.palette[1]).toMatchObject({ name: 'Sky', color: '#336699' });
    expect(document.palette[1].catalog).toBeUndefined();
    expect(document.palette[0].symbol).not.toBe(document.palette[1].symbol);
  });

  it('lets a resolvable code win over a color', () => {
    const chart = chartOf([symbol('a')], [], [1, 0]);
    const document = buildImportedDocument(chart, [{ symbolKey: 'a', catalogCode: '310', color: '#ffffff' }], options);
    expect(document.palette[0].catalog?.code).toBe(getDmcColor('310')!.code);
  });

  it('throws unmapped-symbols when a symbol has neither code nor color', () => {
    const chart = chartOf([symbol('a'), symbol('b')], [], [1, 2]);
    const run = () => buildImportedDocument(chart, [{ symbolKey: 'a', catalogCode: '310' }, { symbolKey: 'b', catalogCode: 'nope' }], options);
    expect(run).toThrow(ImportError);
    try {
      run();
    } catch (error) {
      expect((error as ImportError).code).toBe('unmapped-symbols');
    }
  });

  it('throws too-large before allocating when the cell count is over the limit', () => {
    const chart: ImportedChart = {
      width: MAX_PERSISTABLE_CELL_COUNT,
      height: 2,
      cells: new Uint16Array(0),
      symbols: [],
      key: [],
      warnings: []
    };
    try {
      buildImportedDocument(chart, [], options);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ImportError);
      expect((error as ImportError).code).toBe('too-large');
    }
  });

  it('throws too-many-colors, naming both counts, when symbols exceed the catalog cap', () => {
    const cap = maxImportColors();
    const symbols = Array.from({ length: cap + 1 }, (_, i) => symbol(`s${i}`));
    const chart = chartOf(symbols, [], symbols.map((_, i) => i + 1), symbols.length);
    try {
      buildImportedDocument(chart, [], options);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ImportError);
      expect((error as ImportError).code).toBe('too-many-colors');
      expect((error as ImportError).message).toContain(String(cap + 1));
      expect((error as ImportError).message).toContain(String(cap));
    }
  });
});
