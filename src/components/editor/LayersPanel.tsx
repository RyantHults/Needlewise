import { useEffect, useRef, useState } from "react";
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
import { canAddLayer, MAX_LAYERS_PER_TYPE, type Layer, type LayeredDocument, type LayerType, type PaletteEntry } from "../../domain";
import { createThumbnailQueue, layerContentChanged, paintLayerThumbnail, paletteSignature, renderLayerThumbnailPixels, type ThumbnailQueue } from "../../rendering/layer-thumbnail";
import { pointerWithinOrClosestCenter } from "../gallery-dnd";
import stitchIcon from "../../assets/editor-tools/stitch.svg";
import {
  displayLayerOrder,
  layerDragId,
  resolveLayerMove,
  sharesLayerGroup,
  stepLayerMove,
  type LayerMove,
} from "./layers-dnd";

export type ActiveLayerId = number | "canvas" | "reference";
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
        <img data-icon="stitch" src={stitchIcon} alt="" aria-hidden="true" />
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
  useEffect(() => () => queue?.cancel(layer.id), [queue, layer.id]);
  return <canvas ref={canvas} className="layer-thumbnail" aria-hidden="true" />;
}

interface Props {
  document: LayeredDocument;
  activeLayerId: ActiveLayerId;
  backgroundColor: string;
  reference: { present: boolean; visible: boolean };
  onSelect: (id: ActiveLayerId) => void;
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
  dragging: string | null;
  thumbnails: ThumbnailQueue | null;
  thumbnailSource: React.RefObject<ThumbnailSource>;
  palette: string;
  onSelect: (id: ActiveLayerId) => void;
  onToggleVisibility: (layerId: number, visible: boolean) => void;
  onMove: (move: LayerMove) => void;
}

function LayerRow({ document, layer, selected, dragging, thumbnails, thumbnailSource, palette, onSelect, onToggleVisibility, onMove }: RowProps) {
  const id = layerDragId(layer.id);
  const { listeners, setNodeRef: setDragRef, setActivatorNodeRef, transform, isDragging } = useDraggable({ id });
  const dropActive = dragging !== null && dragging !== id && sharesLayerGroup(document.layers, dragging, layer.type);
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id, disabled: !dropActive });
  const typeLabel = LAYER_TYPE_LABELS[layer.type];
  return (
    <li
      ref={(element) => { setDragRef(element); setDropRef(element); }}
      className={`layer-row${selected ? " layer-row-selected" : ""}${layer.visible ? "" : " layer-row-hidden"}${isDragging ? " layer-row-dragging" : ""}${isOver && dropActive ? " layer-row-drop" : ""}`}
      data-layer-type={layer.type}
      style={transform ? { transform: `translate3d(0, ${String(transform.y)}px, 0)` } : undefined}
      // Touch and pen reorder with a long press anywhere on the row.
      onTouchStart={listeners?.onTouchStart as React.TouchEventHandler<HTMLLIElement> | undefined}
      onPointerDown={listeners?.onPointerDown as React.PointerEventHandler<HTMLLIElement> | undefined}
    >
      <button
        type="button"
        className="layer-row-select"
        aria-pressed={selected}
        aria-label={`${layer.name}, ${typeLabel}${layer.visible ? "" : ", hidden"}`}
        title={layer.name}
        onClick={() => onSelect(layer.id)}
      >
        <LayerTypeSymbol kind={layer.type} />
        <LayerThumbnail queue={thumbnails} source={thumbnailSource} layer={layer} palette={palette} />
        <span className="layer-row-name">{layer.name}</span>
      </button>
      <button
        type="button"
        className="layer-row-eye"
        aria-label={layer.visible ? `Hide ${layer.name}` : `Show ${layer.name}`}
        title={layer.visible ? "Hide layer" : "Show layer"}
        aria-pressed={!layer.visible}
        onClick={() => onToggleVisibility(layer.id, !layer.visible)}
      >
        <EyeIcon open={layer.visible} />
      </button>
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
  activeLayerId,
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

  useEffect(() => {
    if (!menuOpen) return undefined;
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target) && !addButton.current?.contains(event.target)) setMenuOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMenuOpen(false);
      addButton.current?.focus();
    };
    globalThis.document.addEventListener("pointerdown", outside);
    globalThis.document.addEventListener("keydown", key);
    return () => {
      globalThis.document.removeEventListener("pointerdown", outside);
      globalThis.document.removeEventListener("keydown", key);
    };
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
        {!allowed && <small id={reasonId}>{`You already have ${String(MAX_LAYERS_PER_TYPE)} ${type} layers.`}</small>}
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
              <button type="button" className="layer-row-select" aria-pressed={activeLayerId === "reference"} aria-label={`Reference image${reference.visible ? "" : ", hidden"}`} title="Reference image" onClick={() => onSelect("reference")}>
                <LayerTypeSymbol kind="reference" />
                <span className="layer-thumbnail layer-thumbnail-reference" aria-hidden="true" />
                <span className="layer-row-name">Reference</span>
              </button>
              <button type="button" className="layer-row-eye" aria-label={reference.visible ? "Hide reference image" : "Show reference image"} title={reference.visible ? "Hide layer" : "Show layer"} aria-pressed={!reference.visible} onClick={() => onToggleReferenceVisibility(!reference.visible)}>
                <EyeIcon open={reference.visible} />
              </button>
            </li>
          ) : (
            <li className={`layer-row layer-row-pinned layer-row-collapsed${activeLayerId === "reference" ? " layer-row-selected" : ""}`} data-layer-type="reference">
              <button type="button" className="layer-row-add-reference" aria-label="Add reference image" title="Add a reference image to trace" onClick={() => { onSelect("reference"); onAddReference(); }}>
                <LayerTypeSymbol kind="reference" />
                <span>Add image</span>
              </button>
            </li>
          )}
          {rows.map((layer, index) => [
            rows[index - 1]?.type !== layer.type && groupSize(layer.type) > 1 && (
              <li key={`group-${layer.type}`} className="layers-group-header">{GROUP_LABELS[layer.type]}</li>
            ),
            <LayerRow
              key={layer.id}
              document={document}
              layer={layer}
              selected={activeLayerId === layer.id}
              dragging={dragging}
              thumbnails={thumbnails}
              thumbnailSource={thumbnailSource}
              palette={palette}
              onSelect={onSelect}
              onToggleVisibility={onToggleVisibility}
              onMove={onMove}
            />,
          ])}
          <li className={`layer-row layer-row-pinned${activeLayerId === "canvas" ? " layer-row-selected" : ""}`} data-layer-type="canvas">
            <button type="button" className="layer-row-select" aria-pressed={activeLayerId === "canvas"} aria-label="Canvas" title="Canvas" onClick={() => onSelect("canvas")}>
              <LayerTypeSymbol kind="canvas" />
              <span className="layer-thumbnail layer-thumbnail-canvas" style={{ backgroundColor }} aria-hidden="true" />
              <span className="layer-row-name">Canvas</span>
            </button>
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
          <div ref={menu} id="layers-add-menu" className="layers-add-menu" role="menu" aria-label="Add layer">
            {addOption("specialty", "Specialty layer")}
            {addOption("stitch", "Stitch layer")}
          </div>
        )}
      </div>
    </section>
  );
}
