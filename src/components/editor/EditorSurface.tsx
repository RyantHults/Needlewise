import { useEffect, useRef, useState } from "react";
import {
  ChartPresentationMode,
  createEditorSurfaceController,
  createUiStore,
  createWorkspaceEditorGateway,
  createPointerEventsAdapter,
  type EditorSurfaceController,
  type EditorUiState,
} from "../../editor";
import { getCanvasMetrics } from "../../editor/coordinates";
import { createCanvasTarget } from "../../rendering/context";
import { createCanvasRenderer } from "../../rendering/renderer";
import type { ProjectWorkspace } from "../../application/workspace";
import {
  isAlphanumericSymbol,
  MAX_PALETTE_SYMBOL_LENGTH,
  PALETTE_SYMBOLS,
} from "../../domain";
import type { DisplayUnits } from "../../domain";
import { TraceImageControls } from "./TraceImageControls";
import { searchDmcColors } from "../../catalog";
import { useMemo } from "react";
import { createPortal } from "react-dom";
import backstitchIcon from "../../assets/editor-tools/backstitch.svg";
import eraserIcon from "../../assets/editor-tools/eraser.svg";
import fillIcon from "../../assets/editor-tools/paint-bucket.svg";
import selectIcon from "../../assets/editor-tools/select.svg";
import lassoIcon from "../../assets/editor-tools/lasso.svg";
import eyedropperIcon from "../../assets/editor-tools/eyedropper.svg";
import panIcon from "../../assets/editor-tools/pan.svg";
import clearSelectIcon from "../../assets/editor-tools/clear-select.svg";
import stitchIcon from "../../assets/editor-tools/stitch.svg";
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
type CatalogColor = ReturnType<typeof searchDmcColors>[number];
const modes = [
  [ChartPresentationMode.Color, "Color"],
  [ChartPresentationMode.Symbol, "Symbol"],
  [ChartPresentationMode.Grayscale, "B/W"],
  [ChartPresentationMode.Combined, "Both"],
] as const;
const EDITOR_PREFERENCES_KEY = "needlewise-editor-preferences:v1";
type EditorPreferences = {
  version: 1;
  railSide: "left" | "right";
  paletteDisplay: { symbols: boolean; numbers: boolean };
};

const defaultEditorPreferences = (): EditorPreferences => ({
  version: 1,
  railSide: "left",
  paletteDisplay: { symbols: true, numbers: true },
});

const isEditorPreferences = (value: unknown): value is EditorPreferences => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<EditorPreferences>;
  const paletteDisplay = candidate.paletteDisplay;
  return (
    candidate.version === 1 &&
    (candidate.railSide === "left" || candidate.railSide === "right") &&
    !!paletteDisplay &&
    typeof paletteDisplay === "object" &&
    typeof paletteDisplay.symbols === "boolean" &&
    typeof paletteDisplay.numbers === "boolean"
  );
};

const readEditorPreferences = (workspaceId: string): EditorPreferences => {
  const defaults = defaultEditorPreferences();
  try {
    const stored = globalThis.localStorage.getItem(EDITOR_PREFERENCES_KEY);
    if (stored !== null) {
      try {
        const parsed = JSON.parse(stored) as unknown;
        return isEditorPreferences(parsed) ? parsed : defaults;
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
// The symbol picker renders the palette as one continuous wall (glyphs already
// held by other palette entries are omitted, so only reachable assignments show)
// and the filter above narrows the wall on demand.
export function EditorSurface({
  workspace,
  document,
  onExport,
  exportDisabled = false,
  saveMessage,
  saveStatus,
  onOpenMaterials,
}: Props) {
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
  const [size, setSize] = useState(1);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(workspace.metadata?.title ?? "");
  const [notes, setNotes] = useState(workspace.metadata?.notes ?? "");
  const [aida, setAida] = useState(String(workspace.metadata?.aidaCount ?? 14));
  const [units, setUnits] = useState<DisplayUnits>(
    workspace.metadata?.units ?? "metric",
  );
  const [preferences, setPreferences] = useState<EditorPreferences>(() =>
    readEditorPreferences(workspace.metadata?.id ?? "default"),
  );
  const railSide = preferences.railSide;
  const paletteOptions = preferences.paletteDisplay;
  const dialog = useRef<HTMLDivElement>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [selectedCatalogColor, setSelectedCatalogColor] =
    useState<CatalogColor | null>(null);
  const [paletteNotice, setPaletteNotice] = useState("");
  const addTrigger = useRef<HTMLButtonElement>(null);
  const paletteDialog = useRef<HTMLDivElement>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeQuery, setRemoveQuery] = useState("");
  const [removeNotice, setRemoveNotice] = useState("");
  const [removeTarget, setRemoveTarget] = useState<number | null>(null);
  const removeDialog = useRef<HTMLDivElement>(null);
  const removeTrigger = useRef<HTMLButtonElement>(null);
  const [symbolTarget, setSymbolTarget] = useState<number | null>(null);
  const [symbolNotice, setSymbolNotice] = useState("");
  const [symbolQuery, setSymbolQuery] = useState("");
  const [symbolFilter, setSymbolFilter] = useState("");
  const symbolDialog = useRef<HTMLDivElement>(null);
  const symbolTrigger = useRef<HTMLButtonElement | null>(null);
  const [paletteMenu, setPaletteMenu] = useState<number | null>(null);
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
              tool: {
                tool: "paint",
                brush: { kind: "full", paletteId: first.id },
              },
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
          void workspace
            .applyTraceImageChange(
              { ...current, chartBounds: sanitized },
              { label: "trace-image-bounds" },
            )
            .catch(() => undefined);
        },
      });
      controllerRef.current = c;
      setController(c);
      setUi(store.getState());
      const unsub = store.subscribe(setUi);
      const adapter = createPointerEventsAdapter(el, c, { keyboardSurface: root });
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
    controllerRef.current?.setDocument(document, {
      layer: "all",
      full: true,
      reason: "external-document",
    });
  }, [document, controller]);
  useEffect(() => {
    setTitle(workspace.metadata?.title ?? "");
    setNotes(workspace.metadata?.notes ?? "");
    setAida(String(workspace.metadata?.aidaCount ?? 14));
    setUnits(workspace.metadata?.units ?? "metric");
  }, [
    workspace,
    workspace.metadata?.id,
    workspace.metadata?.title,
    workspace.metadata?.notes,
    workspace.metadata?.aidaCount,
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
  const selectedPalette = palette.find((x) => x.id === ui?.paletteId) ?? palette[0];
  const choose = (kind: "full" | "half" | "three-quarter") => {
    const id = palette[0]?.id;
    if (id)
      controllerRef.current?.setBrush({
        kind,
        paletteId: id,
      } as never);
  };
  const invoke = (tool: string) => {
    if (noThread && ["paint", "fill", "backstitch"].includes(tool)) return;
    if (tool === "eraser") controllerRef.current?.setEraserMode("whole-cell");
    else controllerRef.current?.setTool({ tool } as never);
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    await workspace.updateActiveMetadata({
      title: title.trim() || "Untitled sampler",
      notes,
      units,
    });
    await workspace.updateActiveAidaCount?.(Number(aida));
    setOpen(false);
  };
  const applyUnits = (next: DisplayUnits) => {
    setUnits(next);
    void Promise.resolve(workspace.updateActiveMetadata({ units: next })).catch(
      () => undefined,
    );
  };
  const catalogResults = useMemo(
    () => {
      const query = paletteQuery.trim().toLowerCase();
      return searchDmcColors("").filter(
        (color) =>
          !query ||
          color.code.toLowerCase().includes(query) ||
          color.name.toLowerCase().includes(query),
      );
    },
    [paletteQuery],
  );
  useEffect(() => {
    if (!paletteOpen) return;
    if (
      selectedCatalogColor &&
      catalogResults.some((color) => color.code === selectedCatalogColor.code)
    )
      return;
    setSelectedCatalogColor(catalogResults[0] ?? null);
  }, [catalogResults, paletteOpen, selectedCatalogColor]);
  const openPalettePicker = () => {
    setPaletteNotice("");
    setPaletteQuery("");
    setSelectedCatalogColor(searchDmcColors("")[0] ?? null);
    setPaletteOpen(true);
  };
  const closePalettePicker = () => {
    setPaletteOpen(false);
    window.setTimeout(() => addTrigger.current?.focus(), 0);
  };
  const addPaletteColor = async (
    color: ReturnType<typeof searchDmcColors>[number],
  ) => {
    try {
      const previousIds = new Set(document.palette.map((entry) => entry.id));
      const result = await workspace.execute({
        type: "palette-create",
        name: color.name,
        color: color.hex,
        catalog: {
          catalogId: "dmc-compatible-screen-approximation",
          sourceId: color.sourceId,
          code: color.code,
          name: color.name,
          hex: color.hex,
          rgb: color.rgb,
        },
      });
      const createdDocument = result?.document ?? workspace.getStateSnapshot().document;
      const added = createdDocument?.palette.find(
        (entry) => entry.active && entry.catalog?.code === color.code && !previousIds.has(entry.id),
      );
      if (added) controllerRef.current?.selectCreatedPalette(added.id);
      closePalettePicker();
    } catch (error) {
      setPaletteNotice(
        error instanceof Error
          ? error.message
          : "This color could not be added.",
      );
    }
  };
  const paletteActiveIds = useMemo(() => {
    const set = new Set<number>();
    for (let i = 0; i < document.colors.length; i += 1) {
      const c = document.colors[i];
      if (c) set.add(c);
    }
    const backstitchColors = (
      document.backstitches as { colors?: ArrayLike<number> } | undefined
    )?.colors;
    if (backstitchColors)
      for (let i = 0; i < backstitchColors.length; i += 1) {
        const c = backstitchColors[i];
        if (c) set.add(c);
      }
    return set;
  }, [document.colors, document.backstitches.colors]);
  const pendingEntry =
    ui?.pendingPaletteId != null && !paletteActiveIds.has(ui.pendingPaletteId)
      ? palette.find((x) => x.id === ui.pendingPaletteId)
      : undefined;
  const removeEntry =
    removeTarget === null
      ? null
      : (palette.find((x) => x.id === removeTarget) ?? null);
  const removalCandidates =
    removeTarget === null ? [] : palette.filter((x) => x.id !== removeTarget);
  const removeResults = useMemo(
    () =>
      removeTarget !== null && removeQuery.trim()
        ? searchDmcColors(removeQuery, { limit: 8 })
        : [],
    [removeQuery, removeTarget],
  );
  const openRemove = (id: number, trigger: HTMLButtonElement) => {
    removeTrigger.current = trigger;
    setRemoveTarget(id);
    setRemoveQuery("");
    setRemoveNotice("");
    setRemoveOpen(true);
  };
  const openPaletteMenu = (id: number) => {
    window.clearTimeout(palettePress.current ?? undefined);
    palettePress.current = null;
    setPaletteMenu(id);
  };
  const startPalettePress = (id: number) => {
    paletteLongPressed.current = false;
    window.clearTimeout(palettePress.current ?? undefined);
    palettePress.current = window.setTimeout(() => {
      paletteLongPressed.current = true;
      openPaletteMenu(id);
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
        className={
          ui?.pendingPaletteId === x.id && !paletteActiveIds.has(x.id)
            ? "palette-button palette-pending"
            : "palette-button"
        }
        type="button"
        aria-label={`${x.catalog?.code ? x.catalog.code : ""}${x.name}`}
        aria-pressed={ui?.paletteId === x.id}
        onPointerDown={() => startPalettePress(x.id)}
        onPointerUp={endPalettePress}
        onPointerCancel={endPalettePress}
        onContextMenu={(event) => { event.preventDefault(); openPaletteMenu(x.id); }}
        onKeyDown={(event) => {
          if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
            event.preventDefault(); openPaletteMenu(x.id);
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
          {paletteOptions.symbols && <span className="palette-swatch-symbol">{x.symbol}</span>}
          {paletteOptions.numbers && <span className="palette-number">{x.catalog?.code ?? x.id}</span>}
        </span>
      </button>
      <button
        className="palette-symbol"
        type="button"
        aria-label={`Change symbol for ${x.name}`}
        title={`Change symbol for ${x.name}`}
        onClick={(e) => openSymbolPicker(x.id, e.currentTarget)}
      >
        {x.symbol}
      </button>
      {ui?.pendingPaletteId === x.id && !paletteActiveIds.has(x.id) ? null : (
        <button
          className="palette-remove"
          type="button"
          aria-label={`Remove ${x.name}`}
          title="Remove or replace this color"
          onClick={(e) => openRemove(x.id, e.currentTarget)}
        >
          ×
        </button>
      )}
      {paletteMenu === x.id && (
        <div className="palette-menu" role="menu" aria-label={`Details for ${x.name}`}>
          <strong>{x.name}</strong>
          <span>{x.catalog?.code ?? `Color ${x.id}`}</span>
          <span>Symbol {x.symbol}</span>
          <button type="button" role="menuitem" onClick={(event) => openSymbolPicker(x.id, event.currentTarget)}>Change symbol</button>
          {!(ui?.pendingPaletteId === x.id && !paletteActiveIds.has(x.id)) && (
            <button type="button" role="menuitem" className="palette-menu-delete" onClick={(event) => { openRemove(x.id, event.currentTarget); setPaletteMenu(null); }}>Delete color</button>
          )}
        </div>
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
    setSymbolQuery("");
    setSymbolFilter("");
    setSymbolTarget(id);
    symbolTrigger.current = trigger;
  };
  const closeSymbolPicker = () => {
    setSymbolTarget(null);
    setSymbolQuery("");
    setSymbolNotice("");
    setSymbolFilter("");
    window.setTimeout(() => symbolTrigger.current?.focus(), 0);
  };
  const symbolStatus = (value: string): "empty" | "long" | "alpha" | "ok" =>
    value === ""
      ? "empty"
      : value.length > MAX_PALETTE_SYMBOL_LENGTH
        ? "long"
        : isAlphanumericSymbol(value)
          ? "alpha"
          : "ok";
  const symbolStatusMessage = (value: string): string =>
    symbolStatus(value) === "long"
      ? `That's ${String(value.length)} UTF-16 code units — palette symbols can be at most ${String(MAX_PALETTE_SYMBOL_LENGTH)}.`
      : symbolStatus(value) === "alpha"
        ? "Palette symbols must be non-alphanumeric — ASCII letters, digits, and fullwidth forms are reserved."
        : "";
  const updateSymbolQuery = (raw: string) => {
    setSymbolQuery(raw);
    setSymbolNotice(symbolStatusMessage(raw.trim()));
  };
  const commitSymbolQuery = () => {
    const target = symbolTarget;
    if (target === null) return;
    const next = symbolQuery.trim();
    const status = symbolStatus(next);
    if (status === "empty") {
      setSymbolNotice(
        "Type or paste a single non-alphanumeric character, then press Enter to assign it.",
      );
      return;
    }
    if (status !== "ok") {
      setSymbolNotice(symbolStatusMessage(next));
      return;
    }
    assignSymbol(next);
  };
  const customSymbol = symbolQuery.trim();
  const customStatus = symbolStatus(customSymbol);
  const customHolder =
    customStatus === "ok" && symbolEntry
      ? (palette.find(
          (x) => x.id !== symbolEntry.id && x.symbol === customSymbol,
        ) ?? null)
      : null;
  const customCommitLabel =
    customStatus !== "ok" || !symbolEntry
      ? null
      : customHolder
        ? `Assign ${customSymbol} to ${symbolEntry.name} (custom, swaps with ${customHolder.name})`
        : `Assign ${customSymbol} to ${symbolEntry.name} (custom)`;
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
      if (holder)
        workspace.execute({
          type: "palette-update",
          id: holder.id,
          symbol: current.symbol,
        });
      workspace.execute({ type: "palette-update", id: target, symbol });
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
  const removeIntoNew = (color: ReturnType<typeof searchDmcColors>[number]) => {
    const target = removeTarget;
    if (target === null) return;
    try {
      workspace.execute({
        type: "palette-merge",
        from: target,
        createTo: {
          name: color.name,
          color: color.hex,
          catalog: {
            catalogId: "dmc-compatible-screen-approximation",
            sourceId: color.sourceId,
            code: color.code,
            name: color.name,
            hex: color.hex,
            rgb: color.rgb,
          },
        },
      });
      const added = workspace
        .getStateSnapshot()
        .document?.palette.find(
          (x) => x.active && x.catalog?.code === color.code && x.id !== target,
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
    ];
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
    el.querySelector<HTMLInputElement>("#catalog-search")?.focus();
    const all = () =>
      [...el.querySelectorAll<HTMLElement>("button,input")].filter(
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
    if (!removeOpen) return;
    const el = removeDialog.current;
    if (!el) return;
    const root =
      globalThis.document.querySelector<HTMLElement>("[data-application]");
    const wasInert = root?.inert ?? false;
    if (root) root.inert = true;
    el.querySelector<HTMLInputElement>("#remove-search")?.focus();
    const all = () =>
      [...el.querySelectorAll<HTMLElement>("button,input")].filter(
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
    el.querySelector<HTMLInputElement>("#symbol-custom-input")?.focus();
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
      if (event.target instanceof Element && event.target.closest(".palette-row")) return;
      setPaletteMenu(null);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setPaletteMenu(null); };
    globalThis.document.addEventListener("pointerdown", close);
    globalThis.document.addEventListener("keydown", escape);
    return () => { globalThis.document.removeEventListener("pointerdown", close); globalThis.document.removeEventListener("keydown", escape); };
  }, [paletteMenu]);
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
      if (paletteOpen) return;
      const target = event.target;
      if (target instanceof Node && !mobileDock.current?.contains(target) && !(target instanceof Element && target.closest(".mobile-dock-trigger, .editor-rail-popover"))) setMobilePanel(null);
    };
    globalThis.document.addEventListener("keydown", onKeyDown);
    globalThis.document.addEventListener("pointerdown", onPointerDown);
    return () => {
      globalThis.document.removeEventListener("keydown", onKeyDown);
      globalThis.document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [mobilePanel, paletteOpen]);
  const symbolFilterQuery = symbolFilter.trim().toLowerCase();
  const symbolMatches = symbolEntry
    ? PALETTE_SYMBOLS.filter(
        (s) =>
          (s === symbolEntry.symbol ||
            !palette.some((x) => x.id !== symbolEntry.id && x.symbol === s)) &&
          (!symbolFilterQuery || s.toLowerCase().includes(symbolFilterQuery)),
      )
    : [];
  const projectName = workspace.metadata?.title ?? "Untitled pattern";
  const aidaCount = Number(workspace.metadata?.aidaCount ?? 14);
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
  return (
    <section ref={workspaceRoot} className="editor-workspace" aria-labelledby="editor-title">
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
            onClick={() => setOpen(true)}
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
            <button
              className="rail-button"
              type="button"
              aria-label="Full stitch"
              title="Full stitch"
              aria-pressed={fullStitchActive}
              onClick={() => choose("full")}
            >
              <span className="stitch-brush-icon stitch-brush-icon-full" aria-hidden="true" />
            </button>
            <button
              className="rail-button"
              type="button"
              aria-label="Half stitch"
              title="Half stitch"
              aria-pressed={halfActive}
              onClick={() => choose("half")}
            >
              <span className="stitch-brush-icon stitch-brush-icon-half" aria-hidden="true" />
            </button>
            <button
              className="rail-button"
              type="button"
              aria-label="3/4 stitch"
              title="3/4 stitch"
              aria-pressed={threeQuarterActive}
              onClick={() => choose("three-quarter")}
            >
              <span className="stitch-brush-icon stitch-brush-icon-three-quarter" aria-hidden="true" />
            </button>
            <button
              className="rail-button"
              type="button"
              disabled={noThread}
              aria-label="Backstitch"
              title="Backstitch"
              aria-pressed={backstitchActive}
              onClick={() => invoke("backstitch")}
            >
              <img data-icon="backstitch" src={backstitchIcon} alt="" aria-hidden="true" />
            </button>
            <button
              className="rail-button"
              type="button"
              aria-label="Completion"
              title="Completion"
              aria-pressed={(ui?.tool.tool as string | undefined) === "completion"}
              onClick={() => invoke("completion")}
            >
              <svg data-icon="completion" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="m5 12.5 4.2 4.2L19 7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button
              className="rail-button"
              type="button"
              aria-label="Pan"
              title="Pan"
              aria-pressed={ui?.tool.tool === "pan"}
              onClick={() => invoke("pan")}
            >
              <img data-icon="pan" src={panIcon} alt="" aria-hidden="true" />
            </button>
            <button
              className="rail-button"
              type="button"
              aria-label="Eraser"
              title="Eraser"
              aria-pressed={ui?.tool.tool === "eraser"}
              onClick={() => invoke("eraser")}
            >
              <img data-icon="eraser" src={eraserIcon} alt="" aria-hidden="true" />
            </button>
            <button
              className="rail-button"
              type="button"
              aria-label="Select"
              title="Select"
              aria-pressed={ui?.tool.tool === "select"}
              onClick={() => invoke("select")}
            >
              <img data-icon="select" src={selectIcon} alt="" aria-hidden="true" />
            </button>
            <button
              className="rail-button"
              type="button"
              aria-label="Lasso select"
              title="Lasso select"
              aria-pressed={String(ui?.tool.tool) === "lasso"}
              onClick={() => invoke("lasso")}
            >
              <img data-icon="lasso" src={lassoIcon} alt="" aria-hidden="true" />
            </button>
            <button
              className="rail-button"
              type="button"
              aria-label="Fill"
              title="Fill"
              disabled={noThread}
              aria-pressed={ui?.tool.tool === "fill"}
              onClick={() => invoke("fill")}
            >
              <img data-icon="paint-bucket" src={fillIcon} alt="" aria-hidden="true" />
            </button>
            <button
              className="rail-button"
              type="button"
              aria-label="Eyedropper"
              title="Eyedropper"
              aria-pressed={ui?.tool.tool === "eyedropper"}
              onClick={() => invoke("eyedropper")}
            >
              <img data-icon="eyedropper" src={eyedropperIcon} alt="" aria-hidden="true" />
            </button>
            <button className="rail-button" type="button" disabled={!ui?.overlay.selection} onClick={() => controllerRef.current?.deleteSelection?.()} aria-label="Delete selection" title="Delete selection"><img data-icon="clear-select" src={clearSelectIcon} alt="" aria-hidden="true" /></button>
          </nav>
          </div>
          <div ref={mobilePanel === "colors" ? mobilePopover : undefined} id="mobile-colors-popover" className={`editor-rail-popover mobile-colors-popover${mobilePanel === "colors" ? " mobile-popover-open" : ""}`} role={mobilePanel === "colors" ? "dialog" : undefined} aria-label="Colors" tabIndex={-1}>
          <div className="palette-rail" role="region" aria-label="Thread colors">
            <button
              ref={addTrigger}
              className="palette-add-rail"
              type="button"
              aria-label="Add new color"
              title="Add new color"
              onClick={openPalettePicker}
            ><span className="palette-add-glyph">+</span></button>
            <div className="palette-rail-items">
              {pendingEntry && paletteRow(pendingEntry)}
              {palette.filter((x) => x.id !== pendingEntry?.id).map(paletteRow)}
            </div>
          </div>
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
              </>
            )}
          </div>
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
            <section className="action-section brush-settings" aria-labelledby="brush-settings-label">
              <h3 id="brush-settings-label">Brush settings</h3>
              <label className="brush-size-control" htmlFor="brush-size">
                <span>Brush size <output>{size}</output></span>
                <input
                  id="brush-size"
                  type="range"
                  min="1"
                  max="10"
                  value={size}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    setSize(n);
                    controllerRef.current?.setBrushSize?.(n);
                  }}
                />
              </label>
            </section>
            <section className="action-section reference-actions" aria-labelledby="reference-actions-label">
              <h3 id="reference-actions-label">Reference image</h3>
              <TraceImageControls workspace={workspace} document={document} controller={controller} activeTool={ui?.tool.tool} />
            </section>
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
                  <label htmlFor="details-aida">
                    Aida count
                    <select
                      id="details-aida"
                      value={aida}
                      onChange={(e) => setAida(e.target.value)}
                    >
                      {[11, 14, 16, 18, 22].map((x) => (
                        <option key={x}>{x}</option>
                      ))}
                    </select>
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
                </section>
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
              <p className="section-label">Offline catalog</p>
              <h2 id="editor-catalog-title">Add a thread color</h2>
              <div className="catalog-box">
                <div className="catalog-selection" aria-live="polite">
                  {selectedCatalogColor ? (
                    <>
                      <span
                        className="catalog-selection-swatch swatch"
                        style={{ background: selectedCatalogColor.hex }}
                        aria-hidden="true"
                      />
                      <span className="catalog-selection-details">
                        <strong>{selectedCatalogColor.name}</strong>
                        <span>#{selectedCatalogColor.code}</span>
                      </span>
                      <button
                        className="small-action"
                        type="button"
                        aria-label={`Add ${selectedCatalogColor.name}`}
                        onClick={() => void addPaletteColor(selectedCatalogColor)}
                      >
                        Add
                      </button>
                    </>
                  ) : (
                    <span className="catalog-selection-empty">No color selected</span>
                  )}
                </div>
                <label htmlFor="catalog-search">Search offline catalog</label>
                <input
                  id="catalog-search"
                  value={paletteQuery}
                  onChange={(e) => setPaletteQuery(e.target.value)}
                  placeholder="Name or DMC code"
                />
                <div className="catalog-color-grid" role="list" aria-label="Available thread colors">
                  {catalogResults.map((color) => (
                    <div role="listitem" key={color.code}>
                      <button
                        className="catalog-color-button"
                        type="button"
                        aria-label={`${color.name}, color ${color.code}`}
                        aria-pressed={selectedCatalogColor?.code === color.code}
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
              </div>
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
                        {x.catalog?.code ? (
                          <small> #{x.catalog.code}</small>
                        ) : null}
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
                    offline catalog below.
                  </p>
                )}
              </div>
              <div className="catalog-box">
                <label htmlFor="remove-search">
                  Search offline catalog for a replacement
                </label>
                <input
                  id="remove-search"
                  value={removeQuery}
                  onChange={(e) => setRemoveQuery(e.target.value)}
                  placeholder="Name or DMC code"
                />
                <ul className="catalog-results">
                  {removeResults.map((color) => (
                    <li key={color.code}>
                      <span
                        className="swatch"
                        style={{ background: color.hex }}
                      />
                      <span>
                        {color.name} <small>#{color.code}</small>
                      </span>
                      <button
                        className="small-action"
                        type="button"
                        aria-label={`Replace with ${color.name} from the catalog`}
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
              <h2 id="symbol-picker-title">Symbol for {symbolEntry.name}</h2>
              <p className="modal-hint">
                Pick a symbol from the grid below, or type any non-alphanumeric
                character of your own and press Enter to assign it.
              </p>
              <div className="catalog-box">
                <label htmlFor="symbol-custom-input">Symbol character</label>
                <input
                  id="symbol-custom-input"
                  value={symbolQuery}
                  onChange={(e) => updateSymbolQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitSymbolQuery();
                    }
                  }}
                  placeholder="e.g. ⚑ or 🧶"
                  autoComplete="off"
                />
                {customCommitLabel && (
                  <button
                    className="small-action"
                    type="button"
                    style={{ marginTop: ".55rem" }}
                    aria-label={customCommitLabel}
                    onClick={commitSymbolQuery}
                  >
                    {customSymbol}
                    {customHolder ? ` swaps with ${customHolder.name}` : ""}
                  </button>
                )}
                {customHolder && (
                  <p className="modal-hint">
                    {customHolder.name} already uses {customSymbol}. Assigning
                    will swap the two symbols.
                  </p>
                )}
              </div>
              <div className="catalog-box">
                <label htmlFor="symbol-filter-input">Filter symbols</label>
                <input
                  id="symbol-filter-input"
                  value={symbolFilter}
                  onChange={(e) => setSymbolFilter(e.target.value)}
                  placeholder="Narrow by glyph or palette name"
                  autoComplete="off"
                />
              </div>
              {symbolMatches.length > 0 && (
                <div className="symbol-grid">
                  {symbolMatches.map((s) => {
                    const current = symbolEntry.symbol === s;
                    return (
                      <button
                        key={s}
                        type="button"
                        className="symbol-option"
                        aria-pressed={current}
                        aria-label={`Assign ${s} to ${symbolEntry.name}`}
                        onClick={() => assignSymbol(s)}
                      >
                        <span aria-hidden="true">{s}</span>
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
