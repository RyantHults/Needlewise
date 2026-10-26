import {
  findLayer,
  type CommandResult,
  type DomainCommand,
  type LayeredDocument,
  type LayerType,
  type PaletteEntryInput,
  type PatternDocument,
  type PatternFragment,
  type ProgressCommand
} from '../domain';
import type { ProjectWorkspace } from '../application/workspace';
import type { EditorActiveLayer, Invalidation } from './contracts';
import { indexBounds } from './rect';

export interface WorkspaceEditorSnapshot {
  readonly projectId: string | null;
  readonly revision: number | null;
  /** The flattened, visible-only composite that rendering, eyedropper and hover info read. */
  readonly document: PatternDocument | null;
  /** Null only when no project is open, as for every layer field below. */
  readonly layeredDocument: LayeredDocument | null;
  /** The selected layer's own content, which editor tools read and change. Null for Canvas and Reference. */
  readonly editSurface: PatternDocument | null;
  readonly activeLayer: EditorActiveLayer | null;
  /**
   * The selected stitch and specialty layers, bottom to top, which a move and a
   * delete act on. Empty on Canvas or Reference.
   */
  readonly selectedLayers: readonly EditorActiveLayer[];
  /** Changes whenever layer order, membership, type or visibility changes. */
  readonly layerStackKey: string | null;
  /** Changes whenever the set of selected layers changes. */
  readonly layerSelectionKey: string | null;
  /** What the workspace's last change did to the composite, when it reports it. */
  readonly compositeInvalidation: CompositeInvalidationReport | null;
}

/** The session's report of the cells its last change altered in the composite. */
export interface CompositeInvalidationReport {
  readonly revision: number;
  /** Every cell may have changed. */
  readonly full: boolean;
  /** Changed cells when `full` is false; absent means no cell changed. */
  readonly indices?: Uint32Array;
}

export type ActiveLayerId = number | 'canvas' | 'reference';

/** Where a paste of a given layer type lands; see `ProjectSession.resolvePaste`. */
export interface PasteDestination {
  readonly layerId: number | null;
  readonly create: boolean;
  readonly message?: string;
}

export interface PasteCommitResult {
  readonly result: CommandResult;
  /** Null when nothing was pasted (every layer of the type is hidden). */
  readonly layerId?: number | null;
  readonly message?: string;
}

/** True when a result is tagged as leaving the visible composite untouched. */
export function compositeUnchanged(result: CommandResult): boolean {
  return result.compositeUnchanged === true;
}

/**
 * The base-layer invalidation a command result implies for the composite.
 * `compositeFull` wins, then composite changed indices, then the legacy
 * single-surface fields. Empty indices without the `compositeUnchanged` tag
 * still redraw in full, since single backstitch edits report no cells.
 */
export function compositeInvalidationFor(result: CommandResult, requestedIndices?: Uint32Array): Invalidation {
  // Exact composite cells let overview atlases repaint only what changed, even
  // when the screen itself is redrawn in full.
  const cellIndices = result.compositeFull !== true && result.compositeChangedIndices !== undefined ? result.compositeChangedIndices : undefined;
  const full: Invalidation = { layer: 'base', full: true, reason: 'editor-command', ...(cellIndices ? { cellIndices } : {}) };
  if (result.compositeFull === true || result.requiresFullRedraw === true) return full;
  const backstitchesChanged = (result.changedBackstitchIds !== undefined && result.changedBackstitchIds.length > 0)
    || (result.movedBackstitchIds !== undefined && result.movedBackstitchIds.length > 0)
    || (result.createdBackstitchIds !== undefined && result.createdBackstitchIds.length > 0);
  if (backstitchesChanged) return full;
  const changed = result.compositeChangedIndices !== undefined
    ? result.compositeChangedIndices
    : result.changedIndices && result.changedIndices.length > 0 ? result.changedIndices : requestedIndices;
  const cellRect = changed ? indexBounds(changed, result.document.width, result.document.height) : undefined;
  return cellRect ? { layer: 'base', cellRect, reason: 'editor-command', ...(cellIndices ? { cellIndices } : {}) } : full;
}

export interface EditorRevisionToken {
  readonly projectId: string;
  readonly revision: number;
}

/** A snapshot of an open project, which has a revision token. */
export type RevisionedSnapshot = WorkspaceEditorSnapshot & EditorRevisionToken;

export function hasRevision(snapshot: WorkspaceEditorSnapshot): snapshot is RevisionedSnapshot {
  return !!snapshot.projectId && snapshot.revision !== null;
}

/** The revision token of an open project's snapshot. */
export function tokenOf(snapshot: EditorRevisionToken): EditorRevisionToken {
  return { projectId: snapshot.projectId, revision: snapshot.revision };
}

export class StaleEditorTransactionError extends Error {
  readonly code = 'stale-editor-transaction';
  readonly expected: EditorRevisionToken;
  readonly actual: WorkspaceEditorSnapshot;

  constructor(expected: EditorRevisionToken, actual: WorkspaceEditorSnapshot) {
    super(`The editor transaction for ${expected.projectId}@${String(expected.revision)} is stale.`);
    this.name = 'StaleEditorTransactionError';
    this.expected = expected;
    this.actual = actual;
  }
}

export interface WorkspaceEditorBoundary {
  readonly activeProjectId: string | null;
  readonly document: PatternDocument | null;
  readonly layeredDocument: LayeredDocument | null;
  readonly activeLayerId: ActiveLayerId | null;
  /** Every selected stitch/specialty layer id. */
  readonly selectedLayerIds: readonly number[] | null;
  activeLayerSurface(): PatternDocument | null;
  getEditorLayerSnapshot(): { readonly compositeInvalidation: CompositeInvalidationReport | null } | null;
  resolvePaste(type: LayerType): PasteDestination;
  commitPaste(fragment: PatternFragment, position: { x: number; y: number }, destination: PasteDestination, expectedRevision?: number, palette?: readonly PaletteEntryInput[]): PasteCommitResult;
  subscribe(listener: () => void): () => void;
  execute(command: DomainCommand): CommandResult;
  executeBatch(commands: readonly DomainCommand[]): CommandResult;
  undo(): CommandResult;
  redo(): CommandResult;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** The Track page's mark history, kept apart from document history. */
  markProgress(command: ProgressCommand): CommandResult;
  undoMark(): CommandResult;
  redoMark(): CommandResult;
}

export interface EditorTransaction {
  readonly token: EditorRevisionToken;
  commit(command: DomainCommand): CommandResult;
  commitBatch(commands: readonly DomainCommand[]): CommandResult;
}

export interface WorkspaceEditorGateway {
  getSnapshot(): WorkspaceEditorSnapshot;
  getDocumentSnapshot(): WorkspaceEditorSnapshot;
  subscribe(listener: (snapshot: WorkspaceEditorSnapshot) => void): () => void;
  beginTransaction(): EditorTransaction;
  execute(command: DomainCommand, expected?: EditorRevisionToken): CommandResult;
  executeBatch(commands: readonly DomainCommand[], expected?: EditorRevisionToken): CommandResult;
  undo(expected?: EditorRevisionToken): CommandResult;
  redo(expected?: EditorRevisionToken): CommandResult;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Where a paste of this layer type would go; null `layerId` means nowhere. */
  resolvePaste(type: LayerType): PasteDestination;
  /** Paste as one history entry, creating the destination layer when needed. */
  commitPaste(fragment: PatternFragment, position: { x: number; y: number }, destination: PasteDestination, expected?: EditorRevisionToken, palette?: readonly PaletteEntryInput[]): PasteCommitResult;
  /** Record stitch progress outside document history; true when a mark changed. */
  markProgress(command: ProgressCommand): boolean;
  undoMark(): boolean;
  redoMark(): boolean;
  dispose(): void;
}

function activeLayerOf(layered: LayeredDocument, id: ActiveLayerId | null): EditorActiveLayer | null {
  if (id === 'canvas' || id === 'reference') return { id, kind: id, visible: true };
  if (typeof id !== 'number') return null;
  const layer = findLayer(layered, id);
  return layer ? { id, kind: layer.type, visible: layer.visible } : null;
}

function layerStackKeyOf(layered: LayeredDocument): string {
  return layered.layers.map((layer) => `${String(layer.id)}:${layer.type}:${layer.visible ? 1 : 0}`).join(',');
}

function selectedLayersOf(layered: LayeredDocument, ids: readonly number[] | null, active: EditorActiveLayer | null): EditorActiveLayer[] {
  if (typeof active?.id !== 'number') return [];
  const selected = new Set(ids ?? []);
  selected.add(active.id);
  return layered.layers.filter((layer) => selected.has(layer.id)).map((layer) => ({ id: layer.id, kind: layer.type, visible: layer.visible }));
}

function snapshotOf(boundary: WorkspaceEditorBoundary): WorkspaceEditorSnapshot {
  const document = boundary.document;
  const layered = boundary.layeredDocument;
  if (!document || !layered) {
    return {
      projectId: boundary.activeProjectId,
      revision: null,
      document: null,
      layeredDocument: null,
      editSurface: null,
      activeLayer: null,
      selectedLayers: [],
      layerStackKey: null,
      layerSelectionKey: null,
      compositeInvalidation: null
    };
  }
  const activeLayer = activeLayerOf(layered, boundary.activeLayerId);
  const selectedLayers = selectedLayersOf(layered, boundary.selectedLayerIds, activeLayer);
  return {
    projectId: boundary.activeProjectId,
    revision: document.revision,
    document,
    layeredDocument: layered,
    editSurface: typeof activeLayer?.id === 'number' ? boundary.activeLayerSurface() : null,
    activeLayer,
    selectedLayers,
    layerStackKey: layerStackKeyOf(layered),
    layerSelectionKey: selectedLayers.map((layer) => String(layer.id)).join(','),
    compositeInvalidation: boundary.getEditorLayerSnapshot()?.compositeInvalidation ?? null
  };
}

function expectedToken(token: EditorRevisionToken | undefined, snapshot: WorkspaceEditorSnapshot): void {
  if (!token) return;
  if (snapshot.projectId !== token.projectId || snapshot.revision !== token.revision) throw new StaleEditorTransactionError(token, snapshot);
}

class WorkspaceEditorGatewayImpl implements WorkspaceEditorGateway {
  private snapshot: WorkspaceEditorSnapshot;
  private readonly listeners = new Set<(snapshot: WorkspaceEditorSnapshot) => void>();
  private readonly unsubscribeBoundary: () => void;
  private disposed = false;

  constructor(private readonly boundary: WorkspaceEditorBoundary) {
    this.snapshot = snapshotOf(boundary);
    this.unsubscribeBoundary = boundary.subscribe(() => this.refresh());
  }

  getSnapshot(): WorkspaceEditorSnapshot {
    return this.snapshot;
  }

  getDocumentSnapshot(): WorkspaceEditorSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: WorkspaceEditorSnapshot) => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  beginTransaction(): EditorTransaction {
    this.refreshFromBoundary();
    const snapshot = this.snapshot;
    if (!hasRevision(snapshot)) throw new Error('There is no active editor project.');
    const token = tokenOf(snapshot);
    let committed = false;
    return {
      token,
      commit: (command) => {
        if (committed) throw new StaleEditorTransactionError(token, this.snapshot);
        const result = this.execute(command, token);
        committed = true;
        return result;
      },
      commitBatch: (commands) => {
        if (committed) throw new StaleEditorTransactionError(token, this.snapshot);
        const result = this.executeBatch(commands, token);
        committed = true;
        return result;
      }
    };
  }

  execute(command: DomainCommand, expected?: EditorRevisionToken): CommandResult {
    this.ensureLive();
    this.refreshFromBoundary();
    expectedToken(expected, this.snapshot);
    const result = this.boundary.execute(command);
    this.refresh();
    return result;
  }

  executeBatch(commands: readonly DomainCommand[], expected?: EditorRevisionToken): CommandResult {
    this.ensureLive();
    this.refreshFromBoundary();
    expectedToken(expected, this.snapshot);
    const result = this.boundary.executeBatch(commands);
    this.refresh();
    return result;
  }

  undo(expected?: EditorRevisionToken): CommandResult {
    this.ensureLive();
    this.refreshFromBoundary();
    expectedToken(expected, this.snapshot);
    const result = this.boundary.undo();
    this.refresh();
    return result;
  }

  redo(expected?: EditorRevisionToken): CommandResult {
    this.ensureLive();
    this.refreshFromBoundary();
    expectedToken(expected, this.snapshot);
    const result = this.boundary.redo();
    this.refresh();
    return result;
  }

  canUndo(): boolean {
    return this.boundary.canUndo;
  }

  canRedo(): boolean {
    return this.boundary.canRedo;
  }

  resolvePaste(type: LayerType): PasteDestination {
    return this.boundary.resolvePaste(type);
  }

  commitPaste(fragment: PatternFragment, position: { x: number; y: number }, destination: PasteDestination, expected?: EditorRevisionToken, palette?: readonly PaletteEntryInput[]): PasteCommitResult {
    this.ensureLive();
    this.refreshFromBoundary();
    expectedToken(expected, this.snapshot);
    const revision = expected?.revision ?? this.snapshot.revision ?? undefined;
    const outcome = this.boundary.commitPaste(fragment, position, destination, revision, palette);
    this.refresh();
    return outcome;
  }

  markProgress(command: ProgressCommand): boolean {
    return this.progress(() => this.boundary.markProgress(command));
  }

  undoMark(): boolean {
    return this.progress(() => this.boundary.undoMark());
  }

  redoMark(): boolean {
    return this.progress(() => this.boundary.redoMark());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeBoundary();
    this.listeners.clear();
  }

  private progress(apply: () => CommandResult): boolean {
    this.ensureLive();
    this.refreshFromBoundary();
    if (this.snapshot.projectId === null) return false;
    const result = apply();
    this.refresh();
    return result.changed;
  }

  private ensureLive(): void {
    if (this.disposed) throw new Error('The editor gateway has been disposed.');
  }

  private refresh(): void {
    if (this.disposed) return;
    this.snapshot = snapshotOf(this.boundary);
    for (const listener of [...this.listeners]) listener(this.snapshot);
  }

  private refreshFromBoundary(): void {
    this.snapshot = snapshotOf(this.boundary);
  }
}

export function createWorkspaceEditorGateway(boundary: WorkspaceEditorBoundary | ProjectWorkspace): WorkspaceEditorGateway {
  return new WorkspaceEditorGatewayImpl(boundary);
}
