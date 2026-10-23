import { useEffect, useRef, useState } from "react";
import {
  ChartPresentationMode,
  type EditorSurfaceController,
  type EditorUiState,
  type BackstitchMode,
} from "../../editor";
import type { ProjectWorkspace } from "../../application/workspace";
import {
  DEFAULT_PATTERN_SETTINGS,
  findLayer,
} from "../../domain";
import type { LayerType, PatternDocument } from "../../domain";
import { SYMBOL_POOL } from "../../symbols";
import type { PoolEntry } from "../../symbols";
import { RangeInput } from "../RangeInput";
import { TraceImageControls, traceBoundsToWorkspace } from "./TraceImageControls";
import { LayersPanel, LAYER_TYPE_LABELS, type ActiveLayerId, type LayerSelectModifiers } from "./LayersPanel";
import { LayerControls } from "./LayerControls";
import { Toast, useToast } from "./Toast";
import type { PatternView } from "./ViewSwitch";
import { createCatalogReference, type CatalogDefinition, type CatalogRecord } from "../../catalog";
import { createPortal } from "react-dom";
import { Modal } from "../Modal";
import { ConfirmDialog } from "../ConfirmDialog";
import { ColorPickerModal } from "../ColorPickerModal";
import type { ThreadColorPickerProps } from "../ThreadColorPicker";
import { normalizeHexColor } from "../../domain/color";
import { rectsEqual } from "../../editor/rect";
import { PaletteManagerModal } from "./PaletteManagerModal";
import backstitchIcon from "../../assets/editor-tools/backstitch.svg";
import eraserIcon from "../../assets/editor-tools/eraser.svg";
import focusIcon from "../../assets/editor-tools/focus.svg";
import fillIcon from "../../assets/editor-tools/paint-bucket.svg";
import selectIcon from "../../assets/editor-tools/select.svg";
import selectOvalIcon from "../../assets/editor-tools/select-oval.svg";
import lassoIcon from "../../assets/editor-tools/lasso.svg";
import eyedropperIcon from "../../assets/editor-tools/eyedropper.svg";
import panIcon from "../../assets/editor-tools/pan.svg";
import { StitchOptionSlideout } from "./StitchOptionSlideout";
import stitchIcon from "../../assets/editor-tools/stitch.svg";
import { CanvasEdgeControls } from "./CanvasEdgeControls";
import { ViewSettings } from "./ViewSettings";
import { ActionSection } from "./ActionSection";
import { PatternHeader } from "./PatternHeader";
import { paletteCodeFor } from "./palette-code";
import { patternDimensionInfo } from "./pattern-dimensions";
import { usePatternDialogs } from "./pattern-dialogs";
import { CanvasControls } from "./CanvasControls";
import { useEditorPreferences, type HalfStitchDirection } from "./editor-preferences";
import { DockPopover, useMobileDock } from "./mobile-dock";
import { CanvasFrame, useEditorCanvas } from "./editor-canvas";
import { SegmentedControl } from "../controls/SegmentedControl";
import { ToolButton } from "../controls/ToolButton";
import { ErrorNotice } from "../controls/Notice";
import { SwatchSymbol, SymbolTile, SYMBOL_VIEWBOX, symbolSpriteId } from "../controls/SwatchSymbol";
import { useDismissable } from "../dismiss";
import { anchoredPosition } from "../anchored-position";
import { useTimedValue } from "../timed-value";
import { prefersReducedMotion } from "../motion";
import { toolAvailability, type BrushSizeTool, type EditorActiveLayer, type SelectShape, type ShapeKind } from "../../editor/contracts";
import type { ProjectSession } from "../../application/session";
interface Props {
  workspace: ProjectWorkspace;
  document: PatternDocument;
  /** Moves to another of the pattern's pages from the header switch. */
  onNavigate?: (view: PatternView) => void;
  /** Renames the pattern from the header title; without it the title is plain text. */
  onRenameTitle?: (title: string) => void;
}
type CatalogColor = CatalogRecord;
const SHAPE_CHOICES: readonly ShapeKind[] = [
  "line",
  "rectangle",
  "square",
  "circle",
  "oval",
  "triangle",
  "right-triangle",
];
/** The Select rail button's shapes, offered in Tool options while selecting or lassoing. */
type SelectChoice = { tool: "select"; shape: SelectShape; label: string; icon: string; dataIcon: string } | { tool: "lasso"; label: string; icon: string; dataIcon: string };
const SELECT_CHOICES: readonly SelectChoice[] = [
  { tool: "select", shape: "rectangle", label: "Rectangle select", icon: selectIcon, dataIcon: "select" },
  { tool: "select", shape: "oval", label: "Oval select", icon: selectOvalIcon, dataIcon: "select-oval" },
  { tool: "lasso", label: "Lasso", icon: lassoIcon, dataIcon: "lasso" },
];
const STITCH_CHOICES = [["full", "Full stitch"], ["half", "Half stitch"], ["three-quarter", "3/4 stitch"]] as const;
type StitchKind = (typeof STITCH_CHOICES)[number][0];
const BACKSTITCH_MODES = [{ value: "draw", label: "Draw" }, { value: "move", label: "Move" }] as const satisfies readonly { value: BackstitchMode; label: string }[];
const STITCH_DIRECTIONS = [{ value: "/", label: "Bottom-left to top-right" }, { value: "\\", label: "Top-left to bottom-right" }] as const;

/** How many pool entries carry each Unicode name. */
const symbolNameCounts = SYMBOL_POOL.reduce((counts, entry) => {
  counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  return counts;
}, new Map<string, number>());

/**
 * The label a pool entry is shown and announced with.
 *
 * A name only one font contributes already says which glyph it is, so it is
 * left as the font's author wrote it. A name several fonts contribute is the
 * same glyph drawn more than once, and the family that drew each variant is
 * what tells them apart, so it is credited in the label.
 */
const symbolLabel = (entry: PoolEntry): string =>
  (symbolNameCounts.get(entry.name) ?? 1) > 1 ? `${entry.name} (${entry.family})` : entry.name;

/** The heading that names the color being edited and the glyph it holds now. */
const symbolDialogTitle = (colorName: string, symbol: string | undefined): string => {
  const held = SYMBOL_POOL.find((option) => option.id === symbol);
  return held ? `Symbol for ${colorName} — ${symbolLabel(held)}` : `Symbol for ${colorName}`;
};

/** "Full stitch brush size", but "Canvas brush size" / "Canvas eraser size" for the canvas tools, whose labels already name the tool. */
const brushSizeHeading = (label: string) => (label.startsWith("Canvas ") ? `${label} size` : `${label} brush size`);
/** Stitch selections offer Copy/Paste/Move/Delete; canvas selections offer Add/Delete cells. */
type SelectionAction = "copy" | "paste" | "move" | "delete" | "add-cells" | "delete-cells";

// The symbol picker renders the palette as one continuous wall: every pool
// symbol is reachable, glyphs already held by other palette entries stay
// visible and picking one swaps the two colors' glyphs (the document keeps
// one unique symbol per color). The filter above narrows the wall on demand.
export function EditorSurface({
  workspace,
  document,
  onNavigate,
  onRenameTitle,
}: Props) {
  const catalog = workspace.catalogFor(document);
  const availableCatalogs = workspace.availableCatalogs();
  const defaultCatalogId = availableCatalogs.some((item) => item.association.catalogId === catalog?.association.catalogId)
    ? catalog!.association.catalogId
    : availableCatalogs[0]?.association.catalogId ?? "";
  const frame = useRef<HTMLDivElement>(null),
    workspaceRoot = useRef<HTMLElement>(null);
  const canvasRefs = { frame, base: useRef<HTMLCanvasElement>(null), overlay: useRef<HTMLCanvasElement>(null), keyboardSurface: workspaceRoot };
  const [lastBackstitchMode, setLastBackstitchMode] = useState<BackstitchMode>("draw");
  const [selectedShape, setSelectedShape] = useState<ShapeKind>("triangle");
  const [selectChoice, setSelectChoice] = useState<SelectChoice>(SELECT_CHOICES[0]!);
  const [lastStitchKind, setLastStitchKind] = useState<StitchKind>("full");
  const documentBackgroundColor = normalizeHexColor(document.settings?.backgroundColor ?? "") ?? DEFAULT_PATTERN_SETTINGS.backgroundColor;
  const { toast, showToast, dismissToast } = useToast();
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;
  const { controller, ui, fallback } = useEditorCanvas({
    workspace,
    document,
    refs: canvasRefs,
    initialUi: { paletteId: document.palette.find((x) => x.active)?.id ?? null, tool: { tool: "pan" } },
    adapterOptions: {
      shouldExcludeTarget: (target: unknown) =>
        target instanceof Element &&
        Boolean(target.closest('.canvas-edge-controls, .floating-paste-controls, button[aria-label="Shape"], button[aria-label="Select"], button[aria-label="Stitch"], button[aria-label="Eraser"], button[aria-label^="Backstitch"], .tool-options')),
    },
    controllerOptions: {
      catalogDefinition: catalog,
      onNotice: (message: string) => showToastRef.current(message),
      onTraceBoundsChange: (bounds, surface) => {
        const current = workspace.sourceImage;
        if (!current) return;
        const sanitized = {
          x: Math.round(bounds.x),
          y: Math.round(bounds.y),
          width: Math.max(1, Math.round(bounds.width)),
          height: Math.max(1, Math.round(bounds.height)),
        };
        const trace = surface.getTraceImage();
        if (trace && !rectsEqual(sanitized, bounds))
          surface.setTraceImage({
            ...trace,
            chartBounds: sanitized,
          });
        // The descriptor keeps workspace coordinates; the controller works locally.
        void workspace
          .applyTraceImageChange(
            { ...current, chartBounds: traceBoundsToWorkspace(sanitized, workspace.document ?? {}) },
            { label: "trace-image-bounds" },
          )
          .catch(() => undefined);
      },
    },
    onStart: ({ controller: surface, frame: el }) => {
      // The adapter prevents default on canvas presses, so focus would stay on
      // the last rail button and Enter/Escape/Backspace would never reach the
      // controller. Pull focus onto the frame unless it is already inside it.
      const focusFrame = (event: PointerEvent) => {
        if (event.target instanceof Element && event.target.closest(".canvas-edge-controls, .floating-paste-controls")) return;
        if (el.contains(globalThis.document.activeElement)) return;
        el.focus({ preventScroll: true });
      };
      el.addEventListener("pointerdown", focusFrame, true);
      // Opening a pattern leaves focus on the page body, where shortcuts such as
      // Ctrl+V never reach the editor; start with the editor focused instead,
      // unless a text field or dialog already holds focus.
      const active = globalThis.document.activeElement;
      if (!(active instanceof Element && active.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], dialog'))) {
        el.focus({ preventScroll: true });
        surface.handleFocus();
      }
      return () => el.removeEventListener("pointerdown", focusFrame, true);
    },
  });
  const traceFilePicker = useRef<(() => void) | null>(null);
  const referenceVisibility = useRef<((visible: boolean) => void) | null>(null);
  // The layer stack lives on the session; the `document` prop is its flattened composite.
  const session = workspace.session as ProjectSession | null | undefined;
  const layeredDocument = session?.layeredDocument ?? null;
  const activeLayerId: ActiveLayerId = session?.activeLayerId ?? "canvas";
  const activeLayerInfo = session?.activeLayer ?? null;
  const layerSelection = session?.layerSelection ?? { primary: activeLayerId, layerIds: typeof activeLayerId === "number" ? [activeLayerId] : [] };
  const { aidaCount, summary: dimensionSummary } = patternDimensionInfo(workspace, document);
  const [preferences, setPreferences] = useEditorPreferences(workspace);
  const railSide = preferences.railSide;
  const paletteOptions = preferences.paletteDisplay;
  const showPaletteSymbols = ui?.mode === ChartPresentationMode.Symbol || ui?.mode === ChartPresentationMode.Combined;
  const pencilModeEnabled = preferences.pencilModeEnabled;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [swapTarget, setSwapTarget] = useState<number | null>(null);
  const [backgroundPicking, setBackgroundPicking] = useState(false);
  const [paletteNotice, setPaletteNotice] = useState("");
  const addTrigger = useRef<HTMLButtonElement>(null);
  const paletteTrigger = useRef<HTMLButtonElement | null>(null);
  const [symbolTarget, setSymbolTarget] = useState<number | null>(null);
  const [symbolNotice, setSymbolNotice] = useState("");
  const [symbolFilter, setSymbolFilter] = useState("");
  const symbolTrigger = useRef<HTMLButtonElement | null>(null);
  const [paletteMenu, setPaletteMenu] = useState<number | null>(null);
  const [paletteMenuPosition, setPaletteMenuPosition] = useState<{ left: number; top: number }>({ left: 8, top: 8 });
  const menuAnchor = useRef<HTMLElement | null>(null);
  const menuElement = useRef<HTMLDivElement>(null);
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
  const deleteTrigger = useRef<HTMLButtonElement | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [managerPanel, setManagerPanel] = useState<"swap" | "add" | null>(null);
  const [managerSelectedId, setManagerSelectedId] = useState<number | null>(null);
  const managerTrigger = useRef<HTMLButtonElement | null>(null);
  const dock = useMobileDock();
  const palettePress = useRef<number | null>(null);
  const paletteLongPressed = useRef(false);
  useEffect(() => {
    controller?.setTouchMovementOnly(pencilModeEnabled);
  }, [pencilModeEnabled, controller]);
  const palette = document.palette.filter((x) => x.active),
    noThread = !palette.length;
  const activeBackstitchMode = ui?.tool.tool === "backstitch" ? (ui.tool.mode ?? "draw") : undefined;
  const selectedPalette = palette.find((x) => x.id === ui?.paletteId) ?? palette[0];
  const choose = (kind: StitchKind) => {
    const id = selectedPalette?.id;
    if (id)
      controller?.setBrush({
        kind,
        paletteId: id,
        ...(kind === "half" ? { direction: preferences.halfStitchDirection } : {}),
      } as never);
  };
  const chooseHalfDirection = (direction: HalfStitchDirection) => {
    setPreferences((current) => ({ ...current, halfStitchDirection: direction }));
    const id = selectedPalette?.id;
    if (id && selectedBrush?.kind === "half")
      controller?.setBrush({ kind: "half", direction, paletteId: id } as never);
  };
  // Tools stay visible on every layer; unavailable ones are greyed and explain
  // why on hover (title) and on tap (toast) instead of switching.
  const toolLayer: Pick<EditorActiveLayer, "kind" | "visible"> | null =
    (ui as (EditorUiState & { activeLayer?: EditorActiveLayer | null }) | null)?.activeLayer ?? activeLayerInfo;
  const canvasMode = ui?.canvasMode ?? "basic";
  const canvasCropActive = ui?.canvasCropActive ?? false;
  const availability = (tool: string) => toolAvailability(tool as never, undefined, toolLayer, canvasMode, canvasCropActive);
  const canvasCropping = toolLayer?.kind === "canvas" && canvasCropActive;
  /** In Advanced crop the Stitch button drives the canvas brush. */
  const canvasAdvanced = canvasCropping && canvasMode === "advanced";
  const showCanvasEdges = canvasCropping && canvasMode === "basic" && (ui?.canvasBasicAvailable ?? true);
  const toolGate = (tool: string, title: string) => {
    const state = availability(tool);
    return state.enabled
      ? { title, "aria-disabled": undefined, className: "rail-button" }
      : { title: state.hint ?? title, "aria-disabled": true as const, className: "rail-button rail-button-unavailable" };
  };
  /** Shows the hint and returns true when `tool` can't be used on the selected layer. */
  const refuseUnavailable = (tool: string) => {
    const state = availability(tool);
    if (state.enabled) return false;
    if (state.hint) showToast(state.hint);
    return true;
  };
  const invoke = (tool: string) => {
    if (refuseUnavailable(tool)) return;
    if (noThread && ["paint", "fill", "backstitch"].includes(tool)) return;
    if ((tool === "select" || tool === "lasso") && String(ui?.tool.tool) === tool) controller?.clearSelection();
    else controller?.setTool({ tool } as never);
  };
  const runLayerAction = (action: () => unknown) => {
    try {
      action();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "That layer change could not be made.");
    }
  };
  const selectLayer = (id: ActiveLayerId, modifiers?: LayerSelectModifiers) => runLayerAction(() => {
    if (typeof id === "number" && modifiers?.toggle) session?.toggleLayerSelected(id);
    else if (typeof id === "number" && modifiers?.range) session?.selectLayerRange(id);
    else session?.setActiveLayer(id);
  });
  const addLayer = (type: LayerType) => runLayerAction(() => session?.addLayer(type));
  const setReferenceVisible = (visible: boolean) => {
    referenceVisibility.current?.(visible);
  };
  const setCanvasBackground = (color: string) =>
    runLayerAction(() => workspace.execute({ type: "document-settings-update", settings: { backgroundColor: color } }));
  const setCanvasAidaCount = (count: number) =>
    runLayerAction(() => (session ? session.setAidaCount(count) : workspace.execute({ type: "document-settings-update", settings: { aidaCount: count } })));
  const openPalettePicker = () => {
    paletteTrigger.current = addTrigger.current;
    setSwapTarget(null);
    setBackgroundPicking(false);
    setPaletteNotice("");
    setPaletteOpen(true);
  };
  const openSwapPicker = (id: number, trigger: HTMLButtonElement) => {
    paletteTrigger.current = trigger;
    setBackgroundPicking(false);
    setPaletteNotice("");
    setSwapTarget(id);
    setPaletteOpen(true);
  };
  // The manager's chip falls back to the first color on its own, so a delete
  // or swap that removes the chip's color never leaves it pointing at nothing.
  const managerEntry = palette.find((entry) => entry.id === managerSelectedId) ?? palette[0] ?? null;
  const openPaletteManager = (trigger: HTMLButtonElement) => {
    managerTrigger.current = trigger;
    setManagerSelectedId(ui?.paletteId ?? null);
    setManagerPanel(null);
    setSwapTarget(null);
    setManagerOpen(true);
  };
  const closePaletteManager = () => {
    setManagerOpen(false);
    setManagerPanel(null);
    setSwapTarget(null);
  };
  const closeManagerPanel = () => {
    setManagerPanel(null);
    setSwapTarget(null);
  };
  const toggleManagerSwap = () => {
    if (managerPanel === "swap") {
      closeManagerPanel();
      return;
    }
    if (!managerEntry) return;
    setPaletteNotice("");
    setSwapTarget(managerEntry.id);
    setManagerPanel("swap");
  };
  const toggleManagerAdd = () => {
    if (managerPanel === "add") {
      closeManagerPanel();
      return;
    }
    setPaletteNotice("");
    setSwapTarget(null);
    setManagerPanel("add");
  };
  const selectManagerEntry = (id: number) => {
    setManagerSelectedId(id);
    if (managerPanel === "swap") setSwapTarget(id);
  };
  const deleteFromManager = (id: number, trigger: HTMLButtonElement) => {
    setManagerPanel(null);
    setSwapTarget(null);
    deleteTrigger.current = trigger;
    setDeleteTarget(id);
  };
  // The delete confirmation can sit on top of the manager; when the deleted
  // color took the manager's Delete button with it, focus falls back to the
  // manager's close button.
  const focusAfterDelete = () => window.setTimeout(() => (deleteTrigger.current?.isConnected ? deleteTrigger.current : globalThis.document.querySelector<HTMLElement>(".palette-manager-dialog .modal-close"))?.focus(), 0);
  const closeDeleteConfirm = () => {
    setDeleteTarget(null);
    focusAfterDelete();
  };
  const confirmDelete = () => {
    const id = deleteTarget;
    if (id === null) return;
    workspace.execute({ type: 'palette-delete', id });
    if (ui?.paletteId === id) controller?.selectPalette(null);
    closeDeleteConfirm();
  };
  const backgroundCatalogMatch = availableCatalogs.flatMap((item) => {
    const record = item.getByHex(documentBackgroundColor);
    return record ? [{ item, record }] : [];
  })[0];
  const backgroundCatalog = backgroundCatalogMatch?.item ?? availableCatalogs.find((item) => item.association.catalogId === defaultCatalogId);
  const openBackgroundPicker = (trigger: HTMLButtonElement) => {
    paletteTrigger.current = trigger;
    setSwapTarget(null);
    setBackgroundPicking(true);
    setPaletteNotice("");
    setPaletteOpen(true);
  };
  /** The active palette color a custom hex already names, preferring one from the picker's catalog. */
  const paletteMatchForHex = (hex: string, catalogMatch: CatalogColor | undefined, catalog: CatalogDefinition | undefined) => {
    const catalogEntry = catalog && catalogMatch
      ? palette.find((entry) => entry.active && entry.catalog?.catalogId === catalog.association.catalogId && entry.catalog.sourceId === catalogMatch.sourceId && normalizeHexColor(entry.color) === hex)
      : catalog
        ? palette.find((entry) => entry.active && entry.catalog?.catalogId === catalog.association.catalogId && normalizeHexColor(entry.color) === hex)
      : undefined;
    return catalogEntry ?? palette.find((entry) => entry.active && !entry.catalog && normalizeHexColor(entry.color) === hex);
  };
  const customActionLabel = (customColor: string | null, customCatalogColor: CatalogColor | undefined, catalog: CatalogDefinition | undefined) => {
    const customPaletteMatch = customColor ? paletteMatchForHex(customColor, customCatalogColor, catalog) : undefined;
    return backgroundPicking
      ? customColor ? `Use ${customColor}` : "Use custom color"
      : swapTarget !== null
      ? customPaletteMatch ? `Swap with ${customPaletteMatch.name}` : customCatalogColor ? `Swap with ${customCatalogColor.name}` : customColor ? `Replace with ${customColor}` : "Replace custom color"
      : customPaletteMatch
      ? `Select ${customPaletteMatch.name}`
      : customCatalogColor
        ? `Add ${customCatalogColor.name}`
        : customColor
          ? `Add ${customColor}`
          : "Add custom color";
  };
  const closePalettePicker = () => {
    setPaletteOpen(false);
    setBackgroundPicking(false);
  };
  const useBackgroundColor = (hex: string) => {
    setCanvasBackground(hex);
    closePalettePicker();
  };
  // An add from the manager closes only its panel and keeps the manager open
  // on the new color; the standalone picker closes as before.
  const finishAdd = (id: number | null) => {
    if (managerPanel === "add") {
      setManagerPanel(null);
      if (id !== null) setManagerSelectedId(id);
      return;
    }
    closePalettePicker();
  };
  const addPaletteColor = async (
    color: CatalogColor,
    definition: CatalogDefinition,
  ) => {
    try {
      const previousIds = new Set(document.palette.map((entry) => entry.id));
      const result = await workspace.execute({
        type: "palette-create",
        name: color.name,
        color: color.hex,
        catalog: createCatalogReference(definition, color),
      });
      const createdDocument = result?.document ?? workspace.getStateSnapshot().document;
      const added = createdDocument?.palette.find(
        (entry) => entry.active && entry.catalog?.catalogId === definition.association.catalogId && entry.catalog.sourceId === color.sourceId && !previousIds.has(entry.id),
      );
      if (added) controller?.selectCreatedPalette(added.id);
      finishAdd(added?.id ?? null);
    } catch (error) {
      setPaletteNotice(
        error instanceof Error
          ? error.message
          : "This color could not be added.",
      );
    }
  };
  // A swap from the manager closes only its panel and keeps the manager
  // open on the replacement; the standalone picker closes as before.
  const finishSwap = (replacementId: number | null) => {
    controller?.selectPalette(replacementId);
    setSwapTarget(null);
    if (managerPanel === "swap") {
      setManagerPanel(null);
      if (replacementId !== null) setManagerSelectedId(replacementId);
      return;
    }
    closePalettePicker();
  };
  const swapIntoCatalogColor = (color: CatalogColor, definition: CatalogDefinition) => {
    const target = swapTarget;
    if (target === null) return;
    const existing = palette.find((entry) => entry.active && entry.id !== target && entry.catalog?.catalogId === definition.association.catalogId && entry.catalog.sourceId === color.sourceId);
    try {
      if (existing) workspace.execute({ type: "palette-merge", from: target, to: existing.id });
      else workspace.execute({ type: "palette-merge", from: target, createTo: { name: color.name, color: color.hex, catalog: createCatalogReference(definition, color) } });
      const replacement = existing?.id ?? workspace.getStateSnapshot().document?.palette.find((entry) => entry.active && entry.id !== target && entry.catalog?.catalogId === definition.association.catalogId && entry.catalog.sourceId === color.sourceId)?.id ?? null;
      finishSwap(replacement);
    } catch (error) {
      setPaletteNotice(error instanceof Error ? error.message : "This color could not be swapped.");
    }
  };
  const swapIntoCustomColor = (customColor: string) => {
    const target = swapTarget;
    if (target === null) return;
    const existing = palette.find((entry) => entry.active && entry.id !== target && normalizeHexColor(entry.color) === customColor);
    try {
      if (existing) workspace.execute({ type: "palette-merge", from: target, to: existing.id });
      else workspace.execute({ type: "palette-merge", from: target, createTo: { name: customColor, color: customColor } });
      const replacement = existing?.id ?? workspace.getStateSnapshot().document?.palette.find((entry) => entry.active && entry.id !== target && normalizeHexColor(entry.color) === customColor)?.id ?? null;
      finishSwap(replacement);
    } catch (error) {
      setPaletteNotice(error instanceof Error ? error.message : "This color could not be swapped.");
    }
  };
  const addCustomColor = async (customColor: string, customCatalogColor: CatalogColor | undefined, catalog: CatalogDefinition | undefined): Promise<void> => {
    const customPaletteMatch = paletteMatchForHex(customColor, customCatalogColor, catalog);
    if (customPaletteMatch) {
      controller?.selectPalette(customPaletteMatch.id);
      finishAdd(customPaletteMatch.id);
      return;
    }
    if (customCatalogColor && catalog) {
      await addPaletteColor(customCatalogColor, catalog);
      return;
    }
    try {
      const previousIds = new Set(document.palette.map((entry) => entry.id));
      const result = await workspace.execute({
        type: "palette-create",
        name: customColor,
        color: customColor,
      });
      const createdDocument = result?.document ?? workspace.getStateSnapshot().document;
      const added = createdDocument?.palette.find(
        (entry) =>
          entry.active &&
          !entry.catalog &&
          !previousIds.has(entry.id) &&
          normalizeHexColor(entry.color) === customColor,
      );
      if (added) controller?.selectCreatedPalette(added.id);
      finishAdd(added?.id ?? null);
    } catch (error) {
      setPaletteNotice(
        error instanceof Error
          ? error.message
          : "This color could not be added.",
      );
    }
  };
  // Shared by the standalone picker and the manager's panel; the mode comes
  // from backgroundPicking and swapTarget.
  const pickerProps: ThreadColorPickerProps = {
    catalogs: availableCatalogs,
    defaultCatalogId,
    verb: backgroundPicking ? "Use" : swapTarget === null ? "Add" : "Swap",
    onPickCatalogColor: (color, definition) => backgroundPicking ? useBackgroundColor(color.hex) : swapTarget === null ? void addPaletteColor(color, definition) : swapIntoCatalogColor(color, definition),
    onPickCustomColor: (hex, catalogMatch, definition) => backgroundPicking ? useBackgroundColor(hex) : swapTarget === null ? void addCustomColor(hex, catalogMatch, definition) : swapIntoCustomColor(hex),
    customActionLabel,
  };
  const catalogEntryCode = (entry: (typeof palette)[number]) => paletteCodeFor(entry, palette, availableCatalogs);
  const catalogEntryLabel = (entry: (typeof palette)[number]) => catalogEntryCode(entry).label;
  const openPaletteMenu = (id: number, anchor: HTMLElement) => {
    window.clearTimeout(palettePress.current ?? undefined);
    palettePress.current = null;
    menuAnchor.current = anchor;
    setPaletteMenuPosition(anchoredPosition(anchor.getBoundingClientRect(), "right", { width: 188, height: 158 }));
    setPaletteMenu(id);
  };
  const startPalettePress = (id: number, anchor: HTMLElement) => {
    paletteLongPressed.current = false;
    window.clearTimeout(palettePress.current ?? undefined);
    palettePress.current = window.setTimeout(() => {
      paletteLongPressed.current = true;
      openPaletteMenu(id, anchor);
    }, 500);
  };
  const endPalettePress = () => {
    window.clearTimeout(palettePress.current ?? undefined);
    palettePress.current = null;
  };
  const [pickPulse, setPickPulse, clearPickPulse] = useTimedValue<{ paletteId: number; seq: number }>(1400);
  const pendingPick = useRef<{ paletteId: number; seq: number } | null>(null);
  const paletteIdsKey = palette.map((entry) => entry.id).join(",");
  useEffect(() => {
    if (ui?.pickPulse) pendingPick.current = ui.pickPulse;
    const pending = pendingPick.current;
    if (!pending || !palette.some((entry) => entry.id === pending.paletteId)) return;
    pendingPick.current = null;
    const reduce = prefersReducedMotion();
    workspaceRoot.current?.querySelectorAll(`[data-palette-id="${pending.paletteId}"]`).forEach((row) => {
      if (typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduce ? "auto" : "smooth" });
    });
    setPickPulse(pending);
  }, [ui?.pickPulse, paletteIdsKey]);
  // A Ctrl+C or Ctrl+V that registered flashes its toolbar button once.
  const [clipboardPulse, pulseClipboard] = useTimedValue<NonNullable<EditorUiState["clipboardPulse"]>>(1400);
  useEffect(() => {
    if (ui?.clipboardPulse) pulseClipboard(ui.clipboardPulse);
  }, [ui?.clipboardPulse]);
  const paletteRow = (x: (typeof palette)[number]) => (
    <div
      className={`palette-row${ui?.paletteId === x.id ? " palette-row-selected" : ""}`}
      key={x.id}
      data-palette-id={x.id}
      title={x.name}
    >
      <button
        className="palette-button"
        type="button"
        aria-label={`${x.catalog?.code ? catalogEntryLabel(x) : ""}${x.name}`}
        aria-pressed={ui?.paletteId === x.id}
        onPointerDown={(event) => startPalettePress(x.id, event.currentTarget)}
        onPointerUp={endPalettePress}
        onPointerCancel={endPalettePress}
        onContextMenu={(event) => { event.preventDefault(); openPaletteMenu(x.id, event.currentTarget); }}
        onKeyDown={(event) => {
          if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
            event.preventDefault(); openPaletteMenu(x.id, event.currentTarget);
          }
        }}
        onClick={() => {
          if (!paletteLongPressed.current) {
            controller?.selectPalette(x.id);
            // This callback is the existing-color selection path. The mobile
            // panel is the only place dock.panel can be open, so this is a
            // no-op for the desktop rail and does not affect add/manage actions.
            dock.setPanel(null);
          }
          paletteLongPressed.current = false;
        }}
      >
        <span className="palette-swatch" style={{ backgroundColor: x.color }} aria-hidden="true">
          {pickPulse?.paletteId === x.id && <span key={pickPulse.seq} className="palette-pick-pulse" aria-hidden="true" onAnimationEnd={clearPickPulse} />}
          {showPaletteSymbols && <SwatchSymbol symbol={x.symbol} color={x.color} />}
          {paletteOptions.numbers && (
            <span className={`palette-number${x.catalog ? "" : " palette-number-hex"}`}>
              {catalogEntryCode(x).brand ? <><span className="palette-brand-label">{catalogEntryCode(x).brand}</span><span className="palette-code-label">{x.catalog?.code}</span></> : catalogEntryLabel(x)}
            </span>
          )}
        </span>
      </button>
      <button
        className="palette-symbol"
        type="button"
        aria-label={`Change symbol for ${x.name}`}
        title={`Change symbol for ${x.name}`}
        onClick={(e) => openSymbolPicker(x.id, e.currentTarget)}
      >
        <SymbolTile id={x.symbol} />
      </button>
      <button
        className="palette-remove"
        type="button"
        aria-label={`Remove ${x.name}`}
        title="Swap or remove this color"
        onClick={(e) => openSwapPicker(x.id, e.currentTarget)}
      >
        ×
      </button>
      {paletteMenu === x.id && createPortal(
        <div ref={menuElement} className="palette-menu popover-menu" role="menu" aria-label={`Details for ${x.name}`} style={{ position: 'fixed', left: paletteMenuPosition.left, top: paletteMenuPosition.top, zIndex: 1000 }}>
          <strong>{x.name}</strong>
            <span>{catalogEntryLabel(x)}</span>
          <span>Symbol <SymbolTile id={x.symbol} /><span className="visually-hidden">{x.symbol}</span></span>
          <button type="button" role="menuitem" onClick={() => { const anchor = menuAnchor.current as HTMLButtonElement; openSymbolPicker(x.id, anchor); setPaletteMenu(null); }}>Change symbol</button>
          <button type="button" role="menuitem" onClick={() => { openSwapPicker(x.id, menuAnchor.current as HTMLButtonElement); setPaletteMenu(null); }}>Swap color</button>
          <button type="button" role="menuitem" className="palette-menu-delete" onClick={() => { deleteTrigger.current = menuAnchor.current as HTMLButtonElement; setDeleteTarget(x.id); setPaletteMenu(null); }}>Delete color</button>
        </div>, globalThis.document.body
      )}
    </div>
  );
  const symbolEntry =
    symbolTarget === null
      ? null
      : (palette.find((x) => x.id === symbolTarget) ?? null);
  const openSymbolPicker = (id: number, trigger: HTMLButtonElement) => {
    setSymbolNotice("");
    setSymbolFilter("");
    setSymbolTarget(id);
    symbolTrigger.current = trigger;
  };
  const closeSymbolPicker = () => {
    setSymbolTarget(null);
    setSymbolNotice("");
    setSymbolFilter("");
  };
  const assignSymbol = (symbol: string) => {
    const target = symbolTarget;
    if (target === null) return;
    const current = palette.find((x) => x.id === target);
    if (!current || current.symbol === symbol) {
      closeSymbolPicker();
      return;
    }
    try {
      const holder = palette.find(
        (x) => x.id !== target && x.symbol === symbol,
      );
      if (holder) {
        // Atomic glyph swap: two palette-update calls cannot express this,
        // because the first update would trip the duplicate-symbol guard while
        // the other color still holds the symbol being moved. The swap command
        // exchanges both glyphs in one step and keeps glyphs unique.
        workspace.execute({ type: "palette-swap", a: holder.id, b: target });
      } else {
        workspace.execute({ type: "palette-update", id: target, symbol });
      }
      closeSymbolPicker();
    } catch (error) {
      setSymbolNotice(
        error instanceof Error
          ? error.message
          : "This symbol could not be assigned.",
      );
    }
  };
  const command = (key: string, ctrlKey = false) => {
    controller?.handleKeyDown?.({
      key,
      ctrlKey,
      preventDefault: () => undefined,
    });
  };

  useDismissable({ open: paletteMenu !== null, refs: [menuElement, menuAnchor], onDismiss: () => setPaletteMenu(null), returnFocus: menuAnchor });
  const runSelectionAction = (action: SelectionAction) => {
    const surface = controller;
    if (action === "add-cells" || action === "delete-cells") surface?.applyCanvasSelection(action === "add-cells" ? "add" : "remove");
    else if (action === "copy") (surface as (EditorSurfaceController & { copySelection?: () => unknown }) | null)?.copySelection?.();
    else if (action === "paste") surface?.pasteSelection();
    else if (action === "move") surface?.moveSelection();
    else surface?.deleteSelection?.();
    window.setTimeout(() => frame.current?.focus(), 0);
  };
  const symbolFilterQuery = symbolFilter.trim().toLowerCase();
  const symbolMatches = symbolEntry
    ? SYMBOL_POOL.filter(
        (option) =>
          !symbolFilterQuery ||
          option.id.toLowerCase().includes(symbolFilterQuery) ||
          option.name.toLowerCase().includes(symbolFilterQuery),
      )
    : [];
  const projectName = workspace.metadata?.title ?? "Untitled pattern";
  const { openExport, openSettings, dialogs } = usePatternDialogs({ workspace, document, title: projectName, preferences, onPreferencesChange: setPreferences, editorOptions: "all" });
  const activeStackLayer = layeredDocument && typeof activeLayerId === "number" ? findLayer(layeredDocument, activeLayerId) : undefined;
  const activeLayerHeading = !layeredDocument || activeLayerId === "reference"
    ? "Reference image"
    : activeLayerId === "canvas"
      ? "Canvas"
      : activeStackLayer ? LAYER_TYPE_LABELS[activeStackLayer.type] : "Layer";
  const selectedBrush =
    ui?.tool.tool === "paint"
      ? ui.tool.brush
      : ui?.tool.tool === "fill"
        ? ui.tool.brush
        : undefined;
  const fullStitchActive = selectedBrush?.kind === "full";
  const halfActive = selectedBrush?.kind === "half";
  const threeQuarterActive =
    (selectedBrush as { kind?: string } | undefined)?.kind === "three-quarter";
  const backstitchActive = ui?.tool.tool === "backstitch";
  useEffect(() => { if (activeBackstitchMode) setLastBackstitchMode(activeBackstitchMode); }, [activeBackstitchMode]);
  const shapeToolDisabled = noThread || ui?.paletteId == null || !palette.some((entry) => entry.id === ui.paletteId);
  const applyShapeTool = (shape: ShapeKind) => {
    if (shapeToolDisabled || refuseUnavailable("shape")) return;
    controller?.setTool({ tool: "shape", shape } as never);
  };
  const shapeIcon = (kind: ShapeKind) => <svg data-shape-icon={kind} viewBox="0 0 24 24" aria-hidden="true"><path d={kind === "line" ? "M5 19 19 5" : kind === "rectangle" ? "M5 6h14v12H5z" : (kind as string) === "square" ? "M5 5h14v14H5z" : kind === "circle" ? "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16" : (kind as string) === "oval" ? "M12 4a8 6 0 1 0 0 12 8 6 0 0 0 0-12" : (kind as string) === "right-triangle" ? "M5 5V19H19Z" : "M12 4 20 19H4z"} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  /** The Select/Lasso choice matching the active tool; lasso matches by tool, and an unset select shape is rectangle. */
  const activeSelectChoice = SELECT_CHOICES.find((choice) => choice.tool === ui?.tool.tool && (!("shape" in choice) || !("shape" in ui.tool) || ui.tool.shape == null || ui.tool.shape === choice.shape));
  useEffect(() => { if (activeSelectChoice) setSelectChoice(activeSelectChoice); }, [activeSelectChoice]);
  const activeStitchKind = ui?.tool.tool === "paint" ? STITCH_CHOICES.find(([kind]) => kind === (selectedBrush as { kind?: string } | undefined)?.kind)?.[0] : undefined;
  useEffect(() => { if (activeStitchKind) setLastStitchKind(activeStitchKind); }, [activeStitchKind]);
  const applySelectChoice = (choice: SelectChoice) => {
    setSelectChoice(choice);
    if (refuseUnavailable(choice.tool)) return;
    controller?.setTool(("shape" in choice ? { tool: choice.tool, shape: choice.shape } : { tool: choice.tool }) as never);
  };
  /** The active tool's brush size, and the label its size control is announced with. */
  const sizeOption: { tool: BrushSizeTool; label: string } | null =
    ui?.tool.tool === "canvas-brush" ? { tool: "canvas-brush", label: "Canvas brush" }
      : ui?.tool.tool === "eraser" ? { tool: "eraser", label: canvasAdvanced ? "Canvas eraser" : "Eraser" }
        : ui?.tool.tool !== "paint" ? null
          : fullStitchActive ? { tool: "full", label: "Full stitch" }
            : halfActive ? { tool: "half", label: "Half stitch" }
              : threeQuarterActive ? { tool: "three-quarter", label: "3/4 stitch" }
                : null;
  /** The Tool options heading: the active tool's rail name, or undefined when the tool has no options and the section is hidden. */
  const toolOptionsHeading = sizeOption || backstitchActive || ui?.tool.tool === "shape" || activeSelectChoice
    ? ({ paint: "Stitch", select: "Select", lasso: "Select", shape: "Shape", backstitch: "Backstitch", eraser: "Eraser", "canvas-brush": "Canvas brush" } as Record<string, string>)[String(ui?.tool.tool)]
    : undefined;
  /** Apply/Cancel for a floating paste or move: just above the floating rect's top-right corner, below it when there is no room, clamped to the frame. */
  const floatingPaste = ui?.overlay.floatingPaste;
  const floatingPasteControls = floatingPaste && ui?.viewport ? (() => {
    const { destination: rect } = floatingPaste, { x, y, zoom } = ui.viewport;
    const width = 78, height = 36, gap = 6;
    const frameWidth = frame.current?.clientWidth || 640, frameHeight = frame.current?.clientHeight || 480;
    const right = (rect.x + rect.width - x) * zoom, top = (rect.y - y) * zoom, bottom = (rect.y + rect.height - y) * zoom;
    const above = top - gap - height;
    return {
      move: floatingPaste.mode === "move",
      left: Math.max(0, Math.min(right - width, frameWidth - width)),
      top: Math.max(0, Math.min(above >= 0 ? above : bottom + gap, frameHeight - height)),
    };
  })() : null;
  const finishFloatingPaste = (confirm: boolean) => {
    if (confirm) controller?.confirmFloatingPaste();
    else controller?.cancelFloatingPaste();
    window.setTimeout(() => frame.current?.focus(), 0);
  };
  return (
    <section ref={workspaceRoot} className="editor-workspace" aria-labelledby="editor-title">
      {/*
        One sprite for the whole pool, shared by the palette swatches, the
        symbol chip, the details menu, and the symbol picker. A tile references
        a single path instead of repeating its `d` string; the `d` is the pool's
        own value, so a mark is the same geometry the canvas paints through
        Path2D, and both fill it for the same reason they cannot disagree.
        `.symbol-sprite` keeps it inert: absolute, zero size, overflow hidden —
        a definition holder, never painted where placed.
      */}
      <svg
        className="symbol-sprite"
        viewBox={SYMBOL_VIEWBOX}
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          {SYMBOL_POOL.map((option) => (
            <path key={option.id} id={symbolSpriteId(option.id)} d={option.d} fill="currentColor" />
          ))}
        </defs>
      </svg>
      <PatternHeader
        titleId="editor-title"
        title={projectName}
        onRenameTitle={onRenameTitle}
        view="edit"
        onNavigate={onNavigate}
        undo={{ label: "Undo", onClick: () => command("z", true) }}
        redo={{ label: "Redo", onClick: () => command("y", true) }}
        onExport={openExport}
        onSettings={openSettings}
        info={<p className="editor-dimensions">{dimensionSummary}</p>}
      />
      <div className={`editor-layout rail-${railSide}`}>
        <aside ref={dock.dockRef} className="editor-rail-shell" aria-label="Editor controls">
          <DockPopover dock={dock} panel="tools">
          <nav className="editor-rail" aria-label="Editor sections">
            <button className="rail-button" type="button" aria-label="Pan" title="Pan" aria-pressed={ui?.tool.tool === "pan"} onClick={() => invoke("pan")}>
              <img data-icon="pan" src={panIcon} alt="" aria-hidden="true" />
            </button>
            <button
              {...toolGate(selectChoice.tool, "Select")}
              type="button"
              aria-label="Select"
              aria-pressed={activeSelectChoice != null}
              onClick={() => { if (activeSelectChoice) invoke(activeSelectChoice.tool); else applySelectChoice(selectChoice); }}
            >
              <img data-icon="select" src={selectIcon} alt="" aria-hidden="true" />
            </button>
            <button
              {...(canvasAdvanced ? toolGate("canvas-brush", "Canvas brush") : toolGate("paint", "Stitch"))}
              type="button"
              aria-label="Stitch"
              aria-pressed={activeStitchKind != null || (canvasAdvanced && ui?.tool.tool === "canvas-brush")}
              onClick={() => {
                // On the Canvas layer in Advanced mode the stitch slot is the canvas brush.
                if (canvasAdvanced) { invoke("canvas-brush"); return; }
                if (refuseUnavailable("paint")) return;
                choose(lastStitchKind);
              }}
            >
              <img data-icon="stitch" src={stitchIcon} alt="" aria-hidden="true" />
            </button>
            <button
              {...toolGate("shape", "Shape")}
              type="button"
              disabled={shapeToolDisabled}
              aria-label="Shape"
              aria-pressed={ui?.tool.tool === "shape"}
              onClick={() => applyShapeTool(selectedShape)}
            >
              {shapeIcon(selectedShape)}
            </button>
            <button
              {...toolGate("backstitch", "Backstitch")}
              type="button"
              disabled={noThread}
              aria-label={activeBackstitchMode ? `Backstitch, ${activeBackstitchMode} mode` : "Backstitch"}
              aria-pressed={backstitchActive}
              onClick={() => { if (refuseUnavailable("backstitch")) return; controller?.setBackstitchMode(lastBackstitchMode); }}
            >
              <img data-icon="backstitch" src={backstitchIcon} alt="" aria-hidden="true" />
            </button>
            <button
              {...toolGate("eraser", canvasAdvanced ? "Canvas eraser" : "Eraser")}
              type="button"
              aria-label="Eraser"
              aria-pressed={ui?.tool.tool === "eraser"}
              onClick={() => invoke("eraser")}
            >
              <img data-icon="eraser" src={eraserIcon} alt="" aria-hidden="true" />
            </button>
            <button
              {...toolGate("fill", "Fill")}
              type="button"
              aria-label="Fill"
              disabled={noThread}
              aria-pressed={ui?.tool.tool === "fill"}
              onClick={() => invoke("fill")}
            >
              <img data-icon="paint-bucket" src={fillIcon} alt="" aria-hidden="true" />
            </button>
            <button
              {...toolGate("eyedropper", "Eyedropper")}
              type="button"
              aria-label="Eyedropper"
              aria-pressed={ui?.tool.tool === "eyedropper"}
              onClick={() => invoke("eyedropper")}
            >
              <img data-icon="eyedropper" src={eyedropperIcon} alt="" aria-hidden="true" />
            </button>
          </nav>
          </DockPopover>
          <DockPopover dock={dock} panel="colors">
          <div className="palette-rail" role="region" aria-label="Thread colors">
            <div className="palette-rail-actions">
              <button
                ref={addTrigger}
                className="palette-add-rail"
                type="button"
                aria-label="Add new color"
                title="Add new color"
                onClick={openPalettePicker}
              ><span className="palette-add-glyph">+</span></button>
              <button
                className="palette-manage-rail"
                type="button"
                aria-label="Manage palette"
                title="Manage palette"
                onClick={(e) => openPaletteManager(e.currentTarget)}
              ><span className="palette-manage-glyph" aria-hidden="true"><svg viewBox="0 0 16 16" width="16" height="16" focusable="false"><rect x="2" y="2" width="5" height="5" rx="1" fill="currentColor" /><rect x="9" y="2" width="5" height="5" rx="1" fill="currentColor" /><rect x="2" y="9" width="5" height="5" rx="1" fill="currentColor" /><rect x="9" y="9" width="5" height="5" rx="1" fill="currentColor" /></svg></span></button>
              <button
                className="palette-focus-rail"
                type="button"
                aria-label="Focus Color"
                aria-pressed={ui?.focusColor ?? false}
                title="Focus Color"
                disabled={palette.length === 0}
                onClick={() => controller?.toggleFocusColor()}
              ><span className="palette-focus-glyph" aria-hidden="true"><img data-icon="focus" src={focusIcon} alt="" aria-hidden="true" /></span></button>
            </div>
            <div className="palette-rail-items">
              {palette.map(paletteRow)}
            </div>
          </div>
          {layeredDocument && (
            <LayersPanel
              document={layeredDocument}
              layerSelection={layerSelection}
              backgroundColor={documentBackgroundColor}
              reference={{ present: Boolean(workspace.sourceImage), visible: workspace.sourceImage?.traceVisible ?? true }}
              onSelect={selectLayer}
              onToggleVisibility={(layerId, visible) => runLayerAction(() => session?.setLayerVisibility(layerId, visible))}
              onToggleReferenceVisibility={setReferenceVisible}
              onAddReference={() => traceFilePicker.current?.()}
              onMove={(move) => runLayerAction(() => session?.moveLayer(move.layerId, move.toIndex))}
              onAdd={addLayer}
            />
          )}
          </DockPopover>
        </aside>
        <div className="canvas-column">
          <div className="canvas-actions">
            <ActionSection id="reference-actions-label" label={activeLayerHeading} className="reference-actions layer-actions">
              {layeredDocument && activeLayerId !== "reference" && (
                <LayerControls
                  document={layeredDocument}
                  activeLayerId={activeLayerId}
                  backgroundColor={documentBackgroundColor}
                  aidaCount={aidaCount}
                  backgroundCatalog={backgroundCatalogMatch ? { name: backgroundCatalogMatch.record.name, brand: backgroundCatalogMatch.item.association.brandLabel, code: backgroundCatalogMatch.record.code } : undefined}
                  onChooseBackground={openBackgroundPicker}
                  onAidaCountChange={setCanvasAidaCount}
                  canvasMode={canvasMode}
                  canvasBasicAvailable={ui?.canvasBasicAvailable ?? true}
                  canvasCropActive={canvasCropActive}
                  onCanvasModeChange={(mode) => {
                    // Choosing a mode from the menu starts editing in it.
                    if (controller?.setCanvasMode(mode)) controller.setCanvasCropActive(true);
                  }}
                  onCanvasCropToggle={() => controller?.setCanvasCropActive(!canvasCropActive)}
                  onRename={(layerId, name) => runLayerAction(() => session?.renameLayer(layerId, name))}
                  onDuplicate={(layerId) => runLayerAction(() => session?.duplicateLayer(layerId))}
                  layerSelection={layerSelection}
                  onMerge={() => runLayerAction(() => session?.mergeSelectedLayers())}
                  onDelete={(layerId) => runLayerAction(() => session?.deleteLayer(layerId))}
                />
              )}
              {/* Always mounted: it owns decoding the reference image for the canvas. */}
              <div className="reference-layer-controls" hidden={Boolean(layeredDocument) && activeLayerId !== "reference"}>
                <TraceImageControls workspace={workspace} document={document} controller={controller} activeTool={ui?.tool.tool} filePickerRef={traceFilePicker} visibilityRef={referenceVisibility} />
              </div>
            </ActionSection>
            {toolOptionsHeading && (
              <ActionSection id="tool-options-label" label={toolOptionsHeading} className="tool-options">
                {sizeOption ? (
                  <>
                    {activeStitchKind && (
                      <div role="group" aria-label="Stitch type">
                        {STITCH_CHOICES.map(([kind, name]) => {
                          const button = (
                            <ToolButton key={kind} label={name} pressed={activeStitchKind === kind} onClick={() => choose(kind)}>
                              <span className={`stitch-brush-icon stitch-brush-icon-${kind}`} aria-hidden="true" />
                            </ToolButton>
                          );
                          if (kind !== "half") return button;
                          return (
                            <StitchOptionSlideout
                              key={kind}
                              active={activeStitchKind === kind}
                              groupLabel="Half stitch direction"
                              options={STITCH_DIRECTIONS}
                              value={preferences.halfStitchDirection}
                              onChange={chooseHalfDirection}
                            >
                              {button}
                            </StitchOptionSlideout>
                          );
                        })}
                      </div>
                    )}
                    <div className="tool-options-size">
                      <label htmlFor="tool-brush-size">Size <output>{ui?.toolBrushSizes[sizeOption.tool] ?? 1}</output></label>
                      <RangeInput id="tool-brush-size" min="1" max="10" aria-label={brushSizeHeading(sizeOption.label)} value={ui?.toolBrushSizes[sizeOption.tool] ?? 1} onChange={(event) => controller?.setToolBrushSize(sizeOption.tool, Number(event.target.value))} />
                    </div>
                  </>
                ) : backstitchActive ? (
                  <SegmentedControl
                    aria-label="Backstitch mode"
                    options={BACKSTITCH_MODES}
                    value={activeBackstitchMode ?? lastBackstitchMode}
                    onChange={(mode) => { controller?.setBackstitchMode(mode); setLastBackstitchMode(mode); }}
                  />
                ) : ui?.tool.tool === "shape" ? (
                  <div role="group" aria-label="Shape">
                    {SHAPE_CHOICES.map((shape) => {
                      const kind = shape as string;
                      const label = kind === "right-triangle" ? "Right triangle" : kind[0]!.toUpperCase() + kind.slice(1);
                      return <ToolButton key={kind} label={label} pressed={selectedShape === shape} onClick={() => { setSelectedShape(shape); applyShapeTool(shape); }}>{shapeIcon(shape)}</ToolButton>;
                    })}
                  </div>
                ) : activeSelectChoice && (
                  <>
                    <div role="group" aria-label="Selection shape">
                      {SELECT_CHOICES.map((choice) => (
                        <ToolButton key={choice.label} label={choice.label} pressed={activeSelectChoice === choice} onClick={() => applySelectChoice(choice)}>
                          <img data-icon={choice.dataIcon} src={choice.icon} alt="" aria-hidden="true" />
                        </ToolButton>
                      ))}
                    </div>
                    <div role="group" aria-label="Selection actions">
                      {(toolLayer?.kind === "canvas"
                        ? ([["add-cells", "Add", "Add selected cells to the canvas", !ui?.overlay.canvasEditing?.selection], ["delete-cells", "Delete", "Delete selected cells from the canvas", !ui?.overlay.canvasEditing?.selection]] as const)
                        : ([["copy", "Copy", "Copy selection", !ui?.overlay.selection], ["paste", "Paste", "Paste selection", !ui?.canPaste], ["move", "Move", "Move selection", !ui?.overlay.selection], ["delete", "Delete", "Delete selection", !ui?.overlay.selection]] as const)
                      ).map(([action, text, label, disabled]) => (
                        <ToolButton key={action} label={label} disabled={disabled} onClick={() => runSelectionAction(action)}>
                          {text}
                          {clipboardPulse?.action === action && <span key={clipboardPulse.seq} className="clipboard-pulse" aria-hidden="true" />}
                        </ToolButton>
                      ))}
                    </div>
                  </>
                )}
              </ActionSection>
            )}
            <ViewSettings
              mode={ui?.mode}
              threadView={ui?.threadView === true}
              onChartMode={(mode) => controller?.setChartMode(mode)}
              onThreadView={() => controller?.setThreadView(true)}
            />
            <CanvasControls onCommand={command} />
          </div>
          <CanvasFrame refs={canvasRefs} fallback={fallback} aria-label="Stitch chart canvas" aria-describedby="canvas-instructions">
            {showCanvasEdges && ui?.viewport && (
              <CanvasEdgeControls
                controller={controller}
                viewport={ui.viewport}
                width={document.width}
                height={document.height}
                frame={frame}
                previewBox={ui.overlay.canvasEditing?.preview?.kind === "resize" ? ui.overlay.canvasEditing.preview.box : null}
              />
            )}
            {floatingPasteControls && (
              <div className="floating-paste-controls" role="group" aria-label="Paste controls" style={{ left: `${floatingPasteControls.left}px`, top: `${floatingPasteControls.top}px` }}>
                <button type="button" aria-label={floatingPasteControls.move ? "Apply move" : "Apply paste"} title={floatingPasteControls.move ? "Apply move" : "Apply paste"} onPointerDown={(event) => event.stopPropagation()} onClick={() => finishFloatingPaste(true)}>✓</button>
                <button type="button" aria-label={floatingPasteControls.move ? "Cancel move" : "Cancel paste"} title={floatingPasteControls.move ? "Cancel move" : "Cancel paste"} onPointerDown={(event) => event.stopPropagation()} onClick={() => finishFloatingPaste(false)}>✗</button>
              </div>
            )}
          </CanvasFrame>
          <Toast toast={toast} onDismiss={dismissToast} />
          <div className="mobile-dock-card">
            <div className="mobile-dock-triggers" aria-label="Open editor controls">
              <button ref={dock.toolsTriggerRef} className="mobile-dock-trigger" type="button" aria-label="Tools" aria-expanded={dock.panel === "tools"} aria-controls="mobile-tools-popover" onClick={() => dock.setPanel(dock.panel === "tools" ? null : "tools")}>
                <img src={stitchIcon} alt="" aria-hidden="true" />
              </button>
              <button ref={dock.colorsTriggerRef} className="mobile-dock-trigger mobile-colors-trigger" type="button" aria-label={selectedPalette ? `Colors: ${selectedPalette.name}` : "Colors"} title={selectedPalette ? `Colors: ${selectedPalette.name}` : "Colors"} aria-expanded={dock.panel === "colors"} aria-controls="mobile-colors-popover" onClick={() => dock.setPanel(dock.panel === "colors" ? null : "colors")}>
                <span className="mobile-dock-color-swatch" style={{ backgroundColor: selectedPalette?.color ?? "#fffdf9" }} aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      </div>
      {dialogs}
      {paletteOpen && (
        <ColorPickerModal
          {...pickerProps}
          eyebrow={backgroundPicking ? backgroundCatalog?.association.brandLabel ?? "Catalog" : "Color Catalog"}
          title={backgroundPicking ? "Choose a background color" : swapTarget === null ? "Add a thread color" : "Swap Color"}
          hint={swapTarget !== null && <>Stitches and backstitches using {palette.find((entry) => entry.id === swapTarget)?.name ?? "this color"} will be changed.</>}
          initialCatalogId={backgroundPicking ? backgroundCatalog?.association.catalogId : undefined}
          initialColor={backgroundPicking ? backgroundCatalogMatch?.record : undefined}
          initialCustomHex={backgroundPicking ? documentBackgroundColor : undefined}
          notice={paletteNotice}
          onClose={closePalettePicker}
          returnFocus={paletteTrigger}
        />
      )}{" "}
      {managerOpen && (
        <PaletteManagerModal
          palette={palette}
          selected={managerEntry}
          panel={managerPanel}
          entryLabel={catalogEntryLabel}
          swatchContent={showPaletteSymbols ? (entry) => <SwatchSymbol symbol={entry.symbol} color={entry.color} /> : undefined}
          picker={pickerProps}
          notice={paletteNotice}
          onSelect={selectManagerEntry}
          onToggleSwap={toggleManagerSwap}
          onToggleAdd={toggleManagerAdd}
          onClosePanel={closeManagerPanel}
          onDelete={deleteFromManager}
          onClose={closePaletteManager}
          returnFocus={managerTrigger}
        />
      )}{" "}
      {deleteTarget !== null && (
        <ConfirmDialog
          className="palette-delete-dialog"
          eyebrow="Palette"
          title={`Delete ${palette.find((entry) => entry.id === deleteTarget)?.name ?? "color"}?`}
          message="Every stitch using this color, including backstitches, will be deleted."
          confirmLabel="Delete color"
          onConfirm={confirmDelete}
          onCancel={closeDeleteConfirm}
          returnFocus={false}
        />
      )}{" "}
      {symbolTarget !== null &&
        symbolEntry && (
            <Modal
              className="catalog-dialog"
              closeLabel="Close symbol picker"
              eyebrow="Palette"
              title={symbolDialogTitle(symbolEntry.name, symbolEntry.symbol)}
              titleId="symbol-picker-title"
              initialFocus="#symbol-filter-input"
              returnFocus={symbolTrigger}
              onClose={closeSymbolPicker}
            >
              <p className="modal-hint">
                Pick a symbol from the pool below. Every symbol is drawn by
                this application, so the preview matches the chart exactly.
                Symbols already in use by another color stay visible: picking
                one swaps the two colors' glyphs.
              </p>
              <div className="catalog-box">
                <label htmlFor="symbol-filter-input">Filter symbols</label>
                <input
                  id="symbol-filter-input"
                  value={symbolFilter}
                  onChange={(e) => setSymbolFilter(e.target.value)}
                  placeholder="Narrow by symbol name or ID"
                  autoComplete="off"
                />
              </div>
              {/*
                Tiles reference the shared sprite hoisted to the editor
                surface, so the dialog never re-defines the pool.
              */}
              {symbolMatches.length > 0 && (
                <div className="symbol-grid">
                  {symbolMatches.map((option) => {
                    const current = symbolEntry.symbol === option.id;
                    const holder = palette.find((x) => x.id !== symbolEntry.id && x.symbol === option.id);
                    return (
                      <button
                        key={option.id}
                        type="button"
                        className={holder ? "symbol-option symbol-held" : "symbol-option"}
                        aria-pressed={current}
                        aria-label={`${holder ? `Swap ${symbolLabel(option)} with ${holder.name}; currently used by ${holder.name}. ` : ""}Assign ${symbolLabel(option)} to ${symbolEntry.name}`}
                        title={holder ? `${symbolLabel(option)} (used by ${holder.name}) — pick to swap` : symbolLabel(option)}
                        onClick={() => assignSymbol(option.id)}
                      >
                        <SymbolTile id={option.id} className="symbol-preview" />
                      </button>
                    );
                  })}
                </div>
              )}
              {symbolMatches.length === 0 && symbolFilter.trim() !== "" && (
                <p className="modal-hint">
                  No symbols match "{symbolFilter.trim()}".
                </p>
              )}
              {symbolNotice && <ErrorNotice>{symbolNotice}</ErrorNotice>}
            </Modal>
        )}
    </section>
  );
}
