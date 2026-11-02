import { useEffect, useRef } from 'react';
import { ChartPresentationMode, type EditorSurfaceController } from '../../editor';
import type { PatternDocument } from '../../domain';
import type { ProjectWorkspace } from '../../application/workspace';
import { CanvasFrame, useEditorCanvas } from '../editor/editor-canvas';
import { patternDimensionInfo } from '../editor/pattern-dimensions';
import { StitchReadout, useStitchReadout } from '../editor/stitch-readout';
import './viewer.css';

interface Props {
  workspace: ProjectWorkspace;
  /** The flattened visible composite; hidden layers and the reference image are not in it. */
  document: PatternDocument;
  /** Draw the center guides. Only the Track page turns it on. */
  showCenterMark?: boolean;
  /** Pan moves the view; Mark taps or drags stitches done. Two-finger pan and zoom works with either. */
  tool?: 'pan' | 'mark';
  /** The focused palette id: other colors are dimmed and Mark only changes this color. */
  highlightColor?: number | null;
  /** Called once the controller exists, and with `null` when it is disposed. */
  onReady?: (controller: EditorSurfaceController | null) => void;
}

/**
 * The Track page's canvas. The controller runs in `readOnly` mode, so nothing
 * here can edit the pattern; the Mark tool only changes stitch progress. The
 * chart is always Symbol view, where completed stitches draw as Both. The
 * page drives zoom through the controller handed to `onReady`.
 */
export function PatternViewer({ workspace, document, showCenterMark = false, tool = 'pan', highlightColor = null, onReady }: Props) {
  const refs = { frame: useRef<HTMLDivElement>(null), base: useRef<HTMLCanvasElement>(null), overlay: useRef<HTMLCanvasElement>(null) };
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const { hover, attach: attachReadout } = useStitchReadout(document, workspace.availableCatalogs());
  const { controller, renderer, fallback } = useEditorCanvas({
    workspace,
    document,
    refs,
    initialUi: { paletteId: null, tool: { tool: 'pan' }, mode: ChartPresentationMode.Symbol },
    // The controller projects mode, thread view and grid from the UI store.
    rendererStyle: { showCompletion: true },
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
      <StitchReadout hover={hover} dimensions={patternDimensionInfo(workspace, document).summary} />
    </div>
  );
}
