import { describe, expect, it, vi } from 'vitest';
import { CellKind, cloneDocument, computePatternMetrics, createDocument, DocumentEditor, deleteRegionCommand, HalfDirection, layeredFromSurface, QuarterCorner, type CommandResult, type DomainCommand, type LayeredDocument, type PatternDocument } from '../domain';
import type { PersistencePreparationClient, ProjectMetadata, SaveResult } from '../persistence';
import { editorFromSurface, markBackstitchComplete, markCellComplete, onDefaultLayers, applyCommand, bulkRecolorCommand, bulkSetThreeQuarterCommand, createLayeredDocument } from '../domain/test-fixtures';
import { ProjectSession } from './session';
import { ProgressMetricsService } from './progress';
import type { WorkspaceRepository } from './types';
import { DEFAULT_CATALOG_DEFINITION } from '../catalog';

function metadata(id: string, revision: number): ProjectMetadata {
  return { id, title: 'Progress test', notes: '', createdAt: 1, updatedAt: 1, revision };
}

const testPreparationClient: PersistencePreparationClient = {
  prepare: async () => { throw new Error('Preparation was not expected in this legacy repository seam.'); },
  getRequestId: () => { throw new Error('Preparation was not expected in this legacy repository seam.'); },
  dispose: () => undefined
};

const longDebounceMs = 2_000_000_000;

function addBackstitch(document: PatternDocument, start: { x: number; y: number }, end: { x: number; y: number }, color: number, completed: boolean): PatternDocument {
  const added = applyCommand(document, { type: 'add-backstitch', start, end, color });
  if (!completed) return added.document;
  const id = added.backstitchId;
  if (id === undefined) throw new Error('Test backstitch ID was not allocated.');
  return markBackstitchComplete(added.document, id);
}

function mixedDeleteFixture(): { editor: DocumentEditor; rect: { x: number; y: number; width: number; height: number } } {
  let document = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association,
    width: 8,
    height: 6,
    palette: [
      { id: 1, name: 'Red', color: '#d33' },
      { id: 2, name: 'Blue', color: '#36c' },
      { id: 3, name: 'Gold', color: '#da2' }
    ]
  });
  const apply = (command: DomainCommand) => {
    document = applyCommand(document, command).document;
  };
  const rect = { x: 1, y: 1, width: 4, height: 3 };
  apply({ type: 'set-full', x: 1, y: 1, color: 1 });
  document = markCellComplete(document, 1, 1);
  apply({ type: 'set-half', x: 2, y: 1, direction: HalfDirection.Slash, color: 2 });
  document = markCellComplete(document, 2, 1);
  apply({ type: 'set-half', x: 3, y: 1, direction: HalfDirection.Backslash, color: 3 });
  apply({ type: 'set-quarter', x: 4, y: 1, corner: QuarterCorner.NW, color: 1 });
  document = markCellComplete(document, 4, 1, QuarterCorner.NW);
  apply({ type: 'set-quarter', x: 4, y: 1, corner: QuarterCorner.NE, color: 2 });
  apply({ type: 'set-quarter', x: 4, y: 1, corner: QuarterCorner.SE, color: 3 });
  document = markCellComplete(document, 4, 1, QuarterCorner.SE);
  apply({ type: 'set-quarter', x: 1, y: 2, corner: QuarterCorner.SW, color: 2 });
  document = markCellComplete(document, 1, 2, QuarterCorner.SW);
  apply({ type: 'set-quarter', x: 1, y: 2, corner: QuarterCorner.NW, color: 3 });
  apply({ type: 'set-three-quarter', x: 2, y: 2, corner: QuarterCorner.SW, color: 1 });
  document = markCellComplete(document, 2, 2);
  apply({ type: 'set-full', x: 0, y: 0, color: 1 });
  document = markCellComplete(document, 0, 0);
  apply({ type: 'set-half', x: 6, y: 4, direction: HalfDirection.Backslash, color: 2 });

  document = addBackstitch(document, { x: 4, y: 4 }, { x: 12, y: 16 }, 1, true);
  document = addBackstitch(document, { x: 20, y: 4 }, { x: 4, y: 16 }, 2, false);
  document = addBackstitch(document, { x: 8, y: 8 }, { x: 20, y: 12 }, 3, true);
  document = addBackstitch(document, { x: 0, y: 0 }, { x: 4, y: 4 }, 1, false);
  document = addBackstitch(document, { x: 0, y: 20 }, { x: 32, y: 20 }, 2, true);
  document = addBackstitch(document, { x: 0, y: 8 }, { x: 28, y: 12 }, 3, false);
  return { editor: editorFromSurface(document), rect };
}

function denseDocument(side: number): PatternDocument {
  const document = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: side, height: side, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
  document.kind.fill(CellKind.Full);
  for (let index = 0; index < document.kind.length; index += 1) {
    document.colors[index * 4] = 1;
    document.completed[index] = index % 7 === 0 ? 1 : 0;
  }
  return document;
}

/** Applies `result` to the service the way `ProjectSession` does after a changed command. */
function applyResult(service: ProgressMetricsService, editor: DocumentEditor, result: CommandResult): void {
  const indices = result.compositeChangedIndices;
  service.applyComposite(editor.composite, { full: result.compositeFull === true || indices === undefined, ...(indices === undefined ? {} : { indices }) });
}

function expectExactMetrics(service: ProgressMetricsService, document: PatternDocument): void {
  expect(service.metrics).toEqual(computePatternMetrics(document));
}

function expectDeleteMetricsRoundTrip(editor: DocumentEditor, rect: { x: number; y: number; width: number; height: number }): void {
  const service = new ProgressMetricsService(editor.composite);
  let result = editor.execute(onDefaultLayers(deleteRegionCommand(rect, editor.revision)));
  applyResult(service, editor, result);
    expectExactMetrics(service, editor.composite);
  result = editor.undo();
  applyResult(service, editor, result);
    expectExactMetrics(service, editor.composite);
  result = editor.redo();
  applyResult(service, editor, result);
    expectExactMetrics(service, editor.composite);
}

describe('application progress integration', () => {
  it('updates session metrics from layer edits and saves the layered document', async () => {
    const saves: number[] = [];
    const save = vi.fn(async (_projectId: string, _metadata: ProjectMetadata, document: LayeredDocument): Promise<SaveResult> => {
      saves.push(document.revision);
      return { committed: true, stale: false, revision: document.revision };
    });
    const repository = { save } as unknown as WorkspaceRepository;
    const document = createLayeredDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 2, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    const session = new ProjectSession({
      repository,
      metadata: metadata('progress', document.revision),
      document,
      preparationClient: testPreparationClient,
      clock: { now: () => Date.UTC(2026, 7, 30, 12) },
      debounceMs: 0
    });

    session.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    session.execute({ type: 'set-full', x: 1, y: 0, color: 1 });
    expect(session.metrics.totals).toMatchObject({ full: 2, completedComponents: 0, remainingComponents: 2 });
    session.undo();
    expect(session.metrics.totals).toMatchObject({ full: 1 });
    expect(session.metrics).toEqual(computePatternMetrics(session.document));

    await session.flush();
    expect(save).toHaveBeenCalledOnce();
    expect(saves[0]).toBe(session.document.revision);
    await session.dispose();
  });

  it('keeps weighted three-quarter metrics current through geometry changes', async () => {
    const repository = { save: vi.fn(async (_id: string, _metadata: ProjectMetadata, next: LayeredDocument): Promise<SaveResult> => ({ committed: true, stale: false, revision: next.revision })) } as unknown as WorkspaceRepository;
    const document = createLayeredDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 2, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    const session = new ProjectSession({ repository, metadata: metadata('three-quarter-progress', document.revision), document, preparationClient: testPreparationClient, clock: { now: () => Date.UTC(2026, 7, 30) }, debounceMs: longDebounceMs });
    try {
      session.execute({ type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.NE, color: 1 });
      expect(session.metrics.totals).toMatchObject({ threeQuarter: 1, totalComponents: 1, completedComponents: 0, remainingComponents: 1 });

      session.execute({ type: 'set-full', x: 1, y: 0, color: 1 });
      expect(session.metrics.totals).toMatchObject({ full: 1, threeQuarter: 1, totalComponents: 2, remainingComponents: 2 });
      expect(session.metrics).toEqual(computePatternMetrics(session.document));
    } finally {
      await session.dispose();
    }
  });

  it('supports three-quarter incremental metrics, completion, materials, and full rebuilds', () => {
    let document = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 3, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    document = applyCommand(document, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.NW, color: 1 }).document;
    document = markCellComplete(document, 0, 0);
    const editor = editorFromSurface(document);
    const service = new ProgressMetricsService(editor.composite);

    let result = editor.execute(onDefaultLayers(bulkSetThreeQuarterCommand(new Uint32Array([0, 1]), QuarterCorner.SE, 1)));
    expect(result.changedIndices).toEqual(new Uint32Array([0, 1]));
    applyResult(service, editor, result);
    expect(service.metrics).toEqual(computePatternMetrics(editor.composite));
    expect(service.metrics.totals).toMatchObject({ threeQuarter: 3, totalComponents: 3, completedComponents: 1, remainingComponents: 2 });
    expect(service.metrics.palettes[0].material.stitchUnits).toBe(2.25);

    result = editor.applyProgress({ cells: { indices: new Uint32Array([0, 1]), masks: new Uint8Array([5, 1]) }, operation: 'set' })!.result;
    applyResult(service, editor, result);
    expect(service.metrics).toEqual(computePatternMetrics(editor.composite));
    expect(service.metrics.progress).toMatchObject({ completedComponents: 3, remainingComponents: 0, totalComponents: 3 });

    result = editor.execute(onDefaultLayers({ type: 'set-three-quarter', x: 2, y: 0, corner: QuarterCorner.SW, color: 1 }));
    expect(result.changedIndices).toBeUndefined();
    applyResult(service, editor, result);
    expect(service.metrics).toEqual(computePatternMetrics(editor.composite));
    expect(service.recalculate(editor.composite)).toEqual(computePatternMetrics(editor.composite));
  });

  it('keeps masked completion progress and component totals exact across heterogeneous geometry', () => {
    let document = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association,
      width: 3,
      height: 1,
      palette: [
        { id: 1, name: 'Red', color: '#d33' },
        { id: 2, name: 'Blue', color: '#36c' }
      ]
    });
    const editor = editorFromSurface(document);
    editor.execute(onDefaultLayers({ type: 'set-full', x: 0, y: 0, color: 1 }));
    editor.execute(onDefaultLayers({ type: 'set-quarter', x: 1, y: 0, corner: QuarterCorner.NW, color: 1 }));
    editor.execute(onDefaultLayers({ type: 'set-quarter', x: 1, y: 0, corner: QuarterCorner.SE, color: 2 }));
    editor.execute(onDefaultLayers({ type: 'set-three-quarter', x: 2, y: 0, corner: QuarterCorner.NW, color: 1 }));
    editor.execute(onDefaultLayers({ type: 'set-three-quarter', x: 2, y: 0, corner: QuarterCorner.SE, color: 2 }));
    editor.clearHistory();
    document = editor.composite;
    const service = new ProgressMetricsService(document);

    let result = editor.applyProgress({ cells: { indices: new Uint32Array([0, 1, 2]), masks: new Uint8Array([1, 4, 1]) }, operation: 'set' })!.result;
    applyResult(service, editor, result);
    expect(service.metrics).toEqual(computePatternMetrics(editor.composite));
    expect(service.metrics.totals).toMatchObject({ totalComponents: 5, completedComponents: 3, remainingComponents: 2 });
    expect(service.metrics.byPalette.get(1)).toMatchObject({ full: 1, quarter: 1, threeQuarter: 1, completedComponents: 2 });
    expect(service.metrics.byPalette.get(2)).toMatchObject({ quarter: 1, threeQuarter: 1, completedComponents: 1 });

    result = editor.applyProgress({ cells: { indices: new Uint32Array([2]), masks: new Uint8Array([1]) }, operation: 'clear' })!.result;
    applyResult(service, editor, result);
    expect(service.metrics).toEqual(computePatternMetrics(editor.composite));
    expect(service.metrics.totals).toMatchObject({ totalComponents: 5, completedComponents: 2, remainingComponents: 3 });
  });

  it('moves masked component counts and material between palettes without changing progress', () => {
    let document = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association,
      width: 5,
      height: 1,
      palette: [
        { id: 1, name: 'Red', color: '#d33' },
        { id: 2, name: 'Blue', color: '#36c' },
        { id: 3, name: 'Gold', color: '#da2' }
      ]
    });
    document = applyCommand(document, { type: 'set-full', x: 0, y: 0, color: 1 }).document;
    document = markCellComplete(document, 0, 0);
    document = applyCommand(document, { type: 'set-half', x: 1, y: 0, direction: HalfDirection.Slash, color: 1 }).document;
    document = applyCommand(document, { type: 'set-three-quarter', x: 2, y: 0, corner: QuarterCorner.NW, color: 1 }).document;
    document = applyCommand(document, { type: 'set-quarter', x: 3, y: 0, corner: QuarterCorner.NW, color: 1 }).document;
    document = applyCommand(document, { type: 'set-quarter', x: 3, y: 0, corner: QuarterCorner.NE, color: 2 }).document;
    document = applyCommand(document, { type: 'set-three-quarter', x: 4, y: 0, corner: QuarterCorner.NW, color: 1 }).document;
    document = applyCommand(document, { type: 'set-three-quarter', x: 4, y: 0, corner: QuarterCorner.SE, color: 2 }).document;
    document = markCellComplete(document, 3, 0, QuarterCorner.NW);
    document = markCellComplete(document, 4, 0, QuarterCorner.NW);
    const editor = editorFromSurface(document);

    const service = new ProgressMetricsService(editor.composite);
    const recolored = editor.execute(onDefaultLayers(bulkRecolorCommand(
      new Uint32Array([0, 1, 2, 3, 4]),
      new Uint8Array([1, 1, 1, 1, 1]),
      1,
      3,
      editor.revision
    )));
    applyResult(service, editor, recolored);
    expect(service.metrics).toEqual(computePatternMetrics(editor.composite));
    expect(service.metrics.byPalette.get(1)).toMatchObject({ full: 0, half: 0, quarter: 0, completedComponents: 0 });
    expect(service.metrics.byPalette.get(2)).toMatchObject({ quarter: 1, threeQuarter: 1, completedComponents: 0, material: { stitchUnits: 1 } });
    expect(service.metrics.byPalette.get(3)).toMatchObject({ full: 1, half: 1, quarter: 1, threeQuarter: 2, completedComponents: 3, material: { stitchUnits: 3.25 } });

    const undone = editor.undo();
    applyResult(service, editor, undone);
    expect(service.metrics).toEqual(computePatternMetrics(editor.composite));
    expect(service.metrics.byPalette.get(1)).toMatchObject({ full: 1, half: 1, quarter: 1, threeQuarter: 2, completedComponents: 3, material: { stitchUnits: 3.25 } });
    const redone = editor.redo();
    applyResult(service, editor, redone);
    expect(service.metrics).toEqual(computePatternMetrics(editor.composite));
    expect(editor.undoDepth).toBe(1);
  });

  it('tracks distinct-color paired deletion through incremental metrics and undo/redo', () => {
    let document = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association,
      width: 1,
      height: 1,
      palette: [
        { id: 1, name: 'Red', color: '#d33' },
        { id: 2, name: 'Blue', color: '#36c' }
      ]
    });
    document = applyCommand(document, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.NW, color: 1 }).document;
    document = applyCommand(document, { type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.SE, color: 2 }).document;
    document = markCellComplete(document, 0, 0, QuarterCorner.NW);
    const editor = editorFromSurface(document);
    const service = new ProgressMetricsService(document);

    let result = editor.execute(onDefaultLayers(deleteRegionCommand({ x: 0, y: 0, width: 1, height: 1 }, editor.revision)));
    expect(result.recalculateMetrics).toBe(true);
    applyResult(service, editor, result);
    expect(service.metrics).toEqual(computePatternMetrics(editor.composite));
    expect(service.metrics.totals).toMatchObject({ completedComponents: 0, remainingComponents: 0 });

    result = editor.undo();
    applyResult(service, editor, result);
    expect(service.metrics).toEqual(computePatternMetrics(editor.composite));
    expect(service.metrics.byPalette.get(1)).toMatchObject({ threeQuarter: 1, completedComponents: 1 });
    expect(service.metrics.byPalette.get(2)).toMatchObject({ threeQuarter: 1, completedComponents: 0 });

    result = editor.redo();
    applyResult(service, editor, result);
    expect(service.metrics).toEqual(computePatternMetrics(editor.composite));
    expect(service.metrics.totals).toMatchObject({ completedComponents: 0, remainingComponents: 0 });
  });

  it('matches fresh metrics for mixed multi-palette delete, undo, and redo', () => {
    const { editor, rect } = mixedDeleteFixture();
    const service = new ProgressMetricsService(editor.composite);
    const deleted = editor.execute(onDefaultLayers(deleteRegionCommand(rect, editor.revision)));
    expect(deleted.changed).toBe(true);
    expect(deleted.recalculateMetrics).toBe(true);
    expect(Object.keys(deleted)).not.toContain('impact');
    deleted.changedIndices?.fill(0);
    deleted.touchedIndices?.fill(0);
    deleted.changedBackstitchIds?.fill(0);
    applyResult(service, editor, deleted);
    expectExactMetrics(service, editor.composite);

    const undone = editor.undo();
    applyResult(service, editor, undone);
    expectExactMetrics(service, editor.composite);

    const redone = editor.redo();
    applyResult(service, editor, redone);
    expectExactMetrics(service, editor.composite);
  });

  it('matches fresh metrics for cell-only, backstitch-only, and mixed deletes', () => {
    const cellEditor = editorFromSurface(createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 4, height: 3, palette: [{ id: 1, name: 'Red', color: '#d33' }, { id: 2, name: 'Blue', color: '#36c' }] }));
    cellEditor.execute(onDefaultLayers({ type: 'set-full', x: 1, y: 1, color: 1 }));
    cellEditor.execute(onDefaultLayers({ type: 'set-half', x: 2, y: 1, direction: HalfDirection.Backslash, color: 2 }));
    cellEditor.clearHistory();
    expectDeleteMetricsRoundTrip(cellEditor, { x: 1, y: 1, width: 2, height: 1 });

    let backstitchDocument = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 4, height: 3, palette: [{ id: 1, name: 'Red', color: '#d33' }, { id: 2, name: 'Blue', color: '#36c' }] });
    backstitchDocument = addBackstitch(backstitchDocument, { x: 0, y: 0 }, { x: 8, y: 8 }, 1, true);
    backstitchDocument = addBackstitch(backstitchDocument, { x: 0, y: 12 }, { x: 16, y: 12 }, 2, false);
    const backstitchEditor = editorFromSurface(backstitchDocument);
    expectDeleteMetricsRoundTrip(backstitchEditor, { x: 0, y: 0, width: 2, height: 2 });

    const mixed = mixedDeleteFixture();
    expectDeleteMetricsRoundTrip(mixed.editor, mixed.rect);
  });

  it('keeps real session metrics exact across layered delete, undo, and redo', async () => {
    const { editor, rect } = mixedDeleteFixture();
    const document = layeredFromSurface(cloneDocument(editor.composite));
    const repository = {
      save: async (_id: string, _metadata: ProjectMetadata, next: LayeredDocument): Promise<SaveResult> => ({ committed: true, stale: false, revision: next.revision })
    } as unknown as WorkspaceRepository;
    const session = new ProjectSession({
      repository,
      metadata: metadata('delete-metrics-session', document.revision),
      document,
      preparationClient: testPreparationClient,
      clock: { now: () => 1 },
      debounceMs: longDebounceMs
    });
    try {
      for (const layerId of [1, 2]) {
        session.setActiveLayer(layerId);
        session.execute(deleteRegionCommand(rect, session.document.revision));
        expect(session.metrics).toEqual(computePatternMetrics(session.document));
      }
      session.undo();
      expect(session.metrics).toEqual(computePatternMetrics(session.document));
      session.undo();
      expect(session.metrics).toEqual(computePatternMetrics(session.document));
      session.redo();
      expect(session.metrics).toEqual(computePatternMetrics(session.document));
    } finally {
      await session.dispose();
    }
  });

  it('matches fresh metrics for dense 250,000 and 1,000,000 cell deletion round trips', { timeout: 120_000 }, () => {
    for (const testCase of [
      { side: 1_000, rect: { x: 250, y: 250, width: 500, height: 500 } },
      { side: 1_000, rect: { x: 0, y: 0, width: 1_000, height: 1_000 } }
    ]) {
      const editor = editorFromSurface(denseDocument(testCase.side));
      const service = new ProgressMetricsService(editor.composite);
      let result = editor.execute(onDefaultLayers(deleteRegionCommand(testCase.rect, editor.revision)));
      applyResult(service, editor, result);
      expectExactMetrics(service, editor.composite);
      result = editor.undo();
      applyResult(service, editor, result);
      expectExactMetrics(service, editor.composite);
      result = editor.redo();
      applyResult(service, editor, result);
      expectExactMetrics(service, editor.composite);
    }
  });

  it('keeps no-op and stale delete metrics, revision, and history unchanged', () => {
    const editor = editorFromSurface(createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 3, height: 3, palette: [{ id: 1, name: 'Red', color: '#d33' }] }));
    const service = new ProgressMetricsService(editor.composite);
    const before = editor.composite;
    const beforeMetrics = service.metrics;
    const noOp = editor.execute(onDefaultLayers(deleteRegionCommand({ x: 0, y: 0, width: 3, height: 3 }, editor.revision)));
    expect(noOp.changed).toBe(false);
    expect(editor.composite).toBe(before);
    expect(editor.revision).toBe(0);
    expect(editor.undoDepth).toBe(0);
    expect(service.metrics).toEqual(beforeMetrics);

    expect(() => editor.execute(onDefaultLayers(deleteRegionCommand({ x: 0, y: 0, width: 1, height: 1 }, editor.revision + 1)))).toThrow(/revision/i);
    expect(editor.composite).toBe(before);
    expect(editor.revision).toBe(0);
    expect(editor.undoDepth).toBe(0);
    expect(editor.redoDepth).toBe(0);
    expect(service.metrics).toEqual(beforeMetrics);
  });

  it('keeps palette-only execute, undo, and redo metrics exact', () => {
    const editor = editorFromSurface(createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association,
      width: 3,
      height: 2,
      palette: [{ id: 1, name: 'Red', color: '#d33' }]
    }));
    editor.execute(onDefaultLayers({ type: 'set-full', x: 0, y: 0, color: 1 }));
    editor.execute(onDefaultLayers({ type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 4 }, color: 1 }));
    editor.clearHistory();

    const service = new ProgressMetricsService(editor.composite);

    const apply = (command: DomainCommand): void => {
      applyResult(service, editor, editor.execute(onDefaultLayers(command)));
      expectExactMetrics(service, editor.composite);
    };
    const applyHistory = (operation: () => ReturnType<typeof editor.undo>): void => {
      applyResult(service, editor, operation());
      expectExactMetrics(service, editor.composite);
    };

    apply({ type: 'palette-create', name: 'Blue', color: '#36c' });
    expect(service.metrics.byPalette.get(1)).toMatchObject({ full: 1, backstitch: 1, totalComponents: 2 });
    expect(service.metrics.byPalette.get(2)).toMatchObject({ full: 0, half: 0, quarter: 0, backstitch: 0, totalComponents: 0 });

    apply({ type: 'palette-update', id: 2, name: 'Updated blue', color: '#369', material: { kind: 'custom', label: 'Metres', unit: 'meters' } });
    expect(editor.composite.palette.find((entry) => entry.id === 2)).toMatchObject({ name: 'Updated blue', color: '#369' });
    expect(service.metrics.byPalette.get(2)?.material.materialUnit).toBe('meters');

    apply({ type: 'palette-deactivate', id: 2 });
    expect(editor.composite.palette.find((entry) => entry.id === 2)?.active).toBe(false);

    applyHistory(() => editor.undo());
    applyHistory(() => editor.undo());
    applyHistory(() => editor.undo());
    expect(service.metrics.byPalette.has(2)).toBe(false);

    applyHistory(() => editor.redo());
    expect(service.metrics.byPalette.get(2)).toMatchObject({ totalComponents: 0 });
    applyHistory(() => editor.redo());
    applyHistory(() => editor.redo());
    expect(editor.composite.palette.find((entry) => entry.id === 2)?.active).toBe(false);
  });

  it('reconciles cached zero-count palettes across material rebuild, undo, and redo', () => {
    const editor = editorFromSurface(createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association,
      width: 2,
      height: 1,
      palette: [{ id: 1, name: 'Red', color: '#d33' }]
    }));
    editor.execute(onDefaultLayers({ type: 'set-full', x: 0, y: 0, color: 1 }));
    editor.clearHistory();

    const service = new ProgressMetricsService(editor.composite);

    const created = editor.execute(onDefaultLayers({ type: 'palette-create', name: 'Unused', color: '#36c' }));
    applyResult(service, editor, created);
    expectExactMetrics(service, editor.composite);
    expect(service.metrics.byPalette.get(2)).toMatchObject({ totalComponents: 0 });

    service.setMaterialSettings({ strands: 2 });

    const undone = editor.undo();
    applyResult(service, editor, undone);
    expect(service.metrics).toEqual(computePatternMetrics(editor.composite, { strands: 2 }));
    expect(service.metrics.byPalette.has(2)).toBe(false);

    const redone = editor.redo();
    applyResult(service, editor, redone);
    expect(service.metrics).toEqual(computePatternMetrics(editor.composite, { strands: 2 }));
    expect(service.metrics.byPalette.get(2)).toMatchObject({ totalComponents: 0 });
  });
});
