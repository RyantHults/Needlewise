export interface DeleteMetricsImpactEntry {
  readonly paletteId: number;
  readonly removedFull: number;
  readonly removedHalf: number;
  readonly removedQuarter: number;
  readonly removedCellCompleted: number;
  readonly beforeBackstitchCount: number;
  readonly afterBackstitchCount: number;
  readonly beforeBackstitchCompleted: number;
  readonly afterBackstitchCompleted: number;
  readonly beforeBackstitchLengthFixed: number;
  readonly afterBackstitchLengthFixed: number;
}

export interface DeleteMetricsImpact {
  readonly entries: readonly DeleteMetricsImpactEntry[];
}

export type DeleteMetricsImpactTarget = 'before' | 'after';

interface DeleteMetricsResultImpact {
  readonly impact: DeleteMetricsImpact;
  readonly target: DeleteMetricsImpactTarget;
}

const deltaImpacts = new WeakMap<object, DeleteMetricsImpact>();
const resultImpacts = new WeakMap<object, DeleteMetricsResultImpact>();

export function createDeleteMetricsImpact(entries: readonly DeleteMetricsImpactEntry[]): DeleteMetricsImpact {
  const frozenEntries = entries.map((entry) => Object.freeze({ ...entry }));
  return Object.freeze({ entries: Object.freeze(frozenEntries) });
}

export function registerDeleteMetricsImpact(delta: object, impact: DeleteMetricsImpact): void {
  deltaImpacts.set(delta, impact);
}

export function attachDeleteMetricsImpactForDelta(
  result: object,
  delta: object,
  target: DeleteMetricsImpactTarget
): void {
  const impact = deltaImpacts.get(delta);
  if (impact !== undefined) resultImpacts.set(result, Object.freeze({ impact, target }));
}

export function deleteMetricsImpactForResult(result: object): DeleteMetricsResultImpact | undefined {
  return resultImpacts.get(result);
}
