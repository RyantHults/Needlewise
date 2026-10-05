import { describe, expect, it } from 'vitest';
import {
  activeCellCount,
  applyCanvasCommand,
  applyCommandsToDraft,
  applyLayerStructureCommand,
  assertValidLayeredDocument,
  backstitchWithinCanvas,
  canvasCellsCommand,
  canvasResizeCommand,
  canvasWorkspace,
  CellKind,
  collectLayeredValidationErrors,
  collectValidationErrors,
  commitLayerSurface,
  createDocument,
  createLayeredDocument,
  DomainError,
  findLayer,
  isActiveCell,
  isCanvasCommand,
  isRectangularCanvas,
  packCanvasMask,
  unpackCanvasMask,
  layerAddCommand,
  layerSetVisibilityCommand,
  layerSurface,
  LayerType,
  WORKSPACE_MIN_EXTENT,
  WORKSPACE_MIN_MARGIN,
  type CatalogAssociation,
  type DomainCommand,
  type LayeredDocument,
  type SpecialtyLayer,
  type StitchLayer
} from './index';

const TEST_CATALOG: CatalogAssociation = { catalogId: 'test-catalog', brandLabel: 'Test Catalog', colorCount: 489 };

function layered(width = 3, height = 2): LayeredDocument {
  return createLayeredDocument({
    width,
    height,
    catalog: TEST_CATALOG,
    palette: [
      { id: 1, name: 'Red', color: '#d33' },
      { id: 2, name: 'Blue', color: '#36c' }
    ]
  });
}

function run(doc: LayeredDocument, layerId: number, ...commands: DomainCommand[]): void {
  const surface = layerSurface(doc, layerId);
  applyCommandsToDraft(surface, commands);
  commitLayerSurface(doc, layerId, surface);
}

function full(x: number, y: number, color = 1): DomainCommand {
  return { type: 'set-full', x, y, color };
}

function line(x1: number, y1: number, x2: number, y2: number, color = 1): DomainCommand {
  return { type: 'add-backstitch', start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, color };
}

function stitch(doc: LayeredDocument, id = 1): StitchLayer {
  const layer = findLayer(doc, id);
  if (layer?.type !== LayerType.Stitch) throw new Error(`Layer ${String(id)} is not a stitch layer.`);
  return layer;
}

function specialty(doc: LayeredDocument, id = 2): SpecialtyLayer {
  const layer = findLayer(doc, id);
  if (layer?.type !== LayerType.Specialty) throw new Error(`Layer ${String(id)} is not a specialty layer.`);
  return layer;
}

function lines(doc: LayeredDocument, id = 2): number[][] {
  const store = specialty(doc, id).backstitches;
  return Array.from(store.ids, (_, index) => [store.x1[index], store.y1[index], store.x2[index], store.y2[index]]);
}

function errorCode(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof DomainError ? error.code : 'not-domain-error';
  }
  return undefined;
}

function apply(doc: LayeredDocument, command: DomainCommand) {
  const result = applyCanvasCommand(doc, command);
  assertValidLayeredDocument(result.document);
  return result;
}

/** A deep copy of everything applyCanvasCommand could touch, to prove the input is left alone. */
function snapshot(doc: LayeredDocument): unknown {
  return {
    width: doc.width,
    height: doc.height,
    originX: doc.originX,
    originY: doc.originY,
    mask: doc.canvasMask && Array.from(doc.canvasMask),
    layers: doc.layers.map((layer) => layer.type === LayerType.Stitch
      ? { id: layer.id, kind: Array.from(layer.kind), colors: Array.from(layer.colors), completed: layer.completed.length }
      : { id: layer.id, lines: Array.from(layer.backstitches.ids), x1: Array.from(layer.backstitches.x1) })
  };
}

describe('canvas queries', () => {
  it('centres the workspace on small and large canvases', () => {
    expect([WORKSPACE_MIN_EXTENT, WORKSPACE_MIN_MARGIN]).toEqual([1000, 100]);
    expect(canvasWorkspace({ width: 10, height: 6 })).toEqual({ x: -495, y: -497, width: 1000, height: 1000 });
    // Odd differences round toward the top-left.
    expect(canvasWorkspace({ width: 11, height: 1 })).toEqual({ x: -495, y: -500, width: 1000, height: 1000 });
    expect(canvasWorkspace({ width: 1000, height: 900 })).toEqual({ x: -100, y: -100, width: 1200, height: 1100 });
    expect(canvasWorkspace({ width: 1, height: 1_000_000 })).toEqual({ x: -500, y: -100, width: 1000, height: 1_000_200 });
  });

  it('reads active cells from the mask, with an absent mask meaning the whole box', () => {
    const rectangle: { width: number; height: number; canvasMask?: Uint8Array } = { width: 2, height: 2 };
    expect(isRectangularCanvas(rectangle)).toBe(true);
    expect(isActiveCell(rectangle, 3)).toBe(true);
    expect(activeCellCount(rectangle)).toBe(4);
    const masked = { width: 2, height: 2, canvasMask: new Uint8Array([1, 0, 1, 1]) };
    expect(isRectangularCanvas(masked)).toBe(false);
    expect(isActiveCell(masked, 1)).toBe(false);
    expect(isActiveCell(masked, 2)).toBe(true);
    expect(activeCellCount(masked)).toBe(3);
  });

  it('packs masks one bit per cell, least significant bit first, with zero padding', () => {
    const mask = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 1, 0, 1]);
    const bits = packCanvasMask(mask);
    expect(Array.from(bits)).toEqual([0b1000_0001, 0b10]);
    expect(unpackCanvasMask(bits, mask.length)).toEqual(mask);
  });

  it('builds and recognizes canvas commands', () => {
    expect(canvasResizeCommand({ top: 1, right: 0, bottom: -1, left: 2 })).toEqual({ type: 'canvas-resize', edges: { top: 1, right: 0, bottom: -1, left: 2 } });
    const cells = new Uint8Array([1, 0]);
    expect(canvasCellsCommand('remove', { x: -1, y: 0, width: 2, height: 1 }, cells)).toEqual({ type: 'canvas-cells', operation: 'remove', rect: { x: -1, y: 0, width: 2, height: 1 }, cells });
    expect('cells' in canvasCellsCommand('add', { x: 0, y: 0, width: 1, height: 1 })).toBe(false);
    expect(isCanvasCommand({ type: 'canvas-resize' })).toBe(true);
    expect(isCanvasCommand({ type: 'canvasCells' })).toBe(true);
    expect(isCanvasCommand({ type: 'palette-merge' })).toBe(false);
  });
});

describe('backstitchWithinCanvas', () => {
  const rectangle = { width: 3, height: 3 };
  // The centre cell (1, 1) is a hole.
  const holed = { width: 3, height: 3, canvasMask: new Uint8Array([1, 1, 1, 1, 0, 1, 1, 1, 1]) };

  it('keeps lines on the outer border of a rectangle and rejects lines leaving the box', () => {
    expect(backstitchWithinCanvas(rectangle, 0, 0, 12, 0)).toBe(true);
    expect(backstitchWithinCanvas(rectangle, 12, 0, 12, 12)).toBe(true);
    expect(backstitchWithinCanvas(rectangle, 0, 12, 12, 12)).toBe(true);
    expect(backstitchWithinCanvas(rectangle, 0, 0, 13, 0)).toBe(false);
    expect(backstitchWithinCanvas(rectangle, -1, 0, 4, 0)).toBe(false);
    expect(backstitchWithinCanvas(holed, 0, 0, 12, 0)).toBe(true);
  });

  it('drops a line through a hole but keeps one along its edge, where the neighbouring square is active', () => {
    expect(backstitchWithinCanvas(holed, 4, 6, 8, 6)).toBe(false);
    expect(backstitchWithinCanvas(holed, 0, 6, 12, 6)).toBe(false);
    expect(backstitchWithinCanvas(holed, 4, 4, 8, 4)).toBe(true);
    expect(backstitchWithinCanvas(holed, 4, 0, 4, 12)).toBe(true);
    expect(backstitchWithinCanvas(holed, 4, 4, 8, 8)).toBe(false);
  });

  it('keeps a diagonal that touches the hole only at a corner, because that corner lies in the closed active squares around it', () => {
    expect(backstitchWithinCanvas(holed, 0, 0, 4, 4)).toBe(true);
    // A shallow diagonal from (0, 4) to (12, 6) runs through the hole's interior.
    expect(backstitchWithinCanvas(holed, 0, 4, 12, 6)).toBe(false);
  });

  it('keeps a diagonal between two holes through the corner shared by its two active cells, since both closed squares contain it', () => {
    const checker = { width: 2, height: 2, canvasMask: new Uint8Array([1, 0, 0, 1]) };
    expect(backstitchWithinCanvas(checker, 0, 0, 8, 8)).toBe(true);
    // The other diagonal crosses both holes.
    expect(backstitchWithinCanvas(checker, 0, 8, 8, 0)).toBe(false);
    // A point that only an inactive cell contains fails.
    expect(backstitchWithinCanvas(checker, 6, 0, 8, 2)).toBe(false);
  });
});

describe('canvas-resize', () => {
  function seeded(): LayeredDocument {
    const doc = layered(3, 2);
    run(doc, 1, full(0, 0, 1), full(2, 1, 2));
    run(doc, 2, line(0, 0, 4, 0), line(8, 0, 8, 4));
    return doc;
  }

  it('grows each edge, moving the origin only for left and top', () => {
    const doc = seeded();
    const left = apply(doc, canvasResizeCommand({ top: 0, right: 0, bottom: 0, left: 2 }));
    expect(left.changed).toBe(true);
    expect([left.document.width, left.document.height, left.document.originX, left.document.originY]).toEqual([5, 2, -2, undefined]);
    expect(stitch(left.document).kind[2]).toBe(CellKind.Full);
    expect(stitch(left.document).colors[(1 * 5 + 4) * 4]).toBe(2);
    expect(lines(left.document)).toEqual([[8, 0, 12, 0], [16, 0, 16, 4]]);
    expect(left.removal).toEqual({ cells: [], backstitches: [] });

    const top = apply(left.document, canvasResizeCommand({ top: 1, right: 0, bottom: 0, left: 0 }));
    expect([top.document.width, top.document.height, top.document.originX, top.document.originY]).toEqual([5, 3, -2, -1]);
    expect(stitch(top.document).kind[5 + 2]).toBe(CellKind.Full);
    expect(lines(top.document)[0]).toEqual([8, 4, 12, 4]);

    const rightBottom = apply(doc, canvasResizeCommand({ top: 0, right: 1, bottom: 2, left: 0 }));
    expect([rightBottom.document.width, rightBottom.document.height]).toEqual([4, 4]);
    expect('originX' in rightBottom.document).toBe(false);
    expect(stitch(rightBottom.document).kind[0]).toBe(CellKind.Full);
    expect(stitch(rightBottom.document).kind[1 * 4 + 2]).toBe(CellKind.Full);
    expect(lines(rightBottom.document)).toEqual(lines(doc));
  });

  it('shrinks an edge, capturing the content it removes and keeping lines on the new border', () => {
    const doc = seeded();
    const right = apply(doc, canvasResizeCommand({ top: 0, right: -1, bottom: 0, left: 0 }));
    expect([right.document.width, right.document.height]).toEqual([2, 2]);
    expect(right.removal.cells).toEqual([{ layerId: 1, indices: new Uint32Array([5]), kind: new Uint8Array([CellKind.Full]), colors: new Uint16Array([2, 0, 0, 0]) }]);
    // x = 8 is the new right border.
    expect(lines(right.document)).toEqual([[0, 0, 4, 0], [8, 0, 8, 4]]);

    const left = apply(doc, canvasResizeCommand({ top: 0, right: 0, bottom: 0, left: -1 }));
    expect([left.document.width, left.document.originX]).toEqual([2, 1]);
    expect(Array.from(left.removal.cells[0].indices)).toEqual([0]);
    expect(stitch(left.document).kind[3]).toBe(CellKind.Full);
    expect(lines(left.document)).toEqual([[4, 0, 4, 4]]);
    expect(left.removal.backstitches).toHaveLength(1);
    expect(left.removal.backstitches[0]).toMatchObject({ layerId: 2, records: [{ x1: 0, y1: 0, x2: 4, y2: 0, start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 1, completed: false }] });

    const topBottom = apply(doc, canvasResizeCommand({ top: -1, right: 0, bottom: 0, left: 0 }));
    expect([topBottom.document.height, topBottom.document.originY]).toEqual([1, 1]);
    expect(Array.from(stitch(topBottom.document).kind)).toEqual([0, 0, CellKind.Full]);
  });

  it('stores an origin that returns to 0 as absent', () => {
    const doc = seeded();
    const grown = apply(doc, canvasResizeCommand({ top: 1, right: 0, bottom: 0, left: 1 })).document;
    expect([grown.originX, grown.originY]).toEqual([-1, -1]);
    const back = apply(grown, canvasResizeCommand({ top: -1, right: 0, bottom: 0, left: -1 })).document;
    expect('originX' in back || 'originY' in back).toBe(false);
    // An explicit 0 on the input is the same state.
    const explicit = apply({ ...doc, originX: 0, originY: 0 }, canvasResizeCommand({ top: 0, right: 1, bottom: 0, left: 0 })).document;
    expect('originX' in explicit || 'originY' in explicit).toBe(false);
  });

  it('moves every layer when the new box does not overlap the old one', () => {
    const doc = layered(1, 4);
    run(doc, 1, full(0, 0), full(0, 3, 2));
    run(doc, 2, line(0, 4, 4, 4));
    const { document, removal } = apply(doc, canvasResizeCommand({ top: -1, right: -2, bottom: 0, left: 2 }));
    expect([document.width, document.height, document.originX, document.originY]).toEqual([1, 3, -2, 1]);
    expect(Array.from(stitch(document).kind)).toEqual([0, 0, 0]);
    expect(lines(document)).toEqual([]);
    expect(Array.from(removal.cells[0].indices)).toEqual([0, 3]);
    expect(removal.backstitches[0].records).toHaveLength(1);
  });

  it('rejects an edit that moves the origin past the 32-bit range', () => {
    const doc = { ...layered(3, 2), originX: 2 ** 31 - 1 };
    expect(errorCode(() => applyCanvasCommand(doc, canvasResizeCommand({ top: 0, right: 0, bottom: 0, left: -1 })))).toBe('canvas-outside-workspace');
    expect(applyCanvasCommand(doc, canvasResizeCommand({ top: 0, right: 0, bottom: 0, left: 1 })).document.originX).toBe(2 ** 31 - 2);
  });

  it('is a no-op for zero edges and leaves the input untouched', () => {
    const doc = seeded();
    const before = snapshot(doc);
    const same = applyCanvasCommand(doc, canvasResizeCommand({ top: 0, right: 0, bottom: 0, left: 0 }));
    expect(same.changed).toBe(false);
    expect(same.document).toBe(doc);
    const shrunk = applyCanvasCommand(doc, canvasResizeCommand({ top: -1, right: 1, bottom: 0, left: -1 }));
    expect(shrunk.document.revision).toBe(doc.revision);
    expect(snapshot(doc)).toEqual(before);
  });

  it('rejects masks, empty and oversized boxes, the workspace edge and malformed edges', () => {
    const doc = layered(10, 10);
    expect(errorCode(() => applyCanvasCommand(doc, canvasResizeCommand({ top: 0, right: -10, bottom: 0, left: 0 })))).toBe('canvas-empty');
    expect(errorCode(() => applyCanvasCommand(doc, canvasResizeCommand({ top: 0, right: 0, bottom: 0, left: 496 })))).toBe('canvas-outside-workspace');
    expect(applyCanvasCommand(doc, canvasResizeCommand({ top: 0, right: 0, bottom: 0, left: 495 })).document.width).toBe(505);
    expect(errorCode(() => applyCanvasCommand(doc, { type: 'canvas-resize', edges: { top: 0.5, right: 0, bottom: 0, left: 0 } }))).toBe('invalid-command');
    expect(errorCode(() => applyCanvasCommand(doc, { type: 'canvas-resize' }))).toBe('invalid-command');
    const masked = applyCanvasCommand(doc, canvasCellsCommand('remove', { x: 0, y: 0, width: 1, height: 1 })).document;
    expect(errorCode(() => applyCanvasCommand(masked, canvasResizeCommand({ top: 1, right: 0, bottom: 0, left: 0 })))).toBe('canvas-not-rectangular');
    const largest = layered(1000, 1000);
    expect(errorCode(() => applyCanvasCommand(largest, canvasResizeCommand({ top: 0, right: 1, bottom: 0, left: 0 })))).toBe('canvas-too-large');
  });
});

describe('canvas-cells', () => {
  it('adds cells outside the box, growing it to the left and top', () => {
    const doc = layered(3, 2);
    run(doc, 1, full(0, 0));
    run(doc, 2, line(0, 0, 4, 4));
    const { document, changed } = apply(doc, canvasCellsCommand('add', { x: -1, y: -1, width: 1, height: 1 }));
    expect(changed).toBe(true);
    expect([document.width, document.height, document.originX, document.originY]).toEqual([4, 3, -1, -1]);
    expect(Array.from(document.canvasMask!)).toEqual([1, 0, 0, 0, 0, 1, 1, 1, 0, 1, 1, 1]);
    expect(stitch(document).kind[5]).toBe(CellKind.Full);
    expect(lines(document)).toEqual([[4, 4, 8, 8]]);
    expect(isRectangularCanvas(document)).toBe(false);
  });

  it('adds through a cells pattern and ignores cells that are already active', () => {
    const doc = layered(3, 2);
    expect(applyCanvasCommand(doc, canvasCellsCommand('add', { x: 0, y: 0, width: 2, height: 2 })).document).toBe(doc);
    const { document } = apply(doc, canvasCellsCommand('add', { x: 2, y: 1, width: 2, height: 2 }, new Uint8Array([1, 0, 0, 1])));
    expect([document.width, document.height]).toEqual([4, 3]);
    expect(Array.from(document.canvasMask!)).toEqual([1, 1, 1, 0, 1, 1, 1, 0, 0, 0, 0, 1]);
  });

  it('removes an interior cell, clearing and capturing content on hidden layers too', () => {
    const doc = layered(3, 3);
    applyLayerStructureCommand(doc, layerAddCommand(LayerType.Stitch));
    run(doc, 1, full(0, 0));
    run(doc, 3, full(1, 1, 2));
    applyLayerStructureCommand(doc, layerSetVisibilityCommand(3, false));
    const before = snapshot(doc);
    const { document, removal } = apply(doc, canvasCellsCommand('remove', { x: 1, y: 1, width: 1, height: 1 }));
    expect([document.width, document.height]).toEqual([3, 3]);
    expect(Array.from(document.canvasMask!)).toEqual([1, 1, 1, 1, 0, 1, 1, 1, 1]);
    expect(stitch(document, 3).kind[4]).toBe(CellKind.Empty);
    expect(stitch(document, 3).colors[16]).toBe(0);
    expect(removal.cells).toEqual([{ layerId: 3, indices: new Uint32Array([4]), kind: new Uint8Array([CellKind.Full]), colors: new Uint16Array([2, 0, 0, 0]) }]);
    // Layers the edit leaves alone keep their objects.
    expect(findLayer(document, 1)).toBe(findLayer(doc, 1));
    expect(findLayer(document, 2)).toBe(findLayer(doc, 2));
    expect(snapshot(doc)).toEqual(before);
    expect(document.canvasMask).not.toBe(doc.canvasMask);
  });

  it('shrinks the box when an edge row is fully removed, and drops lines that leave the canvas', () => {
    const doc = layered(3, 3);
    run(doc, 1, full(1, 0), full(1, 2));
    run(doc, 2, line(0, 0, 12, 0), line(0, 4, 12, 4), line(4, 6, 8, 6));
    const { document, removal } = apply(doc, canvasCellsCommand('remove', { x: -5, y: 0, width: 20, height: 1 }));
    expect([document.width, document.height, document.originY]).toEqual([3, 2, 1]);
    expect(document.canvasMask).toBeUndefined();
    expect('canvasMask' in document).toBe(false);
    expect(stitch(document).kind[1 * 3 + 1]).toBe(CellKind.Full);
    expect(lines(document)).toEqual([[0, 0, 12, 0], [4, 2, 8, 2]]);
    expect(removal.backstitches[0].records.map((record) => record.id)).toEqual([1]);
    expect(Array.from(removal.cells[0].indices)).toEqual([1]);
  });

  it('drops a line through a new hole and keeps lines along its edges and corners', () => {
    const doc = layered(3, 3);
    run(doc, 2, line(4, 6, 8, 6), line(4, 4, 8, 4), line(0, 0, 4, 4), line(4, 4, 8, 8));
    const { document, removal } = apply(doc, canvasCellsCommand('remove', { x: 1, y: 1, width: 1, height: 1 }));
    expect(lines(document)).toEqual([[4, 4, 8, 4], [0, 0, 4, 4]]);
    expect(removal.backstitches[0].records.map((record) => [record.x1, record.y1, record.x2, record.y2])).toEqual([[4, 6, 8, 6], [4, 4, 8, 8]]);
  });

  it('normalizes back to a rectangle when the last hole is filled, which unlocks basic mode', () => {
    const doc = layered(3, 2);
    const holed = apply(doc, canvasCellsCommand('remove', { x: 1, y: 0, width: 1, height: 1 })).document;
    expect(isRectangularCanvas(holed)).toBe(false);
    const filled = apply(holed, canvasCellsCommand('add', { x: 0, y: 0, width: 3, height: 1 })).document;
    expect(isRectangularCanvas(filled)).toBe(true);
    expect('canvasMask' in filled).toBe(false);
    expect(applyCanvasCommand(filled, canvasResizeCommand({ top: 1, right: 0, bottom: 0, left: 0 })).changed).toBe(true);
  });

  it('clips to the workspace silently and ignores removals outside the canvas', () => {
    const doc = layered(10, 10);
    expect(applyCanvasCommand(doc, canvasCellsCommand('add', { x: -2000, y: 0, width: 5, height: 1 })).document).toBe(doc);
    expect(applyCanvasCommand(doc, canvasCellsCommand('remove', { x: 10, y: 0, width: 5, height: 5 })).document).toBe(doc);
    const { document } = apply(doc, canvasCellsCommand('add', { x: -600, y: 0, width: 200, height: 1 }));
    expect([document.width, document.originX]).toEqual([505, -495]);
  });

  it('rejects an empty canvas, an oversized box and malformed input', () => {
    const doc = layered(3, 2);
    expect(errorCode(() => applyCanvasCommand(doc, canvasCellsCommand('remove', { x: -1, y: -1, width: 5, height: 5 })))).toBe('canvas-empty');
    expect(errorCode(() => applyCanvasCommand(doc, { type: 'canvas-cells', operation: 'flip', rect: { x: 0, y: 0, width: 1, height: 1 } }))).toBe('invalid-command');
    expect(errorCode(() => applyCanvasCommand(doc, { type: 'canvas-cells', operation: 'add', rect: { x: 0.5, y: 0, width: 1, height: 1 } }))).toBe('invalid-command');
    expect(errorCode(() => applyCanvasCommand(doc, { type: 'canvas-cells', operation: 'add', rect: { x: 0, y: 0, width: 0, height: 1 } }))).toBe('invalid-command');
    expect(errorCode(() => applyCanvasCommand(doc, canvasCellsCommand('add', { x: 0, y: 0, width: 2, height: 1 }, new Uint8Array([1]))))).toBe('invalid-command');
    expect(errorCode(() => applyCanvasCommand(doc, canvasCellsCommand('add', { x: 0, y: 0, width: 1, height: 1 }, new Uint8Array([2]))))).toBe('invalid-command');
    expect(errorCode(() => applyCanvasCommand(doc, { type: 'palette-merge' }))).toBe('invalid-command');
    const largest = layered(1000, 1000);
    expect(errorCode(() => applyCanvasCommand(largest, canvasCellsCommand('add', { x: -1, y: 0, width: 1, height: 1 })))).toBe('canvas-too-large');
    expect(errorCode(() => applyCanvasCommand(largest, canvasCellsCommand('add', { x: 999, y: 999, width: 2, height: 1 }, new Uint8Array([1, 1]))))).toBe('canvas-too-large');
  });
});

describe('canvas validation', () => {
  function holed(): LayeredDocument {
    const doc = layered(3, 3);
    return applyCanvasCommand(doc, canvasCellsCommand('remove', { x: 1, y: 1, width: 1, height: 1 })).document;
  }

  it('accepts documents without canvas fields and valid masked documents with an origin', () => {
    expect(collectLayeredValidationErrors(layered())).toEqual([]);
    expect(collectValidationErrors(createDocument({ width: 2, height: 2, catalog: TEST_CATALOG }))).toEqual([]);
    const doc = { ...holed(), originX: -40, originY: 7 };
    expect(collectLayeredValidationErrors(doc)).toEqual([]);
    expect(collectValidationErrors(layerSurface(doc, 1))).toEqual([]);
  });

  it('rejects malformed masks and origins', () => {
    const doc = holed();
    const messages = (patch: Partial<LayeredDocument>): string => collectLayeredValidationErrors({ ...doc, ...patch }).join(' ');
    expect(messages({ canvasMask: new Uint8Array(4) })).toContain('one value per cell');
    expect(messages({ canvasMask: new Uint8Array([1, 1, 1, 1, 2, 1, 1, 1, 1]) })).toContain('only 0 or 1');
    expect(messages({ canvasMask: new Uint8Array(9).fill(1) })).toContain('absent when every cell is active');
    expect(messages({ canvasMask: new Uint8Array(9) })).toContain('at least one active cell');
    expect(messages({ canvasMask: new Uint8Array([1, 1, 0, 1, 1, 0, 1, 1, 0]) })).toContain('tight');
    expect(messages({ originX: 1.5 })).toContain('originX must be a 32-bit integer');
    expect(messages({ originX: 2 ** 31 })).toContain('originX must be a 32-bit integer');
    expect(messages({ originY: -(2 ** 31) - 1 })).toContain('originY must be a 32-bit integer');
    expect(messages({ originX: 2 ** 31 - 1, originY: -(2 ** 31) })).not.toContain('32-bit');
  });

  it('rejects stitches in a hole and backstitches through one, on any layer', () => {
    const doc = holed();
    const surface = layerSurface(doc, 1);
    const kind = surface.kind.slice();
    const colors = surface.colors.slice();
    kind[4] = CellKind.Full;
    colors[16] = 1;
    const painted = { ...doc, layers: doc.layers.map((layer) => layer.id === 1 ? { ...stitch(doc), kind, colors } : layer) };
    expect(collectLayeredValidationErrors(painted).join(' ')).toContain('Cell 4 is outside the canvas');
    expect(collectValidationErrors(layerSurface(painted, 1)).join(' ')).toContain('Cell 4 is outside the canvas');

    const lined = layered(3, 3);
    run(lined, 2, line(4, 6, 8, 6));
    const masked = { ...lined, canvasMask: doc.canvasMask };
    expect(collectLayeredValidationErrors(masked).join(' ')).toContain('Backstitch 1 is outside the canvas');
  });
});
