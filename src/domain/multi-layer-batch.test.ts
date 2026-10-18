import { describe, expect, it } from 'vitest';
import {
  CellKind,
  createLayeredDocument,
  deleteCellSetCommand,
  deleteRegionCommand,
  DocumentEditor,
  DomainError,
  LayerErrorCode,
  layerAddCommand,
  layerSetVisibilityCommand,
  LayerType,
  moveFragmentCommand,
  type CatalogAssociation,
  type DomainCommand,
  type LayeredDocument,
  type SpecialtyLayer,
  type StitchLayer
} from './index';

const CATALOG: CatalogAssociation = { catalogId: 'test', brandLabel: 'Test', colorCount: 20 };
const BOTTOM = 1;
const SPECIALTY = 2;
const TOP = 3;
const WIDTH = 6;
const SOURCE = { x: 0, y: 0, width: 2, height: 2 };
const DESTINATION = { x: 3, y: 1 };

function full(x: number, y: number, color: number, layerId: number): DomainCommand {
  return { type: 'set-full', x, y, color, layerId };
}

function onLayer(command: DomainCommand, layerId: number): DomainCommand {
  return { ...command, layerId };
}

function move(layerId: number): DomainCommand {
  return onLayer(moveFragmentCommand(SOURCE, DESTINATION), layerId);
}

/** Two stitch layers and one specialty layer, each with content inside `SOURCE`. */
function threeLayerEditor(): DocumentEditor {
  const editor = new DocumentEditor(createLayeredDocument({
    width: WIDTH,
    height: 4,
    catalog: CATALOG,
    palette: [{ id: 1, name: 'Red', color: '#DD3333' }, { id: 2, name: 'Blue', color: '#3366CC' }, { id: 3, name: 'Green', color: '#33AA55' }]
  }));
  editor.execute(layerAddCommand(LayerType.Stitch, { id: TOP }));
  editor.execute(full(0, 0, 1, BOTTOM));
  editor.execute(full(1, 0, 1, BOTTOM));
  editor.execute(full(0, 1, 2, TOP));
  editor.execute({ type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 3, layerId: SPECIALTY });
  return editor;
}

function stitch(document: LayeredDocument, id: number): StitchLayer {
  const layer = document.layers.find((candidate) => candidate.id === id);
  if (layer?.type !== LayerType.Stitch) throw new Error(`Layer ${String(id)} is not a stitch layer.`);
  return layer;
}

function specialty(document: LayeredDocument, id: number): SpecialtyLayer {
  const layer = document.layers.find((candidate) => candidate.id === id);
  if (layer?.type !== LayerType.Specialty) throw new Error(`Layer ${String(id)} is not a specialty layer.`);
  return layer;
}

function painted(layer: StitchLayer): number[] {
  return Array.from(layer.kind.keys()).filter((index) => layer.kind[index] !== CellKind.Empty);
}

function line(layer: SpecialtyLayer): number[] {
  const { x1, y1, x2, y2 } = layer.backstitches;
  return [x1[0], y1[0], x2[0], y2[0]];
}

function errorCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  throw new Error('Expected a DomainError.');
}

describe('layered DocumentEditor: batches across layers', () => {
  it('moves three layers as one undo step, and undo and redo restore every layer', () => {
    const editor = threeLayerEditor();
    const depth = editor.undoDepth;
    const result = editor.execute({ type: 'batch', commands: [move(BOTTOM), move(SPECIALTY), move(TOP)] });
    expect(result.changed).toBe(true);
    expect(editor.undoDepth).toBe(depth + 1);
    const moved = editor.document;
    expect(painted(stitch(moved, BOTTOM))).toEqual([9, 10]);
    expect(painted(stitch(moved, TOP))).toEqual([15]);
    expect(line(specialty(moved, SPECIALTY))).toEqual([12, 4, 16, 4]);
    expect(editor.exportHistory().undo.at(-1)?.kind).toBe('group');

    editor.undo();
    expect(editor.undoDepth).toBe(depth);
    expect(painted(stitch(editor.document, BOTTOM))).toEqual([0, 1]);
    expect(painted(stitch(editor.document, TOP))).toEqual([6]);
    expect(line(specialty(editor.document, SPECIALTY))).toEqual([0, 0, 4, 0]);

    editor.redo();
    expect(painted(stitch(editor.document, BOTTOM))).toEqual([9, 10]);
    expect(painted(stitch(editor.document, TOP))).toEqual([15]);
    expect(line(specialty(editor.document, SPECIALTY))).toEqual([12, 4, 16, 4]);
  });

  it('rebuilds the composite over the union of every stitch layer the batch changed', () => {
    const editor = threeLayerEditor();
    const union = [0, 1, 6, 9, 10, 15];
    const result = editor.execute({ type: 'batch', commands: [move(BOTTOM), move(SPECIALTY), move(TOP)] });
    expect(result.compositeFull).toBeUndefined();
    expect(Array.from(result.compositeChangedIndices ?? [])).toEqual(union);
    expect(editor.composite.kind[15]).toBe(CellKind.Full);
    expect(editor.composite.colors[15 * 4]).toBe(2);
    expect(editor.composite.backstitches.ids.length).toBe(1);
    expect(Array.from(editor.undo().compositeChangedIndices ?? [])).toEqual(union);
    expect(editor.composite.kind[6]).toBe(CellKind.Full);
    expect(Array.from(editor.redo().compositeChangedIndices ?? [])).toEqual(union);
  });

  it('skips a child that changes nothing', () => {
    const editor = threeLayerEditor();
    editor.execute(onLayer(deleteRegionCommand(SOURCE), TOP));
    const depth = editor.undoDepth;
    const before = stitch(editor.document, TOP);
    editor.execute({ type: 'batch', commands: [move(BOTTOM), move(SPECIALTY), move(TOP)] });
    expect(editor.undoDepth).toBe(depth + 1);
    expect(stitch(editor.document, TOP)).toBe(before);
    const entry = editor.exportHistory().undo.at(-1);
    expect(entry?.kind === 'group' ? entry.entries.map((child) => child.kind === 'delta' ? child.layerId : undefined) : undefined).toEqual([BOTTOM, SPECIALTY]);

    // With a single change left, the batch records that change alone.
    const single = threeLayerEditor();
    single.execute(onLayer(deleteRegionCommand(SOURCE), TOP));
    single.execute(onLayer(deleteRegionCommand(SOURCE), SPECIALTY));
    single.execute({ type: 'batch', commands: [move(BOTTOM), move(SPECIALTY), move(TOP)] });
    const lone = single.exportHistory().undo.at(-1);
    expect(lone?.kind === 'delta' ? lone.layerId : undefined).toBe(BOTTOM);
  });

  it('refuses the whole batch when one child targets a hidden layer, and leaves the document untouched', () => {
    const editor = threeLayerEditor();
    editor.execute(layerSetVisibilityCommand(TOP, false));
    const document = editor.document;
    const revision = editor.revision;
    const depth = editor.undoDepth;
    expect(errorCode(() => editor.execute({ type: 'batch', commands: [move(BOTTOM), move(SPECIALTY), move(TOP)] }))).toBe(LayerErrorCode.Hidden);
    expect(editor.document).toBe(document);
    expect(editor.revision).toBe(revision);
    expect(editor.undoDepth).toBe(depth);
    expect(painted(stitch(editor.document, BOTTOM))).toEqual([0, 1]);
    expect(line(specialty(editor.document, SPECIALTY))).toEqual([0, 0, 4, 0]);
  });

  it('keeps a single-layer batch on one layer entry', () => {
    const editor = threeLayerEditor();
    const depth = editor.undoDepth;
    editor.execute({ type: 'batch', commands: [full(5, 3, 1, BOTTOM), full(4, 3, 1, BOTTOM)] });
    expect(editor.undoDepth).toBe(depth + 1);
    const entry = editor.exportHistory().undo.at(-1);
    expect(entry?.kind === 'delta' ? entry.layerId : undefined).toBe(BOTTOM);
    // The batch-level layerId still applies to children that name none.
    editor.execute({ type: 'batch', layerId: TOP, commands: [{ type: 'set-full', x: 5, y: 0, color: 2 }] });
    expect(stitch(editor.document, TOP).kind[5]).toBe(CellKind.Full);
  });

  it('deletes a region and a cell set across layers as one undo step', () => {
    const editor = threeLayerEditor();
    const depth = editor.undoDepth;
    editor.execute({ type: 'batch', commands: [onLayer(deleteRegionCommand(SOURCE), BOTTOM), onLayer(deleteRegionCommand(SOURCE), SPECIALTY), onLayer(deleteRegionCommand(SOURCE), TOP)] });
    expect(editor.undoDepth).toBe(depth + 1);
    expect(painted(stitch(editor.document, BOTTOM))).toEqual([]);
    expect(painted(stitch(editor.document, TOP))).toEqual([]);
    expect(specialty(editor.document, SPECIALTY).backstitches.ids.length).toBe(0);
    editor.undo();
    expect(painted(stitch(editor.document, BOTTOM))).toEqual([0, 1]);
    expect(painted(stitch(editor.document, TOP))).toEqual([6]);
    expect(specialty(editor.document, SPECIALTY).backstitches.ids.length).toBe(1);

    const cells = new Uint32Array([0, 6]);
    const result = editor.execute({ type: 'batch', commands: [onLayer(deleteCellSetCommand(cells), BOTTOM), onLayer(deleteCellSetCommand(cells), TOP)] });
    expect(Array.from(result.compositeChangedIndices ?? [])).toEqual([0, 6]);
    expect(painted(stitch(editor.document, BOTTOM))).toEqual([1]);
    expect(painted(stitch(editor.document, TOP))).toEqual([]);
    editor.undo();
    expect(painted(stitch(editor.document, BOTTOM))).toEqual([0, 1]);
    expect(painted(stitch(editor.document, TOP))).toEqual([6]);
  });
});
