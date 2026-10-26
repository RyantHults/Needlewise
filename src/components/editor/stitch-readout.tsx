import { useCallback, useRef, useState } from 'react';
import type { PatternDocument } from '../../domain';
import { screenToCellUnclamped } from '../../editor/coordinates';
import type { EditorCanvasParts } from './editor-canvas';
import './stitch-readout.css';

interface HoverInfo {
  readonly x: number;
  readonly y: number;
  readonly name: string | null;
  readonly color: string | null;
}

/**
 * Tracks the stitch under the pointer in the flattened `document`. `attach`
 * goes inside `useEditorCanvas`'s `onStart`, and its cleanup belongs in the
 * one that `onStart` returns.
 */
export function useStitchReadout(document: PatternDocument): {
  hover: HoverInfo | null;
  attach: (parts: Pick<EditorCanvasParts, 'store' | 'frame'>) => () => void;
} {
  const documentRef = useRef(document);
  documentRef.current = document;
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const attach = useCallback(({ store, frame }: Pick<EditorCanvasParts, 'store' | 'frame'>) => {
    const inspect = (event: PointerEvent) => {
      const bounds = frame.getBoundingClientRect();
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
    frame.addEventListener('pointermove', inspect);
    frame.addEventListener('pointerdown', inspect);
    frame.addEventListener('pointerleave', clearHover);
    return () => {
      frame.removeEventListener('pointermove', inspect);
      frame.removeEventListener('pointerdown', inspect);
      frame.removeEventListener('pointerleave', clearHover);
    };
  }, []);
  return { hover, attach };
}

/** The name, color and position of the hovered stitch, shown below the canvas. */
export function StitchReadout({ hover }: { hover: HoverInfo | null }) {
  return (
    <p className="stitch-readout" aria-live="off">
      {hover && (
        <>
          {hover.color && <span className="stitch-readout-swatch" style={{ background: hover.color }} aria-hidden="true" />}
          {hover.name ?? 'No stitch'} · column {hover.x + 1}, row {hover.y + 1}
        </>
      )}
    </p>
  );
}
