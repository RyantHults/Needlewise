import { useEffect, useRef, useState } from 'react';
import {
  createEditorSurfaceController,
  createPointerEventsAdapter,
  createUiStore,
  createWorkspaceEditorGateway,
  type EditorSurfaceController,
  type EditorUiState
} from '../../editor';
import { getCanvasMetrics, screenToCellUnclamped } from '../../editor/coordinates';
import { createCanvasTarget } from '../../rendering/context';
import { createCanvasRenderer } from '../../rendering/renderer';
import type { CanvasRenderer } from '../../editor/contracts';
import type { PatternDocument } from '../../domain';
import type { ProjectWorkspace } from '../../application/workspace';
import './viewer.css';

interface Props {
  workspace: ProjectWorkspace;
  /** The flattened visible composite; hidden layers and the reference image are not in it. */
  document: PatternDocument;
  /** Draw completion marks. The editor does not use this viewer; only the Track page turns it on. */
  showCompletion?: boolean;
  /** Draw the center guides. Only the Track page turns it on. */
  showCenterMark?: boolean;
  /** Pan moves the view; Mark taps or drags stitches done. Two-finger pan and zoom works with either. */
  tool?: 'pan' | 'mark';
  /** The focused palette id: other colors are dimmed and Mark only changes this color. */
  highlightColor?: number | null;
  /** Called once the controller exists, and with `null` when it is disposed. */
  onReady?: (controller: EditorSurfaceController | null) => void;
  /** Every UI store state, so the page's view settings can show the chart mode. */
  onUiState?: (state: EditorUiState) => void;
}

interface HoverInfo {
  readonly x: number;
  readonly y: number;
  readonly name: string | null;
  readonly color: string | null;
}

/**
 * The Track page's canvas. The controller runs in `readOnly` mode, so nothing
 * here can edit the pattern; the Mark tool only changes stitch progress. The
 * page drives view mode and zoom through the controller handed to `onReady`.
 */
export function PatternViewer({ workspace, document, showCompletion = false, showCenterMark = false, tool = 'pan', highlightColor = null, onReady, onUiState }: Props) {
  const frame = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<EditorSurfaceController | null>(null);
  const rendererRef = useRef<CanvasRenderer | null>(null);
  const documentRef = useRef(document);
  documentRef.current = document;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onUiStateRef = useRef(onUiState);
  onUiStateRef.current = onUiState;
  const initialShowCompletion = useRef(showCompletion);
  const [ready, setReady] = useState(false);
  const [fallback, setFallback] = useState(false);
  const [hover, setHover] = useState<HoverInfo | null>(null);

  useEffect(() => {
    const el = frame.current;
    const baseCanvas = base.current;
    const overlayCanvas = overlay.current;
    if (!el || !baseCanvas || !overlayCanvas) return;
    try {
      const store = createUiStore({ paletteId: null, tool: { tool: 'pan' } });
      const gateway = createWorkspaceEditorGateway(workspace);
      const renderer = createCanvasRenderer({
        document: documentRef.current,
        targets: { base: createCanvasTarget(baseCanvas), overlay: createCanvasTarget(overlayCanvas) },
        metrics: getCanvasMetrics(640, 480, { devicePixelRatio: 1 }),
        // The controller projects mode, thread view and grid from the UI store.
        style: { showCompletion: initialShowCompletion.current }
      });
      const controller = createEditorSurfaceController({ gateway, renderer, uiStore: store, readOnly: true });
      const unsubscribe = store.subscribe((state) => onUiStateRef.current?.(state));
      const measure = () =>
        getCanvasMetrics(
          Math.max(1, el.getBoundingClientRect().width || 640),
          Math.max(1, el.getBoundingClientRect().height || 480),
          { devicePixelRatio: 1 }
        );
      const adapter = createPointerEventsAdapter(el, controller, { keyboardSurface: el });
      const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => controller.setMetrics(measure()));
      observer?.observe(el);
      const inspect = (event: PointerEvent) => {
        const bounds = el.getBoundingClientRect();
        const cell = screenToCellUnclamped({ x: event.clientX - bounds.left, y: event.clientY - bounds.top }, store.getState().viewport);
        const x = Math.floor(cell.x);
        const y = Math.floor(cell.y);
        const current = documentRef.current;
        if (x < 0 || y < 0 || x >= current.width || y >= current.height) {
          setHover(null);
          return;
        }
        const index = y * current.width + x;
        const paletteId = current.kind[index] === 0 ? 0 : current.colors[index * 4];
        const entry = paletteId ? current.palette.find((candidate) => candidate.id === paletteId) : undefined;
        setHover({ x, y, name: entry?.name ?? null, color: entry?.color ?? null });
      };
      const clearHover = () => setHover(null);
      el.addEventListener('pointermove', inspect);
      el.addEventListener('pointerdown', inspect);
      el.addEventListener('pointerleave', clearHover);
      controller.start();
      controller.setMetrics(measure());
      controller.handleKeyDown({ key: '0' });
      controllerRef.current = controller;
      rendererRef.current = renderer;
      setReady(true);
      onReadyRef.current?.(controller);
      onUiStateRef.current?.(store.getState());
      return () => {
        onReadyRef.current?.(null);
        unsubscribe();
        el.removeEventListener('pointermove', inspect);
        el.removeEventListener('pointerdown', inspect);
        el.removeEventListener('pointerleave', clearHover);
        observer?.disconnect();
        adapter.dispose();
        controller.dispose();
        gateway.dispose();
        renderer.dispose();
        controllerRef.current = null;
        rendererRef.current = null;
        setReady(false);
      };
    } catch {
      setFallback(true);
    }
  }, [workspace]);

  useEffect(() => {
    controllerRef.current?.setDocument(document, { layer: 'all', full: true, reason: 'external-document' });
  }, [document, ready]);

  useEffect(() => {
    if (!ready) return;
    rendererRef.current?.setStyle({ showCompletion });
  }, [showCompletion, ready]);

  useEffect(() => {
    if (!ready) return;
    rendererRef.current?.setStyle({ showCenterMark });
  }, [showCenterMark, ready]);

  useEffect(() => {
    if (!ready) return;
    controllerRef.current?.setTool({ tool });
  }, [tool, ready]);

  useEffect(() => {
    if (!ready) return;
    controllerRef.current?.setHighlightColor(highlightColor);
  }, [highlightColor, ready]);

  return (
    <div className="viewer-main">
      <div ref={frame} className="canvas-frame viewer-canvas" role="group" tabIndex={0} aria-label="Pattern preview canvas">
        {fallback ? (
          <p className="canvas-fallback">Canvas preview is unavailable. Refresh the page or try a browser with Canvas 2D support.</p>
        ) : (
          <>
            <canvas ref={base} aria-hidden="true" />
            <canvas ref={overlay} aria-hidden="true" />
          </>
        )}
      </div>
      <p className="viewer-hover" aria-live="off">
        {hover && (
          <>
            {hover.color && <span className="viewer-hover-swatch" style={{ background: hover.color }} aria-hidden="true" />}
            {hover.name ?? 'No stitch'} · column {hover.x + 1}, row {hover.y + 1}
          </>
        )}
      </p>
    </div>
  );
}
