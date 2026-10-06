import { describe, expect, it } from 'vitest';
import {
  CellKind,
  createDocument,
  createEditorFromHistory,
  createLayeredDocument,
  createPatternFragment,
  DocumentEditor,
  DOCUMENT_EDITOR_HISTORY_VERSION,
  DomainError,
  LayerErrorCode,
  layerAddCommand,
  layerDeleteCommand,
  layerDuplicateCommand,
  layerMergeCommand,
  layerMoveCommand,
  layerRenameCommand,
  layerSetVisibilityCommand,
  LayerType,
  packCanvasMask,
  pasteFragmentCommand,
  unpackCanvasMask,
  type CatalogAssociation,
  type DomainCommand,
  type Layer,
  type LayeredDocument,
  type SpecialtyLayer,
  type StitchLayer
} from './index';

const CATALOG: CatalogAssociation = { catalogId: 'test', brandLabel: 'Test', colorCount: 20 };
const STITCHES = 1;
const SPECIALTY = 2;

function palette() {
  return [
    { id: 1, name: 'Red', color: '#DD3333' },
    { id: 2, name: 'Blue', color: '#3366CC' },
    { id: 3, name: 'Green', color: '#33AA55' }
  ];
}

function editorFor(width = 4, height = 3): DocumentEditor {
  return new DocumentEditor(createLayeredDocument({ width, height, catalog: CATALOG, palette: palette() }));
}

function full(x: number, y: number, color: number, layerId = STITCHES): DomainCommand {
  return { type: 'set-full', x, y, color, layerId };
}

function line(x1: number, y1: number, x2: number, y2: number, color: number, layerId = SPECIALTY): DomainCommand {
  return { type: 'add-backstitch', start: { x: x1 * 4, y: y1 * 4 }, end: { x: x2 * 4, y: y2 * 4 }, color, layerId };
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

function ids(document: LayeredDocument): number[] {
  return document.layers.map((layer) => layer.id);
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

function compositeCell(editor: DocumentEditor, x: number, y: number): { kind: number; color: number } {
  const composite = editor.composite;
  const index = y * composite.width + x;
  return { kind: composite.kind[index], color: composite.colors[index * 4] };
}

describe('layered DocumentEditor: layer-scoped commands', () => {
  it('edits only the target layer, updates the composite incrementally, and undoes by layer', () => {
    const editor = editorFor();
    const before = editor.composite;
    const result = editor.execute(full(1, 1, 1));
    expect(result.changed).toBe(true);
    expect(result.revision).toBe(1);
    expect(result.document).toBe(editor.composite);
    expect(Array.from(result.compositeChangedIndices ?? [])).toEqual([5]);
    expect(result.compositeFull).toBeUndefined();
    expect(stitch(editor.document, STITCHES).kind[5]).toBe(CellKind.Full);
    expect(compositeCell(editor, 1, 1)).toEqual({ kind: CellKind.Full, color: 1 });
    // Earlier composites and documents are immutable snapshots.
    expect(before.kind[5]).toBe(CellKind.Empty);
    expect(before).not.toBe(editor.composite);

    const undo = editor.undo();
    expect(undo.revision).toBe(2);
    expect(Array.from(undo.compositeChangedIndices ?? [])).toEqual([5]);
    expect(compositeCell(editor, 1, 1).kind).toBe(CellKind.Empty);
    editor.redo();
    expect(compositeCell(editor, 1, 1)).toEqual({ kind: CellKind.Full, color: 1 });
    expect(editor.revision).toBe(3);
  });

  it('adds backstitches on a specialty layer without touching cells', () => {
    const editor = editorFor();
    const result = editor.execute(line(0, 0, 1, 0, 2));
    expect(result.changed).toBe(true);
    expect(result.compositeChangedIndices?.length).toBe(0);
    expect(specialty(editor.document, SPECIALTY).backstitches.ids.length).toBe(1);
    expect(editor.composite.backstitches.ids.length).toBe(1);
    editor.undo();
    expect(editor.composite.backstitches.ids.length).toBe(0);
  });

  it('rejects commands on hidden, missing, or wrong-type layers and commands without a layerId', () => {
    const editor = editorFor();
    editor.execute(layerSetVisibilityCommand(STITCHES, false));
    const revision = editor.revision;
    expect(errorCode(() => editor.execute(full(0, 0, 1)))).toBe(LayerErrorCode.Hidden);
    expect(errorCode(() => editor.execute(full(0, 0, 1, SPECIALTY)))).toBe(LayerErrorCode.TypeMismatch);
    expect(errorCode(() => editor.execute(line(0, 0, 1, 0, 1, STITCHES)))).toBe(LayerErrorCode.Hidden);
    expect(errorCode(() => editor.execute(full(0, 0, 1, 99)))).toBe(LayerErrorCode.NotFound);
    expect(errorCode(() => editor.execute({ type: 'set-full', x: 0, y: 0, color: 1 }))).toBe('invalid-command');
    editor.execute(layerSetVisibilityCommand(STITCHES, true));
    expect(errorCode(() => editor.execute(line(0, 0, 1, 0, 1, STITCHES)))).toBe(LayerErrorCode.TypeMismatch);
    expect(errorCode(() => editor.execute({ type: 'batch', commands: [full(0, 0, 1), line(0, 0, 1, 0, 1)] }))).toBe('invalid-command');
    expect(editor.revision).toBe(revision + 1);
  });

  it('refuses progress edits because completion is not stored per layer', () => {
    const editor = editorFor();
    editor.execute(full(0, 0, 1));
    expect(errorCode(() => editor.execute({ type: 'set-completion', x: 0, y: 0, completed: true, layerId: STITCHES }))).toBe('invalid-command');
    expect(errorCode(() => editor.execute({ ...full(1, 0, 1), completed: true }))).toBe('invalid-command');
  });

  it('runs a batch of remove-backstitch commands on a specialty layer as one entry', () => {
    const editor = editorFor();
    editor.execute(line(0, 0, 1, 0, 1));
    editor.execute(line(0, 1, 1, 1, 1));
    editor.execute(line(0, 2, 1, 2, 1));
    const [first, second] = Array.from(specialty(editor.document, SPECIALTY).backstitches.ids);
    const depth = editor.undoDepth;
    const result = editor.execute({ type: 'batch', commands: [{ type: 'remove-backstitch', id: first, layerId: SPECIALTY }, { type: 'remove-backstitch', id: second, layerId: SPECIALTY }] });
    expect(result.changed).toBe(true);
    expect(editor.undoDepth).toBe(depth + 1);
    expect(specialty(editor.document, SPECIALTY).backstitches.ids.length).toBe(1);
    editor.undo();
    expect(specialty(editor.document, SPECIALTY).backstitches.ids.length).toBe(3);
  });

  it('covers lower stitch layers in the composite and exposes the lower cell when the top is hidden', () => {
    const editor = editorFor();
    editor.execute(layerAddCommand(LayerType.Stitch));
    const top = 3;
    editor.execute(full(0, 0, 1));
    editor.execute(full(0, 0, 2, top));
    expect(compositeCell(editor, 0, 0).color).toBe(2);
    const hidden = editor.execute(layerSetVisibilityCommand(top, false));
    expect(hidden.compositeFull).toBeUndefined();
    expect(Array.from(hidden.compositeChangedIndices ?? [])).toEqual([0]);
    expect(compositeCell(editor, 0, 0).color).toBe(1);
  });
});

describe('layered DocumentEditor: structure commands', () => {
  it('undoes and redoes add, rename, visibility, move, duplicate, delete, and merge', () => {
    const editor = editorFor();
    editor.execute(full(0, 0, 1));
    const snapshots: LayeredDocument[] = [editor.document];
    const commands: DomainCommand[] = [
      layerAddCommand(LayerType.Stitch),
      layerRenameCommand(3, 'Outline'),
      layerSetVisibilityCommand(3, false),
      layerSetVisibilityCommand(3, true),
      layerMoveCommand(3, 0),
      layerDuplicateCommand(STITCHES),
      layerDeleteCommand(SPECIALTY),
      layerMergeCommand(4, 3)
    ];
    for (const command of commands) {
      const revision = editor.revision;
      const result = editor.execute(command);
      expect(result.changed, command.type).toBe(true);
      if (command.type === 'layer-rename' || command.type === 'layer-add') {
        expect(result.compositeFull, command.type).toBeUndefined();
        expect(result.compositeUnchanged, command.type).toBe(true);
        expect(result.compositeChangedIndices?.length, command.type).toBe(0);
      } else {
        // Structure changes that keep the size report the exact changed cells.
        expect(result.compositeFull, command.type).toBeUndefined();
        expect(result.compositeChangedIndices, command.type).toBeInstanceOf(Uint32Array);
      }
      expect(editor.revision).toBe(revision + 1);
      snapshots.push(editor.document);
    }
    expect(ids(editor.document)).toEqual([3, STITCHES]);
    expect(editor.document.layers[0].name).toBe('Outline');
    for (let index = commands.length - 1; index >= 0; index -= 1) {
      editor.undo();
      expect(editor.document.layers.map(describeLayer), commands[index].type).toEqual(snapshots[index].layers.map(describeLayer));
    }
    for (let index = 0; index < commands.length; index += 1) {
      editor.redo();
      expect(editor.document.layers.map(describeLayer), commands[index].type).toEqual(snapshots[index + 1].layers.map(describeLayer));
    }
  });

  it('treats unchanged structure commands as no-ops without history', () => {
    const editor = editorFor();
    expect(editor.execute(layerRenameCommand(STITCHES, 'Stitches')).changed).toBe(false);
    expect(editor.execute(layerSetVisibilityCommand(STITCHES, true)).changed).toBe(false);
    expect(editor.undoDepth).toBe(0);
    expect(editor.revision).toBe(0);
  });

  it('merges by stack position and rejects hidden or other-type merges', () => {
    const editor = editorFor();
    editor.execute(layerAddCommand(LayerType.Stitch));
    const upper = 3;
    editor.execute(full(0, 0, 1));
    editor.execute(full(1, 0, 1));
    editor.execute(full(1, 0, 2, upper));
    editor.execute(full(2, 0, 2, upper));

    expect(errorCode(() => editor.execute(layerMergeCommand(upper, SPECIALTY)))).toBe(LayerErrorCode.MergeInvalid);
    editor.execute(layerSetVisibilityCommand(upper, false));
    expect(errorCode(() => editor.execute(layerMergeCommand(upper, STITCHES)))).toBe(LayerErrorCode.MergeInvalid);
    editor.execute(layerSetVisibilityCommand(upper, true));

    // Merge the upper layer down: the target keeps its name and position, and upper cells win.
    editor.execute(layerMergeCommand(upper, STITCHES));
    const merged = stitch(editor.document, STITCHES);
    expect(ids(editor.document)).toEqual([STITCHES, SPECIALTY]);
    expect(merged.name).toBe('Stitches');
    expect([0, 1, 2].map((index) => merged.colors[index * 4])).toEqual([1, 2, 2]);
    editor.undo();
    expect(ids(editor.document)).toEqual([STITCHES, upper, SPECIALTY]);
    expect(stitch(editor.document, STITCHES).colors[4]).toBe(1);

    // Merge the lower layer up: upper still wins conflicts.
    editor.execute(layerMergeCommand(STITCHES, upper));
    const mergedUp = stitch(editor.document, upper);
    expect(ids(editor.document)).toEqual([upper, SPECIALTY]);
    expect([0, 1, 2].map((index) => mergedUp.colors[index * 4])).toEqual([1, 2, 2]);
  });

  it('counts deleted and merged layer content toward the history limit', () => {
    const editor = editorFor(100, 100);
    const cellBytes = 100 * 100 * (1 + 8);
    const everyCell = new Uint32Array(100 * 100).map((_, index) => index);
    const fill = (target: DocumentEditor, layerId: number) => target.execute({ type: 'bulk-cell', indices: everyCell, edit: { kind: 'full', color: 1 }, layerId });
    editor.execute(layerAddCommand(LayerType.Stitch));
    const beforeAdd = editor.historyBytes;
    editor.undo();
    editor.redo();
    // A new layer is recorded as empty, not as planes.
    expect(editor.historyBytes - beforeAdd).toBe(0);
    expect(editor.historyBytes).toBeLessThan(2048);
    fill(editor, 3);
    const beforeDelete = editor.historyBytes;
    editor.execute(layerDeleteCommand(3));
    expect(editor.historyBytes - beforeDelete).toBeGreaterThanOrEqual(cellBytes);

    const renameEditor = editorFor(100, 100);
    renameEditor.execute(layerRenameCommand(STITCHES, 'Renamed'));
    expect(renameEditor.historyBytes).toBeLessThan(2048);

    const mergeEditor = editorFor(100, 100);
    mergeEditor.execute(layerAddCommand(LayerType.Stitch));
    fill(mergeEditor, 3);
    fill(mergeEditor, STITCHES);
    const beforeMerge = mergeEditor.historyBytes;
    mergeEditor.execute(layerMergeCommand(3, STITCHES));
    // Source, old target, and the new merged target are all retained.
    expect(mergeEditor.historyBytes - beforeMerge).toBeGreaterThanOrEqual(cellBytes * 3);

    const filled = createLayeredDocument({ width: 100, height: 100, catalog: CATALOG, palette: palette() });
    const filledStitches = stitch(filled, STITCHES);
    filledStitches.kind.fill(CellKind.Full);
    for (let index = 0; index < filledStitches.colors.length; index += 4) filledStitches.colors[index] = 1;
    const tight = new DocumentEditor(filled, { historyLimitBytes: cellBytes });
    expect(errorCode(() => tight.execute(layerDuplicateCommand(STITCHES)))).toBe('history-entry-too-large');
    expect(ids(tight.document)).toEqual([STITCHES, SPECIALTY]);
  });

  it('adds a layer and pastes into it as one history entry', () => {
    const source = createDocument({ width: 2, height: 1, catalog: CATALOG, palette: palette() });
    source.kind[0] = CellKind.Full;
    source.colors[0] = 1;
    source.kind[1] = CellKind.Full;
    source.colors[4] = 2;
    const fragment = createPatternFragment(source, { x: 0, y: 0, width: 2, height: 1 });
    const editor = editorFor();
    const id = editor.document.nextLayerId;
    const result = editor.execute({ type: 'batch', commands: [layerAddCommand(LayerType.Stitch, { id }), { ...pasteFragmentCommand(fragment, { x: 1, y: 1 }), layerId: id }] });
    expect(result.changed).toBe(true);
    expect(result.compositeFull).toBeUndefined();
    expect(Array.from(result.compositeChangedIndices ?? [])).toEqual([5, 6]);
    expect(editor.undoDepth).toBe(1);
    expect(stitch(editor.document, id).colors[(1 * 4 + 1) * 4]).toBe(1);
    expect(stitch(editor.document, STITCHES).kind.every((kind) => kind === CellKind.Empty)).toBe(true);
    expect(compositeCell(editor, 2, 1).color).toBe(2);
    editor.undo();
    expect(ids(editor.document)).toEqual([STITCHES, SPECIALTY]);
    expect(compositeCell(editor, 1, 1).kind).toBe(CellKind.Empty);
    editor.redo();
    expect(ids(editor.document)).toEqual([STITCHES, id, SPECIALTY]);

    // A paste without a layerId targets the layer the batch just added.
    const implicit = editorFor();
    implicit.execute({ type: 'batch', commands: [layerAddCommand(LayerType.Stitch), pasteFragmentCommand(fragment, { x: 0, y: 0 })] });
    expect(stitch(implicit.document, 3).colors[0]).toBe(1);
  });

  it('rolls back a failing compound batch atomically', () => {
    const editor = editorFor();
    const before = editor.document;
    expect(() => editor.execute({ type: 'batch', commands: [layerAddCommand(LayerType.Stitch), full(0, 0, 99, 3)] })).toThrow();
    expect(editor.document).toBe(before);
    expect(editor.undoDepth).toBe(0);
  });
});

describe('layered DocumentEditor: exact composite invalidation for structure changes', () => {
  function layeredEditor(): DocumentEditor {
    const editor = editorFor();
    editor.execute(layerAddCommand(LayerType.Stitch));
    editor.execute(full(0, 0, 1));
    editor.execute(full(1, 0, 1));
    editor.execute(full(1, 0, 2, 3));
    editor.execute(full(2, 2, 3, 3));
    return editor;
  }

  function changed(result: { compositeChangedIndices?: Uint32Array }): number[] {
    return Array.from(result.compositeChangedIndices ?? []);
  }

  it('reports only the cells that visibility, move, duplicate, merge and delete change, and the same on undo and redo', () => {
    const editor = layeredEditor();
    const cases: Array<[DomainCommand, number[]]> = [
      [layerSetVisibilityCommand(3, false), [1, 10]],
      [layerSetVisibilityCommand(3, true), [1, 10]],
      [layerMoveCommand(3, 0), [1]],
      [layerDuplicateCommand(3), []],
      [layerMergeCommand(4, STITCHES), []],
      [layerDeleteCommand(3), []],
      // The merged layer is now the only stitch layer, so deleting it empties every painted cell.
      [layerDeleteCommand(STITCHES), [0, 1, 10]]
    ];
    for (const [command, expected] of cases) {
      const before = editor.composite;
      const result = editor.execute(command);
      expect(result.compositeFull, command.type).toBeUndefined();
      expect(result.requiresFullRedraw, command.type).toBeUndefined();
      expect(changed(result), command.type).toEqual(expected);
      expect(Array.from(result.changedIndices ?? []), command.type).toEqual(expected);
      expect(result.compositeUnchanged === true, command.type).toBe(expected.length === 0);
      expect(before.kind, command.type).not.toBe(result.document.kind);
      const undone = editor.undo();
      expect(changed(undone), `undo ${command.type}`).toEqual(expected);
      const redone = editor.redo();
      expect(changed(redone), `redo ${command.type}`).toEqual(expected);
    }
  });

  it('flags a metrics rescan only when a specialty toggle changes the visible lines', () => {
    const editor = editorFor();
    editor.execute(line(0, 0, 1, 0, 1));
    const hidden = editor.execute(layerSetVisibilityCommand(SPECIALTY, false));
    expect(hidden.compositeFull).toBeUndefined();
    expect(changed(hidden)).toEqual([]);
    expect(hidden.recalculateMetrics).toBe(true);
    expect(hidden.compositeUnchanged).toBeUndefined();
    expect(hidden.document.backstitches.ids.length).toBe(0);

    const stitchesOnly = editorFor();
    stitchesOnly.execute(full(0, 0, 1));
    const toggled = stitchesOnly.execute(layerSetVisibilityCommand(SPECIALTY, false));
    expect(toggled.recalculateMetrics).toBe(false);
    expect(toggled.compositeUnchanged).toBe(true);
  });

  it('reports the pasted cells when an add-and-paste group is undone and redone', () => {
    const source = createDocument({ width: 1, height: 1, catalog: CATALOG, palette: palette() });
    source.kind[0] = CellKind.Full;
    source.colors[0] = 2;
    const fragment = createPatternFragment(source, { x: 0, y: 0, width: 1, height: 1 });
    const editor = editorFor();
    const id = editor.document.nextLayerId;
    editor.execute({ type: 'batch', commands: [layerAddCommand(LayerType.Stitch, { id }), { ...pasteFragmentCommand(fragment, { x: 3, y: 2 }), layerId: id }] });
    expect(changed(editor.undo())).toEqual([11]);
    expect(changed(editor.redo())).toEqual([11]);
  });
});

describe('layered DocumentEditor: document-scoped commands', () => {
  it('merges a palette color on every layer, including hidden ones, and changes the palette once', () => {
    const editor = editorFor();
    editor.execute(layerAddCommand(LayerType.Stitch));
    editor.execute(full(0, 0, 1));
    editor.execute(full(1, 0, 1, 3));
    editor.execute(line(0, 0, 1, 0, 1));
    editor.execute(layerSetVisibilityCommand(3, false));
    const result = editor.execute({ type: 'palette-merge', from: 1, to: 2 });
    expect(result.compositeFull).toBe(true);
    expect(stitch(editor.document, STITCHES).colors[0]).toBe(2);
    expect(stitch(editor.document, 3).colors[4]).toBe(2);
    expect(specialty(editor.document, SPECIALTY).backstitches.colors[0]).toBe(2);
    expect(editor.document.palette.filter((entry) => entry.id === 1).map((entry) => entry.active)).toEqual([false]);
    expect(editor.document.palette.length).toBe(3);
    editor.undo();
    expect(stitch(editor.document, 3).colors[4]).toBe(1);
    expect(editor.document.palette.find((entry) => entry.id === 1)?.active).toBe(true);
  });

  it('creates a merge replacement color exactly once', () => {
    const editor = editorFor();
    editor.execute(full(0, 0, 1));
    const nextPaletteId = editor.document.nextPaletteId;
    editor.execute({ type: 'palette-merge', from: 1, createTo: { name: 'New', color: '#123456' } });
    expect(editor.document.palette.filter((entry) => entry.id === nextPaletteId).length).toBe(1);
    expect(editor.document.nextPaletteId).toBe(nextPaletteId + 1);
    expect(stitch(editor.document, STITCHES).colors[0]).toBe(nextPaletteId);
  });

  it('deletes a palette color from every layer', () => {
    const editor = editorFor();
    editor.execute(layerAddCommand(LayerType.Stitch));
    editor.execute(full(0, 0, 1));
    editor.execute(full(1, 0, 1, 3));
    editor.execute(full(2, 0, 2, 3));
    editor.execute(line(0, 0, 1, 0, 1));
    editor.execute(layerSetVisibilityCommand(3, false));
    editor.execute({ type: 'palette-delete', id: 1 });
    expect(stitch(editor.document, STITCHES).kind[0]).toBe(CellKind.Empty);
    expect(stitch(editor.document, 3).kind[1]).toBe(CellKind.Empty);
    expect(stitch(editor.document, 3).kind[2]).toBe(CellKind.Full);
    expect(specialty(editor.document, SPECIALTY).backstitches.ids.length).toBe(0);
  });

  it('refuses to deactivate a color used on any layer', () => {
    const editor = editorFor();
    editor.execute(layerAddCommand(LayerType.Stitch));
    editor.execute(full(0, 0, 3, 3));
    editor.execute(layerSetVisibilityCommand(3, false));
    expect(errorCode(() => editor.execute({ type: 'palette-deactivate', id: 3 }))).toBe('palette-in-use');
    expect(editor.execute({ type: 'palette-deactivate', id: 2 }).changed).toBe(true);
    const created = editor.execute({ type: 'palette-create', name: 'Gold', color: '#DDAA00' });
    expect(created.paletteId).toBe(4);
    expect(editor.document.palette.filter((entry) => entry.id === 4).length).toBe(1);
    editor.undo();
    expect(editor.document.palette.some((entry) => entry.id === 4)).toBe(false);
  });

  it('updates aidaCount through undoable settings', () => {
    const editor = editorFor();
    const result = editor.execute({ type: 'document-settings-update', settings: { aidaCount: 18 } });
    expect(result.changed).toBe(true);
    expect(editor.document.settings.aidaCount).toBe(18);
    expect(editor.composite.settings.aidaCount).toBe(18);
    expect(editor.execute({ type: 'document-settings-update', settings: { aidaCount: 18 } }).changed).toBe(false);
    editor.undo();
    expect(editor.document.settings.aidaCount).toBe(14);
    expect(editor.composite.settings.aidaCount).toBe(14);
  });

  it('applies document commands to a pattern with no layers', () => {
    const editor = editorFor();
    editor.execute(layerDeleteCommand(SPECIALTY));
    editor.execute(layerDeleteCommand(STITCHES));
    expect(editor.execute({ type: 'palette-merge', from: 1, to: 3 }).changed).toBe(true);
    expect(editor.lastHistoryEntryKind).toBe('layers');
    expect(editor.document.palette.find((entry) => entry.id === 1)?.active).toBe(false);
    expect(editor.execute({ type: 'palette-deactivate', id: 2 }).changed).toBe(true);
  });
});

describe('layered DocumentEditor: compact entries and fast paths', () => {
  it('renames without touching the composite planes, in both directions', () => {
    const editor = editorFor();
    editor.execute(full(0, 0, 1));
    editor.execute(line(0, 0, 1, 0, 1));
    const before = editor.composite;
    const renamed = editor.execute(layerRenameCommand(STITCHES, 'Base'));
    expect(renamed.compositeFull).toBeUndefined();
    expect(renamed.compositeChangedIndices?.length).toBe(0);
    expect(renamed.compositeUnchanged).toBe(true);
    expect(renamed.requiresFullRedraw).toBeUndefined();
    expect(renamed.document).not.toBe(before);
    expect(renamed.document.revision).toBe(before.revision + 1);
    expect(renamed.document.kind).toBe(before.kind);
    expect(renamed.document.backstitches).toBe(before.backstitches);
    const undone = editor.undo();
    expect(undone.compositeChangedIndices?.length).toBe(0);
    expect(undone.compositeUnchanged).toBe(true);
    expect(undone.document.kind).toBe(before.kind);
    expect(editor.document.layers[0].name).toBe('Stitches');
  });

  it('keeps unaffected layer objects through a palette merge', () => {
    const editor = editorFor();
    editor.execute(full(0, 0, 1));
    editor.execute(line(0, 0, 1, 0, 2));
    const specialtyBefore = specialty(editor.document, SPECIALTY);
    editor.execute({ type: 'palette-merge', from: 1, to: 3 });
    expect(specialty(editor.document, SPECIALTY)).toBe(specialtyBefore);
    expect(stitch(editor.document, STITCHES).colors[0]).toBe(3);
  });

  it('records add-and-paste as a tiny structure entry plus a sparse delta in one undo step', () => {
    const source = createDocument({ width: 2, height: 1, catalog: CATALOG, palette: palette() });
    source.kind[0] = CellKind.Full;
    source.colors[0] = 1;
    const fragment = createPatternFragment(source, { x: 0, y: 0, width: 2, height: 1 });
    const editor = editorFor(200, 200);
    const id = editor.document.nextLayerId;
    editor.execute({ type: 'batch', commands: [layerAddCommand(LayerType.Stitch, { id }), { ...pasteFragmentCommand(fragment, { x: 3, y: 3 }), layerId: id }] });
    expect(editor.undoDepth).toBe(1);
    expect(editor.lastHistoryEntryKind).toBe('group');
    expect(editor.historyBytes).toBeLessThan(4096);
    const exported = editor.exportHistory();
    const group = exported.undo[0];
    if (group.kind !== 'group') throw new Error('Expected a group entry.');
    expect(group.entries.map((entry) => entry.kind)).toEqual(['layers', 'delta']);
    expect(group.entries[1].kind === 'delta' ? group.entries[1].layerId : undefined).toBe(id);
    const restored = createEditorFromHistory(editor.document, exported);
    restored.undo();
    expect(ids(restored.document)).toEqual([STITCHES, SPECIALTY]);
    restored.redo();
    expect(stitch(restored.document, id).kind[3 * 200 + 3]).toBe(CellKind.Full);
  });

  it('round-trips document-wide layers and group entries through the DTO', () => {
    const editor = editorFor(6, 4);
    editor.execute(full(1, 1, 1));
    editor.execute(line(0, 0, 2, 2, 2));
    editor.execute({ type: 'palette-merge', from: 1, to: 3 });
    editor.execute({ type: 'batch', commands: [layerAddCommand(LayerType.Stitch), full(0, 0, 2, 3)] });
    editor.undo();
    const exported = editor.exportHistory();
    expect(exported.undo.map((entry) => entry.kind)).toEqual(['delta', 'delta', 'layers']);
    expect(exported.redo.map((entry) => entry.kind)).toEqual(['group']);
    const restored = createEditorFromHistory(editor.document, exported);
    const snapshots = [restored.document.layers.map(describeLayer)];
    while (restored.canUndo) {
      restored.undo();
      snapshots.push(restored.document.layers.map(describeLayer));
    }
    expect([restored.document.width, restored.document.height]).toEqual([6, 4]);
    expect(stitch(restored.document, STITCHES).kind.every((kind) => kind === 0)).toBe(true);
    while (restored.canRedo) restored.redo();
    expect(ids(restored.document)).toEqual([STITCHES, 3, SPECIALTY]);

    const forged = { ...exported, undo: exported.undo.map((entry) => entry.kind === 'layers' ? { ...entry, after: { ...entry.after, palette: entry.after.palette?.map((color) => color.id === 1 ? { ...color, name: 'Rex' } : color) } } : entry) };
    expect(errorCode(() => new DocumentEditor(editor.document).importHistory(forged))).toBe('invalid-history-state');
  });
});

describe('layered DocumentEditor: structural import validation', () => {
  function mergedHistory() {
    const editor = editorFor(4, 2);
    editor.execute(full(3, 1, 1));
    editor.execute(layerSetVisibilityCommand(SPECIALTY, false));
    editor.execute({ type: 'palette-merge', from: 1, to: 3 });
    editor.execute(layerSetVisibilityCommand(SPECIALTY, true));
    return { editor, exported: editor.exportHistory() };
  }

  it('accepts a chain across a document-wide palette merge', () => {
    const { editor, exported } = mergedHistory();
    expect(exported.undo.map((entry) => entry.kind)).toEqual(['delta', 'layers', 'layers', 'layers']);
    const restored = createEditorFromHistory(editor.document, exported);
    while (restored.canUndo) restored.undo();
    expect([restored.document.width, restored.document.height]).toEqual([4, 2]);
    expect(stitch(restored.document, STITCHES).kind[7]).toBe(CellKind.Empty);
  });

  it('rejects forged structure and out-of-bounds deltas behind a palette merge', () => {
    const { editor, exported } = mergedHistory();
    const forgedLayer = {
      ...exported,
      undo: exported.undo.map((entry, index) => {
        if (index !== 1 || entry.kind !== 'layers') return entry;
        return { ...entry, after: { ...entry.after, layers: entry.after.layers.map((layer) => ({ ...layer, name: `${layer.name}!` })) } };
      })
    };
    expect(errorCode(() => new DocumentEditor(editor.document).importHistory(forgedLayer))).toBe('invalid-history-state');

    const forgedDelta = {
      ...exported,
      undo: exported.undo.map((entry, index) => {
        if (index !== 0 || entry.kind !== 'delta') return entry;
        return { ...entry, delta: { ...entry.delta, cells: { ...entry.delta.cells, indices: new Uint32Array([8]) } } };
      })
    };
    expect(errorCode(() => new DocumentEditor(editor.document).importHistory(forgedDelta))).toBe('invalid-history-state');
  });

  it('rejects an oldest delta that would write an unknown palette id', () => {
    const editor = editorFor();
    editor.execute(full(0, 0, 1));
    editor.execute(full(0, 0, 2));
    const exported = editor.exportHistory();
    const oldest = exported.undo[0];
    if (oldest.kind !== 'delta') throw new Error('Expected a delta entry.');
    oldest.delta.cells.beforeKind[0] = CellKind.Full;
    oldest.delta.cells.beforeColors[0] = 999;
    expect(errorCode(() => new DocumentEditor(editor.document).importHistory(exported))).toBe('invalid-history-state');
    // The untouched export still imports.
    expect(createEditorFromHistory(editor.document, editor.exportHistory()).undoDepth).toBe(2);
  });

  it('rejects a delta with an unknown cell kind', () => {
    const editor = editorFor();
    editor.execute(full(0, 0, 1));
    const exported = editor.exportHistory();
    const delta = exported.undo[0];
    if (delta.kind !== 'delta') throw new Error('Expected a delta entry.');
    delta.delta.cells.beforeKind[0] = 77;
    expect(errorCode(() => new DocumentEditor(editor.document).importHistory(exported))).toBe('invalid-history-state');
  });

  it('rejects a layer content record with an unknown cell kind', () => {
    const editor = editorFor();
    editor.execute(layerAddCommand(LayerType.Stitch));
    editor.execute(full(0, 0, 1, 3));
    editor.execute(layerDeleteCommand(3));
    const exported = editor.exportHistory();
    const deletion = exported.undo[2];
    if (deletion.kind !== 'layers') throw new Error('Expected a layers entry.');
    const record = deletion.before.layers.find((layer) => layer.id === 3);
    if (record?.kind === undefined) throw new Error('Expected stored cells.');
    record.kind[0] = 77;
    expect(errorCode(() => new DocumentEditor(editor.document).importHistory(exported))).toBe('invalid-history-state');
  });

  it('rejects a palette change that drops a color the content still uses', () => {
    const editor = editorFor();
    editor.execute({ type: 'palette-create', name: 'Gold', color: '#DDAA00' });
    editor.execute(full(0, 0, 4));
    const exported = editor.exportHistory();
    // Dropping the paint stroke leaves the palette-create undo removing a color the cell still uses.
    const forged = { ...exported, undo: [exported.undo[0]] };
    expect(errorCode(() => new DocumentEditor(editor.document).importHistory(forged))).toBe('invalid-history-state');
  });
});

describe('layered DocumentEditor: history DTO', () => {
  function busyEditor(): DocumentEditor {
    const editor = editorFor();
    editor.execute(full(0, 0, 1));
    editor.execute(layerAddCommand(LayerType.Stitch));
    editor.execute(full(0, 0, 2, 3));
    editor.execute(line(0, 0, 1, 0, 1));
    editor.execute(layerRenameCommand(3, 'Top'));
    editor.execute({ type: 'palette-update', id: 2, name: 'Navy' });
    editor.execute({ type: 'palette-merge', from: 1, to: 3 });
    editor.execute(layerDeleteCommand(STITCHES));
    editor.undo();
    editor.undo();
    return editor;
  }

  it('round-trips v2 history with layer ids and structure entries', () => {
    const editor = busyEditor();
    const exported = editor.exportHistory();
    expect(exported.version).toBe(DOCUMENT_EDITOR_HISTORY_VERSION);
    expect(exported.undo.map((entry) => entry.kind)).toEqual(['delta', 'layers', 'delta', 'delta', 'layers', 'delta']);
    expect(exported.undo.map((entry) => entry.kind === 'delta' ? entry.layerId : undefined)).toEqual([STITCHES, undefined, 3, SPECIALTY, undefined, null]);

    const restored = createEditorFromHistory(editor.document, exported);
    expect(restored.undoDepth).toBe(6);
    expect(restored.redoDepth).toBe(2);
    expect(restored.historyBytes).toBe(editor.historyBytes);
    while (restored.canUndo) restored.undo();
    expect(ids(restored.document)).toEqual([STITCHES, SPECIALTY]);
    expect(restored.document.layers.every((layer) => layer.type !== LayerType.Stitch || layer.kind.every((kind) => kind === 0))).toBe(true);
    while (restored.canRedo) restored.redo();
    expect(ids(restored.document)).toEqual([3, SPECIALTY]);
    expect(restored.document.palette.find((entry) => entry.id === 1)?.active).toBe(false);
  });

  it('exports no repeated object or typed-array references and omits unchanged content', () => {
    const exported = busyEditor().exportHistory();
    const seen = new Set<object>();
    const walk = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) return;
      expect(seen.has(value)).toBe(false);
      seen.add(value);
      if (ArrayBuffer.isView(value)) return;
      for (const child of Object.values(value)) walk(child);
    };
    walk(exported);
    const rename = exported.undo[4];
    if (rename.kind !== 'layers') throw new Error('Expected a layers entry.');
    expect(rename.before.layers.every((layer) => layer.kind === undefined && layer.backstitches === undefined)).toBe(true);
    expect(rename.before.palette).toBeUndefined();
  });

  it('rejects v1, incompatible, and non-canonical history without changing the editor', () => {
    const editor = busyEditor();
    const exported = editor.exportHistory();
    const fresh = new DocumentEditor(editor.document);
    expect(errorCode(() => fresh.importHistory({ ...exported, version: 1 }))).toBe('unsupported-history-version');
    expect(errorCode(() => fresh.importHistory({ ...exported, undo: exported.undo.map((entry, index) => index === 0 ? { ...entry, bytes: entry.bytes + 1 } : entry) }))).toBe('invalid-history-state');
    expect(errorCode(() => new DocumentEditor(editorFor().document).importHistory(exported))).toBe('invalid-history-state');
    expect(fresh.undoDepth).toBe(0);
  });
});

function describeLayer(layer: Layer): unknown {
  return layer.type === LayerType.Stitch
    ? { id: layer.id, name: layer.name, visible: layer.visible, kind: Array.from(layer.kind), colors: Array.from(layer.colors) }
    : { id: layer.id, name: layer.name, visible: layer.visible, lines: Array.from(layer.backstitches.ids) };
}

describe('layered DocumentEditor: canvas edits', () => {
  function canvasCommand(top: number, right: number, bottom: number, left: number): DomainCommand {
    return { type: 'canvas-resize', edges: { top, right, bottom, left } };
  }

  function cellsCommand(operation: 'add' | 'remove', x: number, y: number, width = 1, height = 1, cells?: Uint8Array): DomainCommand {
    return { type: 'canvas-cells', operation, rect: { x, y, width, height }, ...(cells === undefined ? {} : { cells }) };
  }

  /** Content on every layer kind, including a hidden stitch layer, and three lines so a dropped middle line tests store order. */
  function seededEditor(): DocumentEditor {
    const editor = editorFor(5, 4);
    editor.execute(layerAddCommand(LayerType.Stitch));
    editor.execute(full(0, 0, 1));
    editor.execute(full(4, 3, 2));
    editor.execute(full(2, 1, 3));
    editor.execute(full(1, 2, 2, 3));
    editor.execute(full(4, 0, 1, 3));
    editor.execute(line(0, 0, 5, 0, 1));
    editor.execute(line(2, 1, 3, 2, 2));
    editor.execute(line(0, 4, 5, 4, 3));
    editor.execute(layerSetVisibilityCommand(3, false));
    return editor;
  }

  function fingerprint(document: LayeredDocument): unknown {
    return {
      width: document.width,
      height: document.height,
      originX: 'originX' in document ? document.originX : 'absent',
      originY: 'originY' in document ? document.originY : 'absent',
      canvasMask: 'canvasMask' in document ? Array.from(document.canvasMask ?? []) : 'absent',
      layers: document.layers.map((layer) => layer.type === LayerType.Stitch
        ? { id: layer.id, visible: layer.visible, kind: Array.from(layer.kind), colors: Array.from(layer.colors), completed: Array.from(layer.completed) }
        : { id: layer.id, visible: layer.visible, store: Object.fromEntries(Object.entries(layer.backstitches).map(([key, values]) => [key, Array.from(values as ArrayLike<number>)])) })
    };
  }

  function expectCompositeFrame(editor: DocumentEditor): void {
    const { composite, document } = editor;
    expect(composite.canvasMask).toBe(document.canvasMask);
    expect([composite.originX, composite.originY, composite.width, composite.height]).toEqual([document.originX, document.originY, document.width, document.height]);
  }

  /** Executes, then checks undo and redo restore both states bit for bit. */
  function roundTrip(editor: DocumentEditor, command: DomainCommand): void {
    const before = fingerprint(editor.document);
    const executed = editor.execute(command);
    expect(executed.changed).toBe(true);
    expect(executed.compositeFull).toBe(true);
    expect(executed.recalculateMetrics).toBe(true);
    expect(editor.lastHistoryEntryKind).toBe('canvas');
    expectCompositeFrame(editor);
    const after = fingerprint(editor.document);
    editor.undo();
    expect(fingerprint(editor.document)).toEqual(before);
    expectCompositeFrame(editor);
    editor.redo();
    expect(fingerprint(editor.document)).toEqual(after);
    expectCompositeFrame(editor);
  }

  it('routes canvas commands through execute and carries the frame onto the composite', () => {
    const editor = editorFor(3, 2);
    const result = editor.execute(canvasCommand(1, 0, 0, 2));
    expect([result.document.width, result.document.height, result.document.originX, result.document.originY]).toEqual([5, 3, -2, -1]);
    expect(editor.undoDepth).toBe(1);
    expect(editor.document.revision).toBe(1);
    const masked = editor.execute(cellsCommand('remove', 0, 0));
    expect(masked.document.canvasMask).toBe(editor.document.canvasMask);
    expect(masked.document.canvasMask?.[0]).toBe(0);
  });

  it('round-trips growing and shrinking each edge bit for bit across every layer', () => {
    const editor = seededEditor();
    roundTrip(editor, canvasCommand(2, 0, 0, 0));
    roundTrip(editor, canvasCommand(0, 3, 0, 0));
    roundTrip(editor, canvasCommand(0, 0, 1, 0));
    roundTrip(editor, canvasCommand(0, 0, 0, 4));
    roundTrip(editor, canvasCommand(-3, 0, 0, 0));
    roundTrip(editor, canvasCommand(0, -4, 0, 0));
    roundTrip(editor, canvasCommand(0, 0, -2, 0));
    roundTrip(editor, canvasCommand(0, 0, 0, -5));
    expect([editor.document.width, editor.document.height]).toEqual([3, 2]);
  });

  it('round-trips adding, removing and re-filling cells, and undo past the first advanced edit restores the rectangle', () => {
    const editor = seededEditor();
    const rectangle = fingerprint(editor.document);
    // Removes (2, 1), (1, 2) and (2, 2): content on the visible and the hidden stitch layer, and the middle line.
    roundTrip(editor, cellsCommand('remove', 1, 1, 2, 2, new Uint8Array([0, 1, 1, 1])));
    expect(editor.document.canvasMask).toBeDefined();
    // The two edge lines survive as five one-cell records each.
    expect(specialty(editor.document, SPECIALTY).backstitches.ids).toHaveLength(10);
    roundTrip(editor, cellsCommand('add', -2, -1));
    expect([editor.document.width, editor.document.height, editor.document.originX, editor.document.originY]).toEqual([7, 5, -2, -1]);
    // Local coordinates follow the box: its top row now holds only the added cell.
    roundTrip(editor, cellsCommand('remove', 0, 0, 7, 1));
    expect([editor.document.width, editor.document.height]).toEqual([5, 4]);
    expect('originX' in editor.document || 'originY' in editor.document).toBe(false);
    roundTrip(editor, cellsCommand('add', 1, 1, 2, 2));
    expect(editor.document.canvasMask).toBeUndefined();
    while (editor.canUndo && editor.lastHistoryEntryKind === 'canvas') editor.undo();
    expect(fingerprint(editor.document)).toEqual(rectangle);
    expect('canvasMask' in editor.document).toBe(false);
  });

  it('keeps layer structure and layer edits undoable on a masked canvas', () => {
    const editor = seededEditor();
    editor.execute(cellsCommand('remove', 2, 2));
    const masked = fingerprint(editor.document);
    editor.execute(layerAddCommand(LayerType.Stitch));
    editor.execute(full(0, 1, 1, 4));
    editor.execute(layerDeleteCommand(3));
    editor.undo();
    editor.undo();
    editor.undo();
    expect(fingerprint(editor.document)).toEqual(masked);
    const restored = createEditorFromHistory(editor.document, editor.exportHistory());
    while (restored.canRedo) restored.redo();
    expect(ids(restored.document)).toEqual([STITCHES, 4, SPECIALTY]);
    expect(restored.document.canvasMask).toEqual(editor.document.canvasMask);
  });

  it('rejects imported layer edits that write into a hole', () => {
    const editor = seededEditor();
    editor.execute(cellsCommand('remove', 2, 2));
    editor.execute(full(1, 1, 1));
    editor.undo();
    const exported = editor.exportHistory();
    const paint = exported.redo[0];
    if (paint.kind !== 'delta') throw new Error('Expected a delta entry.');
    expect(createEditorFromHistory(editor.document, exported).redoDepth).toBe(1);
    const hole = 2 * 5 + 2;
    const forged = { ...exported, redo: [{ ...paint, delta: { ...paint.delta, cells: { ...paint.delta.cells, indices: new Uint32Array([hole]) } } }] };
    expect(errorCode(() => new DocumentEditor(editor.document).importHistory(forged))).toBe('invalid-history-state');
  });

  it('treats an origin of 0 and an absent origin as the same state on import', () => {
    const editor = seededEditor();
    editor.execute(canvasCommand(0, 0, 0, 1));
    editor.execute(canvasCommand(0, 0, 0, -1));
    expect('originX' in editor.document).toBe(false);
    const exported = editor.exportHistory();
    // A decoder may drop zero origins, or a caller may spell them out.
    const decoded: LayeredDocument = { ...editor.document };
    delete decoded.originX;
    delete decoded.originY;
    for (const current of [decoded, { ...editor.document, originX: 0, originY: 0 }]) {
      const restored = createEditorFromHistory(current, exported);
      restored.undo();
      expect(restored.document.originX).toBe(-1);
      restored.undo();
      expect('originX' in restored.document).toBe(false);
    }
  });

  it('undoes a resize whose new box does not overlap the old one', () => {
    const editor = editorFor(1, 4);
    editor.execute(full(0, 0, 1));
    editor.execute(full(0, 3, 2));
    editor.execute(line(0, 1, 1, 1, 3));
    roundTrip(editor, canvasCommand(-1, -2, 0, 2));
    expect([editor.document.width, editor.document.height]).toEqual([1, 3]);
    expect(createEditorFromHistory(editor.document, editor.exportHistory()).undoDepth).toBe(editor.undoDepth);
  });

  it('stores the before mask of a stroke on a 1000 by 1000 masked canvas packed to bits', () => {
    const editor = editorFor(1000, 1000);
    editor.execute(cellsCommand('remove', 500, 500));
    const bytes = editor.historyBytes;
    editor.execute(cellsCommand('remove', 10, 10, 5, 5));
    expect(editor.historyBytes - bytes).toBeLessThan(140 * 1024);
    const entry = editor.exportHistory().undo.at(-1);
    if (entry?.kind !== 'canvas') throw new Error('Expected a canvas entry.');
    expect(entry.before.canvasMaskBits).toHaveLength(125_000);
    editor.undo();
    expect(editor.document.canvasMask?.[10 * 1000 + 10]).toBe(1);
    expect(editor.document.canvasMask?.[500 * 1000 + 500]).toBe(0);
  });

  it('stores twenty top-row additions on a 200 by 200 canvas compactly', () => {
    const editor = editorFor(200, 200);
    editor.execute(layerAddCommand(LayerType.Stitch));
    editor.execute(full(10, 10, 1));
    editor.execute(full(20, 20, 2, 3));
    const bytes = editor.historyBytes;
    for (let step = 0; step < 20; step += 1) editor.execute(canvasCommand(1, 0, 0, 0));
    expect(editor.document.height).toBe(220);
    expect(editor.historyBytes - bytes).toBeLessThan(64 * 1024);
    for (let step = 0; step < 20; step += 1) editor.undo();
    expect(stitch(editor.document, 3).kind[20 * 200 + 20]).toBe(CellKind.Full);
  });

  it('records nothing for a no-op and rejects canvas edits batched with other edits', () => {
    const editor = editorFor(3, 2);
    expect(editor.execute(canvasCommand(0, 0, 0, 0)).changed).toBe(false);
    expect(editor.execute(cellsCommand('add', 0, 0)).changed).toBe(false);
    expect(editor.undoDepth).toBe(0);
    expect(errorCode(() => editor.batch([cellsCommand('remove', 0, 0), full(1, 1, 1)]))).toBe('invalid-command');
    expect(errorCode(() => editor.batch([layerAddCommand(LayerType.Stitch), canvasCommand(1, 0, 0, 0)]))).toBe('invalid-command');
    expect(editor.undoDepth).toBe(0);
    const before = fingerprint(editor.document);
    editor.batch([canvasCommand(1, 0, 0, 0), cellsCommand('remove', 0, 0)]);
    expect(editor.undoDepth).toBe(1);
    expect(editor.lastHistoryEntryKind).toBe('group');
    editor.undo();
    expect(fingerprint(editor.document)).toEqual(before);
  });

  function historyWithCanvasEntries(): DocumentEditor {
    const editor = seededEditor();
    editor.execute(canvasCommand(1, 0, 0, 2));
    editor.execute(canvasCommand(0, -1, 0, 0));
    editor.execute(full(0, 0, 2));
    editor.execute(cellsCommand('remove', 3, 2, 2, 2));
    editor.execute(cellsCommand('add', -1, 0, 1, 1));
    editor.undo();
    return editor;
  }

  it('round-trips canvas entries through the history DTO', () => {
    const editor = historyWithCanvasEntries();
    const exported = editor.exportHistory();
    expect(exported.undo.map((entry) => entry.kind).slice(-4)).toEqual(['canvas', 'canvas', 'delta', 'canvas']);
    const removed = exported.undo.at(-1);
    if (removed?.kind !== 'canvas') throw new Error('Expected a canvas entry.');
    expect(removed.removal.cells.length).toBeGreaterThan(0);
    expect(removed.removal.backstitches.length).toBeGreaterThan(0);
    expect(exported.redo.map((entry) => entry.kind)).toEqual(['canvas']);
    const restored = createEditorFromHistory(editor.document, exported);
    expect(restored.historyBytes).toBe(editor.historyBytes);
    while (editor.canUndo) {
      editor.undo();
      restored.undo();
      expect(fingerprint(restored.document)).toEqual(fingerprint(editor.document));
    }
    while (editor.canRedo) {
      editor.redo();
      restored.redo();
      expect(fingerprint(restored.document)).toEqual(fingerprint(editor.document));
      expectCompositeFrame(restored);
    }
  });

  it('rejects forged canvas entries', () => {
    const editor = historyWithCanvasEntries();
    const exported = editor.exportHistory();
    const lastCanvas = exported.undo.length - 1;
    const forge = (patch: (entry: Extract<typeof exported.undo[number], { kind: 'canvas' }>) => unknown, index = lastCanvas): unknown => ({
      ...exported,
      undo: exported.undo.map((entry, position) => position === index && entry.kind === 'canvas' ? patch(entry) : entry)
    });
    const rejects = (state: unknown): void => {
      expect(errorCode(() => new DocumentEditor(editor.document).importHistory(state))).toBe('invalid-history-state');
    };
    rejects(forge((entry) => ({ ...entry, before: { ...entry.before, width: entry.before.width + 1 } })));
    const removalIndex = exported.undo.findIndex((entry) => entry.kind === 'canvas' && entry.removal.cells.length > 0);
    rejects(forge((entry) => ({
      ...entry,
      removal: { ...entry.removal, cells: entry.removal.cells.map((cells) => ({ ...cells, indices: Uint32Array.from(cells.indices, (index) => index + 10_000) })) }
    }), removalIndex));
    // Only the redo entry was recorded on a masked canvas, a 6 by 5 box whose 30 cells leave two padding bits.
    const masked = exported.redo[0];
    if (masked.kind !== 'canvas' || masked.before.canvasMaskBits === undefined) throw new Error('Expected a masked canvas entry.');
    const bits = masked.before.canvasMaskBits;
    const cellCount = masked.before.width * masked.before.height;
    expect([cellCount, bits.length]).toEqual([30, 4]);
    const withBits = (canvasMaskBits: Uint8Array): unknown => ({ ...exported, redo: [{ ...masked, before: { ...masked.before, canvasMaskBits } }] });
    rejects(withBits(bits.slice(0, 3)));
    rejects(withBits(Uint8Array.from([...bits, 0])));
    rejects(withBits(Uint8Array.from(bits, (byte, index) => index === bits.length - 1 ? byte | 0x80 : byte)));
    rejects(withBits(packCanvasMask(unpackCanvasMask(bits, cellCount).map((value) => 1 - value))));
    rejects(withBits(packCanvasMask(new Uint8Array(cellCount).fill(1))));
    // A removal that moves a cell somewhere else replays to a different document.
    rejects(forge((entry) => ({
      ...entry,
      removal: { ...entry.removal, cells: entry.removal.cells.map((cells) => ({ ...cells, indices: Uint32Array.from(cells.indices, (index) => index + 1) })) }
    }), removalIndex));
    rejects({ ...exported, redo: exported.redo.map((entry) => entry.kind === 'canvas' ? { ...entry, command: { ...entry.command, operation: 'flip' } } : entry) });
    // The untouched export still imports.
    expect(createEditorFromHistory(editor.document, exported).undoDepth).toBe(editor.undoDepth);
  });
});
