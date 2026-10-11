import { describe, expect, it } from 'vitest';
import type { MaterialEstimate, PaletteEntry, PatternMetrics } from '../domain';
import { buildLegend } from './legend';

const entry = (id: number, patch: Partial<PaletteEntry> = {}): PaletteEntry => ({
  id, name: `Color ${id}`, color: '#112233', active: true, symbol: `sym-${id}`, material: {} as PaletteEntry['material'], ...patch
});

function material(paletteId: number, meters: number): MaterialEstimate {
  return {
    paletteId, stitchUnits: 1, strandLength: 1, estimatedLength: 1, estimatedMeters: meters, estimatedSkeins: meters / 8,
    materialUnit: undefined,
    estimateRange: { meters: { min: meters * 0.9, max: meters * 1.1 }, skeins: { min: 1, max: 2 } },
    assumptions: { model: 'aida', aidaCount: 14, strands: 2, waste: 0.1, backstitchStrands: 1, note: 'Estimate note' }
  };
}

function metricsFor(ids: number[], counts: Record<number, number>, extra: object = {}): PatternMetrics {
  const palettes = ids.map((id) => ({
    paletteId: id, full: counts[id] ?? 0, half: 0, quarter: 0, threeQuarter: 2, backstitch: 0,
    totalComponents: 0, completedComponents: 0, remainingComponents: 0, backstitchLengthFixed: 0, backstitchLength: 0,
    material: material(id, 10)
  }));
  return {
    palettes, byPalette: new Map(palettes.map((p) => [p.paletteId, p])),
    totals: { full: 5, half: 1, quarter: 0, threeQuarter: 2, backstitch: 3 },
    materials: palettes.map((p) => p.material),
    materialSettings: { strands: 2, waste: 0.1, ...extra },
    totalMaterial: { ...material(0, 20), paletteId: undefined }
  } as unknown as PatternMetrics;
}

describe('buildLegend', () => {
  it('skips inactive and stitchless entries and carries catalog codes', () => {
    const palette = [
      entry(1, { catalog: { catalogId: 'c', sourceId: 's', code: '310', name: 'Black', hex: '#000', rgb: [0, 0, 0] } }),
      entry(2, { active: false }),
      entry(3)
    ];
    const metrics = metricsFor([1, 2, 3], { 1: 4, 2: 4, 3: 4 });
    const legend = buildLegend(palette, metrics, 'metric');
    expect(legend.rows.map((r) => r.paletteId)).toEqual([1, 3]);
    expect(legend.rows[0]).toMatchObject({ catalogCode: '310', symbol: 'sym-1', counts: { full: 4, threeQuarter: 2 } });
    expect(legend.rows[1].catalogCode).toBeUndefined();
    const onlyThreeQuarter = buildLegend([entry(1)], metricsFor([1], { 1: 0 }), 'metric');
    expect(onlyThreeQuarter.rows).toHaveLength(1);
  });

  it('drops entries with no stitches at all', () => {
    const metrics = metricsFor([1], { 1: 0 });
    (metrics.byPalette.get(1) as { threeQuarter: number }).threeQuarter = 0;
    expect(buildLegend([entry(1)], metrics, 'metric').rows).toEqual([]);
  });

  it('respects display units', () => {
    const palette = [entry(1)];
    const metrics = metricsFor([1], { 1: 4 });
    const metric = buildLegend(palette, metrics, 'metric');
    const imperial = buildLegend(palette, metrics, 'imperial');
    expect(metric.rows[0].length).toMatchObject({ unit: 'm', value: 10 });
    expect(imperial.rows[0].length?.unit).toBe('yd');
    expect(imperial.rows[0].length?.value).toBeCloseTo(10.9361);
    expect(imperial.totals.length?.max).toBeCloseTo(22 * 1.09361);
    expect(metric.rows[0].skeins).toEqual({ min: 1, max: 2 });
    expect(metric.totals.counts).toEqual({ full: 5, half: 1, threeQuarter: 2, quarter: 0, backstitch: 3 });
  });

  it('reads backstitchStrands defensively', () => {
    const palette = [entry(1)];
    const metrics = metricsFor([1], { 1: 4 });
    expect(buildLegend(palette, metrics, 'metric')).toMatchObject({ strands: 2, backstitchStrands: 1, note: 'Estimate note', aidaCount: 14 });
    const noAssumptions = { ...metrics, totalMaterial: undefined, materials: [], materialSettings: { strands: 2, waste: 0, backstitchStrands: 3 } } as unknown as PatternMetrics;
    expect(buildLegend(palette, noAssumptions, 'metric').backstitchStrands).toBe(3);
    const bare = { ...noAssumptions, materialSettings: { strands: 1, waste: 0 } } as unknown as PatternMetrics;
    expect(buildLegend(palette, bare, 'metric')).toMatchObject({ backstitchStrands: 1, note: undefined });
  });
});
