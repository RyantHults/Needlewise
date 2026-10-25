import {
  addMetricCounts,
  emptyMetricCounts,
  MetricCounter,
  metricsFromCounts,
  normalizeMaterialSettings,
  resolveMetricsAidaCount,
  scanCounts,
  type MetricCounts,
  type MetricsOptions,
  type PatternDocument,
  type PatternMetrics,
  type PatternSettings,
  type ProgressMetrics
} from '../domain';

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
 * Maintains the derived metrics read model for the layered editor's
 * composite, recounting only the cells each change reports.
 */
export class ProgressMetricsService {
  private currentDocument: PatternDocument;
  private options: MetricsOptions | undefined;
  private aidaCount: number | undefined;
  private settings: PatternMetrics['materialSettings'];
  private counts: Map<number, MetricCounts>;
  private current: PatternMetrics;
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
    this.shadow = { kind: document.kind.slice(), colors: document.colors.slice(), completed: document.completed.slice() };
    this.shadowBackstitches = backstitchCounts(document);
    this.shadowSettings = document.settings;
  }

  get metrics(): PatternMetrics {
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
    return settingsChanged;
  }

  recalculate(document: PatternDocument): PatternMetrics {
    this.currentDocument = document;
    this.aidaCount = resolveMetricsAidaCount(document, this.options);
    this.settings = normalizeMaterialSettings(document, this.options);
    this.counts = scanCounts(document);
    this.current = metricsFromCounts(document, this.counts, this.settings, this.aidaCount);
    this.shadow = { kind: document.kind.slice(), colors: document.colors.slice(), completed: document.completed.slice() };
    this.shadowBackstitches = backstitchCounts(document);
    this.shadowSettings = document.settings;
    return this.current;
  }
}
