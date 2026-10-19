import type { DisplayUnits, PatternMetrics } from '../domain';

/** Whole numbers print bare; fractions print with at most two decimals and no trailing zeros. */
export const number = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''));

export function finishedSizeLine(finished: PatternMetrics['finishedSize'], units: DisplayUnits): string | null {
  if (!finished) return null;
  return units === 'metric'
    ? `${number(finished.widthCm)} cm × ${number(finished.heightCm)} cm`
    : `${number(finished.widthInches)} in × ${number(finished.heightInches)} in`;
}
