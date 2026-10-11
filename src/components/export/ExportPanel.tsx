import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectWorkspace } from '../../application/workspace';
import { computePatternMetrics } from '../../domain';
import type { DisplayUnits, PatternDocument } from '../../domain';
import {
  EXPORT_CELL_SIZES_MM,
  EXPORT_CHART_STYLES,
  MAX_EXPORT_OVERLAP,
  MIN_EXPORT_OVERLAP,
  buildLegend,
  estimateTotalPages,
  loadExportSettings,
  normalizeExportSettings,
  saveExportSettings,
  type ExportChartStyle,
  type ExportMargins,
  type ExportOrientation,
  type ExportPaper,
  type ExportSettings,
  type ExportSettingsStorage
} from '../../export';
import { Modal } from '../Modal';
import { PHYSICAL_ESTIMATE_UNAVAILABLE, finishedSizeLine, formatLength, formatSkeins, number, pdfFilename, stitchSummary } from './material-format';
import './export-panel.css';

export interface ExportPdfOptions {
  readonly signal: AbortSignal;
  /** Fraction complete, 0 to 1. */
  readonly onProgress: (fraction: number) => void;
}

export type ExportPdf = (settings: ExportSettings, options: ExportPdfOptions) => Promise<Uint8Array>;

export type ExportPanelWorkspace = Pick<ProjectWorkspace, 'activeProjectId' | 'metadata' | 'materialSettings' | 'updateActiveMaterialSettings' | 'updateActiveMetadata' | 'updateActiveAidaCount'>;

export interface ExportPanelProps {
  /** The flattened visible composite, the same input as the viewer. */
  document: PatternDocument;
  /** Pattern name; becomes the PDF filename. */
  title: string;
  workspace: ExportPanelWorkspace;
  exportPdf: ExportPdf;
  /** Where export settings persist; defaults to `localStorage`. */
  storage?: ExportSettingsStorage;
}

export interface ExportDialogProps extends ExportPanelProps {
  onClose: () => void;
}

/** Common fabric counts; the project's current count is added when it is not one of these. */
const AIDA_COUNTS: readonly number[] = [11, 14, 16, 18, 20, 22, 25, 28, 32];

const MATERIAL_AUTOSAVE_MS = 400;

/** Labels for `EXPORT_CELL_SIZES_MM`, in the same order. */
const STITCH_SIZE_LABELS: readonly string[] = ['Small', 'Medium', 'Large'];

const CHART_STYLE_LABELS: Record<ExportChartStyle, string> = { symbol: 'Symbols', color: 'Color', combined: 'Color and symbols' };

type MaterialDraft = { strands: string; backstitchStrands: string; waste: string };
type Run = { status: 'idle' } | { status: 'running'; progress: number } | { status: 'done' | 'cancelled'; message: string } | { status: 'error'; message: string };

const draftOf = (settings: { strands: number; backstitchStrands?: number; waste: number } | null): MaterialDraft => ({
  strands: String(settings?.strands ?? 1),
  backstitchStrands: String(settings?.backstitchStrands ?? 1),
  waste: number((settings?.waste ?? 0) * 100)
});

const isPositiveInteger = (text: string) => /^\d+$/.test(text.trim()) && Number(text) >= 1;

function validateDraft(draft: MaterialDraft): Partial<Record<keyof MaterialDraft, string>> {
  const errors: Partial<Record<keyof MaterialDraft, string>> = {};
  if (!isPositiveInteger(draft.strands)) errors.strands = 'Strands per stitch must be a whole number of at least 1.';
  if (!isPositiveInteger(draft.backstitchStrands)) errors.backstitchStrands = 'Backstitch strands must be a whole number of at least 1.';
  const waste = Number(draft.waste);
  if (draft.waste.trim() === '' || !Number.isFinite(waste) || waste < 0) errors.waste = 'Waste allowance must be zero or more.';
  return errors;
}

/** Material settings, thread totals, export settings, and the PDF export. Content only; wrap in `ExportDialog` for a modal. */
export function ExportPanel({ document: pattern, title, workspace, exportPdf, storage }: ExportPanelProps) {
  const [materialSettings, setMaterialSettings] = useState(workspace.materialSettings);
  const [units, setUnits] = useState<DisplayUnits>(workspace.metadata?.units ?? 'metric');
  const [draft, setDraft] = useState<MaterialDraft>(() => draftOf(workspace.materialSettings));
  const [errors, setErrors] = useState<Partial<Record<keyof MaterialDraft, string>>>({});
  const [saveMessage, setSaveMessage] = useState('');
  const [settings, setSettings] = useState<ExportSettings>(() => loadExportSettings(storage));
  const [run, setRun] = useState<Run>({ status: 'idle' });
  const controller = useRef<AbortController | null>(null);

  // Settings belong to the active project; do not carry a previous project's draft over.
  useEffect(() => {
    setMaterialSettings(workspace.materialSettings);
    setUnits(workspace.metadata?.units ?? 'metric');
    setDraft(draftOf(workspace.materialSettings));
    setErrors({});
    setSaveMessage('');
  }, [workspace.activeProjectId]);

  useEffect(() => () => controller.current?.abort(), []);

  const metrics = useMemo(() => {
    try {
      return computePatternMetrics(pattern, materialSettings ?? undefined);
    } catch {
      return null;
    }
  }, [pattern, materialSettings]);
  const legend = useMemo(() => (metrics ? buildLegend(pattern.palette, metrics, units) : null), [pattern.palette, metrics, units]);
  const empty = legend === null || legend.rows.length === 0;
  const pages = estimateTotalPages(pattern.width, pattern.height, settings, legend?.rows.length ?? 0);
  const running = run.status === 'running';
  const finished = metrics ? finishedSizeLine(metrics.finishedSize, units) : null;

  const updateDraft = (field: keyof MaterialDraft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setSaveMessage('');
  };

  const draftDirty = () => {
    const saved = draftOf(materialSettings);
    return draft.strands !== saved.strands || draft.backstitchStrands !== saved.backstitchStrands || draft.waste !== saved.waste;
  };

  /** Validate and save the draft. Returns false when it is invalid or the save failed. */
  const commitDraft = async (): Promise<boolean> => {
    const found = validateDraft(draft);
    setErrors(found);
    setSaveMessage('');
    if (Object.keys(found).length > 0) return false;
    try {
      await workspace.updateActiveMaterialSettings({
        strands: Number(draft.strands),
        backstitchStrands: Number(draft.backstitchStrands),
        waste: Number(draft.waste) / 100
      });
      setMaterialSettings(workspace.materialSettings);
      setSaveMessage('Material settings saved.');
      return true;
    } catch (error) {
      setErrors({ strands: error instanceof Error ? error.message : 'Material settings could not be saved.' });
      return false;
    }
  };

  // Material settings save themselves shortly after a valid edit. An invalid draft shows its error and waits.
  const commitRef = useRef(commitDraft);
  commitRef.current = commitDraft;
  const flushRef = useRef<() => void>(() => undefined);
  flushRef.current = () => {
    if (Object.keys(validateDraft(draft)).length === 0 && draftDirty()) void commitDraft();
  };
  useEffect(() => {
    const found = validateDraft(draft);
    setErrors(found);
    if (Object.keys(found).length > 0 || !draftDirty()) return undefined;
    const timer = window.setTimeout(() => void commitRef.current(), MATERIAL_AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [draft]);
  // Closing the dialog inside the debounce window must not drop the edit.
  useEffect(() => () => flushRef.current(), []);


  const changeUnits = async (next: DisplayUnits) => {
    if (next === units) return;
    setUnits(next);
    try {
      await workspace.updateActiveMetadata({ units: next });
    } catch {
      setUnits(units);
    }
  };

  const aidaCount = pattern.settings.aidaCount;
  const aidaOptions = AIDA_COUNTS.includes(aidaCount) ? AIDA_COUNTS : [...AIDA_COUNTS, aidaCount].sort((a, b) => a - b);
  const [aidaError, setAidaError] = useState('');
  const changeAidaCount = async (next: number) => {
    if (next === aidaCount) return;
    setAidaError('');
    try {
      await workspace.updateActiveAidaCount(next);
    } catch (error) {
      setAidaError(error instanceof Error ? error.message : 'The Aida count could not be saved.');
    }
  };

  const changeSettings = (changes: Partial<ExportSettings>) => {
    const next = normalizeExportSettings({ ...settings, ...changes });
    setSettings(next);
    saveExportSettings(next, storage);
  };

  const download = (bytes: Uint8Array) => {
    // Copy into a plain ArrayBuffer so the Blob never views a SharedArrayBuffer.
    const blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    try {
      const link = globalThis.document.createElement('a');
      link.href = url;
      link.download = pdfFilename(title);
      link.rel = 'noopener';
      globalThis.document.body.append(link);
      link.click();
      link.remove();
    } finally {
      // Revoking in the same tick can abort the download in Safari and older Firefox.
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  };

  const startExport = async () => {
    if (running || empty) return;
    const abort = new AbortController();
    controller.current = abort;
    setRun({ status: 'running', progress: 0 });
    try {
      // The export reads the saved settings, so what the form shows is what is exported.
      if (draftDirty() && !(await commitDraft())) {
        setRun({ status: 'idle' });
        return;
      }
      if (abort.signal.aborted) {
        setRun({ status: 'cancelled', message: 'Export cancelled.' });
        return;
      }
      const bytes = await exportPdf(settings, {
        signal: abort.signal,
        onProgress: (fraction) => {
          if (!abort.signal.aborted) setRun({ status: 'running', progress: Math.min(1, Math.max(0, fraction)) });
        }
      });
      if (abort.signal.aborted) {
        setRun({ status: 'cancelled', message: 'Export cancelled.' });
        return;
      }
      download(bytes);
      setRun({ status: 'done', message: `Exported ${pdfFilename(title)}.` });
    } catch (error) {
      if (abort.signal.aborted || (error instanceof Error && error.name === 'PdfExportCancelled')) setRun({ status: 'cancelled', message: 'Export cancelled.' });
      else setRun({ status: 'error', message: error instanceof Error && error.message ? error.message : 'The PDF could not be exported.' });
    } finally {
      if (controller.current === abort) controller.current = null;
    }
  };

  const cancelExport = () => controller.current?.abort();

  return (
    <div className="export-panel">
      <section className="export-section" aria-labelledby="export-material-title">
        <h3 id="export-material-title">Material settings</h3>
        <form className="export-form" onSubmit={(event) => event.preventDefault()} noValidate>
          <div className="export-field">
            <label htmlFor="export-strands">Strands per stitch</label>
            <input id="export-strands" type="number" inputMode="numeric" min="1" step="1" value={draft.strands} aria-invalid={errors.strands ? true : undefined} aria-describedby={errors.strands ? 'export-strands-error' : undefined} onChange={(event) => updateDraft('strands', event.target.value)} />
            {errors.strands && <p className="export-error" id="export-strands-error" role="alert">{errors.strands}</p>}
          </div>
          <div className="export-field">
            <label htmlFor="export-backstitch-strands">Backstitch strands</label>
            <input id="export-backstitch-strands" type="number" inputMode="numeric" min="1" step="1" value={draft.backstitchStrands} aria-invalid={errors.backstitchStrands ? true : undefined} aria-describedby={errors.backstitchStrands ? 'export-backstitch-error' : undefined} onChange={(event) => updateDraft('backstitchStrands', event.target.value)} />
            {errors.backstitchStrands && <p className="export-error" id="export-backstitch-error" role="alert">{errors.backstitchStrands}</p>}
          </div>
          <div className="export-field">
            <label htmlFor="export-waste">Waste allowance (%)</label>
            <input id="export-waste" type="number" inputMode="decimal" min="0" step="1" value={draft.waste} aria-invalid={errors.waste ? true : undefined} aria-describedby={errors.waste ? 'export-waste-error' : undefined} onChange={(event) => updateDraft('waste', event.target.value)} />
            {errors.waste && <p className="export-error" id="export-waste-error" role="alert">{errors.waste}</p>}
          </div>
          {saveMessage && <p className="export-note" role="status">{saveMessage}</p>}
        </form>
        <div className="export-field">
          <label htmlFor="export-aida-count">Aida count</label>
          <select id="export-aida-count" value={aidaCount} disabled={running} onChange={(event) => void changeAidaCount(Number(event.target.value))}>
            {aidaOptions.map((count) => <option key={count} value={count}>{count} count</option>)}
          </select>
          {aidaError && <p className="export-error" role="alert">{aidaError}</p>}
        </div>
        <div className="export-field" role="group" aria-labelledby="export-units-label">
          <span id="export-units-label" className="export-label">Display units</span>
          <div className="export-segmented">
            <button type="button" aria-pressed={units === 'metric'} onClick={() => void changeUnits('metric')}>Metric</button>
            <button type="button" aria-pressed={units === 'imperial'} onClick={() => void changeUnits('imperial')}>Imperial</button>
          </div>
        </div>
      </section>

      <section className="export-section" aria-labelledby="export-totals-title">
        <h3 id="export-totals-title">Thread totals</h3>
        {legend === null ? (
          <p className="export-note">Thread totals are unavailable for this pattern.</p>
        ) : (
          <>
            {finished && <p className="export-note">Finished size: {finished}</p>}
            <ul className="export-rows">
              {legend.rows.map((row) => (
                <li className="export-row" key={row.paletteId}>
                  <span className="export-swatch" style={{ background: row.color }} aria-hidden="true" />
                  <span className="export-row-main">
                    <strong>{row.name}{row.catalogCode && <small className="export-code">{row.catalogCode}</small>}</strong>
                    <span>{stitchSummary(row.counts)}</span>
                  </span>
                  <span className="export-row-estimate">
                    {row.skeins ? formatSkeins(row.skeins) : PHYSICAL_ESTIMATE_UNAVAILABLE}
                    {formatLength(row.length) && <span className="export-row-length">{formatLength(row.length)}</span>}
                  </span>
                </li>
              ))}
            </ul>
            <div className="export-total">
              <strong>Total</strong>
              <span>
                {legend.totals.skeins ? formatSkeins(legend.totals.skeins) : PHYSICAL_ESTIMATE_UNAVAILABLE}
                {formatLength(legend.totals.length) && <> · {formatLength(legend.totals.length)}</>}
              </span>
            </div>
            <p className="export-note">
              {legend.strands} strand{legend.strands === 1 ? '' : 's'} per stitch, {legend.backstitchStrands} backstitch strand{legend.backstitchStrands === 1 ? '' : 's'}, {number(legend.waste * 100)}% waste.
            </p>
            {!legend.note && <p className="export-note">Physical length is unavailable until an Aida count or manual stitch-length calibration is supplied.</p>}
          </>
        )}
      </section>

      <section className="export-section" aria-labelledby="export-settings-title">
        <h3 id="export-settings-title">PDF settings</h3>
        <div className="export-grid">
          <div className="export-field">
            <label htmlFor="export-paper">Paper size</label>
            <select id="export-paper" value={settings.paper} disabled={running} onChange={(event) => changeSettings({ paper: event.target.value as ExportPaper })}>
              <option value="letter">Letter</option>
              <option value="a4">A4</option>
            </select>
          </div>
          <div className="export-field">
            <label htmlFor="export-orientation">Orientation</label>
            <select id="export-orientation" value={settings.orientation} disabled={running} onChange={(event) => changeSettings({ orientation: event.target.value as ExportOrientation })}>
              <option value="portrait">Portrait</option>
              <option value="landscape">Landscape</option>
            </select>
          </div>
          <div className="export-field">
            <label htmlFor="export-margins">Margins</label>
            <select id="export-margins" value={settings.margins} disabled={running} onChange={(event) => changeSettings({ margins: event.target.value as ExportMargins })}>
              <option value="standard">Standard</option>
              <option value="narrow">Narrow</option>
            </select>
          </div>
          <div className="export-field">
            <label htmlFor="export-cell-size">Stitch size</label>
            <select id="export-cell-size" value={settings.cellSizeMm} disabled={running} onChange={(event) => changeSettings({ cellSizeMm: Number(event.target.value) })}>
              {EXPORT_CELL_SIZES_MM.map((size, index) => <option key={size} value={size}>{STITCH_SIZE_LABELS[index]}</option>)}
            </select>
          </div>
          <div className="export-field">
            <label htmlFor="export-chart-style">Chart style</label>
            <select id="export-chart-style" value={settings.chartStyle} disabled={running} onChange={(event) => changeSettings({ chartStyle: event.target.value as ExportChartStyle })}>
              {EXPORT_CHART_STYLES.map((style) => <option key={style} value={style}>{CHART_STYLE_LABELS[style]}</option>)}
            </select>
          </div>
          <div className="export-field">
            <label htmlFor="export-overlap">Page overlap (cells)</label>
            <select id="export-overlap" value={settings.overlap} disabled={running} onChange={(event) => changeSettings({ overlap: Number(event.target.value) })}>
              {Array.from({ length: MAX_EXPORT_OVERLAP - MIN_EXPORT_OVERLAP + 1 }, (_, index) => MIN_EXPORT_OVERLAP + index).map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>
          <div className="export-field">
            <span id="export-page-numbers-label" className="export-label">Page numbers</span>
            <button
              id="export-page-numbers"
              type="button"
              role="switch"
              className="export-toggle"
              aria-checked={settings.pageNumbers}
              aria-labelledby="export-page-numbers-label"
              disabled={running}
              onClick={() => changeSettings({ pageNumbers: !settings.pageNumbers })}
            >
              <span className="export-toggle-track" aria-hidden="true"><span className="export-toggle-thumb" /></span>
              <span className="export-toggle-text">{settings.pageNumbers ? 'On' : 'Off'}</span>
            </button>
          </div>
        </div>
        <p className="export-pages" data-testid="export-page-count">Estimated length: {pages} {pages === 1 ? 'page' : 'pages'}</p>
      </section>

      <section className="export-section" aria-labelledby="export-run-title">
        <h3 id="export-run-title">Export</h3>
        <div className="export-actions">
          <button className="button button-primary" type="button" disabled={running || empty} aria-describedby={empty ? 'export-empty-note' : undefined} onClick={() => void startExport()}>
            {running ? 'Exporting…' : 'Export PDF'}
          </button>
          {running && <button className="button button-secondary" type="button" onClick={cancelExport}>Cancel export</button>}
        </div>
        {empty && <p className="export-note" id="export-empty-note">Add stitches to the pattern before exporting.</p>}
        {run.status === 'running' && (
          <div className="export-progress">
            <progress aria-label="Export progress" max={1} value={run.progress} />
            <span>{Math.round(run.progress * 100)}%</span>
          </div>
        )}
        {run.status === 'error' && <p className="export-error" role="alert">{run.message}</p>}
        {(run.status === 'done' || run.status === 'cancelled') && <p className="export-note" role="status">{run.message}</p>}
      </section>
    </div>
  );
}

/** `ExportPanel` in a modal. Closing mid-export cancels it. */
export function ExportDialog({ onClose, ...panel }: ExportDialogProps) {
  return (
    <Modal className="export-dialog" titleId="export-title" eyebrow="Export" title="Export pattern" closeLabel="Close export" onClose={onClose}>
      <ExportPanel {...panel} />
    </Modal>
  );
}
