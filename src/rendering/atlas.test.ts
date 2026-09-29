import { describe, expect, it } from 'vitest';
import { CellKind, createDocumentEditor, createLayeredDocument, layerSetVisibilityCommand, layerAddCommand, type PatternDocument } from '../domain';
import { DEFAULT_CATALOG_DEFINITION } from '../catalog';
import { DEFAULT_RENDERER_STYLE, type CanvasContextAdapter, type CanvasTarget, type RendererStyle } from '../editor/contracts';
import { ColorAtlasCache, SymbolAtlasCache } from './atlas';

/** A context that paints fillRect into a pixel grid and counts full-atlas rebuilds. */
function pixelTarget(width: number, height: number): CanvasTarget & { pixels: string[][]; fills: number } {
  const pixels = Array.from({ length: height }, () => Array.from({ length: width }, () => ''));
  const paint = (left: number, top: number, rectWidth: number, rectHeight: number, value: () => string): void => {
    for (let y = Math.max(0, top); y < Math.min(height, top + rectHeight); y += 1) {
      for (let x = Math.max(0, left); x < Math.min(width, left + rectWidth); x += 1) pixels[y][x] = value();
    }
  };
  const result = {
    pixels,
    fills: 0,
    width,
    height,
    source: { width, height, getContext: () => undefined },
    context: undefined as unknown as CanvasContextAdapter
  };
  const context: CanvasContextAdapter = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    clearRect: (x, y, w, h) => paint(x, y, w, h, () => ''),
    fillRect: (x, y, w, h) => {
      result.fills += 1;
      paint(x, y, w, h, () => context.fillStyle);
    },
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    fill: () => undefined,
    stroke: () => undefined,
    fillText: () => undefined,
    save: () => undefined,
    restore: () => undefined
  };
  result.context = context;
  return result;
}

const PALETTE = [
  { id: 1, name: 'Red', color: '#ff0000', active: true },
  { id: 2, name: 'Blue', color: '#0000ff', active: true }
];

function editorWithTwoStitchLayers(size = 4) {
  const editor = createDocumentEditor(createLayeredDocument({ width: size, height: size, catalog: DEFAULT_CATALOG_DEFINITION.association, palette: PALETTE }));
  editor.execute(layerAddCommand('stitch'));
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) editor.execute({ type: 'set-full', x, y, color: 1, layerId: 1 });
  }
  return editor;
}

describe('overview atlas caches', () => {
  it('sees copy-on-write planes after a cell edit and repaints only that cell', () => {
    const editor = editorWithTwoStitchLayers();
    const targets: Array<ReturnType<typeof pixelTarget>> = [];
    const cache = new ColorAtlasCache();
    const factory = (width: number, height: number) => {
      const target = pixelTarget(width, height);
      targets.push(target);
      return target;
    };
    const before = editor.composite;
    cache.get(before, DEFAULT_RENDERER_STYLE, factory);
    expect(targets[0].pixels[0][0]).toBe('#ff0000');

    const result = editor.execute({ type: 'set-full', x: 1, y: 2, color: 2, layerId: 3 });
    // The domain replaces planes on every cell edit, so an identity-keyed atlas is never stale.
    expect(result.document.kind).not.toBe(before.kind);
    expect(Array.from(result.compositeChangedIndices ?? [])).toEqual([9]);

    const fillsBefore = targets[0].fills;
    cache.invalidate(result.compositeChangedIndices, 16);
    const atlas = cache.get(result.document, DEFAULT_RENDERER_STYLE, factory);
    expect(targets).toHaveLength(1);
    expect(atlas.revision).toBe(result.revision);
    expect(targets[0].pixels[2][1]).toBe('#0000ff');
    expect(targets[0].pixels[0][0]).toBe('#ff0000');
    // An opaque full stitch is painted straight over the old cell: one fill.
    expect(targets[0].fills - fillsBefore).toBe(1);
  });

  it('repaints the cells a visibility change reports and rebuilds when changes are unknown', () => {
    const editor = editorWithTwoStitchLayers();
    editor.execute({ type: 'set-full', x: 0, y: 0, color: 2, layerId: 3 });
    const targets: Array<ReturnType<typeof pixelTarget>> = [];
    const factory = (width: number, height: number) => {
      const target = pixelTarget(width, height);
      targets.push(target);
      return target;
    };
    const cache = new ColorAtlasCache();
    cache.get(editor.composite, DEFAULT_RENDERER_STYLE, factory);
    expect(targets[0].pixels[0][0]).toBe('#0000ff');

    const hidden = editor.execute(layerSetVisibilityCommand(3, false));
    expect(hidden.compositeFull).not.toBe(true);
    cache.invalidate(hidden.compositeChangedIndices, 16);
    cache.get(hidden.document, DEFAULT_RENDERER_STYLE, factory);
    expect(targets).toHaveLength(1);
    expect(targets[0].pixels[0][0]).toBe('#ff0000');

    const shown = editor.execute(layerSetVisibilityCommand(3, true));
    cache.invalidate(undefined, 16);
    cache.get(shown.document, DEFAULT_RENDERER_STYLE, factory);
    expect(targets).toHaveLength(2);
    expect(targets[1].pixels[0][0]).toBe('#0000ff');
  });

  it('rebuilds when too many cells changed or a palette color changed', () => {
    const editor = editorWithTwoStitchLayers();
    let builds = 0;
    const factory = (width: number, height: number) => {
      builds += 1;
      return pixelTarget(width, height);
    };
    const cache = new ColorAtlasCache();
    cache.get(editor.composite, DEFAULT_RENDERER_STYLE, factory);
    const many = editor.execute({ type: 'bulk-cell', indices: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8]), edit: { kind: 'full', color: 2 }, layerId: 3 });
    cache.invalidate(many.compositeChangedIndices, 16);
    cache.get(many.document, DEFAULT_RENDERER_STYLE, factory);
    expect(builds).toBe(2);

    const recolored: PatternDocument = { ...many.document, palette: many.document.palette.map((entry) => entry.id === 1 ? { ...entry, color: '#00ff00' } : entry) };
    cache.get(recolored, DEFAULT_RENDERER_STYLE, factory);
    expect(builds).toBe(3);
  });

  it('rebuilds a one-pixel color atlas when a patched cell becomes a three-quarter pair', () => {
    const editor = editorWithTwoStitchLayers();
    let builds = 0;
    const factory = (width: number, height: number) => {
      builds += 1;
      return pixelTarget(width, height);
    };
    const cache = new ColorAtlasCache();
    const first = cache.get(editor.composite, DEFAULT_RENDERER_STYLE, factory);
    expect(first.pixelsPerCell).toBe(1);
    editor.execute({ type: 'bulk-cell', indices: new Uint32Array([5]), edit: { kind: 'three-quarter', corner: 0, color: 2 }, layerId: 3 });
    const pair = editor.execute({ type: 'bulk-cell', indices: new Uint32Array([5]), edit: { kind: 'three-quarter', corner: 2, color: 1 }, layerId: 3 });
    expect(pair.document.kind[5]).not.toBe(CellKind.Full);
    cache.invalidate(new Uint32Array([5]), 16);
    const atlas = cache.get(pair.document, DEFAULT_RENDERER_STYLE, factory);
    expect(builds).toBe(2);
    expect(atlas.pixelsPerCell).toBe(2);
  });

  it('patches the symbol atlas cell by cell', () => {
    const editor = editorWithTwoStitchLayers();
    const style: RendererStyle = { ...DEFAULT_RENDERER_STYLE, mode: 'symbol' };
    const targets: Array<ReturnType<typeof pixelTarget>> = [];
    const factory = (width: number, height: number) => {
      const target = pixelTarget(width, height);
      targets.push(target);
      return target;
    };
    const cache = new SymbolAtlasCache();
    cache.get(editor.composite, style, factory);
    const erased = editor.execute({ type: 'bulk-cell', indices: new Uint32Array([0]), edit: { kind: 'erase-cell' }, layerId: 1 });
    cache.invalidate(erased.compositeChangedIndices, 16);
    const atlas = cache.get(erased.document, style, factory);
    expect(targets).toHaveLength(1);
    expect(atlas.revision).toBe(erased.revision);
    expect(atlas.source).toBe(targets[0].source);
  });
});
