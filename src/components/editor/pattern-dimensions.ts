import { deriveFinishedSize, type DisplayUnits } from "../../domain";
import { finishedSizeLine } from "../../export";

/** "40 × 30 stitches · 7.26 cm × 5.44 cm": the stitch count and finished size at the given Aida count. */
export function patternDimensionSummary({ width, height, aidaCount, units }: { width: number; height: number; aidaCount: number; units: DisplayUnits }): string {
  return `${width} × ${height} stitches · ${finishedSizeLine(deriveFinishedSize(width, height, aidaCount), units)}`;
}
