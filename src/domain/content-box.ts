import { cloneBackstitches } from './backstitch-store';
import { CellKind, type PatternDocument } from './types';

/** Inclusive cell bounds of a document's stitched content. */
export interface DocumentContentBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * Bounding box of the cells that hold content, or null when there is none. A
 * cell counts when it holds any stitch (kind !== Empty) or is touched by a
 * backstitch segment (segments use quarter-cell coordinates, four per cell
 * side, so endpoint coverage maps onto cells by integer division). Masked-off
 * cells are always Empty, so they only count when a backstitch touches them.
 */
export function contentBox(document: PatternDocument): DocumentContentBox | null {
  let left = document.width;
  let right = -1;
  let top = document.height;
  let bottom = -1;
  const cover = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= document.width || y >= document.height) return;
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  };
  for (let y = 0; y < document.height; y += 1) {
    for (let x = 0; x < document.width; x += 1) {
      if (document.kind[y * document.width + x] !== CellKind.Empty) cover(x, y);
    }
  }
  const stitches = document.backstitches;
  for (let index = 0; index < stitches.ids.length; index += 1) {
    const minX = Math.floor(Math.min(stitches.x1[index], stitches.x2[index]) / 4);
    const maxX = Math.floor(Math.max(stitches.x1[index], stitches.x2[index]) / 4);
    const minY = Math.floor(Math.min(stitches.y1[index], stitches.y2[index]) / 4);
    const maxY = Math.floor(Math.max(stitches.y1[index], stitches.y2[index]) / 4);
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) cover(x, y);
    }
  }
  if (right < left || bottom < top) return null;
  return { left, top, right, bottom };
}

/** True when the box is the whole document, so cropping to it changes nothing. */
export function boxFillsDocument(document: PatternDocument, box: DocumentContentBox): boolean {
  return box.left === 0 && box.top === 0 && box.right === document.width - 1 && box.bottom === document.height - 1;
}

/**
 * A new document holding only the cells inside `box`, with backstitches
 * translated by its origin. Cell planes, the canvas mask and the backstitch
 * store are fresh arrays, so the source document is never touched. The pure
 * translation preserves canonical endpoint order. A cropped mask that keeps
 * every cell active is dropped, since a present mask is never all-ones.
 */
export function cropDocument(document: PatternDocument, box: DocumentContentBox): PatternDocument {
  const width = box.right - box.left + 1;
  const height = box.bottom - box.top + 1;
  const kind = new Uint8Array(width * height);
  const colors = new Uint16Array(width * height * 4);
  const completed = new Uint8Array(width * height);
  const mask = document.canvasMask ? new Uint8Array(width * height) : undefined;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = (box.top + y) * document.width + box.left + x;
      const to = y * width + x;
      kind[to] = document.kind[from];
      completed[to] = document.completed[from];
      colors.set(document.colors.subarray(from * 4, from * 4 + 4), to * 4);
      if (mask && document.canvasMask) mask[to] = document.canvasMask[from];
    }
  }
  const backstitches = cloneBackstitches(document.backstitches);
  const shiftX = box.left * 4;
  const shiftY = box.top * 4;
  for (let index = 0; index < backstitches.ids.length; index += 1) {
    backstitches.x1[index] -= shiftX;
    backstitches.x2[index] -= shiftX;
    backstitches.y1[index] -= shiftY;
    backstitches.y2[index] -= shiftY;
  }
  const cropped: PatternDocument = {
    ...document,
    width,
    height,
    kind,
    colors,
    completed,
    backstitches,
    ...(document.originX === undefined ? {} : { originX: document.originX + box.left }),
    ...(document.originY === undefined ? {} : { originY: document.originY + box.top })
  };
  if (mask && mask.includes(0)) cropped.canvasMask = mask;
  else delete cropped.canvasMask;
  return cropped;
}

/** The document cropped to its content, or the document itself when it is empty or already fills its box. */
export function cropToContent(document: PatternDocument): PatternDocument {
  const box = contentBox(document);
  return box && !boxFillsDocument(document, box) ? cropDocument(document, box) : document;
}
