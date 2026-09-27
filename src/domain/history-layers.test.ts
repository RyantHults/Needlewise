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
  pasteFragmentCommand,
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
    const result = editor.execute(line(0, 0, 2, 0, 2));
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
    expect(hidden.compositeFull).toBe(true);
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
        expect(result.compositeFull, command.type).toBe(true);
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
    expect(result.compositeFull).toBe(true);
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

  it('crops, rotates, and mirrors every layer and restores them on undo', () => {
    const editor = editorFor(3, 2);
    editor.execute(layerAddCommand(LayerType.Stitch));
    editor.execute(full(0, 0, 1));
    editor.execute(full(2, 1, 2, 3));
    editor.execute(line(0, 0, 1, 0, 1));
    editor.execute(layerSetVisibilityCommand(3, false));

    editor.execute({ type: 'rotate-cw' });
    expect([editor.document.width, editor.document.height]).toEqual([2, 3]);
    expect(stitch(editor.document, STITCHES).kind[1]).toBe(CellKind.Full);
    expect(stitch(editor.document, 3).kind[2 * 2]).toBe(CellKind.Full);
    const rotated = specialty(editor.document, SPECIALTY).backstitches;
    expect([rotated.x1[0], rotated.x2[0]]).toEqual([8, 8]);
    editor.undo();
    expect([editor.document.width, editor.document.height]).toEqual([3, 2]);
    expect(stitch(editor.document, 3).kind[5]).toBe(CellKind.Full);

    editor.execute({ type: 'mirror-horizontal' });
    expect(stitch(editor.document, STITCHES).kind[2]).toBe(CellKind.Full);
    expect(stitch(editor.document, 3).kind[3]).toBe(CellKind.Full);
    editor.undo();

    editor.execute({ type: 'crop', x: 1, y: 1, width: 2, height: 1 });
    expect([editor.document.width, editor.document.height]).toEqual([2, 1]);
    expect(stitch(editor.document, STITCHES).kind.length).toBe(2);
    expect(stitch(editor.document, 3).kind[1]).toBe(CellKind.Full);
    expect(editor.composite.width).toBe(2);
    editor.undo();
    expect(stitch(editor.document, 3).kind.length).toBe(6);
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
    editor.execute({ type: 'rotate-cw' });
    expect([editor.document.width, editor.document.height]).toEqual([3, 4]);
    expect(editor.execute({ type: 'palette-deactivate', id: 1 }).changed).toBe(true);
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

  it('stores rotations and mirrors as invertible transforms and undoes them exactly', () => {
    const editor = editorFor(5, 3);
    editor.execute(layerAddCommand(LayerType.Stitch));
    editor.execute(full(0, 0, 1));
    editor.execute({ type: 'set-half', x: 4, y: 2, direction: '/', color: 2, layerId: 3 });
    editor.execute({ type: 'set-three-quarter', x: 1, y: 2, corner: 1, color: 1, layerId: 3 });
    editor.execute(line(0, 0, 2, 1, 1));
    editor.execute(line(4, 3, 5, 0, 2));
    editor.execute(layerSetVisibilityCommand(3, false));
    const original = editor.document.layers.map(describeLayer);
    for (const command of [{ type: 'rotate-cw' }, { type: 'rotate-ccw' }, { type: 'rotate', quarterTurns: 2 }, { type: 'mirror-horizontal' }, { type: 'mirror', axis: 'vertical' }]) {
      const bytes = editor.historyBytes;
      editor.execute(command);
      expect(editor.lastHistoryEntryKind, command.type).toBe('transform');
      expect(editor.historyBytes - bytes, command.type).toBeLessThanOrEqual(64);
      const transformed = editor.document.layers.map(describeLayer);
      editor.undo();
      expect(editor.document.layers.map(describeLayer), command.type).toEqual(original);
      expect([editor.document.width, editor.document.height]).toEqual([5, 3]);
      editor.redo();
      expect(editor.document.layers.map(describeLayer), command.type).toEqual(transformed);
      editor.undo();
    }
  });

  it('stores only the planes a crop removes and replays it on redo', () => {
    const editor = editorFor(100, 100);
    editor.execute(layerAddCommand(LayerType.Stitch));
    // An empty specialty layer is unchanged by the crop and is restored from the current document.
    editor.execute(layerAddCommand(LayerType.Specialty));
    editor.execute(full(0, 0, 1));
    editor.execute(full(50, 50, 2, 3));
    editor.execute(line(10, 10, 20, 20, 1));
    const original = editor.document.layers.map(describeLayer);
    const bytes = editor.historyBytes;
    editor.execute({ type: 'crop', x: 10, y: 10, width: 60, height: 60 });
    expect(editor.lastHistoryEntryKind).toBe('replay');
    // Two stitch layers before the crop (9 bytes per cell each), the one line, and no after-side planes.
    expect(editor.historyBytes - bytes).toBeLessThan(2 * 100 * 100 * 9 + 4096);
    const cropped = editor.document.layers.map(describeLayer);
    editor.undo();
    expect(editor.document.layers.map(describeLayer)).toEqual(original);
    editor.redo();
    expect(editor.document.layers.map(describeLayer)).toEqual(cropped);
    expect([editor.document.width, editor.document.height]).toEqual([60, 60]);
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

  it('round-trips transform, replay, and group entries through the DTO', () => {
    const editor = editorFor(6, 4);
    editor.execute(full(1, 1, 1));
    editor.execute(line(0, 0, 2, 2, 2));
    editor.execute({ type: 'rotate-cw' });
    editor.execute({ type: 'crop', x: 0, y: 1, width: 3, height: 4 });
    editor.execute({ type: 'batch', commands: [layerAddCommand(LayerType.Stitch), full(0, 0, 2, 3)] });
    editor.undo();
    const exported = editor.exportHistory();
    expect(exported.undo.map((entry) => entry.kind)).toEqual(['delta', 'delta', 'transform', 'replay']);
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

    const forged = { ...exported, undo: exported.undo.map((entry) => entry.kind === 'transform' ? { ...entry, inverse: { type: 'rotate-cw', quarterTurns: 1 } } : entry) };
    expect(errorCode(() => new DocumentEditor(editor.document).importHistory(forged))).toBe('invalid-history-state');
  });
});

describe('layered DocumentEditor: structural import validation', () => {
  function rotatedHistory() {
    const editor = editorFor(4, 2);
    editor.execute(full(3, 1, 1));
    editor.execute(layerSetVisibilityCommand(SPECIALTY, false));
    editor.execute({ type: 'rotate-cw' });
    editor.execute(layerSetVisibilityCommand(SPECIALTY, true));
    return { editor, exported: editor.exportHistory() };
  }

  it('accepts a chain across a transform without replaying it', () => {
    const { editor, exported } = rotatedHistory();
    expect(exported.undo.map((entry) => entry.kind)).toEqual(['delta', 'layers', 'transform', 'layers']);
    const restored = createEditorFromHistory(editor.document, exported);
    while (restored.canUndo) restored.undo();
    expect([restored.document.width, restored.document.height]).toEqual([4, 2]);
    expect(stitch(restored.document, STITCHES).kind[7]).toBe(CellKind.Empty);
  });

  it('rejects forged structure and out-of-bounds deltas behind a transform', () => {
    const { editor, exported } = rotatedHistory();
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

  it('rejects a delta with an unknown cell kind behind a rotate', () => {
    const editor = editorFor();
    editor.execute(full(0, 0, 1));
    editor.execute({ type: 'rotate-cw' });
    const exported = editor.exportHistory();
    const delta = exported.undo[0];
    if (delta.kind !== 'delta') throw new Error('Expected a delta entry.');
    delta.delta.cells.beforeKind[0] = 77;
    expect(errorCode(() => new DocumentEditor(editor.document).importHistory(exported))).toBe('invalid-history-state');
  });

  it('rejects a layer content record with an unknown cell kind behind a rotate', () => {
    const editor = editorFor();
    editor.execute(layerAddCommand(LayerType.Stitch));
    editor.execute(full(0, 0, 1, 3));
    editor.execute(layerDeleteCommand(3));
    editor.execute({ type: 'rotate-cw' });
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
    editor.execute({ type: 'rotate-cw' });
    const exported = editor.exportHistory();
    // Dropping the paint stroke leaves the palette-create undo removing a color the cell still uses.
    const forged = { ...exported, undo: [exported.undo[0], exported.undo[2]] };
    expect(errorCode(() => new DocumentEditor(editor.document).importHistory(forged))).toBe('invalid-history-state');
  });

  it('rejects a palette change after a replayed crop that drops a color the kept content uses', () => {
    const editor = editorFor(6, 4);
    editor.execute(full(1, 1, 1));
    editor.execute(line(1, 1, 2, 1, 1));
    editor.execute({ type: 'crop', x: 0, y: 0, width: 4, height: 3 });
    editor.execute({ type: 'palette-update', id: 2, name: 'Navy' });
    editor.undo();
    editor.undo();
    const exported = editor.exportHistory();
    expect(exported.redo.map((entry) => entry.kind)).toEqual(['delta', 'replay']);
    const update = exported.redo[0];
    if (update.kind !== 'delta' || update.delta.afterPalette === undefined) throw new Error('Expected a palette delta.');
    const afterPalette = update.delta.afterPalette.filter((entry) => entry.id !== 1);
    const growth = (JSON.stringify(afterPalette).length - JSON.stringify(update.delta.afterPalette).length) * 2;
    const forged = { ...exported, redo: [{ ...update, delta: { ...update.delta, afterPalette }, bytes: update.bytes + growth }, exported.redo[1]] };
    expect(() => new DocumentEditor(editor.document).importHistory(forged)).toThrow(/redo\[0\]\.palette is incompatible/);
    expect(createEditorFromHistory(editor.document, exported).redoDepth).toBe(2);
  });

  it('imports a palette delete of a color the crop removed', () => {
    const editor = editorFor(6, 4);
    editor.execute(full(5, 3, 1));
    editor.execute(line(4, 3, 5, 3, 1));
    editor.execute(full(0, 0, 2));
    editor.execute({ type: 'crop', x: 0, y: 0, width: 4, height: 3 });
    editor.execute({ type: 'palette-delete', id: 1 });
    expect(editor.document.palette.find((entry) => entry.id === 1)?.active).toBe(false);
    editor.undo();
    editor.undo();
    const restored = createEditorFromHistory(editor.document, editor.exportHistory());
    restored.redo();
    restored.redo();
    expect(restored.document.palette.find((entry) => entry.id === 1)?.active).toBe(false);
    // The same history also imports from the far end.
    expect(createEditorFromHistory(restored.document, restored.exportHistory()).undoDepth).toBe(5);
  });

  it('rejects a crop replay whose rectangle does not produce the current size', () => {
    const editor = editorFor(6, 4);
    editor.execute(full(1, 1, 1));
    editor.execute({ type: 'crop', x: 0, y: 0, width: 3, height: 3 });
    const exported = editor.exportHistory();
    const forged = { ...exported, undo: exported.undo.map((entry) => entry.kind === 'replay' ? { ...entry, command: { type: 'crop', x: 0, y: 0, width: 2, height: 3 } } : entry) };
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
    editor.execute({ type: 'rotate-cw' });
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
    expect(restored.document.width).toBe(3);
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
