import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { canAddLayer, findLayer, MAX_LAYERS_PER_TYPE, type Layer, type LayeredDocument } from "../../domain";
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
}

/** Background color and stitch count; each change is one undoable settings update. */
function CanvasControls({ backgroundColor, backgroundCatalog, aidaCount, onChooseBackground, onAidaCountChange }: CanvasProps) {
  const catalogLine = backgroundCatalog ? `${backgroundCatalog.brand} · ${backgroundCatalog.code}` : undefined;
  const description = backgroundCatalog ? `${backgroundCatalog.name}, ${catalogLine}, ${backgroundColor}` : backgroundColor;
  return (
    <div className="layer-controls layer-controls-canvas" role="group" aria-label="Canvas settings">
      <button
        className="layer-background-button"
        type="button"
        aria-label={`Change background color, ${description}`}
        onClick={(event) => onChooseBackground(event.currentTarget)}
      >
        <span className="layer-background-swatch" style={{ background: backgroundColor }} aria-hidden="true" />
        <span className="layer-background-details" aria-hidden="true">
          {backgroundCatalog && <strong>{backgroundCatalog.name}</strong>}
          {catalogLine && <span>{catalogLine}</span>}
          <span>{backgroundColor}</span>
        </span>
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
export function LayerControls({ activeLayerId, document, backgroundColor, backgroundCatalog, aidaCount, onChooseBackground, onAidaCountChange, ...actions }: Props) {
  if (activeLayerId === "canvas") {
    return <CanvasControls backgroundColor={backgroundColor} backgroundCatalog={backgroundCatalog} aidaCount={aidaCount} onChooseBackground={onChooseBackground} onAidaCountChange={onAidaCountChange} />;
  }
  if (activeLayerId === "reference") return null;
  const layer = findLayer(document, activeLayerId);
  if (!layer) return null;
  return <StackLayerControls key={layer.id} document={document} layer={layer} {...actions} />;
}
