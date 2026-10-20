import {
  addMetricCounts,
  completedComponentCount,
  emptyMetricCounts,
  MetricCounter,
  metricsFromCounts,
  normalizeMaterialSettings,
  positionsById,
  progressActivity,
  resolveMetricsAidaCount,
  scanCounts,
  type CommandResult,
  type MetricCounts,
  type MetricsOptions,
  type NormalizedMaterialSettings,
  type PatternDocument,
  type PatternMetrics,
  type PatternSettings,
  type ProgressMetrics
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

function zeroDelta(): ProgressActivityDelta {
  return { marked: 0, unmarked: 0 };
}

function addDelta(left: ProgressActivityDelta, right: ProgressActivityDelta): ProgressActivityDelta {
  return { marked: left.marked + right.marked, unmarked: left.unmarked + right.unmarked };
}

function backstitchCompletion(document: PatternDocument, positions: ReadonlyMap<number, number>, id: number): number {
  const index = positions.get(id);
  return index === undefined ? 0 : document.backstitches.completed[index] === 0 ? 0 : 1;
}

function transitionForChangedSets(
  previous: PatternDocument,
  next: PatternDocument,
  cellIndices: Iterable<number>,
  backstitchIds: Iterable<number>
): ProgressActivityDelta {
  let delta = zeroDelta();
  for (const index of new Set<number>(cellIndices)) delta = addDelta(delta, progressActivity(completedComponentCount(previous, index), completedComponentCount(next, index)));
  const ids = new Set<number>(backstitchIds);
  if (ids.size === 0) return delta;
  const previousPositions = positionsById(previous.backstitches);
  const nextPositions = positionsById(next.backstitches);
  for (const id of ids) delta = addDelta(delta, progressActivity(backstitchCompletion(previous, previousPositions, id), backstitchCompletion(next, nextPositions, id)));
  return delta;
}

function transitionByBoundedScan(previous: PatternDocument, next: PatternDocument): ProgressActivityDelta {
  let delta = zeroDelta();
  const cellCount = Math.max(previous.kind.length, next.kind.length);
  for (let index = 0; index < cellCount; index += 1) {
    delta = addDelta(delta, progressActivity(completedComponentCount(previous, index), completedComponentCount(next, index)));
  }

  const ids = new Set<number>([...previous.backstitches.ids, ...next.backstitches.ids]);
  const previousPositions = positionsById(previous.backstitches);
  const nextPositions = positionsById(next.backstitches);
  for (const id of ids) delta = addDelta(delta, progressActivity(backstitchCompletion(previous, previousPositions, id), backstitchCompletion(next, nextPositions, id)));
  return delta;
}

type CellPlanes = Pick<PatternDocument, 'kind' | 'colors' | 'completed'>;

function backstitchCounts(document: PatternDocument): Map<number, MetricCounts> {
  const counts = new Map<number, MetricCounts>();
  const counter = new MetricCounter(counts);
  for (let index = 0; index < document.backstitches.ids.length; index += 1) counter.backstitch(document.backstitches, index, 1);
  return counts;
}

function addPaletteCounts(target: Map<number, MetricCounts>, source: ReadonlyMap<number, MetricCounts>, multiplier: 1 | -1): void {
  for (const [paletteId, counts] of source) {
    let entry = target.get(paletteId);
    if (entry === undefined) {
      entry = emptyMetricCounts();
      target.set(paletteId, entry);
    }
    addMetricCounts(entry, counts, multiplier);
  }
}

/** What changed in a composite since the last count. */
export interface CompositeChange {
  /** Every cell may have changed. */
  readonly full: boolean;
  /** Changed cells when `full` is false; absent means no cell changed. */
  readonly indices?: Uint32Array;
}

/**
 * Palette-only document generations share every plane that contributes to a
 * count. Comparing plane identities avoids touching either the dense cell
 * arrays or the sparse backstitch arrays.
 */
function sharesCountBearingPlanes(previous: PatternDocument, next: PatternDocument): boolean {
  return previous.width === next.width
    && previous.height === next.height
    && previous.kind === next.kind
    && previous.colors === next.colors
    && previous.completed === next.completed
    && previous.backstitches.ids === next.backstitches.ids
    && previous.backstitches.x1 === next.backstitches.x1
    && previous.backstitches.y1 === next.backstitches.y1
    && previous.backstitches.x2 === next.backstitches.x2
    && previous.backstitches.y2 === next.backstitches.y2
    && previous.backstitches.colors === next.backstitches.colors
    && previous.backstitches.completed === next.backstitches.completed;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isValidImpactEntry(entry: DeleteMetricsImpactEntry): boolean {
  return Number.isSafeInteger(entry.paletteId) && entry.paletteId > 0
    && isNonNegativeInteger(entry.removedFull)
    && isNonNegativeInteger(entry.removedHalf)
    && isNonNegativeInteger(entry.removedQuarter)
    && isNonNegativeInteger(entry.removedThreeQuarter)
    && isNonNegativeInteger(entry.removedCellCompleted)
    && isNonNegativeInteger(entry.beforeBackstitchCount)
    && isNonNegativeInteger(entry.afterBackstitchCount)
    && isNonNegativeInteger(entry.beforeBackstitchCompleted)
    && isNonNegativeInteger(entry.afterBackstitchCompleted)
    && Number.isFinite(entry.beforeBackstitchLengthFixed) && entry.beforeBackstitchLengthFixed >= 0
    && Number.isFinite(entry.afterBackstitchLengthFixed) && entry.afterBackstitchLengthFixed >= 0
    && entry.removedCellCompleted <= entry.removedFull + entry.removedHalf + entry.removedQuarter + entry.removedThreeQuarter
    && entry.beforeBackstitchCompleted <= entry.beforeBackstitchCount
    && entry.afterBackstitchCompleted <= entry.afterBackstitchCount
    && entry.afterBackstitchCount <= entry.beforeBackstitchCount
    && entry.afterBackstitchCompleted <= entry.beforeBackstitchCompleted
    && entry.afterBackstitchLengthFixed <= entry.beforeBackstitchLengthFixed;
}

function applyDeleteMetricsImpact(
  sourceCounts: Map<number, MetricCounts>,
  impact: DeleteMetricsImpact,
  target: DeleteMetricsImpactTarget
): Map<number, MetricCounts> | undefined {
  if (impact === null || typeof impact !== 'object' || (target !== 'before' && target !== 'after') || !Array.isArray(impact.entries) || impact.entries.length === 0) return undefined;
  const nextCounts = new Map<number, MetricCounts>();
  for (const [paletteId, counts] of sourceCounts) {
    if (!Number.isSafeInteger(paletteId) || !isNonNegativeInteger(counts.full) || !isNonNegativeInteger(counts.half) || !isNonNegativeInteger(counts.quarter) || !isNonNegativeInteger(counts.threeQuarter) || !isNonNegativeInteger(counts.backstitch) || !isNonNegativeInteger(counts.completedComponents) || counts.completedComponents > counts.full + counts.half + counts.quarter + counts.threeQuarter + counts.backstitch || !Number.isFinite(counts.backstitchLengthFixed) || counts.backstitchLengthFixed < 0) return undefined;
    nextCounts.set(paletteId, { ...counts });
  }

  const seen = new Set<number>();
  let hasDeletedComponent = false;
  for (const entry of impact.entries) {
    if (entry === null || typeof entry !== 'object' || !isValidImpactEntry(entry) || seen.has(entry.paletteId)) return undefined;
    seen.add(entry.paletteId);
    if (entry.removedFull > 0 || entry.removedHalf > 0 || entry.removedQuarter > 0 || entry.removedThreeQuarter > 0 || entry.beforeBackstitchCount !== entry.afterBackstitchCount) hasDeletedComponent = true;
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
      threeQuarter: current.threeQuarter + cellDirection * entry.removedThreeQuarter,
      backstitch: targetBackstitchCount,
      backstitchLengthFixed: targetBackstitchLength,
      completedComponents: sourceCellCompleted + cellDirection * entry.removedCellCompleted + targetBackstitchCompleted
    };
    if (!isNonNegativeInteger(next.full) || !isNonNegativeInteger(next.half) || !isNonNegativeInteger(next.quarter) || !isNonNegativeInteger(next.threeQuarter) || !isNonNegativeInteger(next.backstitch) || !isNonNegativeInteger(next.completedComponents) || !Number.isFinite(next.backstitchLengthFixed) || next.backstitchLengthFixed < 0 || next.completedComponents > next.full + next.half + next.quarter + next.threeQuarter + next.backstitch) return undefined;
    nextCounts.set(entry.paletteId, next);
  }
  return hasDeletedComponent ? nextCounts : undefined;
}

/**
 * One palette color's progress, backstitches included, or the whole
 * pattern's for `null`. A color with no stitches is zero of zero.
 */
export function paletteProgress(metrics: PatternMetrics, paletteId: number | null): ProgressMetrics {
  if (paletteId === null) return metrics.progress;
  const palette = metrics.byPalette.get(paletteId);
  const totalComponents = palette?.totalComponents ?? 0;
  const completedComponents = palette?.completedComponents ?? 0;
  const fraction = totalComponents === 0 ? 0 : completedComponents / totalComponents;
  return { completedComponents, remainingComponents: totalComponents - completedComponents, totalComponents, fraction, percent: fraction * 100 };
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
  private counts: Map<number, MetricCounts>;
  private current: PatternMetrics;
  private revision: number;
  // Copies of the composite's cell planes and backstitch totals as last
  // counted, so a change needs only the composite and its changed cells.
  private shadow: CellPlanes | null = null;
  private shadowBackstitches = new Map<number, MetricCounts>();
  private shadowSettings: PatternSettings | null = null;

  constructor(document: PatternDocument, options?: MetricsOptions) {
    this.currentDocument = document;
    this.options = options;
    this.aidaCount = resolveMetricsAidaCount(document, options);
    this.settings = normalizeMaterialSettings(document, options);
    this.counts = scanCounts(document);
    this.current = metricsFromCounts(document, this.counts, this.settings, this.aidaCount);
    this.revision = document.revision;
    this.shadow = { kind: document.kind.slice(), colors: document.colors.slice(), completed: document.completed.slice() };
    this.shadowBackstitches = backstitchCounts(document);
    this.shadowSettings = document.settings;
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
    return this.recalculate(this.currentDocument);
  }

  /**
   * Applies a change to the layered editor's composite: changed cells are
   * recounted against a private copy of their previous values, and
   * backstitches, palette and settings are re-read (flattening can dedupe or
   * reveal backstitches outside the command's own change set). Returns true
   * when the document settings changed.
   */
  applyComposite(composite: PatternDocument, change: CompositeChange): boolean {
    const settingsChanged = composite.settings !== this.shadowSettings;
    const shadow = this.shadow;
    // The domain reports the exact changed cells for layer edits and stack
    // changes (visibility, move, delete, merge, duplicate); only a full
    // invalidation, such as a palette merge, recounts every cell.
    if (change.full || shadow === null || shadow.kind.length !== composite.kind.length) {
      this.recalculate(composite);
      return settingsChanged;
    }
    const indices = change.indices;
    if (settingsChanged) {
      this.settings = normalizeMaterialSettings(composite, this.options);
      this.aidaCount = resolveMetricsAidaCount(composite, this.options);
      this.shadowSettings = composite.settings;
    }
    if (indices && indices.length > 0) {
      const counter = new MetricCounter(this.counts);
      // A repeated index is harmless: the shadow already matches on the second pass.
      for (const index of indices) {
        if (index >= composite.kind.length) continue;
        counter.cell(shadow, index, -1);
        const offset = index * 4;
        shadow.kind[index] = composite.kind[index];
        shadow.colors[offset] = composite.colors[offset];
        shadow.colors[offset + 1] = composite.colors[offset + 1];
        shadow.colors[offset + 2] = composite.colors[offset + 2];
        shadow.colors[offset + 3] = composite.colors[offset + 3];
        shadow.completed[index] = composite.completed[index];
        counter.cell(composite, index, 1);
      }
    }
    const backstitches = backstitchCounts(composite);
    addPaletteCounts(this.counts, this.shadowBackstitches, -1);
    addPaletteCounts(this.counts, backstitches, 1);
    this.shadowBackstitches = backstitches;
    this.current = metricsFromCounts(composite, this.counts, this.settings, this.aidaCount);
    this.currentDocument = composite;
    this.revision = composite.revision;
    return settingsChanged;
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
        this.current = metricsFromCounts(next, nextCounts, this.settings, this.aidaCount);
        this.counts = nextCounts;
        this.currentDocument = next;
        this.revision = next.revision;
        return progressDelta;
      }
    }
    if (previous.revision === this.revision && next.revision === previous.revision + 1 && sharesCountBearingPlanes(previous, next)) {
      const settings = previous.settings === next.settings ? this.settings : normalizeMaterialSettings(next, this.options);
      this.settings = settings;
      this.current = metricsFromCounts(next, this.counts, settings, this.aidaCount);
      this.currentDocument = next;
      this.revision = next.revision;
      return progressDelta ?? zeroDelta();
    }
    if (result.recalculateMetrics === true || previous.revision !== this.revision) {
      delta = progressDelta ?? (hasExplicitProgress
        ? transitionForChangedSets(previous, next, progressCellIndices, progressBackstitchIds)
        : transitionByBoundedScan(previous, next));
      this.rescan(next);
    } else if (!hasExplicitProgress && !hasChangeSet) {
      delta = transitionByBoundedScan(previous, next);
      this.rescan(next);
    } else {
      delta = progressDelta ?? transitionForChangedSets(previous, next, progressCellIndices, progressBackstitchIds);
      const metricCellIndices = result.changedIndices ?? progressCellIndices;
      const counter = new MetricCounter(this.counts);
      for (const index of new Set<number>(metricCellIndices)) {
        counter.cell(previous, index, -1);
        counter.cell(next, index, 1);
      }
      const metricBackstitchIds = result.changedBackstitchIds ?? (result.createdBackstitchIds === undefined ? progressBackstitchIds : new Uint32Array(0));
      if (metricBackstitchIds.length > 0) {
        const previousPositions = positionsById(previous.backstitches);
        const nextPositions = positionsById(next.backstitches);
        for (const id of new Set<number>(metricBackstitchIds)) {
          const before = previousPositions.get(id);
          const after = nextPositions.get(id);
          if (before !== undefined) counter.backstitch(previous.backstitches, before, -1);
          if (after !== undefined) counter.backstitch(next.backstitches, after, 1);
        }
      }
      if (!hasChangeSet && progressCellIndices.length === 0 && progressBackstitchIds.length === 0) {
        this.rescan(next);
      } else {
        if (result.createdBackstitchIds !== undefined) {
          const positions = positionsById(next.backstitches);
          for (const id of new Set<number>(result.createdBackstitchIds)) {
            const position = positions.get(id);
            if (position !== undefined) counter.backstitch(next.backstitches, position, 1);
          }
        }
        this.current = metricsFromCounts(next, this.counts, this.settings, this.aidaCount);
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

  /** Recounts `document` from scratch with its own material settings. */
  private rescan(document: PatternDocument): void {
    this.aidaCount = resolveMetricsAidaCount(document, this.options);
    this.settings = normalizeMaterialSettings(document, this.options);
    this.counts = scanCounts(document);
    this.current = metricsFromCounts(document, this.counts, this.settings, this.aidaCount);
  }

  recalculate(document: PatternDocument): PatternMetrics {
    this.currentDocument = document;
    this.aidaCount = resolveMetricsAidaCount(document, this.options);
    this.settings = normalizeMaterialSettings(document, this.options);
    this.counts = scanCounts(document);
    this.current = metricsFromCounts(document, this.counts, this.settings, this.aidaCount);
    this.revision = document.revision;
    this.shadow = { kind: document.kind.slice(), colors: document.colors.slice(), completed: document.completed.slice() };
    this.shadowBackstitches = backstitchCounts(document);
    this.shadowSettings = document.settings;
    return this.current;
  }
}

export const IncrementalProgressMetricsService = ProgressMetricsService;
export const IncrementalMetricsService = ProgressMetricsService;
