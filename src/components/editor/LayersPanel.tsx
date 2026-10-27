import { Fragment, useEffect, useRef, useState } from "react";
import {
  DndContext,
  MouseSensor,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { LayerSelection } from "../../application/types";
import { canAddLayer, layerLimitMessage, type Layer, type LayeredDocument, type LayerType, type PaletteEntry } from "../../domain";
import { createThumbnailQueue, layerContentChanged, paintLayerThumbnail, paletteSignature, renderLayerThumbnailPixels, type ThumbnailQueue } from "../../rendering/layer-thumbnail";
import { pointerWithinOrClosestCenter } from "../dnd-shared";
import { useDismissable } from "../dismiss";
import { useObjectUrl } from "../object-url";
import { prefersReducedMotion } from "../motion";
import { Icon } from "../controls/Icon";
import {
  displayLayerOrder,
  layerDragId,
  resolveLayerMove,
  sharesLayerGroup,
  stepLayerMove,
  type LayerMove,
} from "./layers-dnd";

export type ActiveLayerId = number | "canvas" | "reference";
export interface LayerSelectModifiers { toggle?: boolean; range?: boolean }
type RowKind = LayerType | "canvas" | "reference";

export const LAYER_TYPE_LABELS: Record<RowKind, string> = {
  stitch: "Stitch layer",
  specialty: "Specialty layer",
  canvas: "Canvas",
  reference: "Reference image",
};

/** The only visible type label on a row; each type has its own glyph. */
export function LayerTypeSymbol({ kind }: { kind: RowKind }) {
  if (kind === "stitch") {
    return (
      <span className={`layer-type-symbol layer-type-${kind}`} title={LAYER_TYPE_LABELS[kind]} aria-hidden="true">
        <Icon name="stitch" />
      </span>
    );
  }
  const path = kind === "specialty"
    ? <path d="M4 16l5-8 5 8 6-10" />
    : kind === "canvas"
      ? <path d="M4 4h16v16H4zM4 10h16M4 15h16M10 4v16M15 4v16" />
      : <><path d="M4 5h16v14H4z" /><path d="m4 16 5-5 4 4 2-2 5 5" /></>;
  return (
    <span className={`layer-type-symbol layer-type-${kind}`} title={LAYER_TYPE_LABELS[kind]} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{path}</svg>
    </span>
  );
}

function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      {open ? <circle cx="12" cy="12" r="2.8" /> : <path d="M4 20 20 4" />}
    </svg>
  );
}

/** The row's eye button; `name` reads as "Hide <name>" or "Show <name>". */
function VisibilityToggle({ name, visible, onToggle }: { name: string; visible: boolean; onToggle: (visible: boolean) => void }) {
  return (
    <button
      type="button"
      className="layer-row-eye"
      aria-label={visible ? `Hide ${name}` : `Show ${name}`}
      title={visible ? "Hide layer" : "Show layer"}
      aria-pressed={!visible}
      onClick={() => onToggle(!visible)}
    >
      <EyeIcon open={visible} />
    </button>
  );
}

interface LayerRowShellProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  kind: RowKind;
  selected: boolean;
  thumbnail: React.ReactNode;
  name: string;
}

/** The row's select button: type glyph, thumbnail and name. */
function LayerRowShell({ kind, selected, thumbnail, name, ...rest }: LayerRowShellProps) {
  return (
    <button {...rest} type="button" className="layer-row-select" aria-pressed={selected}>
      <LayerTypeSymbol kind={kind} />
      {thumbnail}
      <span className="layer-row-name">{name}</span>
    </button>
  );
}

const SWIPE_HINT = "Swipe right to add to or remove from the selection";
const SWIPE_DISTANCE_PX = 40;
const SWIPE_CLICK_GUARD_MS = 350;

/** Moves toward the right edge that count as a swipe: far enough, rightward, and mostly horizontal. */
function swipeArmed(dx: number, dy: number, threshold: number) {
  return dx >= threshold && Math.abs(dy) < dx / 2;
}

/** Long-press threshold for touch and pen reordering. */
export const LAYER_LONG_PRESS_MS = 400;

type TouchActivator = (typeof TouchSensor.activators)[number];
type PointerActivator = (typeof PointerSensor.activators)[number];

/** Finger long-press. Apple Pencil also sends touch events, which the pen sensor already handles. */
class FingerPressSensor extends TouchSensor {
  static activators: TouchActivator[] = [{
    eventName: "onTouchStart",
    handler: (event, options) => {
      const touch = event.nativeEvent.touches[0] as (Touch & { touchType?: string }) | undefined;
      if (touch?.touchType === "stylus") return false;
      return TouchSensor.activators[0]!.handler(event, options);
    },
  }];
}

/** Pen long-press anywhere on the row. Mice reorder from the handle instead. */
class PenPressSensor extends PointerSensor {
  static activators: PointerActivator[] = [{
    eventName: "onPointerDown",
    handler: ({ nativeEvent }) => nativeEvent.pointerType === "pen" && nativeEvent.isPrimary && nativeEvent.button === 0,
  }];
}

/** Shown above a group only when it holds more than one layer. */
const GROUP_LABELS: Record<LayerType, string> = { stitch: "Stitch layers", specialty: "Specialty layers" };

interface ThumbnailSource {
  width: number;
  height: number;
  palette: readonly PaletteEntry[];
}

interface ThumbnailInputs {
  queue: ThumbnailQueue;
  layer: Layer;
  palette: string;
  width: number;
  height: number;
}

/**
 * Repaints only when this layer's content, the palette's colors or the
 * pattern size change; show/hide and rename don't. Edits replace just the
 * layers they touch, so other rows stay put. The work runs from the shared
 * idle queue, never inside the render that caused it.
 */
function LayerThumbnail({ queue, source, layer, palette }: { queue: ThumbnailQueue | null; source: React.RefObject<ThumbnailSource>; layer: Layer; palette: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scheduled = useRef<ThumbnailInputs | null>(null);
  const width = source.current.width, height = source.current.height;
  useEffect(() => {
    if (!queue) return;
    const previous = scheduled.current;
    scheduled.current = { queue, layer, palette, width, height };
    if (previous && previous.queue === queue && previous.palette === palette && previous.width === width && previous.height === height && !layerContentChanged(previous.layer, layer)) return;
    queue.schedule(layer.id, () => {
      if (canvas.current) paintLayerThumbnail(canvas.current, renderLayerThumbnailPixels(source.current, layer));
    });
  }, [queue, source, layer, palette, width, height]);
  // The cancelled job is gone, so the next mount (or StrictMode's replay) must
  // schedule again instead of treating its inputs as already painted.
  useEffect(() => () => { queue?.cancel(layer.id); scheduled.current = null; }, [queue, layer.id]);
  return <canvas ref={canvas} className="layer-thumbnail" aria-hidden="true" />;
}

interface Props {
  document: LayeredDocument;
  layerSelection: LayerSelection;
  backgroundColor: string;
  reference: { present: boolean; visible: boolean; image?: Blob };
  onSelect: (id: ActiveLayerId, modifiers?: LayerSelectModifiers) => void;
  onToggleVisibility: (layerId: number, visible: boolean) => void;
  onToggleReferenceVisibility: (visible: boolean) => void;
  onAddReference: () => void;
  onMove: (move: LayerMove) => void;
  onAdd: (type: LayerType) => void;
}

interface RowProps {
  document: LayeredDocument;
  layer: Layer;
  selected: boolean;
  primary: boolean;
  dragging: string | null;
  thumbnails: ThumbnailQueue | null;
  thumbnailSource: React.RefObject<ThumbnailSource>;
  palette: string;
  onSelect: (id: ActiveLayerId, modifiers?: LayerSelectModifiers) => void;
  onToggleVisibility: (layerId: number, visible: boolean) => void;
  onMove: (move: LayerMove) => void;
}

function LayerRow({ document, layer, selected, primary, dragging, thumbnails, thumbnailSource, palette, onSelect, onToggleVisibility, onMove }: RowProps) {
  const id = layerDragId(layer.id);
  const { listeners, setNodeRef: setDragRef, setActivatorNodeRef, transform, isDragging } = useDraggable({ id });
  const dropActive = dragging !== null && dragging !== id && sharesLayerGroup(document.layers, dragging, layer.type);
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id, disabled: !dropActive });
  const typeLabel = LAYER_TYPE_LABELS[layer.type];
  // Touch and pen swipe right on the row to toggle its membership; mouse uses Ctrl/Cmd+click.
  const swipe = useRef<{ pointerId: number; x: number; y: number; threshold: number } | null>(null);
  const swallowClick = useRef(false);
  const [swipeOffset, setSwipeOffset] = useState<number | null>(null);
  const [swipeArmedNow, setSwipeArmedNow] = useState(false);
  const reduceMotion = prefersReducedMotion();
  const endSwipe = () => {
    swipe.current = null;
    setSwipeOffset(null);
    setSwipeArmedNow(false);
  };
  const beginSwipe = (event: React.PointerEvent<HTMLLIElement>) => {
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
    if (!event.isPrimary || event.button !== 0) return;
    if ((event.target as Element).closest(".layer-row-eye, .layer-row-handle")) return;
    const width = event.currentTarget.getBoundingClientRect().width;
    swipe.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, threshold: width > 0 ? Math.min(SWIPE_DISTANCE_PX, width * 0.25) : SWIPE_DISTANCE_PX };
  };
  const moveSwipe = (event: React.PointerEvent<HTMLLIElement>) => {
    const start = swipe.current;
    if (!start || start.pointerId !== event.pointerId) return;
    if (dragging !== null || isDragging) { endSwipe(); return; }
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    const horizontal = dx > 0 && Math.abs(dy) < dx / 2;
    setSwipeOffset(horizontal ? Math.min(dx, start.threshold) : null);
    setSwipeArmedNow(horizontal && swipeArmed(dx, dy, start.threshold));
  };
  const releaseSwipe = (event: React.PointerEvent<HTMLLIElement>) => {
    const start = swipe.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const recognized = dragging === null && !isDragging && swipeArmed(event.clientX - start.x, event.clientY - start.y, start.threshold);
    endSwipe();
    if (!recognized) return;
    // The click that follows a swipe must not also plain-select the row.
    swallowClick.current = true;
    window.setTimeout(() => { swallowClick.current = false; }, SWIPE_CLICK_GUARD_MS);
    onSelect(layer.id, { toggle: true });
  };
  return (
    <li
      ref={(element) => { setDragRef(element); setDropRef(element); }}
      className={`layer-row${selected ? " layer-row-selected" : ""}${primary ? " layer-row-primary" : ""}${swipeArmedNow ? (selected ? " layer-row-swipe-remove" : " layer-row-swipe-add") : ""}${layer.visible ? "" : " layer-row-hidden"}${isDragging ? " layer-row-dragging" : ""}${isOver && dropActive ? " layer-row-drop" : ""}`}
      data-layer-type={layer.type}
      style={transform ? { transform: `translate3d(0, ${String(transform.y)}px, 0)` } : undefined}
      // Touch and pen reorder with a long press anywhere on the row.
      onTouchStart={listeners?.onTouchStart as React.TouchEventHandler<HTMLLIElement> | undefined}
      onPointerDown={(event) => {
        (listeners?.onPointerDown as React.PointerEventHandler<HTMLLIElement> | undefined)?.(event);
        beginSwipe(event);
      }}
      onPointerMove={moveSwipe}
      onPointerUp={releaseSwipe}
      onPointerCancel={endSwipe}
      onClickCapture={(event) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <LayerRowShell
        kind={layer.type}
        selected={selected}
        thumbnail={<LayerThumbnail queue={thumbnails} source={thumbnailSource} layer={layer} palette={palette} />}
        name={layer.name}
        aria-label={`${layer.name}, ${typeLabel}${layer.visible ? "" : ", hidden"}`}
        aria-description={SWIPE_HINT}
        title={`${layer.name}. ${SWIPE_HINT}`}
        style={swipeOffset && !reduceMotion ? { transform: `translateX(${String(swipeOffset)}px)` } : undefined}
        onClick={(event) => onSelect(layer.id, {
          toggle: event.ctrlKey || event.metaKey,
          range: event.shiftKey && !event.ctrlKey && !event.metaKey,
        })}
      />
      <VisibilityToggle name={layer.name} visible={layer.visible} onToggle={(visible) => onToggleVisibility(layer.id, visible)} />
      <button
        ref={setActivatorNodeRef}
        type="button"
        className="layer-row-handle"
        aria-label={`Reorder ${layer.name}`}
        title="Drag to reorder · arrow keys move"
        // Mouse reorders from the handle only, so row clicks stay selections.
        onMouseDown={listeners?.onMouseDown as React.MouseEventHandler<HTMLButtonElement> | undefined}
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          const move = stepLayerMove(document.layers, layer.id, event.key === "ArrowUp" ? "up" : "down");
          if (move) onMove(move);
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><circle cx="9" cy="7" r="1.4" /><circle cx="15" cy="7" r="1.4" /><circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" /><circle cx="9" cy="17" r="1.4" /><circle cx="15" cy="17" r="1.4" /></svg>
      </button>
    </li>
  );
}

export function LayersPanel({
  document,
  layerSelection,
  backgroundColor,
  reference,
  onSelect,
  onToggleVisibility,
  onToggleReferenceVisibility,
  onAddReference,
  onMove,
  onAdd,
}: Props) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const activeLayerId = layerSelection.primary;
  const referenceUrl = useObjectUrl(reference.image);
  const addButton = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // Created in an effect, not a memo: StrictMode replays effects, and a queue
  // disposed by the first cleanup would never paint again.
  const [thumbnails, setThumbnails] = useState<ThumbnailQueue | null>(null);
  useEffect(() => {
    const queue = createThumbnailQueue();
    setThumbnails(queue);
    return () => queue.dispose();
  }, []);
  // Jobs read the latest size and palette when they run, not when they were queued.
  const thumbnailSource = useRef<ThumbnailSource>(document);
  thumbnailSource.current = document;
  const palette = paletteSignature(document.palette);

  const mouseSensor = useSensor(MouseSensor, { activationConstraint: { distance: 4 } });
  const fingerSensor = useSensor(FingerPressSensor, { activationConstraint: { delay: LAYER_LONG_PRESS_MS, tolerance: 8 } });
  const penSensor = useSensor(PenPressSensor, { activationConstraint: { delay: LAYER_LONG_PRESS_MS, tolerance: 8 } });
  const sensors = useSensors(mouseSensor, fingerSensor, penSensor);

  // A pen on iPad also drives touch events; once a drag starts, keep the list from panning under it.
  useEffect(() => {
    if (dragging === null) return undefined;
    const hold = (event: TouchEvent) => event.preventDefault();
    window.addEventListener("touchmove", hold, { passive: false });
    return () => window.removeEventListener("touchmove", hold);
  }, [dragging]);

  useDismissable({ open: menuOpen, refs: [menu, addButton], onDismiss: () => setMenuOpen(false), returnFocus: addButton });
  useEffect(() => {
    if (menuOpen) menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [menuOpen]);

  const handleDragStart = (event: DragStartEvent) => setDragging(String(event.active.id));
  const handleDragEnd = (event: DragEndEvent) => {
    setDragging(null);
    if (!event.over) return;
    const move = resolveLayerMove(document.layers, event.active.id, event.over.id);
    if (move) onMove(move);
  };

  const rows = displayLayerOrder(document.layers);
  const groupSize = (type: LayerType) => document.layers.filter((layer) => layer.type === type).length;
  const addOption = (type: LayerType, label: string) => {
    const allowed = canAddLayer(document, type);
    const reasonId = `layer-add-${type}-reason`;
    return (
      <button
        type="button"
        role="menuitem"
        disabled={!allowed}
        aria-describedby={allowed ? undefined : reasonId}
        onClick={() => { setMenuOpen(false); onAdd(type); }}
      >
        <LayerTypeSymbol kind={type} />
        <span>{label}</span>
        {!allowed && <small id={reasonId}>{layerLimitMessage(type)}</small>}
      </button>
    );
  };

  return (
    <section className="layers-panel" aria-label="Layers">
      <h3 className="layers-panel-heading">Layers</h3>
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithinOrClosestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setDragging(null)}
      >
        <ul className="layers-list">
          {reference.present ? (
            <li className={`layer-row layer-row-pinned${activeLayerId === "reference" ? " layer-row-selected" : ""}${reference.visible ? "" : " layer-row-hidden"}`} data-layer-type="reference">
              <LayerRowShell
                kind="reference"
                selected={activeLayerId === "reference"}
                thumbnail={referenceUrl
                  ? <img className="layer-thumbnail" src={referenceUrl} alt="" aria-hidden="true" />
                  : <span className="layer-thumbnail layer-thumbnail-reference" aria-hidden="true" />}
                name="Reference"
                aria-label={`Reference image${reference.visible ? "" : ", hidden"}`}
                title="Reference image"
                onClick={() => onSelect("reference")}
              />
              <VisibilityToggle name="reference image" visible={reference.visible} onToggle={onToggleReferenceVisibility} />
            </li>
          ) : (
            <li className={`layer-row layer-row-pinned layer-row-collapsed${activeLayerId === "reference" ? " layer-row-selected" : ""}`} data-layer-type="reference">
              <button type="button" className="layer-row-add-reference" aria-label="Add reference image" title="Add a reference image to trace" onClick={() => { onSelect("reference"); onAddReference(); }}>
                <LayerTypeSymbol kind="reference" />
                <span>Add image</span>
              </button>
            </li>
          )}
          {rows.map((layer, index) => (
            <Fragment key={layer.id}>
              {rows[index - 1]?.type !== layer.type && groupSize(layer.type) > 1 && (
                <li className="layers-group-header">{GROUP_LABELS[layer.type]}</li>
              )}
              <LayerRow
                document={document}
                layer={layer}
                selected={layerSelection.layerIds.includes(layer.id)}
                primary={activeLayerId === layer.id}
                dragging={dragging}
                thumbnails={thumbnails}
                thumbnailSource={thumbnailSource}
                palette={palette}
                onSelect={onSelect}
                onToggleVisibility={onToggleVisibility}
                onMove={onMove}
              />
            </Fragment>
          ))}
          <li className={`layer-row layer-row-pinned${activeLayerId === "canvas" ? " layer-row-selected" : ""}`} data-layer-type="canvas">
            <LayerRowShell
              kind="canvas"
              selected={activeLayerId === "canvas"}
              thumbnail={<span className="layer-thumbnail layer-thumbnail-canvas" style={{ backgroundColor }} aria-hidden="true" />}
              name="Canvas"
              aria-label="Canvas"
              title="Canvas"
              onClick={() => onSelect("canvas")}
            />
          </li>
        </ul>
      </DndContext>
      <div className="layers-add">
        <button
          ref={addButton}
          type="button"
          className="layers-add-button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls="layers-add-menu"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span aria-hidden="true">+</span> Add layer
        </button>
        {menuOpen && (
          <div ref={menu} id="layers-add-menu" className="popover-menu layers-add-menu" role="menu" aria-label="Add layer">
            {addOption("specialty", "Specialty layer")}
            {addOption("stitch", "Stitch layer")}
          </div>
        )}
      </div>
    </section>
  );
}
