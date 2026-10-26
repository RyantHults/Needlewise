import { useEffect, useRef } from 'react';
import type { EditorSurfaceController, EditorUiState } from '../../editor';
import type { PatternDocument } from '../../domain';
import type { ProjectWorkspace } from '../../application/workspace';
import { CanvasFrame, useEditorCanvas } from '../editor/editor-canvas';
import { StitchReadout, useStitchReadout } from '../editor/stitch-readout';
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

/**
 * The Track page's canvas. The controller runs in `readOnly` mode, so nothing
 * here can edit the pattern; the Mark tool only changes stitch progress. The
 * page drives view mode and zoom through the controller handed to `onReady`.
 */
export function PatternViewer({ workspace, document, showCompletion = false, showCenterMark = false, tool = 'pan', highlightColor = null, onReady, onUiState }: Props) {
  const refs = { frame: useRef<HTMLDivElement>(null), base: useRef<HTMLCanvasElement>(null), overlay: useRef<HTMLCanvasElement>(null) };
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onUiStateRef = useRef(onUiState);
  onUiStateRef.current = onUiState;
  const { hover, attach: attachReadout } = useStitchReadout(document);
  const { controller, renderer, ui, fallback } = useEditorCanvas({
    workspace,
    document,
    refs,
    initialUi: { paletteId: null, tool: { tool: 'pan' } },
    // The controller projects mode, thread view and grid from the UI store.
    rendererStyle: { showCompletion },
    controllerOptions: { readOnly: true },
    onStart: ({ controller, store, frame: el }) => {
      const detachReadout = attachReadout({ store, frame: el });
      onReadyRef.current?.(controller);
      return () => {
        onReadyRef.current?.(null);
        detachReadout();
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
      <StitchReadout hover={hover} />
    </div>
  );
}
