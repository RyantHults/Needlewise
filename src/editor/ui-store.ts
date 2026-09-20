import {
  ChartPresentationMode,
  DEFAULT_BRUSH_SIZE,
  normalizeBrushSize,
  type EditorUiState,
  type EditorUiStore,
  type EditorToolState,
  type AuthoringStitchBrush,
  type ModelPoint,
  type OverlayState,
  type SelectedCellSemantics,
  type StitchBrush,
  type UiListener,
  type UiStatePatch,
  type Viewport
} from './contracts';

export const DEFAULT_EDITOR_UI_STATE: EditorUiState = {
  viewport: { x: 0, y: 0, zoom: 16 },
  brushSize: DEFAULT_BRUSH_SIZE,
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
    brushSize: normalizeBrushSize(initial.brushSize ?? DEFAULT_BRUSH_SIZE),
    overlay: initial.overlay ? { ...initial.overlay } : {}
  };
  const listeners = new Set<UiListener>();

  const store: EditorUiStore = {
    getState: () => state,

    setState(patch: UiStatePatch): void {
      const changes = typeof patch === 'function' ? patch(state) : patch;
      const next: EditorUiState = {
        ...state,
        ...changes,
        viewport: changes.viewport ? { ...changes.viewport } : state.viewport,
        brushSize: changes.brushSize === undefined ? state.brushSize : normalizeBrushSize(changes.brushSize),
        overlay: changes.overlay ? { ...changes.overlay } : state.overlay
      };
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
