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
export const DOCUMENT_SCHEMA_VERSION = 4 as const;
export const LEGACY_DOCUMENT_SCHEMA_VERSION = 1 as const;
export const PENULTIMATE_DOCUMENT_SCHEMA_VERSION = 2 as const;
export const PRIOR_DOCUMENT_SCHEMA_VERSION = 3 as const;
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
}

export const DEFAULT_PATTERN_SETTINGS: PatternSettings = {
  symbolSet: 'default',
  materialUnit: MaterialUnit.Skeins
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
}

export interface LegacyPatternDocument {
  readonly version: typeof LEGACY_DOCUMENT_SCHEMA_VERSION;
  width: number;
  height: number;
  kind: Uint8Array;
  colors: Uint16Array;
  completed: Uint8Array;
  backstitches: BackstitchStore;
  palette: Array<{
    readonly id: number;
    readonly name: string;
    readonly color: string;
    readonly active: boolean;
  }>;
  revision: number;
  nextBackstitchId: number;
  nextPaletteId: number;
}

export type Pattern = PatternDocument;

export interface CreateDocumentOptions {
  width: number;
  height: number;
  palette?: Array<PaletteEntryInput | PaletteEntry>;
  settings?: Partial<PatternSettings>;
}

export type CropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Commands intentionally have a small runtime envelope. Keeping the input
 * shape open lets importers and UI adapters use aliases while the command
 * runner still validates every field before changing a document.
 */
export interface DomainCommand {
  type: string;
  [key: string]: unknown;
}

export type Command = DomainCommand;

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

export type FragmentSelection = CropRect;

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
export interface BulkCellCommand extends DomainCommand {
  readonly type: 'bulk-cell';
  readonly indices: Uint32Array;
  readonly edit: BulkCellEdit;
  readonly expectedRevision?: number;
}

/** Recolor selected occupied cell components without changing geometry/progress. */
export interface BulkRecolorCommand extends DomainCommand {
  readonly type: 'bulk-recolor';
  readonly indices: Uint32Array;
  /** One nonzero occupied-component mask per cell index. */
  readonly masks: Uint8Array;
  readonly fromColor: number;
  readonly toColor: number;
  readonly expectedRevision?: number;
}

export interface BulkCompletionCommand extends DomainCommand {
  readonly type: 'bulk-completion';
  readonly indices: Uint32Array;
  /** `completed` is retained as a compatibility spelling for set/clear. */
  readonly completed?: boolean;
  readonly operation?: BulkProgressOperation;
  readonly corner?: QuarterCorner;
  /** Optional per-index physical completion masks, aligned with `indices`. */
  readonly masks?: Uint8Array;
  readonly expectedRevision?: number;
}

export interface BulkBackstitchCompletionCommand extends DomainCommand {
  readonly type: 'bulk-backstitch-completion';
  /** Stable backstitch IDs, not storage positions. */
  readonly ids: Uint32Array;
  /** `completed` is retained as a compatibility spelling for set/clear. */
  readonly completed?: boolean;
  readonly operation?: BulkProgressOperation;
  readonly expectedRevision?: number;
}

/** Explicit progress targets, separate from ordinary design mutations. */
export interface ProgressChangeSet {
  readonly cellIndices: Uint32Array;
  readonly backstitchIds: Uint32Array;
  /** Exact activity counts, when the command has progress semantics. */
  readonly marked: number;
  readonly unmarked: number;
}

export interface PasteFragmentCommand extends DomainCommand {
  readonly type: 'paste-fragment';
  readonly fragment: PatternFragment;
  readonly destination: Point;
  readonly expectedRevision?: number;
}

/** A single component-mode eraser gesture over whole cells and quarter slots. */
export interface MixedEraseCommand extends DomainCommand {
  readonly type: 'mixed-erase';
  readonly wholeCellIndices: Uint32Array;
  /** Sorted lexicographically by (cell index, corner); pairs are unique. */
  readonly componentCellIndices: Uint32Array;
  readonly componentCorners: Uint8Array;
  readonly expectedRevision?: number;
}

/** Clear all cell geometry in a half-open region and remove only contained lines. */
export interface DeleteRegionCommand extends DomainCommand {
  readonly type: 'delete-region';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly expectedRevision?: number;
}

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
  /** Completion targets changed by this operation; absent means legacy/unknown. */
  progress?: ProgressChangeSet;
  /** Signals that metrics should be rescanned because identities moved or were removed. */
  recalculateMetrics?: boolean;
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
