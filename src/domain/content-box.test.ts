import { describe, expect, it } from 'vitest';
import { backstitchesFromRecords, readBackstitch } from './backstitch-store';
import { contentBox, cropToContent } from './content-box';
import { createDocument } from './model';
import { TEST_CATALOG, getCell } from './test-fixtures';
import { CellKind } from './types';

const palette = [{ id: 1, name: 'Red', color: '#FF0000' }];

function stitched(width: number, height: number, cells: readonly [number, number][]) {
  const document = createDocument({ width, height, catalog: TEST_CATALOG, palette });
  for (const [x, y] of cells) {
    document.kind[y * width + x] = CellKind.Full;
    document.colors[(y * width + x) * 4] = 1;
  }
  return document;
}

describe('content box', () => {
  it('bounds stitches and backstitch-only cells', () => {
    const document = stitched(6, 5, [[1, 1]]);
    // Quarter coords x=16, y=4..12: column 4, rows 1 to 3.
    document.backstitches = backstitchesFromRecords([{ id: 7, x1: 16, y1: 4, x2: 16, y2: 12, start: { x: 16, y: 4 }, end: { x: 16, y: 12 }, color: 1, completed: false }]);
    expect(contentBox(document)).toEqual({ left: 1, top: 1, right: 4, bottom: 3 });
  });

  it('has no box for an empty pattern, including a masked canvas', () => {
    const document = stitched(3, 3, []);
    document.canvasMask = new Uint8Array([0, 1, 0, 1, 1, 1, 0, 1, 0]);
    expect(contentBox(document)).toBeNull();
  });
});

describe('crop to content', () => {
  it('returns a cropped copy and leaves the original untouched', () => {
    const document = stitched(5, 4, [[1, 1], [3, 2]]);
    document.completed[1 * 5 + 1] = 1;
    document.backstitches = backstitchesFromRecords([{ id: 3, x1: 4, y1: 4, x2: 8, y2: 8, start: { x: 4, y: 4 }, end: { x: 8, y: 8 }, color: 1, completed: true }]);
    const before = { kind: document.kind.slice(), colors: document.colors.slice(), x1: document.backstitches.x1.slice() };

    const cropped = cropToContent(document);

    expect(cropped).not.toBe(document);
    expect(cropped).toMatchObject({ width: 3, height: 2, revision: document.revision, palette: document.palette });
    expect(getCell(cropped, 0, 0)).toMatchObject({ kind: CellKind.Full });
    expect(getCell(cropped, 2, 1)).toMatchObject({ kind: CellKind.Full });
    expect(cropped.completed[0]).toBe(1);
    expect(readBackstitch(cropped.backstitches, 0)).toMatchObject({ id: 3, x1: 0, y1: 0, x2: 4, y2: 4, completed: true });

    expect(document.width).toBe(5);
    expect(document.height).toBe(4);
    expect(document.kind).toEqual(before.kind);
    expect(document.colors).toEqual(before.colors);
    expect(document.backstitches.x1).toEqual(before.x1);
  });

  it('crops the canvas mask with the cells', () => {
    const document = stitched(4, 3, [[1, 0], [2, 1]]);
    document.canvasMask = new Uint8Array([
      0, 1, 1, 0,
      1, 0, 1, 1,
      1, 1, 1, 1
    ]);
    const cropped = cropToContent(document);
    expect(cropped).toMatchObject({ width: 2, height: 2 });
    expect(cropped.canvasMask).toEqual(new Uint8Array([1, 1, 0, 1]));
    expect(document.canvasMask).toHaveLength(12);
  });

  it('drops a cropped mask that keeps every cell active', () => {
    const document = stitched(3, 2, [[1, 0]]);
    document.canvasMask = new Uint8Array([0, 1, 1, 1, 1, 1]);
    const cropped = cropToContent(document);
    expect(cropped).toMatchObject({ width: 1, height: 1 });
    expect(cropped.canvasMask).toBeUndefined();
  });

  it('shifts the workspace origin by the crop', () => {
    const document = stitched(4, 4, [[2, 3]]);
    document.originX = 10;
    document.originY = -5;
    expect(cropToContent(document)).toMatchObject({ originX: 12, originY: -2 });
  });

  it('returns the document itself when it is empty or already filled', () => {
    const empty = stitched(3, 3, []);
    expect(cropToContent(empty)).toBe(empty);
    const full = stitched(2, 1, [[0, 0], [1, 0]]);
    expect(cropToContent(full)).toBe(full);
  });
});
