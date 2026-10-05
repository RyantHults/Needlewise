import type { CellKind, PatternDocument, PatternFragment } from '../domain';

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

/** Paint, eraser and canvas-brush tools with independent retained brush sizes. */
export type BrushSizeTool = 'full' | 'half' | 'three-quarter' | 'eraser' | 'canvas-brush';

export type ToolBrushSizes = Readonly<Record<BrushSizeTool, number>>;

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
  /** Ordered document indices for a sparse selection. */
  readonly indices?: ArrayLike<number>;
  /** Compatibility alias for integrations that call these cell indices. */
  readonly cellIndices?: ArrayLike<number>;
  readonly boundaries?: readonly SelectionBoundarySegment[];
  /** Compatibility alias for boundary-oriented renderers. */
  readonly boundarySegments?: readonly SelectionBoundarySegment[];
  readonly boundary?: readonly SelectionBoundarySegment[];
  readonly exteriorBoundary?: readonly SelectionBoundarySegment[];
  readonly interiorBoundary?: readonly SelectionBoundarySegment[];
  readonly kind?: 'rect' | 'sparse';
}

export interface SelectionBoundarySegment {
  readonly start: ModelPoint;
  readonly end: ModelPoint;
  readonly kind: 'exterior' | 'interior';
}

export interface LassoPathOverlay {
  readonly points: readonly ModelPoint[];
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
  readonly lassoPath?: LassoPathOverlay | readonly ModelPoint[] | null;
  readonly cursor?: CursorOverlay | ModelPoint | null;
  readonly backstitchPreview?: BackstitchPreviewOverlay | null;
  readonly brushPreview?: BrushPreviewOverlay | null;
  readonly fillPending?: boolean;
  /** Cells in an uncommitted paint or erase gesture; these never belong to the document. */
  readonly pendingCells?: readonly ModelPoint[];
  /** Exact sparse cell states that the pending gesture would produce. */
  readonly pendingCellStates?: readonly PendingCellState[];
  readonly floatingPaste?: FloatingPasteOverlay | null;
  /** Backstitches an uncommitted specialty-layer erase gesture would remove. */
  readonly pendingBackstitchRemovals?: readonly PendingBackstitchRemoval[];
  /** A touch-only request for the UI to offer Copy for the active selection. */
  readonly touchCopyRequest?: TouchCopyRequest | null;
  readonly color?: string;
  readonly showCursor?: boolean;
  readonly showSelection?: boolean;
  /** When true the overlay canvas draws the reference image's resize handles. */
  readonly imageResizeHandles?: boolean;
  /** Present only while the Canvas layer is active: draws the ghost workspace grid and pending canvas edits. */
  readonly canvasEditing?: CanvasEditingOverlay | null;
}

/**
 * Canvas-editing presentation. Every rect is in local cell coordinates
 * (0,0 = the canvas box's top-left), so x/y may be negative.
 */
export interface CanvasEditingOverlay {
  /** The workspace frozen for the current gesture (`canvasWorkspace` from the domain). */
  readonly workspace: CellRect;
  /** A finalized canvas selection, which may extend beyond the canvas. */
  readonly selection?: CanvasCellSet | null;
  /** The uncommitted result of a gesture: brush, eraser, or edge drag. */
  readonly preview?: CanvasEditPreview | null;
}

/** Cells over `rect`; `cells` is row-major 0/1 over the rect, and absent means the whole rect. */
export interface CanvasCellSet {
  readonly rect: CellRect;
  readonly cells?: Uint8Array;
}

export type CanvasEditPreview =
  | ({ readonly kind: 'add' | 'remove' } & CanvasCellSet)
  /** Basic-mode edge drag: the box the canvas would have on release. */
  | { readonly kind: 'resize'; readonly box: CellRect };

export interface BackstitchPreviewOverlay {
  readonly start: FixedPoint;
  readonly end: FixedPoint;
  readonly color?: string;
}

export interface BrushPreviewOverlay {
  readonly states: readonly PendingCellState[];
  readonly color?: string;
  readonly kind: 'paint' | 'eraser';
}

/** A backstitch segment an uncommitted specialty-layer erase would remove. */
export interface PendingBackstitchRemoval {
  readonly id: number;
  readonly start: FixedPoint;
  readonly end: FixedPoint;
}

/** Presentation-only preview for a controller-owned, uncommitted paste. */
export interface FloatingPasteOverlay {
  readonly fragment: PatternFragment;
  readonly destination: GridRect;
  readonly mode?: 'paste' | 'move';
  readonly copySelection?: FloatingPasteSelectionOverlay;
  readonly sourceSelection?: FloatingPasteSelectionOverlay;
  readonly completion?: ArrayLike<number>;
  readonly backstitches?: FloatingPasteBackstitchOverlay;
  readonly color?: string;
}

export interface FloatingPasteBackstitchOverlay {
  readonly ids: ArrayLike<number>;
  readonly x1: ArrayLike<number>;
  readonly y1: ArrayLike<number>;
  readonly x2: ArrayLike<number>;
  readonly y2: ArrayLike<number>;
  readonly colors: ArrayLike<number>;
  readonly completed: ArrayLike<number>;
}

export interface FloatingPasteSelectionOverlay {
  readonly kind: 'rect' | 'sparse';
  readonly rect: CellRect;
  /** Sparse boundaries are normalized to the copy rectangle's top-left. */
  readonly boundaries?: readonly SelectionBoundarySegment[];
}

export interface TouchCopyRequest {
  readonly cell: ModelPoint;
  readonly selection: GridRect;
  readonly screenX: number;
  readonly screenY: number;
  /** The pointer type of the tap that opened the request; the UI guards touch-opened menus against synthetic clicks. */
  readonly pointerType?: string;
  /**
   * True when the request is for a canvas selection (Canvas layer): the UI
   * offers Add/Delete (`applyCanvasSelection`) instead of Copy/Paste/Move/Delete.
   * `selection` is then the canvas selection's rect, which may lie partly
   * outside the canvas.
   */
  readonly canvas?: boolean;
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
  /**
   * Every document cell whose content changed, when known. Overview atlases
   * repaint only these cells, even when `full` asks for a whole-screen redraw;
   * an empty list means no cell changed.
   */
  readonly cellIndices?: ArrayLike<number>;
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
  /** Fill for everything that is not an active canvas cell: outside the box and holes inside it. */
  readonly offCanvasColor: string;
  /** Lines of the ghost grid drawn over the workspace while the Canvas layer is edited. */
  readonly ghostGridColor: string;
  readonly ghostMajorGridColor: string;
  /** Tint for cells a pending canvas edit would add. */
  readonly canvasAddColor: string;
  /** Hatch for cells a pending canvas edit would remove. */
  readonly canvasRemoveColor: string;
}

export interface RendererStyle extends RendererTheme {
  readonly mode: ChartPresentationMode;
  readonly gridInterval: number;
  readonly midGridInterval: number;
  readonly showGrid: boolean;
  readonly showSymbols: boolean;
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
  offCanvasColor: '#e4e1dc',
  ghostGridColor: '#d3cfc8',
  ghostMajorGridColor: '#bdb8b0',
  canvasAddColor: '#2a9d5c',
  canvasRemoveColor: '#cc3333',
  gridInterval: 10,
  midGridInterval: 5,
  showGrid: true,
  showSymbols: true,
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
  fill(path?: unknown): void;
  stroke(path?: unknown): void;
  fillText?(text: string, x: number, y: number): void;
  drawImage?(...args: unknown[]): void;
  save?(): void;
  restore?(): void;
  /** Composes with the current matrix. `setTransform` would replace the DPR matrix. */
  translate?(x: number, y: number): void;
  scale?(x: number, y: number): void;
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

/** How the Canvas layer is edited: Basic resizes by edges, Advanced adds and removes cells. */
export type CanvasEditMode = 'basic' | 'advanced';

export interface EditorUiState {
  readonly viewport: Viewport;
  readonly brushSize: number;
  /** Retained brush size for each supported authoring tool. */
  readonly toolBrushSizes: ToolBrushSizes;
  readonly mode: ChartPresentationMode;
  /** Session-scoped chart-grid visibility; a view preference, never persisted or undoable. */
  readonly gridVisible: boolean;
  readonly overlay: OverlayState;
  readonly tool: EditorToolState;
  readonly paletteId: number | null;
  readonly keyboardCursor: ModelPoint | null;
  readonly selectedCell: SelectedCellSemantics | null;
  readonly status: string | null;
  /** True when the controller has a cloned in-app fragment available to paste. */
  readonly canPaste: boolean;
  /** The layer editor tools act on; null when the workspace has no layer information. */
  readonly activeLayer: EditorActiveLayer | null;
  /**
   * The effective Canvas-layer edit mode. UI state, never persisted. The
   * controller forces 'advanced' while the canvas is not a rectangle.
   */
  readonly canvasMode: CanvasEditMode;
  /** False while the canvas is not a rectangle, which locks `canvasMode` to 'advanced'. */
  readonly canvasBasicAvailable: boolean;
  /**
   * Crop mode: canvas editing is on only while this is true and the Canvas
   * layer is selected. UI state; it turns off when the layer changes.
   */
  readonly canvasCropActive: boolean;
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
  Lasso: 'lasso',
  Fill: 'fill',
  Backstitch: 'backstitch',
  Eyedropper: 'eyedropper',
  Shape: 'shape',
  CanvasBrush: 'canvas-brush'
} as const;

export type EditorToolKind = (typeof EditorToolKind)[keyof typeof EditorToolKind];

export type ShapeKind = 'line' | 'rectangle' | 'square' | 'circle' | 'oval' | 'triangle' | 'right-triangle';

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

/** The diagonal a half-stitch brush stamps when it does not name one. */
export const DEFAULT_HALF_DIRECTION: '\\' | '/' = '/';

export interface HalfStitchBrush {
  readonly kind: 'half';
  /** The diagonal the half tool stamps, whichever corner is hit; omitted means `DEFAULT_HALF_DIRECTION`. */
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

/** The marquee Select draws; an oval covers the cells the oval Shape stamps plus its interior. */
export type SelectShape = 'rectangle' | 'oval';

export interface SelectToolState {
  readonly tool: 'select';
  /** Undefined means `'rectangle'`. */
  readonly shape?: SelectShape;
}

/** Freehand traces the drag; polygon joins clicked vertices with straight edges. */
export type LassoShape = 'freehand' | 'polygon';

export interface LassoToolState {
  readonly tool: 'lasso';
  /** Undefined means `'freehand'`. */
  readonly shape?: LassoShape;
}

export interface FillToolState {
  readonly tool: 'fill';
  /** Deprecated compatibility field; Fill ignores brush geometry and color. */
  readonly brush?: StitchBrush;
}

/** Draw always starts a new segment; Move only picks up existing ones. */
export type BackstitchMode = 'draw' | 'move';

export interface BackstitchToolState {
  readonly tool: 'backstitch';
  /** Undefined means `'draw'`. */
  readonly mode?: BackstitchMode;
}

export interface EyedropperToolState {
  readonly tool: 'eyedropper';
}

export interface ShapeToolState {
  readonly tool: 'shape';
  readonly shape: ShapeKind;
}

/** Adds canvas cells on the Canvas layer in Advanced mode. Removal uses the eraser. */
export interface CanvasBrushToolState {
  readonly tool: 'canvas-brush';
}

/** Reposition the reference image with pointer drags. No brush or chart edits. */
export interface MoveImageToolState {
  readonly tool: 'move-image';
}

/** Resize the reference image by dragging its corner handles. */
export interface ResizeImageToolState {
  readonly tool: 'resize-image';
}

export type EditorToolState = PaintToolState | PanToolState | EraserToolState | SelectToolState | LassoToolState | FillToolState | BackstitchToolState | EyedropperToolState | ShapeToolState | CanvasBrushToolState | MoveImageToolState | ResizeImageToolState;
export type ToolState = EditorToolState;
export type ActiveStitchBrush = StitchBrush;

/** The kind of row selected in the layers panel. */
export type ActiveLayerKind = 'stitch' | 'specialty' | 'canvas' | 'reference';

export interface EditorActiveLayer {
  readonly id: number | 'canvas' | 'reference';
  readonly kind: ActiveLayerKind;
  readonly visible: boolean;
}

export interface ToolAvailability {
  readonly enabled: boolean;
  /** Short, non-technical reason shown when a disabled tool is tapped or hovered. */
  readonly hint?: string;
}

export const HIDDEN_LAYER_TOOL_HINT = 'Show this layer to edit it.';
export const STITCH_LAYER_TOOL_HINT = 'Select a stitch layer to use this tool.';
export const SPECIALTY_LAYER_BACKSTITCH_HINT = 'Select a specialty layer to use Backstitch.';
export const EDITABLE_LAYER_TOOL_HINT = 'Select a stitch or specialty layer to use this tool.';
export const CANVAS_BRUSH_LAYER_HINT = 'Select the Canvas layer to use the canvas brush.';
export const CANVAS_BASIC_TOOL_HINT = 'Switch the canvas to Advanced to use this tool.';
export const CANVAS_ADVANCED_TOOL_HINT = 'Select a stitch or specialty layer to use this tool.';
/** Why Basic canvas mode is unavailable. */
export const CANVAS_BASIC_LOCKED_HINT = "This canvas isn't a rectangle anymore. Undo your shape edits to use Crop.";
/** Why tools are disabled on the Canvas layer while crop mode is off. */
export const CANVAS_CROP_OFF_HINT = 'Turn on Crop to edit the canvas.';

/** Tools that change the selected layer; Pan, Eyedropper and the reference-image tools never do. */
function isEditingTool(tool: EditorToolKind | EditorToolState['tool']): boolean {
  return tool !== 'pan' && tool !== 'eyedropper' && tool !== 'move-image' && tool !== 'resize-image';
}

/**
 * Whether a tool can be used on the selected layer.
 *
 * Pan and Eyedropper always work. Select, Lasso and Eraser work on stitch and
 * specialty layers; stitch brushes, Shape and Fill only on stitch layers;
 * Backstitch only on specialty layers. Every editing tool is disabled on a
 * hidden layer. A null layer means the workspace has no layer information.
 * `brush` is accepted so callers can gate brush variants; every current brush
 * is a stitch brush.
 *
 * On the Canvas layer only Pan works unless `canvasCropActive` is true; then
 * `canvasMode` decides (absent means 'basic'): Basic
 * allows Pan only; Advanced allows the canvas brush, Eraser, Select, Lasso and
 * Pan. The canvas brush works only on the Canvas layer. The reference-image
 * tools are not layer tools and are always allowed.
 */
export function toolAvailability(
  tool: EditorToolKind | EditorToolState['tool'],
  brush: StitchBrushKind | undefined,
  layer: Pick<EditorActiveLayer, 'kind' | 'visible'> | null,
  canvasMode?: CanvasEditMode,
  canvasCropActive = false
): ToolAvailability {
  void brush;
  if (tool === 'move-image' || tool === 'resize-image' || tool === 'pan') return { enabled: true };
  if (layer?.kind === 'canvas') {
    if (!canvasCropActive) return { enabled: false, hint: CANVAS_CROP_OFF_HINT };
    if (canvasMode !== 'advanced') return { enabled: false, hint: CANVAS_BASIC_TOOL_HINT };
    return tool === 'canvas-brush' || tool === 'eraser' || tool === 'select' || tool === 'lasso'
      ? { enabled: true }
      : { enabled: false, hint: CANVAS_ADVANCED_TOOL_HINT };
  }
  if (tool === 'canvas-brush') return { enabled: false, hint: CANVAS_BRUSH_LAYER_HINT };
  if (!layer || !isEditingTool(tool)) return { enabled: true };
  const editable = layer.kind === 'stitch' || layer.kind === 'specialty';
  if (editable && !layer.visible) return { enabled: false, hint: HIDDEN_LAYER_TOOL_HINT };
  if (tool === 'select' || tool === 'lasso' || tool === 'eraser') {
    return editable ? { enabled: true } : { enabled: false, hint: EDITABLE_LAYER_TOOL_HINT };
  }
  if (tool === 'backstitch') {
    return layer.kind === 'specialty' ? { enabled: true } : { enabled: false, hint: SPECIALTY_LAYER_BACKSTITCH_HINT };
  }
  return layer.kind === 'stitch' ? { enabled: true } : { enabled: false, hint: STITCH_LAYER_TOOL_HINT };
}

/** `toolAvailability` for a full tool state, reading the brush from paint tools. */
export function toolStateAvailability(tool: EditorToolState, layer: Pick<EditorActiveLayer, 'kind' | 'visible'> | null, canvasMode?: CanvasEditMode, canvasCropActive = false): ToolAvailability {
  return toolAvailability(tool.tool, tool.tool === 'paint' ? tool.brush?.kind : undefined, layer, canvasMode, canvasCropActive);
}

export type UiStatePatch = Partial<EditorUiState> | ((state: EditorUiState) => Partial<EditorUiState>);

export type UiListener = (state: EditorUiState, previous: EditorUiState) => void;

export interface EditorUiStore {
  getState(): EditorUiState;
  setState(patch: UiStatePatch): void;
  setViewport(viewport: Viewport): void;
  getBrushSize(): number;
  setBrushSize(size: number): void;
  setToolBrushSize(tool: BrushSizeTool, size: number): void;
  setMode(mode: ChartPresentationMode): void;
  setGridVisible(visible: boolean): void;
  setOverlay(overlay: OverlayState): void;
  setTool(tool: EditorToolState): void;
  setBrush(brush: StitchBrush): void;
  setAuthoringBrush(brush: AuthoringStitchBrush): void;
  setPaletteId(paletteId: number | null): void;
  setKeyboardCursor(cursor: ModelPoint | null): void;
  setSelectedCell(selectedCell: SelectedCellSemantics | null): void;
  setStatus(status: string | null): void;
  setCanPaste(canPaste: boolean): void;
  setActiveLayer(activeLayer: EditorActiveLayer | null): void;
  /** Request a Canvas-layer edit mode; the controller keeps it 'advanced' while the canvas is not a rectangle. */
  setCanvasMode(mode: CanvasEditMode): void;
  setCanvasCropActive(active: boolean): void;
  /** Remember the last tool used on a layer type, for returning to it after a layer switch. Image tools are ignored. */
  rememberToolForLayer(kind: ActiveLayerKind, tool: EditorToolState): void;
  lastToolForLayer(kind: ActiveLayerKind): EditorToolState | undefined;
  subscribe(listener: UiListener): () => void;
}
