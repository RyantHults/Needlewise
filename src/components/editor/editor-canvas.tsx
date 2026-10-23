import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode, type RefObject } from "react";
import {
  createEditorSurfaceController,
  createPointerEventsAdapter,
  createUiStore,
  createWorkspaceEditorGateway,
  type EditorSurfaceController,
  type EditorSurfaceControllerOptions,
  type EditorUiState,
  type EditorUiStore,
  type PointerEventsAdapterOptions,
} from "../../editor";
import { getCanvasMetrics } from "../../editor/coordinates";
import type { CanvasRenderer, RendererStyle, TraceImageBounds } from "../../editor/contracts";
import { createCanvasTarget } from "../../rendering/context";
import { createCanvasRenderer } from "../../rendering/renderer";
import type { PatternDocument } from "../../domain";
import type { ProjectWorkspace } from "../../application/workspace";

export interface EditorCanvasRefs {
  frame: RefObject<HTMLDivElement | null>;
  base: RefObject<HTMLCanvasElement | null>;
  overlay: RefObject<HTMLCanvasElement | null>;
  /** Where keyboard events are read; the frame when omitted. */
  keyboardSurface?: RefObject<HTMLElement | null>;
}

/** A started canvas: what `onStart` is handed and what its cleanup runs before disposing. */
export interface EditorCanvasParts {
  controller: EditorSurfaceController;
  store: EditorUiStore;
  frame: HTMLDivElement;
}

type ControllerExtras = Omit<EditorSurfaceControllerOptions, "gateway" | "renderer" | "uiStore" | "metrics" | "onTraceBoundsChange"> & {
  onTraceBoundsChange?: (bounds: TraceImageBounds, controller: EditorSurfaceController) => void;
};

interface EditorCanvasOptions {
  workspace: ProjectWorkspace;
  document: PatternDocument;
  refs: EditorCanvasRefs;
  initialUi: Partial<EditorUiState>;
  rendererStyle?: Partial<RendererStyle>;
  adapterOptions?: Omit<PointerEventsAdapterOptions, "keyboardSurface">;
  controllerOptions?: ControllerExtras;
  /** The caller's own listeners on the started canvas; the cleanup runs before the controller is disposed. */
  onStart?: (parts: EditorCanvasParts) => (() => void) | void;
}

/**
 * Creates the canvas, controller and pointer input for one workspace, sizes it
 * to the frame, fits the pattern, and keeps the rendered document current.
 * Every option except `workspace` and `document` is read once, when the canvas
 * is created.
 */
export function useEditorCanvas(options: EditorCanvasOptions): {
  controller: EditorSurfaceController | null;
  renderer: CanvasRenderer | null;
  ui: EditorUiState | null;
  fallback: boolean;
} {
  const latest = useRef(options);
  latest.current = options;
  const { workspace, document } = options;
  const [running, setRunning] = useState<{ controller: EditorSurfaceController; renderer: CanvasRenderer } | null>(null);
  const [ui, setUi] = useState<EditorUiState | null>(null);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    const { refs, initialUi, rendererStyle, adapterOptions, controllerOptions, onStart } = latest.current;
    const el = refs.frame.current,
      base = refs.base.current,
      overlay = refs.overlay.current,
      keyboardSurface = refs.keyboardSurface ? refs.keyboardSurface.current : el;
    if (!el || !base || !overlay || !keyboardSurface) return;
    try {
      const measure = () =>
        getCanvasMetrics(
          Math.max(1, el.getBoundingClientRect().width || 640),
          Math.max(1, el.getBoundingClientRect().height || 480),
          { devicePixelRatio: 1 },
        );
      const metrics = getCanvasMetrics(640, 480, { devicePixelRatio: 1 });
      const store = createUiStore(initialUi);
      const gateway = createWorkspaceEditorGateway(workspace);
      const renderer = createCanvasRenderer({
        document: latest.current.document,
        targets: { base: createCanvasTarget(base), overlay: createCanvasTarget(overlay) },
        metrics,
        ...(rendererStyle ? { style: rendererStyle } : {}),
      });
      const { onTraceBoundsChange, ...extras } = controllerOptions ?? {};
      const controller: EditorSurfaceController = createEditorSurfaceController({
        ...extras,
        gateway,
        renderer,
        uiStore: store,
        metrics,
        ...(onTraceBoundsChange ? { onTraceBoundsChange: (bounds: TraceImageBounds) => onTraceBoundsChange(bounds, controller) } : {}),
      });
      setUi(store.getState());
      const unsubscribe = store.subscribe(setUi);
      const adapter = createPointerEventsAdapter(el, controller, { ...adapterOptions, keyboardSurface });
      const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => controller.setMetrics(measure()));
      observer?.observe(el);
      controller.start();
      controller.setMetrics(measure());
      controller.handleKeyDown({ key: "0", preventDefault: () => undefined });
      const detach = onStart?.({ controller, store, frame: el });
      setRunning({ controller, renderer });
      return () => {
        unsubscribe();
        detach?.();
        observer?.disconnect();
        adapter.dispose();
        controller.dispose();
        gateway.dispose();
        renderer.dispose();
        setRunning(null);
      };
    } catch {
      setFallback(true);
    }
  }, [workspace]);

  const controller = running?.controller ?? null;
  useEffect(() => {
    controller?.setDocument(document, { layer: "all", full: true, reason: "external-document" });
  }, [document, controller]);

  return { controller, renderer: running?.renderer ?? null, ui, fallback };
}

interface CanvasFrameProps extends HTMLAttributes<HTMLDivElement> {
  refs: EditorCanvasRefs;
  fallback: boolean;
  /** Overlays drawn above the canvases. */
  children?: ReactNode;
}

/** The focusable frame holding the base and overlay canvases, or the fallback message when Canvas 2D is unavailable. */
export function CanvasFrame({ refs, fallback, className, children, ...rest }: CanvasFrameProps) {
  return (
    <div {...rest} ref={refs.frame} className={["canvas-frame", className ?? ""].filter(Boolean).join(" ")} role="group" tabIndex={0}>
      {fallback ? (
        <p className="canvas-fallback">
          Canvas preview is unavailable. Refresh the page or try a browser
          with Canvas 2D support.
        </p>
      ) : (
        <>
          <canvas ref={refs.base} aria-hidden="true" />
          <canvas ref={refs.overlay} aria-hidden="true" />
          {children}
        </>
      )}
    </div>
  );
}
