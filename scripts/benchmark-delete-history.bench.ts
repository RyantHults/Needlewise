import { describe, it } from 'vitest';
import { ProjectSession, ProgressMetricsService, type WorkspaceRepository } from '../src/application';
import { CellKind, createDocument, createEditor, deleteRegionCommand, type CommandResult, type CropRect, type PatternDocument } from '../src/domain';
import { type PersistencePreparationClient, type ProjectMetadata, type SaveResult } from '../src/persistence';

const WARMUP_COUNT = 3;
const SAMPLE_COUNT = 11;
const DOCUMENT_SIDE = 1_000;
const DEBOUNCE_MS = 2_000_000_000;

type Operation = 'delete' | 'undo' | 'redo';
type Phase = 'editor' | 'metrics' | 'session';

function denseDocument(): PatternDocument {
  const document = createDocument({
    width: DOCUMENT_SIDE,
    height: DOCUMENT_SIDE,
    palette: [{ id: 1, name: 'Benchmark red', color: '#d33' }]
  });
  document.kind.fill(CellKind.Full);
  for (let index = 0; index < document.kind.length; index += 1) document.colors[index * 4] = 1;
  return document;
}

function benchmarkAssert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Benchmark fixture check failed: ${message}`);
}

function verifyCells(document: PatternDocument, rect: CropRect, empty: boolean): void {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    const start = y * document.width + rect.x;
    const end = start + rect.width;
    for (let index = start; index < end; index += 1) {
      const offset = index * 4;
      if (empty) {
        benchmarkAssert(document.kind[index] === CellKind.Empty, `cell ${String(index)} was not deleted`);
        benchmarkAssert(document.completed[index] === 0, `completion at cell ${String(index)} was not deleted`);
        benchmarkAssert(document.colors[offset] === 0 && document.colors[offset + 1] === 0 && document.colors[offset + 2] === 0 && document.colors[offset + 3] === 0, `colors at cell ${String(index)} were not deleted`);
      } else {
        benchmarkAssert(document.kind[index] === CellKind.Full, `cell ${String(index)} was not restored`);
        benchmarkAssert(document.completed[index] === 0, `restored completion at cell ${String(index)} changed`);
        benchmarkAssert(document.colors[offset] === 1 && document.colors[offset + 1] === 0 && document.colors[offset + 2] === 0 && document.colors[offset + 3] === 0, `restored colors at cell ${String(index)} changed`);
      }
    }
  }
}

function verifyEditorState(editor: ReturnType<typeof createEditor>, operation: Operation, baseRevision: number, rect: CropRect): void {
  const expectedRevision = baseRevision + (operation === 'delete' ? 1 : operation === 'undo' ? 2 : 3);
  benchmarkAssert(editor.revision === expectedRevision, `${operation} revision was ${String(editor.revision)}, expected ${String(expectedRevision)}`);
  benchmarkAssert(operation === 'undo' ? editor.undoDepth === 0 && editor.redoDepth === 1 : editor.undoDepth === 1 && editor.redoDepth === 0, `${operation} history depths were unexpected`);
  verifyCells(editor.document, rect, operation !== 'undo');
}

function verifyResult(result: CommandResult, editor: ReturnType<typeof createEditor>, operation: Operation, baseRevision: number, rect: CropRect): void {
  benchmarkAssert(result.changed, `${operation} result was not changed`);
  benchmarkAssert(result.revision === editor.revision, `${operation} result revision did not match the editor`);
  verifyEditorState(editor, operation, baseRevision, rect);
}

function prepareEditor(base: PatternDocument, rect: CropRect, operation: Operation): { editor: ReturnType<typeof createEditor>; command: ReturnType<typeof deleteRegionCommand> } {
  const editor = createEditor(base);
  const command = deleteRegionCommand(rect);
  if (operation !== 'delete') {
    const deleted = editor.execute(command);
    verifyResult(deleted, editor, 'delete', base.revision, rect);
    if (operation === 'redo') {
      const undone = editor.undo();
      verifyResult(undone, editor, 'undo', base.revision, rect);
    }
  }
  return { editor, command };
}

function runEditor(base: PatternDocument, rect: CropRect, operation: Operation): number {
  const { editor, command } = prepareEditor(base, rect, operation);
  const start = performance.now();
  const result = operation === 'delete' ? editor.execute(command) : operation === 'undo' ? editor.undo() : editor.redo();
  const elapsed = performance.now() - start;
  verifyResult(result, editor, operation, base.revision, rect);
  return elapsed;
}

function runMetrics(base: PatternDocument, rect: CropRect, operation: Operation): number {
  const { editor, command } = prepareEditor(base, rect, operation);
  let previous = editor.document;
  let result: CommandResult;
  if (operation === 'delete') {
    result = editor.execute(command);
    verifyResult(result, editor, operation, base.revision, rect);
  } else if (operation === 'undo') {
    previous = editor.document;
    result = editor.undo();
    verifyResult(result, editor, operation, base.revision, rect);
  } else {
    previous = editor.document;
    result = editor.redo();
    verifyResult(result, editor, operation, base.revision, rect);
  }

  // Construction computes the initial metrics and is deliberately outside the
  // measured interval. The timed call is the exact result from the prepared
  // editor operation above.
  const service = new ProgressMetricsService(previous);
  const start = performance.now();
  const progress = service.apply(previous, result);
  const elapsed = performance.now() - start;
  benchmarkAssert(Number.isFinite(progress.marked) && Number.isFinite(progress.unmarked), `${operation} metrics result was invalid`);
  return elapsed;
}

function metadata(revision: number): ProjectMetadata {
  return { id: 'benchmark-delete-history', title: 'Benchmark', notes: '', createdAt: 1, updatedAt: 1, revision };
}

interface SessionSupport {
  readonly repository: WorkspaceRepository;
  readonly preparationClient: PersistencePreparationClient;
  readonly getSaveCount: () => number;
}

function sessionSupport(): SessionSupport {
  let saveCount = 0;
  const repository = {
    save: async (_projectId: string, _metadata: ProjectMetadata, document: PatternDocument): Promise<SaveResult> => {
      saveCount += 1;
      return { committed: true, stale: false, revision: document.revision };
    }
  } as unknown as WorkspaceRepository;
  const preparationClient: PersistencePreparationClient = {
    prepare: async () => { throw new Error('Benchmark preparation was not expected.'); },
    getRequestId: () => { throw new Error('Benchmark preparation was not expected.'); },
    dispose: () => undefined
  };
  return { repository, preparationClient, getSaveCount: () => saveCount };
}

function verifySessionState(session: ProjectSession, operation: Operation, baseRevision: number, rect: CropRect): void {
  const expectedRevision = baseRevision + (operation === 'delete' ? 1 : operation === 'undo' ? 2 : 3);
  benchmarkAssert(session.document.revision === expectedRevision, `${operation} session revision was ${String(session.document.revision)}, expected ${String(expectedRevision)}`);
  benchmarkAssert(operation === 'undo' ? session.historyUndoDepth === 0 && session.historyRedoDepth === 1 : session.historyUndoDepth === 1 && session.historyRedoDepth === 0, `${operation} session history depths were unexpected`);
  verifyCells(session.document, rect, operation !== 'undo');
}

async function runSession(base: PatternDocument, rect: CropRect, operation: Operation): Promise<number> {
  const support = sessionSupport();
  let session: ProjectSession | undefined;
  try {
    session = new ProjectSession({
      repository: support.repository,
      metadata: metadata(base.revision),
      document: base,
      preparationClient: support.preparationClient,
      clock: { now: () => 1 },
      debounceMs: DEBOUNCE_MS
    });
    const command = deleteRegionCommand(rect);
    if (operation !== 'delete') {
      const deleted = session.execute(command);
      benchmarkAssert(deleted.changed, 'session setup delete did not change the document');
      verifySessionState(session, 'delete', base.revision, rect);
      if (operation === 'redo') {
        const undone = session.undo();
        benchmarkAssert(undone.changed, 'session setup undo did not change the document');
        verifySessionState(session, 'undo', base.revision, rect);
      }
    }

    const savesBefore = support.getSaveCount();
    const start = performance.now();
    const result = operation === 'delete' ? session.execute(command) : operation === 'undo' ? session.undo() : session.redo();
    const elapsed = performance.now() - start;
    benchmarkAssert(result.changed, `${operation} session result was not changed`);
    benchmarkAssert(result.revision === session.document.revision, `${operation} session result revision did not match the session`);
    benchmarkAssert(support.getSaveCount() === savesBefore, `${operation} session save callback fired during timing`);
    verifySessionState(session, operation, base.revision, rect);
    return elapsed;
  } finally {
    if (session !== undefined) await session.dispose();
    support.preparationClient.dispose();
  }
}

async function measure(base: PatternDocument, rect: CropRect, operation: Operation, phase: Phase): Promise<number[]> {
  const run = (): number | Promise<number> => phase === 'editor'
    ? runEditor(base, rect, operation)
    : phase === 'metrics'
      ? runMetrics(base, rect, operation)
      : runSession(base, rect, operation);
  for (let index = 0; index < WARMUP_COUNT; index += 1) await run();
  const samples: number[] = [];
  for (let index = 0; index < SAMPLE_COUNT; index += 1) samples.push(await run());
  return samples;
}

function summary(samples: number[]): { median: number; min: number; max: number } {
  const sorted = [...samples].sort((left, right) => left - right);
  return { median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted[sorted.length - 1] };
}

describe('manual delete history benchmark', () => {
  it('reports editor, metrics, and session timings', { timeout: 300_000 }, async () => {
    const base = denseDocument();
    const cases: Array<{ label: string; rect: CropRect }> = [
      { label: '500x500', rect: { x: 250, y: 250, width: 500, height: 500 } },
      { label: '1000x1000', rect: { x: 0, y: 0, width: 1_000, height: 1_000 } }
    ];
    console.log('operation,selection,phase,setup_excluded,samples,warmups,median_ms,min_ms,max_ms');
    for (const operation of ['delete', 'undo', 'redo'] as const) {
      for (const testCase of cases) {
        for (const phase of ['editor', 'metrics', 'session'] as const) {
          const result = summary(await measure(base, testCase.rect, operation, phase));
          console.log(`${operation},${testCase.label},${phase},true,${String(SAMPLE_COUNT)},${String(WARMUP_COUNT)},${result.median.toFixed(3)},${result.min.toFixed(3)},${result.max.toFixed(3)}`);
        }
      }
    }
  });
});
