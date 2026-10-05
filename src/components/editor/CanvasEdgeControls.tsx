import { useEffect, useRef, useState, type RefObject } from "react";
import type { EditorSurfaceController } from "../../editor";
import type { CanvasEdge } from "../../editor/canvas-tools";
import type { CellRect, ScreenPoint, Viewport } from "../../editor/contracts";

type EdgeController = Pick<EditorSurfaceController, "resizeCanvasEdge" | "beginCanvasEdgeDrag" | "updateCanvasEdgeDrag" | "endCanvasEdgeDrag" | "cancelCanvasEdgeDrag">;

interface Props {
  controller: EdgeController | null;
  viewport: Viewport;
  /** The canvas box, in cells. */
  width: number;
  height: number;
  /** The canvas frame the controls float in; screen points are relative to it. */
  frame: RefObject<HTMLElement | null>;
  /** The box an edge drag in progress would commit; the controls follow its edges. */
  previewBox?: CellRect | null;
}

/** Button size and spacing, in CSS pixels; they match the stylesheet. */
const BUTTON = 22;
const GAP = 4;
const CLUSTER_LENGTH = BUTTON * 3 + GAP * 2;

const EDGES: readonly CanvasEdge[] = ["top", "right", "bottom", "left"];

const LABELS: Record<CanvasEdge, { unit: "row" | "column"; where: string; name: string }> = {
  top: { unit: "row", where: "at the top", name: "top" },
  bottom: { unit: "row", where: "at the bottom", name: "bottom" },
  left: { unit: "column", where: "on the left", name: "left" },
  right: { unit: "column", where: "on the right", name: "right" }
};

/** Arrow keys that move each edge outward (grow) and inward (shrink). */
const KEYS: Record<CanvasEdge, { grow: string; shrink: string }> = {
  top: { grow: "ArrowUp", shrink: "ArrowDown" },
  bottom: { grow: "ArrowDown", shrink: "ArrowUp" },
  left: { grow: "ArrowLeft", shrink: "ArrowRight" },
  right: { grow: "ArrowRight", shrink: "ArrowLeft" }
};

function clamp(value: number, min: number, max: number): number {
  return max < min ? min : Math.min(max, Math.max(min, value));
}

/**
 * Basic-mode canvas edge controls, like resize handles: each cluster is locked
 * to its edge line, the drag handle straddling the border with − / + on either
 * side along the edge. Along the edge a cluster slides to the middle of the
 * edge's visible part; an edge whose line is off screen, or whose visible part
 * is shorter than the cluster, shows no controls. During a drag the clusters
 * follow the previewed box, and the dragged one stays rendered (clamped into
 * the frame) so its pointer capture survives.
 */
export function CanvasEdgeControls({ controller, viewport, width, height, frame, previewBox }: Props) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [dragging, setDragging] = useState<{ edge: CanvasEdge; pointerId: number } | null>(null);
  const draggingRef = useRef(dragging);
  draggingRef.current = dragging;

  useEffect(() => {
    const element = frame.current;
    if (!element) return undefined;
    const measure = () => setSize({ width: element.clientWidth || 640, height: element.clientHeight || 480 });
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [frame]);

  useEffect(() => {
    if (!dragging) return undefined;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      controller?.cancelCanvasEdgeDrag();
      setDragging(null);
    };
    globalThis.document.addEventListener("keydown", key, true);
    return () => globalThis.document.removeEventListener("keydown", key, true);
  }, [dragging, controller]);

  const pointOf = (event: React.PointerEvent): ScreenPoint => {
    const rect = frame.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };

  const box = previewBox ?? { x: 0, y: 0, width, height };
  const left = (box.x - viewport.x) * viewport.zoom;
  const top = (box.y - viewport.y) * viewport.zoom;
  const right = (box.x + box.width - viewport.x) * viewport.zoom;
  const bottom = (box.y + box.height - viewport.y) * viewport.zoom;
  const frameWidth = size.width;
  const frameHeight = size.height;

  /** Top-left of a cluster centred on its edge line, or null when the edge has no room on screen. */
  const placement = (edge: CanvasEdge): { left: number; top: number; vertical: boolean } | null => {
    const vertical = edge === "left" || edge === "right";
    const line = edge === "left" ? left : edge === "right" ? right : edge === "top" ? top : bottom;
    const across = vertical ? frameWidth : frameHeight;
    const along = vertical ? frameHeight : frameWidth;
    const start = Math.max(0, vertical ? top : left);
    const end = Math.min(along, vertical ? bottom : right);
    const shown = line >= 0 && line <= across && end - start >= CLUSTER_LENGTH;
    let centreAlong = (start + end) / 2;
    let centreAcross = line;
    if (!shown) {
      // Only the edge being dragged stays rendered: clamped into the frame so the drag isn't lost.
      if (dragging?.edge !== edge) return null;
      const whole = vertical ? (top + bottom) / 2 : (left + right) / 2;
      centreAlong = clamp(whole, CLUSTER_LENGTH / 2, along - CLUSTER_LENGTH / 2);
      centreAcross = clamp(line, BUTTON / 2, across - BUTTON / 2);
    }
    const alongStart = centreAlong - CLUSTER_LENGTH / 2;
    const acrossStart = centreAcross - BUTTON / 2;
    return vertical ? { vertical, left: acrossStart, top: alongStart } : { vertical, left: alongStart, top: acrossStart };
  };

  const finishDrag = (event: React.PointerEvent<HTMLButtonElement>, commit: boolean) => {
    const current = draggingRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    setDragging(null);
    draggingRef.current = null;
    if (commit) controller?.endCanvasEdgeDrag();
    else controller?.cancelCanvasEdgeDrag();
  };

  return (
    <div
      className="canvas-edge-controls"
      role="group"
      aria-label="Resize canvas"
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
    >
      {EDGES.map((edge) => {
        const { unit, where, name } = LABELS[edge];
        const dimension = unit === "row" ? height : width;
        const position = placement(edge);
        if (!position) return null;
        const plural = unit === "row" ? "rows" : "columns";
        return (
          <div
            key={edge}
            className={`canvas-edge-cluster canvas-edge-${edge}${position.vertical ? " canvas-edge-cluster-vertical" : ""}`}
            style={{ left: `${position.left}px`, top: `${position.top}px` }}
          >
            <button
              type="button"
              className="canvas-edge-button"
              aria-label={`Remove a ${unit} ${where}`}
              title={`Remove a ${unit} ${where}`}
              disabled={dimension <= 1}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => controller?.resizeCanvasEdge(edge, -1)}
            >
              <span aria-hidden="true">−</span>
            </button>
            <button
              type="button"
              className="canvas-edge-button canvas-edge-handle"
              aria-label={`Drag the ${name} edge`}
              title={`Drag to resize · arrow keys add or remove ${plural}`}
              aria-pressed={dragging?.edge === edge}
              onPointerDown={(event) => {
                event.stopPropagation();
                if (event.button !== 0 || draggingRef.current || !controller) return;
                event.preventDefault();
                if (!controller.beginCanvasEdgeDrag(edge, pointOf(event))) return;
                event.currentTarget.setPointerCapture?.(event.pointerId);
                const next = { edge, pointerId: event.pointerId };
                draggingRef.current = next;
                setDragging(next);
              }}
              onPointerMove={(event) => {
                if (draggingRef.current?.pointerId === event.pointerId) controller?.updateCanvasEdgeDrag(pointOf(event));
              }}
              onPointerUp={(event) => finishDrag(event, true)}
              onPointerCancel={(event) => finishDrag(event, false)}
              onLostPointerCapture={(event) => finishDrag(event, false)}
              onKeyDown={(event) => {
                const keys = KEYS[edge];
                if (event.key === keys.grow) {
                  event.preventDefault();
                  controller?.resizeCanvasEdge(edge, 1);
                } else if (event.key === keys.shrink) {
                  event.preventDefault();
                  if (dimension > 1) controller?.resizeCanvasEdge(edge, -1);
                }
              }}
            >
              <span aria-hidden="true">{position.vertical ? "↔" : "↕"}</span>
            </button>
            <button
              type="button"
              className="canvas-edge-button"
              aria-label={`Add a ${unit} ${where}`}
              title={`Add a ${unit} ${where}`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => controller?.resizeCanvasEdge(edge, 1)}
            >
              <span aria-hidden="true">+</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
