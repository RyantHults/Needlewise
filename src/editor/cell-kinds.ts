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

export interface ThreeQuarterComponent {
  readonly corner: 0 | 1 | 2 | 3;
  readonly slot: 0 | 1 | 2 | 3;
  readonly kind: CellKind;
}

export function isThreeQuarterKind(kind: number): boolean {
  return THREE_QUARTER_KINDS.includes(kind as (typeof THREE_QUARTER_KINDS)[number]);
}

export function isThreeQuarterPairKind(kind: number): boolean {
  return THREE_QUARTER_PAIR_KINDS.includes(kind as (typeof THREE_QUARTER_PAIR_KINDS)[number]);
}

export function isLegacyQuarterKind(kind: number): boolean {
  return kind === CellKind.Quarters;
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

export function threeQuarterPairComponents(colors: ArrayLike<number>): readonly [ThreeQuarterComponent, ThreeQuarterComponent] {
  return colors[0] !== 0 || colors[2] !== 0
    ? [
        { corner: 0, slot: 0, kind: ThreeQuarterNW },
        { corner: 2, slot: 2, kind: ThreeQuarterSE }
      ]
    : [
        { corner: 1, slot: 1, kind: ThreeQuarterNE },
        { corner: 3, slot: 3, kind: ThreeQuarterSW }
      ];
}

export function threeQuarterCornersShareAxis(left: number, right: number): boolean {
  return (left === 0 || left === 2) === (right === 0 || right === 2);
}

/** The former half-cell triangle used by a directional three-quarter stitch. */
export function threeQuarterUsesBackslashTriangle(kind: number): boolean {
  return kind === ThreeQuarterNW || kind === ThreeQuarterSE;
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
