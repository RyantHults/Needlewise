import {
  CellKind,
  computePatternMetrics,
  FIXED_POINT_UNITS_PER_CELL,
  fixedPointBackstitchLength,
  materialEstimateFromCounts,
  normalizeMaterialSettings,
  getMetricsAidaCount,
  deriveFinishedSize,
  type CommandResult,
  type MetricsOptions,
  type NormalizedMaterialSettings,
  type PatternDocument,
  type PatternMetrics
} from '../domain';
import {
  deleteMetricsImpactForResult,
  type DeleteMetricsImpact,
  type DeleteMetricsImpactEntry,
  type DeleteMetricsImpactTarget
} from '../domain/internal-metrics-impact';

export interface ProgressActivityDelta {
  readonly marked: number;
  readonly unmarked: number;
}

export interface SessionProgressStats {
  readonly startedAt: number;
  readonly marked: number;
  readonly unmarked: number;
}

export type SessionStats = SessionProgressStats;

interface MutableCounts {
  full: number;
  half: number;
  quarter: number;
  backstitch: number;
  completedComponents: number;
  backstitchLengthFixed: number;
}

function zeroDelta(): ProgressActivityDelta {
  return { marked: 0, unmarked: 0 };
}

function emptyCounts(): MutableCounts {
  return { full: 0, half: 0, quarter: 0, backstitch: 0, completedComponents: 0, backstitchLengthFixed: 0 };
}

function completionCount(document: PatternDocument, index: number): number {
  if (index < 0 || index >= document.kind.length) return 0;
  const kind = document.kind[index];
  const offset = index * 4;
  if (kind === CellKind.Full || kind === CellKind.HalfBackslash || kind === CellKind.HalfSlash) return (document.colors[offset] !== 0 && (document.completed[index] & 1) !== 0) ? 1 : 0;
  if (kind !== CellKind.Quarters) return 0;
  let completed = 0;
  for (let slot = 0; slot < 4; slot += 1) {
    if (document.colors[offset + slot] !== 0 && (document.completed[index] & (1 << slot)) !== 0) completed += 1;
  }
  return completed;
}

function completionDelta(previous: number, next: number): ProgressActivityDelta {
  return next >= previous
    ? { marked: next - previous, unmarked: 0 }
    : { marked: 0, unmarked: previous - next };
}

function addDelta(left: ProgressActivityDelta, right: ProgressActivityDelta): ProgressActivityDelta {
  return { marked: left.marked + right.marked, unmarked: left.unmarked + right.unmarked };
}

function findBackstitch(document: PatternDocument, id: number): number {
  return document.backstitches.ids.findIndex((candidate) => candidate === id);
}

function backstitchCompletion(document: PatternDocument, id: number): number {
  const index = findBackstitch(document, id);
  return index < 0 ? 0 : document.backstitches.completed[index] === 0 ? 0 : 1;
}

function transitionForChangedSets(
  previous: PatternDocument,
  next: PatternDocument,
  cellIndices: Iterable<number>,
  backstitchIds: Iterable<number>
): ProgressActivityDelta {
  let delta = zeroDelta();
  for (const index of new Set<number>(cellIndices)) delta = addDelta(delta, completionDelta(completionCount(previous, index), completionCount(next, index)));
  for (const id of new Set<number>(backstitchIds)) delta = addDelta(delta, completionDelta(backstitchCompletion(previous, id), backstitchCompletion(next, id)));
  return delta;
}

function transitionByBoundedScan(previous: PatternDocument, next: PatternDocument): ProgressActivityDelta {
  let delta = zeroDelta();
  const cellCount = Math.max(previous.kind.length, next.kind.length);
  for (let index = 0; index < cellCount; index += 1) {
    delta = addDelta(delta, completionDelta(completionCount(previous, index), completionCount(next, index)));
  }

  const ids = new Set<number>([...previous.backstitches.ids, ...next.backstitches.ids]);
  for (const id of ids) delta = addDelta(delta, completionDelta(backstitchCompletion(previous, id), backstitchCompletion(next, id)));
  return delta;
}

function addCellCounts(target: Map<number, MutableCounts>, document: PatternDocument, index: number, multiplier: 1 | -1): void {
  if (index < 0 || index >= document.kind.length) return;
  const kind = document.kind[index];
  const offset = index * 4;
  const completion = document.completed[index];
  const add = (paletteId: number, completed: boolean, field: 'full' | 'half' | 'quarter'): void => {
    if (paletteId === 0) return;
    const counts = target.get(paletteId) ?? emptyCounts();
    counts[field] += multiplier;
    if (completed) counts.completedComponents += multiplier;
    target.set(paletteId, counts);
  };

  if (kind === CellKind.Full || kind === CellKind.HalfBackslash || kind === CellKind.HalfSlash) {
    add(document.colors[offset], (completion & 1) !== 0, kind === CellKind.Full ? 'full' : 'half');
  } else if (kind === CellKind.Quarters) {
    for (let slot = 0; slot < 4; slot += 1) add(document.colors[offset + slot], (completion & (1 << slot)) !== 0, 'quarter');
  }
}

function addBackstitchCounts(target: Map<number, MutableCounts>, document: PatternDocument, id: number, multiplier: 1 | -1): void {
  const index = findBackstitch(document, id);
  if (index < 0) return;
  const paletteId = document.backstitches.colors[index];
  if (paletteId === 0) return;
  const counts = target.get(paletteId) ?? emptyCounts();
  counts.backstitch += multiplier;
  counts.backstitchLengthFixed += multiplier * fixedPointBackstitchLength(
    document.backstitches.x1[index],
    document.backstitches.y1[index],
    document.backstitches.x2[index],
    document.backstitches.y2[index]
  );
  if (document.backstitches.completed[index] !== 0) counts.completedComponents += multiplier;
  target.set(paletteId, counts);
}

function countsFromMetrics(metrics: PatternMetrics): Map<number, MutableCounts> {
  return new Map(metrics.palettes.map((palette) => [palette.paletteId, {
    full: palette.full,
    half: palette.half,
    quarter: palette.quarter,
    backstitch: palette.backstitch,
    completedComponents: palette.completedComponents,
    backstitchLengthFixed: palette.backstitchLengthFixed
  }]));
}

function metricMaterial(
  paletteId: number,
  counts: MutableCounts,
  materialUnit: PatternMetrics['palettes'][number]['material']['materialUnit'],
  settings: PatternMetrics['materialSettings'],
  aidaCount?: number
): PatternMetrics['materials'][number] {
  return materialEstimateFromCounts(paletteId, counts, materialUnit, settings, aidaCount);
}

function buildMetrics(
  document: PatternDocument,
  countsByPalette: Map<number, MutableCounts>,
  settings: PatternMetrics['materialSettings'],
  aidaCount?: number
): PatternMetrics {
  const paletteEntries = new Map(document.palette.map((entry) => [entry.id, entry]));
  const paletteIds = [...document.palette.map((entry) => entry.id), ...[...countsByPalette.keys()].filter((id) => !paletteEntries.has(id))];
  const totals = emptyCounts();
  const palettes: PatternMetrics['palettes'][number][] = [];
  const materials: PatternMetrics['materials'][number][] = [];
  for (const paletteId of paletteIds) {
    const counts = countsByPalette.get(paletteId) ?? emptyCounts();
    const totalComponents = counts.full + counts.half + counts.quarter + counts.backstitch;
    const material = metricMaterial(paletteId, counts, paletteEntries.get(paletteId)?.material.unit, settings, aidaCount);
    const palette = {
      paletteId,
      full: counts.full,
      half: counts.half,
      quarter: counts.quarter,
      backstitch: counts.backstitch,
      backstitchLengthFixed: counts.backstitchLengthFixed,
      backstitchLength: counts.backstitchLengthFixed / FIXED_POINT_UNITS_PER_CELL,
      totalComponents,
      completedComponents: counts.completedComponents,
      remainingComponents: totalComponents - counts.completedComponents,
      material
    } as PatternMetrics['palettes'][number];
    palettes.push(palette);
    materials.push(material);
    totals.full += counts.full;
    totals.half += counts.half;
    totals.quarter += counts.quarter;
    totals.backstitch += counts.backstitch;
    totals.completedComponents += counts.completedComponents;
    totals.backstitchLengthFixed += counts.backstitchLengthFixed;
  }
  const totalComponents = totals.full + totals.half + totals.quarter + totals.backstitch;
  const fraction = totalComponents === 0 ? 0 : totals.completedComponents / totalComponents;
  const totalMetrics = {
    full: totals.full,
    half: totals.half,
    quarter: totals.quarter,
    backstitch: totals.backstitch,
    backstitchLengthFixed: totals.backstitchLengthFixed,
    backstitchLength: totals.backstitchLengthFixed / FIXED_POINT_UNITS_PER_CELL,
    totalComponents,
    completedComponents: totals.completedComponents,
    remainingComponents: totalComponents - totals.completedComponents
  };
  const progress = {
    completedComponents: totals.completedComponents,
    remainingComponents: totalMetrics.remainingComponents,
    totalComponents,
    fraction,
    percent: fraction * 100
  };
  const totalMaterial = materialEstimateFromCounts(0, totals, undefined, settings, aidaCount);
  const aggregateMaterial = { ...totalMaterial } as Omit<typeof totalMaterial, 'paletteId'> & { paletteId?: number };
  delete aggregateMaterial.paletteId;
  return {
    palettes,
    byPalette: new Map(palettes.map((palette) => [palette.paletteId, palette])),
    totals: totalMetrics,
    progress,
    overallProgress: fraction,
    materials,
    materialSettings: settings,
    ...(aidaCount === undefined ? {} : { finishedSize: deriveFinishedSize(document.width, document.height, aidaCount) }),
    ...(totalMaterial.assumptions === undefined ? {} : { totalMaterial: aggregateMaterial })
  };
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isValidImpactEntry(entry: DeleteMetricsImpactEntry): boolean {
  return Number.isSafeInteger(entry.paletteId) && entry.paletteId > 0
    && isNonNegativeInteger(entry.removedFull)
    && isNonNegativeInteger(entry.removedHalf)
    && isNonNegativeInteger(entry.removedQuarter)
    && isNonNegativeInteger(entry.removedCellCompleted)
    && isNonNegativeInteger(entry.beforeBackstitchCount)
    && isNonNegativeInteger(entry.afterBackstitchCount)
    && isNonNegativeInteger(entry.beforeBackstitchCompleted)
    && isNonNegativeInteger(entry.afterBackstitchCompleted)
    && Number.isFinite(entry.beforeBackstitchLengthFixed) && entry.beforeBackstitchLengthFixed >= 0
    && Number.isFinite(entry.afterBackstitchLengthFixed) && entry.afterBackstitchLengthFixed >= 0
    && entry.removedCellCompleted <= entry.removedFull + entry.removedHalf + entry.removedQuarter
    && entry.beforeBackstitchCompleted <= entry.beforeBackstitchCount
    && entry.afterBackstitchCompleted <= entry.afterBackstitchCount
    && entry.afterBackstitchCount <= entry.beforeBackstitchCount
    && entry.afterBackstitchCompleted <= entry.beforeBackstitchCompleted
    && entry.afterBackstitchLengthFixed <= entry.beforeBackstitchLengthFixed;
}

function cloneCounts(counts: MutableCounts): MutableCounts {
  return { ...counts };
}

function applyDeleteMetricsImpact(
  sourceCounts: Map<number, MutableCounts>,
  impact: DeleteMetricsImpact,
  target: DeleteMetricsImpactTarget
): Map<number, MutableCounts> | undefined {
  if (impact === null || typeof impact !== 'object' || (target !== 'before' && target !== 'after') || !Array.isArray(impact.entries) || impact.entries.length === 0) return undefined;
  const nextCounts = new Map<number, MutableCounts>();
  for (const [paletteId, counts] of sourceCounts) {
    if (!Number.isSafeInteger(paletteId) || !isNonNegativeInteger(counts.full) || !isNonNegativeInteger(counts.half) || !isNonNegativeInteger(counts.quarter) || !isNonNegativeInteger(counts.backstitch) || !isNonNegativeInteger(counts.completedComponents) || counts.completedComponents > counts.full + counts.half + counts.quarter + counts.backstitch || !Number.isFinite(counts.backstitchLengthFixed) || counts.backstitchLengthFixed < 0) return undefined;
    nextCounts.set(paletteId, cloneCounts(counts));
  }

  const seen = new Set<number>();
  let hasDeletedComponent = false;
  for (const entry of impact.entries) {
    if (entry === null || typeof entry !== 'object' || !isValidImpactEntry(entry) || seen.has(entry.paletteId)) return undefined;
    seen.add(entry.paletteId);
    if (entry.removedFull > 0 || entry.removedHalf > 0 || entry.removedQuarter > 0 || entry.beforeBackstitchCount !== entry.afterBackstitchCount) hasDeletedComponent = true;
    const current = sourceCounts.get(entry.paletteId);
    if (current === undefined) return undefined;

    const sourceBackstitchCount = target === 'after' ? entry.beforeBackstitchCount : entry.afterBackstitchCount;
    const targetBackstitchCount = target === 'after' ? entry.afterBackstitchCount : entry.beforeBackstitchCount;
    const sourceBackstitchCompleted = target === 'after' ? entry.beforeBackstitchCompleted : entry.afterBackstitchCompleted;
    const targetBackstitchCompleted = target === 'after' ? entry.afterBackstitchCompleted : entry.beforeBackstitchCompleted;
    const sourceBackstitchLength = target === 'after' ? entry.beforeBackstitchLengthFixed : entry.afterBackstitchLengthFixed;
    const targetBackstitchLength = target === 'after' ? entry.afterBackstitchLengthFixed : entry.beforeBackstitchLengthFixed;
    if (current.backstitch !== sourceBackstitchCount || current.backstitchLengthFixed !== sourceBackstitchLength || current.completedComponents < sourceBackstitchCompleted) return undefined;

    const sourceCellCompleted = current.completedComponents - sourceBackstitchCompleted;
    if (target === 'after' && sourceCellCompleted < entry.removedCellCompleted) return undefined;
    const cellDirection = target === 'after' ? -1 : 1;
    const next = {
      ...current,
      full: current.full + cellDirection * entry.removedFull,
      half: current.half + cellDirection * entry.removedHalf,
      quarter: current.quarter + cellDirection * entry.removedQuarter,
      backstitch: targetBackstitchCount,
      backstitchLengthFixed: targetBackstitchLength,
      completedComponents: sourceCellCompleted + cellDirection * entry.removedCellCompleted + targetBackstitchCompleted
    };
    if (!isNonNegativeInteger(next.full) || !isNonNegativeInteger(next.half) || !isNonNegativeInteger(next.quarter) || !isNonNegativeInteger(next.backstitch) || !isNonNegativeInteger(next.completedComponents) || !Number.isFinite(next.backstitchLengthFixed) || next.backstitchLengthFixed < 0 || next.completedComponents > next.full + next.half + next.quarter + next.backstitch) return undefined;
    nextCounts.set(entry.paletteId, next);
  }
  return hasDeletedComponent ? nextCounts : undefined;
}

/**
 * Maintains the derived metrics read model. Bulk commands use the exact
 * changed-index/changed-ID sets supplied by the domain; commands without a
 * change set use one bounded fallback scan and never cache into the domain.
 */
export class ProgressMetricsService {
  private currentDocument: PatternDocument;
  private options: MetricsOptions | undefined;
  private aidaCount: number | undefined;
  private settings: PatternMetrics['materialSettings'];
  private counts: Map<number, MutableCounts>;
  private current: PatternMetrics;
  private revision: number;

  constructor(document: PatternDocument, options?: MetricsOptions) {
    this.currentDocument = document;
    this.options = options;
    this.aidaCount = getMetricsAidaCount(options);
    this.current = computePatternMetrics(document, options);
    this.settings = normalizeMaterialSettings(document, options);
    this.counts = countsFromMetrics(this.current);
    this.revision = document.revision;
  }

  get metrics(): PatternMetrics {
    return this.current;
  }

  get snapshot(): PatternMetrics {
    return this.current;
  }

  getMetrics(): PatternMetrics {
    return this.current;
  }

  /** Replace calibration inputs and rebuild only the derived read model. */
  setMaterialSettings(options: MetricsOptions | undefined): PatternMetrics {
    this.options = options;
    this.aidaCount = getMetricsAidaCount(options);
    this.settings = normalizeMaterialSettings(this.currentDocument, options);
    this.current = computePatternMetrics(this.currentDocument, options);
    this.counts = countsFromMetrics(this.current);
    this.revision = this.currentDocument.revision;
    return this.current;
  }

  get materialSettings(): NormalizedMaterialSettings {
    return { ...this.settings };
  }

  /** Apply one command result and return only its marked/unmarked delta. */
  apply(result: CommandResult): ProgressActivityDelta;
  apply(previous: PatternDocument, result: CommandResult): ProgressActivityDelta;
  apply(previousOrResult: PatternDocument | CommandResult, suppliedResult?: CommandResult): ProgressActivityDelta {
    const previous = suppliedResult === undefined ? this.currentDocument : previousOrResult as PatternDocument;
    const result = suppliedResult ?? previousOrResult as CommandResult;
    const next = result.document;
    if (!result.changed || next.revision === this.revision) return zeroDelta();

    const hasExplicitProgress = result.progress !== undefined;
    const progressCellIndices = result.progress?.cellIndices ?? result.changedIndices ?? new Uint32Array(0);
    const progressBackstitchIds = result.progress?.backstitchIds ?? result.changedBackstitchIds ?? result.createdBackstitchIds ?? new Uint32Array(0);
    const hasChangeSet = result.changedIndices !== undefined || result.changedBackstitchIds !== undefined || result.createdBackstitchIds !== undefined;
    const progressDelta = result.progress === undefined
      ? undefined
      : { marked: result.progress.marked, unmarked: result.progress.unmarked };
    let delta: ProgressActivityDelta;
    const deleteImpact = deleteMetricsImpactForResult(result);
    if (deleteImpact !== undefined && result.recalculateMetrics === true && previous.revision === this.revision && next.revision === previous.revision + 1 && progressDelta !== undefined) {
      const nextCounts = applyDeleteMetricsImpact(this.counts, deleteImpact.impact, deleteImpact.target);
      if (nextCounts !== undefined) {
        this.current = buildMetrics(next, nextCounts, this.settings, this.aidaCount);
        this.counts = nextCounts;
        this.currentDocument = next;
        this.revision = next.revision;
        return progressDelta;
      }
    }
    if (result.recalculateMetrics === true || previous.revision !== this.revision) {
      delta = progressDelta ?? (hasExplicitProgress
        ? transitionForChangedSets(previous, next, progressCellIndices, progressBackstitchIds)
        : transitionByBoundedScan(previous, next));
      this.current = computePatternMetrics(next, this.options);
      this.counts = countsFromMetrics(this.current);
    } else if (!hasExplicitProgress && !hasChangeSet) {
      delta = transitionByBoundedScan(previous, next);
      this.current = computePatternMetrics(next, this.options);
      this.counts = countsFromMetrics(this.current);
    } else {
      delta = progressDelta ?? transitionForChangedSets(previous, next, progressCellIndices, progressBackstitchIds);
      const metricCellIndices = result.changedIndices ?? progressCellIndices;
      if (metricCellIndices.length > 0) {
        for (const index of new Set<number>(metricCellIndices)) {
          addCellCounts(this.counts, previous, index, -1);
          addCellCounts(this.counts, next, index, 1);
        }
      }
      const metricBackstitchIds = result.changedBackstitchIds ?? (result.createdBackstitchIds === undefined ? progressBackstitchIds : new Uint32Array(0));
      if (metricBackstitchIds.length > 0) {
        for (const id of new Set<number>(metricBackstitchIds)) {
          addBackstitchCounts(this.counts, previous, id, -1);
          addBackstitchCounts(this.counts, next, id, 1);
        }
      }
      if (!hasChangeSet && progressCellIndices.length === 0 && progressBackstitchIds.length === 0) {
        this.current = computePatternMetrics(next, this.options);
        this.counts = countsFromMetrics(this.current);
      } else {
        if (result.createdBackstitchIds !== undefined) for (const id of new Set<number>(result.createdBackstitchIds)) addBackstitchCounts(this.counts, next, id, 1);
        this.current = buildMetrics(next, this.counts, this.settings, this.aidaCount);
      }
    }
    this.currentDocument = next;
    this.revision = next.revision;
    return delta;
  }

  update(result: CommandResult): ProgressActivityDelta;
  update(previous: PatternDocument, result: CommandResult): ProgressActivityDelta;
  update(previousOrResult: PatternDocument | CommandResult, suppliedResult?: CommandResult): ProgressActivityDelta {
    return suppliedResult === undefined
      ? this.apply(previousOrResult as CommandResult)
      : this.apply(previousOrResult as PatternDocument, suppliedResult);
  }

  applyCommandResult(result: CommandResult): ProgressActivityDelta {
    return this.apply(result);
  }

  recalculate(document: PatternDocument): PatternMetrics {
    this.currentDocument = document;
    this.current = computePatternMetrics(document, this.options);
    this.counts = countsFromMetrics(this.current);
    this.revision = document.revision;
    return this.current;
  }
}

export const IncrementalProgressMetricsService = ProgressMetricsService;
export const IncrementalMetricsService = ProgressMetricsService;
