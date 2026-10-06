import { useEffect, useRef, useState } from "react";
import {
  ChartPresentationMode,
  createEditorSurfaceController,
  createUiStore,
  createWorkspaceEditorGateway,
  createPointerEventsAdapter,
  type EditorSurfaceController,
  type EditorUiState,
  type BackstitchMode,
} from "../../editor";
import { getCanvasMetrics } from "../../editor/coordinates";
import { createCanvasTarget } from "../../rendering/context";
import { createCanvasRenderer } from "../../rendering/renderer";
import type { ProjectWorkspace } from "../../application/workspace";
import {
  DEFAULT_PATTERN_AIDA_COUNT,
  findLayer,
} from "../../domain";
import type { DisplayUnits, LayerType } from "../../domain";
import { SYMBOL_POOL, SYMBOL_TILE_VIEW } from "../../symbols";
import type { PoolEntry } from "../../symbols";
import { RangeInput } from "../RangeInput";
import { TraceImageControls, traceBoundsToWorkspace } from "./TraceImageControls";
import { LayersPanel, LAYER_TYPE_LABELS, type ActiveLayerId } from "./LayersPanel";
import { LayerControls } from "./LayerControls";
import { Toast, useToast } from "./Toast";
import { createCatalogReference, type CatalogRecord } from "../../catalog";
import { useMemo } from "react";
import { createPortal } from "react-dom";
import backstitchIcon from "../../assets/editor-tools/backstitch.svg";
import eraserIcon from "../../assets/editor-tools/eraser.svg";
import fillIcon from "../../assets/editor-tools/paint-bucket.svg";
import selectIcon from "../../assets/editor-tools/select.svg";
import selectOvalIcon from "../../assets/editor-tools/select-oval.svg";
import lassoIcon from "../../assets/editor-tools/lasso.svg";
import eyedropperIcon from "../../assets/editor-tools/eyedropper.svg";
import panIcon from "../../assets/editor-tools/pan.svg";
import stitchIcon from "../../assets/editor-tools/stitch.svg";
import { CanvasEdgeControls } from "./CanvasEdgeControls";
import { contrastSymbolInk } from "../../rendering/contrast";
import { DEFAULT_HALF_DIRECTION, DEFAULT_RENDERER_STYLE, toolAvailability, type BrushSizeTool, type EditorActiveLayer, type HalfStitchBrush, type SelectShape, type ShapeKind } from "../../editor/contracts";
import type { ProjectSession } from "../../application/session";
interface Props {
  workspace: ProjectWorkspace;
  document: NonNullable<
    ReturnType<ProjectWorkspace["getStateSnapshot"]>["document"]
  >;
  onExport?: () => void;
  exportDisabled?: boolean;
  saveMessage?: string;
  saveStatus?: import("../../application/types").SaveStatus;
  onOpenMaterials?: () => void;
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
const normalizeHexColor = (value: string): string | undefined => {
  const digits = value.trim().replace(/^#/, "");
  if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(digits)) return undefined;
  const expanded = digits.length === 3
    ? digits.split("").map((digit) => `${digit}${digit}`).join("")
    : digits;
  return `#${expanded.toUpperCase()}`;
};
const modes = [
  [ChartPresentationMode.Color, "Color"],
  [ChartPresentationMode.Symbol, "Symbol"],
  [ChartPresentationMode.Grayscale, "B/W"],
  [ChartPresentationMode.Combined, "Both"],
] as const;
const EDITOR_PREFERENCES_KEY = "needlewise-editor-preferences:v1";

/** DOM id for a symbol's shared sprite path, namespaced so it cannot collide. */
const symbolSpriteId = (slug: string): string => `symbol-${slug}`;

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

/**
 * One preview of a pool symbol, drawn from the single sprite path rather than
 * repeating its `d` string. The palette swatch, the symbol chip, the details
 * menu, and the picker grid go through here, so a mark is the same geometry
 * everywhere and one value is read, not copied.
 */
const SymbolTile = ({ id, className = "symbol-token" }: { id: string; className?: string }) => (
  <svg className={className} viewBox={`${-SYMBOL_TILE_VIEW} ${-SYMBOL_TILE_VIEW} ${SYMBOL_TILE_VIEW * 2} ${SYMBOL_TILE_VIEW * 2}`} aria-hidden="true" focusable="false">
    <use href={`#${symbolSpriteId(id)}`} />
  </svg>
);

type HalfStitchDirection = NonNullable<HalfStitchBrush["direction"]>;

type EditorPreferences = {
  version: 1;
  railSide: "left" | "right";
  paletteDisplay: { symbols: boolean; numbers: boolean };
  /** Restrict finger touch to movement controls; pen input still edits. */
  pencilModeEnabled: boolean;
  /** Which diagonal a half stitch is stamped along. */
  halfStitchDirection: HalfStitchDirection;
};

/** "Full stitch brush size", but "Canvas brush size" / "Canvas eraser size" for the canvas tools, whose labels already name the tool. */
const brushSizeHeading = (label: string) => (label.startsWith("Canvas ") ? `${label} size` : `${label} brush size`);
/** Stitch selections offer Copy/Paste/Move/Delete; canvas selections offer Add/Delete cells. */
type SelectionAction = "copy" | "paste" | "move" | "delete" | "add-cells" | "delete-cells";

const defaultEditorPreferences = (): EditorPreferences => ({
  version: 1,
  railSide: "left",
  paletteDisplay: { symbols: true, numbers: true },
  pencilModeEnabled: false,
  halfStitchDirection: DEFAULT_HALF_DIRECTION,
});

const isEditorPreferences = (value: unknown): value is EditorPreferences => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<EditorPreferences> & {
    touchEditingEnabled?: unknown;
  };
  const paletteDisplay = candidate.paletteDisplay;
  return (
    candidate.version === 1 &&
    (candidate.railSide === "left" || candidate.railSide === "right") &&
    !!paletteDisplay &&
    typeof paletteDisplay === "object" &&
    typeof paletteDisplay.symbols === "boolean" &&
    typeof paletteDisplay.numbers === "boolean" &&
    (candidate.pencilModeEnabled === undefined ||
      typeof candidate.pencilModeEnabled === "boolean") &&
    (candidate.touchEditingEnabled === undefined ||
      typeof candidate.touchEditingEnabled === "boolean")
  );
};

const normalizeEditorPreferences = (value: EditorPreferences): EditorPreferences => {
  const legacy = value as EditorPreferences & { touchEditingEnabled?: boolean };
  return {
    version: value.version,
    railSide: value.railSide,
    paletteDisplay: value.paletteDisplay,
    // The earlier uncommitted envelope named the inverse setting.
    pencilModeEnabled:
      value.pencilModeEnabled ??
      (legacy.touchEditingEnabled === undefined
        ? false
        : !legacy.touchEditingEnabled),
    halfStitchDirection: value.halfStitchDirection === "\\" || value.halfStitchDirection === "/" ? value.halfStitchDirection : DEFAULT_HALF_DIRECTION,
  };
};

const readEditorPreferences = (workspaceId: string): EditorPreferences => {
  const defaults = defaultEditorPreferences();
  try {
    const stored = globalThis.localStorage.getItem(EDITOR_PREFERENCES_KEY);
    if (stored !== null) {
      try {
        const parsed = JSON.parse(stored) as unknown;
        return isEditorPreferences(parsed)
          ? normalizeEditorPreferences(parsed)
          : defaults;
      } catch {
        return defaults;
      }
    }

    const legacy = globalThis.localStorage.getItem(
      `needlewise-editor-palette:${workspaceId}`,
    );
    if (legacy === null) return defaults;

    try {
      const parsed = JSON.parse(legacy) as unknown;
      if (!parsed || typeof parsed !== "object") return defaults;
      const candidate = parsed as Partial<{ symbols: boolean; numbers: boolean }>;
      if (
        (candidate.symbols !== undefined && typeof candidate.symbols !== "boolean") ||
        (candidate.numbers !== undefined && typeof candidate.numbers !== "boolean")
      )
        return defaults;
      return {
        ...defaults,
        paletteDisplay: {
          symbols: candidate.symbols ?? true,
          numbers: candidate.numbers ?? true,
        },
      };
    } catch {
      return defaults;
    }
  } catch {
    return defaults;
  }
};
// The symbol picker renders the palette as one continuous wall: every pool
// symbol is reachable, glyphs already held by other palette entries stay
// visible and picking one swaps the two colors' glyphs (the document keeps
// one unique symbol per color). The filter above narrows the wall on demand.
export function EditorSurface({
  workspace,
  document,
  onExport,
  exportDisabled = false,
  saveMessage,
  saveStatus,
  onOpenMaterials,
}: Props) {
  const catalog = workspace.catalogFor(document);
  const availableCatalogs = workspace.availableCatalogs();
  const defaultCatalogId = availableCatalogs.some((item) => item.association.catalogId === catalog?.association.catalogId)
    ? catalog!.association.catalogId
    : availableCatalogs[0]?.association.catalogId ?? "";
  const frame = useRef<HTMLDivElement>(null),
    base = useRef<HTMLCanvasElement>(null),
    overlay = useRef<HTMLCanvasElement>(null),
    workspaceRoot = useRef<HTMLElement>(null),
    controllerRef = useRef<EditorSurfaceController | null>(null);
  const [controller, setController] = useState<EditorSurfaceController | null>(
    null,
  );
  const [ui, setUi] = useState<EditorUiState | null>(null);
  const [fallback, setFallback] = useState(false);
  const [lastBackstitchMode, setLastBackstitchMode] = useState<BackstitchMode>("draw");
  const [selectedShape, setSelectedShape] = useState<ShapeKind>("triangle");
  const [selectChoice, setSelectChoice] = useState<SelectChoice>(SELECT_CHOICES[0]!);
  const [lastStitchKind, setLastStitchKind] = useState<StitchKind>("full");
  const [open, setOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"project" | "editor">("project");
  const [title, setTitle] = useState(workspace.metadata?.title ?? "");
  const [notes, setNotes] = useState(workspace.metadata?.notes ?? "");
  const documentBackgroundColor = normalizeHexColor((document as typeof document & { settings?: { backgroundColor?: string } }).settings?.backgroundColor ?? "") ?? "#F3EEE5";
  const { toast, showToast, dismissToast } = useToast();
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;
  const traceFilePicker = useRef<(() => void) | null>(null);
  // The layer stack lives on the session; the `document` prop is its flattened composite.
  const session = workspace.session as ProjectSession | null | undefined;
  const layeredDocument = session?.layeredDocument ?? null;
  const activeLayerId: ActiveLayerId = session?.activeLayerId ?? "canvas";
  const activeLayerInfo = session?.activeLayer ?? null;
  const aidaCount = Number(layeredDocument?.settings.aidaCount ?? (document as typeof document & { settings?: { aidaCount?: number } }).settings?.aidaCount ?? DEFAULT_PATTERN_AIDA_COUNT);
  const [units, setUnits] = useState<DisplayUnits>(
    workspace.metadata?.units ?? "metric",
  );
  const [preferences, setPreferences] = useState<EditorPreferences>(() =>
    readEditorPreferences(workspace.metadata?.id ?? "default"),
  );
  const railSide = preferences.railSide;
  const paletteOptions = preferences.paletteDisplay;
  const pencilModeEnabled = preferences.pencilModeEnabled;
  const dialog = useRef<HTMLDivElement>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [selectedCatalogId, setSelectedCatalogId] = useState(defaultCatalogId);
  const [selectedCatalogColor, setSelectedCatalogColor] =
    useState<CatalogColor | null>(null);
  const [swapTarget, setSwapTarget] = useState<number | null>(null);
  const [backgroundPicking, setBackgroundPicking] = useState(false);
  const [customColorInput, setCustomColorInput] = useState("");
  const [canonicalCustomColor, setCanonicalCustomColor] = useState("#000000");
  const [paletteNotice, setPaletteNotice] = useState("");
  const addTrigger = useRef<HTMLButtonElement>(null);
  const preselectedCatalogColor = useRef<CatalogColor | null>(null);
  const paletteTrigger = useRef<HTMLButtonElement | null>(null);
  const paletteDialog = useRef<HTMLDivElement>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeQuery, setRemoveQuery] = useState("");
  const [removeCatalogId, setRemoveCatalogId] = useState(defaultCatalogId);
  const [removeNotice, setRemoveNotice] = useState("");
  const [removeTarget, setRemoveTarget] = useState<number | null>(null);
  const removeDialog = useRef<HTMLDivElement>(null);
  const removeTrigger = useRef<HTMLButtonElement>(null);
  const [symbolTarget, setSymbolTarget] = useState<number | null>(null);
  const [symbolNotice, setSymbolNotice] = useState("");
  const [symbolFilter, setSymbolFilter] = useState("");
  const symbolDialog = useRef<HTMLDivElement>(null);
  const symbolTrigger = useRef<HTMLButtonElement | null>(null);
  const [paletteMenu, setPaletteMenu] = useState<number | null>(null);
  const [paletteMenuPosition, setPaletteMenuPosition] = useState({ left: 8, top: 8 });
  const menuAnchor = useRef<HTMLElement | null>(null);
  const menuElement = useRef<HTMLDivElement>(null);
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
  const deleteTrigger = useRef<HTMLButtonElement | null>(null);
  const deleteDialog = useRef<HTMLDivElement>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [managerPanel, setManagerPanel] = useState<"swap" | "add" | null>(null);
  const [managerSelectedId, setManagerSelectedId] = useState<number | null>(null);
  const managerTrigger = useRef<HTMLButtonElement | null>(null);
  const managerDialog = useRef<HTMLDivElement>(null);
  const managerClose = useRef<HTMLButtonElement>(null);
  const managerSwapButton = useRef<HTMLButtonElement>(null);
  const managerAddButton = useRef<HTMLButtonElement>(null);
  const [mobilePanel, setMobilePanel] = useState<"tools" | "colors" | null>(null);
  const mobileDock = useRef<HTMLElement>(null);
  const mobileToolsTrigger = useRef<HTMLButtonElement>(null);
  const mobileColorsTrigger = useRef<HTMLButtonElement>(null);
  const mobilePopover = useRef<HTMLDivElement>(null);
  const palettePress = useRef<number | null>(null);
  const paletteLongPressed = useRef(false);
  useEffect(() => {
    const el = frame.current,
      b = base.current,
      o = overlay.current,
      root = workspaceRoot.current;
    if (!el || !b || !o || !root) return;
    try {
      const metrics = getCanvasMetrics(640, 480, { devicePixelRatio: 1 });
      const first = document.palette.find((x) => x.active);
      const store = createUiStore(
        first
          ? {
              paletteId: first.id,
              tool: { tool: "pan" },
            }
          : { paletteId: null, tool: { tool: "pan" } },
      );
      const gateway = createWorkspaceEditorGateway(workspace);
      const renderer = createCanvasRenderer({
        document,
        targets: {
          base: createCanvasTarget(b),
          overlay: createCanvasTarget(o),
        },
        metrics,
      });
      const c = createEditorSurfaceController({
        gateway,
        renderer,
        uiStore: store,
        metrics,
        catalogDefinition: catalog,
        onNotice: (message: string) => showToastRef.current(message),
        onTraceBoundsChange: (bounds) => {
          const current = workspace.sourceImage;
          if (!current) return;
          const sanitized = {
            x: Math.round(bounds.x),
            y: Math.round(bounds.y),
            width: Math.max(1, Math.round(bounds.width)),
            height: Math.max(1, Math.round(bounds.height)),
          };
          const trace = controllerRef.current?.getTraceImage?.();
          if (
            trace &&
            (sanitized.x !== bounds.x ||
              sanitized.y !== bounds.y ||
              sanitized.width !== bounds.width ||
              sanitized.height !== bounds.height)
          )
            controllerRef.current?.setTraceImage({
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
      });
      controllerRef.current = c;
      (c as EditorSurfaceController & {
        setTouchMovementOnly?: (only: boolean) => void;
      }).setTouchMovementOnly?.(preferences.pencilModeEnabled);
      setController(c);
      setUi(store.getState());
      const unsub = store.subscribe(setUi);
      const adapter = createPointerEventsAdapter(
        el,
        c,
        {
          keyboardSurface: root,
            shouldExcludeTarget: (target: unknown) =>
            target instanceof Element &&
            Boolean(target.closest('.canvas-edge-controls, .floating-paste-controls, button[aria-label="Shape"], button[aria-label="Select"], button[aria-label="Stitch"], button[aria-label="Eraser"], button[aria-label^="Backstitch"], .tool-options')),
        },
      );
      // The adapter prevents default on canvas presses, so focus would stay on
      // the last rail button and Enter/Escape/Backspace would never reach the
      // controller. Pull focus onto the frame unless it is already inside it.
      const focusFrame = (event: PointerEvent) => {
        if (event.target instanceof Element && event.target.closest(".canvas-edge-controls, .floating-paste-controls")) return;
        if (el.contains(globalThis.document.activeElement)) return;
        el.focus({ preventScroll: true });
      };
      el.addEventListener("pointerdown", focusFrame, true);
      const observer =
        typeof ResizeObserver === "undefined"
          ? undefined
          : new ResizeObserver(() =>
              c.setMetrics(
                getCanvasMetrics(
                  Math.max(1, el.getBoundingClientRect().width || 640),
                  Math.max(1, el.getBoundingClientRect().height || 480),
                  { devicePixelRatio: 1 },
                ),
              ),
            );
      observer?.observe(el);
      c.start();
      c.setMetrics(
        getCanvasMetrics(
          Math.max(1, el.getBoundingClientRect().width || 640),
          Math.max(1, el.getBoundingClientRect().height || 480),
          { devicePixelRatio: 1 },
        ),
      );
      c.handleKeyDown?.({ key: "0", preventDefault: () => undefined });
      return () => {
        el.removeEventListener("pointerdown", focusFrame, true);
        observer?.disconnect();
        adapter.dispose();
        c.dispose();
        gateway.dispose();
        renderer.dispose();
        controllerRef.current = null;
        setController(null);
        unsub();
      };
    } catch {
      setFallback(true);
    }
  }, [workspace]);
  useEffect(() => {
    (controllerRef.current as
      | (EditorSurfaceController & {
          setTouchMovementOnly?: (only: boolean) => void;
        })
      | null)?.setTouchMovementOnly?.(pencilModeEnabled);
  }, [pencilModeEnabled]);
  useEffect(() => {
    controllerRef.current?.setDocument(document, {
      layer: "all",
      full: true,
      reason: "external-document",
    });
  }, [document, controller]);
  useEffect(() => {
    setTitle(workspace.metadata?.title ?? "");
    setNotes(workspace.metadata?.notes ?? "");
    setUnits(workspace.metadata?.units ?? "metric");
  }, [
    workspace,
    workspace.metadata?.id,
    workspace.metadata?.title,
    workspace.metadata?.notes,
    workspace.metadata?.units,
  ]);
  useEffect(() => {
    try {
      globalThis.localStorage.setItem(
        EDITOR_PREFERENCES_KEY,
        JSON.stringify(preferences),
      );
    } catch {
      // Preferences are a convenience; private browsing must not block editing.
    }
  }, [preferences]);
  const palette = document.palette.filter((x) => x.active),
    noThread = !palette.length;
  const activeBackstitchMode = ui?.tool.tool === "backstitch" ? (ui.tool.mode ?? "draw") : undefined;
  const selectedPalette = palette.find((x) => x.id === ui?.paletteId) ?? palette[0];
  const choose = (kind: StitchKind) => {
    const id = selectedPalette?.id;
    if (id)
      controllerRef.current?.setBrush({
        kind,
        paletteId: id,
        ...(kind === "half" ? { direction: preferences.halfStitchDirection } : {}),
      } as never);
  };
  const chooseHalfDirection = (direction: HalfStitchDirection) => {
    setPreferences((current) => ({ ...current, halfStitchDirection: direction }));
    const id = selectedPalette?.id;
    if (id && halfActive)
      controllerRef.current?.setBrush({ kind: "half", direction, paletteId: id });
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
    if ((tool === "select" || tool === "lasso") && String(ui?.tool.tool) === tool) controllerRef.current?.clearSelection();
    else if (tool === "eraser" && toolLayer?.kind !== "canvas") controllerRef.current?.setEraserMode("whole-cell");
    else controllerRef.current?.setTool({ tool } as never);
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    await workspace.updateActiveMetadata({
      title: title.trim() || "Untitled sampler",
      notes,
      units,
    });
    setOpen(false);
  };
  const runLayerAction = (action: () => unknown) => {
    try {
      action();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "That layer change could not be made.");
    }
  };
  const selectLayer = (id: ActiveLayerId) => runLayerAction(() => session?.setActiveLayer(id));
  const addLayer = (type: LayerType) => runLayerAction(() => session?.addLayer(type));
  const setReferenceVisible = (visible: boolean) => {
    const current = workspace.sourceImage;
    if (!current) return;
    void workspace.applyTraceImageChange({ ...current, traceVisible: visible }, { label: "trace-image-visibility" }).catch(() => undefined);
  };
  const setCanvasBackground = (color: string) =>
    runLayerAction(() => workspace.execute({ type: "document-settings-update", settings: { backgroundColor: color } } as never));
  const setCanvasAidaCount = (count: number) =>
    runLayerAction(() => (session ? session.setAidaCount(count) : workspace.execute({ type: "document-settings-update", settings: { aidaCount: count } } as never)));
  const applyUnits = (next: DisplayUnits) => {
    setUnits(next);
    void Promise.resolve(workspace.updateActiveMetadata({ units: next })).catch(
      () => undefined,
    );
  };
  const pickerCatalog = availableCatalogs.find((item) => item.association.catalogId === selectedCatalogId);
  const replacementCatalog = availableCatalogs.find((item) => item.association.catalogId === removeCatalogId);
  const catalogResults = useMemo(
    () => pickerCatalog?.search(paletteQuery) ?? [],
    [paletteQuery, pickerCatalog],
  );
  const installedCatalogIds = availableCatalogs.map((item) => item.association.catalogId).join("\u0000");
  useEffect(() => {
    setSelectedCatalogId((current) => availableCatalogs.some((item) => item.association.catalogId === current) ? current : defaultCatalogId);
    setRemoveCatalogId((current) => availableCatalogs.some((item) => item.association.catalogId === current) ? current : defaultCatalogId);
    setPaletteQuery((current) => availableCatalogs.some((item) => item.association.catalogId === selectedCatalogId) ? current : "");
    setRemoveQuery((current) => availableCatalogs.some((item) => item.association.catalogId === removeCatalogId) ? current : "");
  }, [installedCatalogIds, defaultCatalogId, selectedCatalogId, removeCatalogId]);
  useEffect(() => {
    setSelectedCatalogId(defaultCatalogId);
    setRemoveCatalogId(defaultCatalogId);
    setPaletteQuery("");
    setRemoveQuery("");
    setSelectedCatalogColor(null);
  }, [workspace.activeProjectId, defaultCatalogId]);
  useEffect(() => {
    if (!(paletteOpen || managerPanel)) return;
    if (
      selectedCatalogColor &&
      catalogResults.some((color) => color.sourceId === selectedCatalogColor.sourceId)
    )
      return;
    setSelectedCatalogColor(catalogResults[0] ?? null);
  }, [catalogResults, paletteOpen, managerPanel, selectedCatalogColor, selectedCatalogId]);
  useEffect(() => {
    setPaletteQuery("");
    const preselected = preselectedCatalogColor.current;
    preselectedCatalogColor.current = null;
    setSelectedCatalogColor(preselected ?? pickerCatalog?.search("", { limit: 1 })[0] ?? null);
  }, [selectedCatalogId]);
  const resetPicker = () => {
    setBackgroundPicking(false);
    setPaletteNotice("");
    setPaletteQuery("");
    setCustomColorInput("#000000");
    setCanonicalCustomColor("#000000");
    setSelectedCatalogId(defaultCatalogId);
    setSelectedCatalogColor(availableCatalogs.find((item) => item.association.catalogId === defaultCatalogId)?.search("", { limit: 1 })[0] ?? null);
  };
  const openPalettePicker = () => {
    paletteTrigger.current = addTrigger.current;
    setSwapTarget(null);
    resetPicker();
    setPaletteOpen(true);
  };
  const openSwapPicker = (id: number, trigger: HTMLButtonElement) => {
    paletteTrigger.current = trigger;
    resetPicker();
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
    window.setTimeout(() => managerTrigger.current?.focus(), 0);
  };
  const closeManagerPanel = (focus: HTMLButtonElement | null) => {
    setManagerPanel(null);
    setSwapTarget(null);
    window.setTimeout(() => focus?.focus(), 0);
  };
  const toggleManagerSwap = () => {
    if (managerPanel === "swap") {
      closeManagerPanel(managerSwapButton.current);
      return;
    }
    if (!managerEntry) return;
    resetPicker();
    setSwapTarget(managerEntry.id);
    setManagerPanel("swap");
  };
  const toggleManagerAdd = () => {
    if (managerPanel === "add") {
      closeManagerPanel(managerAddButton.current);
      return;
    }
    resetPicker();
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
  const focusAfterDelete = () => window.setTimeout(() => (deleteTrigger.current?.isConnected ? deleteTrigger.current : managerClose.current)?.focus(), 0);
  const backgroundCatalogMatch = availableCatalogs.flatMap((item) => {
    const record = item.getByHex(documentBackgroundColor);
    return record ? [{ item, record }] : [];
  })[0];
  const openBackgroundPicker = (trigger: HTMLButtonElement) => {
    paletteTrigger.current = trigger;
    const defaultCatalog = availableCatalogs.find((item) => item.association.catalogId === defaultCatalogId);
    const catalog = backgroundCatalogMatch?.item ?? defaultCatalog;
    const catalogId = catalog?.association.catalogId ?? defaultCatalogId;
    const color = backgroundCatalogMatch?.record ?? null;
    setSwapTarget(null);
    setBackgroundPicking(true);
    setPaletteNotice("");
    setPaletteQuery("");
    setCustomColorInput(documentBackgroundColor);
    setCanonicalCustomColor(documentBackgroundColor);
    if (catalogId !== selectedCatalogId) preselectedCatalogColor.current = color;
    setSelectedCatalogId(catalogId);
    setSelectedCatalogColor(color ?? catalog?.search("", { limit: 1 })[0] ?? null);
    setPaletteOpen(true);
  };
  const customColor = normalizeHexColor(customColorInput);
  const setColorFromHex = (value: string) => {
    setCustomColorInput(value);
    const normalized = normalizeHexColor(value);
    if (normalized) {
      setCanonicalCustomColor(normalized);
    }
  };
  const customCatalogColor = customColor ? pickerCatalog?.getByHex(customColor) : undefined;
  const selectedCatalogPaletteMatch = customColor && pickerCatalog && customCatalogColor
    ? palette.find((entry) => entry.active && entry.catalog?.catalogId === pickerCatalog.association.catalogId && entry.catalog.sourceId === customCatalogColor.sourceId && normalizeHexColor(entry.color) === customColor)
    : customColor && pickerCatalog
      ? palette.find((entry) => entry.active && entry.catalog?.catalogId === pickerCatalog.association.catalogId && normalizeHexColor(entry.color) === customColor)
    : undefined;
  const customPaletteMatch = customColor
    ? selectedCatalogPaletteMatch ?? palette.find((entry) => entry.active && !entry.catalog && normalizeHexColor(entry.color) === customColor)
    : undefined;
  const customActionLabel = backgroundPicking
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
  const closePalettePicker = () => {
    setPaletteOpen(false);
    setBackgroundPicking(false);
    window.setTimeout(() => paletteTrigger.current?.focus(), 0);
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
      window.setTimeout(() => managerAddButton.current?.focus(), 0);
      return;
    }
    closePalettePicker();
  };
  const addPaletteColor = async (
    color: CatalogColor,
  ) => {
    try {
      const previousIds = new Set(document.palette.map((entry) => entry.id));
      const definition = pickerCatalog;
      if (!definition) return;
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
      if (added) controllerRef.current?.selectCreatedPalette(added.id);
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
    controllerRef.current?.selectPalette(replacementId);
    setSwapTarget(null);
    if (managerPanel === "swap") {
      setManagerPanel(null);
      if (replacementId !== null) setManagerSelectedId(replacementId);
      window.setTimeout(() => managerSwapButton.current?.focus(), 0);
      return;
    }
    closePalettePicker();
  };
  const swapIntoCatalogColor = (color: CatalogColor) => {
    const target = swapTarget;
    const definition = pickerCatalog;
    if (target === null || !definition) return;
    const existing = palette.find((entry) => entry.active && entry.id !== target && entry.catalog?.catalogId === definition.association.catalogId && entry.catalog.sourceId === color.sourceId);
    try {
      if (existing) workspace.execute({ type: "palette-merge", from: target, to: existing.id });
      else workspace.execute({ type: "palette-merge", from: target, createTo: { name: color.name, color: color.hex, catalog: createCatalogReference(definition, color) } });
      const current = workspace.getStateSnapshot().document;
      const replacement = existing?.id ?? current?.palette.find((entry) => entry.active && entry.id !== target && entry.catalog?.catalogId === definition.association.catalogId && entry.catalog.sourceId === color.sourceId)?.id ?? null;
      finishSwap(replacement);
    } catch (error) {
      setPaletteNotice(error instanceof Error ? error.message : "This color could not be swapped.");
    }
  };
  const swapIntoCustomColor = () => {
    const target = swapTarget;
    if (target === null || !customColor) return;
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
  const addCustomColor = async (): Promise<void> => {
    if (!customColor) return;
    if (customPaletteMatch) {
      controllerRef.current?.selectPalette(customPaletteMatch.id);
      finishAdd(customPaletteMatch.id);
      return;
    }
    if (customCatalogColor && pickerCatalog) {
      await addPaletteColor(customCatalogColor);
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
      if (added) controllerRef.current?.selectCreatedPalette(added.id);
      finishAdd(added?.id ?? null);
    } catch (error) {
      setPaletteNotice(
        error instanceof Error
          ? error.message
          : "This color could not be added.",
      );
    }
  };
  const removeEntry =
    removeTarget === null
      ? null
      : (palette.find((x) => x.id === removeTarget) ?? null);
  const removalCandidates =
    removeTarget === null ? [] : palette.filter((x) => x.id !== removeTarget);
  const catalogIdsByCode = new Map<string, Set<string>>();
  for (const entry of palette) {
    if (!entry.catalog) continue;
    const catalogIds = catalogIdsByCode.get(entry.catalog.code) ?? new Set<string>();
    catalogIds.add(entry.catalog.catalogId);
    catalogIdsByCode.set(entry.catalog.code, catalogIds);
  }
  const duplicateCatalogCodes = new Set([...catalogIdsByCode].filter(([, ids]) => ids.size > 1).map(([code]) => code));
  const catalogEntryBrand = (entry: (typeof palette)[number]) => {
    return entry.catalog && duplicateCatalogCodes.has(entry.catalog.code)
      ? availableCatalogs.find((item) => item.association.catalogId === entry.catalog?.catalogId)?.association.brandLabel
      : undefined;
  };
  const catalogEntryLabel = (entry: (typeof palette)[number]) => `${catalogEntryBrand(entry) ? `${catalogEntryBrand(entry)} ` : ""}${entry.catalog?.code ?? normalizeHexColor(entry.color) ?? entry.color}`;
  const removeResults = useMemo(
    () =>
      removeTarget !== null && removeQuery.trim()
        ? (replacementCatalog?.search(removeQuery, { limit: 8 }) ?? [])
        : [],
    [removeQuery, removeTarget, replacementCatalog],
  );
  const openRemove = (id: number, trigger: HTMLButtonElement) => {
    removeTrigger.current = trigger;
    setRemoveTarget(id);
    setRemoveQuery("");
    setRemoveCatalogId(defaultCatalogId);
    setRemoveNotice("");
    setRemoveOpen(true);
  };
  const positionPaletteMenu = (anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    setPaletteMenuPosition({ left: Math.max(8, Math.min(rect.right + 6, window.innerWidth - 188)), top: Math.max(8, Math.min(rect.top, window.innerHeight - 158)) });
  };
  const openPaletteMenu = (id: number, anchor: HTMLElement) => {
    window.clearTimeout(palettePress.current ?? undefined);
    palettePress.current = null;
    menuAnchor.current = anchor;
    positionPaletteMenu(anchor);
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
  const paletteRow = (x: (typeof palette)[number]) => (
    <div
      className={`palette-row${ui?.paletteId === x.id ? " palette-row-selected" : ""}`}
      key={x.id}
      title={x.name}
    >
      <button
        className="palette-button"
        type="button"
        aria-label={`${x.catalog?.code ? `${duplicateCatalogCodes.has(x.catalog.code) ? `${availableCatalogs.find((item) => item.association.catalogId === x.catalog?.catalogId)?.association.brandLabel ?? ""} ` : ""}${x.catalog.code}` : ""}${x.name}`}
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
            controllerRef.current?.selectPalette(x.id);
            // This callback is the existing-color selection path. The mobile
            // panel is the only place mobilePanel can be open, so this is a
            // no-op for the desktop rail and does not affect add/manage actions.
            setMobilePanel(null);
          }
          paletteLongPressed.current = false;
        }}
      >
        <span className="palette-swatch" style={{ backgroundColor: x.color }} aria-hidden="true">
          {paletteOptions.symbols && <span className="palette-swatch-symbol" style={{ color: contrastSymbolInk(x.color, DEFAULT_RENDERER_STYLE.symbolColor) }}><SymbolTile id={x.symbol} /></span>}
          {paletteOptions.numbers && (
            <span className={`palette-number${x.catalog ? "" : " palette-number-hex"}`}>
              {catalogEntryBrand(x) ? <><span className="palette-brand-label">{catalogEntryBrand(x)}</span><span className="palette-code-label">{x.catalog?.code}</span></> : catalogEntryLabel(x)}
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
        title="Remove or replace this color"
        onClick={(e) => openRemove(x.id, e.currentTarget)}
      >
        ×
      </button>
      {paletteMenu === x.id && createPortal(
        <div ref={menuElement} className="palette-menu" role="menu" aria-label={`Details for ${x.name}`} style={{ position: 'fixed', left: paletteMenuPosition.left, top: paletteMenuPosition.top, zIndex: 1000 }} onPointerDown={(event) => event.stopPropagation()}>
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
  const closeRemove = () => {
    setRemoveOpen(false);
    setRemoveTarget(null);
    window.setTimeout(() => removeTrigger.current?.focus(), 0);
  };
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
    window.setTimeout(() => symbolTrigger.current?.focus(), 0);
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
  const removeIntoExisting = (toId: number) => {
    const target = removeTarget;
    if (target === null) return;
    try {
      workspace.execute({ type: "palette-merge", from: target, to: toId });
      controllerRef.current?.selectPalette(toId);
      closeRemove();
    } catch (error) {
      setRemoveNotice(
        error instanceof Error
          ? error.message
          : "This color could not be removed.",
      );
    }
  };
  const removeIntoNew = (color: CatalogColor) => {
    const target = removeTarget;
    if (target === null) return;
    try {
      workspace.execute({
        type: "palette-merge",
        from: target,
        createTo: {
          name: color.name,
          color: color.hex,
           catalog: createCatalogReference(replacementCatalog!, color),
        },
      });
      const added = workspace
        .getStateSnapshot()
        .document?.palette.find(
          (x) => x.active && x.catalog?.catalogId === replacementCatalog?.association.catalogId && x.catalog?.sourceId === color.sourceId && x.id !== target,
        );
      controllerRef.current?.selectPalette(added?.id ?? null);
      closeRemove();
    } catch (error) {
      setRemoveNotice(
        error instanceof Error
          ? error.message
          : "This color could not be removed.",
      );
    }
  };
  const command = (key: string, ctrlKey = false) => {
    controllerRef.current?.handleKeyDown?.({
      key,
      ctrlKey,
      preventDefault: () => undefined,
    });
  };

  useEffect(() => {
    if (!open) return;
    const el = dialog.current;
    if (!el) return;
    const root =
      globalThis.document.querySelector<HTMLElement>("[data-application]");
    const wasInert = root?.inert ?? false;
    if (root) root.inert = true;
    const all = () => [
      ...el.querySelectorAll<HTMLElement>("button,input,textarea,select"),
    ].filter((item) => !item.closest("[hidden]"));
    all()[0]?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
      if (e.key === "Tab") {
        const f = all(),
          first = f[0],
          last = f.at(-1);
        if (e.shiftKey && globalThis.document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && globalThis.document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    el.addEventListener("keydown", key);
    return () => {
      el.removeEventListener("keydown", key);
      if (root) root.inert = wasInert;
    };
  }, [open]);
  useEffect(() => {
    if (!paletteOpen) return;
    const el = paletteDialog.current;
    if (!el) return;
    const root =
      globalThis.document.querySelector<HTMLElement>("[data-application]");
    const wasInert = root?.inert ?? false;
    if (root) root.inert = true;
    const search = el.querySelector<HTMLInputElement>("#catalog-search");
    if (search && !search.disabled) search.focus();
    else (el.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]') ?? el.querySelector<HTMLButtonElement>(".modal-close"))?.focus();
    const all = () =>
      [...el.querySelectorAll<HTMLElement>("button,input,select")].filter(
        (item) => !item.hasAttribute("disabled") && item.tabIndex >= 0,
      );
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closePalettePicker();
        return;
      }
      if (e.key !== "Tab") return;
      const f = all(),
        first = f[0],
        last = f.at(-1);
      if (e.shiftKey && globalThis.document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && globalThis.document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    el.addEventListener("keydown", key);
    return () => {
      el.removeEventListener("keydown", key);
      if (root) root.inert = wasInert;
    };
  }, [paletteOpen]);
  useEffect(() => {
    if (!managerOpen) return;
    const el = managerDialog.current;
    if (!el) return;
    const root =
      globalThis.document.querySelector<HTMLElement>("[data-application]");
    const wasInert = root?.inert ?? false;
    if (root) root.inert = true;
    (el.querySelector<HTMLButtonElement>('.palette-manager-grid [aria-pressed="true"]') ?? managerClose.current)?.focus();
    // Re-queried on every Tab: the swap panel adds and removes controls.
    const all = () =>
      [...el.querySelectorAll<HTMLElement>("button,input,select")].filter(
        (item) => !item.hasAttribute("disabled") && item.tabIndex >= 0,
      );
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        // The panel's presence is read from the DOM because this listener
        // outlives the render that opened the panel.
        if (el.querySelector("#palette-manager-panel")) closeManagerPanel(el.querySelector('.palette-manager-add[aria-expanded="true"]') ? managerAddButton.current : managerSwapButton.current);
        else closePaletteManager();
        return;
      }
      if (e.key !== "Tab") return;
      const f = all(),
        first = f[0],
        last = f.at(-1);
      if (e.shiftKey && globalThis.document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && globalThis.document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    el.addEventListener("keydown", key);
    return () => {
      el.removeEventListener("keydown", key);
      if (root) root.inert = wasInert;
    };
  }, [managerOpen]);
  useEffect(() => {
    if (!removeOpen) return;
    const el = removeDialog.current;
    if (!el) return;
    const root =
      globalThis.document.querySelector<HTMLElement>("[data-application]");
    const wasInert = root?.inert ?? false;
    if (root) root.inert = true;
    const search = el.querySelector<HTMLInputElement>("#remove-search");
    if (search && !search.disabled) search.focus();
    else (el.querySelector<HTMLSelectElement>("#remove-catalog-choice") ?? el.querySelector<HTMLButtonElement>(".modal-close"))?.focus();
    const all = () =>
      [...el.querySelectorAll<HTMLElement>("button,input,select")].filter(
        (item) => !item.hasAttribute("disabled") && item.tabIndex >= 0,
      );
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRemove();
        return;
      }
      if (e.key !== "Tab") return;
      const f = all(),
        first = f[0],
        last = f.at(-1);
      if (e.shiftKey && globalThis.document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && globalThis.document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    el.addEventListener("keydown", key);
    return () => {
      el.removeEventListener("keydown", key);
      if (root) root.inert = wasInert;
    };
  }, [removeOpen]);
  useEffect(() => {
    if (symbolTarget === null) return;
    const el = symbolDialog.current;
    if (!el) return;
    const root =
      globalThis.document.querySelector<HTMLElement>("[data-application]");
    const wasInert = root?.inert ?? false;
    if (root) root.inert = true;
    el.querySelector<HTMLInputElement>("#symbol-filter-input")?.focus();
    const all = () =>
      [...el.querySelectorAll<HTMLElement>("button,input")].filter(
        (item) => !item.hasAttribute("disabled") && item.tabIndex >= 0,
      );
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeSymbolPicker();
        return;
      }
      if (e.key !== "Tab") return;
      const f = all(),
        first = f[0],
        last = f.at(-1);
      if (e.shiftKey && globalThis.document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && globalThis.document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    el.addEventListener("keydown", key);
    return () => {
      el.removeEventListener("keydown", key);
      if (root) root.inert = wasInert;
    };
  }, [symbolTarget]);
  useEffect(() => {
    if (paletteMenu === null) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && menuElement.current?.contains(event.target)) return;
      if (event.target instanceof Element && event.target.closest(".palette-row")) return;
      setPaletteMenu(null);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setPaletteMenu(null); menuAnchor.current?.focus(); } };
    globalThis.document.addEventListener("pointerdown", close);
    globalThis.document.addEventListener("keydown", escape);
    return () => { globalThis.document.removeEventListener("pointerdown", close); globalThis.document.removeEventListener("keydown", escape); };
  }, [paletteMenu]);
  useEffect(() => {
    if (deleteTarget === null) return;
    const dialog = deleteDialog.current;
    if (!dialog) return;
    const root = globalThis.document.querySelector<HTMLElement>("[data-application]");
    const wasInert = root?.inert ?? false;
    if (root) root.inert = true;
    dialog.querySelector<HTMLButtonElement>("[data-delete-cancel]")?.focus();
    const close = () => { setDeleteTarget(null); focusAfterDelete(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      if (event.key !== "Tab") return;
      const controls = [...dialog.querySelectorAll<HTMLElement>("button,input,select,textarea,[tabindex]:not([tabindex='-1'])")]
        .filter((item) => !item.hasAttribute("disabled") && !item.closest("[hidden]") && item.tabIndex >= 0);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && globalThis.document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && globalThis.document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    dialog.addEventListener("keydown", key);
    return () => { dialog.removeEventListener("keydown", key); if (root) root.inert = wasInert; };
  }, [deleteTarget]);
  useEffect(() => {
    if (!mobilePanel) return;
    mobilePopover.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobilePanel(null);
        window.setTimeout(() => {
          (mobilePanel === "tools" ? mobileToolsTrigger : mobileColorsTrigger).current?.focus();
        }, 0);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (paletteOpen || managerOpen) return;
      const target = event.target;
       if (target instanceof Node && !mobileDock.current?.contains(target) && !(target instanceof Element && target.closest(".mobile-dock-trigger, .editor-rail-popover"))) setMobilePanel(null);
    };
    globalThis.document.addEventListener("keydown", onKeyDown);
    globalThis.document.addEventListener("pointerdown", onPointerDown);
    return () => {
      globalThis.document.removeEventListener("keydown", onKeyDown);
      globalThis.document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [mobilePanel, paletteOpen, managerOpen]);
  const runSelectionAction = (action: SelectionAction) => {
    const surface = controllerRef.current;
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
  const activeStackLayer = layeredDocument && typeof activeLayerId === "number" ? findLayer(layeredDocument, activeLayerId) : undefined;
  const activeLayerHeading = !layeredDocument || activeLayerId === "reference"
    ? "Reference image"
    : activeLayerId === "canvas"
      ? "Canvas"
      : activeStackLayer ? `${LAYER_TYPE_LABELS[activeStackLayer.type]} · ${activeStackLayer.name}` : "Layer";
  const formatMeasure = (inches: number) =>
    units === "metric"
      ? `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(inches * 2.54)} cm`
      : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(inches)} in`;
  const dimensionSummary = `${document.width} × ${document.height} stitches · ${formatMeasure(document.width / aidaCount)} × ${formatMeasure(document.height / aidaCount)}`;
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
    controllerRef.current?.setTool({ tool: "shape", shape } as never);
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
    controllerRef.current?.setTool(("shape" in choice ? { tool: choice.tool, shape: choice.shape } : { tool: choice.tool }) as never);
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
    const surface = controllerRef.current as (EditorSurfaceController & { confirmFloatingPaste?: () => boolean; cancelFloatingPaste?: () => boolean }) | null;
    if (confirm) surface?.confirmFloatingPaste?.();
    else surface?.cancelFloatingPaste?.();
    window.setTimeout(() => frame.current?.focus(), 0);
  };
  // Shared by the add/swap/background picker and the palette manager's swap
  // panel; the two are never open together, so the element ids stay unique.
  const catalogPickerBody = () => (
    <div className="catalog-box">
      <div className="catalog-selection" aria-label="Selected thread color" role="group" aria-live="polite">
      {selectedCatalogColor ? (
        <>
          <span
            className="catalog-selection-swatch swatch"
            style={{ background: selectedCatalogColor.hex }}
            aria-hidden="true"
          />
          <span className="catalog-selection-details">
            <strong>{selectedCatalogColor.name}</strong>
             <span>{pickerCatalog?.association.brandLabel} · #{selectedCatalogColor.code}</span>
          </span>
          <button
            className="small-action"
            type="button"
             aria-label={`${backgroundPicking ? "Use" : swapTarget === null ? "Add" : "Swap"} ${selectedCatalogColor.name}`}
               onClick={() => backgroundPicking ? useBackgroundColor(selectedCatalogColor.hex) : swapTarget === null ? void addPaletteColor(selectedCatalogColor) : swapIntoCatalogColor(selectedCatalogColor)}
            disabled={!pickerCatalog}
          >
             {backgroundPicking ? "Use" : swapTarget === null ? "Add" : "Swap"}
          </button>
        </>
      ) : (
        <span className="catalog-selection-empty">No color selected</span>
      )}
    </div>
    {availableCatalogs.length > 0 ? <div className="catalog-tabs-area">
      <div className="catalog-tabs" role="tablist" aria-label="Thread catalogs">
        {availableCatalogs.map((item) => <button
          key={item.association.catalogId}
          id={`editor-catalog-tab-${item.association.catalogId}`}
          className="catalog-tab"
          type="button"
          role="tab"
          aria-selected={selectedCatalogId === item.association.catalogId}
          aria-controls="editor-catalog-panel"
          tabIndex={selectedCatalogId === item.association.catalogId ? 0 : -1}
          onClick={() => setSelectedCatalogId(item.association.catalogId)}
          onKeyDown={(event) => {
            if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const index = availableCatalogs.findIndex((catalog) => catalog.association.catalogId === item.association.catalogId);
            const nextIndex = event.key === "ArrowRight" ? (index + 1) % availableCatalogs.length : event.key === "ArrowLeft" ? (index - 1 + availableCatalogs.length) % availableCatalogs.length : event.key === "Home" ? 0 : event.key === "End" ? availableCatalogs.length - 1 : index;
            if (nextIndex === index) return;
            const nextCatalog = availableCatalogs[nextIndex];
            setSelectedCatalogId(nextCatalog.association.catalogId);
            window.setTimeout(() => globalThis.document.getElementById(`editor-catalog-tab-${nextCatalog.association.catalogId}`)?.focus(), 0);
          }}
        >{item.association.brandLabel}</button>)}
      </div>
      {pickerCatalog && <div
        id="editor-catalog-panel"
        className="catalog-tabpanel"
        role="tabpanel"
        aria-labelledby={`editor-catalog-tab-${pickerCatalog.association.catalogId}`}
      >
        <label htmlFor="catalog-search">Search {pickerCatalog?.association.brandLabel ? `${pickerCatalog.association.brandLabel} catalog` : "catalog"}</label>
        <input
          id="catalog-search"
          value={paletteQuery}
          onChange={(e) => setPaletteQuery(e.target.value)}
          placeholder={`Name or ${pickerCatalog?.association.brandLabel ?? "catalog"} code`}
          disabled={!pickerCatalog}
          aria-label={`Search ${pickerCatalog?.association.brandLabel ? `${pickerCatalog.association.brandLabel} catalog` : "catalog"}`}
        />
        <div className="catalog-color-grid" role="list" aria-label="Available thread colors">
        {pickerCatalog && catalogResults.map((color) => (
         <div role="listitem" key={`${pickerCatalog.association.catalogId}:${color.sourceId}`}>
          <button
            className="catalog-color-button"
            type="button"
             aria-label={`${color.name}, color ${color.code}`}
             aria-pressed={selectedCatalogColor?.sourceId === color.sourceId}
            onClick={() => setSelectedCatalogColor(color)}
          >
            <span
              className="catalog-color-swatch"
              style={{ background: color.hex }}
              aria-hidden="true"
            />
          </button>
        </div>
      ))}
      {!catalogResults.length && (
        <p className="catalog-empty" role="status">
          No matching colors.
        </p>
      )}
        </div>
      </div>}
    </div> : <p className="catalog-unavailable" role="status">Catalog unavailable</p>}
    <section className="custom-color-section" aria-labelledby="custom-color-title">
      <h3 id="custom-color-title">Custom color</h3>
      <div className="custom-color-fields">
        <label htmlFor="custom-color-picker">Choose custom color</label>
        <input
          id="custom-color-picker"
          type="color"
           value={canonicalCustomColor}
           onChange={(e) => setColorFromHex(e.target.value)}
        />
        <label htmlFor="custom-color-hex">Hex color</label>
        <input
          id="custom-color-hex"
          type="text"
          value={customColorInput}
           onChange={(e) => setColorFromHex(e.target.value)}
          placeholder="#C72B3B"
          inputMode="text"
          autoComplete="off"
          aria-describedby="custom-color-help"
       />
      </div>
      <p id="custom-color-help" className="custom-color-help" aria-live="polite">
        {customColorInput && !customColor
          ? "Enter a 3- or 6-digit hex color."
          : "Use a three- or six-digit hex value."}
      </p>
      <button
        className="small-action custom-color-action"
        type="button"
         disabled={!customColor}
        aria-label={customActionLabel}
         onClick={() => backgroundPicking ? customColor && useBackgroundColor(customColor) : swapTarget === null ? void addCustomColor() : swapIntoCustomColor()}
      >
        {customActionLabel}
      </button>
    </section>
    </div>
  );
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
        viewBox={`${-SYMBOL_TILE_VIEW} ${-SYMBOL_TILE_VIEW} ${SYMBOL_TILE_VIEW * 2} ${SYMBOL_TILE_VIEW * 2}`}
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          {SYMBOL_POOL.map((option) => (
            <path key={option.id} id={symbolSpriteId(option.id)} d={option.d} fill="currentColor" />
          ))}
        </defs>
      </svg>
      <header className="editor-heading">
        <a
          className="editor-brand"
          href="/patterns"
          aria-label="Needlewise home"
        >
          <span className="brand-mark" aria-hidden="true">
            ✣
          </span>
          <span>Needlewise</span>
        </a>
        <div className="editor-heading-controls">
          <button
            className="icon-button"
            type="button"
            aria-label="Undo"
            title="Undo"
            onClick={() => command("z", true)}
          >
            ↶
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="Redo"
            title="Redo"
            onClick={() => command("y", true)}
          >
            ↷
          </button>
          {onExport && (
            <button
              className="icon-button editor-download"
              type="button"
              aria-label="Download Pattern"
              title="Download Pattern"
              disabled={exportDisabled}
              onClick={onExport}
            >
              <svg data-icon="download" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M12 4v10m0 0 4-4m-4 4-4-4M5 19h14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
          <button
            className="gear-button"
            type="button"
            aria-label="Open settings"
            title="Settings"
            onClick={() => { setSettingsTab("project"); setOpen(true); }}
          >
            ⚙
          </button>
          <button className="info-button" type="button" aria-label="Materials and progress" title="Materials and progress" onClick={onOpenMaterials}>i</button>
        </div>
        <div className="editor-heading-project">
          <h2 id="editor-title">{projectName}</h2>
        </div>
        <div className="editor-heading-info">
          <p className="editor-dimensions">{dimensionSummary}</p>
          <div
            className="editor-save-state"
            role="status"
            aria-label={saveMessage ?? "Local project loaded"}
            title={saveMessage ?? "Local project loaded"}
          >
            <span
              className={`save-dot ${saveStatus === "error" ? "save-dot-error" : ""}`}
              aria-hidden="true"
            />
          </div>
        </div>
      </header>
      <div className={`editor-layout rail-${railSide}`}>
        <aside ref={mobileDock} className="editor-rail-shell" aria-label="Editor controls">
          <div ref={mobilePanel === "tools" ? mobilePopover : undefined} id="mobile-tools-popover" className={`editor-rail-popover mobile-tools-popover${mobilePanel === "tools" ? " mobile-popover-open" : ""}`} role={mobilePanel === "tools" ? "dialog" : undefined} aria-label="Tools" tabIndex={-1}>
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
              onClick={() => { if (refuseUnavailable("backstitch")) return; controllerRef.current?.setBackstitchMode(lastBackstitchMode); }}
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
          </div>
          <div ref={mobilePanel === "colors" ? mobilePopover : undefined} id="mobile-colors-popover" className={`editor-rail-popover mobile-colors-popover${mobilePanel === "colors" ? " mobile-popover-open" : ""}`} role={mobilePanel === "colors" ? "dialog" : undefined} aria-label="Colors" tabIndex={-1}>
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
            </div>
            <div className="palette-rail-items">
              {palette.map(paletteRow)}
            </div>
          </div>
          {layeredDocument && (
            <LayersPanel
              document={layeredDocument}
              activeLayerId={activeLayerId}
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
          </div>
        </aside>
        <div className="canvas-column">
          <div
            ref={frame}
            className="canvas-frame"
            role="group"
            tabIndex={0}
            aria-label="Stitch chart canvas"
            aria-describedby="canvas-instructions"
          >
            {fallback ? (
              <p className="canvas-fallback">
                Canvas preview is unavailable. Refresh the page or try a browser
                with Canvas 2D support.
              </p>
            ) : (
              <>
                <canvas ref={base} aria-hidden="true" />
                <canvas ref={overlay} aria-hidden="true" />
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
              </>
            )}
          </div>
          <Toast toast={toast} onDismiss={dismissToast} />
          <div className="mobile-dock-card">
            <div className="mobile-dock-triggers" aria-label="Open editor controls">
              <button ref={mobileToolsTrigger} className="mobile-dock-trigger" type="button" aria-label="Tools" aria-expanded={mobilePanel === "tools"} aria-controls="mobile-tools-popover" onClick={() => setMobilePanel(mobilePanel === "tools" ? null : "tools")}>
                <img src={stitchIcon} alt="" aria-hidden="true" />
              </button>
              <button ref={mobileColorsTrigger} className="mobile-dock-trigger mobile-colors-trigger" type="button" aria-label={selectedPalette ? `Colors: ${selectedPalette.name}` : "Colors"} title={selectedPalette ? `Colors: ${selectedPalette.name}` : "Colors"} aria-expanded={mobilePanel === "colors"} aria-controls="mobile-colors-popover" onClick={() => setMobilePanel(mobilePanel === "colors" ? null : "colors")}>
                <span className="mobile-dock-color-swatch" style={{ backgroundColor: selectedPalette?.color ?? "#fffdf9" }} aria-hidden="true" />
              </button>
            </div>
          </div>
          <div className="canvas-actions">
            <section className="action-section reference-actions layer-actions" aria-labelledby="reference-actions-label">
              <h3 id="reference-actions-label">{activeLayerHeading}</h3>
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
                    if (controllerRef.current?.setCanvasMode(mode)) controllerRef.current.setCanvasCropActive(true);
                  }}
                  onCanvasCropToggle={() => controllerRef.current?.setCanvasCropActive(!canvasCropActive)}
                  onRename={(layerId, name) => runLayerAction(() => session?.renameLayer(layerId, name))}
                  onDuplicate={(layerId) => runLayerAction(() => session?.duplicateLayer(layerId))}
                  onMerge={(sourceId, targetId) => runLayerAction(() => session?.mergeLayer(sourceId, targetId))}
                  onDelete={(layerId) => runLayerAction(() => session?.deleteLayer(layerId))}
                />
              )}
              {/* Always mounted: it owns decoding the reference image for the canvas. */}
              <div className="reference-layer-controls" hidden={Boolean(layeredDocument) && activeLayerId !== "reference"}>
                <TraceImageControls workspace={workspace} document={document} controller={controller} activeTool={ui?.tool.tool} filePickerRef={traceFilePicker} />
              </div>
            </section>
            {toolOptionsHeading && (
              <section className="action-section tool-options" aria-labelledby="tool-options-label">
                <h3 id="tool-options-label">{toolOptionsHeading}</h3>
                {sizeOption ? (
                  <>
                    {activeStitchKind && (
                      <div role="group" aria-label="Stitch type">
                        {STITCH_CHOICES.map(([kind, name]) => (
                          <button key={kind} className="tool-option-button" type="button" aria-label={name} title={name} aria-pressed={activeStitchKind === kind} onClick={() => choose(kind)}>
                            <span className={`stitch-brush-icon stitch-brush-icon-${kind}${kind === "half" && preferences.halfStitchDirection === "\\" ? " stitch-brush-icon-half-backslash" : ""}`} aria-hidden="true" />
                          </button>
                        ))}
                      </div>
                    )}
                    {sizeOption.tool === "half" && (
                      <div role="group" aria-label="Half stitch direction">
                        {([["/", "Bottom-left to top-right"], ["\\", "Top-left to bottom-right"]] as const).map(([direction, name]) => (
                          <button key={direction} className="tool-option-button" type="button" aria-label={name} title={name} aria-pressed={preferences.halfStitchDirection === direction} onClick={() => chooseHalfDirection(direction)}>
                            <span className={`stitch-brush-icon stitch-brush-icon-half${direction === "\\" ? " stitch-brush-icon-half-backslash" : ""}`} aria-hidden="true" />
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="tool-options-size">
                      <label htmlFor="tool-brush-size">Size <output>{ui?.toolBrushSizes[sizeOption.tool] ?? 1}</output></label>
                      <RangeInput id="tool-brush-size" min="1" max="10" aria-label={brushSizeHeading(sizeOption.label)} value={ui?.toolBrushSizes[sizeOption.tool] ?? 1} onChange={(event) => controllerRef.current?.setToolBrushSize(sizeOption.tool, Number(event.target.value))} />
                    </div>
                  </>
                ) : backstitchActive ? (
                  <div role="group" aria-label="Backstitch mode">
                    {(["draw", "move"] as const).map((mode) => (
                      <button key={mode} className="tool-option-button" type="button" aria-pressed={activeBackstitchMode === mode} onClick={() => { controllerRef.current?.setBackstitchMode(mode); setLastBackstitchMode(mode); }}>
                        {mode === "draw" ? "Draw" : "Move"}
                      </button>
                    ))}
                  </div>
                ) : ui?.tool.tool === "shape" ? (
                  <div role="group" aria-label="Shape">
                    {SHAPE_CHOICES.map((shape) => {
                      const kind = shape as string;
                      const label = kind === "right-triangle" ? "Right triangle" : kind[0]!.toUpperCase() + kind.slice(1);
                      return <button key={kind} className="tool-option-button" type="button" aria-label={label} title={label} aria-pressed={selectedShape === shape} onClick={() => { setSelectedShape(shape); applyShapeTool(shape); }}>{shapeIcon(shape)}</button>;
                    })}
                  </div>
                ) : activeSelectChoice && (
                  <>
                    <div role="group" aria-label="Selection shape">
                      {SELECT_CHOICES.map((choice) => (
                        <button key={choice.label} className="tool-option-button" type="button" aria-label={choice.label} title={choice.label} aria-pressed={activeSelectChoice === choice} onClick={() => applySelectChoice(choice)}>
                          <img data-icon={choice.dataIcon} src={choice.icon} alt="" aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                    <div role="group" aria-label="Selection actions">
                      {(toolLayer?.kind === "canvas"
                        ? ([["add-cells", "Add", "Add selected cells to the canvas", !ui?.overlay.canvasEditing?.selection], ["delete-cells", "Delete", "Delete selected cells from the canvas", !ui?.overlay.canvasEditing?.selection]] as const)
                        : ([["copy", "Copy", "Copy selection", !ui?.overlay.selection], ["paste", "Paste", "Paste selection", !ui?.canPaste], ["move", "Move", "Move selection", !ui?.overlay.selection], ["delete", "Delete", "Delete selection", !ui?.overlay.selection]] as const)
                      ).map(([action, text, label, disabled]) => (
                        <button key={action} className="tool-option-button" type="button" aria-label={label} title={label} disabled={disabled} onClick={() => runSelectionAction(action)}>{text}</button>
                      ))}
                    </div>
                  </>
                )}
              </section>
            )}
            <section className="action-section view-actions" aria-labelledby="view-actions-label">
            <h3 id="view-actions-label">View settings</h3>
            <div className="chart-view" role="group" aria-label="View settings">
              {modes.map(([v, l]) => (
                <button type="button" key={v} title={l} aria-label={l} aria-pressed={ui?.mode === v} onClick={() => controllerRef.current?.setChartMode(v)}>
                  <span aria-hidden="true">{v === ChartPresentationMode.Color ? "◈" : v === ChartPresentationMode.Symbol ? "✣" : v === ChartPresentationMode.Grayscale ? "▧" : "◈✣"}</span><small>{l}</small>
                </button>
              ))}
            </div>
            </section>
            <section className="action-section canvas-actions-group" aria-labelledby="canvas-actions-label">
            <h3 id="canvas-actions-label">Canvas controls</h3>
            <button className="bottom-control"
              type="button"
              onClick={() => command("+")}
              aria-label="Zoom in"
              title="Zoom in"
            >
              <span aria-hidden="true">+</span><small>In</small>
            </button>
            <button className="bottom-control"
              type="button"
              onClick={() => command("-")}
              aria-label="Zoom out"
              title="Zoom out"
            >
              <span aria-hidden="true">−</span><small>Out</small>
            </button>
            <button className="bottom-control"
              type="button"
              onClick={() => command("0")}
              aria-label="Fit"
              title="Fit canvas"
            >
              <span aria-hidden="true">⌖</span><small>Fit</small>
            </button>
            </section>
          </div>
        </div>
      </div>
      {open &&
        createPortal(
          <div
            className="modal-backdrop"
            role="presentation"
            onClick={(e) => {
              if (e.target === e.currentTarget) setOpen(false);
            }}
          >
            <div
              ref={dialog}
              className="create-modal details-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="settings-heading"
            >
              <button
                className="modal-close"
                type="button"
                aria-label="Close settings"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
              <h2 id="settings-heading">Settings</h2>
              <form onSubmit={save}>
                <div className="settings-tabs" role="tablist" aria-label="Settings sections">
                  {([['project', 'Project'], ['editor', 'Editor']] as const).map(([key, label]) => <button
                    key={key}
                    id={`settings-tab-${key}`}
                    className="settings-tab"
                    type="button"
                    role="tab"
                    aria-selected={settingsTab === key}
                    aria-controls={`settings-panel-${key}`}
                    tabIndex={settingsTab === key ? 0 : -1}
                    onClick={() => setSettingsTab(key)}
                    onKeyDown={(event) => {
                      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                      event.preventDefault();
                      const keys = ['project', 'editor'] as const;
                      const current = keys.indexOf(key);
                      const target = event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length;
                      const next = keys[target];
                      setSettingsTab(next);
                      window.setTimeout(() => globalThis.document.getElementById(`settings-tab-${next}`)?.focus(), 0);
                    }}
                  >{label}</button>)}
                </div>
                <div id="settings-panel-project" className="settings-tabpanel" role="tabpanel" aria-labelledby="settings-tab-project" hidden={settingsTab !== 'project'}>
                <section
                  className="settings-section"
                  aria-labelledby="project-settings-heading"
                >
                  <h3 id="project-settings-heading">Project</h3>
                  <label htmlFor="details-title-input">
                    Title
                    <input
                      id="details-title-input"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                    />
                  </label>
                  <label htmlFor="details-notes">
                    Notes
                    <textarea
                      id="details-notes"
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                    />
                  </label>
                  <div
                    className="trace-mode-row"
                    role="group"
                    aria-label="Measurement units"
                  >
                    <button
                      type="button"
                      className="trace-mode-button"
                      aria-pressed={units === "metric"}
                      onClick={() => applyUnits("metric")}
                    >
                      Metric
                    </button>
                    <button
                      type="button"
                      className="trace-mode-button"
                      aria-pressed={units === "imperial"}
                      onClick={() => applyUnits("imperial")}
                    >
                      Imperial
                    </button>
                  </div>
                </section>
                </div>
                <div id="settings-panel-editor" className="settings-tabpanel" role="tabpanel" aria-labelledby="settings-tab-editor" hidden={settingsTab !== 'editor'}>
                <section
                  className="settings-section"
                  aria-labelledby="editor-settings-heading"
                >
                  <h3 id="editor-settings-heading">Editor</h3>
                  <div
                    className="trace-mode-row"
                    role="group"
                    aria-label="Control placement"
                  >
                    <button
                      type="button"
                      className="trace-mode-button"
                      aria-pressed={railSide === "left"}
                      onClick={() =>
                        setPreferences((current) => ({
                          ...current,
                          railSide: "left",
                        }))
                      }
                    >
                      Left
                    </button>
                    <button
                      type="button"
                      className="trace-mode-button"
                      aria-pressed={railSide === "right"}
                      onClick={() =>
                        setPreferences((current) => ({
                          ...current,
                          railSide: "right",
                        }))
                      }
                    >
                      Right
                    </button>
                  </div>
                  <label className="check-row palette-display-toggle">
                    Show palette symbols
                    <input
                      type="checkbox"
                      checked={paletteOptions.symbols}
                      onChange={(event) =>
                        setPreferences((current) => ({
                          ...current,
                          paletteDisplay: {
                            ...current.paletteDisplay,
                            symbols: event.target.checked,
                          },
                        }))
                      }
                    />
                  </label>
                  <label className="check-row palette-display-toggle">
                    Show palette numbers
                    <input
                      type="checkbox"
                      checked={paletteOptions.numbers}
                      onChange={(event) =>
                        setPreferences((current) => ({
                          ...current,
                          paletteDisplay: {
                            ...current.paletteDisplay,
                            numbers: event.target.checked,
                          },
                        }))
                      }
                    />
                  </label>
                  <label className="check-row palette-display-toggle" htmlFor="enable-pencil-mode">
                    <span className="pencil-mode-label">
                      Enable pencil mode
                      <span className="settings-info-wrap">
                        <button
                          className="settings-info-button"
                          type="button"
                          aria-label="Pencil mode information"
                          aria-describedby="pencil-mode-tooltip"
                        >
                          i
                        </button>
                        <span
                          id="pencil-mode-tooltip"
                          className="settings-info-tooltip"
                          role="tooltip"
                        >
                          In pencil mode, only a pencil or stylus can make changes to the pattern. Normal touch can only move or zoom.
                        </span>
                      </span>
                    </span>
                    <input
                      id="enable-pencil-mode"
                      type="checkbox"
                      aria-label="Enable pencil mode"
                      checked={pencilModeEnabled}
                      onChange={(event) =>
                        setPreferences((current) => ({
                          ...current,
                          pencilModeEnabled: event.target.checked,
                        }))
                      }
                    />
                  </label>
                </section>
                </div>
                <button className="button button-primary" type="submit">
                  Save settings
                </button>
              </form>
            </div>
          </div>,
          globalThis.document.body,
        )}{" "}
      {paletteOpen &&
        createPortal(
          <div
            className="modal-backdrop"
            role="presentation"
            onClick={(e) => {
              if (e.target === e.currentTarget) closePalettePicker();
            }}
          >
            <div
              ref={paletteDialog}
              className="catalog-dialog create-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="editor-catalog-title"
            >
              <button
                className="modal-close"
                type="button"
                aria-label="Close catalog dialog"
                onClick={closePalettePicker}
              >
                ×
              </button>
                 <p className="section-label">{pickerCatalog?.association.brandLabel ?? "Catalog"}</p>
                <h2 id="editor-catalog-title">{backgroundPicking ? "Choose a background color" : swapTarget === null ? "Add a thread color" : `Swap ${palette.find((entry) => entry.id === swapTarget)?.name ?? "color"} for a thread color`}</h2>
                {swapTarget !== null && <p className="modal-hint">Stitches and backstitches using {palette.find((entry) => entry.id === swapTarget)?.name ?? "this color"} will be changed.</p>}
                {catalogPickerBody()}
              {paletteNotice && (
                <p className="modal-error" role="alert">
                  {paletteNotice}
                </p>
              )}
            </div>
          </div>,
          globalThis.document.body,
        )}{" "}
      {removeOpen &&
        removeEntry &&
        createPortal(
          <div
            className="modal-backdrop"
            role="presentation"
            onClick={(e) => {
              if (e.target === e.currentTarget) closeRemove();
            }}
          >
            <div
              ref={removeDialog}
              className="catalog-dialog create-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="editor-remove-title"
            >
              <button
                className="modal-close"
                type="button"
                aria-label="Close remove dialog"
                onClick={closeRemove}
              >
                ×
              </button>
              <p className="section-label">Palette</p>
              <h2 id="editor-remove-title">Remove {removeEntry.name}</h2>
              <p className="modal-hint">
                Choose a replacement color. Every stitch and backstitch in{" "}
                {removeEntry.name} is recolored, then the color is deactivated;
                history and estimates are preserved.
              </p>
              <div className="catalog-box">
                <h3>Use another palette color</h3>
                <ul className="catalog-results">
                  {removalCandidates.map((x) => (
                    <li key={x.id}>
                      <span
                        className="swatch"
                        style={{ background: x.color }}
                      />
                      <span>
                        {x.name}
                        {x.catalog ? <small> {catalogEntryLabel(x)}</small> : null}
                      </span>
                      <button
                        className="small-action"
                        type="button"
                        aria-label={`Replace with ${x.name}`}
                        onClick={() => removeIntoExisting(x.id)}
                      >
                        Replace
                      </button>
                    </li>
                  ))}
                </ul>
                {removalCandidates.length === 0 && (
                  <p className="control-note">
                    No other active palette colors yet. Add one, or search the
                    {replacementCatalog ? ` ${replacementCatalog.association.brandLabel} catalog` : " catalog"} below.
                  </p>
                )}
              </div>
              <div className="catalog-box">
                {availableCatalogs.length > 1 && <label className="catalog-choice-label" htmlFor="remove-catalog-choice">Catalog<select id="remove-catalog-choice" value={removeCatalogId} onChange={(event) => { setRemoveCatalogId(event.target.value); setRemoveQuery(""); }}><option value="" disabled>Select catalog</option>{availableCatalogs.map((item) => <option key={item.association.catalogId} value={item.association.catalogId}>{item.association.brandLabel}</option>)}</select></label>}
                <label htmlFor="remove-search">
                   Search {replacementCatalog?.association.brandLabel ? `${replacementCatalog.association.brandLabel} catalog` : "catalog"} for a replacement
                </label>
               <input
                 id="remove-search"
                  value={removeQuery}
                  onChange={(e) => setRemoveQuery(e.target.value)}
                   placeholder={`Name or ${replacementCatalog?.association.brandLabel ?? "catalog"} code`}
                  disabled={!replacementCatalog}
                />
                 {!replacementCatalog && <p className="catalog-unavailable" role="status">Catalog unavailable</p>}
                <ul className="catalog-results">
                  {removeResults.map((color) => (
                    <li key={`${replacementCatalog?.association.catalogId}:${color.sourceId}`}>
                      <span
                        className="swatch"
                        style={{ background: color.hex }}
                      />
                      <span>
                         {color.name} <small>{replacementCatalog?.association.brandLabel} #{color.code}</small>
                      </span>
                       <button
                         className="small-action"
                        type="button"
                          aria-label={`Replace with ${color.name} from ${replacementCatalog?.association.brandLabel ?? "the catalog"}`}
                          disabled={!replacementCatalog}
                        onClick={() => removeIntoNew(color)}
                      >
                        Replace
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              {removeNotice && (
                <p className="modal-error" role="alert">
                  {removeNotice}
                </p>
              )}
            </div>
          </div>,
          globalThis.document.body,
        )}{" "}
      {managerOpen &&
        createPortal(
          <div
            className="modal-backdrop"
            role="presentation"
            onClick={(e) => {
              if (e.target === e.currentTarget) closePaletteManager();
            }}
          >
            <div
              ref={managerDialog}
              className={`catalog-dialog create-modal palette-manager-dialog${managerPanel ? " palette-manager-panel-open" : ""}`}
              role="dialog"
              aria-modal="true"
              aria-labelledby="palette-manager-title"
            >
              <button
                ref={managerClose}
                className="modal-close"
                type="button"
                aria-label="Close palette manager"
                onClick={closePaletteManager}
              >
                ×
              </button>
              <div className="palette-manager-columns">
                <section className="palette-manager-palette">
                  <p className="section-label">Manage</p>
                  <h2 id="palette-manager-title">Color palette</h2>
                  <div className="catalog-box">
                    <div className="catalog-selection" aria-label="Selected palette color" role="group">
                      {managerEntry ? (
                        <>
                          <span className="catalog-selection-swatch swatch" style={{ background: managerEntry.color }} aria-hidden="true" />
                          <span className="catalog-selection-details">
                            <strong>{managerEntry.name}</strong>
                            <span>{catalogEntryLabel(managerEntry)}</span>
                          </span>
                          <div className="palette-manager-actions">
                            <button ref={managerSwapButton} className="small-action" type="button" aria-label={`Swap ${managerEntry.name}`} aria-expanded={managerPanel === "swap"} aria-controls="palette-manager-panel" onClick={toggleManagerSwap}>Swap</button>
                            <button className="small-action palette-manager-delete" type="button" aria-label={`Delete ${managerEntry.name}`} onClick={(e) => deleteFromManager(managerEntry.id, e.currentTarget)}>Delete</button>
                          </div>
                        </>
                      ) : (
                        <span className="catalog-selection-empty">No colors in this palette yet.</span>
                      )}
                    </div>
                    <div className="catalog-color-grid palette-manager-grid" role="list" aria-label="Palette colors">
                      <div role="listitem">
                        <button ref={managerAddButton} className="catalog-color-button palette-manager-add" type="button" aria-label="Add color" title="Add color" aria-expanded={managerPanel === "add"} aria-controls="palette-manager-panel" onClick={toggleManagerAdd}><span className="palette-manager-add-glyph" aria-hidden="true">+</span></button>
                      </div>
                      {palette.map((entry) => (
                        <div role="listitem" key={entry.id}>
                          <button
                            className="catalog-color-button"
                            type="button"
                            aria-label={`${entry.name}, ${catalogEntryLabel(entry)}`}
                            aria-pressed={managerEntry?.id === entry.id}
                            onClick={() => selectManagerEntry(entry.id)}
                          >
                            <span className="catalog-color-swatch" style={{ background: entry.color }} aria-hidden="true">
                              {paletteOptions.symbols && <span className="palette-swatch-symbol" style={{ color: contrastSymbolInk(entry.color, DEFAULT_RENDERER_STYLE.symbolColor) }}><SymbolTile id={entry.symbol} /></span>}
                            </span>
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </section>
                {(managerPanel === "add" || (managerPanel === "swap" && managerEntry)) && (
                  <section id="palette-manager-panel" className="palette-manager-panel" aria-labelledby="palette-manager-panel-title">
                    <h3 id="palette-manager-panel-title">{managerPanel === "swap" && managerEntry ? `Swap ${managerEntry.name} for a thread color` : "Add a thread color"}</h3>
                    {managerPanel === "swap" && managerEntry && <p className="modal-hint">Stitches and backstitches using {managerEntry.name} will be changed.</p>}
                    {catalogPickerBody()}
                    {paletteNotice && (
                      <p className="modal-error" role="alert">
                        {paletteNotice}
                      </p>
                    )}
                  </section>
                )}
              </div>
            </div>
          </div>,
          globalThis.document.body,
        )}{" "}
      {deleteTarget !== null && createPortal(
        <div className="modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) { setDeleteTarget(null); focusAfterDelete(); } }}>
          <div ref={deleteDialog} className="catalog-dialog create-modal palette-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="palette-delete-title">
            <p className="section-label">Palette</p>
            <h2 id="palette-delete-title">Delete {palette.find((entry) => entry.id === deleteTarget)?.name ?? 'color'}?</h2>
            <p className="modal-hint">Every stitch using this color, including backstitches, will be deleted.</p>
            <div className="actions">
              <button className="button button-secondary" data-delete-cancel type="button" onClick={() => { setDeleteTarget(null); focusAfterDelete(); }}>Cancel</button>
              <button className="button button-primary" type="button" onClick={() => { const id = deleteTarget; if (id === null) return; workspace.execute({ type: 'palette-delete', id } as never); if (ui?.paletteId === id) controllerRef.current?.selectPalette(null); setDeleteTarget(null); focusAfterDelete(); }}>Delete color</button>
            </div>
          </div>
        </div>, globalThis.document.body
      )}{" "}
      {symbolTarget !== null &&
        symbolEntry &&
        createPortal(
          <div
            className="modal-backdrop"
            role="presentation"
            onClick={(e) => {
              if (e.target === e.currentTarget) closeSymbolPicker();
            }}
          >
            <div
              ref={symbolDialog}
              className="catalog-dialog create-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="symbol-picker-title"
            >
              <button
                className="modal-close"
                type="button"
                aria-label="Close symbol picker"
                onClick={closeSymbolPicker}
              >
                ×
              </button>
              <p className="section-label">Palette</p>
              <h2 id="symbol-picker-title">{symbolDialogTitle(symbolEntry.name, symbolEntry.symbol)}</h2>
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
              {symbolNotice && (
                <p className="modal-error" role="alert">
                  {symbolNotice}
                </p>
              )}
            </div>
          </div>,
          globalThis.document.body,
        )}
    </section>
  );
}
