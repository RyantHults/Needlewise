import { describe, expect, it } from 'vitest';

import { SYMBOL_IDS } from '../symbols';
import {
  CellKind,
  createDocument,
  createPatternFragment,
  fragmentPaletteIds,
  normalizePaletteEntry,
  planPastePalette,
  remapFragmentColors,
  type PaletteCatalogReference,
  type PaletteEntry,
  type PaletteEntryInput
} from './index';

const dmc = (code: string, hex: string): PaletteCatalogReference => {
  const rgb = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
  return { catalogId: 'dmc', sourceId: `dmc-${code}`, code, name: `DMC ${code}`, hex, rgb };
};

const doc = (palette: PaletteEntryInput[], colorCount = 20) => createDocument({ width: 4, height: 4, catalog: { catalogId: 'dmc', brandLabel: 'DMC', colorCount }, palette });
const entry = (input: PaletteEntryInput): PaletteEntry => normalizePaletteEntry(input);

// The test-mode pool is the small fixture, so symbols are taken from it rather than assumed.
const [S0, S1, S2] = SYMBOL_IDS;

describe('planPastePalette', () => {
  it('matches by DMC code even when the hex differs', () => {
    const target = doc([{ name: 'Red', color: '#111111', symbol: S0, catalog: dmc('321', '#111111') }]);
    const plan = planPastePalette(target, [entry({ id: 5, name: 'Red', color: '#FF0000', symbol: S1, catalog: dmc('321', '#FF0000') })]);
    expect(plan.idMap.get(5)).toBe(1);
    expect(plan.creates).toEqual([]);
  });

  it('does not match a catalogued source by hex alone', () => {
    const target = doc([
      { name: 'Custom', color: '#FF0000', symbol: S0 },
      { name: 'Other', color: '#FF0000', symbol: S1, catalog: dmc('666', '#FF0000') }
    ]);
    const plan = planPastePalette(target, [entry({ id: 1, name: 'Red', color: '#FF0000', symbol: S2, catalog: dmc('321', '#FF0000') })]);
    expect(plan.creates).toHaveLength(1);
    expect(plan.idMap.get(1)).toBe(3);
  });

  it('matches a custom source by case-insensitive hex, uncatalogued targets only', () => {
    const target = doc([
      { name: 'Catalogued', color: '#abcdef', symbol: S0, catalog: dmc('1', '#ABCDEF') },
      { name: 'Custom', color: '#ABCDEF', symbol: S1 }
    ]);
    const plan = planPastePalette(target, [entry({ id: 7, name: 'Mine', color: '#abcdef', symbol: S2 })]);
    expect(plan.idMap.get(7)).toBe(2);
    expect(plan.creates).toEqual([]);
  });

  it('prefers the same palette id, then an active entry', () => {
    const target = doc([
      { name: 'A', color: '#111111', symbol: S0, active: false, catalog: dmc('321', '#111111') },
      { name: 'B', color: '#111111', symbol: S1, catalog: dmc('321', '#111111') },
      { name: 'C', color: '#111111', symbol: S2, catalog: dmc('321', '#111111') }
    ]);
    const source = (id: number) => entry({ id, name: 'R', color: '#111111', symbol: S0, catalog: dmc('321', '#111111') });
    expect(planPastePalette(target, [source(3)]).idMap.get(3)).toBe(3);
    expect(planPastePalette(target, [source(9)]).idMap.get(9)).toBe(2);
  });

  it('creates unmatched entries with ascending ids, copying fields and reusing a free symbol', () => {
    const target = doc([{ name: 'Other', color: '#222222', symbol: S1 }]);
    const source = [
      entry({ id: 4, name: 'Blue', color: '#0000FF', symbol: S0, catalog: dmc('797', '#0000FF') }),
      entry({ id: 2, name: 'Mine', color: '#123456', symbol: S1 })
    ];
    const plan = planPastePalette(target, source);
    expect(plan.creates.map((create) => create.id)).toEqual([2, 3]);
    expect(plan.idMap.get(2)).toBe(2);
    expect(plan.idMap.get(4)).toBe(3);
    expect(plan.creates[1]).toMatchObject({ name: 'Blue', color: '#0000FF', catalog: source[0].catalog, material: source[0].material });
    // Mine wants S1, taken by the target, so it falls back to the first free slug (S0); Blue then wants S0 and falls back to the next.
    expect(plan.creates[0].symbol).toBe(S0);
    expect(plan.creates[1].symbol).toBe(S2);
  });

  it('keeps the source symbol when the target does not use it', () => {
    const plan = planPastePalette(doc([{ name: 'Other', color: '#222222', symbol: S1 }]), [entry({ id: 1, name: 'Blue', color: '#0000FF', symbol: S2 })]);
    expect(plan.creates[0].symbol).toBe(S2);
  });

  it('counts symbols taken by earlier creates', () => {
    const target = doc([]);
    const plan = planPastePalette(target, [entry({ id: 1, name: 'A', color: '#010101', symbol: S0 }), entry({ id: 2, name: 'B', color: '#020202', symbol: S0 })]);
    expect(plan.creates[0].symbol).toBe(S0);
    expect(plan.creates[1].symbol).toBe(SYMBOL_IDS.find((slug) => slug !== S0));
  });

  it('omits the symbol when every pool symbol is taken', () => {
    const target = doc(SYMBOL_IDS.map((symbol, index) => ({ name: `T${String(index)}`, color: `#0000${(index + 16).toString(16)}0`, symbol })), 40);
    const plan = planPastePalette(target, [entry({ id: 1, name: 'New', color: '#FEDCBA', symbol: S0 })]);
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0]).not.toHaveProperty('symbol');
  });

  it('throws palette-full when the creates exceed the brand limit', () => {
    const target = doc([{ name: 'A', color: '#111111', symbol: S0 }, { name: 'B', color: '#222222', symbol: S1 }], 2);
    expect(() => planPastePalette(target, [entry({ id: 1, name: 'C', color: '#333333', symbol: S2 })])).toThrow(expect.objectContaining({ code: 'palette-full' }));
  });

  it('is the identity for a paste within one pattern', () => {
    const target = doc([
      { name: 'A', color: '#111111', symbol: S0, catalog: dmc('321', '#111111') },
      { name: 'B', color: '#222222', symbol: S1 }
    ]);
    const plan = planPastePalette(target, target.palette);
    expect([...plan.idMap]).toEqual([[1, 1], [2, 2]]);
    expect(plan.creates).toEqual([]);
  });
});

describe('remapFragmentColors and fragmentPaletteIds', () => {
  const fragment = () => {
    const source = doc([
      { name: 'A', color: '#111111', symbol: S0 },
      { name: 'B', color: '#222222', symbol: S1 },
      { name: 'C', color: '#333333', symbol: S2 }
    ]);
    source.kind[0] = CellKind.Full;
    source.colors[0] = 1;
    source.kind[1] = CellKind.Quarters;
    source.colors.set([0, 2, 0, 3], 4);
    source.backstitches = { ids: Uint32Array.of(1), x1: Uint32Array.of(0), y1: Uint32Array.of(0), x2: Uint32Array.of(4), y2: Uint32Array.of(0), colors: Uint16Array.of(2), completed: Uint8Array.of(0) };
    source.nextBackstitchId = 2;
    return createPatternFragment(source, { x: 0, y: 0, width: 2, height: 1 });
  };

  it('lists sorted unique ids across all slots and backstitches', () => {
    expect(fragmentPaletteIds(fragment())).toEqual([1, 2, 3]);
  });

  it('remaps cells and backstitches without mutating the input and leaves 0 and unmapped ids', () => {
    const original = fragment();
    const mapped = remapFragmentColors(original, new Map([[1, 10], [2, 20]]));
    expect([...mapped.colors]).toEqual([10, 0, 0, 0, 0, 20, 0, 3]);
    expect([...mapped.backstitches.colors]).toEqual([20]);
    expect([...original.colors]).toEqual([1, 0, 0, 0, 0, 2, 0, 3]);
  });
});
