import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createDocument,
  createEditor,
  DomainError,
  listBackstitches,
  type CatalogAssociation,
  type DomainCommand,
  type PatternDocument
} from './index';

const TEST_CATALOG: CatalogAssociation = {
  catalogId: 'test-catalog',
  brandLabel: 'Test Catalog',
  colorCount: 489
};

function document(width = 4, height = 4) {
  return createDocument({
    width,
    height,
    catalog: TEST_CATALOG,
    palette: [
      { id: 1, name: 'Red', color: '#d33' },
      { id: 2, name: 'Blue', color: '#36c' }
    ]
  });
}

function apply(pattern: PatternDocument, command: DomainCommand) {
  return applyCommand(pattern, command);
}

function lines(pattern: PatternDocument) {
  return listBackstitches(pattern).map((record) => ({ id: record.id, x1: record.x1, y1: record.y1, x2: record.x2, y2: record.y2, color: record.color, completed: record.completed }));
}

function geometry(pattern: PatternDocument) {
  return listBackstitches(pattern).map((record) => [record.x1, record.y1, record.x2, record.y2]);
}

describe('backstitch corner segmentation', () => {
  it('splits a straight three-cell line into one record per cell', () => {
    const result = apply(document(), { type: 'add-backstitch', start: { x: 12, y: 0 }, end: { x: 0, y: 0 }, color: 1 });
    expect(geometry(result.document)).toEqual([[0, 0, 4, 0], [4, 0, 8, 0], [8, 0, 12, 0]]);
    expect(listBackstitches(result.document).map((record) => record.id)).toEqual([1, 2, 3]);
    expect(result.backstitchId).toBe(1);
    expect(result.createdBackstitchIds).toEqual(new Uint32Array([1, 2, 3]));
    expect(result.document.nextBackstitchId).toBe(4);
  });

  it('splits a 1:1 diagonal at the corners it crosses', () => {
    const result = apply(document(), { type: 'add-backstitch', start: { x: 0, y: 8 }, end: { x: 8, y: 0 }, color: 1 });
    expect(geometry(result.document)).toEqual([[0, 8, 4, 4], [4, 4, 8, 0]]);
  });

  it('does not split a 2:1 diagonal that crosses only a midpoint', () => {
    const result = apply(document(), { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 8, y: 4 }, color: 1 });
    expect(geometry(result.document)).toEqual([[0, 0, 8, 4]]);
    expect(result.createdBackstitchIds).toEqual(new Uint32Array([1]));
  });

  it('keeps a midpoint endpoint and splits only at interior corners', () => {
    const result = apply(document(), { type: 'add-backstitch', start: { x: 2, y: 0 }, end: { x: 12, y: 0 }, color: 1 });
    expect(geometry(result.document)).toEqual([[2, 0, 4, 0], [4, 0, 8, 0], [8, 0, 12, 0]]);
  });

  it('replaces an overlapping piece in place with the new color and no progress', () => {
    let pattern = apply(document(), { type: 'add-backstitch', start: { x: 4, y: 0 }, end: { x: 8, y: 0 }, color: 1 }).document;
    pattern = apply(pattern, { type: 'set-backstitch-completion', id: 1, completed: true }).document;
    const result = apply(pattern, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 12, y: 0 }, color: 2 });
    expect(lines(result.document)).toEqual([
      { id: 1, x1: 4, y1: 0, x2: 8, y2: 0, color: 2, completed: false },
      { id: 2, x1: 0, y1: 0, x2: 4, y2: 0, color: 2, completed: false },
      { id: 3, x1: 8, y1: 0, x2: 12, y2: 0, color: 2, completed: false }
    ]);
    expect(result.backstitchId).toBe(2);
    expect(result.createdBackstitchIds).toEqual(new Uint32Array([2, 3]));
  });

  it('recolors an exact match without creating ids', () => {
    const pattern = apply(document(), { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 1 }).document;
    const result = apply(pattern, { type: 'add-backstitch', start: { x: 4, y: 0 }, end: { x: 0, y: 0 }, color: 2 });
    expect(lines(result.document)).toEqual([{ id: 1, x1: 0, y1: 0, x2: 4, y2: 0, color: 2, completed: false }]);
    expect(result.backstitchId).toBe(1);
    expect(result.createdBackstitchIds).toBeUndefined();
    expect(result.document.nextBackstitchId).toBe(2);
  });

  it('still rejects a line whose every piece already exists unchanged', () => {
    const pattern = apply(document(), { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 8, y: 0 }, color: 1 }).document;
    expect(() => apply(pattern, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 8, y: 0 }, color: 1 })).toThrow(DomainError);
    expect(() => apply(pattern, { type: 'add-backstitch', start: { x: 4, y: 0 }, end: { x: 8, y: 0 }, color: 1 })).toThrow(/already exists/);
  });

  it('re-splits a moved stitch, keeping its id for the first piece', () => {
    let pattern = apply(document(), { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 2 }).document;
    pattern = apply(pattern, { type: 'set-backstitch-completion', id: 1, completed: true }).document;
    const result = apply(pattern, { type: 'move-backstitch', id: 1, start: { x: 0, y: 4 }, end: { x: 12, y: 4 } });
    expect(lines(result.document)).toEqual([
      { id: 1, x1: 0, y1: 4, x2: 4, y2: 4, color: 2, completed: false },
      { id: 2, x1: 4, y1: 4, x2: 8, y2: 4, color: 2, completed: false },
      { id: 3, x1: 8, y1: 4, x2: 12, y2: 4, color: 2, completed: false }
    ]);
    expect(result.backstitchId).toBe(1);
    expect(result.createdBackstitchIds).toEqual(new Uint32Array([2, 3]));
    expect(result.document.nextBackstitchId).toBe(4);
  });

  it('removes another stitch that a moved piece lands on', () => {
    let pattern = apply(document(), { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 1 }).document;
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 4, y: 4 }, end: { x: 8, y: 4 }, color: 2 }).document;
    const result = apply(pattern, { type: 'move-backstitch', id: 1, start: { x: 0, y: 4 }, end: { x: 8, y: 4 } });
    expect(lines(result.document)).toEqual([
      { id: 1, x1: 0, y1: 4, x2: 4, y2: 4, color: 1, completed: false },
      { id: 3, x1: 4, y1: 4, x2: 8, y2: 4, color: 1, completed: false }
    ]);
  });

  it('gives every piece of an updated stitch the new color', () => {
    const pattern = apply(document(), { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 1 }).document;
    const result = apply(pattern, { type: 'update-backstitch', id: 1, start: { x: 0, y: 4 }, end: { x: 8, y: 4 }, color: 2 });
    expect(lines(result.document)).toEqual([
      { id: 1, x1: 0, y1: 4, x2: 4, y2: 4, color: 2, completed: false },
      { id: 2, x1: 4, y1: 4, x2: 8, y2: 4, color: 2, completed: false }
    ]);
    expect(result.backstitchId).toBe(1);
    expect(result.createdBackstitchIds).toEqual(new Uint32Array([2]));
  });

  it('leaves an unmoved single-piece stitch unchanged', () => {
    const pattern = apply(document(), { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 1 }).document;
    expect(apply(pattern, { type: 'move-backstitch', id: 1, dx: 0, dy: 0 }).changed).toBe(false);
  });

  it('undoes a split add in one step', () => {
    const editor = createEditor(document());
    editor.execute({ type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 1 });
    const before = lines(editor.document);
    editor.execute({ type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 12, y: 0 }, color: 2 });
    expect(listBackstitches(editor.document)).toHaveLength(3);
    editor.undo();
    expect(lines(editor.document)).toEqual(before);
    editor.redo();
    expect(geometry(editor.document)).toEqual([[0, 0, 4, 0], [4, 0, 8, 0], [8, 0, 12, 0]]);
  });
});
