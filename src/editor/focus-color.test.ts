import { describe, expect, it } from 'vitest';
import { CellKind, assertValidPatternFragment, type PatternDocument, type PatternFragment } from '../domain';
import {
  backstitchColor,
  cellEditableUnderFocus,
  componentEditableUnderFocus,
  filterEditableIndices,
  focusBackstitchIds,
  focusColorIndices,
  focusPasteFragment,
  moveOverwritesProtected
} from './focus-color';

const PAIR = CellKind.ThreeQuarterPair;

type CellSpec = readonly [kind: number, colors: readonly [number, number, number, number]];

function surfaceOf(width: number, height: number, cells: Record<number, CellSpec> = {}, lines: readonly (readonly [id: number, color: number])[] = []): PatternDocument {
  const kind = new Uint8Array(width * height);
  const colors = new Uint16Array(width * height * 4);
  for (const [index, [cellKind, cellColors]] of Object.entries(cells)) {
    kind[Number(index)] = cellKind;
    colors.set(cellColors, Number(index) * 4);
  }
  return {
    width,
    height,
    kind,
    colors,
    backstitches: {
      ids: Uint32Array.from(lines, ([id]) => id),
      x1: new Uint32Array(lines.length),
      y1: new Uint32Array(lines.length),
      x2: new Uint32Array(lines.length),
      y2: Uint32Array.from(lines, () => 4),
      colors: Uint16Array.from(lines, ([, color]) => color),
      completed: new Uint8Array(lines.length)
    }
  } as unknown as PatternDocument;
}

const cells: Record<number, CellSpec> = {
  0: [CellKind.Full, [1, 0, 0, 0]],
  1: [CellKind.Full, [2, 0, 0, 0]],
  2: [CellKind.HalfSlash, [1, 0, 0, 0]],
  3: [CellKind.ThreeQuarterNW, [1, 0, 0, 0]],
  4: [PAIR, [1, 0, 1, 0]],
  5: [PAIR, [1, 0, 2, 0]],
  6: [CellKind.Quarters, [1, 1, 0, 0]],
  7: [CellKind.Quarters, [1, 2, 0, 0]]
};

describe('cellEditableUnderFocus', () => {
  const surface = surfaceOf(4, 3, cells);
  it('treats empty cells as editable', () => {
    expect(cellEditableUnderFocus(surface, 8, 1)).toBe(true);
  });
  it('requires every occupied component to be the focus color', () => {
    expect(cellEditableUnderFocus(surface, 0, 1)).toBe(true);
    expect(cellEditableUnderFocus(surface, 1, 1)).toBe(false);
    expect(cellEditableUnderFocus(surface, 2, 1)).toBe(true);
    expect(cellEditableUnderFocus(surface, 3, 1)).toBe(true);
    expect(cellEditableUnderFocus(surface, 4, 1)).toBe(true);
    expect(cellEditableUnderFocus(surface, 5, 1)).toBe(false);
    expect(cellEditableUnderFocus(surface, 6, 1)).toBe(true);
    expect(cellEditableUnderFocus(surface, 7, 1)).toBe(false);
  });
});

describe('componentEditableUnderFocus', () => {
  const surface = surfaceOf(4, 3, cells);
  it('allows a mixed pair component of the focus color only', () => {
    expect(componentEditableUnderFocus(surface, 5, 0, 1)).toBe(true);
    expect(componentEditableUnderFocus(surface, 5, 2, 1)).toBe(false);
    expect(componentEditableUnderFocus(surface, 5, 2, 2)).toBe(true);
  });
  it('falls back to whole-cell rules for other kinds', () => {
    expect(componentEditableUnderFocus(surface, 0, 0, 1)).toBe(true);
    expect(componentEditableUnderFocus(surface, 1, 0, 1)).toBe(false);
    expect(componentEditableUnderFocus(surface, 4, 2, 1)).toBe(true);
  });
});

describe('index filters', () => {
  const surface = surfaceOf(4, 3, cells);
  it('filterEditableIndices keeps order and returns the same array when nothing drops', () => {
    const all = Uint32Array.of(0, 2, 8);
    expect(filterEditableIndices(surface, all, 1)).toBe(all);
    expect(Array.from(filterEditableIndices(surface, Uint32Array.of(0, 1, 5, 8, 2), 1))).toEqual([0, 8, 2]);
  });
  it('focusColorIndices drops empty and other-color cells', () => {
    expect(Array.from(focusColorIndices(surface, Uint32Array.of(0, 1, 2, 5, 6, 8), 1))).toEqual([0, 2, 6]);
  });
});

describe('backstitch helpers', () => {
  const surface = surfaceOf(2, 2, {}, [[10, 1], [11, 2], [12, 1]]);
  it('looks up colors by id', () => {
    expect(backstitchColor(surface, 11)).toBe(2);
    expect(backstitchColor(surface, 99)).toBeUndefined();
  });
  it('keeps only focus ids', () => {
    expect(focusBackstitchIds(surface, [10, 11, 12, 99], 1)).toEqual([10, 12]);
    expect(focusBackstitchIds(surface, Uint32Array.of(11), 1)).toEqual([]);
  });
});

describe('focusPasteFragment', () => {
  const fragment: PatternFragment = {
    version: 1,
    width: 3,
    height: 2,
    kind: Uint8Array.of(CellKind.Full, CellKind.Full, CellKind.Empty, PAIR, CellKind.Full, CellKind.Quarters),
    colors: Uint16Array.of(1, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 1, 0, 2, 0, 1, 0, 0, 0, 1, 1, 0, 0),
    backstitches: {
      x1: Uint32Array.of(0, 1),
      y1: Uint32Array.of(0, 0),
      x2: Uint32Array.of(4, 5),
      y2: Uint32Array.of(0, 0),
      colors: Uint16Array.of(1, 2)
    }
  } as PatternFragment;

  it('drops non-focus cells and backstitches and stays valid', () => {
    assertValidPatternFragment(fragment);
    const surface = surfaceOf(5, 5);
    const result = focusPasteFragment(fragment, surface, { x: 1, y: 1 }, 1);
    assertValidPatternFragment(result);
    expect(Array.from(result.kind)).toEqual([CellKind.Full, 0, 0, 0, CellKind.Full, CellKind.Quarters]);
    expect(Array.from(result.colors.subarray(12, 16))).toEqual([0, 0, 0, 0]);
    expect(Array.from(result.backstitches.colors)).toEqual([1]);
    expect(Array.from(result.backstitches.x2)).toEqual([4]);
    expect(fragment.kind[1]).toBe(CellKind.Full);
  });

  it('drops cells landing on protected destination cells', () => {
    const surface = surfaceOf(5, 5, { 6: [CellKind.Full, [2, 0, 0, 0]], 12: [CellKind.Full, [1, 0, 0, 0]] });
    const result = focusPasteFragment(fragment, surface, { x: 1, y: 1 }, 1);
    assertValidPatternFragment(result);
    expect(result.kind[0]).toBe(CellKind.Empty);
    expect(result.kind[4]).toBe(CellKind.Full);
  });
});

describe('moveOverwritesProtected', () => {
  const surface = surfaceOf(4, 1, { 0: [CellKind.Full, [1, 0, 0, 0]], 1: [CellKind.Full, [1, 0, 0, 0]], 2: [CellKind.Full, [2, 0, 0, 0]] });
  it('flags a move onto another color', () => {
    expect(moveOverwritesProtected(surface, Uint32Array.of(0, 1), 1, 0, 1)).toBe(true);
  });
  it('treats vacated and empty targets as free', () => {
    expect(moveOverwritesProtected(surface, Uint32Array.of(0), 1, 0, 1)).toBe(false);
    expect(moveOverwritesProtected(surface, Uint32Array.of(1), 1, 0, 1)).toBe(true);
    expect(moveOverwritesProtected(surface, Uint32Array.of(0, 1), -1, 0, 1)).toBe(false);
  });
  it('ignores targets outside the surface', () => {
    expect(moveOverwritesProtected(surface, Uint32Array.of(0), -1, 0, 1)).toBe(false);
    expect(moveOverwritesProtected(surface, Uint32Array.of(1), 0, 1, 1)).toBe(false);
  });
});
