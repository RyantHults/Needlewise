import { CellKind, FIXED_POINT_UNITS_PER_CELL, type PaletteEntry } from '../domain';
import { DEFAULT_RENDERER_STYLE, type CanvasContextAdapter } from '../editor/contracts';
import { isLegacyQuarterKind, isThreeQuarterPairKind, threeQuarterPairComponents } from '../editor/cell-kinds';
import {
  drawThreadBackstitch,
  drawThreadFabric,
  drawThreadFlat,
  drawThreadStitch,
  THREAD_MIN_DETAIL_CELL_PX
} from '../rendering/thread-preview';
import { throwIfAborted, yieldToEventLoop } from './cancellation';
import type { PdfPatternDocument } from './pdf-writer';

export const COVER_DEFAULT_MAX_SIDE_PX = 1200;
export const COVER_MAX_CELL_PX = 16;
/** Rows painted between abort checks and event-loop yields. */
const ROW_BATCH = 16;

export interface CoverImageInput {
  /** The flattened visible pattern; completion planes are not part of this type. */
  readonly document: PdfPatternDocument;
  /** Defaults to `document.palette`. */
  readonly palette?: readonly PaletteEntry[];
  readonly backgroundColor: string;
  readonly maxSidePx?: number;
}

/** A drawing surface the renderer paints into and then encodes. */
export interface CoverCanvas {
  readonly context: CanvasContextAdapter;
  toPng(): Promise<Uint8Array>;
}

export type CoverCanvasFactory = (width: number, height: number) => CoverCanvas | undefined;

export interface CoverImageOptions {
  readonly signal?: AbortSignal;
  /** Overrides canvas creation; used by tests. */
  readonly createCanvas?: CoverCanvasFactory;
}

/** Pixels per cell: as large as fits `maxSidePx`, at least 1 and at most 16. */
export function coverCellPx(width: number, height: number, maxSidePx = COVER_DEFAULT_MAX_SIDE_PX): number {
  const longest = Math.max(1, width, height);
  const fit = Math.floor((Number.isFinite(maxSidePx) && maxSidePx > 0 ? maxSidePx : COVER_DEFAULT_MAX_SIDE_PX) / longest);
  return Math.min(COVER_MAX_CELL_PX, Math.max(1, fit));
}

/**
 * Paint the pattern as thread at `cellPx` pixels per cell. Reads stitch kinds
 * and colors only. Below `THREAD_MIN_DETAIL_CELL_PX` it draws flat color.
 */
export async function paintCover(
  context: CanvasContextAdapter,
  input: CoverImageInput,
  cellPx: number,
  signal?: AbortSignal
): Promise<void> {
  const { document, backgroundColor } = input;
  const palette = input.palette ?? document.palette;
  const colorById = new Map(palette.map((entry) => [entry.id, entry.color]));
  const colorOf = (id: number): string => colorById.get(id) ?? DEFAULT_RENDERER_STYLE.missingPaletteColor;
  const detail = cellPx >= THREAD_MIN_DETAIL_CELL_PX;
  const mask = document.canvasMask;

  drawThreadFabric(context, { x: 0, y: 0, width: document.width * cellPx, height: document.height * cellPx }, cellPx, backgroundColor);

  const paint = (kind: number, id: number, x: number, y: number, slot?: number): void => {
    if (id === 0) return;
    const rect = { x: x * cellPx, y: y * cellPx, width: cellPx, height: cellPx };
    if (detail) drawThreadStitch(context, kind, rect, colorOf(id), slot ?? 0);
    else drawThreadFlat(context, kind, rect, colorOf(id), slot ?? 0);
  };

  for (let y = 0; y < document.height; y += 1) {
    if (y % ROW_BATCH === 0) {
      throwIfAborted(signal);
      if (y > 0) await yieldToEventLoop();
      throwIfAborted(signal);
    }
    for (let x = 0; x < document.width; x += 1) {
      const index = y * document.width + x;
      const kind = document.kind[index];
      if (kind === CellKind.Empty || (mask && mask[index] === 0)) continue;
      const offset = index * 4;
      if (isLegacyQuarterKind(kind)) {
        for (let slot = 0; slot < 4; slot += 1) paint(kind, document.colors[offset + slot] ?? 0, x, y, slot);
      } else if (isThreeQuarterPairKind(kind)) {
        const colors = [0, 1, 2, 3].map((slot) => document.colors[offset + slot] ?? 0);
        for (const component of threeQuarterPairComponents(colors)) {
          paint(component.kind, colors[component.slot] ?? 0, x, y, component.slot);
        }
      } else paint(kind, document.colors[offset] ?? 0, x, y);
    }
  }

  throwIfAborted(signal);
  // Store coordinates are fixed-point; the thread painter takes cells.
  const store = document.backstitches;
  for (let i = 0; i < store.ids.length; i += 1) {
    drawThreadBackstitch(
      context,
      { x: store.x1[i] / FIXED_POINT_UNITS_PER_CELL, y: store.y1[i] / FIXED_POINT_UNITS_PER_CELL },
      { x: store.x2[i] / FIXED_POINT_UNITS_PER_CELL, y: store.y2[i] / FIXED_POINT_UNITS_PER_CELL },
      cellPx,
      colorOf(store.colors[i])
    );
  }
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** OffscreenCanvas, else a detached canvas element, else undefined. */
export function createDefaultCoverCanvas(width: number, height: number): CoverCanvas | undefined {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    return {
      context: context as unknown as CanvasContextAdapter,
      toPng: async () => blobBytes(await canvas.convertToBlob({ type: 'image/png' }))
    };
  }
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  let context: CanvasRenderingContext2D | null;
  try {
    context = canvas.getContext('2d');
  } catch {
    context = null;
  }
  if (!context) return undefined;
  return {
    context: context as unknown as CanvasContextAdapter,
    toPng: () => new Promise<Uint8Array>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) blobBytes(blob).then(resolve, reject);
        else reject(new Error('The cover image could not be encoded.'));
      }, 'image/png');
    })
  };
}

/**
 * Render the thread preview of a pattern as PNG bytes for the PDF cover.
 * Resolves undefined when no canvas is available (tests, restricted
 * environments), which the PDF writer treats as "no cover image". Draw and
 * encode errors propagate; a cancelled signal rejects with an `AbortError`.
 */
export async function renderCoverPng(input: CoverImageInput, options: CoverImageOptions = {}): Promise<Uint8Array | undefined> {
  throwIfAborted(options.signal);
  const { width, height } = input.document;
  if (!(width > 0) || !(height > 0)) return undefined;
  const cellPx = coverCellPx(width, height, input.maxSidePx);
  const canvas = (options.createCanvas ?? createDefaultCoverCanvas)(width * cellPx, height * cellPx);
  if (!canvas) return undefined;
  await paintCover(canvas.context, input, cellPx, options.signal);
  throwIfAborted(options.signal);
  return canvas.toPng();
}
