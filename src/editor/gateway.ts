import {
  findLayer,
  pasteFragmentCommand,
  type CommandResult,
  type DomainCommand,
  type LayeredDocument,
  type LayerType,
  type PatternDocument,
  type PatternFragment
} from '../domain';
import type { ProjectWorkspace } from '../application/workspace';
import type { EditorActiveLayer, Invalidation } from './contracts';

export interface WorkspaceEditorSnapshot {
  readonly projectId: string | null;
  readonly revision: number | null;
  /** The flattened, visible-only composite that rendering, eyedropper and hover info read. */
  readonly document: PatternDocument | null;
  readonly layeredDocument?: LayeredDocument | null;
  /**
   * The selected layer's own content, which editor tools read and change. It is
   * null for Canvas and Reference, and equals `document` when the workspace has
   * no layer information.
   */
  readonly editSurface?: PatternDocument | null;
  readonly activeLayer?: EditorActiveLayer | null;
  /** Changes whenever layer order, membership, type or visibility changes. */
  readonly layerStackKey?: string | null;
  /** What the workspace's last change did to the composite, when it reports it. */
  readonly compositeInvalidation?: CompositeInvalidationReport | null;
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
  const cellRect = changed ? cellRectForIndices(changed, result.document.width, result.document.height) : undefined;
  return cellRect ? { layer: 'base', cellRect, reason: 'editor-command', ...(cellIndices ? { cellIndices } : {}) } : full;
}

function cellRectForIndices(indices: Uint32Array, width: number, height: number): Invalidation['cellRect'] {
  if (indices.length === 0 || width < 1 || height < 1) return undefined;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (const index of indices) {
    if (index >= width * height) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return maxX < minX || maxY < minY ? undefined : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export interface EditorRevisionToken {
  readonly projectId: string;
  readonly revision: number;
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
  /** Layer support is optional so single-surface boundaries keep working. */
  readonly layeredDocument?: LayeredDocument | null;
  readonly activeLayerId?: ActiveLayerId | null;
  activeLayerSurface?(): PatternDocument | null;
  getEditorLayerSnapshot?(): { readonly compositeInvalidation: CompositeInvalidationReport | null } | null;
  resolvePaste?(type: LayerType): PasteDestination;
  commitPaste?(fragment: PatternFragment, position: { x: number; y: number }, destination: PasteDestination, expectedRevision?: number): PasteCommitResult;
  subscribe(listener: () => void): () => void;
  execute(command: DomainCommand): CommandResult;
  executeBatch(commands: readonly DomainCommand[]): CommandResult;
  undo(): CommandResult;
  redo(): CommandResult;
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
  /** Where a paste of this layer type would go; null `layerId` means nowhere. */
  resolvePaste?(type: LayerType): PasteDestination;
  /** Paste as one history entry, creating the destination layer when needed. */
  commitPaste?(fragment: PatternFragment, position: { x: number; y: number }, destination: PasteDestination, expected?: EditorRevisionToken): PasteCommitResult;
  dispose(): void;
}

function activeLayerOf(layered: LayeredDocument, id: ActiveLayerId | null | undefined): EditorActiveLayer | null {
  if (id === 'canvas' || id === 'reference') return { id, kind: id, visible: true };
  if (typeof id !== 'number') return null;
  const layer = findLayer(layered, id);
  return layer ? { id, kind: layer.type, visible: layer.visible } : null;
}

function layerStackKeyOf(layered: LayeredDocument): string {
  return layered.layers.map((layer) => `${String(layer.id)}:${layer.type}:${layer.visible ? 1 : 0}`).join(',');
}

function snapshotOf(boundary: WorkspaceEditorBoundary): WorkspaceEditorSnapshot {
  const document = boundary.document;
  const layered = document ? boundary.layeredDocument ?? null : null;
  if (!layered) {
    return {
      projectId: boundary.activeProjectId,
      revision: document?.revision ?? null,
      document,
      layeredDocument: null,
      editSurface: document,
      activeLayer: null,
      layerStackKey: null
    };
  }
  const activeLayer = activeLayerOf(layered, boundary.activeLayerId);
  return {
    projectId: boundary.activeProjectId,
    revision: document?.revision ?? null,
    document,
    layeredDocument: layered,
    editSurface: typeof activeLayer?.id === 'number' ? boundary.activeLayerSurface?.() ?? null : null,
    activeLayer,
    layerStackKey: layerStackKeyOf(layered),
    compositeInvalidation: boundary.getEditorLayerSnapshot?.()?.compositeInvalidation ?? null
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
    if (!snapshot.projectId || snapshot.revision === null) throw new Error('There is no active editor project.');
    const token: EditorRevisionToken = { projectId: snapshot.projectId, revision: snapshot.revision };
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

  resolvePaste(type: LayerType): PasteDestination {
    if (this.boundary.resolvePaste) return this.boundary.resolvePaste(type);
    return { layerId: null, create: false };
  }

  commitPaste(fragment: PatternFragment, position: { x: number; y: number }, destination: PasteDestination, expected?: EditorRevisionToken): PasteCommitResult {
    this.ensureLive();
    this.refreshFromBoundary();
    expectedToken(expected, this.snapshot);
    const revision = expected?.revision ?? this.snapshot.revision ?? undefined;
    const outcome = this.boundary.commitPaste
      ? this.boundary.commitPaste(fragment, position, destination, revision)
      : { result: this.boundary.execute(pasteFragmentCommand(fragment, position, revision ?? 0)) };
    this.refresh();
    return outcome;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeBoundary();
    this.listeners.clear();
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

export const createEditorGateway = createWorkspaceEditorGateway;
