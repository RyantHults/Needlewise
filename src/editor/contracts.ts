import type { CellKind, PatternDocument } from '../domain';

/** The four ways in which a chart can present a stitch. */
export const ChartPresentationMode = {
  Color: 'color',
  Symbol: 'symbol',
  Grayscale: 'grayscale',
  Combined: 'combined'
} as const;

export type ChartPresentationMode = (typeof ChartPresentationMode)[keyof typeof ChartPresentationMode];
export type ChartMode = ChartPresentationMode;
export const ChartViewMode = ChartPresentationMode;
export type ChartViewMode = ChartPresentationMode;
export type ChartPresentation = ChartPresentationMode;

export const MIN_BRUSH_SIZE = 1;
export const MAX_BRUSH_SIZE = 10;
export const DEFAULT_BRUSH_SIZE = 1;

export function normalizeBrushSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < MIN_BRUSH_SIZE || value > MAX_BRUSH_SIZE) {
    throw new RangeError(`Brush size must be an integer from ${String(MIN_BRUSH_SIZE)} to ${String(MAX_BRUSH_SIZE)}.`);
  }
  return value;
}

/** Three deliberately coarse levels. The thresholds are renderer policy, not document data. */
export const RenderLod = {
  Overview: 'overview',
  Compact: 'compact',
  Detail: 'detail'
} as const;

export type RenderLod = (typeof RenderLod)[keyof typeof RenderLod];
export type LOD = RenderLod;

/** Coordinates in model space are measured in cells. */
export interface ModelPoint {
  readonly x: number;
  readonly y: number;
}

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

/** Coordinates in the document's four-units-per-cell fixed-point space. */
export interface FixedPoint {
  readonly x: number;
  readonly y: number;
}

/** A half-open rectangle. `right` and `bottom` are x + width and y + height. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type CellRect = Rect;

/** A normalized, half-open rectangle in integer grid-cell coordinates. */
export interface GridRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The model coordinate at the top-left of the canvas and pixels per model cell.
 * Keeping the origin in model units makes all screen/model transforms affine and
 * independent from the DOM or a particular canvas implementation.
 */
export interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export type ViewportState = Viewport;

export interface DocumentSize {
  readonly width: number;
  readonly height: number;
}

export interface CanvasMetrics {
  /** CSS/display dimensions used by the coordinate system. */
  readonly cssWidth: number;
  readonly cssHeight: number;
  /** Backing-store dimensions after DPR and pixel-budget limiting. */
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly backingWidth: number;
  readonly backingHeight: number;
  readonly requestedDpr: number;
  readonly dpr: number;
  readonly maxDpr: number;
  readonly maxBackingPixels: number;
}

export interface TraceImageCrop {
  /** Normalized source-image coordinates in the closed interval [0, 1]. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A decoded local raster and its chart-space presentation settings. */
export interface TraceImage {
  readonly source: unknown;
  readonly width: number;
  readonly height: number;
  readonly crop?: TraceImageCrop;
  readonly chartBounds?: CellRect;
  readonly visible?: boolean;
  readonly opacity?: number;
  readonly dispose?: () => void;
}

export interface TraceRgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export type TraceSampleCallback = (rgb: TraceRgb) => void;
/** Chart-space rectangle (in cell coordinates) an image occupies on the chart. */
export type TraceImageBounds = CellRect;
export type TraceBoundsChangeCallback = (bounds: TraceImageBounds) => void;
export type TraceImageSampler = (
  trace: TraceImage,
  document: PatternDocument,
  viewport: Viewport,
  metrics: CanvasMetrics,
  point: ScreenPoint
) => TraceRgb | undefined;

export interface DprOptions {
  readonly dpr?: number;
  readonly devicePixelRatio?: number;
  readonly maxDpr?: number;
  readonly maxDevicePixelRatio?: number;
  readonly maxBackingPixels?: number;
  readonly maxPixels?: number;
  readonly pixelBudget?: number;
}

export interface LodThresholds {
  /** Zoom below this number of pixels per cell uses the atlas. */
  readonly overviewMaxZoom: number;
  /** Zoom below this number of pixels per cell uses compact geometry. */
  readonly compactMaxZoom: number;
}

export const DEFAULT_LOD_THRESHOLDS: LodThresholds = {
  overviewMaxZoom: 4,
  compactMaxZoom: 12
};

export interface SelectionOverlay {
  readonly rect: CellRect;
  readonly color?: string;
}

export interface CursorOverlay {
  readonly cell: ModelPoint;
  readonly color?: string;
}

/** Sparse after-state for an uncommitted cell gesture. */
export interface PendingCellState {
  readonly index: number;
  readonly cell: ModelPoint;
  readonly kind: CellKind;
  readonly colors: readonly [number, number, number, number];
  readonly completed: number;
}

export interface OverlayState {
  readonly selection?: SelectionOverlay | CellRect | null;
  readonly cursor?: CursorOverlay | ModelPoint | null;
  readonly backstitchPreview?: BackstitchPreviewOverlay | null;
  readonly fillPending?: boolean;
  /** Cells in an uncommitted paint or erase gesture; these never belong to the document. */
  readonly pendingCells?: readonly ModelPoint[];
  /** Exact sparse cell states that the pending gesture would produce. */
  readonly pendingCellStates?: readonly PendingCellState[];
  readonly color?: string;
  readonly showCursor?: boolean;
  readonly showSelection?: boolean;
  /** When true the overlay canvas draws the reference image's resize handles. */
  readonly imageResizeHandles?: boolean;
}

export interface BackstitchPreviewOverlay {
  readonly start: FixedPoint;
  readonly end: FixedPoint;
  readonly color?: string;
}

export type InvalidationLayer = 'base' | 'overlay' | 'all';

export interface Invalidation {
  readonly layer: InvalidationLayer;
  /** CSS-pixel rectangle in the target's local coordinate space. */
  readonly rect?: Rect;
  /** Model-space rectangle, useful when a command knows its changed cells. */
  readonly cellRect?: CellRect;
  /** A missing region is a full-layer invalidation; this flag is explicit for callers. */
  readonly full?: boolean;
  readonly reason?: string;
}

export type RenderInvalidation = Invalidation;
export type InvalidationRequest = Invalidation;

export interface CoalescedInvalidation {
  readonly base: boolean;
  readonly overlay: boolean;
  readonly rect?: Rect;
  readonly cellRect?: CellRect;
  readonly dirtyRects?: readonly Rect[];
  readonly dirtyCellRects?: readonly CellRect[];
  readonly reasons: readonly string[];
}

export interface RendererTheme {
  readonly backgroundColor: string;
  readonly gridColor: string;
  readonly midGridColor: string;
  readonly majorGridColor: string;
  readonly chartBorderColor: string;
  readonly symbolColor: string;
  readonly symbolBackgroundColor: string;
  readonly completedColor: string;
  readonly selectionColor: string;
  readonly cursorColor: string;
  readonly missingPaletteColor: string;
  readonly pendingCellColor: string;
}

export interface RendererStyle extends RendererTheme {
  readonly mode: ChartPresentationMode;
  readonly gridInterval: number;
  readonly midGridInterval: number;
  readonly showGrid: boolean;
  readonly showSymbols: boolean;
  /**
   * Symbol glyph font. The `em` size unit is interpreted as a fraction of the
   * grid cell (e.g. `1em` fills most of the cell) rather than the canvas
   * default font size, so the glyph scales with the cell at every zoom level.
   */
  readonly symbolFont: string;
  readonly completedOpacity: number;
  readonly completedMarkWidth: number;
  readonly overlayLineWidth: number;
  readonly pendingCellOpacity: number;
}

export const DEFAULT_RENDERER_STYLE: RendererStyle = {
  mode: ChartPresentationMode.Color,
  backgroundColor: '#ffffff',
  gridColor: '#d8d8d8',
  midGridColor: '#b8b8b8',
  majorGridColor: '#858585',
  chartBorderColor: '#4b4b4b',
  symbolColor: '#242424',
  symbolBackgroundColor: '#ffffff',
  completedColor: '#242424',
  selectionColor: '#2266cc',
  cursorColor: '#cc4422',
  missingPaletteColor: '#9b9b9b',
  pendingCellColor: '#2266cc',
  gridInterval: 10,
  midGridInterval: 5,
  showGrid: true,
  showSymbols: true,
  symbolFont: '600 1em sans-serif',
  completedOpacity: 0.62,
  completedMarkWidth: 1,
  overlayLineWidth: 2,
  pendingCellOpacity: 0.34
};

/** A deliberately small Canvas 2D surface used by the renderer. */
export interface CanvasContextAdapter {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  lineCap?: string;
  lineJoin?: string;
  globalAlpha: number;
  font: string;
  textAlign?: string;
  textBaseline?: string;
  imageSmoothingEnabled?: boolean;
  globalCompositeOperation?: string;
  clearRect(x: number, y: number, width: number, height: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  strokeRect?(x: number, y: number, width: number, height: number): void;
  rect?(x: number, y: number, width: number, height: number): void;
  clip?(): void;
  beginPath(): void;
  closePath?(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  fill(): void;
  stroke(): void;
  fillText?(text: string, x: number, y: number): void;
  drawImage?(...args: unknown[]): void;
  save?(): void;
  restore?(): void;
  setTransform?(a: number, b: number, c: number, d: number, e: number, f: number): void;
  setLineDash?(segments: readonly number[]): void;
}

export type Canvas2DContext = CanvasContextAdapter;
export type CanvasTargetAdapter = CanvasTarget;

export interface CanvasTarget {
  readonly context: CanvasContextAdapter;
  /** CSS-independent backing dimensions. A target may resize itself in `resize`. */
  width: number;
  height: number;
  readonly source?: unknown;
  resize?(width: number, height: number): void;
}

export interface RendererTargets {
  readonly base: CanvasTarget;
  readonly overlay: CanvasTarget;
}

export type FrameRequest = (callback: (time: number) => void) => number;
export type FrameCancel = (handle: number) => void;

export interface AtlasTargetFactory {
  (width: number, height: number): CanvasTarget | undefined;
}

export interface CanvasRendererOptions {
  readonly document: PatternDocument;
  readonly targets: RendererTargets;
  readonly metrics: CanvasMetrics;
  readonly viewport?: Viewport;
  readonly style?: Partial<RendererStyle>;
  readonly traceImage?: TraceImage;
  readonly trace?: TraceImage;
  readonly overlay?: OverlayState;
  readonly lodThresholds?: Partial<LodThresholds>;
  readonly atlasTargetFactory?: AtlasTargetFactory;
  readonly requestAnimationFrame?: FrameRequest;
  readonly cancelAnimationFrame?: FrameCancel;
}

export interface RenderStats {
  readonly lod: RenderLod;
  readonly visitedCells: number;
  readonly drawnCells: number;
  readonly drawnBackstitches: number;
  readonly baseRendered: boolean;
  readonly overlayRendered: boolean;
}

export interface CanvasRenderer {
  readonly lastStats: RenderStats;
  getDocument(): PatternDocument;
  getViewport(): Viewport;
  getStyle(): RendererStyle;
  getTraceImage(): TraceImage | undefined;
  setDocument(document: PatternDocument, invalidation?: Invalidation): void;
  setViewport(viewport: Viewport): void;
  setMetrics(metrics: CanvasMetrics): void;
  setStyle(style: Partial<RendererStyle>): void;
  setTraceImage(trace: TraceImage | undefined): void;
  setTraceImageSettings?(settings: Pick<TraceImage, 'visible' | 'opacity'>): void;
  setPatternDimmed?(dimmed: boolean): void;
  clearTraceImage(): void;
  setOverlay(overlay: OverlayState, invalidation?: Invalidation): void;
  invalidate(invalidation?: Invalidation | InvalidationLayer): void;
  requestRender(): void;
  render(): RenderStats;
  renderNow(): RenderStats;
  getLastInvalidation(): CoalescedInvalidation;
  dispose(): void;
  destroy(): void;
}

export type RendererLifecycle = Pick<CanvasRenderer, 'requestRender' | 'render' | 'renderNow' | 'invalidate' | 'dispose' | 'destroy'>;

export interface EditorUiState {
  readonly viewport: Viewport;
  readonly brushSize: number;
  readonly mode: ChartPresentationMode;
  /** Session-scoped chart-grid visibility; a view preference, never persisted or undoable. */
  readonly gridVisible: boolean;
  readonly overlay: OverlayState;
  readonly tool: EditorToolState;
  readonly paletteId: number | null;
  readonly keyboardCursor: ModelPoint | null;
  readonly selectedCell: SelectedCellSemantics | null;
  readonly status: string | null;
  /** Active palette entry added by the eyedropper but not yet referenced by a stitch or backstitch. */
  readonly pendingPaletteId: number | null;
}

export type SelectedCellGeometry =
  | 'empty'
  | 'full'
  | 'half-backslash'
  | 'half-slash'
  | 'quarters'
  | 'three-quarter-nw'
  | 'three-quarter-ne'
  | 'three-quarter-se'
  | 'three-quarter-sw'
  | 'three-quarter-pair';

export interface SelectedCellCompletion {
  readonly completed: number;
  readonly total: number;
  readonly summary: string;
}

export interface SelectedCellSemantics {
  /** One-based values are convenient for a later screen-reader/live-region adapter. */
  readonly row: number;
  readonly column: number;
  readonly cell: ModelPoint;
  readonly geometry: SelectedCellGeometry;
  readonly paletteId: number | null;
  readonly paletteName: string | null;
  readonly paletteIds: readonly number[];
  readonly paletteNames: readonly string[];
  readonly completion: SelectedCellCompletion;
  readonly summary: string;
}

export const EditorToolKind = {
  Paint: 'paint',
  Pan: 'pan',
  Eraser: 'eraser',
  Select: 'select',
  Fill: 'fill',
  Backstitch: 'backstitch',
  Eyedropper: 'eyedropper'
} as const;

export type EditorToolKind = (typeof EditorToolKind)[keyof typeof EditorToolKind];

export const StitchBrushKind = {
  Full: 'full',
  Half: 'half',
  Quarter: 'quarter',
  ThreeQuarter: 'three-quarter'
} as const;

/** Brush variants exposed to new authoring flows. Quarter geometry is legacy-only. */
export const AuthoringStitchBrushKind = {
  Full: 'full',
  Half: 'half',
  ThreeQuarter: 'three-quarter'
} as const;

export type AuthoringStitchBrushKind = (typeof AuthoringStitchBrushKind)[keyof typeof AuthoringStitchBrushKind];

export type StitchBrushKind = (typeof StitchBrushKind)[keyof typeof StitchBrushKind];

export interface FullStitchBrush {
  readonly kind: 'full';
  readonly paletteId: number;
}

export interface HalfStitchBrush {
  readonly kind: 'half';
  /** Retained for legacy callers; authoring derives this from the hit corner. */
  readonly direction?: '\\' | '/';
  readonly paletteId: number;
}

export interface ThreeQuarterStitchBrush {
  readonly kind: 'three-quarter';
  readonly paletteId: number;
}

export interface QuarterStitchBrush {
  readonly kind: 'quarter';
  readonly corner: 0 | 1 | 2 | 3;
  readonly paletteId: number;
}

export type StitchBrush = FullStitchBrush | HalfStitchBrush | ThreeQuarterStitchBrush | QuarterStitchBrush;
export type AuthoringStitchBrush = FullStitchBrush | HalfStitchBrush | ThreeQuarterStitchBrush;
export type LegacyStitchBrush = QuarterStitchBrush;

export interface PaintToolState {
  readonly tool: 'paint';
  readonly brush: StitchBrush;
}

export interface PanToolState {
  readonly tool: 'pan';
}

export type EraserMode = 'whole-cell' | 'component';

export interface EraserToolState {
  readonly tool: 'eraser';
  readonly mode?: EraserMode;
  readonly corner?: 0 | 1 | 2 | 3;
}

export interface SelectToolState {
  readonly tool: 'select';
}

export interface FillToolState {
  readonly tool: 'fill';
  readonly brush?: StitchBrush;
}

export interface BackstitchToolState {
  readonly tool: 'backstitch';
}

export interface EyedropperToolState {
  readonly tool: 'eyedropper';
}

/** Reposition the reference image with pointer drags. No brush or chart edits. */
export interface MoveImageToolState {
  readonly tool: 'move-image';
}

/** Resize the reference image by dragging its corner handles. */
export interface ResizeImageToolState {
  readonly tool: 'resize-image';
}

export type EditorToolState = PaintToolState | PanToolState | EraserToolState | SelectToolState | FillToolState | BackstitchToolState | EyedropperToolState | MoveImageToolState | ResizeImageToolState;
export type ToolState = EditorToolState;
export type ActiveStitchBrush = StitchBrush;

export type UiStatePatch = Partial<EditorUiState> | ((state: EditorUiState) => Partial<EditorUiState>);

export type UiListener = (state: EditorUiState, previous: EditorUiState) => void;

export interface EditorUiStore {
  getState(): EditorUiState;
  setState(patch: UiStatePatch): void;
  setViewport(viewport: Viewport): void;
  getBrushSize(): number;
  setBrushSize(size: number): void;
  setMode(mode: ChartPresentationMode): void;
  setGridVisible(visible: boolean): void;
  setOverlay(overlay: OverlayState): void;
  setTool(tool: EditorToolState): void;
  setBrush(brush: StitchBrush): void;
  setAuthoringBrush(brush: AuthoringStitchBrush): void;
  setPaletteId(paletteId: number | null): void;
  setPendingPaletteId(paletteId: number | null): void;
  setKeyboardCursor(cursor: ModelPoint | null): void;
  setSelectedCell(selectedCell: SelectedCellSemantics | null): void;
  setStatus(status: string | null): void;
  subscribe(listener: UiListener): () => void;
}
