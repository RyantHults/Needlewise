import { describe, expect, it, vi } from 'vitest';
import { bulkRecolorCommand, bulkSetCompletionCommand, bulkSetThreeQuarterCommand, CellKind, computePatternMetrics, createDocument, createEditor, deleteRegionCommand, HalfDirection, QuarterCorner, type PatternDocument } from '../domain';
import { setDailyProgress, type PersistencePreparationClient, type ProgressActivity, type ProjectMetadata, type SaveResult } from '../persistence';
import { attachDeleteMetricsImpactForDelta, registerDeleteMetricsImpact, type DeleteMetricsImpact } from '../domain/internal-metrics-impact';
import { ProjectSession } from './session';
import { ProgressMetricsService } from './progress';
import type { WorkspaceRepository } from './types';

function metadata(id: string, revision: number): ProjectMetadata {
  return { id, title: 'Progress test', notes: '', createdAt: 1, updatedAt: 1, revision };
}

const testPreparationClient: PersistencePreparationClient = {
  prepare: async () => { throw new Error('Preparation was not expected in this legacy repository seam.'); },
  getRequestId: () => { throw new Error('Preparation was not expected in this legacy repository seam.'); },
  dispose: () => undefined
};

const longDebounceMs = 2_000_000_000;

function addBackstitch(editor: ReturnType<typeof createEditor>, start: { x: number; y: number }, end: { x: number; y: number }, color: number, completed: boolean): void {
  const added = editor.execute({ type: 'add-backstitch', start, end, color });
  if (!completed) return;
  const id = added.backstitchId;
  if (id === undefined) throw new Error('Test backstitch ID was not allocated.');
  editor.execute({ type: 'set-backstitch-completion', id, completed: true });
}

function mixedDeleteFixture(): { editor: ReturnType<typeof createEditor>; rect: { x: number; y: number; width: number; height: number } } {
  const editor = createEditor(createDocument({
    width: 8,
    height: 6,
    palette: [
      { id: 1, name: 'Red', color: '#d33' },
      { id: 2, name: 'Blue', color: '#36c' },
      { id: 3, name: 'Gold', color: '#da2' }
    ]
  }));
  const rect = { x: 1, y: 1, width: 4, height: 3 };
  editor.execute({ type: 'set-full', x: 1, y: 1, color: 1 });
  editor.execute({ type: 'set-completion', x: 1, y: 1, completed: true });
  editor.execute({ type: 'set-half', x: 2, y: 1, direction: HalfDirection.Slash, color: 2 });
  editor.execute({ type: 'set-completion', x: 2, y: 1, completed: true });
  editor.execute({ type: 'set-half', x: 3, y: 1, direction: HalfDirection.Backslash, color: 3 });
  editor.execute({ type: 'set-quarter', x: 4, y: 1, corner: QuarterCorner.NW, color: 1 });
  editor.execute({ type: 'set-completion', x: 4, y: 1, corner: QuarterCorner.NW, completed: true });
  editor.execute({ type: 'set-quarter', x: 4, y: 1, corner: QuarterCorner.NE, color: 2 });
  editor.execute({ type: 'set-quarter', x: 4, y: 1, corner: QuarterCorner.SE, color: 3 });
  editor.execute({ type: 'set-completion', x: 4, y: 1, corner: QuarterCorner.SE, completed: true });
  editor.execute({ type: 'set-quarter', x: 1, y: 2, corner: QuarterCorner.SW, color: 2 });
  editor.execute({ type: 'set-completion', x: 1, y: 2, corner: QuarterCorner.SW, completed: true });
  editor.execute({ type: 'set-quarter', x: 1, y: 2, corner: QuarterCorner.NW, color: 3 });
  editor.execute({ type: 'set-three-quarter', x: 2, y: 2, corner: QuarterCorner.SW, color: 1 });
  editor.execute({ type: 'set-completion', x: 2, y: 2, completed: true });
  editor.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
  editor.execute({ type: 'set-completion', x: 0, y: 0, completed: true });
  editor.execute({ type: 'set-half', x: 6, y: 4, direction: HalfDirection.Backslash, color: 2 });

  addBackstitch(editor, { x: 4, y: 4 }, { x: 12, y: 16 }, 1, true);
  addBackstitch(editor, { x: 20, y: 4 }, { x: 4, y: 16 }, 2, false);
  addBackstitch(editor, { x: 8, y: 8 }, { x: 20, y: 12 }, 3, true);
  addBackstitch(editor, { x: 0, y: 0 }, { x: 4, y: 4 }, 1, false);
  addBackstitch(editor, { x: 0, y: 20 }, { x: 32, y: 20 }, 2, true);
  addBackstitch(editor, { x: 0, y: 8 }, { x: 28, y: 12 }, 3, false);
  editor.clearHistory();
  return { editor, rect };
}

function denseDocument(side: number): PatternDocument {
  const document = createDocument({ width: side, height: side, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
  document.kind.fill(CellKind.Full);
  for (let index = 0; index < document.kind.length; index += 1) {
    document.colors[index * 4] = 1;
    document.completed[index] = index % 7 === 0 ? 1 : 0;
  }
  return document;
}

function expectExactMetrics(service: ProgressMetricsService, document: PatternDocument, activity: { marked: number; unmarked: number }): void {
  expect(service.metrics).toEqual(computePatternMetrics(document));
  expect(activity).toEqual({ marked: 0, unmarked: 0 });
}

function expectDeleteMetricsRoundTrip(editor: ReturnType<typeof createEditor>, rect: { x: number; y: number; width: number; height: number }): void {
  const service = new ProgressMetricsService(editor.document);
  let previous = editor.document;
  let result = editor.execute(deleteRegionCommand(rect, editor.revision));
  expectExactMetrics(service, editor.document, service.apply(previous, result));
  previous = editor.document;
  result = editor.undo();
  expectExactMetrics(service, editor.document, service.apply(previous, result));
  previous = editor.document;
  result = editor.redo();
  expectExactMetrics(service, editor.document, service.apply(previous, result));
}

describe('application progress integration', () => {
  it('updates metrics from change sets and records ephemeral plus durable activity', async () => {
    const saves: Array<{ revision: number; activity?: unknown }> = [];
    const save = vi.fn(async (_projectId: string, _metadata: ProjectMetadata, document: ReturnType<typeof createDocument>, _assets: undefined, options: { activity?: unknown }): Promise<SaveResult> => {
      saves.push({ revision: document.revision, activity: options.activity });
      return { committed: true, stale: false, revision: document.revision };
    });
    const repository = { save } as unknown as WorkspaceRepository;
    const document = createDocument({ width: 2, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    const session = new ProjectSession({
      repository,
      metadata: metadata('progress', document.revision),
      document,
      preparationClient: testPreparationClient,
      clock: { now: () => Date.UTC(2026, 7, 30, 12) },
      debounceMs: 0
    });

    session.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    session.execute({ type: 'set-completion', x: 0, y: 0, completed: true });
    expect(session.metrics.totals).toMatchObject({ full: 1, completedComponents: 1, remainingComponents: 0 });
    expect(session.sessionStats).toEqual({ startedAt: Date.UTC(2026, 7, 30, 12), marked: 1, unmarked: 0 });

    const cleared = session.execute({ type: 'bulk-completion', indices: new Uint32Array([0]), operation: 'clear' });
    expect(cleared.changedIndices).toEqual(new Uint32Array([0]));
    expect(session.metrics.progress).toMatchObject({ completedComponents: 0, remainingComponents: 1, fraction: 0 });
    expect(session.sessionStats).toMatchObject({ marked: 1, unmarked: 1 });
    expect(session.activity).toEqual({ daily: [{ date: '2026-08-30', marked: 1, unmarked: 1 }] });

    await session.flush();
    expect(save).toHaveBeenCalledOnce();
    expect(saves[0]).toMatchObject({ revision: 3, activity: { daily: [{ date: '2026-08-30', marked: 1, unmarked: 1 }] } });
    await session.retrySave();
    expect(save).toHaveBeenCalledOnce();
    await session.dispose();
  });

  it('keeps weighted three-quarter metrics current through geometry and completion changes', async () => {
    const repository = { save: vi.fn(async (_id: string, _metadata: ProjectMetadata, next: PatternDocument): Promise<SaveResult> => ({ committed: true, stale: false, revision: next.revision })) } as unknown as WorkspaceRepository;
    const document = createDocument({ width: 2, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    const session = new ProjectSession({ repository, metadata: metadata('three-quarter-progress', document.revision), document, preparationClient: testPreparationClient, clock: { now: () => Date.UTC(2026, 7, 30) }, debounceMs: longDebounceMs });
    try {
      session.execute({ type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.NE, color: 1 });
      expect(session.metrics.totals).toMatchObject({ threeQuarter: 1, totalComponents: 1, completedComponents: 0, remainingComponents: 1 });

      session.execute({ type: 'set-completion', x: 0, y: 0, completed: true });
      expect(session.metrics.progress).toEqual({ completedComponents: 1, remainingComponents: 0, totalComponents: 1, fraction: 1, percent: 100 });
      expect(session.sessionStats).toMatchObject({ marked: 1, unmarked: 0 });

      session.execute({ type: 'set-full', x: 1, y: 0, color: 1 });
      expect(session.metrics.totals).toMatchObject({ full: 1, threeQuarter: 1, totalComponents: 2, completedComponents: 1, remainingComponents: 1 });
    } finally {
      await session.dispose();
    }
  });

  it('supports three-quarter incremental metrics, completion activity, materials, and fallback rebuilds', () => {
    let document = createDocument({ width: 3, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    document = (createEditor(document).execute({ type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.NW, color: 1 })).document;
    document = (createEditor(document).execute({ type: 'set-completion', x: 0, y: 0, completed: true })).document;
    const editor = createEditor(document);
    const service = new ProgressMetricsService(editor.document);

    let previous = editor.document;
    let result = editor.execute(bulkSetThreeQuarterCommand(new Uint32Array([0, 1]), QuarterCorner.SE, 1));
    expect(result.changedIndices).toEqual(new Uint32Array([0, 1]));
    expect(service.apply(previous, result)).toEqual({ marked: 0, unmarked: 0 });
    expect(service.metrics).toEqual(computePatternMetrics(editor.document));
    expect(service.metrics.totals).toMatchObject({ threeQuarter: 3, totalComponents: 3, completedComponents: 1, remainingComponents: 2 });
    expect(service.metrics.palettes[0].material.stitchUnits).toBe(2.25);

    previous = editor.document;
    result = editor.execute(bulkSetCompletionCommand(new Uint32Array([0, 1])));
    expect(service.apply(previous, result)).toEqual({ marked: 2, unmarked: 0 });
    expect(service.metrics).toEqual(computePatternMetrics(editor.document));
    expect(service.metrics.progress).toMatchObject({ completedComponents: 3, remainingComponents: 0, totalComponents: 3 });

    previous = editor.document;
    result = editor.execute({ type: 'set-three-quarter', x: 2, y: 0, corner: QuarterCorner.SW, color: 1 });
    expect(result.changedIndices).toBeUndefined();
    expect(service.apply(previous, result)).toEqual({ marked: 0, unmarked: 0 });
    expect(service.metrics).toEqual(computePatternMetrics(editor.document));
    expect(service.recalculate(editor.document)).toEqual(computePatternMetrics(editor.document));
  });

  it('keeps masked completion progress and component totals exact across heterogeneous geometry', () => {
    let document = createDocument({
      width: 3,
      height: 1,
      palette: [
        { id: 1, name: 'Red', color: '#d33' },
        { id: 2, name: 'Blue', color: '#36c' }
      ]
    });
    const editor = createEditor(document);
    editor.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    editor.execute({ type: 'set-quarter', x: 1, y: 0, corner: QuarterCorner.NW, color: 1 });
    editor.execute({ type: 'set-quarter', x: 1, y: 0, corner: QuarterCorner.SE, color: 2 });
    editor.execute({ type: 'set-three-quarter', x: 2, y: 0, corner: QuarterCorner.NW, color: 1 });
    editor.execute({ type: 'set-three-quarter', x: 2, y: 0, corner: QuarterCorner.SE, color: 2 });
    editor.clearHistory();
    document = editor.document;
    const service = new ProgressMetricsService(document);

    let previous = editor.document;
    let result = editor.execute({ type: 'bulk-completion', indices: new Uint32Array([0, 1, 2]), masks: new Uint8Array([1, 4, 1]), operation: 'set' });
    expect(service.apply(previous, result)).toEqual({ marked: 3, unmarked: 0 });
    expect(service.metrics).toEqual(computePatternMetrics(editor.document));
    expect(service.metrics.totals).toMatchObject({ totalComponents: 5, completedComponents: 3, remainingComponents: 2 });
    expect(service.metrics.byPalette.get(1)).toMatchObject({ full: 1, quarter: 1, threeQuarter: 1, completedComponents: 2 });
    expect(service.metrics.byPalette.get(2)).toMatchObject({ quarter: 1, threeQuarter: 1, completedComponents: 1 });

    previous = editor.document;
    result = editor.execute({ type: 'bulk-completion', indices: new Uint32Array([2]), masks: new Uint8Array([1]), operation: 'clear' });
    expect(service.apply(previous, result)).toEqual({ marked: 0, unmarked: 1 });
    expect(service.metrics).toEqual(computePatternMetrics(editor.document));
    expect(service.metrics.totals).toMatchObject({ totalComponents: 5, completedComponents: 2, remainingComponents: 3 });
  });

  it('moves masked component counts and material between palettes without changing progress', () => {
    const editor = createEditor(createDocument({
      width: 5,
      height: 1,
      palette: [
        { id: 1, name: 'Red', color: '#d33' },
        { id: 2, name: 'Blue', color: '#36c' },
        { id: 3, name: 'Gold', color: '#da2' }
      ]
    }));
    editor.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    editor.execute({ type: 'set-completion', x: 0, y: 0, completed: true });
    editor.execute({ type: 'set-half', x: 1, y: 0, direction: HalfDirection.Slash, color: 1 });
    editor.execute({ type: 'set-three-quarter', x: 2, y: 0, corner: QuarterCorner.NW, color: 1 });
    editor.execute({ type: 'set-quarter', x: 3, y: 0, corner: QuarterCorner.NW, color: 1 });
    editor.execute({ type: 'set-quarter', x: 3, y: 0, corner: QuarterCorner.NE, color: 2 });
    editor.execute({ type: 'set-three-quarter', x: 4, y: 0, corner: QuarterCorner.NW, color: 1 });
    editor.execute({ type: 'set-three-quarter', x: 4, y: 0, corner: QuarterCorner.SE, color: 2 });
    editor.execute({ type: 'set-completion', x: 3, y: 0, corner: QuarterCorner.NW, completed: true });
    editor.execute({ type: 'set-completion', x: 4, y: 0, corner: QuarterCorner.NW, completed: true });
    editor.clearHistory();

    const service = new ProgressMetricsService(editor.document);
    let previous = editor.document;
    const recolored = editor.execute(bulkRecolorCommand(
      new Uint32Array([0, 1, 2, 3, 4]),
      new Uint8Array([1, 1, 1, 1, 1]),
      1,
      3,
      editor.revision
    ));
    expect(service.apply(previous, recolored)).toEqual({ marked: 0, unmarked: 0 });
    expect(service.metrics).toEqual(computePatternMetrics(editor.document));
    expect(service.metrics.byPalette.get(1)).toMatchObject({ full: 0, half: 0, quarter: 0, completedComponents: 0 });
    expect(service.metrics.byPalette.get(2)).toMatchObject({ quarter: 1, threeQuarter: 1, completedComponents: 0, material: { stitchUnits: 1 } });
    expect(service.metrics.byPalette.get(3)).toMatchObject({ full: 1, half: 1, quarter: 1, threeQuarter: 2, completedComponents: 3, material: { stitchUnits: 3.25 } });

    previous = editor.document;
    const undone = editor.undo();
    expect(service.apply(previous, undone)).toEqual({ marked: 0, unmarked: 0 });
    expect(service.metrics).toEqual(computePatternMetrics(editor.document));
    expect(service.metrics.byPalette.get(1)).toMatchObject({ full: 1, half: 1, quarter: 1, threeQuarter: 2, completedComponents: 3, material: { stitchUnits: 3.25 } });
    previous = editor.document;
    const redone = editor.redo();
    expect(service.apply(previous, redone)).toEqual({ marked: 0, unmarked: 0 });
    expect(service.metrics).toEqual(computePatternMetrics(editor.document));
    expect(editor.undoDepth).toBe(1);
  });

  it('tracks distinct-color paired deletion through incremental metrics and undo/redo', () => {
    let document = createDocument({
      width: 1,
      height: 1,
      palette: [
        { id: 1, name: 'Red', color: '#d33' },
        { id: 2, name: 'Blue', color: '#36c' }
      ]
    });
    const editor = createEditor(document);
    editor.execute({ type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.NW, color: 1 });
    editor.execute({ type: 'set-three-quarter', x: 0, y: 0, corner: QuarterCorner.SE, color: 2 });
    editor.execute({ type: 'set-completion', x: 0, y: 0, corner: QuarterCorner.NW, completed: true });
    editor.clearHistory();
    document = editor.document;
    const service = new ProgressMetricsService(document);

    let previous = editor.document;
    let result = editor.execute(deleteRegionCommand({ x: 0, y: 0, width: 1, height: 1 }, editor.revision));
    expect(result.recalculateMetrics).toBe(true);
    expect(service.apply(previous, result)).toEqual({ marked: 0, unmarked: 0 });
    expect(service.metrics).toEqual(computePatternMetrics(editor.document));
    expect(service.metrics.totals).toMatchObject({ completedComponents: 0, remainingComponents: 0 });

    previous = editor.document;
    result = editor.undo();
    expect(service.apply(previous, result)).toEqual({ marked: 0, unmarked: 0 });
    expect(service.metrics).toEqual(computePatternMetrics(editor.document));
    expect(service.metrics.byPalette.get(1)).toMatchObject({ threeQuarter: 1, completedComponents: 1 });
    expect(service.metrics.byPalette.get(2)).toMatchObject({ threeQuarter: 1, completedComponents: 0 });

    previous = editor.document;
    result = editor.redo();
    expect(service.apply(previous, result)).toEqual({ marked: 0, unmarked: 0 });
    expect(service.metrics).toEqual(computePatternMetrics(editor.document));
    expect(service.metrics.totals).toMatchObject({ completedComponents: 0, remainingComponents: 0 });
  });

  it('keeps the activity window bounded and idempotent across repeated snapshots', () => {
    let activity: ProgressActivity | undefined;
    for (let day = 0; day < 400; day += 1) {
      const date = new Date(Date.UTC(2025, 0, 1 + day));
      activity = setDailyProgress(activity, date, 1, 0);
    }
    expect(activity?.daily).toHaveLength(366);
    expect(activity?.daily[0].date).toBe('2025-02-04');
    expect(activity?.daily.at(-1)).toMatchObject({ date: '2026-02-04', marked: 1, unmarked: 0 });
    const repeated = setDailyProgress(activity, '2026-02-04', 1, 0);
    expect(repeated).toEqual(activity);
  });

  it('does not record activity for identity-preserving transforms, but does record undo progress', async () => {
    const repository = { save: vi.fn(async (_id: string, _metadata: ProjectMetadata, next: ReturnType<typeof createDocument>): Promise<SaveResult> => ({ committed: true, stale: false, revision: next.revision })) } as unknown as WorkspaceRepository;
    const document = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    const session = new ProjectSession({
      repository,
      metadata: metadata('identity-progress', document.revision),
      document,
      preparationClient: testPreparationClient,
      clock: { now: () => Date.UTC(2026, 7, 30, 12) },
      debounceMs: 0
    });

    session.execute({ type: 'set-full', x: 0, y: 0, color: 1 });
    session.execute({ type: 'set-completion', x: 0, y: 0, completed: true });
    expect(session.sessionStats).toMatchObject({ marked: 1, unmarked: 0 });

    session.execute({ type: 'rotate-cw' });
    expect(session.sessionStats).toMatchObject({ marked: 1, unmarked: 0 });
    const undoTransform = session.undo();
    expect(undoTransform.progress).toEqual({ cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0), marked: 0, unmarked: 0 });
    expect(session.sessionStats).toMatchObject({ marked: 1, unmarked: 0 });
    const undoCompletion = session.undo();
    expect(undoCompletion.progress).toEqual({ cellIndices: new Uint32Array([0]), backstitchIds: new Uint32Array(0), marked: 0, unmarked: 1 });
    expect(session.sessionStats).toMatchObject({ marked: 1, unmarked: 1 });
    session.redo();
    expect(session.sessionStats).toMatchObject({ marked: 2, unmarked: 1 });
    await session.dispose();
  });

  it('exposes stable-ID backstitch completion helpers backed by domain validation', async () => {
    const repository = { save: vi.fn(async (_id: string, _metadata: ProjectMetadata, next: ReturnType<typeof createDocument>): Promise<SaveResult> => ({ committed: true, stale: false, revision: next.revision })) } as unknown as WorkspaceRepository;
    const document = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
    const session = new ProjectSession({ repository, metadata: metadata('backstitch-progress', document.revision), document, preparationClient: testPreparationClient, clock: { now: () => Date.UTC(2026, 7, 30) }, debounceMs: 0 });
    try {
      const created = session.execute({ type: 'add-backstitch', start: { x: 0, y: 0 }, end: { x: 4, y: 4 }, color: 1 });
      const id = created.backstitchId;
      if (id === undefined) throw new Error('backstitch ID was not allocated');
      const completed = session.completeBackstitches(new Uint32Array([id]));
      expect(completed.changed).toBe(true);
      expect(completed.changedBackstitchIds).toEqual(new Uint32Array([id]));
      expect(session.document.backstitches.completed[0]).toBe(1);
      session.toggleBackstitchCompletion(id);
      expect(session.document.backstitches.completed[0]).toBe(0);
    } finally {
      await session.dispose();
    }
  });

  it('matches fresh metrics for mixed multi-palette delete, undo, and redo', () => {
    const { editor, rect } = mixedDeleteFixture();
    const service = new ProgressMetricsService(editor.document);
    const before = editor.document;
    const deleted = editor.execute(deleteRegionCommand(rect, editor.revision));
    expect(deleted.changed).toBe(true);
    expect(deleted.recalculateMetrics).toBe(true);
    expect(Object.keys(deleted)).not.toContain('impact');
    deleted.changedIndices?.fill(0);
    deleted.touchedIndices?.fill(0);
    deleted.changedBackstitchIds?.fill(0);
    expectExactMetrics(service, editor.document, service.apply(before, deleted));

    const afterDelete = editor.document;
    const undone = editor.undo();
    expectExactMetrics(service, editor.document, service.apply(afterDelete, undone));

    const afterUndo = editor.document;
    const redone = editor.redo();
    expectExactMetrics(service, editor.document, service.apply(afterUndo, redone));
  });

  it('uses exact impacts for cell-only, backstitch-only, and mixed deletes', () => {
    const cellEditor = createEditor(createDocument({ width: 4, height: 3, palette: [{ id: 1, name: 'Red', color: '#d33' }, { id: 2, name: 'Blue', color: '#36c' }] }));
    cellEditor.execute({ type: 'set-full', x: 1, y: 1, color: 1 });
    cellEditor.execute({ type: 'set-half', x: 2, y: 1, direction: HalfDirection.Backslash, color: 2 });
    cellEditor.clearHistory();
    expectDeleteMetricsRoundTrip(cellEditor, { x: 1, y: 1, width: 2, height: 1 });

    const backstitchEditor = createEditor(createDocument({ width: 4, height: 3, palette: [{ id: 1, name: 'Red', color: '#d33' }, { id: 2, name: 'Blue', color: '#36c' }] }));
    addBackstitch(backstitchEditor, { x: 0, y: 0 }, { x: 8, y: 8 }, 1, true);
    addBackstitch(backstitchEditor, { x: 0, y: 12 }, { x: 16, y: 12 }, 2, false);
    backstitchEditor.clearHistory();
    expectDeleteMetricsRoundTrip(backstitchEditor, { x: 0, y: 0, width: 2, height: 2 });

    const mixed = mixedDeleteFixture();
    expectDeleteMetricsRoundTrip(mixed.editor, mixed.rect);
  });

  it('keeps real session metrics exact and preserves zero delete activity', async () => {
    const { editor, rect } = mixedDeleteFixture();
    const document = editor.document;
    const repository = {
      save: async (_id: string, _metadata: ProjectMetadata, next: PatternDocument): Promise<SaveResult> => ({ committed: true, stale: false, revision: next.revision })
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
      let result = session.execute(deleteRegionCommand(rect, session.document.revision));
      expect(result.progress).toEqual({ cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0), marked: 0, unmarked: 0 });
      expect(session.sessionStats).toMatchObject({ marked: 0, unmarked: 0 });
      expect(session.metrics).toEqual(computePatternMetrics(session.document));

      result = session.undo();
      expect(result.progress).toEqual({ cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0), marked: 0, unmarked: 0 });
      expect(session.sessionStats).toMatchObject({ marked: 0, unmarked: 0 });
      expect(session.metrics).toEqual(computePatternMetrics(session.document));

      result = session.redo();
      expect(result.progress).toEqual({ cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0), marked: 0, unmarked: 0 });
      expect(session.sessionStats).toMatchObject({ marked: 0, unmarked: 0 });
      expect(session.metrics).toEqual(computePatternMetrics(session.document));
    } finally {
      await session.dispose();
    }
  });

  it('falls back exactly for copied results, revision mismatches, and malformed impacts', () => {
    const { editor, rect } = mixedDeleteFixture();
    const before = editor.document;
    const deleted = editor.execute(deleteRegionCommand(rect, editor.revision));

    const copiedResult = { ...deleted };
    const copiedService = new ProgressMetricsService(before);
    expectExactMetrics(copiedService, deleted.document, copiedService.apply(before, copiedResult));

    const mismatchedService = new ProgressMetricsService(before);
    const mismatchedPrevious = { ...before, revision: before.revision + 10 };
    expectExactMetrics(mismatchedService, deleted.document, mismatchedService.apply(mismatchedPrevious, deleted));

    const malformedDelta = {};
    const malformedImpact = {
      entries: [{
        paletteId: 1,
        removedFull: -1,
        removedHalf: 0,
        removedQuarter: 0,
        removedCellCompleted: 0,
        beforeBackstitchCount: 0,
        afterBackstitchCount: 0,
        beforeBackstitchCompleted: 0,
        afterBackstitchCompleted: 0,
        beforeBackstitchLengthFixed: 0,
        afterBackstitchLengthFixed: 0
      }]
    } as unknown as DeleteMetricsImpact;
    registerDeleteMetricsImpact(malformedDelta, malformedImpact);
    const malformedResult = { ...deleted };
    attachDeleteMetricsImpactForDelta(malformedResult, malformedDelta, 'after');
    const malformedService = new ProgressMetricsService(before);
    expectExactMetrics(malformedService, deleted.document, malformedService.apply(before, malformedResult));
  });

  it('matches fresh metrics for dense 250,000 and 1,000,000 cell deletion round trips', { timeout: 120_000 }, () => {
    for (const testCase of [
      { side: 1_000, rect: { x: 250, y: 250, width: 500, height: 500 } },
      { side: 1_000, rect: { x: 0, y: 0, width: 1_000, height: 1_000 } }
    ]) {
      const editor = createEditor(denseDocument(testCase.side));
      const service = new ProgressMetricsService(editor.document);
      let previous = editor.document;
      let result = editor.execute(deleteRegionCommand(testCase.rect, editor.revision));
      expectExactMetrics(service, editor.document, service.apply(previous, result));
      previous = editor.document;
      result = editor.undo();
      expectExactMetrics(service, editor.document, service.apply(previous, result));
      previous = editor.document;
      result = editor.redo();
      expectExactMetrics(service, editor.document, service.apply(previous, result));
    }
  });

  it('keeps no-op and stale delete metrics, revision, history, and activity unchanged', () => {
    const editor = createEditor(createDocument({ width: 3, height: 3, palette: [{ id: 1, name: 'Red', color: '#d33' }] }));
    const service = new ProgressMetricsService(editor.document);
    const before = editor.document;
    const beforeMetrics = service.metrics;
    const noOp = editor.execute(deleteRegionCommand({ x: 0, y: 0, width: 3, height: 3 }, editor.revision));
    expect(noOp.changed).toBe(false);
    expect(editor.document).toBe(before);
    expect(editor.revision).toBe(0);
    expect(editor.undoDepth).toBe(0);
    expect(service.apply(before, noOp)).toEqual({ marked: 0, unmarked: 0 });
    expect(service.metrics).toEqual(beforeMetrics);

    expect(() => editor.execute(deleteRegionCommand({ x: 0, y: 0, width: 1, height: 1 }, editor.revision + 1))).toThrow(/revision/i);
    expect(editor.document).toBe(before);
    expect(editor.revision).toBe(0);
    expect(editor.undoDepth).toBe(0);
    expect(editor.redoDepth).toBe(0);
    expect(service.metrics).toEqual(beforeMetrics);
  });
});
