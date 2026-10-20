import { describe, expect, it } from 'vitest';
import { completedComponentCount, componentKind, componentSlotMask, paletteIdsInCells } from './cell-components';
import { CellKind } from './types';

describe('cell components', () => {
  it('masks slot 0 for single kinds and every painted slot for quarters and pairs', () => {
    expect(componentSlotMask(CellKind.Empty, [1, 0, 0, 0], 0)).toBe(0);
    expect(componentSlotMask(CellKind.Full, [3, 0, 0, 0], 0)).toBe(1);
    expect(componentSlotMask(CellKind.ThreeQuarterSE, [3, 0, 0, 0], 0)).toBe(1);
    expect(componentSlotMask(CellKind.Quarters, [0, 0, 1, 2, 0, 4, 0, 5], 4)).toBe(0b1010);
    expect(componentSlotMask(CellKind.ThreeQuarterPair, [1, 0, 2, 0], 0)).toBe(0b0101);
  });

  it('gives a pair slot its corner three-quarter and leaves other kinds alone', () => {
    expect(componentKind(CellKind.ThreeQuarterPair, 2)).toBe(CellKind.ThreeQuarterSE);
    expect(componentKind(CellKind.ThreeQuarterPair, 3)).toBe(CellKind.ThreeQuarterSW);
    expect(componentKind(CellKind.Quarters, 1)).toBe(CellKind.Quarters);
  });

  it('counts completed painted components and treats an out-of-range index as none', () => {
    const planes = {
      kind: new Uint8Array([CellKind.Quarters, CellKind.Full]),
      colors: new Uint16Array([1, 0, 2, 3, 4, 0, 0, 0]),
      completed: new Uint8Array([0b0111, 1])
    };
    expect(completedComponentCount(planes, 0)).toBe(2);
    expect(completedComponentCount(planes, 1)).toBe(1);
    expect(completedComponentCount(planes, -1)).toBe(0);
    expect(completedComponentCount(planes, 2)).toBe(0);
  });

  it('adds the palette IDs cells use and returns the known array when none are new', () => {
    const document = {
      kind: new Uint8Array([CellKind.Full, CellKind.ThreeQuarterPair, CellKind.Empty]),
      colors: new Uint16Array([5, 0, 0, 0, 0, 2, 0, 7, 9, 9, 9, 9])
    };
    const all = paletteIdsInCells(document, []);
    expect(all).toEqual([2, 5, 7]);
    expect(paletteIdsInCells(document, all, [0, 1])).toBe(all);
    expect(paletteIdsInCells(document, [5], [1])).toEqual([2, 5, 7]);
  });
});
