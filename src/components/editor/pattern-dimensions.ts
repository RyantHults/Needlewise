import { DEFAULT_PATTERN_AIDA_COUNT, deriveFinishedSize, type DisplayUnits, type PatternDocument } from "../../domain";
import type { ProjectWorkspace } from "../../application/workspace";
import { finishedSizeLine } from "../../export";

/** "40 × 30 stitches · 7.26 cm × 5.44 cm": the stitch count and finished size at the given Aida count. */
function patternDimensionSummary({ width, height, aidaCount, units }: { width: number; height: number; aidaCount: number; units: DisplayUnits }): string {
  return `${width} × ${height} stitches · ${finishedSizeLine(deriveFinishedSize(width, height, aidaCount), units)}`;
}

/**
 * The Aida count a pattern page sizes against, from the layer stack when there
 * is one and the document otherwise, and the header's dimension line in the
 * project's units.
 */
export function patternDimensionInfo(workspace: Pick<ProjectWorkspace, "session" | "metadata">, document: PatternDocument): { aidaCount: number; summary: string } {
  const aidaCount = Number(workspace.session?.layeredDocument?.settings.aidaCount ?? document.settings?.aidaCount ?? DEFAULT_PATTERN_AIDA_COUNT);
  const units = workspace.metadata?.units ?? "metric";
  return { aidaCount, summary: patternDimensionSummary({ width: document.width, height: document.height, aidaCount, units }) };
}
