import type { DisplayUnits } from "../../domain";

const formatMeasure = (inches: number, units: DisplayUnits) =>
  units === "metric"
    ? `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(inches * 2.54)} cm`
    : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(inches)} in`;

/** "40 × 30 stitches · 7.26 cm × 5.44 cm": the stitch count and finished size at the given Aida count. */
export function patternDimensionSummary({ width, height, aidaCount, units }: { width: number; height: number; aidaCount: number; units: DisplayUnits }): string {
  return `${width} × ${height} stitches · ${formatMeasure(width / aidaCount, units)} × ${formatMeasure(height / aidaCount, units)}`;
}
