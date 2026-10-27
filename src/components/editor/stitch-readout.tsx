import { useCallback, useRef, useState } from 'react';
import type { CatalogDefinition } from '../../catalog';
import { CellKind, type PatternDocument } from '../../domain';
import { componentKind } from '../../domain/cell-components';
import { hitCornerAt } from '../../editor/controller';
import { screenToModel } from '../../editor/coordinates';
import type { EditorCanvasParts } from './editor-canvas';
import { paletteCodeFor } from './palette-code';
import './stitch-readout.css';

const STITCH_LABELS: Readonly<Record<number, string>> = {
  [CellKind.Full]: 'Full stitch',
  [CellKind.HalfBackslash]: 'Half stitch',
  [CellKind.HalfSlash]: 'Half stitch',
  [CellKind.Quarters]: 'Quarter stitch',
  [CellKind.ThreeQuarterNW]: 'Three-quarter stitch',
  [CellKind.ThreeQuarterNE]: 'Three-quarter stitch',
  [CellKind.ThreeQuarterSE]: 'Three-quarter stitch',
  [CellKind.ThreeQuarterSW]: 'Three-quarter stitch'
};

interface HoverInfo {
  readonly x: number;
  readonly y: number;
  readonly code: string | null;
  readonly name: string | null;
  readonly stitch: string | null;
  readonly color: string | null;
}

/**
 * Tracks the stitch under the pointer in the flattened `document`. `attach`
 * goes inside `useEditorCanvas`'s `onStart`, and its cleanup belongs in the
 * one that `onStart` returns.
 */
export function useStitchReadout(document: PatternDocument, catalogs: readonly CatalogDefinition[]): {
  hover: HoverInfo | null;
  attach: (parts: Pick<EditorCanvasParts, 'store' | 'frame'>) => () => void;
} {
  const documentRef = useRef(document);
  documentRef.current = document;
  const catalogsRef = useRef(catalogs);
  catalogsRef.current = catalogs;
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const attach = useCallback(({ store, frame }: Pick<EditorCanvasParts, 'store' | 'frame'>) => {
    const inspect = (event: PointerEvent) => {
      const bounds = frame.getBoundingClientRect();
      const point = screenToModel({ x: event.clientX - bounds.left, y: event.clientY - bounds.top }, store.getState().viewport);
      const x = Math.floor(point.x);
      const y = Math.floor(point.y);
      const current = documentRef.current;
      if (x < 0 || y < 0 || x >= current.width || y >= current.height) {
        setHover(null);
        return;
      }
      const index = y * current.width + x;
      const kind = current.kind[index];
      const slot = kind === CellKind.ThreeQuarterPair || kind === CellKind.Quarters ? hitCornerAt(current, index, point) : 0;
      const paletteId = kind === CellKind.Empty ? 0 : current.colors[index * 4 + slot];
      const entry = paletteId ? current.palette.find((candidate) => candidate.id === paletteId) : undefined;
      setHover({
        x,
        y,
        code: entry ? paletteCodeFor(entry, current.palette, catalogsRef.current).label : null,
        name: entry?.name ?? null,
        stitch: entry ? STITCH_LABELS[componentKind(kind, slot)] : null,
        color: entry?.color ?? null,
      });
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

/** The code, name, color and position of the hovered stitch, shown below the canvas. */
export function StitchReadout({ hover }: { hover: HoverInfo | null }) {
  return (
    <p className="stitch-readout" aria-live="off">
      {hover && (
        <>
          {hover.color && <span className="stitch-readout-swatch" style={{ background: hover.color }} aria-hidden="true" />}
          {hover.name === null ? 'No stitch' : `${hover.code} ${hover.name} · ${hover.stitch}`} · column {hover.x + 1}, row {hover.y + 1}
        </>
      )}
    </p>
  );
}
