import { CellKind, componentKind, componentSlotMask, defaultPaletteSymbol, forEachActiveRun, isLegacyQuarterKind, isThreeQuarterPairKind, paletteIdsInCells, type PatternDocument } from '../domain';
import type { CanvasTarget, Rect, RendererStyle } from '../editor/contracts';
import { MAX_ATLAS_PIXELS, restore, save } from './context';
import { grayscaleColor, paletteColor, paletteEntry } from './colors';
import { drawPaletteSymbol, drawStitchGeometry } from './symbol-painter';

/** Document-owned Aida color. */
export function patternBackgroundColor(document: PatternDocument): string {
  return document.settings.backgroundColor;
}

export interface ColorAtlas {
  /** Undefined means the environment cannot provide a CanvasImageSource. */
  readonly source: CanvasImageSource | undefined;
  readonly width: number;
  readonly height: number;
  /** Source pixels represented by one logical cell. */
  readonly pixelsPerCell: number;
  readonly revision: number;
}

const NO_PALETTE_IDS: readonly number[] = Object.freeze([]);

/** Primitive visual metadata only; palette entry objects are never retained. */
function colorPaletteProjection(
  palette: PatternDocument['palette'],
  ids: readonly number[]
): string {
  return JSON.stringify(ids.map((id) => {
    const entry = paletteEntry(palette, id);
    return [id, entry?.color ?? null];
  })) ?? '';
}

function symbolPaletteProjection(
  palette: PatternDocument['palette'],
  ids: readonly number[],
  mode: RendererStyle['mode'],
  showSymbols: boolean
): string {
  const symbolsAreVisual = showSymbols && (mode === 'symbol' || mode === 'combined');
  return JSON.stringify(ids.map((id) => {
    const entry = paletteEntry(palette, id);
    // Combined mode uses the palette color to choose symbol ink. Symbol mode
    // uses the configured ink color, so palette color is not a visual input.
    return [
      id,
      symbolsAreVisual ? entry?.symbol ?? defaultPaletteSymbol(id) : null,
      symbolsAreVisual && mode === 'combined' ? entry?.color ?? null : null
    ];
  })) ?? '';
}

const COLOR_ATLAS_MAX_DIMENSION = 32_767;

/** Pair cells need a 2×2 source footprint so their two colors survive rasterization. */
export function colorAtlasPixelsPerCell(document: PatternDocument): number {
  let hasPair = false;
  for (const kind of document.kind) {
    if (isThreeQuarterPairKind(kind)) {
      hasPair = true;
      break;
    }
  }
  if (!hasPair) return 1;
  const width = document.width * 2;
  const height = document.height * 2;
  const pixels = width * height;
  return Number.isSafeInteger(width)
    && Number.isSafeInteger(height)
    && Number.isSafeInteger(pixels)
    && width <= COLOR_ATLAS_MAX_DIMENSION
    && height <= COLOR_ATLAS_MAX_DIMENSION
    && pixels <= MAX_ATLAS_PIXELS
    ? 2
    : 0;
}

export function overviewColorForPaletteId(
  document: PatternDocument,
  id: number,
  style: RendererStyle
): string {
  const color = paletteColor(document, id, style.missingPaletteColor);
  return style.mode === 'grayscale' ? grayscaleColor(color) : color;
}

/** Reject cache bookkeeping objects before they reach CanvasRenderingContext2D.drawImage. */
export function isCanvasImageSource(value: unknown): value is CanvasImageSource {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
  const candidate = value as { getContext?: unknown; width?: unknown; height?: unknown; close?: unknown };
  if (typeof candidate.getContext === 'function') return true;
  if (typeof HTMLImageElement !== 'undefined' && value instanceof HTMLImageElement) return true;
  if (typeof HTMLVideoElement !== 'undefined' && value instanceof HTMLVideoElement) return true;
  if (typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap) return true;
  if (typeof VideoFrame !== 'undefined' && value instanceof VideoFrame) return true;
  // ImageBitmap and VideoFrame are image sources but do not expose getContext.
  return typeof candidate.width === 'number' && typeof candidate.height === 'number' && typeof candidate.close === 'function';
}

/** Above this share of changed cells, repainting cell by cell costs more than a rebuild. */
const MAX_PATCH_FRACTION = 0.5;

/**
 * Cells changed since an atlas was last painted. `all` means unknown, so the
 * next plane change rebuilds; a set lets the atlas repaint only those cells.
 */
class AtlasDirtyCells {
  private cells: Set<number> | 'all' = new Set();

  /** Record changed cells; undefined means every cell may have changed. */
  mark(cells: ArrayLike<number> | undefined, cellCount: number): void {
    if (this.cells === 'all') return;
    if (cells === undefined || this.cells.size + cells.length > cellCount * MAX_PATCH_FRACTION) {
      this.cells = 'all';
      return;
    }
    for (let position = 0; position < cells.length; position += 1) this.cells.add(cells[position]);
    if (this.cells.size > cellCount * MAX_PATCH_FRACTION) this.cells = 'all';
  }

  get pending(): ReadonlySet<number> | 'all' {
    return this.cells;
  }

  reset(): void {
    this.cells = new Set();
  }
}

function paintColorAtlasCell(
  context: CanvasTarget['context'],
  document: PatternDocument,
  index: number,
  pixelsPerCell: number,
  style: RendererStyle
): void {
  const x = index % document.width;
  const y = Math.floor(index / document.width);
  const cellRect = { x: x * pixelsPerCell, y: y * pixelsPerCell, width: pixelsPerCell, height: pixelsPerCell };
  paintOverviewCell(context, document.kind[index], document.colors, index * 4, cellRect, (id) => {
    context.fillStyle = overviewColorForPaletteId(document, id, style);
  });
}

/**
 * Paint one cell's stitches as flat shapes, skipping components with no color.
 * `setFill` readies the context's fill for a palette id before each shape.
 */
export function paintOverviewCell(
  context: CanvasTarget['context'],
  kind: number,
  colors: ArrayLike<number>,
  offset: number,
  rect: Rect,
  setFill: (id: number) => void
): void {
  if (kind === CellKind.Empty) return;
  if (isLegacyQuarterKind(kind) || isThreeQuarterPairKind(kind)) {
    const mask = componentSlotMask(kind, colors, offset);
    for (let slot = 0; slot < 4; slot += 1) {
      if ((mask & (1 << slot)) === 0) continue;
      setFill(colors[offset + slot]);
      drawStitchGeometry(context, componentKind(kind, slot), rect, slot);
    }
    return;
  }
  const id = colors[offset];
  if (id === 0) return;
  setFill(id);
  if (kind === CellKind.Full) context.fillRect(rect.x, rect.y, rect.width, rect.height);
  else drawStitchGeometry(context, kind, rect);
}

/** Reset one cell of an atlas to the pattern background (a hole stays transparent) before repainting it. */
function clearAtlasCell(context: CanvasTarget['context'], document: PatternDocument, index: number, pixelsPerCell: number, background: string): void {
  const x = (index % document.width) * pixelsPerCell;
  const y = Math.floor(index / document.width) * pixelsPerCell;
  context.clearRect(x, y, pixelsPerCell, pixelsPerCell);
  if (document.canvasMask !== undefined && document.canvasMask[index] !== 1) return;
  context.fillStyle = background;
  context.fillRect(x, y, pixelsPerCell, pixelsPerCell);
}

/**
 * Paint the fabric over a freshly cleared atlas. A full rectangle is one fill;
 * a masked canvas fills runs of active cells, leaving holes transparent so
 * the renderer's off-canvas color shows through.
 */
function fillAtlasFabric(context: CanvasTarget['context'], document: PatternDocument, pixelsPerCell: number, background: string): void {
  context.fillStyle = background;
  const mask = document.canvasMask;
  if (mask === undefined) {
    context.fillRect(0, 0, document.width * pixelsPerCell, document.height * pixelsPerCell);
    return;
  }
  for (let y = 0; y < document.height; y += 1) {
    forEachActiveRun(mask, document.width, y, 0, document.width, (from, to) => {
      context.fillRect(from * pixelsPerCell, y * pixelsPerCell, (to - from) * pixelsPerCell, pixelsPerCell);
    });
  }
}

/** One atlas's cached state: what it was painted for, from which planes, and the result. */
interface AtlasState<Key, Atlas> {
  /** Everything but the planes and palette that, when it changes, forces a rebuild. */
  readonly key: Key;
  readonly kindPlane: PatternDocument['kind'];
  readonly colorsPlane: PatternDocument['colors'];
  readonly paletteIds: readonly number[];
  readonly paletteProjection: string;
  readonly atlas: Atlas;
  /** The bitmap later patches paint onto; undefined when it cannot be patched. */
  readonly target: CanvasTarget | undefined;
}

/** What differs between the overview atlases; the cache flow around it is shared. */
interface AtlasStrategy<Key, Atlas extends { readonly revision: number }> {
  keyFor(document: PatternDocument, style: RendererStyle): Key;
  /** Primitive palette metadata that reaches the atlas pixels for these ids. */
  projection(palette: PatternDocument['palette'], ids: readonly number[], style: RendererStyle): string;
  /** Allocate a target and paint every cell. */
  allocate(
    document: PatternDocument,
    style: RendererStyle,
    key: Key,
    targetFactory: ((width: number, height: number) => CanvasTarget | undefined) | undefined
  ): { atlas: Omit<Atlas, 'revision'>; target: CanvasTarget | undefined };
  /** Repaint `cells` onto the kept target; false declines the patch, so the atlas is rebuilt. */
  paintCells(target: CanvasTarget, document: PatternDocument, style: RendererStyle, key: Key, atlas: Atlas, cells: ReadonlySet<number>): boolean;
}

/** Atlas keys hold primitives and plane references only, so field identity is equality. */
function keysEqual<Key extends object>(a: Key, b: Key): boolean {
  for (const field of Object.keys(a) as (keyof Key)[]) if (a[field] !== b[field]) return false;
  return true;
}

/**
 * A single cached bitmap-sized target for overview rendering. New planes with
 * known changed cells (`invalidate`) repaint only those cells; unknown changes,
 * palette projections or a changed key rebuild. It never writes to the
 * document.
 */
class AtlasCache<Key extends object, Atlas extends { readonly revision: number }> {
  private state: AtlasState<Key, Atlas> | undefined;
  private readonly dirty = new AtlasDirtyCells();

  constructor(private readonly strategy: AtlasStrategy<Key, Atlas>) {}

  clear(): void {
    this.state = undefined;
    this.dirty.reset();
  }

  /** Record document cells that changed since the last paint; undefined means unknown. */
  invalidate(cells: ArrayLike<number> | undefined, cellCount: number): void {
    this.dirty.mark(cells, cellCount);
  }

  get(
    document: PatternDocument,
    style: RendererStyle,
    targetFactory?: (width: number, height: number) => CanvasTarget | undefined
  ): Atlas {
    const strategy = this.strategy;
    const key = strategy.keyFor(document, style);
    const current = this.state && keysEqual(this.state.key, key) ? this.state : undefined;
    const samePlanes = current?.kindPlane === document.kind && current.colorsPlane === document.colors;
    if (samePlanes && strategy.projection(document.palette, current.paletteIds, style) === current.paletteProjection) {
      // Metadata-only changes replace the document and revision, but do not
      // change the atlas pixels. Refresh the public metadata without
      // rerasterizing (or scanning the kind plane for atlas resolution).
      this.dirty.reset();
      this.state = { ...current, atlas: { ...current.atlas, revision: document.revision } };
      return this.state.atlas;
    }
    const patched = current && this.patch(current, document, style);
    if (patched) return patched;

    const paletteIds = samePlanes ? current.paletteIds : paletteIdsInCells(document, NO_PALETTE_IDS);
    const { atlas, target } = strategy.allocate(document, style, key, targetFactory);
    this.dirty.reset();
    this.state = {
      key,
      kindPlane: document.kind,
      colorsPlane: document.colors,
      paletteIds,
      paletteProjection: strategy.projection(document.palette, paletteIds, style),
      atlas: { ...atlas, revision: document.revision } as Atlas,
      target
    };
    return this.state.atlas;
  }

  /** Repaint only the recorded cells onto the existing bitmap when everything else still matches. */
  private patch(current: AtlasState<Key, Atlas>, document: PatternDocument, style: RendererStyle): Atlas | undefined {
    const strategy = this.strategy;
    const cells = this.dirty.pending;
    if (!current.target || cells === 'all'
      || strategy.projection(document.palette, current.paletteIds, style) !== current.paletteProjection) return undefined;
    if (!strategy.paintCells(current.target, document, style, current.key, current.atlas, cells)) return undefined;
    const paletteIds = paletteIdsInCells(document, current.paletteIds, cells);
    this.dirty.reset();
    this.state = {
      ...current,
      kindPlane: document.kind,
      colorsPlane: document.colors,
      paletteIds,
      paletteProjection: paletteIds === current.paletteIds ? current.paletteProjection : strategy.projection(document.palette, paletteIds, style),
      atlas: { ...current.atlas, revision: document.revision }
    };
    return this.state.atlas;
  }
}

interface ColorAtlasKey {
  readonly documentWidth: number;
  readonly documentHeight: number;
  readonly mode: RendererStyle['mode'];
  readonly patternBackground: string;
  readonly missingColor: string;
  readonly canvasMask: PatternDocument['canvasMask'];
}

const colorAtlasStrategy: AtlasStrategy<ColorAtlasKey, ColorAtlas> = {
  keyFor: (document, style) => ({
    documentWidth: document.width,
    documentHeight: document.height,
    mode: style.mode,
    patternBackground: patternBackgroundColor(document),
    missingColor: style.missingPaletteColor,
    canvasMask: document.canvasMask
  }),
  projection: (palette, ids) => colorPaletteProjection(palette, ids),
  allocate(document, style, key, targetFactory) {
    const pixelsPerCell = colorAtlasPixelsPerCell(document);
    const width = pixelsPerCell > 0 ? document.width * pixelsPerCell : 0;
    const height = pixelsPerCell > 0 ? document.height * pixelsPerCell : 0;
    const target = pixelsPerCell > 0 ? targetFactory?.(width, height) : undefined;
    const source = target && isCanvasImageSource(target.source) ? target.source : undefined;
    if (target) {
      const context = target.context;
      save(context);
      if (context.imageSmoothingEnabled !== undefined) context.imageSmoothingEnabled = false;
      context.clearRect(0, 0, width, height);
      fillAtlasFabric(context, document, pixelsPerCell, key.patternBackground);
      const cellCount = document.width * document.height;
      for (let index = 0; index < cellCount; index += 1) paintColorAtlasCell(context, document, index, pixelsPerCell, style);
      restore(context);
    }
    return { atlas: { source, width, height, pixelsPerCell }, target };
  },
  paintCells(target, document, style, key, atlas, cells) {
    // A new pair cell needs the 2×2 footprint a one-pixel atlas cannot hold.
    if (atlas.pixelsPerCell === 1) for (const index of cells) if (isThreeQuarterPairKind(document.kind[index])) return false;
    const context = target.context;
    save(context);
    if (context.imageSmoothingEnabled !== undefined) context.imageSmoothingEnabled = false;
    for (const index of cells) {
      // An opaque full stitch covers its whole cell, so only other cells need clearing first.
      if (document.kind[index] !== CellKind.Full || document.colors[index * 4] === 0) clearAtlasCell(context, document, index, atlas.pixelsPerCell, key.patternBackground);
      paintColorAtlasCell(context, document, index, atlas.pixelsPerCell, style);
    }
    restore(context);
    return true;
  }
};

export class ColorAtlasCache extends AtlasCache<ColorAtlasKey, ColorAtlas> {
  constructor() {
    super(colorAtlasStrategy);
  }
}

export interface SymbolAtlas {
  /** Undefined means allocation or painting was unavailable. */
  readonly source: CanvasImageSource | undefined;
  readonly width: number;
  readonly height: number;
  readonly revision: number;
}

const MAX_SAFE_CANVAS_DIMENSION = 32_767;

/** Select a bounded source resolution without exceeding the atlas pixel budget. */
export function symbolAtlasPixelsPerCell(document: PatternDocument): number {
  const cells = document.width * document.height;
  if (!Number.isSafeInteger(cells) || cells < 1) return 1;
  const budgeted = Math.floor(Math.sqrt(MAX_ATLAS_PIXELS / cells));
  return Math.max(1, Math.min(8, budgeted));
}

function symbolAtlasDimensions(
  document: PatternDocument,
  ppc: number
): { width: number; height: number } | undefined {
  const width = document.width * ppc;
  const height = document.height * ppc;
  const pixels = width * height;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    !Number.isSafeInteger(pixels) ||
    width < 1 ||
    height < 1 ||
    width > MAX_SAFE_CANVAS_DIMENSION ||
    height > MAX_SAFE_CANVAS_DIMENSION ||
    pixels > MAX_ATLAS_PIXELS
  ) return undefined;
  return { width, height };
}

interface SymbolAtlasKey extends ColorAtlasKey {
  readonly symbolColor: string;
  readonly symbolBackgroundColor: string;
  readonly showSymbols: boolean;
  readonly ppc: number;
}

const symbolAtlasStrategy: AtlasStrategy<SymbolAtlasKey, SymbolAtlas> = {
  keyFor: (document, style) => ({
    ...colorAtlasStrategy.keyFor(document, style),
    symbolColor: style.symbolColor,
    symbolBackgroundColor: style.symbolBackgroundColor,
    showSymbols: style.showSymbols,
    ppc: symbolAtlasPixelsPerCell(document)
  }),
  projection: (palette, ids, style) => symbolPaletteProjection(palette, ids, style.mode, style.showSymbols),
  allocate(document, style, key, targetFactory) {
    const dimensions = symbolAtlasDimensions(document, key.ppc);
    if (!dimensions || !targetFactory) {
      return { atlas: { source: undefined, width: dimensions?.width ?? 0, height: dimensions?.height ?? 0 }, target: undefined };
    }
    let target: CanvasTarget | undefined;
    let source: CanvasImageSource | undefined;
    try {
      target = targetFactory(dimensions.width, dimensions.height);
      source = target && isCanvasImageSource(target.source) ? target.source : undefined;
      if (target) {
        const context = target.context;
        save(context);
        context.clearRect(0, 0, dimensions.width, dimensions.height);
        fillAtlasFabric(context, document, key.ppc, key.patternBackground);
        const cellCount = document.width * document.height;
        for (let index = 0; index < cellCount; index += 1) {
          paintSymbolAtlasCell(context, document, index, key.ppc, style);
        }
        restore(context);
      }
    } catch {
      // Allocation and canvas APIs are optional in workers, jsdom, and
      // restricted browsers. The renderer will fall back to visible cells.
      source = undefined;
      if (target) {
        try { restore(target.context); } catch { /* already failed softly */ }
      }
    }
    return { atlas: { source, width: dimensions.width, height: dimensions.height }, target: source ? target : undefined };
  },
  paintCells(target, document, style, key, _atlas, cells) {
    const context = target.context;
    try {
      save(context);
      for (const index of cells) {
        clearAtlasCell(context, document, index, key.ppc, key.patternBackground);
        paintSymbolAtlasCell(context, document, index, key.ppc, style);
      }
      restore(context);
    } catch {
      try { restore(context); } catch { /* already failed softly */ }
      return false;
    }
    return true;
  }
};

/**
 * Cached high-resolution Symbol-mode overview source. It is intentionally
 * separate from ColorAtlasCache: text must be rasterized at several pixels
 * per cell, never into the one-pixel-per-cell color atlas.
 */
export class SymbolAtlasCache extends AtlasCache<SymbolAtlasKey, SymbolAtlas> {
  constructor() {
    super(symbolAtlasStrategy);
  }
}

/** Paint one cell's geometry and symbols. */
function paintSymbolAtlasCell(
  context: CanvasTarget['context'],
  document: PatternDocument,
  index: number,
  ppc: number,
  style: RendererStyle
): void {
  const kind = document.kind[index];
  if (kind === CellKind.Empty) return;
  const offset = index * 4;
  const rect = { x: (index % document.width) * ppc, y: Math.floor(index / document.width) * ppc, width: ppc, height: ppc };
  const paint = (id: number, slot?: number, geometryKind = kind): void => {
    context.fillStyle = style.symbolBackgroundColor;
    drawStitchGeometry(context, geometryKind, rect, slot);
    if (style.showSymbols) drawPaletteSymbol(context, document, id, rect, style, slot);
  };
  if (isLegacyQuarterKind(kind) || isThreeQuarterPairKind(kind)) {
    const mask = componentSlotMask(kind, document.colors, offset);
    for (let slot = 0; slot < 4; slot += 1) {
      if ((mask & (1 << slot)) !== 0) paint(document.colors[offset + slot], slot, componentKind(kind, slot));
    }
  } else {
    paint(document.colors[offset], undefined);
  }
}
