import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  CellKind,
  computeMetricsSinglePass,
  computePatternMetrics,
  createDocument,
  HalfDirection,
  MAX_PERSISTABLE_CELL_COUNT,
  DEFAULT_SKEIN_LENGTH_METERS,
  normalizeAidaCount,
  normalizeDisplayUnits,
  normalizeMaterialAssumptions,
  QuarterCorner
} from './index';
import { DEFAULT_CATALOG_DEFINITION } from '../catalog';

describe('derived pattern metrics', () => {
  it('counts every component by stable palette ID and calculates material/progress exactly', () => {
    let pattern = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association,
      width: 3,
      height: 2,
      palette: [
        { id: 7, name: 'Red', color: '#d33' },
        { id: 2, name: 'Blue', color: '#36c' }
      ]
    });
    const apply = (command: Parameters<typeof applyCommand>[1]) => {
      pattern = applyCommand(pattern, command).document;
    };

    apply({ type: 'set-full', x: 0, y: 0, color: 7 });
    apply({ type: 'set-completion', x: 0, y: 0, completed: true });
    apply({ type: 'set-half', x: 1, y: 0, direction: HalfDirection.Slash, color: 7 });
    apply({ type: 'set-quarter', x: 2, y: 0, corner: QuarterCorner.NW, color: 2 });
    apply({ type: 'set-completion', x: 2, y: 0, corner: QuarterCorner.NW, completed: true });
    apply({ type: 'set-quarter', x: 2, y: 0, corner: QuarterCorner.SE, color: 7 });
    apply({ type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 2 });
    apply({ type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 4 }, color: 7 });
    const backstitchId = pattern.backstitches.ids[1];
    apply({ type: 'set-backstitch-completion', id: backstitchId, completed: true });

    const metrics = computePatternMetrics(pattern, { strands: 2, waste: 0.1, skeinLength: 10 });

    expect(metrics.palettes).toEqual([
      {
        paletteId: 7,
        full: 1,
        half: 1,
        quarter: 1,
        backstitch: 1,
        backstitchLengthFixed: Math.SQRT2 * 4,
        backstitchLength: Math.SQRT2,
        totalComponents: 4,
        completedComponents: 2,
        remainingComponents: 2,
        material: {
          paletteId: 7,
          stitchUnits: 1.75 + Math.SQRT2,
          strandLength: (1.75 + Math.SQRT2) * 2,
          estimatedLength: (1.75 + Math.SQRT2) * 2.2,
          materialUnit: 'skeins'
        }
      },
      {
        paletteId: 2,
        full: 0,
        half: 0,
        quarter: 1,
        backstitch: 1,
        backstitchLengthFixed: 4,
        backstitchLength: 1,
        totalComponents: 2,
        completedComponents: 1,
        remainingComponents: 1,
        material: {
          paletteId: 2,
          stitchUnits: 1.25,
          strandLength: 2.5,
          estimatedLength: 2.75,
          materialUnit: 'skeins'
        }
      }
    ]);
    expect(metrics.totals).toEqual({
      full: 1,
      half: 1,
      quarter: 2,
      backstitch: 2,
      backstitchLengthFixed: 4 + Math.SQRT2 * 4,
      backstitchLength: 1 + Math.SQRT2,
      totalComponents: 6,
      completedComponents: 3,
      remainingComponents: 3
    });
    expect(metrics.progress).toEqual({
      completedComponents: 3,
      remainingComponents: 3,
      totalComponents: 6,
      fraction: 0.5,
      percent: 50
    });
    expect(metrics.overallProgress).toBe(0.5);
  });

  it('counts directional three-quarter cells as whole components while weighting material at 0.75', () => {
    let pattern = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association,
      width: 2,
      height: 1,
      palette: [{ id: 1, name: 'Red', color: '#d33' }]
    });
    pattern = applyCommand(pattern, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.NW, color: 1 }).document;
    pattern = applyCommand(pattern, { type: 'set-completion', x: 0, y: 0, completed: true }).document;
    pattern = applyCommand(pattern, { type: 'set-three-quarter', x: 1, y: 0, corner: QuarterCorner.SE, color: 1 }).document;

    const metrics = computePatternMetrics(pattern, { strands: 2, waste: 0.1 });
    expect(metrics.palettes[0]).toMatchObject({
      full: 0,
      half: 0,
      quarter: 0,
      threeQuarter: 2,
      backstitch: 0,
      totalComponents: 2,
      completedComponents: 1,
      remainingComponents: 1,
      material: {
        stitchUnits: 1.5,
        strandLength: 3,
      }
    });
    expect(metrics.palettes[0].material.estimatedLength).toBeCloseTo(3.3);
    expect(metrics.totals).toMatchObject({ threeQuarter: 2, totalComponents: 2, completedComponents: 1, remainingComponents: 1 });
    expect(metrics.progress).toEqual({ completedComponents: 1, remainingComponents: 1, totalComponents: 2, fraction: 0.5, percent: 50 });
  });

  it('counts paired three-quarter cells as two components with independently weighted materials', () => {
    let pattern = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association,
      width: 1,
      height: 1,
      palette: [{ id: 1, name: 'Red', color: '#d33' }, { id: 2, name: 'Blue', color: '#36c' }]
    });
    pattern = applyCommand(pattern, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.NW, color: 1 }).document;
    pattern = applyCommand(pattern, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.SE, color: 2 }).document;
    pattern = applyCommand(pattern, { type: 'set-completion', x: 0, y: 0, corner: QuarterCorner.NW, completed: true }).document;

    const metrics = computePatternMetrics(pattern, { strands: 2, waste: 0.1 });
    expect(metrics.totals).toMatchObject({ threeQuarter: 2, totalComponents: 2, completedComponents: 1, remainingComponents: 1 });
    expect(metrics.palettes[0]).toMatchObject({ threeQuarter: 1, totalComponents: 1, completedComponents: 1, material: { stitchUnits: 0.75 } });
    expect(metrics.palettes[1]).toMatchObject({ threeQuarter: 1, totalComponents: 1, completedComponents: 0, material: { stitchUnits: 0.75 } });
    expect(metrics.progress).toEqual({ completedComponents: 1, remainingComponents: 1, totalComponents: 2, fraction: 0.5, percent: 50 });
  });

  it('scans bounded 500 by 500 and 1000 by 1000 documents without adding derived state', () => {
    for (const side of [500, 1000]) {
      const pattern = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association,
        width: side,
        height: side,
        palette: [{ id: 1, name: 'Red', color: '#d33' }]
      });
      const beforeKeys = Object.keys(pattern);
      pattern.kind[pattern.kind.length - 1] = CellKind.Full;
      pattern.colors[pattern.colors.length - 4] = 1;
      const metrics = computePatternMetrics(pattern);

      expect(metrics.totals.full).toBe(1);
      expect(metrics.totals.totalComponents).toBe(1);
      expect(metrics.palettes[0].remainingComponents).toBe(1);
      expect(Object.keys(pattern)).toEqual(beforeKeys);
      expect(pattern.kind[pattern.kind.length - 1]).toBe(CellKind.Full);
    }
    expect(MAX_PERSISTABLE_CELL_COUNT).toBe(1_000_000);
  });

  it('keeps default material results abstract and only emits physical units when calibrated', () => {
    let pattern = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    pattern = applyCommand(pattern, { type: 'set-full', x: 0, y: 0, color: 1 }).document;
    const abstract = computePatternMetrics(pattern);
    expect(abstract.palettes[0].material).toMatchObject({ stitchUnits: 1, strandLength: 1, estimatedLength: 1 });
    expect(abstract.palettes[0].material.estimatedMeters).toBeUndefined();
    expect(abstract.palettes[0].material.estimatedSkeins).toBeUndefined();
    expect(abstract.palettes[0].material.requiredSkeins).toBeUndefined();

    const calibrated = computeMetricsSinglePass(pattern, {
      strands: 2,
      waste: 0.1,
      stitchLengthMeters: 0.1,
      skeinLengthMeters: 8
    });
    expect(calibrated.palettes[0].material).toMatchObject({
      stitchUnits: 1,
      strandLength: 2,
      estimatedLength: 2.2,
      requiredSkeins: 1
    });
    expect(calibrated.palettes[0].material.estimatedMeters).toBeCloseTo(0.22);
    expect(calibrated.palettes[0].material.estimatedSkeins).toBeCloseTo(0.0275);
  });

  it('derives finished size and estimates Aida thread by stitch geometry', () => {
    let pattern = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 14, height: 7, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    pattern = applyCommand(pattern, { type: 'set-full', x: 0, y: 0, color: 1 }).document;
    pattern = applyCommand(pattern, { type: 'set-half', x: 1, y: 0, direction: HalfDirection.Slash, color: 1 }).document;
    pattern = applyCommand(pattern, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 1 }).document;

    const metrics = computePatternMetrics(pattern, { aidaCount: 14 });
    const material = metrics.palettes[0].material;
    const expectedBaseMeters = ((0.8 + 0.4) * 2 + 1.5 / 14) / 39.37007874015748;
    expect(metrics.finishedSize).toEqual({ widthInches: 1, heightInches: 0.5, widthCm: 2.54, heightCm: 1.27 });
    expect(metrics.materialSettings).toMatchObject({ strands: 2, waste: 0 });
    expect(material.estimatedMeters).toBeCloseTo(expectedBaseMeters);
    expect(material.estimatedSkeins).toBeCloseTo(expectedBaseMeters / DEFAULT_SKEIN_LENGTH_METERS);
    expect(material.requiredSkeins).toBe(1);
    expect(material.assumptions).toMatchObject({ model: 'aida', aidaCount: 14, strands: 2, waste: 0, singleStrandFullCrossInchesAt14: 0.8, backstitchUndersideMultiplier: 1.5 });
    expect(material.estimateRange?.meters).toEqual({ min: expectedBaseMeters, max: expectedBaseMeters });
    expect(material.estimateRange?.skeins?.min).toBeCloseTo(expectedBaseMeters / DEFAULT_SKEIN_LENGTH_METERS);
    expect(material.estimateRange?.skeins?.max).toBeCloseTo(expectedBaseMeters / DEFAULT_SKEIN_LENGTH_METERS);
    expect(metrics.totalMaterial?.assumptions).toEqual(material.assumptions);
  });

  it('falls back to an 8.7-yard skein when no skein length is calibrated', () => {
    expect(DEFAULT_SKEIN_LENGTH_METERS).toBeCloseTo(7.95528);
    let pattern = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    pattern = applyCommand(pattern, { type: 'set-full', x: 0, y: 0, color: 1 }).document;
    const metrics = computePatternMetrics(pattern, { aidaCount: 14 });
    const material = metrics.palettes[0].material;
    expect(material.estimatedSkeins).toBeCloseTo((material.estimatedMeters ?? 0) / 7.95528);
    expect(material.requiredSkeins).toBe(1);
  });

  it('uses manual thread calibration for metres and falls back to the standard skein', () => {
    let pattern = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    pattern = applyCommand(pattern, { type: 'set-full', x: 0, y: 0, color: 1 }).document;

    const calibrated = computePatternMetrics(pattern, { aidaCount: 14, stitchLengthMeters: 0.1 });
    expect(calibrated.palettes[0].material.estimatedMeters).toBeCloseTo(0.2);
    expect(calibrated.palettes[0].material.estimatedSkeins).toBeCloseTo(0.2 / DEFAULT_SKEIN_LENGTH_METERS);
    expect(calibrated.palettes[0].material.requiredSkeins).toBe(1);

    const withSkein = computePatternMetrics(pattern, { aidaCount: 14, stitchLengthMeters: 0.1, skeinLengthMeters: 8 });
    expect(withSkein.palettes[0].material.estimatedSkeins).toBeCloseTo(0.025);
    expect(withSkein.palettes[0].material.requiredSkeins).toBe(1);
    expect(() => normalizeAidaCount(0)).toThrow(/finite number greater than zero/);
    expect(() => computePatternMetrics(pattern, { aidaCount: Number.NaN })).toThrow(/Aida count/);
  });

  it('accepts only metric or imperial display units', () => {
    expect(normalizeDisplayUnits('metric')).toBe('metric');
    expect(normalizeDisplayUnits('imperial')).toBe('imperial');
    expect(() => normalizeDisplayUnits('furlongs')).toThrow(/metric or imperial/);
    expect(() => normalizeDisplayUnits(undefined)).toThrow(/metric or imperial/);
    expect(() => normalizeDisplayUnits(null)).toThrow(/metric or imperial/);
  });

  it('keeps canonical waste fractions stable and accepts percentage input only by name', () => {
    const canonical = normalizeMaterialAssumptions({ waste: 1.25 });
    expect(canonical.waste).toBe(1.25);
    expect(normalizeMaterialAssumptions(canonical)).toEqual(canonical);
    expect(normalizeMaterialAssumptions({ wastePercent: 125 })).toEqual(canonical);

    let pattern = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    pattern = applyCommand(pattern, { type: 'set-full', x: 0, y: 0, color: 1 }).document;
    const first = computePatternMetrics(pattern, { aidaCount: 14, strands: canonical.strands, waste: canonical.waste });
    const second = computePatternMetrics(pattern, { aidaCount: 14, ...canonical });
    expect(second.palettes[0].material.estimatedMeters).toBe(first.palettes[0].material.estimatedMeters);
  });
});
