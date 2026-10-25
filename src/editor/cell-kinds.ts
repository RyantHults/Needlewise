import { CellKind } from '../domain';

/** Directional three-quarter kinds use one color and one completion bit. */
export const ThreeQuarterNW = CellKind.ThreeQuarterNW;
export const ThreeQuarterNE = CellKind.ThreeQuarterNE;
export const ThreeQuarterSE = CellKind.ThreeQuarterSE;
export const ThreeQuarterSW = CellKind.ThreeQuarterSW;
export const ThreeQuarterPair = ((CellKind as unknown as Record<string, number>).ThreeQuarterPair ?? 9) as CellKind;

export const THREE_QUARTER_KINDS = [
  ThreeQuarterNW,
  ThreeQuarterNE,
  ThreeQuarterSE,
  ThreeQuarterSW
] as const;

export const THREE_QUARTER_PAIR_KINDS = [ThreeQuarterPair] as const;

export function isThreeQuarterKind(kind: number): boolean {
  return THREE_QUARTER_KINDS.includes(kind as (typeof THREE_QUARTER_KINDS)[number]);
}

export function isThreeQuarterPairKind(kind: number): boolean {
  return THREE_QUARTER_PAIR_KINDS.includes(kind as (typeof THREE_QUARTER_PAIR_KINDS)[number]);
}

export function threeQuarterKindForCorner(corner: number): CellKind {
  switch (corner) {
    case 1: return ThreeQuarterNE;
    case 2: return ThreeQuarterSE;
    case 3: return ThreeQuarterSW;
    default: return ThreeQuarterNW;
  }
}

export function threeQuarterCornerForKind(kind: number): 0 | 1 | 2 | 3 | undefined {
  if (kind === ThreeQuarterNW) return 0;
  if (kind === ThreeQuarterNE) return 1;
  if (kind === ThreeQuarterSE) return 2;
  if (kind === ThreeQuarterSW) return 3;
  return undefined;
}

export function threeQuarterCornersShareAxis(left: number, right: number): boolean {
  return (left === 0 || left === 2) === (right === 0 || right === 2);
}

/** Cell kinds accepted by the dense fill protocol. */
export function isKnownCellKind(kind: number): boolean {
  return kind === CellKind.Empty
    || kind === CellKind.Full
    || kind === CellKind.HalfBackslash
    || kind === CellKind.HalfSlash
    || kind === CellKind.Quarters
    || isThreeQuarterKind(kind)
    || isThreeQuarterPairKind(kind);
}
