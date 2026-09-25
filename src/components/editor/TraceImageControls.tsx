import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProjectWorkspace } from '../../application/workspace';
import type { PatternDocument } from '../../domain';
import type { SourceImageMimeType } from '../../persistence';
import type { EditorSurfaceController } from '../../editor';
import { decodeTraceImage, disposeTraceImage, fitTraceImageBounds, TraceDecodeError } from '../../rendering/trace';
import { MAX_TRACE_IMAGE_BYTES } from '../../rendering/trace';

interface Props { workspace: ProjectWorkspace; document: PatternDocument; controller: EditorSurfaceController | null; activeTool?: string; }

/** A replacement decode is transferred to the source-change effect exactly once. */
function handoffTrace(
  controller: EditorSurfaceController | null,
  trace: Awaited<ReturnType<typeof decodeTraceImage>>,
  settings: { visible: boolean; opacity: number; crop: { x: number; y: number; width: number; height: number }; chartBounds: { x: number; y: number; width: number; height: number } },
  active: boolean
): boolean {
  if (!active || !controller) return false;
  const handedOff = { ...trace, ...settings };
  try {
    controller.setTraceImage(handedOff);
    // The production controller exposes the identity check; the fallback keeps
    // lightweight adapters compatible while still treating thrown calls as a
    // failed handoff.
    return typeof controller.getTraceImage !== 'function' || controller.getTraceImage() === handedOff;
  } catch {
    return false;
  }
}

export function TraceImageControls({ workspace, document, controller, activeTool }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(workspace.sourceImage?.traceVisible ?? true);
  const [opacity, setOpacity] = useState(workspace.sourceImage?.opacity ?? 1);
  const opacityRestoreRef = useRef<number | undefined>(workspace.sourceImage?.opacity);
  const descriptor = workspace.sourceImage;
  const mountedRef = useRef(true);
  const importRequestRef = useRef(0);
  const handedOffReplacement = useRef<{ assetId: string; trace: Awaited<ReturnType<typeof decodeTraceImage>> } | null>(null);
  const decodedAssetRef = useRef<string | null>(null);
  const opacityStartRef = useRef<number | null>(null);
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);
  const removeTrigger = useRef<HTMLButtonElement>(null);
  const removeDialog = useRef<HTMLDivElement>(null);

  useEffect(() => () => { mountedRef.current = false; importRequestRef.current += 1; }, []);

  useEffect(() => {
    // React StrictMode intentionally tears effects down and replays them. The
    // component is live again when this setup runs, so a prior replay cleanup
    // must not make the decoded handoff look like an unmounted race.
    mountedRef.current = true;
    let cancelled = false;
    const source = workspace.sourceImage;
    const asset = source ? workspace.getAsset(source.assetId) : undefined;
    if (!source) { decodedAssetRef.current = null; controller?.clearTraceImage?.(); return undefined; }
    if (!asset) { setStatus('Reference image is missing; the chart is still available.'); controller?.clearTraceImage?.(); return undefined; }
    opacityRestoreRef.current = source.opacity; setVisible(source.traceVisible); setOpacity(source.traceVisible ? source.opacity : 0); setLoading(true); setStatus('Loading reference image…');
    const retained = handedOffReplacement.current?.assetId === source.assetId ? handedOffReplacement.current.trace : undefined;
    if (retained) handedOffReplacement.current = null;
    void (retained ? Promise.resolve(retained) : decodeTraceImage(new Blob([new Uint8Array(asset.data) as unknown as ArrayBuffer], { type: asset.mimeType }))).then((trace) => {
      if (cancelled) { disposeTraceImage(trace); return; }
      const accepted = handoffTrace(controller, trace, { visible: source.traceVisible, opacity: source.opacity, crop: source.crop, chartBounds: source.chartBounds }, mountedRef.current);
      if (!accepted) { disposeTraceImage(trace); setStatus('Reference image could not be attached to the editor.'); return; }
      decodedAssetRef.current = source.assetId;
      setStatus(`${asset.name} ready`);
    }).catch((error: unknown) => { if (!cancelled) { controller?.clearTraceImage?.(); setStatus(error instanceof TraceDecodeError ? error.message : 'Reference image could not be loaded.'); } }).finally(() => { if (!cancelled) setLoading(false); });
    // A pending replacement owns the controller handoff; the old effect must
    // not clear (and thereby dispose) that bitmap during dependency cleanup.
    // Bounds/opacity/visibility changes patch the live trace below without
    // re-decoding, so this effect only watches the asset identity (plus the
    // document size, which can affect the initial fit).
    return () => { cancelled = true; if (!handedOffReplacement.current) controller?.clearTraceImage?.(); };
  }, [workspace, controller, descriptor?.assetId, document.width, document.height]);

  // Patch bounds/crop onto the live bitmap when the descriptor changes without
  // a new asset (drag commits, arrow nudges, resize commits, and their undo).
  // Re-decoding here would be wasteful; the asset effect above owns bitmaps.
  useEffect(() => {
    const source = workspace.sourceImage;
    if (!source || !controller) return;
    if (decodedAssetRef.current !== null && decodedAssetRef.current !== source.assetId) return;
    const trace = controller.getTraceImage?.();
    if (!trace) return;
    const sameBounds = trace.chartBounds !== undefined
      && trace.chartBounds.x === source.chartBounds.x
      && trace.chartBounds.y === source.chartBounds.y
      && trace.chartBounds.width === source.chartBounds.width
      && trace.chartBounds.height === source.chartBounds.height;
    const sameCrop = (trace.crop ?? undefined) === undefined && source.crop === undefined
      || trace.crop !== undefined && trace.crop.x === source.crop.x && trace.crop.y === source.crop.y && trace.crop.width === source.crop.width && trace.crop.height === source.crop.height;
    if (sameBounds && sameCrop) return;
    try {
      controller.setTraceImage({ ...trace, crop: { ...source.crop }, chartBounds: { ...source.chartBounds } });
    } catch {
      // A failed patch leaves the last good trace in place; the asset effect
      // will re-decode on the next asset change.
    }
  }, [workspace, controller, descriptor?.assetId, descriptor?.crop.x, descriptor?.crop.y, descriptor?.crop.width, descriptor?.crop.height, descriptor?.chartBounds.x, descriptor?.chartBounds.y, descriptor?.chartBounds.width, descriptor?.chartBounds.height]);

  // Sync visibility/opacity (including undo/redo) without re-decoding.
  useEffect(() => {
    const source = workspace.sourceImage;
    if (!source) return;
    setVisible(source.traceVisible);
    if (source.traceVisible) {
      opacityRestoreRef.current = source.opacity;
      setOpacity(source.opacity);
    } else {
      if (opacityRestoreRef.current === undefined) opacityRestoreRef.current = source.opacity;
      setOpacity(0);
    }
    try {
      controller?.setTraceImageSettings?.({ visible: source.traceVisible, opacity: source.traceVisible ? source.opacity : 0 });
    } catch {
      // Non-fatal: the next render or asset change re-syncs the controller.
    }
  }, [workspace, controller, descriptor?.traceVisible, descriptor?.opacity]);

  // Focus/inert/Escape/Tab-trap for the remove-confirmation dialog, mirroring
  // the palette-delete dialog pattern in EditorSurface.
  useEffect(() => {
    if (!removeConfirmOpen) return;
    const dialog = removeDialog.current;
    if (!dialog) return;
    const root = globalThis.document.querySelector<HTMLElement>('[data-application]');
    const wasInert = root?.inert ?? false;
    if (root) root.inert = true;
    dialog.querySelector<HTMLButtonElement>('[data-remove-cancel]')?.focus();
    const close = () => { setRemoveConfirmOpen(false); window.setTimeout(() => removeTrigger.current?.focus(), 0); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab') return;
      const controls = [...dialog.querySelectorAll<HTMLElement>("button,input,select,textarea,[tabindex]:not([tabindex='-1'])")]
        .filter((item) => !item.hasAttribute('disabled') && !item.closest('[hidden]') && item.tabIndex >= 0);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && globalThis.document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && globalThis.document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    dialog.addEventListener('keydown', key);
    return () => { dialog.removeEventListener('keydown', key); if (root) root.inert = wasInert; };
  }, [removeConfirmOpen]);

  const commitSettings = async (next: { traceVisible?: boolean; opacity?: number }, label: string) => {
    const current = workspace.sourceImage;
    if (!current) return;
    try {
      if (typeof workspace.applyTraceImageChange === 'function') {
        await workspace.applyTraceImageChange({ ...current, ...next }, { label });
      } else {
        await workspace.setSourceImage({ ...current, ...next });
      }
    } catch { setStatus('Reference image settings could not be saved.'); }
  };

  const remove = async () => {
    const current = workspace.sourceImage;
    if (!current) return;
    try {
      await workspace.removeSourceImage();
      setStatus('Reference image removed.');
    } catch {
      setStatus('Reference image could not be removed.');
    }
  };

  const beginOpacityInteraction = () => {
    if (opacityStartRef.current === null) {
      opacityStartRef.current = opacityRestoreRef.current ?? workspace.sourceImage?.opacity ?? opacity;
    }
  };

  const commitOpacityInteraction = () => {
    const start = opacityStartRef.current;
    opacityStartRef.current = null;
    if (start === null) return;
    const current = workspace.sourceImage;
    if (!current) return;
    // The live slider already moved the controller; persist exactly one
    // history entry for the whole interaction (or none when unchanged).
    const nextOpacity = visible ? opacity : opacityRestoreRef.current ?? current.opacity;
    if (nextOpacity === start && current.opacity === nextOpacity) return;
    void commitSettings({ opacity: nextOpacity }, 'trace-image-opacity');
  };

  const handleOpacityChange = (nextOpacity: number) => {
    opacityRestoreRef.current = nextOpacity;
    if (!visible) {
      setOpacity(0);
      try { controller?.setTraceImageSettings?.({ visible: false, opacity: 0 }); } catch { /* Non-fatal: the next sync re-applies the hidden state. */ }
      return;
    }
    setOpacity(nextOpacity);
    try { controller?.setTraceImageSettings?.({ opacity: nextOpacity }); } catch { /* Non-fatal: the next sync re-applies the value. */ }
  };

  const handleVisibilityChange = (nextVisible: boolean) => {
    const current = workspace.sourceImage;
    if (!current) return;
    if (nextVisible) {
      const restoredOpacity = opacityRestoreRef.current ?? current.opacity ?? 1;
      opacityRestoreRef.current = restoredOpacity;
      setVisible(true);
      setOpacity(restoredOpacity);
      try { controller?.setTraceImageSettings?.({ visible: true, opacity: restoredOpacity }); } catch { /* Non-fatal: the next sync re-applies the visible state. */ }
      void commitSettings({ traceVisible: true, opacity: restoredOpacity }, 'trace-image-visibility');
      return;
    }
    const restoreOpacity = opacityRestoreRef.current ?? opacity;
    opacityRestoreRef.current = restoreOpacity;
    setVisible(false);
    setOpacity(0);
    try { controller?.setTraceImageSettings?.({ visible: false, opacity: 0 }); } catch { /* Non-fatal: the next sync re-applies the hidden state. */ }
    void commitSettings({ traceVisible: false }, 'trace-image-visibility');
  };

  const importFile = async (file: File) => {
    const request = importRequestRef.current + 1;
    importRequestRef.current = request;
    setLoading(true); setStatus('Reading reference image…');
    if (file.size > MAX_TRACE_IMAGE_BYTES) { setLoading(false); setStatus('Reference image data exceeds the local size limit.'); if (inputRef.current) inputRef.current.value = ''; return; }
    let decoded: Awaited<ReturnType<typeof decodeTraceImage>> | undefined;
    try {
      decoded = await decodeTraceImage(file);
      if (!mountedRef.current || request !== importRequestRef.current) throw new Error('Reference image replacement was superseded.');
      const id = `trace-${Date.now().toString(36)}`;
      const chartBounds = fitTraceImageBounds(decoded.sourceWidth ?? decoded.width, decoded.sourceHeight ?? decoded.height, document.width, document.height);
      handedOffReplacement.current = { assetId: id, trace: decoded };
      // The descriptor describes the persisted ORIGINAL asset, so its
      // dimensions are the original decode dimensions (the overlay trace is
      // pre-scaled to the working bound and reports them in width/height).
      await workspace.replaceSourceImage({ asset: { id, name: file.name, mimeType: file.type, data: file }, settings: { assetId: id, mimeType: file.type as SourceImageMimeType, width: decoded.sourceWidth ?? decoded.width, height: decoded.sourceHeight ?? decoded.height, crop: { x: 0, y: 0, width: 1, height: 1 }, chartBounds, traceVisible: true, opacity: 1 } });
      const accepted = handoffTrace(controller, decoded, { visible: true, opacity: 1, crop: { x: 0, y: 0, width: 1, height: 1 }, chartBounds }, mountedRef.current && request === importRequestRef.current);
      if (!accepted) throw new Error('Reference image could not be attached to the editor.');
      decodedAssetRef.current = id;
      decoded = undefined; setStatus(`${file.name} imported.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Reference image could not be imported.'); }
    finally { if (decoded) disposeTraceImage(decoded); setLoading(false); if (inputRef.current) inputRef.current.value = ''; }
  };

  return <div className="trace-controls" role="toolbar" aria-label="Reference image">
    <input ref={inputRef} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); }} />
    {!descriptor && <button type="button" className="trace-icon-button bottom-control" aria-label={loading ? 'Loading reference image' : 'Add reference image'} title={loading ? 'Loading reference image' : 'Add reference image'} disabled={loading} onClick={() => inputRef.current?.click()}><span aria-hidden="true">{loading ? '…' : '+'}</span><small>{loading ? 'Load' : 'Add'}</small></button>}
    <label className="trace-visibility bottom-control" title="Show image"><input aria-label="Show image" type="checkbox" disabled={!descriptor} checked={visible} onChange={(event) => handleVisibilityChange(event.target.checked)} /><span aria-hidden="true">{visible ? '◉' : '○'}</span><small>Show</small></label>
    <div className="trace-mode-row" role="group" aria-label="Reference image tools">
      <button type="button" disabled={!descriptor} className="trace-mode-button bottom-control" aria-label="Move image" title="Move image" aria-pressed={activeTool === 'move-image'} onClick={() => controller?.setTool({ tool: 'move-image' } as never)}><span aria-hidden="true">↔</span><small>Move</small></button>
      <button type="button" disabled={!descriptor} className="trace-mode-button bottom-control" aria-label="Resize image" title="Resize image" aria-pressed={activeTool === 'resize-image'} onClick={() => controller?.setTool({ tool: 'resize-image' } as never)}><span aria-hidden="true">↗</span><small>Resize</small></button>
    </div>
    {descriptor && <button type="button" ref={removeTrigger} className="trace-icon-button trace-remove bottom-control" aria-label="Remove image" title="Remove image" onClick={() => setRemoveConfirmOpen(true)}><span aria-hidden="true">×</span><small>Remove</small></button>}
    {removeConfirmOpen && createPortal(
      <div className="modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) { setRemoveConfirmOpen(false); window.setTimeout(() => removeTrigger.current?.focus(), 0); } }}>
        <div ref={removeDialog} className="catalog-dialog create-modal" role="dialog" aria-modal="true" aria-labelledby="remove-trace-image-title">
          <p className="section-label">Reference image</p>
          <h2 id="remove-trace-image-title">Remove reference image?</h2>
          <p className="modal-hint">The reference image will be removed from this project.</p>
          <div className="actions">
            <button className="button button-secondary" data-remove-cancel type="button" onClick={() => { setRemoveConfirmOpen(false); window.setTimeout(() => removeTrigger.current?.focus(), 0); }}>Cancel</button>
            <button className="button button-primary" type="button" onClick={() => { setRemoveConfirmOpen(false); window.setTimeout(() => removeTrigger.current?.focus(), 0); void remove(); }}>Remove image</button>
          </div>
        </div>
      </div>, globalThis.document.body
    )}
    <label className="trace-opacity"><span className="trace-opacity-label">Transparency</span><input aria-label={`Reference image opacity ${Math.round(opacity * 100)}%`} disabled={!descriptor} type="range" min="0" max="1" step="0.05" value={opacity} onPointerDown={beginOpacityInteraction} onFocus={beginOpacityInteraction} onChange={(event) => handleOpacityChange(Number(event.target.value))} onPointerUp={commitOpacityInteraction} onBlur={commitOpacityInteraction} /></label>
    <span className="trace-status sr-only" role={status?.includes('could not') || status?.includes('missing') ? 'alert' : 'status'}>{status ?? 'Optional local reference; it is not part of the stitch chart.'}</span>
  </div>;
}
