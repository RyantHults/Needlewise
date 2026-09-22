import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  assertValidDocument,
  bulkCellCommand,
  bulkClearCompletionCommand,
  bulkClearBackstitchCompletionCommand,
  bulkCompletionCommand,
  bulkEraseCellCommand,
  bulkEraseQuarterCommand,
  bulkSetCompletionCommand,
  bulkSetBackstitchCompletionCommand,
  bulkSetFullCommand,
  bulkSetHalfCommand,
  bulkSetQuarterCommand,
  bulkSetThreeQuarterCommand,
  bulkToggleCompletionCommand,
  bulkToggleBackstitchCompletionCommand,
  bulkRecolorCommand,
  CellKind,
  cloneDocument,
  createDocument,
  createEditor,
  defaultPaletteSymbol,
  deleteRegionCommand,
  deleteCellSetCommand,
  createPatternFragment,
  createPatternFragmentFromCells,
  assertValidPatternFragment,
  getBackstitch,
  getCell,
  getQuarter,
  HalfDirection,
  isAlphanumericSymbol,
  isQuarterKind,
  isThreeQuarterKind,
  listBackstitches,
  MaterialKind,
  MaterialUnit,
  MAX_PALETTE_SYMBOL_LENGTH,
  MAX_PERSISTABLE_CELL_COUNT,
  mixedEraseCommand,
  pasteFragmentCommand,
  preflightBulkCompletionCommand,
  preflightBulkRecolorCommand,
  QuarterCorner,
  readPatternFragmentCell,
  validateDocument,
  validatePatternFragment,
  DEFAULT_HISTORY_LIMIT_BYTES,
  DomainError,
  estimateBulkCellHistoryBytes,
  estimateBulkRecolorHistoryBytes,
  estimateBulkCompletionHistoryBytes,
  estimateBulkBackstitchCompletionHistoryBytes,
  estimatePasteFragmentHistoryBytes,
  estimateMoveFragmentHistoryBytes,
  estimateMixedEraseHistoryBytes,
  estimateDeleteRegionHistoryBytes,
  estimateDeleteCellSetHistoryBytes,
  mergePaletteCommand,
  moveFragmentCommand,
  PALETTE_SYMBOLS,
  type PatternDocument,
  type CatalogAssociation,
  type PatternFragment,
  computePatternMetrics
} from './index';

const TEST_CATALOG: CatalogAssociation = {
  catalogId: 'test-catalog',
  brandLabel: 'Test Catalog',
  colorCount: 489
};

const TEST_REFERENCE = {
  catalogId: TEST_CATALOG.catalogId,
  sourceId: 'test-source',
  code: 'T1',
  name: 'Test Red',
  hex: '#123456',
  rgb: [18, 52, 86] as const
};

function document(width = 4, height = 3) {
  return createDocument({
    width,
    height,
    catalog: TEST_CATALOG,
    palette: [
      { id: 1, name: 'Red', color: '#d33' },
      { id: 2, name: 'Blue', color: '#36c' },
      { id: 3, name: 'Gold', color: '#da2' }
    ]
  });
}

function apply(pattern: ReturnType<typeof document>, command: Parameters<typeof applyCommand>[1]) {
  return applyCommand(pattern, command).document;
}

function cellSnapshot(pattern: PatternDocument): PatternDocument {
  return {
    ...pattern,
    kind: pattern.kind.slice(),
    colors: pattern.colors.slice(),
    completed: pattern.completed.slice(),
    backstitches: {
      ids: pattern.backstitches.ids.slice(),
      x1: pattern.backstitches.x1.slice(),
      y1: pattern.backstitches.y1.slice(),
      x2: pattern.backstitches.x2.slice(),
      y2: pattern.backstitches.y2.slice(),
      colors: pattern.backstitches.colors.slice(),
      completed: pattern.backstitches.completed.slice()
    },
    palette: pattern.palette.map((entry) => ({ ...entry }))
  };
}

function documentContentSnapshot(pattern: PatternDocument) {
  return {
    kind: pattern.kind.slice(),
    colors: pattern.colors.slice(),
    completed: pattern.completed.slice(),
    backstitches: {
      ids: pattern.backstitches.ids.slice(),
      x1: pattern.backstitches.x1.slice(),
      y1: pattern.backstitches.y1.slice(),
      x2: pattern.backstitches.x2.slice(),
      y2: pattern.backstitches.y2.slice(),
      colors: pattern.backstitches.colors.slice(),
      completed: pattern.backstitches.completed.slice()
    },
    palette: pattern.palette.map((entry) => ({
      ...entry,
      material: { ...entry.material },
      ...(entry.catalog === undefined ? {} : { catalog: { ...entry.catalog, rgb: [...entry.catalog.rgb] } })
    })),
    settings: { ...pattern.settings },
    nextBackstitchId: pattern.nextBackstitchId,
    nextPaletteId: pattern.nextPaletteId
  };
}

describe('document catalog association', () => {
  it('preserves the catalog association through clone, command, undo, and redo', () => {
    const pattern = createDocument({ width: 2, height: 2, catalog: TEST_CATALOG });
    const editor = createEditor(pattern);
    const changed = editor.execute({ type: 'palette-create', name: 'Blue', color: '#0000FF' }).document;

    expect(cloneDocument(changed).catalog).toEqual(TEST_CATALOG);
    expect(editor.undo().document.catalog).toEqual(TEST_CATALOG);
    expect(editor.redo().document.catalog).toEqual(TEST_CATALOG);
  });

  it('rejects a palette-create reference from a different catalog', () => {
    const pattern = createDocument({ width: 1, height: 1, catalog: TEST_CATALOG });

    expect(() => applyCommand(pattern, {
      type: 'palette-create',
      name: 'Foreign',
      color: '#000000',
      catalog: { ...TEST_REFERENCE, catalogId: 'other' }
    })).toThrow('belongs to a different catalog');
  });

  it('uses the document association color count for palette capacity', () => {
    const catalog: CatalogAssociation = { ...TEST_CATALOG, colorCount: 2 };
    const pattern = createDocument({
      width: 1,
      height: 1,
      catalog,
      palette: [
        { id: 1, name: 'One', color: '#111111' },
        { id: 2, name: 'Two', color: '#222222' }
      ]
    });

    expect(() => applyCommand(pattern, { type: 'palette-create', name: 'Three', color: '#333333' })).toThrow(/color count \(2\)/);
  });

  it('requires a well-formed document catalog association', () => {
    const missing = { ...document(), catalog: undefined } as unknown as PatternDocument;
    expect(() => assertValidDocument(missing)).toThrow(/catalog/i);

    const malformed = { ...document(), catalog: { ...TEST_CATALOG, colorCount: 0 } } as unknown as PatternDocument;
    expect(() => assertValidDocument(malformed)).toThrow(/color count/i);
  });

  it('allows catalog-less custom palette entries', () => {
    const pattern = createDocument({
      width: 1,
      height: 1,
      catalog: TEST_CATALOG,
      palette: [{ name: 'Custom', color: '#abcdef', material: { kind: MaterialKind.Custom, label: 'hand dyed', unit: MaterialUnit.Count } }]
    });

    expect(pattern.palette[0].catalog).toBeUndefined();
    expect(validateDocument(pattern)).toBe(true);
  });
});

describe('typed-array pattern document', () => {
  it('uses compact arrays and preserves completion for recolor but not geometry changes', () => {
    const pattern = document();
    expect(pattern.kind).toBeInstanceOf(Uint8Array);
    expect(pattern.colors).toBeInstanceOf(Uint16Array);
    expect(pattern.completed).toBeInstanceOf(Uint8Array);
    expect(pattern.kind.length).toBe(12);
    expect(pattern.colors.length).toBe(48);

    let next = apply(pattern, { type: 'set-full', x: 1, y: 1, color: 1, completed: true });
    expect(getCell(next, 1, 1).completed).toBe(false);
    next = apply(next, { type: 'set-completion', x: 1, y: 1, completed: true });
    next = apply(next, { type: 'set-full', x: 1, y: 1, color: 2 });
    expect(getCell(next, 1, 1).color).toBe(2);
    expect(getCell(next, 1, 1).completed).toBe(true);

    next = apply(next, { type: 'set-half', x: 1, y: 1, direction: HalfDirection.Slash, color: 2 });
    expect(getCell(next, 1, 1).kind).toBe(CellKind.HalfSlash);
    expect(getCell(next, 1, 1).completed).toBe(false);
    next = apply(next, { type: 'set-half', x: 0, y: 0, direction: HalfDirection.Backslash, color: 1, completed: true });
    expect(getCell(next, 0, 0).completed).toBe(false);
  });

  it('keeps independent quarter slots and completion bits', () => {
    let pattern = document();
    pattern = apply(pattern, { type: 'set-quarter', x: 0, y: 0, corner: QuarterCorner.NW, color: 1, completed: true });
    expect(getCell(pattern, 0, 0).quarters[QuarterCorner.NW].completed).toBe(false);
    pattern = apply(pattern, { type: 'set-completion', x: 0, y: 0, corner: QuarterCorner.NW, completed: true });
    pattern = apply(pattern, { type: 'set-quarter', x: 0, y: 0, corner: QuarterCorner.SE, color: 2 });
    const cell = getCell(pattern, 0, 0);
    expect(cell.kind).toBe(CellKind.Quarters);
    expect(cell.quarters[QuarterCorner.NW]).toMatchObject({ color: 1, completed: true });
    expect(cell.quarters[QuarterCorner.SE]).toMatchObject({ color: 2, completed: false });
    expect(pattern.completed[0]).toBe(1);

    pattern = apply(pattern, { type: 'set-full', x: 0, y: 0, color: 3 });
    expect(getCell(pattern, 0, 0).kind).toBe(CellKind.Full);
    expect(pattern.colors.slice(0, 4)).toEqual(new Uint16Array([3, 0, 0, 0]));
    expect(pattern.completed[0]).toBe(0);
  });

  it('writes a homogeneous three-quarter geometry from each pointer corner', () => {
    const expected: Array<[QuarterCorner, number[]]> = [
      [QuarterCorner.NW, [CellKind.ThreeQuarterNW, 2, 0, 0, 0]],
      [QuarterCorner.NE, [CellKind.ThreeQuarterNE, 2, 0, 0, 0]],
      [QuarterCorner.SE, [CellKind.ThreeQuarterSE, 2, 0, 0, 0]],
      [QuarterCorner.SW, [CellKind.ThreeQuarterSW, 2, 0, 0, 0]]
    ];
    for (const [corner, [kind, ...colors]] of expected) {
      const result = applyCommand(document(), { type: 'set-three-quarter', x: 0, y: 0, corner, color: 2 });
      expect(result.document.kind[0]).toBe(kind);
      expect(Array.from(result.document.colors.slice(0, 4))).toEqual(colors);
      expect(result.document.completed[0]).toBe(0);
    }
  });

  it('keeps three-quarter cells separate from legacy quarter slots', () => {
    const pattern = apply(document(), { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.SE, color: 2 });
    expect(pattern.kind[0]).toBe(CellKind.ThreeQuarterSE);
    expect(pattern.colors.slice(0, 4)).toEqual(new Uint16Array([2, 0, 0, 0]));
    expect(getCell(pattern, 0, 0).quarters).toEqual([
      { color: 0, completed: false },
      { color: 0, completed: false },
      { color: 0, completed: false },
      { color: 0, completed: false }
    ]);
    expect(getQuarter(pattern, 0, 0, QuarterCorner.SE)).toEqual({ color: 0, completed: false });
    expect(isQuarterKind(pattern.kind[0])).toBe(false);
    expect(isThreeQuarterKind(pattern.kind[0])).toBe(true);

    const invalid = document();
    invalid.kind[0] = CellKind.ThreeQuarterNW;
    invalid.colors[0] = 1;
    invalid.colors[1] = 2;
    expect(validateDocument(invalid)).toBe(false);
    invalid.colors[1] = 0;
    invalid.completed[0] = 2;
    expect(validateDocument(invalid)).toBe(false);
  });

  it('pairs opposite three-quarter corners while making adjacent clicks exact no-ops', () => {
    let pattern = document();
    pattern = apply(pattern, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.NE, color: 1 });
    pattern = apply(pattern, { type: 'set-completion', x: 0, y: 0, completed: true });
    const editor = createEditor(pattern);
    const beforeAdjacent = cellSnapshot(editor.document);
    const adjacent = editor.execute({ type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.NW, color: 2 });
    expect(adjacent.changed).toBe(false);
    expect(editor.document).toEqual(beforeAdjacent);
    expect(editor.revision).toBe(beforeAdjacent.revision);
    expect(editor.undoDepth).toBe(0);

    const paired = editor.execute({ type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.SW, color: 2 });
    expect(paired.changed).toBe(true);
    expect(editor.document.kind[0]).toBe(CellKind.ThreeQuarterPair);
    expect(editor.document.colors.slice(0, 4)).toEqual(new Uint16Array([0, 1, 0, 2]));
    expect(editor.document.completed[0]).toBe(2);

    const beforePairAdjacent = cellSnapshot(editor.document);
    const pairAdjacent = editor.execute({ type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.NW, color: 3 });
    expect(pairAdjacent.changed).toBe(false);
    expect(editor.document).toEqual(beforePairAdjacent);
    expect(editor.revision).toBe(beforePairAdjacent.revision);

    const bulkAdjacent = editor.execute(bulkSetThreeQuarterCommand(new Uint32Array([0]), QuarterCorner.NW, 3));
    expect(bulkAdjacent.changed).toBe(false);
    expect(editor.document).toEqual(beforePairAdjacent);
    expect(editor.revision).toBe(beforePairAdjacent.revision);

    const bulkCompletion = editor.execute(bulkSetCompletionCommand(new Uint32Array([0])));
    expect(bulkCompletion.changedIndices).toEqual(new Uint32Array([0]));
    expect(bulkCompletion.progress).toMatchObject({ marked: 1, unmarked: 0 });
    expect(editor.document.completed[0]).toBe(10);

    const recolored = editor.execute({ type: 'recolor-cell', x: 0, y: 0, corner: QuarterCorner.SW, color: 3 });
    expect(recolored.changed).toBe(true);
    expect(editor.document.colors.slice(0, 4)).toEqual(new Uint16Array([0, 1, 0, 3]));
    expect(editor.document.completed[0]).toBe(10);
    const beforeRecolorAdjacent = cellSnapshot(editor.document);
    expect(editor.execute({ type: 'recolor-cell', x: 0, y: 0, corner: QuarterCorner.NW, color: 2 }).changed).toBe(false);
    expect(editor.document).toEqual(beforeRecolorAdjacent);
  });

  it('erases paired components independently and canonicalizes the survivor', () => {
    let pattern = document();
    pattern = apply(pattern, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.NW, color: 1 });
    pattern = apply(pattern, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.SE, color: 2 });
    pattern = apply(pattern, { type: 'set-completion', x: 0, y: 0, corner: QuarterCorner.SE, completed: true });
    const editor = createEditor(pattern);

    const erased = editor.execute({ type: 'erase-quarter', x: 0, y: 0, corner: QuarterCorner.NW });
    expect(erased.changed).toBe(true);
    expect(editor.document.kind[0]).toBe(CellKind.ThreeQuarterSE);
    expect(editor.document.colors.slice(0, 4)).toEqual(new Uint16Array([2, 0, 0, 0]));
    expect(editor.document.completed[0]).toBe(1);

    const adjacent = editor.execute({ type: 'erase-quarter', x: 0, y: 0, corner: QuarterCorner.NE });
    expect(adjacent.changed).toBe(false);
    expect(editor.document.kind[0]).toBe(CellKind.ThreeQuarterSE);
    const whole = editor.execute({ type: 'erase-cell', x: 0, y: 0 });
    expect(whole.changed).toBe(true);
    expect(editor.document.kind[0]).toBe(CellKind.Empty);
    expect(editor.document.colors.slice(0, 4)).toEqual(new Uint16Array([0, 0, 0, 0]));
    expect(editor.document.completed[0]).toBe(0);
  });

  it('validates pair geometry and retains physical corner data through fragments', () => {
    let pattern = document(2, 1);
    pattern = apply(pattern, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.NW, color: 1 });
    pattern = apply(pattern, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.SE, color: 1 });
    expect(validateDocument(pattern)).toBe(true);
    expect(getCell(pattern, 0, 0).threeQuarters).toEqual([
      { color: 1, completed: false },
      { color: 0, completed: false },
      { color: 1, completed: false },
      { color: 0, completed: false }
    ]);
    const fragment = createPatternFragment(pattern, { x: 0, y: 0, width: 1, height: 1 });
    expect(validatePatternFragment(fragment)).toBe(true);
    const pasted = applyCommand(document(2, 1), pasteFragmentCommand(fragment, { x: 1, y: 0 }));
    expect(pasted.document.kind[1]).toBe(CellKind.ThreeQuarterPair);
    expect(pasted.document.colors.slice(4, 8)).toEqual(new Uint16Array([1, 0, 1, 0]));

    const invalid = pattern.kind.slice();
    invalid[0] = CellKind.ThreeQuarterPair;
    const invalidPair = { ...pattern, kind: invalid, colors: new Uint16Array([1, 1, 0, 0, 0, 0, 0, 0]) };
    expect(validateDocument(invalidPair)).toBe(false);
  });

  it('keeps direct pair assignment idempotent and preserves matching completion slots', () => {
    const editor = createEditor(document(1, 1));
    editor.execute({ type: 'set-cell', x: 0, y: 0, kind: CellKind.ThreeQuarterPair, colors: [1, 0, 2, 0] });
    editor.execute({ type: 'set-completion', x: 0, y: 0, corner: QuarterCorner.NW, completed: true });
    const before = editor.document;
    const beforeRevision = editor.revision;
    const beforeUndoDepth = editor.undoDepth;

    const identical = editor.execute({ type: 'set-cell', x: 0, y: 0, kind: CellKind.ThreeQuarterPair, colors: [1, 0, 2, 0] });
    expect(identical.changed).toBe(false);
    expect(identical.document).toBe(before);
    expect(editor.revision).toBe(beforeRevision);
    expect(editor.undoDepth).toBe(beforeUndoDepth);
    expect(editor.document.completed[0]).toBe(1);

    const recolored = editor.execute({ type: 'set-cell', x: 0, y: 0, kind: CellKind.ThreeQuarterPair, colors: [2, 0, 1, 0] });
    expect(recolored.changed).toBe(true);
    expect(editor.document.colors.slice(0, 4)).toEqual(new Uint16Array([2, 0, 1, 0]));
    expect(editor.document.completed[0]).toBe(1);

    const reoriented = editor.execute({ type: 'set-cell', x: 0, y: 0, kind: CellKind.ThreeQuarterPair, colors: [0, 2, 0, 1] });
    expect(reoriented.changed).toBe(true);
    expect(editor.document.completed[0]).toBe(0);
  });

  it('overwrites three-quarter geometry, preserves same-kind completion, and packs bulk undo state', () => {
    let pattern = document();
    pattern = apply(pattern, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.NW, color: 1 });
    pattern = apply(pattern, { type: 'set-completion', x: 0, y: 0, completed: true });
    const editor = createEditor(pattern);
    const result = editor.execute(bulkSetThreeQuarterCommand(new Uint32Array([0, 1]), QuarterCorner.NW, 2));
    expect(result.changed).toBe(true);
    expect(result.changedIndices).toEqual(new Uint32Array([0, 1]));
    expect(editor.document.kind[0]).toBe(CellKind.ThreeQuarterNW);
    expect(Array.from(editor.document.colors.slice(0, 4))).toEqual([2, 0, 0, 0]);
    expect(editor.document.completed[0]).toBe(1);
    expect(editor.document.kind[1]).toBe(CellKind.ThreeQuarterNW);
    expect(Array.from(editor.document.colors.slice(4, 8))).toEqual([2, 0, 0, 0]);
    const undone = editor.undo();
    expect(undone.changed).toBe(true);
    expect(undone.changedIndices).toEqual(new Uint32Array([0, 1]));
    undone.changedIndices?.fill(99);
    expect(editor.document.kind[0]).toBe(CellKind.ThreeQuarterNW);
    expect(Array.from(editor.document.colors.slice(0, 4))).toEqual([1, 0, 0, 0]);
    expect(editor.document.completed[0]).toBe(1);
    const redone = editor.redo();
    expect(redone.changed).toBe(true);
    expect(redone.changedIndices).toEqual(new Uint32Array([0, 1]));
    expect(editor.document.kind[0]).toBe(CellKind.ThreeQuarterNW);
    expect(Array.from(editor.document.colors.slice(0, 4))).toEqual([2, 0, 0, 0]);
  });

  it('exports and restores detached delta history with undo and redo stacks', () => {
    const editor = createEditor(document(3, 1));
    editor.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    editor.execute({ type: 'set-full', x: 1, y: 0, color: 2 });
    editor.undo();
    const suppliedCurrent = editor.document;
    const exported = editor.exportHistory();
    expect(exported.version).toBe(1);
    expect(exported.undo).toHaveLength(1);
    expect(exported.redo).toHaveLength(1);

    const restored = createEditor(suppliedCurrent, { historyLimitBytes: editor.historyLimitBytes });
    restored.importHistory(exported);
    (exported.undo[0] as { kind: 'delta'; delta: { cells: { indices: Uint32Array } } }).delta.cells.indices[0] = 99;
    expect(restored.undoDepth).toBe(1);
    expect(restored.redoDepth).toBe(1);
    const undone = restored.undo();
    expect(undone.revision).toBe(suppliedCurrent.revision + 1);
    expect(restored.document.kind).toEqual(new Uint8Array(3));
    const redone = restored.redo();
    expect(redone.revision).toBe(suppliedCurrent.revision + 2);
    expect(restored.document.kind[0]).toBe(CellKind.Full);
  });

  it('exports and restores snapshot history and preserves expected revisions', () => {
    const editor = createEditor(document(2, 1));
    editor.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    const beforeSnapshot = documentContentSnapshot(editor.document);
    editor.execute({ type: 'rotate-cw' });
    const afterSnapshot = documentContentSnapshot(editor.document);
    editor.undo();
    const preSnapshotRedo = editor.redo();
    const preSnapshotUndo = editor.undo();
    const suppliedCurrent = editor.document;
    const restored = createEditor(suppliedCurrent, { historyLimitBytes: editor.historyLimitBytes });
    restored.importHistory(editor.exportHistory());
    expect(restored.undoDepth).toBe(1);
    expect(restored.redoDepth).toBe(1);

    const redoneSnapshot = restored.redo();
    expect(redoneSnapshot.revision).toBe(suppliedCurrent.revision + 1);
    expect(redoneSnapshot.progress).toEqual(preSnapshotRedo.progress);
    expect(documentContentSnapshot(restored.document)).toEqual(afterSnapshot);
    const undoneSnapshot = restored.undo();
    expect(undoneSnapshot.revision).toBe(suppliedCurrent.revision + 2);
    expect(undoneSnapshot.progress).toEqual(preSnapshotUndo.progress);
    expect(documentContentSnapshot(restored.document)).toEqual(beforeSnapshot);
  });

  it('keeps mirror snapshot progress empty across restored undo and redo', () => {
    const editor = createEditor(document(2, 1));
    editor.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    editor.execute({ type: 'mirror-horizontal' });
    const afterMirror = documentContentSnapshot(editor.document);
    const preUndo = editor.undo();
    const preRedo = editor.redo();
    const restored = createEditor(editor.document, { historyLimitBytes: editor.historyLimitBytes });
    restored.importHistory(editor.exportHistory());
    const undone = restored.undo();
    expect(undone.progress).toEqual(preUndo.progress);
    expect(undone.progress).toEqual({ marked: 0, unmarked: 0, cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0) });
    const redone = restored.redo();
    expect(redone.progress).toEqual(preRedo.progress);
    expect(redone.progress).toEqual({ marked: 0, unmarked: 0, cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0) });
    expect(documentContentSnapshot(restored.document)).toEqual(afterMirror);
  });

  it('keeps erase of completed geometry out of completion activity', () => {
    const editor = createEditor(document(1, 1));
    editor.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    editor.execute({ type: 'set-completion', x: 0, y: 0, completed: true });
    editor.clearHistory();
    editor.execute({ type: 'erase-cell', x: 0, y: 0 });
    const preUndo = editor.undo();
    const preRedo = editor.redo();
    const restored = createEditor(editor.document, { historyLimitBytes: editor.historyLimitBytes });
    restored.importHistory(editor.exportHistory());
    const undone = restored.undo();
    expect(undone.progress).toEqual(preUndo.progress);
    expect(undone.progress).toEqual({ marked: 0, unmarked: 0, cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0) });
    expect(undone.recalculateMetrics).toBe(true);
    expect(computePatternMetrics(undone.document).progress).toMatchObject({ completedComponents: 1, remainingComponents: 0 });
    const redone = restored.redo();
    expect(redone.progress).toEqual(preRedo.progress);
    expect(redone.progress).toEqual({ marked: 0, unmarked: 0, cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0) });
    expect(computePatternMetrics(redone.document).progress).toMatchObject({ completedComponents: 0, remainingComponents: 0 });
  });

  it('rejects malformed or oversized history without mutating the editor and documents export trimming', () => {
    const editor = createEditor(document(3, 1));
    editor.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    editor.execute({ type: 'set-full', x: 1, y: 0, color: 2 });
    editor.undo();
    const before = documentContentSnapshot(editor.document);
    const beforeUndoDepth = editor.undoDepth;
    const beforeRedoDepth = editor.redoDepth;

    const malformed = editor.exportHistory();
    (malformed.undo[0] as { bytes: number }).bytes += 1;
    expect(() => editor.importHistory(malformed)).toThrow(/canonical|History|history/);
    expect(documentContentSnapshot(editor.document)).toEqual(before);
    expect(editor.undoDepth).toBe(beforeUndoDepth);
    expect(editor.redoDepth).toBe(beforeRedoDepth);

    const oversized = editor.exportHistory();
    (oversized.undo[0] as { bytes: number }).bytes += 1;
    expect(() => editor.importHistory(oversized)).toThrow(/canonical|History|history/);
    expect(documentContentSnapshot(editor.document)).toEqual(before);
    expect(editor.undoDepth).toBe(beforeUndoDepth);
    expect(editor.redoDepth).toBe(beforeRedoDepth);

    const entryBytes = editor.exportHistory().undo[0].bytes;
    const capped = editor.exportHistory({ maxBytes: entryBytes });
    expect(capped.undo).toHaveLength(0);
    expect(capped.redo).toHaveLength(1);
    const cappedEditor = createEditor(editor.document, { historyLimitBytes: editor.historyLimitBytes });
    cappedEditor.importHistory(capped);
    expect(cappedEditor.undoDepth).toBe(0);
    expect(cappedEditor.redoDepth).toBe(1);
  });

  it('replays history bounds against resized states and reconstructs semantic progress', () => {
    const editor = createEditor(document(4, 4));
    editor.execute({ type: 'set-full', x: 3, y: 3, color: 1 });
    editor.execute({ type: 'crop', x: 0, y: 0, width: 1, height: 1 });
    const cropped = editor.document;
    const exported = editor.exportHistory();
    const restored = createEditor(cropped, { historyLimitBytes: editor.historyLimitBytes });
    restored.importHistory(exported);
    restored.undo();
    expect(restored.document.width).toBe(4);
    expect(restored.document.kind[15]).toBe(CellKind.Full);
    restored.undo();
    expect(restored.document.kind[15]).toBe(CellKind.Empty);
    restored.redo();
    expect(restored.document.kind[15]).toBe(CellKind.Full);
    restored.redo();
    expect(restored.document.width).toBe(1);

    const completionEditor = createEditor(document(1, 1));
    completionEditor.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    completionEditor.execute(bulkSetCompletionCommand(new Uint32Array([0])));
    const preCompletionUndo = completionEditor.undo();
    const preCompletionRedo = completionEditor.redo();
    const completionHistory = completionEditor.exportHistory();
    const completionEntry = completionHistory.undo[1] as { progress: { marked: number; unmarked: number }; recalculateMetrics: boolean };
    completionEntry.progress.marked = 999;
    completionEntry.progress.unmarked = 999;
    completionEntry.recalculateMetrics = false;
    const rejectedCompletion = createEditor(completionEditor.document, { historyLimitBytes: completionEditor.historyLimitBytes });
    expect(() => rejectedCompletion.importHistory(completionHistory)).toThrow(/progress/i);
    expect(rejectedCompletion.undoDepth).toBe(0);
    const completionRestored = createEditor(completionEditor.document, { historyLimitBytes: completionEditor.historyLimitBytes });
    completionRestored.importHistory(completionEditor.exportHistory());
    const undoneCompletion = completionRestored.undo();
    expect(undoneCompletion.recalculateMetrics).toBe(true);
    expect(undoneCompletion.progress).toEqual(preCompletionUndo.progress);
    expect(undoneCompletion.progress).toEqual({ marked: 0, unmarked: 1, cellIndices: new Uint32Array([0]), backstitchIds: new Uint32Array(0) });
    expect(computePatternMetrics(undoneCompletion.document).progress).toMatchObject({ completedComponents: 0, remainingComponents: 1 });
    const redoneCompletion = completionRestored.redo();
    expect(redoneCompletion.recalculateMetrics).toBe(true);
    expect(redoneCompletion.progress).toEqual(preCompletionRedo.progress);
    expect(redoneCompletion.progress).toEqual({ marked: 1, unmarked: 0, cellIndices: new Uint32Array([0]), backstitchIds: new Uint32Array(0) });
    expect(computePatternMetrics(redoneCompletion.document).progress).toMatchObject({ completedComponents: 1, remainingComponents: 0 });

    const backstitchEditor = createEditor(document(2, 1));
    backstitchEditor.execute({ type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 1 });
    const backstitchId = backstitchEditor.document.backstitches.ids[0];
    backstitchEditor.execute(bulkSetBackstitchCompletionCommand(new Uint32Array([backstitchId])));
    const preBackstitchUndo = backstitchEditor.undo();
    const preBackstitchRedo = backstitchEditor.redo();
    const backstitchHistory = backstitchEditor.exportHistory();
    const backstitchEntry = backstitchHistory.undo[1] as { progress: { marked: number; unmarked: number }; recalculateMetrics: boolean };
    backstitchEntry.progress.marked = 999;
    backstitchEntry.progress.unmarked = 999;
    backstitchEntry.recalculateMetrics = false;
    const rejectedBackstitch = createEditor(backstitchEditor.document, { historyLimitBytes: backstitchEditor.historyLimitBytes });
    expect(() => rejectedBackstitch.importHistory(backstitchHistory)).toThrow(/progress/i);
    expect(rejectedBackstitch.undoDepth).toBe(0);
    const restoredBackstitch = createEditor(backstitchEditor.document, { historyLimitBytes: backstitchEditor.historyLimitBytes });
    restoredBackstitch.importHistory(backstitchEditor.exportHistory());
    const restoredBackstitchUndo = restoredBackstitch.undo();
    expect(restoredBackstitchUndo.progress).toEqual(preBackstitchUndo.progress);
    expect(restoredBackstitchUndo.progress).toMatchObject({ marked: 0, unmarked: 1, backstitchIds: new Uint32Array([backstitchId]) });
    const restoredBackstitchRedo = restoredBackstitch.redo();
    expect(restoredBackstitchRedo.progress).toEqual(preBackstitchRedo.progress);
    expect(restoredBackstitchRedo.progress).toMatchObject({ marked: 1, unmarked: 0, backstitchIds: new Uint32Array([backstitchId]) });
  });

  it('rejects a raw history payload over the decode ceiling before cloning it', () => {
    const editor = createEditor(document(2, 3));
    editor.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    for (let index = 0; index < 12; index += 1) editor.execute({ type: index % 2 === 0 ? 'rotate-cw' : 'mirror-horizontal' });
    const exported = editor.exportHistory();
    const snapshots = exported.undo.filter((entry): entry is Extract<typeof entry, { kind: 'snapshot' }> => entry.kind === 'snapshot');
    expect(snapshots.length).toBeGreaterThan(8);
    const repeated = 'x'.repeat(4_000_000);
    for (const entry of snapshots) {
      (entry.before.palette[0] as { name: string }).name = repeated;
      (entry.after.palette[0] as { name: string }).name = repeated;
    }
    expect(() => editor.importHistory(exported)).toThrow(/decode ceiling|history/i);
    expect(editor.undoDepth).toBeGreaterThan(0);
  });

  it('requires explicit completion and enforces active, non-reserved palette IDs', () => {
    expect(() => createDocument({ width: 1, height: 1, catalog: TEST_CATALOG, palette: [{ id: 0xffff, name: 'Reserved', color: '#000' }] })).toThrow();
    let pattern = document(2, 2);
    pattern = apply(pattern, { type: 'set-full', x: 0, y: 0, color: 1 });
    pattern = apply(pattern, { type: 'set-quarter', x: 1, y: 1, corner: QuarterCorner.NW, color: 1 });
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 4 }, color: 1 });
    expect(() => apply(pattern, { type: 'palette-deactivate', id: 1 })).toThrow();
    expect(() => apply(pattern, { type: 'palette-update', id: 1, active: false })).toThrow();
    pattern.palette[0] = { ...pattern.palette[0], active: false };
    expect(validateDocument(pattern)).toBe(false);
  });

  it('merges a referenced palette color into another and deactivates the source atomically', () => {
    let pattern = document(2, 2);
    pattern = apply(pattern, { type: 'set-full', x: 0, y: 0, color: 1 });
    pattern = apply(pattern, { type: 'set-quarter', x: 1, y: 0, corner: QuarterCorner.NW, color: 1 });
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 4 }, color: 1 });
    const editor = createEditor(pattern);
    const result = editor.execute(mergePaletteCommand(1, 2));

    expect(result.changed).toBe(true);
    expect(result.recalculateMetrics).toBe(true);
    const next = result.document;
    expect(next.palette.find((entry) => entry.id === 1)?.active).toBe(false);
    expect(next.palette.find((entry) => entry.id === 1)?.id).toBe(1);
    expect(next.colors[0]).toBe(2);
    expect(next.colors[1 * 4]).toBe(2);
    expect(getBackstitch(next, 1)?.color).toBe(2);
    expect(validateDocument(next)).toBe(true);

    expect(editor.undo().changed).toBe(true);
    const undone = editor.document;
    expect(undone.palette.find((entry) => entry.id === 1)?.active).toBe(true);
    expect(undone.colors[0]).toBe(1);
    expect(getBackstitch(undone, 1)?.color).toBe(1);
    expect(editor.redo().changed).toBe(true);
    expect(editor.document.colors[0]).toBe(2);
  });

  it('removes an unreferenced palette color via merge and rejects invalid merges', () => {
    const pattern = document(2, 2);
    const merged = applyCommand(pattern, mergePaletteCommand(3, 1)).document;
    expect(merged.palette.find((entry) => entry.id === 3)?.active).toBe(false);
    expect(merged.palette.find((entry) => entry.id === 3)?.id).toBe(3);

    expect(() => applyCommand(pattern, mergePaletteCommand(1, 1))).toThrow();
    expect(() => applyCommand(pattern, mergePaletteCommand(99, 1))).toThrow();
    expect(() => applyCommand(pattern, mergePaletteCommand(1, 99))).toThrow();
    const inactiveMerge = applyCommand(pattern, { type: 'palette-create', name: 'Muted', color: '#888', active: false }).document;
    expect(() => applyCommand(inactiveMerge, mergePaletteCommand(2, 4))).toThrow();
  });

  it('atomically creates a replacement color and merges into it in one command', () => {
    let pattern = document(2, 1);
    pattern = apply(pattern, { type: 'set-full', x: 0, y: 0, color: 1 });
    const editor = createEditor(pattern);
    const result = editor.execute({
      type: 'palette-merge',
      from: 1,
      createTo: { name: 'Lilac', color: '#C9A0DC', catalog: { catalogId: TEST_CATALOG.catalogId, sourceId: 's', code: '3740', name: 'Lilac', hex: '#C9A0DC', rgb: [201, 160, 220] } }
    });
    expect(result.changed).toBe(true);
    const next = result.document;
    const added = next.palette.find((entry) => entry.catalog?.code === '3740');
    expect(added).toBeDefined();
    expect(next.palette.find((entry) => entry.id === 1)?.active).toBe(false);
    expect(next.colors[0]).toBe(added!.id);
    expect(validateDocument(next)).toBe(true);
    expect(editor.undo().changed).toBe(true);
    expect(editor.document.colors[0]).toBe(1);
  });

  it('deep-compares and restores v2 palette material and catalog fields', () => {
    const pattern = createDocument({
      width: 1,
      height: 1,
      catalog: TEST_CATALOG,
      palette: [{
        id: 1,
        name: 'Red',
        color: '#d33',
        symbol: '✚',
        material: { kind: 'floss', label: 'Cotton', unit: 'skeins', amount: 2 },
        catalog: { catalogId: TEST_CATALOG.catalogId, sourceId: 'source', code: 'R', name: 'Red', hex: '#DD3333', rgb: [221, 51, 51] }
      }]
    });
    const editor = createEditor(pattern);
    const result = editor.execute({ type: 'palette-update', id: 1, material: { kind: 'floss', label: 'Silk', unit: 'meters', amount: 4 }, catalog: { catalogId: TEST_CATALOG.catalogId, sourceId: 'source-2', code: 'R2', name: 'Red 2', hex: '#CC2222', rgb: [204, 34, 34] } });
    expect(result.changed).toBe(true);
    expect(editor.document.palette[0].material).toMatchObject({ label: 'Silk', unit: 'meters', amount: 4 });
    expect(editor.document.palette[0].catalog?.catalogId).toBe(TEST_CATALOG.catalogId);
    editor.undo();
    expect(editor.document.palette[0].material).toMatchObject({ label: 'Cotton', unit: 'skeins', amount: 2 });
    expect(editor.document.palette[0].catalog?.catalogId).toBe(TEST_CATALOG.catalogId);
    editor.redo();
    expect(editor.document.palette[0].catalog?.rgb).toEqual([204, 34, 34]);
  });

  it('assigns Unicode defaults in order, covers the brand ceiling, and cycles past the pool', () => {
    // The symbol pool must exceed the brand palette ceiling so every valid
    // palette id maps to a unique default glyph.
    expect(PALETTE_SYMBOLS.length).toBeGreaterThanOrEqual(TEST_CATALOG.colorCount);
    expect(new Set(PALETTE_SYMBOLS).size).toBe(PALETTE_SYMBOLS.length);
    for (const glyph of PALETTE_SYMBOLS) {
      expect(glyph.length).toBeGreaterThan(0);
      expect(glyph.length).toBeLessThanOrEqual(MAX_PALETTE_SYMBOL_LENGTH);
      expect(isAlphanumericSymbol(glyph)).toBe(false);
    }
    // The first 28 glyphs are tier-1 coverage symbols, interleaved by coarse
    // visual class via round-robin seeded at ● (filled / hollow / line-cross /
    // diagonal / curved / arrow / pointy-pictographic).
    expect(PALETTE_SYMBOLS.slice(0, 28)).toEqual([
      '●', '△', '✕', '◭', '⟳', '↯', '✦', '▛', '□', '✠', '∕', '∞', '↖', '✹', '◆', '⬚', '∥', '◿', '◔', '↗', '\u25ef', '▲', '▣', '∏', '◸', '∾', '↙', '\u2721'
    ]);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(defaultPaletteSymbol)).toEqual(
      ['●', '△', '✕', '◭', '⟳', '↯', '✦', '▛', '□', '✠']
    );
    expect(defaultPaletteSymbol(20)).toBe('\u2197');
    expect(defaultPaletteSymbol(28)).toBe('\u2721');
    // Ids 1..TEST_CATALOG.colorCount each get a distinct default glyph.
    const assigned = new Set<string>();
    for (let id = 1; id <= TEST_CATALOG.colorCount; id += 1) {
      assigned.add(defaultPaletteSymbol(id));
    }
    expect(assigned.size).toBe(TEST_CATALOG.colorCount);
    // Past the end of the pool the assignment cycles deterministically as a
    // safety tail (unreachable under the business ceiling).
    expect(defaultPaletteSymbol(PALETTE_SYMBOLS.length + 1)).toBe('●');
    expect(defaultPaletteSymbol(2 * PALETTE_SYMBOLS.length + 1)).toBe('●');
    expect(() => defaultPaletteSymbol(0)).toThrow(DomainError);
  });

  it('validates reassigned palette symbols through palette-update', () => {
    const editor = createEditor(document(2, 2));
    expect(editor.document.palette.map((entry) => entry.symbol)).toEqual(['●', '△', '✕']);
    const result = editor.execute({ type: 'palette-update', id: 1, symbol: '☆' });
    expect(result.changed).toBe(true);
    expect(editor.document.palette[0].symbol).toBe('☆');
    expect(() => editor.execute({ type: 'palette-update', id: 2, symbol: '' })).toThrow(/empty/);
    expect(() => editor.execute({ type: 'palette-update', id: 2, symbol: '   ' })).toThrow(/empty/);
    expect(() => editor.execute({ type: 'palette-update', id: 2, symbol: 'ABC' })).toThrow(/alphanumeric/);
    // A single astral-plane glyph is exactly 2 UTF-16 units, so it passes.
    editor.execute({ type: 'palette-update', id: 2, symbol: '𝕏' });
    expect(editor.document.palette[1].symbol).toBe('𝕏');
    expect(() => editor.execute({ type: 'palette-update', id: 3, symbol: '☆' })).toThrow(/duplicated/);
    expect(() => editor.execute({ type: 'palette-update', id: 99, symbol: '○' })).toThrow();
    // Alphanumeric symbols stay banned so the legacy "S3" defaults cannot
    // resurface, but enclosed-digit glyphs (which are non-alphanumeric
    // Unicode) still pass.
    expect(() => editor.execute({ type: 'palette-update', id: 2, symbol: 'S3' })).toThrow(/alphanumeric/);
    expect(() => editor.execute({ type: 'palette-update', id: 2, symbol: 'Ａ' })).toThrow(/alphanumeric/);
    editor.execute({ type: 'palette-update', id: 2, symbol: '①' });
    expect(editor.document.palette[1].symbol).toBe('①');
    // Astral-plane emoji pinned with VS16 + skin-tone modifier (4 UTF-16
    // units) is accepted; anything beyond the cap is still rejected.
    editor.execute({ type: 'palette-update', id: 2, symbol: '🧶\u{fe0f}' });
    expect(editor.document.palette[1].symbol).toBe('🧶\u{fe0f}');
    expect(() => editor.execute({ type: 'palette-update', id: 2, symbol: '🧶\u{fe0f}ab' })).toThrow(/4 UTF-16/);
  });

  it('auto-assigns a unique glyph per palette entry up to the brand ceiling and rejects past it', () => {
    let pattern = createDocument({ width: 2, height: 2, catalog: TEST_CATALOG });
    for (let id = 1; id <= TEST_CATALOG.colorCount; id++) {
      pattern = applyCommand(pattern, { type: 'palette-create', name: `Color ${id}`, color: '#123456' }).document;
    }
    expect(pattern.palette).toHaveLength(TEST_CATALOG.colorCount);
    // Auto-assignment takes the first unused glyph in pool order, so the first
    // TEST_CATALOG.colorCount entries carry unique, ordered symbols.
    expect(pattern.palette.map((entry) => entry.symbol)).toEqual(PALETTE_SYMBOLS.slice(0, TEST_CATALOG.colorCount));
    // The next palette-create would exceed the brand ceiling, so it must throw
    // instead of overflowing onto a cycled duplicate.
    expect(() => applyCommand(pattern, { type: 'palette-create', name: 'Color over', color: '#654321' })).toThrow(/brand's color count/);
    // Explicit duplicates stay rejected on create and update alike (checked on
    // a small palette so the brand-ceiling guard does not fire first).
    const small = document(2, 2);
    expect(() => applyCommand(small, { type: 'palette-create', name: 'Copy', color: '#000000', symbol: '●' })).toThrow(/duplicated/);
    expect(() => applyCommand(small, { type: 'palette-update', id: 2, symbol: '●' })).toThrow(/duplicated/);
  });

  it('yields all-unique symbols at the brand ceiling and rejects ids above it', () => {
    const entries = Array.from({ length: TEST_CATALOG.colorCount }, (_, index) => ({
      id: index + 1,
      name: `Color ${index + 1}`,
      color: '#123456'
    }));
    const pattern = createDocument({ width: 2, height: 2, catalog: TEST_CATALOG, palette: entries });
    expect(pattern.palette).toHaveLength(TEST_CATALOG.colorCount);
    expect(new Set(pattern.palette.map((entry) => entry.symbol)).size).toBe(TEST_CATALOG.colorCount);
    // An explicit id above the brand ceiling is rejected on palette-create.
    expect(() => applyCommand(pattern, { type: 'palette-create', name: 'Over', color: '#ffffff', id: TEST_CATALOG.colorCount + 1, symbol: '★' })).toThrow(/brand's color count/);
  });

  it('enforces the shared maximum cell count during creation and validation', () => {
    const maximum = createDocument({ width: MAX_PERSISTABLE_CELL_COUNT, height: 1, catalog: TEST_CATALOG });
    expect(maximum.kind).toHaveLength(MAX_PERSISTABLE_CELL_COUNT);
    expect(() => createDocument({ width: MAX_PERSISTABLE_CELL_COUNT + 1, height: 1, catalog: TEST_CATALOG })).toThrow(DomainError);

    const invalid = document(1, 1);
    invalid.width = MAX_PERSISTABLE_CELL_COUNT + 1;
    expect(validateDocument(invalid)).toBe(false);
    expect(() => assertValidDocument(invalid)).toThrow(DomainError);
  });

  it('rejects restored documents whose palette exceeds the brand ceiling', () => {
    // Palette length above the ceiling: defense-in-depth for restored docs.
    expect(() => createDocument({
      width: 1,
      height: 1,
      catalog: TEST_CATALOG,
      palette: Array.from({ length: TEST_CATALOG.colorCount + 1 }, (_, index) => ({
        id: index + 1,
        name: `Color ${index + 1}`,
        color: '#123456'
      }))
    })).toThrow(/brand's color count/);

    // A single entry id above the ceiling is likewise rejected.
    expect(() => createDocument({
      width: 1,
      height: 1,
      catalog: TEST_CATALOG,
      palette: [{ id: TEST_CATALOG.colorCount + 1, name: 'Over', color: '#ffffff' }]
    })).toThrow(/brand's color count/);
  });

  it('canonicalizes, recolors, and moves backstitches without changing identity or completion', () => {
    let pattern = document();
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 8, y: 4 }, end: { x: 0, y: 0 }, color: 1, completed: true });
    const id = listBackstitches(pattern)[0].id;
    expect(getBackstitch(pattern, id)).toMatchObject({ completed: false });
    pattern = apply(pattern, { type: 'set-backstitch-completion', id, completed: true });
    expect(getBackstitch(pattern, id)).toMatchObject({ id, x1: 0, y1: 0, x2: 8, y2: 4, completed: true });

    pattern = apply(pattern, { type: 'recolor-backstitch', id, color: 2 });
    expect(getBackstitch(pattern, id)).toMatchObject({ color: 2, completed: true });
    pattern = apply(pattern, { type: 'move-backstitch', id, start: { x: 12, y: 8 }, end: { x: 4, y: 4 } });
    expect(getBackstitch(pattern, id)).toMatchObject({ id, x1: 4, y1: 4, x2: 12, y2: 8, completed: false });
    pattern = apply(pattern, { type: 'set-backstitch-completion', id, completed: true });
    pattern = apply(pattern, { type: 'update-backstitch', id, start: { x: 8, y: 0 }, end: { x: 12, y: 4 }, color: 1, completed: true });
    expect(getBackstitch(pattern, id)).toMatchObject({ x1: 8, y1: 0, x2: 12, y2: 4, completed: false });
  });

  it('snaps new and moved backstitch endpoints to cell corners without migrating legacy geometry', () => {
    let pattern = document(3, 3);
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 2, y: 2 }, end: { x: 10, y: 6 }, color: 1 });
    expect(listBackstitches(pattern)[0]).toMatchObject({ x1: 4, y1: 4, x2: 12, y2: 8 });
    expect(() => apply(document(3, 3), { type: 'add-backstitch', start: { x: 2, y: 2 }, end: { x: 3, y: 3 }, color: 1 })).toThrow(/identical/);

    const legacy = document(3, 3);
    legacy.backstitches = {
      ids: new Uint32Array([1]),
      x1: new Uint32Array([2]),
      y1: new Uint32Array([2]),
      x2: new Uint32Array([10]),
      y2: new Uint32Array([6]),
      colors: new Uint16Array([1]),
      completed: new Uint8Array([0])
    };
    legacy.nextBackstitchId = 2;
    expect(assertValidDocument(legacy)).toBeUndefined();
    expect(listBackstitches(legacy)[0]).toMatchObject({ x1: 2, y1: 2, x2: 10, y2: 6 });

    const moved = apply(legacy, { type: 'move-backstitch', id: 1, start: { x: 2, y: 2 }, end: { x: 9, y: 5 } });
    expect(listBackstitches(moved)[0]).toMatchObject({ x1: 2, y1: 2, x2: 8, y2: 4 });
  });

  it('round-trips rotations and mirrors while moving completion with geometry', () => {
    let pattern = document(3, 2);
    pattern = apply(pattern, { type: 'set-half', x: 0, y: 0, direction: HalfDirection.Backslash, color: 1, completed: true });
    pattern = apply(pattern, { type: 'set-completion', x: 0, y: 0, completed: true });
    pattern = apply(pattern, { type: 'set-quarter', x: 2, y: 1, corner: QuarterCorner.NE, color: 2, completed: true });
    pattern = apply(pattern, { type: 'set-completion', x: 2, y: 1, corner: QuarterCorner.NE, completed: true });
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 12, y: 8 }, color: 3, completed: true });
    const transformedBackstitchId = listBackstitches(pattern)[0].id;
    pattern = apply(pattern, { type: 'set-backstitch-completion', id: transformedBackstitchId, completed: true });
    const original = pattern;

    pattern = apply(pattern, { type: 'rotate-cw' });
    expect(pattern.width).toBe(2);
    expect(pattern.height).toBe(3);
    pattern = apply(pattern, { type: 'rotate-ccw' });
    expect(pattern.width).toBe(original.width);
    expect(pattern.height).toBe(original.height);
    expect(pattern.kind).toEqual(original.kind);
    expect(pattern.colors).toEqual(original.colors);
    expect(pattern.completed).toEqual(original.completed);
    expect(listBackstitches(pattern)).toMatchObject(listBackstitches(original));

    pattern = apply(pattern, { type: 'mirror-horizontal' });
    pattern = apply(pattern, { type: 'mirror-horizontal' });
    expect(pattern.kind).toEqual(original.kind);
    expect(pattern.colors).toEqual(original.colors);
    expect(pattern.completed).toEqual(original.completed);
    expect(listBackstitches(pattern)).toMatchObject(listBackstitches(original));
  });

  it('transforms every directional three-quarter corner with color and completion through undo and redo', () => {
    const cases: Array<{
      command: Parameters<ReturnType<typeof createEditor>['execute']>[0];
      corners: [QuarterCorner, QuarterCorner, QuarterCorner, QuarterCorner];
      position: { x: number; y: number };
      dimensions: { width: number; height: number };
    }> = [
      { command: { type: 'rotate-cw' }, corners: [QuarterCorner.NE, QuarterCorner.SE, QuarterCorner.SW, QuarterCorner.NW], position: { x: 0, y: 1 }, dimensions: { width: 3, height: 2 } },
      { command: { type: 'rotate-ccw' }, corners: [QuarterCorner.SW, QuarterCorner.NW, QuarterCorner.NE, QuarterCorner.SE], position: { x: 2, y: 0 }, dimensions: { width: 3, height: 2 } },
      { command: { type: 'mirror-horizontal' }, corners: [QuarterCorner.NE, QuarterCorner.NW, QuarterCorner.SW, QuarterCorner.SE], position: { x: 0, y: 2 }, dimensions: { width: 2, height: 3 } },
      { command: { type: 'mirror-vertical' }, corners: [QuarterCorner.SW, QuarterCorner.SE, QuarterCorner.NE, QuarterCorner.NW], position: { x: 1, y: 0 }, dimensions: { width: 2, height: 3 } }
    ];

    for (const testCase of cases) {
      for (const [sourceCorner, expectedCorner] of testCase.corners.entries()) {
        let original = document(2, 3);
        original = apply(original, { type: 'set-three-quarter', x: 1, y: 2, corner: sourceCorner as QuarterCorner, color: 2 });
        original = apply(original, { type: 'set-completion', x: 1, y: 2, completed: true });
        const editor = createEditor(original);

        const transformed = editor.execute(testCase.command);
        expect(editor.document.width).toBe(testCase.dimensions.width);
        expect(editor.document.height).toBe(testCase.dimensions.height);
        const index = testCase.position.y * editor.document.width + testCase.position.x;
        expect(editor.document.kind[index]).toBe([CellKind.ThreeQuarterNW, CellKind.ThreeQuarterNE, CellKind.ThreeQuarterSE, CellKind.ThreeQuarterSW][expectedCorner]);
        expect(editor.document.colors[index * 4]).toBe(2);
        expect(editor.document.completed[index]).toBe(1);
        expect(transformed.changed).toBe(true);

        const undone = editor.undo();
        expect(undone.changed).toBe(true);
        expect(editor.document.kind).toEqual(original.kind);
        expect(editor.document.colors).toEqual(original.colors);
        expect(editor.document.completed).toEqual(original.completed);
        const redone = editor.redo();
        expect(redone.changed).toBe(true);
        expect(editor.document.kind[index]).toBe([CellKind.ThreeQuarterNW, CellKind.ThreeQuarterNE, CellKind.ThreeQuarterSE, CellKind.ThreeQuarterSW][expectedCorner]);
        expect(editor.document.colors[index * 4]).toBe(2);
        expect(editor.document.completed[index]).toBe(1);
      }
    }
  });

  it('moves paired three-quarter colors and completion bits with every transform through history', () => {
    const cases: Array<{
      command: Parameters<ReturnType<typeof createEditor>['execute']>[0];
      colors: [number, number, number, number];
      completion: number;
    }> = [
      { command: { type: 'rotate-cw' }, colors: [0, 1, 0, 2], completion: 10 },
      { command: { type: 'rotate-ccw' }, colors: [0, 2, 0, 1], completion: 10 },
      { command: { type: 'mirror-horizontal' }, colors: [0, 1, 0, 2], completion: 10 },
      { command: { type: 'mirror-vertical' }, colors: [0, 2, 0, 1], completion: 10 }
    ];

    for (const testCase of cases) {
      let original = document(1, 1);
      original = apply(original, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.NW, color: 1 });
      original = apply(original, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.SE, color: 2 });
      original = apply(original, { type: 'set-completion', x: 0, y: 0, corner: QuarterCorner.NW, completed: true });
      original = apply(original, { type: 'set-completion', x: 0, y: 0, corner: QuarterCorner.SE, completed: true });
      const editor = createEditor(original);

      const transformed = editor.execute(testCase.command);
      expect(transformed.changed).toBe(true);
      expect(editor.document.kind[0]).toBe(CellKind.ThreeQuarterPair);
      expect(Array.from(editor.document.colors.slice(0, 4))).toEqual(testCase.colors);
      expect(editor.document.completed[0]).toBe(testCase.completion);
      editor.undo();
      expect(editor.document.kind).toEqual(original.kind);
      expect(editor.document.colors).toEqual(original.colors);
      expect(editor.document.completed).toEqual(original.completed);
      editor.redo();
      expect(Array.from(editor.document.colors.slice(0, 4))).toEqual(testCase.colors);
      expect(editor.document.completed[0]).toBe(testCase.completion);
    }
  });

  it('preserves asymmetric paired completion bits through transforms and history', () => {
    const cases: Array<{
      command: Parameters<ReturnType<typeof createEditor>['execute']>[0];
      colors: [number, number, number, number];
      completion: number;
    }> = [
      { command: { type: 'rotate-cw' }, colors: [0, 1, 0, 2], completion: 2 },
      { command: { type: 'rotate-ccw' }, colors: [0, 2, 0, 1], completion: 8 },
      { command: { type: 'mirror-horizontal' }, colors: [0, 1, 0, 2], completion: 2 },
      { command: { type: 'mirror-vertical' }, colors: [0, 2, 0, 1], completion: 8 }
    ];

    for (const testCase of cases) {
      let original = document(1, 1);
      original = apply(original, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.NW, color: 1 });
      original = apply(original, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.SE, color: 2 });
      original = apply(original, { type: 'set-completion', x: 0, y: 0, corner: QuarterCorner.NW, completed: true });
      const editor = createEditor(original);

      const transformed = editor.execute(testCase.command);
      expect(transformed.changed).toBe(true);
      expect(Array.from(editor.document.colors.slice(0, 4))).toEqual(testCase.colors);
      expect(editor.document.completed[0]).toBe(testCase.completion);

      editor.undo();
      expect(editor.document.colors).toEqual(original.colors);
      expect(editor.document.completed).toEqual(original.completed);
      editor.redo();
      expect(Array.from(editor.document.colors.slice(0, 4))).toEqual(testCase.colors);
      expect(editor.document.completed[0]).toBe(testCase.completion);
    }
  });

  it('retains only backstitches fully inside the closed crop boundary', () => {
    let pattern = document(3, 3);
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 4, y: 4 }, end: { x: 8, y: 8 }, color: 1 });
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 4, y: 4 }, end: { x: 12, y: 8 }, color: 2 });
    const retainedId = listBackstitches(pattern)[0].id;
    pattern = apply(pattern, { type: 'crop', x: 1, y: 1, width: 1, height: 1 });
    expect(pattern.width).toBe(1);
    expect(pattern.height).toBe(1);
    expect(listBackstitches(pattern)).toHaveLength(1);
    expect(getBackstitch(pattern, retainedId)).toMatchObject({ x1: 0, y1: 0, x2: 4, y2: 4 });
  });

  it('rejects invalid palette and duplicate segments atomically', () => {
    const editor = createEditor(document());
    expect(() => editor.executeBatch([
      { type: 'set-full', x: 0, y: 0, color: 1 },
      { type: 'set-full', x: 1, y: 0, color: 99 }
    ])).toThrow();
    expect(editor.document.kind[0]).toBe(CellKind.Empty);
    expect(editor.document.kind[1]).toBe(CellKind.Empty);
    expect(editor.document.revision).toBe(0);
    expect(editor.undoDepth).toBe(0);

    editor.execute({ type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 4 }, color: 1 });
    expect(() => editor.execute({ type: 'add-backstitch', start: { x: 4, y: 4 }, end: { x: 0, y: 0 }, color: 2 })).toThrow();
    expect(editor.document.backstitches.ids).toHaveLength(1);
    expect(editor.document.revision).toBe(1);
  });

  it('rejects invalid bulk targets, intent, palette, and stale revisions atomically', () => {
    const editor = createEditor(document());
    const before = cellSnapshot(editor.document);
    expect(() => editor.execute({ type: 'bulk-cell', indices: new Uint32Array([0, 2, 1]), edit: { kind: 'full', color: 1 } })).toThrow(/strictly increasing/);
    expect(() => editor.execute({ type: 'bulk-cell', indices: new Uint32Array([0, 99]), edit: { kind: 'full', color: 1 } })).toThrow(/out of bounds/);
    expect(() => editor.execute({ type: 'bulk-cell', indices: new Uint32Array([0, 1]), edit: { kind: 'unknown' } })).toThrow(DomainError);
    expect(() => editor.execute({ type: 'bulk-cell', indices: new Uint32Array([0, 1]), edit: { kind: 'full', color: 99 } })).toThrow(/Palette/);
    expect(() => editor.execute(bulkCellCommand(new Uint32Array([0]), { kind: 'full', color: 1 }, 1))).toThrow(/expected revision/);
    expect(editor.document).toEqual(before);
    expect(editor.document.revision).toBe(0);
    expect(editor.undoDepth).toBe(0);
    expect(editor.historyBytes).toBe(0);
  });

  it('rejects a bulk and ordinary command in one batch before mutation', () => {
    const editor = createEditor(document());
    const before = editor.document;
    const bulk = bulkSetFullCommand(new Uint32Array([0, 1]), 1);

    expect(() => editor.executeBatch([
      { type: 'set-full', x: 2, y: 0, color: 1 },
      bulk
    ])).toThrow(/standalone/);
    expect(editor.document).toBe(before);
    expect(editor.document.kind.every((kind) => kind === CellKind.Empty)).toBe(true);
    expect(editor.document.revision).toBe(0);
    expect(editor.undoDepth).toBe(0);
    expect(editor.redoDepth).toBe(0);
  });

  it('rejects multiple bulk commands in one batch before mutation', () => {
    const editor = createEditor(document());
    const before = editor.document;

    expect(() => editor.executeBatch([
      bulkSetFullCommand(new Uint32Array([0]), 1),
      bulkSetHalfCommand(new Uint32Array([1]), HalfDirection.Slash, 2)
    ])).toThrow(/standalone/);
    expect(editor.document).toBe(before);
    expect(editor.document.kind.every((kind) => kind === CellKind.Empty)).toBe(true);
    expect(editor.document.revision).toBe(0);
    expect(editor.undoDepth).toBe(0);
    expect(editor.historyBytes).toBe(0);
  });

  it('applies homogeneous bulk cell edits with canonical completion semantics and quarter isolation', () => {
    const editor = createEditor(document(2, 2));
    editor.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    editor.execute({ type: 'set-completion', x: 0, y: 0, completed: true });
    editor.execute({ type: 'set-quarter', x: 1, y: 0, corner: QuarterCorner.NW, color: 1 });
    editor.execute({ type: 'set-quarter', x: 1, y: 0, corner: QuarterCorner.SE, color: 2 });
    editor.execute({ type: 'set-completion', x: 1, y: 0, corner: QuarterCorner.NW, completed: true });
    editor.execute({ type: 'set-completion', x: 1, y: 0, corner: QuarterCorner.SE, completed: true });
    editor.clearHistory();

    const full = editor.execute(bulkSetFullCommand(new Uint32Array([0]), 2));
    expect(full.changed).toBe(true);
    expect(full.touchedIndices).toEqual(new Uint32Array([0]));
    expect(full.changedIndices).toEqual(new Uint32Array([0]));
    expect(getCell(editor.document, 0, 0)).toMatchObject({ kind: CellKind.Full, color: 2, completed: true });

    const quarter = editor.execute(bulkSetQuarterCommand(new Uint32Array([1]), QuarterCorner.NW, 3));
    expect(quarter.changed).toBe(true);
    expect(getCell(editor.document, 1, 0).quarters[QuarterCorner.NW]).toMatchObject({ color: 3, completed: true });
    expect(getCell(editor.document, 1, 0).quarters[QuarterCorner.SE]).toMatchObject({ color: 2, completed: true });

    editor.execute(bulkEraseQuarterCommand(new Uint32Array([1]), QuarterCorner.NW));
    expect(getCell(editor.document, 1, 0).quarters[QuarterCorner.NW]).toMatchObject({ color: 0, completed: false });
    expect(getCell(editor.document, 1, 0).quarters[QuarterCorner.SE]).toMatchObject({ color: 2, completed: true });

    editor.execute(bulkEraseCellCommand(new Uint32Array([1])));
    expect(getCell(editor.document, 1, 0).kind).toBe(CellKind.Empty);

    const half = editor.execute(bulkSetHalfCommand(new Uint32Array([0]), HalfDirection.Slash, 1));
    expect(half.changed).toBe(true);
    expect(getCell(editor.document, 0, 0)).toMatchObject({ kind: CellKind.HalfSlash, completed: false });
  });

  it('commits one bulk edit as one sparse history entry and undoes/redoes it', () => {
    const editor = createEditor(document(4, 3));
    const command = bulkSetFullCommand(new Uint32Array([0, 1, 4, 5]), 1);
    const result = editor.execute(command);
    expect(result.revision).toBe(1);
    expect(editor.undoDepth).toBe(1);
    expect(editor.lastHistoryEntryKind).toBe('delta');
    expect(result.changedIndices).toEqual(new Uint32Array([0, 1, 4, 5]));
    expect(editor.undo().revision).toBe(2);
    expect(editor.document.kind.slice(0, 6)).toEqual(new Uint8Array(6));
    expect(editor.redo().revision).toBe(3);
    expect(editor.document.kind.slice(0, 6)).toEqual(new Uint8Array([1, 1, 0, 0, 1, 1]));
  });

  it('recolors masked components across every stitch geometry in one delta', () => {
    const editor = createEditor(document(6, 1));
    editor.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    editor.execute({ type: 'set-completion', x: 0, y: 0, completed: true });
    editor.execute({ type: 'set-half', x: 1, y: 0, direction: HalfDirection.Slash, color: 1 });
    editor.execute({ type: 'set-completion', x: 1, y: 0, completed: true });
    editor.execute({ type: 'set-three-quarter', x: 2, y: 0, corner: QuarterCorner.NW, color: 1 });
    editor.execute({ type: 'set-completion', x: 2, y: 0, completed: true });
    for (const [corner, color] of [[QuarterCorner.NW, 1], [QuarterCorner.NE, 2], [QuarterCorner.SE, 1], [QuarterCorner.SW, 2]] as const) {
      editor.execute({ type: 'set-quarter', x: 3, y: 0, corner, color });
    }
    editor.execute({ type: 'set-completion', x: 3, y: 0, corner: QuarterCorner.NW, completed: true });
    editor.execute({ type: 'set-three-quarter', x: 4, y: 0, corner: QuarterCorner.NW, color: 1 });
    editor.execute({ type: 'set-three-quarter', x: 4, y: 0, corner: QuarterCorner.SE, color: 1 });
    editor.execute({ type: 'set-completion', x: 4, y: 0, completed: true });
    editor.execute({ type: 'set-three-quarter', x: 5, y: 0, corner: QuarterCorner.NW, color: 1 });
    editor.execute({ type: 'set-three-quarter', x: 5, y: 0, corner: QuarterCorner.SE, color: 2 });
    editor.execute({ type: 'set-completion', x: 5, y: 0, corner: QuarterCorner.NW, completed: true });
    editor.clearHistory();

    const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
    const masks = new Uint8Array([1, 1, 1, 5, 5, 1]);
    const command = bulkRecolorCommand(indices, masks, 1, 3, editor.revision);
    const preflight = preflightBulkRecolorCommand(editor.document, command);
    expect(preflight.indices).toEqual(indices);
    expect(preflight.masks).toEqual(masks);
    expect(preflight.changedIndices).toEqual(indices);

    const recolored = editor.execute(command);
    expect(recolored.changedIndices).toEqual(indices);
    expect(editor.document.kind).toEqual(new Uint8Array([
      CellKind.Full, CellKind.HalfSlash, CellKind.ThreeQuarterNW,
      CellKind.Quarters, CellKind.ThreeQuarterPair, CellKind.ThreeQuarterPair
    ]));
    expect(editor.document.colors).toEqual(new Uint16Array([
      3, 0, 0, 0, 3, 0, 0, 0, 3, 0, 0, 0,
      3, 2, 3, 2, 3, 0, 3, 0, 3, 0, 2, 0
    ]));
    expect(editor.document.completed).toEqual(new Uint8Array([1, 1, 1, 1, 5, 1]));
    expect(editor.undoDepth).toBe(1);
    expect(editor.lastHistoryEntryKind).toBe('delta');
    expect(editor.historyBytes).toBe(estimateBulkRecolorHistoryBytes(indices.length));

    editor.undo();
    expect(editor.document.colors).toEqual(new Uint16Array([
      1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0,
      1, 2, 1, 2, 1, 0, 1, 0, 1, 0, 2, 0
    ]));
    expect(editor.document.kind).toEqual(new Uint8Array([
      CellKind.Full, CellKind.HalfSlash, CellKind.ThreeQuarterNW,
      CellKind.Quarters, CellKind.ThreeQuarterPair, CellKind.ThreeQuarterPair
    ]));
    expect(editor.document.completed[0]).toBe(1);
    editor.redo();
    expect(editor.document.colors[0]).toBe(3);
    expect(editor.document.completed[0]).toBe(1);
  });

  it('keeps the former Full-only recolor call as a mask-one compatibility alias', () => {
    const command = bulkRecolorCommand(new Uint32Array([0, 4]), 1, 2);
    expect(command.masks).toEqual(new Uint8Array([1, 1]));
  });

  it('rejects malformed, mismatched, and stale component recolors atomically', () => {
    const editor = createEditor(document(2, 1));
    editor.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    editor.execute({ type: 'set-quarter', x: 1, y: 0, corner: QuarterCorner.NW, color: 1 });
    editor.clearHistory();
    const before = cellSnapshot(editor.document);
    const revision = editor.revision;
    const valid = { type: 'bulk-recolor', indices: new Uint32Array([0]), masks: new Uint8Array([1]), fromColor: 1, toColor: 2 };
    expect(() => editor.execute({ ...valid, masks: [1] })).toThrow(/Uint8Array/);
    expect(() => editor.execute({ ...valid, indices: new Uint32Array([1, 0]), masks: new Uint8Array([1, 1]) })).toThrow(/strictly increasing/);
    expect(() => editor.execute({ ...valid, masks: new Uint8Array([]) })).toThrow(/align/);
    expect(() => editor.execute({ ...valid, masks: new Uint8Array([0]) })).toThrow(/nonzero/);
    expect(() => editor.execute({ ...valid, masks: new Uint8Array([2]) })).toThrow(/subset/);
    expect(() => editor.execute({ ...valid, fromColor: 2 })).toThrow(/source/);
    expect(() => editor.execute({ ...valid, fromColor: 99 })).toThrow(/Palette|palette/);
    expect(() => editor.execute({ ...valid, toColor: 99 })).toThrow(/Palette|palette/);
    expect(() => editor.execute({ ...valid, expectedRevision: 4 })).toThrow(/expected revision/);
    expect(editor.document).toEqual(before);
    expect(editor.revision).toBe(revision);
    expect(editor.undoDepth).toBe(0);
  });

  it('treats a valid source-equals-destination recolor as a no-op without revision or history', () => {
    const editor = createEditor(document(1, 1));
    editor.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    editor.clearHistory();
    const revision = editor.revision;
    const result = editor.execute(bulkRecolorCommand(new Uint32Array([0]), new Uint8Array([1]), 1, 1, revision));
    expect(result.changed).toBe(false);
    expect(result.changedIndices).toEqual(new Uint32Array(0));
    expect(editor.revision).toBe(revision);
    expect(editor.undoDepth).toBe(0);
  });

  it('applies set, clear, and toggle progress to occupied cell components atomically', () => {
    const editor = createEditor(document(3, 1));
    editor.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    editor.execute({ type: 'set-half', x: 1, y: 0, direction: HalfDirection.Slash, color: 2 });
    editor.execute({ type: 'set-quarter', x: 2, y: 0, corner: QuarterCorner.NW, color: 1 });
    editor.execute({ type: 'set-quarter', x: 2, y: 0, corner: QuarterCorner.SE, color: 2 });
    editor.clearHistory();

    const set = editor.execute(bulkSetCompletionCommand(new Uint32Array([0, 1, 2])));
    expect(set.touchedIndices).toEqual(new Uint32Array([0, 1, 2]));
    expect(set.changedIndices).toEqual(new Uint32Array([0, 1, 2]));
    expect(editor.document.completed).toEqual(new Uint8Array([1, 1, 5]));
    expect(editor.historyBytes).toBe(estimateBulkCompletionHistoryBytes(3));
    expect(editor.undoDepth).toBe(1);

    const clearCorner = editor.execute(bulkClearCompletionCommand(new Uint32Array([2]), QuarterCorner.NW));
    expect(clearCorner.changedIndices).toEqual(new Uint32Array([2]));
    expect(editor.document.completed[2]).toBe(4);

    const toggle = editor.execute(bulkToggleCompletionCommand(new Uint32Array([0, 2])));
    expect(toggle.changedIndices).toEqual(new Uint32Array([0, 2]));
    expect(editor.document.completed).toEqual(new Uint8Array([0, 1, 1]));

    editor.undo();
    expect(editor.document.completed).toEqual(new Uint8Array([1, 1, 4]));
    editor.redo();
    expect(editor.document.completed).toEqual(new Uint8Array([0, 1, 1]));

    const noOp = editor.execute(bulkCompletionCommand(new Uint32Array([0]), 'clear'));
    expect(noOp.changed).toBe(false);
    expect(noOp.touchedIndices).toEqual(new Uint32Array([0]));
    expect(noOp.changedIndices).toEqual(new Uint32Array(0));
  });

  it('shares unrelated planes for cell completion while preserving progress and undo/redo', () => {
    const side = 256;
    let pattern = document(side, side);
    pattern = apply(pattern, { type: 'set-full', x: 128, y: 128, color: 1 });
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 4 }, color: 1 });
    const editor = createEditor(pattern);
    const before = editor.document;
    const target = 128 * side + 128;
    const beforeKind = before.kind;
    const beforeColors = before.colors;
    const beforeCompleted = before.completed;
    const beforeBackstitches = before.backstitches;
    const beforePalette = before.palette;
    const beforeSettings = before.settings;

    const completed = editor.execute(bulkSetCompletionCommand(new Uint32Array([target])));
    const after = editor.document;
    expect(completed.changed).toBe(true);
    expect(completed.changedIndices).toEqual(new Uint32Array([target]));
    expect(completed.progress).toMatchObject({ marked: 1, unmarked: 0, cellIndices: new Uint32Array([target]) });
    expect(after).not.toBe(before);
    expect(after.kind).toBe(beforeKind);
    expect(after.colors).toBe(beforeColors);
    expect(after.completed).not.toBe(beforeCompleted);
    expect(after.palette).toBe(beforePalette);
    expect(after.settings).toBe(beforeSettings);
    expect(after.backstitches).toBe(beforeBackstitches);
    expect(after.completed[target]).toBe(1);
    expect(after.completed[target - 1]).toBe(0);
    expect(after.revision).toBe(before.revision + 1);
    expect(editor.lastHistoryEntryKind).toBe('delta');
    expect(editor.historyBytes).toBe(estimateBulkCompletionHistoryBytes(1));
    expect(editor.undoDepth).toBe(1);

    const undone = editor.undo();
    expect(undone.progress).toMatchObject({ marked: 0, unmarked: 1, cellIndices: new Uint32Array([target]) });
    expect(editor.document.completed).toEqual(beforeCompleted);
    expect(editor.document.completed).not.toBe(after.completed);
    expect(editor.document.kind).toBe(beforeKind);
    expect(editor.document.colors).toBe(beforeColors);
    expect(editor.document.palette).toBe(beforePalette);
    expect(editor.document.settings).toBe(beforeSettings);
    expect(editor.document.backstitches).toBe(beforeBackstitches);
    expect(editor.undoDepth).toBe(0);
    expect(editor.redoDepth).toBe(1);

    const redone = editor.redo();
    expect(redone.progress).toMatchObject({ marked: 1, unmarked: 0, cellIndices: new Uint32Array([target]) });
    expect(editor.document.completed[target]).toBe(1);
    expect(editor.document.completed).not.toBe(after.completed);
    expect(editor.document.kind).toBe(beforeKind);
    expect(editor.document.colors).toBe(beforeColors);
    expect(editor.document.palette).toBe(beforePalette);
    expect(editor.document.settings).toBe(beforeSettings);
    expect(editor.document.backstitches).toBe(beforeBackstitches);
    expect(editor.undoDepth).toBe(1);
    expect(editor.redoDepth).toBe(0);
  });

  it('shares dense planes for palette metadata history across create, undo, and redo', () => {
    const side = 1000;
    const editor = createEditor(document(side, side));
    const before = editor.document;
    const densePlaneReads = { kind: 0, colors: 0, completed: 0 };
    const proxyPlane = <T extends Uint8Array | Uint16Array>(plane: T, name: keyof typeof densePlaneReads): T => new Proxy(plane, {
      get(target, property, receiver) {
        densePlaneReads[name] += 1;
        return Reflect.get(target, property, receiver);
      }
    }) as T;
    const originalKind = before.kind;
    const originalColors = before.colors;
    const originalCompleted = before.completed;
    const kind = proxyPlane(originalKind, 'kind');
    const colors = proxyPlane(originalColors, 'colors');
    const completed = proxyPlane(originalCompleted, 'completed');
    before.kind = kind;
    before.colors = colors;
    before.completed = completed;

    const created = editor.execute({ type: 'palette-create', name: 'Green', color: '#3a3' });
    expect(created.changed).toBe(true);
    expect(created.recalculateMetrics).toBe(false);
    expect(editor.document.kind).toBe(kind);
    expect(editor.document.colors).toBe(colors);
    expect(editor.document.completed).toBe(completed);
    expect(editor.document.backstitches).toBe(before.backstitches);
    expect(editor.document.palette).not.toBe(before.palette);
    const createdPalette = editor.document.palette;
    const createdId = created.paletteId;
    expect(createdId).toBeDefined();
    expect(createdPalette.some((entry) => entry.id === createdId && entry.active)).toBe(true);

    expect(editor.undo().changed).toBe(true);
    expect(editor.document.palette).toEqual(before.palette);
    expect(editor.document.kind).toBe(kind);
    expect(editor.document.colors).toBe(colors);
    expect(editor.document.completed).toBe(completed);
    expect(editor.redo().changed).toBe(true);
    expect(editor.document.palette).toEqual(createdPalette);
    expect(editor.document.kind).toBe(kind);
    expect(editor.document.colors).toBe(colors);
    expect(editor.document.completed).toBe(completed);

    editor.document.kind = originalKind;
    editor.document.colors = originalColors;
    editor.document.completed = originalCompleted;
    before.kind = originalKind;
    before.colors = originalColors;
    before.completed = originalCompleted;
    expect(densePlaneReads).toEqual({ kind: 0, colors: 0, completed: 0 });

    const updated = editor.execute({ type: 'palette-update', id: createdId!, name: 'Updated green' });
    expect(updated.changed).toBe(true);
    expect(editor.document.palette.find((entry) => entry.id === createdId)?.name).toBe('Updated green');
    expect(editor.document.kind).toBe(originalKind);
    expect(editor.document.colors).toBe(originalColors);
    expect(editor.document.completed).toBe(originalCompleted);
    expect(editor.undo().changed).toBe(true);
    expect(editor.document.palette).toEqual(createdPalette);
    expect(editor.redo().changed).toBe(true);
    expect(editor.document.palette.find((entry) => entry.id === createdId)?.name).toBe('Updated green');

    const deactivated = editor.execute({ type: 'palette-deactivate', id: createdId! });
    expect(deactivated.changed).toBe(true);
    expect(editor.document.palette.find((entry) => entry.id === createdId)?.active).toBe(false);
    expect(editor.document.kind).toBe(originalKind);
    expect(editor.document.colors).toBe(originalColors);
    expect(editor.document.completed).toBe(originalCompleted);
    expect(editor.undo().changed).toBe(true);
    expect(editor.document.palette.find((entry) => entry.id === createdId)?.active).toBe(true);
    expect(editor.redo().changed).toBe(true);
    expect(editor.document.palette.find((entry) => entry.id === createdId)?.active).toBe(false);

    assertValidDocument(editor.document);
  });

  it('applies heterogeneous per-cell completion masks without disturbing unrelated bits', () => {
    const editor = createEditor(document(3, 1));
    editor.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    editor.execute({ type: 'set-quarter', x: 1, y: 0, corner: QuarterCorner.NW, color: 1 });
    editor.execute({ type: 'set-quarter', x: 1, y: 0, corner: QuarterCorner.SE, color: 2 });
    editor.execute({ type: 'set-completion', x: 1, y: 0, corner: QuarterCorner.NW, completed: true });
    editor.execute({ type: 'set-three-quarter', x: 2, y: 0, corner: QuarterCorner.NW, color: 1 });
    editor.execute({ type: 'set-three-quarter', x: 2, y: 0, corner: QuarterCorner.SE, color: 2 });
    editor.execute({ type: 'set-completion', x: 2, y: 0, corner: QuarterCorner.SE, completed: true });
    editor.execute({ type: 'set-completion', x: 0, y: 0, completed: true });
    editor.clearHistory();

    const command = {
      type: 'bulk-completion' as const,
      indices: new Uint32Array([0, 1, 2]),
      masks: new Uint8Array([1, 4, 1]),
      operation: 'set' as const
    };
    const preflight = preflightBulkCompletionCommand(editor.document, command);
    expect(preflight.changedIndices).toEqual(new Uint32Array([1, 2]));
    expect(preflight.masks).toEqual(new Uint8Array([4, 1]));

    const set = editor.execute(command);
    expect(set.changedIndices).toEqual(new Uint32Array([1, 2]));
    expect(set.progress).toMatchObject({ marked: 2, unmarked: 0 });
    expect(editor.document.completed).toEqual(new Uint8Array([1, 5, 5]));
    expect(editor.undoDepth).toBe(1);

    const clearPairComponent = editor.execute({
      type: 'bulk-completion' as const,
      indices: new Uint32Array([2]),
      masks: new Uint8Array([1]),
      operation: 'clear' as const
    });
    expect(clearPairComponent.changedIndices).toEqual(new Uint32Array([2]));
    expect(clearPairComponent.progress).toMatchObject({ marked: 0, unmarked: 1 });
    expect(editor.document.completed[2]).toBe(4);
    expect(editor.undoDepth).toBe(2);

    editor.undo();
    expect(editor.document.completed[2]).toBe(5);
    editor.redo();
    expect(editor.document.completed[2]).toBe(4);
  });

  it('rejects invalid or conflicting completion masks atomically and treats zero masks as no-ops', () => {
    const editor = createEditor(document(2, 1));
    editor.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    editor.execute({ type: 'set-quarter', x: 1, y: 0, corner: QuarterCorner.NW, color: 2 });
    editor.clearHistory();
    const before = cellSnapshot(editor.document);

    expect(() => editor.execute({ type: 'bulk-completion', indices: new Uint32Array([0, 1]), masks: new Uint8Array([1]), operation: 'set' })).toThrow(/align/);
    expect(() => editor.execute({ type: 'bulk-completion', indices: new Uint32Array([0]), masks: new Uint8Array([2]), operation: 'set' })).toThrow(/subset/);
    expect(() => editor.execute({ type: 'bulk-completion', indices: new Uint32Array([1]), masks: new Uint8Array([2]), operation: 'set' })).toThrow(/subset/);
    expect(() => editor.execute({ type: 'bulk-completion', indices: new Uint32Array([0]), masks: new Uint8Array([1]), corner: QuarterCorner.NW, operation: 'set' })).toThrow(/corner/);
    expect(() => editor.execute({ type: 'bulk-completion', indices: new Uint32Array([0]), masks: [1], operation: 'set' })).toThrow(/Uint8Array/);
    expect(editor.document).toEqual(before);
    expect(editor.undoDepth).toBe(0);

    const revision = editor.revision;
    const noOp = editor.execute({ type: 'bulk-completion', indices: new Uint32Array([0, 1]), masks: new Uint8Array([0, 0]), operation: 'set' });
    expect(noOp.changed).toBe(false);
    expect(noOp.changedIndices).toEqual(new Uint32Array(0));
    expect(editor.revision).toBe(revision);
    expect(editor.undoDepth).toBe(0);
  });

  it('tracks bulk backstitch progress by stable IDs and supports one undo entry', () => {
    const editor = createEditor(document(3, 2));
    editor.execute({ type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 4 }, color: 1 });
    editor.execute({ type: 'add-backstitch', start: { x: 0, y: 4 }, end: { x: 4, y: 8 }, color: 2 });
    editor.execute({ type: 'add-backstitch', start: { x: 4, y: 0 }, end: { x: 8, y: 4 }, color: 3 });
    editor.clearHistory();

    const set = editor.execute(bulkSetBackstitchCompletionCommand(new Uint32Array([1, 2])));
    expect(set.touchedBackstitchIds).toEqual(new Uint32Array([1, 2]));
    expect(set.changedBackstitchIds).toEqual(new Uint32Array([1, 2]));
    expect(editor.document.backstitches.completed).toEqual(new Uint8Array([1, 1, 0]));
    expect(editor.historyBytes).toBe(estimateBulkBackstitchCompletionHistoryBytes(2));
    expect(editor.undoDepth).toBe(1);
    expect(() => editor.execute(bulkSetBackstitchCompletionCommand(new Uint32Array([1, 99])))).toThrow(/does not exist/);

    const clear = editor.execute(bulkClearBackstitchCompletionCommand(new Uint32Array([1, 2])));
    expect(clear.changedBackstitchIds).toEqual(new Uint32Array([1, 2]));
    const toggle = editor.execute(bulkToggleBackstitchCompletionCommand(new Uint32Array([2, 3])));
    expect(toggle.changedBackstitchIds).toEqual(new Uint32Array([2, 3]));
    expect(editor.document.backstitches.completed).toEqual(new Uint8Array([0, 1, 1]));

    editor.undo();
    expect(editor.document.backstitches.completed).toEqual(new Uint8Array([0, 0, 0]));
    editor.redo();
    expect(editor.document.backstitches.completed).toEqual(new Uint8Array([0, 1, 1]));
  });

  it('rejects unsorted or geometrically invalid bulk completion targets before mutation', () => {
    const editor = createEditor(document(2, 1));
    editor.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    const before = cellSnapshot(editor.document);
    expect(() => editor.execute(bulkSetCompletionCommand(new Uint32Array([1, 0])))).toThrow(/strictly increasing/);
    expect(() => editor.execute(bulkSetCompletionCommand(new Uint32Array([0]), QuarterCorner.NW))).toThrow(/quarter geometry/);
    expect(() => editor.execute(bulkSetCompletionCommand(new Uint32Array([1])))).toThrow(/occupied geometry/);
    expect(editor.document).toEqual(before);
    expect(editor.document.revision).toBe(1);
  });

  it('copies result index arrays so callers cannot alter undo/redo state', () => {
    const editor = createEditor(document(2, 2));
    const command = bulkSetFullCommand(new Uint32Array([0, 1]), 1);
    const result = editor.execute(command);
    expect(result.changedIndices).toBeInstanceOf(Uint32Array);
    expect(result.touchedIndices).toBeInstanceOf(Uint32Array);

    result.changedIndices?.fill(3);
    result.touchedIndices?.fill(3);
    editor.undo();
    expect(editor.document.kind[0]).toBe(CellKind.Empty);
    expect(editor.document.kind[1]).toBe(CellKind.Empty);
    editor.redo();
    expect(editor.document.kind[0]).toBe(CellKind.Full);
    expect(editor.document.kind[1]).toBe(CellKind.Full);

    const deleteEditor = createEditor(document(2, 2));
    deleteEditor.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    deleteEditor.clearHistory();
    const deleteResult = deleteEditor.execute(deleteRegionCommand({ x: 0, y: 0, width: 1, height: 1 }, deleteEditor.revision));
    deleteResult.changedIndices?.fill(3);
    deleteResult.touchedIndices?.fill(3);
    deleteEditor.undo();
    expect(deleteEditor.document.kind[0]).toBe(CellKind.Full);
    deleteEditor.redo();
    expect(deleteEditor.document.kind[0]).toBe(CellKind.Empty);
  });

  it('does not create history for empty or already matching bulk targets', () => {
    const editor = createEditor(document(2, 2));
    const empty = editor.execute(bulkSetFullCommand(new Uint32Array(0), 1));
    expect(empty.changed).toBe(false);
    expect(empty.touchedIndices).toEqual(new Uint32Array(0));
    expect(empty.changedIndices).toEqual(new Uint32Array(0));
    editor.execute(bulkSetFullCommand(new Uint32Array([0, 1]), 1));
    editor.clearHistory();
    const noOp = editor.execute(bulkSetFullCommand(new Uint32Array([0, 1]), 1));
    expect(noOp.changed).toBe(false);
    expect(noOp.revision).toBe(1);
    expect(editor.undoDepth).toBe(0);
    expect(editor.historyBytes).toBe(0);
  });

  it('preflights bulk history size before mutation', () => {
    const editor = createEditor(document(4, 3), { historyLimitBytes: 103 });
    const before = cellSnapshot(editor.document);
    expect(() => editor.execute(bulkSetFullCommand(new Uint32Array([0, 1, 2]), 1))).toThrow(/exceeding/);
    expect(editor.document).toEqual(before);
    expect(editor.document.revision).toBe(0);
    expect(editor.undoDepth).toBe(0);
    expect(editor.redoDepth).toBe(0);
  });

  it('handles a 500 by 500 homogeneous fill without per-cell commands', () => {
    const width = 500;
    const height = 500;
    const indices = Uint32Array.from({ length: width * height }, (_, index) => index);
    const editor = createEditor(createDocument({ width, height, catalog: TEST_CATALOG, palette: [{ id: 1, name: 'Red', color: '#d33' }] }));
    const result = editor.execute(bulkSetFullCommand(indices, 1));
    expect(result.changed).toBe(true);
    expect(result.revision).toBe(1);
    expect(result.changedIndices).toHaveLength(width * height);
    expect(editor.undoDepth).toBe(1);
    expect(editor.lastHistoryEntryKind).toBe('delta');
    expect(editor.historyBytes).toBeLessThanOrEqual(DEFAULT_HISTORY_LIMIT_BYTES);
    expect(editor.document.kind[0]).toBe(CellKind.Full);
    expect(editor.document.kind.at(-1)).toBe(CellKind.Full);

    const historyBytes = editor.historyBytes;
    const noOp = editor.execute(bulkSetFullCommand(indices, 1));
    expect(noOp.changed).toBe(false);
    expect(editor.undoDepth).toBe(1);
    expect(editor.historyBytes).toBe(historyBytes);
    expect(editor.undo().changed).toBe(true);
    expect(editor.document.kind[0]).toBe(CellKind.Empty);
    expect(editor.document.kind.at(-1)).toBe(CellKind.Empty);
    expect(editor.redo().changed).toBe(true);
    expect(editor.document.kind[0]).toBe(CellKind.Full);
  });

  it('proves the packed 1,000 by 1,000 bulk path is one bounded undoable entry', () => {
    const side = 1_000;
    const cellCount = side * side;
    expect(cellCount).toBe(MAX_PERSISTABLE_CELL_COUNT);
    const indices = Uint32Array.from({ length: cellCount }, (_, index) => index);
    const editor = createEditor(createDocument({ width: side, height: side, catalog: TEST_CATALOG, palette: [{ id: 1, name: 'Red', color: '#d33' }] }));
    const command = bulkSetFullCommand(indices, 1);

    const result = editor.execute(command);
    expect(result.revision).toBe(1);
    expect(result.changedIndices).toBeInstanceOf(Uint32Array);
    expect(result.changedIndices).toHaveLength(cellCount);
    expect(editor.lastHistoryEntryKind).toBe('delta');
    expect(editor.undoDepth).toBe(1);
    expect(editor.historyBytes).toBe(estimateBulkCellHistoryBytes(cellCount));
    expect(editor.historyBytes).toBeLessThanOrEqual(DEFAULT_HISTORY_LIMIT_BYTES);

    const historyBytes = editor.historyBytes;
    const noOp = editor.execute(command);
    expect(noOp.changed).toBe(false);
    expect(editor.undoDepth).toBe(1);
    expect(editor.historyBytes).toBe(historyBytes);

    editor.undo();
    expect(editor.document.kind[0]).toBe(CellKind.Empty);
    expect(editor.document.kind.at(-1)).toBe(CellKind.Empty);
    expect(editor.redoDepth).toBe(1);
    editor.redo();
    expect(editor.document.kind[0]).toBe(CellKind.Full);
    expect(editor.document.kind.at(-1)).toBe(CellKind.Full);
  });

  it('rejects a 1,000 by 1,000 bulk entry over budget before mutation', () => {
    const side = 1_000;
    const cellCount = side * side;
    const requiredBytes = estimateBulkCellHistoryBytes(cellCount);
    const editor = createEditor(createDocument({ width: side, height: side, catalog: TEST_CATALOG, palette: [{ id: 1, name: 'Red', color: '#d33' }] }), { historyLimitBytes: requiredBytes - 1 });
    const before = editor.document;
    const command = bulkSetFullCommand(Uint32Array.from({ length: cellCount }, (_, index) => index), 1);

    expect(() => editor.execute(command)).toThrow(/exceeding/);
    expect(editor.document).toBe(before);
    expect(editor.document.revision).toBe(0);
    expect(editor.document.kind[0]).toBe(CellKind.Empty);
    expect(editor.document.kind.at(-1)).toBe(CellKind.Empty);
    expect(editor.undoDepth).toBe(0);
    expect(editor.redoDepth).toBe(0);
    expect(editor.historyBytes).toBe(0);
  });

  it('records one batch entry, treats no-ops as inert, and never reuses IDs', () => {
    const editor = createEditor(document());
    editor.executeBatch([
      { type: 'set-full', x: 0, y: 0, color: 1 },
      { type: 'set-full', x: 1, y: 0, color: 2 }
    ]);
    expect(editor.undoDepth).toBe(1);
    expect(editor.document.revision).toBe(1);
    editor.undo();
    expect(editor.document.kind).toEqual(new Uint8Array(12));
    expect(editor.redoDepth).toBe(1);
    expect(editor.document.revision).toBe(2);
    editor.redo();
    expect(editor.document.revision).toBe(3);

    const noOp = editor.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    expect(noOp.changed).toBe(false);
    expect(editor.document.revision).toBe(3);
    editor.execute({ type: 'erase-cell', x: 0, y: 0 });
    const added = editor.execute({ type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 1 });
    expect(added.backstitchId).toBe(1);
    editor.undo();
    const next = editor.execute({ type: 'add-backstitch', start: { x: 0, y: 4 }, end: { x: 4, y: 4 }, color: 1 });
    expect(next.backstitchId).toBe(2);
  });

  it('uses a packed sparse delta for a one-cell edit in a 1,000 by 1,000 pattern', () => {
    const pattern = createDocument({ width: 1000, height: 1000, catalog: TEST_CATALOG, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    const editor = createEditor(pattern);
    editor.execute({ type: 'set-full', x: 777, y: 888, color: 1 });
    expect(editor.lastHistoryEntryKind).toBe('delta');
    expect(editor.historyBytes).toBeLessThan(1024);
    expect(editor.historyBytes).toBeLessThan(pattern.kind.byteLength);
    editor.undo();
    expect(editor.document.kind[888000 + 777]).toBe(CellKind.Empty);
    editor.redo();
    expect(editor.document.kind[888000 + 777]).toBe(CellKind.Full);

    const transformed = editor.execute({ type: 'mirror-horizontal' });
    expect(transformed.changed).toBe(true);
    expect(editor.historyBytes).toBeLessThanOrEqual(DEFAULT_HISTORY_LIMIT_BYTES);

    const cropped = editor.execute({ type: 'crop', x: 0, y: 0, width: 999, height: 1000 });
    expect(cropped.changed).toBe(true);
    expect(editor.document.width).toBe(999);
    expect(editor.document.height).toBe(1000);
    expect(editor.historyBytes).toBeLessThanOrEqual(DEFAULT_HISTORY_LIMIT_BYTES);
  }, 15_000);

  it('rejects an oversized delta entry atomically', () => {
    const editor = createEditor(document(), { historyLimitBytes: 55 });
    const before = editor.document;
    expect(() => editor.execute({ type: 'set-full', x: 0, y: 0, color: 1 })).toThrow(DomainError);
    expect(() => editor.execute({ type: 'set-full', x: 0, y: 0, color: 1 })).toThrow(/History entry requires/);
    expect(editor.document).toBe(before);
    expect(editor.document.revision).toBe(0);
    expect(editor.undoDepth).toBe(0);
    expect(editor.redoDepth).toBe(0);
    expect(editor.historyBytes).toBe(0);
  });

  it('rejects an oversized snapshot entry atomically', () => {
    const editor = createEditor(document(), { historyLimitBytes: 900 });
    const before = editor.document;
    expect(() => editor.execute({ type: 'rotate-cw' })).toThrow(DomainError);
    expect(editor.document).toBe(before);
    expect(editor.document.revision).toBe(0);
    expect(editor.undoDepth).toBe(0);
    expect(editor.redoDepth).toBe(0);
    expect(editor.historyBytes).toBe(0);
  });

  it('captures typed full, half, and quarter fragment cells without completion data', () => {
    let source = document(5, 3);
    source = apply(source, { type: 'set-full', x: 1, y: 0, color: 1 });
    source = apply(source, { type: 'set-completion', x: 1, y: 0, completed: true });
    source = apply(source, { type: 'set-half', x: 2, y: 0, direction: HalfDirection.Slash, color: 2 });
    source = apply(source, { type: 'set-completion', x: 2, y: 0, completed: true });
    source = apply(source, { type: 'set-quarter', x: 3, y: 0, corner: QuarterCorner.NW, color: 1 });
    source = apply(source, { type: 'set-quarter', x: 3, y: 0, corner: QuarterCorner.SE, color: 3 });
    source = apply(source, { type: 'set-completion', x: 3, y: 0, corner: QuarterCorner.NW, completed: true });
    source = apply(source, { type: 'set-completion', x: 3, y: 0, corner: QuarterCorner.SE, completed: true });
    source = apply(source, { type: 'add-backstitch', start: { x: 4, y: 0 }, end: { x: 16, y: 4 }, color: 2 });
    source = apply(source, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 4 }, color: 1 });

    const fragment = createPatternFragment(source, { x: 1, y: 0, width: 3, height: 2 });
    expect(fragment.version).toBe(1);
    expect(fragment.kind).toBeInstanceOf(Uint8Array);
    expect(fragment.colors).toBeInstanceOf(Uint16Array);
    expect(fragment.kind).toHaveLength(6);
    expect(fragment.colors).toHaveLength(24);
    expect('completed' in fragment).toBe(false);
    expect('completed' in fragment.backstitches).toBe(false);
    expect(validatePatternFragment(fragment)).toBe(true);
    expect(readPatternFragmentCell(fragment, 0, 0)).toMatchObject({ kind: CellKind.Full });
    expect(readPatternFragmentCell(fragment, 1, 0)).toMatchObject({ kind: CellKind.HalfSlash });
    expect(readPatternFragmentCell(fragment, 2, 0)).toMatchObject({ kind: CellKind.Quarters });
    expect(readPatternFragmentCell(fragment, 2, 0).colors).toEqual(new Uint16Array([1, 0, 3, 0]));
    expect(fragment.backstitches.x1).toEqual(new Uint32Array([0]));
    expect(fragment.backstitches.y1).toEqual(new Uint32Array([0]));
    expect(fragment.backstitches.x2).toEqual(new Uint32Array([12]));
    expect(fragment.backstitches.y2).toEqual(new Uint32Array([4]));
    expect(fragment.backstitches.colors).toEqual(new Uint16Array([2]));
  });

  it('captures, validates, and pastes directional three-quarter fragment cells', () => {
    let source = document(2, 1);
    source = apply(source, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.SE, color: 2 });
    source = apply(source, { type: 'set-completion', x: 0, y: 0, completed: true });
    const fragment = createPatternFragment(source, { x: 0, y: 0, width: 1, height: 1 });
    expect(validatePatternFragment(fragment)).toBe(true);
    expect(readPatternFragmentCell(fragment, 0, 0)).toMatchObject({ kind: CellKind.ThreeQuarterSE, colors: new Uint16Array([2, 0, 0, 0]) });

    const destination = applyCommand(document(2, 1), pasteFragmentCommand(fragment, { x: 1, y: 0 }));
    expect(destination.document.kind[1]).toBe(CellKind.ThreeQuarterSE);
    expect(destination.document.colors.slice(4, 8)).toEqual(new Uint16Array([2, 0, 0, 0]));
    expect(destination.document.completed[1]).toBe(0);

    const invalid = { ...fragment, colors: new Uint16Array([2, 1, 0, 0]) };
    expect(validatePatternFragment(invalid)).toBe(false);
  });

  it('pastes fragments transparently with incomplete cells and new backstitch IDs', () => {
    let source = document(5, 3);
    source = apply(source, { type: 'set-full', x: 1, y: 0, color: 1 });
    source = apply(source, { type: 'set-half', x: 2, y: 0, direction: HalfDirection.Slash, color: 2 });
    source = apply(source, { type: 'set-quarter', x: 3, y: 0, corner: QuarterCorner.NW, color: 1 });
    source = apply(source, { type: 'set-quarter', x: 3, y: 0, corner: QuarterCorner.SE, color: 3 });
    source = apply(source, { type: 'add-backstitch', start: { x: 4, y: 0 }, end: { x: 16, y: 4 }, color: 2 });
    const fragment = createPatternFragment(source, { x: 1, y: 0, width: 3, height: 2 });

    let destination = document(6, 4);
    destination = apply(destination, { type: 'set-full', x: 1, y: 1, color: 1 });
    destination = apply(destination, { type: 'set-completion', x: 1, y: 1, completed: true });
    destination = apply(destination, { type: 'set-half', x: 2, y: 1, direction: HalfDirection.Slash, color: 2 });
    destination = apply(destination, { type: 'set-completion', x: 2, y: 1, completed: true });
    destination = apply(destination, { type: 'set-quarter', x: 3, y: 1, corner: QuarterCorner.NW, color: 1 });
    destination = apply(destination, { type: 'set-quarter', x: 3, y: 1, corner: QuarterCorner.SE, color: 3 });
    destination = apply(destination, { type: 'set-completion', x: 3, y: 1, corner: QuarterCorner.NW, completed: true });
    destination = apply(destination, { type: 'set-completion', x: 3, y: 1, corner: QuarterCorner.SE, completed: true });
    destination = apply(destination, { type: 'set-full', x: 1, y: 2, color: 3 });
    destination = apply(destination, { type: 'add-backstitch', start: { x: 0, y: 12 }, end: { x: 4, y: 12 }, color: 1 });
    const directApply = applyCommand(destination, pasteFragmentCommand(fragment, { x: 1, y: 1 }));
    expect(directApply.createdBackstitchIds).toEqual(new Uint32Array([2]));
    expect(listBackstitches(directApply.document)).toMatchObject([
      { id: 1, x1: 0, y1: 12, x2: 4, y2: 12, color: 1 },
      { id: 2, x1: 4, y1: 4, x2: 16, y2: 8, color: 2 }
    ]);
    const initialRevision = destination.revision;
    const editor = createEditor(destination);
    const result = editor.execute(pasteFragmentCommand(fragment, { x: 1, y: 1 }));

    expect(result.revision).toBe(initialRevision + 1);
    expect(editor.undoDepth).toBe(1);
    expect(editor.lastHistoryEntryKind).toBe('delta');
    expect(result.createdBackstitchIds).toEqual(new Uint32Array([2]));
    expect(getCell(editor.document, 1, 1)).toMatchObject({ kind: CellKind.Full, color: 1, completed: false });
    expect(getCell(editor.document, 2, 1)).toMatchObject({ kind: CellKind.HalfSlash, color: 2, completed: false });
    expect(getCell(editor.document, 3, 1).quarters[QuarterCorner.NW]).toMatchObject({ color: 1, completed: false });
    expect(getCell(editor.document, 3, 1).quarters[QuarterCorner.SE]).toMatchObject({ color: 3, completed: false });
    expect(getCell(editor.document, 1, 2)).toMatchObject({ kind: CellKind.Full, color: 3 });
    expect(listBackstitches(editor.document)).toMatchObject([
      { id: 1, x1: 0, y1: 12, x2: 4, y2: 12, color: 1 },
      { id: 2, x1: 4, y1: 4, x2: 16, y2: 8, color: 2 }
    ]);

    editor.undo();
    expect(getCell(editor.document, 1, 1).kind).toBe(CellKind.Full);
    expect(getCell(editor.document, 1, 1).completed).toBe(true);
    expect(listBackstitches(editor.document)).toHaveLength(1);
    editor.redo();
    expect(getCell(editor.document, 1, 1).completed).toBe(false);
    expect(listBackstitches(editor.document)).toHaveLength(2);
  });

  it('rejects malformed fragments, palette references, and placement atomically', () => {
    let source = document(2, 2);
    source = apply(source, { type: 'set-full', x: 0, y: 0, color: 1 });
    const fragment = createPatternFragment(source, { x: 0, y: 0, width: 2, height: 2 });
    const destinationEditor = createEditor(document(4, 4));
    const before = destinationEditor.document;

    const invalidPalette = { ...fragment, colors: fragment.colors.slice() } as PatternFragment;
    invalidPalette.colors[0] = 99;
    expect(() => destinationEditor.execute(pasteFragmentCommand(invalidPalette, { x: 0, y: 0 }))).toThrow(/Palette/);
    expect(destinationEditor.document).toBe(before);
    expect(destinationEditor.document.revision).toBe(0);
    expect(destinationEditor.undoDepth).toBe(0);

    const invalidGeometry = {
      ...fragment,
      backstitches: {
        x1: new Uint32Array([0]),
        y1: new Uint32Array([0]),
        x2: new Uint32Array([9]),
        y2: new Uint32Array([0]),
        colors: new Uint16Array([1])
      }
    } as PatternFragment;
    expect(() => destinationEditor.execute(pasteFragmentCommand(invalidGeometry, { x: 0, y: 0 }))).toThrow(/fragment boundary/);
    expect(destinationEditor.document).toBe(before);
    expect(() => destinationEditor.execute(pasteFragmentCommand(fragment, { x: 3, y: 3 }))).toThrow(/fit entirely/);
    expect(destinationEditor.document).toBe(before);
    const invalidShape = { ...fragment, colors: new Uint16Array(1) } as PatternFragment;
    expect(() => pasteFragmentCommand(invalidShape, { x: 0, y: 0 })).toThrow(/colors/);
    const invalidDuplicate = {
      ...fragment,
      backstitches: {
        x1: new Uint32Array([0, 0]),
        y1: new Uint32Array([0, 0]),
        x2: new Uint32Array([4, 4]),
        y2: new Uint32Array([4, 4]),
        colors: new Uint16Array([1, 1])
      }
    } as PatternFragment;
    expect(() => pasteFragmentCommand(invalidDuplicate, { x: 0, y: 0 })).toThrow(/duplicates/);
    const budgetEditor = createEditor(document(4, 4), { historyLimitBytes: estimatePasteFragmentHistoryBytes(1, 0, 0) - 1 });
    const budgetBefore = budgetEditor.document;
    expect(() => budgetEditor.execute(pasteFragmentCommand(fragment, { x: 0, y: 0 }))).toThrow(/exceeding/);
    expect(budgetEditor.document).toBe(budgetBefore);
    expect(budgetEditor.undoDepth).toBe(0);
    expect(validatePatternFragment(invalidGeometry)).toBe(false);
    expect(() => assertValidPatternFragment(invalidGeometry)).toThrow(DomainError);
  });

  it('moves rectangular contents atomically across overlap while preserving completion and transparent holes', () => {
    let pattern = document(6, 3);
    pattern = apply(pattern, { type: 'set-full', x: 0, y: 0, color: 1 });
    pattern = apply(pattern, { type: 'set-completion', x: 0, y: 0, completed: true });
    pattern = apply(pattern, { type: 'set-half', x: 1, y: 0, direction: HalfDirection.Slash, color: 2 });
    pattern = apply(pattern, { type: 'set-completion', x: 1, y: 0, completed: true });
    pattern = apply(pattern, { type: 'set-full', x: 1, y: 1, color: 3 });
    pattern = apply(pattern, { type: 'set-full', x: 3, y: 1, color: 3 });
    const before = documentContentSnapshot(pattern);
    const editor = createEditor(pattern);

    const result = editor.execute(moveFragmentCommand(
      { kind: 'rect', rect: { x: 0, y: 0, width: 3, height: 1 } },
      { x: 1, y: 1 }
    ));

    expect(result.changed).toBe(true);
    expect(result.changedIndices).toEqual(new Uint32Array([0, 1, 7, 8]));
    expect(result.movedBackstitchIds).toEqual(new Uint32Array(0));
    expect(result.progress).toEqual({ cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0), marked: 0, unmarked: 0 });
    expect(result.recalculateMetrics).toBe(true);
    expect(editor.undoDepth).toBe(1);
    expect(getCell(editor.document, 0, 0).kind).toBe(CellKind.Empty);
    expect(getCell(editor.document, 1, 0).kind).toBe(CellKind.Empty);
    expect(getCell(editor.document, 1, 1)).toMatchObject({ kind: CellKind.Full, color: 1, completed: true });
    expect(getCell(editor.document, 2, 1)).toMatchObject({ kind: CellKind.HalfSlash, color: 2, completed: true });
    expect(getCell(editor.document, 3, 1)).toMatchObject({ kind: CellKind.Full, color: 3 });

    editor.undo();
    expect(documentContentSnapshot(editor.document)).toEqual(before);
    editor.redo();
    expect(getCell(editor.document, 1, 1)).toMatchObject({ kind: CellKind.Full, color: 1, completed: true });
    expect(editor.historyBytes).toBe(estimateMoveFragmentHistoryBytes(4, 0, 0));
  });

  it('clones rectangular and sparse footprints in the move factory', () => {
    const rect = { kind: 'rect' as const, rect: { x: 0, y: 0, width: 2, height: 1 } };
    const sparseIndices = new Uint32Array([0, 2]);
    const sparse = { kind: 'sparse' as const, rect: { x: 0, y: 0, width: 3, height: 1 }, indices: sparseIndices };
    const rectCommand = moveFragmentCommand(rect, { x: 1, y: 1 });
    const sparseCommand = moveFragmentCommand(sparse, { x: 1, y: 1 });
    rect.rect.x = 7;
    sparse.rect.x = 7;
    sparseIndices[0] = 7;
    expect((rectCommand.selection as { rect: { x: number } }).rect.x).toBe(0);
    expect((sparseCommand.selection as { rect: { x: number }; indices: Uint32Array }).rect.x).toBe(0);
    expect((sparseCommand.selection as { rect: { x: number }; indices: Uint32Array }).indices).toEqual(new Uint32Array([0, 2]));
  });

  it('handles forward and reverse rectangular and sparse overlap from original captures', () => {
    let forward = document(5, 1);
    forward = apply(forward, { type: 'set-full', x: 0, y: 0, color: 1 });
    forward = apply(forward, { type: 'set-full', x: 1, y: 0, color: 2 });
    forward = apply(forward, { type: 'set-full', x: 2, y: 0, color: 3 });
    const forwardEditor = createEditor(forward);
    forwardEditor.execute(moveFragmentCommand({ kind: 'rect', rect: { x: 0, y: 0, width: 3, height: 1 } }, { x: 1, y: 0 }));
    expect([0, 1, 2, 3, 4].map((x) => getCell(forwardEditor.document, x, 0).color)).toEqual([0, 1, 2, 3, 0]);

    let reverse = document(5, 1);
    reverse = apply(reverse, { type: 'set-full', x: 1, y: 0, color: 1 });
    reverse = apply(reverse, { type: 'set-full', x: 2, y: 0, color: 2 });
    reverse = apply(reverse, { type: 'set-full', x: 3, y: 0, color: 3 });
    const reverseEditor = createEditor(reverse);
    reverseEditor.execute(moveFragmentCommand({ kind: 'rect', rect: { x: 1, y: 0, width: 3, height: 1 } }, { x: 0, y: 0 }));
    expect([0, 1, 2, 3, 4].map((x) => getCell(reverseEditor.document, x, 0).color)).toEqual([1, 2, 3, 0, 0]);

    const sparseEditor = createEditor(forward);
    sparseEditor.execute(moveFragmentCommand({ kind: 'sparse', rect: { x: 0, y: 0, width: 3, height: 1 }, indices: new Uint32Array([0, 2]) }, { x: 1, y: 0 }));
    expect([0, 1, 2, 3, 4].map((x) => getCell(sparseEditor.document, x, 0).color)).toEqual([0, 1, 0, 3, 0]);

    const reverseSparse = createEditor(reverse);
    reverseSparse.execute(moveFragmentCommand({ kind: 'sparse', rect: { x: 1, y: 0, width: 3, height: 1 }, indices: new Uint32Array([1, 3]) }, { x: 0, y: 0 }));
    expect([0, 1, 2, 3, 4].map((x) => getCell(reverseSparse.document, x, 0).color)).toEqual([1, 0, 3, 0, 0]);
  });

  it('moves sparse cells without overwriting destination holes or selected empties', () => {
    let pattern = document(6, 3);
    pattern = apply(pattern, { type: 'set-full', x: 0, y: 0, color: 1 });
    pattern = apply(pattern, { type: 'set-half', x: 2, y: 0, direction: HalfDirection.Backslash, color: 2 });
    pattern = apply(pattern, { type: 'set-full', x: 4, y: 1, color: 3 });
    const editor = createEditor(pattern);
    const result = editor.execute(moveFragmentCommand(
      { kind: 'sparse', rect: { x: 0, y: 0, width: 3, height: 1 }, indices: new Uint32Array([0, 2]) },
      { x: 3, y: 1 }
    ));

    expect(result.changedIndices).toEqual(new Uint32Array([0, 2, 9, 11]));
    expect(getCell(editor.document, 0, 0).kind).toBe(CellKind.Empty);
    expect(getCell(editor.document, 2, 0).kind).toBe(CellKind.Empty);
    expect(getCell(editor.document, 3, 1)).toMatchObject({ kind: CellKind.Full, color: 1 });
    expect(getCell(editor.document, 4, 1)).toMatchObject({ kind: CellKind.Full, color: 3 });
    expect(getCell(editor.document, 5, 1)).toMatchObject({ kind: CellKind.HalfBackslash, color: 2 });
  });

  it('moves contained backstitches with stable identity and retains boundary-crossing lines', () => {
    let pattern = document(8, 4);
    pattern = apply(pattern, { type: 'set-full', x: 1, y: 1, color: 1 });
    pattern = apply(pattern, { type: 'set-full', x: 2, y: 1, color: 2 });
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 4, y: 4 }, end: { x: 8, y: 4 }, color: 1 });
    pattern = apply(pattern, { type: 'set-backstitch-completion', id: 1, completed: true });
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 0, y: 4 }, end: { x: 8, y: 4 }, color: 2 });
    pattern = apply(pattern, { type: 'set-backstitch-completion', id: 2, completed: true });
    const nextId = pattern.nextBackstitchId;
    const editor = createEditor(pattern);
    const result = editor.execute(moveFragmentCommand(
      { kind: 'rect', rect: { x: 1, y: 1, width: 2, height: 1 } },
      { x: 4, y: 1 }
    ));

    expect(result.movedBackstitchIds).toEqual(new Uint32Array([1]));
    expect(editor.document.nextBackstitchId).toBe(nextId);
    expect(listBackstitches(editor.document)).toMatchObject([
      { id: 1, x1: 16, y1: 4, x2: 20, y2: 4, color: 1, completed: true },
      { id: 2, x1: 0, y1: 4, x2: 8, y2: 4, color: 2, completed: true }
    ]);
    editor.undo();
    expect(listBackstitches(editor.document)).toMatchObject([
      { id: 1, x1: 4, y1: 4, x2: 8, y2: 4, color: 1, completed: true },
      { id: 2, x1: 0, y1: 4, x2: 8, y2: 4, color: 2, completed: true }
    ]);
    editor.redo();
    expect(listBackstitches(editor.document)[0]).toMatchObject({ id: 1, x1: 16, x2: 20, completed: true });
  });

  it('rejects move collisions, bounds, palette, and history failures atomically', () => {
    let pattern = document(6, 3);
    pattern = apply(pattern, { type: 'set-full', x: 0, y: 0, color: 1 });
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 1 });
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 12, y: 0 }, end: { x: 16, y: 0 }, color: 2 });
    const collision = createEditor(pattern);
    const collisionBefore = documentContentSnapshot(collision.document);
    expect(() => collision.execute(moveFragmentCommand({ kind: 'rect', rect: { x: 0, y: 0, width: 1, height: 1 } }, { x: 3, y: 0 }))).toThrow(/collides/);
    expect(documentContentSnapshot(collision.document)).toEqual(collisionBefore);
    expect(collision.undoDepth).toBe(0);

    const bounds = createEditor(pattern);
    const boundsBefore = bounds.document;
    expect(() => bounds.execute(moveFragmentCommand({ kind: 'rect', rect: { x: 0, y: 0, width: 2, height: 1 } }, { x: 5, y: 0 }))).toThrow(/fit entirely/);
    expect(bounds.document).toBe(boundsBefore);

    const palette = createEditor(pattern);
    const paletteBefore = palette.document;
    palette.document.palette.length = 0;
    expect(() => palette.execute(moveFragmentCommand({ kind: 'rect', rect: { x: 0, y: 0, width: 1, height: 1 } }, { x: 1, y: 0 }))).toThrow(/Palette/);
    expect(palette.document).toBe(paletteBefore);

    const budget = createEditor(pattern, { historyLimitBytes: estimateMoveFragmentHistoryBytes(2, 2, 2) - 1 });
    const budgetBefore = budget.document;
    expect(() => budget.execute(moveFragmentCommand({ kind: 'rect', rect: { x: 0, y: 0, width: 1, height: 1 } }, { x: 1, y: 1 }))).toThrow(/exceeding/);
    expect(budget.document).toBe(budgetBefore);
    expect(budget.undoDepth).toBe(0);
  });

  it('treats same-position moves as no-ops without history', () => {
    let pattern = document(4, 3);
    pattern = apply(pattern, { type: 'set-full', x: 1, y: 1, color: 1 });
    const editor = createEditor(pattern);
    const before = editor.document;
    const result = editor.execute(moveFragmentCommand({ kind: 'rect', rect: { x: 1, y: 1, width: 1, height: 1 } }, { x: 1, y: 1 }));
    expect(result.changed).toBe(false);
    expect(result.changedIndices).toEqual(new Uint32Array(0));
    expect(result.movedBackstitchIds).toEqual(new Uint32Array(0));
    expect(editor.document).toBe(before);
    expect(editor.undoDepth).toBe(0);
  });

  it('treats a different-position transparent move as a no-op', () => {
    const editor = createEditor(document(6, 4));
    const before = editor.document;
    const result = editor.execute(moveFragmentCommand({ kind: 'rect', rect: { x: 0, y: 0, width: 2, height: 2 } }, { x: 3, y: 2 }));
    expect(result.changed).toBe(false);
    expect(result.changedIndices).toEqual(new Uint32Array(0));
    expect(result.progress).toEqual({ cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0), marked: 0, unmarked: 0 });
    expect(result.recalculateMetrics).toBeUndefined();
    expect(editor.document).toBe(before);
    expect(editor.undoDepth).toBe(0);
  });

  it('accounts exactly for backstitch history and supports backstitch-only undo/redo', () => {
    let pattern = document(8, 3);
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 1 });
    const editor = createEditor(pattern);
    const result = editor.execute(moveFragmentCommand({ kind: 'rect', rect: { x: 0, y: 0, width: 1, height: 1 } }, { x: 3, y: 0 }));
    expect(result.changedIndices).toEqual(new Uint32Array(0));
    expect(result.movedBackstitchIds).toEqual(new Uint32Array([1]));
    expect(result.progress).toEqual({ cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0), marked: 0, unmarked: 0 });
    expect(result.recalculateMetrics).toBe(true);
    expect(editor.historyBytes).toBe(estimateMoveFragmentHistoryBytes(0, 1, 1));
    const moved = listBackstitches(editor.document);
    expect(moved[0]).toMatchObject({ x1: 12, y1: 0, x2: 16, y2: 0 });
    const undo = editor.undo();
    expect(undo.changedIndices).toEqual(new Uint32Array(0));
    expect(undo.progress).toEqual({ cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0), marked: 0, unmarked: 0 });
    expect(undo.recalculateMetrics).toBe(true);
    expect(listBackstitches(editor.document)[0]).toMatchObject({ x1: 0, y1: 0, x2: 4, y2: 0 });
    const redo = editor.redo();
    expect(redo.changedIndices).toEqual(new Uint32Array(0));
    expect(redo.recalculateMetrics).toBe(true);
    expect(listBackstitches(editor.document)[0]).toMatchObject({ x1: 12, y1: 0, x2: 16, y2: 0 });
  });

  it('preserves completed overwrite metrics and zero activity across move undo and redo', () => {
    let pattern = document(4, 2);
    pattern = apply(pattern, { type: 'set-full', x: 0, y: 0, color: 1 });
    pattern = apply(pattern, { type: 'set-completion', x: 0, y: 0, completed: true });
    pattern = apply(pattern, { type: 'set-full', x: 1, y: 0, color: 2 });
    const editor = createEditor(pattern);
    const metrics = (value: PatternDocument) => {
      const computed = computePatternMetrics(value);
      return {
        totals: computed.totals,
        progress: computed.progress,
        materials: computed.materials.map((material) => ({ paletteId: material.paletteId, stitchUnits: material.stitchUnits, estimatedLength: material.estimatedLength }))
      };
    };
    const beforeMetrics = metrics(editor.document);
    const result = editor.execute(moveFragmentCommand({ kind: 'rect', rect: { x: 0, y: 0, width: 1, height: 1 } }, { x: 1, y: 0 }));
    const afterMetrics = metrics(editor.document);
    expect(result.changedIndices).toEqual(new Uint32Array([0, 1]));
    expect(result.progress).toEqual({ cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0), marked: 0, unmarked: 0 });
    expect(result.recalculateMetrics).toBe(true);
    expect(afterMetrics.totals.full).toBe(1);
    expect(afterMetrics.totals.completedComponents).toBe(1);
    expect(afterMetrics.totals.remainingComponents).toBe(0);
    expect(afterMetrics.materials).toEqual(expect.arrayContaining([
      expect.objectContaining({ paletteId: 1, stitchUnits: 1 }),
      expect.objectContaining({ paletteId: 2, stitchUnits: 0 })
    ]));

    const undo = editor.undo();
    expect(undo.changedIndices).toEqual(new Uint32Array([0, 1]));
    expect(undo.progress).toEqual({ cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0), marked: 0, unmarked: 0 });
    expect(undo.recalculateMetrics).toBe(true);
    expect(metrics(editor.document)).toEqual(beforeMetrics);
    const redo = editor.redo();
    expect(redo.changedIndices).toEqual(new Uint32Array([0, 1]));
    expect(redo.progress).toEqual({ cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0), marked: 0, unmarked: 0 });
    expect(redo.recalculateMetrics).toBe(true);
    expect(metrics(editor.document)).toEqual(afterMetrics);
  });

  it('rejects representative large dense and sparse moves before packed history-state allocation', () => {
    const side = 1000;
    const densePattern = document(side, side);
    densePattern.kind[0] = CellKind.Full;
    densePattern.colors[0] = 1;
    const denseEditor = createEditor(densePattern, { historyLimitBytes: 1 });
    const denseBefore = denseEditor.document;
    expect(() => denseEditor.execute(moveFragmentCommand(
      { kind: 'rect', rect: { x: 0, y: 0, width: side - 1, height: side } },
      { x: 1, y: 0 }
    ))).toThrow(/exceeding/);
    expect(denseEditor.document).toBe(denseBefore);
    expect(denseEditor.undoDepth).toBe(0);

    const sparseIndices = new Uint32Array(50_000);
    for (let position = 0; position < sparseIndices.length; position += 1) sparseIndices[position] = position * 2;
    const sparsePattern = document(side, side);
    sparsePattern.kind[0] = CellKind.Full;
    sparsePattern.colors[0] = 1;
    const sparseEditor = createEditor(sparsePattern, { historyLimitBytes: 1 });
    const sparseBefore = sparseEditor.document;
    expect(() => sparseEditor.execute(moveFragmentCommand(
      { kind: 'sparse', rect: { x: 0, y: 0, width: side, height: 100 }, indices: sparseIndices },
      { x: 0, y: 1 }
    ))).toThrow(/exceeding/);
    expect(sparseEditor.document).toBe(sparseBefore);
    expect(sparseEditor.undoDepth).toBe(0);
  });

  it('keeps a large sparse fragment paste within a bounded packed history entry', () => {
    const side = 500;
    let source = document(side, side);
    source = apply(source, { type: 'set-full', x: side - 1, y: side - 1, color: 1 });
    const fragment = createPatternFragment(source, { x: 0, y: 0, width: side, height: side });
    const editor = createEditor(document(side, side));
    const result = editor.execute(pasteFragmentCommand(fragment, { x: 0, y: 0 }));

    expect(result.changed).toBe(true);
    expect(result.changedIndices).toHaveLength(1);
    expect(result.revision).toBe(1);
    expect(editor.undoDepth).toBe(1);
    expect(editor.lastHistoryEntryKind).toBe('delta');
    expect(editor.historyBytes).toBe(estimatePasteFragmentHistoryBytes(1, 0, 0));
    expect(editor.historyBytes).toBeLessThanOrEqual(DEFAULT_HISTORY_LIMIT_BYTES);
    editor.undo();
    expect(editor.document.kind.at(-1)).toBe(CellKind.Empty);
  });

  it('erases mixed whole-cell and quarter targets as one packed undoable command', () => {
    let pattern = document(4, 2);
    pattern = apply(pattern, { type: 'set-full', x: 0, y: 0, color: 1 });
    pattern = apply(pattern, { type: 'set-completion', x: 0, y: 0, completed: true });
    pattern = apply(pattern, { type: 'set-quarter', x: 1, y: 0, corner: QuarterCorner.NW, color: 2 });
    pattern = apply(pattern, { type: 'set-completion', x: 1, y: 0, corner: QuarterCorner.NW, completed: true });
    pattern = apply(pattern, { type: 'set-quarter', x: 2, y: 0, corner: QuarterCorner.NE, color: 3 });
    pattern = apply(pattern, { type: 'set-quarter', x: 2, y: 0, corner: QuarterCorner.SW, color: 1 });
    pattern = apply(pattern, { type: 'set-quarter', x: 2, y: 0, corner: QuarterCorner.SE, color: 2 });
    pattern = apply(pattern, { type: 'set-completion', x: 2, y: 0, corner: QuarterCorner.NE, completed: true });
    pattern = apply(pattern, { type: 'set-completion', x: 2, y: 0, corner: QuarterCorner.SW, completed: true });
    pattern = apply(pattern, { type: 'set-completion', x: 2, y: 0, corner: QuarterCorner.SE, completed: true });
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 0, y: 4 }, end: { x: 4, y: 8 }, color: 2 });
    const beforePalette = pattern.palette.map((entry) => ({ ...entry }));
    const editor = createEditor(pattern);
    const command = mixedEraseCommand(
      new Uint32Array([0]),
      new Uint32Array([1, 1, 2, 2]),
      new Uint8Array([QuarterCorner.NW, QuarterCorner.NE, QuarterCorner.NE, QuarterCorner.SW])
    );

    const result = editor.execute(command);
    expect(result.changed).toBe(true);
    expect(result.changedIndices).toEqual(new Uint32Array([0, 1, 2]));
    expect(result.revision).toBe(pattern.revision + 1);
    expect(editor.undoDepth).toBe(1);
    expect(editor.lastHistoryEntryKind).toBe('delta');
    expect(editor.historyBytes).toBe(estimateMixedEraseHistoryBytes(3));
    expect(getCell(editor.document, 0, 0).kind).toBe(CellKind.Empty);
    expect(getCell(editor.document, 0, 0).completed).toBe(false);
    expect(getCell(editor.document, 1, 0).kind).toBe(CellKind.Empty);
    expect(getCell(editor.document, 2, 0)).toMatchObject({ kind: CellKind.Quarters, completed: false });
    expect(getCell(editor.document, 2, 0).quarters[QuarterCorner.NE]).toMatchObject({ color: 0, completed: false });
    expect(getCell(editor.document, 2, 0).quarters[QuarterCorner.SW]).toMatchObject({ color: 0, completed: false });
    expect(getCell(editor.document, 2, 0).quarters[QuarterCorner.SE]).toMatchObject({ color: 2, completed: true });
    expect(listBackstitches(editor.document)).toMatchObject([
      { id: 1, x1: 0, y1: 4, x2: 4, y2: 8, color: 2 }
    ]);
    expect(editor.document.palette).toEqual(beforePalette);
    expect(editor.document.nextBackstitchId).toBe(pattern.nextBackstitchId);
    expect(editor.document.nextPaletteId).toBe(pattern.nextPaletteId);

    editor.undo();
    expect(editor.undoDepth).toBe(0);
    expect(editor.redoDepth).toBe(1);
    expect(editor.document.kind).toEqual(pattern.kind);
    expect(editor.document.colors).toEqual(pattern.colors);
    expect(editor.document.completed).toEqual(pattern.completed);
    expect(listBackstitches(editor.document)).toMatchObject(listBackstitches(pattern));
    editor.redo();
    expect(editor.document.kind[0]).toBe(CellKind.Empty);
    expect(editor.document.kind[1]).toBe(CellKind.Empty);
    const added = editor.execute({ type: 'add-backstitch', start: { x: 8, y: 0 }, end: { x: 12, y: 0 }, color: 3 });
    expect(added.backstitchId).toBe(2);
  });

  it('treats absent whole cells as no-ops without creating history', () => {
    const editor = createEditor(document(2, 2));
    const before = editor.document;
    const result = editor.execute(mixedEraseCommand(new Uint32Array([3]), new Uint32Array(), new Uint8Array()));

    expect(result.changed).toBe(false);
    expect(editor.document).toBe(before);
    expect(editor.document.revision).toBe(0);
    expect(editor.undoDepth).toBe(0);
    expect(editor.redoDepth).toBe(0);
    expect(editor.historyBytes).toBe(0);
  });

  it('deletes selected cells and only backstitches whose endpoints are inside the inclusive region bounds', () => {
    const editor = createEditor(document(5, 4));
    editor.execute({ type: 'set-full', x: 1, y: 1, color: 1 });
    editor.execute({ type: 'set-completion', x: 1, y: 1, completed: true });
    editor.execute({ type: 'set-quarter', x: 2, y: 2, corner: QuarterCorner.SE, color: 2 });
    editor.execute({ type: 'set-completion', x: 2, y: 2, corner: QuarterCorner.SE, completed: true });
    editor.execute({ type: 'set-full', x: 4, y: 3, color: 3 });
    editor.execute({ type: 'add-backstitch', start: { x: 4, y: 4 }, end: { x: 12, y: 12 }, color: 1 });
    editor.execute({ type: 'add-backstitch', start: { x: 0, y: 4 }, end: { x: 12, y: 12 }, color: 2 });
    editor.execute({ type: 'add-backstitch', start: { x: 4, y: 4 }, end: { x: 16, y: 12 }, color: 3 });
    editor.clearHistory();

    const result = editor.execute(deleteRegionCommand({ x: 1, y: 1, width: 2, height: 2 }, editor.revision));
    expect(result.changed).toBe(true);
    expect(result.changedIndices).toEqual(new Uint32Array([6, 12]));
    expect(result.changedBackstitchIds).toEqual(new Uint32Array([1]));
    expect(editor.document.kind[6]).toBe(CellKind.Empty);
    expect(editor.document.completed[12]).toBe(0);
    expect(editor.document.kind[19]).toBe(CellKind.Full);
    expect(listBackstitches(editor.document).map((line) => line.id)).toEqual([2, 3]);
    expect(editor.historyBytes).toBe(estimateDeleteRegionHistoryBytes(2, 3, 1));
    expect(editor.undoDepth).toBe(1);

    editor.undo();
    expect(editor.document.kind[6]).toBe(CellKind.Full);
    expect(editor.document.completed[6]).toBe(1);
    expect(listBackstitches(editor.document).map((line) => line.id)).toEqual([1, 2, 3]);
    editor.redo();
    expect(listBackstitches(editor.document).map((line) => line.id)).toEqual([2, 3]);
    expect(editor.document.nextBackstitchId).toBe(4);
  });

  it('restores every delete plane and nested document value through undo and redo', () => {
    let pattern = createDocument({
      width: 4,
      height: 3,
      catalog: TEST_CATALOG,
      palette: [{
        id: 1,
        name: 'Nested red',
        color: '#d33',
        material: { kind: MaterialKind.Custom, label: 'silk', unit: MaterialUnit.Meters, amount: 2.5 },
        catalog: {
          catalogId: 'test-catalog',
          sourceId: 'test-source',
          code: 'T1',
          name: 'Nested red',
          hex: '#d33d33',
          rgb: [211, 61, 51]
        }
      }],
      settings: { symbolSet: 'test-symbols', materialUnit: MaterialUnit.Meters }
    });
    pattern = apply(pattern, { type: 'set-full', x: 1, y: 0, color: 1 });
    pattern = apply(pattern, { type: 'set-completion', x: 1, y: 0, completed: true });
    pattern = apply(pattern, { type: 'set-half', x: 2, y: 0, direction: HalfDirection.Slash, color: 1 });
    pattern = apply(pattern, { type: 'set-quarter', x: 1, y: 1, corner: QuarterCorner.NE, color: 1 });
    pattern = apply(pattern, { type: 'set-quarter', x: 1, y: 1, corner: QuarterCorner.SW, color: 1, completed: true });
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 4, y: 0 }, end: { x: 12, y: 8 }, color: 1 });
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 1 });
    const editor = createEditor(pattern);
    const before = editor.document;
    const beforeContent = documentContentSnapshot(before);

    const deleted = editor.execute(deleteRegionCommand({ x: 1, y: 0, width: 2, height: 2 }, editor.revision));
    expect(deleted.changed).toBe(true);
    expect(editor.document.revision).toBe(before.revision + 1);
    expect(documentContentSnapshot(editor.document)).toMatchObject({
      kind: expect.any(Uint8Array),
      colors: expect.any(Uint16Array),
      completed: expect.any(Uint8Array),
      nextBackstitchId: before.nextBackstitchId,
      nextPaletteId: before.nextPaletteId
    });
    expect(editor.document.kind[1]).toBe(CellKind.Empty);
    expect(editor.document.kind[2]).toBe(CellKind.Empty);
    expect(editor.document.kind[5]).toBe(CellKind.Empty);
    expect(editor.document.kind[6]).toBe(CellKind.Empty);
    expect(editor.document.kind[11]).toBe(CellKind.Empty);
    expect(editor.document.backstitches.ids).toEqual(new Uint32Array([2]));
    expect(editor.document.palette).toEqual(before.palette);
    expect(editor.document.settings).toBe(before.settings);
    assertValidDocument(editor.document);
    const afterContent = documentContentSnapshot(editor.document);

    const undone = editor.undo();
    expect(undone.revision).toBe(before.revision + 2);
    expect(documentContentSnapshot(editor.document)).toEqual(beforeContent);
    expect(editor.document.palette).toBe(before.palette);
    expect(editor.document.settings).toBe(before.settings);
    assertValidDocument(editor.document);

    const redone = editor.redo();
    expect(redone.revision).toBe(before.revision + 3);
    expect(documentContentSnapshot(editor.document)).toEqual(afterContent);
    expect(editor.document.palette).toBe(before.palette);
    expect(editor.document.settings).toBe(before.settings);
    assertValidDocument(editor.document);
  });

  it('keeps prior delete generations immutable while later edits use new planes', () => {
    let pattern = document(4, 2);
    pattern = apply(pattern, { type: 'set-full', x: 0, y: 0, color: 1 });
    pattern = apply(pattern, { type: 'set-half', x: 1, y: 0, direction: HalfDirection.Backslash, color: 2 });
    const editor = createEditor(pattern);
    const preDelete = editor.document;
    const preDeleteContent = documentContentSnapshot(preDelete);

    editor.execute(deleteRegionCommand({ x: 0, y: 0, width: 2, height: 1 }, editor.revision));
    const postDelete = editor.document;
    const postDeleteContent = documentContentSnapshot(postDelete);
    expect(postDelete.kind).not.toBe(preDelete.kind);
    expect(postDelete.colors).not.toBe(preDelete.colors);
    expect(postDelete.completed).not.toBe(preDelete.completed);
    expect(preDelete.kind[0]).toBe(CellKind.Full);
    expect(preDelete.kind[1]).toBe(CellKind.HalfBackslash);

    editor.undo();
    const postUndo = editor.document;
    expect(postUndo.kind).not.toBe(postDelete.kind);
    expect(postUndo.colors).not.toBe(postDelete.colors);
    expect(postUndo.completed).not.toBe(postDelete.completed);
    const postUndoContent = documentContentSnapshot(postUndo);
    expect(documentContentSnapshot(preDelete)).toEqual(preDeleteContent);
    expect(documentContentSnapshot(postDelete)).toEqual(postDeleteContent);

    editor.redo();
    editor.execute({ type: 'set-full', x: 3, y: 1, color: 3 });
    expect(documentContentSnapshot(preDelete)).toEqual(preDeleteContent);
    expect(documentContentSnapshot(postDelete)).toEqual(postDeleteContent);
    expect(documentContentSnapshot(postUndo)).toEqual(postUndoContent);
  });

  it('keeps delete no-ops, stale revisions, and budget failures atomic', () => {
    const noOpEditor = createEditor(document(3, 3));
    const noOpBefore = noOpEditor.document;
    const noOp = noOpEditor.execute(deleteRegionCommand({ x: 0, y: 0, width: 3, height: 3 }, noOpEditor.revision));
    expect(noOp.changed).toBe(false);
    expect(noOpEditor.document).toBe(noOpBefore);
    expect(noOpEditor.revision).toBe(0);
    expect(noOpEditor.undoDepth).toBe(0);
    expect(noOpEditor.historyBytes).toBe(0);

    expect(() => noOpEditor.execute(deleteRegionCommand({ x: 0, y: 0, width: 1, height: 1 }, 1))).toThrow(/revision/i);
    expect(noOpEditor.document).toBe(noOpBefore);
    expect(noOpEditor.revision).toBe(0);
    expect(noOpEditor.undoDepth).toBe(0);

    const occupied = apply(document(3, 3), { type: 'set-full', x: 1, y: 1, color: 1 });
    const budgetEditor = createEditor(occupied, { historyLimitBytes: estimateDeleteRegionHistoryBytes(1) - 1 });
    const budgetBefore = budgetEditor.document;
    const budgetBeforeContent = documentContentSnapshot(budgetBefore);
    expect(() => budgetEditor.execute(deleteRegionCommand({ x: 1, y: 1, width: 1, height: 1 }, budgetEditor.revision))).toThrow(/exceeding/);
    expect(budgetEditor.document).toBe(budgetBefore);
    expect(documentContentSnapshot(budgetEditor.document)).toEqual(budgetBeforeContent);
    expect(budgetEditor.revision).toBe(occupied.revision);
    expect(budgetEditor.undoDepth).toBe(0);
    expect(budgetEditor.redoDepth).toBe(0);
  });

  it('deletes, validates, and restores a dense 1,000 by 1,000 document', { timeout: 240_000 }, () => {
    const side = 1_000;
    const cellCount = side * side;
    const pattern = document(side, side);
    pattern.kind.fill(CellKind.Full);
    pattern.completed.fill(1);
    for (let index = 0; index < cellCount; index += 1) pattern.colors[index * 4] = 1;
    assertValidDocument(pattern);

    const editor = createEditor(pattern);
    const beforeDocument = editor.document;
    const before = documentContentSnapshot(editor.document);
    const deleted = editor.execute(deleteRegionCommand({ x: 0, y: 0, width: side, height: side }, editor.revision));
    expect(deleted.changed).toBe(true);
    expect(deleted.changedIndices).toHaveLength(cellCount);
    expect(editor.historyBytes).toBe(estimateDeleteRegionHistoryBytes(cellCount));
    expect(editor.undoDepth).toBe(1);
    expect(editor.document.kind).toEqual(new Uint8Array(cellCount));
    expect(editor.document.colors).toEqual(new Uint16Array(cellCount * 4));
    expect(editor.document.completed).toEqual(new Uint8Array(cellCount));
    expect(editor.document.backstitches).toBe(beforeDocument.backstitches);
    expect(editor.document.palette).toBe(beforeDocument.palette);
    expect(editor.document.settings).toBe(beforeDocument.settings);
    assertValidDocument(editor.document);
    const after = documentContentSnapshot(editor.document);

    editor.undo();
    expect(editor.document.revision).toBe(2);
    expect(documentContentSnapshot(editor.document)).toEqual(before);
    assertValidDocument(editor.document);

    editor.redo();
    expect(editor.document.revision).toBe(3);
    expect(documentContentSnapshot(editor.document)).toEqual(after);
    assertValidDocument(editor.document);
  });

  it('preflights delete-region history before changing the document', () => {
    const pattern = document(4, 4);
    const source = createEditor(pattern);
    source.execute({ type: 'set-full', x: 1, y: 1, color: 1 });
    source.execute({ type: 'add-backstitch', start: { x: 4, y: 4 }, end: { x: 8, y: 8 }, color: 1 });
    source.clearHistory();
    const required = estimateDeleteRegionHistoryBytes(1, 1, 1);
    const editor = createEditor(source.document, { historyLimitBytes: required - 1 });
    const before = editor.document;
    expect(() => editor.execute(deleteRegionCommand({ x: 1, y: 1, width: 1, height: 1 }, editor.revision))).toThrow(/exceeding/);
    expect(editor.document).toBe(before);
    expect(editor.document.kind[5]).toBe(CellKind.Full);
    expect(editor.document.backstitches.ids).toEqual(new Uint32Array([1]));
    expect(editor.revision).toBe(source.revision);
    expect(editor.undoDepth).toBe(0);
  });

  it('rejects invalid mixed erase targets atomically', () => {
    let pattern = document(2, 2);
    pattern = apply(pattern, { type: 'set-full', x: 0, y: 0, color: 1 });
    pattern = apply(pattern, { type: 'set-quarter', x: 1, y: 0, corner: QuarterCorner.NW, color: 1 });
    const editor = createEditor(pattern);
    const before = editor.document;
    const reject = (command: Parameters<typeof editor.execute>[0], message: RegExp) => {
      expect(() => editor.execute(command)).toThrow(message);
      expect(editor.document).toBe(before);
      expect(editor.document.revision).toBe(pattern.revision);
      expect(editor.undoDepth).toBe(0);
    };

    reject(mixedEraseCommand(new Uint32Array([0]), new Uint32Array([0]), new Uint8Array([QuarterCorner.NW])), /both a whole-cell/);
    reject(mixedEraseCommand(new Uint32Array(), new Uint32Array([0]), new Uint8Array([QuarterCorner.NW])), /not a quarter/);
    reject(mixedEraseCommand(new Uint32Array([4]), new Uint32Array(), new Uint8Array()), /out of bounds/);
    reject({ type: 'mixed-erase', wholeCellIndices: new Uint32Array(), componentCellIndices: new Uint32Array([1]), componentCorners: new Uint8Array([4]) }, /invalid/);
    expect(() => mixedEraseCommand(new Uint32Array([1, 0]), new Uint32Array(), new Uint8Array())).toThrow(/strictly increasing/);
    expect(() => mixedEraseCommand(new Uint32Array(), new Uint32Array([1, 1]), new Uint8Array([QuarterCorner.NW, QuarterCorner.NW]))).toThrow(/sorted and unique/);
  });

  it('rejects a mixed erase over the history budget before mutation', () => {
    let pattern = document(2, 1);
    pattern = apply(pattern, { type: 'set-full', x: 0, y: 0, color: 1 });
    const requiredBytes = estimateMixedEraseHistoryBytes(1);
    const editor = createEditor(pattern, { historyLimitBytes: requiredBytes - 1 });
    const before = editor.document;

    expect(() => editor.execute(mixedEraseCommand(new Uint32Array([0]), new Uint32Array(), new Uint8Array()))).toThrow(/exceeding/);
    expect(editor.document).toBe(before);
    expect(editor.document.kind[0]).toBe(CellKind.Full);
    expect(editor.document.revision).toBe(pattern.revision);
    expect(editor.undoDepth).toBe(0);
    expect(editor.historyBytes).toBe(0);
  });

  it('validates invariants and exposes a boolean validator', () => {
    const pattern = document();
    expect(validateDocument(pattern)).toBe(true);
    pattern.kind[0] = CellKind.Full;
    expect(validateDocument(pattern)).toBe(false);
    expect(() => assertValidDocument(pattern)).toThrow();
  });

  it('captures sparse cells into a tight transparent fragment and uses closed-union endpoints', () => {
    let source = document(4, 1);
    source = apply(source, { type: 'set-full', x: 1, y: 0, color: 1 });
    source = apply(source, { type: 'set-full', x: 3, y: 0, color: 2 });
    source.backstitches = {
      ids: new Uint32Array([1, 2]),
      x1: new Uint32Array([8, 10]),
      y1: new Uint32Array([0, 2]),
      x2: new Uint32Array([12, 12]),
      y2: new Uint32Array([0, 2]),
      colors: new Uint16Array([1, 2]),
      completed: new Uint8Array([0, 1])
    };
    source.nextBackstitchId = 3;
    assertValidDocument(source);

    const fragment = createPatternFragmentFromCells(source, new Uint32Array([1, 3]));
    expect(fragment.width).toBe(3);
    expect(fragment.height).toBe(1);
    expect(fragment.kind).toEqual(new Uint8Array([CellKind.Full, CellKind.Empty, CellKind.Full]));
    expect(fragment.colors).toEqual(new Uint16Array([1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0]));
    expect(fragment.backstitches.x1).toEqual(new Uint32Array([4]));
    expect(fragment.backstitches.y1).toEqual(new Uint32Array([0]));
    expect(fragment.backstitches.x2).toEqual(new Uint32Array([8]));
    expect(fragment.backstitches.y2).toEqual(new Uint32Array([0]));
    expect(validatePatternFragment(fragment)).toBe(true);

    let destination = document(3, 1);
    destination = apply(destination, { type: 'set-full', x: 1, y: 0, color: 3 });
    const pasted = applyCommand(destination, pasteFragmentCommand(fragment, { x: 0, y: 0 }));
    expect(pasted.document.kind).toEqual(new Uint8Array([CellKind.Full, CellKind.Full, CellKind.Full]));
    expect(pasted.document.colors).toEqual(new Uint16Array([1, 0, 0, 0, 3, 0, 0, 0, 2, 0, 0, 0]));
  });

  it('deletes sparse cells and contained backstitches as one undoable delta', () => {
    let pattern = document(4, 1);
    pattern = apply(pattern, { type: 'set-full', x: 1, y: 0, color: 1 });
    pattern = apply(pattern, { type: 'set-completion', x: 1, y: 0, completed: true });
    pattern = apply(pattern, { type: 'set-full', x: 2, y: 0, color: 2 });
    pattern = apply(pattern, { type: 'set-full', x: 3, y: 0, color: 3 });
    pattern.backstitches = {
      ids: new Uint32Array([1, 2]),
      x1: new Uint32Array([8, 10]),
      y1: new Uint32Array([0, 2]),
      x2: new Uint32Array([12, 12]),
      y2: new Uint32Array([0, 2]),
      colors: new Uint16Array([1, 2]),
      completed: new Uint8Array([0, 1])
    };
    pattern.nextBackstitchId = 3;
    assertValidDocument(pattern);
    const editor = createEditor(pattern);
    editor.clearHistory();
    const before = documentContentSnapshot(editor.document);

    const result = editor.execute(deleteCellSetCommand(new Uint32Array([1, 3]), editor.revision));
    expect(result.changed).toBe(true);
    expect(result.changedIndices).toEqual(new Uint32Array([1, 3]));
    expect(result.changedBackstitchIds).toEqual(new Uint32Array([1]));
    expect(editor.document.kind).toEqual(new Uint8Array([CellKind.Empty, CellKind.Empty, CellKind.Full, CellKind.Empty]));
    expect(editor.document.backstitches.ids).toEqual(new Uint32Array([2]));
    expect(editor.undoDepth).toBe(1);
    expect(editor.lastHistoryEntryKind).toBe('delta');
    expect(editor.historyBytes).toBe(estimateDeleteCellSetHistoryBytes(2, 2, 1));

    const undone = editor.undo();
    expect(undone.requiresFullRedraw).toBe(true);
    expect(documentContentSnapshot(editor.document)).toEqual(before);
    const redone = editor.redo();
    expect(redone.requiresFullRedraw).toBe(true);
    expect(editor.document.kind).toEqual(new Uint8Array([CellKind.Empty, CellKind.Empty, CellKind.Full, CellKind.Empty]));
    expect(editor.document.backstitches.ids).toEqual(new Uint32Array([2]));

    const preExportUndo = editor.undo();
    const preExportRedo = editor.redo();
    expect(preExportUndo.requiresFullRedraw).toBe(true);
    expect(preExportRedo.requiresFullRedraw).toBe(true);
    const exported = editor.exportHistory();
    expect(Object.prototype.hasOwnProperty.call((exported.undo[0] as { delta: object }).delta, 'deleteMetricsImpact')).toBe(false);
    const restored = createEditor(editor.document, { historyLimitBytes: editor.historyLimitBytes });
    restored.importHistory(exported);
    const restoredUndo = restored.undo();
    expect(restoredUndo.requiresFullRedraw).toBe(true);
    expect(restoredUndo.recalculateMetrics).toBe(true);
    expect(restoredUndo.progress).toEqual({ marked: 0, unmarked: 0, cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0) });
    expect(computePatternMetrics(restoredUndo.document).progress).toMatchObject({ completedComponents: 2 });
    const restoredRedo = restored.redo();
    expect(restoredRedo.progress).toEqual({ marked: 0, unmarked: 0, cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0) });
    expect(restoredRedo.recalculateMetrics).toBe(true);
    expect(computePatternMetrics(restoredRedo.document).progress).toMatchObject({ completedComponents: 1, remainingComponents: 1 });

    const direct = applyCommand(pattern, deleteCellSetCommand(new Uint32Array([1, 3]), pattern.revision));
    expect(direct.changed).toBe(true);
    expect(direct.document.backstitches.ids).toEqual(new Uint32Array([2]));
  });

  it('rejects malformed sparse deletion atomically and keeps no-ops out of history', () => {
    const editor = createEditor(document(2, 1));
    const before = editor.document;
    expect(() => deleteCellSetCommand(new Uint32Array())).toThrow(/non-empty/);
    expect(() => deleteCellSetCommand(new Uint32Array([1, 0]))).toThrow(/strictly increasing/);
    expect(() => deleteCellSetCommand(new Uint32Array([0, 0]))).toThrow(/strictly increasing/);
    expect(() => editor.execute({ type: 'delete-cell-set', indices: new Uint32Array([2]) })).toThrow(/out of bounds/);
    expect(() => editor.execute(deleteCellSetCommand(new Uint32Array([0]), 1))).toThrow(/revision/i);
    expect(() => editor.executeBatch([deleteCellSetCommand(new Uint32Array([0])), { type: 'set-full', x: 1, y: 0, color: 1 }])).toThrow(/standalone/);
    expect(editor.document).toBe(before);
    expect(editor.revision).toBe(0);
    expect(editor.undoDepth).toBe(0);
    expect(editor.historyBytes).toBe(0);

    const noOpEditor = createEditor(document(2, 1));
    const noOpBefore = noOpEditor.document;
    const noOp = noOpEditor.execute(deleteCellSetCommand(new Uint32Array([0]), noOpEditor.revision));
    expect(noOp.changed).toBe(false);
    expect(noOpEditor.document).toBe(noOpBefore);
    expect(noOpEditor.undoDepth).toBe(0);
    expect(noOpEditor.historyBytes).toBe(0);
  });
});

describe('palette symbol helpers', () => {
  it('exposes the four-unit cap so multi-glyph and astral-plane symbols fit', () => {
    expect(MAX_PALETTE_SYMBOL_LENGTH).toBe(4);
    // BMP glyph, BMP + VS15, surrogate pair, surrogate pair + VS16 — all fit.
    expect('●'.length).toBeLessThanOrEqual(MAX_PALETTE_SYMBOL_LENGTH);
    expect('▶︎'.length).toBeLessThanOrEqual(MAX_PALETTE_SYMBOL_LENGTH);
    expect('𝕏'.length).toBeLessThanOrEqual(MAX_PALETTE_SYMBOL_LENGTH);
    expect('🧶\u{fe0f}'.length).toBeLessThanOrEqual(MAX_PALETTE_SYMBOL_LENGTH);
    // Five units would overflow even with VS16 + skin tone + extra modifier.
    expect('🧶\u{fe0f}abc'.length).toBeGreaterThan(MAX_PALETTE_SYMBOL_LENGTH);
  });

  it('flags ASCII letters, ASCII digits, and fullwidth Latin forms as alphanumeric', () => {
    expect(isAlphanumericSymbol('S')).toBe(true);
    expect(isAlphanumericSymbol('3')).toBe(true);
    expect(isAlphanumericSymbol('S3')).toBe(true);
    expect(isAlphanumericSymbol('abcXYZ')).toBe(true);
    expect(isAlphanumericSymbol('Ａ')).toBe(true); // U+FF21 fullwidth A
    expect(isAlphanumericSymbol('ａ')).toBe(true); // U+FF41 fullwidth a
    expect(isAlphanumericSymbol('３')).toBe(true); // U+FF13 fullwidth 3
    expect(isAlphanumericSymbol('ＡＢ')).toBe(true);
  });

  it('treats non-alphanumeric Unicode — including digit look-alikes — as allowed', () => {
    // BMP geometric / cross / star glyphs from the curated set all pass.
    for (const glyph of PALETTE_SYMBOLS) expect(isAlphanumericSymbol(glyph)).toBe(false);
    // Astral-plane glyphs pass (their surrogate halves are not alphanumeric).
    expect(isAlphanumericSymbol('𝕏')).toBe(false);
    expect(isAlphanumericSymbol('🧶')).toBe(false);
    // Variation selectors are not alphanumeric.
    expect(isAlphanumericSymbol('▶︎')).toBe(false);
    // Digit-shaped enclosed/dingbat forms are explicitly NOT alphanumeric:
    // U+2460 "①", U+2461 "②", U+2776 "❶".
    expect(isAlphanumericSymbol('①')).toBe(false);
    expect(isAlphanumericSymbol('②')).toBe(false);
    expect(isAlphanumericSymbol('❶')).toBe(false);
    // Empty input is not alphanumeric (it's caught earlier as empty).
    expect(isAlphanumericSymbol('')).toBe(false);
  });
});
