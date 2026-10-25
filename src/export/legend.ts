import type { DisplayUnits, MaterialEstimate, PaletteEntry, PatternMetrics } from '../domain';

const YARDS_PER_METER = 1.09361;

export interface LegendLength {
  /** Lengths in the requested display unit. `unit` is `m` or `yd`. */
  readonly unit: 'm' | 'yd';
  readonly value: number;
  readonly min: number;
  readonly max: number;
}

export interface LegendSkeins {
  readonly min: number;
  readonly max: number;
}

export interface LegendCounts {
  readonly full: number;
  readonly half: number;
  readonly threeQuarter: number;
  readonly quarter: number;
  readonly backstitch: number;
}

export interface LegendRow {
  readonly paletteId: number;
  /** Pool slug; resolve outlines with `getSymbolOutline`. */
  readonly symbol: string;
  readonly catalogCode?: string;
  readonly name: string;
  readonly color: string;
  readonly counts: LegendCounts;
  readonly length?: LegendLength;
  readonly skeins?: LegendSkeins;
}

export interface LegendTotals {
  readonly counts: LegendCounts;
  readonly length?: LegendLength;
  readonly skeins?: LegendSkeins;
}

export interface ExportLegend {
  readonly rows: readonly LegendRow[];
  readonly totals: LegendTotals;
  readonly units: DisplayUnits;
  readonly strands: number;
  readonly backstitchStrands: number;
  readonly waste: number;
  readonly aidaCount?: number;
  readonly note?: string;
}

type Material = MaterialEstimate | Omit<MaterialEstimate, 'paletteId'>;

function lengthFor(material: Material | undefined, units: DisplayUnits): LegendLength | undefined {
  if (!material || material.estimatedMeters === undefined) return undefined;
  const range = material.estimateRange?.meters ?? { min: material.estimatedMeters, max: material.estimatedMeters };
  const scale = units === 'imperial' ? YARDS_PER_METER : 1;
  return {
    unit: units === 'imperial' ? 'yd' : 'm',
    value: material.estimatedMeters * scale,
    min: range.min * scale,
    max: range.max * scale
  };
}

function skeinsFor(material: Material | undefined): LegendSkeins | undefined {
  if (!material) return undefined;
  const range = material.estimateRange?.skeins;
  if (range) return { min: range.min, max: range.max };
  if (material.estimatedSkeins === undefined) return undefined;
  return { min: material.estimatedSkeins, max: material.estimatedSkeins };
}

function hasStitches(counts: LegendCounts): boolean {
  return counts.full + counts.half + counts.threeQuarter + counts.quarter + counts.backstitch > 0;
}

/**
 * Legend rows for active palette entries that have at least one stitch, in
 * palette order, plus totals and the estimate assumptions.
 */
export function buildLegend(palette: readonly PaletteEntry[], metrics: PatternMetrics, units: DisplayUnits): ExportLegend {
  const rows: LegendRow[] = [];
  for (const entry of palette) {
    if (!entry.active) continue;
    const item = metrics.byPalette.get(entry.id);
    if (!item) continue;
    const counts: LegendCounts = {
      full: item.full,
      half: item.half,
      threeQuarter: item.threeQuarter ?? 0,
      quarter: item.quarter,
      backstitch: item.backstitch
    };
    if (!hasStitches(counts)) continue;
    rows.push({
      paletteId: entry.id,
      symbol: entry.symbol,
      catalogCode: entry.catalog?.code,
      name: entry.name,
      color: entry.color,
      counts,
      length: lengthFor(item.material, units),
      skeins: skeinsFor(item.material)
    });
  }
  const totals = metrics.totals;
  const assumptions = metrics.totalMaterial?.assumptions ?? metrics.materials.find((material) => material.assumptions)?.assumptions;
  return {
    rows,
    totals: {
      counts: {
        full: totals.full,
        half: totals.half,
        threeQuarter: totals.threeQuarter ?? 0,
        quarter: totals.quarter,
        backstitch: totals.backstitch
      },
      length: lengthFor(metrics.totalMaterial, units),
      skeins: skeinsFor(metrics.totalMaterial)
    },
    units,
    strands: metrics.materialSettings.strands,
    backstitchStrands: assumptions?.backstitchStrands ?? metrics.materialSettings.backstitchStrands,
    waste: metrics.materialSettings.waste,
    aidaCount: assumptions?.aidaCount,
    note: assumptions?.note
  };
}
