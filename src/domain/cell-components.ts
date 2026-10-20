// A cell holds its stitches in one of two shapes. Single kinds (Full, the
// halves and the four single three-quarters) keep one component in slot 0.
// Quarters and ThreeQuarterPair keep up to four, one per slot, and bit `slot`
// of `completed` marks that component done. Hot loops walk the mask bits
// themselves rather than taking a per-component callback.
import { CellKind, type PatternDocument } from './types';

type CellPlanes = Pick<PatternDocument, 'kind' | 'colors' | 'completed'>;

export interface ThreeQuarterComponent {
  readonly corner: 0 | 1 | 2 | 3;
  readonly slot: 0 | 1 | 2 | 3;
  readonly kind: CellKind;
}

export function isLegacyQuarterKind(kind: number): boolean {
  return kind === CellKind.Quarters;
}

/** A 4-bit mask of the slots that hold a component. */
export function componentSlotMask(kind: number, colors: ArrayLike<number>, offset: number): number {
  if (kind === CellKind.Empty) return 0;
  if (kind !== CellKind.Quarters && kind !== CellKind.ThreeQuarterPair) return colors[offset] !== 0 ? 1 : 0;
  let mask = 0;
  for (let slot = 0; slot < 4; slot += 1) if (colors[offset + slot] !== 0) mask |= 1 << slot;
  return mask;
}

/** The geometry a component draws: a pair's slot is its corner's three-quarter. */
export function componentKind(kind: number, slot: number): CellKind {
  if (kind === CellKind.ThreeQuarterPair) return (CellKind.ThreeQuarterNW + slot) as CellKind;
  return kind as CellKind;
}

/** The two diagonal components a pair holds, chosen by which diagonal is painted. */
export function threeQuarterPairComponents(colors: ArrayLike<number>): readonly [ThreeQuarterComponent, ThreeQuarterComponent] {
  return colors[0] !== 0 || colors[2] !== 0
    ? [
        { corner: 0, slot: 0, kind: CellKind.ThreeQuarterNW },
        { corner: 2, slot: 2, kind: CellKind.ThreeQuarterSE }
      ]
    : [
        { corner: 1, slot: 1, kind: CellKind.ThreeQuarterNE },
        { corner: 3, slot: 3, kind: CellKind.ThreeQuarterSW }
      ];
}

/** Completed components of cell `index`; 0 for an index past either end. */
export function completedComponentCount(document: CellPlanes, index: number): number {
  if (index < 0 || index >= document.kind.length) return 0;
  let mask = componentSlotMask(document.kind[index], document.colors, index * 4) & document.completed[index];
  let count = 0;
  for (; mask !== 0; mask &= mask - 1) count += 1;
  return count;
}

/**
 * `known` plus every palette ID the given cells (all cells when omitted) use,
 * sorted. Returns `known` itself when nothing new appears.
 */
export function paletteIdsInCells(document: Pick<PatternDocument, 'kind' | 'colors'>, known: readonly number[], cells?: Iterable<number>): readonly number[] {
  const ids = new Set(known);
  let grew = false;
  const visit = (index: number): void => {
    const offset = index * 4;
    const mask = componentSlotMask(document.kind[index], document.colors, offset);
    for (let slot = 0; slot < 4; slot += 1) {
      if ((mask & (1 << slot)) === 0) continue;
      const id = document.colors[offset + slot];
      if (ids.has(id)) continue;
      ids.add(id);
      grew = true;
    }
  };
  if (cells === undefined) for (let index = 0; index < document.kind.length; index += 1) visit(index);
  else for (const index of cells) visit(index);
  return grew ? Object.freeze([...ids].sort((left, right) => left - right)) : known;
}
