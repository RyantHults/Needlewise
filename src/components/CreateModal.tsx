import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { acceptConversionDraft, DEFAULT_CONVERSION_PALETTE_BUDGET, type ConversionDraft } from '../conversion/image-to-pattern';
import { ConversionCancelledError, convertImageToPattern } from '../conversion/image-conversion-client';
import { deriveFinishedSize } from '../domain';
import type { ProjectAssetInput } from '../persistence';
import type { CatalogSnapshot } from '../catalog';

type Props = { catalog: CatalogSnapshot; mode: 'blank' | 'image'; title: string; width: string; height: string; aida: string; busy: boolean; onMode: (mode: 'blank' | 'image') => void; onClose: () => void; onBlank: (event: React.FormEvent<HTMLFormElement>) => void; onConversionCreate: (draft: ReturnType<typeof acceptConversionDraft>, asset?: ProjectAssetInput) => Promise<string>; onCreated?: (projectId: string) => void; onDurableCreateChange?: (locked: boolean) => void; onTitle: (value: string) => void; onWidth: (value: string) => void; onHeight: (value: string) => void; onAida: (value: string) => void };
const validTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** Keep tiny patterns legible without changing their proportions. */
export function calculatePreviewSize(width: number, height: number) {
  const fit = Math.min(1, 420 / width, 285 / height);
  let scale = fit;
  let multiplier = 1;
  while (width * scale < 300 || height * scale < 300) {
    multiplier *= 2;
    scale = fit * multiplier;
  }
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

const number = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const rest = x % y;
    x = y;
    y = rest;
  }
  return x;
}

function divisors(value: number): number[] {
  const found: number[] = [];
  for (let d = 1; d * d <= value; d++) {
    if (value % d !== 0) continue;
    found.push(d);
    if (d * d !== value) found.push(value / d);
  }
  return found;
}

/** Suggest conversion target dims so the long side lands near targetInches at the given Aida count. Oversized images divide down by the common divisor whose long side lands closest to target (exact integers, no rounding); smaller images pass through unchanged. Never throws: invalid inputs return the natural dims. */
export function suggestConversionDimensions(naturalWidth: number, naturalHeight: number, aidaCount: number, targetInches = 14): { width: number; height: number } {
  const natural = { width: naturalWidth, height: naturalHeight };
  if (!Number.isInteger(naturalWidth) || !Number.isInteger(naturalHeight) || naturalWidth <= 0 || naturalHeight <= 0) return natural;
  if (!Number.isFinite(aidaCount) || aidaCount <= 0 || !Number.isFinite(targetInches) || targetInches <= 0) return natural;
  const naturalLong = Math.max(naturalWidth, naturalHeight);
  const targetLong = targetInches * aidaCount;
  if (naturalLong <= targetLong) return natural;
  let best: { divisor: number; long: number; diff: number } | null = null;
  for (const divisor of divisors(gcd(naturalWidth, naturalHeight))) {
    if (divisor < 2) continue;
    const width = naturalWidth / divisor;
    const height = naturalHeight / divisor;
    if (width < 1 || height < 1 || width > 1000 || height > 1000 || width * height > 1_000_000) continue;
    const long = Math.max(width, height);
    const diff = Math.abs(long - targetLong);
    if (best === null || diff < best.diff || (diff === best.diff && long < best.long)) best = { divisor, long, diff };
  }
  if (best !== null) return { width: naturalWidth / best.divisor, height: naturalHeight / best.divisor };
  // Fallback (rare: no exact division fits, e.g. coprime dims over the limits):
  // largest 2^k scale at or under the fit, as before.
  const scale = Math.pow(2, Math.floor(Math.log2(targetLong / naturalLong)));
  let width = Math.max(1, Math.round(naturalWidth * scale));
  let height = Math.max(1, Math.round(naturalHeight * scale));
  width = Math.min(width, 1000);
  height = Math.min(height, 1000);
  if (width * height > 1_000_000) {
    const shrink = Math.sqrt(1_000_000 / (width * height));
    width = Math.max(1, Math.floor(width * shrink));
    height = Math.max(1, Math.floor(height * shrink));
  }
  return { width, height };
}

/** Display-only finished-size preview for the creation modal. Null while inputs are invalid; never sets errors. */
export function previewFinishedSize(width: string, height: string, aida: string): string | null {
  const w = Number(width);
  const h = Number(height);
  const count = Number(aida);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 1000 || h > 1000 || w * h > 1_000_000) return null;
  if (!Number.isFinite(count) || count <= 0) return null;
  const size = deriveFinishedSize(w, h, count);
  return `\u2248 ${number(size.widthInches)} \u00d7 ${number(size.heightInches)} in (${number(size.widthCm)} \u00d7 ${number(size.heightCm)} cm) at ${number(count)}-count Aida`;
}

export const PREVIEW_LENS_SIZE = 160;
const PREVIEW_LENS_SCALE = 2;

/** Clamp math for the zoom lens: sampled region (bitmap px) + box position (CSS px). Pure, unit-testable in jsdom. */
export function previewLensGeometry(
  canvasWidth: number,
  canvasHeight: number,
  cssWidth: number,
  cssHeight: number,
  frameRect: { left: number; top: number; right: number; bottom: number },
  rect: { left: number; top: number; right: number; bottom: number },
  pointerX: number,
  pointerY: number
) {
  const canvasCssWidth = cssWidth || canvasWidth;
  const canvasCssHeight = cssHeight || canvasHeight;
  const xCss = pointerX - rect.left;
  const yCss = pointerY - rect.top;
  const sourceX = Math.min(Math.max(0, (xCss / canvasCssWidth) * canvasWidth), canvasWidth);
  const sourceY = Math.min(Math.max(0, (yCss / canvasCssHeight) * canvasHeight), canvasHeight);
  const half = PREVIEW_LENS_SIZE / (2 * PREVIEW_LENS_SCALE);
  const sampleSize = PREVIEW_LENS_SIZE / PREVIEW_LENS_SCALE;
  const sourceLeft = Math.max(0, Math.min(sourceX - half, canvasWidth - sampleSize));
  const sourceTop = Math.max(0, Math.min(sourceY - half, canvasHeight - sampleSize));
  const lensLeft = Math.max(0, Math.min(frameRect.right - frameRect.left - PREVIEW_LENS_SIZE, pointerX - frameRect.left - PREVIEW_LENS_SIZE / 2));
  const lensTop = Math.max(0, Math.min(frameRect.bottom - frameRect.top - PREVIEW_LENS_SIZE, pointerY - frameRect.top - PREVIEW_LENS_SIZE / 2));
  return {
    sourceLeft,
    sourceTop,
    sampleSize,
    lensLeft,
    lensTop
  };
}

/** Imperative 2x zoom lens over the review preview. No per-move re-renders. */
function updatePreviewLens(canvas: HTMLCanvasElement, lens: HTMLCanvasElement, frame: HTMLDivElement, pointerX: number, pointerY: number) {
  if (canvas.width < 1 || canvas.height < 1) return;
  const context = lens.getContext('2d');
  const frameRect = frame.getBoundingClientRect();
  const rect = canvas.getBoundingClientRect();
  // Position the lens box first (from the pure clamp math) so visibility and
  // follow behavior work even where getContext is unavailable (jsdom); the
  // drawing step is guarded on the context below.
  const geometry = previewLensGeometry(canvas.width, canvas.height, rect.width, rect.height, frameRect, rect, pointerX, pointerY);
  lens.style.left = `${geometry.lensLeft}px`;
  lens.style.top = `${geometry.lensTop}px`;
  lens.style.opacity = '1';
  if (!context) return;
  context.clearRect(0, 0, PREVIEW_LENS_SIZE, PREVIEW_LENS_SIZE);
  context.imageSmoothingEnabled = false;
  // Fill with the preview's empty-cell tone so empty regions read correctly.
  context.fillStyle = '#f3eee5';
  context.fillRect(0, 0, PREVIEW_LENS_SIZE, PREVIEW_LENS_SIZE);
  context.drawImage(canvas, geometry.sourceLeft, geometry.sourceTop, geometry.sampleSize, geometry.sampleSize, 0, 0, PREVIEW_LENS_SIZE, PREVIEW_LENS_SIZE);
}

export function CreateModal(props: Props) {
  const { catalog, mode, title, width, height, aida, busy, onMode, onClose, onBlank, onConversionCreate, onCreated, onDurableCreateChange, onTitle, onWidth, onHeight, onAida } = props;
  const [file, setFile] = useState<File | null>(null); const draftRef = useRef<ConversionDraft | null>(null); const [draftInfo, setDraftInfo] = useState<ConversionDraft | null>(null);
  const initialBudget = Math.min(DEFAULT_CONVERSION_PALETTE_BUDGET, catalog.association.colorCount);
  const [budget, setBudget] = useState(String(initialBudget)); const [budgetDraft, setBudgetDraft] = useState(String(initialBudget)); const [keepReference, setKeepReference] = useState(true); const [lockAspect, setLockAspect] = useState(true); const [backgroundSourceId, setBackgroundSourceId] = useState<string | null>(null); const [autoCrop, setAutoCrop] = useState(false); const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [status, setStatus] = useState<'idle' | 'updating' | 'converting' | 'ready' | 'creating' | 'error'>('idle'); const statusRef = useRef(status); statusRef.current = status; const [error, setError] = useState('');
  const generation = useRef(0); const abort = useRef<AbortController | null>(null); const decodeGeneration = useRef(0); const fileRef = useRef<File | null>(null); const dimensionPrefillSuppressed = useRef(false); const mounted = useRef(true); const durableLock = useRef(false); const previewRef = useRef<HTMLCanvasElement>(null); const frameRef = useRef<HTMLDivElement>(null); const lensRef = useRef<HTMLCanvasElement>(null); const lensVisible = useRef(false); const dialogRef = useRef<HTMLDivElement>(null);
  const [decodeStatus, setDecodeStatus] = useState<'idle' | 'decoding' | 'ready' | 'error'>('idle');
  type ConversionIdentity = { file: File; mode: 'blank' | 'image'; width: string; height: string; budget: string; backgroundSourceId: string | null; autoCrop: boolean; catalogId: string; brandLabel: string; colorCount: number };
  const acceptedIdentity = useRef<ConversionIdentity | null>(null);
  const previousCatalogAssociation = useRef({ ...catalog.association });
  const sameIdentity = (left: ConversionIdentity | null, right: ConversionIdentity | null) => Boolean(left && right && left.file === right.file && left.mode === right.mode && left.width === right.width && left.height === right.height && left.budget === right.budget && left.backgroundSourceId === right.backgroundSourceId && left.autoCrop === right.autoCrop && left.catalogId === right.catalogId && left.brandLabel === right.brandLabel && left.colorCount === right.colorCount);
  const cancelConversion = (preserveDraft = false) => { generation.current += 1; abort.current?.abort(); abort.current = null; if (!preserveDraft) { draftRef.current = null; acceptedIdentity.current = null; setDraftInfo(null); } setError(''); if (statusRef.current !== 'creating') setStatus(preserveDraft && draftRef.current ? 'updating' : 'idle'); };
  const cancelFileWork = () => { cancelConversion(); decodeGeneration.current += 1; fileRef.current = null; dimensionPrefillSuppressed.current = false; setDecodeStatus('idle'); setFile(null); setNaturalSize(null); setBackgroundSourceId(null); };
  useLayoutEffect(() => {
    const current = catalog.association;
    const previous = previousCatalogAssociation.current;
    if (previous.catalogId === current.catalogId && previous.brandLabel === current.brandLabel && previous.colorCount === current.colorCount) return;
    previousCatalogAssociation.current = { ...current };
    cancelConversion(true);
    const cappedBudget = Math.max(1, Math.min(Number(budget) || DEFAULT_CONVERSION_PALETTE_BUDGET, current.colorCount));
    setBudget(String(cappedBudget));
    setBudgetDraft(String(cappedBudget));
  }, [catalog.association.catalogId, catalog.association.brandLabel, catalog.association.colorCount]);
  const invalidatePendingDecode = () => {
    if (decodeStatus !== 'decoding') return;
    // Keep decoding the selected file. This only disables its automatic
    // dimension write; a successful decode is still required for conversion.
    dimensionPrefillSuppressed.current = true;
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current += 1; decodeGeneration.current += 1; abort.current?.abort(); }; }, []);
  useEffect(() => { if (mode !== 'image') cancelFileWork(); }, [mode]);
  useEffect(() => {
    const canvas = previewRef.current, draft = draftRef.current; if (!canvas || !draft) return; const context = canvas.getContext('2d'); if (!context) return; const size = calculatePreviewSize(draft.document.width, draft.document.height); canvas.width = size.width; canvas.height = size.height; const colors = new Map(draft.document.palette.map(e => [e.id, e.color])); const image = context.createImageData(canvas.width, canvas.height); for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) { const sx = Math.min(draft.document.width - 1, Math.floor(x * draft.document.width / canvas.width)); const sy = Math.min(draft.document.height - 1, Math.floor(y * draft.document.height / canvas.height)); const value = colors.get(draft.document.colors[(sy * draft.document.width + sx) * 4])?.replace('#', '') ?? 'f3eee5'; const offset = (y * canvas.width + x) * 4; image.data[offset] = parseInt(value.slice(0, 2), 16); image.data[offset + 1] = parseInt(value.slice(2, 4), 16); image.data[offset + 2] = parseInt(value.slice(4, 6), 16); image.data[offset + 3] = 255; } context.putImageData(image, 0, 0); hidePreviewLens(lensRef.current); }, [draftInfo]);
  function deriveLockedDimension(edited: string, axis: 'width' | 'height') {
    if (!lockAspect || !naturalSize) return;
    const naturalWidth = naturalSize.width, naturalHeight = naturalSize.height;
    if (naturalWidth < 1 || naturalHeight < 1) return;
    const editedValue = Number(edited);
    if (!Number.isFinite(editedValue) || editedValue < 0) return;
    const ratio = axis === 'width' ? naturalHeight / naturalWidth : naturalWidth / naturalHeight;
    let derived = Math.round(editedValue * ratio);
    derived = Math.max(1, Math.min(1000, derived));
    if (editedValue >= 1) derived = Math.max(1, Math.min(derived, Math.floor(1_000_000 / editedValue)));
    if (axis === 'width') onHeight(String(derived)); else onWidth(String(derived));
  }
  const handlePreviewEnter = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === 'touch') return;
    const canvas = previewRef.current, lens = lensRef.current, frame = frameRef.current;
    if (!canvas || !lens || !frame) return;
    lensVisible.current = true;
    updatePreviewLens(canvas, lens, frame, event.clientX, event.clientY);
  };
  const handlePreviewMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === 'touch' || !lensVisible.current) return;
    const canvas = previewRef.current, lens = lensRef.current, frame = frameRef.current;
    if (!canvas || !lens || !frame) return;
    updatePreviewLens(canvas, lens, frame, event.clientX, event.clientY);
  };
  const handlePreviewLeave = () => { hidePreviewLens(lensRef.current); };
  function hidePreviewLens(lens: HTMLCanvasElement | null) {
    if (!lens) return;
    lensVisible.current = false;
    lens.style.opacity = '0';
  }
  const commitBudget = (value: string) => {
    const parsed = Number(value);
    // Only commit a valid integer within bounds. Empty/garbage input just
    // reverts to the committed budget with no conversion churn.
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxBudgetColors) { setBudgetDraft(budget); return; }
    // Re-committing the current budget only normalizes the draft; a
    // conversion with identical inputs would churn the preview for nothing.
    if (String(parsed) === budget) { setBudgetDraft(budget); return; }
    setBudget(String(parsed)); setBudgetDraft(String(parsed)); cancelConversion(true);
  };
  const stepBudget = (delta: number) => {
    const next = Math.max(1, Math.min(Number(budget || '2') + delta, maxBudgetColors));
    // At a bound the stepper buttons are disabled, but guard the no-op so a
    // clamped step never marks the preview stale without scheduling a request.
    if (String(next) === budget) { setBudgetDraft(String(next)); return; }
    setBudget(String(next)); setBudgetDraft(String(next)); cancelConversion(true);
  };
  function validate() { const maxColors = Math.max(1, Math.min(catalog.association.colorCount, draftInfo?.stats.matchedColorCount ?? catalog.association.colorCount)); const w = Number(width), h = Number(height), colors = Number(budget); if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 1000 || h > 1000 || w * h > 1_000_000) { setError('Use whole-number dimensions from 1 to 1,000, with no more than 1,000,000 cells.'); return; } if (!Number.isInteger(colors) || colors < 1 || colors > maxColors) { setError(`Color budget must be a whole number from 1 to ${maxColors}.`); return; } return { w, h, colors }; }
  function chooseFile(next?: File) {
    if (statusRef.current === 'creating') return;
    cancelFileWork();
    fileRef.current = null;
    dimensionPrefillSuppressed.current = false;
    setFile(null);
    if (!next) return;
    if (!validTypes.has(next.type)) { setError('Choose a PNG, JPEG, or WebP image.'); setStatus('error'); return; }
    const decodeId = ++decodeGeneration.current;
    setDecodeStatus('decoding');
    fileRef.current = next;
    setFile(next);
    const url = URL.createObjectURL(next);
    const image = new Image();
    const stillCurrent = () => mounted.current && decodeId === decodeGeneration.current && fileRef.current === next;
    image.onload = () => { URL.revokeObjectURL(url); if (stillCurrent()) { if (!dimensionPrefillSuppressed.current) { const suggested = suggestConversionDimensions(image.naturalWidth, image.naturalHeight, Number(aida)); onWidth(String(suggested.width)); onHeight(String(suggested.height)); } setNaturalSize({ width: image.naturalWidth, height: image.naturalHeight }); setDecodeStatus('ready'); } };
    image.onerror = () => { URL.revokeObjectURL(url); if (stillCurrent()) { setDecodeStatus('error'); setStatus('error'); setError('The image dimensions could not be read. Choose a different image.'); } };
    image.src = url;
  }
  function convert() { if (!file || statusRef.current === 'creating') return; const config = validate(); if (!config) { setStatus('error'); return; } const identity: ConversionIdentity = { file, mode, width, height, budget, backgroundSourceId, autoCrop, catalogId: catalog.association.catalogId, brandLabel: catalog.association.brandLabel, colorCount: catalog.association.colorCount }; const id = ++generation.current; abort.current?.abort(); const signal = (abort.current = new AbortController()).signal; setError(''); setStatus('converting'); void convertImageToPattern(file, { projectId: 'new-pattern', baseRevision: 0, targetWidth: config.w, targetHeight: config.h, paletteBudget: config.colors, catalog, backgroundSourceId: backgroundSourceId ?? undefined, autoCrop: autoCrop || undefined, sourceImage: { mimeType: file.type } }, {}, { signal }).then(result => { const current: ConversionIdentity = { file, mode, width, height, budget, backgroundSourceId, autoCrop, catalogId: catalog.association.catalogId, brandLabel: catalog.association.brandLabel, colorCount: catalog.association.colorCount }; if (mounted.current && id === generation.current && sameIdentity(identity, current)) { draftRef.current = result.draft; acceptedIdentity.current = identity; setDraftInfo(result.draft); setStatus('ready'); const matchedMax = Math.max(1, Math.min(catalog.association.colorCount, result.draft.stats.matchedColorCount ?? catalog.association.colorCount)); if (Number(budget) > matchedMax) { setBudget(String(matchedMax)); setBudgetDraft(String(matchedMax)); } } }).catch(reason => { if (mounted.current && id === generation.current && !(reason instanceof ConversionCancelledError)) { setStatus('error'); setError(reason instanceof Error ? reason.message : 'The image could not be converted.'); } }); }
  // Status is deliberately not part of this effect.  A conversion changing from
  // converting -> ready/error is a result of the same request, not a new input.
  // Keeping the key to inputs also means each distinct input/config combination
  // gets one, and only one, debounce timer.
  useEffect(() => {
    // A file's decode is a separate lifecycle from conversion. In particular,
    // don't let the debounce consume the dimensions from the previous file.
    if (mode !== 'image' || !file || decodeStatus !== 'ready' || statusRef.current === 'creating') return;
    const timer = window.setTimeout(() => convert(), 300);
    return () => window.clearTimeout(timer);
  }, [mode, file, width, height, budget, backgroundSourceId, autoCrop, decodeStatus, catalog.association.catalogId, catalog.association.brandLabel, catalog.association.colorCount]);
  async function create() { const draft = draftRef.current; const identity = file ? { file, mode, width, height, budget, backgroundSourceId, autoCrop, catalogId: catalog.association.catalogId, brandLabel: catalog.association.brandLabel, colorCount: catalog.association.colorCount } : null; if (!draft || status !== 'ready' || !sameIdentity(acceptedIdentity.current, identity)) return; const id = generation.current; setStatus('creating'); durableLock.current = true; onDurableCreateChange?.(true); try { const projectId = await onConversionCreate(acceptConversionDraft(draft), keepReference && file ? { id: `source-${Date.now().toString(36)}`, name: file.name, mimeType: file.type, data: file } : undefined); durableLock.current = false; onDurableCreateChange?.(false); if (mounted.current && id === generation.current) { onCreated?.(projectId); onClose(); } } catch (reason) { durableLock.current = false; onDurableCreateChange?.(false); if (mounted.current && id === generation.current) { setStatus('ready'); setError(reason instanceof Error ? reason.message : 'The pattern could not be saved locally.'); } } }
  function close() { if (statusRef.current === 'creating') return; cancelFileWork(); onClose(); }
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const focusable = () => [...el.querySelectorAll<HTMLElement>('button,input,textarea,select')].filter((item) => !item.hasAttribute('disabled') && item.tabIndex >= 0);
    (focusable()[0] ?? el).focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab') return;
      const all = focusable(); const first = all[0]; const last = all.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && globalThis.document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && globalThis.document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    el.addEventListener('keydown', key);
    return () => { el.removeEventListener('keydown', key); };
  }, []);
  const palette = draftInfo?.document.palette ?? [];
  const maxBudgetColors = Math.max(1, Math.min(catalog.association.colorCount, draftInfo?.stats.matchedColorCount ?? catalog.association.colorCount));
  const currentIdentity: ConversionIdentity | null = file ? { file, mode, width, height, budget, backgroundSourceId, autoCrop, catalogId: catalog.association.catalogId, brandLabel: catalog.association.brandLabel, colorCount: catalog.association.colorCount } : null;
  const previewIsCurrent = sameIdentity(acceptedIdentity.current, currentIdentity);
  const finishedSizePreview = previewFinishedSize(width, height, aida);
  return <div className="modal-backdrop" role="presentation" onClick={e=>{if(e.target===e.currentTarget)close()}}><div ref={dialogRef} className="create-modal conversion-modal" role="dialog" aria-modal="true" aria-labelledby="create-dialog-title" tabIndex={-1}>
    <button className="modal-close" type="button" aria-label="Close create pattern dialog" disabled={status === 'creating'} onClick={close}>×</button><p className="section-label">New project</p><h2 id="create-dialog-title">Start a pattern</h2>
    <div className="creation-modes" role="radiogroup" aria-label="Creation mode"><button type="button" role="radio" tabIndex={mode === 'blank' ? 0 : -1} aria-checked={mode === 'blank'} onClick={() => onMode('blank')}>Blank canvas</button><button type="button" role="radio" tabIndex={mode === 'image' ? 0 : -1} aria-checked={mode === 'image'} onClick={() => onMode('image')}>From image</button></div>
    {mode === 'blank' ? <form onSubmit={onBlank}><label htmlFor="new-project-title">Title<input id="new-project-title" value={title} onChange={e => onTitle(e.target.value)} /></label><div className="dimension-fields"><label htmlFor="new-project-width">Width<input id="new-project-width" value={width} onChange={e => onWidth(e.target.value)} /></label><label htmlFor="new-project-height">Height<input id="new-project-height" value={height} onChange={e => onHeight(e.target.value)} /></label></div><label htmlFor="new-project-aida">Aida count<select id="new-project-aida" value={aida} onChange={e => onAida(e.target.value)}>{[11, 14, 16, 18, 22].map(x => <option key={x}>{x}</option>)}</select></label>{finishedSizePreview !== null && <p className="control-note">Expected finished size: {finishedSizePreview}</p>}<p className="control-note">Whole-number dimensions. Maximum 1,000,000 cells total.</p><button className="button button-primary" type="submit" disabled={busy}>Create blank pattern</button></form> : <section aria-label="Convert image" aria-busy={status === 'converting' || status === 'updating'}><label htmlFor="new-project-title">Title<input id="new-project-title" value={title} onChange={e => onTitle(e.target.value)} /></label><label className="file-drop" htmlFor="conversion-image">Choose a PNG, JPEG, or WebP image<input id="conversion-image" className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" onChange={e => chooseFile(e.target.files?.[0])} />{file && <strong>{file.name}</strong>}</label>{file && decodeStatus === 'ready' && <div className="conversion-controls"><fieldset className="dimension-fields aspect-dimensions"><legend>Total stitch count</legend><label htmlFor="conversion-width">Width<input id="conversion-width" value={width} onChange={e => { cancelConversion(true); invalidatePendingDecode(); deriveLockedDimension(e.target.value, 'width'); onWidth(e.target.value); }} /></label><div className="aspect-lock-control"><span className="aspect-lock-label">aspect ratio</span><button type="button" className="aspect-lock-toggle" aria-pressed={lockAspect} aria-label="Lock aspect ratio" title={lockAspect ? 'Locked: output width and height keep the source image ratio' : 'Unlocked: output width and height are independent'} disabled={!naturalSize} onClick={() => setLockAspect(value => !value)}>{lockAspect ? '🔒' : '🔓'}</button></div><label htmlFor="conversion-height">Height<input id="conversion-height" value={height} onChange={e => { cancelConversion(true); invalidatePendingDecode(); deriveLockedDimension(e.target.value, 'height'); onHeight(e.target.value); }} /></label></fieldset><label htmlFor="conversion-aida">Aida count<select id="conversion-aida" value={aida} onChange={e => onAida(e.target.value)}>{[11, 14, 16, 18, 22].map(x => <option key={x}>{x}</option>)}</select></label><label className="check-row"><input type="checkbox" checked={autoCrop} onChange={e => { cancelConversion(true); setAutoCrop(e.target.checked); }} />Auto-crop to content edges</label><label className="check-row"><input type="checkbox" checked={keepReference} onChange={e => setKeepReference(e.target.checked)} />Keep source image as a reference</label>{status === 'updating' && <span className="sr-only" role="status" aria-live="polite">Updating preview</span>}{draftInfo && <div className="review"><h3>Review conversion</h3><p>{draftInfo?.stats.sourceWidth} × {draftInfo?.stats.sourceHeight} source → {draftInfo?.document.width} × {draftInfo?.document.height} stitches</p>{finishedSizePreview !== null && <p className="control-note">Expected finished size: {finishedSizePreview}</p>}<div ref={frameRef} className="conversion-preview-frame"><canvas ref={previewRef} className="conversion-preview" aria-label="Converted pattern preview" width={draftInfo ? calculatePreviewSize(draftInfo.document.width, draftInfo.document.height).width : undefined} height={draftInfo ? calculatePreviewSize(draftInfo.document.width, draftInfo.document.height).height : undefined} onPointerEnter={handlePreviewEnter} onPointerMove={handlePreviewMove} onPointerLeave={handlePreviewLeave} /><canvas ref={lensRef} className="preview-lens" width="160" height="160" aria-hidden="true" style={{ opacity: 0, pointerEvents: 'none' }} /></div><div className="budget-control"><label htmlFor="conversion-budget-range">Color budget <span className="budget-stepper"><button type="button" className="budget-step" aria-label="Decrease color budget" disabled={Number(budget) <= 1} onClick={() => stepBudget(-1)}>−</button><input id="conversion-budget-count" className="budget-count" type="text" inputMode="numeric" aria-label="Color budget count" value={budgetDraft} onChange={e => { setBudgetDraft(e.target.value); }} onBlur={() => commitBudget(budgetDraft)} onKeyDown={e => { if (e.key === 'Enter') commitBudget(budgetDraft); }} /> <span className="budget-suffix">colors</span><button type="button" className="budget-step" aria-label="Increase color budget" disabled={Number(budget) >= maxBudgetColors} onClick={() => stepBudget(1)}>+</button></span></label><input id="conversion-budget-range" type="range" min="1" max={maxBudgetColors} step="1" value={budget} aria-label={`Color budget, ${budget} colors`} onChange={e => { cancelConversion(true); setBudget(e.target.value); setBudgetDraft(e.target.value); }} /></div><h4 className="review-swatches-label">Detected colors</h4><p className="review-swatches-hint">Click a color to set it as the background.</p><div className="review-swatches">{palette.map(entry => { const selected = backgroundSourceId !== null && entry.catalog?.sourceId === backgroundSourceId; return <button key={entry.id} type="button" className={selected ? 'swatch swatch-selected' : 'swatch'} style={{ backgroundColor: entry.color }} aria-label={`Use ${entry.name} as background`} aria-pressed={selected} title={`Use ${entry.name} as background`} onClick={() => { cancelConversion(true); setBackgroundSourceId(selected ? null : (entry.catalog?.sourceId ?? null)); }} />; })}{backgroundSourceId !== null && <button type="button" className="review-clear-background" onClick={() => { cancelConversion(true); setBackgroundSourceId(null); }}>Clear background selection</button>}</div><button className="button button-primary" type="button" disabled={!previewIsCurrent || status !== 'ready'} onClick={() => void create()}>Create from image</button></div>}</div>}{error && <p className="modal-error" role="alert">{error}</p>}</section>}
  </div></div>;
}
