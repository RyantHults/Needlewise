import { useEffect, useRef, useState } from 'react';
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
  const [assetName, setAssetName] = useState<string | null>(null);
  const descriptor = workspace.sourceImage;
  const mountedRef = useRef(true);
  const importRequestRef = useRef(0);
  const handedOffReplacement = useRef<{ assetId: string; trace: Awaited<ReturnType<typeof decodeTraceImage>> } | null>(null);
  const decodedAssetRef = useRef<string | null>(null);
  const opacityStartRef = useRef<number | null>(null);

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
    setAssetName(asset.name);
    setVisible(source.traceVisible); setOpacity(source.opacity); setLoading(true); setStatus('Loading reference image…');
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
    setOpacity(source.opacity);
    try {
      controller?.setTraceImageSettings?.({ visible: source.traceVisible, opacity: source.opacity });
    } catch {
      // Non-fatal: the next render or asset change re-syncs the controller.
    }
  }, [workspace, controller, descriptor?.traceVisible, descriptor?.opacity]);

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
      opacityStartRef.current = workspace.sourceImage?.opacity ?? opacity;
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
    if (opacity === start && current.opacity === opacity) return;
    void commitSettings({ opacity }, 'trace-image-opacity');
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
      const chartBounds = fitTraceImageBounds(decoded.width, decoded.height, document.width, document.height);
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

  return <fieldset className="trace-controls"><legend>Reference image</legend>
    <input ref={inputRef} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); }} />
    <button type="button" className="trace-import" disabled={loading} onClick={() => inputRef.current?.click()}>{loading ? 'Loading…' : descriptor ? 'Replace image' : 'Import PNG, JPEG, or WebP'}</button>
    {descriptor && <>
      <p className="trace-file">{assetName ?? 'Missing image'}</p>
      <label className="trace-toggle"><input type="checkbox" checked={visible} onChange={(event) => { const value = event.target.checked; setVisible(value); controller?.setTraceImageSettings?.({ visible: value }); void commitSettings({ traceVisible: value }, 'trace-image-visibility'); }} /> Show image</label>
      <label className="trace-opacity">Opacity <output>{Math.round(opacity * 100)}%</output><input type="range" min="0" max="1" step="0.05" value={opacity} onPointerDown={beginOpacityInteraction} onFocus={beginOpacityInteraction} onChange={(event) => { const value = Number(event.target.value); setOpacity(value); controller?.setTraceImageSettings?.({ opacity: value }); }} onPointerUp={commitOpacityInteraction} onBlur={commitOpacityInteraction} /></label>
      <div className="trace-mode-row" role="group" aria-label="Reference image tools">
        <button type="button" className="trace-mode-button" aria-pressed={activeTool === 'move-image'} onClick={() => controller?.setTool({ tool: 'move-image' } as never)}>Move image</button>
        <button type="button" className="trace-mode-button" aria-pressed={activeTool === 'resize-image'} onClick={() => controller?.setTool({ tool: 'resize-image' } as never)}>Resize image</button>
      </div>
      <button type="button" className="trace-remove" onClick={() => void remove()}>Remove image</button>
    </>}
    <p className="control-note" role={status?.includes('could not') || status?.includes('missing') ? 'alert' : 'status'}>{status ?? 'Optional local reference; it is not part of the stitch chart.'}</p>
  </fieldset>;
}
