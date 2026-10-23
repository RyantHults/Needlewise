import { useEffect, useMemo, useRef, useState } from 'react';
import { buildImportedDocument, assignSymbolSlugs, maxImportColors, proposeMappings } from '../../import/build-document';
import { createPatternImportClient, type PatternImportClient } from '../../import/import-client';
import { ImportError, type ImportAnalysis, type ImportOverrides, type ImportPageRole, type ImportProgress, type SymbolMapping } from '../../import/types';
import { COMMON_AIDA_COUNTS, type PatternDocument } from '../../domain';
import { ConfirmDialog } from '../ConfirmDialog';
import { ErrorNotice, WarningNotice } from '../controls/Notice';
import { useLatestRequest } from '../latest-request';
import { Modal } from '../Modal';
import { ChartStep } from './ChartStep';
import { DetailsStep } from './DetailsStep';
import { KeyStep, type KeyRow } from './KeyStep';
import { PagesStep } from './PagesStep';
import { mappingColor } from './mapping';

export interface ImportedPatternRequest {
  document: PatternDocument;
  title: string;
  aidaCount: number;
  /** The importer id, e.g. `pdf`. */
  format: string;
}

interface Props {
  file: File;
  returnFocus?: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Saves the pattern; the caller navigates away on success. */
  onCreate: (request: ImportedPatternRequest) => Promise<void>;
}

const STEPS = ['Pages', 'Chart', 'Key', 'Details'] as const;
const DEFAULT_AIDA = 14;

const ERROR_MESSAGES: Record<string, string> = {
  'unsupported-format': 'This file type is not supported.',
  'unsupported-scanned-pdf': 'This PDF looks like a scan. Only charts exported from pattern software can be imported.',
  'encrypted-pdf': 'This PDF is password protected. Remove the protection and try again.',
  'invalid-pdf': 'This file could not be read as a PDF.',
  'no-chart-found': 'No cross stitch chart was found in this PDF. The chart needs a symbol printed in each stitched cell, because Needlewise reads the symbols to rebuild the pattern.',
  'unmapped-symbols': 'Some symbols have no thread. Choose one for each on the Key step.'
};

const messageFor = (error: unknown, fallback: string) =>
  error instanceof ImportError ? (error.code === 'too-large' || error.code === 'too-many-colors' ? error.message : ERROR_MESSAGES[error.code] ?? error.message) : fallback;

export function ImportReviewDialog({ file, returnFocus, onClose, onCreate }: Props) {
  const clientRef = useRef<PatternImportClient | null>(null);
  const request = useLatestRequest();
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [loadError, setLoadError] = useState('');
  const [working, setWorking] = useState(false);
  const [step, setStep] = useState(0);
  const [edits, setEdits] = useState<Record<string, SymbolMapping>>({});
  const [roles, setRoles] = useState<Record<number, ImportPageRole>>({});
  const [title, setTitle] = useState('');
  const [aida, setAida] = useState(String(DEFAULT_AIDA));
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [confirmingClose, setConfirmingClose] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const stepChanged = useRef(false);

  useEffect(() => {
    const isCurrent = request.begin();
    const client = createPatternImportClient();
    clientRef.current = client;
    const abort = new AbortController();
    void client.open(file, file.name, { signal: abort.signal, onProgress: (next) => { if (isCurrent()) setProgress(next); } }).then((first) => {
      if (!isCurrent()) return;
      setAnalysis(first);
      setTitle(first.chart.title ?? (file.name.replace(/\.pdf$/i, '') || 'Imported pattern'));
      const fabric = first.chart.fabricCount;
      if (fabric !== undefined && COMMON_AIDA_COUNTS.includes(fabric)) setAida(String(fabric));
    }).catch((error: unknown) => {
      if (isCurrent() && !(error instanceof ImportError && error.code === 'cancelled')) setLoadError(messageFor(error, 'This file could not be read.'));
    });
    return () => { request.cancel(); abort.abort(); client.dispose(); clientRef.current = null; };
  }, [file, request]);

  useEffect(() => {
    if (!stepChanged.current) return;
    headingRef.current?.focus();
  }, [step]);

  const proposals = useMemo(() => (analysis ? proposeMappings(analysis.chart) : []), [analysis]);
  const rows: KeyRow[] = useMemo(() => proposals.map((proposal) => {
    const edit = edits[proposal.symbolKey];
    if (edit) return { mapping: edit, status: 'matched' as const };
    return { mapping: { symbolKey: proposal.symbolKey, catalogCode: proposal.catalogCode, color: proposal.color, symbolSlug: proposal.symbolSlug }, status: proposal.status, reason: proposal.reason };
  }), [proposals, edits]);
  const mappings = useMemo(() => rows.map((row) => row.mapping), [rows]);
  const slugs = useMemo(() => (analysis ? assignSymbolSlugs(analysis.chart, mappings) : new Map<string, string>()), [analysis, mappings]);
  const colorLimit = maxImportColors();
  const overLimit = analysis !== null && analysis.chart.symbols.length > colorLimit;
  const unresolved = rows.filter((row) => !mappingColor(row.mapping)).length;

  /** Re-read with new overrides; `commit` runs only when the new analysis is the one on screen. */
  function rerun(overrides: ImportOverrides, commit: () => void) {
    const client = clientRef.current;
    if (!client) return;
    const isCurrent = request.begin();
    setWorking(true);
    setCreateError('');
    void client.reanalyze(overrides).then((next) => {
      if (!isCurrent()) return;
      commit();
      setAnalysis(next);
    }).catch((error: unknown) => {
      if (isCurrent()) setCreateError(messageFor(error, 'The pattern could not be re-read.'));
    }).finally(() => {
      if (isCurrent()) setWorking(false);
    });
  }
  function changeRole(page: number, role: ImportPageRole) {
    if (!analysis) return;
    const next = { ...Object.fromEntries(analysis.pages.map((candidate) => [candidate.index, candidate.role])), ...roles, [page]: role };
    rerun({ pageRoles: next }, () => setRoles(next));
  }
  /** Once an analysis is on screen, leaving would discard the review, so ask first. */
  function requestClose() {
    if (creating) return;
    if (analysis) setConfirmingClose(true);
    else onClose();
  }
  function goTo(next: number) {
    stepChanged.current = true;
    setStep(next);
  }
  async function create() {
    if (!analysis || creating) return;
    const isCurrent = request.current();
    setCreating(true);
    setCreateError('');
    try {
      const aidaCount = Number(aida);
      const document = buildImportedDocument(analysis.chart, mappings, { aidaCount });
      await onCreate({ document, title: title.trim() || 'Imported pattern', aidaCount, format: analysis.format });
    } catch (error) {
      if (isCurrent()) { setCreateError(messageFor(error, 'The pattern could not be saved locally.')); setCreating(false); }
    }
  }

  const empty = analysis !== null && (analysis.chart.width === 0 || analysis.chart.height === 0);
  const last = step === STEPS.length - 1;
  const busy = working || creating;
  const status = loadError ? '' : !analysis ? (progress ? `Reading page ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…` : 'Opening the PDF…') : working ? 'Re-reading the pattern…' : '';
  return (
    <Modal className="import-review-modal" eyebrow="New project" title="Import a pattern" titleId="import-dialog-title" closeLabel="Close import dialog" closeDisabled={creating} returnFocus={returnFocus} onEscape={requestClose} onClose={requestClose}>
      <p className="control-note import-file-name">{file.name}</p>
      <div aria-live="polite" className="import-status">{status}</div>
      {loadError && <ErrorNotice>{loadError}</ErrorNotice>}
      {!analysis && !loadError && <progress className="import-progress" aria-label="Reading the PDF" max={progress?.total || undefined} value={progress ? progress.done : undefined} />}
      {loadError && <button className="button button-secondary" type="button" onClick={onClose}>Close</button>}
      {analysis && (
        <>
          <ol className="import-steps" aria-label="Import steps">
            {STEPS.map((label, index) => (
              <li key={label} aria-current={index === step ? 'step' : undefined} data-done={index < step}>{index + 1}. {label}</li>
            ))}
          </ol>
          <section className="import-step" aria-labelledby="import-step-title" aria-busy={working}>
            <h3 id="import-step-title" ref={headingRef} tabIndex={-1}>{STEPS[step]}</h3>
            {step === 0 && <PagesStep analysis={analysis} disabled={busy} onRole={changeRole} />}
            {step === 1 && <ChartStep colorLimit={colorLimit} analysis={analysis} mappings={mappings} slugs={slugs} />}
            {step === 2 && <KeyStep chart={analysis.chart} rows={rows} disabled={busy} onChoose={(mapping) => setEdits((current) => ({ ...current, [mapping.symbolKey]: mapping }))} />}
            {step === 3 && <DetailsStep title={title} aida={aida} onTitle={setTitle} onAida={setAida} />}
          </section>
          {step === 2 && unresolved > 0 && <WarningNotice>{unresolved} {unresolved === 1 ? 'symbol has' : 'symbols have'} no thread yet. Choose one before creating the pattern.</WarningNotice>}
          {empty && <WarningNotice>No chart pages are selected. Mark at least one page as a chart.</WarningNotice>}
          {overLimit && step !== 1 && <WarningNotice>This chart uses {analysis.chart.symbols.length} colors, but at most {colorLimit} are supported.</WarningNotice>}
          {createError && <ErrorNotice>{createError}</ErrorNotice>}
          <div className="import-actions">
            <button className="button button-secondary" type="button" disabled={busy || step === 0} onClick={() => goTo(step - 1)}>Back</button>
            {last
              ? <button className="button button-primary" type="button" disabled={busy || empty || overLimit || unresolved > 0} onClick={() => void create()}>{creating ? 'Creating…' : 'Create pattern'}</button>
              : <button className="button button-primary" type="button" disabled={busy || (step > 0 && empty)} onClick={() => goTo(step + 1)}>Next</button>}
          </div>
        </>
      )}
      {confirmingClose && (
        <ConfirmDialog
          title="Leave import?"
          message="Your progress on this import will be lost."
          confirmLabel="Leave"
          cancelLabel="Keep importing"
          onConfirm={() => { setConfirmingClose(false); onClose(); }}
          onCancel={() => setConfirmingClose(false)}
        />
      )}
    </Modal>
  );
}
