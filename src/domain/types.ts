/** Persisted cell geometry tags. Quarters is reserved for legacy slot geometry. */
export const CellKind = {
  Empty: 0,
  Full: 1,
  HalfBackslash: 2,
  HalfSlash: 3,
  Quarters: 4,
  ThreeQuarterNW: 5,
  ThreeQuarterNE: 6,
  ThreeQuarterSE: 7,
  ThreeQuarterSW: 8,
  ThreeQuarterPair: 9,
  Half: 2,
  Quarter: 4,
  EMPTY: 0,
  FULL: 1,
  HALF_BACKSLASH: 2,
  HALF_SLASH: 3,
  QUARTERS: 4,
  THREE_QUARTER_NW: 5,
  THREE_QUARTER_NE: 6,
  THREE_QUARTER_SE: 7,
  THREE_QUARTER_SW: 8,
  THREE_QUARTER_PAIR: 9
} as const;

export type CellKind = (typeof CellKind)[keyof typeof CellKind];

export const StitchKind = CellKind;

export const HalfDirection = {
  Backslash: '\\',
  Slash: '/',
  BACKSLASH: '\\',
  SLASH: '/'
} as const;

export type HalfDirection = (typeof HalfDirection)[keyof typeof HalfDirection];

export const QuarterCorner = {
  NW: 0,
  NE: 1,
  SE: 2,
  SW: 3,
  NORTHWEST: 0,
  NORTHEAST: 1,
  SOUTHEAST: 2,
  SOUTHWEST: 3
} as const;

export type QuarterCorner = (typeof QuarterCorner)[keyof typeof QuarterCorner];
export const Corner = QuarterCorner;

export const CELL_COLOR_SLOTS = 4;
export const FIXED_POINT_UNITS_PER_CELL = 4;
/** The largest grid that can be allocated, iterated, and persisted by v1. */
export const MAX_PERSISTABLE_CELL_COUNT = 1_000_000;
export const PATTERN_FRAGMENT_VERSION = 1 as const;
export const DOCUMENT_SCHEMA_VERSION = 1 as const;
export const PALETTE_ID_MAX = 0xfffe;
export const PALETTE_ID_RESERVED = 0xffff;

export const MaterialKind = {
  Floss: 'floss',
  Custom: 'custom'
} as const;

export type MaterialKind = (typeof MaterialKind)[keyof typeof MaterialKind];

export const MaterialUnit = {
  Skeins: 'skeins',
  Meters: 'meters',
  Count: 'count'
} as const;

export type MaterialUnit = (typeof MaterialUnit)[keyof typeof MaterialUnit];

export interface CatalogAssociation {
  readonly catalogId: string;
  readonly brandLabel: string;
  readonly colorCount: number;
}

export interface PaletteCatalogReference {
  readonly catalogId: string;
  readonly sourceId: string;
  readonly code: string;
  readonly name: string;
  readonly hex: string;
  readonly rgb: readonly [number, number, number];
}

export interface PaletteMaterial {
  readonly kind: MaterialKind;
  readonly label: string;
  readonly unit: MaterialUnit;
  readonly amount?: number;
}

export interface PatternSettings {
  readonly symbolSet: string;
  readonly materialUnit: MaterialUnit;
  /** Canonical uppercase #RRGGBB fabric/chart background color. */
  readonly backgroundColor: string;
  /** Fabric stitch count. It only affects size, thread and stitch estimates. */
  readonly aidaCount: number;
}

/** Mirrors metrics' DEFAULT_AIDA_COUNT without importing it into the type layer. */
export const DEFAULT_PATTERN_AIDA_COUNT = 14;

export const DEFAULT_PATTERN_SETTINGS: PatternSettings = {
  symbolSet: 'default',
  materialUnit: MaterialUnit.Skeins,
  backgroundColor: '#F3EEE5',
  aidaCount: DEFAULT_PATTERN_AIDA_COUNT
};

export interface PaletteEntry {
  readonly id: number;
  readonly name: string;
  readonly color: string;
  readonly active: boolean;
  readonly symbol: string;
  readonly material: PaletteMaterial;
  readonly catalog?: PaletteCatalogReference;
}

export interface PaletteEntryInput {
  id?: number;
  name: string;
  color: string;
  active?: boolean;
  symbol?: string;
  material?: PaletteMaterial;
  catalog?: PaletteCatalogReference;
}

/**
 * Backstitches are kept sparse. Each property has the same length and the
 * index of a record is not its identity; `ids` are the stable identities.
 */
export interface BackstitchStore {
  ids: Uint32Array;
  x1: Uint32Array;
  y1: Uint32Array;
  x2: Uint32Array;
  y2: Uint32Array;
  colors: Uint16Array;
  completed: Uint8Array;
}

export interface BackstitchRecord {
  readonly id: number;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly start: Point;
  readonly end: Point;
  readonly color: number;
  readonly completed: boolean;
}

export interface Point {
  x: number;
  y: number;
}

export interface PatternDocument {
  readonly version: typeof DOCUMENT_SCHEMA_VERSION;
  readonly catalog: CatalogAssociation;
  width: number;
  height: number;
  kind: Uint8Array;
  colors: Uint16Array;
  completed: Uint8Array;
  backstitches: BackstitchStore;
  palette: PaletteEntry[];
  settings: PatternSettings;
  revision: number;
  /** The next value allocated for a backstitch. It is never decremented. */
  nextBackstitchId: number;
  /** The next value allocated for a palette entry. It is never decremented. */
  nextPaletteId: number;
  /** Workspace x of local cell (0,0); absent means 0. */
  originX?: number;
  /** Workspace y of local cell (0,0); absent means 0. */
  originY?: number;
  /**
   * Active cells of the box, one byte per cell (1 = active). Absent means the
   * whole box is active; a present mask is never all-ones and is never mutated.
   */
  canvasMask?: Uint8Array;
}

export type Pattern = PatternDocument;

export const LayerType = {
  Stitch: 'stitch',
  Specialty: 'specialty'
} as const;

export type LayerType = (typeof LayerType)[keyof typeof LayerType];

export const MAX_LAYERS_PER_TYPE = 3;

/** Why another layer of this type cannot be added. */
export function layerLimitMessage(type: LayerType): string {
  return `You already have ${String(MAX_LAYERS_PER_TYPE)} ${type} layers.`;
}
export const MAX_LAYER_NAME_CHARS = 60;
export const LAYERED_DOCUMENT_VERSION = 2 as const;

export const LayerErrorCode = {
  NotFound: 'layer-not-found',
  Hidden: 'layer-hidden',
  TypeMismatch: 'layer-type-mismatch',
  Limit: 'layer-limit',
  MergeInvalid: 'layer-merge-invalid'
} as const;

export type LayerErrorCode = (typeof LayerErrorCode)[keyof typeof LayerErrorCode];

interface LayerBase {
  readonly id: number;
  name: string;
  visible: boolean;
}

export interface StitchLayer extends LayerBase {
  readonly type: typeof LayerType.Stitch;
  kind: Uint8Array;
  colors: Uint16Array;
  /** Always zero and never persisted; it exists so command code runs unchanged on a layer surface. */
  completed: Uint8Array;
}

export interface SpecialtyLayer extends LayerBase {
  readonly type: typeof LayerType.Specialty;
  backstitches: BackstitchStore;
}

export type Layer = StitchLayer | SpecialtyLayer;

export interface LayeredDocument {
  readonly version: typeof LAYERED_DOCUMENT_VERSION;
  readonly catalog: CatalogAssociation;
  width: number;
  height: number;
  /** Bottom to top. Every stitch layer precedes every specialty layer. Canvas and reference image are not entries. */
  layers: Layer[];
  palette: PaletteEntry[];
  settings: PatternSettings;
  revision: number;
  /** Document-wide, so backstitch ids are unique across layers. It is never decremented. */
  nextBackstitchId: number;
  nextPaletteId: number;
  /** The next value allocated for a layer. It is never decremented. */
  nextLayerId: number;
  /** Workspace x of local cell (0,0); absent means 0. */
  originX?: number;
  /** Workspace y of local cell (0,0); absent means 0. */
  originY?: number;
  /**
   * Active cells of the box, one byte per cell (1 = active). Absent means the
   * whole box is active; a present mask is never all-ones and is never mutated.
   */
  canvasMask?: Uint8Array;
}

export interface CreateDocumentOptions {
  width: number;
  height: number;
  catalog: CatalogAssociation;
  palette?: Array<PaletteEntryInput | PaletteEntry>;
  settings?: Partial<PatternSettings>;
}

export type CropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Fields every command may carry. */
interface CommandBase {
  /** The layer a layer-scoped command edits in the layered editor. */
  readonly layerId?: number;
  /** Rejects the command as stale unless the document is at this revision. */
  readonly expectedRevision?: number;
}

export interface PatternFragmentBackstitches {
  readonly x1: Uint32Array;
  readonly y1: Uint32Array;
  readonly x2: Uint32Array;
  readonly y2: Uint32Array;
  readonly colors: Uint16Array;
}

/** A v1 clipboard fragment. Progress is deliberately not part of the type. */
export interface PatternFragment {
  readonly version: typeof PATTERN_FRAGMENT_VERSION;
  readonly width: number;
  readonly height: number;
  readonly kind: Uint8Array;
  readonly colors: Uint16Array;
  readonly backstitches: PatternFragmentBackstitches;
}

export interface RectangularFragmentSelection {
  readonly kind: 'rect';
  readonly rect: CropRect;
}

export interface SparseFragmentSelection {
  readonly kind: 'sparse';
  readonly rect: CropRect;
  /** Absolute document cell indices, sorted and unique. */
  readonly indices: Uint32Array;
}

/** A move/capture footprint. CropRect remains accepted as a rectangular shorthand. */
export type FragmentSelection = CropRect | RectangularFragmentSelection | SparseFragmentSelection;

export type BulkCellEdit =
  | { readonly kind: 'full'; readonly color: number }
  | { readonly kind: 'half'; readonly direction: HalfDirection; readonly color: number }
  | { readonly kind: 'three-quarter'; readonly corner: QuarterCorner; readonly color: number }
  | { readonly kind: 'quarter'; readonly corner: QuarterCorner; readonly color: number }
  | { readonly kind: 'erase-cell' }
  | { readonly kind: 'erase-quarter'; readonly corner: QuarterCorner };

export type BulkCellOperation = BulkCellEdit;
export type BulkCellIntent = BulkCellEdit;

/** The three atomic progress operations supported by bulk completion commands. */
export type BulkProgressOperation = 'set' | 'clear' | 'toggle';

/** One homogeneous edit over an ordered, duplicate-free cell index set. */
export interface BulkCellCommand extends CommandBase {
  readonly type: 'bulk-cell';
  readonly indices: Uint32Array;
  readonly edit: BulkCellEdit;
}

/** Recolor selected occupied cell components without changing geometry/progress. */
export interface BulkRecolorCommand extends CommandBase {
  readonly type: 'bulk-recolor';
  readonly indices: Uint32Array;
  /** One nonzero occupied-component mask per cell index. */
  readonly masks: Uint8Array;
  readonly fromColor: number;
  readonly toColor: number;
}

export interface BulkCompletionCommand extends CommandBase {
  readonly type: 'bulk-completion';
  readonly indices: Uint32Array;
  readonly operation: BulkProgressOperation;
  readonly corner?: QuarterCorner;
  /** Optional per-index physical completion masks, aligned with `indices`. */
  readonly masks?: Uint8Array;
}

export interface BulkBackstitchCompletionCommand extends CommandBase {
  readonly type: 'bulk-backstitch-completion';
  /** Stable backstitch IDs, not storage positions. */
  readonly ids: Uint32Array;
  readonly operation: BulkProgressOperation;
}

/** Explicit progress targets, separate from ordinary design mutations. */
export interface ProgressChangeSet {
  readonly cellIndices: Uint32Array;
  readonly backstitchIds: Uint32Array;
  /** Exact activity counts, when the command has progress semantics. */
  readonly marked: number;
  readonly unmarked: number;
}

export interface PasteFragmentCommand extends CommandBase {
  readonly type: 'paste-fragment';
  readonly fragment: PatternFragment;
  readonly destination: Point;
}

export interface MoveFragmentCommand extends CommandBase {
  readonly type: 'move-fragment';
  readonly selection: FragmentSelection;
  readonly destination: Point;
}

/** A single eraser gesture over whole cells and the quarter slots of three-quarter pairs. */
export interface MixedEraseCommand extends CommandBase {
  readonly type: 'mixed-erase';
  readonly wholeCellIndices: Uint32Array;
  /** Sorted lexicographically by (cell index, corner); pairs are unique. */
  readonly componentCellIndices: Uint32Array;
  readonly componentCorners: Uint8Array;
}

/** Clear all cell geometry in a half-open region and remove only contained lines. */
export interface DeleteRegionCommand extends CommandBase {
  readonly type: 'delete-region';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Clear an ordered, duplicate-free sparse set of cells atomically. */
export interface DeleteCellSetCommand extends CommandBase {
  readonly type: 'delete-cell-set';
  readonly indices: Uint32Array;
}

/** Per-edge change of a rectangular canvas: positive grows, negative shrinks. */
export interface CanvasEdges {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Grow or shrink a rectangular canvas edge by edge. */
export interface CanvasResizeCommand extends CommandBase {
  type: 'canvas-resize';
  edges: CanvasEdges;
}

/** Add or remove canvas cells; the rect is in local coordinates and may reach past the box. */
export interface CanvasCellsCommand extends CommandBase {
  type: 'canvas-cells';
  operation: 'add' | 'remove';
  rect: CropRect;
  /** Row-major 0/1 over `rect`; absent means the whole rect. */
  cells?: Uint8Array;
}

export interface LayerAddCommand extends CommandBase {
  readonly type: 'layer-add';
  readonly layerType: LayerType;
  readonly id?: number;
  readonly name?: string;
  /** Absolute insertion index in `layers`, clamped to the layer type's group. Defaults to the top of the group. */
  readonly index?: number;
}

export interface LayerDeleteCommand extends CommandBase {
  readonly type: 'layer-delete';
  readonly layerId: number;
}

export interface LayerMoveCommand extends CommandBase {
  readonly type: 'layer-move';
  readonly layerId: number;
  /** Absolute final index in `layers`, clamped to the layer's group. */
  readonly toIndex: number;
}

export interface LayerRenameCommand extends CommandBase {
  readonly type: 'layer-rename';
  readonly layerId: number;
  readonly name: string;
}

export interface LayerSetVisibilityCommand extends CommandBase {
  readonly type: 'layer-set-visibility';
  readonly layerId: number;
  readonly visible: boolean;
}

export interface LayerDuplicateCommand extends CommandBase {
  readonly type: 'layer-duplicate';
  readonly layerId: number;
}

export interface LayerMergeCommand extends CommandBase {
  readonly type: 'layer-merge';
  readonly sourceId: number;
  readonly targetId: number;
}

export type LayerStructureCommand =
  | LayerAddCommand
  | LayerDeleteCommand
  | LayerMoveCommand
  | LayerRenameCommand
  | LayerSetVisibilityCommand
  | LayerDuplicateCommand
  | LayerMergeCommand;

interface CellCommandBase extends CommandBase {
  readonly x: number;
  readonly y: number;
}

export interface SetFullCommand extends CellCommandBase {
  readonly type: 'set-full';
  readonly color: number;
}

export interface SetHalfCommand extends CellCommandBase {
  readonly type: 'set-half';
  readonly direction: HalfDirection;
  readonly color: number;
}

/** A zero color removes the quarter. */
export interface SetQuarterCommand extends CellCommandBase {
  readonly type: 'set-quarter';
  readonly corner: QuarterCorner;
  readonly color: number;
}

export interface SetQuartersCommand extends CellCommandBase {
  readonly type: 'set-quarters';
  /** Four physical slot colors; zero leaves a slot empty. */
  readonly colors: readonly number[];
}

export interface SetThreeQuarterCommand extends CellCommandBase {
  readonly type: 'set-three-quarter';
  readonly corner: QuarterCorner;
  readonly color: number;
}

export interface EraseCellCommand extends CellCommandBase {
  readonly type: 'erase-cell';
}

export interface EraseQuarterCommand extends CellCommandBase {
  readonly type: 'erase-quarter';
  readonly corner: QuarterCorner;
}

/** Recolors the occupied components of a cell, or only the one at `corner`. */
export interface RecolorCellCommand extends CellCommandBase {
  readonly type: 'recolor-cell';
  readonly color: number;
  readonly corner?: QuarterCorner;
}

/** Endpoints are fixed-point (cell x 4) and are snapped to valid backstitch points. */
export interface AddBackstitchCommand extends CommandBase {
  readonly type: 'add-backstitch';
  readonly start: Point;
  readonly end: Point;
  readonly color: number;
  /** The first ID to allocate; defaults to the document's next backstitch ID. */
  readonly id?: number;
}

export interface RemoveBackstitchCommand extends CommandBase {
  readonly type: 'remove-backstitch';
  readonly id: number;
}

/** Moves to new endpoints, or translates by `dx`/`dy` in fixed-point units. */
export interface MoveBackstitchCommand extends CommandBase {
  readonly type: 'move-backstitch';
  readonly id: number;
  readonly start?: Point;
  readonly end?: Point;
  readonly dx?: number;
  readonly dy?: number;
}

export interface RecolorBackstitchCommand extends CommandBase {
  readonly type: 'recolor-backstitch';
  readonly id: number;
  readonly color: number;
}

/** A recolor and a move in one step; the move's split pieces take the new color. */
export interface UpdateBackstitchCommand extends CommandBase {
  readonly type: 'update-backstitch';
  readonly id: number;
  readonly color?: number;
  readonly start?: Point;
  readonly end?: Point;
  readonly dx?: number;
  readonly dy?: number;
}

/** `id` defaults to the document's next palette ID. */
export interface PaletteCreateCommand extends CommandBase, PaletteEntryInput {
  readonly type: 'palette-create';
}

export interface PaletteUpdateCommand extends CommandBase {
  readonly type: 'palette-update';
  readonly id: number;
  readonly name?: string;
  readonly color?: string;
  readonly active?: boolean;
  readonly symbol?: string;
  readonly material?: PaletteMaterial;
  readonly catalog?: PaletteCatalogReference;
}

/** Exchanges the symbols of palette entries `a` and `b` atomically. */
export interface PaletteSwapCommand extends CommandBase {
  readonly type: 'palette-swap';
  readonly a: number;
  readonly b: number;
}

export interface PaletteDeactivateCommand extends CommandBase {
  readonly type: 'palette-deactivate';
  readonly id: number;
}

/** Recolors everything using `from` to `to`, then deactivates `from`. `createTo` creates `to` when it does not exist. */
export interface PaletteMergeCommand extends CommandBase {
  readonly type: 'palette-merge';
  readonly from: number;
  /** Defaults to the document's next palette ID, which `createTo` then allocates. */
  readonly to?: number;
  readonly createTo?: Omit<PaletteEntryInput, 'id' | 'active'>;
}

/** Removes every stitch using the palette entry, then deactivates it. */
export interface PaletteDeleteCommand extends CommandBase {
  readonly type: 'palette-delete';
  readonly id: number;
}

export interface DocumentSettingsUpdateCommand extends CommandBase {
  readonly type: 'document-settings-update';
  readonly settings: Partial<PatternSettings>;
}

/** Applies its children atomically as one undo step. */
export interface BatchCommand extends CommandBase {
  readonly type: 'batch';
  readonly commands: readonly DomainCommand[];
}

/**
 * Every command the domain runs, discriminated by its kebab-case `type`.
 * Shapes are checked by the compiler; the runner still validates every field's
 * value (bounds, integers, palette ids) before it changes a document.
 */
export type DomainCommand =
  | SetFullCommand
  | SetHalfCommand
  | SetQuarterCommand
  | SetQuartersCommand
  | SetThreeQuarterCommand
  | EraseCellCommand
  | EraseQuarterCommand
  | RecolorCellCommand
  | BulkCellCommand
  | BulkRecolorCommand
  | BulkCompletionCommand
  | BulkBackstitchCompletionCommand
  | PasteFragmentCommand
  | MoveFragmentCommand
  | MixedEraseCommand
  | DeleteRegionCommand
  | DeleteCellSetCommand
  | AddBackstitchCommand
  | RemoveBackstitchCommand
  | MoveBackstitchCommand
  | RecolorBackstitchCommand
  | UpdateBackstitchCommand
  | PaletteCreateCommand
  | PaletteUpdateCommand
  | PaletteSwapCommand
  | PaletteDeactivateCommand
  | PaletteMergeCommand
  | PaletteDeleteCommand
  | DocumentSettingsUpdateCommand
  | CanvasResizeCommand
  | CanvasCellsCommand
  | LayerStructureCommand
  | BatchCommand;

export type Command = DomainCommand;

export type DomainCommandType = DomainCommand['type'];

/**
 * Commands that are a complete gesture on their own, with a packed delta. They
 * run standalone or as the only child of a batch, never beside other commands.
 */
export const ATOMIC_COMMAND_TYPES = [
  'bulk-cell',
  'bulk-recolor',
  'bulk-completion',
  'bulk-backstitch-completion',
  'paste-fragment',
  'move-fragment',
  'mixed-erase',
  'delete-region',
  'delete-cell-set'
] as const satisfies readonly DomainCommandType[];

export type AtomicCommandType = (typeof ATOMIC_COMMAND_TYPES)[number];

export type AtomicCommand = Extract<DomainCommand, { readonly type: AtomicCommandType }>;

export interface CommandResult {
  document: PatternDocument;
  changed: boolean;
  revision: number;
  backstitchId?: number;
  paletteId?: number;
  /** Targets supplied by a bulk edit, including targets that were no-ops. */
  touchedIndices?: Uint32Array;
  /** Targets whose cell state actually changed. */
  changedIndices?: Uint32Array;
  /** Stable backstitch IDs supplied by a bulk progress edit. */
  touchedBackstitchIds?: Uint32Array;
  /** Stable backstitch IDs whose progress state actually changed. */
  changedBackstitchIds?: Uint32Array;
  /** Newly allocated backstitch IDs created by a fragment paste. */
  createdBackstitchIds?: Uint32Array;
  /** Stable backstitch IDs whose geometry moved with a fragment. */
  movedBackstitchIds?: Uint32Array;
  /** Completion targets changed by this operation; absent means legacy/unknown. */
  progress?: ProgressChangeSet;
  /** Signals that metrics should be rescanned because identities moved or were removed. */
  recalculateMetrics?: boolean;
  /** Signals that the base renderer must be invalidated in full for a history delta. */
  requiresFullRedraw?: boolean;
  /** Composite cells to redraw; absent with compositeFull means unknown. */
  compositeChangedIndices?: Uint32Array;
  /** The whole composite must be rebuilt/redrawn: structure, visibility, dimension or palette-wide changes. */
  compositeFull?: boolean;
  /** The visible composite did not change (for example a rename); no redraw or metrics rescan is needed. */
  compositeUnchanged?: boolean;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}
