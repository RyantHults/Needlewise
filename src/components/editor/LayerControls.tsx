import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { planLayerMerge } from "../../application/layer-merge";
import type { LayerSelection } from "../../application/types";
import { canAddLayer, findLayer, layerLimitMessage, type Layer, type LayeredDocument } from "../../domain";
import { CANVAS_BASIC_LOCKED_HINT, type CanvasEditMode } from "../../editor/contracts";
import type { ActiveLayerId } from "./LayersPanel";
import { anchoredPosition, type AnchoredPosition } from "../anchored-position";
import { ConfirmDialog } from "../ConfirmDialog";
import { ActionButton } from "../controls/ActionButton";
import { AidaCountSelect } from "../controls/AidaCountSelect";
import { nextRovingIndex } from "../controls/roving";
import { useDismissable } from "../dismiss";
import { RenameLayerDialog } from "./RenameLayerDialog";

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
  const [position, setPosition] = useState<AnchoredPosition>({ left: 8, top: 8 });
  const arrow = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const effective: CanvasEditMode = basicAvailable ? mode : "advanced";
  const label = effective === "advanced" ? "Advanced crop" : "Crop";

  const enabledItems = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])].filter((item) => !item.disabled);
  useDismissable({ open, refs: [menu, arrow], onDismiss: () => setOpen(false), returnFocus: arrow });
  useEffect(() => {
    if (!open) return;
    (menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? menu.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)'))?.focus();
  }, [open]);

  const openMenu = () => {
    const rect = arrow.current?.getBoundingClientRect();
    if (rect) setPosition(anchoredPosition(rect, "above", { width: 240, height: 0 }));
    setOpen(true);
  };
  const rove = (event: React.KeyboardEvent) => {
    const enabled = enabledItems();
    const next = nextRovingIndex(event.key, enabled.indexOf(globalThis.document.activeElement as HTMLButtonElement), enabled.length, "vertical");
    if (next === null) return;
    event.preventDefault();
    enabled[next]?.focus();
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
          className="popover-menu crop-mode-menu"
          role="menu"
          aria-label="Crop mode"
          style={{ position: "fixed", ...position, zIndex: 1000 }}
          onKeyDown={rove}
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
        <AidaCountSelect id="canvas-stitch-count" value={aidaCount} onChange={onAidaCountChange} />
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

  const duplicateAllowed = canAddLayer(document, layer.type);
  const duplicateReason = duplicateAllowed ? "Duplicate layer" : layerLimitMessage(layer.type);
  const merge = planLayerMerge(document, layerSelection);
  const mergeDisabledReason = merge && "disabledReason" in merge ? merge.disabledReason : undefined;
  const mergeTitle = merge && "title" in merge ? merge.title : (mergeDisabledReason ?? "Merge layers");

  return (
    <div className="layer-controls" role="group" aria-label={`${layer.name} layer actions`}>
      <ActionButton ref={renameButton} className="bottom-control layer-action" glyph="✎" caption="Rename" aria-label="Rename layer" title="Rename layer" aria-haspopup="dialog" onClick={() => setRenameOpen(true)} />
      <ActionButton className="bottom-control layer-action" glyph="⧉" caption="Duplicate" aria-label="Duplicate layer" title={duplicateReason} disabled={!duplicateAllowed} onClick={() => onDuplicate(layer.id)} />
      <ActionButton
        className="bottom-control layer-action"
        glyph="⤓"
        caption="Merge"
        aria-label="Merge"
        title={mergeTitle}
        aria-description={mergeTitle}
        disabled={!merge || mergeDisabledReason !== undefined}
        onClick={onMerge}
      />
      <ActionButton ref={deleteButton} className="bottom-control layer-action layer-action-delete" glyph="×" caption="Delete" aria-label="Delete layer" title="Delete layer" onClick={() => setDeleteOpen(true)} />
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
