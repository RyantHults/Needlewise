import { isRecord } from '../domain/guards';
import { ChartPresentationMode } from '../editor/contracts';

export type ExportPaper = 'letter' | 'a4';
export type ExportOrientation = 'portrait' | 'landscape';
export type ExportMargins = 'standard' | 'narrow';
export type ExportChartStyle = typeof ChartPresentationMode.Symbol | typeof ChartPresentationMode.Color | typeof ChartPresentationMode.Combined;

export interface ExportSettings {
  readonly paper: ExportPaper;
  readonly orientation: ExportOrientation;
  readonly margins: ExportMargins;
  readonly pageNumbers: boolean;
  /** Draw the grid lines around the pattern's center bold red. The margin ticks print either way. */
  readonly centerMark: boolean;
  /** Crop the exported chart to the stitched content, dropping empty border rows and columns. */
  readonly autoCrop: boolean;
  /** Cells repeated between adjacent chart pages, 0 to 3. */
  readonly overlap: number;
  readonly cellSizeMm: number;
  readonly chartStyle: ExportChartStyle;
}

export const EXPORT_PAPERS: readonly ExportPaper[] = ['letter', 'a4'];
export const EXPORT_ORIENTATIONS: readonly ExportOrientation[] = ['portrait', 'landscape'];
export const EXPORT_MARGINS: readonly ExportMargins[] = ['standard', 'narrow'];
export const EXPORT_CELL_SIZES_MM: readonly number[] = [3.2, 4, 5];
export const EXPORT_CHART_STYLES: readonly ExportChartStyle[] = [
  ChartPresentationMode.Symbol,
  ChartPresentationMode.Color,
  ChartPresentationMode.Combined
];
export const MIN_EXPORT_OVERLAP = 0;
export const MAX_EXPORT_OVERLAP = 3;

/** Page sizes in PDF points. */
export const PAPER_SIZES_PT: Readonly<Record<ExportPaper, { readonly width: number; readonly height: number }>> = {
  letter: { width: 612, height: 792 },
  a4: { width: 595.28, height: 841.89 }
};

/** Margin on each side in PDF points. Standard is 1 in on Letter and 2.5 cm on A4. */
export const MARGIN_SIZES_PT: Readonly<Record<ExportPaper, Readonly<Record<ExportMargins, number>>>> = {
  letter: { standard: 72, narrow: 36 },
  a4: { standard: 70.87, narrow: 36 }
};

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  paper: 'letter',
  orientation: 'portrait',
  margins: 'standard',
  pageNumbers: true,
  centerMark: false,
  autoCrop: true,
  overlap: 0,
  cellSizeMm: 4,
  chartStyle: ChartPresentationMode.Symbol
};

export const EXPORT_SETTINGS_STORAGE_KEY = 'needlewise.export-settings.v1';

function oneOf<T>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? value as T : fallback;
}

/** Coerce unknown input to a complete, valid settings object; unknown or invalid fields take their defaults. */
export function normalizeExportSettings(value: unknown): ExportSettings {
  const source = isRecord(value) ? value : {};
  const defaults = DEFAULT_EXPORT_SETTINGS;
  const overlap = typeof source.overlap === 'number' && Number.isFinite(source.overlap)
    ? Math.min(MAX_EXPORT_OVERLAP, Math.max(MIN_EXPORT_OVERLAP, Math.round(source.overlap)))
    : defaults.overlap;
  return {
    paper: oneOf(source.paper, EXPORT_PAPERS, defaults.paper),
    orientation: oneOf(source.orientation, EXPORT_ORIENTATIONS, defaults.orientation),
    margins: oneOf(source.margins, EXPORT_MARGINS, defaults.margins),
    pageNumbers: typeof source.pageNumbers === 'boolean' ? source.pageNumbers : defaults.pageNumbers,
    centerMark: typeof source.centerMark === 'boolean' ? source.centerMark : defaults.centerMark,
    autoCrop: typeof source.autoCrop === 'boolean' ? source.autoCrop : defaults.autoCrop,
    overlap,
    cellSizeMm: oneOf(source.cellSizeMm, EXPORT_CELL_SIZES_MM, defaults.cellSizeMm),
    chartStyle: oneOf(source.chartStyle, EXPORT_CHART_STYLES, defaults.chartStyle)
  };
}

export type ExportSettingsStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): ExportSettingsStorage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** Read the saved settings, falling back to defaults when storage is absent, throws or holds garbage. */
export function loadExportSettings(storage: ExportSettingsStorage | undefined = defaultStorage()): ExportSettings {
  try {
    const raw = storage?.getItem(EXPORT_SETTINGS_STORAGE_KEY);
    return raw ? normalizeExportSettings(JSON.parse(raw)) : DEFAULT_EXPORT_SETTINGS;
  } catch {
    return DEFAULT_EXPORT_SETTINGS;
  }
}

/** Persist the settings. Returns false when storage is unavailable; callers need not handle errors. */
export function saveExportSettings(settings: ExportSettings, storage: ExportSettingsStorage | undefined = defaultStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(EXPORT_SETTINGS_STORAGE_KEY, JSON.stringify(normalizeExportSettings(settings)));
    return true;
  } catch {
    return false;
  }
}
