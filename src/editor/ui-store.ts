import {
  ChartPresentationMode,
  DEFAULT_BRUSH_SIZE,
  normalizeBrushSize,
  type EditorUiState,
  type EditorUiStore,
  type EditorToolState,
  type BrushSizeTool,
  type ToolBrushSizes,
  type AuthoringStitchBrush,
  type ModelPoint,
  type OverlayState,
  type SelectedCellSemantics,
  type StitchBrush,
  type UiListener,
  type UiStatePatch,
  type Viewport
} from './contracts';

const DEFAULT_TOOL_BRUSH_SIZES: ToolBrushSizes = {
  full: DEFAULT_BRUSH_SIZE,
  half: DEFAULT_BRUSH_SIZE,
  'three-quarter': DEFAULT_BRUSH_SIZE,
  eraser: DEFAULT_BRUSH_SIZE
};

function brushSizeToolFor(tool: EditorToolState): BrushSizeTool | undefined {
  if (tool.tool === 'paint' && tool.brush && (tool.brush.kind === 'full' || tool.brush.kind === 'half' || tool.brush.kind === 'three-quarter')) {
    return tool.brush.kind;
  }
  if (tool.tool === 'eraser') return tool.tool;
  return undefined;
}

function normalizeToolBrushSizes(sizes: Partial<ToolBrushSizes>): ToolBrushSizes {
  return {
    full: normalizeBrushSize(sizes.full ?? DEFAULT_BRUSH_SIZE),
    half: normalizeBrushSize(sizes.half ?? DEFAULT_BRUSH_SIZE),
    'three-quarter': normalizeBrushSize(sizes['three-quarter'] ?? DEFAULT_BRUSH_SIZE),
    eraser: normalizeBrushSize(sizes.eraser ?? DEFAULT_BRUSH_SIZE)
  };
}

export const DEFAULT_EDITOR_UI_STATE: EditorUiState = {
  viewport: { x: 0, y: 0, zoom: 16 },
  brushSize: DEFAULT_BRUSH_SIZE,
  toolBrushSizes: DEFAULT_TOOL_BRUSH_SIZES,
  mode: ChartPresentationMode.Color,
  gridVisible: true,
  overlay: {},
  tool: { tool: 'pan' },
  paletteId: 1,
  keyboardCursor: null,
  selectedCell: null,
  status: null,
  pendingPaletteId: null,
  canPaste: false
};

function sameState(left: EditorUiState, right: EditorUiState): boolean {
  return left.viewport === right.viewport
    && left.brushSize === right.brushSize
    && left.toolBrushSizes === right.toolBrushSizes
    && left.mode === right.mode
    && left.gridVisible === right.gridVisible
    && left.overlay === right.overlay
    && left.tool === right.tool
    && left.paletteId === right.paletteId
    && left.keyboardCursor === right.keyboardCursor
    && left.selectedCell === right.selectedCell
    && left.status === right.status
    && left.pendingPaletteId === right.pendingPaletteId
    && left.canPaste === right.canPaste;
}

export function createUiStore(initial: Partial<EditorUiState> = {}): EditorUiStore {
  let state: EditorUiState = {
    ...DEFAULT_EDITOR_UI_STATE,
    ...initial,
    viewport: initial.viewport ? { ...initial.viewport } : { ...DEFAULT_EDITOR_UI_STATE.viewport },
    toolBrushSizes: normalizeToolBrushSizes(initial.toolBrushSizes ?? DEFAULT_TOOL_BRUSH_SIZES),
    overlay: initial.overlay ? { ...initial.overlay } : {}
  };
  const initialBrushSize = normalizeBrushSize(initial.brushSize ?? DEFAULT_BRUSH_SIZE);
  const initialBrushTool = brushSizeToolFor(state.tool);
  let toolBrushSizes = state.toolBrushSizes;
  if (initial.brushSize !== undefined && initialBrushTool) {
    toolBrushSizes = { ...toolBrushSizes, [initialBrushTool]: initialBrushSize };
  }
  state = {
    ...state,
    brushSize: initial.brushSize === undefined && initialBrushTool
      ? toolBrushSizes[initialBrushTool]
      : initialBrushSize,
    toolBrushSizes
  };
  const listeners = new Set<UiListener>();

  const store: EditorUiStore = {
    getState: () => state,

    setState(patch: UiStatePatch): void {
      const changes = typeof patch === 'function' ? patch(state) : patch;
      let next: EditorUiState = {
        ...state,
        ...changes,
        viewport: changes.viewport ? { ...changes.viewport } : state.viewport,
        toolBrushSizes: changes.toolBrushSizes
          ? normalizeToolBrushSizes({ ...state.toolBrushSizes, ...changes.toolBrushSizes })
          : state.toolBrushSizes,
        overlay: changes.overlay ? { ...changes.overlay } : state.overlay
      };
      const activeBrushSizeTool = brushSizeToolFor(next.tool);
      if (changes.brushSize !== undefined) {
        const brushSize = normalizeBrushSize(changes.brushSize);
        next = {
          ...next,
          brushSize,
          toolBrushSizes: activeBrushSizeTool && next.toolBrushSizes[activeBrushSizeTool] !== brushSize
            ? { ...next.toolBrushSizes, [activeBrushSizeTool]: brushSize }
            : next.toolBrushSizes
        };
      } else if (activeBrushSizeTool && (changes.tool !== undefined || changes.toolBrushSizes !== undefined)) {
        next = { ...next, brushSize: next.toolBrushSizes[activeBrushSizeTool] };
      } else {
        next = { ...next, brushSize: state.brushSize };
      }
      if (sameState(state, next)) return;
      const previous = state;
      state = next;
      listeners.forEach((listener) => listener(state, previous));
    },

    setViewport(viewport: Viewport): void {
      store.setState({ viewport });
    },

    getBrushSize(): number {
      return state.brushSize;
    },

    setBrushSize(size: number): void {
      store.setState({ brushSize: normalizeBrushSize(size) });
    },

    setToolBrushSize(tool: BrushSizeTool, size: number): void {
      const normalized = normalizeBrushSize(size);
      if (state.toolBrushSizes[tool] === normalized) return;
      store.setState((current) => ({
        toolBrushSizes: { ...current.toolBrushSizes, [tool]: normalized }
      }));
    },

    setMode(mode): void {
      store.setState({ mode });
    },

    setGridVisible(visible: boolean): void {
      store.setState({ gridVisible: visible });
    },

    setOverlay(overlay: OverlayState): void {
      store.setState({ overlay });
    },

    setTool(tool: EditorToolState): void {
      store.setState({ tool });
    },

    setBrush(brush: StitchBrush): void {
      store.setState({ tool: { tool: 'paint', brush }, paletteId: brush.paletteId });
    },

    setAuthoringBrush(brush: AuthoringStitchBrush): void {
      store.setBrush(brush);
    },

    setPaletteId(paletteId: number | null): void {
      store.setState({ paletteId });
    },

    setPendingPaletteId(paletteId: number | null): void {
      store.setState({ pendingPaletteId: paletteId });
    },

    setKeyboardCursor(cursor: ModelPoint | null): void {
      store.setState({ keyboardCursor: cursor });
    },

    setSelectedCell(selectedCell: SelectedCellSemantics | null): void {
      store.setState({ selectedCell });
    },

    setStatus(status: string | null): void {
      store.setState({ status });
    },

    setCanPaste(canPaste: boolean): void {
      store.setState({ canPaste });
    },

    subscribe(listener: UiListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
  return store;
}

export const createEditorUiStore = createUiStore;
