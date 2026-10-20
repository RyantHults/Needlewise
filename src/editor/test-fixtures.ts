// Fixtures for editor tests. The gateway keeps a single-surface mode for
// boundaries without layer information; `SurfaceHistory` stands in for the
// document and history behind such a boundary.
import { applyCommand, type CommandResult, type DomainCommand, type PatternDocument } from '../domain';

interface SurfaceStep {
  readonly document: PatternDocument;
  /** The cells the edit changed; absent when it reached past cells (lines, palette, a rescan). */
  readonly changedIndices?: Uint32Array;
}

/**
 * Fakes the document and history behind a single-surface boundary only; it is
 * not an editor. Undo and redo swap whole documents, advance the revision like
 * any edit and report the cells the undone edit changed.
 */
export class SurfaceHistory {
  private undoStack: SurfaceStep[] = [];
  private redoStack: SurfaceStep[] = [];

  constructor(private current: PatternDocument) {}

  get document(): PatternDocument {
    return this.current;
  }

  get revision(): number {
    return this.current.revision;
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }

  execute(command: DomainCommand): CommandResult {
    const result = applyCommand(this.current, command);
    if (!result.changed) return result;
    const cellsOnly = result.changedIndices !== undefined && result.requiresFullRedraw !== true && result.recalculateMetrics !== true;
    this.undoStack.push({ document: this.current, ...(cellsOnly ? { changedIndices: result.changedIndices } : {}) });
    this.redoStack = [];
    this.current = result.document;
    return result;
  }

  executeBatch(commands: readonly DomainCommand[]): CommandResult {
    return this.execute({ type: 'batch', commands: [...commands] });
  }

  undo(): CommandResult {
    return this.step(this.undoStack, this.redoStack);
  }

  redo(): CommandResult {
    return this.step(this.redoStack, this.undoStack);
  }

  private step(from: SurfaceStep[], to: SurfaceStep[]): CommandResult {
    const target = from.pop();
    if (target === undefined) return { document: this.current, changed: false, revision: this.current.revision };
    to.push({ ...target, document: this.current });
    this.current = { ...target.document, revision: this.current.revision + 1 };
    const cells = target.changedIndices === undefined ? { requiresFullRedraw: true, recalculateMetrics: true } : { changedIndices: target.changedIndices };
    return { document: this.current, changed: true, revision: this.current.revision, ...cells };
  }
}
