import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { canAddLayer, findLayer, MAX_LAYERS_PER_TYPE, type Layer, type LayeredDocument } from "../../domain";
import { CANVAS_BASIC_LOCKED_HINT, type CanvasEditMode } from "../../editor/contracts";
import type { ActiveLayerId } from "./LayersPanel";
import { RenameLayerDialog } from "./RenameLayerDialog";

export const AIDA_COUNTS = [11, 14, 16, 18, 22] as const;

/** Layers a selected layer can merge into: other visible layers of the same type. */
export function mergeTargets(document: LayeredDocument, layer: Layer): Layer[] {
  return document.layers.filter((entry) => entry.id !== layer.id && entry.type === layer.type && entry.visible).reverse();
}

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
  onRename: (layerId: number, name: string) => void;
  onDuplicate: (layerId: number) => void;
  onMerge: (sourceId: number, targetId: number) => void;
  onDelete: (layerId: number) => void;
}

function useDialogFocus(open: boolean, dialog: React.RefObject<HTMLDivElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return undefined;
    const element = dialog.current;
    if (!element) return undefined;
    const root = globalThis.document.querySelector<HTMLElement>("[data-application]");
    const wasInert = root?.inert ?? false;
    if (root) root.inert = true;
    element.querySelector<HTMLButtonElement>("[data-dialog-cancel]")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      if (event.key !== "Tab") return;
      const controls = [...element.querySelectorAll<HTMLElement>("button,input,select,textarea")].filter((item) => !item.hasAttribute("disabled"));
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && globalThis.document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && globalThis.document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    element.addEventListener("keydown", key);
    return () => { element.removeEventListener("keydown", key); if (root) root.inert = wasInert; };
  }, [open]);
}

function StackLayerControls({ document, layer, onRename, onDuplicate, onMerge, onDelete }: LayerProps) {
  const [renameOpen, setRenameOpen] = useState(false);
  const renameButton = useRef<HTMLButtonElement>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergePosition, setMergePosition] = useState({ left: 8, top: 8 });
  const [deleteOpen, setDeleteOpen] = useState(false);
  const mergeButton = useRef<HTMLButtonElement>(null);
  const mergeMenu = useRef<HTMLDivElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const deleteDialog = useRef<HTMLDivElement>(null);
  const closeRename = useCallback(() => {
    setRenameOpen(false);
    window.setTimeout(() => renameButton.current?.focus(), 0);
  }, []);

  const targets = mergeTargets(document, layer);
  const typeWord = layer.type === "stitch" ? "stitch" : "specialty";
  const duplicateAllowed = canAddLayer(document, layer.type);
  const duplicateReason = duplicateAllowed ? "Duplicate layer" : `You already have ${String(MAX_LAYERS_PER_TYPE)} ${typeWord} layers.`;
  const mergeReason = !layer.visible
    ? "Show this layer to merge it."
    : targets.length === 0
      ? `There is no other visible ${typeWord} layer to merge into.`
      : "Merge into another layer";

  const closeDelete = () => { setDeleteOpen(false); window.setTimeout(() => deleteButton.current?.focus(), 0); };
  useDialogFocus(deleteOpen, deleteDialog, closeDelete);

  useEffect(() => {
    if (!mergeOpen) return undefined;
    mergeMenu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !mergeMenu.current?.contains(event.target) && !mergeButton.current?.contains(event.target)) setMergeOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMergeOpen(false);
      mergeButton.current?.focus();
    };
    globalThis.document.addEventListener("pointerdown", outside);
    globalThis.document.addEventListener("keydown", key);
    return () => {
      globalThis.document.removeEventListener("pointerdown", outside);
      globalThis.document.removeEventListener("keydown", key);
    };
  }, [mergeOpen]);

  const openMerge = () => {
    const rect = mergeButton.current?.getBoundingClientRect();
    if (rect) setMergePosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 220)), top: Math.max(8, rect.top - 8) });
    setMergeOpen(true);
  };

  return (
    <div className="layer-controls" role="group" aria-label={`${layer.name} layer actions`}>
      <button ref={renameButton} type="button" className="bottom-control layer-action" aria-label="Rename layer" title="Rename layer" aria-haspopup="dialog" onClick={() => setRenameOpen(true)}>
        <span aria-hidden="true">✎</span><small>Rename</small>
      </button>
      <button type="button" className="bottom-control layer-action" aria-label="Duplicate layer" title={duplicateReason} disabled={!duplicateAllowed} onClick={() => onDuplicate(layer.id)}>
        <span aria-hidden="true">⧉</span><small>Duplicate</small>
      </button>
      <button
        ref={mergeButton}
        type="button"
        className="bottom-control layer-action"
        aria-label="Merge into…"
        title={mergeReason}
        aria-haspopup="menu"
        aria-expanded={mergeOpen}
        disabled={!layer.visible || targets.length === 0}
        onClick={() => (mergeOpen ? setMergeOpen(false) : openMerge())}
      >
        <span aria-hidden="true">⤓</span><small>Merge</small>
      </button>
      <button ref={deleteButton} type="button" className="bottom-control layer-action layer-action-delete" aria-label="Delete layer" title="Delete layer" onClick={() => setDeleteOpen(true)}>
        <span aria-hidden="true">×</span><small>Delete</small>
      </button>
      {renameOpen && <RenameLayerDialog name={layer.name} onSave={(name) => onRename(layer.id, name)} onClose={closeRename} />}
      {mergeOpen && createPortal(
        <div
          ref={mergeMenu}
          className="layer-merge-menu"
          role="menu"
          aria-label={`Merge ${layer.name} into`}
          style={{ position: "fixed", left: mergePosition.left, top: mergePosition.top, transform: "translateY(-100%)", zIndex: 1000 }}
        >
          {targets.map((target) => (
            <button key={target.id} type="button" role="menuitem" onClick={() => { setMergeOpen(false); onMerge(layer.id, target.id); }}>
              {target.name}
            </button>
          ))}
        </div>,
        globalThis.document.body,
      )}
      {deleteOpen && createPortal(
        <div className="modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) closeDelete(); }}>
          <div ref={deleteDialog} className="catalog-dialog create-modal" role="dialog" aria-modal="true" aria-labelledby="delete-layer-title" aria-describedby="delete-layer-hint">
            <p className="section-label">Layers</p>
            <h2 id="delete-layer-title">{`Delete ${layer.name}?`}</h2>
            <p id="delete-layer-hint" className="modal-hint">Everything on this layer will be removed. You can undo this.</p>
            <div className="actions">
              <button className="button button-secondary" data-dialog-cancel type="button" onClick={closeDelete}>Cancel</button>
              <button className="button button-primary" type="button" onClick={() => { setDeleteOpen(false); onDelete(layer.id); }}>Delete layer</button>
            </div>
          </div>
        </div>,
        globalThis.document.body,
      )}
    </div>
  );
}

interface Props extends Omit<LayerProps, "layer">, CanvasProps {
  activeLayerId: ActiveLayerId;
}

/** The contextual controls for a stitch, specialty or Canvas selection. The Reference image keeps its own controls. */
export function LayerControls({ activeLayerId, document, backgroundColor, backgroundCatalog, aidaCount, onChooseBackground, onAidaCountChange, canvasMode, canvasBasicAvailable, canvasCropActive, onCanvasModeChange, onCanvasCropToggle, ...actions }: Props) {
  if (activeLayerId === "canvas") {
    return <CanvasControls backgroundColor={backgroundColor} backgroundCatalog={backgroundCatalog} aidaCount={aidaCount} onChooseBackground={onChooseBackground} onAidaCountChange={onAidaCountChange} canvasMode={canvasMode} canvasBasicAvailable={canvasBasicAvailable} canvasCropActive={canvasCropActive} onCanvasModeChange={onCanvasModeChange} onCanvasCropToggle={onCanvasCropToggle} />;
  }
  if (activeLayerId === "reference") return null;
  const layer = findLayer(document, activeLayerId);
  if (!layer) return null;
  return <StackLayerControls key={layer.id} document={document} layer={layer} {...actions} />;
}
