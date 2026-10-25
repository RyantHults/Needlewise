import { describe, expect, it } from 'vitest';
import { getSymbolOutline, SYMBOL_IDS } from '../symbols';
import {
  assertValidDocument,
  bulkBackstitchCompletionCommand,
  bulkCompletionCommand,
  preflightBulkCellCommand,
  CellKind,
  cloneDocument,
  createDocument,
  DocumentEditor,
  defaultPaletteSymbol,
  deleteRegionCommand,
  deleteCellSetCommand,
  createPatternFragment,
  createPatternFragmentFromCells,
  assertValidPatternFragment,
  HalfDirection,
  isKnownSymbolId,
  isThreeQuarterKind,
  listBackstitches,
  MaterialKind,
  MaterialUnit,
  MAX_PERSISTABLE_CELL_COUNT,
  mixedEraseCommand,
  pasteFragmentCommand,
  snapBackstitchPoint,
  preflightBulkCompletionCommand,
  preflightBulkRecolorCommand,
  QuarterCorner,
  DEFAULT_HISTORY_LIMIT_BYTES,
  DomainError,
  estimateBulkCellHistoryBytes,
  estimateBulkRecolorHistoryBytes,
  estimatePasteFragmentHistoryBytes,
  estimateMoveFragmentHistoryBytes,
  estimateMixedEraseHistoryBytes,
  estimateDeleteRegionHistoryBytes,
  moveFragmentCommand,
  type DocumentSettingsUpdateCommand,
  type PatternDocument,
  type CatalogAssociation,
  type PatternFragment,
  computePatternMetrics
} from './index';
import { editorFromSurface, markBackstitchComplete, markCellComplete, onDefaultLayers, SPECIALTY_LAYER_ID, STITCH_LAYER_ID, applyCommand, bulkCellCommand, bulkEraseCellCommand, bulkEraseQuarterCommand, bulkSetFullCommand, bulkSetHalfCommand, bulkSetQuarterCommand, bulkSetThreeQuarterCommand, bulkRecolorCommand, getBackstitch, getCell, getQuarter, isQuarterKind, readPatternFragmentCell, TEST_CATALOG } from './test-fixtures';

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
    const editor = editorFromSurface(pattern);
    const changed = editor.execute(onDefaultLayers({ type: 'palette-create', name: 'Blue', color: '#0000FF' })).document;

    expect(cloneDocument(changed).catalog).toEqual(TEST_CATALOG);
    expect(editor.undo().document.catalog).toEqual(TEST_CATALOG);
    expect(editor.redo().document.catalog).toEqual(TEST_CATALOG);
  });

  it('accepts references from another catalog while rejecting malformed references', () => {
    const pattern = createDocument({ width: 1, height: 1, catalog: TEST_CATALOG });
    const foreignReference = { ...TEST_REFERENCE, catalogId: 'other-catalog' };

    const created = applyCommand(pattern, {
      type: 'palette-create',
      name: 'Foreign',
      color: '#000000',
      catalog: foreignReference
    }).document;
    expect(created.catalog).toEqual(TEST_CATALOG);
    expect(created.palette[0].catalog).toEqual(foreignReference);
    expect(() => assertValidDocument(created)).not.toThrow();

    expect(() => applyCommand(pattern, {
      type: 'palette-create',
      name: 'Malformed',
      color: '#000000',
      catalog: { ...foreignReference, rgb: [0, 0, 0] }
    })).toThrow(/HEX and RGB values must agree/);

    const invalidDocument = {
      ...created,
      palette: [{ ...created.palette[0], catalog: { ...foreignReference, sourceId: ' ' } }]
    } as unknown as PatternDocument;
    expect(() => assertValidDocument(invalidDocument)).toThrow(/invalid catalog data/i);
  });

  it('accepts a foreign catalog reference on initial palette creation', () => {
    const foreignReference = { ...TEST_REFERENCE, catalogId: 'catalog-b' };
    const pattern = createDocument({
      width: 1,
      height: 1,
      catalog: TEST_CATALOG,
      palette: [{ id: 1, name: 'B Red', color: '#123456', catalog: foreignReference }]
    });

    expect(pattern.catalog).toEqual(TEST_CATALOG);
    expect(pattern.palette[0].catalog).toEqual(foreignReference);
    expect(() => assertValidDocument(pattern)).not.toThrow();
  });

  it('preserves a foreign catalog palette addition through clone, undo, and redo', () => {
    const pattern = createDocument({ width: 1, height: 1, catalog: TEST_CATALOG });
    const editor = editorFromSurface(pattern);
    const foreignReference = { ...TEST_REFERENCE, catalogId: 'catalog-b' };

    editor.execute(onDefaultLayers({ type: 'palette-create', name: 'B Red', color: '#123456', catalog: foreignReference }));
    expect(cloneDocument(editor.composite).palette[0].catalog).toEqual(foreignReference);
    expect(editor.undo().document.palette).toHaveLength(0);
    expect(editor.composite.catalog).toEqual(TEST_CATALOG);
    expect(editor.redo().document.palette[0].catalog).toEqual(foreignReference);
    expect(editor.composite.catalog).toEqual(TEST_CATALOG);
    expect(() => assertValidDocument(editor.composite)).not.toThrow();
  });

  it('accepts foreign references on palette update and merge-created entries', () => {
    const foreignReference = { ...TEST_REFERENCE, catalogId: 'catalog-b' };
    const pattern = createDocument({ width: 1, height: 1, catalog: TEST_CATALOG, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    const updated = applyCommand(pattern, { type: 'palette-update', id: 1, catalog: foreignReference }).document;
    expect(updated.catalog).toEqual(TEST_CATALOG);
    expect(updated.palette[0].catalog).toEqual(foreignReference);
    expect(() => assertValidDocument(updated)).not.toThrow();

    const merged = applyCommand(pattern, {
      type: 'palette-merge',
      from: 1,
      createTo: { name: 'B Red', color: '#123456', catalog: foreignReference }
    }).document;
    expect(merged.catalog).toEqual(TEST_CATALOG);
    expect(merged.palette.find((entry) => entry.catalog?.catalogId === 'catalog-b')?.catalog).toEqual(foreignReference);
    expect(() => assertValidDocument(merged)).not.toThrow();
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
    expect(() => assertValidDocument(pattern)).not.toThrow();
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

    let next = apply(pattern, { type: 'set-full', x: 1, y: 1, color: 1 });
    expect(getCell(next, 1, 1).completed).toBe(false);
    next = markCellComplete(next, 1, 1);
    next = apply(next, { type: 'set-full', x: 1, y: 1, color: 2 });
    expect(getCell(next, 1, 1).color).toBe(2);
    expect(getCell(next, 1, 1).completed).toBe(true);

    next = apply(next, { type: 'set-half', x: 1, y: 1, direction: HalfDirection.Slash, color: 2 });
    expect(getCell(next, 1, 1).kind).toBe(CellKind.HalfSlash);
    expect(getCell(next, 1, 1).completed).toBe(false);
  });

  it('keeps independent quarter slots and completion bits', () => {
    let pattern = document();
    pattern = apply(pattern, { type: 'set-quarter', x: 0, y: 0, corner: QuarterCorner.NW, color: 1 });
    expect(getCell(pattern, 0, 0).quarters[QuarterCorner.NW].completed).toBe(false);
    pattern = markCellComplete(pattern, 0, 0, QuarterCorner.NW);
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
    expect(() => assertValidDocument(invalid)).toThrow();
    invalid.colors[1] = 0;
    invalid.completed[0] = 2;
    expect(() => assertValidDocument(invalid)).toThrow();
  });

  it('keeps a full stitch color on the opposite corner when a three-quarter is painted over it', () => {
    const full = apply(document(), { type: 'set-full', x: 0, y: 0, color: 1 });
    const pattern = apply(full, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.NW, color: 2 });
    expect(pattern.kind[0]).toBe(CellKind.ThreeQuarterPair);
    expect(Array.from(pattern.colors.slice(0, 4))).toEqual([2, 0, 1, 0]);
    expect(pattern.completed[0]).toBe(0);

    const same = apply(full, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.NW, color: 1 });
    expect(same.kind[0]).toBe(CellKind.ThreeQuarterPair);
    expect(Array.from(same.colors.slice(0, 4))).toEqual([1, 0, 1, 0]);
  });

  it('moves a completed full stitch completion onto the opposite corner of the pair', () => {
    let pattern = apply(document(), { type: 'set-full', x: 0, y: 0, color: 1 });
    pattern = markCellComplete(pattern, 0, 0);
    pattern = apply(pattern, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.NE, color: 2 });
    expect(pattern.kind[0]).toBe(CellKind.ThreeQuarterPair);
    expect(Array.from(pattern.colors.slice(0, 4))).toEqual([0, 2, 0, 1]);
    expect(pattern.completed[0]).toBe(1 << QuarterCorner.SW);
  });

  it('bulk three-quarter preflight and commit agree for full cells', () => {
    let pattern = apply(document(), { type: 'set-full', x: 0, y: 0, color: 1 });
    pattern = markCellComplete(pattern, 0, 0);
    const command = bulkSetThreeQuarterCommand(new Uint32Array([0, 1]), QuarterCorner.NW, 1);
    const preflight = preflightBulkCellCommand(pattern, command);
    expect(preflight.changedIndices).toEqual(new Uint32Array([0, 1]));
    const editor = editorFromSurface(pattern);
    const result = editor.execute(onDefaultLayers(command));
    expect(result.changedIndices).toEqual(preflight.changedIndices);
    expect(editor.composite.kind[0]).toBe(CellKind.ThreeQuarterPair);
    expect(Array.from(editor.composite.colors.slice(0, 4))).toEqual([1, 0, 1, 0]);
    expect(editor.composite.completed[0]).toBe(1 << QuarterCorner.SE);
    expect(editor.composite.kind[1]).toBe(CellKind.ThreeQuarterNW);
  });

  it('pairs opposite three-quarter corners while making adjacent clicks exact no-ops', () => {
    let pattern = document();
    pattern = apply(pattern, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.NE, color: 1 });
    pattern = markCellComplete(pattern, 0, 0);
    const editor = editorFromSurface(pattern);
    const beforeAdjacent = cellSnapshot(editor.composite);
    const adjacent = editor.execute(onDefaultLayers({ type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.NW, color: 2 }));
    expect(adjacent.changed).toBe(false);
    expect(editor.composite).toEqual(beforeAdjacent);
    expect(editor.revision).toBe(beforeAdjacent.revision);
    expect(editor.undoDepth).toBe(0);

    const paired = editor.execute(onDefaultLayers({ type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.SW, color: 2 }));
    expect(paired.changed).toBe(true);
    expect(editor.composite.kind[0]).toBe(CellKind.ThreeQuarterPair);
    expect(editor.composite.colors.slice(0, 4)).toEqual(new Uint16Array([0, 1, 0, 2]));
    expect(editor.composite.completed[0]).toBe(2);

    const beforePairAdjacent = cellSnapshot(editor.composite);
    const pairAdjacent = editor.execute(onDefaultLayers({ type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.NW, color: 3 }));
    expect(pairAdjacent.changed).toBe(false);
    expect(editor.composite).toEqual(beforePairAdjacent);
    expect(editor.revision).toBe(beforePairAdjacent.revision);

    const bulkAdjacent = editor.execute(onDefaultLayers(bulkSetThreeQuarterCommand(new Uint32Array([0]), QuarterCorner.NW, 3)));
    expect(bulkAdjacent.changed).toBe(false);
    expect(editor.composite).toEqual(beforePairAdjacent);
    expect(editor.revision).toBe(beforePairAdjacent.revision);

    const bulkCompletion = editor.applyProgress({ cells: { indices: new Uint32Array([0]), masks: new Uint8Array([10]) }, operation: 'set' })!.result;
    expect(bulkCompletion.changedIndices).toEqual(new Uint32Array([0]));
    expect(bulkCompletion.progress).toMatchObject({ marked: 1, unmarked: 0 });
    expect(editor.composite.completed[0]).toBe(10);

    const recolored = editor.execute(onDefaultLayers({ type: 'recolor-cell', x: 0, y: 0, corner: QuarterCorner.SW, color: 3 }));
    expect(recolored.changed).toBe(true);
    expect(editor.composite.colors.slice(0, 4)).toEqual(new Uint16Array([0, 1, 0, 3]));
    expect(editor.composite.completed[0]).toBe(10);
    const beforeRecolorAdjacent = cellSnapshot(editor.composite);
    expect(editor.execute(onDefaultLayers({ type: 'recolor-cell', x: 0, y: 0, corner: QuarterCorner.NW, color: 2 })).changed).toBe(false);
    expect(editor.composite).toEqual(beforeRecolorAdjacent);
  });

  it('erases paired components independently and canonicalizes the survivor', () => {
    let pattern = document();
    pattern = apply(pattern, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.NW, color: 1 });
    pattern = apply(pattern, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.SE, color: 2 });
    pattern = markCellComplete(pattern, 0, 0, QuarterCorner.SE);
    const editor = editorFromSurface(pattern);

    const erased = editor.execute(onDefaultLayers({ type: 'erase-quarter', x: 0, y: 0, corner: QuarterCorner.NW }));
    expect(erased.changed).toBe(true);
    expect(editor.composite.kind[0]).toBe(CellKind.ThreeQuarterSE);
    expect(editor.composite.colors.slice(0, 4)).toEqual(new Uint16Array([2, 0, 0, 0]));
    expect(editor.composite.completed[0]).toBe(1);

    const adjacent = editor.execute(onDefaultLayers({ type: 'erase-quarter', x: 0, y: 0, corner: QuarterCorner.NE }));
    expect(adjacent.changed).toBe(false);
    expect(editor.composite.kind[0]).toBe(CellKind.ThreeQuarterSE);
    const whole = editor.execute(onDefaultLayers({ type: 'erase-cell', x: 0, y: 0 }));
    expect(whole.changed).toBe(true);
    expect(editor.composite.kind[0]).toBe(CellKind.Empty);
    expect(editor.composite.colors.slice(0, 4)).toEqual(new Uint16Array([0, 0, 0, 0]));
    expect(editor.composite.completed[0]).toBe(0);
  });

  it('validates pair geometry and retains physical corner data through fragments', () => {
    let pattern = document(2, 1);
    pattern = apply(pattern, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.NW, color: 1 });
    pattern = apply(pattern, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.SE, color: 1 });
    expect(() => assertValidDocument(pattern)).not.toThrow();
    expect(getCell(pattern, 0, 0).threeQuarters).toEqual([
      { color: 1, completed: false },
      { color: 0, completed: false },
      { color: 1, completed: false },
      { color: 0, completed: false }
    ]);
    const fragment = createPatternFragment(pattern, { x: 0, y: 0, width: 1, height: 1 });
    expect(() => assertValidPatternFragment(fragment)).not.toThrow();
    const pasted = applyCommand(document(2, 1), pasteFragmentCommand(fragment, { x: 1, y: 0 }));
    expect(pasted.document.kind[1]).toBe(CellKind.ThreeQuarterPair);
    expect(pasted.document.colors.slice(4, 8)).toEqual(new Uint16Array([1, 0, 1, 0]));

    const invalid = pattern.kind.slice();
    invalid[0] = CellKind.ThreeQuarterPair;
    const invalidPair = { ...pattern, kind: invalid, colors: new Uint16Array([1, 1, 0, 0, 0, 0, 0, 0]) };
    expect(() => assertValidDocument(invalidPair)).toThrow();
  });

  it('overwrites three-quarter geometry, preserves same-kind completion, and packs bulk undo state', () => {
    let pattern = document();
    pattern = apply(pattern, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.NW, color: 1 });
    pattern = markCellComplete(pattern, 0, 0);
    const editor = editorFromSurface(pattern);
    const result = editor.execute(onDefaultLayers(bulkSetThreeQuarterCommand(new Uint32Array([0, 1]), QuarterCorner.NW, 2)));
    expect(result.changed).toBe(true);
    expect(result.changedIndices).toEqual(new Uint32Array([0, 1]));
    expect(editor.composite.kind[0]).toBe(CellKind.ThreeQuarterNW);
    expect(Array.from(editor.composite.colors.slice(0, 4))).toEqual([2, 0, 0, 0]);
    expect(editor.composite.completed[0]).toBe(1);
    expect(editor.composite.kind[1]).toBe(CellKind.ThreeQuarterNW);
    expect(Array.from(editor.composite.colors.slice(4, 8))).toEqual([2, 0, 0, 0]);
    const undone = editor.undo();
    expect(undone.changed).toBe(true);
    expect(undone.changedIndices).toEqual(new Uint32Array([0, 1]));
    undone.changedIndices?.fill(99);
    expect(editor.composite.kind[0]).toBe(CellKind.ThreeQuarterNW);
    expect(Array.from(editor.composite.colors.slice(0, 4))).toEqual([1, 0, 0, 0]);
    expect(editor.composite.completed[0]).toBe(1);
    const redone = editor.redo();
    expect(redone.changed).toBe(true);
    expect(redone.changedIndices).toEqual(new Uint32Array([0, 1]));
    expect(editor.composite.kind[0]).toBe(CellKind.ThreeQuarterNW);
    expect(Array.from(editor.composite.colors.slice(0, 4))).toEqual([2, 0, 0, 0]);
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
    expect(() => assertValidDocument(pattern)).toThrow();
  });

  it('merges a referenced palette color into another and deactivates the source atomically', () => {
    let pattern = document(2, 2);
    pattern = apply(pattern, { type: 'set-full', x: 0, y: 0, color: 1 });
    pattern = apply(pattern, { type: 'set-quarter', x: 1, y: 0, corner: QuarterCorner.NW, color: 1 });
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 4 }, color: 1 });
    const editor = editorFromSurface(pattern);
    const result = editor.execute(onDefaultLayers({ type: 'palette-merge', from: 1, to: 2 }));

    expect(result.changed).toBe(true);
    expect(result.recalculateMetrics).toBe(true);
    const next = result.document;
    expect(next.palette.find((entry) => entry.id === 1)?.active).toBe(false);
    expect(next.palette.find((entry) => entry.id === 1)?.id).toBe(1);
    expect(next.colors[0]).toBe(2);
    expect(next.colors[1 * 4]).toBe(2);
    expect(getBackstitch(next, 1)?.color).toBe(2);
    expect(() => assertValidDocument(next)).not.toThrow();

    expect(editor.undo().changed).toBe(true);
    const undone = editor.composite;
    expect(undone.palette.find((entry) => entry.id === 1)?.active).toBe(true);
    expect(undone.colors[0]).toBe(1);
    expect(getBackstitch(undone, 1)?.color).toBe(1);
    expect(editor.redo().changed).toBe(true);
    expect(editor.composite.colors[0]).toBe(2);
  });

  it('removes an unreferenced palette color via merge and rejects invalid merges', () => {
    const pattern = document(2, 2);
    const merged = applyCommand(pattern, { type: 'palette-merge', from: 3, to: 1 }).document;
    expect(merged.palette.find((entry) => entry.id === 3)?.active).toBe(false);
    expect(merged.palette.find((entry) => entry.id === 3)?.id).toBe(3);

    expect(() => applyCommand(pattern, { type: 'palette-merge', from: 1, to: 1 })).toThrow();
    expect(() => applyCommand(pattern, { type: 'palette-merge', from: 99, to: 1 })).toThrow();
    expect(() => applyCommand(pattern, { type: 'palette-merge', from: 1, to: 99 })).toThrow();
    const inactiveMerge = applyCommand(pattern, { type: 'palette-create', name: 'Muted', color: '#888', active: false }).document;
    expect(() => applyCommand(inactiveMerge, { type: 'palette-merge', from: 2, to: 4 })).toThrow();
  });

  it('palette-delete removes references instead of only deactivating the color', () => {
    let pattern = document(4, 1);
    pattern = apply(pattern, { type: 'set-full', x: 0, y: 0, color: 1 });
    pattern = apply(pattern, { type: 'set-half', x: 1, y: 0, direction: HalfDirection.Slash, color: 1 });
    pattern = apply(pattern, { type: 'set-quarter', x: 2, y: 0, corner: QuarterCorner.NW, color: 1 });
    pattern = apply(pattern, { type: 'set-quarter', x: 2, y: 0, corner: QuarterCorner.SE, color: 2 });
    pattern = apply(pattern, { type: 'set-full', x: 3, y: 0, color: 2 });
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 1 });
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 4, y: 0 }, end: { x: 8, y: 0 }, color: 2 });
    const editor = editorFromSurface(pattern);

    const deleted = editor.execute(onDefaultLayers({ type: 'palette-delete', id: 1 }));

    expect(deleted.changed).toBe(true);
    expect(deleted.document.palette.find((entry) => entry.id === 1)?.active).toBe(false);
    expect(getCell(deleted.document, 0, 0).kind).toBe(CellKind.Empty);
    expect(getCell(deleted.document, 1, 0).kind).toBe(CellKind.Empty);
    expect(getCell(deleted.document, 2, 0)).toMatchObject({ kind: CellKind.Quarters });
    expect(deleted.document.colors.slice(8, 12)).toEqual(new Uint16Array([0, 0, 2, 0]));
    expect(getCell(deleted.document, 3, 0)).toMatchObject({ kind: CellKind.Full, color: 2 });
    expect(listBackstitches(deleted.document).map((line) => line.color)).toEqual([2]);
    expect(() => assertValidDocument(deleted.document)).not.toThrow();

    expect(editor.undo().changed).toBe(true);
    expect(editor.composite.palette.find((entry) => entry.id === 1)?.active).toBe(true);
    expect(getCell(editor.composite, 0, 0).kind).toBe(CellKind.Full);
    expect(listBackstitches(editor.composite).map((line) => line.color)).toEqual([1, 2]);
    expect(editor.redo().changed).toBe(true);
    expect(listBackstitches(editor.composite).map((line) => line.color)).toEqual([2]);
  });

  it('palette-delete preserves the opposite pair member, corner, and completion for either deleted color', () => {
    let pattern = apply(document(1, 1), { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.NW, color: 1 });
    pattern = apply(pattern, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.SE, color: 2 });
    pattern = markCellComplete(pattern, 0, 0, QuarterCorner.NW);
    pattern = markCellComplete(pattern, 0, 0, QuarterCorner.SE);

    for (const [deletedColor, survivorColor, survivorCorner, survivorKind] of [
      [1, 2, QuarterCorner.SE, CellKind.ThreeQuarterSE],
      [2, 1, QuarterCorner.NW, CellKind.ThreeQuarterNW]
    ] as const) {
      const deleted = applyCommand(pattern, { type: 'palette-delete', id: deletedColor }).document;
      const survivor = getCell(deleted, 0, 0);
      const expectedComponents = [
        { color: 0, completed: false },
        { color: 0, completed: false },
        { color: 0, completed: false },
        { color: 0, completed: false }
      ];
      expectedComponents[survivorCorner] = { color: survivorColor, completed: true };

      expect(survivor.kind).toBe(survivorKind);
      expect(survivor.threeQuarters).toEqual(expectedComponents);
      expect(() => assertValidDocument(deleted)).not.toThrow();
    }
  });

  it('palette-delete clears same-color pairs and non-NW three-quarter singles', () => {
    let pattern = apply(document(4, 1), { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.NW, color: 1 });
    pattern = apply(pattern, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.SE, color: 1 });
    pattern = apply(pattern, { type: 'set-three-quarter', x: 1, y: 0, corner: QuarterCorner.NE, color: 1 });
    pattern = apply(pattern, { type: 'set-three-quarter', x: 2, y: 0, corner: QuarterCorner.SE, color: 1 });
    pattern = apply(pattern, { type: 'set-three-quarter', x: 3, y: 0, corner: QuarterCorner.SW, color: 1 });

    const deleted = applyCommand(pattern, { type: 'palette-delete', id: 1 }).document;

    expect(deleted.kind).toEqual(new Uint8Array(4));
    expect(deleted.colors).toEqual(new Uint16Array(16));
    expect(() => assertValidDocument(deleted)).not.toThrow();
  });

  it('palette-delete preserves surviving backstitch identities, geometry, completion, and allocator state', () => {
    let pattern = document(3, 2);
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 1 });
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 0, y: 4 }, end: { x: 4, y: 4 }, color: 2 });
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 4, y: 0 }, end: { x: 8, y: 0 }, color: 2 });
    pattern = markBackstitchComplete(pattern, 2);
    const retainedBackstitches = listBackstitches(pattern).filter((line) => line.color !== 1);
    const nextBackstitchId = pattern.nextBackstitchId;

    const deleted = applyCommand(pattern, { type: 'palette-delete', id: 1 }).document;

    expect(listBackstitches(deleted)).toEqual(retainedBackstitches);
    expect(deleted.nextBackstitchId).toBe(nextBackstitchId);
    expect(() => assertValidDocument(deleted)).not.toThrow();
  });

  it('palette-delete rejects an unknown palette id like the other palette commands', () => {
    expect(() => applyCommand(document(), { type: 'palette-delete', id: 99 })).toThrow(/does not exist/);
  });

  it('atomically creates a replacement color and merges into it in one command', () => {
    let pattern = document(2, 1);
    pattern = apply(pattern, { type: 'set-full', x: 0, y: 0, color: 1 });
    const editor = editorFromSurface(pattern);
    const result = editor.execute(onDefaultLayers({
      type: 'palette-merge',
      from: 1,
      createTo: { name: 'Lilac', color: '#C9A0DC', catalog: { catalogId: TEST_CATALOG.catalogId, sourceId: 's', code: '3740', name: 'Lilac', hex: '#C9A0DC', rgb: [201, 160, 220] } }
    }));
    expect(result.changed).toBe(true);
    const next = result.document;
    const added = next.palette.find((entry) => entry.catalog?.code === '3740');
    expect(added).toBeDefined();
    expect(next.palette.find((entry) => entry.id === 1)?.active).toBe(false);
    expect(next.colors[0]).toBe(added!.id);
    expect(() => assertValidDocument(next)).not.toThrow();
    expect(editor.undo().changed).toBe(true);
    expect(editor.composite.colors[0]).toBe(1);
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
        symbol: SYMBOL_IDS[0],
        material: { kind: 'floss', label: 'Cotton', unit: 'skeins', amount: 2 },
        catalog: { catalogId: TEST_CATALOG.catalogId, sourceId: 'source', code: 'R', name: 'Red', hex: '#DD3333', rgb: [221, 51, 51] }
      }]
    });
    const editor = editorFromSurface(pattern);
    const result = editor.execute(onDefaultLayers({ type: 'palette-update', id: 1, material: { kind: 'floss', label: 'Silk', unit: 'meters', amount: 4 }, catalog: { catalogId: TEST_CATALOG.catalogId, sourceId: 'source-2', code: 'R2', name: 'Red 2', hex: '#CC2222', rgb: [204, 34, 34] } }));
    expect(result.changed).toBe(true);
    expect(editor.composite.palette[0].material).toMatchObject({ label: 'Silk', unit: 'meters', amount: 4 });
    expect(editor.composite.palette[0].catalog?.catalogId).toBe(TEST_CATALOG.catalogId);
    editor.undo();
    expect(editor.composite.palette[0].material).toMatchObject({ label: 'Cotton', unit: 'skeins', amount: 2 });
    expect(editor.composite.palette[0].catalog?.catalogId).toBe(TEST_CATALOG.catalogId);
    editor.redo();
    expect(editor.composite.palette[0].catalog?.rgb).toEqual([204, 34, 34]);
  });

  it('creates a color against a non-empty pool and draws its default symbol', () => {
    // The counterpart of the empty-pool guard in empty-symbol-pool.test.ts: with
    // glyphs in the pool, adding a color is ordinary work and the symbol it
    // lands on is one the pool can actually draw.
    const pattern = createDocument({ width: 1, height: 1, catalog: TEST_CATALOG });
    const result = applyCommand(pattern, { type: 'palette-create', name: 'Ruby', color: '#b44' });
    const [entry] = result.document.palette;
    expect(result.changed).toBe(true);
    expect(isKnownSymbolId(entry.symbol)).toBe(true);
    expect(getSymbolOutline(entry.symbol)).toBeDefined();
  });

  it('assigns pool defaults in order and cycles deterministically past the pool end', () => {
    // The pool is curated to fewer symbols than the brand palette ceiling, so
    // the "pool must cover the catalog" size requirement is relaxed: ids past
    // the pool end reuse the cycled default. The pool itself still has one
    // drawable slug per id.
    expect(SYMBOL_IDS.length).toBeLessThan(TEST_CATALOG.colorCount);
    expect(new Set(SYMBOL_IDS).size).toBe(SYMBOL_IDS.length);
    for (const id of SYMBOL_IDS) {
      expect(id.length).toBeGreaterThan(0);
      expect(getSymbolOutline(id), `${id} is not drawable`).toBeDefined();
    }
    // Defaults are assigned in pool order, so id 1 takes the first slug and the
    // sequence is a straight slice of the pool up to the pool end.
    expect([1, 2, 3, 4, 5].map(defaultPaletteSymbol)).toEqual(SYMBOL_IDS.slice(0, 5));
    expect(defaultPaletteSymbol(SYMBOL_IDS.length)).toBe(SYMBOL_IDS[SYMBOL_IDS.length - 1]);
    // Ids 1..pool length each get a distinct default symbol.
    const assigned = new Set<string>();
    for (let id = 1; id <= SYMBOL_IDS.length; id += 1) {
      assigned.add(defaultPaletteSymbol(id));
    }
    expect(assigned.size).toBe(SYMBOL_IDS.length);
    // Past the end of the pool the assignment cycles deterministically.
    expect(defaultPaletteSymbol(SYMBOL_IDS.length + 1)).toBe(SYMBOL_IDS[0]);
    expect(defaultPaletteSymbol(2 * SYMBOL_IDS.length + 1)).toBe(SYMBOL_IDS[0]);
    expect(() => defaultPaletteSymbol(0)).toThrow(DomainError);
  });

  it('validates reassigned palette symbols through palette-update', () => {
    // The shared helper builds a three-entry palette whose defaults are the
    // first three slugs in pool order, so slugs from `fourth` on are free.
    const editor = editorFromSurface(document(2, 2));
    const [first, second, third, fourth, fifth, sixth] = SYMBOL_IDS;
    expect(editor.composite.palette.map((entry) => entry.symbol)).toEqual([first, second, third]);
    const result = editor.execute(onDefaultLayers({ type: 'palette-update', id: 1, symbol: fourth }));
    expect(result.changed).toBe(true);
    expect(editor.composite.palette[0].symbol).toBe(fourth);
    expect(() => editor.execute(onDefaultLayers({ type: 'palette-update', id: 2, symbol: '' }))).toThrow(/empty/);
    expect(() => editor.execute(onDefaultLayers({ type: 'palette-update', id: 2, symbol: '   ' }))).toThrow(/empty/);
    // Only a slug the pool owns is a valid symbol; anything else is refused,
    // which is what keeps an undrawable character out of a saved document.
    expect(() => editor.execute(onDefaultLayers({ type: 'palette-update', id: 2, symbol: '\u2606' }))).toThrow(/not in the symbol pool/);
    expect(() => editor.execute(onDefaultLayers({ type: 'palette-update', id: 2, symbol: 'ABC' }))).toThrow(/not in the symbol pool/);
    editor.execute(onDefaultLayers({ type: 'palette-update', id: 2, symbol: fifth }));
    expect(editor.composite.palette[1].symbol).toBe(fifth);
    // A slug another entry already holds is still a duplicate.
    expect(() => editor.execute(onDefaultLayers({ type: 'palette-update', id: 1, symbol: fifth }))).toThrow(/duplicated/);
    expect(() => editor.execute(onDefaultLayers({ type: 'palette-update', id: 99, symbol: fifth }))).toThrow();
    // A slug no entry holds is accepted even on an entry this test never touched.
    expect(() => editor.execute(onDefaultLayers({ type: 'palette-update', id: 3, symbol: sixth }))).not.toThrow();
    // Slugs are case sensitive, so a differently-cased copy is simply unknown.
    const upper = first.toUpperCase();
    if (upper !== first) {
      expect(() => editor.execute(onDefaultLayers({ type: 'palette-update', id: 1, symbol: upper }))).toThrow(/not in the symbol pool/);
    }
  });

  it('swaps two palette glyphs atomically, round-trips through undo and keeps every glyph unique', () => {
    // The shared helper builds a three-entry palette whose defaults are the
    // first three slugs in pool order.
    const editor = editorFromSurface(document(2, 2));
    const [first, second, third] = SYMBOL_IDS;
    expect(editor.composite.palette.map((entry) => entry.symbol)).toEqual([first, second, third]);
    const result = editor.execute(onDefaultLayers({ type: 'palette-swap', a: 1, b: 2 }));
    expect(result.changed).toBe(true);
    expect(editor.composite.palette.map((entry) => entry.symbol)).toEqual([second, first, third]);
    // The move is atomic, so the document never passes through a duplicated
    // glyph, and the swap is recordable: undo/redo restore both sides.
    expect(new Set(editor.composite.palette.map((entry) => entry.symbol)).size).toBe(3);
    expect(editor.undo().document.palette.map((entry) => entry.symbol)).toEqual([first, second, third]);
    expect(editor.redo().document.palette.map((entry) => entry.symbol)).toEqual([second, first, third]);
    // The two-step palette-update formulation stays impossible: giving entry 1
    // the glyph entry 2 still holds is a duplicate, which is exactly the trap
    // the picker used to fall into.
    expect(() => editor.execute(onDefaultLayers({ type: 'palette-update', id: 1, symbol: first }))).toThrow(/duplicated/);
  });

  it('rejects malformed palette-swap commands and keeps the palette unique through a swap', () => {
    const editor = editorFromSurface(document(2, 2));
    expect(() => editor.execute(onDefaultLayers({ type: 'palette-swap', a: 1, b: 1 }))).toThrow(/distinct colors/);
    expect(() => editor.execute(onDefaultLayers({ type: 'palette-swap', a: 1, b: 99 }))).toThrow();
    expect(() => editor.execute(onDefaultLayers({ type: 'palette-swap', a: 99, b: 1 }))).toThrow();
    // Swapping twice round-trips the glyphs without ever producing a duplicate:
    // validation forbids that state from arising, so the swap's identical-glyph
    // no-op is defensive rather than reachable.
    editor.execute(onDefaultLayers({ type: 'palette-swap', a: 1, b: 2 }));
    editor.execute(onDefaultLayers({ type: 'palette-swap', a: 1, b: 2 }));
    const [first, second] = SYMBOL_IDS;
    expect(editor.composite.palette.map((entry) => entry.symbol)).toEqual([first, second, SYMBOL_IDS[2]]);
    expect(new Set(editor.composite.palette.map((entry) => entry.symbol)).size).toBe(3);
  });

  it('auto-assigns a unique glyph per pool symbol, cycles cycled defaults for the rest, and rejects past it', () => {
    let pattern = createDocument({ width: 2, height: 2, catalog: TEST_CATALOG });
    for (let id = 1; id <= TEST_CATALOG.colorCount; id++) {
      pattern = applyCommand(pattern, { type: 'palette-create', name: `Color ${id}`, color: '#123456' }).document;
    }
    expect(pattern.palette).toHaveLength(TEST_CATALOG.colorCount);
    // Auto-assignment takes the first unused symbol in pool order, so the first
    // pool-sized chunk carries every pool slug once, and each of the remaining
    // entries reuses its cycled default (the auto-overflow path) instead of
    // failing once the pool is exhausted.
    expect(pattern.palette.slice(0, SYMBOL_IDS.length).map((entry) => entry.symbol)).toEqual(SYMBOL_IDS);
    for (let id = SYMBOL_IDS.length + 1; id <= TEST_CATALOG.colorCount; id++) {
      expect(pattern.palette[id - 1].symbol).toBe(defaultPaletteSymbol(id));
    }
    expect(new Set(pattern.palette.map((entry) => entry.symbol)).size).toBe(SYMBOL_IDS.length);
    // The next palette-create would exceed the brand ceiling, so it must throw
    // instead of overflowing onto a cycled duplicate.
    expect(() => applyCommand(pattern, { type: 'palette-create', name: 'Color over', color: '#654321' })).toThrow(/brand's color count/);
    // Explicit duplicates stay rejected on create and update alike (checked on
    // a small palette so the brand-ceiling guard does not fire first).
    const small = document(2, 2);
    expect(() => applyCommand(small, { type: 'palette-create', name: 'Copy', color: '#000000', symbol: SYMBOL_IDS[0] })).toThrow(/duplicated/);
    expect(() => applyCommand(small, { type: 'palette-update', id: 2, symbol: SYMBOL_IDS[0] })).toThrow(/duplicated/);
  }, 10_000);

  it('yields cycled defaults at the brand ceiling and rejects ids above it', () => {
    const entries = Array.from({ length: TEST_CATALOG.colorCount }, (_, index) => ({
      id: index + 1,
      name: `Color ${index + 1}`,
      color: '#123456'
    }));
    const pattern = createDocument({ width: 2, height: 2, catalog: TEST_CATALOG, palette: entries });
    expect(pattern.palette).toHaveLength(TEST_CATALOG.colorCount);
    // The create path derives the cycled default per id, so a full-ceiling
    // document stays valid even though the pool no longer covers the catalog.
    expect(pattern.palette.slice(0, SYMBOL_IDS.length).map((entry) => entry.symbol)).toEqual(SYMBOL_IDS);
    for (let id = SYMBOL_IDS.length + 1; id <= TEST_CATALOG.colorCount; id++) {
      expect(pattern.palette[id - 1].symbol).toBe(defaultPaletteSymbol(id));
    }
    // An explicit id above the brand ceiling is rejected on palette-create, and
    // it is a symbol the pool owns, so the id is the only thing wrong with it.
    expect(() => applyCommand(pattern, { type: 'palette-create', name: 'Over', color: '#ffffff', id: TEST_CATALOG.colorCount + 1, symbol: SYMBOL_IDS[0] })).toThrow(/brand's color count/);
  });

  it('enforces the shared maximum cell count during creation and validation', () => {
    const maximum = createDocument({ width: MAX_PERSISTABLE_CELL_COUNT, height: 1, catalog: TEST_CATALOG });
    expect(maximum.kind).toHaveLength(MAX_PERSISTABLE_CELL_COUNT);
    expect(() => createDocument({ width: MAX_PERSISTABLE_CELL_COUNT + 1, height: 1, catalog: TEST_CATALOG })).toThrow(DomainError);

    const invalid = document(1, 1);
    invalid.width = MAX_PERSISTABLE_CELL_COUNT + 1;
    expect(() => assertValidDocument(invalid)).toThrow();
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
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 8, y: 4 }, end: { x: 0, y: 0 }, color: 1 });
    const id = listBackstitches(pattern)[0].id;
    expect(getBackstitch(pattern, id)).toMatchObject({ completed: false });
    pattern = markBackstitchComplete(pattern, id);
    expect(getBackstitch(pattern, id)).toMatchObject({ id, x1: 0, y1: 0, x2: 8, y2: 4, completed: true });

    pattern = apply(pattern, { type: 'recolor-backstitch', id, color: 2 });
    expect(getBackstitch(pattern, id)).toMatchObject({ color: 2, completed: true });
    pattern = apply(pattern, { type: 'move-backstitch', id, start: { x: 12, y: 8 }, end: { x: 4, y: 4 } });
    expect(getBackstitch(pattern, id)).toMatchObject({ id, x1: 4, y1: 4, x2: 12, y2: 8, completed: false });
    pattern = markBackstitchComplete(pattern, id);
    pattern = apply(pattern, { type: 'update-backstitch', id, start: { x: 8, y: 0 }, end: { x: 12, y: 4 }, color: 1 });
    expect(getBackstitch(pattern, id)).toMatchObject({ x1: 8, y1: 0, x2: 12, y2: 4, completed: false });
  });

  it('snaps new and moved backstitch endpoints away from cell interiors without migrating legacy geometry', () => {
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

  it('snaps a backstitch point to a corner or, within a quarter cell, an edge midpoint', () => {
    expect(snapBackstitchPoint({ x: 4, y: 8 })).toEqual({ x: 4, y: 8 });
    expect(snapBackstitchPoint({ x: 5, y: 7 })).toEqual({ x: 4, y: 8 });
    // Horizontal edge midpoint (1.5, 1): taken within one unit, a corner beyond it.
    expect(snapBackstitchPoint({ x: 6, y: 4 })).toEqual({ x: 6, y: 4 });
    expect(snapBackstitchPoint({ x: 6.8, y: 4 })).toEqual({ x: 6, y: 4 });
    expect(snapBackstitchPoint({ x: 7.2, y: 4 })).toEqual({ x: 8, y: 4 });
    // Vertical edge midpoint (1, 1.5).
    expect(snapBackstitchPoint({ x: 4, y: 6 })).toEqual({ x: 4, y: 6 });
    expect(snapBackstitchPoint({ x: 4.5, y: 5.5 })).toEqual({ x: 4, y: 6 });
    // Near a cell centre the point goes to a corner, never to the centre.
    expect(snapBackstitchPoint({ x: 6, y: 6 })).toEqual({ x: 8, y: 8 });
    expect(snapBackstitchPoint({ x: 5.5, y: 6.5 })).toEqual({ x: 4, y: 8 });
    for (let x = 0; x <= 12; x += 0.25) {
      for (let y = 0; y <= 12; y += 0.25) {
        const snapped = snapBackstitchPoint({ x, y });
        const onCorner = snapped.x % 4 === 0 && snapped.y % 4 === 0;
        const onMidpoint = (snapped.x % 4 === 0 && snapped.y % 4 === 2) || (snapped.x % 4 === 2 && snapped.y % 4 === 0);
        expect({ x, y, valid: onCorner || onMidpoint }).toEqual({ x, y, valid: true });
        expect(snapBackstitchPoint(snapped)).toEqual(snapped);
      }
    }
    // With bounds the point is clamped to the document first.
    expect(snapBackstitchPoint({ x: -3, y: 50 }, { width: 3, height: 3 })).toEqual({ x: 0, y: 12 });
    expect(snapBackstitchPoint({ x: 13, y: 6 }, { width: 3, height: 3 })).toEqual({ x: 12, y: 6 });
  });

  it('keeps edge-midpoint backstitch endpoints through add, move and paste', () => {
    let pattern = document(3, 2);
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 0, y: 2 }, end: { x: 6, y: 4 }, color: 1 });
    const id = listBackstitches(pattern)[0].id;
    expect(getBackstitch(pattern, id)).toMatchObject({ x1: 0, y1: 2, x2: 6, y2: 4 });
    pattern = apply(pattern, { type: 'move-backstitch', id, start: { x: 0, y: 2 }, end: { x: 4, y: 6 } });
    expect(getBackstitch(pattern, id)).toMatchObject({ x1: 0, y1: 2, x2: 4, y2: 6 });

    const fragment = createPatternFragment(pattern, { x: 0, y: 0, width: 2, height: 2 });
    const pasted = applyCommand(document(3, 3), pasteFragmentCommand(fragment, { x: 1, y: 1 }));
    expect(listBackstitches(pasted.document)[0]).toMatchObject({ x1: 4, y1: 6, x2: 8, y2: 10 });
  });

  it('rejects invalid palette and duplicate segments atomically', () => {
    const editor = editorFromSurface(document());
    expect(() => editor.execute(onDefaultLayers({ type: 'batch', commands: [
      { type: 'set-full', x: 0, y: 0, color: 1 },
      { type: 'set-full', x: 1, y: 0, color: 99 }
    ] }))).toThrow();
    expect(editor.composite.kind[0]).toBe(CellKind.Empty);
    expect(editor.composite.kind[1]).toBe(CellKind.Empty);
    expect(editor.composite.revision).toBe(0);
    expect(editor.undoDepth).toBe(0);

    editor.execute(onDefaultLayers({ type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 4 }, color: 1 }));
    expect(() => editor.execute(onDefaultLayers({ type: 'add-backstitch', start: { x: 4, y: 4 }, end: { x: 0, y: 0 }, color: 1 }))).toThrow();
    expect(editor.composite.backstitches.ids).toHaveLength(1);
    expect(editor.composite.revision).toBe(1);
  });

  it('rejects invalid bulk targets, intent, palette, and stale revisions atomically', () => {
    const editor = editorFromSurface(document());
    const before = cellSnapshot(editor.composite);
    expect(() => editor.execute(onDefaultLayers({ type: 'bulk-cell', indices: new Uint32Array([0, 2, 1]), edit: { kind: 'full', color: 1 } }))).toThrow(/strictly increasing/);
    expect(() => editor.execute(onDefaultLayers({ type: 'bulk-cell', indices: new Uint32Array([0, 99]), edit: { kind: 'full', color: 1 } }))).toThrow(/out of bounds/);
    expect(() => editor.execute(onDefaultLayers({ type: 'bulk-cell', indices: new Uint32Array([0, 1]), edit: { kind: 'full', color: 99 } }))).toThrow(/Palette/);
    expect(() => editor.execute(onDefaultLayers(bulkCellCommand(new Uint32Array([0]), { kind: 'full', color: 1 }, 1)))).toThrow(/expected revision/);
    expect(editor.composite).toEqual(before);
    expect(editor.composite.revision).toBe(0);
    expect(editor.undoDepth).toBe(0);
    expect(editor.historyBytes).toBe(0);
  });

  it('rejects a bulk and ordinary command in one batch before mutation', () => {
    const editor = editorFromSurface(document());
    const before = editor.composite;
    const bulk = bulkSetFullCommand(new Uint32Array([0, 1]), 1);

    expect(() => editor.execute(onDefaultLayers({ type: 'batch', commands: [
      { type: 'set-full', x: 2, y: 0, color: 1 },
      bulk
    ] }))).toThrow(/standalone/);
    expect(editor.composite).toBe(before);
    expect(editor.composite.kind.every((kind) => kind === CellKind.Empty)).toBe(true);
    expect(editor.composite.revision).toBe(0);
    expect(editor.undoDepth).toBe(0);
    expect(editor.redoDepth).toBe(0);
  });

  it('rejects multiple bulk commands in one batch before mutation', () => {
    const editor = editorFromSurface(document());
    const before = editor.composite;

    expect(() => editor.execute(onDefaultLayers({ type: 'batch', commands: [
      bulkSetFullCommand(new Uint32Array([0]), 1),
      bulkSetHalfCommand(new Uint32Array([1]), HalfDirection.Slash, 2)
    ] }))).toThrow(/standalone/);
    expect(editor.composite).toBe(before);
    expect(editor.composite.kind.every((kind) => kind === CellKind.Empty)).toBe(true);
    expect(editor.composite.revision).toBe(0);
    expect(editor.undoDepth).toBe(0);
    expect(editor.historyBytes).toBe(0);
  });

  it('applies homogeneous bulk cell edits with canonical completion semantics and quarter isolation', () => {
    let pattern = document(2, 2);
    pattern = apply(pattern, { type: 'set-full', x: 0, y: 0, color: 1 });
    pattern = markCellComplete(pattern, 0, 0);
    pattern = apply(pattern, { type: 'set-quarter', x: 1, y: 0, corner: QuarterCorner.NW, color: 1 });
    pattern = apply(pattern, { type: 'set-quarter', x: 1, y: 0, corner: QuarterCorner.SE, color: 2 });
    pattern = markCellComplete(pattern, 1, 0, QuarterCorner.NW);
    pattern = markCellComplete(pattern, 1, 0, QuarterCorner.SE);
    const editor = editorFromSurface(pattern);

    const full = editor.execute(onDefaultLayers(bulkSetFullCommand(new Uint32Array([0]), 2)));
    expect(full.changed).toBe(true);
    expect(full.touchedIndices).toEqual(new Uint32Array([0]));
    expect(full.changedIndices).toEqual(new Uint32Array([0]));
    expect(getCell(editor.composite, 0, 0)).toMatchObject({ kind: CellKind.Full, color: 2, completed: true });

    const quarter = editor.execute(onDefaultLayers(bulkSetQuarterCommand(new Uint32Array([1]), QuarterCorner.NW, 3)));
    expect(quarter.changed).toBe(true);
    expect(getCell(editor.composite, 1, 0).quarters[QuarterCorner.NW]).toMatchObject({ color: 3, completed: true });
    expect(getCell(editor.composite, 1, 0).quarters[QuarterCorner.SE]).toMatchObject({ color: 2, completed: true });

    editor.execute(onDefaultLayers(bulkEraseQuarterCommand(new Uint32Array([1]), QuarterCorner.NW)));
    expect(getCell(editor.composite, 1, 0).quarters[QuarterCorner.NW]).toMatchObject({ color: 0, completed: false });
    expect(getCell(editor.composite, 1, 0).quarters[QuarterCorner.SE]).toMatchObject({ color: 2, completed: true });

    editor.execute(onDefaultLayers(bulkEraseCellCommand(new Uint32Array([1]))));
    expect(getCell(editor.composite, 1, 0).kind).toBe(CellKind.Empty);

    const half = editor.execute(onDefaultLayers(bulkSetHalfCommand(new Uint32Array([0]), HalfDirection.Slash, 1)));
    expect(half.changed).toBe(true);
    expect(getCell(editor.composite, 0, 0)).toMatchObject({ kind: CellKind.HalfSlash, completed: false });
  });

  it('commits one bulk edit as one sparse history entry and undoes/redoes it', () => {
    const editor = editorFromSurface(document(4, 3));
    const command = bulkSetFullCommand(new Uint32Array([0, 1, 4, 5]), 1);
    const result = editor.execute(onDefaultLayers(command));
    expect(result.revision).toBe(1);
    expect(editor.undoDepth).toBe(1);
    expect(editor.exportHistory().undo.at(-1)?.kind).toBe('delta');
    expect(result.changedIndices).toEqual(new Uint32Array([0, 1, 4, 5]));
    expect(editor.undo().revision).toBe(2);
    expect(editor.composite.kind.slice(0, 6)).toEqual(new Uint8Array(6));
    expect(editor.redo().revision).toBe(3);
    expect(editor.composite.kind.slice(0, 6)).toEqual(new Uint8Array([1, 1, 0, 0, 1, 1]));
  });

  it('recolors masked components across every stitch geometry in one delta', () => {
    let pattern = document(6, 1);
    pattern = apply(pattern, { type: 'set-full', x: 0, y: 0, color: 1 });
    pattern = markCellComplete(pattern, 0, 0);
    pattern = apply(pattern, { type: 'set-half', x: 1, y: 0, direction: HalfDirection.Slash, color: 1 });
    pattern = markCellComplete(pattern, 1, 0);
    pattern = apply(pattern, { type: 'set-three-quarter', x: 2, y: 0, corner: QuarterCorner.NW, color: 1 });
    pattern = markCellComplete(pattern, 2, 0);
    for (const [corner, color] of [[QuarterCorner.NW, 1], [QuarterCorner.NE, 2], [QuarterCorner.SE, 1], [QuarterCorner.SW, 2]] as const) {
      pattern = apply(pattern, { type: 'set-quarter', x: 3, y: 0, corner, color });
    }
    pattern = markCellComplete(pattern, 3, 0, QuarterCorner.NW);
    pattern = apply(pattern, { type: 'set-three-quarter', x: 4, y: 0, corner: QuarterCorner.NW, color: 1 });
    pattern = apply(pattern, { type: 'set-three-quarter', x: 4, y: 0, corner: QuarterCorner.SE, color: 1 });
    pattern = markCellComplete(pattern, 4, 0);
    pattern = apply(pattern, { type: 'set-three-quarter', x: 5, y: 0, corner: QuarterCorner.NW, color: 1 });
    pattern = apply(pattern, { type: 'set-three-quarter', x: 5, y: 0, corner: QuarterCorner.SE, color: 2 });
    pattern = markCellComplete(pattern, 5, 0, QuarterCorner.NW);
    const editor = editorFromSurface(pattern);

    const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
    const masks = new Uint8Array([1, 1, 1, 5, 5, 1]);
    const command = bulkRecolorCommand(indices, masks, 1, 3, editor.revision);
    const preflight = preflightBulkRecolorCommand(editor.composite, command);
    expect(preflight.indices).toEqual(indices);
    expect(preflight.masks).toEqual(masks);
    expect(preflight.changedIndices).toEqual(indices);

    const recolored = editor.execute(onDefaultLayers(command));
    expect(recolored.changedIndices).toEqual(indices);
    expect(editor.composite.kind).toEqual(new Uint8Array([
      CellKind.Full, CellKind.HalfSlash, CellKind.ThreeQuarterNW,
      CellKind.Quarters, CellKind.ThreeQuarterPair, CellKind.ThreeQuarterPair
    ]));
    expect(editor.composite.colors).toEqual(new Uint16Array([
      3, 0, 0, 0, 3, 0, 0, 0, 3, 0, 0, 0,
      3, 2, 3, 2, 3, 0, 3, 0, 3, 0, 2, 0
    ]));
    expect(editor.composite.completed).toEqual(new Uint8Array([1, 1, 1, 1, 5, 1]));
    expect(editor.undoDepth).toBe(1);
    expect(editor.exportHistory().undo.at(-1)?.kind).toBe('delta');
    expect(editor.historyBytes).toBe(estimateBulkRecolorHistoryBytes(indices.length));

    editor.undo();
    expect(editor.composite.colors).toEqual(new Uint16Array([
      1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0,
      1, 2, 1, 2, 1, 0, 1, 0, 1, 0, 2, 0
    ]));
    expect(editor.composite.kind).toEqual(new Uint8Array([
      CellKind.Full, CellKind.HalfSlash, CellKind.ThreeQuarterNW,
      CellKind.Quarters, CellKind.ThreeQuarterPair, CellKind.ThreeQuarterPair
    ]));
    expect(editor.composite.completed[0]).toBe(1);
    editor.redo();
    expect(editor.composite.colors[0]).toBe(3);
    expect(editor.composite.completed[0]).toBe(1);
  });

  it('rejects malformed, mismatched, and stale component recolors atomically', () => {
    const editor = editorFromSurface(document(2, 1));
    editor.execute(onDefaultLayers({ type: 'set-full', x: 0, y: 0, color: 1 }));
    editor.execute(onDefaultLayers({ type: 'set-quarter', x: 1, y: 0, corner: QuarterCorner.NW, color: 1 }));
    editor.clearHistory();
    const before = cellSnapshot(editor.composite);
    const revision = editor.revision;
    const valid = { type: 'bulk-recolor' as const, indices: new Uint32Array([0]), masks: new Uint8Array([1]), fromColor: 1, toColor: 2 };
    expect(() => editor.execute(onDefaultLayers({ ...valid, indices: new Uint32Array([1, 0]), masks: new Uint8Array([1, 1]) }))).toThrow(/strictly increasing/);
    expect(() => editor.execute(onDefaultLayers({ ...valid, masks: new Uint8Array([]) }))).toThrow(/align/);
    expect(() => editor.execute(onDefaultLayers({ ...valid, masks: new Uint8Array([0]) }))).toThrow(/nonzero/);
    expect(() => editor.execute(onDefaultLayers({ ...valid, masks: new Uint8Array([2]) }))).toThrow(/subset/);
    expect(() => editor.execute(onDefaultLayers({ ...valid, fromColor: 2 }))).toThrow(/source/);
    expect(() => editor.execute(onDefaultLayers({ ...valid, fromColor: 99 }))).toThrow(/Palette|palette/);
    expect(() => editor.execute(onDefaultLayers({ ...valid, toColor: 99 }))).toThrow(/Palette|palette/);
    expect(() => editor.execute(onDefaultLayers({ ...valid, expectedRevision: 4 }))).toThrow(/expected revision/);
    expect(editor.composite).toEqual(before);
    expect(editor.revision).toBe(revision);
    expect(editor.undoDepth).toBe(0);
  });

  it('treats a valid source-equals-destination recolor as a no-op without revision or history', () => {
    const editor = editorFromSurface(document(1, 1));
    editor.execute(onDefaultLayers({ type: 'set-full', x: 0, y: 0, color: 1 }));
    editor.clearHistory();
    const revision = editor.revision;
    const result = editor.execute(onDefaultLayers(bulkRecolorCommand(new Uint32Array([0]), new Uint8Array([1]), 1, 1, revision)));
    expect(result.changed).toBe(false);
    expect(result.changedIndices).toEqual(new Uint32Array(0));
    expect(editor.revision).toBe(revision);
    expect(editor.undoDepth).toBe(0);
  });

  it('applies set, clear, and toggle progress to occupied cell components atomically', () => {
    let pattern = document(3, 1);
    pattern = apply(pattern, { type: 'set-full', x: 0, y: 0, color: 1 });
    pattern = apply(pattern, { type: 'set-half', x: 1, y: 0, direction: HalfDirection.Slash, color: 2 });
    pattern = apply(pattern, { type: 'set-quarter', x: 2, y: 0, corner: QuarterCorner.NW, color: 1 });
    pattern = apply(pattern, { type: 'set-quarter', x: 2, y: 0, corner: QuarterCorner.SE, color: 2 });

    const set = applyCommand(pattern, bulkCompletionCommand(new Uint32Array([0, 1, 2]), 'set'));
    expect(set.touchedIndices).toEqual(new Uint32Array([0, 1, 2]));
    expect(set.changedIndices).toEqual(new Uint32Array([0, 1, 2]));
    expect(set.document.completed).toEqual(new Uint8Array([1, 1, 5]));

    const clearCorner = applyCommand(set.document, bulkCompletionCommand(new Uint32Array([2]), 'clear', QuarterCorner.NW));
    expect(clearCorner.changedIndices).toEqual(new Uint32Array([2]));
    expect(clearCorner.document.completed[2]).toBe(4);

    const toggle = applyCommand(clearCorner.document, bulkCompletionCommand(new Uint32Array([0, 2]), 'toggle'));
    expect(toggle.changedIndices).toEqual(new Uint32Array([0, 2]));
    expect(toggle.document.completed).toEqual(new Uint8Array([0, 1, 1]));

    const noOp = applyCommand(toggle.document, bulkCompletionCommand(new Uint32Array([0]), 'clear'));
    expect(noOp.changed).toBe(false);
    expect(noOp.touchedIndices).toEqual(new Uint32Array([0]));
    expect(noOp.changedIndices).toEqual(new Uint32Array(0));
  });
  it('shares dense planes for palette metadata history across create, undo, and redo', () => {
    const side = 1000;
    const editor = editorFromSurface(document(side, side));
    const before = editor.composite;
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

    const created = editor.execute(onDefaultLayers({ type: 'palette-create', name: 'Green', color: '#3a3' }));
    expect(created.changed).toBe(true);
    expect(created.recalculateMetrics).toBe(false);
    expect(editor.composite.kind).toBe(kind);
    expect(editor.composite.colors).toBe(colors);
    expect(editor.composite.completed).toBe(completed);
    expect(editor.composite.backstitches).toBe(before.backstitches);
    expect(editor.composite.palette).not.toBe(before.palette);
    const createdPalette = editor.composite.palette;
    const createdId = created.paletteId;
    expect(createdId).toBeDefined();
    expect(createdPalette.some((entry) => entry.id === createdId && entry.active)).toBe(true);

    expect(editor.undo().changed).toBe(true);
    expect(editor.composite.palette).toEqual(before.palette);
    expect(editor.composite.kind).toBe(kind);
    expect(editor.composite.colors).toBe(colors);
    expect(editor.composite.completed).toBe(completed);
    expect(editor.redo().changed).toBe(true);
    expect(editor.composite.palette).toEqual(createdPalette);
    expect(editor.composite.kind).toBe(kind);
    expect(editor.composite.colors).toBe(colors);
    expect(editor.composite.completed).toBe(completed);

    editor.composite.kind = originalKind;
    editor.composite.colors = originalColors;
    editor.composite.completed = originalCompleted;
    before.kind = originalKind;
    before.colors = originalColors;
    before.completed = originalCompleted;
    expect(densePlaneReads).toEqual({ kind: 0, colors: 0, completed: 0 });

    const updated = editor.execute(onDefaultLayers({ type: 'palette-update', id: createdId!, name: 'Updated green' }));
    expect(updated.changed).toBe(true);
    expect(editor.composite.palette.find((entry) => entry.id === createdId)?.name).toBe('Updated green');
    expect(editor.composite.kind).toBe(originalKind);
    expect(editor.composite.colors).toBe(originalColors);
    expect(editor.composite.completed).toBe(originalCompleted);
    expect(editor.undo().changed).toBe(true);
    expect(editor.composite.palette).toEqual(createdPalette);
    expect(editor.redo().changed).toBe(true);
    expect(editor.composite.palette.find((entry) => entry.id === createdId)?.name).toBe('Updated green');

    const deactivated = editor.execute(onDefaultLayers({ type: 'palette-deactivate', id: createdId! }));
    expect(deactivated.changed).toBe(true);
    expect(editor.composite.palette.find((entry) => entry.id === createdId)?.active).toBe(false);
    expect(editor.composite.kind).toBe(originalKind);
    expect(editor.composite.colors).toBe(originalColors);
    expect(editor.composite.completed).toBe(originalCompleted);
    expect(editor.undo().changed).toBe(true);
    expect(editor.composite.palette.find((entry) => entry.id === createdId)?.active).toBe(true);
    expect(editor.redo().changed).toBe(true);
    expect(editor.composite.palette.find((entry) => entry.id === createdId)?.active).toBe(false);

    assertValidDocument(editor.composite);
  });

  it('applies heterogeneous per-cell completion masks without disturbing unrelated bits', () => {
    let pattern = document(3, 1);
    pattern = apply(pattern, { type: 'set-full', x: 0, y: 0, color: 1 });
    pattern = apply(pattern, { type: 'set-quarter', x: 1, y: 0, corner: QuarterCorner.NW, color: 1 });
    pattern = apply(pattern, { type: 'set-quarter', x: 1, y: 0, corner: QuarterCorner.SE, color: 2 });
    pattern = markCellComplete(pattern, 1, 0, QuarterCorner.NW);
    pattern = apply(pattern, { type: 'set-three-quarter', x: 2, y: 0, corner: QuarterCorner.NW, color: 1 });
    pattern = apply(pattern, { type: 'set-three-quarter', x: 2, y: 0, corner: QuarterCorner.SE, color: 2 });
    pattern = markCellComplete(pattern, 2, 0, QuarterCorner.SE);
    pattern = markCellComplete(pattern, 0, 0);

    const command = {
      type: 'bulk-completion' as const,
      indices: new Uint32Array([0, 1, 2]),
      masks: new Uint8Array([1, 4, 1]),
      operation: 'set' as const
    };
    const preflight = preflightBulkCompletionCommand(pattern, command);
    expect(preflight.changedIndices).toEqual(new Uint32Array([1, 2]));
    expect(preflight.masks).toEqual(new Uint8Array([4, 1]));

    const set = applyCommand(pattern, command);
    expect(set.changedIndices).toEqual(new Uint32Array([1, 2]));
    expect(set.progress).toMatchObject({ marked: 2, unmarked: 0 });
    expect(set.document.completed).toEqual(new Uint8Array([1, 5, 5]));

    const clearPairComponent = applyCommand(set.document, { type: 'bulk-completion', indices: new Uint32Array([2]), masks: new Uint8Array([1]), operation: 'clear' });
    expect(clearPairComponent.changedIndices).toEqual(new Uint32Array([2]));
    expect(clearPairComponent.progress).toMatchObject({ marked: 0, unmarked: 1 });
    expect(clearPairComponent.document.completed[2]).toBe(4);
  });

  it('rejects invalid or conflicting completion masks atomically and treats zero masks as no-ops', () => {
    let pattern = document(2, 1);
    pattern = apply(pattern, { type: 'set-full', x: 0, y: 0, color: 1 });
    pattern = apply(pattern, { type: 'set-quarter', x: 1, y: 0, corner: QuarterCorner.NW, color: 2 });
    const before = cellSnapshot(pattern);

    expect(() => applyCommand(pattern, { type: 'bulk-completion', indices: new Uint32Array([0, 1]), masks: new Uint8Array([1]), operation: 'set' })).toThrow(/align/);
    expect(() => applyCommand(pattern, { type: 'bulk-completion', indices: new Uint32Array([0]), masks: new Uint8Array([2]), operation: 'set' })).toThrow(/subset/);
    expect(() => applyCommand(pattern, { type: 'bulk-completion', indices: new Uint32Array([1]), masks: new Uint8Array([2]), operation: 'set' })).toThrow(/subset/);
    expect(() => applyCommand(pattern, { type: 'bulk-completion', indices: new Uint32Array([0]), masks: new Uint8Array([1]), corner: QuarterCorner.NW, operation: 'set' })).toThrow(/corner/);
    expect(pattern).toEqual(before);

    const noOp = applyCommand(pattern, { type: 'bulk-completion', indices: new Uint32Array([0, 1]), masks: new Uint8Array([0, 0]), operation: 'set' });
    expect(noOp.changed).toBe(false);
    expect(noOp.changedIndices).toEqual(new Uint32Array(0));
    expect(noOp.revision).toBe(pattern.revision);
  });

  it('tracks bulk backstitch progress by stable IDs', () => {
    let pattern = document(3, 2);
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 4 }, color: 1 });
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 0, y: 4 }, end: { x: 4, y: 8 }, color: 2 });
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 4, y: 0 }, end: { x: 8, y: 4 }, color: 3 });

    const set = applyCommand(pattern, bulkBackstitchCompletionCommand(new Uint32Array([1, 2]), 'set'));
    expect(set.touchedBackstitchIds).toEqual(new Uint32Array([1, 2]));
    expect(set.changedBackstitchIds).toEqual(new Uint32Array([1, 2]));
    expect(set.document.backstitches.completed).toEqual(new Uint8Array([1, 1, 0]));
    expect(() => applyCommand(set.document, bulkBackstitchCompletionCommand(new Uint32Array([1, 99]), 'set'))).toThrow(/does not exist/);

    const clear = applyCommand(set.document, bulkBackstitchCompletionCommand(new Uint32Array([1, 2]), 'clear'));
    expect(clear.changedBackstitchIds).toEqual(new Uint32Array([1, 2]));
    const toggle = applyCommand(clear.document, bulkBackstitchCompletionCommand(new Uint32Array([2, 3]), 'toggle'));
    expect(toggle.changedBackstitchIds).toEqual(new Uint32Array([2, 3]));
    expect(toggle.document.backstitches.completed).toEqual(new Uint8Array([0, 1, 1]));
  });

  it('rejects unsorted or geometrically invalid bulk completion targets before mutation', () => {
    const pattern = apply(document(2, 1), { type: 'set-full', x: 0, y: 0, color: 1 });
    const before = cellSnapshot(pattern);
    expect(() => applyCommand(pattern, bulkCompletionCommand(new Uint32Array([1, 0]), 'set'))).toThrow(/strictly increasing/);
    expect(() => applyCommand(pattern, bulkCompletionCommand(new Uint32Array([0]), 'set', QuarterCorner.NW))).toThrow(/quarter geometry/);
    expect(() => applyCommand(pattern, bulkCompletionCommand(new Uint32Array([1]), 'set'))).toThrow(/occupied geometry/);
    expect(pattern).toEqual(before);
  });

  it('copies result index arrays so callers cannot alter undo/redo state', () => {
    const editor = editorFromSurface(document(2, 2));
    const command = bulkSetFullCommand(new Uint32Array([0, 1]), 1);
    const result = editor.execute(onDefaultLayers(command));
    expect(result.changedIndices).toBeInstanceOf(Uint32Array);
    expect(result.touchedIndices).toBeInstanceOf(Uint32Array);

    result.changedIndices?.fill(3);
    result.touchedIndices?.fill(3);
    editor.undo();
    expect(editor.composite.kind[0]).toBe(CellKind.Empty);
    expect(editor.composite.kind[1]).toBe(CellKind.Empty);
    editor.redo();
    expect(editor.composite.kind[0]).toBe(CellKind.Full);
    expect(editor.composite.kind[1]).toBe(CellKind.Full);

    const deleteEditor = editorFromSurface(document(2, 2));
    deleteEditor.execute(onDefaultLayers({ type: 'set-full', x: 0, y: 0, color: 1 }));
    deleteEditor.clearHistory();
    const deleteResult = deleteEditor.execute(onDefaultLayers(deleteRegionCommand({ x: 0, y: 0, width: 1, height: 1 }, deleteEditor.revision)));
    deleteResult.changedIndices?.fill(3);
    deleteResult.touchedIndices?.fill(3);
    deleteEditor.undo();
    expect(deleteEditor.composite.kind[0]).toBe(CellKind.Full);
    deleteEditor.redo();
    expect(deleteEditor.composite.kind[0]).toBe(CellKind.Empty);
  });

  it('does not create history for empty or already matching bulk targets', () => {
    const editor = editorFromSurface(document(2, 2));
    const empty = editor.execute(onDefaultLayers(bulkSetFullCommand(new Uint32Array(0), 1)));
    expect(empty.changed).toBe(false);
    expect(empty.touchedIndices).toEqual(new Uint32Array(0));
    expect(empty.changedIndices).toEqual(new Uint32Array(0));
    editor.execute(onDefaultLayers(bulkSetFullCommand(new Uint32Array([0, 1]), 1)));
    editor.clearHistory();
    const noOp = editor.execute(onDefaultLayers(bulkSetFullCommand(new Uint32Array([0, 1]), 1)));
    expect(noOp.changed).toBe(false);
    expect(noOp.revision).toBe(1);
    expect(editor.undoDepth).toBe(0);
    expect(editor.historyBytes).toBe(0);
  });

  it('preflights bulk history size before mutation', () => {
    const editor = editorFromSurface(document(4, 3), { historyLimitBytes: 103 });
    const before = cellSnapshot(editor.composite);
    expect(() => editor.execute(onDefaultLayers(bulkSetFullCommand(new Uint32Array([0, 1, 2]), 1)))).toThrow(/exceeding/);
    expect(editor.composite).toEqual(before);
    expect(editor.composite.revision).toBe(0);
    expect(editor.undoDepth).toBe(0);
    expect(editor.redoDepth).toBe(0);
  });

  it('handles a 500 by 500 homogeneous fill without per-cell commands', () => {
    const width = 500;
    const height = 500;
    const indices = Uint32Array.from({ length: width * height }, (_, index) => index);
    const editor = editorFromSurface(createDocument({ width, height, catalog: TEST_CATALOG, palette: [{ id: 1, name: 'Red', color: '#d33' }] }));
    const result = editor.execute(onDefaultLayers(bulkSetFullCommand(indices, 1)));
    expect(result.changed).toBe(true);
    expect(result.revision).toBe(1);
    expect(result.changedIndices).toHaveLength(width * height);
    expect(editor.undoDepth).toBe(1);
    expect(editor.exportHistory().undo.at(-1)?.kind).toBe('delta');
    expect(editor.historyBytes).toBeLessThanOrEqual(DEFAULT_HISTORY_LIMIT_BYTES);
    expect(editor.composite.kind[0]).toBe(CellKind.Full);
    expect(editor.composite.kind.at(-1)).toBe(CellKind.Full);

    const historyBytes = editor.historyBytes;
    const noOp = editor.execute(onDefaultLayers(bulkSetFullCommand(indices, 1)));
    expect(noOp.changed).toBe(false);
    expect(editor.undoDepth).toBe(1);
    expect(editor.historyBytes).toBe(historyBytes);
    expect(editor.undo().changed).toBe(true);
    expect(editor.composite.kind[0]).toBe(CellKind.Empty);
    expect(editor.composite.kind.at(-1)).toBe(CellKind.Empty);
    expect(editor.redo().changed).toBe(true);
    expect(editor.composite.kind[0]).toBe(CellKind.Full);
  });

  it('proves the packed 1,000 by 1,000 bulk path is one bounded undoable entry', () => {
    const side = 1_000;
    const cellCount = side * side;
    expect(cellCount).toBe(MAX_PERSISTABLE_CELL_COUNT);
    const indices = Uint32Array.from({ length: cellCount }, (_, index) => index);
    const editor = editorFromSurface(createDocument({ width: side, height: side, catalog: TEST_CATALOG, palette: [{ id: 1, name: 'Red', color: '#d33' }] }));
    const command = bulkSetFullCommand(indices, 1);

    const result = editor.execute(onDefaultLayers(command));
    expect(result.revision).toBe(1);
    expect(result.changedIndices).toBeInstanceOf(Uint32Array);
    expect(result.changedIndices).toHaveLength(cellCount);
    expect(editor.exportHistory().undo.at(-1)?.kind).toBe('delta');
    expect(editor.undoDepth).toBe(1);
    expect(editor.historyBytes).toBe(estimateBulkCellHistoryBytes(cellCount));
    expect(editor.historyBytes).toBeLessThanOrEqual(DEFAULT_HISTORY_LIMIT_BYTES);

    const historyBytes = editor.historyBytes;
    const noOp = editor.execute(onDefaultLayers(command));
    expect(noOp.changed).toBe(false);
    expect(editor.undoDepth).toBe(1);
    expect(editor.historyBytes).toBe(historyBytes);

    editor.undo();
    expect(editor.composite.kind[0]).toBe(CellKind.Empty);
    expect(editor.composite.kind.at(-1)).toBe(CellKind.Empty);
    expect(editor.redoDepth).toBe(1);
    editor.redo();
    expect(editor.composite.kind[0]).toBe(CellKind.Full);
    expect(editor.composite.kind.at(-1)).toBe(CellKind.Full);
  });

  it('rejects a 1,000 by 1,000 bulk entry over budget before mutation', () => {
    const side = 1_000;
    const cellCount = side * side;
    const requiredBytes = estimateBulkCellHistoryBytes(cellCount);
    const editor = editorFromSurface(createDocument({ width: side, height: side, catalog: TEST_CATALOG, palette: [{ id: 1, name: 'Red', color: '#d33' }] }), { historyLimitBytes: requiredBytes - 1 });
    const before = editor.composite;
    const command = bulkSetFullCommand(Uint32Array.from({ length: cellCount }, (_, index) => index), 1);

    expect(() => editor.execute(onDefaultLayers(command))).toThrow(/exceeding/);
    expect(editor.composite).toBe(before);
    expect(editor.composite.revision).toBe(0);
    expect(editor.composite.kind[0]).toBe(CellKind.Empty);
    expect(editor.composite.kind.at(-1)).toBe(CellKind.Empty);
    expect(editor.undoDepth).toBe(0);
    expect(editor.redoDepth).toBe(0);
    expect(editor.historyBytes).toBe(0);
  });

  it('records one batch entry, treats no-ops as inert, and never reuses IDs', () => {
    const editor = editorFromSurface(document());
    editor.execute(onDefaultLayers({ type: 'batch', commands: [
      { type: 'set-full', x: 0, y: 0, color: 1 },
      { type: 'set-full', x: 1, y: 0, color: 2 }
    ] }));
    expect(editor.undoDepth).toBe(1);
    expect(editor.composite.revision).toBe(1);
    editor.undo();
    expect(editor.composite.kind).toEqual(new Uint8Array(12));
    expect(editor.redoDepth).toBe(1);
    expect(editor.composite.revision).toBe(2);
    editor.redo();
    expect(editor.composite.revision).toBe(3);

    const noOp = editor.execute(onDefaultLayers({ type: 'set-full', x: 0, y: 0, color: 1 }));
    expect(noOp.changed).toBe(false);
    expect(editor.composite.revision).toBe(3);
    editor.execute(onDefaultLayers({ type: 'erase-cell', x: 0, y: 0 }));
    const added = editor.execute(onDefaultLayers({ type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 1 }));
    expect(added.backstitchId).toBe(1);
    editor.undo();
    const next = editor.execute(onDefaultLayers({ type: 'add-backstitch', start: { x: 0, y: 4 }, end: { x: 4, y: 4 }, color: 1 }));
    expect(next.backstitchId).toBe(2);
  });

  it('uses a packed sparse delta for a one-cell edit in a 1,000 by 1,000 pattern', () => {
    const pattern = createDocument({ width: 1000, height: 1000, catalog: TEST_CATALOG, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    const editor = editorFromSurface(pattern);
    editor.execute(onDefaultLayers({ type: 'set-full', x: 777, y: 888, color: 1 }));
    expect(editor.exportHistory().undo.at(-1)?.kind).toBe('delta');
    expect(editor.historyBytes).toBeLessThan(1024);
    expect(editor.historyBytes).toBeLessThan(pattern.kind.byteLength);
    editor.undo();
    expect(editor.composite.kind[888000 + 777]).toBe(CellKind.Empty);
    editor.redo();
    expect(editor.composite.kind[888000 + 777]).toBe(CellKind.Full);
  }, 15_000);

  it('rejects an oversized delta entry atomically', () => {
    const editor = editorFromSurface(document(), { historyLimitBytes: 55 });
    const before = editor.composite;
    expect(() => editor.execute(onDefaultLayers({ type: 'set-full', x: 0, y: 0, color: 1 }))).toThrow(DomainError);
    expect(() => editor.execute(onDefaultLayers({ type: 'set-full', x: 0, y: 0, color: 1 }))).toThrow(/History entry requires/);
    expect(editor.composite).toBe(before);
    expect(editor.composite.revision).toBe(0);
    expect(editor.undoDepth).toBe(0);
    expect(editor.redoDepth).toBe(0);
    expect(editor.historyBytes).toBe(0);
  });

  it('rejects an oversized snapshot entry atomically', () => {
    const editor = editorFromSurface(document(), { historyLimitBytes: 900 });
    const before = editor.composite;
    expect(() => editor.execute(onDefaultLayers({ type: 'palette-merge', from: 1, to: 2 }))).toThrow(DomainError);
    expect(editor.composite).toBe(before);
    expect(editor.composite.revision).toBe(0);
    expect(editor.undoDepth).toBe(0);
    expect(editor.redoDepth).toBe(0);
    expect(editor.historyBytes).toBe(0);
  });

  it('captures typed full, half, and quarter fragment cells without completion data', () => {
    let source = document(5, 3);
    source = apply(source, { type: 'set-full', x: 1, y: 0, color: 1 });
    source = markCellComplete(source, 1, 0);
    source = apply(source, { type: 'set-half', x: 2, y: 0, direction: HalfDirection.Slash, color: 2 });
    source = markCellComplete(source, 2, 0);
    source = apply(source, { type: 'set-quarter', x: 3, y: 0, corner: QuarterCorner.NW, color: 1 });
    source = apply(source, { type: 'set-quarter', x: 3, y: 0, corner: QuarterCorner.SE, color: 3 });
    source = markCellComplete(source, 3, 0, QuarterCorner.NW);
    source = markCellComplete(source, 3, 0, QuarterCorner.SE);
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
    expect(() => assertValidPatternFragment(fragment)).not.toThrow();
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
    source = markCellComplete(source, 0, 0);
    const fragment = createPatternFragment(source, { x: 0, y: 0, width: 1, height: 1 });
    expect(() => assertValidPatternFragment(fragment)).not.toThrow();
    expect(readPatternFragmentCell(fragment, 0, 0)).toMatchObject({ kind: CellKind.ThreeQuarterSE, colors: new Uint16Array([2, 0, 0, 0]) });

    const destination = applyCommand(document(2, 1), pasteFragmentCommand(fragment, { x: 1, y: 0 }));
    expect(destination.document.kind[1]).toBe(CellKind.ThreeQuarterSE);
    expect(destination.document.colors.slice(4, 8)).toEqual(new Uint16Array([2, 0, 0, 0]));
    expect(destination.document.completed[1]).toBe(0);

    const invalid = { ...fragment, colors: new Uint16Array([2, 1, 0, 0]) };
    expect(() => assertValidPatternFragment(invalid)).toThrow();
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
    destination = markCellComplete(destination, 1, 1);
    destination = apply(destination, { type: 'set-half', x: 2, y: 1, direction: HalfDirection.Slash, color: 2 });
    destination = markCellComplete(destination, 2, 1);
    destination = apply(destination, { type: 'set-quarter', x: 3, y: 1, corner: QuarterCorner.NW, color: 1 });
    destination = apply(destination, { type: 'set-quarter', x: 3, y: 1, corner: QuarterCorner.SE, color: 3 });
    destination = markCellComplete(destination, 3, 1, QuarterCorner.NW);
    destination = markCellComplete(destination, 3, 1, QuarterCorner.SE);
    destination = apply(destination, { type: 'set-full', x: 1, y: 2, color: 3 });
    destination = apply(destination, { type: 'add-backstitch', start: { x: 0, y: 12 }, end: { x: 4, y: 12 }, color: 1 });
    const result = applyCommand(destination, pasteFragmentCommand(fragment, { x: 1, y: 1 }));
    expect(result.revision).toBe(destination.revision + 1);
    expect(result.createdBackstitchIds).toEqual(new Uint32Array([2]));
    expect(getCell(result.document, 1, 1)).toMatchObject({ kind: CellKind.Full, color: 1, completed: false });
    expect(getCell(result.document, 2, 1)).toMatchObject({ kind: CellKind.HalfSlash, color: 2, completed: false });
    expect(getCell(result.document, 3, 1).quarters[QuarterCorner.NW]).toMatchObject({ color: 1, completed: false });
    expect(getCell(result.document, 3, 1).quarters[QuarterCorner.SE]).toMatchObject({ color: 3, completed: false });
    expect(getCell(result.document, 1, 2)).toMatchObject({ kind: CellKind.Full, color: 3 });
    expect(listBackstitches(result.document)).toMatchObject([
      { id: 1, x1: 0, y1: 12, x2: 4, y2: 12, color: 1 },
      { id: 2, x1: 4, y1: 4, x2: 16, y2: 8, color: 2 }
    ]);
  });

  it('rejects malformed fragments, palette references, and placement atomically', () => {
    let source = document(2, 2);
    source = apply(source, { type: 'set-full', x: 0, y: 0, color: 1 });
    const fragment = createPatternFragment(source, { x: 0, y: 0, width: 2, height: 2 });
    const destinationEditor = editorFromSurface(document(4, 4));
    const before = destinationEditor.composite;

    const invalidPalette = { ...fragment, colors: fragment.colors.slice() } as PatternFragment;
    invalidPalette.colors[0] = 99;
    expect(() => destinationEditor.execute(onDefaultLayers(pasteFragmentCommand(invalidPalette, { x: 0, y: 0 })))).toThrow(/Palette/);
    expect(destinationEditor.composite).toBe(before);
    expect(destinationEditor.composite.revision).toBe(0);
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
    expect(() => destinationEditor.execute(onDefaultLayers(pasteFragmentCommand(invalidGeometry, { x: 0, y: 0 })))).toThrow(/fragment boundary/);
    expect(destinationEditor.composite).toBe(before);
    expect(() => destinationEditor.execute(onDefaultLayers(pasteFragmentCommand(fragment, { x: 3, y: 3 })))).toThrow(/fit entirely/);
    expect(destinationEditor.composite).toBe(before);
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
    const budgetEditor = editorFromSurface(document(4, 4), { historyLimitBytes: estimatePasteFragmentHistoryBytes(1, 0, 0) - 1 });
    const budgetBefore = budgetEditor.composite;
    expect(() => budgetEditor.execute(onDefaultLayers(pasteFragmentCommand(fragment, { x: 0, y: 0 })))).toThrow(/exceeding/);
    expect(budgetEditor.composite).toBe(budgetBefore);
    expect(budgetEditor.undoDepth).toBe(0);
    expect(() => assertValidPatternFragment(invalidGeometry)).toThrow();
    expect(() => assertValidPatternFragment(invalidGeometry)).toThrow(DomainError);
  });

  it('moves rectangular contents atomically across overlap while preserving completion and transparent holes', () => {
    let pattern = document(6, 3);
    pattern = apply(pattern, { type: 'set-full', x: 0, y: 0, color: 1 });
    pattern = markCellComplete(pattern, 0, 0);
    pattern = apply(pattern, { type: 'set-half', x: 1, y: 0, direction: HalfDirection.Slash, color: 2 });
    pattern = markCellComplete(pattern, 1, 0);
    pattern = apply(pattern, { type: 'set-full', x: 1, y: 1, color: 3 });
    pattern = apply(pattern, { type: 'set-full', x: 3, y: 1, color: 3 });
    const before = documentContentSnapshot(pattern);
    const editor = editorFromSurface(pattern);

    const result = editor.execute(onDefaultLayers(moveFragmentCommand(
      { kind: 'rect', rect: { x: 0, y: 0, width: 3, height: 1 } },
      { x: 1, y: 1 }
    )));

    expect(result.changed).toBe(true);
    expect(result.changedIndices).toEqual(new Uint32Array([0, 1, 7, 8]));
    expect(result.movedBackstitchIds).toEqual(new Uint32Array(0));
    expect(result.progress).toEqual({ cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0), marked: 0, unmarked: 0 });
    expect(result.recalculateMetrics).toBe(true);
    expect(editor.undoDepth).toBe(1);
    expect(getCell(editor.composite, 0, 0).kind).toBe(CellKind.Empty);
    expect(getCell(editor.composite, 1, 0).kind).toBe(CellKind.Empty);
    expect(getCell(editor.composite, 1, 1)).toMatchObject({ kind: CellKind.Full, color: 1, completed: true });
    expect(getCell(editor.composite, 2, 1)).toMatchObject({ kind: CellKind.HalfSlash, color: 2, completed: true });
    expect(getCell(editor.composite, 3, 1)).toMatchObject({ kind: CellKind.Full, color: 3 });

    editor.undo();
    expect(documentContentSnapshot(editor.composite)).toEqual(before);
    editor.redo();
    expect(getCell(editor.composite, 1, 1)).toMatchObject({ kind: CellKind.Full, color: 1, completed: true });
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
    const forwardEditor = editorFromSurface(forward);
    forwardEditor.execute(onDefaultLayers(moveFragmentCommand({ kind: 'rect', rect: { x: 0, y: 0, width: 3, height: 1 } }, { x: 1, y: 0 })));
    expect([0, 1, 2, 3, 4].map((x) => getCell(forwardEditor.composite, x, 0).color)).toEqual([0, 1, 2, 3, 0]);

    let reverse = document(5, 1);
    reverse = apply(reverse, { type: 'set-full', x: 1, y: 0, color: 1 });
    reverse = apply(reverse, { type: 'set-full', x: 2, y: 0, color: 2 });
    reverse = apply(reverse, { type: 'set-full', x: 3, y: 0, color: 3 });
    const reverseEditor = editorFromSurface(reverse);
    reverseEditor.execute(onDefaultLayers(moveFragmentCommand({ kind: 'rect', rect: { x: 1, y: 0, width: 3, height: 1 } }, { x: 0, y: 0 })));
    expect([0, 1, 2, 3, 4].map((x) => getCell(reverseEditor.composite, x, 0).color)).toEqual([1, 2, 3, 0, 0]);

    const sparseEditor = editorFromSurface(forward);
    sparseEditor.execute(onDefaultLayers(moveFragmentCommand({ kind: 'sparse', rect: { x: 0, y: 0, width: 3, height: 1 }, indices: new Uint32Array([0, 2]) }, { x: 1, y: 0 })));
    expect([0, 1, 2, 3, 4].map((x) => getCell(sparseEditor.composite, x, 0).color)).toEqual([0, 1, 0, 3, 0]);

    const reverseSparse = editorFromSurface(reverse);
    reverseSparse.execute(onDefaultLayers(moveFragmentCommand({ kind: 'sparse', rect: { x: 1, y: 0, width: 3, height: 1 }, indices: new Uint32Array([1, 3]) }, { x: 0, y: 0 })));
    expect([0, 1, 2, 3, 4].map((x) => getCell(reverseSparse.composite, x, 0).color)).toEqual([1, 0, 3, 0, 0]);
  });

  it('moves sparse cells without overwriting destination holes or selected empties', () => {
    let pattern = document(6, 3);
    pattern = apply(pattern, { type: 'set-full', x: 0, y: 0, color: 1 });
    pattern = apply(pattern, { type: 'set-half', x: 2, y: 0, direction: HalfDirection.Backslash, color: 2 });
    pattern = apply(pattern, { type: 'set-full', x: 4, y: 1, color: 3 });
    const editor = editorFromSurface(pattern);
    const result = editor.execute(onDefaultLayers(moveFragmentCommand(
      { kind: 'sparse', rect: { x: 0, y: 0, width: 3, height: 1 }, indices: new Uint32Array([0, 2]) },
      { x: 3, y: 1 }
    )));

    expect(result.changedIndices).toEqual(new Uint32Array([0, 2, 9, 11]));
    expect(getCell(editor.composite, 0, 0).kind).toBe(CellKind.Empty);
    expect(getCell(editor.composite, 2, 0).kind).toBe(CellKind.Empty);
    expect(getCell(editor.composite, 3, 1)).toMatchObject({ kind: CellKind.Full, color: 1 });
    expect(getCell(editor.composite, 4, 1)).toMatchObject({ kind: CellKind.Full, color: 3 });
    expect(getCell(editor.composite, 5, 1)).toMatchObject({ kind: CellKind.HalfBackslash, color: 2 });
  });

  it('moves contained backstitches with stable identity and retains boundary-crossing lines', () => {
    let pattern = document(8, 4);
    pattern = apply(pattern, { type: 'set-full', x: 1, y: 1, color: 1 });
    pattern = apply(pattern, { type: 'set-full', x: 2, y: 1, color: 2 });
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 4, y: 4 }, end: { x: 8, y: 4 }, color: 1 });
    pattern = markBackstitchComplete(pattern, 1);
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 0, y: 4 }, end: { x: 8, y: 8 }, color: 2 });
    pattern = markBackstitchComplete(pattern, 2);
    const nextId = pattern.nextBackstitchId;
    const editor = editorFromSurface(pattern);
    const result = editor.execute({
      ...moveFragmentCommand({ kind: 'rect', rect: { x: 1, y: 1, width: 2, height: 1 } }, { x: 4, y: 1 }),
      layerId: SPECIALTY_LAYER_ID
    });

    expect(result.movedBackstitchIds).toEqual(new Uint32Array([1]));
    expect(editor.composite.nextBackstitchId).toBe(nextId);
    expect(listBackstitches(editor.composite)).toMatchObject([
      { id: 1, x1: 16, y1: 4, x2: 20, y2: 4, color: 1, completed: true },
      { id: 2, x1: 0, y1: 4, x2: 8, y2: 8, color: 2, completed: true }
    ]);
    editor.undo();
    expect(listBackstitches(editor.composite)).toMatchObject([
      { id: 1, x1: 4, y1: 4, x2: 8, y2: 4, color: 1, completed: true },
      { id: 2, x1: 0, y1: 4, x2: 8, y2: 8, color: 2, completed: true }
    ]);
    editor.redo();
    expect(listBackstitches(editor.composite)[0]).toMatchObject({ id: 1, x1: 16, x2: 20, completed: true });
  });

  it('rejects move collisions, bounds, palette, and history failures atomically', () => {
    let pattern = document(6, 3);
    pattern = apply(pattern, { type: 'set-full', x: 0, y: 0, color: 1 });
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 1 });
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 12, y: 0 }, end: { x: 16, y: 0 }, color: 2 });
    const collision = editorFromSurface(pattern);
    const collisionBefore = documentContentSnapshot(collision.composite);
    expect(() => collision.execute(onDefaultLayers(moveFragmentCommand({ kind: 'rect', rect: { x: 0, y: 0, width: 1, height: 1 } }, { x: 3, y: 0 })))).toThrow(/collides/);
    expect(documentContentSnapshot(collision.composite)).toEqual(collisionBefore);
    expect(collision.undoDepth).toBe(0);

    const bounds = editorFromSurface(pattern);
    const boundsBefore = bounds.composite;
    expect(() => bounds.execute(onDefaultLayers(moveFragmentCommand({ kind: 'rect', rect: { x: 0, y: 0, width: 2, height: 1 } }, { x: 5, y: 0 })))).toThrow(/fit entirely/);
    expect(bounds.composite).toBe(boundsBefore);

    const palette = editorFromSurface(pattern);
    const paletteBefore = palette.composite;
    palette.composite.palette.length = 0;
    expect(() => palette.execute(onDefaultLayers(moveFragmentCommand({ kind: 'rect', rect: { x: 0, y: 0, width: 1, height: 1 } }, { x: 1, y: 0 })))).toThrow(/Palette/);
    expect(palette.composite).toBe(paletteBefore);

    const budget = editorFromSurface(pattern, { historyLimitBytes: estimateMoveFragmentHistoryBytes(2, 2, 2) - 1 });
    const budgetBefore = budget.composite;
    expect(() => budget.execute(onDefaultLayers(moveFragmentCommand({ kind: 'rect', rect: { x: 0, y: 0, width: 1, height: 1 } }, { x: 1, y: 1 })))).toThrow(/exceeding/);
    expect(budget.composite).toBe(budgetBefore);
    expect(budget.undoDepth).toBe(0);
  });

  it('treats same-position moves as no-ops without history', () => {
    let pattern = document(4, 3);
    pattern = apply(pattern, { type: 'set-full', x: 1, y: 1, color: 1 });
    const editor = editorFromSurface(pattern);
    const before = editor.composite;
    const result = editor.execute({ ...moveFragmentCommand({ kind: 'rect', rect: { x: 1, y: 1, width: 1, height: 1 } }, { x: 1, y: 1 }), layerId: STITCH_LAYER_ID });
    expect(result.changed).toBe(false);
    expect(result.changedIndices).toEqual(new Uint32Array(0));
    expect(result.movedBackstitchIds).toEqual(new Uint32Array(0));
    expect(editor.composite).toBe(before);
    expect(editor.undoDepth).toBe(0);
  });

  it('treats a different-position transparent move as a no-op', () => {
    const editor = editorFromSurface(document(6, 4));
    const before = editor.composite;
    const result = editor.execute({ ...moveFragmentCommand({ kind: 'rect', rect: { x: 0, y: 0, width: 2, height: 2 } }, { x: 3, y: 2 }), layerId: STITCH_LAYER_ID });
    expect(result.changed).toBe(false);
    expect(result.changedIndices).toEqual(new Uint32Array(0));
    expect(result.progress).toEqual({ cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0), marked: 0, unmarked: 0 });
    expect(result.recalculateMetrics).toBeUndefined();
    expect(editor.composite).toBe(before);
    expect(editor.undoDepth).toBe(0);
  });

  it('accounts exactly for backstitch history and supports backstitch-only undo/redo', () => {
    let pattern = document(8, 3);
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 1 });
    const editor = editorFromSurface(pattern);
    const result = editor.execute(onDefaultLayers(moveFragmentCommand({ kind: 'rect', rect: { x: 0, y: 0, width: 1, height: 1 } }, { x: 3, y: 0 })));
    expect(result.changedIndices).toEqual(new Uint32Array(0));
    expect(result.movedBackstitchIds).toEqual(new Uint32Array([1]));
    expect(result.progress).toEqual({ cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0), marked: 0, unmarked: 0 });
    expect(result.recalculateMetrics).toBe(true);
    expect(editor.historyBytes).toBe(estimateMoveFragmentHistoryBytes(0, 1, 1));
    const moved = listBackstitches(editor.composite);
    expect(moved[0]).toMatchObject({ x1: 12, y1: 0, x2: 16, y2: 0 });
    const undo = editor.undo();
    expect(undo.changedIndices).toEqual(new Uint32Array(0));
    expect(undo.progress).toEqual({ cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0), marked: 0, unmarked: 0 });
    expect(undo.recalculateMetrics).toBe(true);
    expect(listBackstitches(editor.composite)[0]).toMatchObject({ x1: 0, y1: 0, x2: 4, y2: 0 });
    const redo = editor.redo();
    expect(redo.changedIndices).toEqual(new Uint32Array(0));
    expect(redo.recalculateMetrics).toBe(true);
    expect(listBackstitches(editor.composite)[0]).toMatchObject({ x1: 12, y1: 0, x2: 16, y2: 0 });
  });

  it('preserves completed overwrite metrics and zero activity across move undo and redo', () => {
    let pattern = document(4, 2);
    pattern = apply(pattern, { type: 'set-full', x: 0, y: 0, color: 1 });
    pattern = markCellComplete(pattern, 0, 0);
    pattern = apply(pattern, { type: 'set-full', x: 1, y: 0, color: 2 });
    const editor = editorFromSurface(pattern);
    const metrics = (value: PatternDocument) => {
      const computed = computePatternMetrics(value);
      return {
        totals: computed.totals,
        progress: computed.progress,
        materials: computed.materials.map((material) => ({ paletteId: material.paletteId, stitchUnits: material.stitchUnits, estimatedLength: material.estimatedLength }))
      };
    };
    const beforeMetrics = metrics(editor.composite);
    const result = editor.execute(onDefaultLayers(moveFragmentCommand({ kind: 'rect', rect: { x: 0, y: 0, width: 1, height: 1 } }, { x: 1, y: 0 })));
    const afterMetrics = metrics(editor.composite);
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
    expect(metrics(editor.composite)).toEqual(beforeMetrics);
    const redo = editor.redo();
    expect(redo.changedIndices).toEqual(new Uint32Array([0, 1]));
    expect(redo.progress).toEqual({ cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0), marked: 0, unmarked: 0 });
    expect(redo.recalculateMetrics).toBe(true);
    expect(metrics(editor.composite)).toEqual(afterMetrics);
  });

  it('rejects representative large dense and sparse moves before packed history-state allocation', () => {
    const side = 1000;
    const densePattern = document(side, side);
    densePattern.kind[0] = CellKind.Full;
    densePattern.colors[0] = 1;
    const denseEditor = editorFromSurface(densePattern, { historyLimitBytes: 1 });
    const denseBefore = denseEditor.composite;
    expect(() => denseEditor.execute(onDefaultLayers(moveFragmentCommand(
      { kind: 'rect', rect: { x: 0, y: 0, width: side - 1, height: side } },
      { x: 1, y: 0 }
    )))).toThrow(/exceeding/);
    expect(denseEditor.composite).toBe(denseBefore);
    expect(denseEditor.undoDepth).toBe(0);

    const sparseIndices = new Uint32Array(50_000);
    for (let position = 0; position < sparseIndices.length; position += 1) sparseIndices[position] = position * 2;
    const sparsePattern = document(side, side);
    sparsePattern.kind[0] = CellKind.Full;
    sparsePattern.colors[0] = 1;
    const sparseEditor = editorFromSurface(sparsePattern, { historyLimitBytes: 1 });
    const sparseBefore = sparseEditor.composite;
    expect(() => sparseEditor.execute(onDefaultLayers(moveFragmentCommand(
      { kind: 'sparse', rect: { x: 0, y: 0, width: side, height: 100 }, indices: sparseIndices },
      { x: 0, y: 1 }
    )))).toThrow(/exceeding/);
    expect(sparseEditor.composite).toBe(sparseBefore);
    expect(sparseEditor.undoDepth).toBe(0);
  });

  it('keeps a large sparse fragment paste within a bounded packed history entry', () => {
    const side = 500;
    let source = document(side, side);
    source = apply(source, { type: 'set-full', x: side - 1, y: side - 1, color: 1 });
    const fragment = createPatternFragment(source, { x: 0, y: 0, width: side, height: side });
    const editor = editorFromSurface(document(side, side));
    const result = editor.execute(onDefaultLayers(pasteFragmentCommand(fragment, { x: 0, y: 0 })));

    expect(result.changed).toBe(true);
    expect(result.changedIndices).toHaveLength(1);
    expect(result.revision).toBe(1);
    expect(editor.undoDepth).toBe(1);
    expect(editor.exportHistory().undo.at(-1)?.kind).toBe('delta');
    expect(editor.historyBytes).toBe(estimatePasteFragmentHistoryBytes(1, 0, 0));
    expect(editor.historyBytes).toBeLessThanOrEqual(DEFAULT_HISTORY_LIMIT_BYTES);
    editor.undo();
    expect(editor.composite.kind.at(-1)).toBe(CellKind.Empty);
  });

  it('erases mixed whole-cell and quarter targets as one packed undoable command', () => {
    let pattern = document(4, 2);
    pattern = apply(pattern, { type: 'set-full', x: 0, y: 0, color: 1 });
    pattern = markCellComplete(pattern, 0, 0);
    pattern = apply(pattern, { type: 'set-quarter', x: 1, y: 0, corner: QuarterCorner.NW, color: 2 });
    pattern = markCellComplete(pattern, 1, 0, QuarterCorner.NW);
    pattern = apply(pattern, { type: 'set-quarter', x: 2, y: 0, corner: QuarterCorner.NE, color: 3 });
    pattern = apply(pattern, { type: 'set-quarter', x: 2, y: 0, corner: QuarterCorner.SW, color: 1 });
    pattern = apply(pattern, { type: 'set-quarter', x: 2, y: 0, corner: QuarterCorner.SE, color: 2 });
    pattern = markCellComplete(pattern, 2, 0);
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 0, y: 4 }, end: { x: 4, y: 8 }, color: 2 });
    const beforePalette = pattern.palette.map((entry) => ({ ...entry }));
    const editor = editorFromSurface(pattern);
    const command = mixedEraseCommand(
      new Uint32Array([0]),
      new Uint32Array([1, 1, 2, 2]),
      new Uint8Array([QuarterCorner.NW, QuarterCorner.NE, QuarterCorner.NE, QuarterCorner.SW])
    );

    const result = editor.execute(onDefaultLayers(command));
    expect(result.changed).toBe(true);
    expect(result.changedIndices).toEqual(new Uint32Array([0, 1, 2]));
    expect(result.revision).toBe(pattern.revision + 1);
    expect(editor.undoDepth).toBe(1);
    expect(editor.exportHistory().undo.at(-1)?.kind).toBe('delta');
    expect(editor.historyBytes).toBe(estimateMixedEraseHistoryBytes(3));
    expect(getCell(editor.composite, 0, 0).kind).toBe(CellKind.Empty);
    expect(getCell(editor.composite, 0, 0).completed).toBe(false);
    expect(getCell(editor.composite, 1, 0).kind).toBe(CellKind.Empty);
    expect(getCell(editor.composite, 2, 0)).toMatchObject({ kind: CellKind.Quarters, completed: false });
    expect(getCell(editor.composite, 2, 0).quarters[QuarterCorner.NE]).toMatchObject({ color: 0, completed: false });
    expect(getCell(editor.composite, 2, 0).quarters[QuarterCorner.SW]).toMatchObject({ color: 0, completed: false });
    expect(getCell(editor.composite, 2, 0).quarters[QuarterCorner.SE]).toMatchObject({ color: 2, completed: true });
    expect(listBackstitches(editor.composite)).toMatchObject([
      { id: 1, x1: 0, y1: 4, x2: 4, y2: 8, color: 2 }
    ]);
    expect(editor.composite.palette).toEqual(beforePalette);
    expect(editor.composite.nextBackstitchId).toBe(pattern.nextBackstitchId);
    expect(editor.composite.nextPaletteId).toBe(pattern.nextPaletteId);

    editor.undo();
    expect(editor.undoDepth).toBe(0);
    expect(editor.redoDepth).toBe(1);
    expect(editor.composite.kind).toEqual(pattern.kind);
    expect(editor.composite.colors).toEqual(pattern.colors);
    expect(editor.composite.completed).toEqual(pattern.completed);
    expect(listBackstitches(editor.composite)).toMatchObject(listBackstitches(pattern));
    editor.redo();
    expect(editor.composite.kind[0]).toBe(CellKind.Empty);
    expect(editor.composite.kind[1]).toBe(CellKind.Empty);
    const added = editor.execute(onDefaultLayers({ type: 'add-backstitch', start: { x: 8, y: 0 }, end: { x: 12, y: 0 }, color: 3 }));
    expect(added.backstitchId).toBe(2);
  });

  it('treats absent whole cells as no-ops without creating history', () => {
    const editor = editorFromSurface(document(2, 2));
    const before = editor.composite;
    const result = editor.execute(onDefaultLayers(mixedEraseCommand(new Uint32Array([3]), new Uint32Array(), new Uint8Array())));

    expect(result.changed).toBe(false);
    expect(editor.composite).toBe(before);
    expect(editor.composite.revision).toBe(0);
    expect(editor.undoDepth).toBe(0);
    expect(editor.redoDepth).toBe(0);
    expect(editor.historyBytes).toBe(0);
  });

  it('deletes selected cells and only backstitches whose endpoints are inside the inclusive region bounds', () => {
    let pattern = document(5, 4);
    pattern = apply(pattern, { type: 'set-full', x: 1, y: 1, color: 1 });
    pattern = markCellComplete(pattern, 1, 1);
    pattern = apply(pattern, { type: 'set-quarter', x: 2, y: 2, corner: QuarterCorner.SE, color: 2 });
    pattern = markCellComplete(pattern, 2, 2, QuarterCorner.SE);
    pattern = apply(pattern, { type: 'set-full', x: 4, y: 3, color: 3 });
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 4, y: 4 }, end: { x: 12, y: 8 }, color: 1 });
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 0, y: 4 }, end: { x: 12, y: 12 }, color: 2 });
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 4, y: 4 }, end: { x: 16, y: 12 }, color: 3 });
    const editor = editorFromSurface(pattern);

    const direct = applyCommand(pattern, deleteRegionCommand({ x: 1, y: 1, width: 2, height: 2 }, pattern.revision));
    expect(direct.changedIndices).toEqual(new Uint32Array([6, 12]));
    expect(direct.changedBackstitchIds).toEqual(new Uint32Array([1]));

    const result = editor.execute(onDefaultLayers(deleteRegionCommand({ x: 1, y: 1, width: 2, height: 2 }, editor.revision)));
    expect(result.changed).toBe(true);
    expect(editor.composite.kind[6]).toBe(CellKind.Empty);
    expect(editor.composite.completed[12]).toBe(0);
    expect(editor.composite.kind[19]).toBe(CellKind.Full);
    expect(listBackstitches(editor.composite).map((line) => line.id)).toEqual([2, 3]);
    expect(editor.undoDepth).toBe(1);

    editor.undo();
    expect(editor.composite.kind[6]).toBe(CellKind.Full);
    expect(editor.composite.completed[6]).toBe(1);
    expect(listBackstitches(editor.composite).map((line) => line.id)).toEqual([1, 2, 3]);
    editor.redo();
    expect(listBackstitches(editor.composite).map((line) => line.id)).toEqual([2, 3]);
    expect(editor.composite.nextBackstitchId).toBe(4);
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
    pattern = markCellComplete(pattern, 1, 0);
    pattern = apply(pattern, { type: 'set-half', x: 2, y: 0, direction: HalfDirection.Slash, color: 1 });
    pattern = apply(pattern, { type: 'set-quarter', x: 1, y: 1, corner: QuarterCorner.NE, color: 1 });
    pattern = apply(pattern, { type: 'set-quarter', x: 1, y: 1, corner: QuarterCorner.SW, color: 1 });
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 4, y: 0 }, end: { x: 12, y: 4 }, color: 1 });
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 1 });
    const editor = editorFromSurface(pattern);
    const before = editor.composite;
    const beforeContent = documentContentSnapshot(before);

    const deleted = editor.execute(onDefaultLayers(deleteRegionCommand({ x: 1, y: 0, width: 2, height: 2 }, editor.revision)));
    expect(deleted.changed).toBe(true);
    expect(editor.composite.revision).toBe(before.revision + 1);
    expect(documentContentSnapshot(editor.composite)).toMatchObject({
      kind: expect.any(Uint8Array),
      colors: expect.any(Uint16Array),
      completed: expect.any(Uint8Array),
      nextBackstitchId: before.nextBackstitchId,
      nextPaletteId: before.nextPaletteId
    });
    expect(editor.composite.kind[1]).toBe(CellKind.Empty);
    expect(editor.composite.kind[2]).toBe(CellKind.Empty);
    expect(editor.composite.kind[5]).toBe(CellKind.Empty);
    expect(editor.composite.kind[6]).toBe(CellKind.Empty);
    expect(editor.composite.kind[11]).toBe(CellKind.Empty);
    expect(editor.composite.backstitches.ids).toEqual(new Uint32Array([2]));
    expect(editor.composite.palette).toEqual(before.palette);
    expect(editor.composite.settings).toBe(before.settings);
    assertValidDocument(editor.composite);
    const afterContent = documentContentSnapshot(editor.composite);

    const undone = editor.undo();
    expect(undone.revision).toBe(before.revision + 2);
    expect(documentContentSnapshot(editor.composite)).toEqual(beforeContent);
    expect(editor.composite.palette).toBe(before.palette);
    expect(editor.composite.settings).toBe(before.settings);
    assertValidDocument(editor.composite);

    const redone = editor.redo();
    expect(redone.revision).toBe(before.revision + 3);
    expect(documentContentSnapshot(editor.composite)).toEqual(afterContent);
    expect(editor.composite.palette).toBe(before.palette);
    expect(editor.composite.settings).toBe(before.settings);
    assertValidDocument(editor.composite);
  });

  it('keeps prior delete generations immutable while later edits use new planes', () => {
    let pattern = document(4, 2);
    pattern = apply(pattern, { type: 'set-full', x: 0, y: 0, color: 1 });
    pattern = apply(pattern, { type: 'set-half', x: 1, y: 0, direction: HalfDirection.Backslash, color: 2 });
    const editor = editorFromSurface(pattern);
    const preDelete = editor.composite;
    const preDeleteContent = documentContentSnapshot(preDelete);

    editor.execute(onDefaultLayers(deleteRegionCommand({ x: 0, y: 0, width: 2, height: 1 }, editor.revision)));
    const postDelete = editor.composite;
    const postDeleteContent = documentContentSnapshot(postDelete);
    expect(postDelete.kind).not.toBe(preDelete.kind);
    expect(postDelete.colors).not.toBe(preDelete.colors);
    expect(postDelete.completed).not.toBe(preDelete.completed);
    expect(preDelete.kind[0]).toBe(CellKind.Full);
    expect(preDelete.kind[1]).toBe(CellKind.HalfBackslash);

    editor.undo();
    const postUndo = editor.composite;
    expect(postUndo.kind).not.toBe(postDelete.kind);
    expect(postUndo.colors).not.toBe(postDelete.colors);
    expect(postUndo.completed).not.toBe(postDelete.completed);
    const postUndoContent = documentContentSnapshot(postUndo);
    expect(documentContentSnapshot(preDelete)).toEqual(preDeleteContent);
    expect(documentContentSnapshot(postDelete)).toEqual(postDeleteContent);

    editor.redo();
    editor.execute(onDefaultLayers({ type: 'set-full', x: 3, y: 1, color: 3 }));
    expect(documentContentSnapshot(preDelete)).toEqual(preDeleteContent);
    expect(documentContentSnapshot(postDelete)).toEqual(postDeleteContent);
    expect(documentContentSnapshot(postUndo)).toEqual(postUndoContent);
  });

  it('keeps delete no-ops, stale revisions, and budget failures atomic', () => {
    const noOpEditor = editorFromSurface(document(3, 3));
    const noOpBefore = noOpEditor.composite;
    const noOp = noOpEditor.execute(onDefaultLayers(deleteRegionCommand({ x: 0, y: 0, width: 3, height: 3 }, noOpEditor.revision)));
    expect(noOp.changed).toBe(false);
    expect(noOpEditor.composite).toBe(noOpBefore);
    expect(noOpEditor.revision).toBe(0);
    expect(noOpEditor.undoDepth).toBe(0);
    expect(noOpEditor.historyBytes).toBe(0);

    expect(() => noOpEditor.execute(onDefaultLayers(deleteRegionCommand({ x: 0, y: 0, width: 1, height: 1 }, 1)))).toThrow(/revision/i);
    expect(noOpEditor.composite).toBe(noOpBefore);
    expect(noOpEditor.revision).toBe(0);
    expect(noOpEditor.undoDepth).toBe(0);

    const occupied = apply(document(3, 3), { type: 'set-full', x: 1, y: 1, color: 1 });
    const budgetEditor = editorFromSurface(occupied, { historyLimitBytes: estimateDeleteRegionHistoryBytes(1) - 1 });
    const budgetBefore = budgetEditor.composite;
    const budgetBeforeContent = documentContentSnapshot(budgetBefore);
    expect(() => budgetEditor.execute(onDefaultLayers(deleteRegionCommand({ x: 1, y: 1, width: 1, height: 1 }, budgetEditor.revision)))).toThrow(/exceeding/);
    expect(budgetEditor.composite).toBe(budgetBefore);
    expect(documentContentSnapshot(budgetEditor.composite)).toEqual(budgetBeforeContent);
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

    const editor = editorFromSurface(pattern);
    const beforeDocument = editor.composite;
    const before = documentContentSnapshot(editor.composite);
    const deleted = editor.execute(onDefaultLayers(deleteRegionCommand({ x: 0, y: 0, width: side, height: side }, editor.revision)));
    expect(deleted.changed).toBe(true);
    expect(deleted.changedIndices).toHaveLength(cellCount);
    expect(editor.historyBytes).toBe(estimateDeleteRegionHistoryBytes(cellCount));
    expect(editor.undoDepth).toBe(1);
    expect(editor.composite.kind).toEqual(new Uint8Array(cellCount));
    expect(editor.composite.colors).toEqual(new Uint16Array(cellCount * 4));
    expect(editor.composite.completed).toEqual(new Uint8Array(cellCount));
    expect(editor.composite.palette).toBe(beforeDocument.palette);
    expect(editor.composite.settings).toBe(beforeDocument.settings);
    assertValidDocument(editor.composite);
    const after = documentContentSnapshot(editor.composite);

    editor.undo();
    expect(editor.composite.revision).toBe(2);
    expect(documentContentSnapshot(editor.composite)).toEqual(before);
    assertValidDocument(editor.composite);

    editor.redo();
    expect(editor.composite.revision).toBe(3);
    expect(documentContentSnapshot(editor.composite)).toEqual(after);
    assertValidDocument(editor.composite);
  });

  it('preflights delete-region history before changing the document', () => {
    const pattern = document(4, 4);
    const source = editorFromSurface(pattern);
    source.execute(onDefaultLayers({ type: 'set-full', x: 1, y: 1, color: 1 }));
    source.execute(onDefaultLayers({ type: 'add-backstitch', start: { x: 4, y: 4 }, end: { x: 8, y: 8 }, color: 1 }));
    source.clearHistory();
    const required = estimateDeleteRegionHistoryBytes(1, 1, 1);
    const editor = editorFromSurface(source.composite, { historyLimitBytes: required - 1 });
    const before = editor.composite;
    expect(() => editor.execute(onDefaultLayers(deleteRegionCommand({ x: 1, y: 1, width: 1, height: 1 }, editor.revision)))).toThrow(/exceeding/);
    expect(editor.composite).toBe(before);
    expect(editor.composite.kind[5]).toBe(CellKind.Full);
    expect(editor.composite.backstitches.ids).toEqual(new Uint32Array([1]));
    expect(editor.revision).toBe(source.revision);
    expect(editor.undoDepth).toBe(0);
  });

  it('rejects invalid mixed erase targets atomically', () => {
    let pattern = document(2, 2);
    pattern = apply(pattern, { type: 'set-full', x: 0, y: 0, color: 1 });
    pattern = apply(pattern, { type: 'set-quarter', x: 1, y: 0, corner: QuarterCorner.NW, color: 1 });
    const editor = editorFromSurface(pattern);
    const before = editor.composite;
    const reject = (command: Parameters<typeof editor.execute>[0], message: RegExp) => {
      expect(() => editor.execute(onDefaultLayers(command))).toThrow(message);
      expect(editor.composite).toBe(before);
      expect(editor.composite.revision).toBe(pattern.revision);
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
    const editor = editorFromSurface(pattern, { historyLimitBytes: requiredBytes - 1 });
    const before = editor.composite;

    expect(() => editor.execute(onDefaultLayers(mixedEraseCommand(new Uint32Array([0]), new Uint32Array(), new Uint8Array())))).toThrow(/exceeding/);
    expect(editor.composite).toBe(before);
    expect(editor.composite.kind[0]).toBe(CellKind.Full);
    expect(editor.composite.revision).toBe(pattern.revision);
    expect(editor.undoDepth).toBe(0);
    expect(editor.historyBytes).toBe(0);
  });

  it('validates invariants and exposes a boolean validator', () => {
    const pattern = document();
    expect(() => assertValidDocument(pattern)).not.toThrow();
    pattern.kind[0] = CellKind.Full;
    expect(() => assertValidDocument(pattern)).toThrow();
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
    expect(() => assertValidPatternFragment(fragment)).not.toThrow();

    let destination = document(3, 1);
    destination = apply(destination, { type: 'set-full', x: 1, y: 0, color: 3 });
    const pasted = applyCommand(destination, pasteFragmentCommand(fragment, { x: 0, y: 0 }));
    expect(pasted.document.kind).toEqual(new Uint8Array([CellKind.Full, CellKind.Full, CellKind.Full]));
    expect(pasted.document.colors).toEqual(new Uint16Array([1, 0, 0, 0, 3, 0, 0, 0, 2, 0, 0, 0]));
  });

  it('deletes sparse cells and contained backstitches as one undoable delta', () => {
    let pattern = document(4, 1);
    pattern = apply(pattern, { type: 'set-full', x: 1, y: 0, color: 1 });
    pattern = markCellComplete(pattern, 1, 0);
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
    const editor = editorFromSurface(pattern);
    editor.clearHistory();
    const before = documentContentSnapshot(editor.composite);

    const result = editor.execute(onDefaultLayers(deleteCellSetCommand(new Uint32Array([1, 3]), editor.revision)));
    expect(result.changed).toBe(true);
    expect(editor.composite.kind).toEqual(new Uint8Array([CellKind.Empty, CellKind.Empty, CellKind.Full, CellKind.Empty]));
    expect(editor.composite.backstitches.ids).toEqual(new Uint32Array([2]));
    expect(editor.undoDepth).toBe(1);

    editor.undo();
    expect(documentContentSnapshot(editor.composite)).toEqual(before);
    editor.redo();
    expect(editor.composite.kind).toEqual(new Uint8Array([CellKind.Empty, CellKind.Empty, CellKind.Full, CellKind.Empty]));
    expect(editor.composite.backstitches.ids).toEqual(new Uint32Array([2]));

    const restored = new DocumentEditor(editor.document, { historyLimitBytes: editor.historyLimitBytes });
    restored.importHistory(editor.exportHistory());
    const restoredUndo = restored.undo();
    expect(restoredUndo.recalculateMetrics).toBe(true);
    expect(restoredUndo.progress).toEqual({ marked: 0, unmarked: 0, cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0) });
    expect(computePatternMetrics(restoredUndo.document).progress).toMatchObject({ completedComponents: 2 });
    const restoredRedo = restored.redo();
    expect(restoredRedo.progress).toEqual({ marked: 0, unmarked: 0, cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0) });
    expect(restoredRedo.recalculateMetrics).toBe(true);
    expect(computePatternMetrics(restoredRedo.document).progress).toMatchObject({ completedComponents: 1, remainingComponents: 1 });

    const direct = applyCommand(pattern, deleteCellSetCommand(new Uint32Array([1, 3]), pattern.revision));
    expect(direct.changed).toBe(true);
    expect(direct.changedIndices).toEqual(new Uint32Array([1, 3]));
    expect(direct.changedBackstitchIds).toEqual(new Uint32Array([1]));
    expect(direct.document.backstitches.ids).toEqual(new Uint32Array([2]));
  });

  it('rejects malformed sparse deletion atomically and keeps no-ops out of history', () => {
    const editor = editorFromSurface(document(2, 1));
    const before = editor.composite;
    expect(() => editor.execute(onDefaultLayers(deleteCellSetCommand(new Uint32Array())))).toThrow(/non-empty/);
    expect(() => editor.execute(onDefaultLayers(deleteCellSetCommand(new Uint32Array([1, 0]))))).toThrow(/strictly increasing/);
    expect(() => editor.execute(onDefaultLayers(deleteCellSetCommand(new Uint32Array([0, 0]))))).toThrow(/strictly increasing/);
    expect(() => editor.execute(onDefaultLayers({ type: 'delete-cell-set', indices: new Uint32Array([2]) }))).toThrow(/out of bounds/);
    expect(() => editor.execute(onDefaultLayers(deleteCellSetCommand(new Uint32Array([0]), 1)))).toThrow(/revision/i);
    expect(() => editor.execute({ type: 'batch', commands: [{ ...deleteCellSetCommand(new Uint32Array([0])), layerId: STITCH_LAYER_ID }, { type: 'set-full', x: 1, y: 0, color: 1, layerId: STITCH_LAYER_ID }] })).toThrow(/standalone/);
    expect(editor.composite).toBe(before);
    expect(editor.revision).toBe(0);
    expect(editor.undoDepth).toBe(0);
    expect(editor.historyBytes).toBe(0);

    const noOpEditor = editorFromSurface(document(2, 1));
    const noOpBefore = noOpEditor.composite;
    const noOp = noOpEditor.execute(onDefaultLayers(deleteCellSetCommand(new Uint32Array([0]), noOpEditor.revision)));
    expect(noOp.changed).toBe(false);
    expect(noOpEditor.composite).toBe(noOpBefore);
    expect(noOpEditor.undoDepth).toBe(0);
    expect(noOpEditor.historyBytes).toBe(0);
  });
});

describe('pattern background settings', () => {
  it('normalizes native color input, defaults to neutral Aida, clones, and validates', () => {
    const options = {
      width: 1,
      height: 1,
      catalog: TEST_CATALOG,
      settings: { symbolSet: 'default', materialUnit: MaterialUnit.Skeins, backgroundColor: '#a1b2c3' }
    };
    const pattern = createDocument(options);

    expect(pattern.settings.backgroundColor).toBe('#A1B2C3');
    expect(cloneDocument(pattern).settings).toEqual(pattern.settings);
    expect(createDocument({ width: 1, height: 1, catalog: TEST_CATALOG }).settings.backgroundColor).toBe('#F3EEE5');
    expect(() => createDocument({ ...options, settings: { ...options.settings, backgroundColor: 'red' } })).toThrow(/background color/i);
    expect(() => createDocument({ ...options, settings: { ...options.settings, backgroundColor: null as never } })).toThrow(/background color/i);

    const nonCanonical = {
      ...pattern,
      settings: { ...pattern.settings, backgroundColor: '#a1b2c3' }
    } as PatternDocument;
    expect(() => assertValidDocument(nonCanonical)).toThrow();
  });

  it('retains background color and settings identity across delta undo and redo', () => {
    const editor = editorFromSurface(createDocument({
      width: 1,
      height: 1,
      catalog: TEST_CATALOG,
      palette: [{ id: 1, name: 'Red', color: '#d33' }],
      settings: { backgroundColor: '#123456' }
    }));
    const settings = editor.composite.settings;

    editor.execute(onDefaultLayers({ type: 'set-full', x: 0, y: 0, color: 1 }));
    expect(editor.composite.settings).toBe(settings);
    expect(editor.composite.settings.backgroundColor).toBe('#123456');
    editor.undo();
    expect(editor.composite.settings).toBe(settings);
    expect(editor.composite.settings.backgroundColor).toBe('#123456');
    editor.redo();
    expect(editor.composite.settings).toBe(settings);
    expect(editor.composite.settings.backgroundColor).toBe('#123456');
  });

  it('accepts typed settings updates with validation, no-op detection, and delta undo/redo', () => {
    const editor = editorFromSurface(createDocument({
      width: 1,
      height: 1,
      catalog: TEST_CATALOG,
      settings: { backgroundColor: '#123456' }
    }));
    const update: DocumentSettingsUpdateCommand = {
      type: 'document-settings-update',
      settings: { backgroundColor: '#aabbcc' }
    };

    const changed = editor.execute(onDefaultLayers(update));
    expect(changed.changed).toBe(true);
    expect(editor.composite.settings.backgroundColor).toBe('#AABBCC');
    expect(editor.undoDepth).toBe(1);

    editor.undo();
    expect(editor.composite.settings.backgroundColor).toBe('#123456');
    editor.redo();
    expect(editor.composite.settings.backgroundColor).toBe('#AABBCC');

    const current = editor.composite;
    const noOp = editor.execute(onDefaultLayers({ type: 'document-settings-update', settings: { backgroundColor: '#aabbcc' } }));
    expect(noOp.changed).toBe(false);
    expect(editor.composite).toBe(current);
    expect(editor.undoDepth).toBe(1);
    expect(editor.redoDepth).toBe(0);

    expect(() => editor.execute(onDefaultLayers({ type: 'document-settings-update', settings: { backgroundColor: 'invalid' } }))).toThrow(/background color/i);
    expect(editor.composite).toBe(current);
    expect(editor.composite.settings.backgroundColor).toBe('#AABBCC');
  });

});

describe('palette symbol helpers', () => {
  it('accepts every generated pool slug', () => {
    for (const id of SYMBOL_IDS) expect(isKnownSymbolId(id)).toBe(true);
  });

  it('rejects anything the pool cannot draw', () => {
    // A former Unicode glyph is no longer valid: the pool owns every symbol, so
    // an unknown value must be refused rather than silently un-drawable.
    expect(isKnownSymbolId('\u25cf')).toBe(false);
    expect(isKnownSymbolId('1')).toBe(false);
    expect(isKnownSymbolId('')).toBe(false);
    expect(isKnownSymbolId(' ')).toBe(false);
  });

  it('is case sensitive, because slugs are lowercase by construction', () => {
    const [first] = SYMBOL_IDS;
    expect(isKnownSymbolId(first.toUpperCase())).toBe(first.toUpperCase() === first);
  });
});

describe('canvas mask enforcement', () => {
  // 4x3 with a hole at (1, 1): index 5.
  const HOLE = 5;

  function maskedDocument(): PatternDocument {
    const canvasMask = new Uint8Array(12).fill(1);
    canvasMask[HOLE] = 0;
    return { ...document(4, 3), canvasMask };
  }

  function thrownCode(run: () => unknown): string | undefined {
    try {
      run();
    } catch (error) {
      return error instanceof DomainError ? error.code : undefined;
    }
    return undefined;
  }

  it('drops single-cell writes to an inactive cell as unchanged no-ops', () => {
    const pattern = maskedDocument();
    for (const command of [
      { type: 'set-full', x: 1, y: 1, color: 1 },
      { type: 'set-half', x: 1, y: 1, direction: HalfDirection.Slash, color: 1 },
      { type: 'set-quarter', x: 1, y: 1, corner: QuarterCorner.NW, color: 1 },
      { type: 'set-three-quarter', x: 1, y: 1, corner: QuarterCorner.NW, color: 1 }
    ] as const) {
      const result = applyCommand(pattern, command);
      expect(result.changed, command.type).toBe(false);
      expect(result.document.kind[HOLE], command.type).toBe(CellKind.Empty);
    }
    const editor = editorFromSurface(pattern);
    const revision = editor.revision;
    editor.execute(onDefaultLayers({ type: 'set-full', x: 1, y: 1, color: 1 }));
    expect(editor.revision).toBe(revision);
    expect(editor.undoDepth).toBe(0);
    expect(applyCommand(pattern, { type: 'set-full', x: 0, y: 1, color: 1 }).changed).toBe(true);
  });

  it('paints only active cells in a bulk stroke across a hole and reports them as changed', () => {
    const pattern = maskedDocument();
    const indices = new Uint32Array([4, 5, 6]);
    const preflight = preflightBulkCellCommand(pattern, bulkSetFullCommand(indices, 1));
    expect(preflight.changedIndices).toEqual(new Uint32Array([4, 6]));
    const result = applyCommand(pattern, bulkSetFullCommand(indices, 1));
    expect(result.changedIndices).toEqual(new Uint32Array([4, 6]));
    expect(result.document.kind[4]).toBe(CellKind.Full);
    expect(result.document.kind[HOLE]).toBe(CellKind.Empty);
    expect(result.document.kind[6]).toBe(CellKind.Full);
  });

  it('respects the mask for every bulk fill style and a whole-document fill', () => {
    const pattern = maskedDocument();
    const all = new Uint32Array(12).map((_, index) => index);
    for (const command of [
      bulkSetFullCommand(all, 1),
      bulkSetHalfCommand(all, HalfDirection.Backslash, 1),
      bulkSetQuarterCommand(all, QuarterCorner.SE, 1),
      bulkSetThreeQuarterCommand(all, QuarterCorner.NE, 1)
    ]) {
      const result = applyCommand(pattern, command);
      expect(result.changedIndices?.length, command.type).toBe(11);
      expect(result.changedIndices).not.toContain(HOLE);
      expect(result.document.kind[HOLE]).toBe(CellKind.Empty);
      expect(result.document.colors.slice(HOLE * 4, HOLE * 4 + 4)).toEqual(new Uint16Array(4));
    }
    const unchanged = applyCommand(pattern, bulkSetFullCommand(new Uint32Array([HOLE]), 1));
    expect(unchanged.changed).toBe(false);
  });

  it('clips a paste to the active cells and lines that stay inside the canvas', () => {
    let source = document(2, 1);
    source = apply(source, { type: 'set-full', x: 0, y: 0, color: 1 });
    source = apply(source, { type: 'set-full', x: 1, y: 0, color: 2 });
    // A line along the top edge, and one through the middle of the row.
    source = apply(source, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 1 });
    source = apply(source, { type: 'add-backstitch', start: { x: 0, y: 2 }, end: { x: 8, y: 2 }, color: 2 });
    const fragment = createPatternFragment(source, { x: 0, y: 0, width: 2, height: 1 });

    const result = applyCommand(maskedDocument(), pasteFragmentCommand(fragment, { x: 0, y: 1 }));
    expect(result.changedIndices).toEqual(new Uint32Array([4]));
    expect(result.document.kind[4]).toBe(CellKind.Full);
    expect(result.document.kind[HOLE]).toBe(CellKind.Empty);
    expect(listBackstitches(result.document)).toMatchObject([{ x1: 0, y1: 4, x2: 4, y2: 4 }]);
    expect(result.createdBackstitchIds).toEqual(new Uint32Array([1]));
    assertValidDocument(result.document);
  });

  it('clips a move-fragment to the active cells and drops lines that would leave the canvas', () => {
    let pattern = maskedDocument();
    pattern = apply(pattern, { type: 'set-full', x: 0, y: 0, color: 1 });
    pattern = apply(pattern, { type: 'set-full', x: 1, y: 0, color: 2 });
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, color: 1 });
    pattern = apply(pattern, { type: 'add-backstitch', start: { x: 0, y: 2 }, end: { x: 8, y: 2 }, color: 2 });
    const [kept, doomed] = listBackstitches(pattern).map((record) => record.id);

    const move = moveFragmentCommand({ kind: 'rect', rect: { x: 0, y: 0, width: 2, height: 1 } }, { x: 0, y: 1 });
    const direct = applyCommand(pattern, move);
    expect(direct.changedIndices).toEqual(new Uint32Array([0, 1, 4]));
    expect(direct.movedBackstitchIds).toEqual(new Uint32Array([kept]));

    const editor = editorFromSurface(pattern);
    editor.execute(onDefaultLayers(move));
    expect(editor.composite.kind[0]).toBe(CellKind.Empty);
    expect(editor.composite.kind[1]).toBe(CellKind.Empty);
    expect(editor.composite.kind[4]).toBe(CellKind.Full);
    expect(editor.composite.kind[HOLE]).toBe(CellKind.Empty);
    expect(listBackstitches(editor.composite)).toMatchObject([{ id: kept, x1: 0, y1: 4, x2: 4, y2: 4 }]);
    expect(getBackstitch(editor.composite, doomed)).toBeUndefined();
    assertValidDocument(editor.composite);

    editor.undo();
    expect(listBackstitches(editor.composite).map((record) => record.id)).toEqual([kept, doomed]);
    expect(editor.composite.kind[0]).toBe(CellKind.Full);
  });

  it('refuses a backstitch that crosses a hole but allows one along its edge', () => {
    const pattern = maskedDocument();
    expect(thrownCode(() => applyCommand(pattern, { type: 'add-backstitch', start: { x: 0, y: 6 }, end: { x: 16, y: 6 }, color: 1 }))).toBe('outside-canvas');
    // The hole spans x 4..8, y 4..8; the cells above and below stay active.
    const top = applyCommand(pattern, { type: 'add-backstitch', start: { x: 4, y: 4 }, end: { x: 8, y: 4 }, color: 1 });
    expect(top.changed).toBe(true);
    const bottom = applyCommand(top.document, { type: 'add-backstitch', start: { x: 4, y: 8 }, end: { x: 8, y: 8 }, color: 1 });
    expect(bottom.changed).toBe(true);
    expect(thrownCode(() => applyCommand(pattern, { type: 'add-backstitch', start: { x: 5, y: 5 }, end: { x: 7, y: 7 }, color: 1 }))).toBe('outside-canvas');
  });

  it('refuses to move or update a backstitch into a hole', () => {
    const pattern = apply(maskedDocument(), { type: 'add-backstitch', start: { x: 0, y: 2 }, end: { x: 16, y: 2 }, color: 1 });
    const id = listBackstitches(pattern)[0].id;
    expect(thrownCode(() => applyCommand(pattern, { type: 'move-backstitch', id, dx: 0, dy: 4 }))).toBe('outside-canvas');
    expect(thrownCode(() => applyCommand(pattern, { type: 'update-backstitch', id, start: { x: 0, y: 6 }, end: { x: 16, y: 6 } }))).toBe('outside-canvas');
    expect(applyCommand(pattern, { type: 'move-backstitch', id, dx: 0, dy: -2 }).changed).toBe(true);
  });

  it('keeps the canvas fields through cloneDocument, and keeps them absent when absent', () => {
    const pattern = { ...maskedDocument(), originX: -3, originY: 2 };
    const copy = cloneDocument(pattern);
    expect(copy.canvasMask).toEqual(pattern.canvasMask);
    expect([copy.originX, copy.originY]).toEqual([-3, 2]);
    const plain = cloneDocument(document(2, 2));
    expect('canvasMask' in plain).toBe(false);
    expect('originX' in plain).toBe(false);
    expect('originY' in plain).toBe(false);
  });

  it('behaves as before when there is no mask', () => {
    const pattern = document(4, 3);
    expect(applyCommand(pattern, { type: 'add-backstitch', start: { x: 0, y: 6 }, end: { x: 16, y: 6 }, color: 1 }).changed).toBe(true);
    expect(applyCommand(pattern, { type: 'set-full', x: 1, y: 1, color: 1 }).changed).toBe(true);
  });
});
