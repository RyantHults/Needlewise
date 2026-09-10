import {
  CellKind,
  DomainError,
  FIXED_POINT_UNITS_PER_CELL,
  type MaterialUnit,
  type PatternDocument,
  type PatternSettings
} from './types';
import { isThreeQuarterPairKind, isThreeQuarterSingleKind } from './model';

/**
 * Material settings used by the estimator.  The document's v2 settings do
 * not contain derived values, so these values are deliberately kept as an
 * input to the calculation rather than written back to the document.
 *
 * `waste` is a fraction (0.15 means 15%).  `wastePercent` is accepted as a
 * convenience for callers reading a percentage from a form.
 */
export interface MaterialSettingsV2 {
  readonly strands?: number;
  readonly waste?: number;
  readonly wastePercent?: number;
  /** Calibrated physical length represented by one abstract stitch unit. */
  readonly stitchLengthMeters?: number;
  readonly metersPerStitch?: number;
  /** Optional physical length of one skein; required for skein conversion. */
  readonly skeinLength?: number;
  readonly skeinLengthMeters?: number;
  readonly metersPerSkein?: number;
}

/** A project-level fabric count. It intentionally lives outside the document binary. */
export const DEFAULT_AIDA_COUNT = 14;

/** One standard skein holds 8.7 yards. Estimates fall back to it when no skein length is calibrated. */
export const DEFAULT_SKEIN_LENGTH_METERS = 8.7 * 0.9144;
const THREE_QUARTER_WEIGHT = 0.75;

export function normalizeAidaCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new DomainError('invalid-aida-count', 'Aida count must be a finite number greater than zero.');
  }
  return value;
}

/** Display units for measurement readouts. Metric is the default when absent. */
export type DisplayUnits = 'metric' | 'imperial';

export function normalizeDisplayUnits(value: unknown): DisplayUnits {
  if (value !== 'metric' && value !== 'imperial') {
    throw new DomainError('invalid-units', 'Display units must be either metric or imperial.');
  }
  return value;
}

export interface MaterialSettingsUpdate {
  readonly strands?: number;
  readonly waste?: number;
  readonly stitchLengthMeters?: number | null;
  readonly skeinLengthMeters?: number | null;
}

export interface MetricsOptions extends MaterialSettingsV2 {
  /** Optional project metadata supplied to the derived metrics layer. */
  readonly aidaCount?: number;
  readonly material?: MaterialSettingsV2;
  readonly materialSettings?: MaterialSettingsV2;
  readonly settings?: MaterialSettingsV2;
}

export interface NormalizedMaterialSettings {
  readonly strands: number;
  readonly waste: number;
  readonly stitchLengthMeters?: number;
  readonly skeinLengthMeters?: number;
}

export interface FinishedSize {
  readonly widthInches: number;
  readonly heightInches: number;
  readonly widthCm: number;
  readonly heightCm: number;
}

export interface EstimateRange {
  readonly min: number;
  readonly max: number;
}

export interface MaterialEstimateAssumptions {
  readonly model: 'aida' | 'manual-calibration';
  readonly aidaCount?: number;
  readonly strands: number;
  readonly waste: number;
  readonly singleStrandFullCrossInchesAt14?: number;
  readonly backstitchStrands?: number;
  readonly backstitchUndersideMultiplier?: number;
  readonly note: string;
}

export interface MaterialEstimateRange {
  readonly meters: EstimateRange;
  readonly skeins?: EstimateRange;
}

export interface StitchCounts {
  readonly full: number;
  readonly half: number;
  readonly quarter: number;
  /** Number of persisted three-quarter stitches. */
  readonly threeQuarter?: number;
  readonly backstitch: number;
}

export interface ComponentCounts {
  readonly totalComponents: number;
  readonly completedComponents: number;
  readonly remainingComponents: number;
}

export interface BackstitchLengths {
  /** Length in the document's fixed-point coordinate units. */
  readonly fixed: number;
  /** Length in cells (fixed-point units divided by four). */
  readonly cells: number;
}

export interface MaterialEstimate {
  readonly paletteId: number;
  /** Full-cell equivalents before strands and waste are applied. */
  readonly stitchUnits: number;
  /** Abstract strand-units after multiplying by the configured strand count. */
  readonly strandLength: number;
  /** Abstract strand-units after adding waste; not a physical length. */
  readonly estimatedLength: number;
  /** Physical length, present with either Aida modelling or stitch calibration. */
  readonly estimatedMeters?: number;
  /** Fractional skeins, present only when an explicit skein length is supplied. */
  readonly estimatedSkeins?: number;
  /** Whole skeins required, present only when skein length is calibrated. */
  readonly requiredSkeins?: number;
  readonly materialUnit: MaterialUnit | undefined;
  /** Explicitly labelled assumptions and bounds for physical estimates. */
  readonly assumptions?: MaterialEstimateAssumptions;
  readonly estimateRange?: MaterialEstimateRange;
}

export interface PaletteMetrics extends StitchCounts, ComponentCounts {
  readonly paletteId: number;
  readonly backstitchLengthFixed: number;
  readonly backstitchLength: number;
  readonly material: MaterialEstimate;
}

export interface TotalMetrics extends StitchCounts, ComponentCounts {
  readonly backstitchLengthFixed: number;
  readonly backstitchLength: number;
}

export interface ProgressMetrics {
  readonly completedComponents: number;
  readonly remainingComponents: number;
  readonly totalComponents: number;
  /** A value in the closed interval [0, 1]. */
  readonly fraction: number;
  /** A value in the closed interval [0, 100]. */
  readonly percent: number;
}

export interface PatternMetrics {
  readonly palettes: readonly PaletteMetrics[];
  /** A stable-ID lookup, useful when the palette is reordered. */
  readonly byPalette: ReadonlyMap<number, PaletteMetrics>;
  readonly totals: TotalMetrics;
  readonly progress: ProgressMetrics;
  /** The same progress fraction as `progress.fraction`, for simple displays. */
  readonly overallProgress: number;
  readonly materials: readonly MaterialEstimate[];
  readonly materialSettings: NormalizedMaterialSettings;
  readonly finishedSize?: FinishedSize;
  /** Aggregate estimate across all palette colors, when a physical model applies. */
  readonly totalMaterial?: Omit<MaterialEstimate, 'paletteId'>;
}

export const DEFAULT_MATERIAL_SETTINGS: NormalizedMaterialSettings = {
  strands: 1,
  waste: 0
};

type MaterialSettingsRecord = Record<string, unknown>;

function asRecord(value: unknown): MaterialSettingsRecord {
  return typeof value === 'object' && value !== null ? value as MaterialSettingsRecord : {};
}

function readFirst(record: MaterialSettingsRecord, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function requiredPositive(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new DomainError('invalid-material-settings', `${label} must be a finite number greater than zero.`);
  return value;
}

function requiredNonNegative(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new DomainError('invalid-material-settings', `${label} must be a finite non-negative number.`);
  return value;
}

function aidaCountFrom(value: unknown): number | undefined {
  return value === undefined ? undefined : normalizeAidaCount(value);
}

/** Resolve and validate the non-derived inputs used by material estimates. */
export function normalizeMaterialSettings(
  document: PatternDocument,
  options?: MetricsOptions | MaterialSettingsV2
): NormalizedMaterialSettings {
  const documentSettings = asRecord(document.settings as PatternSettings);
  const supplied = asRecord(options);
  const documentMaterial = asRecord(documentSettings.material);
  const optionSettings = asRecord(supplied.settings ?? supplied.materialSettings);
  const nested = asRecord(supplied.material);
  const source: MaterialSettingsRecord = {
    ...documentSettings,
    ...documentMaterial,
    ...optionSettings,
    ...supplied,
    ...nested
  };

  return normalizeMaterialAssumptions(source as MaterialSettingsV2);
}

/** Normalize persisted or user-edited material assumptions to canonical keys. */
export function normalizeMaterialAssumptions(value: MaterialSettingsV2 | undefined): NormalizedMaterialSettings {
  if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) throw new DomainError('invalid-material-settings', 'Material settings must be an object.');
  const source = asRecord(value);
  const wastePercent = readFirst(source, ['wastePercent', 'wastePercentage']);
  const rawWaste = wastePercent === undefined ? readFirst(source, ['waste', 'wasteFraction']) : undefined;
  const aidaCount = aidaCountFrom(readFirst(source, ['aidaCount']));
  const waste = wastePercent !== undefined
    ? requiredNonNegative(wastePercent, 'Waste percent') / 100
    : rawWaste === undefined
      ? DEFAULT_MATERIAL_SETTINGS.waste
      // `waste` is always a canonical fraction. In particular, a value over
      // one is not silently reinterpreted as a percentage on a later load.
      : requiredNonNegative(rawWaste, 'Waste');
  const strandsValue = readFirst(source, ['strands', 'strandCount', 'strandsPerStitch']);
  const stitchLengthValue = readFirst(source, ['stitchLengthMeters', 'metersPerStitch']);
  const skeinLengthValue = readFirst(source, ['skeinLengthMeters', 'skeinLength', 'metersPerSkein']);
  // Aida projects have useful physical estimates without a manual calibration.
  // Keep the historical abstract defaults for documents that have no project
  // fabric metadata, while allowing either Aida default to be overridden.
  const strands = strandsValue === undefined ? (aidaCount === undefined ? DEFAULT_MATERIAL_SETTINGS.strands : 2) : requiredPositive(strandsValue, 'Strands');
  const stitchLengthMeters = stitchLengthValue === undefined ? undefined : requiredPositive(stitchLengthValue, 'Stitch length');
  const skeinLengthMeters = skeinLengthValue === undefined ? undefined : requiredPositive(skeinLengthValue, 'Skein length');
  return {
    strands,
    waste,
    ...(stitchLengthMeters === undefined ? {} : { stitchLengthMeters }),
    ...(skeinLengthMeters === undefined ? {} : { skeinLengthMeters })
  };
}

/** Read and validate the optional project count from metrics options. */
export function getMetricsAidaCount(options?: MetricsOptions | MaterialSettingsV2): number | undefined {
  const supplied = asRecord(options);
  const nested = asRecord(supplied.material);
  const nestedSettings = asRecord(supplied.settings ?? supplied.materialSettings);
  const raw = supplied.aidaCount !== undefined
    ? supplied.aidaCount
    : nested.aidaCount !== undefined
      ? nested.aidaCount
      : nestedSettings.aidaCount;
  return aidaCountFrom(raw);
}

/** Derive the stitched dimensions without mutating a document or its metadata. */
export function deriveFinishedSize(document: Pick<PatternDocument, 'width' | 'height'>, aidaCount: number): FinishedSize;
export function deriveFinishedSize(width: number, height: number, aidaCount: number): FinishedSize;
export function deriveFinishedSize(
  widthOrDocument: number | Pick<PatternDocument, 'width' | 'height'>,
  heightOrAidaCount: number,
  suppliedAidaCount?: number
): FinishedSize {
  const width = typeof widthOrDocument === 'number' ? widthOrDocument : widthOrDocument.width;
  const height = typeof widthOrDocument === 'number' ? heightOrAidaCount : widthOrDocument.height;
  const aidaCount = typeof widthOrDocument === 'number' ? suppliedAidaCount : heightOrAidaCount;
  if (aidaCount === undefined) throw new DomainError('invalid-aida-count', 'Aida count must be a finite number greater than zero.');
  const count = normalizeAidaCount(aidaCount);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) {
    throw new DomainError('invalid-dimensions', 'Finished-size dimensions must be finite non-negative numbers.');
  }
  const widthInches = width / count;
  const heightInches = height / count;
  return { widthInches, heightInches, widthCm: widthInches * 2.54, heightCm: heightInches * 2.54 };
}

export const calculateFinishedSize = deriveFinishedSize;
export const getFinishedSize = deriveFinishedSize;

export function updateMaterialSettings(current: NormalizedMaterialSettings | undefined, changes: MaterialSettingsUpdate): NormalizedMaterialSettings {
  const next: Record<string, unknown> = { ...normalizeMaterialAssumptions(current), ...changes };
  if (changes.stitchLengthMeters === null) delete next.stitchLengthMeters;
  if (changes.skeinLengthMeters === null) delete next.skeinLengthMeters;
  return normalizeMaterialAssumptions(next as MaterialSettingsV2);
}

export function isMaterialCalibrated(settings: NormalizedMaterialSettings): boolean {
  // A thread-length calibration is sufficient to report metres. Skein
  // conversion is a separate, explicitly supplied calibration.
  return settings.stitchLengthMeters !== undefined;
}

/**
 * Return a backstitch length without converting the endpoints to floating
 * point cell coordinates first.  Endpoints are integer quarter-cell values,
 * so the fixed-point result is exact for horizontal and vertical segments.
 */
export function fixedPointBackstitchLength(
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.hypot(dx, dy);
}

/** Return both useful units for a backstitch segment. */
export function backstitchLengths(
  x1: number,
  y1: number,
  x2: number,
  y2: number
): BackstitchLengths {
  const fixed = fixedPointBackstitchLength(x1, y1, x2, y2);
  return { fixed, cells: fixed / FIXED_POINT_UNITS_PER_CELL };
}

interface MutableCounts {
  full: number;
  half: number;
  quarter: number;
  threeQuarter: number;
  backstitch: number;
  completedComponents: number;
  backstitchLengthFixed: number;
}

function emptyCounts(): MutableCounts {
  return {
    full: 0,
    half: 0,
    quarter: 0,
    threeQuarter: 0,
    backstitch: 0,
    completedComponents: 0,
    backstitchLengthFixed: 0
  };
}

function componentCount(counts: Pick<MutableCounts, 'full' | 'half' | 'quarter' | 'threeQuarter' | 'backstitch'>): number {
  return counts.full + counts.half + counts.quarter + counts.backstitch + counts.threeQuarter;
}

function toTotalMetrics(counts: MutableCounts): TotalMetrics {
  const totalComponents = componentCount(counts);
  return {
    full: counts.full,
    half: counts.half,
    quarter: counts.quarter,
    ...(counts.threeQuarter === 0 ? {} : { threeQuarter: counts.threeQuarter }),
    backstitch: counts.backstitch,
    backstitchLengthFixed: counts.backstitchLengthFixed,
    backstitchLength: counts.backstitchLengthFixed / FIXED_POINT_UNITS_PER_CELL,
    totalComponents,
    completedComponents: counts.completedComponents,
    remainingComponents: totalComponents - counts.completedComponents
  };
}

function addCounts(target: MutableCounts, source: MutableCounts): void {
  target.full += source.full;
  target.half += source.half;
  target.quarter += source.quarter;
  target.threeQuarter += source.threeQuarter;
  target.backstitch += source.backstitch;
  target.completedComponents += source.completedComponents;
  target.backstitchLengthFixed += source.backstitchLengthFixed;
}

export interface MaterialCountInput {
  readonly full: number;
  readonly half: number;
  readonly quarter: number;
  readonly threeQuarter?: number;
  readonly backstitchLengthFixed: number;
}

/**
 * Estimate material in abstract units and, when possible, physical metres.
 * Aida projects use the count-based thread-length model; a manual stitch
 * calibration overrides that model. Skeins still require an explicit skein
 * length.
 */
export function materialEstimateFromCounts(
  paletteId: number,
  counts: MaterialCountInput,
  materialUnit: MaterialUnit | undefined,
  settings: NormalizedMaterialSettings,
  aidaCount?: number
): MaterialEstimate {
  // A half is half of a full-cell equivalent, a quarter is one quarter, and
  // a three-quarter stitch is three quarters of a full-cell equivalent.
  const threeQuarter = counts.threeQuarter ?? 0;
  // Backstitches already carry their geometric length in cell units.
  const stitchUnits = counts.full
    + counts.half / 2
    + counts.quarter / 4
    + threeQuarter * THREE_QUARTER_WEIGHT
    + counts.backstitchLengthFixed / FIXED_POINT_UNITS_PER_CELL;
  const strandLength = stitchUnits * settings.strands;
  const calibratedStitchLength = settings.stitchLengthMeters;
  const estimatedLength = strandLength * (1 + settings.waste);
  const count = aidaCount === undefined ? undefined : normalizeAidaCount(aidaCount);
  const calibratedBaseMeters = calibratedStitchLength === undefined ? undefined : strandLength * calibratedStitchLength;
  const aidaBaseMeters = count === undefined
    ? undefined
    : (
      // Full crosses are 0.8 single-strand inches at 14-count. Backstitches
      // use their physical drawn line plus an underside allowance.
      (
        (
          counts.full * 0.8 * (14 / count)
          + counts.half * 0.8 * (14 / count) / 2
          + counts.quarter * 0.8 * (14 / count) / 4
          + threeQuarter * 0.8 * (14 / count) * THREE_QUARTER_WEIGHT
        ) * settings.strands
        // Backstitch is reported as one physical line of thread; it does not
        // inherit the cross-stitch strand multiplier.
        + (counts.backstitchLengthFixed / FIXED_POINT_UNITS_PER_CELL) * (1 / count) * 1.5
      ) / 39.37007874015748
    );
  // Manual calibration wins over the Aida model when both are supplied.
  const baseMeters = calibratedBaseMeters ?? aidaBaseMeters;
  const estimatedMeters = baseMeters === undefined ? undefined : baseMeters * (1 + settings.waste);
  const skeinLengthMeters = settings.skeinLengthMeters ?? DEFAULT_SKEIN_LENGTH_METERS;
  const estimatedSkeins = estimatedMeters === undefined
    ? undefined
    : estimatedMeters / skeinLengthMeters;
  const assumptions: MaterialEstimateAssumptions | undefined = baseMeters === undefined
    ? undefined
    : count === undefined
      ? {
        model: 'manual-calibration',
        strands: settings.strands,
        waste: settings.waste,
        note: 'Estimated from the manually calibrated thread length per abstract stitch unit; actual use varies.'
      }
      : {
        model: calibratedStitchLength === undefined ? 'aida' : 'manual-calibration',
        aidaCount: count,
        strands: settings.strands,
        waste: settings.waste,
        ...(calibratedStitchLength === undefined ? { singleStrandFullCrossInchesAt14: 0.8, backstitchStrands: 1, backstitchUndersideMultiplier: 1.5 } : {}),
        note: calibratedStitchLength === undefined
          ? 'Aida estimate: 0.8 single-strand inches (2.03 cm) per full cross at 14-count, scaled by count; half and quarter stitches are proportional and backstitch includes 1.5× underside.'
          : 'Manual stitch-length calibration overrides the Aida thread-length model; actual use varies.'
      };
  const estimateRange: MaterialEstimateRange | undefined = baseMeters === undefined || estimatedMeters === undefined
    ? undefined
    : {
      meters: { min: baseMeters, max: estimatedMeters },
      skeins: { min: baseMeters / skeinLengthMeters, max: estimatedSkeins ?? 0 }
    };

  return {
    paletteId,
    stitchUnits,
    strandLength,
    estimatedLength,
    ...(estimatedMeters === undefined ? {} : { estimatedMeters }),
    ...(estimatedSkeins === undefined ? {} : { estimatedSkeins, requiredSkeins: Math.ceil(estimatedSkeins) }),
    materialUnit,
    ...(assumptions === undefined ? {} : { assumptions }),
    ...(estimateRange === undefined ? {} : { estimateRange })
  };
}

const makeEstimate = materialEstimateFromCounts;

function withoutPaletteId(estimate: MaterialEstimate): Omit<MaterialEstimate, 'paletteId'> {
  const aggregate = { ...estimate } as Omit<MaterialEstimate, 'paletteId'> & { paletteId?: number };
  delete aggregate.paletteId;
  return aggregate;
}

function incrementPaletteCount(counts: MutableCounts, kind: number, completed: number): void {
  if (kind === CellKind.Full) {
    counts.full += 1;
    if ((completed & 1) !== 0) counts.completedComponents += 1;
  } else if (kind === CellKind.HalfBackslash || kind === CellKind.HalfSlash) {
    counts.half += 1;
    if ((completed & 1) !== 0) counts.completedComponents += 1;
  } else if (isThreeQuarterSingleKind(kind)) {
    counts.threeQuarter += 1;
    if ((completed & 1) !== 0) counts.completedComponents += 1;
  }
}

/**
 * Scan the dense cell arrays and sparse backstitch arrays once.  The returned
 * metrics are newly allocated; this function never adds caches to or mutates
 * the supplied document.
 */
export function computePatternMetrics(
  document: PatternDocument,
  options?: MetricsOptions | MaterialSettingsV2
): PatternMetrics {
  const settings = normalizeMaterialSettings(document, options);
  const aidaCount = getMetricsAidaCount(options);
  const byId = new Map<number, MutableCounts>();
  const paletteEntries = new Map(document.palette.map((entry) => [entry.id, entry]));

  // Keep palette order in the result while allowing stable-ID lookup during
  // the scan.  A malformed document can contain a referenced ID not present
  // in its palette; retaining that usage is more useful than silently losing
  // it, and does not alter the document.
  const ensure = (paletteId: number): MutableCounts => {
    let counts = byId.get(paletteId);
    if (counts === undefined) {
      counts = emptyCounts();
      byId.set(paletteId, counts);
    }
    return counts;
  };
  for (const entry of document.palette) ensure(entry.id);

  // Valid documents have equal lengths, but bounding the scan by the arrays
  // also keeps this read-only helper safe when handed an unvalidated draft.
  const cellCount = Math.min(
    document.width * document.height,
    document.kind.length,
    document.completed.length,
    Math.floor(document.colors.length / 4)
  );
  for (let index = 0; index < cellCount; index += 1) {
    const kind = document.kind[index];
    const offset = index * 4;
    const completion = document.completed[index];

    if (kind === CellKind.Full || kind === CellKind.HalfBackslash || kind === CellKind.HalfSlash || isThreeQuarterSingleKind(kind)) {
      const color = document.colors[offset];
      if (color !== 0) incrementPaletteCount(ensure(color), kind, completion);
    } else if (isThreeQuarterPairKind(kind)) {
      for (let slot = 0; slot < 4; slot += 1) {
        const color = document.colors[offset + slot];
        if (color === 0) continue;
        const counts = ensure(color);
        counts.threeQuarter += 1;
        if ((completion & (1 << slot)) !== 0) counts.completedComponents += 1;
      }
    } else if (kind === CellKind.Quarters) {
      // Quarter completion bits are tied to slots, not to the order in which
      // occupied quarters happen to be encountered.
      for (let slot = 0; slot < 4; slot += 1) {
        const color = document.colors[offset + slot];
        if (color === 0) continue;
        const counts = ensure(color);
        counts.quarter += 1;
        if ((completion & (1 << slot)) !== 0) counts.completedComponents += 1;
      }
    }
  }

  const store = document.backstitches;
  for (let index = 0; index < store.ids.length; index += 1) {
    const counts = ensure(store.colors[index]);
    counts.backstitch += 1;
    counts.backstitchLengthFixed += fixedPointBackstitchLength(
      store.x1[index],
      store.y1[index],
      store.x2[index],
      store.y2[index]
    );
    if (store.completed[index] !== 0) counts.completedComponents += 1;
  }

  const totalCounts = emptyCounts();
  const palettes: PaletteMetrics[] = [];
  const materials: MaterialEstimate[] = [];
  const emitted = new Set<number>();
  const emit = (paletteId: number): void => {
    if (emitted.has(paletteId)) return;
    emitted.add(paletteId);
    const counts = byId.get(paletteId) ?? emptyCounts();
    const entry = paletteEntries.get(paletteId);
    const material = makeEstimate(paletteId, counts, entry?.material.unit, settings, aidaCount);
    const total = toTotalMetrics(counts);
    const palette: PaletteMetrics = { paletteId, ...total, material };
    palettes.push(palette);
    materials.push(material);
    addCounts(totalCounts, counts);
  };
  for (const entry of document.palette) emit(entry.id);
  // Preserve usage in malformed documents, as described above, without
  // changing the order of valid palette entries.
  for (const paletteId of byId.keys()) emit(paletteId);

  const totals = toTotalMetrics(totalCounts);
  const fraction = totals.totalComponents === 0
    ? 0
    : totals.completedComponents / totals.totalComponents;
  const progress: ProgressMetrics = {
    completedComponents: totals.completedComponents,
    remainingComponents: totals.remainingComponents,
    totalComponents: totals.totalComponents,
    fraction,
    percent: fraction * 100
  };

  const totalMaterial = makeEstimate(0, totalCounts, undefined, settings, aidaCount);

  return {
    palettes,
    byPalette: new Map(palettes.map((palette) => [palette.paletteId, palette])),
    totals,
    progress,
    overallProgress: fraction,
    materials,
    materialSettings: settings,
    ...(aidaCount === undefined ? {} : { finishedSize: deriveFinishedSize(document.width, document.height, aidaCount) }),
    ...(totalMaterial.assumptions === undefined ? {} : { totalMaterial: withoutPaletteId(totalMaterial) })
  };
}

/** Compute just the per-palette portion of the derived metrics. */
export function computePaletteMetrics(
  document: PatternDocument,
  options?: MetricsOptions | MaterialSettingsV2
): readonly PaletteMetrics[] {
  return computePatternMetrics(document, options).palettes;
}

/** Compute just overall component completion and progress. */
export function computeProgressMetrics(document: PatternDocument): ProgressMetrics {
  return computePatternMetrics(document).progress;
}

/** Compute the material estimates for all palette entries. */
export function computeMaterialEstimates(
  document: PatternDocument,
  options?: MetricsOptions | MaterialSettingsV2
): readonly MaterialEstimate[] {
  return computePatternMetrics(document, options).materials;
}

/** Explicit name for the all-in-one, single-pass metrics calculation. */
export const computeMetricsSinglePass = computePatternMetrics;
export const computeAllPatternMetrics = computePatternMetrics;

// Keep the public vocabulary forgiving for callers that use “derive” or
// “calculate” for a pure read model.  All aliases retain the same semantics.
export const derivePatternMetrics = computePatternMetrics;
export const calculatePatternMetrics = computePatternMetrics;
export const deriveMetrics = computePatternMetrics;
export const calculateMetrics = computePatternMetrics;
export const getPatternMetrics = computePatternMetrics;
export const getPaletteMetrics = computePaletteMetrics;
export const estimateMaterial = computeMaterialEstimates;
export const estimateMaterials = computeMaterialEstimates;
