import { useEffect, useRef, useState } from 'react';
import type { EditorSurfaceController, EditorUiState } from '../../editor';
import { screenToCellUnclamped } from '../../editor/coordinates';
import type { PatternDocument } from '../../domain';
import type { ProjectWorkspace } from '../../application/workspace';
import { CanvasFrame, useEditorCanvas } from '../editor/editor-canvas';
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
  const refs = { frame: useRef<HTMLDivElement>(null), base: useRef<HTMLCanvasElement>(null), overlay: useRef<HTMLCanvasElement>(null) };
  const documentRef = useRef(document);
  documentRef.current = document;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onUiStateRef = useRef(onUiState);
  onUiStateRef.current = onUiState;
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const { controller, renderer, ui, fallback } = useEditorCanvas({
    workspace,
    document,
    refs,
    initialUi: { paletteId: null, tool: { tool: 'pan' } },
    // The controller projects mode, thread view and grid from the UI store.
    rendererStyle: { showCompletion },
    controllerOptions: { readOnly: true },
    onStart: ({ controller, store, frame: el }) => {
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
      onReadyRef.current?.(controller);
      return () => {
        onReadyRef.current?.(null);
        el.removeEventListener('pointermove', inspect);
        el.removeEventListener('pointerdown', inspect);
        el.removeEventListener('pointerleave', clearHover);
      };
    }
  });

  useEffect(() => {
    if (ui) onUiStateRef.current?.(ui);
  }, [ui]);

  useEffect(() => {
    renderer?.setStyle({ showCompletion });
  }, [showCompletion, renderer]);

  useEffect(() => {
    renderer?.setStyle({ showCenterMark });
  }, [showCenterMark, renderer]);

  useEffect(() => {
    controller?.setTool({ tool });
  }, [tool, controller]);

  useEffect(() => {
    controller?.setHighlightColor(highlightColor);
  }, [highlightColor, controller]);

  return (
    <div className="viewer-main">
      <CanvasFrame refs={refs} fallback={fallback} className="viewer-canvas" aria-label="Pattern preview canvas" />
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
