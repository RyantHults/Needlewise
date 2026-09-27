import { CellKind, DEFAULT_PATTERN_SETTINGS, type PatternDocument } from '../domain';
import type { CanvasTarget, RendererStyle } from '../editor/contracts';
import { MAX_ATLAS_PIXELS, restore, save } from './context';
import { drawPaletteSymbol, drawStitchGeometry } from './symbol-painter';
import { isLegacyQuarterKind, isThreeQuarterPairKind, threeQuarterPairComponents } from '../editor/cell-kinds';
import { symbolForPaletteId } from './symbols';

/** Document-owned Aida color, with the renderer's neutral default for legacy runtime documents. */
export function patternBackgroundColor(document: PatternDocument): string {
  const settings = (document as PatternDocument & { settings?: { backgroundColor?: string } }).settings;
  return settings?.backgroundColor ?? DEFAULT_PATTERN_SETTINGS.backgroundColor;
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

interface AtlasCacheEntry extends ColorAtlas {
  readonly documentWidth: number;
  readonly documentHeight: number;
  readonly kindPlane: PatternDocument['kind'];
  readonly colorsPlane: PatternDocument['colors'];
  readonly paletteIds: readonly number[];
  readonly paletteProjection: string;
  readonly mode: RendererStyle['mode'];
  readonly patternBackground: string;
  readonly missingColor: string;
}

function paletteColor(document: PatternDocument, id: number, missing: string): string {
  if (id === 0) return 'transparent';
  return document.palette.find((entry) => entry.id === id)?.color ?? missing;
}

/** Collect only palette IDs that can contribute pixels to either overview atlas. */
function paletteIdsUsedByAtlas(document: PatternDocument): readonly number[] {
  const ids = new Set<number>();
  const add = (id: number): void => {
    if (id !== 0) ids.add(id);
  };
  for (let index = 0; index < document.kind.length; index += 1) {
    const kind = document.kind[index];
    if (kind === CellKind.Empty) continue;
    const offset = index * 4;
    if (isLegacyQuarterKind(kind)) {
      for (let slot = 0; slot < 4; slot += 1) add(document.colors[offset + slot]);
    } else if (isThreeQuarterPairKind(kind)) {
      for (const component of threeQuarterPairComponents(document.colors.subarray(offset, offset + 4))) {
        add(document.colors[offset + component.slot]);
      }
    } else {
      add(document.colors[offset]);
    }
  }
  return Object.freeze([...ids].sort((left, right) => left - right));
}

/** Primitive visual metadata only; palette entry objects are never retained. */
function colorPaletteProjection(
  palette: PatternDocument['palette'],
  ids: readonly number[]
): string {
  return JSON.stringify(ids.map((id) => {
    const entry = palette.find((candidate) => candidate.id === id);
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
    const entry = palette.find((candidate) => candidate.id === id);
    // Combined mode uses the palette color to choose symbol ink. Symbol mode
    // uses the configured ink color, so palette color is not a visual input.
    return [
      id,
      symbolsAreVisual ? entry?.symbol ?? symbolForPaletteId(id) : null,
      symbolsAreVisual && mode === 'combined' ? entry?.color ?? null : null
    ];
  })) ?? '';
}

function parseRgb(color: string): readonly [number, number, number] | undefined {
  const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const digits = hex[1].length === 3
      ? hex[1].split('').map((digit) => `${digit}${digit}`).join('')
      : hex[1];
    return [
      Number.parseInt(digits.slice(0, 2), 16),
      Number.parseInt(digits.slice(2, 4), 16),
      Number.parseInt(digits.slice(4, 6), 16)
    ];
  }
  const rgb = color.trim().match(/^rgba?\(\s*([^,]+),\s*([^,]+),\s*([^,)]+)/i);
  if (!rgb) return undefined;
  const values = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return values.every((value) => Number.isFinite(value))
    ? [Math.round(values[0]), Math.round(values[1]), Math.round(values[2])]
    : undefined;
}

function rgbHex(red: number, green: number, blue: number): string {
  const channel = (value: number): string => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

function combinedSymbolHashGrey(id: number): string {
  // Combined mode uses a stable monochrome signal only when its source color
  // cannot be parsed. Symbol mode has a dedicated glyph atlas and never uses
  // this hash as a substitute for its actual palette symbol.
  let hash = (id * 2_654_435_761) >>> 0;
  hash ^= hash >>> 16;
  const value = 48 + (hash % 160);
  return rgbHex(value, value, value);
}

function combinedOverviewColor(color: string, id: number): string {
  const rgb = parseRgb(color);
  if (!rgb) return combinedSymbolHashGrey(id);
  const symbol = Number.parseInt(combinedSymbolHashGrey(id).slice(1, 3), 16);
  return rgbHex(rgb[0] * 0.8 + symbol * 0.2, rgb[1] * 0.8 + symbol * 0.2, rgb[2] * 0.8 + symbol * 0.2);
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
  if (style.mode === 'grayscale') {
    const rgb = parseRgb(color);
    if (!rgb) return '#808080';
    const value = Math.round(rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722);
    return rgbHex(value, value, value);
  }
  if (style.mode === 'combined') return combinedOverviewColor(color, id);
  return color;
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

/** Add palette IDs a set of cells uses to an atlas' known IDs; returns the same array when nothing is new. */
function paletteIdsWithCells(document: PatternDocument, known: readonly number[], cells: ReadonlySet<number>): readonly number[] {
  const ids = new Set(known);
  let grew = false;
  const add = (id: number): void => {
    if (id === 0 || ids.has(id)) return;
    ids.add(id);
    grew = true;
  };
  for (const index of cells) {
    const kind = document.kind[index];
    if (kind === CellKind.Empty) continue;
    const offset = index * 4;
    if (isLegacyQuarterKind(kind)) for (let slot = 0; slot < 4; slot += 1) add(document.colors[offset + slot]);
    else if (isThreeQuarterPairKind(kind)) for (const component of threeQuarterPairComponents(document.colors.subarray(offset, offset + 4))) add(document.colors[offset + component.slot]);
    else add(document.colors[offset]);
  }
  return grew ? Object.freeze([...ids].sort((left, right) => left - right)) : known;
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
  const offset = index * 4;
  const kind = document.kind[index];
  if (kind === CellKind.Empty) return;
  if (isLegacyQuarterKind(kind)) {
    const half = pixelsPerCell / 2;
    const colors = [
      [cellRect.x, cellRect.y, half, half, 0],
      [cellRect.x + half, cellRect.y, half, half, 1],
      [cellRect.x + half, cellRect.y + half, half, half, 2],
      [cellRect.x, cellRect.y + half, half, half, 3]
    ] as const;
    for (const [left, top, width, height, slot] of colors) {
      const color = document.colors[offset + slot];
      if (color === 0) continue;
      context.fillStyle = overviewColorForPaletteId(document, color, style);
      context.fillRect(left, top, width, height);
    }
  } else if (isThreeQuarterPairKind(kind)) {
    for (const component of threeQuarterPairComponents(document.colors.subarray(offset, offset + 4))) {
      const color = document.colors[offset + component.slot];
      if (color === 0) continue;
      context.fillStyle = overviewColorForPaletteId(document, color, style);
      drawStitchGeometry(context, component.kind, cellRect);
    }
  } else {
    const color = document.colors[offset];
    if (color === 0) return;
    context.fillStyle = overviewColorForPaletteId(document, color, style);
    if (kind === CellKind.Full) context.fillRect(cellRect.x, cellRect.y, cellRect.width, cellRect.height);
    else drawStitchGeometry(context, kind, cellRect);
  }
}

/** Reset one cell of an atlas to the pattern background before repainting it. */
function clearAtlasCell(context: CanvasTarget['context'], document: PatternDocument, index: number, pixelsPerCell: number, background: string): void {
  const x = (index % document.width) * pixelsPerCell;
  const y = Math.floor(index / document.width) * pixelsPerCell;
  context.clearRect(x, y, pixelsPerCell, pixelsPerCell);
  context.fillStyle = background;
  context.fillRect(x, y, pixelsPerCell, pixelsPerCell);
}

/**
 * A single cached bitmap-sized target for overview rendering. New planes with
 * known changed cells (`invalidate`) repaint only those cells; unknown changes,
 * palette projections or presentation colors rebuild. It never writes to the
 * document.
 */
export class ColorAtlasCache {
  private entry: (AtlasCacheEntry & { readonly target: CanvasTarget | undefined }) | undefined;
  private readonly dirty = new AtlasDirtyCells();

  clear(): void {
    this.entry = undefined;
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
  ): ColorAtlas {
    const current = this.entry;
    const patternBackground = patternBackgroundColor(document);
    const reusablePlanesAndStyle = Boolean(
      current &&
      current.documentWidth === document.width &&
      current.documentHeight === document.height &&
      current.kindPlane === document.kind &&
      current.colorsPlane === document.colors &&
      current.mode === style.mode &&
      current.patternBackground === patternBackground &&
      current.missingColor === style.missingPaletteColor
    );
    if (reusablePlanesAndStyle && current) {
      const paletteProjection = colorPaletteProjection(document.palette, current.paletteIds);
      if (paletteProjection === current.paletteProjection) {
        // Metadata-only changes replace the document and revision, but do not
        // change the overview pixels. Refresh the public metadata without
        // rerasterizing (or scanning the kind plane for atlas resolution).
        this.dirty.reset();
        this.entry = { ...current, revision: document.revision };
        return this.entry;
      }
    }
    const patched = this.patch(document, style, patternBackground);
    if (patched) return patched;

    const paletteIds = reusablePlanesAndStyle && current
      ? current.paletteIds
      : paletteIdsUsedByAtlas(document);
    const paletteProjection = colorPaletteProjection(document.palette, paletteIds);
    const pixelsPerCell = colorAtlasPixelsPerCell(document);

    const atlasWidth = pixelsPerCell > 0 ? document.width * pixelsPerCell : 0;
    const atlasHeight = pixelsPerCell > 0 ? document.height * pixelsPerCell : 0;
    const target = pixelsPerCell > 0 ? targetFactory?.(atlasWidth, atlasHeight) : undefined;
    const source = target && isCanvasImageSource(target.source) ? target.source : undefined;
    if (target) {
      const context = target.context;
      save(context);
      if (context.imageSmoothingEnabled !== undefined) context.imageSmoothingEnabled = false;
      context.clearRect(0, 0, atlasWidth, atlasHeight);
      context.fillStyle = patternBackground;
      context.fillRect(0, 0, atlasWidth, atlasHeight);
      const cellCount = document.width * document.height;
      for (let index = 0; index < cellCount; index += 1) paintColorAtlasCell(context, document, index, pixelsPerCell, style);
      restore(context);
    }
    this.dirty.reset();
    this.entry = {
      target,
      source,
      width: atlasWidth,
      height: atlasHeight,
      pixelsPerCell,
      revision: document.revision,
      documentWidth: document.width,
      documentHeight: document.height,
      kindPlane: document.kind,
      colorsPlane: document.colors,
      paletteIds,
      paletteProjection,
      mode: style.mode,
      patternBackground,
      missingColor: style.missingPaletteColor
    };
    return this.entry;
  }

  /** Repaint only the recorded cells onto the existing bitmap when everything else still matches. */
  private patch(document: PatternDocument, style: RendererStyle, patternBackground: string): ColorAtlas | undefined {
    const current = this.entry;
    const cells = this.dirty.pending;
    if (!current?.target || cells === 'all'
      || current.documentWidth !== document.width
      || current.documentHeight !== document.height
      || current.mode !== style.mode
      || current.patternBackground !== patternBackground
      || current.missingColor !== style.missingPaletteColor
      || colorPaletteProjection(document.palette, current.paletteIds) !== current.paletteProjection) return undefined;
    // A new pair cell needs the 2×2 footprint a one-pixel atlas cannot hold.
    if (current.pixelsPerCell === 1) for (const index of cells) if (isThreeQuarterPairKind(document.kind[index])) return undefined;
    const paletteIds = paletteIdsWithCells(document, current.paletteIds, cells);
    const context = current.target.context;
    save(context);
    if (context.imageSmoothingEnabled !== undefined) context.imageSmoothingEnabled = false;
    for (const index of cells) {
      // An opaque full stitch covers its whole cell, so only other cells need clearing first.
      if (document.kind[index] !== CellKind.Full || document.colors[index * 4] === 0) clearAtlasCell(context, document, index, current.pixelsPerCell, patternBackground);
      paintColorAtlasCell(context, document, index, current.pixelsPerCell, style);
    }
    restore(context);
    this.dirty.reset();
    this.entry = {
      ...current,
      revision: document.revision,
      kindPlane: document.kind,
      colorsPlane: document.colors,
      paletteIds,
      paletteProjection: paletteIds === current.paletteIds ? current.paletteProjection : colorPaletteProjection(document.palette, paletteIds)
    };
    return this.entry;
  }
}

export interface SymbolAtlas {
  /** Undefined means allocation or text painting was unavailable. */
  readonly source: CanvasImageSource | undefined;
  readonly width: number;
  readonly height: number;
  readonly revision: number;
  /** False when the source context could not paint actual glyphs. */
  readonly textAvailable: boolean;
}

interface SymbolAtlasCacheEntry extends SymbolAtlas {
  readonly documentWidth: number;
  readonly documentHeight: number;
  readonly kindPlane: PatternDocument['kind'];
  readonly colorsPlane: PatternDocument['colors'];
  readonly paletteIds: readonly number[];
  readonly paletteProjection: string;
  readonly mode: RendererStyle['mode'];
  readonly symbolFont: string;
  readonly symbolColor: string;
  readonly symbolBackgroundColor: string;
  readonly patternBackground: string;
  readonly missingColor: string;
  readonly showSymbols: boolean;
  readonly ppc: number;
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

/**
 * Cached high-resolution Symbol-mode overview source. It is intentionally
 * separate from ColorAtlasCache: text must be rasterized at several pixels
 * per cell, never into the one-pixel-per-cell color atlas.
 */
export class SymbolAtlasCache {
  private entry: (SymbolAtlasCacheEntry & { readonly target?: CanvasTarget }) | undefined;
  private readonly dirty = new AtlasDirtyCells();

  clear(): void {
    this.entry = undefined;
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
  ): SymbolAtlas {
    const ppc = symbolAtlasPixelsPerCell(document);
    const patternBackground = patternBackgroundColor(document);
    const current = this.entry;
    const reusablePlanesAndStyle = Boolean(
      current &&
      current.documentWidth === document.width &&
      current.documentHeight === document.height &&
      current.kindPlane === document.kind &&
      current.colorsPlane === document.colors &&
      current.mode === style.mode &&
      current.symbolFont === style.symbolFont &&
      current.symbolColor === style.symbolColor &&
      current.symbolBackgroundColor === style.symbolBackgroundColor &&
      current.patternBackground === patternBackground &&
      current.missingColor === style.missingPaletteColor &&
      current.showSymbols === style.showSymbols &&
      current.ppc === ppc
    );
    if (reusablePlanesAndStyle && current) {
      const paletteProjection = symbolPaletteProjection(document.palette, current.paletteIds, style.mode, style.showSymbols);
      if (paletteProjection === current.paletteProjection) {
        this.dirty.reset();
        this.entry = { ...current, revision: document.revision };
        return this.entry;
      }
    }
    const patched = this.patch(document, style, patternBackground, ppc);
    if (patched) return patched;

    const paletteIds = reusablePlanesAndStyle && current
      ? current.paletteIds
      : paletteIdsUsedByAtlas(document);
    const paletteProjection = symbolPaletteProjection(document.palette, paletteIds, style.mode, style.showSymbols);
    const dimensions = symbolAtlasDimensions(document, ppc);
    if (!dimensions || !targetFactory) {
      const unavailable: SymbolAtlasCacheEntry = {
        source: undefined,
        width: dimensions?.width ?? 0,
        height: dimensions?.height ?? 0,
        revision: document.revision,
        documentWidth: document.width,
        documentHeight: document.height,
        kindPlane: document.kind,
        colorsPlane: document.colors,
        paletteIds,
        paletteProjection,
        mode: style.mode,
        symbolFont: style.symbolFont,
        symbolColor: style.symbolColor,
        symbolBackgroundColor: style.symbolBackgroundColor,
        patternBackground,
        missingColor: style.missingPaletteColor,
        showSymbols: style.showSymbols,
        ppc,
        textAvailable: false
      };
      this.entry = unavailable;
      return unavailable;
    }

    let target: CanvasTarget | undefined;
    let source: CanvasImageSource | undefined;
    let textAvailable = !style.showSymbols;
    try {
      target = targetFactory(dimensions.width, dimensions.height);
      source = target && isCanvasImageSource(target.source) ? target.source : undefined;
      if (target) {
        const context = target.context;
        save(context);
        context.clearRect(0, 0, dimensions.width, dimensions.height);
        context.fillStyle = patternBackground;
        context.fillRect(0, 0, dimensions.width, dimensions.height);
        textAvailable = !style.showSymbols || typeof context.fillText === 'function';
        const cellCount = document.width * document.height;
        for (let index = 0; index < cellCount; index += 1) {
          if (!paintSymbolAtlasCell(context, document, index, ppc, style)) textAvailable = false;
        }
        restore(context);
      }
    } catch {
      // Allocation and canvas text APIs are optional in workers, jsdom, and
      // restricted browsers. The renderer will fall back to visible cells.
      source = undefined;
      textAvailable = false;
      if (target) {
        try { restore(target.context); } catch { /* already failed softly */ }
      }
    }
    this.dirty.reset();
    const result: SymbolAtlasCacheEntry & { readonly target?: CanvasTarget } = {
      ...(source && target ? { target } : {}),
      source,
      width: dimensions.width,
      height: dimensions.height,
      revision: document.revision,
      documentWidth: document.width,
      documentHeight: document.height,
      kindPlane: document.kind,
      colorsPlane: document.colors,
      paletteIds,
      paletteProjection,
      mode: style.mode,
      symbolFont: style.symbolFont,
      symbolColor: style.symbolColor,
      symbolBackgroundColor: style.symbolBackgroundColor,
      patternBackground,
      missingColor: style.missingPaletteColor,
      showSymbols: style.showSymbols,
      ppc,
      textAvailable
    };
    this.entry = result;
    return result;
  }

  /** Repaint only the recorded cells onto the existing bitmap when everything else still matches. */
  private patch(document: PatternDocument, style: RendererStyle, patternBackground: string, ppc: number): SymbolAtlas | undefined {
    const current = this.entry;
    const cells = this.dirty.pending;
    if (!current?.target || !current.textAvailable || cells === 'all'
      || current.documentWidth !== document.width
      || current.documentHeight !== document.height
      || current.mode !== style.mode
      || current.symbolFont !== style.symbolFont
      || current.symbolColor !== style.symbolColor
      || current.symbolBackgroundColor !== style.symbolBackgroundColor
      || current.patternBackground !== patternBackground
      || current.missingColor !== style.missingPaletteColor
      || current.showSymbols !== style.showSymbols
      || current.ppc !== ppc
      || symbolPaletteProjection(document.palette, current.paletteIds, style.mode, style.showSymbols) !== current.paletteProjection) return undefined;
    const paletteIds = paletteIdsWithCells(document, current.paletteIds, cells);
    const context = current.target.context;
    let textAvailable = true;
    try {
      save(context);
      for (const index of cells) {
        clearAtlasCell(context, document, index, ppc, patternBackground);
        if (!paintSymbolAtlasCell(context, document, index, ppc, style)) textAvailable = false;
      }
      restore(context);
    } catch {
      try { restore(context); } catch { /* already failed softly */ }
      return undefined;
    }
    this.dirty.reset();
    this.entry = {
      ...current,
      revision: document.revision,
      kindPlane: document.kind,
      colorsPlane: document.colors,
      paletteIds,
      paletteProjection: paletteIds === current.paletteIds ? current.paletteProjection : symbolPaletteProjection(document.palette, paletteIds, style.mode, style.showSymbols),
      textAvailable
    };
    return this.entry;
  }
}

/** Paint one cell's geometry and symbols; false when a glyph could not be drawn. */
function paintSymbolAtlasCell(
  context: CanvasTarget['context'],
  document: PatternDocument,
  index: number,
  ppc: number,
  style: RendererStyle
): boolean {
  const kind = document.kind[index];
  if (kind === CellKind.Empty) return true;
  const offset = index * 4;
  const rect = { x: (index % document.width) * ppc, y: Math.floor(index / document.width) * ppc, width: ppc, height: ppc };
  let textAvailable = true;
  const paint = (id: number, slot?: number, geometryKind = kind): void => {
    context.fillStyle = style.symbolBackgroundColor;
    drawStitchGeometry(context, geometryKind, rect, slot);
    if (style.showSymbols) {
      try {
        if (!drawPaletteSymbol(context, document, id, rect, style, slot)) textAvailable = false;
      } catch {
        // Keep the geometry source usable, but let the renderer use
        // its direct glyph fallback when text painting is broken.
        textAvailable = false;
      }
    }
  };
  if (isLegacyQuarterKind(kind)) {
    for (let slot = 0; slot < 4; slot += 1) {
      const id = document.colors[offset + slot];
      if (id !== 0) paint(id, slot);
    }
  } else if (isThreeQuarterPairKind(kind)) {
    for (const component of threeQuarterPairComponents(document.colors.subarray(offset, offset + 4))) {
      const id = document.colors[offset + component.slot];
      if (id !== 0) paint(id, component.slot, component.kind);
    }
  } else {
    paint(document.colors[offset], undefined);
  }
  return textAvailable;
}
