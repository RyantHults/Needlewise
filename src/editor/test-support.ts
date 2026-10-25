// Shared fixtures for editor tests. `LayeredTestBoundary` stands in for the
// workspace the app passes the editor gateway: a layered document editor with
// a selected layer, layer-scoped edits on that layer, paste destinations and
// Track's mark history, as `ProjectSession` provides them, without persistence.
import {
  canAddLayer,
  commandScope,
  createDocument,
  createPaletteCommand,
  DocumentEditor,
  DomainError,
  findLayer,
  fragmentLayerRequirement,
  layerAddCommand,
  LayerErrorCode,
  layerSetVisibilityCommand,
  layerSurface,
  LayerType,
  MAX_LAYERS_PER_TYPE,
  pasteFragmentCommand,
  topmostVisibleLayer,
  type CommandResult,
  type DomainCommand,
  type LayeredDocument,
  type PaletteEntryInput,
  type PatternDocument,
  type PatternFragment,
  type ProgressCommand,
  type ProgressEntry
} from '../domain';
import { DEFAULT_CATALOG_DEFINITION } from '../catalog';
import { editorFromSurface, onDefaultLayers, createLayeredDocument } from '../domain/test-fixtures';
import { EditorSurfaceController, type EditorSurfaceControllerOptions } from './controller';
import type { CanvasRenderer, EditorUiState, Invalidation, OverlayState, RendererStyle, RenderStats, TraceImage, Viewport } from './contracts';
import { getCanvasMetrics } from './coordinates';
import {
  createWorkspaceEditorGateway,
  type ActiveLayerId,
  type CompositeInvalidationReport,
  type PasteCommitResult,
  type PasteDestination,
  type WorkspaceEditorBoundary,
  type WorkspaceEditorGateway
} from './gateway';
import type { PointerSample } from './input';
import { createUiStore } from './ui-store';

export interface LayeredTestBoundaryOptions {
  readonly projectId?: string;
  /** The selected layer; the session's default (topmost visible stitch layer) when absent. */
  readonly activeLayerId?: ActiveLayerId;
}

const LAYER_TYPE_NOUN: Record<LayerType, string> = {
  [LayerType.Stitch]: 'stitch',
  [LayerType.Specialty]: 'specialty'
};

/** The session's selected layer on open: topmost visible stitch layer, else topmost visible layer, else Canvas. */
function defaultActiveLayerId(document: LayeredDocument): ActiveLayerId {
  return (topmostVisibleLayer(document, LayerType.Stitch) ?? topmostVisibleLayer(document))?.id ?? 'canvas';
}

function stampLayerId(command: DomainCommand, layerId: number): DomainCommand {
  if (command.type === 'batch') return { ...command, commands: command.commands.map((child) => stampLayerId(child, layerId)) };
  return commandScope(command) !== 'layer' || typeof command.layerId === 'number' ? command : { ...command, layerId };
}

function needsLayer(command: DomainCommand): boolean {
  if (command.type === 'batch') return command.commands.some(needsLayer);
  return commandScope(command) === 'layer' && typeof command.layerId !== 'number';
}

function editorFor(document: LayeredDocument | PatternDocument): DocumentEditor {
  return 'layers' in document ? new DocumentEditor(document) : editorFromSurface(document);
}

/**
 * A layered workspace for editor tests. A flat `PatternDocument` opens on the
 * two default layers (stitches on 1, backstitches on 2), as `editorFromSurface`
 * builds them. Every edit and undo goes through one `DocumentEditor` history.
 */
export class LayeredTestBoundary implements WorkspaceEditorBoundary {
  /** Commands passed to `execute`, before the selected layer is stamped on. */
  readonly log: DomainCommand[] = [];
  /** Command lists passed to `executeBatch`. */
  readonly batches: DomainCommand[][] = [];
  activeProjectId: string | null;
  private editor: DocumentEditor;
  private active: ActiveLayerId;
  private selected: readonly number[] = [];
  private invalidation: CompositeInvalidationReport | null = null;
  private markUndo: ProgressEntry[] = [];
  private markRedo: ProgressEntry[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(document: LayeredDocument | PatternDocument, options: LayeredTestBoundaryOptions = {}) {
    this.activeProjectId = options.projectId ?? 'project-a';
    this.editor = editorFor(document);
    this.active = options.activeLayerId ?? defaultActiveLayerId(this.editor.document);
    this.refreshSelection();
  }

  /** The flattened, visible-only composite. */
  get document(): PatternDocument {
    return this.editor.composite;
  }

  get layeredDocument(): LayeredDocument {
    return this.editor.document;
  }

  get activeLayerId(): ActiveLayerId {
    return this.active;
  }

  /** The selected layers, bottom to top; just the selected layer without a multi-select. */
  get selectedLayerIds(): readonly number[] {
    return this.selected;
  }

  get undoDepth(): number {
    return this.editor.undoDepth;
  }

  get redoDepth(): number {
    return this.editor.redoDepth;
  }

  activeLayerSurface(): PatternDocument | null {
    return typeof this.active === 'number' ? layerSurface(this.editor.document, this.active) : null;
  }

  getEditorLayerSnapshot(): { readonly compositeInvalidation: CompositeInvalidationReport | null } {
    return { compositeInvalidation: this.invalidation };
  }

  /** Arrange a test: replace the composite invalidation report the editor snapshot returns. */
  setCompositeInvalidation(report: CompositeInvalidationReport | null): void {
    this.invalidation = report;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Layer-scoped commands without a `layerId` go to the selected layer; on Canvas or Reference they are refused. */
  execute(command: DomainCommand): CommandResult {
    this.log.push(command);
    return this.run(command);
  }

  executeBatch(commands: readonly DomainCommand[]): CommandResult {
    this.batches.push([...commands]);
    return this.run({ type: 'batch', commands: [...commands] });
  }

  undo(): CommandResult {
    return this.publish(this.editor.undo());
  }

  redo(): CommandResult {
    return this.publish(this.editor.redo());
  }

  /**
   * The selected layer when it is visible and of the fragment's type; else a
   * new layer when there is room; else the topmost visible layer of the type;
   * else nowhere.
   */
  resolvePaste(type: LayerType): PasteDestination {
    const document = this.editor.document;
    const active = typeof this.active === 'number' ? findLayer(document, this.active) : undefined;
    if (active?.type === type && active.visible) return { layerId: active.id, create: false };
    const noun = LAYER_TYPE_NOUN[type];
    if (canAddLayer(document, type)) return { layerId: null, create: true, message: `Added a new ${noun} layer for your paste.` };
    const top = topmostVisibleLayer(document, type);
    if (top) return { layerId: top.id, create: false, message: `You have ${String(MAX_LAYERS_PER_TYPE)} ${noun} layers already, so this went on the top one.` };
    return { layerId: null, create: false, message: `Your ${noun} layers are all hidden, so nothing was pasted.` };
  }

  /** Pastes as one undo step, creating the layer and any palette entries in it, and selects the destination layer. */
  commitPaste(fragment: PatternFragment, position: { x: number; y: number }, destination: PasteDestination, expectedRevision?: number, palette: readonly PaletteEntryInput[] = []): PasteCommitResult {
    const message = destination.message === undefined ? {} : { message: destination.message };
    const type = fragmentLayerRequirement(fragment);
    if (type === null) return { result: this.unchanged(), layerId: null };
    const creates = palette.map(createPaletteCommand);
    const paste = pasteFragmentCommand(fragment, position, expectedRevision);
    if (destination.create) {
      if (type === 'mixed') throw new Error('A new paste layer needs a fragment of one layer type.');
      const layerId = this.editor.document.nextLayerId;
      const result = this.run({ type: 'batch', commands: [...creates, layerAddCommand(type, { id: layerId }), { ...paste, layerId }] });
      if (result.changed) this.selectLayer(layerId);
      return { result, layerId: result.changed ? layerId : null, ...message };
    }
    if (destination.layerId === null) return { result: this.unchanged(), layerId: null, ...message };
    const layerPaste: DomainCommand = { ...paste, layerId: destination.layerId };
    const result = this.run(creates.length === 0 ? layerPaste : { type: 'batch', commands: [...creates, layerPaste] });
    this.selectLayer(destination.layerId);
    return { result, layerId: destination.layerId, ...message };
  }

  /** Marks bypass document history: each is a step on Track's own stack. */
  markProgress(command: ProgressCommand): CommandResult {
    const applied = this.editor.applyProgress(command);
    if (applied === null || !applied.result.changed) return applied?.result ?? this.unchanged();
    this.markUndo.push(applied.entry);
    this.markRedo = [];
    return this.publish(applied.result);
  }

  undoMark(): CommandResult {
    return this.stepMark(this.markUndo, this.markRedo, false);
  }

  redoMark(): CommandResult {
    return this.stepMark(this.markRedo, this.markUndo, true);
  }

  /** Arrange a test: run an edit on the default layer for its kind (see `onDefaultLayers`), unlogged. */
  seed(command: DomainCommand): CommandResult {
    return this.publish(this.editor.execute(onDefaultLayers(command)));
  }

  /** Select one layer, clearing any multi-select. */
  setActiveLayer(id: ActiveLayerId): void {
    if (typeof id === 'number' && !findLayer(this.editor.document, id)) throw new DomainError(LayerErrorCode.NotFound, `Layer ${String(id)} does not exist.`);
    this.selectLayer(id);
  }

  /** Ctrl/Cmd+click: adds the layer to the selection as its primary, or removes it. The last selected layer stays. */
  toggleLayerSelected(id: number): void {
    if (!this.selected.includes(id)) {
      this.selected = [...this.selected, id];
      this.active = id;
    } else {
      if (this.selected.length <= 1) return;
      const remaining = this.selected.filter((other) => other !== id);
      this.selected = remaining;
      if (id === this.active) this.active = remaining[remaining.length - 1];
    }
    this.refreshSelection();
    this.emit();
  }

  /** Add a layer at the top of its group, as the session does, and select it. */
  addLayer(type: LayerType): number {
    const id = this.editor.document.nextLayerId;
    this.publish(this.editor.execute(layerAddCommand(type, { id })));
    this.selectLayer(id);
    return id;
  }

  /** Show or hide a layer; not an undo step. */
  setLayerVisibility(layerId: number, visible: boolean): void {
    this.publish(this.editor.execute(layerSetVisibilityCommand(layerId, visible)));
  }

  /** Open another project, as switching projects in the workspace does. */
  open(document: LayeredDocument | PatternDocument, projectId: string): void {
    this.activeProjectId = projectId;
    this.editor = editorFor(document);
    this.active = defaultActiveLayerId(this.editor.document);
    this.selected = [];
    this.invalidation = null;
    this.markUndo = [];
    this.markRedo = [];
    this.refreshSelection();
    this.emit();
  }

  private run(command: DomainCommand): CommandResult {
    if (typeof this.active !== 'number' && needsLayer(command)) throw new DomainError(LayerErrorCode.NotFound, 'Select a stitch or specialty layer to edit.');
    return this.publish(this.editor.execute(typeof this.active === 'number' ? stampLayerId(command, this.active) : command));
  }

  private stepMark(from: ProgressEntry[], to: ProgressEntry[], forward: boolean): CommandResult {
    const entry = from.pop();
    if (entry === undefined) return this.unchanged();
    to.push(entry);
    return this.publish(this.editor.applyProgressEntry(entry, forward));
  }

  /** Record what a change did to the composite and keep the selection on existing layers. */
  private publish(result: CommandResult): CommandResult {
    if (result.changed) {
      const indices = result.compositeChangedIndices;
      this.invalidation = { revision: result.revision, full: result.compositeFull === true || indices === undefined, ...(indices === undefined ? {} : { indices }) };
      this.refreshSelection();
    }
    this.emit();
    return result;
  }

  private selectLayer(id: ActiveLayerId): void {
    this.active = id;
    this.selected = [];
    this.refreshSelection();
    this.emit();
  }

  /** The session's rule: a deleted primary falls back to the default, and the primary is always selected. */
  private refreshSelection(): void {
    const document = this.editor.document;
    if (typeof this.active === 'number' && !findLayer(document, this.active)) this.active = defaultActiveLayerId(document);
    const active = this.active;
    if (typeof active !== 'number') {
      this.selected = [];
      return;
    }
    const present = this.selected.filter((id) => findLayer(document, id));
    const ids = present.includes(active) ? present : [active];
    this.selected = document.layers.map((layer) => layer.id).filter((id) => ids.includes(id));
  }

  private unchanged(): CommandResult {
    return { document: this.editor.composite, changed: false, revision: this.editor.revision };
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** A `width`x`height` layered document on the two default layers, with two active colors. */
export function layeredDocument(width = 8, height = 8): LayeredDocument {
  return createLayeredDocument({
    width,
    height,
    catalog: DEFAULT_CATALOG_DEFINITION.association,
    palette: [{ id: 1, name: 'Red', color: '#d33', active: true }, { id: 2, name: 'Blue', color: '#36c', active: true }]
  });
}

/** A flat `width`x`height` document with one color, for `new LayeredTestBoundary(...)`. */
export function plainDocument(width = 8, height = 8): PatternDocument {
  return createDocument({ width, height, catalog: DEFAULT_CATALOG_DEFINITION.association, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
}

/** A renderer that records what the controller sends it. */
export function rendererFixture() {
  let viewport: Viewport = { x: 0, y: 0, zoom: 16 };
  let renderedDocument: PatternDocument | undefined;
  let traceImage: TraceImage | undefined;
  const calls = {
    setDocument: [] as Array<{ document: PatternDocument; invalidation?: Invalidation }>,
    setViewport: [] as Viewport[],
    setMetrics: [] as unknown[],
    setStyle: [] as Partial<RendererStyle>[],
    setOverlay: [] as OverlayState[],
    setPatternDimmed: [] as boolean[]
  };
  const renderer = {
    lastStats: { lod: 'detail', visitedCells: 0, drawnCells: 0, drawnBackstitches: 0, baseRendered: false, overlayRendered: false } as RenderStats,
    getDocument: () => renderedDocument,
    getViewport: () => viewport,
    getStyle: () => ({}) as RendererStyle,
    getTraceImage: () => traceImage,
    setDocument: (document: PatternDocument, invalidation?: Invalidation) => {
      renderedDocument = document;
      calls.setDocument.push({ document, invalidation });
    },
    setViewport: (next: Viewport) => { viewport = next; calls.setViewport.push(next); },
    setMetrics: (metrics: unknown) => calls.setMetrics.push(metrics),
    setStyle: (style: Partial<RendererStyle>) => calls.setStyle.push(style),
    setTraceImage: (next: TraceImage | undefined) => { traceImage = next; },
    clearTraceImage: () => { traceImage = undefined; },
    setOverlay: (overlay: OverlayState) => calls.setOverlay.push(overlay),
    setPatternDimmed: (dimmed: boolean) => { calls.setPatternDimmed.push(dimmed); },
    invalidate: () => undefined,
    requestRender: () => undefined,
    render: () => renderer.lastStats,
    renderNow: () => renderer.lastStats,
    getLastInvalidation: () => ({ base: false, overlay: false, reasons: [] }),
    dispose: () => undefined,
    destroy: () => undefined
  } as unknown as CanvasRenderer;
  return { renderer, calls };
}

export interface FixtureOptions {
  /** Initial UI state; the paint brush with color 1 by default. */
  readonly ui?: Partial<EditorUiState>;
  readonly controller?: Partial<EditorSurfaceControllerOptions>;
}

/** A started, focused controller over `boundary` at zoom 16 on a 128px canvas, collecting notices. */
export function fixture(boundary: LayeredTestBoundary = new LayeredTestBoundary(layeredDocument()), options: FixtureOptions = {}) {
  const gateway: WorkspaceEditorGateway = createWorkspaceEditorGateway(boundary);
  const uiStore = createUiStore({ tool: { tool: 'paint', brush: { kind: 'full', paletteId: 1 } }, ...options.ui });
  const { renderer, calls } = rendererFixture();
  const notices: string[] = [];
  const controller = new EditorSurfaceController({
    gateway,
    uiStore,
    renderer,
    metrics: getCanvasMetrics(128, 128),
    onNotice: (message) => notices.push(message),
    ...options.controller
  });
  controller.start();
  controller.handleFocus();
  return { boundary, gateway, uiStore, controller, renderer, calls, notices };
}

/** A mouse sample at the center of cell (x, y) for the fixture's zoom of 16. */
export function at(pointerId: number, x: number, y: number, extra: Partial<PointerSample> = {}): PointerSample {
  return { pointerId, pointerType: 'mouse', screenX: x * 16 + 8, screenY: y * 16 + 8, button: 0, buttons: 1, isPrimary: true, ...extra };
}

/** Press on cell `from`, move to `to` and release there. */
export function drag(controller: EditorSurfaceController, from: { x: number; y: number }, to: { x: number; y: number }, pointerId = 1): void {
  controller.handlePointerDown(at(pointerId, from.x, from.y));
  controller.handlePointerMove(at(pointerId, to.x, to.y));
  controller.handlePointerUp(at(pointerId, to.x, to.y));
}

/** A mouse sample at the center of cell (x, y), reading the zoom and origin from the ui store's viewport. */
export function atViewport(uiStore: ReturnType<typeof createUiStore>, pointerId: number, x: number, y: number, extra: Partial<PointerSample> = {}): PointerSample {
  const viewport = uiStore.getState().viewport;
  return { pointerId, pointerType: 'mouse', screenX: (x + 0.5 - viewport.x) * viewport.zoom, screenY: (y + 0.5 - viewport.y) * viewport.zoom, button: 0, buttons: 1, isPrimary: true, ...extra };
}

/** `drag`, with cell positions resolved through the ui store's viewport. */
export function dragViewport(controller: EditorSurfaceController, uiStore: ReturnType<typeof createUiStore>, from: { x: number; y: number }, to: { x: number; y: number }, pointerId = 1): void {
  controller.handlePointerDown(atViewport(uiStore, pointerId, from.x, from.y));
  controller.handlePointerMove(atViewport(uiStore, pointerId, to.x, to.y));
  controller.handlePointerUp(atViewport(uiStore, pointerId, to.x, to.y));
}
