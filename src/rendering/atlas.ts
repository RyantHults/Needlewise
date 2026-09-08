import { CellKind, type PatternDocument } from '../domain';
import type { CanvasTarget, RendererStyle } from '../editor/contracts';
import { MAX_ATLAS_PIXELS, restore, save } from './context';
import { drawPaletteSymbol, drawStitchGeometry } from './symbol-painter';

export interface ColorAtlas {
  /** Undefined means the environment cannot provide a CanvasImageSource. */
  readonly source: CanvasImageSource | undefined;
  readonly width: number;
  readonly height: number;
  readonly revision: number;
}

interface AtlasCacheEntry extends ColorAtlas {
  readonly document: PatternDocument;
  readonly mode: RendererStyle['mode'];
  readonly background: string;
  readonly missingColor: string;
}

function paletteColor(document: PatternDocument, id: number, missing: string): string {
  if (id === 0) return 'transparent';
  return document.palette.find((entry) => entry.id === id)?.color ?? missing;
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

/**
 * A single cached bitmap-sized target for overview rendering. The cache is
 * invalidated by document identity/revision or presentation colors; it never
 * writes to the document.
 */
export class ColorAtlasCache {
  private entry: AtlasCacheEntry | undefined;

  clear(): void {
    this.entry = undefined;
  }

  get(
    document: PatternDocument,
    style: RendererStyle,
    targetFactory?: (width: number, height: number) => CanvasTarget | undefined
  ): ColorAtlas {
    const current = this.entry;
    if (
      current &&
      current.document === document &&
      current.revision === document.revision &&
      current.mode === style.mode &&
      current.background === style.backgroundColor &&
      current.missingColor === style.missingPaletteColor
    ) return current;

    const target = targetFactory?.(document.width, document.height);
    const source = target && isCanvasImageSource(target.source) ? target.source : undefined;
    if (target) {
      const context = target.context;
      save(context);
      if (context.imageSmoothingEnabled !== undefined) context.imageSmoothingEnabled = false;
      context.clearRect(0, 0, document.width, document.height);
      for (let y = 0; y < document.height; y += 1) {
        for (let x = 0; x < document.width; x += 1) {
          const index = y * document.width + x;
          const offset = index * 4;
          const kind = document.kind[index];
          if (kind === CellKind.Empty) continue;
          if (kind === CellKind.Quarters) {
            const half = 0.5;
            const colors = [
              [x, y, half, half, 0],
              [x + half, y, half, half, 1],
              [x + half, y + half, half, half, 2],
              [x, y + half, half, half, 3]
            ] as const;
            for (const [left, top, width, height, slot] of colors) {
              const color = document.colors[offset + slot];
              if (color === 0) continue;
              context.fillStyle = overviewColorForPaletteId(document, color, style);
              context.fillRect(left, top, width, height);
            }
          } else {
            const color = document.colors[offset];
            if (color === 0) continue;
            context.fillStyle = overviewColorForPaletteId(document, color, style);
            context.fillRect(x, y, 1, 1);
          }
        }
      }
      restore(context);
    }
    this.entry = {
      source,
      width: document.width,
      height: document.height,
      revision: document.revision,
      document,
      mode: style.mode,
      background: style.backgroundColor,
      missingColor: style.missingPaletteColor
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
  readonly document: PatternDocument;
  readonly documentWidth: number;
  readonly documentHeight: number;
  readonly symbolFont: string;
  readonly symbolColor: string;
  readonly symbolBackgroundColor: string;
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
  private entry: SymbolAtlasCacheEntry | undefined;

  clear(): void {
    this.entry = undefined;
  }

  get(
    document: PatternDocument,
    style: RendererStyle,
    targetFactory?: (width: number, height: number) => CanvasTarget | undefined
  ): SymbolAtlas {
    const ppc = symbolAtlasPixelsPerCell(document);
    const current = this.entry;
    if (
      current &&
      current.document === document &&
      current.revision === document.revision &&
      current.documentWidth === document.width &&
      current.documentHeight === document.height &&
      current.symbolFont === style.symbolFont &&
      current.symbolColor === style.symbolColor &&
      current.symbolBackgroundColor === style.symbolBackgroundColor &&
      current.showSymbols === style.showSymbols &&
      current.ppc === ppc
    ) return current;

    const dimensions = symbolAtlasDimensions(document, ppc);
    if (!dimensions || !targetFactory) {
      const unavailable: SymbolAtlasCacheEntry = {
        source: undefined,
        width: dimensions?.width ?? 0,
        height: dimensions?.height ?? 0,
        revision: document.revision,
        document,
        documentWidth: document.width,
        documentHeight: document.height,
        symbolFont: style.symbolFont,
        symbolColor: style.symbolColor,
        symbolBackgroundColor: style.symbolBackgroundColor,
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
        textAvailable = !style.showSymbols || typeof context.fillText === 'function';
        for (let y = 0; y < document.height; y += 1) {
          for (let x = 0; x < document.width; x += 1) {
            const index = y * document.width + x;
            const offset = index * 4;
            const kind = document.kind[index];
            if (kind === CellKind.Empty) continue;
            const rect = { x: x * ppc, y: y * ppc, width: ppc, height: ppc };
            const paint = (id: number, slot?: number): void => {
              context.fillStyle = style.symbolBackgroundColor;
              drawStitchGeometry(context, kind, rect, slot);
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
            if (kind === CellKind.Quarters) {
              for (let slot = 0; slot < 4; slot += 1) {
                const id = document.colors[offset + slot];
                if (id !== 0) paint(id, slot);
              }
            } else {
              paint(document.colors[offset], undefined);
            }
          }
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
    const result: SymbolAtlasCacheEntry = {
      source,
      width: dimensions.width,
      height: dimensions.height,
      revision: document.revision,
      document,
      documentWidth: document.width,
      documentHeight: document.height,
      symbolFont: style.symbolFont,
      symbolColor: style.symbolColor,
      symbolBackgroundColor: style.symbolBackgroundColor,
      showSymbols: style.showSymbols,
      ppc,
      textAvailable
    };
    this.entry = result;
    return result;
  }
}
