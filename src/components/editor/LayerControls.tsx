import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { planLayerMerge } from "../../application/layer-merge";
import type { LayerSelection } from "../../application/types";
import { canAddLayer, findLayer, MAX_LAYERS_PER_TYPE, type Layer, type LayeredDocument } from "../../domain";
import { CANVAS_BASIC_LOCKED_HINT, type CanvasEditMode } from "../../editor/contracts";
import type { ActiveLayerId } from "./LayersPanel";
import { ConfirmDialog } from "../ConfirmDialog";
import { RenameLayerDialog } from "./RenameLayerDialog";

export const AIDA_COUNTS = [11, 14, 16, 18, 22] as const;

export interface BackgroundCatalogMatch {
  name: string;
  brand: string;
  code: string;
}

interface CanvasProps {
  backgroundColor: string;
  backgroundCatalog?: BackgroundCatalogMatch;
  aidaCount: number;
  onChooseBackground: (trigger: HTMLButtonElement) => void;
  onAidaCountChange: (count: number) => void;
  /** The chosen crop mode; the Crop button is shown when `onCanvasModeChange` and `onCanvasCropToggle` are given. */
  canvasMode?: CanvasEditMode;
  /** False while the canvas is not a rectangle, which locks the mode to Advanced crop. */
  canvasBasicAvailable?: boolean;
  /** True while crop mode is on. */
  canvasCropActive?: boolean;
  onCanvasModeChange?: (mode: CanvasEditMode) => void;
  onCanvasCropToggle?: () => void;
}

const CROP_MODES: ReadonlyArray<readonly [CanvasEditMode, string, string]> = [
  ["basic", "Crop", "Add or remove whole rows and columns"],
  ["advanced", "Advanced crop", "Add or remove single cells"]
];

interface CropProps {
  mode: CanvasEditMode;
  basicAvailable: boolean;
  active: boolean;
  onModeChange: (mode: CanvasEditMode) => void;
  onToggle: () => void;
}

/**
 * Crop split button: the main part toggles crop mode in the chosen mode; the
 * arrow opens a menu choosing Crop (whole rows and columns) or Advanced crop
 * (single cells). Crop is locked while the canvas is not a rectangle.
 */
function CropSplitButton({ mode, basicAvailable, active, onModeChange, onToggle }: CropProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const arrow = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const effective: CanvasEditMode = basicAvailable ? mode : "advanced";
  const label = effective === "advanced" ? "Advanced crop" : "Crop";

  useEffect(() => {
    if (!open) return undefined;
    const items = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])].filter((item) => !item.disabled);
    (menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? items()[0])?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target) && !arrow.current?.contains(event.target)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        arrow.current?.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const enabled = items();
      const index = enabled.indexOf(globalThis.document.activeElement as HTMLButtonElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      enabled[(index + step + enabled.length) % enabled.length]?.focus();
    };
    globalThis.document.addEventListener("pointerdown", outside);
    globalThis.document.addEventListener("keydown", key, true);
    return () => {
      globalThis.document.removeEventListener("pointerdown", outside);
      globalThis.document.removeEventListener("keydown", key, true);
    };
  }, [open]);

  const openMenu = () => {
    const rect = arrow.current?.getBoundingClientRect();
    if (rect) setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 240)), top: Math.max(8, rect.top - 8) });
    setOpen(true);
  };
  const choose = (value: CanvasEditMode) => {
    setOpen(false);
    onModeChange(value);
    arrow.current?.focus();
  };

  return (
    <div className="crop-split-button" role="group" aria-label="Crop">
      <button type="button" className="crop-split-main" aria-pressed={active} title={active ? `Turn off ${label}` : `Turn on ${label}`} onClick={onToggle}>
        {label}
      </button>
      <button
        ref={arrow}
        type="button"
        className="crop-split-arrow"
        aria-label="Crop options"
        title="Crop options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        <span aria-hidden="true">▾</span>
      </button>
      {open && createPortal(
        <div
          ref={menu}
          className="layer-merge-menu crop-mode-menu"
          role="menu"
          aria-label="Crop mode"
          style={{ position: "fixed", left: position.left, top: position.top, transform: "translateY(-100%)", zIndex: 1000 }}
        >
          {CROP_MODES.map(([value, name, description]) => {
            const locked = value === "basic" && !basicAvailable;
            return (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={effective === value}
                disabled={locked}
                title={locked ? CANVAS_BASIC_LOCKED_HINT : description}
                aria-description={locked ? CANVAS_BASIC_LOCKED_HINT : description}
                onClick={() => choose(value)}
              >
                {name}
              </button>
            );
          })}
        </div>,
        globalThis.document.body,
      )}
    </div>
  );
}

/** Edit mode, background color and stitch count; each settings change is one undoable update. */
function CanvasControls({ backgroundColor, backgroundCatalog, aidaCount, onChooseBackground, onAidaCountChange, canvasMode, canvasBasicAvailable, canvasCropActive, onCanvasModeChange, onCanvasCropToggle }: CanvasProps) {
  const catalogLine = backgroundCatalog ? `${backgroundCatalog.brand} · ${backgroundCatalog.code}` : undefined;
  const description = backgroundCatalog ? `${backgroundCatalog.name}, ${catalogLine}, ${backgroundColor}` : backgroundColor;
  return (
    <div className="layer-controls layer-controls-canvas" role="group" aria-label="Canvas settings">
      {onCanvasModeChange && onCanvasCropToggle && <CropSplitButton mode={canvasMode ?? "basic"} basicAvailable={canvasBasicAvailable ?? true} active={canvasCropActive ?? false} onModeChange={onCanvasModeChange} onToggle={onCanvasCropToggle} />}
      <button
        className="layer-background-button"
        type="button"
        aria-label={`Change background color, ${description}`}
        title={`Background color: ${description}`}
        onClick={(event) => onChooseBackground(event.currentTarget)}
      >
        <span className="layer-background-swatch" style={{ background: backgroundColor }} aria-hidden="true" />
        {/* One short line: the thread code when the background is catalogued, otherwise the hex. */}
        <span className="layer-background-code" aria-hidden="true">{backgroundCatalog ? backgroundCatalog.code : backgroundColor}</span>
      </button>
      <label className="layer-control-field" htmlFor="canvas-stitch-count">
        <span>Stitch count</span>
        <select id="canvas-stitch-count" value={String(aidaCount)} onChange={(event) => onAidaCountChange(Number(event.target.value))}>
          {(AIDA_COUNTS as readonly number[]).includes(aidaCount) ? null : <option value={String(aidaCount)}>{aidaCount}</option>}
          {AIDA_COUNTS.map((count) => <option key={count} value={String(count)}>{count}</option>)}
        </select>
      </label>
    </div>
  );
}

interface LayerProps {
  document: LayeredDocument;
  layer: Layer;
  layerSelection: LayerSelection;
  onRename: (layerId: number, name: string) => void;
  onDuplicate: (layerId: number) => void;
  /** Merges the whole layer selection (see `planLayerMerge`). */
  onMerge: () => void;
  onDelete: (layerId: number) => void;
}

function StackLayerControls({ document, layer, layerSelection, onRename, onDuplicate, onMerge, onDelete }: LayerProps) {
  const [renameOpen, setRenameOpen] = useState(false);
  const renameButton = useRef<HTMLButtonElement>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const closeRename = useCallback(() => {
    setRenameOpen(false);
    window.setTimeout(() => renameButton.current?.focus(), 0);
  }, []);

  const typeWord = layer.type === "stitch" ? "stitch" : "specialty";
  const duplicateAllowed = canAddLayer(document, layer.type);
  const duplicateReason = duplicateAllowed ? "Duplicate layer" : `You already have ${String(MAX_LAYERS_PER_TYPE)} ${typeWord} layers.`;
  const merge = planLayerMerge(document, layerSelection);
  const mergeDisabledReason = merge && "disabledReason" in merge ? merge.disabledReason : undefined;
  const mergeTitle = merge && "title" in merge ? merge.title : (mergeDisabledReason ?? "Merge layers");

  return (
    <div className="layer-controls" role="group" aria-label={`${layer.name} layer actions`}>
      <button ref={renameButton} type="button" className="bottom-control layer-action" aria-label="Rename layer" title="Rename layer" aria-haspopup="dialog" onClick={() => setRenameOpen(true)}>
        <span aria-hidden="true">✎</span><small>Rename</small>
      </button>
      <button type="button" className="bottom-control layer-action" aria-label="Duplicate layer" title={duplicateReason} disabled={!duplicateAllowed} onClick={() => onDuplicate(layer.id)}>
        <span aria-hidden="true">⧉</span><small>Duplicate</small>
      </button>
      <button
        type="button"
        className="bottom-control layer-action"
        aria-label="Merge"
        title={mergeTitle}
        aria-description={mergeTitle}
        disabled={!merge || mergeDisabledReason !== undefined}
        onClick={onMerge}
      >
        <span aria-hidden="true">⤓</span><small>Merge</small>
      </button>
      <button ref={deleteButton} type="button" className="bottom-control layer-action layer-action-delete" aria-label="Delete layer" title="Delete layer" onClick={() => setDeleteOpen(true)}>
        <span aria-hidden="true">×</span><small>Delete</small>
      </button>
      {renameOpen && <RenameLayerDialog name={layer.name} onSave={(name) => onRename(layer.id, name)} onClose={closeRename} />}
      {deleteOpen && (
        <ConfirmDialog
          eyebrow="Layers"
          title={`Delete ${layer.name}?`}
          message="Everything on this layer will be removed. You can undo this."
          confirmLabel="Delete layer"
          returnFocus={deleteButton}
          onCancel={() => setDeleteOpen(false)}
          onConfirm={() => { setDeleteOpen(false); onDelete(layer.id); }}
        />
      )}
    </div>
  );
}

interface Props extends Omit<LayerProps, "layer" | "layerSelection">, CanvasProps {
  activeLayerId: ActiveLayerId;
  /** Defaults to the active layer alone. */
  layerSelection?: LayerSelection;
}

/** The contextual controls for a stitch, specialty or Canvas selection. The Reference image keeps its own controls. */
export function LayerControls({ activeLayerId, document, backgroundColor, backgroundCatalog, aidaCount, onChooseBackground, onAidaCountChange, canvasMode, canvasBasicAvailable, canvasCropActive, onCanvasModeChange, onCanvasCropToggle, layerSelection, ...actions }: Props) {
  if (activeLayerId === "canvas") {
    return <CanvasControls backgroundColor={backgroundColor} backgroundCatalog={backgroundCatalog} aidaCount={aidaCount} onChooseBackground={onChooseBackground} onAidaCountChange={onAidaCountChange} canvasMode={canvasMode} canvasBasicAvailable={canvasBasicAvailable} canvasCropActive={canvasCropActive} onCanvasModeChange={onCanvasModeChange} onCanvasCropToggle={onCanvasCropToggle} />;
  }
  if (activeLayerId === "reference") return null;
  const layer = findLayer(document, activeLayerId);
  if (!layer) return null;
  return <StackLayerControls key={layer.id} document={document} layer={layer} layerSelection={layerSelection ?? { primary: layer.id, layerIds: [layer.id] }} {...actions} />;
}
